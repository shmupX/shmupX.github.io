#!/usr/bin/env python3
"""Turn mario-sp's Phaser assets into snes-platformer-example's inputs.

mario-sp draws on an 8x8 grid; the SNES engine's level grid is 16x16 blocks,
256 wide by 32 tall, hard-wired in src/global.inc. level1 is 300x18 of the
former, which is 150x9 of the latter -- so the whole stage fits with room to
spare, at 1:1 pixels, with no scaling of anybody's art. Every 2x2 group of
source tiles becomes one block.

The conversion is by NAME, not by tile id. tools/levelconvert.py reads
levels/tiles/level.tsx, takes each tile's "Name" property, and looks that name
up in the Block enum that tools/makeblocks.py generates from tools/blocks.txt.
So this script emits all three together -- the tileset, the block table and the
map -- and they agree by construction.

Solidity comes from mario-sp's own layering: foregroundLayer is what the player
collides with, backgroundLayer is scenery. A block is solid when any of its four
source cells is set in the foreground layer. Where a 2x2 group is only partly
solid the 16x16 grid cannot express it, so the block rounds up to solid and the
group is listed in convert-report.md -- coarsening collision is a real change to
how the stage plays, and it should be visible rather than silent.
"""

import base64, json, os, struct, sys
from collections import Counter, OrderedDict
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                  # tools/super-mario-sp
ASSETS = os.path.join(ROOT, "assets")
OVERLAY = os.path.join(ROOT, "overlay")

TILE = 8           # mario-sp's tile size, and the SNES CHR tile size
BLOCK = 2          # source tiles per block edge
LEVEL_W, LEVEL_H = 256, 32     # the engine's level grid, in blocks
ROW_OFFSET = 5     # where the stage sits in that grid; see below

def out(*parts):
    p = os.path.join(OVERLAY, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p

# ---------------------------------------------------------------- the level

def load_level():
    with open(os.path.join(ASSETS, "maps", "level1.json")) as f:
        d = json.load(f)
    w, h = d["width"], d["height"]
    layers = {}
    for l in d["layers"]:
        if l["type"] == "tilelayer":
            raw = base64.b64decode(l["data"])
            layers[l["name"]] = list(struct.unpack("<%dI" % (len(raw) // 4), raw))
    objects = [o for l in d["layers"] if l["type"] == "objectgroup" for o in l["objects"]]
    return w, h, layers, objects

# --------------------------------------------------------------- the palette

def snap555(c):
    """Snap a channel to the 5 bits the SNES actually shows."""
    v = c & 0xF8
    return v | (v >> 5)

def snap_rgb(p):
    return (snap555(p[0]), snap555(p[1]), snap555(p[2]))

def tile_pixels(sheet, index, columns):
    """The 8x8 RGBA block for a 0-based tile index in a sheet."""
    col, row = index % columns, index // columns
    return sheet.crop((col * TILE, row * TILE, col * TILE + TILE, row * TILE + TILE))

def collect_colors(images):
    """Every opaque colour across some images, snapped, in first-seen order."""
    seen = OrderedDict()
    for im in images:
        for px in im.convert("RGBA").getdata():
            if px[3] >= 128:
                seen.setdefault(snap_rgb(px), None)
    return list(seen)

def indexed_png(size, cells, palette, path):
    """Write an indexed PNG: index 0 transparent, 1..15 the palette.

    tools/pilbmp2nes.py refuses anything but indexed colour, and
    tools/encodepalettes.py reads getpalette()[3:] -- i.e. it skips entry 0 and
    takes the next 15 as the SNES palette. So entry 0 is the transparent slot
    in both files and the two line up by construction.
    """
    im = Image.new("P", size, 0)
    flat = [0, 0, 0]
    for c in palette:
        flat += list(c)
    flat += [0] * (768 - len(flat))
    im.putpalette(flat)
    px = im.load()
    for (x, y), idx in cells.items():
        px[x, y] = idx
    im.save(path)
    return im

def index_of(palette, rgba):
    """Palette index for an RGBA pixel; 0 when transparent."""
    if rgba[3] < 128:
        return 0
    return palette.index(snap_rgb(rgba)) + 1

def blit(cells, img, palette, ox, oy):
    """Paint an image into a {(x,y): index} dict at an offset."""
    img = img.convert("RGBA")
    for y in range(img.height):
        for x in range(img.width):
            cells[(ox + x, oy + y)] = index_of(palette, img.getpixel((x, y)))

# ------------------------------------------------------------------- main

# Blocks the engine names in its own assembly, and that ca65 therefore needs to
# exist whatever the level looks like. Empty must be FIRST: tools/levelconvert.py
# maps an unset map cell to block 0.
REQUIRED_BLOCKS = [
    ("Empty", []),
    ("PrizeAnimation", []),
    ("UsedPrize", []),
    ("Spring", []),
    ("SpringPressedHalf", []),
    ("SpringPressed", []),
    ("SlopeLeft", ["solid"]),
    ("SlopeRightBelow", ["solid"]),
]

def main():
    w, h, layers, objects = load_level()
    fg, bg = layers["foregroundLayer"], layers["backgroundLayer"]
    comp = [fg[i] or bg[i] for i in range(w * h)]
    bw, bh = w // BLOCK, h // BLOCK          # 150 x 9 blocks

    sheet = Image.open(os.path.join(ASSETS, "tiles", "tiles.png")).convert("RGBA")
    sheet_cols = sheet.width // TILE

    # --- CHR: one entry per distinct source tile, index 0 kept blank ------
    used_gids = sorted({g for g in comp if g})
    chr_index = {0: 0}
    chr_images = [Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))]
    for g in used_gids:
        chr_index[g] = len(chr_images)
        chr_images.append(tile_pixels(sheet, g - 1, sheet_cols))

    # Interactive block art. mario-sp draws these 8x8, half the height of its
    # own ground; on the SNES they become whole 16x16 blocks, which is both what
    # the engine's grid can express and what a Mario block is supposed to be.
    def art16(rel, frame=0, fw=8):
        im = Image.open(os.path.join(ASSETS, rel)).convert("RGBA")
        im = im.crop((frame * fw, 0, frame * fw + fw, im.height))
        return im.resize((16, 16), Image.NEAREST)

    interactive = OrderedDict([
        ("Bricks",    art16("sprites/brick.png")),
        ("Prize",     art16("sprites/box.png", 0)),
        ("UsedBlock", art16("sprites/box.png", 1)),
        ("Money",     art16("collectibles/coin2.png")),
    ])
    # Each of those is four more CHR tiles.
    interactive_chr = {}
    for name, im in interactive.items():
        quad = []
        for (ox, oy) in ((0, 0), (8, 0), (0, 8), (8, 8)):
            quad.append(len(chr_images))
            chr_images.append(im.crop((ox, oy, ox + 8, oy + 8)))
        interactive_chr[name] = quad

    if len(chr_images) > 96:
        sys.exit("GreenBrown holds 96 tiles; this level needs %d" % len(chr_images))

    palette = collect_colors(chr_images)
    if len(palette) > 15:
        sys.exit("background art needs %d colours; a 4bpp palette holds 15" % len(palette))

    cells = {}
    for i, im in enumerate(chr_images):
        blit(cells, im, palette, (i % 16) * TILE, (i // 16) * TILE)
    indexed_png((128, 48), cells, palette, out("tilesets4", "GreenBrown.png"))
    indexed_png((16, 1), {(i, 0): i + 1 for i in range(len(palette))}, palette,
                out("palettes", "GreenBrown.png"))

    # --- blocks: one per distinct 2x2 quad -------------------------------
    def quad_at(bx, by):
        return tuple(comp[(by * BLOCK + dy) * w + (bx * BLOCK + dx)]
                     for dy in range(BLOCK) for dx in range(BLOCK))

    def solid_at(bx, by):
        return any(fg[(by * BLOCK + dy) * w + (bx * BLOCK + dx)]
                   for dy in range(BLOCK) for dx in range(BLOCK))

    def partial_at(bx, by):
        cs = [bool(fg[(by * BLOCK + dy) * w + (bx * BLOCK + dx)])
              for dy in range(BLOCK) for dx in range(BLOCK)]
        return any(cs) and not all(cs)

    blocks = OrderedDict()               # name -> directive lines
    name_for = {}                        # (quad, solid) -> name
    grid = [[0] * bw for _ in range(bh)]  # block index per cell, filled later
    partials = []

    for by in range(bh):
        for bx in range(bw):
            q, s = quad_at(bx, by), solid_at(bx, by)
            if q == (0, 0, 0, 0) and not s:
                grid[by][bx] = "Empty"
                continue
            key = (q, s)
            if key not in name_for:
                nm = "B%03d" % (len(name_for) + 1)
                name_for[key] = nm
                tl, tr, bl, br = (chr_index[g] for g in q)
                lines = (["solid"] if s else []) + [
                    "t %d,%d %d,%d" % (tl % 16, tl // 16, tr % 16, tr // 16),
                    "t %d,%d %d,%d" % (bl % 16, bl // 16, br % 16, br // 16),
                ]
                blocks[nm] = lines
            grid[by][bx] = name_for[key]
            if partial_at(bx, by):
                partials.append((bx, by, q))

    # Interactive blocks reuse the engine's own interaction procs, so none of
    # this needs new 65816.
    def quad_lines(quad, extra):
        tl, tr, bl, br = quad
        return extra + [
            "t %d,%d %d,%d" % (tl % 16, tl // 16, tr % 16, tr // 16),
            "t %d,%d %d,%d" % (bl % 16, bl // 16, br % 16, br // 16),
        ]

    blocks["Bricks"] = quad_lines(interactive_chr["Bricks"], ["solid", "when Below, BlockBricks"])
    blocks["Prize"] = quad_lines(interactive_chr["Prize"], ["solid", "when Below, BlockPrize"])
    blocks["Money"] = quad_lines(interactive_chr["Money"], ["when Touch, BlockMoney", "class Collectible"])
    # A blank solid: the invisible wall that ends the stage, and the kill floor.
    blocks["Wall"] = quad_lines([0, 0, 0, 0], ["solid"])
    blocks["Spikes"] = quad_lines([0, 0, 0, 0], ["solid", "when Above, BlockSpikes"])

    for nm, extra in REQUIRED_BLOCKS:
        if nm in blocks:
            continue
        if nm == "UsedPrize":
            blocks[nm] = quad_lines(interactive_chr["UsedBlock"], ["solid"])
        elif nm == "PrizeAnimation":
            blocks[nm] = quad_lines(interactive_chr["Prize"], ["solid"])
        else:
            blocks[nm] = quad_lines([0, 0, 0, 0], extra)

    # Empty has to be block 0.
    ordered = ["Empty"] + [n for n in blocks if n != "Empty"]
    if "Empty" not in blocks:
        blocks["Empty"] = quad_lines([0, 0, 0, 0], [])
    write_blocks(ordered, blocks)
    write_tileset(ordered)
    return w, h, bw, bh, comp, objects, grid, ordered, partials, chr_images, palette

# ------------------------------------------------------- blocks.txt + tileset

BLOCKS_HEADER = """\
# This file is GENERATED by tools/super-mario-sp/convert/convert.py from
# mario-sp's level1.json. Edit the converter, not this file.
#
# The B### blocks are one per distinct 2x2 group of mario-sp tiles; the named
# ones below them are the engine's own, either because its assembly references
# them or because an object layer needs them.

alias level_gfx $0100
alias level_palette 0

base level_gfx
palette level_palette
"""

def write_blocks(ordered, blocks):
    with open(out("tools", "blocks.txt"), "w") as f:
        f.write(BLOCKS_HEADER)
        for name in ordered:
            f.write("\n+%s\n" % name)
            for line in blocks[name]:
                f.write("%s\n" % line)

def write_tileset(ordered):
    """levels/tiles/level.tsx -- the Name property per block is the whole point.

    level.png beside it is never read by the build (levelconvert only wants the
    names); it exists so the .tmx can still be opened in Tiled to hand-fix a
    block the converter got wrong.
    """
    cols = 16
    rows = (len(ordered) + cols - 1) // cols
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<tileset version="1.8" tiledversion="1.8.5" name="level" tilewidth="16" '
             'tileheight="16" tilecount="%d" columns="%d">' % (len(ordered), cols),
             ' <image source="level.png" width="%d" height="%d"/>' % (cols * 16, rows * 16)]
    for i, name in enumerate(ordered):
        lines += [' <tile id="%d">' % i, '  <properties>',
                  '   <property name="Name" value="%s"/>' % name,
                  '  </properties>', ' </tile>']
    lines.append("</tileset>")
    with open(out("levels", "tiles", "level.tsx"), "w") as f:
        f.write("\n".join(lines) + "\n")

# --------------------------------------------------------------------- TMX

ACTOR_TILE = {"Walker": 0, "LedgeWalker": 1, "Shooter": 2, "Jumper": 3,
              "MovingPlatformHorizontal": 4, "MovingPlatformVertical": 5}

# mario-sp object name -> what it becomes here. `portal` is dropped: the
# engine's door handling is inside an `.if 0` upstream, so the two pipes and
# their two exits would need new 65816 to work. They stay as scenery and the
# stage ends at the wall instead.
OBJECT_BLOCK = {"brick": "Bricks", "box": "Prize", "collectible": "Money"}
OBJECT_ACTOR = {"goomba": "Walker", "koopa": "LedgeWalker",
                "platformMovingLeftAndRight": "MovingPlatformHorizontal",
                "platformMovingUpAndDown": "MovingPlatformVertical"}

def write_tmx(bw, bh, objects, grid, ordered):
    gid_for = {name: i + 1 for i, name in enumerate(ordered)}
    actors_firstgid = len(ordered) + 1

    cells = [["Empty"] * LEVEL_W for _ in range(LEVEL_H)]
    for by in range(bh):
        for bx in range(bw):
            cells[ROW_OFFSET + by][bx] = grid[by][bx]

    # An invisible wall one column past the end, so walking off the right of
    # the stage stops rather than strolling into 106 columns of sky.
    for by in range(bh):
        cells[ROW_OFFSET + by][bw] = "Wall"
    # A kill floor on the first row below the visible screen. The engine has no
    # bottom-of-level check of its own, so without this a pit is just a place
    # you fall forever.
    for bx in range(LEVEL_W):
        cells[ROW_OFFSET + bh][bx] = "Spikes"

    actors, start = [], None
    for o in objects:
        kind = o.get("type") or o.get("name") or ""
        bx = int(o["x"]) // 16
        feet_px = int(o["y"]) + int(o.get("height", 0)) + ROW_OFFSET * 16
        if kind in OBJECT_BLOCK:
            by = (int(o["y"]) + ROW_OFFSET * 16) // 16
            if 0 <= by < LEVEL_H and 0 <= bx < LEVEL_W:
                cells[by][bx] = OBJECT_BLOCK[kind]
        elif kind in OBJECT_ACTOR:
            actors.append((bx * 16, feet_px, OBJECT_ACTOR[kind]))
        elif kind == "player":
            start = (bx * 16, feet_px)

    rows = "\n".join(",".join(str(gid_for[c]) for c in row) for row in cells)
    xml = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<map version="1.8" tiledversion="1.8.5" orientation="orthogonal" '
           'renderorder="right-down" width="%d" height="%d" tilewidth="16" tileheight="16" '
           'infinite="0" backgroundcolor="#5dd2ff" nextlayerid="4" nextobjectid="%d">'
           % (LEVEL_W, LEVEL_H, len(actors) + 2),
           ' <tileset firstgid="1" source="tiles/level.tsx"/>',
           ' <tileset firstgid="%d" source="tiles/actors.tsx"/>' % actors_firstgid,
           ' <layer id="1" name="Foreground" width="%d" height="%d">' % (LEVEL_W, LEVEL_H),
           '  <data encoding="csv">', rows, '</data>', ' </layer>',
           ' <objectgroup id="2" name="Actors">']
    for i, (x, y, name) in enumerate(sorted(actors)):
        xml.append('  <object id="%d" gid="%d" x="%d" y="%d" width="16" height="16"/>'
                   % (i + 1, actors_firstgid + ACTOR_TILE[name], x, y))
    xml += [' </objectgroup>', ' <objectgroup id="3" name="Meta">',
            '  <object id="%d" name="PlayerStart" x="%d" y="%d"><point/></object>'
            % (len(actors) + 1, start[0], start[1]),
            ' </objectgroup>', '</map>']
    with open(out("levels", "demo.tmx"), "w") as f:
        f.write("\n".join(xml) + "\n")
    return actors, start

# ------------------------------------------------------------------ sprites

# mario.png is a 6x3 grid of 16x16 frames. These are the ones the engine's
# PlayerFrame enum asks for, in its order: one idle, six walk, eight run, then
# jump, fall and climb. mario-sp's own animations.json says its walk cycle is
# frames 0-3, so the longer cycles here are that cycle paced out.
MARIO_FRAMES = {
    "Idle":  [0],
    "Walk":  [1, 2, 3, 2, 1, 0],
    "Run":   [1, 2, 3, 2, 1, 2, 3, 2],
    "Jump":  [5],
    "Fall":  [5],
    "Climb": [0],
}

def write_player(palette_out):
    src = Image.open(os.path.join(ASSETS, "sprites", "mario.png")).convert("RGBA")
    frames = [src.crop((c * 16, r * 16, c * 16 + 16, r * 16 + 16))
              for r in range(src.height // 16) for c in range(src.width // 16)]
    palette = collect_colors(frames)
    if len(palette) > 15:
        sys.exit("Mario needs %d colours" % len(palette))

    for name, picks in MARIO_FRAMES.items():
        cells = {}
        for i, fi in enumerate(picks):
            # src/playerdraw.s draws four 16x16 sprites spanning x-16..x+16 and
            # y-33..y-1, so a 16x16 Mario goes bottom-centre of the 32x32 cell:
            # one block wide, standing exactly on his own feet.
            blit(cells, frames[fi], palette, 8, i * 32 + 16)
        indexed_png((32, 32 * len(picks)), cells, palette, out("tilesetsX", "%s.png" % name))
        with open(out("tilesetsX", "%s.txt" % name), "w") as f:
            f.write("--planes=0,1;2,3 --rearrange-16x16")
    indexed_png((16, 1), {(i, 0): i + 1 for i in range(len(palette))}, palette,
                out("palettes", "Player.png"))

def write_enemies():
    """Enemy.png, whose cell layout is dictated by src/actorcode.s.

    DrawWalker writes OAM tile $20/$22, DrawLedgeWalker $28/$2a and
    DrawMovingPlatform $48/$4a. Enemy loads at VRAM $6200 against a sprite base
    of $6000, so $20 is this sheet's first tile and the rest count on from there
    across a 16-tile-wide sheet. Move the art and the actors point at whatever
    is left behind.
    """
    def frames(rel, count, fw, fh):
        im = Image.open(os.path.join(ASSETS, rel)).convert("RGBA")
        return [im.crop((i * fw, 0, i * fw + fw, fh)).resize((16, 16), Image.NEAREST)
                for i in range(count)]

    goomba = frames("sprites/goomba.png", 2, 8, 8)
    koopa = frames("sprites/turtle-red.png", 2, 18, 27)
    plat = Image.open(os.path.join(ASSETS, "images", "platform.png")).convert("RGBA")
    plat = plat.resize((32, 16), Image.NEAREST)
    plat_l, plat_r = plat.crop((0, 0, 16, 16)), plat.crop((16, 0, 32, 16))

    art = goomba + koopa + [plat_l, plat_r]
    palette = collect_colors(art)
    if len(palette) > 15:
        sys.exit("enemy art needs %d colours" % len(palette))

    cells = {}
    for im, (ox, oy) in zip(art, [(0, 0), (16, 0), (64, 0), (80, 0), (64, 16), (80, 16)]):
        blit(cells, im, palette, ox, oy)
    indexed_png((128, 32), cells, palette, out("tilesets4", "Enemy.png"))
    indexed_png((16, 1), {(i, 0): i + 1 for i in range(len(palette))}, palette,
                out("palettes", "Enemy1.png"))

# ------------------------------------------------------------------- report

def write_report(bw, bh, ordered, actors, partials, chr_count, palette):
    counts = Counter(q for _, _, q in partials)
    with open(os.path.join(ROOT, "convert-report.md"), "w") as f:
        f.write("# Super Mario SP conversion report\n\n")
        f.write("Generated by `convert/convert.py`. Not read by the build.\n\n")
        f.write("- stage: **%d x %d blocks** in a %d x %d grid, at row %d\n"
                % (bw, bh, LEVEL_W, LEVEL_H, ROW_OFFSET))
        f.write("- blocks: **%d** of the 256 a level byte can name\n" % len(ordered))
        f.write("- background tiles: **%d** of the 96 GreenBrown holds\n" % chr_count)
        f.write("- background colours: **%d** of 15\n" % len(palette))
        f.write("- actors: **%d**\n\n" % len(actors))
        f.write("## Collision coarsened to 16x16\n\n")
        f.write("mario-sp collides on an 8x8 grid and the SNES engine on a 16x16 one, so a "
                "2x2 group that is only partly solid has to round up to a solid block. "
                "**%d cells** across **%d distinct groups** did:\n\n"
                % (len(partials), len(counts)))
        f.write("| source tiles (TL,TR,BL,BR) | cells |\n| --- | --- |\n")
        for q, n in counts.most_common():
            f.write("| `%s` | %d |\n" % (",".join(str(x) for x in q), n))

def run():
    (w, h, bw, bh, comp, objects, grid, ordered, partials,
     chr_images, palette) = main()
    actors, start = write_tmx(bw, bh, objects, grid, ordered)
    write_player(None)
    write_enemies()
    write_report(bw, bh, ordered, actors, partials, len(chr_images), palette)
    print("stage %dx%d blocks, %d blocks, %d bg tiles, %d colours, %d actors, start %s"
          % (bw, bh, len(ordered), len(chr_images), len(palette), len(actors), start))
    print("%d partially-solid cells rounded up -- see convert-report.md" % len(partials))

if __name__ == "__main__":
    run()
