// pixel-editor.js — the PIXEL EDITOR: the frames a CHARACTER SHEET sent,
// painted in place of the wave grid (or of the boss lab) at integer zoom. One
// component, one host:
//
//   static/editor/index.html  mounts it in #pixel-editor-host. The character
//                             sheet — reached through the CHARACTER tool, the
//                             enemy picker's pixel button and X PIXELS in the
//                             boss lab — fills its INBOUND tray, and A APPLY
//                             hands the painted frames back, which take the
//                             Atlas Manager's own replace path (replacedFrames
//                             → mergeExtraSpritesIntoAtlas).
//
//   const px = PixelEditor.mount(container, {
//     getFrame: name => canvas | null,   // the frame's pixels at full size (an atlas crop)
//     onApply: (edits, n) => {},         // [{ name, canvas, w, h }]: the working copies, as painted
//     onBack: () => {},                  // B when nothing is pending (omit → B reads CLOSE and is inert)
//     theme: 'xbox' | 'nintendo', layout: 'auto' | 'phone' | 'desktop',
//   });
//   px.load({ subject: { name, code, kind }, frames: [{ name, anim, url? }], active, originLabel, note });
//   px.setTheme(t); px.setNote(text); px.pendingCount(); px.revert(); px.destroy();
//
// Every stroke lands on a working copy of the frame; nothing reaches the host
// until A APPLY, and B REVERT drops the strokes. The palette is read off the
// sprite itself (its most-used colours), so a repaint stays in the art's own
// register; PICK lifts any colour the frame has.
(function () {
    'use strict';

    const NARROW_BELOW = 760;   // px: below this the split stacks — tray · canvas · tools
    const MAX_ZOOM = 16;        // integer zoom cap: a 16x16 projectile fills a phone at ×16
    const PALETTE_MAX = 16;     // swatches read off the sprite, most-used first
    const TOOLS = [
        { id: 'pencil', l: 'PENCIL', sub: 'DRAW' },
        { id: 'fill', l: 'FILL', sub: 'FLOOD' },
        { id: 'pick', l: 'PICK', sub: 'EYEDROP' },
        { id: 'erase', l: 'ERASE', sub: 'CLEAR' }
    ];

    // ================== THEME TOKENS (synced with the CMG launcher) ==================
    // Painted onto the component's own root, the way the boss lab does it, so
    // it reads the same wherever it is mounted.
    const THEMES = {
        xbox: { edge: 'rgba(140,255,110,.35)', ink: '#d9ffcb', tglow: 'rgba(124,255,79,.8)', sel: '#F6FF4A', selglow: 'rgba(246,255,74,.55)', redge: 'rgba(140,255,110,.28)', rink: '#d6ffc4', rsub: 'rgba(220,255,180,.55)', btnbg: 'radial-gradient(circle at 35% 30%, rgba(40,90,45,.5), rgba(6,30,12,.95) 70%)', btnactive: 'radial-gradient(circle at 35% 30%, rgba(60,120,60,.9), rgba(6,30,12,.95) 70%)', gridline: 'rgba(140,255,110,.16)', orbA: 'radial-gradient(circle at 35% 30%, #d6ffd0 0%, #6fd06f 25%, #0e6a2b 60%, #04240f 95%)', orbAe: 'rgba(140,255,110,.6)', orbAi: '#04240f', orbB: 'radial-gradient(circle at 35% 30%, #fdf6b0 0%, #cfc23e 30%, #6a6410 65%, #201d02 100%)', orbBe: 'rgba(246,255,74,.5)', orbBi: '#161300' },
        nintendo: { edge: 'rgba(213,213,216,.3)', ink: '#e9ecf1', tglow: 'rgba(255,59,73,.7)', sel: '#ff5b66', selglow: 'rgba(228,0,15,.5)', redge: '#2a3850', rink: '#e9ecf1', rsub: 'rgba(139,160,194,.7)', btnbg: 'radial-gradient(circle at 35% 30%, rgba(49,58,78,.5), rgba(12,16,26,.95) 70%)', btnactive: 'radial-gradient(circle at 35% 30%, rgba(90,20,26,.9), rgba(20,8,12,.95) 70%)', gridline: 'rgba(213,213,216,.16)', orbA: 'radial-gradient(circle at 35% 30%, #ffd9db 0%, #ff6b76 20%, #e4000f 50%, #4a0308 85%)', orbAe: 'rgba(255,140,148,.75)', orbAi: '#fff', orbB: 'radial-gradient(circle at 35% 30%, #fff 0%, #d5d5d8 25%, #88848b 60%, #2f2f2f 95%)', orbBe: 'rgba(213,213,216,.75)', orbBi: '#e4000f' }
    };

    const CSS = `
.px-root { display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; width: 100%; position: relative; font-family: 'Orbitron', system-ui, sans-serif; color: #fff; }
.px-root button { font-family: inherit; }
.px-root.empty > :not(.px-empty) { display: none !important; }
.px-empty { display: none; flex: 1; align-items: center; justify-content: center; text-align: center; padding: 20px; font-family: 'Share Tech Mono', monospace; font-size: 10px; letter-spacing: .16em; line-height: 1.9; color: var(--rsub); }
.px-root.empty .px-empty { display: flex; }
/* INBOUND tray: what the character sheet handed over — active frame lit, edited frames dotted */
.px-tray { flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 8px; border-bottom: 1px solid var(--edge); }
.px-tray-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .18em; color: var(--rsub); }
.px-tray-title { display: flex; align-items: center; gap: 7px; color: var(--sel); }
.px-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--sel); box-shadow: 0 0 8px var(--selglow); flex-shrink: 0; }
.px-chips-scroll { display: flex; overflow-x: auto; scrollbar-width: none; }
.px-chips-scroll::-webkit-scrollbar { display: none; }
.px-chips { display: flex; gap: 8px; }
.px-chip { position: relative; flex-shrink: 0; display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px 0 6px; border-radius: 10px; cursor: pointer; transition: all .15s; border: 1px solid var(--redge); background: var(--btnbg); color: var(--rink); box-shadow: none; }
.px-chip.on { border-color: var(--sel); background: var(--btnactive); color: var(--sel); box-shadow: 0 0 14px var(--selglow); }
.px-chip-thumb { width: 32px; height: 32px; border-radius: 8px; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.px-chip-thumb canvas { width: 26px; height: 26px; image-rendering: pixelated; display: block; }
.px-chip-txt { display: flex; flex-direction: column; gap: 2px; text-align: left; }
.px-chip-label { font-size: 9px; font-weight: 800; letter-spacing: .08em; white-space: nowrap; }
.px-chip-sub { font-family: 'Share Tech Mono', monospace; font-size: 8px; letter-spacing: .1em; opacity: .7; white-space: nowrap; }
.px-chip-dot { position: absolute; top: 5px; right: 6px; width: 6px; height: 6px; border-radius: 50%; background: var(--sel); box-shadow: 0 0 8px var(--sel); }
/* split: canvas (left) · tools (right); stacked below 760px */
.px-split { flex: 1; min-height: 0; display: flex; flex-direction: row; align-items: stretch; overflow: hidden; }
.px-root.narrow .px-split { flex-direction: column; }
.px-canvas-col { flex: 3 1 0%; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.px-title-row { flex-shrink: 0; display: flex; align-items: baseline; justify-content: center; flex-wrap: wrap; gap: 2px 14px; padding: 8px 12px 2px; }
.px-title { font-size: 15px; font-weight: 800; letter-spacing: .2em; color: var(--ink); text-shadow: 0 0 12px var(--tglow); }
.px-meta { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .16em; color: var(--rsub); }
.px-stage { flex: 1; min-height: 0; position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.px-board { position: relative; flex-shrink: 0; background: repeating-conic-gradient(rgba(255,255,255,.07) 0 25%, transparent 0 50%) 0 0 / 16px 16px; outline: 1px solid var(--redge); box-shadow: 0 0 0 1px rgba(0,0,0,.6), 0 0 40px rgba(0,0,0,.6); }
.px-board canvas { position: absolute; inset: 0; width: 100%; height: 100%; image-rendering: pixelated; touch-action: none; cursor: crosshair; display: block; }
.px-grid { position: absolute; inset: 0; pointer-events: none; background-image: linear-gradient(var(--gridline) 1px, transparent 1px), linear-gradient(90deg, var(--gridline) 1px, transparent 1px); }
.px-root.nogrid .px-grid { display: none; }
.px-cursor, .px-zoom { position: absolute; bottom: 8px; font-family: 'Share Tech Mono', monospace; font-size: 10px; color: var(--rsub); pointer-events: none; }
.px-cursor { left: 12px; } .px-zoom { right: 12px; }
/* tools panel */
.px-panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: rgba(0,0,0,.28); flex: 1 1 280px; max-width: 340px; border-left: 1px solid var(--edge); }
.px-root.narrow .px-panel { flex: 0 0 auto; max-width: none; border-left: none; border-top: 1px solid var(--edge); }
.px-panel-body { min-height: 0; overflow-y: auto; padding: 12px 12px 6px; display: flex; flex-direction: column; gap: 12px; flex: 1 1 0%; scrollbar-width: thin; scrollbar-color: var(--redge) transparent; }
.px-root.narrow .px-panel-body { flex: 0 0 auto; }
.px-sec { display: flex; flex-direction: column; gap: 7px; }
.px-label { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .22em; color: var(--rsub); }
.px-label-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.px-now { display: flex; align-items: center; gap: 6px; letter-spacing: .1em; }
.px-now i { width: 12px; height: 12px; border-radius: 3px; box-shadow: 0 0 0 1px rgba(255,255,255,.2); display: block; }
.px-tools { display: flex; flex-wrap: wrap; gap: 8px; }
.px-tool { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; min-height: 46px; padding: 6px 4px; border-radius: 10px; cursor: pointer; transition: all .15s; flex: 1 1 calc(50% - 4px); border: 1px solid var(--redge); color: var(--rink); background: var(--btnbg); box-shadow: none; }
.px-root.narrow .px-tool { flex: 1 1 calc(25% - 6px); }
.px-tool.on { border-color: var(--sel); color: var(--sel); background: var(--btnactive); box-shadow: 0 0 14px var(--selglow); }
.px-tool-l { font-size: 10px; font-weight: 800; letter-spacing: .1em; }
.px-tool-sub { font-family: 'Share Tech Mono', monospace; font-size: 8px; letter-spacing: .1em; opacity: .7; }
.px-swatches { display: flex; flex-wrap: wrap; gap: 6px; }
.px-swatch { width: 36px; height: 36px; border-radius: 8px; border: none; cursor: pointer; padding: 0; box-shadow: inset 0 0 0 1px rgba(255,255,255,.14); }
.px-swatch.on { box-shadow: 0 0 0 2px var(--sel), 0 0 12px var(--selglow); }
.px-opts { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.px-mini { cursor: pointer; font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .12em; padding: 0 12px; min-height: 36px; border-radius: 8px; background: rgba(0,0,0,.3); border: 1px solid var(--redge); color: var(--rsub); }
.px-mini.on { border-color: var(--sel); color: var(--sel); }
.px-note { font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: .1em; line-height: 1.6; color: var(--rsub); flex: 1; min-width: 140px; }
/* pad footer: A APPLY (n) · B REVERT / BACK */
.px-foot { flex-shrink: 0; display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 6px 22px; padding: 12px 16px 14px; border-top: 1px solid var(--edge); }
.px-foot-btn { display: flex; align-items: center; gap: 9px; background: none; border: none; padding: 0; min-height: 44px; color: var(--rink); font-family: 'Orbitron', sans-serif; font-size: 10px; font-weight: 700; letter-spacing: .16em; cursor: pointer; }
.px-foot-btn.dim { opacity: .45; }
.px-orb { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 900; }
.px-orb-a { background: var(--orbA); border: 1px solid var(--orbAe); color: var(--orbAi); }
.px-foot-btn.glow .px-orb-a { box-shadow: 0 0 12px var(--selglow); }
.px-orb-b { background: var(--orbB); border: 1px solid var(--orbBe); color: var(--orbBi); }
`;

    function ensureStyle() {
        if (document.getElementById('pixel-editor-style')) return;
        const s = document.createElement('style');
        s.id = 'pixel-editor-style';
        s.textContent = CSS;
        document.head.appendChild(s);
    }
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }
    function hex(d, i) { i = i || 0; return '#' + [d[i], d[i + 1], d[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase(); }
    function rgb(h) { return [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16)); }
    // bison_idle0.gif → idle0: the prefix is the character, the extension noise.
    function shortName(n) { return String(n || '').replace(/\.(gif|png)$/i, '').replace(/^[a-zA-Z]+?_/, ''); }
    function plural(n, one) { return n + ' ' + one + (n === 1 ? '' : 'S'); }

    class Editor {
        constructor(container, opts) {
            ensureStyle();
            this.container = container;
            this.opts = opts || {};
            this.state = { tool: 'pencil', color: '#F6FF4A', gridOn: true, narrow: false, stageW: 0, stageH: 0, theme: this.opts.theme === 'nintendo' ? 'nintendo' : 'xbox' };
            this.job = null;        // { subject, frames, active, originLabel, note }
            this.buffers = {};      // frame index → { cv, w, h }: the working copy every stroke lands on
            this.edited = {};       // frame index → true once a stroke landed since the last APPLY / REVERT
            this.palette = [];
            this.painting = false;
            this.build();
            this.applyTheme();
            this.ro = new ResizeObserver(() => this.measure());
            this.ro.observe(this.root);
            this.ro.observe(this.stageEl);
            this.measure(true);
            this.render();
        }

        // ---------- data ----------
        frames() { return this.job ? this.job.frames : []; }
        subject() { return (this.job && this.job.subject) || { name: '', code: '', kind: 'enemy' }; }
        idx() { const n = this.frames().length; if (!n) return 0; const a = this.job.active || 0; return Math.max(0, Math.min(n - 1, a)); }
        buf() { return this.buffers[this.idx()] || null; }
        pendingCount() { return Object.keys(this.edited).length; }
        // The sheet's A: a new subject and tray. Working copies start over.
        load(job) {
            const frames = (job && Array.isArray(job.frames) ? job.frames : []).filter(f => f && typeof f.name === 'string');
            this.job = { subject: (job && job.subject) || null, frames, active: (job && job.active) || 0, originLabel: (job && job.originLabel) || '', note: (job && job.note) || '' };
            this.buffers = {}; this.edited = {}; this.palette = [];
            this.painting = false;
            frames.forEach((f, i) => this.ensureBuffer(i));
            this.readPalette();
            this.render();
        }
        setNote(text) { if (this.job) { this.job.note = text || ''; this.noteEl.textContent = this.job.note; } }
        // The frame's pixels as a working copy: the host's crop first (the
        // atlas, synchronously), a url as the fallback (loads, then paints).
        ensureBuffer(i) {
            if (this.buffers[i]) return true;
            const f = this.frames()[i]; if (!f) return false;
            let src = null;
            try { src = this.opts.getFrame ? this.opts.getFrame(f.name) : null; } catch (e) { src = null; }
            if (src && src.width && src.height) {
                const cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
                cv.getContext('2d').drawImage(src, 0, 0);
                this.buffers[i] = { cv, w: cv.width, h: cv.height };
                return true;
            }
            if (f.url && !f._loading) {
                f._loading = true;
                const img = new Image();
                img.onload = () => {
                    f._loading = false;
                    if (!this.job || this.frames()[i] !== f) return;
                    const cv = document.createElement('canvas'); cv.width = img.naturalWidth || 1; cv.height = img.naturalHeight || 1;
                    cv.getContext('2d').drawImage(img, 0, 0);
                    this.buffers[i] = { cv, w: cv.width, h: cv.height };
                    if (i === this.idx()) this.readPalette();
                    this.render();
                };
                img.onerror = () => { f._loading = false; };
                img.src = f.url;
            }
            return false;
        }
        // The sprite's own colours, most-used first: the swatches a repaint picks from.
        readPalette() {
            const b = this.buf();
            if (!b) { this.palette = []; return; }
            const d = b.cv.getContext('2d').getImageData(0, 0, b.w, b.h).data, m = new Map();
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] < 128) continue;
                const k = hex(d, i);
                m.set(k, (m.get(k) || 0) + 1);
            }
            this.palette = Array.from(m.entries()).sort((a, c) => c[1] - a[1]).slice(0, PALETTE_MAX).map(e => e[0]);
            if (this.palette.length && !this.palette.includes(this.state.color) && !this._colorPicked) this.state.color = this.palette[0];
        }
        setFrame(i) {
            if (!this.job || i === this.idx()) return;
            this.job.active = i;
            this.ensureBuffer(i);
            this.readPalette();
            this.render();
        }

        // ---------- layout ----------
        measure(first) {
            const L = this.opts.layout || 'auto';
            const w = this.root.clientWidth || window.innerWidth;
            const narrow = L === 'phone' ? true : (L === 'desktop' ? false : w < NARROW_BELOW);
            const sw = this.stageEl.clientWidth, sh = this.stageEl.clientHeight;
            const moved = sw !== this.state.stageW || sh !== this.state.stageH;
            this.state.stageW = sw; this.state.stageH = sh;
            if (narrow !== this.state.narrow || first) {
                this.state.narrow = narrow;
                this.root.classList.toggle('narrow', narrow);
            }
            if (moved || first) this.layoutBoard();
        }
        scale() {
            const b = this.buf(), S = this.state;
            if (!b || !S.stageW || !S.stageH) return 1;
            return Math.max(1, Math.min(MAX_ZOOM, Math.floor(Math.min((S.stageW - 32) / b.w, (S.stageH - 32) / b.h))));
        }
        // Integer zoom: the board is w×scale by h×scale, the checker two cells, the grid one.
        layoutBoard() {
            const b = this.buf(), sc = this.scale();
            this.board.style.display = b ? '' : 'none';
            if (!b) return;
            this.board.style.width = (b.w * sc) + 'px';
            this.board.style.height = (b.h * sc) + 'px';
            this.board.style.backgroundSize = (sc * 2) + 'px ' + (sc * 2) + 'px';
            this.gridEl.style.backgroundSize = sc + 'px ' + sc + 'px';
            this.zoomEl.textContent = 'ZOOM ×' + sc;
        }

        // ---------- DOM ----------
        build() {
            const r = this.root = el('div', 'px-root');
            r.appendChild(el('div', 'px-empty', 'NOTHING INBOUND · OPEN A CHARACTER SHEET AND SEND ITS FRAMES HERE'));

            const tray = el('div', 'px-tray');
            const head = el('div', 'px-tray-head');
            const title = el('span', 'px-tray-title');
            title.appendChild(el('span', 'px-dot'));
            this.trayTitle = el('span', '', 'INBOUND');
            title.appendChild(this.trayTitle);
            head.appendChild(title);
            this.originEl = el('span');
            head.appendChild(this.originEl);
            tray.appendChild(head);
            const scroll = el('div', 'px-chips-scroll');
            this.chipsEl = el('div', 'px-chips');
            scroll.appendChild(this.chipsEl);
            tray.appendChild(scroll);
            r.appendChild(tray);

            const split = el('div', 'px-split');
            const col = el('div', 'px-canvas-col');
            const titleRow = el('div', 'px-title-row');
            this.titleEl = el('div', 'px-title');
            this.metaEl = el('div', 'px-meta');
            titleRow.appendChild(this.titleEl); titleRow.appendChild(this.metaEl);
            col.appendChild(titleRow);
            const stage = this.stageEl = el('div', 'px-stage');
            const board = this.board = el('div', 'px-board');
            const cv = this.canvas = el('canvas');
            cv.addEventListener('pointerdown', e => this.onDown(e));
            cv.addEventListener('pointermove', e => this.onMove(e));
            cv.addEventListener('pointerup', () => this.onUp());
            cv.addEventListener('pointercancel', () => this.onUp());
            cv.addEventListener('pointerleave', () => this.onLeave());
            board.appendChild(cv);
            this.gridEl = el('div', 'px-grid');
            board.appendChild(this.gridEl);
            stage.appendChild(board);
            this.cursorEl = el('div', 'px-cursor', 'X — · Y —');
            this.zoomEl = el('div', 'px-zoom', 'ZOOM ×1');
            stage.appendChild(this.cursorEl); stage.appendChild(this.zoomEl);
            col.appendChild(stage);
            split.appendChild(col);

            const panel = el('div', 'px-panel');
            const body = el('div', 'px-panel-body');
            const toolsSec = el('div', 'px-sec');
            toolsSec.appendChild(el('div', 'px-label', 'TOOLS'));
            this.toolsEl = el('div', 'px-tools');
            toolsSec.appendChild(this.toolsEl);
            body.appendChild(toolsSec);
            const palSec = el('div', 'px-sec');
            const palRow = el('div', 'px-label px-label-row');
            palRow.appendChild(el('span', '', 'PALETTE · FROM SPRITE'));
            const now = el('span', 'px-now');
            this.nowSwatch = el('i');
            this.nowLabel = el('span');
            now.appendChild(this.nowSwatch); now.appendChild(this.nowLabel);
            palRow.appendChild(now);
            palSec.appendChild(palRow);
            this.swatchesEl = el('div', 'px-swatches');
            palSec.appendChild(this.swatchesEl);
            body.appendChild(palSec);
            const opts = el('div', 'px-opts');
            this.gridBtn = el('button', 'px-mini on', 'GRID ON');
            this.gridBtn.onclick = () => this.toggleGrid();
            opts.appendChild(this.gridBtn);
            this.noteEl = el('span', 'px-note');
            opts.appendChild(this.noteEl);
            body.appendChild(opts);
            panel.appendChild(body);
            const foot = el('div', 'px-foot');
            this.applyBtn = el('button', 'px-foot-btn');
            this.applyBtn.appendChild(el('span', 'px-orb px-orb-a', 'A'));
            this.applyLabel = el('span', '', 'APPLY');
            this.applyBtn.appendChild(this.applyLabel);
            this.applyBtn.onclick = () => this.apply();
            foot.appendChild(this.applyBtn);
            this.revertBtn = el('button', 'px-foot-btn');
            this.revertBtn.appendChild(el('span', 'px-orb px-orb-b', 'B'));
            this.revertLabel = el('span', '', 'REVERT');
            this.revertBtn.appendChild(this.revertLabel);
            this.revertBtn.onclick = () => this.revert();
            foot.appendChild(this.revertBtn);
            panel.appendChild(foot);
            split.appendChild(panel);
            r.appendChild(split);
            this.container.appendChild(r);
        }
        applyTheme() {
            const t = THEMES[this.state.theme] || THEMES.xbox;
            for (const k in t) this.root.style.setProperty('--' + k, t[k]);
        }
        setTheme(t) { this.state.theme = t === 'nintendo' ? 'nintendo' : 'xbox'; this.applyTheme(); }
        toggleGrid() {
            this.state.gridOn = !this.state.gridOn;
            this.root.classList.toggle('nogrid', !this.state.gridOn);
            this.gridBtn.textContent = this.state.gridOn ? 'GRID ON' : 'GRID OFF';
            this.gridBtn.classList.toggle('on', this.state.gridOn);
        }

        // ---------- render ----------
        render() {
            const frames = this.frames();
            this.root.classList.toggle('empty', !frames.length);
            if (!frames.length) return;
            this.renderTray(); this.renderTitle(); this.renderTools(); this.renderSwatches(); this.renderFoot();
            this.noteEl.textContent = this.job.note || '';
            this.draw();
            this.layoutBoard();
        }
        renderTray() {
            const frames = this.frames(), i = this.idx(), sub = this.subject();
            this.trayTitle.textContent = 'INBOUND · ' + String(sub.name || '').toUpperCase() + ' · ' + plural(frames.length, 'FRAME');
            this.originEl.textContent = this.job.originLabel || '';
            this.chipsEl.innerHTML = '';
            frames.forEach((f, k) => {
                const chip = el('button', 'px-chip' + (k === i ? ' on' : ''));
                const thumb = el('span', 'px-chip-thumb');
                const b = this.buffers[k];
                if (b) {
                    const tc = el('canvas'); tc.width = 26; tc.height = 26;
                    const ctx = tc.getContext('2d'); ctx.imageSmoothingEnabled = false;
                    const sc = Math.min(26 / b.w, 26 / b.h), dw = Math.max(1, Math.round(b.w * sc)), dh = Math.max(1, Math.round(b.h * sc));
                    ctx.drawImage(b.cv, 0, 0, b.w, b.h, Math.floor((26 - dw) / 2), Math.floor((26 - dh) / 2), dw, dh);
                    thumb.appendChild(tc);
                }
                chip.appendChild(thumb);
                const txt = el('span', 'px-chip-txt');
                txt.appendChild(el('span', 'px-chip-label', shortName(f.name).toUpperCase()));
                txt.appendChild(el('span', 'px-chip-sub', f.anim || ''));
                chip.appendChild(txt);
                if (this.edited[k]) { const dot = el('span', 'px-chip-dot'); dot.title = 'Edited — not applied yet'; chip.appendChild(dot); }
                chip.title = f.name;
                chip.onclick = () => this.setFrame(k);
                this.chipsEl.appendChild(chip);
            });
        }
        renderTitle() {
            const f = this.frames()[this.idx()] || {}, b = this.buf(), i = this.idx();
            this.titleEl.textContent = shortName(f.name).toUpperCase();
            this.metaEl.textContent = (f.name || '') + (b ? ' · ' + b.w + '×' + b.h + ' PX' : ' · LOADING') + (f.anim ? ' · ' + f.anim : '') + (this.edited[i] ? ' · EDITED' : '');
        }
        renderTools() {
            this.toolsEl.innerHTML = '';
            TOOLS.forEach(t => {
                const b = el('button', 'px-tool' + (t.id === this.state.tool ? ' on' : ''));
                b.appendChild(el('span', 'px-tool-l', t.l));
                b.appendChild(el('span', 'px-tool-sub', t.sub));
                b.onclick = () => { this.state.tool = t.id; this.renderTools(); this.renderSwatches(); };
                this.toolsEl.appendChild(b);
            });
        }
        renderSwatches() {
            const S = this.state;
            this.nowSwatch.style.background = S.color;
            this.nowLabel.textContent = S.color + (S.tool === 'erase' ? ' · ERASING' : '');
            this.swatchesEl.innerHTML = '';
            this.palette.forEach(c => {
                const b = el('button', 'px-swatch' + (c === S.color ? ' on' : ''));
                b.style.background = c; b.title = c;
                b.onclick = () => { S.color = c; this._colorPicked = true; if (S.tool === 'erase' || S.tool === 'pick') S.tool = 'pencil'; this.renderTools(); this.renderSwatches(); };
                this.swatchesEl.appendChild(b);
            });
        }
        renderFoot() {
            const n = this.pendingCount();
            this.applyLabel.textContent = 'APPLY' + (n ? ' (' + n + ')' : '');
            this.applyBtn.classList.toggle('dim', !n);
            this.applyBtn.classList.toggle('glow', n > 0);
            this.revertLabel.textContent = n ? 'REVERT' : (this.opts.onBack ? 'BACK' : 'CLOSE');
            this.revertBtn.classList.toggle('dim', !n && !this.opts.onBack);
        }
        draw() {
            const cv = this.canvas, b = this.buf();
            if (!b) { cv.width = 1; cv.height = 1; return; }
            if (cv.width !== b.w || cv.height !== b.h) { cv.width = b.w; cv.height = b.h; }
            const ctx = cv.getContext('2d');
            ctx.clearRect(0, 0, b.w, b.h);
            ctx.drawImage(b.cv, 0, 0);
        }

        // ---------- painting ----------
        pix(e) {
            const b = this.buf(); if (!b) return null;
            const r = this.canvas.getBoundingClientRect();
            if (!r.width || !r.height) return null;
            const x = Math.floor((e.clientX - r.left) / r.width * b.w), y = Math.floor((e.clientY - r.top) / r.height * b.h);
            if (x < 0 || y < 0 || x >= b.w || y >= b.h) return null;
            return { x, y };
        }
        onDown(e) {
            const p = this.pix(e); if (!p) return;
            e.preventDefault();
            this.painting = true;
            try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
            this.act(p);
        }
        onMove(e) {
            const p = this.pix(e);
            this.cursorEl.textContent = p ? 'X ' + p.x + ' · Y ' + p.y : 'X — · Y —';
            if (this.painting && p && (this.state.tool === 'pencil' || this.state.tool === 'erase')) this.act(p);
        }
        onUp() { this.painting = false; }
        onLeave() { if (!this.painting) this.cursorEl.textContent = 'X — · Y —'; }
        act(p) {
            const b = this.buf(); if (!b) return;
            const ctx = b.cv.getContext('2d'), t = this.state.tool;
            if (t === 'pick') {
                const d = ctx.getImageData(p.x, p.y, 1, 1).data;
                if (d[3]) { this.state.color = hex(d); this._colorPicked = true; this.state.tool = 'pencil'; this.renderTools(); this.renderSwatches(); }
                return;
            }
            if (t === 'pencil') { ctx.fillStyle = this.state.color; ctx.clearRect(p.x, p.y, 1, 1); ctx.fillRect(p.x, p.y, 1, 1); }
            else if (t === 'erase') ctx.clearRect(p.x, p.y, 1, 1);
            else if (t === 'fill') this.flood(ctx, b, p);
            this.draw();
            const i = this.idx();
            if (!this.edited[i]) { this.edited[i] = true; this.renderTray(); this.renderFoot(); }
            this.renderTitle();
        }
        // Flood fill over an exact RGBA match, four-way.
        flood(ctx, b, p) {
            const img = ctx.getImageData(0, 0, b.w, b.h), d = img.data, i0 = (p.y * b.w + p.x) * 4;
            const tg = [d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3]], col = rgb(this.state.color);
            if (tg[3] > 0 && tg[0] === col[0] && tg[1] === col[1] && tg[2] === col[2] && tg[3] === 255) return;
            const seen = new Uint8Array(b.w * b.h), stack = [[p.x, p.y]];
            while (stack.length) {
                const [x, y] = stack.pop();
                if (x < 0 || y < 0 || x >= b.w || y >= b.h) continue;
                const k = y * b.w + x; if (seen[k]) continue; seen[k] = 1;
                const i = k * 4;
                if (d[i] !== tg[0] || d[i + 1] !== tg[1] || d[i + 2] !== tg[2] || d[i + 3] !== tg[3]) continue;
                d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
                stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
            }
            ctx.putImageData(img, 0, 0);
        }

        // ---------- A / B ----------
        // A APPLY: the painted working copies go to the host (copies, so a
        // stroke after the hand-over cannot reach into what it wrote).
        apply() {
            const idxs = Object.keys(this.edited).map(Number);
            if (!idxs.length) return;
            const frames = this.frames(), edits = [];
            idxs.forEach(i => {
                const f = frames[i], b = this.buffers[i]; if (!f || !b) return;
                const cv = document.createElement('canvas'); cv.width = b.w; cv.height = b.h;
                cv.getContext('2d').drawImage(b.cv, 0, 0);
                edits.push({ name: f.name, canvas: cv, w: b.w, h: b.h });
            });
            if (this.opts.onApply) this.opts.onApply(edits, edits.length);
            this.edited = {};
            this.render();
        }
        // B: REVERT drops every stroke (the frames reload from the host); with nothing pending, BACK.
        revert() {
            const idxs = Object.keys(this.edited).map(Number);
            if (idxs.length) {
                idxs.forEach(i => { delete this.buffers[i]; });
                this.edited = {};
                this.frames().forEach((f, i) => this.ensureBuffer(i));
                this.readPalette();
                this.render();
            } else if (this.opts.onBack) this.opts.onBack();
        }
        destroy() {
            if (this.ro) this.ro.disconnect();
            this.root.remove();
        }
    }

    window.PixelEditor = {
        mount: (container, opts) => new Editor(container, opts),
        TOOLS, THEMES
    };
})();
