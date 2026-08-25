import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleControl,
  authorised,
  stripProtected,
  MAX_QUEUE,
  type ControlState,
  type ControlStorage,
} from '../src/control';

const TOKEN = 'a-shared-secret';
const AUTH = `Bearer ${TOKEN}`;
const NOW = 1_700_000_000_000;

let state: ControlState;
let store: ControlStorage;

beforeEach(() => {
  state = { status: null, statusAtMs: null, queue: [] };
  store = {
    read: async () => state,
    write: async (s) => { state = s; },
  };
});

const call = (method: string, path: string, body = '', auth: string | null = AUTH, now = NOW) =>
  handleControl(method, new URL(`http://x${path}`), body, auth, store, TOKEN, now);

describe('authorised', () => {
  it('accepts the exact bearer token and nothing else', () => {
    expect(authorised(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(authorised(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(authorised(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
    expect(authorised(TOKEN, TOKEN)).toBe(false);        // no scheme
    expect(authorised('Basic abc', TOKEN)).toBe(false);
    expect(authorised(null, TOKEN)).toBe(false);
    expect(authorised(undefined, TOKEN)).toBe(false);
  });

  it('refuses everything when no token is configured', () => {
    // Absent configuration must not mean "any request is fine" -- the empty
    // string would otherwise match an empty bearer.
    expect(authorised('Bearer ', '')).toBe(false);
    expect(authorised('Bearer x', '')).toBe(false);
  });
});

describe('stripProtected', () => {
  it('removes network and keeps everything else', () => {
    const out = stripProtected({
      network: { wifiSsid: 'evil', wifiPassword: 'x' },
      display: { brightness: 5 },
      filters: { hideCargo: true },
    });
    expect(out).toEqual({ display: { brightness: 5 }, filters: { hideCargo: true } });
    expect(out).not.toHaveProperty('network');
  });
});

describe('handleControl: auth', () => {
  it('401s every route without a valid token', async () => {
    for (const [m, p] of [['GET', '/v1/control'], ['POST', '/v1/control/checkin'], ['POST', '/v1/control/command']]) {
      const res = await call(m!, p!, '{}', 'Bearer wrong');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('does not touch storage on an unauthorised call', async () => {
    await call('POST', '/v1/control/checkin', '{"fw":"x"}', null);
    expect(state.status).toBeNull();
  });
});

describe('handleControl: checkin', () => {
  it('stores the reported status and returns queued commands, draining them', async () => {
    await call('POST', '/v1/control/command', JSON.stringify({ action: 'restart' }));
    expect(state.queue).toHaveLength(1);

    const res = await call('POST', '/v1/control/checkin', JSON.stringify({ fwVersion: '0d68283', flights: 9 }));
    const body = (await res.json()) as { ok: boolean; commands: { action: string }[] };
    expect(body.ok).toBe(true);
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]!.action).toBe('restart');

    expect(state.status).toEqual({ fwVersion: '0d68283', flights: 9 });
    expect(state.statusAtMs).toBe(NOW);
    // AT-MOST-ONCE: collecting drains. A command that repeated after a reboot
    // mid-apply would be worse than one a human re-queues.
    expect(state.queue).toEqual([]);

    const second = (await (await call('POST', '/v1/control/checkin', '{}')).json()) as { commands: unknown[] };
    expect(second.commands).toEqual([]);
  });

  it('rejects a non-JSON body without clobbering the last good status', async () => {
    await call('POST', '/v1/control/checkin', JSON.stringify({ fwVersion: 'good' }));
    const res = await call('POST', '/v1/control/checkin', 'not json');
    expect(res.status).toBe(400);
    expect(state.status).toEqual({ fwVersion: 'good' });
  });
});

describe('handleControl: reading state', () => {
  it('reports the status as an AGE, not a timestamp', async () => {
    await call('POST', '/v1/control/checkin', JSON.stringify({ fwVersion: 'x' }));
    const res = await call('GET', '/v1/control', '', AUTH, NOW + 90_000);
    const body = (await res.json()) as { status: unknown; statusAgeMs: number; pending: unknown[] };
    expect(body.status).toEqual({ fwVersion: 'x' });
    expect(body.statusAgeMs).toBe(90_000);
    expect(body.pending).toEqual([]);
  });

  it('reports a null age before the device has ever checked in', async () => {
    // Not zero: "never reported" and "reported just now" must not look alike on
    // a page whose whole job is saying what the wall is doing.
    const body = (await (await call('GET', '/v1/control')).json()) as { status: unknown; statusAgeMs: unknown };
    expect(body.status).toBeNull();
    expect(body.statusAgeMs).toBeNull();
  });
});

describe('handleControl: queueing commands', () => {
  it('queues a known action', async () => {
    const res = await call('POST', '/v1/control/command', JSON.stringify({ action: 'updatefw' }));
    expect(res.status).toBe(201);
    expect(state.queue[0]!.action).toBe('updatefw');
  });

  it('refuses an unknown action rather than passing it to the device', async () => {
    const res = await call('POST', '/v1/control/command', JSON.stringify({ action: 'selfdestruct' }));
    expect(res.status).toBe(400);
    expect(state.queue).toEqual([]);
  });

  it('strips network from a settings command', async () => {
    const res = await call('POST', '/v1/control/command', JSON.stringify({
      set: { network: { wifiSsid: 'evil' }, display: { brightness: 3 } },
    }));
    expect(res.status).toBe(201);
    expect(state.queue[0]!.set).toEqual({ display: { brightness: 3 } });
  });

  it('refuses a command that was ONLY network, rather than queueing a no-op', async () => {
    // Silently queueing an empty command would report success for a change that
    // can never happen -- the worst outcome for the one setting deliberately
    // excluded.
    const res = await call('POST', '/v1/control/command', JSON.stringify({
      set: { network: { wifiSsid: 'evil', wifiPassword: 'x' } },
    }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('network settings cannot be set remotely');
    expect(state.queue).toEqual([]);
  });

  it('refuses shapes that are neither', async () => {
    for (const body of ['{}', '{"set":[]}', '{"set":"x"}', 'nope']) {
      const res = await call('POST', '/v1/control/command', body);
      expect(res.status).toBe(400);
    }
    expect(state.queue).toEqual([]);
  });

  it('caps the queue', async () => {
    for (let i = 0; i < MAX_QUEUE; i++) {
      expect((await call('POST', '/v1/control/command', JSON.stringify({ action: 'restart' }))).status).toBe(201);
    }
    const res = await call('POST', '/v1/control/command', JSON.stringify({ action: 'restart' }));
    expect(res.status).toBe(429);
    expect(state.queue).toHaveLength(MAX_QUEUE);
  });
});
