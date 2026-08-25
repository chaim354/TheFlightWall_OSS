#!/usr/bin/env bash
#
# Sign a firmware image for over-the-air delivery, and lay out the three files
# the server needs beside each other.
#
#   ./tools/sign_firmware.sh [path/to/firmware.bin] [outdir]
#
# Defaults to the ESP32-S3 build output and ./dist/firmware.
#
# WHY A SIGNATURE. The device fetches over TLS it does not verify, and pinning a
# CA was rejected for firmware: the server is behind Cloudflare, the chain
# belongs to someone else and rotates, and a pin that stops matching is a device
# that can no longer update -- with the fix only deliverable by update. Signing
# moves the trust decision off the transport. A hostile network can serve any
# bytes it likes; without the private key it cannot make them boot.
#
# THE PRIVATE KEY IS NOT IN THIS REPOSITORY and must never be. It lives in
# 1Password (vault `tinkerex`, document `flightwall-firmware-signing-key`),
# alongside the other secrets this project uses -- the same place
# server/.kamal/secrets pulls from. Losing it means every future update needs a
# cable; leaking it means anyone who can answer the device's HTTP request owns
# the wall permanently.
#
# It is fetched to a mode-600 temp file for the length of one signing run and
# removed on exit, so it need not sit on any disk between releases. A local file
# at $FLIGHTWALL_SIGNING_KEY is still honoured and takes precedence, for working
# offline or from another machine.
#
# The public half lives in firmware/config/FirmwareSigningKey.h and is compiled
# into the device. Changing the key requires flashing over a cable, by design:
# an image signed with a new key cannot be verified by a device that only knows
# the old one.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

BIN="${1:-firmware/.pio/build/esp32s3/firmware.bin}"
OUT="${2:-dist/firmware}"
KEY="${FLIGHTWALL_SIGNING_KEY:-$HOME/.flightwall/fw-signing-key.pem}"
OP_ITEM="${FLIGHTWALL_SIGNING_KEY_ITEM:-flightwall-firmware-signing-key}"
OP_VAULT="${FLIGHTWALL_SIGNING_KEY_VAULT:-tinkerex}"

# A local file wins if present; otherwise pull from 1Password into a temp file
# that exists only for this run. mktemp creates it mode 600 BEFORE anything is
# written, which is the ordering that matters -- a key briefly world-readable is
# a key that was world-readable.
FETCHED_KEY=""
cleanup_key() { [ -n "$FETCHED_KEY" ] && rm -f "$FETCHED_KEY"; }
trap cleanup_key EXIT

if [ ! -f "$KEY" ] && command -v op >/dev/null 2>&1; then
  FETCHED_KEY="$(mktemp)"
  if op document get "$OP_ITEM" --vault "$OP_VAULT" > "$FETCHED_KEY" 2>/dev/null && [ -s "$FETCHED_KEY" ]; then
    KEY="$FETCHED_KEY"
    echo "signing with the key from 1Password ($OP_VAULT/$OP_ITEM)"
  else
    rm -f "$FETCHED_KEY"; FETCHED_KEY=""
  fi
fi

if [ ! -f "$BIN" ]; then
  echo "no firmware image at $BIN" >&2
  echo "build one first:  cd firmware && pio run -e esp32s3" >&2
  exit 2
fi
if [ ! -f "$KEY" ]; then
  echo "no signing key: not at $KEY, and not retrievable from 1Password" >&2
  echo "  1Password:  op document get $OP_ITEM --vault $OP_VAULT   (is 'op' signed in?)" >&2
  echo "  or generate:  openssl ecparam -genkey -name prime256v1 -noout -out \"$KEY\" && chmod 600 \"$KEY\"" >&2
  echo "  then update firmware/config/FirmwareSigningKey.h with its public half." >&2
  exit 2
fi

# The version the device compares against its own, read from the file the BUILD
# wrote beside the binary -- never re-derived from git here.
#
# That distinction is load-bearing. Signing an existing binary after any further
# commit or edit would otherwise advertise a version the image does not contain,
# and the device would install it, boot reporting what was actually compiled in,
# see a different version still on offer, and loop forever. Observed during
# development: a manifest reading 122268d-dirty for an image built as c04980b.
VERSION_FILE="$(dirname "$BIN")/fw_version.txt"
if [ ! -f "$VERSION_FILE" ]; then
  echo "no $VERSION_FILE beside the image" >&2
  echo "rebuild so the version is stamped by the build:  cd firmware && pio run -e esp32s3" >&2
  exit 2
fi
VERSION="$(cat "$VERSION_FILE")"
if [ -z "$VERSION" ]; then
  echo "$VERSION_FILE is empty" >&2
  exit 2
fi

mkdir -p "$OUT"
cp "$BIN" "$OUT/firmware.bin"

# ECDSA P-256 over the image's SHA-256. `openssl dgst -sha256 -sign` hashes the
# file and signs that digest, producing a DER signature -- exactly what
# mbedtls_pk_verify(..., MBEDTLS_MD_SHA256, hash, 32, sig, len) consumes on the
# device.
openssl dgst -sha256 -sign "$KEY" -out "$OUT/firmware.sig" "$OUT/firmware.bin"
printf '%s' "$VERSION" > "$OUT/version.txt"

SHA="$(shasum -a 256 "$OUT/firmware.bin" | cut -d' ' -f1)"
SIZE="$(wc -c < "$OUT/firmware.bin" | tr -d ' ')"

# Verify what was just produced, with the PUBLIC key, before anyone ships it.
# A signing step that cannot be checked locally is one whose first real test is
# a device that refuses to update.
PUBTMP="$(mktemp)"
# Extends the key cleanup rather than replacing it -- a second `trap ... EXIT`
# would silently drop the first, leaving the fetched private key on disk.
trap 'rm -f "$PUBTMP"; cleanup_key' EXIT
openssl ec -in "$KEY" -pubout -out "$PUBTMP" 2>/dev/null
if openssl dgst -sha256 -verify "$PUBTMP" -signature "$OUT/firmware.sig" "$OUT/firmware.bin" >/dev/null 2>&1; then
  echo "signature verifies against the public key"
else
  echo "SIGNATURE DID NOT VERIFY -- refusing to leave a bad image in $OUT" >&2
  rm -f "$OUT/firmware.sig"
  exit 1
fi

cat <<EOF

  image    $OUT/firmware.bin
  version  $VERSION
  size     $SIZE bytes
  sha256   $SHA
  sig      $OUT/firmware.sig ($(wc -c < "$OUT/firmware.sig" | tr -d ' ') bytes, DER)

Upload all three to the server's asset volume under assets/firmware/.
EOF
