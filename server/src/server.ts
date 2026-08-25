import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleFlights, type Env } from './flights';
import { fileStorage } from './schedule/fileStorage';
import { refreshSchedule, refreshPanynj, BOARD_FETCH_DELAY_MS } from './schedule/refresh';
import { PAGE_DELAY_MS } from './schedule/panynj';
import { parseQuietHours, inQuietHours, shouldRefresh, type QuietWindow } from './schedule/quietHours';
import { handleTracked } from './tracked/routes';
import { trackedPage } from './tracked/page';
import { fileTrackedStorage } from './tracked/store';
import { runTrackedTick } from './tracked/tick';
import { resolveFlight } from './tracked/resolve';
import { fetchPosition } from './tracked/opensky';
import { assetManifest, serveAsset } from './assets';
import { handleControl, fileControlStorage, type ControlStorage } from './control';

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
   * Hours during which the schedule refresh is skipped, as "START-END" local
   * hours, or null to always refresh.
   *
   * Defaults to 00:00-06:00: the panel's night schedule ends at 07:00, and this
   * must end BEFORE that so a refresh lands while it is still dark and the
   * table is centred on the morning. Leaving the window forces a refresh within
   * REFRESH_CHECK_MS (5 minutes), so the margin needed is minutes, not a whole
   * refresh interval -- the hour the default leaves is generous, not required.
   * See src/schedule/quietHours.ts.
   */
  quietHours: QuietWindow | null;
  /** IANA zone the quiet-hours window is interpreted in. */
  quietHoursTimeZone: string;
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
  /**
   * OpenSky OAuth2 client-credentials pair used to poll tracked-flight
   * positions (see src/tracked/opensky.ts).
   *
   * Optional, unlike aerodataboxKey -- every ServerConfig literal that
   * predates this feature (this file's own tests included) must keep
   * compiling without naming it. Absent (either one) disables tracked
   * flights entirely: handleRequest 404s /v1/tracked and the tick below
   * never starts. That is also the Cloudflare Worker's permanent state --
   * it shares src/tracked/serve.ts's read path but runs no server.ts and
   * has no tracked store at all.
   */
  openSkyClientId?: string;
  openSkyClientSecret?: string;
  /** Where tracked-flight entries are persisted; see src/tracked/store.ts. */
  trackedPath?: string;
  /**
   * Directory the device downloads its web UI (and later logo tiles and
   * firmware) from. On the VOLUME rather than in the image, so adding one logo
   * does not require a redeploy -- see src/assets.ts.
   */
  assetsPath?: string;
  /**
   * Shared secret for the remote-control routes. Absent disables them
   * entirely -- they 404 and the device never calls them -- the same
   * inert-rather-than-broken posture the tracked routes take without OpenSky
   * credentials. Anyone holding this has full control of the wall.
   */
  controlToken?: string;
  /** Where the command queue and last-reported status live; see src/control.ts. */
  controlPath?: string;
}

const DEFAULT_PORT = 8787;
const DEFAULT_BOARDS = 'KJFK,KLGA,KEWR,KBOS';
const DEFAULT_SCHEDULE_PATH = './data/schedule.json';
const DEFAULT_TRACKED_PATH = './data/tracked.json';
const DEFAULT_ASSETS_PATH = './data/assets';
const DEFAULT_CONTROL_PATH = './data/control.json';
/**
 * AeroDataBox refresh cadence.
 *
 * Two hours, not six. The window is +/-6h around BUILD time, so at six-hourly
 * refreshes its forward half is spent by the end of each cycle: at build+6h
 * the aircraft overhead are landing at build+6h and later, and the table stops
 * exactly there. Route fill decayed across every cycle as a result, and rows
 * AeroDataBox populates late were missed entirely -- DL2532 (PBI->LGA, landing
 * 13:50Z) was absent from a table built at 13:43Z and present in the same
 * board 15 minutes later. At two hours the window is never more than 2h
 * off-centre and a late-populated row is picked up within 2h.
 *
 * Cost, against the $5/mo Pro tier's 6,000 units/month (see
 * fixtures/README.md for how the 2-units-per-call tier was measured):
 *   4 boards x 2 units x 9/day x 30 = 2,160 units/month
 * (9, not 12: quiet hours skip the 00:00, 02:00 and 04:00 refreshes and add one
 * forced refresh when the window ends -- see DEFAULT_QUIET_HOURS below)
 * versus 960 at six-hourly. Three times the spend, no change in dollars, and
 * still ~2x headroom. Hourly would be 5,760 -- inside the tier but with no
 * margin for a retry storm, so two hours is the defensible point.
 */
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/**
 * Port Authority merge cadence -- DISABLED (0).
 *
 * The adapter works and is fully tested against real captured boards, but the
 * endpoint will not serve us in production:
 *
 *   - The OVH box was refused 403 on its FIRST request, with and without a
 *     browser User-Agent.
 *   - Blocks escalate. A first block cleared in ~15-20 minutes; a second, after
 *     only modest additional traffic, had not cleared after 40 minutes of
 *     five-minute polling.
 *   - And the cadence that looked safe was measured from a residential IP,
 *     which says nothing about a datacenter one -- the wrong machine entirely.
 *
 * A source that escalates blocks under light exploratory load cannot be a live
 * dependency for the panel. The code is kept because it is correct, documented
 * and costs nothing while disabled: set this to a positive number to re-enable
 * it if the boards are ever reachable from wherever this runs (a different
 * egress, or a residential host).
 */
const PANYNJ_DISABLED = 0;

// 00:00-06:00. All four boards are NYC-area, so local time is America/New_York.
const DEFAULT_QUIET_HOURS = '0-6';
const DEFAULT_QUIET_TZ = 'America/New_York';

/**
 * The zone if we can actually format with it, else the default.
 *
 * The refresh path feeds this straight to `new Intl.DateTimeFormat`, which
 * throws RangeError on a zone it does not know -- from inside a floating
 * `void refreshTick()`, where under Node's default --unhandled-rejections=throw
 * it takes the process down. REFRESH_QUIET_TZ is a plain-text value in
 * config/deploy.yml, so without this a one-character typo is an outage of the
 * entire service, positions and /up included, rather than of the refresh it was
 * meant to configure. Probing once at startup turns that into a log line, the
 * same refusal-to-guess parseQuietHours applies to a malformed window.
 */
function usableTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric' }).format(new Date());
    return tz;
  } catch {
    console.error(
      `REFRESH_QUIET_TZ="${tz}" is not a usable IANA zone; falling back to ${DEFAULT_QUIET_TZ}`,
    );
    return DEFAULT_QUIET_TZ;
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || DEFAULT_PORT,
    aerodataboxKey: env.AERODATABOX_KEY ?? '',
    boards: env.BOARDS ?? DEFAULT_BOARDS,
    schedulePath: env.SCHEDULE_PATH ?? DEFAULT_SCHEDULE_PATH,
    refreshIntervalMs: TWO_HOURS_MS,
    quietHours: parseQuietHours(env.REFRESH_QUIET_HOURS ?? DEFAULT_QUIET_HOURS),
    quietHoursTimeZone: usableTimeZone(env.REFRESH_QUIET_TZ ?? DEFAULT_QUIET_TZ),
    boardFetchDelayMs: BOARD_FETCH_DELAY_MS,
    panynjIntervalMs: PANYNJ_DISABLED,
    panynjPageDelayMs: PAGE_DELAY_MS,
    openSkyClientId: env.OPENSKY_CLIENT_ID ?? '',
    openSkyClientSecret: env.OPENSKY_CLIENT_SECRET ?? '',
    trackedPath: env.TRACKED_PATH ?? DEFAULT_TRACKED_PATH,
    assetsPath: env.ASSETS_PATH ?? DEFAULT_ASSETS_PATH,
    controlToken: env.CONTROL_TOKEN ?? '',
    controlPath: env.CONTROL_PATH ?? DEFAULT_CONTROL_PATH,
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  env: Env,
  assetsRoot: string,
  control: { storage: ControlStorage; token: string } | null,
): Promise<void> {
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

  if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
    // The watched-flights page. Served whether or not the feature is
    // configured, unlike /v1/tracked below, which 404s without OpenSky
    // credentials -- a 404 at the root of your own server is a puzzle, whereas
    // the page states plainly which two env vars are missing. It discovers that
    // for itself, from the 404 its first fetch gets.
    //
    // no-cache rather than a max-age: this is one small string with no
    // fingerprint in its URL, so a cached copy after a redeploy is a page whose
    // embedded constants disagree with the server it is talking to.
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    });
    // Node drops the body itself on a HEAD response.
    res.end(trackedPage);
    return;
  }

  if (url.pathname === '/v1/control' || url.pathname.startsWith('/v1/control/')) {
    // Absent a token these routes do not exist, rather than existing and
    // refusing -- the same posture /v1/tracked takes without OpenSky
    // credentials. A 404 also declines to confirm the feature is here at all.
    if (!control) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const response = await handleControl(
      req.method ?? 'GET',
      url,
      Buffer.concat(chunks).toString('utf8'),
      req.headers.authorization,
      control.storage,
      control.token,
      Date.now(),
    );
    const body = await response.text();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // Carried through from the handler rather than assumed: without it these
      // responses were cached at the edge and served minutes stale.
      'cache-control': response.headers.get('cache-control') ?? 'no-store',
    };
    const wa = response.headers.get('www-authenticate');
    if (wa) headers['www-authenticate'] = wa;
    res.writeHead(response.status, headers);
    res.end(body);
    return;
  }

  if (url.pathname === '/v1/assets/manifest') {
    const response = await assetManifest(assetsRoot);
    const body = await response.text();
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    // Read-only, and only of files someone deliberately put in the asset
    // directory. Unauthenticated like the rest of this server: the device has
    // no credential to present, and these are the same bytes the firmware
    // repository already publishes.
    const response = await serveAsset(assetsRoot, url.pathname.slice('/assets/'.length));
    const buf = Buffer.from(await response.arrayBuffer());
    const headers: Record<string, string> = { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' };
    const sha = response.headers.get('x-asset-sha256');
    if (sha) headers['x-asset-sha256'] = sha;
    headers['cache-control'] = 'no-cache';
    res.writeHead(response.status, headers);
    res.end(buf);
    return;
  }

  if (url.pathname === '/v1/flights') {
    const response = await handleFlights(url, env, Date.now());
    const body = await response.text();
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
    res.end(body);
    return;
  }

  if (url.pathname === '/v1/tracked' || url.pathname.startsWith('/v1/tracked/')) {
    // env.TRACKED is only set when OPENSKY_CLIENT_ID/SECRET are configured
    // (see startServer) -- absent, this 404s rather than accepting entries
    // a tick that will never run can't ever resolve or poll.
    if (!env.TRACKED) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const response = await handleTracked(
      req.method ?? 'GET',
      url,
      Buffer.concat(chunks).toString('utf8'),
      env.TRACKED,
      Date.now(),
    );
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
  // Coerced to plain strings once, here, so every use below (the route guard's
  // closure included) sees `string`, not `string | undefined` -- config's
  // fields are optional only so pre-existing ServerConfig literals elsewhere
  // keep compiling without naming a feature they don't exercise.
  const openSkyClientId = config.openSkyClientId ?? '';
  const openSkyClientSecret = config.openSkyClientSecret ?? '';
  const trackedPath = config.trackedPath ?? DEFAULT_TRACKED_PATH;
  // Absent credentials keep the feature entirely inert: no storage is wired
  // into env (so /v1/tracked 404s, see handleRequest) and, further down, no
  // tick timer is created either.
  const trackedStorage = openSkyClientId ? fileTrackedStorage(trackedPath) : undefined;

  // Inert without a token: no storage is opened, and handleRequest 404s the
  // routes rather than serving them to be refused.
  const controlToken = config.controlToken ?? '';
  const control = controlToken
    ? { storage: fileControlStorage(config.controlPath ?? DEFAULT_CONTROL_PATH), token: controlToken }
    : null;
  if (!controlToken) {
    console.log('CONTROL_TOKEN is not set -- remote control is disabled.');
  }
  // Only what handleFlights reads. It used to be handed the board list and a
  // paid-API secret it has no use for, on a per-request read-only path.
  const env: Env = { SCHEDULE: storage, TRACKED: trackedStorage };
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

  // Checked every 5 minutes rather than every refreshIntervalMs. setInterval has
  // arbitrary phase, so keying the refresh off it alone would mean the first run
  // after quiet hours end could be nearly a full interval late -- leaving the
  // table centred on the previous evening exactly when the panel wakes.
  const REFRESH_CHECK_MS = 5 * 60 * 1000;
  let lastRefreshMs: number | null = null;
  let wasQuiet = false;
  let quietLogged = false;

  const localHour = (): number =>
    Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: config.quietHoursTimeZone,
        hour: 'numeric',
        hour12: false,
      }).format(new Date()),
    ) % 24;

  const refreshTick = async (): Promise<void> => {
    const quiet = config.quietHours !== null && inQuietHours(localHour(), config.quietHours);
    const go = shouldRefresh({
      nowMs: Date.now(),
      lastRefreshMs,
      intervalMs: config.refreshIntervalMs,
      quiet,
      wasQuiet,
    });
    wasQuiet = quiet;
    if (!go) {
      // Logged, not silent: a refresh that stops happening must say so, or it is
      // indistinguishable from an upstream outage. Keyed to the first tick
      // actually SKIPPED rather than to the quiet edge, because a cold start
      // inside the window refreshes anyway (see shouldRefresh) -- announcing a
      // pause on the tick that refreshes would be exactly the plausible-looking
      // wrong statement this line exists to prevent.
      if (quiet && !quietLogged) {
        console.log(`schedule: quiet hours (${config.quietHours!.startHour}-${config.quietHours!.endHour} ${config.quietHoursTimeZone}); refresh paused until the window ends`);
        quietLogged = true;
      }
      return;
    }
    quietLogged = false;
    lastRefreshMs = Date.now();
    await runBoth();
  };

  void refreshTick(); // once at boot
  const timer = setInterval(() => void refreshTick(), REFRESH_CHECK_MS);
  const panynjTimer = panynjEnabled
    ? setInterval(() => void runPanynj(), config.panynjIntervalMs)
    : undefined;

  // 300s. MEASURED: a single-icao24 query costs FOUR credits against an
  // authenticated allowance of 4000/day, so the real budget is 1000 queries a
  // day. At 300s an eight-hour flight costs 96 of them, so roughly TEN can be
  // tracked concurrently (960) -- comfortably more than the 20-entry cap would
  // ever have airborne at once. The earlier 60s and 120s values supported two
  // and four respectively; 300s is what makes the entry cap, rather than the
  // OpenSky budget, the binding constraint, which is the right way round.
  //
  // The cost is position freshness: at ~500kt an aircraft moves ~40nm between
  // polls. That is immaterial here because the panel renders a CARD -- ident,
  // route, ETA -- not a moving map, and the schedule fields that drive the card
  // do not change between polls at all. Revisit only if this ever feeds
  // something positional.
  //
  // Note this interval also paces RESOLUTION, so a newly added entry waits up
  // to 5 minutes before its aircraft is looked up. Acceptable: entries are
  // added hours ahead of departure, not seconds.
  // See docs/superpowers/audits/2026-08-24-tracked-flights-measurements.md.
  const TRACKED_TICK_MS = 300_000;
  let resolvesUsedToday = 0;
  let resolveDay = new Date().getUTCDate();

  const trackedTimer = trackedStorage
    ? setInterval(() => {
        const today = new Date().getUTCDate();
        if (today !== resolveDay) {
          resolveDay = today;
          resolvesUsedToday = 0;
        }
        void runTrackedTick(trackedStorage, Date.now(), {
          resolve: async (n, d) => {
            resolvesUsedToday++;
            return resolveFlight(n, d, config.aerodataboxKey);
          },
          position: (hex) => fetchPosition(hex, openSkyClientId, openSkyClientSecret),
          resolvesUsedToday,
        }).catch((e) => console.error('tracked tick failed:', e instanceof Error ? e.message : String(e)));
      }, TRACKED_TICK_MS)
    : undefined;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(req, res, env, config.assetsPath ?? DEFAULT_ASSETS_PATH, control).catch((err) => {
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
        clearInterval(trackedTimer);
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
          clearInterval(trackedTimer);
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
