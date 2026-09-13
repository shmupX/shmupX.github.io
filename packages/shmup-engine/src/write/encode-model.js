// The inverse of src/decode/decode-model.js: a level's ポリ吉 models back into
// a raw sec7 section.
//
// Layout (see decode-model.js for the trace and FORMAT.md's "Section
// semantics"): u32be magic 0x12345678, then 16 slots x 328 bytes (u16be part
// count 0-9, u16be model colour, 9 part records x 36 B), then 576 residual
// bytes. 4 + 16*328 + 576 = 5,828 = SECTION_SIZES[7].
//
// A save with no models is written as ALL ZERO rather than as a magic with 16
// empty slots. That is what the Saturn leaves behind when the 3D editor was
// never opened, and what decodeModels reads as "no models" — writing the magic
// alone would claim the editor had been opened.
//
// WHAT ROUND-TRIPS. `decodeModels(encodeModels(m))` reproduces `m` exactly:
// every field the decoder reads is written back, including the model colour
// word UNMASKED (21 % of the corpus sets bit 15, so masking it would silently
// rewrite 119 of 564 models).
//
// What does NOT round-trip byte-for-byte is the residue the Saturn ignores.
// Measured over dev-fixtures: 289 decodable saves, 176 carrying the magic, of
// which 84 hold at least one model (564 models, 3,165 parts) and 92 opened the
// 3D editor without keeping anything. Among those 84:
//
//   - part records past a slot's part count keep stale bytes in 218 slots
//   - the 576 trailing bytes are non-zero in 32 saves
//
// Both are dead to the reader — part count bounds the parts, and nothing
// indexes past the slot table — so this module zeroes them. 22 of the 84
// re-encode byte-identically; the other 62 differ ONLY in those dead bytes,
// and all 84 satisfy decodeModels(encodeModels(x)) === x. The same survey
// found nothing else worth preserving: no slot anywhere has a part count above
// 9, no empty slot carries data, and the two pad words inside a part record
// (+0x02 and +0x16) are zero in all 3,165 parts.
//
// The 92 magic-but-empty saves do NOT survive as such: with no models to
// write, this emits the all-zero section, so they come back as "never opened"
// rather than "opened and empty". Nothing downstream distinguishes the two —
// map-to-game.js only carries `dezaemonModels` when a save has models — and
// zero is the safer default for a level that was authored from scratch.
//
// Environment-neutral ESM (Node + browser).

import {
    MAX_PARTS,
    MODEL_SLOT_SIZE,
    MODEL_SLOTS,
    SEC7_MAGIC,
} from "../decode/decode-model.js";

/** Raw size of section 7 — SECTION_SIZES[7]. */
export const SEC7_SIZE = 4 + MODEL_SLOTS * MODEL_SLOT_SIZE + 576;
const PART_SIZE = 36;
/** Neutral tint: white, which the shader folds in as the identity. */
export const NEUTRAL_COLOR = 0x7fff;

const S32_MIN = -0x80000000;
const S32_MAX = 0x7fffffff;

function putU16(bytes, at, v) {
    bytes[at] = (v >> 8) & 0xff;
    bytes[at + 1] = v & 0xff;
}

function putS32(bytes, at, v) {
    bytes[at] = (v >> 24) & 0xff;
    bytes[at + 1] = (v >> 16) & 0xff;
    bytes[at + 2] = (v >> 8) & 0xff;
    bytes[at + 3] = v & 0xff;
}

/** A 16.16 fixed-point field, clamped to what an s32 can hold. */
function fixed16(value) {
    if (!Number.isFinite(value)) return 0;
    const raw = Math.round(value * 65536);
    return raw < S32_MIN ? S32_MIN : raw > S32_MAX ? S32_MAX : raw;
}

/**
 * Degrees back to the engine's u16 circle (65536 = 360), wrapping rather than
 * clamping: the decoder produced these by dividing, and -90 and 270 are the
 * same rotation. Round, never truncate — the editor's own 18-degree steps are
 * stored with a one- or two-unit drift.
 */
export function encodeRotation(deg) {
    if (!Number.isFinite(deg)) return 0;
    const raw = Math.round((deg * 65536) / 360);
    return ((raw % 65536) + 65536) % 65536;
}

/**
 * The u16 shape word. `shape` wins when a part carries one (an imported part
 * always does, and it is the only field that survives a family/mesh reading
 * the engine masks differently); otherwise it is composed from the decoded
 * halves the way the resolver reads them — family bits 12-15, colour set bits
 * 8-11, mesh index bits 0-7.
 */
export function encodeShapeWord(part) {
    if (Number.isInteger(part.shape)) return part.shape & 0xffff;
    const family = (part.shapeFamily | 0) & 0xf;
    const colorSet = (part.colorSet | 0) & 0xf;
    const meshIndex = (part.meshIndex | 0) & 0xff;
    return (family << 12) | (colorSet << 8) | meshIndex;
}

function encodePart(bytes, at, part) {
    const pos = part.position || {};
    const rot = part.rotation || {};
    const scale = part.scale || {};
    putU16(bytes, at, encodeShapeWord(part));
    // +0x02 and +0x16 are pad words: zero in all 3,165 corpus parts.
    putS32(bytes, at + 0x04, fixed16(pos.x));
    putS32(bytes, at + 0x08, fixed16(pos.y));
    putS32(bytes, at + 0x0c, fixed16(pos.z));
    putU16(bytes, at + 0x10, encodeRotation(rot.x));
    putU16(bytes, at + 0x12, encodeRotation(rot.y));
    putU16(bytes, at + 0x14, encodeRotation(rot.z));
    // A scale of 0 would collapse the part; the decoder's own default is 1.
    putS32(bytes, at + 0x18, fixed16(scale.x === undefined ? 1 : scale.x));
    putS32(bytes, at + 0x1c, fixed16(scale.y === undefined ? 1 : scale.y));
    putS32(bytes, at + 0x20, fixed16(scale.z === undefined ? 1 : scale.z));
}

/**
 * Models -> a raw sec7 section (Uint8Array of SEC7_SIZE).
 *
 * `models` is what decodeModels returns — either `{ models: [...] }` or the
 * array itself — each entry `{ slot, color, parts }` with `parts` as
 * decode-model.js emits them. Null, undefined or an empty list gives the
 * all-zero section.
 *
 * Entries the format cannot hold are SKIPPED, not thrown on, so one bad model
 * never costs a caller the whole export; pass `warn` to hear about them.
 */
export function encodeModels(models, { warn } = {}) {
    const bytes = new Uint8Array(SEC7_SIZE);
    const list = Array.isArray(models) ? models : (models && models.models);
    if (!Array.isArray(list) || !list.length) return bytes;

    const say = typeof warn === "function" ? warn : () => {};
    const taken = new Map();
    let written = 0;
    list.forEach((model, index) => {
        if (!model || typeof model !== "object") return;
        // An entry without a slot takes the next free one, so a caller can
        // hand over a bare list of models.
        let slot = Number.isInteger(model.slot) ? model.slot : -1;
        if (slot < 0 || slot >= MODEL_SLOTS) {
            if (Number.isInteger(model.slot)) {
                say(`3D model ${index}: slot ${model.slot} is outside 0-${MODEL_SLOTS - 1} — skipped`);
                return;
            }
            slot = 0;
            while (slot < MODEL_SLOTS && taken.has(slot)) slot++;
            if (slot >= MODEL_SLOTS) {
                say(`3D model ${index}: no free slot among ${MODEL_SLOTS} — skipped`);
                return;
            }
        }
        const parts = Array.isArray(model.parts) ? model.parts : [];
        if (!parts.length) {
            say(`3D model ${index} (slot ${slot}): no parts — skipped`);
            return;
        }
        if (taken.has(slot)) {
            say(`3D model ${index}: slot ${slot} already holds model ${taken.get(slot)} — skipped`);
            return;
        }
        let use = parts;
        if (parts.length > MAX_PARTS) {
            say(
                `3D model ${index} (slot ${slot}): ${parts.length} parts, the format holds ${MAX_PARTS} — the rest are dropped`,
            );
            use = parts.slice(0, MAX_PARTS);
        }
        taken.set(slot, index);
        const base = 4 + slot * MODEL_SLOT_SIZE;
        putU16(bytes, base, use.length);
        // Written UNMASKED: bit 15 is set on 21 % of corpus models, and the
        // renderer — not the file — is what masks it down to RGB555.
        putU16(bytes, base + 2, Number.isInteger(model.color) ? model.color & 0xffff : NEUTRAL_COLOR);
        use.forEach((part, p) => {
            if (part && typeof part === "object") {
                encodePart(bytes, base + 4 + p * PART_SIZE, part);
            }
        });
        written++;
    });

    // No magic unless something was actually written, so a level whose models
    // were all unusable still reads as "the 3D editor was never opened"
    // rather than as sixteen empty slots.
    if (written) putS32(bytes, 0, SEC7_MAGIC | 0);
    return bytes;
}
