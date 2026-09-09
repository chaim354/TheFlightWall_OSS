# Unified dashboards and an airline ignore list — design

**Dated record.** Written 2026-09-09 against `main` at `c2f04f9`.

## Problem

The wall has two control surfaces, and each can do things the other cannot:

- **The device page** (`http://flightwall.local/`, `firmware/data/index.html`)
  is the LAN page. It edits every setting directly, but it knows nothing
  about the server-side features — watched flights and hand-typed airline
  names live only on the server.
- **The server page** (`https://flightwall.tinkerex.com/`,
  `server/src/tracked/page.ts`) is the remote page. It queues settings
  through the check-in, but it never grew the whole form: no tracked-flight
  list, no airline allow-list, no server URL, no way to go back to the
  built-in web UI.

So which URL you open decides what you are allowed to change, and nothing on
either page says so. The request is: **every control on both pages, except
WiFi.**

Separately, business-jet operators such as NetJets fly airline-format
callsigns (`EJA123`), so they pass the general-aviation filter and take slots
on the wall. There is an allow-list ("only these airlines") but no way to say
"everything except these".

## Decisions taken

| Question | Decision |
|---|---|
| Ignore list scope | **A per-operator deny list**, `filters.airlineDenyList`, matched the same way the allow-list is: ICAO prefix, IATA code, or operator code, case-insensitive |
| Where it is applied | **Both ends.** The device applies it on every position source; the server ALSO applies it before the nearest-N cut, so ignoring three NetJets does not leave three empty slots |
| Watched flights | **Exempt** from the ignore list, exactly as they are exempt from the general-aviation filter: the person named that flight |
| Typing a name | **A search endpoint** on the server (`GET /v1/airlines/search?q=netjets`) over the three name tables, so "netjets" resolves to `EJA` without knowing the code |
| Parity direction | **Both ways.** The server page gains the device-only fields; the device page gains the server-only cards by calling the server directly from the browser |
| How the device page reaches the server | **Cross-origin fetch from the browser**, with the server's own UI password. The ESP32 never proxies anything |
| Still excluded | **WiFi** (as asked), **the control token** (already excluded, same reason), and **the server's password card and command queue** — those are the remote page's own access controls, not controls over the wall |

### Why the server filters too

The device already passes its altitude band and on-ground filter to
`/v1/flights` as query parameters, because the server picks the nearest
`max` flights and the device cannot un-pick them. The airline lists had never
been passed, which was an existing gap for the allow-list and would have been
a visible one for the ignore list: with `maxFlights=8` and three NetJets
overhead, the device would drop three of the eight and show five. Passing
both lists (`deny_airlines`, `allow_airlines`) makes the server's cut respect
them. Pinned cards are merged after the cut and are exempt, matching the
device.

The device keeps applying the lists itself. That is what covers the adsb.lol
fallback and every non-server source, and it is the check that still holds if
the server ignores the parameter.

### Why the device page talks to the server from the browser

A page served over plain HTTP may fetch an HTTPS resource — the mixed-content
rule blocks the other direction. The server's browser-facing routes
(`/v1/tracked`, `/v1/airlines`) gain CORS headers with an `*` origin. That is
safe here because the credential is a bearer header the page sets explicitly,
never a cookie: a hostile site cannot borrow an ambient login, and can only
call the API with a password it already holds. The control routes themselves
get no CORS header; the device page does not queue commands, it applies
settings directly.

The device page stores the server password in `sessionStorage`, as the server
page does, and asks for it only when a server call answers 401. On a server
with no `CONTROL_TOKEN` the routes are open and no password is asked for.

### Why the search is unauthenticated

It reads three bundled tables of public carrier names and touches no state.
Gating it would mean the device page cannot resolve "netjets" until someone
types the server password, for a lookup that reveals nothing about anyone.

### `api.serverUrl` on the remote page

It is admin-gated by the existing rule and was simply never put on the page.
It is now, with a warning: the wall reaches the remote page through that URL,
so a wrong value ends remote control until someone fixes it on the LAN page.
The admin tier exists for exactly this class of setting.

## Architecture

### Firmware

- `AircraftFilters::airlineDenyList`, serialised as `filters.airlineDenyList`,
  parsed with the same trim/uppercase rule as the allow-list.
- `Filters::airlineDenied()` beside `airlineAllowed()`. Applied in
  `classifyAndFilter` (Area mode and the server path alike) and in Flights
  mode; a pinned card bypasses it.
- `FlightWallServerFetcher` appends `deny_airlines=` and `allow_airlines=`
  (alphanumeric codes only) to the flights request.
- `ControlClient` learns a fourth action, `clearui`, which drops the cached
  web UI so the built-in page is served — the LAN page's "Use built-in"
  button, now reachable remotely.
- The check-in status carries the fields `/api/status` already serves that the
  remote page can use: `uiSource`, `uiSha`, `lightLevel`, `lightDark`,
  `activeSource`, `sourceFallback`, `serverStale`.
- `/api/flights` adds `operatorIcao`, so the device page can offer "ignore
  this operator" on a flight that is on the wall right now.

### Server

- `handleFlights` honours `deny_airlines` and `allow_airlines` before the
  sort-and-slice; codes are normalised through `normaliseCarrierCode`.
- `searchAirlines(q)` in `airlines.ts`; served at `GET /v1/airlines/search`.
- CORS on `/v1/tracked*` and `/v1/airlines*`: `OPTIONS` answers 204, every
  response carries `access-control-allow-origin: *`.
- `clearui` joins the action list and the admin-only set.

### Server page

Gains, in the cards where they belong: tracked flights (textarea), the airline
allow-list, the airline ignore list with a name search, the server URL
(admin), the three HUB75 presets, and a "Use built-in web UI" action. The
status card shows which web UI the wall is serving and whether the server
offers a different firmware than the one running.

List fields carry a `data-list` attribute: populated as comma- or
newline-joined text, collected back into arrays.

### Device page

Gains the enrichment cache seconds, the ignore list with the same search, an
"ignore" button on each live flight, and two server cards — watched flights
and airline names — shown only when a server URL is configured. They are
compact versions of the server page's cards: the same forms, the same
verbatim error strings from the server, without the long explanatory copy.

## Error handling

- A server call from the device page that fails to connect shows "could not
  reach the server" in the card and nothing else changes.
- 404 from `/v1/tracked` (no OpenSky credentials) hides the watched-flights
  card with a one-line note; 401 shows the password prompt.
- Ignore-list codes that are not alphanumeric are stored but never sent to
  the server; the device still compares them case-insensitively, so they are
  harmless rather than fatal.

## Testing

- Server: vitest for the two query parameters, the search, CORS on exactly
  the browser-facing routes, `clearui` gating, and the page invariants (every
  new field submittable, admin fields in admin cards, actions gated).
- Firmware: the on-device Unity suite gains deny-list filter and round-trip
  cases (compile-checked on the host); both envs build; the host suites still
  pass.
- Web UI: both pages driven in a browser — the device page against
  `tools/webui_stub.mjs` pointed at a local server with CORS, the server page
  against that same server after a faked check-in.

## Not doing

- Merging the two HTML files into one. The transports differ (direct save
  versus queued command with a status age), and a single page that switches
  on where it is served would be a rewrite of both for no user-visible gain.
- Proxying server features through the ESP32.
- The server's passwords and queue on the device page — see the table above.
