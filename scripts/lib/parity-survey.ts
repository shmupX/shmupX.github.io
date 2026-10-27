// The parity testdrive's SURVEY: per-object telemetry sampled from a pane
// while it plays a stage from its start, so two targets can be compared object
// by object rather than clip by clip — which enemy came on at which scroll
// position, what it fired, what its bullets were drawn with, how long it lived.
//
// Two samplers, both page code installed beside the pane's pilot and polled
// at `periodMs`:
//
// - the Saturn's reads the play engine's per-object arrays straight out of
//   yabause's heap (HWRAM, word-swapped — see parity-saturn.ts): the sprite
//   index every object draws with (0x0608EA90, u16 per slot — an enemy
//   bullet's is its char group, 55/59/63 for bullet types 0/1/2, FORMAT.md
//   "Shot sprites"), the two position arrays in px << 7 (lateral 0x06090040,
//   scroll axis 0x0608D400), hp (0x06095040), the attack word (0x0608C720),
//   the hit-attribute byte (0x06091550), the formation key (0x06090530 — a
//   grid-spawned enemy's PLACEMENT ID, which names its record), the status
//   word (0x06093C50) and the mode word (0x06094240); and the globals: the
//   map's scroll position (s16 0x0608D3FA, px), the px scrolled this frame
//   (0x06090A2C), the dynamic rank (0x06090A2E), lives and the play state.
//   All 256 slots: the ship is slot 2, P1's shots 4-33, P2's 34-63, the
//   option pods 64-67 / 80-83, the boss core 98, the enemy pool 99-248.
// - the web runtime's reads the Phaser scene the PROBE exposes: every enemy
//   (its record name and key, its placement id, hp, frame, scale), every
//   enemy bullet (frame, texture key, speed, heading), the items, the ship,
//   the boss, the stage's step counter and the Dezaemon scroll position.
//
// Both keep a BIRTH log — the first sample an object is seen in, with the
// nearest enemy at that moment for a bullet, so a bullet can be attributed to
// what fired it — and a tally of every distinct sprite / frame seen. The web
// sampler also flies the ship (the runtime autofires), the way the emulator
// pilot does: to random points in a box, so the two sides see comparable
// movement. Nothing here steps a frame: both panes run on their own clocks,
// and the samples carry wall time and the stage's own clock (scroll
// position, step) so a comparison lines them up by the stage, not the wall.

export interface SaturnSurveyConfig {
  ramBase: number;
  periodMs: number;
  /** Object slots scanned; the arrays hold 256. */
  slots?: number;
}

export const SATURN_SURVEY_ADDR = {
  spr: 0x0608EA90,
  x: 0x06090040,
  y: 0x0608D400,
  hp: 0x06095040,
  atk: 0x0608C720,
  attr: 0x06091550,
  key: 0x06090530,
  status: 0x06093C50,
  mode: 0x06094240,
  /** u8 per slot: bit1 ground, bit6 anchored terrain ride (FORMAT.md "Terrain ride"). */
  flags: 0x0608EF40,
  /** u16 per slot: the uniform zoom register, 0x1000 = x1 (record bytes 6-8). */
  zoom: 0x06094A40,
  scroll: 0x0608D3FA,
  scrollStep: 0x06090A2C,
  rank: 0x06090A2E,
  staticRank: 0x0608C712,
  lives: 0x06084354,
  play: 0x060840C8,
  /** u8: the boss phase byte; 3 during the entrance, nonzero while a boss is up. */
  bossPhase: 0x06084158,
} as const;

/** One sampled object on the Saturn: [slot, sprite, x, y, hp, key, attr, atk, status, mode, flags, zoom]. */
export type SaturnObj = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface SaturnSample {
  t: number;
  wall: number;
  play: number;
  lives: number;
  scroll: number;
  step: number;
  rank: number;
  /** The boss phase byte, 0 while no boss is up. */
  boss: number;
  objs: SaturnObj[];
}

export interface SaturnBirth {
  t: number;
  wall: number;
  slot: number;
  spr: number;
  x: number;
  y: number;
  hp: number;
  key: number;
  attr: number;
  atk: number;
  scroll: number;
}

export function saturnSurvey(config: SaturnSurveyConfig): string {
  return `(function (cfg) {
  if (window.__survey) return "already";
  var M = EJS_emulator.Module;
  var A = ${JSON.stringify(SATURN_SURVEY_ADDR)};
  var N = cfg.slots || 256;
  function b(a) { return M.HEAPU8[cfg.ramBase + ((a - 0x06000000) ^ 1)]; }
  function w(a) { return (b(a) << 8) | b(a + 1); }
  function s16(a) { var v = w(a); return v & 0x8000 ? v - 0x10000 : v; }
  function u32(a) { return w(a) * 65536 + w(a + 2); }
  function s32(a) { var v = u32(a); return v >= 0x80000000 ? v - 0x100000000 : v; }
  var S = window.__survey = { on: false, t0: null, n: 0, samples: [], births: [], kinds: {}, prev: [], maxObjs: 0, err: null };
  for (var i = 0; i < N; i++) S.prev.push(0);
  function tick() {
    if (!S.on) return;
    var now = Date.now();
    if (S.t0 === null) S.t0 = now;
    var scroll = s16(A.scroll);
    var objs = [];
    for (var s = 0; s < N; s++) {
      var spr = w(A.spr + s * 2);
      var hp = s32(A.hp + s * 4);
      var key = b(A.key + s);
      if (spr === 0 && hp === 0 && key === 0) { S.prev[s] = 0; continue; }
      var x = s32(A.x + s * 4) / 128, y = s32(A.y + s * 4) / 128;
      var attr = b(A.attr + s), atk = s32(A.atk + s * 4);
      objs.push([s, spr, Math.round(x * 10) / 10, Math.round(y * 10) / 10, hp, key, attr, atk, w(A.status + s * 2), w(A.mode + s * 2), b(A.flags + s), w(A.zoom + s * 2)]);
      if (S.prev[s] !== spr) {
        S.prev[s] = spr;
        S.births.push({ t: now - S.t0, wall: now, slot: s, spr: spr, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, hp: hp, key: key, attr: attr, atk: atk, scroll: scroll });
        var k = "spr" + spr;
        S.kinds[k] = (S.kinds[k] || 0) + 1;
      }
    }
    if (objs.length > S.maxObjs) S.maxObjs = objs.length;
    S.samples.push({ t: now - S.t0, wall: now, play: b(A.play), lives: b(A.lives), scroll: scroll, step: s16(A.scrollStep), rank: b(A.rank), boss: b(A.bossPhase), objs: objs });
    S.n++;
  }
  S.timer = setInterval(function () { try { tick(); } catch (e) { S.err = String(e && e.stack || e); } }, cfg.periodMs);
  S.stop = function () { clearInterval(S.timer); };
  return "installed";
})(${JSON.stringify(config)})`;
}

export interface WebSurveyConfig {
  periodMs: number;
  /** Where the ship is flown, in the runtime's 256x480 field; null leaves it. */
  box: { x0: number; x1: number; y0: number; y1: number } | null;
  seed?: number;
}

export interface WebObj {
  id: number;
  kind: "enemy" | "boss" | "part" | "bullet" | "item";
  name?: string | null;
  key?: string | null;
  deza?: number | null;
  x: number;
  y: number;
  hp?: number;
  frame: string | null;
  tex?: string | null;
  sx?: number;
  sy?: number;
  spd?: number;
  rx?: number;
  ry?: number;
}

export interface WebSample {
  t: number;
  wall: number;
  step: number;
  scroll: number | null;
  score: number;
  player: {
    x: number;
    y: number;
    hp: number;
    shot: string;
    dead: boolean;
  } | null;
  boss: { hp: number; max: number } | null;
  objs: WebObj[];
}

export interface WebBirth {
  t: number;
  wall: number;
  kind: WebObj["kind"];
  id: number;
  name?: string | null;
  key?: string | null;
  deza?: number | null;
  x: number;
  y: number;
  hp?: number;
  frame: string | null;
  tex?: string | null;
  proj?: string[] | null;
  spd?: number;
  rx?: number;
  ry?: number;
  /** For a bullet: the nearest enemy when it was first seen. */
  from?: {
    id: number;
    name: string | null;
    key: string | null;
    deza: number | null;
    kind: string;
    dist: number;
  } | null;
  scroll: number | null;
  step: number;
}

export function webSurvey(config: WebSurveyConfig): string {
  return `(function (cfg) {
  if (window.__survey) return "already";
  var dbg = window.__dbg;
  var S = window.__survey = { on: false, t0: null, n: 0, samples: [], births: [], kinds: {}, maxObjs: 0, ended: null, err: null };
  var ids = new WeakMap(), nextId = 1, seen = {};
  function idOf(o) { var i = ids.get(o); if (!i) { i = nextId++; ids.set(o, i); } return i; }
  function frameName(o) { return (o.frame && o.frame.name) || null; }
  function texOf(pd) { if (!pd || !pd.texture) return null; return Array.isArray(pd.texture) ? pd.texture.slice(0, 8) : [String(pd.texture)]; }
  function data(o, k) { return o.getData ? o.getData(k) : undefined; }
  var held = {};
  function hold(i, on) { if (!!held[i] === !!on) return; held[i] = !!on; dbg.setButtons([i], on); }
  var seed = cfg.seed || 7;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  var tx = 128, ty = 400, vtimer = 0;
  function tick() {
    if (!S.on) return;
    var g = dbg.game();
    if (!g || !g.scene || !g.scene.isActive("PhaserGameScene")) return;
    var sc = g.scene.getScene("PhaserGameScene");
    if (!sc.gameStarted) {
      if (S.t0 !== null && (sc.stageCleared || sc._runEnded)) S.ended = sc.stageCleared ? "cleared" : "ended";
      return;
    }
    var now = Date.now();
    if (S.t0 === null) S.t0 = now;
    var scroll = sc.dezaBg ? sc.dezaBg.scrollPos : null;
    var step = sc.frameCnt;
    var p = sc.players && sc.players[0];
    var objs = [], foes = [];
    var en = sc.enemies || [];
    for (var i = 0; i < en.length; i++) {
      var o = en[i];
      if (!o || !o.active) continue;
      var id = idOf(o);
      var rec = { id: id, kind: o === sc.bossSprite ? "boss" : (data(o, "dezaBossPart") ? "part" : "enemy"),
        name: data(o, "name") || null, key: data(o, "enemyKey") || null, deza: data(o, "dezaKey"),
        x: Math.round(o.x * 10) / 10, y: Math.round(o.y * 10) / 10, hp: data(o, "hp"), frame: frameName(o),
        sx: Math.round(o.scaleX * 100) / 100, sy: Math.round(o.scaleY * 100) / 100 };
      if (rec.deza === undefined) rec.deza = null;
      objs.push(rec); foes.push(rec);
      if (!seen[id]) {
        seen[id] = 1;
        S.births.push({ t: now - S.t0, wall: now, kind: rec.kind, id: id, name: rec.name, key: rec.key, deza: rec.deza,
          x: rec.x, y: rec.y, hp: rec.hp, frame: rec.frame, proj: texOf(data(o, "projData")), scroll: scroll, step: step });
      }
    }
    var eb = sc.enemyBullets || [];
    for (var j = 0; j < eb.length; j++) {
      var bl = eb[j];
      if (!bl || !bl.active) continue;
      var bid = idOf(bl);
      var fr = frameName(bl), tex = bl.texture ? bl.texture.key : null;
      var brec = { id: bid, kind: "bullet", x: Math.round(bl.x * 10) / 10, y: Math.round(bl.y * 10) / 10, frame: fr, tex: tex,
        spd: data(bl, "speed"), rx: data(bl, "rotX"), ry: data(bl, "rotY") };
      objs.push(brec);
      if (!seen[bid]) {
        seen[bid] = 1;
        var best = null, bd = 1e12;
        for (var k = 0; k < foes.length; k++) {
          var f = foes[k], d = (f.x - bl.x) * (f.x - bl.x) + (f.y - bl.y) * (f.y - bl.y);
          if (d < bd) { bd = d; best = f; }
        }
        S.births.push({ t: now - S.t0, wall: now, kind: "bullet", id: bid, frame: fr, tex: tex, x: brec.x, y: brec.y,
          spd: brec.spd, rx: brec.rx, ry: brec.ry,
          from: best ? { id: best.id, name: best.name, key: best.key, deza: best.deza, kind: best.kind, dist: Math.round(Math.sqrt(bd)) } : null,
          scroll: scroll, step: step });
        var kk = (tex && tex !== "game_asset" ? tex + ":" : "") + fr;
        S.kinds[kk] = (S.kinds[kk] || 0) + 1;
      }
    }
    var items = sc.items || [];
    for (var m = 0; m < items.length; m++) {
      var it = items[m];
      if (!it || !it.active) continue;
      var iid = idOf(it);
      var irec = { id: iid, kind: "item", name: data(it, "itemName") || null, x: Math.round(it.x), y: Math.round(it.y), frame: frameName(it) };
      objs.push(irec);
      if (!seen[iid]) { seen[iid] = 1; S.births.push({ t: now - S.t0, wall: now, kind: "item", id: iid, name: irec.name, x: irec.x, y: irec.y, frame: irec.frame, scroll: scroll, step: step }); }
    }
    if (objs.length > S.maxObjs) S.maxObjs = objs.length;
    S.samples.push({ t: now - S.t0, wall: now, step: step, scroll: scroll, score: sc.scoreCount || 0,
      player: p ? { x: Math.round(p.unitX), y: Math.round(p.sprite ? p.sprite.y : p.unitY), hp: p.hp,
        shot: (p.shootMode || sc.shootMode) + "/" + (p.shootSpeed || sc.shootSpeed), dead: !!p.dead } : null,
      boss: sc.bossActive ? { hp: sc.bossHp, max: sc.bossMaxHp } : null, objs: objs });
    S.n++;
    if (p && cfg.box) {
      if (--vtimer <= 0) {
        tx = cfg.box.x0 + rnd() * (cfg.box.x1 - cfg.box.x0);
        ty = cfg.box.y0 + rnd() * (cfg.box.y1 - cfg.box.y0);
        vtimer = 5 + Math.floor(rnd() * 8);
      }
      var px = p.unitX, py = p.sprite ? p.sprite.y : p.unitY;
      hold(14, px > tx + 4); hold(15, px < tx - 4); hold(12, py > ty + 4); hold(13, py < ty - 4);
    }
  }
  S.timer = setInterval(function () { try { tick(); } catch (e) { S.err = String(e && e.stack || e); } }, cfg.periodMs);
  S.stop = function () { clearInterval(S.timer); for (var k in held) if (held[k]) dbg.setButtons([Number(k)], false); held = {}; };
  return "installed";
})(${JSON.stringify(config)})`;
}

/** Stop the sampler and hand everything it kept over. */
export const SURVEY_DUMP = `(function () {
  var S = window.__survey;
  if (!S) return null;
  if (S.stop) S.stop();
  return { n: S.n, t0: S.t0, err: S.err, kinds: S.kinds, maxObjs: S.maxObjs, ended: S.ended || null, births: S.births, samples: S.samples };
})()`;

export interface SurveyDump<B, S> {
  n: number;
  t0: number | null;
  err: string | null;
  kinds: Record<string, number>;
  maxObjs: number;
  ended: string | null;
  births: B[];
  samples: S[];
}

/** The short form of a survey for report.json: how much was seen, of what. */
export function surveySummary(
  dump: SurveyDump<unknown, { t: number }> | null,
): Record<string, unknown> | null {
  if (!dump) return null;
  const kinds = Object.entries(dump.kinds).sort((a, b) => b[1] - a[1]);
  return {
    samples: dump.n,
    seconds: dump.samples.length
      ? +(dump.samples[dump.samples.length - 1].t / 1000).toFixed(1)
      : 0,
    births: dump.births.length,
    maxLiveObjects: dump.maxObjs,
    kinds: Object.fromEntries(kinds.slice(0, 40)),
    kindCount: kinds.length,
    ended: dump.ended,
    err: dump.err,
  };
}

/**
 * The PS2 build in the browser (lib/ps2/web-host.ts): the port's game scene
 * through `__PS2_GS__()`, sampled the same way. The port keeps its objects as
 * plain records, so what is read is whatever names them — `frames` on a
 * projectile, the enemy row's letter and name where the scene carries them —
 * and the first object of each kind is kept whole (`shapes`) so a sample can
 * be read back against the port's own field names.
 */
export function ps2Survey(config: WebSurveyConfig): string {
  return `(function (cfg) {
  if (window.__survey) return "already";
  var S = window.__survey = { on: false, t0: null, n: 0, samples: [], births: [], kinds: {}, maxObjs: 0, ended: null, err: null, shapes: {} };
  var ids = new WeakMap(), nextId = 1, seen = {};
  function idOf(o) { var i = ids.get(o); if (!i) { i = nextId++; ids.set(o, i); } return i; }
  // Only strings and numbers leave the page: a port object's \`frame\` or
  // \`texture\` can be a record of its own (or reach back into the scene),
  // and a dump that carries those is too big to come back over DevTools.
  function str(v) { if (v === undefined || v === null) return null; if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v; if (typeof v === "object") return (typeof v.name === "string" ? v.name : typeof v.key === "string" ? v.key : null); return null; }
  function pick(o, names) { for (var i = 0; i < names.length; i++) { var v = str(o[names[i]]); if (v !== null) return v; } return null; }
  function shape(kind, o) { if (S.shapes[kind]) return; var out = {}; for (var k in o) { var v = o[k]; var t = typeof v; if (t === "number" || t === "string" || t === "boolean") out[k] = v; else if (Array.isArray(v)) out[k] = "[" + v.length + "]"; else if (v && t === "object") out[k] = "{" + Object.keys(v).slice(0, 8).join(",") + "}"; } S.shapes[kind] = out; }
  var seed = cfg.seed || 7;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  var tx = 128, ty = 400, vtimer = 0, held = 0;
  function tick() {
    if (!S.on) return;
    var ctx = window.__PS2_CTX__, gs = window.__PS2_GS__ && __PS2_GS__();
    if (!ctx || !gs || ctx.scenes.current !== "game" || !gs.player) {
      if (S.t0 !== null && ctx && ctx.scenes.current !== "game") S.ended = ctx.scenes.current;
      return;
    }
    var now = Date.now();
    if (S.t0 === null) S.t0 = now;
    var p = gs.player;
    var objs = [], foes = [];
    (gs.enemies || []).forEach(function (e) {
      if (!e || e.dead) return;
      var id = idOf(e);
      shape("enemy", e);
      var rec = { id: id, kind: "enemy", name: pick(e, ["name", "enemyName", "enemyKey", "key", "type"]), key: pick(e, ["enemyKey", "key", "letter"]), deza: pick(e, ["placementId", "dezaKey"]),
        x: Math.round(e.x * 10) / 10, y: Math.round(e.y * 10) / 10, hp: str(e.hp), frame: str(e.frames && e.frames[0]) || pick(e, ["frame", "texture", "img"]) };
      objs.push(rec); foes.push(rec);
      if (!seen[id]) { seen[id] = 1; var pd = e.bulletData || e.projData || null; var pt = pd && pd.texture; S.births.push({ t: now - S.t0, wall: now, kind: "enemy", id: id, name: rec.name, key: rec.key, deza: rec.deza, x: rec.x, y: rec.y, hp: rec.hp, frame: rec.frame, proj: Array.isArray(pt) ? pt.slice(0, 4).map(str) : str(pt), scroll: str(gs.scrollPos), step: str(gs.frameCnt) }); }
    });
    if (gs.boss && !gs.boss.dead) { var bid0 = idOf(gs.boss); shape("boss", gs.boss); objs.push({ id: bid0, kind: "boss", x: str(gs.boss.x), y: str(gs.boss.y), hp: str(gs.boss.hp), frame: null }); if (!seen[bid0]) { seen[bid0] = 1; S.births.push({ t: now - S.t0, wall: now, kind: "boss", id: bid0, x: str(gs.boss.x), y: str(gs.boss.y), hp: str(gs.boss.hp), frame: null, scroll: null, step: str(gs.frameCnt) }); } }
    (gs.projectiles || []).forEach(function (b) {
      if (!b || b.dead) return;
      var bid = idOf(b);
      shape("projectile", b);
      var fr = str(b.frames && b.frames[0]) || pick(b, ["frame", "texture", "img"]) || null;
      var brec = { id: bid, kind: "bullet", x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, frame: fr, spd: pick(b, ["speed"]), rx: pick(b, ["rotX", "vx", "dx"]), ry: pick(b, ["rotY", "vy", "dy"]) };
      objs.push(brec);
      if (!seen[bid]) {
        seen[bid] = 1;
        var best = null, bd = 1e12;
        for (var k = 0; k < foes.length; k++) { var f = foes[k], d = (f.x - b.x) * (f.x - b.x) + (f.y - b.y) * (f.y - b.y); if (d < bd) { bd = d; best = f; } }
        S.births.push({ t: now - S.t0, wall: now, kind: "bullet", id: bid, frame: fr, x: brec.x, y: brec.y, spd: brec.spd, rx: brec.rx, ry: brec.ry, from: best ? { id: best.id, name: best.name, key: best.key, deza: best.deza, kind: "enemy", dist: Math.round(Math.sqrt(bd)) } : null, scroll: null, step: str(gs.frameCnt) });
        var kk = String(fr); S.kinds[kk] = (S.kinds[kk] || 0) + 1;
      }
    });
    (gs.items || []).forEach(function (it) {
      if (!it || it.dead) return;
      var iid = idOf(it);
      shape("item", it);
      var irec = { id: iid, kind: "item", name: pick(it, ["itemName", "name", "type"]), x: Math.round(it.x), y: Math.round(it.y), frame: str(it.frames && it.frames[0]) };
      objs.push(irec);
      if (!seen[iid]) { seen[iid] = 1; S.births.push({ t: now - S.t0, wall: now, kind: "item", id: iid, name: irec.name, x: irec.x, y: irec.y, frame: irec.frame, scroll: null, step: str(gs.frameCnt) }); }
    });
    if (objs.length > S.maxObjs) S.maxObjs = objs.length;
    // At TURBO the port can hold hundreds of objects a sample; a sample keeps
    // the first 600 and says how many there were, so a minute's dump stays
    // a few tens of MB (every birth is still logged).
    var objsTotal = objs.length;
    if (objsTotal > 600) objs = objs.slice(0, 600);
    S.samples.push({ t: now - S.t0, wall: now, step: str(gs.frameCnt), scroll: str(gs.scrollPos), score: str(ctx.state.score) || 0, objsTotal: objsTotal,
      player: { x: Math.round(p.x), y: Math.round(p.y), hp: str(p.hp), shot: String(pick(p, ["shootMode", "shotName", "weapon"])) + "/" + String(pick(p, ["shootSpeed", "shotSpeed"])), dead: !!p.dead },
      boss: gs.boss && !gs.boss.dead ? { hp: str(gs.boss.hp), max: str(gs.boss.maxHp) } : null, objs: objs });
    S.n++;
    if (cfg.box && window.__PS2_PADS__) {
      if (--vtimer <= 0) { tx = cfg.box.x0 + rnd() * (cfg.box.x1 - cfg.box.x0); ty = cfg.box.y0 + rnd() * (cfg.box.y1 - cfg.box.y0); vtimer = 5 + Math.floor(rnd() * 8); }
      var B = __PS2_PADS__.BUTTONS, mask = 0;
      if (p.x > tx + 4) mask |= B.LEFT; if (p.x < tx - 4) mask |= B.RIGHT; if (p.y > ty + 4) mask |= B.UP; if (p.y < ty - 4) mask |= B.DOWN;
      if (mask !== held) { held = mask; if (mask) __PS2_PADS__.set(mask); else __PS2_PADS__.clear(); }
    }
  }
  S.timer = setInterval(function () { try { tick(); } catch (e) { S.err = String(e && e.stack || e); } }, cfg.periodMs);
  S.stop = function () { clearInterval(S.timer); if (window.__PS2_PADS__) __PS2_PADS__.clear(); };
  return "installed";
})(${JSON.stringify(config)})`;
}

/** SURVEY_DUMP, plus the shapes a PS2 survey kept. */
export const PS2_SURVEY_DUMP = `(function () {
  var S = window.__survey;
  if (!S) return null;
  if (S.stop) S.stop();
  return { n: S.n, t0: S.t0, err: S.err, kinds: S.kinds, maxObjs: S.maxObjs, ended: S.ended || null, shapes: S.shapes, births: S.births, samples: S.samples };
})()`;
