// Online two-player, the joining half.
//
// The bundle (game.bundle.js, `cmgNet*`) is the HOST half: it announces a run,
// publishes snapshots and feeds a guest's buttons to player 2. This file is
// everything the other person sees — the live-runs panel on the title screen,
// the preview, and the guest view itself.
//
// It is a plugin rather than more bundle edits for the same reason
// extract-mode.js is: game.bundle.js is a vendored artifact this repo has no
// build step for, so anything that can live outside it should.
//
// The guest does not simulate. It renders the host's snapshots and streams
// input back — so joining is instant, needs no level download, and cannot
// desync. The trade is that a guest sees their own ship at the host's latency;
// their movement is predicted locally to hide most of it.
//
// Everything is opt-in behind ?online=1 and fails soft: no /netplay/ bundle
// (an offline export), no network, no database — the panel simply never
// appears and the game plays exactly as it does today.
(function () {
    'use strict';

    var MODULE = '/netplay/shmupx-netplay.js';
    // The playfield the runtime draws into (GAME_DIMENSIONS), which is also
    // the coordinate space every snapshot is in.
    var GW = 256;
    var GH = 480;
    // Movement per fixed step, matching the runtime's keyMoveSpeed, so a
    // guest's predicted ship travels at the same rate as the real one.
    var MOVE_SPEED = 3;
    // The runtime clamps a ship to its own half-width (clampPlayerX), which for
    // the trooper's 28px frame is (28-14)/2 = 7. Predicting against a different
    // wall would park the drawn ship several pixels off the real one and never
    // converge, because at the wall the host's position stops changing.
    var SHIP_HALF_W = 7;
    var STEP_MS = 1000 / 120;

    function q(name) {
        try {
            return new URLSearchParams(location.search).get(name);
        } catch (e) {
            return null;
        }
    }

    function enabled() {
        var v = q('online');
        return v != null && v !== '' && !/^(0|false|off|no)$/i.test(v);
    }

    function game() {
        return window.__PHASER_4_GAME__ || window.__PHASER_GAME__ || null;
    }

    function sceneActive(key) {
        var g = game();
        if (!g || !g.scene) return false;
        try {
            var s = g.scene.getScene(key);
            return !!(s && s.scene.isActive());
        } catch (e) {
            return false;
        }
    }

    // ---- drawing -----------------------------------------------------------
    //
    // Snapshots carry positions and a roster index, not pixels, so the preview
    // is drawn with the atlas THIS page already loaded — the same art the host
    // is looking at, not an abstraction of it.

    function atlasSource(g) {
        try {
            var tex = g.textures.get('game_asset');
            var img = tex && tex.getSourceImage();
            return img ? { tex: tex, img: img } : null;
        } catch (e) {
            return null;
        }
    }

    /** Roster order must match the host's: sorted enemyData keys, 1-based. */
    function buildRoster() {
        var st = window.__GAME_STATE__;
        var recipe = st && st._phaserRecipe;
        var data = (recipe && recipe.enemyData) || {};
        var names = Object.keys(data).sort();
        var byIndex = [null];
        for (var i = 0; i < names.length && i < 255; i++) {
            var rec = data[names[i]];
            byIndex.push((rec && rec.texture && rec.texture[0]) || null);
        }
        return byIndex;
    }

    function playerFrames() {
        var st = window.__GAME_STATE__;
        var recipe = st && st._phaserRecipe;
        var p1 = (recipe && recipe.playerData && recipe.playerData.texture) || [];
        var p2 = (recipe && recipe.playerData2 && recipe.playerData2.texture) ||
            ['trooper_0', 'trooper_1', 'trooper_2', 'trooper_3',
                'trooper_4', 'trooper_5', 'trooper_6', 'trooper_7'];
        return [p1, p2];
    }

    function blit(ctx, art, frameName, cx, cy) {
        if (!art || !frameName) return false;
        var f;
        try {
            f = art.tex.frames[frameName];
        } catch (e) {
            return false;
        }
        if (!f) return false;
        ctx.drawImage(
            art.img,
            f.cutX, f.cutY, f.cutWidth, f.cutHeight,
            Math.round(cx - f.cutWidth / 2), Math.round(cy - f.cutHeight / 2),
            f.cutWidth, f.cutHeight
        );
        return true;
    }

    function drawSnapshot(canvas, snap, art, roster, frames, tick, localShip) {
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        // The scenery is the host's business and is not in the snapshot;
        // a flat field keeps the entities legible without pretending.
        ctx.fillStyle = '#050a18';
        ctx.fillRect(0, 0, GW, GH);
        if (!snap) {
            ctx.fillStyle = 'rgba(255,255,255,.35)';
            ctx.font = '10px monospace';
            ctx.fillText('WAITING FOR HOST…', 12, 24);
            return;
        }

        ctx.fillStyle = '#8fd0ff';
        for (var b = 0; b < snap.bullets.length; b++) {
            ctx.fillRect(snap.bullets[b].x - 1, snap.bullets[b].y - 3, 2, 6);
        }
        ctx.fillStyle = '#ff8f6b';
        for (var e = 0; e < snap.enemyBullets.length; e++) {
            ctx.fillRect(snap.enemyBullets[e].x - 2, snap.enemyBullets[e].y - 2, 4, 4);
        }

        for (var i = 0; i < snap.enemies.length; i++) {
            var en = snap.enemies[i];
            if (!blit(ctx, art, roster[en.kind], en.x, en.y)) {
                ctx.fillStyle = '#7dff9a';
                ctx.fillRect(en.x - 5, en.y - 5, 10, 10);
            }
        }

        for (var s = 0; s < snap.ships.length; s++) {
            var sh = snap.ships[s];
            if (sh.dead) continue;
            // The guest's own ship is drawn where the guest believes it is, not
            // where the host last said — otherwise every input waits a round
            // trip to show on screen.
            var x = (localShip && s === localShip.slot) ? localShip.x : sh.x;
            var y = (localShip && s === localShip.slot) ? localShip.y : sh.y;
            var list = frames[s] || frames[0] || [];
            var frame = list.length ? list[(tick >> 3) % list.length] : null;
            if (!blit(ctx, art, frame, x, y)) {
                ctx.fillStyle = s === 0 ? '#7dff9a' : '#2f9bff';
                ctx.fillRect(x - 6, y - 8, 12, 16);
            }
        }
    }

    // ---- DOM ---------------------------------------------------------------

    var CSS = [
        '#netplay-panel{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:9998;',
        'width:min(340px,92vw);background:rgba(8,12,24,.94);border:1px solid rgba(120,190,255,.35);',
        "border-radius:10px;padding:10px 12px 12px;color:#dceaff;font-family:'Orbitron',system-ui,sans-serif;",
        'box-shadow:0 10px 40px rgba(0,0,0,.6);font-size:11px;letter-spacing:.12em;}',
        '#netplay-panel h4{margin:0 0 8px;font-size:10px;letter-spacing:.3em;color:#8fd0ff;font-weight:700;}',
        '#netplay-panel .row{display:flex;gap:10px;align-items:center;padding:6px 0;',
        'border-top:1px solid rgba(120,190,255,.15);}',
        '#netplay-panel .row canvas{width:44px;height:82px;background:#050a18;border-radius:3px;',
        'border:1px solid rgba(120,190,255,.25);image-rendering:pixelated;}',
        '#netplay-panel .meta{flex:1;min-width:0;}',
        '#netplay-panel .meta b{display:block;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '#netplay-panel .meta span{color:#7f9dc4;font-size:9px;letter-spacing:.16em;}',
        '#netplay-panel button{background:rgba(120,190,255,.16);border:1px solid rgba(120,190,255,.5);',
        'color:#dceaff;border-radius:5px;padding:7px 12px;font:inherit;font-size:10px;letter-spacing:.2em;cursor:pointer;}',
        '#netplay-panel button:disabled{opacity:.4;cursor:default;}',
        '#netplay-panel .status{color:#7f9dc4;font-size:9px;letter-spacing:.18em;}',
        '#netplay-guest{position:fixed;inset:0;z-index:10001;background:#000;display:flex;',
        'flex-direction:column;align-items:center;justify-content:center;}',
        '#netplay-guest canvas{height:100%;max-height:100vh;image-rendering:pixelated;}',
        '#netplay-guest .bar{position:fixed;top:0;left:0;right:0;padding:6px 10px;display:flex;',
        'gap:10px;align-items:center;background:rgba(8,12,24,.85);color:#dceaff;',
        "font-family:'Orbitron',system-ui,sans-serif;font-size:10px;letter-spacing:.18em;}",
        '#netplay-guest .bar button{margin-left:auto;background:rgba(255,120,120,.18);',
        'border:1px solid rgba(255,120,120,.5);color:#ffdcdc;border-radius:5px;padding:5px 10px;',
        'font:inherit;font-size:9px;letter-spacing:.2em;cursor:pointer;}',
    ].join('');

    function injectCss() {
        if (document.getElementById('netplay-css')) return;
        var st = document.createElement('style');
        st.id = 'netplay-css';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    // ---- lobby -------------------------------------------------------------

    var api = null;
    var panel = null;
    var rows = new Map();
    var tick = 0;

    function ensurePanel() {
        if (panel) return panel;
        injectCss();
        panel = document.createElement('div');
        panel.id = 'netplay-panel';
        panel.innerHTML = '<h4>LIVE NOW</h4><div class="list"></div>' +
            '<div class="status">CONNECTING…</div>';
        document.body.appendChild(panel);
        return panel;
    }

    function setStatus(text) {
        if (!panel) return;
        var el = panel.querySelector('.status');
        if (el) el.textContent = text;
    }

    function renderSessions(list) {
        if (!panel) return;
        var host = panel.querySelector('.list');
        var live = list.filter(function (s) { return !s.mine; });
        for (var key of Array.from(rows.keys())) {
            if (!live.some(function (s) { return s.hostHex === key; })) {
                var dead = rows.get(key);
                if (dead.unwatch) dead.unwatch();
                dead.el.remove();
                rows.delete(key);
            }
        }
        if (!live.length) {
            setStatus('NOBODY ELSE IS PLAYING THIS ONE');
            return;
        }
        setStatus(live.length + (live.length === 1 ? ' RUN LIVE' : ' RUNS LIVE'));
        live.forEach(function (s) {
            var row = rows.get(s.hostHex);
            if (!row) {
                var el = document.createElement('div');
                el.className = 'row';
                var canvas = document.createElement('canvas');
                canvas.width = GW;
                canvas.height = GH;
                var meta = document.createElement('div');
                meta.className = 'meta';
                var btn = document.createElement('button');
                btn.textContent = 'JOIN';
                btn.addEventListener('click', function () {
                    if (row.joining) return;
                    row.joining = true;
                    btn.disabled = true;
                    btn.textContent = 'JOINING…';
                    joinRun(s.hostHex, function (err) {
                        row.joining = false;
                        btn.disabled = false;
                        btn.textContent = 'JOIN';
                        if (err) setStatus(String(err).toUpperCase());
                    });
                });
                el.appendChild(canvas);
                el.appendChild(meta);
                el.appendChild(btn);
                host.appendChild(el);
                row = { el: el, canvas: canvas, meta: meta, btn: btn, snap: null };
                row.unwatch = api.watch(s.hostHex, function (snap) {
                    row.snap = snap;
                });
                rows.set(s.hostHex, row);
            }
            row.meta.innerHTML = '';
            var b = document.createElement('b');
            b.textContent = s.title || s.gameId;
            var sp = document.createElement('span');
            sp.textContent = 'STAGE ' + (s.stage + 1) + ' · ' + s.score.toLocaleString() +
                ' · ' + s.players + 'P';
            row.meta.appendChild(b);
            row.meta.appendChild(sp);
            // Never fight an in-flight join: a session update lands between
            // the click and the reducer's answer, and re-enabling here let a
            // second click open a second guest overlay that nothing could close.
            if (!row.joining) {
                row.btn.disabled = !s.joinable;
                // ...and the label has to come BACK when a seat frees, or a run
                // that filled once reads FULL for the rest of its life.
                row.btn.textContent = s.joinable ? 'JOIN' : 'FULL';
            }
        });
    }

    // ---- guest -------------------------------------------------------------

    var guest = null;

    function currentInput() {
        var g = guest;
        return {
            left: g.keys.ArrowLeft || g.keys.a || g.pad.left,
            right: g.keys.ArrowRight || g.keys.d || g.pad.right,
            up: g.keys.ArrowUp || g.keys.w || g.pad.up,
            down: g.keys.ArrowDown || g.keys.s || g.pad.down,
            fire: g.keys[' '] || g.pad.fire,
            charge: g.keys.Shift || g.pad.charge,
        };
    }

    function pollPad() {
        var out = { left: false, right: false, up: false, down: false, fire: false, charge: false };
        var pads;
        try {
            pads = navigator.getGamepads ? navigator.getGamepads() : [];
        } catch (e) {
            return out;
        }
        for (var i = 0; i < pads.length; i++) {
            var p = pads[i];
            if (!p || !p.buttons) continue;
            if (p.buttons[14] && p.buttons[14].pressed) out.left = true;
            if (p.buttons[15] && p.buttons[15].pressed) out.right = true;
            if (p.buttons[12] && p.buttons[12].pressed) out.up = true;
            if (p.buttons[13] && p.buttons[13].pressed) out.down = true;
            for (var b = 0; b < 4; b++) {
                if (p.buttons[b] && p.buttons[b].pressed) out.fire = true;
            }
            if ((p.buttons[4] && p.buttons[4].pressed) || (p.buttons[5] && p.buttons[5].pressed)) {
                out.charge = true;
            }
            if (p.axes && p.axes.length >= 2) {
                if (p.axes[0] < -0.5) out.left = true;
                if (p.axes[0] > 0.5) out.right = true;
                if (p.axes[1] < -0.5) out.up = true;
                if (p.axes[1] > 0.5) out.down = true;
            }
        }
        return out;
    }

    function leaveGuest(reason) {
        if (!guest) return;
        if (reason) setStatus(String(reason).toUpperCase());
        clearInterval(guest.loop);
        window.removeEventListener('keydown', guest.onDown, true);
        window.removeEventListener('keyup', guest.onUp, true);
        if (guest.unwatch) guest.unwatch();
        if (guest.unsubSessions) guest.unsubSessions();
        guest.overlay.remove();
        guest = null;
        if (api) api.leave();
        if (panel) panel.style.display = '';
    }

    function joinRun(hostHex, done) {
        if (!api) return done('offline');
        api.join(hostHex).then(function (res) {
            if (!res.ok) return done(res.error || 'could not join');
            openGuest(hostHex);
            done(null);
        }).catch(function (err) {
            done(String(err && err.message ? err.message : err));
        });
    }

    function openGuest(hostHex) {
        injectCss();
        var overlay = document.createElement('div');
        overlay.id = 'netplay-guest';
        var canvas = document.createElement('canvas');
        canvas.width = GW;
        canvas.height = GH;
        var bar = document.createElement('div');
        bar.className = 'bar';
        var label = document.createElement('span');
        label.textContent = 'PLAYER 2 · ONLINE';
        var quit = document.createElement('button');
        quit.textContent = 'LEAVE';
        quit.addEventListener('click', leaveGuest);
        bar.appendChild(label);
        bar.appendChild(quit);
        overlay.appendChild(bar);
        overlay.appendChild(canvas);
        document.body.appendChild(overlay);
        if (panel) panel.style.display = 'none';

        var g = game();
        guest = {
            hostHex: hostHex,
            overlay: overlay,
            canvas: canvas,
            label: label,
            art: g ? atlasSource(g) : null,
            roster: buildRoster(),
            frames: playerFrames(),
            snap: null,
            keys: Object.create(null),
            pad: { left: false, right: false, up: false, down: false, fire: false, charge: false },
            // Local prediction of our own ship, corrected toward the host's
            // authoritative position every snapshot.
            local: { slot: 1, x: GW / 2 + 64, y: GH - 80 },
            onDown: function (ev) {
                guest.keys[ev.key] = true;
                if (ev.key === ' ' || ev.key.indexOf('Arrow') === 0) ev.preventDefault();
            },
            onUp: function (ev) {
                guest.keys[ev.key] = false;
            },
        };
        window.addEventListener('keydown', guest.onDown, true);
        window.addEventListener('keyup', guest.onUp, true);

        // The host can stop existing at any moment — game over, a closed tab,
        // a dead network. Nothing else would ever take this overlay down, so
        // the guest watches the session list for its own host disappearing.
        guest.unsubSessions = api.onSessions(function (rows) {
            if (!guest) return;
            var still = rows.some(function (r) { return r.hostHex === guest.hostHex; });
            if (!still) leaveGuest('that run has ended');
        });
        guest.unwatch = api.watch(hostHex, function (snap) {
            guest.snap = snap;
            var mine = snap.ships[guest.local.slot];
            if (!mine) return;
            if (mine.dead) {
                guest.local.x = mine.x;
                guest.local.y = mine.y;
                return;
            }
            // Ease onto the host's truth rather than snapping to it: a hard
            // correction every 66ms reads as stutter, while drifting 25% of the
            // error a frame converges in a few frames and stays smooth.
            guest.local.x += (mine.x - guest.local.x) * 0.25;
            guest.local.y += (mine.y - guest.local.y) * 0.25;
        });

        guest.loop = setInterval(function () {
            if (!guest) return;
            tick++;
            guest.pad = pollPad();
            var input = currentInput();
            api.sendInput(input);
            // Predict: the host moves player 2 by MOVE_SPEED per fixed step
            // under exactly these buttons, so do the same locally.
            if (input.left) guest.local.x -= MOVE_SPEED;
            if (input.right) guest.local.x += MOVE_SPEED;
            if (input.up) guest.local.y -= MOVE_SPEED;
            if (input.down) guest.local.y += MOVE_SPEED;
            guest.local.x = Math.max(SHIP_HALF_W, Math.min(GW - SHIP_HALF_W, guest.local.x));
            guest.local.y = Math.max(50, Math.min(GH - 20, guest.local.y));
            drawSnapshot(guest.canvas, guest.snap, guest.art, guest.roster, guest.frames, tick, guest.local);
            if (guest.snap) {
                var mine = guest.snap.ships[guest.local.slot];
                guest.label.textContent = 'PLAYER 2 · ONLINE · ' +
                    guest.snap.score.toLocaleString() +
                    (mine ? (mine.dead ? ' · DOWN' : ' · HP ' + mine.hp) : '');
            }
        }, STEP_MS);
    }

    // ---- boot --------------------------------------------------------------

    function paintPreviews() {
        tick++;
        var g = game();
        var art = g ? atlasSource(g) : null;
        var roster = buildRoster();
        var frames = playerFrames();
        rows.forEach(function (row) {
            drawSnapshot(row.canvas, row.snap, art, roster, frames, tick, null);
        });
    }

    function boot() {
        if (!enabled()) return;
        import(MODULE).then(function (mod) {
            var opts = {};
            var uri = q('netplayUri');
            if (uri) opts.uri = uri;
            var db = q('netplayDb');
            if (db) opts.moduleName = db;
            // The lobby lists runs of THIS game only — "someone is playing this
            // one" is the question a title screen can actually answer.
            var st = window.__GAME_STATE__;
            var gameId = (st && st.gameId) || window.__GAME_ID__ || null;
            if (gameId) opts.gameId = gameId;
            return mod.netplay(opts);
        }).then(function (connected) {
            api = connected;
            if (!api) return;
            ensurePanel();
            api.onSessions(renderSessions);
            setStatus(api.online ? 'ONLINE' : 'OFFLINE');
            setInterval(paintPreviews, 66);
            // The panel belongs to the menus. During play the host's own HUD is
            // the thing to look at, and a guest has the full-screen view.
            setInterval(function () {
                if (!panel) return;
                var inPlay = sceneActive('PhaserGameScene');
                panel.style.display = (guest || inPlay) ? 'none' : '';
            }, 400);
        }).catch(function (err) {
            console.warn('[netplay] lobby unavailable:', err && err.message ? err.message : err);
        });
    }

    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot);
})();
