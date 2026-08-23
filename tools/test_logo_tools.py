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


if __name__ == "__main__":
    unittest.main()
