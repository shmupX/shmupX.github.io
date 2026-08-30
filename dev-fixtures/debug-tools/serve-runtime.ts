// Serve the level editor and the 2019-es7 Phaser runtime from ONE origin, so
// a .sav can be imported in the editor and immediately test-played against
// the runtime's SOURCE files — edit a scene module, reload, see the change.
//
//   deno run -A dev-fixtures/debug-tools/serve-runtime.ts [save.sav] [--port n]
//
// Routes:
//   /                  cmg's static/ (so /editor/?game=2028-ai is the real
//                      editor, and /games/… is the bundled game)
//   /es7/              the 2019-es7 checkout (so /es7/phaser-game.html runs
//                      the runtime from src/phaser/*.js, unbundled)
//   /__sav__/save.sav  the save passed on the command line, same-origin, so
//                      the editor's URL-import field can reach it without
//                      CORS or the network
//
// Why one origin: the editor hands the runtime its recipe through
// localStorage and its atlas through IndexedDB, both same-origin only. And
// why no-store on /es7/: a browser keeps an ES module graph per URL, so a
// plain reload re-runs STALE modules after you edit a scene file — the
// change appears to have no effect. Verify freshness in the page with
//   String((await import("/es7/src/phaser/…js")).fn).includes("<new code>")
// before trusting what you see.
//
// The runtime lives in the 2019-es7 sibling checkout; point somewhere else
// with CMG_ES7_ROOT. Note the checkout preference here is 2019-es7 FIRST,
// matching scripts/build-2028-ai.ts (which bundles the shipped game from
// that same directory) rather than the importer tools' order — a machine
// can hold several checkouts on different branches, and serving a runtime
// the build does not use makes an edit look like it changed nothing.
import { serveDir } from "@std/http/file-server";
import { fromFileUrl } from "@std/path";

const CMG_ROOT = fromFileUrl(new URL("../../", import.meta.url));

function resolveEs7(): string {
  const env = Deno.env.get("CMG_ES7_ROOT");
  if (env) return env;
  for (const dir of ["2019-es7", "2019-es7-0822"]) {
    const candidate = `${CMG_ROOT}../${dir}`;
    try {
      if (Deno.statSync(`${candidate}/src/phaser/GameScene.js`).isFile) {
        return candidate;
      }
    } catch {
      // not this one
    }
  }
  console.error(
    "2019-es7 checkout with src/phaser not found — set CMG_ES7_ROOT",
  );
  Deno.exit(1);
}

const args = [...Deno.args];
let port = 8819;
const portAt = args.indexOf("--port");
if (portAt >= 0) {
  port = Number(args[portAt + 1]);
  if (!Number.isFinite(port)) {
    console.error("--port needs a number");
    Deno.exit(2);
  }
  args.splice(portAt, 2);
}
const savePath = args[0] ?? null;
const ES7_ROOT = resolveEs7();

if (savePath) {
  try {
    Deno.statSync(savePath);
  } catch {
    console.error(`save not found: ${savePath}`);
    Deno.exit(2);
  }
}

Deno.serve({ port, hostname: "127.0.0.1" }, async (req) => {
  const { pathname } = new URL(req.url);

  if (pathname === "/__sav__/save.sav") {
    if (!savePath) {
      return new Response("no save passed to serve-runtime", { status: 404 });
    }
    const bytes = await Deno.readFile(savePath);
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      headers: {
        "content-type": "application/octet-stream",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      },
    });
  }

  if (pathname.startsWith("/es7/")) {
    const res = await serveDir(req, {
      fsRoot: ES7_ROOT,
      urlRoot: "es7",
      enableCors: true,
      quiet: true,
    });
    // Defeat the ES-module cache: without this an edited scene module keeps
    // running its previous revision across reloads.
    const headers = new Headers(res.headers);
    headers.set("cache-control", "no-store");
    headers.delete("etag");
    headers.delete("last-modified");
    return new Response(res.body, { status: res.status, headers });
  }

  return serveDir(req, {
    fsRoot: `${CMG_ROOT}static`,
    enableCors: true,
    quiet: true,
  });
});

console.log(`editor:  http://127.0.0.1:${port}/editor/?game=2028-ai`);
console.log(
  `runtime: http://127.0.0.1:${port}/es7/phaser-game.html?editorPlay=1&stage=0&god=1`,
);
if (savePath) {
  console.log(
    `save:    http://127.0.0.1:${port}/__sav__/save.sav  (${savePath})`,
  );
} else {
  console.log("save:    none passed — add a .sav argument to serve one");
}
console.log(`es7:     ${ES7_ROOT}`);
