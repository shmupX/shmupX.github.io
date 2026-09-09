(function () {
  "use strict";

  const root = globalThis;
  if (!root.navigator) return;

  const existing = root.CMGGamepadCompat;
  if (existing && existing.install) {
    existing.install();
    return;
  }

  const SNES_PAD_RE =
    /SNES Controller|Nintendo.*SNES|Vendor:\s*057e\s+Product:\s*2017|057e.*2017/i;
  // "Legion" (not just "Legion Go") — Lenovo Legion built-in pads identify as
  // Xbox 360 controllers on some stacks and as "Legion Controller" on others;
  // "X-Box" is the Linux xpad driver's spelling.
  const XBOX_PAD_RE = /Xbox|X-Box|XInput|Microsoft|Legion/i;
  // Google Stadia controller: Chrome names it "Stadia Controller rev. A
  // (STANDARD GAMEPAD Vendor: 18d1 Product: 9400)", Firefox
  // "18d1-9400-Stadia Controller rev. A". Standard mapping, so it needs no
  // button rebuild here — only the priority that makes it win over a generic
  // pad still paired in the background.
  const STADIA_PAD_RE = /Stadia|18d1.{0,8}9400/i;
  // Lenovo Legion Go family. The built-in TrueStrike controller enumerates as
  // "Lenovo Legion Controller for Windows", vendor 17ef, product 6182 in
  // XInput mode (6183 DInput, 6184 dual DInput, 6185 FPS mode): Linux Chrome
  // spells it "… (STANDARD GAMEPAD Vendor: 17ef Product: 6182)", Firefox
  // "17ef-6182-…". On Windows the pad rides XInput and collapses to the
  // anonymous Xbox 360 literal, so the launcher also asks the desktop host
  // which machine it is on (routes/api/host.ts) before defaulting Split
  // Controller mode on.
  const LEGION_PAD_RE =
    /Legion|Vendor:\s*17ef\s+Product:\s*61[0-9a-f]{2}|\b17ef-61[0-9a-f]{2}-/i;
  // Chrome on Android gets pad-layout tweaks of its own (see snesButtons).
  // userAgentData first: "Request desktop site" strips Android from the UA
  // string, which would silently disable every Android pad accommodation.
  const IS_ANDROID = (() => {
    try {
      const uad = root.navigator && root.navigator.userAgentData;
      if (uad && uad.platform === "Android") return true;
    } catch (_) { /* ignore */ }
    return /Android/i.test((root.navigator && root.navigator.userAgent) || "");
  })();
  const defaultOptions = {
    sourceParent: false,
    preferSinglePad: false,
    forceIndexZero: false,
    standardizeSnesMapping: true,
  };
  let options = { ...defaultOptions };
  const rawGetGamepads = typeof root.navigator.getGamepads === "function"
    ? root.navigator.getGamepads.bind(root.navigator)
    : null;
  let installed = false;
  const wrapCache = typeof WeakMap === "function" ? new WeakMap() : null;

  function merge(target, ...sources) {
    for (const source of sources) {
      for (const key in source || {}) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          target[key] = source[key];
        }
      }
    }
    return target;
  }

  function isSnesPad(pad) {
    return !!(pad && SNES_PAD_RE.test(pad.id || ""));
  }

  function isStadiaPad(pad) {
    return !!(pad && STADIA_PAD_RE.test(pad.id || ""));
  }

  function isLegionPad(pad) {
    return !!(pad && LEGION_PAD_RE.test(pad.id || ""));
  }

  function padPriority(pad) {
    const id = (pad && pad.id) || "";
    if (SNES_PAD_RE.test(id)) return 3;
    // A Legion pad ranks with Xbox pads under every spelling, not only the
    // ones that say "Legion" — see LEGION_PAD_RE.
    if (XBOX_PAD_RE.test(id) || STADIA_PAD_RE.test(id) || LEGION_PAD_RE.test(id)) return 2;
    return 1;
  }

  function decodeHat(value) {
    const dirs = { up: false, down: false, left: false, right: false };
    if (typeof value !== "number" || value < -1.05 || value > 1.05) {
      return dirs;
    }

    // Hats step through exactly 8 values (-1 .. 1 in 2/7 increments). A value
    // off that grid isn't a hat state — notably 0, which some stacks report
    // for an untouched axis; rounding it would fabricate a phantom "down".
    const scaled = (value + 1) * 3.5;
    if (Math.abs(scaled - Math.round(scaled)) > 0.25) return dirs;

    const state = ((Math.round(scaled) % 8) + 8) % 8;
    switch (state) {
      case 0:
        dirs.up = true;
        break;
      case 1:
        dirs.up = true;
        dirs.right = true;
        break;
      case 2:
        dirs.right = true;
        break;
      case 3:
        dirs.down = true;
        dirs.right = true;
        break;
      case 4:
        dirs.down = true;
        break;
      case 5:
        dirs.down = true;
        dirs.left = true;
        break;
      case 6:
        dirs.left = true;
        break;
      case 7:
        dirs.up = true;
        dirs.left = true;
        break;
    }
    return dirs;
  }

  function button(pressed) {
    return {
      pressed: !!pressed,
      touched: !!pressed,
      value: pressed ? 1 : 0,
    };
  }

  // An axis reporting only exact -1 / 0 / +1 is a digital D-pad axis (joydev
  // hat0x/hat0y, Android AXIS_HAT_X/Y). Safe to read aggressively on SNES-id
  // pads: they have no analog sticks, so nothing else produces these values.
  function isDigitalValue(v) {
    return typeof v === "number" &&
      (Math.abs(v) < 0.01 || Math.abs(Math.abs(v) - 1) < 0.01);
  }

  function orDigitalPair(axes, xi, yi, dirs) {
    const x = axes[xi];
    const y = axes[yi];
    if (!isDigitalValue(x) || !isDigitalValue(y)) return;
    if (x <= -0.99) dirs.left = true;
    else if (x >= 0.99) dirs.right = true;
    if (y <= -0.99) dirs.up = true;
    else if (y >= 0.99) dirs.down = true;
  }

  // The SNES pad reports its D-pad differently per platform/connection:
  //   - encoded hat on axes[9]  (Chrome generic-HID)
  //   - digital hat pair on axes[0]/[1], [2]/[3] or [4]/[5]  (Linux joydev)
  //   - digital hat pair on axes[6]/[7]  (Android)
  // OR every source; on this pad they can't conflict (no analog sticks).
  function snesDirs(pad) {
    const axes = pad.axes || [];
    const dirs = decodeHat(axes.length > 9 ? axes[9] : NaN);
    orDigitalPair(axes, 0, 1, dirs);
    orDigitalPair(axes, 2, 3, dirs);
    orDigitalPair(axes, 4, 5, dirs);
    orDigitalPair(axes, 6, 7, dirs);
    return dirs;
  }

  function isPressed(b) {
    return !!(b && b.pressed);
  }

  // Normalize an SNES pad's buttons to the standard-gamepad layout:
  // face 0-3 (bottom/right/left/top), L/R 4/5, L2/R2 6/7, Select/Start 8/9,
  // D-pad 12-15.
  //
  // Two non-standard families are handled (fingerprinted by axis count —
  // measured with the dashboard's ?paddebug=1 overlay):
  //   - Nintendo HID bit order (macOS Chrome generic-HID): ~10 axes with the
  //     D-pad as an encoded hat on axes[9]. Faces (B,A,Y,X at 0-3), L/R at
  //     4/5, ZL/L2 at 6, and Select/Start at 8/9 already match the standard
  //     layout; ZR/R2 reports at raw 15 and moves to the standard 7. The raw
  //     12-15 slots are never a D-pad here (Home/Capture bits + ZR), so the
  //     D-pad comes exclusively from the hat.
  //   - Linux joydev family (B,A,X,Y,L,R,Select,Start,...): few axes; the
  //     D-pad arrives as real buttons 12-15 and/or a digital hat pair on the
  //     low axes. Top/left faces swap and Select/Start move 6/7 → 8/9 (the
  //     vacated slots are cleared so they can't ghost as L2/R2).
  function snesButtons(pad) {
    const source = pad.buttons || [];
    const out = new Array(Math.max(source.length, 16));

    for (let i = 0; i < out.length; i++) {
      out[i] = source[i] || button(false);
    }

    if (pad.mapping !== "standard") {
      const axes = pad.axes || [];
      const joydevFamily = axes.length <= 9;

      if (joydevFamily) {
        // joydev family reports X (top) at 2 and Y (left) at 3 — standard
        // wants left at 2, top at 3.
        out[2] = source[3] || button(false);
        out[3] = source[2] || button(false);
        out[8] = button(isPressed(source[8]) || isPressed(source[6])); // Select
        out[9] = button(isPressed(source[9]) || isPressed(source[7])); // Start
        out[6] = button(false);
        out[7] = button(false);
      } else {
        // Nintendo HID order: ZR/R2 reports at raw 15 → standard R2 slot.
        // (ZL/L2 already sits at the standard 6; Select/Start at 8/9.)
        out[7] = button(isPressed(source[7]) || isPressed(source[15]));
      }

      // D-pad: raw buttons 12-15 are a real D-pad only in the joydev family;
      // in Nintendo HID order they hold Home/Capture/ZR bits and must not
      // leak in (ZR at 15 would read as a stuck D-pad-right).
      const dirs = snesDirs(pad);
      out[12] = button((joydevFamily && isPressed(source[12])) || dirs.up);
      out[13] = button((joydevFamily && isPressed(source[13])) || dirs.down);
      out[14] = button((joydevFamily && isPressed(source[14])) || dirs.left);
      out[15] = button((joydevFamily && isPressed(source[15])) || dirs.right);
    }

    // Chrome on Android: remap the SNES pad's R shoulder into the L2 slot,
    // universally (launcher and games alike). Runs after (and regardless of)
    // the family normalization above, so "R" is whatever landed in the
    // standard slot 5 — including on Android's standard-mapped pads. The
    // launcher pairs this with L/L2 list navigation and the SELECT+L2 OSD
    // chord on Android.
    if (IS_ANDROID) {
      out[6] = button(isPressed(out[5]) || isPressed(out[6]));
      out[5] = button(false);
    }

    return out;
  }

  // The joydev-family SNES pad reports its digital D-pad as full-deflection
  // values on the low axes; once snesButtons has folded those into buttons
  // 12-15, exposing them as axes too makes every analog consumer (EmulatorJS
  // stick bindings, twin-stick passthrough) read phantom stick input. The pad
  // has no analog sticks, so zero the four stick slots; higher axes (hat
  // encodings) pass through for diagnostic readers. Standard-mapped SNES pads
  // skip this (no family normalization ran, so axes were never folded).
  function snesAxes(pad) {
    const out = (pad.axes || []).slice();
    for (let i = 0; i < 4 && i < out.length; i++) out[i] = 0;
    return out;
  }

  // ==== Generic fallback for unrecognized non-standard pads ====
  //
  // A pad that is neither SNES-id nor wizard-profiled and reports a
  // non-"standard" mapping gets zero normalization — on Chrome Android such
  // pads commonly report the D-pad as AXIS_HAT_X/Y on axes 6/7 (or an encoded
  // hat on axes[9]) and so have a dead D-pad in every consumer that reads
  // buttons 12-15 (EmulatorJS, games). Rebuild 12-15 from those sources.
  //
  // Digital-pair reads on axes 6/7 are double-gated: the axis must have been
  // observed at true neutral (≈0) at least once — trigger axes rest at ±1 and
  // would otherwise decode as a stuck direction — AND must never have been
  // observed at a non-digital intermediate value. True digital hat axes only
  // ever report -1/0/+1; sticks and analog triggers sweep through
  // intermediates at poll rate and get blacklisted before they can fabricate
  // a press (an analog axis resting at 0 would pass the neutral gate alone).
  // The hat decode on axes[9] is gated the same way in reverse: only after the
  // axis has been seen at a hat REST sentinel (outside ±1.05, e.g. Chrome's
  // 1.2857) — an analog axis 9 (HOTAS throttle) never leaves [-1, 1] and so
  // never qualifies. Keyed by index:id, not object identity, so it survives
  // browsers that hand out per-call snapshots.
  const axisNeutralSeen = new Map(); // "index:id" -> Set(axisIndex, 9 = hat-rest)
  const axisAnalogSeen = new Map(); // "index:id" -> Set(axisIndex)

  function genericDirs(pad) {
    const axes = pad.axes || [];
    const key = pad.index + ":" + (pad.id || "");
    let seen = axisNeutralSeen.get(key);
    if (!seen) {
      seen = new Set();
      axisNeutralSeen.set(key, seen);
    }
    let analog = axisAnalogSeen.get(key);
    if (!analog) {
      analog = new Set();
      axisAnalogSeen.set(key, analog);
    }
    for (const i of [6, 7]) {
      const v = axes[i];
      if (typeof v !== "number") continue;
      if (Math.abs(v) < 0.01) seen.add(i);
      if (!isDigitalValue(v) && Math.abs(v) <= 1.05) analog.add(i);
    }
    if (axes.length > 9 && typeof axes[9] === "number" && Math.abs(axes[9]) > 1.05) {
      seen.add(9);
    }
    const dirs = decodeHat(seen.has(9) && axes.length > 9 ? axes[9] : NaN);
    const digital = (i) =>
      seen.has(i) && !analog.has(i) && isDigitalValue(axes[i]) ? axes[i] : 0;
    const x = digital(6);
    const y = digital(7);
    if (x <= -0.99) dirs.left = true;
    else if (x >= 0.99) dirs.right = true;
    if (y <= -0.99) dirs.up = true;
    else if (y >= 0.99) dirs.down = true;
    return dirs;
  }

  function genericButtons(pad) {
    const source = pad.buttons || [];
    const out = new Array(Math.max(source.length, 16));
    for (let i = 0; i < out.length; i++) {
      out[i] = source[i] || button(false);
    }
    const dirs = genericDirs(pad);
    if (dirs.up) out[12] = button(true);
    if (dirs.down) out[13] = button(true);
    if (dirs.left) out[14] = button(true);
    if (dirs.right) out[15] = button(true);
    return out;
  }

  // ==== Custom mapping profiles (saved by the Button Mapping Wizard) ====
  //
  // A profile records, per standard-gamepad slot, which raw control this pad
  // actually reports (button index, digital axis+direction, or hat-switch
  // direction). Pads with a profile are re-expressed as standard-layout
  // (Xbox-360-style) pads for every consumer of navigator.getGamepads() —
  // launcher, GamepadManager, and same-origin game frames alike.
  //
  // Shape (stored under localStorage "cmgPadProfiles", keyed by pad.id):
  //   {
  //     buttons: { "<standardSlot>": { kind: "button", index }
  //                                 | { kind: "axis", index, sign, baseline }
  //                                 | { kind: "hat", index, dir } },
  //     axes:    { "<standardAxis 0-3>": { index, invert } },
  //   }
  const PROFILE_STORAGE_KEY = "cmgPadProfiles";
  let profileCache = null;

  function loadProfiles() {
    if (profileCache) return profileCache;
    try {
      profileCache =
        JSON.parse(root.localStorage.getItem(PROFILE_STORAGE_KEY) || "{}") ||
        {};
    } catch (_) {
      profileCache = {};
    }
    return profileCache;
  }

  function invalidateProfiles() {
    profileCache = null;
  }

  try {
    // storage fires in every other same-origin document (game iframes); the
    // custom event covers the document that saved the profile itself.
    root.addEventListener("storage", (e) => {
      if (!e || !e.key || e.key === PROFILE_STORAGE_KEY) invalidateProfiles();
    });
    root.addEventListener("cmg-pad-profiles-updated", invalidateProfiles);
  } catch (_) { /* non-window context */ }

  function profileFor(pad) {
    if (!pad || !pad.id) return null;
    const profile = loadProfiles()[pad.id];
    return profile && profile.buttons ? profile : null;
  }

  function bindingPressed(pad, binding) {
    if (!binding) return false;
    if (binding.kind === "button") {
      const b = (pad.buttons || [])[binding.index];
      return !!(b && b.pressed);
    }
    const v = (pad.axes || [])[binding.index];
    if (typeof v !== "number") return false;
    if (binding.kind === "hat") return !!decodeHat(v)[binding.dir];
    if (binding.kind === "axis") {
      const base = typeof binding.baseline === "number" ? binding.baseline : 0;
      return binding.sign >= 0 ? v - base > 0.5 : base - v > 0.5;
    }
    return false;
  }

  function profileButtons(pad, profile) {
    const out = new Array(17);
    for (let i = 0; i < out.length; i++) {
      out[i] = button(bindingPressed(pad, profile.buttons[i]));
    }
    return out;
  }

  function profileAxes(pad, profile) {
    const src = pad.axes || [];
    const map = profile.axes || {};
    const read = (slot) => {
      const m = map[slot];
      if (!m || typeof src[m.index] !== "number") return 0;
      return m.invert ? -src[m.index] : src[m.index];
    };
    return [read(0), read(1), read(2), read(3)];
  }

  const profileWrapCache = typeof WeakMap === "function" ? new WeakMap() : null;

  function wrapProfiledPad(pad, profile, opts) {
    if (profileWrapCache) {
      const cached = profileWrapCache.get(pad);
      // Profile object identity is stable until invalidateProfiles(), so a
      // re-saved profile naturally busts this cache.
      if (cached && cached.profile === profile) return cached.wrapped;
    }

    const wrapped = new Proxy(pad, {
      get(target, prop) {
        if (prop === "__cmgGamepadCompatWrapped") return true;
        if (prop === "buttons") return profileButtons(target, profile);
        if (prop === "axes") return profileAxes(target, profile);
        if (prop === "mapping") return "standard";
        if (prop === "index" && opts.forceIndexZero) return 0;

        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    if (profileWrapCache) profileWrapCache.set(pad, { profile, wrapped });
    return wrapped;
  }

  function cacheKey(opts) {
    return [
      opts.forceIndexZero ? "i0" : "idx",
      opts.standardizeSnesMapping ? "std" : "raw",
    ].join(":");
  }

  // Index-only shim for pads that are already fully normalized (see below):
  // re-fronts .index as 0 without touching buttons/axes/mapping.
  function wrapIndexOnly(pad) {
    const key = "idx-shim";
    if (wrapCache) {
      const cachedForPad = wrapCache.get(pad);
      if (cachedForPad && cachedForPad[key]) return cachedForPad[key];
    }
    const wrapped = new Proxy(pad, {
      get(target, prop) {
        if (prop === "__cmgGamepadCompatWrapped") return true;
        if (prop === "index") return 0;
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    if (wrapCache) {
      const next = wrapCache.get(pad) || {};
      next[key] = wrapped;
      wrapCache.set(pad, next);
    }
    return wrapped;
  }

  function wrapPad(pad, opts) {
    if (!pad) return pad;

    // Already normalized by another document's plugin — sourceParent frames
    // read the parent launcher's PATCHED getGamepads, so the pads arriving
    // here are proxies whose buttons/axes are the normalized view. Profile
    // bindings index RAW controls; re-resolving them against the normalized
    // view scrambles the mapping (raw hat axes are gone, raw button slots
    // moved). Only the index shim may still be needed.
    if (pad.__cmgGamepadCompatWrapped) {
      if (opts.forceIndexZero && pad.index !== 0) return wrapIndexOnly(pad);
      return pad;
    }

    // A wizard-authored profile wins over the built-in SNES heuristics: the
    // user explicitly told us where every control lives on this pad.
    const profile = profileFor(pad);
    if (profile) return wrapProfiledPad(pad, profile, opts);

    // forceIndexZero must hold for EVERY pad, not just SNES ones: consumers
    // like EmulatorJS's GamepadHandler and Emscripten SDL look pads up by
    // ARRAY POSITION using the pad's .index, and preferSinglePad serves them
    // a one-element array — a pad still wearing a browser index of 1+ sends
    // those lookups at a hole (dead input, or a crashed poll loop).
    const snes = isSnesPad(pad);
    // Unrecognized non-standard pads get the conservative generic D-pad
    // rebuild (hat / digital-pair axes → buttons 12-15). Skip pads without
    // enough axes to carry either source — the wrap would be a no-op.
    const generic = !snes && pad.mapping !== "standard" &&
      (pad.axes || []).length >= 7;
    if (!snes && !generic && !(opts.forceIndexZero && pad.index !== 0)) {
      return pad;
    }

    const key = cacheKey(opts);
    if (wrapCache) {
      const cachedForPad = wrapCache.get(pad);
      if (cachedForPad && cachedForPad[key]) return cachedForPad[key];
    }

    const wrapped = new Proxy(pad, {
      get(target, prop) {
        if (prop === "__cmgGamepadCompatWrapped") return true;
        if (snes && prop === "buttons") return snesButtons(target);
        if (generic && prop === "buttons") return genericButtons(target);
        // Only when family normalization folded the D-pad out of the axes
        // (non-standard mapping): hide the phantom stick deflections.
        if (snes && prop === "axes" && target.mapping !== "standard") {
          return snesAxes(target);
        }
        if (prop === "index" && opts.forceIndexZero) return 0;
        if (snes && prop === "mapping" && opts.standardizeSnesMapping) {
          return "standard";
        }

        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    if (wrapCache) {
      const next = wrapCache.get(pad) || {};
      next[key] = wrapped;
      wrapCache.set(pad, next);
    }

    return wrapped;
  }

  function readLocalPads() {
    return rawGetGamepads ? (rawGetGamepads() || []) : [];
  }

  function readParentPads() {
    try {
      const parentWindow = root.parent;
      if (
        !options.sourceParent ||
        !parentWindow ||
        parentWindow === root ||
        !parentWindow.navigator ||
        typeof parentWindow.navigator.getGamepads !== "function"
      ) {
        return null;
      }

      const pads = parentWindow.navigator.getGamepads() || [];
      for (let i = 0; i < pads.length; i++) {
        if (pads[i] && pads[i].connected) return pads;
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  function sourcePads() {
    return readParentPads() || readLocalPads();
  }

  function selectPreferredPad(pads) {
    let best = null;
    let bestScore = -1;

    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad || !pad.connected) continue;

      const score = padPriority(pad);
      if (score > bestScore) {
        best = pad;
        bestScore = score;
      }
    }

    return best;
  }

  function normalizedGamepads() {
    const pads = sourcePads();

    if (options.preferSinglePad) {
      const preferred = selectPreferredPad(pads);
      return preferred ? [wrapPad(preferred, options)] : [];
    }

    const out = new Array(pads.length);
    for (let i = 0; i < pads.length; i++) {
      out[i] = pads[i] ? wrapPad(pads[i], options) : pads[i];
    }
    return out;
  }

  // Twin-Stick mode: re-express a pad as a dual-analog controller for
  // twin-stick shooters — D-pad drives the left stick (move), face buttons
  // drive the right stick (aim: top=up, right=right, bottom=down, left=left).
  // Expects standard-layout pads (run them through this plugin first), so it
  // works for the SNES pad and any standard pad alike. Real analog values
  // pass through whenever the digital override isn't pressed. Returns plain
  // snapshot objects (not proxies) so they can safely cross into a
  // same-origin game iframe's realm.
  function twinStickPads(pads) {
    const out = [];
    for (let i = 0; i < (pads ? pads.length : 0); i++) {
      const p = pads[i];
      if (!p || !p.connected) {
        out.push(null);
        continue;
      }
      // A half of a split pad (splitPads above) already is the twin-stick
      // expression, and its faces are confirm/bomb/weapon buttons, not aim:
      // pass it through untouched.
      if (p.__cmgSplitHalf) {
        out.push(p);
        continue;
      }
      const b = p.buttons || [];
      const pr = (j) => !!(b[j] && b[j].pressed);
      const axes = [];
      const srcAxes = p.axes || [];
      for (let a = 0; a < Math.max(srcAxes.length, 4); a++) {
        axes[a] = typeof srcAxes[a] === "number" ? srcAxes[a] : 0;
      }
      axes[0] = pr(14) ? -1 : pr(15) ? 1 : axes[0]; // D-pad → left stick X
      axes[1] = pr(12) ? -1 : pr(13) ? 1 : axes[1]; // D-pad → left stick Y
      axes[2] = pr(2) ? -1 : pr(1) ? 1 : axes[2]; // faces → right stick X
      axes[3] = pr(3) ? -1 : pr(0) ? 1 : axes[3]; // faces → right stick Y
      out.push({
        id: p.id,
        index: p.index,
        connected: true,
        mapping: "standard",
        timestamp: p.timestamp || 0,
        axes,
        buttons: Array.prototype.map.call(b, (x) => ({
          pressed: !!(x && x.pressed),
          touched: !!(x && (x.touched || x.pressed)),
          value: x && typeof x.value === "number" ? x.value : (x && x.pressed ? 1 : 0),
        })),
        vibrationActuator: p.vibrationActuator || null,
      });
    }
    return out;
  }

  // ==== Split Controller mode (Lenovo Legion Go) ====
  //
  // The Legion Go's TrueStrike controller detaches into two halves that keep
  // reporting as ONE standard pad: left stick, D-pad, LB, LT, L3 and View on
  // the left half; right stick, ABXY, RB, RT, R3 and Menu on the right. Two
  // players holding a half each therefore look to a game like one player —
  // player 1 flies on the left stick while the right half's buttons bomb for
  // player 1 too. splitPads() re-expresses such a pad as two standard-layout
  // virtual pads, one per half, so games that read the Gamepad API per pad —
  // 2028-ai's join-in (a second pad pressing a face or shoulder button),
  // Sh'M↑ Party's one-player-per-port — see two controllers:
  //
  //   left half  → "<id> [L]" at the pad's own index. axes 0/1 = left stick;
  //                12-15 = D-pad; 4 = LB, and 0 = LB as well so the half has
  //                a confirm button; 6 AND 7 = LT (both triggers, so a game
  //                reading either finds it); 8 = View; 10 = L3, and 11 = L3
  //                as well (2028-ai's level-editor button is R3).
  //   right half → "<id> [R]" at index + SPLIT_INDEX_OFFSET (Chrome hands
  //                real pads 0-3, so it never collides). axes 0/1 = the RIGHT
  //                stick — it is this player's movement stick; 0-3 = ABXY;
  //                5 = RB; 6 AND 7 = RT; 9 = Menu; 11 = R3.
  //
  // The right half exists only once it has been CLAIMED — a press on one of
  // its buttons (ABXY, RB, RT, R3; the sticks never claim, nor does Menu) —
  // and then stays for as long as the physical pad does. Until then the left
  // pad is the whole controller for the one player holding it: the right
  // stick rides on its axes 2/3 (Sh'M↑ Party's aim stick) and Menu on its
  // slot 9. Split mode is the launcher's default on a Legion Go whether or
  // not the halves are apart — nothing can tell — so a solo player who keeps
  // to the sticks, the D-pad and the left half's buttons never spawns a
  // player 2; a face or right-shoulder press hands that half to player 2,
  // which is exactly what a second player's first press must do.
  //
  // Menu: on both halves in the generic profile (2028-ai pauses only on
  // player 1's Start and ignores player 2's during play); on the right half
  // alone in the twinstick profile (Sh'M↑ Party toggles pause per port, and
  // two ports pressing START in one frame would cancel out).
  //
  // profile "twinstick" (Sh'M↑ Party, and any game the launcher knows as a
  // twin-stick game) reshapes each half for a one-stick twin-stick player:
  // dash (L1) is LB on the left half and RB on the right; the weapon cycle
  // (R1) is LT on the left and Y on the right; the right half's stick also
  // writes the D-pad (12-15) past SPLIT_DPAD_AT, so a menu that reads only
  // LEFT/RIGHT (the perk picker) can be worked from it; and R2 — the game's
  // auto-aim-and-fire button — is held on a half while its player is at the
  // controls (any input within AUTO_FIRE_IDLE_MS), since a half has no
  // second stick to aim with. It lets go after that idle window so the title
  // can still fall into attract mode.
  //
  // Rumble splits with the halves: XInput's strong motor is the left grip and
  // the weak one the right, so each virtual pad's actuator drives its own
  // motor — and, because both wrap the SAME physical actuator, whose
  // playEffect preempts whatever is playing, a half's effect carries the
  // other half's still-live magnitude along instead of cancelling it.
  //
  // Which pads split (splitTargets): every Legion-id pad; or, where the pad
  // hides behind the XInput literal, the lowest-index standard pad when
  // nothing identifies itself as a Legion. Other pads pass through untouched,
  // at their index. Returns plain snapshot objects, like twinStickPads, so
  // they can cross into a same-origin game frame's realm.
  const SPLIT_INDEX_OFFSET = 4;
  // A stick this far off centre counts as a hand on that half...
  const SPLIT_STICK_LIVE = 0.3;
  // ...and this far is a D-pad press, for the right half's synthesized D-pad.
  const SPLIT_DPAD_AT = 0.7;
  const AUTO_FIRE_IDLE_MS = 10000;
  const LEFT_HALF_SLOTS = [4, 6, 8, 10, 12, 13, 14, 15];
  const RIGHT_HALF_CLAIM_SLOTS = [0, 1, 2, 3, 5, 7, 11];
  // "index:id" -> { rightLive, leftAt, rightAt }. Pads gone from the list are
  // forgotten, so a reconnected controller starts over with no right half.
  const splitState = new Map();

  function snapshotButton(b) {
    return {
      pressed: !!(b && b.pressed),
      touched: !!(b && (b.touched || b.pressed)),
      value: b && typeof b.value === "number" ? b.value : (b && b.pressed ? 1 : 0),
    };
  }

  // One half's share of the pad's dual-rumble actuator. Each half sets only
  // its own motor; the other motor keeps whatever its half last asked for
  // while that effect is still running, so 2028-ai's game-wide buzz (both
  // halves, back to back, in one tick) reaches both grips instead of the
  // second call cancelling the first. Firefox's pulse() has no per-motor
  // form and passes straight through.
  const actuatorShares = typeof WeakMap === "function" ? new WeakMap() : null;

  function halfActuator(real, side) {
    if (!real || typeof real.playEffect !== "function") return null;
    let share = actuatorShares ? actuatorShares.get(real) : null;
    if (!share) {
      share = { strong: 0, weak: 0, strongUntil: 0, weakUntil: 0 };
      if (actuatorShares) actuatorShares.set(real, share);
    }
    const mine = side === "left" ? "strong" : "weak";
    const other = side === "left" ? "weak" : "strong";
    const type = real.type || "dual-rumble";
    const half = {
      type,
      playEffect(effectType, params) {
        const p = merge({}, params || {});
        const now = Date.now();
        const duration = typeof p.duration === "number" ? p.duration : 0;
        const mag = p[mine + "Magnitude"];
        share[mine] = typeof mag === "number" ? mag : 0;
        share[mine + "Until"] = now + duration;
        if (share[other + "Until"] <= now) share[other] = 0;
        p.strongMagnitude = share.strong;
        p.weakMagnitude = share.weak;
        return real.playEffect(effectType, p);
      },
      reset() {
        const now = Date.now();
        share[mine] = 0;
        share[mine + "Until"] = 0;
        const remaining = share[other + "Until"] - now;
        if (remaining > 0 && share[other] > 0) {
          // The other half is still buzzing: play its remainder alone.
          return real.playEffect(type, {
            duration: remaining,
            strongMagnitude: share.strong,
            weakMagnitude: share.weak,
          });
        }
        return typeof real.reset === "function" ? real.reset() : Promise.resolve("complete");
      },
    };
    if (typeof real.pulse === "function") {
      half.pulse = (value, duration) => real.pulse(value, duration);
    }
    return half;
  }

  function splittablePad(pad) {
    if (!pad || !pad.connected) return false;
    if (pad.mapping === "standard") return true;
    return (pad.axes || []).length >= 4 && (pad.buttons || []).length >= 12;
  }

  // The pads splitPads() would split, as their indices. The launcher's
  // key-synthesis layer (gamepad-support.js) scopes its right-half hold-back
  // to exactly these, so a second, unsplit pad keeps all of its keys.
  function splitTargets(pads) {
    const list = pads ? Array.prototype.slice.call(pads) : [];
    let targets = list.filter((p) => splittablePad(p) && isLegionPad(p));
    if (!targets.length) {
      const candidates = list.filter(splittablePad).sort((a, b) => a.index - b.index);
      if (candidates.length) targets = [candidates[0]];
    }
    return targets.map((p) => p.index);
  }

  function splitOne(pad, profile, now) {
    const key = pad.index + ":" + (pad.id || "");
    let st = splitState.get(key);
    if (!st) {
      st = { rightLive: false, leftAt: -Infinity, rightAt: -Infinity };
      splitState.set(key, st);
    }
    const b = pad.buttons || [];
    const ax = pad.axes || [];
    const pr = (i) => !!(b[i] && b[i].pressed);
    const axis = (i) => (typeof ax[i] === "number" && Math.abs(ax[i]) <= 1.05 ? ax[i] : 0);
    const lx = axis(0), ly = axis(1), rx = axis(2), ry = axis(3);
    const claimNow = RIGHT_HALF_CLAIM_SLOTS.some(pr);
    // Menu belongs to the left pad until the right half is claimed (see
    // below), so until then a Menu press is that player at the controls.
    const leftActive = LEFT_HALF_SLOTS.some(pr) || (!st.rightLive && pr(9)) ||
      Math.abs(lx) > SPLIT_STICK_LIVE || Math.abs(ly) > SPLIT_STICK_LIVE;
    const rightActive = claimNow || pr(9) ||
      Math.abs(rx) > SPLIT_STICK_LIVE || Math.abs(ry) > SPLIT_STICK_LIVE;
    if (leftActive) st.leftAt = now;
    if (rightActive) st.rightAt = now;
    if (claimNow) st.rightLive = true;
    const claimed = st.rightLive;
    const twin = profile === "twinstick";
    const fireL = twin && now - st.leftAt < AUTO_FIRE_IDLE_MS;
    const fireR = twin && now - st.rightAt < AUTO_FIRE_IDLE_MS;

    const n = Math.max(b.length, 17);
    const left = new Array(n);
    const right = new Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = button(false);
      right[i] = button(false);
    }
    // Left half.
    left[0] = snapshotButton(b[4]); // LB doubles as this half's confirm
    left[4] = snapshotButton(b[4]);
    left[8] = snapshotButton(b[8]);
    left[10] = snapshotButton(b[10]);
    left[11] = snapshotButton(b[10]); // ...and as R3, the level-editor button
    for (let d = 12; d <= 15; d++) left[d] = snapshotButton(b[d]);
    if (twin) {
      left[5] = snapshotButton(b[6]); // LT → weapon cycle
      left[7] = button(fireL); // auto-aim and fire while at the controls
    } else {
      left[6] = snapshotButton(b[6]);
      left[7] = snapshotButton(b[6]);
    }
    // Menu: player 1's pause in the generic profile, and the whole pad's
    // Start until the right half has been claimed.
    if (!twin || !claimed) left[9] = snapshotButton(b[9]);
    // Anything past the standard 17 (a Stadia's Capture/Assistant, a pad's
    // Home) belongs to player 1's half.
    for (let i = 16; i < b.length; i++) left[i] = snapshotButton(b[i]);
    // Right half.
    for (let f = 0; f <= 3; f++) right[f] = snapshotButton(b[f]);
    right[9] = snapshotButton(b[9]);
    right[11] = snapshotButton(b[11]);
    if (twin) {
      right[4] = snapshotButton(b[5]); // RB → dash
      right[5] = snapshotButton(b[3]); // Y → weapon cycle (still Y at slot 3)
      right[7] = button(fireR || pr(7));
      // The stick as a D-pad too, for menus that read only LEFT/RIGHT.
      right[12] = button(ry < -SPLIT_DPAD_AT);
      right[13] = button(ry > SPLIT_DPAD_AT);
      right[14] = button(rx < -SPLIT_DPAD_AT);
      right[15] = button(rx > SPLIT_DPAD_AT);
    } else {
      right[5] = snapshotButton(b[5]);
      right[6] = snapshotButton(b[7]);
      right[7] = snapshotButton(b[7]);
    }

    const half = (suffix, index, axes, buttons, side) => ({
      id: (pad.id || "") + " [" + suffix + "]",
      index,
      connected: true,
      mapping: "standard",
      timestamp: pad.timestamp || 0,
      axes,
      buttons,
      vibrationActuator: halfActuator(pad.vibrationActuator, side),
      __cmgSplitHalf: suffix,
    });
    return {
      // Unclaimed, the left pad still carries the right stick: it is the
      // whole controller for the one player holding it.
      leftPad: half("L", pad.index, claimed ? [lx, ly, 0, 0] : [lx, ly, rx, ry], left, "left"),
      rightPad: claimed
        ? half("R", pad.index + SPLIT_INDEX_OFFSET, [rx, ry, 0, 0], right, "right")
        : null,
    };
  }

  function splitPads(pads, opts) {
    const o = opts || {};
    const profile = o.profile === "twinstick" ? "twinstick" : "generic";
    const now = typeof o.now === "number" ? o.now : Date.now();
    const list = pads ? Array.prototype.slice.call(pads) : [];
    const targetIndices = new Set(splitTargets(list));
    const targets = list.filter((p) => p && targetIndices.has(p.index));

    let size = Math.max(list.length, SPLIT_INDEX_OFFSET * 2);
    for (const p of list) {
      if (p && typeof p.index === "number" && p.index + 1 > size) size = p.index + 1;
    }
    const out = new Array(size);
    for (let i = 0; i < size; i++) out[i] = null;
    for (const p of list) {
      if (p && typeof p.index === "number" && p.index >= 0) out[p.index] = p;
    }

    const seen = new Set();
    for (const p of targets) {
      seen.add(p.index + ":" + (p.id || ""));
      const halves = splitOne(p, profile, now);
      out[p.index] = halves.leftPad;
      const r = halves.rightPad;
      if (!r) continue;
      // A real pad already sitting at index + 4 (Firefox numbers pads
      // freely) keeps its slot; the half takes the next free one.
      while (out[r.index] && !out[r.index].__cmgSplitHalf) r.index++;
      out[r.index] = r;
    }
    for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = null;
    for (const key of splitState.keys()) {
      if (!seen.has(key)) splitState.delete(key);
    }
    return out;
  }

  function install(nextOptions) {
    options = merge({}, options, nextOptions || {});

    if (!installed && rawGetGamepads) {
      root.navigator.getGamepads = normalizedGamepads;
      installed = true;
    }

    return api;
  }

  const api = {
    version: "1.5.0",
    install,
    isSnesPad,
    isStadiaPad,
    isLegionPad,
    padPriority,
    decodeHat,
    selectPreferredPad,
    // Mapping-profile helpers (used by the Button Mapping Wizard).
    profiles: loadProfiles,
    invalidateProfiles,
    bindingPressed,
    options() {
      return merge({}, options);
    },
    twinStick: twinStickPads,
    // Split Controller mode (see above): one pad as two half-pads, and
    // which pads it would split.
    splitPads,
    splitTargets,
    // Forget every pad's split state — a right half seen, a hand's last
    // input — so the next splitPads call starts over (tests, and the
    // launcher when the mode is switched off).
    splitReset() {
      splitState.clear();
    },
    // Unwrapped pads, for diagnostics (e.g. the dashboard's ?paddebug=1
    // overlay) — shows what the browser actually reports before this plugin
    // normalizes it.
    raw() {
      return readLocalPads();
    },
  };

  root.CMGGamepadCompat = api;
  install();
})();
