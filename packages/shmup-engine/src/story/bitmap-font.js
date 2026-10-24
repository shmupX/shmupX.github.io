// Text drawn with Dezaemon 2's own 8x8 face, for art baked into a cart.
//
// A cart's story is set in pixels before it is written, by the command line
// (packages/shmup-harbor) and by the level editor in the page alike, so the
// face is typeset here, from RGBA, with no canvas. The face is
// `athenaFont.png` — font 0 of the disc's GFONT.BIN, the face the Saturn
// kernel draws SCORE and PAUSE! in, lifted by `deza:disc` — a single row of
// 95 glyphs, 8x8 each, in Phaser's RetroFont.TEXT_SET1 order. That is ASCII
// 32 through 126, so a glyph's index is its code point minus 32, and a cart's
// story ends up set in the cart's own lettering. Reading the sheet is the
// caller's: the CLI decodes the PNG off disk (lib/bitmap-font.ts
// loadAthenaFont), the editor draws the served file onto a canvas.
//
// The glyphs are used as a MASK: only their alpha is read, and the colour is
// the caller's, so the same face can be drawn in any ink over any picture.

/** The first code point the sheet carries. TEXT_SET1 starts at a space. */
const FIRST_CODE = 32;

/**
 * @typedef {{ width: number, height: number, data: Uint8Array<ArrayBuffer> }} Raster
 *   An 8-bit RGBA image, row-major.
 * @typedef {{ glyphW: number, glyphH: number, glyphs: Uint8Array[] }} BitmapFont
 *   Alpha mask per glyph, indexed by code point minus FIRST_CODE.
 */

/** @returns {Raster} a transparent `width` x `height` raster. */
export function newRaster(width, height) {
    return { width, height, data: new Uint8Array(width * height * 4) };
}

/**
 * The face as glyph masks, from its sheet as RGBA ({ width, height, data }).
 * Any pixel with alpha counts as ink, which is what lets the sheet be
 * recoloured; the sheet itself is white on transparent.
 *
 * @param {{ width: number, height: number, data: ArrayLike<number> }} sheet
 * @returns {BitmapFont}
 */
export function bitmapFontFromSheet(sheet, glyphW = 8, glyphH = 8) {
    if (sheet.height < glyphH) {
        throw new Error(`font: ${sheet.height} rows cannot hold a ${glyphH}px glyph`);
    }
    const count = Math.floor(sheet.width / glyphW);
    const glyphs = [];
    for (let g = 0; g < count; g++) {
        const mask = new Uint8Array(glyphW * glyphH);
        for (let y = 0; y < glyphH; y++) {
            for (let x = 0; x < glyphW; x++) {
                const s = (y * sheet.width + g * glyphW + x) * 4;
                mask[y * glyphW + x] = sheet.data[s + 3] ? 1 : 0;
            }
        }
        glyphs.push(mask);
    }
    return { glyphW, glyphH, glyphs };
}

/**
 * `text` broken to `cols` characters a line, honouring the newlines the
 * author typed and breaking on spaces where it can.
 *
 * A word longer than the line is cut rather than allowed to overrun, because
 * a panel has no margin to spill into.
 *
 * @param {string} text
 * @param {number} cols
 * @returns {string[]}
 */
export function wrapText(text, cols) {
    const out = [];
    for (const paragraph of foldToAscii(text).split("\n")) {
        const words = paragraph.trim().split(/\s+/).filter(Boolean);
        if (!words.length) {
            out.push("");
            continue;
        }
        let line = "";
        for (let word of words) {
            while (word.length > cols) {
                if (line) {
                    out.push(line);
                    line = "";
                }
                out.push(word.slice(0, cols));
                word = word.slice(cols);
            }
            if (!line) line = word;
            else if (line.length + 1 + word.length <= cols) line += " " + word;
            else {
                out.push(line);
                line = word;
            }
        }
        if (line) out.push(line);
    }
    return out;
}

/**
 * Typographic characters an editor inserts silently, folded to the ASCII the
 * sheet can draw. Without this a curly apostrophe drops out and the text
 * reads "humanity s last hope".
 *
 * @type {Record<string, string>}
 */
const FOLD = {
    "‘": "'",
    "’": "'",
    "‚": ",",
    "“": '"',
    "”": '"',
    "–": "-",
    "—": "-",
    "−": "-",
    "…": "...",
    " ": " ",
    "´": "'",
    "`": "'",
};

/**
 * `text` with those foldings applied.
 *
 * @param {string} text
 * @returns {string}
 */
export function foldToAscii(text) {
    let out = "";
    for (const ch of String(text ?? "")) out += FOLD[ch] ?? ch;
    return out;
}

/**
 * A code point the sheet can draw. Anything outside it — the story text
 * carries mis-decoded Greek in places — becomes a space rather than a wrong
 * glyph or a crash.
 */
function glyphIndex(font, ch) {
    const code = ch.codePointAt(0) ?? 32;
    const index = code - FIRST_CODE;
    return index >= 0 && index < font.glyphs.length ? index : -1;
}

/**
 * `text` drawn into a `w` x `h` raster, wrapped and vertically centred.
 *
 * Lines that do not fit the height are dropped from the bottom: a story
 * caption that overruns its strip is better short than spilling over the
 * picture below it.
 *
 * Options: `colour` (ink, default white), `align` ("left" | "centre", default
 * centre — a story caption reads centred), `lineGap` (pixels between
 * baselines, default the glyph height plus one), `shadow` (a drop shadow one
 * pixel down-right, so light text survives a light picture).
 *
 * @param {BitmapFont} font
 * @param {string} text
 * @param {number} w
 * @param {number} h
 * @param {{ colour?: [number, number, number], align?: "left" | "centre", lineGap?: number, shadow?: boolean }} [opts]
 * @returns {Raster}
 */
export function renderText(font, text, w, h, opts = {}) {
    const colour = opts.colour ?? [255, 255, 255];
    const align = opts.align ?? "centre";
    const lineGap = opts.lineGap ?? font.glyphH + 1;
    const out = newRaster(w, h);

    const cols = Math.max(1, Math.floor(w / font.glyphW));
    const rows = Math.max(1, Math.floor((h + (lineGap - font.glyphH)) / lineGap));
    const lines = wrapText(text, cols).slice(0, rows);
    if (!lines.length) return out;

    const blockH = lines.length * lineGap - (lineGap - font.glyphH);
    const top = Math.max(0, Math.floor((h - blockH) / 2));

    const plot = (px, py, r, g, b) => {
        if (px < 0 || py < 0 || px >= w || py >= h) return;
        const d = (py * w + px) * 4;
        out.data[d] = r;
        out.data[d + 1] = g;
        out.data[d + 2] = b;
        out.data[d + 3] = 255;
    };

    lines.forEach((line, row) => {
        const lineW = line.length * font.glyphW;
        const left = align === "centre" ? Math.floor((w - lineW) / 2) : 0;
        const y0 = top + row * lineGap;
        for (let i = 0; i < line.length; i++) {
            const gi = glyphIndex(font, line[i]);
            if (gi < 0) continue;
            const mask = font.glyphs[gi];
            const x0 = left + i * font.glyphW;
            // Shadow first, so the ink lands on top of it.
            if (opts.shadow) {
                for (let y = 0; y < font.glyphH; y++) {
                    for (let x = 0; x < font.glyphW; x++) {
                        if (mask[y * font.glyphW + x]) plot(x0 + x + 1, y0 + y + 1, 0, 0, 0);
                    }
                }
            }
            for (let y = 0; y < font.glyphH; y++) {
                for (let x = 0; x < font.glyphW; x++) {
                    if (mask[y * font.glyphW + x]) plot(x0 + x, y0 + y, colour[0], colour[1], colour[2]);
                }
            }
        }
    });
    return out;
}
