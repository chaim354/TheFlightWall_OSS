#!/usr/bin/env python3
"""
Generate generic 32x32 icon tiles for non-airline flights:
  _CARGO.rgb565   - a shipping box (cargo flights)
  _PRIVATE.rgb565 - a small jet silhouette (private / GA flights)

These are plain generic icons (no trademarks), drawn with Pillow. The firmware
picks them when a flight is classified as cargo or private.

    pip install pillow
    python3 tools/gen_special_logos.py
"""
import os
import struct

try:
    from PIL import Image, ImageDraw
except ImportError:
    raise SystemExit("Pillow is required: pip install pillow")

SIZE = 32
OUT = os.path.join(os.path.dirname(__file__), "..", "firmware", "data", "logos")


def rgb565(r, g, b):
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


def save(img, name):
    img = img.convert("RGB")
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(struct.pack("<HH", SIZE, SIZE))
        for y in range(SIZE):
            for x in range(SIZE):
                r, g, b = img.getpixel((x, y))
                f.write(struct.pack("<H", rgb565(r, g, b)))
    print("wrote", name)


def cargo_box():
    img = Image.new("RGB", (SIZE, SIZE), (0, 0, 0))
    d = ImageDraw.Draw(img)
    tan = (196, 146, 84)
    tan_dark = (150, 104, 54)
    edge = (110, 74, 38)
    # body
    d.rectangle([7, 12, 25, 27], fill=tan, outline=edge)
    # lid flaps (two, with a V gap in the middle)
    d.polygon([(7, 12), (10, 7), (16, 7), (16, 12)], fill=tan_dark, outline=edge)
    d.polygon([(16, 12), (16, 7), (22, 7), (25, 12)], fill=tan_dark, outline=edge)
    # packing tape down the center
    d.line([(16, 7), (16, 27)], fill=edge, width=1)
    return img


def private_jet():
    img = Image.new("RGB", (SIZE, SIZE), (0, 0, 0))
    d = ImageDraw.Draw(img)
    body = (232, 236, 245)
    # fuselage (nose to the right) + nose cone
    d.rounded_rectangle([4, 14, 27, 19], radius=2, fill=body)
    d.polygon([(27, 14), (31, 16), (31, 17), (27, 19)], fill=body)
    # tail fin (rear-left, pointing up)
    d.polygon([(4, 15), (2, 7), (9, 15)], fill=body)
    # main wing (swept, downward)
    d.polygon([(15, 18), (9, 26), (13, 26), (20, 19)], fill=body)
    # rear horizontal stabilizer
    d.polygon([(6, 16), (2, 20), (6, 19)], fill=body)
    return img


def helicopter():
    img = Image.new("RGB", (SIZE, SIZE), (0, 0, 0))
    d = ImageDraw.Draw(img)
    c = (225, 230, 240)
    d.line([(2, 7), (30, 7)], fill=c, width=2)        # main rotor
    d.line([(16, 7), (16, 12)], fill=c, width=2)      # mast
    d.ellipse([(7, 12), (21, 23)], fill=c)            # cockpit / body
    d.polygon([(19, 15), (30, 17), (30, 19), (19, 20)], fill=c)  # tail boom
    d.line([(29, 12), (29, 21)], fill=c, width=2)     # tail rotor fin
    d.line([(8, 26), (22, 26)], fill=c, width=1)      # skid
    d.line([(11, 23), (11, 26)], fill=c, width=1)     # skid strut
    d.line([(19, 23), (19, 26)], fill=c, width=1)     # skid strut
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    save(cargo_box(), "_CARGO.rgb565")
    save(private_jet(), "_PRIVATE.rgb565")
    save(helicopter(), "_HELI.rgb565")


if __name__ == "__main__":
    main()
