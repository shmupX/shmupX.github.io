#!/usr/bin/env python3
"""The gs cloud game's title backdrop: the gold 2028 plate, reading 869.

A custom game that brought no backdrop of its own scrolls rando's gold 2028
(static/games/2028-ai/assets/img/titleBgCustom.jpg): outlined varsity
numerals embossed on a grained gold plate, in rows tilted 25.5 degrees. This
draws the same plate reading "869", in the same gold, emboss, size, angle
and spacing, as a tile that repeats exactly every TILE_W pixels across, so
the title's sideways scroll never shows a seam. (The 2028 plate's own 768 is
not a period of its pattern, and it shows one at every wrap.)

    python3 scripts/gs/draw_869_backdrop.py [out.jpg]

writes scripts/gs/art/titleBg869.jpg by default, 845x480: as tall as the
title screen, and three of the pattern's rows across. title-backdrop.ts puts
it on the gs level. Needs numpy, scipy and Pillow. Deterministic: the grain
has a fixed seed.

Nothing is drawn by hand; everything is measured off the 2028 plate:

1. Turn the plate so its rows run level, find its fifteen "2028"s by
   template matching, fit their lattice, register each one to the others to
   a fraction of a pixel, and average them at 4x.
2. Trace the glyph outlines and fit the emboss as a linear kernel that turns
   an outline into the plate's highlight and shadow: deconvolve with the
   kernel, trace again, refit, until the outlines settle.
3. The 8 is the plate's own 8. The 6 is its 0 with the 8's lower counter, the
   upper right opened, and the 2's top terminal mirrored onto it; the 9 is
   the 6 turned half round.
4. Set "869" on 2028's digit pitch and rise, the words on 2028's row spacing
   and word gap, with the row stagger that closes the lattice three rows
   across TILE_W. Draw the outlines with the kernel, onto the plate's own
   vertical shading and a grain matched to it, periodic across the tile.
"""

import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as nd
from scipy.signal import fftconvolve

HERE = os.path.dirname(os.path.abspath(__file__))
PLATE = os.path.join(HERE, "..", "..", "static", "games", "2028-ai", "assets", "img", "titleBgCustom.jpg")
OUT = os.path.join(HERE, "art", "titleBg869.jpg")

ANGLE = 25.5        # the rows' tilt, degrees anticlockwise
SC = 4              # supersampling of the word boxes
TILE_H = 480        # GAME_DIMENSIONS.HEIGHT: every row the title shows
SEED = 869


# ---- 1. the plate's 2028s, averaged ----------------------------------------

def level_plate(path):
    """The plate turned so its rows run level, and where it has pixels."""
    im = Image.open(path).convert("RGB")
    rot = np.asarray(im.rotate(-ANGLE, resample=Image.BICUBIC, expand=True)).astype(float)
    valid = np.asarray(Image.new("L", im.size, 255).rotate(-ANGLE, resample=Image.NEAREST, expand=True)) > 0
    return rot, nd.binary_erosion(valid, iterations=3)


def find_words(rot, valid):
    """Every 2028 on the level plate, by matching one of them."""
    g = rot.mean(2)
    hp = g - nd.gaussian_filter(g, 5)
    hp[~valid] = 0
    y0, y1, x0, x1 = 280, 375, 190, 425       # one whole word
    tpl = hp[y0:y1, x0:x1].copy()
    tpl -= tpl.mean()
    cc = fftconvolve(hp, tpl[::-1, ::-1], mode="same")
    with np.errstate(invalid="ignore"):
        norm = np.sqrt(fftconvolve(hp ** 2, np.ones_like(tpl), mode="same")) + 1e-6
    ncc = cc / norm / np.sqrt((tpl ** 2).sum())
    peaks = np.argwhere((ncc == nd.maximum_filter(ncc, size=60)) & (ncc > 0.5))
    # sub-pixel, by a parabola through each peak's neighbours
    ref = []
    for y, x in peaks:
        c = cc[y - 1:y + 2, x - 1:x + 2]
        dx = 0.5 * (c[1, 0] - c[1, 2]) / (c[1, 0] - 2 * c[1, 1] + c[1, 2])
        dy = 0.5 * (c[0, 1] - c[2, 1]) / (c[0, 1] - 2 * c[1, 1] + c[2, 1])
        ref.append((y + dy, x + dx))
    ref = np.array(ref)
    # the lattice: word i of row j at origin + i*P + j*Q
    rows = np.round((ref[:, 0] - 206) / 121.3).astype(int)
    cols = np.round((ref[:, 1] - 302 - 4.6 * rows) / 249).astype(int)
    X = np.stack([np.ones(len(ref)), cols, rows], 1)
    sol_y = np.linalg.lstsq(X, ref[:, 0], rcond=None)[0]
    sol_x = np.linalg.lstsq(X, ref[:, 1], rcond=None)[0]
    return np.stack([X @ sol_y, X @ sol_x], 1), sol_x, sol_y


HH, WW = 95, 235    # the template box
OY, OX = np.meshgrid(np.arange(-HH / 2 - 10, HH / 2 + 10, 1 / SC),
                     np.arange(-WW / 2 - 10, WW / 2 + 10, 1 / SC), indexing="ij")


def word_at(rot, valid, centre):
    yy, xx = OY + centre[0], OX + centre[1]
    m = (nd.map_coordinates(valid.astype(float), [yy, xx], order=1, mode="constant") > 0.999).astype(float)
    img = np.stack([nd.map_coordinates(rot[..., c], [yy, xx], order=3, mode="nearest") for c in range(3)], -1)
    return img, m


def average(rot, valid, centres):
    acc = np.zeros(OY.shape + (3,))
    w = np.zeros(OY.shape)
    for c in centres:
        img, m = word_at(rot, valid, c)
        acc += img * m[..., None]
        w += m
    return acc / np.maximum(w, 1e-6)[..., None]


def registered_average(rot, valid, centres):
    """Each word moved onto the average, the average taken again; thrice."""
    def hp(a):
        g = a.mean(2)
        return g - nd.gaussian_filter(g, 12)
    avg = average(rot, valid, centres)
    shifts = np.zeros((len(centres), 2))
    for _ in range(3):
        ref = hp(avg)
        for k in range(len(centres)):
            img, m = word_at(rot, valid, centres[k] + shifts[k])
            h, rr = hp(img) * m, ref * m
            cc = np.fft.fftshift(np.real(np.fft.ifft2(np.fft.fft2(rr) * np.conj(np.fft.fft2(h)))))
            cy, cx = np.array(cc.shape) // 2
            win = cc[cy - 12:cy + 13, cx - 12:cx + 13]
            py, px = np.unravel_index(win.argmax(), win.shape)
            py += cy - 12
            px += cx - 12
            c = cc[py - 1:py + 2, px - 1:px + 2]
            dx = 0.5 * (c[1, 0] - c[1, 2]) / (c[1, 0] - 2 * c[1, 1] + c[1, 2])
            dy = 0.5 * (c[0, 1] - c[2, 1]) / (c[0, 1] - 2 * c[1, 1] + c[2, 1])
            shifts[k] -= [(py + dy - cy) / SC, (px + dx - cx) / SC]
        shifts -= shifts.mean(0)
        avg = average(rot, valid, centres + shifts)
    return avg


# ---- 2. outlines and the emboss --------------------------------------------

def split_band(band, reach):
    """
    The glyphs inside a closed outline band: the regions it encloses that lie
    within `reach` of the outside are bodies, the rest counters, and the band
    is shared between them down its middle.
    """
    lab, _ = nd.label(~band)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    outside = np.isin(lab, list(border))
    lab2, n2 = nd.label(~outside & ~band)
    body = np.zeros_like(band)
    counter = np.zeros_like(band)
    for i in range(1, n2 + 1):
        reg = lab2 == i
        if reg.sum() < 200:
            continue
        if (nd.binary_dilation(reg, iterations=reach) & outside).any():
            body |= reg
        else:
            counter |= reg
    db = nd.distance_transform_edt(~body)
    dn = nd.distance_transform_edt(~(outside | counter))
    return body | (band & (db < dn))


def first_trace(avg):
    """The glyphs, as the band the emboss covers, split down its middle."""
    L = avg.mean(2)
    band = nd.gaussian_filter(np.abs(L - np.median(L)), 3) > 9
    return split_band(nd.binary_closing(band, iterations=2), 30)


def line(mask, s=1.0):
    """An outline: the gradient magnitude of the softened mask."""
    m = nd.gaussian_filter(mask.astype(float), s)
    gy, gx = np.gradient(m)
    return np.hypot(gx, gy)


def fit_emboss(avg, G):
    """Outlines and the emboss kernel K, refined together."""
    bg = np.median(avg.reshape(-1, 3), 0)
    Y = avg - bg
    H, W = G.shape
    PH, PW = H + 128, W + 128

    def pad(a):
        o = np.zeros((PH, PW))
        o[64:64 + H, 64:64 + W] = a
        return o

    def fitK(X, lamf=1e-5, r=44):
        Xf = np.fft.fft2(pad(X))
        lam = lamf * np.abs(Xf).max() ** 2
        K = []
        for c in range(3):
            Yf = np.fft.fft2(pad(Y[..., c]))
            k = np.fft.fftshift(np.real(np.fft.ifft2(Yf * np.conj(Xf) / (np.abs(Xf) ** 2 + lam))))
            K.append(k[PH // 2 - r:PH // 2 + r + 1, PW // 2 - r:PW // 2 + r + 1])
        return np.stack(K, -1)

    def deconv(K, lamf=3e-3):
        num = 0
        den = 0
        r = K.shape[0] // 2
        for c in range(3):
            kp = np.zeros((PH, PW))
            kp[:2 * r + 1, :2 * r + 1] = K[..., c]
            kp = np.roll(kp, (-r, -r), (0, 1))
            Kf = np.fft.fft2(kp)
            num = num + np.fft.fft2(pad(Y[..., c])) * np.conj(Kf)
            den = den + np.abs(Kf) ** 2
        x = np.real(np.fft.ifft2(num / (den + lamf * den.max())))
        return x[64:64 + H, 64:64 + W]

    for _ in range(4):
        K = fitK(line(G))
        xe = nd.gaussian_filter(deconv(K), 1.0)
        G = split_band(nd.binary_closing(xe > np.percentile(xe, 90), iterations=1), 40)
    return G, K, Y


# ---- 3. the glyphs -----------------------------------------------------------

def bbox(m):
    ys, xs = np.where(m)
    return ys.min(), ys.max(), xs.min(), xs.max()


def disk(r):
    return np.hypot(*np.mgrid[-r:r + 1, -r:r + 1]) <= r


def glyphs(G):
    """8, 6 and 9 as masks, each cropped to its box (4x)."""
    def take(x0, x1):
        m = np.zeros_like(G)
        m[:, x0:x1] = G[:, x0:x1]
        return m
    g8 = take(728, 940)
    g0 = take(288, 500)
    H4, W4 = G.shape
    yy, xx = np.mgrid[0:H4, 0:W4]
    # the 0: counter x 360..428, y 142..334; right edge 489
    cl, cr, ct, cb = 360, 428, 142, 334
    spur_bot = ct + 38      # the 2's top terminal drops 38 below its bar
    mt = 203                # the 6's middle bar, a stroke above the counter
    ch = 40                 # the 0's corner chamfer
    xr = 489
    S0 = nd.binary_fill_holes(g0)
    # the 8's lower counter, centred on the 0's and sitting on its floor
    f8 = nd.binary_fill_holes(g8) & ~g8
    lab, n = nd.label(f8)
    cnts = [lab == i for i in range(1, n + 1) if (lab == i).sum() > 500]
    low = max(cnts, key=lambda m: bbox(m)[0])
    ly0, ly1, lx0, lx1 = bbox(low)
    lowc = nd.shift(low.astype(float), (cb - ly1, round((cl + cr) / 2 - (lx0 + lx1) / 2)), order=0) > 0.5
    notch = (xx >= cl) & (yy >= ct) & (yy <= mt)
    notch |= (xx >= xr - ch) & (yy >= ct) & (yy - mt <= (xx - (xr - ch)))
    spur = (xx >= cr) & (yy >= ct) & (yy <= spur_bot)
    notch &= ~spur
    notch = nd.binary_opening(notch, structure=disk(10))    # rounded, as counters
    g6 = S0 & ~lowc & ~notch
    near_spur = (xx >= cr - 20) & (yy >= spur_bot - 20) & (yy <= spur_bot + 20)
    g6 = np.where(near_spur, nd.binary_opening(g6, structure=disk(5)), g6)
    g6 &= (xx >= 285) & (xx <= 500)
    y0, y1, x0, x1 = bbox(g6)
    crop6 = g6[y0:y1 + 1, x0:x1 + 1]
    y0, y1, x0, x1 = bbox(g8)
    crop8 = g8[y0:y1 + 1, x0:x1 + 1]
    return crop8, crop6, crop6[::-1, ::-1]


# ---- 4. the tile -------------------------------------------------------------

PITCH = 222.5       # 4x, digit to digit, as 2028's
RISE = -6.33        # 4x, each digit sits that much higher than the last
WORD_P = 992.8      # 4x, 2028's word period along the row
ROW_R = 121.22      # 1x, 2028's row spacing
WH, WW4 = 460, 820  # the word box (4x), the lattice point at its centre
WCY, WCX = 230, 410


def word_relief(digits, K, fillc):
    word = np.zeros((WH, WW4), bool)
    for k, crop in enumerate(digits):
        cx = WCX + (k - 1) * PITCH - 10.1
        cy = WCY + 6.4 + (k - 1) * RISE
        h, w = crop.shape
        oy, ox = int(round(cy - (h - 1) / 2)), int(round(cx - (w - 1) / 2))
        word[oy:oy + h, ox:ox + w] |= crop
    X = line(word)
    relief = np.stack([fftconvolve(X, K[..., c], mode="same") for c in range(3)], -1)
    return relief + nd.gaussian_filter(word.astype(float), 4)[..., None] * fillc


def tile(relief, plate_path):
    th = np.radians(ANGLE)
    P = (2 * PITCH + (WORD_P - 3 * PITCH)) / SC     # 869's word period, 1x
    TW = int(round(3 * ROW_R / np.sin(th)))         # three rows across
    R = TW * np.sin(th) / 3
    s = (TW * np.cos(th) - 4 * P) / 3               # the stagger that closes it
    eu = np.array([np.cos(th), -np.sin(th)])
    ev = np.array([np.sin(th), np.cos(th)])
    py, px = np.mgrid[0:TILE_H, 0:TW].astype(float)
    px += 0.5
    py += 0.5
    U = px * eu[0] + py * eu[1]
    V = px * ev[0] + py * ev[1]
    O = np.array([40.0, 60.0])
    out = np.zeros((TILE_H, TW, 3))
    j0 = np.floor((V - O[1]) / R).astype(int)
    for dj in (-1, 0, 1, 2):
        j = j0 + dj
        i0 = np.floor((U - O[0] - j * s) / P).astype(int)
        for di in (-1, 0, 1, 2):
            i = i0 + di
            r = WCY + (V - (O[1] + j * R)) * SC
            c = WCX + (U - (O[0] + i * P + j * s)) * SC
            inside = (r >= 0) & (r <= WH - 1) & (c >= 0) & (c <= WW4 - 1)
            for ch in range(3):
                smp = nd.map_coordinates(relief[..., ch], [r, c], order=3, mode="constant", cval=0.0)
                out[..., ch] += np.where(inside, smp, 0.0)
    # the plate: its own top-to-bottom shading, measured between the numerals
    src = np.asarray(Image.open(plate_path).convert("RGB")).astype(float)
    g = src.mean(2)
    E = nd.gaussian_filter(np.abs(g - nd.gaussian_filter(g, 4)), 3)
    blank = nd.binary_erosion(E < np.percentile(E, 25), iterations=3).astype(float)
    prof = np.zeros((TILE_H, 3))
    for c in range(3):
        num = nd.gaussian_filter1d((src[..., c] * blank).sum(1), 25, mode="nearest")
        den = nd.gaussian_filter1d(blank.sum(1), 25, mode="nearest")
        prof[:, c] = num / np.maximum(den, 1e-3)
    # and its grain, wrapped so the tile's edges meet
    rng = np.random.default_rng(SEED)

    def grain():
        return nd.gaussian_filter(rng.standard_normal((TILE_H, TW)), 0.55, mode="wrap")
    lum = grain()
    lum *= 2.9 / lum.std()
    chroma = np.stack([grain() for _ in range(3)], -1)
    chroma *= 0.55 / chroma.std()
    img = prof[:, None, :] + out + lum[..., None] + chroma
    return np.clip(np.round(img), 0, 255).astype(np.uint8), TW, P, R, s


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else OUT
    rot, valid = level_plate(PLATE)
    centres, _, _ = find_words(rot, valid)
    first = average(rot, valid, centres)
    avg = registered_average(rot, valid, centres)
    G, K, Y = fit_emboss(avg, first_trace(first))
    # the glyph fill: ~2 levels under the plate, a scalar per channel
    X = line(G)
    pred = np.stack([fftconvolve(X, K[..., c], mode="same") for c in range(3)], -1)
    Mb = nd.gaussian_filter(G.astype(float), 4)
    fillc = np.array([(Mb * (Y[..., c] - pred[..., c])).sum() / (Mb * Mb).sum() for c in range(3)])
    relief = word_relief(glyphs(G), K, fillc)
    img, TW, P, R, s = tile(relief, PLATE)
    Image.fromarray(img).save(out_path, quality=95, subsampling=2, optimize=True)
    print(f"{out_path}: {TW}x{TILE_H}, {len(centres)} words measured, "
          f"word period {P:.3f}, rows {R:.3f} apart, stagger {s:.3f}")


if __name__ == "__main__":
    main()
