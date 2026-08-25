import { describe, it, expect, vi, afterEach } from 'vitest';
import { unfoldIcs, extractFlightNumber, parseCalendarFlights, fetchIcs } from '../../src/tracked/calendar';

/** Wrap VEVENT bodies in the surrounding VCALENDAR a real feed carries. */
function ics(...events: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apple Inc.//iCloud Calendar//EN',
    ...events.flatMap((e) => ['BEGIN:VEVENT', ...e.trim().split('\n'), 'END:VEVENT']),
    'END:VCALENDAR',
  ].join('\r\n');
}

describe('unfoldIcs', () => {
  it('rejoins a line folded with a space', () => {
    expect(unfoldIcs('SUMMARY:DL17\r\n 32 JFK\r\n')).toEqual(['SUMMARY:DL1732 JFK']);
  });

  it('rejoins a line folded with a tab', () => {
    expect(unfoldIcs('SUMMARY:DL17\r\n\t32 JFK\r\n')).toEqual(['SUMMARY:DL1732 JFK']);
  });

  it('removes only the single fold whitespace, keeping content spaces', () => {
    expect(unfoldIcs('SUMMARY:BA181\r\n  LHR\r\n')).toEqual(['SUMMARY:BA181 LHR']);
  });

  it('accepts bare LF as well as CRLF, since not every feed folds strictly', () => {
    expect(unfoldIcs('SUMMARY:DL17\n 32\n')).toEqual(['SUMMARY:DL1732']);
  });

  it('keeps separate properties separate', () => {
    expect(unfoldIcs('SUMMARY:BA181\r\nDTSTART:20260914T183000Z\r\n')).toEqual([
      'SUMMARY:BA181',
      'DTSTART:20260914T183000Z',
    ]);
  });

  it('drops blank lines rather than emitting empty properties', () => {
    expect(unfoldIcs('SUMMARY:BA181\r\n\r\nUID:abc\r\n')).toEqual(['SUMMARY:BA181', 'UID:abc']);
  });
});

describe('extractFlightNumber', () => {
  it('reads a number with no space', () => {
    expect(extractFlightNumber('DL1732')).toBe('DL1732');
  });

  it('reads a number with a space', () => {
    expect(extractFlightNumber('DL 1732')).toBe('DL1732');
  });

  it('finds the number inside a decorated title', () => {
    expect(extractFlightNumber('✈️ BA 181 JFK → LHR')).toBe('BA181');
  });

  it('accepts a digit-letter carrier code', () => {
    expect(extractFlightNumber('9W 2381 to Delhi')).toBe('9W2381');
  });

  it('accepts a letter-digit carrier code', () => {
    expect(extractFlightNumber('B6 615')).toBe('B6615');
  });

  it('returns null when there is no flight number', () => {
    expect(extractFlightNumber('Dinner with Ana')).toBeNull();
  });

  it('rejects a bare number, which normaliseNumber would split into a fake carrier', () => {
    expect(extractFlightNumber('181')).toBeNull();
  });

  it('rejects the ICAO callsign form rather than mis-splitting it', () => {
    // "BAW181" must NOT become "AW181". Only 2-character IATA prefixes are
    // accepted, so there is no split of this string that parses -- which is
    // the safe outcome, since a wrong carrier resolves the wrong flight.
    expect(extractFlightNumber('Rehearsal BAW181 nonsense')).toBeNull();
  });

  it('ignores lowercase prose, which is what keeps ordinary events out', () => {
    // "Go 5k run" would otherwise parse as carrier GO, flight 5. Requiring the
    // carrier code to be already-uppercase is the cheap filter that stops it.
    expect(extractFlightNumber('Go 5k run')).toBeNull();
  });
});

describe('parseCalendarFlights', () => {
  it('takes the origin-local date straight from a TZID value', () => {
    const flights = parseCalendarFlights(
      ics(`
UID:a
SUMMARY:DL 1732 JFK → LAX
DTSTART;TZID=America/New_York:20260914T183000
`),
    );
    expect(flights).toHaveLength(1);
    expect(flights[0]!.number).toBe('DL1732');
    expect(flights[0]!.date).toBe('2026-09-14');
    expect(flights[0]!.tzid).toBe('America/New_York');
  });

  it('resolves a TZID value to the true instant, not the wall clock', () => {
    // 18:30 New York on 2026-09-14 is EDT (UTC-4), so 22:30Z.
    const flights = parseCalendarFlights(
      ics(`
UID:a
SUMMARY:DL 1732
DTSTART;TZID=America/New_York:20260914T183000
`),
    );
    expect(flights[0]!.startMs).toBe(Date.UTC(2026, 8, 14, 22, 30));
  });

  it('falls back to the UTC date when the value is a Z instant', () => {
    const flights = parseCalendarFlights(
      ics(`
UID:a
SUMMARY:BA181
DTSTART:20260914T183000Z
`),
    );
    expect(flights[0]!.date).toBe('2026-09-14');
    expect(flights[0]!.tzid).toBeNull();
    expect(flights[0]!.startMs).toBe(Date.UTC(2026, 8, 14, 18, 30));
  });

  it('handles an all-day event, which carries a date and no time', () => {
    const flights = parseCalendarFlights(
      ics(`
UID:a
SUMMARY:BA181
DTSTART;VALUE=DATE:20260914
`),
    );
    expect(flights[0]!.date).toBe('2026-09-14');
    expect(flights[0]!.startMs).toBe(Date.UTC(2026, 8, 14));
  });

  it('ignores DTSTART lines outside VEVENT, which VTIMEZONE is full of', () => {
    const feed = [
      'BEGIN:VCALENDAR',
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'BEGIN:DAYLIGHT',
      'DTSTART:19700308T020000',
      'TZNAME:EDT',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:a',
      'SUMMARY:BA181',
      'DTSTART:20260914T183000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const flights = parseCalendarFlights(feed);
    expect(flights).toHaveLength(1);
    expect(flights[0]!.date).toBe('2026-09-14');
  });

  it('skips a cancelled event', () => {
    const flights = parseCalendarFlights(
      ics(`
UID:a
SUMMARY:BA181
STATUS:CANCELLED
DTSTART:20260914T183000Z
`),
    );
    expect(flights).toEqual([]);
  });

  it('skips an event with no flight number', () => {
    const flights = parseCalendarFlights(
      ics(`
UID:a
SUMMARY:Dinner with Ana
DTSTART:20260914T183000Z
`),
    );
    expect(flights).toEqual([]);
  });

  it('skips an event whose DTSTART cannot be parsed', () => {
    const flights = parseCalendarFlights(
      ics(`
UID:a
SUMMARY:BA181
DTSTART:not-a-date
`),
    );
    expect(flights).toEqual([]);
  });

  it('skips an event with no DTSTART at all', () => {
    const flights = parseCalendarFlights(ics('UID:a\nSUMMARY:BA181'));
    expect(flights).toEqual([]);
  });

  it('falls back to DESCRIPTION when SUMMARY has no number', () => {
    const flights = parseCalendarFlights(
      ics(`
UID:a
SUMMARY:Trip to London
DESCRIPTION:Confirmation ABC123\\nFlight BA 181\\, seat 14C
DTSTART:20260914T183000Z
`),
    );
    expect(flights[0]!.number).toBe('BA181');
  });

  it('recovers a flight number split across a fold', () => {
    const feed = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:a',
      'SUMMARY:DL17',
      ' 32 JFK to LAX',
      'DTSTART:20260914T183000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(parseCalendarFlights(feed)[0]!.number).toBe('DL1732');
  });

  it('dedupes the same leg appearing twice', () => {
    const flights = parseCalendarFlights(
      ics(
        'UID:a\nSUMMARY:BA181\nDTSTART:20260914T183000Z',
        'UID:b\nSUMMARY:BA 181 JFK → LHR\nDTSTART:20260914T190000Z',
      ),
    );
    expect(flights).toHaveLength(1);
  });

  it('keeps the same flight number on two different dates', () => {
    const flights = parseCalendarFlights(
      ics(
        'UID:a\nSUMMARY:BA181\nDTSTART:20260914T183000Z',
        'UID:b\nSUMMARY:BA181\nDTSTART:20260918T183000Z',
      ),
    );
    expect(flights).toHaveLength(2);
  });

  it('orders by true instant, not by wall clock across zones', () => {
    // Tokyo 20:00 JST is 11:00Z; New York 08:00 EDT is 12:00Z. Naive wall-clock
    // ordering would put New York first and be wrong.
    const flights = parseCalendarFlights(
      ics(
        'UID:a\nSUMMARY:AA100\nDTSTART;TZID=America/New_York:20260914T080000',
        'UID:b\nSUMMARY:JL5\nDTSTART;TZID=Asia/Tokyo:20260914T200000',
      ),
    );
    expect(flights.map((f) => f.number)).toEqual(['JL5', 'AA100']);
  });

  it('treats an unknown TZID as UTC rather than throwing the whole feed away', () => {
    const flights = parseCalendarFlights(
      ics('UID:a\nSUMMARY:BA181\nDTSTART;TZID=Mars/Olympus:20260914T183000'),
    );
    expect(flights).toHaveLength(1);
    expect(flights[0]!.date).toBe('2026-09-14');
  });

  it('returns nothing for a feed with no events', () => {
    expect(parseCalendarFlights('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toEqual([]);
  });
});

describe('fetchIcs', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const ok = (body: string): Response => new Response(body, { status: 200 });
  const VALID = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR';

  it('returns the body of a well-formed feed', async () => {
    globalThis.fetch = vi.fn(async () => ok(VALID)) as unknown as typeof fetch;
    expect(await fetchIcs('https://example.com/f.ics')).toBe(VALID);
  });

  it('rewrites a webcal:// link, which is what Calendar.app hands you', async () => {
    const spy = vi.fn(async (_url: RequestInfo | URL) => ok(VALID));
    globalThis.fetch = spy as unknown as typeof fetch;
    await fetchIcs('webcal://p01-calendars.icloud.com/published/2/tok');
    expect(String(spy.mock.calls[0]![0])).toBe('https://p01-calendars.icloud.com/published/2/tok');
  });

  it('returns null on a non-200', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    expect(await fetchIcs('https://example.com/f.ics')).toBeNull();
  });

  it('returns null when the network throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    expect(await fetchIcs('https://example.com/f.ics')).toBeNull();
  });

  it('rejects a 200 that is not a calendar at all', async () => {
    // The dangerous case: a captive portal or an iCloud error page served with
    // status 200 would parse as a calendar holding zero flights, and an empty
    // parse is exactly what authorises deletions. It must read as a FAILURE.
    globalThis.fetch = vi.fn(async () => ok('<!doctype html><title>Sign in</title>')) as unknown as typeof fetch;
    expect(await fetchIcs('https://example.com/f.ics')).toBeNull();
  });

  it('rejects an empty 200 body for the same reason', async () => {
    globalThis.fetch = vi.fn(async () => ok('')) as unknown as typeof fetch;
    expect(await fetchIcs('https://example.com/f.ics')).toBeNull();
  });

  it('rejects a URL that is not http, https or webcal', async () => {
    const spy = vi.fn(async () => ok(VALID));
    globalThis.fetch = spy as unknown as typeof fetch;
    expect(await fetchIcs('file:///etc/passwd')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
