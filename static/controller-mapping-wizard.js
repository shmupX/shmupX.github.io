// Button Mapping Wizard — opened from Controller Settings > Button Mapping.
//
// Walks the player through pressing each physical control (D-pad, face
// buttons, bumpers/triggers, Select/Start, analog sticks if present) and
// records which raw button index, digital axis, or hat-switch direction the
// pad actually reports for each one. The result is saved as a mapping profile
// (localStorage "cmgPadProfiles", keyed by pad id) that
// gamepad-compatibility-plugin.js applies globally: every consumer of
// navigator.getGamepads() then sees the pad as a normal standard-layout
// (Xbox-360-style) controller — so an SNES pad, a generic USB adapter, or any
// oddball HID pad drives the launcher and every game exactly like an Xbox pad.
//
// Loaded as an ES module after controller-configurator.js; augments
// GamepadManager.prototype the same way the configurator does.
import { GamepadManager } from './gamepad-support.js';

(function () {
  if (!GamepadManager || !window.gamepadManager) {
    console.warn('[mapping-wizard] GamepadManager not initialized; skipping.');
    return;
  }

  const PROFILE_STORAGE_KEY = 'cmgPadProfiles';

  // Standard-gamepad slots (https://w3c.github.io/gamepad/#remapping):
  // 0 A · 1 B · 2 X · 3 Y · 4 LB · 5 RB · 6 LT · 7 RT · 8 Select · 9 Start ·
  // 10 LS click · 11 RS click · 12-15 D-pad U/D/L/R. Axes 0/1 left stick,
  // 2/3 right stick.
  //
  // Step kinds: 'press' captures a button/axis/hat binding for a standard
  // button slot; 'stick-axis' captures a raw axis (+ inversion) for a standard
  // axis slot. `stick` groups stick steps so skipping the first skips the rest
  // (pads like the SNES have no sticks at all).
  const STEPS = [
    { kind: 'press', slot: 12, section: 'D-Pad', label: 'D-Pad UP', dir: 'up' },
    { kind: 'press', slot: 13, section: 'D-Pad', label: 'D-Pad DOWN', dir: 'down' },
    { kind: 'press', slot: 14, section: 'D-Pad', label: 'D-Pad LEFT', dir: 'left' },
    { kind: 'press', slot: 15, section: 'D-Pad', label: 'D-Pad RIGHT', dir: 'right' },

    { kind: 'press', slot: 0, section: 'Face Buttons', label: 'BOTTOM face button', hint: 'A on Xbox · B on SNES/Switch · Cross on PlayStation' },
    { kind: 'press', slot: 1, section: 'Face Buttons', label: 'RIGHT face button', hint: 'B on Xbox · A on SNES/Switch · Circle on PlayStation' },
    { kind: 'press', slot: 2, section: 'Face Buttons', label: 'LEFT face button', hint: 'X on Xbox · Y on SNES/Switch · Square on PlayStation' },
    { kind: 'press', slot: 3, section: 'Face Buttons', label: 'TOP face button', hint: 'Y on Xbox · X on SNES/Switch · Triangle on PlayStation' },

    { kind: 'press', slot: 4, section: 'Bumpers & Triggers', label: 'LEFT bumper', hint: 'LB / L / L1' },
    { kind: 'press', slot: 5, section: 'Bumpers & Triggers', label: 'RIGHT bumper', hint: 'RB / R / R1' },
    { kind: 'press', slot: 6, section: 'Bumpers & Triggers', label: 'LEFT trigger', hint: 'LT / ZL / L2 — Skip if this pad has no triggers', optional: true },
    { kind: 'press', slot: 7, section: 'Bumpers & Triggers', label: 'RIGHT trigger', hint: 'RT / ZR / R2 — Skip if this pad has no triggers', optional: true },

    { kind: 'press', slot: 8, section: 'Select & Start', label: 'SELECT', hint: 'Select / Back / Minus', optional: true },
    { kind: 'press', slot: 9, section: 'Select & Start', label: 'START', hint: 'Start / Menu / Plus', optional: true },

    { kind: 'stick-axis', axisSlot: 0, section: 'Left Stick', label: 'Push the LEFT STICK fully LEFT', expectSign: -1, stick: 'left', stickFirst: true, optional: true, hint: 'Skip if this pad has no analog sticks' },
    { kind: 'stick-axis', axisSlot: 1, section: 'Left Stick', label: 'Push the LEFT STICK fully UP', expectSign: -1, stick: 'left', optional: true },
    { kind: 'press', slot: 10, section: 'Left Stick', label: 'CLICK the LEFT STICK (press it in)', stick: 'left', optional: true, hint: 'Skip if the stick does not click' },

    { kind: 'stick-axis', axisSlot: 2, section: 'Right Stick', label: 'Push the RIGHT STICK fully LEFT', expectSign: -1, stick: 'right', stickFirst: true, optional: true, hint: 'Skip if this pad has one stick or none' },
    { kind: 'stick-axis', axisSlot: 3, section: 'Right Stick', label: 'Push the RIGHT STICK fully UP', expectSign: -1, stick: 'right', optional: true },
    { kind: 'press', slot: 11, section: 'Right Stick', label: 'CLICK the RIGHT STICK (press it in)', stick: 'right', optional: true, hint: 'Skip if the stick does not click' },
  ];

  const AXIS_CAPTURE_DELTA = 0.6;   // how far an axis must move from baseline to count
  const NEUTRAL_DELTA = 0.35;       // how close to baseline counts as "released"
  const HOLD_TO_ACT_MS = 1500;      // hold-any-control duration for skip (steps) / save (summary)

  class WizardMixin {

  openMappingWizard() {
    if (this._wizard) return;

    // Read raw, un-normalized pads: the compat plugin patches
    // navigator.getGamepads, and capturing through an existing profile or the
    // SNES normalization would record the translated layout, not the pad.
    const readRaw = () => {
      try {
        const compat = window.CMGGamepadCompat;
        if (compat && typeof compat.raw === 'function') return compat.raw() || [];
      } catch (_) {}
      try { return navigator.getGamepads() || []; } catch (_) { return []; }
    };

    // Target the controller selected in the configurator dropdown; with "all"
    // (or standalone) the wizard locks onto the first pad that shows input.
    let targetPadId = null;
    try {
      const sel = document.querySelector('#config-controller-select');
      if (sel && sel.value && sel.value !== 'all') targetPadId = sel.value;
    } catch (_) {}

    this._wizard = {
      readRaw,
      targetPadId,
      stepIndex: 0,
      results: {},        // step index -> binding | {skipped: true}
      skippedSticks: {},  // 'left'/'right' -> true
      rest: null,         // resting snapshot of the untouched pad; every
                          // capture and release check compares against this
      awaitingNeutral: true,
      pendingHold: null,  // optional-step press being held: { binding, start }
      sum: null,          // summary-screen pad state: { save, back, holdStart }
      raf: 0,
    };

    // Swallow all pad input from the launcher/game while the wizard runs
    // (gamepad-support.js checks this in shouldSwallowFor).
    this.wizardActive = true;

    this.createWizardUI();
    this._wizardTick();
  }

  closeMappingWizard() {
    const w = this._wizard;
    if (!w) return;
    if (w.raf) cancelAnimationFrame(w.raf);
    this._wizard = null;
    this.wizardActive = false;
    const el = document.querySelector('.mapping-wizard');
    if (el) {
      el.classList.remove('visible');
      setTimeout(() => el.remove(), 250);
    }
  }

  createWizardUI() {
    const existing = document.querySelector('.mapping-wizard');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.className = 'mapping-wizard';
    el.innerHTML = `
      <div class="wizard-overlay">
        <div class="wizard-panel">
          <div class="wizard-header">
            <h2>Button Mapping Wizard</h2>
            <button class="close-btn" id="wizard-cancel-x">&times;</button>
          </div>
          <div class="wizard-pad-id" id="wizard-pad-id">Press any button on the controller you want to map&hellip;</div>
          <div class="wizard-body">
            <div class="wizard-section" id="wizard-section"></div>
            <div class="wizard-prompt" id="wizard-prompt"></div>
            <div class="wizard-hint" id="wizard-hint"></div>
            <div class="wizard-captured" id="wizard-captured"></div>
            <div class="wizard-hold" id="wizard-hold" style="display:none;">
              <div class="wizard-hold-track"><div class="wizard-hold-fill"></div></div>
              <div class="wizard-hold-label">hold to skip&hellip;</div>
            </div>
            <div class="wizard-progress" id="wizard-progress"></div>
          </div>
          <div class="wizard-footer">
            <button id="wizard-back-btn">&larr; Back</button>
            <div class="wizard-footer-right">
              <button id="wizard-skip-btn">Skip</button>
              <button id="wizard-cancel-btn">Cancel</button>
              <button id="wizard-save-btn" style="display:none;">Save Mapping</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);

    el.querySelector('#wizard-cancel-x').addEventListener('click', () => this.closeMappingWizard());
    el.querySelector('#wizard-cancel-btn').addEventListener('click', () => this.closeMappingWizard());
    el.querySelector('#wizard-skip-btn').addEventListener('click', () => this._wizardSkip());
    el.querySelector('#wizard-back-btn').addEventListener('click', () => this._wizardBack());
    el.querySelector('#wizard-save-btn').addEventListener('click', () => this._wizardSave());

    setTimeout(() => el.classList.add('visible'), 30);
    this._renderWizardStep();
  }

  _wizardTargetPad() {
    const w = this._wizard;
    const pads = w.readRaw();
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      if (!w.targetPadId) {
        // Lock onto the first pad showing any input — a button press or an
        // axis move (hat/digital-axis D-pads produce no button presses).
        if (!w.lockBaselines) w.lockBaselines = {};
        const snap = this._snapshotPad(p);
        const base = w.lockBaselines[p.index];
        if (!base) {
          w.lockBaselines[p.index] = snap;
          continue;
        }
        const anyBtn = snap.buttons.some((pressed, j) => pressed && !base.buttons[j]);
        const anyAxis = snap.axes.some((v, j) => Math.abs(v - (base.axes[j] || 0)) > AXIS_CAPTURE_DELTA);
        if (anyBtn || anyAxis) {
          w.targetPadId = p.id;
          // The pre-input snapshot for this pad is its resting state; the
          // locking press itself is still held, so wait for release first.
          w.rest = base;
          w.awaitingNeutral = true;
          return p;
        }
        continue;
      }
      if (p.id === w.targetPadId) return p;
    }
    return null;
  }

  _snapshotPad(pad) {
    return {
      buttons: Array.from(pad.buttons || [], b => !!(b && b.pressed)),
      axes: Array.from(pad.axes || [], v => (typeof v === 'number' ? v : 0)),
    };
  }

  _padIsNeutral(pad, baseline) {
    const snap = this._snapshotPad(pad);
    if (snap.buttons.some(Boolean)) return false;
    for (let i = 0; i < snap.axes.length; i++) {
      const base = baseline && typeof baseline.axes[i] === 'number' ? baseline.axes[i] : snap.axes[i];
      // Hat axes rest OUTSIDE the ±1 grid (e.g. 1.2857). When the baseline is
      // a hat rest sentinel, "neutral" means the live value is back off-grid.
      // The plain delta test would accept a held diagonal (NW = 1.0, delta
      // 0.29 < NEUTRAL_DELTA) — and the rest refreshes that follow a passed
      // neutral gate would then record that held diagonal as "rest",
      // permanently corrupting every later hat capture.
      if (Math.abs(base) > 1.05) {
        if (Math.abs(snap.axes[i]) <= 1.05) return false;
        continue;
      }
      if (Math.abs(snap.axes[i] - base) > NEUTRAL_DELTA) return false;
    }
    return true;
  }

  _wizardTick() {
    const w = this._wizard;
    if (!w) return;
    w.raf = requestAnimationFrame(() => this._wizardTick());

    const pad = this._wizardTargetPad();
    const padIdEl = document.querySelector('#wizard-pad-id');
    if (!pad) {
      if (padIdEl && w.targetPadId) padIdEl.textContent = `Waiting for: ${w.targetPadId}`;
      return;
    }
    if (padIdEl) padIdEl.textContent = pad.id;

    if (w.stepIndex >= STEPS.length) { this._wizardSummaryTick(pad); return; }

    // First frame with a pre-selected pad: assume it's untouched and record
    // its resting snapshot. All captures diff against this rest state, and a
    // step only arms once the pad has returned to it — so one long press
    // can't register twice, and a release can never masquerade as a press.
    if (!w.rest) {
      w.rest = this._snapshotPad(pad);
      w.awaitingNeutral = true;
      return;
    }

    // Optional steps capture on RELEASE: a short press commits the binding,
    // while holding the control ~1.5s skips the step instead — the only
    // pad-only way to skip (e.g. "press LEFT trigger" on a pad without one).
    if (w.pendingHold) {
      // Commit when the CAPTURED control is released, not when the whole pad
      // is neutral: a trigger axis that rest-shifts after first use (reports
      // 0 until touched, then rests at -1) never reads as neutral again, which
      // silently turned a successful capture into an auto-skip.
      // stick-axis bindings aren't a _wizardBindingPressed kind — test their
      // release as the axis returning near its rest baseline.
      const heldBinding = w.pendingHold.binding;
      const heldReleased = heldBinding.kind === 'stick-axis'
        ? Math.abs((((pad.axes || [])[heldBinding.index] ?? 0)) - ((w.rest.axes || [])[heldBinding.index] || 0)) < NEUTRAL_DELTA
        : !this._wizardBindingPressed(pad, heldBinding);
      if (heldReleased) {
        const binding = w.pendingHold.binding;
        w.pendingHold = null;
        this._setWizardHold(0, false);
        w.results[w.stepIndex] = binding;
        this._flashCaptured(binding);
        // Rebaseline the bound axis at its (possibly shifted) new rest so the
        // following awaitingNeutral gate can actually clear.
        if (binding.kind !== 'button' && typeof binding.index === 'number' && w.rest && w.rest.axes) {
          const cur = (pad.axes || [])[binding.index];
          if (typeof cur === 'number') w.rest.axes[binding.index] = cur;
        }
        w.stepIndex++;
        w.awaitingNeutral = true;
        this._renderWizardStep();
      } else {
        const frac = (performance.now() - w.pendingHold.start) / HOLD_TO_ACT_MS;
        const step = STEPS[w.stepIndex];
        // A long hold IN the prompted stick direction is a capture, not a
        // skip — users naturally hold the stick "to make sure it takes", and
        // auto-skipping here silently killed the stick for every game.
        // Holding some other control (opposite direction, a D-pad axis on a
        // stickless pad) still skips.
        const holdCaptures = step.kind === 'stick-axis' &&
          w.pendingHold.binding.kind === 'stick-axis' && !w.pendingHold.binding.invert;
        if (frac >= 1) {
          const binding = w.pendingHold.binding;
          w.pendingHold = null;
          this._setWizardHold(0, false);
          if (holdCaptures) {
            w.results[w.stepIndex] = binding;
            this._flashCaptured(binding);
            w.stepIndex++;
            w.awaitingNeutral = true;
            this._renderWizardStep();
          } else {
            this._wizardSkip();
          }
        } else {
          this._setWizardHold(frac, true, holdCaptures
            ? 'captured — release or keep holding'
            : 'keep holding to skip · release to capture');
        }
      }
      return;
    }

    if (w.awaitingNeutral) {
      if (!this._padIsNeutral(pad, w.rest)) return;
      w.awaitingNeutral = false;
      // Refresh the resting baseline now that the pad is provably neutral: if
      // the wizard was opened by a pad press (A on "Run Button Wizard"), the
      // first-frame snapshot recorded that held button as "at rest", which
      // would mask the same button from ever being captured.
      w.rest = this._snapshotPad(pad);
    }

    const step = STEPS[w.stepIndex];
    const binding = this._detectBinding(pad, w.rest, step);
    if (binding) {
      if (step.optional) {
        w.pendingHold = { binding, start: performance.now() };
        this._setWizardHold(0, true, 'keep holding to skip · release to capture');
        return;
      }
      w.results[w.stepIndex] = binding;
      this._flashCaptured(binding);
      w.stepIndex++;
      w.awaitingNeutral = true; // require release before the next step arms
      this._renderWizardStep();
    }
  }

  // Summary screen, pad-operable: the wizard just proved which raw controls
  // are FBTN_BOTTOM / FBTN_RIGHT, so those captured bindings become Save /
  // Back. Pads where FBTN_BOTTOM wasn't captured fall back to
  // hold-any-control-to-save.
  _wizardSummaryTick(pad) {
    const w = this._wizard;
    if (!w.rest) { w.rest = this._snapshotPad(pad); w.awaitingNeutral = true; return; }
    if (w.awaitingNeutral) {
      if (!this._padIsNeutral(pad, w.rest)) return;
      w.awaitingNeutral = false;
      w.rest = this._snapshotPad(pad); // clean baseline (see _wizardTick)
      w.sum = { save: false, back: false, holdStart: 0 };
    }
    if (!w.sum) w.sum = { save: false, back: false, holdStart: 0 };

    const saveBinding = this._wizardResultForSlot(0);
    const backBinding = this._wizardResultForSlot(1);

    if (saveBinding) {
      const p = this._wizardBindingPressed(pad, saveBinding);
      if (p && !w.sum.save) { this._wizardSave(); return; }
      w.sum.save = p;
    } else {
      // Fallback: hold anything ~1.5s to save.
      if (!this._padIsNeutral(pad, w.rest)) {
        if (!w.sum.holdStart) w.sum.holdStart = performance.now();
        const frac = (performance.now() - w.sum.holdStart) / HOLD_TO_ACT_MS;
        if (frac >= 1) { this._setWizardHold(0, false); this._wizardSave(); return; }
        this._setWizardHold(frac, true, 'keep holding to save…');
      } else {
        w.sum.holdStart = 0;
        this._setWizardHold(0, false);
      }
    }

    if (backBinding) {
      const p = this._wizardBindingPressed(pad, backBinding);
      if (p && !w.sum.back) { this._wizardBack(); return; }
      w.sum.back = p;
    }
  }

  // Captured binding for a standard button slot, or null if skipped/missing.
  _wizardResultForSlot(slot) {
    const w = this._wizard;
    if (!w) return null;
    for (let i = 0; i < STEPS.length; i++) {
      if (STEPS[i].kind === 'press' && STEPS[i].slot === slot) {
        const r = w.results[i];
        return r && !r.skipped ? r : null;
      }
    }
    return null;
  }

  // Is a captured binding currently pressed on this raw pad? Prefers the
  // compat plugin's canonical implementation; inline fallback matches it.
  _wizardBindingPressed(pad, binding) {
    if (!binding) return false;
    try {
      const compat = window.CMGGamepadCompat;
      if (compat && typeof compat.bindingPressed === 'function') return !!compat.bindingPressed(pad, binding);
    } catch (_) {}
    if (binding.kind === 'button') {
      const b = (pad.buttons || [])[binding.index];
      return !!(b && b.pressed);
    }
    const v = (pad.axes || [])[binding.index];
    if (typeof v !== 'number') return false;
    if (binding.kind === 'hat') return !!this.decodeHat(v)[binding.dir];
    if (binding.kind === 'axis') {
      const base = typeof binding.baseline === 'number' ? binding.baseline : 0;
      return binding.sign >= 0 ? v - base > 0.5 : base - v > 0.5;
    }
    return false;
  }

  // Progress bar for the hold-to-skip / hold-to-save gestures.
  _setWizardHold(frac, show, label) {
    const wrap = document.querySelector('.mapping-wizard #wizard-hold');
    if (!wrap) return;
    wrap.style.display = show ? '' : 'none';
    if (!show) return;
    const fill = wrap.querySelector('.wizard-hold-fill');
    if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    if (label) {
      const lab = wrap.querySelector('.wizard-hold-label');
      if (lab && lab.textContent !== label) lab.textContent = label;
    }
  }

  _detectBinding(pad, baseline, step) {
    const snap = this._snapshotPad(pad);

    if (step.kind === 'press') {
      // Prefer a real button edge; fall back to an axis move (hat D-pads,
      // axis-reported triggers).
      for (let i = 0; i < snap.buttons.length; i++) {
        if (snap.buttons[i] && !baseline.buttons[i]) return { kind: 'button', index: i };
      }
      const compat = window.CMGGamepadCompat;
      for (let i = 0; i < snap.axes.length; i++) {
        const base = baseline.axes[i];
        const v = snap.axes[i];
        // Hat switch: neutral parks outside [-1, 1] (e.g. 1.2857) and pressed
        // values land on the 8-step grid. Decode directions instead of using
        // the raw delta — adjacent hat states (e.g. LEFT at 5/7) can sit
        // closer to neutral than the generic threshold. A hat axis moved in
        // the wrong direction is never a binding, so don't fall through.
        if (compat && Math.abs(base) > 1.05) {
          if (step.dir && Math.abs(v) <= 1.05 && compat.decodeHat(v)[step.dir]) {
            return { kind: 'hat', index: i, dir: step.dir };
          }
          continue;
        }
        if (Math.abs(v - base) < AXIS_CAPTURE_DELTA) continue;
        return { kind: 'axis', index: i, sign: v > base ? 1 : -1, baseline: Math.round(base * 100) / 100 };
      }
      return null;
    }

    if (step.kind === 'stick-axis') {
      for (let i = 0; i < snap.axes.length; i++) {
        const base = baseline.axes[i];
        if (Math.abs(base) > 1.05) continue; // hat neutral sentinel — not a stick
        const v = snap.axes[i];
        const delta = v - base;
        if (Math.abs(delta) < AXIS_CAPTURE_DELTA) continue;
        const sign = delta > 0 ? 1 : -1;
        return { kind: 'stick-axis', index: i, invert: sign !== step.expectSign };
      }
      return null;
    }

    return null;
  }

  _flashCaptured(binding) {
    const el = document.querySelector('#wizard-captured');
    if (!el) return;
    let desc = '';
    if (binding.kind === 'button') desc = `button ${binding.index}`;
    else if (binding.kind === 'hat') desc = `hat axis ${binding.index} (${binding.dir})`;
    else if (binding.kind === 'axis') desc = `axis ${binding.index} (${binding.sign > 0 ? '+' : '-'})`;
    else if (binding.kind === 'stick-axis') desc = `axis ${binding.index}${binding.invert ? ' (inverted)' : ''}`;
    el.textContent = `Captured: ${desc}`;
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
  }

  _wizardSkip() {
    const w = this._wizard;
    if (!w || w.stepIndex >= STEPS.length) return;
    w.pendingHold = null;
    this._setWizardHold(0, false);
    const step = STEPS[w.stepIndex];
    w.results[w.stepIndex] = { skipped: true };
    // Skipping the first step of a stick means "this pad has no such stick":
    // skip the rest of that stick's steps too.
    if (step.stick && step.stickFirst) w.skippedSticks[step.stick] = true;
    do {
      w.stepIndex++;
    } while (
      w.stepIndex < STEPS.length &&
      STEPS[w.stepIndex].stick &&
      w.skippedSticks[STEPS[w.stepIndex].stick] &&
      (w.results[w.stepIndex] = { skipped: true })
    );
    w.awaitingNeutral = true;
    this._renderWizardStep();
  }

  _wizardBack() {
    const w = this._wizard;
    if (!w || w.stepIndex === 0) return;
    w.pendingHold = null;
    w.sum = null;
    this._setWizardHold(0, false);
    w.stepIndex--;
    const step = STEPS[w.stepIndex];
    if (step.stick) delete w.skippedSticks[step.stick];
    delete w.results[w.stepIndex];
    w.awaitingNeutral = true;
    this._renderWizardStep();
  }

  _renderWizardStep() {
    const w = this._wizard;
    if (!w) return;
    const sectionEl = document.querySelector('#wizard-section');
    const promptEl = document.querySelector('#wizard-prompt');
    const hintEl = document.querySelector('#wizard-hint');
    const progressEl = document.querySelector('#wizard-progress');
    const skipBtn = document.querySelector('#wizard-skip-btn');
    const saveBtn = document.querySelector('#wizard-save-btn');
    const backBtn = document.querySelector('#wizard-back-btn');
    if (!promptEl) return;

    backBtn.disabled = w.stepIndex === 0;

    this._setWizardHold(0, false);

    if (w.stepIndex >= STEPS.length) {
      const captured = Object.values(w.results).filter(r => r && !r.skipped).length;
      sectionEl.textContent = 'All done';
      promptEl.textContent = `Mapped ${captured} controls.`;
      // Advertise the pad gestures that are actually available on this pad:
      // the captured FBTN_BOTTOM / FBTN_RIGHT bindings act as Save / Back,
      // with hold-anything as the fallback when FBTN_BOTTOM wasn't captured.
      const saveBinding = this._wizardResultForSlot(0);
      const backBinding = this._wizardResultForSlot(1);
      const gesture = saveBinding
        ? `Pad: BOTTOM face button saves${backBinding ? ' · RIGHT face button goes back' : ''}.`
        : 'Pad: hold any control 1.5s to save.';
      hintEl.textContent = `Save to translate this controller into a standard Xbox-style pad everywhere — launcher and all games. ${gesture}`;
      skipBtn.style.display = 'none';
      saveBtn.style.display = '';
    } else {
      const step = STEPS[w.stepIndex];
      sectionEl.textContent = step.section;
      promptEl.textContent = `Press ${step.label}`;
      hintEl.textContent = step.optional
        ? `${step.hint ? `${step.hint} · ` : ''}Hold any control 1.5s to skip`
        : (step.hint || '');
      skipBtn.style.display = '';
      skipBtn.textContent = step.optional ? 'Skip' : 'Skip (not recommended)';
      saveBtn.style.display = 'none';
    }

    // Progress dots: done / skipped / current / pending.
    progressEl.innerHTML = STEPS.map((s, i) => {
      const r = w.results[i];
      let cls = 'pending';
      if (i === w.stepIndex) cls = 'current';
      else if (r && r.skipped) cls = 'skipped';
      else if (r) cls = 'done';
      return `<span class="wizard-dot ${cls}" title="${s.label}"></span>`;
    }).join('');
  }

  _wizardSave() {
    const w = this._wizard;
    if (!w || !w.targetPadId) { this.closeMappingWizard(); return; }

    const profile = { buttons: {}, axes: {}, savedAt: new Date().toISOString() };
    STEPS.forEach((step, i) => {
      const r = w.results[i];
      if (!r || r.skipped) return;
      if (step.kind === 'press') {
        profile.buttons[step.slot] = r;
      } else if (step.kind === 'stick-axis') {
        profile.axes[step.axisSlot] = { index: r.index, invert: !!r.invert };
      }
    });

    try {
      const all = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || '{}') || {};
      all[w.targetPadId] = profile;
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(all));
    } catch (e) {
      console.warn('[mapping-wizard] unable to persist profile', e);
    }

    // The pad now presents the standard layout, so any per-button keyboard
    // remap saved against its old raw indices would double-translate — reset
    // this pad's keyboard mapping to the standard defaults.
    try {
      this.controllerMappings[w.targetPadId] = JSON.parse(JSON.stringify(this.defaultMapping));
      this.saveMapping(w.targetPadId);
    } catch (_) {}

    // Wake the compat plugin in this document; other same-origin documents
    // (game iframes) hear the storage event.
    try { window.dispatchEvent(new Event('cmg-pad-profiles-updated')); } catch (_) {}

    this.closeMappingWizard();
    // Refresh the configurator (if open) so testing reflects the new profile.
    try { this.onConfigControllerChanged && this.onConfigControllerChanged(); } catch (_) {}
  }
  }

  for (const name of Object.getOwnPropertyNames(WizardMixin.prototype)) {
    if (name !== 'constructor') GamepadManager.prototype[name] = WizardMixin.prototype[name];
  }

  // The wizard-active signal external pollers (e.g. the launcher Dashboard)
  // check to yield pad input while the wizard captures raw presses. Make it a
  // well-defined boolean from load, not undefined-until-first-open.
  if (!('wizardActive' in window.gamepadManager)) window.gamepadManager.wizardActive = false;

  const wizardCSS = `
.mapping-wizard {
  position: fixed;
  inset: 0;
  z-index: 10001;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease;
  font-family: 'Orbitron', sans-serif;
}

.mapping-wizard.visible {
  opacity: 1;
  pointer-events: all;
}

.wizard-overlay {
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.65);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  display: flex;
  justify-content: center;
  align-items: center;
}

.wizard-panel {
  background: linear-gradient(180deg, rgba(12, 40, 20, .96), rgba(6, 22, 11, .98));
  border-radius: 12px;
  box-shadow: 0 0 38px rgba(80, 220, 100, .35), inset 0 0 0 1px rgba(140, 255, 110, .08);
  width: 92vw;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(140, 255, 110, .55);
  color: #dfffc4;
}

.wizard-header {
  padding: 16px 20px;
  border-bottom: 1px solid rgba(140, 255, 110, .18);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.wizard-header h2 {
  color: #eaffd2;
  margin: 0;
  font-weight: 800;
  font-size: 16px;
  letter-spacing: .18em;
  text-transform: uppercase;
  text-shadow: 0 0 14px rgba(120, 255, 90, .5);
}

.mapping-wizard .close-btn {
  background: transparent;
  border: 1px solid rgba(140, 255, 110, .25);
  color: rgba(220, 255, 180, .6);
  font-size: 18px;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  cursor: pointer;
  line-height: 1;
}

.mapping-wizard .close-btn:hover {
  background: rgba(120, 255, 90, .12);
  color: #eaffd2;
}

.wizard-pad-id {
  padding: 8px 20px;
  font-family: 'Share Tech Mono', monospace;
  font-size: 12px;
  color: rgba(180, 255, 140, .6);
  border-bottom: 1px solid rgba(140, 255, 110, .1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wizard-body {
  padding: 26px 20px;
  text-align: center;
  min-height: 190px;
}

.wizard-section {
  font-family: 'Share Tech Mono', monospace;
  font-size: 12px;
  letter-spacing: .22em;
  text-transform: uppercase;
  color: rgba(140, 255, 110, .6);
  margin-bottom: 10px;
}

.wizard-prompt {
  font-size: 22px;
  font-weight: 800;
  color: #eaffd2;
  text-shadow: 0 0 16px rgba(120, 255, 90, .45);
  margin-bottom: 8px;
  animation: wizard-pulse 1.6s ease-in-out infinite;
}

@keyframes wizard-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .55; }
}

.wizard-hint {
  font-family: 'Share Tech Mono', monospace;
  font-size: 12px;
  color: rgba(180, 255, 140, .55);
  min-height: 16px;
  margin-bottom: 14px;
}

.wizard-captured {
  font-family: 'Share Tech Mono', monospace;
  font-size: 13px;
  color: #7CFF4F;
  min-height: 18px;
  margin-bottom: 14px;
}

.wizard-captured.flash {
  animation: wizard-captured-flash 0.8s ease-out;
}

@keyframes wizard-captured-flash {
  0% { text-shadow: 0 0 18px rgba(120, 255, 90, 1); transform: scale(1.15); }
  100% { text-shadow: none; transform: scale(1); }
}

/* hold-to-skip / hold-to-save progress */
.wizard-hold {
  margin: 0 auto 14px;
  max-width: 280px;
}

.wizard-hold-track {
  height: 6px;
  border-radius: 3px;
  background: rgba(140, 255, 110, .15);
  border: 1px solid rgba(140, 255, 110, .3);
  overflow: hidden;
}

.wizard-hold-fill {
  height: 100%;
  width: 0%;
  background: #FFB13D;
  transition: width 0.05s linear;
}

.wizard-hold-label {
  margin-top: 6px;
  font-family: 'Share Tech Mono', monospace;
  font-size: 12px;
  color: rgba(255, 177, 61, .85);
}

.wizard-progress {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
}

.wizard-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgba(140, 255, 110, .15);
  border: 1px solid rgba(140, 255, 110, .3);
}

.wizard-dot.done { background: #7CFF4F; }
.wizard-dot.skipped { background: rgba(255, 177, 61, .55); border-color: rgba(255, 177, 61, .7); }
.wizard-dot.current { background: #F6FF4A; border-color: #fff36a; box-shadow: 0 0 8px rgba(246, 255, 74, .8); }

.wizard-footer {
  padding: 14px 20px;
  border-top: 1px solid rgba(140, 255, 110, .18);
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.wizard-footer-right { display: flex; gap: 10px; }

.wizard-footer button {
  padding: 9px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  font-family: 'Orbitron', sans-serif;
  letter-spacing: .05em;
  font-size: 12px;
  background: transparent;
  border: 1px solid rgba(140, 255, 110, .35);
  color: #dfffc4;
  transition: all 0.15s ease;
}

.wizard-footer button:hover:not(:disabled) {
  background: rgba(120, 255, 90, .12);
  border-color: rgba(140, 255, 110, .6);
}

.wizard-footer button:disabled { opacity: .35; cursor: default; }

#wizard-skip-btn {
  border-color: rgba(255, 177, 61, .5);
  color: #FFB13D;
}

#wizard-skip-btn:hover {
  background: rgba(255, 177, 61, .12);
  border-color: rgba(255, 177, 61, .8);
}

#wizard-save-btn {
  background: linear-gradient(180deg, rgba(160, 255, 110, .95), rgba(90, 220, 60, .9));
  border: 1px solid rgba(180, 255, 140, 1);
  color: #0a1a06;
  text-shadow: 0 1px 0 rgba(255, 255, 255, .25);
  box-shadow: 0 0 20px rgba(120, 255, 90, .35);
}

#wizard-save-btn:hover {
  background: linear-gradient(180deg, rgba(180, 255, 130, 1), rgba(110, 240, 80, .95));
}
`;

  const styleSheet = document.createElement('style');
  styleSheet.textContent = wizardCSS;
  document.head.appendChild(styleSheet);

  window.openButtonMappingWizard = () => window.gamepadManager.openMappingWizard();
})();
