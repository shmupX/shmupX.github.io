// Story backdrops: a level's story — its pictures and its words — set as the
// opening scenery of each stage on a cart: the Saturn's Dezaemon 2, the Super
// Famicom's Dezaemon, and the PlayStation's Kids! and Dezaemon+.
//
// A save has nowhere to put a story: the formats have no words for scenes,
// text or cutscenes, so exporting a level throws its `storyData` away and the
// import arrives with `noStory`. What every one of them DOES hold is a
// background map per stage, 224 px of it drawn across, whose first rows are
// what the screen shows as the stage starts. That is where the story goes:
// each writer (game-to-save.js's story section, sfc-write.js buildWithStory,
// plus-write.js and kids-write.js likewise) paints it there, slows the stage's
// scroll while it is on screen where the format can, and holds the waves back
// until it has gone. It costs the game nothing but the cells nobody else
// wanted.
//
// What is drawn follows the web runtime's story scene: the speaker's name on
// a plate, the stage's words in a black box under it (every part, in order —
// a cart cannot wait for a tap between them), and the stage's picture below.
// Each stage comes in several sizes, largest first, because the cells are
// shared with the whole game: the writer takes the largest size that leaves
// room for every stage's story, then smaller pictures, then the words alone,
// then only the opening part's words.
//
// The pictures are GIFs held as data URLs in `storyData.customImages`, keyed
// `stage<N>_part<M>` — often large (foo's stage 0 is 642x547 across 16
// frames), so they are area-averaged down rather than point-sampled; a
// nearest-neighbour reduction of a painted image at this ratio turns to noise.
//
// It lives in the engine, beside the writers, because two callers compose the
// same backdrops: the command line's `build:sav / build:sfc / build:kids /
// build:plus` (packages/shmup-harbor/lib/story-panels.ts) and the level
// editor's exports in the page (window.Dezaemon). Turning a data URL into
// RGBA is the one step each does its own way — the CLI with its GIF and PNG
// decoders, the page with the browser's — so the caller hands it in as
// `decodePicture`, and what comes out of the same picture is the same cart.

import { newRaster, renderText, wrapText } from "./bitmap-font.js";

/** A stage's background map is 14 cells of 16 px across. */
export const BACKDROP_W = 224;
/** One map row, and the unit a backdrop's height comes in. */
export const BACKDROP_ROW = 16;
/**
 * The height a story aims to fit: what the screen shows between the score
 * and its bottom edge as the stage opens, 12 rows (the writer starts it at
 * STORY_FIRST_ROW). Longer words make it taller, and its top then scrolls
 * into view.
 */
export const BACKDROP_H = 12 * BACKDROP_ROW;

/**
 * @typedef {import("./bitmap-font.js").Raster} Raster
 * @typedef {import("./bitmap-font.js").BitmapFont} BitmapFont
 * @typedef {{ label: string, w: number, h: number, rgba: Uint8Array }} StoryVariant
 *   One way of drawing a stage's story: a BACKDROP_W-wide raster, whole rows
 *   tall; `label` says what it shows, for the build log ("picture 123x164 +
 *   words", "words", …).
 * @typedef {{ stage: number, sourceKey: string | null, speaker: string, parts: string[], variants: StoryVariant[] }} StoryBackdrop
 *   Which stage it opens; the customImages key its picture came from (null
 *   for words alone); who the plate names; the stage's story parts, in order,
 *   as authored; the sizes it can be drawn at, largest first (the writer
 *   takes one).
 */

/**
 * `src` fitted into `w` x `h` by area averaging, preserving aspect and
 * centring what is left over. Transparent pixels contribute nothing but their
 * transparency, so a picture with an alpha border does not bleed grey.
 *
 * @param {{ width: number, height: number, data: ArrayLike<number> }} src
 * @param {number} w
 * @param {number} h
 * @returns {Raster}
 */
export function fitPanel(src, w, h) {
    const out = newRaster(w, h);
    const scale = Math.min(src.width / w, src.height / h);
    // The source rectangle that maps onto the whole panel (centre crop).
    const cropW = Math.min(src.width, Math.round(w * scale));
    const cropH = Math.min(src.height, Math.round(h * scale));
    const cropX = Math.floor((src.width - cropW) / 2);
    const cropY = Math.floor((src.height - cropH) / 2);

    for (let y = 0; y < h; y++) {
        const sy0 = cropY + Math.floor((y * cropH) / h);
        const sy1 = Math.max(sy0 + 1, cropY + Math.floor(((y + 1) * cropH) / h));
        for (let x = 0; x < w; x++) {
            const sx0 = cropX + Math.floor((x * cropW) / w);
            const sx1 = Math.max(sx0 + 1, cropX + Math.floor(((x + 1) * cropW) / w));
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let sy = sy0; sy < sy1 && sy < src.height; sy++) {
                for (let sx = sx0; sx < sx1 && sx < src.width; sx++) {
                    const s = (sy * src.width + sx) * 4;
                    const sa = src.data[s + 3];
                    if (sa) {
                        r += src.data[s] * sa;
                        g += src.data[s + 1] * sa;
                        b += src.data[s + 2] * sa;
                    }
                    a += sa;
                    n++;
                }
            }
            if (!n) continue;
            const d = (y * w + x) * 4;
            const alpha = a / n;
            out.data[d + 3] = Math.round(alpha);
            if (a > 0) {
                out.data[d] = Math.round(r / a);
                out.data[d + 1] = Math.round(g / a);
                out.data[d + 2] = Math.round(b / a);
            }
        }
    }
    return out;
}

/**
 * `src` at its own aspect, as large as fits `w` x `h`.
 *
 * @param {{ width: number, height: number, data: ArrayLike<number> }} src
 * @param {number} w
 * @param {number} h
 * @returns {Raster}
 */
export function containPicture(src, w, h) {
    const scale = Math.min(w / src.width, h / src.height);
    return fitPanel(
        src,
        Math.max(1, Math.round(src.width * scale)),
        Math.max(1, Math.round(src.height * scale)),
    );
}

/**
 * The parts of a stage's story, as authored.
 *
 * @param {unknown} storyData
 * @param {number} stage
 * @returns {string[]}
 */
export function storyParts(storyData, stage) {
    const st = storyData && storyData[`stage${stage}`];
    if (!st || !Array.isArray(st.part)) return [];
    return st.part
        .map((p) => (p && typeof p.text === "string" ? p.text : ""))
        .filter((t) => t.trim());
}

/**
 * Who the plate names: the story's own speaker (gs's is GS), else G, whose
 * story 2028.Ai's is — the web runtime's rule (storySpeaker in the bundle).
 *
 * @param {unknown} storyData
 * @returns {string}
 */
export function storySpeaker(storyData) {
    const own = storyData && storyData.speaker;
    return typeof own === "string" && own.trim() ? own.trim() : "G";
}

// The plate and the box, in the face's 8 px cells.
const BORDER = 1;
const PAD = 3;
const GAP = 4;
const WHITE = [255, 255, 255];

function fillRect(r, x0, y0, w, h, rgb) {
    for (let y = Math.max(0, y0); y < Math.min(r.height, y0 + h); y++) {
        for (let x = Math.max(0, x0); x < Math.min(r.width, x0 + w); x++) {
            r.data.set([rgb[0], rgb[1], rgb[2], 255], (y * r.width + x) * 4);
        }
    }
}

/** A white-edged black box. */
function frameBox(r, x, y, w, h) {
    fillRect(r, x, y, w, h, WHITE);
    fillRect(r, x + BORDER, y + BORDER, w - 2 * BORDER, h - 2 * BORDER, [0, 0, 0]);
}

/** `src` drawn over `dst` at (x, y), its transparent pixels left alone. */
function blit(dst, src, x0, y0) {
    for (let y = 0; y < src.height; y++) {
        const dy = y0 + y;
        if (dy < 0 || dy >= dst.height) continue;
        for (let x = 0; x < src.width; x++) {
            const dx = x0 + x;
            if (dx < 0 || dx >= dst.width) continue;
            const s = (y * src.width + x) * 4;
            if (!src.data[s + 3]) continue;
            dst.data.set(src.data.subarray(s, s + 4), (dy * dst.width + dx) * 4);
        }
    }
}

/**
 * The height of the plate and the box for `lines` lines of words. The box
 * shares the plate's bottom edge, the way the web scene sits its name plate
 * on the box.
 *
 * @param {BitmapFont} font
 * @param {number} lines
 * @returns {number}
 */
export function wordsHeight(font, lines) {
    const plateH = font.glyphH + 2 * (BORDER + PAD);
    const boxH = lines * (font.glyphH + 1) - 1 + 2 * (BORDER + PAD);
    return plateH - BORDER + boxH;
}

/**
 * One stage's story drawn BACKDROP_W wide: the speaker's plate and the words'
 * box on top, the picture centred below, the whole padded with transparency
 * to whole rows. Either half may be missing.
 *
 * @param {BitmapFont | null} font
 * @param {string} speaker
 * @param {string[]} lines
 * @param {Raster | null} picture
 * @returns {Raster}
 */
export function composeBackdrop(font, speaker, lines, picture) {
    const gw = font?.glyphW ?? 8, gh = font?.glyphH ?? 8;
    const lineGap = gh + 1;
    const words = font && lines.length > 0;
    const plateW = speaker.length * gw + 2 * (BORDER + PAD);
    const plateH = gh + 2 * (BORDER + PAD);
    const boxH = lines.length * lineGap - 1 + 2 * (BORDER + PAD);
    const wordsH = words ? wordsHeight(font, lines.length) : 0;
    const pictureY = words && picture ? wordsH + GAP : wordsH;
    const contentH = pictureY + (picture ? picture.height : 0);
    const h = Math.max(BACKDROP_ROW, Math.ceil(contentH / BACKDROP_ROW) * BACKDROP_ROW);
    const out = newRaster(BACKDROP_W, h);
    if (words) {
        const boxY = plateH - BORDER;
        frameBox(out, 0, boxY, BACKDROP_W, boxH);
        frameBox(out, 4, 0, plateW, plateH);
        blit(
            out,
            renderText(font, speaker, speaker.length * gw, gh, { colour: WHITE }),
            4 + BORDER + PAD,
            BORDER + PAD,
        );
        const inner = BACKDROP_W - 2 * (BORDER + PAD);
        blit(
            out,
            renderText(font, lines.join("\n"), inner, lines.length * lineGap - 1, {
                colour: WHITE,
                align: "left",
                lineGap,
            }),
            BORDER + PAD,
            boxY + BORDER + PAD,
        );
    }
    if (picture) {
        blit(out, picture, Math.floor((BACKDROP_W - picture.width) / 2), pictureY);
    }
    return out;
}

/** The words' lines as the box sets them. */
function boxLines(font, parts) {
    const cols = Math.floor((BACKDROP_W - 2 * (BORDER + PAD)) / font.glyphW);
    return parts.flatMap((p) => wrapText(p, cols));
}

/**
 * A build's "story:" log line: what each of the cart's stages opens on, and
 * which of the story's stages the cart has no stage for (a stage is matched
 * by its key, `stage<N>`, so a boss's split second stage is never one). The
 * writers' `report.stages` are the second argument as they come.
 *
 * @param {StoryBackdrop[]} backdrops
 * @param {{ key: string, story?: { size: string, rows: number } | null }[]} stages
 * @returns {string}
 */
export function storyLogLine(backdrops, stages) {
    if (!backdrops.length) {
        return "story: the level tells none — stages open as they are";
    }
    const keys = new Set(stages.map((s) => s.key));
    const drawn = stages.filter((s) => s.story).map((s) => `${s.key} ${s.story.size} (${s.story.rows} rows)`);
    const beyond = backdrops.filter((b) => !keys.has(`stage${b.stage}`)).map((b) => b.stage);
    return `story: ${drawn.length ? `opens ${drawn.join(", ")}` : "no stage has room for it"}${
        beyond.length
            ? ` (stage${beyond.length === 1 ? "" : "s"} ${beyond.join(", ")} of the story ${
                beyond.length === 1 ? "has" : "have"
            } no stage on the cart)`
            : ""
    }`;
}

const variant = (label, r) => ({ label, w: r.width, h: r.height, rgba: r.data });

/**
 * Every stage's story backdrop, in the sizes it can be drawn at.
 *
 * A stage whose story has neither a picture nor words is skipped, and a
 * picture that will not decode costs only that picture — the export must
 * never fail over cutscene art. Without a font a story is its picture alone;
 * without `decodePicture` it is its words alone.
 *
 * Options: `font` (the face to set the words in, bitmapFontFromSheet),
 * `decodePicture` (a `customImages` data URL -> Promise<{ width, height,
 * data }> RGBA; an animated GIF's first frame, which is all a background
 * holds), `onWarn` (message => void).
 *
 * @param {unknown} storyData
 * @param {{ font?: BitmapFont | null, decodePicture?: ((dataUrl: string) => Promise<{ width: number, height: number, data: ArrayLike<number> }>) | null, onWarn?: (message: string) => void }} [options]
 * @returns {Promise<StoryBackdrop[]>}
 */
export async function storyBackdrops(storyData, { font = null, decodePicture = null, onWarn = () => {} } = {}) {
    const sd = storyData;
    if (!sd || typeof sd !== "object") return [];
    const images = sd.customImages && typeof sd.customImages === "object" ? sd.customImages : {};
    const speaker = storySpeaker(sd);
    const out = [];
    for (let stage = 0; stage < 16; stage++) {
        const parts = storyParts(sd, stage);
        // The first part with a picture is the one the stage opens on.
        const key = Object.keys(images)
            .filter((k) => new RegExp("^stage" + stage + "_part\\d+$").test(k))
            .sort((a, b) => Number(a.split("part")[1]) - Number(b.split("part")[1]))
            .find((k) => typeof images[k] === "string") ?? null;
        let source = null;
        if (key && decodePicture) {
            try {
                source = await decodePicture(images[key]);
            } catch (e) {
                onWarn(`story picture for stage ${stage} (${key}): ${e && e.message || e}`);
            }
        }
        const lines = font ? boxLines(font, parts) : [];
        if (!source && !lines.length) continue;

        const variants = [];
        const words = font && lines.length ? composeBackdrop(font, speaker, lines, null) : null;
        if (source) {
            // The picture takes what the words leave of the opening screen, then
            // two thirds of that, then two fifths; a story whose words fill the
            // screen still shows its picture, below them, at a third of it.
            const room = BACKDROP_H - (words ? wordsHeight(font, lines.length) + GAP : 0);
            const heights = room >= 48
                ? [room, Math.round(room * 2 / 3), Math.round(room * 2 / 5)]
                : [Math.round(BACKDROP_H / 3)];
            const seen = new Set();
            for (const h of heights) {
                const pic = containPicture(source, BACKDROP_W, h);
                const size = `${pic.width}x${pic.height}`;
                if (seen.has(size) || pic.height < 16) continue;
                seen.add(size);
                variants.push(
                    variant(
                        `picture ${size}${words ? " + words" : ""}`,
                        composeBackdrop(font, speaker, words ? lines : [], pic),
                    ),
                );
            }
        }
        if (words) {
            variants.push(variant("words", words));
            const opening = boxLines(font, parts.slice(0, 1));
            if (parts.length > 1 && opening.length < lines.length) {
                variants.push(variant("opening words", composeBackdrop(font, speaker, opening, null)));
            }
        }
        out.push({ stage, sourceKey: source ? key : null, speaker, parts, variants });
    }
    return out;
}
