import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStorage } from '../src/schedule/fileStorage';
import type { StoredSchedule } from '../src/schedule/store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flightwall-filestorage-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const schedule = (builtAtMs: number): StoredSchedule => ({
  builtAtMs,
  index: {
    byNumber: { '5075': [{ callsign: null, carrierIata: 'DL', number: '5075', origIata: 'CVG', destIata: 'LGA',
      origLat: 39.0, origLon: -84.7, destLat: 40.78, destLon: -73.87, schedArrEpoch: null }] },
    byCallsign: {},
  },
});

describe('fileStorage: round trip', () => {
  it('reads back exactly what it wrote', async () => {
    const path = join(dir, 'schedule.json');
    const storage = fileStorage(path);
    await storage.write(schedule(1_700_000_000_000));
    expect(await storage.read()).toEqual(schedule(1_700_000_000_000));
  });

  it('overwrites on a second write -- read reflects only the latest', async () => {
    const path = join(dir, 'schedule.json');
    const storage = fileStorage(path);
    await storage.write(schedule(1));
    await storage.write(schedule(2));
    expect(await storage.read()).toEqual(schedule(2));
  });

  it('creates missing parent directories on write', async () => {
    const path = join(dir, 'nested', 'deep', 'schedule.json');
    const storage = fileStorage(path);
    await storage.write(schedule(1));
    expect(await storage.read()).toEqual(schedule(1));
  });
});

describe('fileStorage: missing file', () => {
  it('returns null instead of throwing when the file has never been written', async () => {
    const storage = fileStorage(join(dir, 'never-written.json'));
    await expect(storage.read()).resolves.toBeNull();
  });

  it('returns null instead of throwing when the parent directory does not exist either', async () => {
    const storage = fileStorage(join(dir, 'nope', 'schedule.json'));
    await expect(storage.read()).resolves.toBeNull();
  });
});

describe('fileStorage: corrupt file', () => {
  it('returns null instead of throwing on truncated/invalid JSON', async () => {
    const path = join(dir, 'schedule.json');
    writeFileSync(path, '{"builtAtMs": 1, "index": {not valid json');
    const storage = fileStorage(path);
    await expect(storage.read()).resolves.toBeNull();
  });

  it('returns null instead of throwing on an empty file', async () => {
    const path = join(dir, 'schedule.json');
    writeFileSync(path, '');
    const storage = fileStorage(path);
    await expect(storage.read()).resolves.toBeNull();
  });

  it('a corrupt file does not stop a subsequent write from succeeding', async () => {
    // Recovery matters as much as detection: a bad table on disk must not
    // wedge the service out of ever getting a good one.
    const path = join(dir, 'schedule.json');
    writeFileSync(path, 'not json at all');
    const storage = fileStorage(path);
    await storage.write(schedule(5));
    expect(await storage.read()).toEqual(schedule(5));
  });
});

describe('fileStorage: atomic write', () => {
  it('never leaves a temp file behind after a successful write', async () => {
    const path = join(dir, 'schedule.json');
    const storage = fileStorage(path);
    await storage.write(schedule(1));
    const entries = readdirSync(dir);
    expect(entries).toEqual(['schedule.json']);
  });

  it('a reader never observes a partial/corrupt file while a write is in flight', async () => {
    // Real filesystem, no mocking: fileStorage always writes the FULL new
    // payload to a distinct temp path and only ever touches the live path
    // via a single `rename`, which POSIX guarantees is atomic. That means
    // there is no instant at which `path` can contain a partial write --
    // this test proves the observable consequence of that by polling the
    // real file on disk throughout an in-flight write of a large payload
    // (a naive truncate-then-write implementation would fail this: JSON.parse
    // would catch it mid-write with a truncated document).
    const path = join(dir, 'schedule.json');
    const storage = fileStorage(path);
    await storage.write(schedule(1)); // establishes an old, valid file

    // Deliberately oversized (not a realistic StoredSchedule shape) so the
    // write takes long enough on disk for the polling loop below to have a
    // real chance of landing mid-write; cast rather than widen the type
    // just for this one fixture.
    const big = {
      builtAtMs: 2,
      index: { byNumber: { x: [] }, byCallsign: {} },
      filler: 'x'.repeat(4_000_000),
    } as unknown as StoredSchedule;

    let settled = false;
    const writeDone = storage.write(big).finally(() => {
      settled = true;
    });

    let sawPartial = false;
    let pollIterations = 0;
    while (!settled) {
      pollIterations++;
      if (existsSync(path)) {
        const raw = readFileSync(path, 'utf8');
        try {
          JSON.parse(raw);
        } catch {
          sawPartial = true;
          break;
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await writeDone;

    expect(sawPartial).toBe(false);
    expect(pollIterations).toBeGreaterThan(0); // sanity: the loop actually ran

    // And no temp file survives the completed write.
    const entries = await readdir(dir);
    expect(entries.every((e) => !e.includes('.tmp-'))).toBe(true);
    expect(entries).toContain('schedule.json');
  });
});
