// When the launcher will replace itself, and — more importantly — when it
// will not.
//
// This is the one feature in the repo that downloads an executable and runs it.
// Every "off" below is therefore a deliberate refusal rather than a missing
// capability, and the test exists so a later edit cannot turn one of them into
// a default: a build with no signing key must not fall back to trusting
// whatever answers the URL, and a source checkout must not try to patch the
// `deno` binary somebody is developing with.
//
// `updatePlan` is pure, so none of this touches the network or the runtime's
// own updater.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  isEd25519PublicKey,
  updateChannel,
  updatePlan,
} from "../lib/self-update.ts";

const LINUX = "x86_64-unknown-linux-gnu";
// 32 bytes, because that is the only length an Ed25519 public key has. The key
// arrives through the context rather than the environment: a launcher added to
// Steam inherits that shortcut's Launch Options, which a player can edit from
// Game Mode, and a key settable there would make the updater repointable.
const KEY = "Zm9vYmFyYmF6cXV1eGZvb2JhcmJhenF1dXhmb29iYXI=";

const packaged = (env: Record<string, string> = {}) => ({
  env,
  target: LINUX,
  version: "2026.9.13",
  underDesktop: true,
  publicKey: KEY,
});

Deno.test("a signed, versioned desktop build watches its own architecture", () => {
  const plan = updatePlan(packaged());
  assert(plan.enabled);
  assertEquals(plan.channel, "linux-x86_64");
  assertEquals(plan.url, "https://codemonkey.games/desktop/linux-x86_64");
  assertEquals(plan.version, "2026.9.13");
  assertEquals(plan.reason, null);
});

Deno.test("a build with no signing key does not update at all", () => {
  // The refusal that matters: without a key there is no way to tell a release
  // from anything else that answers, so the answer is off, not unverified.
  const plan = updatePlan({ ...packaged(), publicKey: "" });
  assert(!plan.enabled);
  assertEquals(plan.url, null);
  assertStringIncludes(plan.reason ?? "", "signing key");
});

Deno.test("a key that is not 32 bytes is refused, not trusted", () => {
  // The hazard this guards: an Ed25519 PRIVATE seed is also 32 bytes and so the
  // same base64 length as the public half, and a truncated key looks like a
  // real one. Either mistake ships a ~450 MB public artifact whose only symptom
  // is that no release ever verifies.
  assert(isEd25519PublicKey(KEY));
  // The fixture this suite used to carry: 29 bytes, and it asserted `enabled`.
  assert(!isEd25519PublicKey("Zm9vYmFyYmF6cXV1eGZvb2JhcmJhenF1dXhmb28="));
  assert(!isEd25519PublicKey("not base64 at all !!"));
  assert(!isEd25519PublicKey(""));

  const plan = updatePlan({
    ...packaged(),
    publicKey: "Zm9vYmFyYmF6cXV1eGZvb2JhcmJhenF1dXhmb28=",
  });
  assert(!plan.enabled);
  assertStringIncludes(plan.reason ?? "", "Ed25519");
});

Deno.test("an AppImage is off, because it cannot write to its own mount", () => {
  // Not a capability that is missing — one that cannot exist: the AppImage is a
  // read-only squashfs, and the runtime patches its library in place. The
  // refusal names the way out rather than just reporting the wall.
  const plan = updatePlan({ ...packaged(), binaryKind: "appimage" });
  assert(!plan.enabled);
  assertEquals(plan.url, null);
  assertStringIncludes(plan.reason ?? "", "ADD TO STEAM");

  // The copy it installs is an ordinary file tree and does update.
  for (const kind of ["installed", "executable", null] as const) {
    assert(updatePlan({ ...packaged(), binaryKind: kind }).enabled, `${kind}`);
  }
});

Deno.test("macOS is off while a patched bundle would not load", () => {
  // The bundle is code-signed and its library hashed page by page; a bsdiff
  // patch invalidates that and nothing re-signs, so the update would stage,
  // swap, fail to load and roll back on every poll.
  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const plan = updatePlan({ ...packaged(), target });
    assert(!plan.enabled, target);
    assertStringIncludes(plan.reason ?? "", "code-signed");
  }
});

Deno.test("a staging URL that is not https is refused, not silently ignored", () => {
  // Falling back to the production channel would make a staging run look like
  // it worked against the wrong origin.
  for (const url of ["http://staging.example/d", "ftp://x/y", "not a url"]) {
    const plan = updatePlan(packaged({ SHMUPX_UPDATE_URL: url }));
    assert(!plan.enabled, url);
    assertStringIncludes(plan.reason ?? "", "https");
  }
});

Deno.test("the signing key is not reachable from the environment", () => {
  // Steam Launch Options are environment. If this ever passes again, the
  // updater is repointable from a text field on a handheld.
  const plan = updatePlan({
    ...packaged({ SHMUPX_UPDATE_KEY: KEY }),
    publicKey: "",
  });
  assert(!plan.enabled);
  assertStringIncludes(plan.reason ?? "", "signing key");
});

Deno.test("a source checkout has nothing to update from", () => {
  const plan = updatePlan({ ...packaged(), version: null });
  assert(!plan.enabled);
  assertStringIncludes(plan.reason ?? "", "no version");
});

Deno.test("a build that is not a desktop app has no updater", () => {
  // The Windows `deno compile` .exe: no CEF, no Deno.autoUpdate.
  const plan = updatePlan({ ...packaged(), underDesktop: false });
  assert(!plan.enabled);
  assertStringIncludes(plan.reason ?? "", "no updater");
});

Deno.test("an architecture with no channel is off rather than guessed", () => {
  const plan = updatePlan({
    ...packaged(),
    target: "riscv64-unknown-linux-gnu",
  });
  assert(!plan.enabled);
  assertStringIncludes(plan.reason ?? "", "riscv64");
});

Deno.test("SHMUPX_NO_UPDATE switches it off for a run", () => {
  const plan = updatePlan(packaged({ SHMUPX_NO_UPDATE: "1" }));
  assert(!plan.enabled);
  assertStringIncludes(plan.reason ?? "", "switched off");
});

Deno.test("the channel is per-os and per-architecture, because a patch is", () => {
  assertEquals(updateChannel("x86_64-unknown-linux-gnu"), "linux-x86_64");
  assertEquals(updateChannel("aarch64-unknown-linux-gnu"), "linux-aarch64");
  assertEquals(updateChannel("aarch64-apple-darwin"), "macos-aarch64");
  assertEquals(updateChannel("x86_64-apple-darwin"), "macos-x86_64");
  assertEquals(updateChannel("x86_64-pc-windows-msvc"), "windows-x86_64");
  assertEquals(updateChannel("riscv64-unknown-linux-gnu"), null);
});

Deno.test("a staging channel can be pointed elsewhere, trailing slash or not", () => {
  assertEquals(
    updatePlan(packaged({ SHMUPX_UPDATE_URL: "https://staging.example/d/" }))
      .url,
    "https://staging.example/d/linux-x86_64",
  );
  assertEquals(
    updatePlan(packaged({ SHMUPX_UPDATE_URL: "https://staging.example/d" }))
      .url,
    "https://staging.example/d/linux-x86_64",
  );
});

Deno.test("the poll interval defaults to hourly and is overridable", () => {
  assertEquals(updatePlan(packaged()).intervalMs, 3_600_000);
  assertEquals(
    updatePlan(packaged({ SHMUPX_UPDATE_INTERVAL_MS: "60000" })).intervalMs,
    60_000,
  );
  // Nonsense falls back rather than polling in a tight loop.
  assertEquals(
    updatePlan(packaged({ SHMUPX_UPDATE_INTERVAL_MS: "nope" })).intervalMs,
    3_600_000,
  );
  assertEquals(
    updatePlan(packaged({ SHMUPX_UPDATE_INTERVAL_MS: "-5" })).intervalMs,
    3_600_000,
  );
});
