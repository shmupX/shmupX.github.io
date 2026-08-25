// Bundle the shmup-engine workspace module into one same-origin ESM file the
// level editor imports at runtime (static/engine/shmup-engine.js). The JSR
// package (packages/shmup-engine) is the source of truth; this bundle exists
// so the plain-HTML editor can `import("/engine/shmup-engine.js")` with no
// CDN or import map, keeping the page same-origin-only (the launcher's mapped
// gamepad/keyboard input requires a same-origin gameframe).
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(
  new URL("../packages/shmup-engine/mod.js", import.meta.url),
);
const outfile = fileURLToPath(
  new URL("../static/engine/shmup-engine.js", import.meta.url),
);

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  minify: false,
  format: "esm",
  target: "es2022",
  outfile,
  logLevel: "info",
});

if (result.warnings.length) {
  console.warn(`${result.warnings.length} warning(s) during build.`);
}

await esbuild.stop();
