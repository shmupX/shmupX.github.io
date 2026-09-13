#!/usr/bin/env python3
"""Render static/icons/super-mario-sp-icon.png from mario-sp's own title art.

The launcher draws this inside a circle roughly 54-72 px across
(dashboard.css's .game-icon), with object-fit: contain and NO
image-rendering: pixelated -- so the browser bilinearly downscales whatever it
is given. Pixel art has to be upscaled with nearest-neighbour HERE, at author
time, or it arrives as mush. There is no ImageMagick on this machine; Pillow is
what the SNES asset pipeline already uses.
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "tools", "super-mario-sp", "assets", "images", "title.png")
OUT = os.path.join(ROOT, "static", "icons", "super-mario-sp-icon.png")
SIZE = 512

src = Image.open(SRC).convert("RGBA")
k = max(1, min(SIZE // src.width, SIZE // src.height))
big = src.resize((src.width * k, src.height * k), Image.NEAREST)
out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
out.paste(big, ((SIZE - big.width) // 2, (SIZE - big.height) // 2), big)
out.save(OUT, optimize=True)
print("wrote %s (%dx%d, from %dx%d at %dx)"
      % (os.path.relpath(OUT, ROOT), SIZE, SIZE, src.width, src.height, k))
