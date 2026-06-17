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
    http.begin(APIConfiguration::OPENSKY_TOKEN_URL);
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
    // Ensure OAuth token if configured
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
    http.begin(url);
    // OAuth Bearer required
    http.addHeader("Authorization", String("Bearer ") + m_accessToken);

    int code = http.GET();
    if (code != 200)
    {
        bool attemptedRefresh = false;
        if (code == 401 && m_accessToken.length() > 0)
        {
            // Try refresh once
            http.end();
            if (ensureAccessToken(true))
            {
                HTTPClient retry;
                retry.begin(url);
                retry.addHeader("Authorization", String("Bearer ") + m_accessToken);
                code = retry.GET();
                if (code != 200)
                {
                    Serial.print("OpenSkyFetcher: HTTP retry failed with code: ");
                    Serial.println(code);
                    retry.end();
                    return false;
                }
                String payload = retry.getString();
                retry.end();
                try
                {
                    parseStatesInto(payload, centerLat, centerLon, radiusKm, outStateVectors);
                }
                catch (...)
                {
                    outStateVectors.clear();
                    Serial.println("OpenSkyFetcher: parse aborted (low memory)");
                }
                return true;
            }
            attemptedRefresh = true;
        }

        Serial.print("OpenSkyFetcher: HTTP request failed with code: ");
        Serial.println(code);
        http.end();
        if (attemptedRefresh)
        {
            Serial.println("OpenSkyFetcher: Token refresh attempt failed");
        }
        return false;
    }
    String payload = http.getString();
    http.end();
    try
    {
        parseStatesInto(payload, centerLat, centerLon, radiusKm, outStateVectors);
    }
    catch (...)
    {
        outStateVectors.clear();
        Serial.println("OpenSkyFetcher: parse aborted (low memory)");
    }
    return true;
}

void OpenSkyFetcher::parseStatesInto(const String &payload, double centerLat, double centerLon,
                                     double radiusKm, std::vector<StateVector> &out)
{
    int sidx = payload.indexOf("\"states\"");
    if (sidx < 0)
        return; // no states key
    int i = payload.indexOf('[', sidx);
    if (i < 0)
        return;
    i++; // step past the outer '['
    const int n = (int)payload.length();

    JsonDocument sdoc; // reused; holds only ONE state vector at a time

    while (i < n && out.size() < 40)
    {
        // advance to the next inner array (or end of the states array)
        while (i < n && payload[i] != '[' && payload[i] != ']')
            i++;
        if (i >= n || payload[i] == ']')
            break;

        // bracket-match this one state array, skipping over any strings
        const int start = i;
        int depth = 0;
        bool inStr = false;
        while (i < n)
        {
            char ch = payload[i];
            if (inStr)
            {
                if (ch == '\\')
                    i++; // skip escaped char
                else if (ch == '"')
                    inStr = false;
            }
            else if (ch == '"')
                inStr = true;
            else if (ch == '[')
                depth++;
            else if (ch == ']')
            {
                if (--depth == 0)
                {
                    i++;
                    break;
                }
            }
            i++;
        }

        sdoc.clear();
        if (deserializeJson(sdoc, payload.substring(start, i)))
            continue;
        JsonArray a = sdoc.as<JsonArray>();
        if (a.size() < 7)
            continue;

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
        s.position_source = a[16].isNull() ? 0 : a[16].as<int>();
        s.category = a[17].isNull() ? 0 : a[17].as<int>(); // extended=1; 8 = rotorcraft

        if (isnan(s.lat) || isnan(s.lon))
            continue;
        s.distance_km = haversineKm(centerLat, centerLon, s.lat, s.lon);
        if (s.distance_km > radiusKm)
            continue;
        s.bearing_deg = computeBearingDeg(centerLat, centerLon, s.lat, s.lon);
        out.push_back(s);
    }
}
