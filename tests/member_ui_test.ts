// A member pack's UI: the strip sections its member.json declares
// (lib/member-ui.ts), which the dashboard adds the moment the pack is
// imported. These pin that a declaration is read strictly — only the known
// fields, only paths the pack carries — that the Switch pack's own
// declaration reads back whole, and that the three places the bring-your-own
// handoff is spelled (the module, the dashboard, the player page) agree.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BYO_DATABASE,
  BYO_KEY,
  BYO_STORE,
  describeMemberUi,
  readMemberUi,
} from "../lib/member-ui.ts";
import { memberPacks } from "../lib/member-content.ts";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

const SWITCH = memberPacks([]).find((p) => p.id === "switch")!;
const carries = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

Deno.test("the Switch pack declares one section, and it reads back whole when the pack carries its pages", () => {
  const ui = readMemberUi(
    SWITCH.ui,
    carries("/switch/play.html", "/NintendoSwitch/manifest.json"),
  );
  assert(ui);
  assertEquals(ui.sections.length, 1);
  const s = ui.sections[0];
  assertEquals(s.id, "switch");
  assertEquals(s.player, "/switch/play.html");
  assertEquals(s.manifest, "/NintendoSwitch/manifest.json");
  assertEquals(s.isolated, true);
  assertStringIncludes(s.picker!.accept, ".xci");
  assertEquals(s.byod!.btn, "Choose cartridge…");
  assertEquals(describeMemberUi(ui), "the NINTENDO SWITCH section");
  // The same declaration, as the rule writes it, survives a JSON round trip.
  assertEquals(
    readMemberUi(
      JSON.parse(JSON.stringify(SWITCH.ui)),
      carries("/switch/play.html", "/NintendoSwitch/manifest.json"),
    ),
    ui,
  );
});

Deno.test("a section only opens what its pack carries, and loses what it does not", () => {
  // The shelf list is absent: the section stays, shelfless.
  const shelfless = readMemberUi(SWITCH.ui, carries("/switch/play.html"));
  assertEquals(shelfless?.sections[0].manifest, undefined);
  assertEquals(shelfless?.sections[0].player, "/switch/play.html");
  // The player is absent: there is no section, and nothing to add.
  assertEquals(
    readMemberUi(SWITCH.ui, carries("/NintendoSwitch/manifest.json")),
    null,
  );
  assertEquals(describeMemberUi(null), "");
  // A path that is not a URL path the pack's file list could hold.
  const odd = readMemberUi({
    sections: [{
      ...SWITCH.ui!.sections[0],
      player: "https://example.com/play.html",
    }],
  }, () => true);
  assertEquals(odd, null);
  assertEquals(
    readMemberUi({
      sections: [{ ...SWITCH.ui!.sections[0], player: "/a/../index.html" }],
    }, () => true),
    null,
  );
});

Deno.test("a declaration is read strictly: known fields, sane strings, one section per id", () => {
  const base = SWITCH.ui!.sections[0];
  const ui = readMemberUi({
    sections: [
      // Unknown fields are dropped, and a wrong-typed optional one too.
      { ...base, extra: "ignored", isolated: "yes", icon: 42 },
      // The same id again is not a second tile.
      { ...base, name: "Again" },
      // A required field of the wrong type is a section that does not read.
      { ...base, id: "other", mark: 7 },
      // A slug that is not one.
      { ...base, id: "Not A Slug" },
      // A picker without accept is no picker; a note without a button is no note.
      { ...base, id: "plain", picker: { label: "Add" }, byod: { title: "X" } },
      // Hint tokens: strings and { code } only, anything else dropped.
      {
        ...base,
        id: "hinted",
        byod: {
          ...base.byod,
          hint: [["a", { code: "b" }, { nope: 1 }, 3], "not a line", []],
        },
      },
      "junk",
      null,
    ],
  }, carries("/switch/play.html", "/NintendoSwitch/manifest.json"));
  assert(ui);
  assertEquals(ui.sections.map((s) => s.id), ["switch", "plain", "hinted"]);
  const first = ui.sections[0] as unknown as Record<string, unknown>;
  assertEquals("extra" in first, false);
  assertEquals(first.isolated, undefined);
  assertEquals(first.icon, undefined);
  assertEquals(first.name, "Nintendo Switch");
  assertEquals(ui.sections[1].picker, undefined);
  assertEquals(ui.sections[1].byod, undefined);
  assertEquals(ui.sections[2].byod!.hint, [["a", { code: "b" }]]);
  // Nothing at all, in every shape nothing comes in.
  assertEquals(readMemberUi(undefined, () => true), null);
  assertEquals(readMemberUi("sections", () => true), null);
  assertEquals(readMemberUi({ sections: {} }, () => true), null);
  assertEquals(readMemberUi({ sections: [] }, () => true), null);
  // A text field past its cap does not read.
  assertEquals(
    readMemberUi(
      { sections: [{ ...base, title: "T".repeat(61) }] },
      carries("/switch/play.html"),
    ),
    null,
  );
});

Deno.test("the bring-your-own handoff is spelled the same in the module, the dashboard and the player", async () => {
  const page = await read("static/switch/play.html");
  const dashboard = await read("svelte-src/Dashboard.svelte");
  for (
    const [name, value] of [
      ["BYO_DATABASE", BYO_DATABASE],
      ["BYO_STORE", BYO_STORE],
      ["BYO_KEY", BYO_KEY],
    ]
  ) {
    assertStringIncludes(page, `var ${name} = "${value}";`, name);
    assertStringIncludes(dashboard, `const ${name} = '${value}';`, name);
  }
  // The player is opened with ?byo=1, and reads it.
  assertStringIncludes(dashboard, "'?byo=1'");
  assertStringIncludes(page, 'params.get("byo") === "1"');
  // And it looks for the keys where the pack puts them.
  assertStringIncludes(page, 'var KEYS_DIR = "/switch/keys/";');
});

Deno.test("the catalogue's Switch core is local, with the pack section's own player and shelf", async () => {
  const catalog = JSON.parse(await read("static/emulators.json"));
  const core = catalog.cores.find((c: { id: string }) => c.id === "switch");
  const section = SWITCH.ui!.sections[0];
  assertEquals(core.local, true);
  assertEquals(core.prefixes, []);
  assertEquals(core.isolated, true);
  assertEquals(core.player, section.player);
  assertEquals(core.manifest, section.manifest);
  // The pack section stands in for the core on the strip, so they must
  // agree on the id the dashboard keys both on.
  assertEquals(core.id, section.id);
});
