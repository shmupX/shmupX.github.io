// lib/android-host.ts — the launcher's Mobile shelf. Everything that decides
// something is pure and is held to a truth table here: the parsers for adb,
// Tailscale and Waydroid, the remote-desktop verdict, the package id a build
// found on disk is addressed by, the merge of the registry with what the
// build trees hold, and the target A picks when nobody chose one. The host
// probes and the moves spawn waydroid / adb / tailscale and are not run
// here; the registry round-trips through a temp directory.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type AndroidBuild,
  type AndroidRuntimes,
  buildFromTree,
  defaultTarget,
  discoverBuilds,
  mergeBuilds,
  packageIdForSlug,
  parseAdbDevices,
  parseCordovaConfig,
  parseTailscalePeers,
  parseTarget,
  parseWaydroidStatus,
  readShelfFile,
  remoteDesktopSignals,
  targetLabel,
  writeShelfFile,
} from "../lib/android-host.ts";

Deno.test("adb devices -l: serials, states and models, nothing else", () => {
  const text = [
    "* daemon not running; starting now at tcp:5037",
    "* daemon started successfully",
    "List of devices attached",
    "4B091FDAS00123         device usb:1-2 product:tokay model:Pixel_9 device:tokay transport_id:1",
    "100.112.217.49:33223   device product:tokay model:Pixel_9 device:tokay transport_id:2",
    "100.112.217.49:39639   offline transport_id:3",
    "emulator-5554          unauthorized transport_id:4",
    "0123456789ABCDEF       no permissions (missing udev rules?) transport_id:5",
    "",
  ].join("\n");
  const devs = parseAdbDevices(text);
  assertEquals(devs.map((d) => d.serial), [
    "4B091FDAS00123",
    "100.112.217.49:33223",
    "100.112.217.49:39639",
    "emulator-5554",
    "0123456789ABCDEF",
  ]);
  assertEquals(devs[0], {
    serial: "4B091FDAS00123",
    state: "device",
    model: "Pixel 9",
    transport: "usb",
  });
  assertEquals(devs[1].transport, "tcp");
  assertEquals(devs[2].state, "offline");
  assertEquals(devs[3].state, "unauthorized");
  assertEquals(devs[4].state, "no permissions (missing udev rules?)");
  assertEquals(parseAdbDevices(""), []);
  assertEquals(parseAdbDevices("List of devices attached\n\n"), []);
});

Deno.test("tailscale status --json: peers by Taildrop name, online first", () => {
  const json = JSON.stringify({
    Self: { HostName: "bazzite", OS: "linux" },
    Peer: {
      a: {
        HostName: "BOOK-1",
        DNSName: "book-1.tailc3f70f.ts.net.",
        OS: "windows",
        Online: false,
        TailscaleIPs: ["100.125.66.102", "fd7a::1"],
      },
      b: {
        HostName: "Pixel 9",
        DNSName: "pixel-9.tailc3f70f.ts.net.",
        OS: "android",
        Online: true,
        TailscaleIPs: ["fd7a::2", "100.112.217.49"],
      },
      c: { HostName: "nameless", OS: "iOS", Online: true },
    },
  });
  const { self, peers } = parseTailscalePeers(json);
  assertEquals(self, "bazzite");
  assertEquals(peers.map((p) => p.id), ["nameless", "pixel-9", "book-1"]);
  const pixel = peers.find((p) => p.id === "pixel-9")!;
  // The IPv4 is the one a human would type; the name is the phone's own.
  assertEquals(pixel.ip, "100.112.217.49");
  assertEquals(pixel.name, "Pixel 9");
  assertEquals(pixel.os, "android");
  assert(pixel.online);
  assertEquals(pixel.dns, "pixel-9.tailc3f70f.ts.net");
  // No MagicDNS name: the host name, slugged, still addresses it.
  assertEquals(peers[0].id, "nameless");
  assertEquals(parseTailscalePeers("not json"), { self: "", peers: [] });
});

Deno.test("waydroid status: initialised, and whether a session is up", () => {
  assertEquals(
    parseWaydroidStatus("Session:\tSTOPPED\nVendor type:\tMAINLINE"),
    {
      initialized: true,
      sessionRunning: false,
    },
  );
  assertEquals(parseWaydroidStatus("Session:\tRUNNING\nContainer:\tRUNNING"), {
    initialized: true,
    sessionRunning: true,
  });
  assertEquals(
    parseWaydroidStatus(
      'ERROR: WayDroid is not initialized, run "waydroid init"',
    ),
    {
      initialized: false,
      sessionRunning: false,
    },
  );
});

Deno.test("remote desktop: the session's environment, or a running host", () => {
  const none = remoteDesktopSignals({}, ["bash", "deno", "chrome"]);
  assertEquals(none, { detected: false, via: [] });
  assertEquals(remoteDesktopSignals({ SESSIONNAME: "RDP-Tcp#3" }, []).via, [
    "rdp",
  ]);
  assertEquals(
    remoteDesktopSignals({ SESSIONNAME: "Console" }, []).detected,
    false,
  );
  assertEquals(remoteDesktopSignals({ XRDP_SESSION: "1" }, []).via, ["xrdp"]);
  assertEquals(remoteDesktopSignals({ VNCDESKTOP: "x" }, []).via, ["vnc"]);
  assertEquals(remoteDesktopSignals({ SSH_CONNECTION: "1 2 3 4" }, []).via, [
    "ssh",
  ]);
  // Daemons count by name, case-insensitively and with a Windows .exe.
  assertEquals(
    remoteDesktopSignals({}, ["systemd", "sunshine", "Xorg"]).via,
    ["sunshine"],
  );
  assertEquals(remoteDesktopSignals({}, ["RustDesk.exe"]).via, ["rustdesk"]);
  assertEquals(remoteDesktopSignals({}, ["/usr/bin/wayvnc"]).via, ["vnc"]);
  assertEquals(
    remoteDesktopSignals({}, ["gnome-remote-desktop-daemon"]).via,
    ["gnome-remote-desktop"],
  );
  // Several at once list once each, environment first.
  const both = remoteDesktopSignals({ XRDP_SESSION: "1" }, [
    "xrdp",
    "xrdp-sesman",
  ]);
  assertEquals(both.via, ["xrdp"]);
  assert(both.detected);
});

Deno.test("package ids mirror tools/build-level's safePackageSegment", () => {
  assertEquals(packageIdForSlug("rando"), "com.easierbycode.rando");
  assertEquals(packageIdForSlug("2019"), "com.easierbycode.a2019");
  assertEquals(packageIdForSlug("2019ps2"), "com.easierbycode.a2019ps2");
  assertEquals(
    packageIdForSlug("level-3f2a1c04"),
    "com.easierbycode.level3f2a1c04",
  );
  assertEquals(packageIdForSlug("class"), "com.easierbycode.class_");
  assertEquals(packageIdForSlug(""), "com.easierbycode.app");
  assertEquals(packageIdForSlug("2028-ai"), "com.easierbycode.a2028ai");
});

Deno.test("cordova config.xml: the widget id and the app's name", () => {
  const xml = `<?xml version='1.0' encoding='utf-8'?>
<widget id="com.easierbycode.rando" version="1.0.0" xmlns="http://www.w3.org/ns/widgets">
    <name>rando</name>
    <description>A shmup</description>
</widget>`;
  assertEquals(parseCordovaConfig(xml), {
    packageId: "com.easierbycode.rando",
    name: "rando",
  });
  assertEquals(parseCordovaConfig("<widget>"), { packageId: null, name: null });
});

Deno.test("targets: what the launcher may send, and what they are called", () => {
  assertEquals(parseTarget("waydroid"), "waydroid");
  assertEquals(parseTarget("wsa"), "wsa");
  assertEquals(
    parseTarget("adb:100.112.217.49:33223"),
    "adb:100.112.217.49:33223",
  );
  assertEquals(parseTarget("taildrop:pixel-9"), "taildrop:pixel-9");
  assertEquals(parseTarget("taildrop:pixel 9"), null);
  assertEquals(parseTarget("adb:"), null);
  assertEquals(parseTarget("steam"), null);
  assertEquals(parseTarget(42), null);
  const runtimes = fakeRuntimes();
  assertEquals(targetLabel("waydroid"), "Waydroid");
  assertEquals(targetLabel("wsa"), "Windows Subsystem for Android");
  assertEquals(targetLabel("adb:4B091FDAS00123", runtimes), "Pixel 9 (adb)");
  assertEquals(targetLabel("adb:unknown", runtimes), "unknown (adb)");
  assertEquals(
    targetLabel("taildrop:pixel-9", runtimes),
    "Pixel 9 (Tailscale)",
  );
  assertEquals(targetLabel("taildrop:pixel-9"), "pixel-9 (Tailscale)");
});

function fakeRuntimes(over: Partial<AndroidRuntimes> = {}): AndroidRuntimes {
  return {
    waydroid: {
      found: true,
      initialized: true,
      containerActive: true,
      sessionRunning: false,
      gameMode: false,
      status: "Session:\tSTOPPED",
    },
    wsa: { found: false, path: null, running: false },
    adb: {
      found: true,
      path: "/sdk/platform-tools/adb",
      devices: [
        {
          serial: "4B091FDAS00123",
          state: "device",
          model: "Pixel 9",
          transport: "usb",
        },
        {
          serial: "emulator-5554",
          state: "offline",
          model: "",
          transport: "usb",
        },
      ],
    },
    tailscale: {
      found: true,
      self: "bazzite",
      peers: [
        {
          name: "Pixel 9",
          id: "pixel-9",
          dns: "pixel-9.ts.net",
          ip: "100.1.1.1",
          os: "android",
          online: true,
        },
        {
          name: "Surface",
          id: "surface",
          dns: "surface.ts.net",
          ip: "100.1.1.2",
          os: "windows",
          online: true,
        },
        {
          name: "Old phone",
          id: "old-phone",
          dns: "old-phone.ts.net",
          ip: "100.1.1.3",
          os: "android",
          online: false,
        },
      ],
    },
    ...over,
  };
}

Deno.test("the default target: here first, unless this is a remote desktop", () => {
  const r = fakeRuntimes();
  const here = { detected: false, via: [] };
  const away = { detected: true, via: ["sunshine"] };
  assertEquals(defaultTarget(r, here), "waydroid");
  // A remote desktop puts the device in hand first: the adb device that is
  // actually ready, before any Taildrop peer, before this screen.
  assertEquals(defaultTarget(r, away), "adb:4B091FDAS00123");
  const noAdb = fakeRuntimes({
    adb: { found: true, path: "adb", devices: [] },
  });
  assertEquals(defaultTarget(noAdb, away), "taildrop:pixel-9");
  // Only online Android peers count; a Windows laptop is not where an APK goes.
  const noPhone = fakeRuntimes({
    adb: { found: false, path: null, devices: [] },
    tailscale: {
      found: true,
      self: "",
      peers: [r.tailscale.peers[1], r.tailscale.peers[2]],
    },
  });
  assertEquals(defaultTarget(noPhone, away), "waydroid");
  // Nothing anywhere: null, and the launcher opens the chooser instead.
  const bare = fakeRuntimes({
    waydroid: { ...r.waydroid, found: false, initialized: false },
    adb: { found: false, path: null, devices: [] },
    tailscale: { found: false, self: "", peers: [] },
  });
  assertEquals(defaultTarget(bare, here), null);
  // An uninitialised Waydroid is not a place to run anything yet.
  const uninit = fakeRuntimes({
    waydroid: { ...r.waydroid, initialized: false },
  });
  assertEquals(defaultTarget(uninit, here), "adb:4B091FDAS00123");
  // WSA on Windows is "here" the way Waydroid is on Linux.
  const win = fakeRuntimes({
    waydroid: { ...r.waydroid, found: false, initialized: false },
    wsa: { found: true, path: "C:\\WsaClient.exe", running: false },
  });
  assertEquals(defaultTarget(win, here), "wsa");
});

function build(over: Partial<AndroidBuild>): AndroidBuild {
  return {
    id: "rando",
    name: "rando",
    slug: "rando",
    apk: "/b/rando/dist/rando-app-debug.apk",
    packageId: "com.easierbycode.rando",
    size: 1,
    builtAt: 1000,
    source: "level:rando",
    icon: null,
    installed: {},
    ...over,
  };
}

Deno.test("merging the registry with the build trees", () => {
  const registered = [
    build({ installed: { waydroid: 5 }, builtAt: 1000 }),
    build({ id: "old", slug: "old", apk: "/b/old/dist/old.apk", builtAt: 10 }),
  ];
  const discovered = [
    // The same APK, seen on disk: the registry's row (its install history) wins.
    build({ installed: {}, source: "found on disk", builtAt: 1000 }),
    build({
      id: "2019",
      slug: "2019",
      apk: "/b/2019/dist/2019.apk",
      builtAt: 500,
    }),
  ];
  const merged = mergeBuilds(registered, discovered);
  assertEquals(merged.map((b) => b.id), ["rando", "2019", "old"]);
  assertEquals(merged[0].installed, { waydroid: 5 });
  assertEquals(merged[0].source, "level:rando");
  // Forgotten stays forgotten — until a rebuild newer than the forgetting
  // lands on the same path.
  const forgot = mergeBuilds(registered, discovered, [{
    apk: "/b/2019/dist/2019.apk",
    at: 600,
  }]);
  assertEquals(forgot.map((b) => b.id), ["rando", "old"]);
  const rebuilt = mergeBuilds(
    registered,
    [discovered[0], { ...discovered[1], builtAt: 700 }],
    [{ apk: "/b/2019/dist/2019.apk", at: 600 }],
  );
  assertEquals(rebuilt.map((b) => b.id), ["rando", "2019", "old"]);
  // Two APKs claiming one id: the newer is the shelf's.
  const twice = mergeBuilds([], [
    build({ apk: "/a/rando.apk", builtAt: 1 }),
    build({ apk: "/b/rando.apk", builtAt: 2 }),
  ]);
  assertEquals(twice.length, 1);
  assertEquals(twice[0].apk, "/b/rando.apk");
});

Deno.test("a build tree on disk becomes a shelf row; the registry round-trips", async () => {
  const dir = await Deno.makeTempDir({ prefix: "android-shelf-" });
  try {
    const tree = join(dir, "build", "rando");
    await Deno.mkdir(join(tree, "dist"), { recursive: true });
    await Deno.mkdir(join(tree, "cordova", "icons"), { recursive: true });
    const apk = join(tree, "dist", "rando-app-debug.apk");
    await Deno.writeFile(apk, new Uint8Array(16));
    await Deno.writeTextFile(
      join(tree, "artifacts.json"),
      JSON.stringify({ android: [apk] }),
    );
    await Deno.writeTextFile(
      join(tree, "cordova", "config.xml"),
      `<widget id="com.easierbycode.rando"><name>Rando!</name></widget>`,
    );
    await Deno.writeFile(
      join(tree, "cordova", "icons", "icon-192.png"),
      new Uint8Array(4),
    );
    const found = await buildFromTree(tree);
    assert(found);
    assertEquals(found.id, "rando");
    assertEquals(found.name, "Rando!");
    assertEquals(found.packageId, "com.easierbycode.rando");
    assertEquals(found.apk, apk);
    assertEquals(found.size, 16);
    assertEquals(found.icon, join(tree, "cordova", "icons", "icon-192.png"));
    assertEquals(found.source, "found on disk");

    // No artifacts.json and no config.xml: the newest APK in dist/ and the
    // slug's own package id.
    const bare = join(dir, "build", "2019");
    await Deno.mkdir(join(bare, "dist"), { recursive: true });
    await Deno.writeFile(
      join(bare, "dist", "2019-app-debug.apk"),
      new Uint8Array(8),
    );
    const old = await buildFromTree(bare);
    assert(old);
    assertEquals(old.packageId, "com.easierbycode.a2019");
    assertEquals(old.name, "2019");
    assertEquals(old.icon, null);

    // A tree with nothing in it is not a build; neither is a root that is
    // not there.
    await Deno.mkdir(join(dir, "build", "empty"));
    assertEquals(await buildFromTree(join(dir, "build", "empty")), null);
    const all = await discoverBuilds([join(dir, "build"), join(dir, "nope")]);
    assertEquals(all.map((b) => b.id).sort(), ["2019", "rando"]);

    // The registry file: written, read back, tolerant of an older shape.
    const path = join(dir, "android-shelf.json");
    assertEquals(await readShelfFile(path), {
      version: 1,
      builds: [],
      forgotten: [],
    });
    await writeShelfFile({
      version: 1,
      builds: [found],
      forgotten: [{ apk: "/x.apk", at: 3 }],
    }, path);
    const back = await readShelfFile(path);
    assertEquals(back.builds.length, 1);
    assertEquals(back.builds[0].name, "Rando!");
    assertEquals(back.forgotten, [{ apk: "/x.apk", at: 3 }]);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        builds: [found, { bogus: true }],
        forgotten: ["/old.apk", 5],
      }),
    );
    const lenient = await readShelfFile(path);
    assertEquals(lenient.builds.length, 1);
    assertEquals(lenient.forgotten, []);
    await Deno.writeTextFile(path, "not json");
    assertEquals((await readShelfFile(path)).builds, []);
    assertStringIncludes(
      JSON.stringify(await readShelfFile(path)),
      '"version":1',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
