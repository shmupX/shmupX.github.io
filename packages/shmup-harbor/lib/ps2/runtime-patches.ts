// lib/ps2/runtime-patches.ts — the edits the exporter makes to the port it
// ships.
//
// main.js is @easierbycode/svelte-ps2's ps2-sp bundled for QuickJS, and a few
// things a disc needs live where runtime-entry.ts cannot reach them: inside a
// function private to one of the port's modules. Each patch here is one
// anchored edit to the bundled text, applied every time the bundle is handed
// out (buildRuntimeBundle), so the cached bundle stays the bundler's own
// output. An anchor that is not there exactly once fails the build rather
// than shipping a disc without the change: the pin moving under a patch is
// the thing to hear about. Each one belongs upstream in svelte-ps2; this is
// where it lives until it lands there.

export interface RuntimePatch {
  name: string;
  find: RegExp;
  replace: string;
  /**
   * The top-level names the patch declares. The bundle is one module scope,
   * so a port that grew a function of the same name would make main.js a
   * SyntaxError on the console; patchRuntime refuses it instead.
   */
  defines?: readonly string[];
}

// A boss's weapons, the browser's (game.bundle.js: bossWeaponSlots). A record
// arms up to four slots, each under either spelling — bulletData or
// projectileData, then A, B and C — and the one weapon a routine fires is the
// record's own, else slot A's. The port reads only `projectileData`
// (normalizeRecipe's copy of a bulletData) and `projectileDataA`, so a boss
// that names only A and B slots — gs's Daltonius, the stock Sagat, Vega and
// Fang, every boss foo.json ships — fired normalizeRecipe's empty stand-in:
// the port's red 6x6 squares, never its own art.
//
// - Every boss is armed the browser's way as createBoss makes it, each slot in
//   the shape normalizeRecipe gives a boss's bulletData. A slot whose texture
//   names no frame is no weapon, so the stand-in no longer shadows slot A; a
//   boss with no weapon at all still fires it, as it always did.
// - No port routine fires slot B. The browser's do, as a heavy throw between
//   volleys of the rest — Daltonius flies Akuma's: six of slot A straight at
//   the ship, or one of slot B, about as often. So here every third move of a
//   boss with a slot B is one straight shot of it, and the next waits 40 steps
//   (the port's slowest straight-shot cooldown). The routine's own pattern is
//   not advanced by a throw. Every third, not at random, so a run replays the
//   same, as the port's routines do. Slot C is armed and fired by nothing,
//   since the browser fires it only from routines the port does not have.
//
// A boss's second stage, the browser's (game.bundle.js: bossStage2Record,
// bossStage2Due, bossStage2Start; README-Technical.md, "A boss can have a
// second stage"). A `stage2` block on a boss record is laid over the record
// once the boss's hp falls below `hpBelow` of its bar (half unless the block
// says otherwise), between two moves — the move in flight finishes first. Its
// stances and weapon slots replace the boss's own key by key, and `anim.morph`
// plays once on the way in. The cloud game gs turns its second boss,
// Daltonius, into Liu Kang's dragon this way (liuKangDragon0-9, then 9 to
// stand in), spitting deza1_52 dragon heads.
//
// The port's boss is a much smaller thing than the browser's, so the parts
// land differently:
//
// - bossStage2Record is the browser's, character for character
//   (tests/ps2_boss_stage2_test.ts holds them together). The pool is the same
//   one: stage 2 is the bottom of the bar, not a refill.
// - "Between two moves" is bossLoop's attack site: when the cooldown runs
//   out, a boss that is due changes instead of making its move (bossMove).
// - The port draws a boss with one frame list, `texture` — normalizeRecipe's
//   copy of anim.idle — and never its other stances, so stage 2 stands in the
//   block's `texture`, else its `anim.idle`, else the boss's own. The shoot
//   and syngoku stances the browser's routines switch to stay unused, as the
//   boss's own do (lib/ps2/assets.ts packs only what is drawn).
// - Stage 2 arms its slots from the record it flies, as stage 1 did from the
//   boss's (above).
// - The routine is picked by `stageId`, never by attackPattern, so only a
//   block's OWN attackPattern changes it, and only to one the port has
//   (`bossN`); a boss's attackPattern does nothing here in either stage.
// - Timings are the browser's milliseconds, counted in logic steps at the
//   build's game speed (bossSteps: `__PS2_GAME_FPS__`, 120 a second by
//   default, lib/ps2/build.ts; else the port's own 30), and twice as fast in
//   turbo, like its cooldowns: a morph frame is 90 ms (3 steps at 30, 11 at
//   120), stage 1's last pose fades out over 360 ms above the first frames of
//   the morph, and the routine picks up 500 ms after the morph. The boss
//   holds still and holds fire while it changes, and stays hittable
//   throughout.
// - The first morph frame keeps the top edge of the body it replaces — a
//   taller body hangs lower rather than climbing off the screen — and every
//   frame after keeps its centre; the hit box is each frame's size, as
//   createBoss makes it.
// - The browser's camera flash and shake have no equivalent on the console;
//   the morph plays se_sp, as the browser does.
//
// A boss's overlay, the browser's (game.bundle.js: armBossOverlay,
// chargeOverlayShot, fireOverlayShot; README-Technical.md, "A boss can wear
// parts that come off as shots"). `overlay.parts` are drawn over the boss,
// each by its top-left in the boss's frame and filled with `cover`; with a
// `shot`, every `shot.every` ms one part's copy fades in over its slot in
// `shot.chargeMs`, flashing through `shot.colors`, and at full opacity leaves
// as an aimed shot that keeps flashing; and while a part charges, `glow` lays
// the cut of the boss's current frame under the parts in the part's colour.
// gs's Geekstar wears his logo's G, E, E, K this way, black over the white
// ones, and his mask's red eyes and mouth burn in the thrown letter's colour.
//
// - A fill and a flash are both one AthenaEnv draw colour, which multiplies
//   the texture as the browser's tint does: black fills a part solid (its dark
//   outline too, as Phaser's FILL does), a neon colour turns the white letter
//   neon. The colour's alpha carries the fade.
// - The record's timings are the browser's milliseconds, counted in logic
//   steps at the build's own game speed — `__PS2_GAME_FPS__`, 120 a second by
//   default (lib/ps2/build.ts), the browser's own logic rate, else the port's
//   30 — so the letters come as often on a disc as on the web: every 2600 ms
//   is 312 steps there, a 900 ms charge 108, a 60 ms flash 7. Turbo runs them
//   twice as fast, as it runs everything. The clock runs only once the boss
//   has arrived and stops with it in a time stop, as the browser's does.
// - The browser picks the part at random. The port picks every part from one
//   fixed sequence instead (an LCG seeded per boss), so a run replays the
//   same, as its routines do.
// - The shot flies at `shot.speed` per step, as every other boss shot here
//   flies at its record's speed, aimed at the first ship still flying (the
//   scene the port publishes for the web host, `__PS2_GS__`, has them); with
//   none it falls straight down. Its hit box is the letter, as in the browser.
//   The scene's projectiles keep only the fields createProjectile knows, so
//   the flash rides on three of their own (tints, flashSteps, tintSteps),
//   carried over by a wrapper, and is drawn by another.
// - The glow lights only the frames the port draws a boss in (its idle
//   stance); lib/ps2/assets.ts packs just those cuts.
//
// No `$` in here: it is spliced into a String.replace replacement.
export const BOSS_RUNTIME = String
  .raw`// shmupX lib/ps2/runtime-patches.ts: a boss's weapons and second stage.
var BOSS_STAGE2_HP_BELOW = 0.5;
var BOSS_WEAPON_SUFFIXES = ["", "A", "B", "C"];
var BOSS_HEAVY_EVERY = 3;
var BOSS_HEAVY_STEPS = 40;
var BOSS_STAGE2_MORPH_MS = 90;
var BOSS_STAGE2_FADE_MS = 360;
var BOSS_STAGE2_REST_MS = 500;
function bossSteps(ms) {
  var perSecond = Number(globalThis.__PS2_GAME_FPS__) || 30;
  return Math.max(1, Math.round(ms * perSecond / 1000));
}
function bossStage2Record(bossData) {
  var stage2 = bossData && bossData.stage2;
  if (!stage2 || typeof stage2 !== "object") return null;
  var merged = Object.assign({}, bossData, stage2);
  delete merged.stage2;
  merged.anim = Object.assign({}, bossData.anim || {}, stage2.anim || {});
  // A weapon slot is one weapon under either spelling: a stage 2
  // bulletDataA replaces the boss's projectileDataA, which would otherwise
  // still win where the boss's own spelling is read first.
  for (var i = 0; i < BOSS_WEAPON_SUFFIXES.length; i++) {
    var bullet = "bulletData" + BOSS_WEAPON_SUFFIXES[i];
    var projectile = "projectileData" + BOSS_WEAPON_SUFFIXES[i];
    if (stage2[bullet] && !stage2[projectile]) delete merged[projectile];
    if (stage2[projectile] && !stage2[bullet]) delete merged[bullet];
  }
  var below = Number(stage2.hpBelow);
  merged.hpBelow = below > 0 && below < 1 ? below : BOSS_STAGE2_HP_BELOW;
  return merged;
}
function bossStage2Due(b) {
  var stage2 = b.stage2;
  if (!stage2 || b.stage2Done || !(b.maxHp > 0)) return false;
  return b.hp / b.maxHp < stage2.hpBelow;
}
function bossStage2List(list) {
  return Array.isArray(list) && list.length > 0 ? list : null;
}
function bossArm(b, data) {
  var block = data && data.stage2;
  bossWeaponSlots(b, data);
  b.heavyPhase = 0;
  b.stage2 = bossStage2Record(data);
  b.stage2Done = 0;
  b.stage2Idle = null;
  b.stage2Routine = null;
  b.stage2Morph = null;
  b.stage2Ghost = null;
  if (b.stage2) {
    b.stage2Idle = bossStage2List(block.texture) ||
      bossStage2List(block.anim && block.anim.idle) || b.frames;
    var routine = /boss(\d+)/.exec(String(block.attackPattern || ""));
    if (routine) b.stage2Routine = Number(routine[1]);
  }
  return b;
}
function bossWeapon(record, suffix) {
  var bullet = record["bulletData" + suffix];
  if (bullet && bossStage2List(bullet.texture)) {
    return {
      texture: bullet.texture,
      speed: bullet.speed || 2,
      damage: bullet.damage || 1,
      hp: bullet.hp || 1,
      name: "bullet"
    };
  }
  var projectile = record["projectileData" + suffix];
  return projectile && bossStage2List(projectile.texture) ? projectile : null;
}
function bossWeaponSlots(b, record) {
  b.projectileDataA = bossWeapon(record, "A");
  b.projectileDataB = bossWeapon(record, "B");
  b.projectileDataC = bossWeapon(record, "C");
  b.projectileData = bossWeapon(record, "") || b.projectileDataA ||
    record.projectileData || null;
}
function bossMove(ctx, b) {
  if (bossStage2Due(b)) {
    bossStage2Start(ctx, b);
    return;
  }
  if (b.projectileDataB && ++b.heavyPhase % BOSS_HEAVY_EVERY === 0) {
    bossShootStraight(b, b.projectileDataB);
    b.attackCooldown = BOSS_HEAVY_STEPS;
    ctx.sound.playSfx("se_shoot");
    return;
  }
  bossAttack(ctx, b);
}
function bossStage2Frames(ctx, atlas, list) {
  var out = [];
  if (!Array.isArray(list)) return out;
  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] !== "string") continue;
    if (ctx.atlas.hasFrame(atlas, ctx.atlas.resolveFrameName(atlas, list[i]))) {
      out.push(list[i]);
    }
  }
  return out;
}
function bossStage2Pose(ctx, b, frames, keepTop) {
  b.frames = frames;
  b.animFrame = 0;
  b.animCounter = 0;
  var size = ctx.atlas.getFrameSize(
    b.atlas,
    ctx.atlas.resolveFrameName(b.atlas, frames[0])
  );
  if (!(size.w > 0)) return;
  var x = b.x + b.width / 2 - size.w / 2;
  b.moveTargetX += x - b.x;
  b.x = x;
  if (!keepTop) b.y += b.height / 2 - size.h / 2;
  b.width = b.hitW = size.w;
  b.height = b.hitH = size.h;
}
function bossStage2Rest(b) {
  b.stage2Morph = null;
  b.shootFlg = 1;
  b.attackCooldown = bossSteps(BOSS_STAGE2_REST_MS);
}
function bossStage2Start(ctx, b) {
  var stage2 = b.stage2;
  b.stage2Done = 1;
  bossWeaponSlots(b, stage2);
  if (b.stage2Routine !== null) b.stageId = b.stage2Routine;
  if (b.frames.length > 0) {
    b.stage2Ghost = {
      atlas: b.atlas,
      frame: b.frames[b.animFrame],
      x: b.x + b.width / 2,
      y: b.y + b.height / 2,
      steps: 0
    };
  }
  b.atlas = stage2.atlas || b.atlas;
  var idle = bossStage2Frames(ctx, b.atlas, b.stage2Idle);
  var morph = bossStage2Frames(ctx, b.atlas, stage2.anim.morph);
  var frames = morph.length ? morph : idle;
  ctx.sound.playSfx("se_sp");
  b.shootFlg = 0;
  b.stage2Morph = { frames: frames, idle: idle, at: 0, steps: 0 };
  if (frames.length) bossStage2Pose(ctx, b, [frames[0]], true);
  else bossStage2Rest(b);
}
function bossStage2Step(ctx, b) {
  var mul = ctx.state.turboMode ? 2 : 1;
  var ghost = b.stage2Ghost;
  if (ghost) {
    ghost.steps += mul;
    if (ghost.steps >= bossSteps(BOSS_STAGE2_FADE_MS)) b.stage2Ghost = null;
  }
  var morph = b.stage2Morph;
  if (!morph) return false;
  if (b.deadFlg) {
    b.stage2Morph = null;
    return false;
  }
  if (b.tintFlash > 0 && ++b.tintTimer > 6) {
    b.tintFlash = 0;
    b.tintTimer = 0;
  }
  morph.steps += mul;
  if (morph.steps < bossSteps(BOSS_STAGE2_MORPH_MS)) return true;
  morph.steps -= bossSteps(BOSS_STAGE2_MORPH_MS);
  morph.at++;
  if (morph.at < morph.frames.length) {
    bossStage2Pose(ctx, b, [morph.frames[morph.at]], false);
  } else {
    if (morph.idle.length) bossStage2Pose(ctx, b, morph.idle, false);
    bossStage2Rest(b);
  }
  return true;
}
function bossStage2Ghost(ctx, b) {
  var ghost = b.stage2Ghost;
  if (!ghost || b.deadFlg || !b.visible) return;
  var alpha = (1 - ghost.steps / bossSteps(BOSS_STAGE2_FADE_MS)) * b.alpha;
  if (alpha <= 0) return;
  ctx.atlas.drawFrame(
    ghost.atlas,
    ctx.atlas.resolveFrameName(ghost.atlas, ghost.frame),
    ctx.vp.toX(ghost.x),
    ctx.vp.toY(ghost.y),
    ctx.vp.scale,
    ctx.vp.scale,
    alpha,
    null
  );
}
var OVERLAY_NEON = [
  [255, 43, 214],
  [0, 240, 255],
  [57, 255, 20],
  [255, 242, 0],
  [255, 106, 0]
];
function overlayRgb(value, fallback) {
  var n = typeof value === "number" && isFinite(value) ? value :
    typeof value === "string" ? parseInt(value.replace(/^#|^0x/i, ""), 16) : NaN;
  return isNaN(n) ? fallback : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function overlaySteps(ms, fallback, least) {
  var n = Number(ms);
  return Math.max(least, bossSteps(n > 0 ? n : fallback));
}
function overlayArt(ctx, atlas, name) {
  if (typeof name !== "string") return null;
  var frame = ctx.atlas.resolveFrameName(atlas, name);
  if (!ctx.atlas.hasFrame(atlas, frame)) return null;
  var size = ctx.atlas.getFrameSize(atlas, frame);
  return { frame: frame, x: 0, y: 0, w: size.w, h: size.h };
}
function bossOverlayArm(ctx, b, data) {
  b.overlay = null;
  var overlay = data && data.overlay;
  if (!overlay || !Array.isArray(overlay.parts) || !overlay.parts.length) {
    return b;
  }
  var parts = [];
  for (var i = 0; i < overlay.parts.length; i++) {
    var part = overlay.parts[i];
    var art = part ? overlayArt(ctx, b.atlas, part.frame) : null;
    if (!art) return b;
    art.x = Number(part.x) || 0;
    art.y = Number(part.y) || 0;
    parts.push(art);
  }
  var glow = null;
  var lit = overlay.glow && overlay.glow.frames;
  if (lit && typeof lit === "object") {
    for (var key in lit) {
      var from = overlayArt(ctx, b.atlas, key);
      var cut = overlayArt(ctx, b.atlas, lit[key]);
      if (!from || !cut) continue;
      if (!glow) {
        glow = {
          x: Number(overlay.glow.x) || 0,
          y: Number(overlay.glow.y) || 0,
          frames: {}
        };
      }
      glow.frames[from.frame] = cut;
    }
  }
  var shot = overlay.shot;
  var colors = [];
  if (shot && Array.isArray(shot.colors)) {
    for (var c = 0; c < shot.colors.length; c++) {
      colors.push(overlayRgb(shot.colors[c], [255, 255, 255]));
    }
  }
  b.overlay = {
    parts: parts,
    cover: overlayRgb(overlay.cover, [0, 0, 0]),
    glow: glow,
    shot: shot && typeof shot === "object" ? {
      every: overlaySteps(shot.every, 2600, 8),
      charge: overlaySteps(shot.chargeMs, 900, 3),
      flash: overlaySteps(shot.flashMs, 60, 1),
      colors: colors.length ? colors : OVERLAY_NEON,
      speed: Number(shot.speed) || 3,
      damage: shot.damage || 1,
      hp: shot.hp || 1
    } : null,
    timer: 0,
    seed: 1,
    charge: null
  };
  return b;
}
function bossOverlayStep(ctx, b) {
  var o = b.overlay;
  if (!o || !o.shot || b.deadFlg) return;
  var mul = ctx.state.turboMode ? 2 : 1;
  if (o.charge) {
    o.charge.steps += mul;
    if (o.charge.steps >= o.shot.charge) bossOverlayFire(b, o);
  }
  o.timer += mul;
  if (o.timer < o.shot.every) return;
  o.timer -= o.shot.every;
  if (o.charge) return;
  // The sequence's high bits: its low ones repeat (1 mod 4 for a long run).
  o.seed = (o.seed * 75 + 74) % 65537;
  o.charge = {
    part: o.parts[Math.floor(o.seed * o.parts.length / 65537)],
    steps: 0
  };
}
function bossOverlayShip() {
  var gs = typeof globalThis.__PS2_GS__ === "function" ?
    globalThis.__PS2_GS__() : null;
  if (!gs) return null;
  if (gs.player && !gs.player.dead) return gs.player;
  if (gs.player2 && !gs.player2.dead) return gs.player2;
  return null;
}
function bossOverlayFire(b, o) {
  var c = o.charge;
  o.charge = null;
  var x = b.x + c.part.x + c.part.w / 2;
  var y = b.y + c.part.y + c.part.h / 2;
  var ship = bossOverlayShip();
  var dx = ship ? ship.x + ship.width / 2 - x : 0;
  var dy = ship ? ship.y + ship.height / 2 - y : 1;
  var d = Math.sqrt(dx * dx + dy * dy) || 1;
  b.pendingProjectiles.push({
    x: x,
    y: y,
    rotX: dx / d,
    rotY: dy / d,
    speed: o.shot.speed,
    damage: o.shot.damage,
    hp: o.shot.hp,
    name: "bullet",
    atlas: b.atlas,
    frames: [c.part.frame],
    width: c.part.w,
    height: c.part.h,
    tints: o.shot.colors,
    flashSteps: o.shot.flash,
    tintSteps: c.steps
  });
}
function overlayColor(ctx, rgb, alpha) {
  var a = Math.max(0, Math.min(1, alpha));
  return ctx.rt.Color.new(rgb[0], rgb[1], rgb[2], Math.floor(a * 128));
}
function overlayFlash(tints, steps, flash) {
  return tints[Math.floor(steps / (flash || 1)) % tints.length];
}
function overlayDraw(ctx, b, art, x, y, color) {
  ctx.atlas.drawFrame(
    b.atlas,
    art.frame,
    ctx.vp.toX(b.x + x + art.w / 2),
    ctx.vp.toY(b.y + y + art.h / 2),
    ctx.vp.scale,
    ctx.vp.scale,
    1,
    color
  );
}
function bossOverlayDraw(ctx, b) {
  var o = b.overlay;
  if (!o || b.deadFlg || !b.visible || b.alpha <= 0 || !b.frames.length) return;
  var c = o.charge;
  var neon = c ? overlayFlash(o.shot.colors, c.steps, o.shot.flash) : null;
  if (neon && o.glow) {
    var cut = o.glow.frames[
      ctx.atlas.resolveFrameName(b.atlas, b.frames[b.animFrame])
    ];
    if (cut) {
      overlayDraw(ctx, b, cut, o.glow.x, o.glow.y, overlayColor(ctx, neon, b.alpha));
    }
  }
  var cover = overlayColor(ctx, o.cover, b.alpha);
  for (var i = 0; i < o.parts.length; i++) {
    overlayDraw(ctx, b, o.parts[i], o.parts[i].x, o.parts[i].y, cover);
  }
  if (c) {
    var fade = b.alpha * Math.min(1, c.steps / o.shot.charge);
    overlayDraw(ctx, b, c.part, c.part.x, c.part.y, overlayColor(ctx, neon, fade));
  }
}
function projectileTints(proj, data) {
  if (data && Array.isArray(data.tints) && data.tints.length) {
    proj.tints = data.tints;
    proj.flashSteps = data.flashSteps || 1;
    proj.tintSteps = data.tintSteps || 0;
  }
  return proj;
}
function projectileFlashDraw(ctx, proj) {
  if (proj.deadFlg || proj.dead || !proj.frames.length) return;
  var atlas = proj.atlas || "game_asset";
  ctx.atlas.drawFrame(
    atlas,
    ctx.atlas.resolveFrameName(atlas, proj.frames[proj.animFrame] || proj.frames[0]),
    ctx.vp.toX(proj.x),
    ctx.vp.toY(proj.y),
    ctx.vp.scale,
    ctx.vp.scale,
    1,
    overlayColor(ctx, overlayFlash(proj.tints, proj.tintSteps, proj.flashSteps), 1)
  );
}
`;

/** The top-level names BOSS_RUNTIME declares. */
const BOSS_NAMES = [
  ...BOSS_RUNTIME.matchAll(/^(?:var|function) (\w+)/gm),
].map((m) => m[1]);

// A Dezaemon zako, the browser's (game.bundle.js: initEntryScript,
// stepEntryScript, updateEnemyFire, dezaVolley). A record imported from a
// Dezaemon cart — or built from one, as gs's Clevin is from rando's horned
// imp (scripts/gs/add-clevin.ts) — moves by `dezaemon.entry`, its appearance
// script, and fires by `dezaemon.behavior.fire`, on the engine's fire pulse.
// The port reads neither. It flew such a record at `speed || 1` (straight
// down, `speed` being 0) and fired it every `interval` steps — the cart's
// fire-table interval, 5, read as steps: 24 shots a second at 120, straight
// down, from above the screen on.
//
// - The script is the browser's, row for row: [duration, angle, turn, amp,
//   flags], one row per Saturn frame of its duration, the angle turning by
//   `turn` a frame, `amp / 256` px a frame along it. 0 is right, 0x4000 up,
//   0xC000 down; a right-half spawn mirrors the lateral part and the ground
//   flag the vertical one. A Saturn frame is two of the browser's 120 Hz
//   steps, so 60 / `__PS2_GAME_FPS__` of them pass a step here (turbo
//   doubles it), and the velocity a row sets is spread over the steps.
//   Terrain rides (amp bit 15, flags bit 8) need the scrolling map the port
//   does not have; such a row moves as a plain one. With no script the port
//   moves the record as before.
// - The gun is the browser's: a pulse that adds 28 + rank/2 a Saturn frame
//   and fires past 255, a reload of TYPE012_INTERVAL by fire window plus
//   0..window-1 pulses, counted down on pulses, a volley only while the
//   zako's centre is 8 px inside the screen, and none within 40 px of the
//   ship. Rank starts at 8 + 8*stage and climbs one per 128 Saturn frames of
//   the wave phase toward 32 + 4*power + 8*stage, as the browser's does
//   (without its reset when a ship is lost). Each zako keeps its own pulse —
//   the browser's is the scene's — so their volleys keep the same rhythm and
//   are not in step.
// - A volley is the geometry table's spread about the ship's heading, or
//   straight down unaimed; 11 jitters, 12 spirals, 10-12 burst. The bullet is
//   the record's own art (its bulletData, as normalizeRecipe hands it over) at
//   the browser's zako speed, 1.35 px a Saturn frame — or the cart's bullet
//   config, when the level carries `dezaemonBullets`. Steering (8, 9) is not
//   modelled; those fly straight. The port's own gun stands down.
// - Its random draws come from one LCG, as the overlay's do, so a run
//   replays the same. The ship it aims at is the overlay's (bossOverlayShip).
//
// No `$` in here: it is spliced into a String.replace replacement.
export const DEZA_ZAKO_RUNTIME = String
  .raw`// shmupX lib/ps2/runtime-patches.ts: a Dezaemon zako's script and gun.
var DEZA_TYPE012_INTERVAL = [14, 12, 10, 8, 6, 4, 2, 1];
var DEZA_FIRE_WINDOW = [29, 22, 16, 11, 7, 4, 2, 1];
var DEZA_GEOMETRY_SPREADS = {
  1: [0], 2: [-8, 8], 3: [0, -8, 8], 4: [0, -16, 16], 5: [-8, 8, -24, 24],
  6: [0, -8, 8, -16, 16], 7: [0, -16, 16, -32, 32], 8: [0, -16, 16, -32, 32],
  9: [0], 10: [0], 13: [-64, 64], 14: [0, -64, 64, 128],
  15: [0, -32, 32, -64, 64, -96, 96, 128]
};
var DEZA_SPIRAL_DELTAS = [192, 208, 224, 240, 0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176];
var DEZA_ANGLE_UNIT = Math.PI * 2 / 256;
var DEZA_ZAKO_BULLET_SPEED = 1.35;
var DEZA_POINT_BLANK = 40;
var DEZA_ENTRY_ADVANCE = 0x1;
var DEZA_ENTRY_NO_COS = 0x20;
var DEZA_ENTRY_NO_SIN = 0x40;
var DEZA_SEED = 1;
function dezaRandom() {
  DEZA_SEED = (DEZA_SEED * 75 + 74) % 65537;
  return DEZA_SEED / 65537;
}
function dezaSaturnPerStep() {
  return 60 / (globalThis.__PS2_GAME_FPS__ || 30);
}
function dezaScene() {
  return typeof globalThis.__PS2_GS__ === "function" ? globalThis.__PS2_GS__() : null;
}
function dezaGeometry(fire) {
  if (fire.geometry != null) return fire.geometry;
  if (fire.pattern != null) return 10 + fire.pattern;
  return (fire.direction || 0) & 15;
}
function dezaAimed(fire) {
  if (fire.aimed != null) return fire.aimed;
  return ((fire.direction || 0) & 16) !== 0;
}
function dezaReload(fire) {
  var rate = DEZA_FIRE_WINDOW.indexOf(fire.window);
  if (rate < 0) rate = 0;
  var interval = fire.mode === 3 ? fire.interval : DEZA_TYPE012_INTERVAL[rate];
  if (fire.bigShot) return interval;
  return interval + Math.floor(dezaRandom() * (fire.window || 1));
}
function dezaRank(ctx) {
  var stage = ctx.state.stageId || 0;
  var start = 8 + 8 * stage;
  var gs = dezaScene();
  if (!gs) return start;
  var powered = [gs.player, gs.player2].some(function (p) {
    return p && !p.dead && p.shootMode && p.shootMode !== "normal";
  });
  var target = 32 + 4 * (powered ? 3 : 1) + 8 * stage;
  var ramp = Math.floor((gs.frameCnt || 0) * dezaSaturnPerStep() / 128);
  return start < target ? Math.min(target, start + ramp) : Math.max(target, start - ramp);
}
function dezaZakoArm(e, data) {
  var dz = data && data.dezaemon;
  if (!dz || typeof dz !== "object") return e;
  var b = dz.behavior || {};
  var rows = dz.entry && Array.isArray(dz.entry.rows) && dz.entry.rows.length ? dz.entry.rows : null;
  var fire = b.fire && b.fire.enabled ? b.fire : null;
  e.deza = {
    rows: rows,
    idx: 0,
    rowT: 0,
    angle: 0,
    turn: 0,
    amp: 0,
    flags: 0,
    vx: 0,
    vy: 0,
    active: false,
    loaded: false,
    mirror: null,
    ground: !!b.ground,
    speed: Number.isFinite(b.speed) ? b.speed : 0,
    fire: fire,
    reload: fire ? dezaReload(fire) : -1,
    burst: 0,
    acc: 0,
    sub: 0
  };
  if (rows) e.speed = 0;
  e.interval = 0;
  return e;
}
function dezaEntryFrame(d) {
  var recompute = false;
  if (--d.rowT < 0) {
    var row = d.rows[d.idx < d.rows.length ? d.idx : d.rows.length - 1];
    d.flags = row[4];
    d.rowT = row[0];
    d.angle = row[1];
    d.turn = row[2];
    d.amp = row[3] & 0x7fff;
    d.loaded = true;
    if (d.flags & DEZA_ENTRY_ADVANCE) {
      d.idx = d.idx + 1 < d.rows.length ? d.idx + 1 : d.rows.length - 1;
    }
    recompute = true;
  } else if (d.turn) {
    d.angle = (d.angle + d.turn) & 0xffff;
    recompute = true;
  }
  if (!recompute) return;
  var th = (d.angle >>> 8) * DEZA_ANGLE_UNIT;
  var v = d.amp / 256;
  d.vx = d.flags & DEZA_ENTRY_NO_COS ? 0 : Math.cos(th) * v;
  if (d.mirror) d.vx = -d.vx;
  d.vy = d.flags & DEZA_ENTRY_NO_SIN ? 0 : -Math.sin(th) * v;
  if (d.ground) d.vy = -d.vy;
  d.active = d.amp > 0;
}
function dezaVolley(ctx, e, d, geom) {
  var proj = e.projectileData;
  var gs = dezaScene();
  if (!proj || !gs) return;
  var fire = d.fire;
  var x = e.x + e.width / 2;
  var y = e.y + e.height / 2;
  var base = Math.PI;
  if (dezaAimed(fire)) {
    var ship = bossOverlayShip();
    if (!ship) return;
    var dx = ship.x + ship.width / 2 - x;
    var dy = ship.y + ship.height / 2 - y;
    if (Math.abs(dx) < DEZA_POINT_BLANK && Math.abs(dy) < DEZA_POINT_BLANK) return;
    base = Math.atan2(dx, -dy);
  }
  var bank = ctx.state.recipe && ctx.state.recipe.dezaemonBullets;
  var cfg = bank && bank.configs && bank.configs[fire.mode];
  var speed = cfg && Number.isFinite(cfg.speedAdd)
    ? (dezaRank(ctx) * 4 / 512 + cfg.speedAdd) * 2
    : DEZA_ZAKO_BULLET_SPEED;
  var angles;
  if (geom === 11) {
    angles = [base + (Math.floor(dezaRandom() * 32) - 16) * DEZA_ANGLE_UNIT];
  } else if (geom === 12) {
    angles = [base + DEZA_SPIRAL_DELTAS[d.burst & 15] * DEZA_ANGLE_UNIT];
  } else {
    angles = (DEZA_GEOMETRY_SPREADS[geom] || [0]).map(function (s) {
      return base + s * DEZA_ANGLE_UNIT;
    });
  }
  for (var i = 0; i < angles.length; i++) {
    gs.projectiles.push(createProjectile({
      x: x,
      y: y,
      rotX: Math.sin(angles[i]),
      // createProjectile reads a 0 as "down"; a level shot is a hair off it.
      rotY: -Math.cos(angles[i]) || 1e-9,
      speed: speed * dezaSaturnPerStep(),
      damage: proj.damage || 1,
      hp: proj.hp || 1,
      name: "bullet",
      frames: proj.texture || [],
      atlas: proj.atlas || e.atlas || "game_asset"
    }));
  }
  ctx.sound.playSfx("se_shoot");
}
function dezaFireFrame(ctx, e, d) {
  d.acc += 28 + (dezaRank(ctx) >> 1);
  var pulse = d.acc > 255;
  if (pulse) d.acc = 0;
  var fire = d.fire;
  if (!fire || d.reload < 0) return;
  var geom = dezaGeometry(fire);
  var big = !!fire.bigShot;
  if (!big && geom === 0) return;
  var cy = e.y + e.height / 2;
  var onScreen = cy >= 8 && cy <= GH - 8;
  var isBurst = geom >= 10 && geom <= 12;
  var burstLen = geom === 10 ? 4 : geom === 11 ? 5 : 16;
  var firedMidBurst = false;
  if (isBurst && d.burst > 0) {
    if (geom === 12 || pulse) {
      dezaVolley(ctx, e, d, geom);
      d.burst = (d.burst + 1) % burstLen;
      firedMidBurst = true;
    }
  } else if (big) {
    if (d.reload <= 0 && onScreen) {
      d.reload = dezaReload(fire);
      dezaVolley(ctx, e, d, 1);
    } else if (d.reload > 0) d.reload -= 1;
    return;
  } else if (pulse && d.reload <= 0 && onScreen) {
    d.reload = dezaReload(fire);
    dezaVolley(ctx, e, d, geom);
    if (isBurst) d.burst = 1;
  }
  if (pulse && d.reload > 0 && !firedMidBurst) d.reload -= 1;
}
function dezaZakoStep(ctx, e) {
  var d = e.deza;
  if (d.mirror === null) d.mirror = e.x + e.width / 2 > GW / 2;
  var frames = dezaSaturnPerStep() * (ctx.state.turboMode ? 2 : 1);
  d.sub += frames;
  while (d.sub >= 1) {
    d.sub -= 1;
    if (d.rows) dezaEntryFrame(d);
    dezaFireFrame(ctx, e, d);
  }
  if (!d.rows) return;
  // A zero-amplitude row leaves the zako to its record's speed, straight
  // down, as the browser's does — once the script has started.
  if (d.active) {
    e.x += d.vx * frames;
    e.y += d.vy * frames;
  } else if (d.loaded) {
    e.y += d.speed * frames;
  }
}
`;

/** The top-level names DEZA_ZAKO_RUNTIME declares. */
const DEZA_NAMES = [
  ...DEZA_ZAKO_RUNTIME.matchAll(/^(?:var|function) (\w+)/gm),
].map((m) => m[1]);

export const RUNTIME_PATCHES: readonly RuntimePatch[] = [
  {
    // God mode. The title's L+R+START secret (runtime-entry.ts) sets
    // `state.godMode`, which the port has no notion of. Every way it hurts the
    // player — a shot, a collision, the boss timer running out — goes through
    // playerOnDamage, so one guard at its top covers them all, the way the
    // browser's playerDamage returns early on gameState.godFlg. The flinch,
    // the voice and the HP bar go with it.
    name: "god mode",
    find: /(function playerOnDamage\((\w+), \w+, \w+\) \{\r?\n)/,
    replace: "$1  if ($2.state.godMode) return;\n",
  },
  {
    // An enemy the ship runs into, the browser's way: one hit, and the enemy
    // dies of it (game.bundle.js: playerDamage then enemyDie), scored as the
    // port scores one the barrier takes. The port only hurt the ship and left
    // the enemy flying through it, so a laptop crossing the ship hit it again
    // each time its blink ran out — every 31 steps at 120 a second, three
    // hits and a lost life from one laptop. And the contact box is the
    // body's frame less a tenth of it each side, where the port and the
    // browser take the whole frame: gs's laptop leaves its frame's corners
    // empty, and a ship beside one was hit by the empty corner, the laptop
    // visibly off to its right. Shots still hit the whole frame.
    name: "enemy contact: one hit, and the enemy dies",
    find:
      /(enemyDead\((\w+), (\w+)\);(\r?\n)\s*hudOnEnemyKill\(\2\.hud, \3\.score, \3\.spgage\);\4\s*\2\.sound\.playSfx\("se_guard"\);\4\s*\}\4\s*\} else if \(hitTestAABB\()\3\.x \+ \3\.hitX, \3\.y \+ \3\.hitY, \3\.hitW, \3\.hitH, ((\w+)\.x \+ \6\.hitX, \6\.y \+ \6\.hitY, \6\.hitW, \6\.hitH\)\) \{\4(\s*))gamePlayerDamage\(1\);/,
    replace:
      "$1$3.x + $3.hitX + $3.hitW * 0.1, $3.y + $3.hitY + $3.hitH * 0.1, " +
      "$3.hitW * 0.8, $3.hitH * 0.8, $5gamePlayerDamage(1);" +
      "$4$7enemyDead($2, $3);" +
      "$4$7hudOnEnemyKill($2.hud, $3.score, $3.spgage);",
  },
  {
    // The ship's blink after a hit, while nothing hurts it, in the port's own
    // time: 30 steps and a flicker every 2 of its 30 a second — a second,
    // blinking at 7.5 Hz. The build runs `__PS2_GAME_FPS__` steps a second
    // (120 by default, lib/ps2/build.ts), which made it a quarter of a second
    // flickering at 30 Hz.
    name: "ship blink: the port's second",
    find:
      /(\.damageAnimTimer % )4 < 2\)([\s\S]{0,400}?\.damageAnimTimer > )30\)/,
    replace: "$1(4 * ((globalThis.__PS2_GAME_FPS__ || 30) / 30)) < " +
      "2 * ((globalThis.__PS2_GAME_FPS__ || 30) / 30))" +
      "$2(30 * ((globalThis.__PS2_GAME_FPS__ || 30) / 30)))",
  },
  {
    // An enemy's shadow where the browser casts it, and as dark: centred a
    // body's height below the body's centre less `shadowOffsetY`, flipped or
    // not (game.bundle.js: updateShadowPosition; the Pixi original's
    // BaseUnit), a black silhouette at half alpha. The port centred a flipped
    // shadow `shadowOffsetY` ABOVE the body's centre, in a grey that keeps
    // the art readable, so all that showed of it was the body's own bottom
    // rows upside down, poking out over its head — gs's enemies all wore one.
    name: "enemy shadow: below, and black",
    find:
      /(\w+)\.rt\.Color\.new\(60, 60, 60, 60\);(\r?\n\s*)const shadowY = (\w+)\.shadowReverse \? [^;]+;/,
    replace: "$1.rt.Color.new(0, 0, 0, 64);" +
      "$2const shadowY = $3.y + $3.height * 1.5 - $3.shadowOffsetY;",
  },
  {
    // A Dezaemon zako, 1 of 2: the helpers go in ahead of createEnemy, which
    // is wrapped so a record with a `dezaemon` block is armed the browser's
    // way, and the port's own mover and gun stand down for it.
    name: "dezaemon zako: armed",
    find: /function createEnemy\((\w+), (\w+)\) \{/,
    replace: DEZA_ZAKO_RUNTIME +
      "function createEnemy($1, $2) {\n" +
      "  return dezaZakoArm(createEnemyBody($1, $2), $2);\n" +
      "}\n" +
      "function createEnemyBody($1, $2) {",
    defines: [...DEZA_NAMES, "createEnemyBody"],
  },
  {
    // 2 of 2: every step, ahead of the port's own, its script and its gun.
    // An exploding zako stops where it was hit.
    name: "dezaemon zako: script and gun",
    find: /function enemyLoop\((\w+), (\w+), (\w+)\) \{/,
    replace: "function enemyLoop($1, $2, $3) {\n" +
      "  if ($2.deza && !$2.dead && !$2.deadFlg) dezaZakoStep($1, $2);\n" +
      "  return enemyLoopBody($1, $2, $3);\n" +
      "}\n" +
      "function enemyLoopBody($1, $2, $3) {",
    defines: ["enemyLoopBody"],
  },
  {
    // A boss, 1 of 4: the helpers go in ahead of createBoss, which is wrapped
    // so every boss it makes is armed the browser's way, for its second stage
    // and for its overlay — or for neither, when its record has no block.
    name: "boss: armed",
    find: /function createBoss\((\w+), (\w+), (\w+)\) \{/,
    replace: BOSS_RUNTIME +
      "function createBoss($1, $2, $3) {\n" +
      "  return bossOverlayArm($1, bossArm(createBossBody($1, $2, $3), $2), $2);\n" +
      "}\n" +
      "function createBossBody($1, $2, $3) {",
    defines: [...BOSS_NAMES, "createBossBody"],
  },
  {
    // 2 of 4: one move when the cooldown runs out — the change to stage 2 when
    // it is due, slot B's throw on its turn, else the port's routine.
    name: "boss: one move at a time",
    find: /(\.attackCooldown <= 0\) \{\r?\n\s*)bossAttack\((\w+), (\w+)\);/,
    replace: "$1bossMove($2, $3);",
  },
  {
    // 3 of 4: every step once the boss has arrived, the overlay's clock; then
    // the morph. While it plays the boss neither moves nor fires — bossLoop
    // stops short of both — and the ghost of stage 1 fades.
    name: "boss stage 2: the morph",
    find:
      /(\n(\s*)const (\w+) = (\w+)\.state\.turboMode \? 2 : 1;\r?\n\s*(\w+)\.moveTimer \+= \3;)/,
    replace: "\n$2bossOverlayStep($4, $5);" +
      "\n$2if (bossStage2Step($4, $5)) return;$1",
  },
  {
    // 4 of 4: stage 1's last pose, drawn over the first frames of the morph
    // as it fades, so one body reads as becoming the other rather than a cut;
    // then the overlay, over whichever body is standing.
    name: "boss stage 2: the ghost",
    find: /function bossDraw\((\w+), (\w+)\) \{/,
    replace: "function bossDraw($1, $2) {\n" +
      "  bossDrawBody($1, $2);\n" +
      "  bossStage2Ghost($1, $2);\n" +
      "  bossOverlayDraw($1, $2);\n" +
      "}\n" +
      "function bossDrawBody($1, $2) {",
    defines: ["bossDrawBody"],
  },
  {
    // An overlay's shot, 1 of 3: the scene makes each boss shot a projectile
    // with createProjectile, which keeps only the fields it knows; the flash
    // is carried over.
    name: "overlay shot: made",
    find: /function createProjectile\((\w+)\) \{/,
    replace: "function createProjectile($1) {\n" +
      "  return projectileTints(createProjectileBody($1), $1);\n" +
      "}\n" +
      "function createProjectileBody($1) {",
    defines: ["createProjectileBody"],
  },
  {
    // 2 of 3: its flash keeps time with the steps it flies.
    name: "overlay shot: flies",
    find: /function projectileLoop\((\w+), (\w+), (\w+)\) \{/,
    replace: "function projectileLoop($1, $2, $3) {\n" +
      "  if ($2.tints) $2.tintSteps += $1.state.turboMode ? 2 : 1;\n" +
      "  return projectileLoopBody($1, $2, $3);\n" +
      "}\n" +
      "function projectileLoopBody($1, $2, $3) {",
    defines: ["projectileLoopBody"],
  },
  {
    // 3 of 3: and is drawn in its colour of the moment.
    name: "overlay shot: drawn",
    find: /function projectileDraw\((\w+), (\w+)\) \{/,
    replace: "function projectileDraw($1, $2) {\n" +
      "  if ($2.tints) {\n" +
      "    projectileFlashDraw($1, $2);\n" +
      "    return;\n" +
      "  }\n" +
      "  projectileDrawBody($1, $2);\n" +
      "}\n" +
      "function projectileDrawBody($1, $2) {",
    defines: ["projectileDrawBody"],
  },
  {
    // The text face. The port makes one Font('default') — AthenaEnv's
    // built-in — for every line it prints, the title's HI-SCORE and PRESS
    // START and the HUD alike. A build that carries a face of its own names
    // it in `__PS2_FONT__` (lib/ps2/build.ts, Orbitron by default) with the
    // scale that keeps it inside the port's layout in `__PS2_FONT_SCALE__`;
    // a build that names none keeps the built-in font at the port's scale.
    //
    // `__PS2_FONT_BOLD__` thickens it: AthenaEnv rasterises a TrueType face at
    // its own size and scales the bitmap down, and at the half size the port's
    // layout needs, Orbitron's hairline crossbars fall between pixels ("H
    // SCORE"). Drawing each line again a pixel right and a pixel down keeps
    // every stroke at least two pixels wide.
    name: "font: the build's own",
    find:
      /const (\w+) = new (\w+)\.Font\("default"\);(\r?\n)(\s*)\1\.scale = (\w+)\.scale;/,
    replace:
      'const $1 = new $2.Font(globalThis.__PS2_FONT__ || "default");$3$4$1.scale = $5.scale * (globalThis.__PS2_FONT_SCALE__ || 1);' +
      "$3$4if (globalThis.__PS2_FONT_BOLD__) {$3$4  const print1 = $1.print.bind($1);" +
      "$3$4  $1.print = (x, y, text, color) => { print1(x, y, text, color); print1(x + 1, y, text, color); print1(x, y + 1, text, color); };" +
      "$3$4}",
  },
  {
    // The game scene's state — the ship, the enemies, the boss, the shots in
    // flight, the items — lives in createGameScene's own closure, where
    // nothing outside the scene can see it. A pilot that flies the web build
    // (scripts/testdrive-parity.ts, through lib/ps2/web-host.ts) has to: it
    // reads `globalThis.__PS2_GS__()`, the scene the game made last. A getter,
    // so it reads the state only once the scene has built it. A console has
    // nothing that calls it, so on hardware it is one unused property.
    name: "game scene: published",
    find:
      /function createGameScene\((\w+), (\w+) = null\) \{(\r?\n)(\s*)const (\w+) = \{/,
    replace:
      "function createGameScene($1, $2 = null) {$3$4globalThis.__PS2_GS__ = () => $5;$3$4const $5 = {",
  },
];

/** `js` with every patch applied; throws when an anchor is missing. */
export function patchRuntime(js: string): string {
  let out = js;
  for (const patch of RUNTIME_PATCHES) {
    const hits = out.match(new RegExp(patch.find.source, "g"))?.length ?? 0;
    if (hits !== 1) {
      throw new Error(
        `PS2 runtime patch "${patch.name}": its anchor is in main.js ` +
          `${hits} times, not once — the @easierbycode/svelte-ps2 pin has ` +
          `moved under it (lib/ps2/runtime-patches.ts)`,
      );
    }
    for (const name of patch.defines ?? []) {
      if (new RegExp(`\\b(?:var|let|const|function) ${name}\\b`).test(out)) {
        throw new Error(
          `PS2 runtime patch "${patch.name}": main.js already declares ` +
            `${name} — the @easierbycode/svelte-ps2 pin has grown a name the ` +
            `patch declares too (lib/ps2/runtime-patches.ts)`,
        );
      }
    }
    out = out.replace(patch.find, patch.replace);
  }
  return out;
}
