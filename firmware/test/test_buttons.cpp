// Host unit tests for ButtonState.h + BrightnessLadder.h — compile with g++, no hardware.
// These are the two pieces of the button feature that are pure logic; the GPIO reads
// and the toast rendering are not host-testable and are verified on the device.
//
// Guarded so a `pio test` build doesn't collide with the other loose host
// tests under test/ -- see the test_filter comment in platformio.ini. This
// file is a standalone host test; it only runs via bare g++, which never
// defines PIO_UNIT_TESTING, so the guard is a no-op for that workflow and
// this file's behavior there is unchanged.
#ifndef PIO_UNIT_TESTING
#include "../utils/ButtonState.h"
#include "../utils/BrightnessLadder.h"
#include <cstdio>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

using E = ButtonState::Event;

// Drive the state machine from t to t+durMs at 10ms steps, collecting events.
struct Trace { int clicks = 0; int ramps = 0; };
static Trace run(ButtonState &b, bool pressed, unsigned long &t, unsigned long durMs)
{
    Trace tr;
    for (unsigned long end = t + durMs; t <= end; t += 10)
    {
        E e = b.update(pressed, t);
        if (e == E::Click) tr.clicks++;
        else if (e == E::Ramp) tr.ramps++;
    }
    return tr;
}

int main()
{
    // ---- ButtonState ------------------------------------------------------

    // Idle produces nothing.
    {
        ButtonState b; unsigned long t = 1000;
        Trace tr = run(b, false, t, 1000);
        CHECK(tr.clicks == 0 && tr.ramps == 0);
    }

    // A short press (below the hold threshold) yields exactly one Click on RELEASE,
    // and never a Ramp. Click-on-release is what lets a single press be unambiguous
    // without a double-click window to wait out.
    {
        ButtonState b; unsigned long t = 1000;
        run(b, false, t, 100);              // settle
        Trace hold = run(b, true, t, 200);  // 200ms < 500ms hold
        CHECK(hold.clicks == 0);            // nothing yet — still held
        CHECK(hold.ramps == 0);
        Trace rel = run(b, false, t, 100);
        CHECK(rel.clicks == 1);             // exactly one click, on release
        CHECK(rel.ramps == 0);
    }

    // A long press ramps and does NOT click on release. A press that ramped was a
    // brightness gesture, so releasing it must not also toggle the panel off.
    {
        ButtonState b; unsigned long t = 1000;
        run(b, false, t, 100);
        Trace hold = run(b, true, t, 1000); // 1s: first ramp at 500ms, then every 120ms
        CHECK(hold.ramps >= 4);             // ~1 + 500/120
        CHECK(hold.clicks == 0);
        Trace rel = run(b, false, t, 100);
        CHECK(rel.clicks == 0);             // ramped -> release is NOT a click
    }

    // The first Ramp fires at the hold threshold, not before.
    {
        ButtonState b; unsigned long t = 1000;
        run(b, false, t, 100);
        Trace early = run(b, true, t, 400); // still under 500ms
        CHECK(early.ramps == 0);
        Trace late = run(b, true, t, 200);  // now past it
        CHECK(late.ramps >= 1);
    }

    // Ramp repeats at roughly the repeat interval — not every poll. A ramp that
    // fired per-poll would slew brightness across the whole ladder instantly.
    {
        ButtonState b; unsigned long t = 1000;
        run(b, false, t, 100);
        run(b, true, t, 500);               // reach the hold threshold
        Trace r = run(b, true, t, 1200);    // 1.2s of ramping
        CHECK(r.ramps >= 8 && r.ramps <= 12); // ~1200/120 = 10
    }

    // Contact bounce shorter than the debounce window is ignored: a bounce burst
    // must not produce a click.
    {
        ButtonState b; unsigned long t = 1000;
        run(b, false, t, 100);
        int clicks = 0;
        for (int i = 0; i < 6; ++i) { // 6 transitions, 10ms apart -> all inside 25ms
            E e = b.update(i % 2 == 0, t); t += 10;
            if (e == E::Click) clicks++;
        }
        CHECK(clicks == 0);
    }

    // ---- BrightnessLadder -------------------------------------------------

    // Steps land on the ladder even when the current value is between rungs. The
    // real settings (20 default, 5 night, 3 dim) are not ladder values.
    {
        CHECK(brightnessUp(20) == 26);   // 18 < 20 < 26
        CHECK(brightnessDown(20) == 18);
    }

    // Saturates at both ends rather than wrapping.
    {
        CHECK(brightnessUp(255) == 255);
        CHECK(brightnessDown(1) == 1);
        CHECK(brightnessUp(0) == 1);     // from off/blank, one step up lights it dimly
    }

    // The ladder never returns 0: "off" is a separate button action, not the bottom
    // of the brightness range. A ramp that could reach 0 would be indistinguishable
    // from the panel being broken.
    {
        uint8_t v = 200;
        for (int i = 0; i < 40; ++i) { v = brightnessDown(v); CHECK(v >= 1); }
    }

    // Strictly monotonic and reachable: ramping up from the bottom reaches the top,
    // and every step actually moves.
    {
        uint8_t v = 1; int steps = 0;
        while (v < 255 && steps < 100) { uint8_t n = brightnessUp(v); CHECK(n > v); v = n; steps++; }
        CHECK(v == 255);
        CHECK(steps <= 20);              // a usable number of presses end-to-end
    }

    // Perceptual, not linear: the bottom of the range must have fine steps, because
    // that is where the panel actually lives (night=5, dim=3). A linear step of 16
    // would jump 5 -> 21 and skip the entire useful band.
    {
        CHECK(brightnessUp(3) <= 8);     // small absolute step down low
        CHECK(brightnessUp(145) >= 180); // coarse step up high
    }

    // Up then down returns to where you started, from a ladder value.
    {
        CHECK(brightnessDown(brightnessUp(26)) == 26);
    }

    if (failures == 0) { printf("ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
#endif // PIO_UNIT_TESTING
