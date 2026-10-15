// The manifest, pinned against the files beside it: every referenced script,
// stylesheet, icon and font exists; the editor's origins come from ONE list
// (picker-core's) and are permitted; the inbox host is permitted; the bridge
// runs in every frame (the editor may be the dashboard's iframe); and the
// popup's own references resolve.
//
//   node --test 'tools/sprite-picker-extension/test/*.test.mjs'   (no dependencies)

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

// The core, loaded as the browser loads it (a plain script).
vm.runInThisContext(readFileSync(join(ROOT, "lib/picker-core.js"), "utf8"), { filename: "picker-core.js" });
const Core = globalThis.ShxPickerCore;

const exists = (rel) => existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isFile();
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const INBOX_HOST = "https://evil-invaders-default-rtdb.firebaseio.com/*";

/** A URL a match pattern covers, as a browser would see it: the wildcard subdomain filled in, the editor path on. */
const sampleUrl = (pattern) => pattern.replace("*.", "sub.").replace(/\/\*$/, "/editor/");

test("it is an MV3 manifest named for shmupX with the permissions the code uses", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "shmupX Sprite Picker");
  assert.match(manifest.version, /^\d+(\.\d+)*$/);
  assert.ok(manifest.description.length > 0);
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "contextMenus", "scripting", "storage"]);
  // Inject-anywhere asks for the tab's origin at click time (popup.js).
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"]);
});

test("the service worker, popup, icons and font all exist", () => {
  assert.ok(exists(manifest.background.service_worker), manifest.background.service_worker);
  assert.ok(exists(manifest.action.default_popup), manifest.action.default_popup);
  for (const size of ["16", "48", "128"]) {
    assert.ok(exists(manifest.icons[size]), `icons.${size}`);
    assert.ok(exists(manifest.action.default_icon[size]), `action.default_icon.${size}`);
  }
  assert.ok(exists("fonts/Orbitron-Variable.woff2"));
});

test("web-accessible resources: the font for any sprite site, and the stylesheet the shadow root links", () => {
  const all = [];
  for (const entry of manifest.web_accessible_resources) {
    for (const pattern of entry.resources) {
      const [dir, glob] = pattern.split("/");
      const suffix = glob.replace(/^\*/, "");
      const matches = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(suffix));
      assert.ok(matches.length > 0, `${pattern} matches a bundled file`);
      all.push(pattern);
    }
    assert.ok(entry.matches.includes("<all_urls>"), "readable from any site the picker is injected on");
  }
  assert.ok(all.includes("fonts/*.woff2"));
  assert.ok(all.includes("content/content.css"), "content.js links content.css into its closed shadow root");
});

test("every content script and stylesheet exists, and the shared core loads first", () => {
  for (const cs of manifest.content_scripts) {
    for (const js of cs.js) assert.ok(exists(js), js);
    for (const css of cs.css || []) assert.ok(exists(css), css);
    assert.equal(cs.js[0], "lib/picker-core.js", "picker-core defines ShxPickerCore for the rest");
  }
});

test("the picker runs on sprite sites with the detector", () => {
  const picker = manifest.content_scripts.find((cs) => cs.js.includes("content/content.js"));
  assert.ok(picker, "a content_scripts entry for content/content.js");
  assert.ok(picker.js.includes("lib/sprite-detect.js"));
  assert.ok(picker.css.includes("content/content.css"));
  assert.ok(picker.matches.some((m) => m.includes("spriters-resource.com")));
});

test("the bridge runs on exactly the core's editor origins, in all frames", () => {
  const bridge = manifest.content_scripts.find((cs) => cs.js.includes("bridge/shmupx-bridge.js"));
  assert.ok(bridge, "a content_scripts entry for bridge/shmupx-bridge.js");
  assert.equal(bridge.all_frames, true, "the editor may be the dashboard's iframe");
  assert.deepEqual([...bridge.matches].sort(), [...Core.EDITOR_URL_PATTERNS].sort(), "one list: Core.EDITOR_URL_PATTERNS");
  assert.ok(!bridge.js.includes("content/content.js"), "the picker UI does not run on the editor");
  assert.ok(Core.EDITOR_URL_PATTERNS.length >= 5);
});

test("host permissions cover the sprite sites, every editor pattern and the inbox", () => {
  const hosts = manifest.host_permissions;
  for (const pattern of Core.EDITOR_URL_PATTERNS) assert.ok(hosts.includes(pattern), pattern);
  assert.ok(hosts.includes(INBOX_HOST), "the RTDB inbox");
  assert.ok(hosts.some((h) => h.includes("spriters-resource.com")));
  assert.ok(hosts.some((h) => h.includes("images.spriters-resource.com")), "the image proxy fetches from the CDN");
});

test("every editor pattern's origin is one isEditorOrigin accepts (the patterns and the rule agree)", () => {
  for (const pattern of Core.EDITOR_URL_PATTERNS) {
    const url = sampleUrl(pattern);
    assert.ok(Core.isEditorOrigin(url), `${pattern} → ${url}`);
    assert.ok(Core.isEditorUrl(url), `${url} is the editor`);
  }
  assert.equal(sampleUrl("https://*.codemonkey.games/*"), "https://sub.codemonkey.games/editor/");
});

test("the popup's own script and font references resolve", () => {
  const html = read(manifest.action.default_popup);
  const popupDir = dirname(manifest.action.default_popup);
  for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
    assert.ok(exists(join(popupDir, src)), src);
  }
  for (const [, url] of html.matchAll(/url\("([^"]+\.woff2)"\)/g)) {
    assert.ok(exists(join(popupDir, url)), url);
  }
  assert.ok(html.includes("SHMUPX SPRITE PICKER"));
  assert.ok(/Atlas Manager/.test(html), "the how-to says where the picker code is shown");
});

test("the content stylesheet has no @font-face (the shadow tree cannot use one) and no CMG names", () => {
  const css = read("content/content.css");
  assert.ok(!/^\s*@font-face/m.test(css), "content.js injects the @font-face into the document instead");
  assert.ok(!css.includes("__MSG_@@extension_id__"), "a <link>-loaded stylesheet gets no placeholder substitution");
  assert.ok(css.includes(":host"), "the shadow host rule");
  assert.ok(!/cmg/i.test(css), "no CMG names left in the stylesheet");
});

test("the content script renders in a closed shadow root, loads the font and stylesheet itself, and only acts on trusted events", () => {
  const src = read("content/content.js");
  assert.ok(src.includes('attachShadow({ mode: "closed" })'));
  assert.ok(src.includes('chrome.runtime.getURL("content/content.css")'));
  assert.ok(src.includes('chrome.runtime.getURL("fonts/Orbitron-Variable.woff2")'));
  assert.ok(src.includes("@font-face{"), "the document-level @font-face");
  assert.ok(src.includes("ev.isTrusted"));
  assert.ok(!/data-(code|picker)/.test(src), "the code is never parked in a data attribute");
});

test("the detector is cmg's, verbatim, and nothing is left pointing at CMG", () => {
  const detect = read("lib/sprite-detect.js");
  assert.ok(detect.includes("window.SpriteDetect"), "the detector exports window.SpriteDetect");
  for (const rel of [
    "content/content.js",
    "background/service-worker.js",
    "bridge/shmupx-bridge.js",
    "popup/popup.js",
    "popup/popup.html",
    "lib/picker-core.js",
  ]) {
    const src = read(rel);
    assert.ok(!/cmgsp|__cmg|CMG_PING|SPRITEX_PRELOAD|cmg-sprite-picker/.test(src), `${rel} has no CMG wiring`);
  }
});

test("the editor contract: the bridge needs the editor's meta mark, posts as sprite-picker-bridge and reads sprite-picker-page", () => {
  const bridge = read("bridge/shmupx-bridge.js");
  assert.ok(bridge.includes(`meta[name="shmupx-editor"]`), "path alone is not enough on localhost");
  assert.ok(bridge.includes('source: "sprite-picker-bridge"'));
  assert.ok(bridge.includes('type: "SPRITE_PICKER_INJECT"'));
  assert.ok(bridge.includes('type: "GET_ATLAS_FRAMES"'));
  assert.ok(bridge.includes("request.atlas = atlas"), "GET_ATLAS_FRAMES may name an atlas");
  assert.ok(bridge.includes('"sprite-picker-page"'));
  assert.ok(bridge.includes('"ATLAS_FRAMES_RESPONSE"'));
  assert.ok(bridge.includes("currentAtlas") && bridge.includes("atlases"), "the response's currentAtlas and atlases are passed on");
  assert.ok(bridge.includes('localStorage.getItem("shmupx-picker-code")'));
});

test("the service worker spells the inbox limit the one way and aborts a hung inbox write", () => {
  const sw = read("background/service-worker.js");
  assert.ok(sw.includes("Core.INBOX_MAX_LABEL"));
  assert.ok(!/4\s?MB\b/.test(sw), "never '4 MB'");
  assert.ok(sw.includes("AbortController"));
  assert.ok(sw.includes("Core.inboxBody(") && sw.includes("Core.frameOptions("), "body shape and frame addressing come from the core");
});
