#!/usr/bin/env python3
"""
Generate a starter set of 16x16 airline "logo" tiles for the LED panel.

These are brand-colored tiles showing the airline's 2-char code in a tiny pixel
font — the legible, recognizable mark used by most LED flight displays. They ship
in firmware/data/logos/<ICAO>.rgb565 so the wall has logos out of the box. Swap in
real logo artwork any time with tools/png_to_rgb565.py (same output format).

Output format (.rgb565), little-endian:
    uint16 width, uint16 height, then width*height * uint16 RGB565 pixels.

Pure standard library — no Pillow required. Run from the repo root:
    python3 tools/gen_starter_logos.py
"""
import os
import struct

SIZE = 16
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "firmware", "data", "logos")

# 3x5 pixel font (top->bottom). Only the glyphs used by airline codes are needed,
# but A-Z and 0-9 are all defined so any code renders.
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

# ICAO -> (display code, background hex, foreground hex)
AIRLINES = {
    "UAL": ("UA", "1414B4", "FFFFFF"),  # United
    "DAL": ("DL", "003268", "FFFFFF"),  # Delta
    "AAL": ("AA", "0078D2", "FFFFFF"),  # American
    "SWA": ("WN", "304CB2", "F9B612"),  # Southwest
    "JBU": ("B6", "003876", "FFFFFF"),  # JetBlue
    "ASA": ("AS", "01426A", "FFFFFF"),  # Alaska
    "FFT": ("F9", "00684A", "FFFFFF"),  # Frontier
    "NKS": ("NK", "FFEC00", "111111"),  # Spirit
    "BAW": ("BA", "2E5C99", "FFFFFF"),  # British Airways
    "DLH": ("LH", "05164D", "F9BA00"),  # Lufthansa
    "AFR": ("AF", "002157", "FFFFFF"),  # Air France
    "KLM": ("KL", "00A1DE", "FFFFFF"),  # KLM
    "UAE": ("EK", "D71921", "FFFFFF"),  # Emirates
    "ACA": ("AC", "D22630", "FFFFFF"),  # Air Canada
    "RYR": ("FR", "073590", "F1C933"),  # Ryanair
    "QFA": ("QF", "E40000", "FFFFFF"),  # Qantas
    "SIA": ("SQ", "11286B", "F99F1C"),  # Singapore
    "EZY": ("U2", "FF6600", "FFFFFF"),  # easyJet
}

SCALE = 2  # 3x5 glyph -> 6x10


def hex_to_rgb(h):
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def rgb565(r, g, b):
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


def render(code, bg, fg):
    bgc, fgc = hex_to_rgb(bg), hex_to_rgb(fg)
    px = [[bgc for _ in range(SIZE)] for _ in range(SIZE)]

    chars = code[:2]  # two chars fit cleanly at scale 2
    glyph_w = 3 * SCALE
    gap = SCALE
    total_w = len(chars) * glyph_w + (len(chars) - 1) * gap
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
        cx += glyph_w + gap
    return px


def write_tile(path, px):
    with open(path, "wb") as f:
        f.write(struct.pack("<HH", SIZE, SIZE))
        for row in px:
            for (r, g, b) in row:
                f.write(struct.pack("<H", rgb565(r, g, b)))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for icao, (code, bg, fg) in AIRLINES.items():
        write_tile(os.path.join(OUT_DIR, icao + ".rgb565"), render(code, bg, fg))
    print(f"Wrote {len(AIRLINES)} logo tiles to {os.path.normpath(OUT_DIR)}")


if __name__ == "__main__":
    main()
