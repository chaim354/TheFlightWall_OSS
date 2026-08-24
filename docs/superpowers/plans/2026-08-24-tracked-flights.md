# Tracked Flights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user track one specific flight on one specific date, anywhere in the world, pinned to the top of the panel with a marker.

**Architecture:** Server-side. AeroDataBox resolves `flight number + date` to the aircraft's `modeS` hex (~2 calls per journey); OpenSky then polls live positions by `icao24` for free. Gaps in ADS-B coverage are dead-reckoned along the great-circle route and labelled `pos_src: "estimated"` so they can never read as measured. Entries self-expire.

**Tech Stack:** TypeScript (Node 22+, strict, `noUncheckedIndexedAccess`), vitest, esbuild, Kamal/Docker. Firmware: arduino-esp32 2.0.17, PlatformIO, bare-g++ host tests.

**Spec:** `docs/superpowers/specs/2026-08-24-tracked-flights-design.md`

---

## Correction to the spec, applied throughout this plan

The spec says resolve "~3h before scheduled departure". **That is not computable
from a `pending` entry** -- the departure time is one of the things resolution
returns, so there is nothing to be 3h before. Using it literally would mean
either resolving blindly at some fixed hour or storing a time we do not have.

This plan uses two deterministic triggers instead, preserving the ~2-calls-per-
journey budget:

1. **Resolve #1** at `startOfUtcDay(date)` -- establishes scheduled times and a
   provisional aircraft.
2. **Resolve #2** at `schedDep - 1h`, now computable -- catches a tail swap,
   which is the failure the spec's second resolve exists for.

**The spec's `resolving` state is also dropped.** It listed seven states; this
plan has six. `resolving` described a moment inside a single tick -- the entry
is never persisted in it, because `runTrackedTick` performs the call and writes
the outcome in the same pass. Storing it would mean a crash mid-resolve leaves
an entry stuck in a state nothing transitions out of, which is a bug the shorter
enum makes unrepresentable. Resolution is an ACTION (`'resolve'` /
`'reresolve'`), not a state.

---

## File structure

**Create (server):**

| File | Responsibility |
|---|---|
| `server/src/tracked/types.ts` | `TrackedEntry`, `TrackedState`, `TrackedAction`, `ResolvedFlight` |
| `server/src/tracked/lifecycle.ts` | Pure `decideTracked(entry, nowMs, onGround)` state machine |
| `server/src/tracked/deadReckon.ts` | Pure great-circle interpolation |
| `server/src/tracked/store.ts` | `TrackedStorage` interface + file-backed impl |
| `server/src/tracked/resolve.ts` | AeroDataBox by-number client |
| `server/src/tracked/opensky.ts` | OpenSky `icao24` client |
| `server/src/tracked/routes.ts` | `/v1/tracked` GET/POST/DELETE + guards |
| `server/src/tracked/tick.ts` | Drives the state machine; the only unit with side effects |

**Create (tests):** one `server/test/tracked/<unit>.test.ts` per unit above.

**Modify:**

| File | Change |
|---|---|
| `server/src/flights.ts` | Merge pinned tracked cards ahead of area results |
| `server/src/server.ts` | Wire `/v1/tracked` routes + the tracked tick |
| `server/config/deploy.yml` | `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` secrets |
| `server/README.md` | Document the endpoint and its guards |
| `firmware/adapters/FlightWallServerFetcher.cpp` | Parse `pin` and `pos_src` |
| `firmware/models/FlightInfo.h` | `pinned` + `position_estimated` fields |
| `firmware/adapters/Hub75Display.cpp` | Marker, distinct for estimated |

---

## Task 1: Verify the two assumptions before building on them

**No code.** The spec flags two unknowns; everything downstream is priced on
them. Measure first.

**Files:**
- Create: `server/fixtures/aerodatabox-bynumber.json`
- Create: `docs/superpowers/audits/2026-08-24-tracked-flights-measurements.md`

- [ ] **Step 1: Capture one real by-number response**

Use a flight that is definitely operating today.

**Do NOT grep the key out of `server/.kamal/secrets`.** That file uses 1Password
indirection (`AERODATABOX_KEY=$(op ...)`), so a grep/cut yields the literal
command string, and sending it produces a 403 `"You are not subscribed to this
API."` that looks exactly like a plan/subscription problem and is not. Source
the file so the substitution runs:

```bash
cd server && set -a && . ./.kamal/secrets && set +a
```

```bash
curl -s -H "x-rapidapi-key: $AERODATABOX_KEY" -H "x-rapidapi-host: aerodatabox.p.rapidapi.com" \
  "https://aerodatabox.p.rapidapi.com/flights/number/BA181/$(date -u +%Y-%m-%d)" \
  | tee server/fixtures/aerodatabox-bynumber.json | python3 -m json.tool | head -60
```

- [ ] **Step 2: Confirm `modeS` is present**

```bash
python3 -c "
import json; d=json.load(open('server/fixtures/aerodatabox-bynumber.json'))
rows = d if isinstance(d,list) else [d]
for r in rows:
    a = r.get('aircraft') or {}
    print('modeS=', a.get('modeS'), ' reg=', a.get('reg'), ' status=', r.get('status'))
"
```

Expected: a 6-hex-digit `modeS`, e.g. `4008f3`.

**If `modeS` is absent: STOP and report.** The fallback is `reg` -> hex via a
separate registration lookup, which changes the per-journey cost and must be
re-costed before Tasks 6-9 are written. Tasks 2 and 3 are unaffected and can
proceed either way.

- [ ] **Step 3: Measure OpenSky credit cost for one icao24**

```bash
curl -s -u "$OPENSKY_CLIENT_ID:$OPENSKY_CLIENT_SECRET" \
  -D /tmp/osky-headers.txt \
  "https://opensky-network.org/api/states/all?icao24=4008f3" -o /tmp/osky.json
grep -i "x-rate-limit" /tmp/osky-headers.txt
head -c 300 /tmp/osky.json
```

Record `X-Rate-Limit-Remaining` before and after a second call; the difference is
the per-query cost.

- [ ] **Step 4: Write the measurements down**

Create `docs/superpowers/audits/2026-08-24-tracked-flights-measurements.md` with:
the observed `modeS` and `reg`, the OpenSky credit delta, the resulting safe poll
cadence (`floor(daily_allowance / credits_per_query / expected_concurrent_flights)`
seconds), and the date measured.

- [ ] **Step 5: Commit**

```bash
git add server/fixtures/aerodatabox-bynumber.json docs/superpowers/audits/2026-08-24-tracked-flights-measurements.md
git commit -m "test(tracked): capture by-number fixture and OpenSky credit cost"
```

---

## Task 2: Types

**Files:**
- Create: `server/src/tracked/types.ts`

- [ ] **Step 1: Write the types**

```typescript
/** Lifecycle states. See docs/superpowers/specs/2026-08-24-tracked-flights-design.md. */
export type TrackedState =
  | 'pending'
  | 'resolved'
  | 'airborne'
  | 'landed'
  | 'unresolved'
  | 'expired';

/** What the caller should DO about an entry this tick. Separate from state so
 * the state machine stays pure: it never performs the call it asks for. */
export type TrackedAction = 'none' | 'resolve' | 'reresolve' | 'poll' | 'drop';

export interface LatLon {
  lat: number;
  lon: number;
}

/** What resolve.ts returns on success. */
export interface ResolvedFlight {
  icao24: string | null;
  reg: string | null;
  origIata: string | null;
  destIata: string | null;
  orig: LatLon | null;
  dest: LatLon | null;
  schedDepEpoch: number | null;
  schedArrEpoch: number | null;
}

export interface TrackedEntry {
  id: string;
  /** Normalised: uppercase, no spaces. "ba 181" -> "BA181". */
  number: string;
  /** ISO date, "YYYY-MM-DD". */
  date: string;
  state: TrackedState;
  /** Human-readable why, set when state is `unresolved`. Null otherwise. */
  reason: string | null;
  /** Transport-error retries used so far. Reset on success. */
  attempts: number;
  /** When `state` was last assigned. Drives the expiry timers. */
  stateAtMs: number;
  /** True once resolve #2 has run, so it runs at most once. */
  reresolved: boolean;
  icao24: string | null;
  reg: string | null;
  origIata: string | null;
  destIata: string | null;
  orig: LatLon | null;
  dest: LatLon | null;
  schedDepEpoch: number | null;
  schedArrEpoch: number | null;
  /** Last observed position, live or estimated. */
  lastLat: number | null;
  lastLon: number | null;
  lastPosAtMs: number | null;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add server/src/tracked/types.ts
git commit -m "feat(tracked): types for the tracked-flight lifecycle"
```

---

## Task 3: The lifecycle state machine (pure)

**Files:**
- Create: `server/src/tracked/lifecycle.ts`
- Test: `server/test/tracked/lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { decideTracked, startOfUtcDay } from '../../src/tracked/lifecycle';
import type { TrackedEntry } from '../../src/tracked/types';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** A pending entry for 2026-09-14 with nothing resolved yet. */
function entry(over: Partial<TrackedEntry> = {}): TrackedEntry {
  return {
    id: 'e1',
    number: 'BA181',
    date: '2026-09-14',
    state: 'pending',
    reason: null,
    attempts: 0,
    stateAtMs: 0,
    reresolved: false,
    icao24: null,
    reg: null,
    origIata: null,
    destIata: null,
    orig: null,
    dest: null,
    schedDepEpoch: null,
    schedArrEpoch: null,
    lastLat: null,
    lastLon: null,
    lastPosAtMs: null,
    ...over,
  };
}

const DAY_START = Date.UTC(2026, 8, 14, 0, 0, 0); // month is 0-based

describe('startOfUtcDay', () => {
  it('returns midnight UTC for an ISO date', () => {
    expect(startOfUtcDay('2026-09-14')).toBe(DAY_START);
  });

  it('returns NaN for a malformed date rather than guessing', () => {
    expect(Number.isNaN(startOfUtcDay('14/09/2026'))).toBe(true);
    expect(Number.isNaN(startOfUtcDay('nonsense'))).toBe(true);
  });
});

describe('decideTracked - pending', () => {
  it('does nothing before the entry date begins', () => {
    const d = decideTracked(entry(), DAY_START - 1);
    expect(d).toEqual({ state: 'pending', action: 'none' });
  });

  it('resolves once the entry date begins', () => {
    // The spec said "3h before departure"; departure is unknown while pending,
    // so the trigger is the start of the date itself.
    const d = decideTracked(entry(), DAY_START);
    expect(d).toEqual({ state: 'pending', action: 'resolve' });
  });
});

describe('decideTracked - resolved', () => {
  const dep = DAY_START + 18 * HOUR;
  const arr = dep + 7 * HOUR;
  const resolved = (over: Partial<TrackedEntry> = {}) =>
    entry({ state: 'resolved', schedDepEpoch: dep / 1000, schedArrEpoch: arr / 1000, icao24: '4008f3', ...over });

  it('waits while departure is more than an hour away', () => {
    expect(decideTracked(resolved(), dep - HOUR - 1)).toEqual({ state: 'resolved', action: 'none' });
  });

  it('re-resolves exactly once, an hour before departure', () => {
    expect(decideTracked(resolved(), dep - HOUR)).toEqual({ state: 'resolved', action: 'reresolve' });
    // Already done: must not ask again, or every tick burns a call.
    expect(decideTracked(resolved({ reresolved: true }), dep - HOUR)).toEqual({
      state: 'resolved',
      action: 'none',
    });
  });

  it('becomes airborne at scheduled departure and starts polling', () => {
    expect(decideTracked(resolved({ reresolved: true }), dep)).toEqual({ state: 'airborne', action: 'poll' });
  });

  it('does not go airborne without a hex to poll', () => {
    // Nothing to ask OpenSky about. Polling would be a guaranteed-empty call.
    expect(decideTracked(resolved({ reresolved: true, icao24: null }), dep)).toEqual({
      state: 'resolved',
      action: 'none',
    });
  });
});

describe('decideTracked - airborne', () => {
  const dep = DAY_START + 18 * HOUR;
  const arr = dep + 7 * HOUR;
  const flying = (over: Partial<TrackedEntry> = {}) =>
    entry({ state: 'airborne', schedDepEpoch: dep / 1000, schedArrEpoch: arr / 1000, icao24: '4008f3', reresolved: true, ...over });

  it('keeps polling while en route', () => {
    expect(decideTracked(flying(), dep + HOUR)).toEqual({ state: 'airborne', action: 'poll' });
  });

  it('lands immediately when OpenSky reports on-ground, before the schedule says so', () => {
    // An early arrival must not keep burning OpenSky credits for an hour.
    expect(decideTracked(flying(), dep + HOUR, true)).toEqual({ state: 'landed', action: 'none' });
  });

  it('lands on schedule plus grace when no on-ground signal arrives', () => {
    // Grace exists because delays are normal and ADS-B coverage at the
    // destination is not guaranteed.
    expect(decideTracked(flying(), arr + 30 * 60_000 - 1)).toEqual({ state: 'airborne', action: 'poll' });
    expect(decideTracked(flying(), arr + 30 * 60_000)).toEqual({ state: 'landed', action: 'none' });
  });
});

describe('decideTracked - terminal states expire', () => {
  it('drops a landed entry two hours later', () => {
    const e = entry({ state: 'landed', stateAtMs: DAY_START });
    expect(decideTracked(e, DAY_START + 2 * HOUR - 1)).toEqual({ state: 'landed', action: 'none' });
    expect(decideTracked(e, DAY_START + 2 * HOUR)).toEqual({ state: 'expired', action: 'drop' });
  });

  it('drops an unresolved entry a day later, and never retries it', () => {
    // Terminal on purpose: a typo must cost a bounded number of calls, not a
    // retry loop against an endpoint that will never succeed.
    const e = entry({ state: 'unresolved', reason: 'not operating', stateAtMs: DAY_START });
    expect(decideTracked(e, DAY_START + DAY - 1)).toEqual({ state: 'unresolved', action: 'none' });
    expect(decideTracked(e, DAY_START + DAY)).toEqual({ state: 'expired', action: 'drop' });
  });

  it('drops anything whose date is more than a day past, whatever its state', () => {
    // Backstop: covers an entry stuck in a non-terminal state by a bug.
    const e = entry({ state: 'resolved', schedDepEpoch: null });
    expect(decideTracked(e, DAY_START + 2 * DAY)).toEqual({ state: 'expired', action: 'drop' });
  });

  it('an expired entry always asks to be dropped', () => {
    expect(decideTracked(entry({ state: 'expired' }), DAY_START)).toEqual({ state: 'expired', action: 'drop' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/tracked/lifecycle.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/tracked/lifecycle"`.

- [ ] **Step 3: Write the implementation**

```typescript
import type { TrackedEntry, TrackedAction, TrackedState } from './types';

/** Re-resolve this long before scheduled departure, to catch a tail swap. */
const RERESOLVE_LEAD_MS = 60 * 60_000;
/** How long after scheduled arrival to keep polling when nothing says landed. */
const ARRIVAL_GRACE_MS = 30 * 60_000;
/** Terminal-state expiry timers. */
const EXPIRE_AFTER_LANDED_MS = 2 * 60 * 60_000;
const EXPIRE_AFTER_UNRESOLVED_MS = 24 * 60 * 60_000;
/** Backstop for an entry stuck in a non-terminal state by a bug. */
const EXPIRE_AFTER_DATE_MS = 24 * 60 * 60_000;

export interface TrackedDecision {
  state: TrackedState;
  action: TrackedAction;
}

/**
 * Midnight UTC for an ISO "YYYY-MM-DD", or NaN if it is not one.
 *
 * Strict on purpose. `new Date("14/09/2026")` is an Invalid Date in some
 * engines and a real date in others, and a date that silently became the wrong
 * day would resolve the wrong flight and spend a call doing it.
 */
export function startOfUtcDay(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? NaN : ms;
}

/**
 * The whole lifecycle, as a pure function.
 *
 * Takes the observed on-ground flag as a PARAMETER rather than reading it, so
 * this stays testable without a network and the caller keeps the one job of
 * performing the action it is told to perform. `onGround` is null when we have
 * no observation this tick -- which is not the same as "airborne", and
 * conflating the two would land a flight every time ADS-B coverage dropped.
 */
export function decideTracked(
  e: TrackedEntry,
  nowMs: number,
  onGround: boolean | null = null,
): TrackedDecision {
  if (e.state === 'expired') return { state: 'expired', action: 'drop' };

  if (e.state === 'landed') {
    return nowMs - e.stateAtMs >= EXPIRE_AFTER_LANDED_MS
      ? { state: 'expired', action: 'drop' }
      : { state: 'landed', action: 'none' };
  }

  if (e.state === 'unresolved') {
    return nowMs - e.stateAtMs >= EXPIRE_AFTER_UNRESOLVED_MS
      ? { state: 'expired', action: 'drop' }
      : { state: 'unresolved', action: 'none' };
  }

  // Backstop before anything schedule-driven: an entry whose date is well past
  // has nothing left to do regardless of the state it is stuck in.
  const dayStart = startOfUtcDay(e.date);
  if (!Number.isNaN(dayStart) && nowMs >= dayStart + EXPIRE_AFTER_DATE_MS) {
    return { state: 'expired', action: 'drop' };
  }

  if (e.state === 'pending') {
    if (Number.isNaN(dayStart)) return { state: 'pending', action: 'none' };
    return nowMs >= dayStart
      ? { state: 'pending', action: 'resolve' }
      : { state: 'pending', action: 'none' };
  }

  const depMs = e.schedDepEpoch === null ? null : e.schedDepEpoch * 1000;
  const arrMs = e.schedArrEpoch === null ? null : e.schedArrEpoch * 1000;

  if (e.state === 'resolved') {
    if (depMs === null) return { state: 'resolved', action: 'none' };
    if (nowMs >= depMs) {
      // Nothing to poll without a hex; going airborne would guarantee an empty
      // call every tick for the length of the flight.
      return e.icao24
        ? { state: 'airborne', action: 'poll' }
        : { state: 'resolved', action: 'none' };
    }
    if (!e.reresolved && nowMs >= depMs - RERESOLVE_LEAD_MS) {
      return { state: 'resolved', action: 'reresolve' };
    }
    return { state: 'resolved', action: 'none' };
  }

  // airborne
  if (onGround === true) return { state: 'landed', action: 'none' };
  if (arrMs !== null && nowMs >= arrMs + ARRIVAL_GRACE_MS) {
    return { state: 'landed', action: 'none' };
  }
  return { state: 'airborne', action: 'poll' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/tracked/lifecycle.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/tracked/lifecycle.ts server/test/tracked/lifecycle.test.ts
git commit -m "feat(tracked): pure lifecycle state machine"
```

---

## Task 4: Dead reckoning (pure)

**Files:**
- Create: `server/src/tracked/deadReckon.ts`
- Test: `server/test/tracked/deadReckon.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { greatCircleAt, deadReckonAt } from '../../src/tracked/deadReckon';

const JFK = { lat: 40.6413, lon: -73.7781 };
const LHR = { lat: 51.47, lon: -0.4543 };

describe('greatCircleAt', () => {
  it('returns the endpoints at the extremes', () => {
    expect(greatCircleAt(JFK, LHR, 0).lat).toBeCloseTo(JFK.lat, 4);
    expect(greatCircleAt(JFK, LHR, 0).lon).toBeCloseTo(JFK.lon, 4);
    expect(greatCircleAt(JFK, LHR, 1).lat).toBeCloseTo(LHR.lat, 4);
    expect(greatCircleAt(JFK, LHR, 1).lon).toBeCloseTo(LHR.lon, 4);
  });

  it('bows NORTH of both endpoints at the midpoint', () => {
    // The distinguishing property of a great circle versus naive linear
    // interpolation: the JFK-LHR midpoint is north of BOTH airports. Linear
    // interpolation would put it at ~46N, between them, and would look
    // plausible while being wrong by hundreds of miles.
    const mid = greatCircleAt(JFK, LHR, 0.5);
    expect(mid.lat).toBeGreaterThan(LHR.lat);
    expect(mid.lat).toBeLessThan(60);
    expect(mid.lon).toBeGreaterThan(-45);
    expect(mid.lon).toBeLessThan(-25);
  });

  it('clamps a fraction outside 0..1 rather than extrapolating', () => {
    // Past the destination is not a place the aircraft can be.
    expect(greatCircleAt(JFK, LHR, 1.5).lat).toBeCloseTo(LHR.lat, 4);
    expect(greatCircleAt(JFK, LHR, -0.5).lat).toBeCloseTo(JFK.lat, 4);
  });

  it('handles identical endpoints without dividing by zero', () => {
    const p = greatCircleAt(JFK, JFK, 0.5);
    expect(p.lat).toBeCloseTo(JFK.lat, 4);
    expect(p.lon).toBeCloseTo(JFK.lon, 4);
  });
});

describe('deadReckonAt', () => {
  const dep = Date.UTC(2026, 8, 14, 18, 0, 0);
  const arr = Date.UTC(2026, 8, 15, 1, 0, 0); // 7h later
  const route = { orig: JFK, dest: LHR, depMs: dep, arrMs: arr };

  it('is at the origin at departure and the destination at arrival', () => {
    expect(deadReckonAt(route, dep)!.lat).toBeCloseTo(JFK.lat, 3);
    expect(deadReckonAt(route, arr)!.lat).toBeCloseTo(LHR.lat, 3);
  });

  it('is north of both airports halfway through', () => {
    const p = deadReckonAt(route, dep + 3.5 * 3600_000)!;
    expect(p.lat).toBeGreaterThan(LHR.lat);
  });

  it('clamps outside the flight window instead of extrapolating', () => {
    expect(deadReckonAt(route, dep - 3600_000)!.lat).toBeCloseTo(JFK.lat, 3);
    expect(deadReckonAt(route, arr + 3600_000)!.lat).toBeCloseTo(LHR.lat, 3);
  });

  it('returns null when the route is not fully known', () => {
    // Refusing is the point: a half-known route must produce no position at
    // all rather than a confident-looking guess.
    expect(deadReckonAt({ ...route, orig: null }, dep + 3600_000)).toBeNull();
    expect(deadReckonAt({ ...route, dest: null }, dep + 3600_000)).toBeNull();
    expect(deadReckonAt({ ...route, depMs: null }, dep + 3600_000)).toBeNull();
    expect(deadReckonAt({ ...route, arrMs: null }, dep + 3600_000)).toBeNull();
  });

  it('returns null for a zero or negative duration', () => {
    expect(deadReckonAt({ ...route, arrMs: dep }, dep)).toBeNull();
    expect(deadReckonAt({ ...route, arrMs: dep - 1 }, dep)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/tracked/deadReckon.test.ts`
Expected: FAIL — cannot resolve `../../src/tracked/deadReckon`.

- [ ] **Step 3: Write the implementation**

```typescript
import type { LatLon } from './types';

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Point at `fraction` along the great circle from `a` to `b`.
 *
 * Spherical linear interpolation, NOT linear interpolation of lat/lon. On a
 * JFK-LHR route the two differ by hundreds of miles at the midpoint -- the real
 * track bows north of both airports, which is why the aircraft is over Iceland
 * rather than mid-Atlantic. Since this position is already an estimate, using
 * the wrong curve would compound an approximation with an avoidable error.
 *
 * `fraction` is clamped: past the destination is not a place an aircraft can be.
 */
export function greatCircleAt(a: LatLon, b: LatLon, fraction: number): LatLon {
  const f = clamp01(fraction);
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lon);
  const φ2 = toRad(b.lat);
  const λ2 = toRad(b.lon);

  const δ = 2 * Math.asin(
    Math.sqrt(
      Math.sin((φ2 - φ1) / 2) ** 2 +
        Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
    ),
  );

  // Coincident endpoints: sin(δ) is 0 and the interpolation below would divide
  // by zero. There is also nothing to interpolate.
  if (δ === 0 || !Number.isFinite(δ)) return { lat: a.lat, lon: a.lon };

  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ) / Math.sin(δ);

  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);

  return {
    lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lon: toDeg(Math.atan2(y, x)),
  };
}

export interface DeadReckonRoute {
  orig: LatLon | null;
  dest: LatLon | null;
  depMs: number | null;
  arrMs: number | null;
}

/**
 * Estimated position from schedule alone, or null when it cannot be estimated.
 *
 * Returning null on partial input is deliberate. Every caller of this labels
 * the result `pos_src: "estimated"`, but a position derived from half a route
 * would be worse than that label admits -- so the only honest output for
 * incomplete input is no output. Assumes constant progress along the track,
 * which is wrong in detail (climb, cruise, descent, winds) and right enough for
 * "roughly where over the ocean is it".
 */
export function deadReckonAt(route: DeadReckonRoute, nowMs: number): LatLon | null {
  const { orig, dest, depMs, arrMs } = route;
  if (!orig || !dest || depMs === null || arrMs === null) return null;
  const duration = arrMs - depMs;
  if (duration <= 0) return null;
  return greatCircleAt(orig, dest, (nowMs - depMs) / duration);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/tracked/deadReckon.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/tracked/deadReckon.ts server/test/tracked/deadReckon.test.ts
git commit -m "feat(tracked): great-circle dead reckoning"
```

---

## Task 5: The entry store

**Files:**
- Create: `server/src/tracked/store.ts`
- Test: `server/test/tracked/store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTrackedStorage } from '../../src/tracked/store';
import type { TrackedEntry } from '../../src/tracked/types';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tracked-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sample = (id: string): TrackedEntry => ({
  id, number: 'BA181', date: '2026-09-14', state: 'pending', reason: null,
  attempts: 0, stateAtMs: 0, reresolved: false, icao24: null, reg: null,
  origIata: null, destIata: null, orig: null, dest: null,
  schedDepEpoch: null, schedArrEpoch: null,
  lastLat: null, lastLon: null, lastPosAtMs: null,
});

describe('fileTrackedStorage', () => {
  it('reads an empty list before anything is written', () => {
    // First boot is the common case, not an error.
    const s = fileTrackedStorage(join(dir, 'tracked.json'));
    return expect(s.read()).resolves.toEqual([]);
  });

  it('round-trips entries', async () => {
    const s = fileTrackedStorage(join(dir, 'tracked.json'));
    await s.write([sample('a'), sample('b')]);
    const back = await s.read();
    expect(back.map((e) => e.id)).toEqual(['a', 'b']);
    expect(back[0]!.number).toBe('BA181');
  });

  it('survives a reopen', async () => {
    const path = join(dir, 'tracked.json');
    await fileTrackedStorage(path).write([sample('a')]);
    expect((await fileTrackedStorage(path).read()).length).toBe(1);
  });

  it('returns an empty list rather than throwing on corrupt JSON', async () => {
    // A corrupt file must not take down /v1/flights, which does not depend on
    // tracked entries at all.
    const path = join(dir, 'tracked.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ not json', 'utf8');
    await expect(fileTrackedStorage(path).read()).resolves.toEqual([]);
  });

  it('returns an empty list when the file holds JSON that is not an array', async () => {
    const path = join(dir, 'tracked.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{"nope":true}', 'utf8');
    await expect(fileTrackedStorage(path).read()).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/tracked/store.test.ts`
Expected: FAIL — cannot resolve `../../src/tracked/store`.

- [ ] **Step 3: Write the implementation**

```typescript
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TrackedEntry } from './types';

export interface TrackedStorage {
  read(): Promise<TrackedEntry[]>;
  write(entries: TrackedEntry[]): Promise<void>;
}

/**
 * File-backed entry store, living in the same volume as the schedule table
 * (see config/deploy.yml) so entries survive a redeploy.
 *
 * Mirrors schedule/fileStorage.ts deliberately, including the write-to-temp-
 * then-rename: a crash mid-write must not leave a half-written file that reads
 * as corrupt on next boot.
 *
 * Every read failure degrades to an empty list rather than throwing. Tracked
 * flights are an addition to /v1/flights, never a precondition for it -- a
 * corrupt tracked file must cost the user their pinned cards, not the whole
 * wall.
 */
export function fileTrackedStorage(path: string): TrackedStorage {
  return {
    async read(): Promise<TrackedEntry[]> {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!Array.isArray(parsed)) {
          console.error('tracked store: file is not an array; ignoring');
          return [];
        }
        return parsed as TrackedEntry[];
      } catch (err) {
        // ENOENT is first boot, which is expected and not worth a line.
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.error('tracked store read failed:', err instanceof Error ? err.message : String(err));
        }
        return [];
      }
    },

    async write(entries: TrackedEntry[]): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(entries), 'utf8');
      await rename(tmp, path);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/tracked/store.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/tracked/store.ts server/test/tracked/store.test.ts
git commit -m "feat(tracked): file-backed entry store"
```

---

## Task 6: AeroDataBox by-number resolver

**Files:**
- Create: `server/src/tracked/resolve.ts`
- Test: `server/test/tracked/resolve.test.ts`

**Before starting:** re-read `server/fixtures/aerodatabox-bynumber.json` from
Task 1 and adjust the field paths below if the real payload differs. The parser
below assumes the same `aircraft: { reg, modeS }` shape the board endpoint uses
(`src/schedule/aerodatabox.ts:18`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseByNumber, resolveFlight } from '../../src/tracked/resolve';

const payload = [
  {
    number: 'BA 181',
    callSign: 'BAW181',
    status: 'Expected',
    aircraft: { reg: 'G-STBA', modeS: '4008F3', model: 'Boeing 777' },
    departure: {
      airport: { iata: 'JFK', location: { lat: 40.6413, lon: -73.7781 } },
      scheduledTime: { utc: '2026-09-14 18:00Z' },
    },
    arrival: {
      airport: { iata: 'LHR', location: { lat: 51.47, lon: -0.4543 } },
      scheduledTime: { utc: '2026-09-15 01:00Z' },
    },
  },
];

describe('parseByNumber', () => {
  it('extracts the hex, registration, route and times', () => {
    const r = parseByNumber(payload);
    expect(r).not.toBeNull();
    // Lowercased: OpenSky's icao24 is lowercase hex and comparisons elsewhere
    // assume it.
    expect(r!.icao24).toBe('4008f3');
    expect(r!.reg).toBe('G-STBA');
    expect(r!.origIata).toBe('JFK');
    expect(r!.destIata).toBe('LHR');
    expect(r!.orig).toEqual({ lat: 40.6413, lon: -73.7781 });
    expect(r!.schedDepEpoch).toBe(Math.floor(Date.parse('2026-09-14T18:00:00Z') / 1000));
    expect(r!.schedArrEpoch).toBe(Math.floor(Date.parse('2026-09-15T01:00:00Z') / 1000));
  });

  it('accepts a bare object as well as an array', () => {
    expect(parseByNumber(payload[0]!)!.icao24).toBe('4008f3');
  });

  it('returns null for an empty array (flight not operating that date)', () => {
    expect(parseByNumber([])).toBeNull();
  });

  it('returns a row with a null hex rather than null, when modeS is missing', () => {
    // "Resolved but no hex" is a DIFFERENT outcome from "no such flight", and
    // the caller reports them with different reasons. Collapsing them would
    // hide the spec's flagged risk that the by-number endpoint may not carry
    // modeS at all.
    const noHex = [{ ...payload[0]!, aircraft: { reg: 'G-STBA', model: 'B777' } }];
    const r = parseByNumber(noHex);
    expect(r).not.toBeNull();
    expect(r!.icao24).toBeNull();
    expect(r!.reg).toBe('G-STBA');
  });

  it('tolerates missing coordinates without throwing', () => {
    const noCoord = [{ ...payload[0]!, departure: { airport: { iata: 'JFK' }, scheduledTime: { utc: '2026-09-14 18:00Z' } } }];
    const r = parseByNumber(noCoord);
    expect(r!.orig).toBeNull();
    expect(r!.origIata).toBe('JFK');
  });
});

describe('resolveFlight', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('calls the by-number endpoint with the date and returns a parsed row', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await resolveFlight('BA181', '2026-09-14', 'KEY');
    expect(r.ok).toBe(true);
    expect(r.flight!.icao24).toBe('4008f3');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/flights/number/BA181/2026-09-14');
  });

  it('reports not-found as a terminal miss, not a transport error', async () => {
    // The distinction drives retry policy: a 404 must never be retried.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    const r = await resolveFlight('BA1811', '2026-09-14', 'KEY');
    expect(r).toEqual({ ok: false, retryable: false, reason: 'not operating 2026-09-14' });
  });

  it('reports 5xx and 429 as retryable', async () => {
    for (const status of [429, 500, 503]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
      const r = await resolveFlight('BA181', '2026-09-14', 'KEY');
      expect(r.ok).toBe(false);
      expect(r.retryable).toBe(true);
    }
  });

  it('reports a thrown fetch as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const r = await resolveFlight('BA181', '2026-09-14', 'KEY');
    expect(r).toEqual({ ok: false, retryable: true, reason: 'ECONNRESET' });
  });

  it('treats an empty result as terminal, not retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));
    const r = await resolveFlight('BA181', '2026-09-14', 'KEY');
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/tracked/resolve.test.ts`
Expected: FAIL — cannot resolve `../../src/tracked/resolve`.

- [ ] **Step 3: Write the implementation**

```typescript
import type { LatLon, ResolvedFlight } from './types';

const API_HOST = 'aerodatabox.p.rapidapi.com';
const BASE = `https://${API_HOST}`;

export type ResolveResult =
  | { ok: true; flight: ResolvedFlight }
  | { ok: false; retryable: boolean; reason: string };

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** AeroDataBox writes "2026-09-14 18:00Z"; Date.parse wants the T. */
const epoch = (v: unknown): number | null => {
  const s = str(v);
  if (!s) return null;
  const ms = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};

const coord = (airport: unknown): LatLon | null => {
  const loc = (airport as { location?: unknown } | null)?.location as
    | { lat?: unknown; lon?: unknown }
    | undefined;
  const lat = num(loc?.lat);
  const lon = num(loc?.lon);
  return lat === null || lon === null ? null : { lat, lon };
};

/**
 * Map one by-number payload to a ResolvedFlight, or null if it holds no row.
 *
 * Returning a row whose `icao24` is null is NOT the same as returning null. The
 * first means "this flight exists, we just have no transponder address"; the
 * second means "no such flight that day". The caller reports them differently,
 * and the spec flags the missing-modeS case as an explicit risk to keep visible.
 */
export function parseByNumber(payload: unknown): ResolvedFlight | null {
  const rows = Array.isArray(payload) ? payload : [payload];
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row || typeof row !== 'object') return null;

  const aircraft = (row.aircraft ?? {}) as Record<string, unknown>;
  const dep = (row.departure ?? {}) as Record<string, unknown>;
  const arr = (row.arrival ?? {}) as Record<string, unknown>;
  const depAirport = (dep.airport ?? null) as Record<string, unknown> | null;
  const arrAirport = (arr.airport ?? null) as Record<string, unknown> | null;

  const modeS = str(aircraft.modeS);

  return {
    // Lowercase: OpenSky's icao24 is lowercase hex and every comparison
    // downstream assumes it.
    icao24: modeS ? modeS.toLowerCase() : null,
    reg: str(aircraft.reg),
    origIata: str(depAirport?.iata),
    destIata: str(arrAirport?.iata),
    orig: coord(depAirport),
    dest: coord(arrAirport),
    schedDepEpoch: epoch((dep.scheduledTime as { utc?: unknown } | undefined)?.utc),
    schedArrEpoch: epoch((arr.scheduledTime as { utc?: unknown } | undefined)?.utc),
  };
}

/**
 * One AeroDataBox by-number lookup.
 *
 * `retryable` is the important half of the return. A 404 means the flight is
 * not operating that date -- retrying it can only ever waste calls, and on an
 * unauthenticated endpoint a retry loop against a permanent miss is exactly how
 * the quota drains. Transport failures (429, 5xx, thrown) are the opposite:
 * they say nothing about the flight and are worth another attempt.
 */
export async function resolveFlight(
  number: string,
  date: string,
  apiKey: string,
): Promise<ResolveResult> {
  const url = `${BASE}/flights/number/${encodeURIComponent(number)}/${encodeURIComponent(date)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': API_HOST } });
  } catch (e) {
    return { ok: false, retryable: true, reason: e instanceof Error ? e.message : String(e) };
  }

  if (res.status === 404) {
    return { ok: false, retryable: false, reason: `not operating ${date}` };
  }
  if (!res.ok) {
    return { ok: false, retryable: true, reason: `HTTP ${res.status}` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, retryable: false, reason: 'unparseable response' };
  }

  const flight = parseByNumber(payload);
  if (!flight) {
    return { ok: false, retryable: false, reason: `not operating ${date}` };
  }
  return { ok: true, flight };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/tracked/resolve.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/tracked/resolve.ts server/test/tracked/resolve.test.ts
git commit -m "feat(tracked): AeroDataBox by-number resolver"
```

---

## Task 7: OpenSky position client

**Files:**
- Create: `server/src/tracked/opensky.ts`
- Test: `server/test/tracked/opensky.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/tracked/opensky.test.ts`
Expected: FAIL — cannot resolve `../../src/tracked/opensky`.

- [ ] **Step 3: Write the implementation**

```typescript
const BASE = 'https://opensky-network.org/api/states/all';

export interface OpenSkyPosition {
  lat: number;
  lon: number;
  altitudeFt: number | null;
  headingDeg: number | null;
  onGround: boolean;
  seenAtEpoch: number | null;
}

export type PositionResult =
  | { ok: true; position: OpenSkyPosition | null }
  | { ok: false; reason: string };

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const M_TO_FT = 3.280839895;

/**
 * Map an OpenSky /states/all body to one position, or null if nobody is
 * receiving that aircraft.
 *
 * OpenSky returns POSITIONAL ARRAYS, not objects, so every field here is an
 * index into an undocumented-by-shape tuple. The indices are from its API docs;
 * the test pins them with a realistic vector so a reordering upstream fails
 * loudly rather than silently swapping latitude and longitude.
 *
 * null is "not currently seen", which is the ocean-gap case and NOT an error --
 * the caller responds by dead-reckoning, so conflating it with a failure would
 * drop the card exactly when the estimate is most wanted.
 */
export function parseStates(body: unknown): OpenSkyPosition | null {
  const states = (body as { states?: unknown } | null)?.states;
  if (!Array.isArray(states) || states.length === 0) return null;
  const s = states[0];
  if (!Array.isArray(s)) return null;

  const lon = num(s[5]);
  const lat = num(s[6]);
  // A listed aircraft with no fix is common. Coercing null to 0 would place it
  // off the coast of Africa, which is the plausible-looking-wrong-value failure
  // this codebase already guards against elsewhere.
  if (lat === null || lon === null) return null;

  const altM = num(s[7]);
  return {
    lat,
    lon,
    altitudeFt: altM === null ? null : Math.round(altM * M_TO_FT),
    headingDeg: num(s[10]),
    onGround: s[8] === true,
    seenAtEpoch: num(s[3]),
  };
}

/**
 * One OpenSky lookup for a single transponder address.
 *
 * Filtering by icao24 rather than fetching an area is what keeps this cheap
 * enough to run per tick -- see the credit measurement in
 * docs/superpowers/audits/2026-08-24-tracked-flights-measurements.md.
 */
export async function fetchPosition(
  icao24: string,
  clientId: string,
  clientSecret: string,
): Promise<PositionResult> {
  const url = `${BASE}?icao24=${encodeURIComponent(icao24.toLowerCase())}`;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Basic ${auth}` } });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

  try {
    return { ok: true, position: parseStates(await res.json()) };
  } catch {
    return { ok: false, reason: 'unparseable response' };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/tracked/opensky.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/tracked/opensky.ts server/test/tracked/opensky.test.ts
git commit -m "feat(tracked): OpenSky position client"
```

---

## Task 8: The `/v1/tracked` routes and their guards

**Files:**
- Create: `server/src/tracked/routes.ts`
- Test: `server/test/tracked/routes.test.ts`

**Context the implementer needs:** this endpoint ships **unauthenticated** by the
maintainer's explicit decision (see the spec). The guards below are therefore
load-bearing, not defensive polish — they are the only thing bounding what a
stranger who finds the URL can spend. Do not relax them.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { normaliseNumber, validateEntry, MAX_ENTRIES } from '../../src/tracked/routes';

const TODAY = Date.UTC(2026, 8, 14);

describe('normaliseNumber', () => {
  it('uppercases and strips spaces', () => {
    expect(normaliseNumber('ba 181')).toBe('BA181');
    expect(normaliseNumber('  dl405 ')).toBe('DL405');
  });

  it('rejects anything that is not carrier+digits', () => {
    for (const bad of ['', '181', 'BA', 'B!181', 'BA181X9', 'a'.repeat(20)]) {
      expect(normaliseNumber(bad)).toBeNull();
    }
  });
});

describe('validateEntry', () => {
  it('accepts today and dates inside the window', () => {
    expect(validateEntry({ number: 'BA181', date: '2026-09-14' }, TODAY, 0).ok).toBe(true);
    expect(validateEntry({ number: 'BA181', date: '2026-09-28' }, TODAY, 0).ok).toBe(true);
    expect(validateEntry({ number: 'BA181', date: '2026-09-13' }, TODAY, 0).ok).toBe(true);
  });

  it('rejects dates outside today-1..today+14', () => {
    // Bounds what a stranger can queue up, and rejects backfill attempts.
    expect(validateEntry({ number: 'BA181', date: '2026-09-12' }, TODAY, 0).ok).toBe(false);
    expect(validateEntry({ number: 'BA181', date: '2026-09-29' }, TODAY, 0).ok).toBe(false);
  });

  it('rejects a malformed date rather than guessing', () => {
    expect(validateEntry({ number: 'BA181', date: '14/09/2026' }, TODAY, 0).ok).toBe(false);
    expect(validateEntry({ number: 'BA181', date: '' }, TODAY, 0).ok).toBe(false);
  });

  it('rejects a bad flight number', () => {
    expect(validateEntry({ number: '!!', date: '2026-09-14' }, TODAY, 0).ok).toBe(false);
  });

  it('rejects once the store is full', () => {
    expect(validateEntry({ number: 'BA181', date: '2026-09-14' }, TODAY, MAX_ENTRIES).ok).toBe(false);
    expect(validateEntry({ number: 'BA181', date: '2026-09-14' }, TODAY, MAX_ENTRIES - 1).ok).toBe(true);
  });

  it('gives a reason on every rejection', () => {
    // The endpoint is the only UI. "400" with no reason is unusable.
    const r = validateEntry({ number: 'BA181', date: '2026-01-01' }, TODAY, 0);
    expect(r.ok).toBe(false);
    expect(r.reason.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/tracked/routes.test.ts`
Expected: FAIL — cannot resolve `../../src/tracked/routes`.

- [ ] **Step 3: Write the implementation**

```typescript
import { randomUUID } from 'node:crypto';
import type { TrackedEntry } from './types';
import type { TrackedStorage } from './store';
import { startOfUtcDay } from './lifecycle';

/**
 * Hard cap on stored entries.
 *
 * Load-bearing, not cosmetic: this endpoint is unauthenticated by explicit
 * decision, so this and the date window below are what stop a stranger who
 * finds the URL from queueing unbounded work. Keep it consistent with the
 * daily resolution ceiling in tick.ts -- 20 entries x 2 calls each is 40, and
 * a ceiling below that would deadlock a legitimately full store.
 */
export const MAX_ENTRIES = 20;
const DAY_MS = 24 * 60 * 60_000;
const WINDOW_PAST_DAYS = 1;
const WINDOW_FUTURE_DAYS = 14;

/** Carrier prefix (2-3 alphanumerics) then 1-4 digits. "ba 181" -> "BA181". */
export function normaliseNumber(raw: string): string | null {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9]{2,3}\d{1,4}$/.test(s) ? s : null;
}

export interface EntryInput {
  number: string;
  date: string;
}

export type Validation =
  | { ok: true; number: string; date: string }
  | { ok: false; reason: string };

/**
 * Every rejection carries a reason because this endpoint IS the user interface
 * -- there is no form to show a validation message, so a bare 400 would leave
 * the user guessing which of the number, the date or the cap they hit.
 */
export function validateEntry(input: EntryInput, nowMs: number, currentCount: number): Validation {
  if (currentCount >= MAX_ENTRIES) {
    return { ok: false, reason: `at most ${MAX_ENTRIES} tracked flights; delete one first` };
  }

  const number = normaliseNumber(input.number ?? '');
  if (!number) {
    return { ok: false, reason: 'flight number must look like "BA181"' };
  }

  const dayMs = startOfUtcDay(input.date ?? '');
  if (Number.isNaN(dayMs)) {
    return { ok: false, reason: 'date must be YYYY-MM-DD' };
  }

  const todayMs = startOfUtcDay(new Date(nowMs).toISOString().slice(0, 10));
  if (dayMs < todayMs - WINDOW_PAST_DAYS * DAY_MS) {
    return { ok: false, reason: 'date is in the past' };
  }
  if (dayMs > todayMs + WINDOW_FUTURE_DAYS * DAY_MS) {
    return { ok: false, reason: `date is more than ${WINDOW_FUTURE_DAYS} days ahead` };
  }

  return { ok: true, number, date: input.date };
}

export function newEntry(number: string, date: string, nowMs: number): TrackedEntry {
  return {
    id: randomUUID(),
    number,
    date,
    state: 'pending',
    reason: null,
    attempts: 0,
    stateAtMs: nowMs,
    reresolved: false,
    icao24: null,
    reg: null,
    origIata: null,
    destIata: null,
    orig: null,
    dest: null,
    schedDepEpoch: null,
    schedArrEpoch: null,
    lastLat: null,
    lastLon: null,
    lastPosAtMs: null,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** GET /v1/tracked, POST /v1/tracked, DELETE /v1/tracked/{id}. */
export async function handleTracked(
  method: string,
  url: URL,
  bodyText: string,
  storage: TrackedStorage,
  nowMs: number,
): Promise<Response> {
  const entries = await storage.read();

  if (method === 'GET') {
    return json({ ok: true, entries });
  }

  if (method === 'POST') {
    let input: EntryInput;
    try {
      input = JSON.parse(bodyText) as EntryInput;
    } catch {
      return json({ ok: false, error: 'body must be JSON' }, 400);
    }
    const v = validateEntry(input, nowMs, entries.length);
    if (!v.ok) return json({ ok: false, error: v.reason }, 400);

    // Idempotent on (number, date): re-POSTing the same journey must not
    // consume a second slot against the cap.
    const existing = entries.find((e) => e.number === v.number && e.date === v.date);
    if (existing) return json({ ok: true, entry: existing });

    const entry = newEntry(v.number, v.date, nowMs);
    await storage.write([...entries, entry]);
    return json({ ok: true, entry }, 201);
  }

  if (method === 'DELETE') {
    const id = url.pathname.split('/').pop() ?? '';
    const remaining = entries.filter((e) => e.id !== id);
    if (remaining.length === entries.length) {
      return json({ ok: false, error: 'no such entry' }, 404);
    }
    await storage.write(remaining);
    return json({ ok: true });
  }

  return json({ ok: false, error: 'method not allowed' }, 405);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/tracked/routes.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/tracked/routes.ts server/test/tracked/routes.test.ts
git commit -m "feat(tracked): /v1/tracked routes with the guards that bound an open endpoint"
```

---

## Task 9: The tick — drive the state machine

**Files:**
- Create: `server/src/tracked/tick.ts`
- Test: `server/test/tracked/tick.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runTrackedTick, DAILY_RESOLVE_CEILING } from '../../src/tracked/tick';
import type { TrackedEntry } from '../../src/tracked/types';
import type { TrackedStorage } from '../../src/tracked/store';

const DAY_START = Date.UTC(2026, 8, 14);

const entry = (over: Partial<TrackedEntry> = {}): TrackedEntry => ({
  id: 'e1', number: 'BA181', date: '2026-09-14', state: 'pending', reason: null,
  attempts: 0, stateAtMs: 0, reresolved: false, icao24: null, reg: null,
  origIata: null, destIata: null, orig: null, dest: null,
  schedDepEpoch: null, schedArrEpoch: null,
  lastLat: null, lastLon: null, lastPosAtMs: null, ...over,
});

function memStore(initial: TrackedEntry[]): TrackedStorage & { current: TrackedEntry[] } {
  const box = {
    current: initial,
    async read() { return box.current; },
    async write(e: TrackedEntry[]) { box.current = e; },
  };
  return box;
}

const resolved = {
  icao24: '4008f3', reg: 'G-STBA', origIata: 'JFK', destIata: 'LHR',
  orig: { lat: 40.6413, lon: -73.7781 }, dest: { lat: 51.47, lon: -0.4543 },
  schedDepEpoch: Math.floor((DAY_START + 18 * 3600_000) / 1000),
  schedArrEpoch: Math.floor((DAY_START + 25 * 3600_000) / 1000),
};

describe('runTrackedTick', () => {
  it('resolves a pending entry once its date starts', async () => {
    const store = memStore([entry()]);
    const resolveFn = vi.fn().mockResolvedValue({ ok: true, flight: resolved });
    await runTrackedTick(store, DAY_START, {
      resolve: resolveFn, position: vi.fn(), resolvesUsedToday: 0,
    });
    expect(resolveFn).toHaveBeenCalledWith('BA181', '2026-09-14');
    expect(store.current[0]!.state).toBe('resolved');
    expect(store.current[0]!.icao24).toBe('4008f3');
  });

  it('marks a permanent miss unresolved and never calls again', async () => {
    const store = memStore([entry()]);
    const resolveFn = vi.fn().mockResolvedValue({ ok: false, retryable: false, reason: 'not operating 2026-09-14' });
    await runTrackedTick(store, DAY_START, { resolve: resolveFn, position: vi.fn(), resolvesUsedToday: 0 });
    expect(store.current[0]!.state).toBe('unresolved');
    expect(store.current[0]!.reason).toBe('not operating 2026-09-14');

    // Second tick: terminal, so no further call.
    resolveFn.mockClear();
    await runTrackedTick(store, DAY_START + 60_000, { resolve: resolveFn, position: vi.fn(), resolvesUsedToday: 0 });
    expect(resolveFn).not.toHaveBeenCalled();
  });

  it('retries a transport failure up to three times, then gives up', async () => {
    const store = memStore([entry()]);
    const resolveFn = vi.fn().mockResolvedValue({ ok: false, retryable: true, reason: 'HTTP 503' });
    for (let i = 0; i < 3; i++) {
      await runTrackedTick(store, DAY_START + i * 60_000, { resolve: resolveFn, position: vi.fn(), resolvesUsedToday: 0 });
    }
    expect(store.current[0]!.state).toBe('pending');
    expect(store.current[0]!.attempts).toBe(3);

    await runTrackedTick(store, DAY_START + 4 * 60_000, { resolve: resolveFn, position: vi.fn(), resolvesUsedToday: 0 });
    expect(store.current[0]!.state).toBe('unresolved');
  });

  it('refuses to resolve past the daily ceiling', async () => {
    // The ceiling is what stops an open endpoint draining the AeroDataBox quota.
    const store = memStore([entry()]);
    const resolveFn = vi.fn();
    await runTrackedTick(store, DAY_START, {
      resolve: resolveFn, position: vi.fn(), resolvesUsedToday: DAILY_RESOLVE_CEILING,
    });
    expect(resolveFn).not.toHaveBeenCalled();
    expect(store.current[0]!.state).toBe('pending');
  });

  it('polls OpenSky once airborne and stores the live fix', async () => {
    const store = memStore([entry({ state: 'resolved', reresolved: true, ...resolved })]);
    const positionFn = vi.fn().mockResolvedValue({
      ok: true, position: { lat: 52.1, lon: -30.5, altitudeFt: 37000, headingDeg: 62, onGround: false, seenAtEpoch: 1 },
    });
    await runTrackedTick(store, DAY_START + 18 * 3600_000, {
      resolve: vi.fn(), position: positionFn, resolvesUsedToday: 0,
    });
    expect(positionFn).toHaveBeenCalledWith('4008f3');
    expect(store.current[0]!.state).toBe('airborne');
    expect(store.current[0]!.lastLat).toBeCloseTo(52.1, 3);
  });

  it('lands the flight when OpenSky reports on-ground', async () => {
    const store = memStore([entry({ state: 'airborne', reresolved: true, ...resolved })]);
    const positionFn = vi.fn().mockResolvedValue({
      ok: true, position: { lat: 51.4, lon: -0.45, altitudeFt: 0, headingDeg: 0, onGround: true, seenAtEpoch: 1 },
    });
    await runTrackedTick(store, DAY_START + 20 * 3600_000, {
      resolve: vi.fn(), position: positionFn, resolvesUsedToday: 0,
    });
    expect(store.current[0]!.state).toBe('landed');
  });

  it('keeps the entry airborne when OpenSky sees nothing', async () => {
    // The ocean gap. Dropping to landed here would end tracking mid-Atlantic.
    const store = memStore([entry({ state: 'airborne', reresolved: true, ...resolved })]);
    await runTrackedTick(store, DAY_START + 20 * 3600_000, {
      resolve: vi.fn(), position: vi.fn().mockResolvedValue({ ok: true, position: null }), resolvesUsedToday: 0,
    });
    expect(store.current[0]!.state).toBe('airborne');
  });

  it('drops expired entries from the store', async () => {
    const store = memStore([entry({ state: 'landed', stateAtMs: DAY_START })]);
    await runTrackedTick(store, DAY_START + 3 * 3600_000, {
      resolve: vi.fn(), position: vi.fn(), resolvesUsedToday: 0,
    });
    expect(store.current).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/tracked/tick.test.ts`
Expected: FAIL — cannot resolve `../../src/tracked/tick`.

- [ ] **Step 3: Write the implementation**

```typescript
import { decideTracked } from './lifecycle';
import type { TrackedEntry } from './types';
import type { TrackedStorage } from './store';
import type { ResolveResult } from './resolve';
import type { PositionResult } from './opensky';

/**
 * Ceiling on AeroDataBox resolutions per day for this feature.
 *
 * 50, not a rounder number, because it must exceed what a legitimately full
 * store needs: MAX_ENTRIES (20) x 2 calls per journey is 40 in the worst case
 * where every entry resolves the same day, and a lower ceiling would deadlock
 * the cap against itself. It still leaves roughly 14 calls/day of the measured
 * spare untouched.
 */
export const DAILY_RESOLVE_CEILING = 50;

/** Transport retries before an entry is declared unresolved. */
const MAX_ATTEMPTS = 3;

export interface TrackedDeps {
  resolve(number: string, date: string): Promise<ResolveResult>;
  position(icao24: string): Promise<PositionResult>;
  resolvesUsedToday: number;
}

/**
 * One pass over every entry: ask the pure state machine what to do, then do it.
 *
 * All the branching lives in lifecycle.ts; this unit only performs actions and
 * writes results back. Keeping the split means the interesting rules are
 * testable without a network, and this file stays small enough to audit for the
 * one thing that matters on an unauthenticated feature -- that no path can call
 * AeroDataBox more than the ceiling allows.
 */
export async function runTrackedTick(
  storage: TrackedStorage,
  nowMs: number,
  deps: TrackedDeps,
): Promise<void> {
  const entries = await storage.read();
  if (entries.length === 0) return;

  let resolvesUsed = deps.resolvesUsedToday;
  const next: TrackedEntry[] = [];
  let changed = false;

  for (const e of entries) {
    const before = e.state;
    const d = decideTracked(e, nowMs);

    if (d.action === 'drop') {
      changed = true;
      continue;
    }

    let updated: TrackedEntry = d.state === before ? e : { ...e, state: d.state, stateAtMs: nowMs };
    if (d.state !== before) changed = true;

    if (d.action === 'resolve' || d.action === 'reresolve') {
      if (resolvesUsed >= DAILY_RESOLVE_CEILING) {
        console.error(
          `tracked: daily resolve ceiling (${DAILY_RESOLVE_CEILING}) reached; ${e.number} ${e.date} waits`,
        );
        next.push(updated);
        continue;
      }
      resolvesUsed++;
      const r = await deps.resolve(e.number, e.date);
      changed = true;

      if (r.ok) {
        updated = {
          ...updated,
          ...r.flight,
          state: 'resolved',
          stateAtMs: nowMs,
          attempts: 0,
          reresolved: d.action === 'reresolve' ? true : updated.reresolved,
          reason: null,
        };
      } else if (!r.retryable || updated.attempts + 1 >= MAX_ATTEMPTS) {
        // Terminal. A permanent miss is terminal immediately; a transport
        // failure becomes terminal once the attempt budget is spent, so a
        // single bad entry costs a bounded number of calls rather than a
        // retry loop forever.
        updated = {
          ...updated,
          state: 'unresolved',
          stateAtMs: nowMs,
          attempts: updated.attempts + 1,
          reason: r.reason,
        };
      } else {
        updated = { ...updated, attempts: updated.attempts + 1 };
      }
    } else if (d.action === 'poll' && updated.icao24) {
      const p = await deps.position(updated.icao24);
      changed = true;
      if (p.ok && p.position) {
        // Re-run the machine with the observation, so an early arrival lands
        // the flight now instead of burning credits until schedule+grace.
        const withObs = decideTracked(updated, nowMs, p.position.onGround);
        updated = {
          ...updated,
          state: withObs.state,
          stateAtMs: withObs.state === updated.state ? updated.stateAtMs : nowMs,
          lastLat: p.position.lat,
          lastLon: p.position.lon,
          lastPosAtMs: nowMs,
        };
      }
      // p.position === null is the ocean gap: leave the entry airborne and let
      // the serving layer dead-reckon. Not an error, and not a landing.
    }

    next.push(updated);
  }

  if (changed) await storage.write(next);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/tracked/tick.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/tracked/tick.ts server/test/tracked/tick.test.ts
git commit -m "feat(tracked): tick driving the lifecycle, with the resolve ceiling"
```

---

## Task 10: Serve pinned cards from `/v1/flights`

**Files:**
- Modify: `server/src/flights.ts`
- Test: `server/test/tracked/serve.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { trackedCards } from '../../src/tracked/serve';
import type { TrackedEntry } from '../../src/tracked/types';

const DAY = Date.UTC(2026, 8, 14);
const dep = DAY + 18 * 3600_000;
const arr = DAY + 25 * 3600_000;

const airborne = (over: Partial<TrackedEntry> = {}): TrackedEntry => ({
  id: 'e1', number: 'BA181', date: '2026-09-14', state: 'airborne', reason: null,
  attempts: 0, stateAtMs: DAY, reresolved: true, icao24: '4008f3', reg: 'G-STBA',
  origIata: 'JFK', destIata: 'LHR',
  orig: { lat: 40.6413, lon: -73.7781 }, dest: { lat: 51.47, lon: -0.4543 },
  schedDepEpoch: dep / 1000, schedArrEpoch: arr / 1000,
  lastLat: null, lastLon: null, lastPosAtMs: null, ...over,
});

describe('trackedCards', () => {
  it('emits a live card from a recent fix', () => {
    const now = dep + 3600_000;
    const cards = trackedCards([airborne({ lastLat: 52.1, lastLon: -30.5, lastPosAtMs: now - 30_000 })], now);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.pin).toBe(true);
    expect(cards[0]!.pos_src).toBe('live');
    expect(cards[0]!.cs).toBe('BA181');
    expect(cards[0]!.from).toBe('JFK');
    expect(cards[0]!.to).toBe('LHR');
  });

  it('dead-reckons and labels ESTIMATED when the fix is stale', () => {
    // The whole point: an estimate must never be servable as a measurement.
    const now = dep + 3.5 * 3600_000;
    const cards = trackedCards([airborne({ lastLat: 45, lastLon: -50, lastPosAtMs: now - 20 * 60_000 })], now);
    expect(cards[0]!.pos_src).toBe('estimated');
    expect(cards[0]!.lat).toBeGreaterThan(51.47); // great circle bows north
  });

  it('dead-reckons when there has never been a fix', () => {
    const now = dep + 3.5 * 3600_000;
    const cards = trackedCards([airborne()], now);
    expect(cards[0]!.pos_src).toBe('estimated');
    expect(cards[0]!.lat).not.toBeNull();
  });

  it('emits nothing for states that are not airborne', () => {
    for (const state of ['pending', 'resolved', 'landed', 'unresolved', 'expired'] as const) {
      expect(trackedCards([airborne({ state })], dep + 3600_000)).toEqual([]);
    }
  });

  it('emits nothing when the route is unknown and there is no fix', () => {
    // Nothing measured, nothing derivable: no card beats a card at (0,0).
    expect(trackedCards([airborne({ orig: null, dest: null })], dep + 3600_000)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/tracked/serve.test.ts`
Expected: FAIL — cannot resolve `../../src/tracked/serve`.

- [ ] **Step 3: Create `server/src/tracked/serve.ts`**

```typescript
import { deadReckonAt } from './deadReckon';
import type { TrackedEntry } from './types';

/** A fix older than this is not worth serving as current. */
const FIX_FRESH_MS = 5 * 60_000;

export interface TrackedCard {
  cs: string;
  flt: string;
  reg: string | null;
  from: string | null;
  to: string | null;
  lat: number;
  lon: number;
  pin: true;
  pos_src: 'live' | 'estimated';
}

/**
 * Cards for the flights currently in the air, pinned.
 *
 * `pos_src` is the load-bearing field. A dead-reckoned position is a schedule
 * projection, not an observation, and serving it indistinguishably from a fix
 * would be the plausible-looking-wrong-value failure this codebase already
 * guards against in clearStaleFlights and the ok:false propagation. The device
 * renders the two differently.
 *
 * An entry with neither a fresh fix nor a complete route yields NO card, rather
 * than a card at a default position.
 */
export function trackedCards(entries: TrackedEntry[], nowMs: number): TrackedCard[] {
  const cards: TrackedCard[] = [];

  for (const e of entries) {
    if (e.state !== 'airborne') continue;

    const fresh =
      e.lastLat !== null && e.lastLon !== null && e.lastPosAtMs !== null &&
      nowMs - e.lastPosAtMs <= FIX_FRESH_MS;

    let lat: number | null = null;
    let lon: number | null = null;
    let src: 'live' | 'estimated' = 'live';

    if (fresh) {
      lat = e.lastLat;
      lon = e.lastLon;
    } else {
      const p = deadReckonAt(
        {
          orig: e.orig,
          dest: e.dest,
          depMs: e.schedDepEpoch === null ? null : e.schedDepEpoch * 1000,
          arrMs: e.schedArrEpoch === null ? null : e.schedArrEpoch * 1000,
        },
        nowMs,
      );
      if (!p) continue;
      lat = p.lat;
      lon = p.lon;
      src = 'estimated';
    }

    if (lat === null || lon === null) continue;

    cards.push({
      cs: e.number,
      flt: e.number,
      reg: e.reg,
      from: e.origIata,
      to: e.destIata,
      lat,
      lon,
      pin: true,
      pos_src: src,
    });
  }

  return cards;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/tracked/serve.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Merge the cards into `/v1/flights`**

In `server/src/flights.ts`, extend `Env` and prepend the pinned cards to the
response array, before the existing area results:

```typescript
// Add to the Env interface (currently at src/flights.ts:15):
export interface Env {
  SCHEDULE: ScheduleStorage;
  /** Optional: absent on the Worker, which has no tracked-flight store. */
  TRACKED?: TrackedStorage;
}
```

Immediately before the response is serialised, prepend:

```typescript
// Pinned first, ahead of the nearest-first area ordering. The cap is applied
// AFTER prepending so a tracked flight can never be pushed off the end by
// ordinary traffic -- being crowded out by a jet that happens to be closer is
// exactly the failure this feature exists to prevent.
const pinned = env.TRACKED ? trackedCards(await env.TRACKED.read(), nowMs) : [];
const merged = [...pinned, ...flights].slice(0, max);
```

- [ ] **Step 6: Verify the whole suite still passes**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: tsc silent; all suites pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/tracked/serve.ts server/test/tracked/serve.test.ts server/src/flights.ts
git commit -m "feat(tracked): serve pinned cards, labelled live or estimated"
```

---

## Task 11: Wire the routes and the tick into the server

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/config/deploy.yml`

- [ ] **Step 1: Add config fields**

In `server/src/server.ts`, add to `ServerConfig` (near `quietHours`, ~line 26):

```typescript
  /** Absent disables tracked flights entirely; the routes 404. */
  openSkyClientId: string;
  openSkyClientSecret: string;
  trackedPath: string;
```

And in `configFromEnv`:

```typescript
    openSkyClientId: env.OPENSKY_CLIENT_ID ?? '',
    openSkyClientSecret: env.OPENSKY_CLIENT_SECRET ?? '',
    trackedPath: env.TRACKED_PATH ?? './data/tracked.json',
```

- [ ] **Step 2: Wire the routes**

In `startServer`, alongside the existing `/v1/flights` branch (~line 164):

```typescript
  if (url.pathname === '/v1/tracked' || url.pathname.startsWith('/v1/tracked/')) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const response = await handleTracked(
      req.method ?? 'GET',
      url,
      Buffer.concat(chunks).toString('utf8'),
      trackedStorage,
      Date.now(),
    );
    const body = await response.text();
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }
```

- [ ] **Step 3: Wire the tick**

Alongside the existing `refreshTick` interval:

```typescript
  // 60s: fast enough that a pinned card tracks usefully, slow enough that a
  // single flight costs ~480 OpenSky requests over an 8h crossing. Retune from
  // the credit measurement in
  // docs/superpowers/audits/2026-08-24-tracked-flights-measurements.md.
  const TRACKED_TICK_MS = 60_000;
  let resolvesUsedToday = 0;
  let resolveDay = new Date().getUTCDate();

  const trackedTimer = config.openSkyClientId
    ? setInterval(() => {
        const today = new Date().getUTCDate();
        if (today !== resolveDay) {
          resolveDay = today;
          resolvesUsedToday = 0;
        }
        void runTrackedTick(trackedStorage, Date.now(), {
          resolve: async (n, d) => {
            resolvesUsedToday++;
            return resolveFlight(n, d, config.aerodataboxKey);
          },
          position: (hex) => fetchPosition(hex, config.openSkyClientId, config.openSkyClientSecret),
          resolvesUsedToday,
        }).catch((e) => console.error('tracked tick failed:', e));
      }, TRACKED_TICK_MS)
    : undefined;
```

Add `if (trackedTimer) clearInterval(trackedTimer);` wherever `clearInterval(timer)`
already appears — there are two such sites, and missing one leaks a handle that
keeps the test process alive.

- [ ] **Step 4: Add the secrets to deploy.yml**

In `server/config/deploy.yml`, add to `env: secret:`:

```yaml
    - OPENSKY_CLIENT_ID
    - OPENSKY_CLIENT_SECRET
```

Then add both to `server/.kamal/secrets` locally (not committed).

- [ ] **Step 5: Verify**

```bash
cd server && npx tsc --noEmit && npx vitest run && npm run build
python3 -c "import yaml; yaml.safe_load(open('config/deploy.yml')); print('yaml ok')"
```

Expected: tsc silent, all suites pass, build succeeds, `yaml ok`.

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts server/config/deploy.yml
git commit -m "feat(tracked): wire the routes, the tick and the OpenSky secrets"
```

---

## Task 12: Device — parse and pin

**Files:**
- Modify: `firmware/models/FlightInfo.h`
- Modify: `firmware/adapters/FlightWallServerFetcher.cpp`
- Test: `firmware/test/test_pinsort.cpp`

- [ ] **Step 1: Write the failing host test**

```cpp
// Host unit tests for pinned-flight ordering — compile with g++, no hardware.
//
// Guarded like the other loose host tests under test/; see platformio.ini.
#ifndef PIO_UNIT_TESTING
#include "../utils/PinSort.h"
#include <cstdio>
#include <vector>
#include <string>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

struct Row { std::string id; bool pinned; double dist; };

int main() {
    // Pinned first, and WITHIN each group the existing nearest-first order is
    // preserved -- pinning changes which group a card is in, not the sort.
    std::vector<Row> v = {
        {"far",       false, 30.0},
        {"pinned-far",true,  90.0},
        {"near",      false, 2.0},
        {"pinned-nr", true,  10.0},
    };
    stablePinFirst(v, [](const Row &r) { return r.pinned; });
    CHECK(v[0].id == "pinned-far");
    CHECK(v[1].id == "pinned-nr");
    CHECK(v[2].id == "far");
    CHECK(v[3].id == "near");

    // No pinned rows: order is untouched.
    std::vector<Row> none = {{"a", false, 1.0}, {"b", false, 2.0}};
    stablePinFirst(none, [](const Row &r) { return r.pinned; });
    CHECK(none[0].id == "a");
    CHECK(none[1].id == "b");

    // All pinned: also untouched.
    std::vector<Row> all = {{"a", true, 1.0}, {"b", true, 2.0}};
    stablePinFirst(all, [](const Row &r) { return r.pinned; });
    CHECK(all[0].id == "a");

    // Empty is not a crash.
    std::vector<Row> empty;
    stablePinFirst(empty, [](const Row &r) { return r.pinned; });
    CHECK(empty.empty());

    if (failures == 0) { printf("ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
#endif
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd firmware && ./run_host_tests.sh pinsort`
Expected: FAIL (compile) — no such file `../utils/PinSort.h`.

- [ ] **Step 3: Create `firmware/utils/PinSort.h`**

```cpp
#pragma once

#include <algorithm>
#include <vector>

// Move pinned entries to the front, preserving relative order within both
// groups.
//
// std::stable_partition, not sort: the caller has ALREADY ordered these
// nearest-first, and pinning is meant to change which group a card is in, not
// to reorder within a group. A plain sort would silently discard that ordering
// and the cards would shuffle every cycle.
template <typename T, typename IsPinned>
inline void stablePinFirst(std::vector<T> &v, IsPinned isPinned)
{
    std::stable_partition(v.begin(), v.end(), isPinned);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd firmware && ./run_host_tests.sh pinsort`
Expected: `ALL PASS`, then `All 1 host tests passed.`

- [ ] **Step 5: Add the fields to `FlightInfo`**

In `firmware/models/FlightInfo.h`, alongside the existing flags:

```cpp
    // Server-pinned tracked flight: always shown, ahead of overhead traffic.
    bool pinned = false;
    // Position is a schedule projection, not an observed fix. Rendered
    // differently so the panel never asserts a position nobody measured.
    bool position_estimated = false;
```

- [ ] **Step 6: Parse them in the fetcher**

In `firmware/adapters/FlightWallServerFetcher.cpp`, inside the per-flight loop
(after `info.eta_text = optStr(f, "eta_text");`):

```cpp
        info.pinned = f["pin"] | false;
        // Absent means live: only the tracked path ever sets this, so an
        // ordinary area card must not be labelled an estimate by omission.
        info.position_estimated = (optStr(f, "pos_src") == "estimated");
```

And after the loop, before the log line:

```cpp
    stablePinFirst(outFlights, [](const FlightInfo &f) { return f.pinned; });
```

Add `#include "utils/PinSort.h"` at the top.

- [ ] **Step 7: Build both envs**

```bash
cd firmware && pio run -e esp32dev && pio run -e esp32s3
```

Expected: both `SUCCESS`.

- [ ] **Step 8: Commit**

```bash
git add firmware/utils/PinSort.h firmware/test/test_pinsort.cpp firmware/models/FlightInfo.h firmware/adapters/FlightWallServerFetcher.cpp
git commit -m "feat(fetch): parse pinned/estimated flags and order pinned first"
```

---

## Task 13: Device — the marker

**Files:**
- Modify: `firmware/adapters/Hub75Display.cpp`

- [ ] **Step 1: Find the card renderer**

```bash
cd firmware && grep -n "drawLogoOrBadge\|void Hub75Display::displayFlights" adapters/Hub75Display.cpp | head
```

- [ ] **Step 2: Draw the marker**

In the per-card drawing function, after the logo/badge is drawn, add:

```cpp
    // Pinned marker: a 3px bar at the card's left edge. Amber for a live fix,
    // hollow (outline only) for a dead-reckoned one -- the panel must never
    // present a schedule projection the same way it presents an observation,
    // which is the same rule eta_src follows for times.
    if (info.pinned)
    {
        const uint16_t amber = _matrix->color565(255, 180, 84);
        if (info.position_estimated)
        {
            _matrix->drawRect(x, y, 3, cardHeight, amber);
        }
        else
        {
            _matrix->fillRect(x, y, 3, cardHeight, amber);
        }
    }
```

Adjust `x`, `y` and `cardHeight` to the local variable names already in scope in
that function — read the surrounding code rather than assuming these names.

- [ ] **Step 3: Build both envs**

```bash
cd firmware && pio run -e esp32dev && pio run -e esp32s3
```

Expected: both `SUCCESS`.

- [ ] **Step 4: Commit**

```bash
git add firmware/adapters/Hub75Display.cpp
git commit -m "feat(display): mark pinned flights, hollow when the position is estimated"
```

---

## Task 14: Document and verify end to end

**Files:**
- Modify: `server/README.md`
- Modify: `HANDOFF.md`

- [ ] **Step 1: Document the endpoint in `server/README.md`**

Add after the env-var table:

```markdown
### Tracked flights

`POST /v1/tracked` with `{"number":"BA181","date":"2026-09-14"}` adds one
journey. `GET /v1/tracked` lists them; `DELETE /v1/tracked/{id}` removes one.

**This endpoint is UNAUTHENTICATED by deliberate choice.** Anyone who knows the
URL can add entries and read which flights are being followed. Four guards bound
what that costs, and they are load-bearing rather than cosmetic -- do not relax
them without adding auth first:

- at most 20 stored entries
- dates restricted to today-1 .. today+14
- at most 50 AeroDataBox resolutions per day for this feature
- entries expire on their own (2h after landing, 24h after an unresolved miss)

Requires `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET`. Without them the
tracked tick never starts and the feature is inert.
```

- [ ] **Step 2: Full verification sweep**

```bash
cd server && npx tsc --noEmit && npx vitest run && npm run build
cd ../firmware && pio run -e esp32dev && pio run -e esp32s3 && ./run_host_tests.sh
pio test -e esp32s3 --without-uploading --without-testing
cd .. && python3 -m unittest discover -s tools -p 'test_*.py'
git status --short
```

Expected: tsc silent; all server suites pass; both envs `SUCCESS`; `All 12 host
tests passed.`; on-device suite `PASSED`; tools `OK`; clean tree.

- [ ] **Step 3: Live check against the deployed server**

After deploying, add a real flight operating today and watch it resolve:

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"number":"BA181","date":"'"$(date -u +%Y-%m-%d)"'"}' \
  https://flightwall.tinkerex.com/v1/tracked | python3 -m json.tool
sleep 90
curl -s https://flightwall.tinkerex.com/v1/tracked | python3 -m json.tool
```

Expected: `state` moves `pending` -> `resolved` with a non-null `icao24`, or
`unresolved` with a reason. Both are correct outcomes; a stuck `pending` past
the date start is not.

- [ ] **Step 4: Record it in HANDOFF.md**

Add a row to the §0 table stating what was device-verified and, explicitly, what
was not — following the convention of the existing rows.

- [ ] **Step 5: Commit**

```bash
git add server/README.md HANDOFF.md
git commit -m "docs(tracked): document the endpoint, its guards and the open-by-choice decision"
```
