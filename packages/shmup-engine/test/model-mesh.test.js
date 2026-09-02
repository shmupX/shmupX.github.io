// Model -> triangles: transforms, projection, painter order, Mesh2D packing.
import {
  assert,
  assertAlmostEquals,
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
  LIGHT_VIEW,
  modelStats,
  normalMatrix,
  orbitCamera,
  packMesh2D,
  projectModel,
  quantizeRotation,
  ROT_ORDERS,
  ROTATION_ORDER,
  saturnLightView,
  SHADE_FLOOR,
  SHADE_LEVELS,
  SHADE_ZERO,
  shadeRgb555,
  shadeRow,
  swatchCell,
  swatchRgb,
  swatchUV,
  tintRgb555,
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

Deno.test("the default rotation order is the Saturn's: Z, then Y, then X", () => {
  // Traced from POLYKITI: slRotX, slRotY, slRotZ are called in that order and
  // SGL post-multiplies, so the last call is the first the vertex sees.
  assertStrictEquals(ROTATION_ORDER, "zyx");
  assert(ROT_ORDERS.includes(ROTATION_ORDER));
  // and the two orders really differ when two rotations are non-zero
  const part2 = part({ rotation: { x: 36, y: 180, z: 0 } });
  const a = point(composeTransform(part2, { rotOrder: "zyx" }), 0, 0, 10);
  const b = point(composeTransform(part2, { rotOrder: "xyz" }), 0, 0, 10);
  assert(!near(a[1], b[1]) || !near(a[2], b[2]), `${a} vs ${b}`);
});

Deno.test("the model colour word tints every polygon colour, white being neutral", () => {
  assertStrictEquals(tintRgb555(0x03e0, 0x7fff), 0x03e0);
  assertStrictEquals(tintRgb555(0x7fff, 0x4210), 0x4210); // white polygon takes the tint
  assertStrictEquals(tintRgb555(0x0000, 0x4210), 0x0000);
  // DAIOH's 0x4210 = (16,16,16) pulls a (10,16,22) polygon to (0,1,7)
  const blue = 10 | (16 << 5) | (22 << 10);
  assertStrictEquals(tintRgb555(blue, 0x4210), 0 | (1 << 5) | (7 << 10));
  // through buildModelMesh: default on, off when asked, neutral without a colour word
  const cube = part();
  const tinted = buildModelMesh({ color: 0x4210, parts: [cube] });
  const plain = buildModelMesh({ color: 0x4210, parts: [cube] }, {
    tint: false,
  });
  const none = buildModelMesh({ parts: [cube] });
  assertStrictEquals(tinted.tint, 0x4210);
  assertStrictEquals(plain.colors[0], rgb555ToHex(0x03e0));
  assertStrictEquals(none.colors[0], rgb555ToHex(0x03e0));
  assertStrictEquals(tinted.colors[0], rgb555ToHex(tintRgb555(0x03e0, 0x4210)));
});

Deno.test("the shade table: 32 light rows, per-channel floors, tint first", () => {
  assertStrictEquals(SHADE_LEVELS, 32);
  assertStrictEquals(SHADE_ZERO, 16);
  assertStrictEquals(SHADE_FLOOR, 0);
  // row = 16 + floor(16 * n.L), clamped
  assertStrictEquals(shadeRow(1), 31);
  assertStrictEquals(shadeRow(0), 16);
  assertStrictEquals(shadeRow(-1), 0);
  assertStrictEquals(shadeRow(0.5), 24);
  assertStrictEquals(shadeRow(-0.3), 11);
  assertStrictEquals(shadeRow(2), 31);
  // clamp(c + tint_c - 31 + (row - 16), floor, 31) per channel
  assertStrictEquals(shadeRgb555(0x7fff, SHADE_ZERO), 0x7fff);
  assertStrictEquals(shadeRgb555(0x7fff, 31), 0x7fff);
  assertStrictEquals(shadeRgb555(0x7fff, 0), 15 | (15 << 5) | (15 << 10));
  assertStrictEquals(shadeRgb555(0x7fff, SHADE_ZERO, 0x4210), 0x4210);
  assertStrictEquals(
    shadeRgb555(0x7fff, 20, 0x4210),
    20 | (20 << 5) | (20 << 10),
  );
  // the floor is a minimum, not an offset
  assertStrictEquals(
    shadeRgb555(0x0000, 0, 0x7fff, 4),
    4 | (4 << 5) | (4 << 10),
  );
  assertStrictEquals(shadeRgb555(0x7fff, 31, 0x7fff, 4), 0x7fff);
  // through buildModelMesh: the raw polygon colour is kept, the floor applies
  const floored = buildModelMesh({ parts: [part()] }, { floor: 8 });
  assertStrictEquals(floored.floor, 8);
  assertStrictEquals(floored.colors555[0], 0x03e0);
  assertStrictEquals(floored.colors[0], rgb555ToHex(8 | (31 << 5) | (8 << 10)));
  assertStrictEquals(buildModelMesh({ parts: [part()] }).floor, SHADE_FLOOR);
});

Deno.test("the capture light is Rz(45).Rx(-50).(0,0,1), negated, fixed to the screen", () => {
  // (right, up, toward-viewer) components of the direction toward the light
  assertAlmostEquals(LIGHT_VIEW[0], 0.5417, 1e-3);
  assertAlmostEquals(LIGHT_VIEW[1], 0.5417, 1e-3);
  assertAlmostEquals(LIGHT_VIEW[2], 0.6428, 1e-3);
  const straight = saturnLightView(0, 0); // no azimuth, no tilt: from the viewer
  assertAlmostEquals(straight[0], 0, 1e-12);
  assertAlmostEquals(straight[1], 0, 1e-12);
  assertAlmostEquals(straight[2], 1, 1e-12);
  const left = saturnLightView(-45, -50); // azimuth mirrors the right component
  assertAlmostEquals(left[0], -LIGHT_VIEW[0], 1e-12);
  assertAlmostEquals(left[1], LIGHT_VIEW[1], 1e-12);

  const mesh = buildModelMesh({ parts: [part()] });
  const frame = allocFrame(mesh);
  const rowsAt = (yaw, lightView) => {
    const cam = orbitCamera({ yaw, pitch: 25, distance: 150 });
    const n = projectModel(mesh, cam, frame, lightView);
    const rows = [];
    for (let r = 0; r < n; r++) rows.push(frame.shade[frame.order[r]]);
    return rows.sort((a, b) => a - b);
  };
  // the cube looks the same from yaw 35 and yaw 125, so a screen-fixed light
  // shades the visible faces identically
  assertEquals(rowsAt(35), rowsAt(125));
  assertEquals(rowsAt(35), rowsAt(215));
  // the top face (normal +Y) sees 0.5417 * cos 25 + 0.6428 * sin 25 = 0.763
  // whatever the yaw: row 16 + floor(12.2) = 28
  for (const yaw of [0, 35, 80, 125]) {
    const cam = orbitCamera({ yaw, pitch: 25, distance: 150 });
    projectModel(mesh, cam, frame);
    for (let t = 0; t < mesh.triCount; t++) {
      if (!frame.visible[t] || mesh.normals[t * 3 + 1] < 0.99) continue;
      assertStrictEquals(frame.shade[t], 28, `yaw ${yaw}`);
    }
  }
  // lit straight from the viewer, every visible face is above the zero row
  for (const row of rowsAt(35, [0, 0, 1])) assert(row > SHADE_ZERO);
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

Deno.test("swatch cells sit at texel centres, one per colour per light row", () => {
  const [u, v] = swatchUV(swatchCell(0, 0));
  assertStrictEquals(u, 2 / 256);
  assertStrictEquals(v, 2 / 256);
  const [u2, v2] = swatchUV(swatchCell(1, 31)); // cell 63: last column of row 0
  assertStrictEquals(u2, (63 * 4 + 2) / 256);
  assertStrictEquals(v2, 2 / 256);
  const [, v3] = swatchUV(swatchCell(2, 0)); // cell 64: row 1
  assertStrictEquals(v3, (4 + 2) / 256);
  // 128 colours x 32 rows fit the 256 px atlas
  const last = swatchUV(swatchCell(127, 31));
  assert(last[0] < 1 && last[1] < 1);
  // the cell colour is the shader's output for that row
  assertStrictEquals(swatchRgb(0x7fff, SHADE_ZERO), 0xffffff);
  assertStrictEquals(swatchRgb(0x7fff, 0), 0x7b7b7b);
  assertStrictEquals(swatchRgb(0x03e0, 0), rgb555ToHex(15 << 5));
  assertStrictEquals(swatchRgb(0x7fff, SHADE_ZERO, 0x4210), 0x848484);
  assertStrictEquals(
    swatchRgb(0x0000, 0, 0x7fff, 4),
    rgb555ToHex(4 | (4 << 5) | (4 << 10)),
  );
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
