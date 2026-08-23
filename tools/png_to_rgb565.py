#!/usr/bin/env python3
"""
Convert a logo image (PNG/JPG/etc.) into the LED panel's .rgb565 tile format so
you can ship real airline artwork on the wall.

Usage:
    python3 tools/png_to_rgb565.py united.png firmware/data/logos/UAL.rgb565 [--size 32]

The image transform itself lives in rgb565_tile.py, shared with
convert_logo_folder.py -- the two used to carry different copies, and this one
was missing the dark-on-transparent rescue, so a black wordmark converted here
came out invisible on the panel.

Requires Pillow:  pip install pillow

Output format (.rgb565), little-endian:
    uint16 width, uint16 height, then width*height * uint16 RGB565 pixels.
Transparent pixels are flattened onto black (the panel's "off" color).
"""
import argparse

from rgb565_tile import TILE_SIZE, convert


def build_parser():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--size", type=int, default=TILE_SIZE, help="square tile size (px)")
    ap.add_argument("--no-normalize", action="store_true", help="skip brightness normalization")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    convert(args.input, args.output, args.size, do_normalize=not args.no_normalize)
    print(f"Wrote {args.output} ({args.size}x{args.size})")


if __name__ == "__main__":
    main()
