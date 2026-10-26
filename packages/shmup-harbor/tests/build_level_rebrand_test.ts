// `--build-number` is what lets the TestFlight workflow upload the same level
// twice: App Store Connect refuses a CFBundleVersion it has seen for a version,
// so .github/workflows/ios-publish.yml passes the clock in, and
// tools/build-level/lib/rebrand.js writes it into config.xml as
// ios-CFBundleVersion — and as android-versionCode only when it is the plain
// integer Android insists on. tools/build-level is excluded from deno's own
// checks, so this runs the Node code for real against the scaffold's config.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { harborRoot } from "../lib/repo-root.ts";

const TOOL = join(harborRoot(), "tools", "build-level");

async function rebrand(
  name: string,
  packageId: string,
  buildNumber?: string,
): Promise<string> {
  const script = `
    const { rebrandConfigXml } = require(${
    JSON.stringify(join(TOOL, "lib", "rebrand.js"))
  });
    const xml = rebrandConfigXml(
      ${JSON.stringify(join(TOOL, "scaffold", "config.xml"))},
      ${JSON.stringify(name)}, ${JSON.stringify(packageId)}, undefined,
      ${buildNumber === undefined ? "undefined" : JSON.stringify(buildNumber)});
    process.stdout.write(xml);`;
  const out = await new Deno.Command("node", {
    args: ["-e", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout);
}

const widget = (xml: string) => /<widget\b[^>]*>/.exec(xml)![0];

Deno.test("a dotted build number reaches iOS only; an integer reaches both", async () => {
  const ios = widget(
    await rebrand("foo", "com.easierbycode.game2028", "20261025.1430.7"),
  );
  assertMatch(ios, /\sid="com\.easierbycode\.game2028"/);
  assertMatch(ios, /\sios-CFBundleVersion="20261025\.1430\.7"/);
  assert(!/android-versionCode=/.test(ios), ios);

  const both = widget(await rebrand("foo", "com.easierbycode.foo", "42"));
  assertMatch(both, /\sios-CFBundleVersion="42"/);
  assertMatch(both, /\sandroid-versionCode="42"/);
  // `version` itself is untouched: the build number is the other axis.
  assertMatch(both, /\sversion="1\.0\.0"/);
});

Deno.test("no build number leaves the scaffold's widget tag as it was", async () => {
  const plain = widget(await rebrand("foo", "com.easierbycode.foo"));
  assert(!/CFBundleVersion|versionCode/.test(plain), plain);
  assertEquals(
    plain.includes('id="com.easierbycode.foo"') &&
      plain.includes('version="1.0.0"'),
    true,
  );
});

Deno.test("a second rebrand replaces the number rather than stacking it", async () => {
  // The scaffold never carries one, so write one in and run the rule over
  // the result through a temp copy.
  const once = await rebrand("foo", "com.easierbycode.foo", "1");
  const tmp = await Deno.makeTempFile({ suffix: ".xml" });
  try {
    await Deno.writeTextFile(tmp, once);
    const script = `
      const { rebrandConfigXml } = require(${
      JSON.stringify(join(TOOL, "lib", "rebrand.js"))
    });
      process.stdout.write(rebrandConfigXml(${
      JSON.stringify(tmp)
    }, "foo", "com.easierbycode.foo", undefined, "2"));`;
    const out = await new Deno.Command("node", {
      args: ["-e", script],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    const twice = widget(new TextDecoder().decode(out.stdout));
    assertEquals(twice.match(/ios-CFBundleVersion=/g)?.length, 1);
    assertMatch(twice, /\sios-CFBundleVersion="2"/);
    assertMatch(twice, /\sandroid-versionCode="2"/);
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
});
