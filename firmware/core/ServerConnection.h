#pragma once
/*
Purpose: ONE TLS connection to the FlightWall server, shared by every caller
that talks to it.

WHY THIS EXISTS. Four separate WiFiClientSecure singletons used to point at the
same host -- one each in FlightWallServerFetcher, ControlClient, AssetUpdater
and FirmwareUpdater. Same server, four handshakes, four mbedTLS contexts. The
fetcher's own header already stated the intent ("One server means one
connection, with keep-alive"), but its secureClient() called stop() on every
call, so the connection could never survive to be reused.

That cost is not theoretical on this hardware. HANDOFF section 1 measures the
TLS handshake as the single most loss-sensitive thing the device does: at ~21%
per-packet loss a handshake needs ~10 packets to survive, and each retransmit
burns seconds against a 4s budget. doFetchAndRender() ran the flight fetch and
then the control check-in back to back, to the same host, and paid for two full
handshakes every cycle. Sharing one connection makes the second one free.

Verified against the live server before this was written: it answers HTTP/1.1
with `Connection: keep-alive` and serves consecutive requests on one socket.
HTTPClient cooperates by default (_reuse is true; disconnect() leaves the socket
open when the response allows it), so all that was ever missing was a single
client object and the absence of an unconditional stop().

reset() is the counterpart. Reuse means a broken socket would otherwise be
inherited by the NEXT caller, turning one failed request into a run of them, so
every transport failure hands back a clean slate.
*/

#include <WiFiClientSecure.h>

namespace ServerConnection
{
    /**
     * The shared client, configured on first use.
     *
     * Returns a LIVE connection when one was used moments ago, and a freshly
     * stopped one when the last use is older than the idle bound in the .cpp --
     * so the check-in riding behind the fetch reuses the socket, while a socket
     * left idle between cycles is never trusted. Callers that know their own
     * exchange went wrong call reset().
     */
    WiFiClientSecure &client();

    /**
     * Drop the connection so the next caller handshakes fresh.
     *
     * Call after a TRANSPORT failure -- begin() refused, a non-200, a read that
     * died mid-flight. NOT after a parse failure: a body that arrived complete
     * and then failed to deserialize says nothing bad about the socket, and
     * throwing the connection away there would reintroduce the per-cycle
     * handshake this file exists to remove.
     */
    void reset();
}
