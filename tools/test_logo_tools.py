#!/usr/bin/env python3
"""
Host tests for the logo asset pipeline.

Covers the two facts F-TOOL01-A found drifting (2026-08-23 audit):
  1. Every writer in the toolchain agrees the tile size is 32 -- the shipped
     bundle is 153 files of 2052 bytes (4-byte header + 32*32*2), and three of
     the five writers said 16.
  2. `gen_starter_logos.py` does not silently overwrite artwork that is already
     on disk. firmware/data/logos/ holds the maintainer's local, uncommitted,
     trademarked tiles (HANDOFF.md 5); the README documents running this script,
     and before this guard existed doing so destroyed ~78 of them with no prompt.

Pure standard library, like the scripts under test. Run from the repo root:
    python3 -m unittest discover -s tools -p 'test_*.py' -v
"""
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import convert_logo_folder  # noqa: E402
import gen_cargo_logos  # noqa: E402
import gen_special_logos  # noqa: E402
import gen_starter_logos  # noqa: E402
import png_to_rgb565  # noqa: E402

TILE_SIZE = 32
TILE_BYTES = 4 + TILE_SIZE * TILE_SIZE * 2  # header + RGB565 pixels


def header_of(path):
    """Return (width, height) from a .rgb565 file's little-endian header."""
    with open(path, "rb") as f:
        return struct.unpack("<HH", f.read(4))


class TileSizeContract(unittest.TestCase):
    """One tile geometry, asserted across every writer that encodes it."""

    def test_all_generators_agree_on_the_tile_size(self):
        self.assertEqual(gen_starter_logos.SIZE, TILE_SIZE)
        self.assertEqual(gen_cargo_logos.SIZE, TILE_SIZE)
        self.assertEqual(gen_special_logos.SIZE, TILE_SIZE)

    def test_both_converters_default_to_the_tile_size(self):
        for mod in (png_to_rgb565, convert_logo_folder):
            parser = mod.build_parser()
            self.assertEqual(
                parser.get_default("size"), TILE_SIZE,
                f"{mod.__name__} --size default disagrees with the shipped bundle",
            )

    def test_starter_tiles_match_the_shipped_geometry(self):
        with tempfile.TemporaryDirectory() as out:
            self._run_starter(out)
            tiles = sorted(f for f in os.listdir(out) if f.endswith(".rgb565"))
            self.assertTrue(tiles, "generator wrote nothing")
            for name in tiles:
                path = os.path.join(out, name)
                self.assertEqual(header_of(path), (TILE_SIZE, TILE_SIZE), name)
                self.assertEqual(os.path.getsize(path), TILE_BYTES, name)

    @staticmethod
    def _run_starter(out_dir, argv=None):
        original = gen_starter_logos.OUT_DIR
        gen_starter_logos.OUT_DIR = out_dir
        try:
            gen_starter_logos.main(argv or [])
        finally:
            gen_starter_logos.OUT_DIR = original


class StarterDoesNotClobberArtwork(unittest.TestCase):
    """The README tells people to run this script. It must be safe by default."""

    SENTINEL = b"real artwork, not a generated badge"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.out = self._tmp.name
        self.addCleanup(self._tmp.cleanup)
        # Stand in for a hand-placed tile the maintainer cannot recover from git.
        self.existing = os.path.join(self.out, "UAL.rgb565")
        with open(self.existing, "wb") as f:
            f.write(self.SENTINEL)

    def test_existing_tile_survives_a_default_run(self):
        TileSizeContract._run_starter(self.out)
        with open(self.existing, "rb") as f:
            self.assertEqual(f.read(), self.SENTINEL,
                             "default run overwrote existing artwork")

    def test_default_run_still_writes_the_missing_tiles(self):
        TileSizeContract._run_starter(self.out)
        written = [f for f in os.listdir(self.out) if f.endswith(".rgb565")]
        self.assertGreater(len(written), 1, "skip guard suppressed everything")

    def test_force_overwrites_deliberately(self):
        TileSizeContract._run_starter(self.out, ["--force"])
        self.assertEqual(header_of(self.existing), (TILE_SIZE, TILE_SIZE))
        self.assertEqual(os.path.getsize(self.existing), TILE_BYTES)


class BothConvertersAgree(unittest.TestCase):
    """F-TOOL01-B: two entry points, one image->tile transform.

    convert_logo_folder.py's header claims "Output format matches
    png_to_rgb565.py". That was true of the CONTAINER and false of the PIXELS:
    it also carried a dark-on-transparent rescue (composite on white when the
    image is nearly black) and a brightness normalisation that the single-file
    converter did not.

    The gap fails silently and looks like a firmware bug. A black wordmark
    exported from SVG on a transparent background flattens onto black, giving an
    all-black tile -- which still passes tileFor()'s `w>0 && h>0 && w<=64` test,
    so drawLogoOrBadge takes the haveLogo branch and paints a black square. It
    never reaches the accentColorFor code-badge fallback the user wanted.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def _dark_on_transparent(self):
        """A near-black mark on a fully transparent field -- the common case."""
        from PIL import Image
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        for y in range(20, 44):
            for x in range(20, 44):
                img.putpixel((x, y), (10, 10, 10, 255))
        path = os.path.join(self.dir, "DARK.png")
        img.save(path)
        return path

    @staticmethod
    def _pixels(tile_path):
        with open(tile_path, "rb") as f:
            w, h = struct.unpack("<HH", f.read(4))
            return [struct.unpack("<H", f.read(2))[0] for _ in range(w * h)]

    @staticmethod
    def _peak_channel(pixels):
        """Brightest 8-bit channel value across the tile, from RGB565."""
        peak = 0
        for p in pixels:
            r = ((p >> 11) & 0x1F) << 3
            g = ((p >> 5) & 0x3F) << 2
            b = (p & 0x1F) << 3
            peak = max(peak, r, g, b)
        return peak

    def test_single_file_converter_emits_a_VISIBLE_tile(self):
        # Not "not literally zero" -- (10,10,10) survives that trivially while
        # being invisible on the panel. The threshold is the one the rescue
        # itself uses: below 60, a tile is indistinguishable from the unlit
        # panel and the user would have been better served by the code badge.
        src = self._dark_on_transparent()
        out = os.path.join(self.dir, "DARK.rgb565")
        png_to_rgb565.main([src, out])
        self.assertGreaterEqual(
            self._peak_channel(self._pixels(out)), 60,
            "dark-on-transparent produced a tile too dark to see on the panel")

    def test_both_entry_points_produce_identical_pixels(self):
        src = self._dark_on_transparent()
        single = os.path.join(self.dir, "single.rgb565")
        png_to_rgb565.main([src, single])

        folder_out = os.path.join(self.dir, "out")
        convert_logo_folder.main([self.dir, folder_out])
        batch = os.path.join(folder_out, "DARK.rgb565")

        self.assertEqual(self._pixels(single), self._pixels(batch),
                         "the two converters disagree on pixels for one input")


if __name__ == "__main__":
    unittest.main()
