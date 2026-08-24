import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseStates, fetchPosition } from '../../src/tracked/opensky';

// OpenSky returns positional arrays, not objects. Indices, per its docs:
// 0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
// 5 longitude, 6 latitude, 7 baro_altitude, 8 on_ground, 9 velocity,
// 10 true_track, 11 vertical_rate.
const state = (over: Partial<Record<number, unknown>> = {}): unknown[] => {
  const s: unknown[] = ['4008f3', 'BAW181 ', 'United Kingdom', 1787000000, 1787000000,
    -30.5, 52.1, 11277.6, false, 250.3, 62.1, 0];
  for (const [i, v] of Object.entries(over)) s[Number(i)] = v;
  return s;
};

describe('parseStates', () => {
  it('extracts position, altitude, track and on-ground', () => {
    const p = parseStates({ states: [state()] });
    expect(p).not.toBeNull();
    expect(p!.lat).toBeCloseTo(52.1, 4);
    expect(p!.lon).toBeCloseTo(-30.5, 4);
    expect(p!.onGround).toBe(false);
    expect(p!.headingDeg).toBeCloseTo(62.1, 1);
  });

  it('returns null when states is null or empty (aircraft not seen)', () => {
    // OpenSky returns states:null for an aircraft nobody is receiving. That is
    // the ocean-gap case, and it must be distinguishable from an error so the
    // caller dead-reckons instead of dropping the card.
    expect(parseStates({ states: null })).toBeNull();
    expect(parseStates({ states: [] })).toBeNull();
    expect(parseStates({})).toBeNull();
  });

  it('returns null when lat/lon are null but the aircraft is listed', () => {
    // A state vector with no position happens; treating null as 0 would put
    // the aircraft in the Gulf of Guinea.
    expect(parseStates({ states: [state({ 5: null, 6: null })] })).toBeNull();
  });

  it('reports on-ground when the flag is set', () => {
    expect(parseStates({ states: [state({ 8: true })] })!.onGround).toBe(true);
  });
});

describe('fetchPosition', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('queries by icao24 and returns a position', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ states: [state()] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchPosition('4008f3', 'id', 'secret');
    expect(r.ok).toBe(true);
    // `expect(r.ok).toBe(true)` doesn't narrow `r` for the type checker --
    // only a real `if` does -- so an explicit guard is needed before `r.position`
    // is accessible under this repo's strict tsconfig.
    if (!r.ok) throw new Error('unreachable: r.ok was asserted true above');
    expect(r.position!.lat).toBeCloseTo(52.1, 4);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('icao24=4008f3');
  });

  it('distinguishes "seen but no position" from "request failed"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"states":null}', { status: 200 })));
    const r = await fetchPosition('4008f3', 'id', 'secret');
    expect(r).toEqual({ ok: true, position: null });
  });

  it('reports an HTTP failure as not-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    const r = await fetchPosition('4008f3', 'id', 'secret');
    expect(r.ok).toBe(false);
  });

  it('reports a thrown fetch as not-ok rather than propagating', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')));
    const r = await fetchPosition('4008f3', 'id', 'secret');
    expect(r.ok).toBe(false);
  });
});
