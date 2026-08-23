#!/usr/bin/env python3
"""
Generate a starter set of 32x32 airline "logo" tiles for the LED panel.

These are brand-colored tiles showing the airline's 2-char code in a tiny pixel
font — the legible, recognizable mark used by most LED flight displays. They ship
in firmware/data/logos/<ICAO>.rgb565 so the wall has logos out of the box. Swap in
real logo artwork any time with tools/png_to_rgb565.py (same output format).

Output format (.rgb565), little-endian:
    uint16 width, uint16 height, then width*height * uint16 RGB565 pixels.

Existing tiles are left alone: firmware/data/logos/ holds hand-placed artwork
that is not in git, so a rerun must never clobber it. Pass --force to regenerate
deliberately.

Pure standard library — no Pillow required. Run from the repo root:
    python3 tools/gen_starter_logos.py            # fill in what is missing
    python3 tools/gen_starter_logos.py --force    # regenerate every tile
"""
import argparse
import os
import struct

SIZE = 32
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

# ICAO -> (display code [IATA], background hex, foreground hex)
# These are brand-colored 2-char code badges (not airline logo artwork). Drop in
# real logos with tools/png_to_rgb565.py / tools/convert_logo_folder.py.
AIRLINES = {
    # --- North America ---
    "UAL": ("UA", "1414B4", "FFFFFF"),  # United
    "DAL": ("DL", "003268", "FFFFFF"),  # Delta
    "AAL": ("AA", "0078D2", "FFFFFF"),  # American
    "SWA": ("WN", "304CB2", "F9B612"),  # Southwest
    "JBU": ("B6", "003876", "FFFFFF"),  # JetBlue
    "ASA": ("AS", "01426A", "FFFFFF"),  # Alaska
    "FFT": ("F9", "00684A", "FFFFFF"),  # Frontier
    "NKS": ("NK", "FFEC00", "111111"),  # Spirit
    "HAL": ("HA", "52247F", "FFFFFF"),  # Hawaiian
    "SCX": ("SY", "00263A", "FFCC00"),  # Sun Country
    "AAY": ("G4", "00529B", "F58025"),  # Allegiant
    "ACA": ("AC", "D22630", "FFFFFF"),  # Air Canada
    "WJA": ("WS", "00457C", "FFFFFF"),  # WestJet
    "AMX": ("AM", "0B2343", "FFFFFF"),  # Aeromexico
    "VOI": ("Y4", "A4218E", "FFFFFF"),  # Volaris
    # --- Europe ---
    "BAW": ("BA", "075AAA", "FFFFFF"),  # British Airways
    "DLH": ("LH", "05164D", "F9BA00"),  # Lufthansa
    "AFR": ("AF", "002157", "FFFFFF"),  # Air France
    "KLM": ("KL", "00A1DE", "FFFFFF"),  # KLM
    "EZY": ("U2", "FF6600", "FFFFFF"),  # easyJet
    "RYR": ("FR", "073590", "F1C933"),  # Ryanair
    "IBE": ("IB", "D40F14", "F9B612"),  # Iberia
    "VLG": ("VY", "FFCC00", "111111"),  # Vueling
    "SAS": ("SK", "003D87", "FFFFFF"),  # SAS
    "SWR": ("LX", "E2001A", "FFFFFF"),  # Swiss
    "AUA": ("OS", "E2001A", "FFFFFF"),  # Austrian
    "BEL": ("SN", "00A1DE", "FFFFFF"),  # Brussels
    "TAP": ("TP", "00A04A", "FFFFFF"),  # TAP Air Portugal
    "FIN": ("AY", "0B1560", "FFFFFF"),  # Finnair
    "THY": ("TK", "C70A0C", "FFFFFF"),  # Turkish
    "AEE": ("A3", "00508F", "FFFFFF"),  # Aegean
    "LOT": ("LO", "11357A", "FFFFFF"),  # LOT
    "NAX": ("DY", "D81E05", "FFFFFF"),  # Norwegian
    "WZZ": ("W6", "C6007E", "FFFFFF"),  # Wizz Air
    "EIN": ("EI", "006272", "FFFFFF"),  # Aer Lingus
    "ITY": ("AZ", "004B87", "FFFFFF"),  # ITA Airways
    "VIR": ("VS", "E10A0A", "FFFFFF"),  # Virgin Atlantic
    "EWG": ("EW", "8E0038", "FFFFFF"),  # Eurowings
    # --- Middle East / Africa ---
    "UAE": ("EK", "D71921", "FFFFFF"),  # Emirates
    "ETD": ("EY", "B58A3C", "FFFFFF"),  # Etihad
    "QTR": ("QR", "5C0632", "FFFFFF"),  # Qatar
    "SVA": ("SV", "00683C", "FFFFFF"),  # Saudia
    "MSR": ("MS", "002F87", "FFFFFF"),  # EgyptAir
    "ETH": ("ET", "6CB33F", "FFFFFF"),  # Ethiopian
    "RJA": ("RJ", "5A2D81", "FFFFFF"),  # Royal Jordanian
    "ELY": ("LY", "003399", "FFFFFF"),  # El Al
    "SAA": ("SA", "0046AD", "FFFFFF"),  # South African
    "RAM": ("AT", "C4122E", "FFFFFF"),  # Royal Air Maroc
    "KQA": ("KQ", "C8102E", "FFFFFF"),  # Kenya Airways
    # --- Asia / Pacific ---
    "QFA": ("QF", "E40000", "FFFFFF"),  # Qantas
    "VOZ": ("VA", "C8102E", "FFFFFF"),  # Virgin Australia
    "ANZ": ("NZ", "2D2926", "FFFFFF"),  # Air New Zealand
    "SIA": ("SQ", "11286B", "F99F1C"),  # Singapore
    "CPA": ("CX", "006564", "FFFFFF"),  # Cathay Pacific
    "JAL": ("JL", "C8102E", "FFFFFF"),  # Japan Airlines
    "ANA": ("NH", "13448F", "FFFFFF"),  # All Nippon
    "KAL": ("KE", "00256C", "FFFFFF"),  # Korean Air
    "AAR": ("OZ", "00A0E2", "FFFFFF"),  # Asiana
    "CCA": ("CA", "E2001A", "FFD700"),  # Air China
    "CES": ("MU", "C8102E", "FFFFFF"),  # China Eastern
    "CSN": ("CZ", "00A1DE", "FFFFFF"),  # China Southern
    "CAL": ("CI", "C8102E", "FFFFFF"),  # China Airlines
    "EVA": ("BR", "006847", "F5A800"),  # EVA Air
    "THA": ("TG", "4B0082", "D4A017"),  # Thai Airways
    "AIC": ("AI", "C8102E", "FF9933"),  # Air India
    "IGO": ("6E", "002D72", "FFFFFF"),  # IndiGo
    "MAS": ("MH", "006DB7", "FFFFFF"),  # Malaysia
    "GIA": ("GA", "035AA6", "FFFFFF"),  # Garuda Indonesia
    "PAL": ("PR", "00529B", "FFFFFF"),  # Philippine
    "CEB": ("5J", "FCB711", "1B3A6B"),  # Cebu Pacific
    "HVN": ("VN", "00529B", "F9B612"),  # Vietnam Airlines
    "AXM": ("AK", "C8102E", "FFFFFF"),  # AirAsia
    # --- Latin America ---
    "LAN": ("LA", "1B0088", "FFFFFF"),  # LATAM
    "AVA": ("AV", "D31245", "FFFFFF"),  # Avianca
    "GLO": ("G3", "FF7A00", "FFFFFF"),  # Gol
    "AZU": ("AD", "003DA5", "FFFFFF"),  # Azul
    "ARG": ("AR", "009FE3", "FFFFFF"),  # Aerolineas Argentinas
    "CMP": ("CM", "003DA5", "FFFFFF"),  # Copa
}

SCALE = 4  # 3x5 glyph -> 12x20


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


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("--force", action="store_true",
                    help="overwrite tiles that already exist (default: skip them)")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    os.makedirs(OUT_DIR, exist_ok=True)
    written = skipped = 0
    for icao, (code, bg, fg) in AIRLINES.items():
        path = os.path.join(OUT_DIR, icao + ".rgb565")
        if os.path.exists(path) and not args.force:
            skipped += 1
            continue
        write_tile(path, render(code, bg, fg))
        written += 1
    out = os.path.normpath(OUT_DIR)
    print(f"Wrote {written} logo tiles to {out}")
    if skipped:
        print(f"Skipped {skipped} that already exist (--force to overwrite)")


if __name__ == "__main__":
    main()
