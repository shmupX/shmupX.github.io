// publish-panel.js — the PUBLISH panel: one saved cloud game to the stores,
// every build on a GitHub runner, watched from here.
//
// A bottom sheet the editor's drawer opens (FILE SYSTEM → PUBLISH ›, and the
// IOS target's PUBLISH IOS BUILD under EXPORT → APP). Three store cards — App
// Store Connect, Steam, itch.io — each a toggle (include it in this publish)
// and a › that opens its settings in place; one PUBLISH button for however
// many are on; the runs in flight as a row of step chips each; the store
// listing (title, description, CAPTURE SCREENSHOTS) shared by every store;
// and the log of every run this game has had, newest first.
//
// The server half is routes/api/publish.ts (dispatch, watch, the log, the
// secrets a store needs) and routes/api/store-shots.ts (the testdrive capture
// and its stills); this file is the panel alone, mounted by the editor:
//
//   const panel = PublishPanel.mount(document.getElementById('publish-sheet'), {
//     levelName: () => string,          // the cloud game's name, '' when unsaved
//     label: () => string,              // what the open game is called, for chrome
//     isSav: () => bool,                // an imported cart is open (no cloud record)
//     lastSavedAt: () => number|null,   // when the game was last saved to the cloud
//     save: () => Promise<string|false|undefined>,   // saveToFirebase: the key, false when declined
//     writeListing: (level, listing) => Promise,     // shmupX/storeListings/<level>
//     flash: (msg) => {},
//   });
//   panel.open({ store: 'ios' }); panel.close(); panel.isOpen();
//
// Settings and the listing are kept per game in localStorage; the runs in
// flight too, so a reload (the run keeps going on GitHub) picks the watch
// back up.
(function () {
    'use strict';

    const STORE_IDS = ['ios', 'steam', 'itch'];
    const STORES = {
        ios: { badge: 'TF', name: 'APP STORE CONNECT', sub: 'TESTFLIGHT · SIGNED ON A GITHUB MAC', queued: 'Waiting for a GitHub Mac…',
               chips: ['STAGE', 'SIGN', 'UPLOAD'] },
        steam: { badge: 'ST', name: 'STEAM', sub: 'STEAMPIPE · GITHUB RUNNER', queued: 'Waiting for a GitHub runner…',
                 chips: ['STAGE', 'DEPOT', 'UPLOAD', 'BRANCH'] },
        itch: { badge: 'IT', name: 'ITCH.IO', sub: 'BUTLER · GITHUB RUNNER', queued: 'Waiting for a GitHub runner…',
                chips: ['STAGE', 'PACK', 'PUSH'] },
    };
    // What each chip stands for, for its title before the server has said.
    const CHIP_TITLES = {
        ios: { STAGE: 'Stage the game as an Xcode project', SIGN: 'Archive and export the signed .ipa', UPLOAD: 'Upload to TestFlight', REVIEW: 'Submit the processed build for App Store review' },
        steam: { STAGE: 'Build the Linux and Windows desktop apps', DEPOT: 'Lay the builds into the depot', UPLOAD: 'Upload with SteamPipe', BRANCH: 'Set live on the branch' },
        itch: { STAGE: 'Build the picked channels', PACK: 'Pack one zip per channel', PUSH: 'butler push, per channel' },
    };
    const SHOT_SIZES = {
        ios: [['iphone-67', 'APP STORE 6.7″', 1290, 2796], ['iphone-65', 'APP STORE 6.5″', 1284, 2778]],
        steam: [['capsule', 'STEAM CAPSULE', 616, 353], ['header', 'STEAM HEADER', 460, 215], ['shot', 'STEAM SHOT', 1920, 1080]],
        itch: [['cover', 'ITCH COVER', 630, 500], ['shot', 'ITCH SHOT', 1920, 1080]],
    };
    const ITCH_CHANNELS = ['win', 'linux', 'mac', 'web'];
    const DEFAULT_BUNDLE_ID = 'com.easierbycode.game2028';
    const SETTINGS_KEY = 'cmg-publish:';     // + level
    const RUNS_KEY = 'cmg-publish-runs';
    const POLL_MS = 8000;
    const CAPTURE_POLL_MS = 3000;
    const RESUME_MS = 2 * 60 * 60 * 1000;

    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const when = (t) => {
        const d = new Date(t);
        if (isNaN(d)) return '';
        return MONTHS[d.getMonth()] + ' ' + d.getDate() + ' · ' + d.toTimeString().slice(0, 5);
    };
    const clock = (t) => { const d = new Date(t); return isNaN(d) ? '' : d.toTimeString().slice(0, 5); };
    const todayVersion = () => {
        const d = new Date();
        return String(d.getUTCFullYear()) + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0') + '.1';
    };
    const link = (href, text) => '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(text) + '</a>';

    function defaultSettings() {
        return {
            on: { ios: true, steam: false, itch: false },
            open: 'ios',
            ios: { bundleId: '', upload: true, review: false },
            steam: { appId: '', depotId: '', branch: 'default', description: '' },
            itch: { target: '', version: '', channels: { win: true, linux: true, mac: false, web: true } },
            listing: { title: '', description: '' },
        };
    }

    function mount(host, api) {
        const S = {
            level: '',
            settings: defaultSettings(),
            config: null,       // GET /api/publish
            configError: '',    // why there is none
            loading: false,
            runs: null,         // { store: { request, runId, run, artifacts, error, hint, review } }
            runsLevel: '',      // the game those runs belong to
            phase: null,        // 'saving' | 'listing' | 'dispatching' while PUBLISH is busy
            log: [], logError: '',
            capture: null,      // the job going, or the one that just finished
            shots: [],          // what is on disk for this level
            capturedAt: null,
            captureError: '',
            listingNote: '',
            isOpen: false,
        };
        let pollTimer = null, captureTimer = null;

        // ── persistence ──
        function loadSettings(level) {
            const d = defaultSettings();
            if (!level) return d;
            try {
                const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY + level) || 'null');
                if (!saved) return d;
                return {
                    on: Object.assign(d.on, saved.on || {}),
                    open: saved.open === undefined ? d.open : saved.open,
                    ios: Object.assign(d.ios, saved.ios || {}),
                    steam: Object.assign(d.steam, saved.steam || {}),
                    itch: Object.assign(d.itch, saved.itch || {}, { channels: Object.assign(d.itch.channels, (saved.itch || {}).channels || {}) }),
                    listing: Object.assign(d.listing, saved.listing || {}),
                };
            } catch (e) { return d; }
        }
        function saveSettings() {
            if (!S.level) return;
            try { localStorage.setItem(SETTINGS_KEY + S.level, JSON.stringify(S.settings)); } catch (e) {}
        }
        function saveRuns() {
            try {
                if (!S.runs) { localStorage.removeItem(RUNS_KEY); return; }
                const runs = {};
                for (const k of Object.keys(S.runs)) {
                    const r = S.runs[k];
                    if (r.request || r.runId) runs[k] = { request: r.request, runId: r.runId, review: !!r.review };
                }
                localStorage.setItem(RUNS_KEY, JSON.stringify({ level: S.level, at: Date.now(), runs }));
            } catch (e) {}
        }

        // ── the level the panel is about ──
        function syncLevel() {
            const level = (api.levelName() || '').trim();
            if (level === S.level && S.config) return false;
            S.level = level;
            S.settings = loadSettings(level);
            if (!S.settings.listing.title) S.settings.listing.title = api.label() || level;
            // Runs in flight belong to one game; another game opened over
            // them is not watching them.
            if (S.runs && S.runsLevel && level && S.runsLevel !== level) { S.runs = null; stopWatch(); }
            return true;
        }

        // ── the server ──
        async function loadConfig() {
            S.loading = true; S.configError = '';
            render();
            try {
                const r = await fetch('/api/publish' + (S.level ? '?level=' + encodeURIComponent(S.level) : ''), { cache: 'no-store' });
                const data = await r.json().catch(() => ({}));
                if (r.status === 403 || r.status === 404) {
                    S.config = null;
                    S.configError = 'PUBLISHING RUNS FROM A LOCAL INSTALL: THIS ORIGIN HOLDS NO GITHUB TOKEN TO DISPATCH THE BUILDS WITH. OPEN THE EDITOR FROM `deno task dev` OR THE DESKTOP APP.';
                } else if (!r.ok || !data.ok) {
                    S.config = null;
                    S.configError = 'COULD NOT READ THE PUBLISHER: ' + (data.error || ('HTTP ' + r.status)).toUpperCase() + (data.hint ? ' — ' + data.hint : '');
                } else {
                    S.config = data;
                    S.log = Array.isArray(data.log) ? data.log : [];
                    S.logError = data.logError || '';
                    // Repository variables default the settings the first time.
                    const v = (id, name) => ((data.stores[id] || {}).variables || {})[name] || '';
                    const st = S.settings;
                    if (!st.ios.bundleId) st.ios.bundleId = v('ios', 'IOS_BUNDLE_ID') || DEFAULT_BUNDLE_ID;
                    if (!st.steam.appId) st.steam.appId = v('steam', 'STEAM_APP_ID');
                    if (!st.steam.depotId) st.steam.depotId = v('steam', 'STEAM_DEPOT_ID');
                    if (!st.itch.target) st.itch.target = v('itch', 'ITCH_TARGET');
                }
            } catch (e) {
                S.config = null;
                S.configError = 'COULD NOT REACH THE PUBLISHER: ' + String(e && e.message || e).toUpperCase();
            }
            S.loading = false;
            render();
        }
        async function loadShots() {
            if (!S.level) { S.shots = []; S.capturedAt = null; return; }
            try {
                const r = await fetch('/api/store-shots?level=' + encodeURIComponent(S.level), { cache: 'no-store' });
                const data = await r.json().catch(() => ({}));
                if (r.ok && data.ok) {
                    S.shots = data.shots || [];
                    S.capturedAt = data.capturedAt || null;
                    if (data.capture) { S.capture = data.capture; watchCapture(); }
                }
            } catch (e) {}
            render();
        }
        async function refreshLog() {
            if (!S.level || !S.config) return;
            try {
                const r = await fetch('/api/publish?level=' + encodeURIComponent(S.level), { cache: 'no-store' });
                const data = await r.json().catch(() => ({}));
                if (r.ok && data.ok) { S.log = data.log || []; S.logError = data.logError || ''; }
            } catch (e) {}
            render();
        }

        // ── publishing ──
        function picked() { return STORE_IDS.filter((k) => S.settings.on[k]); }
        function running() {
            return !!S.phase || (!!S.runs && Object.values(S.runs).some((r) => !r.error && (!r.run || r.run.status !== 'completed')));
        }

        async function publish() {
            const stores = picked();
            if (!stores.length || running() || !S.config || !S.config.configured) return;
            if (api.isSav()) {
                S.listingNote = 'THE RUNNERS READ THE GAME FROM THE CLOUD BY NAME, AND AN IMPORTED CART HAS NO CLOUD RECORD — SAVE IT AS A CLOUD GAME FIRST.';
                render(); return;
            }
            S.listingNote = '';
            S.phase = 'saving';
            S.runs = {};
            for (const k of stores) S.runs[k] = { request: null, runId: null, run: null, artifacts: [], error: '', hint: '', review: k === 'ios' && !!S.settings.ios.review };
            render();
            let saved;
            try { saved = await api.save(); } catch (e) { /* saveToFirebase alerts on its own */ }
            if (saved === false) {
                S.phase = null; S.runs = null;
                S.listingNote = 'PUBLISH CANCELLED: THE GAME WAS NOT SAVED. PICK A NAME FOR IT AND PUBLISH AGAIN.';
                render(); return;
            }
            const level = (typeof saved === 'string' && saved) || (api.levelName() || '').trim();
            if (!level) {
                S.phase = null; S.runs = null;
                S.listingNote = 'THE GAME HAS NO CLOUD NAME TO BUILD UNDER.';
                render(); return;
            }
            if (level !== S.level) {
                // Saved under another key (a short name's game): the settings
                // and the log follow the key the runners will read.
                const settings = S.settings;
                S.level = level; S.settings = settings; saveSettings();
            }
            // The listing goes up before the dispatch, so the review step and
            // the next build read what was just typed.
            S.phase = 'listing'; render();
            try {
                const listing = { title: S.settings.listing.title || '', description: S.settings.listing.description || '' };
                if (S.settings.on.ios) {
                    const shots = {};
                    for (const sh of S.shots) {
                        if (sh.store !== 'ios') continue;
                        try {
                            const blob = await (await fetch(sh.url, { cache: 'no-store' })).blob();
                            shots[sh.key] = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
                        } catch (e) {}
                    }
                    if (Object.keys(shots).length) listing.shots = { ios: shots };
                }
                await api.writeListing(level, listing);
            } catch (e) {
                S.listingNote = 'THE STORE LISTING DID NOT SAVE (' + String(e && e.message || e).toUpperCase() + ') — THE BUILDS GO AHEAD WITHOUT IT.';
            }
            S.phase = 'dispatching'; render();
            const body = { level, stores: {} };
            const st = S.settings;
            if (st.on.ios) body.stores.ios = { bundleId: st.ios.bundleId, upload: st.ios.upload !== false, review: !!st.ios.review };
            if (st.on.steam) body.stores.steam = { appId: st.steam.appId, depotId: st.steam.depotId, branch: st.steam.branch, description: st.steam.description };
            if (st.on.itch) body.stores.itch = { target: st.itch.target, version: st.itch.version || todayVersion(), channels: ITCH_CHANNELS.filter((c) => st.itch.channels[c]) };
            let data, r;
            try {
                r = await fetch('/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                data = await r.json().catch(() => ({}));
            } catch (e) {
                S.phase = null;
                for (const k of stores) S.runs[k].error = 'Publish error: ' + (e && e.message || e);
                render(); return;
            }
            S.phase = null;
            if (!r.ok || !data.ok) {
                for (const k of stores) { S.runs[k].error = data.error || ('HTTP ' + r.status); S.runs[k].hint = data.hint || ''; }
                render(); return;
            }
            for (const k of stores) {
                const res = (data.results || {})[k] || { ok: false, error: 'No answer for this store.' };
                const entry = S.runs[k];
                if (!res.ok) { entry.error = res.error || 'Refused.'; entry.hint = res.hint || ''; continue; }
                entry.request = res.request;
                entry.runId = res.run ? res.run.id : null;
                entry.run = res.run || null;
                entry.actionsUrl = res.actionsUrl || '';
                entry.at = Date.now();
            }
            S.runsLevel = level;
            saveRuns();
            render();
            watch();
        }

        // ── watching the runs ──
        function stopWatch() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
        function watch() {
            stopWatch();
            const tick = async () => {
                pollTimer = null;
                if (!S.runs) return;
                let live = false;
                for (const k of Object.keys(S.runs)) {
                    const entry = S.runs[k];
                    if (entry.error || (entry.run && entry.run.status === 'completed')) continue;
                    if (!entry.request && !entry.runId) continue;
                    try {
                        const q = entry.runId ? 'run=' + encodeURIComponent(entry.runId) : 'request=' + encodeURIComponent(entry.request);
                        const r = await fetch('/api/publish?store=' + k + '&' + q + (entry.review ? '&review=1' : ''), { cache: 'no-store' });
                        const data = await r.json().catch(() => ({}));
                        if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
                        if (!data.run) {
                            // Not listed yet; two minutes means the dispatch went
                            // somewhere this cannot see.
                            if (Date.now() - (entry.at || 0) > 120000) {
                                entry.error = 'GitHub accepted the dispatch but listed no run for it.';
                                entry.hint = entry.actionsUrl ? 'Look at ' + entry.actionsUrl : '';
                            } else live = true;
                            continue;
                        }
                        if (!entry.runId) { entry.runId = data.run.id; saveRuns(); }
                        const was = entry.run && entry.run.status;
                        entry.run = data.run;
                        entry.artifacts = data.artifacts || [];
                        entry.lostSight = '';
                        if (data.run.status !== 'completed') live = true;
                        else if (was !== 'completed') {
                            const name = STORES[k].name;
                            api.flash(data.run.outcome === 'ok' ? name + ': ' + data.run.headline : name + ' — ' + data.run.headline.split('. ')[0]);
                            refreshLog();
                        }
                    } catch (e) {
                        entry.lostSight = 'Lost sight of the GitHub run: ' + (e && e.message || e);
                        live = true;
                    }
                }
                renderIfChanged();
                if (live) pollTimer = setTimeout(tick, POLL_MS);
                else saveRuns();
            };
            tick();
        }
        function resume() {
            let kept = null;
            try { kept = JSON.parse(localStorage.getItem(RUNS_KEY) || 'null'); } catch (e) {}
            if (!kept || !kept.at || Date.now() - kept.at > RESUME_MS || !kept.runs || !Object.keys(kept.runs).length) {
                try { localStorage.removeItem(RUNS_KEY); } catch (e) {}
                return;
            }
            // The name box may still be empty at mount (a ?level= boot fills
            // it once the record lands), so the level is taken from the kept
            // runs and checked against the box as it fills (syncLevel).
            if (S.level && kept.level !== S.level) return;
            S.runsLevel = kept.level;
            S.runs = {};
            for (const k of Object.keys(kept.runs)) {
                if (!STORES[k]) continue;
                const r = kept.runs[k];
                S.runs[k] = { request: r.request || null, runId: r.runId || null, run: null, artifacts: [], error: '', hint: '', review: !!r.review, at: kept.at };
            }
            watch();
        }

        // ── screenshots ──
        function stopCaptureWatch() { if (captureTimer) { clearTimeout(captureTimer); captureTimer = null; } }
        async function capture() {
            if (!S.level || (S.capture && (S.capture.status === 'recording' || S.capture.status === 'cutting'))) return;
            if (api.isSav()) { S.captureError = 'THE TESTDRIVE PLAYS A CLOUD GAME BY NAME — SAVE THE CART AS ONE FIRST.'; render(); return; }
            S.captureError = '';
            try {
                const r = await fetch('/api/store-shots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: S.level }) });
                const data = await r.json().catch(() => ({}));
                if (!r.ok || !data.ok) {
                    S.captureError = (r.status === 403 || r.status === 404)
                        ? 'SCREENSHOTS ARE CAPTURED ON A LOCAL INSTALL, WHERE THE TESTDRIVE CAN RUN A BROWSER.'
                        : 'COULD NOT START THE CAPTURE: ' + String(data.error || ('HTTP ' + r.status)).toUpperCase();
                    render(); return;
                }
                S.capture = data.capture;
                render();
                watchCapture();
            } catch (e) {
                S.captureError = 'COULD NOT START THE CAPTURE: ' + String(e && e.message || e).toUpperCase();
                render();
            }
        }
        function watchCapture() {
            stopCaptureWatch();
            const tick = async () => {
                captureTimer = null;
                if (!S.capture) return;
                try {
                    const r = await fetch('/api/store-shots?capture=' + encodeURIComponent(S.capture.id), { cache: 'no-store' });
                    const data = await r.json().catch(() => ({}));
                    if (r.ok && data.ok) S.capture = data.capture;
                    // The server no longer knows the job (it restarted): not
                    // a capture to keep waiting on.
                    else if (r.status === 404) S.capture = { id: S.capture.id, status: 'failed', note: 'The capture was lost — the server restarted under it. Capture again.', shots: [] };
                } catch (e) {}
                const st = S.capture.status;
                if (st === 'recording' || st === 'cutting') { renderIfChanged(); captureTimer = setTimeout(tick, CAPTURE_POLL_MS); return; }
                if (st === 'done') { S.shots = S.capture.shots || []; S.capturedAt = new Date().toISOString(); api.flash('SCREENSHOTS CAPTURED'); }
                renderIfChanged();
            };
            tick();
        }

        // ── rendering ──
        function credOf(store) {
            const c = S.config && S.config.stores && S.config.stores[store] && S.config.stores[store].cred;
            return c || null;
        }
        function storeCard(k) {
            const st = S.settings, spec = STORES[k];
            const on = !!st.on[k], open = st.open === k;
            const cred = credOf(k);
            const credCls = !cred ? 'unknown' : cred.ok === true ? '' : cred.ok === false ? 'warn' : 'unknown';
            const credTxt = cred ? cred.text : (S.config ? 'NO TOKEN · THE RUN CANNOT START' : S.loading ? 'READING THE REPOSITORY…' : 'NO PUBLISHER HERE');
            return '<div class="pub-store' + (on ? ' on' : '') + (open ? ' open' : '') + '" data-store="' + k + '">' +
                '<button class="pub-store-main" data-action="toggle-store" data-store="' + k + '" title="Include this store">' +
                    '<span class="sheet-badge">' + spec.badge + '</span>' +
                    '<span class="sheet-txt"><span class="sheet-name">' + spec.name + '</span><span class="sheet-sub">' + spec.sub + '</span>' +
                    '<span class="pub-cred ' + credCls + '"><span class="dot"></span>' + esc(credTxt) + '</span></span>' +
                    '<span class="toggle"><span class="knob' + (on ? '' : ' off') + '"></span></span>' +
                '</button>' +
                '<button class="pub-store-gear" data-action="open-store" data-store="' + k + '" title="Settings">&rsaquo;</button>' +
            '</div>';
        }
        function seg(on, label, action, value) {
            return '<button class="seg xseg' + (on ? ' on' : '') + '" data-action="' + action + '" data-value="' + value + '">' + label + '</button>';
        }
        function toggleRow(action, badge, label, sub, on) {
            return '<button class="menu-row pub-toggle-row" data-action="' + action + '">' +
                '<span class="pub-row-left"><span class="mono-badge">' + badge + '</span><span class="pub-row-txt"><span>' + label + '</span><span class="pub-row-sub">' + esc(sub) + '</span></span></span>' +
                '<span class="toggle"><span class="knob' + (on ? '' : ' off') + '"></span></span></button>';
        }
        function field(label, inputHtml, tail, title) {
            return '<div class="pub-field"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="display-lbl">' + label + '</span>' + inputHtml +
                (tail ? '<span class="pub-tail">' + esc(tail) + '</span>' : '') + '</div>';
        }
        function input(fieldKey, value, placeholder, extra) {
            return '<input type="text" class="menu-input" data-field="' + fieldKey + '" value="' + esc(value) + '"' +
                (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') + ' spellcheck="false" autocomplete="off"' + (extra || '') + '>';
        }
        function secretNote(k) {
            const cred = credOf(k);
            const repo = S.config ? S.config.repo : 'shmupX/shmupX.github.io';
            if (!S.config) return S.loading ? { cls: '', text: 'READING THE REPOSITORY’S SECRETS…' } : { cls: 'warn', text: S.configError || 'NO PUBLISHER ON THIS ORIGIN.' };
            if (!S.config.configured) return { cls: 'warn', text: 'NO GITHUB TOKEN ON THIS MACHINE: ' + (S.config.hint || '').toUpperCase() };
            if (!cred || cred.ok === null) return { cls: '', text: 'THE TOKEN CANNOT LIST ' + repo.toUpperCase() + '’S SECRETS; THE RUN SAYS FOR ITSELF WHETHER IT COULD SHIP.' };
            if (k === 'ios') {
                if (cred.ok) return { cls: '', text: 'SECRETS ON THE REPOSITORY: BUILD_CERTIFICATE_BASE64 · BUILD_PROVISION_PROFILE_BASE64 · APPLE_TEAM_ID · ASC_KEY_ID · ASC_ISSUER_ID · ASC_API_KEY — ALL PRESENT. BUILD NUMBER ' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.HHMM.<RUN>.' };
                const noSigning = cred.missing.indexOf('BUILD_CERTIFICATE_BASE64') >= 0 || cred.missing.indexOf('BUILD_PROVISION_PROFILE_BASE64') >= 0;
                return { cls: 'warn', text: noSigning
                    ? 'NO CERTIFICATE OR PROFILE IN THE REPOSITORY SECRETS: THE RUN ARCHIVES AN UNSIGNED .IPA, ATTACHES IT AND SKIPS THE UPLOAD. ADD THE APPLE SECRETS (' + cred.missing.join(' · ') + ') AND PUBLISH AGAIN.'
                    : 'NO APP STORE CONNECT API KEY (' + cred.missing.join(' · ') + '): THE RUN SIGNS THE .IPA, ATTACHES IT AND STOPS BEFORE THE UPLOAD.' };
            }
            if (k === 'steam') {
                return cred.ok
                    ? { cls: '', text: 'SECRETS: STEAM_USERNAME · STEAM_CONFIG_VDF — PRESENT. THE DEPOT TAKES THE LINUX APPRUN FOLDER AND THE WINDOWS MSI’S FILES; BETA GOES LIVE FROM HERE, DEFAULT IS SET LIVE IN STEAMWORKS.' }
                    : { cls: 'warn', text: 'NO STEAM_CONFIG_VDF SECRET: THE RUN BUILDS AND LAYS OUT THE DEPOT, THEN STOPS BEFORE UPLOAD. LOG IN WITH STEAMCMD ONCE AND PUT ITS config.vdf (BASE64) IN THE REPOSITORY SECRETS, WITH STEAM_USERNAME.' };
            }
            return cred.ok
                ? { cls: '', text: 'SECRETS: BUTLER_API_KEY — PRESENT. ONE butler push PER CHANNEL, --userversion FROM THE FIELD ABOVE.' }
                : { cls: 'warn', text: 'NO BUTLER_API_KEY SECRET: THE RUN PACKS EVERY CHANNEL AND STOPS BEFORE PUSH. MAKE A KEY AT itch.io/user/settings/api-keys.' };
        }
        function settingsSection() {
            const k = S.settings.open;
            if (!k || !STORES[k]) return '';
            const st = S.settings, repo = S.config ? S.config.repo : 'shmupX/shmupX.github.io', ref = S.config ? S.config.ref : 'main';
            const note = secretNote(k);
            let body = '';
            if (k === 'ios') {
                const bid = st.ios.bundleId || DEFAULT_BUNDLE_ID;
                body = '<div class="menu-label">APP STORE CONNECT · ios-publish.yml ON ' + esc(repo) + ' @ ' + esc(ref) + '</div>' +
                    field('BUNDLE ID', input('ios.bundleId', bid, DEFAULT_BUNDLE_ID), bid === DEFAULT_BUNDLE_ID ? '2028.AI · RECORD EXISTS' : 'NEEDS ITS OWN APP RECORD + PROFILE',
                        'App Store Connect takes a build only for a bundle id it already has an app record for, signed with a profile for that id.') +
                    toggleRow('toggle-upload', 'TF', 'UPLOAD TO TESTFLIGHT', st.ios.upload !== false ? 'ON · THE SIGNED .IPA GOES TO TESTFLIGHT' : 'OFF · SIGN, ATTACH THE .IPA TO THE RUN, STOP', st.ios.upload !== false) +
                    toggleRow('toggle-review', 'RV', 'SUBMIT FOR APP STORE REVIEW', 'ONCE APPLE HAS PROCESSED THE BUILD · USES THE ASC API KEY · NEEDS THE LISTING BELOW', !!st.ios.review);
            } else if (k === 'steam') {
                body = '<div class="menu-label">STEAM · steam-publish.yml · STEAMPIPE ON A GITHUB RUNNER · LINUX + WINDOWS DESKTOP BUILDS</div>' +
                    '<div class="pub-grid2">' +
                        field('APP ID', input('steam.appId', st.steam.appId, '3482910', ' inputmode="numeric"')) +
                        field('DEPOT ID', input('steam.depotId', st.steam.depotId, '3482911', ' inputmode="numeric"')) +
                    '</div>' +
                    '<div class="display-row" title="Which branch the build is set live on. DEFAULT is what every player gets, and only Steamworks sets it live; BETA needs opting in and goes live from here."><span class="display-lbl">BRANCH</span><div class="seg-wrap">' +
                        seg(st.steam.branch !== 'beta', 'DEFAULT', 'steam-branch', 'default') + seg(st.steam.branch === 'beta', 'BETA', 'steam-branch', 'beta') +
                    '</div></div>' +
                    field('DESCRIPTION', input('steam.description', st.steam.description, (S.level || 'game') + ' · ' + new Date().toISOString().slice(0, 10) + ' · editor publish'));
            } else {
                body = '<div class="menu-label">ITCH.IO · itch-publish.yml · BUTLER PUSH, ONE CHANNEL PER BUILD</div>' +
                    '<div class="pub-grid2">' +
                        field('TARGET', input('itch.target', st.itch.target, 'easierbycode/' + (S.level || 'game').toLowerCase())) +
                        field('VERSION', input('itch.version', st.itch.version, todayVersion())) +
                    '</div>' +
                    '<div class="display-row" title="One butler channel per build. WIN and LINUX are the desktop exports; MAC is the .app; WEB is the Phaser build, playable in the itch page."><span class="display-lbl">CHANNELS</span><div class="seg-wrap">' +
                        ITCH_CHANNELS.map((c) => seg(!!st.itch.channels[c], c.toUpperCase(), 'itch-channel', c)).join('') +
                    '</div></div>';
            }
            return '<div class="sheet-sec pub-settings" data-store="' + k + '">' + body + '<div class="pub-note ' + note.cls + '">' + esc(note.text) + '</div></div>';
        }
        function goButton() {
            const stores = picked();
            const busy = running();
            const can = !!(S.config && S.config.configured) && stores.length > 0 && !busy;
            const label = S.phase === 'saving' ? 'SAVING THE GAME…' : S.phase === 'listing' ? 'SAVING THE STORE LISTING…' : S.phase === 'dispatching' ? 'ASKING GITHUB FOR RUNNERS…'
                : busy ? 'PUBLISHING…' : !stores.length ? 'PICK A STORE ABOVE' : 'PUBLISH TO ' + stores.length + (stores.length === 1 ? ' STORE' : ' STORES');
            return '<button class="menu-row hi pub-go" data-action="publish"' + (can ? '' : ' disabled') + '>' +
                '<span class="mono-badge">GO</span><span class="pub-go-label">' + label + '</span>' +
                '<span class="pub-go-sub">' + stores.map((k) => STORES[k].badge).join(' · ') + '</span></button>';
        }
        function chipHtml(c) {
            return '<span class="pub-chip ' + c.state + '" title="' + esc(c.title) + '"><span class="dot"></span>' + esc(c.label + (c.state === 'skip' ? ' · SKIPPED' : '')) + '</span>';
        }
        function runRow(k) {
            const entry = S.runs[k], spec = STORES[k];
            let chips, headline, cls;
            if (entry.run && entry.run.chips) {
                chips = entry.run.chips;
            } else {
                const keys = spec.chips.slice();
                if (entry.review) keys.push('REVIEW');
                chips = keys.map((key) => ({ key, label: key, title: CHIP_TITLES[k][key] || key, state: 'todo' }));
            }
            if (entry.error) {
                headline = esc(entry.error) + (entry.hint ? ' ' + esc(entry.hint) : '');
                cls = 'fail';
            } else if (S.phase === 'saving') { headline = 'Saving game before publish…'; cls = 'run'; }
            else if (S.phase === 'listing') { headline = 'Saving the store listing…'; cls = 'run'; }
            else if (S.phase === 'dispatching') { headline = 'Dispatching the workflow…'; cls = 'run'; }
            else if (!entry.run) { headline = esc(entry.lostSight || spec.queued) + (entry.actionsUrl ? ' ' + link(entry.actionsUrl, 'ACTIONS') : ''); cls = 'run'; }
            else {
                const run = entry.run;
                headline = esc(run.headline);
                if (k === 'ios' && run.outcome === 'ok' && run.uploaded) headline += esc(' It shows in App Store Connect once Apple has processed it.');
                if (k === 'ios' && run.outcome === 'warn' && run.signed === false) headline += esc(' Add the Apple signing secrets to the repository and publish again for TestFlight.');
                if (run.status === 'completed' && run.outcome === 'fail') for (const e of (run.errors || []).slice(1)) headline += '<br>' + esc(e);
                if (entry.lostSight) headline += ' ' + esc(entry.lostSight);
                headline += ' ' + link(run.url, 'OPEN RUN');
                for (const a of entry.artifacts || []) headline += ' ' + link(a.url, a.label);
                cls = run.outcome === 'ok' ? 'ok' : run.outcome === 'fail' ? 'fail' : 'run';
            }
            return '<div class="pub-run"><div class="pub-run-head"><span class="mono-badge">' + spec.badge + '</span><span class="pub-run-name">' + spec.name + '</span>' +
                '<div class="pub-chips">' + chips.map(chipHtml).join('') + '</div></div>' +
                '<div class="pub-note ' + cls + '">' + headline + '</div></div>';
        }
        function runsSection() {
            if (!S.runs) return '';
            const keys = Object.keys(S.runs);
            const live = running();
            return '<div class="pub-runs"><div class="menu-label">THIS PUBLISH · ' + (live ? 'WATCHING ' + keys.length + (keys.length === 1 ? ' RUN' : ' RUNS') + ' · EVERY 8 S' : 'FINISHED · LOGGED BELOW') + '</div>' +
                keys.map(runRow).join('') + '</div>';
        }
        function shotsGrid() {
            const stores = picked();
            const going = S.capture && (S.capture.status === 'recording' || S.capture.status === 'cutting');
            const byKey = {};
            for (const sh of S.shots) byKey[sh.store + '/' + sh.key] = sh;
            let html = '';
            for (const k of stores) {
                for (const d of SHOT_SIZES[k]) {
                    const sh = byKey[k + '/' + d[0]];
                    const state = sh ? 'READY' : going ? (S.capture.status === 'cutting' ? 'CUTTING…' : 'RECORDING…') : 'EMPTY';
                    const cls = sh ? 'ready' : going ? 'recording' : '';
                    const tile = '<div class="pub-shot-tile ' + cls + '" style="aspect-ratio:' + d[2] + '/' + d[3] + '">' +
                        (sh ? '<img src="' + esc(sh.url) + (S.capturedAt ? '&t=' + encodeURIComponent(S.capturedAt) : '') + '" alt="">' : state) + '</div>';
                    html += '<div class="pub-shot">' + (sh ? '<a href="' + esc(sh.url) + '" target="_blank" rel="noopener" title="Open the still">' + tile + '</a>' : tile) +
                        '<div class="pub-shot-lbl">' + esc(d[1] + ' · ' + d[2] + '×' + d[3]) + '</div></div>';
                }
            }
            return html;
        }
        function listingSection() {
            const st = S.settings;
            const going = S.capture && (S.capture.status === 'recording' || S.capture.status === 'cutting');
            const has = S.shots.length > 0;
            const cmd = 'deno task testdrive:parity ' + (S.level || '<game>') + ' -- --targets web';
            let noteCls = '', noteTxt;
            if (S.captureError) { noteCls = 'warn'; noteTxt = S.captureError; }
            else if (S.capture && S.capture.status === 'failed') { noteCls = 'fail'; noteTxt = S.capture.note; }
            else if (going) { noteCls = 'run'; noteTxt = S.capture.note || 'The pilot is playing ' + S.level + ' on the web runtime…'; }
            else if (has) { noteCls = 'ok'; noteTxt = (S.shots[0] && S.shots[0].path ? 'build/publish/' + S.shots[0].path.split('/')[0] + '/testdrive/panes/web.mp4' : 'The recording') + ' → ' + S.shots.length + ' stills, one set per store. The App Store ones ride up with the next publish; the Steam and itch.io ones are downloads for their store pages.'; }
            else noteTxt = 'Nothing captured yet. Each store gets stills in its own sizes from one testdrive recording.';
            return '<div class="pub-col">' +
                '<div class="menu-label">STORE LISTING · SHARED BY EVERY STORE</div>' +
                field('TITLE', input('listing.title', st.listing.title, api.label()), 'FROM THE TITLE SCREEN') +
                '<textarea class="pub-textarea" rows="3" data-field="listing.description" placeholder="SHORT DESCRIPTION · 170 CHARACTERS FOR APP STORE, 300 FOR STEAM" spellcheck="false">' + esc(st.listing.description) + '</textarea>' +
                '<button class="menu-row" data-action="capture"' + (going || !S.level ? ' disabled' : '') + ' title="' + esc(cmd + ': the tool-assisted pilot plays the level, the recording is cut into stills and sized for every picked store') + '">' +
                    '<span class="mono-badge">TD</span><span class="pub-row-txt" style="flex:1;min-width:0"><span>' + (going ? 'RECORDING WITH TESTDRIVE…' : has ? 'RECAPTURE SCREENSHOTS' : 'CAPTURE SCREENSHOTS') + '</span>' +
                    '<span class="pub-row-sub pub-ellipsis">' + esc(cmd) + ' · STILLS CUT TO EACH STORE’S SIZES</span></span></button>' +
                '<div class="pub-shots">' + shotsGrid() + '</div>' +
                '<div class="pub-note ' + noteCls + '">' + esc(noteTxt) + '</div>' +
                (S.listingNote ? '<div class="pub-note warn">' + esc(S.listingNote) + '</div>' : '') +
            '</div>';
        }
        function logSection() {
            let rows = '';
            if (S.logError) rows += '<div class="pub-note warn">' + esc(S.logError.toUpperCase()) + '</div>';
            if (!S.log.length && !S.logError) rows += '<div class="pub-note">' + (S.loading ? 'READING THE RUNS…' : !S.config ? 'THE LOG IS READ FROM GITHUB, WHICH THIS ORIGIN CANNOT ASK.' : !S.config.configured ? 'NO TOKEN, NO LOG.' : !S.level ? 'A GAME WITH A CLOUD NAME HAS A LOG.' : 'NOTHING PUBLISHED YET.') + '</div>';
            for (const l of S.log) {
                const spec = STORES[l.store] || { badge: '??' };
                const color = l.outcome === 'ok' ? '#84cc16' : l.outcome === 'fail' ? '#f87171' : '#f59e0b';
                const title = String(l.headline || '').split(' — ')[0].split('. ')[0].replace(/\.?$/, '.');
                rows += '<div class="pub-log-row"><span class="mono-badge">' + spec.badge + '</span>' +
                    '<span class="pub-log-txt"><span class="pub-log-title"><span class="dot" style="background:' + color + ';box-shadow:0 0 8px ' + color + '"></span><span class="pub-log-title-txt">' + esc(title) + '</span></span>' +
                    '<span class="pub-log-when">' + esc(when(l.createdAt)) + (l.detail ? ' · ' + esc(l.detail) : '') + '</span></span>' +
                    '<span class="pub-log-links">' + link(l.url, 'RUN #' + l.number) + (l.artifacts || []).map((a) => link(a.url, a.label)).join('') + '</span></div>';
            }
            return '<div class="pub-col"><div class="menu-label">PUBLISHES · ' + esc((S.level || api.label() || '').toUpperCase()) + ' · EVERY RUN, NEWEST FIRST</div>' + rows + '</div>';
        }
        function titleSub() {
            const name = (S.level || api.label() || '').toUpperCase();
            const saved = api.lastSavedAt();
            return esc(name) + ' · ' + (api.isSav() ? 'IMPORTED CART' : 'CLOUD GAME') + ' · ' + (saved ? 'SAVED ' + clock(saved) : S.level ? 'SAVED EARLIER' : 'NOT SAVED YET');
        }
        // The polls call this rather than render(): a tick that changed
        // nothing visible must not rebuild the sheet under a finger or a
        // caret.
        let lastSnapshot = '';
        function renderIfChanged() {
            const snap = JSON.stringify([S.capture, S.runs, S.shots, S.capturedAt, S.log, S.phase, S.config && S.config.configured]);
            if (snap === lastSnapshot) return;
            lastSnapshot = snap;
            render();
        }
        function render() {
            if (!S.isOpen) return;
            // The sheet itself is made once per opening and kept: rebuilding it
            // would replay its slide-in on every click and drop its scroll.
            let panel = host.querySelector('.picker-panel');
            if (!panel) {
                panel = document.createElement('div');
                panel.className = 'picker-panel pub';
                host.appendChild(panel);
            }
            const scroll = panel.scrollTop;
            // The field being typed into, and where the caret was, so the
            // rebuild hands them back.
            const active = document.activeElement;
            const typing = active && host.contains(active) && active.dataset && active.dataset.field
                ? { field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd }
                : null;
            panel.innerHTML =
                    '<div class="picker-title">PUBLISH<span class="pub-title-sub">' + titleSub() + '</span></div>' +
                    '<div class="sheet-opts pub-body">' +
                        (S.configError ? '<div class="pub-note warn">' + esc(S.configError) + '</div>' : '') +
                        (S.config && !S.config.configured ? '<div class="pub-note warn">NO GITHUB TOKEN ON THIS MACHINE · ' + esc((S.config.hint || '').toUpperCase()) + '</div>' : '') +
                        '<div class="menu-label">STORES · PICK WHERE THIS BUILD GOES</div>' +
                        '<div class="pub-stores">' + STORE_IDS.map(storeCard).join('') + '</div>' +
                        settingsSection() +
                        goButton() +
                        runsSection() +
                        '<div class="pub-cols">' + listingSection() + logSection() + '</div>' +
                    '</div>' +
                    '<div class="picker-hint sheet-foot">EVERY STORE BUILDS ON A GITHUB RUNNER · THIS MACHINE ONLY NEEDS A GITHUB TOKEN · THE GAME IS SAVED FIRST</div>';
            if (scroll) panel.scrollTop = scroll;
            if (typing) {
                const el = host.querySelector('[data-field="' + typing.field + '"]');
                if (el) {
                    el.focus({ preventScroll: true });
                    try { el.setSelectionRange(typing.start, typing.end); } catch (e) {}
                }
            }
        }

        // ── events ──
        host.addEventListener('click', (ev) => {
            if (ev.target === host) { close(); return; }
            const btn = ev.target.closest('[data-action]');
            if (!btn || btn.disabled) return;
            const st = S.settings;
            const act = btn.dataset.action;
            switch (act) {
                case 'toggle-store': st.on[btn.dataset.store] = !st.on[btn.dataset.store]; break;
                case 'open-store': st.open = st.open === btn.dataset.store ? null : btn.dataset.store; break;
                case 'toggle-upload': st.ios.upload = st.ios.upload === false; break;
                case 'toggle-review': st.ios.review = !st.ios.review; break;
                case 'steam-branch': st.steam.branch = btn.dataset.value; break;
                case 'itch-channel': st.itch.channels[btn.dataset.value] = !st.itch.channels[btn.dataset.value]; break;
                case 'publish': publish(); return;
                case 'capture': capture(); return;
                default: return;
            }
            saveSettings();
            render();
        });
        host.addEventListener('input', (ev) => {
            const el = ev.target.closest('[data-field]');
            if (!el) return;
            const path = el.dataset.field.split('.');
            let node = S.settings;
            for (let i = 0; i < path.length - 1; i++) node = node[path[i]];
            node[path[path.length - 1]] = el.value;
            saveSettings();
        });

        function open(opts) {
            const changed = syncLevel();
            if (opts && opts.store && STORES[opts.store]) {
                S.settings.on[opts.store] = true;
                S.settings.open = opts.store;
                saveSettings();
            }
            S.isOpen = true;
            host.classList.remove('hidden');
            render();
            if (changed || !S.config) { loadConfig(); loadShots(); }
            else { refreshLog(); loadShots(); }
        }
        function close() {
            S.isOpen = false;
            host.classList.add('hidden');
            // Emptied, so the next opening slides in from the bottom again.
            host.innerHTML = '';
        }

        // A publish survives a reload — the run keeps going on GitHub — so
        // the watch is picked back up now, for two hours, and the flash
        // fires whether or not the sheet is open.
        syncLevel();
        resume();

        return {
            open, close,
            isOpen: () => S.isOpen,
            running,
            setTheme: () => {},
            destroy: () => { stopWatch(); stopCaptureWatch(); },
        };
    }

    window.PublishPanel = { mount, STORES, SHOT_SIZES };
})();
