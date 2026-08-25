// Controller Configurator — extracted from gamepad-support.js.
//
// The button-remap UI, live button-testing visuals, and "detect gamepad button"
// feature were moved out of the core GamepadManager so gamepad-support.js can
// stay focused on the live in-game gamepad->keyboard path. This file augments
// GamepadManager.prototype and is opened from the in-game OSD's "Controller
// Settings" via window.openControllerConfigurator().
//
// Loaded as an ES module; importing GamepadManager guarantees gamepad-support.js
// has executed (and created the global window.gamepadManager instance) first.
import { GamepadManager } from './gamepad-support.js';

(function () {
  if (!GamepadManager || !window.gamepadManager) {
    console.warn('[controller-configurator] GamepadManager not initialized; skipping.');
    return;
  }

  // Authored in class syntax for readability, then mixed into the prototype.
  class ConfiguratorMixin {
  // opts.byMouse — the caller reached this panel with a real mouse click, so the
  // cursor must be visible while it is up on a touch device that otherwise
  // hides it (body.no-cursor). This only takes effect while NO gamepad is
  // connected: body.pad-on beats body.cfg-mouse in dashboard.css, so a pad
  // keeps the pointer hidden here however the panel was opened. Either way the
  // pad can drive it directly via handleConfiguratorPadTick (D-pad moves focus,
  // A activates, B closes).
  openControllerConfigurator(opts) {
    document.body.classList.toggle('cfg-mouse', !!(opts && opts.byMouse));
    this.createConfiguratorUI();
  }

  createConfiguratorUI() {
    // Remove existing configurator
    const existingConfig = document.querySelector('.controller-configurator');
    if (existingConfig) {
      existingConfig.remove();
    }
    
    const configurator = document.createElement('div');
    configurator.className = 'controller-configurator';
    configurator.innerHTML = this.getConfiguratorHTML();
    
    document.body.appendChild(configurator);
    
    // Add event listeners
    this.attachConfiguratorListeners(configurator);
    
    // Show with animation
    setTimeout(() => configurator.classList.add('visible'), 50);
  }
  
  getConfiguratorHTML() {
    return `
      <div class="configurator-overlay">
        <div class="configurator-panel">
          <div class="configurator-header">
            <h2>Controller Layout</h2>
            <button class="close-btn" onclick="gamepadManager.closeConfigurator()">&times;</button>
          </div>
          
          <div class="configurator-content">
            <div class="controller-visual">
              <svg viewBox="0 0 400 250" class="controller-svg">
                <!-- Controller outline -->
                <path d="M80 120 Q60 100 40 120 Q20 140 40 160 L80 160 Q100 180 120 180 L280 180 Q300 180 320 160 L360 160 Q380 140 360 120 Q340 100 320 120 L80 120 Z" 
                      fill="#0b2414" stroke="rgba(140,255,110,.35)" stroke-width="2"/>
                
                <!-- D-Pad -->
                <g class="dpad-group" transform="translate(100, 140)">
                  <rect x="-15" y="-5" width="30" height="10" fill="#143a22" class="dpad-horizontal"/>
                  <rect x="-5" y="-15" width="10" height="30" fill="#143a22" class="dpad-vertical"/>
                  <!-- Invisible enlarged touch targets (drawn under the visible shapes) -->
                  <circle cx="0" cy="-12" r="14" fill="transparent" class="config-hit" data-group="dpad" data-button="up"></circle>
                  <circle cx="0" cy="12" r="14" fill="transparent" class="config-hit" data-group="dpad" data-button="down"></circle>
                  <circle cx="-12" cy="0" r="14" fill="transparent" class="config-hit" data-group="dpad" data-button="left"></circle>
                  <circle cx="12" cy="0" r="14" fill="transparent" class="config-hit" data-group="dpad" data-button="right"></circle>
                  <circle cx="0" cy="-12" r="8" fill="#1f5c34" class="config-btn dpad-up" data-group="dpad" data-button="up"></circle>
                  <circle cx="0" cy="12" r="8" fill="#1f5c34" class="config-btn dpad-down" data-group="dpad" data-button="down"></circle>
                  <circle cx="-12" cy="0" r="8" fill="#1f5c34" class="config-btn dpad-left" data-group="dpad" data-button="left"></circle>
                  <circle cx="12" cy="0" r="8" fill="#1f5c34" class="config-btn dpad-right" data-group="dpad" data-button="right"></circle>
                </g>
                
                <!-- Face buttons -->
                <g class="face-buttons-group" transform="translate(300, 140)">
                  <!-- Invisible enlarged touch targets (drawn under the visible shapes) -->
                  <circle cx="0" cy="-20" r="17" fill="transparent" class="config-hit" data-group="face" data-button="btnTop"></circle>
                  <circle cx="0" cy="20" r="17" fill="transparent" class="config-hit" data-group="face" data-button="btnBottom"></circle>
                  <circle cx="-20" cy="0" r="17" fill="transparent" class="config-hit" data-group="face" data-button="btnLeft"></circle>
                  <circle cx="20" cy="0" r="17" fill="transparent" class="config-hit" data-group="face" data-button="btnRight"></circle>
                  <circle cx="0" cy="-20" r="12" fill="#1f5c34" class="config-btn face-north" data-group="face" data-button="btnTop"></circle>
                  <circle cx="0" cy="20" r="12" fill="#1f5c34" class="config-btn face-south" data-group="face" data-button="btnBottom"></circle>
                  <circle cx="-20" cy="0" r="12" fill="#1f5c34" class="config-btn face-west" data-group="face" data-button="btnLeft"></circle>
                  <circle cx="20" cy="0" r="12" fill="#1f5c34" class="config-btn face-east" data-group="face" data-button="btnRight"></circle>
                  <!-- Button labels -->
                  <text x="0" y="-16" text-anchor="middle" fill="#dfffc4" font-size="10">Y</text>
                  <text x="0" y="24" text-anchor="middle" fill="#dfffc4" font-size="10">A</text>
                  <text x="-20" y="4" text-anchor="middle" fill="#dfffc4" font-size="10">X</text>
                  <text x="20" y="4" text-anchor="middle" fill="#dfffc4" font-size="10">B</text>
                </g>
                
                <!-- Shoulder buttons -->
                <g class="shoulder-buttons">
                  <rect x="60" y="80" width="40" height="15" rx="7" fill="#1f5c34" class="config-btn shoulder-left" data-group="shoulder" data-button="leftShoulder"></rect>
                  <rect x="300" y="80" width="40" height="15" rx="7" fill="#1f5c34" class="config-btn shoulder-right" data-group="shoulder" data-button="rightShoulder"></rect>
                  <rect x="60" y="60" width="40" height="15" rx="7" fill="#143a22" class="config-btn trigger-left" data-group="shoulder" data-button="leftTrigger"></rect>
                  <rect x="300" y="60" width="40" height="15" rx="7" fill="#143a22" class="config-btn trigger-right" data-group="shoulder" data-button="rightTrigger"></rect>
                  <text x="80" y="91" text-anchor="middle" fill="#dfffc4" font-size="8">LB</text>
                  <text x="320" y="91" text-anchor="middle" fill="#dfffc4" font-size="8">RB</text>
                  <text x="80" y="71" text-anchor="middle" fill="#dfffc4" font-size="8">LT</text>
                  <text x="320" y="71" text-anchor="middle" fill="#dfffc4" font-size="8">RT</text>
                </g>
                
                <!-- Special buttons -->
                <g class="special-buttons">
                  <!-- Invisible enlarged touch targets (drawn under the visible shapes) -->
                  <rect x="152" y="112" width="36" height="26" rx="6" fill="transparent" class="config-hit" data-group="special" data-button="select"></rect>
                  <rect x="212" y="112" width="36" height="26" rx="6" fill="transparent" class="config-hit" data-group="special" data-button="start"></rect>
                  <rect x="160" y="120" width="20" height="10" rx="5" fill="#1f5c34" class="config-btn special-select" data-group="special" data-button="select"></rect>
                  <rect x="220" y="120" width="20" height="10" rx="5" fill="#1f5c34" class="config-btn special-start" data-group="special" data-button="start"></rect>
                  <text x="170" y="127" text-anchor="middle" fill="#dfffc4" font-size="7">SEL</text>
                  <text x="230" y="127" text-anchor="middle" fill="#dfffc4" font-size="7">STR</text>
                </g>
                
                <!-- Analog sticks -->
                <circle cx="140" cy="180" r="18" fill="#143a22" stroke="rgba(140,255,110,.3)" stroke-width="2" class="stick-left-base"></circle>
                <circle cx="260" cy="180" r="18" fill="#143a22" stroke="rgba(140,255,110,.3)" stroke-width="2" class="stick-right-base"></circle>
                <!-- Invisible enlarged touch targets (drawn under the visible thumbs) -->
                <circle cx="140" cy="180" r="16" fill="transparent" class="config-hit" data-group="special" data-button="leftStick"></circle>
                <circle cx="260" cy="180" r="16" fill="transparent" class="config-hit" data-group="special" data-button="rightStick"></circle>
                <circle cx="140" cy="180" r="8" fill="#1f5c34" class="config-btn stick-left" data-group="special" data-button="leftStick"></circle>
                <circle cx="260" cy="180" r="8" fill="#1f5c34" class="config-btn stick-right" data-group="special" data-button="rightStick"></circle>
              </svg>
            </div>
            
            <div class="configurator-sidebar">
              <div class="controller-select-section">
                <div class="form-group">
                  <label for="config-controller-select"><b>Configure Controller</b></label>
                  <select id="config-controller-select">
                    <!-- Options populated dynamically -->
                  </select>
                </div>
              </div>

              <div class="mapping-info">
            <h3>Button Mapping</h3>
                <div class="current-mapping" id="current-mapping-display">
                  <p>Click a button to configure it</p>
                </div>
                <div class="form-group">
                  <button type="button" id="open-wizard-btn">Run Button Wizard</button>
                  <p class="testing-hint">Walks you through pressing every control and translates this pad into a standard Xbox-style layout everywhere.</p>
                </div>
              </div>

              <div class="layout-section" id="layout-section">
                <h3>Controller Layout</h3>
                <div class="form-group inline">
                  <label for="wasd-toggle">Use WASD for D-pad:</label>
                  <label class="switch">
                    <input type="checkbox" id="wasd-toggle" />
                    <span class="slider"></span>
                  </label>
                </div>
              </div>

              <div class="start-section" id="start-section">
                <h3>Start Button</h3>
                <div class="form-group inline">
                  <label for="start-touch-toggle">Simulate click on Start:</label>
                  <label class="switch">
                    <input type="checkbox" id="start-touch-toggle" />
                    <span class="slider"></span>
                  </label>
                </div>
                <div class="form-group">
                  <label for="touch-target-input">Click target selector (optional):</label>
                  <input type="text" id="touch-target-input" placeholder="#startButton or any CSS selector" />
                </div>
                <div class="form-group">
                  <label for="scene-name-input">Phaser scene to start (optional):</label>
                  <input type="text" id="scene-name-input" placeholder="game-scene" />
                  <p class="testing-hint">If available, calls window.gameScene.scene.start(name) or globalThis.__PHASER_GAME__.scene.scenes[0].scene.start(name) on Start.</p>
                </div>
              </div>
              
              <div class="mapping-form" id="mapping-form" style="display: none;">
                <h4>Configure <span id="config-button-name"></span></h4>
                <div class="form-group">
                  <label>Keyboard Key:</label>
                  <input type="text" id="keyboard-key-input" placeholder="Press a key..." readonly>
                  <button type="button" id="detect-key-btn">Detect Key</button>
                </div>
                <div class="form-group">
                  <label>Gamepad Button:</label>
                  <select id="gamepad-button-select">
                    <option value="0">Button 0 (A/Cross)</option>
                    <option value="1">Button 1 (B/Circle)</option>
                    <option value="2">Button 2 (X/Square)</option>
                    <option value="3">Button 3 (Y/Triangle)</option>
                    <option value="4">Left Shoulder</option>
                    <option value="5">Right Shoulder</option>
                    <option value="6">Left Trigger</option>
                    <option value="7">Right Trigger</option>
                    <option value="8">Select</option>
                    <option value="9">Start</option>
                    <option value="10">Left Stick</option>
                    <option value="11">Right Stick</option>
                    <option value="12">D-Pad Up</option>
                    <option value="13">D-Pad Down</option>
                    <option value="14">D-Pad Left</option>
                    <option value="15">D-Pad Right</option>
                    <option value="16">Home</option>
                  </select>
                  <button type="button" id="detect-gamepad-btn">Detect Gamepad Button</button>
                  <div id="detect-gp-hint" style="margin-top:6px;color:rgba(180,255,140,.7);font-size:12px;display:none;">Press any gamepad button...</div>
                </div>
                <div class="form-actions">
                  <button type="button" id="save-mapping-btn">Save</button>
                  <button type="button" id="reset-mapping-btn">Reset to Default</button>
                </div>
              </div>

              <div class="testing-section" id="testing-section">
                <h3>Button Testing</h3>
                <div class="form-group inline">
                  <label for="btn-testing-toggle">Live Testing:</label>
                  <label class="switch">
                    <input type="checkbox" id="btn-testing-toggle" />
                    <span class="slider"></span>
                  </label>
                </div>
                <p class="testing-hint">When enabled, pressed controls light up on the diagram. The controller selected above will be used for testing. While testing, hold the RIGHT face button (B) for 1.5s to turn testing off with the pad.</p>
                <div class="raw-readout" id="raw-input-readout" aria-live="polite">
                  <div class="raw-readout-empty">Turn on Live Testing, then press any control to see the raw button/axis it reports.</div>
                </div>
              </div>
            </div>
          </div>
          
          <div class="configurator-footer">
            <button class="reset-all-btn" onclick="gamepadManager.resetAllMappings()">Reset All</button>
            <button class="save-close-btn" onclick="gamepadManager.saveAndClose()">Save & Close</button>
          </div>

          <div class="cfg-toast" role="status" aria-live="polite"></div>
        </div>
      </div>
    `;
  }
  
  attachConfiguratorListeners(configurator) {
    // Button configuration listeners. The invisible .config-hit shapes enlarge
    // tiny touch targets; they delegate to the visible .config-btn so the
    // selected highlight always lands on the shape the player can see.
    const configButtons = configurator.querySelectorAll('.config-btn, .config-hit');
    configButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const t = e.currentTarget;
        const group = t.dataset.group;
        const button = t.dataset.button;
        const visual = configurator.querySelector(`.config-btn[data-group="${group}"][data-button="${button}"]`) || t;
        this.selectButtonForConfig(group, button, visual);
      });
    });

    // Button Mapping Wizard (controller-mapping-wizard.js)
    const wizardBtn = configurator.querySelector('#open-wizard-btn');
    wizardBtn?.addEventListener('click', () => {
      if (this.openMappingWizard) this.openMappingWizard();
      else this.showConfiguratorNotice('Mapping wizard failed to load.');
    });

    // Key detection
    const detectKeyBtn = configurator.querySelector('#detect-key-btn');
    const keyInput = configurator.querySelector('#keyboard-key-input');
    
    detectKeyBtn.addEventListener('click', () => {
      this.startKeyDetection(keyInput);
    });
    
    // Save mapping
    const saveMappingBtn = configurator.querySelector('#save-mapping-btn');
    saveMappingBtn.addEventListener('click', () => {
      this.saveCurrentMapping();
    });
    
    // Reset single mapping
    const resetMappingBtn = configurator.querySelector('#reset-mapping-btn');
    resetMappingBtn.addEventListener('click', () => {
      this.resetCurrentMapping();
    });

    // Detect Gamepad Button
    const detectGpBtn = configurator.querySelector('#detect-gamepad-btn');
    const detectHint = configurator.querySelector('#detect-gp-hint');
    const gpSelect = configurator.querySelector('#gamepad-button-select');
    detectGpBtn?.addEventListener('click', () => {
      if (!this.configSelection) return;
      this.startGamepadButtonDetection({ selectEl: gpSelect, buttonEl: detectGpBtn, hintEl: detectHint });
    });

    // When selecting a gamepad button from dropdown, display its default keyboard key
    gpSelect?.addEventListener('change', (e) => {
      const idx = parseInt(gpSelect.value, 10);
      const defKey = this.getDefaultKeyForGamepadIndex(idx) || '';
      if (defKey) {
        keyInput.value = defKey;
      }
    });

    // Button Testing toggle
    const testingToggle = configurator.querySelector('#btn-testing-toggle');
    if (testingToggle) {
      testingToggle.checked = !!this.testingMode;
      testingToggle.addEventListener('change', () => {
        this.setTestingMode(!!testingToggle.checked);
      });
    }

    // WASD layout toggle
    const wasdToggle = configurator.querySelector('#wasd-toggle');
    if (wasdToggle) {
      wasdToggle.addEventListener('change', () => {
        const controllerId = document.querySelector('#config-controller-select')?.value;
        if (controllerId && controllerId !== 'all') {
          this.setUseWASDForDpad(controllerId, !!wasdToggle.checked);
        }
      });
    }

    // Start button preferences
    const startTouchToggle = configurator.querySelector('#start-touch-toggle');
    const touchTargetInput = configurator.querySelector('#touch-target-input');
    const sceneNameInput = configurator.querySelector('#scene-name-input');
    if (startTouchToggle) {
      startTouchToggle.checked = !!this.simulateTouchOnStart;
      startTouchToggle.addEventListener('change', () => {
        this.setSimulateTouchOnStart(!!startTouchToggle.checked);
      });
    }
    if (touchTargetInput) {
      touchTargetInput.value = this.touchTargetSelector || '';
      touchTargetInput.addEventListener('change', () => {
        this.setTouchTargetSelector(String(touchTargetInput.value || '').trim());
      });
    }
    if (sceneNameInput) {
      sceneNameInput.value = this.startSceneName || '';
      sceneNameInput.addEventListener('change', () => {
        this.setStartSceneName(String(sceneNameInput.value || '').trim());
      });
    }

    // Populate and manage the main controller selection dropdown
    this.updateConfigControllerDropdown();
    const configControllerSelect = configurator.querySelector('#config-controller-select');
    if (configControllerSelect) {
      configControllerSelect.addEventListener('change', () => {
        this.onConfigControllerChanged();
      });
    }
    // Set initial state based on the first available controller
    this.onConfigControllerChanged();
  }

  onConfigControllerChanged() {
    const select = document.querySelector('#config-controller-select');
    if (!select) return;

    const selectedValue = select.value;
    const isAll = selectedValue === 'all';

    // Update the testing controller
    this.testingController = isAll ? 'all' : selectedValue;

    // Toggle visibility of config sections
    const configSections = document.querySelectorAll('.layout-section, .start-section, .mapping-form, .mapping-info .current-mapping');
    configSections.forEach(el => {
      el.style.display = isAll ? 'none' : '';
    });

    // If "All" is selected, show a message.
    const mappingDisplay = document.querySelector('#current-mapping-display');
    if (isAll) {
      mappingDisplay.style.display = 'block';
      mappingDisplay.innerHTML = '<p>Select a specific controller to configure it.</p>';
    } else {
      mappingDisplay.innerHTML = '<p>Click a button on the diagram to configure it.</p>';
      this.populateConfiguratorForController(selectedValue);
    }

    // Refresh testing visuals
    try { this.updateTestingVisual(); } catch (_) {}
  }

  populateConfiguratorForController(controllerId) {
    if (!controllerId || controllerId === 'all') return;

    const mapping = this.controllerMappings[controllerId];
    const useWASD = this.controllerUseWASD[controllerId];
    if (mapping === undefined || useWASD === undefined) {
        console.warn(`No settings found for controller ${controllerId}. Using defaults.`);
        this.controllerMappings[controllerId] = JSON.parse(JSON.stringify(this.defaultMapping));
        this.controllerUseWASD[controllerId] = false;
    }

    // Update WASD toggle
    const wasdToggle = document.querySelector('#wasd-toggle');
    if (wasdToggle) wasdToggle.checked = !!useWASD;

    // Update Start button preferences
    const startTouchToggle = document.querySelector('#start-touch-toggle');
    const touchTargetInput = document.querySelector('#touch-target-input');
    const sceneNameInput = document.querySelector('#scene-name-input');
    if (startTouchToggle) startTouchToggle.checked = !!this.simulateTouchOnStart;
    if (touchTargetInput) touchTargetInput.value = this.touchTargetSelector || '';
    if (sceneNameInput) sceneNameInput.value = this.startSceneName || '';

    // Clear any active button config display
    this.deselectButtonForConfig();
  }

  deselectButtonForConfig() {
    const allButtons = document.querySelectorAll('.config-btn.selected');
    allButtons.forEach(btn => btn.classList.remove('selected'));
    document.querySelector('#mapping-form').style.display = 'none';
    document.querySelector('#current-mapping-display').style.display = 'block';
    this.configSelection = null;
    // The mapping form (and its key input) just went away — stop any pending
    // key detection so its document listener doesn't dangle.
    try { this.cancelKeyDetection(); } catch (_) {}
  }
  
  selectButtonForConfig(group, button, element) {
    const controllerId = document.querySelector('#config-controller-select')?.value;
    if (!controllerId || controllerId === 'all') {
      this.showConfiguratorNotice('Select a specific controller before configuring buttons.');
      return;
    }

    // Highlight selected button
    const allButtons = document.querySelectorAll('.config-btn');
    allButtons.forEach(btn => btn.classList.remove('selected'));
    element.classList.add('selected');
    
    // Show mapping form
    const mappingForm = document.querySelector('#mapping-form');
    const mappingDisplay = document.querySelector('#current-mapping-display');
    const buttonNameSpan = document.querySelector('#config-button-name');
    
    mappingDisplay.style.display = 'none';
    mappingForm.style.display = 'block';
    buttonNameSpan.textContent = `${group.toUpperCase()} ${button.toUpperCase()}`;
    
    // Populate current values
    let mapping = this.controllerMappings[controllerId];
    if (!mapping) {
      mapping = this.controllerMappings[controllerId] = JSON.parse(JSON.stringify(this.defaultMapping));
    }

    if (!mapping[group]) {
      mapping[group] = JSON.parse(JSON.stringify(this.defaultMapping[group] || {}));
    }

    if (!mapping[group][button] && this.defaultMapping[group]?.[button]) {
      mapping[group][button] = { ...this.defaultMapping[group][button] };
    }

    const currentMapping = mapping[group]?.[button];
    if (!currentMapping) {
      console.warn(`No mapping found for ${group}.${button}; using defaults.`);
      return;
    }

    document.querySelector('#keyboard-key-input').value = currentMapping.keyboardKey;
    document.querySelector('#gamepad-button-select').value = currentMapping.gamepadButton;
    
    // Store current selection
    this.configSelection = { group, button };
  }
  
  startKeyDetection(input) {
    this.cancelKeyDetection();
    const prev = input.value;
    input.value = 'Press any key...';
    input.focus();

    const handler = (e) => {
      e.preventDefault();
      input.value = e.key === 'Escape' ? prev : e.key;
      this.cancelKeyDetection();
    };

    this._keyDetect = { handler, input, prev };
    document.addEventListener('keydown', handler, true);
  }

  // Remove the key-detection listener wherever the flow ends — key pressed,
  // Escape, deselect, or panel close — so it can never leak and swallow a
  // later keypress after the panel is gone.
  cancelKeyDetection() {
    const kd = this._keyDetect;
    if (!kd) return;
    this._keyDetect = null;
    document.removeEventListener('keydown', kd.handler, true);
    // Detection ended without a key (close/deselect): restore the old value.
    if (kd.input && kd.input.value === 'Press any key...') kd.input.value = kd.prev;
  }

  // Small inline toast — replaces blocking alert()s, which stall the rAF pad
  // poll and are unusable from a gamepad or a touch-only device.
  showConfiguratorNotice(message) {
    const el = document.querySelector('.controller-configurator .cfg-toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(this._cfgToastTimer);
    this._cfgToastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }
  
  saveCurrentMapping() {
    if (!this.configSelection) return;
    const controllerId = document.querySelector('#config-controller-select')?.value;
    if (!controllerId || controllerId === 'all') return;
    
    const { group, button } = this.configSelection;
    const keyboardKey = document.querySelector('#keyboard-key-input').value;
    const gamepadButton = parseInt(document.querySelector('#gamepad-button-select').value);
    
    // Update mapping in memory
    const mapping = this.controllerMappings[controllerId];
    if (mapping) {
      mapping[group][button].keyboardKey = keyboardKey;
      mapping[group][button].keyCode = this.getKeyCode(keyboardKey);
      mapping[group][button].gamepadButton = gamepadButton;
    }
    
    // Save to localStorage
    this.saveMapping(controllerId);

    this.showConfiguratorNotice('Mapping saved.');
  }
  
  resetCurrentMapping() {
    if (!this.configSelection) return;
    const controllerId = document.querySelector('#config-controller-select')?.value;
    if (!controllerId || controllerId === 'all') return;
    
    const { group, button } = this.configSelection;
    const defaultMapping = this.defaultMapping[group][button];
    
    // Reset to default in memory
    const mapping = this.controllerMappings[controllerId];
    if (mapping) {
        mapping[group][button] = { ...defaultMapping };
    }
    
    // Update UI
    document.querySelector('#keyboard-key-input').value = defaultMapping.keyboardKey;
    document.querySelector('#gamepad-button-select').value = defaultMapping.gamepadButton;
    
    this.saveMapping(controllerId);
  }
  
  resetAllMappings() {
    // Press-again-to-confirm: a blocking confirm() stalls the rAF pad poll and
    // can't be answered from a gamepad. First activation arms the button;
    // pressing it again within 3s performs the reset.
    if (!this._resetAllArmed) {
      this._resetAllArmed = true;
      const btn = document.querySelector('.controller-configurator .reset-all-btn');
      if (btn) {
        btn.classList.add('confirming');
        btn.textContent = 'Press again to confirm';
      }
      clearTimeout(this._resetAllArmTimer);
      this._resetAllArmTimer = setTimeout(() => this.disarmResetAllConfirm(), 3000);
      return;
    }
    this.disarmResetAllConfirm();

    // Clear from memory
    this.controllerMappings = {};
    this.controllerUseWASD = {};

    // Re-initialize for currently connected controllers
    for (const idx in this.controllers) {
      const controller = this.controllers[idx];
      if (controller && controller.id) {
        const controllerId = this.getControllerId(controller);
        this.controllerMappings[controllerId] = JSON.parse(JSON.stringify(this.defaultMapping));
        this.controllerUseWASD[controllerId] = false; // Default WASD to off
      }
    }

    // Clear from localStorage
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('gamepadMapping_') || key.startsWith('gamepadUseWASD_'))) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        localStorage.removeItem(key);
      }
    } catch(e) {
      console.error("Error clearing all gamepad settings from localStorage", e);
    }

    this.closeConfigurator();
  }

  disarmResetAllConfirm() {
    this._resetAllArmed = false;
    clearTimeout(this._resetAllArmTimer);
    this._resetAllArmTimer = null;
    const btn = document.querySelector('.controller-configurator .reset-all-btn');
    if (btn) {
      btn.classList.remove('confirming');
      btn.textContent = 'Reset All';
    }
  }
  
  saveAndClose() {
    const controllerId = document.querySelector('#config-controller-select')?.value;
    if (controllerId && controllerId !== 'all') {
      // This is a bit of a simplification. It assumes any changes in the form have been
      // latched into memory, which they are by the various event handlers.
      // A more robust solution might re-read all form values here.
      this.saveMapping(controllerId);
    }
    this.closeConfigurator();
  }
  
  closeConfigurator() {
    // Hand the cursor back to the no-cursor policy — every close path (✕,
    // Save & Close, Reset All) funnels through here.
    document.body.classList.remove('cfg-mouse');
    const configurator = document.querySelector('.controller-configurator');
    if (configurator) {
      configurator.classList.remove('visible');
      setTimeout(() => configurator.remove(), 300);
    }
    // Stop detect mode if active
    try { this.cancelGamepadButtonDetection(); } catch (_) {}
    // Stop key detection — its document listener must not outlive the panel
    try { this.cancelKeyDetection(); } catch (_) {}
    // Turn off testing visuals
    try { this.setTestingMode(false); } catch (_) {}
    // Disarm the Reset All confirmation and drop pad-nav state
    try { this.disarmResetAllConfirm(); } catch (_) {}
    this._cfgNav = null;
  }
  
  // ===== Button Testing (visualize pressed controls) =====
  setTestingMode(enabled) {
    this.testingMode = !!enabled;
    const root = document.querySelector('.controller-configurator');
    if (root) root.classList.toggle('testing-active', this.testingMode);
    if (!this.testingMode) this.clearTestingVisual();
  }

  updateConfigControllerDropdown() {
    const select = document.querySelector('.controller-configurator #config-controller-select');
    if (!select) return;

    const connectedControllers = Object.values(this.controllers);
    const prev = select.value;

    // Clear options
    while (select.firstChild) select.removeChild(select.firstChild);

    const addOpt = (value, label) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    };

    // Add an option for each connected controller
    for (const controller of connectedControllers) {
      if (controller && controller.id) {
        addOpt(this.getControllerId(controller), controller.id);
      }
    }

    // Add the "All" option for testing
    addOpt('all', 'All Connected (for testing)');

    // Restore previous selection if still present
    const values = Array.from(select.options).map(o => o.value);
    if (values.includes(prev)) {
      select.value = prev;
    } else if (connectedControllers.length > 0) {
      select.value = this.getControllerId(connectedControllers[0]);
    } else {
      select.value = 'all';
    }

    // Trigger a change event to update the UI state
    this.onConfigControllerChanged();
  }

  refreshTestingControllerOptionsIfOpen() {
    if (this.isConfiguratorOpen && this.isConfiguratorOpen()) {
      this.updateConfigControllerDropdown();
    }
  }

  clearTestingVisual() {
    try {
      const els = document.querySelectorAll('.controller-configurator .controller-svg .config-btn');
      els.forEach(el => el.classList.remove('testing-pressed'));
      // Reset stick thumb positions to center
      const root = document.querySelector('.controller-configurator');
      const resetThumb = (sel) => {
        const el = root && root.querySelector(sel);
        if (!el) return;
        const cx0 = el.dataset.cx0;
        const cy0 = el.dataset.cy0;
        if (cx0 && cy0) {
          el.setAttribute('cx', cx0);
          el.setAttribute('cy', cy0);
        }
        // Clear any transform that might have been applied elsewhere
        el.removeAttribute('transform');
      };
      resetThumb('.stick-left');
      resetThumb('.stick-right');
      const readout = document.querySelector('.controller-configurator #raw-input-readout');
      if (readout) readout.innerHTML = '<div class="raw-readout-empty">Turn on Live Testing, then press any control to see the raw button/axis it reports.</div>';
    } catch (_) {}
  }

  updateTestingVisual() {
    const root = document.querySelector('.controller-configurator');
    if (!root) return;
    const pressed = this.getAggregatedPressedState();

    const map = [
      { sel: '.dpad-up', key: 'up' },
      { sel: '.dpad-down', key: 'down' },
      { sel: '.dpad-left', key: 'left' },
      { sel: '.dpad-right', key: 'right' },
      { sel: '.face-north', key: 'btnTop' },
      { sel: '.face-south', key: 'btnBottom' },
      { sel: '.face-west', key: 'btnLeft' },
      { sel: '.face-east', key: 'btnRight' },
      { sel: '.shoulder-left', key: 'leftShoulder' },
      { sel: '.shoulder-right', key: 'rightShoulder' },
      { sel: '.trigger-left', key: 'leftTrigger' },
      { sel: '.trigger-right', key: 'rightTrigger' },
      { sel: '.special-select', key: 'select' },
      { sel: '.special-start', key: 'start' },
      { sel: '.stick-left', key: 'leftStick' },
      { sel: '.stick-right', key: 'rightStick' },
    ];

    for (const m of map) {
      const el = root.querySelector(m.sel);
      if (!el) continue;
      if (pressed[m.key]) el.classList.add('testing-pressed');
      else el.classList.remove('testing-pressed');
    }

    // Handle stick base highlighting for movement
    const checkStickNav = (stickName) => {
      let moved = false;
      for (const idx in this.controllers) {
        const state = this.buttonState[idx] && this.buttonState[idx][stickName];
        if (state && state.nav && (state.nav.left || state.nav.right || state.nav.up || state.nav.down)) {
          moved = true;
          break;
        }
      }
      const baseEl = root.querySelector(`.stick-${stickName.replace('Stick', '').toLowerCase()}-base`);
      if (baseEl) {
        baseEl.classList.toggle('testing-pressed', moved);
      }
    };
    checkStickNav('leftStick');
    checkStickNav('rightStick');

    // Show analog stick thumb offsets
    try {
      const analog = this.getAggregatedAnalogState();
      const applyThumb = (sel, stick) => {
        const el = root.querySelector(sel);
        if (!el) return;
        // Cache original center on first run
        if (!el.dataset.cx0 || !el.dataset.cy0) {
          el.dataset.cx0 = el.getAttribute('cx') || '0';
          el.dataset.cy0 = el.getAttribute('cy') || '0';
        }
        const cx0 = parseFloat(el.dataset.cx0);
        const cy0 = parseFloat(el.dataset.cy0);
        // Max offset within ring (ring r=18, thumb r=8) with small margin
        const maxOffset = 10; // px
        const dx = Math.max(-1, Math.min(1, stick.x || 0)) * maxOffset;
        const dy = Math.max(-1, Math.min(1, stick.y || 0)) * maxOffset;
        // Clamp to circle radius to avoid leaving ring visually
        const len = Math.hypot(dx, dy);
        const limit = maxOffset;
        const scale = len > limit && len > 0 ? limit / len : 1;
        const nx = cx0 + dx * scale;
        const ny = cy0 + dy * scale;
        el.setAttribute('cx', String(nx));
        el.setAttribute('cy', String(ny));
      };
      applyThumb('.stick-left', analog.leftStick);
      applyThumb('.stick-right', analog.rightStick);
    } catch (_) {}

    // Live raw-input readout: shows exactly which button indices / axes the
    // selected pad reports, so non-standard controllers are self-documenting.
    try { this.updateRawReadout(); } catch (_) {}
  }

  // Render a compact live dump of the raw gamepad state for the controller(s)
  // currently selected for testing. Reads navigator's fresh snapshot via
  // this.controllers (refreshed each poll), not the mapped buttonState.
  getRawDiag() {
    const targetId = this.testingController;
    const indices = Object.keys(this.controllers).filter(idx => {
      if (targetId === 'all') return true;
      const c = this.controllers[idx];
      return c && this.getControllerId(c) === targetId;
    });
    const out = [];
    for (const idx of indices) {
      const c = this.controllers[idx];
      if (!c) continue;
      const buttons = [];
      (c.buttons || []).forEach((btn, i) => { if (btn && btn.pressed) buttons.push(i); });
      const axes = [];
      (c.axes || []).forEach((v, i) => {
        if (typeof v !== 'number') return;
        if (Math.abs(v) > 1.05) return;      // neutral sentinel (e.g. hat at rest)
        if (Math.abs(v) > 0.18) axes.push(`a${i}:${v.toFixed(2)}`);
      });
      let dpad = '';
      try {
        const mapping = this.controllerMappings[this.getControllerId(c)];
        const d = this.readDpad(c, mapping);
        dpad = ['up', 'down', 'left', 'right'].filter(k => d[k]).join(' ');
      } catch (_) {}
      out.push({
        id: c.id,
        mapping: c.mapping || 'non-standard',
        buttons, axes, dpad,
        numButtons: (c.buttons || []).length,
        numAxes: (c.axes || []).length,
      });
    }
    return out;
  }

  updateRawReadout() {
    const el = document.querySelector('.controller-configurator #raw-input-readout');
    if (!el) return;
    const diag = this.getRawDiag();
    if (!diag.length) {
      el.innerHTML = '<div class="raw-readout-empty">No controller selected for testing.</div>';
      return;
    }
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    el.innerHTML = diag.map((d) => `
      <div class="raw-readout-pad">
        <div class="raw-readout-id">${esc(d.id)}</div>
        <div class="raw-readout-line"><span>map</span> ${esc(d.mapping)} · ${d.numButtons} btn · ${d.numAxes} axes</div>
        <div class="raw-readout-line"><span>btn</span> ${d.buttons.length ? d.buttons.map((i) => `b${i}`).join(' ') : '—'}</div>
        <div class="raw-readout-line"><span>axes</span> ${d.axes.length ? d.axes.join('  ') : '—'}</div>
        <div class="raw-readout-line"><span>d-pad</span> ${d.dpad || '—'}</div>
      </div>
    `).join('');
  }

  getAggregatedPressedState() {
    const init = () => false;
    const names = {
      up: init(), down: init(), left: init(), right: init(),
      btnTop: init(), btnBottom: init(), btnLeft: init(), btnRight: init(),
      leftShoulder: init(), rightShoulder: init(), leftTrigger: init(), rightTrigger: init(),
      select: init(), start: init(), leftStick: init(), rightStick: init(),
    };

    const targetId = this.testingController; // This is now a controller ID string or 'all'
    const indices = Object.keys(this.controllers).filter(idx => {
        if (targetId === 'all') return true;
        const controller = this.controllers[idx];
        return controller && this.getControllerId(controller) === targetId;
    });

    for (let idx of indices) {
      const bs = this.buttonState[idx] || {};
      for (let k in names) {
        if (Object.prototype.hasOwnProperty.call(bs, k)) {
          const state = bs[k];
          if (typeof state === 'object' && state !== null && 'pressed' in state) {
            names[k] = !!(names[k] || state.pressed);
          } else {
            names[k] = !!(names[k] || state);
          }
        }
      }
    }
    return names;
  }

  // Aggregate analog stick positions across the selected testing controller(s)
  // Returns normalized values in range [-1, 1]
  getAggregatedAnalogState() {
    const targetId = this.testingController; // This is now a controller ID string or 'all'
    const indices = Object.keys(this.controllers).filter(idx => {
        if (targetId === 'all') return true;
        const controller = this.controllers[idx];
        return controller && this.getControllerId(controller) === targetId;
    });

    let count = 0;
    let lx = 0, ly = 0, rx = 0, ry = 0;
    for (let idx of indices) {
      const a = this.analogState[idx];
      if (!a) continue;
      lx += a.leftStick?.x || 0;
      ly += a.leftStick?.y || 0;
      rx += a.rightStick?.x || 0;
      ry += a.rightStick?.y || 0;
      count++;
    }
    if (count === 0) return { leftStick: { x: 0, y: 0 }, rightStick: { x: 0, y: 0 } };
    return {
      leftStick: { x: lx / count, y: ly / count },
      rightStick: { x: rx / count, y: ry / count },
    };
  }
  }
  for (const name of Object.getOwnPropertyNames(ConfiguratorMixin.prototype)) {
    if (name !== 'constructor') GamepadManager.prototype[name] = ConfiguratorMixin.prototype[name];
  }

// ===== Detect Gamepad Button feature =====
GamepadManager.prototype.startGamepadButtonDetection = function(uiRefs) {
  this.cancelGamepadButtonDetection();
  // Snapshot current button AND axis state so we only pick up new input —
  // detection accepts real buttons, digital D-pad axes, and encoded hats.
  this._detectSnapshot = {};
  for (let idx in this.controllers) {
    try {
      const gp = this.controllers[idx];
      this._detectSnapshot[idx] = {
        buttons: Array.from(gp.buttons || []).map(b => !!(b && b.pressed)),
        axes: Array.from(gp.axes || []).map(v => (typeof v === 'number' ? v : 0)),
      };
    } catch (_) { this._detectSnapshot[idx] = { buttons: [], axes: [] }; }
  }
  // Escape or a click/tap anywhere else cancels; so does the 10s timeout.
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelGamepadButtonDetection();
    }
  };
  const onClick = (e) => {
    if (uiRefs.buttonEl && (e.target === uiRefs.buttonEl || uiRefs.buttonEl.contains(e.target))) return;
    this.cancelGamepadButtonDetection();
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('click', onClick, true);
  this._detecting = { ui: uiRefs, deadline: Date.now() + 10000, onKey, onClick };
  try { uiRefs.buttonEl.disabled = true; } catch (_) {}
  try {
    uiRefs.hintEl.textContent = 'Press any button, D-pad or hat direction… (Esc or tap elsewhere to cancel)';
    uiRefs.hintEl.style.display = '';
  } catch (_) {}
};

GamepadManager.prototype.cancelGamepadButtonDetection = function() {
  if (this._detecting && this._detecting.ui) {
    const { buttonEl, hintEl } = this._detecting.ui;
    try { if (buttonEl) buttonEl.disabled = false; } catch (_) {}
    try { if (hintEl) hintEl.style.display = 'none'; } catch (_) {}
  }
  if (this._detecting) {
    try { document.removeEventListener('keydown', this._detecting.onKey, true); } catch (_) {}
    try { document.removeEventListener('click', this._detecting.onClick, true); } catch (_) {}
  }
  this._detecting = false;
  this._detectSnapshot = {};
};

GamepadManager.prototype.handleDetectionTick = function() {
  if (!this._detecting) return;
  // If configurator closed, cancel detection
  if (!(this.isConfiguratorOpen && this.isConfiguratorOpen())) {
    this.cancelGamepadButtonDetection();
    return;
  }
  if (Date.now() > this._detecting.deadline) {
    this.cancelGamepadButtonDetection();
    try { this.showConfiguratorNotice('No gamepad input detected.'); } catch (_) {}
    return;
  }
  for (let idx in this.controllers) {
    const gp = this.controllers[idx];
    if (!gp) continue;
    const snap = this._detectSnapshot[idx] || { buttons: [], axes: [] };
    const detected = this.detectRawControlEdge(gp, snap);
    if (!detected) continue;
    if (detected.slot === null) {
      // An axis we can't translate to a standard button slot (e.g. an analog
      // stick move) — be honest instead of guessing.
      this.cancelGamepadButtonDetection();
      try { this.showConfiguratorNotice(`Detected ${detected.desc} — can't be mapped here. Run the Button Wizard instead.`); } catch (_) {}
      return;
    }
    // Assign detected control to the UI select and show the default key
    try {
      const selectEl = this._detecting.ui && this._detecting.ui.selectEl;
      if (selectEl) selectEl.value = String(detected.slot);
      const defKey = this.getDefaultKeyForGamepadIndex(detected.slot);
      const keyInput = document.querySelector('#keyboard-key-input');
      if (keyInput && defKey) keyInput.value = defKey;
    } catch (_) {}
    this.cancelGamepadButtonDetection();
    try { this.showConfiguratorNotice(`Detected ${detected.desc}.`); } catch (_) {}
    return;
  }
};

// Compare a pad against its detection-start snapshot and return the first new
// input as { slot, desc }: a raw button index, a hat direction (mapped to the
// standard D-pad slots 12-15 — readDpad honors the hat directly), or a
// digital D-pad axis (axes 6/7, same convention readDpad uses). Anything else
// (analog stick movement) returns slot: null so the caller can bail honestly.
GamepadManager.prototype.detectRawControlEdge = function(gp, snap) {
  const buttons = gp.buttons || [];
  for (let i = 0; i < buttons.length; i++) {
    const pressed = !!(buttons[i] && buttons[i].pressed);
    if (pressed && !snap.buttons[i]) return { slot: i, desc: `button ${i}` };
  }
  const axes = gp.axes || [];
  const dirSlot = { up: 12, down: 13, left: 14, right: 15 };
  for (let i = 0; i < axes.length; i++) {
    const v = axes[i];
    if (typeof v !== 'number') continue;
    const base = typeof snap.axes[i] === 'number' ? snap.axes[i] : 0;
    // Encoded hat: rests outside [-1, 1]; a press lands on the 8-step grid.
    if (Math.abs(base) > 1.05) {
      if (Math.abs(v) <= 1.05) {
        const dirs = this.decodeHat(v);
        for (const d of ['up', 'down', 'left', 'right']) {
          if (dirs[d]) return { slot: dirSlot[d], desc: `hat ${d} (axis ${i})` };
        }
      }
      continue;
    }
    if (Math.abs(v - base) < 0.6) continue;
    // Dedicated digital D-pad axes (readDpad convention: 6 = left/right, 7 = up/down)
    if (i === 6) return { slot: v < 0 ? 14 : 15, desc: `axis 6 ${v < 0 ? 'left' : 'right'}` };
    if (i === 7) return { slot: v < 0 ? 12 : 13, desc: `axis 7 ${v < 0 ? 'up' : 'down'}` };
    return { slot: null, desc: `axis ${i} movement` };
  }
  return null;
};

GamepadManager.prototype.getDefaultKeyForGamepadIndex = function(idx) {
  // Search defaultMapping to find the first entry with matching gamepadButton
  const groups = ['dpad', 'face', 'shoulder', 'special'];
  for (const g of groups) {
    const group = this.defaultMapping[g] || {};
    for (const name in group) {
      const m = group[name];
      if (m && m.gamepadButton === idx) return m.keyboardKey;
    }
  }
  return '';
};

// ===== Gamepad navigation of the configurator panel =====
//
// Called from GamepadManager.poll() every frame, BEFORE processInputs(), so
// nav presses are consumed here instead of leaking into the game or launcher.
// While the panel is open this also latches the manager's edge-tracking state
// for the D-pad and A/B to the live pressed values each frame, which means
// processButtonGroup() never sees a rising or falling edge for them — the
// panel fully owns those inputs, including the legacy "FBTN_RIGHT closes the
// configurator" special case, which is re-issued from here.
GamepadManager.prototype.handleConfiguratorPadTick = function () {
  if (!(this.isConfiguratorOpen && this.isConfiguratorOpen())) {
    if (this._cfgNav) this._cfgNav = null;
    return;
  }

  const input = this.readConfiguratorNavInput();
  this.latchConfiguratorButtonState();

  const nav = this._cfgNav;
  if (!nav) {
    // Snapshot frame: whatever is held right now is the press that opened the
    // panel — it must release before it can act on the panel.
    this._cfgNav = { focusEl: null, prev: input, dir: null, dirStart: 0, dirLast: 0, holdB: 0, suspended: false };
    return;
  }

  // The wizard and Detect-mode consume raw presses themselves; pause nav and
  // resync the edge baselines afterwards so a still-held button can't re-fire.
  if (this.wizardActive || this._detecting) {
    nav.suspended = true;
    nav.prev = input;
    return;
  }
  if (nav.suspended) {
    nav.suspended = false;
    nav.prev = input;
    return;
  }

  const now = performance.now();

  // Live Testing swallows every control so presses can be visualized —
  // including B-close. Escape hatch for pad-only players: hold B ~1.5s.
  if (this.testingMode) {
    if (input.b) {
      if (!nav.holdB) {
        nav.holdB = now;
      } else if (now - nav.holdB >= 1500) {
        nav.holdB = 0;
        this.setTestingMode(false);
        const toggle = document.querySelector('.controller-configurator #btn-testing-toggle');
        if (toggle) toggle.checked = false;
        this.showConfiguratorNotice('Live Testing off');
      }
    } else {
      nav.holdB = 0;
    }
    nav.prev = input;
    return;
  }
  nav.holdB = 0;

  // FBTN_RIGHT (B) closes the panel — the same behavior processInputs
  // provided before this tick took ownership of pad input.
  if (input.b && !nav.prev.b) {
    nav.prev = input;
    try { this.closeConfigurator(); } catch (_) {}
    return;
  }

  // FBTN_BOTTOM (A) activates the focused control.
  if (input.a && !nav.prev.a) {
    nav.prev = input;
    if (nav.focusEl && this.getConfiguratorFocusables().includes(nav.focusEl)) {
      this.activateConfiguratorControl(nav.focusEl);
      this.applyConfiguratorFocus(nav.focusEl);
    }
    return;
  }

  // D-pad: up/down moves focus, left/right adjusts the focused control.
  // Edge-latched with hold-to-repeat (~400ms initial delay, ~150ms rate).
  const dir = input.up ? 'up' : input.down ? 'down' : input.left ? 'left' : input.right ? 'right' : null;
  if (!dir) {
    nav.dir = null;
  } else {
    let fire = false;
    if (nav.dir !== dir) {
      nav.dir = dir;
      nav.dirStart = now;
      nav.dirLast = now;
      fire = true;
    } else if (now - nav.dirStart >= 400 && now - nav.dirLast >= 150) {
      nav.dirLast = now;
      fire = true;
    }
    if (fire) this.handleConfiguratorNavDir(dir);
  }

  nav.prev = input;
};

// Aggregate nav-relevant pressed state across all connected pads. Direction
// comes from readDpad() so hat- and axis-based D-pads work; A/B honor each
// controller's face-button remap (defaults 0/1).
GamepadManager.prototype.readConfiguratorNavInput = function () {
  const agg = { up: false, down: false, left: false, right: false, a: false, b: false };
  for (const idx in this.controllers) {
    const c = this.controllers[idx];
    if (!c || !c.id) continue;
    const mapping = this.controllerMappings[this.getControllerId(c)] || this.defaultMapping;
    const d = this.readDpad(c, mapping);
    agg.up = agg.up || d.up;
    agg.down = agg.down || d.down;
    agg.left = agg.left || d.left;
    agg.right = agg.right || d.right;
    const pressed = (i) => !!(c.buttons && c.buttons[i] && c.buttons[i].pressed);
    const aIdx = mapping.face && mapping.face.btnBottom && mapping.face.btnBottom.gamepadButton;
    const bIdx = mapping.face && mapping.face.btnRight && mapping.face.btnRight.gamepadButton;
    agg.a = agg.a || pressed(typeof aIdx === 'number' ? aIdx : 0);
    agg.b = agg.b || pressed(typeof bIdx === 'number' ? bIdx : 1);
  }
  return agg;
};

// While the panel is open, keep the manager's edge-tracking state for the
// controls the panel consumes in sync with reality so processButtonGroup()
// never sees an edge for them: no synthetic keys, no double-handling, and the
// press that closes the panel can't leak into the game as a fresh keydown.
GamepadManager.prototype.latchConfiguratorButtonState = function () {
  for (const idx in this.controllers) {
    const c = this.controllers[idx];
    if (!c || !c.id) continue;
    const bs = this.ensureButtonState(idx);
    const mapping = this.controllerMappings[this.getControllerId(c)] || this.defaultMapping;
    const d = this.readDpad(c, mapping);
    bs.up = d.up;
    bs.down = d.down;
    bs.left = d.left;
    bs.right = d.right;
    const pressed = (i) => !!(c.buttons && c.buttons[i] && c.buttons[i].pressed);
    const aIdx = mapping.face && mapping.face.btnBottom && mapping.face.btnBottom.gamepadButton;
    const bIdx = mapping.face && mapping.face.btnRight && mapping.face.btnRight.gamepadButton;
    bs.btnBottom = pressed(typeof aIdx === 'number' ? aIdx : 0);
    bs.btnRight = pressed(typeof bIdx === 'number' ? bIdx : 1);
    bs.faceSouth = bs.btnBottom;
    bs.faceEast = bs.btnRight;
  }
};

// Ordered list of pad-focusable controls: sidebar top-to-bottom, then the
// footer, then the header ✕. Free-text inputs are excluded — they need a
// physical keyboard (the readonly key field's pad path is its Detect button).
// Hidden controls (e.g. the mapping form before a diagram button is selected,
// or sections hidden for "All Connected") drop out automatically.
GamepadManager.prototype.getConfiguratorFocusables = function () {
  const root = document.querySelector('.controller-configurator');
  if (!root) return [];
  const selectors = [
    '#config-controller-select',
    '#open-wizard-btn',
    '#wasd-toggle',
    '#start-touch-toggle',
    '#detect-key-btn',
    '#gamepad-button-select',
    '#detect-gamepad-btn',
    '#save-mapping-btn',
    '#reset-mapping-btn',
    '#btn-testing-toggle',
    '.reset-all-btn',
    '.save-close-btn',
    '.close-btn',
  ];
  const items = [];
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (!el || el.disabled) continue;
    const visual = this.configuratorFocusVisual(el);
    if (!visual || !visual.getClientRects().length) continue;
    items.push(el);
  }
  return items;
};

// The pill-toggle checkboxes are display:none; render focus on their .switch.
GamepadManager.prototype.configuratorFocusVisual = function (el) {
  if (el && el.tagName === 'INPUT' && el.type === 'checkbox') {
    const sw = el.closest('label.switch');
    if (sw) return sw;
  }
  return el;
};

GamepadManager.prototype.applyConfiguratorFocus = function (el) {
  const root = document.querySelector('.controller-configurator');
  if (!root) return;
  root.querySelectorAll('.pad-focus').forEach((n) => n.classList.remove('pad-focus'));
  if (!el) return;
  const visual = this.configuratorFocusVisual(el);
  visual.classList.add('pad-focus');
  try { visual.scrollIntoView({ block: 'nearest' }); } catch (_) {}
};

GamepadManager.prototype.moveConfiguratorFocus = function (delta) {
  const items = this.getConfiguratorFocusables();
  if (!items.length) return;
  const nav = this._cfgNav;
  const idx = items.indexOf(nav.focusEl);
  const next = idx < 0
    ? (delta > 0 ? 0 : items.length - 1)
    : (idx + delta + items.length) % items.length;
  nav.focusEl = items[next];
  this.applyConfiguratorFocus(nav.focusEl);
};

GamepadManager.prototype.handleConfiguratorNavDir = function (dir) {
  if (dir === 'up') { this.moveConfiguratorFocus(-1); return; }
  if (dir === 'down') { this.moveConfiguratorFocus(1); return; }
  // left/right adjust the focused control in place
  const el = this._cfgNav.focusEl;
  if (!el || !this.getConfiguratorFocusables().includes(el)) return;
  if (el.tagName === 'SELECT') {
    this.cycleConfiguratorSelect(el, dir === 'right' ? 1 : -1);
  } else if (el.tagName === 'INPUT' && el.type === 'checkbox') {
    el.checked = !el.checked;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
};

GamepadManager.prototype.activateConfiguratorControl = function (el) {
  if (!el) return;
  if (el.tagName === 'SELECT') {
    // A pad can't open a native dropdown; A steps to the next option.
    this.cycleConfiguratorSelect(el, 1);
    return;
  }
  if (el.tagName === 'INPUT' && el.type === 'checkbox') {
    el.checked = !el.checked;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  try { el.click(); } catch (_) {}
};

GamepadManager.prototype.cycleConfiguratorSelect = function (el, delta) {
  const n = el.options ? el.options.length : 0;
  if (!n) return;
  el.selectedIndex = ((el.selectedIndex < 0 ? 0 : el.selectedIndex) + delta + n) % n;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

// CSS for Controller Configurator
const configuratorCSS = `
.controller-configurator {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 10000;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease;
  font-family: 'Orbitron', sans-serif;
}

.controller-configurator.visible {
  opacity: 1;
  pointer-events: all;
}

.configurator-overlay {
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.55);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  display: flex;
  justify-content: center;
  align-items: center;
}

.configurator-panel {
  background: linear-gradient(180deg, rgba(12, 40, 20, .94), rgba(6, 22, 11, .96));
  border-radius: 12px;
  box-shadow: 0 0 38px rgba(80, 220, 100, .3), inset 0 0 0 1px rgba(140, 255, 110, .08);
  -webkit-backdrop-filter: blur(8px) saturate(140%);
  backdrop-filter: blur(8px) saturate(140%);
  width: 90vw;
  max-width: 1000px;
  height: 80vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--tile-edge, rgba(140, 255, 110, .55));
  color: #dfffc4;
}

.configurator-header {
  padding: 16px 20px;
  border-bottom: 1px solid rgba(140, 255, 110, .18);
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-radius: 12px 12px 0 0;
}

.configurator-header h2 {
  color: #eaffd2;
  margin: 0;
  font-family: 'Orbitron', sans-serif;
  font-weight: 800;
  font-size: 18px;
  letter-spacing: .18em;
  text-transform: uppercase;
  text-shadow: 0 0 14px rgba(120, 255, 90, .5);
}

.close-btn {
  background: transparent;
  border: 1px solid rgba(140, 255, 110, .25);
  color: rgba(220, 255, 180, .6);
  font-size: 18px;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.close-btn:hover {
  background: rgba(120, 255, 90, .12);
  color: #eaffd2;
  border-color: rgba(140, 255, 110, .5);
}

.configurator-content {
  flex: 1;
  display: flex;
  padding: 20px;
  gap: 20px;
  overflow: hidden;
}

.controller-visual {
  flex: 2;
  background: linear-gradient(180deg, rgba(70, 180, 90, .07), rgba(20, 60, 30, .35));
  border: 1px solid rgba(140, 255, 110, .18);
  border-radius: 8px;
  padding: 20px;
  display: flex;
  justify-content: center;
  align-items: center;
}

.controller-svg {
  max-width: 100%;
  max-height: 100%;
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.4));
}

.config-btn {
  cursor: pointer;
  transition: fill 0.15s ease, transform 0.15s ease, stroke 0.15s ease;
}

.config-btn:hover {
  fill: #7CFF4F;
  transform: scale(1.1);
}

.config-btn.selected {
  fill: var(--yellow, #F6FF4A);
  stroke: #fff36a;
  stroke-width: 2;
}

.configurator-sidebar {
  flex: 1;
  background: linear-gradient(180deg, rgba(70, 180, 90, .05), rgba(20, 60, 30, .3));
  border: 1px solid rgba(140, 255, 110, .14);
  border-radius: 8px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(140, 255, 110, .3) transparent;
}

.mapping-info h3,
.layout-section h3 {
  color: rgba(180, 255, 140, .85);
  margin: 0 0 12px 0;
  font-family: 'Share Tech Mono', monospace;
  font-size: 13px;
  letter-spacing: .18em;
  text-transform: uppercase;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(140, 255, 110, .14);
}

.current-mapping p {
  color: rgba(220, 255, 180, .7);
  margin: 0;
  font-family: 'Share Tech Mono', monospace;
  font-size: 13px;
}

.mapping-form h4 {
  color: #eaffd2;
  margin: 0 0 15px 0;
  font-family: 'Orbitron', sans-serif;
  font-weight: 700;
  font-size: 14px;
  letter-spacing: .04em;
}

.form-group {
  margin-bottom: 15px;
}

.form-group label {
  display: block;
  color: rgba(220, 255, 180, .75);
  margin-bottom: 5px;
  font-size: 13px;
  letter-spacing: .04em;
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid rgba(140, 255, 110, .25);
  border-radius: 6px;
  background: rgba(6, 22, 11, .6);
  color: #eaffd2;
  font-size: 14px;
  font-family: 'Share Tech Mono', monospace;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: rgba(140, 255, 110, .6);
  box-shadow: 0 0 10px rgba(120, 255, 90, .25);
}

.form-group input::placeholder {
  color: rgba(180, 255, 140, .35);
}

.form-group select option {
  background: #06160b;
  color: #eaffd2;
}

.form-group button {
  margin-top: 8px;
  padding: 7px 14px;
  background: linear-gradient(180deg, rgba(70, 180, 90, .2), rgba(20, 60, 30, .5));
  color: #eaffd2;
  border: 1px solid rgba(140, 255, 110, .4);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-family: 'Orbitron', sans-serif;
  letter-spacing: .05em;
  transition: all 0.15s ease;
}

.form-group button:hover {
  background: linear-gradient(180deg, rgba(90, 220, 110, .3), rgba(30, 80, 40, .6));
  border-color: rgba(140, 255, 110, .65);
  box-shadow: 0 0 14px rgba(80, 220, 100, .25);
}

.form-actions {
  display: flex;
  gap: 10px;
}

.form-actions button {
  flex: 1;
  padding: 9px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  font-family: 'Orbitron', sans-serif;
  letter-spacing: .05em;
  transition: all 0.15s ease;
}

/* Inline form group (for testing toggle) */
.form-group.inline {
  display: flex;
  align-items: center;
  gap: 10px;
}

.form-group.inline label {
  margin-bottom: 0;
}

.testing-section h3 {
  color: rgba(180, 255, 140, .85);
  margin: 0 0 12px 0;
  font-family: 'Share Tech Mono', monospace;
  font-size: 13px;
  letter-spacing: .18em;
  text-transform: uppercase;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(140, 255, 110, .14);
}

.testing-hint {
  color: rgba(180, 255, 140, .5);
  font-size: 12px;
  margin: 6px 0 0 0;
  font-family: 'Share Tech Mono', monospace;
  line-height: 1.4;
}

/* Live raw-input readout (button indices / axes the pad reports) */
.raw-readout {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(140, 255, 110, .18);
  border-radius: 6px;
  background: rgba(6, 22, 11, .55);
  font-family: 'Share Tech Mono', monospace;
  font-size: 12px;
  line-height: 1.5;
  color: #cdebb0;
  max-height: 180px;
  overflow-y: auto;
}

.raw-readout-empty {
  color: rgba(180, 255, 140, .45);
}

.raw-readout-pad + .raw-readout-pad {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed rgba(140, 255, 110, .14);
}

.raw-readout-id {
  color: rgba(180, 255, 140, .85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}

.raw-readout-line span {
  display: inline-block;
  width: 44px;
  color: rgba(140, 255, 110, .55);
  text-transform: uppercase;
  letter-spacing: .08em;
}

.start-section h3 {
  color: rgba(180, 255, 140, .85);
  margin: 0 0 12px 0;
  font-family: 'Share Tech Mono', monospace;
  font-size: 13px;
  letter-spacing: .18em;
  text-transform: uppercase;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(140, 255, 110, .14);
}

/* Toggle switch — matches the OSD pill toggle */
.switch {
  position: relative;
  display: inline-block;
  width: 46px;
  height: 24px;
  flex-shrink: 0;
}

.switch input { display: none; }

.slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(140, 255, 110, .22);
  transition: .15s ease;
  border-radius: 999px;
}

.slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: #eaffd2;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .4);
  transition: .15s ease;
  border-radius: 50%;
}

input:checked + .slider {
  background-color: #4fd06a;
}

input:checked + .slider:before {
  transform: translateX(22px);
}

/* Visual highlight for pressed buttons during testing */
.controller-configurator.testing-active .controller-svg .config-btn.testing-pressed {
  fill: #7CFF4F !important;
  stroke: #eaffd2;
  stroke-width: 2;
  filter: drop-shadow(0 0 6px rgba(120, 255, 90, 0.8));
}

#save-mapping-btn {
  background: linear-gradient(180deg, rgba(160, 255, 110, .95), rgba(90, 220, 60, .9));
  border: 1px solid rgba(180, 255, 140, 1);
  color: #0a1a06;
  text-shadow: 0 1px 0 rgba(255, 255, 255, .25);
  box-shadow: 0 0 20px rgba(120, 255, 90, .35), inset 0 -2px 0 rgba(0, 0, 0, .15);
}

#save-mapping-btn:hover {
  background: linear-gradient(180deg, rgba(180, 255, 130, 1), rgba(110, 240, 80, .95));
  box-shadow: 0 0 28px rgba(120, 255, 90, .5), inset 0 -2px 0 rgba(0, 0, 0, .15);
}

#reset-mapping-btn {
  background: transparent;
  border: 1px solid rgba(255, 177, 61, .5);
  color: #FFB13D;
}

#reset-mapping-btn:hover {
  background: rgba(255, 177, 61, .12);
  border-color: rgba(255, 177, 61, .8);
  box-shadow: 0 0 14px rgba(255, 177, 61, .25);
}

.configurator-footer {
  padding: 16px 20px;
  border-top: 1px solid rgba(140, 255, 110, .18);
  display: flex;
  justify-content: space-between;
  gap: 12px;
  background: rgba(6, 22, 11, .5);
  border-radius: 0 0 12px 12px;
}

.reset-all-btn,
.save-close-btn {
  padding: 10px 20px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  font-family: 'Orbitron', sans-serif;
  letter-spacing: .05em;
  transition: all 0.15s ease;
}

.reset-all-btn {
  background: transparent;
  border: 1px solid rgba(255, 177, 61, .5);
  color: #FFB13D;
}

.reset-all-btn:hover {
  background: rgba(255, 177, 61, .12);
  border-color: rgba(255, 177, 61, .8);
  box-shadow: 0 0 14px rgba(255, 177, 61, .25);
}

.save-close-btn {
  background: linear-gradient(180deg, rgba(160, 255, 110, .95), rgba(90, 220, 60, .9));
  border: 1px solid rgba(180, 255, 140, 1);
  color: #0a1a06;
  text-shadow: 0 1px 0 rgba(255, 255, 255, .25);
  box-shadow: 0 0 20px rgba(120, 255, 90, .35), inset 0 -2px 0 rgba(0, 0, 0, .15);
}

.save-close-btn:hover {
  background: linear-gradient(180deg, rgba(180, 255, 130, 1), rgba(110, 240, 80, .95));
  box-shadow: 0 0 28px rgba(120, 255, 90, .5), inset 0 -2px 0 rgba(0, 0, 0, .15);
}

/* Anchor for the inline toast */
.configurator-panel {
  position: relative;
}

/* The SVG letter labels sit on top of the button shapes; without this they
   swallow clicks/taps meant for the shape underneath (worst on touch). */
.controller-svg text {
  pointer-events: none;
}

/* Invisible enlarged touch targets layered under the small visible shapes */
.config-hit {
  cursor: pointer;
}

/* Gamepad-navigation focus ring */
.controller-configurator .pad-focus {
  outline: 2px solid var(--yellow, #F6FF4A);
  outline-offset: 2px;
  box-shadow: 0 0 12px rgba(246, 255, 74, .45);
  border-radius: 6px;
}

/* Inline toast — non-blocking replacement for alert() */
.cfg-toast {
  position: absolute;
  left: 50%;
  bottom: 72px;
  transform: translateX(-50%) translateY(6px);
  background: rgba(6, 22, 11, .94);
  border: 1px solid rgba(140, 255, 110, .5);
  color: #eaffd2;
  padding: 8px 14px;
  border-radius: 8px;
  font-family: 'Share Tech Mono', monospace;
  font-size: 13px;
  max-width: 80%;
  text-align: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease, transform 0.2s ease;
  z-index: 5;
}

.cfg-toast.show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

/* Reset All press-again-to-confirm state */
.reset-all-btn.confirming {
  background: rgba(255, 80, 60, .16);
  border-color: rgba(255, 120, 90, .9);
  color: #ff9c86;
  box-shadow: 0 0 14px rgba(255, 120, 90, .35);
}

/* Narrow / portrait viewports (phones): stack the diagram above the sidebar
   and let the whole content column scroll. */
@media (max-width: 700px) {
  .configurator-panel {
    width: 96vw;
    height: 94vh;
  }

  .configurator-content {
    flex-direction: column;
    overflow-y: auto;
    padding: 12px;
    gap: 12px;
  }

  .controller-visual {
    flex: 0 0 auto;
    padding: 8px;
  }

  .controller-svg {
    width: 100%;
    height: auto;
    max-height: 32vh;
  }

  .configurator-sidebar {
    flex: 0 0 auto;
    overflow-y: visible;
  }
}
`;

  const styleSheet = document.createElement('style');
  styleSheet.textContent = configuratorCSS;
  document.head.appendChild(styleSheet);

  // Opened from the in-game OSD ("Controller Settings"); alias kept for back-compat.
  window.openControllerConfigurator = (opts) => window.gamepadManager.openControllerConfigurator(opts);
  window.openControllerConfig = window.openControllerConfigurator;
})();
