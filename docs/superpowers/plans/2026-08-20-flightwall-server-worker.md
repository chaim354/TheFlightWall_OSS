# FlightWall Server (Cloudflare Worker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker that fetches live positions, joins them to airport schedules, computes ETA, and returns a small display-ready flight list — so the ESP32 makes one HTTP call per cycle instead of up to seventeen TLS connections.

**Architecture:** A cron-triggered handler pulls arrival/departure boards for KJFK/KLGA/KEWR/KBOS into KV every 6h. A fetch handler pulls live positions from adsb.lol, joins each aircraft to a schedule row, applies a geometric plausibility filter, computes ETA from a two-segment physics model, converts units, resolves airline names, and returns the nearest N flights already sorted. All decision logic lives in pure modules that are unit-tested without the Workers runtime.

**Tech Stack:** TypeScript, Cloudflare Workers (Wrangler), Workers KV, Vitest.

---

## Scope

Plan **2 of 3** for [the server-mediated route + ETA design](../specs/2026-08-19-server-mediated-route-eta-design.md).

- **Plan 1 — bug fixes.** Done, commits `8b5075a`..`d869f51`.
- **Plan 2 (this one) — the Worker.** Testable end-to-end against fixtures with no hardware.
- **Plan 3 — firmware adapters.** Depends on the contract in Task 9 of this plan, not on this code.

## Correction to the spec, made here

The spec's join section says to look up a schedule row by `(operator prefix, trailing digits)`. **That is wrong for roughly half of all flights and this plan does not implement it.**

The collision measurement behind it (7.1% collisions on bare suffix, 0% on the composite key) proved the composite key is *unique among airborne ADS-B callsigns*. It never showed the key can *address a schedule row* — and it can't, because the two sides are keyed differently:

- ADS-B broadcasts the **operator**: `EDV5075` (Endeavor Air)
- A schedule row is keyed by the **marketing carrier**: `DL5075` (Delta)

Measured on the same sample (n=37): the operator prefix maps onto the flight-number carrier for only **51%** of flights. For the other **49%** — every regional-operated flight — `(EDV, 5075)` simply does not exist in the schedule.

So the join in this plan is:

1. **Preferred, if the provider ships an operating callsign on the row:** exact string match. No ambiguity, no tables.
2. **Fallback:** match on the **number alone**, then disambiguate by (a) whether the row's carrier is one this operator actually flies for, (b) geometric plausibility against the aircraft's position, (c) scheduled-time proximity. Ambiguity that survives all three yields **no route**, never a guess.

Task 1 determines which path is live. Both are implemented, so **the plan is not blocked on the answer** — the preferred path simply short-circuits the fallback when available.

## File Structure

| File | Responsibility |
|---|---|
| `server/wrangler.toml` | Worker config: KV binding, cron trigger, vars |
| `server/package.json`, `tsconfig.json`, `vitest.config.ts` | Tooling |
| `server/src/geo.ts` | Great-circle distance, bearing, corridor deviation. Pure. |
| `server/src/eta.ts` | Two-segment ETA model and display formatting. Pure. |
| `server/src/join.ts` | Callsign parsing, operator→carrier candidates, schedule matching. Pure. |
| `server/src/airlines.ts` | Carrier code → display name. Pure. |
| `server/src/adsblol.ts` | adsb.lol client + row→Aircraft parse |
| `server/src/schedule/aerodatabox.ts` | AeroDataBox FIDS client + row parse |
| `server/src/schedule/store.ts` | KV read/write of the schedule table, staleness |
| `server/src/enrich.ts` | Aircraft + schedule → display-ready Flight |
| `server/src/flights.ts` | `/v1/flights` handler: filter, sort, cap, serialise |
| `server/src/index.ts` | Worker entry: `fetch` + `scheduled` |
| `server/src/types.ts` | Shared types |
| `server/test/*.test.ts` | One suite per module |
| `server/fixtures/*.json` | Recorded provider responses |

Pure modules (`geo`, `eta`, `join`, `airlines`) carry all the decision logic and are tested without the Workers runtime. I/O modules are thin and fixture-tested.

## Verification used by every task

```bash
cd server && npm test
```
```bash
cd server && npx tsc --noEmit
```

---

### Task 1: Scaffold, and settle the two AeroDataBox unknowns

Two facts decide how the join works and what it costs. Both are answerable on AeroDataBox's free tier (600 units).

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/wrangler.toml`, `server/.gitignore`
- Create: `server/fixtures/README.md`
- Modify: `.gitignore` (repo root)

- [ ] **Step 1: Check the Node version supports current Wrangler**

```bash
node --version
```

Wrangler 4 requires Node 20+. This repo's environment had v18.20.8 at time of writing. If you are on 18, either upgrade or pin `wrangler@3` in the next step — **do not silently proceed**, note which you chose in the commit message.

- [ ] **Step 2: Scaffold**

Create `server/package.json`:

```json
{
  "name": "flightwall-server",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240909.0",
    "@types/node": "^20.19.43",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5",
    "wrangler": "^3.78.0"
  }
}
```

`@types/node` is needed starting Task 6: its test reads a fixture via `node:fs`
and `import.meta.url`, and without Node's ambient types `tsc --noEmit` fails
with `Cannot find module 'node:fs'`. Pin it to the `^20` line specifically —
newer major versions (v26 at time of writing) assume `Symbol.dispose` support
that this project's `"lib": ["ES2022"]` doesn't provide, which collides with
`@cloudflare/workers-types`'s `URL` global and breaks `tsc` on any `URL` use.
Scaffolding it now avoids rediscovering this the hard way in Task 6.

Create `server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ES2022",
    "moduleResolution": "bundler",
    // "node" is here only because test/**/*.ts reads fixtures via node:fs
    // and import.meta.url — nothing in src/ needs it. Pinned to ^20 in
    // package.json: @types/node's v26 line assumes Symbol.dispose support
    // that this project's ES2022 lib doesn't provide, which collides with
    // @cloudflare/workers-types' URL global (their URLSearchParamsIterator
    // types stop matching, so tsc fails on any URL use). Trade-off: Node
    // globals are now visible to src/** at type-check time even though they
    // do not exist at runtime in a Worker — src/ code must not reach for them.
    "types": ["@cloudflare/workers-types", "node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
```

Create `server/wrangler.toml`:

```toml
name = "flightwall-server"
main = "src/index.ts"
compatibility_date = "2026-08-20"

# Schedule refresh. Route data is stable day-to-day (measured 94-100%), so this
# is about picking up the next day's board, not about freshness within a pass.
[triggers]
crons = ["0 */6 * * *"]

[vars]
BOARDS = "KJFK,KLGA,KEWR,KBOS"

# AERODATABOX_KEY is a secret: wrangler secret put AERODATABOX_KEY

# [[kv_namespaces]]
# binding = "SCHEDULE"
# id = "<fill in after: wrangler kv namespace create SCHEDULE>"
```

Create `server/.gitignore`:

```
node_modules/
.wrangler/
dist/
```

Append to the repo-root `.gitignore`:

```
# Worker dependencies (server/ has its own .gitignore for the rest)
server/node_modules
```

- [ ] **Step 3: Install and confirm the toolchain runs**

```bash
cd server && npm install && npx tsc --noEmit
```

Expected: install succeeds, `tsc` exits 0 with no files yet to check.

- [ ] **Step 4: Answer unknown #1 — the FIDS credit tier**

You need an AeroDataBox key. If you do not have one, STOP and report NEEDS_CONTEXT — do not create an account.

Note your credit balance, make exactly one FIDS call, note it again:

```bash
curl -s -D- -o /tmp/fids.json \
  -H "x-magicapi-key: $AERODATABOX_KEY" \
  "https://prod.api.market/api/v1/aedbx/aerodatabox/flights/airports/icao/KJFK/2026-08-20T12:00/2026-08-20T18:00?withLeg=true&direction=Both" \
  | grep -i "ratelimit\|quota\|credit"
```

The exact host and header depend on whether the key is from AeroDataBox direct, RapidAPI, or API.market — check which you have and adapt. Record the per-call unit cost in `server/fixtures/README.md`.

- [ ] **Step 5: Answer unknown #2 — does a FIDS row carry the operating callsign?**

```bash
python3 -c "
import json; d=json.load(open('/tmp/fids.json'))
rows=(d.get('arrivals') or []) + (d.get('departures') or [])
print('rows:', len(rows))
if rows:
    import sys; json.dump(rows[0], sys.stdout, indent=1)
    print()
    keys=set()
    for r in rows[:50]: keys.update(r.keys())
    print('all keys:', sorted(keys))
    print('CALLSIGN PRESENT:', any('callsign' in str(k).lower() for k in keys))
"
```

**This is the deciding output.** If a callsign field exists and holds the *operating* callsign (`EDV5075`, not `DAL5075`), the exact-match path in Task 4 is live and the disambiguation fallback becomes dead code you keep but never exercise. If it does not, the fallback carries the join.

Verify by picking a row whose flight number starts `DL5` or `AA4` (regional ranges) and checking whether its callsign prefix differs from the marketing carrier. A row where `DL5075` reports callsign `DAL5075` means the field is derived, not operational, and **does not** solve the problem.

- [ ] **Step 6: Save the fixture**

Save the response to `server/fixtures/fids-kjfk.json`. Redact nothing — it is public schedule data. Record in `server/fixtures/README.md`: the date captured, the endpoint, the credit cost per call, and the callsign-field verdict.

- [ ] **Step 7: Commit**

```bash
git add server .gitignore
git commit -m "feat(server): scaffold Worker, settle AeroDataBox unknowns

Records the FIDS credit tier and whether FIDS rows carry the operating
callsign. The second decides whether the join is an exact string match
or number-plus-disambiguation; both are implemented, so this only
determines which path is live."
```

---

### Task 2: Geometry

Distance, bearing, and how far off a route corridor an aircraft sits. The corridor function is what lets the server reject a schedule row that is geometrically impossible for where the aircraft actually is.

**Files:**
- Create: `server/src/geo.ts`
- Create: `server/test/geo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/geo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { haversineKm, bearingDeg, corridorExcessKm, KM_PER_NM } from '../src/geo';

const JFK = { lat: 40.6413, lon: -73.7781 };
const LAX = { lat: 33.9416, lon: -118.4085 };
const BOS = { lat: 42.3656, lon: -71.0096 };

describe('haversineKm', () => {
  it('measures a known long leg', () => {
    // JFK-LAX great circle is ~3974 km.
    expect(haversineKm(JFK.lat, JFK.lon, LAX.lat, LAX.lon)).toBeCloseTo(3974, -1);
  });

  it('is zero for identical points and symmetric', () => {
    expect(haversineKm(JFK.lat, JFK.lon, JFK.lat, JFK.lon)).toBe(0);
    expect(haversineKm(JFK.lat, JFK.lon, BOS.lat, BOS.lon))
      .toBeCloseTo(haversineKm(BOS.lat, BOS.lon, JFK.lat, JFK.lon), 9);
  });

  it('handles antimeridian crossing without going the long way', () => {
    // 179E to 179W is 2 degrees apart, not 358.
    expect(haversineKm(0, 179, 0, -179)).toBeLessThan(250);
  });
});

describe('bearingDeg', () => {
  it('points north, east, south, west', () => {
    expect(bearingDeg(0, 0, 10, 0)).toBeCloseTo(0, 1);
    expect(bearingDeg(0, 0, 0, 10)).toBeCloseTo(90, 1);
    expect(bearingDeg(0, 0, -10, 0)).toBeCloseTo(180, 1);
    expect(bearingDeg(0, 0, 0, -10)).toBeCloseTo(270, 1);
  });

  it('always returns 0..360', () => {
    const b = bearingDeg(JFK.lat, JFK.lon, LAX.lat, LAX.lon);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
  });
});

describe('corridorExcessKm', () => {
  it('is ~0 for a point on the route', () => {
    // A point at JFK, on a JFK->LAX route.
    expect(corridorExcessKm(JFK.lat, JFK.lon, JFK.lat, JFK.lon, LAX.lat, LAX.lon))
      .toBeCloseTo(0, 6);
  });

  it('is large for a point nowhere near the route', () => {
    // Aircraft over New York, claimed route SFO-LAX. This is the real
    // SWA1304 case: adsbdb returned SFO-LAX for an aircraft over NYC.
    const SFO = { lat: 37.6188, lon: -122.375 };
    const excess = corridorExcessKm(JFK.lat, JFK.lon, SFO.lat, SFO.lon, LAX.lat, LAX.lon);
    expect(excess).toBeGreaterThan(5000);
  });

  it('is small for a point mid-route', () => {
    // Midpoint of JFK-LAX, roughly over Kansas.
    const excess = corridorExcessKm(39.0, -96.0, JFK.lat, JFK.lon, LAX.lat, LAX.lon);
    expect(excess).toBeLessThan(200);
  });

  it('never returns negative', () => {
    expect(corridorExcessKm(JFK.lat, JFK.lon, BOS.lat, BOS.lon, LAX.lat, LAX.lon))
      .toBeGreaterThanOrEqual(0);
  });
});

describe('KM_PER_NM', () => {
  it('is the international nautical mile', () => {
    expect(KM_PER_NM).toBe(1.852);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && npm test
```

Expected: FAIL — `Cannot find module '../src/geo'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/geo.ts`:

```ts
// Pure geometry. No Workers APIs, no I/O — unit-tested with plain vitest.

/** Mean Earth radius (IUGG), km. */
export const R_KM = 6371.0088;

/** International nautical mile, km. */
export const KM_PER_NM = 1.852;

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/** Great-circle distance in km. */
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const p1 = toRad(aLat);
  const p2 = toRad(bLat);
  const dp = p2 - p1;
  // Taking the delta in degrees before converting keeps antimeridian
  // crossings correct: 179 -> -179 is -358 deg, whose sine is that of +2 deg.
  const dl = toRad(bLon - aLon);
  const h =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing, degrees clockwise from north, in [0, 360). */
export function bearingDeg(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const p1 = toRad(fromLat);
  const p2 = toRad(toLat);
  const dl = toRad(toLon - fromLon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * How far off the direct A->B path a point sits, in km: d(P,A) + d(P,B) - d(A,B).
 *
 * Zero on the route, large off it. This is the cheap test that catches a
 * geometrically impossible route claim — measured on live data, it rejected
 * 6 of 17 wrong destinations with zero false positives, including a flight
 * reported as SFO-LAX while physically over New York.
 *
 * It is a detour metric, NOT cross-track distance: a point beyond an endpoint
 * scores high, which is what we want (an aircraft 500 km past its claimed
 * destination is as suspect as one 500 km to the side).
 *
 * Clamped at zero — floating-point error can otherwise produce a tiny negative
 * for a point exactly on the path.
 */
export function corridorExcessKm(
  pLat: number, pLon: number,
  aLat: number, aLon: number,
  bLat: number, bLon: number,
): number {
  const legs = haversineKm(pLat, pLon, aLat, aLon) + haversineKm(pLat, pLon, bLat, bLon);
  return Math.max(0, legs - haversineKm(aLat, aLon, bLat, bLon));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && npm test && npx tsc --noEmit
```

Expected: all `geo` tests pass, `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/geo.ts server/test/geo.test.ts
git commit -m "feat(server): great-circle distance, bearing, corridor deviation

corridorExcessKm is the plausibility test: measured on live data it
rejected 6 of 17 wrong destinations with zero false positives."
```

---

### Task 3: ETA model

`distance / groundspeed` is optimistic by a roughly constant ~10 minutes at any range above the terminal area, because the aircraft always owes the same deceleration. That is 10% error on a transatlantic and 50% at 60 nm out — exactly where a viewer is watching.

**Files:**
- Create: `server/src/eta.ts`
- Create: `server/test/eta.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/eta.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { etaMinutes, formatEta, TERMINAL_NM, TERMINAL_KT, TERMINAL_MIN, LANDING_NM } from '../src/eta';

describe('etaMinutes', () => {
  it('uses current groundspeed above the terminal segment', () => {
    // 200nm at 450kt: (200-60)/450*60 = 18.67, + 18 terminal = 36.67
    expect(etaMinutes(200, 450)!).toBeCloseTo(36.67, 1);
  });

  it('adds a roughly constant terminal penalty over naive at cruise', () => {
    for (const [d, gs] of [[800, 470], [200, 450], [120, 400]] as const) {
      const naive = (d / gs) * 60;
      const diff = etaMinutes(d, gs)! - naive;
      expect(diff).toBeGreaterThan(8);
      expect(diff).toBeLessThan(11);
    }
  });

  it('switches to the nominal terminal profile inside the boundary', () => {
    // 25nm: 25/200*60 = 7.5, independent of current groundspeed.
    expect(etaMinutes(25, 220)!).toBeCloseTo(7.5, 3);
    expect(etaMinutes(25, 140)!).toBeCloseTo(7.5, 3);
  });

  it('is continuous at the boundary', () => {
    const inside = etaMinutes(TERMINAL_NM, 300)!;
    const outside = etaMinutes(TERMINAL_NM + 0.001, 300)!;
    expect(inside).toBeCloseTo(TERMINAL_MIN, 6);
    expect(Math.abs(outside - inside)).toBeLessThan(0.01);
  });

  it('converges with naive on short final, where groundspeed is representative', () => {
    // At 8nm/150kt the two models should be within a minute of each other.
    expect(Math.abs(etaMinutes(8, 150)! - (8 / 150) * 60)).toBeLessThan(1);
  });

  it('returns null when it cannot estimate', () => {
    expect(etaMinutes(200, 0)).toBeNull();
    expect(etaMinutes(200, -50)).toBeNull();
    expect(etaMinutes(NaN, 450)).toBeNull();
    expect(etaMinutes(200, NaN)).toBeNull();
    expect(etaMinutes(-5, 450)).toBeNull();
  });

  it('does not need groundspeed inside the terminal segment', () => {
    // Below the boundary the nominal profile carries it, so a missing or
    // zero groundspeed is still answerable.
    expect(etaMinutes(25, 0)).toBeCloseTo(7.5, 3);
  });
});

describe('formatEta', () => {
  it('shows LANDING inside the display threshold regardless of the number', () => {
    expect(formatEta(LANDING_NM - 1, 4)).toBe('LANDING');
    expect(formatEta(5, 2)).toBe('LANDING');
    expect(formatEta(5, null)).toBe('LANDING');
  });

  it('rounds to 5 minutes under an hour', () => {
    expect(formatEta(200, 23)).toBe('~25m');
    expect(formatEta(200, 22)).toBe('~20m');
    expect(formatEta(200, 37)).toBe('~35m');
  });

  it('rounds to 10 minutes at an hour and over, as h:mm', () => {
    expect(formatEta(800, 64)).toBe('~1h00');
    expect(formatEta(800, 66)).toBe('~1h10');
    expect(formatEta(800, 122)).toBe('~2h00');   // 122 -> 120
    expect(formatEta(800, 125)).toBe('~2h10');   // 125 -> 130, not 120
    expect(formatEta(800, 132)).toBe('~2h10');
  });

  it('returns null when there is no estimate and we are not landing', () => {
    expect(formatEta(200, null)).toBeNull();
  });

  it('never renders a bare zero', () => {
    // Rounding 2 minutes to the nearest 5 gives 0; at that range we are landing.
    expect(formatEta(200, 2)).toBe('~5m');
  });
});

describe('constants', () => {
  it('derive the terminal penalty from the profile rather than hardcoding it', () => {
    expect(TERMINAL_MIN).toBeCloseTo((TERMINAL_NM / TERMINAL_KT) * 60, 9);
    expect(TERMINAL_MIN).toBeCloseTo(18, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && npm test
```

Expected: FAIL — `Cannot find module '../src/eta'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/eta.ts`:

```ts
// Pure ETA model. No I/O.
//
// A naive distance/groundspeed is optimistic by a roughly CONSTANT ~10 minutes
// at any range above the terminal area, because the aircraft always owes the
// same deceleration whether it is 200 nm out or 800. Measured against the naive
// model:
//
//   phase                d(nm)  gs(kt)   naive    2-seg    diff
//   cruise, 800nm out      800     470  102.1m   112.5m  +10.3m
//   cruise, 200nm out      200     450   26.7m    36.7m  +10.0m
//   top of descent         120     400   18.0m    27.0m   +9.0m
//   descending              60     300   12.0m    18.0m   +6.0m
//   approach                25     220    6.8m     7.5m   +0.7m
//   final                    8     150    3.2m     2.4m   -0.8m
//
// That is a 10% error on a transatlantic and a 50% error at 60 nm out, which is
// exactly the range a viewer is watching.

/** Distance-to-go, in nm, below which we stop trusting current groundspeed. */
export const TERMINAL_NM = 60;

/** Nominal average groundspeed, kt, across the terminal segment. */
export const TERMINAL_KT = 200;

/** Minutes the terminal segment costs. Derived, not hardcoded. */
export const TERMINAL_MIN = (TERMINAL_NM / TERMINAL_KT) * 60;

/**
 * Distance-to-go, in nm, below which we show LANDING instead of a number.
 *
 * NOTE this is a DIFFERENT threshold from TERMINAL_NM and deliberately so.
 * TERMINAL_NM is where the MODEL changes; LANDING_NM is where the DISPLAY
 * stops claiming precision it does not have. The model still produces a value
 * inside 30 nm — we decline to show it.
 */
export const LANDING_NM = 30;

/**
 * Minutes remaining, or null if not estimable.
 *
 * Above TERMINAL_NM the aircraft's own groundspeed does the work — it is
 * genuinely accurate there. Below it groundspeed is already decaying, so the
 * nominal profile takes over and the current value is ignored. The halves meet
 * continuously at TERMINAL_MIN.
 */
export function etaMinutes(distanceNm: number, groundspeedKt: number): number | null {
  if (!Number.isFinite(distanceNm) || distanceNm < 0) return null;
  if (distanceNm <= TERMINAL_NM) return (distanceNm / TERMINAL_KT) * 60;
  if (!Number.isFinite(groundspeedKt) || groundspeedKt <= 0) return null;
  return ((distanceNm - TERMINAL_NM) / groundspeedKt) * 60 + TERMINAL_MIN;
}

/**
 * Display string, or null to show nothing.
 *
 * Rounded because the model does not support finer precision: it cannot know
 * about vectoring, holds, runway changes or taxi-in, so it lands within ~5 min
 * enroute and gets vaguer near the end. Always prefixed "~" so the panel never
 * implies a scheduled time.
 */
export function formatEta(distanceNm: number, etaMin: number | null): string | null {
  if (Number.isFinite(distanceNm) && distanceNm <= LANDING_NM) return 'LANDING';
  if (etaMin === null || !Number.isFinite(etaMin)) return null;

  if (etaMin < 60) {
    // Nearest 5, but never round down to a bare zero — outside LANDING_NM,
    // "~0m" would be both wrong and alarming.
    const m = Math.max(5, Math.round(etaMin / 5) * 5);
    return m >= 60 ? '~1h00' : `~${m}m`;
  }
  const total = Math.round(etaMin / 10) * 10;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `~${h}h${String(m).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && npm test && npx tsc --noEmit
```

Expected: all `eta` tests pass, `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/eta.ts server/test/eta.test.ts
git commit -m "feat(server): two-segment ETA model

Naive distance/groundspeed is optimistic by a near-constant ~10 min at
any cruise range, which is a 50% error at 60nm out. Model the last 60nm
at a nominal 200kt instead; the halves meet continuously at 18 minutes."
```

---

### Task 4: The join

The hard part. See "Correction to the spec" above for why `(operator, number)` cannot address a schedule row.

**Files:**
- Create: `server/src/join.ts`
- Create: `server/test/join.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/join.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { callsignKey, candidateCarriers, matchSchedule } from '../src/join';
import type { ScheduleRow } from '../src/types';

// Default row: CVG -> LGA. Both ends carry coordinates, because corridor
// deviation needs two points -- a row missing either end is rejected outright.
const row = (over: Partial<ScheduleRow>): ScheduleRow => ({
  carrierIata: 'DL', number: '5075', callsign: null,
  origIata: 'CVG', destIata: 'LGA',
  origLat: 39.0488, origLon: -84.6678,
  destLat: 40.7769, destLon: -73.8740,
  schedArrEpoch: null,
  ...over,
});

describe('callsignKey', () => {
  it('splits an airline callsign into operator and trailing digits', () => {
    expect(callsignKey('EDV5075')).toEqual({ operator: 'EDV', number: '5075' });
    expect(callsignKey('AAL166')).toEqual({ operator: 'AAL', number: '166' });
  });

  it('trims, uppercases, and strips leading zeros from the number', () => {
    expect(callsignKey('  edv0075 ')).toEqual({ operator: 'EDV', number: '75' });
  });

  it('rejects callsigns that do not end in digits', () => {
    // British Airways transmits BAW2LJ for flight BA1228 -- no derivable
    // relationship to the number. 7% of airline callsigns are this shape.
    expect(callsignKey('BAW2LJ')).toBeNull();
    expect(callsignKey('AFR53X')).toBeNull();
    expect(callsignKey('IBE03ZD')).toBeNull();
  });

  it('rejects non-airline shapes', () => {
    expect(callsignKey('N172SP')).toBeNull();  // tail number
    expect(callsignKey('')).toBeNull();
    expect(callsignKey('AA')).toBeNull();
  });
});

describe('candidateCarriers', () => {
  it('maps a mainline operator to its own IATA code', () => {
    expect(candidateCarriers('DAL')).toEqual(['DL']);
    expect(candidateCarriers('JBU')).toEqual(['B6']);
  });

  it('maps a single-partner regional to that partner', () => {
    expect(candidateCarriers('EDV')).toEqual(['DL']);
  });

  it('maps a multi-partner regional to every partner it flies for', () => {
    // Measured live: RPA -> AA three times and RPA -> DL twice in one sample.
    const rpa = candidateCarriers('RPA')!;
    expect(rpa).toContain('AA');
    expect(rpa).toContain('DL');
    expect(rpa).toContain('UA');
  });

  it('returns null for an unknown operator, meaning "do not constrain"', () => {
    expect(candidateCarriers('ZZZ')).toBeNull();
  });
});

describe('matchSchedule', () => {
  const pos = { lat: 40.75, lon: -73.9 };  // over NYC

  it('prefers an exact operating-callsign match and skips disambiguation', () => {
    const rows = [
      row({ carrierIata: 'AA', number: '5075', callsign: 'ENY5075', destIata: 'DFW',
            destLat: 32.8968, destLon: -97.0380 }),
      row({ carrierIata: 'DL', number: '5075', callsign: 'EDV5075' }),
    ];
    const m = matchSchedule('EDV5075', pos.lat, pos.lon, rows);
    expect(m?.destIata).toBe('LGA');
  });

  it('falls back to number + carrier candidates when no callsign is present', () => {
    const rows = [
      row({ carrierIata: 'AA', number: '5075', destIata: 'DFW',
            destLat: 32.8968, destLon: -97.0380 }),
      row({ carrierIata: 'DL', number: '5075' }),
    ];
    // EDV flies only for DL, so the AA row is excluded before geometry.
    expect(matchSchedule('EDV5075', pos.lat, pos.lon, rows)?.destIata).toBe('LGA');
  });

  it('uses geometry to break a tie the carrier set cannot', () => {
    // RPA flies for both AA and DL, so both rows survive the carrier filter.
    const rows = [
      row({ carrierIata: 'AA', number: '4426', origIata: 'LAX', destIata: 'SFO',
            origLat: 33.9416, origLon: -118.4085, destLat: 37.6188, destLon: -122.375 }),
      row({ carrierIata: 'DL', number: '4426', origIata: 'BOS', destIata: 'LGA',
            origLat: 42.3656, origLon: -71.0096 }),
    ];
    expect(matchSchedule('RPA4426', pos.lat, pos.lon, rows)?.destIata).toBe('LGA');
  });

  it('returns null rather than guessing when ambiguity survives', () => {
    // Two rows, both allowed carriers, both equally plausible geometrically.
    const rows = [
      row({ carrierIata: 'AA', number: '4426', destIata: 'LGA' }),
      row({ carrierIata: 'DL', number: '4426', destIata: 'LGA' }),
    ];
    // Same destination coords => identical geometry => cannot choose.
    expect(matchSchedule('RPA4426', pos.lat, pos.lon, rows)).toBeNull();
  });

  it('returns null when a known operator narrows to zero, rather than falling back to an unnarrowed collision', () => {
    // Regression case: the real flight is EDV5075 (Delta, operated by
    // Endeavor). Its DL row is missing from this fetch -- a data gap, not a
    // table gap. The only row sharing this bare number is an unrelated
    // WN5075 (Southwest, MDW -> LGA) collision that happens to be landing
    // right where the aircraft is. EDV's table entry is ['DL'], so this WN
    // row narrows to zero and must be rejected outright -- an earlier
    // version fell back to the unnarrowed set here and geometry accepted
    // the WN row, because corridor excess cannot tell two NYC-bound routes
    // apart when every board this Worker watches is NYC-area.
    const rows = [
      row({
        carrierIata: 'WN', number: '5075', origIata: 'MDW',
        origLat: 41.7868, origLon: -87.7522,
      }),
    ];
    expect(matchSchedule('EDV5075', pos.lat, pos.lon, rows)).toBeNull();
  });

  it('still falls through to geometry when the operator is entirely absent from the table', () => {
    // ZZZ has no entry in CARRIER_CANDIDATES at all, so candidateCarriers
    // returns null ("do not constrain") and the single row sharing this
    // number must be accepted on geometry alone. This is the fallback an
    // incomplete table is supposed to degrade into -- it must still work.
    const rows = [row({ carrierIata: 'XY', number: '2100' })];
    expect(matchSchedule('ZZZ2100', pos.lat, pos.lon, rows)?.carrierIata).toBe('XY');
  });

  it('rejects a row missing coordinates rather than trusting it unchecked', () => {
    const rows = [row({ origLat: null, origLon: null })];
    expect(matchSchedule('EDV5075', pos.lat, pos.lon, rows)).toBeNull();
  });

  it('returns null when no row matches the number', () => {
    expect(matchSchedule('DAL999', pos.lat, pos.lon, [row({})])).toBeNull();
  });

  it('returns null for an unjoinable callsign', () => {
    expect(matchSchedule('BAW2LJ', pos.lat, pos.lon, [row({})])).toBeNull();
  });

  it('rejects a match that is geometrically impossible', () => {
    // Aircraft over NYC, only candidate row is SFO-LAX. This is the real
    // SWA1304 case; blank beats a confident lie.
    const rows = [row({
      carrierIata: 'WN', number: '1304', origIata: 'SFO', destIata: 'LAX',
      origLat: 37.6188, origLon: -122.375, destLat: 33.9416, destLon: -118.4085,
    })];
    expect(matchSchedule('SWA1304', pos.lat, pos.lon, rows)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && npm test
```

Expected: FAIL — `Cannot find module '../src/join'` (and `../src/types`).

- [ ] **Step 3: Write the shared types**

Create `server/src/types.ts`:

```ts
/** One aircraft as reported by the position source, in source units. */
export interface Aircraft {
  hex: string;
  callsign: string;
  registration: string | null;
  typeIcao: string | null;
  lat: number;
  lon: number;
  altFt: number | null;
  groundspeedKt: number | null;
  trackDeg: number | null;
  verticalRateFpm: number | null;
  onGround: boolean;
  category: string | null;   // adsb.lol uses "A1".."A7"; A7 = rotorcraft
  distanceNm: number | null; // adsb.lol precomputes this ("dst")
  bearingDeg: number | null; // adsb.lol precomputes this ("dir")
}

/** One scheduled leg, as stored in KV. */
export interface ScheduleRow {
  /** Operating callsign, if the provider supplies it. Enables exact matching. */
  callsign: string | null;
  /** Marketing carrier IATA, e.g. "DL". */
  carrierIata: string;
  /** Flight number digits only, leading zeros stripped, e.g. "5075". */
  number: string;
  origIata: string | null;
  destIata: string | null;
  /**
   * BOTH ends need coordinates. matchSchedule measures how far off the
   * origin->destination corridor the aircraft sits, which needs two points; a
   * destination alone only answers "is it far away", which is not the same
   * question. A FIDS row supplies the far end, so the board's own airport
   * coordinates must be filled in for the near end.
   */
  origLat: number | null;
  origLon: number | null;
  destLat: number | null;
  destLon: number | null;
  /** Scheduled arrival, epoch seconds, for time disambiguation. */
  schedArrEpoch: number | null;
}

/** A display-ready flight, in the units the device renders. */
export interface Flight {
  cs: string;
  flt: string | null;
  al: string | null;
  reg: string | null;
  ac: string | null;
  from: string | null;
  to: string | null;
  alt: number | null;
  spd: number | null;
  hdg: number | null;
  vs: number | null;
  dst: number;
  brg: number;
  eta_min: number | null;
  eta_text: string | null;
  eta_src: 'physics' | null;
}
```

**Contract gap, found while wiring Plan 3's Task 6 (server dispatch), not fixed
here:** `Flight` carries no emitter category, so a server-sourced rotorcraft
can never set the firmware's `is_helicopter` — Area mode gets that from
`StateVector::category`, which this path bypasses entirely. `Aircraft.category`
above already holds the value adsb.lol sends (parsed in Task 6's
`adsblol.ts`); `enrich()` (Task 8) just never copies it onto the `Flight` it
returns. Whoever extends this contract: the fix is a passthrough field here
(e.g. `heli: boolean`), translating `Aircraft.category === 'A7'` the same way
the firmware's `AdsbLolFetcher` already does — not a new provider call. See
the design spec's Contract section for the full writeup.

- [ ] **Step 4: Write the join**

Create `server/src/join.ts`:

```ts
import { corridorExcessKm } from './geo';
import type { ScheduleRow } from './types';

/**
 * How far off a claimed route corridor an aircraft may sit before we treat the
 * row as impossible. 300 km caught 6 of 17 wrong destinations on live data
 * with zero false positives.
 */
export const MAX_CORRIDOR_EXCESS_KM = 300;

/** Minimum geometric separation, km, before we call one row a better fit. */
const TIEBREAK_MARGIN_KM = 50;

export interface CallsignKey {
  operator: string;
  number: string;
}

/**
 * Split an ADS-B callsign into its operator prefix and trailing flight number.
 *
 * The number must be a TRAILING digit run, not the first digits anywhere in the
 * string. Matching the first run instead mis-keys alphanumeric callsigns:
 * IBE03ZD would key as "3" and collide with everything.
 *
 * Returns null for shapes with no derivable flight number — tail numbers, and
 * the ~7% of airline callsigns that end in letters. British Airways transmits
 * BAW2LJ for flight BA1228; there is no relationship to recover.
 */
export function callsignKey(callsign: string): CallsignKey | null {
  const cs = callsign.trim().toUpperCase();
  if (!/^[A-Z]{3}\d/.test(cs)) return null;
  const m = /(\d+)$/.exec(cs);
  if (!m || !m[1]) return null;
  const number = m[1].replace(/^0+/, '') || '0';
  return { operator: cs.slice(0, 3), number };
}

/**
 * Which marketing carriers an operator's flights can be sold under.
 *
 * This exists because ADS-B carries the OPERATOR and a schedule row carries the
 * MARKETING CARRIER, and for regional-operated flights they differ. Measured on
 * live NYC traffic: the two agree for only 51% of flights.
 *
 * Single-partner regionals are safe to pin. Multi-partner ones are NOT — RPA was
 * observed flying as AA three times and DL twice in one sample — so they list
 * every partner and let geometry break the tie.
 *
 * null means "unknown operator, do not constrain" — geometry alone decides,
 * carrying whatever residual risk that already implies (see matchSchedule).
 *
 * A known operator is different: it can only ever narrow candidates, never
 * widen them, and matchSchedule returns null rather than widening back to the
 * unconstrained set when narrowing excludes everything. So an incomplete
 * table — missing an operator, or listing fewer carriers than it actually
 * flies for — degrades to more blanks, never to a wrong route.
 */
const CARRIER_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  // Mainline: operator is the carrier.
  AAL: ['AA'], DAL: ['DL'], UAL: ['UA'], JBU: ['B6'], SWA: ['WN'],
  ASA: ['AS'], NKS: ['NK'], FFT: ['F9'], HAL: ['HA'], AAY: ['G4'],
  // Single-partner regionals.
  EDV: ['DL'],                 // Endeavor Air -> Delta
  ENY: ['AA'],                 // Envoy Air -> American
  JIA: ['AA'],                 // PSA Airlines -> American
  PDT: ['AA'],                 // Piedmont -> American
  AWI: ['AA'],                 // Air Wisconsin -> American
  UCA: ['UA'],                 // CommuteAir -> United
  QXE: ['AS'],                 // Horizon Air -> Alaska
  // Multi-partner regionals: geometry must disambiguate.
  RPA: ['AA', 'DL', 'UA'],     // Republic
  SKW: ['AA', 'DL', 'UA', 'AS'], // SkyWest
  ASH: ['AA', 'UA'],           // Mesa
  GJS: ['UA', 'DL'],           // GoJet
};

export function candidateCarriers(operatorIcao: string): readonly string[] | null {
  return CARRIER_CANDIDATES[operatorIcao.toUpperCase()] ?? null;
}

/**
 * Find the schedule row for a live aircraft, or null.
 *
 * Order matters:
 *   1. Exact operating-callsign match, when the provider ships one. No
 *      ambiguity, no tables, nothing to get wrong.
 *   2. Otherwise: match the flight NUMBER, narrow by carrier candidates,
 *      then break any remaining tie geometrically.
 *
 * Ambiguity that survives all of it returns null. On a 64px panel a blank
 * route is strictly better than a confident wrong city.
 */
export function matchSchedule(
  callsign: string,
  lat: number,
  lon: number,
  rows: readonly ScheduleRow[],
): ScheduleRow | null {
  const cs = callsign.trim().toUpperCase();

  // 1. Exact match on the operating callsign.
  const exact = rows.filter((r) => r.callsign && r.callsign.trim().toUpperCase() === cs);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null; // provider gave us duplicates; do not guess

  // 2. Number, then carrier, then geometry.
  const key = callsignKey(cs);
  if (!key) return null;

  let candidates = rows.filter((r) => r.number === key.number);
  if (candidates.length === 0) return null;

  const allowed = candidateCarriers(key.operator);
  if (allowed) {
    // A known operator is positive information, not a hint: we know every
    // carrier it can fly for, and none of the rows sharing this number
    // belong to one of them. That means the true row is simply missing from
    // this fetch -- a same-number collision with an unrelated carrier is not
    // a substitute for it, and geometry cannot be trusted to catch the
    // substitution: every board this Worker watches is NYC-area, so a wrong
    // NYC-bound row often sits just as close to the corridor as the right
    // one. (This is how EDV5075, its real DL row missing from the fetch,
    // used to lock onto an unrelated WN5075 MDW-LGA row -- corridor excess
    // was measured against geometrically *impossible* routes like SFO-LAX
    // seen over New York, never against two equally plausible NYC-bound
    // ones.) No candidate survives narrowing -> no route, full stop.
    candidates = candidates.filter((r) => allowed.includes(r.carrierIata));
    if (candidates.length === 0) return null;
  }

  const scored = candidates
    .map((r) => ({ row: r, excess: excessFor(r, lat, lon) }))
    .filter((c) => c.excess !== null && c.excess <= MAX_CORRIDOR_EXCESS_KM)
    .sort((a, b) => a.excess! - b.excess!);

  if (scored.length === 0) return null;
  if (scored.length === 1) return scored[0]!.row;

  // Two or more plausible rows: only choose if one is clearly the better fit.
  const [best, next] = scored;
  return next!.excess! - best!.excess! >= TIEBREAK_MARGIN_KM ? best!.row : null;
}

/**
 * Corridor deviation for a row, or null when the row lacks the coordinates to
 * judge it. A row we cannot check is not a row we should trust — returning null
 * drops it from consideration rather than letting it through unchecked.
 */
function excessFor(r: ScheduleRow, lat: number, lon: number): number | null {
  if (r.destLat === null || r.destLon === null) return null;
  if (r.origLat === null || r.origLon === null) return null;
  return corridorExcessKm(lat, lon, r.origLat, r.origLon, r.destLat, r.destLon);
}
```

**Found during implementation:** the first version of the narrowing step let a
known operator fall back to the unnarrowed candidate set when its carrier
list excluded every row, on the theory that "the table is wrong for this
flight, not the schedule." That was wrong, and it shipped a real defect:
EDV5075 (Delta, operated by Endeavor), with its true DL row missing from the
fetch, locked onto an unrelated WN5075 (Southwest, MDW-LGA) bare-number
collision row instead, because corridor excess passed it. The 300 km
corridor check was measured against geometrically *impossible* routes
(SFO-LAX seen over New York) — it was never going to discriminate between
two plausible NYC-bound ones, and every board this Worker watches is
NYC-area. Fixed below: a known operator that narrows to zero returns null.
Only a genuinely unknown operator (absent from `CARRIER_CANDIDATES`) falls
through to unconstrained geometry. Both the code and the test file above
already reflect the fix; see the `join.ts` commit history for the correction
commit.

- [ ] **Step 5: Run tests until green**

```bash
cd server && npm test && npx tsc --noEmit
```

Expected: all `join` tests pass. If the "returns null rather than guessing" test is hard to satisfy alongside the geometry test, re-read `TIEBREAK_MARGIN_KM` — two rows with identical destination coordinates must score identically and therefore tie.

- [ ] **Step 6: Commit**

```bash
git add server/src/join.ts server/src/types.ts server/test/join.test.ts
git commit -m "feat(server): callsign-to-schedule join

ADS-B carries the OPERATOR (EDV5075); a schedule row carries the
MARKETING CARRIER (DL5075). Measured live, they agree for only 51% of
flights, so the composite key in the design spec cannot address a
schedule row for the other 49%.

Prefer an exact operating-callsign match when the provider ships one.
Otherwise match the number, narrow by which carriers the operator
actually flies for, and break ties geometrically. Surviving ambiguity
returns null -- blank beats a confident wrong city."
```

---

### Task 5: Airline display names

**Files:**
- Create: `server/src/airlines.ts`
- Create: `server/test/airlines.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/airlines.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { airlineName } from '../src/airlines';

describe('airlineName', () => {
  it('resolves a marketing carrier to its display name', () => {
    expect(airlineName('DL')).toBe('Delta');
    expect(airlineName('AA')).toBe('American');
    expect(airlineName('B6')).toBe('JetBlue');
  });

  it('is case-insensitive and trims', () => {
    expect(airlineName(' dl ')).toBe('Delta');
  });

  it('returns null for an unknown code so the caller can fall back', () => {
    expect(airlineName('ZZ')).toBeNull();
    expect(airlineName('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && npm test
```

Expected: FAIL — `Cannot find module '../src/airlines'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/airlines.ts`:

```ts
/**
 * Marketing carrier IATA -> display name.
 *
 * Keyed by the MARKETING carrier from the schedule row, not by the ADS-B
 * callsign prefix. That distinction is the whole point: a callsign-prefix table
 * renders EDV5075 as "Endeavor Air" when the flight is sold as Delta, and it
 * structurally cannot do better, because RPA flies for American and Delta both.
 *
 * Names are deliberately short — the panel is 64px wide.
 *
 * Unknown codes return null; the caller shows the bare code, which is honest
 * and self-correcting once an entry is added.
 */
const NAMES: Readonly<Record<string, string>> = {
  AA: 'American', DL: 'Delta', UA: 'United', B6: 'JetBlue', WN: 'Southwest',
  AS: 'Alaska', NK: 'Spirit', F9: 'Frontier', HA: 'Hawaiian', G4: 'Allegiant',
  AC: 'Air Canada', BA: 'British Airways', VS: 'Virgin Atlantic',
  LH: 'Lufthansa', AF: 'Air France', KL: 'KLM', IB: 'Iberia', EI: 'Aer Lingus',
  EK: 'Emirates', QR: 'Qatar', EY: 'Etihad', TK: 'Turkish', SQ: 'Singapore',
  NH: 'ANA', JL: 'JAL', QF: 'Qantas', AM: 'Aeromexico', AV: 'Avianca',
  LA: 'LATAM', CM: 'Copa', TP: 'TAP', SK: 'SAS', AY: 'Finnair', LX: 'SWISS',
  OS: 'Austrian', SN: 'Brussels', AZ: 'ITA', VY: 'Vueling', FR: 'Ryanair',
  U2: 'easyJet', WS: 'WestJet', PD: 'Porter', FX: 'FedEx', '5X': 'UPS',
};

export function airlineName(carrierIata: string): string | null {
  return NAMES[carrierIata.trim().toUpperCase()] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && npm test && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add server/src/airlines.ts server/test/airlines.test.ts
git commit -m "feat(server): marketing-carrier display names

Keyed by the schedule row's marketing carrier, not the ADS-B callsign
prefix -- a prefix table cannot render EDV5075 as Delta, and cannot
resolve RPA at all since it flies for both American and Delta."
```

---

### Task 6: adsb.lol position client

**Files:**
- Create: `server/src/adsblol.ts`
- Create: `server/test/adsblol.test.ts`
- Create: `server/fixtures/adsblol-jfk.json`

- [ ] **Step 1: Record a fixture**

```bash
curl -s "https://api.adsb.lol/v2/lat/40.64/lon/-73.78/dist/60" \
  -o server/fixtures/adsblol-jfk.json
python3 -c "
import json; d=json.load(open('server/fixtures/adsblol-jfk.json'))
print('aircraft:', len(d['ac']))
print('sample:', json.dumps(d['ac'][0], indent=1)[:400])
"
```

Expected: 100+ aircraft, each with `hex`, `flight`, `r`, `t`, `alt_baro`, `gs`, `track`, `lat`, `lon`, `dst`, `dir`.

- [ ] **Step 2: Write the failing test**

Create `server/test/adsblol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAdsbLol } from '../src/adsblol';

const raw = JSON.parse(readFileSync(new URL('../fixtures/adsblol-jfk.json', import.meta.url), 'utf8'));

describe('parseAdsbLol', () => {
  const aircraft = parseAdsbLol(raw);

  it('parses every aircraft that has a position', () => {
    expect(aircraft.length).toBeGreaterThan(50);
    for (const a of aircraft) {
      expect(Number.isFinite(a.lat)).toBe(true);
      expect(Number.isFinite(a.lon)).toBe(true);
    }
  });

  it('trims the callsign', () => {
    for (const a of aircraft) expect(a.callsign).toBe(a.callsign.trim());
  });

  it('carries registration and type inline, so no per-flight lookup is needed', () => {
    const withType = aircraft.filter((a) => a.typeIcao);
    const withReg = aircraft.filter((a) => a.registration);
    expect(withType.length / aircraft.length).toBeGreaterThan(0.8);
    expect(withReg.length / aircraft.length).toBeGreaterThan(0.8);
  });

  it('carries precomputed distance and bearing', () => {
    const withDst = aircraft.filter((a) => a.distanceNm !== null);
    expect(withDst.length / aircraft.length).toBeGreaterThan(0.9);
  });

  it('treats a ground-string altitude as on-ground rather than NaN', () => {
    // adsb.lol reports alt_baro as the string "ground" for surface aircraft.
    const parsed = parseAdsbLol({ ac: [{ hex: 'abc123', flight: 'TEST1 ', lat: 40, lon: -73, alt_baro: 'ground' }] });
    expect(parsed[0]!.onGround).toBe(true);
    expect(parsed[0]!.altFt).toBeNull();
  });

  it('drops rows with no position', () => {
    const parsed = parseAdsbLol({ ac: [{ hex: 'abc123', flight: 'TEST1' }] });
    expect(parsed).toHaveLength(0);
  });

  it('survives a malformed payload without throwing', () => {
    expect(parseAdsbLol({})).toEqual([]);
    expect(parseAdsbLol({ ac: null })).toEqual([]);
  });

  it('degrades a wrong-typed string field to empty/null instead of throwing', () => {
    // hex/flight/r/t/category are declared as strings but nothing guarantees
    // that at runtime -- an upstream schema change could ship any of them as
    // a number or boolean. A bad field must not crash the row.
    const base = { hex: 'abc123', flight: 'TEST1', lat: 40, lon: -73 };
    expect(() => parseAdsbLol({ ac: [{ ...base, r: 12345 }] })).not.toThrow();
    expect(() => parseAdsbLol({ ac: [{ ...base, t: 12345 }] })).not.toThrow();
    expect(() => parseAdsbLol({ ac: [{ ...base, category: true }] })).not.toThrow();
    expect(() => parseAdsbLol({ ac: [{ ...base, hex: 999 }] })).not.toThrow();
    expect(() => parseAdsbLol({ ac: [{ ...base, flight: 12345 }] })).not.toThrow();

    expect(parseAdsbLol({ ac: [{ ...base, r: 12345 }] })[0]!.registration).toBeNull();
    expect(parseAdsbLol({ ac: [{ ...base, t: 12345 }] })[0]!.typeIcao).toBeNull();
    expect(parseAdsbLol({ ac: [{ ...base, category: true }] })[0]!.category).toBeNull();
    expect(parseAdsbLol({ ac: [{ ...base, hex: 999 }] })[0]!.hex).toBe('');
    expect(parseAdsbLol({ ac: [{ ...base, flight: 12345 }] })[0]!.callsign).toBe('');
  });

  it('degrades only the malformed row, not the whole batch', () => {
    // Partial degradation is the point: one bad row from an upstream schema
    // change must not blank out every other aircraft in the same response.
    const parsed = parseAdsbLol({
      ac: [
        { hex: 'aaa111', flight: 'GOOD1', r: 'N123AB', t: 'B738', lat: 40.1, lon: -73.1 },
        { hex: 'bbb222', flight: 'BAD1', r: 12345, t: true, category: 42, lat: 40.2, lon: -73.2 },
        { hex: 'ccc333', flight: 'GOOD2', r: 'N456CD', t: 'A320', lat: 40.3, lon: -73.3 },
      ],
    });

    expect(parsed).toHaveLength(3);
    expect(parsed.map((a) => a.callsign)).toEqual(['GOOD1', 'BAD1', 'GOOD2']);

    const [good1, bad, good2] = parsed;
    expect(good1!.registration).toBe('N123AB');
    expect(good1!.typeIcao).toBe('B738');
    expect(bad!.registration).toBeNull();
    expect(bad!.typeIcao).toBeNull();
    expect(bad!.category).toBeNull();
    expect(good2!.registration).toBe('N456CD');
    expect(good2!.typeIcao).toBe('A320');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd server && npm test
```

Expected: FAIL — `Cannot find module '../src/adsblol'`.

- [ ] **Step 4: Write the implementation**

Create `server/src/adsblol.ts`:

```ts
import type { Aircraft } from './types';

const BASE = 'https://api.adsb.lol';

/** adsb.lol's raw row shape. Every field is optional in practice. */
interface RawAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | string;   // "ground" for surface aircraft
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  geom_rate?: number;
  category?: string;
  dst?: number;                 // nm from the query point, precomputed
  dir?: number;                 // bearing from the query point, precomputed
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Parse an adsb.lol /v2 response.
 *
 * Rows carry registration (`r`), ICAO type (`t`), and precomputed distance and
 * bearing (`dst`/`dir`) inline — which is why this source removes the per-flight
 * aircraft lookup entirely rather than just replacing the position feed.
 *
 * Never throws, at the payload level or the row level. A row with a
 * wrong-typed field (`t` arriving as a number, say) degrades just that field
 * to empty/null rather than losing the row or the request. That distinction
 * matters downstream: a thrown error fails the whole fetch, which the device
 * treats as "keep showing the last flights" — survivable. An empty list looks
 * like a successful fetch of an empty sky, which blanks the display instead.
 * One malformed row must not manufacture either outcome for every aircraft
 * riding along in the same response.
 */
export function parseAdsbLol(body: unknown): Aircraft[] {
  const rows = (body as { ac?: unknown })?.ac;
  if (!Array.isArray(rows)) return [];

  const out: Aircraft[] = [];
  for (const r of rows as RawAircraft[]) {
    const lat = num(r?.lat);
    const lon = num(r?.lon);
    if (lat === null || lon === null) continue;

    // alt_baro is the string "ground" for surface aircraft, not a number.
    const onGround = r.alt_baro === 'ground';
    const altFt = onGround ? null : num(r.alt_baro) ?? num(r.alt_geom);

    out.push({
      hex: str(r.hex).toLowerCase(),
      callsign: str(r.flight),
      registration: str(r.r) || null,
      typeIcao: str(r.t) || null,
      lat,
      lon,
      altFt,
      groundspeedKt: num(r.gs),
      trackDeg: num(r.track),
      verticalRateFpm: num(r.baro_rate) ?? num(r.geom_rate),
      onGround,
      category: str(r.category) || null,
      distanceNm: num(r.dst),
      bearingDeg: num(r.dir),
    });
  }
  return out;
}

/** Fetch live aircraft within `radiusNm` of a point. Throws on transport failure. */
export async function fetchAircraft(lat: number, lon: number, radiusNm: number): Promise<Aircraft[]> {
  const url = `${BASE}/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${Math.round(radiusNm)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'flightwall-server/1.0 (+https://github.com/)' },
  });
  if (!res.ok) throw new Error(`adsb.lol ${res.status}`);
  return parseAdsbLol(await res.json());
}
```

**Defect this plan originally shipped:** the first draft of this Step used
`r.r?.trim()` (and the equivalent for `hex`/`flight`/`t`/`category`), which
guards only `null`/`undefined` — a row where any of those five fields arrives
as a number or boolean (a plausible upstream schema change, not just a
theoretical one) threw a `TypeError` and, per Task 9's handler contract, would
have failed the *entire* fetch over one bad row. The top-level malformed-payload
test above did not catch this because it only exercises payload shape, never
per-row field types. The `str()` helper above and the two tests covering it
(the wrong-typed-field case and the mixed-batch case) are the fix; keep both
if re-running this task.

- [ ] **Step 5: Run tests**

```bash
cd server && npm test && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add server/src/adsblol.ts server/test/adsblol.test.ts server/fixtures/adsblol-jfk.json
git commit -m "feat(server): adsb.lol position client

Rows carry registration, ICAO type and precomputed distance/bearing
inline, so this replaces both the position feed and the per-flight
aircraft lookup. No key, no rate limit observed over ~150 requests."
```

---

### Task 7: Schedule fetch and KV store

**Files:**
- Create: `server/src/schedule/aerodatabox.ts`
- Create: `server/src/schedule/store.ts`
- Create: `server/test/schedule.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/schedule.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFids } from '../src/schedule/aerodatabox';
import { indexRows, lookupRows, lookupByCallsign, STALE_AFTER_MS } from '../src/schedule/store';
import type { ScheduleRow } from '../src/types';

const raw = JSON.parse(readFileSync(new URL('../fixtures/fids-kjfk.json', import.meta.url), 'utf8'));

describe('parseFids', () => {
  const rows = parseFids(raw, 'KJFK');

  it('produces rows with a number and a carrier', () => {
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      expect(r.number).toMatch(/^\d+$/);
      expect(r.carrierIata.length).toBeGreaterThan(0);
    }
  });

  it('strips leading zeros from the number so it matches a callsign suffix', () => {
    for (const r of rows) expect(r.number).not.toMatch(/^0/);
  });

  it('records whether the provider supplied an operating callsign', () => {
    // Not an assertion about the answer -- Task 1 settles that. This just
    // pins that we surface it rather than silently dropping it.
    for (const r of rows) {
      expect(r.callsign === null || typeof r.callsign === 'string').toBe(true);
    }
  });

  it('never throws on a malformed payload', () => {
    expect(parseFids({}, 'KJFK')).toEqual([]);
    expect(parseFids({ arrivals: null }, 'KJFK')).toEqual([]);
  });
});

describe('indexRows / lookupRows', () => {
  const rows: ScheduleRow[] = [
    { callsign: null, carrierIata: 'DL', number: '5075', origIata: 'CVG', destIata: 'LGA',
      origLat: 39.0, origLon: -84.7, destLat: 40.78, destLon: -73.87, schedArrEpoch: null },
    { callsign: null, carrierIata: 'AA', number: '5075', origIata: 'DFW', destIata: 'JFK',
      origLat: 32.9, origLon: -97.0, destLat: 40.64, destLon: -73.78, schedArrEpoch: null },
    { callsign: null, carrierIata: 'UA', number: '1630', origIata: 'ORD', destIata: 'EWR',
      origLat: 41.98, origLon: -87.9, destLat: 40.69, destLon: -74.17, schedArrEpoch: null },
  ];

  it('groups rows by flight number', () => {
    const idx = indexRows(rows);
    expect(lookupRows(idx, '5075')).toHaveLength(2);
    expect(lookupRows(idx, '1630')).toHaveLength(1);
    expect(lookupRows(idx, '9999')).toHaveLength(0);
  });

  it('round-trips through JSON, since KV stores strings', () => {
    const idx = indexRows(rows);
    const revived = JSON.parse(JSON.stringify(idx));
    expect(lookupRows(revived, '5075')).toHaveLength(2);
  });

  it('leaves byCallsign empty when no row carries one, without throwing', () => {
    // This is the state Task 1 may well have found. It must degrade to the
    // number path, not blow up.
    const idx = indexRows(rows);
    expect(Object.keys(idx.byCallsign)).toHaveLength(0);
    expect(lookupByCallsign(idx, 'EDV5075')).toEqual([]);
  });

  it('declares a staleness window longer than the refresh interval', () => {
    // Cron runs every 6h; the table must not read as stale between runs.
    expect(STALE_AFTER_MS).toBeGreaterThan(6 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && npm test
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Write the FIDS client**

Create `server/src/schedule/aerodatabox.ts`. **Adapt the field paths to the fixture you captured in Task 1** — AeroDataBox's response shape differs between the direct, RapidAPI and API.market surfaces, so read `server/fixtures/fids-kjfk.json` and map from what is actually there rather than from this sketch:

```ts
import type { ScheduleRow } from '../types';

/**
 * Parse an AeroDataBox FIDS response into schedule rows.
 *
 * A FIDS call returns both directions when asked. For an ARRIVAL the movement's
 * own airport is the destination; for a DEPARTURE it is the origin, and
 * `withLeg=true` supplies the far end.
 *
 * Never throws: a malformed payload yields an empty list, and the caller keeps
 * the previous table rather than blanking every route.
 */
export function parseFids(body: unknown, airportIcao: string): ScheduleRow[] {
  const b = body as { arrivals?: unknown; departures?: unknown };
  const out: ScheduleRow[] = [];
  collect(b?.arrivals, airportIcao, 'arrival', out);
  collect(b?.departures, airportIcao, 'departure', out);
  return out;
}

function collect(list: unknown, airportIcao: string, dir: 'arrival' | 'departure', out: ScheduleRow[]): void {
  if (!Array.isArray(list)) return;
  for (const m of list as Record<string, any>[]) {
    const flightNo: string = (m?.number ?? '').toString().replace(/\s+/g, '');
    const digits = /(\d+)$/.exec(flightNo)?.[1];
    if (!digits) continue;
    const carrier: string = (m?.airline?.iata ?? flightNo.slice(0, flightNo.length - digits.length)) || '';
    if (!carrier) continue;

    const far = m?.movement?.airport;
    const isArrival = dir === 'arrival';
    out.push({
      // Present only if the provider ships it. Task 1 determines whether it does.
      callsign: (m?.callSign ?? m?.callsign ?? null) || null,
      carrierIata: carrier.toUpperCase(),
      number: digits.replace(/^0+/, '') || '0',
      origIata: isArrival ? far?.iata ?? null : null,
      destIata: isArrival ? null : far?.iata ?? null,
      origLat: isArrival ? num(far?.location?.lat) : null,
      origLon: isArrival ? num(far?.location?.lon) : null,
      destLat: isArrival ? null : num(far?.location?.lat),
      destLon: isArrival ? null : num(far?.location?.lon),
      schedArrEpoch: epoch(m?.movement?.scheduledTime?.utc),
    });
  }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const epoch = (s: unknown): number | null => {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};
```

`parseFids` above leaves one end of each leg without coordinates: an arrival row
knows its *origin* but its destination is the board's own airport, and a departure
row is the reverse. `matchSchedule` needs BOTH ends, so fill the near end from a
fixed table of the four board airports.

Add to `server/src/schedule/aerodatabox.ts`:

```ts
/**
 * Coordinates for the boards we poll. Fixed, public, and small enough to inline
 * — a FIDS row never carries its own airport's position, only the far end's.
 */
const BOARD_AIRPORTS: Readonly<Record<string, { iata: string; lat: number; lon: number }>> = {
  KJFK: { iata: 'JFK', lat: 40.6413, lon: -73.7781 },
  KLGA: { iata: 'LGA', lat: 40.7769, lon: -73.8740 },
  KEWR: { iata: 'EWR', lat: 40.6895, lon: -74.1745 },
  KBOS: { iata: 'BOS', lat: 42.3656, lon: -71.0096 },
};
```

and rewrite `collect` so the board airport supplies the missing end:

```ts
function collect(list: unknown, airportIcao: string, dir: 'arrival' | 'departure', out: ScheduleRow[]): void {
  if (!Array.isArray(list)) return;
  const self = BOARD_AIRPORTS[airportIcao.toUpperCase()];
  if (!self) return; // a board we have no coordinates for cannot be checked

  for (const m of list as Record<string, any>[]) {
    const flightNo: string = (m?.number ?? '').toString().replace(/\s+/g, '');
    const digits = /(\d+)$/.exec(flightNo)?.[1];
    if (!digits) continue;
    const carrier: string =
      (m?.airline?.iata ?? flightNo.slice(0, flightNo.length - digits.length)) || '';
    if (!carrier) continue;

    const far = m?.movement?.airport;
    const farLat = num(far?.location?.lat);
    const farLon = num(far?.location?.lon);
    const farIata: string | null = far?.iata ?? null;
    const isArrival = dir === 'arrival';

    out.push({
      callsign: (m?.callSign ?? m?.callsign ?? null) || null,
      carrierIata: carrier.toUpperCase(),
      number: digits.replace(/^0+/, '') || '0',
      // Arrival: the far end is where it came FROM, we are the destination.
      // Departure: the far end is where it is going TO, we are the origin.
      origIata: isArrival ? farIata : self.iata,
      origLat:  isArrival ? farLat  : self.lat,
      origLon:  isArrival ? farLon  : self.lon,
      destIata: isArrival ? self.iata : farIata,
      destLat:  isArrival ? self.lat  : farLat,
      destLon:  isArrival ? self.lon  : farLon,
      schedArrEpoch: epoch(m?.movement?.scheduledTime?.utc),
    });
  }
}
```

Add a test pinning the asymmetry — it is the single easiest thing in this plan to get backwards, and getting it backwards produces routes that are exactly reversed:

```ts
it('puts the board airport on the correct end for each direction', () => {
  const arr = parseFids({ arrivals: [{ number: 'DL 5075',
    movement: { airport: { iata: 'CVG', location: { lat: 39.0488, lon: -84.6678 } } } }] }, 'KJFK');
  expect(arr[0]!.origIata).toBe('CVG');
  expect(arr[0]!.destIata).toBe('JFK');

  const dep = parseFids({ departures: [{ number: 'DL 5076',
    movement: { airport: { iata: 'CVG', location: { lat: 39.0488, lon: -84.6678 } } } }] }, 'KJFK');
  expect(dep[0]!.origIata).toBe('JFK');
  expect(dep[0]!.destIata).toBe('CVG');
});
```

Also add the fetch wrapper:

```ts
/** Fetch one board's arrivals + departures. Throws on transport failure. */
export async function fetchBoard(icao: string, apiKey: string): Promise<ScheduleRow[]> {
  const now = new Date();
  const from = new Date(now.getTime() - 2 * 3600_000).toISOString().slice(0, 16);
  const to = new Date(now.getTime() + 10 * 3600_000).toISOString().slice(0, 16);
  const url = `https://aerodatabox.p.rapidapi.com/flights/airports/icao/${icao}/${from}/${to}`
    + `?withLeg=true&direction=Both&withCancelled=false&withCodeshared=false`;
  const res = await fetch(url, { headers: { 'x-rapidapi-key': apiKey } });
  if (!res.ok) throw new Error(`aerodatabox ${icao} ${res.status}`);
  return parseFids(await res.json(), icao);
}
```

**Adapt the host and auth header to whichever AeroDataBox surface your key is for** — direct, RapidAPI, or API.market differ. The 12-hour window (2h back, 10h forward) matters: flights already airborne departed in the past, so a forward-only window misses exactly the aircraft overhead right now.

- [ ] **Step 4: Write the KV store**

Create `server/src/schedule/store.ts`:

```ts
import type { ScheduleRow } from '../types';

export const KV_KEY = 'schedule:v1';

/**
 * How old the table may be before responses are flagged stale.
 *
 * Longer than the 6h cron interval, deliberately: one missed refresh should not
 * flag every response. Route data is stable day-to-day (measured 94-100%), so a
 * table a few hours old is still correct — it is a table days old that isn't.
 */
export const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

/**
 * Two indexes over the same rows.
 *
 * `byNumber` is the one that always works: the flight number is the only key
 * both sides share, because ADS-B carries the operator and a schedule row
 * carries the marketing carrier.
 *
 * `byCallsign` is populated only when the provider ships an operating callsign.
 * When it is, it is strictly better — an exact match needs no disambiguation,
 * and it is the only way to join the ~7% of airline callsigns that end in
 * letters (BAW2LJ for BA1228) and so have no derivable number at all.
 */
export interface ScheduleIndex {
  byNumber: Record<string, ScheduleRow[]>;
  byCallsign: Record<string, ScheduleRow[]>;
}

export interface StoredSchedule {
  builtAtMs: number;
  index: ScheduleIndex;
}

export function indexRows(rows: readonly ScheduleRow[]): ScheduleIndex {
  const idx: ScheduleIndex = { byNumber: {}, byCallsign: {} };
  for (const r of rows) {
    (idx.byNumber[r.number] ??= []).push(r);
    if (r.callsign) (idx.byCallsign[r.callsign.trim().toUpperCase()] ??= []).push(r);
  }
  return idx;
}

export function lookupRows(idx: ScheduleIndex, number: string): ScheduleRow[] {
  return idx.byNumber[number] ?? [];
}

export function lookupByCallsign(idx: ScheduleIndex, callsign: string): ScheduleRow[] {
  return idx.byCallsign[callsign.trim().toUpperCase()] ?? [];
}

export async function saveSchedule(kv: KVNamespace, rows: readonly ScheduleRow[], nowMs: number): Promise<void> {
  const payload: StoredSchedule = { builtAtMs: nowMs, index: indexRows(rows) };
  await kv.put(KV_KEY, JSON.stringify(payload));
}

export async function loadSchedule(kv: KVNamespace): Promise<StoredSchedule | null> {
  return await kv.get<StoredSchedule>(KV_KEY, 'json');
}

export function isStale(s: StoredSchedule | null, nowMs: number): boolean {
  return s === null || nowMs - s.builtAtMs > STALE_AFTER_MS;
}
```

- [ ] **Step 5: Run tests until green**

```bash
cd server && npm test && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add server/src/schedule server/test/schedule.test.ts
git commit -m "feat(server): AeroDataBox FIDS parse and KV schedule store

Indexed by flight number, since that is the only key both sides share.
Staleness window is longer than the cron interval so one missed refresh
does not flag every response."
```

---

### Task 8: Enrichment

Combine one aircraft plus the schedule into a display-ready flight.

**Files:**
- Create: `server/src/enrich.ts`
- Create: `server/test/enrich.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/enrich.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { enrich } from '../src/enrich';
import type { Aircraft, ScheduleRow } from '../src/types';

const LGA = { lat: 40.7769, lon: -73.8740 };

const ac = (over: Partial<Aircraft> = {}): Aircraft => ({
  hex: 'a19357', callsign: 'EDV5075', registration: 'N914XJ', typeIcao: 'CRJ9',
  lat: 41.5, lon: -74.5, altFt: 18000, groundspeedKt: 400, trackDeg: 120,
  verticalRateFpm: -1200, onGround: false, category: 'A3',
  distanceNm: 60, bearingDeg: 210, ...over,
});

const sched: ScheduleRow[] = [{
  callsign: null, carrierIata: 'DL', number: '5075',
  origIata: 'CVG', destIata: 'LGA',
  origLat: 39.0488, origLon: -84.6678, destLat: LGA.lat, destLon: LGA.lon,
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
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

Create `server/src/enrich.ts`:

```ts
import { haversineKm, bearingDeg, KM_PER_NM } from './geo';
import { etaMinutes, formatEta } from './eta';
import { matchSchedule } from './join';
import { airlineName } from './airlines';
import type { Aircraft, Flight, ScheduleRow } from './types';

export interface EnrichOptions {
  units: 'imperial' | 'metric';
  /** Used only when the position feed did not precompute distance/bearing. */
  centerLat?: number;
  centerLon?: number;
}

const FT_PER_M = 3.28084;
const KMH_PER_KT = 1.852;

/**
 * One aircraft plus the schedule -> one display-ready flight, or null to drop it.
 *
 * A schedule miss is NOT a failure: the flight still renders with its callsign,
 * position and live metrics, just without a route. That is the whole design
 * stance — blank beats a confident wrong city on a 64px panel.
 */
export function enrich(a: Aircraft, rows: readonly ScheduleRow[], opts: EnrichOptions): Flight | null {
  const cs = a.callsign.trim();
  if (!cs) return null; // no identity, not worth a slot

  const row = matchSchedule(cs, a.lat, a.lon, rows);

  let etaMin: number | null = null;
  let etaText: string | null = null;
  if (row && row.destLat !== null && row.destLon !== null) {
    const nm = haversineKm(a.lat, a.lon, row.destLat, row.destLon) / KM_PER_NM;
    etaMin = etaMinutes(nm, a.groundspeedKt ?? Number.NaN);
    etaText = formatEta(nm, etaMin);
  }

  // Prefer the feed's precomputed values; adsb.lol ships both, so this
  // fallback is for sources that don't.
  let dstNm = a.distanceNm;
  let brg = a.bearingDeg;
  if (opts.centerLat !== undefined && opts.centerLon !== undefined) {
    if (dstNm === null) dstNm = haversineKm(opts.centerLat, opts.centerLon, a.lat, a.lon) / KM_PER_NM;
    if (brg === null) brg = bearingDeg(opts.centerLat, opts.centerLon, a.lat, a.lon);
  }

  const metric = opts.units === 'metric';
  const round = (v: number | null): number | null => (v === null ? null : Math.round(v));

  return {
    cs,
    flt: row ? `${row.carrierIata}${row.number}` : null,
    al: row ? airlineName(row.carrierIata) ?? row.carrierIata : null,
    reg: a.registration,
    ac: a.typeIcao,
    from: row?.origIata ?? null,
    to: row?.destIata ?? null,
    alt: round(a.altFt === null ? null : metric ? a.altFt / FT_PER_M : a.altFt),
    spd: round(a.groundspeedKt === null ? null : metric ? a.groundspeedKt * KMH_PER_KT : a.groundspeedKt),
    hdg: round(a.trackDeg),
    vs: round(a.verticalRateFpm === null ? null : metric ? a.verticalRateFpm / FT_PER_M : a.verticalRateFpm),
    // One decimal: the panel shows "12.4" but never "12.437".
    dst: dstNm === null ? 0 : Math.round((metric ? dstNm * KM_PER_NM : dstNm) * 10) / 10,
    brg: brg === null ? 0 : Math.round(brg),
    eta_min: round(etaMin),
    eta_text: etaText,
    eta_src: etaMin === null ? null : 'physics',
  };
}
```

**Found during implementation:** the Step 1 fixture for 'falls back to the
bare carrier code when the name is unknown' originally read
`const rows = [{ ...sched[0]!, carrierIata: 'ZZ' }]` and expected it to match
the default aircraft callsign `EDV5075`. That row is a dead end: `EDV` is a
known operator, narrowed by Task 4's `CARRIER_CANDIDATES` to `['DL']`, `'ZZ'`
is not in that list, and `matchSchedule`'s "known operator narrows to zero →
null, never fall back to an unnarrowed collision" rule (Task 4's own fix; see
join.test.ts's "returns null when a known operator narrows to zero...")
rejects the row before `enrich()` ever reaches the
`airlineName(row.carrierIata) ?? row.carrierIata` fallback the test means to
exercise. Task 4's narrowing fix is what makes this fixture unreachable — one
task's correctness fix retroactively invalidating another task's test data,
not a bug in either module. Fixed above by giving the row a matching
operating callsign (`callsign: 'EDV5075'`), which takes join.ts's exact-match
path instead — the one path that skips carrier narrowing entirely, same as a
provider-supplied callsign would in production. `enrich.ts` itself needed no
change; the fixture was the only thing wrong.

- [ ] **Step 4: Run tests until green, then commit**

```bash
cd server && npm test && npx tsc --noEmit
git add server/src/enrich.ts server/test/enrich.test.ts
git commit -m "feat(server): combine position and schedule into a display-ready flight"
```

---

### Task 9: HTTP handler and cron

**Files:**
- Create: `server/src/flights.ts`
- Create: `server/src/index.ts`
- Create: `server/test/flights.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/flights.test.ts` covering:

- A valid request returns `ok: true`, `flights` sorted ascending by `dst`, and no more than `max` entries.
- `exclude_ground=1` removes on-ground aircraft; `min_alt_ft`/`max_alt_ft` band-filter.
- Missing or non-numeric `lat`/`lon` returns HTTP 400 with `ok: false`.
- `max` is clamped to a sane ceiling (pick one, document it) so a caller cannot ask for 10,000.
- A position-source failure returns `ok: false` — **not** an empty flight list. This is load-bearing: the firmware keeps its previous flights on `ok: false` and would blank the display on an empty success.
- A stale schedule table sets `stale: true` but still returns flights.

Use a fake `env` object with an in-memory KV stub — do not require Miniflare for this.

- [ ] **Step 2: Implement `flights.ts`**

Create `server/src/flights.ts`:

```ts
import { fetchAircraft } from './adsblol';
import { enrich } from './enrich';
import { callsignKey } from './join';
import { loadSchedule, isStale, lookupRows, lookupByCallsign } from './schedule/store';
import { KM_PER_NM } from './geo';
import type { Flight, ScheduleRow } from './types';

export interface Env {
  SCHEDULE: KVNamespace;
  BOARDS: string;
  AERODATABOX_KEY: string;
}

/** Hard ceiling on `max`, so a caller cannot ask us to serialise the whole sky. */
export const MAX_FLIGHTS_CEILING = 40;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/**
 * Parse an optional-looking-but-guarded numeric query param as NaN when the
 * param is absent or blank, instead of as `0`.
 *
 * `Number(null)` and `Number('')` both coerce to `0`, which is a legitimate
 * value for every param this guards -- a coordinate of 0 (null island), or an
 * altitude bound of 0 ft. Every caller below uses `Number.isFinite(...)` to
 * mean "the caller actually supplied this", so an absent param must parse to
 * something that check rejects. Without this, two different failures both
 * happened to hide behind the same coercion: a missing `lat`/`lon` silently
 * queried position data for (0, 0) instead of returning 400, and an absent
 * `max_alt_ft` silently became "reject every aircraft above 0 ft" -- i.e. an
 * always-on filter that empties every ordinary request's flight list, since
 * `max_alt_ft` is documented as optional and the common case omits it
 * entirely. `radius_km` and `max` below don't need this: they use `X || default`,
 * and `0`/NaN are both already falsy, so absence already falls through to
 * their default there.
 */
const parseNum = (raw: string | null): number => (raw === null || raw.trim() === '' ? NaN : Number(raw));

export async function handleFlights(url: URL, env: Env, nowMs: number): Promise<Response> {
  const q = url.searchParams;
  const lat = parseNum(q.get('lat'));
  const lon = parseNum(q.get('lon'));
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return json({ ok: false, error: 'bad lat', flights: [] }, 400);
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return json({ ok: false, error: 'bad lon', flights: [] }, 400);

  const radiusKm = clamp(Number(q.get('radius_km')) || 40, 1, 400);
  const max = clamp(Math.trunc(Number(q.get('max'))) || 8, 1, MAX_FLIGHTS_CEILING);
  const units = q.get('units') === 'metric' ? 'metric' : 'imperial';
  const excludeGround = q.get('exclude_ground') === '1';
  const minAlt = parseNum(q.get('min_alt_ft'));
  const maxAlt = parseNum(q.get('max_alt_ft'));
  const ts = Math.floor(nowMs / 1000);

  // A KV read failure degrades to "no routes", not to a failed request.
  const stored = await loadSchedule(env.SCHEDULE).catch(() => null);
  const stale = isStale(stored, nowMs);

  let aircraft;
  try {
    aircraft = await fetchAircraft(lat, lon, radiusKm / KM_PER_NM);
  } catch {
    // ok:false, NOT an empty success. The firmware keeps its previous flights
    // on ok:false and would blank the display on an empty list.
    return json({ ok: false, ts, stale, flights: [] });
  }

  const flights: Flight[] = [];
  for (const a of aircraft) {
    if (excludeGround && a.onGround) continue;
    if (a.altFt !== null && Number.isFinite(minAlt) && a.altFt < minAlt) continue;
    if (a.altFt !== null && Number.isFinite(maxAlt) && a.altFt > maxAlt) continue;

    let rows: ScheduleRow[] = [];
    if (stored) {
      // Exact-callsign candidates first: they also cover alphanumeric callsigns
      // like BAW2LJ, which have no derivable number and would otherwise be
      // unjoinable. Fall back to the number index for everything else.
      rows = lookupByCallsign(stored.index, a.callsign);
      if (rows.length === 0) {
        const key = callsignKey(a.callsign);
        if (key) rows = lookupRows(stored.index, key.number);
      }
    }

    const f = enrich(a, rows, { units, centerLat: lat, centerLon: lon });
    if (f) flights.push(f);
  }

  flights.sort((x, y) => x.dst - y.dst);
  return json({ ok: true, ts, stale, flights: flights.slice(0, max) });
}
```

`lookupByCallsign` and the two-index `ScheduleIndex` are already defined in Task 7 — this handler is their only consumer. Confirm the import resolves and that `byCallsign` being empty (the state Task 1 may well have found) degrades to the number path rather than throwing.

**Found during implementation:** the first version of this Step parsed `lat`,
`lon`, `min_alt_ft` and `max_alt_ft` with bare `Number(q.get(...))`. `Number(null)`
and `Number('')` both coerce to `0`, and `0` is a legitimate value for every one
of those params — so `Number.isFinite(...)` cannot be used as a "did the caller
supply this" gate the way this Step used it, because an absent or blank param
is indistinguishable from an explicit `0` once it has gone through `Number()`.
That shipped two failures at once. A missing or blank `lat`/`lon` silently
passed the `Number.isFinite(lat) && Math.abs(lat) <= 90` check as `(0, 0)`
instead of returning 400. Worse: `max_alt_ft` is documented as optional and an
ordinary request omits it, so `maxAlt` defaulted to `0`, which is finite —
making `a.altFt > maxAlt` reject every airborne aircraft on every request that
didn't explicitly pass an altitude band. The handler still returned `ok: true`,
just with an empty `flights` array, which is exactly the shape Task 9's own
Step 1 says must never happen on anything but a genuinely empty sky: the
ESP32 reads `ok: true` with an empty list as "the sky is confirmed empty" and
blanks the display immediately, rather than holding the last-known flights the
way it does on `ok: false`. A deployment in this state would have looked like
it was working right up until someone noticed the panel never showed anything.
The `parseNum()` helper above is the fix: it parses an absent or blank param to
`NaN` instead of `0`, used everywhere `Number.isFinite(...)` means "was this
supplied" — `lat`, `lon`, `min_alt_ft`, `max_alt_ft`. `radius_km` and `max`
above deliberately do NOT use `parseNum` and do not need it — they're parsed
with `Number(q.get(...)) || default`, and `0` and `NaN` are both already
falsy, so an absent or blank value already falls through to the default
there. Applying `parseNum` to those two anyway would change `max=0`'s
documented behavior (falls back to the default of 8) into a hard-clamped `1`,
which is not this fix's job — leave them as `||`-defaulted if re-running this
task. Verified by reverting to the literal `Number(...)` form and confirming
the tests in `flights.test.ts` that don't pass `min_alt_ft`/`max_alt_ft` fail
exactly this way — empty `flights` where aircraft were expected — then
restoring the fix.

- [ ] **Step 3: Implement `index.ts`**

Create `server/src/index.ts`:

```ts
import { handleFlights, type Env } from './flights';
import { fetchBoard } from './schedule/aerodatabox';
import { saveSchedule } from './schedule/store';
import type { ScheduleRow } from './types';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/v1/flights') return handleFlights(url, env, Date.now());
    return new Response('not found', { status: 404 });
  },

  async scheduled(_ev: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const boards = env.BOARDS.split(',').map((s) => s.trim()).filter(Boolean);
    const rows: ScheduleRow[] = [];
    let ok = 0;

    for (const icao of boards) {
      try {
        rows.push(...(await fetchBoard(icao, env.AERODATABOX_KEY)));
        ok++;
      } catch (e) {
        // One board failing must not cost us the other three.
        console.error(`board ${icao} failed:`, e);
      }
    }

    if (ok === 0) {
      // Writing an empty table would blank every route until the next cron.
      // Leave the previous one in place and let it age into `stale` honestly.
      console.error('all boards failed; keeping the previous table');
      return;
    }

    await saveSchedule(env.SCHEDULE, rows, Date.now());
    console.log(`schedule: ${rows.length} rows from ${ok}/${boards.length} boards`);
  },
};
```

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
cd server && npm test && npx tsc --noEmit
git add server/src/flights.ts server/src/index.ts server/test/flights.test.ts
git commit -m "feat(server): /v1/flights handler and schedule cron

ok:false on a position-source failure rather than an empty list -- the
firmware keeps its previous flights on ok:false and would blank the
display on an empty success."
```

---

### Task 10: Deploy and verify against the real contract

- [ ] **Step 1: Create the KV namespace and wire it up**

```bash
cd server && npx wrangler kv namespace create SCHEDULE
```

Uncomment the `[[kv_namespaces]]` block in `wrangler.toml` and paste the returned id.

- [ ] **Step 2: Set the secret**

```bash
cd server && npx wrangler secret put AERODATABOX_KEY
```

- [ ] **Step 3: Deploy and prime the schedule**

```bash
cd server && npx wrangler deploy
npx wrangler tail &
curl -s "https://flightwall-server.<your-subdomain>.workers.dev/__scheduled?cron=0+*/6+*+*+*"
```

Confirm in the tail that four boards were fetched and the KV write succeeded.

- [ ] **Step 4: Verify the contract end to end**

```bash
curl -s "https://flightwall-server.<your-subdomain>.workers.dev/v1/flights?lat=40.6413&lon=-73.7781&radius_km=40&max=8&units=imperial&exclude_ground=1" | python3 -m json.tool
```

Check, and record the numbers in the commit message:
- `ok: true`, `stale: false`
- at most 8 flights, ascending `dst`
- **what fraction have a non-null `to`** — the design target is ~86% of airline traffic; anything far below that means the join is not working and Task 4 needs revisiting before Plan 3
- ETA strings look like `~25m` / `~1h10` / `LANDING`, never a bare number
- response body is small — note the byte count, since the ESP32 parses it

- [ ] **Step 5: Measure the credit burn**

Check your AeroDataBox balance against the figure recorded in Task 1. Four boards × 4 refreshes/day should be well inside the $5 tier. If it is not, reduce the cron frequency before Plan 3 depends on it.

- [ ] **Step 6: Commit**

```bash
git add server/wrangler.toml
git commit -m "feat(server): deploy, prime schedule, verify contract

Records measured route-fill rate and response size against the design
target, so Plan 3 builds against numbers rather than assumptions."
```

---

## Done when

- [ ] `npm test` green and `npx tsc --noEmit` clean.
- [ ] Worker deployed; cron has populated KV with all four boards.
- [ ] `/v1/flights` returns the contract shape against a live position feed.
- [ ] Measured route-fill rate recorded and compared to the ~86% target.
- [ ] Credit burn measured and inside the chosen tier.

**Not verified by this plan:** nothing runs on the ESP32. Plan 3 covers the firmware adapter and is the first time the contract meets the device.

## Open risk carried into Plan 3

If Task 10's measured route-fill rate comes in well below ~86%, do **not** start Plan 3. The likely causes, in order: the FIDS window is too narrow to cover flights already airborne; the arrival/departure coordinate backfill in Task 7 is wrong for one direction; or the carrier-candidate table is excluding valid rows. All three are diagnosable from the Task 10 output and all three are cheaper to fix here than after the firmware depends on them.
