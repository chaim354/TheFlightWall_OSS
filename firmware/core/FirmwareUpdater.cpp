#include "core/FirmwareUpdater.h"
#include "config/FirmwareSigningKey.h"

#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Update.h>
#include <esp_ota_ops.h>
#include <mbedtls/base64.h>
#include <mbedtls/pk.h>
#include <mbedtls/sha256.h>

#ifndef FW_VERSION
#define FW_VERSION "unknown"
#endif

namespace
{
    WiFiClientSecure &secureClient()
    {
        static WiFiClientSecure client;
        static bool configured = false;
        if (!configured)
        {
            // Unverified, and that is SOUND here in a way it would not be
            // without a signature: the transport carries the bytes, the
            // signature decides whether they may run. See the header.
            client.setInsecure();
            configured = true;
        }
        return client;
    }

    /**
     * A Stream that hashes what it is given and writes it into the OTA slot.
     *
     * Exists so HTTPClient::writeToStream() can do the READING, which is the
     * only way the body arrives de-chunked. This server answers through
     * Cloudflare with transfer-encoding: chunked and no content-length, so
     * reading getStreamPtr() by hand receives the chunk framing along with the
     * image -- the size lines and their CRLFs. Measured, on hardware: the very
     * first Update.write() was handed an ASCII chunk-length line and rejected
     * it with "Wrong Magic Byte", because an ESP32 image must begin 0xE9.
     *
     * The identical mistake was made and fixed one phase earlier in
     * AssetUpdater. Writing it down here because the shape recurs: on this
     * server, anything that reads a body by hand is reading chunk framing.
     */
    class UpdateSink : public Stream
    {
    public:
        explicit UpdateSink(mbedtls_sha256_context &ctx) : _ctx(ctx) {}

        size_t write(const uint8_t *buf, size_t n) override
        {
            mbedtls_sha256_update(&_ctx, buf, n);
            const size_t w = Update.write(const_cast<uint8_t *>(buf), n);
            if (w != n)
                _failed = true;
            _written += w;
            return w;
        }
        size_t write(uint8_t b) override { return write(&b, 1); }

        // Stream is read/write; nothing ever reads from this one.
        int available() override { return 0; }
        int read() override { return -1; }
        int peek() override { return -1; }
        void flush() override {}

        bool failed() const { return _failed; }
        size_t written() const { return _written; }

    private:
        mbedtls_sha256_context &_ctx;
        size_t _written = 0;
        bool _failed = false;
    };

    /**
     * ECDSA P-256 verification of `sig` over a 32-byte SHA-256 `hash`, using
     * the public key compiled into this image.
     *
     * mbedtls_pk_verify with MBEDTLS_MD_SHA256 and a DER signature is precisely
     * what `openssl dgst -sha256 -sign` produces on the other side -- the two
     * halves were checked against each other before either was wired up.
     */
    bool verifySignature(const uint8_t hash[32], const uint8_t *sig, size_t sigLen, String &err)
    {
        mbedtls_pk_context pk;
        mbedtls_pk_init(&pk);

        // +1 for the NUL: mbedtls_pk_parse_public_key wants the terminator
        // COUNTED for a PEM key, and silently fails to parse without it.
        const size_t pemLen = strlen(kFirmwareSigningPublicKeyPem) + 1;
        int rc = mbedtls_pk_parse_public_key(
            &pk, (const unsigned char *)kFirmwareSigningPublicKeyPem, pemLen);
        if (rc != 0)
        {
            err = String("public key unusable (") + rc + ")";
            mbedtls_pk_free(&pk);
            return false;
        }

        rc = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, hash, 32, sig, sigLen);
        mbedtls_pk_free(&pk);
        if (rc != 0)
        {
            // The one error a user must be able to read plainly: these bytes
            // were not signed by the key this device trusts.
            err = "signature does not verify";
            return false;
        }
        return true;
    }
}

namespace FirmwareUpdater
{
    const char *runningVersion()
    {
        return FW_VERSION;
    }

    bool awaitingValidation()
    {
        const esp_partition_t *running = esp_ota_get_running_partition();
        esp_ota_img_states_t state;
        if (esp_ota_get_state_partition(running, &state) != ESP_OK)
            return false;
        return state == ESP_OTA_IMG_PENDING_VERIFY;
    }

    void markRunningImageValid()
    {
        if (!awaitingValidation())
            return;
        if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK)
            Serial.println("[ota] running image marked valid; rollback cancelled");
        else
            Serial.println("[ota] could not mark the image valid -- it will roll back");
    }

    const char *buildTarget()
    {
        // Same dispatch order as HardwareConfiguration.h. The MatrixPortal is
        // ALSO an ESP32-S3, so its explicit board flag must be tested before
        // CONFIG_IDF_TARGET_ESP32S3 or every MatrixPortal would call itself a
        // DevKit -- which is exactly the confusion this function prevents.
#if defined(FLIGHTWALL_BOARD_MATRIXPORTAL_S3)
        return "matrixportal_s3";
#elif defined(CONFIG_IDF_TARGET_ESP32S3)
        return "esp32s3";
#else
        return "esp32dev";
#endif
    }

    Available check(const String &serverUrl)
    {
        Available a;
        if (serverUrl.length() == 0)
        {
            a.error = "no server URL configured";
            return a;
        }

        HTTPClient http;
        if (!http.begin(secureClient(), serverUrl + "/v1/assets/manifest"))
        {
            a.error = "connect failed";
            return a;
        }
        http.setTimeout(10000);
        const int code = http.GET();
        if (code != HTTP_CODE_OK)
        {
            a.error = String("HTTP ") + code;
            http.end();
            return a;
        }

        JsonDocument doc;
        const DeserializationError e = deserializeJson(doc, http.getStream());
        http.end();
        if (e)
        {
            a.error = String("bad JSON: ") + e.c_str();
            return a;
        }

        JsonObject fw = doc["firmware"].as<JsonObject>();
        if (fw.isNull())
        {
            // A server with no firmware uploaded is a normal state, not a
            // fault -- the same way ui:null is.
            a.error = "server has no firmware uploaded";
            return a;
        }
        a.version = fw["version"].as<String>();
        a.sha256 = fw["sha256"].as<String>();
        a.size = fw["size"].as<size_t>();
        a.sigB64 = fw["sig"].as<String>();
        a.target = fw["target"].as<String>();

        // TARGET GATE, and it FAILS CLOSED on purpose.
        //
        // A signature proves the image is authentic; it says nothing about
        // which board it was built for. One slot serves every device, so an
        // unchecked download is how a DevKit ends up running a MatrixPortal
        // image and boot-looping until someone finds a cable.
        //
        // A manifest with no target at all is refused rather than assumed
        // compatible: silence used to mean "no check", and treating it as
        // permission would leave exactly the hazard this closes. An old server
        // therefore stops offering updates to new firmware until it is
        // republished -- a visible, recoverable state, and the safe direction
        // to fail in. The reason lands in otaError, so it is readable from the
        // control page without a cable.
        if (a.target.length() == 0)
        {
            a.error = "server did not state a firmware target; refusing";
            return a;
        }
        if (a.target != buildTarget())
        {
            a.error = String("firmware is for '") + a.target + "', this board is '" +
                      buildTarget() + "'; refusing";
            return a;
        }

        a.ok = a.version.length() && a.sha256.length() && a.sigB64.length() && a.size > 0;
        if (!a.ok)
            a.error = "incomplete firmware entry";
        return a;
    }

    ApplyResult apply(const String &serverUrl, const Available &a)
    {
        ApplyResult r;

        // Decode the signature FIRST. It is ~71 bytes and costs nothing to
        // check, whereas discovering it is malformed after streaming 1.2MB into
        // the spare slot wastes the download and the write cycles.
        uint8_t sig[128];
        size_t sigLen = 0;
        if (mbedtls_base64_decode(sig, sizeof(sig), &sigLen,
                                  (const unsigned char *)a.sigB64.c_str(),
                                  a.sigB64.length()) != 0)
        {
            r.error = "signature is not valid base64";
            return r;
        }

        HTTPClient http;
        if (!http.begin(secureClient(), serverUrl + "/assets/firmware/firmware.bin"))
        {
            r.error = "connect failed";
            return r;
        }
        http.setTimeout(30000);
        const int code = http.GET();
        if (code != HTTP_CODE_OK)
        {
            r.error = String("HTTP ") + code;
            http.end();
            return r;
        }

        // U_FLASH targets the INACTIVE ota slot; the running image is never
        // touched. Sized from the manifest because Update needs a length up
        // front and this response has no content-length -- Cloudflare serves it
        // chunked, the same way it serves everything else here.
        if (!Update.begin(a.size, U_FLASH))
        {
            r.error = String("cannot start update: ") + Update.errorString();
            http.end();
            return r;
        }

        mbedtls_sha256_context ctx;
        mbedtls_sha256_init(&ctx);
        mbedtls_sha256_starts(&ctx, 0);

        UpdateSink sink(ctx);
        const int streamed = http.writeToStream(&sink);
        const size_t written = sink.written();
        String err;
        if (sink.failed())
            err = String("flash write failed: ") + Update.errorString();
        else if (streamed < 0)
            err = String("download failed (") + streamed + ")";

        uint8_t hash[32];
        mbedtls_sha256_finish(&ctx, hash);
        mbedtls_sha256_free(&ctx);
        http.end();

        if (err.length())
        {
            Update.abort();
            r.error = err;
            return r;
        }
        if (written != a.size)
        {
            Update.abort();
            r.error = String("short download: ") + written + "/" + a.size;
            return r;
        }

        // THE GATE. Everything above merely put bytes in a slot nothing boots
        // from. This is where they earn the right to run, and it happens before
        // Update.end() -- which is what would mark the partition bootable.
        if (!verifySignature(hash, sig, sigLen, err))
        {
            Update.abort();
            r.error = err;
            return r;
        }

        if (!Update.end(true))
        {
            r.error = String("could not finalise: ") + Update.errorString();
            return r;
        }

        Serial.printf("[ota] verified %s (%u bytes); rebooting\n", a.version.c_str(),
                      (unsigned)a.size);
        delay(200); // let the serial line and the HTTP response drain
        ESP.restart();

        // Unreachable in practice; a caller that sees this got an error.
        r.error = "restart did not happen";
        return r;
    }
}
