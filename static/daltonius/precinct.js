// precinct.js — Daltonius's Computer Precinct (codemonkey.games/daltonius).
//
// Three jobs:
//  1. Build the precinct: a box store's computer service counter whose work
//     area is floored in black square tiles, with the LP Warehouse's shelf
//     racks and monitors (lp-os apps/shell/static/warehouse.js, the scene
//     thirsty.store?kiosk=1 opens) built the same way and styled the same.
//  2. Run the attract mode: the tag (SQUAD's ship, `bby-ship`) against
//     Daltonius (SQUAD's stage-2 boss) on a loop, with nobody at the stick.
//     Daltonius works through his record's own moves — RAM sticks (shootA),
//     hacked laptops (shootB), the Ashura warp (syungoku) — and holds up his
//     "I'm Fired!!!" balloon once he is nearly done.
//  3. Play his death scene when his HP runs out: he swells up, froths at the
//     mouth, toots himself flat, and the precinct's screens call it.
//
// art/ holds every frame it draws: Daltonius's poses and death frames as
// scripts/gs/draw_daltonius.py writes them, and the tag, its beam and
// barrier, and Daltonius's RAM and laptop bullets cut from gs's own atlas.
//
// ?scene=death opens on the death scene; ?seed=<n> fixes the first loop's
// dice; ?orbit=0 holds the camera still; ?speed=<1-8> runs it faster.

import { FRAMES } from "./frames.js";

const ART = "art/";
const ground = document.getElementById("ground");
const wrapper = document.getElementById("wrapper");
const stage = document.getElementById("stage");
const bannerEl = document.getElementById("banner");
const fadeEl = document.getElementById("fade");
const hpFill = document.getElementById("hpFill");
const hpBar = document.getElementById("hpBar");
const hpText = document.getElementById("hpText");
const scoreEl = document.getElementById("score");
const deathBtn = document.getElementById("deathBtn");
const soundBtn = document.getElementById("soundBtn");

const PARAMS = new URLSearchParams(location.search);
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ORBIT = PARAMS.get("orbit") !== "0" && !REDUCED;
const SPEED = clampInt(PARAMS.get("speed"), 1, 8);

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

/* ------------------------------------------------------------- frames ---- */

/** name -> { w, h } once loaded */
const SIZE = new Map();

function loadFrames() {
  return Promise.all(FRAMES.map((name) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        SIZE.set(name, { w: img.naturalWidth, h: img.naturalHeight });
        resolve();
      };
      img.onerror = () => reject(new Error(`${ART}${name}.png did not load`));
      img.src = `${ART}${name}.png`;
    })
  ));
}

/* ---------------------------------------------------------------- dice ---- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => k * k * (3 - 2 * k);

/* ------------------------------------------- geometry (warehouse.js) ---- */

function el(cls, parent = ground) {
  const node = document.createElement("div");
  node.className = cls;
  parent.appendChild(node);
  return node;
}

function face(parent, w, h, transform, background, text) {
  const f = document.createElement("div");
  f.className = "face";
  f.style.width = w + "px";
  f.style.height = h + "px";
  f.style.transform = transform;
  f.style.background = background;
  if (text) f.textContent = text;
  parent.appendChild(f);
  return f;
}

// A cuboid standing on the floor: footprint w×d at ground (x,y), height h.
// Faces get shaded variants of `color` so the volume reads without lighting.
function makeBox({ x, y, z = 0, w, d, h, color, top, label, cls = "" }) {
  const box = el(("box3d " + cls).trim());
  box.style.width = w + "px";
  box.style.height = d + "px";
  box.style.transform = `translate3d(${x}px, ${y}px, ${z}px)`;

  const shade = (amt) => `color-mix(in oklab, ${color} ${100 - amt}%, black ${amt}%)`;

  face(box, w, d, `translateZ(${h}px)`, top || shade(0));
  face(box, w, h, `translate3d(0px, ${d - h}px, 0px) rotateX(-90deg)`, shade(18), label)
    .style.transformOrigin = "50% 100%";
  face(box, w, h, `translate3d(0px, ${-h}px, 0px) rotateX(-90deg)`, shade(18))
    .style.transformOrigin = "50% 100%";
  face(box, d, h, `translate3d(${-d / 2}px, ${d / 2 - h}px, 0px) rotateX(-90deg) rotateY(90deg)`, shade(34))
    .style.transformOrigin = "50% 100%";
  face(box, d, h, `translate3d(${w - d / 2}px, ${d / 2 - h}px, 0px) rotateX(-90deg) rotateY(90deg)`, shade(34))
    .style.transformOrigin = "50% 100%";
  return box;
}

// Stand a billboard on the floor with its bottom centre at (x, y, z).
const BILLBOARD = "rotateX(-90deg) rotateY(calc(var(--cam-ry) * -1))";
function standAt(node, x, y, z, w, h, extra = "") {
  node.style.transform = `translate3d(${x - w / 2}px, ${y - h}px, ${z}px) ${BILLBOARD}${extra}`;
}

/* -------------------------------------------------- the shelf racks ---- */

// warehouse.js buildRacks, one rack at a time: three wooden levels with a lit
// orange lip, four X-section posts, stock on every level but the odd gap.
// `stock` is the warehouse's list of emoji, or a function that stocks one
// level itself (the quarantine shelf's sprites).
function buildRack({ x, y, len, stock, plate, plateCls = "", idx }) {
  const DEPTH = 22;
  const LEVELS = [0, 26, 52];
  const POST_H = 74;
  const rack = el("box3d rack");
  rack.style.width = len + "px";
  rack.style.height = DEPTH + "px";
  rack.style.transform = `translate3d(${x}px, ${y}px, 0px)`;
  const slots = Math.floor((len - 14) / 33);

  for (const z of LEVELS) {
    const board = document.createElement("div");
    board.className = "rack-board";
    board.style.cssText = `position:absolute;width:${len}px;height:${DEPTH}px;transform:translateZ(${z}px);`;
    rack.appendChild(board);

    const edge = document.createElement("div");
    edge.className = "rack-edge";
    edge.style.cssText = `position:absolute;width:${len}px;height:4px;` +
      `transform:translate3d(0px, ${DEPTH - 4}px, ${z}px) rotateX(-90deg);`;
    rack.appendChild(edge);

    if (typeof stock === "function") {
      stock(rack, z, DEPTH, len);
      continue;
    }
    for (let slot = 0; slot < slots; slot++) {
      if ((idx * 7 + slot + z) % 5 === 4) continue; // leave gaps
      const item = document.createElement("div");
      item.className = "shelf-item";
      item.textContent = stock[(idx * 3 + slot * 2 + z / 26) % stock.length];
      item.style.cssText = `position:absolute;font-size:15px;` +
        `transform:translate3d(${14 + slot * 33}px, ${DEPTH - 18}px, ${z}px) rotateX(-90deg);`;
      rack.appendChild(item);
    }
  }

  for (const px of [0, len - 4]) {
    for (const py of [2, DEPTH - 2]) {
      for (const spin of [0, 90]) {
        const post = document.createElement("div");
        post.className = "rack-post";
        post.style.cssText = `position:absolute;width:4px;height:${POST_H}px;` +
          `transform:translate3d(${px}px, ${py - POST_H}px, 0px) rotateX(-90deg) rotateY(${spin}deg);`;
        rack.appendChild(post);
      }
    }
  }

  if (plate) {
    const p = document.createElement("div");
    p.className = `plate bb ${plateCls}`.trim();
    p.textContent = plate;
    p.style.cssText = `position:absolute;transform:translate3d(-4px, ${DEPTH}px, ${POST_H + 6}px) ${BILLBOARD};`;
    rack.appendChild(p);
  }
  return rack;
}

/* ------------------------------------------------ the quarantine shelf ---- */

// One rack in the middle of the work area, between the back wall and where
// Daltonius stands: his stash, stocked with nothing but hacked laptops and
// RAM sticks, shuffled differently every visit (fixed by ?seed=). They are
// gs's own sprites, the ones he throws, shrunk to shelf size; each laptop's
// HACKED screen flickers between its two frames out of step with the rest.
const QUARANTINE = { x: 280, y: 150, len: 240 };

function stockQuarantine(rng) {
  const LAPTOP = { w: 74 * 0.3, h: 58 * 0.3 };
  const RAM = { w: 32 * 0.62, h: 18 * 0.62 };
  return (rack, z, depth, len) => {
    let x = 6 + rng() * 6;
    for (;;) {
      const roll = rng();
      const kind = roll < 0.52 ? "laptop" : roll < 0.92 ? "ram" : "gap";
      if (kind === "gap") {
        x += 10 + rng() * 10;
        continue;
      }
      const { w, h } = kind === "laptop" ? LAPTOP : RAM;
      if (x + w > len - 6) break;
      const item = document.createElement("div");
      item.className = `shelf-item stash ${kind}`;
      item.style.width = w + "px";
      item.style.height = h + "px";
      // RAM leans every which way; a laptop sits square to show its screen.
      const lean = kind === "ram" ? ` rotate(${Math.round((rng() - 0.5) * 50)}deg)` +
        (rng() < 0.5 ? " scaleX(-1)" : "") : "";
      item.style.transform =
        `translate3d(${x}px, ${depth - 4 - h}px, ${z}px) rotateX(-90deg)${lean}`;
      if (kind === "laptop") {
        item.innerHTML = `<img class="px" src="${ART}laptop0.png" alt="">` +
          `<img class="px flicker" src="${ART}laptop1.png" alt="">`;
        const flick = item.lastElementChild;
        flick.style.animationDuration = (0.28 + rng() * 0.3).toFixed(2) + "s";
        flick.style.animationDelay = (-rng()).toFixed(2) + "s";
      } else {
        item.innerHTML = `<img class="px" src="${ART}RAM_0.png" alt="">`;
      }
      rack.appendChild(item);
      x += w + 2 + rng() * 5;
    }
  };
}

function buildQuarantine() {
  const given = Number(PARAMS.get("seed"));
  const seed = given ? given ^ 0x51a5 : Math.floor(Math.random() * 2 ** 32);
  buildRack({
    ...QUARANTINE,
    stock: stockQuarantine(mulberry32(seed)),
    plate: "QUARANTINE",
    plateCls: "alert",
    idx: 4,
  });
}

/* ------------------------------------------------------- the monitors ---- */

// warehouse.js buildScreens: the same monitor, a glyph and a label over a
// stand and a base. Here they sit on the benches and the counter.
const SCREEN_W = 84;
const SCREEN_H = 52 + 12 + 4;

function buildScreen({ x, y, z, glyph, label }) {
  const screen = el("screen bb");
  standAt(screen, x, y, z, SCREEN_W, SCREEN_H);
  screen.innerHTML = `
    <div class="screen-face">
      <span class="screen-glyph"></span>
      <span class="screen-label"></span>
    </div>
    <div class="screen-stand"></div>
    <div class="screen-base"></div>`;
  const g = screen.querySelector(".screen-glyph");
  const l = screen.querySelector(".screen-label");
  g.textContent = glyph;
  l.textContent = label;
  return { el: screen, glyph: g, label: l, home: { glyph, label } };
}

/* ---------------------------------------------------------- the room ---- */

const BENCH_H = 30;
const COUNTER_H = 34;
const screens = {};

function buildPrecinct() {
  // The back wall, with the precinct's name across it.
  const wall = el("back-wall");
  wall.style.width = "720px";
  wall.style.height = "150px";
  wall.style.transform = `translate3d(40px, ${30 - 150}px, 0px) rotateX(-90deg)`;
  wall.innerHTML = `<div class="sign">COMPUTER PRECINCT<small>REPAIRS · SETUP · SUPPORT</small></div>`;

  // Shelves: in-for-repair and ready-for-pickup against the back wall, and
  // two runs of stock out on the store floor.
  const REPAIRS = ["💻", "🖥️", "📦", "⌨️", "💻", "🖨️", "📦", "🖱️"];
  const PICKUP = ["📦", "💻", "📦", "🎧", "🖥️", "📦", "💾", "⌨️"];
  const STORE = ["💻", "🎧", "🖱️", "⌨️", "💾", "🔌", "📀", "🕹️"];
  buildRack({ x: 90, y: 44, len: 240, stock: REPAIRS, plate: "REPAIRS IN", idx: 0 });
  buildRack({ x: 470, y: 44, len: 240, stock: PICKUP, plate: "READY FOR PICKUP", idx: 1 });
  buildRack({ x: 22, y: 528, len: 170, stock: STORE, plate: "LAPTOPS", idx: 2 });
  buildRack({ x: 608, y: 528, len: 170, stock: STORE, plate: "ACCESSORIES", idx: 3 });
  buildQuarantine();

  // Workbenches down both sides of the work area, a monitor on each.
  for (const [x, y] of [[75, 132], [75, 282], [595, 132], [595, 282]]) {
    makeBox({ x, y, w: 130, d: 36, h: BENCH_H, color: "#3b4250", top: "#4a5263" });
    const tool = el("shelf-item");
    tool.textContent = x < 400 ? "💻" : "🖥️";
    tool.style.fontSize = "18px";
    standAt(tool, x + (x < 400 ? 104 : 24), y + 20, BENCH_H, 20, 18);
  }
  screens.diag = buildScreen({ x: 130, y: 152, z: BENCH_H, glyph: "🩺", label: "Diagnostics" });
  screens.backup = buildScreen({ x: 130, y: 302, z: BENCH_H, glyph: "💾", label: "Data backup" });
  screens.virus = buildScreen({ x: 670, y: 152, z: BENCH_H, glyph: "🛡️", label: "Virus scan" });
  screens.queue = buildScreen({ x: 670, y: 302, z: BENCH_H, glyph: "🧰", label: "Repair queue" });

  // The service counter across the front, check-in and pick-up on it.
  makeBox({
    x: 170, y: 428, w: 460, d: 32, h: COUNTER_H,
    color: "#1f2533", top: "#2b3243", label: "COMPUTER PRECINCT", cls: "counter",
  });
  screens.checkin = buildScreen({ x: 200, y: 444, z: COUNTER_H, glyph: "🏷️", label: "Check-in" });
  screens.pickup = buildScreen({ x: 600, y: 444, z: COUNTER_H, glyph: "📦", label: "Pick-up" });

  const decal = el("floor-decal");
  decal.textContent = "CHECK-IN HERE";
  decal.style.transform = "translate3d(318px, 490px, 1px)";
}

/* ------------------------------------------------------------ sprites ---- */

class Sprite {
  constructor(frame, { scale = 1, cls = "", mid = false } = {}) {
    this.node = el(`sprite ${mid ? "mid " : ""}${cls}`.trim());
    this.img = document.createElement("img");
    this.img.className = "px";
    this.img.alt = "";
    this.img.draggable = false;
    this.node.appendChild(this.img);
    this.scale = scale;
    this.mid = mid;
    this.frame = null;
    this.setFrame(frame);
  }

  setFrame(name) {
    if (name === this.frame) return;
    this.frame = name;
    const { w, h } = SIZE.get(name);
    this.w = w * this.scale;
    this.h = h * this.scale;
    this.img.src = `${ART}${name}.png`;
    this.node.style.width = this.w + "px";
    this.node.style.height = this.h + "px";
  }

  // Bottom centre at (x, y, z) — or, for a mid sprite, its centre.
  place(x, y, z, extra = "") {
    const top = this.mid ? y - this.h / 2 : y - this.h;
    this.node.style.transform =
      `translate3d(${x - this.w / 2}px, ${top}px, ${z}px) ${BILLBOARD}${extra}`;
  }

  remove() {
    this.node.remove();
  }
}

class Shadow {
  constructor() {
    this.node = el("shadow");
  }
  place(x, y, w, d, alpha = 1) {
    this.node.style.width = w + "px";
    this.node.style.height = d + "px";
    this.node.style.opacity = String(alpha);
    this.node.style.transform = `translate3d(${x - w / 2}px, ${y - d / 2}px, 1px)`;
  }
  remove() {
    this.node.remove();
  }
}

/* -------------------------------------------------------------- sound ---- */

// Off until asked for (and a click lets a page make sound at all). Everything
// is synthesized: the toots are a sawtooth through a resonant low-pass with
// its amplitude fluttered at ~30 Hz, which is most of what a toot is.
const sfx = {
  ctx: null,
  master: null,
  on: false,
  enable() {
    if (!this.ctx) {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctx) return false;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
    }
    this.ctx.resume();
    this.on = true;
    return true;
  },
  disable() {
    this.on = false;
  },
  get t() {
    return this.ctx.currentTime;
  },
  noise(dur) {
    const n = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    return src;
  },
  toot(dur, f0, f1, vol = 0.8, flutter = 30) {
    if (!this.on) return;
    const t = this.t;
    const o = this.ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(280, t + dur);
    lp.Q.value = 7;
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(vol, t + 0.03);
    amp.gain.setValueAtTime(vol, t + dur * 0.7);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.setValueAtTime(flutter, t);
    lfo.frequency.linearRampToValueAtTime(flutter * 0.6, t + dur);
    const depth = this.ctx.createGain();
    depth.gain.value = vol * 0.7;
    lfo.connect(depth).connect(amp.gain);
    o.connect(lp).connect(amp).connect(this.master);
    const air = this.noise(dur);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 500;
    bp.Q.value = 1.2;
    const airAmp = this.ctx.createGain();
    airAmp.gain.setValueAtTime(vol * 0.25, t);
    airAmp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    air.connect(bp).connect(airAmp).connect(this.master);
    for (const n of [o, lfo, air]) {
      n.start(t);
      n.stop(t + dur + 0.05);
    }
  },
  inflate(dur) {
    if (!this.on) return;
    const t = this.t;
    const o = this.ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(980, t + dur);
    const vib = this.ctx.createOscillator();
    vib.frequency.value = 11;
    const vibAmt = this.ctx.createGain();
    vibAmt.gain.value = 24;
    vib.connect(vibAmt).connect(o.frequency);
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(0.28, t + 0.1);
    amp.gain.setValueAtTime(0.28, t + dur - 0.1);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(amp).connect(this.master);
    for (const n of [o, vib]) {
      n.start(t);
      n.stop(t + dur + 0.05);
    }
  },
  blip(f, dur = 0.06, vol = 0.2, type = "sine") {
    if (!this.on) return;
    const t = this.t;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 1.6, t + dur);
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(vol, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(amp).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  },
  thud(vol = 0.6, dur = 0.35) {
    if (!this.on) return;
    const t = this.t;
    const src = this.noise(dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + dur);
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(vol, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(amp).connect(this.master);
    src.start(t);
    src.stop(t + dur);
  },
};

/* ------------------------------------------------------------ the HUD ---- */

const MAX_HP = 3500; // his bossData hp
const BOSS_SCORE = 8000; // and his score

function banner(text, sub = "", cls = "") {
  bannerEl.className = "banner";
  bannerEl.textContent = text;
  if (sub) {
    const s = document.createElement("small");
    s.textContent = sub;
    bannerEl.appendChild(s);
  }
  if (cls) bannerEl.classList.add(cls);
  // Force the scale-in to replay for back-to-back banners.
  void bannerEl.offsetWidth;
  bannerEl.classList.add("show");
}

function hideBanner() {
  bannerEl.classList.remove("show");
}

let shownHp = -1;
let shownScore = -1;
function drawHud() {
  const hp = Math.max(0, S.boss.hp);
  if (hp !== shownHp) {
    shownHp = hp;
    const k = hp / MAX_HP;
    hpFill.style.transform = `scaleX(${k})`;
    hpText.textContent = `${Math.ceil(k * 100)}%`;
    hpBar.classList.toggle("danger", k > 0 && k < 0.25);
  }
  if (S.score !== shownScore) {
    shownScore = S.score;
    scoreEl.textContent = String(S.score).padStart(6, "0");
  }
}

/* ---------------------------------------------------------- the world ---- */

const BOSS_SCALE = 1;
const BOSS_Y = 210;
const TAG_Y = 372;
const ARENA = { min: 262, max: 538 };
const BEAM_DAMAGE = 6;
const MAX_FX = 160;

/** The loop's state; newLoop() replaces it. */
let S = null;
let loopCount = 0;

function newLoop({ death = false, seed } = {}) {
  if (S) {
    for (const list of [S.beams, S.shots, S.fx]) for (const o of list) o.node.remove();
    S.boss.sprite.remove();
    S.boss.shadow.remove();
    S.boss.balloon.remove();
    S.tag.sprite.remove();
    S.tag.barrier.remove();
    S.tag.shadow.remove();
  }
  const rng = mulberry32(seed ?? (Number(PARAMS.get("seed")) || 0x5eed) + loopCount++ * 7919);
  S = {
    t: 0,
    rng,
    phase: "intro",
    score: 0,
    beams: [],
    shots: [],
    fx: [],
    shake: 0,
    cam: { rx: -24, ry: -34, z: -170, y: 40, fx: 400, fy: 290 },
    camGoal: { rx: -24, z: -120, y: 40, fx: 400, fy: 270 },
    boss: {
      x: 400,
      y: BOSS_Y,
      z: 0,
      jx: 0,
      sx: 1,
      sy: 1,
      hp: MAX_HP,
      flash: 0,
      frame: "Daltonius_idle0",
      hittable: false,
      sprite: new Sprite("Daltonius_idle0", { scale: BOSS_SCALE }),
      shadow: new Shadow(),
      balloon: new Sprite("Daltonius_fired0", { scale: 1 }),
    },
    tag: {
      x: 400,
      y: 590,
      z: 170,
      vx: 0,
      fireT: 0,
      shield: 0,
      firing: false,
      sprite: new Sprite("bby-ship"),
      barrier: new Sprite("barrier0", { mid: true }),
      shadow: new Shadow(),
    },
  };
  S.boss.balloon.node.style.display = "none";
  S.tag.barrier.node.style.display = "none";
  for (const s of Object.values(screens)) resetScreen(s);
  shownHp = shownScore = -1;
  hideBanner();
  director = attract({ death });
}

function resetScreen(s) {
  s.el.classList.remove("live", "alarm");
  s.glyph.textContent = s.home.glyph;
  s.label.textContent = s.home.label;
}

/* -------------------------------------------------------------- effects ---- */

function addFx(fx) {
  if (S.fx.length >= MAX_FX) {
    const old = S.fx.shift();
    old.node.remove();
  }
  S.fx.push(fx);
  return fx;
}

// A round particle: a spark, a fleck of foam, a puff of gas, a speck of dust.
function particle(cls, { x, y, z, vx = 0, vy = 0, vz = 0, g = 0, size = 6, grow = 0, life = 30, color, floor = false }) {
  const node = el(`spark ${cls}`);
  if (color) node.style.background = color;
  return addFx({ node, x, y, z, vx, vy, vz, g, size, grow, life, max: life, floor });
}

function sparks(x, y, z, n, colors, speed = 2.2, life = 16) {
  const rng = S.rng;
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const b = (rng() - 0.3) * Math.PI;
    particle("", {
      x, y, z,
      vx: Math.cos(a) * Math.cos(b) * speed,
      vy: Math.sin(a) * Math.cos(b) * speed * 0.6,
      vz: Math.sin(b) * speed,
      size: 3 + rng() * 3,
      life: life + rng() * 8,
      color: colors[i % colors.length],
    });
  }
}

function popText(text, cls, x, y, z, { size = 22, life = 60, rise = 0.6 } = {}) {
  const node = el(`pop-text ${cls}`);
  node.textContent = text;
  node.style.fontSize = size + "px";
  return addFx({ node, x, y, z, vx: 0, vy: 0, vz: rise, g: 0, life, max: life, text: true });
}

function afterimage(spr, x, y, z) {
  const ghost = new Sprite(spr.frame, { scale: spr.scale, cls: "ghost" });
  ghost.place(x, y, z);
  return addFx({ node: ghost.node, x, y, z, life: 18, max: 18, ghost: ghost });
}

function stepFx() {
  for (let i = S.fx.length - 1; i >= 0; i--) {
    const f = S.fx[i];
    f.life--;
    if (f.life <= 0) {
      f.node.remove();
      S.fx.splice(i, 1);
      continue;
    }
    if (f.ghost) {
      f.node.style.opacity = String(0.45 * (f.life / f.max));
      continue;
    }
    f.vz -= f.g;
    f.x += f.vx;
    f.y += f.vy;
    f.z += f.vz;
    if (f.z <= 0 && !f.g) {
      f.z = 0;
      f.vz = 0;
    } else if (f.z <= 0) {
      // landed: foam sticks to the tiles and spreads a little
      f.z = 0;
      f.vx *= 0.3;
      f.vy *= 0.3;
      f.vz = 0;
      if (f.floor && !f.landed) {
        f.landed = true;
        f.life = Math.min(f.life, 70);
        f.max = f.life;
      }
    }
    f.size += f.grow;
    const k = f.life / f.max;
    if (f.text) {
      const pop = Math.min(1, (f.max - f.life) / 6);
      f.node.style.opacity = String(Math.min(1, k * 2.2));
      f.node.style.transform =
        `translate3d(${f.x}px, ${f.y}px, ${f.z}px) ${BILLBOARD} translateX(-50%) scale(${0.4 + 0.6 * pop})`;
      continue;
    }
    const s = f.landed ? f.size * 1.3 : f.size;
    f.node.style.width = s + "px";
    f.node.style.height = (f.landed ? s * 0.5 : s) + "px";
    f.node.style.opacity = String(Math.min(1, k * 1.6));
    f.node.style.transform = f.landed
      ? `translate3d(${f.x - s / 2}px, ${f.y - s / 4}px, 1.5px)`
      : `translate3d(${f.x - s / 2}px, ${f.y - s / 2}px, ${f.z}px) ${BILLBOARD}`;
  }
}

/* ------------------------------------------------------------ shooting ---- */

function spawnBeam(off) {
  const { tag, boss } = S;
  const x = tag.x + off;
  const y = tag.y - 6;
  const z = tag.z + 40;
  const tx = boss.x + off * 0.4;
  const tz = 62;
  const dx = tx - x;
  const dy = boss.y - y;
  const dz = tz - z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const spr = new Sprite("beam0", { cls: "beam", mid: true });
  spr.node.style.width = "6px";
  spr.node.style.height = "22px";
  spr.w = 6;
  spr.h = 22;
  S.beams.push({ node: spr.node, spr, x, y, z, vx: (dx / len) * 8, vy: (dy / len) * 8, vz: (dz / len) * 8, t: 0 });
}

function handPos(side) {
  const b = S.boss;
  return { x: b.x + side * 30, y: b.y + 2, z: 64 * BOSS_SCALE + b.z };
}

function aimAt(from, to, speed) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  return { vx: (dx / len) * speed, vy: (dy / len) * speed, vz: (dz / len) * speed };
}

function throwRam() {
  const from = handPos(1);
  const { tag } = S;
  const v = aimAt(from, { x: tag.x + tag.vx * 18, y: tag.y, z: tag.z + 25 }, 3.1);
  const spr = new Sprite("RAM_0", { mid: true, scale: 0.9 });
  S.shots.push({ kind: "ram", node: spr.node, spr, ...from, ...v, hp: 2, rot: 0, t: 0, dodge: S.rng() < 0.72 });
  sfx.blip(520, 0.08, 0.12, "square");
}

function throwLaptops() {
  const { tag } = S;
  const from = { x: S.boss.x, y: S.boss.y + 4, z: 70 * BOSS_SCALE };
  const base = aimAt(from, { x: tag.x, y: tag.y, z: tag.z + 25 }, 2.3);
  for (const spread of [-0.42, 0, 0.42]) {
    const c = Math.cos(spread);
    const s = Math.sin(spread);
    const spr = new Sprite("laptop0", { mid: true, scale: 0.55 });
    S.shots.push({
      kind: "laptop",
      node: spr.node,
      spr,
      ...from,
      x: from.x + spread * 60,
      vx: base.vx * c - base.vy * s,
      vy: base.vx * s + base.vy * c,
      vz: base.vz,
      hp: 3,
      rot: 0,
      t: 0,
      dodge: S.rng() < 0.8,
    });
  }
  screens.virus.el.classList.add("alarm");
  screens.virus.glyph.textContent = "🦠";
  screens.virus.label.textContent = "Hacked!";
  sfx.blip(220, 0.18, 0.14, "sawtooth");
}

function popShot(i, scored) {
  const s = S.shots[i];
  sparks(s.x, s.y, s.z, scored ? 10 : 6, s.kind === "ram" ? ["#9be37b", "#e9f7c9"] : ["#9fc6ff", "#ffffff"]);
  if (scored) {
    const pts = s.kind === "laptop" ? 500 : 100;
    S.score += pts;
    popText(String(pts), "score", s.x, s.y, s.z, { size: 13, life: 40 });
    if (s.kind === "laptop") {
      S.fixed = (S.fixed || 0) + 1;
      screens.queue.label.textContent = `Fixed ${S.fixed}`;
      screens.queue.el.classList.add("live");
    }
  }
  s.node.remove();
  S.shots.splice(i, 1);
}

function stepShots() {
  const { tag, boss } = S;
  for (let i = S.beams.length - 1; i >= 0; i--) {
    const b = S.beams[i];
    b.x += b.vx;
    b.y += b.vy;
    b.z += b.vz;
    b.t++;
    if (b.t % 3 === 0) b.spr.img.src = `${ART}beam${(b.t / 3) % 2}.png`;
    let hit = false;
    for (let j = S.shots.length - 1; j >= 0; j--) {
      const s = S.shots[j];
      if (Math.hypot(s.x - b.x, s.y - b.y, s.z - b.z) < (s.kind === "laptop" ? 22 : 16)) {
        hit = true;
        if (--s.hp <= 0) popShot(j, true);
        else sparks(b.x, b.y, b.z, 3, ["#ffffff"]);
        break;
      }
    }
    if (!hit && boss.hittable && Math.abs(b.y - boss.y) < 10 &&
      Math.abs(b.x - boss.x) < 34 * BOSS_SCALE && b.z > 8 && b.z < 118 * BOSS_SCALE) {
      hit = true;
      boss.hp -= BEAM_DAMAGE;
      // A flash every few hits, not every one, or he would never stop glowing.
      if (boss.flash <= -8) boss.flash = 3;
      S.score += 10;
      sparks(b.x, boss.y + 6, b.z, 3, ["#7fd3ff", "#ffffff", "#ffe93b"], 1.8, 12);
    }
    if (hit || b.y < boss.y - 40 || b.t > 60) {
      b.node.remove();
      S.beams.splice(i, 1);
    }
  }

  for (let i = S.shots.length - 1; i >= 0; i--) {
    const s = S.shots[i];
    s.x += s.vx;
    s.y += s.vy;
    s.z = Math.max(6, s.z + s.vz);
    s.t++;
    if (s.kind === "ram") s.rot += 14;
    else {
      s.rot = Math.sin(s.t * 0.18) * 12;
      if (s.t % 10 === 0) s.spr.setFrame(`laptop${(s.t / 10) % 2}`);
    }
    if (Math.hypot(s.x - tag.x, s.y - tag.y, s.z - (tag.z + 25)) < (s.kind === "laptop" ? 26 : 20)) {
      tag.shield = 70;
      popText("BLOCK", "score", tag.x, tag.y, tag.z + 60, { size: 12, life: 34 });
      sfx.blip(880, 0.12, 0.12, "triangle");
      popShot(i, false);
      continue;
    }
    if (s.y > 520 || s.y < 0 || s.x < 0 || s.x > 800) {
      s.node.remove();
      S.shots.splice(i, 1);
    }
  }
}

/* ------------------------------------------------------------- the tag ---- */

function stepTag() {
  const { tag, boss } = S;
  const t = S.t / 60;
  let tx = tag.x;
  let ty = tag.y;
  let tz = tag.z;
  if (S.phase === "fight") {
    tx = boss.x + 92 * Math.sin(t * 0.85) + 28 * Math.sin(t * 2.3);
    ty = TAG_Y + 16 * Math.sin(t * 0.55);
    tz = 40 + 10 * Math.sin(t * 1.7);
    // Sidestep what is coming — most of the time.
    for (const s of S.shots) {
      if (s.vy <= 0 || !s.dodge) continue;
      const eta = (tag.y - s.y) / s.vy;
      if (eta < 0 || eta > 46) continue;
      const px = s.x + s.vx * eta;
      if (Math.abs(px - tag.x) < 36) {
        tx = tag.x + (tag.x < px ? -70 : 70);
        if (tx < ARENA.min || tx > ARENA.max) tx = tag.x + (tag.x < px ? 70 : -70);
      }
    }
    tx = clamp(tx, ARENA.min, ARENA.max);
    if (--tag.fireT <= 0) {
      tag.fireT = 7;
      spawnBeam(-7);
      spawnBeam(7);
    }
  } else if (S.phase === "death") {
    // Stand off to one side and watch.
    tx = boss.x < 400 ? boss.x + 120 : boss.x - 120;
    ty = boss.y + 70;
    tz = 50 + 6 * Math.sin(t * 2);
  } else if (S.phase === "outro") {
    // A victory hop beside what is left of him.
    tx = (boss.x < 400 ? boss.x + 110 : boss.x - 110) + 14 * Math.sin(t * 2.2);
    ty = boss.y + 70;
    tz = 50 + 22 * Math.abs(Math.sin(t * 4));
  }
  if (S.phase === "intro") {
    // flown in by the director
  } else {
    const ax = clamp((tx - tag.x) * 0.08 - tag.vx * 0.25, -0.6, 0.6);
    tag.vx = clamp(tag.vx + ax, -3.4, 3.4);
    tag.x += tag.vx;
    tag.y += (ty - tag.y) * 0.06;
    tag.z += (tz - tag.z) * 0.08;
  }
  if (tag.shield > 0) tag.shield--;
}

/* ------------------------------------------------------- his moves ---- */

function* wait(n) {
  for (let i = 0; i < n; i++) yield;
}

function drift(speed = 0.5) {
  const { boss, tag } = S;
  boss.x += clamp(tag.x - boss.x, -speed, speed) * 0.6;
  boss.x = clamp(boss.x, ARENA.min + 20, ARENA.max - 20);
}

const MOVES = {
  *idle() {
    const n = 50 + Math.floor(S.rng() * 50);
    for (let i = 0; i < n; i++) {
      S.boss.frame = Math.floor(i / 18) % 2 ? "Daltonius_idle1" : "Daltonius_idle0";
      drift();
      yield;
    }
  },
  *shootA() {
    const b = S.boss;
    b.frame = "Daltonius_shootA0";
    yield* wait(12);
    b.frame = "Daltonius_shootA1";
    yield* wait(16);
    b.frame = "Daltonius_shootA2";
    throwRam();
    yield* wait(20);
  },
  *shootB() {
    const b = S.boss;
    const near = b.x < 400 ? screens.diag : screens.virus;
    near.el.classList.add("live");
    for (let i = 0; i < 48; i++) {
      b.frame = Math.floor(i / 6) % 2 ? "Daltonius_shootB1" : "Daltonius_shootB0";
      yield;
    }
    b.frame = "Daltonius_shootB2";
    throwLaptops();
    yield* wait(14);
    b.frame = "Daltonius_shootB3";
    yield* wait(18);
    b.frame = "Daltonius_shootB4";
    yield* wait(22);
    near.el.classList.remove("live");
  },
  *syungoku() {
    const b = S.boss;
    const from = { x: b.x, y: b.y };
    // Warp to the far half of the floor from wherever he stands.
    const lo = ARENA.min + 20;
    const hi = ARENA.max - 20;
    const mid = (lo + hi) / 2;
    const to = from.x < mid ? lerp(mid + 40, hi, S.rng()) : lerp(lo, mid - 40, S.rng());
    const toY = BOSS_Y + (S.rng() - 0.5) * 36;
    sfx.blip(300, 0.3, 0.1, "sine");
    for (let i = 0; i < 36; i++) {
      b.frame = `Daltonius_syungoku${Math.floor(i / 4) % 3}`;
      const k = ease(i / 35);
      b.x = lerp(from.x, to, k);
      b.y = lerp(from.y, toY, k);
      if (i % 3 === 0) afterimage(b.sprite, b.x, b.y, b.z);
      yield;
    }
    b.frame = "Daltonius_syungoku_finish";
    yield* wait(24);
    b.frame = "Daltonius_syungoku_finish_ten";
    yield* wait(40);
  },
};

const PATTERN = ["idle", "shootA", "shootA", "idle", "shootB", "idle", "syungoku", "shootA", "idle", "shootB", "shootA", "syungoku"];

function* bossBrain() {
  for (;;) {
    for (const move of PATTERN) yield* MOVES[move]();
  }
}

/* ---------------------------------------------------- the death scene ---- */

function mouthZ() {
  // The froth frames' mouth sits 74px up the 128px frame.
  return 74 * BOSS_SCALE + S.boss.z;
}

function* deathScene() {
  const { boss, rng } = S;
  S.phase = "death";
  boss.hittable = false;
  boss.balloon.node.style.display = "none";
  for (let i = S.shots.length - 1; i >= 0; i--) popShot(i, false);
  for (const b of S.beams) b.node.remove();
  S.beams.length = 0;

  // Struck: a white flash and the screen shaking.
  boss.flash = 26;
  S.shake = 14;
  sfx.thud(0.7, 0.5);
  hpBar.classList.remove("danger");
  yield* wait(28);

  // The camera moves in on him.
  S.camGoal = { rx: -18, z: 520, y: 70, fx: boss.x, fy: boss.y + 10 };

  // Bulge: he swells, wobbling, a size each beat.
  sfx.inflate(1.7);
  for (const [i, f] of ["bulge0", "bulge1", "bulge2"].entries()) {
    boss.frame = `Daltonius_die_${f}`;
    for (let k = 0; k < 34; k++) {
      const w = Math.sin(k * 0.8) * (0.035 + i * 0.015);
      boss.sx = 1 + w;
      boss.sy = 1 - w * 0.8;
      boss.jx = (rng() - 0.5) * (0.6 + i * 0.7);
      yield;
    }
  }
  boss.sx = boss.sy = 1;

  // Froth: foaming at the mouth, flecks raining onto the black tiles.
  screens.diag.el.classList.add("alarm");
  screens.diag.glyph.textContent = "⚠️";
  screens.diag.label.textContent = "Pressure!";
  for (let k = 0; k < 140; k++) {
    boss.frame = `Daltonius_die_froth${Math.floor(k / 7) % 3}`;
    boss.jx = (rng() - 0.5) * 1.8;
    if (k % 2 === 0) {
      particle("foam", {
        x: boss.x + (rng() - 0.5) * 22,
        y: boss.y + 2 + rng() * 4,
        z: mouthZ() - 8,
        vx: (rng() - 0.5) * 2.2,
        vy: 0.2 + rng() * 0.9,
        vz: 0.6 + rng() * 1.6,
        g: 0.11,
        size: 4 + rng() * 6,
        life: 160,
        floor: true,
      });
    }
    if (k % 10 === 0) sfx.blip(300 + rng() * 600, 0.05, 0.1);
    yield;
  }

  // Toot: each lets a size out of him and kicks him off the floor.
  const toots = [
    { f: "toot0", text: "toot", size: 18, hop: 8, dur: 0.38, f0: 190, f1: 120, puffs: 6 },
    { f: "toot1", text: "TOOT!", size: 26, hop: 14, dur: 0.55, f0: 150, f1: 85, puffs: 10 },
    { f: "toot2", text: "TOOOOT!!", size: 36, hop: 22, dur: 0.95, f0: 125, f1: 58, puffs: 16 },
    { f: "toot3", text: "pfffft…", size: 15, hop: 3, dur: 0.6, f0: 240, f1: 160, puffs: 5 },
  ];
  screens.virus.el.classList.add("alarm");
  screens.virus.glyph.textContent = "☣️";
  screens.virus.label.textContent = "Air quality";
  for (const [i, t] of toots.entries()) {
    boss.frame = `Daltonius_die_${t.f}`;
    sfx.toot(t.dur, t.f0, t.f1, t.f === "toot3" ? 0.4 : 0.85);
    S.shake = Math.round(t.hop / 2);
    // Out the back of him, off to one side then the other.
    popText(t.text, "toot", boss.x + (i % 2 ? 58 : -58), boss.y + 10, 24 * BOSS_SCALE, {
      size: t.size,
      life: 70,
      rise: 0.7,
    });
    for (let k = 0; k < 56; k++) {
      boss.z = k < 24 ? t.hop * Math.sin((Math.PI * k) / 24) : 0;
      boss.jx = (rng() - 0.5) * 1.2;
      if (k < t.puffs) {
        const side = k % 2 ? 1 : -1;
        particle("gas", {
          x: boss.x + side * (18 + rng() * 18),
          y: boss.y - 4 - rng() * 6,
          z: 6 + rng() * 16,
          vx: side * (0.3 + rng() * 0.9),
          vy: (rng() - 0.5) * 0.4,
          vz: 0.15 + rng() * 0.35,
          size: 12 + rng() * 10,
          grow: 0.45,
          life: 80 + rng() * 30,
        });
      }
      yield;
    }
  }

  // Flat: all the air out of him.
  boss.z = 0;
  boss.jx = 0;
  boss.frame = "Daltonius_die_flat";
  sfx.thud(0.5, 0.3);
  for (let i = 0; i < 10; i++) {
    particle("", {
      x: boss.x + (rng() - 0.5) * 80,
      y: boss.y + rng() * 6,
      z: 2,
      vx: (rng() - 0.5) * 1.2,
      vz: 0.4 + rng() * 0.4,
      size: 6 + rng() * 6,
      grow: 0.3,
      life: 30,
      color: "rgba(160,166,180,.55)",
    });
  }
  yield* wait(44);

  // The precinct's verdict.
  S.phase = "outro";
  for (const s of Object.values(screens)) {
    s.el.classList.remove("alarm");
    s.el.classList.add("live");
    s.glyph.textContent = "💀";
    s.label.textContent = "Fired";
  }
  S.score += BOSS_SCORE;
  popText(String(BOSS_SCORE), "score", boss.x, boss.y, 50, { size: 20, life: 120, rise: 0.4 });
  banner("YOU'RE FIRED!", "DALTONIUS · PRECINCT CLOSED", "fired");
  sfx.toot(0.25, 330, 300, 0.35, 22);
  yield* wait(200);
}

/* ------------------------------------------------------- the director ---- */

let director = null;

function* attract({ death }) {
  const { boss, tag } = S;
  if (!death) {
    // Title, then the tag flies in over the counter.
    S.phase = "intro";
    banner("DALTONIUS", "VS THE TAG · COMPUTER PRECINCT");
    for (let i = 0; i < 150; i++) {
      const k = ease(i / 149);
      tag.x = 400;
      tag.y = lerp(590, TAG_Y, k);
      tag.z = lerp(170, 40, k);
      S.boss.frame = Math.floor(i / 18) % 2 ? "Daltonius_idle1" : "Daltonius_idle0";
      yield;
    }
    hideBanner();
    yield* wait(12);
    banner("READY?");
    yield* wait(50);
    banner("GO!");
    yield* wait(26);
    hideBanner();
  } else {
    tag.y = TAG_Y;
    tag.z = 40;
    boss.hp = 0;
  }

  // The fight: until his HP runs out, the camera in close on it.
  S.phase = "fight";
  S.camGoal = { rx: -30, z: 60, y: 70, fx: 400, fy: 300 };
  boss.hittable = true;
  const brain = bossBrain();
  let danger = false;
  let tick = 0;
  while (boss.hp > 0) {
    brain.next();
    if (!danger && boss.hp < MAX_HP * 0.25) {
      danger = true;
      boss.balloon.node.style.display = "";
      screens.backup.el.classList.add("alarm");
      screens.backup.glyph.textContent = "📄";
      screens.backup.label.textContent = "Pink slip";
    }
    if (++tick % 30 === 0) {
      screens.diag.label.textContent = `HP ${Math.ceil((boss.hp / MAX_HP) * 100)}%`;
      screens.queue.el.classList.remove("live");
      const counter = Math.floor(tick / 90) % 2 ? screens.checkin : screens.pickup;
      screens.checkin.el.classList.toggle("live", counter === screens.checkin);
      screens.pickup.el.classList.toggle("live", counter === screens.pickup);
      if (tick % 120 === 0) {
        screens.virus.el.classList.remove("alarm");
        screens.virus.glyph.textContent = screens.virus.home.glyph;
        screens.virus.label.textContent = screens.virus.home.label;
      }
    }
    yield;
  }
  boss.hp = 0;
  yield* deathScene();

  fadeEl.classList.add("on");
  yield* wait(42);
  hideBanner();
}

/* -------------------------------------------------------------- render ---- */

let fit = 1;
let orbit = 0; // the viewer's own turn, from the arrow keys or a drag

function resize() {
  // A portrait screen gives up the racks at the edges for a bigger fight.
  const across = innerWidth < innerHeight ? 620 : 900;
  fit = clamp(Math.min(innerWidth / across, innerHeight / 640), 0.4, 1.6);
}

function stepCamera() {
  const c = S.cam;
  const g = S.camGoal;
  const k = S.phase === "intro" ? 0.02 : 0.045;
  for (const key of ["rx", "z", "y", "fx", "fy"]) c[key] = lerp(c[key], g[key], k);
  if (S.phase === "fight") g.fx = lerp(400, (S.boss.x + S.tag.x) / 2, 0.6);
  const sway = ORBIT ? (S.phase === "fight" ? 15 : 10) * Math.sin(S.t / 360) : 0;
  const ryGoal = (S.phase === "intro" ? -14 : -10) + sway + orbit;
  c.ry = lerp(c.ry, ryGoal, 0.03);
  if (S.shake > 0) S.shake--;
}

function render() {
  const { cam, boss, tag } = S;
  const shake = REDUCED ? 0 : S.shake;
  const sx = shake ? (S.rng() - 0.5) * shake : 0;
  const sy = shake ? (S.rng() - 0.5) * shake : 0;
  wrapper.style.setProperty("--cam-ry", `${cam.ry}deg`);
  wrapper.style.transform = `translate3d(${sx}px, ${cam.y + sy}px, ${cam.z}px) scale(${fit}) ` +
    `rotateX(${cam.rx}deg) rotateY(${cam.ry}deg)`;
  ground.style.transform = `rotateX(90deg) translate3d(${400 - cam.fx}px, ${300 - cam.fy}px, 0)`;

  boss.sprite.setFrame(boss.frame);
  const squash = boss.sx !== 1 || boss.sy !== 1 ? ` scale(${boss.sx}, ${boss.sy})` : "";
  boss.sprite.place(boss.x + boss.jx, boss.y, boss.z, squash);
  boss.sprite.node.classList.toggle("flash", boss.flash > 0 && boss.flash % 4 < 2);
  if (boss.flash > -8) boss.flash--;
  const flat = boss.frame === "Daltonius_die_flat";
  boss.shadow.place(boss.x, boss.y, flat ? 110 : 76, flat ? 22 : 20, 1 - Math.min(0.6, boss.z / 40));
  if (boss.balloon.node.style.display !== "none") {
    boss.balloon.setFrame(`Daltonius_fired${[0, 1, 0, 2][Math.floor(S.t / 9) % 4]}`);
    boss.balloon.place(boss.x, boss.y + 1, 96 * BOSS_SCALE, " translateX(46px)");
  }

  tag.sprite.place(tag.x, tag.y, tag.z, ` rotate(${clamp(tag.vx * 4, -14, 14)}deg)`);
  tag.shadow.place(tag.x, tag.y, 34 - tag.z * 0.12, 12 - tag.z * 0.04, clamp(1 - tag.z / 220, 0.2, 0.9));
  if (tag.shield > 0) {
    tag.barrier.node.style.display = "";
    tag.barrier.node.style.opacity = String(0.55 + 0.4 * Math.sin(S.t * 0.6));
    tag.barrier.place(tag.x, tag.y, tag.z + 25);
  } else {
    tag.barrier.node.style.display = "none";
  }

  for (const b of S.beams) b.spr.place(b.x, b.y, b.z);
  for (const s of S.shots) s.spr.place(s.x, s.y, s.z, ` rotate(${s.rot}deg)`);
  drawHud();
}

/* ---------------------------------------------------------------- loop ---- */

const TICK = 1000 / 60;
let acc = 0;
let last = 0;
let paused = false;

function tick() {
  S.t++;
  const r = director.next();
  if (r.done) {
    fadeEl.classList.remove("on");
    newLoop();
    return;
  }
  stepTag();
  stepShots();
  stepFx();
  stepCamera();
}

function frame(now) {
  if (!last) last = now;
  acc += Math.min(now - last, TICK * 5) * SPEED;
  last = now;
  if (!paused) {
    while (acc >= TICK) {
      tick();
      acc -= TICK;
    }
    render();
  } else {
    acc = 0;
  }
  requestAnimationFrame(frame);
}

function deathNow() {
  if (S.phase === "fight") S.boss.hp = 0;
  else {
    fadeEl.classList.remove("on");
    newLoop({ death: true });
  }
}

function setSound(on) {
  const ok = on ? sfx.enable() : (sfx.disable(), false);
  soundBtn.setAttribute("aria-pressed", String(ok));
  soundBtn.textContent = ok ? "Sound on" : "Sound off";
}

function bindInput() {
  addEventListener("resize", resize);
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Enter" || e.key === " ") {
      if (e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      fadeEl.classList.remove("on");
      newLoop();
    } else if (e.key === "d" || e.key === "D") deathNow();
    else if (e.key === "m" || e.key === "M") setSound(!sfx.on);
    else if (e.key === "p" || e.key === "P") paused = !paused;
    else if (e.key === "ArrowLeft") orbit = clamp(orbit - 6, -70, 70);
    else if (e.key === "ArrowRight") orbit = clamp(orbit + 6, -70, 70);
  });
  deathBtn.addEventListener("click", deathNow);
  soundBtn.addEventListener("click", () => setSound(!sfx.on));

  // Drag anywhere on the scene to turn it.
  let dragX = null;
  stage.addEventListener("pointerdown", (e) => {
    dragX = e.clientX;
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (dragX === null) return;
    orbit = clamp(orbit + (e.clientX - dragX) * 0.25, -70, 70);
    dragX = e.clientX;
  });
  const end = () => (dragX = null);
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
}

async function main() {
  resize();
  buildPrecinct();
  await loadFrames();
  bindInput();
  newLoop({ death: PARAMS.get("scene") === "death" });
  requestAnimationFrame(frame);
  // For a test or a capture to look in on.
  globalThis.precinct = {
    get state() {
      return {
        phase: S.phase,
        t: S.t,
        loop: loopCount,
        hp: S.boss.hp,
        frame: S.boss.frame,
        score: S.score,
        nodes: ground.querySelectorAll("*").length,
      };
    },
    death: deathNow,
    pause(on = true) {
      paused = on;
    },
  };
}

main().catch((err) => {
  console.error(err);
  banner("OUT OF ORDER", String(err.message || err));
});
