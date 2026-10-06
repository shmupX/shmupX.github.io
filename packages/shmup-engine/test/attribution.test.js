// Attribution: the names a level record carries, set into a cart's staff roll
// and read back by the decoders that read real saves.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { decodeSave } from "../src/decode/index.js";
import { mapSaveToGame } from "../src/map-to-game.js";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { isGameSave } from "../src/payload-table.js";
import { exportLevelToSav } from "../src/write/export-sav.js";
import {
  authorFromEnvironment,
  CREDIT_STRIP_H,
  CREDIT_STRIP_W,
  creditStripRgba,
  foldCreditText,
  normalizeAttribution,
  resolveAttribution,
  staffRolesFor,
} from "../src/write/attribution.js";

function frame(w, h, [r, g, b]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([r, g, b, 255], i * 4);
  rgba[3] = 0;
  return { w, h, rgba };
}

function level(extra = {}) {
  return {
    name: "tiny",
    width: 8,
    enemylist: [["A1", "00", "00", "A0", "00", "00", "00", "A1"]],
    enemyData: {
      enemyA: {
        hp: 3,
        score: 200,
        speed: 1,
        interval: 60,
        texture: ["dot.png"],
      },
    },
    bossData: {},
    ...extra,
  };
}
const art = () => ({ "dot.png": frame(12, 14, [255, 0, 0]) });

/** Export, then read the cart back the way the editor's import does. */
async function roundTrip(lvl, options = {}, pictures = art()) {
  const out = exportLevelToSav(lvl, pictures, options);
  const [save] = bup.parse((await normalize(out.sav)).data).filter(isGameSave);
  const decoded = decodeSave(save.payload.buffer);
  return { out, decoded, strips: stripsOf(decoded) };
}

/** credit slot -> the ink mask the cart holds there, in strip coordinates. */
function stripsOf(decoded) {
  const strips = {};
  for (const [role, index] of Object.entries(decoded.titleArt || {})) {
    const m = /^credit(\d)$/.exec(role);
    if (!m) continue;
    const sprite = decoded.sprites[index];
    const at = decoded.titleLayout.credits[Number(m[1])];
    const ink = new Set();
    for (let y = 0; y < sprite.h; y++) {
      for (let x = 0; x < sprite.w; x++) {
        if (sprite.rgba[(y * sprite.w + x) * 4 + 3]) {
          ink.add(`${at.x + x},${at.y + y}`);
        }
      }
    }
    strips[m[1]] = ink;
  }
  return strips;
}

/** The same mask straight off the face, for comparison. */
function inkOf(text) {
  const strip = creditStripRgba(text);
  const ink = new Set();
  for (let y = 0; y < strip.h; y++) {
    for (let x = 0; x < strip.w; x++) {
      if (strip.rgba[(y * strip.w + x) * 4 + 3]) ink.add(`${x},${y}`);
    }
  }
  return ink;
}

Deno.test("an attribution is read in every shape a person would write it", () => {
  const presented = { credits: [{ role: "PRESENTED BY", names: ["dan"] }] };
  assertEquals(normalizeAttribution("dan"), presented);
  assertEquals(normalizeAttribution({ author: " dan " }), presented);
  assertEquals(normalizeAttribution({ credits: [{ name: "dan" }] }), presented);
  assertEquals(normalizeAttribution([{ role: 12, names: ["dan"] }]), presented);
  // Labels are matched as typed, not as cased.
  assertEquals(
    normalizeAttribution({
      credits: [{ role: "music", names: ["a", "b"] }, null, { role: "Thanks" }],
    }),
    {
      credits: [
        { role: "MUSIC", names: ["a", "b"] },
        { role: "", names: [] },
        { role: "THANKS", names: [] },
      ],
    },
  );
  // names[1] is the SECOND strip: a blank first name keeps its place.
  assertEquals(
    normalizeAttribution({ credits: [{ role: "DEBUG", names: ["", "b"] }] }),
    { credits: [{ role: "DEBUG", names: ["", "b"] }] },
  );
});

Deno.test("saying nothing and saying nobody are different answers", () => {
  for (const nothing of [undefined, null, "", "  ", {}, { author: "" }, true]) {
    assertStrictEquals(normalizeAttribution(nothing), null, String(nothing));
  }
  assertEquals(normalizeAttribution(false), { credits: [] });
  assertEquals(normalizeAttribution({ credits: [] }), { credits: [] });
  assertEquals(normalizeAttribution({ credits: [{ role: "" }] }), {
    credits: [],
  });
});

Deno.test("what a staff roll cannot hold is dropped out loud", () => {
  const heard = [];
  const got = normalizeAttribution({
    credits: [
      { role: "DIRECTOR", names: ["a", "b", "c"] },
      { names: ["d"] },
      { names: ["e"] },
      { names: ["f"] },
    ],
  }, (m) => heard.push(m));
  assertEquals(got.credits.map((c) => c.role), [
    "PRESENTED BY",
    "PRESENTED BY",
    "PRESENTED BY",
  ]);
  assertEquals(got.credits[0].names, ["a", "b"]);
  assertStrictEquals(heard.length, 3, heard.join("\n"));
  assert(heard.some((m) => m.includes("DIRECTOR")));
  assert(heard.some((m) => m.includes('"c"')));
  assert(heard.some((m) => m.includes("3 roles")));
});

Deno.test("the most explicit source wins, and a cart is never re-credited", () => {
  const web = level();
  const cart = level({ meta: { source: "dezaemon2" } });
  const opts = { author: "player" };
  assertStrictEquals(resolveAttribution(web, {}).source, "none");
  assertStrictEquals(resolveAttribution(web, opts).source, "default");
  assertEquals(resolveAttribution(web, opts).credits, [
    { role: "PRESENTED BY", names: ["player"] },
  ]);
  // Somebody else made a cart: the player's own name is not a default for it…
  assertStrictEquals(resolveAttribution(cart, opts).source, "cart");
  for (const key of ["dezaemonTitle", "dezaemonTitleScreen"]) {
    assertStrictEquals(
      resolveAttribution(level({ [key]: {} }), opts).source,
      "cart",
    );
  }
  // …but naming someone on it is an explicit act, and counts.
  const named = { ...cart, attribution: "modder" };
  assertStrictEquals(resolveAttribution(named, opts).source, "level");
  assertStrictEquals(
    resolveAttribution(named, { ...opts, attribution: "flag" }).source,
    "option",
  );
  // `false` ends the search instead of falling through to the default.
  const anon = resolveAttribution({ ...web, attribution: false }, opts);
  assertEquals(anon, { source: "level", credits: [] });
  assertEquals(staffRolesFor(anon.credits), [0, 0, 0]);
});

Deno.test("a name is drawn as large as its strip allows", () => {
  const short = creditStripRgba("daniel");
  assertEquals([short.w, short.h], [CREDIT_STRIP_W, CREDIT_STRIP_H]);
  assertEquals(short.lines, ["DANIEL"]);
  const long = creditStripRgba("easierbycode");
  assertEquals(long.lines, ["EASIERBYCODE"]);
  const count = (s) => {
    let n = 0;
    for (let i = 0; i < s.rgba.length; i += 4) if (s.rgba[i] === 255) n++;
    return n;
  };
  // Double size is four pixels a dot, double height two.
  assertStrictEquals(count(short) % 4, 0);
  assertStrictEquals(count(long) % 2, 0);
  assert(
    count(creditStripRgba("abcdefgh")) > count(creditStripRgba("abcdefghi")),
  );

  // Past a line it wraps on a space; a newline asks for the two lines outright.
  assertEquals(creditStripRgba("Easier By Code Games 2026").lines, [
    "EASIER BY CODE",
    "GAMES 2026",
  ]);
  assertEquals(creditStripRgba("2026\nshmupX").lines, ["2026", "SHMUPX"]);
  const cut = creditStripRgba("one two three four five six seven eight nine");
  assertStrictEquals(cut.lines.length, 2);
  assertStrictEquals(cut.truncated, true);

  // Sixteen characters and their shadow are exactly the strip: nothing clips.
  const full = creditStripRgba("WWWWWWWWWWWWWWWW");
  let right = 0;
  for (let y = 0; y < full.h; y++) {
    if (full.rgba[(y * full.w + full.w - 1) * 4 + 3]) right++;
  }
  assert(right > 0, "the shadow reaches the last column");
});

Deno.test("text the face cannot spell is folded, then dropped, never guessed", () => {
  assertEquals(foldCreditText("Zoë  O’Neil"), {
    text: "ZOE O'NEIL",
    dropped: "",
  });
  assertEquals(foldCreditText("dan★"), { text: "DAN", dropped: "★" });
  assertStrictEquals(creditStripRgba("日本語"), null);
  assertStrictEquals(creditStripRgba("   "), null);
});

Deno.test("the player's name is the account, else the home directory", () => {
  assertStrictEquals(
    authorFromEnvironment({ USER: "dan", HOME: "/home/other" }),
    "dan",
  );
  assertStrictEquals(authorFromEnvironment({ LOGNAME: "dan" }), "dan");
  assertStrictEquals(authorFromEnvironment({ USERNAME: "Deck" }), "Deck");
  assertStrictEquals(
    authorFromEnvironment({ HOME: "/var/home/easierbycode/" }),
    "easierbycode",
  );
  assertStrictEquals(
    authorFromEnvironment({ USER: " ", USERPROFILE: "C:\\Users\\deck" }),
    "deck",
  );
  assertStrictEquals(authorFromEnvironment({ HOME: "/" }), null);
  assertStrictEquals(authorFromEnvironment({}), null);
  assertStrictEquals(authorFromEnvironment(), null);
});

Deno.test("a web game goes out presented by the player", async () => {
  const { out, decoded, strips } = await roundTrip(level(), {
    author: "easierbycode",
  });
  assertEquals(out.report.attribution, {
    source: "default",
    credits: [{ role: "PRESENTED BY", names: ["easierbycode"] }],
  });
  assertStrictEquals(out.report.title.credits, 1);
  assertEquals(out.warnings.filter((w) => /credit/i.test(w)), []);

  // The label, and under it one strip: the name, pixel for pixel.
  assertEquals(decoded.settings.staffRoles, ["PRESENTED BY", "", ""]);
  assertEquals(Object.keys(strips), ["0"]);
  assertEquals(strips[0], inkOf("easierbycode"));

  // With nobody to name the cart is what it always was.
  const bare = await roundTrip(level());
  assertStrictEquals(bare.out.report.attribution.source, "none");
  assertEquals(bare.strips, {});
  assertEquals(bare.decoded.settings.staffRoleIndices, [12, 0, 0]);
});

Deno.test("a level's own roll lands role by role, strip by strip", async () => {
  const attribution = {
    credits: [
      { role: "PLANNING", names: ["daniel", "easier by code"] },
      { role: "MUSIC", names: ["", "somebody else"] },
      { role: "THANKS" },
    ],
  };
  const { out, decoded, strips } = await roundTrip(
    level({ attribution }),
    { author: "ignored" },
  );
  assertStrictEquals(out.report.attribution.source, "level");
  assertEquals(decoded.settings.staffRoles, ["PLANNING", "MUSIC", "THANKS"]);
  // Strips 2i and 2i+1 sit under label i; MUSIC's first is deliberately blank.
  assertEquals(Object.keys(strips).sort(), ["0", "1", "3"]);
  assertEquals(strips[0], inkOf("daniel"));
  assertEquals(strips[1], inkOf("easier by code"));
  assertEquals(strips[3], inkOf("somebody else"));

  // The caller's flag outranks the level; `false` on the level credits nobody.
  const flagged = await roundTrip(level({ attribution }), {
    attribution: "the flag",
  });
  assertStrictEquals(flagged.out.report.attribution.source, "option");
  assertEquals(Object.keys(flagged.strips), ["0"]);
  assertEquals(flagged.strips[0], inkOf("the flag"));

  const anon = await roundTrip(level({ attribution: false }), {
    author: "ignored",
  });
  assertEquals(anon.strips, {});
  assertEquals(anon.decoded.settings.staffRoleIndices, [0, 0, 0]);
});

Deno.test("a name the face cannot draw costs its strip and says so", async () => {
  const { out, strips } = await roundTrip(level({ attribution: "日本語" }));
  assertEquals(strips, {});
  assert(
    out.warnings.some((w) => w.includes("日本語")),
    out.warnings.join("\n"),
  );
  const partly = await roundTrip(level({ attribution: "dan★" }));
  assertEquals(partly.strips[0], inkOf("dan"));
  assert(partly.out.warnings.some((w) => w.includes("★")));
});

Deno.test("credits survive the round trip as the cart's own, and are not re-credited", async () => {
  const first = await roundTrip(level(), { author: "easierbycode" });
  // Re-import: the name is now drawn art on a cart, like any community game's.
  const { gameJson, sprites } = mapSaveToGame(first.decoded);
  assertStrictEquals(gameJson.dezaemonTitle.credit0, "dezaCredit0.gif");
  assertEquals(gameJson.dezaemonTitleScreen.staffLabels, [
    "PRESENTED BY",
    "",
    "",
  ]);
  const pictures = {};
  for (const s of sprites) pictures[s.key] = { w: s.w, h: s.h, rgba: s.rgba };

  // Written back out by somebody else, it still says who made it.
  const second = await roundTrip(
    gameJson,
    { author: "someone else" },
    pictures,
  );
  assertStrictEquals(second.out.report.attribution.source, "cart");
  assertEquals(second.decoded.settings.staffRoles, ["PRESENTED BY", "", ""]);
  assertEquals(second.strips[0], inkOf("easierbycode"));

  // Unless they sign it: typed names replace the roll whole.
  const signed = await roundTrip(
    {
      ...gameJson,
      attribution: { credits: [null, { role: "DEBUG", names: ["modder"] }] },
    },
    {},
    pictures,
  );
  assertStrictEquals(signed.out.report.attribution.source, "level");
  assertEquals(signed.decoded.settings.staffRoles, ["", "DEBUG", ""]);
  assertEquals(Object.keys(signed.strips), ["2"]);
  assertEquals(signed.strips[2], inkOf("modder"));
});
