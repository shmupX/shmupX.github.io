// lib/static-indexes.ts carries a copy of which directories under static/ hold
// an index.html, because main.ts and vite.config.ts have to redirect the bare
// /tilemap-editor to /tilemap-editor/ before anything serves it, and Deploy can
// serve static/ but can't list it at runtime to work that out for itself.
//
// A directory index missing from that copy keeps the old failure: the page
// loads at the bare URL and every relative URL in it resolves one level too
// high, which reads as a page that renders but whose scripts 404. So the copy
// is checked against the tree rather than trusted.

import { assertEquals } from "@std/assert";
import { dirIndexRedirect, STATIC_INDEXES } from "../lib/static-indexes.ts";

const STATIC = new URL("../static/", import.meta.url);

async function isFile(url: URL): Promise<boolean> {
  try {
    return (await Deno.stat(url)).isFile;
  } catch {
    return false;
  }
}

/** Every directory under static/ holding an index.html, as a URL pathname. */
async function dirIndexes(dir: URL, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isDirectory) continue;
    const at = `${prefix}/${entry.name}`;
    const sub = new URL(`${entry.name}/`, dir);
    if (await isFile(new URL("index.html", sub))) found.push(at);
    found.push(...await dirIndexes(sub, at));
  }
  return found.sort();
}

Deno.test("STATIC_INDEXES matches the directory indexes under static/", async () => {
  assertEquals(
    [...STATIC_INDEXES].sort(),
    await dirIndexes(STATIC),
    "lib/static-indexes.ts has drifted from static/. A path on disk but not in " +
      "the list serves its page at the bare URL with every relative URL in it " +
      "resolving one level too high; a path in the list but not on disk " +
      "redirects to a 404.",
  );
});

Deno.test("dirIndexRedirect canonicalises only the bare directory URL", () => {
  assertEquals(dirIndexRedirect("/tilemap-editor"), "/tilemap-editor/");
  assertEquals(
    dirIndexRedirect("/tilemap-editor?level=foo"),
    "/tilemap-editor/?level=foo",
  );

  // Already canonical, or not a directory index at all: left alone. The last
  // two matter most — a prefix match here would redirect a real asset and a
  // Fresh route into 404s.
  for (
    const url of [
      "/tilemap-editor/",
      "/tilemap-editor/tilemap-editor.js",
      "/tilemap-editor.js",
      "/tilemap-editor-nope",
      "/games/2028-ai",
      "/characters",
      "/",
    ]
  ) {
    assertEquals(dirIndexRedirect(url), null, url);
  }
});
