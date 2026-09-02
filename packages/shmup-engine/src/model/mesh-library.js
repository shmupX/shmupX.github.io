// The ポリ吉 (POLYKITI) part library: what a sec7 shape word points at.
//
// A Dezaemon 2 model is a composition of up to nine PARTS, each a transform
// over one mesh of a fixed 224-mesh library that lives on the disc as
// MDLDT_01-56.CMP (56 files x 4 meshes; see src/model/decode-mdldt.js). The
// shape word's family (0-5) and mesh index select the mesh; its colour set
// (0-2) selects one of the three per-polygon colour tables every mesh
// carries. This module is the index into that library plus two things that
// do not need the disc:
//
//   - a PLACEHOLDER library: family 5 (the geometric-primitive page: cube,
//     sphere, wedge, hex prism, cylinder and their flatter re-issues) is
//     regenerated procedurally from the disc's measured dimensions, family 4
//     (all 43x70x10 plates) is a plate, families 0-3 (organic hull / wing /
//     gun catalogues) are sized boxes. Every placeholder says so in `source`.
//   - the JSON form of a library, which is how the real one is shipped
//     (static/editor/dezaemon/mesh-library.json, built by
//     `deno task deza:meshlib` from a local disc image).
//
// Mesh shape, shared by every producer and consumer:
//
//   {
//     vertices:  Float32Array, xyz per vertex, model units (authored inside
//                about +-35; the cube is +-20.5)
//     polygons:  Uint16Array, 4 vertex indices per polygon; v[2] === v[3]
//                marks a triangle (the SGL POLYGON convention)
//     normals:   Float32Array, xyz per polygon. SGL stores them, and they
//                equal cross(v2 - v0, v1 - v0) normalised — the Saturn's
//                left-handed convention, i.e. the NEGATIVE of the right-hand
//                rule. polygonNormals() reproduces that, so a mesh built
//                here and a mesh read off the disc agree.
//     colorSets: [Uint16Array x3], RGB555 per polygon, bit 15 masked
//     source:    "mdldt" | "placeholder"
//     family, meshIndex
//   }
//
// Family -> library slice sizes (32/72/36/36/36/12) are forced by the corpus
// index maxima; family 4 and 5 are pinned to MDLDT_45-53 / 54-56 by their
// content, and the ascending order of families 0-3 is an assumption that a
// rendered DAIOH ship either confirms or refutes. mdldtFileFor() is the one
// place that order lives.
//
// Environment-neutral ESM (Node + browser).

import {
    FAMILY_FILE_RANGES,
    FAMILY_MESH_COUNTS,
    SHAPE_FAMILIES,
} from "../decode/decode-model.js";

export const LIBRARY_MESH_COUNT = 224;
export const COLOR_SETS = 3;
export const MESHES_PER_FILE = 4;
/** Authoring envelope of a library mesh, in model units. */
export const MODEL_UNIT_RADIUS = 35;

/** First library index of each family: [0, 32, 104, 140, 176, 212]. */
export const FAMILY_OFFSETS = (() => {
    const offsets = [];
    let at = 0;
    for (const count of FAMILY_MESH_COUNTS) {
        offsets.push(at);
        at += count;
    }
    return offsets;
})();

/** 0..223, or -1 when the (family, meshIndex) pair is outside the library. */
export function libraryIndex(family, meshIndex) {
    if (family < 0 || family >= SHAPE_FAMILIES) return -1;
    if (meshIndex < 0 || meshIndex >= FAMILY_MESH_COUNTS[family]) return -1;
    return FAMILY_OFFSETS[family] + meshIndex;
}

/** Inverse of libraryIndex: { family, meshIndex } for 0..223. */
export function familyOfLibraryIndex(index) {
    for (let family = SHAPE_FAMILIES - 1; family >= 0; family--) {
        if (index >= FAMILY_OFFSETS[family]) {
            return { family, meshIndex: index - FAMILY_OFFSETS[family] };
        }
    }
    return null;
}

/** Which MDLDT_NN.CMP holds a mesh, and where inside it (0-3). */
export function mdldtFileFor(family, meshIndex) {
    if (libraryIndex(family, meshIndex) < 0) return null;
    return {
        file: FAMILY_FILE_RANGES[family][0] + (meshIndex >> 2),
        meshInFile: meshIndex & 3,
    };
}

/** The family and first mesh index an MDLDT file (1-56) contributes. */
export function familyForFile(file) {
    for (let family = 0; family < SHAPE_FAMILIES; family++) {
        const [first, last] = FAMILY_FILE_RANGES[family];
        if (file >= first && file <= last) {
            return { family, firstMeshIndex: (file - first) * MESHES_PER_FILE };
        }
    }
    return null;
}

export function mdldtFileName(file) {
    return `MDLDT_${String(file).padStart(2, "0")}.CMP`;
}

// ---------------------------------------------------------------------------
// Mesh construction

export function polygonCount(mesh) {
    return mesh.polygons.length >> 2;
}

// Polygon normals in the SGL convention (see the header). Newell's method
// over the polygon's vertices, negated: Newell follows the right-hand rule,
// the Saturn stores the opposite. Triangles repeat their last vertex, which
// Newell tolerates (a zero-length edge contributes nothing).
export function polygonNormals(vertices, polygons) {
    const count = polygons.length >> 2;
    const normals = new Float32Array(count * 3);
    for (let q = 0; q < count; q++) {
        let nx = 0, ny = 0, nz = 0;
        for (let k = 0; k < 4; k++) {
            const a = polygons[q * 4 + k] * 3;
            const b = polygons[q * 4 + ((k + 1) & 3)] * 3;
            const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
            const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
            nx += (ay - by) * (az + bz);
            ny += (az - bz) * (ax + bx);
            nz += (ax - bx) * (ay + by);
        }
        const len = Math.hypot(nx, ny, nz) || 1;
        normals[q * 3] = -nx / len;
        normals[q * 3 + 1] = -ny / len;
        normals[q * 3 + 2] = -nz / len;
    }
    return normals;
}

/** Build a Mesh from loose arrays; normals are computed unless given. */
export function makeMesh({
    vertices,
    polygons,
    colorSets,
    normals,
    source = "placeholder",
    family = -1,
    meshIndex = -1,
}) {
    const v = vertices instanceof Float32Array ? vertices : Float32Array.from(vertices);
    const p = polygons instanceof Uint16Array ? polygons : Uint16Array.from(polygons);
    const count = p.length >> 2;
    const sets = [];
    for (let s = 0; s < COLOR_SETS; s++) {
        const src = colorSets && colorSets[s];
        const set = new Uint16Array(count);
        if (src) {
            for (let q = 0; q < count; q++) set[q] = src[q % src.length] & 0x7fff;
        }
        sets.push(set);
    }
    return {
        vertices: v,
        polygons: p,
        normals: normals ? Float32Array.from(normals) : polygonNormals(v, p),
        colorSets: sets,
        source,
        family,
        meshIndex,
    };
}

/** Axis-aligned bounds and the framing radius (max distance from the origin). */
export function meshBounds(mesh) {
    const v = mesh.vertices;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let radius = 0;
    for (let i = 0; i < v.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            if (v[i + k] < min[k]) min[k] = v[i + k];
            if (v[i + k] > max[k]) max[k] = v[i + k];
        }
        radius = Math.max(radius, Math.hypot(v[i], v[i + 1], v[i + 2]));
    }
    if (!v.length) return { min: [0, 0, 0], max: [0, 0, 0], radius: 0 };
    return { min, max, radius };
}

// ---------------------------------------------------------------------------
// Placeholder primitives
//
// Generators emit polygons in any order and then orientOutward() flips the
// ones whose SGL normal points at the origin — every primitive here is
// convex and centred, so "away from the origin" is "outside".

// The disc's own colour sets for family 5 (MDLDT_54 mesh 0): set 0 is a
// flat dark red, set 1 cycles four saturated colours per face, set 2 is a
// flat grey. Using the same values keeps DAIOH's picture frame (0x5000 posts
// vs 0x5200 bars) readable even without the disc library.
export const PLACEHOLDER_COLOR_SETS = [
    [0x000f],
    [0x03e0, 0x001f, 0x7c00, 0x03ff],
    [0x5294],
];

function orientOutward(vertices, polygons) {
    const normals = polygonNormals(vertices, polygons);
    for (let q = 0; q < polygons.length >> 2; q++) {
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < 4; k++) {
            const a = polygons[q * 4 + k] * 3;
            cx += vertices[a];
            cy += vertices[a + 1];
            cz += vertices[a + 2];
        }
        const dot = normals[q * 3] * cx + normals[q * 3 + 1] * cy +
            normals[q * 3 + 2] * cz;
        if (dot < 0) {
            const a = polygons[q * 4], b = polygons[q * 4 + 1];
            const c = polygons[q * 4 + 2], d = polygons[q * 4 + 3];
            if (c === d) {
                polygons[q * 4] = a;
                polygons[q * 4 + 1] = c;
                polygons[q * 4 + 2] = b;
                polygons[q * 4 + 3] = b;
            } else {
                polygons[q * 4] = d;
                polygons[q * 4 + 1] = c;
                polygons[q * 4 + 2] = b;
                polygons[q * 4 + 3] = a;
            }
        }
    }
}

function primitive(vertices, polygons, meta) {
    const v = Float32Array.from(vertices);
    const p = Uint16Array.from(polygons);
    orientOutward(v, p);
    return makeMesh({
        vertices: v,
        polygons: p,
        colorSets: PLACEHOLDER_COLOR_SETS,
        source: "placeholder",
        ...meta,
    });
}

/** Prism over a polygon in the XZ plane: ring = [[x, z] ...], extruded to +-hy. */
function prismMesh(ring, hy, meta) {
    const n = ring.length;
    const vertices = [];
    for (const [x, z] of ring) vertices.push(x, hy, z);
    for (const [x, z] of ring) vertices.push(x, -hy, z);
    const polygons = [];
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        polygons.push(i, j, n + j, n + i);
    }
    // Caps as a fan of quads from vertex 0 (a final triangle when n is odd).
    for (const base of [0, n]) {
        for (let i = 1; i + 1 < n; i += 2) {
            const c = base + i + 1;
            const d = i + 2 < n ? base + i + 2 : c;
            polygons.push(base, base + i, c, d);
        }
    }
    return primitive(vertices, polygons, meta);
}

/** Ring at +hy closing to a single apex at (0, -hy, 0): one triangle per edge. */
function pyramidMesh(ring, hy, meta) {
    const n = ring.length;
    const vertices = [];
    for (const [x, z] of ring) vertices.push(x, hy, z);
    vertices.push(0, -hy, 0);
    const apex = n;
    const polygons = [];
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        polygons.push(i, j, apex, apex);
    }
    for (let i = 1; i + 1 < n; i += 2) {
        const c = i + 1;
        const d = i + 2 < n ? i + 2 : c;
        polygons.push(0, i, c, d);
    }
    return primitive(vertices, polygons, meta);
}

/** Two rings of the same arity at +-hy — a prism when they match, else a taper. */
function frustumMesh(ringTop, ringBottom, hy, meta) {
    const n = ringTop.length;
    const vertices = [];
    for (const [x, z] of ringTop) vertices.push(x, hy, z);
    for (const [x, z] of ringBottom) vertices.push(x, -hy, z);
    const polygons = [];
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        polygons.push(i, j, n + j, n + i);
    }
    for (const base of [0, n]) {
        for (let i = 1; i + 1 < n; i += 2) {
            const c = base + i + 1;
            const d = i + 2 < n ? base + i + 2 : c;
            polygons.push(base, base + i, c, d);
        }
    }
    return primitive(vertices, polygons, meta);
}

function squareRing(r) {
    return [[r, r], [-r, r], [-r, -r], [r, -r]];
}

function polygonRing(r, segments) {
    const ring = [];
    for (let i = 0; i < segments; i++) {
        const a = (i * 2 * Math.PI) / segments;
        ring.push([r * Math.sin(a), r * Math.cos(a)]);
    }
    return ring;
}

export function boxMesh(hx, hy, hz, meta) {
    return prismMesh([[hx, hz], [-hx, hz], [-hx, -hz], [hx, -hz]], hy, meta);
}

/** Triangular prism: a triangle in XZ (base at zMin, apex at zMax), +-hy tall. */
export function wedgeMesh(hx, hy, zMin, zMax, meta) {
    return prismMesh([[-hx, zMin], [hx, zMin], [0, zMax]], hy, meta);
}

export function hexPrismMesh(r, hy, meta) {
    const ring = [];
    for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        ring.push([r * Math.sin(a), r * Math.cos(a)]);
    }
    return prismMesh(ring, hy, meta);
}

export function cylinderMesh(r, hy, segments = 16, meta) {
    const ring = [];
    for (let i = 0; i < segments; i++) {
        const a = (i * 2 * Math.PI) / segments;
        ring.push([r * Math.sin(a), r * Math.cos(a)]);
    }
    return prismMesh(ring, hy, meta);
}

/** A square standing on a corner in XZ (the disc's idx 6 box variant). */
export function rhombusPrismMesh(r, hy, meta) {
    return prismMesh([[0, r], [r, 0], [0, -r], [-r, 0]], hy, meta);
}

/** Trapezoid in XZ: bottom (z = -hz) spans +-hxBottom, top +-hxTop. */
export function trapezoidPrismMesh(hxBottom, hxTop, hy, hz, meta) {
    return prismMesh(
        [[hxTop, hz], [-hxTop, hz], [-hxBottom, -hz], [hxBottom, -hz]],
        hy,
        meta,
    );
}

/**
 * UV sphere with the disc's topology: one vertex per pole, `rings` latitude
 * rings of `segments` vertices, quads between rings and triangle fans at the
 * poles — 9 x 10 gives the library's 92 vertices / 100 polygons.
 */
export function sphereMesh(r, rings = 9, segments = 10, meta) {
    const vertices = [0, r, 0];
    for (let i = 1; i <= rings; i++) {
        const lat = (Math.PI * i) / (rings + 1);
        const y = r * Math.cos(lat);
        const rr = r * Math.sin(lat);
        for (let j = 0; j < segments; j++) {
            const a = (2 * Math.PI * j) / segments;
            vertices.push(rr * Math.sin(a), y, rr * Math.cos(a));
        }
    }
    vertices.push(0, -r, 0);
    const top = 0;
    const bottom = 1 + rings * segments;
    const ringAt = (i, j) => 1 + i * segments + (j % segments);
    const polygons = [];
    for (let j = 0; j < segments; j++) {
        polygons.push(top, ringAt(0, j), ringAt(0, j + 1), ringAt(0, j + 1));
    }
    for (let i = 0; i + 1 < rings; i++) {
        for (let j = 0; j < segments; j++) {
            polygons.push(
                ringAt(i, j),
                ringAt(i, j + 1),
                ringAt(i + 1, j + 1),
                ringAt(i + 1, j),
            );
        }
    }
    for (let j = 0; j < segments; j++) {
        const a = ringAt(rings - 1, j);
        const b = ringAt(rings - 1, j + 1);
        polygons.push(bottom, b, a, a);
    }
    return primitive(vertices, polygons, meta);
}

// Family 5, the geometric-primitive page. Kind and dimensions taken per entry
// from MDLDT_54-56 (2026-09-02, re-checked against the shipped library): the
// page is five solids at full height, then the same five closed to an apex or
// tapered, at lower heights. Six of these are prisms and the other six are not
// — reading the bounding boxes alone would make every one of them a prism, so
// test/mesh-library.test.js compares each entry's DISTINCT vertex count and
// bounds against static/editor/dezaemon/mesh-library.json when it is present.
// Tessellation still differs slightly from the disc (the cylinders' caps, the
// sphere's longitude phase); these are stand-ins, not the meshes.
const TRI_RING = [[-27.5, 15.58], [27.5, 15.58], [0, -31.76]];
const FAMILY5_TABLE = [
    (m) => boxMesh(20.5, 20.5, 20.5, m), //                  0  cube
    (m) => sphereMesh(27.5, 9, 10, m), //                     1  sphere
    (m) => wedgeMesh(27.5, 27.5, -15.88, 31.76, m), //        2  triangular prism
    (m) => hexPrismMesh(27.5, 27.5, m), //                    3  hexagonal prism
    (m) => cylinderMesh(27.5, 27.5, 16, m), //                4  16-gon cylinder
    (m) => pyramidMesh(TRI_RING, 20, m), //                   5  triangular pyramid
    (m) => pyramidMesh(squareRing(27.5), 20, m), //           6  square pyramid
    (m) => frustumMesh(squareRing(27.5), squareRing(15), 15, m), // 7  square frustum
    (m) => hexPrismMesh(27.5, 15, m), //                      8  flatter hex prism
    (m) => pyramidMesh(polygonRing(27.5, 16), 20, m), //      9  16-gon cone
    (m) => cylinderMesh(27.5, 15, 16, m), //                 10  flatter cylinder
    (m) => //                                                11  triangular frustum
        frustumMesh(
            [[-27.5, -15.88], [27.5, -15.88], [0, 31.76]],
            [[-17.1875, -9.925], [17.1875, -9.925], [0, 19.85]],
            15,
            m,
        ),
];

/** A stand-in for one library mesh; never null. */
export function placeholderMesh(family, meshIndex) {
    const meta = { family, meshIndex };
    if (family === 5 && meshIndex >= 0 && meshIndex < FAMILY5_TABLE.length) {
        return FAMILY5_TABLE[meshIndex](meta);
    }
    if (family === 4) return boxMesh(21.34, 35, 5, meta); // every plate is 43x70x10
    if (family === 0) return boxMesh(35, 30, 12, meta); // wide hull slabs
    if (family >= 1 && family <= 3) return boxMesh(10, 35, 12, meta); // fins, wings, guns
    return boxMesh(20, 20, 20, meta);
}

let placeholderCache = null;

/** The whole library as placeholders (memoised). */
export function placeholderLibrary() {
    if (placeholderCache) return placeholderCache;
    const meshes = [];
    for (let i = 0; i < LIBRARY_MESH_COUNT; i++) {
        const { family, meshIndex } = familyOfLibraryIndex(i);
        meshes.push(placeholderMesh(family, meshIndex));
    }
    placeholderCache = { meshes, familyOffsets: FAMILY_OFFSETS, source: "placeholder" };
    return placeholderCache;
}

/** The mesh a decoded part refers to, from a library; falls back to a placeholder. */
export function meshFor(library, part) {
    const index = libraryIndex(part.shapeFamily, part.meshIndex);
    const mesh = index >= 0 && library ? library.meshes[index] : null;
    return mesh || placeholderMesh(part.shapeFamily, part.meshIndex);
}

// ---------------------------------------------------------------------------
// JSON form
//
// Vertices are stored as integers in 1/256 model unit (the 16.16 sources are
// exact multiples of 1/65536, and 1/256 keeps every measured dimension to two
// decimals in a fraction of the bytes); normals are recomputed on load.

export const JSON_UNIT = 256;

export function serializeMeshLibrary(library) {
    return {
        v: 1,
        source: library.source,
        unit: JSON_UNIT,
        meshes: library.meshes.map((mesh) => ({
            f: mesh.family,
            i: mesh.meshIndex,
            s: mesh.source,
            v: Array.from(mesh.vertices, (x) => Math.round(x * JSON_UNIT)),
            p: Array.from(mesh.polygons),
            c: mesh.colorSets.map((set) => Array.from(set)),
        })),
    };
}

export function meshLibraryFromJson(obj) {
    if (!obj || obj.v !== 1 || !Array.isArray(obj.meshes)) {
        throw new Error("mesh library: not a v1 library");
    }
    const unit = obj.unit || JSON_UNIT;
    const meshes = obj.meshes.map((m) =>
        makeMesh({
            vertices: Float32Array.from(m.v, (x) => x / unit),
            polygons: m.p,
            colorSets: m.c,
            source: m.s || obj.source || "mdldt",
            family: m.f,
            meshIndex: m.i,
        })
    );
    return { meshes, familyOffsets: FAMILY_OFFSETS, source: obj.source || "mdldt" };
}
