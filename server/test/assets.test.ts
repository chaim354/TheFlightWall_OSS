import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  resolveAssetPath,
  assetInfo,
  assetManifest,
  serveAsset,
  clearAssetHashCache, writeFirmware } from '../src/assets';

let root: string;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flightwall-assets-'));
  clearAssetHashCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveAssetPath', () => {
  it('accepts the names actually used', () => {
    expect(resolveAssetPath(root, 'index.html.gz')).toBe(join(root, 'index.html.gz'));
    expect(resolveAssetPath(root, 'logos/JZA.rgb565')).toBe(join(root, 'logos/JZA.rgb565'));
  });

  // This reads from a directory an operator uploads into, so traversal is a
  // real input rather than a theoretical one. Each of these escapes on at
  // least one naive implementation.
  it('refuses to leave the root', () => {
    expect(resolveAssetPath(root, '../secrets')).toBeNull();
    expect(resolveAssetPath(root, 'logos/../../secrets')).toBeNull();
    expect(resolveAssetPath(root, '/etc/passwd')).toBeNull();     // join() would go absolute
    expect(resolveAssetPath(root, './index.html.gz')).toBeNull();  // leading dot
    expect(resolveAssetPath(root, '.env')).toBeNull();             // dotfile
    expect(resolveAssetPath(root, '')).toBeNull();
    expect(resolveAssetPath(root, 'a'.repeat(200))).toBeNull();
  });

  it('refuses characters that have no business in an asset name', () => {
    expect(resolveAssetPath(root, 'index html.gz')).toBeNull(); // space
    expect(resolveAssetPath(root, 'a\\b')).toBeNull();          // backslash
    expect(resolveAssetPath(root, 'a\0b')).toBeNull();          // NUL
    expect(resolveAssetPath(root, '%2e%2e/x')).toBeNull();      // encoded ..
  });
});

describe('assetInfo', () => {
  it('reports size and sha256', async () => {
    writeFileSync(join(root, 'index.html.gz'), 'hello');
    const info = await assetInfo(join(root, 'index.html.gz'));
    expect(info).toEqual({ sha256: sha('hello'), size: 5 });
  });

  it('is null for a missing file and for a directory', async () => {
    expect(await assetInfo(join(root, 'nope'))).toBeNull();
    mkdirSync(join(root, 'logos'));
    expect(await assetInfo(join(root, 'logos'))).toBeNull();
  });

  it('re-hashes when the file changes', async () => {
    const p = join(root, 'index.html.gz');
    writeFileSync(p, 'one');
    expect((await assetInfo(p))!.sha256).toBe(sha('one'));

    // Same length, different content, and an explicitly different mtime --
    // a cache keyed on size alone would serve the stale hash here, and the
    // device would then decline a download it needs.
    writeFileSync(p, 'two');
    const t = new Date(Date.now() + 2000);
    utimesSync(p, t, t);
    expect((await assetInfo(p))!.sha256).toBe(sha('two'));
  });
});

describe('assetManifest', () => {
  it('reports the UI entry when one is uploaded', async () => {
    writeFileSync(join(root, 'index.html.gz'), 'page');
    const body = (await (await assetManifest(root)).json()) as { ok: boolean; ui: unknown };
    expect(body.ok).toBe(true);
    expect(body.ui).toEqual({ sha256: sha('page'), size: 4 });
  });

  it('reports ui:null rather than failing when nothing is uploaded', async () => {
    // A server with an empty asset directory is a normal state, not an error --
    // the device keeps serving its built-in copy.
    const res = await assetManifest(root);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ui: unknown };
    expect(body.ok).toBe(true);
    expect(body.ui).toBeNull();
  });
});

describe('assetManifest firmware entry', () => {
  const layDownFirmware = (
    bin: string,
    sig: Buffer,
    version: string,
    target = 'esp32s3',
  ): void => {
    mkdirSync(join(root, 'firmware'), { recursive: true });
    writeFileSync(join(root, 'firmware', 'firmware.bin'), bin);
    writeFileSync(join(root, 'firmware', 'firmware.sig'), sig);
    writeFileSync(join(root, 'firmware', 'version.txt'), version + '\n');
    writeFileSync(join(root, 'firmware', 'target.txt'), target + '\n');
  };

  it('reports version, target, size, hash and the signature', async () => {
    const sig = Buffer.from([0x30, 0x45, 0x02, 0x21, 0xde, 0xad]);
    layDownFirmware('IMAGE', sig, '2e05f4d', 'matrixportal_s3');
    const body = (await (await assetManifest(root)).json()) as {
      firmware: {
        version: string; size: number; sha256: string; sig: string; target: string;
      } | null;
    };
    expect(body.firmware).toEqual({
      version: '2e05f4d',           // trailing newline trimmed
      target: 'matrixportal_s3',     // likewise, and it gates the install
      size: 5,
      sha256: sha('IMAGE'),          // from the BYTES, not from anything uploaded
      sig: sig.toString('base64'),
    });
  });

  it('is null when target.txt is missing, so no board is offered an unlabelled image', async () => {
    // One slot serves every board and the signature proves only authenticity,
    // never fitness. An image with no stated target is one every current device
    // refuses, so advertising it would offer an update nothing can install --
    // and worse, an older device that does not check would take it.
    const sig = Buffer.from([0x30, 0x45]);
    mkdirSync(join(root, 'firmware'), { recursive: true });
    writeFileSync(join(root, 'firmware', 'firmware.bin'), 'IMAGE');
    writeFileSync(join(root, 'firmware', 'firmware.sig'), sig);
    writeFileSync(join(root, 'firmware', 'version.txt'), '2e05f4d\n');
    const body = (await (await assetManifest(root)).json()) as { firmware: unknown };
    expect(body.firmware).toBeNull();
  });

  it('is null when any of the three files is missing', async () => {
    // A half-uploaded directory is an incomplete offer, not a broken one: the
    // device must be told there is nothing to install rather than handed
    // something it cannot verify.
    mkdirSync(join(root, 'firmware'), { recursive: true });
    writeFileSync(join(root, 'firmware', 'firmware.bin'), 'IMAGE');
    const noSig = (await (await assetManifest(root)).json()) as { firmware: unknown };
    expect(noSig.firmware).toBeNull();

    writeFileSync(join(root, 'firmware', 'firmware.sig'), Buffer.from([1, 2, 3]));
    const noVersion = (await (await assetManifest(root)).json()) as { firmware: unknown };
    expect(noVersion.firmware).toBeNull();
  });

  it('is null when nothing is uploaded at all, alongside ui', async () => {
    const body = (await (await assetManifest(root)).json()) as { ok: boolean; ui: unknown; firmware: unknown };
    expect(body.ok).toBe(true);
    expect(body.ui).toBeNull();
    expect(body.firmware).toBeNull();
  });
});

describe('serveAsset', () => {
  it('serves the bytes with the hash on the response', async () => {
    writeFileSync(join(root, 'index.html.gz'), 'page');
    const res = await serveAsset(root, 'index.html.gz');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-asset-sha256')).toBe(sha('page'));
    expect(res.headers.get('content-length')).toBe('4');
    // octet-stream, NOT text/html+gzip: an intermediary that decompressed a
    // .gz in transit would break the hash the device is about to check.
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(await res.text()).toBe('page');
  });

  it('serves a nested logo tile byte for byte', async () => {
    mkdirSync(join(root, 'logos'));
    const bytes = Buffer.from([0x20, 0x00, 0x20, 0x00, 0xde, 0xad]);
    writeFileSync(join(root, 'logos', 'JZA.rgb565'), bytes);
    const res = await serveAsset(root, 'logos/JZA.rgb565');
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });

  it('404s a missing file and a traversal attempt alike', async () => {
    expect((await serveAsset(root, 'nope.bin')).status).toBe(404);
    expect((await serveAsset(root, '../../etc/passwd')).status).toBe(404);
  });
});

describe('writeFirmware', () => {
  const good = () => ({
    bin: Buffer.from('FIRMWARE-IMAGE'),
    sig: Buffer.from([0x30, 0x45, 0x02, 0x21, 0xde, 0xad]).toString('base64'),
    version: '1a7599b',
    target: 'esp32s3',
  });

  it('lands a complete, self-consistent entry the manifest can serve', async () => {
    const r = await writeFirmware(root, good());
    expect(r.ok).toBe(true);
    const body = (await (await assetManifest(root)).json()) as {
      firmware: { version: string; target: string; size: number; sha256: string; sig: string } | null;
    };
    expect(body.firmware).toEqual({
      version: '1a7599b',
      target: 'esp32s3',
      size: 14,
      sha256: sha('FIRMWARE-IMAGE'),
      sig: good().sig,
    });
  });

  it('REPLACES a previous publish without ever advertising a mixed pair', async () => {
    // The window this guards: metadata written before the image would leave the
    // manifest naming the NEW version against the OLD binary, which a device
    // checking in would download and install. Removing the image first makes
    // the entry null for the whole window instead.
    await writeFirmware(root, good());
    const before = (await (await assetManifest(root)).json()) as { firmware: { sha256: string } };
    const second = { ...good(), bin: Buffer.from('DIFFERENT-IMAGE'), version: 'deadbee' };
    await writeFirmware(root, second);
    const after = (await (await assetManifest(root)).json()) as {
      firmware: { version: string; sha256: string };
    };
    expect(after.firmware.version).toBe('deadbee');
    expect(after.firmware.sha256).toBe(sha('DIFFERENT-IMAGE'));
    expect(after.firmware.sha256).not.toBe(before.firmware.sha256);
  });

  it('refuses a target no board could accept', async () => {
    const r = await writeFirmware(root, { ...good(), target: 'esp32s4' });
    expect(r.ok).toBe(false);
    const body = (await (await assetManifest(root)).json()) as { firmware: unknown };
    expect(body.firmware).toBeNull();   // nothing written
  });

  it('refuses a signature that is not really base64', async () => {
    // Buffer.from is lenient and would silently decode this to something
    // shorter, storing a signature that cannot verify rather than refusing.
    const r = await writeFirmware(root, { ...good(), sig: 'not!valid!base64!' });
    expect(r.ok).toBe(false);
  });

  it('refuses an empty image', async () => {
    const r = await writeFirmware(root, { ...good(), bin: Buffer.alloc(0) });
    expect(r.ok).toBe(false);
  });

  it('refuses a version with characters that do not belong in a path', async () => {
    const r = await writeFirmware(root, { ...good(), version: '../../etc/passwd' });
    expect(r.ok).toBe(false);
  });
});
