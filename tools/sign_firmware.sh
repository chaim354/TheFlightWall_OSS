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
# THE PRIVATE KEY IS NOT IN THIS REPOSITORY and must never be. It lives at
# $FLIGHTWALL_SIGNING_KEY (default ~/.flightwall/fw-signing-key.pem). Losing it
# means every future update needs a cable; leaking it means anyone who can
# answer the device's HTTP request owns the wall permanently. Put it somewhere
# durable and private -- a password manager, not a laptop's home directory.
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

if [ ! -f "$BIN" ]; then
  echo "no firmware image at $BIN" >&2
  echo "build one first:  cd firmware && pio run -e esp32s3" >&2
  exit 2
fi
if [ ! -f "$KEY" ]; then
  echo "no signing key at $KEY" >&2
  echo "generate one:  openssl ecparam -genkey -name prime256v1 -noout -out \"$KEY\" && chmod 600 \"$KEY\"" >&2
  echo "then update firmware/config/FirmwareSigningKey.h with its public half." >&2
  exit 2
fi

# The version the device compares against its own. Derived from git rather than
# hand-maintained, and marked -dirty when the tree has uncommitted changes --
# an image built from an unrecorded state should say so, because the whole point
# of the version is answering "what exactly is running out there".
VERSION="$(git rev-parse --short HEAD)"
if ! git diff --quiet || ! git diff --cached --quiet; then
  VERSION="${VERSION}-dirty"
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
trap 'rm -f "$PUBTMP"' EXIT
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
