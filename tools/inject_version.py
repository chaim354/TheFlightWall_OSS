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
print(f"[version] FW_VERSION={rev}")
