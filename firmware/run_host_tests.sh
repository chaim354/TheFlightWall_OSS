#!/usr/bin/env bash
#
# Run the firmware host tests -- the pure-logic suites under test/test_*.cpp,
# each a standalone g++ program with its own main(), runnable with no board
# attached. (The on-device suite is test/test_logic/, run via `pio test`.)
#
#   ./run_host_tests.sh            # build and run all of them
#   ./run_host_tests.sh route lru  # just these
#
# Exits non-zero if any test fails to compile or fails at runtime.
#
# This exists because the inventory used to live in prose: a `for t in parsers
# classify lru ...` loop typed into HANDOFF.md and copied into two other docs,
# already stale in both. Worse, `g++ ... && ./t_$t` inside a bare `for` throws
# away each iteration's status -- the loop's exit code was the LAST iteration's
# alone, so a compile error scrolled past and the loop still exited 0. Five of
# the eight suites print a bare "ALL PASS", indistinguishable from each other,
# so the only way to detect a failure was to count the lines by eye. "All host
# tests passed" was not a representable outcome (F-FW14-B, 2026-08-23 audit).
#
# The inventory is now derived from the glob, so adding test/test_foo.cpp is
# enough -- there is no list to update.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

CXX="${CXX:-g++}"
CXXFLAGS="${CXXFLAGS:--std=c++17 -Wall -Wextra}"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

# Selection: named suites if given, else every test/test_*.cpp. The nullglob
# guard keeps an unmatched pattern from being passed through as a literal path.
shopt -s nullglob
if [ "$#" -gt 0 ]; then
  sources=()
  for name in "$@"; do
    src="test/test_${name}.cpp"
    if [ ! -f "$src" ]; then
      echo "no such host test: $src" >&2
      exit 2
    fi
    sources+=("$src")
  done
else
  sources=(test/test_*.cpp)
fi
shopt -u nullglob

if [ "${#sources[@]}" -eq 0 ]; then
  echo "no host tests found in test/ -- expected test/test_*.cpp" >&2
  exit 2
fi

passed=() ; failed=()

for src in "${sources[@]}"; do
  name="$(basename "$src" .cpp)"
  name="${name#test_}"
  bin="$BUILD_DIR/$name"

  if ! "$CXX" $CXXFLAGS "$src" -o "$bin"; then
    echo "FAIL  $name (compile)"
    failed+=("$name (compile)")
    continue
  fi

  if "$bin"; then
    echo "ok    $name"
    passed+=("$name")
  else
    echo "FAIL  $name (exit $?)"
    failed+=("$name (runtime)")
  fi
done

echo
if [ "${#failed[@]}" -eq 0 ]; then
  echo "All ${#passed[@]} host tests passed."
  exit 0
fi

echo "${#failed[@]} of $(( ${#passed[@]} + ${#failed[@]} )) host tests FAILED:"
for f in "${failed[@]}"; do echo "  - $f"; done
exit 1
