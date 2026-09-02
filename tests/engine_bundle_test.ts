// The committed browser bundle, static/engine/shmup-engine.js, is what the
// level editor (and the model viewer) actually run. Nothing regenerates it in
// CI, so this is the guard against a mod.js change shipped without
// `deno task engine:bundle`.

import { assert, assertStrictEquals } from "@std/assert";
import * as bundle from "../static/engine/shmup-engine.js";
import * as source from "../packages/shmup-engine/mod.js";

Deno.test("the engine bundle carries every name mod.js exports", () => {
  const missing = Object.keys(source).filter((name) => !(name in bundle));
  assertStrictEquals(
    missing.length,
    0,
    `stale bundle, missing: ${missing.join(", ")}`,
  );
});

Deno.test("the bundle's model surface works", () => {
  const b = bundle as unknown as Record<string, CallableFunction>;
  assert(typeof b.buildModelMesh === "function");
  assertStrictEquals(b.rgb555ToHex(0x7fff), 0xffffff);
  const mesh = b.buildModelMesh({
    parts: [{
      shapeFamily: 5,
      meshIndex: 0,
      colorSet: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    }],
  });
  assertStrictEquals(mesh.triCount, 12);
});
