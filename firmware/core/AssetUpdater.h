/*
Purpose: Download a file from the FlightWall server into LittleFS, verified.

ONE mechanism, three eventual uses: the web UI (now), logo tiles, and a firmware
image. They differ only in size and in what happens after the write, so this is
deliberately about bytes and hashes and knows nothing about what it is fetching.

See docs/superpowers/specs/2026-08-25-server-delivered-assets-design.md.

The write discipline is the whole point: stream to a TEMP path while hashing,
compare, and only then rename over the destination. A truncated download, a
snapped connection or a corrupted body therefore cannot replace a file that
currently works -- which matters most for the web UI, because that page is how
someone fixes a device that is misbehaving.
*/
#pragma once

#include <Arduino.h>

namespace AssetUpdater
{
    /** Where the downloaded web UI lands. handleRoot() prefers this over the
     * built-in /index.html.gz, so a bad or absent download degrades to the
     * page that shipped with the firmware rather than to nothing. */
    static const char *kUiCachePath = "/index.cache.html.gz";
    /** Hex SHA-256 of whatever is at kUiCachePath, so the device can answer
     * "do I already have this?" without re-hashing 12KB on every check. */
    static const char *kUiShaPath = "/index.cache.sha";

    struct ManifestResult
    {
        bool ok = false;
        String uiSha;   // empty when the server has no UI uploaded
        size_t uiSize = 0;
        String error;
    };

    /** GET <serverUrl>/v1/assets/manifest. */
    ManifestResult fetchManifest(const String &serverUrl);

    struct FetchResult
    {
        bool ok = false;
        bool changed = false; // false when the local copy already matched
        String error;
    };

    /**
     * Bring the cached web UI up to date with the server.
     *
     * A no-op when the stored hash already equals the manifest's, so pressing
     * the button twice costs one HTTP request rather than two downloads.
     */
    FetchResult updateUi(const String &serverUrl);

    /** Hex SHA-256 recorded for the cached UI, or "" when there is no cache. */
    String cachedUiSha();

    /** True when a downloaded UI exists and will be served in preference to
     * the built-in one. */
    bool servingCachedUi();

    /** Delete the cached UI, so the built-in page is served again. The escape
     * hatch for a download that is valid, current, and bad. */
    bool clearCachedUi();

    enum class LogoResult
    {
        AlreadyPresent, // already on the filesystem; nothing was fetched
        Downloaded,     // fetched, verified, written
        NotOnServer,    // the server does not have this operator's tile (404)
        Failed,         // transport, verification or filesystem problem
    };

    /**
     * Make sure `/logos/<ICAO>.rgb565` exists, fetching it once if it does not.
     *
     * Fetched BY NAME rather than from a manifest: a listing of 154 tiles is
     * something the device has no use for, and a miss on a specific operator is
     * exactly the evidence that one is wanted.
     *
     * A 404 is remembered for the rest of the boot. Without that, an operator
     * genuinely absent from the server would be re-requested every carousel
     * cycle, forever -- the wall asking the same question several times a
     * minute and always getting the same no.
     */
    LogoResult ensureLogo(const String &serverUrl, const String &icao);

    /** How many operators have been recorded as absent this boot. Diagnostic. */
    size_t missingLogoCount();
}
