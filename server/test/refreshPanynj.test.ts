import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/schedule/panynj', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/schedule/panynj')>();
  return { ...actual, fetchBoard: vi.fn() };
});

import { fetchBoard as fetchPanynj } from '../src/schedule/panynj';
import { refreshPanynj, refreshSchedule, resetPanynjBackoff } from '../src/schedule/refresh';
import { matchSchedule } from '../src/join';
import { indexRows, type ScheduleStorage, type StoredSchedule } from '../src/schedule/store';
import type { ScheduleRow } from '../src/types';

class FakeStorage implements ScheduleStorage {
  value: StoredSchedule | null = null;
  async read(): Promise<StoredSchedule | null> {
    return this.value;
  }
  async write(s: StoredSchedule): Promise<void> {
    this.value = s;
  }
}

/** Fixed 'now'; these rows' epochs are far in the past, which the temporal
 *  filter passes through -- see test/join.test.ts for its own cases. */
const NOW = 1_787_000_000;

/** DL 5075 CVG->LGA, the shape both sources would produce for one flight. */
const base = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  callsign: null,
  carrierIata: 'DL',
  number: '5075',
  origIata: 'CVG',
  origLat: 39.0488,
  origLon: -84.6678,
  destIata: 'LGA',
  destLat: 40.7772,
  destLon: -73.8726,
  schedArrEpoch: null,
  revArrEpoch: null,
  ...over,
});

const storedRowsOf = (s: StoredSchedule | null): ScheduleRow[] =>
  Object.values(s?.index.byNumber ?? {}).flat();

const seed = (storage: FakeStorage, rows: ScheduleRow[], builtAtMs = 1000): void => {
  storage.value = { builtAtMs, index: indexRows(rows) };
};

/** Every board-direction returns `rows`. */
const allBoardsReturn = (rows: ScheduleRow[]): void => {
  vi.mocked(fetchPanynj).mockResolvedValue(rows);
};

beforeEach(() => {
  vi.mocked(fetchPanynj).mockReset();
  resetPanynjBackoff();
});

describe('refreshPanynj: merging with the AeroDataBox table', () => {
  it('yields ONE row for a flight both sources list, not two', async () => {
    // The whole reason the merge is keyed rather than a union. Two rows for
    // the same flight share an origin and destination, so they score an
    // identical corridor excess and matchSchedule's tiebreak refuses to pick
    // between them -- a union would blank the route it was meant to improve.
    const storage = new FakeStorage();
    seed(storage, [{ ...base({ callsign: 'EDV5075', schedArrEpoch: 100 }), src: 'adb' }]);
    allBoardsReturn([base({ schedArrEpoch: 200, revArrEpoch: 250 })]);

    await refreshPanynj(storage, 5000, 0);

    const rows = storedRowsOf(storage.value);
    expect(rows).toHaveLength(1);
  });

  it('and that single row still matches, where a union would have blanked it', async () => {
    // The failure this guards is silent and downstream, so assert on the
    // actual join rather than only on row count.
    const storage = new FakeStorage();
    seed(storage, [{ ...base({ callsign: 'EDV5075' }), src: 'adb' }]);
    allBoardsReturn([base({ schedArrEpoch: 200 })]);
    await refreshPanynj(storage, 5000, 0);

    const rows = storedRowsOf(storage.value);
    // A point on the CVG->LGA corridor.
    const hit = matchSchedule('EDV5075', 40.5, -75.5, rows, NOW);
    expect(hit).not.toBeNull();
    expect(hit!.destIata).toBe('LGA');

    // Demonstrate the counterfactual: an un-merged union really does blank --
    // but only once the exact-callsign path is out of the picture, which is
    // the common case here. A Port Authority row NEVER carries a callsign and
    // 56% of AeroDataBox rows do not either, so for most flights the join
    // falls through to number + carrier + geometry, where two rows describing
    // the same leg score an identical excess and the tiebreak refuses both.
    const union = [base({ schedArrEpoch: 100 }), base({ schedArrEpoch: 200 })];
    expect(matchSchedule('EDV5075', 40.5, -75.5, union, NOW)).toBeNull();

    // And when a callsign IS present the exact path returns before the
    // tiebreak is ever reached -- so the union is not uniformly fatal, which
    // is exactly why this needed asserting rather than assuming.
    const withCallsign = [base({ callsign: 'EDV5075' }), base({ schedArrEpoch: 200 })];
    expect(matchSchedule('EDV5075', 40.5, -75.5, withCallsign, NOW)).not.toBeNull();
  });

  it('keeps the AeroDataBox callsign under the fresher Port Authority row', async () => {
    // Port Authority boards never publish an operating callsign, so a naive
    // "fresh wins" replacement would destroy join.ts's exact-match path for
    // every flight these three airports serve.
    const storage = new FakeStorage();
    seed(storage, [{ ...base({ callsign: 'EDV5075' }), src: 'adb' }]);
    allBoardsReturn([base({ schedArrEpoch: 200, revArrEpoch: 250 })]);

    await refreshPanynj(storage, 5000, 0);

    const [merged] = storedRowsOf(storage.value);
    expect(merged!.callsign).toBe('EDV5075'); // from AeroDataBox
    expect(merged!.schedArrEpoch).toBe(200); // from Port Authority
    expect(merged!.revArrEpoch).toBe(250);
  });

  it('keeps the AeroDataBox arrival time on a departures row, which PA cannot supply', async () => {
    // A Port Authority departures row carries no arrival time at all. Letting
    // it overwrite AeroDataBox's far-end arrival would drop those flights back
    // to the physics ETA for no reason.
    const storage = new FakeStorage();
    const dep = base({ origIata: 'JFK', destIata: 'LAX', origLat: 40.64, origLon: -73.78, destLat: 33.94, destLon: -118.41 });
    seed(storage, [{ ...dep, schedArrEpoch: 900, revArrEpoch: 950, src: 'adb' }]);
    allBoardsReturn([dep]); // PA departures: both epochs null

    await refreshPanynj(storage, 5000, 0);

    const [merged] = storedRowsOf(storage.value);
    expect(merged!.schedArrEpoch).toBe(900);
    expect(merged!.revArrEpoch).toBe(950);
  });

  it('keeps rows the Port Authority does not cover at all, such as BOS', async () => {
    const storage = new FakeStorage();
    const bos = base({ carrierIata: 'B6', number: '1234', origIata: 'MCO', destIata: 'BOS', destLat: 42.36, destLon: -71.01 });
    seed(storage, [{ ...bos, src: 'adb' }]);
    allBoardsReturn([base()]);

    await refreshPanynj(storage, 5000, 0);

    const rows = storedRowsOf(storage.value);
    expect(rows.some((r) => r.destIata === 'BOS' && r.number === '1234')).toBe(true);
  });
});

describe('refreshPanynj: the table stays bounded', () => {
  it('replaces its own previous rows instead of accumulating them', async () => {
    // Without the `src` tag every merge would pile another generation of
    // Port Authority rows onto the table until the 6-hourly AeroDataBox pass
    // happened to reset it.
    const storage = new FakeStorage();
    allBoardsReturn([base({ number: '1' })]);
    await refreshPanynj(storage, 1000, 0);
    expect(storedRowsOf(storage.value)).toHaveLength(1);

    allBoardsReturn([base({ number: '2' })]);
    await refreshPanynj(storage, 2000, 0);
    const rows = storedRowsOf(storage.value);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.number).toBe('2'); // the stale generation is gone
  });

  it('treats an untagged legacy row as not-Port-Authority and keeps it', async () => {
    // Tables written before `src` existed have no tag. Dropping them would
    // silently empty the table on the first merge after a deploy.
    const storage = new FakeStorage();
    seed(storage, [base({ carrierIata: 'AA', number: '99', origIata: 'ORD', destIata: 'BOS' })]);
    allBoardsReturn([base()]);

    await refreshPanynj(storage, 5000, 0);

    expect(storedRowsOf(storage.value).some((r) => r.number === '99')).toBe(true);
  });
});

describe('refreshPanynj: failure', () => {
  it('leaves the previous table alone when every board fails', async () => {
    const storage = new FakeStorage();
    seed(storage, [{ ...base({ number: '7' }), src: 'adb' }], 1234);
    vi.mocked(fetchPanynj).mockRejectedValue(new Error('403'));

    await refreshPanynj(storage, 9999, 0);

    expect(storage.value!.builtAtMs).toBe(1234); // untouched
    expect(storedRowsOf(storage.value).map((r) => r.number)).toEqual(['7']);
  });

  it('saves what succeeded when only some boards fail', async () => {
    // A non-403 failure, deliberately: a 403 is a rate-limit signal that
    // abandons the whole pass on purpose, and is covered separately below.
    const storage = new FakeStorage();
    vi.mocked(fetchPanynj)
      .mockRejectedValueOnce(new Error('panynj JFK arrival 502'))
      .mockResolvedValue([base({ number: '8' })]);

    await refreshPanynj(storage, 4242, 0);

    expect(storage.value!.builtAtMs).toBe(4242);
    expect(storedRowsOf(storage.value).map((r) => r.number)).toEqual(['8']);
  });

  it('fetches all six board-directions', async () => {
    const storage = new FakeStorage();
    allBoardsReturn([]);
    await refreshPanynj(storage, 1000, 0);

    const calls = vi.mocked(fetchPanynj).mock.calls.map((c) => `${c[0]}/${c[1]}`);
    expect(calls.sort()).toEqual([
      'EWR/arrival', 'EWR/departure', 'JFK/arrival', 'JFK/departure', 'LGA/arrival', 'LGA/departure',
    ]);
  });

  it('does not throw when storage cannot be read', async () => {
    const storage = new FakeStorage();
    storage.read = async () => {
      throw new Error('disk gone');
    };
    allBoardsReturn([base()]);
    await expect(refreshPanynj(storage, 1000, 0)).resolves.toBeUndefined();
    expect(storedRowsOf(storage.value)).toHaveLength(1);
  });
});

describe('refreshPanynj: 403 backoff', () => {
  const forbid = (): void => {
    vi.mocked(fetchPanynj).mockRejectedValue(new Error('panynj JFK arrival 403'));
  };

  it('abandons the rest of the pass on a 403 instead of hammering', async () => {
    // The block is per-origin, so the other five board-directions are
    // already refused; asking anyway only deepens it.
    const storage = new FakeStorage();
    forbid();
    await refreshPanynj(storage, 1000, 0);
    expect(vi.mocked(fetchPanynj).mock.calls).toHaveLength(1);
  });

  it('skips subsequent passes until the backoff expires', async () => {
    const storage = new FakeStorage();
    forbid();
    await refreshPanynj(storage, 0, 0);
    expect(vi.mocked(fetchPanynj).mock.calls).toHaveLength(1);

    // Well inside the 15-minute base backoff: no request at all.
    await refreshPanynj(storage, 60_000, 0);
    expect(vi.mocked(fetchPanynj).mock.calls).toHaveLength(1);

    // Past it: tries again.
    await refreshPanynj(storage, 16 * 60_000, 0);
    expect(vi.mocked(fetchPanynj).mock.calls).toHaveLength(2);
  });

  it('doubles the backoff while blocks continue', async () => {
    const storage = new FakeStorage();
    forbid();
    await refreshPanynj(storage, 0, 0); // blocked until 15m
    await refreshPanynj(storage, 16 * 60_000, 0); // retried, blocked again -> 30m
    const calls = vi.mocked(fetchPanynj).mock.calls.length;

    // 20 minutes after the second block is still inside a 30-minute window.
    await refreshPanynj(storage, 36 * 60_000, 0);
    expect(vi.mocked(fetchPanynj).mock.calls).toHaveLength(calls);

    await refreshPanynj(storage, 47 * 60_000, 0);
    expect(vi.mocked(fetchPanynj).mock.calls.length).toBeGreaterThan(calls);
  });

  it('clears the backoff after a pass that succeeds', async () => {
    const storage = new FakeStorage();
    forbid();
    await refreshPanynj(storage, 0, 0);

    vi.mocked(fetchPanynj).mockReset();
    allBoardsReturn([base()]);
    await refreshPanynj(storage, 16 * 60_000, 0);
    expect(vi.mocked(fetchPanynj).mock.calls).toHaveLength(6);

    // Immediately afterwards: no residual backoff.
    vi.mocked(fetchPanynj).mockClear();
    await refreshPanynj(storage, 16 * 60_000 + 1000, 0);
    expect(vi.mocked(fetchPanynj).mock.calls).toHaveLength(6);
  });

  it('does not back off for an ordinary non-403 failure', async () => {
    // A single flaky board is not a rate-limit signal; treating it as one
    // would silence this source for 15 minutes over one dropped connection.
    const storage = new FakeStorage();
    vi.mocked(fetchPanynj)
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue([base()]);
    await refreshPanynj(storage, 0, 0);
    expect(vi.mocked(fetchPanynj).mock.calls).toHaveLength(6); // pass continued

    vi.mocked(fetchPanynj).mockClear();
    await refreshPanynj(storage, 1000, 0);
    expect(vi.mocked(fetchPanynj).mock.calls).toHaveLength(6); // and no backoff
  });

  it('keeps the previous table when a 403 means nothing was fetched', async () => {
    const storage = new FakeStorage();
    seed(storage, [{ ...base({ number: '5' }), src: 'adb' }], 777);
    forbid();
    await refreshPanynj(storage, 1000, 0);
    expect(storage.value!.builtAtMs).toBe(777);
    expect(storedRowsOf(storage.value).map((r) => r.number)).toEqual(['5']);
  });
});

describe('refreshSchedule tags its rows so the merge can identify them', () => {
  it('marks AeroDataBox rows adb', async () => {
    const mod = await import('../src/schedule/aerodatabox');
    const spy = vi.spyOn(mod, 'fetchBoard').mockResolvedValue([base()]);
    const storage = new FakeStorage();
    await refreshSchedule(['KJFK'], 'key', storage, 1000, 0);
    expect(storedRowsOf(storage.value).every((r) => r.src === 'adb')).toBe(true);
    spy.mockRestore();
  });
});
