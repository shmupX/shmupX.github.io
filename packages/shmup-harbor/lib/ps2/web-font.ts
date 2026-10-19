// A proportional canvas bitmap font for the PS2 web host: the build's own
// TrueType face (lib/ps2/build.ts ships Orbitron) drawn onto a canvas and
// registered as a Phaser bitmap font, every glyph advancing by its own width.
//
// svelte-ps2's registerCanvasBitmapFont backs AthenaEnv's built-in font and
// gives every glyph one cell — the widest glyph's — which suits a monospace
// stand-in and reads as a typewriter for a face like Orbitron, whose M is
// twice its I. Here the cells stay uniform (the sheet is still a grid that
// RetroFont.Parse can cut), but each glyph is drawn at its cell's left edge
// and advances by what the canvas measured for it, as a console's FreeType
// would lay the same face out.

import Phaser from "phaser";

export interface ProportionalFontOptions {
  /** The CSS family, already loaded (document.fonts). */
  fontFamily: string;
  /** Glyph size in px. */
  fontSize: number;
  /** Extra pixels after every glyph. */
  tracking?: number;
  /** Characters to include. Default: Phaser's TEXT_SET1 (printable ASCII). */
  chars?: string;
}

/** The advance each glyph gets: its measured width, rounded up, plus tracking. */
export function glyphAdvances(
  chars: string,
  measure: (ch: string) => number,
  tracking = 0,
): number[] {
  return [...chars].map((ch) => Math.max(1, Math.ceil(measure(ch)) + tracking));
}

export function registerProportionalCanvasFont(
  scene: Phaser.Scene,
  key: string,
  options: ProportionalFontOptions,
): void {
  if (scene.cache.bitmapFont.exists(key)) return;
  const chars = options.chars ?? Phaser.GameObjects.RetroFont.TEXT_SET1;
  const font = `${options.fontSize}px ${options.fontFamily}`;
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const texture = scene.textures.createCanvas(key, 1, 1);
  if (!texture) throw new Error(`could not create canvas texture "${key}"`);
  let context = texture.context;
  context.font = font;
  const advances = glyphAdvances(
    chars,
    (ch) => context.measureText(ch).width,
    options.tracking ?? 0,
  );
  const cellWidth = Math.max(...advances);
  const probe = context.measureText("Mg(|]q");
  const ascent = Math.ceil(
    probe.fontBoundingBoxAscent ?? probe.actualBoundingBoxAscent ??
      options.fontSize * 0.8,
  );
  const descent = Math.ceil(
    probe.fontBoundingBoxDescent ?? probe.actualBoundingBoxDescent ??
      options.fontSize * 0.25,
  );
  const cellHeight = ascent + descent;
  const perRow = Math.ceil(Math.sqrt(chars.length));
  const rows = Math.ceil(chars.length / perRow);
  // A gap between cells: drawn scaled down, a glyph's frame would otherwise
  // sample the edge of its neighbour's.
  const GAP = 2;
  // Resizing the canvas resets its 2d state.
  texture.setSize(perRow * (cellWidth + GAP), rows * (cellHeight + GAP));
  context = texture.context;
  context.font = font;
  context.fillStyle = "#ffffff";
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  [...chars].forEach((ch, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    context.fillText(
      ch,
      col * (cellWidth + GAP),
      row * (cellHeight + GAP) + ascent,
    );
  });
  texture.refresh();

  const entry = Phaser.GameObjects.RetroFont.Parse(scene, {
    image: key,
    "offset.x": 0,
    "offset.y": 0,
    width: cellWidth,
    height: cellHeight,
    chars,
    charsPerRow: perRow,
    "spacing.x": GAP,
    "spacing.y": GAP,
    lineSpacing: 0,
  });
  // The cell stays the glyph's frame; only the advance is the glyph's own.
  // Phaser types Parse's answer as the font data itself; at run time it is
  // the cache entry holding it under `data` — either way, its `chars`.
  type Glyphs = { chars: Record<number, { xAdvance: number }> };
  const parsed = entry as unknown as Glyphs & { data?: Glyphs };
  const glyphs = (parsed.data ?? parsed).chars;
  [...chars].forEach((ch, i) => {
    const glyph = glyphs[ch.charCodeAt(0)];
    if (glyph) glyph.xAdvance = advances[i];
  });
  scene.cache.bitmapFont.add(key, entry);
}
