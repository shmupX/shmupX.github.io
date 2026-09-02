// Model -> triangles: transforms, projection, painter order, Mesh2D packing.
import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { rgb555ToHex } from "../src/decode/decode-cg.js";
import { placeholderLibrary } from "../src/model/mesh-library.js";
import {
  allocFrame,
  buildModelMesh,
  buildSwatchTable,
  composeTransform,
  modelStats,
  normalMatrix,
  orbitCamera,
  packMesh2D,
  projectModel,
  quantizeRotation,
  ROT_ORDERS,
  SHADE_LEVELS,
  swatchCell,
  swatchRgb,
  swatchUV,
  transformPoint,
  wireframeSegments,
} from "../src/model/model-mesh.js";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import { hasDevFixtures, loadDevFixture } from "./_fixtures.js";

const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;
const point = (m, x, y, z) =>
  Array.from(transformPoint(m, x, y, z, new Float64Array(3)));

function part(over = {}) {
  return {
    shape: 0x5100,
    shapeFamily: 5,
    meshIndex: 0,
    colorSet: 1,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    ...over,
  };
}

Deno.test("composeTransform: identity, then scale -> rotate -> translate", () => {
  assertEquals(point(composeTransform(part()), 1, 2, 3), [1, 2, 3]);
  const m = composeTransform(part({
    position: { x: 10, y: 20, z: 30 },
    rotation: { x: 0, y: 0, z: 90 },
    scale: { x: 2, y: -1, z: 1 },
  }));
  // (1,0,0) scaled to (2,0,0), turned 90 about Z to (0,2,0), moved
  const p = point(m, 1, 0, 0);
  assert(near(p[0], 10) && near(p[1], 22) && near(p[2], 30), String(p));
  // a right-handed rotation about Y takes +X to -Z
  const q = point(
    composeTransform(part({ rotation: { x: 0, y: 90, z: 0 } })),
    1,
    0,
    0,
  );
  assert(near(q[0], 0) && near(q[1], 0) && near(q[2], -1), String(q));
  assertThrows(() => composeTransform(part(), { rotOrder: "abc" }));
});

Deno.test("every rotation order applies its axes first-letter first", () => {
  const deg = Math.PI / 180;
  const rot = {
    x: (
      [x, y, z],
      a,
    ) => [
      x,
      y * Math.cos(a) - z * Math.sin(a),
      y * Math.sin(a) + z * Math.cos(a),
    ],
    y: (
      [x, y, z],
      a,
    ) => [
      x * Math.cos(a) + z * Math.sin(a),
      y,
      -x * Math.sin(a) + z * Math.cos(a),
    ],
    z: (
      [x, y, z],
      a,
    ) => [
      x * Math.cos(a) - y * Math.sin(a),
      x * Math.sin(a) + y * Math.cos(a),
      z,
    ],
  };
  const angles = { x: 30, y: 45, z: 60 };
  for (const order of ROT_ORDERS) {
    let expect = [1, 2, 3];
    for (const axis of order) expect = rot[axis](expect, angles[axis] * deg);
    const m = composeTransform(part({ rotation: angles }), {
      rotOrder: order,
      quantize: false,
    });
    const got = point(m, 1, 2, 3);
    for (let k = 0; k < 3; k++) {
      assert(near(got[k], expect[k]), `${order}: ${got} vs ${expect}`);
    }
  }
});

Deno.test("quantizeRotation snaps to the editor's 18-degree steps", () => {
  assertStrictEquals(quantizeRotation(35.99), 36);
  assertStrictEquals(quantizeRotation(36.01), 36);
  assertStrictEquals(quantizeRotation(90), 90);
  assertStrictEquals(quantizeRotation(359.9), 0);
  assertStrictEquals(quantizeRotation(305.9), 306);
  assertStrictEquals(quantizeRotation(-18), 342);
});

Deno.test("normalMatrix is the inverse transpose", () => {
  const m = composeTransform(part({ scale: { x: 2, y: -1, z: 4 } }));
  const n = Array.from(normalMatrix(m)).map((v) => +v.toFixed(6));
  assertEquals(n, [0.5, 0, 0, 0, -1, 0, 0, 0, 0.25]);
});

function outward(mesh) {
  const c = mesh.bounds.center;
  for (let t = 0; t < mesh.triCount; t++) {
    let mx = 0, my = 0, mz = 0;
    for (let k = 0; k < 3; k++) {
      mx += mesh.positions[t * 9 + k * 3];
      my += mesh.positions[t * 9 + k * 3 + 1];
      mz += mesh.positions[t * 9 + k * 3 + 2];
    }
    const dot = mesh.normals[t * 3] * (mx / 3 - c[0]) +
      mesh.normals[t * 3 + 1] * (my / 3 - c[1]) +
      mesh.normals[t * 3 + 2] * (mz / 3 - c[2]);
    if (dot <= 0) return false;
  }
  return true;
}

Deno.test("a one-part cube builds 12 outward triangles with the colour set's colours", () => {
  const mesh = buildModelMesh({ slot: 0, color: 0x7fff, parts: [part()] }, {
    library: placeholderLibrary(),
  });
  assertStrictEquals(mesh.triCount, 12);
  assertStrictEquals(mesh.placeholder, true);
  assertEquals(mesh.bounds.min, [-20.5, -20.5, -20.5]);
  assertEquals(mesh.bounds.max, [20.5, 20.5, 20.5]);
  assert(outward(mesh));
  const distinct = new Set();
  for (let t = 0; t < 12; t++) {
    distinct.add(
      Array.from(mesh.normals.subarray(t * 3, t * 3 + 3)).map((v) =>
        v.toFixed(2)
      ).join(","),
    );
  }
  assertStrictEquals(distinct.size, 6);
  assertStrictEquals(mesh.colors[0], rgb555ToHex(0x03e0));
  assertStrictEquals(mesh.parts.length, 1);
  assertStrictEquals(mesh.parts[0].triCount, 12);
});

Deno.test("a mirrored part keeps outward normals, with and without yDown", () => {
  for (const yDown of [true, false]) {
    const mesh = buildModelMesh({
      parts: [part({ scale: { x: -1, y: 1, z: 1 } })],
    }, { yDown });
    assert(outward(mesh), `yDown=${yDown}`);
    assertStrictEquals(mesh.parts[0].part.mirrored, undefined); // decoder field, not recomputed here
  }
});

Deno.test("a cube shows exactly three faces from a generic viewpoint", () => {
  for (const yDown of [true, false]) {
    for (const sx of [1, -1]) {
      const mesh = buildModelMesh({
        parts: [part({ scale: { x: sx, y: 1, z: 1 } })],
      }, { yDown });
      const frame = allocFrame(mesh);
      const cam = orbitCamera({ yaw: 35, pitch: 25, distance: 150 });
      assertStrictEquals(
        projectModel(mesh, cam, frame),
        6,
        `yDown=${yDown} sx=${sx}`,
      );
      // every visible triangle faces the eye
      for (let r = 0; r < 6; r++) {
        const t = frame.order[r];
        assertStrictEquals(frame.visible[t], 1);
        assert(frame.shade[t] >= 0 && frame.shade[t] < SHADE_LEVELS);
      }
      // and the order runs far to near
      for (let r = 1; r < 6; r++) {
        assert(frame.depth[frame.order[r - 1]] >= frame.depth[frame.order[r]]);
      }
    }
  }
});

Deno.test("a triangle behind the near plane is dropped", () => {
  const mesh = buildModelMesh({ parts: [part()] });
  const frame = allocFrame(mesh);
  const cam = orbitCamera({ yaw: 0, pitch: 0, distance: 10 }); // inside the cube
  assertStrictEquals(projectModel(mesh, cam, frame), 0);
});

Deno.test("packMesh2D writes step-4 vertices and page-0 indices in painter order", () => {
  const mesh = buildModelMesh({
    parts: [part(), part({ position: { x: 60, y: 0, z: 0 }, colorSet: 2 })],
  });
  const frame = allocFrame(mesh);
  const cam = orbitCamera({ yaw: 30, pitch: 20, distance: 300 });
  const n = projectModel(mesh, cam, frame);
  assert(n > 0);
  const table = buildSwatchTable(mesh);
  assertStrictEquals(table.colors.length, 5); // four faces of set 1 + the grey of set 2
  const out = packMesh2D(mesh, frame, table);
  assertStrictEquals(out.count, n);
  assertStrictEquals(out.vertices.length, n * 12);
  assertStrictEquals(out.indices.length, n * 4);
  for (let r = 0; r < n; r++) {
    assertEquals(out.indices.slice(r * 4, r * 4 + 4), [
      r * 3,
      r * 3 + 1,
      r * 3 + 2,
      0,
    ]);
    for (let k = 0; k < 3; k++) {
      const u = out.vertices[r * 12 + k * 4 + 2],
        v = out.vertices[r * 12 + k * 4 + 3];
      assert(u > 0 && u < 1 && v > 0 && v < 1);
    }
  }
  // the buffers are reused and trimmed
  const again = packMesh2D(mesh, frame, table, undefined, out);
  assertStrictEquals(again.vertices, out.vertices);
  const wire = wireframeSegments(mesh, frame);
  assertStrictEquals(wire.length, n * 12);
});

Deno.test("swatch cells sit at texel centres and shade toward the base colour", () => {
  const [u, v] = swatchUV(swatchCell(0, 0));
  assertStrictEquals(u, 4 / 256);
  assertStrictEquals(v, 4 / 256);
  const [u2, v2] = swatchUV(swatchCell(3, 7)); // cell 31: last column of row 0
  assertStrictEquals(u2, (31 * 8 + 4) / 256);
  assertStrictEquals(v2, 4 / 256);
  const [, v3] = swatchUV(swatchCell(4, 0)); // cell 32: row 1
  assertStrictEquals(v3, (8 + 4) / 256);
  assertStrictEquals(swatchRgb(0x808080, SHADE_LEVELS - 1), 0x8d8d8d);
  assertStrictEquals(swatchRgb(0xff0000, 0), 0x940000);
});

Deno.test("modelStats counts slots and parts", () => {
  assertEquals(modelStats([{ parts: [1, 2] }, { parts: [3] }]), {
    slots: 2,
    parts: 3,
  });
  assertEquals(modelStats(null), { slots: 0, parts: 0 });
});

// --- DAIOH, the disc's sample game (dev-fixtures/) --------------------------

const DAIOH = "Dezaemon 2 (DAIOH).sav";
if (!hasDevFixtures(DAIOH)) {
  console.log(
    "  (DAIOH models: skipped — no dev-fixtures/Dezaemon 2 (DAIOH).sav)",
  );
}

async function daioh() {
  const { data } = await normalize(loadDevFixture(DAIOH));
  const save = bup.parse(data).find((s) => s.payload);
  return decodeSave(save.payload.buffer);
}

Deno.test({
  name:
    "DAIOH slot 1 is a picture frame of eight cubes in two colour sets plus a plate",
  ignore: !hasDevFixtures(DAIOH),
  async fn() {
    const d = await daioh();
    assertStrictEquals(d.models.models.length, 6);
    const frame = d.models.models[1];
    assertStrictEquals(frame.parts.length, 9);
    const bars = frame.parts.filter((p) => p.shape === 0x5200);
    const posts = frame.parts.filter((p) => p.shape === 0x5000);
    assertStrictEquals(bars.length, 4);
    assertStrictEquals(posts.length, 4);
    for (const p of [...bars, ...posts]) {
      assertStrictEquals(p.shapeFamily, 5);
      assertStrictEquals(p.meshIndex, 0);
    }
    assert(
      bars.every((p) => p.colorSet === 2) &&
        posts.every((p) => p.colorSet === 0),
    );
    const plate = frame.parts.find((p) => p.shape === 0x000c);
    assertStrictEquals(plate.shapeFamily, 0);
    assertStrictEquals(plate.meshIndex, 12);
    const mesh = buildModelMesh(frame, { library: placeholderLibrary() });
    assertStrictEquals(mesh.triCount, 8 * 12 + 12);
    // slot 0 is the ship: nine parts, with the engine block at y = -52
    // (model +Y is up on screen — see FORMAT.md's sec7 subsection)
    assertStrictEquals(d.models.models[0].parts.length, 9);
    assert(d.models.models[0].parts.some((p) => p.position.y === -52));
  },
});
