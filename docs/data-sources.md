# Data sources & APIs

TheFlightWall needs two kinds of data, and they come from **separate** services that
you pick independently in the web UI:

1. **Positions** — where the aircraft are (latitude/longitude, altitude, speed,
   heading), used to decide what's flying near you and to draw the live metrics.
2. **Enrichment** — the human-friendly details: airline, route
   (origin → destination), and aircraft type.

ADS-B (what aircraft broadcast) carries **position + callsign** but *not* the route or
airline — those have to be looked up from the callsign/registration. That's why the two
layers are separate, and why the "accurate routes" problem is harder than the
"where is it" problem.

Out of the box the wall costs **$0**: OpenSky for positions, adsbdb/hexdb for
enrichment. You only ever *need* OpenSky credentials.

---

## 1. Position sources (Area mode)

Selectable in the web UI under **API keys → Position source**.

| Source | Key needed | Cost | Notes |
|---|---|---|---|
| **OpenSky** *(default)* | OAuth client id/secret (free) | Free | Official, stable, well-documented public API. Streams one aircraft at a time, so its RAM use is flat regardless of how busy your sky is. Recommended. |
| **Flightradar24** *(opt-in)* | None | Free | **Unofficial** — see the warning below. Returns position **and** route/airline/aircraft in a single response, so the route lookup is not needed, and its routes handle diversions and non-scheduled traffic that the free enrichment databases miss. |

### ⚠️ About the Flightradar24 source

The Flightradar24 option is an **unofficial scrape** of `data-cloud.flightradar24.com/zones/fcgi/feed.js`
— the same internal JSON that the fr24.com live map fetches in your browser. It is **not**
an official API. Understand the trade-offs before enabling it:

- **It violates Flightradar24's Terms of Service.** It is intended for **personal /
  educational use only**. For anything commercial, contact `business@fr24.com`. It is
  gated behind a config flag and is **never** the default.
- **It can break without notice.** The endpoint is undocumented; FR24 changes field
  order, adds tokens, and rate-limits/IP-bans aggressive scrapers. The official sources
  (OpenSky/adsbdb/hexdb) don't have this liability. Expect to patch it occasionally.
- **It parses the whole area at once.** Unlike OpenSky, FR24's feed is a single object,
  so the entire bounding box is parsed into RAM per fetch. On the plain ESP32 this is
  memory-bound — keep the radius tight. On the **ESP32-S3 (PSRAM)** the parse lives in
  PSRAM and the radius is no longer memory-limited. **This source is intended for the
  S3.**
- Keep polling gentle (the default 30 s cadence is fine) and the radius modest.

When FR24 is the position source, the per-flight enrichment lookup is skipped only
for flights whose feed row already includes a route — for those, the route,
aircraft type, and operator all ride along in the position feed. A row with type
and/or operator but no route (common for GA/private and unscheduled traffic) still
triggers the normal per-flight lookup below to try to fill the route in.

The feed identifies the operator by **ICAO code only**, so the airline's display name is
resolved on device from a built-in table (`firmware/utils/AirlineNames.h`, ~177 carriers,
about 4 KB of flash and no RAM). Without it the wall shows "DAL" instead of "Delta". An
operator missing from the table simply displays its ICAO code; add a line to that header
to cover it.

---

## 2. Enrichment sources

Selectable in the web UI under **API keys → Flight enrichment source**. Always used
with OpenSky. Under Flightradar24 it is skipped only for flights whose feed row
already carries a route — any FR24 flight without one (GA/private, unscheduled)
still calls out to whichever source is configured here.

| Source | Key needed | Cost | Provides |
|---|---|---|---|
| **adsbdb.com** *(default)* | None | Free | Callsign → route + airline, ICAO24 → aircraft type. |
| **hexdb.io** *(automatic fallback)* | None | Free | Fills whatever adsbdb missed (route + aircraft). Always active behind adsbdb; not separately selectable. |
| **FlightAware AeroAPI** | API key | Paid | Authoritative route/airline/aircraft. Can be the primary source, or a **backup** that only fires when adsbdb misses a flight (so you pay only for the gaps). |
| **Off** | — | Free | Callsign only, no route/airline/type. |

Results are **cached per flight leg** (`enrichmentCacheSeconds`, default 600 s / 10
min), so a loitering plane isn't re-queried every cycle. Raising it buys less than
you might think: the key is the callsign, so an aircraft that leaves and comes
back hours later returns under a new one and misses the cache anyway. The default
already spans a single pass. Raise it only if aircraft linger in your radius, and
know the cost is a diverted flight keeping its filed route, or a flight number
reused for a later sector.

### Roughly what the paid options cost

Enrichment is billed **per unique flight leg**: the cache dedupes repeats within
its TTL, not across the month, so an aircraft that passes your antenna on three
separate legs is three lookups. Your cost scales with how many distinct legs you
see per month; a busy location near a major airport can see tens of thousands.

| Source | ~3k lookups/mo | ~30k lookups/mo | Notes |
|---|---|---|---|
| adsbdb + hexdb | **$0** | **$0** | Free, fair-use. Respect it: modest radius, and keep Max flights low. |
| **AeroAPI** | ~$100 | ~$150 | ~$0.005/query. Personal tier is free but capped at ~1,000 queries/mo ($5); beyond that jumps to the Standard tier's ~$100–200/mo minimum. |
| AeroDataBox | ~$5–15 | ~$90–160 | Billed in "units" (≠ requests) via RapidAPI/API.market. Cheapest paid option at low volume. |
| Aviationstack | ~$50 | ~$149 | Keyed by IATA flight number, not callsign/hex — a poor fit for this project. |

*(Prices are approximate and change — verify on each provider's pricing page.)*

**Takeaway:** the free stack is the best value. Paid enrichment (AeroAPI) mainly buys
route accuracy for the hard cases — diversions, reroutes, and non-scheduled/GA traffic
that the free callsign→route databases don't have. Flightradar24 as the position
source gets you comparable route quality for free, but only for flights where FR24's
own feed already includes a route — and the hard cases above are disproportionately
the ones FR24 has no route for either. Those still fall through to whichever
enrichment source is configured, so on AeroAPI they're billed per lookup like any
other flight; the position source alone doesn't make them free (with the ToS and
reliability caveats above).

---

## Configuring it

Everything is set at runtime — nothing needs to be hardcoded or recompiled.

**Web UI** (the primary way): open the wall's page and use the **API keys** card to
choose the position source, enrichment source, and enter any keys.

**USB serial** (no recompile), for the keys and common toggles:

```
opensky <id> <secret>          # OpenSky OAuth credentials
aeroapi <key>                  # FlightAware AeroAPI key
enrich <adsbdb|aeroapi|off>    # enrichment source
loc <lat> <lon> <radiusKm>     # center + radius (Area mode)
status                         # show current config
```

The position source (OpenSky vs Flightradar24) is set from the web UI.

**Compile-time seed** (optional): copy `firmware/config/Secrets.h.example` to
`firmware/config/Secrets.h` (gitignored) to bake WiFi/API credentials in at flash time
for first boot. After that, manage everything from the web UI.

---

## Getting the free keys

**OpenSky** (required for the default setup):
1. Register at <https://opensky-network.org/>.
2. In your account, create an API client and note the `client_id` and `client_secret`.
3. Enter them in the web UI (or via `opensky <id> <secret>` over serial).

**adsbdb / hexdb**: nothing to do — no key, no account.

**FlightAware AeroAPI** (optional, paid): create a personal account at
<https://flightaware.com/aeroapi>, generate a key, and enter it in the web UI. Only
needed if you select AeroAPI as your enrichment source or backup.
