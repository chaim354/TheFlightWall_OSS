#!/usr/bin/env python3
"""
Batch-convert a folder of airline logo images into LED-panel tiles.

For real logo artwork you have the rights to use: put one image per airline named
by its ICAO code (e.g. UAL.png, DAL.png, BAW.svg-exported-png) in a folder, then:

    pip install pillow
    python3 tools/convert_logo_folder.py ~/airline_logos firmware/data/logos --size 16

Each <ICAO>.<ext> becomes firmware/data/logos/<ICAO>.rgb565 (overwriting the
bundled brand-badge tile). Re-flash the filesystem afterwards: `pio run -t uploadfs`.

Output format matches png_to_rgb565.py:
    uint16 width, uint16 height, then width*height * uint16 RGB565 pixels (LE).
Transparency is flattened onto black (the panel's "off" color).
"""
import argparse
import os
import struct

try:
    from PIL import Image
except ImportError:
    raise SystemExit("Pillow is required: pip install pillow")

EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}


def rgb565(r, g, b):
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


def convert(src, dst, size):
    img = Image.open(src).convert("RGBA").resize((size, size), Image.LANCZOS)
    bg = Image.new("RGBA", img.size, (0, 0, 0, 255))
    img = Image.alpha_composite(bg, img).convert("RGB")
    with open(dst, "wb") as f:
        f.write(struct.pack("<HH", size, size))
        for y in range(size):
            for x in range(size):
                r, g, b = img.getpixel((x, y))
                f.write(struct.pack("<H", rgb565(r, g, b)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input_dir", help="folder of <ICAO>.<img> files")
    ap.add_argument("output_dir", help="firmware/data/logos")
    ap.add_argument("--size", type=int, default=16, help="square tile size (px)")
    args = ap.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    n = 0
    for name in sorted(os.listdir(args.input_dir)):
        stem, ext = os.path.splitext(name)
        if ext.lower() not in EXTS:
            continue
        icao = stem.upper()
        out = os.path.join(args.output_dir, icao + ".rgb565")
        convert(os.path.join(args.input_dir, name), out, args.size)
        print(f"  {name} -> {icao}.rgb565")
        n += 1
    print(f"Converted {n} logo(s) into {args.output_dir}")


if __name__ == "__main__":
    main()
