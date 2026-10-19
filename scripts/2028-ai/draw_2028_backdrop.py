#!/usr/bin/env python3
"""The shared title backdrop: rando's gold 2028 plate, redrawn to tile.

A custom game that brought no backdrop of its own scrolls rando's gold 2028
(title_bg_custom, static/games/2028-ai/assets/img/titleBgCustom.jpg) sideways
without end. rando's upload, kept as art/titleBgCustom-rando.jpg, was 768
wide, and 768 is not a period of its pattern, so the scroll showed a seam at
every wrap. This draws the same plate, reading the same 2028, as a tile that
repeats exactly every 845 pixels.

    python3 scripts/2028-ai/draw_2028_backdrop.py [out.jpg [out.png]]

writes static/games/2028-ai/assets/img/titleBgCustom.jpg by default, 845x480:
as tall as the title screen, and three of the pattern's rows across. It also
writes the same picture losslessly as art/titleBg2028.png, for the records
that carried rando's upload as their own titleBgDataURL (2028.Ai's foo.json,
and rando and foo in the database, title-backdrop.ts): the exporters read
only PNG and GIF title art. Needs numpy, scipy and Pillow. Deterministic: the
grain has a fixed seed.

It is scripts/gs/draw_869_backdrop.py's plate, measured the same way off
rando's upload (its lattice, the emboss kernel, the glyph outlines), with the
word left as the plate sets it: its own 2, 0, 2 and 8, 222.5/4 px apart and
each 6.33/4 px higher than the last, the words 248.2 px apart along the row.
845 px is where rows 121.22 px apart, tilted 25.5 degrees, come round three
rows across; three words along each closes the lattice with a row stagger of
(845 cos 25.5 - 3 * 248.2) / 3 = 6.0 px, near the plate's own 4.3. The words
sit where the plate's do, so the first 768 columns line up with the upload.
"""

import os
import sys

import numpy as np
from scipy import ndimage as nd
from scipy.signal import fftconvolve

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "gs"))
import draw_869_backdrop as plate  # noqa: E402

OUT = os.path.join(HERE, "..", "..", "static", "games", "2028-ai", "assets", "img", "titleBgCustom.jpg")
OUT_PNG = os.path.join(HERE, "art", "titleBg2028.png")
SEED = 2028
PER_ROW = 3         # words along each of the tile's three rows


def word_relief(m):
    """The plate's 2028, outlines and fill, on its word box (4x)."""
    X = plate.line(m.G)
    relief = np.stack([fftconvolve(X, m.K[..., c], mode="same") for c in range(3)], -1)
    return relief + nd.gaussian_filter(m.G.astype(float), 4)[..., None] * m.fillc


def origin(m, P, plate_size):
    """
    Where the tile's word (0, 0) goes, along and across the rows, so that the
    word nearest the plate's centre lands where it stands on the plate.
    """
    th = np.radians(plate.ANGLE)
    TW = int(round(3 * plate.ROW_R / np.sin(th)))
    R = TW * np.sin(th) / 3
    s = (TW * np.cos(th) - PER_ROW * P) / 3
    nh, nw = m.level_shape
    w, h = plate_size
    sx, sy = m.sol_x, m.sol_y
    # the plate's word nearest its centre, on the level plate (array indices)
    j = round((nh / 2 - 0.5 - sy[0]) / sy[2])
    i = round((nw / 2 - 0.5 - sx[0] - j * sx[2]) / sx[1])
    lx = sx[0] + i * sx[1] + j * sx[2] + 0.5
    ly = sy[0] + i * sy[1] + j * sy[2] + 0.5
    # level plate -> the tile's along/across-row frame: Image.rotate turns
    # about the centres, which the expanded plate keeps
    u = lx - nw / 2 + (w / 2) * np.cos(th) - (h / 2) * np.sin(th)
    v = ly - nh / 2 + (w / 2) * np.sin(th) + (h / 2) * np.cos(th)
    return (u - i * P - j * s, v - j * R)


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else OUT
    png_path = sys.argv[2] if len(sys.argv) > 2 else OUT_PNG
    m = plate.measure(plate.PLATE)
    P = plate.WORD_P / plate.SC                     # 2028's word period, 1x
    with plate.Image.open(plate.PLATE) as im:
        size = im.size
    img, TW, P, R, s = plate.tile(word_relief(m), plate.PLATE, P, PER_ROW, origin(m, P, size), SEED)
    plate.save(img, out_path)
    plate.Image.fromarray(img).save(png_path, optimize=True)
    print(f"{out_path}, {png_path}: {TW}x{plate.TILE_H}, {len(m.centres)} words measured, "
          f"word period {P:.3f}, rows {R:.3f} apart, stagger {s:.3f}")


if __name__ == "__main__":
    main()
