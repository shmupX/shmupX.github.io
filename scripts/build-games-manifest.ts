// Generate static/games.manifest.json — the OTA launcher manifest — from
// data/games.json (the PLAYER game list, the Games screen's own rows) and
// data/eshop.json (the GLOBAL game list, the eShop's catalog).
//
// The launcher binary and the web dashboard both fetch this manifest at runtime
// (deployed origin first, same-origin fallback — see Dashboard.svelte's
// loadManifest, mirroring scripts/2028-ai/boot-entry.js). So adding a game to
// data/games.json, or a game to the eShop by pull request against
// data/eshop.json, and pushing to main redeploys it to every CMG Launcher with
// no binary rebuild: Deno Deploy runs `deno task build`, which runs this.
//
// Mirrors build-tg16-manifest.ts: Deno Deploy can serve files in static/ but
// cannot Deno.readDir the source tree, so the committed manifest is the
// authoritative, served index. The eShop's second source — games published from
// the level editor into the Realtime Database — is merged at runtime by
// static/eshop-library.js, not here: it changes without a deploy.
//
// The eShop entries are validated on the way through (the same rules
// tests/eshop_catalog_test.ts enforces, so a bad PR fails both `deno task
// games:manifest` and CI) because an entry the installer cannot act on would
// otherwise ship as a row that never installs.

interface ManifestEntry {
  id: string;
  name: string;
  title?: string;
  sub?: string;
  icon?: string | null;
  size?: string;
  date?: string;
  // In-repo games carry a Fresh-route path (e.g. "/games/2028-ai"); it is
  // resolved against the manifest's own origin at runtime. External games omit
  // `url` and load from https://easierbycode.com/<id>.
  url?: string;
  // Opt-in launcher capabilities, carried through verbatim and read by the
  // dashboard OSD. `twinStick`: dual-analog mode. `levelEditor`: the game ships
  // a level editor — true (derive /editor/?game=<id>), a same-origin /editor…
  // path, or { game, url }. Extra keys survive JSON round-trip, so these are
  // documentation of the shape the dashboard understands, not a filter.
  twinStick?: boolean | { default?: boolean };
  levelEditor?: boolean | string | { game?: string; url?: string };
}

// An eShop catalog entry (data/eshop.json). Two kinds: a "web" build the
// installer unzips into Cache Storage and serves from /eshop/<id>/, and a
// "deza" Dezaemon 2 save that goes onto the shelf. The per-kind fields the
// installer reads are checked below; twinStick / touchControls / levelEditor
// pass through with the same meaning as on a Games entry.
interface EshopEntry extends ManifestEntry {
  kind: "web" | "deza";
  // web
  source?: "github" | "url";
  repo?: string;
  branch?: string;
  entry?: string;
  subdir?: string;
  downloadUrl?: string;
  streamUrl?: string;
  // deza
  sav?: string;
  slug?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DATE_RE = /^\d{2}\.\d{2}\.\d{2}$/;

/** https, or root-relative on this origin — the only URLs the installer fetches. */
function isFetchableUrl(v: unknown): boolean {
  return typeof v === "string" &&
    (/^https:\/\/[^/]+\//.test(v) ||
      (v.startsWith("/") && !v.startsWith("//")));
}

/** Every rule an eShop entry has to meet; empty when it is fine. */
export function eshopEntryProblems(e: EshopEntry, i: number): string[] {
  const at = `eshop[${i}]`;
  const problems: string[] = [];
  if (!ID_RE.test(e.id)) {
    problems.push(`${at}: id "${e.id}" must match ${ID_RE} (a path segment)`);
  }
  if (typeof e.title !== "string" || !e.title) {
    problems.push(`${at}: needs a string "title"`);
  }
  if (e.icon != null && !isFetchableUrl(e.icon)) {
    problems.push(`${at}: icon must be https or root-relative`);
  }
  if (e.date != null && !DATE_RE.test(e.date)) {
    problems.push(`${at}: date must be "MM.DD.YY"`);
  }
  if (e.size != null && typeof e.size !== "string") {
    problems.push(`${at}: size must be a label like "8 MB"`);
  }
  if (e.kind === "web") {
    if (e.source !== "github" && e.source !== "url") {
      problems.push(`${at}: web source must be "github" or "url"`);
    }
    if (e.source === "github" && !REPO_RE.test(e.repo ?? "")) {
      problems.push(`${at}: github entries need repo "owner/name"`);
    }
    if (e.source === "url" && !isFetchableUrl(e.downloadUrl)) {
      problems.push(
        `${at}: url entries need an https or root-relative downloadUrl`,
      );
    }
    if (e.downloadUrl != null && !isFetchableUrl(e.downloadUrl)) {
      problems.push(`${at}: downloadUrl must be https or root-relative`);
    }
    if (e.streamUrl != null && !isFetchableUrl(e.streamUrl)) {
      problems.push(`${at}: streamUrl must be https or root-relative`);
    }
    for (const key of ["branch", "entry", "subdir"] as const) {
      const v = e[key];
      if (v != null && (typeof v !== "string" || !v || v.includes(".."))) {
        problems.push(`${at}: ${key} must be a plain relative name`);
      }
    }
  } else if (e.kind === "deza") {
    if (e.sav == null && e.slug == null) {
      problems.push(`${at}: deza entries need "sav" (a URL) or "slug"`);
    }
    if (e.sav != null && !isFetchableUrl(e.sav)) {
      problems.push(`${at}: sav must be https or root-relative`);
    }
    if (e.slug != null && !ID_RE.test(e.slug)) {
      problems.push(`${at}: slug must match ${ID_RE}`);
    }
  } else {
    problems.push(`${at}: kind must be "web" or "deza"`);
  }
  return problems;
}

// Read + validate a JSON array of entries. `required` files must exist;
// optional ones default to [] if absent so the build never fails on a fresh
// tree.
async function readEntries<T extends ManifestEntry>(
  label: string,
  url: URL,
  required: boolean,
): Promise<T[]> {
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
  let entries: T[];
  try {
    entries = JSON.parse(raw) as T[];
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

// Version is informational (observability/debugging) — the client never
// gates on it, unlike TokScrape's sha256/minNativeVersion. Prefer the git
// short SHA for human readability; fall back to a content hash (over both
// lists, so the version changes whenever either does) where git is
// unavailable.
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

if (import.meta.main) {
  const dataDir = new URL("../data/", import.meta.url);
  const outUrl = new URL("../static/games.manifest.json", import.meta.url);

  const games = await readEntries<ManifestEntry>(
    "games",
    new URL("games.json", dataDir),
    true,
  );
  const eshop = await readEntries<EshopEntry>(
    "eshop",
    new URL("eshop.json", dataDir),
    false,
  );

  // Ids double as cache paths (/eshop/<id>/…) and shelf ids (eshop:<id>), so
  // they have to be unique and path-safe; everything else the installer needs
  // is checked per kind.
  const problems = eshop.flatMap((e, i) => eshopEntryProblems(e, i));
  const seen = new Set<string>();
  for (const e of eshop) {
    if (seen.has(e.id)) problems.push(`eshop: duplicate id "${e.id}"`);
    seen.add(e.id);
  }
  if (problems.length) {
    for (const p of problems) console.error(`[games-manifest] ${p}`);
    Deno.exit(1);
  }

  const version = (await gitShortSha()) ??
    await contentHash(JSON.stringify({ games, eshop }));

  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    games,
    eshop,
  };

  await Deno.writeTextFile(outUrl, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `[games-manifest] wrote ${games.length} game(s) + ${eshop.length} eShop entr${
      eshop.length === 1 ? "y" : "ies"
    } (version ${version}) to ${outUrl.pathname}`,
  );
}
