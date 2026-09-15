#!/usr/bin/env -S deno run -A
// scripts/release-desktop.ts — publish what lib/self-update.ts watches.
//
//   deno task release:keygen
//   deno task release:desktop -- --new build/desktop/shmupX-linux-x86_64 \
//       --old 2026.9.13=build/old/shmupX-linux-x86_64.AppImage
//
// The launcher half has been done since `Let a packaged launcher patch itself`:
// a build polls `<baseUrl>/<os>-<arch>/latest.json` hourly, fetches a signed
// bsdiff of its runtime dylib, stages it and rolls back by itself if the next
// launch fails. Nothing has ever answered that URL. This writes what does.
//
// WHAT A RELEASE IS, in the runtime's terms (docs.deno.com/runtime/desktop/
// auto_update): a `latest.json` naming the newest version and, per older
// version still supported, one bsdiff patch of THE APP'S RUNTIME DYLIB with its
// SHA-256. Not the executable, not the AppImage — the dylib inside the built
// app. A version with no patch listed is not broken, it simply stays where it
// is, so dropping old builds off the end is a supported thing to do.
//
// THREE REFUSALS, all for the same reason: every one of them, waved through,
// produces a release whose only symptom is silence.
//
//   * Signing with a key this build does not carry. A launcher verifies the
//     envelope against the key compiled into it (lib/self-update.ts's
//     BUILD_PUBLIC_KEY); sign with any other and every install ignores every
//     release forever, while the manifest looks perfect in a browser.
//   * Guessing which file is the dylib. A `deno desktop` app ships more than
//     one shared library and the biggest is CEF's, not the runtime's. Patching
//     the wrong one produces a patch that applies cleanly and then fails to
//     boot — recoverable, because the launcher rolls back, but every player
//     sees a failed launch first. So the pick is by name — the runtime is named
//     after the APP (shmupX.so), so it is found by setting CEF's own aside and
//     seeing what is left — and anything still ambiguous is an error with
//     --dylib as the way through, never a guess at the largest.
//   * Publishing a patch without applying it. `bspatch` is right there, so the
//     patch is applied to the old dylib and the result compared to the new one
//     byte for byte before the manifest names it.
//
// It needs `bsdiff`/`bspatch` on PATH (dnf install bsdiff, apt install bsdiff,
// brew install bsdiff). Writing a bsdiff 4 encoder here — suffix sorting plus
// three bzip2 streams, over a library of a few hundred MB — would be a worse
// version of a tool every distro packages.
//
// The default output is build/release/<channel>/, which is git-ignored. Serving
// it from codemonkey.games/desktop — the baseUrl deno.json pins — means copying
// that into static/desktop/<channel>/ and deploying, which does commit a patch
// of a few MB per release into the repo. That is a decision about the repo's
// size, so this script does not make it.

import { basename, join } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import { BUILD_PUBLIC_KEY, updateChannel } from "../lib/self-update.ts";

// ─── Keys ────────────────────────────────────────────────────────────────────

/**
 * An Ed25519 private key is a 32-byte seed; Web Crypto wants it in PKCS#8.
 * The wrapper is fixed for this curve, so it is a constant prefix rather than a
 * DER encoder.
 */
const PKCS8_PREFIX = new Uint8Array([
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
]);

export function decodeBase64(value: string): Uint8Array {
  const raw = atob(value.trim());
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The PKCS#8 wrapper around a seed — and the length check, in the one place
 * both callers go through.
 *
 * `Uint8Array.set` pads rather than complains: a 29-byte seed written into a
 * 32-byte buffer is a perfectly valid key for a pair nobody has, and derives a
 * public half that simply is not the one the builds carry. That is the same
 * "a truncated key is the same shape as a real one" hazard the whole key
 * discipline exists for, so it cannot live in only one of the two paths that
 * read a seed — which is what it did until this shared it.
 */
function seedToPkcs8(seedB64: string): Uint8Array {
  const seed = decodeBase64(seedB64);
  if (seed.length !== 32) {
    throw new Error(
      `a signing seed is 32 bytes; this one is ${seed.length}. An Ed25519 ` +
        `PUBLIC key is also 32 bytes and the same base64 length, so check ` +
        `which half this is.`,
    );
  }
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  return pkcs8;
}

/** The signing key, from the 32-byte seed the release secret holds. */
export async function importSeed(seedB64: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "pkcs8",
    seedToPkcs8(seedB64) as BufferSource,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

/**
 * The public half of a seed, base64 — what a build has to carry.
 *
 * Derived rather than stored, because the alternative is a pair that can drift:
 * the seed in a repository secret and the key in a source file are edited years
 * apart, and nothing but a dead update channel ever says they stopped matching.
 */
export async function publicKeyFromSeed(seedB64: string): Promise<string> {
  const priv = await crypto.subtle.importKey(
    "pkcs8",
    seedToPkcs8(seedB64) as BufferSource,
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  // The JWK's "x" is the public key, base64url. The manifest wants plain
  // base64, which is the same bytes with two characters swapped.
  return (jwk.x ?? "").replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - ((jwk.x ?? "").length % 4)) % 4);
}

// ─── The manifest ────────────────────────────────────────────────────────────

export interface PatchEntry {
  /** The patch filename, relative to the manifest's own URL. */
  name: string;
  /** Lowercase hex SHA-256 of the patch bytes. The runtime requires it. */
  sha256: string;
}

export interface Manifest {
  version: string;
  patches: Record<string, PatchEntry>;
}

/** `patch-<from>-to-<to>.bin`, the name the runtime's own docs use. */
export function patchName(from: string, to: string): string {
  return `patch-${from}-to-${to}.bin`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The signed envelope, as the file to upload.
 *
 * The manifest is embedded VERBATIM as the `signed` string and the signature
 * covers those exact bytes — that is the runtime's design, and it is why this
 * serialises once and signs the same text it writes. Re-stringifying the object
 * to sign it would work today and break the first time a key order or a space
 * changed.
 */
export async function signedManifest(
  manifest: Manifest,
  seedB64: string,
): Promise<string> {
  const signed = JSON.stringify(manifest);
  const key = await importSeed(seedB64);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      new TextEncoder().encode(signed),
    ),
  );
  return JSON.stringify(
    { signed, signature: encodeBase64(signature) },
    null,
    2,
  );
}

// ─── Finding the dylib ───────────────────────────────────────────────────────

export interface LibraryFile {
  /** Path relative to the app tree, so old and new can be compared. */
  rel: string;
  size: number;
}

/** Shared libraries under a built app, deepest name intact. */
export async function libraries(root: string): Promise<LibraryFile[]> {
  const out: LibraryFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(path, rel);
      } else if (
        entry.isFile && /\.(so|so\.\d+|dylib|dll)$/i.test(entry.name)
      ) {
        out.push({ rel, size: (await Deno.stat(path)).size });
      }
    }
  };
  await walk(root, "");
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Which of them is the runtime the updater patches.
 *
 * By NAME, never by size: CEF's libcef.so is the biggest file in a `deno
 * desktop` app by a wide margin and is not the file being patched. A tree where
 * the name does not decide it is an error rather than a guess, because the cost
 * of being wrong is a release that boots nobody until it rolls back.
 */
export function pickDylib(
  files: LibraryFile[],
): { pick: LibraryFile | null; error: string | null } {
  const denoish = files.filter((f) =>
    /deno/i.test(basename(f.rel)) && !/^libcef/i.test(basename(f.rel))
  );
  if (denoish.length === 1) return { pick: denoish[0], error: null };
  const list = files.length
    ? files.map((f) => `    ${f.rel} (${(f.size / 1e6).toFixed(1)}MB)`).join(
      "\n",
    )
    : "    (none)";
  if (denoish.length > 1) {
    return {
      pick: null,
      error: `more than one library looks like the Deno runtime, so none was ` +
        `picked. Pass --dylib <path relative to the app> with the right one:\n` +
        denoish.map((f) => `    ${f.rel}`).join("\n"),
    };
  }
  // Nothing says "deno" — which is the normal case, not a broken tree. A
  // `deno desktop` app names its runtime library after the APP: the first real
  // run of this produced shmupX.so beside libcef.so, and the name rule above
  // could not have matched any app ever built here.
  //
  // So: take out what CEF brings with it, which is a fixed and published set of
  // names, and see what is left. Exactly one file left is not a guess about
  // which is biggest — it is the only candidate there is, and the run prints
  // the pick before it patches anything. More than one is ambiguity again, and
  // goes back to --dylib.
  const cefish =
    /^(libcef|libEGL|libGLESv2|libvk_swiftshader|libvulkan|libGLX|libOSMesa)\b/i;
  const rest = files.filter((f) => !cefish.test(basename(f.rel)));
  if (rest.length === 1) return { pick: rest[0], error: null };
  if (rest.length > 1) {
    return {
      pick: null,
      error: `no library here names the Deno runtime, and more than one is ` +
        `left once CEF's own are set aside, so none was picked. Pass --dylib ` +
        `<path relative to the app> with the right one:\n` +
        rest.map((f) => `    ${f.rel} (${(f.size / 1e6).toFixed(1)}MB)`).join(
          "\n",
        ),
    };
  }
  return {
    pick: null,
    error:
      `no library in this app names the Deno runtime, and the largest one is ` +
      `CEF rather than the file the updater patches. Pass --dylib <path ` +
      `relative to the app>. What is in there:\n${list}`,
  };
}

// ─── Reading an app off disk ─────────────────────────────────────────────────

/**
 * A built app as a directory, extracting an .AppImage first if that is what it
 * is.
 *
 * `--appimage-extract` is the runtime's own flag and needs no FUSE, but it does
 * mean running the artifact, so it only works for the host's own OS and
 * architecture. Refusing beats extracting the wrong thing quietly.
 */
export async function appTree(
  path: string,
  scratch: string,
): Promise<{ dir: string; cleanup: string | null }> {
  const stat = await Deno.stat(path);
  if (stat.isDirectory) return { dir: path, cleanup: null };
  if (!/\.AppImage$/i.test(path)) {
    throw new Error(
      `${path} is neither a directory nor an .AppImage. Build with ` +
        `\`deno task build:linux --no-appimage\` to get the app directory.`,
    );
  }
  if (Deno.build.os !== "linux") {
    throw new Error(
      `extracting ${basename(path)} means running it, which needs Linux. ` +
        `Pass the app directory instead.`,
    );
  }
  const into = await Deno.makeTempDir({ dir: scratch, prefix: "appimage-" });
  const run = new Deno.Command(await Deno.realPath(path), {
    args: ["--appimage-extract"],
    cwd: into,
    stdout: "null",
    stderr: "piped",
  });
  const { code, stderr } = await run.output();
  if (code !== 0) {
    throw new Error(
      `${basename(path)} --appimage-extract failed: ${
        new TextDecoder().decode(stderr).trim()
      }`,
    );
  }
  return { dir: join(into, "squashfs-root"), cleanup: into };
}

// ─── bsdiff ──────────────────────────────────────────────────────────────────

async function tool(name: string): Promise<boolean> {
  try {
    const { code } = await new Deno.Command(name, {
      stdout: "null",
      stderr: "null",
    }).output();
    // bsdiff with no arguments exits non-zero with a usage message; what is
    // being tested is whether it is there at all.
    return code !== 127;
  } catch {
    return false;
  }
}

async function run(name: string, args: string[]): Promise<void> {
  const { code, stderr } = await new Deno.Command(name, {
    args,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `${name} ${args.join(" ")} exited ${code}: ${
        new TextDecoder().decode(stderr).trim()
      }`,
    );
  }
}

/**
 * Diff one dylib against another, and prove the patch reproduces it.
 *
 * The check is the point. A patch that applies and then does not boot is the
 * failure the runtime's own docs warn about, and it costs every player one
 * failed launch before the rollback saves them. Applying it here and comparing
 * the SHA-256 turns that into a release that does not go out.
 */
export async function makePatch(
  oldDylib: string,
  newDylib: string,
  out: string,
  scratch: string,
): Promise<{ bytes: number; sha256: string }> {
  await run("bsdiff", [oldDylib, newDylib, out]);
  const patch = await Deno.readFile(out);
  const check = join(scratch, `${basename(out)}.applied`);
  await run("bspatch", [oldDylib, check, out]);
  const applied = await sha256Hex(await Deno.readFile(check));
  const wanted = await sha256Hex(await Deno.readFile(newDylib));
  await Deno.remove(check).catch(() => {});
  if (applied !== wanted) {
    // Take the patch with it. Nothing would ever fetch a file no manifest
    // names, but "nothing was published" has to be true of the directory as
    // well as of the manifest.
    await Deno.remove(out).catch(() => {});
    throw new Error(
      `the patch does not reproduce the new library (${applied} != ` +
        `${wanted}). Nothing was published.`,
    );
  }
  return { bytes: patch.length, sha256: await sha256Hex(patch) };
}

// ─── The commands ────────────────────────────────────────────────────────────

async function keygen(): Promise<void> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const seed = encodeBase64(pkcs8.slice(PKCS8_PREFIX.length));
  const publicKey = encodeBase64(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  console.log(`
  A release key pair. Both halves are 32 bytes and therefore the same base64
  length, which is exactly how the wrong one gets pasted into a source file —
  so they are labelled, and nothing here writes either to disk.

  PUBLIC — lib/self-update.ts, BUILD_PUBLIC_KEY:

    export const BUILD_PUBLIC_KEY = "${publicKey}";

  PRIVATE — the SHMUPX_UPDATE_SECRET repository secret, and nowhere else. It
  signs every release this key's builds will ever accept; there is no revoking
  it short of shipping a new build to everybody by hand.

    ${seed}

  Neither belongs on the release host: the manifest is signed before it is
  uploaded.
`);
}

/**
 * Prove the secret and the source file are two halves of one key pair.
 *
 * Until something does this, nothing has: `publish` compares them, but only
 * after a build exists, so the first proof that the pair matches would arrive
 * ~450MB into cutting a release. And the mistake it catches is total — a
 * launcher verifies against the key compiled into it, so a mismatch is not a
 * degraded channel, it is no channel at all, in every copy already out there,
 * with silence as the only symptom.
 *
 * It is cheap enough to run on every push that touches either: derive the
 * public half of the seed and compare. Nothing prints the seed — the derived
 * key is the public one, and saying it is what makes a mismatch diagnosable
 * rather than just red.
 */
async function checkKey(seed: string): Promise<boolean> {
  let derived: string;
  try {
    derived = await publicKeyFromSeed(seed);
  } catch (e) {
    console.error(
      `\n  SHMUPX_UPDATE_SECRET is not a signing seed: ${
        (e as Error).message
      }\n`,
    );
    return false;
  }
  if (!BUILD_PUBLIC_KEY) {
    console.error(
      `\n  lib/self-update.ts carries no key, so every build refuses to update.\n` +
        `  The secret's public half is:\n\n` +
        `    export const BUILD_PUBLIC_KEY = "${derived}";\n`,
    );
    return false;
  }
  if (derived !== BUILD_PUBLIC_KEY) {
    console.error(
      `\n  The secret and the build do not match.\n\n` +
        `    SHMUPX_UPDATE_SECRET signs for  ${derived}\n` +
        `    lib/self-update.ts carries      ${BUILD_PUBLIC_KEY}\n\n` +
        `  Every release this secret signs would be ignored by every install.\n` +
        `  Both halves are 32 bytes and the same base64 length, so the usual\n` +
        `  cause is one of them being the wrong half of its pair.\n`,
    );
    return false;
  }
  console.log(
    `\n  The secret is the private half of ${derived} — the key the builds\n` +
      `  carry. A release signed with it verifies.\n`,
  );
  return true;
}

interface PublishOptions {
  newApp: string;
  olds: { version: string; app: string }[];
  version: string;
  channel: string;
  out: string;
  dylib: string | null;
  seed: string;
}

async function publish(opts: PublishOptions): Promise<void> {
  const derived = await publicKeyFromSeed(opts.seed);
  if (BUILD_PUBLIC_KEY && derived !== BUILD_PUBLIC_KEY) {
    throw new Error(
      `this key signs for ${derived}, and the builds carry ` +
        `${BUILD_PUBLIC_KEY}. Every install would ignore this release. ` +
        `Nothing was written.`,
    );
  }
  if (!BUILD_PUBLIC_KEY) {
    console.log(
      `  NOTE: lib/self-update.ts carries no key, so every build currently\n` +
        `  refuses to update at all. Paste this one in and rebuild before\n` +
        `  this release can reach anybody:\n\n` +
        `    export const BUILD_PUBLIC_KEY = "${derived}";\n`,
    );
  }

  const scratch = await Deno.makeTempDir({ prefix: "shmupx-release-" });
  const cleanups: string[] = [];
  try {
    const fresh = await appTree(opts.newApp, scratch);
    if (fresh.cleanup) cleanups.push(fresh.cleanup);
    const inNew = await libraries(fresh.dir);
    let rel = opts.dylib;
    if (!rel) {
      const { pick, error } = pickDylib(inNew);
      if (!pick) throw new Error(error ?? "no runtime library found");
      rel = pick.rel;
      console.log(`  Patching ${rel}.`);
    }
    const newDylib = join(fresh.dir, rel);
    await Deno.stat(newDylib);

    const patches: Record<string, PatchEntry> = {};
    const outDir = join(opts.out, opts.channel);
    await Deno.mkdir(outDir, { recursive: true });

    for (const old of opts.olds) {
      if (old.version === opts.version) {
        throw new Error(
          `--old ${old.version} is the version being released; a build cannot ` +
            `patch to itself`,
        );
      }
      const tree = await appTree(old.app, scratch);
      if (tree.cleanup) cleanups.push(tree.cleanup);
      const oldDylib = join(tree.dir, rel);
      try {
        await Deno.stat(oldDylib);
      } catch {
        throw new Error(
          `${old.version} has no ${rel} in it. A patch is a diff of one exact ` +
            `file against another, so the two builds have to agree on which.`,
        );
      }
      const name = patchName(old.version, opts.version);
      const result = await makePatch(
        oldDylib,
        newDylib,
        join(outDir, name),
        scratch,
      );
      patches[old.version] = { name, sha256: result.sha256 };
      console.log(
        `  ${old.version} -> ${opts.version}: ${name} (${
          (result.bytes / 1e6).toFixed(1)
        }MB, verified).`,
      );
    }

    const manifest: Manifest = { version: opts.version, patches };
    const envelope = await signedManifest(manifest, opts.seed);
    await Deno.writeTextFile(join(outDir, "latest.json"), envelope);
    console.log(
      `\n  ${join(outDir, "latest.json")} — ${opts.channel}, signed.`,
    );
    if (!opts.olds.length) {
      console.log(
        `  It lists no patches, so no install updates FROM anything: this is\n` +
          `  a first release, or every older build has been dropped. Pass\n` +
          `  --old <version>=<app> for each one that should reach it.`,
      );
    }
    console.log(
      `\n  Upload the directory to ` +
        `https://codemonkey.games/desktop/${opts.channel}/ — latest.json and ` +
        `every patch beside it.\n`,
    );
  } finally {
    for (const dir of cleanups) {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
}

async function repoVersion(): Promise<string> {
  const config = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  );
  return String(config.version ?? "");
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["new", "old", "version", "channel", "target", "out", "dylib"],
    boolean: ["keygen", "check-key", "help"],
    collect: ["old"],
    default: { out: "build/release" },
  });

  if (args.help) {
    console.log(`
  deno task release:keygen
  deno task release:checkkey
  deno task release:desktop -- --new <app> [--old <version>=<app> ...] [flags]

    --new <app>             the build being released: an app directory, or an
                            .AppImage (extracted on Linux)
    --old <version>=<app>   a build that should be able to update to it;
                            repeatable
    --version <v>           what to call the new build (default: deno.json)
    --target <triple>       which channel, from a Deno target triple
    --channel <os-arch>     ...or name the channel outright
    --dylib <rel path>      the runtime library to diff, when the name in the
                            app does not decide it
    --out <dir>             where to write (default: build/release)

  The signing seed comes from SHMUPX_UPDATE_SECRET. release:checkkey proves it
  is the private half of the key lib/self-update.ts carries, and nothing else
  reads a release key without building one first.
`);
    Deno.exit(0);
  }

  if (args.keygen) {
    await keygen();
    Deno.exit(0);
  }

  if (args["check-key"]) {
    const secret = (Deno.env.get("SHMUPX_UPDATE_SECRET") ?? "").trim();
    if (!secret) {
      // Deliberately an error rather than a skip. A key check that passes when
      // there is no key to check is the thing this exists to prevent: it would
      // go green forever while nothing had ever verified the pair.
      console.error(
        "\n  SHMUPX_UPDATE_SECRET is not set, so there is nothing to check\n" +
          "  against. It is the 32-byte base64 seed `deno task release:keygen`\n" +
          "  labelled PRIVATE, and it belongs in exactly one place:\n\n" +
          "    Settings -> Secrets and variables -> Actions -> New repository\n" +
          "    secret, named SHMUPX_UPDATE_SECRET\n\n" +
          "  An organisation secret not granted to this repository, or an\n" +
          "  environment secret without a matching `environment:` on the job,\n" +
          "  both arrive here looking exactly like this.\n",
      );
      Deno.exit(1);
    }
    Deno.exit(await checkKey(secret) ? 0 : 1);
  }

  // Annotated rather than inferred: TypeScript only narrows past a call that
  // returns `never` when the binding says so outright.
  const die: (line: string) => never = (line) => {
    console.error(`\n  ${line}\n`);
    Deno.exit(1);
  };

  if (!args.new) {
    die("--new <app> is what is being released. Nothing else to do.");
  }
  for (const name of ["bsdiff", "bspatch"]) {
    if (!(await tool(name))) {
      die(
        `${name} is not on PATH, and the patches are its output. ` +
          `dnf install bsdiff / apt install bsdiff / brew install bsdiff.`,
      );
    }
  }
  const seed = (Deno.env.get("SHMUPX_UPDATE_SECRET") ?? "").trim();
  if (!seed) {
    die(
      "SHMUPX_UPDATE_SECRET is not set, and an unsigned manifest is one every " +
        "build refuses. `deno task release:keygen` makes a pair.",
    );
  }
  const channel = args.channel ??
    (args.target ? updateChannel(args.target) : null) ??
    updateChannel(Deno.build.target);
  if (!channel) {
    die(`no release channel for ${args.target ?? Deno.build.target}`);
  }
  const olds = (args.old ?? []).map((entry) => {
    const at = entry.indexOf("=");
    if (at <= 0) {
      die(`--old wants <version>=<app>, not ${entry}`);
    }
    return { version: entry.slice(0, at), app: entry.slice(at + 1) };
  });
  const version = args.version ?? await repoVersion();
  if (!version) die("no --version, and deno.json has none either");

  try {
    await publish({
      newApp: args.new,
      olds,
      version,
      channel,
      out: args.out,
      dylib: args.dylib ?? null,
      seed,
    });
  } catch (e) {
    die((e as Error).message);
  }
}
