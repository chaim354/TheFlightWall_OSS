#!/usr/bin/env bash
#
# Publish device-downloadable assets to the FlightWall server's data volume.
#
#   ./tools/publish_assets.sh ui              the web UI
#   ./tools/publish_assets.sh logos           all logo tiles
#   ./tools/publish_assets.sh logo JZA        one logo tile
#   ./tools/publish_assets.sh firmware        the signed image, signature and version
#   ./tools/publish_assets.sh all             ui + logos + firmware (if signed)
#
# WHY THIS EXISTS. Assets live on the VOLUME rather than in the container image,
# deliberately: adding one 2KB logo must not require rebuilding and redeploying
# a server. The cost of that choice is a second delivery path, and doing it by
# hand is `scp` plus `docker cp` plus looking up the container name -- three
# commands and a name that changes on every deploy, repeated per file.
#
# EVERY PUBLISH IS VERIFIED against what the server actually serves afterwards,
# which is the part worth automating. The manifest is what the device trusts to
# decide whether to download, so "the file is on the box" is not the question --
# "the server now advertises the hash I just uploaded" is. That check caught
# nothing during development only because it was being done by hand each time.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DEPLOY_YML="server/config/deploy.yml"

# One source of truth for where the server is: the file Kamal already deploys
# with. Overridable for a different box, but never duplicated by default -- a
# host that is right in one file and stale in another is worse than no default.
read_yaml_scalar() {  # key, file  (first match, unquoted)
  sed -n "s/^[[:space:]]*$1:[[:space:]]*\"\{0,1\}\([^\"#]*\)\"\{0,1\}[[:space:]]*$/\1/p" "$2" | head -1 | tr -d '[:space:]'
}

HOST="${FLIGHTWALL_HOST:-$(sed -n '/^servers:/,/^[a-z]/p' "$DEPLOY_YML" 2>/dev/null | sed -n 's/^[[:space:]]*-[[:space:]]*//p' | head -1)}"
SSH_USER="${FLIGHTWALL_SSH_USER:-$(read_yaml_scalar user "$DEPLOY_YML" 2>/dev/null)}"
PROXY_HOST="${FLIGHTWALL_PROXY_HOST:-$(read_yaml_scalar host "$DEPLOY_YML" 2>/dev/null)}"
SSH_USER="${SSH_USER:-ubuntu}"
BASE_URL="${FLIGHTWALL_URL:-https://${PROXY_HOST}}"

if [ -z "$HOST" ]; then
  echo "cannot work out the server host; set FLIGHTWALL_HOST" >&2
  exit 2
fi

SSH="ssh -o BatchMode=yes ${SSH_USER}@${HOST}"

# The container name carries the deployed git sha, so it changes on every
# deploy and cannot be hardcoded. Asked for by LABEL instead, which is stable.
container() {
  $SSH 'docker ps --format "{{.Names}}" --filter label=service=flightwall-server' | head -1
}

# Resolved lazily by need_container(), NOT at startup: printing usage should
# not open an SSH connection, and `--help`-shaped invocations are common enough
# that making them touch the network is its own small bug.
CN=""
need_container() {
  [ -n "$CN" ] && return 0
  CN="$(container)"
  if [ -z "$CN" ]; then
    echo "no running flightwall-server container on $HOST" >&2
    exit 1
  fi
  echo "publishing to $HOST ($BASE_URL), container $CN"
}

sha_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

# docker cp cannot create intermediate directories, and on a fresh volume none
# of these exist yet.
ensure_dirs() {
  $SSH "docker exec $CN mkdir -p /app/data/assets/logos /app/data/assets/firmware"
}

# scp to the host, then docker cp into the container. Two hops because the
# volume is not reachable from outside the container without root on the box.
put() {  # local-path, container-path
  local src="$1" dst="$2" tmp
  tmp="/tmp/fwpub.$$.$(basename "$dst")"
  scp -q -o BatchMode=yes "$src" "${SSH_USER}@${HOST}:$tmp"
  $SSH "docker cp '$tmp' '$CN:$dst' && rm -f '$tmp'"
}

manifest() { curl -fsS --max-time 20 "$BASE_URL/v1/assets/manifest"; }

publish_ui() {
  local src="firmware/data/index.html.gz"
  [ -f "$src" ] || { echo "no $src -- build the firmware first (pio run -e esp32s3)"; return 1; }
  ensure_dirs
  put "$src" "/app/data/assets/index.html.gz"

  local want got
  want="$(sha_of "$src")"
  got="$(manifest | python3 -c 'import json,sys; u=json.load(sys.stdin).get("ui"); print(u["sha256"] if u else "")')"
  if [ "$want" = "$got" ]; then
    echo "  ui        ok  ${want:0:12}…  ($(wc -c < "$src" | tr -d ' ') bytes)"
  else
    echo "  ui        MISMATCH: uploaded ${want:0:12}… but the server advertises ${got:0:12}…" >&2
    return 1
  fi
}

publish_one_logo() {
  local code="$1" src="firmware/data/logos/$1.rgb565"
  [ -f "$src" ] || { echo "no tile at $src" >&2; return 1; }
  ensure_dirs
  put "$src" "/app/data/assets/logos/$code.rgb565"

  # Verified against the response header rather than the manifest: logo tiles
  # are deliberately absent from the manifest (154 entries an ESP32 has no use
  # for), and the device fetches them by name the same way this does.
  local want got
  want="$(sha_of "$src")"
  got="$(curl -fsSI --max-time 20 "$BASE_URL/assets/logos/$code.rgb565" | tr -d '\r' | sed -n 's/^[Xx]-[Aa]sset-[Ss][Hh][Aa]256: //p')"
  if [ "$want" = "$got" ]; then
    echo "  logo $code   ok  ${want:0:12}…"
  else
    echo "  logo $code   MISMATCH: uploaded ${want:0:12}… server has ${got:0:12}…" >&2
    return 1
  fi
}

publish_logos() {
  local count
  count="$(ls firmware/data/logos/*.rgb565 2>/dev/null | wc -l | tr -d ' ')"
  [ "$count" != "0" ] || { echo "no logo tiles found" >&2; return 1; }
  ensure_dirs

  # One tar rather than N round trips: 154 tiles is 154 scp handshakes
  # otherwise, and this is the operation most likely to be run in bulk.
  local tgz="/tmp/fwpub.logos.$$.tgz"
  tar -C firmware/data -czf "$tgz" logos
  scp -q -o BatchMode=yes "$tgz" "${SSH_USER}@${HOST}:$tgz"
  $SSH "docker cp '$tgz' '$CN:/tmp/logos.tgz' && docker exec $CN sh -c 'cd /app/data/assets && tar xzf /tmp/logos.tgz && rm -f /tmp/logos.tgz' && rm -f '$tgz'"
  rm -f "$tgz"

  local remote
  remote="$($SSH "docker exec $CN sh -c 'ls /app/data/assets/logos | wc -l'" | tr -d '[:space:]')"
  echo "  logos     $remote on the server (local: $count)"
  [ "$remote" -ge "$count" ] || { echo "  logos     FEWER on the server than locally" >&2; return 1; }

  # Spot-check one tile end to end. A count proves files arrived; only a hash
  # proves their CONTENT did.
  local first
  first="$(basename "$(ls firmware/data/logos/*.rgb565 | head -1)" .rgb565)"
  publish_one_logo "$first" >/dev/null && echo "  logos     content spot-check ok ($first)"
}

publish_firmware() {
  local d="dist/firmware"
  for f in firmware.bin firmware.sig version.txt target.txt; do
    [ -f "$d/$f" ] || { echo "no $d/$f -- run tools/sign_firmware.sh first" >&2; return 1; }
  done

  # Re-verify the signature before it goes anywhere. Publishing an image the
  # device will refuse wastes a 1.2MB download and looks, from the wall,
  # exactly like an attack -- indistinguishable from the tampering this whole
  # mechanism exists to catch.
  #
  # Checked against the PUBLIC key compiled into the firmware, not against the
  # private key's public half. That is deliberate on two counts: this needs no
  # secret at all, so it runs anywhere; and it asks the question the DEVICE will
  # ask -- "does this verify under the key the wall actually holds" -- which
  # catches signing with the wrong key, something a private-key check cannot.
  local pub; pub="$(mktemp)"
  trap 'rm -f "$pub"' RETURN
  # The trailing ";" on the final line is part of the C declaration, not the
  # PEM -- omitting it from the pattern silently drops "-----END PUBLIC KEY-----"
  # and openssl then rejects a key that is perfectly fine.
  sed -n 's/^ *"\(.*\)\\n";\{0,1\}$/\1/p' firmware/config/FirmwareSigningKey.h > "$pub"
  if ! grep -q "BEGIN PUBLIC KEY" "$pub"; then
    echo "  firmware  cannot read the public key from firmware/config/FirmwareSigningKey.h" >&2
    return 1
  fi
  if ! openssl dgst -sha256 -verify "$pub" -signature "$d/firmware.sig" "$d/firmware.bin" >/dev/null 2>&1; then
    echo "  firmware  REFUSING TO PUBLISH: signature does not verify under the key the device holds" >&2
    return 1
  fi

  ensure_dirs
  # The image LAST. Until it lands, the manifest reports null because one of
  # the three files is missing -- so a device checking mid-publish is told
  # there is nothing to install, rather than being offered an image whose
  # signature belongs to a different build.
  put "$d/version.txt" "/app/data/assets/firmware/version.txt"
  put "$d/target.txt" "/app/data/assets/firmware/target.txt"
  put "$d/firmware.sig" "/app/data/assets/firmware/firmware.sig"
  put "$d/firmware.bin" "/app/data/assets/firmware/firmware.bin"

  local want got ver tgt
  want="$(sha_of "$d/firmware.bin")"
  read -r got ver tgt <<<"$(manifest | python3 -c 'import json,sys; f=json.load(sys.stdin).get("firmware") or {}; print(f.get("sha256",""), f.get("version",""), f.get("target",""))')"
  if [ "$want" = "$got" ]; then
    echo "  firmware  ok  $ver  target=$tgt  ${want:0:12}…  ($(wc -c < "$d/firmware.bin" | tr -d ' ') bytes)"
  else
    echo "  firmware  MISMATCH: uploaded ${want:0:12}… but the server advertises ${got:0:12}…" >&2
    return 1
  fi
}

CMD="${1:-}"
case "$CMD" in
  ui)       need_container; publish_ui ;;
  logos)    need_container; publish_logos ;;
  logo)     [ -n "${2:-}" ] || { echo "usage: $0 logo <ICAO>" >&2; exit 2; }; need_container; publish_one_logo "$2" ;;
  firmware) need_container; publish_firmware ;;
  all)
    need_container
    publish_ui
    publish_logos
    if [ -f dist/firmware/firmware.bin ]; then publish_firmware; else echo "  firmware  (nothing signed; skipped)"; fi
    ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
