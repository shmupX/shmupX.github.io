// tools/build-level/lib/run-deno-desktop.js is what replaced the electron-
// builder path. It is Node, and excluded from deno fmt/lint/check like the rest
// of tools/build-level, so — as tests/build_level_slug_test.ts does for the slug
// rule — this runs the real module in a subprocess rather than reimplementing
// it, and asserts the two things whose failure mode is silent.
//
// Both matter because `deno desktop` has no --app-name and no --identifier: it
// takes the app's identity from the output file's stem and from the deno.json
// it discovers. A bundle identifier that is not reverse-DNS, or carries a
// character outside [A-Za-z0-9.-], does not fail the build — it makes it skip
// the .desktop entry, which is what gives a Linux artifact its name and icon.

import { assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { harborRoot } from "../lib/repo-root.ts";

const ROOT = harborRoot();
const MODULE = join(
  ROOT,
  "tools",
  "build-level",
  "lib",
  "run-deno-desktop.js",
);

async function node(script: string): Promise<string> {
  const cmd = new Deno.Command("node", {
    args: ["-e", script],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(new TextDecoder().decode(stderr));
  }
  return new TextDecoder().decode(stdout).trim();
}

const REQUIRE = `const m = require(${JSON.stringify(MODULE)});`;

Deno.test("a game's bundle identifier is its Cordova package id", async () => {
  const out = await node(
    `${REQUIRE} process.stdout.write(m.identifierFor("com.easierbycode.a2028ai", "2028ai"));`,
  );
  // One game, one identity across every target it builds for.
  assertEquals(out, "com.easierbycode.a2028ai");
});

Deno.test("an unusable package id falls back to a valid one", async () => {
  // A slug that reduces to nothing, an id with no dot, and one carrying an
  // underscore — none of which are legal reverse-DNS — must still come back as
  // something `deno desktop` will accept rather than silently drop.
  for (
    const [packageId, slug] of [
      ["", "my-level"],
      ["notreversedns", "my-level"],
      ["com.easierbycode.my_level", "my-level"],
    ]
  ) {
    const out = await node(
      `${REQUIRE} process.stdout.write(m.identifierFor(${
        JSON.stringify(packageId)
      }, ${JSON.stringify(slug)}));`,
    );
    assertMatch(out, /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/, `for ${packageId}`);
  }
});

Deno.test("every desktop target maps to a deno triple", async () => {
  const out = await node(
    `${REQUIRE} const r = {};
     for (const p of ["windows", "mac", "linux"]) {
       for (const a of ["x64", "arm64"]) r[p + "/" + a] = m.tripleFor(p, a);
     }
     process.stdout.write(JSON.stringify(r));`,
  );
  assertEquals(JSON.parse(out), {
    "windows/x64": "x86_64-pc-windows-msvc",
    "windows/arm64": "aarch64-pc-windows-msvc",
    "mac/x64": "x86_64-apple-darwin",
    "mac/arm64": "aarch64-apple-darwin",
    "linux/x64": "x86_64-unknown-linux-gnu",
    "linux/arm64": "aarch64-unknown-linux-gnu",
  });
});

Deno.test("the macOS icon is a real icns, built without a Mac", async () => {
  // `deno desktop` converts a --icon PNG for a mac target through a Mac-only
  // tool and dies with a bare "program not found", so the .icns has to be
  // assembled here. Its header is "icns" + the total length.
  const icons = join(ROOT, "tools", "build-level", "scaffold", "icons");
  const out = await node(
    `${REQUIRE} const b = m.buildIcns([${
      JSON.stringify(join(icons, "icon-512.png"))
    }]);
     process.stdout.write(JSON.stringify({
       magic: b.subarray(0, 4).toString("ascii"),
       declared: b.readUInt32BE(4),
       actual: b.length,
     }));`,
  );
  const icns = JSON.parse(out);
  assertEquals(icns.magic, "icns");
  assertEquals(icns.declared, icns.actual);
});
