/* VOXEL3D_RUNTIME — Phaser 4.2.1 dual-mode (2D vertical shooter / 3D super
 * scaler) runtime for Voxel 3D exports from the CMG Level Editor.
 *
 * Receives DATA = { name, recipe, atlas: { frames, imageDataURL }, uiAtlas,
 * backgrounds: { "0".."4": dataURL }, sounds: { key: dataURL }, startStage,
 * voxelMeta: { pixelSize, yaw, pitch, depth } } where every atlas frame is a
 * Pixel Composer voxelized render of the original sprite (pitch/yaw 10). Frame
 * entries carry sourceSize = the ORIGINAL sprite dimensions, so gameplay
 * sizing/scale cancels the voxel inflation (rendered frame is ~pixelSize×
 * bigger than the source art).
 *
 * Rendering uses Phaser 4.2's new WebGL pipeline instead of a hand-rolled 2D
 * canvas: the super-scaler ground plane is a Mesh2D (the 4.2 textured-triangle
 * game object — Phaser 4 has no scene-level 3D camera; Mesh2D + projection
 * math IS its 3D toolkit), and all sprites are pooled Images placed through a
 * perspective projection. The same world-space simulation (ported from the
 * editor's GAME3D_RUNTIME super-scaler export) drives both view modes:
 *   3d — Burning Force style rail shooter (default)
 *   2d — top-down vertical shooter (the original game's view)
 * Toggle with the M key, the on-screen MODE button, or ?mode=2d|3d.
 *
 * The function is serialized with .toString() into the exported HTML, so it
 * must stay fully self-contained (only Phaser + DATA from outside).
 */
window.VOXEL3D_RUNTIME = function VOXEL3D_RUNTIME(DATA) {
  'use strict';

  // ================== CONFIG (mirrors GAME3D_RUNTIME) ==================
  const W = 480, H = 320;               // logical resolution
  const HY = 96;                        // horizon screen y (3D)
  const BY = H - 26;                    // ground line at the player plane (3D)
  const FOCAL = 140;                    // perspective focal length
  const ZMAX = 1600;                    // spawn depth
  const SPR = 1.5;                      // sprite world scale (source px -> world units)
  const LANE_W = 56;                    // world width of one grid column
  const GROUND_TILE_W = 512;            // world width covered by one bg tile
  const Z2TEX = 0.55;                   // world z units -> bg texture pixels
  const PLAYER_ALT = 34;
  const AIR_ALT = 52;
  const STEP_MS = 8.333333;             // 120Hz fixed step, d=1 per step
  const MAX_FRAME_MS = 66.67;
  const WAVE_INTERVAL = 80;
  const CA_MAX = 100;
  const AIR_NAMES = { soliderA: 1, soliderB: 1, soliderC: 1 };
  const ITEM_BY_CODE = { 1: 'big', 2: '3way', 3: 'speed_high', 9: 'barrier' };
  const ITEM_PREFIX = { big: 'powerupBig', '3way': 'powerup3way', speed_high: 'speedupItem', barrier: 'barrierItem' };

  // 2D (vertical shooter) view: centered playfield column, far z at top.
  const F2D = { w: 300, top: 24, bottom: H - 22, kx: 150 / 210, scale: 0.85 };

  const R = DATA.recipe || {};
  const VOXMETA = DATA.voxelMeta || { pixelSize: 4, yaw: 10, pitch: 10, depth: 6 };
  const MAX_STAGE = (function () {
    let n = -1;
    for (const k in R) { const m = /^stage(\d+)$/.exec(k); if (m && R[k] && R[k].enemylist) n = Math.max(n, +m[1]); }
    return n < 0 ? 0 : n;
  })();

  // ================== FRAME TABLE ==================
  const frames = (DATA.atlas && DATA.atlas.frames) || {};
  const frameKeyCache = {};
  function frameKey(key) {
    if (!key) return null;
    if (frameKeyCache[key] !== undefined) return frameKeyCache[key];
    let k = null;
    if (frames[key]) k = key;
    else {
      const alt1 = String(key).replace(/\.gif$/, '.png');
      const alt2 = String(key).replace(/\.png$/, '.gif');
      if (frames[alt1]) k = alt1;
      else if (frames[alt2]) k = alt2;
    }
    frameKeyCache[key] = k;
    return k;
  }
  // Original (pre-voxelization) sprite size for gameplay/scale math.
  function srcSize(key) {
    const k = frameKey(key);
    if (!k) return null;
    const fd = frames[k];
    const ss = fd.sourceSize || (fd.frame ? { w: fd.frame.w, h: fd.frame.h } : null);
    return ss;
  }
  // Display scale factor that cancels voxel inflation: rendered frame is
  // frame.w px wide but represents a sourceSize.w px sprite.
  function voxScale(key) {
    const k = frameKey(key);
    if (!k) return 1;
    const fd = frames[k];
    if (!fd.frame || !fd.sourceSize || !fd.frame.w) return 1;
    return fd.sourceSize.w / fd.frame.w;
  }
  function framesByPrefix(prefix) {
    const out = [];
    for (const k in frames) {
      const m = new RegExp('^' + prefix + '(\\d+)\\.(gif|png)$').exec(k);
      if (m) out.push({ k: k, n: +m[1] });
    }
    out.sort(function (a, b) { return a.n - b.n; });
    return out.map(function (o) { return o.k; });
  }
  let EXPLOSION_FRAMES = [], SP_EXPLOSION_FRAMES = [], ITEM_FRAMES = {};

  const uiFrames = (DATA.uiAtlas && DATA.uiAtlas.frames) || {};
  function uiKey(key) {
    if (uiFrames[key]) return key;
    const alt = String(key).replace(/\.gif$/, '.png');
    return uiFrames[alt] ? alt : null;
  }

  // ================== SOUND (plain Audio pools, independent of Phaser) ==================
  const soundBank = {};
  (function () {
    const s = DATA.sounds || {};
    for (const k in s) { if (s[k]) soundBank[k] = s[k]; }
  })();
  const VOL = { se_shoot: 0.25, se_shoot_b: 0.25, se_explosion: 0.35, se_damage: 0.2, se_guard: 0.25,
    g_damage_voice: 0.7, g_powerup_voice: 0.6, se_ca: 0.8, se_ca_explosion: 0.8,
    se_barrier_start: 0.8, se_barrier_end: 0.8, g_ca_voice: 0.7 };
  const sndPool = {};
  function play(key) {
    const src = soundBank[key];
    if (!src) return;
    const pool = sndPool[key] || (sndPool[key] = []);
    let a = null;
    for (let i = 0; i < pool.length; i++) if (pool[i].paused || pool[i].ended) { a = pool[i]; break; }
    if (!a) {
      if (pool.length >= 4) { a = pool[0]; }
      else { a = new Audio(src); a.volume = VOL[key] != null ? VOL[key] : 0.6; pool.push(a); }
    }
    try { a.currentTime = 0; a.play().catch(function () {}); } catch (e) { /* ignore */ }
  }

  // Looping BGM. Each stage plays its boss theme from stage start (the 2019-es7
  // model has no separate ambient track). Sources are data-URLs (small default
  // assets bundled by the exporter) or remote CDN URLs (large custom BGM left
  // by reference); either plays through a single looping HTMLAudioElement. This
  // is view-independent, so music plays in both the 2D and 3D/EX views. First
  // playback rides the start gesture (Enter/tap), satisfying autoplay policy.
  const bgmSources = (DATA.bgm && DATA.bgm.stages) || {};
  let bgmAudio = null, bgmSrc = null;
  function stopBgm() {
    if (bgmAudio) { try { bgmAudio.pause(); } catch (e) { /* ignore */ } }
    bgmAudio = null; bgmSrc = null;
  }
  function playBgm(src) {
    if (!src) { stopBgm(); return; }
    if (bgmSrc === src && bgmAudio && !bgmAudio.paused) return;
    stopBgm();
    try {
      bgmAudio = new Audio(src);
      bgmAudio.loop = true;
      bgmAudio.volume = 0.4;
      bgmAudio.play().catch(function () { /* retried on next stage/gesture */ });
      bgmSrc = src;
    } catch (e) { /* ignore */ }
  }
  function stageBgm() { playBgm(bgmSources[state.stageId] || bgmSources[0] || null); }

  // ================== VIEW MODE ==================
  let viewMode = (function () {
    const m = /[?&]mode=(2d|3d)/i.exec(location.search || '');
    return m ? m[1].toLowerCase() : '3d';
  })();
  function toggleMode() { viewMode = viewMode === '3d' ? '2d' : '3d'; }

  // ================== INPUT ==================
  const keys = {};
  let caRequested = false;
  let confirmEdge = false;
  window.addEventListener('keydown', function (e) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].indexOf(e.key) >= 0) e.preventDefault();
    keys[e.key] = true;
    if (e.key === ' ') caRequested = true;
    if (e.key === 'Enter' || e.key === ' ') confirmEdge = true;
    if (e.key === 'm' || e.key === 'M') toggleMode();
  });
  window.addEventListener('keyup', function (e) { keys[e.key] = false; });
  let dragTargetWx = null, lastTap = 0;
  const SP_BTN = { x: W - 42, y: H - 42, r: 21 };
  const MODE_BTN = { x: W - 34, y: 16, w: 56, h: 20 };

  // ================== 3D PROJECTION ==================
  let camX = 0;
  function proj(z) { return FOCAL / (FOCAL + Math.max(z, -FOCAL * 0.6)); }
  function groundY(z) { return HY + (BY - HY) * proj(z); }
  function screenX(wx, z) { return W / 2 + (wx - camX) * proj(z); }
  // 2D projection: z -> screen y (far at top), wx -> x in the center column.
  function z2y(z) { return F2D.bottom - (z / ZMAX) * (F2D.bottom - F2D.top); }
  function x2d(wx) { return W / 2 + wx * F2D.kx; }

  // ================== GAME STATE ==================
  const state = {
    mode: 'boot',            // boot | title | game | clear | gameover | ending
    stageId: 0,
    score: 0, hiScore: 0, combo: 0, maxCombo: 0, comboTimer: 0,
    cagage: 0, continueCnt: 0,
    frame: 0,
  };
  try { state.hiScore = +(localStorage.getItem('voxel3d_hiscore') || 0) || 0; } catch (e) { /* ignore */ }
  const startStage = (function () {
    const q = /[?&]stage=(\d+)/.exec(location.search || '');
    if (q) return Math.max(0, Math.min(MAX_STAGE, +q[1]));
    return Math.max(0, Math.min(MAX_STAGE, DATA.startStage || 0));
  })();

  let player, enemies = [], playerShots = [], enemyShots = [], items = [], fx = [], boss = null, waves = [];
  let scrollZ = 0, waveFrameCnt = 0, waveCount = 0, theWorld = false, worldTimer = 0;
  let bossTimer = 99, bossTimerMs = 0, bossTimerOn = false;
  let banner = null;
  let flashAlpha = 0, shake = 0, gameOverTimer = 0, clearTimer = 0, titleFrame = 0;
  let godMode = false;

  function anim(list, timer, speed) {
    if (!list || !list.length) return null;
    return list[Math.floor(timer * speed) % list.length];
  }

  // ================== SETUP / STAGE ==================
  function newRun() {
    state.score = 0; state.combo = 0; state.maxCombo = 0; state.cagage = 0; state.continueCnt = 0;
    state.stageId = startStage;
    const pd = R.playerData || {};
    player = {
      wx: 0, vx: 0, alt: PLAYER_ALT, hp: pd.maxHp || 3, maxHp: pd.maxHp || 3,
      shootMode: 'normal', speedBoost: 0, shootCnt: 0, animT: 0,
      barrierOn: false, barrierT: 0, invuln: 0, dead: false, deadT: 0,
      hitRingT: 0, nextInterval: 20,
    };
    startStageRun();
  }
  function startStageRun() {
    enemies = []; playerShots = []; enemyShots = []; items = []; fx = [];
    boss = null; bossTimerOn = false; bossTimer = 99; bossTimerMs = 0;
    waveFrameCnt = 0; waveCount = 0; theWorld = false; worldTimer = 0;
    scrollZ = 0;
    const sd = R['stage' + state.stageId];
    waves = sd && sd.enemylist ? sd.enemylist.slice().reverse() : [];
    banner = { kind: 'stage', n: state.stageId + 1, timer: 170 };
    play('g_stage_voice_' + state.stageId);
    stageBgm();
    state.mode = 'game';
  }

  // ================== SPAWNING ==================
  function spawnWaveRow(row) {
    for (let i = 0; i < 8 && i < row.length; i++) {
      const code = row[i];
      if (!code || code === '00' || typeof code !== 'string') continue;
      const def = (R.enemyData || {})['enemy' + code[0]];
      if (!def || !def.texture || !def.texture.length) continue;
      const isAir = !!AIR_NAMES[def.name];
      enemies.push({
        def: def, name: def.name || ('enemy' + code[0]),
        wx: (i - 3.5) * LANE_W, alt: isAir ? AIR_ALT : 0, z: ZMAX,
        vz: (def.speed || 0.7) * 3,
        hp: def.hp === 'infinity' ? Infinity : (def.hp || 1),
        score: def.score || 0, cagage: def.spgage != null ? def.spgage : (def.cagage || 0),
        interval: def.interval || -1, fireCnt: Math.random() * 40,
        itemName: ITEM_BY_CODE[code[1]] || null,
        animT: Math.random() * 100, posName: null, flash: 0, isAir: isAir,
        w: 32, h: 32, sized: false,
      });
    }
  }
  function sizeEntity(e, key) {
    const ss = srcSize(key);
    if (ss) { e.w = ss.w * SPR; e.h = ss.h * SPR; e.sized = true; }
  }
  function spawnBoss() {
    const bd = (R.bossData || {})['boss' + state.stageId];
    if (!bd || !bd.anim || !bd.anim.idle) { stageClear(); return; }
    makeBoss(bd, state.stageId === 3 && state.continueCnt === 0);
  }
  function makeBoss(bd, gokiFlg) {
    boss = {
      def: bd, name: bd.name || 'boss',
      wx: 0, alt: 40, z: ZMAX, targetZ: 360,
      hp: bd.hp === 'infinity' ? Infinity : (bd.hp || 100), maxHp: bd.hp || 100,
      score: bd.score || 0, cagage: bd.spgage || 0,
      animT: 0, entered: false, gokiFlg: !!gokiFlg, dying: 0,
      phase: null, phaseT: 0, animKey: 'idle', fireT: 0, homeZ: 360, warpX: 0,
      w: 90, h: 90, sized: false, flash: 0,
    };
  }
  // Projectile definitions. The 2019-es7 level model keeps enemy bullets in
  // `projectileData` and boss bullets in `projectileDataA`/`projectileDataB`
  // (older 2019-turbo data used `bulletData`). Read all three so both eras fire.
  function enemyProjDef(e) {
    const d = e && e.def;
    return (d && (d.projectileData || d.bulletData)) || fallbackProjDef();
  }
  function bossProjDef(which) {
    const d = boss && boss.def;
    if (d) {
      const a = d.projectileDataA || d.bulletData || d.projectileData;
      const b = d.projectileDataB || a;
      const pick = which === 'B' ? b : a;
      if (pick && pick.texture && pick.texture.length) return pick;
    }
    return fallbackProjDef();
  }
  let _fallbackProj = undefined;
  function fallbackProjDef() {
    if (_fallbackProj !== undefined) return _fallbackProj;
    const ed = R.enemyData || {}, bd = R.bossData || {};
    const scan = (o) => o && (o.projectileData || o.projectileDataA || o.bulletData);
    for (const k in ed) { const p = scan(ed[k]); if (p && p.texture && p.texture.length) return (_fallbackProj = p); }
    for (const k in bd) { const p = scan(bd[k]); if (p && p.texture && p.texture.length) return (_fallbackProj = p); }
    return (_fallbackProj = null);
  }

  // Low-level spawn: one bullet from (wx,alt,z) with velocity (vx,vz,va).
  function spawnBullet(pdef, wx, alt, z, vx, vz, va) {
    if (!pdef || !pdef.texture || !pdef.texture.length) return;
    enemyShots.push({
      tex: pdef.texture, wx: wx, alt: alt, z: z,
      vx: vx, vz: vz, va: va, damage: pdef.damage || 1, animT: 0, w: 18, h: 18,
    });
  }
  // Aim a shot from (wx,alt,z) at the player plane, offset by `spreadWx` world
  // units. vz is always toward the camera (negative), so bullets close in.
  function aimAtPlayer(pdef, wx, alt, z, sp, spreadWx) {
    const dz = -z, dx = (player.wx + (spreadWx || 0)) - wx, da = PLAYER_ALT - alt;
    const len = Math.sqrt(dz * dz + dx * dx + da * da) || 1;
    spawnBullet(pdef, wx, alt, z, dx / len * sp, dz / len * sp, da / len * sp);
  }

  // Enemy fire: a single shot on the enemy's own interval (as in the 2D game),
  // lightly aimed so it's dodgeable by sliding off the enemy's column.
  function fireEnemyShot(e) {
    const pdef = enemyProjDef(e);
    if (!pdef) return;
    const sp = Math.max(4, (pdef.speed || 1) * 6);
    aimAtPlayer(pdef, e.wx, e.alt + 10, e.z, sp, (player.wx - e.wx) * -0.5);
    play('se_shoot');
  }

  // Boss patterns (super-scaler reinterpretations of the 2019-es7 boss modules):
  // an aimed column-rake with projA, and a wide spray with projB. Bullet counts
  // are kept sane for the rail view (the 2D game's radial bursts were up to 72).
  function bossFireAimed(n, spreadWx) {
    const pdef = bossProjDef('A');
    if (!pdef) return;
    const sp = Math.max(4, (pdef.speed || 1) * 6);
    for (let i = 0; i < n; i++) {
      const off = n > 1 ? (i / (n - 1) - 0.5) * spreadWx : 0;
      aimAtPlayer(pdef, boss.wx, boss.alt + 12, boss.z, sp, off);
    }
    play('se_shoot');
  }
  function bossFireSpray(n) {
    const pdef = bossProjDef('B');
    if (!pdef) return;
    const sp = Math.max(3, (pdef.speed || 1) * 5);
    for (let i = 0; i < n; i++) {
      const ang = (i / (n - 1) - 0.5) * Math.PI * 0.9; // fan across the lane
      spawnBullet(pdef, boss.wx, boss.alt + 12, boss.z,
        Math.sin(ang) * sp, -Math.abs(Math.cos(ang)) * sp - 1, (PLAYER_ALT - boss.alt) * 0.02 * sp);
    }
    play('se_shoot');
  }
  // Boss "AI": each cycle rolls a random attack bucket (as the 2019-es7 bosses
  // do via a per-cycle seed) — warp/reposition, an aimed column rake (projA), a
  // lane-wide spray (projB), or a dive down the player's column — then drops to
  // idle before rolling again. Movement + the shoot/attack/warp/idle anim are
  // both driven here, so the boss reads as attacking in either view.
  function rollBossPhase() {
    const seed = Math.random();
    boss.fireT = 0;
    if (seed < 0.14) { boss.phase = 'warp'; boss.phaseT = 55; boss.animKey = 'warp'; boss.warpX = (Math.random() * 2 - 1) * 170; }
    else if (seed < 0.48) { boss.phase = 'rake'; boss.phaseT = 150; boss.animKey = 'shoot'; }
    else if (seed < 0.76) { boss.phase = 'spray'; boss.phaseT = 130; boss.animKey = 'shoot'; }
    else { boss.phase = 'dive'; boss.phaseT = 150; boss.animKey = 'attack'; }
  }
  function updateBossAI(d) {
    if (boss.homeZ == null) boss.homeZ = boss.targetZ;
    if (boss.phase == null) rollBossPhase();
    boss.phaseT -= d;
    boss.fireT += d;
    const approach = (tz, ta, twx, k) => {
      boss.z += (tz - boss.z) * k * d;
      boss.alt += (ta - boss.alt) * k * d;
      if (twx != null) boss.wx += (twx - boss.wx) * k * d;
    };
    if (boss.phase === 'warp') {
      boss.wx += (boss.warpX - boss.wx) * 0.25 * d;
      approach(boss.homeZ, 40, null, 0.08);
    } else if (boss.phase === 'rake') {
      boss.wx = Math.sin(boss.animT * 0.02) * 150;
      approach(boss.homeZ, 44, null, 0.06);
      if (boss.fireT >= 22) { boss.fireT = 0; bossFireAimed(2, 40); }
    } else if (boss.phase === 'spray') {
      approach(boss.homeZ - 30, 40, 0, 0.06);
      if (boss.fireT >= 34) { boss.fireT = 0; bossFireSpray(7); }
    } else if (boss.phase === 'dive') {
      if (boss.phaseT > 60) approach(150, 20, player.wx, 0.05);
      else approach(boss.homeZ, 42, null, 0.05);
      if (boss.fireT >= 28) { boss.fireT = 0; bossFireAimed(1, 0); }
    } else { // idle
      boss.wx = Math.sin(boss.animT * 0.012) * 120;
      approach(boss.homeZ, 34 + Math.sin(boss.animT * 0.03) * 12, null, 0.05);
    }
    if (boss.phaseT <= 0) {
      if (boss.phase === 'idle') rollBossPhase();
      else { boss.phase = 'idle'; boss.animKey = 'idle'; boss.phaseT = 34; }
    }
  }

  function playerShoot() {
    const pd = R.playerData || {};
    const mode = player.shootMode;
    let conf = mode === 'big' ? pd.shootBig : mode === '3way' ? pd.shoot3way : pd.shootNormal;
    if (!conf) conf = { texture: ['shot00.gif'], damage: 1, interval: 23 };
    const tex = (mode === '3way' && pd.shootNormal ? pd.shootNormal.texture : conf.texture) || ['shot00.gif'];
    const baseV = (conf.speed || (mode === 'big' ? 6 : 8)) * 3;
    const mk = function (vx) {
      playerShots.push({
        tex: tex, wx: player.wx, alt: player.alt + 6, z: 30, zPrev: 30,
        vx: vx, vz: baseV, damage: conf.damage || 1,
        big: mode === 'big', hitIds: {}, animT: 0,
      });
    };
    if (mode === '3way') { mk(-2.6); mk(0); mk(2.6); play('se_shoot'); }
    else if (mode === 'big') { mk(0); play('se_shoot_b'); }
    else { mk(0); play('se_shoot'); }
    const interval = (conf.interval || 23) - player.speedBoost;
    return Math.max(6, interval);
  }

  function dropItem(e) {
    if (!e.itemName) return;
    items.push({ name: e.itemName, wx: e.wx, alt: Math.max(20, e.alt), z: e.z, animT: 0, bob: Math.random() * 10 });
  }
  function addExplosion(wx, alt, z, big) {
    fx.push({ kind: 'boom', frames: big ? SP_EXPLOSION_FRAMES : EXPLOSION_FRAMES, wx: wx, alt: alt, z: z, t: 0, scale: big ? 1.6 : 1 });
    play(big ? 'se_ca_explosion' : 'se_explosion');
  }

  // ================== DAMAGE / SCORE ==================
  function addScore(pts, gage) {
    state.score += pts || 0;
    state.combo += 1; state.comboTimer = 240;
    if (state.combo > state.maxCombo) state.maxCombo = state.combo;
    state.cagage = Math.min(CA_MAX, state.cagage + (gage || 0));
    if (state.score > state.hiScore) {
      state.hiScore = state.score;
      try { localStorage.setItem('voxel3d_hiscore', String(state.hiScore)); } catch (e) { /* ignore */ }
    }
  }
  function killEnemy(e) {
    addScore(e.score, e.cagage);
    addExplosion(e.wx, e.alt + e.h / 4, e.z, false);
    dropItem(e);
    const idx = enemies.indexOf(e);
    if (idx > -1) enemies.splice(idx, 1);
  }
  function damageEnemy(e, dmg) {
    if (e.hp === Infinity) { e.flash = 8; play('se_guard'); return; }
    e.hp -= dmg;
    if (e.hp <= 0) {
      if (e === boss) bossDefeated();
      else killEnemy(e);
    } else { e.flash = 6; play('se_damage'); }
  }
  function damagePlayer(amount) {
    if (player.dead || player.invuln > 0 || godMode) return;
    if (player.barrierOn) { play('se_guard'); return; }
    player.hp = Math.max(0, player.hp - amount);
    player.hitRingT = 110;
    shake = 14;
    play('se_damage'); play('g_damage_voice');
    if (player.hp <= 0) {
      player.dead = true; player.deadT = 0;
      addExplosion(player.wx, player.alt + 10, 10, false);
      addExplosion(player.wx - 20, player.alt, 24, false);
      addExplosion(player.wx + 20, player.alt + 18, 30, false);
    } else {
      player.invuln = 120;
    }
  }
  function pickupItem(it) {
    play('g_powerup_voice');
    if (it.name === 'speed_high') player.speedBoost = 15;
    else if (it.name === 'barrier') { player.barrierOn = true; player.barrierT = ((R.playerData && R.playerData.barrier && R.playerData.barrier.time) || 4) * 120; play('se_barrier_start'); }
    else {
      if (player.shootMode !== it.name) player.speedBoost = 0;
      player.shootMode = it.name;
    }
  }
  function bossDefeated() {
    if (!boss || boss.dying) return;
    boss.dying = 1;
    bossTimerOn = false;
    theWorld = true; worldTimer = 200;
    addScore(boss.score, boss.cagage);
    enemyShots = [];
  }
  function stageClear() {
    state.mode = 'clear';
    clearTimer = 0;
    banner = null;
  }

  function caFire() {
    if (state.cagage < CA_MAX || theWorld || player.dead) return;
    state.cagage = 0;
    theWorld = true; worldTimer = 150;
    flashAlpha = 1;
    play('se_ca'); play('g_ca_voice');
    const dmg = (R.playerData && R.playerData.spDamage) || 50;
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      addExplosion(e.wx, e.alt + 10, e.z, true);
      damageEnemy(e, dmg);
    }
    if (boss && boss.entered && !boss.dying) {
      addExplosion(boss.wx, boss.alt + 30, boss.z, true);
      damageEnemy(boss, dmg);
    }
    enemyShots = [];
    for (let j = 0; j < 14; j++) {
      fx.push({ kind: 'boom', frames: SP_EXPLOSION_FRAMES, wx: (Math.random() - 0.5) * 400, alt: Math.random() * 80, z: 120 + Math.random() * 900, t: -j * 4, scale: 1.4 });
    }
  }

  // ================== UPDATE (fixed step, d = 1) ==================
  function update(d) {
    state.frame += d;
    if (state.mode === 'title') { titleFrame += d; scrollZ += 6 * d; if (anyConfirm()) newRun(); return; }
    if (state.mode === 'ending') { titleFrame += d; scrollZ += 3 * d; if (anyConfirm()) toTitle(); return; }
    if (state.mode !== 'game' && state.mode !== 'clear' && state.mode !== 'gameover') return;

    if (banner && (banner.timer -= d) <= 0) banner = null;
    if (flashAlpha > 0) flashAlpha = Math.max(0, flashAlpha - 0.04 * d);
    if (shake > 0) shake = Math.max(0, shake - d);
    if (state.comboTimer > 0) { state.comboTimer -= d; if (state.comboTimer <= 0) state.combo = 0; }

    if (state.mode === 'clear') {
      scrollZ += 9 * d;
      clearTimer += d;
      updateFx(d);
      if (clearTimer > 300) {
        state.stageId++;
        if (state.stageId > MAX_STAGE) { state.mode = 'ending'; titleFrame = 0; stopBgm(); }
        else startStageRun();
      }
      return;
    }

    if (state.mode === 'gameover') {
      gameOverTimer += d;
      updateFx(d);
      if (gameOverTimer > 90 && anyConfirm()) {
        state.continueCnt++;
        player.hp = player.maxHp; player.dead = false; player.invuln = 180;
        player.shootMode = 'normal'; player.speedBoost = 0;
        state.combo = 0;
        startStageRun();
      }
      return;
    }

    // ---- game mode ----
    if (theWorld) {
      worldTimer -= d;
      updateFx(d);
      if (boss && boss.dying) {
        boss.dying += d;
        if (boss.dying % 14 < d) addExplosion(boss.wx + (Math.random() - 0.5) * boss.w, boss.alt + Math.random() * boss.h / SPR, boss.z, false);
        if (boss.dying > 160) {
          addExplosion(boss.wx, boss.alt + 20, boss.z, true);
          const wasStage3 = state.stageId === 3;
          const wasVega = boss.name === 'vega';
          boss = null; theWorld = false;
          if (wasStage3 && wasVega && state.continueCnt === 0 && R.bossData && R.bossData.bossExtra) {
            makeBoss(R.bossData.bossExtra, false);
          } else stageClear();
        }
      } else if (worldTimer <= 0) theWorld = false;
      return;
    }

    scrollZ += 9 * d;

    // player
    if (!player.dead) {
      const accel = 3.2 * d;
      if (keys.ArrowLeft || keys.a || keys.A) player.vx -= accel;
      else if (keys.ArrowRight || keys.d || keys.D) player.vx += accel;
      else if (dragTargetWx !== null) player.vx += Math.max(-accel, Math.min(accel, (dragTargetWx - player.wx) * 0.08));
      else player.vx *= Math.pow(0.86, d);
      player.vx = Math.max(-7, Math.min(7, player.vx));
      player.wx += player.vx * d;
      if (player.wx < -210) { player.wx = -210; player.vx = 0; }
      if (player.wx > 210) { player.wx = 210; player.vx = 0; }
      player.animT += d;
      if (player.invuln > 0) player.invuln -= d;
      if (player.hitRingT > 0) player.hitRingT -= d;
      if (player.barrierOn) { player.barrierT -= d; if (player.barrierT <= 0) { player.barrierOn = false; play('se_barrier_end'); } }
      player.shootCnt += d;
      if (player.shootCnt >= (player.nextInterval || 20)) { player.nextInterval = playerShoot(); player.shootCnt = 0; }
      if (caRequested) { caFire(); }
    } else {
      player.deadT += d;
      if (player.deadT > 120) { state.mode = 'gameover'; gameOverTimer = 0; state.maxCombo = Math.max(state.maxCombo, state.combo); stopBgm(); }
    }
    caRequested = false;
    camX = player.wx * 0.62;

    // waves
    if (!boss) {
      waveFrameCnt += d;
      if (waveFrameCnt >= WAVE_INTERVAL) {
        waveFrameCnt = 0;
        if (waveCount >= waves.length) { if (enemies.length === 0) spawnBoss(); }
        else { spawnWaveRow(waves[waveCount]); waveCount++; }
      }
    }

    // enemies
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (!e.sized) sizeEntity(e, e.def.texture[0]);
      e.animT += d;
      if (e.flash > 0) e.flash -= d;
      e.z -= e.vz * d;
      if (e.name === 'soliderA') {
        if (e.z < ZMAX * 0.4) e.wx += 0.01 * (player.wx - e.wx) * d;
      } else if (e.name === 'soliderB') {
        if (e.posName === null && e.z < ZMAX * 0.9) e.posName = e.wx >= 0 ? 'right' : 'left';
        if (e.z < ZMAX * 0.6) e.wx += (e.posName === 'right' ? -1.4 : 1.4) * d;
      }
      if (e.interval > 0 && e.z < ZMAX * 0.85) {
        e.fireCnt += d;
        if (e.fireCnt >= e.interval) { e.fireCnt = 0; fireEnemyShot(e); }
      }
      if (e.z <= -60) { enemies.splice(i, 1); continue; }
      if (!player.dead && e.z < 46 && e.z > -30) {
        const vDiff = Math.abs((e.alt + e.h / 2) - player.alt);
        if (Math.abs(e.wx - player.wx) < (e.w + 34) / 2 && vDiff < e.h / 2 + 30) {
          if (player.barrierOn) { if (e.hp !== Infinity) { killEnemy(e); play('se_guard'); continue; } }
          else { damagePlayer(1); if (e.hp !== Infinity) { killEnemy(e); continue; } }
        }
      }
    }

    // boss
    if (boss) {
      if (!boss.sized) sizeEntity(boss, boss.def.anim.idle[0]);
      boss.animT += d;
      if (boss.flash > 0) boss.flash -= d;
      if (!boss.entered) {
        boss.z -= 9 * d;
        if (boss.z <= boss.targetZ) { boss.z = boss.targetZ; boss.entered = true; bossTimerOn = true; bossTimer = 99; bossTimerMs = 0; }
      } else if (!boss.dying) {
        updateBossAI(d);
        if (!player.dead && boss.z < 60) {
          if (Math.abs(boss.wx - player.wx) < (boss.w + 34) / 2 &&
              Math.abs(boss.alt - player.alt) < boss.h / 2 + 24) damagePlayer(1);
        }
      }
    }
    if (bossTimerOn) {
      bossTimerMs += d * STEP_MS;
      if (bossTimerMs >= 1000) {
        bossTimerMs = 0; bossTimer--;
        if (bossTimer <= 0) { bossTimerOn = false; damagePlayer(100); }
      }
    }

    // player shots
    for (let s = playerShots.length - 1; s >= 0; s--) {
      const sh = playerShots[s];
      sh.zPrev = sh.z;
      sh.z += sh.vz * d;
      sh.wx += sh.vx * d;
      sh.animT += d;
      if (sh.z > ZMAX + 100) { playerShots.splice(s, 1); continue; }
      let hit = false;
      for (let j = enemies.length - 1; j >= 0; j--) {
        const en = enemies[j];
        if (en.z < sh.zPrev - 20 || en.z > sh.z + 20) continue;
        if (Math.abs(en.wx - sh.wx) > (en.w + 14) / 2) continue;
        const sv = Math.abs((en.alt + en.h / 2) - sh.alt);
        if (sv > en.h / 2 + 34) continue;
        if (sh.big) {
          const id = enemies.indexOf(en);
          if (sh.hitIds[id]) continue;
          sh.hitIds[id] = 1;
          damageEnemy(en, sh.damage);
        } else {
          damageEnemy(en, sh.damage);
          playerShots.splice(s, 1); hit = true;
        }
        break;
      }
      if (hit) continue;
      for (let q = enemyShots.length - 1; q >= 0; q--) {
        const eb = enemyShots[q];
        if (eb.z < sh.zPrev - 24 || eb.z > sh.z + 24) continue;
        if (Math.abs(eb.wx - sh.wx) > 16) continue;
        if (Math.abs(eb.alt - sh.alt) > 26) continue;
        addExplosion(eb.wx, eb.alt, eb.z, false);
        addScore(100, 2);
        enemyShots.splice(q, 1);
        if (!sh.big) { playerShots.splice(s, 1); hit = true; }
        break;
      }
      if (hit) continue;
      if (boss && boss.entered && !boss.dying) {
        if (sh.z + 30 >= boss.z && sh.zPrev - 30 <= boss.z &&
            Math.abs(boss.wx - sh.wx) < (boss.w + 14) / 2) {
          damageEnemy(boss, sh.damage);
          if (!sh.big) playerShots.splice(s, 1);
        }
      }
    }

    // enemy shots
    for (let b = enemyShots.length - 1; b >= 0; b--) {
      const es = enemyShots[b];
      es.z += es.vz * d;
      es.wx += es.vx * d;
      es.alt += es.va * d;
      es.animT += d;
      if (es.z <= -40 || Math.abs(es.wx) > 460) { enemyShots.splice(b, 1); continue; }
      if (!player.dead && es.z < 26 && es.z > -26) {
        if (Math.abs(es.wx - player.wx) < 26 && Math.abs(es.alt - player.alt) < 34) {
          if (player.barrierOn) { play('se_guard'); }
          else damagePlayer(es.damage);
          enemyShots.splice(b, 1);
        }
      }
    }

    // items
    for (let m = items.length - 1; m >= 0; m--) {
      const it = items[m];
      it.z -= 5.5 * d;
      it.animT += d;
      it.alt = Math.max(16, it.alt) + Math.sin((it.animT + it.bob) * 0.08) * 0.4;
      it.wx += Math.max(-1.2, Math.min(1.2, (player.wx - it.wx) * 0.006)) * d;
      if (it.z <= -40) { items.splice(m, 1); continue; }
      if (!player.dead && it.z < 40 && Math.abs(it.wx - player.wx) < 44) {
        pickupItem(it); items.splice(m, 1);
      }
    }

    updateFx(d);
  }
  function updateFx(d) {
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i];
      f.t += d;
      if (f.t > 0 && f.t * 0.28 >= f.frames.length) fx.splice(i, 1);
    }
  }
  function anyConfirm() {
    if (confirmEdge) { confirmEdge = false; return true; }
    return false;
  }
  function toTitle() { state.mode = 'title'; titleFrame = 0; stopBgm(); }

  // ================== ASSET PRELOAD (plain Images from data URLs) ==================
  function loadImage(src) {
    return new Promise(function (resolve) {
      if (!src) { resolve(null); return; }
      const im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { resolve(null); };
      im.src = src;
    });
  }

  // ================== PHASER GAME ==================
  const scene = { create: create, update: phaserUpdate };
  let game = null;
  let S = null;                 // active Phaser scene
  const bgTex = {};             // stageId -> texture key (registered)
  let groundMesh = null, groundMeshOk = false;
  let skyG = null, skyStageId = -1, skyTint = { r: 40, g: 40, b: 80 };
  let fxG = null;               // per-frame primitive graphics
  let flashRect = null;
  let panelG = null;            // 2D side panels (cached)
  let panelMode = '';
  const imgPool = []; let imgUsed = 0;
  const txtPool = []; let txtUsed = 0;
  let depthSeq = 0;
  let acc = 0;

  // Ground mesh topology: ROWS screen-space bands x COLS one-tile quads.
  const G_ROWS = 44, G_COLS = 26;

  function boot() {
    const atlasImg = DATA.atlas && DATA.atlas.imageDataURL;
    const uiImg = DATA.uiAtlas && DATA.uiAtlas.imageDataURL;
    const bgs = DATA.backgrounds || {};
    const loads = [loadImage(atlasImg), loadImage(uiImg)];
    const bgIds = Object.keys(bgs);
    bgIds.forEach(function (k) { loads.push(loadImage(bgs[k])); });
    Promise.all(loads).then(function (res) {
      const atlas = res[0], ui = res[1];
      const bgImgs = {};
      bgIds.forEach(function (k, i) { if (res[2 + i]) bgImgs[k] = res[2 + i]; });
      if (!atlas) {
        document.body.innerHTML = '<p style="color:#f87171;font:14px monospace;text-align:center">Failed to load voxel atlas image</p>';
        return;
      }
      EXPLOSION_FRAMES = framesByPrefix('explosion');
      SP_EXPLOSION_FRAMES = framesByPrefix('spExplosion');
      if (!SP_EXPLOSION_FRAMES.length) SP_EXPLOSION_FRAMES = EXPLOSION_FRAMES;
      ITEM_FRAMES = {};
      for (const k in ITEM_PREFIX) ITEM_FRAMES[k] = framesByPrefix(ITEM_PREFIX[k]);

      let type = Phaser.AUTO;
      try { if (Phaser.WEBGL != null) type = Phaser.WEBGL; } catch (e) { /* ignore */ }
      game = new Phaser.Game({
        type: type,
        width: W, height: H,
        backgroundColor: '#000000',
        pixelArt: true,
        banner: false,
        parent: document.body,
        scene: scene,
        callbacks: {
          postBoot: function () { fitCanvas(); },
        },
      });
      // Canonical test/game handle used across CMG repos.
      globalThis.__PHASER_GAME__ = game;
      scene.__assets = { atlas: atlas, ui: ui, bgImgs: bgImgs };
      window.addEventListener('resize', fitCanvas);
    });
  }
  function fitCanvas() {
    const cv = game && game.canvas;
    if (!cv) return;
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    cv.style.width = Math.floor(W * s) + 'px';
    cv.style.height = Math.floor(H * s) + 'px';
    cv.style.imageRendering = 'pixelated';
    cv.style.touchAction = 'none';
  }

  function imageToCanvas(img) {
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth || img.width;
    cv.height = img.naturalHeight || img.height;
    cv.getContext('2d').drawImage(img, 0, 0);
    return cv;
  }

  function create() {
    S = this;
    const assets = scene.__assets || {};
    // Atlas textures. Pass canvases — the proven addAtlas path in this engine
    // family (2019-es7 BootScene does the same against Phaser 4.2.1).
    this.textures.addAtlas('vox', imageToCanvas(assets.atlas), { frames: frames });
    if (assets.ui && DATA.uiAtlas && DATA.uiAtlas.frames) {
      this.textures.addAtlas('ui', imageToCanvas(assets.ui), { frames: DATA.uiAtlas.frames });
    }
    for (const k in assets.bgImgs) {
      const key = 'bg' + k;
      this.textures.addImage(key, assets.bgImgs[k]);
      bgTex[k] = key;
    }
    // Soft round shadow texture.
    (function () {
      const cv = document.createElement('canvas');
      cv.width = 64; cv.height = 24;
      const c2 = cv.getContext('2d');
      const g = c2.createRadialGradient(32, 12, 2, 32, 12, 30);
      g.addColorStop(0, 'rgba(0,0,0,0.55)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c2.fillStyle = g;
      c2.save(); c2.translate(32, 12); c2.scale(1, 0.34); c2.translate(-32, -12);
      c2.beginPath(); c2.arc(32, 12, 30, 0, Math.PI * 2); c2.fill();
      c2.restore();
      S.textures.addImage('vox_shadow', cv.transferToImageBitmap ? cv : cv);
    })();

    skyG = this.add.graphics(); skyG.setDepth(0);
    buildGroundMesh();
    panelG = this.add.graphics(); panelG.setDepth(4000); panelG.setVisible(false);
    fxG = this.add.graphics(); fxG.setDepth(6000);
    flashRect = this.add.rectangle(W / 2, H / 2, W + 8, H + 8, 0xffffff);
    flashRect.setDepth(9000); flashRect.setAlpha(0);

    setupPointer();
    state.mode = 'title';
  }

  function buildGroundMesh() {
    groundMeshOk = false;
    if (!S || !S.add || typeof S.add.mesh2d !== 'function') return;
    if (!game || !game.renderer || (Phaser.WEBGL != null && game.renderer.type !== Phaser.WEBGL)) return;
    const texKey = bgTex[0] || bgTex[Object.keys(bgTex)[0]];
    if (!texKey) return;
    try {
      const quadCount = G_ROWS * G_COLS;
      const verts = new Array(quadCount * 4 * 4).fill(0);
      const indices = [];
      for (let q = 0; q < quadCount; q++) {
        const b = q * 4;
        indices.push(b, b + 1, b + 2, 0, b, b + 2, b + 3, 0);
      }
      groundMesh = S.add.mesh2d(0, 0, texKey, verts, indices);
      groundMesh.setDepth(1);
      groundMeshOk = true;
    } catch (e) {
      groundMesh = null;
      groundMeshOk = false;
    }
  }

  // ================== POOLED IMMEDIATE-MODE DRAW ==================
  function beginFrame() { imgUsed = 0; txtUsed = 0; depthSeq = 10; fxG.clear(); }
  function endFrame() {
    for (let i = imgUsed; i < imgPool.length; i++) imgPool[i].setVisible(false);
    for (let i = txtUsed; i < txtPool.length; i++) txtPool[i].setVisible(false);
  }
  function img(texKey, frameName, x, y, opts) {
    opts = opts || {};
    let im;
    if (imgUsed < imgPool.length) im = imgPool[imgUsed];
    else { im = S.add.image(0, 0, 'vox'); imgPool.push(im); }
    imgUsed++;
    im.setVisible(true);
    if (frameName != null) im.setTexture(texKey, frameName);
    else im.setTexture(texKey);
    im.setPosition(x, y);
    im.setOrigin(opts.ox != null ? opts.ox : 0.5, opts.oy != null ? opts.oy : 0.5);
    im.setScale(opts.sx != null ? opts.sx : (opts.s != null ? opts.s : 1), opts.sy != null ? opts.sy : (opts.s != null ? opts.s : 1));
    im.setAlpha(opts.alpha != null ? opts.alpha : 1);
    im.rotation = opts.rotate || 0;
    im.setDepth(opts.depth != null ? opts.depth : depthSeq++);
    if (opts.flash && im.setTintFill) im.setTintFill(0xffffff);
    else if (im.clearTint) im.clearTint();
    else if (im.setTint) im.setTint(0xffffff);
    return im;
  }
  function txt(str, x, y, size, color, align, depth, bold) {
    let t;
    if (txtUsed < txtPool.length) t = txtPool[txtUsed];
    else {
      t = S.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: '12px', color: '#ffffff' });
      txtPool.push(t);
    }
    txtUsed++;
    t.setVisible(true);
    t.setText(str);
    t.setStyle({ fontFamily: 'monospace', fontSize: size + 'px', color: color || '#ffffff', fontStyle: bold ? 'bold' : 'normal' });
    t.setPosition(x, y);
    t.setOrigin(align === 'center' ? 0.5 : align === 'right' ? 1 : 0, 0);
    t.setDepth(depth != null ? depth : 7000);
    return t;
  }

  // Draw an atlas frame in the current view mode at world (wx, alt, z).
  // Returns false when the frame is unknown.
  function drawWorldSprite(key, wx, alt, z, opts) {
    opts = opts || {};
    const fk = frameKey(key);
    if (!fk) return false;
    const vs = voxScale(fk) * (opts.scale || 1);
    if (viewMode === '3d') {
      const t = proj(z);
      const sc = SPR * t * vs;
      const x = screenX(wx, z), y = groundY(z) - alt * t;
      img('vox', fk, x, y, {
        s: sc, alpha: opts.alpha, rotate: opts.rotate, flash: opts.flash,
        oy: opts.rotate ? 0.5 : 1, depth: depthSeq++,
      });
      if (opts.rotate) { /* rotated sprites use center origin like GAME3D */ }
    } else {
      const x = x2d(wx), y = z2y(z) - alt * 0.18;
      img('vox', fk, x, y, {
        s: SPR * F2D.scale * vs, alpha: opts.alpha, rotate: opts.rotate, flash: opts.flash,
        depth: depthSeq++,
      });
    }
    return true;
  }
  function drawShadow(wx, z, widthPx, opts) {
    if (viewMode !== '3d') return;
    const t = proj(z);
    const x = screenX(wx, z), y = groundY(z);
    const rw = Math.max(2, widthPx * SPR * t * 0.45);
    img('vox_shadow', null, x, y, {
      sx: (rw * 2) / 64, sy: Math.max(0.1, (rw * 0.56) / 24),
      alpha: (opts && opts.alpha != null ? opts.alpha : 1),
      depth: depthSeq++,
    });
  }
  function drawUIFrame(key, cx, cy, opts) {
    opts = opts || {};
    const k = uiKey(key);
    if (!k || !S.textures.exists('ui')) return false;
    img('ui', k, cx, cy, { s: opts.scale || 1, alpha: opts.alpha, depth: opts.depth != null ? opts.depth : 7000 });
    return true;
  }
  function drawBitmapNum(prefix, value, cx, y, opts) {
    opts = opts || {};
    if (!S.textures.exists('ui')) return false;
    const str = String(value);
    const sc = opts.scale || 1;
    const digits = [];
    let total = 0;
    for (let i = 0; i < str.length; i++) {
      const k = uiKey(prefix + str[i] + '.gif');
      if (!k) return false;
      const f = uiFrames[k].frame;
      digits.push({ k: k, w: f.w, h: f.h });
      total += (f.w + 1) * sc;
    }
    let x = cx - total / 2;
    for (let j = 0; j < digits.length; j++) {
      img('ui', digits[j].k, x + digits[j].w * sc / 2, y + digits[j].h * sc / 2, { s: sc, alpha: opts.alpha, depth: 7000 });
      x += (digits[j].w + 1) * sc;
    }
    return true;
  }
  function drawScoreRow(labelKey, value, cx, y, sc) {
    sc = sc || 1;
    if (!drawUIFrame(labelKey, cx, y, { scale: sc })) {
      const lbl = labelKey === 'hiScoreTxt.gif' ? 'HI SCORE' : 'SCORE';
      txt(lbl + ' ' + String(value).padStart(8, '0'), cx, y - 2, 12, '#fff', 'center');
      return;
    }
    if (!drawBitmapNum('bigNum', value, cx, y + 6 * sc, { scale: sc })) {
      txt(String(value).padStart(8, '0'), cx, y + 12, 12, '#fff', 'center');
    }
  }

  // ================== POINTER ==================
  function setupPointer() {
    const cv = game.canvas;
    function canvasXY(e) {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
    }
    function pointerWx(e) {
      const p = canvasXY(e);
      if (viewMode === '3d') return (p.x - W / 2) / 0.62;
      return (p.x - W / 2) / F2D.kx;
    }
    cv.addEventListener('pointerdown', function (e) {
      const p = canvasXY(e);
      if (p.x > MODE_BTN.x - MODE_BTN.w / 2 && p.x < MODE_BTN.x + MODE_BTN.w / 2 &&
          p.y > MODE_BTN.y - MODE_BTN.h / 2 && p.y < MODE_BTN.y + MODE_BTN.h / 2) {
        toggleMode();
        return;
      }
      if (state.mode === 'game' && Math.hypot(p.x - SP_BTN.x, p.y - SP_BTN.y) <= SP_BTN.r + 10) {
        caRequested = true;
        return;
      }
      confirmEdge = true;
      const now = performance.now();
      if (now - lastTap < 280) caRequested = true;
      lastTap = now;
      dragTargetWx = pointerWx(e);
    });
    cv.addEventListener('pointermove', function (e) { if (dragTargetWx !== null) dragTargetWx = pointerWx(e); });
    window.addEventListener('pointerup', function () { dragTargetWx = null; });
  }

  // ================== RENDER: 3D (SUPER SCALER) ==================
  function computeSkyTint(texKey) {
    try {
      const src = S.textures.get(texKey).getSourceImage();
      const cv = document.createElement('canvas'); cv.width = 8; cv.height = 8;
      cv.getContext('2d').drawImage(src, 0, 0, 8, 8);
      const d = cv.getContext('2d').getImageData(0, 0, 8, 8).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4;
      return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
    } catch (e) { return { r: 40, g: 40, b: 80 }; }
  }
  function rgb(r, g, b) { return (Math.max(0, Math.min(255, r | 0)) << 16) | (Math.max(0, Math.min(255, g | 0)) << 8) | Math.max(0, Math.min(255, b | 0)); }
  function drawSky(stageId) {
    if (skyStageId === stageId) { skyG.setVisible(viewMode === '3d'); return; }
    skyStageId = stageId;
    const texKey = bgTex[stageId];
    skyTint = texKey ? computeSkyTint(texKey) : { r: 40, g: 40, b: 80 };
    skyG.clear();
    const bands = 16;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      let cr, cg, cb;
      if (t < 0.72) {
        const u = t / 0.72;
        cr = (skyTint.r >> 2) + ((skyTint.r >> 1) - (skyTint.r >> 2)) * u;
        cg = (skyTint.g >> 2) + ((skyTint.g >> 1) - (skyTint.g >> 2)) * u;
        cb = ((skyTint.b >> 2) + 12) + (((skyTint.b >> 1) + 16) - ((skyTint.b >> 2) + 12)) * u;
      } else {
        const u = (t - 0.72) / 0.28;
        cr = (skyTint.r >> 1) + (Math.min(255, skyTint.r + 90) - (skyTint.r >> 1)) * u;
        cg = (skyTint.g >> 1) + (Math.min(255, skyTint.g + 70) - (skyTint.g >> 1)) * u;
        cb = ((skyTint.b >> 1) + 16) + (Math.min(255, skyTint.b + 60) - ((skyTint.b >> 1) + 16)) * u;
      }
      skyG.fillStyle(rgb(cr, cg, cb), 1);
      skyG.fillRect(0, (HY / bands) * i, W, HY / bands + 1);
    }
    // striped retro sun
    const sunX = W / 2, sunY = HY - 26;
    for (let rr = 30; rr > 4; rr -= 3) {
      skyG.fillStyle(rgb(255, 200 + rr, 120), 0.10 + (30 - rr) * 0.02);
      skyG.fillCircle(sunX, sunY, rr);
    }
    // horizon haze
    skyG.fillStyle(rgb(255, 220, 170), 0.28);
    skyG.fillRect(0, HY - 2, W, 3);
  }

  function updateGround(stageId) {
    const texKey = bgTex[stageId];
    if (!groundMeshOk || !texKey) return false;
    if (groundMesh.texture.key !== texKey) groundMesh.setTexture(texKey);
    const tex = S.textures.get(texKey).getSourceImage();
    const texH = (tex && tex.height) || 256;
    const verts = groundMesh.vertices;
    let vi = 0;
    for (let r2 = 0; r2 < G_ROWS; r2++) {
      const yTop = HY + 1 + ((H - HY - 1) * r2) / G_ROWS;
      const yBot = HY + 1 + ((H - HY - 1) * (r2 + 1)) / G_ROWS;
      const yMid = (yTop + yBot) / 2;
      const t = Math.max(0.012, (yMid - HY) / (BY - HY));
      const z = FOCAL * (1 - t) / t;
      const srcY = ((((scrollZ + z) * Z2TEX) % texH) + texH) % texH;
      const v = srcY / texH;
      const vEps = 0.5 / texH;
      let dw = GROUND_TILE_W * t;
      if (dw < W / (G_COLS - 2)) dw = W / (G_COLS - 2);
      const x0 = W / 2 - camX * t;
      const firstTile = Math.floor((0 - x0) / dw) - 1;
      for (let c = 0; c < G_COLS; c++) {
        const tileIdx = firstTile + c;
        const xa = x0 + tileIdx * dw;
        const xb = xa + dw;
        // 4 corners: TL, TR, BR, BL — u spans exactly one tile (0..1),
        // v is a constant one-texel band (the canvas scanline idiom).
        verts[vi++] = xa; verts[vi++] = yTop; verts[vi++] = 0; verts[vi++] = v;
        verts[vi++] = xb; verts[vi++] = yTop; verts[vi++] = 1; verts[vi++] = v;
        verts[vi++] = xb; verts[vi++] = yBot; verts[vi++] = 1; verts[vi++] = v + vEps;
        verts[vi++] = xa; verts[vi++] = yBot; verts[vi++] = 0; verts[vi++] = v + vEps;
      }
    }
    groundMesh.setVisible(true);
    return true;
  }
  function drawGroundFallback() {
    fxG.fillStyle(0x0a140a, 1);
    fxG.fillRect(0, HY + 1, W, H - HY - 1);
    fxG.lineStyle(1, 0x78ff78, 0.35);
    for (let i = -8; i <= 8; i++) {
      const wx = i * LANE_W;
      fxG.lineBetween(screenX(wx, 0), groundY(0), screenX(wx, ZMAX * 4), groundY(ZMAX * 4));
    }
    for (let zi = 0; zi < 14; zi++) {
      let zz = ((zi * 120) - (scrollZ * 2) % 120);
      if (zz < 0) zz += 1680;
      const gy = groundY(zz);
      fxG.lineBetween(0, gy, W, gy);
    }
  }

  function render3DWorld() {
    const sid = Math.min(state.stageId, MAX_STAGE);
    drawSky(sid);
    skyG.setVisible(true);
    if (!updateGround(sid)) {
      if (groundMesh) groundMesh.setVisible(false);
      drawGroundFallback();
    }
    if (state.mode === 'title') { renderTitle(); return; }
    if (state.mode === 'ending') { renderEnding(); return; }

    const draws = [];
    let i;
    for (i = 0; i < enemies.length; i++) draws.push({ z: enemies[i].z, kind: 'enemy', o: enemies[i] });
    if (boss) draws.push({ z: boss.z, kind: 'boss', o: boss });
    for (i = 0; i < enemyShots.length; i++) draws.push({ z: enemyShots[i].z, kind: 'eshot', o: enemyShots[i] });
    for (i = 0; i < playerShots.length; i++) draws.push({ z: playerShots[i].z, kind: 'pshot', o: playerShots[i] });
    for (i = 0; i < items.length; i++) draws.push({ z: items[i].z, kind: 'item', o: items[i] });
    for (i = 0; i < fx.length; i++) if (fx[i].t >= 0) draws.push({ z: fx[i].z, kind: 'fx', o: fx[i] });
    draws.sort(function (a, b) { return b.z - a.z; });
    for (i = 0; i < draws.length; i++) drawEntity(draws[i]);
    drawPlayer();
    renderOverlays();
  }

  // ================== RENDER: 2D (VERTICAL SHOOTER) ==================
  function render2DWorld() {
    skyG.setVisible(false);
    if (groundMesh) groundMesh.setVisible(false);
    const sid = Math.min(state.stageId, MAX_STAGE);
    // scrolling stage background inside the playfield column
    const texKey = bgTex[sid];
    const fx0 = W / 2 - F2D.w / 2;
    if (texKey) {
      const tex = S.textures.get(texKey).getSourceImage();
      const texW = (tex && tex.width) || 512, texH = (tex && tex.height) || 512;
      const sc = F2D.w / texW;
      const tileH = texH * sc;
      const yOff = ((scrollZ * Z2TEX * 0.55 * sc) % tileH + tileH) % tileH;
      for (let y = yOff - tileH; y < H + tileH; y += tileH) {
        img(texKey, null, W / 2, y + tileH / 2, { sx: sc, sy: sc, depth: 1, alpha: 0.85 });
      }
    } else {
      fxG.fillStyle(0x06101c, 1);
      fxG.fillRect(fx0, 0, F2D.w, H);
    }
    // side panels (cached graphics; redrawn when mode flips)
    if (panelMode !== '2d') {
      panelMode = '2d';
      panelG.clear();
      panelG.fillStyle(0x05070c, 1);
      panelG.fillRect(0, 0, fx0, H);
      panelG.fillRect(W / 2 + F2D.w / 2, 0, W - (W / 2 + F2D.w / 2), H);
      panelG.lineStyle(2, 0x1c2a44, 1);
      panelG.lineBetween(fx0, 0, fx0, H);
      panelG.lineBetween(W / 2 + F2D.w / 2, 0, W / 2 + F2D.w / 2, H);
    }
    panelG.setVisible(true);

    if (state.mode === 'title') { renderTitle(); return; }
    if (state.mode === 'ending') { renderEnding(); return; }

    let i;
    for (i = 0; i < enemies.length; i++) drawEntity({ kind: 'enemy', o: enemies[i] });
    if (boss) drawEntity({ kind: 'boss', o: boss });
    for (i = 0; i < enemyShots.length; i++) drawEntity({ kind: 'eshot', o: enemyShots[i] });
    for (i = 0; i < playerShots.length; i++) drawEntity({ kind: 'pshot', o: playerShots[i] });
    for (i = 0; i < items.length; i++) drawEntity({ kind: 'item', o: items[i] });
    for (i = 0; i < fx.length; i++) if (fx[i].t >= 0) drawEntity({ kind: 'fx', o: fx[i] });
    drawPlayer();
    renderOverlays();
  }

  // ================== SHARED ENTITY DRAWING ==================
  function drawEntity(dd) {
    const o = dd.o;
    if (dd.kind === 'enemy') {
      drawShadow(o.wx, o.z, o.w / SPR);
      drawWorldSprite(anim(o.def.texture, o.animT, 0.1), o.wx, o.alt, o.z, o.flash > 0 ? { flash: true } : null);
    } else if (dd.kind === 'boss') {
      drawShadow(o.wx, o.z, o.w / SPR, { alpha: o.dying ? 0.5 : 1 });
      const anims = o.def.anim || {};
      const ak = o.animKey || 'idle';
      const frameList = (anims[ak] && anims[ak].length ? anims[ak] : anims.idle) || anims.idle;
      const op = o.flash > 0 ? { flash: true } : (o.dying ? { alpha: Math.max(0.25, 1 - o.dying / 180) } : null);
      drawWorldSprite(anim(frameList, o.animT, ak === 'shoot' ? 0.14 : 0.08), o.wx, o.alt, o.z, op);
    } else if (dd.kind === 'eshot') {
      drawWorldSprite(anim(o.tex, o.animT, 0.15), o.wx, o.alt, o.z, { scale: 1.1 });
    } else if (dd.kind === 'pshot') {
      // Player shots must point toward the top of the screen (the way they
      // travel) in BOTH views. The source shot art is a horizontal bolt (its
      // mass sits on the right), so rotate it -90deg to stand it upright — the
      // same -90deg the canvas super-scaler used, now applied in 2D too where
      // it previously stayed flat and read as "facing right".
      drawShadow(o.wx, o.z, o.big ? 18 : 12);
      drawWorldSprite(anim(o.tex, o.animT, 0.3), o.wx, o.alt, o.z, { scale: o.big ? 1.3 : 0.9, rotate: -Math.PI / 2 });
    } else if (dd.kind === 'item') {
      const pf = ITEM_FRAMES[o.name];
      if (pf && pf.length) drawWorldSprite(anim(pf, o.animT, 0.08), o.wx, o.alt, o.z, { scale: 1.15 });
    } else if (dd.kind === 'fx') {
      const fr = anim(o.frames, Math.max(0, o.t), 0.28);
      if (fr) drawWorldSprite(fr, o.wx, o.alt, o.z, { scale: o.scale });
    }
  }
  function drawPlayer() {
    if (!player || state.mode !== 'game' && state.mode !== 'clear' && state.mode !== 'gameover') return;
    if (player.dead) return;
    const pd = R.playerData || {};
    const fade = player.invuln > 0 && Math.floor(player.invuln / 6) % 2 === 0;
    const bank = viewMode === '3d' ? Math.max(-0.5, Math.min(0.5, player.vx * 0.06)) : 0;
    drawShadow(player.wx, 0, 34);
    const ptex = pd.texture || [];
    if (!fade) drawWorldSprite(anim(ptex, player.animT, 0.35), player.wx, player.alt, 0, { rotate: bank, scale: 1.05 });
    if (player.barrierOn) {
      const p = viewMode === '3d'
        ? { x: screenX(player.wx, 0), y: groundY(0) - player.alt * proj(0) - 14 }
        : { x: x2d(player.wx), y: z2y(0) - 8 };
      fxG.lineStyle(2, 0x7dd3fc, 0.5 + 0.3 * Math.sin(player.barrierT * 0.2));
      fxG.strokeCircle(p.x, p.y, 30);
    }
    if (player.hitRingT > 0) {
      const p = viewMode === '3d'
        ? { x: screenX(player.wx, 0), y: groundY(0) - player.alt * proj(0) - 14 }
        : { x: x2d(player.wx), y: z2y(0) - 8 };
      fxG.lineStyle(2, 0xef4444, Math.max(0, player.hitRingT / 110));
      fxG.strokeCircle(p.x, p.y, 34 - player.hitRingT * 0.12);
    }
  }

  // ================== OVERLAYS / HUD ==================
  function renderOverlays() {
    if (banner) renderStageBanner();
    if (state.mode === 'clear') renderClearOverlay();
    if (state.mode === 'gameover') renderGameOver();
    renderHUD();
  }
  function renderHUD() {
    // score
    if (!drawBitmapNum('bigNum', state.score, 64, 6, { scale: 0.8 })) {
      txt('SCORE ' + String(state.score).padStart(8, '0'), 8, 6, 11, '#fff');
    }
    if (!drawBitmapNum('bigNum', state.hiScore, W / 2, 6, { scale: 0.6 })) {
      txt('HI ' + String(state.hiScore).padStart(8, '0'), W / 2, 6, 10, '#94a3b8', 'center');
    }
    // HP pips
    if (player) {
      for (let i = 0; i < player.maxHp; i++) {
        fxG.fillStyle(i < player.hp ? 0x4ade80 : 0x334155, 1);
        fxG.fillRect(8 + i * 10, H - 14, 8, 6);
      }
    }
    // combo
    if (state.combo > 1) {
      txt(state.combo + ' COMBO', 8, 30, 11, '#fde047');
    }
    // boss HP bar + timer
    if (boss && boss.entered && !boss.dying && boss.hp !== Infinity) {
      const bw = 160;
      fxG.fillStyle(0x000000, 0.5); fxG.fillRect(W / 2 - bw / 2 - 1, 22, bw + 2, 7);
      fxG.fillStyle(0xef4444, 1); fxG.fillRect(W / 2 - bw / 2, 23, bw * Math.max(0, boss.hp / boss.maxHp), 5);
      if (bossTimerOn) txt(String(bossTimer), W / 2, 32, 12, '#fde047', 'center');
    }
    // SP (CA) button with charge ring
    const pct = state.cagage / CA_MAX;
    fxG.fillStyle(0x000000, 0.35); fxG.fillCircle(SP_BTN.x, SP_BTN.y, SP_BTN.r);
    fxG.lineStyle(3, pct >= 1 ? 0xfde047 : 0x38bdf8, 0.9);
    fxG.beginPath();
    fxG.arc(SP_BTN.x, SP_BTN.y, SP_BTN.r - 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct, false);
    fxG.strokePath();
    if (!drawUIFrame(pct >= 1 ? 'hudCabtn100per.gif' : 'hudCabtn0per.gif', SP_BTN.x, SP_BTN.y, { scale: 0.8 })) {
      txt('SP', SP_BTN.x, SP_BTN.y - 6, 11, pct >= 1 ? '#fde047' : '#7dd3fc', 'center', 7000, true);
    }
    // MODE toggle button
    fxG.fillStyle(0x000000, 0.45);
    fxG.fillRect(MODE_BTN.x - MODE_BTN.w / 2, MODE_BTN.y - MODE_BTN.h / 2, MODE_BTN.w, MODE_BTN.h);
    fxG.lineStyle(1, 0x38bdf8, 0.8);
    fxG.strokeRect(MODE_BTN.x - MODE_BTN.w / 2, MODE_BTN.y - MODE_BTN.h / 2, MODE_BTN.w, MODE_BTN.h);
    txt(viewMode === '3d' ? '3D ▸ 2D' : '2D ▸ 3D', MODE_BTN.x, MODE_BTN.y - 6, 10, '#7dd3fc', 'center', 7000);
    // CA flash
    flashRect.setAlpha(flashAlpha > 0 ? flashAlpha * 0.85 : 0);
  }
  function renderStageBanner() {
    const a = Math.min(1, banner.timer / 40);
    if (banner.timer > 70) {
      if (drawUIFrame('stageTitle.gif', W / 2 - 18, H / 2 - 20, { scale: 1.3, alpha: a })) {
        const numKey = 'stageNum' + banner.n + '.gif';
        if (!drawUIFrame(numKey, W / 2 + 48, H / 2 - 20, { scale: 1.3, alpha: a })) {
          drawBitmapNum('bigNum', banner.n, W / 2 + 48, H / 2 - 33, { scale: 1.4, alpha: a });
        }
      } else {
        txt('STAGE ' + banner.n, W / 2, H / 2 - 24, 26, '#fde047', 'center', 7000, true);
      }
    } else if (!drawUIFrame('stageFight.gif', W / 2, H / 2 - 16, { scale: 1.3, alpha: a })) {
      txt('FIGHT!', W / 2, H / 2 - 20, 26, '#fff', 'center', 7000, true);
    }
  }
  function renderClearOverlay() {
    fxG.fillStyle(0x000000, 0.35); fxG.fillRect(0, 0, W, H);
    if (!drawUIFrame('stageclear.gif', W / 2, H / 2 - 44, { scale: 1.2 })) {
      txt('STAGE CLEAR', W / 2, H / 2 - 48, 24, '#fde047', 'center', 7000, true);
    }
    drawScoreRow('scoreTxt.gif', state.score, W / 2, H / 2 + 6, 1);
    drawScoreRow('hiScoreTxt.gif', state.hiScore, W / 2, H / 2 + 62, 1);
  }
  function renderGameOver() {
    fxG.fillStyle(0x000000, 0.55); fxG.fillRect(0, 0, W, H);
    if (!drawUIFrame('continueGameOver.gif', W / 2, H / 2 - 56, { scale: 1.1 })) {
      txt('GAME OVER', W / 2, H / 2 - 62, 28, '#ef4444', 'center', 7000, true);
    }
    drawScoreRow('scoreTxt.gif', state.score, W / 2, H / 2 - 8, 1);
    drawScoreRow('hiScoreTxt.gif', state.hiScore, W / 2, H / 2 + 48, 1);
    if (gameOverTimer > 90 && Math.floor(gameOverTimer / 40) % 2 === 0) {
      if (!drawUIFrame('titleStartText.gif', W / 2, H - 34, { scale: 1 })) {
        txt('PRESS ENTER / TAP TO CONTINUE', W / 2, H - 34, 12, '#fde047', 'center', 7000);
      }
    }
  }
  function renderTitle() {
    const pd = R.playerData || {};
    const bob = Math.sin(titleFrame * 0.03) * 5;
    drawShadow(0, 60, 34);
    if (viewMode === '3d') {
      drawWorldSprite(anim(pd.texture || [], titleFrame, 0.35), 0, PLAYER_ALT + 8 + bob, 60, { scale: 1.6 });
    } else {
      drawWorldSprite(anim(pd.texture || [], titleFrame, 0.35), 0, 0, 220 + bob * 8, { scale: 1.6 });
    }
    fxG.fillStyle(0x000000, 0.35); fxG.fillRect(0, 30, W, 96);
    if (drawUIFrame('logo.gif', W / 2, 68, { scale: 1.05 })) {
      const subKey = uiKey('subTitleEn.gif') ? 'subTitleEn.gif' : 'subTitle.gif';
      drawUIFrame(subKey, W / 2, 112, { scale: 1.05 });
    } else {
      txt((DATA.name || 'VOXEL 3D').toUpperCase(), W / 2, 56, 26, '#fde047', 'center', 7000, true);
      txt(viewMode === '3d' ? 'VOXEL SUPER SCALER 3D' : 'VOXEL VERTICAL SHOOTER', W / 2, 90, 14, '#7dd3fc', 'center', 7000);
    }
    // EX roundel (same mark as the 2D title's unlock badge)
    const bx = W / 2 + 148, by = 68;
    fxG.fillStyle(0x000000, 0.55); fxG.fillCircle(bx, by, 14);
    fxG.lineStyle(2, 0xfde047, 0.9); fxG.strokeCircle(bx, by, 14);
    txt('EX', bx, by - 6, 11, '#fde047', 'center', 7000, true);
    if (Math.floor(titleFrame / 40) % 2 === 0) {
      if (!drawUIFrame('titleStartText.gif', W / 2, H - 64, { scale: 1.1 })) {
        txt('PRESS ENTER / TAP TO START', W / 2, H - 68, 13, '#fff', 'center', 7000);
      }
    }
    txt('M: SWITCH 2D/3D', W / 2, H - 26, 10, '#64748b', 'center', 7000);
    drawScoreRow('hiScoreTxt.gif', state.hiScore, W / 2, H - 48, 0.8);
  }
  function renderEnding() {
    fxG.fillStyle(0x000000, 0.45); fxG.fillRect(0, 0, W, H);
    if (!drawUIFrame('congraTxt0.gif', W / 2, H / 2 - 62, { scale: 1 })) {
      txt('CONGRATULATIONS!', W / 2, H / 2 - 68, 24, '#fde047', 'center', 7000, true);
    }
    drawScoreRow('scoreTxt.gif', state.score, W / 2, H / 2 - 12, 1);
    drawScoreRow('hiScoreTxt.gif', state.hiScore, W / 2, H / 2 + 44, 1);
    if (Math.floor(titleFrame / 40) % 2 === 0) {
      if (!drawUIFrame('titleStartText.gif', W / 2, H - 34, { scale: 1 })) {
        txt('PRESS ENTER / TAP', W / 2, H - 34, 12, '#fff', 'center', 7000);
      }
    }
  }

  // ================== PHASER SCENE UPDATE ==================
  function phaserUpdate(time, delta) {
    if (state.mode === 'boot') return;
    acc += Math.min(delta || 16.7, MAX_FRAME_MS);
    while (acc >= STEP_MS) { acc -= STEP_MS; update(1); }
    // camera shake
    const cam = S.cameras && S.cameras.main;
    if (cam && cam.setScroll) {
      if (shake > 0) cam.setScroll((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5);
      else cam.setScroll(0, 0);
    }
    beginFrame();
    if (viewMode === '3d') { if (panelG) panelG.setVisible(false); panelMode = ''; render3DWorld(); }
    else render2DWorld();
    endFrame();
  }

  // ================== TEST HOOKS ==================
  window.__VOXEL3D__ = {
    getState: function () { return { mode: state.mode, viewMode: viewMode, stageId: state.stageId, score: state.score, cagage: state.cagage, combo: state.combo, enemies: enemies ? enemies.length : 0, items: items ? items.length : 0, eshots: enemyShots ? enemyShots.length : 0, boss: boss ? { name: boss.name, hp: boss.hp, entered: boss.entered, phase: boss.phase, wx: Math.round(boss.wx), z: Math.round(boss.z), alt: Math.round(boss.alt), animKey: boss.animKey } : null, playerHp: player ? player.hp : 0, shootMode: player ? player.shootMode : null, waveCount: waveCount, waves: waves ? waves.length : 0, phaser: !!game, renderer: game && game.renderer ? game.renderer.type : -1, mesh2d: groundMeshOk }; },
    bgm: function () { return { stageIdx: state.stageId, src: bgmSrc ? String(bgmSrc).slice(0, 60) : null, hasAudio: !!bgmAudio, paused: bgmAudio ? bgmAudio.paused : null, stagesAvailable: Object.keys(bgmSources) }; },
    start: function () { confirmEdge = true; },
    god: function (on) { godMode = !!on; },
    skipToBoss: function () { if (state.mode === 'game') { waves = []; waveCount = 0; } },
    damageBoss: function (n) { if (boss) damageEnemy(boss, n || 50); },
    giveCa: function () { state.cagage = CA_MAX; },
    ca: function () { caRequested = true; },
    spawnItem: function (name) { items.push({ name: name || 'big', wx: player.wx, alt: 30, z: 300, animT: 0, bob: 0 }); },
    hurt: function (n) { if (player) { player.invuln = 0; const g = godMode; godMode = false; damagePlayer(n || 1); godMode = g; } },
    move: function (wx) { if (player) { player.wx = Math.max(-210, Math.min(210, wx)); } },
    setMode: function (m) { if (m === '2d' || m === '3d') viewMode = m; },
    getMode: function () { return viewMode; },
  };

  // ================== BOOT ==================
  boot();
};
