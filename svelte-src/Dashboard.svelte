<script>
  import { onMount, onDestroy, untrack } from 'svelte';
  import Osd from './Osd.svelte';
  import SavPicker from './SavPicker.svelte';
  // The PS2 shelf the level editor files its own builds in, and the rule for
  // what emu-sw.js is allowed to mirror. Shared with static/editor/index.html
  // (which imports the same module at runtime) so the two cannot drift — see
  // static/ps2-library.js.
  import {
    emuStateFor,
    listPs2Games,
    ps2PlayerUrl,
  } from '../static/ps2-library.js';

  const MAIN_MENU = [
    { id: 'games',    label: 'Games',    tag: '01 / disc.io',  num: '0x01' },
    { id: 'settings', label: 'Settings', tag: '02 / config',   num: '0x02' },
    { id: 'desktop',  label: 'Desktop',  tag: '03 / wkstn.ui', num: '0x03' },
  ];

  // Baked-in fallback snapshot of the game list — the offline / pre-manifest
  // seed. At runtime loadManifest() replaces it with the fetched same-origin
  // manifest (static/games.manifest.json); this inline copy only renders when
  // the manifest fetch fails (fully offline).
  const SEED_GAMES = [
    { id: 'shmupx', name: 'shmupX', title: 'SHMUPX', sub: 'Level Editor // Phaser 4', icon: '/icons/2028-icon.png', size: '— MB', date: '—', url: '/editor/?game=2028-ai' },
  ];

  // Reactive base game list: starts as the baked seed, then replaced at
  // runtime by the fetched manifest (see loadManifest). The rendered GAMES
  // list is derived from this — see below.
  let manifestGames = $state([...SEED_GAMES]);
  // Origin the active manifest came from; game `url`s resolve against it
  // ('' = same-origin / relative — always the case here, which keeps frames
  // root-relative so mapped gamepad→keyboard input injection works).
  let manifestOrigin = $state('');

  let screen = $state('dashboard'); // 'dashboard' | 'games' | 'settings' | 'emulators'
  let menuSel = $state(0);           // start on Games
  let gameSel = $state(0);
  let clockStr = $state('--:--:--');
  // Same clock without the seconds, for the cramped strip header. Set in the
  // tick beside clockStr rather than sliced off it — a slice would cut the
  // 12-hour string's AM/PM away.
  let clockShort = $state('--:--');
  let gameSrc = $state(null);
  let gameOn = $state(false);
  let bootGone = $state(false);
  let gameRowEls = $state([]);
  let gameListEl = $state(null);

  // ─── Section strip ─────────────────────────────────────────────────────────
  // The catalog is a section of ONE screen: the strip across the top selects a
  // section, the list under it shows that section's rows. `secSel` indexes
  // SECTIONS (below); `stripFocus` says which of the two the cursor is in —
  // Down off the strip enters the list, Up from row 0 returns to it, so the
  // two halves behave like one continuous column.
  //
  // The strip only earns its row when there is more than one section to switch
  // between: shmupX ships the catalog alone, and a one-tile rail is pure chrome.
  // `stripShown` gates the markup and `stripOn` is the focus flag every consumer
  // reads — a hidden strip can never hold the cursor, whatever stripFocus says.
  let secSel = $state(0);
  let stripFocus = $state(true);
  let stripEl = $state(null);
  let tileEls = $state([]);
  // The selected section's file picker, rendered once and re-pointed by the
  // section descriptor. No current section declares one, but the plumbing
  // stays generic — a section with a `picker` gets it back for free.
  let byodInputEl = $state(null);
  let byodBtnEl = $state(null);

  // ─── Emulators (opt-in downloads) ──────────────────────────────────────────
  // shmupX ships no emulator cores. static/emulators.json is the catalogue;
  // installing one records its id here and hands its path prefixes to
  // static/emu-sw.js, which from then on answers those paths from Cache Storage,
  // pulling anything it does not already hold from the cmg origin. Every byte
  // therefore arrives SAME-ORIGIN, which is what lets the launcher's mapped
  // gamepad→keyboard input reach the player frame at all.
  //
  // Nothing is downloaded up front beyond the player page, the ROM manifest and
  // the catalogue's shared scripts (see installCore); the core wasm, BIOS and
  // ROMs materialise as the player asks for them.
  const EMU_KEY = 'shmupx-emulators';
  const EMU_SW = '/emu-sw.js';
  const EMU_CATALOG = '/emulators.json';
  // emu-sw.js's own cache name and state key. The worker sends no reply, but it
  // persists the state it applied here, which is the only ack available — see
  // pushEmuState. Keep in sync with CACHE / STATE_URL in static/emu-sw.js.
  const EMU_CACHE = 'shmupx-emu-v1';
  const EMU_STATE_URL = '/__emu-state.json';
  function loadInstalledEmus() {
    try {
      const v = JSON.parse(localStorage.getItem(EMU_KEY) || '[]');
      return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
    } catch (_) { return []; }
  }
  let emuCatalog = $state(null);              // parsed /emulators.json, null until fetched
  let emuInstalled = $state(loadInstalledEmus());
  // Fetched ROM manifests, keyed by core id. undefined = not read yet, null =
  // the read failed, [] = a real empty shelf (several consoles deploy none).
  let emuManifests = $state({});
  // In-flight manifest reads, so a re-entrant call can't double-fetch. Plain
  // Set, not $state: nothing renders off it.
  const emuManifestPending = new Set();
  // Per-core install progress: { busy, step, total, err }.
  let emuStatus = $state({});
  // Row cursor per installed section, keyed by core id — the sections are
  // dynamic, so they share one map instead of a rune each.
  let emuSecSel = $state({});
  let emuSel = $state(0);                     // cursor on the Emulators screen
  let emuRowEls = $state([]);

  let emuCores = $derived(emuCatalog?.cores || []);
  let emuShared = $derived(emuCatalog?.shared || []);
  let installedCores = $derived(emuCores.filter((c) => emuInstalled.includes(c.id)));

  // The worker only answers paths it has been handed: the union of every
  // installed core's prefixes, each core's tile icon (which lives under /icons/
  // on the cmg origin, outside its own prefixes) and the catalogue's shared
  // scripts (which sit at the root, under no core at all). With nothing
  // installed the message is empty and the worker stays out of the way.
  //
  // The rule itself lives in static/ps2-library.js because the editor installs
  // the PS2 core too, and two copies of it would eventually disagree about what
  // the worker may mirror. It returns plain arrays, which is what postMessage
  // needs — a $state-backed one is not structured-cloneable.
  function emuState() {
    return emuStateFor(emuCatalog, [...emuInstalled]);
  }

  // Registering is idempotent — register() on an already-installed worker
  // resolves with the existing one. Resolves once the worker is not merely
  // active but CONTROLLING this page: an uncontrolled page's fetches never
  // reach it, so warming would 404 against this origin instead of mirroring.
  let emuSwReady = null;
  function readyEmuWorker() {
    if (emuSwReady) return emuSwReady;
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    emuSwReady = (async () => {
      await navigator.serviceWorker.register(EMU_SW);
      const reg = await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); resolve(); };
          // A claim that never lands must not hang an install forever.
          const timer = setTimeout(done, 8000);
          navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
          // The worker may have claimed the page between the check above and
          // the listener attaching; controllerchange would never fire again.
          if (navigator.serviceWorker.controller) done();
        });
      }
      return reg;
    })().catch(() => null);
    return emuSwReady;
  }

  async function emuWorker() {
    const reg = await readyEmuWorker();
    return reg?.active || navigator.serviceWorker?.controller || null;
  }

  // The worker handles the message asynchronously, and a fetch that beats it
  // lands on this origin — a 404 — instead of the mirror. There is no reply
  // channel, but the worker persists the state it applied, so wait for that copy
  // to match before treating the mirrored paths as live.
  async function confirmEmuState(state) {
    const want = state.prefixes.join('|');
    for (let i = 0; i < 60; i++) {
      try {
        const res = await (await caches.open(EMU_CACHE)).match(EMU_STATE_URL);
        if (res) {
          const got = await res.json();
          if (got.origin === state.origin && (got.prefixes || []).join('|') === want) return true;
        }
      } catch (_) { return false; } // no Cache Storage — nothing to wait for
      await new Promise((r) => setTimeout(r, 40));
    }
    return false;
  }

  async function pushEmuState() {
    // Snapshot before awaiting so the message can't describe a set that moved
    // on while the worker was coming up. emuState() builds plain arrays of plain
    // strings on purpose — a $state-backed array is not structured-cloneable.
    const state = emuState();
    const w = await emuWorker();
    if (!w) return;
    w.postMessage({ type: 'emu-state', state });
    await confirmEmuState(state);
  }

  function persistEmus() {
    try { localStorage.setItem(EMU_KEY, JSON.stringify(emuInstalled)); } catch (_) {}
  }

  // Read once per install and cached. An empty array is a real answer, so it is
  // stored as-is and the section renders its shelf note rather than an error.
  async function loadEmuManifest(core, force = false) {
    if (!core) return;
    if (emuManifestPending.has(core.id)) return;
    if (!force && emuManifests[core.id] !== undefined) return;
    emuManifestPending.add(core.id);
    try {
      await readyEmuWorker();
      const r = await fetch(core.manifest, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      emuManifests = { ...emuManifests, [core.id]: Array.isArray(data) ? data : [] };
    } catch (_) {
      emuManifests = { ...emuManifests, [core.id]: null };
    } finally {
      emuManifestPending.delete(core.id);
    }
  }

  // Install: record the core, hand the worker its prefixes, then warm the few
  // files the section needs to be usable immediately — the player page, the ROM
  // manifest, and the catalogue's shared scripts. These are same-origin fetches
  // the worker mirrors and keeps, which is why the section works offline after.
  //
  // A failed warm leaves the core INSTALLED and flags the row instead of rolling
  // back: the worker is already primed, so nothing is broken by keeping it, and
  // A on the flagged row retries the same warm.
  async function installCore(id) {
    const core = emuCores.find((c) => c.id === id);
    if (!core || emuStatus[id]?.busy) return;
    if (!emuInstalled.includes(id)) {
      emuInstalled = [...emuInstalled, id];
      persistEmus();
    }
    const targets = [core.player, core.manifest, ...emuShared].filter(Boolean);
    const set = (v) => (emuStatus = { ...emuStatus, [id]: v });
    set({ busy: true, step: 0, total: targets.length, err: '' });
    await pushEmuState();
    let done = 0;
    for (const path of targets) {
      try {
        const r = await fetch(path, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        // Drain the body: the worker's cache.put() only completes once the
        // response has been read, so progress must not run ahead of it.
        await r.arrayBuffer();
      } catch (e) {
        set({ busy: false, step: done, total: targets.length, err: 'WARM FAILED · ' + path });
        showToast(core.name + ': could not fetch ' + path + ' — press A to retry.');
        return;
      }
      set({ busy: true, step: ++done, total: targets.length, err: '' });
    }
    set({ busy: false, step: done, total: targets.length, err: '' });
    await loadEmuManifest(core, true);
  }

  // Uninstall: drop the id, persist, re-state the worker (so it stops answering
  // those paths) and only then evict — the two messages arrive in order, so the
  // worker is never asked to serve a prefix it has just dropped the bytes for.
  async function uninstallCore(id) {
    const core = emuCores.find((c) => c.id === id);
    if (!core) return;
    emuInstalled = emuInstalled.filter((x) => x !== id);
    persistEmus();
    const m = { ...emuManifests }; delete m[core.id]; emuManifests = m;
    const s = { ...emuStatus }; delete s[core.id]; emuStatus = s;
    // Spread out of the reactive proxy: a $state-backed array is not structured-
    // cloneable and postMessage throws DataCloneError on it, silently leaving
    // every mirrored byte in the cache.
    const gone = [...(core.prefixes || [])];
    if (core.icon) gone.push(core.icon);
    // The shared scripts belong to whichever cores are installed; with the last
    // one gone they are dead weight, so they leave with it.
    if (!installedCores.length) gone.push(...emuShared);
    await pushEmuState();
    const w = await emuWorker();
    if (w) w.postMessage({ type: 'emu-evict', prefixes: gone });
  }

  // ─── The local PS2 shelf ───────────────────────────────────────────────────
  // PS2 games built on this machine — the level editor's TARGET -> PS2 export,
  // filed through static/ps2-library.js. They live in IndexedDB rather than on
  // the mirror, so they are read here and shown ahead of the hosted rows in the
  // PlayStation 2 section. Nothing else in the launcher knows they are local.
  let ps2Local = $state([]);
  async function refreshPs2Local() {
    try { ps2Local = await listPs2Games(); } catch (_) { ps2Local = []; }
  }

  // Boot: read the saved set, read the catalogue, register the worker and hand
  // it the current state, then fill in the installed cores' shelves. Strictly
  // sequential — a manifest read before the worker holds the prefixes would
  // 404 against this origin.
  async function initEmulators() {
    refreshPs2Local();
    try {
      const r = await fetch(EMU_CATALOG, { cache: 'no-store' });
      if (r.ok) emuCatalog = await r.json();
    } catch (_) { /* no catalogue — the Emulators screen says so */ }
    await pushEmuState();
    if (!emuCatalog) return;
    for (const c of installedCores) loadEmuManifest(c);
  }

  // Row badge on the Emulators screen — the same GET / ⬇ / INSTALLED vocabulary
  // the network installs use elsewhere in the launcher.
  function emuBadge(c) {
    const st = emuStatus[c.id];
    if (st?.busy) return { cls: 'dl', text: '⬇ ' + st.step + ' / ' + st.total };
    if (st?.err) return { cls: 'err', text: '! RETRY' };
    return emuInstalled.includes(c.id)
      ? { cls: 'ok', text: 'INSTALLED' }
      : { cls: 'get', text: 'GET ⬇' };
  }

  function activateEmulator(i) {
    const c = emuCores[i];
    if (!c) return;
    emuSel = i;
    if (emuStatus[c.id]?.busy) return;
    sfx.enter();
    // A on a flagged row retries the warm rather than uninstalling — the fix
    // for a half-installed core is the one press already under the cursor.
    if (emuInstalled.includes(c.id) && !emuStatus[c.id]?.err) uninstallCore(c.id);
    else installCore(c.id);
  }

  let emuCurrent = $derived(emuCores[emuSel]);
  let emuCounterText = $derived(
    String(Math.min(emuSel + 1, emuCores.length)).padStart(2, '0') + ' / ' +
    String(emuCores.length).padStart(2, '0')
  );
  let emuStateLabel = $derived.by(() => {
    const c = emuCurrent;
    if (!c) return '—';
    const st = emuStatus[c.id];
    if (st?.busy) return 'INSTALLING ' + st.step + ' / ' + st.total;
    if (st?.err) return st.err;
    return emuInstalled.includes(c.id) ? 'INSTALLED' : 'NOT INSTALLED';
  });
  let emuActionLabel = $derived.by(() => {
    const c = emuCurrent;
    if (!c) return 'Select';
    const st = emuStatus[c.id];
    if (st?.busy) return 'Working…';
    if (st?.err) return 'Retry';
    return emuInstalled.includes(c.id) ? 'Uninstall' : 'Install';
  });

  // ─── Settings → Theme ──────────────────────────────────────────────────────
  // Dashboard skins. 'xbox' is the shipped green look; 'xbox360' is the
  // Xbox-360 blades skin extracted from the embedded blade OSD that used to
  // ship inside 2019 TURBO / 2028.Ai; 'nintendo' is the NES cabinet palette
  // ported from codemonkey-games-launcher (body.theme-* overrides in
  // dashboard.css).
  const THEMES = [
    { id: 'xbox', label: 'XBOX' },
    { id: 'xbox360', label: 'XBOX 360' },
    { id: 'nintendo', label: 'NINTENDO' },
  ];
  let SETTINGS_ITEMS = $derived([
    {
      id: 'theme',
      label: 'THEME',
      sub: THEMES.map((t) => (t.id === tweaks.theme ? `[ ${t.label} ]` : t.label)).join('  ·  '),
    },
    {
      id: 'emulators',
      label: 'EMULATORS',
      sub: installedCores.length
        ? installedCores.map((c) => c.mark).join('  ·  ')
        : 'none installed  ·  add a console',
    },
  ]);
  let settingsSel = $state(0);
  let settingsRowEls = $state([]);
  // The rendered Games list. Reassigning manifestGames re-derives this.
  let GAMES = $derived([...manifestGames]);

  // --- online 2P presence -------------------------------------------------
  //
  // Which catalogue entries somebody is playing RIGHT NOW, so a row can say so
  // and launch straight into the game's own join panel. Keyed by the netplay
  // session's gameId, which for a shipped game is its catalogue id.
  //
  // Entirely optional: the client is imported lazily and every failure path
  // leaves this empty, so a launcher with no network looks exactly as it does
  // today.
  let liveRuns = $state({});
  let liveTotal = $state(null);
  let netplayApi = null;

  // A session is keyed by the LEVEL being played, not by a catalogue row —
  // shmupX's single entry covers every level its editor can open, so an exact
  // id match would never fire for it. So: an exact match wins where one exists
  // (a future catalogue entry that is one specific game), and otherwise any
  // live run counts toward the shmupX-hosted rows, which is what those rows
  // actually mean. External games get nothing, correctly: this launcher has no
  // idea what is happening inside somebody else's origin.
  function liveFor(row) {
    if (!row) return null;
    const exact = liveRuns[row.key];
    if (exact) return exact;
    const url = row.g && row.g.url;
    const ours = typeof url === 'string' && !/^https?:/i.test(url);
    return ours ? liveTotal : null;
  }

  async function initNetplayPresence() {
    try {
      const mod = await import('/netplay/shmupx-netplay.js');
      const opts = {};
      // Dev overrides, so a local SpacetimeDB can be pointed at without
      // touching the built defaults.
      const uri = qs('netplayUri');
      if (uri) opts.uri = uri;
      const db = qs('netplayDb');
      if (db) opts.moduleName = db;
      // No gameId filter: the launcher wants every game's runs at once.
      netplayApi = await mod.netplay(opts);
      if (!netplayApi) return;
      netplayApi.onSessions((rows) => {
        const next = {};
        let total = null;
        for (const r of rows) {
          const cur = next[r.gameId] || { count: 0, joinable: false };
          cur.count += 1;
          cur.joinable = cur.joinable || r.joinable;
          next[r.gameId] = cur;
          total = total || { count: 0, joinable: false };
          total.count += 1;
          total.joinable = total.joinable || r.joinable;
        }
        liveRuns = next;
        liveTotal = total;
      });
    } catch (err) {
      // No bundle (offline export), no network, no database — all the same.
      console.warn('[netplay] presence unavailable:', err && err.message ? err.message : err);
    }
  }

  function qs(name) {
    try {
      return new URLSearchParams(location.search).get(name);
    } catch (e) {
      return null;
    }
  }
  let isTouch = $state(false);
  let padHadConnection = $state(false);
  let padConnected = $state(false);
  // Which device last drove the UI — 'mouse' | 'touch' | 'key' | 'pad'. Only
  // consumed by the cursor policy (see the no-cursor effect), so it is a plain
  // let, not $state: nothing renders off it. Defaults to 'pad' because a
  // couch session starts on the controller.
  let lastInput = 'pad';
  // An editor runs in the game frame but is a button-dense editor UI: the
  // transparent .osd-corner hit-zones would swallow taps on its toolbar corners
  // (enemy/item pickers top-left, save/menu top-right) and on grid cells in the
  // bottom corners. While one is the active frame the overlay zones are
  // suppressed and the same gestures are detected by listeners injected into
  // the (guaranteed same-origin) frame instead — see injectEditorCornerGesture.
  //
  // The frame can also navigate itself away from the editor (the SAVED GAMES
  // shelf's player mode swaps it for /games/…), so the live location — read on
  // each frame load, null for cross-origin frames — outranks gameSrc here:
  // once the editor frame becomes a game, the corner zones and the Guide's
  // Sound section come back.
  let frameUrl = $state(null);
  let editorFrameActive = $derived.by(() => {
    const src = typeof frameUrl === 'string' ? frameUrl : gameSrc;
    return typeof src === 'string' && /^\/editor(\/|\?|$)/.test(src);
  });
  // Same-origin games get the launcher's Gamepad API patch (Twin-Stick /
  // touch virtual pad); cross-origin games run their own touch analogs off
  // cmg-twinstick-touch-set instead, so the launcher's zones must stand down.
  let gameFramePatchable = $derived.by(() => {
    if (typeof gameSrc !== 'string' || !gameSrc) return false;
    try { return new URL(gameSrc, window.location.href).origin === window.location.origin; }
    catch (_) { return false; }
  });
  // First touch in-game dismisses transient chrome (kept for the tg16 message
  // path). The upper-right close button is gone — Exit Game in the OSD replaces it.
  let chromeDismissed = $state(false);

  // ─── In-game OSD ("Guide") ───────────────────────────────────────────────
  // Opened by SELECT + Down (gamepad) or a two-finger bottom-left + top-right
  // tap (touch). Game section = Exit Game + Controller Settings; Look section =
  // the design's tweaks (persisted to localStorage, applied to the dashboard).
  let osdOpen = $state(false);
  let osdSel = $state(0);
  // The Guide is a two-level menu: the root list ('main') and the Cheats
  // sub-page ('cheats'). osdItems is derived off this so gamepad/keyboard nav,
  // which indexes into osdItems, transparently follows whichever page is shown.
  let osdView = $state('main');
  const osdNav = { vDir: 0, hDir: 0 }; // edge-latch for gamepad nav while open
  // Per-section collapse state (keyed by section name). A collapsed section
  // renders only its header row; its child rows are filtered out of osdItems.
  // 'Look' starts collapsed so the Guide opens compact — expand to reveal tweaks.
  // Persisted to localStorage (like the Look tweaks) so a chosen collapse/expand
  // sticks across reloads; the defaults only seed first-run / cleared storage.
  const OSD_COLLAPSE_KEY = 'cmg-osd-collapsed';
  const OSD_COLLAPSE_DEFAULTS = { Look: true };
  function loadCollapsed() {
    try { return { ...OSD_COLLAPSE_DEFAULTS, ...JSON.parse(localStorage.getItem(OSD_COLLAPSE_KEY) || '{}') }; }
    catch (_) { return { ...OSD_COLLAPSE_DEFAULTS }; }
  }
  let osdCollapsed = $state(loadCollapsed());

  // ── Sound: BGM/SFX master volumes ─────────────────────────────────────────
  // Percent sliders in the Guide's Sound section. Persisted to localStorage
  // under the same keys the 2028-ai runtime reads at boot (same origin), and
  // posted live into the running frame as 0..1 factors over cmg-volume — so
  // launcher-hosted and standalone play stay in sync. Defaults: BGM full,
  // SFX at an eighth (the effects are tuned loud relative to the music, and a
  // Dezaemon save's chiptune-voiced hits are louder still).
  const VOL_BGM_KEY = 'cmg-vol-bgm';
  const VOL_SFX_KEY = 'cmg-vol-sfx';
  function loadVolPct(key, dflt) {
    try {
      // parseFloat, not Number: a missing key reads back null, and
      // Number(null) is 0 — which would silently mute instead of defaulting.
      const v = parseFloat(localStorage.getItem(key));
      return Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : dflt;
    } catch (_) { return dflt; }
  }
  let volBgm = $state(loadVolPct(VOL_BGM_KEY, 100));
  let volSfx = $state(loadVolPct(VOL_SFX_KEY, 13));
  // targetOrigin '*' for the same reason as setPlugin: the payload is benign
  // numbers and a volume-capable game could load cross-origin.
  function postVolume() {
    const iframe = document.getElementById('gameframe');
    try { iframe?.contentWindow?.postMessage({ type: 'cmg-volume', bgm: volBgm / 100, sfx: volSfx / 100 }, '*'); }
    catch (_) { /* ignore */ }
  }
  function setVolume(key, pct) {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    if (key === 'vol-bgm') volBgm = pct; else volSfx = pct;
    try { localStorage.setItem(key === 'vol-bgm' ? VOL_BGM_KEY : VOL_SFX_KEY, String(pct)); } catch (_) {}
    postVolume();
  }
  // While the Guide is up over a running game, hold the game paused. The frame
  // acknowledges cmg-pause by sleeping its loop and suspending audio (the
  // 2028-ai runtime); frames without a listener (e.g. the editor) ignore it.
  $effect(() => {
    const paused = osdOpen;
    if (!gameOn) return;
    const iframe = document.getElementById('gameframe');
    try { iframe?.contentWindow?.postMessage({ type: 'cmg-pause', paused }, '*'); } catch (_) { /* ignore */ }
  });

  // Cheats are boot-time URL params on the running game's iframe. A game
  // advertises which ones it supports by postMessage'ing
  // { type: 'cmg-cheats', cheats: [...] } on boot (handled in onWindowMessage);
  // the OSD shows the Cheats submenu only while a game has broadcast a set, so
  // it's automatically scoped to the games that opt in. Toggling a cheat
  // rewrites gameSrc's query string and the iframe reloads with it applied.
  let osdCheats = $state([]);
  // Plugins are the live-toggle sibling of cheats. A game advertises which ones
  // it supports by postMessage'ing { type: 'cmg-plugins', plugins: [...] } on
  // boot (handled in onWindowMessage). Unlike cheats (boot-time URL params that
  // reload the iframe), a plugin toggle is applied live: flipping it posts
  // { type: 'cmg-plugin-set', id, value } back into the running frame, which the
  // game acts on without a reload (e.g. the Vertical Shooter demo's TATE Mode
  // CRT shader). The dashboard holds the last-known value; the game is only the
  // source of truth at boot, after which the OSD is the sole place it changes.
  let osdPlugins = $state([]);
  // Actions are momentary OSD buttons a game advertises by postMessage'ing
  // { type: 'cmg-actions', actions: [{ id, label }] } on boot (handled in
  // onWindowMessage). Activating one posts { type: 'cmg-action', id } back into
  // the running frame, which the game turns into an in-game action — e.g.
  // shmup-party advertises "Controls" and opens its own remapping UI. Like
  // cheats/plugins this is opt-in per game, so the rows only exist while a game
  // has broadcast a set.
  let osdActions = $state([]);
  // A game can advertise "extra" playable builds living next to it — e.g.
  // 2019-turbo's unlocked super-scaler 3D build (ex.html) — by postMessage'ing
  // { type: 'cmg-ex', url, label } on boot or the moment one is earned. Each
  // gets a launch row in the Guide's Game section that swaps the iframe to it.
  // (Level editors go through osdLevelEditor / cmg-level-editor instead.) Keyed
  // by url so re-adverts update in place; capped to keep the Guide sane.
  let osdExtras = $state([]);
  // Harden the game-supplied payload before it drives the menu: whitelist kind,
  // clamp counts/lengths, coerce slider bounds. Each item keeps a stable `key`
  // for the keyed {#each}. Returns [] on anything malformed.
  function sanitizeCheats(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const c of raw.slice(0, 12)) {
      if (!c || typeof c.param !== 'string' || !c.param) continue;
      const param = c.param.slice(0, 32);
      // One row per param: the keyed {#each} keys on 'cheat-'+param, and Svelte
      // throws at runtime on a duplicate key — so collapse repeats defensively.
      if (seen.has(param)) continue;
      seen.add(param);
      const label = (typeof c.label === 'string' && c.label) ? c.label.slice(0, 40) : param;
      const kind = c.kind === 'slider' ? 'slider' : 'toggle';
      if (kind === 'slider') {
        const min = Number.isFinite(c.min) ? c.min : 0;
        const max = Number.isFinite(c.max) ? Math.max(min, c.max) : Math.max(min, 9);
        const step = Number.isFinite(c.step) && c.step > 0 ? c.step : 1;
        const unit = typeof c.unit === 'string' ? c.unit.slice(0, 4) : '';
        // commit:true → the OSD applies the value (rewriting gameSrc, which
        // reloads the game) on the slider's change event, not on every oninput,
        // so dragging the slider doesn't reboot the game on each intermediate step.
        out.push({ key: 'cheat-' + param, param, kind, label, min, max, step, unit, commit: true });
      } else {
        // Optional `on` is the param value that means "enabled" (e.g. the
        // Akuma cheat's ?boss=goki); defaults to '1'.
        const on = (typeof c.on === 'string' && c.on) ? c.on.slice(0, 32) : '1';
        out.push({ key: 'cheat-' + param, param, kind, label, on });
      }
    }
    return out;
  }
  // Harden the game-supplied EX advert. The URL may be absolute http(s) — the
  // game resolves ex.html against its own location, which the launcher can't
  // see for a cross-origin frame — or relative (resolved against gameSrc at
  // launch). Other schemes and protocol-relative URLs are rejected. Accepting
  // this from the frame grants no new capability: an iframe can already
  // navigate itself anywhere; the Guide row just does it on the player's cue.
  function sanitizeEx(raw) {
    if (!raw || typeof raw.url !== 'string' || !raw.url) return null;
    const url = raw.url.slice(0, 512);
    if (url.startsWith('//')) return null;
    if (/^(?!https?:)[a-z][a-z0-9+.-]*:/i.test(url)) return null;
    const label = (typeof raw.label === 'string' && raw.label) ? raw.label.slice(0, 40) : 'EX Version';
    return { url, label };
  }
  // Swap the running iframe to an advertised extra. Relative URLs resolve
  // against the current game URL; keep gameSrc's absolute/relative shape so
  // same-origin games stay same-origin (as setCheat does).
  function launchEx(url) {
    if (!url || !gameSrc) return;
    const base = cheatUrl();
    let target;
    try { target = base ? new URL(url, base) : new URL(url); }
    catch (_) { return; }
    const relative = target.origin === window.location.origin;
    gameSrc = relative ? target.pathname + target.search + target.hash : target.href;
  }
  // Which URL a cheat applies to. A frame can navigate itself away from what we
  // launched — the .sav shelf hands the editor /editor/?play=<slug> and the
  // editor swaps itself for /games/2028-ai?editorPlay=1 — and the cheats belong
  // to the page that is actually running, not to the one that opened it. So the
  // live location wins (frameUrl, root-relative and same-origin-only) and
  // gameSrc is the fallback for cross-origin frames we can't read.
  function cheatSrc() {
    return (typeof frameUrl === 'string' && frameUrl) ? frameUrl : gameSrc;
  }
  // Parse that (absolute https://… for external games, root-relative /…/ for
  // in-repo ones) into a URL so we can read/rewrite a single query param.
  function cheatUrl() {
    const src = cheatSrc();
    if (!src) return null;
    try { return new URL(src, src.startsWith('/') ? window.location.origin : undefined); }
    catch (_) { return null; }
  }
  function cheatParam(param) {
    const u = cheatUrl(); return u ? u.searchParams.get(param) : null;
  }
  // value === null deletes the param; otherwise it is set. Re-serialize keeping
  // the original absolute/relative shape so same-origin games stay same-origin.
  function setCheat(param, value) {
    const src = cheatSrc();
    const u = cheatUrl(); if (!u || !src) return;
    if (value === null) u.searchParams.delete(param);
    else u.searchParams.set(param, String(value));
    const relative = src.startsWith('/') && u.origin === window.location.origin;
    gameSrc = relative ? u.pathname + u.search + u.hash : u.href;
  }
  // Harden a game-advertised plugin set (mirrors sanitizeCheats). Each plugin is
  // a live toggle keyed on a stable id; malformed entries are dropped. Returns
  // [] on anything not an array. Plugins are currently toggle-only.
  function sanitizePlugins(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const p of raw.slice(0, 8)) {
      if (!p || typeof p.id !== 'string' || !p.id) continue;
      const id = p.id.slice(0, 32);
      if (seen.has(id)) continue;
      seen.add(id);
      const label = (typeof p.label === 'string' && p.label) ? p.label.slice(0, 40) : id;
      out.push({ key: 'plugin-' + id, id, kind: 'toggle', label, value: !!p.value });
    }
    return out;
  }
  // Toggle a plugin: record the new value locally (so the OSD reflects it) and
  // tell the running game to apply it live.
  function setPlugin(id, value) {
    osdPlugins = osdPlugins.map((p) => (p.id === id ? { ...p, value: !!value } : p));
    const iframe = document.getElementById('gameframe');
    // targetOrigin '*' is deliberate here: a plugin-capable game could load
    // cross-origin, where a strict origin would silently drop the toggle. The
    // payload is a benign boolean, so '*' is safe — do not tighten it to
    // window.location.origin or cross-origin games break.
    try { iframe?.contentWindow?.postMessage({ type: 'cmg-plugin-set', id, value: !!value }, '*'); }
    catch (_) { /* ignore */ }
  }
  // Harden a game-advertised action set (mirrors sanitizePlugins). Each action is
  // a momentary button keyed on a stable id; malformed entries are dropped.
  function sanitizeActions(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const a of raw.slice(0, 8)) {
      if (!a || typeof a.id !== 'string' || !a.id) continue;
      const id = a.id.slice(0, 32);
      if (seen.has(id)) continue;
      seen.add(id);
      const label = (typeof a.label === 'string' && a.label) ? a.label.slice(0, 40) : id;
      out.push({ key: 'action-' + id, id, label });
    }
    return out;
  }
  // Tell the running game an OSD action button was activated. '*' targetOrigin
  // for the same reason as setPlugin: action-capable games can load
  // cross-origin. The payload is a benign id, so '*' is safe.
  function sendGameAction(id) {
    const iframe = document.getElementById('gameframe');
    try { iframe?.contentWindow?.postMessage({ type: 'cmg-action', id }, '*'); }
    catch (_) { /* ignore */ }
  }

  // ── Level Editor capability ───────────────────────────────────────────────
  // A game can advertise that it ships a level editor two ways, mirroring the
  // cmg-cheats/cmg-actions pattern:
  //   - a `levelEditor` field on its catalog/manifest entry (resolved at launch,
  //     works for external games that can't postMessage), or
  //   - a boot-time postMessage { type: 'cmg-level-editor', game?, url? }.
  // Either yields an OSD "Edit Levels" button that swaps the frame to the ported
  // level editor (/editor/), which authors custom "Game" records in Firebase.
  // Only a SAME-ORIGIN /editor… path is ever honored — the editor is same-origin
  // by construction, and refusing off-origin URLs keeps a hostile game from
  // pointing the button at an arbitrary site.
  let osdLevelEditor = $state(null); // { url } | null
  function sanitizeLevelEditor(raw, fallbackGameId) {
    // Explicit same-origin path wins; otherwise derive /editor/?game=<id>.
    let url = null;
    if (raw && typeof raw === 'object' && typeof raw.url === 'string') url = raw.url;
    else if (typeof raw === 'string' && raw.startsWith('/')) url = raw;
    if (!url) {
      // Prefer an explicit editor game id, else the launched game id with any
      // "games/" manifest prefix stripped (2028-ai's catalog id is "games/2028-ai",
      // but its assets live at /games/2028-ai/, so the editor game id is "2028-ai").
      let g = (raw && typeof raw === 'object' && raw.game) ? String(raw.game) : String(fallbackGameId || '');
      g = g.replace(/^games\//, '').replace(/[^a-zA-Z0-9_-]/g, '');
      url = '/editor/' + (g ? ('?game=' + encodeURIComponent(g)) : '');
    }
    // Hard guard: only a root-relative /editor… path (never an absolute URL to
    // another origin, and no ".." — raw or percent-encoded — that could resolve
    // back out of /editor to the launcher root and nest a launcher in the frame)
    // is allowed through.
    if (url.includes('..') || /%2e/i.test(url) || !/^\/editor(\/|\?|$)/.test(url)) return null;
    return { url };
  }
  // Swap the running frame to the level editor. Treated like launching a new
  // in-frame view: reset the prior game's advertised OSD capabilities so none
  // of its cheats/plugins/actions linger over the editor.
  function openLevelEditor() {
    const le = osdLevelEditor;
    if (!le || !le.url) return;
    sfx.enter();
    osdOpen = false; osdView = 'main';
    osdCheats = []; osdPlugins = []; osdActions = [];
    // Clear the editor's own capability too, so the "Edit Levels" button doesn't
    // linger in the OSD while the editor is the active frame.
    osdLevelEditor = null;
    twinStickAvail = false; twinStickOn = false;
    touchCtlAvail = false; touchCtlOn = false;
    // Deliberately root-relative (NOT resolved against manifestOrigin like games):
    // the editor must stay on the launcher's own origin so its /api/build-apk
    // call and Firebase writes run against the local dev/desktop host, not the
    // read-only deploy.
    frameUrl = null;
    gameSrc = le.url;
    setTimeout(() => { gameOn = true; }, 30);
  }

  // ── Twin-Stick mode ───────────────────────────────────────────────────────
  // Re-expresses the pad as a dual-analog controller for twin-stick shooters:
  // D-pad → left stick (move), face buttons → right stick (aim; top=up,
  // right=right, bottom=down, left=left). The Guide shows the toggle when a
  // game opts in, three ways:
  //   - built-in default list (TWIN_STICK_DEFAULT_IDS — defaults ON),
  //   - a `twinStick` flag on its catalog/manifest entry
  //     (true, or { default: true }),
  //   - a boot-time postMessage { type: 'cmg-twinstick', default?: bool },
  //     same pattern as cmg-cheats/cmg-plugins.
  // Same-origin games get it applied by patching
  // the frame's navigator.getGamepads with CMGGamepadCompat.twinStick over the
  // launcher's own (SNES-normalized) pads — zero game changes needed.
  // Cross-origin games can't be patched; they receive
  // { type: 'cmg-twinstick-set', value } (sent in both cases) and apply it
  // themselves. The choice persists per game in localStorage.
  const TWIN_STICK_DEFAULT_IDS = new Set(['shmup-party-phaser3', 'shmup-party-phaser4']);
  let twinStickAvail = $state(false);
  let twinStickOn = $state(false);
  let twinTouchOn = $state(false);
  let osdOpenedByTouch = $state(false);
  let twinGameId = null;
  let twinStickUserSet = false;

  function twinStickKey(id) { return 'cmg-twinstick:' + id; }
  function twinTouchKey(id) { return 'cmg-twinstick-touch:' + id; }

  function initTwinStick(id, item) {
    twinGameId = id || null;
    twinStickUserSet = false;
    osdOpenedByTouch = false;
    const flag = item ? item.twinStick : undefined;
    const catalogAvail = flag === true || (!!flag && typeof flag === 'object');
    const catalogDefault = flag === true || !!(flag && flag.default);
    const builtin = !!id && TWIN_STICK_DEFAULT_IDS.has(id);
    twinStickAvail = builtin || catalogAvail;
    let on = builtin || catalogDefault;
    try {
      const saved = id ? localStorage.getItem(twinStickKey(id)) : null;
      if (saved !== null) on = saved === '1';
    } catch (_) { /* ignore */ }
    twinStickOn = twinStickAvail && on;
    let touchOn = false;
    try {
      const savedTouch = id ? localStorage.getItem(twinTouchKey(id)) : null;
      touchOn = savedTouch === '1';
    } catch (_) { /* ignore */ }
    twinTouchOn = twinStickAvail && touchOn;
    resetTwinTouch();
  }

  function setTwinStick(v) {
    twinStickOn = !!v;
    twinStickUserSet = true;
    if (twinGameId) {
      try { localStorage.setItem(twinStickKey(twinGameId), twinStickOn ? '1' : '0'); } catch (_) { /* ignore */ }
    }
    applyTwinStick();
  }

  function setTwinTouch(v) {
    twinTouchOn = twinStickAvail && !!v;
    if (twinGameId) {
      try { localStorage.setItem(twinTouchKey(twinGameId), twinTouchOn ? '1' : '0'); } catch (_) { /* ignore */ }
    }
    if (!twinTouchOn) resetTwinTouch();
    applyTwinStick();
  }

  // ── Touch Controls ────────────────────────────────────────────────────────
  // On-screen touch pad rendered by the game itself.
  // Availability mirrors twin-stick: a `touchControls`
  // flag on the catalog/manifest entry (true, or { default: true }),
  // or a boot-time postMessage
  // { type: 'cmg-touchcontrols', default?: bool }. The launcher only brokers
  // the option — the choice persists per game in localStorage and is pushed
  // into the frame as { type: 'cmg-touchcontrols-set', value }; the game
  // renders/hides its own overlay. The launcher theme rides along as
  // { type: 'cmg-theme', theme } so the pad can match the skin (Nintendo red
  // → Nintendo-gray buttons).
  let touchCtlAvail = $state(false);
  let touchCtlOn = $state(false);
  let touchCtlGameId = null;
  let touchCtlUserSet = false;

  function touchCtlKey(id) { return 'cmg-touchcontrols:' + id; }

  function initTouchControls(id, item) {
    touchCtlGameId = id || null;
    touchCtlUserSet = false;
    const flag = item ? item.touchControls : undefined;
    touchCtlAvail = flag === true || (!!flag && typeof flag === 'object');
    let on = flag === true || !!(flag && flag.default);
    try {
      const saved = id ? localStorage.getItem(touchCtlKey(id)) : null;
      if (saved !== null) on = saved === '1';
    } catch (_) { /* ignore */ }
    touchCtlOn = touchCtlAvail && on;
  }

  function setTouchControls(v) {
    touchCtlOn = !!v;
    touchCtlUserSet = true;
    if (touchCtlGameId) {
      try { localStorage.setItem(touchCtlKey(touchCtlGameId), touchCtlOn ? '1' : '0'); } catch (_) { /* ignore */ }
    }
    applyTouchControls();
  }

  function applyTouchControls() {
    const iframe = document.getElementById('gameframe') ||
      document.querySelector('.game-iframe iframe');
    try { iframe?.contentWindow?.postMessage({ type: 'cmg-touchcontrols-set', value: touchCtlOn }, '*'); } catch (_) { /* ignore */ }
  }

  // Push the launcher skin into the running game so its own chrome (touch
  // pad colors, etc.) can match — cross-origin games can't read cmg-theme
  // from localStorage, so it travels by postMessage.
  function applyGameTheme() {
    const iframe = document.getElementById('gameframe') ||
      document.querySelector('.game-iframe iframe');
    try { iframe?.contentWindow?.postMessage({ type: 'cmg-theme', theme: tweaks.theme }, '*'); } catch (_) { /* ignore */ }
  }

  let twinTouch = $state({
    left: { id: null, ox: 0, oy: 0, x: 0, y: 0, active: false },
    right: { id: null, ox: 0, oy: 0, x: 0, y: 0, active: false },
  });
  const TWIN_TOUCH_RADIUS = 60;
  const TWIN_TOUCH_DEAD = 10;
  function resetTwinTouch() {
    for (const side of ['left', 'right']) {
      const st = twinTouch[side];
      st.id = null; st.active = false; st.x = 0; st.y = 0;
    }
  }
  function twinTouchGamepad(pads) {
    if (!twinTouchOn || !twinStickAvail) return pads;
    const axes = [0, 0, 0, 0];
    if (twinTouch.left.active) { axes[0] = twinTouch.left.x; axes[1] = twinTouch.left.y; }
    if (twinTouch.right.active) { axes[2] = twinTouch.right.x; axes[3] = twinTouch.right.y; }
    const active = twinTouch.left.active || twinTouch.right.active;
    if (!active) return pads;
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
    const base = pads && pads[0];
    const virtualPad = base ? {
      id: base.id || 'CMG Touch Twin-Stick',
      index: 0,
      connected: true,
      mapping: 'standard',
      timestamp: Date.now(),
      axes: [
        twinTouch.left.active ? axes[0] : (base.axes?.[0] || 0),
        twinTouch.left.active ? axes[1] : (base.axes?.[1] || 0),
        twinTouch.right.active ? axes[2] : (base.axes?.[2] || 0),
        twinTouch.right.active ? axes[3] : (base.axes?.[3] || 0),
      ],
      buttons: base.buttons || buttons,
      vibrationActuator: base.vibrationActuator || null,
    } : {
      id: 'CMG Touch Twin-Stick', index: 0, connected: true, mapping: 'standard',
      timestamp: Date.now(), axes, buttons, vibrationActuator: null,
    };
    const out = Array.prototype.slice.call(pads || []);
    out[0] = virtualPad;
    return out;
  }

  // A game frame is patchable only when same-origin. Decide from the frame's
  // src URL rather than probing contentWindow.document: the probe throws a
  // catchable SecurityError, but Chrome still logs a "Blocked a frame …"
  // console error at the access point even when it's caught — pure noise on
  // every cross-origin game load.
  function frameIsSameOrigin(iframe) {
    try {
      const src = iframe?.getAttribute('src') || '';
      if (!src) return false;
      return new URL(src, window.location.href).origin === window.location.origin;
    } catch (_) { return false; }
  }

  // Patch (same-origin) and/or notify (any origin) the running game frame.
  // The patched getGamepads reads twinStickOn live, so it installs once per
  // frame document and the toggle takes effect without a reload.
  function applyTwinStick() {
    // Fall back to the class selector: on the iframe's own load event the
    // gameOn-gated id may not be applied yet.
    const iframe = document.getElementById('gameframe') ||
      document.querySelector('.game-iframe iframe');
    const w = iframe && iframe.contentWindow;
    if (!w) return;
    if (frameIsSameOrigin(iframe)) {
      try {
        if (!w.__cmgTwinStickWrapped) {
          w.__cmgTwinStickWrapped = true;
          const orig = typeof w.navigator.getGamepads === 'function'
            ? w.navigator.getGamepads.bind(w.navigator)
            : () => [];
          w.navigator.getGamepads = () => {
            if (!twinStickOn) return orig();
            try { return twinTouchGamepad(window.CMGGamepadCompat.twinStick(navigator.getGamepads() || [])); }
            catch (_) { return orig(); }
          };
        }
      } catch (_) { /* frame navigated mid-flight — the postMessage below still lands */ }
    } else {
      // Cross-origin frames can't be patched, so the launcher's own touch
      // zones/virtual pad never reach them. Tell the game to run its own
      // Touch Twin-Stick analogs (shmup-party's touch-controls.ts). Sent to
      // cross-origin frames ONLY — a same-origin game also listening would
      // double up input and visuals with the launcher's zones. Send the
      // EFFECTIVE state (same gate as the same-origin overlay), not the raw
      // saved toggle: turning Twin-Stick Mode off must also stop the game's
      // touch analogs even though twinTouchOn stays saved for later.
      const touchEffective = twinStickAvail && twinStickOn && twinTouchOn;
      try { w.postMessage({ type: 'cmg-twinstick-touch-set', value: touchEffective }, '*'); } catch (_) { /* ignore */ }
    }
    // Cross-origin games apply the toggle themselves off this message.
    try { w.postMessage({ type: 'cmg-twinstick-set', value: twinStickOn }, '*'); } catch (_) { /* ignore */ }
  }
  const HUE_SWATCHES = [
    { hex: '#7CFF4F', hue: 130 }, // green (default)
    { hex: '#4FB8FF', hue: 235 }, // blue
    { hex: '#FF6FB1', hue: 350 }, // pink
    { hex: '#FFB13D', hue: 60 },  // amber
    { hex: '#C18BFF', hue: 290 }, // violet
    { hex: '#56F0E2', hue: 190 }, // cyan
  ];
  const TWEAK_KEY = 'cmg-tweaks';
  const TWEAK_DEFAULTS = { hue: 130, breatheSpeed: 1, scanlines: true, discoMode: false, theme: 'xbox' };
  function loadTweaks() {
    try { return { ...TWEAK_DEFAULTS, ...JSON.parse(localStorage.getItem(TWEAK_KEY) || '{}') }; }
    catch (_) { return { ...TWEAK_DEFAULTS }; }
  }
  let tweaks = $state(loadTweaks());
  function setTweak(key, value) {
    tweaks = { ...tweaks, [key]: value };
    try {
      localStorage.setItem(TWEAK_KEY, JSON.stringify(tweaks));
      // Mirror theme/scanlines to the standalone keys the level editor reads,
      // so an editor opened later boots with the launcher's current look.
      if (key === 'theme') { localStorage.setItem('cmg-theme', value); applyGameTheme(); }
      if (key === 'scanlines') localStorage.setItem('cmg-scanlines', value ? '1' : '0');
    } catch (_) {}
  }

  // Flat, ordered list the OSD renders and gamepad/keyboard nav indexes into.
  // Each section is introduced by a navigable header row (kind:'section'); when
  // that section is collapsed only the header is emitted, so nav and rendering
  // both transparently skip the hidden children.
  let osdItems = $derived.by(() => {
    const out = [];
    const addSection = (name, children) => {
      if (!children.length) return;
      out.push({ key: `sect-${name}`, kind: 'section', section: name, label: name, collapsed: !!osdCollapsed[name] });
      if (!osdCollapsed[name]) out.push(...children);
    };

    // Cheats sub-page: a Back row plus one control per URL-param cheat, each
    // reflecting the param's current state on the running game's iframe.
    if (osdView === 'cheats') {
      addSection('Cheats', [
        { key: 'cheats-back', kind: 'button', label: '‹ Back' },
        ...osdCheats.map((c) =>
          c.kind === 'toggle'
            ? { ...c, value: cheatParam(c.param) === (c.on || '1') }
            : { ...c, value: Number(cheatParam(c.param)) || 0 }
        ),
      ]);
      return out;
    }

    const game = [
      { key: 'exit', kind: 'button', label: 'Exit Game' },
      { key: 'controller', kind: 'button', label: 'Controller Settings' },
      // R3 is the only pad shortcut to fullscreen and SNES-class pads have no
      // stick clicks — this row is their (and touch/mouse users') path to it.
      { key: 'fullscreen', kind: 'button', label: 'Fullscreen' },
    ];
    // Game-advertised OSD action buttons (opt-in per game over cmg-actions).
    // Activating one posts { type:'cmg-action', id } back into the frame.
    for (const a of osdActions) game.push({ key: a.key, kind: 'button', label: a.label, action: a.id });
    // Twin-Stick mode appears only for games that opt in (built-in list,
    // catalog `twinStick` flag, or a cmg-twinstick broadcast).
    if (twinStickAvail) {
      game.push({ key: 'twinstick', kind: 'toggle', label: 'Twin-Stick Mode', value: twinStickOn });
      // Gate on device capability, not on how THIS Guide was opened — a hybrid
      // (touchscreen + pad) device that opened the Guide with the pad chord
      // still wants the touch analogs reachable.
      if (isTouch) {
        game.push({ key: 'twinstick-touch', kind: 'toggle', label: 'Touch Twin-Stick', value: twinTouchOn });
      }
    }
    // Touch Controls appears only for games that opt in (catalog
    // `touchControls` flag or a cmg-touchcontrols broadcast).
    if (touchCtlAvail) {
      game.push({ key: 'touchcontrols', kind: 'toggle', label: 'Touch Controls', value: touchCtlOn });
    }
    // The Cheats submenu appears only when the running game has advertised a
    // cheat set over postMessage (osdCheats) — opt-in, per game.
    if (osdCheats.length) {
      game.push({ key: 'cheats', kind: 'button', label: 'Cheats' });
    }
    // "Edit Levels" appears only for games that ship a level editor (catalog
    // `levelEditor` flag or a cmg-level-editor broadcast) — opt-in, per game.
    if (osdLevelEditor) {
      game.push({ key: 'leveleditor', kind: 'button', label: 'Edit Levels' });
    }
    // Game-advertised extra builds (e.g. an unlocked EX super-scaler 3D
    // version) each get a launch row; like Cheats, they exist only while the
    // running game has broadcast them (cmg-ex → osdExtras).
    for (const ex of osdExtras) {
      game.push({ key: 'ex:' + ex.url, kind: 'button', label: ex.label, exUrl: ex.url });
    }
    addSection('Game', game);

    // Game-advertised live plugins render as toggles under a "Plugins" header.
    // Like Cheats, this is opt-in per game — the section only exists while the
    // running game has broadcast a plugin set.
    addSection('Plugins', osdPlugins.map((p) => (
      { key: p.key, kind: 'toggle', label: p.label, value: p.value, plugin: p.id }
    )));

    // Master volume for the running game (relayed over cmg-volume). The editor
    // frame plays no audio, so the section hides while it is the active frame.
    if (gameOn && !editorFrameActive) {
      addSection('Sound', [
        { key: 'vol-bgm', kind: 'slider', label: 'BGM', value: volBgm, min: 0, max: 100, step: 5, unit: '%' },
        { key: 'vol-sfx', kind: 'slider', label: 'SFX', value: volSfx, min: 0, max: 100, step: 5, unit: '%' },
      ]);
    }

    addSection('Look', [
      { key: 'hue', kind: 'color', label: 'Glow color', value: tweaks.hue, options: HUE_SWATCHES },
      { key: 'breathe', kind: 'slider', label: 'Breathe speed', value: tweaks.breatheSpeed, min: 0.4, max: 2.2, step: 0.1, unit: '×' },
      { key: 'scanlines', kind: 'toggle', label: 'Scanlines', value: tweaks.scanlines },
      { key: 'disco', kind: 'toggle', label: 'Disco mode', value: tweaks.discoMode },
    ]);
    return out;
  });

  // Keep the selection in range when the list shrinks under it — e.g. a game
  // re-advertises a smaller cheat/plugin set while the Guide is open. The nav
  // handlers also clamp on keypress, but this self-heals the highlight the
  // instant the derived list changes. (osdItems doesn't read osdSel, so no loop.)
  $effect(() => {
    if (osdSel > osdItems.length - 1) osdSel = Math.max(0, osdItems.length - 1);
  });

  // Index of the first non-header row, so resetting the selection lands on an
  // actionable item rather than a section header (which would only collapse it).
  function firstSelectable(items) {
    const i = items.findIndex((it) => it.kind !== 'section');
    return i < 0 ? 0 : i;
  }
  function toggleSection(name) {
    osdCollapsed = { ...osdCollapsed, [name]: !osdCollapsed[name] };
    try { localStorage.setItem(OSD_COLLAPSE_KEY, JSON.stringify(osdCollapsed)); } catch (_) {}
    sfx.nav();
  }
  function openOsd() {
    osdView = 'main'; osdSel = firstSelectable(osdItems); osdNav.vDir = 0; osdNav.hDir = 0; osdOpen = true; sfx.enter();
    // Pull keyboard focus out of the game frame so the launcher's own onKey
    // handler drives OSD navigation. A focus-stealing game — especially a
    // cross-origin one, whose keys the launcher can neither read nor forward
    // into — otherwise swallows every arrow/Enter/Esc while the Guide is up.
    if (gameOn) { try { document.getElementById('gameframe')?.blur(); window.focus(); } catch (_) { /* ignore */ } }
  }
  // FBTN_RIGHT / Esc backs out of the Cheats sub-page to the root before it
  // closes the whole Guide; the ✕ button and tap-out always close outright.
  function osdBack() {
    if (osdView === 'cheats') { osdView = 'main'; osdSel = firstSelectable(osdItems); sfx.back(); return; }
    closeOsd();
  }
  function closeOsd() {
    osdOpen = false; osdView = 'main'; sfx.back();
    // Hand focus back so the game resumes receiving input.
    if (gameOn) { try { document.getElementById('gameframe')?.focus(); } catch (_) { /* ignore */ } }
  }
  function setOsdValue(i, v) {
    const it = osdItems[i]; if (!it) return;
    // Cheat rows carry a `param`: toggles add/remove ?param=<on> (default '1',
    // e.g. ?boss=goki), the stage slider sets ?stage=N (0 kept — it is a valid
    // first stage). Reloads the iframe.
    if (it.param) { setCheat(it.param, it.kind === 'toggle' ? (v ? (it.on || '1') : null) : v); return; }
    // Plugin rows carry a `plugin` id — flip it live in the running game.
    if (it.plugin) { setPlugin(it.plugin, !!v); return; }
    if (it.key === 'vol-bgm' || it.key === 'vol-sfx') { setVolume(it.key, v); return; }
    if (it.key === 'hue') setTweak('hue', v);
    else if (it.key === 'breathe') setTweak('breatheSpeed', Math.round(v * 10) / 10);
    else if (it.key === 'scanlines') setTweak('scanlines', !!v);
    else if (it.key === 'disco') setTweak('discoMode', !!v);
    else if (it.key === 'twinstick') setTwinStick(!!v);
    else if (it.key === 'twinstick-touch') setTwinTouch(!!v);
    else if (it.key === 'touchcontrols') setTouchControls(!!v);
  }
  function adjustOsd(i, dir) {
    const it = osdItems[i]; if (!it) return;
    if (it.kind === 'section') {
      // Left collapses, right expands — only act when it changes state.
      if ((dir < 0) !== !!osdCollapsed[it.section]) toggleSection(it.section);
    } else if (it.kind === 'slider') {
      const v = Math.max(it.min, Math.min(it.max, Math.round((it.value + dir * it.step) * 10) / 10));
      setOsdValue(i, v); sfx.nav();
    } else if (it.kind === 'color') {
      const idx = Math.max(0, it.options.findIndex((o) => o.hue === it.value));
      setOsdValue(i, it.options[(idx + dir + it.options.length) % it.options.length].hue); sfx.nav();
    } else if (it.kind === 'toggle') {
      setOsdValue(i, dir > 0); sfx.nav();
    }
  }
  function activateOsd(i) {
    const it = osdItems[i]; if (!it) return;
    if (it.kind === 'section') { toggleSection(it.section); return; }
    if (it.kind === 'toggle') { setOsdValue(i, !it.value); sfx.nav(); return; }
    if (it.kind === 'color' || it.kind === 'slider') { adjustOsd(i, 1); return; }
    // Game-advertised action button: relay it into the frame and hand focus back
    // so the game's own UI (e.g. shmup's Controls remapper) receives input.
    if (it.action) {
      sfx.enter();
      osdOpen = false; osdView = 'main';
      sendGameAction(it.action);
      if (gameOn) { try { document.getElementById('gameframe')?.focus(); } catch (_) {} }
      return;
    }
    if (it.key === 'exit') { sfx.enter(); osdOpen = false; closeGame(); }
    // Same deferred-activation semantics as R3: a mouse/touch/key activation
    // grants fullscreen immediately; a pad press records the intent and the
    // next real gesture cashes it in (see requestFullscreenFromPad).
    else if (it.key === 'fullscreen') { sfx.enter(); requestFullscreenFromPad(); }
    // byMouse decides whether the Controller Layout un-hides the pointer: the
    // panel is mouse-only, so a player who reached it with a click needs the
    // cursor back, while one who reached it on the pad should not get one.
    else if (it.key === 'controller') { sfx.enter(); osdOpen = false; try { window.openControllerConfigurator?.({ byMouse: lastInput === 'mouse' }); } catch (_) {} }
    else if (it.key === 'leveleditor') { openLevelEditor(); }
    else if (it.key === 'cheats') { sfx.enter(); osdView = 'cheats'; osdSel = firstSelectable(osdItems); }
    else if (it.key === 'cheats-back') { osdView = 'main'; osdSel = firstSelectable(osdItems); sfx.back(); }
    else if (it.exUrl) { sfx.enter(); osdOpen = false; launchEx(it.exUrl); }
  }

  // Two-finger corner gesture (bottom-left + top-right at once) opens the OSD on
  // touch, where the SELECT + Down chord isn't available.
  const cornerState = { bl: false, tr: false };
  function cornerDown(c, e) {
    cornerState[c] = true;
    if (cornerState.bl && cornerState.tr) {
      cornerState.bl = false; cornerState.tr = false;
      osdOpenedByTouch = !e || e.pointerType === 'touch';
      openOsd();
    }
  }
  function cornerUp(c) { cornerState[c] = false; }

  function twinTouchStart(e, side) {
    if (!twinTouchOn || !twinStickAvail || osdOpen || (e.pointerType && e.pointerType !== 'touch')) return;
    const st = twinTouch[side];
    if (st.id !== null) return;
    st.id = e.pointerId; st.ox = e.clientX; st.oy = e.clientY; st.x = 0; st.y = 0; st.active = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  }
  function twinTouchMove(e, side) {
    const st = twinTouch[side];
    if (st.id !== e.pointerId) return;
    const dx = e.clientX - st.ox, dy = e.clientY - st.oy;
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag < TWIN_TOUCH_DEAD) { st.x = 0; st.y = 0; }
    else { st.x = Math.max(-1, Math.min(1, dx / TWIN_TOUCH_RADIUS)); st.y = Math.max(-1, Math.min(1, dy / TWIN_TOUCH_RADIUS)); }
    e.preventDefault();
  }
  function twinTouchEnd(e, side) {
    const st = twinTouch[side];
    if (st.id !== e.pointerId) return;
    st.id = null; st.active = false; st.x = 0; st.y = 0;
    e.preventDefault();
  }

  // Keep the cursor on screen in whichever half of the games screen owns it —
  // the row list, or the strip. Both halves scroll independently, and both nudge
  // by the minimum rather than centring: the shelf you are reading stays put
  // until the cursor actually reaches an edge. Each keeps a lead-in past the
  // cursor so there is always context beyond it — 18% of the list's height for
  // the rows, a flat 24px for the tiles. Assigning scrollTop/scrollLeft still
  // animates; both containers carry scroll-behavior: smooth.
  $effect(() => {
    if (screen !== 'games' || stripOn) return;
    const el = gameRowEls[curSel];
    const list = gameListEl;
    if (!el || !list) return;
    // .games-list is positioned, so it IS the rows' offsetParent and offsetTop is
    // already relative to it.
    const top = el.offsetTop;
    const pad = list.clientHeight * 0.18;
    if (top - pad < list.scrollTop) list.scrollTop = Math.max(0, top - pad);
    else if (top + el.offsetHeight + pad > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + el.offsetHeight + pad - list.clientHeight;
    }
  });

  $effect(() => {
    if (screen !== 'games') return;
    const el = tileEls[secSel];
    const strip = stripEl;
    if (!el || !strip) return;
    // The strip is NOT positioned, so tiles measure against a shared ancestor and
    // the strip's own offset has to come back out.
    const pad = 24;
    const left = el.offsetLeft - strip.offsetLeft;
    if (left - pad < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - pad);
    else if (left + el.offsetWidth + pad > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = left + el.offsetWidth + pad - strip.clientWidth;
    }
  });

  $effect(() => {
    if (screen !== 'settings') return;
    const el = settingsRowEls[settingsSel];
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  // Keep the selection in range if the Games list shrinks under it.
  $effect(() => {
    if (gameSel > GAMES.length - 1) gameSel = Math.max(GAMES.length - 1, 0);
  });

  // Auto-focus the BYOD button when landing on an empty console section so
  // gamepad FBTN_BOTTOM can click it. Note: browsers require a *user* gesture to
  // open the native file picker — gamepad input doesn't count. Focusing means a
  // real Enter on a USB keyboard will trigger the picker; programmatic .click()
  // from gamepad polling will be silently denied in some browsers.
  // Not while the .sav picker is up: this re-runs on unrelated reactivity and
  // would rip focus out of the picker's search field mid-word.
  $effect(() => {
    if (screen !== 'games' || !sectionEmpty || !curSection.picker || savPickerOpen) return;
    queueMicrotask(() => { try { byodBtnEl?.focus(); } catch (_) {} });
  });

  // A section whose list shrank under the cursor (a ROM list arrives, a network
  // install graduates) must not leave the selection dangling past the end.
  $effect(() => {
    const max = Math.max(curRows.length - 1, 0);
    if (curSection.sel() > max) curSection.setSel(max);
  });

  // A whole section can vanish under the cursor (a core is uninstalled), taking
  // the strip with it when the catalog is the last one standing. Clamp the tile
  // index and never leave the focus flag parked on a rail that isn't rendered —
  // stripOn already masks it for consumers, this keeps the state itself honest.
  $effect(() => {
    if (secSel > SECTIONS.length - 1) secSel = Math.max(SECTIONS.length - 1, 0);
    if (!stripShown && stripFocus) stripFocus = false;
  });

  // Emulators screen: keep the cursor on screen, same as Settings.
  $effect(() => {
    if (screen !== 'emulators') return;
    const el = emuRowEls[emuSel];
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  // ─── Strip sections ────────────────────────────────────────────────────────
  // One descriptor per strip tile. shmupX ships a single section — the games
  // catalog — and every INSTALLED emulator core appends one built straight from
  // its catalogue entry, which is what makes the strip appear at all.
  //
  //   name/mark/icon      — the strip tile (mark is the type-mark in the glass
  //                         disc; a section with an icon shows that instead)
  //   title/metaType/date — section header + the disc panel's readout
  //   coreA/coreB         — the credits line in the strip's header
  //   rows                — normalized row descriptors (see romRows)
  //   sel/setSel/activate — cursor + what FBTN_BOTTOM does on a row
  //   byod                — shelf note when rows is empty
  function romRows(list, core) {
    return (list || []).map((g) => ({
      key: g.file || g.url, name: g.name, title: String(g.name).toUpperCase(), sub: g.size,
      icon: null, size: g.size, date: g.date, type: core.metaType,
      file: g.file, url: g.url, kind: g.kind, bios: g.bios,
    }));
  }
  // The same shape for a disc that never came off the mirror. `local` carries
  // the record (blob included) straight through to launchEmuRow, so the row is
  // the only thing that has to know where the game came from.
  function localRows(core) {
    if (core.id !== 'ps2') return [];
    return ps2Local.map((g) => ({
      key: 'local:' + g.id, name: g.name, title: String(g.name).toUpperCase(),
      sub: g.source || 'built here', icon: null,
      size: (g.size / 1048576).toFixed(1) + ' MB',
      date: 'LOCAL', type: 'PS2 / BUILT HERE',
      kind: 'local', local: g,
    }));
  }
  // Rows for an installed core: what this machine built first, then the mirror's
  // shelf. A build you just made is the one you came here to play.
  function coreRows(core) {
    return [...localRows(core), ...romRows(emuManifests[core.id], core)];
  }
  // Empty-shelf copy for an installed core. The three states are distinct on
  // purpose: a manifest that has not arrived is not the same as one that failed,
  // and neither is the same as a console that genuinely deploys no titles.
  function emuNote(core) {
    const m = emuManifests[core.id];
    if (m === undefined) return { title: 'READING SHELF…', pre: 'Fetching ', path: core.manifest, post: ' from the mirror.', hint: [] };
    if (m === null) return { title: 'SHELF UNAVAILABLE', pre: 'Could not read ', path: core.manifest, post: '. Reinstall the core from Settings → Emulators.', hint: [] };
    return { title: 'NO GAMES', pre: 'The mirror lists nothing in ', path: core.manifest, post: ' yet.', hint: [] };
  }
  let SECTIONS = $derived([
    {
      id: 'games', name: 'Games', mark: 'SX', icon: '/x-logo.png',
      title: 'GAMES', metaType: 'SHMUPX / CATALOG', date: 'SX',
      coreA: 'boot.0728', coreB: 'signal // ok',
      sel: () => gameSel, setSel: (v) => (gameSel = v),
      activate: (i) => launchGame(GAMES[i]?.id),
      rows: GAMES.map((g) => ({
        key: g.id, name: g.name, title: g.title, sub: g.sub,
        icon: g.icon, size: g.size, date: g.date,
        type: 'GAME / IFRAME',
        g,
      })),
    },
    ...installedCores.map((c) => ({
      id: 'emu-' + c.id, name: c.name, mark: c.mark, icon: c.icon || null,
      title: c.title, metaType: c.metaType, date: c.date,
      coreA: c.coreA, coreB: c.coreB,
      sel: () => emuSecSel[c.id] || 0,
      setSel: (v) => (emuSecSel = { ...emuSecSel, [c.id]: v }),
      activate: (i) => launchEmuRow(c, coreRows(c)[i]),
      rows: coreRows(c),
      byod: emuNote(c),
    })),
  ]);

  let curSection = $derived(SECTIONS[secSel] || SECTIONS[0]);
  let curRows = $derived(curSection.rows);
  let curSel = $derived(Math.min(curSection.sel(), Math.max(curRows.length - 1, 0)));
  let curRow = $derived(curRows[curSel]);
  let sectionEmpty = $derived(curRows.length === 0);
  // With one section the strip has nothing to switch between, so it is not
  // rendered and the panel falls back to the single-row grid every other screen
  // uses. Installing a core brings both back. Every read of "is the cursor in
  // the strip" goes through stripOn, so a hidden strip can never hold it.
  let stripShown = $derived(SECTIONS.length > 1);
  let stripOn = $derived(stripShown && stripFocus);
  let stripCounter = $derived(
    String(secSel + 1).padStart(2, '0') + ' / ' + String(SECTIONS.length).padStart(2, '0')
  );
  // Second half of the strip's header line. With the cursor up here it advertises
  // the gesture; once the rail collapses it names the shelf you are looking at
  // (the collapsed tiles have dropped their labels) and how to get back to it.
  let stripHint = $derived(stripOn ? 'swipe ↔' : curSection.name + ' · ↑ expand');

  let currentGame = $derived(GAMES[gameSel]);
  // Section header counter. A pinned BYO row labels itself (BYOB / BYOC) rather
  // than claiming an index in the ROM count it isn't part of.
  let counterText = $derived(
    sectionEmpty
      ? '00 / 00'
      : curRow?.counterLabel
        ? curRow.counterLabel
        : String(curSel + 1).padStart(2, '0') + ' / ' + String(curRows.length).padStart(2, '0')
  );
  // The disc panel reads the section while the cursor is on the strip, and the
  // selected row once it drops into the list.
  let metaName = $derived(stripOn ? curSection.name : (curRow ? curRow.name : '—'));
  let metaSize = $derived(stripOn ? '— MB' : (curRow ? curRow.size : '—'));
  let metaType = $derived(stripOn ? curSection.metaType : (curRow?.type || curSection.metaType));
  let metaDate = $derived(stripOn ? curSection.date : (curRow ? curRow.date : '—'));
  // What A does from here: open the section (or its file picker, when the
  // section is empty and A goes straight to the dialog), or launch a row.
  let gamesActionLabel = $derived(
    stripOn
      ? (sectionEmpty ? (curSection.picker ? 'Browse' : 'Open') : 'Open')
      : (curRow?.pinned ? 'Browse' : 'Launch')
  );
  // WebAudio blips
  let ac = null;
  function getAc() {
    if (!ac) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ac = new Ctor();
    }
    return ac;
  }
  function blip(freq = 440, dur = 0.07, type = 'square', vol = 0.06) {
    try {
      const a = getAc(); if (!a) return;
      if (a.state === 'suspended') a.resume();
      const o = a.createOscillator(), g = a.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.value = 0; o.connect(g); g.connect(a.destination);
      const t = a.currentTime;
      g.gain.linearRampToValueAtTime(vol, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* ignore */ }
  }
  const sfx = {
    nav:   () => blip(540, 0.05, 'square', 0.05),
    enter: () => { blip(660, 0.07, 'square', 0.06); setTimeout(() => blip(990, 0.10, 'square', 0.05), 60); },
    back:  () => { blip(440, 0.06, 'square', 0.05); setTimeout(() => blip(330, 0.08, 'square', 0.05), 50); },
    boot:  () => { blip(220, 0.12, 'sawtooth', 0.04); setTimeout(() => blip(440, 0.15, 'sawtooth', 0.04), 120); setTimeout(() => blip(880, 0.25, 'sawtooth', 0.04), 280); },
  };

  function initial(name) {
    const s = name.replace(/[^A-Z0-9]/gi, '').slice(0, 2).toUpperCase();
    return s || '··';
  }

  function pickMenu(idx) {
    const m = MAIN_MENU[idx];
    sfx.enter();
    menuSel = idx;
    if (m.id === 'games') {
      screen = 'games';
    } else if (m.id === 'settings') {
      screen = 'settings';
      settingsSel = 0;
    } else if (m.id === 'desktop') {
      // Switch to Desktop mode — the windowed workstation at /desktop/.
      // Root-relative on purpose, same convention as the level editor.
      location.href = '/desktop/';
    }
  }

  function goBack() {
    sfx.back();
    // A screen reached from another screen names its parent in SCREEN_DEFS
    // (Emulators → Settings); everything else returns to the dashboard.
    screen = SCREEN_DEFS[screen]?.back || 'dashboard';
  }

  // ─── Strip navigation ──────────────────────────────────────────────────────
  // The strip and the list under it are one cursor: Down off the strip enters
  // the list, Up from row 0 comes back. A section with no rows keeps the cursor
  // on the strip — there is nothing under it to land on but the empty state,
  // which the A button reaches directly (see SCREEN_DEFS.games.activate).
  function pickSection(i) {
    const next = Math.max(0, Math.min(SECTIONS.length - 1, i));
    if (next !== secSel) {
      // The list under the strip is a different library now — start it at the
      // top, cursor included. Resetting the scroll but keeping the row the
      // section was last left on would only smooth-scroll straight back down
      // the moment Down drops the cursor into it.
      SECTIONS[next].setSel(0);
      secSel = next;
      if (gameListEl) gameListEl.scrollTop = 0;
      sfx.nav();
    }
    stripFocus = stripShown;
  }
  function enterList() {
    if (sectionEmpty) return false;
    stripFocus = false;
    curSection.setSel(Math.min(curSection.sel(), curRows.length - 1));
    return true;
  }
  // Vertical move for the games screen, wired in as SCREEN_DEFS.games.move so
  // keyboard and gamepad share it. `fresh` (a deliberate new press) wraps at the
  // list's bottom; a held repeat clamps — same contract as navMove.
  function gamesMove(dir, fresh = false) {
    if (stripOn) {
      if (dir > 0) enterList();
      return;
    }
    const max = Math.max(curRows.length - 1, 0);
    const next = curSection.sel() + dir;
    // Up off row 0 returns to the strip — unless there isn't one, in which case
    // the list is the whole screen and Up follows navMove's contract instead
    // (a fresh press wraps to the bottom, a held repeat clamps).
    if (next < 0) {
      if (stripShown) { stripFocus = true; return; }
      curSection.setSel(fresh && max > 0 ? max : 0);
      return;
    }
    curSection.setSel(next > max ? (fresh && max > 0 ? 0 : max) : next);
  }
  // Horizontal move — the strip, from either half of the screen. Coming from the
  // list it also pulls focus back up to the strip, so ← / → always means "change
  // section" no matter where the cursor was.
  function gamesMoveH(dir) {
    const next = secSel + dir;
    if (next < 0 || next > SECTIONS.length - 1) return;
    pickSection(next);
  }

  // The current section's file picker. Click the VISIBLE button rather than the
  // hidden input where there is one, so the activation context is anchored to a
  // user-visible element; sections whose picker is a pinned row (Arcade, NES)
  // have no button and fall through to the input, as they always did.
  function openSectionPicker() {
    if (!curSection.picker) return;
    try { if (byodBtnEl) { byodBtnEl.click(); pickerGestureHint(); return; } } catch (_) { /* ignore */ }
    try { byodInputEl?.click(); } catch (_) { /* ignore */ }
    pickerGestureHint();
  }

  // ─── Strip pointer / wheel scrolling ───────────────────────────────────────
  // The strip slides under the finger, and a drag past a few pixels swallows the
  // click so a swipe never launches an emulator.
  let stripDrag = null;
  let stripDragMove = null;
  let stripDragUp = null;
  let stripDragged = false;
  function onStripDown(e) {
    if (!stripEl) return;
    stripDrag = { x: e.clientX, left: stripEl.scrollLeft, moved: false };
    stripEl.style.scrollBehavior = 'auto';
    stripDragMove = (ev) => {
      if (!stripDrag) return;
      const dx = ev.clientX - stripDrag.x;
      if (Math.abs(dx) > 4) stripDrag.moved = true;
      stripEl.scrollLeft = stripDrag.left - dx;
    };
    stripDragUp = () => { stripDragged = !!(stripDrag && stripDrag.moved); endStripDrag(); };
    window.addEventListener('pointermove', stripDragMove);
    window.addEventListener('pointerup', stripDragUp);
    window.addEventListener('pointercancel', stripDragUp);
  }
  function endStripDrag() {
    if (stripEl) stripEl.style.scrollBehavior = 'smooth';
    stripDrag = null;
    if (stripDragMove) window.removeEventListener('pointermove', stripDragMove);
    if (stripDragUp) {
      window.removeEventListener('pointerup', stripDragUp);
      window.removeEventListener('pointercancel', stripDragUp);
    }
    stripDragMove = stripDragUp = null;
  }
  function onStripWheel(e) {
    if (!stripEl) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    stripEl.style.scrollBehavior = 'auto';
    stripEl.scrollLeft += d;
    stripEl.style.scrollBehavior = 'smooth';
  }
  function onTileClick(i) {
    if (stripDragged) { stripDragged = false; return; }
    if (i === secSel && !stripOn) { stripFocus = true; sfx.nav(); return; }
    pickSection(i);
    sfx.enter();
  }

  // Footer A/B are <div>s, not <button>s, so a touchscreen tap doesn't reliably
  // produce a synthesized click — the onclick never fires on the Steam Deck
  // touchscreen. Bind pointerup instead (fires uniformly for touch, pen, and
  // mouse) and call preventDefault so no late synthesized click double-fires
  // the handler. Returns a handler bound to the given action.
  function tapHandler(action) {
    return (e) => {
      e.preventDefault();
      action();
    };
  }
  // Keyboard twin of tapHandler for every role="button"/role="menuitem" div in
  // here (footer chips, menu items, strip tiles, list rows) — non-native buttons
  // don't synthesize a click on Enter/Space, so without this they were focusable
  // but inert on a keyboard (and for assistive tech).
  function chipKeyHandler(action) {
    return (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        // stopPropagation too: the window-level onKey would otherwise ALSO
        // handle this Enter and activate the (possibly just-changed) screen's
        // selected row — one keystroke, two dispatches.
        e.preventDefault();
        e.stopPropagation();
        action();
      }
    };
  }

  // ── Transient toast ────────────────────────────────────────────────────────
  // Small self-dismissing notice for actions the browser can't honor from
  // gamepad input (file pickers, typing) — surfacing the working alternative
  // beats failing silently.
  let toastMsg = $state('');
  let toastTimer = null;
  function showToast(msg) {
    toastMsg = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastMsg = ''; }, 3600);
  }

  // Browsers only open the native file picker inside a real user gesture — a
  // gamepad press doesn't qualify (same rule as fullscreen; see
  // requestFullscreenFromPad). When the click is about to be silently dropped,
  // tell the player what will work instead.
  function pickerGestureHint() {
    try {
      if (navigator.userActivation && !navigator.userActivation.isActive) {
        showToast('The file picker needs a key press, tap, or click — press ENTER on a keyboard or tap BROWSE.');
      }
    } catch (_) { /* ignore */ }
  }

  let settingsCounterText = $derived(
    String(settingsSel + 1).padStart(2, '0') + ' / ' + String(SETTINGS_ITEMS.length).padStart(2, '0')
  );

  function activateSettings(i) {
    const it = SETTINGS_ITEMS[i];
    if (!it) return;
    settingsSel = i;
    sfx.enter();
    if (it.id === 'theme') {
      const cur = THEMES.findIndex((t) => t.id === tweaks.theme);
      setTweak('theme', THEMES[(cur + 1) % THEMES.length].id);
    } else if (it.id === 'emulators') {
      screen = 'emulators';
      emuSel = 0;
    }
  }

  // urlOverride launches the entry at a different URL than its catalog one —
  // the .sav coverflow's &play=<slug> hand-off — while keeping every per-game
  // capability (twin-stick, touch controls, level editor) keyed to the entry.
  function launchGame(id, urlOverride) {
    sfx.enter();
    chromeDismissed = false;
    frameUrl = null;
    // A long-press pending on a row must not survive into the game and pop
    // the picker over it (openSavPicker's gameOn guard is the second belt).
    rowPressCancel();
    const item = GAMES.find((g) => g.id === id);
    if (!item || !(urlOverride || item.url)) return;
    initTwinStick(id, item);
    initTouchControls(id, item);
    // Level-editor availability from the catalog entry (games that broadcast
    // cmg-level-editor on boot override this in onWindowMessage).
    osdLevelEditor = (item && item.levelEditor)
      ? sanitizeLevelEditor(item.levelEditor, id)
      : null;
    // Resolve against the origin the manifest came from — same-origin here
    // ('' → root-relative url), which is what lets gamepad-support.js
    // synthesize mapped keyboard events into the frame.
    let url = urlOverride || item.url;
    // Somebody is already playing this one: bring the game up with its own
    // live-runs panel armed, so the row's LIVE badge leads somewhere.
    if (liveFor({ key: item.id, g: item }) && url.indexOf('online=') === -1) {
      url += (url.indexOf('?') === -1 ? '?' : '&') + 'online=1';
    }
    gameSrc = manifestOrigin ? new URL(url, manifestOrigin).href : url;
    setTimeout(() => { gameOn = true; }, 30);
  }

  // One launcher for every installed core. All eight players take ?rom=<file>
  // off their own page (core.player), so the only per-core knowledge left is the
  // BIOS list arcade rows carry — everything else is the catalogue entry.
  //
  // Root-relative and therefore same-origin: the worker mirrors the player from
  // the cmg origin, which is exactly what lets gamepad-support.js synthesize
  // mapped keyboard events into the frame. (The PS2 and Switch players also want
  // cross-origin isolation for SharedArrayBuffer; the worker stamps COOP/COEP on
  // their responses, but an iframe only isolates when the embedder does too, so
  // those two are best-effort here.)
  function launchEmuRow(core, row) {
    if (!core || !row) return;
    sfx.enter();
    chromeDismissed = false;
    // A disc built on this machine never reaches the mirror, so it is handed to
    // the player through IndexedDB instead of by filename — and at the TOP
    // level, because Play! keeps guest RAM in a SharedArrayBuffer and only a
    // cross-origin-isolated document gets one; an iframe cannot isolate unless
    // its embedder does too. That is the mode the player's own BYOD path was
    // written for, exit gestures (Escape, SELECT+START, two corners) included.
    if (row.kind === 'local' && row.local) {
      launchLocalPs2(row.local);
      return;
    }
    // A ps2 "web" row is a browser build living beside the ISOs, not a disc —
    // launch its own url rather than handing the filename to the emulator.
    if (row.kind === 'web' && row.url) {
      gameSrc = row.url;
    } else {
      if (!row.file) return;
      let q = 'rom=' + encodeURIComponent(row.file);
      if (Array.isArray(row.bios) && row.bios.length) {
        const params = new URLSearchParams({ rom: row.file });
        params.set('bios', row.bios.join(','));
        q = params.toString();
      }
      gameSrc = core.player + '?' + q;
    }
    setTimeout(() => { gameOn = true; }, 30);
  }

  async function launchLocalPs2(game) {
    try {
      location.href = await ps2PlayerUrl(game);
    } catch (e) {
      showToast('Could not start the PS2 player: ' + (e?.message || e));
    }
  }

  // ─── ShmupX context menu — .sav coverflow picker ──────────────────────────
  // Right-click, the gamepad's top face button (Y / triangle), the row's
  // shelf badge, or tap-and-hold on the highlighted
  // ShmupX row opens a coverflow over the Dezaemon .sav shelf — the same
  // library the editor's SAVED GAMES drawer reads: the database index first
  // (the only source a deployed build has), the static manifest for offline
  // checkouts. Picking a cover launches the row's own editor URL with
  // &play=<slug> appended — the editor's instant-play hand-off, which imports
  // the cart silently and swaps the frame for the running game.
  const SAV_DB_URL = 'https://evil-invaders-default-rtdb.firebaseio.com';
  const SAV_STATIC_MANIFEST = '/editor/dezaemon/saves.manifest.json';
  // The database index was written before the community table carried a game's
  // page and gameplay video, so those two come off games-db.json instead — the
  // same title join the editor's shelf does. The video is what the coverflow
  // previews on hover / tap-and-hold.
  const SAV_GAMES_DB = '/editor/dezaemon/games-db.json';
  // Catalog entries that own a .sav shelf. A manifest entry can also opt in
  // with `savLibrary: true` — same pattern as twinStick/touchControls.
  const SAV_PICKER_IDS = new Set(['shmupx']);
  // The player's pinned games. One localStorage key shared with the editor's
  // SAVED GAMES drawer, so a game starred on either surface leads both. Ids
  // are the database slugs — static-manifest rows compute the identical slug
  // (savSlugOf mirrors the upload script), so the two sources agree.
  const SAV_FAVS_KEY = 'cmg-deza-favs';
  function readSavFavs() {
    try {
      const raw = JSON.parse(localStorage.getItem(SAV_FAVS_KEY) || '[]');
      if (Array.isArray(raw)) return new Set(raw.filter((v) => typeof v === 'string'));
    } catch (_) { /* unreadable pref — start unpinned */ }
    return new Set();
  }
  let savFavs = $state(readSavFavs());
  function savFavId(item) { return item.slug || savSlugOf(item.title); }
  let savPickerOpen = $state(false);
  let savPickerSel = $state(0);
  let savQuery = $state('');          // the live search filter; '' = the whole shelf
  let savFindOpen = $state(false);    // is the search field on screen
  let savScrubbing = $state(false);   // a finger is on the alpha rail right now
  // The game savPickerSel is MEANT to be on, by identity rather than by index.
  // A plain let, not $state: the follow effect below reads it but must not
  // re-run on it, or writing the selection would retrigger the effect that
  // wrote it. Every write to savPickerSel goes through setSavSel so this
  // cannot drift.
  let savAnchorId = '';
  let savLibrary = $state(null);      // null until first open; [] = nothing reachable
  let savLibraryLoading = $state(false);
  let savLibraryErr = $state('');
  let savCovers = $state({});         // slug -> data URL | null (fetch failed)
  let savPickerGame = $state(null);   // the catalog entry the picker was opened for
  const savCoverPending = new Set();  // in-flight cover fetches; nothing renders off it
  let savLibraryPending = false;

  function rowHasSavPicker(row) {
    const g = row?.g;
    return !!g && (g.savLibrary === true || SAV_PICKER_IDS.has(g.id));
  }

  // Warm the shelf the moment a shelf-owning row is highlighted: the badge
  // gets its game count and the picker opens instantly instead of loading.
  $effect(() => {
    if (screen === 'games' && rowHasSavPicker(curRow)) loadSavLibrary();
  });

  // The upload script's slug algorithm (slugOf in scripts/upload-deza-saves.ts),
  // so static-manifest rows agree with the database keys.
  function savSlugOf(title) {
    const s = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return s || 'save';
  }

  // The editor's matcher (dezaNormTitle in static/editor/index.html).
  function savNormTitle(title) {
    return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  // Search folding. NFKD splits the accents off "Sōkyūgurentai" and the
  // combining marks are then dropped, so an ASCII keyboard still finds it; it
  // also folds the full-width Latin some of the scraped titles carry. Kana and
  // kanji survive untouched — those match by paste or by an IME, which is what
  // the titleJa column is there for.
  function savFold(s) {
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }
  // Built once per row at load, NEVER lazily inside the filter: savLibrary is
  // $state, so its rows are proxies, and writing a field on one from inside a
  // $derived is a mutation during derivation — Svelte 5 throws for that.
  function savBuildHaystacks(rows) {
    for (const r of rows) {
      r._hay = savFold(
        [r.title, r.titleJa, r.developer, r.developerJa, r.genre, r.slug].filter(Boolean).join(' ')
      );
    }
    return rows;
  }

  // Rows in, same rows out — with `url` / `video` filled in where the table
  // knows the game. A missing or unreadable table just means no previews.
  async function savAttachLinks(rows) {
    try {
      const r = await fetch(SAV_GAMES_DB);
      if (!r.ok) return rows;
      const db = await r.json();
      const byTitle = new Map();
      for (const g of db.games || []) byTitle.set(savNormTitle(g[0]), g);
      for (const [from, to] of Object.entries(db.aliases || {})) {
        const target = byTitle.get(to);
        if (target && !byTitle.has(from)) byTitle.set(from, target);
      }
      for (const row of rows) {
        const g = byTitle.get(savNormTitle(row.title));
        if (!g) continue;
        row.url = g[5] || '';
        row.video = g[6] || '';
      }
    } catch (_) { /* no links — the shelf itself is unaffected */ }
    return rows;
  }

  async function loadSavLibrary() {
    if (savLibraryPending || savLibrary) return;
    savLibraryPending = true;
    savLibraryLoading = true;
    savLibraryErr = '';
    try {
      let rows = null;
      try {
        const r = await fetch(SAV_DB_URL + '/dezaemon/index.json');
        if (r.ok) {
          const index = await r.json();
          if (index && typeof index === 'object') {
            rows = Object.keys(index).map((slug) => {
              const e = index[slug] || {};
              return {
                slug,
                file: e.file || slug + '.sav',
                title: e.titleEn || e.fileTitle || slug,
                titleJa: e.titleJa || '',
                developer: e.developerEn || '',
                developerJa: e.developerJa || '',
                genre: e.genre || '',
                hasCover: !!e.hasCover,
              };
            }).filter((s) => s.file);
            if (!rows.length) rows = null;
          }
        }
      } catch (_) { rows = null; }
      if (!rows) {
        // Offline checkout: the static manifest beside the .sav files. Covers
        // live only in the database, so these rows wear the placeholder art.
        const r = await fetch(SAV_STATIC_MANIFEST);
        const data = r.ok ? await r.json() : { saves: [] };
        rows = (data.saves || []).map((s) => ({
          slug: savSlugOf(s.title), file: s.file, title: s.title,
          titleJa: '', developer: '', developerJa: '', genre: '', hasCover: false,
        }));
      }
      await savAttachLinks(rows);
      rows.sort((a, b) => a.title.localeCompare(b.title));
      savBuildHaystacks(rows);
      savLibrary = rows;
    } catch (err) {
      savLibrary = [];
      savLibraryErr = 'COULD NOT READ THE SHELF: ' + (err?.message || err);
    } finally {
      savLibraryPending = false;
      savLibraryLoading = false;
    }
  }

  // The FAVORITES block leads, everything behind it keeps A-Z order (the block
  // itself stays A-Z too, being a stable partition of a sorted list). Rows in,
  // same rows out when nothing is pinned, so the caller keeps its array
  // identity — savShelf leans on that to hand savLibrary back by reference.
  function savHoistFavs(rows) {
    if (!rows?.length || !savFavs.size) return rows;
    const favs = [], rest = [];
    for (const r of rows) (savFavs.has(savFavId(r)) ? favs : rest).push(r);
    return favs.length ? favs.concat(rest) : rows;
  }

  // What the coverflow actually shows: the search filter, then the favorites
  // hoist. Derived, so a toggle or a keystroke re-shelves without refetching,
  // and every picker index — sel, launch, cover prefetch, the alpha rail —
  // reads this order, never savLibrary's.
  //
  // null = not read yet, [] = nothing reachable OR nothing matched; SavPicker
  // tells those two apart by the query it was given, not by the length.
  let savShelf = $derived.by(() => {
    if (!savLibrary?.length) return savLibrary;
    const terms = savFold(savQuery).split(/\s+/).filter(Boolean);
    // The filter runs BEFORE the hoist and never reads savFavs. A predicate
    // that consulted pin state would drop a game out of the shelf on the very
    // toggle that pinned it, and toggleSavFav's findIndex below would then
    // strand the cursor on an index that no longer exists.
    const rows = terms.length
      ? savLibrary.filter((r) => terms.every((t) => r._hay.includes(t)))
      : savLibrary;
    return savHoistFavs(rows);
  });

  // The alpha rail's rows, derived from the shelf so every `at` is a real,
  // in-range index by construction: a letter with no games simply has no band,
  // which is why the rail needs no skip logic and no disabled state. Keyed by
  // first appearance rather than by a fixed A-Z, because localeCompare files
  // the four punctuation-led titles ("-Devil Dimension- KAKUKAI 2") ahead of A
  // rather than under their first letter — a fixed alphabet would point # at
  // the wrong end of the shelf. Letters bucket from the end of the FAVORITES
  // block so a pinned S hoisted to the front never becomes the S the rail
  // jumps to.
  let savBands = $derived.by(() => {
    const rows = savShelf;
    if (!rows?.length) return [];
    let from = 0;
    while (from < rows.length && savFavs.has(savFavId(rows[from]))) from++;
    const seen = new Map();
    for (let i = from; i < rows.length; i++) {
      const c = String(rows[i].title || '').charAt(0).toUpperCase();
      const key = c >= 'A' && c <= 'Z' ? c : '#';
      const band = seen.get(key);
      if (band) band.n++;
      else seen.set(key, { key, at: i, n: 1 });
    }
    const out = [...seen.values()].sort((a, b) => a.at - b.at);
    if (from > 0) out.unshift({ key: '★', at: 0, n: from });
    return out;
  });

  // The single writer of savPickerSel. It stamps the anchor at the same time,
  // so the follow effect below always knows which game the cursor was on
  // before the shelf reshuffled under it.
  function setSavSel(i) {
    savPickerSel = i;
    const item = savShelf?.[i];
    savAnchorId = item ? savFavId(item) : '';
  }

  function toggleSavFav(i) {
    const item = savShelf?.[i];
    if (!item) return;
    const id = savFavId(item);
    const next = new Set(savFavs);
    if (next.has(id)) next.delete(id); else next.add(id);
    savFavs = next;
    try { localStorage.setItem(SAV_FAVS_KEY, JSON.stringify([...next])); } catch (_) { /* session-only pin */ }
    // The cover just moved into (or out of) the leading favorites block —
    // follow it, so the fan stays centred on the game that was just starred.
    // The effect below would land the same index a frame later; doing it here
    // too keeps the fan from visibly jumping through the old position first.
    savAnchorId = id;
    const at = savShelf ? savShelf.findIndex((r) => savFavId(r) === id) : -1;
    if (at >= 0 && at !== savPickerSel) savPickerSel = at;
    sfx.nav();
  }

  function fetchSavCover(item) {
    if (!item || !item.slug || !item.hasCover) return;
    if (item.slug in savCovers || savCoverPending.has(item.slug)) return;
    savCoverPending.add(item.slug);
    (async () => {
      try {
        const r = await fetch(SAV_DB_URL + '/dezaemon/covers/' + encodeURIComponent(item.slug) + '.json');
        const rec = r.ok ? await r.json() : null;
        savCovers = { ...savCovers, [item.slug]: rec && rec.png ? rec.png : null };
      } catch (_) {
        savCovers = { ...savCovers, [item.slug]: null };
      } finally {
        savCoverPending.delete(item.slug);
      }
    })();
  }

  // Fetch art for the covers in and just beyond the rendered fan as the
  // cursor moves — the full shelf is 258 × ~9KB, far more than a browse needs.
  // Held off entirely while a finger is on the alpha rail: one sweep crosses
  // every band, and 13 fetches per band is the whole library in flight.
  $effect(() => {
    if (!savPickerOpen || savScrubbing || !savShelf?.length) return;
    const lo = Math.max(0, savPickerSel - 6);
    const hi = Math.min(savShelf.length - 1, savPickerSel + 6);
    for (let i = lo; i <= hi; i++) fetchSavCover(savShelf[i]);
  });

  // The cursor follows the GAME, not the index. A search keystroke, a favorite
  // toggle and a shelf that shrank under the cursor all reshuffle savShelf, and
  // this is the one owner that re-points the selection afterwards: find the
  // anchored game again, else clamp where we are into the new range. Reading
  // savShelf is what makes a keystroke re-run it — the clamp this replaced read
  // neither the shelf nor the query, so it could never have fired on one.
  $effect(() => {
    const shelf = savShelf;
    if (!savLibrary) return;
    const n = shelf?.length || 0;
    // untrack so the effect's only dependency is the shelf: reading the value
    // it also writes would make it retrigger itself.
    untrack(() => {
      const at = savAnchorId && n ? shelf.findIndex((r) => savFavId(r) === savAnchorId) : -1;
      const target = at >= 0 ? at : Math.min(Math.max(0, savPickerSel), Math.max(0, n - 1));
      if (savPickerSel !== target) savPickerSel = target;
    });
  });

  function openSavPicker(g) {
    // The gameOn guard covers async entries — a long-press timer that fires
    // after another input already launched a game must not stack the picker
    // over the running frame.
    if (savPickerOpen || gameOn) return;
    if (g) savPickerGame = g;
    savNav.hDir = 0; savNav.hSeenAt = 0; savNav.hHeldSince = 0; savNav.hLastNav = 0;
    savNav.vDir = 0; savNav.vSeenAt = 0; savNav.vHeldSince = 0; savNav.vLastNav = 0;
    // A filter is a browse, not a preference: it never survives a close. The
    // cursor deliberately does — the anchor puts it back on the same game once
    // clearing the query restores the full shelf.
    savQuery = ''; savFindOpen = false; savScrubbing = false;
    // Pins toggled in the editor's drawer (a same-origin iframe away) land
    // between opens — re-read, so both surfaces shelve the same games first.
    savFavs = readSavFavs();
    savPickerOpen = true;
    sfx.enter();
    // A shelf that came up empty (offline at the time, fetch error) retries
    // on the next open instead of caching the failure for the session.
    if (savLibrary && !savLibrary.length) savLibrary = null;
    loadSavLibrary();
  }
  function closeSavPicker() {
    if (!savPickerOpen) return;
    savPickerOpen = false;
    savScrubbing = false;
    sfx.back();
  }
  // Esc / the ✕ on the field walk one rung at a time: a live query clears
  // first, then the field goes away, and only then does Esc reach the picker.
  function savFindEscape() {
    if (savQuery) savQuery = '';
    else if (savFindOpen) { savFindOpen = false; sfx.back(); }
    else closeSavPicker();
  }
  function savToggleFind() {
    savFindOpen = !savFindOpen;
    if (!savFindOpen) savQuery = '';
    sfx.nav();
  }
  // The gamepad entry (FBTN_TOP): only while a shelf-owning row is the
  // highlighted row of the games screen.
  function openSavPickerForRow() {
    if (gameOn || screen !== 'games' || stripOn) return false;
    if (!rowHasSavPicker(curRow)) return false;
    openSavPicker(curRow.g);
    return true;
  }
  // Bounded on the SHELF, not the library: under a search filter the shelf is
  // the shorter of the two, and every keyboard, gamepad and pointer move on
  // the picker funnels through here.
  function savPickerJump(i) {
    if (!savShelf?.length) return;
    const next = Math.max(0, Math.min(savShelf.length - 1, i));
    if (next !== savPickerSel) { setSavSel(next); sfx.nav(); }
  }
  function savPickerMove(dir) { savPickerJump(savPickerSel + dir); }
  // The alpha rail hands back a band index; the band's `at` is already a valid
  // shelf index (savBands is derived from savShelf), so there is nothing to
  // resolve here beyond the shared bounds check.
  function savBandJump(b) {
    const band = savBands[b];
    if (band) savPickerJump(band.at);
  }
  // Gamepad/keyboard stepping between bands: which band the cursor is inside
  // right now, then one along. Bands are ordered by `at`, so the containing
  // band is the last one that starts at or before the cursor.
  function savBandAt(i) {
    let at = 0;
    for (let b = 0; b < savBands.length; b++) {
      if (savBands[b].at <= i) at = b; else break;
    }
    return at;
  }
  function savBandStep(dir) {
    if (!savBands.length) return;
    const here = savBandAt(savPickerSel);
    // Stepping back from inside a band lands on its own first game first —
    // the same "go to the top of this letter, then the previous letter" feel
    // a scrollbar's page-up has.
    const next = dir < 0 && savBands[here].at < savPickerSel ? here : here + dir;
    // Off either end is a no-op, never a clamp: clamping a forward step back
    // onto the final band would re-jump to that band's FIRST game, scrubbing
    // the fan backwards on an input that means "next letter".
    if (next < 0 || next >= savBands.length) return;
    savBandJump(next);
  }
  function launchSavGame(i) {
    const item = savShelf?.[i];
    const g = savPickerGame;
    if (!item || !g || !g.url) return;
    savPickerOpen = false;
    let url;
    try {
      const u = new URL(g.url, window.location.origin);
      u.searchParams.set('play', item.slug || savSlugOf(item.title));
      url = u.pathname + u.search + u.hash;
    } catch (_) { return; }
    launchGame(g.id, url);
  }

  // ── Row context gestures ──────────────────────────────────────────────────
  // Right-click and tap-and-hold on a shelf-owning row open the coverflow.
  // The long-press stamps rowPressFiredAt so the click that follows its
  // release is swallowed (consumeRowPress in the row's onclick) instead of
  // ALSO launching the row, and a drag past a few pixels cancels it so list
  // scrolling stays a scroll.
  let rowPress = null;          // { id, x, y, timer }
  let rowPressFiredAt = 0;
  const ROW_PRESS_MS = 550;
  const ROW_PRESS_SLOP = 12;
  function rowPressStart(e, r, i) {
    if (!rowHasSavPicker(r) || savPickerOpen) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    rowPressCancel();
    rowPress = {
      id: e.pointerId, x: e.clientX, y: e.clientY,
      timer: setTimeout(() => {
        rowPress = null;
        rowPressFiredAt = performance.now();
        stripFocus = false;
        curSection.setSel(i);
        openSavPicker(r.g);
      }, ROW_PRESS_MS),
    };
  }
  function rowPressMove(e) {
    if (!rowPress || rowPress.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - rowPress.x, e.clientY - rowPress.y) > ROW_PRESS_SLOP) rowPressCancel();
  }
  function rowPressEnd(e) {
    if (rowPress && rowPress.id === e.pointerId) rowPressCancel();
  }
  function rowPressCancel() {
    if (rowPress) { clearTimeout(rowPress.timer); rowPress = null; }
  }
  // Self-expiring: a hold whose release never produces a click (the finger
  // lifted over the picker's scrim) must not swallow the NEXT genuine click.
  function consumeRowPress() {
    return performance.now() - rowPressFiredAt < 800;
  }
  function onRowContextMenu(e, r, i) {
    if (!rowHasSavPicker(r)) return; // other rows keep the native menu
    e.preventDefault();
    if (savPickerOpen) return;
    stripFocus = false;
    curSection.setSel(i);
    openSavPicker(r.g);
  }

  // Gamepad nav state for the picker (edge latch + hold-to-repeat, the same
  // feel as the launcher lists). Plain object — nothing renders off it.
  const savNav = {
    hDir: 0, hSeenAt: 0, hHeldSince: 0, hLastNav: 0,
    // The alpha channel, on the right stick. Kept as its own latch so a
    // diagonal never fires both axes.
    vDir: 0, vSeenAt: 0, vHeldSince: 0, vLastNav: 0,
  };
  function pollSavPickerPad(pad) {
    padState.axisDir = 0; padState.hAxisDir = 0;
    const pressedNow = new Set();
    pad.buttons.forEach((btn, i) => { if (btn?.pressed) pressedNow.add(i); });
    const justPressed = (i) => pressedNow.has(i) && !padState.btn.has(i);
    const dirs = readPadDirs(pad);
    const now = performance.now();
    const isSnes = SNES_PAD_RE.test(pad?.id || '');
    // Ignore direction input while SELECT is held — the still-held SELECT+Up
    // OPEN chord would otherwise feed straight into nav on the picker's first
    // frame (same guard, and same reason, as the OSD branch's selHeld).
    const selHeld = !!pad.buttons[8]?.pressed;
    // The fan is the only thing on screen, so Up/Down fold into prev/next too.
    let h = 0;
    if (!selHeld) {
      if (dirs.left || dirs.up) h = -1;
      else if (dirs.right || dirs.down) h = 1;
      else {
        // Sticks — capped at 1.05 like every other axis read: idle axes on
        // some pads rest at "no input" sentinels like 1.28. SNES pads have no
        // sticks, and their raw slots must not be read as analog at all.
        for (const i of isSnes ? [] : [0, 1]) {
          const v = pad.axes[i];
          if (typeof v !== 'number' || Math.abs(v) > 1.05) continue;
          if (v < -PAD_DEADZONE) { h = -1; break; }
          if (v > PAD_DEADZONE) { h = 1; break; }
        }
      }
    }
    const hReal = h;
    if (h === 0 && savNav.hDir !== 0 && now - savNav.hSeenAt < 80) h = savNav.hDir;
    if (hReal !== 0) savNav.hSeenAt = now;
    if (h !== 0 && h !== savNav.hDir) {
      // Fresh edges are rate-limited like the launcher lists: bounce trains
      // with gaps past the dropout window land as several edges per tap.
      if (now - savNav.hLastNav >= 150 || savNav.hLastNav === 0) {
        savPickerMove(h);
        savNav.hLastNav = now;
      }
      savNav.hHeldSince = now;
    } else if (h !== 0 && h === savNav.hDir) {
      if (now - savNav.hHeldSince >= padState.initialDelayMs && now - savNav.hLastNav >= padState.repeatMs) {
        savPickerMove(h);
        savNav.hLastNav = now;
      }
    }
    savNav.hDir = h;

    // Alpha stepping on the RIGHT stick's Y axis (axes[3]) — the only input
    // the picker does not already spend, so nothing existing changes meaning:
    // the d-pad and the left stick keep folding Up/Down into prev/next. Same
    // five-step edge/dropout/repeat filter as the horizontal channel above.
    // Dead on Android+SNES by construction (no analog slots to read there,
    // which is the same reason that branch hijacks L/L2 for prev/next) — the
    // rail and the keyboard cover that case.
    let v = 0;
    if (!selHeld && !isSnes) {
      const raw = pad.axes[3];
      if (typeof raw === 'number' && Math.abs(raw) <= 1.05) {
        if (raw < -PAD_DEADZONE) v = -1;
        else if (raw > PAD_DEADZONE) v = 1;
      }
    }
    const vReal = v;
    if (v === 0 && savNav.vDir !== 0 && now - savNav.vSeenAt < 80) v = savNav.vDir;
    if (vReal !== 0) savNav.vSeenAt = now;
    if (v !== 0 && v !== savNav.vDir) {
      if (now - savNav.vLastNav >= 150 || savNav.vLastNav === 0) {
        savBandStep(v);
        savNav.vLastNav = now;
      }
      savNav.vHeldSince = now;
    } else if (v !== 0 && v === savNav.vDir) {
      if (now - savNav.vHeldSince >= padState.initialDelayMs && now - savNav.vLastNav >= padState.repeatMs) {
        savBandStep(v);
        savNav.vLastNav = now;
      }
    }
    savNav.vDir = v;

    if (IS_ANDROID && isSnes) {
      // Android Chrome + SNES: the D-pad doesn't report and physical R
      // arrives remapped to the L2 slot — L/L2 are the primary prev/next
      // there, exactly as they are the launcher lists' primary up/down.
      if (justPressed(4)) savPickerMove(-1);
      if (justPressed(6)) savPickerMove(1);
    } else {
      // Shoulders page, triggers jump to the ends — the shelf is 258 long.
      if (justPressed(4)) savPickerJump(savPickerSel - 10);
      if (justPressed(5)) savPickerJump(savPickerSel + 10);
      if (justPressed(6)) savPickerJump(0);
      if (justPressed(7)) savPickerJump(savShelf ? savShelf.length - 1 : 0);
    }
    // FBTN_LEFT (X / square) pins the centred cover to the favorites block.
    if (justPressed(2)) toggleSavFav(savPickerSel);
    if (justPressed(0) || justPressed(9)) { lastInput = 'pad'; launchSavGame(savPickerSel); }
    else if (justPressed(1) || justPressed(8)) closeSavPicker();
    // The SELECT still held from the opening chord must not read as Back once
    // it is finally released back in the launcher branch.
    if (!pressedNow.has(8)) { padState.selChordFired = false; padState.selArmed = false; }
    padState.btn = pressedNow;
  }

  async function loadManifest() {
    // Launcher content, fetched SAME-ORIGIN only (/games.manifest.json), else
    // keep the baked seeds. Same-origin keeps every game url root-relative,
    // which is what allows mapped gamepad→keyboard input injection into the
    // game frame.
    const asList = (v) => (Array.isArray(v) ? v : null);
    const tryFetch = async (base) => {
      const r = await fetch(base + '/games.manifest.json?ts=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      // Accept { games, demos } or a bare games array (older manifest shape).
      const games = asList(data) || asList(data && data.games);
      if (!games || !games.length) throw new Error('empty manifest');
      return { games, base };
    };
    let res = null;
    try {
      res = await tryFetch('');
    } catch (_e) {
      return; // fetch failed — keep the baked-in seeds
    }
    manifestOrigin = res.base;
    // Write the backing $state; GAMES is a $derived over it.
    manifestGames = res.games;
    if (gameSel >= GAMES.length) gameSel = 0;
  }

  function closeGame() {
    // Keep gameSrc set through the fade-out so the iframe unmounts after the
    // transition plays.
    let unmounted = false;
    const unmount = () => { if (!unmounted) { unmounted = true; gameSrc = null; } };
    setTimeout(unmount, 500);
    gameOn = false;
    frameUrl = null;
    chromeDismissed = false;
    // Drop the prior game's advertised cheats; the next game re-broadcasts its
    // own on boot. closeGame is the single chokepoint between games (the list
    // is only reachable when no game is on), so this alone prevents stale carry-over.
    osdCheats = [];
    osdPlugins = [];
    osdActions = [];
    osdExtras = [];
    osdLevelEditor = null;
    twinStickAvail = false;
    twinStickOn = false;
    twinGameId = null;
    twinStickUserSet = false;
    touchCtlAvail = false;
    touchCtlOn = false;
    touchCtlGameId = null;
    touchCtlUserSet = false;
    sfx.back();
  }

  function onIconError(e, name) {
    const img = e.currentTarget;
    const parent = img.parentNode;
    if (parent) parent.innerHTML = '<span class="ph">' + initial(name) + '</span>';
  }

  let clockTimer;
  let bootTimer;
  let padRaf = null;
  const padSeenBtns = new Set();
  const padSeenAxes = new Set();

  // ?paddebug=1 — on-screen gamepad monitor for devices without devtools
  // (handhelds, TVs). Shows the browser's RAW pad state alongside the
  // compat-plugin-normalized view, so quirky button/axis layouts can be
  // reported from the couch.
  const padDebugOn = typeof location !== 'undefined' && /[?&]paddebug=1/.test(location.search);
  let padDebugText = $state('');

  function padDebugTick() {
    if (!padDebugOn) return;
    const fmt = (p, tag) => {
      if (!p) return null;
      const btns = [];
      for (let i = 0; i < p.buttons.length; i++) if (p.buttons[i]?.pressed) btns.push(i);
      const axs = [];
      for (let i = 0; i < p.axes.length; i++) {
        const v = p.axes[i];
        if (typeof v === 'number' && Math.abs(v) > 0.2) axs.push(`${i}:${v.toFixed(2)}`);
      }
      return `${tag} #${p.index} map:${p.mapping || '""'} b:${p.buttons.length} a:${p.axes.length}\n` +
        `  pressed:[${btns.join(',')}] axes:[${axs.join(' ')}]\n  ${(p.id || '').slice(0, 48)}`;
    };
    const lines = [];
    try {
      for (const p of (window.CMGGamepadCompat?.raw?.() || [])) {
        const s = fmt(p, 'RAW ');
        if (s) lines.push(s);
      }
    } catch (_) { /* ignore */ }
    try {
      for (const p of ((navigator.getGamepads && navigator.getGamepads()) || [])) {
        const s = fmt(p, 'NORM');
        if (s) lines.push(s);
      }
    } catch (_) { /* ignore */ }
    padDebugText = lines.join('\n') || 'no pads detected';
  }
  const padState = {
    btn: new Set(),
    axisDir: 0,
    lastNavAt: 0,
    // Hold-to-repeat feel: long enough that a deliberate single tap (which
    // often lasts 300ms+) never auto-repeats, then a steady scroll.
    initialDelayMs: 600,
    repeatMs: 150,
    holdingSince: 0,
    comboLatched: false,
    // SELECT chord bookkeeping for the launcher branch: selArmed marks a
    // SELECT press that began there (so a release edge inherited from another
    // branch can't fire Back), selChordFired marks that SELECT + Up consumed
    // the hold (so its release doesn't ALSO fire Back).
    selArmed: false,
    selChordFired: false,
    rawDirPrev: 0,
    r3Latched: false,
    dirSeenAt: 0,
    lastPollAt: 0,
    // Horizontal twins of axisDir/lastNavAt/holdingSince/dirSeenAt, for the
    // emulator strip. Kept separate so a diagonal never fires both axes.
    hAxisDir: 0,
    hLastNavAt: 0,
    hHoldingSince: 0,
    hDirSeenAt: 0,
    // Index of the controller currently driving the menu. Any controller the
    // user picks up takes over (see pickActivePad); this remembers the last one
    // so an idle pad keeps control until another is actually used.
    lastActiveIndex: null,
  };
  const PAD_DEADZONE = 0.55;
  const SNES_PAD_RE = /SNES Controller|Nintendo.*SNES|057e.{0,8}2017/i;
  // What kind of pad is currently driving the menus — feeds the Guide footer
  // hint so the open-chord it advertises is the one that actually works on
  // this pad/platform (the hardcoded 'SELECT + ↓' was wrong on Android+SNES,
  // where the D-pad doesn't report and the real chord is SELECT + L2).
  let activePadKind = $state('none'); // 'none' | 'pad' | 'snes' | 'snes-android'
  let osdHint = $derived(
    activePadKind === 'snes-android'
      ? 'SELECT + L2 (R) · two-corner tap'
      : activePadKind === 'snes'
        ? 'SELECT + ↓ or R · two-corner tap'
        : 'SELECT + ↓ · two-corner tap'
  );
  // Chrome on Android: the compat plugin remaps the SNES pad's R shoulder to
  // the L2 slot there, and the launcher pairs it with L/L2 nav + SELECT+L2.
  // userAgentData first — "Request desktop site" strips Android from the UA
  // string, which would silently disable those accommodations.
  const IS_ANDROID = typeof navigator !== 'undefined' &&
    (navigator.userAgentData?.platform === 'Android' || /Android/i.test(navigator.userAgent || ''));
  const XBOX_PAD_RE = /Xbox|XInput|Microsoft|Legion Go/i;

  function padPriority(p) {
    const id = p?.id || '';
    if (SNES_PAD_RE.test(id)) return 3;
    if (XBOX_PAD_RE.test(id)) return 2;
    return 1;
  }

  function pickPrimaryPad(pads) {
    let best = null;
    let bestScore = -1;
    for (const p of pads) {
      if (!p?.connected) continue;
      const score = padPriority(p);
      if (score > bestScore) {
        best = p;
        bestScore = score;
      }
    }
    return best;
  }

  // Is this pad providing live input right now? Buttons + sticks (axes 0-3) +
  // hat only — trigger axes rest at an extreme on some pads, so counting all
  // axes would flag an idle controller as "active" and fight for control.
  function padHasActivity(pad) {
    if (!pad) return false;
    for (let i = 0; i < pad.buttons.length; i++) {
      if (pad.buttons[i]?.pressed) return true;
    }
    for (const i of [0, 1, 2, 3]) {
      const v = pad.axes[i];
      if (typeof v === 'number' && Math.abs(v) > PAD_DEADZONE && Math.abs(v) <= 1.05) return true;
    }
    // Hat on axes[9] counts as activity (grid-validated decode rejects analog
    // values), but raw axes 6/7 deliberately do NOT: trigger axes rest at ±1
    // on some pads, and counting them here would let a completely idle device
    // permanently seize menu control in multi-pad sessions. A pad whose D-pad
    // lives on 6/7 still navigates fine whenever it is the primary/last-used
    // pad — it just can't steal control with its first D-pad press alone.
    const hat = decodePadHat(pad.axes[9]);
    return hat.up || hat.down || hat.left || hat.right;
  }

  // Which controller drives the menu. Unlike pickPrimaryPad (single highest-
  // priority pad), this lets ANY connected controller take over the moment it's
  // used, so a second/guest pad works without being unplugged-and-swapped:
  //   1. a pad with live input this frame wins (the one still holding control
  //      keeps it if it's also active, to avoid thrashing between two);
  //   2. otherwise the last pad that was used keeps control while idle;
  //   3. otherwise fall back to the priority pick.
  function pickActivePad(pads) {
    let active = null;
    for (const p of pads) {
      if (!p?.connected || !padHasActivity(p)) continue;
      if (p.index === padState.lastActiveIndex) return p;
      if (!active) active = p;
    }
    if (active) { padState.lastActiveIndex = active.index; return active; }
    if (padState.lastActiveIndex != null) {
      for (const p of pads) {
        if (p?.connected && p.index === padState.lastActiveIndex) return p;
      }
    }
    const primary = pickPrimaryPad(pads);
    padState.lastActiveIndex = primary ? primary.index : null;
    return primary;
  }

  function decodePadHat(v) {
    const none = { up: false, down: false, left: false, right: false };
    if (typeof v !== 'number' || v < -1.05 || v > 1.05) return none;
    // Only accept values on the hat's 8-step grid — 0 (an untouched axis on
    // some stacks) sits between steps and would decode as a phantom "down".
    const scaled = (v + 1) * 3.5;
    if (Math.abs(scaled - Math.round(scaled)) > 0.25) return none;
    const pos = Math.round(scaled);
    const labels = ['up', 'upright', 'right', 'downright', 'down', 'downleft', 'left', 'upleft'];
    const d = labels[pos] || '';
    return {
      up: d === 'up' || d === 'upright' || d === 'upleft',
      down: d === 'down' || d === 'downright' || d === 'downleft',
      left: d === 'left' || d === 'downleft' || d === 'upleft',
      right: d === 'right' || d === 'upright' || d === 'downright',
    };
  }

  function readPadDirs(pad) {
    const dirs = { up: false, down: false, left: false, right: false };
    if (!pad) return dirs;
    const btn = (i) => !!pad.buttons[i]?.pressed;
    dirs.up = btn(12);
    dirs.down = btn(13);
    dirs.left = btn(14);
    dirs.right = btn(15);
    // A pad the browser normalized to the standard mapping is DONE here:
    // 12-15 ARE its D-pad, the raw slots past 15 are extra hardware (on a
    // DualShock 4, 16 = the PS button and 17 = the touchpad click — read as
    // "up"/"down" they navigated the launcher), and its axes past 3 are
    // whatever the driver felt like (a resting trigger reads as a held
    // direction). Only non-standard layouts need the fallback sweeps.
    if (pad.mapping === 'standard') return dirs;
    // SNES pads: the compat plugin rebuilds 12-15 from the hat, and the raw
    // slots past 15 can hold Select/Start on some platforms — reading them as
    // a D-pad turns Select/Start into phantom up/down presses.
    const isSnes = SNES_PAD_RE.test(pad?.id || '');
    if (!isSnes) {
      dirs.up ||= btn(16) || btn(18) || btn(20);
      dirs.down ||= btn(17) || btn(19) || btn(21);
    }
    const ax = pad.axes || [];
    if (typeof ax[6] === 'number' && Math.abs(ax[6]) <= 1.05) {
      if (ax[6] <= -PAD_DEADZONE) dirs.left = true;
      else if (ax[6] >= PAD_DEADZONE) dirs.right = true;
    }
    if (typeof ax[7] === 'number' && Math.abs(ax[7]) <= 1.05) {
      if (ax[7] <= -PAD_DEADZONE) dirs.up = true;
      else if (ax[7] >= PAD_DEADZONE) dirs.down = true;
    }
    const hat = decodePadHat(ax[9]);
    dirs.up ||= hat.up; dirs.down ||= hat.down; dirs.left ||= hat.left; dirs.right ||= hat.right;
    return dirs;
  }

  // ─── Screen registry ─────────────────────────────────────────────────────
  // One descriptor per screen replaces the per-screen if/else chains that were
  // duplicated across navUp/navDown/navTop/navBottom/actFbtnBottom and onKey —
  // every screen registered here is uniformly navigable by gamepad AND
  // keyboard, current and future. Each entry:
  //   sel()/setSel(v) — accessors around the screen's selection $state;
  //   len()           — row count (arcade/nes include their pinned BYO row);
  //   activate(i)     — FBTN_BOTTOM / Enter / Space on row i;
  //   move/top/bottom — optional overrides for non-uniform rows (oeimport
  //                     skips its header rows).
  const SCREEN_DEFS = {
    dashboard: { sel: () => menuSel, setSel: (v) => (menuSel = v), len: () => MAIN_MENU.length, activate: (i) => pickMenu(i) },
    // One entry for the whole catalog: the strip picks the section, the section
    // owns its own cursor (see SECTIONS). `moveH` is the horizontal channel —
    // only screens that declare it get left/right nav at all.
    games: {
      // Clamped: a section's cursor can outlive a list that shrank under it, and
      // the clamp lands before the $effect that writes the correction back.
      sel: () => curSel,
      setSel: (v) => curSection.setSel(v),
      len: () => curRows.length,
      move: (dir, fresh) => gamesMove(dir, fresh),
      moveH: (dir) => gamesMoveH(dir),
      // L2/R2 jump between the two halves: to the strip, or to the last row.
      // With no strip rendered, "top" is just the top of the list.
      top: () => { if (stripShown) stripFocus = true; else curSection.setSel(0); },
      bottom: () => { if (enterList()) curSection.setSel(Math.max(curRows.length - 1, 0)); },
      // On the strip, A drops into the list — or opens the picker outright when
      // the section is empty, so an empty console is one press from a file
      // dialog instead of a dead end.
      activate: (i) => {
        if (stripOn) { if (!enterList()) openSectionPicker(); return; }
        if (sectionEmpty) { openSectionPicker(); return; }
        curSection.activate(i);
      },
    },
    settings: { sel: () => settingsSel, setSel: (v) => (settingsSel = v), len: () => SETTINGS_ITEMS.length, activate: (i) => activateSettings(i) },
    // Reached from Settings, so B goes back there rather than to the dashboard.
    emulators: { sel: () => emuSel, setSel: (v) => (emuSel = v), len: () => emuCores.length, activate: (i) => activateEmulator(i), back: 'settings' },
  };

  // Shared vertical nav. `fresh` marks a deliberate new press (gamepad edge /
  // non-repeat keydown): those wrap at the list ends — SNES-class pads have no
  // L2/R2 to jump with, so wrapping is their fast path to the far end — while
  // hold-to-repeat clamps, so autoscroll parks at the edge instead of cycling.
  function navMove(dir, fresh = false) {
    const s = SCREEN_DEFS[screen];
    if (!s) return;
    if (s.move) s.move(dir, fresh);
    else {
      const max = Math.max(s.len() - 1, 0);
      let next = s.sel() + dir;
      if (next < 0) next = fresh && max > 0 ? max : 0;
      else if (next > max) next = fresh && max > 0 ? 0 : max;
      s.setSel(next);
    }
    sfx.nav();
  }
  function navUp(fresh = false) { navMove(-1, fresh); }
  function navDown(fresh = false) { navMove(1, fresh); }
  // Horizontal nav — only the games screen declares `moveH` (the emulator
  // strip); everywhere else left/right stay free for their existing meanings.
  function navHasH() { return !!SCREEN_DEFS[screen]?.moveH; }
  function navMoveH(dir) {
    const s = SCREEN_DEFS[screen];
    if (!s?.moveH) return;
    s.moveH(dir);
  }
  function navTop() {
    const s = SCREEN_DEFS[screen];
    if (!s) return;
    if (s.top) s.top(); else s.setSel(0);
    sfx.nav();
  }
  function navBottom() {
    const s = SCREEN_DEFS[screen];
    if (!s) return;
    if (s.bottom) s.bottom(); else s.setSel(Math.max(s.len() - 1, 0));
    sfx.nav();
  }
  function actFbtnBottom() {
    if (gameOn) return;
    const s = SCREEN_DEFS[screen];
    if (s) s.activate(s.sel());
  }
  function actFbtnRight() {
    if (gameOn) closeGame();
    else if (screen !== 'dashboard') goBack();
  }

  // Custom gamepad polling drives dashboard nav (vertical). When a game iframe
  // is active, body.playing is set and the launcher's gamepad-support.js takes
  // over and dispatches keys into iframe#gameframe — we yield to it.
  function pollPad() {
    padRaf = requestAnimationFrame(pollPad);
    padDebugTick();
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    let pad = pickActivePad(pads);
    const kindNow = !pad
      ? 'none'
      : SNES_PAD_RE.test(pad.id || '')
        ? (IS_ANDROID ? 'snes-android' : 'snes')
        : 'pad';
    if (kindNow !== activePadKind) activePadKind = kindNow;
    // R3 anywhere — launcher or mid-game — asks for fullscreen. Latched on its
    // own so the early returns below (and the OSD branch) can't swallow it.
    if (pad) {
      const r3 = !!pad.buttons[11]?.pressed;
      if (r3 && !padState.r3Latched) requestFullscreenFromPad();
      padState.r3Latched = r3;
    } else padState.r3Latched = false;
    // While the controller configurator or the mapping wizard is open, that
    // panel owns pad input (driven from gamepad-support.js's poll hook) — the
    // launcher must not also navigate/launch/open the Guide underneath it.
    // Keep latching pressed buttons so the press that closes the panel doesn't
    // read as a fresh edge (and, say, fire Back) the frame after it closes.
    const gm = typeof window !== 'undefined' ? window.gamepadManager : null;
    if (gm && ((gm.isConfiguratorOpen && gm.isConfiguratorOpen()) || gm.wizardActive)) {
      const pressedNow = new Set();
      if (pad) pad.buttons.forEach((btn, i) => { if (btn?.pressed) pressedNow.add(i); });
      padState.btn = pressedNow;
      padState.axisDir = 0; padState.hAxisDir = 0; padState.comboLatched = false;
      if (!pressedNow.has(8)) { padState.selArmed = false; padState.selChordFired = false; }
      osdNav.vDir = 0; osdNav.hDir = 0;
      return;
    }
    if (gameOn) {
      // While a game is up we yield input to gamepad-support.js (it dispatches
      // keys into #gameframe). Here we only watch for the OSD open-chord, and
      // drive OSD navigation while it's open — body.osd-open makes
      // gamepad-support yield, so these presses don't leak into the game.
      padState.axisDir = 0; padState.hAxisDir = 0;
      if (!pad) { padState.btn.clear(); padState.comboLatched = false; padState.selArmed = false; padState.selChordFired = false; osdNav.vDir = 0; osdNav.hDir = 0; return; }
      const pressedNow = new Set();
      pad.buttons.forEach((btn, i) => { if (btn?.pressed) pressedNow.add(i); });
      const justPressed = (i) => pressedNow.has(i) && !padState.btn.has(i);
      // A SELECT released while a game runs must not leave the launcher's
      // chord latches armed — they'd eat (or forge) the next launcher Back.
      if (!pressedNow.has(8)) { padState.selArmed = false; padState.selChordFired = false; }

      if (osdOpen) {
        // Vertical: D-pad 12/13 or left-stick Y → move selection (edge-latched).
        // Ignored while SELECT is held — SELECT has no vertical-nav role in the
        // Guide, and without this the still-held SELECT+Down OPEN chord feeds
        // straight into nav (worse now that hold-to-repeat exists: holding the
        // chord a beat too long would race the selection down the list).
        const dirs = readPadDirs(pad);
        const nowOsd = performance.now();
        const selHeld = !!pad.buttons[8]?.pressed;
        let v = 0;
        if (!selHeld) {
          if (dirs.up) v = -1;
          else if (dirs.down) v = 1;
          else { const ay = pad.axes[1] ?? 0; if (ay < -PAD_DEADZONE) v = -1; else if (ay > PAD_DEADZONE) v = 1; }
        }
        // Shoulders mirror the launcher-list nav (L up, R/L2 down) — on
        // Android Chrome the SNES pad's D-pad doesn't report, so these are
        // the only way to move through the Guide there. Ignored while SELECT
        // is held so the SELECT+L2 open-chord doesn't nudge the selection on
        // its opening frame.
        if (v === 0 && !pad.buttons[8]?.pressed) {
          if (pad.buttons[4]?.pressed) v = -1;
          else if (pad.buttons[5]?.pressed || pad.buttons[6]?.pressed) v = 1;
        }
        // Same bounce/dropout filter as the launcher-list nav: hold the last
        // direction through sub-80ms neutral blips so a bouncy D-pad doesn't
        // move the selection several rows per tap. Only a REAL read re-arms the
        // window — refreshing it from the synthesized hold latched the
        // direction and stopped the D-pad responding until the opposite was
        // pressed.
        const vReal = v;
        if (v === 0 && osdNav.vDir !== 0 && nowOsd - (osdNav.vSeenAt || 0) < 80) v = osdNav.vDir;
        if (vReal !== 0) osdNav.vSeenAt = nowOsd;
        if (v !== 0 && v !== osdNav.vDir) {
          osdSel = Math.max(0, Math.min(osdItems.length - 1, osdSel + v));
          sfx.nav();
          osdNav.vHeldSince = nowOsd;
          osdNav.vLastNav = nowOsd;
        } else if (v !== 0 && v === osdNav.vDir) {
          // Hold-to-repeat, mirroring the launcher lists — without it a long
          // Guide (many cheats/plugins) is a one-tap-per-row crawl.
          if (
            nowOsd - (osdNav.vHeldSince || 0) >= padState.initialDelayMs &&
            nowOsd - (osdNav.vLastNav || 0) >= padState.repeatMs
          ) {
            osdSel = Math.max(0, Math.min(osdItems.length - 1, osdSel + v));
            sfx.nav();
            osdNav.vLastNav = nowOsd;
          }
        }
        osdNav.vDir = v;
        // Horizontal: D-pad 14/15 or left-stick X → adjust the focused control.
        let h = 0;
        if (dirs.left) h = -1;
        else if (dirs.right) h = 1;
        else { const ax = pad.axes[0] ?? 0; if (ax < -PAD_DEADZONE) h = -1; else if (ax > PAD_DEADZONE) h = 1; }
        const hReal = h;
        if (h === 0 && osdNav.hDir !== 0 && nowOsd - (osdNav.hSeenAt || 0) < 80) h = osdNav.hDir;
        if (hReal !== 0) osdNav.hSeenAt = nowOsd;
        if (h !== 0 && h !== osdNav.hDir) adjustOsd(osdSel, h);
        osdNav.hDir = h;
        if (justPressed(0)) { lastInput = 'pad'; activateOsd(osdSel); }  // FBTN_BOTTOM
        else if (justPressed(1) || justPressed(8)) osdBack(); // FBTN_RIGHT or Select (Cheats → root → close)
        // FBTN_LEFT / FBTN_TOP (X/Y) adjust the focused slider/color row down/up.
        // On Android Chrome + SNES the D-pad doesn't report and axes[0] is dead,
        // so without these a slider could only ever increase (A clamps at max).
        // X/Y exist on every SNES-class pad and are otherwise unused in the Guide.
        if (justPressed(2) || justPressed(3)) {
          const it = osdItems[osdSel];
          if (it && (it.kind === 'slider' || it.kind === 'color')) {
            adjustOsd(osdSel, justPressed(2) ? -1 : 1);
          }
        }
        padState.btn = pressedNow;
        return;
      }

      // OSD closed: SELECT + Down opens it (SELECT + R is the SNES-adapter
      // fallback for pads whose D-pad isn't recognized; SELECT + L2 is the
      // Android chord, where R is remapped to L2 by the compat plugin).
      const dirs = readPadDirs(pad);
      const selectBtn = !!pad.buttons[8]?.pressed;
      const rShoulder = !!pad.buttons[5]?.pressed || !!pad.buttons[6]?.pressed;
      const dpadDown = dirs.down;
      const ayDown = (pad.axes[1] ?? 0) > PAD_DEADZONE;
      const combo = selectBtn && (dpadDown || ayDown || rShoulder);
      if (combo && !padState.comboLatched) { padState.comboLatched = true; openOsd(); }
      else if (!combo) padState.comboLatched = false;
      osdNav.vDir = 0; osdNav.hDir = 0;
      padState.btn = pressedNow;
      return;
    }
    if (!pad) { padState.btn.clear(); padState.axisDir = 0; padState.hAxisDir = 0; padState.rawDirPrev = 0; padState.selArmed = false; padState.selChordFired = false; if (padConnected) padConnected = false; return; }
    if (!padConnected) padConnected = true;
    // The .sav coverflow owns the pad while it is up — nothing may navigate
    // or launch underneath it. Same shape as the OSD branch above.
    if (savPickerOpen) { pollSavPickerPad(pad); return; }
    if (!padHadConnection) {
      padHadConnection = true;
      try { getAc()?.resume(); } catch (_) {}
      // One-shot diagnostic: log mapping/axes/button counts so non-standard
      // controllers (SNES → USB adapters, etc.) can be debugged remotely.
      try {
        console.log('[pad] connected:', pad.id, 'mapping:', pad.mapping,
          'axes:', pad.axes.length, 'buttons:', pad.buttons.length);
      } catch (_) {}
    }

    // Diagnostic: log the first time each individual button is pressed and
    // each individual axis crosses out of neutral, so we can see exactly which
    // indices a quirky browser/controller is using for D-pad. Capped per index
    // so a held button doesn't spam the console.
    for (let i = 0; i < pad.buttons.length; i++) {
      if (pad.buttons[i]?.pressed && !padSeenBtns.has(i)) {
        padSeenBtns.add(i);
        try { console.log(`[pad] button ${i} pressed`); } catch (_) {}
      }
    }
    for (let i = 0; i < pad.axes.length; i++) {
      const v = pad.axes[i];
      if (typeof v !== 'number') continue;
      // 0.4 * deadzone catches mild analog drift / partial D-pad pushes.
      // Cap at 1.05 to ignore "no input" sentinels like 1.28.
      if (Math.abs(v) > PAD_DEADZONE * 0.4 && Math.abs(v) <= 1.05 && !padSeenAxes.has(i)) {
        padSeenAxes.add(i);
        try { console.log(`[pad] axes[${i}] active, value=${v.toFixed(3)}`); } catch (_) {}
      }
    }

    const now = performance.now();
    // Detect vertical input across as many layouts as we've seen:
    //   - Standard mapping: D-pad on buttons 12 / 13.
    //   - Firefox non-standard: D-pad often shifts past the face buttons
    //     (button indices 16-19, or different ordering).
    //   - Analog stick Y on axes[1] (or axes[3] / axes[5] on some pads).
    //   - axes[7]: digital -1/0/+1 D-pad Y on some adapters.
    //   - axes[9]: encoded hat switch on others.
    // SNES pads: trust only the plugin-normalized 12/13 — the raw slots past
    // 15 can hold Select/Start on some platforms, which made Select/Start
    // scroll the launcher.
    const isSnesPad = SNES_PAD_RE.test(pad?.id || '');
    // Standard-mapping pads end at 12/13: on a DualShock 4 the raw slots 16
    // and 17 are the PS button and the touchpad click, which read here as
    // phantom up/down (and doubled D-pad presses when a driver mirrors them).
    const trustRawSlots = pad.mapping !== 'standard' && !isSnesPad;
    const upButtonIdxs = trustRawSlots ? [12, 16, 18, 20] : [12];
    const downButtonIdxs = trustRawSlots ? [13, 17, 19, 21] : [13];
    const dpadUp = upButtonIdxs.some((i) => !!pad.buttons[i]?.pressed);
    const dpadDown = downButtonIdxs.some((i) => !!pad.buttons[i]?.pressed);
    let dir = 0;
    if (dpadUp) dir = -1;
    else if (dpadDown) dir = 1;
    if (dir === 0) {
      // Iterate candidate Y axes — bail on the first one that's clearly off-neutral.
      const yAxes = [1, 3, 5, 7];
      for (const i of yAxes) {
        const v = pad.axes[i];
        if (typeof v !== 'number') continue;
        if (Math.abs(v) > 1.05) continue; // neutral sentinel (e.g. 1.28)
        if (v < -PAD_DEADZONE) { dir = -1; break; }
        if (v > PAD_DEADZONE) { dir = 1; break; }
      }
    }
    if (dir === 0) {
      // Hat-switch decode via the shared grid-validated decoder — a raw
      // angle read here decoded an untouched axes[9] of exactly 0 as a
      // constant "down".
      const hat = decodePadHat(pad.axes[9]);
      if (hat.up) dir = -1;
      else if (hat.down) dir = 1;
    }
    // Nintendo theme: the catalog lists are a horizontal coverflow row, so
    // D-pad / stick left/right navigate them as prev/next too. Not on the games
    // screen — there left/right belongs to the emulator strip in every theme
    // (see the horizontal block below), and the coverflow keeps up/down.
    if (dir === 0 && !gameOn && tweaks.theme === 'nintendo' && screen !== 'dashboard' && !navHasH()) {
      if (pad.buttons[14]?.pressed) dir = -1;       // standard-mapping D-pad left
      else if (pad.buttons[15]?.pressed) dir = 1;   // standard-mapping D-pad right
      if (dir === 0 && !isSnesPad) {
        for (const i of [0, 2, 4, 6]) {             // candidate X axes
          const v = pad.axes[i];
          if (typeof v !== 'number' || Math.abs(v) > 1.05) continue;
          if (v < -PAD_DEADZONE) { dir = -1; break; }
          if (v > PAD_DEADZONE) { dir = 1; break; }
        }
      }
      if (dir === 0) {
        const hat = decodePadHat(pad.axes[9]);
        if (hat.left) dir = -1;
        else if (hat.right) dir = 1;
      }
    }

    // While SELECT is held the D-pad must not navigate, and SELECT's own
    // Back action lives on its release edge (below) — the OSD open-chord
    // (SELECT + Down, in-game) and the historical launcher chords depend on
    // the hold being inert. The .sav shelf now opens on FBTN_TOP (Y /
    // triangle) instead of the old SELECT + Up chord.
    const selHeld = !!pad.buttons[8]?.pressed;
    if (selHeld) {
      padState.rawDirPrev = dir;
      dir = 0;
      // Neutralize the direction latches too: the bounce filter below would
      // otherwise resurrect a pre-chord press from them for up to 80ms and
      // navigate under the held SELECT.
      padState.axisDir = 0;
      padState.hAxisDir = 0;
    } else {
      padState.rawDirPrev = dir;
    }

    // Bounce/dropout filter: a one-or-two-frame neutral blip in the middle of
    // a press (contact bounce, or duplicate pad entries alternating state)
    // re-fires the edge nav, which reads as several presses per tap. Hold the
    // last direction through sub-80ms dropouts so only a real release
    // re-arms the edge.
    const realDir = dir; // pre-filter read — only a real direction re-arms the window
    if (dir === 0 && padState.axisDir !== 0 && now - padState.dirSeenAt < 80) {
      dir = padState.axisDir;
    }
    // Re-arm the dropout window from a REAL read only. Refreshing it from the
    // synthesized hold kept every release inside the 80ms window frame after
    // frame, so a single tap latched the direction and hold-repeat fired
    // forever — until another direction replaced it. (SNES / Switch Pro pads.)
    if (realDir !== 0) padState.dirSeenAt = now;

    // A stalled frame (heavy re-render, tab jank) can make one tap look like a
    // long hold: the next poll arrives with heldFor already past the repeat
    // threshold and fires a phantom repeat. Restart hold timing after any gap
    // long enough that the intervening pad state was unobserved.
    const frameGap = now - (padState.lastPollAt || now);
    padState.lastPollAt = now;
    if (frameGap > 200) padState.holdingSince = now;

    if (dir !== 0 && dir !== padState.axisDir) {
      // Edge-triggered nav, rate-limited: bounce trains with gaps past the
      // dropout window otherwise land as several distinct edges per tap.
      // A fresh edge wraps at the list ends (see navMove).
      if (now - padState.lastNavAt >= 150 || padState.lastNavAt === 0) {
        if (dir < 0) navUp(true); else navDown(true);
        padState.lastNavAt = now;
      }
      padState.holdingSince = now;
    } else if (dir !== 0 && dir === padState.axisDir) {
      const heldFor = now - padState.holdingSince;
      const sinceLast = now - padState.lastNavAt;
      if (heldFor >= padState.initialDelayMs && sinceLast >= padState.repeatMs) {
        if (dir < 0) navUp(); else navDown();
        padState.lastNavAt = now;
      }
    }
    padState.axisDir = dir;

    // ── Horizontal axis (emulator strip) ─────────────────────────────────
    // Its own edge + hold-repeat state so a diagonal press can't cross-fire
    // between the strip and the row list. Only polled on a screen that
    // declares moveH, so nothing else pays for it.
    let hdir = 0;
    if (!gameOn && navHasH() && !selHeld) {
      if (pad.buttons[14]?.pressed) hdir = -1;      // standard-mapping D-pad left
      else if (pad.buttons[15]?.pressed) hdir = 1;  // standard-mapping D-pad right
      if (hdir === 0 && !isSnesPad) {
        for (const i of [0, 2, 4, 6]) {             // candidate X axes
          const v = pad.axes[i];
          if (typeof v !== 'number' || Math.abs(v) > 1.05) continue;
          if (v < -PAD_DEADZONE) { hdir = -1; break; }
          if (v > PAD_DEADZONE) { hdir = 1; break; }
        }
      }
      if (hdir === 0) {
        const hat = decodePadHat(pad.axes[9]);
        if (hat.left) hdir = -1;
        else if (hat.right) hdir = 1;
      }
    }
    const realHdir = hdir;
    if (hdir === 0 && padState.hAxisDir !== 0 && now - padState.hDirSeenAt < 80) {
      hdir = padState.hAxisDir;
    }
    if (realHdir !== 0) padState.hDirSeenAt = now;
    if (frameGap > 200) padState.hHoldingSince = now;
    if (hdir !== 0 && hdir !== padState.hAxisDir) {
      if (now - padState.hLastNavAt >= 150 || padState.hLastNavAt === 0) {
        navMoveH(hdir);
        padState.hLastNavAt = now;
      }
      padState.hHoldingSince = now;
    } else if (hdir !== 0 && hdir === padState.hAxisDir) {
      const heldFor = now - padState.hHoldingSince;
      const sinceLast = now - padState.hLastNavAt;
      if (heldFor >= padState.initialDelayMs && sinceLast >= padState.repeatMs) {
        navMoveH(hdir);
        padState.hLastNavAt = now;
      }
    }
    padState.hAxisDir = hdir;

    const pressedNow = new Set();
    pad.buttons.forEach((btn, i) => { if (btn?.pressed) pressedNow.add(i); });
    const justPressed = (i) => pressedNow.has(i) && !padState.btn.has(i);
    if (justPressed(0) || justPressed(9)) actFbtnBottom(); // FBTN_BOTTOM or Start
    if (justPressed(1)) actFbtnRight();                    // FBTN_RIGHT
    // FBTN_TOP (Y / triangle) opens the highlighted row's .sav shelf — the
    // one-button replacement for the old SELECT + Up chord.
    if (justPressed(3)) {
      if (openSavPickerForRow()) lastInput = 'pad';
    }
    // SELECT backs out on its RELEASE edge, so SELECT + Up can chord (above)
    // without Back firing the moment SELECT goes down. Only a press that
    // began in this branch arms it — a release inherited from the in-game or
    // picker branches must not fire a stray Back.
    if (justPressed(8)) padState.selArmed = true;
    if (padState.btn.has(8) && !pressedNow.has(8)) {
      if (padState.selArmed && !padState.selChordFired) actFbtnRight();
      padState.selArmed = false;
      padState.selChordFired = false;
    }
    // Shoulder/trigger navigation — fallback when D-pad isn't recognized
    // (e.g. Firefox + non-standard SNES adapters). Safe for SNES pads too:
    // the compat plugin guarantees normalized 6/7 are either real L2/R2
    // triggers or cleared (the joydev layout's Select/Start move to 8/9).
    // On Android Chrome the SNES pad's R arrives remapped to L2 (see the
    // compat plugin), and the D-pad doesn't report — so there L/L2 are the
    // primary up/down navigation rather than L2 jumping to the top.
    if (justPressed(5)) navDown();                  // R shoulder
    if (justPressed(4)) navUp();                    // L shoulder
    if (justPressed(7)) navBottom();                // R2 — jump to bottom
    if (justPressed(6)) {                           // L2
      if (IS_ANDROID && isSnesPad) navDown();
      else navTop();
    }
    padState.btn = pressedNow;
  }

  function unlockAudio() { try { getAc()?.resume(); } catch (e) { /* ignore */ } }

  function onKey(e) {
    lastInput = 'key';
    // The picker's search field is the only place in the app that wants raw
    // keystrokes, and the branch below spends Space, f, b, Backspace, the
    // arrows and Home/End on picker nav — inside a text field every one of
    // those is a character or a caret move. Bail before completePendingFullscreen
    // too, or the first letter typed cashes in a pad's pending R3 and throws the
    // browser into fullscreen. SavPicker's own onkeydown answers the keys the
    // field needs (Escape, Enter, ArrowDown).
    // An ALLOW-list of text-entry types, not a deny-list of the rest: the OSD's
    // volume rows are <input type="range"> and the BYOD button an <input
    // type="file">, and a focused one of those must keep driving the launcher —
    // a deny-list would have to name every such type, and miss the next one.
    const t = e.target;
    const typing = !!t && (t.isContentEditable || t.tagName === 'TEXTAREA' ||
      (t.tagName === 'INPUT' && /^(text|search|url|tel|email|password|number)$/.test(t.type)));
    if (typing) return;
    completePendingFullscreen();
    // The .sav coverflow owns the keyboard while it is up (launcher only —
    // it can never be open over a running game).
    if (savPickerOpen) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); savPickerMove(-1); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); savPickerMove(1); }
      else if (e.key === 'PageUp') { e.preventDefault(); savPickerJump(savPickerSel - 10); }
      else if (e.key === 'PageDown') { e.preventDefault(); savPickerJump(savPickerSel + 10); }
      else if (e.key === 'Home') { e.preventDefault(); savPickerJump(0); }
      else if (e.key === 'End') { e.preventDefault(); savPickerJump((savShelf?.length || 1) - 1); }
      // Ctrl/Cmd+F keeps f as favorite: the search field is opened deliberately
      // (/, ⌘F, the ⌕ button, or a tap), never by a stray letter — type-ahead
      // would have to steal f, Space, b and Backspace from the bindings below.
      else if (e.key === '/' || ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F'))) {
        e.preventDefault();
        if (!savFindOpen) savToggleFind();
      }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleSavFav(savPickerSel); }
      else if (e.key === '[') { e.preventDefault(); savBandStep(-1); }
      else if (e.key === ']') { e.preventDefault(); savBandStep(1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); launchSavGame(savPickerSel); }
      else if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'b' || e.key === 'B') { e.preventDefault(); savFindEscape(); }
      return;
    }
    // Nintendo theme lays the catalog lists out as a horizontal coverflow row,
    // so left/right arrows navigate them too (up/down keeps working). Skipped on
    // a screen that owns the horizontal axis itself — the games screen's strip
    // takes left/right in every theme.
    if (!gameOn && tweaks.theme === 'nintendo' && screen !== 'dashboard' && !navHasH() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      onKey({
        key: e.key === 'ArrowLeft' ? 'ArrowUp' : 'ArrowDown',
        repeat: e.repeat, // preserved so held keys clamp instead of wrapping
        preventDefault: () => e.preventDefault(),
        stopImmediatePropagation: () => e.stopImmediatePropagation?.(),
      });
      return;
    }
    if (gameOn) {
      if (osdOpen) {
        // Keyboard nav of the OSD (mirrors the gamepad mapping).
        if (e.key === 'ArrowDown') { osdSel = Math.min(osdSel + 1, osdItems.length - 1); sfx.nav(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { osdSel = Math.max(osdSel - 1, 0); sfx.nav(); e.preventDefault(); }
        else if (e.key === 'ArrowLeft') { adjustOsd(osdSel, -1); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { adjustOsd(osdSel, 1); e.preventDefault(); }
        else if (e.key === 'Enter' || e.key === ' ') { activateOsd(osdSel); e.preventDefault(); }
        else if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'b' || e.key === 'B' || e.code === 'Backquote' || e.key === '`' || e.key === '~') { osdBack(); e.preventDefault(); }
        return;
      }
      // The ` / ~ key (Backquote) and Escape open the OSD — a keyboard stand-in
      // for the SELECT + Down gamepad chord, usable when no gamepad is detected
      // (e.g. Flatpak Chrome under Steam). play.html posts tg16-toggle-controls
      // back when the game iframe holds focus instead.
      if (e.code === 'Backquote' || e.key === '`' || e.key === '~' || e.keyCode === 192 || e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        openOsd();
        return;
      }
      return;
    }
    // Keyboard and gamepad route through the same navUp/navDown/activate so
    // the two input paths cannot drift.
    const s = SCREEN_DEFS[screen];
    if (!s) return;
    // preventDefault on the vertical pair too (the horizontal branch below always
    // did): a focused control inside a scrolling list — an uninstall ✕, a net
    // badge — otherwise gets the browser's native scroll on top of the move.
    if (e.key === 'ArrowDown') { e.preventDefault(); navDown(!e.repeat); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); navUp(!e.repeat); }
    else if (s.moveH && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      navMoveH(e.key === 'ArrowLeft' ? -1 : 1);
    }
    else if (e.key === 'Enter' || e.key === ' ') s.activate(s.sel());
    else if (
      screen !== 'dashboard' &&
      (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'b' || e.key === 'B' || e.key === 'c' || e.key === 'C')
    ) goBack();
  }

  // Inject a capture-phase OSD-trigger forwarder INTO a same-origin game frame.
  // Once a game grabs keyboard focus the launcher's own window listener goes
  // deaf, so a listener living inside the frame is the only thing that still
  // sees ` / ~ / Esc. Cross-origin frames throw on contentWindow access and
  // are skipped here; those forward the key by postMessage instead (see below).
  function injectOsdKeyForwarder(e) {
    const iframe = e?.currentTarget || document.getElementById('gameframe');
    if (!iframe) return;
    // Origin pre-check (see frameIsSameOrigin): probing a cross-origin frame
    // throws a catchable error but still logs a console "Blocked a frame …".
    if (!frameIsSameOrigin(iframe)) return;
    try {
      const w = iframe.contentWindow;
      if (!w || w.__cmgOsdForwarder) return;
      w.__cmgOsdForwarder = true;
      w.addEventListener('keydown', (ev) => {
        if (ev.code === 'Backquote' || ev.key === '`' || ev.key === '~' || ev.keyCode === 192 || ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          // osdBack (not closeOsd) so the in-frame ` / Esc gesture matches the
          // window + gamepad handlers: back out of Cheats / dismiss an open
          // music player before closing the Guide.
          if (osdOpen) osdBack(); else { osdOpenedByTouch = false; openOsd(); }
        }
      }, true);
    } catch (_) { /* cross-origin frame — can't inject; it must postMessage instead */ }
  }

  // Stamp the launcher-detection contract (ported from
  // codemonkey-games-launcher; see lib/launcher-inject.ts) into a same-origin
  // game frame: window.__CMG_LAUNCHER__ / window.__CMG__ globals, the
  // data-cmg-launcher attribute, and the "inLauncher" class on <html> and
  // <body>. Games hide their own standalone chrome with CSS like
  // `.inLauncher #info { display:none !important; }`. The primary stamp is
  // server-side: a middleware in main.ts injects the marker into every
  // /games/* and /demos/* HTML response, which also covers packaged launchers
  // that load built-ins from the deploy origin (cross-origin frames this
  // function can't reach). This client-side stamp is the belt-and-braces pass
  // for same-origin frames whose HTML skipped the middleware (e.g. a game
  // page cached before the marker shipped). All paths are idempotent, as is
  // a game's own self-detection (e.g. static/demos/akuma.js). Truly external
  // cross-origin games rely on their host serving the marker, or on the
  // cmg-in-launcher message below: an externally hosted build that can't be
  // stamped from here (pacman-halloween-2025's streamUrl copy, which hides its
  // logo off .inLauncher) adds the class itself when told.
  function injectLauncherMarkerIntoFrame(e) {
    const iframe = e?.currentTarget || document.getElementById('gameframe');
    if (!iframe) return;
    if (!frameIsSameOrigin(iframe)) {
      try {
        iframe.contentWindow?.postMessage({ type: 'cmg-in-launcher', value: true }, '*');
      } catch (_) { /* ignore */ }
      return;
    }
    try {
      const w = iframe.contentWindow;
      if (!w) return;
      w.__CMG_LAUNCHER__ = true;
      if (!w.__CMG__) {
        try { w.__CMG__ = Object.freeze({ launcher: true, name: 'cmg' }); } catch (_) { /* ignore */ }
      }
      const doc = w.document;
      doc.documentElement.setAttribute('data-cmg-launcher', '1');
      doc.documentElement.classList.add('inLauncher');
      if (doc.body) doc.body.classList.add('inLauncher');
    } catch (_) { /* cross-origin frame — can't stamp from here */ }
  }

  // The level editor frame gets no .osd-corner overlay zones (they'd swallow
  // taps on its toolbar corners — see editorFrameActive), so the two-finger
  // corner gestures are detected from INSIDE the frame instead: passive
  // capture-phase pointer listeners on the frame's window map presses in the
  // corner regions (same min(13vmin, 104px) squares as the CSS zones) onto the
  // launcher's cornerDown/cornerUp state. Unlike the overlay zones these don't
  // eat the events, so the editor UI underneath keeps working. Editor URLs are
  // hard-guarded same-origin (sanitizeLevelEditor), so injection always works.
  function injectEditorCornerGesture(e) {
    if (!editorFrameActive) return;
    const iframe = e?.currentTarget || document.getElementById('gameframe');
    if (!iframe || !frameIsSameOrigin(iframe)) return;
    try {
      const w = iframe.contentWindow;
      if (!w || w.__cmgCornerGesture) return;
      w.__cmgCornerGesture = true;
      const cornersAt = (ev) => {
        const s = Math.min(0.13 * Math.min(w.innerWidth, w.innerHeight), 104);
        const L = ev.clientX <= s, R = ev.clientX >= w.innerWidth - s;
        const T = ev.clientY <= s, B = ev.clientY >= w.innerHeight - s;
        const c = [];
        if (B && L) c.push('bl');
        if (T && R) c.push('tr');
        return c;
      };
      const held = new Map(); // pointerId -> corners pressed by that pointer
      w.addEventListener('pointerdown', (ev) => {
        if (osdOpen) return;
        const c = cornersAt(ev);
        if (!c.length) return;
        held.set(ev.pointerId, c);
        for (const k of c) cornerDown(k, ev);
      }, true);
      const release = (ev) => {
        const c = held.get(ev.pointerId);
        if (!c) return;
        held.delete(ev.pointerId);
        for (const k of c) cornerUp(k);
      };
      w.addEventListener('pointerup', release, true);
      w.addEventListener('pointercancel', release, true);
    } catch (_) { /* frame navigated cross-origin — zones stay suppressed, gesture unavailable */ }
  }

  function onWindowMessage(e) {
    // Identify our own mounted game frame by window reference. That comparison
    // holds even for a cross-origin game (window identities compare across
    // origins) — unlike the origin string — which lets a cross-origin game
    // (e.g. monkey-kombat) forward its OSD key here. A page we didn't mount
    // can't be e.source, so this alone is a strong guard for benign signals.
    const iframe = document.querySelector('.game-iframe iframe');
    if (!iframe || e.source !== iframe.contentWindow) return;
    const sameOrigin = !e.origin || e.origin === window.location.origin;
    const d = e?.data || {};
    // Benign, idempotent UI signals — safe to honor from our own frame at any
    // origin (worst case the Guide menu just opens).
    if (d.type === 'tg16-toggle-controls') {
      // ` / ~ inside the focused game frame (see the snippet a cross-origin
      // game posts) — toggle the OSD so the in-game menu (incl. Exit) stays
      // reachable even when no gamepad is seen. osdBack (not closeOsd)
      // mirrors the window/gamepad back-gesture: Cheats-back before closing
      // the Guide.
      if (osdOpen) osdBack(); else openOsd();
      return;
    }
    if (d.type === 'tg16-first-touch') { chromeDismissed = true; return; }
    if (d.type === 'cmg-cheats') {
      // The running game advertises the boot-time URL-param cheats it honours,
      // which the Guide turns into a Cheats submenu. Benign — worst case it
      // shows toggles that reload the same game — so accept it from our own
      // frame at any origin (like tg16-toggle-controls). Payload is sanitized.
      osdCheats = sanitizeCheats(d.cheats);
      return;
    }
    if (d.type === 'cmg-plugins') {
      // The running game advertises the live toggles it supports, which the
      // Guide renders inline as a Plugins section. Benign — worst case it shows
      // a toggle whose cmg-plugin-set reply the game ignores — so accept it from
      // our own frame at any origin (like cmg-cheats). Payload is sanitized.
      // Unlike cheats (whose value is re-derived from the iframe URL each render),
      // a plugin's value is held here, so the OSD is its source of truth after
      // boot. Preserve the current value for any id we already track and take the
      // game-advertised value only for new ids — that way a re-advertise (boot
      // re-broadcast, scene restart) can't silently revert a user's toggle.
      const prev = new Map(osdPlugins.map((p) => [p.id, p.value]));
      osdPlugins = sanitizePlugins(d.plugins).map((p) =>
        prev.has(p.id) ? { ...p, value: prev.get(p.id) } : p
      );
      return;
    }
    if (d.type === 'cmg-twinstick') {
      // The running game advertises Twin-Stick support (optionally with a
      // default). Benign — worst case a toggle appears whose effect the game
      // ignores — so accept it from our own frame at any origin, like
      // cmg-cheats. A saved per-game choice or an in-session user toggle
      // always wins over the advertised default.
      twinStickAvail = true;
      if (!twinStickUserSet) {
        let on = d.default !== false;
        try {
          const saved = twinGameId ? localStorage.getItem(twinStickKey(twinGameId)) : null;
          if (saved !== null) on = saved === '1';
        } catch (_) { /* ignore */ }
        twinStickOn = on;
      }
      applyTwinStick();
      return;
    }
    if (d.type === 'cmg-touchcontrols') {
      // The running game advertises an on-screen touch pad (optionally with a
      // default). Same trust posture as cmg-twinstick — benign, worst case a
      // toggle appears whose cmg-touchcontrols-set reply the game ignores. A
      // saved per-game choice or an in-session user toggle wins over the
      // advertised default.
      touchCtlAvail = true;
      if (!touchCtlUserSet) {
        let on = d.default !== false;
        try {
          const saved = touchCtlGameId ? localStorage.getItem(touchCtlKey(touchCtlGameId)) : null;
          if (saved !== null) on = saved === '1';
        } catch (_) { /* ignore */ }
        touchCtlOn = on;
      }
      applyTouchControls();
      // reply with the skin too, so the game's pad can match it
      applyGameTheme();
      return;
    }
    if (d.type === 'cmg-actions') {
      // The running game advertises momentary OSD buttons (e.g. "Controls"),
      // which the Guide renders inline in the Game section. Benign — worst case
      // it shows a button whose cmg-action reply the game ignores — so accept it
      // from our own frame at any origin (like cmg-plugins). Payload is sanitized.
      osdActions = sanitizeActions(d.actions);
      return;
    }
    if (d.type === 'cmg-theme' || d.type === 'cmg-scanlines') {
      // The level editor's Display section syncs the launcher's look in real
      // time. Benign, idempotent UI tweaks — same trust posture as the other
      // cmg-* capability signals — and values are validated before applying.
      if (d.type === 'cmg-theme' && (d.theme === 'xbox' || d.theme === 'xbox360' || d.theme === 'nintendo')) setTweak('theme', d.theme);
      if (d.type === 'cmg-scanlines') setTweak('scanlines', !!d.value);
      return;
    }
    if (d.type === 'cmg-level-editor') {
      // The running game advertises that it ships a level editor. The Guide
      // shows an "Edit Levels" button that swaps the frame to /editor/. Benign
      // and same-origin-guarded in sanitizeLevelEditor (only a /editor… path is
      // ever honored), so accept it from our own frame at any origin like the
      // other cmg-* capability signals. `twinGameId` is the id of the launched
      // game, used to derive the editor's ?game= when none is given.
      osdLevelEditor = sanitizeLevelEditor(d, twinGameId);
      return;
    }
    if (d.type === 'cmg-ex') {
      // The running game advertises an extra playable build (see osdExtras).
      // Benign — worst case the Guide gains a row that swaps the iframe to a
      // page the frame could already have navigated itself to — so accept it
      // from our own frame at any origin (like cmg-cheats). Payload sanitized.
      const ex = sanitizeEx(d);
      if (ex) osdExtras = [...osdExtras.filter((x) => x.url !== ex.url), ex].slice(0, 4);
      return;
    }
    // Sensitive actions — closing the game — stay same-origin only; never
    // honor them from a cross-origin frame.
    if (!sameOrigin) return;
    if (d.type === 'tg16-exit') closeGame();
  }

  onMount(() => {
    // 12-hour wall clock, the way the phone's own status bar reads it — the
    // HUD is set dressing, not a mission timer.
    const tick = () => {
      const d = new Date();
      const h24 = d.getHours();
      const h = String(h24 % 12 || 12);
      const m = String(d.getMinutes()).padStart(2, '0');
      const s = String(d.getSeconds()).padStart(2, '0');
      const ap = h24 < 12 ? 'AM' : 'PM';
      clockStr = h + ':' + m + ':' + s + ' ' + ap;
      clockShort = h + ':' + m + ' ' + ap;
    };
    tick();
    clockTimer = setInterval(tick, 1000);

    isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;

    sfx.boot();
    document.addEventListener('click', unlockAudio, { once: true });
    bootTimer = setTimeout(() => { bootGone = true; }, 1600);

    window.addEventListener('keydown', onKey);
    // Capture phase so lastInput is already correct by the time the resulting
    // click reaches a row handler (Osd rows activate on click, not pointerdown).
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('message', onWindowMessage);
    window.addEventListener('gamepadconnected', onPadConnect);
    window.addEventListener('gamepaddisconnected', onPadDisconnect);
    refreshPadConnected();
    padRaf = requestAnimationFrame(pollPad);

    loadManifest();
    initNetplayPresence();
    initEmulators();
  });

  function refreshPadConnected() {
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    let any = false;
    for (const p of pads) { if (p && p.connected) { any = true; break; } }
    padConnected = any;
  }
  function onPadConnect() { padHadConnection = true; refreshPadConnected(); }
  function onPadDisconnect() { refreshPadConnected(); }
  // A pen counts as a pointer the player is aiming by hand, like touch — only a
  // real mouse earns the cursor back in the Controller Layout.
  function onPointerDown(e) {
    lastInput = e.pointerType === 'mouse' ? 'mouse' : 'touch';
    completePendingFullscreen();
  }

  // ── R3 → fullscreen ──────────────────────────────────────────────────────
  // One-way on purpose: R3 also reaches games as a normal button, so letting it
  // toggle would drop players out of fullscreen mid-game.
  //
  // The shipped launchers (--kiosk) and the desktop shell already fill the
  // screen at the window-manager level, where the Fullscreen API reports
  // nothing — document.fullscreenElement is null even though there is nothing
  // to gain. Comparing the viewport against the screen catches that case too,
  // so R3 stays a no-op there instead of firing a doomed request every press.
  function isEffectivelyFullscreen() {
    if (document.fullscreenElement) return true;
    const sw = window.screen?.width;
    const sh = window.screen?.height;
    return !!(sw && sh && window.innerWidth >= sw - 2 && window.innerHeight >= sh - 2);
  }

  // Chrome only grants fullscreen with transient user activation, and a gamepad
  // press does not count as one (verified: the promise rejects with
  // "Permissions check failed" and navigator.userActivation.isActive is false).
  // So the pad press records the intent and the next real gesture — a click, a
  // key — cashes it in. In kiosk/desktop builds none of this runs.
  let fullscreenWanted = false;

  function requestFullscreenFromPad() {
    if (isEffectivelyFullscreen()) { fullscreenWanted = false; return; }
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try {
      const p = req.call(el);
      if (p && p.catch) p.catch(() => { fullscreenWanted = true; });
    } catch (_) { fullscreenWanted = true; }
  }

  function completePendingFullscreen() {
    if (!fullscreenWanted) return;
    fullscreenWanted = false;
    if (isEffectivelyFullscreen()) return;
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try { const p = req.call(el); if (p && p.catch) p.catch(() => {}); } catch (_) {}
  }

  $effect(() => {
    if (padConnected) document.body.classList.add('pad-on');
    else document.body.classList.remove('pad-on');
  });

  // ── Cursor policy ────────────────────────────────────────────────────────
  // The pointer only belongs on a keyboard-and-mouse desk. A touchscreen or a
  // gamepad means it is dead weight parked over the game, so hide it. A pad
  // counts from the moment it is seen at all — pollPad sets padConnected on the
  // first frame a pad object appears, which in Chrome is the first button
  // press, since it withholds the pad until then.
  //
  // The exception lives in CSS: body.cfg-mouse, set while the Controller Layout
  // was reached by an actual mouse click. It is scoped to the no-pad case —
  // body.pad-on overrides it — so once a gamepad is connected the pointer stays
  // hidden even there, and that panel is driven by its own pad path instead.
  $effect(() => {
    document.body.classList.toggle('no-cursor', isTouch || padConnected);
  });

  $effect(() => {
    // While a game iframe is active, gamepad-support.js routes gamepad → keyboard
    // into iframe#gameframe. It only dispatches when body.playing is set.
    if (gameOn) document.body.classList.add('playing');
    else document.body.classList.remove('playing');
  });

  // Reflect OSD visibility on <body> so gamepad-support.js's isAnyOverlayOpen()
  // yields gamepad→key input to the game while the Guide is open.
  $effect(() => {
    if (osdOpen) document.body.classList.add('osd-open');
    else document.body.classList.remove('osd-open');
  });

  // Apply the Look tweaks to the dashboard chrome (and the OSD, via the shared
  // CSS vars). Persisted in setTweak(); re-applied whenever they change.
  $effect(() => {
    const root = document.documentElement;
    const nintendo = tweaks.theme === 'nintendo';
    const xbox360 = tweaks.theme === 'xbox360';
    document.body.classList.toggle('theme-nintendo', nintendo);
    document.body.classList.toggle('theme-xbox360', xbox360);
    if (nintendo || xbox360) {
      // The Nintendo and Xbox 360 skins are fixed palettes (body.theme-* in
      // dashboard.css) — drop the inline hue overrides so they win.
      for (const p of ['--green-glow', '--green', '--tile-edge', '--green-deep']) {
        root.style.removeProperty(p);
      }
    } else if (!tweaks.discoMode) {
      const h = tweaks.hue;
      root.style.setProperty('--green-glow', `oklch(0.78 0.26 ${h})`);
      root.style.setProperty('--green', `oklch(0.86 0.22 ${h})`);
      root.style.setProperty('--tile-edge', `oklch(0.78 0.22 ${h} / 0.55)`);
      root.style.setProperty('--green-deep', `oklch(0.4 0.18 ${h})`);
    }
    root.style.setProperty('--breathe-mult', String(tweaks.breatheSpeed));
    document.body.classList.toggle('no-scan', !tweaks.scanlines);
  });

  // Disco mode — cycle the glow hue while enabled.
  $effect(() => {
    if (!tweaks.discoMode || tweaks.theme === 'nintendo' || tweaks.theme === 'xbox360') return;
    let h = tweaks.hue;
    const root = document.documentElement;
    const id = setInterval(() => {
      h = (h + 4) % 360;
      root.style.setProperty('--green-glow', `oklch(0.78 0.26 ${h})`);
      root.style.setProperty('--green', `oklch(0.86 0.22 ${h})`);
      root.style.setProperty('--tile-edge', `oklch(0.78 0.22 ${h} / 0.55)`);
    }, 120);
    return () => clearInterval(id);
  });

  onDestroy(() => {
    if (clockTimer) clearInterval(clockTimer);
    if (bootTimer) clearTimeout(bootTimer);
    if (toastTimer) clearTimeout(toastTimer);
    rowPressCancel();
    if (padRaf) cancelAnimationFrame(padRaf);
    document.removeEventListener('click', unlockAudio);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('message', onWindowMessage);
    endStripDrag();
    window.removeEventListener('gamepadconnected', onPadConnect);
    window.removeEventListener('gamepaddisconnected', onPadDisconnect);
    document.body.classList.remove('playing');
    document.body.classList.remove('pad-on');
    document.body.classList.remove('osd-open');
  });
</script>

{#if !bootGone}
  <!-- Boot flash: the blocky voxel X. Square source, centred on its own canvas,
       so the mark sits dead centre in the flash. -->
  <div class="boot"><img class="b-glyph" src="/x-logo.png" alt="" /></div>
{/if}

<div class="field" aria-hidden="true">
  <svg class="mesh" viewBox="-500 -500 1000 1000" preserveAspectRatio="xMidYMid slice">
    <defs>
      <radialGradient id="fade" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="rgba(120,255,90,0.0)" />
        <stop offset="55%" stop-color="rgba(120,255,90,0.5)" />
        <stop offset="100%" stop-color="rgba(120,255,90,0.0)" />
      </radialGradient>
    </defs>
    <g stroke="url(#fade)" stroke-width="1" fill="none" opacity="0.6">
      <ellipse cx="0" cy="0" rx="120" ry="42" />
      <ellipse cx="0" cy="0" rx="180" ry="62" />
      <ellipse cx="0" cy="0" rx="240" ry="86" />
      <ellipse cx="0" cy="0" rx="310" ry="115" />
      <ellipse cx="0" cy="0" rx="380" ry="146" />
      <ellipse cx="0" cy="0" rx="450" ry="180" />
    </g>
    <g stroke="url(#fade)" stroke-width="0.6" fill="none" opacity="0.35">
      <line x1="-500" y1="0" x2="500" y2="0" />
      <line x1="0" y1="-200" x2="0" y2="200" />
      <line x1="-440" y1="-160" x2="440" y2="160" />
      <line x1="440" y1="-160" x2="-440" y2="160" />
      <line x1="-250" y1="-180" x2="250" y2="180" />
      <line x1="250" y1="-180" x2="-250" y2="180" />
    </g>
  </svg>
  <svg class="mesh2" viewBox="-500 -500 1000 1000" preserveAspectRatio="xMidYMid slice">
    <g stroke="rgba(120,255,90,0.16)" stroke-width="0.5" fill="none">
      <ellipse cx="0" cy="0" rx="150" ry="380" transform="rotate(20)" />
      <ellipse cx="0" cy="0" rx="150" ry="380" transform="rotate(70)" />
      <ellipse cx="0" cy="0" rx="150" ry="380" transform="rotate(120)" />
      <ellipse cx="0" cy="0" rx="150" ry="380" transform="rotate(170)" />
    </g>
  </svg>
</div>

<div class="noise"></div>
<div class="scan"></div>
<div class="vignette"></div>

<div class="stage">
  <div class="topbar">
    <div class="brand">
      <span class="dot"></span>
      <span>codemonkey.games</span>
    </div>
    <div class="right">
      <!-- Two clocks, one shown at a time by width: the HUD line is already
           crowded on a phone, and "10:27:18 PM" wrapping between the seconds
           and the meridiem looks broken. Narrow screens get the short one. -->
      <span class="clock full">{clockStr}</span>
      <span class="clock short">{clockShort}</span>
      <span>core stable</span>
      <span>sys ▮▮▮▮▮▮▮▱</span>
    </div>
  </div>

  <div class="dashboard {screen === 'dashboard' ? '' : 'gone'}">
    <div class="orb-wrap">
      <div class="orb">
        <div class="ring c"></div>
        <div class="ring b"></div>
        <div class="ring a"></div>
        <div class="core"></div>
        <div class="glyph">🐵</div>
      </div>
    </div>
    <div class="menu" role="menu" aria-label="Main menu">
      {#each MAIN_MENU as m, i (m.id)}
        <div
          class="item {i === menuSel ? 'sel' : ''}"
          role="menuitem"
          tabindex="-1"
          onmouseenter={() => { if (i !== menuSel) { menuSel = i; sfx.nav(); } }}
          onclick={() => pickMenu(i)}
          onkeydown={chipKeyHandler(() => pickMenu(i))}
        >
          <span class="tag">{m.tag}</span>
          <div class="node"></div>
          <div class="bar">
            <span>{m.label}</span>
            <span class="num">{m.num}</span>
          </div>
        </div>
      {/each}
    </div>
  </div>

  <!-- The catalog and every emulator library on one screen. The strip across
       the top selects a section (SECTIONS in the script); the disc panel and
       the row list under it follow it. Sections used to be separate screens
       reached through submenu rows — everything they rendered is now this one
       block driven by the section descriptor. -->
  <div class="games-screen games-screen-strip {screen === 'games' ? 'shown' : ''}">
    <div class="games-panel {stripShown ? 'with-strip' : ''}">
      {#if !stripShown}
        <!-- Nothing to switch between: the panel drops the strip's grid row and
             wears the same absolutely-positioned header line every other
             single-section screen uses. -->
        <div class="strip-top">
          <span>{curSection.coreA}</span>
          <span>{curSection.coreB}</span>
          <span>{clockStr}</span>
        </div>
      {:else}
      <div class="strip-block">
        <div class="strip-head">
          <span class="strip-label {stripFocus ? 'on' : ''}">library</span>
          <span>{stripCounter} · {stripHint}</span>
          <span class="strip-core push">{curSection.coreA}</span>
          <span class="strip-core">{curSection.coreB}</span>
          <span class="strip-core">{clockShort}</span>
        </div>

        <div
          class="cmg-strip {stripFocus ? 'on' : ''}"
          role="tablist"
          aria-label="Libraries"
          tabindex="-1"
          bind:this={stripEl}
          onwheel={onStripWheel}
          onpointerdown={onStripDown}
        >
          {#each SECTIONS as s, i (s.id)}
            <div
              bind:this={tileEls[i]}
              class="strip-tile {i === secSel ? 'active' : ''} {stripFocus && i === secSel ? 'sel' : ''}"
              style="animation-delay: {(i % 4) * -1.1}s"
              role="tab"
              aria-selected={i === secSel}
              tabindex="-1"
              onclick={() => onTileClick(i)}
              onkeydown={chipKeyHandler(() => onTileClick(i))}
              onmouseenter={() => { if (!(stripFocus && i === secSel)) pickSection(i); }}
            >
              <div class="strip-disc">
                <div class="glass">
                  {#if s.icon}
                    <img src={s.icon} alt={s.name} />
                  {:else}
                    <span class="mark {s.mark.length > 3 ? 'long' : ''}">{s.mark}</span>
                  {/if}
                </div>
              </div>
              <div class="strip-name">{s.name}</div>
            </div>
          {/each}
        </div>
      </div>
      {/if}

      <div class="disc-col">
        <div class="disc"></div>
        <div class="meta">
          <div><span class="k">name</span><b>{metaName}</b></div>
          <div><span class="k">size</span><b>{metaSize}</b></div>
          <div><span class="k">type</span><b>{metaType}</b></div>
          <div><span class="k">date</span><b>{metaDate}</b></div>
        </div>
      </div>

      <div class="games-right">
        <div class="games-header">
          <div class="title-bar {stripOn ? 'dim' : ''}">{curSection.title}</div>
          <div class="counter">{counterText}</div>
          {#if curSection.add}
            <button type="button" class="add-btn" onclick={curSection.add.run}>
              <span class="add-btn-icon">{curSection.add.icon}</span>
              <span>{curSection.add.label}</span>
            </button>
          {/if}
        </div>
        <div class="games-list" bind:this={gameListEl}>
          <!-- One picker for whichever section is showing. Rendered outside the
               empty-state branch because the pinned-row sections (Arcade, NES)
               need it with a full list too. -->
          {#if curSection.picker}
            <input
              type="file"
              bind:this={byodInputEl}
              multiple={!!curSection.picker.multiple}
              accept={curSection.picker.accept}
              onchange={curSection.picker.onchange}
              class="byod-input"
            />
          {/if}

          {#if sectionEmpty && curSection.byod}
            <div class="byod">
              <div class="byod-title">{curSection.byod.title}</div>
              <div class="byod-sub">{curSection.byod.pre}<code>{curSection.byod.path}</code>{curSection.byod.post}</div>
              {#if curSection.picker}
                <button
                  type="button"
                  class="byod-btn"
                  bind:this={byodBtnEl}
                  onclick={() => { try { byodInputEl?.click(); } catch (_) {} }}
                >
                  <span class="byod-btn-icon">⬆</span>
                  <span>{curSection.byod.btn}</span>
                </button>
              {/if}
              <div class="byod-hint">
                {#each curSection.byod.hint as line}
                  <div>{#each line as tok}{#if typeof tok === 'string'}{tok}{:else}<code>{tok.code}</code>{/if}{/each}</div>
                {/each}
              </div>
              {#if curSection.err}
                <div class="byod-err">{curSection.err}</div>
              {/if}
            </div>
          {:else}
            <!-- The breathe stagger comes off the row index rather than the
                 :nth-child pairs .game-row carries for the other screens: the
                 hidden file picker above is child 1 on every console section
                 and would slide the whole pattern along by a row. -->
            {#each curRows as r, i (r.key)}
              <div
                bind:this={gameRowEls[i]}
                class="game-row {r.pinned ? 'byoc-row' : ''} {!stripOn && i === curSel ? 'sel' : ''}"
                style="animation-delay: {i % 3 === 0 ? -2.4 : i % 2 === 0 ? -1.2 : 0}s"
                role="button"
                tabindex="-1"
                onmouseenter={() => { if (stripOn || i !== curSel) { stripFocus = false; curSection.setSel(i); sfx.nav(); } }}
                onclick={() => { if (consumeRowPress()) return; stripFocus = false; curSection.setSel(i); curSection.activate(i); }}
                onkeydown={chipKeyHandler(() => { stripFocus = false; curSection.setSel(i); curSection.activate(i); })}
                oncontextmenu={(e) => onRowContextMenu(e, r, i)}
                onpointerdown={(e) => rowPressStart(e, r, i)}
                onpointermove={(e) => rowPressMove(e)}
                onpointerup={(e) => rowPressEnd(e)}
                onpointercancel={(e) => rowPressEnd(e)}
                onpointerleave={(e) => rowPressEnd(e)}
              >
                {#if r.submenu}
                  <!-- Category rows get a folder-of-discs instead of the single
                       glass disc, so "a collection of games" reads at a glance and
                       the leading submenu block is visually distinct from the game
                       rows under it. Purely decorative — the row's title carries
                       the name — hence aria-hidden. -->
                  <div class="submenu-icon" aria-hidden="true">
                    <span class="submenu-art">
                      <span class="folder"></span>
                      <span class="sub-disc sub-disc-back"></span>
                      <span class="sub-disc sub-disc-front"></span>
                    </span>
                  </div>
                {:else}
                  <div class="game-icon">
                    <div class="glass">
                      {#if r.icon}
                        <img src={r.icon} alt={r.name} onerror={(e) => onIconError(e, r.name)} />
                      {:else}
                        <span class="ph">{r.pinned ? '⬆' : initial(r.name)}</span>
                      {/if}
                    </div>
                  </div>
                {/if}
                <div class="game-bar">
                  <span class="name">{r.title}</span>
                  {#if rowHasSavPicker(r)}
                    <!-- The row owns a shelf of ready-to-play .sav games: in
                         place of the subtitle, a stack of cartridge spines
                         says so at a glance, and on the highlighted row it
                         grows the count plus the way in (Y on a pad,
                         tapping the badge otherwise). The badge is its own
                         click target — browsing the shelf and launching the
                         row stay separate gestures. -->
                    <div
                      class="shelf-badge {!stripOn && i === curSel ? 'lit' : ''}"
                      role="button"
                      tabindex="-1"
                      aria-label="Browse the game shelf"
                      onclick={(e) => { e.stopPropagation(); if (consumeRowPress()) return; stripFocus = false; curSection.setSel(i); openSavPicker(r.g); }}
                      onkeydown={chipKeyHandler(() => { stripFocus = false; curSection.setSel(i); openSavPicker(r.g); })}
                      onpointerdown={(e) => e.stopPropagation()}
                      oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); if (!savPickerOpen) { stripFocus = false; curSection.setSel(i); openSavPicker(r.g); } }}
                    >
                      <span class="shelf-spines" aria-hidden="true"><i></i><i></i><i></i></span>
                      <span class="shelf-copy">
                        <b>SHELF</b>
                        <em>{savLibrary?.length ? `${savLibrary.length} GAMES` : 'browse'}</em>
                      </span>
                      {#if !stripOn && i === curSel && padConnected}
                        <span class="shelf-key" aria-hidden="true">Y</span>
                      {/if}
                    </div>
                  {:else}
                    <span class="sub">{r.sub}</span>
                  {/if}
                  <!-- Outside the shelf/sub branches on purpose: the shmupX row
                       renders a shelf badge INSTEAD of a sub, and that is
                       precisely the row a live run belongs on. -->
                  {#if liveFor(r)}
                    <b class="live-chip" class:open={liveFor(r).joinable}>
                      {liveFor(r).joinable ? 'LIVE · OPEN' : 'LIVE'}
                    </b>
                  {/if}
                </div>
              </div>
            {/each}
            {#if curSection.err}
              <div class="byod-err">{curSection.err}</div>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  </div>

  <!-- Settings — entered from the main menu. -->
  <div class="games-screen {screen === 'settings' ? 'shown' : ''}">
    <div class="games-panel">
      <div class="strip-top">
        <span>sys // config</span>
        <span>settings</span>
        <span>{clockStr}</span>
      </div>
      <div class="disc-col">
        <div class="disc"></div>
        <div class="meta">
          <div><span class="k">section</span><b>{SETTINGS_ITEMS[settingsSel]?.label ?? '—'}</b></div>
          <div><span class="k">state</span><b>READY</b></div>
          <div><span class="k">unit</span><b>SHMUPX DASHBOARD</b></div>
        </div>
      </div>
      <div class="games-right">
        <div class="games-header">
          <div class="title-bar">SETTINGS</div>
          <div class="counter">{settingsCounterText}</div>
        </div>
        <div class="games-list">
          {#each SETTINGS_ITEMS as it, i (it.id)}
            <div
              bind:this={settingsRowEls[i]}
              class="game-row {i === settingsSel ? 'sel' : ''}"
              role="button"
              tabindex="-1"
              onmouseenter={() => { if (i !== settingsSel) { settingsSel = i; sfx.nav(); } }}
              onclick={() => activateSettings(i)}
              onkeydown={chipKeyHandler(() => activateSettings(i))}
            >
              <div class="game-icon"><div class="glass"><span class="ph">◧</span></div></div>
              <div class="game-bar">
                <span class="name">{it.label}</span>
                <span class="sub">{it.sub}</span>
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>

  <!-- Emulators — opt-in downloads, reached from Settings. Installing a core
       appends its section to the strip on the catalog screen; until then
       nothing of it is fetched at all. -->
  <div class="games-screen {screen === 'emulators' ? 'shown' : ''}">
    <div class="games-panel">
      <div class="strip-top">
        <span>sys // emulators</span>
        <span>{installedCores.length} / {emuCores.length} installed</span>
        <span>{clockStr}</span>
      </div>
      <div class="disc-col">
        <div class="disc net"></div>
        <div class="meta">
          <div><span class="k">core</span><b>{emuCurrent?.name ?? '—'}</b></div>
          <div><span class="k">size</span><b>{emuCurrent?.size ?? '—'}</b></div>
          <div><span class="k">type</span><b>{emuCurrent?.metaType ?? '—'}</b></div>
          <div><span class="k">state</span><b>{emuStateLabel}</b></div>
        </div>
      </div>
      <div class="games-right">
        <div class="games-header">
          <div class="title-bar">EMULATORS</div>
          <div class="counter">{emuCounterText}</div>
        </div>
        <div class="games-list">
          {#each emuCores as c, i (c.id)}
            <div
              bind:this={emuRowEls[i]}
              class="game-row {i === emuSel ? 'sel' : ''}"
              role="button"
              tabindex="-1"
              onmouseenter={() => { if (i !== emuSel) { emuSel = i; sfx.nav(); } }}
              onclick={() => activateEmulator(i)}
              onkeydown={chipKeyHandler(() => activateEmulator(i))}
            >
              <div class="game-icon">
                <div class="glass">
                  <!-- A core's icon is mirrored with the rest of it, so an
                       uninstalled row has nothing to point at yet and wears its
                       type-mark instead. -->
                  {#if c.icon && emuInstalled.includes(c.id)}
                    <img src={c.icon} alt={c.name} onerror={(e) => onIconError(e, c.name)} />
                  {:else}
                    <span class="ph">{c.mark}</span>
                  {/if}
                </div>
              </div>
              <div class="game-bar">
                <span class="name">{c.name}</span>
                <span class="sub">{c.size} · {c.coreA}</span>
              </div>
              <span class="net-badge {emuBadge(c).cls}">{emuBadge(c).text}</span>
              {#if emuInstalled.includes(c.id)}
                <!-- stopPropagation: the row's own click installs/uninstalls, so
                     without it the ✕ would fire the row handler too. -->
                <button
                  type="button"
                  class="uninstall-btn"
                  title="Uninstall {c.name}"
                  onclick={(e) => { e.stopPropagation(); emuSel = i; sfx.back(); uninstallCore(c.id); }}
                >✕</button>
              {/if}
            </div>
          {/each}
          {#if !emuCores.length}
            <div class="byod">
              <div class="byod-title">CATALOGUE UNAVAILABLE</div>
              <div class="byod-sub">Could not read <code>{EMU_CATALOG}</code>. Check the connection and reopen this screen.</div>
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>

  {#if screen !== 'dashboard'}
    <div class="footer left tap" role="button" tabindex="0" onpointerup={tapHandler(goBack)} onkeydown={chipKeyHandler(goBack)}>
      <div class="btn-hint b">B</div>
      <span>Back</span>
    </div>
  {/if}
  <div class="footer tap" role="button" tabindex="0" onpointerup={tapHandler(actFbtnBottom)} onkeydown={chipKeyHandler(actFbtnBottom)}>
    <div class="btn-hint">A</div>
    <span>{screen === 'games' ? gamesActionLabel : screen === 'emulators' ? emuActionLabel : 'Select'}</span>
  </div>
</div>

<!-- Only mount the overlay while a game is active. Leaving a navigated,
     full-screen iframe in the DOM (even hidden via opacity:0 + pointer-events:none)
     keeps a touch/scroll-capturing region over the games list on mobile WebKit,
     which kills swipe-scroll after returning to the menu. gameSrc stays set for
     500ms after closeGame() so the fade-out still plays before it unmounts. -->
{#if gameSrc}
  <div class="game-iframe {gameOn ? 'on' : ''}">
    <iframe
      id={gameOn ? 'gameframe' : undefined}
      src={gameSrc}
      title="game"
      allow="autoplay; fullscreen; gamepad; xr-spatial-tracking"
      onload={(e) => { try { const l = e.currentTarget.contentWindow.location; frameUrl = l.pathname + l.search; } catch (_) { frameUrl = null; } injectLauncherMarkerIntoFrame(e); injectOsdKeyForwarder(e); injectEditorCornerGesture(e); applyTwinStick(); applyTouchControls(); applyGameTheme(); postVolume(); }}
    ></iframe>
  </div>
{/if}

{#if gameOn && twinStickAvail && twinStickOn && twinTouchOn && gameFramePatchable && !osdOpen}
  <div class="twin-touch-zone left" aria-hidden="true"
       onpointerdown={(e) => twinTouchStart(e, 'left')}
       onpointermove={(e) => twinTouchMove(e, 'left')}
       onpointerup={(e) => twinTouchEnd(e, 'left')}
       onpointercancel={(e) => twinTouchEnd(e, 'left')}>
    {#if twinTouch.left.active}
      <span class="twin-touch-base" style={`left:${twinTouch.left.ox}px;top:${twinTouch.left.oy}px`}></span>
      <span class="twin-touch-knob" style={`left:${twinTouch.left.ox + twinTouch.left.x * TWIN_TOUCH_RADIUS}px;top:${twinTouch.left.oy + twinTouch.left.y * TWIN_TOUCH_RADIUS}px`}></span>
    {/if}
  </div>
  <div class="twin-touch-zone right" aria-hidden="true"
       onpointerdown={(e) => twinTouchStart(e, 'right')}
       onpointermove={(e) => twinTouchMove(e, 'right')}
       onpointerup={(e) => twinTouchEnd(e, 'right')}
       onpointercancel={(e) => twinTouchEnd(e, 'right')}>
    {#if twinTouch.right.active}
      <span class="twin-touch-base" style={`left:${twinTouch.right.ox}px;top:${twinTouch.right.oy}px`}></span>
      <span class="twin-touch-knob" style={`left:${twinTouch.right.ox + twinTouch.right.x * TWIN_TOUCH_RADIUS}px;top:${twinTouch.right.oy + twinTouch.right.y * TWIN_TOUCH_RADIUS}px`}></span>
    {/if}
  </div>
{/if}

<!-- In-game OSD trigger: two-finger bottom-left + top-right tap. Small corner
     hit-zones layered above the game iframe, rendered only while a game is up
     and the OSD is closed. (Gamepad opens it with SELECT + Down; keyboard with
     ` or Esc.) Suppressed while the level editor is the active frame — its
     toolbar/grid has controls in all four corners the zones would swallow;
     the same gestures are detected in-frame instead (injectEditorCornerGesture). -->
{#if gameOn && !osdOpen && !editorFrameActive}
  <div class="osd-corner bl" aria-hidden="true"
       onpointerdown={(e) => cornerDown('bl', e)} onpointerup={() => cornerUp('bl')}
       onpointercancel={() => cornerUp('bl')} onpointerleave={() => cornerUp('bl')}></div>
  <div class="osd-corner tr" aria-hidden="true"
       onpointerdown={(e) => cornerDown('tr', e)} onpointerup={() => cornerUp('tr')}
       onpointercancel={() => cornerUp('tr')} onpointerleave={() => cornerUp('tr')}></div>
{/if}

<!-- Nintendo theme: NES-cabinet bottom bar, ported from
     codemonkey-games-launcher (gray console shell + logo + vent boxes).
     Pure chrome — hidden while a game is running. -->
{#if tweaks.theme === 'nintendo' && !gameOn}
  <div class="nes-bar" aria-hidden="true">
    <div class="nes-bar-top">
      <img class="nes-logo" src="/nes-logo.png" alt="" />
      <div class="nes-box"></div>
    </div>
    <div class="nes-bar-mid"><div class="nes-box"><div class="nes-line"></div></div></div>
    <div class="nes-bar-bottom"><div class="nes-box"><div class="nes-line"></div></div></div>
  </div>
{/if}

{#if padDebugOn}
  <pre class="pad-debug">{padDebugText}</pre>
{/if}

{#if toastMsg}
  <div class="cmg-toast" role="status">{toastMsg}</div>
{/if}

<SavPicker open={savPickerOpen} items={savShelf || []} sel={savPickerSel}
     favs={savFavs} onfav={toggleSavFav}
     covers={savCovers} loading={savLibraryLoading} error={savLibraryErr}
     bands={savBands} query={savQuery} findOpen={savFindOpen}
     onquery={(q) => { savQuery = q; }} onfind={savToggleFind} onescape={savFindEscape}
     onband={(b) => savBandJump(b)}
     onscrub={(on) => { savScrubbing = on; }}
     onselect={(i) => savPickerJump(i)} onlaunch={(i) => launchSavGame(i)}
     onclose={closeSavPicker} />

<Osd open={osdOpen} items={osdItems} sel={osdSel} theme={tweaks.theme}
     clock={clockStr} title={currentGame?.title || currentGame?.name || ''}
     hint={osdHint}
     onactivate={activateOsd} onsetvalue={setOsdValue}
     onselect={(i) => (osdSel = i)} onclose={closeOsd} />
