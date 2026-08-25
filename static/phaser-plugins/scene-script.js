// Scene Script — player-authored customization of a game's intro scenes.
//
// Games that support the CMG Level Editor (2028-ai, 2019-turbo, ...) let the
// player attach a script to the TitleScene and/or the story interlude
// ("level intro" — AdvScene). A script can HOOK the default scene (run extra
// logic when the scene starts and when it hands off) or REPLACE the scene
// entirely. Scripts get a `ctx` with the current scene, the live list of its
// GameObjects, the shared game state and a `next()` continuation.
//
// SCRIPT SOURCES (resolved in priority order by resolveSceneScriptEntries):
//   1. Level-editor hand-off: `?editorPlay=1` + localStorage
//      "__editorSceneScripts__"  = { title?: entry, adv?: entry }
//   2. Query params: ?titleScript=<url|gist:spec> / ?advScript=<url|gist:spec>
//      (+ ?titleScriptMode=replace / ?advScriptMode=replace)
//   3. The level recipe: recipe.sceneScripts = { title?: entry, adv?: entry }
//      (carried by Firebase levels, offline-baked levels and game.json)
//
// ENTRY SHAPE (what the editor stores):
//   { mode: "hook"|"replace",
//     sourceType: "url"|"inline"|"gist",
//     url?,                                  // sourceType "url"
//     code?, lang?: "js"|"ts"|"svelte",      // sourceType "inline"
//     compiledJs?,                           // editor-compiled inline source
//     gist?: { user, id, file?, rev? } }     // rev: "latest" (default) | sha
//
// MODULE CONTRACT (what the loaded script exports as `default`):
//   {
//     onStart(ctx)              // hook mode: scene finished building itself
//     onEnd(ctx)                // hook mode: scene is about to hand off.
//                               //   return true  -> you own the transition,
//                               //                   call ctx.next() yourself
//                               //   return Promise -> transition waits; auto-
//                               //                   continues unless it
//                               //                   resolves to true
//     create(ctx)               // replace mode: build the whole scene
//     update(ctx, time, delta)  // optional per-frame tick
//   }
//   A bare `export default function (ctx) {...}` is treated as onStart (hook
//   mode) or create (replace mode). A compiled .svelte component (marker
//   `export const __svelte = true`) is mounted as a DOM overlay above the
//   canvas with `{ ctx }` as props.
//
// CTX:
//   { scene, game, Phaser, state, target, stageId,
//     gameObjects,        // live snapshot of scene.children.list
//     find(name),         // GameObject by .name or scene property (e.g. "logo")
//     overlay(),          // DOM <div> positioned over the canvas
//     next(),             // continue the default flow (idempotent)
//     onCleanup(fn) }     // run fn when the scene shuts down
//
// TypeScript sources are transpiled with sucrase, .svelte sources compiled
// with the Svelte 5 compiler — both loaded lazily from esm.sh only when such
// a script is actually used. Plain .js scripts never touch the CDN.
//
// This module is dependency-free and is shared VERBATIM with the standalone
// 2019-turbo repo (src/scene-script.js there) — keep the two copies in sync.

export const SCENE_SCRIPT_DEFAULTS = {
  editorKey: "__editorSceneScripts__",
  targets: {
    title: { param: "titleScript", modeParam: "titleScriptMode" },
    adv: { param: "advScript", modeParam: "advScriptMode" },
  },
  defaultGistUser: "easierbycode",
  gistApiBase: "https://api.github.com/gists",
  gistUserApiBase: "https://api.github.com/users",
  sucraseCdn: "https://esm.sh/sucrase@3.35.0",
  svelteCdn: "https://esm.sh/svelte@5.16.0",
  // The importable characters library. GitHub Pages can't serve the bare URL
  // as JavaScript, so imports of it are rewritten to the real module — the
  // browser build, whose svelte imports are pinned to svelteCdn so characters
  // share one runtime with compiled scene scripts.
  charactersUrl: "https://easierbycode.com/2019-es7/characters",
  charactersModule: "https://easierbycode.com/2019-es7/characters/browser.js",
};

// Where characters imports actually resolve. Pages served by the cmg app set
// __CHARACTERS_MODULE__ to their own /characters route (see routes/characters/
// index.ts), whose named exports are generated from the database per request —
// characters created moments ago import by name with no rebuild. Everything
// else (offline/standalone exports, other hosts) keeps the static build.
export function charactersModuleUrl() {
  return (typeof globalThis !== "undefined" && globalThis.__CHARACTERS_MODULE__) ||
    SCENE_SCRIPT_DEFAULTS.charactersModule;
}

export const SCENE_SCRIPT_TARGETS = ["title", "adv"];

// Indirect dynamic import: keeps bundlers (esbuild iife) from trying to
// resolve/transform a runtime-variable import().
function dynImport(url) {
  return new Function("u", "return import(u)")(url);
}

function readParam(name) {
  if (typeof globalThis === "undefined" || !globalThis.location) return null;
  try {
    return new URLSearchParams(globalThis.location.search).get(name);
  } catch (_e) {
    return null;
  }
}

export function inferSceneScriptLang(filename) {
  const f = String(filename || "").split(/[?#]/)[0].toLowerCase();
  if (f.endsWith(".svelte")) return "svelte";
  if (f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".mts")) return "ts";
  return "js";
}

function normalizeBaseUrl(base) {
  if (!base) return base;
  try {
    const u = new URL(base);
    if (!u.pathname.endsWith("/") && !/\.[a-z0-9]+$/i.test(u.pathname)) {
      u.pathname += "/";
    }
    return u.href;
  } catch (_e) {
    return base;
  }
}

export function resolveScriptUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  if (/^(?:[a-z]+:|\/\/)/i.test(rawUrl)) {
    return rawUrl;
  }
  const relPath = rawUrl.replace(/^\/+/, "");
  let base;
  if (typeof document !== "undefined" && document.baseURI) {
    base = document.baseURI;
  } else if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.href) {
    base = globalThis.location.href;
  }
  if (base) {
    return new URL(relPath, normalizeBaseUrl(base)).href;
  }
  return rawUrl;
}

// ---- Compilation (lazy CDN) -----------------------------------------------

export async function compileTypeScript(code) {
  const sucrase = await dynImport(SCENE_SCRIPT_DEFAULTS.sucraseCdn);
  const transform = sucrase.transform || (sucrase.default && sucrase.default.transform);
  if (!transform) throw new Error("sucrase transform unavailable");
  return transform(code, { transforms: ["typescript"] }).code;
}

export async function compileSvelte(code, filename) {
  const compiler = await dynImport(SCENE_SCRIPT_DEFAULTS.svelteCdn + "/compiler");
  const compile = compiler.compile || (compiler.default && compiler.default.compile);
  if (!compile) throw new Error("svelte compiler unavailable");
  const out = compile(code, {
    filename: filename || "SceneScript.svelte",
    generate: "client",
    css: "injected", // keep <style> blocks — there is no separate .css file at runtime
  });
  // The compiled component imports bare "svelte/*" specifiers; point them at
  // the same CDN build the runtime uses so mount()/component share a runtime.
  let js = out.js.code.replace(
    /((?:from|import)\s*\(?\s*)(["'])(svelte(?:\/[^"']*)?)\2/g,
    (_m, pre, q, spec) =>
      pre + q + SCENE_SCRIPT_DEFAULTS.svelteCdn + spec.slice("svelte".length) + q,
  );
  js += "\nexport const __svelte = true;\n";
  return js;
}

// Rewrite imports of the bare characters-library URL (with or without a
// trailing "/") to the actual browser module. Applied to every script lang —
// the bare URL is documentation-friendly but not directly fetchable.
export function rewriteCharacterImports(code) {
  const { charactersUrl } = SCENE_SCRIPT_DEFAULTS;
  const target = charactersModuleUrl();
  if (!charactersUrl || !target) return code;
  return code.replace(
    /((?:from|import)\s*\(?\s*)(["'])(https?:\/\/[^"']+?)\/?\2/g,
    (m, pre, q, url) => (url === charactersUrl ? pre + q + target + q : m),
  );
}

// Compile any supported source to a plain ES module (JS passes through).
export async function compileSceneScript(code, lang, filename) {
  const l = lang || inferSceneScriptLang(filename);
  let js = code;
  if (l === "ts") js = await compileTypeScript(code);
  else if (l === "svelte") js = await compileSvelte(code, filename);
  return rewriteCharacterImports(js);
}

export async function importModuleFromSource(jsCode) {
  const blob = new Blob([jsCode], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    return await dynImport(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- GitHub gists -----------------------------------------------------------

// List a user's gists that look like scene scripts: any filename (or the
// description) containing "scene"/"Scene".
export async function listSceneGists(username) {
  const user = (username || SCENE_SCRIPT_DEFAULTS.defaultGistUser).trim().replace(/^@/, "");
  const res = await fetch(
    `${SCENE_SCRIPT_DEFAULTS.gistUserApiBase}/${encodeURIComponent(user)}/gists?per_page=100`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!res.ok) throw new Error(`GitHub gists for @${user}: HTTP ${res.status}`);
  const gists = await res.json();
  const out = [];
  for (const g of Array.isArray(gists) ? gists : []) {
    const files = Object.keys(g.files || {});
    const sceneFiles = files.filter((f) => /scene/i.test(f));
    if (sceneFiles.length === 0 && !/scene/i.test(g.description || "")) continue;
    out.push({
      id: g.id,
      user,
      description: g.description || "",
      files,
      sceneFiles: sceneFiles.length ? sceneFiles : files,
      updatedAt: g.updated_at,
      url: g.html_url,
    });
  }
  return out;
}

// Fetch one file's content from a gist, optionally pinned to a revision.
// rev: undefined/"latest" -> newest; otherwise a commit sha.
export async function fetchGistFile(spec) {
  const s = spec || {};
  if (!s.id) throw new Error("gist id required");
  const rev = s.rev && s.rev !== "latest" ? "/" + s.rev : "";
  const res = await fetch(`${SCENE_SCRIPT_DEFAULTS.gistApiBase}/${s.id}${rev}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`gist ${s.id}${rev}: HTTP ${res.status}`);
  const gist = await res.json();
  const files = gist.files || {};
  const names = Object.keys(files);
  let name = s.file && files[s.file] ? s.file : null;
  if (!name) name = names.find((f) => /scene/i.test(f) && /\.(js|ts|svelte)$/i.test(f));
  if (!name) name = names.find((f) => /\.(js|ts|svelte)$/i.test(f));
  if (!name) name = names[0];
  if (!name) throw new Error(`gist ${s.id} has no files`);
  const file = files[name];
  let content = file.content;
  if (file.truncated || content == null) {
    const raw = await fetch(file.raw_url);
    if (!raw.ok) throw new Error(`gist raw ${name}: HTTP ${raw.status}`);
    content = await raw.text();
  }
  return { content, filename: name, revision: gist.history && gist.history[0] ? gist.history[0].version : null };
}

// Param form: gist:[user/]id[@rev][#file]  (encode # as %23 inside a URL param)
export function parseGistSpec(value) {
  let rest = String(value || "").replace(/^gist:/, "");
  let file;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    file = rest.slice(hash + 1) || undefined;
    rest = rest.slice(0, hash);
  }
  let rev;
  const at = rest.indexOf("@");
  if (at >= 0) {
    rev = rest.slice(at + 1) || undefined;
    rest = rest.slice(0, at);
  }
  let user, id;
  const slash = rest.indexOf("/");
  if (slash >= 0) {
    user = rest.slice(0, slash) || undefined;
    id = rest.slice(slash + 1);
  } else {
    id = rest;
  }
  return { user, id, rev: rev || "latest", file };
}

// ---- Entry resolution --------------------------------------------------------

function entryFromParamValue(value, mode) {
  const m = mode === "replace" ? "replace" : "hook";
  if (/^gist:/i.test(value)) {
    return { sourceType: "gist", mode: m, gist: parseGistSpec(value) };
  }
  return { sourceType: "url", mode: m, url: value };
}

// Resolve the configured entry per target. opts.recipe is the merged level
// recipe (may carry recipe.sceneScripts).
export function resolveSceneScriptEntries(opts) {
  const o = opts || {};
  const out = { title: null, adv: null };

  if (readParam("editorPlay") === "1") {
    try {
      const raw = localStorage.getItem(SCENE_SCRIPT_DEFAULTS.editorKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const t of SCENE_SCRIPT_TARGETS) {
          if (parsed && parsed[t] && typeof parsed[t] === "object") out[t] = parsed[t];
        }
      }
    } catch (_e) { /* localStorage may be blocked */ }
  }

  for (const t of SCENE_SCRIPT_TARGETS) {
    const v = readParam(SCENE_SCRIPT_DEFAULTS.targets[t].param);
    if (v) out[t] = entryFromParamValue(v, readParam(SCENE_SCRIPT_DEFAULTS.targets[t].modeParam));
  }

  const rs = o.recipe && o.recipe.sceneScripts;
  if (rs && typeof rs === "object") {
    for (const t of SCENE_SCRIPT_TARGETS) {
      if (!out[t] && rs[t] && typeof rs[t] === "object") out[t] = rs[t];
    }
  }
  return out;
}

// ---- Loading -----------------------------------------------------------------

async function resolveEntrySource(entry) {
  if (entry.sourceType === "inline") {
    if (entry.compiledJs) return { js: entry.compiledJs };
    return { js: await compileSceneScript(entry.code || "", entry.lang, null) };
  }
  if (entry.sourceType === "gist") {
    const g = Object.assign({ user: SCENE_SCRIPT_DEFAULTS.defaultGistUser }, entry.gist);
    const { content, filename } = await fetchGistFile(g);
    return { js: await compileSceneScript(content, null, filename) };
  }
  // "url"
  const rawUrl = entry.url;
  const url = resolveScriptUrl(rawUrl);
  const lang = inferSceneScriptLang(url);
  if (lang === "js") {
    // Direct import keeps relative imports inside the module working; gist
    // raw URLs and text/plain hosts fail MIME checks, so fall back to a blob.
    try {
      return { module: await dynImport(url) };
    } catch (_e) { /* fall through to fetch+blob */ }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`scene script ${rawUrl}: HTTP ${res.status}`);
  return { js: await compileSceneScript(await res.text(), lang, url) };
}

function normalizeLoaded(entry, module) {
  const svelte = !!module.__svelte;
  let hooks = module.default;
  const mode = entry.mode === "replace" ? "replace" : "hook";
  if (!svelte && typeof hooks === "function") {
    hooks = mode === "replace" ? { create: hooks } : { onStart: hooks };
  }
  if (!svelte && (!hooks || typeof hooks !== "object")) {
    // Allow named exports as a fallback contract.
    hooks = {
      onStart: module.onStart,
      onEnd: module.onEnd,
      create: module.create,
      update: module.update,
    };
  }
  return { entry, mode, module, hooks: svelte ? null : hooks, svelte };
}

export async function loadSceneScriptModule(entry) {
  const src = await resolveEntrySource(entry);
  const module = src.module || (await importModuleFromSource(src.js));
  return normalizeLoaded(entry, module);
}

// ---- Runtime state -----------------------------------------------------------

const _loaded = { title: null, adv: null };
let _initPromise = null;

// Resolve + load every configured script once. Never rejects — a broken
// script logs and the game falls back to its default scenes.
export function initSceneScripts(opts) {
  if (!_initPromise) {
    _initPromise = (async () => {
      let entries;
      try {
        entries = resolveSceneScriptEntries(opts);
      } catch (e) {
        console.error("[scene-script] entry resolution failed:", e);
        return _loaded;
      }
      for (const t of SCENE_SCRIPT_TARGETS) {
        if (!entries[t]) continue;
        try {
          _loaded[t] = await loadSceneScriptModule(entries[t]);
          console.log(`[scene-script] loaded ${t} script (${_loaded[t].mode} mode)`);
        } catch (e) {
          console.error(`[scene-script] failed to load ${t} script:`, e);
        }
      }
      return _loaded;
    })();
  }
  return _initPromise;
}

export function getSceneScript(target) {
  return _loaded[target] || null;
}

export function hasSceneScript(target) {
  return !!_loaded[target];
}

export function isSceneScriptReplaced(scene) {
  return !!(scene && scene.__sceneScriptReplaced);
}

// ---- ctx + overlay -----------------------------------------------------------

function registerCleanup(scene, fn) {
  if (!scene.__sceneScriptCleanup) {
    scene.__sceneScriptCleanup = [];
    scene.events.once("shutdown", () => {
      const fns = scene.__sceneScriptCleanup || [];
      scene.__sceneScriptCleanup = null;
      scene.__sceneScriptCtx = null;
      scene.__sceneScriptReplaced = false;
      for (const f of fns) {
        try {
          f();
        } catch (e) {
          console.error("[scene-script] cleanup failed:", e);
        }
      }
    });
  }
  scene.__sceneScriptCleanup.push(fn);
}

// A DOM layer tracking the canvas bounds — used for svelte overlays and
// available to scripts via ctx.overlay(). The host itself is input-
// transparent so in-canvas interaction (scene.input, interactive objects)
// keeps working; DOM content that wants clicks opts back in with
// `pointer-events: auto` on its own elements.
function createOverlayHost(scene) {
  const canvas = scene.game.canvas;
  const div = document.createElement("div");
  div.className = "scene-script-overlay";
  div.style.cssText = "position:absolute;z-index:1000;overflow:hidden;pointer-events:none;";
  const place = () => {
    const r = canvas.getBoundingClientRect();
    div.style.left = r.left + globalThis.scrollX + "px";
    div.style.top = r.top + globalThis.scrollY + "px";
    div.style.width = r.width + "px";
    div.style.height = r.height + "px";
  };
  place();
  document.body.appendChild(div);
  globalThis.addEventListener("resize", place);
  const interval = setInterval(place, 500); // canvas can move without a resize
  registerCleanup(scene, () => {
    globalThis.removeEventListener("resize", place);
    clearInterval(interval);
    div.remove();
  });
  return div;
}

// Build (or reuse) the per-scene ctx handed to every hook. `opts` comes from
// the game integration: { Phaser, state, next }.
export function getSceneScriptContext(target, scene, opts) {
  if (scene.__sceneScriptCtx) return scene.__sceneScriptCtx;
  const o = opts || {};
  let advanced = false;
  let overlayHost = null;
  const ctx = {
    scene,
    game: scene.game,
    Phaser: o.Phaser || globalThis.Phaser,
    state: o.state || {},
    target,
    get stageId() {
      return o.state && o.state.stageId != null ? o.state.stageId : 0;
    },
    get gameObjects() {
      return scene.children && scene.children.list ? scene.children.list.slice() : [];
    },
    find(name) {
      if (!name) return null;
      const byName = scene.children && scene.children.getByName
        ? scene.children.getByName(name)
        : null;
      if (byName) return byName;
      const v = scene[name];
      return v && typeof v === "object" && typeof v.destroy === "function" ? v : null;
    },
    overlay() {
      if (!overlayHost) overlayHost = createOverlayHost(scene);
      return overlayHost;
    },
    next() {
      if (advanced) return;
      advanced = true;
      if (typeof o.next === "function") o.next();
    },
    onCleanup(fn) {
      registerCleanup(scene, fn);
    },
  };
  registerCleanup(scene, () => {});
  scene.__sceneScriptCtx = ctx;
  return ctx;
}

async function mountSvelteScript(script, scene, ctx) {
  const svelte = await dynImport(SCENE_SCRIPT_DEFAULTS.svelteCdn);
  const host = ctx.overlay();
  const instance = svelte.mount(script.module.default, {
    target: host,
    props: { ctx },
  });
  registerCleanup(scene, () => {
    try {
      svelte.unmount(instance);
    } catch (_e) { /* already gone */ }
  });
}

// ---- Scene runners -------------------------------------------------------------
// Games call these from their scenes; each is a no-op when no script is set.

// Call at the very top of the scene's create(). Returns true when a replace-
// mode script owns the scene — the caller must then skip its default create().
export function runSceneScriptCreate(target, scene, opts) {
  const s = _loaded[target];
  if (!s || s.mode !== "replace") return false;
  scene.__sceneScriptReplaced = true;
  const ctx = getSceneScriptContext(target, scene, opts);
  try {
    if (s.svelte) {
      mountSvelteScript(s, scene, ctx).catch((e) =>
        console.error("[scene-script] svelte mount failed:", e)
      );
    } else if (s.hooks && typeof s.hooks.create === "function") {
      s.hooks.create(ctx);
    } else if (s.hooks && typeof s.hooks.onStart === "function") {
      s.hooks.onStart(ctx);
    } else {
      console.warn(`[scene-script] ${target} replace script exports no create(); continuing to next scene`);
      ctx.next();
    }
  } catch (e) {
    console.error(`[scene-script] ${target} create failed:`, e);
  }
  return true;
}

// Call at the end of the scene's default create() (hook mode start).
export function runSceneScriptStart(target, scene, opts) {
  const s = _loaded[target];
  if (!s || s.mode === "replace") return;
  const ctx = getSceneScriptContext(target, scene, opts);
  try {
    if (s.svelte) {
      mountSvelteScript(s, scene, ctx).catch((e) =>
        console.error("[scene-script] svelte mount failed:", e)
      );
    } else if (s.hooks && typeof s.hooks.onStart === "function") {
      s.hooks.onStart(ctx);
    }
  } catch (e) {
    console.error(`[scene-script] ${target} onStart failed:`, e);
  }
}

// Call where the scene would hand off to the next scene. Returns true when the
// script takes over the transition (it will call ctx.next(), or the promise it
// returned auto-continues on resolve).
export function runSceneScriptEnd(target, scene, opts) {
  const s = _loaded[target];
  if (!s || s.svelte || !s.hooks || typeof s.hooks.onEnd !== "function") return false;
  const ctx = getSceneScriptContext(target, scene, opts);
  let result;
  try {
    result = s.hooks.onEnd(ctx);
  } catch (e) {
    console.error(`[scene-script] ${target} onEnd failed:`, e);
    return false;
  }
  if (result === true) return true;
  if (result && typeof result.then === "function") {
    result.then(
      (v) => {
        if (v !== true) ctx.next();
      },
      (e) => {
        console.error(`[scene-script] ${target} onEnd rejected:`, e);
        ctx.next();
      },
    );
    return true;
  }
  return false;
}

// Call from the scene's update() — feeds the optional script update hook.
export function runSceneScriptUpdate(target, scene, time, delta) {
  const s = _loaded[target];
  if (!s || s.svelte || !s.hooks || typeof s.hooks.update !== "function") return;
  const ctx = scene.__sceneScriptCtx;
  if (!ctx) return;
  try {
    s.hooks.update(ctx, time, delta);
  } catch (e) {
    console.error(`[scene-script] ${target} update failed:`, e);
    s.hooks.update = null; // don't spam every frame
  }
}
