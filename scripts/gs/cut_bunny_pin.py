#!/usr/bin/env python3
"""The gs cloud game's second-stage story picture: the glitter bunny pin.

The upload, kept as scripts/gs/art/bunnyPinUpload.jpg, is a photo of the
pin on black, with a scatter of gold and silver stars around it. This cuts
the pin out — the black and the stars go, the pin keeps every enclosed dark
bit of its own — and sets it on a transparent 180x240 canvas, the size and
shape gs's other story pictures are (so AdvScene draws it at scale 1 where
they draw, storyPictureFit, and the carts' cover-fit, fitPanel, crops none
of it).

    python3 scripts/gs/cut_bunny_pin.py [out.png]

writes scripts/gs/art/bunnyPin.png by default. story-bunny-pin.ts puts it on
the gs level as storyData/customImages/stage1_part1. Needs numpy and Pillow.
Deterministic: no randomness anywhere.

1. Everything darker than DARK is a candidate for the background. The
   background proper is the dark that reaches the picture's edge: a flood
   from the border, so a dark enamel or shadow enclosed by the pin stays.
2. What is left is the pin and the stars. The pin is the piece that holds
   the picture's centre; the stars are the rest, and go.
3. The mask is worn in by FRINGE pixels: the JPEG's edge between gold and
   black is a dark halo, and this keeps it off the cut edge.
4. The pin is scaled to CANVAS_H - 2 * MARGIN tall at its own shape, area
   filtered with its colour weighted by its coverage so the edge never
   bleeds the black it was cut from, and centred on the canvas.
"""

import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
UPLOAD = os.path.join(HERE, "art", "bunnyPinUpload.jpg")
OUT = os.path.join(HERE, "art", "bunnyPin.png")

DARK = 28           # luma at or under this is black enough to be background
FRINGE = 2          # pixels of edge worn off the mask, against the JPEG halo
CANVAS_W, CANVAS_H = 180, 240   # gs's story pictures
MARGIN = 4          # breathing room above and below the pin


def fill(mask, seed):
    """The part of `mask` that `seed` reaches, 4-connected.

    Geodesic reconstruction without scipy: along every row, a run of mask
    is reached as soon as any pixel of it is; then along every column; and
    again until nothing changes. Each pass is a handful of vectorised sweeps
    over the whole picture, and a silhouette like the pin's settles in a
    few dozen.
    """
    reach = mask & seed
    while True:
        before = reach.sum()
        for axis in (1, 0):
            m = mask if axis == 1 else mask.T
            r = reach if axis == 1 else reach.T
            # Label each row's runs of mask: a run starts where mask is on
            # and the pixel before it (in the row) is off.
            starts = m & ~np.concatenate(
                [np.zeros((m.shape[0], 1), bool), m[:, :-1]], axis=1)
            run = np.cumsum(starts.ravel()).reshape(m.shape)  # 1-based ids
            run_reached = np.bincount(
                run.ravel(), weights=r.ravel(), minlength=run.max() + 1) > 0
            grown = m & run_reached[run]
            reach = grown if axis == 1 else grown.T
        if reach.sum() == before:
            return reach


def erode(mask, times):
    """`mask` worn in by `times` pixels, 8-neighbour."""
    for _ in range(times):
        m = np.pad(mask, 1)
        out = mask.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                out &= m[1 + dy:1 + dy + mask.shape[0],
                         1 + dx:1 + dx + mask.shape[1]]
        mask = out
    return mask


def cut(upload):
    rgb = np.asarray(Image.open(upload).convert("RGB")).astype(np.float32)
    luma = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    dark = luma <= DARK

    # 1. the background: the dark that reaches the edge
    border = np.zeros(dark.shape, bool)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    outside = fill(dark, border)

    # 2. the pin: the solid piece under the picture's centre
    solid = ~outside
    centre = np.zeros(solid.shape, bool)
    centre[solid.shape[0] // 2, solid.shape[1] // 2] = True
    assert solid[centre].all(), "the picture's centre is not on the pin"
    pin = fill(solid, centre)

    # 3. off the JPEG's dark halo
    pin = erode(pin, FRINGE)
    return rgb, pin


def compose(rgb, pin):
    ys, xs = np.nonzero(pin)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    alpha = pin[y0:y1, x0:x1].astype(np.float32)
    colour = rgb[y0:y1, x0:x1] * alpha[..., None]   # coverage-weighted

    # 4. to the canvas, at the pin's own shape
    h = CANVAS_H - 2 * MARGIN
    w = int(round((x1 - x0) * h / (y1 - y0)))
    assert w <= CANVAS_W, "the pin is wider than the canvas"

    def shrink(plane):
        return np.asarray(
            Image.fromarray(plane, "F").resize((w, h), Image.BOX),
            np.float32)

    a = np.clip(shrink(alpha), 0, 1)
    out = np.zeros((h, w, 4), np.float32)
    for c in range(3):
        weighted = shrink(np.ascontiguousarray(colour[..., c]))
        out[..., c] = np.where(a > 0, weighted / np.maximum(a, 1e-6), 0)
    out[..., 3] = a * 255
    out = np.clip(np.round(out), 0, 255).astype(np.uint8)

    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    canvas.paste(Image.fromarray(out, "RGBA"), ((CANVAS_W - w) // 2, MARGIN))
    return canvas


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else OUT
    rgb, pin = cut(UPLOAD)
    ys, xs = np.nonzero(pin)
    print("pin %dx%d at %d,%d of %dx%d" % (
        xs.max() - xs.min() + 1, ys.max() - ys.min() + 1, xs.min(), ys.min(),
        rgb.shape[1], rgb.shape[0]))
    canvas = compose(rgb, pin)
    canvas.save(out, optimize=True)
    print("wrote %s %dx%d" % (out, *canvas.size))


if __name__ == "__main__":
    main()
