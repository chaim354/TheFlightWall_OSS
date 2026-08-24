import { describe, it, expect } from 'vitest';
import { parseQuietHours, inQuietHours, shouldRefresh } from '../src/schedule/quietHours';

describe('parseQuietHours', () => {
  it('parses a plain window', () => {
    expect(parseQuietHours('0-6')).toEqual({ startHour: 0, endHour: 6 });
  });

  it('treats empty or "off" as disabled', () => {
    expect(parseQuietHours('')).toBeNull();
    expect(parseQuietHours('off')).toBeNull();
    expect(parseQuietHours(undefined)).toBeNull();
  });

  it('rejects malformed input rather than guessing', () => {
    // A typo must not silently become a window that suppresses refreshes all day.
    for (const bad of ['6', '6-', '-6', 'a-b', '0-24', '-1-6', '0-6-8']) {
      expect(parseQuietHours(bad)).toBeNull();
    }
  });
});

describe('inQuietHours', () => {
  const w = { startHour: 0, endHour: 6 };

  it('is true inside the window and false outside', () => {
    expect(inQuietHours(0, w)).toBe(true);
    expect(inQuietHours(3, w)).toBe(true);
    expect(inQuietHours(5, w)).toBe(true);
    expect(inQuietHours(6, w)).toBe(false); // end is exclusive
    expect(inQuietHours(12, w)).toBe(false);
    expect(inQuietHours(23, w)).toBe(false);
  });

  it('handles a window that wraps midnight', () => {
    const wrap = { startHour: 23, endHour: 7 };
    expect(inQuietHours(23, wrap)).toBe(true);
    expect(inQuietHours(0, wrap)).toBe(true);
    expect(inQuietHours(6, wrap)).toBe(true);
    expect(inQuietHours(7, wrap)).toBe(false);
    expect(inQuietHours(12, wrap)).toBe(false);
  });
});

describe('shouldRefresh', () => {
  const TWO_H = 2 * 60 * 60 * 1000;

  it('never refreshes inside quiet hours', () => {
    expect(shouldRefresh({ nowMs: 100_000_000, lastRefreshMs: 0, intervalMs: TWO_H, quiet: true, wasQuiet: true })).toBe(false);
    expect(shouldRefresh({ nowMs: 100_000_000, lastRefreshMs: 0, intervalMs: TWO_H, quiet: true, wasQuiet: false })).toBe(false);
  });

  it('refreshes IMMEDIATELY on leaving quiet hours, whatever the interval says', () => {
    // This is the whole point: setInterval has arbitrary phase, so waiting for
    // the next tick could leave the morning cold for nearly two hours.
    expect(shouldRefresh({ nowMs: 1000, lastRefreshMs: 999, intervalMs: TWO_H, quiet: false, wasQuiet: true })).toBe(true);
  });

  it('otherwise refreshes on the interval', () => {
    expect(shouldRefresh({ nowMs: TWO_H, lastRefreshMs: 0, intervalMs: TWO_H, quiet: false, wasQuiet: false })).toBe(true);
    expect(shouldRefresh({ nowMs: TWO_H - 1, lastRefreshMs: 0, intervalMs: TWO_H, quiet: false, wasQuiet: false })).toBe(false);
  });

  it('refreshes when nothing has been refreshed yet', () => {
    expect(shouldRefresh({ nowMs: 0, lastRefreshMs: null, intervalMs: TWO_H, quiet: false, wasQuiet: false })).toBe(true);
  });

  // A cold start is not cadence. lastRefreshMs starts null on every boot and the
  // table lives in memory, so skipping here serves routeless flights until the
  // window ends -- up to six hours after a first deploy, or after the named
  // volume in config/deploy.yml is lost. Quiet hours exist to drop REDUNDANT
  // refreshes; the one that populates an empty table is the opposite of
  // redundant. Costs one refresh per restart against the three a night saved.
  it('refreshes at boot even when boot lands inside quiet hours', () => {
    expect(shouldRefresh({ nowMs: 0, lastRefreshMs: null, intervalMs: TWO_H, quiet: true, wasQuiet: false })).toBe(true);
  });
});
