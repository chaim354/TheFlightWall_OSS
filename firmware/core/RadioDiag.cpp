#include "core/RadioDiag.h"

#include <WiFi.h>

namespace RadioDiag
{
    namespace
    {
        uint32_t g_disconnects = 0;
        uint32_t g_downtimeMs = 0;
        uint32_t g_lastDownAtMs = 0;
        uint32_t g_lastUpAtMs = 0;
        bool g_down = false;

        /**
         * Espressif's wifi_err_reason_t, named.
         *
         * Only the codes that actually distinguish a fault are spelled out; the
         * rest fall through to the number, which is still greppable. The three
         * that matter most here are 200/204/8 -- see RadioDiag.h.
         */
        const char *reasonName(uint8_t r)
        {
            switch (r)
            {
            case 1:   return "UNSPECIFIED";
            case 2:   return "AUTH_EXPIRE";
            case 3:   return "AUTH_LEAVE";
            case 4:   return "ASSOC_EXPIRE";
            case 5:   return "ASSOC_TOOMANY";
            case 6:   return "NOT_AUTHED";
            case 7:   return "NOT_ASSOCED";
            case 8:   return "ASSOC_LEAVE";       // the AP pushed us off
            case 9:   return "ASSOC_NOT_AUTHED";
            case 15:  return "4WAY_HANDSHAKE_TIMEOUT";
            case 16:  return "GROUP_KEY_UPDATE_TIMEOUT";
            case 23:  return "IEEE802_1X_AUTH_FAILED";
            case 24:  return "CIPHER_SUITE_REJECTED";
            case 200: return "BEACON_TIMEOUT";    // AP stopped being heard
            case 201: return "NO_AP_FOUND";
            case 202: return "AUTH_FAIL";
            case 203: return "ASSOC_FAIL";
            case 204: return "HANDSHAKE_TIMEOUT"; // heard, but key exchange failed
            case 205: return "CONNECTION_FAIL";
            case 206: return "AP_TSF_RESET";
            case 207: return "ROAMING";
            default:  return "?";
            }
        }

        void onEvent(arduino_event_id_t event, arduino_event_info_t info)
        {
            const uint32_t now = millis();
            switch (event)
            {
            case ARDUINO_EVENT_WIFI_STA_CONNECTED:
            {
                // Associated. BSSID and channel here are what expose a roam --
                // a different BSSID than the previous line means we moved AP.
                char bssid[18];
                const uint8_t *b = info.wifi_sta_connected.bssid;
                snprintf(bssid, sizeof(bssid), "%02x:%02x:%02x:%02x:%02x:%02x",
                         b[0], b[1], b[2], b[3], b[4], b[5]);
                if (g_down)
                {
                    g_downtimeMs += (now - g_lastDownAtMs);
                    g_down = false;
                }
                g_lastUpAtMs = now;
                Serial.printf("[radio] CONNECTED  bssid=%s ch=%u  down_total=%lums\n",
                              bssid, (unsigned)info.wifi_sta_connected.channel,
                              (unsigned long)g_downtimeMs);
                break;
            }
            case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
            {
                const uint8_t reason = info.wifi_sta_disconnected.reason;
                g_disconnects++;
                if (!g_down)
                {
                    g_down = true;
                    g_lastDownAtMs = now;
                }
                // The line this whole file exists for.
                Serial.printf("[radio] DISCONNECTED reason=%u (%s)  n=%lu  up_for=%lums\n",
                              (unsigned)reason, reasonName(reason),
                              (unsigned long)g_disconnects,
                              (unsigned long)(g_lastUpAtMs ? now - g_lastUpAtMs : 0));
                break;
            }
            case ARDUINO_EVENT_WIFI_STA_GOT_IP:
                Serial.printf("[radio] GOT_IP %s  rssi=%d\n",
                              WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
                break;
            case ARDUINO_EVENT_WIFI_STA_LOST_IP:
                Serial.println("[radio] LOST_IP");
                break;
            default:
                break;
            }
        }
    }

    void begin()
    {
        // connectWifiSta() can run more than once (AP fallback, reconnect paths),
        // and registering the same handler twice would double every line.
        static bool armed = false;
        if (armed)
            return;
        armed = true;
        WiFi.onEvent(onEvent);
        Serial.println("[radio] event logging armed");
    }

    void logSnapshot(const char *tag)
    {
        if (WiFi.status() != WL_CONNECTED)
        {
            Serial.printf("[radio] %s: DISASSOCIATED  n=%lu down_total=%lums\n",
                          tag, (unsigned long)g_disconnects, (unsigned long)g_downtimeMs);
            return;
        }
        Serial.printf("[radio] %s: rssi=%d ch=%d bssid=%s tx=%.1fdBm n=%lu down_total=%lums up_for=%lums\n",
                      tag, (int)WiFi.RSSI(), (int)WiFi.channel(),
                      WiFi.BSSIDstr().c_str(),
                      (double)WiFi.getTxPower() / 4.0,
                      (unsigned long)g_disconnects, (unsigned long)g_downtimeMs,
                      (unsigned long)(g_lastUpAtMs ? millis() - g_lastUpAtMs : 0));
    }

    uint32_t disconnectCount() { return g_disconnects; }
    uint32_t downtimeMs()      { return g_downtimeMs; }
}
