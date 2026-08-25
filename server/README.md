# flightwall-server

Serves `GET /v1/flights` (positions from adsb.lol, joined with a schedule
table fetched periodically from AeroDataBox) to the FlightWall device. Two
entry points share every line of that logic:

- **`src/index.ts`** -- a Cloudflare Worker (`wrangler deploy`). Schedule
  storage is Workers KV.
- **`src/server.ts`** -- a plain Node process, for deploying with Kamal.
  Schedule storage is a JSON file on disk.

Both call the same `handleFlights` (in `src/flights.ts`) and the same
`refreshSchedule` (in `src/schedule/refresh.ts`); only the storage backing
and the HTTP plumbing differ. See `src/schedule/store.ts`'s
`ScheduleStorage` interface for how that split works.

## Why two entry points

adsb.lol rate-limits the Worker: Workers egress from IPs shared with every
other Cloudflare Worker, and adsb.lol returns `429` on roughly 4 of every 5
requests from that shared range, even though the device only polls once
every 30 seconds. The identical request from a residential/dedicated IP
does not get rate-limited.

Running the same code as a plain process on a box with its own IP -- here,
an OVH server managed with [Kamal](https://kamal-deploy.org/) -- fixes
that: Cloudflare only proxies the *inbound* connection (DNS, TLS, DDoS
protection), so the box's own outbound calls to adsb.lol leave from its
own dedicated IP, not a shared Workers range.

## Local development

```sh
npm install
npm test           # no real network calls -- adsb.lol/AeroDataBox are stubbed
npm run typecheck  # tsc --noEmit over src/ and test/
npm run dev        # wrangler dev -- runs the Worker path locally
```

To run the Node path locally instead:

```sh
npm run build          # esbuild src/server.ts -> dist/server.js
AERODATABOX_KEY=... npm start
```

or without a key at all -- positions and the physics-based ETA both work
with no schedule table; only routes (origin/destination/flight number) are
lost:

```sh
npm run build && npm start
```

### Config (`server.ts` / Docker / Kamal)

All read from the environment, with defaults for everything except the key:

| Var                | Default                    | Notes                                    |
|--------------------|-----------------------------|-------------------------------------------|
| `PORT`             | `8787`                      | |
| `AERODATABOX_KEY`  | *(none)*                    | Missing -> schedule refresh is skipped; server still starts and serves positions. |
| `BOARDS`           | `KJFK,KLGA,KEWR,KBOS`        | Comma-separated ICAO airport codes. |
| `SCHEDULE_PATH`    | `./data/schedule.json`      | Docker image overrides this to `/app/data/schedule.json` (see Dockerfile). |
| `REFRESH_QUIET_HOURS` | `0-6`                     | Local-hour window `START-END` (end exclusive) during which the AeroDataBox schedule refresh is skipped. `off` disables it (always refresh); malformed values are also treated as `off` rather than guessed at, since a typo that became an all-day window would stop refreshes and look like an upstream outage. |
| `REFRESH_QUIET_TZ` | `America/New_York`           | IANA zone the window above is read in. |
| `TRACKED_ICS_URL`  | *(none)*                    | Published calendar feed to sync tracked flights from; `webcal://` accepted. Missing -> no sync. **A secret** (capability URL). See [Syncing tracked flights from a calendar](#syncing-tracked-flights-from-a-calendar). |

**The quiet-hours window must end before your panel wakes.** `server.ts`'s
refresh covers roughly +/-6h centred on the moment the schedule table was
built, and that coverage is spent by the end of each cycle -- a table built at
23:00 covers ~17:00-05:00, so a panel waking at 07:00 against it has no rows
for morning departures. Leaving the window forces a refresh within 5 minutes
regardless of the 2h cadence, so the margin you need is minutes; the hour the
`0-6` default leaves before a 07:00 wake is generous, not the minimum. What
breaks is ending the window at or after the wake time. The default assumes a
panel whose night schedule ends at 07:00 -- change both together.

### Tracked flights

**`GET /` is the page for this.** Open the server in a browser: it lists what is
being watched -- state, route, aircraft, and whether the wall is drawing a live
fix or a dead-reckoned estimate right now -- with a form to add a flight and a
button to remove one. It is one self-contained HTML string bundled into
`dist/server.js` (`src/tracked/page.ts`), because the runtime image ships no
other files. On a server with no OpenSky credentials the page still loads and
says which two environment variables are missing, rather than 404ing.

Underneath, `POST /v1/tracked` with `{"number":"BA181","date":"2026-09-14"}`
adds one journey. `GET /v1/tracked` lists them; `DELETE /v1/tracked/{id}`
removes one. The flight is resolved to its aircraft via AeroDataBox, then
followed live via OpenSky and pinned to the top of the panel until it lands.

**This endpoint is UNAUTHENTICATED by deliberate choice, and so is the page.**
Anyone who knows the URL can add entries and read which flights are being
followed. Serving the page adds discoverability, not capability -- it can do
nothing a `curl` could not already do. Four guards bound
what that costs, and they are load-bearing rather than cosmetic -- do not relax
any of them without adding auth first:

- at most 20 stored entries
- dates restricted to today-1 .. today+14
- at most 50 AeroDataBox resolutions per day for this feature
- entries expire on their own (2h after landing, 24h after an unresolved miss)

Requires `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET`. Without them the tick
never starts and the routes 404, so the feature is inert rather than broken.

**On the OpenSky budget.** Authentication is OAuth2 client credentials, NOT HTTP
Basic -- Basic returns 200 with real data while being served from the anonymous
400/day tier instead of the authenticated 4000/day one, a tenfold error that
produces no error. A single-`icao24` query costs FOUR credits, so the real budget
is ~1000 queries/day. The 300s tick is sized so roughly ten concurrent
eight-hour flights (960 queries) fit -- i.e. the 20-entry cap binds before the
OpenSky budget does. Raise the interval before tracking more than that; see
`docs/superpowers/audits/2026-08-24-tracked-flights-measurements.md`.

### Syncing tracked flights from a calendar

Set **`TRACKED_ICS_URL`** to a published calendar feed and the server keeps the
tracked list in step with it -- adding flights it finds, removing the ones it
added when they leave the feed. Unset, nothing runs. It also needs the OpenSky
pair above, since it writes into a store that only exists with them.

The feed is any published `.ics`. For Flighty on iOS, turn on Calendar Export,
then publish the calendar it writes into: Calendar app -> Calendars -> the info
button -> **Public Calendar** -> Share Link. `webcal://` is accepted and
rewritten, so paste the link as given.

**Two things to get right before it works:**

- **The calendar must be an iCloud calendar.** One under "On My iPhone" or "On
  My Mac" cannot be published to a URL at all.
- **Point it at a calendar that holds flights and nothing else.** Publishing is
  public to anyone holding the link, and a flight-number parser on a general
  calendar has false positives -- "Room 2B 101" is a valid-looking flight
  number. If Flighty offers no destination picker, make a dedicated calendar and
  set it as the iOS default (Settings -> Calendar -> Default Calendar).

**`TRACKED_ICS_URL` is a secret.** It is a capability URL: anyone holding it
reads every flight in that calendar. It is never rendered on the page, never
returned by an endpoint, and only its host appears in logs.

**What the sync will and will not delete.** It removes an entry only when all
four hold -- the entry is calendar-sourced, is not `airborne`, is still inside
the date window, and is absent from the feed. So flights added by hand are never
touched, an aircraft in the air is never yanked off the panel, and expiry stays
lifecycle's job. A **failed fetch changes nothing at all**: a transient 503, or
an HTML error page served with status 200, must not read as "the calendar is
empty" and wipe the list. A feed that genuinely parses to zero flights does
delete.

Runs inside the tracked tick, hourly, rather than on its own timer -- the entry
store is read-whole/write-whole with no protection against two writers, and
interleaving would silently lose either a position update or a new entry.

**On dates.** A `DTSTART` carrying a `TZID` gives the origin-local departure
date, which is what AeroDataBox resolves against. A bare `Z` instant does not,
and the UTC date is then used instead -- a day late for a late-evening westbound
departure. The first sync logs which form your feed uses.

## Docker

```sh
docker build -t flightwall-server .
docker run --rm -p 8787:8787 \
  -e AERODATABOX_KEY=your-key-here \
  -v flightwall_schedule_data:/app/data \
  flightwall-server
curl http://localhost:8787/up
```

Multi-stage build: TypeScript is bundled (not just transpiled) with
esbuild in a `node:22-alpine` build stage; the runtime stage ships only
the resulting `dist/server.js`, running as a non-root user, with no
`node_modules` at all (this package has zero runtime `dependencies`). See
the comment at the top of the `Dockerfile` for why esbuild rather than
plain `tsc` or a runtime loader (tsx/ts-node).

## Deploying with Kamal

Prerequisites: `gem install kamal` (Kamal 2.x -- specifically a release
from mid-2025 or later, when kamal-proxy gained custom SSL certificate
support; run `kamal version` and upgrade if it predates that), Docker
running wherever you run `kamal` from, and SSH access to the target box.

1. **`config/deploy.yml`'s placeholders are filled in for this deployment**:
   `image`/`registry.username` are `chaim354`, `registry.server` is
   `ghcr.io`, `servers` is the OVH box (`15.204.216.249`), and
   `proxy.host` is `flightwall.tinkerex.com`. Deploying your own fork
   instead: replace those five values with your own registry
   username/server, OVH box IP/hostname, and public hostname -- none of
   them are guessed for you on purpose.

2. **Secrets go in `.kamal/secrets`** (create it; it's gitignored --
   `server/.gitignore` already excludes `.kamal/`). `kamal init` will
   scaffold this file for you if you'd rather start from its template.
   This deploy needs four secrets. This deployment sources all four from
   1Password (vault `tinkerex`) via the `op` CLI, using Kamal's
   command-substitution form so nothing is ever stored in plaintext:

   ```sh
   # server/.kamal/secrets
   KAMAL_REGISTRY_PASSWORD=$(op read "op://tinkerex/ghcr.io/password")
   CLOUDFLARE_ORIGIN_CERT_PEM=$(op read "op://tinkerex/tinkerex-origin/certificate")
   CLOUDFLARE_ORIGIN_KEY_PEM=$(op read "op://tinkerex/tinkerex-origin/private key")
   AERODATABOX_KEY=$(op read "op://tinkerex/aerodatabox/credential")
   ```

   `ghcr.io` and `tinkerex-origin` already exist in the `tinkerex` vault.
   `aerodatabox` does not -- it holds a real API key, so creating it is a
   deliberate step for whoever owns the vault, not something to script
   blindly. Create it yourself with:

   ```sh
   op item create --category "API Credential" --vault tinkerex \
     --title aerodatabox credential=<your-aerodatabox-key>
   ```

   (get a key at https://aerodatabox.com/ -- the free tier covers a
   handful of boards; the assignment-statement form above puts the key on
   your shell command line, which 1Password's own CLI docs note can land
   in shell history, so prefer pasting it into an interactive `op item
   create` prompt or 1Password's UI if that matters to you). Until the
   item exists, `op read` for it fails and Kamal's command substitution
   silently resolves `AERODATABOX_KEY` to an empty string rather than
   erroring the deploy -- the server still starts fine without it (see
   the Config table above), it just skips schedule refresh until the key
   is added and the container is redeployed.

   No `op` CLI, or prefer plain files instead of a password manager?
   Kamal's command substitution runs any command, e.g.:

   ```sh
   # server/.kamal/secrets
   KAMAL_REGISTRY_PASSWORD=$(cat ~/.kamal/registry_password)
   AERODATABOX_KEY=$(cat ~/.kamal/aerodatabox_key)
   CLOUDFLARE_ORIGIN_CERT_PEM=$(cat ~/.kamal/flightwall_origin_cert.pem)
   CLOUDFLARE_ORIGIN_KEY_PEM=$(cat ~/.kamal/flightwall_origin_key.pem)
   ```

   Keep the referenced files (`~/.kamal/*`) outside the repo entirely --
   `.kamal/secrets` only needs to reference them, never contain the raw
   registry password/API key/cert text inline (though it can, if you
   prefer one file over several -- just don't commit it either way).

3. **Cloudflare, before the first deploy:**
   - DNS: an A record for `proxy.host` pointing at the OVH box's IP, proxy
     status **on** (orange cloud) -- this is what puts Cloudflare in the
     path at all.
   - SSL/TLS -> Overview: set the encryption mode to **Full** (or **Full
     (strict)** once the origin cert below is in place -- strict also
     validates the cert's hostname/expiry). **Not Flexible.** Flexible
     terminates TLS at Cloudflare and speaks plain HTTP from Cloudflare to
     the origin -- the visitor sees a padlock, but the Cloudflare-to-box
     hop (carrying the same request Cloudflare received) is unencrypted.
     Full requires the origin to speak real TLS, which is exactly what the
     Origin Certificate below is for.
   - SSL/TLS -> Origin Server -> Create Certificate: generates a
     certificate (up to 15 years) that Cloudflare trusts for this purpose
     specifically -- it is not a publicly-trusted cert and browsers will
     not trust it directly, which is fine, because nothing but Cloudflare
     ever connects to this box's TLS listener. Save the certificate and
     private key into the `tinkerex-origin` 1Password item (`certificate`
     and `private key` fields -- already done for this deployment), or
     the two files referenced in step 2 if you're using the file-based
     fallback instead.

4. **First deploy:**

   ```sh
   cd server
   kamal setup
   ```

   `kamal setup` provisions kamal-proxy on the target box (installing
   Docker there first if it isn't already present), builds and pushes the
   image, and starts the container. Subsequent deploys are `kamal deploy`.

5. **Verify:** `kamal app logs`, and `curl https://<proxy.host>/up`. Kamal
   itself already healthchecks `/up` during every deploy (see
   `proxy.healthcheck` in `config/deploy.yml`) and won't route traffic to a
   new container until it passes.

### The schedule volume

`config/deploy.yml` mounts a named volume at `/app/data`, so the fetched
schedule table survives a redeploy instead of starting empty (which would
just read as `stale` and cost routes, not positions, until the next
refresh -- but there's no reason to take that hit on every deploy when a
volume avoids it for free).

### SIGTERM

Kamal stops the old container with `SIGTERM` during a deploy.
`src/server.ts` handles it by clearing the refresh timer and closing the
HTTP server (including forcing idle keep-alive connections closed, so
shutdown doesn't hang waiting one out) before exiting.
