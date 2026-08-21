import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleFlights, type Env } from './flights';
import { fileStorage } from './schedule/fileStorage';
import { refreshSchedule, refreshPanynj, BOARD_FETCH_DELAY_MS } from './schedule/refresh';
import { PAGE_DELAY_MS } from './schedule/panynj';

/** Everything server.ts needs, read from process.env with a default for
 * every var except the API key -- there is no sensible default for that. */
export interface ServerConfig {
  port: number;
  aerodataboxKey: string;
  boards: string;
  schedulePath: string;
  /** How often to refresh the schedule table after the initial boot fetch. */
  refreshIntervalMs: number;
  /**
   * How often to re-merge the free Port Authority boards on top of it.
   *
   * Much shorter than refreshIntervalMs because this source costs nothing
   * per call, and short cadence is the entire point: it is what keeps the
   * window centred on now instead of on a build time up to six hours old.
   *
   * Zero or negative disables the Port Authority source entirely -- no boot
   * pass and no timer. That is how tests get a server that touches no
   * network, and it is also the escape hatch if the Port Authority ever
   * starts refusing us: set it to 0 and the AeroDataBox path carries on
   * alone, exactly as it did before this source existed.
   */
  panynjIntervalMs: number;
  /**
   * Spacing between Port Authority requests. A field rather than a constant
   * only so tests can pass 0; see panynj.ts on why the real value matters.
   */
  panynjPageDelayMs: number;
  /**
   * Delay between board fetches within one refresh pass. Not read from an
   * env var -- configFromEnv always sets it to refreshSchedule's own
   * default -- it's a ServerConfig field rather than a constant only so
   * tests can pass 0 and run fast instead of waiting out real 1.5s gaps.
   */
  boardFetchDelayMs: number;
}

const DEFAULT_PORT = 8787;
const DEFAULT_BOARDS = 'KJFK,KLGA,KEWR,KBOS';
const DEFAULT_SCHEDULE_PATH = './data/schedule.json';
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * Port Authority merge cadence.
 *
 * Ten minutes is ~8 requests per pass, i.e. about 0.8/min. Measured safe
 * headroom: 18 requests at 2s spacing over five minutes (3.6/min) drew no
 * throttling at all, while an unspaced burst of ~12-15 did. See panynj.ts.
 */
const TEN_MINUTES_MS = 10 * 60 * 1000;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || DEFAULT_PORT,
    aerodataboxKey: env.AERODATABOX_KEY ?? '',
    boards: env.BOARDS ?? DEFAULT_BOARDS,
    schedulePath: env.SCHEDULE_PATH ?? DEFAULT_SCHEDULE_PATH,
    refreshIntervalMs: SIX_HOURS_MS,
    boardFetchDelayMs: BOARD_FETCH_DELAY_MS,
    panynjIntervalMs: TEN_MINUTES_MS,
    panynjPageDelayMs: PAGE_DELAY_MS,
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, env: Env): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/up') {
    // Liveness only, deliberately: it must stay 200 even when the schedule
    // table is missing or stale, because positions and the physics ETA
    // both work without it. A deep healthcheck that failed on a bad
    // schedule file would get Kamal to yank a container that is otherwise
    // serving perfectly good flight data.
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url.pathname === '/v1/flights') {
    const response = await handleFlights(url, env, Date.now());
    const body = await response.text();
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
    res.end(body);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

export interface RunningServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/**
 * Boots the HTTP server and the periodic schedule refresh together, and
 * hands back a handle to shut both down. Does not touch process.env or
 * process signals itself -- that's the main-module block at the bottom of
 * this file, kept separate so tests can start/stop a server on an
 * ephemeral port without also wiring up SIGTERM handlers or reading real
 * env vars.
 */
export function startServer(config: ServerConfig): Promise<RunningServer> {
  const storage = fileStorage(config.schedulePath);
  const env: Env = { SCHEDULE: storage, BOARDS: config.boards, AERODATABOX_KEY: config.aerodataboxKey };
  const boards = config.boards.split(',').map((s) => s.trim()).filter(Boolean);

  if (!config.aerodataboxKey) {
    // Not fatal: positions and the physics ETA work with no schedule table
    // at all, they just lose routes (origin/destination/flight number).
    console.error('AERODATABOX_KEY is not set -- schedule refresh is disabled. Positions and the physics ETA still work; routes will not.');
  }

  /**
   * One refresh at a time.
   *
   * Two timers write the same table on different periods, and
   * refreshPanynj's merge is read-modify-write: a Port Authority pass that
   * read the table before a concurrent AeroDataBox pass overwrote it would
   * write back a merge built on rows that no longer exist. Skipping rather
   * than queueing is right for both -- a missed pass is re-run minutes later,
   * whereas a queued one would just pile up behind a slow fetch.
   */
  let refreshing = false;

  const guarded = async (label: string, run: () => Promise<void>): Promise<void> => {
    if (refreshing) {
      console.log(`${label} skipped: a refresh is already running`);
      return;
    }
    refreshing = true;
    try {
      await run();
    } catch (err) {
      // The refresh routines already log per-board failures and the
      // all-boards-failed case; this only catches what they did not expect
      // (e.g. a storage.write failure), so a recurring timer is never killed
      // by an unhandled rejection.
      console.error(`${label} failed:`, err instanceof Error ? err.message : String(err));
    } finally {
      refreshing = false;
    }
  };

  const runAerodatabox = (): Promise<void> =>
    config.aerodataboxKey
      ? guarded('schedule refresh', () =>
          refreshSchedule(boards, config.aerodataboxKey, storage, Date.now(), config.boardFetchDelayMs),
        )
      : Promise.resolve();

  const panynjEnabled = config.panynjIntervalMs > 0;

  const runPanynj = (): Promise<void> =>
    panynjEnabled
      ? guarded('panynj refresh', () => refreshPanynj(storage, Date.now(), config.panynjPageDelayMs))
      : Promise.resolve();

  /**
   * AeroDataBox first, then Port Authority, always in that order.
   *
   * refreshSchedule REPLACES the whole table, so a Port Authority pass that
   * ran before it would have its rows discarded moments later. Chaining the
   * merge onto the end of every AeroDataBox pass keeps the gap where the
   * table holds no fresh Port Authority data down to the length of one fetch,
   * instead of up to a full panynjIntervalMs.
   */
  const runBoth = async (): Promise<void> => {
    await runAerodatabox();
    await runPanynj();
  };

  void runBoth(); // once at boot
  const timer = setInterval(() => void runBoth(), config.refreshIntervalMs);
  const panynjTimer = panynjEnabled
    ? setInterval(() => void runPanynj(), config.panynjIntervalMs)
    : undefined;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(req, res, env).catch((err) => {
        console.error('request handler error:', err instanceof Error ? err.message : String(err));
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      });
    });

    // Every server-level error gets logged, not just a pre-listen bind
    // failure: `.once` + reject() alone would go silent for good after the
    // promise below settles, since rejecting an already-settled promise is
    // a silent no-op -- exactly the kind of undiagnosable-in-production gap
    // this codebase has already been bitten by once (see flights.ts's
    // position-fetch error log). `settled` is what still lets a genuine
    // startup failure (e.g. EADDRINUSE) reject startServer()'s promise.
    let settled = false;
    server.on('error', (err) => {
      console.error('server error:', err instanceof Error ? err.message : String(err));
      if (!settled) {
        settled = true;
        clearInterval(timer);
        clearInterval(panynjTimer);
        reject(err);
      }
    });

    server.listen(config.port, () => {
      settled = true;
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : config.port;

      const close = (): Promise<void> =>
        new Promise((resolveClose, rejectClose) => {
          clearInterval(timer);
          clearInterval(panynjTimer);
          server.close((err) => (err ? rejectClose(err) : resolveClose()));
          // Force idle keep-alive sockets closed immediately rather than
          // waiting out their keep-alive timeout -- otherwise server.close()
          // can hang for seconds with no in-flight requests at all, which
          // matters both for fast test teardown and for a clean SIGTERM
          // during a Kamal deploy.
          server.closeIdleConnections();
        });

      resolve({ server, port, close });
    });
  });
}

function isMainModule(): boolean {
  // True whether this runs compiled (`node dist/server.js`) or, in
  // principle, directly via a TS loader -- both set process.argv[1] to this
  // file's path. False on import, which is what keeps a plain `import
  // '../src/server'` in a test from binding a real port or reading real
  // env vars.
  return Boolean(process.argv[1]) && import.meta.url === `file://${process.argv[1]}`;
}

/* c8 ignore start -- exercised as a real process in Docker/Kamal, not under vitest */
if (isMainModule()) {
  const config = configFromEnv();
  startServer(config)
    .then(({ port, close }) => {
      console.log(`flightwall-server listening on :${port}`);

      const shutdown = (signal: string): void => {
        console.log(`${signal} received, shutting down`);
        close()
          .then(() => process.exit(0))
          .catch((err: unknown) => {
            console.error('error during shutdown:', err instanceof Error ? err.message : String(err));
            process.exit(1);
          });
      };

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((err: unknown) => {
      console.error('failed to start server:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
/* c8 ignore stop */
