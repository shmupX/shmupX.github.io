// The web build of AthenaEnv: the parts of lib/ps2/web-*.ts that are not
// Phaser, and then the whole of it minus Phaser.
//
// The browser page runs a build's main.js unmodified, so main.js reaches for a
// console's globals and the page rebuilds them over svelte-ps2's browser
// runtime (web-native.ts). The last test does exactly what the page does —
// createRuntime over a host, AthenaEnv's globals over that, main.js handing
// its frame to `__PS2_HOST_LOOP__` — with a recording host in Phaser's place,
// and plays the title's secrets through the pad source the bot drives.

import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  Color,
  createRuntime,
  PAD_BUTTONS,
  type PS2Host,
} from "@easierbycode/svelte-ps2";
import { gamepadMask, keyMask, WebPadSource } from "../lib/ps2/web-pads.ts";
import {
  athenaPath,
  type BuildFiles,
  createFrameTimer,
  createNativeGlobals,
  installNativeGlobals,
  toShimColor,
} from "../lib/ps2/web-native.ts";
import {
  bootScript,
  isTextPath,
  parseAthenaIni,
  sfxPreloadPaths,
  webManifest,
} from "../lib/ps2/web-files.ts";
import {
  audsrvGain,
  audsrvPan,
  createWebSound,
  soundKey,
} from "../lib/ps2/web-sound.ts";
import { webIndexHtml, writeWebBuild } from "../lib/ps2/web-build.ts";
import { stageAssets } from "../lib/ps2/assets.ts";
import { buildRuntimeBundle } from "../lib/ps2/build.ts";
import { repoRoot } from "../lib/repo-root.ts";

const ROOT = repoRoot();
const B = PAD_BUTTONS;

// ---------------------------------------------------------------- pads ----

/** An EventTarget that records preventDefault, for the pad source. */
function keyTarget() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const target = {
    addEventListener: (type: string, fn: (event: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (event: Event) => void) =>
      listeners.get(type)?.delete(fn),
  } as unknown as Pick<EventTarget, "addEventListener" | "removeEventListener">;
  const send = (type: string, code = "") => {
    let prevented = false;
    const event = {
      type,
      code,
      preventDefault: () => (prevented = true),
    } as unknown as Event;
    for (const fn of listeners.get(type) ?? []) fn(event);
    return prevented;
  };
  return { target, send, count: () => listeners.get("keydown")?.size ?? 0 };
}

Deno.test("the keyboard maps the way the page says it does", () => {
  assertEquals(keyMask(["ArrowUp"]), B.UP);
  assertEquals(keyMask(["ArrowLeft", "ArrowRight"]), B.LEFT | B.RIGHT);
  assertEquals(keyMask(["KeyZ"]), B.CROSS);
  assertEquals(keyMask(["Space"]), B.CROSS);
  assertEquals(keyMask(["Enter"]), B.START);
  assertEquals(keyMask(["ShiftLeft"]), B.SELECT);
  assertEquals(keyMask(["ShiftRight"]), B.SELECT);
  assertEquals(keyMask(["KeyQ", "KeyE"]), B.L1 | B.R1);
  assertEquals(keyMask(["KeyM", "Tab"]), 0, "unmapped keys hold nothing");
});

Deno.test("a standard-mapping gamepad maps onto the DualShock", () => {
  const buttons = (...down: number[]) =>
    Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i) }));
  assertEquals(gamepadMask(buttons(0)), B.CROSS);
  assertEquals(gamepadMask(buttons(4, 5, 9)), B.L1 | B.R1 | B.START);
  assertEquals(gamepadMask(buttons(8)), B.SELECT);
  assertEquals(gamepadMask(buttons(12, 15)), B.UP | B.RIGHT);
  assertEquals(gamepadMask(buttons(16)), 0, "the home button is nothing");
});

Deno.test("the pad source ORs keys, gamepads and the bot, one snapshot a frame", () => {
  const keys = keyTarget();
  const pad = {
    connected: true,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false })),
    axes: [0.5, -1, 0, 0],
  };
  const source = new WebPadSource({
    target: keys.target,
    gamepads: () => [pad],
  });

  // Nothing is seen until the frame's snapshot is taken.
  assert(keys.send("keydown", "Enter"), "a mapped key keeps its default");
  assertEquals(keys.send("keydown", "KeyM"), false, "others are left alone");
  assertEquals(source.held(B.START), false);
  source.refresh();
  assert(source.held(B.START));
  assert(source.fresh(B.START), "the press is an edge on its first frame");
  source.refresh();
  assert(source.held(B.START));
  assertEquals(source.fresh(B.START), false, "and only on its first frame");

  // The bot's mask and a gamepad's buttons join the keyboard's.
  source.scripted.set(B.L1 | B.R1);
  pad.buttons[8].pressed = true;
  source.refresh();
  assertEquals(source.mask, B.START | B.L1 | B.R1 | B.SELECT);
  assertEquals(source.scripted.held(), source.mask);
  assertEquals(source.scripted.get(), B.L1 | B.R1);
  assertEquals(source.axis("lx"), 0.5);
  assertEquals(source.axis("ly"), -1);

  // Letting go: keyup, blur (a key released in another tab), clear().
  keys.send("keyup", "Enter");
  pad.buttons[8].pressed = false;
  source.scripted.clear();
  source.refresh();
  assertEquals(source.mask, 0);
  keys.send("keydown", "KeyQ");
  keys.send("blur");
  source.refresh();
  assertEquals(source.mask, 0, "blur drops every held key");

  source.destroy();
  assertEquals(keys.count(), 0, "destroy() removes its listeners");
});

// -------------------------------------------------------------- native ----

/** svelte-ps2's native adapter's colour rescale (src/native, not exported). */
function toNativeColor(c: number): number {
  const r = c & 0xff;
  const g = (c >>> 8) & 0xff;
  const b = (c >>> 16) & 0xff;
  const a = (c >>> 24) & 0xff;
  return (((a & 0xff) << 24) | ((Math.round((b * 128) / 255) & 0xff) << 16) |
    ((Math.round((g * 128) / 255) & 0xff) << 8) |
    (Math.round((r * 128) / 255) & 0xff)) >>> 0;
}

Deno.test("toShimColor undoes the native adapter's rescale to within a level", () => {
  // 256 levels squeezed into the GS's 129 cannot all come back exactly; each
  // comes back within one, and alpha untouched.
  for (let v = 0; v <= 255; v++) {
    const shim = Color.new(v, 255 - v, v >> 1, 96);
    const back = toShimColor(toNativeColor(shim));
    for (const channel of [Color.getR, Color.getG, Color.getB]) {
      const off = Math.abs(channel(back) - channel(shim));
      assert(off <= 1, `level ${v} came back ${off} levels out`);
    }
    assertEquals(Color.getA(back), 96);
  }
  // Untinted and black survive exactly: they are most of what a game draws.
  const white = Color.new(255, 255, 255, 128);
  assertEquals(toShimColor(toNativeColor(white)), white);
  const black = Color.new(0, 0, 0, 128);
  assertEquals(toShimColor(toNativeColor(black)), black);
  // GS over-bright (above 128) has nowhere to go in a browser but white.
  assertEquals(Color.getR(toShimColor(Color.new(200, 0, 0, 128))), 255);
});

Deno.test("athenaPath finds the file whatever device a console names", () => {
  assertEquals(athenaPath("assets/game_ui.png"), "assets/game_ui.png");
  assertEquals(athenaPath("./assets/a.png"), "assets/a.png");
  assertEquals(athenaPath("cdfs:/assets/a.png"), "assets/a.png");
  assertEquals(athenaPath("mass:/Gs/main.js"), "Gs/main.js");
  assertEquals(athenaPath("cdrom0:\\ATHENA.INI;1"), "ATHENA.INI");
  assertEquals(athenaPath("assets\\sounds\\x.adp"), "assets/sounds/x.adp");
});

Deno.test("the frame timer counts microseconds of the clock it is given", () => {
  let now = 1000;
  const Timer = createFrameTimer(() => now);
  const t = Timer.new();
  now += 33.5;
  assertEquals(Timer.getTime(t), 33500);
  Timer.pause(t);
  now += 1000;
  assertEquals(Timer.getTime(t), 33500, "a paused timer stands still");
  Timer.resume(t);
  now += 1;
  assertEquals(Timer.getTime(t), 34500);
  Timer.setTime(t, 0);
  assertEquals(Timer.getTime(t), 0);
});

interface Recorded {
  rects: { x: number; y: number; w: number; h: number; a: number }[];
  images: {
    path: string;
    sx: number;
    sw: number;
    dw: number;
    dh: number;
    r: number;
    flipX: boolean;
  }[];
  texts: { text: string; r: number; g: number; b: number; scale: number }[];
}

/** A PS2Host that records instead of drawing, sizing images from `sizes`. */
function recordingHost(
  sizes: (path: string) => { width: number; height: number },
  pads: WebPadSource,
): { host: PS2Host; seen: Recorded; frame: () => Recorded } {
  let seen: Recorded = { rects: [], images: [], texts: [] };
  let last = seen;
  const host: PS2Host = {
    screen: { width: 640, height: 448 },
    beginFrame: () => (seen = { rects: [], images: [], texts: [] }),
    endFrame: () => (last = seen),
    drawRect: (x, y, w, h, c) => seen.rects.push({ x, y, w, h, a: c.a }),
    createImage: (path) => ({ path, ...sizes(path) }) as never,
    drawImage: (img, sx, _sy, sw, _sh, _dx, _dy, dw, dh, o) =>
      seen.images.push({
        path: (img as unknown as { path: string }).path,
        sx,
        sw,
        dw,
        dh,
        r: o.color?.r ?? 255,
        flipX: o.flipX,
      }),
    createFont: () => ({}),
    drawText: (_f, _x, _y, text, color, scale) =>
      seen.texts.push({
        text,
        r: color?.r ?? 255,
        g: color?.g ?? 255,
        b: color?.b ?? 255,
        scale: scale ?? 1,
      }),
    measureText: (_f, text, scale) => ({
      width: text.length * 7 * (scale ?? 1),
      height: 12 * (scale ?? 1),
    }),
    padHeld: (mask) => pads.held(mask),
    padFresh: (mask) => pads.fresh(mask),
    padAxis: () => 0,
    loadFile: () => null,
    writeFile: () => {},
  };
  return { host, seen, frame: () => last };
}

function noPads(): WebPadSource {
  return new WebPadSource({ target: keyTarget().target, gamepads: () => [] });
}

Deno.test("AthenaEnv's globals draw through the browser runtime", () => {
  const pads = noPads();
  const rec = recordingHost(() => ({ width: 64, height: 32 }), pads);
  const runtime = createRuntime(rec.host);
  const saved = new Map<string, string>();
  const files: BuildFiles = {
    has: (path) => path === "assets/level.json" || path === "assets/x.adp",
    text: (path) => (path === "assets/level.json" ? '{"ok":1}' : null),
  };
  // deno-lint-ignore no-explicit-any
  const g: Record<string, any> = createNativeGlobals({
    runtime,
    files,
    storage: {
      load: (path) => saved.get(path) ?? null,
      save: (path, data) => void saved.set(path, data),
    },
    now: () => 0,
    sound: { marker: true },
  });

  rec.host.beginFrame();
  g.Screen.clear(Color.new(0, 0, 0, 128));
  const image = new g.Image("cdfs:/assets/sheet.png");
  assertEquals([image.width, image.height], [64, 32]);
  // A GS-convention half tint, a crop swapped to flip, a size of its own.
  image.startx = 32;
  image.endx = 16;
  image.width = 48;
  image.height = 24;
  image.color = Color.new(64, 128, 128, 128);
  image.draw(10, 20);
  const font = new g.Font();
  font.scale = 2;
  font.color = Color.new(128, 128, 0, 128);
  font.print(0, 0, "HI-SCORE");
  rec.host.endFrame();

  const frame = rec.frame();
  assertEquals(frame.rects[0], { x: 0, y: 0, w: 640, h: 448, a: 1 });
  assertEquals(frame.images[0].path, "assets/sheet.png");
  assertEquals(frame.images[0].sx, 16, "endx < startx flips the crop");
  assertEquals(frame.images[0].sw, 16);
  assert(frame.images[0].flipX);
  assertEquals([frame.images[0].dw, frame.images[0].dh], [48, 24]);
  assertEquals(frame.images[0].r, 128, "GS 64 is half of the browser's 255");
  assertEquals(frame.texts[0].text, "HI-SCORE");
  assertEquals([frame.texts[0].r, frame.texts[0].b], [255, 0]);
  assertEquals(frame.texts[0].scale, 2);

  // std: the build's text, the game's own writes, and the open() probe.
  assertEquals(g.std.loadFile("assets/level.json"), '{"ok":1}');
  assertEquals(g.std.loadFile("assets/missing.json"), null);
  assertEquals(g.std.open("assets/missing.adp", "rb"), null);
  const probe = g.std.open("assets/x.adp", "rb");
  assert(probe, "a file the build lists opens for reading");
  probe.close();
  const out = g.std.open("ps2sp_hiscore.txt", "w");
  out.puts("1200");
  out.close();
  assertEquals(g.std.loadFile("ps2sp_hiscore.txt"), "1200");
  assertEquals(g.Sound, { marker: true });
  assertEquals(g.Pads.START, B.START);

  const target: Record<string, unknown> = {};
  installNativeGlobals({ Screen: g.Screen }, target);
  assertEquals(target.Screen, g.Screen);
});

// --------------------------------------------------------------- sound ----

Deno.test("a silent page still answers Sound, and logs what the game asked for", async () => {
  const seen: string[] = [];
  const sound = createWebSound({
    context: null,
    load: () => Promise.resolve(null),
    onEvent: (event) => seen.push(event.key),
  });
  await sound.preload(["assets/sounds/se_correct.adp"]);
  assertEquals(sound.state, "none");
  const Sound = sound.module;
  Sound.setVolume(100);
  const sfx = Sound.Sfx("assets/sounds/se_correct.adp");
  sfx.play(Sound.findChannel());
  const music = Sound.Stream("assets/sounds/adventure_bgm.wav");
  music.play();
  assertEquals(music.playing(), false);
  music.free();
  assertEquals(seen, ["se_correct", "adventure_bgm"]);
  assertEquals(sound.log.map((e) => [e.kind, e.audible]), [
    ["sfx", false],
    ["stream", false],
  ]);
  // findChannel walks audsrv's 24 voices.
  const channels = Array.from({ length: 30 }, () => Sound.findChannel());
  assertEquals(Math.max(...channels), 23);
  assertEquals(soundKey("assets/sounds/scene_x/voice_ko.wav"), "voice_ko");
  assertEquals([audsrvGain(150), audsrvGain(-5), audsrvGain(50)], [1, 0, 0.5]);
  assertEquals([audsrvPan(-200), audsrvPan(25)], [-1, 0.25]);
});

// --------------------------------------------------------------- files ----

Deno.test("athena.ini, files.json and which files load up front", () => {
  // The shape lib/ps2/build.ts writes.
  const ini = parseAthenaIni(
    'boot_logo = false\ndark_mode = true\ndefault_script = "main.js"\n' +
      "audsrv = true\n# a comment\n",
  );
  assertEquals(ini, {
    boot_logo: "false",
    dark_mode: "true",
    default_script: "main.js",
    audsrv: "true",
  });
  assertEquals(bootScript(ini), "main.js");
  assertEquals(bootScript({ default_script: "./game.js" }), "game.js");
  assertEquals(bootScript({}), "main.js");

  const manifest = webManifest([
    { path: "main.js", size: 3 },
    { path: "athena.elf", size: 5_000_000 },
    { path: "SYSTEM.CNF", size: 50 },
    { path: "assets\\level.json", size: 2 },
    { path: "athena.ini", size: 1 },
  ]);
  assertEquals(manifest.version, 1);
  assertEquals(manifest.files.map((f) => f.path), [
    "assets/level.json",
    "athena.ini",
    "main.js",
  ]);

  assertEquals(
    sfxPreloadPaths([
      "assets/sounds/se_shoot.adp",
      "assets/sounds/tonebank/s01.adp",
      "assets/sounds/adventure_bgm.wav",
    ]),
    ["assets/sounds/se_shoot.adp"],
  );
  assert(isTextPath("assets/level_atlas.json"));
  assert(isTextPath("athena.ini"));
  assertEquals(isTextPath("assets/level_atlas.png"), false);
});

Deno.test("the page boots host.js against its build, and its title is escaped", () => {
  const html = webIndexHtml({ title: 'gs <"&">' });
  assert(html.includes("<title>gs &lt;&quot;&amp;&quot;&gt; — PlayStation 2"));
  assert(html.includes('<main id="ps2" data-build="./">'));
  assert(html.includes('<script type="module" src="host.js"></script>'));
  assert(
    webIndexHtml({ title: "x", build: "../Gs/" }).includes(
      'data-build="../Gs/"',
    ),
  );
});

Deno.test("writeWebBuild copies the tree beside the page and nothing a console alone opens", async () => {
  const dir = await Deno.makeTempDir({ prefix: "shmupx-ps2-web-" });
  try {
    const build = join(dir, "Gs");
    const write = async (path: string, text: string) => {
      await Deno.mkdir(dirname(join(build, path)), { recursive: true });
      await Deno.writeTextFile(join(build, path), text);
    };
    await write("athena.ini", 'default_script = "main.js"\naudsrv = false\n');
    await write("main.js", "globalThis.__PS2_HOST_LOOP__;");
    await write("athena.elf", "ELF");
    await write("SYSTEM.CNF", "BOOT2");
    await write("assets/level.json", "{}");
    await write("assets/old.png", "png");

    const hostJs = new TextEncoder().encode("// host");
    const out = join(dir, "web");
    const result = await writeWebBuild(build, out, { hostJs });
    assertEquals(result.manifest.files.map((f) => f.path), [
      "assets/level.json",
      "assets/old.png",
      "athena.ini",
      "main.js",
    ]);
    assertEquals(await Deno.readTextFile(join(out, "host.js")), "// host");
    assertEquals(
      await Deno.readTextFile(join(out, "main.js")),
      "globalThis.__PS2_HOST_LOOP__;",
    );
    assert((await Deno.readTextFile(result.index)).includes("<title>Gs — "));
    await assertMissing(join(out, "athena.elf"));
    await assertMissing(join(out, "SYSTEM.CNF"));
    const listed = JSON.parse(await Deno.readTextFile(join(out, "files.json")));
    assertEquals(listed, result.manifest);

    // Rewriting removes what the last write put there and this one does not.
    await Deno.remove(join(build, "assets/old.png"));
    await Deno.writeTextFile(join(out, "notes.txt"), "mine");
    await writeWebBuild(build, out, { hostJs, title: "gs" });
    await assertMissing(join(out, "assets/old.png"));
    assertEquals(await Deno.readTextFile(join(out, "notes.txt")), "mine");

    // Not into the build itself, and not from a folder that is not one.
    await assertRejects(
      () => writeWebBuild(build, join(build, "web"), { hostJs }),
      "inside the build",
    );
    await assertRejects(
      () => writeWebBuild(join(build, "assets"), join(dir, "x"), { hostJs }),
      "athena.ini",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

async function assertMissing(path: string): Promise<void> {
  try {
    await Deno.stat(path);
  } catch {
    return;
  }
  throw new Error(`${path} should not be there`);
}

async function assertRejects(
  fn: () => Promise<unknown>,
  includes: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(
      (error as Error).message.includes(includes),
      (error as Error).message,
    );
    return;
  }
  throw new Error(`expected a rejection mentioning "${includes}"`);
}

// ---------------------------------------------------------- end to end ----

Deno.test("a build's main.js runs on the browser runtime and keeps the title's secrets", async () => {
  const cache = join(ROOT, "build", "ps2", ".cache");
  try {
    await Deno.stat(join(cache, "main.js"));
  } catch {
    console.log("  (skipped: run `deno task build:ps2` first)");
    return;
  }
  const runtimeJs = await buildRuntimeBundle(ROOT, cache);
  assert(
    new TextDecoder().decode(runtimeJs).includes("__PS2_HOST_LOOP__"),
    "main.js no longer hands its frame to a host",
  );
  const gameDir = join(ROOT, "static", "games", "2028-ai");
  const record = JSON.parse(await Deno.readTextFile(join(gameDir, "foo.json")));
  const { files: staged } = await stageAssets({ gameDir, record });
  const bytes = new Map(staged.map((file) => [file.path, file.data]));
  const decoder = new TextDecoder();
  const sizeOf = (path: string) => {
    const png = bytes.get(path);
    assert(png, `the game opened ${path}, which is not in the build`);
    const view = new DataView(png.buffer, png.byteOffset);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  };
  // The effects runtime-sound.ts loads, as if the sound pack had staged them.
  const sfx = ["se_correct", "se_decision", "voice_titlecall"].map(
    (key) => `assets/sounds/${key}.adp`,
  );
  const files: BuildFiles = {
    has: (path) => bytes.has(path) || sfx.includes(path),
    text: (path) =>
      isTextPath(path) && bytes.has(path)
        ? decoder.decode(bytes.get(path))
        : null,
  };

  const dir = await Deno.makeTempDir({ prefix: "shmupx-ps2-webhost-" });
  const g = globalThis as unknown as Record<string, unknown>;
  const names: string[] = [];
  let runs = 0;
  /**
   * Boot a fresh copy of main.js, wait for the title's prompt, then hold
   * `hold` and press `press` for a few frames.
   */
  const play = async (hold: number, press: number) => {
    const keys = keyTarget();
    const pads = new WebPadSource({ target: keys.target, gamepads: () => [] });
    const rec = recordingHost(sizeOf, pads);
    const runtime = createRuntime(rec.host);
    let clock = 0;
    const sound = createWebSound({
      context: null,
      load: () => Promise.resolve(null),
    });
    const globals = createNativeGlobals({
      runtime,
      files,
      storage: { load: () => null, save: () => {} },
      now: () => clock,
      sound: sound.module,
    });
    names.push(...Object.keys(globals));
    installNativeGlobals(globals);
    let frame: (() => void) | null = null;
    g.__PS2_HOST_LOOP__ = (f: () => void) => {
      frame = f;
      runtime.Screen.display(f);
    };

    const mainJs = join(dir, `main-${runs++}.mjs`);
    await Deno.writeFile(
      mainJs,
      new Uint8Array([
        ...new TextEncoder().encode("globalThis.__PS2_GAME_FPS__ = 120;\n"),
        ...runtimeJs,
      ]),
    );
    const quiet = console.log;
    console.log = () => {};
    try {
      await import(`file://${mainJs}`);
    } finally {
      console.log = quiet;
    }
    assert(frame, "main.js returned without handing over its frame");
    // deno-lint-ignore no-explicit-any
    const ctx = g.__PS2_CTX__ as any;
    assert(ctx, "main.js did not publish __PS2_CTX__");

    const tick = () => {
      pads.refresh();
      runtime.tick();
      clock += 1000 / 60;
    };
    let prompt = false;
    for (let i = 0; i < 1200 && !prompt; i++) {
      tick();
      prompt = rec.frame().texts.some((t) => t.text === "SELECT = TURBO MODE");
    }
    assert(prompt, "the title never offered SELECT = TURBO MODE");
    assert(rec.frame().texts.some((t) => t.text === "HI-SCORE"));
    assert(rec.frame().images.length > 0, "the title drew no images");

    pads.scripted.set(hold);
    tick();
    pads.scripted.set(hold | press);
    for (let i = 0; i < 4; i++) tick();
    pads.scripted.clear();
    for (let i = 0; i < 4; i++) tick();
    return {
      fading: ctx.scenes.fading as boolean,
      god: ctx.state.godMode as number,
      turbo: ctx.state.turboMode as number,
      sounds: sound.log.map((e) => e.key),
    };
  };

  try {
    const god = await play(B.L1 | B.R1, B.START);
    assert(god.fading, "START at the title did not start the run");
    assertEquals(god.god, 1, "L1+R1+START did not arm god mode");
    assertEquals(god.turbo, 0);
    assert(god.sounds.includes("se_correct"), `no chime: ${god.sounds}`);

    const turbo = await play(0, B.SELECT);
    assert(turbo.fading, "SELECT at the title did not start the run");
    assertEquals(turbo.turbo, 1, "SELECT did not start a turbo run");
    assertEquals(turbo.god, 0, "SELECT alone armed god mode");
    assertEquals(turbo.sounds.includes("se_correct"), false);
  } finally {
    for (const name of new Set(names)) delete g[name];
    delete g.__PS2_HOST_LOOP__;
    delete g.__PS2_CTX__;
    delete g.__PS2_GAME_FPS__;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
