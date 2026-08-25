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
  clearAssetHashCache,
} from '../src/assets';

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
