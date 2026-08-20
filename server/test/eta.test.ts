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
