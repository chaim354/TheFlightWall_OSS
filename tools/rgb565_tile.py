#!/usr/bin/env python3
"""
The one image -> .rgb565 tile transform, shared by both converters.

WHY THIS EXISTS. png_to_rgb565.py and convert_logo_folder.py each owned a copy,
and the copies had diverged: the batch one carried a dark-on-transparent rescue
and a brightness normalisation the single-file one did not, while its own header
claimed "Output format matches png_to_rgb565.py" -- true of the container, false
of the pixels. The README sent single-logo users to the uncorrected script.

The divergence failed silently and read as a firmware bug. A black wordmark on a
transparent background (common -- it is what an SVG export gives you) flattened
onto black and produced an all-but-invisible tile, which still passes
tileFor()'s `w>0 && h>0 && w<=64` validity test, so drawLogoOrBadge takes the
haveLogo branch and paints a black square. It never reaches the accentColorFor
code-badge fallback the user actually wanted.

Tile format, little-endian: uint16 width, uint16 height, then width*height
uint16 RGB565 pixels. Transparency is flattened -- the panel has no alpha.
"""
import struct

try:
    from PIL import Image
except ImportError:
    raise SystemExit("Pillow is required: pip install pillow")

TILE_SIZE = 32

# Below this peak channel value a flattened tile is indistinguishable from the
# unlit panel, so it gets re-flattened onto white instead. Chosen by eye against
# real artwork rather than measured; it is the knob to turn if a logo comes out
# inverted when it should not have.
DARK_RESCUE_THRESHOLD = 60


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


def image_to_tile(src, size=TILE_SIZE, do_normalize=True):
    """Open `src` and return a flattened, size x size RGB image ready to encode."""
    rgba = Image.open(src).convert("RGBA").resize((size, size), Image.LANCZOS)
    img = Image.alpha_composite(Image.new("RGBA", rgba.size, (0, 0, 0, 255)), rgba).convert("RGB")

    # Dark-on-transparent logos vanish on the black panel -- flatten on white
    # instead so the dark mark stays visible (white tile, dark logo).
    if max(max(p) for p in img.getdata()) < DARK_RESCUE_THRESHOLD:
        img = Image.alpha_composite(Image.new("RGBA", rgba.size, (255, 255, 255, 255)), rgba).convert("RGB")

    if do_normalize:
        img = normalize(img)
    return img


def write_tile(dst, img):
    """Encode an RGB image to `dst` in the panel's .rgb565 format."""
    w, h = img.size
    with open(dst, "wb") as f:
        f.write(struct.pack("<HH", w, h))
        for y in range(h):
            for x in range(w):
                f.write(struct.pack("<H", rgb565(*img.getpixel((x, y)))))


def convert(src, dst, size=TILE_SIZE, do_normalize=True):
    """src image -> dst .rgb565 tile."""
    write_tile(dst, image_to_tile(src, size, do_normalize))
