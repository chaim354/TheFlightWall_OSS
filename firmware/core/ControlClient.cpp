#include "core/ControlClient.h"
#include "core/ServerConnection.h"
#include "core/Settings.h"

#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

namespace
{
    /**
     * Cap on one command batch.
     *
     * The server caps its queue at twenty, but this device must not depend on
     * the server behaving -- that is the whole premise of the network strip
     * below. A batch that arrives larger than this is truncated rather than
     * trusted, because applying an unbounded list means an unbounded stall in
     * a loop that also drives the display.
     */
    const size_t kMaxCommands = 20;
}

namespace ControlClient
{
    String stripProtected(const String &setJson, bool &removedSomething)
    {
        removedSomething = false;

        JsonDocument doc;
        if (deserializeJson(doc, setJson) != DeserializationError::Ok)
            return String();

        // "network" carries wifiSsid and wifiPassword. Removing the whole
        // section rather than the two keys is deliberate: a future field added
        // there is protected automatically, whereas a list of key names has to
        // be remembered, and the cost of forgetting is a wall that cannot be
        // reached without a ladder.
        if (doc["network"].is<JsonVariant>() && !doc["network"].isNull())
        {
            doc.remove("network");
            removedSomething = true;
        }

        // api.controlToken, for the same reason: applying a new token from the
        // network locks remote control out permanently, and the only repair is
        // the LAN page this feature exists to avoid needing. The rest of `api`
        // is ordinary configuration and stays settable.
        JsonObject api = doc["api"].as<JsonObject>();
        if (!api.isNull() && api["controlToken"].is<const char *>())
        {
            api.remove("controlToken");
            removedSomething = true;
            if (api.size() == 0)
                doc.remove("api");
        }

        String out;
        serializeJson(doc, out);
        return out;
    }

    Outcome checkIn(const String &serverUrl, const String &token, const String &statusJson)
    {
        Outcome o;
        if (serverUrl.length() == 0 || token.length() == 0)
            return o; // not configured: no request, no error, nothing to report

        HTTPClient http;
        // THE SAME CONNECTION THE FLIGHT FETCH JUST USED. checkIn() is called
        // from doFetchAndRender() immediately after FlightWallServerFetcher has
        // talked to this very host, so the socket is already open and warm:
        // reusing it turns what used to be a second full TLS handshake per cycle
        // into a plain request. See core/ServerConnection.h for the measurement
        // that motivated it and for why reset() exists.
        if (!http.begin(ServerConnection::client(), serverUrl + "/v1/control/checkin"))
        {
            o.error = "connect failed";
            ServerConnection::reset();
            return o;
        }
        http.setTimeout(8000);
        http.addHeader("Content-Type", "application/json");
        http.addHeader("Authorization", String("Bearer ") + token);

        const int code = http.POST(statusJson);
        if (code != HTTP_CODE_OK)
        {
            // The BODY, not just the code. The server distinguishes its
            // refusals and says which one this is -- 401 `unauthorised` means
            // the credential is unknown, while 403 `not the device` means it is
            // a VALID credential of the wrong tier: the UI or admin page
            // password rather than CONTROL_TOKEN. Those need opposite fixes and
            // the status code alone cannot tell them apart, which cost a real
            // debugging session. adsb.lol taught the same lesson in the same
            // week (see AdsbLolFetcher).
            String why = http.getString();
            why.replace('\n', ' ');
            if (why.length() > 160)
                why = why.substring(0, 160) + "...";
            o.error = String("HTTP ") + code + " -- " + why;
            http.end();
            ServerConnection::reset();
            return o;
        }

        JsonDocument doc;
        const DeserializationError e = deserializeJson(doc, http.getStream());
        http.end();
        if (e)
        {
            o.error = String("bad JSON: ") + e.c_str();
            return o;
        }
        o.checkedIn = true;
        // SUCCESS WAS THE ONLY OUTCOME WITHOUT A LINE. Every failure logged, so
        // silence used to mean either "checked in perfectly" or "never tried"
        // -- the unconfigured path returns just as quietly. Those are opposite
        // situations and they looked identical from outside the device, which
        // is exactly how a control token that had not applied was mistaken for
        // one that had. With this line, silence can only mean unconfigured.
        Serial.printf("[control] checked in ok (%u bytes reported, %u command(s))\n",
                      (unsigned)statusJson.length(),
                      (unsigned)(doc["commands"].is<JsonArray>()
                                     ? doc["commands"].as<JsonArray>().size()
                                     : 0));

        JsonArray cmds = doc["commands"].as<JsonArray>();
        if (cmds.isNull())
            return o; // answered, nothing queued

        size_t n = 0;
        for (JsonObject c : cmds)
        {
            if (++n > kMaxCommands)
            {
                Serial.println("[control] too many commands in one batch; ignoring the rest");
                break;
            }

            if (c["action"].is<const char *>())
            {
                const String action = c["action"].as<String>();
                if (action == "restart")
                    o.restart = true;
                else if (action == "updateui")
                    o.updateUi = true;
                else if (action == "updatefw")
                    o.updateFirmware = true;
                else
                    Serial.printf("[control] unknown action '%s' ignored\n", action.c_str());
                continue;
            }

            if (!c["set"].isNull())
            {
                String setJson;
                serializeJson(c["set"], setJson);

                bool removed = false;
                const String safe = stripProtected(setJson, removed);
                if (removed)
                {
                    // Loud, because the server is supposed to have removed this
                    // already. Seeing it here means either a server that has
                    // been changed, or one that has been compromised -- and
                    // either way the operator should know the wall refused it.
                    Serial.println("[control] REFUSED network settings from the server");
                }
                if (safe.length() == 0 || safe == "{}")
                {
                    Serial.println("[control] command had nothing applicable; skipped");
                    continue;
                }

                if (g_settings.fromJson(safe))
                {
                    g_settings.save();
                    o.settingsChanged = true;
                    Serial.printf("[control] applied %s\n", safe.c_str());
                }
                else
                {
                    Serial.println("[control] command was not valid settings JSON");
                }
            }
        }
        return o;
    }
}
