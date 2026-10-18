/**
 * The in-page halves of `deno task refresh:compare` (scripts/refresh-compare.ts):
 * the emulated display's clock and side-by-side composite (pageSetup), and the
 * frame meter both kinds of run read their numbers from (meterSetup).
 */

import { CADENCE_JS } from "./refresh-metrics.ts";

/**
 * Where a position lands on the game's own 256×480 pixel grid, the way the
 * renderer puts it there. `pixelArt: true` turns on Phaser's roundPixels: the
 * canvas renderer floors a sprite's x and y; WebGL rounds the corners of any
 * sprite that is only translated (vertexRoundMode "safeAuto") and leaves a
 * rotated or scaled one where it is; a tile sprite's scroll is sampled
 * nearest-texel, so a fraction of a texel never shows. The canvas is then
 * scaled up whole, so no finer step than this ever reaches the screen.
 */
const PIXELS_JS = `
  var pxRound = true, pxWebgl = false;
  function pixelMode(game, scene) {
    var cam = scene.cameras && scene.cameras.main;
    pxRound = cam && typeof cam.renderRoundPixels === "boolean"
      ? cam.renderRoundPixels : !!(game.config && game.config.roundPixels);
    pxWebgl = !!(game.renderer && game.renderer.type === 2);
  }
  function pixelSnap(o, v, origin) {
    if (!pxRound) return v;
    if (!pxWebgl) return Math.floor(v);
    if (o.rotation || o.scaleX !== 1 || o.scaleY !== 1) return v;
    return Math.round(v - (origin || 0));
  }
  function pixelX(o, v) { return pixelSnap(o, v, o.displayOriginX); }
  function pixelY(o, v) { return pixelSnap(o, v, o.displayOriginY); }
`;

/**
 * The in-page half: seeds Math.random, parks the probe's clock at the
 * display rate, and defines __rfFrame(level), which steps one display frame
 * and reports on it — level 0 nothing, 1 every object's drawn and logic
 * positions, 2 that plus both halves composited.
 */
export function pageSetup(hz: number, seed: number): string {
  return `
(function () {
  ${PIXELS_JS}
  function prng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  Math.random = prng(${seed});
  var dbg = window.__dbg;
  dbg.paused = true;
  // The emulated display's clock, exact in binary: a whole-millisecond start
  // and 1000/hz rounded up to 2^-10 ms (240 Hz becomes 239.98). Phaser takes
  // each frame's delta as this time minus the last; with an arbitrary start
  // that subtraction rounds differently on every run, and a timer due on
  // exactly a frame boundary (the stage card's 2500 ms is frame 600 at
  // 240 Hz) lands a frame early on some runs and on time on others.
  dbg.t = Math.round(dbg.t);
  dbg.dt = Math.ceil((1000 / ${hz}) * 1024) / 1024;
  // Phaser's tweens are timed by Date.now(), not by the frame's delta, so the
  // wall clock has to be the display's too: otherwise every tween runs at the
  // speed this page happens to be stepped at. Epoch plus display time stays
  // exact at 2^-10 ms granularity until the year 2248.
  var epoch = Math.round(Date.now() - dbg.t);
  Date.now = function () { return epoch + dbg.t; };
  var c = window.__rfCompare = {
    hz: ${hz}, ids: new WeakMap(), next: 1, side: prng(${seed} ^ 0x5bd1e995),
    canvas: null, ctx: null, scratch: null, prev: [null, null],
    drive: false, driveFrame: 0, hooked: false, stage: null,
    // The ship sweeps side to side on the pad once the stage is up, so the
    // player's own motion is in the comparison too, not only the waves'.
    sweep: false, sweepFrame: 0,
  };
  // Into the stage. While driving, START is tapped on the pad four times a
  // second, which steps through the title and the story. Everything after is
  // timed from the stage scene's own start, not from when the harness saw it:
  // the random stream is reseeded the moment the scene starts (before its
  // create), START comes up, and stage frames are counted from its create.
  // The handoff runs on a real-time setTimeout, so this is what lets two runs
  // line up frame for frame.
  var BTN_START = 9;
  window.__rfDrive = function () { c.drive = true; c.driveFrame = 0; };
  function hookStage(g) {
    if (c.hooked) return;
    var gs = g.scene.getScene("PhaserGameScene");
    if (!gs) return;
    c.hooked = true;
    gs.events.on("start", function () {
      if (!c.drive) return;
      c.drive = false;
      dbg.setButtons([BTN_START], false);
      Math.random = prng(${seed});
    });
    gs.events.on("create", function () {
      if (c.stage !== null) return;
      c.stage = 0;
      c.sweep = true;
      c.sweepFrame = 0;
    });
  }
  function idOf(o) {
    var id = c.ids.get(o);
    if (!id) { id = String(c.next++); c.ids.set(o, id); }
    return id;
  }
  function steppedScene(g) {
    var keys = ["PhaserGameScene", "PhaserTitleScene"];
    for (var i = 0; i < keys.length; i++) {
      var s = g.scene.getScene(keys[i]);
      if (s && s.sys.settings.active) return s;
    }
    return null;
  }
  function differs(a, b) {
    if (!b) return true;
    for (var i = 0; i < a.length; i += 4) {
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) return true;
    }
    return false;
  }
  window.__rfFrame = function (level) {
    if (c.drive) {
      var beat = c.driveFrame++ % Math.round(c.hz / 4);
      if (beat === 0) dbg.setButtons([BTN_START], true);
      if (beat === 3) dbg.setButtons([BTN_START], false);
    }
    if (c.sweep) {
      var leg = Math.floor(c.sweepFrame++ / Math.round(c.hz * 0.6));
      dbg.setAxes([leg % 2 ? -1 : 1, 0]);
    }
    dbg.stepOnce();
    if (c.stage !== null) c.stage++;
    var g = window.__PHASER_4_GAME__;
    if (!g || !g.canvas) return { frame: dbg.frame, scene: null, stage: null };
    hookStage(g);
    var scene = steppedScene(g);
    var ri = scene && scene._refresh;
    var key = scene ? scene.sys.settings.key : null;
    var on = !!(ri && ri.on);
    if (!level) return { frame: dbg.frame, scene: key, on: on, stage: c.stage };
    // What the blend moved, and where the logic has it.
    var d = ri ? ri.drawn : [];
    var logic = new Map(), tiles = new Map();
    for (var i = 0; i < d.length; i += 6) {
      (d[i + 1] ? tiles : logic).set(d[i], [d[i + 2], d[i + 3]]);
    }
    var objs = [];
    var list = scene ? scene.children.list : [];
    if (scene) pixelMode(g, scene);
    for (var j = 0; j < list.length; j++) {
      var o = list[j];
      if (!o.visible || typeof o.x !== "number") continue;
      var id = idOf(o);
      var l = logic.get(o);
      var lx = l ? l[0] : o.x, ly = l ? l[1] : o.y;
      var what = (o.texture ? o.texture.key : o.type) +
        (o.frame && o.frame.name != null ? ":" + o.frame.name : "");
      objs.push([id, o.x, o.y, lx, ly, what,
        pixelX(o, o.x), pixelY(o, o.y), pixelX(o, lx), pixelY(o, ly)]);
      if (typeof o.tilePositionX === "number") {
        var lt = tiles.get(o);
        var tx = lt ? lt[0] : o.tilePositionX, ty = lt ? lt[1] : o.tilePositionY;
        objs.push(["t" + id, o.tilePositionX, o.tilePositionY, tx, ty, what + " (tile)",
          Math.floor(o.tilePositionX), Math.floor(o.tilePositionY),
          Math.floor(tx), Math.floor(ty)]);
      }
    }
    var gc = g.canvas, W = gc.width, H = gc.height, HEAD = 46, GAP = 8;
    if (level === 1) {
      return { frame: dbg.frame, scene: key, on: on, stage: c.stage, objs: objs };
    }
    if (!c.canvas) {
      c.canvas = document.createElement("canvas");
      c.canvas.width = W * 2 + GAP;
      c.canvas.height = H + HEAD;
      c.ctx = c.canvas.getContext("2d", { willReadFrequently: true });
      c.ctx.imageSmoothingEnabled = false;
    }
    var ctx = c.ctx;
    // The right half: this frame as max refresh drew it.
    ctx.drawImage(gc, W + GAP, HEAD);
    // The left half: the same state drawn the stock way, at the logic's
    // positions, on a random stream of its own.
    function put(which) {
      for (var k = 0; k < d.length; k += 6) {
        var ob = d[k], vx = d[k + which], vy = d[k + which + 1];
        if (d[k + 1]) { ob.tilePositionX = vx; ob.tilePositionY = vy; }
        else { ob.x = vx; ob.y = vy; }
      }
    }
    put(2);
    var r = g.renderer, rand = Math.random;
    Math.random = c.side;
    try { r.preRender(); g.scene.render(r); r.postRender(); }
    finally { Math.random = rand; }
    ctx.drawImage(gc, 0, HEAD);
    put(4);
    var halves = [ctx.getImageData(0, HEAD, W, H).data, ctx.getImageData(W + GAP, HEAD, W, H).data];
    var changed = [differs(halves[0], c.prev[0]), differs(halves[1], c.prev[1])];
    c.prev = halves;
    // Labels.
    ctx.fillStyle = "#101018";
    ctx.fillRect(0, 0, c.canvas.width, HEAD);
    ctx.fillRect(W, HEAD, GAP, H);
    ctx.textBaseline = "top";
    var hz = c.hz;
    var label = function (x, title, line, color) {
      ctx.fillStyle = color;
      ctx.font = "bold 15px sans-serif";
      ctx.fillText(title, x + 6, 5);
      ctx.fillStyle = "#c8c8d8";
      ctx.font = "11px sans-serif";
      ctx.fillText(line, x + 6, 26);
    };
    label(0, "STOCK", "each 120 Hz step drawn " + (hz / 120).toFixed(1) + "x", "#ffb000");
    label(W + GAP, "MAX REFRESH", "motion drawn every " + hz + " Hz frame", "#38e070");
    ctx.fillStyle = "#6a6a80";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    ctx.fillText(hz + " Hz  f" + dbg.frame, c.canvas.width - 6, 8);
    ctx.textAlign = "left";
    return {
      frame: dbg.frame, scene: key, on: on, stage: c.stage, objs: objs, changed: changed,
      png: c.canvas.toDataURL("image/png"),
    };
  };
  return "ok";
})();
`;
}

export interface MeterOptions {
  /**
   * A real display: the meter drives the game itself (its own pad, START
   * through the title and the story, the ship's sweep) and records the
   * stock and tested modes in alternating slices once the stage is warm.
   * Otherwise the harness says when to record (`__rfMeter.record(tag)`).
   */
  live: boolean;
  /** The mode under test: "auto", what players get, or "max". */
  mode: "auto" | "max";
  /** Seconds of the stage before recording starts (live). */
  warmup: number;
  /** Seconds to record of each mode (live). */
  seconds: number;
  /** Seconds per slice before switching mode (live). */
  slice: number;
}

/**
 * The frame meter, `window.__rfMeter`: hooked onto the game's own loop
 * events, it times every frame (the interval since the last one, by the
 * frame's own timestamp, and the main-thread work: the update from 'prestep'
 * to 'prerender', the draw from there to 'postrender'), counts the fixed
 * steps it ran, and notes whether it was drawn blended. Chrome rounds
 * performance.now() to 0.1 ms on a page like this one, so single frames are
 * coarse and the means over thousands of them are what to read. A live run also tallies motion cadence here, frame by
 * frame, with CADENCE_JS (its sampling time is left out of the work).
 *
 * A live run switches mode on the scene's own refresh state
 * (`scene._refresh.mode`, which `?refresh=` only sets the start of), so the
 * two modes take turns over the same stretch of the same stage, on the same
 * machine as warm as it is going to get, a slice at a time.
 */
export function meterSetup(opts: MeterOptions): string {
  return `
(function () {
  ${CADENCE_JS}
  ${PIXELS_JS}
  var opts = ${JSON.stringify(opts)};
  function run() {
    return {
      interval: [], work: [], update: [], draw: [], steps: [], on: [], elapsed: 0,
      cadence: null,
    };
  }
  var m = window.__rfMeter = {
    phase: opts.live ? "boot" : "idle",
    error: null,
    tag: null,
    frame: 0,
    stageAt: null,
    // Display frames per 120 Hz step, measured in the warmup (CADENCE_JS).
    span: null,
    runs: { stock: run(), max: run() },
  };
  var warm = [];
  var game = null, gs = null, lastT = null, interval = 0, steps = 0;
  var t0 = 0, tPre = 0, tDraw = 0;
  var sliceAt = 0, slices = 0, sweep = false, pad = null;
  var ORDER = ["stock", "max", "max", "stock"];

  // A live page's own pad. Its id must not end in "[R]": cmgSplitTwoPlayer
  // reads that as a split controller's right half and adds a second ship.
  if (opts.live) {
    var buttons = [];
    for (var i = 0; i < 17; i++) buttons.push({ pressed: false, touched: false, value: 0 });
    pad = {
      id: "shmupX refresh meter (Vendor: 0000 Product: 0000)", index: 0,
      connected: true, mapping: "standard", timestamp: 0, axes: [0, 0, 0, 0],
      buttons: buttons,
    };
    navigator.getGamepads = function () { return [pad]; };
    try {
      var ev = new Event("gamepadconnected");
      ev.gamepad = pad;
      window.dispatchEvent(ev);
    } catch (e) {}
  }
  function startButton(down) {
    var b = pad.buttons[9];
    b.pressed = b.touched = !!down;
    b.value = down ? 1 : 0;
    pad.timestamp = performance.now();
  }
  // The mode this frame is drawn in.
  function apply() {
    var ri = gs && gs._refresh;
    if (!ri) return;
    var want = m.tag === "stock" ? "stock" : opts.mode;
    if (ri.mode === want) return;
    ri.mode = want;
    if (want === "stock") ri.on = false;
    if (want === "max") ri.on = true;
  }
  function finish(error) {
    m.tag = null;
    m.phase = "done";
    m.error = error;
    sweep = false;
    pad.axes[0] = 0;
    apply();
  }
  function drive(now) {
    if (m.phase === "boot") {
      // START four times a second steps through the title and the story.
      startButton(now % 250 < 60);
    } else if (m.phase === "warmup") {
      if (interval > 0 && warm.length < 4000) warm.push(interval);
      if (now - m.stageAt >= opts.warmup * 1000) {
        var sorted = warm.slice().sort(function (a, b) { return a - b; });
        var hz = sorted.length ? 1000 / sorted[sorted.length >> 1] : 60;
        m.span = Math.max(2, Math.ceil(hz / 120 - 0.01));
        m.runs.stock.cadence = cadenceMeter(m.span);
        m.runs.max.cadence = cadenceMeter(m.span);
        m.phase = "recording";
        m.tag = "stock";
        sliceAt = now;
      }
    } else if (m.phase === "recording") {
      if (!gs.sys.settings.active) {
        finish("the stage ended " + ((now - m.stageAt) / 1000).toFixed(1) + " s in");
        return;
      }
      var need = opts.seconds * 1000;
      var left = function (tag) { return m.runs[tag].elapsed < need; };
      if (!left("stock") && !left("max")) {
        finish(null);
      } else if (now - sliceAt >= opts.slice * 1000 || !left(m.tag)) {
        // Turns go stock, max, max, stock and round again, so a stage that
        // gets busier (or a machine that warms up) as it goes weighs on both
        // modes alike rather than always on whichever goes second.
        var next = ORDER[++slices % 4];
        if (!left(next)) next = next === "stock" ? "max" : "stock";
        m.tag = next;
        sliceAt = now;
      }
    }
    if (sweep) {
      pad.axes[0] = Math.floor((now - m.stageAt) / 600) % 2 ? -1 : 1;
      pad.timestamp = now;
    }
    apply();
  }
  // Every body on screen, at the position it is drawn at and the one the
  // logic has it at (the blend's own record of what it moved).
  function sample(cad, n) {
    var ri = gs._refresh, d = ri ? ri.drawn : null, i, o;
    if (d) {
      for (i = 0; i < d.length; i += 6) {
        o = d[i];
        if (d[i + 1]) { o._rcTileAt = n; o._rcTlx = d[i + 2]; o._rcTly = d[i + 3]; }
        else { o._rcAt = n; o._rcLx = d[i + 2]; o._rcLy = d[i + 3]; }
      }
    }
    cad.frame(n);
    pixelMode(game, gs);
    var list = gs.children.list;
    for (i = 0; i < list.length; i++) {
      o = list[i];
      if (!o.visible || typeof o.x !== "number") continue;
      var b = o._rcAt === n;
      var lx = b ? o._rcLx : o.x, ly = b ? o._rcLy : o.y;
      cad.body(o, o.x, o.y, lx, ly,
        pixelX(o, o.x), pixelY(o, o.y), pixelX(o, lx), pixelY(o, ly));
      if (typeof o.tilePositionX === "number") {
        var bt = o._rcTileAt === n;
        var tx = bt ? o._rcTlx : o.tilePositionX, ty = bt ? o._rcTly : o.tilePositionY;
        cad.body(o._rcTile || (o._rcTile = {}), o.tilePositionX, o.tilePositionY, tx, ty,
          Math.floor(o.tilePositionX), Math.floor(o.tilePositionY), Math.floor(tx), Math.floor(ty));
      }
    }
  }
  function hook(g) {
    game = g;
    gs = g.scene.getScene("PhaserGameScene");
    var fixed = gs.fixedUpdate;
    gs.fixedUpdate = function () {
      steps++;
      return fixed.apply(this, arguments);
    };
    gs.events.on("start", function () {
      if (m.phase !== "boot") return;
      startButton(false);
      m.phase = "loading";
    });
    gs.events.on("create", function () {
      if (m.stageAt !== null) return;
      m.stageAt = lastT === null ? performance.now() : lastT;
      if (opts.live) {
        m.phase = "warmup";
        sweep = true;
      }
    });
    g.events.on("prestep", function (t) {
      interval = lastT === null ? 0 : t - lastT;
      lastT = t;
      steps = 0;
      if (opts.live) drive(t);
      t0 = performance.now();
    });
    // The update is 'prestep' to 'prerender', the draw 'prerender' to
    // 'postrender'; a live run's sampling sits between the two, in neither.
    g.events.on("prerender", function () {
      tPre = performance.now();
      if (opts.live && m.tag && m.runs[m.tag].cadence && gs.sys.settings.active) {
        sample(m.runs[m.tag].cadence, m.frame);
      }
      tDraw = performance.now();
    });
    g.events.on("postrender", function () {
      var update = tPre - t0, draw = performance.now() - tDraw;
      if (m.tag) {
        var r = m.runs[m.tag], ri = gs._refresh;
        r.interval.push(interval);
        r.update.push(update);
        r.draw.push(draw);
        r.work.push(update + draw);
        r.steps.push(steps);
        r.on.push(ri && ri.on ? 1 : 0);
        r.elapsed += interval;
      }
      m.frame++;
    });
  }
  var poll = setInterval(function () {
    var g = window.__PHASER_4_GAME__;
    if (!g || !g.events || !g.scene || !g.scene.getScene) return;
    if (!g.scene.getScene("PhaserGameScene")) return;
    clearInterval(poll);
    hook(g);
  }, 20);

  m.record = function (tag) { m.tag = tag || null; };
  m.status = function () {
    return {
      phase: m.phase, error: m.error, tag: m.tag, frames: m.frame,
      stage: m.stageAt === null || lastT === null ? null : (lastT - m.stageAt) / 1000,
      recorded: { stock: m.runs.stock.elapsed / 1000, max: m.runs.max.elapsed / 1000 },
    };
  };
  m.take = function () {
    var out = { span: m.span };
    var none = { samples: 0, moved: 0, evenness: 0 };
    for (var k in m.runs) {
      var r = m.runs[k];
      out[k] = {
        interval: r.interval, work: r.work, update: r.update, draw: r.draw,
        steps: r.steps, on: r.on,
        cadence: r.cadence ? r.cadence.result() : [none, none, none, none],
      };
    }
    return out;
  };
  // What this is running on, as far as a page can tell.
  m.machine = async function () {
    var g = window.__PHASER_4_GAME__;
    var info = {
      userAgent: navigator.userAgent,
      platform: null,
      browser: null,
      threads: navigator.hardwareConcurrency || null,
      memoryGb: navigator.deviceMemory || null,
      gpu: null,
      renderer: g && g.renderer ? (g.renderer.type === 2 ? "webgl" : g.renderer.type === 1 ? "canvas" : String(g.renderer.type)) : null,
      screen: { width: screen.width, height: screen.height, dpr: window.devicePixelRatio || 1 },
    };
    try {
      var gl = document.createElement("canvas").getContext("webgl");
      var ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      info.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl ? gl.getParameter(gl.RENDERER) : null;
    } catch (e) {}
    try {
      if (navigator.userAgentData) {
        var h = await navigator.userAgentData.getHighEntropyValues(
          ["platform", "platformVersion", "architecture", "fullVersionList"]);
        info.platform = [h.platform, h.platformVersion, h.architecture].filter(Boolean).join(" ");
        var brands = (h.fullVersionList || []).filter(function (b) { return !/Not.A.Brand/i.test(b.brand); });
        var pick = brands.find(function (b) { return /Edge|Opera|Brave/.test(b.brand); }) ||
          brands.find(function (b) { return /Chrome/.test(b.brand); }) || brands[0];
        if (pick) info.browser = pick.brand + " " + pick.version;
      }
    } catch (e) {}
    return info;
  };
  return "ok";
})();
`;
}
