// music-maker.js — MUSIC: 音まろ, Dezaemon 2's music editor, in place of the
// wave grid. One component, one host:
//
//   static/editor/index.html  mounts it in #music-maker-host from the drawer's
//                             MUSIC row (and the toolbar's note badge) and
//                             hands it the level's `dezaemonBgm`.
//
//   const mm = MusicMaker.mount(container, {
//     engine: () => window.Dezaemon || null,   // the engine bundle (song model + player)
//     getBgm: () => record | null,             // gameData.dezaemonBgm as it stands
//     setBgm: (record) => {},                  // write it back (debounced; flush() forces it)
//     stages: () => [{ id, label }],           // the level's stages, for the SET LIST
//     flash: (msg) => {},                      // the editor's toast
//     onBack: () => {},                        // B / Escape with nothing open: leave MUSIC
//     onSave: () => {},  canSave: () => bool,  // Y SAVE
//     onPlayStage: (stageIndex) => {},         // SET LIST ▶ STAGE: play-test from there
//     theme: 'xbox' | 'nintendo',
//     atlas: () => { frames, url } | null,     // the game's atlas, for the tempo mascot
//     playerFrames: () => [frameKey, …],       // the ship it borrows
//     onStatus: (status) => {},                // the tape, tempo or play state changed
//     keysBlocked: () => bool,                 // another panel is open over MUSIC: leave the keys alone
//     bankBase: '/games/2028-ai/assets/tone-bank/',
//   });
//   mm.open({ slot }); mm.close(); mm.isOpen(); mm.refresh(); mm.flush(); mm.discard();
//   mm.setTheme(t); mm.status() -> { slot, label, bpm, playing }; mm.destroy();
//   window.__musicMakerState() -> { slot, playing, step, undoDepth, bankReady }
//
// What it edits is the cart's own bytes: every tape is a 4,228-byte 音まろ
// slot and every edit goes through the engine's song model (song-edit.js),
// which writes only what the console's editor writes and leaves every other
// byte as it found it — so a song nobody touched goes back to the cart
// unchanged, and one somebody did plays on the Saturn as it plays here. The
// player is the engine's (bgm-player.js), the same notes, timing and Saturn
// samples the game plays.
(function () {
    'use strict';

    const PART_COLORS = ['#ffd84a', '#5ad1ff', '#ff7ab8', '#9dff6a'];
    const RHYTHM_COLOR = '#c9a7ff';
    const ROWS = 25;                       // the focused staff: two octaves and the top C
    const GUTTER = 30;                     // px: note names left of the focused staff
    const LENS = [1, 2, 4, 8, 16];
    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const SCALES = {
        chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        major: [0, 2, 4, 5, 7, 9, 11],
        minor: [0, 2, 3, 5, 7, 8, 10],
        penta: [0, 2, 4, 7, 9],
        blues: [0, 3, 5, 6, 7, 10],
    };
    const ROLES = [
        { i: 0, label: 'TITLE', chip: 'TITLE' },
        { i: 1, label: 'GAME OVER', chip: 'OVER' },
        { i: 2, label: 'STAGE CLEAR', chip: 'CLEAR' },
        { i: 3, label: 'ENDING', chip: 'END' },
    ];
    const SFX_SETS = [{ v: 1, l: 'REAL' }, { v: 2, l: 'COMIC' }, { v: 3, l: 'SF' }];
    const TOOLS = [
        { id: 'place', l: 'PLACE', sub: 'TAP · DRAG HOLDS' },
        { id: 'hold', l: 'HOLD', sub: 'STRETCH A NOTE' },
        { id: 'erase', l: 'ERASE', sub: 'RUB OUT' },
        { id: 'brush', l: 'BRUSH', sub: 'REPAINT SOUND' },
        { id: 'select', l: 'SELECT', sub: 'MEASURES' },
    ];
    // Every input in one table: the keyboard, the pad, touch, and the cheat
    // sheet the ? button shows are all generated from it.
    const ACTIONS = [
        { id: 'play', label: 'PLAY / STOP', keys: ['Space', 'X'], pad: 'X', touch: 'PLAY button' },
        { id: 'place', label: 'PLACE A NOTE', keys: ['A', 'Enter'], pad: 'A', touch: 'tap the staff' },
        { id: 'erase', label: 'ERASE', keys: ['B', 'Delete'], pad: 'B', touch: 'ERASE tool or long-press' },
        { id: 'save', label: 'SAVE', keys: ['Y', 'Ctrl+S'], pad: 'Y', touch: 'SAVE' },
        { id: 'cursor', label: 'MOVE THE CURSOR', keys: ['Arrows'], pad: 'D-pad', touch: 'tap' },
        { id: 'part', label: 'NEXT / PREVIOUS PART', keys: ['Tab', 'Shift+Tab'], pad: 'RB / LB', touch: 'tap a lane' },
        { id: 'inst', label: 'PREVIOUS / NEXT SOUND', keys: ['Q', 'E'], pad: 'LT / RT', touch: 'tap the palette' },
        { id: 'len', label: 'SHORTER / LONGER NOTES', keys: ['[', ']'], pad: 'Select+◀/▶', touch: 'length chips' },
        { id: 'octave', label: 'OCTAVE DOWN / UP', keys: ['PageDown', 'PageUp'], pad: 'Select+▼/▲', touch: '▲ ▼ beside the staff' },
        { id: 'tool', label: 'PICK A TOOL', keys: ['1-5'], pad: 'Select+A', touch: 'tool buttons' },
        { id: 'undo', label: 'UNDO / REDO', keys: ['Ctrl+Z', 'Ctrl+Y'], pad: 'Select+B / Select+Y', touch: '↶ ↷' },
        { id: 'copy', label: 'COPY / PASTE MEASURES', keys: ['Ctrl+C', 'Ctrl+V'], pad: 'Select+X', touch: 'SELECT, then COPY' },
        { id: 'typing', label: 'PLAY THE KEYBOARD (A S D F … ROW)', keys: ['`'], pad: '—', touch: 'KEYS toggle' },
        { id: 'back', label: 'BACK', keys: ['Escape'], pad: 'B (nothing selected)', touch: '‹ BACK' },
    ];
    // The A-row as a piano while musical typing is on: white keys on the home
    // row, black keys above them.
    const TYPING = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16 };

    // ================== THEME TOKENS (synced with the CMG launcher) ==================
    const THEMES = {
        xbox: { edge: 'rgba(140,255,110,.35)', ink: '#d9ffcb', tglow: 'rgba(124,255,79,.8)', sel: '#F6FF4A', selglow: 'rgba(246,255,74,.55)', redge: 'rgba(140,255,110,.28)', rink: '#d6ffc4', rsub: 'rgba(220,255,180,.55)', btnbg: 'radial-gradient(circle at 35% 30%, rgba(40,90,45,.5), rgba(6,30,12,.95) 70%)', btnactive: 'radial-gradient(circle at 35% 30%, rgba(60,120,60,.9), rgba(6,30,12,.95) 70%)', gridline: 'rgba(140,255,110,.14)', lane: 'rgba(4,20,8,.72)', orbA: 'radial-gradient(circle at 35% 30%, #d6ffd0 0%, #6fd06f 25%, #0e6a2b 60%, #04240f 95%)', orbAe: 'rgba(140,255,110,.6)', orbAi: '#04240f', orbB: 'radial-gradient(circle at 35% 30%, #fdf6b0 0%, #cfc23e 30%, #6a6410 65%, #201d02 100%)', orbBe: 'rgba(246,255,74,.5)', orbBi: '#161300' },
        nintendo: { edge: 'rgba(213,213,216,.3)', ink: '#e9ecf1', tglow: 'rgba(255,59,73,.7)', sel: '#ff5b66', selglow: 'rgba(228,0,15,.5)', redge: '#2a3850', rink: '#e9ecf1', rsub: 'rgba(139,160,194,.7)', btnbg: 'radial-gradient(circle at 35% 30%, rgba(49,58,78,.5), rgba(12,16,26,.95) 70%)', btnactive: 'radial-gradient(circle at 35% 30%, rgba(90,20,26,.9), rgba(20,8,12,.95) 70%)', gridline: 'rgba(213,213,216,.12)', lane: 'rgba(10,14,24,.78)', orbA: 'radial-gradient(circle at 35% 30%, #ffd9db 0%, #ff6b76 20%, #e4000f 50%, #4a0308 85%)', orbAe: 'rgba(255,140,148,.75)', orbAi: '#fff', orbB: 'radial-gradient(circle at 35% 30%, #fff 0%, #d5d5d8 25%, #88848b 60%, #2f2f2f 95%)', orbBe: 'rgba(213,213,216,.75)', orbBi: '#e4000f' }
    };

    // The mode's own share of the page: while MUSIC is open it stands in for
    // the rail, the grid and the pad footer, behind the toolbar's status line
    // (the same set the pixel editor hides — tests/music_maker_test.ts).
    const MODE_CSS = `
body.music-maker #toolbar .grid-only { display: none !important; }
body.music-maker #stage-rail, body.music-maker #grid-area, body.music-maker #pad-footer, body.music-maker #nes-stripe, body.music-maker #boss-lab-host, body.music-maker #pixel-editor-host { display: none !important; }
body.music-maker #lab-status { display: flex; }
#music-maker-host { display: none; flex: 1; min-height: 0; position: relative; }
body.music-maker #music-maker-host { display: flex; flex-direction: column; }
`;

    const CSS = MODE_CSS + `
.mm-root { display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; width: 100%; position: relative; font-family: 'Orbitron', system-ui, sans-serif; color: #fff; user-select: none; -webkit-user-select: none; }
.mm-root button { font-family: inherit; }
.mm-mono { font-family: 'Share Tech Mono', monospace; }
.mm-loading { flex: 1; display: flex; align-items: center; justify-content: center; font-family: 'Share Tech Mono', monospace; font-size: 10px; letter-spacing: .18em; color: var(--rsub); }
/* head: title · bank pill · view tabs */
.mm-head { flex-shrink: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 12px 6px; border-bottom: 1px solid var(--edge); }
.mm-title { font-size: 13px; font-weight: 800; letter-spacing: .2em; color: var(--ink); text-shadow: 0 0 12px var(--tglow); white-space: nowrap; }
.mm-title small { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .14em; color: var(--rsub); margin-left: 8px; font-weight: 400; text-shadow: none; }
.mm-pill { font-family: 'Share Tech Mono', monospace; font-size: 8px; letter-spacing: .16em; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--redge); color: var(--rsub); white-space: nowrap; }
.mm-pill.ok { color: var(--sel); border-color: var(--sel); }
.mm-pill.busy { animation: mm-blink 1s steps(2) infinite; }
@keyframes mm-blink { 50% { opacity: .35; } }
.mm-spacer { flex: 1; }
.mm-seg { display: flex; border: 1px solid var(--redge); border-radius: 9px; overflow: hidden; }
.mm-seg button { background: rgba(0,0,0,.3); border: none; color: var(--rsub); font-size: 9px; font-weight: 800; letter-spacing: .14em; padding: 0 12px; min-height: 30px; cursor: pointer; }
.mm-seg button.on { background: var(--btnactive); color: var(--sel); }
.mm-btn { cursor: pointer; font-size: 9px; font-weight: 800; letter-spacing: .12em; padding: 0 11px; min-height: 32px; border-radius: 9px; background: var(--btnbg); border: 1px solid var(--redge); color: var(--rink); white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
.mm-btn:disabled { opacity: .35; cursor: default; }
.mm-btn.on { border-color: var(--sel); color: var(--sel); background: var(--btnactive); box-shadow: 0 0 12px var(--selglow); }
.mm-btn.big { min-height: 38px; font-size: 11px; padding: 0 16px; }
.mm-btn canvas { width: 16px; height: 16px; image-rendering: pixelated; }
/* the shelf: 24 tapes */
.mm-shelf { flex-shrink: 0; display: flex; gap: 8px; overflow-x: auto; padding: 8px 12px; border-bottom: 1px solid var(--edge); scrollbar-width: thin; scrollbar-color: var(--redge) transparent; }
.mm-tape { position: relative; flex-shrink: 0; width: 112px; min-height: 66px; padding: 6px 7px 5px; border-radius: 9px; cursor: pointer; border: 1px solid var(--redge); background: var(--btnbg); color: var(--rink); text-align: left; display: flex; flex-direction: column; gap: 3px; }
.mm-tape.on { border-color: var(--sel); color: var(--sel); background: var(--btnactive); box-shadow: 0 0 14px var(--selglow); }
.mm-tape.empty { opacity: .55; }
.mm-tape-top { display: flex; align-items: center; gap: 5px; font-size: 9px; font-weight: 800; letter-spacing: .1em; }
.mm-tape-top canvas { width: 16px; height: 16px; image-rendering: pixelated; }
.mm-tape-name { font-family: 'Share Tech Mono', monospace; font-size: 8px; letter-spacing: .08em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .85; }
.mm-tape-map { width: 96px; height: 10px; image-rendering: pixelated; display: block; }
.mm-chips { display: flex; flex-wrap: wrap; gap: 3px; }
.mm-chip { font-family: 'Share Tech Mono', monospace; font-size: 7px; letter-spacing: .06em; padding: 1px 4px; border-radius: 4px; background: rgba(0,0,0,.45); color: var(--sel); }
.mm-chip.odd { color: #ffb36b; }
/* compose */
.mm-body { flex: 1; min-height: 0; display: flex; overflow: hidden; }
.mm-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.mm-songbar { flex-shrink: 0; display: flex; align-items: center; gap: 8px 14px; flex-wrap: wrap; padding: 7px 12px; border-bottom: 1px solid var(--edge); }
.mm-group { display: flex; align-items: center; gap: 6px; }
.mm-label { font-family: 'Share Tech Mono', monospace; font-size: 8px; letter-spacing: .2em; color: var(--rsub); }
.mm-value { font-size: 12px; font-weight: 800; letter-spacing: .08em; color: var(--ink); min-width: 52px; text-align: center; }
.mm-step { width: 28px; min-height: 28px; padding: 0; justify-content: center; }
.mm-mascot { width: 72px; height: 24px; image-rendering: pixelated; border-radius: 6px; background: rgba(0,0,0,.35); box-shadow: inset 0 0 0 1px var(--redge); }
.mm-pips { display: flex; gap: 3px; }
.mm-pip { width: 12px; height: 18px; border-radius: 3px; border: 1px solid var(--redge); background: rgba(0,0,0,.35); cursor: pointer; padding: 0; }
.mm-pip.on { background: var(--sel); border-color: var(--sel); box-shadow: 0 0 6px var(--selglow); }
.mm-overview { flex-shrink: 0; height: 34px; margin: 6px 12px 2px; display: block; cursor: pointer; touch-action: none; }
.mm-lanes { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 12px 8px; display: flex; flex-direction: column; gap: 6px; scrollbar-width: thin; scrollbar-color: var(--redge) transparent; }
.mm-lane { display: flex; align-items: stretch; gap: 8px; flex-shrink: 0; }
.mm-lane-head { flex: 0 0 116px; display: flex; flex-direction: column; justify-content: center; gap: 4px; padding: 6px 8px; border-radius: 9px; border: 1px solid var(--redge); background: rgba(0,0,0,.3); cursor: pointer; }
.mm-lane.focus .mm-lane-head { border-color: var(--pc); box-shadow: 0 0 12px color-mix(in srgb, var(--pc) 50%, transparent); }
.mm-lane-title { display: flex; align-items: center; gap: 6px; font-size: 9px; font-weight: 800; letter-spacing: .12em; color: var(--pc); }
.mm-lane-title i { width: 8px; height: 8px; border-radius: 50%; background: var(--pc); box-shadow: 0 0 8px var(--pc); display: block; }
.mm-lane-inst { display: flex; align-items: center; gap: 5px; font-family: 'Share Tech Mono', monospace; font-size: 8px; letter-spacing: .06em; color: var(--rink); }
.mm-lane-inst canvas { width: 16px; height: 16px; image-rendering: pixelated; }
.mm-ms { display: flex; gap: 4px; }
.mm-ms button { min-height: 22px; min-width: 26px; padding: 0 6px; font-size: 8px; }
.mm-oct { display: flex; gap: 4px; }
.mm-lane canvas.mm-staff { flex: 1; min-width: 0; display: block; border-radius: 8px; touch-action: none; cursor: crosshair; }
.mm-lane.compact canvas.mm-staff { height: 50px; cursor: pointer; }
.mm-lane.focus canvas.mm-staff { height: 300px; }
.mm-lane.rhythm canvas.mm-staff { height: 52px; cursor: pointer; }
/* side panel */
.mm-side { flex: 0 0 300px; min-height: 0; overflow-y: auto; border-left: 1px solid var(--edge); background: rgba(0,0,0,.28); padding: 10px 12px; display: flex; flex-direction: column; gap: 12px; scrollbar-width: thin; scrollbar-color: var(--redge) transparent; }
.mm-sec { display: flex; flex-direction: column; gap: 7px; }
.mm-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mm-tools { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.mm-tool { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 2px; min-height: 42px; border-radius: 9px; cursor: pointer; border: 1px solid var(--redge); color: var(--rink); background: var(--btnbg); }
.mm-tool.on { border-color: var(--sel); color: var(--sel); background: var(--btnactive); box-shadow: 0 0 12px var(--selglow); }
.mm-tool b { font-size: 9px; letter-spacing: .1em; }
.mm-tool small { font-family: 'Share Tech Mono', monospace; font-size: 7px; letter-spacing: .06em; opacity: .7; }
.mm-row { display: flex; flex-wrap: wrap; gap: 5px; }
.mm-row .mm-btn { min-height: 28px; padding: 0 9px; }
.mm-fams { display: flex; flex-wrap: wrap; gap: 4px; }
.mm-fam { display: flex; align-items: center; gap: 4px; padding: 3px 7px 3px 4px; min-height: 26px; border-radius: 8px; border: 1px solid var(--redge); background: rgba(0,0,0,.3); color: var(--rsub); cursor: pointer; font-size: 8px; font-weight: 800; letter-spacing: .1em; }
.mm-fam.on { color: var(--sel); border-color: var(--sel); }
.mm-fam canvas { width: 16px; height: 16px; image-rendering: pixelated; }
.mm-insts { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 5px; }
.mm-inst { display: flex; align-items: center; gap: 5px; padding: 4px 6px; min-height: 36px; border-radius: 8px; border: 1px solid var(--redge); background: var(--btnbg); color: var(--rink); cursor: pointer; text-align: left; }
.mm-inst.on { border-color: var(--pc, var(--sel)); box-shadow: 0 0 10px color-mix(in srgb, var(--pc, var(--sel)) 55%, transparent); }
.mm-inst canvas { width: 24px; height: 24px; image-rendering: pixelated; flex-shrink: 0; }
.mm-inst span { font-family: 'Share Tech Mono', monospace; font-size: 8px; letter-spacing: .04em; line-height: 1.25; }
.mm-note { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .08em; line-height: 1.6; color: var(--rsub); }
/* sheets inside the root */
.mm-sheet { position: absolute; inset: 0; z-index: 20; display: flex; align-items: flex-end; justify-content: center; background: rgba(0,0,0,.55); }
.mm-sheet[hidden] { display: none; }
.mm-sheet-panel { width: min(720px, 100%); max-height: 86%; overflow-y: auto; background: rgba(6,12,10,.97); border: 1px solid var(--edge); border-bottom: none; border-radius: 18px 18px 0 0; padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 -10px 40px rgba(0,0,0,.6); }
.mm-sheet-title { font-size: 13px; font-weight: 800; letter-spacing: .24em; color: var(--ink); text-shadow: 0 0 10px var(--tglow); }
.mm-band-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; }
.mm-band { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 7px 4px; border-radius: 10px; border: 1px solid var(--redge); background: var(--btnbg); color: var(--rink); cursor: pointer; }
.mm-band.on { border-color: var(--sel); color: var(--sel); box-shadow: 0 0 12px var(--selglow); }
.mm-band canvas { width: 32px; height: 32px; image-rendering: pixelated; }
.mm-band b { font-size: 9px; letter-spacing: .1em; }
.mm-band small { font-family: 'Share Tech Mono', monospace; font-size: 7px; letter-spacing: .06em; opacity: .75; }
.mm-setlist { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 14px 16px; display: flex; flex-direction: column; gap: 6px; }
.mm-set-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 6px 10px; border-radius: 9px; border: 1px solid var(--redge); background: rgba(0,0,0,.3); }
.mm-set-row .mm-label { min-width: 120px; }
.mm-set-row select, .mm-sheet select, .mm-sheet input { font-family: 'Share Tech Mono', monospace; font-size: 10px; letter-spacing: .06em; background: rgba(0,0,0,.5); color: var(--rink); border: 1px solid var(--redge); border-radius: 7px; min-height: 30px; padding: 0 8px; }
.mm-cheats { display: grid; grid-template-columns: auto auto auto auto; gap: 4px 14px; font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .06em; color: var(--rink); }
.mm-cheats b { color: var(--sel); font-weight: 400; }
.mm-coach { position: absolute; z-index: 15; max-width: 260px; padding: 10px 12px; border-radius: 12px; background: rgba(0,0,0,.88); border: 1px solid var(--sel); color: var(--rink); font-family: 'Share Tech Mono', monospace; font-size: 10px; letter-spacing: .06em; line-height: 1.55; box-shadow: 0 0 16px var(--selglow); }
.mm-coach button { margin-top: 8px; }
/* pad footer */
.mm-foot { flex-shrink: 0; display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 6px 20px; padding: 9px 16px 11px; border-top: 1px solid var(--edge); }
.mm-foot-btn { display: flex; align-items: center; gap: 8px; background: none; border: none; padding: 0; min-height: 40px; color: var(--rink); font-size: 10px; font-weight: 700; letter-spacing: .16em; cursor: pointer; }
.mm-orb { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 900; }
.mm-orb-a { background: var(--orbA); border: 1px solid var(--orbAe); color: var(--orbAi); }
.mm-orb-b { background: var(--orbB); border: 1px solid var(--orbBe); color: var(--orbBi); }
.mm-orb-x { background: radial-gradient(circle at 35% 30%, #cfe8ff 0%, #3c8ddf 40%, #0b2f5c 90%); border: 1px solid #7ab8ff; color: #fff; }
.mm-orb-y { background: radial-gradient(circle at 35% 30%, #fff6c9 0%, #e8c23c 40%, #5c4508 90%); border: 1px solid #ffe07a; color: #1a1200; }
/* A phone: one scrolling column — song bar, lanes at full height, then tools */
.mm-root.narrow .mm-body { flex-direction: column; overflow-y: auto; }
.mm-root.narrow .mm-main { flex: 0 0 auto; }
.mm-root.narrow .mm-lanes { flex: 0 0 auto; overflow: visible; }
.mm-root.narrow .mm-side { flex: 0 0 auto; overflow: visible; border-left: none; border-top: 1px solid var(--edge); }
.mm-root.narrow .mm-lane-head { flex-basis: 84px; }
.mm-root.narrow .mm-lane.focus canvas.mm-staff { height: 240px; }
`;

    function ensureStyle() {
        if (document.getElementById('music-maker-style')) return;
        const s = document.createElement('style');
        s.id = 'music-maker-style';
        s.textContent = CSS;
        document.head.appendChild(s);
    }
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }
    function btn(cls, text, onclick, title) {
        const b = el('button', cls, text);
        b.type = 'button';
        if (onclick) b.onclick = onclick;
        if (title) b.title = title;
        return b;
    }
    const pad2 = (n) => String(n).padStart(2, '0');
    const tapeLabel = (slot) => 'SS-' + pad2(slot + 1);
    /** MIDI = pitch byte + 35: pitch 25 is middle C. */
    function noteName(pitch) {
        const midi = pitch + 35;
        return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
    }
    function pitchClass(pitch) { return (pitch + 35) % 12; }
    /** The six speeds the tempo mascot runs at, slowest first. */
    function tempoTier(tempoIndex) { return Math.min(5, Math.floor(tempoIndex / 6)); }
    const TIER_NAMES = ['STROLL', 'WALK', 'JOG', 'RUN', 'DASH', 'BOOST'];
    function canvasIcon(src, size) {
        const cv = el('canvas');
        cv.width = 16; cv.height = 16;
        cv.getContext('2d').drawImage(src, 0, 0);
        if (size) { cv.style.width = size + 'px'; cv.style.height = size + 'px'; }
        return cv;
    }
    function shallowEq(a, b) {
        if (a === b) return true;
        if (!a || !b || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    class MusicMaker {
        constructor(host, api) {
            ensureStyle();
            this.api = api || {};
            this.host = host;
            this.root = el('div', 'mm-root');
            host.appendChild(this.root);
            this.setTheme(this.api.theme || 'xbox');
            this.isOpenFlag = false;
            this.view = 'compose';
            this.slot = 0;
            this.focusPart = 0;
            this.firstMeasure = 0;
            this.tool = 'place';
            this.len = 2;
            this.inst = [13, 18, 23, 41];
            this.base = [13, 1, 13, 13];        // bottom pitch of each part's staff window
            this.scale = 'chromatic';
            this.family = null;
            this.cursor = { step: 0, pitch: 25 };
            this.selection = null;              // { m0, m1 }
            this.loopRegion = false;
            this.follow = true;
            this.typing = false;
            this.undo = [];
            this.redo = [];
            this.dirty = false;
            this.writeTimer = null;
            this.toneBank = undefined;          // undefined = not asked, null = none, object = loaded
            this.player = null;
            this.actx = null;
            this.raf = 0;
            this.drag = null;
            this.sampleSongs = null;
            this.onKey = this.onKey.bind(this);
            this.onDocUp = () => { if (this.drag) setTimeout(() => { if (this.drag) this.staffUp(); }, 0); };
            this.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.layout()) : null;
            if (this.ro) this.ro.observe(this.root);
            window.__musicMakerState = () => ({
                slot: this.slot,
                playing: !!(this.player && this.player.playing()),
                step: this.player && this.player.position() ? this.player.position().step : null,
                undoDepth: this.undo.length,
                bankReady: !!this.toneBank,
                open: this.isOpenFlag,
            });
        }

        get E() { return this.api.engine ? this.api.engine() : window.Dezaemon || null; }

        // ---------- open / close ----------
        open(opts = {}) {
            this.isOpenFlag = true;
            document.addEventListener('keydown', this.onKey, true);
            // A release outside the canvas (or after it was rebuilt) still ends a drag.
            document.addEventListener('pointerup', this.onDocUp, true);
            const E = this.E;
            if (!E || !E.bankFromBgm) {
                this.root.textContent = '';
                this.root.appendChild(el('div', 'mm-loading', 'LOADING THE ENGINE…'));
                const go = () => { if (this.isOpenFlag) this.open(opts); };
                window.addEventListener('dezaemon-ready', go, { once: true });
                return;
            }
            this.load();
            if (Number.isInteger(opts.slot)) this.slot = opts.slot;
            this.build();
            this.loadBank();
            this.maybeCoach();
        }
        close() {
            if (!this.isOpenFlag) return;
            this.stop();
            this.flush();
            this.isOpenFlag = false;
            document.removeEventListener('keydown', this.onKey, true);
            document.removeEventListener('pointerup', this.onDocUp, true);
        }
        isOpen() { return this.isOpenFlag; }
        // The record changed under us (a load, an import): take it up.
        refresh() {
            if (!this.isOpenFlag || this.dirty) return;
            this.load();
            this.render();
        }
        // Drop what has not been written and forget the open record — the
        // level it belonged to is gone.
        discard() {
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
            this.dirty = false;
            this.stop();
            this.bank = null;
            this.undo = [];
            this.redo = [];
            this.lanes = null;
            this.root.textContent = '';
        }
        flush() {
            if (!this.dirty || !this.bank) return;
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
            this.writeNow();
        }
        status() {
            const b = this.bytes();
            return {
                slot: this.slot,
                label: tapeLabel(this.slot) + (this.bank && this.bank.names && this.bank.names[this.slot] ? ' ' + this.bank.names[this.slot] : ''),
                bpm: b ? Math.round(this.E.headerOf(b).bpm || 0) : 0,
                playing: !!(this.player && this.player.playing()),
            };
        }
        setTheme(t) {
            const tok = THEMES[t] || THEMES.xbox;
            for (const k in tok) this.root.style.setProperty('--' + k, tok[k]);
        }
        destroy() {
            this.close();
            if (this.ro) this.ro.disconnect();
            if (this.actx) try { this.actx.close(); } catch (e) {}
            this.root.remove();
        }

        load() {
            const E = this.E;
            const rec = this.api.getBgm ? this.api.getBgm() : null;
            this.previous = rec || null;
            this.bank = E.bankFromBgm(rec);
            this.stageCount = Math.min(10, Math.max(this.bank.stageCount, (this.api.stages ? this.api.stages() : []).length));
            this.opened = this.bank.slots.map((s) => s.slice());
            this.undo = [];
            this.redo = [];
            this.dirty = false;
            this.fams = MusicMakerIcons.families(E);
            if (!rec) {
                // A web level with no soundtrack yet: every table entry points
                // at the last tape, which stays blank, so nothing changes in
                // the game until a tape is put on a row.
                this.bank.table = new Array(24).fill(23);
                this.bank.sfxSet = 1;
            }
            const firstUsed = this.bank.slots.findIndex((s) => !E.isEmptySong(s));
            this.slot = firstUsed >= 0 ? firstUsed : 0;
            this.fitStaff();
        }
        bytes() { return this.bank ? this.bank.slots[this.slot] : null; }

        // ---------- edits ----------
        commit(bytes, label) {
            const cur = this.bytes();
            if (!bytes || shallowEq(bytes, cur)) return false;
            this.undo.push({ slot: this.slot, bytes: cur });
            if (this.undo.length > 300) this.undo.shift();
            this.redo = [];
            this.bank.slots[this.slot] = bytes;
            this.changed(label);
            return true;
        }
        commitMeta(mutate, label) {
            this.undo.push({ meta: this.meta() });
            this.redo = [];
            mutate();
            this.changed(label);
        }
        meta() {
            return { table: this.bank.table.slice(), sfxSet: this.bank.sfxSet, names: Object.assign({}, this.bank.names || {}) };
        }
        restore(entry) {
            if (entry.meta) {
                const now = { meta: this.meta() };
                this.bank.table = entry.meta.table;
                this.bank.sfxSet = entry.meta.sfxSet;
                this.bank.names = entry.meta.names;
                return now;
            }
            const now = { slot: entry.slot, bytes: this.bank.slots[entry.slot] };
            this.bank.slots[entry.slot] = entry.bytes;
            this.slot = entry.slot;
            return now;
        }
        doUndo() {
            this.cancelDrag();
            const e = this.undo.pop();
            if (!e) return;
            this.redo.push(this.restore(e));
            this.changed('UNDO');
        }
        doRedo() {
            this.cancelDrag();
            const e = this.redo.pop();
            if (!e) return;
            this.undo.push(this.restore(e));
            this.changed('REDO');
        }
        changed(label) {
            this.dirty = true;
            clearTimeout(this.writeTimer);
            this.writeTimer = setTimeout(() => this.writeNow(), 150);
            if (this.player && this.player.playing()) this.player.load(this.bytes());
            if (label && this.api.flash && label !== 'quiet') this.api.flash(label);
            this.render();
            if (this.api.onStatus) this.api.onStatus(this.status());
        }
        writeNow() {
            this.writeTimer = null;
            if (!this.bank) return;
            const rec = this.E.bgmFromBank(this.bank, { stageCount: this.stageCount, previous: this.previous, edited: Date.now() });
            this.previous = rec;
            this.dirty = false;
            if (this.api.setBgm) this.api.setBgm(rec);
        }
        tryEdit(fn, label) {
            try {
                return this.commit(fn(this.bytes()), label);
            } catch (e) {
                if (this.api.flash) this.api.flash(String(e.message || e).replace(/^song-edit: /, '').toUpperCase());
                return false;
            }
        }

        // ---------- audio ----------
        ensureAudio() {
            if (!this.actx) {
                const Ctor = window.AudioContext || window.webkitAudioContext;
                if (!Ctor) return null;
                this.actx = new Ctor();
                this.player = this.E.createBgmPlayer(this.actx, { bank: this.toneBank || null });
            }
            if (this.actx.state === 'suspended') this.actx.resume();
            return this.player;
        }
        loadBank() {
            if (this.toneBank !== undefined) return;
            this.toneBank = undefined;
            const E = this.E;
            const base = this.api.bankBase || E.TONE_BANK_PATH;
            this.bankState = 'busy';
            E.loadToneBank([base]).then((bank) => {
                this.toneBank = bank;
                this.bankState = bank ? 'ok' : 'none';
                if (this.player) this.player.setBank(bank);
                this.renderHead();
            });
        }
        play() {
            if (!this.bank) return;
            const p = this.ensureAudio();
            if (!p) return;
            p.load(this.bytes());
            const region = this.loopRegion && this.selection ? [this.selection.m0, this.selection.m1] : null;
            const from = region ? region[0] * 16 : Math.floor(this.cursor.step / 16) * 16;
            p.play({ fromStep: from, region });
            this.tick();
            this.renderSongbar();
        }
        stop() {
            if (this.player) this.player.stop();
            cancelAnimationFrame(this.raf);
            this.raf = 0;
            if (this.root.isConnected && this.bank) { this.renderSongbar(); this.drawAll(); }
        }
        togglePlay() { if (this.player && this.player.playing()) this.stop(); else this.play(); }
        tick() {
            cancelAnimationFrame(this.raf);
            const loop = () => {
                if (!this.player || !this.player.playing()) return;
                const pos = this.player.position();
                if (pos && this.follow) {
                    const m = Math.floor(pos.step / 16);
                    const n = this.visibleMeasures();
                    if (m < this.firstMeasure || m >= this.firstMeasure + n) this.firstMeasure = Math.max(0, Math.min(32 - n, m - (m % n)));
                }
                this.drawAll();
                this.drawMascot();
                this.raf = requestAnimationFrame(loop);
            };
            this.raf = requestAnimationFrame(loop);
        }
        audition(inst, pitch, part = this.focusPart) {
            if (!this.bank) return;
            const p = this.ensureAudio();
            if (p) p.audition(inst, pitch, { part, len: Math.max(2, this.len), stepSeconds: this.E.headerOf(this.bytes()).bpm ? 60 / (this.E.headerOf(this.bytes()).bpm * 4) : 0.1 });
        }

        // ---------- staff geometry ----------
        visibleMeasures() {
            const w = this.root.clientWidth || 1200;
            return w >= 1180 ? 4 : w >= 720 ? 2 : 1;
        }
        fitStaff() {
            const b = this.bytes();
            if (!b) return;
            for (let p = 0; p < 4; p++) {
                const notes = this.E.partNotes(b, p);
                if (!notes.length) continue;
                // Centre the window on where the part spends its time (the
                // median note), not on the middle of its extremes.
                const sorted = notes.map((n) => n.pitch).sort((x, y) => x - y);
                const mid = sorted[Math.floor(sorted.length / 2)];
                this.base[p] = Math.max(1, Math.min(59 - (ROWS - 1), mid - 12));
            }
            const first = this.E.partNotes(b, this.focusPart)[0];
            if (first) this.cursor = { step: first.step, pitch: first.pitch };
        }
        snapPitch(pitch) {
            const sc = SCALES[this.scale];
            if (!sc || sc.length === 12) return pitch;
            for (let d = 0; d < 12; d++) {
                for (const s of [pitch - d, pitch + d]) if (s >= 1 && s <= 59 && sc.includes(pitchClass(s))) return s;
            }
            return pitch;
        }

        // ---------- DOM ----------
        build() {
            this.root.textContent = '';
            this.head = el('div', 'mm-head');
            this.shelf = el('div', 'mm-shelf');
            this.bodyEl = el('div', 'mm-body');
            this.foot = el('div', 'mm-foot');
            this.sheet = el('div', 'mm-sheet');
            this.sheet.hidden = true;
            this.sheet.onclick = (e) => { if (e.target === this.sheet) this.closeSheet(); };
            this.root.append(this.head, this.shelf, this.bodyEl, this.foot, this.sheet);
            this.layout();
            this.render();
        }
        layout() {
            if (!this.root) return;
            this.root.classList.toggle('narrow', (this.root.clientWidth || 1200) < 760);
            const n = this.visibleMeasures();
            this.firstMeasure = Math.max(0, Math.min(32 - n, this.firstMeasure - (this.firstMeasure % n)));
            if (this.lanes) this.drawAll();
        }
        render() {
            if (!this.isOpenFlag || !this.bank || !this.head) return;
            this.renderHead();
            this.renderShelf();
            this.bodyEl.textContent = '';
            if (this.view === 'setlist') {
                this.lanes = null;
                this.renderSetlist();
            } else {
                this.renderCompose();
            }
            this.renderFoot();
        }
        renderHead() {
            if (!this.head) return;
            this.head.textContent = '';
            const t = el('div', 'mm-title', 'MUSIC');
            t.appendChild(el('small', null, '音まろ · ' + tapeLabel(this.slot)));
            this.head.appendChild(t);
            const pill = el('span', 'mm-pill');
            if (this.toneBank) { pill.textContent = 'SATURN SAMPLES'; pill.classList.add('ok'); }
            else if (this.bankState === 'busy') { pill.textContent = 'LOADING SATURN SOUNDS'; pill.classList.add('busy'); }
            else pill.textContent = 'SYNTH VOICES · NO BANK';
            pill.title = this.toneBank ? 'Notes play on the Saturn tone bank' : 'The tone bank is not here; notes play on its analysed voices';
            this.head.appendChild(pill);
            this.head.appendChild(el('span', 'mm-spacer'));
            const seg = el('div', 'mm-seg');
            for (const [v, l] of [['compose', 'COMPOSE'], ['setlist', 'SET LIST']]) {
                const b = btn(this.view === v ? 'on' : '', l, () => { this.view = v; this.render(); });
                seg.appendChild(b);
            }
            this.head.appendChild(seg);
            this.head.appendChild(btn('mm-btn', '?', () => this.openCheats(), 'Every control'));
        }
        renderShelf() {
            const E = this.E;
            this.shelf.textContent = '';
            const roles = this.rolesBySlot();
            for (let s = 0; s < 24; s++) {
                const bytes = this.bank.slots[s];
                const empty = E.isEmptySong(bytes);
                const tape = btn('mm-tape' + (s === this.slot ? ' on' : '') + (empty ? ' empty' : ''), '', () => this.selectSlot(s));
                const top = el('div', 'mm-tape-top');
                top.appendChild(canvasIcon(MusicMakerIcons.icon('tape', 40 + s * 13, 55)));
                top.appendChild(el('span', null, tapeLabel(s)));
                const h = E.headerOf(bytes);
                if (!empty && h.bpm) top.appendChild(el('span', 'mm-mono', Math.round(h.bpm) + 'BPM'));
                tape.appendChild(top);
                const shape = E.songShape(bytes);
                const name = (this.bank.names && this.bank.names[s]) || (empty ? 'EMPTY' : shape.onsets ? shape.onsets + ' NOTES' : 'BAND ONLY');
                tape.appendChild(el('div', 'mm-tape-name', name));
                const map = el('canvas', 'mm-tape-map');
                map.width = 96; map.height = 10;
                this.drawTapeMap(map, bytes);
                tape.appendChild(map);
                const chips = el('div', 'mm-chips');
                for (const r of roles[s] || []) chips.appendChild(el('span', 'mm-chip', r));
                if (!shape.canonical && !empty) {
                    const c = el('span', 'mm-chip odd', 'ODD BYTES · KEPT');
                    c.title = Object.entries(E.issueCounts(shape)).map(([k, v]) => v + ' ' + k).join(', ');
                    chips.appendChild(c);
                }
                tape.appendChild(chips);
                tape.title = tapeLabel(s) + ' · ' + name;
                this.shelf.appendChild(tape);
            }
        }
        drawTapeMap(cv, bytes) {
            const ctx = cv.getContext('2d');
            ctx.clearRect(0, 0, 96, 10);
            const E = this.E;
            for (let p = 0; p < 4; p++) {
                ctx.fillStyle = PART_COLORS[p];
                for (const n of E.partNotes(bytes, p)) {
                    const x = Math.floor(n.step * 96 / 512);
                    ctx.fillRect(x, p * 2, Math.max(1, Math.round(n.len * 96 / 512)), 2);
                }
            }
            ctx.fillStyle = RHYTHM_COLOR;
            for (let m = 0; m < 32; m++) {
                const c = E.controlAt(bytes, m);
                if (c.valid && !E.describeAccomp(c.bank, c.pattern, c.chord).silent) ctx.fillRect(m * 3, 8, 3, 2);
            }
        }
        rolesBySlot() {
            const out = {};
            const add = (slot, label) => { (out[slot] = out[slot] || []).push(label); };
            const t = this.bank.table;
            for (const r of ROLES) add(t[r.i], r.chip);
            for (let s = 0; s < this.stageCount; s++) {
                add(t[4 + s * 2], 'S' + (s + 1) + ' MAIN');
                add(t[5 + s * 2], 'S' + (s + 1) + ' BOSS');
            }
            return out;
        }
        selectSlot(s) {
            if (s === this.slot) return;
            this.cancelDrag();
            const was = this.player && this.player.playing();
            this.stop();
            this.slot = s;
            this.selection = null;
            this.firstMeasure = 0;
            this.fitStaff();
            this.render();
            if (was) this.play();
            if (this.api.onStatus) this.api.onStatus(this.status());
        }

        // ---------- compose ----------
        renderCompose() {
            const main = el('div', 'mm-main');
            this.songbar = el('div', 'mm-songbar');
            main.appendChild(this.songbar);
            this.renderSongbar();
            this.overview = el('canvas', 'mm-overview');
            this.overview.onpointerdown = (e) => this.overviewDown(e);
            this.overview.onpointermove = (e) => this.overviewMove(e);
            this.overview.onpointerup = () => this.staffUp();
            this.overview.onpointercancel = () => this.staffUp();
            main.appendChild(this.overview);
            this.lanes = el('div', 'mm-lanes');
            main.appendChild(this.lanes);
            this.laneEls = [];
            for (let p = 0; p < 4; p++) this.lanes.appendChild(this.buildLane(p));
            this.lanes.appendChild(this.buildRhythmLane());
            this.bodyEl.appendChild(main);
            this.side = el('div', 'mm-side');
            this.bodyEl.appendChild(this.side);
            this.renderSide();
            requestAnimationFrame(() => this.drawAll());
        }
        renderSongbar() {
            if (!this.songbar || !this.bank) return;
            const E = this.E;
            const b = this.bytes();
            const h = E.headerOf(b);
            this.songbar.textContent = '';
            const playing = !!(this.player && this.player.playing());
            const transport = el('div', 'mm-group');
            transport.appendChild(btn('mm-btn big' + (playing ? ' on' : ''), playing ? '■ STOP' : '▶ PLAY', () => this.togglePlay(), 'Space / X'));
            transport.appendChild(btn('mm-btn' + (this.loopRegion ? ' on' : ''), 'LOOP SEL', () => { this.loopRegion = !this.loopRegion; if (playing) this.play(); else this.renderSongbar(); }, 'Loop the selected measures while composing'));
            transport.appendChild(btn('mm-btn' + (this.follow ? ' on' : ''), 'FOLLOW', () => { this.follow = !this.follow; this.renderSongbar(); }));
            this.songbar.appendChild(transport);

            const tempo = el('div', 'mm-group');
            tempo.appendChild(el('span', 'mm-label', 'TEMPO'));
            tempo.appendChild(btn('mm-btn mm-step', '−', () => this.tryEdit((s) => E.setHeader(s, { tempoIndex: Math.max(0, h.tempoIndex - 1) }), 'quiet'), 'Slower'));
            tempo.appendChild(el('span', 'mm-value', h.bpm ? Math.round(h.bpm) + ' BPM' : '—'));
            tempo.appendChild(btn('mm-btn mm-step', '+', () => this.tryEdit((s) => E.setHeader(s, { tempoIndex: Math.min(31, h.tempoIndex + 1) }), 'quiet'), 'Faster'));
            this.mascot = el('canvas', 'mm-mascot');
            this.mascot.width = 72; this.mascot.height = 24;
            this.mascot.title = TIER_NAMES[tempoTier(h.tempoIndex)] + ' · tempo ' + (h.tempoIndex + 1) + ' of 32';
            tempo.appendChild(this.mascot);
            this.songbar.appendChild(tempo);
            this.drawMascot();

            const echo = el('div', 'mm-group');
            echo.appendChild(el('span', 'mm-label', 'ECHO'));
            const pips = el('div', 'mm-pips');
            for (let i = 0; i <= 7; i++) {
                const pip = btn('mm-pip' + (i <= h.echo && h.echo > 0 && i > 0 ? ' on' : ''), '', () => this.tryEdit((s) => E.setHeader(s, { echo: i === h.echo ? 0 : i }), 'quiet'), 'Echo ' + i);
                if (i === 0) { pip.textContent = '0'; pip.style.fontSize = '8px'; pip.style.color = 'var(--rsub)'; }
                pips.appendChild(pip);
            }
            echo.appendChild(pips);
            this.songbar.appendChild(echo);

            const loop = el('div', 'mm-group');
            loop.appendChild(el('span', 'mm-label', 'LOOP'));
            loop.appendChild(el('span', 'mm-value', pad2(h.loopStart + 1) + '→' + pad2(h.loopEnd + 1)));
            loop.appendChild(btn('mm-btn', 'LOOP HERE', () => {
                const s = this.selection || { m0: Math.floor(this.cursor.step / 16), m1: Math.floor(this.cursor.step / 16) };
                this.tryEdit((b2) => E.setHeader(b2, { loopStart: s.m0, loopEnd: s.m1 }), 'LOOP ' + pad2(s.m0 + 1) + '→' + pad2(s.m1 + 1));
            }, 'Loop the selected measures in the game'));
            this.songbar.appendChild(loop);

            const tapeOps = el('div', 'mm-group');
            tapeOps.appendChild(btn('mm-btn', '↶', () => this.doUndo(), 'Undo (Ctrl+Z)'));
            tapeOps.appendChild(btn('mm-btn', '↷', () => this.doRedo(), 'Redo (Ctrl+Y)'));
            tapeOps.appendChild(btn('mm-btn', 'TAPE ▾', () => this.openTapeSheet()));
            this.songbar.appendChild(tapeOps);
        }
        drawMascot() {
            const cv = this.mascot;
            if (!cv || !this.bank) return;
            const ctx = cv.getContext('2d');
            ctx.clearRect(0, 0, 72, 24);
            ctx.imageSmoothingEnabled = false;
            const h = this.E.headerOf(this.bytes());
            const tier = tempoTier(h.tempoIndex);
            const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            const playing = this.player && this.player.playing();
            const t = playing && this.actx ? this.actx.currentTime : 0;
            const beat = h.bpm ? t * h.bpm / 60 : 0;
            // speed lines grow with the tier
            ctx.fillStyle = 'rgba(255,255,255,.25)';
            for (let i = 0; i <= tier; i++) ctx.fillRect(4 + ((i * 11 + (reduce ? 0 : beat * 8 * (tier + 1))) % 40), 6 + (i % 3) * 5, 6 + tier, 1);
            const x = 46;
            const y = 4 + (playing && !reduce ? Math.abs(Math.sin(beat * Math.PI)) * -3 + 2 : 2);
            const img = this.mascotImage();
            if (img) {
                const s = Math.min(16 / img.h, 16 / img.w);
                ctx.drawImage(img.image, img.x, img.y, img.w, img.h, x, y, Math.round(img.w * s), Math.round(img.h * s));
            } else {
                ctx.drawImage(MusicMakerIcons.icon('band', 140, 55), x, y);
            }
        }
        mascotImage() {
            if (this._mascot !== undefined) return this._mascot;
            this._mascot = null;
            try {
                const atlas = this.api.atlas && this.api.atlas();
                const keys = this.api.playerFrames ? this.api.playerFrames() : [];
                const f = atlas && keys[0] && atlas.frames[keys[0]] && atlas.frames[keys[0]].frame;
                if (f) {
                    const image = new Image();
                    image.onload = () => this.drawMascot();
                    image.src = atlas.url;
                    this._mascot = { image, x: f.x, y: f.y, w: f.w, h: f.h };
                }
            } catch (e) {}
            return this._mascot;
        }
        buildLane(p) {
            const lane = el('div', 'mm-lane ' + (p === this.focusPart ? 'focus' : 'compact'));
            lane.style.setProperty('--pc', PART_COLORS[p]);
            const head = el('div', 'mm-lane-head');
            head.onclick = (e) => { if (e.target.closest('button')) return; this.focus(p); };
            const title = el('div', 'mm-lane-title');
            title.appendChild(el('i'));
            title.appendChild(el('span', null, 'PART ' + (p + 1)));
            head.appendChild(title);
            const fam = this.fams[this.inst[p]] || this.fams[0];
            const inst = el('div', 'mm-lane-inst');
            inst.appendChild(canvasIcon(MusicMakerIcons.instrumentIcon(fam)));
            inst.appendChild(el('span', null, fam.name));
            head.appendChild(inst);
            const ms = el('div', 'mm-ms');
            const mix = this.player ? this.player.mix() : { muted: [], soloed: [] };
            ms.appendChild(btn('mm-btn' + (mix.muted[p] ? ' on' : ''), 'M', () => this.toggleMix('mute', p), 'Mute'));
            ms.appendChild(btn('mm-btn' + (mix.soloed[p] ? ' on' : ''), 'S', () => this.toggleMix('solo', p), 'Solo'));
            if (p === this.focusPart) {
                ms.appendChild(btn('mm-btn', '▲', () => this.octave(1), 'Octave up (PageUp)'));
                ms.appendChild(btn('mm-btn', '▼', () => this.octave(-1), 'Octave down (PageDown)'));
            }
            head.appendChild(ms);
            lane.appendChild(head);
            const cv = el('canvas', 'mm-staff');
            cv.onpointerdown = (e) => this.staffDown(e, p);
            cv.onpointermove = (e) => this.staffMove(e, p);
            cv.onpointerup = (e) => this.staffUp(e, p);
            cv.onpointercancel = () => { this.cancelDrag(); this.drawAll(); };
            cv.oncontextmenu = (e) => e.preventDefault();
            lane.appendChild(cv);
            this.laneEls[p] = cv;
            return lane;
        }
        buildRhythmLane() {
            const lane = el('div', 'mm-lane rhythm');
            lane.style.setProperty('--pc', RHYTHM_COLOR);
            const head = el('div', 'mm-lane-head');
            const title = el('div', 'mm-lane-title');
            title.appendChild(el('i'));
            title.appendChild(el('span', null, 'RHYTHM'));
            head.appendChild(title);
            head.appendChild(el('div', 'mm-lane-inst', 'THE BAND · TAP A BAR'));
            const ms = el('div', 'mm-ms');
            const mix = this.player ? this.player.mix() : { muted: [], soloed: [] };
            ms.appendChild(btn('mm-btn' + (mix.muted[4] ? ' on' : ''), 'M', () => this.toggleMix('mute', 4), 'Mute the band'));
            ms.appendChild(btn('mm-btn' + (mix.soloed[4] ? ' on' : ''), 'S', () => this.toggleMix('solo', 4), 'Solo the band'));
            head.appendChild(ms);
            lane.appendChild(head);
            const cv = el('canvas', 'mm-staff');
            cv.onpointerdown = (e) => {
                const m = this.measureAt(cv, e);
                if (m === null) return;
                this.openBandSheet(this.selection && m >= this.selection.m0 && m <= this.selection.m1 ? this.selection : { m0: m, m1: m });
            };
            lane.appendChild(cv);
            this.rhythmEl = cv;
            return lane;
        }
        toggleMix(kind, i) {
            const p = this.ensureAudio();
            if (!p) return;
            const mix = p.mix();
            if (kind === 'mute') p.setMute(i, !mix.muted[i]); else p.setSolo(i, !mix.soloed[i]);
            this.renderCompose2();
        }
        // Rebuild the lanes and side without losing the songbar's buttons mid-click.
        renderCompose2() {
            if (this.view !== 'compose') return;
            this.bodyEl.textContent = '';
            this.renderCompose();
        }
        focus(p) {
            if (p === this.focusPart) return;
            this.focusPart = p;
            this.renderCompose2();
        }
        octave(d) {
            const p = this.focusPart, old = this.base[p];
            this.base[p] = Math.max(1, Math.min(59 - (ROWS - 1), old + d * 12));
            // The cursor pages with the window, so the next arrow key stays here.
            const moved = this.base[p] - old;
            this.cursor.pitch = Math.max(this.base[p], Math.min(this.base[p] + ROWS - 1, this.cursor.pitch + moved));
            this.drawAll();
        }

        // ---------- side panel ----------
        renderSide() {
            const s = this.side;
            s.textContent = '';
            const tools = el('div', 'mm-sec');
            tools.appendChild(el('div', 'mm-label', 'TOOLS'));
            const grid = el('div', 'mm-tools');
            TOOLS.forEach((t, i) => {
                const b = btn('mm-tool' + (this.tool === t.id ? ' on' : ''), '', () => { this.tool = t.id; this.renderSide(); });
                b.title = t.l + ' (' + (i + 1) + ')';
                b.appendChild(el('b', null, t.l));
                b.appendChild(el('small', null, t.sub));
                grid.appendChild(b);
            });
            tools.appendChild(grid);
            const lens = el('div', 'mm-row');
            lens.appendChild(el('span', 'mm-label', 'LENGTH'));
            for (const n of LENS) lens.appendChild(btn('mm-btn' + (this.len === n ? ' on' : ''), n === 1 ? '1/16' : n === 2 ? '1/8' : n === 4 ? '1/4' : n === 8 ? '1/2' : '1', () => { this.len = n; this.renderSide(); }));
            tools.appendChild(lens);
            const scales = el('div', 'mm-row');
            scales.appendChild(el('span', 'mm-label', 'SNAP'));
            for (const k of Object.keys(SCALES)) scales.appendChild(btn('mm-btn' + (this.scale === k ? ' on' : ''), k.toUpperCase(), () => { this.scale = k; this.renderSide(); this.drawAll(); }));
            tools.appendChild(scales);
            const misc = el('div', 'mm-row');
            misc.appendChild(btn('mm-btn' + (this.typing ? ' on' : ''), 'KEYS ⌨', () => { this.typing = !this.typing; this.renderSide(); }, 'Play the A S D F row as a piano (`)'));
            tools.appendChild(misc);
            s.appendChild(tools);

            if (this.selection) {
                const sel = el('div', 'mm-sec');
                const { m0, m1 } = this.selection;
                sel.appendChild(el('div', 'mm-label', 'MEASURES ' + pad2(m0 + 1) + (m1 > m0 ? '–' + pad2(m1 + 1) : '')));
                const row = el('div', 'mm-row');
                const E = this.E;
                const n = m1 - m0 + 1;
                row.appendChild(btn('mm-btn', 'COPY', () => this.copySel()));
                row.appendChild(btn('mm-btn', 'CUT', () => { this.copySel(); this.tryEdit((b) => E.tidyMeasures(b, m0, n), 'CUT'); }));
                row.appendChild(btn('mm-btn', 'PASTE', () => this.pasteAt(m0)));
                row.appendChild(btn('mm-btn', 'INSERT', () => this.tryEdit((b) => E.insertMeasures(b, m0, n), 'INSERTED ' + n)));
                row.appendChild(btn('mm-btn', 'DELETE', () => this.tryEdit((b) => E.deleteMeasures(b, m0, n), 'DELETED ' + n)));
                for (const [l, d] of [['−12', -12], ['−1', -1], ['+1', 1], ['+12', 12]]) {
                    row.appendChild(btn('mm-btn', l, () => {
                        const r = E.transposeMeasures(this.bytes(), m0, m1, d, { rhythm: true });
                        if (r.refused.length) this.api.flash && this.api.flash(r.refused.length + (r.refused.length === 1 ? ' NOTE WOULD' : ' NOTES WOULD') + ' FALL OFF · LEFT AS THEY WERE');
                        this.commit(r.bytes, r.refused.length ? null : 'TRANSPOSED ' + l);
                    }, 'Transpose (notes and band key)'));
                }
                row.appendChild(btn('mm-btn', 'BAND…', () => this.openBandSheet(this.selection)));
                row.appendChild(btn('mm-btn', '✕', () => { this.selection = null; this.renderSide(); this.drawAll(); }, 'Clear the selection'));
                sel.appendChild(row);
                s.appendChild(sel);
            }

            const pal = el('div', 'mm-sec');
            const ph = el('div', 'mm-sec-head');
            ph.appendChild(el('span', 'mm-label', 'SOUNDS · PART ' + (this.focusPart + 1)));
            pal.appendChild(ph);
            const fams = el('div', 'mm-fams');
            const cur = this.fams[this.inst[this.focusPart]];
            const showFam = this.family || (cur && cur.family) || 'keys';
            for (const f of MusicMakerIcons.FAMILIES) {
                const b = btn('mm-fam' + (showFam === f.id ? ' on' : ''), '', () => { this.family = f.id; this.renderSide(); });
                b.appendChild(canvasIcon(MusicMakerIcons.icon(f.id, f.hue, 58)));
                b.appendChild(el('span', null, f.label));
                fams.appendChild(b);
            }
            pal.appendChild(fams);
            const insts = el('div', 'mm-insts');
            insts.style.setProperty('--pc', PART_COLORS[this.focusPart]);
            for (const f of this.fams.filter((e) => e.family === showFam)) {
                const b = btn('mm-inst' + (this.inst[this.focusPart] === f.inst ? ' on' : ''), '', () => {
                    this.inst[this.focusPart] = f.inst;
                    this.audition(f.inst, this.cursor.pitch);
                    if (this.tool !== 'brush' && this.tool !== 'place') this.tool = 'place';
                    this.renderSide();
                    this.renderCompose2();
                });
                b.onpointerenter = (e) => { if (e.pointerType === 'mouse' && this.actx) this.audition(f.inst, this.cursor.pitch); };
                b.appendChild(canvasIcon(MusicMakerIcons.instrumentIcon(f)));
                b.appendChild(el('span', null, f.name + '\n#' + pad2(f.inst)));
                b.title = f.name + ' · tone-bank instrument ' + f.inst;
                insts.appendChild(b);
            }
            pal.appendChild(insts);
            s.appendChild(pal);
            s.appendChild(el('div', 'mm-note', 'Every note is its sound’s icon. Tap the staff to place one, drag right to hold it; tap the RHYTHM lane to give a bar a band.'));
        }

        // ---------- drawing ----------
        drawAll() {
            if (!this.lanes || !this.bank || this.view !== 'compose') return;
            this.drawOverview();
            for (let p = 0; p < 4; p++) this.drawLane(p);
            this.drawRhythm();
        }
        prep(cv) {
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const w = Math.max(10, cv.clientWidth), h = Math.max(10, cv.clientHeight);
            if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
            const ctx = cv.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.imageSmoothingEnabled = false;
            ctx.clearRect(0, 0, w, h);
            return { ctx, w, h };
        }
        css(name) { return getComputedStyle(this.root).getPropertyValue('--' + name).trim(); }
        playStep() {
            const pos = this.player && this.player.playing() ? this.player.position() : null;
            return pos ? pos.step : null;
        }
        drawOverview() {
            const cv = this.overview;
            if (!cv) return;
            const { ctx, w, h } = this.prep(cv);
            const E = this.E, b = this.bytes(), cw = w / 32;
            const hd = E.headerOf(b);
            ctx.fillStyle = this.css('lane') || 'rgba(0,0,0,.5)';
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = 'rgba(255,255,255,.06)';
            ctx.fillRect(hd.loopStart * cw, 0, (hd.loopEnd - hd.loopStart + 1) * cw, h);
            for (let p = 0; p < 4; p++) {
                ctx.fillStyle = PART_COLORS[p];
                for (const n of E.partNotes(b, p)) ctx.fillRect(n.step * w / 512, 3 + p * 6, Math.max(1.5, n.len * w / 512), 4);
            }
            for (let m = 0; m < 32; m++) {
                const c = E.controlAt(b, m);
                if (c.ff) { ctx.fillStyle = '#ffb36b'; ctx.fillRect(m * cw + 2, h - 6, cw - 4, 4); continue; }
                if (c.valid && !E.describeAccomp(c.bank, c.pattern, c.chord).silent) { ctx.fillStyle = RHYTHM_COLOR; ctx.fillRect(m * cw + 2, h - 6, cw - 4, 4); }
                ctx.fillStyle = 'rgba(255,255,255,.12)';
                ctx.fillRect(m * cw, 0, 1, h);
            }
            if (this.selection) {
                ctx.fillStyle = 'rgba(246,255,74,.18)';
                ctx.fillRect(this.selection.m0 * cw, 0, (this.selection.m1 - this.selection.m0 + 1) * cw, h);
            }
            ctx.strokeStyle = this.css('sel') || '#ff0';
            ctx.lineWidth = 2;
            ctx.strokeRect(this.firstMeasure * cw + 1, 1, this.visibleMeasures() * cw - 2, h - 2);
            ctx.fillStyle = '#fff';
            ctx.font = '8px "Share Tech Mono", monospace';
            ctx.fillText('↻', hd.loopStart * cw + 2, 9);
            const ps = this.playStep();
            if (ps !== null) { ctx.fillStyle = '#fff'; ctx.fillRect(ps * w / 512, 0, 2, h); }
        }
        laneGeom(cv, p) {
            const focus = p === this.focusPart;
            const w = cv.clientWidth, h = cv.clientHeight;
            const left = focus ? GUTTER : 0;
            const n = this.visibleMeasures();
            const stepW = (w - left) / (n * 16);
            return { focus, w, h, left, n, stepW, first: this.firstMeasure * 16, rowH: h / ROWS };
        }
        /** How big a note's icon is drawn on a lane. */
        iconPx(g) {
            return g.focus
                ? Math.max(14, Math.min(28, Math.round(g.rowH * 2.2), Math.round(g.stepW * 2.4)))
                : Math.max(12, Math.min(20, Math.round(g.stepW * 2)));
        }
        /** Centre height of a pitch on the focused staff. */
        staffY(p, g, pitch) {
            return (this.base[p] + ROWS - 1 - pitch) * g.rowH + g.rowH / 2;
        }
        /** Where a note's icon is drawn — centred on its onset cell — and so where a tap finds it. */
        noteIconRect(g, step, y, px) {
            return { x: Math.round(g.left + (step - g.first) * g.stepW + g.stepW / 2 - px / 2), y: Math.round(y - px / 2) };
        }
        drawLane(p) {
            const cv = this.laneEls[p];
            if (!cv) return;
            const { ctx, w, h } = this.prep(cv);
            const g = this.laneGeom(cv, p);
            const E = this.E, b = this.bytes();
            const color = PART_COLORS[p];
            ctx.fillStyle = this.css('lane') || 'rgba(0,0,0,.5)';
            ctx.fillRect(0, 0, w, h);
            const hd = E.headerOf(b);
            // loop, selection and beats
            for (let i = 0; i < g.n * 16; i++) {
                const step = g.first + i, x = g.left + i * g.stepW, m = Math.floor(step / 16);
                if (m < hd.loopStart || m > hd.loopEnd) { ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x, 0, g.stepW, h); }
                if (this.selection && m >= this.selection.m0 && m <= this.selection.m1) { ctx.fillStyle = 'rgba(246,255,74,.08)'; ctx.fillRect(x, 0, g.stepW, h); }
                if (step % 4 === 0) { ctx.fillStyle = step % 16 === 0 ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.08)'; ctx.fillRect(x, 0, 1, h); }
                if (step % 16 === 0) { ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = '8px "Share Tech Mono", monospace'; ctx.fillText(pad2(m + 1), x + 3, h - 3); }
                if (E.isFfMeasure(b, m) && step % 16 === 0) { ctx.fillStyle = 'rgba(255,179,107,.18)'; ctx.fillRect(x, 0, g.stepW * 16, h); }
            }
            const base = this.base[p];
            let toY;
            if (g.focus) {
                const sc = SCALES[this.scale];
                for (let r = 0; r < ROWS; r++) {
                    const pitch = base + (ROWS - 1 - r);
                    const pc = pitchClass(pitch);
                    const y = r * g.rowH;
                    if (!sc.includes(pc)) { ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(g.left, y, w - g.left, g.rowH); }
                    if (pc === 0) { ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(g.left, y + g.rowH - 1, w - g.left, 1); }
                    else if ([2, 4, 5, 7, 9, 11].includes(pc)) { ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fillRect(g.left, y + g.rowH - 1, w - g.left, 1); }
                    if (pc === 0 || r === 0 || r === ROWS - 1) {
                        ctx.fillStyle = pc === 0 ? '#fff' : 'rgba(255,255,255,.5)';
                        ctx.font = '9px "Share Tech Mono", monospace';
                        ctx.fillText(noteName(pitch), 2, y + g.rowH - 2);
                    }
                }
                toY = (pitch) => this.staffY(p, g, pitch);
            } else {
                const notes = E.partNotes(b, p);
                const lo = notes.length ? Math.min(...notes.map((n) => n.pitch)) : 1;
                const hi = notes.length ? Math.max(...notes.map((n) => n.pitch)) : 59;
                toY = (pitch) => hi === lo ? h / 2 : 10 + (hi - pitch) / (hi - lo) * (h - 20);
            }
            const iconPx = this.iconPx(g);
            const visibleEnd = g.first + g.n * 16;
            // stray cells: orphan ties and rests that still name a sound
            const kinds = E.partCells(b, p);
            ctx.font = '9px "Share Tech Mono", monospace';
            for (let st = g.first; st < visibleEnd; st++) {
                if (kinds[st] === 'orphan-tie' || kinds[st] === 'pitch-range') {
                    ctx.fillStyle = 'rgba(255,179,107,.55)';
                    ctx.fillText('?', g.left + (st - g.first) * g.stepW + 2, h - 12);
                }
            }
            for (const n of E.partNotes(b, p)) {
                if (n.step + n.len <= g.first || n.step >= visibleEnd) continue;
                const x0 = g.left + (n.step - g.first) * g.stepW;
                const x1 = g.left + (n.step + n.len - g.first) * g.stepW;
                let y = toY(n.pitch);
                const off = g.focus && (y < 0 || y > h);
                if (off) y = y < 0 ? 6 : h - 6;
                // the held part: a wavy tail in the part's colour
                if (n.len > 1) {
                    ctx.strokeStyle = color;
                    ctx.globalAlpha = 0.8;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    const start = Math.max(g.left, x0 + iconPx * 0.45), end = Math.min(w, x1 - 1);
                    for (let x = start; x <= end; x += 2) {
                        const yy = y + Math.sin((x - x0) / 3.2) * 2.5;
                        if (x === start) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
                    }
                    ctx.stroke();
                    ctx.globalAlpha = 1;
                    // bends: where a tie's pitch byte says another note (kept as found)
                    for (const bd of n.bends) {
                        if (bd.step < g.first || bd.step >= visibleEnd || !bd.pitch) continue;
                        ctx.fillStyle = '#ffb36b';
                        const by = Math.max(3, Math.min(h - 3, toY(bd.pitch)));
                        ctx.fillRect(g.left + (bd.step - g.first) * g.stepW + g.stepW / 2 - 1.5, by - 1.5, 3, 3);
                    }
                }
                if (n.step >= g.first) {
                    const fam = this.fams[n.inst];
                    const icon = fam ? MusicMakerIcons.instrumentIcon(fam) : MusicMakerIcons.icon('fx', 30, 50);
                    const { x: ix, y: iy } = this.noteIconRect(g, n.step, y, iconPx);
                    ctx.globalAlpha = off ? 0.5 : 1;
                    ctx.drawImage(icon, Math.max(0, ix), iy, iconPx, iconPx);
                    ctx.globalAlpha = 1;
                    if (g.focus && off) {
                        ctx.fillStyle = '#fff';
                        ctx.fillText(y < h / 2 ? '▲' : '▼', ix + iconPx, iy + iconPx / 2 + 3);
                    }
                }
            }
            // the cursor and the playhead
            if (g.focus) {
                const cs = this.cursor.step;
                if (cs >= g.first && cs < visibleEnd) {
                    ctx.strokeStyle = this.css('sel') || '#ff0';
                    ctx.lineWidth = 1.5;
                    ctx.strokeRect(g.left + (cs - g.first) * g.stepW + 0.5, toY(this.cursor.pitch) - g.rowH / 2, Math.max(4, g.stepW * this.len) - 1, g.rowH);
                }
            }
            const ps = this.playStep();
            if (ps !== null && ps >= g.first && ps < visibleEnd) {
                ctx.fillStyle = '#fff';
                ctx.fillRect(g.left + (ps - g.first) * g.stepW, 0, 2, h);
            }
        }
        drawRhythm() {
            const cv = this.rhythmEl;
            if (!cv) return;
            const { ctx, w, h } = this.prep(cv);
            const E = this.E, b = this.bytes();
            const n = this.visibleMeasures();
            const mw = w / n;
            ctx.fillStyle = this.css('lane') || 'rgba(0,0,0,.5)';
            ctx.fillRect(0, 0, w, h);
            for (let i = 0; i < n; i++) {
                const m = this.firstMeasure + i;
                const x = i * mw;
                const c = E.controlAt(b, m);
                const selected = this.selection && m >= this.selection.m0 && m <= this.selection.m1;
                ctx.fillStyle = selected ? 'rgba(246,255,74,.12)' : 'rgba(255,255,255,.03)';
                ctx.fillRect(x + 2, 2, mw - 4, h - 4);
                ctx.fillStyle = 'rgba(255,255,255,.28)';
                ctx.fillRect(x, 0, 1, h);
                ctx.font = '8px "Share Tech Mono", monospace';
                if (c.ff) { ctx.fillStyle = '#ffb36b'; ctx.fillText('0xFF · TIDY TO USE', x + 8, h / 2 + 3); continue; }
                if (!c.valid) { ctx.fillStyle = '#ffb36b'; ctx.fillText('? ' + c.raw.join(' ') + ' (KEPT)', x + 8, h / 2 + 3); continue; }
                const d = E.describeAccomp(c.bank, c.pattern, c.chord);
                if (d.silent) { ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillText(pad2(m + 1) + ' · NO BAND', x + 8, h / 2 + 3); continue; }
                ctx.drawImage(MusicMakerIcons.icon('band', 260 + c.bank * 22, 58), x + 6, 6, 24, 24);
                ctx.fillStyle = RHYTHM_COLOR;
                ctx.font = 'bold 9px Orbitron, sans-serif';
                ctx.fillText(this.bandName(c.bank), x + 36, 15);
                ctx.font = '8px "Share Tech Mono", monospace';
                ctx.fillStyle = 'rgba(255,255,255,.75)';
                ctx.fillText('GROOVE ' + (c.pattern + 1) + ' · CHORD ' + (c.chord + 1) + ' · KEY ' + this.keyLabel(c.key), x + 36, 27);
                // the drum hits of the bar, as dots
                const drums = d.rows.slice(4).filter(Boolean);
                const dw = (mw - 44) / 16;
                for (let st = 0; st < 16; st++) {
                    const hit = drums.some((r) => r[st] && !(r[st] & 128));
                    ctx.fillStyle = hit ? '#fff' : 'rgba(255,255,255,.15)';
                    ctx.fillRect(x + 36 + st * dw, h - 12, Math.max(2, dw - 2), hit ? 5 : 2);
                }
            }
            const ps = this.playStep();
            if (ps !== null) {
                const m = Math.floor(ps / 16) - this.firstMeasure;
                if (m >= 0 && m < n) { ctx.fillStyle = '#fff'; ctx.fillRect(m * mw + (ps % 16) * mw / 16, 0, 2, h); }
            }
        }
        bandName(bank) { return bank === 0 ? 'DRUMS ONLY' : 'BAND ' + bank; }
        keyLabel(key) {
            const t = this.E.TRANSPOSE_TABLE[key];
            return t === undefined ? '?' : (t > 0 ? '+' + t : String(t));
        }

        // ---------- pointer ----------
        stepPitchAt(cv, e, p) {
            const r = cv.getBoundingClientRect();
            const g = this.laneGeom(cv, p);
            const x = e.clientX - r.left, y = e.clientY - r.top;
            const step = Math.max(0, Math.min(511, g.first + Math.floor((x - g.left) / g.stepW)));
            const row = Math.max(0, Math.min(ROWS - 1, Math.floor(y / g.rowH)));
            const pitch = this.base[p] + (ROWS - 1 - row);
            return { step, pitch: Math.max(1, Math.min(59, pitch)), x, y, inside: x >= g.left };
        }
        measureAt(cv, e) {
            const r = cv.getBoundingClientRect();
            const n = this.visibleMeasures();
            const i = Math.floor((e.clientX - r.left) / (r.width / n));
            return i >= 0 && i < n ? this.firstMeasure + i : null;
        }
        // The note whose drawn icon is under (x, y) on the focused staff — a
        // tap on an icon means that note, even where the icon spills past its cell.
        iconHitAt(p, at) {
            const cv = this.laneEls[p];
            const g = this.laneGeom(cv, p);
            const notes = this.E.partNotes(this.bytes(), p);
            const px = this.iconPx(g);
            for (let i = notes.length - 1; i >= 0; i--) {
                const n = notes[i];
                if (n.step < g.first || n.step >= g.first + g.n * 16) continue;
                const r = this.noteIconRect(g, n.step, this.staffY(p, g, n.pitch), px);
                if (at.x >= r.x && at.x < r.x + px && at.y >= r.y && at.y < r.y + px) return n;
            }
            return null;
        }
        staffDown(e, p) {
            if (p !== this.focusPart) { this.focus(p); return; }
            const cv = this.laneEls[p];
            const at = this.stepPitchAt(cv, e, p);
            if (!at.inside) return;
            e.preventDefault();
            try { cv.setPointerCapture(e.pointerId); } catch (err) {}
            this.cancelDrag();
            const E = this.E, b = this.bytes();
            const tool = e.button === 2 ? 'erase' : this.tool;
            const icon = this.iconHitAt(p, at);
            const step = icon ? icon.step : at.step;
            const base = { slot: this.slot, start: b, downStep: at.step, moved: false };
            this.cursor = { step, pitch: icon ? icon.pitch : this.snapPitch(at.pitch) };
            if (tool === 'place') {
                const pitch = icon ? icon.pitch : this.snapPitch(at.pitch);
                const hit = icon || E.noteAt(b, p, at.step);
                if (hit && hit.step === step && hit.pitch === pitch) {
                    this.audition(hit.inst, hit.pitch);
                    this.drag = { ...base, kind: 'hold', step: hit.step };
                    this.drawAll();
                    return;
                }
                const placed = this.safe(() => E.placeNote(b, { part: p, step, len: this.len, pitch, inst: this.inst[p] }));
                if (!placed) return;
                this.bank.slots[this.slot] = placed;
                this.drag = { ...base, kind: 'place', step, pitch };
                this.audition(this.inst[p], pitch);
                this.drawAll();
            } else if (tool === 'hold') {
                const hit = icon || E.noteAt(b, p, at.step);
                if (hit) this.drag = { ...base, kind: 'hold', step: hit.step };
            } else if (tool === 'erase') {
                this.drag = { ...base, kind: 'erase' };
                this.eraseAt(p, step);
            } else if (tool === 'brush') {
                this.drag = { ...base, kind: 'brush' };
                this.brushAt(p, step);
            } else if (tool === 'select') {
                const m = Math.floor(at.step / 16);
                this.drag = { kind: 'select', slot: this.slot, m };
                this.selection = { m0: m, m1: m };
                this.renderSide();
                this.drawAll();
            }
        }
        staffMove(e, p) {
            const d = this.drag;
            if (!d || p !== this.focusPart || d.slot !== this.slot) return;
            // A release the canvas never heard (the window lost it): land the
            // drag now rather than let a bare hover keep editing.
            if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) { this.staffUp(e, p); return; }
            const at = this.stepPitchAt(this.laneEls[p], e, p);
            const E = this.E;
            if (d.kind === 'place' || d.kind === 'hold') {
                // A press that has not left its cell is a tap: the LENGTH chip
                // stands, and a tapped note keeps its own length.
                if (!d.moved) { if (at.step === d.downStep) return; d.moved = true; }
                const len = Math.max(1, at.step - d.step + 1);
                const next = this.safe(() => d.kind === 'place'
                    ? E.placeNote(d.start, { part: p, step: d.step, len, pitch: d.pitch, inst: this.inst[p] })
                    : E.resizeNote(d.start, p, d.step, len));
                if (next) { this.bank.slots[d.slot] = next; this.drawAll(); }
            } else if (d.kind === 'erase') this.eraseAt(p, at.step);
            else if (d.kind === 'brush') this.brushAt(p, at.step);
            else if (d.kind === 'select') {
                const m = Math.floor(at.step / 16);
                this.selection = { m0: Math.min(d.m, m), m1: Math.max(d.m, m) };
                this.drawAll();
            }
        }
        staffUp() {
            const d = this.drag;
            this.drag = null;
            if (!d) return;
            if (d.kind === 'select' || d.kind === 'oselect') { this.renderSide(); return; }
            if (!d.start || d.slot !== this.slot) return;
            // The drag edited the live bytes for feedback; land it as one undo step.
            const now = this.bytes();
            this.bank.slots[this.slot] = d.start;
            this.commit(now, 'quiet');
        }
        // A drag that will not finish (the tape changed, an undo, a cancelled
        // pointer): put its tape back the way the drag found it.
        cancelDrag() {
            const d = this.drag;
            this.drag = null;
            if (d && d.start && this.bank) this.bank.slots[d.slot] = d.start;
        }
        eraseAt(p, step) {
            const E = this.E, b = this.bytes();
            const hit = E.noteAt(b, p, step);
            const kinds = E.partCells(b, p);
            if (!hit && kinds[step] === 'rest') return;
            const next = this.safe(() => E.eraseNote(b, p, step));
            if (next) { this.bank.slots[this.slot] = next; this.drawAll(); }
        }
        brushAt(p, step) {
            const E = this.E, b = this.bytes();
            const hit = E.noteAt(b, p, step);
            if (!hit || hit.inst === this.inst[p]) return;
            const next = this.safe(() => E.paintInstrument(b, p, step, this.inst[p]));
            if (next) { this.bank.slots[this.slot] = next; this.drawAll(); }
        }
        safe(fn) {
            try { return fn(); } catch (e) {
                if (this.api.flash) this.api.flash(String(e.message || e).replace(/^song-edit: /, '').toUpperCase());
                return null;
            }
        }
        overviewDown(e) {
            const r = this.overview.getBoundingClientRect();
            const m = Math.max(0, Math.min(31, Math.floor((e.clientX - r.left) / (r.width / 32))));
            if (e.shiftKey || this.tool === 'select') {
                this.drag = { kind: 'oselect', m };
                this.selection = { m0: m, m1: m };
                this.renderSide();
            } else {
                const n = this.visibleMeasures();
                this.firstMeasure = Math.max(0, Math.min(32 - n, m - (m % n)));
                this.cursor.step = m * 16;
                this.drag = { kind: 'scroll' };
            }
            this.drawAll();
        }
        overviewMove(e) {
            if (!this.drag || (e.buttons & 1) === 0) return;
            const r = this.overview.getBoundingClientRect();
            const m = Math.max(0, Math.min(31, Math.floor((e.clientX - r.left) / (r.width / 32))));
            if (this.drag.kind === 'oselect') this.selection = { m0: Math.min(this.drag.m, m), m1: Math.max(this.drag.m, m) };
            else if (this.drag.kind === 'scroll') {
                const n = this.visibleMeasures();
                this.firstMeasure = Math.max(0, Math.min(32 - n, m - (m % n)));
            }
            this.drawAll();
        }

        // ---------- measures clipboard ----------
        copySel() {
            if (!this.selection) return;
            const { m0, m1 } = this.selection;
            const clip = this.E.copyMeasures(this.bytes(), m0, m1 - m0 + 1);
            let s = '';
            for (const v of clip) s += String.fromCharCode(v);
            try { localStorage.setItem('mm-clip', btoa(s)); } catch (e) {}
            this.clip = clip;
            this.api.flash && this.api.flash('COPIED ' + (m1 - m0 + 1) + (m1 > m0 ? ' MEASURES' : ' MEASURE'));
        }
        pasteAt(m) {
            let clip = this.clip;
            if (!clip) {
                try { const raw = localStorage.getItem('mm-clip'); if (raw) clip = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); } catch (e) {}
            }
            if (!clip) { this.api.flash && this.api.flash('NOTHING COPIED YET'); return; }
            this.tryEdit((b) => this.E.pasteMeasures(b, m, clip), 'PASTED AT ' + pad2(m + 1));
        }

        // ---------- sheets ----------
        openSheet(title) {
            this.sheet.textContent = '';
            const panel = el('div', 'mm-sheet-panel');
            panel.appendChild(el('div', 'mm-sheet-title', title));
            this.sheet.appendChild(panel);
            this.sheet.hidden = false;
            return panel;
        }
        closeSheet() { this.sheet.hidden = true; this.sheet.textContent = ''; }
        sheetOpen() { return !this.sheet.hidden; }
        openBandSheet(range) {
            const E = this.E;
            const { m0, m1 } = range;
            const c = E.controlAt(this.bytes(), m0);
            const pick = { bank: c.valid ? c.bank : 1, pattern: c.valid ? c.pattern : 0, chord: c.valid ? c.chord : 0, key: c.valid ? c.key : 3 };
            const panel = this.openSheet('THE BAND · MEASURE ' + pad2(m0 + 1) + (m1 > m0 ? '–' + pad2(m1 + 1) : ''));
            const draw = () => {
                while (panel.children.length > 1) panel.lastChild.remove();
                panel.appendChild(el('div', 'mm-label', 'BAND'));
                const grid = el('div', 'mm-band-grid');
                for (let k = 0; k < 9; k++) {
                    const d = E.describeAccomp(k, pick.pattern, pick.chord);
                    const b = btn('mm-band' + (pick.bank === k ? ' on' : ''), '', () => { pick.bank = k; this.auditionBand(pick); draw(); });
                    b.appendChild(canvasIcon(MusicMakerIcons.icon('band', 260 + k * 22, 58), 32));
                    b.appendChild(el('b', null, this.bandName(k)));
                    b.appendChild(el('small', null, d.silent ? 'SILENT HERE' : (d.pitched ? 'CHORDS' : '') + (d.pitched && d.drums ? ' + ' : '') + (d.drums ? 'DRUMS' : '')));
                    grid.appendChild(b);
                }
                panel.appendChild(grid);
                const row = (label, n, key, fmt) => {
                    const r = el('div', 'mm-row');
                    r.appendChild(el('span', 'mm-label', label));
                    for (let v = 0; v < n; v++) r.appendChild(btn('mm-btn' + (pick[key] === v ? ' on' : ''), fmt(v), () => { pick[key] = v; this.auditionBand(pick); draw(); }));
                    panel.appendChild(r);
                };
                row('GROOVE', 4, 'pattern', (v) => String(v + 1));
                row('CHORD', 5, 'chord', (v) => String(v + 1));
                row('KEY', 12, 'key', (v) => this.keyLabel(v));
                const act = el('div', 'mm-row');
                act.appendChild(btn('mm-btn big', '▶ HEAR IT', () => this.auditionBand(pick)));
                act.appendChild(btn('mm-btn big on', 'A  PUT IT ON ' + (m1 > m0 ? (m1 - m0 + 1) + ' BARS' : 'THIS BAR'), () => {
                    this.tryEdit((b) => { let out = b; for (let m = m0; m <= m1; m++) out = E.setRhythm(out, m, pick); return out; }, this.bandName(pick.bank) + ' · ' + (m1 - m0 + 1) + (m1 > m0 ? ' BARS' : ' BAR'));
                    this.closeSheet();
                }));
                act.appendChild(btn('mm-btn big', 'NO BAND', () => {
                    this.tryEdit((b) => { let out = b; for (let m = m0; m <= m1; m++) out = E.clearRhythm(out, m); return out; }, 'NO BAND');
                    this.closeSheet();
                }));
                if (E.isFfMeasure(this.bytes(), m0)) act.appendChild(btn('mm-btn big', 'TIDY 0xFF BAR', () => { this.tryEdit((b) => E.tidyMeasures(b, m0, 1), 'TIDIED'); this.closeSheet(); }));
                act.appendChild(btn('mm-btn big', 'B  BACK', () => this.closeSheet()));
                panel.appendChild(act);
                panel.appendChild(el('div', 'mm-note', 'The band is the cart’s own auto-accompaniment: nine bands, four grooves and five chords each, in any of twelve keys. It plays under your four parts.'));
            };
            draw();
        }
        auditionBand(pick) {
            const p = this.ensureAudio();
            if (!p) return;
            const h = this.E.headerOf(this.bytes());
            p.auditionRhythm([pick.bank, pick.pattern, (pick.chord << 1) | 0x80, pick.key], this.E.TEMPO_TABLE[h.tempoIndex & 31] / 240);
        }
        openTapeSheet() {
            const E = this.E;
            const s = this.slot;
            const panel = this.openSheet('TAPE ' + tapeLabel(s));
            const nameRow = el('div', 'mm-row');
            nameRow.appendChild(el('span', 'mm-label', 'LABEL'));
            const input = el('input');
            input.maxLength = 16;
            input.value = (this.bank.names && this.bank.names[s]) || '';
            input.placeholder = 'NAME THIS TAPE';
            input.onkeydown = (e) => e.stopPropagation();
            nameRow.appendChild(input);
            nameRow.appendChild(btn('mm-btn', 'SET', () => {
                const v = input.value.trim().toUpperCase().slice(0, 16);
                this.commitMeta(() => { this.bank.names = Object.assign({}, this.bank.names || {}); if (v) this.bank.names[s] = v; else delete this.bank.names[s]; }, v ? 'TAPE LABELLED' : 'LABEL CLEARED');
                this.closeSheet();
            }));
            panel.appendChild(nameRow);
            panel.appendChild(el('div', 'mm-note', 'The label lives with the level on the web; the cart itself has no names.'));
            const ops = el('div', 'mm-row');
            ops.appendChild(btn('mm-btn', 'LOAD SAMPLE SONG…', () => this.openSampleSheet()));
            ops.appendChild(btn('mm-btn', 'CLEAR TAPE', () => { this.commit(E.emptySong(), 'TAPE CLEARED'); this.closeSheet(); }));
            ops.appendChild(btn('mm-btn', 'REVERT TAPE', () => { this.commit(this.opened[s].slice(), 'TAPE REVERTED'); this.closeSheet(); }, 'Back to how it was when MUSIC opened'));
            panel.appendChild(ops);
            const copy = el('div', 'mm-row');
            copy.appendChild(el('span', 'mm-label', 'COPY TO'));
            const sel = el('select');
            for (let t = 0; t < 24; t++) if (t !== s) { const o = el('option', null, tapeLabel(t) + (E.isEmptySong(this.bank.slots[t]) ? ' · EMPTY' : '')); o.value = t; sel.appendChild(o); }
            copy.appendChild(sel);
            copy.appendChild(btn('mm-btn', 'COPY', () => {
                const t = Number(sel.value);
                this.undo.push({ slot: t, bytes: this.bank.slots[t] });
                this.redo = [];
                this.bank.slots[t] = this.bytes().slice();
                this.changed('COPIED TO ' + tapeLabel(t));
                this.closeSheet();
            }));
            copy.appendChild(btn('mm-btn', 'SWAP', () => {
                const t = Number(sel.value);
                const a = this.bank.slots[s], b = this.bank.slots[t];
                this.commitMeta(() => {
                    this.bank.slots[s] = b; this.bank.slots[t] = a;
                    const o = this.opened[s]; this.opened[s] = this.opened[t]; this.opened[t] = o;   // REVERT follows the tape
                    this.bank.table = this.bank.table.map((v) => (v === s ? t : v === t ? s : v));
                    const n = Object.assign({}, this.bank.names || {}); const ns = n[s], nt = n[t];
                    delete n[s]; delete n[t]; if (ns) n[t] = ns; if (nt) n[s] = nt; this.bank.names = n;
                    this.slot = t;
                }, 'SWAPPED · THE SET LIST FOLLOWS');
                this.undo = [];   // a swap moves two tapes and the table at once: start a fresh history
                this.closeSheet();
            }, 'Swap the two tapes; the set list follows them'));
            panel.appendChild(copy);
            panel.appendChild(btn('mm-btn big', 'B  BACK', () => this.closeSheet()));
        }
        loadSampleSongs() {
            if (this.sampleSongs) return Promise.resolve(this.sampleSongs);
            return Promise.all([
                fetch('/editor/dezaemon/sample-songs.bin').then((r) => (r.ok ? r.arrayBuffer() : null)),
                fetch('/editor/dezaemon/sample-songs.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
            ]).then(([bin, meta]) => {
                if (!bin) return null;
                const all = new Uint8Array(bin);
                const size = this.E.SONG_SIZE;
                const songs = [];
                for (let i = 0; i * size < all.length; i++) {
                    const m = meta && meta.songs && meta.songs[i];
                    songs.push({ ss: 25 + i, name: (m && m.name) || '', bytes: all.slice(i * size, (i + 1) * size) });
                }
                this.sampleSongs = songs;
                return songs;
            }).catch(() => null);
        }
        openSampleSheet() {
            const panel = this.openSheet('SAMPLE SONGS · SS-25 TO SS-97');
            panel.appendChild(el('div', 'mm-note', 'The 73 songs 音まろ ships with. HEAR plays the opening; LOAD puts one on ' + tapeLabel(this.slot) + ' exactly as the console does.'));
            const list = el('div', 'mm-band-grid');
            panel.appendChild(list);
            panel.appendChild(btn('mm-btn big', 'B  BACK', () => this.closeSheet()));
            this.loadSampleSongs().then((songs) => {
                if (!songs) { list.appendChild(el('div', 'mm-note', 'THE SAMPLE SONGS ARE NOT ON THIS SERVER.')); return; }
                for (const sg of songs) {
                    const b = el('div', 'mm-band');
                    b.appendChild(el('b', null, 'SS-' + sg.ss));
                    b.appendChild(el('small', null, sg.name || Math.round(this.E.headerOf(sg.bytes).bpm) + ' BPM'));
                    const row = el('div', 'mm-row');
                    row.appendChild(btn('mm-btn', '▶', () => {
                        const p = this.ensureAudio();
                        if (!p) return;
                        p.load(sg.bytes).play({ region: [0, 1] });
                        setTimeout(() => { if (!this.player.playing()) return; this.player.stop(); }, 6000);
                    }, 'Hear the first two bars'));
                    row.appendChild(btn('mm-btn on', 'LOAD', () => {
                        this.stop();
                        this.commit(sg.bytes.slice(), 'SS-' + sg.ss + ' ON ' + tapeLabel(this.slot));
                        this.fitStaff();
                        this.closeSheet();
                        this.render();
                    }));
                    b.appendChild(row);
                    list.appendChild(b);
                }
            });
        }
        openCheats() {
            const panel = this.openSheet('EVERY CONTROL');
            const g = el('div', 'mm-cheats');
            for (const h of ['', 'KEYBOARD', 'PAD', 'TOUCH']) g.appendChild(el('b', null, h));
            for (const a of ACTIONS) {
                g.appendChild(el('span', null, a.label));
                g.appendChild(el('span', null, a.keys.join(' · ')));
                g.appendChild(el('span', null, a.pad));
                g.appendChild(el('span', null, a.touch));
            }
            panel.appendChild(g);
            panel.appendChild(btn('mm-btn big', 'B  BACK', () => this.closeSheet()));
        }

        // ---------- set list ----------
        renderSetlist() {
            const E = this.E;
            const wrap = el('div', 'mm-setlist');
            wrap.appendChild(el('div', 'mm-note', 'Which tape plays where. The cart reads this table; on the web the same rows pick the stage, boss, title, game over and clear music.'));
            const sfx = el('div', 'mm-set-row');
            sfx.appendChild(el('span', 'mm-label', 'SOUND EFFECTS'));
            const seg = el('div', 'mm-seg');
            for (const s of SFX_SETS) seg.appendChild(btn(this.bank.sfxSet === s.v ? 'on' : '', s.l, () => this.commitMeta(() => { this.bank.sfxSet = s.v; }, 'EFFECTS · ' + s.l)));
            sfx.appendChild(seg);
            wrap.appendChild(sfx);
            const row = (label, i, stage) => {
                const r = el('div', 'mm-set-row');
                r.appendChild(el('span', 'mm-label', label));
                const sel = el('select');
                for (let t = 0; t < 24; t++) {
                    const name = (this.bank.names && this.bank.names[t]) || (E.isEmptySong(this.bank.slots[t]) ? 'EMPTY · SILENT' : '');
                    const o = el('option', null, tapeLabel(t) + (name ? ' · ' + name : ''));
                    o.value = t;
                    if (this.bank.table[i] === t) o.selected = true;
                    sel.appendChild(o);
                }
                sel.onchange = () => this.commitMeta(() => { this.bank.table = this.bank.table.slice(); this.bank.table[i] = Number(sel.value); }, label + ' → ' + tapeLabel(Number(sel.value)));
                sel.onkeydown = (e) => e.stopPropagation();
                r.appendChild(sel);
                r.appendChild(btn('mm-btn', '▶ HEAR', () => {
                    const p = this.ensureAudio();
                    if (!p) return;
                    if (p.playing()) { this.stop(); return; }
                    p.load(this.bank.slots[this.bank.table[i]]).play();
                }));
                r.appendChild(btn('mm-btn', 'EDIT', () => { this.view = 'compose'; this.selectSlot(this.bank.table[i]); this.render(); }));
                if (stage !== undefined && this.api.onPlayStage) r.appendChild(btn('mm-btn', 'PLAY STAGE ' + pad2(stage + 1), () => { this.flush(); this.api.onPlayStage(stage); }));
                wrap.appendChild(r);
            };
            for (const ro of ROLES) row(ro.label, ro.i);
            for (let s = 0; s < this.stageCount; s++) {
                row('STAGE ' + pad2(s + 1) + ' MAIN', 4 + s * 2, s);
                row('STAGE ' + pad2(s + 1) + ' BOSS', 5 + s * 2, s);
            }
            this.bodyEl.appendChild(wrap);
        }

        // ---------- footer ----------
        renderFoot() {
            this.foot.textContent = '';
            const add = (orb, cls, label, fn) => {
                const b = btn('mm-foot-btn', '', fn);
                b.appendChild(el('span', 'mm-orb ' + cls, orb));
                b.appendChild(el('span', null, label));
                this.foot.appendChild(b);
            };
            if (this.view === 'compose') {
                add('A', 'mm-orb-a', 'PLACE', () => this.keyPlace());
                add('B', 'mm-orb-b', 'ERASE', () => this.keyErase());
            }
            add('X', 'mm-orb-x', this.player && this.player.playing() ? 'STOP' : 'PLAY', () => this.togglePlay());
            if (!this.api.canSave || this.api.canSave()) add('Y', 'mm-orb-y', 'SAVE', () => this.save());
            add('‹', 'mm-orb-b', 'BACK', () => this.back());
        }
        save() {
            this.flush();
            if (this.api.onSave) this.api.onSave();
        }
        back() {
            if (this.sheetOpen()) { this.closeSheet(); return; }
            if (this.selection) { this.selection = null; this.renderSide(); this.drawAll(); return; }
            if (this.api.onBack) this.api.onBack();
        }

        // ---------- keyboard ----------
        keyPlace(pitch) {
            const p = this.focusPart;
            const P = pitch || this.snapPitch(this.cursor.pitch);
            this.cursor.pitch = P;
            if (this.tryEdit((b) => this.E.placeNote(b, { part: p, step: this.cursor.step, len: this.len, pitch: P, inst: this.inst[p] }), 'quiet')) {
                this.audition(this.inst[p], P);
            }
        }
        keyErase() { this.tryEdit((b) => this.E.eraseNote(b, this.focusPart, this.cursor.step), 'quiet'); }
        moveCursor(dStep, dPitch) {
            const c = this.cursor;
            c.step = Math.max(0, Math.min(511, c.step + dStep));
            c.pitch = Math.max(1, Math.min(59, c.pitch + dPitch));
            const p = this.focusPart;
            if (c.pitch < this.base[p]) this.base[p] = Math.max(1, c.pitch);
            if (c.pitch > this.base[p] + ROWS - 1) this.base[p] = Math.min(59 - (ROWS - 1), c.pitch - (ROWS - 1));
            const n = this.visibleMeasures(), m = Math.floor(c.step / 16);
            if (m < this.firstMeasure || m >= this.firstMeasure + n) this.firstMeasure = Math.max(0, Math.min(32 - n, m - (m % n)));
            this.drawAll();
        }
        cycleInst(d) {
            const p = this.focusPart;
            this.inst[p] = (this.inst[p] + d + 60) % 60;
            this.family = this.fams[this.inst[p]].family;
            this.audition(this.inst[p], this.cursor.pitch);
            this.renderCompose2();
        }
        onKey(e) {
            if (!this.isOpenFlag || !this.bank) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
            // Another of the editor's panels is open over MUSIC (the drawer, a
            // chooser, a sheet), or the key belongs to something outside it:
            // the keys are that panel's.
            if (this.api.keysBlocked && this.api.keysBlocked()) return;
            if (t && t !== document.body && t !== document.documentElement && !this.root.contains(t)) return;
            const k = e.key, ctrl = e.ctrlKey || e.metaKey;
            // Ctrl+S is the editor's own SAVE: write the record first, then let it through.
            if (ctrl && (k === 's' || k === 'S')) { this.flush(); return; }
            e.stopPropagation();
            const handled = this.handleKey(e, k, ctrl);
            if (handled) e.preventDefault();
        }
        handleKey(e, k, ctrl) {
            if (k === 'Escape') { this.back(); return true; }
            if (this.sheetOpen()) return k === ' ';
            // The SET LIST is buttons and selects: only play, save and undo reach
            // through; every edit key is the compose view's.
            if (this.view !== 'compose') {
                const lk = k.toLowerCase();
                if (ctrl && lk === 'z' && !e.shiftKey) { this.doUndo(); return true; }
                if (ctrl && (lk === 'y' || (lk === 'z' && e.shiftKey))) { this.doRedo(); return true; }
                if (!ctrl && lk === 'x') { this.togglePlay(); return true; }
                if (!ctrl && lk === 'y') { this.save(); return true; }
                return false;
            }
            if (ctrl) {
                const lk = k.toLowerCase();
                if (lk === 'z' && !e.shiftKey) { this.doUndo(); return true; }
                if (lk === 'y' || (lk === 'z' && e.shiftKey)) { this.doRedo(); return true; }
                if (lk === 'c') { this.copySel(); return true; }
                if (lk === 'v') { this.pasteAt(this.selection ? this.selection.m0 : Math.floor(this.cursor.step / 16)); return true; }
                return false;
            }
            if (k === '`') { this.typing = !this.typing; this.renderSide(); return true; }
            if (this.typing && Object.prototype.hasOwnProperty.call(TYPING, k.toLowerCase())) {
                const base = this.base[this.focusPart];
                const c0 = base + ((12 - pitchClass(base)) % 12);   // the window's lowest C
                const pitch = Math.min(59, c0 + TYPING[k.toLowerCase()]);
                this.keyPlace(pitch);
                this.moveCursor(this.len, 0);
                return true;
            }
            switch (k) {
                case ' ': case 'x': case 'X': this.togglePlay(); return true;
                case 'a': case 'A': case 'Enter': this.keyPlace(); return true;
                case 'b': case 'B': case 'Delete': case 'Backspace': this.keyErase(); return true;
                case 'y': case 'Y': this.save(); return true;
                case 'ArrowLeft': this.moveCursor(-(e.shiftKey ? 16 : this.len), 0); return true;
                case 'ArrowRight': this.moveCursor(e.shiftKey ? 16 : this.len, 0); return true;
                case 'ArrowUp': this.moveCursor(0, e.shiftKey ? 12 : 1); return true;
                case 'ArrowDown': this.moveCursor(0, e.shiftKey ? -12 : -1); return true;
                case 'PageUp': this.octave(1); return true;
                case 'PageDown': this.octave(-1); return true;
                case 'Tab': this.focus((this.focusPart + (e.shiftKey ? 3 : 1)) % 4); return true;
                case 'q': case 'Q': this.cycleInst(-1); return true;
                case 'e': case 'E': this.cycleInst(1); return true;
                case '[': this.len = LENS[Math.max(0, LENS.indexOf(this.len) - 1)]; this.renderSide(); this.drawAll(); return true;
                case ']': this.len = LENS[Math.min(LENS.length - 1, LENS.indexOf(this.len) + 1)]; this.renderSide(); this.drawAll(); return true;
                case '1': case '2': case '3': case '4': case '5': this.tool = TOOLS[Number(k) - 1].id; this.renderSide(); return true;
                default: return false;
            }
        }

        // ---------- coach ----------
        maybeCoach() {
            let seen = false;
            try { seen = localStorage.getItem('mm-coach-v1') === '1'; } catch (e) {}
            if (seen) return;
            const tips = [
                'Each TAPE up top is one of the cart’s 24 song slots. Pick one to work on.',
                'Tap the big staff to place a note — the note is its sound’s icon. Drag right to hold it.',
                'Tap a bar in the RHYTHM lane to give it a band: the cart’s own backing players.',
                'SET LIST says which tape plays on the title, each stage and each boss. ▶ PLAY hears it all.',
            ];
            let i = 0;
            const box = el('div', 'mm-coach');
            box.style.right = '24px';
            box.style.top = '120px';
            const text = el('div');
            const next = btn('mm-btn', 'NEXT', () => {
                i++;
                if (i >= tips.length) { box.remove(); try { localStorage.setItem('mm-coach-v1', '1'); } catch (e) {} return; }
                text.textContent = tips[i];
                if (i === tips.length - 1) next.textContent = 'GOT IT';
            });
            text.textContent = tips[0];
            box.append(text, next);
            this.root.appendChild(box);
        }
    }

    window.MusicMaker = {
        mount: (container, api) => new MusicMaker(container, api),
        THEMES, ACTIONS, TOOLS, tempoTier, noteName, MODE_CSS,
    };
})();
