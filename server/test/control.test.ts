import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleControl,
  redactStatus,
  stripProtected,
  MAX_QUEUE,
  type ControlState,
  type ControlStorage,
} from '../src/control';
import {
  tierFor,
  hashPassword,
  verifyPassword,
  adminFieldsIn,
  redactSettingsForTier,
  actionNeedsAdmin,
  DEFAULT_UI_PASSWORD,
} from '../src/controlAuth';

const DEVICE = 'device-token-abc';
const NOW = 1_700_000_000_000;

let state: ControlState;
let store: ControlStorage;

beforeEach(() => {
  state = { status: null, statusAtMs: null, queue: [], uiPasswordHash: null, adminPasswordHash: null };
  store = { read: async () => state, write: async (s) => { state = s; } };
});

const call = (method: string, path: string, body = '', secret: string | null = DEFAULT_UI_PASSWORD, now = NOW) =>
  handleControl(
    method,
    new URL(`http://x${path}`),
    body,
    secret === null ? null : `Bearer ${secret}`,
    store,
    DEVICE,
    now,
  );

describe('password hashing', () => {
  it('round-trips and rejects a wrong password', () => {
    const h = hashPassword('correct horse battery');
    expect(verifyPassword('correct horse battery', h)).toBe(true);
    expect(verifyPassword('Correct horse battery', h)).toBe(false);
    expect(verifyPassword('', h)).toBe(false);
  });

  it('salts, so the same password hashes differently each time', () => {
    // Otherwise two deployments sharing a password share a hash, and one leaked
    // file says something about every other one.
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('refuses malformed stored values rather than throwing', () => {
    for (const bad of [null, undefined, '', 'plaintext', 'scrypt$nothex$nothex', 'bcrypt$a$b']) {
      expect(verifyPassword('x', bad as string | null)).toBe(false);
    }
  });
});

describe('tierFor', () => {
  const secrets = (ui: string | null, admin: string | null) => ({
    deviceToken: DEVICE,
    uiPasswordHash: ui === null ? null : hashPassword(ui),
    adminPasswordHash: admin === null ? null : hashPassword(admin),
  });

  it('recognises the device token', () => {
    expect(tierFor(DEVICE, secrets(null, null))).toBe('device');
  });

  it('accepts the shipped default only while no ui password is set', () => {
    expect(tierFor(DEFAULT_UI_PASSWORD, secrets(null, null))).toBe('ui');
    // Once a real one exists the default must stop working, or resetting the
    // password would change nothing at all.
    expect(tierFor(DEFAULT_UI_PASSWORD, secrets('a-real-password', null))).toBe('none');
  });

  it('prefers admin when both match, so a shared string is not capped at ui', () => {
    expect(tierFor('same-password', secrets('same-password', 'same-password'))).toBe('admin');
  });

  it('gives nothing for an unknown credential', () => {
    expect(tierFor('nope', secrets('ui-pass', 'admin-pass'))).toBe('none');
    expect(tierFor(null, secrets('ui-pass', 'admin-pass'))).toBe('none');
  });
});

describe('adminFieldsIn', () => {
  it('names whole admin sections and individual admin keys', () => {
    expect(adminFieldsIn({ hardware: { panelResX: 64 } })).toEqual(['hardware']);
    // The light sensor splits: wiring is admin, everyday tuning is not.
    expect(adminFieldsIn({ light: { pin: 3 } })).toEqual(['light.pin']);
    expect(adminFieldsIn({ light: { type: 'bh1750', hysteresis: 80 } }).sort())
      .toEqual(['light.hysteresis', 'light.type']);
    expect(adminFieldsIn({ light: { enabled: true, darkThreshold: 900, dimInstead: true } })).toEqual([]);
    expect(adminFieldsIn({ display: { fetchIntervalSeconds: 30 } })).toEqual(['display.fetchIntervalSeconds']);
    expect(adminFieldsIn({ api: { positionSource: 'opensky', aeroApiKey: 'k' } }).sort())
      .toEqual(['api.aeroApiKey', 'api.positionSource']);
    // Every API credential, not just the paid one -- a leaked OpenSky secret
    // is somebody else's quota being spent under this account's name.
    expect(adminFieldsIn({ api: { openSkyClientSecret: 's', enrichmentCacheSeconds: 60 } }).sort())
      .toEqual(['api.enrichmentCacheSeconds', 'api.openSkyClientSecret']);
  });

  it('leaves ordinary settings alone', () => {
    expect(adminFieldsIn({ display: { brightness: 5, cycleSeconds: 8 }, filters: { hideCargo: true } })).toEqual([]);
  });

  it('gates every action that flashes, updates or takes the wall down', () => {
    for (const a of ['restart', 'updateui', 'updatefw']) expect(actionNeedsAdmin(a)).toBe(true);
  });
});

describe('stripProtected', () => {
  it('removes network and api.controlToken, keeping the rest', () => {
    expect(stripProtected({
      network: { wifiSsid: 'evil' },
      api: { controlToken: 'new', serverUrl: 'https://x' },
      display: { brightness: 5 },
    })).toEqual({ api: { serverUrl: 'https://x' }, display: { brightness: 5 } });
  });
});

describe('tiers on the wire', () => {
  it('401s an unknown credential and 403s the device outside check-in', async () => {
    expect((await call('GET', '/v1/control', '', 'wrong')).status).toBe(401);
    // The device may report; it may not queue or read the control view.
    expect((await call('GET', '/v1/control', '', DEVICE)).status).toBe(403);
    expect((await call('POST', '/v1/control/command', '{"action":"restart"}', DEVICE)).status).toBe(403);
  });

  it('refuses a browser trying to check in as the device', async () => {
    // Otherwise anyone with the UI password could fake what the wall reports,
    // and the page would show a fiction with a fresh timestamp on it.
    const res = await call('POST', '/v1/control/checkin', '{"fwVersion":"lies"}');
    expect(res.status).toBe(403);
    expect(state.status).toBeNull();
  });

  it('tells the page it is running on the shipped default', async () => {
    const body = (await (await call('GET', '/v1/control')).json()) as
      { tier: string; usingDefaultUiPassword: boolean; adminAvailable: boolean };
    expect(body.tier).toBe('ui');
    expect(body.usingDefaultUiPassword).toBe(true);
    expect(body.adminAvailable).toBe(false);
  });
});

describe('the admin tier', () => {
  it('refuses admin actions to the ui tier, and says none is set yet', async () => {
    const res = await call('POST', '/v1/control/command', JSON.stringify({ action: 'updatefw' }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { needsAdmin: boolean; error: string };
    expect(body.needsAdmin).toBe(true);
    expect(body.error).toContain('none has been set yet');
    expect(state.queue).toEqual([]);
  });

  it('refuses admin SETTINGS to the ui tier, naming the fields', async () => {
    // Named rather than generic: "needs the admin password" leaves someone
    // hunting through a form for which control did it.
    const res = await call('POST', '/v1/control/command', JSON.stringify({
      set: { display: { brightness: 5, fetchIntervalSeconds: 30 }, hardware: { panelResX: 64 } },
    }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('hardware');
    expect(body.error).toContain('display.fetchIntervalSeconds');
    expect(state.queue).toEqual([]);
  });

  it('allows ordinary settings to the ui tier', async () => {
    const res = await call('POST', '/v1/control/command', JSON.stringify({
      set: { display: { brightness: 5 }, filters: { hideCargo: true } },
    }));
    expect(res.status).toBe(201);
    expect(state.queue).toHaveLength(1);
  });

  it('bootstraps the first admin password from the ui tier, then locks it', async () => {
    // Somebody has to be able to create the first one, and the ui password is
    // the only credential in existence at that point.
    expect((await call('POST', '/v1/control/password',
      JSON.stringify({ which: 'admin', newPassword: 'admin-password-1' }))).status).toBe(200);

    // ...and must not be able to change it afterwards.
    expect((await call('POST', '/v1/control/password',
      JSON.stringify({ which: 'admin', newPassword: 'another-one-99' }))).status).toBe(403);

    const res = await call('POST', '/v1/control/command',
      JSON.stringify({ action: 'updatefw' }), 'admin-password-1');
    expect(res.status).toBe(201);
    expect(state.queue[0]!.action).toBe('updatefw');
  });
});

describe('changing the ui password', () => {
  it('replaces the default and stops accepting it', async () => {
    expect((await call('POST', '/v1/control/password',
      JSON.stringify({ which: 'ui', newPassword: 'my-new-password' }))).status).toBe(200);

    expect((await call('GET', '/v1/control', '', DEFAULT_UI_PASSWORD)).status).toBe(401);
    const body = (await (await call('GET', '/v1/control', '', 'my-new-password')).json()) as
      { usingDefaultUiPassword: boolean };
    expect(body.usingDefaultUiPassword).toBe(false);
  });

  it('refuses to set it back to the shipped default', async () => {
    // Accepting would clear the page's warning while leaving the exposure
    // exactly as it was -- the worst of both.
    const res = await call('POST', '/v1/control/password',
      JSON.stringify({ which: 'ui', newPassword: DEFAULT_UI_PASSWORD }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('shipped default');
  });

  it('refuses a short password', async () => {
    expect((await call('POST', '/v1/control/password',
      JSON.stringify({ which: 'ui', newPassword: 'short' }))).status).toBe(400);
  });
});

describe('redactStatus', () => {
  it('drops the wall\'s network settings from what it reports', () => {
    // The device redacts the Wi-Fi PASSWORD; the SSID is the name of the
    // reader's home network and has no business on an internet-facing page.
    const status = {
      fwVersion: 'x',
      settings: { network: { wifiSsid: 'chaim354', wifiPasswordSet: true }, display: { brightness: 5 } },
    };
    expect(redactStatus(status)).toEqual({ fwVersion: 'x', settings: { display: { brightness: 5 } } });
  });

  it('leaves a status without settings alone', () => {
    expect(redactStatus({ fwVersion: 'x' })).toEqual({ fwVersion: 'x' });
    expect(redactStatus({ fwVersion: 'x', settings: { display: {} } }))
      .toEqual({ fwVersion: 'x', settings: { display: {} } });
  });
});

describe('what each tier may READ', () => {
  const settings = {
    display: { brightness: 5, fetchIntervalSeconds: 60 },
    api: { openSkyClientId: 'someone@example.com-api-client', positionSource: 'server', serverUrl: 'https://x' },
    filters: { hideCargo: true },
    hardware: { panelResX: 64 },
    light: { enabled: true, darkThreshold: 900, pin: 4, hysteresis: 80 },
  };

  it('hides from the ui tier exactly what the ui tier may not set', () => {
    // light survives with its everyday keys and loses only the wiring, so the
    // on/off switch and the threshold still populate on the main page.
    expect(redactSettingsForTier(settings, 'ui')).toEqual({
      display: { brightness: 5 },
      api: {},
      filters: { hideCargo: true },
      light: { enabled: true, darkThreshold: 900 },
    });
  });

  it('shows the admin tier everything', () => {
    expect(redactSettingsForTier(settings, 'admin')).toEqual(settings);
  });

  it('redacts on the wire, not just in the helper', async () => {
    // The OpenSky client id is the account holder's email address, and the ui
    // password ships with a public default -- so anything the ui tier can read
    // is effectively public until somebody changes it.
    await call('POST', '/v1/control/checkin', JSON.stringify({ settings }), DEVICE);

    const asUi = (await (await call('GET', '/v1/control')).json()) as { status: { settings: Record<string, unknown> } };
    expect(JSON.stringify(asUi.status.settings)).not.toContain('example.com');
    expect(asUi.status.settings.hardware).toBeUndefined();
    // ...but the ui tier still gets what it is allowed to tune.
    expect(asUi.status.settings.light).toEqual({ enabled: true, darkThreshold: 900 });

    await call('POST', '/v1/control/password', JSON.stringify({ which: 'admin', newPassword: 'admin-password-1' }));
    const asAdmin = (await (await call('GET', '/v1/control', '', 'admin-password-1')).json()) as
      { status: { settings: Record<string, unknown> } };
    expect(JSON.stringify(asAdmin.status.settings)).toContain('example.com');
    expect(asAdmin.status.settings.hardware).toEqual({ panelResX: 64 });
  });
});

describe('checkin and queueing', () => {
  it('never writes the network section to the state file', async () => {
    // On arrival, not on display: a leak that exists only on disk is a leak.
    await call('POST', '/v1/control/checkin',
      JSON.stringify({ settings: { network: { wifiSsid: 'chaim354' }, display: { brightness: 1 } } }), DEVICE);
    expect(JSON.stringify(state.status)).not.toContain('chaim354');
    expect(JSON.stringify(state.status)).not.toContain('network');
  });

  it('drains the queue on check-in and records the status', async () => {
    await call('POST', '/v1/control/command', JSON.stringify({ set: { display: { brightness: 3 } } }));
    const res = await call('POST', '/v1/control/checkin', JSON.stringify({ fwVersion: 'x' }), DEVICE);
    const body = (await res.json()) as { commands: unknown[] };
    expect(body.commands).toHaveLength(1);
    expect(state.queue).toEqual([]);
    expect(state.statusAtMs).toBe(NOW);
  });

  it('reports the status age, null before any check-in', async () => {
    const before = (await (await call('GET', '/v1/control')).json()) as { statusAgeMs: unknown };
    expect(before.statusAgeMs).toBeNull();
    await call('POST', '/v1/control/checkin', '{"a":1}', DEVICE);
    const after = (await (await call('GET', '/v1/control', '', DEFAULT_UI_PASSWORD, NOW + 5000)).json()) as
      { statusAgeMs: number };
    expect(after.statusAgeMs).toBe(5000);
  });

  it('caps the queue', async () => {
    for (let i = 0; i < MAX_QUEUE; i++) {
      await call('POST', '/v1/control/command', JSON.stringify({ set: { display: { brightness: i } } }));
    }
    expect((await call('POST', '/v1/control/command',
      JSON.stringify({ set: { display: { brightness: 1 } } }))).status).toBe(429);
  });

  it('marks every response no-store', async () => {
    for (const res of [
      await call('GET', '/v1/control'),
      await call('POST', '/v1/control/checkin', '{}', DEVICE),
      await call('GET', '/v1/control', '', 'wrong'),
    ]) {
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });
});
