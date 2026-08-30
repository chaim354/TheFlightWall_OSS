#!/usr/bin/env bash
#
# Publish a signed firmware image to the FlightWall server OVER HTTP, and
# optionally tell the wall to install it.
#
#   ./tools/publish_firmware.sh                 upload dist/firmware
#   ./tools/publish_firmware.sh --update        upload, then queue `updatefw`
#   ./tools/publish_firmware.sh --update-only   queue `updatefw`, upload nothing
#   ./tools/publish_firmware.sh --ui            upload the web UI
#   ./tools/publish_firmware.sh --ui-update     upload the web UI, queue `updateui`
#
# The UI has always been collectable over the air -- `updateui` makes the device
# fetch /assets/index.html.gz and cache it in LittleFS, so the page does NOT
# need uploadfs and a cable. Only the upload side needed shell access, which is
# what --ui removes.
#
# WHY THIS EXISTS. tools/publish_assets.sh ships firmware by scp plus `docker
# exec` plus looking up a container name that changes on every deploy -- so
# releasing needed shell access to the box, and could not be driven from
# anywhere else. The device has always fetched over HTTP; nothing accepted an
# upload over it until /v1/control/firmware.
#
# THE ADMIN PASSWORD IS NEVER PASSED ON THE COMMAND LINE and is not echoed. It
# comes from 1Password (vault `tinkerex`, item `flightwall-admin-password`),
# the same place the signing key and the server's own secrets live, or from
# $FLIGHTWALL_ADMIN_PASSWORD if you would rather supply it in the environment.
# It goes out in an Authorization header over TLS and nowhere else.
#
# Uploading does NOT install anything: the manifest changes, and the wall only
# acts on it when an `updatefw` command is queued -- which is why --update is a
# separate, deliberate flag.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SERVER="${FLIGHTWALL_SERVER_URL:-https://flightwall.tinkerex.com}"
DIR="${FLIGHTWALL_FIRMWARE_DIR:-dist/firmware}"
OP_ITEM="${FLIGHTWALL_ADMIN_ITEM:-flightwall-admin-password}"
OP_VAULT="${FLIGHTWALL_ADMIN_VAULT:-tinkerex}"

DO_UPLOAD=1
DO_UPDATE=0
DO_UI=0
UI_FILE="${FLIGHTWALL_UI_FILE:-firmware/data/index.html.gz}"
case "${1:-}" in
  --update)      DO_UPDATE=1 ;;
  --update-only) DO_UPDATE=1; DO_UPLOAD=0 ;;
  --ui)          DO_UI=1; DO_UPLOAD=0 ;;
  --ui-update)   DO_UI=1; DO_UPLOAD=0; DO_UPDATE=updateui ;;
  "")            ;;
  *) echo "usage: $0 [--update|--update-only|--ui|--ui-update]" >&2; exit 2 ;;
esac

# --- the admin password, fetched but never printed --------------------------
PASS="${FLIGHTWALL_ADMIN_PASSWORD:-}"
if [ -z "$PASS" ]; then
  if ! command -v op >/dev/null 2>&1; then
    echo "no admin password: \$FLIGHTWALL_ADMIN_PASSWORD unset and 'op' not installed" >&2
    exit 2
  fi
  PASS="$(op read "op://$OP_VAULT/$OP_ITEM/password" 2>/dev/null || true)"
  if [ -z "$PASS" ]; then
    echo "no admin password: not in \$FLIGHTWALL_ADMIN_PASSWORD, and 1Password returned nothing" >&2
    echo "  tried:  op read op://$OP_VAULT/$OP_ITEM/password   (is 'op' signed in?)" >&2
    exit 2
  fi
  echo "using the admin password from 1Password ($OP_VAULT/$OP_ITEM)"
fi

api () { # method path [extra curl args...]
  local method="$1" path="$2"; shift 2
  curl -sS -X "$method" "$SERVER$path" \
    -H "Authorization: Bearer $PASS" "$@"
}

if [ "$DO_UPLOAD" = 1 ]; then
  for f in firmware.bin firmware.sig version.txt target.txt; do
    [ -f "$DIR/$f" ] || { echo "missing $DIR/$f -- run tools/sign_firmware.sh first" >&2; exit 2; }
  done
  VERSION="$(cat "$DIR/version.txt")"
  TARGET="$(cat "$DIR/target.txt")"
  SIG="$(base64 < "$DIR/firmware.sig" | tr -d '\n')"
  SIZE="$(wc -c < "$DIR/firmware.bin" | tr -d ' ')"

  echo "uploading $VERSION ($TARGET, $SIZE bytes) to $SERVER"
  RESP="$(api POST "/v1/control/firmware?version=$VERSION&target=$TARGET" \
            -H "Content-Type: application/octet-stream" \
            -H "X-Firmware-Sig: $SIG" \
            --data-binary "@$DIR/firmware.bin")"
  echo "  $RESP"
  case "$RESP" in *'"ok":true'*) ;; *) echo "upload refused" >&2; exit 1 ;; esac

  # VERIFY AGAINST WHAT THE SERVER NOW SERVES, not against its own reply. The
  # manifest is what the device trusts, so "the POST returned 200" is not the
  # question -- "the server advertises the hash I just sent" is.
  WANT="$(shasum -a 256 "$DIR/firmware.bin" | cut -d' ' -f1)"
  GOT="$(curl -sS "$SERVER/v1/assets/manifest" \
          | python3 -c 'import json,sys; f=json.load(sys.stdin).get("firmware") or {}; print(f.get("sha256",""), f.get("version",""), f.get("target",""))')"
  read -r GOTSHA GOTVER GOTTGT <<<"$GOT"
  if [ "$WANT" = "$GOTSHA" ]; then
    echo "  manifest ok  $GOTVER  target=$GOTTGT  ${WANT:0:12}…"
  else
    echo "  MANIFEST MISMATCH: server advertises ${GOTSHA:0:12}…, uploaded ${WANT:0:12}…" >&2
    exit 1
  fi
fi

if [ "$DO_UI" = 1 ]; then
  [ -f "$UI_FILE" ] || { echo "missing $UI_FILE -- build the firmware first, it gzips the page" >&2; exit 2; }
  # Guard here as well as server-side: catching it locally costs one byte
  # comparison and saves a round trip with the admin credential attached.
  head -c 2 "$UI_FILE" | od -An -tx1 | grep -q "1f 8b" \
    || { echo "$UI_FILE is not gzip -- upload index.html.gz, not index.html" >&2; exit 2; }
  echo "uploading web UI ($(wc -c < "$UI_FILE" | tr -d ' ') bytes) to $SERVER"
  RESP="$(api POST /v1/control/ui \
            -H "Content-Type: application/octet-stream" \
            --data-binary "@$UI_FILE")"
  echo "  $RESP"
  case "$RESP" in *'"ok":true'*) ;; *) echo "upload refused" >&2; exit 1 ;; esac
  WANT="$(shasum -a 256 "$UI_FILE" | cut -d' ' -f1)"
  GOT="$(curl -sS "$SERVER/v1/assets/manifest" \
          | python3 -c 'import json,sys; u=json.load(sys.stdin).get("ui") or {}; print(u.get("sha256",""))')"
  if [ "$WANT" = "$GOT" ]; then
    echo "  manifest ok  ui  ${WANT:0:12}…"
  else
    echo "  MANIFEST MISMATCH: server advertises ${GOT:0:12}…, uploaded ${WANT:0:12}…" >&2
    exit 1
  fi
fi

if [ "$DO_UPDATE" = "updateui" ]; then
  echo "queueing updateui"
  RESP="$(api POST /v1/control/command \
            -H "Content-Type: application/json" \
            -d '{"action":"updateui"}')"
  echo "  $RESP"
  case "$RESP" in *'"ok":true'*) ;; *) echo "queueing refused" >&2; exit 1 ;; esac
  echo "  the wall collects it on its next check-in"
elif [ "$DO_UPDATE" = 1 ]; then
  echo "queueing updatefw"
  RESP="$(api POST /v1/control/command \
            -H "Content-Type: application/json" \
            -d '{"action":"updatefw"}')"
  echo "  $RESP"
  case "$RESP" in *'"ok":true'*) ;; *) echo "queueing refused" >&2; exit 1 ;; esac
  echo "  the wall installs it on its next check-in (within one fetch interval)"
fi
