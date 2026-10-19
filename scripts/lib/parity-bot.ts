// The tool-assisted pilot for the panes whose game state can be read: the
// web runtime (2028.Ai's PhaserGameScene) and the PS2 build in the browser
// (lib/ps2/web-host.ts, whose game scene a runtime patch publishes as
// `__PS2_GS__`). It is page code, installed after scripts/lib/game-debug.ts's
// PROBE — whose stepOnce it wraps, so it decides every frame's input from the
// state that frame will run on.
//
// One pilot, two adapters. An adapter reads its runtime into one VIEW — the
// ship, its speed, the enemy bullets with their velocities, the enemy bodies,
// the items, the boss — and presses that runtime's pad; everything else is
// shared:
//
// - Steering (the ship autofires on both): the nine moves are each flown
//   `horizon` frames ahead — the ship at its own speed, every bullet along a
//   straight line at its velocity, every body where it stands — and the
//   cheapest taken: a hit costs more the sooner it lands, a near miss a
//   little, and the rest is distance from where it wants to be. That is under
//   the boss, where its shots land; on a falling item; or, before the boss,
//   under whatever carries an item, then under the weakest enemy — so the
//   boss is met with the level's power-ups.
// - The capture window opens on the frame the boss's HP falls to `fromHp` of
//   its bar, and from then on the first frame each of the boss's projectile
//   kinds is on screen is noted. A powered-up ship takes the last few percent
//   to the morph in a second or two, faster than the boss gets round to its
//   next volley, and it cannot hold its fire — so each kind the boss fires
//   only BEFORE its second stage (gs: RAM_0, the laptops) is also remembered
//   as it last APPEARED before the morph, with the wall-clock time and the
//   boss's HP then, and the driver opens the clip early enough to hold that
//   volley. The window closes `tailSteps` after the morph and the last new
//   kind, or when the boss dies, or at `maxWindowSteps`.
// - The pad mask of every frame is logged for the attract mode
//   (scripts/lib/parity.ts encodeInputs).
//
// Everything it reads is plain game state; it changes nothing but the pad.

export interface BotConfig {
  /** Boss projectile kinds: kind -> bullet frame names (parity.ts projectileKinds). */
  kinds: Record<string, string[]>;
  /** Kinds the boss fires before its second stage only (not `stage2:`). */
  preMorphKinds: string[];
  /** The window opens when the boss's HP falls to this share of its bar. */
  fromHp: number;
  /** Frames the window runs on after the morph and the last new kind. */
  tailSteps: number;
  /** The longest the window may run, in frames. */
  maxWindowSteps: number;
  /** Frames each candidate move is flown ahead. */
  horizon: number;
  /** Whether the boss has a second stage the window must include. */
  needMorph: boolean;
}

/** @deprecated the web pilot's config is the shared one. */
export type WebBotConfig = BotConfig;

/** The pad bits a logged mask is made of (parity.ts BUTTON_BITS). */
const BITS = "{ up: 1, down: 2, left: 4, right: 8, sp: 32, start: 64 }";

/**
 * The shared half: steering, the window, the kinds, the log. `ADAPTER` is a
 * function expression `(bot, cfg) => ({ read(), press(mask) })`; `read`
 * answers null outside a stage, else the view.
 */
function pilot(adapter: string, config: BotConfig): string {
  return `(function (cfg, makeAdapter) {
  if (window.__bot) return "already";
  var dbg = window.__dbg;
  if (!dbg) return "no probe";
  var BIT = ${BITS};
  var bot = window.__bot = {
    on: false, step: 0, masks: [], err: null,
    hp: null, maxHp: null, bossSeenStep: null, bossSeenWall: null,
    windowStart: null, windowStartWall: null, windowEnd: null, windowEndWall: null,
    endReason: null, morphStep: null, morphWall: null,
    seen: {}, lastKindStep: null, hits: 0, lastHp: null, outcome: null,
    standOff: 0, onScreen: {}, preMorph: {}, hpLog: [],
  };
  var frameKey = function (n) { return String(n || "").replace(/\\u2024/g, "."); };
  bot.kindOf = function (names) {
    for (var i = 0; i < names.length; i++) {
      var f = frameKey(names[i]);
      for (var k in cfg.kinds) if (cfg.kinds[k].indexOf(f) >= 0) return k;
    }
    return null;
  };
  var A = makeAdapter(bot, cfg);
  function end(reason) {
    if (bot.windowEnd !== null) return;
    bot.windowEnd = bot.step;
    bot.windowEndWall = Date.now();
    bot.endReason = reason;
  }

  function plan(v) {
    var tx = v.tx, ty = v.ty, H = cfg.horizon, bestCost = Infinity, bestMask = 0;
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
      var cost = (dx || dy) ? 0.4 : 0, sx = v.px, sy = v.py;
      for (var k = 1; k <= H; k++) {
        sx = Math.max(v.minX, Math.min(v.maxX, sx + dx * v.spd));
        sy = Math.max(v.minY, Math.min(v.maxY, sy + dy * v.spd));
        var w = H - k + 1;
        for (var q = 0; q < v.bullets.length; q++) {
          var bb = v.bullets[q];
          var ddx = Math.abs(sx - (bb.x + bb.vx * k)), ddy = Math.abs(sy - (bb.y + bb.vy * k));
          if (ddx < bb.hx && ddy < bb.hy) cost += 400 * w;
          else if (ddx < bb.hx + 14 && ddy < bb.hy + 14) cost += 6 * w / k;
        }
        for (var r = 0; r < v.bodies.length; r++) {
          var o2 = v.bodies[r];
          if (Math.abs(sx - o2.x) < o2.hx && Math.abs(sy - o2.y) < o2.hy) cost += 300 * w;
        }
      }
      cost += Math.abs(sx - tx) * 0.6 + Math.abs(sy - ty) * 0.25;
      if (cost < bestCost) {
        bestCost = cost;
        bestMask = (dx < 0 ? BIT.left : dx > 0 ? BIT.right : 0) | (dy < 0 ? BIT.up : dy > 0 ? BIT.down : 0);
      }
    }
    if (v.boss && v.spReady && (bot.step & 1)) bestMask |= BIT.sp;
    return bestMask;
  }

  function tick() {
    var v = A.read();
    if (!v) {
      // Out of the stage after being in it: a game over, a TIME OVER, a
      // cleared stage — the run is over either way.
      if (bot.step > 0 && bot.windowEnd === null) bot.outcome = bot.outcome || "left-stage";
      A.press(0);
      return;
    }
    bot.step++;
    bot.shot = v.shot;
    bot.sp = v.sp;
    bot.items = v.itemCount;
    var max = v.bossMax, hp = v.bossHp;
    if (v.boss && max > 0) {
      bot.hp = hp; bot.maxHp = max;
      if (bot.bossSeenStep === null) { bot.bossSeenStep = bot.step; bot.bossSeenWall = Date.now(); }
      if (bot.windowStart === null && hp / max <= cfg.fromHp) {
        bot.windowStart = bot.step; bot.windowStartWall = Date.now();
      }
      if (bot.step % 15 === 0) bot.hpLog.push([Date.now(), hp]);
    }
    if (v.morphed && bot.morphStep === null) { bot.morphStep = bot.step; bot.morphWall = Date.now(); }
    var now = {};
    for (var i = 0; i < v.bulletKinds.length; i++) if (v.bulletKinds[i]) now[v.bulletKinds[i]] = true;
    for (var kk in now) {
      if (!bot.onScreen[kk] && bot.morphStep === null && max > 0) {
        bot.preMorph[kk] = { step: bot.step, wall: Date.now(), hp: hp };
      }
      if (bot.windowStart !== null && bot.seen[kk] == null) { bot.seen[kk] = bot.step; bot.lastKindStep = bot.step; }
    }
    bot.onScreen = now;
    if (bot.windowStart !== null) {
      // A kind fired only before the morph counts once it appeared at all
      // before it: the driver opens the clip on its last volley.
      var all = Object.keys(cfg.kinds).every(function (k) {
        return bot.seen[k] != null || (cfg.preMorphKinds.indexOf(k) >= 0 && bot.preMorph[k]);
      });
      var settled = Math.max(bot.lastKindStep || 0, bot.morphStep || 0);
      if (all && (!cfg.needMorph || bot.morphStep !== null) && bot.step - settled >= cfg.tailSteps) end("complete");
      else if (v.boss && hp <= 0) end("boss-down");
      else if (v.cleared) end("boss-down");
      else if (bot.step - bot.windowStart >= cfg.maxWindowSteps) end("max-window");
    }
    if (bot.lastHp !== null && v.playerHp < bot.lastHp) bot.hits++;
    bot.lastHp = v.playerHp;
    if (v.dead) bot.outcome = bot.outcome || "dead";
    if (v.timeOver) bot.outcome = bot.outcome || "time-over";
    var mask = plan(v);
    bot.masks.push(mask);
    A.press(mask);
  }

  var orig = dbg.stepOnce;
  dbg.stepOnce = function () {
    if (bot.on) { try { tick(); } catch (e) { bot.err = String(e && e.stack || e); } }
    return orig.apply(this, arguments);
  };
  return "installed";
})(${JSON.stringify(config)}, ${adapter})`;
}

/**
 * Where the ship wants to be: under a falling item, waiting for it; else
 * under the boss (close enough for a spread shot to land whole); else —
 * before the boss — under whatever carries an item, then the weakest enemy.
 * An item is worth it from the moment it drops, not once it is low: a falling
 * item crosses the screen in a couple of seconds and the ship has to be under
 * it before it gets there. Shot upgrades come before the barrier, and an item
 * that has already fallen past the ship is gone. Page code shared by both
 * adapters; `enemies` are { x, y, item, hp } and `items` { x, y, name }, x
 * and y the centre.
 */
const TARGET = `function (v, enemies, items, boss, bh) {
    var tx = 128, ty = 400;
    if (boss && boss.y + bh / 2 > 280) {
      // The boss is down among the ship's rows (a dive): out from under it.
      tx = boss.x < 128 ? Math.min(236, boss.x + 90) : Math.max(20, boss.x - 90);
      ty = 440;
    } else if (boss) {
      tx = boss.x; ty = Math.min(420, boss.y + bh / 2 + 150);
    } else {
      var pick = null, best = Infinity;
      for (var z = 0; z < enemies.length; z++) {
        var c = enemies[z];
        if (c.y < 0 || c.y > 380) continue;
        var s = (c.item ? 0 : 1000) + (c.hp || 0) * 10 + Math.abs(c.x - v.px);
        if (s < best) { best = s; pick = c; }
      }
      if (pick) tx = pick.x;
    }
    var bestItem = null, bestScore = 1e9;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.y > v.py + 8) continue;
      var score = Math.abs(it.x - v.px) + (/barrier/.test(String(it.name)) ? 120 : 0);
      if (score < bestScore) { bestScore = score; bestItem = it; }
    }
    if (bestItem) { tx = bestItem.x; ty = Math.min(440, Math.max(300, bestItem.y + 40)); }
    v.tx = tx; v.ty = ty;
  }`;

/** The web runtime: 2028.Ai's PhaserGameScene and the probe's synthetic pad. */
export function webBot(config: BotConfig): string {
  const adapter = `function (bot, cfg) {
  var dbg = window.__dbg;
  var target = ${TARGET};
  var lastPos = new WeakMap();
  var PAD = [[1, 12], [2, 13], [4, 14], [8, 15], [32, 0], [64, 9]];
  function half(o, f) { return Math.max(2, (o && o.displayWidth ? o.displayWidth : 8) * f); }
  return {
    read: function () {
      var g = dbg.game();
      if (!g || !g.scene || !g.scene.isActive("PhaserGameScene")) return null;
      var sc = g.scene.getScene("PhaserGameScene");
      var p = sc.players && sc.players[0];
      if (!sc.gameStarted || !p) return null;
      var boss = sc.bossSprite && sc.bossSprite.active && sc.bossActive ? sc.bossSprite : null;
      var v = {
        px: p.unitX, py: p.sprite ? p.sprite.y : p.unitY, spd: sc.keyMoveSpeed || 3,
        minX: 10, maxX: 246, minY: 50, maxY: 460,
        bullets: [], bodies: [], bulletKinds: [],
        boss: boss ? { x: boss.x, y: boss.y } : null,
        bossHp: sc.bossHp, bossMax: sc.bossMaxHp, morphed: !!sc.bossStage2Done,
        playerHp: p.hp, dead: !!(p.dead || sc._runEnded),
        timeOver: sc.bossTimerStartFlg === false && sc.bossTimerCountDown <= 0,
        cleared: !!sc.stageCleared,
        shot: (p.shootMode || sc.shootMode) + "/" + (p.shootSpeed || sc.shootSpeed),
        sp: p.spGauge, spReady: p.spGauge >= 100, itemCount: (sc.items || []).length,
      };
      var eb = sc.enemyBullets || [];
      for (var j = 0; j < eb.length; j++) {
        var b = eb[j];
        if (!b || !b.active) continue;
        var s = b.getData ? (b.getData("speed") || 1) : 1;
        v.bullets.push({ x: b.x, y: b.y,
          vx: (b.getData ? (b.getData("rotX") || 0) : 0) * s,
          vy: (b.getData ? (b.getData("rotY") || 1) : 1) * s,
          hx: 8 + half(b, 0.3), hy: 8 + (b.displayHeight ? b.displayHeight * 0.3 : 4) });
        if (b.frame) v.bulletKinds.push(bot.kindOf([b.frame.name]));
      }
      var en = sc.enemies || [], foes = [];
      for (var e = 0; e < en.length; e++) {
        var o = en[e];
        if (!o || !o.active) continue;
        // A body on the move — Daltonius diving at the ship — is flown ahead
        // like a bullet, at the velocity it showed since the last frame.
        var prev = lastPos.get(o);
        var evx = prev ? o.x - prev.x : 0, evy = prev ? o.y - prev.y : 0;
        lastPos.set(o, { x: o.x, y: o.y });
        var body = { x: o.x, y: o.y, vx: evx, vy: evy, hx: 6 + half(o, 0.4), hy: 6 + (o.displayHeight ? o.displayHeight * 0.4 : 4) };
        if (Math.abs(evx) + Math.abs(evy) > 0.5 && Math.abs(evx) + Math.abs(evy) < 40) v.bullets.push(body);
        else v.bodies.push(body);
        if (o !== sc.bossSprite) {
          foes.push({ x: o.x, y: o.y, item: o.getData ? o.getData("itemName") : null, hp: o.getData ? o.getData("hp") : 0 });
        }
      }
      var items = [];
      (sc.items || []).forEach(function (it) {
        if (it && it.active) items.push({ x: it.x, y: it.y, name: it.getData ? it.getData("itemName") : null });
      });
      target(v, foes, items, v.boss, boss ? (boss.displayHeight || 96) : 0);
      return v;
    },
    press: function (mask) {
      var on = [], off = [];
      for (var i = 0; i < PAD.length; i++) (mask & PAD[i][0] ? on : off).push(PAD[i][1]);
      dbg.setButtons(off, false);
      dbg.setButtons(on, true);
    },
  };
}`;
  return pilot(adapter, config);
}

/**
 * The PS2 build in the browser (lib/ps2/web-host.ts): the port's game scene
 * through `__PS2_GS__()` and its pad through `__PS2_PADS__`. The port keeps
 * positions as top-left corners on the same 256x480 field as the browser,
 * its shots as centres, and moves things a few logic steps per rendered
 * frame (more in turbo), so velocities and the ship's speed are MEASURED
 * frame to frame rather than worked out from the port's units.
 */
export function ps2Bot(config: BotConfig): string {
  const adapter = `function (bot, cfg) {
  var target = ${TARGET};
  var last = new WeakMap();
  var lastShip = null, spd = 4;
  // The pad is the host's, which loads after this script: looked up on use.
  var MAP = null;
  function map() {
    if (MAP) return MAP;
    var B = window.__PS2_PADS__ && window.__PS2_PADS__.BUTTONS;
    if (!B) return null;
    MAP = [[1, B.UP], [2, B.DOWN], [4, B.LEFT], [8, B.RIGHT]];
    return MAP;
  }
  return {
    read: function () {
      var ctx = window.__PS2_CTX__;
      var gs = window.__PS2_GS__ && window.__PS2_GS__();
      if (!ctx || !gs || ctx.scenes.current !== "game" || !gs.player) return null;
      var p = gs.player;
      var px = p.x + p.width / 2, py = p.y + p.height / 2;
      if (lastShip) {
        var moved = Math.max(Math.abs(px - lastShip.x), Math.abs(py - lastShip.y));
        if (moved > 0.5 && moved < 24) spd = spd * 0.8 + moved * 0.2;
      }
      lastShip = { x: px, y: py };
      var boss = gs.boss && !gs.boss.dead && gs.boss.entryDone ? gs.boss : null;
      var v = {
        px: px, py: py, spd: spd,
        minX: p.width / 2, maxX: 256 - p.width / 2, minY: 50, maxY: 460,
        bullets: [], bodies: [], bulletKinds: [],
        boss: boss ? { x: boss.x + boss.width / 2, y: boss.y + boss.height / 2 } : null,
        bossHp: gs.boss ? gs.boss.hp : null, bossMax: gs.boss ? gs.boss.maxHp : null,
        morphed: !!(gs.boss && gs.boss.stage2Done),
        playerHp: p.hp, dead: !!p.dead,
        timeOver: gs.bossTimerStartFlg && gs.bossTimerCountDown <= 0,
        cleared: !!(gs.boss && gs.boss.deadFlg),
        shot: String(p.shootMode) + "/" + String(p.shootSpeed),
        sp: ctx.state.spgage, spReady: false, itemCount: (gs.items || []).length,
      };
      var shipHx = (p.hitW || 14) / 2, shipHy = (p.hitH || 8) / 2;
      var pr = gs.projectiles || [];
      for (var j = 0; j < pr.length; j++) {
        var b = pr[j];
        if (!b || b.dead || b.deadFlg) continue;
        var prev = last.get(b);
        var vx = prev ? b.x - prev.x : (b.rotX || 0) * (b.speed || 1) * 2;
        var vy = prev ? b.y - prev.y : (b.rotY || 1) * (b.speed || 1) * 2;
        last.set(b, { x: b.x, y: b.y });
        v.bullets.push({ x: b.x, y: b.y, vx: vx, vy: vy,
          hx: shipHx + (b.width || 8) * 0.4 + 2, hy: shipHy + (b.height || 8) * 0.4 + 2 });
        v.bulletKinds.push(bot.kindOf(b.frames || []));
      }
      var foes = [];
      // A body on the move is flown ahead like a bullet, at the velocity it
      // showed since the last frame; one standing still is an obstacle.
      var bodyAt = function (o, cx, cy, w, h) {
        var prev = last.get(o);
        var vx = prev ? cx - prev.x : 0, vy = prev ? cy - prev.y : 0;
        last.set(o, { x: cx, y: cy });
        var body = { x: cx, y: cy, vx: vx, vy: vy, hx: 6 + w * 0.4, hy: 6 + h * 0.4 };
        if (Math.abs(vx) + Math.abs(vy) > 0.5 && Math.abs(vx) + Math.abs(vy) < 40) v.bullets.push(body);
        else v.bodies.push(body);
      };
      (gs.enemies || []).forEach(function (e) {
        if (!e || e.dead || e.explosionPlaying) return;
        var w = e.width || 32, h = e.height || 32;
        var cx = e.x + w / 2, cy = e.y + h / 2;
        bodyAt(e, cx, cy, w, h);
        foes.push({ x: cx, y: cy, item: e.itemName || (e.data && e.data.itemName) || null, hp: e.hp || 0 });
      });
      if (boss) bodyAt(boss, v.boss.x, v.boss.y, boss.width, boss.height);
      var items = (gs.items || []).map(function (it) { return { x: it.x, y: it.y, name: it.name }; });
      target(v, foes, items, v.boss, boss ? boss.height : 0);
      return v;
    },
    press: function (mask) {
      var M = map();
      if (!M) return;
      var m = 0;
      for (var i = 0; i < M.length; i++) if (mask & M[i][0]) m |= M[i][1];
      window.__PS2_PADS__.set(m);
    },
  };
}`;
  return pilot(adapter, config);
}

/** What the driver reads back from the page each poll. */
export const BOT_STATUS = `(function () {
  var b = window.__bot;
  if (!b) return null;
  return {
    step: b.step, err: b.err, hp: b.hp, maxHp: b.maxHp,
    bossSeenStep: b.bossSeenStep, bossSeenWall: b.bossSeenWall,
    windowStart: b.windowStart, windowStartWall: b.windowStartWall,
    windowEnd: b.windowEnd, windowEndWall: b.windowEndWall, endReason: b.endReason,
    morphStep: b.morphStep, morphWall: b.morphWall, seen: b.seen,
    hits: b.hits, outcome: b.outcome, standOff: b.standOff,
    shot: b.shot, sp: b.sp, items: b.items, preMorph: b.preMorph,
  };
})()`;

export interface BotStatus {
  step: number;
  err: string | null;
  hp: number | null;
  maxHp: number | null;
  bossSeenStep: number | null;
  bossSeenWall: number | null;
  windowStart: number | null;
  windowStartWall: number | null;
  windowEnd: number | null;
  windowEndWall: number | null;
  endReason: string | null;
  morphStep: number | null;
  morphWall: number | null;
  seen: Record<string, number>;
  hits: number;
  outcome: string | null;
  standOff: number;
  /** The ship's shot mode and speed, "normal/speed_normal" until a power-up. */
  shot?: string;
  sp?: number;
  items?: number;
  /** Each kind's last appearance before the morph: step, wall ms, boss HP. */
  preMorph?: Record<string, { step: number; wall: number; hp: number }>;
}
