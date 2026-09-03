// boss-lab.js — the BOSS LAB: every boss of the loaded game, live, next to an
// attack-pattern assignment panel. One component, two hosts:
//
//   static/editor/index.html   mounts it in place of the wave grid (toolbar
//                              invader badge / drawer → BOSS LAB) and commits
//                              APPLY into its own bossData.
//   static/editor/boss-viewer.html  mounts it standalone and writes APPLY back
//                              through the editor bridge, so both pages read
//                              one store.
//
//   const lab = BossLab.mount(container, {
//     getBossData: () => bossData,        // host-owned record map (boss0…, bossExtra)
//     atlas: () => ({ frames, url, w, h }) | null,   // CSS-crop source for frames
//     frameUrl: name => url | null,       // fallback for frames outside the atlas
//     playerFrames: () => ['player00.gif', 'player01.gif'],
//     onApply: (changes, n) => {},        // commit {bossKey: patternKey|''}; omit → lab mutates the data itself
//     onBack: () => {},                   // B when nothing is pending (omit → B is inert)
//     onSave: () => {} | null,            // Y SAVE when the host has a save target
//     bossName: (key, rec) => string,     // optional display-name override
//     theme: 'xbox' | 'nintendo', layout: 'auto' | 'phone' | 'desktop',
//   });
//   lab.setTheme(t); lab.refresh(); lab.selectBoss(k); lab.pendingCount(); lab.destroy();
//
// The sim (step DSL, projectile physics, player drag, hit rings) is the
// boss-viewer.html sim, moved here so the editor gets the same preview.
(function () {
    'use strict';

    const BOSS_ORDER = ['boss0', 'boss1', 'boss2', 'boss3', 'boss4', 'bossExtra'];
    // Null-prototype: looked up with bossData keys and attackPattern values that
    // come straight off a shared level, so a plain object would let
    // "constructor" pull function source out of Object.prototype.
    const NAMES = Object.assign(Object.create(null), { boss0: 'Bison', boss1: 'Barlog', boss2: 'Sagat', boss3: 'Vega', boss4: 'Fang', bossExtra: 'Goki' });
    // A Dezaemon import fills the same slots with its own bosses, named
    // dezaBoss0..N by map-to-game.js — that name wins over the shipped roster.
    const IMPORTED_BOSS_NAME = /^dezaBoss\d+$/;
    const BASE = 0.26;          // boss resting y (fraction of stage height)
    const SPRITE_SCALE = 3;     // boss sprite scale (clamped to fit the stage)
    const REPEAT_DELAY = 1000;  // ms before a finished pattern move loops
    const NARROW_BELOW = 760;   // px: below this the split stacks (sim over a collapsible panel)

    // Pattern-preview path sketches shown in the panel when a new pattern is picked.
    const PREVIEWS = {
        boss0: { d: 'M30 30 H290', d2: 'M160 30 V88', dots: [[30, 30], [160, 30], [290, 30], [160, 88]] },
        boss1: { d: 'M20 40 C80 15 130 55 180 35', d2: 'M180 35 L215 88 L255 40', dots: [[20, 40], [180, 35], [255, 40]] },
        boss2: { d: 'M20 30 H70 V48 H120 V30 H170 V48 H220', d2: 'M268 30 V85', dots: [[20, 30], [220, 48], [268, 85]] },
        boss3: { d: 'M160 45 L100 90 M160 45 L160 92 M160 45 L220 90', dots: [[30, 28], [290, 28], [160, 45]] },
        boss4: { d: 'M160 25 L105 88 M160 25 L160 92 M160 25 L215 88', dots: [[160, 25], [105, 88], [160, 92], [215, 88]] },
        bossExtra: { d: 'M30 62 C85 18 150 92 205 45 S275 24 292 32', dots: [[30, 62], [292, 32]] }
    };

    // ================== ATTACK PATTERNS ==================
    // Simulated versions of the game's boss movement/attack patterns.
    // Step DSL: tw (tween x/y), jump (teleport), fade (alpha), wait (ms),
    // anim (switch animation), fire (spawn projectiles).
    // The steps builder gets c = { px: player x, B: BASE, r(a,b): random }.
    const PAT = Object.assign(Object.create(null), {
        boss0: { label: 'PYRAMID', desc: 'WARP ×3 → STRAFE VOLLEY ×7 → RADIAL FIELD → DIVE CRUSH ON PLAYER X', moves: [
            { l: 'WARP ×3', sub: 'TELEPORT SWEEP', a: 'idle', steps: c => [{ fade: 0, dur: 90 }, { jump: { x: 0.12 } }, { fade: 1, dur: 90 }, { wait: 260 }, { fade: 0, dur: 90 }, { jump: { x: 0.88 } }, { fade: 1, dur: 90 }, { wait: 260 }, { fade: 0, dur: 90 }, { jump: { x: c.r(0.2, 0.8) } }, { fade: 1, dur: 90 }] },
            { l: 'STRAFE VOLLEY', sub: 'STRAIGHT ×7', a: 'attack', steps: c => { const s = [{ anim: 'attack' }]; [0.06, 0.94, 0.14, 0.86, 0.28, 0.72, 0.5].forEach(x => s.push({ jump: { x } }, { fire: { type: 'straight' } }, { wait: 130 })); return s; } },
            { l: 'RADIAL FIELD', sub: 'RADIAL 14 ×3', a: 'attack', steps: c => [{ tw: { x: 0.5, y: c.B + 0.05 }, dur: 400, anim: 'attack' }, { fire: { type: 'radial', count: 14, proj: 'B' } }, { wait: 750 }, { fire: { type: 'radial', count: 14, proj: 'B' } }, { wait: 750 }, { fire: { type: 'radial', count: 14, proj: 'B' } }] },
            { l: 'DIVE CRUSH', sub: 'LOCK X · DIVE', a: 'attack', steps: c => [{ jump: { x: c.px } }, { anim: 'attack' }, { tw: { y: c.B - 0.07 }, dur: 220 }, { tw: { y: 0.9 }, dur: 800, ease: 'in' }, { fade: 0, dur: 60 }, { jump: { x: 0.5, y: -0.12 } }, { fade: 1, dur: 60 }, { tw: { y: c.B }, dur: 800 }] }
        ] },
        boss1: { label: 'BARLOG', desc: 'REPOSITION → STRAIGHT SHOT · TRACK PLAYER X + SHOT · POWER DIVE + RETURN', moves: [
            { l: 'REPOSITION SHOT', sub: 'STRAIGHT ×1', a: 'shoot', steps: c => [{ tw: { x: c.r(0.1, 0.9), y: c.r(0.15, 0.4) }, dur: 600 }, { anim: 'shoot' }, { fire: { type: 'straight' } }, { wait: 400 }] },
            { l: 'TRACK + SHOT', sub: 'LOCK X · STRAIGHT', a: 'shoot', steps: c => [{ tw: { x: c.px }, dur: 300 }, { anim: 'shoot' }, { wait: 350 }, { fire: { type: 'straight' } }, { wait: 350 }] },
            { l: 'POWER DIVE', sub: 'SHOT · DIVE', a: 'attack', steps: c => [{ tw: { x: c.px }, dur: 500 }, { fire: { type: 'straight' } }, { anim: 'attack' }, { tw: { y: c.B - 0.12 }, dur: 300 }, { tw: { y: 0.88 }, dur: 600, ease: 'in' }, { tw: { y: c.B }, dur: 300 }] }
        ] },
        boss2: { label: 'SAGAT', desc: 'SWEEP 6 STOPS FIRING → RAPID FIRE ×7 → TIGER SHOT (B) → DIVE + RETURN', moves: [
            { l: 'SWEEP VOLLEY', sub: 'STRAIGHT ×6', a: 'shoot', steps: c => { const s = [{ anim: 'shoot' }]; [0.05, 0.22, 0.42, 0.62, 0.82, 0.95].forEach(x => s.push({ tw: { x }, dur: 250 }, { fire: { type: 'straight' } })); return s; } },
            { l: 'RAPID FIRE', sub: 'STRAIGHT ×7', a: 'shoot', steps: c => { const s = [{ tw: { x: c.r(0.15, 0.85) }, dur: 250, anim: 'shoot' }]; for (let i = 0; i < 7; i++) s.push({ fire: { type: 'straight' } }, { wait: 200 }); return s; } },
            { l: 'TIGER SHOT', sub: 'HEAVY SHOT B', a: 'charge', steps: c => [{ tw: { x: c.r(0.15, 0.85) }, dur: 250, anim: 'charge' }, { wait: 500 }, { anim: 'shoot' }, { fire: { type: 'straight', proj: 'B' } }, { wait: 500 }] },
            { l: 'DIVE RETURN', sub: 'LOCK X · DIVE', a: 'attack', steps: c => [{ tw: { x: c.px, y: c.B - 0.05 }, dur: 400 }, { fire: { type: 'straight' } }, { wait: 300 }, { anim: 'attack' }, { tw: { y: 0.88 }, dur: 300, ease: 'in' }, { tw: { y: c.B }, dur: 260 }] }
        ] },
        boss3: { label: 'VEGA', desc: 'TRIPLE WARP · PSYCHO SHOTS ×7 AIMED · RADIAL FIELD 12×5 · IZUNA DIVE + SPREAD', moves: [
            { l: 'TRIPLE WARP', sub: 'TELEPORT ×3', a: 'idle', steps: c => [{ fade: 0, dur: 80 }, { jump: { x: 0.08 } }, { fade: 1, dur: 80 }, { wait: 220 }, { fade: 0, dur: 80 }, { jump: { x: 0.92 } }, { fade: 1, dur: 80 }, { wait: 220 }, { fade: 0, dur: 80 }, { jump: { x: c.r(0.2, 0.8) } }, { fade: 1, dur: 80 }] },
            { l: 'PSYCHO SHOTS', sub: 'AIMED ×7', a: 'shoot', steps: c => { const s = [{ anim: 'shoot' }]; [0.08, 0.85, 0.15, 0.5, 0.9, 0.2, 0.5].forEach(x => s.push({ fade: 0, dur: 80 }, { jump: { x } }, { fade: 1, dur: 80 }, { fire: { type: 'aimed' } }, { wait: 240 })); return s; } },
            { l: 'RADIAL FIELD', sub: 'RADIAL 12 ×3', a: 'shoot', steps: c => [{ tw: { x: 0.5, y: c.B + 0.03 }, dur: 300, anim: 'shoot' }, { fire: { type: 'radial', count: 12, proj: 'B' } }, { wait: 800 }, { fire: { type: 'radial', count: 12, proj: 'B' } }, { wait: 800 }, { fire: { type: 'radial', count: 12, proj: 'B' } }] },
            { l: 'IZUNA DIVE', sub: 'SPREAD 3 · DIVE', a: 'attack', steps: c => [{ fade: 0, dur: 80 }, { jump: { x: c.px } }, { fade: 1, dur: 80 }, { anim: 'attack' }, { tw: { y: c.B - 0.06 }, dur: 200 }, { fire: { type: 'spread', count: 3, angle: 30 } }, { tw: { y: 0.92 }, dur: 800, ease: 'in' }, { fade: 0, dur: 60 }, { jump: { x: 0.5, y: -0.12 } }, { fade: 1, dur: 60 }, { tw: { y: c.B }, dur: 800 }] }
        ] },
        boss4: { label: 'FANG', desc: 'POISON BEAMS 105°/90°/75° · RADIAL BURST ×8 · SMOKE BARRAGE AIMED', moves: [
            { l: 'POISON BEAMS', sub: 'BEAMS 105/90/75°', a: 'charge', steps: c => [{ anim: 'charge' }, { wait: 500 }, { anim: 'shoot' }, { fire: { type: 'beam', angle: 105 } }, { wait: 450 }, { fire: { type: 'beam', angle: 90 } }, { wait: 450 }, { fire: { type: 'beam', angle: 75 } }, { wait: 300 }] },
            { l: 'RADIAL BURST', sub: 'RADIAL ×8', a: 'shoot', steps: c => [{ anim: 'shoot' }, { fire: { type: 'radial', count: 8 } }, { wait: 600 }] },
            { l: 'SMOKE BARRAGE', sub: 'AIMED ×8 · JITTER', a: 'wait', steps: c => { const s = [{ anim: 'wait' }]; for (let i = 0; i < 8; i++) s.push({ tw: { x: c.r(0.2, 0.8) }, dur: 140 }, { fire: { type: 'aimed', proj: 'B' } }, { wait: 160 }); return s; } }
        ] },
        bossExtra: { label: 'GOKI', desc: 'LOCK X ON PLAYER → SHOOT-A VOLLEY ×6 · SHOOT-B HEAVY · ASHURA WARP / DIVE', moves: [
            { l: 'SHOOT-A VOLLEY', sub: 'LOCK X · STRAIGHT ×6', a: 'shootA', steps: c => { const s = [{ tw: { x: c.px }, dur: 400, anim: 'shootA' }]; for (let i = 0; i < 6; i++) s.push({ fire: { type: 'straight' } }, { wait: 150 }); return s; } },
            { l: 'SHOOT-B HEAVY', sub: 'LOCK X · HEAVY B', a: 'shootB', steps: c => [{ tw: { x: c.px }, dur: 400, anim: 'shootB' }, { wait: 500 }, { fire: { type: 'straight', proj: 'B' } }, { wait: 600 }] },
            { l: 'ASHURA DIVE', sub: 'DIVE · WARP TOP', a: 'syngoku', steps: c => [{ anim: 'syngoku' }, { tw: { y: 0.92 }, dur: 1100, ease: 'lin' }, { fade: 0, dur: 60 }, { jump: { x: c.r(0.2, 0.8), y: -0.12 } }, { fade: 1, dur: 60 }, { tw: { y: c.B }, dur: 700 }] },
            { l: 'ASHURA WARP', sub: 'GLIDE REPOSITION', a: 'syngoku', steps: c => [{ anim: 'syngoku' }, { tw: { x: c.r(0.15, 0.85), y: c.r(0.15, 0.35) }, dur: 700 }] }
        ] }
    });
    // A slot the sim has no scripted pattern for (boss5+, a Dezaemon boss whose
    // pattern is data-driven): stand in with the pyramid moves under an honest label.
    const GENERIC = { label: 'GENERIC', desc: 'STAND-IN MOVES — THIS BOSS RUNS A DATA-DRIVEN PATTERN THE LAB CANNOT SCRIPT', moves: PAT.boss0.moves };
    const patternOf = key => PAT[key] || GENERIC;
    const patternLabel = key => patternOf(key).label;

    // ================== THEME TOKENS (synced with the CMG launcher) ==================
    // The lab paints itself off these variables on its own root, so it looks
    // the same whether the host page is the editor or the viewer.
    const THEMES = {
        xbox: { edge: 'rgba(140,255,110,.35)', ink: '#d9ffcb', tglow: 'rgba(124,255,79,.8)', mono: 'rgba(156,255,107,.65)', monodim: 'rgba(220,255,180,.45)', sel: '#F6FF4A', selglow: 'rgba(246,255,74,.55)', dot: '#7CFF4F', rbg: 'rgba(4,24,10,.6)', redge: 'rgba(140,255,110,.28)', rink: '#d6ffc4', rsub: 'rgba(220,255,180,.55)', btnbg: 'radial-gradient(circle at 35% 30%, rgba(40,90,45,.5), rgba(6,30,12,.95) 70%)', btnactive: 'radial-gradient(circle at 35% 30%, rgba(60,120,60,.9), rgba(6,30,12,.95) 70%)', bink: '#9CFF6B', shedge: 'rgba(246,255,74,.65)', ov1: 'rgba(60,54,8,.55)', ov2: 'rgba(24,22,4,.65)', orbA: 'radial-gradient(circle at 35% 30%, #d6ffd0 0%, #6fd06f 25%, #0e6a2b 60%, #04240f 95%)', orbAe: 'rgba(140,255,110,.6)', orbAi: '#04240f', orbB: 'radial-gradient(circle at 35% 30%, #fdf6b0 0%, #cfc23e 30%, #6a6410 65%, #201d02 100%)', orbBe: 'rgba(246,255,74,.5)', orbBi: '#161300', orbY: 'radial-gradient(circle at 35% 30%, #e8e8ff 0%, #8f8fd8 30%, #2c2c6e 65%, #0a0a24 100%)', orbYe: 'rgba(160,160,255,.5)', orbYi: '#0a0a24' },
        nintendo: { edge: 'rgba(213,213,216,.3)', ink: '#e9ecf1', tglow: 'rgba(255,59,73,.7)', mono: 'rgba(139,160,194,.8)', monodim: 'rgba(139,160,194,.55)', sel: '#ff5b66', selglow: 'rgba(228,0,15,.5)', dot: '#ff3b49', rbg: '#0f1622', redge: '#2a3850', rink: '#e9ecf1', rsub: 'rgba(139,160,194,.7)', btnbg: 'radial-gradient(circle at 35% 30%, rgba(49,58,78,.5), rgba(12,16,26,.95) 70%)', btnactive: 'radial-gradient(circle at 35% 30%, rgba(90,20,26,.9), rgba(20,8,12,.95) 70%)', bink: '#e9ecf1', shedge: 'rgba(255,91,102,.7)', ov1: 'rgba(74,3,8,.55)', ov2: 'rgba(36,1,4,.65)', orbA: 'radial-gradient(circle at 35% 30%, #ffd9db 0%, #ff6b76 20%, #e4000f 50%, #4a0308 85%)', orbAe: 'rgba(255,140,148,.75)', orbAi: '#fff', orbB: 'radial-gradient(circle at 35% 30%, #fff 0%, #d5d5d8 25%, #88848b 60%, #2f2f2f 95%)', orbBe: 'rgba(213,213,216,.75)', orbBi: '#e4000f', orbY: 'radial-gradient(circle at 35% 30%, #f2f4f8 0%, #b7bcc6 30%, #565a66 70%, #14161d 100%)', orbYe: 'rgba(213,213,216,.5)', orbYi: '#14161d' }
    };

    const CSS = `
.bl-root { display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; width: 100%; position: relative; font-family: 'Orbitron', system-ui, sans-serif; color: #fff; }
.bl-root button { font-family: inherit; }
.bl-root.empty > :not(.bl-empty) { display: none !important; }
.bl-empty { display: none; flex: 1; align-items: center; justify-content: center; text-align: center; padding: 20px; font-family: 'Share Tech Mono', monospace; font-size: 10px; letter-spacing: .16em; line-height: 1.9; color: var(--rsub); }
.bl-root.empty .bl-empty { display: flex; }
/* boss roster chips — one row: centered when it fits, side-scrolls when it doesn't */
.bl-chips-scroll { flex-shrink: 0; display: flex; overflow-x: auto; scrollbar-width: none; padding: 8px 10px 4px; }
.bl-chips-scroll::-webkit-scrollbar { display: none; }
.bl-chips { display: flex; align-items: center; gap: 8px; margin: 0 auto; }
.bl-chip { position: relative; flex-shrink: 0; height: 44px; padding: 0 18px; border-radius: 22px; cursor: pointer; white-space: nowrap; text-transform: uppercase; letter-spacing: .08em; font-family: 'Orbitron', sans-serif; font-size: 11px; font-weight: 800; transition: all .15s; border: 2px solid var(--redge); color: var(--rink); background: var(--btnbg); box-shadow: none; }
.bl-chip.on { border-color: var(--sel); color: var(--sel); background: var(--btnactive); box-shadow: 0 0 16px var(--selglow); }
.bl-chip-dot { position: absolute; top: 6px; right: 8px; width: 7px; height: 7px; border-radius: 50%; background: var(--sel); box-shadow: 0 0 8px var(--sel); }
.bl-chip-dot.pend { background: #fff; box-shadow: 0 0 8px #fff; }
/* split: live stage (left) · pattern panel (right); stacked below 760px */
.bl-split { flex: 1; min-height: 0; display: flex; flex-direction: row; align-items: stretch; overflow: hidden; }
.bl-root.narrow .bl-split { flex-direction: column; }
.bl-stage-col { min-height: 0; min-width: 0; display: flex; flex-direction: column; flex: 3 1 520px; }
.bl-root.narrow .bl-stage-col { flex: 1.15 1 0%; }
.bl-title-row { flex-shrink: 0; display: flex; align-items: baseline; justify-content: center; flex-wrap: wrap; gap: 2px 14px; padding: 6px 12px 2px; }
.bl-boss-title { font-size: 16px; font-weight: 800; letter-spacing: .2em; color: var(--ink); text-shadow: 0 0 12px var(--tglow); }
.bl-pattern-tag { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .16em; color: var(--rsub); }
.bl-pattern-tag.on { color: var(--sel); }
.bl-stage { flex: 1; min-height: 0; position: relative; overflow: hidden; touch-action: none; cursor: crosshair; }
.bl-layer { position: absolute; inset: 0; pointer-events: none; }
.bl-sprite { position: absolute; transform: translate(-50%, -50%); image-rendering: pixelated; background-repeat: no-repeat; }
.bl-sprite img { display: block; image-rendering: pixelated; }
.bl-boss { animation: blBossIn .4s ease-out; }
.bl-player { position: absolute; transform: translate(-50%, -50%); }
.bl-player .bl-sprite { position: relative; transform: none; }
.bl-player-hint { position: absolute; left: 50%; bottom: -18px; transform: translateX(-50%); font-family: 'Share Tech Mono', monospace; font-size: 8px; letter-spacing: .14em; white-space: nowrap; color: var(--rsub); }
.bl-hit-ring { position: absolute; left: 50%; top: 50%; width: 52px; height: 52px; border: 2px solid var(--sel); border-radius: 50%; animation: blHitRing .3s ease-out forwards; }
.bl-hits, .bl-frame { position: absolute; bottom: 8px; font-size: 10px; color: var(--rsub); font-family: 'Share Tech Mono', monospace; pointer-events: none; }
.bl-hits { left: 12px; } .bl-frame { right: 12px; }
/* move cards */
.bl-moves { flex-shrink: 0; border-top: 1px solid var(--edge); padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 7px; }
.bl-moves-scroll { display: flex; overflow-x: auto; scrollbar-width: none; }
.bl-moves-scroll::-webkit-scrollbar { display: none; }
.bl-move-bar { display: flex; gap: 8px; justify-content: center; margin: 0 auto; flex-wrap: wrap; }
.bl-root.narrow .bl-move-bar { flex-wrap: nowrap; }
.bl-move { display: flex; flex-shrink: 0; flex-direction: column; align-items: center; gap: 3px; padding: 8px 14px; min-height: 46px; border-radius: 10px; cursor: pointer; transition: all .15s; border: 2px solid var(--redge); color: var(--rink); background: rgba(0,0,0,.4); box-shadow: none; }
.bl-move.on { border-color: var(--sel); color: var(--sel); background: var(--btnactive); box-shadow: 0 0 14px var(--selglow); }
.bl-move-title { font-family: 'Orbitron', sans-serif; font-size: 11px; font-weight: 800; letter-spacing: .08em; white-space: nowrap; }
.bl-move-sub { font-family: 'Share Tech Mono', monospace; font-size: 8px; letter-spacing: .08em; opacity: .75; white-space: nowrap; }
.bl-extra-bar { display: none; gap: 6px; justify-content: center; flex-wrap: wrap; }
.bl-extra-bar.has { display: flex; }
.bl-extra { cursor: pointer; font-family: 'Share Tech Mono', monospace; font-size: 8px; letter-spacing: .1em; padding: 5px 9px; border-radius: 6px; background: rgba(0,0,0,.3); text-transform: uppercase; transition: all .15s; border: 1px solid var(--redge); color: var(--rsub); }
.bl-extra.on { border-color: var(--sel); color: var(--sel); }
/* attack pattern panel */
.bl-panel { min-height: 0; min-width: 0; display: flex; flex-direction: column; background: rgba(0,0,0,.28); flex: 1 1 320px; max-width: 420px; border-left: 1px solid var(--edge); }
.bl-root.narrow .bl-panel { flex: 1 1 0%; max-width: none; border-left: none; border-top: 1px solid var(--edge); }
.bl-root.narrow.collapsed .bl-panel { flex: 0 0 auto; }
.bl-panel-head { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px 10px; border-bottom: 1px solid var(--edge); }
.bl-root.narrow .bl-panel-head { cursor: pointer; }
.bl-panel-head-txt { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.bl-panel-title { font-size: 13px; font-weight: 800; letter-spacing: .22em; color: var(--ink); text-shadow: 0 0 14px var(--tglow); white-space: nowrap; }
.bl-panel-sub { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .14em; color: var(--rsub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bl-chevron { display: none; width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; align-items: center; justify-content: center; border: 1px solid var(--redge); background: var(--btnbg); color: var(--rink); font-size: 13px; line-height: 1; }
.bl-root.narrow .bl-chevron { display: flex; }
.bl-list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 12px 4px; scrollbar-width: thin; scrollbar-color: var(--redge) transparent; }
.bl-root.narrow.collapsed .bl-list { display: none; }
.bl-hint { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .14em; color: var(--rsub); margin: 0 2px 10px; line-height: 1.7; }
.bl-preview { border: 1px dashed var(--sel); border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; animation: blFadeIn .15s; }
.bl-preview-label { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .22em; color: var(--sel); margin-bottom: 6px; }
.bl-preview svg { width: 100%; height: 84px; display: block; }
.bl-preview path { fill: none; stroke: var(--sel); stroke-width: 2; stroke-dasharray: 6 5; animation: blDash 1.2s linear infinite; }
.bl-preview circle { fill: var(--sel); }
.bl-preview-desc { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .1em; line-height: 1.7; color: var(--rink); margin-top: 6px; }
.bl-preview-chips { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.bl-chip-old { font-family: 'Share Tech Mono', monospace; font-size: 9px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--redge); color: var(--rsub); text-decoration: line-through; background: rgba(0,0,0,.3); }
.bl-chip-arrow { font-family: 'Share Tech Mono', monospace; font-size: 11px; color: var(--sel); padding: 0 2px; }
.bl-chip-new { font-family: 'Share Tech Mono', monospace; font-size: 9px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--sel); color: var(--sel); background: rgba(0,0,0,.3); box-shadow: 0 0 10px var(--selglow); }
.bl-opt { display: block; width: 100%; text-align: left; border-radius: 12px; margin-bottom: 8px; padding: 10px 12px; transition: all .15s; cursor: pointer; border: 1px solid var(--redge); background: var(--rbg); box-shadow: none; color: inherit; }
.bl-opt.sel { border-color: var(--bink); }
.bl-opt.saved { border-color: var(--shedge); background: linear-gradient(90deg, var(--ov1), var(--ov2)); }
.bl-opt.pend { border-color: var(--sel); background: linear-gradient(90deg, var(--ov1), var(--ov2)); box-shadow: 0 0 18px var(--selglow); }
.bl-opt-main { display: flex; align-items: center; gap: 12px; }
.bl-opt-thumb { width: 40px; height: 40px; flex-shrink: 0; border-radius: 50%; overflow: hidden; display: flex; align-items: center; justify-content: center; border: 2px solid var(--redge); background: var(--btnbg); }
.bl-opt-thumb .bl-sprite { position: static; transform: none; }
.bl-opt-thumb img { width: 28px; height: 28px; object-fit: contain; }
.bl-opt-info { flex: 1; min-width: 0; }
.bl-opt-name { font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--rink); }
.bl-opt-sub { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .06em; margin-top: 2px; color: var(--rsub); }
.bl-opt.saved .bl-opt-name, .bl-opt.saved .bl-opt-sub, .bl-opt.pend .bl-opt-name, .bl-opt.pend .bl-opt-sub { color: var(--sel); }
.bl-radio { width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0; border: 1px solid var(--redge); background: transparent; }
.bl-opt.sel .bl-radio { border-color: var(--sel); background: var(--sel); box-shadow: 0 0 10px var(--selglow); }
.bl-opt-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.bl-opt-chip { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .08em; padding: 3px 8px; border-radius: 6px; background: rgba(0,0,0,.35); border: 1px solid var(--redge); color: var(--rink); }
.bl-opt.pend .bl-opt-chip { border-color: var(--sel); color: var(--sel); }
/* pad footer: A APPLY · B REVERT / BACK · (Y SAVE when the host has a save target) */
.bl-foot { flex-shrink: 0; display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 6px 22px; padding: 12px 16px 14px; border-top: 1px solid var(--edge); }
.bl-foot-btn { display: flex; align-items: center; gap: 9px; background: none; border: none; padding: 0; min-height: 44px; color: var(--rink); font-family: 'Orbitron', sans-serif; font-size: 10px; font-weight: 700; letter-spacing: .16em; cursor: pointer; }
.bl-foot-btn.dim { opacity: .45; }
.bl-orb { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 900; }
.bl-orb-a { background: var(--orbA); border: 1px solid var(--orbAe); color: var(--orbAi); }
.bl-foot-btn.glow .bl-orb-a { box-shadow: 0 0 12px var(--selglow); }
.bl-orb-b { background: var(--orbB); border: 1px solid var(--orbBe); color: var(--orbBi); }
.bl-orb-y { background: var(--orbY); border: 1px solid var(--orbYe); color: var(--orbYi); }
@keyframes blBossIn { from { opacity: 0; transform: translate(-50%,-50%) scale(1.5); filter: brightness(3); } to { opacity: 1; transform: translate(-50%,-50%) scale(1); filter: brightness(1); } }
@keyframes blHitRing { from { opacity: 1; transform: translate(-50%,-50%) scale(.5); } to { opacity: 0; transform: translate(-50%,-50%) scale(1.6); } }
@keyframes blDash { to { stroke-dashoffset: -14; } }
@keyframes blFadeIn { from { opacity: 0; } }
`;

    function ensureStyle() {
        if (document.getElementById('boss-lab-style')) return;
        const s = document.createElement('style');
        s.id = 'boss-lab-style';
        s.textContent = CSS;
        document.head.appendChild(s);
    }
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }
    const SVG_NS = 'http://www.w3.org/2000/svg';
    function svgEl(tag, attrs) {
        const e = document.createElementNS(SVG_NS, tag);
        for (const k in attrs) e.setAttribute(k, attrs[k]);
        return e;
    }
    function stageOf(key) {
        const m = /^boss(\d+)$/.exec(key);
        if (m) return 'STAGE ' + m[1];
        if (key === 'bossExtra') return 'NOT STAGE-BOUND';
        return '';
    }

    class Lab {
        constructor(container, opts) {
            ensureStyle();
            this.container = container;
            this.opts = opts || {};
            this.state = { bossKey: null, pending: {}, previewBoss: null, moveId: 'idle', narrow: false, panelOpen: true, theme: this.opts.theme === 'nintendo' ? 'nintendo' : 'xbox' };
            this.sim = { x: 0.5, y: BASE, alpha: 1, animKey: 'idle', frame: 0, frameT: 0, projs: [], player: { x: 0.5, y: 0.86 }, hits: 0, hitAt: 0, seq: null, stepIdx: 0, loopAt: 0, dragging: false, dragged: false, nowT: 0 };
            this.dom = { boss: null, bossKey: null, bossFrame: null, bossScale: 0, player: null, playerSprite: null, playerHint: null, playerFrame: null, playerScale: 0, ringAt: 0, lastHit: false };
            this.prevT = null;
            this.build();
            this.applyTheme();
            this.cachePlayerFrames();
            this.ro = new ResizeObserver(() => this.measure());
            this.ro.observe(this.root);
            this.measure(true);
            this.render();
            this.startMove('idle');
            this.raf = requestAnimationFrame(t => this.loop(t));
        }

        // ---------- data ----------
        data() { return (this.opts.getBossData && this.opts.getBossData()) || {}; }
        keys() {
            const d = this.data();
            const rest = Object.keys(d).filter(k => !BOSS_ORDER.includes(k) && d[k] && typeof d[k] === 'object').sort();
            return BOSS_ORDER.filter(k => d[k]).concat(rest);
        }
        bossName(k) {
            const rec = this.data()[k];
            if (this.opts.bossName) return this.opts.bossName(k, rec);
            const own = rec && rec.name;
            if (IMPORTED_BOSS_NAME.test(own || '')) return own;
            return NAMES[k] || own || k;
        }
        curKey() { const keys = this.keys(); return keys.includes(this.state.bossKey) ? this.state.bossKey : keys[0]; }
        curBoss() { return this.data()[this.curKey()]; }
        savedPattern(k) { const b = this.data()[k]; return (b && b.attackPattern) || ''; }
        // The pattern a boss actually runs: pending pick, else its saved
        // attackPattern override (the same field the game engine reads), else its own.
        effKey(k) { const p = this.state.pending[k]; const v = p !== undefined ? p : this.savedPattern(k); return v || k; }
        pat(k) { return patternOf(this.effKey(k)); }
        animKeys(b) { return Object.keys((b && b.anim) || {}).filter(a => !a.startsWith('_')); }
        idleKey() { const b = this.curBoss(); return b && b.anim && b.anim.idle ? 'idle' : this.animKeys(b)[0]; }
        mapAnim(key) {
            const b = this.curBoss();
            if (!b || !b.anim) return key;
            if (b.anim[key]) return key;
            return b.anim.attack ? 'attack' : (b.anim.shoot ? 'shoot' : this.animKeys(b)[0]);
        }
        projData(sel) {
            const pick = b => {
                if (!b) return null;
                const d = sel === 'B' ? (b.bulletDataB || b.bulletDataA || b.bulletData) : (b.bulletDataA || b.bulletData);
                return d && d.texture && d.texture.length ? d : null;
            };
            const d = this.data();
            return pick(this.curBoss()) || pick(d[this.effKey(this.curKey())]) || pick(d.bossExtra) || pick(d.boss1);
        }
        pendingCount() {
            return this.keys().filter(k => this.state.pending[k] !== undefined && this.state.pending[k] !== this.savedPattern(k)).length;
        }

        // ---------- frames ----------
        atlas() {
            const a = this.opts.atlas ? this.opts.atlas() : null;
            return a && a.frames && a.url ? a : null;
        }
        resolveFrame(name) {
            if (!name) return null;
            const a = this.atlas();
            if (a) {
                let f = a.frames[name];
                if (!f) {
                    const alt = name.endsWith('.gif') ? name.slice(0, -4) + '.png' : (name.endsWith('.png') ? name.slice(0, -4) + '.gif' : null);
                    if (alt) f = a.frames[alt];
                }
                if (f && f.frame) {
                    const meta = a.meta && a.meta.size;
                    return { crop: f.frame, url: a.url, sw: a.w || (meta && meta.w) || 2048, sh: a.h || (meta && meta.h) || 2048 };
                }
            }
            if (this.opts.frameUrl) {
                const u = this.opts.frameUrl(name);
                if (u) return { img: u };
            }
            return null;
        }
        // Paint a frame into a .bl-sprite at an integer scale: an atlas CSS crop
        // when the frame is in the atlas, an <img> (library / thumbnail art)
        // otherwise. The element ends up at the frame's scaled pixel size.
        paintSprite(div, info, scale) {
            if (info.crop) {
                const f = info.crop;
                const old = div.firstChild; if (old) old.remove();
                div.style.width = (f.w * scale) + 'px';
                div.style.height = (f.h * scale) + 'px';
                div.style.backgroundImage = "url('" + info.url + "')";
                div.style.backgroundSize = (info.sw * scale) + 'px ' + (info.sh * scale) + 'px';
                div.style.backgroundPosition = (-f.x * scale) + 'px ' + (-f.y * scale) + 'px';
                div._nat = { w: f.w, h: f.h };
                return;
            }
            div.style.backgroundImage = 'none';
            let img = div.firstChild;
            if (!img) { img = document.createElement('img'); img.alt = ''; img.draggable = false; div.appendChild(img); }
            const size = () => {
                const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
                if (!w) return;
                div._nat = { w, h };
                img.style.width = (w * scale) + 'px'; img.style.height = (h * scale) + 'px';
                div.style.width = img.style.width; div.style.height = img.style.height;
            };
            if (img.dataset.src !== info.img) { img.dataset.src = info.img; img.onload = size; img.src = info.img; }
            size();
        }
        thumbSprite(name) {
            const info = this.resolveFrame(name);
            const div = el('div', 'bl-sprite');
            if (!info) { div.style.width = div.style.height = '28px'; return div; }
            if (info.crop) { this.paintSprite(div, info, Math.min(28 / info.crop.w, 28 / info.crop.h, 1)); return div; }
            const img = document.createElement('img'); img.alt = ''; img.src = info.img; div.appendChild(img);
            return div;
        }
        cachePlayerFrames() {
            const list = (this.opts.playerFrames && this.opts.playerFrames()) || [];
            this._playerFrames = list.filter(f => this.resolveFrame(f)).slice(0, 2);
        }

        // ---------- theme / layout ----------
        applyTheme() {
            const T = THEMES[this.state.theme] || THEMES.xbox;
            for (const k in T) this.root.style.setProperty('--' + k, T[k]);
        }
        setTheme(t) { this.state.theme = t === 'nintendo' ? 'nintendo' : 'xbox'; this.applyTheme(); }
        measure(first) {
            const L = this.opts.layout || 'auto';
            const w = this.root.clientWidth || window.innerWidth;
            const narrow = L === 'phone' ? true : (L === 'desktop' ? false : w < NARROW_BELOW);
            if (narrow === this.state.narrow && !first) return;
            this.state.narrow = narrow;
            this.root.classList.toggle('narrow', narrow);
            this.root.classList.toggle('collapsed', narrow && !this.state.panelOpen);
            if (!first) this.dom.bossScale = 0;
        }

        // ---------- DOM ----------
        build() {
            const r = this.root = el('div', 'bl-root');
            r.appendChild(el('div', 'bl-empty', 'NO BOSS DATA LOADED · LOAD A GAME DIRECTORY, A SAVED GAME OR A DEZAEMON .SAV FIRST'));
            const chipsScroll = el('div', 'bl-chips-scroll');
            this.chipsEl = el('div', 'bl-chips');
            chipsScroll.appendChild(this.chipsEl);
            r.appendChild(chipsScroll);

            const split = el('div', 'bl-split');
            const stageCol = el('div', 'bl-stage-col');
            const titleRow = el('div', 'bl-title-row');
            this.titleEl = el('div', 'bl-boss-title');
            this.tagEl = el('div', 'bl-pattern-tag');
            titleRow.appendChild(this.titleEl); titleRow.appendChild(this.tagEl);
            stageCol.appendChild(titleRow);
            const stage = this.stageEl = el('div', 'bl-stage');
            this.bossLayer = el('div', 'bl-layer'); this.projLayer = el('div', 'bl-layer'); this.playerLayer = el('div', 'bl-layer');
            this.hitsEl = el('div', 'bl-hits', 'HITS 00'); this.frameEl = el('div', 'bl-frame');
            stage.appendChild(this.bossLayer); stage.appendChild(this.projLayer); stage.appendChild(this.playerLayer);
            stage.appendChild(this.hitsEl); stage.appendChild(this.frameEl);
            stage.addEventListener('pointerdown', e => { this.sim.dragging = true; try { stage.setPointerCapture(e.pointerId); } catch (err) {} this.movePlayer(e); });
            stage.addEventListener('pointermove', e => { if (this.sim.dragging) this.movePlayer(e); });
            stage.addEventListener('pointerup', () => { this.sim.dragging = false; });
            stage.addEventListener('pointercancel', () => { this.sim.dragging = false; });
            stageCol.appendChild(stage);
            const moves = el('div', 'bl-moves');
            const movesScroll = el('div', 'bl-moves-scroll');
            this.moveBar = el('div', 'bl-move-bar');
            movesScroll.appendChild(this.moveBar);
            moves.appendChild(movesScroll);
            this.extraBar = el('div', 'bl-extra-bar');
            moves.appendChild(this.extraBar);
            stageCol.appendChild(moves);
            split.appendChild(stageCol);

            const panel = el('div', 'bl-panel');
            const head = el('div', 'bl-panel-head');
            const headTxt = el('div', 'bl-panel-head-txt');
            headTxt.appendChild(el('div', 'bl-panel-title', 'ATTACK PATTERN'));
            this.panelSub = el('div', 'bl-panel-sub');
            headTxt.appendChild(this.panelSub);
            head.appendChild(headTxt);
            this.chevron = el('div', 'bl-chevron', '▾');
            this.chevron.title = 'Show / hide the pattern list';
            head.appendChild(this.chevron);
            head.addEventListener('click', () => this.togglePanel());
            panel.appendChild(head);
            this.listEl = el('div', 'bl-list');
            panel.appendChild(this.listEl);
            const foot = el('div', 'bl-foot');
            this.applyBtn = el('button', 'bl-foot-btn');
            this.applyBtn.appendChild(el('span', 'bl-orb bl-orb-a', 'A'));
            this.applyLabel = el('span', '', 'APPLY');
            this.applyBtn.appendChild(this.applyLabel);
            this.applyBtn.onclick = () => this.apply();
            foot.appendChild(this.applyBtn);
            this.revertBtn = el('button', 'bl-foot-btn');
            this.revertBtn.appendChild(el('span', 'bl-orb bl-orb-b', 'B'));
            this.revertLabel = el('span', '', 'REVERT');
            this.revertBtn.appendChild(this.revertLabel);
            this.revertBtn.onclick = () => this.revert();
            foot.appendChild(this.revertBtn);
            this.saveBtn = el('button', 'bl-foot-btn');
            this.saveBtn.appendChild(el('span', 'bl-orb bl-orb-y', 'Y'));
            this.saveBtn.appendChild(el('span', '', 'SAVE'));
            this.saveBtn.onclick = () => { if (this.opts.onSave) this.opts.onSave(); };
            foot.appendChild(this.saveBtn);
            panel.appendChild(foot);
            split.appendChild(panel);
            r.appendChild(split);
            this.container.appendChild(r);
        }
        togglePanel() {
            if (!this.state.narrow) return;
            this.state.panelOpen = !this.state.panelOpen;
            this.root.classList.toggle('collapsed', !this.state.panelOpen);
            this.chevron.textContent = this.state.panelOpen ? '▾' : '▴';
            this.dom.bossScale = 0;
        }

        // ---------- render (chrome + panel; the stage paints itself per frame) ----------
        render() { this.renderChrome(); this.renderPanel(); }
        renderChrome() {
            const keys = this.keys();
            this.root.classList.toggle('empty', keys.length === 0);
            if (!keys.length) return;
            const cur = this.curKey(), boss = this.curBoss() || {}, pat = this.pat(cur);
            const saved = this.savedPattern(cur), pv = this.state.pending[cur], isPending = pv !== undefined && pv !== saved;

            this.chipsEl.innerHTML = '';
            keys.forEach(k => {
                const btn = el('button', 'bl-chip' + (k === cur ? ' on' : ''), this.bossName(k));
                const ov = !!this.savedPattern(k), pend = this.state.pending[k] !== undefined && this.state.pending[k] !== this.savedPattern(k);
                if (ov || pend) { const dot = el('span', 'bl-chip-dot' + (pend ? ' pend' : '')); dot.title = pend ? 'Pattern change pending' : 'Pattern overridden'; btn.appendChild(dot); }
                btn.onclick = () => this.selectBoss(k);
                this.chipsEl.appendChild(btn);
            });

            this.titleEl.textContent = this.bossName(cur).toUpperCase();
            this.tagEl.textContent = 'PATTERN · ' + pat.label + (isPending ? ' — PREVIEW · NOT APPLIED' : (saved ? ' — OVERRIDDEN' : ' — DEFAULT'));
            this.tagEl.classList.toggle('on', isPending || !!saved);

            this.moveBar.innerHTML = '';
            const card = (title, sub, active, onclick) => {
                const btn = el('button', 'bl-move' + (active ? ' on' : ''));
                btn.appendChild(el('span', 'bl-move-title', title));
                btn.appendChild(el('span', 'bl-move-sub', sub));
                btn.onclick = onclick;
                this.moveBar.appendChild(btn);
            };
            card('IDLE', (this.idleKey() || '').toUpperCase() + ' ANIM', this.state.moveId === 'idle', () => this.startMove('idle'));
            pat.moves.forEach((m, i) => card(m.l, m.sub + ' · ' + String(this.mapAnim(m.a) || '').toUpperCase(), this.state.moveId === i, () => { this.sim.hits = 0; this.startMove(i); }));
            const used = new Set(['idle', this.idleKey()].concat(pat.moves.map(m => this.mapAnim(m.a))));
            const extras = this.animKeys(boss).filter(a => !used.has(a));
            this.extraBar.innerHTML = '';
            this.extraBar.classList.toggle('has', extras.length > 0);
            extras.forEach(a => {
                const btn = el('button', 'bl-extra' + (this.state.moveId === 'anim:' + a ? ' on' : ''), '+ ' + a);
                btn.onclick = () => this.startMove('anim:' + a);
                this.extraBar.appendChild(btn);
            });
        }
        renderPanel() {
            const keys = this.keys();
            if (!keys.length) return;
            const cur = this.curKey(), boss = this.curBoss() || {};
            const saved = this.savedPattern(cur), pv = this.state.pending[cur], isPending = pv !== undefined && pv !== saved, effective = pv !== undefined ? pv : saved;
            this.panelSub.textContent = cur + ' · ' + (stageOf(cur) ? stageOf(cur) + ' · ' : '') + 'HP ' + (boss.hp || '?');

            const list = this.listEl;
            list.innerHTML = '';
            list.appendChild(el('div', 'bl-hint', 'TAP A PATTERN TO PREVIEW IT LIVE ON ' + this.bossName(cur).toUpperCase() + ' · A APPLIES · B REVERTS'));

            if (this.state.previewBoss === cur && isPending) {
                const newKey = effective || cur, oldKey = saved || cur;
                const np = patternOf(newKey), op = patternOf(oldKey), pvw = PREVIEWS[newKey] || PREVIEWS.boss0;
                const box = el('div', 'bl-preview');
                box.appendChild(el('div', 'bl-preview-label', 'PATTERN PREVIEW · ' + this.bossName(cur).toUpperCase()));
                const svg = svgEl('svg', { viewBox: '0 0 320 110' });
                svg.appendChild(svgEl('path', { d: pvw.d }));
                if (pvw.d2) svg.appendChild(svgEl('path', { d: pvw.d2 }));
                pvw.dots.forEach(p => svg.appendChild(svgEl('circle', { cx: p[0], cy: p[1], r: 5 })));
                box.appendChild(svg);
                box.appendChild(el('div', 'bl-preview-desc', np.label + ': ' + np.desc));
                const chips = el('div', 'bl-preview-chips');
                op.moves.forEach(m => chips.appendChild(el('span', 'bl-chip-old', m.l)));
                chips.appendChild(el('span', 'bl-chip-arrow', '→'));
                np.moves.forEach(m => chips.appendChild(el('span', 'bl-chip-new', m.l)));
                box.appendChild(chips);
                list.appendChild(box);
            }

            const option = (k, isOwn) => {
                const val = isOwn ? '' : k, selected = effective === val, pend = isPending && selected, savedSel = !isPending && selected && !!saved;
                const p = patternOf(k), b = this.data()[k] || {};
                const btn = el('button', 'bl-opt' + (selected ? ' sel' : '') + (pend ? ' pend' : (savedSel ? ' saved' : '')));
                const main = el('div', 'bl-opt-main');
                const thumb = el('div', 'bl-opt-thumb');
                const idle = b.anim && b.anim.idle && b.anim.idle[0];
                if (idle) thumb.appendChild(this.thumbSprite(idle));
                main.appendChild(thumb);
                const info = el('div', 'bl-opt-info');
                info.appendChild(el('div', 'bl-opt-name', isOwn ? this.bossName(k) + ' (DEFAULT)' : this.bossName(k) + ' · ' + p.label));
                info.appendChild(el('div', 'bl-opt-sub', isOwn ? 'OWN PATTERN · ' + p.label + ' · ' + p.moves.length + ' MOVES' : k + ' · HP ' + (b.hp || '?') + ' · ' + p.moves.length + ' MOVES'));
                main.appendChild(info);
                main.appendChild(el('span', 'bl-radio'));
                btn.appendChild(main);
                const chips = el('div', 'bl-opt-chips');
                p.moves.forEach(m => chips.appendChild(el('span', 'bl-opt-chip', m.l)));
                btn.appendChild(chips);
                btn.onclick = () => this.pick(cur, val);
                list.appendChild(btn);
            };
            option(cur, true);
            keys.filter(k => k !== cur).forEach(k => option(k, false));

            this.updateFoot();
        }
        // A APPLY (n) · B REVERT / BACK · Y SAVE — the host can call this alone
        // when only its save target changed (opts.canSave).
        updateFoot() {
            const n = this.pendingCount();
            this.applyLabel.textContent = 'APPLY' + (n ? ' (' + n + ')' : '');
            this.applyBtn.classList.toggle('dim', !n);
            this.applyBtn.classList.toggle('glow', n > 0);
            this.revertLabel.textContent = n ? 'REVERT' : (this.opts.onBack ? 'BACK' : 'CLOSE');
            this.revertBtn.classList.toggle('dim', !n && !this.opts.onBack);
            const canSave = !!this.opts.onSave && (this.opts.canSave ? !!this.opts.canSave() : true);
            this.saveBtn.style.display = canSave ? '' : 'none';
        }

        // ---------- assignment ----------
        selectBoss(k) {
            if (!this.data()[k]) return;
            Object.assign(this.sim, { x: 0.5, y: BASE, alpha: 1, frame: 0, hits: 0 });
            this.state.bossKey = k;
            this.state.previewBoss = null;
            this.sim.animKey = this.idleKey();
            this.startMove('idle');
            this.renderPanel();
        }
        pick(bk, val) {
            const pending = Object.assign({}, this.state.pending), saved = this.savedPattern(bk);
            if (val === saved) delete pending[bk]; else pending[bk] = val;
            this.state.pending = pending;
            this.state.previewBoss = pending[bk] !== undefined ? bk : null;
            this.sim.hits = 0;
            this.startMove(0);
            this.renderPanel();
        }
        apply() {
            const n = this.pendingCount();
            if (!n) return;
            const changes = {};
            this.keys().forEach(k => { if (this.state.pending[k] !== undefined) changes[k] = this.state.pending[k]; });
            if (this.opts.onApply) this.opts.onApply(changes, n);
            else {
                const d = this.data();
                for (const k in changes) { if (!d[k]) continue; if (changes[k]) d[k].attackPattern = changes[k]; else delete d[k].attackPattern; }
            }
            this.state.pending = {};
            this.state.previewBoss = null;
            this.startMove('idle');
            this.renderPanel();
        }
        revert() {
            if (this.pendingCount()) { this.state.pending = {}; this.state.previewBoss = null; this.startMove('idle'); this.renderPanel(); }
            else if (this.opts.onBack) this.opts.onBack();
        }
        // The host changed bossData (a load, an apply from the other page): re-read it.
        refresh() {
            const keys = this.keys();
            if (!keys.includes(this.state.bossKey)) { this.state.bossKey = keys[0] || null; this.state.pending = {}; this.state.previewBoss = null; }
            this.cachePlayerFrames();
            this.dom.bossFrame = null; this.dom.playerFrame = null;
            this.render();
            if (keys.length && !this.sim.seq && this.state.moveId === 'idle') this.startMove('idle');
        }

        // ---------- sim ----------
        clearProjs() { this.sim.projs.forEach(p => { if (p.el) p.el.remove(); }); this.sim.projs = []; }
        startMove(id) {
            const s = this.sim;
            this.state.moveId = id; s.loopAt = 0; s.stepIdx = 0; s.alpha = 1;
            this.clearProjs();
            if (!this.keys().length) { s.seq = null; this.renderChrome(); return; }
            if (id === 'idle') s.seq = [{ tw: { x: 0.5, y: BASE }, dur: 500 }, { anim: this.idleKey() }];
            else if (typeof id === 'string' && id.indexOf('anim:') === 0) s.seq = [{ tw: { x: 0.5, y: BASE }, dur: 400 }, { anim: id.slice(5) }];
            else s.seq = this.buildSeq(id);
            this.renderChrome();
        }
        buildSeq(idx) {
            const move = this.pat(this.curKey()).moves[idx];
            if (!move) return null;
            const c = { px: Math.max(0.05, Math.min(0.95, this.sim.player.x)), B: BASE, r: (a, b) => a + Math.random() * (b - a) };
            const steps = move.steps(c).map(st => { const s2 = Object.assign({}, st); if (s2.anim) s2.anim = this.mapAnim(s2.anim); return s2; });
            return [{ anim: this.mapAnim(move.a) }].concat(steps);
        }
        spawn(p) {
            const e = el('div', 'bl-sprite');
            this.projLayer.appendChild(e);
            p.el = e; p.lastFrame = null;
            this.sim.projs.push(p);
        }
        fire(f) {
            const W = this.stageEl.clientWidth, H = this.stageEl.clientHeight, d = this.projData(f.proj || 'A');
            if (!d) return;
            const frames = d.texture.filter(t => this.resolveFrame(t));
            if (!frames.length) return;
            const sp = (d.speed || 1.5) * 0.16, bx = this.sim.x * W, by = this.sim.y * H + 24, dirs = [];
            if (f.type === 'straight') dirs.push([0, 1]);
            else if (f.type === 'aimed') { const dx = this.sim.player.x * W - bx, dy = this.sim.player.y * H - by, m = Math.hypot(dx, dy) || 1; dirs.push([dx / m, dy / m]); }
            else if (f.type === 'radial') { const n = f.count || 8; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; dirs.push([Math.cos(a), Math.sin(a)]); } }
            else if (f.type === 'spread') { const n = f.count || 3, span = (f.angle || 30) * Math.PI / 180; for (let i = 0; i < n; i++) { const a = Math.PI / 2 + (i - (n - 1) / 2) * span / Math.max(1, n - 1) * 2; dirs.push([Math.cos(a), Math.sin(a)]); } }
            else if (f.type === 'beam') { const a = (f.angle || 90) * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a); for (let i = 0; i < 6; i++) this.spawn({ x: bx + dx * i * 28, y: by + dy * i * 28, vx: dx * sp * 1.4, vy: dy * sp * 1.4, frames, fi: 0, ft: 0 }); }
            dirs.forEach(dir => this.spawn({ x: bx, y: by, vx: dir[0] * sp, vy: dir[1] * sp, frames, fi: 0, ft: 0 }));
            if (this.sim.projs.length > 90) this.sim.projs.splice(0, this.sim.projs.length - 90).forEach(p => { if (p.el) p.el.remove(); });
        }
        loop(t) {
            this.raf = requestAnimationFrame(tt => this.loop(tt));
            if (this.prevT === null) { this.prevT = t; return; }
            const dt = Math.min(50, t - this.prevT); this.prevT = t;
            if (!this.root.isConnected || !this.keys().length) return;
            const s = this.sim;
            s.frameT += dt; if (s.frameT > 167) { s.frameT = 0; s.frame++; }
            if (s.seq) {
                for (let guard = 0; guard < 12 && s.seq; guard++) {
                    if (s.stepIdx >= s.seq.length) {
                        s.seq = null;
                        if (typeof this.state.moveId === 'number') { s.animKey = this.idleKey(); s.frame = 0; s.loopAt = t + REPEAT_DELAY; }
                        break;
                    }
                    const st = s.seq[s.stepIdx];
                    if (st.t0 === undefined) { st.t0 = t; if (st.tw) st.from = { x: s.x, y: s.y }; if (st.fade !== undefined) st.fromA = s.alpha; }
                    const elapsed = t - st.t0;
                    if (st.tw) {
                        if (st.anim && !st.animSet) { st.animSet = true; s.animKey = st.anim; s.frame = 0; }
                        const d = st.dur || 400, p = Math.min(1, elapsed / d);
                        const e = st.ease === 'in' ? p * p * p : (st.ease === 'lin' ? p : 1 - Math.pow(1 - p, 3));
                        if (st.tw.x !== undefined) s.x = st.from.x + (st.tw.x - st.from.x) * e;
                        if (st.tw.y !== undefined) s.y = st.from.y + (st.tw.y - st.from.y) * e;
                        if (p < 1) break;
                        s.stepIdx++; continue;
                    }
                    if (st.fade !== undefined) { const d = st.dur || 100, p = Math.min(1, elapsed / d); s.alpha = st.fromA + (st.fade - st.fromA) * p; if (p < 1) break; s.stepIdx++; continue; }
                    if (st.wait) { if (elapsed < st.wait) break; s.stepIdx++; continue; }
                    if (st.jump) { if (st.jump.x !== undefined) s.x = st.jump.x; if (st.jump.y !== undefined) s.y = st.jump.y; s.stepIdx++; continue; }
                    if (st.anim) { s.animKey = st.anim; s.frame = 0; s.stepIdx++; continue; }
                    if (st.fire) { this.fire(st.fire); s.stepIdx++; continue; }
                    s.stepIdx++;
                }
            } else if (s.loopAt && t >= s.loopAt && typeof this.state.moveId === 'number') {
                s.loopAt = 0; s.stepIdx = 0; s.seq = this.buildSeq(this.state.moveId);
            }
            const W = this.stageEl.clientWidth, H = this.stageEl.clientHeight, pp = this.playerPos(W, H);
            s.projs = s.projs.filter(p => {
                p.x += p.vx * dt; p.y += p.vy * dt; p.ft += dt; if (p.ft > 250) { p.ft = 0; p.fi++; }
                if (Math.hypot(p.x - pp.x, p.y - pp.y) < 22) { s.hits++; s.hitAt = t; p.el.remove(); return false; }
                if (p.x > -50 && p.x < W + 50 && p.y > -50 && p.y < H + 50) return true;
                p.el.remove(); return false;
            });
            s.nowT = t;
            this.renderStage(W, H);
        }
        renderStage(W, H) {
            const s = this.sim, d = this.dom, boss = this.curBoss(), key = this.curKey();
            const frames = (boss && boss.anim && boss.anim[s.animKey]) || [];
            let info = null, fname = null, idx = 0;
            if (frames.length) { idx = s.frame % frames.length; fname = frames[idx]; info = this.resolveFrame(fname); }
            if (info) {
                if (!d.boss || d.bossKey !== key) {
                    if (d.boss) d.boss.remove();
                    d.boss = el('div', 'bl-sprite bl-boss');
                    this.bossLayer.appendChild(d.boss);
                    d.bossKey = key; d.bossFrame = null;
                }
                const natH = info.crop ? info.crop.h : ((d.boss._nat && d.boss._nat.h) || 128);
                const sc = Math.max(1, Math.min(SPRITE_SCALE, Math.floor((H * 0.34) / natH)));
                if (d.bossFrame !== fname || d.bossScale !== sc) { this.paintSprite(d.boss, info, sc); d.bossFrame = fname; d.bossScale = sc; }
                d.boss.style.display = '';
                d.boss.style.left = (s.x * 100) + '%'; d.boss.style.top = (s.y * 100) + '%'; d.boss.style.opacity = s.alpha;
                this.frameEl.textContent = fname + ' [' + (idx + 1) + '/' + frames.length + ']';
            } else {
                this.frameEl.textContent = '';
                if (d.boss) d.boss.style.display = 'none';
            }
            s.projs.forEach(p => {
                const pf = p.frames[p.fi % p.frames.length];
                if (p.lastFrame !== pf) { const inf = this.resolveFrame(pf); if (inf) this.paintSprite(p.el, inf, 2); p.lastFrame = pf; }
                p.el.style.left = p.x + 'px'; p.el.style.top = p.y + 'px';
            });
            const pfs = this._playerFrames || [];
            if (pfs.length) {
                if (!d.player) {
                    d.player = el('div', 'bl-player');
                    d.playerSprite = el('div', 'bl-sprite');
                    d.playerHint = el('div', 'bl-player-hint', '◄ DRAG PLAYER ►');
                    d.player.appendChild(d.playerSprite); d.player.appendChild(d.playerHint);
                    this.playerLayer.appendChild(d.player);
                }
                const pp = this.playerPos(W, H), pf = pfs[s.frame % pfs.length], psc = 2 * pp.ps;
                if (d.playerFrame !== pf || d.playerScale !== psc) { const inf = this.resolveFrame(pf); if (inf) this.paintSprite(d.playerSprite, inf, psc); d.playerFrame = pf; d.playerScale = psc; }
                d.player.style.left = pp.x + 'px'; d.player.style.top = pp.y + 'px';
                d.playerHint.style.display = s.dragged ? 'none' : '';
                const hit = s.nowT && s.nowT - s.hitAt < 300;
                if (hit !== d.lastHit) { d.player.style.filter = hit ? 'brightness(2.5) drop-shadow(0 0 8px var(--sel))' : 'none'; d.lastHit = hit; }
                if (hit && d.ringAt !== s.hitAt) {
                    d.ringAt = s.hitAt;
                    const old = d.player.querySelector('.bl-hit-ring'); if (old) old.remove();
                    d.player.appendChild(el('div', 'bl-hit-ring'));
                } else if (!hit) { const old = d.player.querySelector('.bl-hit-ring'); if (old) old.remove(); }
            }
            this.hitsEl.textContent = 'HITS ' + String(s.hits).padStart(2, '0');
        }
        // The player shrinks on short stages (stacked phone layout) and stays clear of the bottom edge.
        playerPos(W, H) { const ps = H < 300 ? 0.6 : 1; return { x: this.sim.player.x * W, y: Math.min(this.sim.player.y * H, H - 64 * ps - 22), ps }; }
        movePlayer(e) {
            const r = this.stageEl.getBoundingClientRect();
            this.sim.player.x = Math.max(0.03, Math.min(0.97, (e.clientX - r.left) / r.width));
            this.sim.player.y = Math.max(0.55, Math.min(0.94, (e.clientY - r.top) / r.height));
            this.sim.dragged = true;
        }
        destroy() {
            cancelAnimationFrame(this.raf);
            if (this.ro) this.ro.disconnect();
            this.clearProjs();
            this.root.remove();
        }
    }

    window.BossLab = {
        mount: (container, opts) => new Lab(container, opts),
        PAT, PREVIEWS, NAMES, BOSS_ORDER, THEMES, patternOf, patternLabel,
        // The BroadcastChannel both hosts share: the viewer's APPLY reaches an
        // open editor on this origin as { type: 'boss-patterns', gameId, changes }.
        CHANNEL: 'editor-viewer-bridge',
    };
})();
