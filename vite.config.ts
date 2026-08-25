import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";

export default defineConfig({
  plugins: [fresh()],
  server: {
    // Allow ngrok tunnels (and any other host) to reach the dev server.
    // Dev-only — production builds aren't served by Vite.
    allowedHosts: true,
  },
});
