import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Remote control, carried on the poll the device already makes.
 *
 * The device cannot be reached from here -- it is behind a home NAT and only
 * makes outbound connections -- so nothing here ever initiates. The device
 * checks in, reports what it is doing, and collects whatever a human queued.
 *
 * See docs/superpowers/specs/2026-08-25-remote-control-design.md.
 */

/** Actions the device knows how to perform. Anything else is refused here
 * rather than sent for the device to puzzle over. */
const ACTIONS = ['restart', 'updateui', 'updatefw'] as const;
export type ControlAction = (typeof ACTIONS)[number];

export interface Command {
  id: string;
  queuedAtMs: number;
  /** A partial settings document, with network keys already removed. */
  set?: Record<string, unknown>;
  action?: ControlAction;
}

export interface ControlState {
  /** Whatever the device last reported, verbatim, plus when. */
  status: Record<string, unknown> | null;
  statusAtMs: number | null;
  queue: Command[];
}

/**
 * Hard cap on queued commands.
 *
 * Load-bearing for the same reason the tracked-entry cap is: this endpoint is
 * reachable by anyone holding the token, and a queue with no ceiling is a way
 * to fill a disk. Twenty is far more than a human queues between two check-ins
 * sixty seconds apart.
 */
export const MAX_QUEUE = 20;

const EMPTY: ControlState = { status: null, statusAtMs: null, queue: [] };

export interface ControlStorage {
  read(): Promise<ControlState>;
  write(s: ControlState): Promise<void>;
}

/**
 * File-backed, on the same volume as the schedule table and tracked entries,
 * so a redeploy loses neither a queued command nor the last known status.
 *
 * Mirrors tracked/store.ts down to the write-to-temp-then-rename and the
 * unlink-on-failure, for the reasons documented there: a crash mid-write must
 * not leave a half-written file, and a failed write must not orphan a temp file
 * whose name carries a fresh UUID each attempt.
 */
export function fileControlStorage(path: string): ControlStorage {
  return {
    async read(): Promise<ControlState> {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
        const s = parsed as Partial<ControlState>;
        return {
          status: s.status ?? null,
          statusAtMs: typeof s.statusAtMs === 'number' ? s.statusAtMs : null,
          queue: Array.isArray(s.queue) ? s.queue : [],
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.error('control store read failed:', err instanceof Error ? err.message : String(err));
        }
        return { ...EMPTY };
      }
    },

    async write(s: ControlState): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(s), 'utf8');
        await rename(tmp, path);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    },
  };
}

/**
 * Constant-time bearer check.
 *
 * `===` on a secret leaks its prefix through timing, and this one grants
 * control of the device. The length guard before the compare is required
 * because timingSafeEqual throws on differing lengths -- so length itself is
 * still observable, which is acceptable and unavoidable here.
 */
export function authorised(header: string | null | undefined, token: string): boolean {
  if (!token) return false;
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length));
  const want = Buffer.from(token);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/**
 * Strip the settings a remote caller must never be able to change.
 *
 * NETWORK IS EXCLUDED, and this is one of the two places that enforces it --
 * the device strips it again before applying. That second check is not
 * redundant: it is the one that still holds when this server is what has been
 * compromised, which is exactly the scenario the exclusion exists for.
 *
 * A wrong SSID applied from across the internet drops the wall off the network,
 * and the only remaining repair is physical access.
 */
export function stripProtected(set: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(set)) {
    if (k === 'network') continue;

    // api.controlToken is the SECOND self-destructive setting, and it belongs
    // here for exactly the same reason as network: changing it remotely locks
    // remote control out permanently, and the only repair is the LAN page this
    // feature exists to avoid needing. The rest of `api` stays settable.
    if (k === 'api' && v && typeof v === 'object' && !Array.isArray(v)) {
      const api: Record<string, unknown> = {};
      for (const [ak, av] of Object.entries(v as Record<string, unknown>)) {
        if (ak === 'controlToken') continue;
        api[ak] = av;
      }
      if (Object.keys(api).length > 0) out[k] = api;
      continue;
    }

    out[k] = v;
  }
  return out;
}

/**
 * no-store on EVERY control response, without exception.
 *
 * Not defensive boilerplate -- an observed bug. Without it these responses were
 * cached at the edge, and repeated polls returned a status minutes old while
 * the device was checking in every cycle. It cost several minutes of diagnosing
 * a device that was working perfectly, and on the control page it would be
 * worse: a page whose entire job is saying what the wall is doing, showing a
 * stale answer as though it were live. The age field cannot save a reader from
 * that, because the age is cached along with the status.
 *
 * no-store rather than no-cache: these carry device state and command queues
 * behind a bearer token, and there is no version of "keep a copy" that helps.
 */
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const UNAUTHORISED = (): Response =>
  new Response(JSON.stringify({ ok: false, error: 'unauthorised' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer',
      'cache-control': 'no-store',
    },
  });

/**
 * GET /v1/control, POST /v1/control/command, POST /v1/control/checkin.
 *
 * `nowMs` is a parameter rather than a Date.now() call so the age arithmetic is
 * testable, matching the convention every other handler here follows.
 */
export async function handleControl(
  method: string,
  url: URL,
  bodyText: string,
  authHeader: string | null | undefined,
  storage: ControlStorage,
  token: string,
  nowMs: number,
): Promise<Response> {
  if (!authorised(authHeader, token)) return UNAUTHORISED();

  const state = await storage.read();

  // The DEVICE's call: report status, collect commands. Collecting drains the
  // queue -- at-most-once, by decision. A command lost to a reboot mid-apply is
  // re-queued by a human, which is preferable to one that silently repeats.
  if (method === 'POST' && url.pathname === '/v1/control/checkin') {
    let status: Record<string, unknown>;
    try {
      status = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: 'body must be JSON' }, 400);
    }
    const commands = state.queue;
    await storage.write({ status, statusAtMs: nowMs, queue: [] });
    return json({ ok: true, commands });
  }

  // The PAGE's call.
  if (method === 'GET' && url.pathname === '/v1/control') {
    return json({
      ok: true,
      status: state.status,
      // Age rather than a timestamp: a control page must never present stale
      // state as though it were live, and an age is the one form a reader
      // cannot misjudge at a glance.
      statusAgeMs: state.statusAtMs === null ? null : nowMs - state.statusAtMs,
      pending: state.queue,
    });
  }

  if (method === 'POST' && url.pathname === '/v1/control/command') {
    let input: { set?: unknown; action?: unknown };
    try {
      input = JSON.parse(bodyText) as { set?: unknown; action?: unknown };
    } catch {
      return json({ ok: false, error: 'body must be JSON' }, 400);
    }

    if (state.queue.length >= MAX_QUEUE) {
      return json({ ok: false, error: `at most ${MAX_QUEUE} queued commands` }, 429);
    }

    const cmd: Command = { id: randomUUID(), queuedAtMs: nowMs };

    if (typeof input.action === 'string') {
      if (!ACTIONS.includes(input.action as ControlAction)) {
        return json({ ok: false, error: `unknown action; expected one of ${ACTIONS.join(', ')}` }, 400);
      }
      cmd.action = input.action as ControlAction;
    } else if (input.set && typeof input.set === 'object' && !Array.isArray(input.set)) {
      const stripped = stripProtected(input.set as Record<string, unknown>);
      if (Object.keys(stripped).length === 0) {
        // Everything sent was refused. Saying so beats queueing a no-op that
        // appears to have worked.
        return json({ ok: false, error: 'nothing settable remained (network settings cannot be set remotely)' }, 400);
      }
      cmd.set = stripped;
    } else {
      return json({ ok: false, error: 'expected {set:{…}} or {action:"…"}' }, 400);
    }

    await storage.write({ ...state, queue: [...state.queue, cmd] });
    return json({ ok: true, command: cmd }, 201);
  }

  return json({ ok: false, error: 'not found' }, 404);
}
