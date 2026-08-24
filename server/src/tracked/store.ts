import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TrackedEntry } from './types';

export interface TrackedStorage {
  read(): Promise<TrackedEntry[]>;
  write(entries: TrackedEntry[]): Promise<void>;
}

/**
 * File-backed entry store, living in the same volume as the schedule table
 * (see config/deploy.yml) so entries survive a redeploy.
 *
 * Mirrors schedule/fileStorage.ts deliberately, including the write-to-temp-
 * then-rename: a crash mid-write must not leave a half-written file that reads
 * as corrupt on next boot.
 *
 * Every read failure degrades to an empty list rather than throwing. Tracked
 * flights are an addition to /v1/flights, never a precondition for it -- a
 * corrupt tracked file must cost the user their pinned cards, not the whole
 * wall.
 */
export function fileTrackedStorage(path: string): TrackedStorage {
  return {
    async read(): Promise<TrackedEntry[]> {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!Array.isArray(parsed)) {
          console.error('tracked store: file is not an array; ignoring');
          return [];
        }
        return parsed as TrackedEntry[];
      } catch (err) {
        // ENOENT is first boot, which is expected and not worth a line.
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.error('tracked store read failed:', err instanceof Error ? err.message : String(err));
        }
        return [];
      }
    },

    async write(entries: TrackedEntry[]): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${randomUUID()}.tmp`;
      // writeFile lives inside this try, not just rename: a thrown write
      // error (ENOSPC, EDQUOT, EIO -- all realistic on a small VPS) must not
      // orphan a partial temp file. Each attempt's name carries a fresh
      // UUID, so without this cleanup, failures accumulate one orphan apiece
      // instead of overwriting -- on ENOSPC that is a feedback loop, each
      // failure eating more of the space that caused it. fileStorage.ts (the
      // schedule table) hit exactly this -- see commit 5b04ae4, F-SRV09R-B,
      // and test/fileStorageWriteFailure.test.ts -- and this mirrors its fix.
      try {
        await writeFile(tmp, JSON.stringify(entries), 'utf8');
        await rename(tmp, path);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    },
  };
}
