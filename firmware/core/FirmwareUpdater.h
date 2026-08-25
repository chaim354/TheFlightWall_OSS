/*
Purpose: Apply a signed firmware image fetched from the FlightWall server.

Phase 3 of docs/superpowers/specs/2026-08-25-server-delivered-assets-design.md.

THE SIGNATURE IS THE TRUST DECISION, not the transport. This device fetches over
TLS it does not verify, and pinning a CA was rejected for firmware: the server
sits behind Cloudflare, so the certificate chain belongs to someone else and
rotates, and a pin that stops matching leaves a device that can no longer
update -- with the fix only deliverable by update. ECDSA P-256 over the image's
SHA-256 removes the transport from the question entirely. A hostile network can
serve any bytes it likes; without the private key it cannot make them boot.

NOTHING IS MADE BOOTABLE BEFORE IT IS VERIFIED. The image streams into the
INACTIVE OTA slot -- which is exactly what that slot is for, and costs nothing
if the download is rubbish -- but the boot partition is only switched after the
signature checks out. A failed download, a corrupted body or a forged image
leaves the running firmware untouched and still bootable.

AND THE BOOTLOADER GETS THE LAST WORD. CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE is
on, so a newly-flashed image boots PENDING VERIFY and is reverted unless it
declares itself healthy. See markRunningImageValid() for what "healthy" means
here -- deliberately more than "reached setup()".
*/
#pragma once

#include <Arduino.h>

namespace FirmwareUpdater
{
    /** What this build is, from git via tools/inject_version.py. */
    const char *runningVersion();

    /**
     * Tell the bootloader the running image works, cancelling the rollback it
     * would otherwise perform on the next reboot.
     *
     * Called once the device has proved it can do its job -- WiFi associated
     * AND a flight fetch succeeded -- not merely that it booted. That
     * distinction is the entire value of rollback: an image that starts,
     * initialises the panel and then cannot reach the network is precisely the
     * failure a cable-free update most needs protecting against, and it would
     * pass a "reached setup()" test happily.
     *
     * A no-op when the running image is not pending verification, which is the
     * normal case for a cable-flashed build.
     */
    void markRunningImageValid();

    /** True while the running image still owes the bootloader a verdict. */
    bool awaitingValidation();

    struct Available
    {
        bool ok = false;
        String version;   // what the server offers
        String sha256;    // expected hash of the image
        size_t size = 0;
        String sigB64;    // base64 DER ECDSA signature over that hash
        String error;
    };

    /** Read the firmware entry from the server's asset manifest. */
    Available check(const String &serverUrl);

    struct ApplyResult
    {
        bool ok = false;
        String error;
    };

    /**
     * Download, verify and stage the image, then reboot into it.
     *
     * Returns only on FAILURE -- success reboots the device, so a caller that
     * gets a value back is looking at an error every time.
     */
    ApplyResult apply(const String &serverUrl, const Available &a);
}
