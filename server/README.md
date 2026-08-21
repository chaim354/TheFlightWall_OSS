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

1. **Fill in the placeholders in `config/deploy.yml`**: `image`'s registry
   username, `registry.server`/`registry.username`, `servers` (the OVH
   box's IP or hostname), and `proxy.host` (the public hostname you'll
   point at it). None of these are guessed for you on purpose -- there is
   no real registry or hostname to default to.

2. **Secrets go in `.kamal/secrets`** (create it; it's gitignored --
   `server/.gitignore` already excludes `.kamal/`). `kamal init` will
   scaffold this file for you if you'd rather start from its template.
   This deploy needs three secrets:

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
     private key to the two files referenced in step 2.

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
