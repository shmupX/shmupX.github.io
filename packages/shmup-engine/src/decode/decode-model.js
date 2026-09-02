// Dezaemon 2 sec7 decoder — the ポリ吉 (POLYKITI) 3D model section.
//
// Layout (FORMAT.md "Section semantics", confirmed against POLYKITI.bin's
// literal pools — HWRAM working base 0x06097E90, stride 0x148, end 0x1484 —
// and against SGM_DAIO's populated section):
//
//   +0x00  u32be magic 0x12345678. Absent = the save never opened the 3D
//          editor; the section is then all-zero or residual RAM (ELFI's
//          "custom" sec7 is uninitialized garbage) and holds no models.
//   +0x04  16 model slots x 328 bytes:
//            u16be part count (0-9), u16be model color,
//            9 part records x 36 bytes
//   then 576 residual bytes.
//
// Part record (36 B) — offsets confirmed by parsing SGM_DAIO (35 of its 37
// parts carry zero in both pad words; the other two put a Z rotation where a
// misaligned read would see a pad, which is what pinned the layout):
//
//   +0x00  u16be shape word — see below
//   +0x02  u16be pad (0 in the corpus)
//   +0x04  s32be x, y, z position, 16.16 fixed point (model units)
//   +0x10  u16be rotX, rotY, rotZ — full circle = 65536 (0x1999 = 36 deg)
//   +0x16  u16be pad (0 in the corpus)
//   +0x18  s32be scaleX, scaleY, scaleZ, signed 16.16 — negative mirrors
//          that axis (0x10000 = x1.0)
//
// The shape word, TRACED from the POLYKITI overlay's resolver (file +0xce4,
// 2026-09-02) after a corpus read of 2,814 parts had guessed it:
//
//   bits 12-15  family      0-5, the six part pages (the switch rejects >5)
//   bits  8-11  colour set  0-2, which of a mesh's three colour tables
//   bits  0-7   mesh index  into the family's slice of the 224-mesh library
//   In the corpus bits 7, 10, 11 and 15 are never set and bits 8-9 never
//   hold 3, so a narrower 3/2/7 reading gives the same values; the widths
//   above are what the engine masks.
//
// The meshes themselves are NOT in the save: MDLDT_01-56.CMP on the disc are
// the part library, 56 files x 4 meshes, each mesh stored as three SGL PDATA
// copies that share vertices and polygons and differ only in the per-polygon
// colour table. The resolver adds a per-family constant to the mesh index —
// 0, 32, 104, 140, 176, 212, immediates in a switch — and loads file
// (sum >> 2) from a table that runs MDLDT_01 upward (+0xdc7c), then picks
// PDATA (sum & 3) * 3 + colourSet out of the file's twelve. So families 0-5
// are files 01-08 / 09-26 / 27-35 / 36-44 / 45-53 / 54-56, ascending, which
// FAMILY_FILE_RANGES records. DAIOH's picture-frame model uses 0x5000 and
// 0x5200 for the same cube in two colours.
//
// See src/model/mesh-library.js for the library index and
// src/model/decode-mdldt.js for the mesh reader.
//
// The per-MODEL u16 colour (RGB555, bit 15 clear; edited by a three-channel
// picker in the overlay, +0x3ac4) is a whole-model TINT, traced through the
// shader: each polygon's own channel c renders as
// clamp(c + tint_c - 31 + light, floor_c, 31). White is neutral.
//
// The models never affect play directly — ポリ吉 renders a composition into
// CG cells, and the game only ever draws those cells — so this decoder
// serves viewers and re-export tooling, not the runtime.
//
// Environment-neutral ESM (Node + browser).

export const SEC7_MAGIC = 0x12345678;
export const MODEL_SLOTS = 16;
export const MODEL_SLOT_SIZE = 328;
export const MAX_PARTS = 9;
const PART_SIZE = 36;

/** The six part pages of the ポリ吉 editor. */
export const SHAPE_FAMILIES = 6;
/** Meshes per family in the 224-mesh MDLDT library (forced by corpus maxima). */
export const FAMILY_MESH_COUNTS = [32, 72, 36, 36, 36, 12];
/** MDLDT_NN.CMP file ranges per family, 1-based, inclusive (4 meshes/file). */
export const FAMILY_FILE_RANGES = [
    [1, 8],
    [9, 26],
    [27, 35],
    [36, 44],
    [45, 53],
    [54, 56],
];

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const s32 = (b, o) =>
    (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) | 0);

function decodePart(bytes, off) {
    const shape = u16(bytes, off);
    const scale = {
        x: s32(bytes, off + 0x18) / 65536,
        y: s32(bytes, off + 0x1c) / 65536,
        z: s32(bytes, off + 0x20) / 65536,
    };
    return {
        shape,
        shapeFamily: (shape >> 12) & 0xf,
        // Kept for compatibility: the low 12 bits as one number. The two
        // fields below are its decoded halves, masked the way the engine
        // masks them.
        shapeVariant: shape & 0xfff,
        colorSet: (shape >> 8) & 0xf,
        meshIndex: shape & 0xff,
        position: {
            x: s32(bytes, off + 0x04) / 65536,
            y: s32(bytes, off + 0x08) / 65536,
            z: s32(bytes, off + 0x0c) / 65536,
        },
        // degrees, engine-stored as a u16 circle (65536 = 360). The editor
        // steps rotations by 18 degrees (65536/20) and stores them with a
        // rounding drift of one or two raw units — round, never compare.
        rotation: {
            x: (u16(bytes, off + 0x10) * 360) / 65536,
            y: (u16(bytes, off + 0x12) * 360) / 65536,
            z: (u16(bytes, off + 0x14) * 360) / 65536,
        },
        // x1.0 = 1; a negative scale mirrors its axis (the editor almost
        // always mirrors Y)
        scale,
        mirrored: scale.x * scale.y * scale.z < 0,
    };
}

// Decode a decompressed sec7. Returns null when the section was never
// initialized (no magic); otherwise { models } where models keeps one entry
// per NON-EMPTY slot: { slot, color, parts }.
export function decodeModels(sec7) {
    if (!sec7 || sec7.length < 4 + MODEL_SLOTS * MODEL_SLOT_SIZE) return null;
    const magic = (s32(sec7, 0) >>> 0);
    if (magic !== SEC7_MAGIC) return null;
    const models = [];
    for (let slot = 0; slot < MODEL_SLOTS; slot++) {
        const base = 4 + slot * MODEL_SLOT_SIZE;
        const partCount = u16(sec7, base);
        if (partCount === 0 || partCount > MAX_PARTS) continue;
        const parts = [];
        for (let p = 0; p < partCount; p++) {
            parts.push(decodePart(sec7, base + 4 + p * PART_SIZE));
        }
        models.push({
            slot,
            // RGB555 like the palette bank (R bits 0-4, G 5-9, B 10-14):
            // the whole-model tint the renderer folds into every polygon
            // colour (see the header); 0x7fff is neutral
            color: u16(sec7, base + 2),
            parts,
        });
    }
    return { models };
}
