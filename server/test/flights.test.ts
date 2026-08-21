import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/adsblol', () => ({
  fetchAircraft: vi.fn(),
}));

import { handleFlights, MAX_FLIGHTS_CEILING, type Env } from '../src/flights';
import { fetchAircraft } from '../src/adsblol';
import { KV_KEY, indexRows, STALE_AFTER_MS, kvStorage } from '../src/schedule/store';
import type { Aircraft, ScheduleRow } from '../src/types';

// A minimal in-memory stand-in for the Workers KVNamespace binding. Only
// `get`/`put` are implemented -- the only two methods anything under test
// calls -- and `get` only supports the `'json'` string-literal type argument,
// because that is the only overload loadSchedule ever invokes. No Miniflare,
// no real network: fetchAircraft is mocked below and this class is the only
// thing standing in for env.SCHEDULE.
class FakeKV {
  private store = new Map<string, string>();

  async get(key: string, type?: string): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return type === 'json' ? JSON.parse(raw) : raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

// FakeKV's get/put match the KVNamespace shape kvStorage expects, so
// wrapping it here exercises the real Task 1 adapter -- these 25 tests are
// also kvStorage's regression coverage, proving it behaves identically to
// the raw-KV-in-Env code this replaced.
function mkEnv(kv: FakeKV): Env {
  return { SCHEDULE: kvStorage(kv as unknown as KVNamespace), BOARDS: 'KJFK,KLGA,KEWR,KBOS', AERODATABOX_KEY: 'unused-in-these-tests' };
}

async function seedSchedule(kv: FakeKV, rows: ScheduleRow[], builtAtMs: number): Promise<void> {
  await kv.put(KV_KEY, JSON.stringify({ builtAtMs, index: indexRows(rows) }));
}

const BASE_URL = 'https://worker.example/v1/flights';
function mkUrl(params: Record<string, string>): URL {
  const u = new URL(BASE_URL);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
}

// Center point roughly over NYC, matching the corridor geometry already
// proven to match CVG->LGA in enrich.test.ts and join.test.ts.
const LAT = '40.75';
const LON = '-73.9';

// Distinct from the query center: enrich() uses distanceNm/bearingDeg
// straight off the aircraft when the feed supplies them (adsb.lol always
// does), so most tests below set distanceNm directly and never need real
// geometry between this position and the query center.
const ac = (over: Partial<Aircraft> = {}): Aircraft => ({
  hex: 'a19357', callsign: 'EDV5075', registration: 'N914XJ', typeIcao: 'CRJ9',
  lat: 41.5, lon: -74.5, altFt: 18000, groundspeedKt: 400, trackDeg: 120,
  verticalRateFpm: -1200, onGround: false, category: 'A3',
  distanceNm: 20, bearingDeg: 210, ...over,
});

beforeEach(() => {
  vi.mocked(fetchAircraft).mockReset();
});

describe('handleFlights: happy path', () => {
  it('returns ok:true with flights sorted ascending by dst, capped at max', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([
      ac({ hex: 'a1', callsign: 'AAA111', distanceNm: 50 }),
      ac({ hex: 'a2', callsign: 'BBB222', distanceNm: 5 }),
      ac({ hex: 'a3', callsign: 'CCC333', distanceNm: 20 }),
    ]);
    const nowMs = 1_700_000_000_123;
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON, max: '2' }), mkEnv(new FakeKV()), nowMs);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ts: number; flights: { dst: number }[] };
    expect(body.ok).toBe(true);
    expect(body.ts).toBe(1_700_000_000); // nowMs floored to whole seconds
    // Capped at max=2 even though 3 aircraft came back, and it's the nearest
    // two -- not just the first two in feed order (BBB222 at 5, CCC333 at 20;
    // AAA111 at 50 is dropped).
    expect(body.flights).toHaveLength(2);
    expect(body.flights.map((f) => f.dst)).toEqual([5, 20]);
  });

  it('returns ok:true with an empty list when the fetch succeeds but finds no aircraft', async () => {
    // Contrast case for the load-bearing test below: the SAME empty
    // flights:[] shape must mean two different things depending on ok, and
    // this is the "genuinely nothing nearby" half of that contrast.
    vi.mocked(fetchAircraft).mockResolvedValue([]);
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON }), mkEnv(new FakeKV()), Date.now());
    const body = (await res.json()) as { ok: boolean; flights: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.flights).toEqual([]);
  });

  it('converts radius_km to nautical miles before calling the position source', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([]);
    await handleFlights(mkUrl({ lat: LAT, lon: LON, radius_km: '185.2' }), mkEnv(new FakeKV()), Date.now());
    // 185.2 / 1.852 km-per-nm == 100, modulo float error, so match args
    // individually with toBeCloseTo rather than toHaveBeenCalledWith.
    const call = vi.mocked(fetchAircraft).mock.calls[0]!;
    expect(call[0]).toBe(40.75);
    expect(call[1]).toBe(-73.9);
    expect(call[2]).toBeCloseTo(100, 9);
  });
});

describe('handleFlights: exclude_ground and altitude band filter', () => {
  it('exclude_ground=1 removes on-ground aircraft', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([
      ac({ hex: 'a1', callsign: 'GRND01', onGround: true, distanceNm: 5 }),
      ac({ hex: 'a2', callsign: 'AIR001', onGround: false, distanceNm: 10 }),
    ]);
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON, exclude_ground: '1' }), mkEnv(new FakeKV()), Date.now());
    const body = (await res.json()) as { flights: { cs: string }[] };
    expect(body.flights.map((f) => f.cs)).toEqual(['AIR001']);
  });

  it('leaves on-ground aircraft in when exclude_ground is absent', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([ac({ hex: 'a1', callsign: 'GRND01', onGround: true, distanceNm: 5 })]);
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON }), mkEnv(new FakeKV()), Date.now());
    const body = (await res.json()) as { flights: { cs: string }[] };
    expect(body.flights.map((f) => f.cs)).toEqual(['GRND01']);
  });

  it('min_alt_ft/max_alt_ft band-filters by altitude', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([
      ac({ hex: 'a1', callsign: 'LOW0001', altFt: 5000, distanceNm: 1 }),
      ac({ hex: 'a2', callsign: 'MID0001', altFt: 15000, distanceNm: 2 }),
      ac({ hex: 'a3', callsign: 'HI00001', altFt: 25000, distanceNm: 3 }),
    ]);
    const res = await handleFlights(
      mkUrl({ lat: LAT, lon: LON, min_alt_ft: '10000', max_alt_ft: '20000' }),
      mkEnv(new FakeKV()),
      Date.now(),
    );
    const body = (await res.json()) as { flights: { cs: string }[] };
    expect(body.flights.map((f) => f.cs)).toEqual(['MID0001']);
  });

  it('does not filter by altitude at all when min_alt_ft/max_alt_ft are both omitted', async () => {
    // Regression test for a defect found while writing this suite:
    // Number(null) is 0, which IS finite, so a naive `Number(q.get('max_alt_ft'))`
    // turns an OMITTED max_alt_ft into an always-on "reject anything above 0 ft"
    // filter -- silently emptying every ordinary request's flight list, since
    // max_alt_ft is documented as an optional filter and the common case omits
    // it entirely. This is what the other tests in this block incidentally
    // guard against too (none of them pass min_alt_ft/max_alt_ft), but this
    // test names the failure mode directly: a normal cruising aircraft, with
    // no altitude band requested at all, must survive.
    vi.mocked(fetchAircraft).mockResolvedValue([ac({ hex: 'a1', callsign: 'CRUISE1', altFt: 18000, distanceNm: 1 })]);
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON }), mkEnv(new FakeKV()), Date.now());
    const body = (await res.json()) as { flights: { cs: string }[] };
    expect(body.flights.map((f) => f.cs)).toEqual(['CRUISE1']);
  });

  it('does not drop an aircraft with unknown altitude from the band filter', async () => {
    // An unknown altitude is not evidence the aircraft is outside the band --
    // it is evidence we don't know. Filtering it out would be a false
    // rejection, and the firmware's own equivalent filter treats it the same
    // way: unknown never counts against a flight.
    vi.mocked(fetchAircraft).mockResolvedValue([ac({ hex: 'a1', callsign: 'NOALT01', altFt: null, distanceNm: 1 })]);
    const res = await handleFlights(
      mkUrl({ lat: LAT, lon: LON, min_alt_ft: '10000', max_alt_ft: '20000' }),
      mkEnv(new FakeKV()),
      Date.now(),
    );
    const body = (await res.json()) as { flights: { cs: string }[] };
    expect(body.flights.map((f) => f.cs)).toEqual(['NOALT01']);
  });
});

describe('handleFlights: lat/lon validation', () => {
  it('rejects a missing lat with 400 and ok:false', async () => {
    const res = await handleFlights(mkUrl({ lon: LON }), mkEnv(new FakeKV()), Date.now());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('rejects a missing lon with 400 and ok:false', async () => {
    const res = await handleFlights(mkUrl({ lat: LAT }), mkEnv(new FakeKV()), Date.now());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('rejects a blank lat the same way as a missing one', async () => {
    // Number('') is 0, same trap as Number(null) for an absent param: a
    // present-but-empty ?lat= must not silently become the equator.
    const res = await handleFlights(mkUrl({ lat: '', lon: LON }), mkEnv(new FakeKV()), Date.now());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('rejects a non-numeric lat with 400 and ok:false', async () => {
    const res = await handleFlights(mkUrl({ lat: 'abc', lon: LON }), mkEnv(new FakeKV()), Date.now());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('rejects a non-numeric lon with 400 and ok:false', async () => {
    const res = await handleFlights(mkUrl({ lat: LAT, lon: 'xyz' }), mkEnv(new FakeKV()), Date.now());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('rejects an out-of-range lat', async () => {
    const res = await handleFlights(mkUrl({ lat: '91', lon: LON }), mkEnv(new FakeKV()), Date.now());
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range lon', async () => {
    const res = await handleFlights(mkUrl({ lat: LAT, lon: '181' }), mkEnv(new FakeKV()), Date.now());
    expect(res.status).toBe(400);
  });

  it('accepts the boundary values 90 and 180', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([]);
    const res = await handleFlights(mkUrl({ lat: '90', lon: '180' }), mkEnv(new FakeKV()), Date.now());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe('handleFlights: max clamping', () => {
  it('clamps max to MAX_FLIGHTS_CEILING even when the caller asks for far more', async () => {
    const many = Array.from({ length: MAX_FLIGHTS_CEILING + 10 }, (_, i) =>
      ac({ hex: `a${i}`, callsign: `FL${String(i).padStart(4, '0')}`, distanceNm: i + 1 }),
    );
    vi.mocked(fetchAircraft).mockResolvedValue(many);
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON, max: '9999' }), mkEnv(new FakeKV()), Date.now());
    const body = (await res.json()) as { flights: unknown[] };
    expect(body.flights).toHaveLength(MAX_FLIGHTS_CEILING);
  });

  it('treats max=0 as not-specified and falls back to the default of 8', async () => {
    // Documented actual behavior, not an assumption: `Math.trunc(Number('0')) || 8`
    // is 8, because 0 is falsy in JS. The same `X || default` idiom is used for
    // radius_km just above it, so this is a consistent (if easy-to-miss) house
    // pattern, not a one-off. clamp()'s own floor is 1, so even without the
    // `|| 8` short-circuit max=0 could never mean "return zero flights."
    const many = Array.from({ length: 10 }, (_, i) => ac({ hex: `a${i}`, callsign: `FL${i}`, distanceNm: i + 1 }));
    vi.mocked(fetchAircraft).mockResolvedValue(many);
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON, max: '0' }), mkEnv(new FakeKV()), Date.now());
    const body = (await res.json()) as { flights: unknown[] };
    expect(body.flights).toHaveLength(8);
  });

  it('clamps a negative max up to 1 rather than erroring', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([
      ac({ hex: 'a1', callsign: 'ONE0001', distanceNm: 5 }),
      ac({ hex: 'a2', callsign: 'TWO0002', distanceNm: 15 }),
    ]);
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON, max: '-5' }), mkEnv(new FakeKV()), Date.now());
    const body = (await res.json()) as { ok: boolean; flights: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.flights).toHaveLength(1);
  });

  it('treats a non-numeric max the same as not-specified', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ac({ hex: `a${i}`, callsign: `FL${i}`, distanceNm: i + 1 }));
    vi.mocked(fetchAircraft).mockResolvedValue(many);
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON, max: 'banana' }), mkEnv(new FakeKV()), Date.now());
    const body = (await res.json()) as { flights: unknown[] };
    expect(body.flights).toHaveLength(8);
  });
});

describe('handleFlights: position-source failure', () => {
  it('returns ok:false, not an empty success, when the position source fails', async () => {
    // The single most consequential line in this file. The ESP32's
    // doFetchAndRender keeps its previous flights when ok:false, and blanks
    // the display only after six stale intervals. ok:true with flights:[]
    // reads as "confirmed empty sky" and wipes the wall immediately on the
    // very first transient adsb.lol failure. The two must never be
    // conflated, so this asserts both halves of the distinction explicitly.
    vi.mocked(fetchAircraft).mockRejectedValue(new Error('adsb.lol 503'));
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON }), mkEnv(new FakeKV()), Date.now());
    const body = (await res.json()) as { ok: boolean; flights: unknown[] };
    expect(body.ok).toBe(false);
    expect(body.flights).toEqual([]);
    expect(body).not.toEqual(expect.objectContaining({ ok: true }));
  });

  it('still reports stale correctly on a position-source failure', async () => {
    vi.mocked(fetchAircraft).mockRejectedValue(new Error('network down'));
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON }), mkEnv(new FakeKV()), Date.now());
    const body = (await res.json()) as { ok: boolean; stale: boolean };
    expect(body.ok).toBe(false);
    expect(body.stale).toBe(true); // no schedule was ever stored, so it reads stale
  });
});

describe('handleFlights: schedule staleness', () => {
  it('sets stale:true when the schedule table is old, but still returns flights with routes', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([ac({ hex: 'a1', callsign: 'EDV5075', distanceNm: 10 })]);
    const kv = new FakeKV();
    const now = Date.now();
    const oldSchedule: ScheduleRow[] = [{
      callsign: null, carrierIata: 'DL', number: '5075',
      origIata: 'CVG', destIata: 'LGA',
      origLat: 39.0488, origLon: -84.6678, destLat: 40.7769, destLon: -73.8740,
      schedArrEpoch: null, revArrEpoch: null,
    }];
    await seedSchedule(kv, oldSchedule, now - STALE_AFTER_MS - 1000);
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON }), mkEnv(kv), now);
    const body = (await res.json()) as { ok: boolean; stale: boolean; flights: { to: string | null }[] };
    expect(body.ok).toBe(true);
    expect(body.stale).toBe(true);
    expect(body.flights).toHaveLength(1);
    // An aging table is still USED, just flagged -- staleness does not
    // suppress the route it can still correctly supply.
    expect(body.flights[0]!.to).toBe('LGA');
  });

  it('does not flag a fresh schedule table as stale', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([ac({ hex: 'a1', callsign: 'EDV5075', distanceNm: 10 })]);
    const kv = new FakeKV();
    const now = Date.now();
    await seedSchedule(kv, [{
      callsign: null, carrierIata: 'DL', number: '5075',
      origIata: 'CVG', destIata: 'LGA',
      origLat: 39.0488, origLon: -84.6678, destLat: 40.7769, destLon: -73.8740,
      schedArrEpoch: null, revArrEpoch: null,
    }], now);
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON }), mkEnv(kv), now);
    const body = (await res.json()) as { stale: boolean };
    expect(body.stale).toBe(false);
  });

  it('degrades to stale:true rather than failing the request when the KV read throws', async () => {
    // loadSchedule's own .catch(() => null) inside handleFlights must
    // absorb this -- a KV outage should read exactly like "no table has
    // ever been written," not like a request failure.
    vi.mocked(fetchAircraft).mockResolvedValue([ac({ hex: 'a1', callsign: 'TEST1', distanceNm: 10 })]);
    const throwingKv = {
      get: vi.fn().mockRejectedValue(new Error('KV unavailable')),
      put: vi.fn(),
    } as unknown as KVNamespace;
    const res = await handleFlights(
      mkUrl({ lat: LAT, lon: LON }),
      { SCHEDULE: kvStorage(throwingKv), BOARDS: 'KJFK', AERODATABOX_KEY: 'x' },
      Date.now(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; stale: boolean; flights: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.stale).toBe(true);
    expect(body.flights).toHaveLength(1); // the aircraft still renders, just with no route
  });
});

describe('handleFlights: schedule-time ETA end to end', () => {
  // enrich.test.ts covers the priority chain itself in isolation; this
  // covers the one line that actually wires handleFlights' own `nowMs`
  // parameter into enrich() (src/flights.ts's `enrich(a, rows, opts,
  // nowMs)` call) -- a real regression risk on its own (e.g. the wrong
  // variable, or the argument silently dropped) that no purely
  // enrich()-level test can catch, since those tests supply their own
  // nowMs directly.
  it('serves a schedule-derived ETA, sourced from the request\'s own clock, through the real HTTP path', async () => {
    vi.mocked(fetchAircraft).mockResolvedValue([ac({ hex: 'a1', callsign: 'EDV5075', distanceNm: 10 })]);
    const kv = new FakeKV();
    const now = Date.now();
    const schedArrEpoch = Math.floor(now / 1000) + 45 * 60; // 45 minutes from `now`
    await seedSchedule(kv, [{
      callsign: null, carrierIata: 'DL', number: '5075',
      origIata: 'CVG', destIata: 'LGA',
      origLat: 39.0488, origLon: -84.6678, destLat: 40.7769, destLon: -73.8740,
      schedArrEpoch, revArrEpoch: null,
    }], now);
    const res = await handleFlights(mkUrl({ lat: LAT, lon: LON }), mkEnv(kv), now);
    const body = (await res.json()) as {
      flights: { to: string | null; eta_min: number | null; eta_text: string | null; eta_src: string | null }[];
    };
    expect(body.flights).toHaveLength(1);
    expect(body.flights[0]!.to).toBe('LGA');
    expect(body.flights[0]!.eta_src).toBe('scheduled');
    expect(body.flights[0]!.eta_min).toBe(45);
    expect(body.flights[0]!.eta_text).toBe('~45m');
  });
});
