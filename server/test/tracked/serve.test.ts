import { describe, it, expect } from 'vitest';
import { trackedCards } from '../../src/tracked/serve';
import type { TrackedEntry } from '../../src/tracked/types';

const DAY = Date.UTC(2026, 8, 14);
const dep = DAY + 18 * 3600_000;
const arr = DAY + 25 * 3600_000;

// Arbitrary wall location (JFK-ish), reused everywhere the test doesn't care
// about the exact centre -- only trackedCards' distance/bearing/LANDING tests
// below need to choose it deliberately.
const CENTER = { lat: 40.6413, lon: -73.7781 };

const airborne = (over: Partial<TrackedEntry> = {}): TrackedEntry => ({
  id: 'e1', number: 'BA181', date: '2026-09-14', state: 'airborne', reason: null,
  attempts: 0, stateAtMs: DAY, reresolved: true, icao24: '4008f3', callsign: 'BAW181', reg: 'G-STBA',
  aircraftModel: null, origIata: 'JFK', destIata: 'LHR',
  orig: { lat: 40.6413, lon: -73.7781 }, dest: { lat: 51.47, lon: -0.4543 },
  schedDepEpoch: dep / 1000, schedArrEpoch: arr / 1000,
  lastLat: null, lastLon: null, lastPosAtMs: null,
  lastAltFt: null, lastGroundspeedKt: null, lastHeadingDeg: null, lastVerticalRateFpm: null,
  ...over,
});

describe('trackedCards', () => {
  it('emits a live card from a recent fix', () => {
    const now = dep + 3600_000;
    const cards = trackedCards([airborne({ lastLat: 52.1, lastLon: -30.5, lastPosAtMs: now - 30_000 })], now, CENTER);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.pin).toBe(true);
    expect(cards[0]!.pos_src).toBe('live');
    // The ICAO callsign, not the IATA number the user typed. This is what the
    // device's operator parse needs -- it takes the first three letters, so
    // "BA181" yields "BA1" and no logo tile at all.
    expect(cards[0]!.cs).toBe('BAW181');
    expect(cards[0]!.flt).toBe('BA181'); // the marketing number is still carried
    expect(cards[0]!.from).toBe('JFK');
    expect(cards[0]!.to).toBe('LHR');
  });

  // The pinned card rendered with NO AIRLINE LOGO in production, because `cs`
  // carried the IATA number the user typed ("DL1732") while every other card
  // carries the ADS-B callsign ("DAL1732"), and the device derives the operator
  // -- and so the logo tile -- from the first three letters. "DL1" is not an
  // operator. AeroDataBox returns the right value as `callSign` and resolve.ts
  // was discarding it.
  it('identifies a card by its ICAO callsign, so the operator parse can find a logo', () => {
    const now = dep + 3600_000;
    const [card] = trackedCards(
      [airborne({ number: 'DL1732', callsign: 'DAL1732', lastLat: 52.1, lastLon: -30.5, lastPosAtMs: now })],
      now, CENTER,
    );
    expect(card!.cs).toBe('DAL1732');
    expect(card!.cs.slice(0, 3)).toBe('DAL'); // the three letters the tile is keyed on
    expect(card!.flt).toBe('DL1732');
  });

  it('falls back to the number for an entry stored before callsign existed', () => {
    // No schema migration for stored entries (see HANDOFF): an older entry
    // simply lacks the field. That must render the pre-fix card -- logo-less
    // but present -- rather than a card with no identity, which serve.ts would
    // otherwise have to drop.
    const now = dep + 3600_000;
    const [card] = trackedCards(
      [airborne({ number: 'DL1732', callsign: null, lastLat: 52.1, lastLon: -30.5, lastPosAtMs: now })],
      now, CENTER,
    );
    expect(card!.cs).toBe('DL1732');
  });

  it('dead-reckons and labels ESTIMATED when the fix is stale', () => {
    // The whole point: an estimate must never be servable as a measurement.
    // The dead-reckoned position itself (that it bows north of a straight
    // line, per great-circle interpolation) is deadReckon.test.ts's job to
    // verify -- lat/lon are no longer on the wire (see below), so this only
    // checks the label.
    const now = dep + 3.5 * 3600_000;
    const cards = trackedCards([airborne({ lastLat: 45, lastLon: -50, lastPosAtMs: now - 20 * 60_000 })], now, CENTER);
    expect(cards[0]!.pos_src).toBe('estimated');
  });

  it('dead-reckons when there has never been a fix', () => {
    const now = dep + 3.5 * 3600_000;
    const cards = trackedCards([airborne()], now, CENTER);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.pos_src).toBe('estimated');
  });

  it('keeps a fix LIVE across one missed poll', () => {
    // The freshness window must exceed the poll interval in server.ts
    // (TRACKED_TICK_MS, currently 300s) with margin. When the two were equal,
    // any late tick or single failed poll relabelled a perfectly good fix as
    // an estimate -- the card would oscillate live/estimated while nothing was
    // actually wrong. A fix one whole poll old is still the best thing we know.
    const now = dep + 3600_000;
    const oneMissedPoll = 300_000 + 30_000;
    const cards = trackedCards(
      [airborne({ lastLat: 52.1, lastLon: -30.5, lastPosAtMs: now - oneMissedPoll })], now, CENTER);
    expect(cards[0]!.pos_src).toBe('live');
  });

  it('falls back to estimated once a fix is older than two polls', () => {
    // Two consecutive misses is a real loss of coverage, not a timing wobble,
    // and THAT is when the honest answer becomes "we are projecting".
    const now = dep + 3600_000;
    const cards = trackedCards(
      [airborne({ lastLat: 52.1, lastLon: -30.5, lastPosAtMs: now - 12 * 60_000 })], now, CENTER);
    expect(cards[0]!.pos_src).toBe('estimated');
  });

  it('emits nothing for states that are not airborne', () => {
    for (const state of ['pending', 'resolved', 'landed', 'unresolved', 'expired'] as const) {
      expect(trackedCards([airborne({ state })], dep + 3600_000, CENTER)).toEqual([]);
    }
  });

  it('emits nothing when the route is unknown and there is no fix', () => {
    // Nothing measured, nothing derivable: no card beats a card at (0,0).
    expect(trackedCards([airborne({ orig: null, dest: null })], dep + 3600_000, CENTER)).toEqual([]);
  });

  // The regression this file exists for: the pinned card used to emit only
  // cs/flt/reg/from/to/lat/lon/pin/pos_src, so it rendered on the wall with a
  // callsign and route and NOTHING else -- no altitude, speed, distance, ETA,
  // airline or aircraft type. See serve.ts's own TrackedCard doc comment.
  it('carries every area-card field on a live fix, not just cs/flt/reg/from/to', () => {
    const now = dep + 3600_000;
    const cards = trackedCards([airborne({
      aircraftModel: 'Boeing 777-300ER Passenger',
      lastLat: 52.1, lastLon: -30.5, lastPosAtMs: now - 30_000,
      lastAltFt: 37000, lastGroundspeedKt: 480, lastHeadingDeg: 270, lastVerticalRateFpm: -800,
    })], now, CENTER);
    expect(cards).toHaveLength(1);
    const c = cards[0]!;
    expect(c.ac).toBe('Boeing 777-300ER Passenger');
    expect(c.al).toBe('British Airways'); // BA181 -> carrier prefix "BA"
    expect(c.alt).toBe(37000);
    expect(c.spd).toBe(480);
    expect(c.hdg).toBe(270);
    expect(c.vs).toBe(-800);
    expect(Number.isFinite(c.dst)).toBe(true);
    expect(Number.isFinite(c.brg)).toBe(true);
    expect(c.eta_min).not.toBeNull();
    expect(c.eta_src).toBe('scheduled');
    expect(c.eta_text).not.toBeNull();
  });

  it('does not carry lat/lon on the wire -- the firmware never parses them', () => {
    const now = dep + 3600_000;
    const cards = trackedCards([airborne({ lastLat: 52.1, lastLon: -30.5, lastPosAtMs: now - 30_000 })], now, CENTER);
    expect(cards[0]).not.toHaveProperty('lat');
    expect(cards[0]).not.toHaveProperty('lon');
  });

  it('unknown carrier prefix -> al is null, not a crash or a guessed name', () => {
    const now = dep + 3600_000;
    const cards = trackedCards([airborne({
      number: 'XX999',
      lastLat: 52.1, lastLon: -30.5, lastPosAtMs: now - 30_000,
    })], now, CENTER);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.al).toBeNull();
    expect(cards[0]!.flt).toBe('XX999'); // the rest of the card still renders
  });

  it('a dead-reckoned card still carries schedule-derived fields, with no OpenSky-derived ones', () => {
    // No fix has ever arrived (lastLat/lastLon/lastAltFt/... all null, the
    // airborne() default), so this exercises dead reckoning. eta_min/eta_src
    // come from the SCHEDULE, not from OpenSky, so they must still be there.
    const now = dep + 3.5 * 3600_000;
    const cards = trackedCards([airborne()], now, CENTER);
    expect(cards).toHaveLength(1);
    const c = cards[0]!;
    expect(c.pos_src).toBe('estimated');
    expect(c.eta_src).toBe('scheduled');
    // arr is DAY+25h, now is dep+3.5h = DAY+21.5h -> 3.5h = 210min remaining.
    expect(c.eta_min).toBe(210);
    expect(c.alt).toBeNull();
    expect(c.spd).toBeNull();
    expect(c.hdg).toBeNull();
    expect(c.vs).toBeNull();
  });

  describe('dst / brg: measured from the wall, in NAUTICAL MILES', () => {
    it('reports dst in nautical miles, not km -- a hand-computed separation', () => {
      // Centre at (0,0); live fix exactly 500nm due north (same longitude,
      // so the great circle runs along the meridian and this is EXACT, not
      // an approximation). 8.327706568089223 = toDeg((500 * KM_PER_NM) /
      // R_KM), computed independently from src/geo.ts's own constants, the
      // same way test/enrich.test.ts hand-derives its regression latitudes.
      // A km/NM mix-up (dst off by a factor of KM_PER_NM, 1.852x) would miss
      // this by over 400nm -- nowhere near the tolerance below.
      const center = { lat: 0, lon: 0 };
      const now = dep + 3600_000;
      const cards = trackedCards(
        [airborne({ lastLat: 8.327706568089223, lastLon: 0, lastPosAtMs: now - 30_000 })],
        now, center,
      );
      expect(cards[0]!.dst).toBeCloseTo(500, 1);
      expect(cards[0]!.brg).toBeCloseTo(0, 5); // due north
    });
  });

  describe('eta_text LANDING is measured to the DESTINATION, not the wall', () => {
    // Both cases below give the flight a schedule-derived eta_min of 5
    // (comfortably under eta.ts's LANDING_MAX_MIN, 9) so LANDING turns
    // entirely on the DISTANCE argument formatEta receives -- proving which
    // distance that is.
    it('does not say LANDING for a flight passing near the wall early in its journey', () => {
      // Live fix sits exactly AT the wall's centre (0nm away, well inside
      // LANDING_NM) but its destination is ~1800nm north -- a flight
      // overhead early on a long leg. If the implementation used
      // distance-to-wall for LANDING, this would wrongly say LANDING.
      const center = { lat: 0, lon: 0 };
      const now = dep + 3600_000;
      const cards = trackedCards([airborne({
        dest: { lat: 30, lon: 0 },
        schedArrEpoch: now / 1000 + 300, // 5 minutes from now
        lastLat: 0, lastLon: 0, lastPosAtMs: now - 30_000,
      })], now, center);
      expect(cards[0]!.eta_min).toBe(5);
      expect(cards[0]!.eta_text).not.toBe('LANDING');
      expect(cards[0]!.eta_text).toBe('~5m');
    });

    it('says LANDING for a flight near its own destination, however far that is from the wall', () => {
      // Live fix sits 10nm from its destination (inside LANDING_NM) while the
      // wall itself is ~6,600nm away. If the implementation used
      // distance-to-wall for LANDING, this would wrongly withhold it.
      const center = { lat: -80, lon: 0 };
      const now = dep + 3600_000;
      const cards = trackedCards([airborne({
        dest: { lat: 30, lon: 0 },
        schedArrEpoch: now / 1000 + 300, // 5 minutes from now
        // 29.833445868638215 is precisely 10nm due south of (30, 0) --
        // same meridian construction as the dst hand-computation above.
        lastLat: 29.833445868638215, lastLon: 0, lastPosAtMs: now - 30_000,
      })], now, center);
      expect(cards[0]!.eta_min).toBe(5);
      expect(cards[0]!.eta_text).toBe('LANDING');
    });
  });
});
