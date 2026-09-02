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
//          u16 colno (RGB555 | 0x8000), u16 gstb, u16 dir. Every polygon in
//          the library reads 0 / 11 / 0 / 0xe8 / colour / 0 / 4, so colno is
//          the only field a renderer needs.
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
        meshes.push(makeMesh({
            vertices,
            polygons,
            normals,
            colorSets,
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
