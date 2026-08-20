import { handleFlights, type Env } from './flights';
import { kvStorage } from './schedule/store';
import { refreshSchedule } from './schedule/refresh';

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
    await refreshSchedule(boards, env.AERODATABOX_KEY, kvStorage(env.SCHEDULE), Date.now());
  },
};
