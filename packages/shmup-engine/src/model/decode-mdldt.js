// MDLDT_NN.CMP reader — the ポリ吉 part library's SGL meshes.
//
// Each of the disc's 56 MDLDT files decompresses (src/decompress.js
// decompressCmp: u32le stream length + Okumura LZSS) to an SGL model bank
// loaded at LWRAM 0x002F0000:
//
//   +0x00  12 x u32be pointers (absolute, base 0x002F0000) to PDATA records
//          in mesh-major order: mesh 0 colour set 0, 1, 2, then mesh 1 ...
//          so a file holds 4 meshes x 3 colour sets.
//   PDATA (24 B): u32 pntbl, u32 nbPoint, u32 pltbl, u32 nbPolygon,
//          u32 attbl, u32 0. The three PDATA of a mesh share pntbl and
//          pltbl and differ only in attbl (verified over all 224 meshes).
//   POINT (12 B): s32be x, y, z, 16.16.
//   POLYGON (20 B): s32be normal x, y, z (16.16) + 4 x u16be vertex index;
//          v[2] == v[3] marks a triangle.
//   ATTR (12 B per polygon): u8 flag, u8 sort, u16 texno, u16 atrb,
//          u16 colno (RGB555 | 0x8000), u16 gstb, u16 dir. Over the whole
//          library (45,648 records = 15,216 polygons x 3 colour sets) sort,
//          texno, atrb, gstb and dir are constant at 11 / 0 / 0xe8 / 0 / 4.
//          `flag` is NOT: it reads 0 on 45,516 records and 1 on 132. Those
//          132 are 44 distinct polygons, flagged identically in all three
//          colour sets, in exactly two meshes — library 148 (F3:8,
//          MDLDT_38 mesh 0, 32 of its 96 polygons) and library 171 (F3:31,
//          MDLDT_43 mesh 3, 12 of 72). Both meshes are open shells, and the
//          flagging tracks that: every polygon owning a boundary edge is
//          flagged (8 of 8 in mesh 148, 12 of 12 in mesh 171, and no
//          UNflagged polygon in either mesh touches one). The converse does
//          not hold — mesh 148 flags 24 further polygons that own no
//          boundary edge, so the rule is not simply "the open rim".
//
//          flag bit 0 is SGL's Single_Plane(0) / Dual_Plane(1), TRACED in
//          POLYKITI's own polygon loop rather than taken from the SGL
//          headers: at overlay +0xa894 `cmp/ge` is the back-face test, and
//          on failure it falls to +0xa8a2 `tst #1,r0` (r0 = the flag byte,
//          swapped in from the ATTR word at +0xa868). Bit clear branches to
//          +0xa8ba `bra`, which skips the polygon; bit set falls through to
//          +0xa8a8, which NEGATES the three view-space normal components
//          and submits the polygon anyway. So a dual-plane polygon is drawn
//          from both sides, and its back side is shaded with the flipped
//          normal — which is what src/model/model-mesh.js reproduces.
//
//          `sort` = 11 = SORT_CEN (bits 0-1 = 3) | 0x08 (use the light
//          table). Also traced: the ATTR word indexes a 16-byte-per-entry
//          stage table at overlay +0xa928 by (sort & 0x7f); entry 11's
//          depth-key routine is +0xb68c, which sums the FOUR vertices' z
//          and divides by 4 (`shlr16` / `exts.w` / two `shar`), while
//          entries 1, 2 and 0 point at +0xb648 (min), +0xb6cc (max) and
//          +0xb710 (reuse the previous key) — SGL's SORT_MIN / SORT_MAX /
//          SORT_BFR in their documented order. Entry 11's colour stage is
//          +0xb128, the shader FORMAT.md already traced. A renderer
//          therefore needs colno, the flag, and a centroid depth key.
//
// Totals over the library: 224 meshes, 14,345 vertices, 15,216 polygons
// (27,124 triangles). MDLDT_54 mesh 0 is the +-20.5 cube; its colour sets
// are 0x800f (all faces), a per-face 0x83e0/0x801f/0xfc00/0x801f/0x83ff/0xfc00,
// and 0xd294 (all faces).
//
// The caller supplies decompressed bytes — the disc never ships with this
// package — and gets Mesh objects (see src/model/mesh-library.js) back.
//
// Environment-neutral ESM (Node + browser).

import {
    familyForFile,
    FAMILY_OFFSETS,
    familyOfLibraryIndex,
    LIBRARY_MESH_COUNT,
    makeMesh,
    MESHES_PER_FILE,
    placeholderMesh,
} from "./mesh-library.js";

export const MDLDT_BASE = 0x002f0000;
export const MDLDT_FILE_COUNT = 56;
export const PDATA_PER_FILE = 12;
const PDATA_SIZE = 24;
const POINT_SIZE = 12;
const POLYGON_SIZE = 20;
const ATTR_SIZE = 12;
const COLOR_SETS = 3;

function view(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readPdata(dv, at) {
    return {
        pntbl: dv.getUint32(at) - MDLDT_BASE,
        nbPoint: dv.getUint32(at + 4),
        pltbl: dv.getUint32(at + 8) - MDLDT_BASE,
        nbPolygon: dv.getUint32(at + 12),
        attbl: dv.getUint32(at + 16) - MDLDT_BASE,
    };
}

/**
 * Decode one decompressed MDLDT file into its four meshes. `file` (1-56)
 * tags each mesh with its family and mesh index; without it they are -1.
 */
export function decodeMdldt(bytes, { file = 0 } = {}) {
    if (!bytes || bytes.length < PDATA_PER_FILE * 4) {
        throw new Error("MDLDT: too short for a pointer table");
    }
    const dv = view(bytes);
    const slice = file ? familyForFile(file) : null;
    const meshes = [];
    for (let m = 0; m < MESHES_PER_FILE; m++) {
        const sets = [];
        for (let s = 0; s < COLOR_SETS; s++) {
            const ptr = dv.getUint32((m * COLOR_SETS + s) * 4) - MDLDT_BASE;
            if (ptr < 0 || ptr + PDATA_SIZE > bytes.length) {
                throw new Error(`MDLDT: PDATA ${m * COLOR_SETS + s} out of range`);
            }
            sets.push(readPdata(dv, ptr));
        }
        const base = sets[0];
        for (const other of sets) {
            if (
                other.pntbl !== base.pntbl || other.pltbl !== base.pltbl ||
                other.nbPoint !== base.nbPoint ||
                other.nbPolygon !== base.nbPolygon
            ) {
                throw new Error(`MDLDT: mesh ${m}'s colour sets disagree on geometry`);
            }
        }
        const end = Math.max(
            base.pntbl + base.nbPoint * POINT_SIZE,
            base.pltbl + base.nbPolygon * POLYGON_SIZE,
            ...sets.map((s) => s.attbl + base.nbPolygon * ATTR_SIZE),
        );
        if (end > bytes.length) throw new Error(`MDLDT: mesh ${m} runs past the file`);

        const vertices = new Float32Array(base.nbPoint * 3);
        for (let i = 0; i < base.nbPoint * 3; i++) {
            vertices[i] = dv.getInt32(base.pntbl + i * 4) / 65536;
        }
        const polygons = new Uint16Array(base.nbPolygon * 4);
        const normals = new Float32Array(base.nbPolygon * 3);
        for (let q = 0; q < base.nbPolygon; q++) {
            const at = base.pltbl + q * POLYGON_SIZE;
            normals[q * 3] = dv.getInt32(at) / 65536;
            normals[q * 3 + 1] = dv.getInt32(at + 4) / 65536;
            normals[q * 3 + 2] = dv.getInt32(at + 8) / 65536;
            for (let k = 0; k < 4; k++) {
                const index = dv.getUint16(at + 12 + k * 2);
                if (index >= base.nbPoint) {
                    throw new Error(`MDLDT: mesh ${m} polygon ${q} indexes vertex ${index}`);
                }
                polygons[q * 4 + k] = index;
            }
        }
        const colorSets = sets.map((s) => {
            const colors = new Uint16Array(base.nbPolygon);
            for (let q = 0; q < base.nbPolygon; q++) {
                colors[q] = dv.getUint16(s.attbl + q * ATTR_SIZE + 6) & 0x7fff;
            }
            return colors;
        });
        // The dual-plane flag belongs to the polygon, not to a colour set:
        // the library agrees across all three copies on every flagged
        // polygon, so read it from the first and check the others rather
        // than assume it (the same way the geometry is cross-checked above).
        const dualPlane = new Uint8Array(base.nbPolygon);
        for (let q = 0; q < base.nbPolygon; q++) {
            dualPlane[q] = dv.getUint8(sets[0].attbl + q * ATTR_SIZE) & 1;
        }
        for (const other of sets) {
            for (let q = 0; q < base.nbPolygon; q++) {
                if ((dv.getUint8(other.attbl + q * ATTR_SIZE) & 1) !== dualPlane[q]) {
                    throw new Error(
                        `MDLDT: mesh ${m} polygon ${q} disagrees on the dual-plane flag between colour sets`,
                    );
                }
            }
        }
        meshes.push(makeMesh({
            vertices,
            polygons,
            normals,
            colorSets,
            dualPlane,
            source: "mdldt",
            family: slice ? slice.family : -1,
            meshIndex: slice ? slice.firstMeshIndex + m : -1,
        }));
    }
    return meshes;
}

/**
 * Assemble the 224-mesh library from decompressed MDLDT files. `files[n - 1]`
 * is MDLDT_NN; a missing (null) file is back-filled with placeholders so a
 * partial set still yields a complete library.
 */
export function buildMeshLibrary(files) {
    const meshes = new Array(LIBRARY_MESH_COUNT).fill(null);
    let real = 0;
    for (let file = 1; file <= MDLDT_FILE_COUNT; file++) {
        const bytes = files[file - 1];
        if (!bytes) continue;
        const slice = familyForFile(file);
        const decoded = decodeMdldt(bytes, { file });
        for (let m = 0; m < decoded.length; m++) {
            const index = FAMILY_OFFSETS[slice.family] + slice.firstMeshIndex + m;
            meshes[index] = decoded[m];
            real++;
        }
    }
    for (let i = 0; i < LIBRARY_MESH_COUNT; i++) {
        if (meshes[i]) continue;
        const { family, meshIndex } = familyOfLibraryIndex(i);
        meshes[i] = placeholderMesh(family, meshIndex);
    }
    return {
        meshes,
        familyOffsets: FAMILY_OFFSETS,
        source: real === LIBRARY_MESH_COUNT ? "mdldt" : real ? "partial" : "placeholder",
        realMeshes: real,
    };
}
