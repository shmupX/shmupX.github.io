#!/usr/bin/env python3
"""The gs cloud game's stage-2 boss, drawn from a whiteboard doodle.

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

    python3 scripts/gs/draw_lol_boss.py [out_dir]

writes lolBoss_<pose>.png and lolBoss_fired<0..2>.png into out_dir
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
        render(name).save(os.path.join(out, f"lolBoss_{name}.png"))
    for i in range(3):
        bubble(i).save(os.path.join(out, f"lolBoss_fired{i}.png"))
    print(f"wrote {len(POSES) + 3} frames to {out}")


if __name__ == "__main__":
    main()
