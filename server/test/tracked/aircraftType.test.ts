import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchIcaoTypeCode } from '../../src/tracked/aircraftType';

describe('fetchIcaoTypeCode', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns the ICAO type code for a hex', async () => {
    // The real hexdb.io body for A997CC (N717TW, the Delta 757 that surfaced
    // this), captured verbatim -- including the fields we ignore, so the shape
    // this parses is the shape the endpoint actually sends.
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ModeS: 'A997CC', Registration: 'N717TW', Manufacturer: 'Boeing',
      ICAOTypeCode: 'B752', Type: '757 231/W',
      RegisteredOwners: 'Delta Air Lines', OperatorFlagCode: 'DAL',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchIcaoTypeCode('a997cc')).toBe('B752');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://hexdb.io/api/v1/aircraft/a997cc');
  });

  it('uppercases and trims', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ICAOTypeCode: ' b77w ' }), { status: 200 }),
    ));
    expect(await fetchIcaoTypeCode('406947')).toBe('B77W');
  });

  // Every failure below must return null rather than throw. A type code is
  // cosmetic; resolveFlight calls this AFTER it has already succeeded, and a
  // hexdb problem must never turn a resolvable flight into an unresolved one.
  it('returns null when hexdb answers 200 with no type code', async () => {
    // Its actual not-found behaviour: 200 with a body that simply lacks the
    // field, which is why the shape check is the not-found path and not just
    // defensive typing.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ModeS: 'ABCDEF' }), { status: 200 }),
    ));
    expect(await fetchIcaoTypeCode('abcdef')).toBeNull();
  });

  it('returns null on a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    expect(await fetchIcaoTypeCode('abcdef')).toBeNull();
  });

  it('returns null on an unparseable body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    expect(await fetchIcaoTypeCode('abcdef')).toBeNull();
  });

  it('returns null when the request throws or times out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timed out')));
    expect(await fetchIcaoTypeCode('abcdef')).toBeNull();
  });

  it('returns null for an empty hex without calling out at all', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchIcaoTypeCode('')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null rather than a code when the field is not a string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ICAOTypeCode: 752 }), { status: 200 }),
    ));
    expect(await fetchIcaoTypeCode('abcdef')).toBeNull();
  });
});
