#!/usr/bin/env python3
"""
Generate 32x32 brand-colored code-badge tiles for cargo airlines.

These are brand-colored tiles showing the carrier's short code in a pixel font —
the legible, recognizable mark used by most LED flight displays. They ship in
firmware/data/logos/<ICAO>.rgb565 so the wall has cargo logos out of the box.
Swap in real logo artwork any time with tools/png_to_rgb565.py (same format).

This mirrors tools/gen_starter_logos.py (reuses its 3x5 FONT, no Pillow) but
renders at 32x32 to match the generic _CARGO/_PRIVATE/_HELI tiles produced by
tools/gen_special_logos.py.

Output format (.rgb565), little-endian:
    uint16 width, uint16 height, then width*height * uint16 RGB565 pixels.

Pure standard library — no Pillow required. Run from the repo root:
    python3 tools/gen_cargo_logos.py
"""
import os
import struct

SIZE = 32
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "firmware", "data", "logos")

# 3x5 pixel font (top->bottom). Copied from tools/gen_starter_logos.py so this
# script stays standalone. A-Z and 0-9 are all defined so any code renders.
FONT = {
    "A": [".#.", "#.#", "###", "#.#", "#.#"],
    "B": ["##.", "#.#", "##.", "#.#", "##."],
    "C": [".##", "#..", "#..", "#..", ".##"],
    "D": ["##.", "#.#", "#.#", "#.#", "##."],
    "E": ["###", "#..", "##.", "#..", "###"],
    "F": ["###", "#..", "##.", "#..", "#.."],
    "G": [".##", "#..", "#.#", "#.#", ".##"],
    "H": ["#.#", "#.#", "###", "#.#", "#.#"],
    "I": ["###", ".#.", ".#.", ".#.", "###"],
    "J": ["..#", "..#", "..#", "#.#", ".#."],
    "K": ["#.#", "#.#", "##.", "#.#", "#.#"],
    "L": ["#..", "#..", "#..", "#..", "###"],
    "M": ["#.#", "###", "###", "#.#", "#.#"],
    "N": ["#.#", "###", "###", "#.#", "#.#"],
    "O": [".#.", "#.#", "#.#", "#.#", ".#."],
    "P": ["##.", "#.#", "##.", "#..", "#.."],
    "Q": [".#.", "#.#", "#.#", ".#.", "..#"],
    "R": ["##.", "#.#", "##.", "#.#", "#.#"],
    "S": [".##", "#..", ".#.", "..#", "##."],
    "T": ["###", ".#.", ".#.", ".#.", ".#."],
    "U": ["#.#", "#.#", "#.#", "#.#", "###"],
    "V": ["#.#", "#.#", "#.#", "#.#", ".#."],
    "W": ["#.#", "#.#", "###", "###", "#.#"],
    "X": ["#.#", "#.#", ".#.", "#.#", "#.#"],
    "Y": ["#.#", "#.#", ".#.", ".#.", ".#."],
    "Z": ["###", "..#", ".#.", "#..", "###"],
    "0": ["###", "#.#", "#.#", "#.#", "###"],
    "1": [".#.", "##.", ".#.", ".#.", "###"],
    "2": ["##.", "..#", ".#.", "#..", "###"],
    "3": ["##.", "..#", ".#.", "..#", "##."],
    "4": ["#.#", "#.#", "###", "..#", "..#"],
    "5": ["###", "#..", "##.", "..#", "##."],
    "6": [".##", "#..", "##.", "#.#", "##."],
    "7": ["###", "..#", ".#.", ".#.", ".#."],
    "8": [".#.", "#.#", ".#.", "#.#", ".#."],
    "9": [".#.", "#.#", ".##", "..#", "##."],
    " ": ["...", "...", "...", "...", "..."],
}

# ICAO -> (display code, background hex, foreground hex).
# Brand-colored 3-char code badges for cargo carriers (not logo artwork). Drop in
# real logos with tools/png_to_rgb565.py / tools/convert_logo_folder.py.
CARGO = {
    "FDX": ("FDX", "4D148C", "FF6600"),  # FedEx Express (purple / orange)
    "UPS": ("UPS", "351C15", "FFB500"),  # UPS (brown / gold)
    "GTI": ("GTI", "0A2A66", "FFFFFF"),  # Atlas Air (navy)
    "GEC": ("GEC", "F0B800", "05164D"),  # Lufthansa Cargo (yellow / navy)
    "CLX": ("CLX", "003B7A", "FFFFFF"),  # Cargolux (blue)
    "CKS": ("CKS", "0055A4", "FFFFFF"),  # Kalitta Air (blue)
    "CAO": ("CAO", "C8102E", "FFD700"),  # Air China Cargo (red / gold)
    "BOX": ("BOX", "1B4DA0", "FFFFFF"),  # AeroLogic (blue)
    "ABW": ("ABW", "0A3D91", "FFFFFF"),  # AirBridgeCargo (blue)
    "MPH": ("MPH", "0066B3", "FFFFFF"),  # Martinair Cargo (blue)
    "PAC": ("PAC", "0033A0", "FFD200"),  # Polar Air Cargo (blue / yellow)
    "GSS": ("GSS", "002157", "FFFFFF"),  # Global / AF-KLM Cargo (navy)
    "NCA": ("NCA", "B0182C", "FFFFFF"),  # Nippon Cargo (red)
    "CKK": ("CKK", "C8102E", "FFD700"),  # China Cargo / Air (red / gold)
    "SQC": ("SQC", "11286B", "F99F1C"),  # Singapore Cargo (navy / gold)
    "ABX": ("ABX", "00529B", "FFFFFF"),  # ABX Air (blue)
    "CJT": ("CJT", "E2231A", "FFFFFF"),  # Cargojet (red)
    "BCS": ("BCS", "FFCC00", "D40511"),  # DHL / European Air Transport (yellow / red)
    "DHK": ("DHK", "FFCC00", "D40511"),  # DHL Air UK (yellow / red)
}

SCALE = 3  # 3x5 glyph -> 9x15
GAP = 2    # pixel gap between glyphs (in output pixels)


def hex_to_rgb(h):
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def rgb565(r, g, b):
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


def render(code, bg, fg):
    bgc, fgc = hex_to_rgb(bg), hex_to_rgb(fg)
    px = [[bgc for _ in range(SIZE)] for _ in range(SIZE)]

    chars = code[:3]
    glyph_w = 3 * SCALE
    total_w = len(chars) * glyph_w + (len(chars) - 1) * GAP
    x0 = (SIZE - total_w) // 2
    y0 = (SIZE - 5 * SCALE) // 2

    cx = x0
    for ch in chars:
        rows = FONT.get(ch.upper(), FONT[" "])
        for ry, row in enumerate(rows):
            for rx, c in enumerate(row):
                if c == "#":
                    for dy in range(SCALE):
                        for dx in range(SCALE):
                            x, y = cx + rx * SCALE + dx, y0 + ry * SCALE + dy
                            if 0 <= x < SIZE and 0 <= y < SIZE:
                                px[y][x] = fgc
        cx += glyph_w + GAP
    return px


def write_tile(path, px):
    with open(path, "wb") as f:
        f.write(struct.pack("<HH", SIZE, SIZE))
        for row in px:
            for (r, g, b) in row:
                f.write(struct.pack("<H", rgb565(r, g, b)))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    written = 0
    for icao, (code, bg, fg) in CARGO.items():
        path = os.path.join(OUT_DIR, icao + ".rgb565")
        if os.path.exists(path):
            print(f"SKIP (exists): {icao}")
            continue
        write_tile(path, render(code, bg, fg))
        written += 1
    print(f"Wrote {written} cargo logo tiles to {os.path.normpath(OUT_DIR)}")


if __name__ == "__main__":
    main()
