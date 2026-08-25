/*
Purpose: Check in with the FlightWall server and apply anything queued there.

The device cannot be reached from outside the house -- it sits behind a home NAT
and only makes outbound connections -- so remote control rides the poll it
already makes. One extra request per fetch cycle: report what this wall is
doing, collect whatever a human queued, apply it.

See docs/superpowers/specs/2026-08-25-remote-control-design.md.

NETWORK SETTINGS ARE REFUSED HERE, not merely refused by the server. That second
check is the entire security value of this file: the server strips them too, but
a compromised server would simply not run that code. This one still holds. A
wrong SSID applied from across the internet drops the wall off the network, and
the only repair left is physical access -- the cable the whole update mechanism
exists to avoid needing.

Inert without a token: no token, no check-in, no request. Same posture the
server takes without CONTROL_TOKEN.
*/
#pragma once

#include <Arduino.h>

namespace ControlClient
{
    /** What the caller must do as a result of this check-in. Actions are
     * returned rather than performed so the one place that knows how to restart
     * or run an update keeps doing it -- this file only decides. */
    struct Outcome
    {
        bool checkedIn = false;   // a request was actually made and answered
        bool settingsChanged = false;
        bool restart = false;
        bool updateUi = false;
        bool updateFirmware = false;
        String error;
    };

    /**
     * Report `statusJson` and apply any commands the server hands back.
     *
     * `statusJson` is a complete JSON object -- built by the caller, since it is
     * the caller that knows the runtime values -- and is sent verbatim.
     */
    Outcome checkIn(const String &serverUrl, const String &token, const String &statusJson);

    /**
     * Remove the settings a remote caller may never change, returning the JSON
     * that remains.
     *
     * Exposed for its own sake because it is the security boundary, not an
     * implementation detail: it is the check that still stands when the server
     * is the thing that has been compromised.
     */
    String stripProtected(const String &setJson, bool &removedSomething);
}
