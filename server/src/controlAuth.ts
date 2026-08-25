import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Who is asking, and how much they may do.
 *
 * THREE secrets, not one, and the split is what makes a resettable password
 * possible at all:
 *
 *   device  CONTROL_TOKEN, from the environment. Machine-to-machine, and
 *           deliberately NOT resettable from the browser -- changing it would
 *           leave the wall holding a token the server no longer accepts, unable
 *           to check in, with the only repair being the LAN page this whole
 *           feature exists to avoid needing.
 *   ui      What a person types. Resettable, and defaults to a known string.
 *   admin   A second password for the things that can break the wall or spend
 *           money: flashing, updating, restarting, panel geometry, the light
 *           sensor, the fetch interval, and the data sources.
 *
 * Admin implies ui. A person holding the admin password does not also have to
 * type the other one.
 */
export type Tier = 'none' | 'device' | 'ui' | 'admin';

/**
 * The default UI password.
 *
 * Public, guessable, and shipped on purpose -- so the page works the moment it
 * is deployed. It is not a secret and must never be treated as one: while it is
 * in use, anyone who finds the URL can change settings and restart the wall.
 * `usingDefaultUiPassword` exists so the page can say so continuously rather
 * than once, and the admin tier is what keeps flashing out of reach regardless.
 */
export const DEFAULT_UI_PASSWORD = 'flightwall123';

/** scrypt with a per-password salt. Not bcrypt only because this project has no
 * runtime dependencies and node's crypto has scrypt built in. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  // Buffer.from() around each: the same string-overload resolution that bit
  // assets.ts -- without it TS picks a zero-argument toString and the hex
  // encoding is silently dropped.
  return `scrypt$${Buffer.from(salt).toString('hex')}$${Buffer.from(hash).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt: Buffer;
  let want: Buffer;
  try {
    salt = Buffer.from(parts[1]!, 'hex');
    want = Buffer.from(parts[2]!, 'hex');
  } catch {
    return false;
  }
  if (want.length === 0) return false;
  const got = scryptSync(password, salt, want.length);
  return timingSafeEqual(got, want);
}

/** Constant-time compare for the device token, which is a plain shared secret
 * rather than a stored hash. */
export function tokenMatches(candidate: string, token: string): boolean {
  if (!token || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface Secrets {
  /** CONTROL_TOKEN, for the device. Empty disables the whole feature. */
  deviceToken: string;
  /** Null means the default is still in force. */
  uiPasswordHash: string | null;
  /** Null means no admin password has been set, and the admin tier is
   * unreachable -- flashing and the rest stay unavailable rather than falling
   * back to a weaker check. */
  adminPasswordHash: string | null;
}

/**
 * Resolve a bearer credential to a tier.
 *
 * ORDER MATTERS: admin is checked before ui, so setting the admin password to
 * the same string as the ui one grants admin rather than silently capping at
 * ui. Device is checked first and separately because it is a different KIND of
 * caller -- it may only check in, never queue.
 */
export function tierFor(bearer: string | null | undefined, s: Secrets): Tier {
  if (!bearer) return 'none';
  if (s.deviceToken && tokenMatches(bearer, s.deviceToken)) return 'device';
  if (s.adminPasswordHash && verifyPassword(bearer, s.adminPasswordHash)) return 'admin';
  if (s.uiPasswordHash) {
    if (verifyPassword(bearer, s.uiPasswordHash)) return 'ui';
  } else if (tokenMatches(bearer, DEFAULT_UI_PASSWORD)) {
    return 'ui';
  }
  return 'none';
}

/**
 * Settings that require the admin tier.
 *
 * Everything here can either break the wall (panel geometry, the light sensor
 * type and pin) or change what it costs and where its data comes from (the
 * sources, the API credentials, the fetch interval). None of it is something a
 * person adjusts while looking at the wall; all of it is something that can
 * leave the wall blank or spending money, with no way to tell from the page
 * which happened.
 *
 * The test is that last clause, not "is it about hardware": turning the light
 * sensor on and off, and saying what counts as dark, are exactly what somebody
 * standing in front of a too-dim wall needs, so they stay on the main page.
 *
 * Whole sections where the whole section qualifies, individual keys where it
 * does not.
 */
const ADMIN_SECTIONS = new Set(['hardware']);
const ADMIN_KEYS: Record<string, Set<string>> = {
  display: new Set(['fetchIntervalSeconds']),
  // The light sensor splits rather than gating whole. Which sensor it is and
  // which pin it is on are wiring -- getting them wrong blanks the panel and
  // pauses fetching, which looks exactly like a dead device from the page.
  // Whether the sensor is USED and what counts as dark are everyday tuning:
  // the wall is too dim this evening, or it never comes back on in the
  // morning. Locking those behind the admin password means walking to the wall
  // to fix a room that got darker, which is the opposite of the point.
  //
  // Hysteresis moved to the main page: it is the margin that stops the wall
  // flapping at dusk, so it is set BY tuning the threshold and is useless
  // apart from it. Only which sensor and which pin remain wiring.
  light: new Set(['type', 'pin']),
  api: new Set([
    'positionSource', 'enrichmentSource', 'enrichmentFallbackToAeroApi', 'serverUrl',
    // Credentials and the two knobs that decide how often they get spent.
    'aeroApiKey', 'openSkyClientId', 'openSkyClientSecret', 'enrichmentCacheSeconds',
  ]),
};

/** Actions that require the admin tier: everything that flashes, updates, or
 * takes the wall down. */
const ADMIN_ACTIONS = new Set(['restart', 'updateui', 'updatefw']);

export function actionNeedsAdmin(action: string): boolean {
  return ADMIN_ACTIONS.has(action);
}

/**
 * Which admin-only settings a command touches, if any.
 *
 * Returns the names so the refusal can SAY what was refused. "Needs the admin
 * password" leaves someone hunting through a form; "hardware, display.fetchIntervalSeconds
 * need the admin password" does not.
 */
/**
 * The same list, applied to READS.
 *
 * A tier that may not set a field has no business being shown its value
 * either: the ui password ships with a public default, so anything returned to
 * that tier is effectively public until someone changes it. The OpenSky client
 * id is the account holder's email address; the AeroAPI key arrives redacted
 * but its presence flag does not have to.
 *
 * Deliberately driven by the SAME constants as adminFieldsIn(), so a field
 * added to one direction cannot be forgotten in the other -- which is exactly
 * how the Wi-Fi SSID ended up readable.
 */
export function redactSettingsForTier(
  settings: Record<string, unknown>,
  tier: Tier,
): Record<string, unknown> {
  if (tier === 'admin') return settings;

  const out: Record<string, unknown> = {};
  for (const [section, value] of Object.entries(settings)) {
    if (ADMIN_SECTIONS.has(section)) continue;

    const keys = ADMIN_KEYS[section];
    if (!keys || !value || typeof value !== 'object' || Array.isArray(value)) {
      out[section] = value;
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!keys.has(k)) kept[k] = v;
    }
    out[section] = kept;
  }
  return out;
}

export function adminFieldsIn(set: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const [section, value] of Object.entries(set)) {
    if (ADMIN_SECTIONS.has(section)) {
      found.push(section);
      continue;
    }
    const keys = ADMIN_KEYS[section];
    if (keys && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const k of Object.keys(value as Record<string, unknown>)) {
        if (keys.has(k)) found.push(`${section}.${k}`);
      }
    }
  }
  return found;
}
