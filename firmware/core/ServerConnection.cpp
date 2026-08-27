#include "core/ServerConnection.h"

#include <Arduino.h> // millis(), for the idle bound below

namespace ServerConnection
{
    /**
     * How long a connection may sit idle and still be handed back.
     *
     * DELIBERATELY SHORTER THAN THE FETCH INTERVAL (30s default), and that is
     * the whole design. The saving this file exists for is WITHIN a cycle:
     * doFetchAndRender() runs the flight fetch and then controlCheckIn() to the
     * same host milliseconds apart, and the second one should not handshake
     * again. Reuse ACROSS cycles would save more, but it means trusting a socket
     * that has been idle for half a minute, and a keep-alive the far end quietly
     * dropped comes back as connected() == true and then fails on write -- one
     * failed fetch every other cycle, which is worse than the handshake it saves.
     *
     * So the fetcher's behaviour is unchanged from before this file existed: it
     * gets a fresh connection each cycle. Only the check-in riding directly
     * behind it gets a free ride. Widening this is a one-constant change if a
     * long-lived keep-alive is ever measured against the real server.
     */
    static const unsigned long kMaxIdleMs = 5000;

    WiFiClientSecure &client()
    {
        static WiFiClientSecure c;
        static bool configured = false;
        static unsigned long lastUseMs = 0;
        if (!configured)
        {
            c.setInsecure();

            // 4s, carried over from FlightWallServerFetcher::secureClient(),
            // where it was chosen and justified: adsb.lol sits behind this
            // source as a fallback, so a fast failure that hands off promptly
            // beats a slow one that only delays the same handoff. The server
            // answers a healthy request in tens of milliseconds, so 4s is room
            // for a genuinely slow handshake several times over, not a bound
            // sized to the response.
            //
            // CONSEQUENCE OF SHARING, stated because it IS a behaviour change:
            // ControlClient previously handshook with the framework default and
            // now inherits this 4s. That is deliberate and benign -- a check-in
            // that misses simply retries on the next fetch cycle, so the cost of
            // giving up early is one interval of remote-control latency, while
            // the cost of hanging on is a multi-second stall in a loop that also
            // drives the display.
            c.setHandshakeTimeout(4);
            configured = true;
        }

        // millis() rollover (~49 days) makes this subtraction wrap, which is
        // harmless: unsigned arithmetic still yields a correct elapsed value.
        if (lastUseMs != 0 && (millis() - lastUseMs) > kMaxIdleMs)
            c.stop();
        lastUseMs = millis();
        return c;
    }

    void reset()
    {
        client().stop();
    }
}
