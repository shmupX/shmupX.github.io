// Which file "Add to Steam" writes into the library, and when there isn't one.
//
// The shortcut Steam stores is a path and nothing ever checks it again, so
// getting this wrong is silent: the entry appears, the player presses play, and
// nothing happens. The AppImage case is the one that bites — its own binary
// runs from a temp mount that stops existing the moment the app quits — and it
// cannot be reproduced on the machine running these tests, so the environment
// is the fixture.

import { assertEquals } from "@std/assert";
import { launcherBinary } from "../lib/launcher-binary.ts";

Deno.test("an AppImage is the file the player double-clicked, not the mount", () => {
  assertEquals(
    launcherBinary({
      // What execPath reports from inside a running AppImage: a path under the
      // squashfs mount, gone the moment the process exits.
      execPath: "/tmp/.mount_shmupXAbC123/usr/bin/shmupX",
      env: { APPIMAGE: "/home/deck/Applications/shmupX-linux-x86-64.AppImage" },
      standalone: true,
      os: "linux",
    }),
    {
      path: "/home/deck/Applications/shmupX-linux-x86-64.AppImage",
      kind: "appimage",
    },
  );
});

Deno.test("a macOS build is the bundle, not the binary buried in it", () => {
  assertEquals(
    launcherBinary({
      execPath: "/Applications/shmupX.app/Contents/MacOS/shmupX",
      env: {},
      standalone: true,
      os: "darwin",
    }),
    { path: "/Applications/shmupX.app", kind: "macos-app" },
  );
  // A bare Mach-O that is not inside a bundle is itself.
  assertEquals(
    launcherBinary({
      execPath: "/usr/local/bin/shmupX",
      env: {},
      standalone: true,
      os: "darwin",
    }),
    { path: "/usr/local/bin/shmupX", kind: "executable" },
  );
});

Deno.test("a Windows build is the .exe it says it is", () => {
  assertEquals(
    launcherBinary({
      execPath: "C:\\Games\\shmupX-windows-x86_64.exe",
      env: {},
      standalone: true,
      os: "windows",
    }),
    { path: "C:\\Games\\shmupX-windows-x86_64.exe", kind: "executable" },
  );
});

Deno.test("a source checkout has nothing to add — `deno` is not a game", () => {
  assertEquals(
    launcherBinary({
      execPath: "/Users/me/.deno/bin/deno",
      env: {},
      standalone: false,
      os: "darwin",
    }),
    null,
  );
  // Not even when $APPIMAGE is absent and execPath looks plausible.
  assertEquals(
    launcherBinary({
      execPath: "/usr/bin/deno",
      env: {},
      standalone: false,
      os: "linux",
    }),
    null,
  );
});

Deno.test("$APPIMAGE wins even over a standalone execPath, and blank does not count", () => {
  assertEquals(
    launcherBinary({
      execPath: "/tmp/.mount_x/usr/bin/shmupX",
      env: { APPIMAGE: "  /games/shmupX.AppImage  " },
      standalone: true,
      os: "linux",
    })?.path,
    "/games/shmupX.AppImage",
  );
  // An empty APPIMAGE is not an AppImage — some shells export it blank.
  assertEquals(
    launcherBinary({
      execPath: "/games/shmupX",
      env: { APPIMAGE: "   " },
      standalone: true,
      os: "linux",
    }),
    { path: "/games/shmupX", kind: "executable" },
  );
});
