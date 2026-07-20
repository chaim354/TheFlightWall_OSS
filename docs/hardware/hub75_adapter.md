# Passive HUB75 → ESP32-S3 breakout (copper-tape / 3D-print method)

A passive 1:1 breakout: a 2×8 IDC header (panel side, via the female-to-female ribbon)
wired straight to the ESP32-S3 GPIOs. No buffers (direct 3.3 V drive). Built with the
QWZ-Labs extrude-traces + copper-tape method, or on perfboard.

Pin map matches `firmware/config/HardwareConfiguration.h` (the `CONFIG_IDF_TARGET_ESP32S3`
block) — change both together if you re-map.

## Netlist
`hub75_adapter.net` (KiCad s-expr, version E). In KiCad: Pcbnew → File → Import Netlist
(or build a 2-part schematic from the table below). Footprints used:
- `J1` = `Connector_IDC:IDC-Header_2x08_P2.54mm_Vertical` (HUB75 to panel)
- `J2` = `Connector_PinHeader_2.54mm:PinHeader_1x15_P2.54mm_Vertical` (wires to the S3)

## Connections
| Signal | IDC pin (J1) | J2 pin | ESP32-S3 GPIO |
|---|---|---|---|
| R1  | 1  | 1  | 4 |
| G1  | 2  | 2  | 5 |
| B1  | 3  | 3  | 6 |
| R2  | 5  | 4  | 7 |
| G2  | 6  | 5  | 8 |
| B2  | 7  | 6  | 9 |
| A   | 9  | 7  | 10 |
| B   | 10 | 8  | 11 |
| C   | 11 | 9  | 12 |
| D   | 12 | 10 | 13 |
| E   | 8  | 11 | 14 |
| CLK | 13 | 12 | 17 |
| LAT | 14 | 13 | 15 |
| OE  | 15 | 14 | 16 |
| GND | 4 + 16 | 15 | any GND |

Panel **5 V power is NOT on this board** — it goes through the panel's own power
connector to the PSU. Tie S3 / panel / PSU grounds together.

## Single-sided routing (copper tape)
Single-sided = **no ground plane**, so treat traces like short wires:
- **Trace width ~1.5–2 mm, spacing ≥1 mm**, rounded corners (copper tape won't conform
  to sharp angles; the 0.6 mm raised-trace extrude wants gentle bends).
- **Fat GND trace** down one edge tying J1 pin 4, J1 pin 16, and the S3 GND. Make it the
  widest trace; route it adjacent to the clock where you can.
- **Isolate CLK (GPIO17 ↔ IDC 13):** give it its own lane, ideally with GND beside it; do
  not run it long-and-parallel right next to the RGB data lanes.
- **Crossings:** with this map the only out-of-sequence net is **E** (GPIO14 → IDC pin 8,
  which sits between B2 and A). Expect **1–2 crossings** there; handle each with a short
  insulated wire jumper soldered over the tape, or a small printed bridge.
- Keep the whole board **short** — the panel and S3 headers close together. Long copper-
  tape runs are the main signal-integrity risk without a buffer.

## If you want ZERO crossings
The GPIO assignment is ours to choose. If you tell me the physical order of GPIOs along
your DevKitC-1 header, I can re-assign the 14 signals to a **contiguous run in IDC order**
so the board routes single-sided with no crossings — then update
`HardwareConfiguration.h` to match (one-line-per-pin change + reflash).

## Verify before powering the panel
1. Continuity-check every net (IDC pin ↔ GPIO) against the table — a tape bridge/short is
   the classic copper-tape failure.
2. Confirm no adjacent traces are shorted (the cut between them is clean).
3. Power up; expect the `[boot] PSRAM:` line, then a render. Start `panelI2sSpeedMhz` at
   15; raise only if stable.
