#include "core/AssetUpdater.h"

#include <HTTPClient.h>
#include <LittleFS.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <mbedtls/sha256.h>

namespace
{
    /**
     * TLS is unverified here, exactly as every other outbound call from this
     * device already is (see FlightWallServerFetcher::secureClient).
     *
     * DELIBERATE FOR THIS PHASE, and bounded by what is being fetched. The
     * design records why: the server sits behind Cloudflare, so the device sees
     * an edge certificate on a chain nobody here controls, and a pin that stops
     * matching is a device that can no longer fetch. For a WEB PAGE that trade
     * is not worth making -- the SHA check below still catches corruption, and
     * the worst a hostile page can do is misconfigure a flight display whose
     * built-in copy is one delete away.
     *
     * It is NOT an acceptable answer for firmware, where the same weakness
     * becomes permanent code execution. That decision is called out as a
     * prerequisite for phase 3 and must be settled before a .bin is fetched
     * through this path.
     */
    WiFiClientSecure &secureClient()
    {
        static WiFiClientSecure client;
        static bool configured = false;
        if (!configured)
        {
            client.setInsecure();
            configured = true;
        }
        return client;
    }

    String toHex(const uint8_t *bytes, size_t len)
    {
        static const char *kHex = "0123456789abcdef";
        String out;
        out.reserve(len * 2);
        for (size_t i = 0; i < len; ++i)
        {
            out += kHex[(bytes[i] >> 4) & 0x0F];
            out += kHex[bytes[i] & 0x0F];
        }
        return out;
    }

    String readSmallFile(const char *path)
    {
        File f = LittleFS.open(path, "r");
        if (!f)
            return String();
        String out = f.readString();
        f.close();
        out.trim();
        return out;
    }

    /**
     * Stream a URL into `destPath`, hashing as it goes, and only publish the
     * result if the hash matches.
     *
     * The temp file is what makes a failure harmless. Writing straight to
     * destPath would mean a connection dropped at 80% leaves a truncated web UI
     * that serves as a broken page -- worse than the old one, and on the
     * surface used to fix things.
     *
     * Chunked rather than buffered whole: 12KB fits easily today, but the same
     * function carries a 1.2MB firmware image in phase 3, and a device whose
     * scarce resource is the largest CONTIGUOUS heap block cannot allocate that.
     */
    /** Hex SHA-256 of a file already on the filesystem, or "" if unreadable. */
    String hashFile(const char *path)
    {
        File f = LittleFS.open(path, "r");
        if (!f)
            return String();

        mbedtls_sha256_context ctx;
        mbedtls_sha256_init(&ctx);
        mbedtls_sha256_starts(&ctx, 0); // 0 = SHA-256, not SHA-224

        uint8_t buf[512];
        while (true)
        {
            const int n = f.read(buf, sizeof(buf));
            if (n <= 0)
                break;
            mbedtls_sha256_update(&ctx, buf, (size_t)n);
        }
        f.close();

        uint8_t digest[32];
        mbedtls_sha256_finish(&ctx, digest);
        mbedtls_sha256_free(&ctx);
        return toHex(digest, sizeof(digest));
    }

    /**
     * Stream a URL into `destPath`, and only publish it if the hash matches.
     *
     * The temp file is what makes a failure harmless. Writing straight to
     * destPath would mean a connection dropped at 80% leaves a truncated web UI
     * that serves as a broken page -- worse than the old one, and on the
     * surface used to fix things.
     *
     * writeToStream() rather than reading getStreamPtr() by hand, and that is
     * not a style preference. This server answers through Cloudflare with
     * TRANSFER-ENCODING: CHUNKED and no content-length, and a hand-rolled read
     * of the raw stream receives the chunk framing along with the body -- the
     * size lines and their CRLFs. Measured: 12,770 bytes arrived for a 12,757
     * byte file, and the hash check correctly rejected all of it. HTTPClient
     * de-chunks only when it does the reading, so it does the reading.
     *
     * The cost is hashing in a second pass, off the filesystem, instead of
     * inline. That is cheap here and stays cheap for a 1.2MB firmware image:
     * it is sequential reads into a 512-byte buffer, and it never needs the
     * body in RAM -- which a device whose scarce resource is the largest
     * CONTIGUOUS heap block could not provide anyway.
     */
    bool streamVerified(const String &url, const char *destPath, const String &expectedSha, String &err)
    {
        HTTPClient http;
        if (!http.begin(secureClient(), url))
        {
            err = "connect failed";
            return false;
        }
        http.setTimeout(20000);
        const int code = http.GET();
        if (code != HTTP_CODE_OK)
        {
            err = String("HTTP ") + code;
            http.end();
            return false;
        }

        const String tmpPath = String(destPath) + ".part";
        File out = LittleFS.open(tmpPath, "w");
        if (!out)
        {
            err = "cannot open temp file";
            http.end();
            return false;
        }

        const int written = http.writeToStream(&out);
        out.close();
        http.end();

        if (written <= 0)
        {
            err = String("download failed (") + written + ")";
            LittleFS.remove(tmpPath);
            return false;
        }

        const String got = hashFile(tmpPath.c_str());
        if (!expectedSha.equalsIgnoreCase(got))
        {
            // The whole reason the temp file exists: what is already at
            // destPath is untouched and still works. A TRUNCATED body lands
            // here too -- there is no separate short-read check, because
            // without a content-length there is no length to check against,
            // and a partial body cannot produce the right hash.
            err = String("sha mismatch (") + written + " bytes)";
            LittleFS.remove(tmpPath);
            return false;
        }

        LittleFS.remove(destPath); // rename() will not overwrite
        if (!LittleFS.rename(tmpPath, destPath))
        {
            err = "rename failed";
            LittleFS.remove(tmpPath);
            return false;
        }
        return true;
    }
}

namespace AssetUpdater
{
    ManifestResult fetchManifest(const String &serverUrl)
    {
        ManifestResult r;
        if (serverUrl.length() == 0)
        {
            r.error = "no server URL configured";
            return r;
        }

        HTTPClient http;
        const String url = serverUrl + "/v1/assets/manifest";
        if (!http.begin(secureClient(), url))
        {
            r.error = "connect failed";
            return r;
        }
        http.setTimeout(10000);
        const int code = http.GET();
        if (code != HTTP_CODE_OK)
        {
            r.error = String("HTTP ") + code;
            http.end();
            return r;
        }

        JsonDocument doc;
        const DeserializationError e = deserializeJson(doc, http.getStream());
        http.end();
        if (e)
        {
            r.error = String("bad JSON: ") + e.c_str();
            return r;
        }

        // ui:null is a normal answer -- a server with nothing uploaded yet --
        // and leaves uiSha empty, which updateUi() reports rather than treating
        // as a failure.
        JsonObject ui = doc["ui"].as<JsonObject>();
        if (!ui.isNull())
        {
            r.uiSha = ui["sha256"].as<String>();
            r.uiSize = ui["size"].as<size_t>();
        }
        r.ok = true;
        return r;
    }

    String cachedUiSha()
    {
        return readSmallFile(kUiShaPath);
    }

    bool servingCachedUi()
    {
        return LittleFS.exists(kUiCachePath);
    }

    bool clearCachedUi()
    {
        LittleFS.remove(kUiShaPath);
        return LittleFS.remove(kUiCachePath);
    }

    FetchResult updateUi(const String &serverUrl)
    {
        FetchResult r;
        const ManifestResult m = fetchManifest(serverUrl);
        if (!m.ok)
        {
            r.error = m.error;
            return r;
        }
        if (m.uiSha.length() == 0)
        {
            r.error = "server has no web UI uploaded";
            return r;
        }
        if (m.uiSha.equalsIgnoreCase(cachedUiSha()) && servingCachedUi())
        {
            r.ok = true; // already current; not an error and not a download
            return r;
        }

        String err;
        if (!streamVerified(serverUrl + "/assets/index.html.gz", kUiCachePath, m.uiSha, err))
        {
            r.error = err;
            return r;
        }

        // Written only after the page itself is in place, so a crash between
        // the two leaves a stale hash next to a good page -- which costs one
        // redundant download -- rather than a current hash beside a bad page,
        // which would make the device believe it is up to date when it is not.
        File f = LittleFS.open(kUiShaPath, "w");
        if (f)
        {
            f.print(m.uiSha);
            f.close();
        }

        r.ok = true;
        r.changed = true;
        return r;
    }
}
