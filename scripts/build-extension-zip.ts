// scripts/build-extension-zip.ts — the shmupX Sprite Picker as the archive
// https://codemonkey.games/extension hands out.
//
//   deno task extension:zip      # tools/sprite-picker-extension → static/extension/shmupx-sprite-picker.zip
//
// Chrome loads an extension unpacked from a folder, so the archive is that
// folder, named — unpack anywhere and "Load unpacked" points at
// shmupx-sprite-picker/. The test/ directory and the README stay out: they are
// the repo's, not the extension's. Beside the zip goes meta.json — the
// manifest's version, the archive's size and its file count — which the page
// reads for its one line of facts. Both are build output (gitignored, made by
// `deno task build`), so the download always matches the commit it is served
// from and never a stale copy somebody forgot to rebuild.

import { fromFileUrl } from "@std/path";
import { buildZip, treeEntries } from "@shmupx/shmup-harbor/zip";

const SRC = fromFileUrl(
  new URL("../tools/sprite-picker-extension", import.meta.url),
);
const OUT_DIR = new URL("../static/extension/", import.meta.url);
export const FOLDER = "shmupx-sprite-picker";
/** Repo-side files that are not part of what Chrome loads. */
const SKIP = /^shmupx-sprite-picker\/(test\/|README\.md$)/;
// Fixed, so zipping the same inputs twice gives the same bytes.
const STAMP = new Date("2026-10-15T00:00:00Z");

if (import.meta.main) {
  const entries = (await treeEntries(SRC, FOLDER)).filter((e) =>
    !SKIP.test(e.path)
  );
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const zip = await buildZip(entries, STAMP);
  const manifest = JSON.parse(
    await Deno.readTextFile(`${SRC}/manifest.json`),
  ) as { version?: string; name?: string };
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const zipPath = new URL(`${FOLDER}.zip`, OUT_DIR);
  await Deno.writeFile(zipPath, zip);
  const meta = {
    name: manifest.name ?? "shmupX Sprite Picker",
    version: manifest.version ?? "0",
    bytes: zip.length,
    files: entries.length,
    file: `${FOLDER}.zip`,
  };
  await Deno.writeTextFile(
    new URL("meta.json", OUT_DIR),
    JSON.stringify(meta, null, 2) + "\n",
  );
  console.log(
    `wrote ${fromFileUrl(zipPath)} (${(zip.length / 1024).toFixed(0)} KB, ${entries.length} files, v${meta.version})`,
  );
}
