import { normaliseNumber } from './routes';

/**
 * Unfold an ICS body into logical lines.
 *
 * RFC 5545 folds long lines at 75 octets by inserting CRLF followed by ONE
 * space or tab, and unfolding has to happen before anything reads the content.
 * This is not a tidiness step: a folded SUMMARY splits mid-token, so "DL1732"
 * arrives as "DL17" + "32" and either fails to parse or -- worse -- parses as
 * a different flight that exists.
 *
 * Bare LF is accepted alongside CRLF. The spec says CRLF, but feeds in the
 * wild are normalised by proxies and by whatever wrote them, and a parser that
 * only understood CRLF would read a whole calendar as one line.
 *
 * Exactly one whitespace character is removed per fold, because the second
 * space in a fold is content -- dropping it would silently edit event titles.
 */
export function unfoldIcs(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw === '') continue;
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += raw.slice(1);
      continue;
    }
    out.push(raw);
  }
  return out;
}

/**
 * Carrier prefix then flight number, as it appears in a calendar event title.
 *
 * TWO-CHARACTER IATA PREFIXES ONLY -- "DL 1732", not "DAL1732". Allowing a
 * three-letter alternative would make every airport code in a title a
 * candidate carrier: "LHR 2" parses as carrier LHR, flight 2, and Flighty's
 * summaries are full of airport codes. The cost is that a feed writing only
 * the ICAO callsign form parses as nothing at all, which is the safe failure
 * -- a mis-split prefix would resolve a real but wrong flight.
 *
 * CASE-SENSITIVE, deliberately. Requiring the carrier code to be already
 * uppercase is what keeps ordinary prose out: "Go 5k run" would otherwise
 * parse as carrier GO, flight 5. Real flight numbers in calendar titles are
 * uppercase; sentences are not.
 *
 * The \b on both ends is what stops a prefix being cut out of a longer token.
 */
const FLIGHT_RE = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/;

/**
 * First flight number in `text`, normalised, or null.
 *
 * The match is handed to normaliseNumber for the final say rather than being
 * trusted directly, so there is ONE definition of "looks like a flight
 * number" in this codebase -- including its rule that a prefix must contain a
 * letter, which is what stops a bare "181" becoming carrier 18, flight 1.
 */
export function extractFlightNumber(text: string): string | null {
  const m = FLIGHT_RE.exec(text);
  if (!m) return null;
  return normaliseNumber(`${m[1]}${m[2]}`);
}

/**
 * How long to wait on the feed before giving up.
 *
 * Short, because this runs INSIDE the tracked tick (see server.ts): every
 * second spent here is a second the position poll is not running. A calendar
 * that is slow today is not worth delaying live flight positions for -- the
 * next attempt is an hour away and the store is unchanged in the meantime.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch the published feed, or null if anything at all went wrong.
 *
 * NEVER THROWS, and the null is load-bearing: sync.ts treats null as "make no
 * change", so every failure funnelled through here is a failure that leaves
 * the store alone.
 *
 * A 200 THAT IS NOT A CALENDAR COUNTS AS A FAILURE. This is the subtle one. A
 * captive portal, a proxy error page, or iCloud's own sign-in page can arrive
 * with status 200 and an HTML body; that parses as a calendar containing zero
 * flights, and an empty parse is precisely what authorises deletions. Checking
 * for BEGIN:VCALENDAR is what stops an HTML page silently wiping every tracked
 * flight.
 *
 * The scheme allowlist keeps this from being a general-purpose fetcher for
 * whatever ends up in the environment variable -- `file://` would read local
 * disk, and the operator who typoed the URL should get nothing rather than
 * something.
 */
export async function fetchIcs(url: string): Promise<string | null> {
  // webcal:// is what Calendar.app and iCloud.com put on the clipboard. It is
  // https in everything but the scheme, and rewriting it here means the
  // operator can paste the link they were given instead of editing it.
  const target = url.startsWith('webcal://') ? `https://${url.slice('webcal://'.length)}` : url;
  if (!/^https?:\/\//.test(target)) return null;

  try {
    const res = await fetch(target, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/calendar' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.includes('BEGIN:VCALENDAR') ? text : null;
  } catch {
    return null;
  }
}

export interface CalendarFlight {
  /** Normalised, e.g. "BA181". */
  number: string;
  /** ISO "YYYY-MM-DD". Origin-local when `tzid` is set; UTC otherwise. */
  date: string;
  /**
   * True instant of departure, for ORDERING ONLY -- it decides which flights
   * survive the entry cap when the feed holds more than fit. Never stored: the
   * resolve pipeline is authoritative about times, and a calendar's idea of a
   * departure goes stale the moment the flight moves.
   */
  startMs: number;
  /**
   * The zone the event was written in, or null when DTSTART carried a UTC `Z`
   * instant, a floating time, or a date with no time at all.
   *
   * Null is the case to watch: `date` is then a UTC date, which is a day LATE
   * for a late-evening westbound departure. server.ts logs which form a feed
   * uses on the first sync so the regime is known rather than assumed.
   */
  tzid: string | null;
}

/** One property line: NAME;PARAM=value:VALUE. */
interface Prop {
  params: Map<string, string>;
  value: string;
}

/**
 * Split on `sep`, ignoring separators inside double quotes.
 *
 * Needed because a TZID may legitimately arrive quoted -- `TZID="America/New_
 * York"` -- and a quoted param value may contain the very characters that
 * delimit properties. Splitting naively finds a colon inside the quotes and
 * truncates the property name.
 */
function splitUnquoted(s: string, sep: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (c === sep && !quoted) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** Undo RFC 5545 text escaping. */
function unescapeText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c: string) =>
    c === 'n' || c === 'N' ? '\n' : c,
  );
}

function parseProp(line: string): { name: string; prop: Prop } | null {
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;

  const segments = splitUnquoted(line.slice(0, colon), ';');
  const name = (segments[0] ?? '').toUpperCase();
  if (!name) return null;

  const params = new Map<string, string>();
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq === -1) continue;
    params.set(seg.slice(0, eq).toUpperCase(), seg.slice(eq + 1).replace(/^"|"$/g, ''));
  }

  return { name, prop: { params, value: line.slice(colon + 1) } };
}

/**
 * The zone's offset from UTC, in ms, at a given instant.
 *
 * Intl is the only timezone database available without a dependency, and
 * formatToParts is the standard way to read an offset out of it: format the
 * instant into the zone, read the wall clock back as if it were UTC, and the
 * difference is the offset.
 *
 * An unknown TZID makes the constructor throw RangeError. That is caught and
 * reported as zero, so one bad zone costs that event its offset rather than
 * costing the whole feed -- a calendar is not worth discarding over a zone
 * name this Node build has never heard of.
 */
function zoneOffsetMs(tzid: string, utcMs: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
    // `% 24` because hour12:false renders midnight as "24" on some ICU builds.
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return Number.isNaN(asUtc) ? 0 : asUtc - utcMs;
  } catch {
    return 0;
  }
}

const DATE_ONLY_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

interface ParsedStart {
  date: string;
  startMs: number;
  tzid: string | null;
}

function parseDtStart(prop: Prop): ParsedStart | null {
  const value = prop.value.trim();

  const dateOnly = DATE_ONLY_RE.exec(value);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly as unknown as [string, string, string, string];
    return { date: `${y}-${mo}-${d}`, startMs: Date.UTC(+y, +mo - 1, +d), tzid: null };
  }

  const dt = DATE_TIME_RE.exec(value);
  if (!dt) return null;
  const [, y, mo, d, h, mi, s, z] = dt as unknown as [string, string, string, string, string, string, string, string];
  const date = `${y}-${mo}-${d}`;
  const naive = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);

  // A `Z` value is already UTC, and a floating time (no Z, no TZID) has no
  // zone to apply -- both are read as UTC, and both report tzid null so the
  // caller knows `date` may be a day off for a late westbound departure.
  const tzid = prop.params.get('TZID');
  if (z === 'Z' || !tzid) return { date, startMs: naive, tzid: null };

  // Twice: the first pass picks an offset using the wall clock read as UTC,
  // which lands in the wrong DST regime for an event within a few hours of a
  // transition. Re-reading the offset at the instant just computed settles it.
  const once = naive - zoneOffsetMs(tzid, naive);
  return { date, startMs: naive - zoneOffsetMs(tzid, once), tzid };
}

/**
 * Every flight the feed describes, deduped on (number, date) and ordered
 * soonest first.
 *
 * NO CLOCK. The window belongs to sync.ts, which owns the store rules; this
 * unit only understands ICS. Keeping the split means the parsing can be tested
 * against fixed text with no time control at all.
 *
 * Only VEVENT bodies are read. That is not fussiness: VTIMEZONE carries its
 * own DTSTART lines (the DST transition rules, dated 1970), and a parser that
 * scanned the whole feed would read them as events.
 */
export function parseCalendarFlights(text: string): CalendarFlight[] {
  const flights: CalendarFlight[] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  let event: Map<string, Prop> | null = null;

  const finish = (): void => {
    if (!event) return;
    const current = event;
    event = null;

    if ((current.get('STATUS')?.value ?? '').trim().toUpperCase() === 'CANCELLED') return;

    const summary = unescapeText(current.get('SUMMARY')?.value ?? '');
    const description = unescapeText(current.get('DESCRIPTION')?.value ?? '');
    const number = extractFlightNumber(summary) ?? extractFlightNumber(description);
    if (!number) return;

    const dtstart = current.get('DTSTART');
    if (!dtstart) return;
    const start = parseDtStart(dtstart);
    if (!start) return;

    const key = `${number}|${start.date}`;
    if (seen.has(key)) return;
    seen.add(key);
    flights.push({ number, date: start.date, startMs: start.startMs, tzid: start.tzid });
  };

  for (const line of unfoldIcs(text)) {
    const parsed = parseProp(line);
    if (!parsed) continue;
    const { name, prop } = parsed;

    if (name === 'BEGIN') {
      const component = prop.value.trim().toUpperCase();
      stack.push(component);
      if (component === 'VEVENT') event = new Map();
      continue;
    }
    if (name === 'END') {
      if (prop.value.trim().toUpperCase() === 'VEVENT') finish();
      stack.pop();
      continue;
    }

    // Only properties directly inside a VEVENT count. A VALARM nested in the
    // event has its own TRIGGER and DESCRIPTION, and letting those overwrite
    // the event's would read the reminder text as the flight.
    if (event && stack[stack.length - 1] === 'VEVENT' && !event.has(name)) {
      event.set(name, prop);
    }
  }

  return flights.sort((a, b) => a.startMs - b.startMs);
}
