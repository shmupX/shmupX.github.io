// Generate static/games.manifest.json — the OTA launcher manifest — from
// data/games.json (the Games list) and data/demos.json (the Games → Demos list).
//
// The launcher binary and the web dashboard both fetch this manifest at runtime
// (deployed origin first, same-origin fallback — see Dashboard.svelte's
// loadManifest, mirroring scripts/2028-ai/boot-entry.js). So adding a game or a
// demo to data/*.json and pushing to main redeploys it to every CMG Launcher
// with no binary rebuild: Deno Deploy runs `deno task build`, which runs this.
//
// Mirrors build-tg16-manifest.ts: Deno Deploy can serve files in static/ but
// cannot Deno.readDir the source tree, so the committed manifest is the
// authoritative, served index.

interface ManifestEntry {
  id: string;
  name: string;
  title?: string;
  sub?: string;
  icon?: string | null;
  size?: string;
  date?: string;
  // In-repo games/demos carry a Fresh-route path (e.g. "/games/2028-ai",
  // "/demos/goofy-game"); it is resolved against the manifest's own origin at
  // runtime. External games omit `url` and load from https://easierbycode.com/<id>.
  url?: string;
  // Opt-in launcher capabilities, carried through verbatim and read by the
  // dashboard OSD. `twinStick`: dual-analog mode. `levelEditor`: the game ships
  // a level editor — true (derive /editor/?game=<id>), a same-origin /editor…
  // path, or { game, url }. Extra keys survive JSON round-trip, so these are
  // documentation of the shape the dashboard understands, not a filter.
  twinStick?: boolean | { default?: boolean };
  levelEditor?: boolean | string | { game?: string; url?: string };
}

// Read + validate a JSON array of entries. `required` files must exist; optional
// ones (demos) default to [] if absent so the build never fails on a fresh tree.
async function readEntries(
  label: string,
  url: URL,
  required: boolean,
): Promise<ManifestEntry[]> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(url);
  } catch (e) {
    if (!required && (e instanceof Deno.errors.NotFound)) return [];
    console.error(
      `[games-manifest] cannot read ${url.pathname}: ${(e as Error).message}`,
    );
    Deno.exit(1);
  }
  let entries: ManifestEntry[];
  try {
    entries = JSON.parse(raw) as ManifestEntry[];
  } catch (e) {
    console.error(
      `[games-manifest] ${url.pathname} is not valid JSON: ${
        (e as Error).message
      }`,
    );
    Deno.exit(1);
  }
  if (!Array.isArray(entries)) {
    console.error(`[games-manifest] ${url.pathname} is not a JSON array`);
    Deno.exit(1);
  }
  for (const [i, e] of entries.entries()) {
    if (!e || typeof e.id !== "string" || typeof e.name !== "string") {
      console.error(
        `[games-manifest] ${label}[${i}] is missing a string "id" and/or "name"`,
      );
      Deno.exit(1);
    }
  }
  return entries;
}

const dataDir = new URL("../data/", import.meta.url);
const outUrl = new URL("../static/games.manifest.json", import.meta.url);

const games = await readEntries("games", new URL("games.json", dataDir), true);
const demos = await readEntries("demos", new URL("demos.json", dataDir), false);

// Version is informational (observability/debugging) — the client never gates
// on it, unlike TokScrape's sha256/minNativeVersion. Prefer the git short SHA
// for human readability; fall back to a content hash (over both lists, so the
// version changes whenever either does) where git is unavailable.
async function gitShortSha(): Promise<string | null> {
  try {
    const { code, stdout } = await new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (code === 0) {
      const sha = new TextDecoder().decode(stdout).trim();
      if (sha) return sha;
    }
  } catch (_e) {
    // git not present — fall through to the content hash.
  }
  return null;
}

async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 7);
}

const version = (await gitShortSha()) ??
  await contentHash(JSON.stringify({ games, demos }));

const manifest = {
  version,
  generatedAt: new Date().toISOString(),
  games,
  demos,
};

await Deno.writeTextFile(outUrl, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `[games-manifest] wrote ${games.length} game(s) + ${demos.length} demo(s) (version ${version}) to ${outUrl.pathname}`,
);
