#!/usr/bin/env python3
"""
Convert a logo image (PNG/JPG/etc.) into the LED panel's .rgb565 tile format so
you can ship real airline artwork on the wall.

Usage:
    python3 tools/png_to_rgb565.py united.png firmware/data/logos/UAL.rgb565 [--size 16]

Requires Pillow:  pip install pillow

Output format (.rgb565), little-endian:
    uint16 width, uint16 height, then width*height * uint16 RGB565 pixels.
Transparent pixels are flattened onto black (the panel's "off" color).
"""
import argparse
import struct

try:
    from PIL import Image
except ImportError:
    raise SystemExit("Pillow is required: pip install pillow")


def rgb565(r, g, b):
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--size", type=int, default=16, help="square tile size (px)")
    args = ap.parse_args()

    img = Image.open(args.input).convert("RGBA")
    img = img.resize((args.size, args.size), Image.LANCZOS)

    bg = Image.new("RGBA", img.size, (0, 0, 0, 255))
    img = Image.alpha_composite(bg, img).convert("RGB")

    w, h = img.size
    with open(args.output, "wb") as f:
        f.write(struct.pack("<HH", w, h))
        for y in range(h):
            for x in range(w):
                r, g, b = img.getpixel((x, y))
                f.write(struct.pack("<H", rgb565(r, g, b)))
    print(f"Wrote {w}x{h} tile -> {args.output}")


if __name__ == "__main__":
    main()
