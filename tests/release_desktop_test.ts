// What a release has to be for a launcher to accept it — and the two mistakes
// that produce one nothing on earth will.
//
// The update channel is the only thing in this repo that can hand a player a
// new executable, and its failure mode is silence: a manifest signed with the
// wrong key, or a patch cut against the wrong library, looks perfect in a
// browser and is ignored (or rolled back) by every install. So the envelope is
// verified here exactly the way the runtime verifies it — raw Ed25519 public
// key, signature over the bytes of the `signed` string, manifest parsed only
// after that — rather than by round-tripping this file's own helpers.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  decodeBase64,
  encodeBase64,
  type LibraryFile,
  patchName,
  pickDylib,
  publicKeyFromSeed,
  sha256Hex,
  signedManifest,
} from "../scripts/release-desktop.ts";

async function freshSeed(): Promise<{ seed: string; publicKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return {
    // The last 32 bytes of the PKCS#8 wrapper are the seed.
    seed: encodeBase64(pkcs8.slice(16)),
    publicKey: encodeBase64(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    ),
  };
}

/** Verify an envelope the way `Deno.autoUpdate` does, and return the manifest. */
async function verify(envelope: string, publicKey: string) {
  const outer = JSON.parse(envelope);
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase64(publicKey) as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    decodeBase64(outer.signature) as BufferSource,
    new TextEncoder().encode(outer.signed),
  );
  return { ok, manifest: ok ? JSON.parse(outer.signed) : null };
}

Deno.test("a signed manifest verifies against the key the build carries", async () => {
  const { seed, publicKey } = await freshSeed();
  // Derived, not stored: a seed in a repository secret and a key in a source
  // file are edited years apart, and only a dead channel says they diverged.
  assertEquals(await publicKeyFromSeed(seed), publicKey);

  const envelope = await signedManifest({
    version: "2026.9.20",
    patches: {
      "2026.9.13": {
        name: patchName("2026.9.13", "2026.9.20"),
        sha256: "ab".repeat(32),
      },
    },
  }, seed);
  const { ok, manifest } = await verify(envelope, publicKey);
  assert(ok);
  assertEquals(manifest.version, "2026.9.20");
  assertEquals(
    manifest.patches["2026.9.13"].name,
    "patch-2026.9.13-to-2026.9.20.bin",
  );
});

Deno.test("the signature covers the bytes that ship, not a re-serialisation", async () => {
  // The runtime embeds the manifest verbatim as `signed` and trusts only what
  // it parses back out of it, precisely so nobody needs a canonical-JSON
  // implementation. Anything that re-stringifies the object to sign it works
  // until the day a key order or a space changes.
  const { seed, publicKey } = await freshSeed();
  const envelope = await signedManifest({ version: "1", patches: {} }, seed);
  const outer = JSON.parse(envelope);
  assertEquals(outer.signed, '{"version":"1","patches":{}}');
  assert((await verify(envelope, publicKey)).ok);

  // One byte of the manifest changed, signature untouched: refused.
  const tampered = JSON.stringify({
    signed: outer.signed.replace('"1"', '"2"'),
    signature: outer.signature,
  });
  assert(!(await verify(tampered, publicKey)).ok);
});

Deno.test("a manifest signed with another key is not this build's release", async () => {
  const mine = await freshSeed();
  const theirs = await freshSeed();
  const envelope = await signedManifest(
    { version: "1", patches: {} },
    theirs.seed,
  );
  assert(!(await verify(envelope, mine.publicKey)).ok);
});

Deno.test("half a key pair is not the other half", async () => {
  // The hazard the whole key discipline exists for: an Ed25519 private seed is
  // 32 bytes, so it is the same base64 length as the public key and pastes
  // into the same field without complaint.
  const { publicKey } = await freshSeed();
  assertEquals(decodeBase64(publicKey).length, 32);
  await assertRejects(
    () => signedManifest({ version: "1", patches: {} }, "dG9vIHNob3J0"),
    Error,
    "32 bytes",
  );
  // And the same refusal on the way IN, because `Uint8Array.set` pads rather
  // than complains: a short seed zero-filled to 32 bytes is a valid key for a
  // pair nobody has, and derives a public half that is simply not the one the
  // builds carry. Reported as "not a seed", never as a mismatch.
  await assertRejects(
    () => publicKeyFromSeed("dG9vIHNob3J0"),
    Error,
    "32 bytes",
  );
});

Deno.test("the runtime library is picked by name, never by size", () => {
  // CEF is the biggest file in the app by a wide margin and is NOT what the
  // updater patches. A patch cut against it applies cleanly, fails to boot, and
  // costs every player a failed launch before the rollback saves them.
  const tree: LibraryFile[] = [
    { rel: "usr/lib/libcef.so", size: 180_000_000 },
    { rel: "usr/lib/libdeno_desktop.so", size: 90_000_000 },
    { rel: "usr/lib/libEGL.so", size: 300_000 },
  ];
  assertEquals(pickDylib(tree).pick?.rel, "usr/lib/libdeno_desktop.so");

  // Nothing recognisable is an error with a way through, not a guess at the
  // largest.
  const blind = pickDylib([tree[0], tree[2]]);
  assertEquals(blind.pick, null);
  assertStringIncludes(blind.error ?? "", "--dylib");
  assertStringIncludes(blind.error ?? "", "libcef.so");

  // ...and so is a tree where two files could be it.
  const two = pickDylib([...tree, { rel: "usr/lib/libdenort.so", size: 1 }]);
  assertEquals(two.pick, null);
  assertStringIncludes(two.error ?? "", "more than one");
});

Deno.test("the runtime library of a real `deno desktop` app is named after the app", () => {
  // What the first release run actually built. Not one of these says "deno":
  // `deno desktop` names the runtime library after the app, so the name rule
  // above could never have matched any build this repo produces, and the run
  // stopped with "no library in this app names the Deno runtime".
  const shipped: LibraryFile[] = [
    { rel: "libcef.so", size: 256_300_000 },
    { rel: "libEGL.so", size: 800_000 },
    { rel: "libGLESv2.so", size: 20_000_000 },
    { rel: "libvk_swiftshader.so", size: 16_700_000 },
    { rel: "libvulkan.so.1", size: 1_500_000 },
    { rel: "shmupX.so", size: 192_200_000 },
  ];
  assertEquals(pickDylib(shipped).pick?.rel, "shmupX.so");

  // Still by elimination and never by size: CEF is the biggest file here and
  // is set aside by name, along with the rest of what it brings with it.
  const noApp = pickDylib(shipped.filter((f) => f.rel !== "shmupX.so"));
  assertEquals(noApp.pick, null);
  assertStringIncludes(noApp.error ?? "", "--dylib");

  // A second unrecognised library is ambiguity again — a plugin beside the
  // runtime must not be patched on a coin toss.
  const plugin = pickDylib([...shipped, {
    rel: "libsomething.so",
    size: 40_000,
  }]);
  assertEquals(plugin.pick, null);
  assertStringIncludes(plugin.error ?? "", "--dylib");
  assertStringIncludes(plugin.error ?? "", "libsomething.so");
});

Deno.test("a patch is named and hashed the way the manifest reads it", async () => {
  assertEquals(
    patchName("2026.9.13", "2026.9.20"),
    "patch-2026.9.13-to-2026.9.20.bin",
  );
  // Lowercase hex, 64 characters: the runtime refuses a patch whose bytes do
  // not hash to this, so it is the one field with no room for a format guess.
  const hex = await sha256Hex(new TextEncoder().encode("shmupX"));
  assertEquals(hex.length, 64);
  assertEquals(hex, hex.toLowerCase());
  assert(/^[0-9a-f]{64}$/.test(hex));
});
