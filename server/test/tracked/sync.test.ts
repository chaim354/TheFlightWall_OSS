import { describe, it, expect } from 'vitest';
import { reconcile, runCalendarSync } from '../../src/tracked/sync';
import type { CalendarFlight } from '../../src/tracked/calendar';
import type { TrackedEntry } from '../../src/tracked/types';
import type { TrackedStorage } from '../../src/tracked/store';
import { MAX_ENTRIES } from '../../src/tracked/routes';

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

function entry(over: Partial<TrackedEntry> = {}): TrackedEntry {
  return {
    id: 'e1',
    number: 'BA181',
    date: '2026-09-14',
    wantOrigIata: null,
    wantDestIata: null,
    state: 'pending',
    reason: null,
    attempts: 0,
    stateAtMs: NOW,
    reresolved: false,
    source: 'calendar',
    icao24: null,
    callsign: null,
    reg: null,
    aircraftModel: null,
    aircraftType: null,
    origIata: null,
    destIata: null,
    orig: null,
    dest: null,
    schedDepEpoch: null,
    schedArrEpoch: null,
    lastLat: null,
    lastLon: null,
    lastPosAtMs: null,
    lastAltFt: null,
    lastGroundspeedKt: null,
    lastHeadingDeg: null,
    lastVerticalRateFpm: null,
    ...over,
  };
}

function flight(number: string, date: string, startMs = NOW): CalendarFlight {
  return { number, date, startMs, tzid: 'America/New_York' };
}

function memoryStorage(initial: TrackedEntry[]): TrackedStorage & { writes: number } {
  let entries = initial;
  return {
    writes: 0,
    async read() {
      return entries;
    },
    async write(next) {
      this.writes++;
      entries = next;
    },
  };
}

describe('reconcile: adding', () => {
  it('adds a flight from the feed that is not in the store', () => {
    const { next } = reconcile([], [flight('DL1732', '2026-09-15')], NOW);
    expect(next).toHaveLength(1);
    expect(next[0]!.number).toBe('DL1732');
    expect(next[0]!.date).toBe('2026-09-15');
  });

  it('marks what it adds as calendar-sourced', () => {
    const { next } = reconcile([], [flight('DL1732', '2026-09-15')], NOW);
    expect(next[0]!.source).toBe('calendar');
  });

  it('starts an added entry pending, so the tick resolves it', () => {
    const { next } = reconcile([], [flight('DL1732', '2026-09-15')], NOW);
    expect(next[0]!.state).toBe('pending');
  });

  it('does not re-add a journey already in the store', () => {
    const existing = entry({ number: 'BA181', date: '2026-09-14' });
    const { next } = reconcile([existing], [flight('BA181', '2026-09-14')], NOW);
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe('e1');
  });

  it('does not duplicate a journey the user added by hand', () => {
    const manual = entry({ source: 'manual', number: 'BA181', date: '2026-09-14' });
    const { next } = reconcile([manual], [flight('BA181', '2026-09-14')], NOW);
    expect(next).toHaveLength(1);
    expect(next[0]!.source).toBe('manual');
  });

  it('ignores a feed flight whose date is before the window', () => {
    const { next } = reconcile([], [flight('DL1732', '2026-09-12')], NOW);
    expect(next).toEqual([]);
  });

  it('ignores a feed flight whose date is beyond the window', () => {
    const { next } = reconcile([], [flight('DL1732', '2026-09-29')], NOW);
    expect(next).toEqual([]);
  });

  it('fills to the cap soonest first, and reports what it skipped', () => {
    // Expressed in terms of MAX_ENTRIES, not a literal: the cap is a tuning
    // decision that has already moved once (20 -> 60, when the OpenSky guard
    // moved to MAX_AIRBORNE_POLLS where the spending actually is), and a test
    // that restates the number just breaks the next time it is tuned.
    const over = 5;
    const flights = Array.from({ length: MAX_ENTRIES + over }, (_, i) =>
      flight(`DL${1000 + i}`, '2026-09-15', NOW + i * 60_000),
    );
    const { next, skipped } = reconcile([], flights, NOW);
    expect(next).toHaveLength(MAX_ENTRIES);
    expect(next[0]!.number).toBe('DL1000');
    expect(next[MAX_ENTRIES - 1]!.number).toBe(`DL${1000 + MAX_ENTRIES - 1}`);
    expect(skipped).toBe(over);
  });

  it('counts existing entries against the cap', () => {
    // Hand-added, so they survive reconcile and genuinely occupy slots.
    const existing = Array.from({ length: MAX_ENTRIES - 1 }, (_, i) =>
      entry({ id: `x${i}`, number: `AA${100 + i}`, date: '2026-09-14', source: 'manual' }),
    );
    const { next, skipped } = reconcile(
      existing,
      [flight('DL1', '2026-09-15'), flight('DL2', '2026-09-16')],
      NOW,
    );
    expect(next).toHaveLength(MAX_ENTRIES);
    expect(skipped).toBe(1);
  });
});

describe('reconcile: deleting', () => {
  it('deletes a calendar entry that is no longer in the feed', () => {
    const gone = entry({ number: 'BA181', date: '2026-09-14' });
    const { next, deleted } = reconcile([gone], [], NOW);
    expect(next).toEqual([]);
    expect(deleted).toBe(1);
  });

  it('spares an entry the user added by hand', () => {
    const manual = entry({ source: 'manual' });
    const { next } = reconcile([manual], [], NOW);
    expect(next).toHaveLength(1);
  });

  it('spares an entry stored before the source field existed', () => {
    const legacy = entry({ source: null });
    const { next } = reconcile([legacy], [], NOW);
    expect(next).toHaveLength(1);
  });

  it('spares an airborne entry, which is a real aircraft in the air', () => {
    const flying = entry({ state: 'airborne' });
    const { next } = reconcile([flying], [], NOW);
    expect(next).toHaveLength(1);
  });

  it('spares an entry whose date has left the window, which is lifecycle’s call', () => {
    const ageing = entry({ date: '2026-09-12' });
    const { next } = reconcile([ageing], [], NOW);
    expect(next).toHaveLength(1);
  });

  it('handles a rebooking as one delete and one add', () => {
    const old = entry({ number: 'BA181', date: '2026-09-14' });
    const { next, added, deleted } = reconcile([old], [flight('BA181', '2026-09-15')], NOW);
    expect(next).toHaveLength(1);
    expect(next[0]!.date).toBe('2026-09-15');
    expect(added).toBe(1);
    expect(deleted).toBe(1);
  });

  it('frees a capped slot in the same pass, so a delete makes room for an add', () => {
    const existing = Array.from({ length: 20 }, (_, i) =>
      entry({ id: `x${i}`, number: `AA${100 + i}`, date: '2026-09-14' }),
    );
    // AA100 is gone from the feed; DL1 is new. The feed still lists the other 19.
    const feed = [
      ...Array.from({ length: 19 }, (_, i) => flight(`AA${101 + i}`, '2026-09-14')),
      flight('DL1', '2026-09-15'),
    ];
    const { next, skipped } = reconcile(existing, feed, NOW);
    expect(next).toHaveLength(20);
    expect(next.some((e) => e.number === 'DL1')).toBe(true);
    expect(skipped).toBe(0);
  });
});

describe('runCalendarSync', () => {
  it('writes the reconciled store when the fetch succeeds', async () => {
    const storage = memoryStorage([]);
    await runCalendarSync(storage, NOW, {
      fetchIcs: async () =>
        'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:DL1732\r\nDTSTART:20260915T183000Z\r\nEND:VEVENT\r\nEND:VCALENDAR',
    });
    expect(await storage.read()).toHaveLength(1);
  });

  it('makes no change at all when the fetch fails', async () => {
    const existing = entry();
    const storage = memoryStorage([existing]);
    await runCalendarSync(storage, NOW, { fetchIcs: async () => null });
    expect(storage.writes).toBe(0);
    expect(await storage.read()).toEqual([existing]);
  });

  it('does delete when the feed is genuinely empty', async () => {
    const storage = memoryStorage([entry()]);
    await runCalendarSync(storage, NOW, {
      fetchIcs: async () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
    });
    expect(await storage.read()).toEqual([]);
  });

  it('does not write when nothing changed', async () => {
    const storage = memoryStorage([entry({ number: 'BA181', date: '2026-09-14' })]);
    await runCalendarSync(storage, NOW, {
      fetchIcs: async () =>
        'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:BA181\r\nDTSTART:20260914T183000Z\r\nEND:VEVENT\r\nEND:VCALENDAR',
    });
    expect(storage.writes).toBe(0);
  });
});

describe('reconcile: reporting the date regime', () => {
  it('counts feed flights whose date came from a zone', () => {
    const { zonedDates, floatingDates } = reconcile(
      [],
      [{ number: 'BA181', date: '2026-09-15', startMs: NOW, tzid: 'Europe/London' }],
      NOW,
    );
    expect(zonedDates).toBe(1);
    expect(floatingDates).toBe(0);
  });

  it('counts feed flights whose date is only a UTC guess', () => {
    // The count server.ts logs: a non-zero floating count means dates may be a
    // day late for late-evening westbound departures, and that is worth
    // knowing before someone debugs a flight that resolved to the wrong day.
    const { zonedDates, floatingDates } = reconcile(
      [],
      [{ number: 'BA181', date: '2026-09-15', startMs: NOW, tzid: null }],
      NOW,
    );
    expect(zonedDates).toBe(0);
    expect(floatingDates).toBe(1);
  });

  it('counts only flights inside the window, which are the ones acted on', () => {
    const { floatingDates } = reconcile(
      [],
      [{ number: 'BA181', date: '2030-01-01', startMs: NOW, tzid: null }],
      NOW,
    );
    expect(floatingDates).toBe(0);
  });
});
