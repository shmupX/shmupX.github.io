// The pure core the service worker, popup, content script and bridge share,
// pinned function by function: the picker code's alphabet and formatting,
// which URLs are the level editor, the inbox path, body and size limit, batch
// ids, frame addressing, the nearest frame name, and the one routing
// decision (editor tab → inbox → nothing).
//
//   node --test 'tools/sprite-picker-extension/test/*.test.mjs'   (no dependencies)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// picker-core.js is a plain script (it has to load in a service worker, a
// popup and content scripts alike, with no modules), so load it the way a
// browser does: evaluate the source and read globalThis.ShxPickerCore. The
// repo's package.json says "type": "module", which would make require() of
// a .js file an ESM load with no module.exports.
const CORE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "picker-core.js");
vm.runInThisContext(readFileSync(CORE_PATH, "utf8"), { filename: CORE_PATH });
const Core = globalThis.ShxPickerCore;

const {
  CODE_ALPHABET,
  INBOX_MAX_BYTES,
  INBOX_MAX_LABEL,
  normalizePickerCode,
  formatPickerCode,
  isEditorPath,
  isEditorOrigin,
  isEditorUrl,
  inboxPath,
  inboxUrl,
  newBatchId,
  payloadBytes,
  inboxTooLarge,
  sanitizeSpriteName,
  atlasOptions,
  closestName,
  chooseTarget,
  frameOptions,
  describeTarget,
  buildInjectPayload,
  inboxBody,
} = Core;

const sprite = (name, bytes = 16) => ({
  name,
  dataURL: "data:image/png;base64," + "A".repeat(bytes),
  w: 16,
  h: 16,
});

// ---------- picker code ----------

test("a picker code is 8 letters of the alphabet, however it was typed", () => {
  assert.equal(normalizePickerCode("ABCDEFGH"), "ABCDEFGH");
  assert.equal(normalizePickerCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normalizePickerCode("  ab cd / ef_gh "), "ABCDEFGH");
  assert.equal(normalizePickerCode("2345-6789"), "23456789");
});

test("the alphabet has no 0/O or 1/I, and the code is exactly eight long", () => {
  assert.equal(CODE_ALPHABET.length, 32);
  for (const bad of ["0", "1", "I", "O"]) assert.ok(!CODE_ALPHABET.includes(bad));
  assert.equal(normalizePickerCode("ABCDEFG0"), "");
  assert.equal(normalizePickerCode("ABCDEFG1"), "");
  assert.equal(normalizePickerCode("ABCDEFGI"), "");
  assert.equal(normalizePickerCode("ABCDEFGO"), "");
  assert.equal(normalizePickerCode("ABCDEFG"), "");
  assert.equal(normalizePickerCode("ABCDEFGHJ"), "");
  assert.equal(normalizePickerCode(""), "");
  assert.equal(normalizePickerCode(null), "");
  assert.equal(normalizePickerCode(undefined), "");
  assert.equal(normalizePickerCode(12345678), "");
});

test("formatPickerCode shows ABCD-EFGH and nothing for an invalid code", () => {
  assert.equal(formatPickerCode("ABCDEFGH"), "ABCD-EFGH");
  assert.equal(formatPickerCode("abcd-efgh"), "ABCD-EFGH");
  assert.equal(formatPickerCode("nope"), "");
  assert.equal(formatPickerCode(""), "");
});

// ---------- editor URLs ----------

test("the editor's paths, and only those", () => {
  assert.ok(isEditorPath("/editor"));
  assert.ok(isEditorPath("/editor/"));
  assert.ok(isEditorPath("/editor/index.html"));
  // A caller that forgot to strip the query still gets the right answer.
  assert.ok(isEditorPath("/editor/?game=2028-ai"));
  assert.ok(isEditorPath("/editor/#atlas"));

  assert.ok(!isEditorPath("/"));
  assert.ok(!isEditorPath("/games/2028-ai/"));
  assert.ok(!isEditorPath("/editor/assets/fonts/Orbitron-Variable.woff2"));
  assert.ok(!isEditorPath("/editors/"));
  assert.ok(!isEditorPath("/level-editor/"));
  assert.ok(!isEditorPath(""));
  assert.ok(!isEditorPath(null));
});

test("the origins the editor is served from, including level subdomains and local ports", () => {
  assert.ok(isEditorOrigin("https://codemonkey.games/editor/"));
  assert.ok(isEditorOrigin("https://foo.codemonkey.games/editor/?game=x"));
  assert.ok(isEditorOrigin("https://shmupx.github.io/editor/"));
  assert.ok(isEditorOrigin("http://localhost:5173/editor/"));
  assert.ok(isEditorOrigin("http://localhost:8000/editor/"));
  assert.ok(isEditorOrigin("http://127.0.0.1:8787/editor"));
  // Origin only: any path on those hosts (the bridge checks the path itself).
  assert.ok(isEditorOrigin("https://codemonkey.games/games/2028-ai/"));

  assert.ok(!isEditorOrigin("https://codemonkey.games.evil.com/editor/"));
  assert.ok(!isEditorOrigin("https://evilcodemonkey.games/editor/"));
  assert.ok(!isEditorOrigin("http://codemonkey.games/editor/"), "the hosted editor is https only");
  assert.ok(!isEditorOrigin("https://localhost:5173/editor/"), "local is http only");
  assert.ok(!isEditorOrigin("https://github.io/editor/"));
  assert.ok(!isEditorOrigin("https://shmupx.github.io.evil.com/editor/"));
  assert.ok(!isEditorOrigin("/games/2028-ai/"), "a bare path is not an origin");
  assert.ok(!isEditorOrigin("not a url"));
  assert.ok(!isEditorOrigin(""));
  assert.ok(!isEditorOrigin(null));
});

test("isEditorUrl needs both the origin and the path", () => {
  assert.ok(isEditorUrl("https://foo.codemonkey.games/editor/?game=x"));
  assert.ok(isEditorUrl("http://127.0.0.1:8787/editor"));
  assert.ok(!isEditorUrl("https://codemonkey.games/games/2028-ai/"));
  assert.ok(!isEditorUrl("https://codemonkey.games.evil.com/editor/"));
});

// ---------- inbox ----------

test("the inbox path is spritePicker/inbox/<CODE>/<batchId>", () => {
  assert.equal(inboxPath("abcd-efgh", "m2x1-abc123"), "spritePicker/inbox/ABCDEFGH/m2x1-abc123");
  assert.equal(
    inboxUrl("ABCDEFGH", "b1"),
    "https://evil-invaders-default-rtdb.firebaseio.com/spritePicker/inbox/ABCDEFGH/b1.json",
  );
  assert.throws(() => inboxPath("bad", "b1"), /Invalid picker code/);
  assert.throws(() => inboxPath("ABCDEFGH", ""), /Invalid batch id/);
  assert.throws(() => inboxPath("ABCDEFGH", "a/b"), /Invalid batch id/, "no RTDB key characters");
  assert.throws(() => inboxPath("ABCDEFGH", "a.b"), /Invalid batch id/);
});

test("a batch id is time-sortable, random-tailed, deterministic under injection, and a legal key", () => {
  const id = newBatchId(1760000000000, () => 0);
  assert.equal(id, `${(1760000000000).toString(36)}-000000`);
  assert.match(id, /^[0-9a-z]+-[0-9a-z]{6}$/);
  assert.equal(newBatchId(1760000000000, () => 0.999), `${(1760000000000).toString(36)}-zzzzzz`);
  assert.notEqual(newBatchId(1760000000000, Math.random), newBatchId(1760000000000, Math.random));
  // Later batches sort later for the same digit count.
  assert.ok(newBatchId(1760000000001, () => 0) > newBatchId(1760000000000, () => 0));
  // Defaults: now and Math.random.
  assert.match(newBatchId(), /^[0-9a-z]+-[0-9a-z]{6}$/);
  assert.doesNotThrow(() => inboxPath("ABCDEFGH", newBatchId()));
});

test("payloadBytes is the JSON size of the sprites and the inbox refuses over 4 MiB", () => {
  assert.equal(INBOX_MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(INBOX_MAX_LABEL, "4 MiB");
  const one = [sprite("a_0", 100)];
  assert.equal(payloadBytes(one), Buffer.byteLength(JSON.stringify(one), "utf8"));
  assert.equal(payloadBytes([]), 2);
  assert.equal(payloadBytes(null), 2);
  // Non-ASCII names count in bytes, not characters.
  assert.equal(payloadBytes([sprite("é", 0)]), Buffer.byteLength(JSON.stringify([sprite("é", 0)]), "utf8"));

  assert.equal(inboxTooLarge(one), false);
  const small = [sprite("s_0", 1024 * 1024)];
  assert.equal(inboxTooLarge(small), false);
  const big = [sprite("b_0", INBOX_MAX_BYTES)];
  assert.equal(inboxTooLarge(big), true);
  const justOver = [sprite("j_0", INBOX_MAX_BYTES - JSON.stringify([sprite("j_0", 0)]).length + 1)];
  assert.equal(inboxTooLarge(justOver), true);
  const justUnder = [sprite("j_0", INBOX_MAX_BYTES - JSON.stringify([sprite("j_0", 0)]).length)];
  assert.equal(inboxTooLarge(justUnder), false);
});

test("inboxBody is the record the editor's watcher reads: nulls, never undefined", () => {
  const sprites = [sprite("a_0")];
  const full = inboxBody({ at: 7, batchId: "b-1", atlas: "game_ui", mode: "replace", frameName: "enemy01", sprites, from: "ignored" });
  assert.deepEqual(full, {
    at: 7,
    from: "shmupX Sprite Picker",
    batchId: "b-1",
    atlas: "game_ui",
    mode: "replace",
    frameName: "enemy01",
    sprites,
  });
  const bare = inboxBody({ at: 7, batchId: "b-2", sprites });
  assert.deepEqual(Object.keys(bare).sort(), ["at", "atlas", "batchId", "frameName", "from", "mode", "sprites"]);
  assert.equal(bare.atlas, null);
  assert.equal(bare.frameName, null);
  assert.equal(bare.mode, "add");
  assert.ok(!Object.values(bare).includes(undefined), "the Realtime Database rejects undefined");
  // Missing pieces are filled rather than passed through.
  const minted = inboxBody({ sprites });
  assert.equal(typeof minted.at, "number");
  assert.match(minted.batchId, /^[0-9a-z]+-[0-9a-z]{6}$/);
  assert.deepEqual(inboxBody(null).sprites, []);
});

// ---------- names and atlases ----------

test("sprite base names are sanitised the way cmg did", () => {
  assert.equal(sanitizeSpriteName("ship"), "ship");
  assert.equal(sanitizeSpriteName("my ship!"), "myship");
  assert.equal(sanitizeSpriteName("boss-2_idle"), "boss-2_idle");
  assert.equal(sanitizeSpriteName("x".repeat(60)).length, 40);
  assert.equal(sanitizeSpriteName(""), "sprite");
  assert.equal(sanitizeSpriteName("!!!"), "sprite");
  assert.equal(sanitizeSpriteName(null), "sprite");
});

test("atlas options lead with the editor's current atlas, then the editor's list or the known keys, deduped", () => {
  assert.deepEqual(atlasOptions(null), ["game_asset", "game_ui", "title_ui"]);
  assert.deepEqual(atlasOptions("game_asset"), ["game_asset", "game_ui", "title_ui"]);
  assert.deepEqual(atlasOptions("title_ui"), ["title_ui", "game_asset", "game_ui"]);
  assert.deepEqual(atlasOptions("custom_atlas"), ["custom_atlas", "game_asset", "game_ui", "title_ui"]);
  assert.deepEqual(atlasOptions(""), ["game_asset", "game_ui", "title_ui"]);
  // The editor's own list (ATLAS_FRAMES_RESPONSE.atlases) wins over the hardcoded keys.
  assert.deepEqual(atlasOptions("game_ui", ["game_asset", "game_ui", "title_ui", "extra"]), ["game_ui", "game_asset", "title_ui", "extra"]);
  assert.deepEqual(atlasOptions(null, ["only_one"]), ["only_one"]);
  assert.deepEqual(atlasOptions("game_ui", []), ["game_ui", "game_asset", "title_ui"], "an empty list falls back");
  assert.deepEqual(atlasOptions(null, "nope"), ["game_asset", "game_ui", "title_ui"]);
});

test("closestName finds the frame a REPLACE meant, or nothing when nothing is near", () => {
  const frames = ["enemy01", "enemy02", "boss_idle", "ship", "bullet_a"];
  assert.equal(closestName("enemy02", frames), "enemy02");
  assert.equal(closestName("ENEMY01", frames), "enemy01", "case is forgiven");
  assert.equal(closestName("enemy03", frames), "enemy01", "one edit away, ties to the shorter/first");
  assert.equal(closestName("boss", frames), "boss_idle", "a prefix is near");
  assert.equal(closestName("bulet_a", frames), "bullet_a", "a dropped letter is near");
  assert.equal(closestName("shpi", frames), "ship");
  assert.equal(closestName("zzzzzzzz", frames), null);
  assert.equal(closestName("", frames), null);
  assert.equal(closestName("ship", []), null);
  assert.equal(closestName("ship", null), null);
  assert.equal(closestName(null, frames), null);
});

// ---------- routing ----------

test("chooseTarget: the first editor frame wins over any picker code", () => {
  const frames = [
    { tabId: 12, frameId: 0, href: "https://codemonkey.games/editor/", pickerCode: "ABCDEFGH" },
    { tabId: 13, frameId: 4, href: "http://localhost:5173/editor/", pickerCode: null },
  ];
  assert.deepEqual(chooseTarget({ editorFrames: frames, pickerCode: "QRSTUVWX" }), {
    kind: "tab",
    tabId: 12,
    frameId: 0,
    href: "https://codemonkey.games/editor/",
  });
  // An editor inside the dashboard's iframe has no known frameId → null.
  assert.deepEqual(chooseTarget({ editorFrames: [{ tabId: 7, frameId: null, href: "x" }] }), {
    kind: "tab",
    tabId: 7,
    frameId: null,
    href: "x",
  });
  assert.equal(chooseTarget({ editorFrames: [{ tabId: 7, frameId: 3 }] }).frameId, 3);
  assert.equal(chooseTarget({ editorFrames: [{ tabId: 7 }] }).href, null);
  // Junk frames without a tab id are skipped.
  assert.equal(chooseTarget({ editorFrames: [{ frameId: 0 }, { tabId: 9 }] }).tabId, 9);
});

test("chooseTarget: no editor frame and a valid code → the inbox", () => {
  assert.deepEqual(chooseTarget({ editorFrames: [], pickerCode: "abcd-efgh" }), {
    kind: "inbox",
    code: "ABCDEFGH",
  });
  assert.deepEqual(chooseTarget({ pickerCode: "ABCDEFGH" }), { kind: "inbox", code: "ABCDEFGH" });
});

test("chooseTarget: nothing to send to says what to do about it", () => {
  const none = chooseTarget({ editorFrames: [], pickerCode: "" });
  assert.equal(none.kind, "none");
  assert.equal(
    none.reason,
    "Open the level editor (codemonkey.games/editor) in a tab, or set the PICKER CODE the editor's Atlas Manager shows",
  );
  assert.equal(chooseTarget({ editorFrames: [], pickerCode: "ABCDEFG0" }).kind, "none", "an invalid code is no code");
  assert.equal(chooseTarget({}).kind, "none");
  assert.equal(chooseTarget().kind, "none");
});

test("frameOptions addresses a known iframe and nothing else", () => {
  assert.deepEqual(frameOptions({ kind: "tab", tabId: 1, frameId: 4 }), { frameId: 4 });
  assert.equal(frameOptions({ kind: "tab", tabId: 1, frameId: 0 }), undefined, "the top frame: all frames, only the editor acts");
  assert.equal(frameOptions({ kind: "tab", tabId: 1, frameId: null }), undefined, "unknown iframe: same");
  assert.equal(frameOptions({ kind: "tab", tabId: 1 }), undefined);
  assert.equal(frameOptions({ kind: "inbox", code: "ABCDEFGH" }), undefined);
  assert.equal(frameOptions(null), undefined);
});

test("describeTarget gives the CRT status line for each kind", () => {
  assert.equal(describeTarget({ kind: "tab", tabId: 12, frameId: 0 }), "EDITOR TAB 12");
  assert.equal(describeTarget({ kind: "inbox", code: "ABCDEFGH" }), "INBOX ABCD-EFGH");
  const none = describeTarget(chooseTarget({}));
  assert.ok(none.startsWith("NO TARGET — OPEN THE LEVEL EDITOR"));
  assert.equal(none, none.toUpperCase());
  assert.equal(describeTarget({ kind: "none", reason: "Boom" }), "NO TARGET — BOOM");
  assert.equal(describeTarget(null), "NO TARGET");
});

// ---------- the inject body ----------

test("every inject carries batchId, from and at beside the editor's contract fields", () => {
  const sprites = [sprite("ship_0"), sprite("ship_1")];
  const p = buildInjectPayload({ sprites, atlas: "game_ui", now: 1760000000000 });
  assert.deepEqual(Object.keys(p).sort(), ["at", "atlas", "batchId", "from", "mode", "sprites"]);
  assert.equal(p.sprites, sprites);
  assert.equal(p.mode, "add");
  assert.equal(p.atlas, "game_ui");
  assert.equal(p.from, "shmupX Sprite Picker");
  assert.equal(p.at, 1760000000000);
  assert.match(p.batchId, /^[0-9a-z]+-[0-9a-z]{6}$/);
  assert.ok(p.batchId.startsWith((1760000000000).toString(36)), "the batch id is minted from `now`");
});

test("an inject without an atlas leaves it off so the editor keeps its current one", () => {
  const p = buildInjectPayload({ sprites: [sprite("a_0")], now: 1 });
  assert.ok(!("atlas" in p));
  assert.ok(!("frameName" in p));
  assert.equal(buildInjectPayload({ sprites: [sprite("a_0")], atlas: "", now: 1 }).atlas, undefined);
});

test("replace mode needs a frame name and exactly one sprite", () => {
  const p = buildInjectPayload({
    sprites: [sprite("a_0")],
    mode: "replace",
    frameName: "  enemy01  ",
    batchId: "fixed-id",
    now: 5,
  });
  assert.equal(p.mode, "replace");
  assert.equal(p.frameName, "enemy01");
  assert.equal(p.batchId, "fixed-id");
  assert.throws(() => buildInjectPayload({ sprites: [sprite("a_0")], mode: "replace" }), /frame name/);
  assert.throws(
    () => buildInjectPayload({ sprites: [sprite("a_0"), sprite("a_1")], mode: "replace", frameName: "x" }),
    /exactly one sprite/,
  );
  // Any other mode string is "add".
  assert.equal(buildInjectPayload({ sprites: [sprite("a_0")], mode: "whatever" }).mode, "add");
});

test("an inject payload round-trips into an inbox body", () => {
  const p = buildInjectPayload({ sprites: [sprite("a_0")], atlas: "title_ui", now: 9, batchId: "b-9" });
  const body = inboxBody(p);
  assert.equal(body.at, 9);
  assert.equal(body.batchId, "b-9");
  assert.equal(body.atlas, "title_ui");
  assert.equal(body.frameName, null);
  assert.equal(body.sprites, p.sprites);
});
