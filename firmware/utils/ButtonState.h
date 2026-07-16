#pragma once
// Arduino-free, header-only debounce + click/hold state machine for one momentary
// button. Time is injected, so the whole thing is host-testable (see test_buttons).
//
// The gesture split is deliberate: a SINGLE CLICK fires the action and a HOLD ramps
// brightness. There is no double-click, which means there is no window to wait out
// before deciding what a press meant — so the action fires immediately on release
// and the ramp starts crisply. (Recognising a double-click would require holding
// every single press for ~300ms to see whether a second one arrives, which makes
// brightness feel broken.)
//
// A press that ramped does NOT click on release: it was a brightness gesture, and
// releasing it must not also toggle the panel off.

#include <cstdint>

class ButtonState
{
public:
    enum class Event : uint8_t
    {
        None,
        Click, // short press, emitted on release
        Ramp,  // hold threshold reached, then repeated every kRampRepeatMs
    };

    // Contact bounce is a few ms; 25 swallows it without being felt.
    static const unsigned long kDebounceMs = 25;
    // Long enough not to trip on a normal click, short enough that a deliberate hold
    // starts ramping without feeling stuck.
    static const unsigned long kHoldMs = 500;
    // ~8 steps/sec: crosses the 15-rung ladder in about 2s of holding.
    static const unsigned long kRampRepeatMs = 120;

    // Feed the raw (already active-high) pin state and the current millis().
    Event update(bool rawPressed, unsigned long nowMs)
    {
        if (rawPressed != _raw)
        {
            _raw = rawPressed;
            _lastChangeMs = nowMs;
        }

        // Debounce: adopt the raw level only once it has been stable long enough.
        if (_raw != _stable && (nowMs - _lastChangeMs) >= kDebounceMs)
        {
            _stable = _raw;
            if (_stable)
            {
                _pressedAtMs = nowMs;
                _ramped = false;
            }
            else if (!_ramped && (nowMs - _pressedAtMs) < kHoldMs)
            {
                return Event::Click; // short press completed
            }
        }

        if (_stable && (nowMs - _pressedAtMs) >= kHoldMs &&
            (!_ramped || (nowMs - _lastRampMs) >= kRampRepeatMs))
        {
            _ramped = true;
            _lastRampMs = nowMs;
            return Event::Ramp;
        }
        return Event::None;
    }

private:
    bool _raw = false;              // last raw level seen
    bool _stable = false;           // debounced level
    bool _ramped = false;           // this press has ramped -> suppress its click
    unsigned long _lastChangeMs = 0;
    unsigned long _pressedAtMs = 0;
    unsigned long _lastRampMs = 0;
};
