#!/bin/sh
# Extract reference frames from a gameplay capture for side-by-side comparison
# with the runtime (e.g. a Saturn boss-fight recording vs. the imported level).
#
#   dev-fixtures/debug-tools/extract-frames.sh <video> [out-dir] [fps]
#
# Defaults: out-dir ./frames, fps 2 (a 30s capture -> ~60 stills). Frames are
# numbered f001.png, f002.png, ... in order. Bump fps (e.g. 5 or 10) around a
# transition you need to see closely, trimming with -ss/-t first if the video
# is long:
#
#   ffmpeg -ss 13 -t 6 -i boss.mov -vf fps=10 tx/a%02d.png
set -eu

if [ $# -lt 1 ]; then
    echo "usage: $0 <video> [out-dir] [fps]" >&2
    exit 2
fi
VIDEO=$1
OUT=${2:-./frames}
FPS=${3:-2}

mkdir -p "$OUT"
# clear frames from a previous run so a shorter extraction can't leave stale
# tails behind (and the count below stays honest)
rm -f "$OUT"/f[0-9][0-9][0-9].png
ffmpeg -v error -i "$VIDEO" -vf "fps=$FPS" "$OUT/f%03d.png"
COUNT=$(ls "$OUT"/f[0-9][0-9][0-9].png 2>/dev/null | wc -l | tr -d ' ')
echo "extracted $COUNT frames at ${FPS}fps -> $OUT"
