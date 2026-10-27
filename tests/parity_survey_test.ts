// The parity testdrive's survey (scripts/lib/parity-survey.ts): the page
// code's addresses and the summary a pane's report carries. The samplers
// themselves run inside EmulatorJS and Phaser pages and are exercised by
// `deno task testdrive:parity -- --sav <cart> --full`; what can be pinned
// here is the pure half.

import { assert, assertEquals } from "@std/assert";
import {
  PS2_SURVEY_DUMP,
  ps2Survey,
  SATURN_SURVEY_ADDR,
  saturnSurvey,
  SURVEY_DUMP,
  surveySummary,
  webSurvey,
} from "../scripts/lib/parity-survey.ts";

Deno.test("the Saturn survey reads the play engine's per-slot arrays FORMAT.md names", () => {
  // Sprite index, lateral and scroll positions, hp, attack word, hit
  // attributes, formation key (FORMAT.md "Shot sprites", "Axes and angles",
  // "Formation keys"); the map scroll and the dynamic rank.
  assertEquals(SATURN_SURVEY_ADDR.spr, 0x0608EA90);
  assertEquals(SATURN_SURVEY_ADDR.x, 0x06090040);
  assertEquals(SATURN_SURVEY_ADDR.y, 0x0608D400);
  assertEquals(SATURN_SURVEY_ADDR.hp, 0x06095040);
  assertEquals(SATURN_SURVEY_ADDR.atk, 0x0608C720);
  assertEquals(SATURN_SURVEY_ADDR.attr, 0x06091550);
  assertEquals(SATURN_SURVEY_ADDR.key, 0x06090530);
  assertEquals(SATURN_SURVEY_ADDR.scroll, 0x0608D3FA);
  assertEquals(SATURN_SURVEY_ADDR.rank, 0x06090A2E);
  assertEquals(SATURN_SURVEY_ADDR.lives, 0x06084354);
  const page = saturnSurvey({ ramBase: 12345, periodMs: 100, slots: 256 });
  // The page reads HWRAM word-swapped off the heap base it is given, and
  // scans every slot the arrays hold.
  assert(page.includes("^ 1)"));
  assert(page.includes('"ramBase":12345'));
  assert(page.includes('"slots":256'));
  assert(page.includes("window.__survey"));
});

Deno.test("the web and PS2 surveys fly the ship inside the box they are given and log births", () => {
  const web = webSurvey({ periodMs: 100, box: { x0: 40, x1: 216, y0: 300, y1: 440 }, seed: 7 });
  assert(web.includes('"x0":40'));
  assert(web.includes("dbg.setButtons"));
  assert(web.includes("S.births.push"));
  assert(web.includes("enemyBullets"));
  const ps2 = ps2Survey({ periodMs: 100, box: { x0: 40, x1: 200, y0: 300, y1: 440 } });
  assert(ps2.includes("__PS2_GS__"));
  assert(ps2.includes("__PS2_PADS__"));
  // Only strings and numbers leave the page: a port object's frame or
  // texture can be a record that reaches back into the scene.
  assert(ps2.includes("function str("));
  // ...and a sample keeps at most 600 of them, saying how many there were.
  assert(ps2.includes("objsTotal"));
  assert(SURVEY_DUMP.includes("S.stop()"));
  assert(PS2_SURVEY_DUMP.includes("shapes"));
});

Deno.test("a survey's summary counts what was seen and keeps the kinds in order", () => {
  assertEquals(surveySummary(null), null);
  const s = surveySummary({
    n: 3,
    t0: 1000,
    err: null,
    kinds: { "spr55": 2, "spr119": 9, "spr71": 4 },
    maxObjs: 17,
    ended: null,
    births: [{}, {}, {}, {}],
    samples: [{ t: 0 }, { t: 100 }, { t: 2500 }],
  });
  assertEquals(s?.samples, 3);
  assertEquals(s?.seconds, 2.5);
  assertEquals(s?.births, 4);
  assertEquals(s?.maxLiveObjects, 17);
  assertEquals(Object.keys(s?.kinds as Record<string, number>), ["spr119", "spr71", "spr55"]);
  assertEquals(s?.kindCount, 3);
});
