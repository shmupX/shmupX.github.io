/**
 * Advanced Gamepad Support System
 * Works in both launcher and in-game contexts
 * Features Steam-like Controller Configurator
 *
 * Reuse in other web games:
 *   - As an ES module:
 *       import { GamepadManager } from "./gamepad-support.js"; // named
 *       import GamepadManager from "./gamepad-support.js";     // default (same class)
 *       const gm = new GamepadManager();
 *   - Via <script type="module" src="gamepad-support.js">: a shared instance is
 *     auto-created at window.gamepadManager, with the class at window.GamepadManager.
 */

class GamepadManager {
  constructor() {
    this.MAX_PLAYERS = 4;
    this.controllers = {};
    this.buttonState = {};
    this.analogState = {};
    this.isRunning = false;
    // Testing mode (visualize presses on configurator SVG)
    this.testingMode = false;
    this.testingController = 'all'; // 'all' or specific controller index (number or string)

    // Detect Gamepad Button state
    this._detecting = false; // { ui: { selectEl, buttonEl, hintEl } } | false
    this._detectSnapshot = {}; // controllerIndex -> [bool]

    // Default controller mapping (Standard Gamepad API)
    this.defaultMapping = {
      dpad: {
        up: { gamepadButton: 12, keyboardKey: 'ArrowUp', keyCode: 38 },
        down: { gamepadButton: 13, keyboardKey: 'ArrowDown', keyCode: 40 },
        left: { gamepadButton: 14, keyboardKey: 'ArrowLeft', keyCode: 37 },
        right: { gamepadButton: 15, keyboardKey: 'ArrowRight', keyCode: 39 }
      },
      // Face buttons are named by POSITION, not by vendor letter, because the
      // same standard-mapping index is a different glyph per vendor: index 0 is
      // Xbox A / PlayStation Cross but Nintendo B, and index 1 is Xbox B but
      // Nintendo A. "Press A" is therefore ambiguous across pads; FBTN_BOTTOM
      // is not. The indices themselves follow the W3C standard gamepad mapping.
      face: {
        btnBottom: { gamepadButton: 0, keyboardKey: ' ', keyCode: 32 }, // FBTN_BOTTOM
        btnRight: { gamepadButton: 1, keyboardKey: 'c', keyCode: 67 }, // FBTN_RIGHT
        btnLeft: { gamepadButton: 2, keyboardKey: 'c', keyCode: 67 }, // FBTN_LEFT
        btnTop: { gamepadButton: 3, keyboardKey: ' ', keyCode: 32 } // FBTN_TOP
      },
      shoulder: {
        leftShoulder: { gamepadButton: 4, keyboardKey: 'q', keyCode: 81 },
        rightShoulder: { gamepadButton: 5, keyboardKey: 'e', keyCode: 69 },
        leftTrigger: { gamepadButton: 6, keyboardKey: 'r', keyCode: 82 },
        rightTrigger: { gamepadButton: 7, keyboardKey: 't', keyCode: 84 }
      },
      special: {
        select: { gamepadButton: 8, keyboardKey: 'Backspace', keyCode: 8 },
        start: { gamepadButton: 9, keyboardKey: 'Enter', keyCode: 13 },
        leftStick: { gamepadButton: 10, keyboardKey: 'f', keyCode: 70 },
        rightStick: { gamepadButton: 11, keyboardKey: 'g', keyCode: 71 },
        home: { gamepadButton: 16, keyboardKey: 'h', keyCode: 72 }
      }
    };

    // Load saved mapping or use default
    this.controllerMappings = {}; // Maps controller ID to mapping object
    this.controllerUseWASD = {}; // Maps controller ID to boolean

    // Start button preferences
    this.simulateTouchOnStart = this.loadStartTouchPreference();
    this.touchTargetSelector = this.loadTouchTargetPreference();
    this.startSceneName = this.loadStartScenePreference();

    this.init();
  }

  init() {
    // Event listeners for gamepad connection/disconnection
    window.addEventListener('gamepadconnected', (e) => this.onGamepadConnected(e));
    window.addEventListener('gamepaddisconnected', (e) => this.onGamepadDisconnected(e));

    // Start the polling loop
    this.startPolling();

    // Initialize button state tracking
    this.resetButtonStates();
  }

  startPolling() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.poll();
  }

  stopPolling() {
    this.isRunning = false;
  }

  poll() {
    if (!this.isRunning) return;

    try {
      this.scanGamepads();
      // Configurator hooks (present only when controller-configurator.js is loaded).
      if (this.handleDetectionTick) this.handleDetectionTick();
      // Pad-driven navigation of the configurator panel / mapping wizard
      // (present only when those modules are loaded). Runs before
      // processInputs so nav presses are consumed instead of dispatched.
      if (this.handleConfiguratorPadTick) this.handleConfiguratorPadTick();
      this.processInputs();

      if (this.isConfiguratorOpen && this.isConfiguratorOpen() && this.testingMode && this.updateTestingVisual) {
        this.updateTestingVisual();
      }
    } catch (err) {
      // Never let a single bad frame kill the loop — log and keep polling.
      console.warn('GamepadManager poll error (continuing):', err);
    }

    requestAnimationFrame(() => this.poll());
  }

  scanGamepads() {
    const gamepads = navigator.getGamepads();
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i]) {
        if (gamepads[i].index in this.controllers) {
          this.controllers[gamepads[i].index] = gamepads[i];
        } else {
          this.addGamepad(gamepads[i]);
        }
      }
    }
  }

  onGamepadConnected(event) {
    console.log('Gamepad connected:', event.gamepad);
    this.addGamepad(event.gamepad);
    this.refreshTestingControllerOptionsIfOpen?.();
  }

  onGamepadDisconnected(event) {
    console.log('Gamepad disconnected:', event.gamepad);
    this.removeGamepad(event.gamepad);
    this.refreshTestingControllerOptionsIfOpen?.();
  }

  getControllerId(controller) {
    // Use the gamepad's ID, which is a descriptive string.
    // Fallback to index if ID is not available, though ID is standard.
    return controller.id || `gamepad-index-${controller.index}`;
  }

  isSnesController(controller) {
    return /SNES Controller|Nintendo.*SNES|057e.{0,8}2017/i.test((controller && controller.id) || "");
  }

  isXboxController(controller) {
    // "Legion" (not just "Legion Go") — Lenovo Legion built-in pads identify as
    // Xbox 360 controllers on some stacks and as "Legion Controller" on others;
    // "X-Box" is the Linux xpad driver's spelling.
    return /Xbox|X-Box|XInput|Microsoft|Legion/i.test((controller && controller.id) || "");
  }

  controllerPriority(controller) {
    if (this.isSnesController(controller)) return 3;
    if (this.isXboxController(controller)) return 2;
    return 1;
  }

  shouldProcessController(controller) {
    const connected = Object.values(this.controllers).filter(c => c && c.id);
    if (!connected.length) return false;
    const best = Math.max(...connected.map(c => this.controllerPriority(c)));
    // SNES overrides the Legion Go/Xbox built-in pad; Xbox remains the default
    // over generic devices. Multiple controllers at the winning priority still
    // work together.
    if (best > 1) return this.controllerPriority(controller) === best;
    return true;
  }

  addGamepad(gamepad) {
    if (!gamepad || !gamepad.id) return; // Ignore invalid gamepads
    const controllerId = this.getControllerId(gamepad);

    this.controllers[gamepad.index] = gamepad;
    // Never let a bad saved mapping leave this controller half-registered:
    // the controller is already in this.controllers, and scanGamepads won't
    // re-add a known index — an uncaught throw here used to strand it with no
    // buttonState, crashing every subsequent poll frame.
    try {
      this.controllerMappings[controllerId] = this.loadMapping(controllerId);
    } catch (_) {
      this.controllerMappings[controllerId] = JSON.parse(JSON.stringify(this.defaultMapping));
    }
    try {
      this.controllerUseWASD[controllerId] = this.loadUseWASDPreference(controllerId);
    } catch (_) {
      this.controllerUseWASD[controllerId] = false;
    }

    // If this is the 2nd gamepad connecting, ensure one is wasd and the other is arrowkeys
    try {
      const connectedControllers = Object.values(this.controllers).filter(c => c && c.id);
      // Check if we are adding the second controller
      if (connectedControllers.length === 1) {
        const firstController = connectedControllers[0];
        if (firstController) {
          const firstId = this.getControllerId(firstController);
          const firstUsesWASD = this.controllerUseWASD[firstId];
          // If first controller is NOT using WASD, and this one has no preference, default it to ON
          if (!firstUsesWASD && localStorage.getItem(`gamepadUseWASD_${controllerId}`) === null) {
            this.controllerUseWASD[controllerId] = true;
          }
        }
      }
    } catch (e) {
      console.warn('Error during 2nd gamepad WASD defaulting logic:', e);
    }

    // Initialize button state for all expected buttons
    this.buttonState[gamepad.index] = this.initialButtonState();

    this.analogState[gamepad.index] = { leftStick: { x: 0, y: 0 }, rightStick: { x: 0, y: 0 } };

    console.log(`Gamepad ${gamepad.index} (${gamepad.id}) added and initialized`);
    this.refreshTestingControllerOptionsIfOpen?.();
  }

  removeGamepad(gamepad) {
    const controllerId = this.getControllerId(gamepad);
    delete this.controllers[gamepad.index];
    delete this.buttonState[gamepad.index];
    delete this.analogState[gamepad.index];
    delete this.controllerMappings[controllerId];
    delete this.controllerUseWASD[controllerId];
    this.refreshTestingControllerOptionsIfOpen?.();
  }

  // Full per-controller state shape. Everything that reads stick sub-objects
  // assumes they exist, so resets must produce this — not a bare {}.
  initialButtonState() {
    return {
      // D-pad states
      dpadLeft: false,
      dpadRight: false,
      dpadUp: false,
      dpadDown: false,
      // Face button states
      faceSouth: false,
      faceNorth: false,
      faceEast: false,
      faceWest: false,
      // Special states
      osdCombo: false,
      // Analog stick digital states
      leftStick: { pressed: false, nav: { left: false, right: false, up: false, down: false } },
      rightStick: { pressed: false, nav: { left: false, right: false, up: false, down: false } }
    };
  }

  resetButtonStates() {
    for (let controllerIndex in this.controllers) {
      this.buttonState[controllerIndex] = this.initialButtonState();
    }
  }

  // Self-heal: return the state object for a controller, creating it (and its
  // stick sub-objects) if anything left it missing or partially formed.
  ensureButtonState(controllerIndex) {
    let bs = this.buttonState[controllerIndex];
    if (!bs) bs = this.buttonState[controllerIndex] = this.initialButtonState();
    if (!bs.leftStick || typeof bs.leftStick !== 'object') {
      bs.leftStick = { pressed: false, nav: { left: false, right: false, up: false, down: false } };
    }
    if (!bs.rightStick || typeof bs.rightStick !== 'object') {
      bs.rightStick = { pressed: false, nav: { left: false, right: false, up: false, down: false } };
    }
    return bs;
  }

  processInputs() {
    for (let controllerIndex in this.controllers) {
      const controller = this.controllers[controllerIndex];
      if (!controller || !controller.id) continue;
      if (!this.shouldProcessController(controller)) continue;
      const controllerId = this.getControllerId(controller);
      const mapping = this.controllerMappings[controllerId];
      const useWASD = this.controllerUseWASD[controllerId];

      if (!mapping) continue; // Don't process if no mapping is loaded

      // Snapshot previous button state to detect rising edges reliably within
      // this frame. ensureButtonState self-heals a missing/partial entry so a
      // controller can never crash the poll loop on its stick sub-objects.
      const prevButtonState = { ...this.ensureButtonState(controllerIndex) };

      // Process all mapped buttons
      this.processButtonGroup('dpad', controller, controllerIndex, prevButtonState, mapping, useWASD);
      this.processButtonGroup('face', controller, controllerIndex, prevButtonState, mapping, useWASD);
      this.processButtonGroup('shoulder', controller, controllerIndex, prevButtonState, mapping, useWASD);
      this.processButtonGroup('special', controller, controllerIndex, prevButtonState, mapping, useWASD);

      // Process analog sticks
      this.processAnalogSticks(controller, controllerIndex, mapping);
    }
  }

  processButtonGroup(groupName, controller, controllerIndex, prevButtonState, mapping, useWASD) {
    const group = mapping[groupName];
    if (!group) return;

    // D-pad press state comes from readDpad() so non-standard pads (hat switch
    // on an axis, digital D-pad axes, or shifted button indices) drive it — not
    // just the standard buttons 12-15.
    const dpadDirs = groupName === 'dpad' ? this.readDpad(controller, mapping) : null;

    for (let buttonName in group) {
      const buttonMapping = group[buttonName];
      const button = controller.buttons[buttonMapping.gamepadButton];

      if (dpadDirs || button) {
        const isStick = buttonName === 'leftStick' || buttonName === 'rightStick';
        const wasPressed = isStick ? (prevButtonState[buttonName] && prevButtonState[buttonName].pressed) : (prevButtonState[buttonName] || false);
        const isPressed = dpadDirs ? !!dpadDirs[buttonName] : button.pressed;

        const swallow = this.shouldSwallowFor(controllerIndex);

        // Button press (rising edge)
        if (isPressed && !wasPressed) {
          // Intercept Start while in-game for custom actions (simulate touch / Phaser scene start)
          if (!swallow && groupName === 'special' && buttonName === 'start') {
            const handled = this.handleStartInGame();
            if (handled) {
              // Latch state and skip default dispatch — continue (not return)
              // so the rest of this group still edge-processes this frame.
              this.buttonState[controllerIndex][buttonName] = isPressed;
              continue;
            }
          }
          // While testing (for this controller), swallow inputs entirely (no actions)
          if (swallow) {
            // no-op: allow state update below for visualization
          }
          // FBTN_RIGHT closes controller configurator if open; otherwise fall
          // through
          else if (this.isConfiguratorOpen && this.isConfiguratorOpen() && groupName === 'face' && buttonName === 'btnRight') {
            try { this.closeConfigurator(); } catch (_) {}
            this.buttonState[controllerIndex].faceEast = true;
            // Latch the edge key too, or the still-held press re-fires as a
            // fresh rising edge next frame (post-close) and leaks a keydown
            // into the game.
            this.buttonState[controllerIndex][buttonName] = isPressed;
            continue;
          }
          // While overlays are open, don't forward most groups to the game
          else if (this.isAnyOverlayOpen && this.isAnyOverlayOpen() && (groupName === 'dpad' || groupName === 'face' || groupName === 'shoulder')) {
            // Latch FBTN_BOTTOM/FBTN_RIGHT so releasing after closing overlay
            // won't trigger launcher actions
            if (groupName === 'face' && buttonName === 'btnBottom') this.buttonState[controllerIndex].faceSouth = true;
            if (groupName === 'face' && buttonName === 'btnRight') this.buttonState[controllerIndex].faceEast = true;
            // Overlay-specific handling handled elsewhere
          } else {
            const eff = this.getEffectiveMappingForLayout(groupName, buttonName, buttonMapping, useWASD);
            this.dispatchKeyboardEvent('keydown', eff);
            this.handleSpecialActions(groupName, buttonName, controllerIndex);
          }
        }
        // Button release (falling edge)
        else if (!isPressed && wasPressed) {
          if (swallow) {
            // swallow
          } else if (this.isAnyOverlayOpen && this.isAnyOverlayOpen() && (groupName === 'dpad' || groupName === 'face' || groupName === 'shoulder')) {
            if (groupName === 'face' && buttonName === 'btnBottom') this.buttonState[controllerIndex].faceSouth = false;
            if (groupName === 'face' && buttonName === 'btnRight') this.buttonState[controllerIndex].faceEast = false;
          } else {
            const eff = this.getEffectiveMappingForLayout(groupName, buttonName, buttonMapping, useWASD);
            this.dispatchKeyboardEvent('keyup', eff);
          }
        }

        if (isStick) {
          this.buttonState[controllerIndex][buttonName].pressed = isPressed;
        } else {
          this.buttonState[controllerIndex][buttonName] = isPressed;
        }
      }
    }
  }

  // Map Arrow keys to WASD when enabled for D-pad only
  getEffectiveMappingForLayout(groupName, buttonName, mapping, useWASD) {
    try {
      if (groupName === 'dpad' && useWASD) {
        const map = {
          up: 'w',
          down: 's',
          left: 'a',
          right: 'd',
        };
        const k = map[buttonName];
        if (k) {
          const keyCode = this.getKeyCode(k);
          return { ...mapping, keyboardKey: k, keyCode };
        }
      }
    } catch (_) {}
    return mapping;
  }

  processAnalogSticks(controller, controllerIndex, mapping) {
    // Check if axes exist (some controllers might not have them)
    if (!controller.axes || controller.axes.length < 4) return;

    // Left stick (axes 0,1)
    const leftStick = {
      x: this.applyDeadzone(controller.axes[0] || 0),
      y: this.applyDeadzone(controller.axes[1] || 0)
    };

    // Right stick (axes 2,3)
    const rightStick = {
      x: this.applyDeadzone(controller.axes[2] || 0),
      y: this.applyDeadzone(controller.axes[3] || 0)
    };

    this.analogState[controllerIndex] = { leftStick, rightStick };

    // Convert analog to digital for launcher navigation
    this.processAnalogToDigital(leftStick, controllerIndex, 'leftStick');
    this.processAnalogToDigital(rightStick, controllerIndex, 'rightStick');
  }

  applyDeadzone(value, deadzone = 0.15) {
    return Math.abs(value) > deadzone ? value : 0;
  }

  processAnalogToDigital(stick, controllerIndex, stickName) {
    // Launcher navigation moved to the dashboard's own poll loop; this now only
    // tracks digital nav state for the configurator's button-testing visuals.
    const threshold = 0.5;
    const stickState = this.buttonState[controllerIndex][stickName];
    stickState.nav = {
      left: stick.x < -threshold,
      right: stick.x > threshold,
      up: stick.y < -threshold,
      down: stick.y > threshold,
    };
  }

  // Robustly derive D-pad direction state across the many ways controllers
  // report it. Standard pads use buttons 12-15; non-standard pads (SNES/USB
  // adapters, common on Chrome and Firefox) instead expose the D-pad as an
  // encoded hat switch on an axis, as digital axes, or at shifted button
  // indices. We OR every known source so the D-pad lights up and dispatches
  // keys regardless of how this particular pad/browser reports it.
  readDpad(controller, mapping) {
    const b = controller.buttons || [];
    const ax = controller.axes || [];
    const pressed = (i) => !!(b[i] && b[i].pressed);

    // SNES-style pads (e.g. the Switch-Online SNES pad, 057e:2017) never
    // report a real D-pad on the raw 12-15 button slots — those hold other
    // bits (Home/Capture, or Select/Start on some platforms). The compat
    // plugin (loaded on every page that uses this manager) rebuilds 12-15
    // from the pad's hat/digital axes, so trust exactly those normalized
    // slots plus the encoded hat, and skip the generic shifted-index
    // guesses below that misfire on this pad.
    if (this.isSnesController(controller)) {
      const dirs = ax.length > 9 ? this.decodeHat(ax[9]) : { up: false, down: false, left: false, right: false };
      dirs.up = dirs.up || pressed(12);
      dirs.down = dirs.down || pressed(13);
      dirs.left = dirs.left || pressed(14);
      dirs.right = dirs.right || pressed(15);
      return dirs;
    }

    const dpadMap = (mapping && mapping.dpad) || {};
    const mapped = (name, fallback) => {
      const m = dpadMap[name];
      const gi = m && typeof m.gamepadButton === 'number' ? m.gamepadButton : fallback;
      return pressed(gi);
    };

    // 1) Mapped/standard button indices (respects a user remap; defaults 12-15).
    let up = mapped('up', 12), down = mapped('down', 13),
        left = mapped('left', 14), right = mapped('right', 15);

    // 2) Shifted indices some non-standard layouts use (e.g. Firefox).
    up = up || pressed(16) || pressed(18) || pressed(20);
    down = down || pressed(17) || pressed(19) || pressed(21);

    // 3) Dedicated digital D-pad axes (value -1/0/+1), distinct from analog
    //    sticks. Only trust them when in [-1.05, 1.05] (skip neutral sentinels).
    const axOk = (v) => typeof v === 'number' && Math.abs(v) <= 1.05;
    if (axOk(ax[6])) { if (ax[6] <= -0.5) left = true; else if (ax[6] >= 0.5) right = true; }
    if (axOk(ax[7])) { if (ax[7] <= -0.5) up = true; else if (ax[7] >= 0.5) down = true; }

    // 4) Encoded 8-way hat switch (commonly axes[9]; neutral reads as a >1
    //    sentinel like 1.2857). Decode to the nearest of the 8 positions.
    const hat = this.decodeHat(ax[9]);
    up = up || hat.up; down = down || hat.down; left = left || hat.left; right = right || hat.right;

    return { up, down, left, right };
  }

  // Decode a normalized POV-hat axis value into directional booleans. The
  // common encoding maps states 0..7 (N, NE, E, SE, S, SW, W, NW) to
  // 2*state/7 - 1, so neutral (state 8) lands at ~1.2857 (> 1). Values outside
  // [-1.05, 1.05] are treated as neutral/absent.
  decodeHat(v) {
    const res = { up: false, down: false, left: false, right: false };
    if (typeof v !== 'number' || v > 1.05 || v < -1.05) return res;
    // Only accept values on the 8-step grid: 0 (an untouched axis on some
    // stacks) sits between steps and would decode as a phantom "down".
    const scaled = (v + 1) * 3.5;
    if (Math.abs(scaled - Math.round(scaled)) > 0.25) return res;
    const state = ((Math.round(scaled) % 8) + 8) % 8; // inverse of 2*state/7 - 1
    switch (state) {
      case 0: res.up = true; break;
      case 1: res.up = true; res.right = true; break;
      case 2: res.right = true; break;
      case 3: res.down = true; res.right = true; break;
      case 4: res.down = true; break;
      case 5: res.down = true; res.left = true; break;
      case 6: res.left = true; break;
      case 7: res.up = true; res.left = true; break;
    }
    return res;
  }

  // Handle Start press when in-game: simulate a click and/or start a Phaser scene
  handleStartInGame() {
    try {
      // Only act when a game is running and no overlays are open
      const inGame = document.body.classList.contains('playing');
      if (!inGame) return false;
      if (this.isAnyOverlayOpen && this.isAnyOverlayOpen()) return false;

      // Try starting a Phaser scene if configured
      const sceneName = (this.startSceneName || '').trim();
      if (sceneName) {
        try { this.tryStartPhaserScene(sceneName); } catch (_) {}
      }

      // Simulate click if enabled (default)
      if (this.simulateTouchOnStart) {
        try { this.dispatchSyntheticClick(); } catch (e) { console.warn('Synthetic click failed', e); }
      }
      return true;
    } catch (_) { return false; }
  }

  // Attempt to start a Phaser scene inside the iframe using common globals
  tryStartPhaserScene(sceneName) {
    const iframe = document.querySelector('iframe#gameframe');
    if (!iframe) return false;
    let ok = false;
    try {
      const w = iframe.contentWindow;
      if (!w) return false;
      // window.gameScene
      try {
        const gs = w.gameScene || w.window?.gameScene;
        if (gs && gs.scene && typeof gs.scene.start === 'function') {
          gs.scene.start(sceneName);
          ok = true;
        }
      } catch (_) {}
      // globalThis.__PHASER_GAME__
      if (!ok) {
        try {
          const g = w.__PHASER_GAME__ || w.globalThis?.__PHASER_GAME__;
          const scene = g && g.scene && g.scene.scenes && g.scene.scenes[0] && g.scene.scenes[0].scene;
          if (scene && typeof scene.start === 'function') {
            scene.start(sceneName);
            ok = true;
          }
        } catch (_) {}
      }
    } catch (err) {
      console.warn('Error attempting Phaser scene start:', err);
    }
    return ok;
  }

  // Dispatch a quick click (pointer/mouse/click) to a target inside the iframe (searches nested frames if a selector is provided)
  dispatchSyntheticClick() {
    const iframe = document.querySelector('iframe#gameframe');
    if (!iframe) return false;
    try {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) return false;

      // If not fully loaded, defer until load completes
      if (doc.readyState !== 'complete') {
        try { iframe.addEventListener('load', () => { try { this.dispatchSyntheticClick(); } catch(_){} }, { once: true }); } catch (_) {}
        return true;
      }

      // Resolve target element
      let target = null;
      const sel = (this.touchTargetSelector || '').trim();
      if (sel) {
        target = this.findInFrames(iframe, sel) || null;
      }
      if (!target) {
        // Prefer visible canvas across nested frames; fallback to first canvas in outer; else body
        target = this.findInFrames(iframe, 'canvas');
        if (!target) {
          const canvases = Array.from(doc.querySelectorAll('canvas'));
          const visible = canvases.filter(c => (c.offsetWidth > 0 && c.offsetHeight > 0));
          target = (visible[0] || canvases[0] || doc.body);
        }
      }
      if (!target) return false;

      const rect = target.getBoundingClientRect();
      const cx = Math.floor(rect.left + rect.width / 2);
      const cy = Math.floor(rect.top + rect.height / 2);

      const commonInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: cx,
        clientY: cy,
        screenX: cx,
        screenY: cy,
        view: win,
      };

      const view = (target && target.ownerDocument && target.ownerDocument.defaultView) || win;
      const fire = (ev) => { try { target.dispatchEvent(ev); } catch (_) {} };

      // Native click first
      try { target.click(); } catch (_) {}

      // Pointer events are widely supported and Phaser often listens to them
      try {
        const down = new view.PointerEvent('pointerdown', { ...commonInit, pointerType: 'mouse', isPrimary: true, pointerId: 1, buttons: 1, button: 0 });
        fire(down);
        const up = new view.PointerEvent('pointerup', { ...commonInit, pointerType: 'mouse', isPrimary: true, pointerId: 1, buttons: 0, button: 0 });
        // Slight delay to mimic a tap
        setTimeout(() => fire(up), 35);
        // continue to mouse sequence below
      } catch (_) {}

      // Fallback: mouse events
      try {
        const mdown = new view.MouseEvent('mousedown', { ...commonInit, button: 0 });
        fire(mdown);
        const mup = new view.MouseEvent('mouseup', { ...commonInit, button: 0 });
        setTimeout(() => fire(mup), 35);
        // also fire click
        setTimeout(() => fire(new view.MouseEvent('click', { ...commonInit, button: 0 })), 40);
      } catch (_) {}
      return true;
    } catch (err) {
      console.warn('Synthetic click error:', err);
      return false;
    }
  }

  // Search nested iframes starting from an outer iframe element for a selector; returns the first matching element or null
  findInFrames(rootFrameEl, selector) {
    const stack = [rootFrameEl];
    while (stack.length) {
      const frameEl = stack.pop();
      try {
        const win = frameEl && frameEl.contentWindow;
        const doc = win && win.document;
        if (!doc) continue;

        // Try in this frame
        const hit = doc.querySelector(selector);
        if (hit) return hit;

        // Enqueue children iframes
        const children = doc.querySelectorAll('iframe');
        for (const child of children) {
          if (child && child.contentWindow) stack.push(child);
        }
      } catch (_) {
        // Cross-origin: skip
        continue;
      }
    }
    return null;
  }

  isAnyOverlayOpen() {
    // Input must NOT reach the game while a launcher overlay is up: the in-game
    // OSD (dashboard) sets body.osd-open; the controller configurator adds
    // .controller-configurator.visible; the soft-mod cinematic sets
    // body.softmod-open.
    const body = typeof document !== 'undefined' ? document.body : null;
    return (this.isConfiguratorOpen && this.isConfiguratorOpen()) ||
      (!!body && (body.classList.contains('osd-open') || body.classList.contains('softmod-open')));
  }

  // Minimal check for controller configurator visibility
  isConfiguratorOpen() {
    const el = document.querySelector('.controller-configurator');
    return !!el && el.classList.contains('visible');
  }

  // Testing is active only when toggle is on and configurator is open
  isTestingActive() {
    return !!this.testingMode && (this.isConfiguratorOpen && this.isConfiguratorOpen());
  }

  // Swallow inputs for ALL controllers while testing is active
  // Rationale: During live button testing, no controller should
  // navigate the launcher or close overlays (e.g., via FBTN_RIGHT). The
  // controller selection only affects visualization aggregation,
  // not input routing. This prevents other controllers from
  // interacting with the launcher while testing a single controller.
  shouldSwallowFor(controllerIndex) {
    // wizardActive: the Button Mapping Wizard is capturing raw presses — no
    // pad input may reach the launcher or game (FBTN_RIGHT would close the
    // configurator underneath, etc.).
    return !!(this.isTestingActive && this.isTestingActive()) || !!this.wizardActive;
  }

  // ===== Per-game key routing preference =====
  // Active game id derived from iframe path /games/<id>/...
  getActiveGameId() {
    try {
      const iframe = document.querySelector('iframe#gameframe');
      if (!iframe) return null;
      let path = '';
      try { path = iframe.contentWindow?.location?.pathname || ''; } catch(_) {}
      if (!path) {
        try { path = new URL(iframe.src, location.origin).pathname; } catch(_) {}
      }
      if (!path) return null;
      const segs = (path.startsWith('/') ? path.slice(1) : path).split('/');
      if (segs[0] !== 'games') return null;
      return segs[1] || null;
    } catch(_) { return null; }
  }

  getKeydownOnlyForGame(gameId) {
    try { return localStorage.getItem(`cmg_keydownOnly_${gameId}`) === '1'; } catch(_) { return false; }
  }

  setKeydownOnlyForGame(gameId, enabled) {
    try { localStorage.setItem(`cmg_keydownOnly_${gameId}`, enabled ? '1' : '0'); } catch(_) {}
  }

  isKeydownOnlyMode() {
    const id = this.getActiveGameId();
    if (!id) return false;
    return this.getKeydownOnlyForGame(id);
  }

  handleSpecialActions(_groupName, _buttonName, _controllerIndex) {
    // Home used to toggle fullscreen from here. It doesn't any more:
    //   - fullscreen is R3's job now, and it only ever ENTERS (see
    //     requestFullscreenFromPad in Dashboard.svelte), because a toggle bound
    //     to a button games also receive kicks players out mid-game;
    //   - Home is the arcade player's quick-load (static/arcade/play.html), and
    //     a fullscreen toggle riding along with every state load was wrong.
    // Kept as a hook for future per-button special actions.
  }

  dispatchKeyboardEvent(eventType, mapping) {
    // Only dispatch to games when in playing mode and no overlay is open
    if (!document.body.classList.contains('playing')) return;
    if (this.isAnyOverlayOpen && this.isAnyOverlayOpen()) return;

    // Per-game: optionally route only keydown (skip keyup/keypress)
    const onlyDown = (this.isKeydownOnlyMode && this.isKeydownOnlyMode()) || false;
    if (onlyDown && eventType !== 'keydown') return;

    const iframe = document.querySelector('iframe#gameframe');
    let targetWin = null;
    try { targetWin = iframe && iframe.contentWindow ? iframe.contentWindow : null; } catch (_) { targetWin = null; }

    // Probe same-origin access once: reading ANY property of a cross-origin
    // frame's window throws SecurityError, so guard it in try/catch.
    let targetDoc = null;
    let sameOrigin = false;
    if (targetWin) {
      try { targetDoc = targetWin.document; sameOrigin = true; } catch (_) { targetDoc = null; sameOrigin = false; }
    }

    // We can't inject synthetic keyboard events into a cross-origin game frame
    // — the browser blocks all access. Such games read the Gamepad API directly
    // (the iframe has allow="gamepad"), so bail out quietly. Throwing here would
    // propagate up through poll() and kill the entire polling loop.
    if (targetWin && !sameOrigin) return;

    const key = mapping.keyboardKey;
    const code = key === ' ' ? 'Space' : (key.length === 1 ? `Key${key.toUpperCase()}` : key);

    const setLegacyProps = (event, codeVal) => {
      try {
        Object.defineProperty(event, 'keyCode', { get: () => codeVal });
        Object.defineProperty(event, 'which', { get: () => codeVal });
        Object.defineProperty(event, 'charCode', { get: () => codeVal });
      } catch (_) { /* ignore */ }
    };

    const makeEvent = (target, type) => {
      const view = (target && target.ownerDocument && target.ownerDocument.defaultView) || targetWin || window;
      let EvtCtor = KeyboardEvent;
      try { if (view && view.KeyboardEvent) EvtCtor = view.KeyboardEvent; } catch (_) { EvtCtor = KeyboardEvent; }

      const event = new EvtCtor(type, {
        key,
        code,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      setLegacyProps(event, mapping.keyCode);
      return event;
    };

    // Ruffle listens on its custom element; canvas games still receive the
    // bubbled event from their visible game surface.
    const target = this.getKeyboardDispatchTarget(targetDoc, targetWin);
    try { target.dispatchEvent(makeEvent(target, eventType)); } catch (_) { /* ignore dispatch errors */ }
    if (!onlyDown && key === ' ' && eventType === 'keydown') {
      try { target.dispatchEvent(makeEvent(target, 'keypress')); } catch (_) { /* ignore dispatch errors */ }
    }
  }

  getKeyboardDispatchTarget(targetDoc, targetWin) {
    try {
      if (!targetDoc) return targetWin || document;

      const active = targetDoc.activeElement;
      if (active && active !== targetDoc.body && active !== targetDoc.documentElement) {
        return active;
      }

      const selectors = [
        'ruffle-player',
        'ruffle-embed',
        'ruffle-object',
        'canvas',
        '[tabindex]',
      ];

      for (const selector of selectors) {
        const elements = Array.from(targetDoc.querySelectorAll(selector));
        const visible = elements.find((element) => {
          try {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          } catch (_) {
            return false;
          }
        });
        if (visible) return visible;
      }

      return targetDoc.body || targetDoc;
    } catch (_) {
      return targetDoc || targetWin || document;
    }
  }

  getKeyCode(key) {
    // Map common keys to keyCodes
    const keyCodeMap = {
      'Enter': 13, 'Escape': 27, ' ': 32, 'Backspace': 8, 'Tab': 9,
      'ArrowUp': 38, 'ArrowDown': 40, 'ArrowLeft': 37, 'ArrowRight': 39,
      'a': 65, 'b': 66, 'c': 67, 'd': 68, 'e': 69, 'f': 70, 'g': 71, 'h': 72,
      'i': 73, 'j': 74, 'k': 75, 'l': 76, 'm': 77, 'n': 78, 'o': 79, 'p': 80,
      'q': 81, 'r': 82, 's': 83, 't': 84, 'u': 85, 'v': 86, 'w': 87, 'x': 88,
      'y': 89, 'z': 90
    };

    return keyCodeMap[key] || key.charCodeAt(0);
  }

  // ===== Preferences (WASD layout) =====
  setUseWASDForDpad(controllerId, enabled) {
    if (!controllerId) return;
    this.controllerUseWASD[controllerId] = !!enabled;
    try { localStorage.setItem(`gamepadUseWASD_${controllerId}`, enabled ? '1' : '0'); } catch (_) {}
  }

  loadUseWASDPreference(controllerId) {
    if (!controllerId) return false;
    try {
      const v = localStorage.getItem(`gamepadUseWASD_${controllerId}`);
      if (v !== null) {
        return v === '1' || v === 'true';
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  // ===== Preferences (Start actions) =====
  setSimulateTouchOnStart(enabled) {
    this.simulateTouchOnStart = !!enabled;
    try { localStorage.setItem('gamepadStartSimTouch', this.simulateTouchOnStart ? '1' : '0'); } catch (_) {}
  }

  setTouchTargetSelector(selector) {
    this.touchTargetSelector = selector || '';
    try { localStorage.setItem('gamepadTouchTargetSelector', this.touchTargetSelector); } catch (_) {}
  }

  setStartSceneName(name) {
    this.startSceneName = name || '';
    try { localStorage.setItem('gamepadStartSceneName', this.startSceneName); } catch (_) {}
  }

  loadStartTouchPreference() {
    try {
      const v = localStorage.getItem('gamepadStartSimTouch');
      // Default ON when unset
      return v === null ? true : (v === '1' || v === 'true');
    } catch (_) { return true; }
  }

  loadTouchTargetPreference() {
    try { return localStorage.getItem('gamepadTouchTargetSelector') || ''; } catch (_) { return ''; }
  }

  loadStartScenePreference() {
    try { return localStorage.getItem('gamepadStartSceneName') || ''; } catch (_) { return ''; }
  }

  saveMapping(controllerId) {
    if (!controllerId) return;
    const mapping = this.controllerMappings[controllerId];
    if (mapping) {
      try {
        localStorage.setItem(`gamepadMapping_${controllerId}`, JSON.stringify(mapping));
      } catch (e) {
        console.warn('Unable to persist controller mapping to localStorage', e);
      }
    }
  }

  loadMapping(controllerId) {
    if (!controllerId) return JSON.parse(JSON.stringify(this.defaultMapping));
    let saved = null;
    try {
      saved = localStorage.getItem(`gamepadMapping_${controllerId}`);
    } catch (_) {
      saved = null;
    }

    // For seamless migration, check for old global mapping if no specific one is found.
    // This will effectively copy the old setting to the first controller that connects.
    let mappingToParse = saved;
    if (!mappingToParse) {
      try {
        const oldGlobal = localStorage.getItem('gamepadMapping');
        if (oldGlobal) {
          mappingToParse = oldGlobal;
          // To prevent all controllers from getting this, we should remove it.
          // This migration will only happen once per user.
          localStorage.removeItem('gamepadMapping');
          // Also migrate the old WASD setting
          const oldWASD = localStorage.getItem('gamepadUseWASD');
          if (oldWASD) {
            this.setUseWASDForDpad(controllerId, oldWASD === '1' || oldWASD === 'true');
            localStorage.removeItem('gamepadUseWASD');
          }
        }
      } catch (_) { /* ignore */ }
    }

    let mapping = null;
    if (mappingToParse) {
      try {
        mapping = JSON.parse(mappingToParse);
      } catch (_) {
        mapping = null;
      }
    }
    if (!mapping) {
      mapping = JSON.parse(JSON.stringify(this.defaultMapping));
    }
    // Migrate old face button keys (north/east/south/west) to new names
    try {
      if (mapping && mapping.face) {
        const f = mapping.face;
        const needsMigration = 'north' in f || 'east' in f || 'south' in f || 'west' in f;
        if (needsMigration) {
          mapping.face = {
            btnTop: f.north || this.defaultMapping.face.btnTop,
            btnRight: f.east || this.defaultMapping.face.btnRight,
            btnBottom: f.south || this.defaultMapping.face.btnBottom,
            btnLeft: f.west || this.defaultMapping.face.btnLeft,
          };
        }
      }
    } catch (_) { /* ignore migration errors */ }
    return mapping;
  }

}

// Expose the class so controller-configurator.js can augment its prototype, plus
// a shared singleton for the launcher and inline on* handlers. Guarded so this
// module can also be imported in a non-browser context (SSR/tests) without throwing.
if (typeof window !== 'undefined') {
  window.GamepadManager = GamepadManager;
  // Reuse an existing instance if the script is loaded (or imported) more than once.
  window.gamepadManager = window.gamepadManager || new GamepadManager();
  console.log('Gamepad support initialized');
}

// ES module exports so other web games can import this class.
export { GamepadManager };
export default GamepadManager;
