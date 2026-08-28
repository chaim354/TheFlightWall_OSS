#pragma once
/*
Purpose: make the radio's behaviour VISIBLE, because every diagnosis of this
fault so far has been made from outside the device and has been wrong at least
once.

WHAT WAS MISSING. Nothing in this firmware ever registered a WiFi event
handler, so a disconnect/reassociate cycle was completely invisible: the only
radio fact anyone had was RSSI sampled from /api/status, which HANDOFF section 1
already records as WORTHLESS here (-46 to -56 throughout a 52%-loss window, and
-47 on the DevKit while it lost 12% of packets with 566ms round trips). A board
that drops association and recovers looks, through that keyhole, identical to a
board that never moved.

WHAT THIS ADDS, and why each field earns its place:

  reason code   -- the single most diagnostic number available. BEACON_TIMEOUT
                   (200) means the AP stopped being heard; HANDSHAKE_TIMEOUT
                   (204) means it was heard and the key exchange failed;
                   ASSOC_LEAVE (8) means the AP pushed us off. Those are three
                   completely different faults that all present as "the wall
                   stopped updating".
  BSSID         -- reveals ROAMING. On a mesh or with an extender, moving
                   between radios produces exactly this symptom while RSSI stays
                   healthy, because RSSI is measured against whichever AP we
                   just landed on.
  channel       -- pairs with BSSID; a channel change is a roam even when the
                   BSSID lookup is ambiguous.
  tx power      -- rules in or out the radio backing itself off.
  downtime      -- total ms disassociated since boot, which converts "it feels
                   flaky" into a number that can be compared between runs.

Deliberately counters plus event lines rather than a ring buffer: the console is
already the transport, and a line per event with a timestamp is greppable
against the ping logs taken from the Mac at the same moment.
*/

#include <Arduino.h>

namespace RadioDiag
{
    /** Register the WiFi event handlers. Call once, before WiFi.begin(). */
    void begin();

    /** One line of current radio state, tagged. Cheap; safe to call per cycle. */
    void logSnapshot(const char *tag);

    /** Disassociation events since boot. */
    uint32_t disconnectCount();

    /** Total milliseconds spent disassociated since boot. */
    uint32_t downtimeMs();
}
