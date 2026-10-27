// Write static/NintendoSwitch/manifest.json — the Nintendo Switch shelf — by
// scanning the cartridge folder. Ported from cmg's scripts/build-switch-
// manifest.ts: the deploy can serve a file in static/ but cannot read the
// folder at runtime, so the list is written here and is what the section
// reads (static/switch/play.html opens a row by its `file`).
//
// The cartridges are gitignored, and so are their covers; the manifest is
// not, and is committed empty. A fresh clone and the deploy therefore ship an
// empty shelf, and the section offers BYOC — Bring Your Own Cartridge —
// instead. The folder, the list and the covers are the `switch` member
// pack's (lib/member-content.ts): `deno task members:pack` zips them, and a
// packaged launcher reads the shelf out of the pack.

interface SwitchRom {
  file: string;
  name: string;
  url: string;
  size: string;
  date: string;
  icon?: string;
}

// The three containers Voland accepts (its docs/DUMP.md): .xci cartridge
// dumps, .nsp eShop packages, .nro homebrew. Compressed .nsz/.xcz are
// explicitly unsupported upstream, and .nca (the raw archive inside an
// xci/nsp) is not a standalone bootable unit — neither is matched here.
const SWITCH_EXT = /\.(xci|nsp|nro)$/i;

const dirUrl = new URL("../static/NintendoSwitch/", import.meta.url);
const manifestPath = new URL("manifest.json", dirUrl);

// Strip trailing region / version / dump tags — "(USA)", "[v0]", "(World)" —
// repeatedly.
function cleanName(file: string): string {
  let name = file.replace(SWITCH_EXT, "");
  let prev: string;
  do {
    prev = name;
    name = name.replace(/\s*[\[(][^\[\]()]*[\])]\s*$/, "").trim();
  } while (name !== prev);
  return name || file.replace(SWITCH_EXT, "");
}

// Cover art lives in covers/ beside the cartridges — the served URL when
// <basename>.png exists.
async function coverIcon(file: string): Promise<string | undefined> {
  const base = file.replace(SWITCH_EXT, "");
  try {
    await Deno.stat(new URL(`covers/${base}.png`, dirUrl));
    return `/NintendoSwitch/covers/${encodeURIComponent(base)}.png`;
  } catch {
    return undefined;
  }
}

const games: SwitchRom[] = [];
try {
  for await (const entry of Deno.readDir(dirUrl)) {
    if (!entry.isFile) continue;
    if (!SWITCH_EXT.test(entry.name)) continue;
    const stat = await Deno.stat(new URL(entry.name, dirUrl));
    // Switch cartridges run to tens of gigabytes, so report GB once past a
    // gigabyte — "31457.3 MB" is unreadable in the dashboard's meta column.
    const bytes = stat.size;
    const size = bytes >= 1024 * 1024 * 1024
      ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    const d = stat.mtime ?? new Date();
    const date = `${String(d.getMonth() + 1).padStart(2, "0")}.${
      String(d.getDate()).padStart(2, "0")
    }.${String(d.getFullYear()).slice(-2)}`;
    const icon = await coverIcon(entry.name);
    games.push({
      file: entry.name,
      name: cleanName(entry.name),
      url: `/NintendoSwitch/${encodeURIComponent(entry.name)}`,
      size,
      date,
      ...(icon ? { icon } : {}),
    });
  }
} catch (e) {
  console.error(
    `[switch-manifest] could not read ${dirUrl.pathname}: ${
      (e as Error).message
    }`,
  );
}

games.sort((a, b) => a.name.localeCompare(b.name));

await Deno.writeTextFile(
  manifestPath,
  games.length ? JSON.stringify(games, null, 2) + "\n" : "[]\n",
);
console.log(
  `[switch-manifest] wrote ${games.length} cartridge${
    games.length === 1 ? "" : "s"
  } to ${manifestPath.pathname}`,
);
