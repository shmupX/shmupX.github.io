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

export default defineConfig({
  plugins: [fresh(), playerIsolationHeaders()],
  server: {
    // Allow ngrok tunnels (and any other host) to reach the dev server.
    // Dev-only — production builds aren't served by Vite.
    allowedHosts: true,
  },
});
