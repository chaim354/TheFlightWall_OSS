import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTrackedStorage } from '../../src/tracked/store';
import type { TrackedEntry } from '../../src/tracked/types';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tracked-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sample = (id: string): TrackedEntry => ({
  id, number: 'BA181', date: '2026-09-14', state: 'pending', reason: null,
  attempts: 0, stateAtMs: 0, reresolved: false, source: 'manual', icao24: null, callsign: null, reg: null,
  aircraftModel: null, aircraftType: null, origIata: null, destIata: null, orig: null, dest: null,
  schedDepEpoch: null, schedArrEpoch: null,
  lastLat: null, lastLon: null, lastPosAtMs: null,
  lastAltFt: null, lastGroundspeedKt: null, lastHeadingDeg: null, lastVerticalRateFpm: null,
});

describe('fileTrackedStorage', () => {
  it('reads an empty list before anything is written', () => {
    // First boot is the common case, not an error.
    const s = fileTrackedStorage(join(dir, 'tracked.json'));
    return expect(s.read()).resolves.toEqual([]);
  });

  it('round-trips entries', async () => {
    const s = fileTrackedStorage(join(dir, 'tracked.json'));
    await s.write([sample('a'), sample('b')]);
    const back = await s.read();
    expect(back.map((e) => e.id)).toEqual(['a', 'b']);
    expect(back[0]!.number).toBe('BA181');
  });

  it('survives a reopen', async () => {
    const path = join(dir, 'tracked.json');
    await fileTrackedStorage(path).write([sample('a')]);
    expect((await fileTrackedStorage(path).read()).length).toBe(1);
  });

  it('returns an empty list rather than throwing on corrupt JSON', async () => {
    // A corrupt file must not take down /v1/flights, which does not depend on
    // tracked entries at all.
    const path = join(dir, 'tracked.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ not json', 'utf8');
    await expect(fileTrackedStorage(path).read()).resolves.toEqual([]);
  });

  it('returns an empty list when the file holds JSON that is not an array', async () => {
    const path = join(dir, 'tracked.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{"nope":true}', 'utf8');
    await expect(fileTrackedStorage(path).read()).resolves.toEqual([]);
  });
});
