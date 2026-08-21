import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stub the network entirely -- this suite must never reach adsb.lol or
// AeroDataBox for real, the same discipline test/flights.test.ts uses.
vi.mock('../src/adsblol', () => ({ fetchAircraft: vi.fn() }));
vi.mock('../src/schedule/aerodatabox', () => ({ fetchBoard: vi.fn() }));

import { fetchAircraft } from '../src/adsblol';
import { fetchBoard } from '../src/schedule/aerodatabox';
import { startServer, configFromEnv, type RunningServer } from '../src/server';

let dir: string;
let running: RunningServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flightwall-server-'));
  vi.mocked(fetchAircraft).mockReset().mockResolvedValue([]);
  vi.mocked(fetchBoard).mockReset().mockResolvedValue([]);
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('configFromEnv', () => {
  it('applies sensible defaults for everything except the API key', () => {
    const cfg = configFromEnv({} as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(8787);
    expect(cfg.aerodataboxKey).toBe(''); // no default -- there isn't a sensible one
    expect(cfg.boards).toBe('KJFK,KLGA,KEWR,KBOS');
    expect(cfg.schedulePath).toBe('./data/schedule.json');
    expect(cfg.refreshIntervalMs).toBe(6 * 60 * 60 * 1000);
    expect(cfg.boardFetchDelayMs).toBe(1500);
    // The Port Authority merge runs on its own, much shorter period -- it is
    // free, and the short cadence is the whole point of having it.
    expect(cfg.panynjIntervalMs).toBe(10 * 60 * 1000);
    expect(cfg.panynjPageDelayMs).toBe(2000);
  });

  it('reads every var when all are set', () => {
    const cfg = configFromEnv({
      PORT: '1234',
      AERODATABOX_KEY: 'k',
      BOARDS: 'KBOS',
      SCHEDULE_PATH: '/tmp/x.json',
    } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ port: 1234, aerodataboxKey: 'k', boards: 'KBOS', schedulePath: '/tmp/x.json' });
  });

  it('falls back to the default port on a non-numeric PORT rather than binding NaN', () => {
    const cfg = configFromEnv({ PORT: 'banana' } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(8787);
  });
});

describe('startServer', () => {
  it('serves /up and /v1/flights, 404s everything else, and shuts down cleanly', async () => {
    running = await startServer({
      port: 0, // ephemeral
      aerodataboxKey: '', // missing key -- must still serve (per spec)
      boards: 'KJFK',
      schedulePath: join(dir, 'schedule.json'),
      panynjIntervalMs: 0, // no network from tests
      panynjPageDelayMs: 0,
      refreshIntervalMs: 24 * 60 * 60 * 1000,
      boardFetchDelayMs: 0, // pacing itself is covered by test/refresh.test.ts
    });
    const base = `http://127.0.0.1:${running.port}`;

    const up = await fetch(`${base}/up`);
    expect(up.status).toBe(200);

    const flights = await fetch(`${base}/v1/flights?lat=40.7&lon=-73.9`);
    expect(flights.status).toBe(200);
    const body = (await flights.json()) as { ok: boolean; flights: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.flights).toEqual([]);
    expect(fetchAircraft).toHaveBeenCalled();

    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);

    // A missing key must short-circuit the refresh entirely, not silently
    // attempt (and presumably fail) a real board fetch.
    expect(fetchBoard).not.toHaveBeenCalled();
  });

  it('still answers /v1/flights (with no routes) when AERODATABOX_KEY is missing', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([
      { hex: 'a1', callsign: 'DL5075', registration: null, typeIcao: null, lat: 40.8, lon: -73.9,
        altFt: 18000, groundspeedKt: 400, trackDeg: 90, verticalRateFpm: 0, onGround: false,
        category: null, distanceNm: 5, bearingDeg: 90 },
    ]);
    running = await startServer({
      port: 0,
      aerodataboxKey: '',
      boards: 'KJFK',
      schedulePath: join(dir, 'schedule.json'),
      panynjIntervalMs: 0, // no network from tests
      panynjPageDelayMs: 0,
      refreshIntervalMs: 24 * 60 * 60 * 1000,
      boardFetchDelayMs: 0, // pacing itself is covered by test/refresh.test.ts
    });
    const res = await fetch(`http://127.0.0.1:${running.port}/v1/flights?lat=40.7&lon=-73.9`);
    const body = (await res.json()) as { ok: boolean; flights: { to: string | null }[] };
    expect(body.ok).toBe(true);
    expect(body.flights).toHaveLength(1);
    expect(body.flights[0]!.to).toBeNull(); // no schedule table -> no route, not a failure
  });

  it('refreshes the schedule once at boot when a key is configured, and paces board fetches', async () => {
    vi.mocked(fetchBoard).mockResolvedValue([]);
    running = await startServer({
      port: 0,
      aerodataboxKey: 'a-key',
      boards: 'KJFK,KLGA',
      schedulePath: join(dir, 'schedule.json'),
      panynjIntervalMs: 0, // no network from tests
      panynjPageDelayMs: 0,
      refreshIntervalMs: 24 * 60 * 60 * 1000,
      boardFetchDelayMs: 0, // pacing itself is covered by test/refresh.test.ts
    });
    // The boot refresh is fire-and-forget (does not block server start), so
    // give its microtasks a turn.
    await vi.waitFor(() => expect(fetchBoard).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(fetchBoard).toHaveBeenNthCalledWith(1, 'KJFK', 'a-key');
    expect(fetchBoard).toHaveBeenNthCalledWith(2, 'KLGA', 'a-key');
  });

  it('rejects instead of hanging when the port is already in use', async () => {
    running = await startServer({
      port: 0,
      aerodataboxKey: '',
      boards: 'KJFK',
      schedulePath: join(dir, 'schedule.json'),
      panynjIntervalMs: 0, // no network from tests
      panynjPageDelayMs: 0,
      refreshIntervalMs: 24 * 60 * 60 * 1000,
      boardFetchDelayMs: 0,
    });
    // A second server bound to the exact same (now-taken) port must fail
    // its startup promise -- regression guard for a real defect found in
    // self-review: the server's 'error' listener was a bare `.once` that
    // rejected an ALREADY-settled promise as a silent no-op for any error
    // after a successful bind, so a startup-time bind failure is the one
    // case that must still surface loudly through the returned promise.
    await expect(
      startServer({
        port: running.port,
        aerodataboxKey: '',
        boards: 'KJFK',
        schedulePath: join(dir, 'schedule2.json'),
        panynjIntervalMs: 0, // no network from tests
        panynjPageDelayMs: 0,
        refreshIntervalMs: 24 * 60 * 60 * 1000,
        boardFetchDelayMs: 0,
      }),
    ).rejects.toThrow();
  });
});
