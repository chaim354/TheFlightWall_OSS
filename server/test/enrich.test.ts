import { describe, it, expect } from 'vitest';
import { enrich } from '../src/enrich';
import type { Aircraft, ScheduleRow } from '../src/types';

const LGA = { lat: 40.7769, lon: -73.8740 };
const CVG = { lat: 39.0488, lon: -84.6678 };

const ac = (over: Partial<Aircraft> = {}): Aircraft => ({
  hex: 'a19357', callsign: 'EDV5075', registration: 'N914XJ', typeIcao: 'CRJ9',
  lat: 41.5, lon: -74.5, altFt: 18000, groundspeedKt: 400, trackDeg: 120,
  verticalRateFpm: -1200, onGround: false, category: 'A3',
  distanceNm: 60, bearingDeg: 210, ...over,
});

const sched: ScheduleRow[] = [{
  callsign: null, carrierIata: 'DL', number: '5075',
  origIata: 'CVG', destIata: 'LGA',
  origLat: CVG.lat, origLon: CVG.lon, destLat: LGA.lat, destLon: LGA.lon,
  schedArrEpoch: null,
}];

describe('enrich', () => {
  it('fills route, carrier name and ETA from the schedule', () => {
    const f = enrich(ac(), sched, { units: 'imperial' })!;
    expect(f.from).toBe('CVG');
    expect(f.to).toBe('LGA');
    expect(f.al).toBe('Delta');
    expect(f.flt).toBe('DL5075');
    expect(f.eta_min).toBeGreaterThan(0);
    expect(f.eta_text).toMatch(/^~/);
    expect(f.eta_src).toBe('physics');
  });

  it('still returns a flight when no schedule row matches', () => {
    // Route blank, but callsign, position and metrics must survive -- the card
    // still renders, it just has no route.
    const f = enrich(ac({ callsign: 'ZZZ9999' }), sched, { units: 'imperial' })!;
    expect(f.cs).toBe('ZZZ9999');
    expect(f.to).toBeNull();
    expect(f.eta_min).toBeNull();
    expect(f.eta_text).toBeNull();
    expect(f.alt).toBe(18000);
  });

  it('carries registration and type through from the position feed', () => {
    const f = enrich(ac(), sched, { units: 'imperial' })!;
    expect(f.reg).toBe('N914XJ');
    expect(f.ac).toBe('CRJ9');
  });

  it('falls back to the bare carrier code when the name is unknown', () => {
    // DEVIATION FROM THE PLAN: the plan's version of this test spreads
    // sched[0] (callsign: null) and only overrides carrierIata to 'ZZ'. With
    // the aircraft's default callsign EDV5075, that row is unreachable: EDV
    // is a known operator narrowed to carrier candidates ['DL'] in join.ts,
    // 'ZZ' isn't in that list, so matchSchedule's "known operator narrows to
    // zero -> null, never fall back to an unnarrowed collision" rule (the
    // fix from Task 4, join.test.ts "returns null when a known operator
    // narrows to zero...") rejects the row before enrich() ever calls
    // airlineName('ZZ'). Verified empirically: matchSchedule('EDV5075', ...,
    // [{callsign: null, carrierIata: 'ZZ', number: '5075', ...}]) returns
    // null, so the plan's literal fixture makes f.al null, not 'ZZ', and the
    // test as written would fail -- not because enrich.ts is wrong (blank on
    // no-match is exactly the intended behavior), but because the fixture
    // can never reach the airlineName-fallback line it means to exercise.
    // Fixed here by giving the row a matching operating callsign, which
    // takes join.ts's exact-match path -- the one path that skips carrier
    // narrowing entirely, same as a provider-supplied callsign would in
    // production.
    const rows = [{ ...sched[0]!, carrierIata: 'ZZ', callsign: 'EDV5075' }];
    expect(enrich(ac(), rows, { units: 'imperial' })!.al).toBe('ZZ');
  });

  it('computes distance and bearing when the feed did not supply them', () => {
    const f = enrich(ac({ distanceNm: null, bearingDeg: null }), sched,
      { units: 'imperial', centerLat: LGA.lat, centerLon: LGA.lon })!;
    expect(f.dst).toBeGreaterThan(0);
    expect(f.brg).toBeGreaterThanOrEqual(0);
  });

  it('emits metric units on request', () => {
    const imperial = enrich(ac(), sched, { units: 'imperial' })!;
    const metric = enrich(ac(), sched, { units: 'metric' })!;
    // 400 kt -> ~741 km/h (larger number); 18000 ft -> ~5486 m (smaller number).
    expect(metric.spd!).toBeGreaterThan(imperial.spd!);
    expect(metric.alt!).toBeLessThan(imperial.alt!);
  });

  it('drops an aircraft with no callsign', () => {
    expect(enrich(ac({ callsign: '' }), sched, { units: 'imperial' })).toBeNull();
  });
});

// Probed beyond the plan's own test list: schedule rows that match but lack
// destination coordinates, missing groundspeed both inside and outside the
// terminal segment, an aircraft already at its destination, and the exact
// (not just directional) unit-conversion factors, including one field --
// vertical rate -- the plan's own metric test never touches.
describe('enrich: edge cases', () => {
  it('shows the route without an ETA when the matched row has no destination coordinates', () => {
    // join.ts's exact-callsign path (unlike its number+geometry fallback)
    // does not itself require coordinates -- see join.ts's `exact` filter,
    // which checks only the callsign string. A row that matches by callsign
    // but is missing destLat/destLon must not throw, must not fabricate a
    // distance, and should still show the route text the schedule gave us.
    const rows: ScheduleRow[] = [{
      callsign: 'EDV5075', carrierIata: 'DL', number: '5075',
      origIata: 'CVG', destIata: 'LGA',
      origLat: CVG.lat, origLon: CVG.lon, destLat: null, destLon: null,
      schedArrEpoch: null,
    }];
    const f = enrich(ac(), rows, { units: 'imperial' })!;
    expect(f.from).toBe('CVG');
    expect(f.to).toBe('LGA');
    expect(f.eta_min).toBeNull();
    expect(f.eta_text).toBeNull();
    expect(f.eta_src).toBeNull();
  });

  it('returns a null ETA rather than a wrong one when groundspeed is missing beyond the terminal segment', () => {
    // Placed at CVG itself -- ~507nm from LGA, well past TERMINAL_NM (60) --
    // so the model needs groundspeed and does not have it.
    const f = enrich(ac({ lat: CVG.lat, lon: CVG.lon, groundspeedKt: null }), sched,
      { units: 'imperial' })!;
    expect(f.to).toBe('LGA'); // the row still matched -- only the ETA is unavailable
    expect(f.eta_min).toBeNull();
    expect(f.eta_text).toBeNull();
    expect(f.eta_src).toBeNull();
  });

  it('still computes an ETA with missing groundspeed inside the terminal segment', () => {
    // The default ac() position is ~52nm from LGA -- inside TERMINAL_NM (60)
    // -- where the model uses a nominal speed, not the aircraft's own. A
    // missing groundspeed this close to the airport must not blank the ETA.
    const f = enrich(ac({ groundspeedKt: null }), sched, { units: 'imperial' })!;
    expect(f.eta_min).not.toBeNull();
    expect(f.eta_text).toMatch(/^~|^LANDING$/);
  });

  it('applies the descent floor even at zero horizontal distance -- overhead the destination at cruise altitude is not landing', () => {
    // This test used to assert eta_min=0 / eta_text='LANDING' here, which
    // was itself an instance of the WJA2101 bug class at its most extreme:
    // distance 0 hid the fact that ac()'s default altFt is 18000, i.e. this
    // aircraft is directly over LGA at cruise altitude (a hold, overflight,
    // or missed approach), not touching down. Horizontal distance alone
    // said 0 minutes; it now correctly reflects the descent still owed:
    // 18000ft / 1800fpm (NOMINAL_DESCENT_FPM) = 10 minutes.
    const f = enrich(ac({ lat: LGA.lat, lon: LGA.lon }), sched, { units: 'imperial' })!;
    expect(f.eta_min).toBe(10);
    expect(f.eta_text).toBe('~10m');
  });

  it('still reports LANDING at zero distance when the aircraft is actually low', () => {
    // The genuine case the old test above meant to cover: an aircraft
    // actually near the ground at its destination's coordinates, where the
    // descent floor (50ft / 1800fpm, about 0.03min) is negligible.
    const f = enrich(ac({ lat: LGA.lat, lon: LGA.lon, altFt: 50 }), sched, { units: 'imperial' })!;
    expect(f.eta_min).toBe(0);
    expect(f.eta_text).toBe('LANDING');
  });

  it('reports LANDING for a genuinely on-ground aircraft at its destination', () => {
    // adsblol.ts parses a surface aircraft's alt_baro (the literal string
    // "ground") to altFt: null, not 0 -- so this is the real shape an
    // on-ground aircraft arrives in, not a stand-in. A null altitude must
    // not block LANDING at zero distance: no floor applies, exactly as if
    // altitude had never been supplied.
    const f = enrich(
      ac({ lat: LGA.lat, lon: LGA.lon, altFt: null, groundspeedKt: 0, onGround: true }),
      sched, { units: 'imperial' },
    )!;
    expect(f.eta_min).toBe(0);
    expect(f.eta_text).toBe('LANDING');
  });

  it('converts kt to km/h and ft to m by the documented factor, not just in the right direction', () => {
    const imperial = enrich(ac(), sched, { units: 'imperial' })!;
    const metric = enrich(ac(), sched, { units: 'metric' })!;
    expect(imperial.spd).toBe(400);
    expect(imperial.alt).toBe(18000);
    expect(metric.spd).toBe(741);   // 400kt * 1.852 km/h-per-kt
    expect(metric.alt).toBe(5486);  // 18000ft / 3.28084 ft-per-m
  });

  it('also converts vertical rate to m/min, the one metric field the plan never tests', () => {
    // Same division-by-FT_PER_M family as altitude, but a separate line of
    // code (a.verticalRateFpm / FT_PER_M) with no coverage anywhere in the
    // plan's own enrich tests.
    const imperial = enrich(ac(), sched, { units: 'imperial' })!;
    const metric = enrich(ac(), sched, { units: 'metric' })!;
    expect(imperial.vs).toBe(-1200);
    expect(metric.vs).toBe(-366); // -1200fpm / 3.28084 ft-per-m, sign preserved
  });
});

// Named regression test for a real production bug: an aircraft at cruise
// altitude, horizontally close to its own destination, was reported as
// "LANDING" because the ETA model only ever looked at horizontal distance.
describe('enrich: WJA2101 regression', () => {
  it('does not report LANDING for a cruise-altitude aircraft 8.6nm from its destination', () => {
    // Observed live: "cs":"WJA2101","from":"ATL","to":"JFK","alt":38000,
    // "eta_text":"LANDING" -- while the aircraft was ~8.6nm from JFK at
    // FL380 (38,000ft), still owing a full descent. Horizontal distance
    // alone put it at ~2.6 minutes out; at a nominal 1800fpm
    // (NOMINAL_DESCENT_FPM) descending from 38,000ft takes ~21 minutes.
    const JFK = { lat: 40.6394, lon: -73.7793 };
    const ATL = { lat: 33.6367, lon: -84.4281 };
    // 40.782636552971134 is precisely 8.6nm due north of JFK (same
    // longitude), verified against src/geo.ts's own haversineKm.
    const acLat = 40.782636552971134;
    const rows: ScheduleRow[] = [{
      callsign: 'WJA2101', carrierIata: 'WS', number: '2101',
      origIata: 'ATL', destIata: 'JFK',
      origLat: ATL.lat, origLon: ATL.lon, destLat: JFK.lat, destLon: JFK.lon,
      schedArrEpoch: null,
    }];
    const f = enrich(
      // distanceNm/bearingDeg are the board's own precomputed "distance from
      // query center" (a separate concept from distance-to-destination) --
      // set null here with no centerLat/centerLon so dst falls back to 0
      // rather than asserting something this test isn't about.
      ac({
        callsign: 'WJA2101', lat: acLat, lon: JFK.lon, altFt: 38000, groundspeedKt: 320,
        distanceNm: null, bearingDeg: null,
      }),
      rows,
      { units: 'imperial' },
    )!;
    expect(f.to).toBe('JFK');
    expect(f.alt).toBe(38000);
    expect(f.eta_min).toBe(21);        // round(38000 / 1800)
    expect(f.eta_text).not.toBe('LANDING');
    expect(f.eta_text).toBe('~20m');
  });
});
