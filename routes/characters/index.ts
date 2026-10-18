// GET /characters — the characters library as a live ES module.
//
// The static module on GitHub Pages (easierbycode.com/2019-es7/characters/)
// bakes its named exports in at build time, so a character created in the
// editor is only importable by name after a rebuild + redeploy. This route
// removes that loop: on every request it lists shmupX/characters in the RTDB
// and emits a tiny module that re-exports the static component code and
// declares one export per character that exists *right now* (plus a
// PascalCase alias — Svelte templates need capitalized tags). Local explicit
// exports legally shadow the `export *`, so stale names baked into the static
// build are harmlessly overridden.
//
// Served extensionless with a real JavaScript content-type and open CORS, so
// `import("https://<this host>/characters")` works from anywhere — including
// cmg's scene-script compiler, which rewrites the documentation URL
// (easierbycode.com/2019-es7/characters) to this route on cmg-served pages
// (see static/phaser-plugins/scene-script.js).
//
// The characters are shmupX's own, under the `shmupX/` subtree of the
// database it shares with cmg (lib/rtdb-root.ts); the root-level
// `characters/*` is cmg's catalog. Listing the subtree is only half of it:
// the static module fetches each record (characters/<n>, and the atlas its
// textureKey names) from `globalThis.__CHARACTERS_DB__`, falling back to the
// database root, so a module that exported shmupX's names while the records
// came from — and saveCharacter wrote to — cmg's root copy would be two
// catalogs pretending to be one. Every module this route serves therefore
// names the scoped base itself. Pages set the same global next to their
// Firebase config, and one that already did (a test database, say) is left
// as it is.
import { define } from "../../utils.ts";
import { RTDB_ROOT, rtdbPath } from "../../lib/rtdb-root.ts";

// The DATABASE, as CHARACTERS_DB always meant; the root goes on top, so a
// deployment that set it to the bare database URL keeps working.
const DB = (Deno.env.get("CHARACTERS_DB") ??
  "https://evil-invaders-default-rtdb.firebaseio.com").replace(/\/+$/, "");
/** The base the static module reads characters/<n> and atlases/<key> from. */
const CHARACTERS_BASE = `${DB}/${RTDB_ROOT}`;
const SET_BASE = `globalThis.__CHARACTERS_DB__ ||= ${
  JSON.stringify(CHARACTERS_BASE)
};`;
const STATIC_MODULE = Deno.env.get("CHARACTERS_STATIC") ??
  "https://easierbycode.com/2019-es7/characters/browser.js";

const CACHE_MS = 60_000;

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Names the static module already exports for things that are not characters
// (mirrors RESERVED in 2019-es7 characters/build.mjs).
const RESERVED = new Set([
  "default",
  "character",
  "Character",
  "Adopt",
  "CHARACTERS",
  "Game",
  "Scene",
  "Spawner",
  "Sprite",
  "Text",
  "TileSprite",
  "Rectangle",
  "Container",
  "ArcadePhysics",
  "ArcadeCollider",
]);

// ECMAScript keywords pass IDENT_RE but can never be `export const` names —
// a character stored as "class" (the DB is open-write) would otherwise turn
// the whole generated module into one SyntaxError for every consumer.
const JS_KEYWORDS = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function pascal(name: string): string {
  const p = name.replace(/[_-]+(.)/g, (_m, c: string) => c.toUpperCase());
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function renderModule(names: string[]): string {
  const lines = [
    "// Generated per-request from the characters database — named exports",
    "// stay current without rebuilding the static module. Component code:",
    `// ${STATIC_MODULE}`,
    `export * from ${JSON.stringify(STATIC_MODULE)};`,
    `import { character } from ${JSON.stringify(STATIC_MODULE)};`,
    "",
    // Imports evaluate first, but the static module reads the global on each
    // fetch, so setting it here is in time for the first character() below.
    SET_BASE,
    "",
  ];
  const seen = new Set(RESERVED);
  for (const n of names) {
    if (!IDENT_RE.test(n) || seen.has(n) || JS_KEYWORDS.has(n)) continue;
    lines.push(`export const ${n} = character(${JSON.stringify(n)});`);
    seen.add(n);
    const alias = pascal(n);
    if (
      alias !== n && IDENT_RE.test(alias) && !seen.has(alias) &&
      !JS_KEYWORDS.has(alias)
    ) {
      lines.push(`export { ${n} as ${alias} };`);
      seen.add(alias);
    }
  }
  lines.push("", `export const CHARACTERS = ${JSON.stringify(names)};`, "");
  return lines.join("\n");
}

let cached: { body: string; at: number } | null = null;

async function moduleBody(): Promise<string> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.body;
  try {
    const res = await fetch(
      `${DB}/${rtdbPath("characters")}.json?shallow=true`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) throw new Error(`RTDB HTTP ${res.status}`);
    const keys = (await res.json()) as Record<string, unknown> | null;
    const names = keys ? Object.keys(keys).sort() : [];
    cached = { body: renderModule(names), at: Date.now() };
    return cached.body;
  } catch (err) {
    // Stale beats broken; with no cache at all fall back to the static list.
    if (cached) return cached.body;
    console.error("[/characters] listing failed:", err);
    return `export * from ${JSON.stringify(STATIC_MODULE)};\n${SET_BASE}\n`;
  }
}

export const handler = define.handlers({
  async GET(_ctx) {
    return new Response(await moduleBody(), {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=60",
      },
    });
  },
});
