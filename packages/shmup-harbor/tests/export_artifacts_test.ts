// findArtifacts is what turns "the build tool exited 0" into "here is the app",
// and for three of the six targets it had quietly stopped doing that. It matched
// one hard-coded extension per platform, so every time the builder renamed its
// output the lookup returned an empty list — and an empty list is not
// distinguishable, further up, from a build that produced nothing. The export
// then reported success with no artifact and the editor painted a green
// "built: see build/ output" over it.
//
// The three that drifted: the electron-builder → `deno desktop` swap made the
// Windows artifact <slug>.msi while this looked for ".exe", made the macOS one
// <slug>.app which is a DIRECTORY and so failed the isFile test, and iOS has
// never written a .ipa at all off a Mac — `cordova prepare ios` stages an Xcode
// project and stops.
//
// So these tests pin what replaced the extension table. The tool now records
// what it built in build/<slug>/artifacts.json and that is what is read; the
// scan survives only as a fallback for a tree an older copy of the tool made,
// and it is scoped to the extensions the platform can actually produce —
// because dist/ is shared by every target for a game, so "return everything in
// dist" would hand an iOS export the .exe a Windows build left there last week.
// And when an iOS build has no app to show, the staged Xcode project is zipped
// into dist/ and handed back, out of reach of the rm -rf that begins every
// cordova run.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  findArtifacts,
  IOS_PROJECT_SUFFIX,
  isIosProject,
  packageIosProject,
} from "../lib/export-build.ts";
// The witness is the app's own browser unzipper — the one the export panel
// reads a finished artifact with — rather than a second reader written here.
// It lives outside the package, which only tests may do: they never publish.
import { unzip } from "../../../static/zip-read.js";

/** A build tree with `files` in build/<slug>/dist. */
async function tree(
  slug: string,
  files: Array<{ name: string; dir?: boolean }>,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "shmupx-artifacts-" });
  const dist = join(root, "build", slug, "dist");
  await Deno.mkdir(dist, { recursive: true });
  for (const f of files) {
    if (f.dir) await Deno.mkdir(join(dist, f.name), { recursive: true });
    else await Deno.writeTextFile(join(dist, f.name), "x");
  }
  return root;
}

Deno.test("findArtifacts finds the .msi a Windows build actually writes", async () => {
  const root = await tree("valkyrie", [{ name: "valkyrie.msi" }]);
  try {
    const found = await findArtifacts(root, "valkyrie", "windows");
    assertEquals(found.length, 1);
    assert(found[0].endsWith("valkyrie.msi"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("findArtifacts finds a macOS .app, which is a directory", async () => {
  const root = await tree("valkyrie", [{ name: "valkyrie.app", dir: true }]);
  try {
    const found = await findArtifacts(root, "valkyrie", "mac");
    assertEquals(found.length, 1);
    assert(found[0].endsWith("valkyrie.app"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the fallback scan ignores other targets' leftovers in the shared dist", async () => {
  // dist is per-GAME, not per-target, so a game built for several platforms
  // accumulates all of them there. Handing an iOS export the .exe a Windows
  // build left behind would be worse than the empty list it used to return.
  const root = await tree("valkyrie", [
    { name: "valkyrie-app-debug.apk" },
    { name: "valkyrie.AppImage" },
    { name: "valkyrie.exe" },
  ]);
  try {
    assertEquals(await findArtifacts(root, "valkyrie", "ios"), []);
    const apk = await findArtifacts(root, "valkyrie", "android");
    assertEquals(apk.length, 1);
    assert(apk[0].endsWith(".apk"));
    const appimage = await findArtifacts(root, "valkyrie", "linux");
    assertEquals(appimage.length, 1);
    assert(appimage[0].endsWith(".AppImage"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("artifacts.json wins over the scan, and drops paths since deleted", async () => {
  const root = await tree("valkyrie", [
    { name: "valkyrie.ipa" },
    { name: "valkyrie.exe" },
  ]);
  const dist = join(root, "build", "valkyrie", "dist");
  await Deno.writeTextFile(
    join(root, "build", "valkyrie", "artifacts.json"),
    JSON.stringify({
      ios: [join(dist, "valkyrie.ipa")],
      windows: [join(dist, "valkyrie.msi")], // cleaned up since that build
    }),
  );
  try {
    const ios = await findArtifacts(root, "valkyrie", "ios");
    assertEquals(ios.length, 1);
    assert(ios[0].endsWith("valkyrie.ipa"));
    // The recorded .msi is gone, so the scan takes over rather than offering a
    // download that would 404.
    const win = await findArtifacts(root, "valkyrie", "windows");
    assertEquals(win.length, 1);
    assert(win[0].endsWith("valkyrie.exe"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a corrupt artifacts.json falls back to the scan rather than throwing", async () => {
  const root = await tree("valkyrie", [{ name: "valkyrie-app-debug.apk" }]);
  await Deno.writeTextFile(
    join(root, "build", "valkyrie", "artifacts.json"),
    "{ not json",
  );
  try {
    const found = await findArtifacts(root, "valkyrie", "android");
    assertEquals(found.length, 1);
    assert(found[0].endsWith(".apk"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an iOS build with no app falls back to the Xcode project", async () => {
  const root = await tree("valkyrie", []);
  const project = join(
    root,
    "build",
    "valkyrie",
    "cordova",
    "platforms",
    "ios",
  );
  await Deno.mkdir(project, { recursive: true });
  try {
    const found = await findArtifacts(root, "valkyrie", "ios");
    assertEquals(found.length, 1);
    assertEquals(found[0], project);
    assert(isIosProject(found[0]));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an iOS build that produced an .ipa hands back the .ipa", async () => {
  const root = await tree("valkyrie", [{ name: "valkyrie.ipa" }]);
  await Deno.mkdir(
    join(root, "build", "valkyrie", "cordova", "platforms", "ios"),
    { recursive: true },
  );
  try {
    const found = await findArtifacts(root, "valkyrie", "ios");
    assertEquals(found.length, 1);
    assert(found[0].endsWith("valkyrie.ipa"));
    assert(!isIosProject(found[0]));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a build that wrote nothing reports nothing", async () => {
  const root = await tree("valkyrie", []);
  try {
    assertEquals(await findArtifacts(root, "valkyrie", "android"), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the Xcode project is packaged into dist, out of cordova's reach", async () => {
  // buildCordova starts every run with rm -rf on build/<slug>/cordova, so the
  // project directory is not somewhere an artifact can be left: the next
  // android export of the same game would delete the file the editor had just
  // offered. dist/ is never cleaned between runs, so the zip goes there.
  const root = await tree("valkyrie", []);
  const buildRoot = join(root, "build", "valkyrie");
  const project = join(buildRoot, "cordova", "platforms", "ios");
  await Deno.mkdir(join(project, "Valkyrie__.xcodeproj"), { recursive: true });
  await Deno.mkdir(join(project, "Valkyrie__.xcworkspace"), {
    recursive: true,
  });
  await Deno.writeTextFile(join(project, "Podfile"), "platform :ios, '14.0'\n");
  await Deno.writeTextFile(
    join(project, "Valkyrie__.xcodeproj", "project.pbxproj"),
    "// pbxproj\n",
  );
  try {
    const out = await packageIosProject(
      buildRoot,
      "valkyrie",
      [project],
      () => {},
    );
    assertEquals(out.artifacts.length, 1);
    const zip = out.artifacts[0];
    assertEquals(zip, join(buildRoot, "dist", `valkyrie${IOS_PROJECT_SUFFIX}`));
    assert(out.note && out.note.includes("Xcode project"));

    // The project survives a cordova wipe because the artifact is no longer in it.
    await Deno.remove(join(buildRoot, "cordova"), { recursive: true });
    assert((await Deno.stat(zip)).isFile);

    const files = await unzip(await Deno.readFile(zip));
    const names = files.map((f) => f.path).sort();
    const where = names.join(", ");
    // One named folder, so unpacking does not spray the project over cwd.
    assert(names.every((n) => n.startsWith("valkyrie-ios/")), where);
    assert(names.includes("valkyrie-ios/Podfile"), where);
    assert(
      names.includes("valkyrie-ios/Valkyrie__.xcodeproj/project.pbxproj"),
      where,
    );
    // The one thing that still speaks to whoever opens this on a Mac later.
    const how = files.find((f) => f.path.endsWith("HOW-TO-BUILD.txt"));
    assert(how, where);
    assertStringIncludes(
      new TextDecoder().decode(how.data),
      "Valkyrie__.xcworkspace",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("packaging leaves a real app alone, but says it is unsigned", async () => {
  const root = await tree("valkyrie", [{ name: "valkyrie.ipa" }]);
  const buildRoot = join(root, "build", "valkyrie");
  const ipa = join(buildRoot, "dist", "valkyrie.ipa");
  try {
    const out = await packageIosProject(buildRoot, "valkyrie", [ipa], () => {});
    assertEquals(out.artifacts, [ipa]);
    // buildIosIpa switches signing off, so the file will not install as it
    // stands — a green "done" with no word about that is the same class of lie
    // this whole change exists to remove.
    assertStringIncludes(out.note ?? "", "Unsigned");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a non-iOS build gets no note", async () => {
  const root = await tree("valkyrie", [{ name: "valkyrie.msi" }]);
  const buildRoot = join(root, "build", "valkyrie");
  const msi = join(buildRoot, "dist", "valkyrie.msi");
  try {
    const out = await packageIosProject(buildRoot, "valkyrie", [msi], () => {});
    assertEquals(out.artifacts, [msi]);
    assertEquals(out.note, undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("isIosProject only matches the staged project path", () => {
  assert(isIosProject("/b/valkyrie/cordova/platforms/ios"));
  assert(isIosProject("C:\\b\\valkyrie\\cordova\\platforms\\ios"));
  assert(!isIosProject("/b/valkyrie/dist/valkyrie.ipa"));
  assert(!isIosProject("/b/valkyrie/cordova/platforms/android"));
});
