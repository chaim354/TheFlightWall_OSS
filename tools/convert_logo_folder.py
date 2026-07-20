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


def normalize(img, target=230.0):
    """Scale so each logo's peak (99th-pct) luminance hits `target`, evening out
    brightness across logos with very different source luminance. Black stays black."""
    px = list(img.getdata())
    lums = sorted(0.299 * r + 0.587 * g + 0.114 * b for (r, g, b) in px)
    p = lums[min(len(lums) - 1, int(len(lums) * 0.99))]
    if p <= 1:
        return img
    s = min(3.0, target / p)
    if 0.95 < s < 1.05:
        return img
    img.putdata([(min(255, int(r * s)), min(255, int(g * s)), min(255, int(b * s))) for (r, g, b) in px])
    return img


def convert(src, dst, size, do_normalize=True):
    rgba = Image.open(src).convert("RGBA").resize((size, size), Image.LANCZOS)
    img = Image.alpha_composite(Image.new("RGBA", rgba.size, (0, 0, 0, 255)), rgba).convert("RGB")
    # Dark-on-transparent logos vanish on the black panel — flatten on white instead
    # so the dark mark stays visible (white tile, dark logo).
    if max(max(p) for p in img.getdata()) < 60:
        img = Image.alpha_composite(Image.new("RGBA", rgba.size, (255, 255, 255, 255)), rgba).convert("RGB")
    if do_normalize:
        img = normalize(img)
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
    ap.add_argument("--size", type=int, default=16, help="square tile size (px); use 32 for 128x64")
    ap.add_argument("--no-normalize", action="store_true", help="skip brightness normalization")
    args = ap.parse_args()

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
