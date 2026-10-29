import { defineConfig, type Plugin } from "vite";
import { fresh } from "@fresh/plugin-vite";
import { TEST_FILE_PATTERN } from "fresh/internal-dev";
import { dirIndexRedirect } from "./lib/static-indexes.ts";

// On an exFAT volume (a USB checkout, say) macOS writes an AppleDouble sidecar
// named `._<name>` beside every file it touches, and re-creates it on the next
// write. The sidecars are binary, but `routes/games/._2028-ai.tsx` still matches
// the .tsx filter on the Fresh plugin's route crawl, so the scan handed one to
// the Deno loader and the build died on `Unexpected character '\0'`. The same
// pattern keeps the crawl off the sidecars in islands/ and static/.
const APPLE_DOUBLE = /(^|[\\/])\._/;

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

// Dev parity for the directory-index redirect in main.ts. Vite serves static/
// itself in dev, bypassing the Fresh app, so /tilemap-editor would keep serving
// the page from the wrong base here and the breakage would only show up in
// production. The list both sides read is lib/static-indexes.ts.
function staticIndexRedirects(): Plugin {
  return {
    name: "static-index-redirects",
    // Ahead of the Fresh plugin, whose dev middleware would answer first.
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const to = req.url ? dirIndexRedirect(req.url) : null;
        if (to === null) return next();
        res.statusCode = 301;
        res.setHeader("Location", to);
        res.end();
      });
    },
  };
}

// The Dezaemon tone bank is no longer served here: the cut bank is published
// with the game (static/games/2028-ai/assets/tone-bank/, `deno task
// deza:tonebank --web`), so dev and production load the same files.

export default defineConfig({
  plugins: [
    staticIndexRedirects(),
    // `ignore` replaces the plugin's default list rather than extending it, so
    // the test-file pattern has to be carried over — dropping it would turn
    // `routes/foo_test.ts` into a route.
    fresh({ ignore: [TEST_FILE_PATTERN, APPLE_DOUBLE] }),
    playerIsolationHeaders(),
  ],
  server: {
    // Allow ngrok tunnels (and any other host) to reach the dev server.
    // Dev-only — production builds aren't served by Vite.
    allowedHosts: true,
    watch: {
      // build/ is where every export lands, and an export is tens of thousands
      // of files — a staged www/, a whole cordova project, an unpacked Electron
      // app. Watching it means a build kicked off from the editor's EXPORT
      // button spends its minutes making the dev server churn and telling every
      // client to reload, over files no client ever loads. Nothing under build/
      // is served, so there is nothing to watch it for.
      ignored: ["**/build/**"],
    },
  },
});
