#!/usr/bin/env -S deno run -A
/**
 * `deno task preview:verify` — prove that a previewed character reaches the
 * running game with all of its art.
 *
 * Why a browser at all. Every cheaper check passes on art that never renders:
 * the record can name a frame the atlas does not carry, the atlas can carry a
 * frame the level's sheet does not stack, and the runtime filters frame names
 * it does not recognise out in silence — the character simply wears stock art
 * and nothing anywhere says so. Only the runtime's own texture knows which
 * frames arrived, so this boots the real bundle and asks it.
 *
 * The frames are checked against `game_asset`, not against a texture named
 * after the character: buildPreviewLevel stacks the character's sheet UNDER the
 * level's own and merges the two frame maps, which is exactly what the level
 * loader does, so by the time the game holds them they are part of the level's
 * one sheet. Looking for a `<character>` texture finds nothing and reports a
 * clean false negative.
 *
 *   deno task preview:verify                  # build, serve, boot, check frames
 *   deno task preview:verify -- --play        # also play to the boss and watch it fire
 *   deno task preview:verify -- --help
 *
 * Needs a Chromium, found by the profiler's own findChrome(): $CHROME_BIN
 * wins; otherwise the Playwright cache and the usual system installs are
 * searched. Nothing is downloaded.
 */

import { parseArgs } from "@std/cli/parse-args";
import {
  buildCharacter,
  type CreateRequest,
  MAIN_PROJECTILE_KEY,
} from "../mcp/lib/character.ts";
import {
  buildPreviewLevel,
  readBaseLevel,
  servePreview,
  stopPreview,
} from "../mcp/lib/preview.ts";
// The profiler's browser layer, rather than a second copy of it here. Its
// findChrome() searches the Playwright cache and the Linux installs this file
// used to have to search for itself, and its Cdp propagates page exceptions,
// carries events, and rejects a command the browser refused — all three of
// which the private client that used to live below did not.
import {
  Cdp,
  findChrome,
} from "../packages/shmup-harbor/tools/sav-profiler/lib/web.ts";

/** Frames the character was packed with that the runtime did not end up holding. */
export function missingFrames(expected: string[], actual: string[]): string[] {
  const have = new Set(actual);
  return expected.filter((f) => !have.has(f));
}

/** ─── the browser ───────────────────────────────────────────────────────── */

/** A port nobody is on, asked for rather than guessed. */
function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Attach to the page of the Chrome this task just spawned.
 *
 * Polled because nothing was waited for: /json/list refuses connections until
 * the DevTools endpoint is listening, and then answers with no page target for
 * a moment after that.
 */
async function attach(port: number, timeoutMs = 30_000): Promise<Cdp> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(400);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`))
        .json();
      const page = list.find((t: Record<string, string>) => t.type === "page");
      if (!page?.webSocketDebuggerUrl) continue;
      return await Cdp.connect(page.webSocketDebuggerUrl);
    } catch { /* browser still coming up */ }
  }
  throw new Error("could not attach to the browser's devtools");
}

/**
 * Evaluate, treating every kind of failure as "not there yet".
 *
 * Cdp.eval THROWS on a page exception, where the hand-rolled client this file
 * used to carry returned undefined. Throwing is the better default everywhere
 * except in the two polling loops below, which by design interrogate a page
 * that is still booting: FIND_GAME walks every window key and a getter on one
 * of them can throw, framesIn() and drawing() index into a game object and a
 * texture list that do not exist until the level has loaded, and
 * Runtime.evaluate is itself refused while a navigation is swapping the
 * execution context out. Each of those means "ask again in a second", so they
 * come back as null and the loop's own deadline stays the only thing that can
 * fail the run — which is the whole assertion this task is built on.
 */
async function poll<T>(cdp: Cdp, expression: string): Promise<T | null> {
  try {
    return await cdp.eval<T>(expression);
  } catch {
    return null;
  }
}

/** Enter/Space/Z and a tap: whatever this build listens for, one of these is it. */
async function nudge(cdp: Cdp) {
  for (
    const [key, code, vk] of [["Enter", "Enter", 13], [" ", "Space", 32], [
      "z",
      "KeyZ",
      90,
    ]] as const
  ) {
    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
    }
  }
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: 240,
      y: 400,
      button: "left",
      clickCount: 1,
    });
  }
}

async function screenshot(cdp: Cdp, path: string) {
  const r = await cdp.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Deno.writeFile(
    path,
    Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)),
  );
}

/** ─── what we ask the running game ──────────────────────────────────────── */

// The game instance is not exported; Phaser parks it on window under its own
// name, so it is found by shape rather than by a name that could change.
const FIND_GAME = `(() => {
  for (const k of Object.keys(window)) {
    const v = window[k];
    if (v && v.scene && v.textures && v.canvas) return k;
  }
  return null;
})()`;

const framesIn = (game: string, texture: string) =>
  `(() => {
  const t = window[${JSON.stringify(game)}].textures.list[${
    JSON.stringify(texture)
  }];
  return t && t.getFrameNames ? t.getFrameNames() : null;
})()`;

/** Visible sprites drawing any of `names`, with enough detail to be believed. */
const drawing = (game: string, names: string[]) =>
  `(() => {
  const want = new Set(${JSON.stringify(names)});
  const g = window[${JSON.stringify(game)}];
  const hits = [];
  for (const s of g.scene.scenes) {
    if (!s.sys.settings.active || !s.children) continue;
    const walk = (l) => { for (const c of l || []) {
      const f = c.frame && c.frame.name;
      if (typeof f === "string" && want.has(f) && c.visible) {
        hits.push({
          frame: f, x: Math.round(c.x), y: Math.round(c.y),
          w: Math.round(c.displayWidth || 0), h: Math.round(c.displayHeight || 0),
        });
      }
      if (c.list) walk(c.list);
    } };
    walk(s.children.list);
  }
  return hits;
})()`;

/** ─── main ──────────────────────────────────────────────────────────────── */

const HELP = `deno task preview:verify [-- options]

  --name <s>             name for the built character (default hadoukenBoss)
  --clone-from <s>       character to clone (default dezaBoss0)
  --main-projectile <s>  comma-separated frame refs for bulletDataA
                         (default hadouken/atlas_s0,hadouken/hadouken1)
  --stage-bg-end <s>     stage-end backdrop frame ref, or "" for none
                         (default bg-great-hall/atlas_s0)
  --stage-bg-end-alpha   0..1 (default 0.45)
  --stage <n>            boss slot (default 0)
  --port <n>             preview server port (default 8823)
  --boot-timeout <s>     seconds to wait for the frames to reach the runtime
                         (default 180)
  --play                 also play to the boss and confirm it draws and fires
  --play-timeout <s>     seconds to allow for that (default 420)
  --shots <dir>          write screenshots here
  --help`;

async function main(): Promise<number> {
  // `deno task preview:verify -- --play` forwards the separator itself, so
  // Deno.args starts with a literal "--". parseArgs treats that as "stop", and
  // every flag after it lands in `_` unparsed -- including --help, which is how
  // this was noticed. Drop it so both spellings work.
  const argv = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
  const args = parseArgs(argv, {
    boolean: ["play", "help"],
    string: [
      "name",
      "clone-from",
      "main-projectile",
      "stage-bg-end",
      "stage-bg-end-alpha",
      "stage",
      "port",
      "boot-timeout",
      "play-timeout",
      "shots",
    ],
    default: {
      "name": "hadoukenBoss",
      "clone-from": "dezaBoss0",
      "main-projectile": "hadouken/atlas_s0,hadouken/hadouken1",
      "stage-bg-end": "bg-great-hall/atlas_s0",
      "stage-bg-end-alpha": "0.45",
      "stage": "0",
      "port": "8823",
      "boot-timeout": "180",
      "play-timeout": "420",
    },
  });
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const shots = args.shots;
  if (shots) await Deno.mkdir(shots, { recursive: true });
  const shot = async (dt: Cdp, name: string) => {
    if (shots) await screenshot(dt, `${shots}/${name}.png`);
  };

  // `mainProjectile` is sugar the TOOL layer owns, not a CreateRequest field:
  // mcp/server.ts's toRequest folds it into projectiles[MAIN_PROJECTILE_KEY].
  // Handing it to buildCharacter directly is ignored in silence — the character
  // keeps the clone's own bullets and the swap simply never happens — so the
  // same fold is done here. server.ts cannot be imported for it: it connects a
  // stdio transport at module scope.
  const main = args["main-projectile"]!.split(",").filter(Boolean);
  const request: CreateRequest = {
    name: args.name!,
    cloneFrom: args["clone-from"]!,
    ...(main.length
      ? { projectiles: { [MAIN_PROJECTILE_KEY]: { texture: main as never } } }
      : {}),
    ...(args["stage-bg-end"]
      ? {
        stageBgEnd: args["stage-bg-end"],
        stageBgEndAlpha: Number(args["stage-bg-end-alpha"]),
      }
      : {}),
  };

  console.log(`building ${request.name} (clone of ${request.cloneFrom}) ...`);
  let built;
  try {
    built = await buildCharacter(request);
  } catch (err) {
    // A frame reference that names an atlas or a frame the catalog does not
    // have throws rather than landing in `unresolved`, and its message already
    // names the atlas and lists what it does carry. Report it as a failure
    // instead of letting the stack trace be the output.
    console.error(
      `FAIL  ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  // The static half of "a missing frame": names the record carries that no
  // source could supply. buildCharacter collects them rather than throwing,
  // because the tool layer wants to show them; here they are simply fatal.
  if (built.unresolved.length) {
    console.error(
      `FAIL  ${built.unresolved.length} frame(s) have no pixels behind them: ` +
        built.unresolved.join(", "),
    );
    return 1;
  }
  const expected = Object.keys(built.atlas.json.frames).sort();
  console.log(`ok    packed ${expected.length} frames, none unresolved`);

  const stage = Number(args.stage);
  const level = await buildPreviewLevel(built, {
    base: await readBaseLevel(),
    stage,
  });
  const served = await servePreview(level, { port: Number(args.port), stage });
  console.log(`ok    serving ${served.playUrl}`);

  let dt: Cdp | null = null;
  let chrome: Deno.ChildProcess | null = null;
  try {
    // Discovery lives INSIDE the try: the preview server is already listening
    // by now, so a throw out here would leave it bound and print a stack trace
    // instead of the FAIL line every other failure in this task produces.
    let browser: string;
    try {
      browser = await findChrome();
    } catch (err) {
      console.error(
        `FAIL  ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
    const cdpPort = freePort();
    chrome = new Deno.Command(browser, {
      args: [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=480,720",
        `--remote-debugging-port=${cdpPort}`,
        "--autoplay-policy=no-user-gesture-required",
        served.playUrl,
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();

    dt = await attach(cdpPort);
    await dt.send("Page.enable");
    await dt.send("Runtime.enable");

    // Wait for the frames themselves, not merely for game_asset to exist.
    // game_asset is created early holding the BASE game's own art, and the
    // level's stacked sheet -- the one carrying this character -- is merged in
    // later, as the level loads. Gating on "the texture has some frames" is
    // therefore a gate that opens too soon, and reports every frame missing.
    // Waiting for the set to arrive makes the timeout itself the assertion: a
    // frame that never turns up is exactly what this task exists to catch.
    let game: string | null = null;
    let runtime: string[] = [];
    let missing = expected;
    const bootBy = Date.now() + Number(args["boot-timeout"]) * 1000;
    while (Date.now() < bootBy) {
      game ??= await poll<string>(dt, FIND_GAME);
      if (game) {
        runtime = await poll<string[]>(dt, framesIn(game, "game_asset")) ?? [];
        missing = missingFrames(expected, runtime);
        if (!missing.length) break;
      }
      await sleep(1000);
    }
    if (!game) {
      console.error("FAIL  no Phaser game ever appeared on the page");
      await shot(dt, "no-game");
      return 1;
    }
    if (missing.length) {
      console.error(
        `FAIL  ${missing.length} of ${expected.length} packed frame(s) never ` +
          `reached the runtime within ${args["boot-timeout"]}s ` +
          `(game_asset holds ${runtime.length}): ${missing.join(", ")}`,
      );
      await shot(dt, "missing-frames");
      return 1;
    }
    console.log(
      `ok    all ${expected.length} packed frames present in game_asset ` +
        `(${runtime.length} frames total)`,
    );

    if (!args.play) {
      console.log("\nPASS  (pass --play to also watch it arrive and fire)");
      return 0;
    }

    // Playing it. The runtime reads only bossRush and stage -- there is no
    // story skip -- so the intro is tapped through. The taps are also the fire
    // button, which is why they stop the moment the boss shows up: a boss the
    // player is shooting dies before it runs a fire pattern.
    const bossFrames = [
      ...new Set(
        Object.values(built.character.anim ?? {}).flat() as string[],
      ),
    ];
    const shotFrames =
      (built.character.bulletDataA as { texture?: string[] } | undefined)
        ?.texture ?? [];

    let bossSeen: Record<string, unknown>[] | null = null;
    let shotSeen: Record<string, unknown>[] | null = null;
    const playBy = Date.now() + Number(args["play-timeout"]) * 1000;
    let lastTap = 0;
    while (
      Date.now() < playBy && !(bossSeen && (shotSeen || !shotFrames.length))
    ) {
      if (!bossSeen && Date.now() - lastTap > 450) {
        await nudge(dt);
        lastTap = Date.now();
      }
      if (!bossSeen) {
        const hits = await poll<Record<string, unknown>[]>(
          dt,
          drawing(game, bossFrames),
        );
        if (hits?.length) {
          bossSeen = hits;
          console.log(`ok    boss on screen: ${JSON.stringify(hits[0])}`);
          await shot(dt, "boss");
        }
      } else if (shotFrames.length && !shotSeen) {
        const hits = await poll<Record<string, unknown>[]>(
          dt,
          drawing(game, shotFrames),
        );
        if (hits?.length) {
          shotSeen = hits;
          console.log(
            `ok    main projectile fired: ${JSON.stringify(hits[0])}`,
          );
          await shot(dt, "projectile");
        }
      }
    }

    if (!bossSeen) {
      console.error(
        "FAIL  the boss never drew any of its animation frames: " +
          bossFrames.join(", "),
      );
      await shot(dt, "no-boss");
      return 1;
    }
    if (shotFrames.length && !shotSeen) {
      console.error(
        "FAIL  the boss never drew its main projectile: " +
          shotFrames.join(", "),
      );
      await shot(dt, "no-projectile");
      return 1;
    }
    console.log("\nPASS");
    return 0;
  } finally {
    dt?.close();
    if (chrome) {
      try {
        chrome.kill();
      } catch { /* already gone */ }
      await chrome.status;
    }
    await stopPreview();
  }
}

if (import.meta.main) {
  Deno.exit(
    await main().catch((err) => {
      console.error(
        `FAIL  ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }),
  );
}
