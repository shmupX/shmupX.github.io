import { defineConfig, type Plugin } from "vite";
import { fresh } from "@fresh/plugin-vite";

// Dev parity for the cross-origin-isolated players. In production these come
// from the main.ts middleware (or from emu-sw.js, which serves the opted-in
// downloads), but Vite serves static files itself in dev, bypassing the Fresh
// app. Keep this list in sync with ISOLATED_PLAYERS in main.ts.
const ISOLATED_PLAYERS = ["/ps2/", "/switch/"];

function playerIsolationHeaders(): Plugin {
  return {
    name: "player-isolation-headers",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && ISOLATED_PLAYERS.some((p) => req.url!.startsWith(p))) {
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        }
        next();
      });
    },
  };
}

// Dev-only access to the Dezaemon sound bank.
//
// SNDPAC.BIN is disc content: gitignored, never committed, and above all never
// published. It must not live under static/, because `vite build` copies that
// whole tree into the deployed site. So it is served here instead — Vite runs
// only in dev (production is the Fresh server), which makes this route
// automatically local-only.
//
// /dev/tone-bank.json  the index: which cut each instrument layer uses, its
//                      root pitch, level, pan and exact loop point
// /dev/tone-bank.pcm   every distinct cut, Int16 little-endian, concatenated
//
// The cutting happens in the engine (packages/shmup-engine/src/audio), the
// same code the PS2 pack goes through, so the browser and the console play
// the same samples. With no bank present both routes 404 and the runtime
// keeps its synthesised voices.
function dezaToneBank(): Plugin {
  let cache: { json: string; pcm: Uint8Array } | null | undefined;

  async function build() {
    if (cache !== undefined) return cache;
    const root = new URL(".", import.meta.url).pathname;
    const { buildWebToneBank, findSndpac } = await import("./lib/sndpac.ts");
    const source = await findSndpac(root, null);
    if (!source) {
      cache = null;
      return cache;
    }
    const { index, pcm } = buildWebToneBank(source.bytes);
    cache = { json: JSON.stringify(index), pcm };
    console.log(
      `[tone-bank] serving ${index.slices.length} Saturn samples from ${source.from}`,
    );
    return cache;
  }

  return {
    name: "deza-tone-bank",
    // Ahead of the Fresh plugin, whose dev middleware answers everything it
    // does not recognise with a 404.
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (url !== "/dev/tone-bank.json" && url !== "/dev/tone-bank.pcm") {
          return next();
        }
        build().then((bank) => {
          if (!bank) {
            res.statusCode = 404;
            res.end("no SNDPAC.BIN in dev-fixtures/");
            return;
          }
          if (url === "/dev/tone-bank.json") {
            res.setHeader("Content-Type", "application/json");
            res.end(bank.json);
          } else {
            res.setHeader("Content-Type", "application/octet-stream");
            res.end(bank.pcm);
          }
        }).catch((error) => {
          console.error("[tone-bank]", error);
          res.statusCode = 500;
          res.end("tone bank failed to build");
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [dezaToneBank(), fresh(), playerIsolationHeaders()],
  server: {
    // Allow ngrok tunnels (and any other host) to reach the dev server.
    // Dev-only — production builds aren't served by Vite.
    allowedHosts: true,
  },
});
