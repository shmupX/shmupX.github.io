// An enemy that never fires leaves EXTRACT MODE without a projectile
// (static/phaser-plugins/extract-mode.js `dropDeadProjectile`).
//
// The Dezaemon mapper starts every zako from the starter enemy, so each one
// carries the stock purple fireball in `bulletData` whether it can fire or
// not. ryu_level_moon, a backdrop moon that never fires (its byte 5 picks
// geometry 0, the engine's empty routine), was published with that fireball
// packed into its atlas and named in its record. The test is the runtime's:
// a behaviour-driven zako fires when enabled with a big shot or a geometry
// other than 0, and a web enemy's reload loop skips a negative interval.

import { assert, assertEquals } from "@std/assert";

type Rec = Record<string, unknown>;
interface Extract {
  collectFrameNames(record: Rec): string[];
  dropDeadProjectile(record: Rec): Rec;
  publishRecord(opts: Rec): Promise<string | null>;
}

const DB = "https://evil-invaders-default-rtdb.firebaseio.com";
const FIREBALL = [
  "normalProjectile0.gif",
  "normalProjectile1.gif",
  "normalProjectile2.gif",
];
const MOON_ART = [
  "deza0_40_0.gif",
  "deza0_40_1.gif",
  "deza0_40_2.gif",
  "deza0_40_3.gif",
];

/** Load the browser script under a window just real enough for its load-time arming. */
async function loadExtract(fetch: unknown = () => Promise.reject()) {
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
    __FIREBASE_CONFIG__: { databaseURL: DB },
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
    "fetch",
    src,
  )(win, document, MutationObserver, win.navigator, {}, fetch);
  const ex = win.ShmupExtract as Extract | undefined;
  assert(
    ex && typeof ex.dropDeadProjectile === "function",
    "ShmupExtract loaded",
  );
  return ex;
}

const EX = await loadExtract();

/** A zako as the mapper writes it, with `fire` laid over the moon's. */
function zako(fire: Rec = {}, extra: Rec = {}): Rec {
  return {
    name: "deza0_40",
    interval: 119,
    texture: MOON_ART.slice(),
    bulletData: { damage: 1, hp: 1, speed: 2.13, texture: FIREBALL.slice() },
    dezaemon: {
      stage: 0,
      record: 40,
      behavior: {
        appearance: 32,
        fire: { enabled: true, mode: 0, direction: 0, interval: 119, ...fire },
      },
    },
    ...extra,
  };
}

Deno.test("ryu_level_moon never fires, so its fireball is neither packed nor published", async () => {
  const moon = zako();
  assertEquals(EX.collectFrameNames(moon), MOON_ART);

  const calls: { method: string; body?: Rec }[] = [];
  const fetch = (_url: string, init?: { method?: string; body?: string }) => {
    calls.push({
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(null) });
  };
  const ex = await loadExtract(fetch);
  const saved = await ex.publishRecord({
    name: "ryu_level_moon",
    record: moon,
    db: DB,
    atlasJson: { frames: Object.fromEntries(MOON_ART.map((f) => [f, {}])) },
    canvas: { toDataURL: () => "data:image/png;base64,AA==" },
    confirmOverwrite: () => true,
  });
  assertEquals(saved, "ryu_level_moon");
  const published = calls[1].body!["characters/ryu_level_moon"] as Rec;
  assertEquals("bulletData" in published, false);
  assertEquals(published.texture, MOON_ART);
  assertEquals(published.textureKey, "ryu_level_moon");
  // The caller's record is the game's own: publishing must not disarm it.
  assert("bulletData" in moon, "the live record keeps its projectile");
});

Deno.test("a zako that fires keeps its projectile", () => {
  for (const fire of [{ direction: 1 }, { geometry: 3 }, { direction: 0x11 }]) {
    assertEquals(
      EX.collectFrameNames(zako(fire)),
      [...MOON_ART, ...FIREBALL],
      JSON.stringify(fire),
    );
  }
  // An older record with only `pattern`: 10 + pattern is a burst, which fires.
  assertEquals(
    EX.collectFrameNames(zako({ pattern: 0 })),
    [...MOON_ART, ...FIREBALL],
  );
  // Bullet type 3 skips the geometry-0 early-out: it always fires.
  assertEquals(
    EX.collectFrameNames(zako({ mode: 3, bigShot: { band: 0, index: 0 } })),
    [...MOON_ART, ...FIREBALL],
  );
});

Deno.test("either gate silences a zako: the appearance's no-fire bit, or geometry 0", () => {
  // Gate one: an appearance that never fires, whatever byte 5 says.
  assertEquals(
    EX.collectFrameNames(zako({ enabled: false, direction: 1 })),
    MOON_ART,
  );
  // Gate two: an explicit geometry 0 wins over a stale direction.
  assertEquals(
    EX.collectFrameNames(zako({ geometry: 0, direction: 1 })),
    MOON_ART,
  );
});

Deno.test("a web enemy is silent only at a negative interval (0 reads as 300)", () => {
  const web = (interval?: number): Rec => ({
    name: "soliderA",
    texture: ["soliderA0.gif"],
    ...(interval === undefined ? {} : { interval }),
    projectileData: { texture: FIREBALL.slice() },
  });
  assertEquals(EX.collectFrameNames(web(-1)), ["soliderA0.gif"]);
  assertEquals(EX.collectFrameNames(web(0)), ["soliderA0.gif", ...FIREBALL]);
  assertEquals(EX.collectFrameNames(web(300)), ["soliderA0.gif", ...FIREBALL]);
  assertEquals(EX.collectFrameNames(web()), ["soliderA0.gif", ...FIREBALL]);
});

Deno.test("bosses and players are left as they are", () => {
  // A Dezaemon boss is armed by its fire points (bossTravelRecord), not by
  // this rule, even with an interval the web loop would skip.
  const boss: Rec = {
    name: "dezaBoss0",
    interval: -1,
    anim: { idle: ["boss0.gif"] },
    bulletDataA: { texture: ["bossShot0.gif"] },
    bulletData: { texture: FIREBALL.slice() },
    dezaemon: { boss: { patterns: [] } },
  };
  assertEquals(EX.dropDeadProjectile(boss), boss);
  const player: Rec = {
    name: "G",
    texture: ["player00.gif"],
    shootNormal: { texture: ["shot00.gif"] },
  };
  assertEquals(EX.dropDeadProjectile(player), player);
});

Deno.test("nothing to drop hands back the same record, and the input is never changed", () => {
  const firing = zako({ direction: 1 });
  assert(EX.dropDeadProjectile(firing) === firing);
  const moon = zako();
  const dropped = EX.dropDeadProjectile(moon);
  assert(dropped !== moon);
  assertEquals("bulletData" in dropped, false);
  assertEquals((moon.bulletData as Rec).texture, FIREBALL);
});
