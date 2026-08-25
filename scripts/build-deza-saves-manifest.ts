// Generate static/editor/dezaemon/saves.manifest.json — the index of the
// community Dezaemon 2 save collection the level editor's ".SAV LOAD GAME"
// shelf lists (static/editor/index.html → openDezaemonLibrary).
//
// Same constraint as build-games-manifest.ts: Deno Deploy serves files under
// static/ but cannot Deno.readDir the source tree, so the committed manifest is
// the authoritative, served index — the editor fetches it instead of asking a
// route to list a directory. That also means the shelf works identically in the
// three places the editor runs: `deno task dev`, the deployed origin, and the
// packaged desktop app (where these files live in the deno-compile VFS).
//
// Saves live beside this manifest in saves/ and are fetched straight from there,
// so adding one is: drop the file in, re-run the build, commit both.

// The collection is named "Dez 2 - <title>.sav" (the MiSTer/Saturn convention).
// The title is what games-db.json is keyed on, so the prefix comes off here
// rather than in the editor.
const NAME_PREFIX = /^Dez 2 - /;
const SAVE_EXT = /\.(sav|bcr|bkr)$/i;

interface SaveEntry {
  file: string;
  title: string;
  size: number;
}

const savesDir = new URL("../static/editor/dezaemon/saves/", import.meta.url);
const outUrl = new URL(
  "../static/editor/dezaemon/saves.manifest.json",
  import.meta.url,
);

const saves: SaveEntry[] = [];
try {
  for await (const entry of Deno.readDir(savesDir)) {
    if (!entry.isFile || !SAVE_EXT.test(entry.name)) continue;
    const { size } = await Deno.stat(new URL(entry.name, savesDir));
    saves.push({
      file: entry.name,
      title: entry.name.replace(SAVE_EXT, "").replace(NAME_PREFIX, ""),
      size,
    });
  }
} catch (e) {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
  // No collection in this checkout — write an empty manifest so the shelf shows
  // its "no saves" note rather than failing on a 404.
}

saves.sort((a, b) => a.title.localeCompare(b.title));

// Rewriting an unchanged manifest would bump generatedAt on every build and
// leave a spurious diff in every working tree, so only the list decides.
let previous: { saves?: SaveEntry[] } = {};
try {
  previous = JSON.parse(await Deno.readTextFile(outUrl));
} catch (_e) { /* first run — write it */ }
if (JSON.stringify(previous.saves) === JSON.stringify(saves)) {
  console.log(
    `[deza-saves] ${saves.length} save(s) — manifest already current`,
  );
} else {
  const manifest = {
    generatedAt: new Date().toISOString(),
    count: saves.length,
    saves,
  };
  await Deno.writeTextFile(outUrl, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `[deza-saves] wrote ${saves.length} save(s) to ${outUrl.pathname}`,
  );
}
