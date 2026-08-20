import { handleFlights, type Env } from './flights';
import { fetchBoard } from './schedule/aerodatabox';
import { saveSchedule, kvStorage } from './schedule/store';
import type { ScheduleRow } from './types';

/**
 * The Worker's actual Cloudflare bindings (wrangler.toml), as opposed to
 * flights.ts's `Env`, which is storage-abstraction-shaped. SCHEDULE here is
 * the real KVNamespace; it gets adapted with kvStorage() below before
 * anything storage-abstraction-shaped sees it.
 */
interface WorkerEnv {
  SCHEDULE: KVNamespace;
  BOARDS: string;
  AERODATABOX_KEY: string;
}

export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/v1/flights') return new Response('not found', { status: 404 });
    const flightsEnv: Env = { ...env, SCHEDULE: kvStorage(env.SCHEDULE) };
    return handleFlights(url, flightsEnv, Date.now());
  },

  async scheduled(_ev: ScheduledController, env: WorkerEnv, _ctx: ExecutionContext): Promise<void> {
    const boards = env.BOARDS.split(',').map((s) => s.trim()).filter(Boolean);
    const rows: ScheduleRow[] = [];
    let ok = 0;

    for (const icao of boards) {
      try {
        rows.push(...(await fetchBoard(icao, env.AERODATABOX_KEY)));
        ok++;
      } catch (e) {
        // One board failing must not cost us the other three.
        console.error(`board ${icao} failed:`, e);
      }
    }

    if (ok === 0) {
      // Writing an empty table would blank every route until the next cron.
      // Leave the previous one in place and let it age into `stale` honestly.
      console.error('all boards failed; keeping the previous table');
      return;
    }

    await saveSchedule(kvStorage(env.SCHEDULE), rows, Date.now());
    console.log(`schedule: ${rows.length} rows from ${ok}/${boards.length} boards`);
  },
};
