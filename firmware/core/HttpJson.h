#pragma once
/*
Purpose: One shared HTTPS+JSON client for all fetchers.
- Owns a single persistent WiFiClientSecure so the ~40KB mbedTLS buffers are
  allocated once (early), not per request. Repeated per-request allocation is
  what fragments the heap and makes later TLS handshakes fail with adequate
  total free heap but no contiguous block.
- Streams the response body directly into ArduinoJson (no whole-body String).
- Uses HTTP/1.1 keep-alive so ONE TLS handshake serves many same-host calls.
  (It deliberately does NOT force HTTP/1.0: that would disable keep-alive, and
  adsbdb/hexdb both return Content-Length, so the stream parser is happy on 1.1.
  OpenSky's body IS chunked and does need useHTTP10 — but OpenSky uses its own
  HTTPClient, not this class.)
*/
#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

class HttpJson
{
public:
    // Fills `doc` on success. Optional `filter` limits which fields are parsed.
    // Optional bearer token and a single extra header (e.g. AeroAPI x-apikey).
    // Returns true only on HTTP 200 + successful parse. 404 is treated as a
    // silent miss (not logged); other failures log the code + largest free block.
    bool getJson(const String &url, JsonDocument &doc,
                 const JsonDocument *filter = nullptr,
                 const char *bearerToken = nullptr,
                 const char *headerName = nullptr,
                 const char *headerValue = nullptr,
                 uint16_t timeoutMs = 12000);

    int lastStatus() const { return _lastStatus; }

private:
    WiFiClientSecure _secure;
    bool _secureInit = false;
    int _lastStatus = 0;
};
