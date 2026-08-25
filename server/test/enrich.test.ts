import { describe, it, expect } from 'vitest';
import { enrich } from '../src/enrich';
import type { Aircraft, ScheduleRow } from '../src/types';
import { getAirportCoord } from '../src/schedule/airports';

// Ask the table production asks. These were hand-copied from a two-table
// version of airports.ts that 8556a5a DELETED, and LGA had since drifted
// 120 m from the value the Worker actually emits (F-SRV16-A). Nothing failed
// -- the corridor gate is 300 km -- but it meant every geometry assertion
// here was validated against a position production does not produce.
const LGA = getAirportCoord('KLGA')!;
const CVG = getAirportCoord('KCVG')!;

// Fixed instant used everywhere enrich() needs "now". enrich() is pure and
// takes it as an argument rather than reading Date.now() itself, so every
// test pins it explicitly -- see enrich.ts's own header comment for why.
// The value itself is arbitrary; only tests that build a schedule epoch
// relative to it (below) care about its magnitude.
const NOW_MS = 1_755_000_000_000;
const NOW_SEC = NOW_MS / 1000;

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
  schedArrEpoch: null, revArrEpoch: null,
}];

describe('enrich', () => {
  it('fills route, carrier name and ETA from the schedule', () => {
    const f = enrich(ac(), sched, {}, NOW_MS)!;
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
    const f = enrich(ac({ callsign: 'ZZZ9999' }), sched, {}, NOW_MS)!;
    expect(f.cs).toBe('ZZZ9999');
    expect(f.to).toBeNull();
    expect(f.eta_min).toBeNull();
    expect(f.eta_text).toBeNull();
    expect(f.alt).toBe(18000);
  });

  it('carries registration and type through from the position feed', () => {
    const f = enrich(ac(), sched, {}, NOW_MS)!;
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
    expect(enrich(ac(), rows, {}, NOW_MS)!.al).toBe('ZZ');
  });

  it('computes distance and bearing when the feed did not supply them', () => {
    const f = enrich(ac({ distanceNm: null, bearingDeg: null }), sched,
      { center: { lat: LGA.lat, lon: LGA.lon } }, NOW_MS)!;
    expect(f.dst).toBeGreaterThan(0);
    expect(f.brg).toBeGreaterThanOrEqual(0);
  });

  it('drops an aircraft with no callsign', () => {
    expect(enrich(ac({ callsign: '' }), sched, {}, NOW_MS)).toBeNull();
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
      schedArrEpoch: null, revArrEpoch: null,
    }];
    const f = enrich(ac(), rows, {}, NOW_MS)!;
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
      {}, NOW_MS)!;
    expect(f.to).toBe('LGA'); // the row still matched -- only the ETA is unavailable
    expect(f.eta_min).toBeNull();
    expect(f.eta_text).toBeNull();
    expect(f.eta_src).toBeNull();
  });

  it('still computes an ETA with missing groundspeed inside the terminal segment', () => {
    // The default ac() position is ~52nm from LGA -- inside TERMINAL_NM (60)
    // -- where the model uses a nominal speed, not the aircraft's own. A
    // missing groundspeed this close to the airport must not blank the ETA.
    const f = enrich(ac({ groundspeedKt: null }), sched, {}, NOW_MS)!;
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
    const f = enrich(ac({ lat: LGA.lat, lon: LGA.lon }), sched, {}, NOW_MS)!;
    expect(f.eta_min).toBe(10);
    expect(f.eta_text).toBe('~10m');
  });

  it('still reports LANDING at zero distance when the aircraft is actually low', () => {
    // The genuine case the old test above meant to cover: an aircraft
    // actually near the ground at its destination's coordinates, where the
    // descent floor (50ft / 1800fpm, about 0.03min) is negligible.
    const f = enrich(ac({ lat: LGA.lat, lon: LGA.lon, altFt: 50 }), sched, {}, NOW_MS)!;
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
      sched, {}, NOW_MS,
    )!;
    expect(f.eta_min).toBe(0);
    expect(f.eta_text).toBe('LANDING');
  });

  it('emits source units verbatim -- ft, kt, fpm, nm', () => {
    // The wire is imperial-only. These three assertions are what survives of the
    // metric-conversion tests: they pinned the imperial side too, and that half
    // is the actual contract the firmware decodes.
    const f = enrich(ac(), sched, {}, NOW_MS)!;
    expect(f.alt).toBe(18000);
    expect(f.spd).toBe(400);
    expect(f.vs).toBe(-1200);
    // hdg was the ONE wire key no test named. Every other key is pinned only
    // because some test happens to mention it -- rename this one and nothing
    // here fails, while FlightWallServerFetcher.cpp's optNum(f, "hdg") silently
    // returns nothing and the panel's heading row goes blank.
    expect(f.hdg).toBe(120);
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
      schedArrEpoch: null, revArrEpoch: null,
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
      {},
      NOW_MS,
    )!;
    expect(f.to).toBe('JFK');
    expect(f.alt).toBe(38000);
    expect(f.eta_min).toBe(21);        // round(38000 / 1800)
    expect(f.eta_text).not.toBe('LANDING');
    expect(f.eta_text).toBe('~20m');
  });
});

// Task: replace the modelled ETA with the operator's own arrival time when
// the schedule table carries one. Priority chain: revised (delay-aware) >
// scheduled (published) > physics (fallback). All four tiers below use the
// same CVG->LGA `sched` fixture, varying only schedArrEpoch/revArrEpoch and
// the clock, so the only thing under test is which source wins.
describe('enrich: schedule-time priority chain', () => {
  it('prefers the revised time over the scheduled time when both are usable', () => {
    const rows: ScheduleRow[] = [{
      ...sched[0]!,
      schedArrEpoch: NOW_SEC + 60 * 60,  // published: 1h from now
      revArrEpoch: NOW_SEC + 90 * 60,    // delayed 30min per the operator's own update
    }];
    const f = enrich(ac(), rows, {}, NOW_MS)!;
    expect(f.eta_src).toBe('revised');
    expect(f.eta_min).toBe(90);
    expect(f.eta_text).toBe('~1h30');
  });

  it('uses the scheduled time when no revised time is present', () => {
    const rows: ScheduleRow[] = [{
      ...sched[0]!,
      schedArrEpoch: NOW_SEC + 45 * 60,
      revArrEpoch: null,
    }];
    const f = enrich(ac(), rows, {}, NOW_MS)!;
    expect(f.eta_src).toBe('scheduled');
    expect(f.eta_min).toBe(45);
    expect(f.eta_text).toBe('~45m');
  });

  it('falls back to physics when neither revised nor scheduled is present', () => {
    // This is exactly `sched` itself (schedArrEpoch/revArrEpoch both null) --
    // restated here explicitly, alongside its siblings above and below,
    // because the task asked for this tier to have its own named case
    // rather than resting on the general "fills route..." test doing double
    // duty for it.
    const f = enrich(ac(), sched, {}, NOW_MS)!;
    expect(f.eta_src).toBe('physics');
    expect(f.eta_min).toBeGreaterThan(0);
  });

  it('falls back to physics when there is no schedule match at all', () => {
    // A genuinely different case from the one above: here there is no ROW,
    // so there is no destination either -- physics has nothing to measure
    // distance to, and neither did the pre-existing code (etaMinutes always
    // needed row.destLat/destLon, which only a match supplies). "Physics is
    // the fallback" therefore cannot mean "physics produces a number" in
    // this case; it means the no-match path degrades exactly as it always
    // did -- eta_min/eta_text/eta_src all null, no crash from touching
    // row.revArrEpoch/schedArrEpoch on a null row.
    const f = enrich(ac({ callsign: 'ZZZ9999' }), sched, {}, NOW_MS)!;
    expect(f.to).toBeNull();
    expect(f.eta_min).toBeNull();
    expect(f.eta_text).toBeNull();
    expect(f.eta_src).toBeNull();
  });

  it('uses the scheduled time when the revised time is present but in the past, rather than discarding the whole row', () => {
    // Per-tier independence: a stale/bad revised value must not drag down a
    // perfectly good scheduled one sitting right next to it. Falling all
    // the way to physics here would be a worse answer than the schedule
    // still has on offer.
    const rows: ScheduleRow[] = [{
      ...sched[0]!,
      schedArrEpoch: NOW_SEC + 20 * 60,  // still ahead of now
      revArrEpoch: NOW_SEC - 5 * 60,     // 5 minutes in the past
    }];
    const f = enrich(ac(), rows, {}, NOW_MS)!;
    expect(f.eta_src).toBe('scheduled');
    expect(f.eta_min).toBe(20);
  });
});

// Requirement 4: "a negative ETA must not render as a negative number or as
// '0m'". Decision: a past revised/scheduled time is stale data, not a valid
// answer -- treated exactly as if that field had never been supplied, so the
// chain moves to the next candidate (scheduled, then physics) instead of
// ever handing a non-positive number to round()/formatEta.
describe('enrich: a past arrival time is treated as stale, not as a negative ETA', () => {
  it('falls back to physics when the scheduled time is in the past and no revised time exists', () => {
    const rows: ScheduleRow[] = [{
      ...sched[0]!,
      schedArrEpoch: NOW_SEC - 10 * 60, // 10 minutes ago -- e.g. already landed, or a stale row
      revArrEpoch: null,
    }];
    const f = enrich(ac(), rows, {}, NOW_MS)!;
    expect(f.eta_src).toBe('physics');
    // The default ac()/sched pairing is the same geometry the plain
    // "fills route..." physics test uses -- a positive number, not a
    // negative one and not a value derived from the stale epoch.
    expect(f.eta_min).toBeGreaterThan(0);
    expect(f.eta_text).not.toMatch(/^-/);
    expect(f.eta_text).not.toBe('~0m');
  });

  it('falls back all the way to null, never negative, when every source is exhausted', () => {
    // Both times are stale AND the row has no destination coordinates, so
    // physics cannot run either -- the same "cannot estimate" shape as the
    // no-destination-coordinates edge case above, reached via a different
    // route (stale times instead of absent ones).
    const rows: ScheduleRow[] = [{
      callsign: 'EDV5075', carrierIata: 'DL', number: '5075',
      origIata: 'CVG', destIata: 'LGA',
      origLat: CVG.lat, origLon: CVG.lon, destLat: null, destLon: null,
      schedArrEpoch: NOW_SEC - 3600,
      revArrEpoch: NOW_SEC - 1800,
    }];
    const f = enrich(ac(), rows, {}, NOW_MS)!;
    expect(f.eta_min).toBeNull();
    expect(f.eta_text).toBeNull();
    expect(f.eta_src).toBeNull();
  });

  it('treats an epoch exactly equal to now as a real zero-minute answer, not stale data', () => {
    // The boundary itself: "in the past" means strictly before now, so an
    // arrival epoch equal to nowSec is still a usable (if imminent) answer,
    // not a case for falling through to the next tier.
    const rows: ScheduleRow[] = [{ ...sched[0]!, schedArrEpoch: NOW_SEC, revArrEpoch: null }];
    const f = enrich(ac(), rows, {}, NOW_MS)!;
    expect(f.eta_src).toBe('scheduled');
    expect(f.eta_min).toBe(0);
  });
});

// Named regression test for the second production bug eta.ts's physics model
// needed patching for: an aircraft climbing out of JFK for Reno, still slow
// and low, had its low INSTANTANEOUS groundspeed extrapolated across the
// entire remaining ~2,100nm -- reporting ~13h50 against a real ~5h flight.
// A real arrival time sidesteps the whole failure mode: it does not care how
// fast the aircraft happens to be moving right now.
describe('enrich: JBU81 JFK->RNO regression (real arrival time beats a bad physics extrapolation)', () => {
  it('uses the scheduled arrival instead of extrapolating from a low-altitude, low-speed climb-out', () => {
    // Coordinates from the bundled OurAirports table (src/schedule/airports.ts):
    // KJFK [40.6394, -73.7793], KRNO [39.4991, -119.768] -- ~2,090nm apart.
    const JFK = { lat: 40.6394, lon: -73.7793 };
    const RNO = { lat: 39.4991, lon: -119.768 };

    const rows: ScheduleRow[] = [{
      callsign: 'JBU81', carrierIata: 'B6', number: '81',
      origIata: 'JFK', destIata: 'RNO',
      origLat: JFK.lat, origLon: JFK.lon, destLat: RNO.lat, destLon: RNO.lon,
      schedArrEpoch: NOW_SEC + 5 * 3600, // real scheduled flight time: ~5h
      revArrEpoch: null,
    }];

    const f = enrich(
      ac({
        callsign: 'JBU81', lat: JFK.lat, lon: JFK.lon, altFt: 1975, groundspeedKt: 150,
        distanceNm: null, bearingDeg: null,
      }),
      rows,
      {},
      NOW_MS,
    )!;

    // The bug this replaces: at this exact geometry (~2,090nm, 150kt, floor
    // from 1,975ft negligible), the physics model alone gives ~830 minutes
    // (~13h50) -- verified by hand against etaMinutes' own formula:
    // (2090-60)/150*60 + 18 = ~830. The real flight is ~5h. This test's
    // whole point is that the schedule-time path no longer goes anywhere
    // near that number.
    expect(f.to).toBe('RNO');
    expect(f.eta_src).toBe('scheduled');
    expect(f.eta_min).toBe(300);       // exactly 5h, by construction above
    expect(f.eta_text).toBe('~5h00');
  });
});

// Task: a schedule-derived ETA is only as trustworthy as the journey it
// still describes, and unlike physics (anchored to the aircraft's own live
// position and speed), a schedule time carries no internal signal that it
// no longer applies -- a flight delayed past what its published time can
// still make looks exactly like a good time until checked against
// geometry. This guard rejects a revised/scheduled epoch that implies
// covering the remaining distance faster than MAX_SCHEDULE_GS_KT allows:
// the schedule-time analogue of join.ts's corridorExcessKm, which does the
// same job for route claims instead of time claims. It is primarily a
// delay filter -- see enrich.ts's own MAX_SCHEDULE_GS_KT comment for the
// full reasoning, including why it has to be read together with
// revArrEpoch rather than in isolation, and an honest accounting of what
// it does and does not catch.
describe('enrich: a schedule-derived ETA a delay has made unreachable is not used', () => {
  it('THY6044 regression: falls through to physics when the scheduled time implies 2,640kt over 660nm', () => {
    // Observed live: JFK->ATL, 660nm to go, eta_src "scheduled" claiming 15
    // minutes -- implying an average groundspeed of 660 / (15/60) =
    // 2,640kt, ~4x MAX_SCHEDULE_GS_KT (620) and far past anything a
    // subsonic airliner can do under any wind. Confirmed in the live
    // schedule table (as TK6044): scheduled 03:13Z (+13min, impossible for
    // 660nm) sat beside a since-published revised 04:40Z (+100min,
    // correct) -- the scheduled figure was never bad data, just a promise
    // a delay had already broken. This test predates that revision
    // existing (revArrEpoch: null below), which is exactly the window this
    // guard is for -- see the "recovers via a plausible revised time" test
    // further down for the case once TK6044's revision is in.
    //
    // 44.62927266987777 is precisely 660nm due north of ATL (same
    // longitude) -- same construction as the WJA2101 regression above,
    // verified against src/geo.ts's own haversineKm. The row carries the
    // aircraft's own operating callsign, so join.ts's exact-match path
    // returns it unconditionally: no corridor check runs, so this synthetic
    // position does not need to sit on the real JFK-ATL route, only to be
    // exactly 660nm from ATL.
    const ATL = { lat: 33.6367, lon: -84.4281 };
    const rows: ScheduleRow[] = [{
      callsign: 'THY6044', carrierIata: 'TK', number: '6044',
      origIata: 'JFK', destIata: 'ATL',
      origLat: 40.6394, origLon: -73.7793, destLat: ATL.lat, destLon: ATL.lon,
      schedArrEpoch: NOW_SEC + 15 * 60, revArrEpoch: null,
    }];
    const f = enrich(
      ac({ callsign: 'THY6044', lat: 44.62927266987777, lon: ATL.lon, distanceNm: null, bearingDeg: null }),
      rows, {}, NOW_MS,
    )!;
    expect(f.to).toBe('ATL');
    // Falls through to physics rather than the impossible 15-minute figure.
    // ac()'s default groundspeed (400kt) and altitude (18000ft) give a
    // clean, hand-verifiable number: (660-60)/400*60 + 18 (TERMINAL_MIN) =
    // 108 exactly; the 18000ft descent floor (10min) does not bind.
    expect(f.eta_src).toBe('physics');
    expect(f.eta_min).toBe(108);
    expect(f.eta_text).toBe('~1h50');
  });

  it('DAL688 regression: falls through to physics when the scheduled time implies 630kt over 2,099nm', () => {
    // Observed live: JFK->SEA, 2,099nm to go, eta_src "scheduled" claiming
    // 200 minutes -- implying 2,099 / (200/60) = 629.7kt, only ~1.6% over
    // MAX_SCHEDULE_GS_KT (620). Confirmed a heavily delayed flight, not a
    // borderline-real one: DAL688 had not made the progress its published
    // schedule assumed, so 200 minutes described a journey the delay had
    // already ruled out. That thin 1.6% margin is not a false-positive risk
    // to weigh against THY6044's clean 4x -- a delayed flight's scheduled
    // time degrades continuously as the delay grows, sitting just past the
    // line early on and further past it the longer the delay runs, so
    // catching DAL688 here means catching its delay near the start of that
    // curve, not scraping in a marginal call (see MAX_SCHEDULE_GS_KT's own
    // comment for the full reasoning, including the genuine-fast-leg case,
    // BA112 below, this bound must still let through -- DAL688 is also
    // JFK->SEA, WESTbound, a direction the jet stream cannot boost the way
    // it boosts an eastbound Atlantic leg, corroborating that 630kt was
    // never a tailwind on this flight specifically).
    //
    // 82.40761217283855 is precisely 2,099nm due north of SEA (same
    // longitude), verified the same way as THY6044 above.
    const SEA = { lat: 47.4479, lon: -122.3103 };
    const rows: ScheduleRow[] = [{
      callsign: 'DAL688', carrierIata: 'DL', number: '688',
      origIata: 'JFK', destIata: 'SEA',
      origLat: 40.6394, origLon: -73.7793, destLat: SEA.lat, destLon: SEA.lon,
      schedArrEpoch: NOW_SEC + 200 * 60, revArrEpoch: null,
    }];
    const f = enrich(
      ac({ callsign: 'DAL688', lat: 82.40761217283855, lon: SEA.lon, distanceNm: null, bearingDeg: null }),
      rows, {}, NOW_MS,
    )!;
    expect(f.to).toBe('SEA');
    // (2099-60)/400*60 + 18 = 323.85 -> rounds to 324; the 18000ft descent
    // floor (10min) does not bind.
    expect(f.eta_src).toBe('physics');
    expect(f.eta_min).toBe(324);
    expect(f.eta_text).toBe('~5h20');
  });

  it('does not reject a genuine fast eastbound leg -- BA112 JFK-LHR in 4h56 implies ~606kt, under the bound', () => {
    // The case MAX_SCHEDULE_GS_KT's own comment must not break: a real,
    // storm-assisted jet-stream tailwind on an eastbound Atlantic crossing,
    // not a hypothetical. British Airways 112 rode Storm Ciara's jet stream
    // from JFK to LHR in a widely-reported 4h56m on 9 Feb 2020. JFK-LHR is a
    // ~2,991.5nm great-circle (real coordinates); 4h56m (296min) implies
    // 2,991.5 / (296/60) = ~606.4kt -- comfortably inside MAX_SCHEDULE_GS_KT
    // (620, which requires at least ~289.5min for this distance), so the
    // schedule time survives and is used as given, not silently downgraded
    // to a physics guess.
    const JFK = { lat: 40.6394, lon: -73.7793 };
    const LHR = { lat: 51.4700, lon: -0.4543 };
    const rows: ScheduleRow[] = [{
      callsign: 'BAW112', carrierIata: 'BA', number: '112',
      origIata: 'JFK', destIata: 'LHR',
      origLat: JFK.lat, origLon: JFK.lon, destLat: LHR.lat, destLon: LHR.lon,
      schedArrEpoch: NOW_SEC + 296 * 60, revArrEpoch: null,
    }];
    const f = enrich(
      ac({ callsign: 'BAW112', lat: JFK.lat, lon: JFK.lon, distanceNm: null, bearingDeg: null }),
      rows, {}, NOW_MS,
    )!;
    expect(f.to).toBe('LHR');
    expect(f.eta_src).toBe('scheduled');
    expect(f.eta_min).toBe(296);
    // Minute resolution, because this is a clock time and not a physics guess
    // (see formatEta's clockDerived) -- so the text now names the same 4h56
    // this case is named after, instead of rounding it away to ~5h00.
    expect(f.eta_text).toBe('~4h56');
  });

  it('rejects only the implausible tier -- a bad revised time does not block a good scheduled time next to it', () => {
    // Per-tier independence, the same contract the existing past-arrival
    // guard already has (see "uses the scheduled time when the revised
    // time is present but in the past" above): THY6044's geometry (660nm
    // out) with revArrEpoch claiming the same impossible 15 minutes as the
    // real bug, and schedArrEpoch claiming a plausible 90 minutes
    // (660/(90/60) = 440kt, comfortably under the bound). The revised tier
    // is rejected on its own; the scheduled tier right next to it is not
    // dragged down by it.
    const ATL = { lat: 33.6367, lon: -84.4281 };
    const rows: ScheduleRow[] = [{
      callsign: 'THY6044', carrierIata: 'TK', number: '6044',
      origIata: 'JFK', destIata: 'ATL',
      origLat: 40.6394, origLon: -73.7793, destLat: ATL.lat, destLon: ATL.lon,
      schedArrEpoch: NOW_SEC + 90 * 60, revArrEpoch: NOW_SEC + 15 * 60,
    }];
    const f = enrich(
      ac({ callsign: 'THY6044', lat: 44.62927266987777, lon: ATL.lon, distanceNm: null, bearingDeg: null }),
      rows, {}, NOW_MS,
    )!;
    expect(f.eta_src).toBe('scheduled');
    expect(f.eta_min).toBe(90);
    expect(f.eta_text).toBe('~1h30');
  });

  it('TK6044: recovers via a plausible revised time once the operator publishes one for a delayed scheduled time', () => {
    // The complementary half of the THY6044 regression above, and the
    // concrete case for MAX_SCHEDULE_GS_KT's "read together with
    // revArrEpoch" point: TK6044's live schedule row carried scheduled
    // 03:13Z (+13min, implying 660/(13/60) = ~3,046kt -- impossible, and
    // rejected by this guard on its own) alongside a since-published
    // revised 04:40Z (+100min, implying 660/(100/60) = 396kt -- plausible).
    // The priority chain checks revised first and, once it passes this
    // same guard, uses it outright -- so once the operator's revision
    // lands, the delayed scheduled figure next to it is moot rather than
    // merely suppressed. This is the "after" to the other test's "before":
    // together they cover the whole timeline of a delay, from before any
    // revision exists (this guard is the only protection) to after one is
    // published (revArrEpoch is simply correct).
    const ATL = { lat: 33.6367, lon: -84.4281 };
    const rows: ScheduleRow[] = [{
      callsign: 'THY6044', carrierIata: 'TK', number: '6044',
      origIata: 'JFK', destIata: 'ATL',
      origLat: 40.6394, origLon: -73.7793, destLat: ATL.lat, destLon: ATL.lon,
      schedArrEpoch: NOW_SEC + 13 * 60, revArrEpoch: NOW_SEC + 100 * 60,
    }];
    const f = enrich(
      ac({ callsign: 'THY6044', lat: 44.62927266987777, lon: ATL.lon, distanceNm: null, bearingDeg: null }),
      rows, {}, NOW_MS,
    )!;
    expect(f.eta_src).toBe('revised');
    expect(f.eta_min).toBe(100);
    expect(f.eta_text).toBe('~1h40');
  });

  it('does not apply the guard inside TERMINAL_NM, where minute-level rounding dominates the implied speed', () => {
    // A close-in schedule time that LOOKS fast is not necessarily wrong: at
    // ~52nm (the default ac()/LGA pairing) a single minute of rounding in
    // the schedule feed (times are minute-, not second-, granular) swings
    // the implied speed by hundreds of knots on its own, and straight-line
    // distance stops tracking actual remaining track once vectoring and
    // holds enter the picture -- see MAX_SCHEDULE_GS_KT's own comment,
    // which points at this being the same reason etaMinutes (eta.ts) stops
    // trusting a computed speed at this same TERMINAL_NM threshold. Below
    // it the guard does not run at all, so a 4-minute claim over ~52nm --
    // which would fail the guard at long range -- passes through exactly as
    // it would have before this guard existed.
    const rows: ScheduleRow[] = [{ ...sched[0]!, schedArrEpoch: NOW_SEC + 4 * 60, revArrEpoch: null }];
    const f = enrich(ac(), rows, {}, NOW_MS)!;
    expect(f.eta_src).toBe('scheduled');
    expect(f.eta_min).toBe(4);
    // A clock time now shows its own minute rather than the nearest five, so
    // the "4-minute claim ... passes through exactly as it would have" above is
    // now literally what the panel says. The bare-zero floor still holds -- it
    // is just a floor of one minute here rather than five.
    expect(f.eta_text).toBe('~4m');
  });

  it('does not reject a schedule time when the row has no destination coordinates to check it against', () => {
    // Same "cannot evaluate, so let it through" stance formatEta already
    // takes for a non-finite distance (see "shows the route without an ETA"
    // in the edge-cases block above). With no destination coordinates there
    // is no distance to compare the claimed time against, so there is no
    // impossible-speed claim to detect -- the schedule time is used as-is.
    const rows: ScheduleRow[] = [{
      callsign: 'EDV5075', carrierIata: 'DL', number: '5075',
      origIata: 'CVG', destIata: 'LGA',
      origLat: CVG.lat, origLon: CVG.lon, destLat: null, destLon: null,
      schedArrEpoch: NOW_SEC + 2 * 60, // "impossible" at any real distance, but there is none to check
      revArrEpoch: null,
    }];
    const f = enrich(ac(), rows, {}, NOW_MS)!;
    expect(f.eta_src).toBe('scheduled');
    expect(f.eta_min).toBe(2);
  });
});
