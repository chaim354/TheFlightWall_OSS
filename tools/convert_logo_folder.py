#!/usr/bin/env python3
"""
Batch-convert a folder of airline logo images into LED-panel tiles.

For real logo artwork you have the rights to use: put one image per airline named
by its ICAO code (e.g. UAL.png, DAL.png, BAW.svg-exported-png) in a folder, then:

    pip install pillow
    python3 tools/convert_logo_folder.py ~/airline_logos firmware/data/logos

Each <ICAO>.<ext> becomes firmware/data/logos/<ICAO>.rgb565 (overwriting the
bundled brand-badge tile). Re-flash the filesystem afterwards: `pio run -t uploadfs`.

Output matches png_to_rgb565.py -- both call the same transform in
rgb565_tile.py. That claim used to be true only of the container: this script
carried a dark-on-transparent rescue and a brightness normalisation that the
single-file converter did not, so the same image gave different pixels
depending on which one you ran.

Format, little-endian: uint16 width, uint16 height, then width*height uint16
RGB565 pixels. Transparency is flattened onto black, or onto white for artwork
too dark to see against an unlit panel.
"""
import argparse
import os

from rgb565_tile import TILE_SIZE, convert

EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}


def build_parser():
    ap = argparse.ArgumentParser()
    ap.add_argument("input_dir", help="folder of <ICAO>.<img> files")
    ap.add_argument("output_dir", help="firmware/data/logos")
    ap.add_argument("--size", type=int, default=TILE_SIZE, help="square tile size (px)")
    ap.add_argument("--no-normalize", action="store_true", help="skip brightness normalization")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)

    os.makedirs(args.output_dir, exist_ok=True)
    n = 0
    for name in sorted(os.listdir(args.input_dir)):
        stem, ext = os.path.splitext(name)
        if ext.lower() not in EXTS:
            continue
        icao = stem.upper()
        out = os.path.join(args.output_dir, icao + ".rgb565")
        convert(os.path.join(args.input_dir, name), out, args.size, do_normalize=not args.no_normalize)
        print(f"  {name} -> {icao}.rgb565")
        n += 1
    print(f"Converted {n} logo(s) into {args.output_dir}")


if __name__ == "__main__":
    main()
