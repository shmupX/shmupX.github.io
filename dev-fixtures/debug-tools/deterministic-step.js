// Drive a running Phaser game FRAME BY FRAME from the console, so a level
// can be compared against a capture at matching timestamps instead of
// whatever the browser's requestAnimationFrame happened to deliver.
//
// Paste this whole file into the devtools console of a page running the
// game (e.g. /es7/phaser-game.html?editorPlay=1&stage=0&god=1, served by
// serve-runtime.ts), then:
//
//   await dezaStep.attach()   // wait for the stage, then FREEZE real time
//   dezaStep.toSecond(31)     // advance to stage-second 31 and stop there
//   dezaStep.frames(60)       // or step an exact number of engine ticks
//   dezaStep.census()         // what is on screen right now
//   dezaStep.resume()         // hand the game back to real time
//
// Three traps this exists to avoid, all of which silently produce numbers
// that look plausible and are wrong:
//
//   1. A page that loads in a BACKGROUND tab auto-sleeps the loop, and then
//      game.loop.step() is a no-op. attach() wakes it first.
//   2. Reassigning game.step does nothing — rAF drives the callback bound
//      into game.loop.callback. Freezing means replacing THAT, and keeping
//      the original to call by hand.
//   3. If real time is not actually frozen, wall-clock frames interleave
//      with your manual ones and every measurement drifts. attach() proves
//      the freeze by sampling the scene clock across a real timeout, and
//      throws rather than reporting an unverified result.
//
// Stage-seconds here are the runtime's own clock (worldTime), not wall time:
// the scene fixed-steps at 120Hz, so one stage-second is 120 ticks. See
// SATURN_TICKS_PER_FRAME in 2019-es7/src/phaser/dezaemon-runtime.js for why
// that is twice the Saturn's 60fps frame rate.

globalThis.dezaStep = (() => {
  const STEP_MS = 1000 / 60; // one rAF frame; the scene sub-steps internally
  const TICKS_PER_SECOND = 120; // scene fixedUpdate rate

  let game = null;
  let scene = null;
  let realCallback = null;
  let clock = 0;

  const getGame = () => globalThis.__PHASER_4_GAME__ || globalThis.game || null;
  const getScene = () => game ? game.scene.getScene("PhaserGameScene") : null;

  async function attach({ timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      game = getGame();
      if (game) {
        // A hidden tab parks the loop; without this every step() is a no-op.
        game.loop.wake();
        const s = getScene();
        if (s && s.scene.isActive() && s.gameStarted) break;
        // Nudge boot along in case rAF is not running at all.
        clock = performance.now();
        for (let i = 0; i < 10; i++) {
          clock += STEP_MS;
          game.loop.step(clock);
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    scene = getScene();
    if (!scene || !scene.gameStarted) {
      throw new Error("GameScene never reached gameStarted");
    }

    // Freeze: rAF keeps firing, but the callback it drives is now inert.
    realCallback = game.loop.callback;
    game.loop.callback = () => {};
    clock = performance.now();

    const before = scene.worldTime;
    await new Promise((r) => setTimeout(r, 600));
    const drift = scene.worldTime - before;
    if (drift !== 0) {
      game.loop.callback = realCallback;
      realCallback = null;
      throw new Error(
        `real time is not frozen (scene advanced ${drift} ticks while idle)`,
      );
    }
    return { frozenAtSecond: +(scene.worldTime / TICKS_PER_SECOND).toFixed(2) };
  }

  function frames(n) {
    if (!realCallback) throw new Error("call attach() first");
    for (let i = 0; i < n; i++) {
      clock += STEP_MS;
      realCallback(clock, STEP_MS);
    }
    return census();
  }

  function toSecond(second, { maxFrames = 60 * 60 * 10 } = {}) {
    if (!realCallback) throw new Error("call attach() first");
    const target = second * TICKS_PER_SECOND;
    let guard = 0;
    while (scene.worldTime < target && guard++ < maxFrames) {
      clock += STEP_MS;
      realCallback(clock, STEP_MS);
    }
    if (scene.worldTime < target) {
      throw new Error(`gave up short of second ${second} (frame guard hit)`);
    }
    return census();
  }

  // Snapshot worth diffing against a capture frame: how far the stage has
  // scrolled, which records are alive, and how much the enemies are shooting.
  function census() {
    const byKey = {};
    for (const e of scene.enemies) {
      const key = e.getData("enemyKey") || "?";
      byKey[key] = (byKey[key] || 0) + 1;
    }
    return {
      second: +(scene.worldTime / TICKS_PER_SECOND).toFixed(2),
      worldTime: scene.worldTime,
      scroll: scene.dezaBg ? scene.dezaBg._scroll : null,
      wave: `${scene.waveCount}/${scene.stageEnemyPositionList.length}`,
      enemies: scene.enemies.length,
      bullets: scene.enemyBullets.length,
      byKey,
    };
  }

  // Is a record glued to the map, or sliding across it? Returns the largest
  // disagreement between an enemy's own motion and the scroll over the
  // sampled frames — 0 means perfectly pinned scenery (statues, pillars,
  // domes).
  function glueError(enemyKey, frameCount = 600) {
    if (!realCallback) throw new Error("call attach() first");
    if (!scene.dezaBg) throw new Error("stage has no imported background");
    const tracked = new Map();
    let worst = 0;
    for (let i = 0; i < frameCount; i++) {
      clock += STEP_MS;
      realCallback(clock, STEP_MS);
      for (const e of scene.enemies) {
        if ((e.getData("enemyKey") || "") !== enemyKey) continue;
        if (!tracked.has(e)) {
          tracked.set(e, { y: e.y, scroll: scene.dezaBg._scroll });
          continue;
        }
        const base = tracked.get(e);
        const err = Math.abs(
          (e.y - base.y) - (scene.dezaBg._scroll - base.scroll),
        );
        if (err > worst) worst = err;
      }
    }
    // No sightings is NOT a clean result — reporting 0 there would read as
    // "perfectly pinned" when it means the record was never on screen.
    return {
      enemyKey,
      sampled: tracked.size,
      maxGlueError: tracked.size ? +worst.toFixed(2) : null,
    };
  }

  function resume() {
    if (!realCallback) return "not frozen";
    game.loop.callback = realCallback;
    realCallback = null;
    return "resumed on real time";
  }

  return { attach, frames, toSecond, census, glueError, resume };
})();

console.log(
  "dezaStep ready — await dezaStep.attach(), then dezaStep.toSecond(31)",
);
