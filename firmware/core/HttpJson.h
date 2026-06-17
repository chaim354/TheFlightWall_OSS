#pragma once
/*
Purpose: One shared HTTPS+JSON client for all fetchers.
- Owns a single persistent WiFiClientSecure so the ~40KB mbedTLS buffers are
  allocated once (early), not per request. Repeated per-request allocation is
  what fragments the heap and makes later TLS handshakes fail with adequate
  total free heap but no contiguous block.
- Streams the response body directly into ArduinoJson (no whole-body String),
  and forces HTTP/1.0 so servers return an unchunked Content-Length body the
  stream parser can consume (OpenSky's chunked body breaks raw getStream()).
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
