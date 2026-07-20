#include "core/HttpJson.h"
#include "esp_heap_caps.h"

bool HttpJson::getJson(const String &url, JsonDocument &doc,
                       const JsonDocument *filter,
                       const char *bearerToken,
                       const char *headerName,
                       const char *headerValue,
                       uint16_t timeoutMs)
{
    if (!_secureInit)
    {
        _secure.setInsecure();           // hobby device; no cert pinning (matches prior behavior)
        _secure.setHandshakeTimeout(15); // seconds; bound the TLS handshake so an unreachable
                                         // host cannot stall the single-threaded main loop/display
        _secureInit = true;
    }

    HTTPClient http;
    if (!http.begin(_secure, url))
    {
        Serial.printf("HttpJson: begin() failed  %s\n", url.c_str());
        return false;
    }
    // HTTP/1.1 keep-alive: reuse ONE TLS handshake across same-host calls within a
    // fetch cycle. adsbdb and hexdb both return Content-Length (verified), so we do
    // NOT need useHTTP10 here — and avoiding it is critical: a TLS handshake needs a
    // scarce ~40KB contiguous heap block, and on a fragmented heap re-handshaking on
    // every call fails with mbedTLS -32512. With keep-alive the persistent _secure
    // connection is reused, so a cycle pays ~1 adsbdb handshake instead of one per call.
    // (OpenSky's body IS chunked and needs useHTTP10 — but it uses its own HTTPClient,
    // not HttpJson, so this only affects the adsbdb/hexdb enrichment path.)
    http.setReuse(true);
    http.setTimeout(timeoutMs);
    http.addHeader("Accept", "application/json");
    if (bearerToken)
        http.addHeader("Authorization", String("Bearer ") + bearerToken);
    if (headerName && headerValue)
        http.addHeader(headerName, headerValue);

    int code = http.GET();
    _lastStatus = code;
    if (code != 200)
    {
        if (code != 404) // 404 = "not in this DB" — expected, not an error
            // INTERNAL (not 8BIT): on the S3, 8BIT includes PSRAM and would hide the
            // internal-RAM starvation that actually fails a TLS handshake.
            Serial.printf("HttpJson: GET %d (largestInternal=%u)  %s\n", code,
                          (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
                          url.c_str());
        http.end();
        return false;
    }

    DeserializationError err = filter
                                   ? deserializeJson(doc, http.getStream(),
                                                     DeserializationOption::Filter(*filter))
                                   : deserializeJson(doc, http.getStream());
    http.end();
    if (err)
    {
        Serial.printf("HttpJson: parse %s  %s\n", err.c_str(), url.c_str());
        return false;
    }
    return true;
}
