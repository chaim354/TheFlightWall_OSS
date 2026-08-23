# Audit Priority List — derived from the 2026-08-23 simplification audit

**Source:** `docs/superpowers/audits/2026-08-23-simplification-audit.md` (1,455 lines, 43 accepted
findings, branch `claude/codebase-simplification-audit-2f73a3` @ `d58ed83`).
**This list:** a single ordered work plan that resolves the audit's tiers against its own later
amendments. Dated record, accurate as of 2026-08-23 against `d58ed83`.

The audit's `§2/§6` tiers were written *before* the X-02/X-04/X-05 rows landed, and are further
amended by the `C-5` merges, the `C-6` conflict, the `C-7` promotions and the `C-10` sequencing —
all filed in separate places. This document applies all of them in one pass and re-sorts firmware
work by **verification method** (`C-13`) rather than by subsystem.

Cost tags: `[desk]` no hardware, no deploy · `[deploy]` server only · `[uploadfs]` web assets only,
**erases `/settings.json`** · `[flash]` `pio run -t upload`.

---

## Verification done for this list

Eleven of the highest-ranked claims were re-checked against the tree at `d58ed83`. **All eleven hold:**

| Claim | Check | Result |
|---|---|---|
| F-TOOL01-A | `gen_starter_logos.py` SIZE vs shipped tiles | `SIZE = 16`; all 153 tiles are 2052 B (32×32) — confirmed |
| F-SRV13-A | generator emits `getAirportCoordByIata`? | 0 occurrences in generator, 1 in the generated file — confirmed |
| F-X05-A | heap fields rendered in `index.html` | `freeHeap` ×1; `largestInternal`/`largestDma`/`freeInternal`/`freePsram` ×0 — confirmed |
| F-SRV10-B | the write gate | `refresh.ts:57` `if (ok === 0)` — confirmed |
| F-FW05-A | Save button armed before load | `index.html:70`, no `disabled` — confirmed |
| F-FW05-C | unescaped SSID | `index.html:496` `${s.ssid||'-'}` into `innerHTML` — confirmed |
| F-FW11-A | LightSensor stores its pin? | `LightSensor.h:36-37` — two bools, no `_pin`, no `_type` — confirmed |
| F-FW03-A | `seedDefaults()` covers `serverUrl`/`positionSource`? | 0 matches in `Settings.cpp:74-122` — confirmed |
| F-FW10-A | console signals settings-changed? | 0 occurrences in `SerialConsole.cpp` — confirmed |
| F-FW08-A | `buildFlightLines` route codes | `Hub75Display.cpp:291-292` ICAO-only vs `:500-501` correct fallback — confirmed |
| F-FW03R-A | S3 ADC1 range vs HUB75 | `ADC1_PIN_MIN/MAX = 1/10`, HUB75 occupies 4–17 — confirmed |

---

## What this list changes vs. the audit's own tiers

1. **The four `index.html` findings are one flash unit, not two tiers.** The audit puts F-X05-A in
   Tier 1 and F-FW05-A/B/C in Tier 2 #9. All four are `index.html`-only and share a single
   `uploadfs`. Merged into one batch (**P6**).
2. **F-FW01-A is accepted but appears in no tier.** It is in the roll-up (`§ROLL-UP`, FW-01 row) and
   in the `C-6` conflict, but the final tier lists contain only F-FW01-**B**. Placed here at **P17**,
   sequenced after F-FW14-A per `C-6`.
3. **Gate 0 is promoted to its own step.** The decision memo (`C-15`) and the measurement flash
   (`C-14`) are prerequisites for ~a fifth of the ledger and are listed in Tier 4 as if they were
   work items. They are unblockers — send/run them first.
4. **Merges applied inline** (`C-5`): F-SRV10-A+B, F-FW09-A+B, F-FW04-A+B, F-X02-A→F-X01-A.
5. **`uploadfs` is not "no device".** The addendum tags F-X05-A as Tier 1 / no-device; it needs an
   `uploadfs`, which **erases `/settings.json`**. Back up per `HANDOFF.md:217-222` first.

---

## GATE 0 — unblockers, before any device work

**G1. Send the decision memo** (`C-15`) `[desk]`
Eight questions, none engineering-blocked, gating ~a fifth of the ledger. Ask once:
`note` field — delete or fix the mode echo? · tail numbers on the roadmap (F-FW07-A)? ·
`ident_iata` — delete or wire the marketing number? · which accent key is canonical (F-FW06-B)? ·
does the Worker keep refreshing (F-SRV01-A)? · F-SRV07-A — fix both sides or document both? ·
accept the KV migration + rebuild window (F-SRV15-A)? · adopt skip-if-exists everywhere (F-TOOL01-A)?

**G2. One `-DCORE_DEBUG_LEVEL=4` build of *unmodified* HEAD** (`C-14`) `[flash]`
On a trip you are making anyway. Simultaneously settles F-FW09-A's branch choice (prediction: one
fresh `connected to %s:%u` per `getJson()`, zero reuse lines), captures the live FR24 payload
F-FW12-A cannot be discharged without, and produces the heap baseline four RAM claims assert with
no number. **Do not choose F-FW09-A's branch by reading** — its alternative is the only change in
the ledger whose failure mode is a silent OOM coredump on a wall-mounted board.

---

## TIER 1 — Traps. No hardware, no deploy, everything fails loudly.

> The audit's "best first slice": ~1–1.5 days, and it removes every trap the rest of the plan
> would otherwise spring.

**P1. F-TOOL01-A (Tier-1 slice, ~4 lines)** `[desk]` — *the documented command is destructive today*
`README.md:170` tells you to run `python3 tools/gen_starter_logos.py`. Doing so **overwrites 78 of
the 153 shipped 32×32 tiles with 516-byte 16×16 tiles**, no prompt, no skip guard — while its
sibling `gen_cargo_logos.py:143-145` refuses to touch anything that exists. Five assertions of the
tile size across the toolchain, two different values.
*Fix:* `gen_starter_logos.py` SIZE→32, adjust SCALE/gap, fix the two argparse defaults.
*Ride along:* the README `--size` flags (F-X04-A(d)) and making `--size` an arg defaulting to 32.
⚠️ This directory holds the maintainer's local trademarked artwork — never bulk-commit
(`HANDOFF.md:194-198`).

**P2. F-SRV13-A** `[desk]` — *a first-class npm script deletes working code*
`npm run gen:airports` (`package.json:14`) regenerates `airports.ts` from a template that never
emits `iataIndex`/`iataToIcao()`/`getAirportCoordByIata()` — 42 hand-written lines added in
`e538c05` and out of sync since 2026-08-21. It takes out the PANYNJ provider's only route to
coordinates. Failure is loud (TS import error), but recovery means knowing which 42 lines to
re-apply, against an unreviewable 143,117-character diff.
*Fix:* split `airports.data.ts` (generated) from `airports.ts` (hand-owned). Move the 143 KB line
byte-for-byte; do **not** regenerate as part of this change.

**P3. F-FW14-A (minimum tier, ~12 lines) → F-FW14-B** `[desk]` — *the host suite cannot report failure*
`platformio.ini:7-13` and `:83-87` both state the collision-prevention mechanism **incorrectly** —
refuted by the very commit that introduced them (`c685fa1`: "the filter alone left the exact same
link error"). The mechanism that works is duplicated into all eight test files, each pointing
readers at the wrong comment.
And there is no runner: the only invocation is a shell loop typed into `HANDOFF.md:25` and `:224`,
already stale in two other docs, and `g++ … && /tmp/t_$t` inside a bare `for` **discards each
iteration's status** — the loop's exit code is the last iteration's alone. Five of eight print a
bare `ALL PASS`, indistinguishable from each other.
*Order is load-bearing:* A before B (B's runner globs the files A moves).
*Promoted by `C-11`:* there is **no `native` env** — these eight bare-g++ tests are the only
off-device coverage that exists, and three findings justify themselves by "makes this host-testable
for the first time".

**P4. F-SRV16-A** `[desk]` — *the test suite disagrees with itself* — **do after P2**
Five test sites carry `KLGA 40.7769/-73.8740`, a pair `8556a5a` **deleted** from production;
production now says `40.7772/-73.8726`. JFK has three distinct literals. Nothing fails today (120 m
against a 300 km corridor gate) — the hazard is that the drift is silent and one-directional, so
any future work tightening corridor geometry gets validated against positions production never emits.
*Fix:* `const LGA = getAirportCoord('KLGA')!;` — 5 sites, 3 files. Leave `airports.test.ts` alone;
it is the oracle and must keep its hand-typed literals.

---

## TIER 2 — Server live defects. Deploy only, no device.

**P5a. F-SRV10-B → F-SRV10-A** `[deploy]` — **merge, B first** (`C-5`; the emptiness test must run
on the merged output, or the two encode different predicates over different arrays)

- **B — the write gate counts fetches, not rows.** `refresh.ts:57` guards `if (ok === 0)`, where
  `ok` counts fetches that did not throw. So `ok > 0 && rows.length === 0` **writes an empty table
  with a fresh `builtAtMs`** — and `store.ts:92-94` derives staleness from `builtAtMs` alone, so it
  reports `stale:false` with zero routes and rewrites itself identically every cron tick.
  Self-sustaining and invisible. `parseFids` returns `[]` silently on a payload-shape change.
- **A — cross-board duplicate rows blank the route.** Every board is fetched
  `?withLeg=true&direction=Both`, so a JFK→BOS leg is built **field-for-field identically** from
  both the KJFK and KBOS boards. `join.ts:171` `if (exact.length > 1) return null`, and the
  tiebreak path gives a delta of 0 < `TIEBREAK_MARGIN_KM`. Fixture evidence: seven JFK↔BOS legs
  duplicate from one board pairing. **Deterministic blank route for inter-board shuttle traffic —
  i.e. flights directly over the panel's own coverage.** The invariant is stated at
  `refresh.ts:86-99` and enforced only on the PANYNJ path, which is disabled in production.
  *Fix:* route the write through the `mergeByFlight` that already exists.

**P5b. F-SRV10-C (partial-board)** `[deploy]` — *the gap neither B nor F-SRV12-A closes* (`C-3`)
If **one** board's payload shape changes, the other three still contribute, so neither `ok === 0`
nor B's `rows.length === 0` fires. A table missing a quarter of its coverage is written fresh and
reads as healthy. This is the *more likely* case. Needs a per-board outcome record (N-of-M, or
per-board coverage stored in the table).

**P5c. F-SRV12-A** `[deploy]` — defence-in-depth behind B, **never a substitute**
`fetchBoard` collapses "empty board", "unparseable payload" and "unknown board ICAO" into one `[]`.

**P6-server. F-SRV08-A** `[deploy]` — *a 3 s timeout blanks a route for 30 minutes*
`routeLookup.ts:174-190` returns the same `null` for 404, 429, 502, 403, timeout and DNS failure;
`:225-228` writes it as a definitive negative at `NEG_TTL_MS = 30 min`. The rationale at `:53-63`
justifying 30 minutes is written **entirely about the definitively-answered case**. An IP-level
block or 429 poisons every callsign asked during it, on a module that exists as the last resort for
flights that would otherwise render blank — for an aircraft overhead a few minutes.
*In-repo precedent:* the firmware's identical cache uses a failure TTL **30× shorter** (60 s).
*Fix:* give `getText` a reason (`body`/`no-record`/`unreachable`); TTL follows the reason. Existing
tests pass unchanged. Classify only 429/5xx/throws as unreachable.

**P7. F-SRV09R-A + F-SRV09R-B** `[deploy]`

- **A — invalid shape reports FRESH, forever.** `fileStorage.ts:28` casts `JSON.parse(raw) as
  StoredSchedule` unchecked. For `{"index":{}}`, `nowMs - s.builtAtMs` is `NaN` and `NaN > STALE`
  is **false**. Then `flights.ts:94-98` throws a `TypeError` the `.catch()` thirty lines earlier
  does not cover → a 500 on *every* request (Node), no catch at all (Worker). The codebase already
  knows the type lies: `refresh.ts:217-219` hand-rolls exactly the guard `flights.ts` lacks.
  *Fix:* narrow inside `loadSchedule` — this **deletes** the ad-hoc guard and closes the KV path too.
- **B — orphaned temp files accumulate on ENOSPC.** `fileStorage.ts:59` `await writeFile(tmp, …)`
  sits **outside** the `try`. Each attempt embeds a fresh UUID, so failures accumulate one file per
  attempt — a positive feedback loop on a full disk, every two hours, forever.
  *Fix:* move one `await` inside the existing `try`. **Keep the UUID** (Kamal runs both containers
  against the same volume during a deploy).

---

## TIER 3 — First device trip: `uploadfs` only. Cheapest device work in the audit.

⚠️ **Back up `/settings.json` first** — `uploadfs` erases LittleFS (`HANDOFF.md:217-222`).

**P8. The `index.html` batch — one flash unit, four findings** `[uploadfs]`
Do this on the first trip you make: it repairs the diagnostic channel every other item is debugged
through.

- **F-X05-A — the web UI shows the one number documented as having misled a live diagnosis.**
  `index.html` renders `freeHeap` ×1 and `largestInternal`/`largestDma`/`freeInternal`/`freePsram`
  **×0 each**, while `WebConfigServer.cpp` produces all five. Its own comment at `:165-179` says
  "freeHeap ALONE is misleading, and it misled a live diagnosis: the device was failing every fetch
  with ~174 KB free, which reads healthy". The producer half shipped; the consumer half did not.
  **No C++ change needed** — `/api/status` already ships the data. Guard with `'largestInternal' in s`.
  *Subsumes F-FW04-A and F-FW04-B as one defect class* (per the addendum).
- **F-FW05-A — Save can persist a blank form over live config.** `index.html:70` has no `disabled`;
  `loadSettings()` has no guard and records nothing on success. Clicking Save on an unloaded form
  sends a **complete, fully-populated document of HTML defaults**: blank SSID/PSK (→ next boot lands
  in the open setup AP), all three API keys blanked, `panelResX/Y/Chain: 0` (→ a 0×0 matrix),
  brightness 0, mode forced to "area". **Worse than a factory reset, persisted atomically** — and
  it is exactly what the atomic-save work exists to prevent, reached by another route. Recovery
  needs serial or a reflash. The window is wide: `/api/settings` routinely takes seconds while the
  form sits blank and Save sits armed.
  *Fix:* ship `disabled` in the static HTML; clear it only on `loadSettings()`'s success path. ~+70–85 B gzipped.
- **F-FW05-C — SECURITY: unescaped SSID into `innerHTML`.** `index.html:496` interpolates
  `s.ssid` (i.e. `WiFi.SSID()` — attacker-supplied from the local RF environment) with no `esc()`.
  The file's own comment at `:310-315` states the rule, and `:480` applies it correctly to the scan
  list. **Fix is 5 bytes.** Payload would execute in the config UI's own origin, which can rewrite
  settings via the same endpoint.
- **F-FW05-B — `setInterval` polling overlaps.** `:533` fires on wall-clock against a device that
  serves one request per `loop()` and blocks for seconds, so a stale snapshot can land on top of a
  fresh one. *Fix:* self-rescheduling `setTimeout`; the `clearTimeout` is load-bearing. ~+15 B gzipped.

---

## TIER 4 — Second device trip: firmware flash. Batch everything below into one trip.

> `C-13`: keep commits fine (bisectable), flashes coarse. 21 accepted findings cannot reach the
> device without `pio run -t upload` — sort by verification method, not by subsystem.

### 4a — Live defects

**P9. F-FW11-A → P10. F-FW10-A** `[flash]` — **order is load-bearing** (`C-10`)
F-FW11-A's severity is *latent* once F-FW10-A lands, **and it must be implemented first** —
precisely because the other order closes the only demonstrated route to the bug while leaving the
representational hazard fully alive and making the finding look unnecessary.

- **F-FW11-A — latched-dark panel blanking.** `LightSensor.h:36-37` is the entire init state: two
  bools, neither recording *which* pin or *which* type was brought up, while `readSensor()`
  dispatches on live settings. Set a non-ADC1 pin over serial → `_analogReady` stays true →
  `analogRead()` returns **0** → the `v < 0` fail-safe is skipped → `_dark = true` latches
  permanently → `main.cpp:288-289` blanks the panel. Both documented guards defeated at once, and
  reachable through the console's own printed advice.
  *Minimum stopping point:* the 3-line pin capture alone fixes the reachable failure.
  ⚠️ `C-21`: rests on the unverifiable external premise that `analogRead(<non-ADC pin>)` returns 0,
  not −1. If it returns negative, the fail-safe fires and there is no bug. **Confirm on hardware.**
- **F-FW10-A — the console is the only writer that neither re-applies nor announces.** Eight
  mutate-then-save sites, none signalling; `main.cpp:587-603` is the only place latched state is
  re-derived and it is gated solely on the *web* flag. Four latched groups affected (timezone,
  light, buttons, maxFlights). Self-contradiction, entirely within one file: `:42` tells the user to
  enable the sensor "via `set`", and doing so makes the very next `light` print `NO READING` **on
  correctly wired hardware**. `:282` prints "Settings applied + saved." — "applied" is false.
  *Fix:* the same one-shot flag `WebConfigServer` already has. Use `|`, not `||`, at `main.cpp:587`.

**P11. F-FW03-A (+ `TimingConfiguration.h` fold-in)** `[flash]` — *the documented escape hatch does
not reset what it promises*
`seedDefaults()` is a hand-maintained second copy of ~30 defaults, and **neither `serverUrl` nor
`positionSource` is assigned anywhere in it** — so `erase` ("reset to defaults") leaves a bad
`serverUrl` in place and writes it back. If a bad server URL is what you are escaping, the escape
hatch does not clear it. Second, independent drift: `Settings.h:133-134` says San Francisco,
`UserConfiguration.h:9-10` says JFK, and `:16-17` states "They must agree." They do not — and which
default you get depends on which of four `begin()` paths ran.
*Fix:* `seedDefaults()` becomes `*this = Settings();` plus the five `Secrets.h` credentials. A field
added to the struct is then automatically in the reset path; the omission class becomes
unrepresentable. Net ~40 lines removed.
⚠️ `C-11`: both proposed tests are on-target only — this is flash-session work, not desk work.

**P12. F-FW03R-A** `[flash]` — *seven of ten "valid" ADC1 pins are live HUB75 data lines*
On the S3, `ADC1_PIN_MIN/MAX = 1/10` while HUB75 occupies 4–17, and `isValidAdc1Pin` only
range-checks. **Pins 4–10 are simultaneously "valid ADC1" and R1/G1/B1/R2/G2/B2/A.** The UI
*advertises* the bad range: `/api/status` publishes `adc1Min/adc1Max`, `index.html:259` renders
"Analog pin (ADC1: 1-10)", and `Settings.cpp:466-467` accepts the POSTed value with no validation.
The irony: the guard exists because "an unchecked pin could point analogRead() at a live PSRAM
line" — it guards PSRAM and not the panel's own data lines. This bug class **already shipped once**
in this same file (GPIO 21 double-booked, "forty lines below, same file").
*Fix:* `constexpr bool isHub75Pin(int)` + ~12 `static_assert`s + one runtime `&& !isHub75Pin(pin)`.
*Honest note:* this **adds** ~15 lines. It qualifies as invalid-state removal, not line reduction.

**P13. F-FW08-A** `[flash]` — *no route line at all on non-default panel geometries*
`Hub75Display.cpp:291-292` reads `code_icao` only, where `:500-501` and `WebConfigServer.cpp:197-200`
both apply the documented IATA-preferred fallback correctly. Server- and FR24-sourced flights carry
**only** `code_iata`, so `origin.length() || dest.length()` is false and the row is silently dropped.
`WebConfigServer.cpp:223-227` carries a comment documenting that this exact bug was found and fixed
once — **in the web list. The panel copy was never fixed.**
*Fix:* `String displayCode() const` on `AirportInfo` — the rule the header already asserts, moved
from prose into the one place all three readers pass through.
⚠️ **`C-9` correction:** the **shipped default (128×64) does not exhibit this.** It affects 64×32,
128×32, 160×32 and single-panel 64×64 builds. Verify cheaply: set `panelChain=1`, Save, Restart,
observe, revert.

### 4b — Model simplifications. Compile-loud, batch nearly free on the same trip.

**P14–P16.** In the audit's order, all `[flash]` unless noted:
F-X01-A (**server-only, no reflash**; F-X02-A merges in here — the real defect is that metric `vs`
is m/**min**, contradicting the project's own SI convention, plus a silent `units` fallback with no
test and no echo) · F-FW02-A · F-FW07-B · F-FW12-C (`renderable()` — a *documented safety guard*
with zero callers) · F-FW08-B (+`bearing_deg`) · F-FW07-A · F-FW12-B · F-FW06-A · F-FW06-C
(`miniVr` renders AeroAPI's ±1.0 sentinel as "level"; structurally identical to F-FW08-A) ·
F-SRV02-A `[deploy]` · F-SRV03-C `[deploy]` · F-TOOL01-B `[desk]` · F-FW12-A de-dup half ·
F-SRV04-A `[deploy]` · F-X01-B (2 lines).

**P17. F-FW01-A** `[flash]` — **missing from the audit's tiers entirely; sequenced here**
Two mutually-shadowing backoff ladders; combine by `max()` instead of precedence.
⚠️ `C-6` **hard conflict:** it prescribes a new `firmware/test/test_fetchcadence.cpp`, and F-FW14-A
(P3) moves the eight host tests *out* of `firmware/test/`. **Do P3 first, or write the new test to
the new location** — otherwise it re-incurs the guard tax the audit named as its own evidence.

**P18. F-X04-A(a)(b)(c)** `[desk]` — *the most expensive doc claims in the repo*
(a) `README.md:42-51` gives the **classic-ESP32 pin map with no target label**, on a page that
recommends the S3 at `:12`. On an S3 those GPIOs are nonexistent / SPI flash / PSRAM — a reader
solders a breakout from this table on the recommended board and it cannot work. **Hours with a
soldering iron.** (b) `:146` repeats verbatim the mistake the firmware went out of its way to fix
(classic-only sensor pins). (c) `firmware/README.md:12` documents `/api/framebuffer`, which does not
exist — the preview was deliberately removed in `17b213c`; the README was never updated.
*Ride (d)(e) along with P1:* the `--size` flags, and two docs linking a dated plan as live
deployment instructions.

---

## TIER 5 — Gated. Do not start until Gate 0 answers land.

- **F-FW09-A** — *the class's central claim is not achieved.* `HttpJson.cpp:19` declares
  `HTTPClient http;` as a **stack local**, whose destructor unconditionally calls `_client->stop()`
  on the shared `_secure` — freeing the mbedTLS buffers. `setReuse(true)` is inert. At
  `maxFlights=12` the design intends ~2 handshakes per cycle and performs up to **~48**, each
  needing the ~40 KB contiguous block that colour depth was dropped 8→6 bits to widen.
  **Branch choice is gated on G2** — the behaviour-restoring variant may be a net loss on esp32dev.
  Merge with F-FW09-B (66-line file, same 13-line banner).
- **F-FW12-A migration half** — needs the live FR24 capture from G2.
- **F-X03-A + F-X03-B** — *the maintainer's own deferred items* (`HANDOFF.md:153-156`), not audit
  discoveries. A: serve a redacted projection from `GET /api/settings` — the UI never needs the
  values back, and it also kills a real bug (a stale tab overwrites newer credentials). **Ship
  firmware and UI together**, or a cached old page posts empty strings and wipes the PSK. B: AP mode
  is **absorbing** — `g_apMode` is set and *never cleared*, gating the entire self-heal reboot
  block, so a power outage that restores mains before the router finishes booting strands the device
  broadcasting an **open** AP permanently. **If only one ships, ship A.**
- **F-SRV07-A** (both sides or neither) · **F-SRV01-A** (product) · **F-FW06-B** (which accent key) ·
  **F-FW08-B's `ident_iata` fork**.

**LAST OR NEVER — F-SRV15-A** (`C-16`). Conflicts with six other server findings, is the only
finding carrying a persisted-storage migration against backends that deserialize with an unchecked
cast, and its `KV_KEY` v2 bump would ship a deliberate empty-table window **through the very logic
P5a and P7 exist to harden against.**

---

## TIER 6 — Fold-in only

F-SRV03-A (into F-SRV03-C) · F-FW02-B · F-FW09-B (into F-FW09-A) · F-FW01-B (⚠️ `C-4`: under-scoped
— there are **three** `ESP.restart()` sites, including `SerialConsole.cpp:323`; coordinate with P10) ·
F-FW10-B · F-SRV09-B · F-SRV07-B · F-X04-A snapshot-header lines · `gen_starter_logos.py --size`
default (ride with P1) · ~10 sub-threshold one-liners.

## REJECTED (8)

F-SRV11-A, F-SRV11-B (disabled path) · F-FW02-B as a standalone · F-FW10-B as a simplification ·
F-SRV07-B (`unknown` destroys load-bearing wire documentation) · F-X02-B · F-X04-B · F-X05-B
(mandating `[tag]` logging: 145 call sites, and *"the six costumes are evidence for the RULE, not
for a formatting convention"*).

---

## Read before coding from any of this

1. **Validation is missing on 22 of 43 findings and thin on 13 more** — including four
   HIGH-materiality items (F-FW08-A, F-FW11-A, F-FW05-A, F-TOOL01-A). Scope/interfaces are thin on
   ~24. *The evidence layer is strong; the implementation layer needs filling per-finding.*
2. **Six citation errata** at `C-17` — including one on the only security finding (F-FW05-C: the
   SSID source is `WebConfigServer.cpp:155`, not `:151`). ~8% of ~150 citations are imprecise;
   none fabricated, but not tight enough to paste into an editor.
3. **Firmware findings rest on unlabelled out-of-repo library behaviour** (`C-21`) — most sharply
   F-FW11-A's `analogRead` premise and F-FW09-A's `HTTPClient` semantics, asserted against a
   toolchain `platformio.ini` pins only in prose (`platform = espressif32`, no version constraint).
4. **Read `HANDOFF.md` §3 "Open items" first.** Two findings turned out to be already recorded
   there (the credential exposure, the `framebuffer()` dead code). It is the maintainer's own defect
   ledger and it is current.
5. **`P-1` is the lens worth keeping.** Eleven accepted findings are one defect wearing different
   clothes: *a value that is absent, stale or wrong renders as blank/zero/healthy rather than as an
   error.* The codebase knows this rule and applies it unevenly.
