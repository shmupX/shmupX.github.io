// The editor files its own .sav builds through static/deza-exports.js, and the
// launcher's SAVED GAMES coverflow reads the same store through the same
// module — that is the whole reason the module exists. The editor still keeps
// one thing inline (the id formula runs synchronously in the export flow), so
// pin that copy to the module's, and make sure the editor really does route
// its store traffic through the module rather than an IndexedDB copy of its
// own that could drift.

import { assert, assertEquals } from "@std/assert";
import { dezaExportId } from "../static/deza-exports.js";

const editor = await Deno.readTextFile(
  new URL("../static/editor/index.html", import.meta.url),
);

Deno.test("the editor's inline export id is the module's", () => {
  const m = editor.match(
    /function dezaExportId\(title, palette\) \{\s*return ([^\r\n]+);/,
  );
  assert(m, "dezaExportId not found in the editor");
  const inline = new Function("title", "palette", `return ${m[1]};`) as (
    t: string,
    p: string,
  ) => string;
  for (
    const [title, palette] of [
      ["foo", "saturn"],
      ["Dez 2 - Foo!", "sfc"],
      ["  Sōkyū Gurentai  ", "saturn"],
      ["2028.Ai", "sfc"],
      ["", "saturn"],
    ]
  ) {
    assertEquals(inline(title, palette), dezaExportId(title, palette));
  }
  assertEquals(dezaExportId("Dez 2 - Foo!", "sfc"), "dez-2-foo:sfc");
});

Deno.test("the editor stores exports through the shared module", () => {
  assert(
    editor.includes("import('/deza-exports.js')"),
    "the editor should lazy-import static/deza-exports.js",
  );
  assert(
    !/indexedDB\.open\(DEZA_EXPORTS_DB/.test(editor),
    "the editor still opens the exports database itself",
  );
});
