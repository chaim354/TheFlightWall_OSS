import { describe, it, expect } from 'vitest';
import {
  etaMinutes, formatEta,
  TERMINAL_NM, TERMINAL_KT, TERMINAL_MIN,
  LANDING_NM, LANDING_MAX_MIN, NOMINAL_DESCENT_FPM,
} from '../src/eta';

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
    // Below the boundary the nominal profile carries it, so a missing or zero
    // groundspeed is still answerable.
    expect(etaMinutes(25, 0)).toBeCloseTo(7.5, 3);
  });
});

describe('etaMinutes: descent-time floor', () => {
  // Table verified by hand before implementing, reproduced here as the test
  // suite. floor = altitudeFt / NOMINAL_DESCENT_FPM (1800fpm); result =
  // max(horizontal, floor).
  it('binds when high and close: FL380, 8.6nm out -- the WJA2101 shape', () => {
    const horizontalOnly = etaMinutes(8.6, 320);
    const withFloor = etaMinutes(8.6, 320, 38000);
    expect(horizontalOnly).toBeCloseTo(2.58, 2);   // horizontal alone: under 3 minutes
    expect(withFloor).toBeCloseTo(21.11, 2);       // 38000 / 1800
    expect(withFloor!).toBeGreaterThan(horizontalOnly!);
  });

  it('does not bind: 8,000ft, 25nm out', () => {
    const horizontalOnly = etaMinutes(25, 300);
    const withFloor = etaMinutes(25, 300, 8000);
    expect(horizontalOnly).toBeCloseTo(7.5, 3);
    expect(withFloor).toBe(horizontalOnly); // floor (4.44) is smaller; unchanged
  });

  it('does not bind: FL350, 800nm out', () => {
    const horizontalOnly = etaMinutes(800, 470);
    const withFloor = etaMinutes(800, 470, 35000);
    expect(horizontalOnly).toBeCloseTo(112.47, 1);
    expect(withFloor).toBe(horizontalOnly); // floor (19.4) is smaller; unchanged
  });

  it('does not bind: 2,000ft, 8nm final', () => {
    const horizontalOnly = etaMinutes(8, 150);
    const withFloor = etaMinutes(8, 150, 2000);
    expect(horizontalOnly).toBeCloseTo(2.4, 3);
    expect(withFloor).toBe(horizontalOnly); // floor (1.11) is smaller; unchanged
  });

  it('applies no floor when altitude is null -- unknown must not invent a constraint', () => {
    // Same distance as the WJA2101 case, where a floor -- if applied --
    // would dominate (~21min). With altitude unknown, it must not appear.
    // This is also the REAL on-ground representation in this codebase: per
    // adsblol.ts, a surface aircraft's alt_baro arrives as the literal
    // string "ground", which is parsed to altFt: null (not 0) precisely so
    // callers don't have to treat 0 as a trustworthy altitude reading.
    expect(etaMinutes(8.6, 320, null)).toBe(etaMinutes(8.6, 320));
  });

  it('applies no floor when altitude is omitted -- existing 2-arg callers keep working', () => {
    expect(etaMinutes(8.6, 320, undefined)).toBe(etaMinutes(8.6, 320));
  });

  it('applies no floor for a literal zero or a negative altitude reading', () => {
    // Distinct from the null case above: this is a provider that reports an
    // explicit numeric 0 (or bad data below it) rather than omitting the
    // field. Both must be inert, the same as null -- not a source of NaN
    // (Math.max with a stray NaN operand would poison the whole result) and
    // not a false suppression of a legitimate horizontal ETA.
    const eta = etaMinutes(0.5, 20, 0);
    expect(etaMinutes(8.6, 320, 0)).toBe(etaMinutes(8.6, 320));
    expect(etaMinutes(8.6, 320, -500)).toBe(etaMinutes(8.6, 320));
    expect(eta).toBeCloseTo((0.5 / 200) * 60, 6);
    expect(formatEta(0.5, eta)).toBe('LANDING');
  });

  it('WJA2101 regression: FL380 8.6nm from JFK is not LANDING', () => {
    // Observed in production: WJA2101, ATL->JFK, altFt 38000, ~8.6nm from
    // JFK -- its own destination -- reported eta_text "LANDING". Horizontal
    // distance alone gives 2.6 minutes; the aircraft still owed a full
    // descent from FL380, which at a nominal 1800fpm takes ~21 minutes.
    const eta = etaMinutes(8.6, 320, 38000);
    expect(eta).toBeCloseTo(21.11, 2);
    expect(formatEta(8.6, eta)).not.toBe('LANDING');
    expect(formatEta(8.6, eta)).toBe('~20m');
  });
});

describe('formatEta', () => {
  it('shows LANDING when close AND the ETA itself is genuinely small', () => {
    expect(formatEta(LANDING_NM - 1, 4)).toBe('LANDING');
    expect(formatEta(5, 2)).toBe('LANDING');
    expect(formatEta(LANDING_NM, LANDING_MAX_MIN)).toBe('LANDING'); // boundary, inclusive
  });

  it('does not show LANDING on proximity alone when the ETA is not small -- the WJA2101 bug shape', () => {
    // Close by distance (well inside LANDING_NM) but the ETA itself is
    // large -- exactly what a floored, cruise-altitude ETA looks like.
    // Distance alone used to be sufficient; now it is not.
    expect(formatEta(5, 15)).not.toBe('LANDING');
    expect(formatEta(LANDING_NM, LANDING_MAX_MIN + 0.01)).not.toBe('LANDING');
    expect(formatEta(8.6, 21.11)).not.toBe('LANDING'); // the reported bug, numerically
  });

  it('does not show LANDING for a null ETA -- absence of an estimate is not evidence of arrival', () => {
    // A null etaMin means we could not estimate at all. Previously this fell
    // back to LANDING whenever distance alone was small; that is a confident
    // claim built on missing data, so it now shows nothing instead.
    expect(formatEta(5, null)).toBeNull();
    expect(formatEta(LANDING_NM - 1, null)).toBeNull();
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

  it('derives the LANDING display threshold from LANDING_NM, not a separate hardcoded number', () => {
    expect(LANDING_MAX_MIN).toBeCloseTo((LANDING_NM / TERMINAL_KT) * 60, 9);
    expect(LANDING_MAX_MIN).toBeCloseTo(9, 6);
  });

  it('picks a descent rate inside the documented 1500-2500fpm range, on the conservative (slower) half', () => {
    // Slower => a larger floor => a longer reported ETA. Overstating time
    // remaining is a much smaller sin than telling someone a cruising
    // aircraft is landing, so this constant should sit at or below the
    // midpoint of the realistic range, never above it.
    expect(NOMINAL_DESCENT_FPM).toBeGreaterThanOrEqual(1500);
    expect(NOMINAL_DESCENT_FPM).toBeLessThanOrEqual(2000);
  });
});
