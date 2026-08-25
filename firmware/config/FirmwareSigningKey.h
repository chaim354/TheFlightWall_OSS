/*
Purpose: The PUBLIC half of the firmware signing key.

Safe to commit and safe to publish -- it can only VERIFY. The private half
never enters this repository; see tools/sign_firmware.sh.

WHY SIGNING RATHER THAN TRUSTED TRANSPORT. This device fetches over TLS it does
not verify, and pinning a CA was rejected as the answer for firmware: the server
sits behind Cloudflare, so the chain belongs to someone else and rotates, and a
pin that stops matching is a device that can no longer update -- with the fix
itself only deliverable by update. A signature moves the trust decision off the
transport entirely. A hostile network can serve any bytes it likes; without this
key's private half it cannot make them boot.

The signature is ECDSA P-256 over the SHA-256 of the image, which is what
`openssl dgst -sha256 -sign` produces and what mbedtls_pk_verify() consumes.
Both are available and linkable in this framework -- checked, not assumed.

ROTATION: replacing this key means flashing over a cable, because an update
signed by a new key cannot be verified by a device that only knows the old one.
That is the cost of the guarantee, not an oversight.
*/
#pragma once

static const char *kFirmwareSigningPublicKeyPem =
    "-----BEGIN PUBLIC KEY-----\n"
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE438qN2xJV3RCYkK52p6p4S2QZYAQ\n"
    "KLV27sQjjbUSdvN8gmlZ54wkg/p91vLn+LZgAn5WHe4Dj3dlUdb7cc7gFA==\n"
    "-----END PUBLIC KEY-----\n";
