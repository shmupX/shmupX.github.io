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
//   out, a boss that is due changes instead of attacking.
// - The port draws a boss with one frame list, `texture` — normalizeRecipe's
//   copy of anim.idle — and never its other stances, so stage 2 stands in the
//   block's `texture`, else its `anim.idle`, else the boss's own. The shoot
//   and syngoku stances the browser's routines switch to stay unused, as the
//   boss's own do (lib/ps2/assets.ts packs only what is drawn).
// - Its routines read two weapons: `projectileData`, fired by every one, and
//   `projectileDataA`, the second boss's spread. Stage 2 arms all four slots
//   the browser's way (bossWeaponSlots: bulletData or projectileData, the
//   one weapon a routine fires being the record's own else slot A's), each in
//   the shape normalizeRecipe gives a boss's bulletData. A slot whose texture
//   names no frame is no weapon: normalizeRecipe gives a boss with no
//   bulletData an empty stand-in, which would otherwise shadow slot A and
//   fire the port's red squares, as gs's Daltonius does before he changes.
// - The routine is picked by `stageId`, never by attackPattern, so only a
//   block's OWN attackPattern changes it, and only to one the port has
//   (`bossN`); a boss's attackPattern does nothing here in either stage.
// - Timings are logic steps, as every one of the port's is, at its own 30 a
//   second (and twice as fast in turbo, like its cooldowns): a morph frame
//   is 3 (the browser's 90 ms), stage 1's last pose fades out over 11 (360
//   ms) above the first frames of the morph, and the routine picks up 15
//   after the morph (500 ms). The boss holds still and holds fire while it
//   changes, and stays hittable throughout.
// - The first morph frame keeps the top edge of the body it replaces — a
//   taller body hangs lower rather than climbing off the screen — and every
//   frame after keeps its centre; the hit box is each frame's size, as
//   createBoss makes it.
// - The browser's camera flash and shake have no equivalent on the console;
//   the morph plays se_sp, as the browser does.
//
// No `$` in here: it is spliced into a String.replace replacement.
export const BOSS_STAGE2_RUNTIME = String
  .raw`// shmupX lib/ps2/runtime-patches.ts: a boss's second stage.
var BOSS_STAGE2_HP_BELOW = 0.5;
var BOSS_WEAPON_SUFFIXES = ["", "A", "B", "C"];
var BOSS_STAGE2_MORPH_STEPS = 3;
var BOSS_STAGE2_FADE_STEPS = 11;
var BOSS_STAGE2_REST_STEPS = 15;
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
function bossStage2Arm(b, data) {
  var block = data && data.stage2;
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
function bossStage2Weapon(record, suffix) {
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
function bossStage2Weapons(b, record) {
  b.projectileDataA = bossStage2Weapon(record, "A");
  b.projectileDataB = bossStage2Weapon(record, "B");
  b.projectileDataC = bossStage2Weapon(record, "C");
  b.projectileData = bossStage2Weapon(record, "") || b.projectileDataA ||
    record.projectileData || null;
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
  b.attackCooldown = BOSS_STAGE2_REST_STEPS;
}
function bossStage2Start(ctx, b) {
  var stage2 = b.stage2;
  b.stage2Done = 1;
  bossStage2Weapons(b, stage2);
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
    if (ghost.steps >= BOSS_STAGE2_FADE_STEPS) b.stage2Ghost = null;
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
  if (morph.steps < BOSS_STAGE2_MORPH_STEPS) return true;
  morph.steps -= BOSS_STAGE2_MORPH_STEPS;
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
  var alpha = (1 - ghost.steps / BOSS_STAGE2_FADE_STEPS) * b.alpha;
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
`;

/** The top-level names BOSS_STAGE2_RUNTIME declares. */
const BOSS_STAGE2_NAMES = [
  ...BOSS_STAGE2_RUNTIME.matchAll(/^(?:var|function) (\w+)/gm),
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
    // A boss's second stage, 1 of 4: the helpers go in ahead of createBoss,
    // which is wrapped so every boss it makes is armed for its stage 2 — or
    // for none, when its record has no block.
    name: "boss stage 2: armed",
    find: /function createBoss\((\w+), (\w+), (\w+)\) \{/,
    replace: BOSS_STAGE2_RUNTIME +
      "function createBoss($1, $2, $3) {\n" +
      "  return bossStage2Arm(createBossBody($1, $2, $3), $2);\n" +
      "}\n" +
      "function createBossBody($1, $2, $3) {",
    defines: [...BOSS_STAGE2_NAMES, "createBossBody"],
  },
  {
    // 2 of 4: between two moves. bossLoop attacks when the cooldown runs out;
    // a boss that is due changes then instead.
    name: "boss stage 2: between moves",
    find: /(\s)bossAttack\((\w+), (\w+)\);/,
    replace: "$1(bossStage2Due($3) ? bossStage2Start : bossAttack)($2, $3);",
  },
  {
    // 3 of 4: the morph. While it plays the boss neither moves nor fires —
    // bossLoop stops short of both — and the ghost of stage 1 fades.
    name: "boss stage 2: the morph",
    find:
      /(\n(\s*)const (\w+) = (\w+)\.state\.turboMode \? 2 : 1;\r?\n\s*(\w+)\.moveTimer \+= \3;)/,
    replace: "\n$2if (bossStage2Step($4, $5)) return;$1",
  },
  {
    // 4 of 4: stage 1's last pose, drawn over the first frames of the morph
    // as it fades, so one body reads as becoming the other rather than a cut.
    name: "boss stage 2: the ghost",
    find: /function bossDraw\((\w+), (\w+)\) \{/,
    replace: "function bossDraw($1, $2) {\n" +
      "  bossDrawBody($1, $2);\n" +
      "  bossStage2Ghost($1, $2);\n" +
      "}\n" +
      "function bossDrawBody($1, $2) {",
    defines: ["bossDrawBody"],
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
