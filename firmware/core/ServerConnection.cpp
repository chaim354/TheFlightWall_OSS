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

            // 10s. This was 4s, inherited with the reasoning that 4s left
            // "room for a genuinely slow handshake several times over". THAT
            // ASSUMPTION IS NOW FALSIFIED BY MEASUREMENT. Instrumented on
            // 2026-08-27 with per-phase timings, on a link showing 12-20%
            // packet loss at RSSI -47 and zero disconnects:
            //
            //   success  connect+TLS 3186ms, body 1ms
            //   success  connect+TLS 4020ms, body 2ms
            //   FAIL     timed out at 4581ms
            //   FAIL     timed out at 5597ms
            //
            // A healthy handshake was taking 3.2-4.0s, so 4s was not generous
            // headroom -- it was the failure boundary, and fetches were being
            // discarded by a couple of hundred milliseconds. Note the body
            // moves in 1-2ms once connected: this is packet loss during setup,
            // not a slow link, so a longer budget costs nothing when the link
            // is healthy and rescues the fetch when it is not.
            //
            // The old bound also assumed a working fallback to hand off TO.
            // adsb.lol had been returning 403 on every attempt (see
            // AdsbLolFetcher), so failing fast bought nothing at all.
            //
            // CONSEQUENCE OF SHARING, stated because it IS a behaviour change:
            // ControlClient previously handshook with the framework default and
            // now inherits this bound. Benign -- a check-in that misses simply
            // retries on the next fetch cycle. The worst case is a 10s stall in
            // a loop that also drives the display, against a 30s fetch interval;
            // that is the price of a fetch surviving a lossy link, and the panel
            // holds its last frame rather than blanking.
            c.setHandshakeTimeout(10);
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
