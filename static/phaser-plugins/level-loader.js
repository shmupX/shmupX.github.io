// Level Loader — a Phaser 4 ScenePlugin that resolves a "level" from one of
// several sources (an offline-baked record, a Firebase Realtime Database
// entry, or a level-editor draft in localStorage) and merges it into a base
// "recipe" object describing enemies, bosses, the player, the stage atlas and
// custom audio.
//
// This logic was extracted from the 2019-es7 game's BootScene, where it lived
// inline and was hard-wired to that game's `gameState`/constants. Here it is a
// self-contained, reusable plugin: the game-specific bits (which base recipe to
// merge into, the atlas/texture keys, how to prime per-stage state) are passed
// in as options instead of being baked in.
//
// USAGE
//   import { levelLoaderScenePluginConfig } from "/phaser-plugins/level-loader.js";
//
//   const config = {
//     type: Phaser.WEBGL,
//     scene: BootScene,
//     plugins: {
//       scene: [levelLoaderScenePluginConfig({ mapping: "levelLoader" })],
//     },
//   };
//   new Phaser.Game(config);
//
//   // ...then inside a scene that preloaded the base recipe + atlas:
//   class BootScene extends Phaser.Scene {
//     create() {
//       this.levelLoader.loadLevel({
//         baseRecipeKey: "recipe",
//         atlasKey: "game_asset",
//         onPrimeState: (recipe, info) => primeGameState(recipe, info.stageId),
//       }).then((result) => {
//         this.scene.start(result.showTitle ? "TitleScene" : "GameScene");
//       });
//     }
//   }
//
// Phaser must be loaded before `createLevelLoaderPlugin` is called. Because the
// plugin class extends `Phaser.Plugins.ScenePlugin`, it is produced lazily by a
// factory rather than at module-evaluation time, so importing this module never
// depends on Phaser already being present.
//
// Besides the plugin, this module exports the Phaser-free helpers the level
// EDITOR (static/editor/index.html) shares with the game: level-name/Firebase
// key sanitizing, stage-id clamping, the custom-audio IndexedDB opener, the
// Firebase database bootstrap, and DEFAULTS (the editor-play localStorage keys
// and custom-audio DB names live there). Keeping them here means the editor
// writes exactly what the plugin reads.

export const DEFAULTS = {
  defaultLevel: "foo",
  baseRecipeKey: "recipe",
  levelsPath: "levels",
  atlasKey: "game_asset",
  // stage0..stage9 — Dezaemon 2's own maximum, and what the 2019-es7 runtime
  // plays. Only five sets of per-stage backgrounds and voices exist, so stage
  // 5 and up reuse them (stageId % 5); see 2019-es7 src/phaser/stages.js.
  maxStage: 9,
  editorRecipeKey: "__editorPhaserRecipe__",
  editorStageKey: "__editorPhaserStageId__",
  fallbackOnError: true,
  lowMode: false,
  // Firebase data keys that carry a base64 image, mapped to the texture key to
  // create. `replace: true` removes any existing texture of that key first.
  titleImageKeys: {
    titleBgDataURL: { key: "title_bg", replace: true },
    logoDataURL: { key: "custom_logo", replace: false },
    subTitleDataURL: { key: "custom_subTitle", replace: false },
    titleStartTextDataURL: { key: "custom_titleStartText", replace: false },
  },
  audio: {
    enabled: true,
    dbName: "editorCustomAudio",
    store: "customAudio",
    customBgmDir: "assets/custom-bgm/",
    manifestKey: "custom-bgm-manifest",
    baseUrlElementId: "baseUrl",
  },
  // Where the level editor publishes its working atlas, keyed per atlas
  // ("atlas:game_asset", "atlas:game_ui"), so which atlas the editor happens
  // to have open does not decide what the game gets.
  editorAtlas: {
    enabled: true,
    dbName: "editorViewerBridge",
    store: "assets",
    keyPrefix: "atlas:",
  },
};

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

// One stage of a level record, in the shape the game scene reads: the wave
// grid, the per-wave scroll rows that keep an imported stage's pacing (only
// meaningful with one entry per wave, or the runtime gets a mismatched pair),
// and the tile grid that replaces the stock backdrop. Used for both the flat
// open-stage fields and each entry of the `stages` map.
function stageRecordFromLevel(src) {
  if (!src || !Array.isArray(src.enemylist) || !src.enemylist.length) {
    return null;
  }
  const stage = { enemylist: src.enemylist };
  if (
    Array.isArray(src.waveRows) &&
    src.waveRows.length === src.enemylist.length
  ) {
    stage.waveRows = src.waveRows;
    if (Number.isFinite(src.waveInterval) && src.waveInterval > 0) {
      stage.waveInterval = src.waveInterval;
    }
  }
  if (src.background) stage.background = src.background;
  if (src.items) stage.items = src.items;
  return stage;
}

function readParam(name) {
  if (typeof globalThis === "undefined" || !globalThis.location) {
    return null;
  }
  try {
    return new URLSearchParams(globalThis.location.search).get(name);
  } catch (_e) {
    return null;
  }
}

export function sanitizeLevelName(name) {
  return name ? name.replace(/[.#$/\[\]]/g, "_").trim() : null;
}

// Firebase RTDB keys can't contain "." — encode it as the one-dot-leader
// character (U+2024) on write, and decode it back on read.
export function encodeFirebaseKey(key) {
  return key.replace(/\./g, "\u2024");
}

export function decodeFirebaseKey(key) {
  return key.replace(/\u2024/g, ".");
}

export function parseStageId(value, maxStage) {
  const stageId = Number(value);
  if (!Number.isFinite(stageId)) {
    return 0;
  }
  return Math.max(0, Math.min(maxStage, Math.floor(stageId)));
}

export function openCustomAudioDB(dbName, store) {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB not available"));
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(store)) {
        db.createObjectStore(store);
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function loadImage(src) {
  if (typeof Image === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const isBlob = typeof Blob !== "undefined" && src instanceof Blob;
    const url = isBlob ? URL.createObjectURL(src) : src;
    const img = new Image();
    const done = (value) => {
      if (isBlob) URL.revokeObjectURL(url);
      resolve(value);
    };
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = url;
  });
}

// Read the editor's published atlas record. Resolves null whenever there is
// nothing usable — no IndexedDB, no bridge, no record for this atlas.
function readEditorAtlasBridge(atlasKey, opts) {
  const o = opts || DEFAULTS.editorAtlas;
  if (o.enabled === false || typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let req;
    try {
      // Open without a version so an existing bridge is read at whatever
      // version the editor made it.
      req = indexedDB.open(o.dbName);
    } catch (_e) {
      resolve(null);
      return;
    }
    // Opening a database that does not exist creates it. If that happens here
    // — the editor has never run in this browser — the empty database we just
    // made would be left behind for the editor to trip over, so throw our
    // accidental creation away.
    let created = false;
    req.onupgradeneeded = () => {
      created = true;
    };
    req.onerror = () => resolve(null);
    req.onsuccess = (e) => {
      const db = e.target.result;
      if (created || !db.objectStoreNames.contains(o.store)) {
        try {
          db.close();
          if (created) indexedDB.deleteDatabase(o.dbName);
        } catch (_e) { /* nothing to undo */ }
        resolve(null);
        return;
      }
      try {
        const tx = db.transaction(o.store, "readonly");
        const recordReq = tx.objectStore(o.store).get(o.keyPrefix + atlasKey);
        tx.oncomplete = () => {
          const record = recordReq.result;
          resolve(
            record && record.frames && record.blob
              ? { frames: record.frames, blob: record.blob }
              : null,
          );
        };
        tx.onerror = () => resolve(null);
      } catch (_e) {
        resolve(null);
      }
    };
  });
}

function getAllCustomAudioEntries(dbName, store) {
  return openCustomAudioDB(dbName, store).then((db) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const objectStore = tx.objectStore(store);
      const entries = {};
      const cursorReq = objectStore.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          entries[cursor.key] = cursor.value;
          cursor.continue();
        } else {
          resolve(entries);
        }
      };
      cursorReq.onerror = (e) => reject(e.target.error);
    })
  );
}

// Resolve a Realtime Database handle from the compat firebase SDK, initializing
// the default app from `config` when none exists yet.
export function getFirebaseDatabase(firebase, config) {
  if (typeof firebase === "undefined" || !firebase || !firebase.database) {
    throw new Error("Firebase not available");
  }
  if (!firebase.apps || firebase.apps.length === 0) {
    if (!config) {
      throw new Error("No Firebase config");
    }
    firebase.initializeApp(config);
  }
  return firebase.database();
}

export function createLevelLoaderPlugin(Phaser = globalThis.Phaser) {
  if (!Phaser || !Phaser.Plugins || !Phaser.Plugins.ScenePlugin) {
    throw new Error(
      "createLevelLoaderPlugin: Phaser.Plugins.ScenePlugin is unavailable — load Phaser before calling this factory.",
    );
  }

  return class LevelLoaderPlugin extends Phaser.Plugins.ScenePlugin {
    constructor(scene, pluginManager, pluginKey) {
      super(scene, pluginManager, pluginKey);
    }

    // ---- URL parameter readers --------------------------------------------

    readLevelParam() {
      return sanitizeLevelName(readParam("level"));
    }

    readStageParam() {
      return readParam("stage");
    }

    readBossRushParam() {
      return readParam("bossRush") === "1";
    }

    // Editor "play" requests skip the network entirely: the level editor writes
    // a recipe draft to localStorage and navigates here with `?editorPlay=1`.
    readEditorPlayRequest(opts) {
      const o = opts || {};
      const recipeKey = o.editorRecipeKey || DEFAULTS.editorRecipeKey;
      const stageKey = o.editorStageKey || DEFAULTS.editorStageKey;
      const maxStage = o.maxStage != null ? o.maxStage : DEFAULTS.maxStage;

      if (typeof globalThis === "undefined" || readParam("editorPlay") !== "1") {
        return null;
      }

      let recipeText = null;
      try {
        recipeText = localStorage.getItem(recipeKey);
      } catch (_e) { /* localStorage may be blocked */ }
      if (!recipeText) {
        return null;
      }

      try {
        return {
          recipe: JSON.parse(recipeText),
          stageId: parseStageId(
            readParam("stage") || localStorage.getItem(stageKey) || 0,
            maxStage,
          ),
        };
      } catch (_e) {
        return null;
      }
    }

    // ---- Source resolution ------------------------------------------------

    // Resolve the raw level record. Priority: an offline-baked record on
    // `globalThis.__OFFLINE_LEVEL__` (build tooling inlines it so there is no
    // network dependency), otherwise Firebase Realtime Database.
    fetchLevel(levelName, opts) {
      const o = opts || {};
      const offline = o.offlineLevel !== undefined
        ? o.offlineLevel
        : (typeof globalThis !== "undefined" ? globalThis.__OFFLINE_LEVEL__ : null);
      if (offline) {
        return Promise.resolve(offline);
      }

      const firebase = o.firebase || (typeof globalThis !== "undefined" ? globalThis.firebase : undefined);
      const config = o.firebaseConfig ||
        (typeof globalThis !== "undefined" ? (globalThis.firebaseConfig || globalThis.__FIREBASE_CONFIG__) : null);
      let db;
      try {
        db = getFirebaseDatabase(firebase, config);
      } catch (err) {
        return Promise.reject(err);
      }

      const levelsPath = o.levelsPath || DEFAULTS.levelsPath;
      return db.ref(levelsPath + "/" + levelName).once("value").then((snapshot) => {
        const data = snapshot.val();
        if (!data || !data.enemylist) {
          throw new Error('Level "' + levelName + '" not found');
        }
        return data;
      });
    }

    // ---- Atlas merge ------------------------------------------------------

    // A level may ship its own atlas (base64 PNG + frame map). Stack it beneath
    // the local atlas in a single canvas so both local frames (player/UI) and
    // level frames (enemies) resolve from one texture. Resolves once merged (or
    // immediately, if the level carries no atlas).
    mergeAtlas(levelData, atlasKey) {
      if (!levelData || !levelData.atlasImageDataURL || !levelData.atlasFrames) {
        return Promise.resolve(false);
      }
      return loadImage(levelData.atlasImageDataURL).then((img) => {
        if (!img) {
          console.warn("Level atlas image failed to load, using local atlas");
          return false;
        }
        return this._stackAtlas(img, levelData.atlasFrames, atlasKey);
      });
    }

    // Stack `image` beneath the loaded atlas and rebuild the frame map so both
    // sets resolve from one texture. Incoming frames win on a name collision —
    // they are the customization — and .gif/.png spellings of the same name are
    // treated as the same frame, since the editor and Firebase disagree on the
    // suffix.
    //
    // Stacking rather than replacing matters: the incoming atlas may be missing
    // frames the runtime needs (player00.gif and friends), and those keep
    // resolving from the local copy instead of disappearing.
    _stackAtlas(image, frames, atlasKey) {
      const scene = this.scene;
      try {
        const localAtlas = scene.textures.get(atlasKey);
        const localSource = localAtlas && localAtlas.source && localAtlas.source[0]
          ? localAtlas.source[0].image
          : null;
        const localFrames = localAtlas ? localAtlas.frames : {};
        if (!localSource) {
          return false;
        }

        const localW = localSource.width;
        const localH = localSource.height;
        const mergedCanvas = document.createElement("canvas");
        mergedCanvas.width = Math.max(localW, image.width);
        mergedCanvas.height = localH + image.height;
        const mctx = mergedCanvas.getContext("2d");
        mctx.drawImage(localSource, 0, 0);
        mctx.drawImage(image, 0, localH);

        const mergedFrameMap = {};
        for (const lk in localFrames) {
          if (lk === "__BASE") continue;
          const lf = localFrames[lk];
          if (lf && lf.cutX !== undefined) {
            mergedFrameMap[lk] = {
              frame: { x: lf.cutX, y: lf.cutY, w: lf.cutWidth, h: lf.cutHeight },
            };
          }
        }
        // Incoming frames are offset down by the local atlas height.
        for (const fname in frames) {
          const decodedName = decodeFirebaseKey(fname);
          const fd = frames[fname];
          if (fd && fd.frame) {
            const frameData = {
              frame: { x: fd.frame.x, y: fd.frame.y + localH, w: fd.frame.w, h: fd.frame.h },
            };
            mergedFrameMap[decodedName] = frameData;
            // Let a .png replacement also satisfy a .gif lookup (and vice
            // versa) so animations find the swapped-in frames.
            let altName = null;
            if (decodedName.endsWith(".png")) {
              altName = decodedName.slice(0, -4) + ".gif";
            } else if (decodedName.endsWith(".gif")) {
              altName = decodedName.slice(0, -4) + ".png";
            }
            if (altName && mergedFrameMap[altName]) {
              mergedFrameMap[altName] = frameData;
            }
          }
        }

        scene.textures.remove(atlasKey);
        scene.textures.addAtlas(atlasKey, mergedCanvas, { frames: mergedFrameMap });
        return true;
      } catch (atlasErr) {
        console.warn("Failed to merge atlas:", atlasErr);
        return false;
      }
    }

    // The level EDITOR's working atlas, which it republishes to IndexedDB on
    // every change (one record per atlas key). An editor "play" hands over a
    // recipe of texture *names* through localStorage but no art, so without
    // this every frame the editor added — an uploaded sprite, a Dezaemon
    // import, the default player's own frames — resolves to the local atlas's
    // frame 0. Resolves false (never rejects) when there is nothing to merge.
    mergeEditorAtlas(opts) {
      const o = opts || {};
      const atlasKey = o.atlasKey || DEFAULTS.atlasKey;
      const bridge = Object.assign({}, DEFAULTS.editorAtlas, o.editorAtlas || {});
      return readEditorAtlasBridge(atlasKey, bridge)
        .then((record) => {
          if (!record) return false;
          return loadImage(record.blob).then((img) =>
            img ? this._stackAtlas(img, record.frames, atlasKey) : false
          );
        })
        .catch((err) => {
          console.warn("Editor atlas bridge unavailable, using on-disk art:", err);
          return false;
        });
    }

    // ---- Recipe merge -----------------------------------------------------

    // Merge a level's enemy/boss/player/story data into a (cloned) base recipe.
    // For cross-game levels, a referenced texture may not exist in the loaded
    // atlas; in that case we keep the local texture so the entity still renders.
    mergeRecipe(baseRecipe, levelData, atlasKey) {
      const recipe = deepClone(baseRecipe) || {};
      const localEnemyData = recipe.enemyData ? deepClone(recipe.enemyData) : {};

      const stageKey = levelData.stageKey || "stage0";
      // The flat fields are the level's open stage — the only shape records
      // written before multi-stage saves have.
      recipe[stageKey] = stageRecordFromLevel(levelData) ||
        { enemylist: levelData.enemylist };
      // A newer record carries every other stage of the game under `stages`,
      // so ?stage=3 plays stage 3's own enemies and scenery instead of falling
      // through to the base recipe's stage of that number. A .sav import is
      // 5-14 stages and only one of them used to travel.
      if (levelData.stages && typeof levelData.stages === "object") {
        for (const sKey of Object.keys(levelData.stages)) {
          if (!/^stage\d+$/.test(sKey)) continue;
          const sRec = stageRecordFromLevel(levelData.stages[sKey]);
          if (sRec) recipe[sKey] = sRec;
        }
      }
      // The cell list every stage's tile grid indexes into. Both halves must
      // travel or the runtime draws nothing.
      if (Array.isArray(levelData.backgroundCells)) {
        recipe.backgroundCells = levelData.backgroundCells;
      }
      // A Dezaemon import's soundtrack: dezaemon-runtime.js sequences it
      // straight out of the recipe, and no other path supplies music for such
      // a level — there is no mp3 in customAudioURLs to fall back on — so
      // without this the level plays in silence. Its own per-stage table
      // assigns a (main, boss) pair per stage, which only pays off now that
      // every stage is reachable.
      if (levelData.dezaemonBgm && typeof levelData.dezaemonBgm === "object") {
        recipe.dezaemonBgm = levelData.dezaemonBgm;
      }
      // The import's drawn title screen (atlas frame names), its no-story
      // flag and its community credits ride the recipe: the runtime's title
      // scene, the AdvScene skip and the staff roll read them from there.
      if (levelData.dezaemonTitle && typeof levelData.dezaemonTitle === "object") {
        recipe.dezaemonTitle = levelData.dezaemonTitle;
      }
      if (levelData.dezaemonCredits && typeof levelData.dezaemonCredits === "object") {
        recipe.dezaemonCredits = levelData.dezaemonCredits;
      }
      if (typeof levelData.noStory === "boolean") {
        recipe.noStory = levelData.noStory;
      }
      if (typeof levelData.godMode === "boolean") {
        recipe.godMode = levelData.godMode;
      }

      const atlasFrames = (() => {
        try {
          const atlas = this.scene.textures.get(atlasKey);
          return atlas && atlas.frames ? atlas.frames : null;
        } catch (_e) {
          return null;
        }
      })();

      if (levelData.enemyData) {
        const merged = deepClone(levelData.enemyData);
        if (atlasFrames) {
          for (const ek in merged) {
            const fbTextures = merged[ek] && merged[ek].texture ? merged[ek].texture : [];
            if (fbTextures.length > 0 && !atlasFrames[fbTextures[0]]) {
              const localEnemy = localEnemyData[ek];
              if (localEnemy && localEnemy.texture && localEnemy.texture.length > 0) {
                merged[ek].texture = localEnemy.texture;
              }
              const projKey = merged[ek].projectileData
                ? "projectileData"
                : (merged[ek].bulletData ? "bulletData" : null);
              const localProjKey = localEnemy
                ? (localEnemy.projectileData ? "projectileData" : (localEnemy.bulletData ? "bulletData" : null))
                : null;
              if (projKey && localProjKey && merged[ek][projKey] && merged[ek][projKey].texture) {
                const fbProjTex = merged[ek][projKey].texture;
                if (
                  fbProjTex.length > 0 && !atlasFrames[fbProjTex[0]] &&
                  localEnemy[localProjKey] && localEnemy[localProjKey].texture
                ) {
                  merged[ek][projKey].texture = localEnemy[localProjKey].texture;
                }
              }
            }
          }
        }
        recipe.enemyData = merged;
      }

      if (levelData.bossData) {
        const mergedBoss = deepClone(levelData.bossData);
        const localBossData = recipe.bossData ? deepClone(recipe.bossData) : {};
        if (atlasFrames) {
          for (const bk in mergedBoss) {
            const fb = mergedBoss[bk];
            const lb = localBossData[bk];
            if (fb && fb.anim) {
              for (const ak in fb.anim) {
                if (ak.startsWith("_")) continue;
                const fbAnim = fb.anim[ak];
                if (Array.isArray(fbAnim) && fbAnim.length > 0 && !atlasFrames[fbAnim[0]]) {
                  if (lb && lb.anim && lb.anim[ak]) {
                    fb.anim[ak] = lb.anim[ak];
                  }
                }
              }
            }
            if (fb && fb.bulletData && fb.bulletData.texture) {
              const fbBulletTex = fb.bulletData.texture;
              if (fbBulletTex.length > 0 && !atlasFrames[fbBulletTex[0]]) {
                if (lb && lb.bulletData && lb.bulletData.texture) {
                  fb.bulletData.texture = lb.bulletData.texture;
                }
              }
            }
          }
        }
        recipe.bossData = mergedBoss;
      }

      if (levelData.storyData) {
        recipe.storyData = levelData.storyData;
      }

      // Player scene scripts (title/adv hooks or replacements) ride along the
      // recipe; the scene-script runtime reads recipe.sceneScripts.
      if (levelData.sceneScripts && typeof levelData.sceneScripts === "object") {
        recipe.sceneScripts = levelData.sceneScripts;
      }

      if (levelData.playerData && typeof levelData.playerData === "object") {
        const localPlayer = recipe.playerData ? deepClone(recipe.playerData) : {};
        const mergedPlayer = Object.assign(localPlayer, deepClone(levelData.playerData));
        if (atlasFrames) {
          const shootKeys = ["shootNormal", "shootBig", "shoot3way"];
          for (let sk = 0; sk < shootKeys.length; sk++) {
            const shootEntry = mergedPlayer[shootKeys[sk]];
            const localShoot = recipe.playerData && recipe.playerData[shootKeys[sk]];
            if (
              shootEntry && shootEntry.texture && shootEntry.texture.length > 0 &&
              !atlasFrames[shootEntry.texture[0]]
            ) {
              if (localShoot && localShoot.texture && localShoot.texture.length > 0) {
                shootEntry.texture = localShoot.texture;
              }
            }
          }
        }
        recipe.playerData = mergedPlayer;
      }

      return recipe;
    }

    // ---- Title imagery ----------------------------------------------------

    // Add/replace branding textures (title background, logo, etc.) from any
    // base64 images the level carries.
    applyTitleImages(levelData, keyMap) {
      const scene = this.scene;
      const map = keyMap || DEFAULTS.titleImageKeys;
      for (const dataKey in map) {
        const dataURL = levelData[dataKey];
        if (!dataURL) continue;
        const spec = map[dataKey];
        const textureKey = spec.key;
        const replace = !!spec.replace;
        const img = new Image();
        img.onload = () => {
          try {
            if (replace) {
              scene.textures.remove(textureKey);
            }
            scene.textures.addImage(textureKey, img);
          } catch (e) {
            console.warn('Failed to load custom "' + textureKey + '":', e);
          }
        };
        img.src = dataURL;
      }
    }

    // ---- Custom audio -----------------------------------------------------

    // Gather custom audio blobs from IndexedDB (browser/editor flow) and, when
    // present, the Electron filesystem bridge (disk wins over IndexedDB).
    collectCustomAudioEntries(opts) {
      const o = opts || {};
      const dbName = o.dbName || DEFAULTS.audio.dbName;
      const store = o.store || DEFAULTS.audio.store;
      const entries = {};

      const idbPromise = getAllCustomAudioEntries(dbName, store).then((idbEntries) => {
        for (const k in idbEntries) {
          entries[k] = idbEntries[k];
        }
      }).catch(() => {});

      let electronPromise;
      if (
        typeof globalThis !== "undefined" && globalThis.electronAudio &&
        typeof globalThis.electronAudio.loadCustomAudio === "function"
      ) {
        electronPromise = globalThis.electronAudio.loadCustomAudio().then((diskEntries) => {
          for (const k in diskEntries) {
            entries[k] = diskEntries[k];
          }
        }).catch((err) => {
          console.warn("Electron custom audio load failed:", err);
        });
      } else {
        electronPromise = Promise.resolve();
      }

      return Promise.all([idbPromise, electronPromise]).then(() => entries);
    }

    // Queue the level's remote BGM URL overrides onto the scene loader,
    // preferring locally downloaded copies. Returns the discovered source URLs.
    _queueAudioOverrides(levelData, opts) {
      const scene = this.scene;
      const sourceURLs = {};
      if (!levelData.customAudioURLs || typeof levelData.customAudioURLs !== "object") {
        return sourceURLs;
      }

      const manifestKey = opts.manifestKey || DEFAULTS.audio.manifestKey;
      const customBgmDir = opts.customBgmDir || DEFAULTS.audio.customBgmDir;
      const baseUrlEl = typeof document !== "undefined"
        ? document.getElementById(opts.baseUrlElementId || DEFAULTS.audio.baseUrlElementId)
        : null;
      const baseUrl = baseUrlEl ? baseUrlEl.textContent.trim() : "./";
      const manifest = scene.cache.json.exists(manifestKey)
        ? (scene.cache.json.get(manifestKey) || {})
        : {};

      for (const uKey in levelData.customAudioURLs) {
        const uUrl = levelData.customAudioURLs[uKey];
        if (uUrl && typeof uUrl === "string") {
          const localFilename = manifest[uKey] || (uKey + ".mp3");
          const localPath = baseUrl + customBgmDir + localFilename;
          sourceURLs[uKey] = uUrl;
          if (scene.cache.audio.exists(uKey)) {
            scene.cache.audio.remove(uKey);
          }
          scene.load.audio(uKey, [localPath, uUrl]);
        }
      }
      return sourceURLs;
    }

    // Queue every audio source (URL overrides + collected blobs), run the
    // loader once, and resolve with the level's BGM source URL map. Resolves
    // immediately when low mode is on or nothing needs loading.
    _loadAudio(levelData, opts, lowMode) {
      const scene = this.scene;
      if (lowMode || !opts.enabled) {
        return Promise.resolve(this._queueOnlySourceURLs(levelData));
      }

      const sourceURLs = this._queueAudioOverrides(levelData, opts);
      // Each entry in sourceURLs queued exactly one loader job above.
      let queuedCount = Object.keys(sourceURLs).length;

      return this.collectCustomAudioEntries(opts).then((entries) => {
        const blobURLs = [];
        for (const key in entries) {
          const data = entries[key];
          const blob = data instanceof Blob ? data : new Blob([data], { type: "audio/mpeg" });
          const url = URL.createObjectURL(blob);
          blobURLs.push(url);
          if (scene.cache.audio.exists(key)) {
            scene.cache.audio.remove(key);
          }
          scene.load.audio(key, url);
          queuedCount++;
        }

        if (queuedCount === 0) {
          return sourceURLs;
        }

        return new Promise((resolve) => {
          scene.load.once("complete", () => {
            for (let j = 0; j < blobURLs.length; j++) {
              URL.revokeObjectURL(blobURLs[j]);
            }
            resolve(sourceURLs);
          });
          scene.load.start();
        });
      }).catch((err) => {
        console.warn("Custom audio load failed:", err);
        return sourceURLs;
      });
    }

    // Discover BGM source URLs without queuing loads (low-mode path).
    _queueOnlySourceURLs(levelData) {
      const sourceURLs = {};
      if (levelData && levelData.customAudioURLs && typeof levelData.customAudioURLs === "object") {
        for (const uKey in levelData.customAudioURLs) {
          const uUrl = levelData.customAudioURLs[uKey];
          if (uUrl && typeof uUrl === "string") {
            sourceURLs[uKey] = uUrl;
          }
        }
      }
      return sourceURLs;
    }

    // ---- Orchestration ----------------------------------------------------

    // Resolve, merge and apply a level, returning a description the caller uses
    // to drive scene flow:
    //   { recipe, stageId, hasCustomEnemies, showTitle, bossRush, source,
    //     levelName, bgmSourceURLs }
    // `source` is one of "editor" | "firebase" | "offline" | "fallback".
    loadLevel(options) {
      const o = Object.assign({}, DEFAULTS, options || {});
      o.titleImageKeys = (options && options.titleImageKeys) || DEFAULTS.titleImageKeys;
      o.audio = Object.assign({}, DEFAULTS.audio, (options && options.audio) || {});

      const scene = this.scene;
      const baseRecipe = o.baseRecipe !== undefined
        ? o.baseRecipe
        : scene.cache.json.get(o.baseRecipeKey);
      const bossRush = this.readBossRushParam();

      const prime = (recipe, info) => {
        if (typeof o.onPrimeState === "function") {
          o.onPrimeState(recipe, info);
        }
      };

      // 1) Editor draft (localStorage) — skips the network entirely. Its art
      //    comes from the editor's IndexedDB atlas bridge, not from the record.
      const editorPlay = this.readEditorPlayRequest(o);
      if (editorPlay && editorPlay.recipe) {
        const recipe = deepClone(editorPlay.recipe);
        let hasCustomEnemies = false;
        try {
          hasCustomEnemies = !!(recipe.enemyData && baseRecipe && baseRecipe.enemyData) &&
            JSON.stringify(recipe.enemyData) !== JSON.stringify(baseRecipe.enemyData);
        } catch (_e) { /* ignore */ }
        const stageId = parseStageId(editorPlay.stageId, o.maxStage);
        const info = { stageId, bossRush, source: "editor", hasCustomEnemies };
        return this.mergeEditorAtlas(o).then(() => {
          prime(recipe, info);
          return {
            recipe,
            stageId,
            hasCustomEnemies,
            showTitle: false,
            bossRush,
            source: "editor",
            levelName: null,
            bgmSourceURLs: {},
          };
        });
      }

      // 2) Network/offline level. An explicit ?level= jumps straight into the
      //    game; the default level shows the title first.
      const explicitLevel = this.readLevelParam();
      const levelName = explicitLevel || o.defaultLevel;
      const showTitle = !explicitLevel;
      const stageParam = this.readStageParam();
      const usingOffline = o.offlineLevel !== undefined
        ? !!o.offlineLevel
        : (typeof globalThis !== "undefined" && !!globalThis.__OFFLINE_LEVEL__);

      return this.fetchLevel(levelName, o).then((data) =>
        this.mergeAtlas(data, o.atlasKey).then(() => {
          const recipe = this.mergeRecipe(baseRecipe, data, o.atlasKey);
          this.applyTitleImages(data, o.titleImageKeys);

          const stageKey = data.stageKey || "stage0";
          const stageId = stageParam != null
            ? parseStageId(stageParam, o.maxStage)
            : parseStageId(stageKey.replace("stage", ""), o.maxStage);
          const hasCustomEnemies = !!data.enemyData;
          const source = usingOffline ? "offline" : "firebase";

          prime(recipe, { stageId, bossRush, source, hasCustomEnemies });

          return this._loadAudio(data, o.audio, o.lowMode).then((bgmSourceURLs) => ({
            recipe,
            stageId,
            hasCustomEnemies,
            showTitle,
            bossRush,
            source,
            levelName,
            bgmSourceURLs,
          }));
        })
      ).catch((err) => {
        console.warn("Level load failed for '" + levelName + "':", err);
        if (!o.fallbackOnError) {
          throw err;
        }
        // Fall back to the base recipe so the game can still boot.
        const recipe = deepClone(baseRecipe) || {};
        const stageId = stageParam != null ? parseStageId(stageParam, o.maxStage) : 0;
        prime(recipe, { stageId, bossRush, source: "fallback", hasCustomEnemies: false });
        return {
          recipe,
          stageId,
          hasCustomEnemies: false,
          showTitle: true,
          bossRush,
          source: "fallback",
          levelName,
          bgmSourceURLs: {},
        };
      });
    }
  };
}

// Convenience: build the entry for a Phaser game config's `plugins.scene`
// array. `mapping` is the property the plugin is exposed as on each scene.
export function levelLoaderScenePluginConfig(opts) {
  const o = opts || {};
  return {
    key: o.key || "LevelLoader",
    plugin: createLevelLoaderPlugin(o.Phaser),
    mapping: o.mapping || "levelLoader",
  };
}

export default createLevelLoaderPlugin;
