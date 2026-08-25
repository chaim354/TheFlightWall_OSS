# Tracked flights from a published calendar — design

**Dated record.** Written 2026-08-25 against `claude/flighty-calendar-sync`,
branched from `main` at `aad7160`.

## Problem

Tracked flights work, and nobody uses them, because adding one is manual. The
journey has to be typed into the form at `GET /` — flight number and date — for
every leg, days ahead, and forgotten exactly when it would have been most
useful. Meanwhile Flighty already knows every flight, keeps it current when the
gate or the time moves, and writes it into the maintainer's calendar.

The data is already on the right side of the fence. What is missing is a path
from that calendar to `POST /v1/tracked`.

## What already exists (do not rebuild)

Checked before designing:

- **`POST /v1/tracked` is idempotent on `(number, date)`.** `routes.ts` looks
  up an existing entry *before* the cap check, deliberately, so a repost at a
  full store returns the existing entry instead of "store is full". A poller
  can therefore re-post the same journeys forever at no cost. This is the
  single property that makes the whole design cheap.
- **Validation, normalisation and construction are already separate,
  exported functions** — `normaliseNumber`, `validateEntry`, `newEntry`. The
  sync calls them directly rather than going over HTTP to its own process.
- **A tick already exists** in `server.ts`, on a 300s interval, created only
  when tracked storage exists.
- **Lifecycle already expires entries** — 2h after landing, 24h after an
  unresolved miss. The sync does not need to clean up after itself in the
  common case.
- **`normaliseNumber` already rejects a bare number.** Its prefix-must-contain
  -a-letter rule exists because `[A-Z0-9]{2,3}\d{1,4}` alone matches "181" as
  carrier "18" + flight "1". The parser reuses it rather than inventing a
  second definition of "looks like a flight number".

## Upstream facts this rests on

Verified 2026-08-25, because the design is worthless if any of them is wrong:

- **Flighty has two calendar features pointing opposite ways.** *Calendar
  Import* reads calendars to find flights and documents a calendar picker.
  *Calendar Export* writes flight events and keeps them updated when
  "departure time, gate, or duration" change. This design consumes the
  **export** direction. Flighty's docs do **not** state whether the export
  destination calendar is selectable.
- **Flighty exports friends' flights too**, carrying the person's name and not
  affecting availability. Decision below: track them.
- **Public calendar publishing is an iCloud-account feature.** A calendar under
  "On My Mac" / "On My iPhone" cannot be published to a URL; Apple offers only
  WebDAV for those. **Precondition: the calendar Flighty writes into must be an
  iCloud calendar.**
- **The published link is `webcal://`**, and the same URL over `https://`
  serves the raw `.ics`.

**Unverified, and blocking implementation:** the actual text of a Flighty
event — `SUMMARY` format, whether `DTSTART` carries a `TZID`, and whether a
friend's flight is distinguishable from the maintainer's. The parser is written
against a real fixture, not against a guess. See "Open items".

## Decisions taken

| Question | Decision |
|---|---|
| Direction | **Server pulls** a published `.ics`. Works while the maintainer is asleep, travelling, or has the Mac shut |
| Where it runs | **The Node deployment only.** The Worker has no tracked store, so this is inert there, as tracked flights already are |
| When it runs | **Inside the existing 300s tracked tick**, gated to hourly. Not its own timer — see "Why not a second timer" |
| Whose flights | **Both the maintainer's and friends'.** Any parseable flight number counts, so there is no friend-detection heuristic to get wrong |
| Ownership | **Reconcile, but only its own entries.** A new `source` field distinguishes them |
| Config | **`TRACKED_ICS_URL`.** Absent means the sync never runs |
| Dependency | **None added.** A minimal RFC 5545 subset, not an ICS library |

## Why not a second timer

This is the one non-obvious structural call, and it is a correctness fix rather
than a style preference.

`fileTrackedStorage` is read-whole-array / write-whole-array with a
write-to-temp-then-rename. That is safe against a crash mid-write. It is **not**
safe against two writers. A separate hourly `setInterval` would interleave its
read-modify-write with the tick's across an `await`, and whichever wrote second
would silently clobber the other — a tick's position updates lost, or a
just-added entry vanishing before anyone saw it. Neither leaves a trace.

Folding the sync into the same callback serialises them for free, with no
new locking primitive and no change to the store. It gates on elapsed time via
`lastCalendarSyncMs`, the way `refreshTick` already gates on `lastRefreshMs`.

Side effect worth having: an entry the sync adds is resolved by
`runTrackedTick` in the same pass, instead of waiting up to five minutes.

## Data flow

One sync, in order:

1. **Fetch** `TRACKED_ICS_URL` with a timeout. `webcal://` is accepted and
   rewritten to `https://`, because that is literally what Calendar.app puts on
   the clipboard.
2. **Parse** to `{ number, date, startMs }` triples. Drop cancelled events,
   events with no parseable flight number, and events outside the endpoint's
   today−1..+14 window. `startMs` exists only to order the next step — it is
   never stored, because the resolve pipeline is authoritative about times and
   a calendar's idea of a departure goes stale the moment the flight moves.
3. **Add**, soonest `startMs` first, up to `MAX_ENTRIES`, reusing
   `normaliseNumber` / `validateEntry` / `newEntry`. The cap, the window and
   the idempotency rule are therefore the same code the HTTP endpoint runs, not
   a parallel copy that can drift from it.
4. **Reconcile deletions** — remove entries the sync itself added that are no
   longer in the feed.

### What "no longer in the feed" means precisely

The comparison key is `(number, date)`, matching the store's own idempotency
key. An entry is deleted when all four hold:

- its `source` is `'calendar'`, and
- its `state` is not `'airborne'`, and
- its `date` is still inside the today−1..+14 window, and
- no in-window feed event shares its `(number, date)`.

The third condition is what stops the sync racing lifecycle at the boundary. An
entry ageing out of the window drops out of the feed set for a reason that has
nothing to do with the calendar, and expiry is lifecycle's job — the sync
declining to act there means one owner per transition rather than two.

A rebooking falls out of this correctly with no special case: the old
`(number, date)` leaves the feed and is deleted, the new one is added.

## The `source` field

`TrackedEntry` gains:

```ts
/** Who put this entry here. Null on entries stored before this field existed;
 *  read as 'manual', so the sync never deletes something it cannot prove it
 *  created. */
source: 'manual' | 'calendar' | null;
```

Same back-compatible-nullable pattern as `callsign` and `aircraftType`, and it
errs in the safe direction: an unknown provenance is never something the sync
feels entitled to delete.

## Four rules on deletion

Each exists to stop one specific failure, and none is cosmetic. Stated as a
single predicate in "What 'no longer in the feed' means precisely" above.

- **A failed or unparseable fetch skips the sync entirely — no adds, no
  deletes.** Otherwise a single transient iCloud 503 reads as "the calendar is
  empty" and wipes every tracked flight. The store is left exactly as it was.
- **Never delete an `airborne` entry.** If Flighty tidies an event mid-flight,
  the wall is still showing an aircraft that is genuinely in the air. Let
  lifecycle expire it 2h after landing.
- **Never touch a `manual` or `null`-source entry.** The hand-add form keeps
  working unchanged.
- **Never delete an entry whose date has left the window.** Its absence from
  the feed set says nothing about the calendar, and expiring it is lifecycle's
  job. One owner per transition, not two.

## Parsing

### Minimal RFC 5545 subset

The server ships one runtime dependency (`lz-string`). An ICS library would
double that to read four fields. What is needed:

1. **Unfold first.** RFC 5545 folds lines at 75 octets with a leading space or
   tab on continuations. This is the likeliest thing to break naive parsing: a
   folded `SUMMARY` splits *mid-flight-number*, so "DL1732" arrives as "DL17" +
   "32" and either fails to parse or parses as the wrong flight. Unfold before
   anything reads the text.
2. Split `BEGIN:VEVENT` … `END:VEVENT`.
3. Parse `NAME;PARAM=value:VALUE`. Params are not optional to handle — `TZID`
   lives there.
4. Unescape `\,` `\;` `\n` `\\`.

### Dates, and the off-by-one this codebase has already paid for

Two `DTSTART` forms, not equally useful:

| Form | Origin-local date |
|---|---|
| `DTSTART;TZID=America/New_York:20260914T183000` | **In the value**: `2026-09-14`. Exactly what AeroDataBox resolves against |
| `DTSTART:20260914T223000Z` | **Unrecoverable** without the origin's timezone |

Prefer `TZID`; fall back to the UTC date, accepting that a late-evening
westbound departure can resolve a day late. **Log which form the feed uses on
the first sync**, so the regime is known rather than assumed — `tick.ts` already
carries a scar from this class of bug, where a local-dated evening departure was
swept by the date backstop 55 minutes before pushback.

Deliberate non-change: `validateEntry` compares dates on a UTC-day axis via
`startOfUtcDay`, and the sync passes an origin-local date string into it. The
mismatch is ±1 day and bites only at the window edges, where the window is
already −1/+14. Immaterial, and not worth changing the endpoint's convention.

### Flight numbers

Regex over `SUMMARY`, falling back to `DESCRIPTION`: carrier shapes `[A-Z]{2}`,
`[A-Z]\d`, `\d[A-Z]` — covering B6, 9W, W6 — then an optional space, then 1–4
digits. The match is handed to `normaliseNumber` for the final say.

**Honest cost:** on a calendar holding anything other than flights this has
false positives. "Room 2B 101" parses as carrier 2B, flight 101. One false
positive costs one AeroDataBox resolution, goes `unresolved`, and expires in
24h — bounded, but not free. The mitigation is the dedicated flights-only
calendar that the privacy argument already wants.

Also: skip `STATUS:CANCELLED`, skip an unparseable `DTSTART`, and dedupe on
`(number, date)` before adding, since an airline's own invite can sit alongside
Flighty's event for the same leg.

## Config

- **`TRACKED_ICS_URL`** — absent means the sync never runs. Inert rather than
  broken, matching how tracked flights behave without OpenSky credentials.
- **No interval env var.** Hourly, hardcoded, with the rationale in a comment.
  The tick cadence already quantises it to multiples of 300s, so the knob would
  mostly be a way to get it wrong.
- **The URL is a secret.** It is a capability URL: anyone holding it reads the
  maintainer's flights, and their friends'. Never rendered on `GET /`, never in
  a status response, never logged in full — log the host only. This repo
  already established the rule when the audit replaced plaintext secrets with
  `wifiPasswordSet` booleans.
- **`GET /` gains a per-entry marker**, calendar vs by hand, so an entry
  disappearing on reconcile is explicable rather than mysterious.

## Failure modes

| Situation | Behaviour |
|---|---|
| iCloud 5xx, timeout, DNS failure | Log once, skip the sync — no adds, **no deletes**. Position polling continues untouched |
| Feed parses to zero flights | Legitimate (all flights past) → reconcile **does** delete. This is why it must be distinguishable from a failed fetch |
| More than 20 in-window flights | Add soonest-first to the cap, and **log how many were skipped**. Silent truncation would read as "tracking everything" |
| Event with no flight number | Skipped silently. Calendars contain non-flight events |
| Calendar published, then unpublished | Fetch 404s → treated as a failed fetch → store frozen, not wiped |

A calendar failure must never stop position polling. The sync is wrapped so that
a throw cannot escape into `runTrackedTick`.

## Testing

Mirrors `server/test/tracked/`.

`calendar.test.ts` — line unfolding (including a flight number split across the
fold), `TZID` vs `Z`, escaped text, `STATUS:CANCELLED`, events with no flight
number, carrier codes 9W / B6 / W6, duplicate events for one leg.

`sync.test.ts` — adds new; deletes its own that vanished; spares `manual`;
spares `null`-source; spares `airborne`; spares an entry whose date has left
the window; respects the cap soonest-first; filters the window; a rebooking
deletes the old leg and adds the new one; **fetch failure produces zero
mutations**; empty feed does delete.

A redacted real `.ics` goes in `server/fixtures/`.

## Open items

1. **A real Flighty VEVENT is required before the parser is written.** Publish
   the calendar, then paste one event (reservation number and seat redacted).
   It settles the `SUMMARY` format, the `DTSTART` form, and whether a friend's
   flight is distinguishable.
2. **Confirm Flighty's export destination is an iCloud calendar.** If Calendar
   Export offers no destination picker, create a dedicated "Flights" calendar
   and set it as the iOS default (Settings → Calendar → Default Calendar), then
   confirm the next Flighty event lands there. Publishing a general-purpose
   personal calendar would publish everything in it, not just flights.

## Not doing

- **Authenticating `/v1/tracked`.** Out of scope. The four existing guards are
  what bound an unauthenticated endpoint, and this design keeps all of them by
  reusing the same validation path.
- **Two-way sync.** The wall never writes back to the calendar.
- **Reading anything but flight number and date.** Route, aircraft and times all
  come from the existing resolve pipeline, which is authoritative; the calendar
  is a source of *intent*, not of flight data.
- **A dedicated ICS library, or a general calendar integration.** One feed, four
  fields.
- **Deleting on `STATUS:CANCELLED` mid-flight.** The airborne rule wins.
