// EXTRACT MODE — save any on-screen player/enemy/boss to the shared character
// library (/characters + /atlases in the evil-invaders RTDB).
//
// Two consumers share this file:
//   - The level editor (static/editor/index.html) uses the pure helpers
//     (collectFrameNames / packFrames / publishRecord) for its PUBLISH TO
//     LIBRARY button and its grid EXTRACT tool.
//   - The hosted game page (routes/games/2028-ai.tsx) also gets the in-game
//     runtime below: an EXTRACT MODE button rides the standalone PAUSE panel
//     (#cmg-pause-panel, hand-patched into game.bundle.js); while the game
//     loop sleeps, a DOM overlay hit-tests the frozen PhaserGameScene so any
//     sprite can be clicked, inspected and published.
//
// The library schema mirrors spriteX (see editor/index.html publish notes):
//   atlases/{name}    => { json: JSON.stringify(atlasJson), png: dataURL }
//   characters/{name} => the character record verbatim + { name, textureKey }
// The atlas JSON is stored as a STRING so RTDB never mangles frame-name keys.
(function () {
    'use strict';

    var DEFAULT_DB = 'https://evil-invaders-default-rtdb.firebaseio.com';

    function dbURL() {
        var cfg = window.__FIREBASE_CONFIG__ || window.firebaseConfig;
        return (cfg && cfg.databaseURL) || DEFAULT_DB;
    }

    // Every frame name a character record references, in order, deduped —
    // the same depth<=2 walk the editor's publish flow uses, so player
    // (texture + shoot*/barrier frame lists), enemy (texture) and boss
    // (anim.*) records all collect correctly.
    function collectFrameNames(record) {
        var wanted = [];
        var seen = new Set();
        var collect = function (obj, depth) {
            if (!obj || typeof obj !== 'object' || depth > 2) return;
            for (var k in obj) {
                var v = obj[k];
                if (Array.isArray(v) && v.length && v.every(function (s) { return typeof s === 'string'; })) {
                    for (var i = 0; i < v.length; i++) {
                        if (!seen.has(v[i])) { seen.add(v[i]); wanted.push(v[i]); }
                    }
                } else if (v && typeof v === 'object') collect(v, depth + 1);
            }
        };
        collect(record, 0);
        return wanted;
    }

    // A cheap content hash of one cropped frame, used to spot the duplicate
    // frames Dezaemon art is full of (an enemy whose four animation slots
    // hold the same picture) so they share one rect in the packed atlas.
    function frameHash(sprite) {
        var d;
        try {
            d = sprite.canvas.getContext('2d').getImageData(0, 0, sprite.w, sprite.h).data;
        } catch (e) {
            return null; // tainted canvas — treat as unique
        }
        var h = 2166136261;
        for (var i = 0; i < d.length; i++) {
            h ^= d[i];
            h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
        }
        return sprite.w + 'x' + sprite.h + ':' + h;
    }

    // How many of a record's frames are visually distinct. Frame lists that
    // collapse to one image do not animate however they are published — the
    // info cards surface this so a static character reads as source art
    // rather than a broken export.
    function uniqueFrameCount(sprites) {
        var seen = {};
        var n = 0;
        for (var i = 0; i < sprites.length; i++) {
            var h = frameHash(sprites[i]);
            if (h === null) { n++; continue; }
            if (!seen[h]) { seen[h] = 1; n++; }
        }
        return n;
    }

    // Shelf-pack cropped frames into one canvas + TexturePacker-style JSON
    // (the same 1024-wide / 2px-pad scheme as the editor's atlas builder).
    // sprites: [{ key, canvas, w, h }]; app tags meta.app for provenance.
    // Pixel-identical frames are packed once and shared by every name that
    // references them, so a four-slot static enemy costs one image.
    function packFrames(sprites, app) {
        var sorted = sprites.slice().sort(function (a, b) { return b.h - a.h; });
        var MW = 1024, P = 2;
        var cx = P, cy = P, rh = 0, fh = 0;
        var pos = {};
        var rectByHash = {};
        var drawList = [];
        sorted.forEach(function (s) {
            var h = frameHash(s);
            if (h !== null && rectByHash[h]) { pos[s.key] = rectByHash[h]; return; }
            if (cx + s.w + P > MW) { cy += rh + P; cx = P; rh = 0; }
            var rect = { x: cx, y: cy };
            pos[s.key] = rect;
            if (h !== null) rectByHash[h] = rect;
            drawList.push(s);
            cx += s.w + P;
            rh = Math.max(rh, s.h);
            fh = Math.max(fh, cy + s.h + P);
        });
        var canvas = document.createElement('canvas');
        canvas.width = MW;
        canvas.height = fh;
        var nc = canvas.getContext('2d');
        var outFrames = {};
        drawList.forEach(function (s) {
            var p = pos[s.key];
            nc.drawImage(s.canvas, p.x, p.y);
        });
        sorted.forEach(function (s) {
            var p = pos[s.key];
            outFrames[s.key] = {
                frame: { x: p.x, y: p.y, w: s.w, h: s.h }, rotated: false, trimmed: false,
                spriteSourceSize: { x: 0, y: 0, w: s.w, h: s.h }, sourceSize: { w: s.w, h: s.h },
            };
        });
        var atlasJson = {
            frames: outFrames,
            meta: { app: app || 'shmupX extract mode', version: '1.0', image: 'atlas.png', format: 'RGBA8888', scale: '1', size: { w: canvas.width, h: canvas.height } },
        };
        return { canvas: canvas, atlasJson: atlasJson };
    }

    // getFrame(name) with the .gif/.png extension-swap fallback the runtime's
    // resolveFrame applies.
    function lookupFrame(getFrame, fk) {
        var f = getFrame(fk);
        if (!f) {
            var alt = fk.endsWith('.gif') ? fk.slice(0, -4) + '.png'
                : fk.endsWith('.png') ? fk.slice(0, -4) + '.gif' : null;
            if (alt) f = getFrame(alt);
        }
        return f;
    }

    // Crop every frame the record references through getFrame(name) ->
    // { image, x, y, w, h } | null.
    function cropFrames(record, getFrame) {
        var wanted = collectFrameNames(record);
        var sprites = [];
        var missing = [];
        for (var i = 0; i < wanted.length; i++) {
            var fk = wanted[i];
            var f = lookupFrame(getFrame, fk);
            if (!f) { missing.push(fk); continue; }
            var c = document.createElement('canvas');
            c.width = f.w;
            c.height = f.h;
            c.getContext('2d').drawImage(f.image, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
            sprites.push({ key: fk, canvas: c, w: f.w, h: f.h });
        }
        return { sprites: sprites, missing: missing };
    }

    // Drop frame names the atlas does not carry from every frame list in the
    // record (same depth<=2 walk as collectFrameNames). A published character
    // must be self-consistent: the library editor animates straight off these
    // lists, so a name with no frame behind it stalls the preview on whatever
    // was drawn last. A list left with nothing is removed outright rather than
    // emptied — an absent list falls back to the consumer's defaults, while a
    // present-but-empty one renders a frameless sprite.
    function pruneFrameNames(record, missing) {
        if (!missing || !missing.length) return record;
        var drop = {};
        for (var i = 0; i < missing.length; i++) drop[missing[i]] = 1;
        var walk = function (obj, depth) {
            if (!obj || typeof obj !== 'object' || depth > 2) return;
            for (var k in obj) {
                var v = obj[k];
                if (Array.isArray(v) && v.length && v.every(function (x) { return typeof x === 'string'; })) {
                    var kept = v.filter(function (x) { return !drop[x]; });
                    if (kept.length === v.length) continue;
                    if (kept.length) obj[k] = kept;
                    else delete obj[k];
                } else if (v && typeof v === 'object') walk(v, depth + 1);
            }
        };
        walk(record, 0);
        return record;
    }

    // PUT the packed atlas + the record. Resolves the published name, or null
    // when an existing character was kept (overwrite declined).
    // opts: { name, record, canvas, atlasJson, db?, missing?, confirmOverwrite? }
    async function publishRecord(opts) {
        var name = opts.name;
        var record = JSON.parse(JSON.stringify(opts.record));
        delete record._enemyKey; // runtime-only tag createEnemy leaves on recipe entries
        if (!record.name) record.name = name;
        record.textureKey = name;
        pruneFrameNames(record, opts.missing);

        if (opts.atlasJson && opts.atlasJson.frames && opts.atlasJson.frames.__BASE) {
            throw new Error("'__BASE' is a reserved Phaser frame name");
        }

        var DB = opts.db || dbURL();
        var existing = await fetch(DB + '/characters/' + encodeURIComponent(name) + '.json')
            .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
        if (existing) {
            var ok = opts.confirmOverwrite
                ? opts.confirmOverwrite(name)
                : confirm("'" + name + "' already exists in the library. Overwrite it?");
            if (!ok) return null;
        }
        // One multi-path update so atlas + record land atomically — two
        // sequential PUTs could strand an old record on a new atlas.
        var body = {};
        body['atlases/' + name] = { json: JSON.stringify(opts.atlasJson), png: opts.canvas.toDataURL('image/png') };
        body['characters/' + name] = record;
        var res = await fetch(DB + '/.json', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return name;
    }

    // ECMAScript keywords would break the generated /characters module's
    // `export const <name>` line; the second set is names the characters
    // module reserves for its own exports (see routes/characters/index.ts) —
    // a character published under one could never be imported by name.
    var JS_KEYWORDS = ('await break case catch class const continue debugger delete do else enum export'
        + ' extends false finally for function if implements import in instanceof interface let new null'
        + ' package private protected public return static super switch this throw true try typeof var'
        + ' void while with yield').split(' ');
    var MODULE_RESERVED = ('default character Character Adopt CHARACTERS Game Scene Spawner Sprite Text'
        + ' TileSprite Rectangle Container ArcadePhysics ArcadeCollider').split(' ');

    function validName(name) {
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
    }

    // The reserved word a name collides with, or null when it is fine.
    function reservedName(name) {
        if (JS_KEYWORDS.indexOf(name) !== -1) return name;
        if (MODULE_RESERVED.indexOf(name) !== -1) return name;
        return null;
    }

    function suggestName(raw) {
        var s = String(raw || 'character').replace(/[^A-Za-z0-9_]/g, '_');
        return /^[A-Za-z_]/.test(s) ? s : '_' + s;
    }

    // Where the level editor lives. '' means this same origin; null means
    // there is none to link to — a packaged export has no /editor/ route, so
    // the deep-link button is hidden unless a host origin was configured at
    // build time (tools/build-level --editor-origin).
    function editorOrigin() {
        var o = window.__SHMUP_EDITOR_ORIGIN__;
        if (typeof o === 'string' && o) return o.replace(/\/+$/, '');
        return window.__EXPORTED_LEVEL_APP__ ? null : '';
    }

    // Deep link into the level editor's CHARACTER LIBRARY EDITOR modal.
    function libraryEditorURL(gameId, characterName, origin) {
        return (origin || '') + '/editor/?game=' + encodeURIComponent(gameId || '2028-ai')
            + '&libraryEditor=1&character=' + encodeURIComponent(characterName);
    }

    window.ShmupExtract = {
        dbURL: dbURL,
        collectFrameNames: collectFrameNames,
        cropFrames: cropFrames,
        packFrames: packFrames,
        publishRecord: publishRecord,
        pruneFrameNames: pruneFrameNames,
        uniqueFrameCount: uniqueFrameCount,
        validName: validName,
        reservedName: reservedName,
        suggestName: suggestName,
        libraryEditorURL: libraryEditorURL,
        editorOrigin: editorOrigin,
    };

    // =====================================================================
    // In-game extract mode. Everything below only arms on a page that hosts
    // a Phaser game (the standalone PAUSE panel appears there); the editor
    // never creates #cmg-pause-panel, so it only gets the helpers above.
    // =====================================================================

    var ui = null;        // { overlay, hint, box, card }
    var pausePanel = null;
    var picked = null;    // current selection: { sprite, kind, key, record, textureKey }
    // Embedded in the cmg launcher there is no PAUSE panel to ride, so extract
    // mode owns the pause itself. `launcherWantsPaused` mirrors the last
    // cmg-pause the launcher sent, so exiting restores ITS intent rather than
    // blindly resuming under an open Guide.
    var launcherWantsPaused = false;

    function embedded() {
        try { return window.parent !== window; } catch (e) { return true; }
    }

    // The bundle owns one `cmgPaused` boolean plus per-Sound bookkeeping, so
    // route through its closure when the hand patch exposed it; the fallback
    // keeps extract mode usable against an unpatched bundle.
    function setPaused(p) {
        if (typeof window.__cmgSetPaused === 'function') {
            try { window.__cmgSetPaused(p); return; } catch (e) { }
        }
        var game = phaserGame();
        if (!game) return;
        try { p ? game.loop.sleep() : game.loop.wake(); } catch (e) { }
        try {
            var ctx = game.sound && game.sound.context;
            if (ctx) p ? ctx.suspend() : ctx.resume();
        } catch (e2) { }
    }

    function phaserGame() {
        return window.__PHASER_4_GAME__ || window.__PHASER_GAME__ || null;
    }

    function activeGameScene() {
        var game = phaserGame();
        if (!game || !game.scene) return null;
        var sc = null;
        try { sc = game.scene.getScene('PhaserGameScene'); } catch (e) { }
        if (!sc || !sc.sys || !sc.sys.settings || !sc.sys.settings.active) return null;
        return sc;
    }

    function gameIdFromPath() {
        var m = location.pathname.match(/\/games\/([^/?#]+)/);
        return m ? m[1] : '2028-ai';
    }

    // Screen(local CSS px, post-rotation-remap) -> game viewport coords. The
    // FIT_PORTRAIT patch rewrites pointer events and the canvas rect into the
    // same rotated-local space, so this mapping holds in both orientations.
    function canvasMetrics() {
        var game = phaserGame();
        var canvas = game && game.canvas;
        if (!canvas) return null;
        var rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        var gw = (game.scale && game.scale.gameSize && game.scale.gameSize.width) || canvas.width;
        var gh = (game.scale && game.scale.gameSize && game.scale.gameSize.height) || canvas.height;
        return { rect: rect, gw: gw, gh: gh };
    }

    function worldPointFromEvent(ev, scene) {
        var m = canvasMetrics();
        if (!m) return null;
        var gx = (ev.clientX - m.rect.left) * (m.gw / m.rect.width);
        var gy = (ev.clientY - m.rect.top) * (m.gh / m.rect.height);
        var cam = scene.cameras && scene.cameras.main;
        if (cam && typeof cam.getWorldPoint === 'function') {
            try { return cam.getWorldPoint(gx, gy); } catch (e) { }
        }
        return { x: gx, y: gy };
    }

    function screenRectFromBounds(b, scene) {
        var m = canvasMetrics();
        if (!m) return null;
        var cam = scene.cameras && scene.cameras.main;
        var vx = 0, vy = 0, vw = m.gw, vh = m.gh;
        if (cam && cam.worldView && cam.worldView.width > 0) {
            vx = cam.worldView.x; vy = cam.worldView.y;
            vw = cam.worldView.width; vh = cam.worldView.height;
        }
        return {
            left: m.rect.left + (b.x - vx) * (m.rect.width / vw),
            top: m.rect.top + (b.y - vy) * (m.rect.height / vh),
            width: b.width * (m.rect.width / vw),
            height: b.height * (m.rect.height / vh),
        };
    }

    // A record for a sprite the recipe doesn't describe (boss parts, bullets,
    // items, UI…) — enemy-shaped, so the library can still hold it. '__BASE'
    // (Phaser's whole-texture frame on tile sprites, text, plain images) is
    // reserved — remap it to a per-texture synthetic name that
    // textureFrameSource resolves back to the base frame.
    function baseFrameAlias(textureKey) {
        return String(textureKey).replace(/[^A-Za-z0-9_]/g, '_') + '.png';
    }

    function synthesizedRecord(sprite) {
        var frameName = sprite.frame && sprite.frame.name;
        if (frameName === '__BASE' && sprite.texture) frameName = baseFrameAlias(sprite.texture.key);
        var rec = { name: sprite.getData && sprite.getData('name') || frameName || sprite.texture.key };
        var d = function (k) { return sprite.getData ? sprite.getData(k) : undefined; };
        if (typeof d('maxHp') === 'number') rec.hp = d('maxHp');
        if (typeof d('score') === 'number') rec.score = d('score');
        if (typeof d('speed') === 'number') rec.speed = d('speed');
        if (typeof d('interval') === 'number') rec.interval = d('interval');
        var frames = d('frames');
        rec.texture = Array.isArray(frames) && frames.length ? frames.slice()
            : (frameName ? [frameName] : []);
        // Dezaemon boss parts are all stamped "dezaPart" — key the suggested
        // name by their art so two parts don't invite overwriting each other.
        if (rec.name === 'dezaPart' && rec.texture[0]) {
            rec.name = 'dezaPart_' + rec.texture[0].replace(/\.\w+$/, '');
        }
        return rec;
    }

    // All the objects a click may land on, most-prominent kinds first.
    function extractables(scene) {
        var out = [];
        var recipe = scene.recipe || {};
        if (scene.playerSprite && scene.playerSprite.active && scene.playerSprite.visible) {
            out.push({
                sprite: scene.playerSprite, kind: 'player', key: 'playerData',
                record: recipe.playerData || synthesizedRecord(scene.playerSprite),
            });
        }
        var list = scene.enemies || [];
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            if (!e || !e.active || !e.visible || !e.getBounds) continue;
            if (e.getData('type') === 'boss') {
                // The hand-patched Akuma swap keeps bossStageId but reads its
                // record from bossData.bossExtra — mirror that here.
                var bossKey = scene.bossIsGoki ? 'bossExtra' : 'boss' + String(scene.bossStageId);
                out.push({
                    sprite: e, kind: 'boss', key: bossKey,
                    record: (recipe.bossData && recipe.bossData[bossKey]) || synthesizedRecord(e),
                });
            } else {
                var letter = e.getData('enemyKey');
                var rec = letter && recipe.enemyData && recipe.enemyData['enemy' + letter];
                out.push({
                    sprite: e, kind: 'enemy', key: letter ? 'enemy' + letter : (e.getData('name') || 'sprite'),
                    record: rec || synthesizedRecord(e),
                });
            }
        }
        return out;
    }

    function hitTest(candidates, wp, pad) {
        var best = null;
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            var b;
            try { b = c.sprite.getBounds(); } catch (e) { continue; }
            if (wp.x < b.x - pad || wp.x > b.right + pad || wp.y < b.y - pad || wp.y > b.bottom + pad) continue;
            var depth = c.sprite.depth || 0;
            if (!best || depth >= best.depth) best = { c: c, depth: depth, bounds: b };
        }
        return best;
    }

    // Fallback sweep of the whole display list ("click ANY gameObject").
    function hitTestDisplayList(scene, wp, exclude) {
        var kids = (scene.children && scene.children.list) || [];
        for (var i = kids.length - 1; i >= 0; i--) {
            var s = kids[i];
            if (!s || !s.visible || !s.texture || !s.getBounds || exclude.indexOf(s) !== -1) continue;
            var b;
            try { b = s.getBounds(); } catch (e) { continue; }
            if (wp.x < b.x || wp.x > b.right || wp.y < b.y || wp.y > b.bottom) continue;
            return {
                c: { sprite: s, kind: 'sprite', key: s.texture.key + '/' + (s.frame ? s.frame.name : '?'), record: synthesizedRecord(s) },
                depth: s.depth || 0,
                bounds: b,
            };
        }
        return null;
    }

    // { image, x, y, w, h } lookup against a live Phaser texture.
    function textureFrameSource(scene, textureKey) {
        var tex = null;
        try { tex = scene.textures.get(textureKey); } catch (e) { }
        return function (frameName) {
            if (!tex || !tex.has) return null;
            // synthesizedRecord's alias for the reserved whole-texture frame
            if (frameName === baseFrameAlias(textureKey) && !tex.has(frameName) && tex.has('__BASE')) {
                frameName = '__BASE';
            }
            if (!tex.has(frameName)) return null;
            var fr = tex.get(frameName);
            if (!fr) return null;
            var img = (fr.source && (fr.source.image || fr.source.canvas)) || null;
            if (!img) return null;
            return {
                image: img,
                x: fr.cutX !== undefined ? fr.cutX : fr.x,
                y: fr.cutY !== undefined ? fr.cutY : fr.y,
                w: fr.cutWidth !== undefined ? fr.cutWidth : fr.width,
                h: fr.cutHeight !== undefined ? fr.cutHeight : fr.height,
            };
        };
    }

    // ---------------- DOM ----------------

    var BTN_CSS = 'padding:8px 18px;border-radius:6px;border:1px solid rgba(255,255,255,.45);'
        + 'background:rgba(255,255,255,.12);color:#fff;font-family:inherit;font-size:11px;'
        + 'letter-spacing:.18em;text-indent:.18em;cursor:pointer;';

    function makeButton(label, onClick) {
        var b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = BTN_CSS;
        b.addEventListener('click', onClick);
        return b;
    }

    function ensureUI() {
        if (ui) return ui;
        var overlay = document.createElement('div');
        overlay.id = 'shmup-extract-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;display:none;cursor:crosshair;'
            + "font-family:'Orbitron',system-ui,sans-serif;color:#fff;";

        // pointer-events:none so sprites at the top of the screen stay
        // clickable through the hint text; only EXIT itself takes clicks.
        var hint = document.createElement('div');
        hint.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);'
            + 'display:flex;align-items:center;gap:10px;background:rgba(70,70,70,.92);border-radius:6px;'
            + 'padding:7px 12px;font-size:10px;letter-spacing:.2em;white-space:nowrap;'
            + 'box-shadow:0 6px 24px rgba(0,0,0,.5);pointer-events:none;';
        var hintText = document.createElement('span');
        hintText.textContent = 'EXTRACT MODE · TAP ANY OBJECT';
        var exitBtn = makeButton('EXIT', function (ev) { ev.stopPropagation(); exitExtractMode(); });
        exitBtn.style.padding = '4px 10px';
        exitBtn.style.pointerEvents = 'auto';
        exitBtn.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
        hint.appendChild(hintText);
        hint.appendChild(exitBtn);
        overlay.appendChild(hint);

        var box = document.createElement('div');
        box.style.cssText = 'position:absolute;display:none;border:2px solid #F6FF4A;border-radius:3px;'
            + 'box-shadow:0 0 14px rgba(246,255,74,.6);pointer-events:none;';
        overlay.appendChild(box);

        var card = document.createElement('div');
        card.style.cssText = 'position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:none;'
            + 'background:rgba(70,70,70,.94);border-radius:8px;padding:14px 18px 16px;'
            + 'width:min(300px,86vw);text-align:center;box-shadow:0 10px 44px rgba(0,0,0,.65);cursor:default;';
        card.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
        overlay.appendChild(card);

        overlay.addEventListener('pointerdown', handlePick);

        document.body.appendChild(overlay);
        ui = { overlay: overlay, hint: hint, box: box, card: card };
        return ui;
    }

    function extractActive() {
        return !!(ui && ui.overlay.style.display !== 'none');
    }

    function enterExtractMode() {
        var u = ensureUI();
        picked = null;
        u.card.style.display = 'none';
        u.box.style.display = 'none';
        u.overlay.style.display = 'block';
    }

    function exitExtractMode() {
        if (!ui) return;
        ui.overlay.style.display = 'none';
        picked = null;
        // Back to the PAUSE panel — the game is still cmg-paused. Embedded
        // there is no panel: hand the pause back to whatever the launcher
        // last asked for, so we never resume under an open Guide.
        var panel = document.getElementById('cmg-pause-panel');
        if (panel) panel.style.display = 'flex';
        else if (embedded()) setPaused(launcherWantsPaused);
    }

    function statRow(label, value) {
        if (value === undefined || value === null || value === '') return null;
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;gap:12px;font-size:10px;'
            + 'letter-spacing:.12em;margin:3px 0;';
        var l = document.createElement('span');
        l.textContent = label;
        l.style.opacity = '.7';
        var v = document.createElement('span');
        v.textContent = String(value);
        v.style.cssText = 'font-family:monospace;letter-spacing:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        row.appendChild(l);
        row.appendChild(v);
        return row;
    }

    function drawThumb(scene, sel) {
        var frames = collectFrameNames(sel.record);
        var first = frames.length ? frames[0] : (sel.sprite.frame && sel.sprite.frame.name);
        if (!first) return null;
        var src = lookupFrame(textureFrameSource(scene, sel.textureKey), first);
        if (!src) return null;
        var c = document.createElement('canvas');
        var scale = Math.max(1, Math.min(4, Math.floor(56 / Math.max(src.w, src.h))));
        c.width = src.w * scale;
        c.height = src.h * scale;
        var ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(src.image, src.x, src.y, src.w, src.h, 0, 0, c.width, c.height);
        c.style.cssText = 'image-rendering:pixelated;max-width:64px;max-height:64px;margin-bottom:6px;';
        return c;
    }

    function showCard(scene, sel) {
        var u = ensureUI();
        var card = u.card;
        card.innerHTML = '';

        var thumb = drawThumb(scene, sel);
        if (thumb) card.appendChild(thumb);

        var title = document.createElement('div');
        title.textContent = String(sel.record.name || sel.key).toUpperCase();
        title.style.cssText = 'font-size:13px;font-weight:700;letter-spacing:.22em;text-indent:.22em;margin-bottom:2px;';
        card.appendChild(title);

        var kind = document.createElement('div');
        kind.textContent = sel.kind.toUpperCase() + ' · ' + sel.key;
        kind.style.cssText = 'font-size:9px;letter-spacing:.2em;opacity:.65;margin-bottom:8px;';
        card.appendChild(kind);

        var rows = document.createElement('div');
        rows.style.cssText = 'margin-bottom:10px;';
        var frames = collectFrameNames(sel.record);
        var crop = cropFrames(sel.record, textureFrameSource(scene, sel.textureKey));
        var uniq = uniqueFrameCount(crop.sprites);
        var frameLabel = String(frames.length);
        if (crop.missing.length) frameLabel += ' (' + crop.missing.length + ' missing)';
        else if (uniq < frames.length) frameLabel += ' (' + uniq + ' unique)';
        [
            statRow('HP', sel.record.hp !== undefined ? sel.record.hp : sel.record.maxHp),
            statRow('SCORE', sel.record.score),
            statRow('SPEED', sel.record.speed),
            statRow('FIRE INTERVAL', sel.record.interval),
            statRow('FRAMES', frameLabel),
            statRow('ATLAS', sel.textureKey),
        ].forEach(function (r) { if (r) rows.appendChild(r); });
        card.appendChild(rows);
        if (uniq === 1 && frames.length > 1 && !crop.missing.length) {
            var note = document.createElement('div');
            note.textContent = 'ALL FRAMES IDENTICAL — THIS ART DOES NOT ANIMATE';
            note.style.cssText = 'font-size:8px;letter-spacing:.14em;opacity:.6;margin:-6px 0 8px;';
            card.appendChild(note);
        }

        var btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap;';
        btns.appendChild(makeButton('SAVE TO LIBRARY', function () { saveSelection(scene, sel); }));
        btns.appendChild(makeButton('CLOSE', function () {
            card.style.display = 'none';
            u.box.style.display = 'none';
            picked = null;
        }));
        card.appendChild(btns);
        card.style.display = 'block';
    }

    function showSaved(name) {
        var u = ensureUI();
        var card = u.card;
        card.innerHTML = '';
        var title = document.createElement('div');
        title.textContent = "SAVED '" + name.toUpperCase() + "'";
        title.style.cssText = 'font-size:12px;font-weight:700;letter-spacing:.2em;margin-bottom:4px;color:#B6FF6C;';
        card.appendChild(title);
        var note = document.createElement('div');
        note.textContent = 'ADDED TO THE SHARED CHARACTER LIBRARY';
        note.style.cssText = 'font-size:9px;letter-spacing:.18em;opacity:.7;margin-bottom:10px;';
        card.appendChild(note);
        var btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap;';
        var eo = editorOrigin();
        if (eo !== null) {
            btns.appendChild(makeButton('OPEN LIBRARY EDITOR', function () {
                window.open(libraryEditorURL(gameIdFromPath(), name, eo), '_blank');
            }));
        }
        btns.appendChild(makeButton('DONE', function () {
            card.style.display = 'none';
            ui.box.style.display = 'none';
            picked = null;
        }));
        card.appendChild(btns);
        card.style.display = 'block';
    }

    function handlePick(ev) {
        var scene = activeGameScene();
        var u = ensureUI();
        if (!scene) { exitExtractMode(); return; }
        var wp = worldPointFromEvent(ev, scene);
        if (!wp) return;
        var hit = hitTest(extractables(scene), wp, 3);
        if (!hit) {
            var known = extractables(scene).map(function (c) { return c.sprite; });
            hit = hitTestDisplayList(scene, wp, known);
        }
        if (!hit) {
            u.card.style.display = 'none';
            u.box.style.display = 'none';
            picked = null;
            return;
        }
        picked = hit.c;
        picked.textureKey = (hit.c.sprite.texture && hit.c.sprite.texture.key) || 'game_asset';
        var sr = screenRectFromBounds(hit.bounds, scene);
        if (sr) {
            u.box.style.display = 'block';
            u.box.style.left = sr.left + 'px';
            u.box.style.top = sr.top + 'px';
            u.box.style.width = sr.width + 'px';
            u.box.style.height = sr.height + 'px';
        }
        showCard(scene, picked);
    }

    async function saveSelection(scene, sel) {
        var name = prompt('Save to the shared library as:', suggestName(sel.record.name || sel.key));
        if (!name) return;
        name = name.trim();
        if (!validName(name)) return alert('Use letters, digits and underscores only');
        if (reservedName(name)) return alert("'" + name + "' is reserved by the characters module — pick another name");

        var crop = cropFrames(sel.record, textureFrameSource(scene, sel.textureKey));
        if (!crop.sprites.length) return alert('None of the frames this object references are loaded');
        if (crop.missing.length
            && !confirm(crop.missing.length + ' referenced frame(s) are missing and will be skipped. Save anyway?')) return;

        var packed = packFrames(crop.sprites);
        try {
            var saved = await publishRecord({
                name: name, record: sel.record, missing: crop.missing,
                canvas: packed.canvas, atlasJson: packed.atlasJson,
            });
            if (saved) showSaved(saved);
        } catch (e) {
            alert(navigator.onLine === false
                ? 'You are offline — the shared library needs a connection.'
                : 'Save failed: ' + e.message);
        }
    }

    // The bundle's two-corner pause gesture (a window CAPTURE listener that
    // registered before this script) can toggle the pause panel up — or, if
    // it were left up, back down with a game resume — underneath the extract
    // overlay. This guard registers later, so within the same capture phase
    // it runs after the toggle and re-hides the panel on every pointerdown,
    // keeping cmgPanelVisible() false (and the resume branch unreachable)
    // for the whole extract session — card/EXIT stopPropagation included.
    window.addEventListener('pointerdown', function () {
        if (!extractActive()) return;
        var panel = document.getElementById('cmg-pause-panel');
        if (panel && panel.style.display !== 'none') panel.style.display = 'none';
    }, true);

    // ESC while extracting: close the card, or leave extract mode back to the
    // PAUSE panel. Capture-phase so the bundle's own ESC toggle never fires.
    window.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape' || !extractActive()) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (ui.card.style.display !== 'none') {
            ui.card.style.display = 'none';
            ui.box.style.display = 'none';
            picked = null;
        } else {
            exitExtractMode();
        }
    }, true);

    // Ride the standalone PAUSE panel: add EXTRACT MODE under RESUME the
    // moment game.bundle.js builds it.
    function injectPausePanelButton() {
        var panel = document.getElementById('cmg-pause-panel');
        if (!panel || panel.__extractArmed) return !!panel;
        var pcard = panel.firstElementChild;
        if (!pcard) return false;
        panel.__extractArmed = true;
        pausePanel = panel;
        var btn = document.createElement('button');
        btn.textContent = 'EXTRACT MODE';
        btn.style.cssText = 'display:block;margin:10px auto 0;' + BTN_CSS;
        btn.addEventListener('click', function () {
            if (!activeGameScene()) {
                var old = btn.textContent;
                btn.textContent = 'NO STAGE RUNNING';
                setTimeout(function () { btn.textContent = old; }, 1400);
                return;
            }
            panel.style.display = 'none';
            enterExtractMode();
        });
        pcard.appendChild(btn);
        return true;
    }

    function armWhenPanelAppears() {
        if (injectPausePanelButton()) return;
        var mo = new MutationObserver(function () {
            if (injectPausePanelButton()) mo.disconnect();
        });
        mo.observe(document.body, { childList: true });
    }

    // Embedded in the cmg launcher the bundle never builds #cmg-pause-panel
    // (its whole standalone block is gated on window.parent === window), and
    // ESC / START / the corner gesture are all redirected to the launcher's
    // Guide. The way in is the launcher's own actions protocol: advertise
    // EXTRACT MODE, and the Guide renders it as a button that closes itself
    // and posts cmg-action back down.
    var EXTRACT_ACTION = 'extract';

    // Only a page that actually hosts the game may advertise — the level
    // editor loads this file too for the helpers above, and the launcher
    // swaps its own frame to /editor/, where a dead button must not appear.
    function hostsGame() {
        return !!document.getElementById('phaser-canvas');
    }

    function advertiseAction() {
        if (!embedded() || !hostsGame()) return;
        try {
            // The launcher replaces its action list wholesale per message, so
            // this must stay the only cmg-actions this game ever posts.
            window.parent.postMessage({
                type: 'cmg-actions',
                actions: [{ id: EXTRACT_ACTION, label: 'Extract Mode' }],
            }, '*');
        } catch (e) { }
    }

    window.addEventListener('message', function (ev) {
        var d = ev && ev.data;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'cmg-pause') {
            launcherWantsPaused = !!d.paused;
            // Activating a Guide action closes the Guide, which un-pauses one
            // dispatch later. The bundle's handler already ran this tick, so
            // re-assert before the next frame — no frame advances under the
            // overlay.
            if (extractActive() && !launcherWantsPaused) setPaused(true);
            return;
        }
        if (d.type !== 'cmg-action') return;
        if ((d.id || d.action) !== EXTRACT_ACTION) return;
        if (!activeGameScene()) { flashToast('EXTRACT MODE · NO STAGE RUNNING'); return; }
        setPaused(true);
        enterExtractMode();
    });

    // Transient notice for the embedded case, where there is no pause-panel
    // button whose label can carry the message.
    function flashToast(text) {
        var t = document.createElement('div');
        t.textContent = text;
        t.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:10002;'
            + 'background:rgba(70,70,70,.94);color:#fff;border-radius:6px;padding:8px 14px;'
            + "font-family:'Orbitron',system-ui,sans-serif;font-size:10px;letter-spacing:.2em;";
        document.body.appendChild(t);
        setTimeout(function () { t.remove(); }, 1800);
    }

    function arm() {
        armWhenPanelAppears();
        advertiseAction();
    }

    if (document.body) arm();
    else document.addEventListener('DOMContentLoaded', arm);
})();
