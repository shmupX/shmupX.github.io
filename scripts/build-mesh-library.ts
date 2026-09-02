// scripts/build-mesh-library.ts — the ポリ吉 part library as JSON.
//
//   deno task deza:meshlib                     → static/editor/dezaemon/mesh-library.json
//   deno task deza:meshlib --out path/to.json
//
// MDLDT_01-56.CMP on the Dezaemon 2 disc are the 3D editor's part library:
// 56 files x 4 meshes, each with three colour tables — the geometry every
// sec7 model's shape word points at. This reads them out of a disc image (or
// extracted copies) in the gitignored dev-fixtures/, decodes them with the
// engine (packages/shmup-engine/src/model/decode-mdldt.js) and writes the
// library in the JSON form the model viewer loads
// (src/model/mesh-library.js serializeMeshLibrary).
//
// The output is COMMITTED and served from static/, so it deploys with the
// site: Deno Deploy has no disc to rebuild it from, and the level editor's
// model viewer needs it in production (decision 2026-09-02; see README.md
// "PlayStation 2"). The engine already ships smaller disc-derived tables in
// packages/shmup-engine/data/ — this is the first one big enough to serve to
// the browser rather than bundle. Finding no disc is not an error: the
// committed file stays authoritative, exactly like saves.manifest.json, so the
// task says so and exits 0.

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { findDiscFiles } from "../lib/disc-file.ts";
import { decompressCmp } from "../packages/shmup-engine/src/decompress.js";
import {
  buildMeshLibrary,
  MDLDT_FILE_COUNT,
} from "../packages/shmup-engine/src/model/decode-mdldt.js";
import {
  LIBRARY_MESH_COUNT,
  mdldtFileName,
  serializeMeshLibrary,
} from "../packages/shmup-engine/src/model/mesh-library.js";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const DEFAULT_OUT = join(
  ROOT,
  "static",
  "editor",
  "dezaemon",
  "mesh-library.json",
);

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

let out = DEFAULT_OUT;
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (arg === "--out") {
    const value = Deno.args[++i];
    if (value === undefined) fail("--out needs a value");
    out = resolve(value);
  } else {
    fail(`unknown argument ${arg}`);
  }
}

const names: string[] = [];
for (let n = 1; n <= MDLDT_FILE_COUNT; n++) names.push(mdldtFileName(n));

const source = await findDiscFiles(ROOT, names);
if (!source) {
  console.log(
    "mesh library: no MDLDT_NN.CMP or Dezaemon 2 disc image in dev-fixtures/ — " +
      `keeping ${relative(ROOT, out)} as committed`,
  );
  Deno.exit(0);
}

const missing = source.files.map((f, i) => (f ? null : names[i])).filter(
  Boolean,
);
if (missing.length) {
  console.log(
    `mesh library: ${missing.length} files not found (${
      missing.join(", ")
    }) — placeholders fill them`,
  );
}

const decompressed = source.files.map((bytes, i) => {
  if (!bytes) return null;
  try {
    return decompressCmp(bytes);
  } catch (error) {
    fail(`${names[i]}: ${(error as Error).message}`);
  }
});

const library = buildMeshLibrary(decompressed);
let vertices = 0;
let polygons = 0;
for (const mesh of library.meshes) {
  vertices += mesh.vertices.length / 3;
  polygons += mesh.polygons.length / 4;
}
const json = JSON.stringify(serializeMeshLibrary(library));
await Deno.mkdir(dirname(out), { recursive: true });
await Deno.writeTextFile(out, json + "\n");

console.log(
  `mesh library: ${library.realMeshes}/${LIBRARY_MESH_COUNT} meshes from ${source.from} — ` +
    `${vertices.toLocaleString()} vertices, ${polygons.toLocaleString()} polygons, ` +
    `${(json.length / 1024).toFixed(0)} KB → ${relative(ROOT, out)}`,
);
