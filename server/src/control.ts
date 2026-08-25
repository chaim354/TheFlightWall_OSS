import { randomUUID } from 'node:crypto';
import {
  tierFor,
  hashPassword,
  actionNeedsAdmin,
  adminFieldsIn,
  DEFAULT_UI_PASSWORD,
  type Secrets,
  type Tier,
} from './controlAuth';
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
  /** Null while the shipped default is still in force -- see controlAuth. */
  uiPasswordHash?: string | null;
  /** Null until one is set; the admin tier is unreachable until then, rather
   * than falling back to a weaker check. */
  adminPasswordHash?: string | null;
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

const EMPTY: ControlState = {
  status: null, statusAtMs: null, queue: [], uiPasswordHash: null, adminPasswordHash: null,
};

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
          uiPasswordHash: s.uiPasswordHash ?? null,
          adminPasswordHash: s.adminPasswordHash ?? null,
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
 * What the wall reports about itself, minus the part nobody browsing needs.
 *
 * `network` carries the home Wi-Fi SSID. The device already redacts the
 * password, but the SSID is the name of the reader's house network, and this
 * page is reachable from the internet behind a password that ships with a
 * public default -- so the SSID would be readable by anyone who found the URL
 * before the password was ever changed.
 *
 * Stripped on ARRIVAL rather than on display, so it is never written to the
 * state file either. A leak that only exists on disk is still a leak, and the
 * page is not the only thing that reads that file.
 *
 * The mirror image of stripProtected(): that one keeps network settings from
 * travelling server -> device, this one keeps them from travelling
 * device -> browser.
 */
export function redactStatus(status: Record<string, unknown>): Record<string, unknown> {
  const settings = status.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return status;
  const rest = { ...(settings as Record<string, unknown>) };
  if (!('network' in rest)) return status;
  delete rest.network;
  return { ...status, settings: rest };
}

/**
 * GET /v1/control, POST /v1/control/{checkin,command,password}.
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
  deviceToken: string,
  nowMs: number,
): Promise<Response> {
  const state = await storage.read();
  const secrets: Secrets = {
    deviceToken,
    uiPasswordHash: state.uiPasswordHash ?? null,
    adminPasswordHash: state.adminPasswordHash ?? null,
  };

  const bearer = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : null;
  const tier: Tier = tierFor(bearer, secrets);
  if (tier === 'none') return UNAUTHORISED();

  const usingDefaultUiPassword = !state.uiPasswordHash;
  const adminAvailable = !!state.adminPasswordHash;

  // The DEVICE's call: report status, collect commands. Collecting drains the
  // queue -- at-most-once, by decision. A command lost to a reboot mid-apply is
  // re-queued by a human, which is preferable to one that silently repeats.
  if (method === 'POST' && url.pathname === '/v1/control/checkin') {
    // Only the device may check in. A browser holding the UI password must not
    // be able to overwrite the reported status with anything it likes.
    if (tier !== 'device') return json({ ok: false, error: 'not the device' }, 403);
    let status: Record<string, unknown>;
    try {
      status = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: 'body must be JSON' }, 400);
    }
    const commands = state.queue;
    await storage.write({ ...state, status: redactStatus(status), statusAtMs: nowMs, queue: [] });
    return json({ ok: true, commands });
  }

  // Everything below is for a person, never the device.
  if (tier === 'device') return json({ ok: false, error: 'device token cannot do this' }, 403);

  if (method === 'GET' && url.pathname === '/v1/control') {
    return json({
      ok: true,
      tier,
      // The page shows a standing warning while this is true. Once, at login,
      // would not be enough: the exposure lasts as long as the default does.
      usingDefaultUiPassword,
      adminAvailable,
      status: state.status,
      // Age rather than a timestamp: a control page must never present stale
      // state as though it were live, and an age is the one form a reader
      // cannot misjudge at a glance.
      statusAgeMs: state.statusAtMs === null ? null : nowMs - state.statusAtMs,
      pending: state.queue,
    });
  }

  // Changing either password.
  if (method === 'POST' && url.pathname === '/v1/control/password') {
    let input: { which?: unknown; newPassword?: unknown };
    try {
      input = JSON.parse(bodyText) as { which?: unknown; newPassword?: unknown };
    } catch {
      return json({ ok: false, error: 'body must be JSON' }, 400);
    }
    const which = input.which === 'admin' ? 'admin' : 'ui';
    const next = typeof input.newPassword === 'string' ? input.newPassword : '';
    if (next.length < 8) {
      return json({ ok: false, error: 'password must be at least 8 characters' }, 400);
    }
    // Setting the ADMIN password needs admin -- unless none exists yet, which
    // is the bootstrap case: somebody has to be able to create the first one,
    // and the UI password is the only credential available at that point.
    if (which === 'admin' && adminAvailable && tier !== 'admin') {
      return json({ ok: false, error: 'changing the admin password needs the admin password' }, 403);
    }
    if (which === 'ui' && next === DEFAULT_UI_PASSWORD) {
      // Refusing beats accepting: setting it back to the shipped default would
      // clear the warning while leaving the exposure exactly as it was.
      return json({ ok: false, error: 'that is the shipped default; choose something else' }, 400);
    }
    const hash = hashPassword(next);
    await storage.write({
      ...state,
      uiPasswordHash: which === 'ui' ? hash : (state.uiPasswordHash ?? null),
      adminPasswordHash: which === 'admin' ? hash : (state.adminPasswordHash ?? null),
    });
    return json({ ok: true, which });
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
      if (actionNeedsAdmin(input.action) && tier !== 'admin') {
        return json({
          ok: false,
          needsAdmin: true,
          error: adminAvailable
            ? `"${input.action}" needs the admin password`
            : `"${input.action}" needs an admin password, and none has been set yet`,
        }, 403);
      }
      cmd.action = input.action as ControlAction;
    } else if (input.set && typeof input.set === 'object' && !Array.isArray(input.set)) {
      const stripped = stripProtected(input.set as Record<string, unknown>);
      if (Object.keys(stripped).length === 0) {
        return json({ ok: false, error: 'nothing settable remained (network settings and the control token cannot be set remotely)' }, 400);
      }
      const needsAdmin = adminFieldsIn(stripped);
      if (needsAdmin.length > 0 && tier !== 'admin') {
        // Named rather than generic: "needs the admin password" leaves someone
        // hunting through a form for which field did it.
        return json({
          ok: false,
          needsAdmin: true,
          error: `${needsAdmin.join(', ')} ${needsAdmin.length === 1 ? 'needs' : 'need'} the admin password`,
        }, 403);
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
