"""
Pre-compress the web UI into firmware/data/ so the device can serve it with
Content-Encoding: gzip.

Wired into platformio.ini as `extra_scripts = pre:../tools/gzip_web_assets.py`, so it
runs on every invocation — including `uploadfs`, which is the one that matters. Doing
this at build time rather than committing the .gz means the two can never drift: an
edit to index.html is always reflected in what gets packed.

Why bother on a LAN device: WebConfigServer runs inside loop(), which blocks for
seconds at a time on the flight fetch. The page can only stream during the gaps, so
~25KB -> ~7.5KB is directly less time with the UI half-loaded.

Both files stay in data/. The uncompressed one is the fallback path in handleRoot()
and costs ~25KB of a 9.9MB partition — not worth optimizing away.
"""
import gzip
import pathlib
import shutil

Import("env")  # noqa: F821  (injected by PlatformIO)

# Ask PlatformIO where data/ is rather than deriving it from __file__ — SCons exec()s
# this script instead of importing it, so __file__ is not defined here.
DATA_DIR = pathlib.Path(env.subst("$PROJECT_DATA_DIR"))  # noqa: F821
ASSETS = ["index.html"]


def gzip_assets(*args, **kwargs):
    for name in ASSETS:
        src = DATA_DIR / name
        if not src.exists():
            print(f"[gzip] skip {name} (not found)")
            continue
        dst = src.with_suffix(src.suffix + ".gz")
        # mtime=0 keeps the output byte-identical for identical input, so a rebuild
        # with no source change does not produce a different filesystem image.
        with src.open("rb") as f_in, gzip.GzipFile(dst, "wb", compresslevel=9, mtime=0) as f_out:
            shutil.copyfileobj(f_in, f_out)
        before, after = src.stat().st_size, dst.stat().st_size
        pct = 100 - (after * 100 // max(before, 1))
        print(f"[gzip] {name}: {before} -> {after} bytes ({pct}% smaller)")


gzip_assets()
