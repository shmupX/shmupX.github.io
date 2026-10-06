// Who made this game, as a Dezaemon 2 cart can say it.
//
// A cart has exactly one place for a name: the ending's STAFF ROLL (FORMAT.md,
// settings +0x5A..+0x5C). Three role labels picked from the engine's fixed
// list of sixteen, and under each one two 64x16 credit strips the author
// DREW — there is no text anywhere in the save, so a name is pixels. A game
// made in the web editor has nobody to draw them, and used to leave the cart
// reading "PRESENTED BY" over an empty screen.
//
// So the level record carries the words, and the writer sets them in a face
// of its own:
//
//   "attribution": "easierbycode"
//   "attribution": { "author": "easierbycode" }
//   "attribution": { "credits": [
//       { "role": "PRESENTED BY", "names": ["EASIERBYCODE", "2026"] },
//       { "role": "MUSIC",        "names": ["SOMEBODY ELSE"] }
//   ] }
//   "attribution": false            // credit nobody, not even the default
//
// The first two are the same thing: one PRESENTED BY credit. `credits` is the
// whole roll — up to three roles, two names each, a name being one strip.
//
// Who wins, most explicit first (resolveAttribution):
//
//   1. the caller's `attribution` option   (`build:sav --author`)
//   2. the level's own `attribution`       (the editor's STAFF ROLL rows, or
//                                            the field typed into the JSON)
//   3. a cart's own drawn credits          (an import keeps its author's art)
//   4. the caller's `author` option        (the default: the player's account
//                                            name — authorFromEnvironment)
//
// (4) never applies to a game that came off a cart: somebody else made it.
//
// Environment-neutral ESM (Node + browser), no canvas: the editor and
// `deno task build:sav` write the same bytes.

import { STAFF_ROLE_LABELS } from "../decode/decode-settings.js";

/** Role labels a staff roll holds, and the credit strips under each. */
export const ATTRIBUTION_ROLES = 3;
export const NAMES_PER_ROLE = 2;
/** The label a bare author is credited under. */
export const DEFAULT_ATTRIBUTION_ROLE = "PRESENTED BY";
/** A credit strip, in pixels (TITLE_SLOTS.credits: 4x1 CG cells). */
export const CREDIT_STRIP_W = 64;
export const CREDIT_STRIP_H = 16;
/** The most characters one line of a strip holds, and one strip in all. */
export const CREDIT_LINE_CHARS = 16;
export const CREDIT_STRIP_CHARS = CREDIT_LINE_CHARS * 2;

// The face: 3x5, one column of air between glyphs, upper case only — sixteen
// characters across a strip, which is what it takes to fit an account name on
// one line. Five rows of three bits, top row first.
const GLYPH_W = 3, GLYPH_H = 5, ADVANCE = 4;
const GLYPHS = {
    " ": "000000000000000",
    A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110",
    E: "111100110100111", F: "111100110100100", G: "011100101101011", H: "101101111101101",
    I: "111010010010111", J: "001001001101010", K: "101101110101101", L: "100100100100111",
    M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100",
    Q: "010101101111011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
    U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
    Y: "101101010010010", Z: "111001010100111",
    0: "111101101101111", 1: "010110010010111", 2: "110001010100111", 3: "110001010001110",
    4: "101101111001001", 5: "111100110001110", 6: "011100111101111", 7: "111001010010010",
    8: "111101111101111", 9: "111101111001110",
    ".": "000000000000010", ",": "000000000010100", "-": "000000111000000", _: "000000000000111",
    "'": "010010000000000", "!": "010010010000010", "?": "110001010000010", "&": "010101010101011",
    "/": "001001010100100", ":": "000010000010000", "+": "000010111010000", "@": "111101111100111",
    "#": "101111101111101", "(": "001010010010001", ")": "100010010010100", "*": "101010101000000",
};

// What an editor or a keyboard puts in a name that the face spells otherwise.
const FOLD = { "‘": "'", "’": "'", "`": "'", "“": "'", "”": "'", '"': "'", "–": "-", "—": "-", "\t": " " };

/**
 * `text` as the face can set it: upper case, accents folded off their
 * letters, runs of space collapsed. Returns {text, dropped} — `dropped` the
 * characters it has no glyph for, which are left out rather than guessed at.
 */
export function foldCreditText(text) {
    let dropped = "";
    const folded = [...String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "")]
        .map((ch) => FOLD[ch] ?? ch)
        .join("")
        .toUpperCase();
    let out = "";
    for (const ch of folded) {
        if (ch === "\n" || GLYPHS[ch] !== undefined) out += ch;
        else if (!dropped.includes(ch)) dropped += ch;
    }
    const lines = out.split("\n").map((l) => l.replace(/ +/g, " ").trim());
    return { text: lines.join("\n").replace(/^\n+|\n+$/g, ""), dropped };
}

/** One line broken to `cols`, on spaces where it can; a longer word is cut. */
function wrapLine(line, cols) {
    const out = [];
    let cur = "";
    for (let word of line.split(" ").filter(Boolean)) {
        while (word.length > cols) {
            if (cur) { out.push(cur); cur = ""; }
            out.push(word.slice(0, cols));
            word = word.slice(cols);
        }
        if (!cur) cur = word;
        else if (cur.length + 1 + word.length <= cols) cur += " " + word;
        else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
    return out;
}

/**
 * One credit strip: `text` set in white with a one-pixel shadow (the roll
 * flies it over the stages' scenery), centred in 64x16.
 *
 * It is drawn as large as it fits: up to 8 characters at double size, up to
 * 16 on one double-height line, otherwise two lines of 16 (a newline in the
 * text asks for the two lines outright). Anything past that is cut.
 *
 * Returns {w, h, rgba, lines, dropped, truncated}, or null when nothing in
 * the text can be drawn.
 */
export function creditStripRgba(text) {
    const folded = foldCreditText(text);
    if (!folded.text.replace(/\n/g, "")) return null;
    const asked = folded.text.split("\n").filter(Boolean);
    let lines, sx = 1, sy = 1;
    if (asked.length === 1 && asked[0].length <= CREDIT_LINE_CHARS / 2) {
        lines = asked; sx = 2; sy = 2;
    } else if (asked.length === 1 && asked[0].length <= CREDIT_LINE_CHARS) {
        lines = asked; sy = 2;
    } else {
        lines = asked.flatMap((l) => wrapLine(l, CREDIT_LINE_CHARS));
    }
    const truncated = lines.length > 2;
    lines = lines.slice(0, 2);

    const rgba = new Uint8Array(CREDIT_STRIP_W * CREDIT_STRIP_H * 4);
    const put = (x, y, v) => {
        if (x < 0 || y < 0 || x >= CREDIT_STRIP_W || y >= CREDIT_STRIP_H) return;
        const o = (y * CREDIT_STRIP_W + x) * 4;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
        rgba[o + 3] = 255;
    };
    const lineH = GLYPH_H * sy, pitch = lineH + 2;
    // +1 everywhere for the shadow, so the block it is centred as is the block drawn
    const top = Math.floor((CREDIT_STRIP_H - (lineH + (lines.length - 1) * pitch + 1)) / 2);
    const draw = (dx, dy, v) => lines.forEach((line, n) => {
        const left = Math.floor((CREDIT_STRIP_W - (line.length * ADVANCE * sx - sx + 1)) / 2);
        [...line].forEach((ch, c) => {
            const bits = GLYPHS[ch];
            for (let gy = 0; gy < GLYPH_H; gy++) {
                for (let gx = 0; gx < GLYPH_W; gx++) {
                    if (bits[gy * GLYPH_W + gx] !== "1") continue;
                    for (let py = 0; py < sy; py++) {
                        for (let px = 0; px < sx; px++) {
                            put(left + (c * ADVANCE + gx) * sx + px + dx, top + n * pitch + gy * sy + py + dy, v);
                        }
                    }
                }
            }
        });
    });
    draw(1, 1, 0);
    draw(0, 0, 255);
    return { w: CREDIT_STRIP_W, h: CREDIT_STRIP_H, rgba, lines, dropped: folded.dropped, truncated };
}

/** A role as its index into the engine's sixteen labels, or -1. */
function roleIndex(role) {
    if (Number.isInteger(role)) return role >= 0 && role < STAFF_ROLE_LABELS.length ? role : -1;
    if (typeof role !== "string") return -1;
    return STAFF_ROLE_LABELS.indexOf(role.trim().replace(/\s+/g, " ").toUpperCase());
}

const cleanName = (v) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");

/**
 * An `attribution` value, in any of the shapes the header lists, as the one
 * canonical shape: {credits: [{role: "<LABEL>", names: [..up to 2]}, ..up to 3]}.
 *
 * Returns null when the value says nothing (absent, blank, an empty object) —
 * the next source in line gets its turn — and {credits: []} when it says
 * NOBODY (`false`, or an explicit empty `credits`), which ends the search.
 * `warn` hears about whatever was dropped on the way.
 */
export function normalizeAttribution(value, warn = () => {}) {
    if (value === false) return { credits: [] };
    if (value === undefined || value === null || value === true) return null;
    if (typeof value === "string" || typeof value === "number") {
        const author = cleanName(value);
        return author ? { credits: [{ role: DEFAULT_ATTRIBUTION_ROLE, names: [author] }] } : null;
    }
    if (typeof value !== "object") return null;
    const list = Array.isArray(value) ? value : value.credits;
    if (!Array.isArray(list)) return normalizeAttribution(value.author ?? null, warn);

    if (list.length > ATTRIBUTION_ROLES) {
        warn(`attribution: a staff roll holds ${ATTRIBUTION_ROLES} roles; dropped ${list.length - ATTRIBUTION_ROLES}`);
    }
    const credits = list.slice(0, ATTRIBUTION_ROLES).map((entry) => {
        if (typeof entry === "string" || typeof entry === "number") entry = { names: [entry] };
        if (!entry || typeof entry !== "object") return { role: "", names: [] };
        const raw = Array.isArray(entry.names) ? entry.names : [entry.names ?? entry.name];
        const names = raw.map(cleanName);
        const over = names.slice(NAMES_PER_ROLE).filter(Boolean);
        if (over.length) warn(`attribution: a role holds ${NAMES_PER_ROLE} names; dropped "${over.join('", "')}"`);
        // Position matters — names[1] is the SECOND strip — so a blank first
        // name stays where it is; only blanks past the last name go.
        const kept = names.slice(0, NAMES_PER_ROLE);
        while (kept.length && !kept[kept.length - 1]) kept.pop();
        const presented = STAFF_ROLE_LABELS.indexOf(DEFAULT_ATTRIBUTION_ROLE);
        let index;
        if (entry.role === undefined || entry.role === null) {
            // A name with no role is presented; a slot with neither is a gap.
            index = kept.length ? presented : 0;
        } else {
            index = roleIndex(entry.role);
            if (index < 0) {
                warn(`attribution: "${entry.role}" is not one of the staff roll's labels — using ${DEFAULT_ATTRIBUTION_ROLE}`);
                index = presented;
            }
        }
        return { role: STAFF_ROLE_LABELS[index], names: kept };
    });
    while (credits.length && !credits[credits.length - 1].role && !credits[credits.length - 1].names.length) credits.pop();
    return { credits };
}

/** Did this level come off a cart? Then its credits are its author's. */
function cameOffACart(level) {
    return !!(level && (level.dezaemonTitle || level.dezaemonTitleScreen ||
        (level.meta && level.meta.source === "dezaemon2")));
}

/**
 * Whose names go on the cart: {source, credits}, `source` one of
 *   "option"   the caller's `attribution`
 *   "level"    the level's own `attribution`
 *   "cart"     the drawn strips an import carried (credits: [] — it is art)
 *   "default"  the caller's `author`, for a web game that names nobody
 *   "none"     nothing to go on
 */
export function resolveAttribution(level, { attribution, author } = {}, warn = () => {}) {
    const asked = normalizeAttribution(attribution, warn);
    if (asked) return { source: "option", credits: asked.credits };
    const own = normalizeAttribution(level && level.attribution, warn);
    if (own) return { source: "level", credits: own.credits };
    if (cameOffACart(level)) return { source: "cart", credits: [] };
    const fallback = normalizeAttribution(cleanName(author), warn);
    if (fallback) return { source: "default", credits: fallback.credits };
    return { source: "none", credits: [] };
}

/** The three settings bytes (+0x5A..+0x5C) for a resolved roll. */
export function staffRolesFor(credits) {
    return Array.from({ length: ATTRIBUTION_ROLES }, (_, i) => Math.max(0, roleIndex(credits[i] ? credits[i].role : "")));
}

/**
 * The player's name off a process environment, handed in as a plain object
 * ({USER, LOGNAME, USERNAME, HOME, USERPROFILE}) so this stays free of any
 * runtime: the account name, else the name of the home directory — which is
 * the same word on most machines and the only one a sandbox that clears USER
 * leaves behind. Null when the environment says neither.
 */
export function authorFromEnvironment(env = {}) {
    const read = (key) => (typeof env[key] === "string" ? env[key].trim() : "");
    const user = read("USER") || read("LOGNAME") || read("USERNAME");
    if (user) return user;
    const home = (read("HOME") || read("USERPROFILE")).replace(/[\\/]+$/, "");
    return home.split(/[\\/]/).pop() || null;
}
