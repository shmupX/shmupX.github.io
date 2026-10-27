#!/usr/bin/env bash
#
# Build the Voland WASM core and install it into static/switch/core/, where
# the Nintendo Switch player (static/switch/play.html) looks for it and where
# `deno task members:pack` picks it up for the `switch` member pack. Ported
# from cmg's scripts/build-voland-core.sh.
#
# Voland (github.com/voland-emu/Voland, GPL-2.0) publishes no prebuilt WASM —
# no releases, no npm package — so the player loads a core that has to be
# built from source. This script is that build.
#
#   bash scripts/build-voland-core.sh
#
# Run it from a Linux shell. On Windows that means WSL, not Git Bash: emsdk
# publishes no windows-arm64 Emscripten (its manifest has url_macos/url_linux
# for arch arm64, but url_windows only for x86_64), and linux-arm64 IS
# published, so WSL builds natively on an ARM box:
#
#   wsl -d Ubuntu -- bash /mnt/c/CODE/shmupX.github.io/scripts/build-voland-core.sh
#
# Artifacts land in static/switch/core/ (gitignored — a GPL build artifact,
# and it must not ride into a commit or a deploy). They reach a launcher only
# inside the member pack.
#
# What you get: the core instantiates, reserves its 5.25 GiB shared memory,
# and answers all nine exported FFI functions. It does NOT run games. Upstream
# ships CPU_BACKEND=noop as the only buildable backend (interpreter and
# ballistic are FATAL_ERROR in core/CMakeLists.txt), and nothing in the export
# list accepts a cartridge or a key. Expect "CORE ONLINE — CANNOT BOOT
# CARTRIDGES" in the player.
set -euo pipefail

REPO_URL="https://github.com/voland-emu/Voland.git"
WORK_DIR="${VOLAND_WORK_DIR:-$HOME/.cache/voland-build}"
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/static/switch/core"

step() { printf '\n=== %s ===\n' "$*"; }

step "toolchain"
export PATH="$HOME/.local/bin:$PATH"
# Ubuntu 22.04 ships cmake 3.22; Voland's CMakeLists requires 3.24.
need_cmake=1
if command -v cmake >/dev/null 2>&1; then
  cmake_ver=$(cmake --version | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
  major=${cmake_ver%%.*}; minor=${cmake_ver##*.}
  if [ "$major" -gt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -ge 24 ]; }; then
    need_cmake=0
  fi
fi
if [ "$need_cmake" -eq 1 ]; then
  echo "installing cmake >= 3.24 into ~/.local (system cmake is too old)"
  pip3 install --user --quiet --upgrade cmake
  hash -r
fi
cmake --version | head -1

step "emsdk"
mkdir -p "$WORK_DIR"
if [ ! -d "$WORK_DIR/emsdk" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$WORK_DIR/emsdk"
fi
cd "$WORK_DIR/emsdk"
./emsdk install latest
./emsdk activate latest
# shellcheck disable=SC1091
source ./emsdk_env.sh >/dev/null 2>&1
emcc --version | head -1

step "source"
if [ ! -d "$WORK_DIR/Voland" ]; then
  # No --recurse-submodules on purpose. The only submodule is
  # externals/dynarmic, an interim DESKTOP CPU backend; the web build is
  # CPU_BACKEND=noop and the root CMakeLists only add_subdirectory(core), so
  # dynarmic is never referenced. The README's blanket `git submodule update
  # --init --recursive` just downloads hundreds of MB for nothing.
  git clone --depth 1 "$REPO_URL" "$WORK_DIR/Voland"
fi
cd "$WORK_DIR/Voland"
git log -1 --format='commit %h %ad %s' --date=short

step "patch: single-line the emcc -s list arguments"
# Upstream's CMakeLists.txt wraps these across source lines:
#     "-sEXPORTED_FUNCTIONS=['_emulator_create_ffi','_emulator_destroy_ffi',
#                             '_emulator_run_ffi', ...]"
# CMake preserves the embedded newlines, and emcc's -s parser stops at the
# first one, so the link fails outright:
#     emcc: error: error parsing "-s" setting "EXPORTED_FUNCTIONS=[...,"
#     unterminated string list. expected final character to be "]"
# The web target does not link without this. Collapsing the interior
# whitespace changes which symbols are exported not at all — it only lets the
# argument survive intact to emcc. Idempotent, so re-runs are safe.
python3 - <<'PY'
import re, pathlib
p = pathlib.Path("CMakeLists.txt")
src = p.read_text()
pattern = re.compile(r'"-s[A-Z_]+=\[[^"]*\]"', re.S)
out, n = pattern.subn(lambda m: re.sub(r'\s*\n\s*', '', m.group(0)), src)
if out != src:
    p.write_text(out)
print(f"collapsed {n} -s list argument(s)")
PY

step "configure + compile"
rm -rf build/web
emcmake cmake -B build/web \
  -DCMAKE_BUILD_TYPE=Release \
  -DCPU_BACKEND=noop \
  -DGPU_BACKEND=webgpu \
  -DPLATFORM=web
cmake --build build/web -j"$(nproc)"

step "install into $DEST"
mkdir -p "$DEST"
cp -v build/web/core/switch_core.js build/web/core/switch_core.wasm "$DEST/"

step "done"
ls -la "$DEST"
echo
echo "Next: put your prod.keys (and title.keys, if any) in static/switch/keys/,"
echo "drop cartridges in static/NintendoSwitch/ and run 'deno task switch:manifest',"
echo "then 'deno task members:pack' writes build/steam/members/shmupx-member-switch.zip."
echo "In the launcher, Settings -> MEMBER FILES imports it and the NINTENDO SWITCH"
echo "tile appears in the strip."
