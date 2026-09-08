// The AppImage-from-Windows bridge: the pieces that fail silently.
//
// tools/build-level/lib/appimage-bridge.js exists because electron-builder
// assembles an AppImage with mksquashfs and every copy it ships is a Linux
// binary — so on Windows the target used to die inside app-builder with
// `exec: "…\linux-arm64\mksquashfs": file does not exist`, which reads like a
// failed download and is not. The bridge answers that by pointing app-builder's
// MKSQUASHFS_PATH at bin/mksquashfs.cmd, which forwards the call into WSL.
//
// Two things about that arrangement break quietly rather than loudly, which is
// what this file is for:
//
//   * the .cmd and the .js next to it are a PAIR, wired by name. Rename or drop
//     one and nothing complains until a build is minutes in and app-builder
//     reports a missing executable again — the very error the bridge exists to
//     prevent.
//   * argument translation. app-builder passes the stage dir and the output
//     file as Windows paths and everything else as flags; translating one flag
//     value by mistake, or missing one of the two paths, produces a build that
//     fails deep inside mksquashfs rather than here.
//
// Like tests/build_level_slug_test.ts, this runs the Node copy for real —
// tools/build-level is excluded from deno.json's fmt/lint/check, so a test that
// actually executes it is the only coverage it has.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");
const BIN = join(ROOT, "tools", "build-level", "bin");
const SHIM_CMD = join(BIN, "mksquashfs.cmd");
const SHIM_JS = join(BIN, "mksquashfs-wsl.js");

async function haveNode(): Promise<boolean> {
  try {
    return (await new Deno.Command("node", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch (_e) {
    return false;
  }
}

/** Run a snippet in the tool's own runtime and parse what it writes back. */
async function inNode(script: string): Promise<unknown> {
  const out = await new Deno.Command("node", {
    args: ["-e", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(new TextDecoder().decode(out.stderr));
  }
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

const nodeAvailable = await haveNode();
if (!nodeAvailable) {
  console.log("  (appimage bridge: skipped — no node on PATH)");
}

Deno.test("the WSL stand-in is a matched pair of files", async () => {
  const cmd = await Deno.readTextFile(SHIM_CMD);
  // The .cmd names its sibling; the two move together or not at all.
  assert(
    cmd.includes("mksquashfs-wsl.js"),
    "bin/mksquashfs.cmd no longer invokes mksquashfs-wsl.js",
  );
  assert((await Deno.stat(SHIM_JS)).isFile);
  // app-builder execs MKSQUASHFS_PATH directly, so a shim that swallows a
  // non-zero status would let a failed squashfs pass for a built AppImage.
  const js = await Deno.readTextFile(SHIM_JS);
  assert(
    js.includes("process.exit("),
    "mksquashfs-wsl.js must propagate mksquashfs's exit status",
  );
});

Deno.test({
  name: "only the Windows paths in app-builder's argv are translated",
  ignore: !nodeAvailable,
  async fn() {
    // Verbatim from a real failing run: the two paths, then flags, then
    // -offset's numeric value, which must survive untouched.
    const argv = [
      "C:\\Users\\me\\AppData\\Local\\Temp\\build\\electron\\dist\\__appImage-x64",
      "C:\\Users\\me\\AppData\\Local\\Temp\\build\\electron\\dist\\game.AppImage",
      "-offset",
      "188392",
      "-all-root",
      "-noappend",
      "-no-progress",
      "-quiet",
      "-no-xattrs",
      "-no-fragments",
    ];
    const script = `
      const { isWindowsPath } = require(${JSON.stringify(SHIM_JS)});
      const argv = ${JSON.stringify(argv)};
      process.stdout.write(JSON.stringify(argv.map(isWindowsPath)));
    `;
    const flags = await inNode(script) as boolean[];
    assertEquals(
      flags,
      [true, true, false, false, false, false, false, false, false, false],
      "the stage dir and the output file translate; nothing else does",
    );
  },
});

Deno.test({
  name: "forward-slash and lowercase drive letters count as Windows paths",
  ignore: !nodeAvailable,
  async fn() {
    // electron-builder's own logs show both spellings, and the drive letter is
    // whatever the user's TEMP sits on.
    const script = `
      const { isWindowsPath } = require(${JSON.stringify(SHIM_JS)});
      const cases = ["C:/x/y", "d:\\\\x\\\\y", "-offset", "188392", "/mnt/c/x"];
      process.stdout.write(JSON.stringify(cases.map(isWindowsPath)));
    `;
    assertEquals(
      await inNode(script) as boolean[],
      [true, true, false, false, false],
    );
  },
});

Deno.test({
  name: "the bridge either hands over a real stand-in or says why it cannot",
  ignore: !nodeAvailable,
  async fn() {
    const script = `
      const { appImageBridge } = require(${
      JSON.stringify(join(ROOT, "tools", "build-level", "lib", "appimage-bridge.js"))
    });
      // The bridge steps aside when the caller has already chosen a mksquashfs;
      // clear those so this measures the bridge's own answer.
      delete process.env.MKSQUASHFS_PATH;
      delete process.env.USE_SYSTEM_MKSQUASHFS;
      process.stdout.write(JSON.stringify(appImageBridge() ?? null));
    `;
    const bridge = await inNode(script) as
      | null
      | { ok: boolean; reason?: string; env?: Record<string, string> };

    if (Deno.build.os !== "windows") {
      // Linux has a mksquashfs and the toolchain carries a macOS one, so there
      // is nothing to bridge and nothing to refuse.
      assertEquals(bridge, null);
      return;
    }
    assert(bridge !== null);
    if (!bridge.ok) {
      // No WSL on this machine. The point of the guard is that the message
      // says what to install — the old failure named a path and left it there.
      assert(
        /wsl/i.test(bridge.reason ?? ""),
        "the refusal must name WSL as what is missing",
      );
      return;
    }
    const shim = bridge.env?.MKSQUASHFS_PATH ?? "";
    assertEquals(
      shim,
      SHIM_CMD,
      "app-builder is pointed at bin/mksquashfs.cmd",
    );
    // A path app-builder cannot exec is the bug this whole file is about.
    assert((await Deno.stat(shim)).isFile);
  },
});
