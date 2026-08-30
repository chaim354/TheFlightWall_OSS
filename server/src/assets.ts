import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

/**
 * Files the device downloads and then serves or renders itself: the web UI
 * today, logo tiles next, a firmware image after that.
 *
 * They live on the VOLUME (`/app/data/assets`), not in the image, so adding one
 * logo does not mean a redeploy -- that was the whole complaint. The cost is
 * that this reads from a directory an operator uploads into rather than one the
 * build produced, which is why the path handling below is strict rather than
 * convenient.
 *
 * See docs/superpowers/specs/2026-08-25-server-delivered-assets-design.md.
 */

export interface AssetInfo {
  sha256: string;
  size: number;
}

/**
 * Allowlist, not a denylist. Names must start with an alphanumeric and may then
 * contain only alphanumerics, underscore, dot, dash and a forward slash for the
 * one level of nesting logo tiles need.
 *
 * Written this way because the interesting inputs here are not the ones anyone
 * predicts. A denylist for ".." misses "%2e%2e", a leading "/" makes join()
 * return an absolute path outside the root, and a leading dot reaches dotfiles.
 * Requiring the first character to be alphanumeric kills the last two outright,
 * and the containment check below is what catches whatever this misses.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/;

/**
 * Resolve a request path under `root`, or null if it escapes.
 *
 * TWO independent checks, deliberately. The regex rejects the shapes that lead
 * out, and the prefix test proves the resolved path actually landed inside --
 * so a hole in the pattern is not by itself an escape. Never collapse these
 * into one: the regex alone has been the whole defence in plenty of traversals.
 */
export function resolveAssetPath(root: string, rel: string): string | null {
  if (!rel || rel.length > 128) return null;
  if (!SAFE_NAME.test(rel)) return null;
  if (rel.includes('..')) return null;

  const base = normalize(root);
  const full = normalize(join(base, rel));
  return full.startsWith(base.endsWith(sep) ? base : base + sep) ? full : null;
}

/**
 * Size and SHA-256 of one asset, or null if it is not a readable file.
 *
 * Cached against (mtime, size). Hashing 154 logo tiles on every manifest
 * request would be absurd; never hashing would make the manifest a claim rather
 * than a fact, and the device decides whether to download by comparing exactly
 * this value. Keying on mtime AND size means an in-place edit that happens to
 * preserve one of them still invalidates.
 */
const hashCache = new Map<string, { mtimeMs: number; size: number; sha256: string }>();

export async function assetInfo(full: string): Promise<AssetInfo | null> {
  let st;
  try {
    st = await stat(full);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const hit = hashCache.get(full);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return { sha256: hit.sha256, size: hit.size };
  }

  let buf: Buffer;
  try {
    buf = await readFile(full);
  } catch {
    return null;
  }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  hashCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, sha256 });
  return { sha256, size: buf.byteLength };
}

/** Only for tests -- the cache is process-lifetime otherwise. */
export function clearAssetHashCache(): void {
  hashCache.clear();
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * What the device asks for before deciding to download anything.
 *
 * Deliberately SMALL: the UI entry and (later) the firmware entry, not a
 * listing of every logo tile. An ESP32 parses this with ArduinoJson on a heap
 * whose largest contiguous block is the scarce resource, and 154 entries would
 * be a listing it has no use for -- logo tiles are fetched by name, on the miss
 * that proves one is wanted.
 *
 * A missing file yields null rather than an error: a server with no assets
 * uploaded yet is a normal state, and the device already knows what to do with
 * "nothing available" -- keep serving what it has.
 */
export interface FirmwareInfo extends AssetInfo {
  version: string;
  /** base64 DER ECDSA-P256 signature over the image's SHA-256. */
  sig: string;
  /**
   * The board this image was built for: matrixportal_s3 | esp32s3 | esp32dev.
   *
   * There is one firmware slot and every device reads it, while the signature
   * only proves the image is AUTHENTIC -- never that it belongs on the board
   * asking. A MatrixPortal image on a DevKit boot-loops (different pin map,
   * quad vs octal PSRAM, different partition table) and needs a cable to undo,
   * which is the one thing OTA exists to avoid. The device refuses a mismatch,
   * and refuses a manifest that omits this outright.
   */
  target: string;
}

/**
 * The firmware entry, assembled from the three files tools/sign_firmware.sh
 * lays down together: the image, its detached signature, and the version.
 *
 * size and sha256 are computed from the BYTES rather than read from anything
 * the uploader wrote, so the manifest cannot claim a hash the file does not
 * have. The signature is passed through verbatim -- this server does not check
 * it and could not meaningfully do so, since the entire point is that the
 * DEVICE verifies against a key this server has never held. A server that has
 * been compromised can serve any manifest it likes and still cannot make the
 * wall run unsigned code.
 *
 * Any of the three missing yields null: a half-uploaded firmware directory is
 * an incomplete offer, not a broken one, and the device is told there is
 * nothing to install rather than being handed something it cannot verify.
 */
async function firmwareEntry(root: string): Promise<FirmwareInfo | null> {
  const binPath = resolveAssetPath(root, 'firmware/firmware.bin');
  const sigPath = resolveAssetPath(root, 'firmware/firmware.sig');
  const verPath = resolveAssetPath(root, 'firmware/version.txt');
  // target.txt joins the required set rather than being optional: an entry
  // without it is one no current device will install anyway, so advertising it
  // would only offer an update that every board refuses.
  const tgtPath = resolveAssetPath(root, 'firmware/target.txt');
  if (!binPath || !sigPath || !verPath || !tgtPath) return null;

  const info = await assetInfo(binPath);
  if (!info) return null;

  let sig: string;
  let version: string;
  let target: string;
  try {
    // Buffer.from() around the read: the signature is BINARY DER, and taking
    // the string-returning overload here would mangle it through a text decode
    // before it ever reached base64.
    sig = Buffer.from(await readFile(sigPath)).toString('base64');
    version = Buffer.from(await readFile(verPath)).toString('utf8').trim();
    target = Buffer.from(await readFile(tgtPath)).toString('utf8').trim();
  } catch {
    return null;
  }
  if (!sig || !version || !target) return null;

  return { ...info, version, sig, target };
}

/** Build targets a firmware image may declare; see FirmwareUpdater::buildTarget(). */
const FIRMWARE_TARGETS = ['esp32dev', 'esp32s3', 'matrixportal_s3'] as const;
export type FirmwareTarget = (typeof FIRMWARE_TARGETS)[number];

export interface FirmwareUpload {
  bin: Buffer;
  /** base64 DER ECDSA-P256 signature over the image's SHA-256. */
  sig: string;
  version: string;
  target: string;
}

/**
 * Write a firmware image and its three metadata files into the asset volume.
 *
 * WHY THIS EXISTS. Publishing used to mean scp plus `docker cp` plus looking up
 * a container name that changes on every deploy -- so shipping a build required
 * shell access to the box, and could not be driven from anywhere else. The
 * device already fetches over HTTP; the only reason the upload did not was that
 * nothing accepted one.
 *
 * ORDER IS LOAD-BEARING, and it is not the order the shell script used. That
 * script wrote metadata first and the image last, so a device checking in
 * mid-publish saw a null entry rather than a mismatched one -- correct only for
 * a FRESH directory. Overwriting an existing publish that way advertises the
 * NEW version against the OLD binary for the length of the upload, which is
 * worse than either. So the image is REMOVED first: the manifest goes null
 * immediately, stays null while the metadata lands, and becomes valid again
 * only when a consistent set is in place.
 *
 * The signature is stored verbatim and never checked here. This server has
 * never held the signing key and could not verify it if it wanted to -- that is
 * the entire point of signing. A compromised server can serve any manifest it
 * likes and still cannot make the wall run unsigned code.
 */
/**
 * Decode a base64 DER signature, or null if it is not one.
 *
 * Deliberately not annotated `: Buffer` -- this project's tsconfig loads both
 * @cloudflare/workers-types and node, and the workers `Buffer` interface wins
 * as a TYPE while node's wins as a VALUE, so an explicit annotation makes
 * `.toString(encoding)` fail to typecheck. The rest of this file relies on
 * inference for the same reason.
 */
function decodeDerSignature(sig: string) {
  if (sig.length === 0 || sig.length > 512) return null;
  if (sig.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) return null;
  const bytes = Buffer.from(sig, 'base64');
  // ECDSA-P256 DER is ~70-72 bytes; the bound is generous, not exact.
  if (bytes.length === 0 || bytes.length > 256) return null;
  return bytes;
}

export async function writeFirmware(
  root: string,
  upload: FirmwareUpload,
): Promise<{ ok: true; sha256: string; size: number } | { ok: false; error: string }> {
  const { bin, sig, version, target } = upload;

  if (!bin || bin.length === 0) return { ok: false, error: 'empty image' };
  // Generous against the largest OTA slot (3MB) while still bounding what one
  // request can make this process buffer.
  if (bin.length > 4 * 1024 * 1024) return { ok: false, error: 'image too large' };
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(version)) return { ok: false, error: 'bad version' };
  if (!(FIRMWARE_TARGETS as readonly string[]).includes(target)) {
    return { ok: false, error: `bad target (expected one of: ${FIRMWARE_TARGETS.join(', ')})` };
  }
  // Validated by SHAPE before decoding, because Buffer.from(..., 'base64') is
  // lenient: it silently drops characters it does not recognise, so a mangled
  // signature decodes to a shorter valid-looking one rather than failing. A
  // detached signature that is quietly wrong is worse than one that is refused.
  const sigBytes = decodeDerSignature(sig);
  if (!sigBytes) return { ok: false, error: 'bad signature encoding' };

  const dir = resolveAssetPath(root, 'firmware');
  if (!dir) return { ok: false, error: 'bad asset root' };
  await mkdir(dir, { recursive: true });

  // Image first OUT, so the manifest is null for the whole window.
  await rm(join(dir, 'firmware.bin'), { force: true });
  await writeFile(join(dir, 'version.txt'), version);
  await writeFile(join(dir, 'target.txt'), target);
  await writeFile(join(dir, 'firmware.sig'), sigBytes);
  await writeFile(join(dir, 'firmware.bin'), bin);

  return {
    ok: true,
    sha256: createHash('sha256').update(bin).digest('hex'),
    size: bin.length,
  };
}

export async function assetManifest(root: string): Promise<Response> {
  const uiPath = resolveAssetPath(root, 'index.html.gz');
  const ui = uiPath ? await assetInfo(uiPath) : null;
  const firmware = await firmwareEntry(root);
  return json({ ok: true, ui, firmware });
}

/** Content types are advisory here -- the device stores bytes -- so octet-stream
 * is honest for everything it fetches, and .gz in particular must NOT be served
 * as text/html with content-encoding, or an intermediary may decompress it and
 * break the hash the device just checked. */
export async function serveAsset(root: string, rel: string): Promise<Response> {
  const full = resolveAssetPath(root, rel);
  if (!full) return new Response('not found', { status: 404 });

  const info = await assetInfo(full);
  if (!info) return new Response('not found', { status: 404 });

  const body = await readFile(full);
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(info.size),
      // The hash is on the response too, so a caller that already has the
      // manifest can cross-check without a second round trip.
      'x-asset-sha256': info.sha256,
      'cache-control': 'no-cache',
    },
  });
}
