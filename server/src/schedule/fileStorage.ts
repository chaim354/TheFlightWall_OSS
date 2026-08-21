import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ScheduleStorage, StoredSchedule } from './store';

/**
 * File-backed ScheduleStorage for the Node/Kamal entry point (server.ts).
 * Never imported by index.ts or anything it pulls in -- it is the one place
 * in src/ allowed to reach for Node built-ins, and keeping it in its own
 * module is what keeps `node:fs` out of the Worker's bundle graph.
 *
 * Mirrors kvStorage's contract: a caller that only knows ScheduleStorage
 * cannot tell which implementation it has.
 */
export function fileStorage(path: string): ScheduleStorage {
  return {
    /**
     * A missing file (ENOENT, e.g. first boot before any refresh has ever
     * written one) and a corrupt/truncated file (bad JSON) both degrade to
     * null rather than throwing -- exactly what a KV miss already returns.
     * loadSchedule's caller (handleFlights) already treats null as "no
     * table yet" and isStale(null, ...) already reads that as stale, which
     * degrades to no routes rather than a failed request.
     */
    async read(): Promise<StoredSchedule | null> {
      try {
        const raw = await readFile(path, 'utf8');
        return JSON.parse(raw) as StoredSchedule;
      } catch (err) {
        // ENOENT (no table written yet) is the expected, common case on
        // first boot -- not worth a log line. Anything else -- permission
        // denied, a disk error, corrupt JSON -- degrades to the same null
        // per spec, but gets logged first: swallowing it silently would
        // read as "no schedule yet" forever with no clue why, the same
        // undiagnosable-in-production gap flights.ts's position-fetch
        // error log exists to avoid (see the comment there).
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.error('schedule file read failed:', err instanceof Error ? err.message : String(err));
        }
        return null;
      }
    },

    /**
     * Write to a temp file in the same directory, then rename over the live
     * file -- same discipline as the firmware's Settings::save() (see
     * firmware/core/Settings.cpp) and for the same reason: a crash or power
     * cut mid-write must never leave a truncated /schedule.json on disk.
     * `rename` is atomic on the same filesystem (guaranteed by POSIX, which
     * is what the target container runtime runs on), so readers only ever
     * see the file fully-old or fully-new, never partial. The temp file
     * lives beside the target (not in os.tmpdir()) specifically so the
     * rename can't cross a filesystem boundary, which would turn it into a
     * non-atomic copy.
     */
    async write(s: StoredSchedule): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${randomUUID()}`;
      await writeFile(tmp, JSON.stringify(s), 'utf8');
      try {
        await rename(tmp, path);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    },
  };
}
