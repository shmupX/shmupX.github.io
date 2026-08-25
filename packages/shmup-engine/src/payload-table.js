// Dezaemon 2 payload section table.
//
// A DEZA2____NN game payload starts with a 0x6C-byte table followed by 8
// concatenated sections that consume the payload exactly:
//
//   +0x00  u32 BE  checksumTotal — sum of the 8 section checksums
//   +0x04  u32 BE  tableAddr — LWRAM address this table is staged at when the
//                  game saves/loads (0x002C8A84 in every save seen so far);
//                  sections begin at tableAddr + 0x6C
//   +0x08  u32 BE  endAddr — last section's addr + size
//   +0x0C  8 × { u32 checksum, u32 lwramAddr, u32 size }
//
// Section checksums are plain 32-bit sums of the section's bytes, section
// addresses chain contiguously, and 0x6C + Σsizes === datasize. All of that
// is validated here — it doubles as an end-to-end proof that block-accurate
// payload reassembly worked.
//
// The sections themselves are compressed by the game (the "COMPRESS POINT"
// screen); see FORMAT.md for the current state of that reverse-engineering.

export const TABLE_SIZE = 0x6c;
export const SECTION_COUNT = 8;

export function byteSum(data, start, end) {
    let s = 0;
    for (let i = start; i < end; i++) s = (s + data[i]) >>> 0;
    return s;
}

// Parse (and by default validate) the section table of a game payload.
// Returns { checksumTotal, tableAddr, endAddr, sections } where each section
// is { index, checksum, addr, size, offset } (`offset` is payload-relative).
export function parseSectionTable(payload, { validate = true } = {}) {
    if (payload.length < TABLE_SIZE) {
        throw new Error(`payload too small for a section table (${payload.length} < ${TABLE_SIZE} bytes)`);
    }
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const table = {
        checksumTotal: dv.getUint32(0),
        tableAddr: dv.getUint32(4),
        endAddr: dv.getUint32(8),
        sections: [],
    };
    let offset = TABLE_SIZE;
    for (let i = 0; i < SECTION_COUNT; i++) {
        const p = 0x0c + i * 12;
        const section = {
            index: i,
            checksum: dv.getUint32(p),
            addr: dv.getUint32(p + 4),
            size: dv.getUint32(p + 8),
            offset,
        };
        table.sections.push(section);
        offset += section.size;
    }
    if (validate) validateSectionTable(payload, table);
    return table;
}

// Throws with a precise message on the first inconsistency.
export function validateSectionTable(payload, table) {
    const { sections } = table;
    const total = sections.reduce((a, s) => a + s.size, TABLE_SIZE);
    if (total !== payload.length) {
        throw new Error(`section sizes + table (${total}) != payload length (${payload.length})`);
    }
    if (sections[0].addr !== table.tableAddr + TABLE_SIZE) {
        throw new Error(
            `section 0 addr 0x${sections[0].addr.toString(16)} != tableAddr+0x6C 0x${(table.tableAddr + TABLE_SIZE).toString(16)}`
        );
    }
    for (let i = 1; i < sections.length; i++) {
        const expected = sections[i - 1].addr + sections[i - 1].size;
        if (sections[i].addr !== expected) {
            throw new Error(
                `section ${i} addr 0x${sections[i].addr.toString(16)} breaks the chain (expected 0x${expected.toString(16)})`
            );
        }
    }
    const last = sections[sections.length - 1];
    if (table.endAddr !== last.addr + last.size) {
        throw new Error(
            `endAddr 0x${table.endAddr.toString(16)} != last section end 0x${(last.addr + last.size).toString(16)}`
        );
    }
    let sum = 0;
    for (const s of sections) {
        const actual = byteSum(payload, s.offset, s.offset + s.size);
        if (actual !== s.checksum) {
            throw new Error(
                `section ${s.index} checksum mismatch: stored 0x${s.checksum.toString(16)}, computed 0x${actual.toString(16)}`
            );
        }
        sum = (sum + s.checksum) >>> 0;
    }
    if (sum !== table.checksumTotal) {
        throw new Error(
            `checksumTotal 0x${table.checksumTotal.toString(16)} != sum of section checksums 0x${sum.toString(16)}`
        );
    }
}

// True if this directory entry looks like a Dezaemon 2 game save (as opposed
// to the DEZA2___SYS settings record or a non-Dezaemon save).
export function isGameSave(entry) {
    return /^DEZA2____\d\d$/.test(entry.filename);
}
