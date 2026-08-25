import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
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
export async function assetManifest(root: string): Promise<Response> {
  const uiPath = resolveAssetPath(root, 'index.html.gz');
  const ui = uiPath ? await assetInfo(uiPath) : null;
  return json({ ok: true, ui });
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
