// Bundle the netplay client (static/netplay/src + the generated SpacetimeDB
// bindings + the SDK) into one same-origin ESM file the game page and the
// launcher dashboard both import at runtime:
// static/netplay/shmupx-netplay.js.
//
// Same reasoning as scripts/build-engine.ts: the pages that use this must stay
// same-origin-only with no CDN and no import map, because the launcher's
// mapped gamepad/keyboard input requires a same-origin gameframe.
//
// The bindings under static/netplay/bindings/ are generated — regenerate them
// with `deno task netplay:generate` whenever spacetimedb/module/src/index.ts
// changes its tables or reducers, then re-run this.

import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(
  new URL("../static/netplay/src/client.ts", import.meta.url),
);
const outfile = fileURLToPath(
  new URL("../static/netplay/shmupx-netplay.js", import.meta.url),
);
// The SDK resolves out of the module project's node_modules — this repo has no
// npm install of its own, and vendoring a second copy would be one more thing
// to keep in step with the published module.
const sdkDir = fileURLToPath(
  new URL("../spacetimedb/module/node_modules", import.meta.url),
);

// That tree is gitignored, so a clean checkout does not have it — and
// `deno task build` runs this. Bundling is therefore OPTIONAL: the committed
// static/netplay/shmupx-netplay.js is what ships, and this script only refreshes
// it for someone who has actually installed the module's dependencies. Failing
// here instead would take the whole site build down over an opt-in feature.
try {
  Deno.statSync(sdkDir);
} catch {
  const built = (() => {
    try {
      return Deno.statSync(outfile).isFile;
    } catch {
      return false;
    }
  })();
  console.log(
    `netplay: skipping bundle — ${sdkDir} is absent.\n` +
      (built
        ? "  The committed static/netplay/shmupx-netplay.js is used as-is."
        : "  WARNING: no committed bundle either; online 2P will be inert.") +
      "\n  To rebuild it: cd spacetimedb/module && npm install",
  );
  Deno.exit(0);
}
const nodePaths = [sdkDir];

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  minify: false,
  format: "esm",
  target: "es2022",
  platform: "browser",
  nodePaths,
  outfile,
  logLevel: "info",
});

if (result.warnings.length) {
  console.warn(`${result.warnings.length} warning(s) during build.`);
}

await esbuild.stop();
