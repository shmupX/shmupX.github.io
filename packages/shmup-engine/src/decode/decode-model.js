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
//   +0x00  u16be shape descriptor (primitive family + variant; the mesh data
//          itself is engine-fixed inside the POLYKITI overlay, not the save)
//   +0x02  u16be pad (0 in the corpus)
//   +0x04  s32be x, y, z position, 16.16 fixed point (model units)
//   +0x10  u16be rotX, rotY, rotZ — full circle = 65536 (0x1999 = 36 deg)
//   +0x16  u16be pad (0 in the corpus)
//   +0x18  s32be scaleX, scaleY, scaleZ, signed 16.16 — negative mirrors
//          that axis (0x10000 = x1.0)
//
// The models are the 3D editor's user-built part compositions. They never
// affect play directly — ポリ吉 renders a composition into CG cells, and the
// game only ever draws those cells — so this decoder serves viewers and
// re-export tooling, not the runtime.
//
// Environment-neutral ESM (Node + browser).

export const SEC7_MAGIC = 0x12345678;
export const MODEL_SLOTS = 16;
export const MODEL_SLOT_SIZE = 328;
export const MAX_PARTS = 9;
const PART_SIZE = 36;

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const s32 = (b, o) =>
    (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) | 0);

function decodePart(bytes, off) {
    const shape = u16(bytes, off);
    return {
        shape,
        // Observed families across the disc corpus: 0x0-0x5 in the high
        // nibble with variant bits below. Which family is which primitive
        // (cube/cylinder/cone/sphere/plane) awaits a POLYKITI mesh trace, so
        // the split is carried as data, not names.
        shapeFamily: (shape >> 12) & 0xf,
        shapeVariant: shape & 0xfff,
        position: {
            x: s32(bytes, off + 0x04) / 65536,
            y: s32(bytes, off + 0x08) / 65536,
            z: s32(bytes, off + 0x0c) / 65536,
        },
        // degrees, engine-stored as a u16 circle (65536 = 360)
        rotation: {
            x: (u16(bytes, off + 0x10) * 360) / 65536,
            y: (u16(bytes, off + 0x12) * 360) / 65536,
            z: (u16(bytes, off + 0x14) * 360) / 65536,
        },
        // x1.0 = 1; a negative scale mirrors its axis
        scale: {
            x: s32(bytes, off + 0x18) / 65536,
            y: s32(bytes, off + 0x1c) / 65536,
            z: s32(bytes, off + 0x20) / 65536,
        },
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
            // RGB555 like the palette bank (R bits 0-4, G 5-9, B 10-14)
            color: u16(sec7, base + 2),
            parts,
        });
    }
    return { models };
}
