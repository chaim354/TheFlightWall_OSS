import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredSchedule } from '../src/schedule/store';

// F-SRV09R-B. `await writeFile(tmp, ...)` sat OUTSIDE the try that cleans up:
// cleanup only ran in the catch around `rename`. A writeFile that fails --
// ENOSPC, EDQUOT, EIO, all realistic on one small VPS with a named volume --
// orphaned a partially-written schedule.json.tmp-<uuid> owned by nobody. The
// name embeds a fresh UUID per attempt, so orphans ACCUMULATE one per failure
// rather than overwriting: on ENOSPC that is a positive feedback loop, every
// two hours, forever, each failure consuming more of the space that caused it.
// Nothing sweeps *.tmp-* at startup.
//
// Its own module comment already states the discipline ("a crash or power cut
// mid-write must never leave a truncated /schedule.json on disk"); this is the
// path where it did not hold.
//
// In its own file because the node:fs/promises mock is module-wide. The mock
// passes through to the real implementation unless `fail` is armed, and when
// armed it creates the file BEFORE throwing -- which is what ENOSPC actually
// does, and what makes the orphan real rather than hypothetical.

const h = vi.hoisted(() => ({ fail: null as Error | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (file: string, data: string, enc: BufferEncoding) => {
      if (h.fail) {
        await actual.writeFile(file, '', enc); // partial write, then out of space
        throw h.fail;
      }
      return actual.writeFile(file, data, enc);
    },
  };
});

const { fileStorage } = await import('../src/schedule/fileStorage');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flightwall-writefail-'));
  h.fail = null;
});
afterEach(() => {
  h.fail = null;
  rmSync(dir, { recursive: true, force: true });
});

const schedule = (builtAtMs: number): StoredSchedule => ({
  builtAtMs,
  index: { byNumber: {}, byCallsign: {} },
});

const tmpFiles = () => readdirSync(dir).filter((f) => f.includes('.tmp-'));

const enospc = () =>
  Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });

describe('fileStorage.write: a failed write owns its temp file', () => {
  it('leaves no temp file behind when the content write fails', async () => {
    const storage = fileStorage(join(dir, 'schedule.json'));
    h.fail = enospc();

    await expect(storage.write(schedule(1000))).rejects.toThrow(/ENOSPC/);

    expect(tmpFiles()).toEqual([]);
  });

  it('does not accumulate one orphan per failed attempt', async () => {
    const storage = fileStorage(join(dir, 'schedule.json'));

    for (let i = 0; i < 3; i++) {
      h.fail = enospc();
      await expect(storage.write(schedule(1000 + i))).rejects.toThrow(/ENOSPC/);
    }

    expect(tmpFiles()).toEqual([]);
  });

  it('still propagates the error rather than swallowing it', async () => {
    const storage = fileStorage(join(dir, 'schedule.json'));
    h.fail = enospc();

    await expect(storage.write(schedule(1000))).rejects.toMatchObject({ code: 'ENOSPC' });
  });

  it('leaves the previous good table in place after a failed write', async () => {
    const path = join(dir, 'schedule.json');
    const storage = fileStorage(path);

    await storage.write(schedule(1000));
    expect((await storage.read())?.builtAtMs).toBe(1000);

    h.fail = enospc();
    await expect(storage.write(schedule(2000))).rejects.toThrow(/ENOSPC/);

    expect((await storage.read())?.builtAtMs).toBe(1000);
    expect(tmpFiles()).toEqual([]);
  });

  it('writes normally when nothing is failing', async () => {
    // Guards the mock itself: if pass-through broke, every test above would
    // pass vacuously.
    const path = join(dir, 'schedule.json');
    const storage = fileStorage(path);

    await storage.write(schedule(4242));

    expect(existsSync(path)).toBe(true);
    expect((await storage.read())?.builtAtMs).toBe(4242);
    expect(tmpFiles()).toEqual([]);
  });
});
