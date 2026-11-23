#!/usr/bin/env python3
"""Daltonius, the gs cloud game's stage-2 boss, drawn from a whiteboard doodle.

A marker drawing of a grinning, bearded office boss (topknot, wild hair, big
toothy grin, a "DMP" name badge, oval arms and legs) is redrawn here as pixel
art and posed on Akuma's frame set, one frame for each of his: idle x2,
shootA x3, shootB x5, syungoku x3 (the Ashura warp), syungoku_finish and
syungoku_finish_ten. The shootB frames are 128 wide, as Akuma's are, and the
rest 96; every frame is 128 tall with the figure on the same centre line, so
the boss does not jump between poses.

It also draws the "I'm Fired!!!" speech balloon from the same whiteboard as
three blink frames: the record's own danger balloon (`dangerBalloon`),
which takes the place of the stock skull once one bomb would finish him.

    python3 scripts/gs/draw_daltonius.py [out_dir]

writes Daltonius_<pose>.png and Daltonius_fired<0..2>.png into out_dir
(default scripts/gs/art). Needs numpy and Pillow. The output is
deterministic: the stubble and beard speckle use fixed seeds.
"""

import math
import os
import sys

import numpy as np
from PIL import Image

INK = (22, 34, 118, 255)       # blue marker
INK_DK = (10, 14, 58, 255)     # dense marker (beard, mouth, pupils)
INK_LT = (70, 96, 186, 255)    # light strokes (stubble, hair)
FILL = (240, 240, 232, 255)    # whiteboard
SHADE = (198, 202, 212, 255)
TOOTH = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)


class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = np.zeros((h, w, 4), dtype=np.uint8)
        ys, xs = np.mgrid[0:h, 0:w]
        self.X = xs + 0.5
        self.Y = ys + 0.5

    clip = None

    def put(self, mask, color):
        self.px[mask] = color

    def dot(self, x, y, color):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < self.w and 0 <= y < self.h:
            if self.clip is not None and not self.clip[y, x]:
                return
            self.px[y, x] = color

    def line(self, x0, y0, x1, y1, color):
        x0, y0, x1, y1 = (int(round(v)) for v in (x0, y0, x1, y1))
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err = dx + dy
        while True:
            self.dot(x0, y0, color)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def poly(self, pts, color):
        for (a, b) in zip(pts, pts[1:]):
            self.line(a[0], a[1], b[0], b[1], color)

    def image(self):
        return Image.fromarray(self.px, "RGBA")


def ellipse(c, cx, cy, rx, ry, ang=0.0):
    ca, sa = math.cos(ang), math.sin(ang)
    dx, dy = c.X - cx, c.Y - cy
    u = dx * ca + dy * sa
    v = -dx * sa + dy * ca
    return (u / rx) ** 2 + (v / ry) ** 2 <= 1.0


def polygon(c, pts):
    """Even-odd fill of a polygon, sampled at pixel centres."""
    inside = np.zeros((c.h, c.w), dtype=bool)
    n = len(pts)
    for i in range(n):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % n]
        if y0 == y1:
            continue
        cond = ((c.Y >= min(y0, y1)) & (c.Y < max(y0, y1)))
        xi = x0 + (c.Y - y0) * (x1 - x0) / (y1 - y0)
        inside ^= cond & (c.X < xi)
    return inside


def edge(mask):
    """Pixels of mask with a 4-neighbour outside it."""
    m = np.pad(mask, 1)
    inner = m[1:-1, 1:-1] & m[:-2, 1:-1] & m[2:, 1:-1] & m[1:-1, :-2] & m[1:-1, 2:]
    return mask & ~inner


def shift(mask, dx, dy):
    out = np.zeros_like(mask)
    h, w = mask.shape
    xs = slice(max(dx, 0), w + min(dx, 0))
    xd = slice(max(-dx, 0), w + min(-dx, 0))
    ys = slice(max(dy, 0), h + min(dy, 0))
    yd = slice(max(-dy, 0), h + min(-dy, 0))
    out[ys, xs] = mask[yd, xd]
    return out


def blob(c, mask, fill=FILL, line=INK, shade=True):
    """Paint a solid part: fill, a bottom-right shade rim, a marker outline."""
    c.put(mask, fill)
    if shade:
        rim = mask & ~shift(mask, -2, -2)
        c.put(rim, SHADE)
    c.put(edge(mask), line)
    return mask


# --- the boss ---------------------------------------------------------------

GLOW_RAM = [(40, 200, 90, 110), (150, 255, 170, 200), (235, 255, 235, 255)]
AURA = [(255, 150, 40, 255), (220, 30, 30, 255)]
RED = (220, 30, 30, 255)


def arm_shape(c, sx, sy, ang_deg, length=15.0, width=4.6):
    """An oval arm hung from a shoulder, pointing along ang (0 = right, 90 = down)."""
    a = math.radians(ang_deg)
    cx = sx + math.cos(a) * length * 0.82
    cy = sy + math.sin(a) * length * 0.82
    hand = (sx + math.cos(a) * length * 1.7, sy + math.sin(a) * length * 1.7)
    return ellipse(c, cx, cy, length, width, a), hand


def glow(c, x, y, colors, r=6):
    for i, col in enumerate(colors):
        rr = r * (1 - i / len(colors))
        m = ellipse(c, x, y, rr, rr)
        alpha = col[3] / 255.0
        base = c.px[m].astype(float)
        src = np.array(col[:3], dtype=float)
        a0 = base[:, 3:4] / 255.0
        out_rgb = src * alpha + base[:, :3] * (1 - alpha) * (a0 > 0) + src * (1 - alpha) * (a0 == 0)
        out_a = np.maximum(base[:, 3], col[3])
        c.px[m, :3] = out_rgb.astype(np.uint8)
        c.px[m, 3] = out_a.astype(np.uint8)


def head(c, hx, hy, back=False, mouth_open=0):
    # ears and topknot sit behind the head's outline
    blob(c, ellipse(c, hx - 23.5, hy - 2.5, 3.9, 4.6))
    blob(c, ellipse(c, hx + 23.0, hy - 5.0, 3.9, 4.6))
    knot = polygon(c, [(hx - 7, hy - 35), (hx - 3, hy - 40), (hx + 2, hy - 37),
                       (hx + 1, hy - 31), (hx + 3, hy - 25), (hx - 5, hy - 24), (hx - 9, hy - 29)])
    blob(c, knot)
    c.line(hx - 5, hy - 33, hx - 1, hy - 34, INK)
    c.line(hx - 1, hy - 34, hx - 1, hy - 30, INK)
    if back:
        blob(c, polygon(c, [(hx - 8, hy + 18), (hx + 8, hy + 18), (hx + 8, hy + 30), (hx - 8, hy + 30)]))
    h = blob(c, ellipse(c, hx, hy, 22.5, 25.0))
    if back:
        c.clip = h & ~edge(h)
        # the back of his head: strands all over, no face
        wx, wy = hx + 1, hy - 14
        c.poly([(wx, wy), (wx + 2, wy - 1), (wx + 3, wy + 1), (wx + 1, wy + 3), (wx - 2, wy + 2), (wx - 3, wy - 1), (wx - 1, wy - 4), (wx + 3, wy - 4)], INK)
        for ang in range(0, 360, 30):
            a = math.radians(ang)
            r0, r1 = 6, 13 + (ang % 60) / 12
            c.line(wx + math.cos(a) * r0, wy + math.sin(a) * r0 * 0.9,
                   wx + math.cos(a + 0.35) * r1, wy + math.sin(a + 0.35) * r1 * 0.9, INK_LT)
        for x in range(-16, 18, 5):
            c.line(hx + x, hy + 4, hx + x * 1.1, hy + 14 - abs(x) * 0.2, INK_LT)
        c.clip = None
        return h
    # hair strands across the crown
    strands = [(-15, -16, -18, -9), (-12, -20, -13, -12), (-8, -22, -10, -15), (-5, -23, -3, -16),
               (-1, -24, -2, -19), (2, -24, 5, -18), (6, -23, 4, -15), (9, -21, 12, -15),
               (12, -19, 16, -12), (16, -15, 18, -10), (-10, -15, -6, -13), (7, -15, 10, -13)]
    for x0, y0, x1, y1 in strands:
        c.line(hx + x0, hy + y0, hx + x1, hy + y1, INK)
    # eyes: the left smaller, the right wide, as drawn
    blob(c, ellipse(c, hx - 9.0, hy - 3.0, 4.6, 5.6), fill=TOOTH, shade=False)
    blob(c, ellipse(c, hx + 7.5, hy - 4.5, 5.6, 6.6), fill=TOOTH, shade=False)
    c.put(ellipse(c, hx - 8.0, hy - 2.5, 1.3, 1.6), INK_DK)
    c.put(ellipse(c, hx + 7.5, hy - 3.5, 1.5, 1.8), INK_DK)
    # nose: a little U
    c.poly([(hx - 1.5, hy + 2), (hx - 1.5, hy + 4), (hx - 0.5, hy + 5), (hx + 1, hy + 5), (hx + 2, hy + 3)], INK)
    # the grin: wide, wavy top lip, dark inside, a row of teeth
    my = hy + 9
    mouth = polygon(c, [(hx - 13, my - 1), (hx - 8, my + 1), (hx - 3, my), (hx + 3, my + 1), (hx + 8, my - 1),
                        (hx + 13, my - 3), (hx + 10, my + 4 + mouth_open * 0.5), (hx + 4, my + 8 + mouth_open),
                        (hx - 4, my + 8 + mouth_open), (hx - 10, my + 5 + mouth_open * 0.5)])
    c.put(mouth, INK_DK)
    for tx in range(-10, 12, 3):
        top = my + (0 if abs(tx) < 9 else -1)
        c.put(polygon(c, [(hx + tx - 1, top), (hx + tx + 2, top), (hx + tx + 0.5, top + 3)]), TOOTH)
    c.put(edge(mouth), INK)
    # stubble along the jaw
    rng = np.random.default_rng(7)
    for _ in range(26):
        ang = rng.uniform(0.15, math.pi - 0.15)
        rr = rng.uniform(0.70, 0.93)
        x = hx + math.cos(ang) * 22.5 * rr
        y = hy + math.sin(ang) * 25.0 * rr
        if mouth[int(y), int(x)]:
            continue
        c.dot(x, y, INK_LT)
    return h


def beard(c, hx, hy):
    pts = [(hx - 15, hy + 15), (hx - 10, hy + 19), (hx - 4, hy + 19), (hx + 3, hy + 19), (hx + 9, hy + 17),
           (hx + 15, hy + 12), (hx + 15, hy + 20), (hx + 12, hy + 27), (hx + 9, hy + 25), (hx + 7, hy + 32),
           (hx + 3, hy + 28), (hx, hy + 34), (hx - 3, hy + 29), (hx - 6, hy + 33), (hx - 9, hy + 27),
           (hx - 12, hy + 29), (hx - 14, hy + 22)]
    m = polygon(c, pts)
    c.put(m, INK_DK)
    rng = np.random.default_rng(3)
    ys, xs = np.nonzero(m)
    for i in rng.choice(len(xs), size=max(1, len(xs) // 9), replace=False):
        c.dot(xs[i], ys[i], INK)


def torso(c, tx, ty, back=False, letters=False):
    t = blob(c, ellipse(c, tx, ty, 18.5, 17.5))
    # belt with its buckle
    belt = t & (c.Y > ty + 2) & (c.Y < ty + 4.2)
    c.put(belt, INK)
    if not back:
        c.put(polygon(c, [(tx - 6, ty + 1.5), (tx - 1, ty + 1.5), (tx - 1, ty + 5.5), (tx - 6, ty + 5.5)]), FILL)
        c.poly([(tx - 6, ty + 1.5), (tx - 1, ty + 1.5), (tx - 1, ty + 5.5), (tx - 6, ty + 5.5), (tx - 6, ty + 1.5)], INK)
        # the name badge, lettered DMP as on the whiteboard
        bx, by = tx + 1, ty - 12.5
        c.put(polygon(c, [(bx, by), (bx + 17, by), (bx + 17, by + 8), (bx, by + 8)]), TOOTH)
        c.poly([(bx, by), (bx + 16, by), (bx + 16, by + 7), (bx, by + 7), (bx, by)], INK)
        font = {"D": ["XX.", "X.X", "X.X", "XX."], "M": ["X...X", "XX.XX", "X.X.X", "X...X"], "P": ["XX.", "X.X", "XX.", "X.."]}
        gx0 = int(bx) + 2
        for ch in "DMP":
            for gy, row in enumerate(font[ch]):
                for gx, on in enumerate(row):
                    if on == "X":
                        c.dot(gx0 + gx, int(by) + 2 + gy, INK)
            gx0 += len(font[ch][0]) + 1
        # the shirt's lower seam
        c.line(tx - 14, ty + 9, tx - 8, ty + 11, INK_LT)
    if letters:
        # "LOL" on his back, where Akuma wears his kanji
        L = ["X..", "X..", "X..", "X..", "XXX"]
        O = ["XXX", "X.X", "X.X", "X.X", "XXX"]
        x0, y0 = int(tx) - 10, int(ty) - 13
        for glyph, gx in ((L, 0), (O, 7), (L, 14)):
            for gy, row in enumerate(glyph):
                for gxx, ch in enumerate(row):
                    if ch == "X":
                        for dx in (0, 1):
                            for dy in (0, 1):
                                c.dot(x0 + gx + gxx * 2 + dx, y0 + gy * 2 + dy, RED)
    return t


def leg(c, x, y, ry=8.5, rx=4.6, ang=0.0):
    return blob(c, ellipse(c, x, y, rx, ry, math.radians(ang)))


def aura(c, colors):
    sil = c.px[..., 3] > 0
    ring1 = np.zeros_like(sil)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ring1 |= shift(sil, dx, dy)
    ring1 &= ~sil
    ring2 = np.zeros_like(sil)
    grown = sil | ring1
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ring2 |= shift(grown, dx, dy)
    ring2 &= ~grown
    c.put(ring2, colors[0])
    c.put(ring1, colors[1])


POSES = {}


def pose(name, w=96, **kw):
    POSES[name] = dict(w=w, **kw)


# Akuma's frames, one for one: idle x2, shootA x3, shootB x5, syungoku x3, finish, finish_ten
pose("idle0", armR=-57, armL=118)
pose("idle1", armR=-42, armL=112, bob=1)
pose("shootA0", armR=-78, armL=130, bob=2, crouch=1, armRLen=13)
pose("shootA1", armR=-62, armL=135, bob=3, crouch=2, armRLen=14, glowR=GLOW_RAM)
pose("shootA2", armR=62, armL=140, bob=2, crouch=1, armRLen=16, mouth=3, lean=1, glowR=GLOW_RAM[1:])
pose("shootB0", w=128, armR=-52, armL=-128, bob=2, crouch=1, aura=True)
pose("shootB1", w=128, armR=-45, armL=-135, bob=3, crouch=2, aura=True, auraAlt=True)
pose("shootB2", w=128, armR=30, armL=150, bob=1, crouch=1, mouth=3, armRLen=17, armLLen=17)
pose("shootB3", w=128, armR=22, armL=158, bob=0, crouch=1, mouth=4, armRLen=19, armLLen=19)
pose("shootB4", w=128, armR=55, armL=125, bob=1, mouth=1)
pose("syungoku0", armR=96, armL=84, together=True, ghost=6)
pose("syungoku1", armR=100, armL=80, together=True, ghost=-6, lean=1)
pose("syungoku2", armR=92, armL=88, together=True, ghost=9, lean=-1)
pose("syungoku_finish", w=96, armR=80, armL=100, back=True)
pose("syungoku_finish_ten", w=96, armR=80, armL=100, back=True, letters=True)


def render(name, ghosted=False):
    p = POSES[name]
    w = p["w"]
    c = Canvas(w, 128)
    cx = w // 2 + p.get("lean", 0)
    bob = p.get("bob", 0)
    crouch = p.get("crouch", 0)
    hx, hy = cx, 44.5 + bob
    tx, ty = cx - 3, 89.0 + bob
    back = p.get("back", False)
    sR = (tx + 16, ty - 4) if not back else (tx - 14, ty - 4)
    sL = (tx - 14, ty - 6) if not back else (tx + 16, ty - 4)
    lenR = p.get("armRLen", 15.0)
    lenL = p.get("armLLen", 12.0)
    armR = p["armR"] if not back else 180 - p["armR"]
    armL = p["armL"] if not back else 180 - p["armL"]
    legs_ry = 8.5 - crouch
    if p.get("together"):
        leg(c, tx - 4, 112 + crouch, legs_ry, 4.4, 6)
        leg(c, tx + 5, 112 + crouch, legs_ry, 4.4, -6)
    else:
        spread = crouch * 1.5
        leg(c, tx - 10 - spread, 112.5 + crouch, legs_ry, 4.6, 8 * (crouch > 0))
        leg(c, tx + 12 + spread, 112 + crouch, legs_ry, 4.6, -8 * (crouch > 0))
    torso(c, tx, ty, back=back, letters=p.get("letters", False))
    head(c, hx, hy, back=back, mouth_open=p.get("mouth", 0))
    if not back:
        beard(c, hx, hy)
    mR, handR = arm_shape(c, sR[0], sR[1], armR, lenR)
    blob(c, mR)
    mL, handL = arm_shape(c, sL[0], sL[1], armL, lenL, 4.2)
    blob(c, mL)
    if p.get("glowR"):
        glow(c, handR[0], handR[1], p["glowR"], r=6)
    if p.get("aura"):
        aura(c, AURA if not p.get("auraAlt") else AURA[::-1])
    img = c.image()
    if p.get("ghost") and not ghosted:
        base = Image.new("RGBA", img.size, (0, 0, 0, 0))
        g = render(name, ghosted=True)
        ga = np.asarray(g).copy()
        ga[..., :3] = (ga[..., :3] * 0.4 + np.array([60, 90, 220]) * 0.6).astype(np.uint8)
        ga[..., 3] = (ga[..., 3] * 0.45).astype(np.uint8)
        gimg = Image.fromarray(ga, "RGBA")
        base.alpha_composite(gimg, (p["ghost"], 0))
        base.alpha_composite(img)
        img = base
    return img


# --- the death scene ---------------------------------------------------------
#
# When his HP runs out he does not explode: he swells up (bulge0-2), froths at
# the mouth (froth0-2), lets it all out in three toots that let him down
# (toot0-3) and ends as an empty suit on the floor (flat). Every frame is
# 128x128 with his feet on the same line as the poses above, so the scene can
# swap them in place; the toots carry their own gas cloud.

FLUSH = (250, 206, 206, 255)    # a face going red
FLUSH_SH = (222, 160, 168, 255)
GAS = (168, 204, 70, 255)       # the cloud
GAS_SH = (124, 160, 44, 255)
GAS_INK = (60, 96, 22, 255)
FOAM_LINE = (150, 170, 205, 255)
VEIN = (214, 40, 52, 255)
TONGUE = (226, 92, 120, 255)


def s_ellipse(c, cx, cy, rx, ry, s, ang=0.0):
    return ellipse(c, cx, cy, rx * s, ry * s, ang)


def death_eyes(c, hx, hy, s, kind, size):
    """Both eyes, left smaller as drawn, in one of the death scene's states."""
    eyes = ((hx - 9.0 * s, hy - 3.0 * s, 4.6, 5.6), (hx + 7.5 * s, hy - 4.5 * s, 5.6, 6.6))
    for i, (ex, ey, rx, ry) in enumerate(eyes):
        rx, ry = rx * size, ry * size
        if kind in ("shut", "x", "spiral"):
            r = 3.2 * size if kind != "shut" else 3.6 * size
            if kind == "shut":
                # squeezed shut: a > and a <, pointing at the nose
                d = 1 if i == 0 else -1
                c.poly([(ex - d * r, ey - r * 0.8), (ex + d * r * 0.6, ey), (ex - d * r, ey + r * 0.8)], INK_DK)
                c.poly([(ex - d * r + d, ey - r * 0.8), (ex + d * r * 0.6 + d, ey), (ex - d * r + d, ey + r * 0.8)], INK_DK)
            elif kind == "x":
                for dx in (0, 1):
                    c.line(ex - r + dx, ey - r, ex + r + dx, ey + r, INK_DK)
                    c.line(ex - r + dx, ey + r, ex + r + dx, ey - r, INK_DK)
            else:
                # dazed: a little spiral, wound the other way in each eye
                pts = []
                for k in range(0, 40):
                    a = k * 0.42 * (1 if i == 0 else -1)
                    rr = 0.4 + k * r / 40.0
                    pts.append((ex + math.cos(a) * rr, ey + math.sin(a) * rr))
                c.poly(pts, INK_DK)
            continue
        ball = ellipse(c, ex, ey, rx, ry)
        blob(c, ball, fill=TOOTH, shade=False)
        if kind == "bulge":
            # bloodshot: a few red veins creeping in from the rim
            for a in (0.4, 1.9, 3.3, 4.6):
                x0, y0 = ex + math.cos(a) * rx * 0.92, ey + math.sin(a) * ry * 0.92
                x1, y1 = ex + math.cos(a + 0.3) * rx * 0.55, ey + math.sin(a + 0.3) * ry * 0.55
                c.line(x0, y0, x1, y1, VEIN)
            c.put(ellipse(c, ex + 0.5, ey + 0.5, 1.2, 1.2), INK_DK)
        elif kind == "roll":
            # rolled back: only the bottom of each pupil still shows
            c.put(ellipse(c, ex, ey - ry + 1.2, 2.4, 1.6) & ball, INK_DK)
        else:
            c.put(ellipse(c, ex + 1, ey + 0.5, 1.5, 1.8), INK_DK)
        c.put(edge(ball), INK)


def death_mouth(c, hx, my, s, kind, seed):
    """The mouth, plus anything spilling out of it; returns the mouth mask."""
    if kind == "puff":
        # cheeks blown out, lips pressed into a tiny o
        m = ellipse(c, hx + 0.5, my + 1, 2.6, 2.2)
        c.put(m, INK_DK)
        c.put(edge(m), INK)
        for side in (-1, 1):
            cx = hx + side * 15 * s
            c.poly([(cx - 3, my - 2), (cx - 1, my - 4), (cx + 2, my - 4), (cx + 4, my - 2)], INK_LT)
        return m
    if kind == "grit":
        # clenched: a bar of teeth, the strain of the toot
        w = 11 * s
        m = polygon(c, [(hx - w, my - 1), (hx + w, my - 2), (hx + w - 1, my + 5), (hx - w + 1, my + 5)])
        c.put(m, TOOTH)
        c.line(hx - w + 1, my + 2, hx + w - 1, my + 1.5, INK)
        for tx in range(int(-w) + 3, int(w), 3):
            c.line(hx + tx, my - 1, hx + tx, my + 4, INK)
        c.put(edge(m), INK)
        return m
    if kind == "o":
        m = ellipse(c, hx + 0.5, my + 3, 5.0 * s, 6.0 * s)
        c.put(m, INK_DK)
        c.put(edge(m), INK)
        return m
    if kind == "tongue":
        m = ellipse(c, hx, my + 2, 8.0 * s, 4.0 * s)
        c.put(m, INK_DK)
        t = ellipse(c, hx + 3, my + 7, 3.4, 5.0)
        c.put(t, TONGUE)
        c.put(edge(t), INK)
        c.line(hx + 3, my + 4, hx + 3, my + 9, INK)
        c.put(edge(m), INK)
        return m
    # froth: the grin forced wide open, foam welling over the lip
    w = 13 * s
    m = polygon(c, [(hx - w, my - 1), (hx - w * 0.4, my), (hx + w * 0.4, my), (hx + w, my - 3),
                    (hx + w * 0.8, my + 7), (hx + w * 0.3, my + 12), (hx - w * 0.3, my + 12), (hx - w * 0.8, my + 8)])
    c.put(m, INK_DK)
    for tx in range(-10, 12, 3):
        c.put(polygon(c, [(hx + tx * s - 1, my), (hx + tx * s + 2, my), (hx + tx * s + 0.5, my + 3)]), TOOTH)
    c.put(edge(m), INK)
    return m


def foam(c, hx, my, s, seed, drip):
    """Froth: a puffy bank of foam over the lower lip, drips running off it."""
    rng = np.random.default_rng(seed)
    w = 13 * s
    bubbles = [(hx + x * w, my + 7 + rng.uniform(-1.5, 2.5), rng.uniform(3.0, 4.6))
               for x in np.linspace(-1, 1, 7)]
    for _ in range(6):
        bubbles.append((hx + rng.uniform(-w, w), my + 11 + rng.uniform(0, 3), rng.uniform(2.2, 3.6)))
    for d in range(3):
        x = hx + (-8 + d * 8) * s + rng.uniform(-2, 2)
        length = drip * rng.uniform(0.6, 1.0)
        for k in range(int(length // 3) + 1):
            bubbles.append((x + rng.uniform(-0.6, 0.6), my + 14 + k * 3, max(1.4, 2.8 - k * 0.22)))
    mass = np.zeros((c.h, c.w), dtype=bool)
    for x, y, r in bubbles:
        mass |= ellipse(c, x, y, r, r)
    c.put(mass, TOOTH)
    c.put(mass & ~shift(mass, -1, -1) & ~edge(mass), (226, 232, 244, 255))
    # bubble rims inside the mass, so it reads as foam and not a white blob
    for x, y, r in bubbles[::2]:
        ring = edge(ellipse(c, x, y, r * 0.55, r * 0.55))
        c.put(ring & mass & ~edge(mass), FOAM_LINE)
    c.put(edge(mass), FOAM_LINE)
    # flecks spat clear of the face
    for _ in range(6):
        a = rng.uniform(-math.pi * 0.95, -math.pi * 0.05)
        rr = rng.uniform(16, 24) * s
        x, y, r = hx + math.cos(a) * rr * 1.25, my + 4 + math.sin(a) * rr * 0.45, rng.uniform(1.0, 1.7)
        m = ellipse(c, x, y, r, r)
        c.put(m, TOOTH)
        c.put(edge(m), FOAM_LINE)


def death_head(c, hx, hy, s, eyes="normal", eye_size=1.0, mouth="froth", flush=False,
               hair_up=False, seed=0, drip=0):
    fill = FLUSH if flush else FILL
    blob(c, s_ellipse(c, hx - 23.5 * s, hy - 2.5 * s, 3.9, 4.6, 1.0), fill=fill)
    blob(c, s_ellipse(c, hx + 23.0 * s, hy - 5.0 * s, 3.9, 4.6, 1.0), fill=fill)
    knot = polygon(c, [(hx - 7, hy - 35 * s), (hx - 3, hy - 40 * s), (hx + 2, hy - 37 * s),
                       (hx + 1, hy - 31 * s), (hx + 3, hy - 25 * s), (hx - 5, hy - 24 * s), (hx - 9, hy - 29 * s)])
    blob(c, knot)
    if hair_up:
        # the topknot quivering with the pressure
        ky = hy - 34 * s
        for side in (-1, 1):
            c.line(hx - 2 + side * 9, ky - 2, hx - 2 + side * 13, ky - 4, INK_LT)
            c.line(hx - 2 + side * 9, ky + 2, hx - 2 + side * 14, ky + 2, INK_LT)
    h = s_ellipse(c, hx, hy, 22.5, 25.0, s)
    if mouth == "puff":
        # cheeks blown out past the jaw
        for side in (-1, 1):
            h |= s_ellipse(c, hx + side * 15.5 * s, hy + 8 * s, 8.5, 8.0, s)
    h = blob(c, h, fill=fill)
    if flush:
        c.put(h & ~shift(h, -2, -2) & ~edge(h), FLUSH_SH)
    c.clip = h & ~edge(h)
    strands = [(-15, -16, -18, -9), (-12, -20, -13, -12), (-8, -22, -10, -15), (-5, -23, -3, -16),
               (-1, -24, -2, -19), (2, -24, 5, -18), (6, -23, 4, -15), (9, -21, 12, -15),
               (12, -19, 16, -12), (16, -15, 18, -10), (-10, -15, -6, -13), (7, -15, 10, -13)]
    for x0, y0, x1, y1 in strands:
        if hair_up:
            # every hair on end
            c.line(hx + x0 * s, hy + y0 * s, hx + x0 * s * 1.05, hy + (y0 - 6) * s, INK)
        else:
            c.line(hx + x0 * s, hy + y0 * s, hx + x1 * s, hy + y1 * s, INK)
    c.clip = None
    death_eyes(c, hx, hy, s, eyes, eye_size)
    c.poly([(hx - 1.5, hy + 2 * s), (hx - 1.5, hy + 4 * s), (hx - 0.5, hy + 5 * s), (hx + 1, hy + 5 * s), (hx + 2, hy + 3 * s)], INK)
    my = hy + 9 * s
    death_beard(c, hx, hy, s)
    death_mouth(c, hx, my, s, mouth, seed)
    if mouth == "froth":
        foam(c, hx, my, s, seed, drip)
    return h


def death_beard(c, hx, hy, s):
    pts = [(-15, 15), (-10, 19), (-4, 19), (3, 19), (9, 17), (15, 12), (15, 20), (12, 27), (9, 25), (7, 32),
           (3, 28), (0, 34), (-3, 29), (-6, 33), (-9, 27), (-12, 29), (-14, 22)]
    m = polygon(c, [(hx + x * s, hy + y * s) for x, y in pts])
    c.put(m, INK_DK)
    rng = np.random.default_rng(3)
    ys, xs = np.nonzero(m)
    for i in rng.choice(len(xs), size=max(1, len(xs) // 9), replace=False):
        c.dot(xs[i], ys[i], INK)


def death_torso(c, tx, ty, sx, sy, strain=0, popped=False, sag=False):
    t = blob(c, ellipse(c, tx, ty, 18.5 * sx, 17.5 * sy))
    c.put(t & (c.Y > ty + 2) & (c.Y < ty + 4.2), INK)
    # the buckle, sprung off when he is fullest
    bx = tx - 6 * sx
    if popped:
        c.put(t & (c.X > bx) & (c.X < bx + 5) & (c.Y > ty + 1) & (c.Y < ty + 5.5), FILL)
        bk = (tx + 20 * sx, ty - 2)
        c.poly([(bk[0], bk[1]), (bk[0] + 5, bk[1] - 1), (bk[0] + 6, bk[1] + 3), (bk[0] + 1, bk[1] + 4), (bk[0], bk[1])], INK)
        c.line(bk[0] - 4, bk[1] + 1, bk[0] - 9, bk[1] + 2, INK_LT)
        c.line(bk[0] - 4, bk[1] + 4, bk[0] - 8, bk[1] + 6, INK_LT)
    else:
        c.put(polygon(c, [(bx, ty + 1.5), (bx + 5, ty + 1.5), (bx + 5, ty + 5.5), (bx, ty + 5.5)]), FILL)
        c.poly([(bx, ty + 1.5), (bx + 5, ty + 1.5), (bx + 5, ty + 5.5), (bx, ty + 5.5), (bx, ty + 1.5)], INK)
    # the DMP badge, stretched with him
    bw, bh = 17 * min(sx, 1.3), 8
    bxl, byt = tx + 1, ty - 12.5 - (sy - 1) * 4
    c.put(polygon(c, [(bxl, byt), (bxl + bw, byt), (bxl + bw, byt + bh), (bxl, byt + bh)]), TOOTH)
    c.poly([(bxl, byt), (bxl + bw - 1, byt), (bxl + bw - 1, byt + bh - 1), (bxl, byt + bh - 1), (bxl, byt)], INK)
    font = {"D": ["XX.", "X.X", "X.X", "XX."], "M": ["X...X", "XX.XX", "X.X.X", "X...X"], "P": ["XX.", "X.X", "XX.", "X.."]}
    gap = 1 + (1 if bw > 19 else 0)
    gx0 = int(bxl) + 2
    for ch in "DMP":
        for gy, row in enumerate(font[ch]):
            for gx, on in enumerate(row):
                if on == "X":
                    c.dot(gx0 + gx, int(byt) + 2 + gy, INK)
        gx0 += len(font[ch][0]) + gap
    # stretch marks where the shirt is fit to burst
    for k in range(strain):
        a = math.pi * (0.72 + k * 0.16)
        x0, y0 = tx + math.cos(a) * 18.5 * sx * 0.95, ty + math.sin(a) * 17.5 * sy * 0.95
        c.line(x0, y0, x0 + math.cos(a) * -4, y0 + math.sin(a) * -4, INK_LT)
        a2 = math.pi * (0.28 - k * 0.16)
        x0, y0 = tx + math.cos(a2) * 18.5 * sx * 0.95, ty + math.sin(a2) * 17.5 * sy * 0.95
        c.line(x0, y0, x0 + math.cos(a2) * -4, y0 + math.sin(a2) * -4, INK_LT)
    if sag:
        # let down: folds hanging off him
        for k, x in enumerate((-10, -3, 5, 11)):
            c.poly([(tx + x * sx, ty + 6), (tx + x * sx + 2, ty + 10 + k % 2), (tx + x * sx, ty + 13)], INK_LT)
    else:
        c.line(tx - 14 * sx, ty + 9 * sy, tx - 8 * sx, ty + 11 * sy, INK_LT)
    return t


def gas_cloud(c, x, y, size, seed, fade=0):
    """A puff of gas: lumpy, green, outlined like everything else."""
    rng = np.random.default_rng(seed)
    m = np.zeros((c.h, c.w), dtype=bool)
    lumps = [(0, 0, 1.0)]
    for _ in range(5 + int(size / 5)):
        a = rng.uniform(0, 2 * math.pi)
        rr = rng.uniform(0.35, 0.8) * size
        lumps.append((math.cos(a) * rr, math.sin(a) * rr * 0.7, rng.uniform(0.45, 0.75)))
    for dx, dy, r in lumps:
        m |= ellipse(c, x + dx, y + dy, size * r * 0.62, size * r * 0.52)
    if fade:
        # thinning out: a checker of holes eats the body of the cloud
        holes = ((np.indices((c.h, c.w)).sum(axis=0) % (4 - min(fade, 2))) == 0)
        body = m & ~edge(m)
        c.put(body & ~holes, GAS)
        c.put(edge(m) & ~holes, GAS_INK)
        return m
    c.put(m, GAS)
    c.put(m & ~shift(m, -2, -2), GAS_SH)
    c.put(edge(m), GAS_INK)
    # a couple of curls inside
    for _ in range(2):
        cx, cy = x + rng.uniform(-size * 0.3, size * 0.3), y + rng.uniform(-size * 0.2, size * 0.2)
        c.poly([(cx - 2, cy), (cx - 1, cy - 2), (cx + 1, cy - 2), (cx + 2, cy), (cx + 1, cy + 1)], GAS_SH)
    return m


def stink_lines(c, x, y, n=3, h=12):
    for k in range(n):
        x0 = x + k * 5
        pts = [(x0 + (1 if (j // 3) % 2 else -1), y - j) for j in range(h)]
        c.poly(pts, GAS_INK)


DEATH = {}


def death(name, **kw):
    DEATH[name] = kw


# swelling: rounder each frame, eyes popping, face going red
death("bulge0", k=1.12, eyes="bulge", eye_size=1.15, mouth="puff", arms=(-35, 215), flush=False)
death("bulge1", k=1.30, eyes="bulge", eye_size=1.35, mouth="puff", arms=(-25, 205), flush=True, strain=1)
death("bulge2", k=1.50, eyes="bulge", eye_size=1.6, mouth="puff", arms=(-12, 192), flush=True, strain=2,
      popped=True, hair_up=True)
# frothing: as full as he gets, the grin forced open and foaming over
death("froth0", k=1.50, eyes="roll", eye_size=1.5, mouth="froth", arms=(-10, 190), flush=True, strain=2,
      popped=True, hair_up=True, seed=11, drip=6)
death("froth1", k=1.50, eyes="roll", eye_size=1.5, mouth="froth", arms=(-6, 186), flush=True, strain=2,
      popped=True, hair_up=True, seed=12, drip=14, bob=1)
death("froth2", k=1.50, eyes="roll", eye_size=1.5, mouth="froth", arms=(-12, 192), flush=True, strain=2,
      popped=True, hair_up=True, seed=13, drip=22)
# tooting: each one lets him down a size, the cloud behind him growing
death("toot0", k=1.30, eyes="shut", mouth="grit", arms=(20, 160), flush=True, strain=1, popped=True,
      gas=[(30, 112, 14, 21)], lift=3)
death("toot1", k=1.16, eyes="shut", mouth="grit", arms=(35, 145), flush=False, gas=[(28, 108, 18, 22),
      (100, 114, 12, 23)], lift=5, popped=True)
death("toot2", k=1.02, eyes="spiral", mouth="o", arms=(60, 120), gas=[(24, 104, 22, 24), (104, 110, 16, 25),
      (64, 122, 12, 26)], lift=2, popped=True, stink=True)
death("toot3", k=0.92, eyes="spiral", mouth="o", arms=(75, 105), gas=[(20, 98, 22, 27, 1), (108, 104, 16, 28, 1)],
      sag=True, popped=True, stink=True)


def render_death(name):
    p = DEATH[name]
    c = Canvas(128, 128)
    k = p["k"]
    cx = 64
    lift = p.get("lift", 0)
    bob = p.get("bob", 0)
    s = 1 + (k - 1) * 0.42
    sy = k if not p.get("sag") else k * 0.9
    tx, ty = cx - 3, 90.0 - lift + bob + (17.5 - 17.5 * sy) * 0.4
    hy = 47.0 - lift + bob + (1 - s) * 18
    if p.get("sag"):
        hy += 4
    for g in p.get("gas", []):
        gas_cloud(c, g[0], g[1], g[2], g[3], fade=g[4] if len(g) > 4 else 0)
    # stubby legs under a body this round
    leg_ry = 8.5 - (k - 1) * 6
    leg_y = min(122.5 - leg_ry, ty + 17.5 * sy - 1)
    leg(c, tx - 10 * k, leg_y, leg_ry, 4.6, 10 if lift else 0)
    leg(c, tx + 12 * k, leg_y - 0.5, leg_ry, 4.6, -10 if lift else 0)
    death_torso(c, tx, ty, k, sy, strain=p.get("strain", 0), popped=p.get("popped", False), sag=p.get("sag", False))
    death_head(c, cx, hy, s, eyes=p["eyes"], eye_size=p.get("eye_size", 1.0), mouth=p["mouth"],
               flush=p.get("flush", False), hair_up=p.get("hair_up", False), seed=p.get("seed", 0),
               drip=p.get("drip", 0))
    aR, aL = p["arms"]
    sR = (tx + 16 * k, ty - 4 * k)
    sL = (tx - 14 * k, ty - 6 * k)
    mR, _ = arm_shape(c, sR[0], sR[1], aR, 13.0)
    blob(c, mR, fill=FLUSH if p.get("flush") else FILL)
    mL, _ = arm_shape(c, sL[0], sL[1], aL, 11.0, 4.2)
    blob(c, mL, fill=FLUSH if p.get("flush") else FILL)
    if p.get("stink"):
        stink_lines(c, 10, 84)
        stink_lines(c, 104, 92)
    if lift:
        # the jolt of it: speed lines under his feet
        for x in (tx - 14, tx - 4, tx + 8, tx + 18):
            c.line(x, 124, x, 127, INK_LT)
    return c.image()


def render_flat():
    """All the air out of him: an empty suit on the floor, face up."""
    c = Canvas(128, 128)
    gas_cloud(c, 104, 96, 14, 29, fade=2)
    body = polygon(c, [(22, 122), (30, 112), (52, 108), (82, 108), (104, 113), (112, 121), (98, 126), (40, 126)])
    blob(c, body)
    c.put(body & (c.Y > 116) & (c.Y < 118) & (c.X > 40) & (c.X < 96), INK)
    for x in (38, 54, 70, 88):
        c.poly([(x, 112), (x + 3, 116), (x, 121)], INK_LT)
    # the badge, still on
    c.put(polygon(c, [(60, 110), (76, 110), (76, 115), (60, 115)]), TOOTH)
    c.poly([(60, 110), (75, 110), (75, 114), (60, 114), (60, 110)], INK)
    for x in range(62, 74, 2):
        c.dot(x, 112, INK)
    # arms and legs splayed, flat as the rest of him
    blob(c, ellipse(c, 18, 118, 8, 3.2, math.radians(-12)))
    blob(c, ellipse(c, 112, 112, 8, 3.2, math.radians(22)))
    blob(c, ellipse(c, 44, 125, 6, 2.4))
    blob(c, ellipse(c, 92, 125, 6, 2.4))
    # the head flopped back on the floor
    hx, hy = 64, 98
    blob(c, ellipse(c, hx - 25, hy + 2, 3.6, 3.0))
    blob(c, ellipse(c, hx + 25, hy, 3.6, 3.0))
    knot = polygon(c, [(hx - 3, hy - 13), (hx + 4, hy - 17), (hx + 12, hy - 18), (hx + 9, hy - 13), (hx + 2, hy - 10)])
    blob(c, knot)
    h = blob(c, ellipse(c, hx, hy, 23, 13))
    c.clip = h & ~edge(h)
    for x in range(-14, 16, 5):
        c.line(hx + x, hy - 12, hx + x + 3, hy - 8, INK)
    c.clip = None
    death_eyes(c, hx, hy + 2, 0.8, "x", 1.0)
    pts = [(-13, 6), (-7, 9), (0, 10), (7, 9), (13, 6), (11, 11), (6, 13), (0, 14), (-6, 13), (-11, 11)]
    c.put(polygon(c, [(hx + x, hy + y) for x, y in pts]), INK_DK)
    t = ellipse(c, hx + 3, hy + 13, 3.0, 4.0)
    c.put(t, TONGUE)
    c.put(edge(t), INK)
    # a last bubble of froth
    m = ellipse(c, hx - 6, hy + 9, 2.2, 2.2)
    c.put(m, TOOTH)
    c.put(edge(m), FOAM_LINE)
    return c.image()


# --- the balloon -------------------------------------------------------------

TEAL = (36, 168, 140, 255)

FIRED = {
    "F": ["XXXX", "X...", "X...", "XXX.", "X...", "X...", "X..."],
    "i": ["X", ".", "X", "X", "X", "X", "X"],
    "r": ["....", "....", "X.XX", "XX..", "X...", "X...", "X..."],
    "e": ["....", "....", ".XX.", "X..X", "XXXX", "X...", ".XXX"],
    "d": ["...X", "...X", ".XXX", "X..X", "X..X", "X..X", ".XXX"],
    "!": ["X", "X", "X", "X", "X", ".", "X"],
}
IM = {
    "I": ["XXX", ".X.", ".X.", ".X.", "XXX"],
    "'": ["X", "X", ".", ".", "."],
    "m": [".....", ".....", "XX.X.", "X.X.X", "X.X.X"],
}


def text(c, font, word, x, y, color, bold=False, gap=1):
    for ch in word:
        g = font[ch]
        for gy, row in enumerate(g):
            for gx, on in enumerate(row):
                if on == "X":
                    c.dot(x + gx, y + gy, color)
                    if bold:
                        c.dot(x + gx + 1, y + gy, color)
        x += len(g[0]) + gap + (1 if bold else 0)
    return x


def bubble(frame):
    c = Canvas(60, 42)
    body = ellipse(c, 34.5, 17.5, 24.5, 15.5) | ellipse(c, 43.5, 25.0, 12.0, 9.0)
    tail = polygon(c, [(13, 21), (23, 28), (1, 41)])
    shape = body | tail
    blob(c, shape)
    # the tail's join stays open, as drawn
    c.put(edge(body) & tail & ~edge(tail), FILL)
    dy = -1 if frame == 2 else 0
    text(c, IM, "I'm", 17, 7 + dy, TEAL)
    color = RED if frame == 1 else INK
    text(c, FIRED, "Fired!!!", 15, 16 + dy, color, bold=True)
    return c.image()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "art")
    os.makedirs(out, exist_ok=True)
    for name in POSES:
        render(name).save(os.path.join(out, f"Daltonius_{name}.png"))
    for i in range(3):
        bubble(i).save(os.path.join(out, f"Daltonius_fired{i}.png"))
    for name in DEATH:
        render_death(name).save(os.path.join(out, f"Daltonius_die_{name}.png"))
    render_flat().save(os.path.join(out, "Daltonius_die_flat.png"))
    print(f"wrote {len(POSES) + 3 + len(DEATH) + 1} frames to {out}")


if __name__ == "__main__":
    main()
