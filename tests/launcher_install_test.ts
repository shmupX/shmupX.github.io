// Whether pressing ADD TO STEAM also installs a copy, and where it lands.
//
// The stake is the updater: an AppImage cannot patch itself, so the only way a
// Linux launcher ever updates is from the tree lib/launcher-install.ts copies
// out of the mount (lib/self-update.ts refuses to arm on the AppImage itself).
// A plan that says `can` on the wrong build copies ~1GB for nothing; one that
// says it on the right build and picks the wrong directory installs a launcher
// the shortcut does not point at.
//
// `installPlan` is pure, so none of this needs a machine running an AppImage.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  type InstallContext,
  installDir,
  installedExe,
  installLauncher,
  installPlan,
} from "../lib/launcher-install.ts";
import { launcherBinary } from "../lib/launcher-binary.ts";

const HOME = "/home/deck";
const MOUNT = "/tmp/.mount_shmupXAbC123";
const APPIMAGE = `${HOME}/Downloads/shmupX-linux-x86_64.AppImage`;
const DIR = `${HOME}/.local/share/shmupX/app`;

const onAppImage = {
  os: "linux" as const,
  env: { HOME, APPIMAGE, APPDIR: MOUNT },
  binary: { path: APPIMAGE, kind: "appimage" as const },
};

Deno.test("an installed copy lives under the launcher's own data directory", () => {
  // The same directory the spawned browser's profiles are in, because that is
  // already the one a player deletes to start over.
  assertEquals(
    installDir("linux", { HOME }),
    `${HOME}/.local/share/shmupX/app`,
  );
  assertEquals(
    installDir("linux", { HOME, XDG_DATA_HOME: "/mnt/sd/share" }),
    "/mnt/sd/share/shmupX/app",
  );
  assertEquals(installedExe(DIR), `${DIR}/AppRun`);
});

Deno.test("a running AppImage installs the tree it is mounted from", () => {
  const plan = installPlan(onAppImage);
  assert(plan.can);
  // $APPDIR, not a path rebuilt from execPath: the layout inside the mount is
  // the application's business, and reconstructing it would be a guess.
  assertEquals(plan.source, MOUNT);
  assertEquals(plan.dir, DIR);
  assertEquals(plan.exe, `${DIR}/AppRun`);
  assertEquals(plan.reason, null);
});

Deno.test("an AppImage with no $APPDIR is refused rather than guessed at", () => {
  const plan = installPlan({ ...onAppImage, env: { HOME, APPIMAGE } });
  assert(!plan.can);
  assertStringIncludes(plan.reason ?? "", "where it is mounted");
});

Deno.test("nothing is installed twice", () => {
  const plan = installPlan({
    ...onAppImage,
    binary: { path: `${DIR}/AppRun`, kind: "installed" },
  });
  assert(!plan.can);
  assertStringIncludes(plan.reason ?? "", "already installed");
});

Deno.test("only the Linux AppImage is installed — the others run in place", () => {
  // A macOS bundle is code-signed and could not be patched wherever it lived,
  // and the Windows .exe has no updater at all: copying either moves ~500MB
  // for no gain.
  const others: InstallContext[] = [
    {
      os: "darwin",
      env: { HOME },
      binary: { path: "/Applications/shmupX.app", kind: "macos-app" },
    },
    {
      os: "windows",
      env: { USERPROFILE: "C:\\Users\\deck" },
      binary: { path: "C:\\Games\\shmupX.exe", kind: "executable" },
    },
  ];
  for (const ctx of others) {
    const plan = installPlan(ctx);
    assert(!plan.can, ctx.os);
    assertStringIncludes(plan.reason ?? "", "runs in place");
  }
});

Deno.test("a source checkout has no launcher to install", () => {
  const plan = installPlan({ os: "linux", env: { HOME }, binary: null });
  assert(!plan.can);
  assertStringIncludes(plan.reason ?? "", "source checkout");
});

Deno.test("an installed launcher knows it is one, and is entered through AppRun", () => {
  // This is what arms the updater (lib/self-update.ts): "installed" is the one
  // Linux shape `Deno.autoUpdate` can write next to. Nothing in execPath says
  // so, which is why the install directory is passed in.
  assertEquals(
    launcherBinary({
      execPath: `${DIR}/usr/bin/shmupX`,
      env: { HOME },
      standalone: true,
      os: "linux",
      installDir: DIR,
    }),
    { path: `${DIR}/AppRun`, kind: "installed" },
  );
  // Still an AppImage while it is running as one, whatever else is on disk.
  assertEquals(
    launcherBinary({
      execPath: `${MOUNT}/usr/bin/shmupX`,
      env: { HOME, APPIMAGE },
      standalone: true,
      os: "linux",
      installDir: DIR,
    }),
    { path: APPIMAGE, kind: "appimage" },
  );
  // A build somewhere else is an ordinary executable, not an install.
  assertEquals(
    launcherBinary({
      execPath: `${HOME}/build/desktop/shmupX`,
      env: { HOME },
      standalone: true,
      os: "linux",
      installDir: DIR,
    })?.kind,
    "executable",
  );
  // A directory that merely starts with the same characters is not inside it.
  assertEquals(
    launcherBinary({
      execPath: `${DIR}-old/usr/bin/shmupX`,
      env: { HOME },
      standalone: true,
      os: "linux",
      installDir: DIR,
    })?.kind,
    "executable",
  );
});

// The copy itself, against a real directory: the swap is the part that can
// leave a player with a shortcut pointing at half a launcher.

async function fakeMount(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "shmupx-mount-" });
  for (const [name, body] of Object.entries(files)) {
    const path = `${dir}/${name}`;
    await Deno.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  return dir;
}

Deno.test("installing copies the mounted tree and leaves AppRun to run", async () => {
  const home = await Deno.makeTempDir({ prefix: "shmupx-home-" });
  const mount = await fakeMount({
    "AppRun": "#!/bin/sh\nexec usr/bin/shmupX\n",
    "usr/bin/shmupX": "ELF",
    "usr/lib/libdeno_desktop.so": "dylib",
  });
  try {
    const plan = installPlan({
      os: "linux",
      env: { HOME: home, APPIMAGE: "/dl/shmupX.AppImage", APPDIR: mount },
      binary: { path: "/dl/shmupX.AppImage", kind: "appimage" },
    });
    const outcome = await installLauncher(plan);
    assert(outcome.ok, outcome.error ?? "");
    assertEquals(outcome.exe, `${home}/.local/share/shmupX/app/AppRun`);
    assertEquals(
      await Deno.readTextFile(`${outcome.dir}/usr/lib/libdeno_desktop.so`),
      "dylib",
    );
    assert(outcome.bytes > 0);
    // The staging tree does not survive a successful install.
    await assertRejects(() => Deno.stat(`${outcome.dir}.new`));

    // Installing again over the top replaces it rather than merging into it:
    // a file the new build dropped must not come back from the old one.
    await Deno.writeTextFile(`${outcome.dir}/usr/lib/stale.so`, "old");
    assert((await installLauncher(plan)).ok);
    await assertRejects(() => Deno.stat(`${outcome.dir}/usr/lib/stale.so`));
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(mount, { recursive: true });
  }
});

Deno.test("a tree with no AppRun is thrown away, not installed", async () => {
  // The silent failure this exists for: a half-copied tree is still a
  // directory, the shortcut still points at it, and the player presses play on
  // a launcher that no longer starts.
  const home = await Deno.makeTempDir({ prefix: "shmupx-home-" });
  const mount = await fakeMount({ "usr/bin/shmupX": "ELF" });
  try {
    const plan = installPlan({
      os: "linux",
      env: { HOME: home, APPIMAGE: "/dl/shmupX.AppImage", APPDIR: mount },
      binary: { path: "/dl/shmupX.AppImage", kind: "appimage" },
    });
    const outcome = await installLauncher(plan);
    assert(!outcome.ok);
    assertStringIncludes(outcome.error ?? "", "AppRun");
    await assertRejects(() => Deno.stat(outcome.dir));
    await assertRejects(() => Deno.stat(`${outcome.dir}.new`));
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(mount, { recursive: true });
  }
});

Deno.test("an install that cannot happen reports, rather than throwing", async () => {
  const outcome = await installLauncher(
    installPlan({ os: "linux", env: { HOME: "/home/deck" }, binary: null }),
  );
  assert(!outcome.ok);
  assertStringIncludes(outcome.error ?? "", "source checkout");
});
