import { handleFlights, type Env } from './flights';
import { fetchBoard } from './schedule/aerodatabox';
import { saveSchedule } from './schedule/store';
import type { ScheduleRow } from './types';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/v1/flights') return handleFlights(url, env, Date.now());
    return new Response('not found', { status: 404 });
  },

  async scheduled(_ev: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
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

    await saveSchedule(env.SCHEDULE, rows, Date.now());
    console.log(`schedule: ${rows.length} rows from ${ok}/${boards.length} boards`);
  },
};
