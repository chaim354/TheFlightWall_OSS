# Don't poll while the panel is dark — design

**Dated record.** Written 2026-08-23 against `claude/audit-priority-list-d3dbf5`.

## Problem

The device fetches every 30s regardless of whether anything is on screen. With the
night schedule set to `nightBrightness: 0` from 23:00 to 07:00, that is ~960
fetches per night rendering to a dark panel — each one a TLS handshake on a link
that is measurably fragile (see the 2026-08-23 RF investigation: the HUB75 I2S
clock degrades WiFi, and 8 MHz with a reseated ribbon is the usable floor).

The server side follows for free on positions — adsb.lol is fetched per
`/v1/flights` request — but the AeroDataBox schedule refresh is a timer and runs
regardless of any device.

## Decisions taken

| Question | Decision |
|---|---|
| What counts as "off"? | **Effective brightness 0, any cause** |
| Waking | **Drop stale flights, fetch immediately, show the loading screen** |
| Server | **Quiet hours on a fixed schedule**, shipped **enabled**, default **00:00–07:00** |

## Device

### Suppressing the fetch

`applyBrightness()` already resolves five sources — base setting, night schedule,
ambient sensor, manual button ramp, `g_panelOff` — into one value,
`g_appliedBrightness`. That is the authoritative "is the panel dark" signal and
the gate hooks it directly:

```
if (g_appliedBrightness == 0)  -> skip the fetch this pass
```

No new state and no second notion of "off". It inherits every cause, including
the night schedule, which is where the volume actually is.

**Ordering matters:** the gate must sit AFTER `applyBrightness()` runs in
`loop()`, or it reads a stale value on the pass where brightness changes.

### Waking

Suppression must not leave the panel showing aircraft that have landed. On the
transition from suppressed to not-suppressed:

1. If the held flights are older than the existing stale window
   (`fetchIntervalSeconds * 6`), clear them — reusing the rule already applied on
   the failure path, not inventing a second one.
2. Force an immediate fetch (`g_lastFetchMs = 0`).
3. The panel shows the loading screen for a second or two.

Showing a stale set briefly was considered and rejected: it is the
"plausible-looking wrong value" this codebase's own logging rule treats as a
silent failure.

### What must NOT change

- The backoff ladders. Suppression is not failure: `g_consecutiveFailures` and
  `g_consecutiveEmpty` must not increment while dark, or the first fetch after a
  night would start at a 300s interval.
- `/api/status` and `/api/flights` keep serving while dark. The web UI is the
  only diagnostic channel a wall-mounted board has.
- The serial console, buttons and web config all keep working.

### Testability

The decision is pure over `(effectiveBrightness, wasSuppressed, lastGoodFetchMs,
nowMs, staleWindowMs)`. Extract to a header-only helper beside
`utils/FetchCadence.h`, with host tests: stays suppressed while dark, forces a
fetch on wake, clears only when genuinely stale, does not touch failure counters.

## Server

### Quiet hours

A window checked in the refresh path, **enabled by default at 00:00–07:00**
America/New_York (all four boards are NYC-area). Configurable via env so it can
be matched to the panel.

Skipping **logs a line**. A silent skip is exactly the failure mode
`flights.ts:74-77` and `server.ts:228-234` exist to prevent.

### The wake-boundary problem, and the fix

`server.ts`'s `TWO_HOURS_MS` rationale is that the ±6h window is centred on
BUILD time and is spent by the end of each cycle. So a table built at 23:00
covers 17:00–05:00, and a panel waking at 07:00 against it gets **no rows for
morning departures**.

`setInterval(runBoth, TWO_HOURS_MS)` has arbitrary phase — a tick can land at
07:43, leaving the morning cold for nearly two hours after quiet hours end.

**Fix:** replace the fixed interval with a short-period checker (5 min) that owns
the decision as a pure predicate:

```
shouldRefresh(nowMs, lastRefreshMs, intervalMs, quiet, wasQuiet)
  -> false  while inside quiet hours
  -> true   on the first check after LEAVING quiet hours, regardless of interval
  -> true   when nowMs - lastRefreshMs >= intervalMs
  -> false  otherwise
```

This guarantees a refresh within 5 minutes of 07:00 rather than up to 2 hours,
and keeps the 2h cadence unchanged outside the window.

**Documented caveat:** the default 00:00–07:00 assumes a panel that wakes at
07:00, so the morning refresh races the wake by a few minutes. Setting quiet-end
an hour before the panel wakes (e.g. 00:00–06:00 for a 07:00 wake) gives a fully
warm table instead. This is a comment in the config, not logic — the server
cannot know the device's schedule.

### Not doing

- Device-activity tracking on the server. Rejected: it needs new persisted state
  and only makes sense for a single-device deployment.
- Any change to the 2h cadence outside quiet hours.
- Any change to the Worker's `[triggers]` cron, which is deliberately left at 6h
  with its own documented rationale.

### Testability

`shouldRefresh` and the quiet-hours predicate are pure. Vitest cases: inside and
outside the window, the midnight wrap (00:00–07:00 does not wrap, but 23:00–07:00
does and must work), the leaving-quiet-hours forced refresh, the interval path
outside quiet hours, and the disabled case.

## Risks

| Risk | Mitigation |
|---|---|
| A mis-sited ambient sensor reads dark in a lit room and silently stops updates | Known open item (HANDOFF §3). `/api/status` keeps serving while dark and reports `lightLevel`/`lightDark`, so the cause stays visible. |
| Quiet hours drift from the panel's night schedule | Configurable, logged on skip, and the caveat is documented at the config site. |
| Backoff counters polluted by suppression | Explicitly excluded above; covered by host tests. |

## Success criteria

- No `/v1/flights` requests while the panel is dark.
- Waking shows the loading screen, then fresh flights — never a stale set.
- No AeroDataBox refresh between 00:00 and 07:00; one within 5 minutes of 07:00.
- Both envs build, host tests pass, server suite passes.
