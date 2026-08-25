"""
Stamp the build with the git revision it came from.

Wired into platformio.ini as an extra_script. The device compares FW_VERSION
against the version the server advertises to decide whether an update exists,
so it has to be derived rather than hand-maintained -- a constant someone
forgets to bump makes the wall believe it is current forever.

Marked `-dirty` when the tree has uncommitted changes, matching
tools/sign_firmware.sh exactly. An image built from an unrecorded state should
say so: the whole point of the version is answering "what is actually running
out there", and "some edit of 2e05f4d" is a different answer from "2e05f4d".
"""
import os
import subprocess

Import("env")  # noqa: F821  (injected by PlatformIO)


def git(*args):
    try:
        return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return ""


rev = git("rev-parse", "--short", "HEAD") or "unknown"
if rev != "unknown":
    dirty = git("status", "--porcelain") != ""
    if dirty:
        rev += "-dirty"

env.Append(CPPDEFINES=[("FW_VERSION", env.StringifyMacro(rev))])  # noqa: F821

# Also written BESIDE the binary, and that file -- not git -- is what
# tools/sign_firmware.sh publishes as the version.
#
# Deriving the version from git at SIGNING time is a bug that hides well:
# sign an existing binary after any further commit or edit and the manifest
# advertises a version the image does not contain. The device then installs it,
# boots reporting the version actually compiled in, sees the server still
# offering a different one, and offers the same update forever. Observed
# exactly that: a manifest reading 122268d-dirty for an image built as c04980b.
build_dir = env.subst("$BUILD_DIR")  # noqa: F821
os.makedirs(build_dir, exist_ok=True)
with open(os.path.join(build_dir, "fw_version.txt"), "w") as f:
    f.write(rev)

print(f"[version] FW_VERSION={rev}")
