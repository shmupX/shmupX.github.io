// MDLDT_NN.CMP, the ポリ吉 part library: a synthetic bank, then the disc's.
import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { decompressCmp } from "../src/decompress.js";
import {
  buildMeshLibrary,
  decodeMdldt,
  MDLDT_BASE,
  MDLDT_FILE_COUNT,
} from "../src/model/decode-mdldt.js";
import {
  LIBRARY_MESH_COUNT,
  libraryIndex,
  mdldtFileName,
  meshBounds,
  polygonNormals,
} from "../src/model/mesh-library.js";
import { hasDiscFile, loadDiscFile } from "./_fixtures.js";

// A one-mesh bank in the disc's layout: 12 pointers, three PDATA sharing
// pntbl/pltbl, a cube, three ATTR tables. Only mesh 0 is populated; the
// other three pointer triples alias it, which the reader tolerates.
// `dualPlane` flags those polygon indices with ATTR flag bit 0 in every
// colour set; `disagreeAt` flags one polygon in set 0 only, which the reader
// must reject.
function syntheticBank({ dualPlane = [], disagreeAt = -1 } = {}) {
  const nbPoint = 8, nbPolygon = 6;
  const headerSize = 12 * 4;
  const pdataAt = headerSize;
  const pntAt = pdataAt + 3 * 24;
  const polAt = pntAt + nbPoint * 12;
  const attrAt = polAt + nbPolygon * 20;
  const size = attrAt + 3 * nbPolygon * 12;
  const bytes = new Uint8Array(size);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < 12; i++) {
    dv.setUint32(i * 4, MDLDT_BASE + pdataAt + (i % 3) * 24);
  }
  for (let s = 0; s < 3; s++) {
    const at = pdataAt + s * 24;
    dv.setUint32(at, MDLDT_BASE + pntAt);
    dv.setUint32(at + 4, nbPoint);
    dv.setUint32(at + 8, MDLDT_BASE + polAt);
    dv.setUint32(at + 12, nbPolygon);
    dv.setUint32(at + 16, MDLDT_BASE + attrAt + s * nbPolygon * 12);
    dv.setUint32(at + 20, 0);
  }
  const h = 20.5 * 65536;
  const verts = [
    [h, h, h],
    [-h, h, h],
    [-h, h, -h],
    [h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [h, -h, -h],
    [-h, -h, -h],
  ];
  verts.forEach((v, i) =>
    v.forEach((c, k) => dv.setInt32(pntAt + i * 12 + k * 4, c))
  );
  const polys = [
    [[0, 1, 0], [0, 1, 2, 3]],
    [[0, 0, 1], [4, 1, 0, 5]],
    [[1, 0, 0], [5, 0, 3, 6]],
    [[0, 0, -1], [6, 3, 2, 7]],
    [[0, -1, 0], [4, 5, 6, 7]],
    [[-1, 0, 0], [1, 4, 7, 2]],
  ];
  polys.forEach(([n, v], q) => {
    n.forEach((c, k) => dv.setInt32(polAt + q * 20 + k * 4, c * 65536));
    v.forEach((c, k) => dv.setUint16(polAt + q * 20 + 12 + k * 2, c));
  });
  const sets = [
    [0x800f, 0x800f, 0x800f, 0x800f, 0x800f, 0x800f],
    [0x83e0, 0x801f, 0xfc00, 0x801f, 0x83ff, 0xfc00],
    [0xd294, 0xd294, 0xd294, 0xd294, 0xd294, 0xd294],
  ];
  sets.forEach((set, s) =>
    set.forEach((c, q) => {
      const at = attrAt + s * nbPolygon * 12 + q * 12;
      const flagged = dualPlane.includes(q) || (s === 0 && q === disagreeAt);
      dv.setUint8(at, flagged ? 1 : 0);
      dv.setUint8(at + 1, 11);
      dv.setUint16(at + 4, 0xe8);
      dv.setUint16(at + 6, c);
      dv.setUint16(at + 10, 4);
    })
  );
  return bytes;
}

Deno.test("decodeMdldt reads vertices, polygons, stored normals and three colour sets", () => {
  const meshes = decodeMdldt(syntheticBank(), { file: 54 });
  assertStrictEquals(meshes.length, 4);
  const cube = meshes[0];
  assertStrictEquals(cube.source, "mdldt");
  assertStrictEquals(cube.family, 5);
  assertStrictEquals(cube.meshIndex, 0);
  assertStrictEquals(meshes[3].meshIndex, 3);
  assertStrictEquals(cube.vertices.length, 24);
  assertStrictEquals(cube.polygons.length, 24);
  assertStrictEquals(cube.vertices[0], 20.5);
  assertEquals(Array.from(cube.polygons.subarray(0, 4)), [0, 1, 2, 3]);
  assertEquals(Array.from(cube.normals.subarray(0, 3)), [0, 1, 0]);
  assertEquals(Array.from(cube.colorSets[0]), [15, 15, 15, 15, 15, 15]);
  assertEquals(Array.from(cube.colorSets[1]), [
    0x03e0,
    0x001f,
    0x7c00,
    0x001f,
    0x03ff,
    0x7c00,
  ]);
  assertEquals(Array.from(cube.colorSets[2]), [
    0x5294,
    0x5294,
    0x5294,
    0x5294,
    0x5294,
    0x5294,
  ]);
  // the stored normals are what polygonNormals reproduces
  const computed = polygonNormals(cube.vertices, cube.polygons);
  for (let i = 0; i < computed.length; i++) {
    assert(Math.abs(computed[i] - cube.normals[i]) < 1e-3);
  }
});

Deno.test("decodeMdldt rejects a bank whose colour sets disagree on geometry", () => {
  const bytes = syntheticBank();
  const dv = new DataView(bytes.buffer);
  dv.setUint32(12 * 4 + 24 + 4, 7); // second PDATA claims 7 points
  assertThrows(() => decodeMdldt(bytes), Error, "disagree");
});

Deno.test("buildMeshLibrary back-fills missing files with placeholders", () => {
  const files = new Array(MDLDT_FILE_COUNT).fill(null);
  files[53] = syntheticBank(); // MDLDT_54
  const lib = buildMeshLibrary(files);
  assertStrictEquals(lib.meshes.length, LIBRARY_MESH_COUNT);
  assertStrictEquals(lib.realMeshes, 4);
  assertStrictEquals(lib.source, "partial");
  assertStrictEquals(lib.meshes[libraryIndex(5, 0)].source, "mdldt");
  assertStrictEquals(lib.meshes[libraryIndex(5, 4)].source, "placeholder");
  assertStrictEquals(lib.meshes[0].source, "placeholder");
});

// --- The disc ---------------------------------------------------------------

const DISC = hasDiscFile("MDLDT_54.CMP");
if (!DISC) {
  console.log("  (MDLDT: skipped — no Dezaemon 2 disc image in dev-fixtures/)");
}

function discFile(n) {
  return decompressCmp(loadDiscFile(mdldtFileName(n)));
}

Deno.test({
  name: "MDLDT_54 mesh 0 is the +-20.5 cube with the three known colour sets",
  ignore: !DISC,
  fn() {
    const meshes = decodeMdldt(discFile(54), { file: 54 });
    const cube = meshes[0];
    assertStrictEquals(cube.vertices.length / 3, 8);
    assertStrictEquals(cube.polygons.length / 4, 6);
    const b = meshBounds(cube);
    assertEquals(b.min, [-20.5, -20.5, -20.5]);
    assertEquals(b.max, [20.5, 20.5, 20.5]);
    assertEquals(Array.from(cube.colorSets[0]), [15, 15, 15, 15, 15, 15]);
    assertEquals(Array.from(cube.colorSets[1]), [
      0x03e0,
      0x001f,
      0x7c00,
      0x001f,
      0x03ff,
      0x7c00,
    ]);
    assertEquals(Array.from(cube.colorSets[2]), [
      0x5294,
      0x5294,
      0x5294,
      0x5294,
      0x5294,
      0x5294,
    ]);
    // mesh 1 is the sphere: 92 vertices, 100 polygons
    assertStrictEquals(meshes[1].vertices.length / 3, 92);
    assertStrictEquals(meshes[1].polygons.length / 4, 100);
  },
});

Deno.test({
  name:
    "the whole disc library is 224 meshes, 14,345 vertices, 15,216 polygons",
  ignore: !DISC,
  fn() {
    const files = [];
    for (let n = 1; n <= MDLDT_FILE_COUNT; n++) files.push(discFile(n));
    const lib = buildMeshLibrary(files);
    assertStrictEquals(lib.source, "mdldt");
    assertStrictEquals(lib.realMeshes, LIBRARY_MESH_COUNT);
    let vertices = 0, polygons = 0, triangles = 0;
    for (const mesh of lib.meshes) {
      vertices += mesh.vertices.length / 3;
      polygons += mesh.polygons.length / 4;
      for (let q = 0; q < mesh.polygons.length / 4; q++) {
        triangles += mesh.polygons[q * 4 + 2] === mesh.polygons[q * 4 + 3]
          ? 1
          : 2;
      }
    }
    assertStrictEquals(vertices, 14345);
    assertStrictEquals(polygons, 15216);
    assertStrictEquals(triangles, 27124);
    // family 4 is the plate page: every mesh is 70 tall and 10 deep
    for (let i = 0; i < 36; i++) {
      const b = meshBounds(lib.meshes[libraryIndex(4, i)]);
      assert(Math.abs(b.max[1] - b.min[1] - 70) < 0.01);
      assert(Math.abs(b.max[2] - b.min[2] - 10) < 0.01);
    }
  },
});

Deno.test("the ATTR flag decodes as the per-polygon dual-plane bit", () => {
  const plain = decodeMdldt(syntheticBank(), { file: 54 })[0];
  assertStrictEquals(plain.dualPlane.length, 6);
  assertStrictEquals(plain.dualPlane.reduce((a, b) => a + b, 0), 0);

  const flagged =
    decodeMdldt(syntheticBank({ dualPlane: [1, 4] }), { file: 54 })[0];
  assertEquals(Array.from(flagged.dualPlane), [0, 1, 0, 0, 1, 0]);

  // The flag belongs to the polygon, so the three colour sets must agree;
  // a bank where they do not is a misread, not something to paper over.
  assertThrows(
    () => decodeMdldt(syntheticBank({ disagreeAt: 2 }), { file: 54 }),
    Error,
    "dual-plane",
  );
});

Deno.test({
  name:
    "the disc's ATTR: sort is always SORT_CEN, and 44 polygons are dual-plane",
  ignore: !DISC,
  fn() {
    // Pins the two facts src/model/decode-mdldt.js's header states and the
    // renderer relies on. `sort` constant means the depth key is SORT_CEN for
    // the whole library; the flag is not constant, which is the correction.
    const flaggedByLibIndex = new Map();
    let polygons = 0, flagged = 0;
    for (let n = 1; n <= MDLDT_FILE_COUNT; n++) {
      const bytes = discFile(n);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (const mesh of decodeMdldt(bytes, { file: n })) {
        const count = mesh.dualPlane.reduce((a, b) => a + b, 0);
        polygons += mesh.dualPlane.length;
        flagged += count;
        if (count) {
          flaggedByLibIndex.set(
            libraryIndex(mesh.family, mesh.meshIndex),
            count,
          );
        }
      }
      // every ATTR record in the file, all three colour sets
      for (let p = 0; p < 12; p++) {
        const at = dv.getUint32(p * 4) - MDLDT_BASE;
        const nbPolygon = dv.getUint32(at + 12);
        const attbl = dv.getUint32(at + 16) - MDLDT_BASE;
        for (let q = 0; q < nbPolygon; q++) {
          assertStrictEquals(dv.getUint8(attbl + q * 12 + 1), 0x0b);
        }
      }
    }
    assertStrictEquals(polygons, 15216);
    assertStrictEquals(flagged, 44);
    assertEquals([...flaggedByLibIndex].sort((a, b) => a[0] - b[0]), [
      [148, 32],
      [171, 12],
    ]);
  },
});

Deno.test({
  name: "the disc's stored normals follow the rule polygonNormals reproduces",
  ignore: !DISC,
  fn() {
    let total = 0, agree = 0, opposite = 0, zeroComputed = 0;
    for (let n = 1; n <= MDLDT_FILE_COUNT; n++) {
      for (const mesh of decodeMdldt(discFile(n), { file: n })) {
        const computed = polygonNormals(mesh.vertices, mesh.polygons);
        for (let q = 0; q < mesh.polygons.length / 4; q++) {
          const dot = computed[q * 3] * mesh.normals[q * 3] +
            computed[q * 3 + 1] * mesh.normals[q * 3 + 1] +
            computed[q * 3 + 2] * mesh.normals[q * 3 + 2];
          total++;
          if (dot > 0.9) agree++;
          if (dot < 0) opposite++;
          const len = Math.hypot(
            computed[q * 3],
            computed[q * 3 + 1],
            computed[q * 3 + 2],
          );
          if (len < 1e-6) zeroComputed++;
          // whatever the winding says, the DISC's normal is always a unit vector
          assert(
            Math.abs(
              Math.hypot(
                mesh.normals[q * 3],
                mesh.normals[q * 3 + 1],
                mesh.normals[q * 3 + 2],
              ) - 1,
            ) < 1e-3,
          );
        }
      }
    }
    assert(agree / total > 0.97, `${agree}/${total} agree`);
    assert(opposite / total < 0.01, `${opposite}/${total} opposite`);
    // ...but "mostly agrees" is not "is a substitute", which is why the JSON
    // form carries the disc's own normals rather than recomputing them. These
    // are the polygons recomputation gets WRONG: one comes out facing the
    // other way, and 18 collapse to the zero vector, which culls them from
    // every angle. Both figures are exact — if they move, the library changed.
    assertStrictEquals(opposite, 1);
    assertStrictEquals(zeroComputed, 18);
  },
});
