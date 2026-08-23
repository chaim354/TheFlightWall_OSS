/*
Purpose: Fetch ADS-B state vectors from OpenSky Network (OAuth-protected API).
Responsibilities:
- Manage OAuth2 client_credentials token lifecycle with early refresh.
- Build geographic bounding box around a center point and query states/all.
- Parse JSON into StateVector objects and compute distance/bearing.
- Filter by radius and bearing using GeoUtils helpers.
Inputs: centerLat, centerLon, radiusKm, min/max bearing; APIConfiguration creds/URLs.
Outputs: Populates outStateVectors with filtered results (distance_km, bearing_deg set).
*/
#include "adapters/OpenSkyFetcher.h"
#include "core/Settings.h"

// The TLS client for every OpenSky call. Configured once, lazily (a global fetcher
// is constructed before WiFi/Settings exist).
//
// setHandshakeTimeout(15) is the load-bearing line. Without our own client,
// HTTPClient::begin(url) constructs a WiFiClientSecure internally whose
// handshake_timeout is the 120000ms default — identical to the loop watchdog — so a
// stalled handshake reboots the board instead of failing. 15s matches HttpJson, and
// leaves room for the enrichment calls later in the same fetch cycle.
//
// setInsecure() preserves existing behavior: begin(url) reached the same state via
// TLSTraits::verify() (CA == nullptr -> setInsecure), so this is not a downgrade.
// The coredump confirms it: `insecure=true` in the captured start_ssl_client frame.
WiFiClientSecure &OpenSkyFetcher::secureClient()
{
    if (!m_secureInit)
    {
        m_secure.setInsecure();
        m_secure.setHandshakeTimeout(15); // seconds
        m_secureInit = true;
    }
    // Close anything left open by the previous call before handing the client over.
    //
    // OpenSky spans TWO hosts — auth.opensky-network.org for the token, then
    // opensky-network.org for the states — and HTTPClient::connect() short-circuits on
    // `if (connected()) return true;` WITHOUT comparing hosts. fetchToken() does not
    // call useHTTP10(), so its _reuse stays true and end() deliberately KEEPS its
    // socket open; the states GET would then be sent down that auth connection.
    //
    // begin(url) could not hit this because it built a fresh client inside each
    // HTTPClient. Sharing one client (needed to bound the handshake) reintroduced the
    // "one persistent client can hold one host" hazard, so pay a handshake per call —
    // exactly what the old code did. useHTTP10(true) already disables keep-alive on
    // the states path anyway, so this costs nothing there.
    m_secure.stop();
    return m_secure;
}

static String urlEncodeForm(const String &value)
{
    String out;
    const char *hex = "0123456789ABCDEF";
    for (size_t i = 0; i < value.length(); ++i)
    {
        char c = value[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~')
        {
            out += c;
        }
        else if (c == ' ')
        {
            out += '+';
        }
        else
        {
            out += '%';
            out += hex[(c >> 4) & 0x0F];
            out += hex[c & 0x0F];
        }
    }
    return out;
}

bool OpenSkyFetcher::ensureAccessToken(bool forceRefresh)
{
    const bool oauthConfigured = (g_settings.openSkyClientId.length() > 0) && (g_settings.openSkyClientSecret.length() > 0);
    if (!oauthConfigured)
    {
        Serial.println("OpenSkyFetcher: OAuth credentials are required but not configured");
        return false;
    }

    unsigned long nowMs = millis();
    const unsigned long safetySkewMs = 60UL * 1000UL; // refresh 60s early
    if (!forceRefresh && m_accessToken.length() > 0 && nowMs + safetySkewMs < m_tokenExpiryMs)
    {
        Serial.print("OpenSkyFetcher: Using cached token. ms until refresh window: ");
        Serial.println((long)(m_tokenExpiryMs - safetySkewMs - nowMs));
        return true;
    }

    Serial.println(forceRefresh ? "OpenSkyFetcher: Refreshing token (forced)" : "OpenSkyFetcher: Fetching new token");
    String newToken;
    unsigned long newExpiryMs = 0;
    if (!requestAccessToken(newToken, newExpiryMs))
    {
        Serial.println("OpenSkyFetcher: Failed to obtain OAuth access token");
        return false;
    }

    m_accessToken = newToken;
    m_tokenExpiryMs = newExpiryMs;
    Serial.print("OpenSkyFetcher: Token cached. Expires at ms: ");
    Serial.println((long)m_tokenExpiryMs);
    return true;
}

bool OpenSkyFetcher::ensureAuthenticated(bool forceRefresh)
{
    return ensureAccessToken(forceRefresh);
}

bool OpenSkyFetcher::requestAccessToken(String &outToken, unsigned long &outExpiryMs)
{
    if (g_settings.openSkyClientId.length() == 0 || g_settings.openSkyClientSecret.length() == 0)
    {
        Serial.println("OpenSkyFetcher: OAuth credentials not configured");
        return false;
    }

    HTTPClient http;
    Serial.print("OpenSkyFetcher: Token URL: ");
    Serial.println(APIConfiguration::OPENSKY_TOKEN_URL);
    http.begin(secureClient(), APIConfiguration::OPENSKY_TOKEN_URL);
    http.addHeader("Content-Type", "application/x-www-form-urlencoded");
    http.addHeader("Accept", "application/json");
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

    String body = String("grant_type=client_credentials&client_id=") + urlEncodeForm(g_settings.openSkyClientId) +
                  "&client_secret=" + urlEncodeForm(g_settings.openSkyClientSecret);

    // Debug: show request (without exposing secret)
    Serial.print("OpenSkyFetcher: Using client_id: ");
    Serial.println(g_settings.openSkyClientId);
    Serial.print("OpenSkyFetcher: client_secret length: ");
    Serial.println((int)g_settings.openSkyClientSecret.length());
    Serial.print("OpenSkyFetcher: POST body length: ");
    Serial.println((int)body.length());
    http.setTimeout(15000);

    int code = http.POST(body);
    String payload = http.getString();
    if (code != 200)
    {
        Serial.print("OpenSkyFetcher: Token request failed, code: ");
        Serial.println(code);
        Serial.print("OpenSkyFetcher: Error payload: ");
        if (payload.length() > 0)
        {
            Serial.println(payload);
        }
        else
        {
            Serial.println("<empty>");
        }
        http.end();
        return false;
    }
    http.end();

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (err)
    {
        Serial.print("OpenSkyFetcher: Token JSON parse error: ");
        Serial.println(err.c_str());
        Serial.print("OpenSkyFetcher: Raw token response: ");
        Serial.println(payload);
        return false;
    }

    String tokenStr = doc["access_token"].as<String>();
    int expiresIn = doc["expires_in"] | 1800; // seconds; default 30min
    if (tokenStr.length() == 0)
    {
        Serial.println("OpenSkyFetcher: access_token missing in response");
        Serial.print("OpenSkyFetcher: Full response: ");
        Serial.println(payload);
        if (doc.is<JsonObject>())
        {
            Serial.println("OpenSkyFetcher: Response keys:");
            for (JsonPair kv : doc.as<JsonObject>())
            {
                Serial.print(" - ");
                Serial.println(kv.key().c_str());
            }
        }
        return false;
    }

    outToken = tokenStr;
    outExpiryMs = millis() + (unsigned long)expiresIn * 1000UL;
    Serial.print("OpenSkyFetcher: Obtained access token, length: ");
    Serial.println((int)outToken.length());
    Serial.print("OpenSkyFetcher: Token expires in (s): ");
    Serial.println(expiresIn);
    return true;
}

bool OpenSkyFetcher::fetchStateVectors(double centerLat,
                                       double centerLon,
                                       double radiusKm,
                                       std::vector<StateVector> &outStateVectors)
{
    if (!ensureAccessToken(false))
    {
        Serial.println("OpenSkyFetcher: ensureAccessToken failed before GET");
        return false;
    }

    double latMin, latMax, lonMin, lonMax;
    centeredBoundingBox(centerLat, centerLon, radiusKm, latMin, latMax, lonMin, lonMax);

    String url = String(APIConfiguration::OPENSKY_BASE_URL) + "/api/states/all?lamin=" + String(latMin, 6) +
                 "&lamax=" + String(latMax, 6) +
                 "&lomin=" + String(lonMin, 6) +
                 "&lomax=" + String(lonMax, 6) +
                 "&extended=1"; // include ADS-B emitter category (index 17; 8 = rotorcraft)

    HTTPClient http;
    // OpenSky uses its own transport (Bearer token, not via HttpJson) — but it must
    // still pass OUR client, so the TLS handshake is bounded. See secureClient().
    http.begin(secureClient(), url);
    http.useHTTP10(true); // unchunked body so we can stream-parse the states array
    http.setTimeout(15000);
    http.addHeader("Authorization", String("Bearer ") + m_accessToken);

    int code = http.GET();
    if (code == 401 && m_accessToken.length() > 0 && ensureAccessToken(true))
    {
        http.end();
        http.begin(secureClient(), url);
        http.useHTTP10(true);
        http.setTimeout(15000);
        http.addHeader("Authorization", String("Bearer ") + m_accessToken);
        code = http.GET();
    }
    if (code != 200)
    {
        Serial.print("OpenSkyFetcher: HTTP request failed with code: ");
        Serial.println(code);
        http.end();
        return false;
    }

    try
    {
        parseStatesInto(http.getStream(), centerLat, centerLon, radiusKm, outStateVectors);
    }
    catch (...)
    {
        outStateVectors.clear();
        Serial.println("OpenSkyFetcher: parse aborted (low memory)");
    }
    http.end();
    return true;
}

void OpenSkyFetcher::parseStatesInto(Stream &stream, double centerLat, double centerLon,
                                     double radiusKm, std::vector<StateVector> &out)
{
    // Seek to the start of the states array, then parse ONE inner array at a
    // time into a reused tiny document (never the whole response in RAM).
    if (!stream.find("\"states\":["))
        return; // no states array (e.g. {"time":..,"states":null})

    JsonDocument sdoc; // reused; holds only ONE state vector at a time
    do
    {
        sdoc.clear();
        DeserializationError err = deserializeJson(sdoc, stream);
        if (err)
            break; // hit ']' / malformed — stop
        JsonArray a = sdoc.as<JsonArray>();
        if (a.size() >= 7)
        {
            StateVector s;
            s.icao24 = a[0].as<const char *>();
            s.callsign = a[1].isNull() ? String("") : String(a[1].as<const char *>());
            s.callsign.trim();
            s.lon = a[5].isNull() ? NAN : a[5].as<double>();
            s.lat = a[6].isNull() ? NAN : a[6].as<double>();
            s.baro_altitude = a[7].isNull() ? NAN : a[7].as<double>();
            s.on_ground = a[8].isNull() ? false : a[8].as<bool>();
            s.velocity = a[9].isNull() ? NAN : a[9].as<double>();
            s.heading = a[10].isNull() ? NAN : a[10].as<double>();
            s.vertical_rate = a[11].isNull() ? NAN : a[11].as<double>();
            s.geo_altitude = a[13].isNull() ? NAN : a[13].as<double>();
            s.category = a[17].isNull() ? 0 : a[17].as<int>(); // extended=1; 8 = rotorcraft

            if (!isnan(s.lat) && !isnan(s.lon))
            {
                s.distance_km = haversineKm(centerLat, centerLon, s.lat, s.lon);
                if (s.distance_km <= radiusKm)
                {
                    s.bearing_deg = computeBearingDeg(centerLat, centerLon, s.lat, s.lon);
                    out.push_back(s);
                }
            }
        }
    } while (out.size() < 40 && stream.findUntil(",", "]"));
}
