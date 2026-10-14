// What a boss leaves a game with, when EXTRACT MODE or the editor publishes
// it to the shared character library (static/phaser-plugins/extract-mode.js
// `bossPublishRecord`).
//
// A web boss's routine is its SLOT's: bossShootStart picks the stock pattern
// from the slot number a record lands in, never from the record. So a boss
// has to leave with that slot pinned as `attackPattern`, or she runs whatever
// routine her new slot gives her — 2028.Ai's second boss, published out of
// boss1 and placed anywhere else, lost Barlog's dive. A Dezaemon-native boss
// is never pinned (initDezaBoss reads attackPattern as the opt-out of its
// own state machine), and a pattern already on the record — a mod's web
// overlay laid over a cart-decoded boss — wins over the slot it sits in.

import { assert, assertEquals } from "@std/assert";

type Rec = Record<string, unknown>;
interface Extract {
  bossPublishRecord(
    recipe: Rec,
    record: Rec,
    stageId: number,
    key: string,
  ): Rec;
  bossTravelRecord(recipe: Rec, record: Rec, stageId: number): Rec;
  collectFrameNames(record: Rec): string[];
  previewFrameName(record: Rec): string | null;
  pruneFrameNames(record: Rec, missing: string[]): Rec;
}

/** Load the browser script under a window just real enough for its load-time arming. */
async function loadExtract(): Promise<Extract> {
  const src = await Deno.readTextFile(
    new URL("../static/phaser-plugins/extract-mode.js", import.meta.url),
  );
  const noop = () => {};
  const document = {
    getElementById: () => null,
    body: { appendChild: noop },
    readyState: "complete",
    addEventListener: noop,
    createElement: () => ({
      style: {},
      appendChild: noop,
      addEventListener: noop,
    }),
  };
  const win: Rec = {
    addEventListener: noop,
    removeEventListener: noop,
    postMessage: noop,
    document,
    location: {
      pathname: "/games/2028-ai/",
      search: "",
      origin: "http://localhost",
    },
    navigator: { onLine: true },
  };
  win.parent = win;
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  new Function(
    "window",
    "document",
    "MutationObserver",
    "navigator",
    "localStorage",
    src,
  )(win, document, MutationObserver, win.navigator, {});
  const ex = win.ShmupExtract as Extract | undefined;
  assert(
    ex && typeof ex.bossPublishRecord === "function",
    "ShmupExtract loaded",
  );
  return ex;
}

const EX = await loadExtract();

const webBoss = (): Rec => ({
  name: "flirty_girl",
  hp: 250,
  anim: { idle: ["flirty_girl0.png"], attack: ["flirty_girl3.png"] },
  projectileDataA: { texture: ["flirty_girl_projectileA0.png"], speed: 2 },
});

Deno.test("a web boss leaves with the slot she was authored for pinned", () => {
  const live = webBoss();
  const out = EX.bossPublishRecord({}, live, 1, "boss1");
  assertEquals(out.attackPattern, "boss1");
  assertEquals(out.name, "flirty_girl");
  assertEquals(
    out.projectileDataA,
    live.projectileDataA,
    "her own weapons stay",
  );
  // Copied, not assigned: the live recipe record is not written to.
  assertEquals(live.attackPattern, undefined);
});

Deno.test("a pattern already on the record wins over the slot it sits in", () => {
  const out = EX.bossPublishRecord(
    {},
    { ...webBoss(), attackPattern: "boss3" },
    1,
    "boss1",
  );
  assertEquals(out.attackPattern, "boss3");
});

Deno.test("a Dezaemon-native boss is never pinned — a pattern would switch her off", () => {
  const deza: Rec = {
    name: "dezaBoss3",
    hp: 225,
    anim: { idle: ["dezaBoss3_0.gif"] },
    dezaemon: { boss: { patterns: [], playlist: [[0, 0, 0, 0]] } },
  };
  const out = EX.bossPublishRecord({}, deza, 1, "boss1");
  assertEquals(out.attackPattern, undefined);
  // A cart-decoded web boss the overlay already pinned keeps that pin.
  const pinned = EX.bossPublishRecord(
    {},
    { ...deza, attackPattern: "boss1" },
    1,
    "boss1",
  );
  assertEquals(pinned.attackPattern, "boss1");
});

Deno.test("only a numbered slot pins; bossExtra's routine is name-driven", () => {
  const out = EX.bossPublishRecord({}, webBoss(), 5, "bossExtra");
  assertEquals(out.attackPattern, undefined);
});

Deno.test("the travel record underneath is unchanged for a web boss", () => {
  const live = webBoss();
  assertEquals(EX.bossTravelRecord({}, live, 1), live);
});

// flirty_revenge as the editor exports her: re-skinned from Barlog, whose
// art the editor set aside under '_' keys rather than deleting.
const reskinned = (): Rec => ({
  _name: "barlog",
  name: "flirty_revenge",
  anim: {
    _attack: ["barlog_attack0.gif", "barlog_attack1.gif"],
    _idle: ["barlog_idle0.gif"],
    attack: ["flirtyRevenge3.png", "flirtyRevenge4.png"],
    idle: ["flirtyRevenge0.png", "flirtyRevenge1.png"],
  },
  projectileData: {
    _texture: ["flirty_revenge_projectile0.png"],
    texture: ["flirtyRevengeProjectile0.png", "flirtyRevengeProjectile1.png"],
  },
});

Deno.test("a key the editor set aside with '_' is not part of the character", () => {
  assertEquals(EX.collectFrameNames(reskinned()), [
    "flirtyRevenge3.png",
    "flirtyRevenge4.png",
    "flirtyRevenge0.png",
    "flirtyRevenge1.png",
    "flirtyRevengeProjectile0.png",
    "flirtyRevengeProjectile1.png",
  ]);
});

Deno.test("the card leads with the idle pose, as the library does", () => {
  assertEquals(EX.previewFrameName(reskinned()), "flirtyRevenge0.png");
  // No idle list: the texture list, then the first name the walk finds.
  assertEquals(
    EX.previewFrameName({ texture: ["ship0.png", "ship1.png"] }),
    "ship0.png",
  );
  assertEquals(
    EX.previewFrameName({ anim: { attack: ["a0.png"] } }),
    "a0.png",
  );
  assertEquals(EX.previewFrameName({ name: "bare" }), null);
});

Deno.test("pruning a missing frame leaves the set-aside lists alone", () => {
  const rec = reskinned();
  EX.pruneFrameNames(rec, ["flirtyRevenge4.png", "barlog_attack0.gif"]);
  assertEquals((rec.anim as Rec).attack, ["flirtyRevenge3.png"]);
  assertEquals((rec.anim as Rec)._attack, [
    "barlog_attack0.gif",
    "barlog_attack1.gif",
  ]);
});
