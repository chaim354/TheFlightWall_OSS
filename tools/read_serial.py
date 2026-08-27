#!/usr/bin/env python3
"""
Read a board's serial output, asserting DTR.

WHY THIS EXISTS. `cat /dev/cu.usbmodemN` works on the ESP32-S3 DevKit and
returns NOTHING on the MatrixPortal S3, from a board that is running fine.
TinyUSB CDC buffers its output until the host raises DTR, and macOS /dev/cu.*
devices deliberately never raise it (that is the difference from /dev/tty.*).
The DevKit is unaffected because it uses the USB-Serial-JTAG peripheral, which
does not gate on DTR.

On 2026-08-25 that cost hours: a stripped bring-up image with a visibly
blinking LED read as zero bytes over `cat`, which looked exactly like a board
that would not boot.

    tools/read_serial.py [port] [seconds]

Needs pyserial; PlatformIO's bundled interpreter has it:
    ~/.platformio/penv/bin/python tools/read_serial.py
"""
import sys
import time

try:
    import serial
except ImportError:
    sys.exit("pyserial not found. Try: ~/.platformio/penv/bin/python " + sys.argv[0])

port = sys.argv[1] if len(sys.argv) > 1 else "/dev/cu.usbmodem101"
secs = float(sys.argv[2]) if len(sys.argv) > 2 else 15.0

with serial.Serial(port, 115200, timeout=1) as s:
    s.dtr = True   # the whole point
    s.rts = False
    time.sleep(0.3)
    end = time.time() + secs
    while time.time() < end:
        chunk = s.read(512)
        if chunk:
            sys.stdout.write(chunk.decode("utf-8", "replace"))
            sys.stdout.flush()
