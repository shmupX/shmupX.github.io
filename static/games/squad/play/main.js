globalThis.__PS2_GAME_FPS__ = 120;
globalThis.__PS2_SFX__ = ["boss_barlog_voice_add","boss_bison_voice_add","boss_fang_voice_add","boss_goki_voice_add","boss_sagat_voice_add","boss_vega_voice_add","g_adbenture_voice0","g_continue_no_voice0","g_continue_no_voice1","g_continue_yes_voice0","g_continue_yes_voice1","g_continue_yes_voice2","g_damage_voice","g_powerup_voice","g_sp_voice","g_stage_voice_1","g_stage_voice_2","g_stage_voice_3","g_stage_voice_4","se_barrier_end","se_barrier_start","se_correct","se_cursor","se_damage","se_decision","se_explosion","se_guard","se_over","se_shoot","se_shoot_b","se_sp","se_sp_explosion","voice_congra","voice_countdown0","voice_countdown1","voice_countdown2","voice_countdown3","voice_countdown4","voice_countdown5","voice_countdown6","voice_countdown7","voice_countdown8","voice_countdown9","voice_fight","voice_gameover","voice_ko","voice_round0","voice_round1","voice_round2","voice_round3","voice_thankyou","voice_titlecall"];
globalThis.__PS2_BGM__ = {"tracks":["adventure_bgm","bgm_continue","bgm_gameover","boss_fang_bgm"],"alias":{"boss_geekstar_bgm":"boss_fang_bgm","boss_Daltonius_bgm":"boss_fang_bgm"}};
globalThis.__PS2_FONT__ = "assets/fonts/orbitron.ttf"; globalThis.__PS2_FONT_SCALE__ = 0.5; globalThis.__PS2_FONT_BOLD__ = true;
// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/core/color.ts
var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
var Color = {
  new(r, g2, b, a = 128) {
    return ((clamp(a, 0, 255) & 255) << 24 | (clamp(b, 0, 255) & 255) << 16 | (clamp(g2, 0, 255) & 255) << 8 | clamp(r, 0, 255) & 255) >>> 0;
  },
  getR(c) {
    return c & 255;
  },
  getG(c) {
    return c >>> 8 & 255;
  },
  getB(c) {
    return c >>> 16 & 255;
  },
  getA(c) {
    return c >>> 24 & 255;
  },
  setR(c, v) {
    return (c & 4294967040 | clamp(v, 0, 255) & 255) >>> 0;
  },
  setG(c, v) {
    return (c & 4294902015 | (clamp(v, 0, 255) & 255) << 8) >>> 0;
  },
  setB(c, v) {
    return (c & 4278255615 | (clamp(v, 0, 255) & 255) << 16) >>> 0;
  },
  setA(c, v) {
    return (c & 16777215 | (clamp(v, 0, 255) & 255) << 24) >>> 0;
  }
};

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/core/pads.ts
var PAD_BUTTONS = {
  SELECT: 1,
  L3: 2,
  R3: 4,
  START: 8,
  UP: 16,
  RIGHT: 32,
  DOWN: 64,
  LEFT: 128,
  L2: 256,
  R2: 512,
  L1: 1024,
  R1: 2048,
  TRIANGLE: 4096,
  CIRCLE: 8192,
  CROSS: 16384,
  SQUARE: 32768
};

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/core/constants.ts
var LINEAR = 0;
var NEAREST = 1;

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/core/timer.ts
var nowMs = () => typeof performance !== "undefined" ? performance.now() : Date.now();
var Timer = {
  new() {
    return {
      base: nowMs(),
      pausedAt: null
    };
  },
  getTime(t) {
    const current = t.pausedAt ?? nowMs();
    return Math.round((current - t.base) * 1e3);
  },
  setTime(t, us) {
    const current = t.pausedAt ?? nowMs();
    t.base = current - us / 1e3;
  },
  pause(t) {
    if (t.pausedAt === null) t.pausedAt = nowMs();
  },
  resume(t) {
    if (t.pausedAt !== null) {
      t.base += nowMs() - t.pausedAt;
      t.pausedAt = null;
    }
  },
  reset(t) {
    t.base = nowMs();
    t.pausedAt = null;
  },
  destroy(_t) {
  }
};

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/native/index.ts
var g = globalThis;
function toNativeColor(c) {
  const r = c & 255;
  const gc = c >>> 8 & 255;
  const b = c >>> 16 & 255;
  const a = c >>> 24 & 255;
  return ((a & 255) << 24 | (Math.round(b * 128 / 255) & 255) << 16 | (Math.round(gc * 128 / 255) & 255) << 8 | Math.round(r * 128 / 255) & 255) >>> 0;
}
function need(name) {
  const mod = g[name];
  if (mod === void 0 || mod === null) {
    throw new Error(`createNativeRuntime: AthenaEnv global '${name}' is missing \u2014 the native adapter must run on AthenaEnv v4`);
  }
  return mod;
}
function createNativeRuntime(options) {
  const fontScale = options?.fontScale ?? 1;
  const clearColor = options?.clearColor ?? Color.new(0, 0, 0, 128);
  const nativeScreen = need("Screen");
  const nativeDraw = need("Draw");
  const NativeImageCtor = need("Image");
  const NativeFontCtor = need("Font");
  const nativePads = need("Pads");
  const nativeStd = need("std");
  const nativeLinear = typeof g.LINEAR === "number" ? g.LINEAR : 1;
  const nativeNearest = typeof g.NEAREST === "number" ? g.NEAREST : 0;
  const nativeNeutral = toNativeColor(Color.new(255, 255, 255, 128));
  let displayCallback = null;
  const Screen = {
    setVSync(on) {
      if (typeof nativeScreen.setVSync === "function") nativeScreen.setVSync(on);
    },
    getMode() {
      const mode = nativeScreen.getMode();
      return {
        width: mode.width,
        height: mode.height
      };
    },
    display(cb) {
      displayCallback = cb;
    }
  };
  const Draw = {
    rect(x, y, w, h, color) {
      nativeDraw.rect(x, y, w, h, color);
    }
  };
  class NativeImage {
    width;
    height;
    startx;
    starty;
    endx;
    endy;
    filter = LINEAR;
    #color = Color.new(255, 255, 255, 128);
    #native;
    constructor(path) {
      this.#native = new NativeImageCtor(path);
      this.width = this.#native.width;
      this.height = this.#native.height;
      this.startx = 0;
      this.starty = 0;
      this.endx = this.#native.width;
      this.endy = this.#native.height;
    }
    get color() {
      return this.#color;
    }
    set color(c) {
      this.#color = c;
      this.#native.color = toNativeColor(c);
    }
    draw(x, y, w, h) {
      const n = this.#native;
      n.startx = this.startx;
      n.starty = this.starty;
      n.endx = this.endx;
      n.endy = this.endy;
      n.width = w === void 0 ? this.width : w;
      n.height = h === void 0 ? this.height : h;
      n.filter = this.filter === NEAREST ? nativeNearest : nativeLinear;
      n.color = toNativeColor(this.#color);
      n.draw(x, y);
    }
  }
  class NativeFont {
    scale = 1;
    color = void 0;
    #native;
    constructor(path) {
      this.#native = path === "default" ? new NativeFontCtor() : new NativeFontCtor(path);
    }
    print(x, y, text, color) {
      const effective = color === void 0 ? this.color : color;
      const n = this.#native;
      n.scale = this.scale * fontScale;
      n.color = effective === void 0 ? nativeNeutral : toNativeColor(effective);
      n.print(x, y, String(text));
    }
    getTextSize(text) {
      const n = this.#native;
      n.scale = this.scale * fontScale;
      const size = n.getTextSize(String(text));
      return {
        width: size.width,
        height: size.height
      };
    }
  }
  const padConst = (name) => typeof nativePads[name] === "number" ? nativePads[name] : PAD_BUTTONS[name];
  const Pads = {
    SELECT: padConst("SELECT"),
    L3: padConst("L3"),
    R3: padConst("R3"),
    START: padConst("START"),
    UP: padConst("UP"),
    RIGHT: padConst("RIGHT"),
    DOWN: padConst("DOWN"),
    LEFT: padConst("LEFT"),
    L2: padConst("L2"),
    R2: padConst("R2"),
    L1: padConst("L1"),
    R1: padConst("R1"),
    TRIANGLE: padConst("TRIANGLE"),
    CIRCLE: padConst("CIRCLE"),
    CROSS: padConst("CROSS"),
    SQUARE: padConst("SQUARE"),
    get(port = 0) {
      return nativePads.get(port);
    },
    getConnected() {
      return typeof nativePads.getConnected === "function" ? nativePads.getConnected() : [
        0
      ];
    },
    getConnectedCount() {
      return typeof nativePads.getConnectedCount === "function" ? nativePads.getConnectedCount() : 1;
    },
    isActive(port) {
      return typeof nativePads.isActive === "function" ? nativePads.isActive(port) : port === 0;
    }
  };
  return {
    Screen,
    Draw,
    Color,
    Pads,
    Image: NativeImage,
    Font: NativeFont,
    Timer: g.Timer ?? Timer,
    std: nativeStd,
    NEAREST,
    LINEAR,
    tick() {
      nativeScreen.clear(clearColor);
      if (displayCallback) displayCallback();
      nativeScreen.flip();
    }
  };
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/toolkit/easing.ts
function easeLinear(t) {
  return t;
}
function easeQuintOut(t) {
  return 1 - Math.pow(1 - t, 5);
}
function easeQuintIn(t) {
  return t * t * t * t * t;
}
function easeExpoIn(t) {
  return t === 0 ? 0 : Math.pow(2, 10 * (t - 1));
}
function easeExpoOut(t) {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}
function easeBackOut(t) {
  const s = 1.70158;
  return (t -= 1) * t * ((s + 1) * t + s) + 1;
}
function easeElasticOut(t) {
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t - 0.075) * (2 * Math.PI) / 0.3) + 1;
}
var EASES = {
  "Linear": easeLinear,
  "Quint.easeOut": easeQuintOut,
  "Quint.easeIn": easeQuintIn,
  "Expo.easeIn": easeExpoIn,
  "Expo.easeOut": easeExpoOut,
  "Back.easeOut": easeBackOut,
  "Elastic.easeOut": easeElasticOut
};
function getEase(name) {
  if (name === void 0) return easeLinear;
  return EASES[name] ?? easeLinear;
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/toolkit/tween.ts
var TweenManager = class {
  paused = false;
  tweens = [];
  idCounter = 0;
  add(opts) {
    const id = this.idCounter++;
    const tw = {
      id,
      target: opts.target,
      props: {},
      duration: opts.duration || 300,
      delay: opts.delay || 0,
      elapsed: 0,
      ease: getEase(opts.ease || "Linear"),
      yoyo: opts.yoyo || false,
      repeat: opts.repeat || 0,
      repeatCount: 0,
      forward: true,
      onComplete: opts.onComplete || null,
      onUpdate: opts.onUpdate || null,
      active: true,
      hold: opts.hold || 0,
      holdElapsed: 0
    };
    const propKeys = Object.keys(opts.props || {});
    for (let i = 0; i < propKeys.length; i++) {
      const key = propKeys[i];
      const current = opts.target[key];
      tw.props[key] = {
        start: current !== void 0 ? current : 0,
        end: opts.props[key]
      };
    }
    this.tweens.push(tw);
    return id;
  }
  update(dt) {
    if (this.paused) return;
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      if (!tw.active) {
        this.tweens.splice(i, 1);
        continue;
      }
      if (tw.delay > 0) {
        tw.delay -= dt;
        if (tw.delay > 0) continue;
        dt = -tw.delay;
        tw.delay = 0;
      }
      tw.elapsed += dt;
      const progress = Math.min(tw.elapsed / tw.duration, 1);
      const easedProgress = tw.ease(tw.forward ? progress : 1 - progress);
      const propKeys = Object.keys(tw.props);
      for (let p = 0; p < propKeys.length; p++) {
        const key = propKeys[p];
        const prop = tw.props[key];
        tw.target[key] = prop.start + (prop.end - prop.start) * easedProgress;
      }
      if (tw.onUpdate) tw.onUpdate(tw.target, progress);
      if (progress >= 1) {
        if (tw.yoyo && tw.forward) {
          if (tw.hold > 0 && tw.holdElapsed < tw.hold) {
            tw.holdElapsed += dt;
            continue;
          }
          tw.forward = false;
          tw.elapsed = 0;
          tw.holdElapsed = 0;
        } else if (tw.repeat !== 0) {
          tw.repeatCount++;
          if (tw.repeat === -1 || tw.repeatCount <= tw.repeat) {
            tw.forward = true;
            tw.elapsed = 0;
            tw.holdElapsed = 0;
          } else {
            tw.active = false;
            if (tw.onComplete) tw.onComplete(tw.target);
          }
        } else {
          tw.active = false;
          if (tw.onComplete) tw.onComplete(tw.target);
        }
      }
    }
  }
  kill(id) {
    for (let i = 0; i < this.tweens.length; i++) {
      if (this.tweens[i].id === id) {
        this.tweens[i].active = false;
        break;
      }
    }
  }
  killAll() {
    this.tweens.length = 0;
  }
};

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/toolkit/scheduler.ts
var Scheduler = class {
  paused = false;
  timers = [];
  idCounter = 0;
  delayedCall(delayMs, callback) {
    const id = this.idCounter++;
    this.timers.push({
      id,
      delay: delayMs,
      elapsed: 0,
      callback,
      repeat: 0,
      repeatCount: 0,
      interval: 0,
      active: 1
    });
    return id;
  }
  // repeat: 0 = one-shot, -1 = forever, N = fires N+1 times total
  addEvent(delayMs, repeat, callback) {
    const id = this.idCounter++;
    this.timers.push({
      id,
      delay: delayMs,
      elapsed: 0,
      callback,
      repeat,
      repeatCount: 0,
      interval: delayMs,
      active: 1
    });
    return id;
  }
  loop(delayMs, callback) {
    return this.addEvent(delayMs, -1, callback);
  }
  remove(id) {
    for (let i = 0; i < this.timers.length; i++) {
      if (this.timers[i].id === id) {
        this.timers[i].active = 0;
        break;
      }
    }
  }
  update(dt) {
    if (this.paused) return;
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const t = this.timers[i];
      if (!t.active) {
        this.timers.splice(i, 1);
        continue;
      }
      t.elapsed += dt;
      if (t.elapsed >= t.delay) {
        t.callback();
        t.repeatCount++;
        if (t.repeat === 0) {
          t.active = 0;
          this.timers.splice(i, 1);
        } else if (t.repeat === -1 || t.repeatCount <= t.repeat) {
          t.elapsed -= t.delay;
        } else {
          t.active = 0;
          this.timers.splice(i, 1);
        }
      }
    }
  }
  clear() {
    this.timers.length = 0;
  }
};

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/toolkit/loop.ts
var FixedStep = class {
  frameMs;
  now;
  maxSteps;
  last;
  acc = 0;
  constructor(options) {
    this.frameMs = 1e3 / options.fps;
    this.now = options.now;
    this.maxSteps = options.maxSteps ?? 5;
    this.last = this.now();
  }
  // Run 0..maxSteps fixed steps, return how many ran
  tick(step) {
    const current = this.now();
    this.acc += current - this.last;
    this.last = current;
    let steps = Math.floor(this.acc / this.frameMs);
    if (steps > this.maxSteps) {
      steps = this.maxSteps;
      this.acc = 0;
    } else {
      this.acc -= steps * this.frameMs;
    }
    for (let i = 0; i < steps; i++) step();
    return steps;
  }
  // Forget accumulated time and re-base the clock (e.g. after a pause)
  reset() {
    this.acc = 0;
    this.last = this.now();
  }
};

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/toolkit/viewport.ts
var Viewport = class {
  gameWidth;
  gameHeight;
  screenWidth;
  screenHeight;
  scale;
  offsetX;
  offsetY;
  constructor(options) {
    this.gameWidth = options.gameWidth;
    this.gameHeight = options.gameHeight;
    this.screenWidth = options.screenWidth;
    this.screenHeight = options.screenHeight;
    this.scale = Math.min(this.screenWidth / this.gameWidth, this.screenHeight / this.gameHeight);
    this.offsetX = Math.floor((this.screenWidth - this.gameWidth * this.scale) / 2);
    this.offsetY = Math.floor((this.screenHeight - this.gameHeight * this.scale) / 2);
  }
  // Convert game coordinates to screen coordinates
  toX(gx) {
    return Math.floor(gx * this.scale + this.offsetX);
  }
  toY(gy) {
    return Math.floor(gy * this.scale + this.offsetY);
  }
  toW(gw) {
    return Math.floor(gw * this.scale);
  }
  toH(gh) {
    return Math.floor(gh * this.scale);
  }
  // Fill the margins around the game plane with black bars
  drawLetterbox(rt) {
    const barColor = rt.Color.new(0, 0, 0);
    if (this.offsetX > 0) {
      rt.Draw.rect(0, 0, this.offsetX, this.screenHeight, barColor);
    }
    const rightX = this.offsetX + Math.ceil(this.gameWidth * this.scale);
    if (rightX < this.screenWidth) {
      rt.Draw.rect(rightX, 0, this.screenWidth - rightX, this.screenHeight, barColor);
    }
    if (this.offsetY > 0) {
      rt.Draw.rect(0, 0, this.screenWidth, this.offsetY, barColor);
    }
    const bottomY = this.offsetY + Math.ceil(this.gameHeight * this.scale);
    if (bottomY < this.screenHeight) {
      rt.Draw.rect(0, bottomY, this.screenWidth, this.screenHeight - bottomY, barColor);
    }
  }
};

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/toolkit/atlas.ts
var AtlasManager = class {
  #rt;
  #atlases = {};
  constructor(rt) {
    this.#rt = rt;
  }
  loadAtlas(name, pngPath, jsonPath) {
    const jsonText = this.#rt.std.loadFile(jsonPath);
    if (!jsonText) {
      console.log("[Atlas] Failed to load JSON: " + jsonPath);
      return false;
    }
    const data = JSON.parse(jsonText);
    const img = new this.#rt.Image(pngPath);
    const ds = data.meta && data.meta.ps2DisplayScale ? data.meta.ps2DisplayScale : 1;
    const frames = {};
    if (data.frames) {
      if (Array.isArray(data.frames)) {
        for (let i = 0; i < data.frames.length; i++) {
          const f = data.frames[i];
          frames[f.filename] = {
            x: f.frame.x,
            y: f.frame.y,
            w: f.frame.w,
            h: f.frame.h,
            dw: f.frame.w * ds,
            dh: f.frame.h * ds
          };
        }
      } else {
        const keys = Object.keys(data.frames);
        for (let k = 0; k < keys.length; k++) {
          const key = keys[k];
          const fr = data.frames[key].frame;
          frames[key] = {
            x: fr.x,
            y: fr.y,
            w: fr.w,
            h: fr.h,
            dw: fr.w * ds,
            dh: fr.h * ds
          };
        }
      }
    }
    const tex = img;
    this.#atlases[name] = {
      image: img,
      frames,
      displayScale: ds,
      texWidth: tex.texWidth || img.width,
      texHeight: tex.texHeight || img.height
    };
    console.log("[Atlas] Loaded " + name + " with " + Object.keys(frames).length + " frames (displayScale=" + ds + ")");
    return true;
  }
  // Load a grid-based spritesheet (uniform frame size, no JSON metadata)
  loadSpritesheet(name, pngPath, frameWidth, frameHeight) {
    const img = new this.#rt.Image(pngPath);
    const imgW = img.width;
    const imgH = img.height;
    const cols = Math.floor(imgW / frameWidth);
    const rows = Math.floor(imgH / frameHeight);
    const frames = {};
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        frames[String(idx)] = {
          x: c * frameWidth,
          y: r * frameHeight,
          w: frameWidth,
          h: frameHeight,
          dw: frameWidth,
          dh: frameHeight
        };
      }
    }
    this.#atlases[name] = {
      image: img,
      frames,
      displayScale: 1,
      texWidth: imgW,
      texHeight: imgH
    };
    console.log("[Atlas] Loaded spritesheet " + name + " (" + cols + "x" + rows + " = " + cols * rows + " frames, " + frameWidth + "x" + frameHeight + ")");
  }
  get(name) {
    return this.#atlases[name] || null;
  }
  getFrame(name, frame2) {
    const atlas = this.#atlases[name];
    if (!atlas) return null;
    return atlas.frames[frame2] || null;
  }
  hasFrame(name, frame2) {
    const atlas = this.#atlases[name];
    if (!atlas) return false;
    return !!atlas.frames[frame2];
  }
  // Resolve frame name: try exact, then swap .gif/.png extension
  resolveFrameName(name, frame2) {
    if (this.hasFrame(name, frame2)) return frame2;
    let alt = null;
    if (frame2.endsWith(".gif")) alt = frame2.replace(/\.gif$/, ".png");
    else if (frame2.endsWith(".png")) alt = frame2.replace(/\.png$/, ".gif");
    if (alt && this.hasFrame(name, alt)) return alt;
    return frame2;
  }
  // Get frame dimensions (original display size, not texture size)
  getFrameSize(name, frame2) {
    const f = this.getFrame(name, frame2);
    if (!f) return {
      w: 0,
      h: 0
    };
    return {
      w: f.dw,
      h: f.dh
    };
  }
  // Draw an atlas frame at screen position (x, y) with center origin.
  // Negative scaleX/scaleY flips by swapping the crop edges.
  drawFrame(name, frame2, x, y, scaleX, scaleY, alpha, tint) {
    const atlas = this.#atlases[name];
    if (!atlas) return;
    const f = atlas.frames[frame2];
    if (!f) return;
    const img = atlas.image;
    const sx = scaleX || 1;
    const sy = scaleY || 1;
    this.#setCrop(img, f, sx < 0, sy < 0);
    const displayW = f.dw * Math.abs(sx);
    const displayH = f.dh * Math.abs(sy);
    img.width = displayW;
    img.height = displayH;
    if (tint) {
      img.color = tint;
    } else if (alpha !== void 0 && alpha < 1) {
      const a = Math.floor(alpha * 128);
      img.color = this.#rt.Color.new(255, 255, 255, a);
    } else {
      img.color = this.#rt.Color.new(255, 255, 255, 128);
    }
    img.draw(x - displayW / 2, y - displayH / 2);
  }
  // Draw atlas frame with top-left origin (no centering)
  drawFrameTL(name, frame2, x, y, scaleX, scaleY, alpha) {
    const atlas = this.#atlases[name];
    if (!atlas) return;
    const f = atlas.frames[frame2];
    if (!f) return;
    const img = atlas.image;
    const sx = scaleX || 1;
    const sy = scaleY || 1;
    this.#setCrop(img, f, sx < 0, sy < 0);
    img.width = f.dw * Math.abs(sx);
    img.height = f.dh * Math.abs(sy);
    if (alpha !== void 0 && alpha < 1) {
      const a = Math.floor(alpha * 128);
      img.color = this.#rt.Color.new(255, 255, 255, a);
    } else {
      img.color = this.#rt.Color.new(255, 255, 255, 128);
    }
    img.draw(x, y);
  }
  #setCrop(img, f, flipX, flipY) {
    img.startx = flipX ? f.x + f.w : f.x;
    img.endx = flipX ? f.x : f.x + f.w;
    img.starty = flipY ? f.y + f.h : f.y;
    img.endy = flipY ? f.y : f.y + f.h;
  }
};

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/toolkit/sprite.ts
function hitTestAABB(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/toolkit/scenes.ts
var SceneManager = class {
  #rt;
  #screenWidth;
  #screenHeight;
  #fadeStep;
  #beforeInit;
  #handlers = {};
  #current = "";
  #timer = 0;
  #fadeAlpha = 0;
  #fading = false;
  #next = "";
  constructor(options) {
    this.#rt = options.rt;
    this.#screenWidth = options.screenWidth;
    this.#screenHeight = options.screenHeight;
    this.#fadeStep = options.fadeStep ?? 0.03;
    this.#beforeInit = options.beforeInit;
  }
  get current() {
    return this.#current;
  }
  get timer() {
    return this.#timer;
  }
  get fading() {
    return this.#fading;
  }
  register(name, handlers) {
    this.#handlers[name] = handlers;
  }
  switch(name) {
    this.#fading = true;
    this.#next = name;
    this.#fadeAlpha = 0;
  }
  switchImmediate(name) {
    this.#current = name;
    this.#timer = 0;
    this.#fading = false;
    this.#fadeAlpha = 0;
    this.#init(name);
  }
  #init(name) {
    this.#beforeInit?.(name);
    this.#handlers[name]?.init?.();
  }
  update() {
    if (this.#fading) {
      this.#fadeAlpha += this.#fadeStep;
      if (this.#fadeAlpha < 1) return;
      this.#fadeAlpha = 1;
      this.#current = this.#next;
      this.#timer = 0;
      this.#init(this.#current);
      this.#fading = false;
    }
    this.#timer++;
    this.#handlers[this.#current]?.update?.();
  }
  draw() {
    this.#handlers[this.#current]?.draw?.();
    if (this.#fadeAlpha > 0 && this.#fading) {
      const a = Math.floor(this.#fadeAlpha * 128);
      const fadeColor = this.#rt.Color.new(0, 0, 0, a);
      this.#rt.Draw.rect(0, 0, this.#screenWidth, this.#screenHeight, fadeColor);
    }
  }
};

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/constants.ts
var GW = 256;
var GH = 480;
var GCX = 128;
var GCY = 240;
var SCREEN_W = 640;
var SCREEN_H = 448;
var FPS = 30;
var FRAME_MS = 1e3 / FPS;
var PLAYER_MOVE_SPEED = 6;
var PLAYER_SMOOTHING = 0.09;
var SCENE_TITLE = "title";
var SCENE_ADV = "adventure";
var SCENE_GAME = "game";
var SCENE_CONTINUE = "continue";
var SCENE_ENDING = "ending";

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/state.ts
var HISCORE_FILE = "ps2sp_hiscore.txt";
function createGameState() {
  return {
    score: 0,
    highScore: 0,
    localHighScore: 0,
    stageId: 0,
    continueCnt: 0,
    akebonoCnt: 0,
    maxCombo: 0,
    spgage: 0,
    playerHp: 0,
    playerMaxHp: 0,
    spDamage: 0,
    shootMode: "normal",
    shootSpeed: "speed_normal",
    shortFlg: 0,
    secondLoop: 0,
    recipe: null,
    paused: 0,
    pauseCursor: 0,
    turboMode: 0
  };
}
function resetGameState(state2) {
  state2.score = 0;
  state2.maxCombo = 0;
  state2.spgage = 0;
  state2.stageId = 0;
  state2.continueCnt = 0;
  state2.akebonoCnt = 0;
  state2.shortFlg = 0;
  state2.turboMode = 0;
}
function saveHighScore(ctx2) {
  const state2 = ctx2.state;
  if (state2.score > state2.highScore) {
    state2.highScore = state2.score;
  }
  if (state2.highScore > state2.localHighScore) {
    state2.localHighScore = state2.highScore;
  }
  try {
    const file = ctx2.rt.std.open(HISCORE_FILE, "w");
    file.puts(String(state2.localHighScore));
    file.close();
  } catch {
  }
}
function loadSavedHighScore(rt) {
  try {
    const text = rt.std.loadFile(HISCORE_FILE);
    if (text === null) {
      return 0;
    }
    const value = parseInt(text, 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/sound.ts
function createNullSound() {
  return {
    init() {
    },
    loadSfx(_key, _path) {
    },
    loadStream(_key, _path) {
    },
    playSfx(_key, _volume) {
    },
    playSound(_key, _volume) {
    },
    playBgm(_key, _volume) {
    },
    stopBgm() {
    },
    stopAllSounds() {
    }
  };
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/input.ts
var MASKS = Object.values(PAD_BUTTONS);
function createInput(rt) {
  const pad2 = rt.Pads.get();
  let held2 = {};
  let prevHeld = {};
  const isDown = (mask) => held2[mask] === true;
  const isPressed = (mask) => held2[mask] === true && prevHeld[mask] !== true;
  const getAnalogX = () => pad2.lx / 128;
  const getAnalogY = () => pad2.ly / 128;
  return {
    update() {
      pad2.update();
      prevHeld = held2;
      held2 = {};
      for (const mask of MASKS) {
        held2[mask] = pad2.pressed(mask);
      }
    },
    isDown,
    isPressed,
    getAnalogX,
    getAnalogY,
    isLeftHeld() {
      return isDown(PAD_BUTTONS.LEFT) || getAnalogX() < -0.3;
    },
    isRightHeld() {
      return isDown(PAD_BUTTONS.RIGHT) || getAnalogX() > 0.3;
    },
    isUpHeld() {
      return isDown(PAD_BUTTONS.UP) || getAnalogY() < -0.3;
    },
    isDownHeld() {
      return isDown(PAD_BUTTONS.DOWN) || getAnalogY() > 0.3;
    },
    isUpPressed() {
      return isPressed(PAD_BUTTONS.UP);
    },
    isDownPressed() {
      return isPressed(PAD_BUTTONS.DOWN);
    },
    isFirePressed() {
      return isPressed(PAD_BUTTONS.CROSS) || isPressed(PAD_BUTTONS.CIRCLE);
    },
    isSpPressed() {
      return isPressed(PAD_BUTTONS.TRIANGLE) || isPressed(PAD_BUTTONS.R1);
    },
    isStartPressed() {
      return isPressed(PAD_BUTTONS.START);
    },
    isSelectPressed() {
      return isPressed(PAD_BUTTONS.SELECT);
    },
    isConfirmPressed() {
      return isPressed(PAD_BUTTONS.CROSS) || isPressed(PAD_BUTTONS.START);
    },
    isBackPressed() {
      return isPressed(PAD_BUTTONS.CIRCLE) || isPressed(PAD_BUTTONS.TRIANGLE);
    },
    isYesPressed() {
      return isPressed(PAD_BUTTONS.CROSS);
    },
    isNoPressed() {
      return isPressed(PAD_BUTTONS.CIRCLE);
    },
    isTurboToggle() {
      return isDown(PAD_BUTTONS.SELECT) && isPressed(PAD_BUTTONS.DOWN) || isPressed(PAD_BUTTONS.SELECT) && isDown(PAD_BUTTONS.DOWN);
    }
  };
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/font.ts
function createGameFont(rt, vp) {
  const font = new rt.Font(globalThis.__PS2_FONT__ || "default");
  font.scale = vp.scale * (globalThis.__PS2_FONT_SCALE__ || 1);
  if (globalThis.__PS2_FONT_BOLD__) {
    const print1 = font.print.bind(font);
    font.print = (x, y, text, color) => { print1(x, y, text, color); print1(x + 1, y, text, color); print1(x, y + 1, text, color); };
  }
  return {
    print(x, y, text, color) {
      font.print(x, y, text, color);
    },
    printGame(gx, gy, text, color) {
      font.print(vp.toX(gx), vp.toY(gy), text, color);
    }
  };
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/hud.ts
function createHudState() {
  return {
    scoreCount: 0,
    highScore: 0,
    comboCount: 0,
    maxCombo: 0,
    comboTimeCnt: 0,
    spgageCount: 0,
    spgageMax: 100,
    spFireFlg: 0,
    spBtnActive: 0,
    hpPercent: 1,
    bossTimerVisible: 0,
    bossTimerCount: 99
  };
}
function hudReset(hud) {
  hud.scoreCount = 0;
  hud.comboCount = 0;
  hud.maxCombo = 0;
  hud.comboTimeCnt = 0;
  hud.spgageCount = 0;
  hud.spFireFlg = 0;
  hud.spBtnActive = 0;
  hud.hpPercent = 1;
  hud.bossTimerVisible = 0;
  hud.bossTimerCount = 99;
}
function hudOnEnemyKill(hud, score, spgage) {
  hud.comboCount++;
  hud.scoreCount += score * hud.comboCount;
  hud.spgageCount += spgage;
  if (hud.spgageCount > hud.spgageMax) {
    hud.spgageCount = hud.spgageMax;
  }
  hud.comboTimeCnt = 60;
  if (hud.comboCount > hud.maxCombo) {
    hud.maxCombo = hud.comboCount;
  }
}
function hudLoop(hud) {
  if (hud.comboTimeCnt > 0) {
    hud.comboTimeCnt--;
    if (hud.comboTimeCnt <= 0) {
      hud.comboCount = 0;
    }
  }
}
function hudDraw(ctx2) {
  const hud = ctx2.hud;
  const white = ctx2.rt.Color.new(255, 255, 255);
  const yellow = ctx2.rt.Color.new(255, 255, 0);
  const red = ctx2.rt.Color.new(255, 60, 60);
  const green = ctx2.rt.Color.new(60, 255, 60);
  const cyan = ctx2.rt.Color.new(60, 200, 255);
  const barBg = ctx2.rt.Color.new(40, 40, 40);
  const lx = ctx2.vp.toX(4);
  const topY = ctx2.vp.toY(4);
  ctx2.font.print(lx, topY, "SCORE", white);
  ctx2.font.print(lx + 50, topY, String(hud.scoreCount), yellow);
  ctx2.font.print(lx, topY + 14, "HI", white);
  ctx2.font.print(lx + 20, topY + 14, String(hud.highScore), white);
  const barX = ctx2.vp.toX(4);
  const barY = ctx2.vp.toY(GH - 18);
  const barW = ctx2.vp.toW(GW - 8);
  const barH = ctx2.vp.toH(6);
  ctx2.rt.Draw.rect(barX, barY, barW, barH, barBg);
  const hpW = Math.floor(barW * hud.hpPercent);
  const hpColor = hud.hpPercent > 0.3 ? green : red;
  if (hpW > 0) {
    ctx2.rt.Draw.rect(barX, barY, hpW, barH, hpColor);
  }
  const spY = ctx2.vp.toY(GH - 10);
  const spW = ctx2.vp.toW(GW - 8);
  const spH = ctx2.vp.toH(4);
  ctx2.rt.Draw.rect(barX, spY, spW, spH, barBg);
  const spFill = Math.floor(spW * (hud.spgageCount / hud.spgageMax));
  if (spFill > 0) {
    ctx2.rt.Draw.rect(barX, spY, spFill, spH, cyan);
  }
  if (hud.spgageCount >= hud.spgageMax && hud.spBtnActive) {
    ctx2.font.print(ctx2.vp.toX(GCX - 20), ctx2.vp.toY(GH - 28), "SP READY!", cyan);
  }
  if (hud.comboCount > 1) {
    ctx2.font.print(ctx2.vp.toX(GCX - 20), ctx2.vp.toY(50), String(hud.comboCount) + " COMBO!", yellow);
  }
  if (hud.bossTimerVisible) {
    ctx2.font.print(ctx2.vp.toX(GCX - 10), ctx2.vp.toY(58), "TIME", white);
    ctx2.font.print(ctx2.vp.toX(GCX + 15), ctx2.vp.toY(58), String(hud.bossTimerCount), yellow);
  }
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/assets.ts
function normalizeRecipe(recipe) {
  if (!recipe) return;
  const bossKeys = recipe.bossData ? Object.keys(recipe.bossData) : [];
  for (let i = 0; i < bossKeys.length; i++) {
    const boss = recipe.bossData[bossKeys[i]];
    if ((!boss.texture || boss.texture.length === 0) && boss.anim) {
      boss.texture = boss.anim.idle || [];
      boss.attackTexture = boss.anim.attack || [];
    }
    if (!boss.projectileData && boss.bulletData && boss.bulletData.texture) {
      boss.projectileData = {
        texture: boss.bulletData.texture || [],
        speed: boss.bulletData.speed || 2,
        damage: boss.bulletData.damage || 1,
        hp: boss.bulletData.hp || 1,
        name: "bullet",
        ...boss.bulletData.atlas ? {
          atlas: boss.bulletData.atlas
        } : {}
      };
    }
    if (!boss.projectileData) {
      boss.projectileData = {
        texture: [],
        speed: 2,
        damage: 1,
        hp: 1,
        name: "bullet"
      };
    }
    if (!boss.speed) boss.speed = 1;
  }
  if (recipe.enemyData) {
    const enemyKeys = Object.keys(recipe.enemyData);
    for (let j = 0; j < enemyKeys.length; j++) {
      const enemy = recipe.enemyData[enemyKeys[j]];
      if (!enemy.projectileData && enemy.bulletData && enemy.bulletData.texture) {
        enemy.projectileData = {
          texture: enemy.bulletData.texture || [],
          speed: enemy.bulletData.speed || 2,
          damage: enemy.bulletData.damage || 1,
          hp: enemy.bulletData.hp || 1,
          name: "bullet",
          interval: enemy.bulletData.interval || 120,
          ...enemy.bulletData.atlas ? {
            atlas: enemy.bulletData.atlas
          } : {}
        };
      }
    }
  }
  console.log("[Main] Recipe normalized");
}
function loadFirebaseLevel(ctx2, recipe, levelPath) {
  const levelText = ctx2.rt.std.loadFile(levelPath);
  if (!levelText) {
    console.log("[Main] Firebase level file not found: " + levelPath);
    return;
  }
  const data = JSON.parse(levelText);
  if (!data || !data.enemylist) {
    console.log("[Main] Firebase level missing enemylist, skipping");
    return;
  }
  const stageKey = data.stageKey || "stage0";
  recipe[stageKey] = {
    enemylist: data.enemylist
  };
  console.log("[Main] Firebase level merged into " + stageKey + " (" + data.enemylist.length + " waves)");
  if (data.enemyData) {
    const merged = JSON.parse(JSON.stringify(data.enemyData));
    for (const ek in merged) {
      merged[ek].atlas = "level_atlas";
      const projKey = merged[ek].projectileData ? "projectileData" : merged[ek].bulletData ? "bulletData" : null;
      const proj = projKey ? merged[ek][projKey] : null;
      if (proj) {
        proj.atlas = "level_atlas";
      }
    }
    recipe.enemyData = merged;
    console.log("[Main] Firebase enemyData merged (level_atlas)");
  }
  if (data.bossData) {
    const mergedBoss = JSON.parse(JSON.stringify(data.bossData));
    for (const bk in mergedBoss) {
      const boss = mergedBoss[bk];
      if (boss && boss.anim) {
        boss.atlas = "level_atlas";
      }
      const bossProj = boss && boss.bulletData ? boss.bulletData : null;
      if (bossProj) {
        bossProj.atlas = "level_atlas";
      }
    }
    recipe.bossData = mergedBoss;
    console.log("[Main] Firebase bossData merged (level_atlas)");
  }
  let stageId = parseInt(stageKey.replace("stage", ""), 10);
  if (isNaN(stageId) || stageId < 0) stageId = 0;
  if (stageId > 4) stageId = 4;
  ctx2.state.stageId = stageId;
}
function loadAllAssets(ctx2, options) {
  console.log("[Main] Loading assets...");
  ctx2.atlas.loadAtlas("game_ui", "assets/game_ui.png", "assets/game_ui.json");
  ctx2.atlas.loadAtlas("game_asset", "assets/game_asset.png", "assets/game_asset.json");
  ctx2.atlas.loadSpritesheet("cyber-liberty", "assets/cyber_liberty.png", 32, 32);
  if (options.level) {
    ctx2.atlas.loadAtlas("level_atlas", options.level.atlasPngPath, options.level.atlasJsonPath);
  }
  const recipeText = ctx2.rt.std.loadFile("assets/game.json");
  if (recipeText) {
    ctx2.state.recipe = JSON.parse(recipeText);
    console.log("[Main] Recipe loaded");
  } else {
    console.log("[Main] WARNING: game.json not found, using fallback");
    ctx2.state.recipe = createFallbackRecipe();
  }
  if (options.level && ctx2.state.recipe) {
    loadFirebaseLevel(ctx2, ctx2.state.recipe, options.level.dataPath);
  }
  normalizeRecipe(ctx2.state.recipe);
  if (ctx2.state.recipe && ctx2.state.recipe.playerData) {
    const pd = ctx2.state.recipe.playerData;
    ctx2.state.playerMaxHp = pd.maxHp || 100;
    ctx2.state.playerHp = pd.maxHp || 100;
    ctx2.state.spDamage = pd.spDamage || 50;
    ctx2.state.shootMode = pd.defaultShootName || "normal";
    ctx2.state.shootSpeed = pd.defaultShootSpeed || "speed_normal";
  }
  const sfxList = [
    "se_shoot",
    "se_shoot_b",
    "se_explosion",
    "se_damage",
    "se_guard",
    "se_sp",
    "se_sp_explosion",
    "se_barrier_start",
    "se_barrier_end",
    "se_decision",
    "se_correct",
    "se_cursor",
    "se_over"
  ];
  for (let i = 0; i < sfxList.length; i++) {
    ctx2.sound.loadSfx(sfxList[i], "assets/sounds/" + sfxList[i] + ".wav");
  }
  const voiceList = [
    "voice_titlecall",
    "voice_fight",
    "voice_ko",
    "voice_another_fighter",
    "voice_congra",
    "voice_gameover",
    "voice_round0",
    "voice_round1",
    "voice_round2",
    "voice_round3",
    "g_damage_voice",
    "g_powerup_voice",
    "g_sp_voice",
    "g_adbenture_voice0",
    "voice_thankyou"
  ];
  for (let i = 0; i < voiceList.length; i++) {
    ctx2.sound.loadSfx(voiceList[i], "assets/sounds/" + voiceList[i] + ".wav");
  }
  for (let i = 0; i <= 9; i++) {
    ctx2.sound.loadSfx("voice_countdown" + String(i), "assets/sounds/scene_continue/voice_countdown" + String(i) + ".wav");
  }
  for (let i = 0; i < 3; i++) {
    ctx2.sound.loadSfx("g_continue_yes_voice" + String(i), "assets/sounds/scene_continue/g_continue_yes_voice" + String(i) + ".wav");
  }
  for (let i = 0; i < 2; i++) {
    ctx2.sound.loadSfx("g_continue_no_voice" + String(i), "assets/sounds/scene_continue/g_continue_no_voice" + String(i) + ".wav");
  }
  for (let i = 0; i < 5; i++) {
    ctx2.sound.loadSfx("g_stage_voice_" + String(i), "assets/sounds/scene_game/g_stage_voice_" + String(i) + ".wav");
  }
  const bossNames = [
    "bison",
    "barlog",
    "sagat",
    "vega",
    "goki",
    "fang"
  ];
  for (let i = 0; i < bossNames.length; i++) {
    const bn = bossNames[i];
    ctx2.sound.loadSfx("boss_" + bn + "_voice_add", "assets/sounds/boss_" + bn + "_voice_add.wav");
    ctx2.sound.loadSfx("boss_" + bn + "_voice_ko", "assets/sounds/boss_" + bn + "_voice_ko.wav");
  }
  const bgmList = [
    "adventure_bgm",
    "boss_bison_bgm",
    "boss_barlog_bgm",
    "boss_sagat_bgm",
    "boss_vega_bgm",
    "boss_goki_bgm",
    "boss_fang_bgm",
    "bgm_continue",
    "bgm_gameover"
  ];
  for (let i = 0; i < bgmList.length; i++) {
    ctx2.sound.loadStream(bgmList[i], "assets/sounds/" + bgmList[i] + ".ogg");
  }
  console.log("[Main] Asset loading complete");
}
function createFallbackRecipe() {
  return {
    playerData: {
      name: "player",
      texture: [],
      hp: 100,
      maxHp: 100,
      spDamage: 50,
      defaultShootName: "normal",
      defaultShootSpeed: "speed_normal",
      shootNormal: {
        texture: [],
        interval: 8,
        damage: 1,
        hp: 1
      },
      shootBig: {
        texture: [],
        interval: 12,
        damage: 3,
        hp: 3
      },
      shoot3way: {
        texture: [],
        interval: 10,
        damage: 1,
        hp: 1
      },
      barrier: {
        texture: []
      }
    },
    enemyData: {
      enemyA: {
        name: "soliderA",
        texture: [],
        hp: 2,
        speed: 1,
        score: 100,
        spgage: 5,
        interval: 60
      },
      enemyB: {
        name: "soliderB",
        texture: [],
        hp: 3,
        speed: 0.8,
        score: 150,
        spgage: 8,
        interval: 45
      }
    },
    bossData: {
      boss0: {
        name: "bison",
        texture: [],
        hp: 80,
        score: 5e3,
        spgage: 50,
        speed: 1,
        projectileData: {
          texture: [],
          speed: 2,
          damage: 1,
          hp: 1,
          name: "bullet"
        }
      },
      boss1: {
        name: "barlog",
        texture: [],
        hp: 100,
        score: 6e3,
        spgage: 50,
        speed: 1,
        projectileData: {
          texture: [],
          speed: 2.5,
          damage: 1,
          hp: 1,
          name: "bullet"
        }
      },
      boss2: {
        name: "sagat",
        texture: [],
        hp: 120,
        score: 7e3,
        spgage: 50,
        speed: 1,
        projectileData: {
          texture: [],
          speed: 2,
          damage: 1,
          hp: 1,
          name: "bullet"
        }
      },
      boss3: {
        name: "vega",
        texture: [],
        hp: 140,
        score: 8e3,
        spgage: 50,
        speed: 1,
        projectileData: {
          texture: [],
          speed: 2,
          damage: 1,
          hp: 1,
          name: "bullet"
        }
      },
      boss4: {
        name: "fang",
        texture: [],
        hp: 160,
        score: 1e4,
        spgage: 50,
        speed: 1,
        projectileData: {
          texture: [],
          speed: 2,
          damage: 1,
          hp: 1,
          name: "bullet"
        }
      }
    },
    stage0: {
      enemylist: [
        [
          "A0",
          "00",
          "A0",
          "00",
          "A0",
          "00",
          "A0",
          "00"
        ],
        [
          "00",
          "A0",
          "00",
          "A0",
          "00",
          "A0",
          "00",
          "A0"
        ],
        [
          "A1",
          "00",
          "A2",
          "00",
          "A9",
          "00",
          "A3",
          "00"
        ]
      ]
    },
    stage1: {
      enemylist: [
        [
          "B0",
          "A0",
          "B0",
          "00",
          "A0",
          "B0",
          "A0",
          "00"
        ],
        [
          "00",
          "A0",
          "00",
          "B0",
          "00",
          "A0",
          "00",
          "B0"
        ],
        [
          "A1",
          "00",
          "A2",
          "00",
          "A9",
          "00",
          "A3",
          "00"
        ]
      ]
    },
    stage2: {
      enemylist: [
        [
          "A0",
          "B0",
          "A0",
          "B0",
          "A0",
          "B0",
          "A0",
          "00"
        ],
        [
          "B0",
          "00",
          "B0",
          "00",
          "B0",
          "00",
          "B0",
          "00"
        ],
        [
          "A1",
          "00",
          "A2",
          "00",
          "A9",
          "00",
          "A3",
          "00"
        ]
      ]
    },
    stage3: {
      enemylist: [
        [
          "B0",
          "B0",
          "A0",
          "A0",
          "B0",
          "B0",
          "A0",
          "00"
        ],
        [
          "A0",
          "A0",
          "B0",
          "B0",
          "A0",
          "A0",
          "B0",
          "00"
        ],
        [
          "A1",
          "A2",
          "A9",
          "00",
          "A3",
          "00",
          "A1",
          "00"
        ]
      ]
    },
    stage4: {
      enemylist: [
        [
          "B0",
          "A0",
          "B0",
          "A0",
          "B0",
          "A0",
          "B0",
          "A0"
        ],
        [
          "A0",
          "B0",
          "A0",
          "B0",
          "A0",
          "B0",
          "A0",
          "B0"
        ],
        [
          "A1",
          "A2",
          "A9",
          "A3",
          "A1",
          "A2",
          "A9",
          "A3"
        ]
      ]
    }
  };
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/scenes/title.ts
function createTitleScene(ctx2) {
  const ts = {
    introTimer: 0,
    introDone: 0,
    startBtnVisible: 0,
    bgScrollX: 0
  };
  function init() {
    ts.introTimer = 0;
    ts.introDone = 0;
    ts.startBtnVisible = 0;
    ts.bgScrollX = 0;
    ctx2.state.turboMode = 0;
    ctx2.sound.stopAllSounds();
  }
  function update() {
    ts.bgScrollX += 0.5;
    if (!ts.introDone) {
      ts.introTimer++;
      if (ts.introTimer >= 120) {
        ts.introDone = 1;
        ts.startBtnVisible = 1;
        ctx2.sound.playSound("voice_titlecall");
      }
    }
    if (ts.startBtnVisible) {
      if (ctx2.input.isSelectPressed()) {
        ctx2.state.turboMode = 1;
        ctx2.sound.playSound("se_decision");
        ctx2.scenes.switch(SCENE_ADV);
      } else if (ctx2.input.isConfirmPressed()) {
        ctx2.sound.playSound("se_decision");
        ctx2.scenes.switch(SCENE_ADV);
      }
    }
  }
  function draw() {
    const { rt, vp, atlas, font } = ctx2;
    const white = rt.Color.new(255, 255, 255);
    const yellow = rt.Color.new(255, 255, 0);
    const black = rt.Color.new(0, 0, 0);
    if (atlas.hasFrame("game_ui", "title_bg")) {
      atlas.drawFrameTL("game_ui", "title_bg", 0, 0, SCREEN_W / 256, SCREEN_H / 480, 1);
    } else {
      rt.Draw.rect(0, 0, SCREEN_W, SCREEN_H, rt.Color.new(20, 10, 40));
    }
    const introT = Math.min(ts.introTimer / 90, 1);
    const eased = 1 - Math.pow(1 - introT, 5);
    if (atlas.hasFrame("game_ui", atlas.resolveFrameName("game_ui", "titleG.gif"))) {
      const gFrame = atlas.resolveFrameName("game_ui", "titleG.gif");
      const gx = SCREEN_W * 0.7 - (SCREEN_W * 0.7 - SCREEN_W / 2) * eased;
      atlas.drawFrame("game_ui", gFrame, Math.floor(gx), vp.toY(60), vp.scale, vp.scale, eased, null);
    }
    if (atlas.hasFrame("game_ui", atlas.resolveFrameName("game_ui", "logo.gif"))) {
      const logoFrame = atlas.resolveFrameName("game_ui", "logo.gif");
      const logoScale = 2 - eased;
      atlas.drawFrame("game_ui", logoFrame, vp.toX(GCX), vp.toY(75), vp.scale * logoScale, vp.scale * logoScale, eased, null);
    }
    if (atlas.hasFrame("game_ui", atlas.resolveFrameName("game_ui", "subTitle.gif"))) {
      const subFrame = atlas.resolveFrameName("game_ui", "subTitle.gif");
      atlas.drawFrame("game_ui", subFrame, vp.toX(GCX), vp.toY(130), vp.scale, vp.scale, eased, null);
    }
    rt.Draw.rect(vp.toX(0), vp.toY(GH - 120), vp.toW(GW), vp.toH(120), black);
    font.print(vp.toX(32), vp.toY(GH - 100), "HI-SCORE", white);
    font.print(vp.toX(110), vp.toY(GH - 100), String(ctx2.state.highScore || 0), yellow);
    if (ts.startBtnVisible) {
      if (ctx2.scenes.timer % 40 < 30) {
        font.print(vp.toX(GCX - 45), vp.toY(GH - 60), "PRESS START", white);
      }
      font.print(vp.toX(GCX - 55), vp.toY(GH - 42), "SELECT = TURBO MODE", rt.Color.new(255, 100, 0));
    }
    font.print(vp.toX(10), vp.toY(GH - 20), "(C)CAPCOM", rt.Color.new(128, 128, 128));
  }
  return {
    init,
    update,
    draw
  };
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/scenes/adv.ts
function createAdvScene(ctx2) {
  const as = {
    timer: 0,
    phase: 0,
    textAlpha: 0
  };
  function init() {
    as.timer = 0;
    as.phase = 0;
    as.textAlpha = 0;
    ctx2.sound.playBgm("adventure_bgm");
    ctx2.sound.playSound("g_adbenture_voice0");
  }
  function update() {
    as.timer++;
    if (as.timer < 60) {
      as.textAlpha = as.timer / 60;
    } else if (as.timer < 180) {
      as.textAlpha = 1;
    } else if (as.timer < 240) {
      as.textAlpha = 1 - (as.timer - 180) / 60;
    } else {
      ctx2.sound.stopBgm();
      ctx2.scenes.switch(SCENE_GAME);
    }
    if (ctx2.input.isConfirmPressed() && as.timer > 30) {
      ctx2.sound.stopBgm();
      ctx2.scenes.switch(SCENE_GAME);
    }
  }
  function draw() {
    const { rt, vp, font } = ctx2;
    const black = rt.Color.new(0, 0, 0);
    rt.Draw.rect(0, 0, SCREEN_W, SCREEN_H, black);
    const a = Math.floor(as.textAlpha * 128);
    const textColor = rt.Color.new(255, 255, 255, a);
    font.print(vp.toX(GCX - 60), vp.toY(GCY - 20), "STAGE " + String(ctx2.state.stageId + 1), textColor);
    font.print(vp.toX(GCX - 50), vp.toY(GCY + 10), "GET READY!", textColor);
  }
  return {
    init,
    update,
    draw
  };
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/player.ts
function createPlayer(data) {
  const p = {
    x: 0,
    y: 0,
    targetX: 0,
    targetY: 0,
    atlas: "cyber-liberty",
    frames: [
      "0",
      "1"
    ],
    animFrame: 0,
    animSpeed: 0.15,
    animCounter: 0,
    hp: data.hp || 100,
    maxHp: data.maxHp || 100,
    percent: 1,
    shootOn: 0,
    shootMode: "normal",
    shootSpeed: 0,
    shootInterval: 20,
    bulletFrameCnt: 0,
    bulletIdCnt: 0,
    bullets: [],
    shootNormalData: data.shootNormal || {},
    shootBigData: data.shootBig || {},
    shoot3wayData: data.shoot3way || {},
    barrierFlg: 0,
    barrierAlpha: 0,
    barrierTimer: 0,
    barrierMaxTime: 600,
    barrierFrames: data.barrier && data.barrier.texture ? data.barrier.texture : [],
    barrierAnimFrame: 0,
    alpha: 1,
    visible: 1,
    damageAnimFlg: 0,
    damageAnimTimer: 0,
    tintFlash: 0,
    width: 32,
    height: 32,
    hitX: 9,
    hitY: 12,
    hitW: 14,
    hitH: 8,
    shadowOffsetY: 5,
    dead: 0,
    explosionPlaying: 0,
    explosionFrame: 0,
    explosionTimer: 0,
    name: data.name || ""
  };
  if (p.shootNormalData.interval) {
    p.shootInterval = p.shootNormalData.interval;
  }
  return p;
}
function playerSetUp(p, hp, shootMode, shootSpeed) {
  p.hp = hp;
  p.percent = p.hp / p.maxHp;
  p.shootMode = shootMode;
  p.dead = 0;
  p.explosionPlaying = 0;
  p.visible = 1;
  p.alpha = 1;
  p.damageAnimFlg = 0;
  switch (shootMode) {
    case "normal":
      p.shootInterval = p.shootNormalData.interval || 20;
      break;
    case "big":
      p.shootInterval = p.shootBigData.interval || 20;
      break;
    case "3way":
      p.shootInterval = p.shoot3wayData.interval || 20;
      break;
  }
  switch (shootSpeed) {
    case "speed_high":
      p.shootSpeed = 15;
      break;
    default:
      p.shootSpeed = 0;
      break;
  }
}
function playerLoop(ctx2, p) {
  if (p.dead) return;
  p.x += PLAYER_SMOOTHING * (p.targetX - (p.x + p.width / 2));
  p.y += PLAYER_SMOOTHING * (p.targetY - p.y);
  p.animCounter += p.animSpeed;
  if (p.animCounter >= p.frames.length) {
    p.animCounter -= p.frames.length;
  }
  p.animFrame = Math.floor(p.animCounter) % p.frames.length;
  p.bulletFrameCnt++;
  let interval = p.shootInterval - p.shootSpeed;
  if (ctx2.state.turboMode) interval = Math.floor(interval / 2);
  if (interval < 1) interval = 1;
  if (p.shootOn && p.bulletFrameCnt % interval === 0) {
    playerShoot(ctx2, p);
  }
  const bulletMul = ctx2.state.turboMode ? 2 : 1;
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    const b = p.bullets[i];
    b.x += 3.5 * bulletMul * Math.cos(b.rotation);
    b.y += 3.5 * bulletMul * Math.sin(b.rotation);
    if (b.y <= 40 || b.x <= -b.width || b.x >= GW) {
      p.bullets.splice(i, 1);
    }
  }
  if (p.damageAnimFlg) {
    p.damageAnimTimer++;
    if (p.damageAnimTimer % (4 * ((globalThis.__PS2_GAME_FPS__ || 30) / 30)) < 2 * ((globalThis.__PS2_GAME_FPS__ || 30) / 30)) {
      p.tintFlash = 1;
      p.alpha = 0.5;
    } else {
      p.tintFlash = 0;
      p.alpha = 1;
    }
    if (p.damageAnimTimer > (30 * ((globalThis.__PS2_GAME_FPS__ || 30) / 30))) {
      p.damageAnimFlg = 0;
      p.damageAnimTimer = 0;
      p.tintFlash = 0;
      p.alpha = 1;
    }
  }
  if (p.barrierFlg) {
    p.barrierTimer++;
    if (p.barrierTimer > p.barrierMaxTime * 0.7) {
      p.barrierAlpha = p.barrierTimer % 6 < 3 ? 1 : 0.3;
    } else {
      p.barrierAlpha = 1;
    }
    if (p.barrierTimer >= p.barrierMaxTime) {
      p.barrierFlg = 0;
      p.barrierAlpha = 0;
      p.barrierTimer = 0;
      ctx2.sound.playSfx("se_barrier_end");
    }
    if (p.barrierFlg && p.barrierFrames.length > 0) {
      p.barrierAnimFrame = (p.barrierAnimFrame + 0.15) % p.barrierFrames.length;
    }
  }
}
function playerShoot(ctx2, p) {
  const rad270 = 270 * Math.PI / 180;
  const rad260 = 260 * Math.PI / 180;
  const rad280 = 280 * Math.PI / 180;
  switch (p.shootMode) {
    case "normal": {
      const b = createPlayerBullet(p, rad270, 14, 11);
      b.name = "normal";
      b.damage = p.shootNormalData.damage || 1;
      b.hp = p.shootNormalData.hp || 1;
      p.bullets.push(b);
      ctx2.sound.playSfx("se_shoot");
      break;
    }
    case "big": {
      const b = createPlayerBullet(p, rad270, 10, 22);
      b.name = "big";
      b.damage = p.shootBigData.damage || 2;
      b.hp = p.shootBigData.hp || 3;
      b.width = 16;
      b.height = 16;
      p.bullets.push(b);
      ctx2.sound.playSfx("se_shoot_b");
      break;
    }
    case "3way": {
      for (let i = 0; i < 3; i++) {
        const angle = i === 0 ? rad280 : i === 1 ? rad270 : rad260;
        const ox = i === 0 ? 14 : i === 1 ? 10 : 6;
        const b = createPlayerBullet(p, angle, ox, 11);
        b.name = "3way";
        b.damage = p.shootNormalData.damage || 1;
        b.hp = p.shootNormalData.hp || 1;
        p.bullets.push(b);
      }
      ctx2.sound.playSfx("se_shoot");
      break;
    }
  }
}
function createPlayerBullet(p, rotation, offsetX, offsetY) {
  return {
    id: p.bulletIdCnt++,
    x: p.x + 5 * Math.sin(rotation) + offsetX,
    y: p.y + 5 * Math.sin(rotation) + offsetY,
    rotation,
    width: 8,
    height: 8,
    damage: 1,
    hp: 1,
    name: "normal",
    dead: 0
  };
}
function playerOnDamage(ctx2, p, amount) {
  if (ctx2.state.godMode) return;
  if (p.barrierFlg || p.damageAnimFlg || p.dead) return;
  p.hp -= amount;
  if (p.hp <= 0) p.hp = 0;
  p.percent = p.hp / p.maxHp;
  if (p.hp <= 0) {
    p.dead = 1;
    p.explosionPlaying = 1;
    p.explosionFrame = 0;
    p.explosionTimer = 0;
    p.shootOn = 0;
    ctx2.sound.playSfx("se_explosion");
    ctx2.sound.playSfx("g_continue_no_voice0");
  } else {
    p.damageAnimFlg = 1;
    p.damageAnimTimer = 0;
    ctx2.sound.playSfx("g_damage_voice");
    ctx2.sound.playSfx("se_damage");
  }
}
function playerShootModeChange(ctx2, p, mode) {
  p.shootMode = mode;
  switch (mode) {
    case "normal":
      p.shootInterval = p.shootNormalData.interval || 20;
      break;
    case "big":
      p.shootInterval = p.shootBigData.interval || 20;
      break;
    case "3way":
      p.shootInterval = p.shoot3wayData.interval || 20;
      break;
  }
  ctx2.sound.playSfx("g_powerup_voice");
}
function playerShootSpeedChange(ctx2, p, speed) {
  switch (speed) {
    case "speed_high":
      p.shootSpeed = 15;
      break;
    default:
      p.shootSpeed = 0;
      break;
  }
  ctx2.sound.playSfx("g_powerup_voice");
}
function playerBarrierStart(ctx2, p) {
  p.barrierFlg = 1;
  p.barrierAlpha = 1;
  p.barrierTimer = 0;
  ctx2.sound.playSfx("se_barrier_start");
}
function playerExplosionUpdate(p) {
  if (!p.explosionPlaying) return;
  p.explosionTimer++;
  if (p.explosionTimer % 3 === 0) p.explosionFrame++;
  if (p.explosionFrame > 6) {
    p.explosionPlaying = 0;
  }
}
function playerDraw(ctx2, p) {
  if (!p.visible || p.alpha <= 0) return;
  if (p.dead && p.explosionPlaying) {
    const expFrame = "explosion0" + String(Math.min(p.explosionFrame, 6)) + ".gif";
    ctx2.atlas.drawFrame("game_asset", ctx2.atlas.resolveFrameName("game_asset", expFrame), ctx2.vp.toX(p.x + p.width / 2), ctx2.vp.toY(p.y + p.height / 2), ctx2.vp.scale, ctx2.vp.scale, 1, null);
    return;
  }
  if (p.dead) return;
  const playerAtlas = p.atlas || "game_asset";
  const shadowFrame = p.frames.length > 0 ? ctx2.atlas.resolveFrameName(playerAtlas, p.frames[p.animFrame]) : null;
  if (shadowFrame) {
    const shadowColor = ctx2.rt.Color.new(60, 60, 60, 60);
    ctx2.atlas.drawFrame(playerAtlas, shadowFrame, ctx2.vp.toX(p.x + p.width / 2), ctx2.vp.toY(p.y + p.height / 2 + p.shadowOffsetY), ctx2.vp.scale, ctx2.vp.scale, 0.3, shadowColor);
  }
  if (p.frames.length > 0) {
    const frame2 = ctx2.atlas.resolveFrameName(playerAtlas, p.frames[p.animFrame]);
    let tint = null;
    if (p.tintFlash) {
      tint = ctx2.rt.Color.new(255, 80, 80, Math.floor(p.alpha * 128));
    } else if (p.alpha < 1) {
      tint = ctx2.rt.Color.new(255, 255, 255, Math.floor(p.alpha * 128));
    }
    ctx2.atlas.drawFrame(playerAtlas, frame2, ctx2.vp.toX(p.x + p.width / 2), ctx2.vp.toY(p.y + p.height / 2), ctx2.vp.scale, ctx2.vp.scale, p.alpha, tint);
  }
  if (p.barrierFlg && p.barrierAlpha > 0) {
    if (p.barrierFrames.length > 0) {
      const bFrame = ctx2.atlas.resolveFrameName("game_asset", p.barrierFrames[Math.floor(p.barrierAnimFrame)]);
      const bTint = ctx2.rt.Color.new(255, 255, 255, Math.floor(p.barrierAlpha * 128));
      ctx2.atlas.drawFrame("game_asset", bFrame, ctx2.vp.toX(p.x + p.width / 2), ctx2.vp.toY(p.y - 15 + 20), ctx2.vp.scale, ctx2.vp.scale, p.barrierAlpha, bTint);
    }
  }
  for (let i = 0; i < p.bullets.length; i++) {
    const bullet = p.bullets[i];
    let bfName = null;
    switch (bullet.name) {
      case "big":
        bfName = p.shootBigData.texture ? p.shootBigData.texture[0] : null;
        break;
      default:
        bfName = p.shootNormalData.texture ? p.shootNormalData.texture[0] : null;
        break;
    }
    if (bfName) {
      bfName = ctx2.atlas.resolveFrameName("game_asset", bfName);
      ctx2.atlas.drawFrame("game_asset", bfName, ctx2.vp.toX(bullet.x + bullet.width / 2), ctx2.vp.toY(bullet.y + bullet.height / 2), ctx2.vp.scale, ctx2.vp.scale, 1, null);
    }
  }
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/enemy.ts
// shmupX lib/ps2/runtime-patches.ts: a Dezaemon zako's script and gun.
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
function createEnemy(ctx2, data) {
  return dezaZakoArm(createEnemyBody(ctx2, data), data);
}
function createEnemyBody(ctx2, data) {
  const e = {
    name: data.name || "",
    atlas: data.atlas || "game_asset",
    frames: data.texture || [],
    animFrame: 0,
    animSpeed: 0.15,
    animCounter: 0,
    x: 0,
    y: -32,
    width: 32,
    height: 32,
    hitX: 0,
    hitY: 0,
    hitW: 32,
    hitH: 32,
    hp: data.hp || 1,
    speed: data.speed || 1,
    score: data.score || 0,
    spgage: data.spgage || 0,
    interval: data.interval || 0,
    projectileData: data.projectileData || null,
    itemName: data.itemName || null,
    itemTexture: data.itemTexture || null,
    dead: 0,
    deadFlg: 0,
    shootFlg: 1,
    hardleFlg: 0,
    bulletFrameCnt: 0,
    posName: "",
    // Shadow
    shadowReverse: data.shadowReverse !== void 0 ? data.shadowReverse : 1,
    shadowOffsetY: data.shadowOffsetY || 0,
    shadowVisible: 1,
    // Explosion
    explosionPlaying: 0,
    explosionFrame: 0,
    explosionTimer: 0,
    // Visual
    visible: 1,
    alpha: 1,
    tintFlash: 0,
    tintTimer: 0,
    // Big bullet tracking per enemy
    bulletTracking: {}
  };
  if (e.interval <= -1) e.hardleFlg = 1;
  switch (data.name) {
    case "baraA":
    case "baraB":
      e.shadowVisible = 0;
      break;
    case "drum":
      e.hitX = 7;
      e.hitY = 2;
      e.hitW = e.width - 14;
      e.hitH = e.height - 2;
      break;
    case "launchpad":
      e.hitX = 8;
      e.hitY = 0;
      e.hitW = e.width - 16;
      e.hitH = e.height;
      break;
  }
  if (e.frames.length > 0) {
    const size = ctx2.atlas.getFrameSize(e.atlas, ctx2.atlas.resolveFrameName(e.atlas, e.frames[0]));
    if (size.w > 0) {
      e.width = size.w;
      e.height = size.h;
      if (e.hitW === 32) {
        e.hitW = size.w;
        e.hitH = size.h;
      }
    }
  }
  return e;
}
function enemyLoop(ctx2, e, player) {
  if (e.deza && !e.dead && !e.deadFlg) dezaZakoStep(ctx2, e);
  return enemyLoopBody(ctx2, e, player);
}
function enemyLoopBody(ctx2, e, player) {
  if (e.explosionPlaying) enemyExplosionUpdate(e);
  if (e.dead) return 0;
  e.bulletFrameCnt++;
  if (e.frames.length > 1) {
    e.animCounter += e.animSpeed;
    if (e.animCounter >= e.frames.length) e.animCounter -= e.frames.length;
    e.animFrame = Math.floor(e.animCounter) % e.frames.length;
  }
  const eMul = ctx2.state.turboMode ? 2 : 1;
  e.y += e.speed * eMul;
  switch (e.name) {
    case "soliderA":
      if (e.y >= GH / 1.5 && player) {
        e.x += 5e-3 * eMul * (player.x - e.x);
      }
      break;
    case "soliderB":
      if (e.y <= 10) {
        if (e.x >= GW / 2) {
          e.x = GW;
          e.posName = "right";
        } else {
          e.x = -e.width;
          e.posName = "left";
        }
      }
      if (e.y >= GH / 3) {
        if (e.posName === "right") e.x -= 1 * eMul;
        else if (e.posName === "left") e.x += 1 * eMul;
      }
      break;
  }
  if (e.tintFlash > 0) {
    e.tintTimer++;
    if (e.tintTimer > 6) {
      e.tintFlash = 0;
      e.tintTimer = 0;
    }
  }
  let shouldShoot = 0;
  const eInterval = ctx2.state.turboMode ? Math.max(1, Math.floor(e.interval / 2)) : e.interval;
  if (e.shootFlg && !e.hardleFlg && eInterval > 0 && e.bulletFrameCnt % eInterval === 0) {
    shouldShoot = 1;
  }
  if (e.x <= -50 || e.x >= GW + 33 || e.y <= -33 || e.y >= GH) {
    return 0;
  }
  return shouldShoot ? "shoot" : 1;
}
function enemyOnDamage(ctx2, e, damage) {
  if (e.hp === "infinity") {
    e.tintFlash = 1;
    e.tintTimer = 0;
    return;
  }
  if (e.deadFlg) return;
  e.hp -= damage;
  if (e.hp <= 0) {
    enemyDead(ctx2, e);
  } else {
    e.tintFlash = 1;
    e.tintTimer = 0;
  }
}
function enemyDead(ctx2, e) {
  if (e.hp === "infinity") return;
  e.deadFlg = 1;
  e.shootFlg = 0;
  e.explosionPlaying = 1;
  e.explosionFrame = 0;
  e.explosionTimer = 0;
  ctx2.sound.playSfx("se_explosion");
}
function enemyExplosionUpdate(e) {
  if (!e.explosionPlaying) return;
  e.explosionTimer++;
  if (e.explosionTimer % 3 === 0) e.explosionFrame++;
  if (e.explosionFrame > 6) {
    e.explosionPlaying = 0;
    e.dead = 1;
  }
}
function enemyDraw(ctx2, e) {
  if (!e.visible || e.alpha <= 0) return;
  const ea = e.atlas || "game_asset";
  if (e.explosionPlaying) {
    const expFrame = "explosion0" + String(Math.min(e.explosionFrame, 6)) + ".gif";
    const expAtlas = ctx2.atlas.hasFrame(ea, ctx2.atlas.resolveFrameName(ea, expFrame)) ? ea : "game_asset";
    ctx2.atlas.drawFrame(expAtlas, ctx2.atlas.resolveFrameName(expAtlas, expFrame), ctx2.vp.toX(e.x + e.width / 2), ctx2.vp.toY(e.y + e.height / 2), ctx2.vp.scale, ctx2.vp.scale, 1, null);
    return;
  }
  if (e.deadFlg) return;
  if (e.shadowVisible && e.frames.length > 0) {
    const frame2 = ctx2.atlas.resolveFrameName(ea, e.frames[e.animFrame]);
    const shadowColor = ctx2.rt.Color.new(0, 0, 0, 64);
    const shadowY = e.y + e.height * 1.5 - e.shadowOffsetY;
    ctx2.atlas.drawFrame(ea, frame2, ctx2.vp.toX(e.x + e.width / 2), ctx2.vp.toY(shadowY), ctx2.vp.scale, e.shadowReverse ? -ctx2.vp.scale : ctx2.vp.scale, 0.3, shadowColor);
  }
  if (e.frames.length > 0) {
    const frame2 = ctx2.atlas.resolveFrameName(ea, e.frames[e.animFrame]);
    let tint = null;
    if (e.tintFlash) {
      tint = ctx2.rt.Color.new(255, 80, 80, 128);
    }
    ctx2.atlas.drawFrame(ea, frame2, ctx2.vp.toX(e.x + e.width / 2), ctx2.vp.toY(e.y + e.height / 2), ctx2.vp.scale, ctx2.vp.scale, e.alpha, tint);
  }
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/boss.ts
// shmupX lib/ps2/runtime-patches.ts: a boss's weapons and second stage.
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
function createBoss(ctx2, data, stageId) {
  return bossOverlayArm(ctx2, bossArm(createBossBody(ctx2, data, stageId), data), data);
}
function createBossBody(ctx2, data, stageId) {
  const b = {
    name: data.name || "",
    // A level's own boss has its frames in the level atlas (loadFirebaseLevel
    // tags it); the base game's bosses live in game_asset.
    atlas: data.atlas || "game_asset",
    frames: data.texture || [],
    animFrame: 0,
    animSpeed: 0.15,
    animCounter: 0,
    x: 0,
    y: -64,
    width: 64,
    height: 64,
    hitX: 0,
    hitY: 0,
    hitW: 64,
    hitH: 64,
    hp: data.hp || 100,
    maxHp: data.hp || 100,
    score: data.score || 1e3,
    spgage: data.spgage || 50,
    speed: data.speed || 1,
    // Attack pattern
    stageId,
    projectileData: data.projectileData || null,
    projectileDataA: data.projectileDataA || null,
    projectileDataB: data.projectileDataB || null,
    projectileDataC: data.projectileDataC || null,
    shootFlg: 0,
    patternTimer: 0,
    patternPhase: 0,
    attackCooldown: 0,
    // State
    dead: 0,
    deadFlg: 0,
    theWorld: 0,
    visible: 1,
    alpha: 1,
    toujouFlg: 0,
    // Shadow
    shadowReverse: 1,
    shadowOffsetY: 0,
    shadowVisible: 1,
    // Explosion
    explosionPlaying: 0,
    explosionFrame: 0,
    explosionTimer: 0,
    explosionCount: 0,
    // Visual effects
    tintFlash: 0,
    tintTimer: 0,
    // Entry animation
    entryDone: 0,
    entryTimer: 0,
    entryStartY: -64,
    entryEndY: 60,
    // Projectiles spawned (returned to game scene for hit testing)
    pendingProjectiles: [],
    // Movement pattern
    moveTimer: 0,
    moveTargetX: 0,
    movePhase: 0,
    // Goki special
    gokiFlg: data.gokiFlg || 0,
    akebonoFlg: 0
  };
  if (b.frames.length > 0) {
    const size = ctx2.atlas.getFrameSize(b.atlas, ctx2.atlas.resolveFrameName(b.atlas, b.frames[0]));
    if (size.w > 0) {
      b.width = size.w;
      b.height = size.h;
      b.hitW = size.w;
      b.hitH = size.h;
    }
  }
  return b;
}
function bossEntry(ctx2, b) {
  b.entryDone = 0;
  b.entryTimer = 0;
  b.y = b.entryStartY;
  ctx2.sound.playSfx("boss_" + b.name + "_voice_add");
}
function bossLoop(ctx2, b) {
  if (b.dead || b.theWorld) return;
  if (!b.entryDone) {
    b.entryTimer++;
    const t = Math.min(b.entryTimer / 60, 1);
    const eased = 1 - Math.pow(1 - t, 5);
    b.y = b.entryStartY + (b.entryEndY - b.entryStartY) * eased;
    if (t >= 1) {
      b.entryDone = 1;
      b.shootFlg = 1;
    }
    return;
  }
  if (b.frames.length > 1) {
    b.animCounter += b.animSpeed;
    if (b.animCounter >= b.frames.length) b.animCounter -= b.frames.length;
    b.animFrame = Math.floor(b.animCounter) % b.frames.length;
  }
  bossOverlayStep(ctx2, b);
  if (bossStage2Step(ctx2, b)) return;
  const bMul = ctx2.state.turboMode ? 2 : 1;
  b.moveTimer += bMul;
  if (b.moveTimer % 120 === 0) {
    b.movePhase = (b.movePhase + 1) % 3;
    switch (b.movePhase) {
      case 0:
        b.moveTargetX = GCX - b.width / 2;
        break;
      case 1:
        b.moveTargetX = GW * 0.2;
        break;
      case 2:
        b.moveTargetX = GW * 0.6;
        break;
    }
  }
  b.x += 0.03 * bMul * (b.moveTargetX - b.x);
  if (b.shootFlg) {
    b.patternTimer++;
    b.attackCooldown -= bMul;
    if (b.attackCooldown <= 0) {
      bossMove(ctx2, b);
    }
  }
  if (b.tintFlash > 0) {
    b.tintTimer++;
    if (b.tintTimer > 6) {
      b.tintFlash = 0;
      b.tintTimer = 0;
    }
  }
}
function bossAttack(ctx2, b) {
  const projData = b.projectileData;
  if (!projData) {
    b.attackCooldown = 60;
    return;
  }
  switch (b.stageId) {
    case 0:
      if (b.patternPhase % 3 < 2) {
        bossShootStraight(b, projData);
        b.attackCooldown = 30;
      } else {
        bossShootRadial(b, projData, 12);
        b.attackCooldown = 90;
      }
      b.patternPhase++;
      break;
    case 1:
      bossShootStraight(b, projData);
      if (b.patternPhase % 4 === 0 && b.projectileDataA) {
        bossShootSpread(b, b.projectileDataA, 3);
      }
      b.attackCooldown = 25;
      b.patternPhase++;
      break;
    case 2:
      if (b.patternPhase % 2 === 0) {
        bossShootStraight(b, projData);
      } else {
        bossShootSpread(b, projData, 2);
      }
      b.attackCooldown = 35;
      b.patternPhase++;
      break;
    case 3:
      bossShootStraight(b, projData);
      if (b.patternPhase % 5 === 0) {
        bossShootRadial(b, projData, 8);
      }
      b.attackCooldown = 28;
      b.patternPhase++;
      break;
    case 4:
      if (b.patternPhase % 3 === 0) {
        bossShootRadial(b, projData, 16);
        b.attackCooldown = 60;
      } else {
        bossShootSpread(b, projData, 3);
        b.attackCooldown = 25;
      }
      b.patternPhase++;
      break;
    default:
      bossShootStraight(b, projData);
      b.attackCooldown = 40;
      break;
  }
  ctx2.sound.playSfx("se_shoot");
}
function bossShootStraight(b, data) {
  b.pendingProjectiles.push({
    x: b.x + b.hitW / 2,
    y: b.y + b.hitH,
    rotX: 0,
    rotY: 1,
    speed: data.speed || 2,
    damage: data.damage || 1,
    hp: data.hp || 1,
    name: data.name || "bullet",
    frames: data.texture || [],
    width: 8,
    height: 8
  });
}
function bossShootSpread(b, data, count) {
  const baseAngle = 80;
  const spread = 20;
  const step = count > 1 ? spread / (count - 1) : 0;
  const startAngle = baseAngle - spread / 2;
  for (let i = 0; i < count; i++) {
    const deg = startAngle + step * i;
    const rad = deg * Math.PI / 180;
    b.pendingProjectiles.push({
      x: b.x + b.hitW / 2,
      y: b.y + b.hitH,
      rotX: Math.cos(rad),
      rotY: Math.sin(rad),
      speed: data.speed || 2,
      damage: data.damage || 1,
      hp: data.hp || 1,
      name: data.name || "bullet",
      frames: data.texture || [],
      width: 8,
      height: 8
    });
  }
}
function bossShootRadial(b, data, count) {
  for (let i = 0; i < count; i++) {
    const deg = i / count * 360;
    const rad = deg * Math.PI / 180;
    b.pendingProjectiles.push({
      x: b.x + b.hitW / 2,
      y: b.y + b.hitH / 2,
      rotX: Math.cos(rad),
      rotY: Math.sin(rad),
      speed: data.speed || 1.5,
      damage: data.damage || 1,
      hp: data.hp || 1,
      name: data.name || "bullet",
      frames: data.texture || [],
      width: 8,
      height: 8
    });
  }
}
function bossOnDamage(ctx2, b, damage) {
  if (b.deadFlg || b.dead) return;
  b.hp -= damage;
  b.tintFlash = 1;
  b.tintTimer = 0;
  if (b.hp <= 0) {
    b.hp = 0;
    bossDead(ctx2, b);
  }
}
function bossDead(ctx2, b) {
  b.deadFlg = 1;
  b.shootFlg = 0;
  b.explosionPlaying = 1;
  b.explosionFrame = 0;
  b.explosionTimer = 0;
  b.explosionCount = 0;
  ctx2.sound.playSfx("se_explosion");
  ctx2.sound.playSfx("boss_" + b.name + "_voice_ko");
}
function bossExplosionUpdate(ctx2, b) {
  if (!b.explosionPlaying) return 0;
  b.explosionTimer++;
  if (b.explosionTimer % 8 === 0) {
    b.explosionCount++;
    if (b.explosionCount > 5) {
      b.explosionPlaying = 0;
      b.dead = 1;
      return 1;
    }
    ctx2.sound.playSfx("se_explosion");
  }
  return 0;
}
function bossDraw(ctx2, b) {
  bossDrawBody(ctx2, b);
  bossStage2Ghost(ctx2, b);
  bossOverlayDraw(ctx2, b);
}
function bossDrawBody(ctx2, b) {
  if (!b.visible || b.alpha <= 0) return;
  const ba = b.atlas || "game_asset";
  if (b.explosionPlaying) {
    for (let i = 0; i <= b.explosionCount; i++) {
      const ox = Math.sin(i * 2.5) * 20;
      const oy = Math.cos(i * 3.1) * 15;
      const ef = Math.min((b.explosionTimer + i * 3) % 21 / 3, 6);
      const expFrame = "explosion0" + String(Math.floor(ef)) + ".gif";
      const expAtlas = ctx2.atlas.hasFrame(ba, ctx2.atlas.resolveFrameName(ba, expFrame)) ? ba : "game_asset";
      ctx2.atlas.drawFrame(expAtlas, ctx2.atlas.resolveFrameName(expAtlas, expFrame), ctx2.vp.toX(b.x + b.width / 2 + ox), ctx2.vp.toY(b.y + b.height / 2 + oy), ctx2.vp.scale, ctx2.vp.scale, 1, null);
    }
    return;
  }
  if (b.deadFlg) return;
  if (b.shadowVisible && b.frames.length > 0) {
    const frame2 = ctx2.atlas.resolveFrameName(ba, b.frames[b.animFrame]);
    const shadowColor = ctx2.rt.Color.new(60, 60, 60, 60);
    ctx2.atlas.drawFrame(ba, frame2, ctx2.vp.toX(b.x + b.width / 2), ctx2.vp.toY(b.y + b.height / 2 + 5), ctx2.vp.scale, -ctx2.vp.scale, 0.3, shadowColor);
  }
  if (b.frames.length > 0) {
    const frame2 = ctx2.atlas.resolveFrameName(ba, b.frames[b.animFrame]);
    let tint = null;
    if (b.tintFlash) {
      tint = ctx2.rt.Color.new(255, 80, 80, 128);
    }
    ctx2.atlas.drawFrame(ba, frame2, ctx2.vp.toX(b.x + b.width / 2), ctx2.vp.toY(b.y + b.height / 2), ctx2.vp.scale, ctx2.vp.scale, b.alpha, tint);
  }
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/projectile.ts
function createProjectile(data) {
  return projectileTints(createProjectileBody(data), data);
}
function createProjectileBody(data) {
  return {
    x: data.x || 0,
    y: data.y || 0,
    rotX: data.rotX || 0,
    rotY: data.rotY || 1,
    speed: data.speed || 2,
    damage: data.damage || 1,
    hp: data.hp || 1,
    name: data.name || "bullet",
    atlas: data.atlas || "game_asset",
    frames: data.frames || [],
    animFrame: 0,
    animCounter: 0,
    width: data.width || 8,
    height: data.height || 8,
    dead: 0,
    deadFlg: 0,
    // For meka-type homing
    cont: 0,
    start: data.start || 0,
    targetX: null
  };
}
function projectileLoop(ctx2, proj, player) {
  if (proj.tints) proj.tintSteps += ctx2.state.turboMode ? 2 : 1;
  return projectileLoopBody(ctx2, proj, player);
}
function projectileLoopBody(ctx2, proj, player) {
  if (proj.deadFlg) return false;
  const pMul = ctx2.state.turboMode ? 2 : 1;
  if (proj.rotX !== 0 || proj.name !== "meka") {
    proj.x += proj.rotX * proj.speed * pMul;
    proj.y += proj.rotY * proj.speed * pMul;
  } else if (proj.name === "meka") {
    proj.cont++;
    if (proj.cont >= proj.start) {
      if (!proj.targetX && player) {
        proj.targetX = player.x;
      }
      if (proj.targetX) {
        proj.x += 9e-3 * pMul * (proj.targetX - proj.x);
      }
      proj.y += (Math.cos(proj.cont / 5) + 2.5 * proj.speed) * pMul;
    }
  }
  if (proj.frames && proj.frames.length > 1) {
    proj.animCounter += 0.15;
    if (proj.animCounter >= proj.frames.length) proj.animCounter -= proj.frames.length;
    proj.animFrame = Math.floor(proj.animCounter) % proj.frames.length;
  }
  if (proj.x < -30 || proj.x > GW + 30 || proj.y < -30 || proj.y > GH + 30) {
    return false;
  }
  return true;
}
function projectileDraw(ctx2, proj) {
  if (proj.tints) {
    projectileFlashDraw(ctx2, proj);
    return;
  }
  projectileDrawBody(ctx2, proj);
}
function projectileDrawBody(ctx2, proj) {
  if (proj.deadFlg || proj.dead) return;
  const pa = proj.atlas || "game_asset";
  let frame2 = null;
  if (proj.frames && proj.frames.length > 0) {
    frame2 = ctx2.atlas.resolveFrameName(pa, proj.frames[proj.animFrame]);
  }
  if (frame2) {
    ctx2.atlas.drawFrame(pa, frame2, ctx2.vp.toX(proj.x), ctx2.vp.toY(proj.y), ctx2.vp.scale, ctx2.vp.scale, 1, null);
  } else {
    const color = ctx2.rt.Color.new(255, 100, 100);
    ctx2.rt.Draw.rect(ctx2.vp.toX(proj.x - 3), ctx2.vp.toY(proj.y - 3), ctx2.vp.toW(6), ctx2.vp.toH(6), color);
  }
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/scenes/game.ts
function createGameScene(ctx2, net = null) {
  globalThis.__PS2_GS__ = () => gs;
  const gs = {
    waveInterval: 80,
    waveCount: 0,
    frameCnt: 0,
    enemyWaveFlg: 0,
    theWorldFlg: 0,
    enemies: [],
    projectiles: [],
    items: [],
    player: null,
    player2: null,
    boss: null,
    bossTimerStartFlg: 0,
    bossTimerCountDown: 99,
    bossTimerFrameCnt: 0,
    stageEnemyList: [],
    stageBgScrollY: 0,
    stageBgmName: "",
    sceneSwitch: 0,
    // SP fire
    spLineH: 0,
    spFireActive: 0,
    spFireTimer: 0,
    // Stage clear / game over
    resultTimer: 0,
    // Turbo activation effect
    turboEffectActive: 0,
    turboImpacts: [],
    turboFlashAlpha: 0,
    turboBlackoutAlpha: 0
  };
  function init() {
    ctx2.state.paused = 0;
    ctx2.state.pauseCursor = 0;
    ctx2.scheduler.paused = false;
    ctx2.tweens.paused = false;
    gs.waveCount = 0;
    gs.frameCnt = 0;
    gs.enemyWaveFlg = 0;
    gs.theWorldFlg = 0;
    gs.enemies = [];
    gs.projectiles = [];
    gs.items = [];
    gs.player2 = null;
    gs.boss = null;
    gs.bossTimerStartFlg = 0;
    gs.bossTimerCountDown = 99;
    gs.bossTimerFrameCnt = 0;
    gs.stageBgScrollY = 0;
    gs.sceneSwitch = 0;
    gs.spFireActive = 0;
    gs.spFireTimer = 0;
    gs.spLineH = 0;
    gs.resultTimer = 0;
    gs.turboEffectActive = 0;
    gs.turboImpacts = [];
    gs.turboFlashAlpha = 0;
    gs.turboBlackoutAlpha = 0;
    const recipe = ctx2.state.recipe;
    if (recipe) {
      const stageKey = "stage" + String(ctx2.state.stageId);
      const stageData = recipe[stageKey];
      if (stageData && stageData.enemylist) {
        gs.stageEnemyList = stageData.enemylist.slice().reverse();
      } else {
        gs.stageEnemyList = [];
      }
    }
    const playerData = recipe ? recipe.playerData : null;
    if (playerData) {
      gs.player = createPlayer(playerData);
      playerSetUp(gs.player, ctx2.state.playerMaxHp || playerData.maxHp || 0, ctx2.state.shootMode || "normal", ctx2.state.shootSpeed || "speed_normal");
      gs.player.x = GCX - gs.player.width / 2;
      gs.player.y = GH - 96 - gs.player.height / 2;
      gs.player.targetX = GCX;
      gs.player.targetY = gs.player.y;
    }
    const bossData = recipe && recipe.bossData ? recipe.bossData["boss" + String(ctx2.state.stageId)] : null;
    if (bossData) {
      gs.stageBgmName = "boss_" + bossData.name + "_bgm";
      ctx2.sound.stopBgm();
      ctx2.sound.playBgm(gs.stageBgmName);
    }
    hudReset(ctx2.hud);
    ctx2.hud.scoreCount = ctx2.state.score || 0;
    ctx2.hud.highScore = ctx2.state.highScore || 0;
    ctx2.hud.spgageCount = ctx2.state.spgage || 0;
    ctx2.scheduler.delayedCall(2600, () => {
      gs.enemyWaveFlg = 1;
      if (gs.player) gs.player.shootOn = 1;
      ctx2.sound.playSound("g_stage_voice_" + String(ctx2.state.stageId));
    });
    ctx2.sound.playSound("voice_round" + String(Math.min(ctx2.state.stageId, 3)));
    ctx2.scheduler.delayedCall(800, () => {
      ctx2.sound.playSound("voice_fight");
    });
  }
  function update() {
    net?.onSceneTick?.({
      player: gs.player,
      player2: gs.player2,
      enemies: gs.enemies,
      projectiles: gs.projectiles,
      boss: gs.boss,
      state: ctx2.state
    });
    const p = gs.player;
    if (!p) return;
    if (ctx2.input.isStartPressed()) {
      if (ctx2.state.paused) {
        ctx2.state.paused = 0;
        ctx2.scheduler.paused = false;
        ctx2.tweens.paused = false;
      } else {
        ctx2.state.paused = 1;
        ctx2.state.pauseCursor = 0;
        ctx2.scheduler.paused = true;
        ctx2.tweens.paused = true;
      }
    }
    if (ctx2.state.paused) {
      updatePauseMenu();
      return;
    }
    if (!gs.turboEffectActive && ctx2.input.isTurboToggle()) {
      if (ctx2.state.turboMode) {
        ctx2.state.turboMode = 0;
      } else {
        startTurboEffect();
      }
    }
    if (gs.theWorldFlg) {
      for (let i = gs.enemies.length - 1; i >= 0; i--) {
        if (gs.enemies[i].explosionPlaying) enemyExplosionUpdate(gs.enemies[i]);
      }
      if (gs.turboEffectActive) {
        updateTurboEffect();
        return;
      }
      if (p.dead) {
        gs.resultTimer++;
        playerExplosionUpdate(p);
        if (gs.resultTimer > 90) {
          ctx2.state.score = ctx2.hud.scoreCount;
          ctx2.scenes.switch(SCENE_CONTINUE);
        }
        return;
      }
      if (gs.boss && gs.boss.deadFlg) {
        const boss = gs.boss;
        bossExplosionUpdate(ctx2, boss);
        if (boss.dead) {
          gs.resultTimer++;
        }
        if (gs.resultTimer > 75) {
          ctx2.state.playerHp = p.hp;
          ctx2.state.spgage = ctx2.hud.spgageCount;
          ctx2.state.score = ctx2.hud.scoreCount;
          ctx2.state.stageId++;
          if (ctx2.state.stageId > 4) {
            ctx2.scenes.switch(SCENE_ENDING);
          } else {
            ctx2.scenes.switch(SCENE_ADV);
          }
        }
        return;
      }
      if (gs.spFireActive) {
        updateSpFire();
      }
      return;
    }
    if (ctx2.input.isLeftHeld()) {
      p.targetX -= PLAYER_MOVE_SPEED;
    }
    if (ctx2.input.isRightHeld()) {
      p.targetX += PLAYER_MOVE_SPEED;
    }
    if (p.targetX < p.hitW / 2) p.targetX = p.hitW / 2;
    if (p.targetX > GW - p.hitW / 2) p.targetX = GW - p.hitW / 2;
    if (ctx2.input.isSpPressed() && ctx2.hud.spBtnActive && ctx2.hud.spgageCount >= ctx2.hud.spgageMax && !gs.spFireActive) {
      startSpFire();
    }
    playerLoop(ctx2, p);
    updateRemotePlayer2();
    const bulletArrays = gs.player2 ? [
      p.bullets,
      gs.player2.bullets
    ] : [
      p.bullets
    ];
    hudLoop(ctx2.hud);
    ctx2.hud.hpPercent = p.percent;
    if (gs.enemyWaveFlg) {
      gs.frameCnt += ctx2.state.turboMode ? 2 : 1;
      if (gs.frameCnt % gs.waveInterval === 0) {
        if (gs.waveCount >= gs.stageEnemyList.length) {
          spawnBoss();
          gs.enemyWaveFlg = 0;
        } else {
          spawnEnemyWave();
          gs.waveCount++;
        }
      }
    }
    for (let i = gs.enemies.length - 1; i >= 0; i--) {
      const e = gs.enemies[i];
      const result = enemyLoop(ctx2, e, p);
      if (result === 0) {
        gs.enemies.splice(i, 1);
        continue;
      }
      if (result === "shoot" && e.projectileData) {
        const proj = createProjectile({
          x: e.x + e.width / 2,
          y: e.y + e.hitH / 2,
          rotX: 0,
          rotY: 1,
          speed: e.projectileData.speed || 2,
          damage: e.projectileData.damage || 1,
          hp: e.projectileData.hp || 1,
          name: e.projectileData.name || "bullet",
          frames: e.projectileData.texture || [],
          atlas: e.projectileData.atlas || e.atlas || "game_asset"
        });
        gs.projectiles.push(proj);
        ctx2.sound.playSfx("se_shoot");
      }
      if (!e.deadFlg && e.y >= 40 && e.x >= -e.width / 2 && e.x <= GW - e.width / 2) {
        for (const bullets of bulletArrays) {
          for (let j = bullets.length - 1; j >= 0; j--) {
            const b = bullets[j];
            if (hitTestAABB(e.x + e.hitX, e.y + e.hitY, e.hitW, e.hitH, b.x, b.y, b.width, b.height)) {
              enemyOnDamage(ctx2, e, b.damage);
              b.hp -= 1;
              if (b.hp <= 0) {
                bullets.splice(j, 1);
              }
              ctx2.sound.playSfx("se_damage");
              if (e.deadFlg) {
                hudOnEnemyKill(ctx2.hud, e.score, e.spgage);
                if (e.itemName) {
                  gs.items.push({
                    x: e.x,
                    y: e.y,
                    name: e.itemName,
                    frames: e.itemTexture || [],
                    animFrame: 0,
                    animCounter: 0
                  });
                }
              }
            }
          }
        }
      }
      if (!e.deadFlg && !p.dead) {
        if (p.barrierFlg) {
          if (hitTestAABB(e.x + e.hitX, e.y + e.hitY, e.hitW, e.hitH, p.x + p.hitX, p.y - 15, p.hitW + 10, p.hitH + 20)) {
            enemyDead(ctx2, e);
            hudOnEnemyKill(ctx2.hud, e.score, e.spgage);
            ctx2.sound.playSfx("se_guard");
          }
        } else if (hitTestAABB(e.x + e.hitX + e.hitW * 0.1, e.y + e.hitY + e.hitH * 0.1, e.hitW * 0.8, e.hitH * 0.8, p.x + p.hitX, p.y + p.hitY, p.hitW, p.hitH)) {
          gamePlayerDamage(1);
          enemyDead(ctx2, e);
          hudOnEnemyKill(ctx2.hud, e.score, e.spgage);
        }
      }
    }
    if (gs.boss && !gs.boss.dead) {
      const boss = gs.boss;
      bossLoop(ctx2, boss);
      while (boss.pendingProjectiles.length > 0) {
        const pd = boss.pendingProjectiles.shift();
        if (pd) gs.projectiles.push(createProjectile(pd));
      }
      if (!boss.deadFlg && boss.entryDone) {
        for (const bullets of bulletArrays) {
          for (let j = bullets.length - 1; j >= 0; j--) {
            const b = bullets[j];
            if (hitTestAABB(boss.x + boss.hitX, boss.y + boss.hitY, boss.hitW, boss.hitH, b.x, b.y, b.width, b.height)) {
              bossOnDamage(ctx2, boss, b.damage);
              b.hp -= 1;
              if (b.hp <= 0) {
                bullets.splice(j, 1);
              }
              ctx2.sound.playSfx("se_damage");
              if (boss.deadFlg) {
                hudOnEnemyKill(ctx2.hud, boss.score, boss.spgage);
                gs.theWorldFlg = 1;
                gs.resultTimer = 0;
                p.shootOn = 0;
                ctx2.hud.spBtnActive = 0;
                ctx2.sound.playSound("voice_ko");
              }
            }
          }
        }
        if (!boss.deadFlg && !p.dead && !p.barrierFlg) {
          if (hitTestAABB(boss.x + boss.hitX, boss.y + boss.hitY, boss.hitW, boss.hitH, p.x + p.hitX, p.y + p.hitY, p.hitW, p.hitH)) {
            gamePlayerDamage(1);
          }
        }
      }
      if (gs.bossTimerStartFlg) {
        gs.bossTimerFrameCnt++;
        if (gs.bossTimerFrameCnt % 30 === 0) {
          gs.bossTimerCountDown--;
          ctx2.hud.bossTimerCount = gs.bossTimerCountDown;
          if (gs.bossTimerCountDown <= 0) {
            gs.bossTimerStartFlg = 0;
            gamePlayerDamage(9999);
          }
        }
      }
    }
    for (let i = gs.projectiles.length - 1; i >= 0; i--) {
      const proj = gs.projectiles[i];
      if (!projectileLoop(ctx2, proj, p)) {
        gs.projectiles.splice(i, 1);
        continue;
      }
      if (!p.dead) {
        if (p.barrierFlg) {
          if (hitTestAABB(proj.x - proj.width / 2, proj.y - proj.height / 2, proj.width, proj.height, p.x + p.hitX, p.y - 15, p.hitW + 10, p.hitH + 20)) {
            proj.deadFlg = 1;
            proj.dead = 1;
            gs.projectiles.splice(i, 1);
            ctx2.sound.playSfx("se_guard");
          }
        } else if (hitTestAABB(proj.x - proj.width / 2, proj.y - proj.height / 2, proj.width, proj.height, p.x + p.hitX, p.y + p.hitY, p.hitW, p.hitH)) {
          gamePlayerDamage(proj.damage);
          proj.deadFlg = 1;
          proj.dead = 1;
          gs.projectiles.splice(i, 1);
        }
      }
    }
    for (let i = gs.projectiles.length - 1; i >= 0; i--) {
      const proj = gs.projectiles[i];
      for (let j = p.bullets.length - 1; j >= 0; j--) {
        const b = p.bullets[j];
        if (hitTestAABB(proj.x - proj.width / 2, proj.y - proj.height / 2, proj.width, proj.height, b.x, b.y, b.width, b.height)) {
          proj.hp = (proj.hp || 1) - b.damage;
          b.hp -= 1;
          if (b.hp <= 0) {
            p.bullets.splice(j, 1);
          }
          if (proj.hp <= 0) {
            gs.projectiles.splice(i, 1);
            break;
          }
        }
      }
    }
    const tMul = ctx2.state.turboMode ? 2 : 1;
    for (let i = gs.items.length - 1; i >= 0; i--) {
      const item = gs.items[i];
      item.y += 1 * tMul;
      item.animCounter += 0.08;
      if (hitTestAABB(item.x, item.y, 16, 16, p.x + p.hitX, p.y + p.hitY, p.hitW, p.hitH)) {
        switch (item.name) {
          case "speed_high":
            ctx2.state.shootSpeed = item.name;
            playerShootSpeedChange(ctx2, p, ctx2.state.shootSpeed);
            break;
          case "barrier":
            playerBarrierStart(ctx2, p);
            break;
          default:
            if (p.shootMode !== item.name) {
              ctx2.state.shootSpeed = "speed_normal";
              playerShootSpeedChange(ctx2, p, ctx2.state.shootSpeed);
            }
            ctx2.state.shootMode = item.name;
            playerShootModeChange(ctx2, p, ctx2.state.shootMode);
            break;
        }
        gs.items.splice(i, 1);
        continue;
      }
      if (item.y >= GH - 10) {
        gs.items.splice(i, 1);
      }
    }
    gs.stageBgScrollY += 0.7 * tMul;
  }
  function draw() {
    const { Color: Color2, Draw } = ctx2.rt;
    drawStageBg();
    for (let i = 0; i < gs.items.length; i++) {
      const item = gs.items[i];
      if (item.frames && item.frames.length > 0) {
        const fi = Math.floor(item.animCounter) % item.frames.length;
        const itemAtlas = ctx2.atlas.hasFrame("level_atlas", ctx2.atlas.resolveFrameName("level_atlas", item.frames[fi])) ? "level_atlas" : "game_asset";
        const fname = ctx2.atlas.resolveFrameName(itemAtlas, item.frames[fi]);
        ctx2.atlas.drawFrame(itemAtlas, fname, ctx2.vp.toX(item.x + 8), ctx2.vp.toY(item.y + 8), ctx2.vp.scale, ctx2.vp.scale, 1, null);
      } else {
        Draw.rect(ctx2.vp.toX(item.x), ctx2.vp.toY(item.y), ctx2.vp.toW(12), ctx2.vp.toH(12), Color2.new(255, 255, 0));
      }
    }
    for (let i = 0; i < gs.enemies.length; i++) {
      enemyDraw(ctx2, gs.enemies[i]);
    }
    if (gs.boss) {
      bossDraw(ctx2, gs.boss);
    }
    for (let i = 0; i < gs.projectiles.length; i++) {
      projectileDraw(ctx2, gs.projectiles[i]);
    }
    if (gs.player) {
      playerDraw(ctx2, gs.player);
    }
    if (gs.player2) {
      playerDraw(ctx2, gs.player2);
    }
    if (gs.spFireActive && gs.player) {
      const spColor = Color2.new(255, 50, 50, 100);
      Draw.rect(ctx2.vp.toX(gs.player.x + 12), ctx2.vp.toY(gs.player.y - gs.spLineH), ctx2.vp.toW(3), ctx2.vp.toH(gs.spLineH), spColor);
    }
    hudDraw(ctx2);
    if (ctx2.scenes.timer < 90) {
      const titleAlpha = ctx2.scenes.timer < 60 ? 1 : 1 - (ctx2.scenes.timer - 60) / 30;
      const ta = Math.floor(titleAlpha * 128);
      const titleColor = Color2.new(255, 255, 255, ta);
      ctx2.font.print(ctx2.vp.toX(GCX - 30), ctx2.vp.toY(GCY - 40), "ROUND " + String(ctx2.state.stageId + 1), titleColor);
    }
    if (ctx2.scenes.timer >= 40 && ctx2.scenes.timer < 100) {
      const fightAlpha = ctx2.scenes.timer < 80 ? 1 : 1 - (ctx2.scenes.timer - 80) / 20;
      const fa = Math.floor(fightAlpha * 128);
      const fightColor = Color2.new(255, 200, 0, fa);
      ctx2.font.print(ctx2.vp.toX(GCX - 20), ctx2.vp.toY(GCY), "FIGHT!", fightColor);
    }
    if (gs.player && gs.player.dead && gs.resultTimer > 30) {
      ctx2.font.print(ctx2.vp.toX(GCX - 20), ctx2.vp.toY(GCY - 10), "K.O.", Color2.new(255, 60, 60));
    }
    if (gs.boss && gs.boss.dead && gs.resultTimer > 20) {
      ctx2.font.print(ctx2.vp.toX(GCX - 35), ctx2.vp.toY(GCY - 10), "STAGE CLEAR!", Color2.new(255, 255, 0));
    }
    if (ctx2.state.turboMode && !gs.turboEffectActive) {
      const turboFlicker = ctx2.scenes.timer % 20 < 14 ? 1 : 0.5;
      const tc = Color2.new(255, 100, 0, Math.floor(turboFlicker * 128));
      ctx2.font.print(ctx2.vp.toX(GW - 52), ctx2.vp.toY(GH - 18), "TURBO", tc);
    }
    if (gs.turboEffectActive || gs.turboBlackoutAlpha > 0) {
      drawTurboEffect();
    }
    if (ctx2.state.paused) {
      drawPauseMenu();
    }
  }
  function drawStageBg() {
    const stageKey = "stage_loop" + String(ctx2.state.stageId);
    if (ctx2.atlas.hasFrame("game_ui", stageKey)) {
      const bgH = 480;
      const scrollY = gs.stageBgScrollY % bgH;
      ctx2.atlas.drawFrameTL("game_ui", stageKey, ctx2.vp.toX(0), ctx2.vp.toY(-bgH + scrollY), ctx2.vp.scale, ctx2.vp.scale, 1);
      ctx2.atlas.drawFrameTL("game_ui", stageKey, ctx2.vp.toX(0), ctx2.vp.toY(scrollY), ctx2.vp.scale, ctx2.vp.scale, 1);
    } else {
      const { Color: Color2, Draw } = ctx2.rt;
      const bgColors = [
        Color2.new(20, 20, 60),
        Color2.new(40, 15, 15),
        Color2.new(15, 40, 15),
        Color2.new(30, 15, 40),
        Color2.new(40, 30, 10)
      ];
      const bgColor = bgColors[ctx2.state.stageId % bgColors.length];
      Draw.rect(ctx2.vp.toX(0), ctx2.vp.toY(0), ctx2.vp.toW(GW), ctx2.vp.toH(GH), bgColor);
    }
  }
  function spawnEnemyWave() {
    const recipe = ctx2.state.recipe;
    if (!recipe || !recipe.enemyData) return;
    const row = gs.stageEnemyList[gs.waveCount] || [];
    const cols = row.length || 8;
    const cellW = GW / cols;
    for (let i = 0; i < row.length; i++) {
      const code = String(row[i]);
      if (code === "00") continue;
      const enemyType = code.slice(0, -1);
      const itemCode = code.slice(-1);
      const eData = recipe.enemyData["enemy" + enemyType];
      if (!eData) continue;
      const enemy = createEnemy(ctx2, eData);
      enemy.x = cellW * i + cellW / 2 - enemy.width / 2;
      enemy.y = -32;
      switch (itemCode) {
        case "1":
          enemy.itemName = "big";
          enemy.itemTexture = [
            "powerupBig0.gif",
            "powerupBig1.gif"
          ];
          break;
        case "2":
          enemy.itemName = "3way";
          enemy.itemTexture = [
            "powerup3way0.gif",
            "powerup3way1.gif"
          ];
          break;
        case "3":
          enemy.itemName = "speed_high";
          enemy.itemTexture = [
            "speedupItem0.gif",
            "speedupItem1.gif"
          ];
          break;
        case "9":
          enemy.itemName = "barrier";
          enemy.itemTexture = [
            "barrierItem0.gif",
            "barrierItem1.gif"
          ];
          break;
      }
      gs.enemies.push(enemy);
    }
  }
  function spawnBoss() {
    const recipe = ctx2.state.recipe;
    if (!recipe || !recipe.bossData) return;
    const bossData = recipe.bossData["boss" + String(ctx2.state.stageId)];
    if (!bossData) return;
    const boss = createBoss(ctx2, bossData, ctx2.state.stageId);
    gs.boss = boss;
    boss.x = GCX - boss.width / 2;
    boss.moveTargetX = boss.x;
    bossEntry(ctx2, boss);
    ctx2.scheduler.delayedCall(6e3, () => {
      gs.bossTimerStartFlg = 1;
      gs.bossTimerCountDown = 99;
      gs.bossTimerFrameCnt = 0;
      ctx2.hud.bossTimerVisible = 1;
      ctx2.hud.bossTimerCount = 99;
    });
    ctx2.hud.spBtnActive = 1;
    ctx2.sound.playSound("voice_another_fighter");
  }
  function ensurePlayer2() {
    const recipe = ctx2.state.recipe;
    const playerData = recipe ? recipe.playerData : null;
    if (!playerData) return;
    const p2 = createPlayer(playerData);
    playerSetUp(p2, ctx2.state.playerMaxHp || playerData.maxHp || 0, ctx2.state.shootMode || "normal", ctx2.state.shootSpeed || "speed_normal");
    p2.x = GW * 0.65 - p2.width / 2;
    p2.y = GH - 96 - p2.height / 2;
    p2.targetX = GW * 0.65;
    p2.targetY = p2.y;
    p2.shootOn = 1;
    gs.player2 = p2;
  }
  function updateRemotePlayer2() {
    const frame2 = net?.remoteInput?.() ?? null;
    if (!frame2) {
      gs.player2 = null;
      return;
    }
    if (!gs.player2) ensurePlayer2();
    const p2 = gs.player2;
    if (!p2) return;
    if (frame2.touchX != null) {
      p2.targetX = frame2.touchX;
    } else {
      if (frame2.left) p2.targetX -= PLAYER_MOVE_SPEED;
      if (frame2.right) p2.targetX += PLAYER_MOVE_SPEED;
    }
    if (p2.targetX < p2.hitW / 2) p2.targetX = p2.hitW / 2;
    if (p2.targetX > GW - p2.hitW / 2) p2.targetX = GW - p2.hitW / 2;
    p2.shootOn = frame2.fire ? 1 : 0;
    playerLoop(ctx2, p2);
  }
  function gamePlayerDamage(amount) {
    const p = gs.player;
    if (!p || p.dead) return;
    playerOnDamage(ctx2, p, amount);
    ctx2.hud.hpPercent = p.percent;
    if (p.dead) {
      gs.theWorldFlg = 1;
      gs.resultTimer = 0;
      ctx2.state.score = ctx2.hud.scoreCount;
      ctx2.hud.spBtnActive = 0;
      if (gs.boss) gs.boss.theWorld = 1;
    }
  }
  function startSpFire() {
    gs.spFireActive = 1;
    gs.spFireTimer = 0;
    gs.spLineH = 0;
    gs.theWorldFlg = 1;
    ctx2.hud.spFireFlg = 1;
    ctx2.hud.spgageCount = 0;
    ctx2.hud.spBtnActive = 0;
    if (gs.boss) gs.boss.theWorld = 1;
    ctx2.sound.playSound("g_sp_voice");
    ctx2.sound.playSound("se_sp");
  }
  function updateSpFire() {
    gs.spFireTimer++;
    if (gs.spFireTimer < 30) {
      gs.spLineH = gs.spFireTimer / 30 * GH;
    } else if (gs.spFireTimer < 90) {
      if (gs.spFireTimer % 4 === 0) {
        ctx2.sound.playSound("se_sp_explosion");
      }
    } else if (gs.spFireTimer === 90) {
      const spDamage = ctx2.state.spDamage || 50;
      for (let i = gs.enemies.length - 1; i >= 0; i--) {
        enemyOnDamage(ctx2, gs.enemies[i], spDamage);
        if (gs.enemies[i].deadFlg) {
          hudOnEnemyKill(ctx2.hud, gs.enemies[i].score, gs.enemies[i].spgage);
        }
      }
      if (gs.boss && !gs.boss.deadFlg) {
        bossOnDamage(ctx2, gs.boss, spDamage);
        if (gs.boss.deadFlg) {
          hudOnEnemyKill(ctx2.hud, gs.boss.score, gs.boss.spgage);
          gs.resultTimer = 0;
          ctx2.sound.playSound("voice_ko");
        }
      }
      gs.projectiles = [];
    } else if (gs.spFireTimer >= 120) {
      gs.spFireActive = 0;
      gs.spLineH = 0;
      ctx2.hud.spFireFlg = 0;
      if (gs.boss && !gs.boss.deadFlg) {
        gs.theWorldFlg = 0;
        gs.boss.theWorld = 0;
      }
    }
  }
  function startTurboEffect() {
    gs.turboEffectActive = 1;
    gs.turboImpacts = [];
    gs.turboFlashAlpha = 0;
    gs.turboBlackoutAlpha = 0.8;
    gs.theWorldFlg = 1;
    if (gs.boss) gs.boss.theWorld = 1;
    ctx2.sound.playSfx("se_sp");
    for (let i = 0; i < 10; i++) {
      ctx2.scheduler.delayedCall(50 + 50 * i, () => {
        const ix = Math.random() * (GW - 60) + 30;
        const iy = Math.random() * (GH - 200) + 80;
        gs.turboImpacts.push({
          x: ix,
          y: iy,
          frame: 0,
          timer: 0
        });
        gs.turboFlashAlpha = 0.2;
        ctx2.sound.playSfx("se_damage");
      });
      ctx2.scheduler.delayedCall(50 + 50 * i + 60, () => {
        gs.turboFlashAlpha = 0;
      });
    }
    ctx2.scheduler.delayedCall(700, () => {
      gs.turboBlackoutAlpha = 0;
      gs.turboFlashAlpha = 0;
      gs.turboEffectActive = 0;
      gs.theWorldFlg = 0;
      if (gs.boss) gs.boss.theWorld = 0;
      ctx2.state.turboMode = 1;
    });
  }
  function updateTurboEffect() {
    for (let i = gs.turboImpacts.length - 1; i >= 0; i--) {
      const imp = gs.turboImpacts[i];
      imp.timer++;
      if (imp.timer % 2 === 0) imp.frame++;
      if (imp.frame > 4) {
        gs.turboImpacts.splice(i, 1);
      }
    }
  }
  function drawTurboEffect() {
    const { Color: Color2, Draw } = ctx2.rt;
    if (gs.turboBlackoutAlpha > 0) {
      const ba = Math.floor(gs.turboBlackoutAlpha * 128);
      Draw.rect(0, 0, SCREEN_W, SCREEN_H, Color2.new(0, 0, 0, ba));
    }
    for (let i = 0; i < gs.turboImpacts.length; i++) {
      const imp = gs.turboImpacts[i];
      const hitFrame = "hit" + String(Math.min(imp.frame, 4)) + ".gif";
      const fname = ctx2.atlas.resolveFrameName("game_asset", hitFrame);
      if (ctx2.atlas.hasFrame("game_asset", fname)) {
        ctx2.atlas.drawFrame("game_asset", fname, ctx2.vp.toX(imp.x), ctx2.vp.toY(imp.y), ctx2.vp.scale * 1.5, ctx2.vp.scale * 1.5, 1, null);
      }
    }
    if (gs.turboFlashAlpha > 0) {
      const fa = Math.floor(gs.turboFlashAlpha * 128);
      Draw.rect(0, 0, SCREEN_W, SCREEN_H, Color2.new(255, 255, 255, fa));
    }
  }
  function updatePauseMenu() {
    if (ctx2.input.isUpPressed()) {
      ctx2.state.pauseCursor--;
      if (ctx2.state.pauseCursor < 0) ctx2.state.pauseCursor = 1;
    }
    if (ctx2.input.isDownPressed()) {
      ctx2.state.pauseCursor++;
      if (ctx2.state.pauseCursor > 1) ctx2.state.pauseCursor = 0;
    }
    if (ctx2.input.isConfirmPressed()) {
      if (ctx2.state.pauseCursor === 0) {
        ctx2.state.paused = 0;
        ctx2.scheduler.paused = false;
        ctx2.tweens.paused = false;
      } else {
        ctx2.state.paused = 0;
        ctx2.scheduler.paused = false;
        ctx2.tweens.paused = false;
        ctx2.sound.stopAllSounds();
        ctx2.scenes.switch(SCENE_TITLE);
      }
    }
  }
  function drawPauseMenu() {
    const { Color: Color2, Draw } = ctx2.rt;
    Draw.rect(0, 0, SCREEN_W, SCREEN_H, Color2.new(0, 0, 0, 80));
    const menuX = GCX - 40;
    const menuY = GCY - 40;
    const white = Color2.new(255, 255, 255);
    const gray = Color2.new(100, 100, 100);
    const yellow = Color2.new(255, 255, 0);
    ctx2.font.print(ctx2.vp.toX(menuX - 2), ctx2.vp.toY(menuY), "PAUSE", white);
    const items = [
      "RESUME",
      "QUIT"
    ];
    for (let i = 0; i < items.length; i++) {
      const iy = menuY + 30 + i * 20;
      const col = i === ctx2.state.pauseCursor ? yellow : gray;
      if (i === ctx2.state.pauseCursor) {
        ctx2.font.print(ctx2.vp.toX(menuX - 2), ctx2.vp.toY(iy), ">", yellow);
      }
      ctx2.font.print(ctx2.vp.toX(menuX + 10), ctx2.vp.toY(iy), items[i], col);
    }
    ctx2.font.print(ctx2.vp.toX(menuX - 10), ctx2.vp.toY(menuY + 80), "START:BACK", Color2.new(140, 140, 140));
  }
  return {
    init,
    update,
    draw
  };
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/scenes/continue.ts
function createContinueScene(ctx2) {
  const cs = {
    countDown: 9,
    countDownTimer: 0,
    selection: -1,
    cursorPos: 0,
    gameOverShown: 0,
    gameOverTimer: 0
  };
  function init() {
    cs.countDown = 9;
    cs.countDownTimer = 0;
    cs.selection = -1;
    cs.cursorPos = 0;
    cs.gameOverShown = 0;
    cs.gameOverTimer = 0;
    ctx2.sound.stopAllSounds();
    ctx2.sound.playBgm("bgm_continue");
  }
  function continueSelectYes() {
    cs.selection = 0;
    const voiceIdx = Math.floor(Math.random() * 3);
    ctx2.sound.playSound("g_continue_yes_voice" + String(voiceIdx));
    ctx2.sound.stopBgm();
    const recipe = ctx2.state.recipe;
    const playerData = recipe ? recipe.playerData : null;
    if (playerData) {
      ctx2.state.playerMaxHp = playerData.maxHp ?? 0;
      ctx2.state.playerHp = ctx2.state.playerMaxHp;
      ctx2.state.shootMode = playerData.defaultShootName || "normal";
      ctx2.state.shootSpeed = playerData.defaultShootSpeed || "speed_normal";
    }
    ctx2.state.continueCnt++;
    ctx2.state.score = ctx2.state.continueCnt;
    ctx2.scenes.switch(SCENE_GAME);
  }
  function continueSelectNo() {
    cs.selection = 1;
    cs.gameOverShown = 1;
    cs.gameOverTimer = 0;
    ctx2.sound.playSound("voice_gameover");
    ctx2.sound.playSound("bgm_gameover");
    if (ctx2.state.score > ctx2.state.highScore) {
      ctx2.state.highScore = ctx2.state.score;
    }
    saveHighScore(ctx2);
    const voiceIdx = Math.floor(Math.random() * 2);
    ctx2.sound.playSound("g_continue_no_voice" + String(voiceIdx));
  }
  function update() {
    if (cs.gameOverShown) {
      cs.gameOverTimer++;
      if (cs.gameOverTimer > 90 && ctx2.input.isConfirmPressed()) {
        ctx2.scenes.switch(SCENE_TITLE);
      }
      return;
    }
    cs.countDownTimer++;
    if (cs.countDownTimer % 40 === 0 && cs.countDown >= 0) {
      ctx2.sound.playSound("voice_countdown" + String(cs.countDown));
      cs.countDown--;
    }
    if (cs.countDown < 0 && cs.selection === -1) {
      continueSelectNo();
      return;
    }
    if (ctx2.input.isLeftHeld() || ctx2.input.isRightHeld()) {
      cs.cursorPos = cs.cursorPos === 0 ? 1 : 0;
    }
    if (ctx2.input.isConfirmPressed()) {
      if (cs.cursorPos === 0) {
        continueSelectYes();
      } else {
        continueSelectNo();
      }
    }
  }
  function draw() {
    const { Color: Color2, Draw } = ctx2.rt;
    const black = Color2.new(0, 0, 0);
    const white = Color2.new(255, 255, 255);
    const yellow = Color2.new(255, 255, 0);
    const red = Color2.new(255, 60, 60);
    const gray = Color2.new(128, 128, 128);
    Draw.rect(0, 0, SCREEN_W, SCREEN_H, black);
    if (cs.gameOverShown) {
      ctx2.font.print(ctx2.vp.toX(GCX - 40), ctx2.vp.toY(GCY - 60), "GAME OVER", red);
      ctx2.font.print(ctx2.vp.toX(40), ctx2.vp.toY(GCY), "SCORE", white);
      ctx2.font.print(ctx2.vp.toX(100), ctx2.vp.toY(GCY), String(ctx2.state.score), yellow);
      ctx2.font.print(ctx2.vp.toX(40), ctx2.vp.toY(GCY + 20), "HI-SCORE", white);
      ctx2.font.print(ctx2.vp.toX(120), ctx2.vp.toY(GCY + 20), String(ctx2.state.highScore), yellow);
      ctx2.font.print(ctx2.vp.toX(40), ctx2.vp.toY(GCY + 40), "MAX COMBO", white);
      ctx2.font.print(ctx2.vp.toX(130), ctx2.vp.toY(GCY + 40), String(ctx2.hud.maxCombo), yellow);
      if (cs.gameOverTimer > 90) {
        if (ctx2.scenes.timer % 40 < 30) {
          ctx2.font.print(ctx2.vp.toX(GCX - 50), ctx2.vp.toY(GH - 60), "PRESS START", white);
        }
      }
      return;
    }
    if (ctx2.atlas.hasFrame("game_ui", ctx2.atlas.resolveFrameName("game_ui", "continueTitle.gif"))) {
      ctx2.atlas.drawFrame("game_ui", ctx2.atlas.resolveFrameName("game_ui", "continueTitle.gif"), ctx2.vp.toX(GCX), ctx2.vp.toY(90), ctx2.vp.scale, ctx2.vp.scale, 1, null);
    } else {
      ctx2.font.print(ctx2.vp.toX(GCX - 40), ctx2.vp.toY(70), "CONTINUE?", white);
    }
    if (ctx2.atlas.hasFrame("game_ui", ctx2.atlas.resolveFrameName("game_ui", "continueFace0.gif"))) {
      const faceFrame = ctx2.scenes.timer % 20 < 10 ? "continueFace0.gif" : "continueFace1.gif";
      ctx2.atlas.drawFrame("game_ui", ctx2.atlas.resolveFrameName("game_ui", faceFrame), ctx2.vp.toX(60), ctx2.vp.toY(180), ctx2.vp.scale, ctx2.vp.scale, 1, null);
    }
    const countStr = cs.countDown >= 0 ? String(cs.countDown) : "0";
    ctx2.font.print(ctx2.vp.toX(160), ctx2.vp.toY(160), countStr, cs.countDown <= 3 ? red : yellow);
    const yesColor = cs.cursorPos === 0 ? yellow : gray;
    const noColor = cs.cursorPos === 1 ? yellow : gray;
    ctx2.font.print(ctx2.vp.toX(GCX - 60), ctx2.vp.toY(GCY + 50), "YES", yesColor);
    ctx2.font.print(ctx2.vp.toX(GCX + 30), ctx2.vp.toY(GCY + 50), "NO", noColor);
    const cursorX = cs.cursorPos === 0 ? GCX - 70 : GCX + 20;
    ctx2.font.print(ctx2.vp.toX(cursorX), ctx2.vp.toY(GCY + 50), ">", white);
  }
  return {
    init,
    update,
    draw
  };
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/scenes/ending.ts
function createEndingScene(ctx2) {
  const es = {
    timer: 0,
    scrollY: 0,
    phase: 0
  };
  function init() {
    es.timer = 0;
    es.scrollY = 0;
    es.phase = 0;
    ctx2.sound.stopAllSounds();
    ctx2.sound.playSound("voice_congra");
  }
  function update() {
    es.timer++;
    es.scrollY += 0.5;
    if (es.timer > 600 && ctx2.input.isConfirmPressed()) {
      resetGameState(ctx2.state);
      ctx2.scenes.switch(SCENE_TITLE);
    }
    if (es.timer > 900) {
      resetGameState(ctx2.state);
      ctx2.scenes.switch(SCENE_TITLE);
    }
  }
  function draw() {
    const { Color: Color2, Draw } = ctx2.rt;
    const black = Color2.new(0, 0, 0);
    const white = Color2.new(255, 255, 255);
    const yellow = Color2.new(255, 255, 0);
    Draw.rect(0, 0, SCREEN_W, SCREEN_H, black);
    const congAlpha = Math.min(es.timer / 60, 1);
    const ca = Math.floor(congAlpha * 128);
    const congColor = Color2.new(255, 255, 0, ca);
    ctx2.font.print(ctx2.vp.toX(GCX - 60), ctx2.vp.toY(40), "CONGRATULATIONS!", congColor);
    if (es.timer > 60) {
      ctx2.font.print(ctx2.vp.toX(40), ctx2.vp.toY(100), "FINAL SCORE", white);
      ctx2.font.print(ctx2.vp.toX(40), ctx2.vp.toY(120), String(ctx2.state.score), yellow);
      ctx2.font.print(ctx2.vp.toX(40), ctx2.vp.toY(150), "MAX COMBO", white);
      ctx2.font.print(ctx2.vp.toX(40), ctx2.vp.toY(170), String(ctx2.hud.maxCombo), yellow);
      ctx2.font.print(ctx2.vp.toX(40), ctx2.vp.toY(200), "CONTINUES", white);
      ctx2.font.print(ctx2.vp.toX(40), ctx2.vp.toY(220), String(ctx2.state.continueCnt), yellow);
    }
    if (es.timer > 180) {
      const credY = 300 - es.scrollY + 90;
      const credits = [
        "ORIGINAL GAME",
        "CAPCOM",
        "",
        "PS2 PORT",
        "AthenaEnv v4",
        "",
        "PROGRAMMING",
        "Claude Code",
        "",
        "SPECIAL THANKS",
        "Seamus McNamara",
        "",
        "THANK YOU",
        "FOR PLAYING!"
      ];
      for (let i = 0; i < credits.length; i++) {
        const cy = ctx2.vp.toY(credY + i * 20);
        if (cy > 0 && cy < SCREEN_H) {
          ctx2.font.print(ctx2.vp.toX(GCX - 50), cy, credits[i], white);
        }
      }
    }
    if (es.timer > 600) {
      if (ctx2.scenes.timer % 40 < 30) {
        ctx2.font.print(ctx2.vp.toX(GCX - 50), ctx2.vp.toY(GH - 40), "PRESS START", white);
      }
    }
  }
  return {
    init,
    update,
    draw
  };
}

// deno:https://jsr.io/@easierbycode/svelte-ps2/1.1.1/src/ps2-sp/game.ts
var DEFAULT_LEVEL = {
  dataPath: "assets/level_foo.json",
  atlasPngPath: "assets/level_foo_atlas.png",
  atlasJsonPath: "assets/level_foo_atlas.json"
};
function createGame(rt, options = {}) {
  const resolved = {
    sound: options.sound ?? createNullSound(),
    level: options.level === void 0 ? DEFAULT_LEVEL : options.level,
    startScene: options.startScene ?? SCENE_TITLE,
    net: options.net ?? null
  };
  const vp = new Viewport({
    gameWidth: GW,
    gameHeight: GH,
    screenWidth: SCREEN_W,
    screenHeight: SCREEN_H
  });
  const tweens = new TweenManager();
  const scheduler = new Scheduler();
  const atlas = new AtlasManager(rt);
  const scenes = new SceneManager({
    rt,
    screenWidth: SCREEN_W,
    screenHeight: SCREEN_H,
    beforeInit: () => {
      tweens.killAll();
      scheduler.clear();
    }
  });
  const ctx2 = {
    rt,
    vp,
    atlas,
    tweens,
    scheduler,
    scenes,
    state: createGameState(),
    hud: createHudState(),
    input: createInput(rt),
    sound: resolved.sound,
    font: createGameFont(rt, vp)
  };
  ctx2.state.highScore = loadSavedHighScore(rt);
  ctx2.state.localHighScore = ctx2.state.highScore;
  ctx2.sound.init();
  loadAllAssets(ctx2, resolved);
  scenes.register(SCENE_TITLE, createTitleScene(ctx2));
  scenes.register(SCENE_ADV, createAdvScene(ctx2));
  scenes.register(SCENE_GAME, createGameScene(ctx2, resolved.net));
  scenes.register(SCENE_CONTINUE, createContinueScene(ctx2));
  scenes.register(SCENE_ENDING, createEndingScene(ctx2));
  scenes.switchImmediate(resolved.startScene);
  const clock = rt.Timer.new();
  const step = new FixedStep({
    fps: FPS,
    now: () => rt.Timer.getTime(clock) / 1e3
  });
  rt.Screen.display(() => {
    step.tick(() => {
      ctx2.input.update();
      ctx2.scheduler.update(FRAME_MS);
      ctx2.tweens.update(FRAME_MS);
      ctx2.scenes.update();
    });
    ctx2.scenes.draw();
    vp.drawLetterbox(rt);
  });
  return {
    ctx: ctx2
  };
}

// packages/shmup-harbor/lib/ps2/runtime-sound.ts
var SFX_VOICES = 4;
function adpPath(path) {
  return soundPath(path, ".adp");
}
function wavPath(path) {
  return soundPath(path, ".wav");
}
function soundPath(path, extension) {
  return "assets/sounds/" + soundStem(path) + extension;
}
function soundStem(path) {
  return path.replace(/^.*\//, "").replace(/\.[^.]*$/, "");
}
function canOpen(path) {
  const std = globalThis.std;
  if (!std || typeof std.open !== "function") return true;
  try {
    const file = std.open(path, "rb");
    if (!file) return false;
    file.close();
    return true;
  } catch {
    return false;
  }
}
function toAudsrvVolume(volume) {
  return Math.max(0, Math.min(100, Math.round(volume * 100)));
}
function createAthenaSound() {
  const Sound = globalThis.Sound;
  const silent = {
    init() {
    },
    loadSfx() {
    },
    loadStream() {
    },
    playSfx() {
    },
    playSound() {
    },
    playBgm() {
    },
    stopBgm() {
    },
    stopAllSounds() {
    },
    pump() {
    }
  };
  const audsrv = globalThis.__PS2_AUDSRV__;
  if (audsrv === false) return silent;
  if (!Sound || typeof Sound.Sfx !== "function") return silent;
  const canStream = typeof Sound.Stream === "function";
  const staged = globalThis.__PS2_SFX__;
  const stagedSfx = Array.isArray(staged) ? Object.fromEntries(staged.map((key) => [
    String(key),
    true
  ])) : null;
  const sfx = {};
  const streamPaths = {};
  const voices = {};
  let struck = {};
  const bgm = globalThis.__PS2_BGM__;
  const stagedBgm = bgm && Array.isArray(bgm.tracks) ? Object.fromEntries(bgm.tracks.map((key) => [
    String(key),
    true
  ])) : null;
  const bgmAlias = bgm && bgm.alias && typeof bgm.alias === "object" ? bgm.alias : {};
  if (stagedBgm) {
    for (const key of Object.keys(stagedBgm)) {
      streamPaths[key] = soundPath(key, ".wav");
    }
  }
  const trackKey = (key) => Object.prototype.hasOwnProperty.call(bgmAlias, key) ? bgmAlias[key] : key;
  let track = null;
  let trackLoops = false;
  let trackRunning = false;
  const channel = () => {
    try {
      const ch = Sound.findChannel();
      if (typeof ch !== "number") return 0;
      return ch >= 0 ? ch : -1;
    } catch {
      return 0;
    }
  };
  const prune = (s, mine) => {
    if (typeof s.playing !== "function") {
      mine.length = 0;
      return;
    }
    for (let i = mine.length - 1; i >= 0; i--) {
      let on = false;
      try {
        on = !!s.playing(mine[i]);
      } catch {
      }
      if (!on) mine.splice(i, 1);
    }
  };
  const dropTrack = () => {
    if (!track) return;
    const going = track;
    track = null;
    trackLoops = false;
    trackRunning = false;
    try {
      going.pause();
      going.free();
    } catch {
    }
  };
  const startTrack = (key, loop, volume) => {
    const path = streamPaths[trackKey(key)];
    if (!canStream || !path) return;
    dropTrack();
    if (!canOpen(path)) return;
    try {
      const next = Sound.Stream(path);
      if (volume !== void 0 && typeof next.volume === "number") {
        next.volume = toAudsrvVolume(volume);
      }
      next.play();
      track = next;
      trackLoops = loop;
      trackRunning = false;
    } catch {
    }
  };
  const fireSfx = (key, volume) => {
    const s = sfx[key];
    if (!s || struck[key]) return;
    struck[key] = true;
    const mine = voices[key] ?? (voices[key] = []);
    if (mine.length >= SFX_VOICES) prune(s, mine);
    if (mine.length >= SFX_VOICES) return;
    const ch = channel();
    if (ch < 0) return;
    try {
      if (volume !== void 0 && typeof s.volume === "number") {
        s.volume = toAudsrvVolume(volume);
      }
      s.play(ch);
      const again = mine.indexOf(ch);
      if (again >= 0) mine.splice(again, 1);
      mine.push(ch);
    } catch {
    }
  };
  return {
    init() {
      try {
        Sound.setVolume(100);
      } catch {
      }
    },
    loadSfx(key, path) {
      const file = adpPath(path);
      if (stagedSfx && !stagedSfx[soundStem(file)]) return;
      if (!canOpen(file)) return;
      try {
        sfx[key] = Sound.Sfx(file);
      } catch {
      }
    },
    // Just the path: nothing is opened until something plays it. A track the
    // build left off the disc is not even that.
    loadStream(key, path) {
      const file = wavPath(path);
      if (stagedBgm && !stagedBgm[soundStem(file)]) return;
      streamPaths[key] = file;
    },
    playSfx: fireSfx,
    // The port fires `bgm_gameover` — a stream — through playSound, so this
    // has to serve both. A track reached this way is a jingle and plays once;
    // only playBgm loops.
    playSound(key, volume) {
      if (streamPaths[trackKey(key)] !== void 0) {
        startTrack(key, false, volume);
      } else fireSfx(key, volume);
    },
    playBgm(key, volume) {
      startTrack(key, true, volume);
    },
    stopBgm: dropTrack,
    stopAllSounds() {
      dropTrack();
    },
    pump() {
      struck = {};
      if (!track || !trackLoops) return;
      try {
        if (!trackRunning) {
          if (track.playing()) trackRunning = true;
          return;
        }
        if (!track.playing()) {
          track.rewind();
          track.play();
        }
      } catch {
        trackLoops = false;
      }
    }
  };
}

// packages/shmup-harbor/lib/ps2/runtime-entry.ts
var screen = globalThis.Screen;
var uncapped = globalThis.__PS2_UNCAPPED__ === true;
if (screen) {
  if (typeof screen.setParam === "function" && typeof screen.DEPTH_TEST_ENABLE === "number") {
    screen.setParam(screen.DEPTH_TEST_ENABLE, 0);
  }
  if (typeof screen.setVSync === "function") screen.setVSync(!uncapped);
  if (uncapped && typeof screen.setFrameCounter === "function") {
    screen.setFrameCounter(true);
  }
}
var runtime = createNativeRuntime();
var GAME_FPS = globalThis.__PS2_GAME_FPS__ ?? 30;
var rate = GAME_FPS / 30;
var ctx = null;
var inGame = () => ctx !== null && ctx.scenes.current === SCENE_GAME;
if (rate !== 1) {
  const base = runtime.Timer;
  let virtualUs = 0;
  let lastRealUs = 0;
  let started = false;
  runtime.Timer = {
    ...base,
    getTime: (timer) => {
      const real = base.getTime(timer);
      if (!started) {
        lastRealUs = real;
        started = true;
      }
      virtualUs += (real - lastRealUs) * (inGame() ? rate : 1);
      lastRealUs = real;
      return virtualUs;
    }
  };
  const pads = runtime.Pads;
  const realPad = pads.get();
  const DIRECTIONS = [
    pads.UP,
    pads.DOWN,
    pads.LEFT,
    pads.RIGHT
  ];
  let logicStep = 0;
  const steering = () => inGame() && !ctx.state.paused && logicStep % rate !== 0;
  const gatedPad = {
    update: () => {
      logicStep++;
      realPad.update();
    },
    pressed: (mask) => DIRECTIONS.indexOf(mask) !== -1 && steering() ? false : realPad.pressed(mask),
    justPressed: (mask) => realPad.justPressed(mask),
    get lx() {
      return steering() ? 0 : realPad.lx;
    },
    get ly() {
      return steering() ? 0 : realPad.ly;
    },
    get rx() {
      return realPad.rx;
    },
    get ry() {
      return realPad.ry;
    }
  };
  runtime.Pads = {
    ...pads,
    get: () => gatedPad
  };
}
var sound = createAthenaSound();
var game = createGame(runtime, {
  sound,
  // Paths are relative to the boot directory: `cdfs:/` on a disc, the app's
  // own folder on a USB stick. lib/ps2/build.ts writes exactly these three.
  level: {
    dataPath: "assets/level.json",
    atlasPngPath: "assets/level_atlas.png",
    atlasJsonPath: "assets/level_atlas.json"
  }
});
ctx = game.ctx;
globalThis.__PS2_CTX__ = ctx;
var pad = runtime.Pads.get();
var START = runtime.Pads.START;
var startWasDown = false;
var L = [
  runtime.Pads.L1,
  runtime.Pads.L2
];
var R = [
  runtime.Pads.R1,
  runtime.Pads.R2
];
var STARTS = [
  START,
  runtime.Pads.SELECT
];
var held = (masks) => masks.some((mask) => pad.pressed(mask));
var state = ctx.state;
function frame() {
  const startDown = pad.pressed(START);
  const startPressed = startDown && !startWasDown;
  startWasDown = startDown;
  const pausedBefore = game.ctx.state.paused;
  const titleWaiting = game.ctx.scenes.current === SCENE_TITLE && !game.ctx.scenes.fading;
  runtime.tick();
  sound.pump();
  if (titleWaiting && game.ctx.scenes.fading) {
    const god = held(STARTS) && held(L) && held(R);
    state.godMode = god ? 1 : 0;
    if (god) sound.playSound("se_correct");
  }
  if (startPressed && game.ctx.scenes.current === SCENE_GAME) {
    const paused = !pausedBefore;
    game.ctx.state.paused = paused ? 1 : 0;
    game.ctx.scheduler.paused = paused;
    game.ctx.tweens.paused = paused;
  }
}
var hostLoop = globalThis.__PS2_HOST_LOOP__;
if (typeof hostLoop === "function") hostLoop(frame);
else for (; ; ) frame();
