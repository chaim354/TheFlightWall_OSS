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
| Auth | **Three secrets**: a device token, a resettable UI password, an admin password |
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

### Three secrets, not one

The original design had a single shared token. That could not survive the
requirement that a person be able to reset the password from the page: the token
is what the DEVICE authenticates with, so resetting it would leave the wall
holding a credential the server no longer accepts, unable to check in, with the
only repair being the cable this whole arc existed to eliminate.

So the one secret splits into three, by what each is for:

| Secret | Held by | Resettable | Grants |
|---|---|---|---|
| `CONTROL_TOKEN` (env) | the device | **No** — deliberately | check-in only |
| UI password | a person | Yes, from the page | status, and the everyday settings |
| Admin password | a person | Yes, by its holder | everything, including flashing |

`tierFor()` resolves a bearer to one of `none` / `device` / `ui` / `admin`.
Admin is checked **before** ui, so setting both to the same string grants admin
rather than silently capping at ui. Device is checked first and separately
because it is a different KIND of caller: it may report, and nothing else. A
browser presenting the device token gets 403 on every page route, and a browser
cannot check in — otherwise anyone with the UI password could fake what the wall
reports and the page would show a fiction with a fresh timestamp on it.

Passwords are stored as scrypt hashes with a per-password salt, in the same
state file as the queue. The device token stays a plain shared secret compared
in constant time, because it is supplied by the environment, not stored.

### The default UI password

The UI password defaults to `flightwall123` — public, guessable, and shipped on
purpose so the page works the moment it is deployed.

It is not a secret and is never treated as one. `GET /v1/control` returns
`usingDefaultUiPassword`, and the page shows a warning card continuously while
it is true, saying plainly that anyone who finds the URL can change settings and
restart the wall. Setting the UI password back to the default is refused: it
would clear the warning while leaving the exposure exactly as it was.

Once a real UI password exists, the default stops being accepted — otherwise
resetting the password would change nothing at all.

### What the admin tier gates

Everything that can break the wall or spend money:

- **Actions**: `restart`, `updateui`, `updatefw`
- **Sections**: `hardware` (HUB75 geometry, driver chip, I2S clock), `light`
  (sensor type, pin, thresholds, hysteresis)
- **Keys**: `display.fetchIntervalSeconds`; `api.positionSource`,
  `enrichmentSource`, `enrichmentFallbackToAeroApi`, `serverUrl`, and every
  credential — `aeroApiKey`, `openSkyClientId`, `openSkyClientSecret`,
  `enrichmentCacheSeconds`

A refusal names the fields it refused. "Needs the admin password" leaves someone
hunting through a form for which control did it.

Before any admin password exists the admin tier is unreachable, and flashing
stays unavailable rather than falling back to a weaker check. The ui tier may
create the FIRST admin password — somebody has to, and it is the only credential
in existence at that point — and is locked out of changing it afterwards.

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

- `POST /v1/control/password` — set the UI or admin password.

All require `Authorization: Bearer <secret>`, and each route accepts only the
tiers listed above.

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

**One page, not two.** The controls live on the watched-flights page at `/`, so
there is a single address for the wall; `/control` 301s there for anyone who was
given the old URL.

**The whole page is behind the password**, watched flights included. An
anonymous visitor sees a sign-in card and nothing else — no header, no flight
count, no wall status. `/v1/tracked` is gated with the same credential, because
hiding the UI while leaving the API that drives it open would be a curtain
rather than a lock: anyone could still add and remove flights with one curl.
The device is unaffected — it calls `/v1/flights`, `/v1/assets/manifest` and
`/v1/control/checkin`, never `/v1/tracked` — and a device token presenting there
gets 403, since it is not a browser that forgot its password but something using
the wrong key. Absent `CONTROL_TOKEN` there is no password mechanism at all, so
the route stays open rather than locking everyone out of a server with no way to
let them back in.

**Admin sections are absent, not greyed out**, unless the password signed in with
was the admin one. Disabling them still rendered every field, and the values were
the sensitive part; the server already withholds them from a non-admin caller, so
a visible card could only ever show blanks. One short line stays behind to say
some settings need the admin password, which keeps the tier discoverable without
naming anything inside it.

It offers the same controls the LAN page has, minus WiFi and the device token,
and the fields auto-populate from the settings the device reports on each
check-in. That population is what makes the form safe: without it an untouched
checkbox reads as "set this to false" rather than "leave it alone", so queueing
one filter change would silently clear two others. If a wall has never reported
its settings the controls stay hidden, because sending a form full of blanks
would overwrite real values with guesses.

A submit collects from **its own card only**, not by section name across the
page. A section's fields are deliberately spread across cards —
`display.fetchIntervalSeconds` sits with the API keys because it decides how
often they are spent — so a page-wide sweep made "Queue display" also submit an
admin-only field and the whole card was refused for a control the person never
touched.

A `Lock` control clears the held password and returns to the sign-in card, which
is also how someone at the ui tier signs back in with the admin one.

Every value is stamped with how long ago the wall checked in — an age, not a
timestamp, because the reader is asking "is it alive" and a clock reading makes
them subtract against a device that may be in another time zone.

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
