# Decision memo — Gate 0 of the audit priority list

**Companion to** `2026-08-23-priority-list.md` (item **G1**), which is derived from
`2026-08-23-simplification-audit.md`. Dated record, accurate as of 2026-08-23.

Eight open questions. **None is engineering-blocked** — each is a product, roadmap or
budget call that only the maintainer can make, and between them they gate roughly a fifth
of the audit's ledger (most of Tier 4 and Tier 5). The audit's `C-20` found that four of
these had been filed as *accepted findings* when they are really open questions; this memo
is the correction.

Answer whenever — nothing in Tiers 1–3 waits on them.

> **Q9 was raised while implementing Tier 2** and is listed after the original eight.

> **Q8 is already answered and closed.** *"Adopt skip-if-exists in the logo generators?"* —
> **yes, with `--force`**, shipped in `5b18438`. Left here so the count matches the audit.

---

## Q1 — `note` on `/api/status`: delete it, or fix the mode echo?
**Finding:** F-FW04-B · **Gates:** Tier 3 (the `index.html` batch) · **Cost either way:** ~3 lines

`_lastNote` only ever holds one of four string literals, pushed from `main.cpp:389`, `:436`
and `:450-451`. Nothing reads it: no consumer in `index.html`, and `git log -S'note'` shows
it has *never* been rendered, while the field dates to the initial import. Worse, half its
value space duplicates `mode` — which `/api/status` emits **live** from `g_settings` on the
line above — so after a mode switch the payload contradicts itself (`mode:"area"` beside
`note:"flights mode"`) for up to a full fetch interval.

**But** this codebase deliberately ships curl-only diagnostics the HTML never renders:
`WebConfigServer.cpp:166-175` argues at length for the heap-block fields precisely because
HTTP is "the only channel available when the board is mounted on a wall", and `rssi` is
likewise unrendered. So an unread fetch-outcome string may be intentional.

- **(a) Delete it.** Simplest. Loses a diagnostic you may have meant to keep.
- **(b) Keep it, stop overwriting it with the mode echo** so it always means "last fetch
  outcome". The fix lives at `main.cpp:450-451`. ← *audit's recommendation*

**Note:** F-X05-A subsumes this. Tier 3 already surfaces the four heap fields the UI never
showed; if `note` is meant to be a diagnostic, that batch is where it should start being
rendered. Answering (b) makes it one more field in that same edit.

---

## Q2 — Are tail numbers on the roadmap?
**Finding:** F-FW07-A · **Gates:** Tier 4 · **Cost:** deletion is ~4 lines

`StateVector.registration` and `StateVector.position_source` are written by the fetchers and
read by nothing. Deleting them forecloses ever showing an aircraft's tail number on the
panel without re-plumbing the field.

Correct the RAM argument if you saw it earlier: the audit's own `C-2` **struck** the
"~1.3–1.6 KB" figure as wrong (arduino-esp32 `String` *does* have SSO — a 6-char
registration never heap-allocates). Real cost is **~20 bytes of struct footprint per state
vector**. So this is a roadmap question, not a memory one.

- **(a) No plans** → delete both fields.
- **(b) Maybe** → keep `registration`, delete `position_source` (which has no product story
  at all), and add a comment saying why it's carried.

---

## Q3 — `ident_iata`: delete it, or wire up the marketing number?
**Finding:** F-FW08-B · **Gates:** Tier 4

Three writers, **zero readers**. Unlike Q2 this one is populated on most flights, so it
costs a real allocation per flight in the same internal-RAM pool the TLS handshake competes
for.

The product fork underneath: the server ships `flt` as the **marketing** number
(`enrich.ts:234` → `"DL5075"`) where `cs` is the **operating** callsign (`"EDV5075"`). Those
differ for every regional-carrier flight — a Delta-branded flight actually operated by
Endeavor. Right now the device pays to carry the marketing number and displays the operating
one.

- **(a) Delete** → treat "show the marketing number" as a separate product change later.
  ← *audit's recommendation*
- **(b) Wire it up** → show `DL5075` instead of `EDV5075` on the card. A visible product
  change, arguably the more recognisable one for a wall display.

Status quo — paying the allocation on every flight to display nothing — is not defensible
either way.

---

## Q4 — Which accent key is canonical?
**Finding:** F-FW06-B · **Gates:** Tier 4/5 · **This one changes pixels**

Two call sites derive the colour key differently for the same flight:

| Site | Key |
|---|---|
| `Hub75Display.cpp:452` (badge fill) | `operator_icao`, else the uppercased **first two chars** of iata/icao/operator_code |
| `Hub75Display.cpp:757` (side-by-side separator) | `operator_icao`, else the **full** `operator_code` |

`accentColorFor` is FNV-1a, so for any flight **without** `operator_icao` the badge and the
separator get completely unrelated hues. Unifying them is cosmetically better but visibly
different from today, so it needs your call rather than mine:

- **(a) Full `operator_code`** — more input, fewer hash collisions between carriers.
- **(b) First two chars** — matches what the badge already draws, so the badge's colour
  stops changing.

Look at a GA/private flight (no `operator_icao`) on the panel before deciding — that's the
only case where they differ.

---

## Q5 — Does the Worker keep refreshing the schedule?
**Finding:** F-SRV01-A · **Gates:** Tier 5 · **Possible budget impact**

Proven drift: commit `1ce76ac` ("halve the AeroDataBox cadence") changed `server.ts` to 2 h
but **did not touch `wrangler.toml`**, which still carries `crons = ["0 */6 * * *"]` and the
*pre-fix* rationale that `server.ts:47-66` explicitly refutes.

`server.ts:59-64` computes the API budget as if there were **one** refresher: 2,880
units/month. Two refreshers at 6 h + 2 h on one key is **3,840 of 6,000** — and the obvious
fix is unavailable, since bumping the cron to 2 h puts both at 5,760, the number `server.ts`
already rejects as having "no margin for a retry storm".

**One thing I cannot check from the repo:** whether `wrangler secret put AERODATABOX_KEY`
and the Kamal secret (`config/deploy.yml:66`) hold the **same** key. If they're two accounts,
the budget argument evaporates and only the comment contradiction remains.

- **First:** same key or two? (Decisive test: do monthly units track ~3,840 or ~2,880?)
- **(a) Worker is fetch-only** → delete `[triggers]` and the `scheduled` handler. ⚠️ Its KV
  table then never refreshes and `/v1/flights` permanently returns routeless flights — a
  visible regression for anyone still pointing a device at the Worker URL.
- **(b) Keep it at 6 h**, with a comment cross-referencing `server.ts`'s `TWO_HOURS_MS`
  rationale and recording the combined spend. Not a simplification, but it converts silent
  drift into a stated decision — which is most of the value. ← *audit's narrowing*

---

## Q6 — The `"ground"` sentinel: fix both sides, or document both?
**Finding:** F-SRV07-A · **Gates:** Tier 5

`adsblol.ts:56-57` gates altitude on `onGround`, but `:69` (`verticalRateFpm`) has **no
ground gate**, though the two fallback chains are otherwise identical. In the captured
fixture, 74 rows are `"alt_baro":"ground"` and 2 of them carry a rate — both `adsr_icao`
rebroadcast rows, a recurring class rather than a one-off. The invalid combination has
already leaked into the tests as the normal shape.

Provably **ETA-neutral** (`eta.ts:165`/`:209` return early when altitude is null, always true
on the ground). Only the `vs` wire field changes.

The catch: `firmware/adapters/AdsbLolFetcher.cpp` carries an independent copy of the same
parse with the **identical** asymmetry. Fix only the server and a device on the server path
renders `vs` differently from a device on the direct path.

- **(a) Fix both sides** — server + firmware, one flash trip.
- **(b) Document both** — a comment at each site saying the rate is deliberately ungated.

Either is defensible. The current **undocumented** state is the one that isn't.

---

## Q7 — Accept a KV migration and its rebuild window?
**Finding:** F-SRV15-A · **Gates:** everything else in the server — **do this LAST or never**

Pairing each end's coordinates (`{lat, lon}` instead of four independent nullables) is a
genuinely better model. It is also the single riskiest item in the audit:

- Conflicts with **six** other server findings (`refresh.ts`, `aerodatabox.ts`, `panynj.ts`,
  `join.ts`, `enrich.ts`, `store.ts`).
- The **only** finding carrying a persisted-storage migration — against backends that
  deserialize with an unchecked cast (the hole P7/F-SRV09R-A exists to close).
- Its `KV_KEY` v2 bump ships a deliberate **empty-table window** through the very logic
  F-SRV10-B and F-SRV09-B exist to harden against.

**Recommendation: defer indefinitely.** Revisit only if you're bumping `schedule:v2` for
another reason anyway — then it rides along nearly free. `C-7` notes the same modelling win
is available at a fraction of the cost via **F-SRV03-C** (`EnrichOptions.centerLat/centerLon`
→ one `LatLon`), which has no persisted shape, no key bump and no rebuild window. That one is
already in Tier 4.

---

## Q9 — Should partial board coverage block the write? *(raised during Tier 2)*
**Finding:** F-SRV10-C · **Gates:** nothing — the visible half already shipped · **Needs production data**

Not one of the original eight. It came up implementing F-SRV10-C in `88741e2`.

If one board yields no rows while the others contribute, the table is written a
quarter short with a fresh `builtAtMs` and reads as perfectly healthy. Every plausible
cause is a defect — a payload-shape change `parseFids` returned `[]` for, a board ICAO
`getAirportCoord` does not know, a board throttled into an empty body — because a 12 h
FIDS window at KJFK/KLGA/KEWR/KBOS is never legitimately empty.

**Shipped:** barren boards are now tracked separately from "boards that answered" and
named on the operator's channel. The failure is no longer invisible.

**Not shipped, and deliberately:** whether a coverage floor should also *block* the
write. The trade is real in both directions — storing partial coverage beats discarding
it, but a complete 2 h-old table beats a fresh table missing a quarter of its rows.

- **(a) Report only** — where it stands now. ← *safe default*
- **(b) N-of-M floor** — refuse the write below some fraction. Needs a number, and
  picking one without knowing how often this fires is guessing.
- **(c) Compare against the previous table** — keep the old one if row count collapses.
  Self-calibrating, but needs a read-before-write in `refreshSchedule` (which currently
  does not read at all) and could misfire on a genuinely quiet window.

**Recommendation: leave it at (a) until the new log line has fired in production at
least once.** Then you'll know whether this is a once-a-year event or a weekly one,
which is exactly the fact that decides between (b) and (c).

---

## Summary

| # | Question | Finding | Gates | My default if you don't answer |
|---|---|---|---|---|
| 1 | `note`: delete or fix the echo? | F-FW04-B | Tier 3 | (b) fix the echo, fold into the web-UI batch |
| 2 | Tail numbers on the roadmap? | F-FW07-A | Tier 4 | (a) delete both fields |
| 3 | `ident_iata`: delete or wire up? | F-FW08-B | Tier 4 | (a) delete; marketing number as its own change |
| 4 | Which accent key is canonical? | F-FW06-B | Tier 4/5 | **blocked — changes pixels, won't guess** |
| 5 | Worker keeps refreshing? | F-SRV01-A | Tier 5 | (b) keep 6 h, add the cross-reference comment |
| 6 | Ground sentinel: fix or document? | F-SRV07-A | Tier 5 | (a) fix both sides on the next flash trip |
| 7 | Accept the KV migration? | F-SRV15-A | last/never | defer; take F-SRV03-C instead |
| 9 | Coverage floor block the write? | F-SRV10-C | nothing | (a) report only, until it fires once in production |

**G2 (the other half of Gate 0) is yours to run:** one `-DCORE_DEBUG_LEVEL=4` build of
*unmodified* HEAD, on a trip you're making anyway. It simultaneously settles F-FW09-A's
branch choice, captures the live FR24 payload F-FW12-A needs, and produces the heap baseline
four RAM claims currently assert with no number. Do **not** pick F-FW09-A's branch by reading
— its alternative is the only change in the ledger whose failure mode is a silent
out-of-memory coredump on a wall-mounted device.
