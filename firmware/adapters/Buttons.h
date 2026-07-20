/*
Purpose: Two momentary buttons (to GND, INPUT_PULLUP) for brightness and mode
control without opening the web UI. Pins are in HardwareConfiguration.

Gestures (see utils/ButtonState.h for why there is no double-click):
  A: click = toggle the panel off/on     hold = brightness UP
  B: click = cycle the no-flights mode   hold = brightness DOWN

POLLED from loop(), deliberately not an ISR. The handoff's §2 traps make interrupt
or task-based input a bad trade here: a fetch task must sit below lwIP's priority,
CPU0's idle is watchdogged with PANIC=y so a missing yield reboots the board, and
WiFi event handlers deadlock if blocked. Polling a GPIO costs microseconds and
sidesteps all of it. The debounce/hold logic is time-injected and host-tested.

This adapter only REPORTS events; main.cpp decides what they mean. Brightness
precedence against the schedule and the light sensor lives in applyBrightness(),
which is the only place that understands all three sources.
*/
#pragma once

#include <Arduino.h>
#include "utils/ButtonState.h"

struct ButtonEvents
{
    bool clickA = false;
    bool rampA = false; // repeats while held
    bool clickB = false;
    bool rampB = false;
};

class Buttons
{
public:
    void begin(); // (re)configure pins for the current Settings
    ButtonEvents poll(unsigned long nowMs);

private:
    ButtonState _a;
    ButtonState _b;
    bool _ready = false;
};
