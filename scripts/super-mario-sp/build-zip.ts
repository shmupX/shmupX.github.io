// Pack static/games/super-mario-sp/ into the archive the eShop installs.
//
//   deno task super-mario-sp:zip
//
// The eShop's only install path is a zip (static/eshop-library.js's
// installWebGame), and Deno Deploy can serve static/ but cannot Deno.readDir it
// at runtime -- the same constraint that makes games.manifest.json a committed
// file -- so the archive cannot be produced on demand by a route. It is built
// here instead, ahead of `vite build`, exactly the way
// static/games/2028-ai/assets/custom-bgm/ is.
//
// Three details are load-bearing, and each one is a bug the eShop would
// otherwise report as something else:
//
//   ROOT, NOT WRAPPED. stripWrapper (eshop-library.js) only unwraps the
//   "<repo>-<branch>/" folder a GitHub zipball carries, and it returns early
//   when the entry tracks no GitHub repo -- which this one does not. So a
//   wrapper folder would never be removed and the install would die with
//   "index.html is not in the archive".
//
//   NO APPLEDOUBLE SIDECARS. treeEntries() walks every file it finds, and this
//   checkout lives on an exFAT volume where macOS writes a `._name` sidecar
//   beside anything it touches. Unfiltered, those ship to the deploy and get
//   written into every player's Cache Storage.
//
//   THE LAUNCHER MARKER. main.ts stamps it into /games/* HTML on the way out,
//   but the installed copy is served from Cache Storage by emu-sw.js, which
//   returns the stored bytes untouched. Stamping it in here means the archive
//   carries what the served page has. injectLauncherMarker is idempotent, so
//   the launcher's own client-side stamp cannot double it.

import { buildZip, treeEntries } from "@shmupx/shmup-harbor/zip";
import { fromFileUrl } from "@std/path";
import { injectLauncherMarker } from "../../lib/launcher-inject.ts";

// fromFileUrl, not .pathname: this checkout's path has a space in it.
const GAME = fromFileUrl(
  new URL("../../static/games/super-mario-sp/", import.meta.url),
);
const OUT = new URL(
  "../../static/games/super-mario-sp-web.zip",
  import.meta.url,
);

// Fixed, so zipping the same folder twice gives the same bytes -- the same
// discipline buildZip's own docstring asks for.
const STAMP = new Date("2026-09-13T00:00:00Z");

const FOLDER = "super-mario-sp";

/** The archive's entries: the game folder, rooted, cleaned and stamped. */
export async function gameEntries() {
  const entries = (await treeEntries(GAME, FOLDER))
    // Drop the wrapper treeEntries adds, so the archive root IS the game root.
    .map((e) => ({ ...e, path: e.path.slice(FOLDER.length + 1) }))
    .filter((e) =>
      e.path &&
      !e.path.split("/").some((s) => s.startsWith("._") || s === ".DS_Store")
    );
  for (const e of entries) {
    if (e.path === "index.html") {
      const html = injectLauncherMarker(new TextDecoder().decode(e.data));
      e.data = new TextEncoder().encode(html);
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

if (import.meta.main) {
  const entries = await gameEntries();
  if (!entries.some((e) => e.path === "index.html")) {
    console.error(
      "index.html is missing from the archive root -- the eShop install would " +
        "fail with exactly that message. Top level holds: " +
        [...new Set(entries.map((e) => e.path.split("/")[0]))].join(", "),
    );
    Deno.exit(1);
  }
  const zip = await buildZip(entries, STAMP);
  await Deno.writeFile(OUT, zip);
  const mb = zip.length / 1048576;
  console.log(
    `super-mario-sp-web.zip  ${entries.length} files  ` +
      `${zip.length.toLocaleString("en-US")} bytes (${mb.toFixed(1)} MB)`,
  );
  console.log(`set "size" in data/eshop.json to "${mb.toFixed(1)} MB"`);
}
