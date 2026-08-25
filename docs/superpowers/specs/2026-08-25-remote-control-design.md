# Remote control over the existing poll — design

**Dated record.** Written 2026-08-25 against `main` at `0d68283`.

## Problem

The wall's control surface is LAN-only: `http://192.168.1.113/`. From outside
the house there is no way to see what it is doing or change it.

The obvious answer — serve the control page from `flightwall.tinkerex.com` —
does not work, for two independent reasons:

- A page on HTTPS cannot call `http://192.168.1.113`. Browsers block mixed
  content and the wall cannot obtain a certificate for a LAN address.
- The server cannot reach the wall at all. It sits behind a home NAT and only
  ever makes outbound connections.

But the device **already polls the server every 60 seconds** for flight data.
That channel is the answer: it crosses the NAT, it exists, and its latency is
already the update cadence the wall runs at.

## What that channel is today

```
GET /v1/flights?lat=…&lon=…&radius_km=…&max=…&exclude_ground=…
```

**Anonymous.** No device id, no token, on either side — verified in
`FlightWallServerFetcher.cpp` and `flights.ts`. It is a public read, and that is
fine for flight data.

It is not fine for control, which is the whole cost of this feature.

## Decisions taken

| Question | Decision |
|---|---|
| Transport | **The existing 60s poll**, via one added request. No tunnel, no inbound connection |
| Scope | **Everything except network settings.** WiFi stays device-only |
| Auth | **A shared token**, server env + device setting + the control page |
| Devices | **One wall per server.** A single global command queue, no device ids |
| Delivery | **At-most-once.** The queue drains on collection; a lost command is re-queued by a human |

### Why network settings are excluded

Applying a wrong SSID from across the internet drops the wall off the network,
and the only remaining fix is the cable this entire arc existed to eliminate. It
is the one setting whose failure mode destroys the channel that would repair it.

Enforced **twice, independently**: the server strips `network` from anything
queued, and the device strips it again before applying. The second is not
redundant — it is the one that still holds when the server is the thing that has
been compromised, which is precisely the scenario the exclusion is for.

### Why one shared token, and what it does not protect

Anyone holding the token has full control of the wall. That is understood and
accepted for a single-user deployment; the alternative (per-user login) is
Cloudflare Access in front of these routes, which needs no code here and can be
added later without changing anything below.

Absent `CONTROL_TOKEN`, every control route 404s and the device never calls
them — the same inert-rather-than-broken posture `/v1/tracked` takes without
OpenSky credentials.

## Architecture

### Server

- `POST /v1/control/checkin` — the DEVICE's call, on its existing cadence.
  Body is the device's status; the response carries any queued commands, and
  collecting them drains the queue.
- `GET /v1/control` — the PAGE's call. Last reported status (with its age) and
  anything still pending.
- `POST /v1/control/command` — queue one command.

All three require `Authorization: Bearer <CONTROL_TOKEN>`.

State lives on the volume beside the schedule and tracked entries, so a redeploy
does not lose a queued command or the last known status.

### Commands

```
{ "set": { …partial settings… } }     network keys stripped
{ "action": "restart" }
{ "action": "updateui" | "updatefw" }
```

`set` is a partial settings document applied by the same `Settings::fromJson`
the LAN page posts to, so remote and local edits cannot diverge in behaviour.

### Device

One extra HTTP call per fetch cycle, alongside the flights request. It reports
status, receives commands, applies them, and the existing settings-changed path
does the rest — brightness, layout and filters all re-apply immediately, exactly
as they do for a LAN save.

### Page

A second view on the server, gated by the token, showing what the wall reports
and offering the same controls the LAN page has minus WiFi. Every value is
stamped with when the wall last checked in, because a control page showing stale
state as though it were live is worse than one showing nothing.

## Risks

| Risk | Mitigation |
|---|---|
| Token leaks → full control of the wall | Accepted for one user; Cloudflare Access is the upgrade path |
| A remote setting strands the device | Network settings excluded, enforced on both ends |
| Server compromised → hostile commands | Device strips network keys regardless of what arrives; firmware still requires a valid signature |
| Stale status read as live | Every value carries the check-in age |
| Command lost mid-apply | At-most-once, and re-queuing is a human action |

## Not doing

- Multiple walls per server. One queue, no device ids, stated rather than implied.
- Real-time control. Latency is the fetch interval; a brightness change taking a
  minute is the honest cost of not opening an inbound port.
- Remote WiFi configuration. See above.

## Success criteria

- The wall's current state is visible from outside the house.
- Brightness, filters, layout and tracking can be changed remotely and take
  effect within one fetch cycle.
- Nothing queued can change WiFi, even if the server says so.
- With `CONTROL_TOKEN` unset the feature is inert and the device never calls it.
