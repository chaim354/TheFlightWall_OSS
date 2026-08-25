# Server-delivered assets and firmware OTA — design

**Dated record.** Written 2026-08-25 against `main` at `8f90aad`.

## Problem

Everything on the device that is not code requires a cable. The web UI and the
154 logo tiles live in the LittleFS image, and changing one byte of either means
`pio run -t uploadfs`, which erases `/settings.json` and needs physical access.

Two concrete costs, both paid this week:

- A missing `JZA.rgb565` meant Air Canada Express rendered a text badge. Adding
  one 2KB tile cost a full 10MB filesystem flash plus a settings backup/restore.
- Every web UI change carries the same price, which discourages small fixes to
  the one surface a user actually touches.

And firmware changes need a cable at all, which is the larger version of the
same problem.

## What already exists (do not rebuild)

- **The S3 partition table is already OTA-capable.** `partitions_16MB.csv` has
  `app0`/`ota_0` and `app1`/`ota_1` at 3MB each, plus `otadata`, against a
  ~1.2MB binary. No repartition, no cable, and the table's own comment says it
  was laid out for this.
- **LittleFS is writable at runtime.** `/settings.json` is written on every
  save, so single files can be added without touching the image.
- **The server already has a mounted volume** (`flightwall_schedule_data:/app/data`)
  that survives redeploys, where the schedule table and tracked entries live.
- **`Hub75Display::stopOutput()`** can halt the panel DMA, added 2026-08-25 when
  that DMA was measured starving the radio badly enough to make the setup AP
  unjoinable.

## Decisions taken

| Question | Decision |
|---|---|
| What OTA replaces | **App firmware only.** The filesystem stays cable-only |
| How the UI ships | **Device downloads it and serves it itself**, local copy is the fallback |
| How logos ship | **Pull on demand**, one tile, when a lookup misses |
| Where assets live | **The server's data volume**, not the image — adding a logo must not need a redeploy |
| Trigger | **Manual**, a button in the web UI. No unattended reboots |
| Authenticity | **Verified TLS + SHA-256 from a manifest** |
| Order | **UI, then logos, then firmware** — same plumbing, proven at 12KB before it carries 1.2MB |

### Why the UI is downloaded rather than served from the server

Because a page served over HTTPS cannot call `http://192.168.1.113`: browsers
block mixed content, and the device cannot obtain a valid certificate for a LAN
address. A browser-loads-from-server design would need the wall to speak HTTPS
with a real cert, which is not obtainable, so it is not on the table.

Downloading keeps every `fetch('/api/settings')` same-origin against the device,
which is what the existing page already does and why none of its code changes.

## Architecture

One mechanism, three uses: **fetch a file from the server over TLS, check its
SHA-256, write it to LittleFS.** They differ only in size and in what happens
after the write.

### Server

Assets live under `/app/data/assets/` on the volume:

```
assets/index.html.gz
assets/logos/<ICAO>.rgb565
assets/firmware/<version>.bin
```

Endpoints:

- `GET /v1/assets/manifest` — small by design, so an ESP32 can parse it:
  `{ ui: {sha256, size}, firmware: {version, sha256, size} }`. NOT a listing of
  154 logos; the device asks for the one tile it is missing.
- `GET /assets/<path>` — raw bytes. Path validated against `^[A-Za-z0-9_./-]+$`
  with `..` rejected outright, since this reads from a directory an operator
  uploads into.

Hashes are computed on read and cached against file mtime — hashing 154 files
per request would be absurd, and hashing none would make the manifest a lie.

### Device

`assetFetch(url, destPath, expectedSha)`:

1. GET over `WiFiClientSecure`.
2. Stream to a TEMP file, hashing as it goes (mbedtls SHA-256 is already linked).
3. Compare to the expected hash; on mismatch, delete the temp and keep what was
   there. Never write a partial file over a good one.
4. Rename into place.

**UI.** `handleRoot()` prefers `/index.cache.html.gz` and falls back to the
built-in `/index.html.gz`. A "Check for updates" button fetches the manifest,
compares to the stored hash, downloads if different. The fallback is what makes
this safe: a failed download, a corrupt file, or a device that has never seen
the server all serve the built-in page.

**Logos.** When `tileFor(icao)` misses, request that one tile. A 404 is cached
in RAM for the session so a genuinely-unknown airline is not re-requested every
carousel cycle. Successes are cached to LittleFS and survive reboot.

**Firmware.** `Update.begin()/write()/end()` into the inactive OTA slot, then
`esp_ota_set_boot_partition` and reboot. The panel's DMA is stopped for the
duration — 1.2MB over a radio this panel measurably starves is the one download
where that matters.

## Risks

| Risk | Mitigation |
|---|---|
| A bad UI download bricks the config surface | Built-in copy is the fallback; nothing overwrites it |
| A partial write leaves a corrupt file | Temp file + hash check + rename; never write over a good file |
| Path traversal into the volume | Strict allowlist regex, `..` rejected |
| A bad firmware image | Two OTA slots; ESP32 rollback marks the new image valid only after a successful boot |
| Unattended update surprises the user | Manual trigger only |

## The open question: which CA

Verified TLS means the device must know a root to trust, and the server is
behind Cloudflare, so the device sees Cloudflare's edge certificate rather than
our origin one. Pinning is therefore a bet on a CA chain we do not control:
Cloudflare rotates, and free-tier certs have moved between issuers.

If that pin ever stops matching, the device cannot fetch — and for firmware that
is a chicken-and-egg, because the fix would itself arrive by OTA.

Staged accordingly:

- **Phase 1 and 2 (UI, logos) can ship on the current transport.** A wrong
  `index.html.gz` or logo tile is a cosmetic failure with a built-in fallback,
  and the SHA check still catches corruption. The stakes do not justify a
  brittle pin.
- **Phase 3 (firmware) is where authenticity becomes load-bearing**, and the
  honest options are (a) bundle several roots and accept that a CA change needs
  a cable, or (b) sign the image with a key baked into firmware, which makes the
  transport irrelevant. (b) has no rotation hazard and is the better answer if
  firmware OTA is meant to be depended on.

**This needs a maintainer decision before phase 3 is built.** Phases 1 and 2 do
not depend on it.

## Not doing

- Filesystem OTA. 10MB over this radio, and it wipes settings.
- Automatic/scheduled updates. Manual only, by decision above.
- OTA on the classic ESP32 target: `huge_app.csv` has a single app slot, so it
  needs a new partition table, which needs a cable anyway.
- Delta/patch updates. The whole file, every time; these are small.

## Success criteria

- A logo tile added to the server appears on the wall without a cable.
- A web UI change appears after pressing one button, without a cable.
- A device that cannot reach the server still serves its built-in UI and renders
  its built-in tiles.
- A corrupted or truncated download never replaces a working file.
- Firmware OTA (phase 3) can be rolled back by a failed boot rather than a cable.
