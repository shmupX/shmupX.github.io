#!/usr/bin/env -S deno run -A
/**
 * `deno task game:debug` — open the game, walk it to the stage, pause, and hand
 * the keyboard over.
 *
 * The thing this exists for is that the interesting part of this runtime is
 * three minutes of typewriter story away from the first frame you actually want
 * to look at, and once you are there a running game is useless for inspection:
 * by the time you have read a screenshot the world has moved on a hundred
 * frames. So this task does the boring part once — serve the level, boot a
 * browser with the frame-queue probe installed before the bundle, tap through
 * the title and the story, pause on the first frame of the stage — and then
 * stops and waits, holding the browser and the server open, so that everything
 * after that is a single keystroke: `s` for a frame, `c` for a screenshot,
 * `b a` to press the fire button.
 *
 * WHY THIS PROCESS STAYS IN THE FOREGROUND. It owns both the level server
 * (Deno.serve, in-process) and the Chromium child. If it returns, the server
 * socket closes and the child is orphaned against a dead origin, so the paused
 * page the handover just advertised stops existing. The REPL is therefore not a
 * convenience wrapper around the work — it IS the process's reason to remain
 * alive, and `q`, EOF and SIGINT are the three ways it ends, all of which tear
 * the pair down together.
 *
 * WHY THE PAGE, NOT THIS PROCESS, HOLDS THE DEBUG STATE. Everything the prompt
 * can do is a DevTools call against window.__dbg, so the same page is equally
 * drivable from the `shmupx_debug_*` MCP tools while this prompt sits idle.
 * That is the point of the handover banner printing the port: an agent holding
 * this terminal open can step the game from either side, and neither side has
 * to hand a session object to the other.
 *
 *   deno task game:debug                          # the shipped level, foo.json
 *   deno task game:debug -- --character myBoss \
 *       --clone-from dezaBoss0 --main-projectile hadouken/atlas_s0
 *   deno task game:debug -- --help
 *
 * Needs a Chromium: --chrome wins, then $CHROME_BIN, then the usual installs.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import {
  buildCharacter,
  type CreateRequest,
  MAIN_PROJECTILE_KEY,
} from "../mcp/lib/character.ts";
import {
  buildPreviewLevel,
  type LevelRecord,
  readBaseLevel,
} from "../mcp/lib/preview.ts";
import {
  type DebugStatus,
  DEFAULT_CDP_PORT,
  DEFAULT_SERVE_PORT,
  driveToGame,
  GAME_HEIGHT,
  GAME_WIDTH,
  GameDebug,
  KEY_SPECS,
  launchDebugBrowser,
  PAD_BUTTONS,
} from "./lib/game-debug.ts";

const HELP = `deno task game:debug [-- options]

Serves a level, boots the game with the debug probe installed, walks it to the
first frame of the stage, pauses it, and hands you an interactive prompt.
With no options it serves the SHIPPED level (static/games/2028-ai/foo.json).

  --character <name>        build a character and serve ITS preview level
                            instead of the shipped level as-is
  --clone-from <name>       character it clones (default dezaBoss0)
  --main-projectile <refs>  comma-separated frame refs for its main bullet,
                            e.g. hadouken/atlas_s0,hadouken/hadouken1
  --stage <n>               boss slot / stage to play (default 0)
  --no-boss-rush            keep the wave list; by default bossRush=1 empties
                            it so the boss arrives immediately
  --cdp-port <n>            DevTools port to expose (default ${DEFAULT_CDP_PORT})
  --serve-port <n>          port the level is served on (default ${DEFAULT_SERVE_PORT})
  --headless                run Chromium headless (the default: this container
                            has no display)
  --headed                  run Chromium with a window instead
  --shots <dir>             where \`c\` writes screenshots
                            (default build/debug-shots/<timestamp>)
  --chrome <path>           Chromium binary (\$CHROME_BIN is also read)
  --help`;

const REPL_HELP = `commands (single letters, because you type them a lot)

  s [n]      step n frames (default 1) — pauses first if running
  r          resume: let the game run at full speed again
  p          pause
  c [path]   capture a screenshot (default <shots>/frame-NNNNNN.png)
  b <names>  press pad buttons, comma or space separated ("b a", "b up,a")
             ${Object.keys(PAD_BUTTONS).join(" ")}
  k <names>  send keys, comma or space separated ("k enter", "k z,space")
             ${Object.keys(KEY_SPECS).join(" ")}
  i          inspect: active scenes, the player, what is on screen
  e <expr>   evaluate an expression in the page and print the result
  ?          this help
  q          quit — kills the browser and stops the server (so does Ctrl-C,
             and so does end-of-input on stdin)`;

/** How many frame-name rows `i` prints before it summarises the rest. */
const VISIBLE_FRAME_LINES = 24;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One line, the same shape every time, so a run of `s` reads like a trace. */
function statusLine(st: DebugStatus): string {
  const where = st.scenes.join(",") || "no active scene";
  return `  frame ${st.frame}  ${st.paused ? "paused" : "running"}  loop ${
    st.loopTime ?? "?"
  }ms  ${where}${st.lastError ? `  lastError: ${st.lastError}` : ""}`;
}

/**
 * Lines off stdin, without pulling in a stream helper this repo does not
 * already depend on. Reading raw and splitting by hand also means a closed
 * stdin is a plain end-of-iteration, which is how `q`-less shutdown works when
 * something pipes commands in rather than typing them.
 */
async function* stdinLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const buf = new Uint8Array(4096);
  let pending = "";
  while (true) {
    let n: number | null;
    try {
      n = await Deno.stdin.read(buf);
    } catch {
      // stdin was closed under us (no tty at all, or the parent went away).
      // Indistinguishable from EOF as far as the prompt is concerned.
      n = null;
    }
    if (n === null) break;
    pending += decoder.decode(buf.subarray(0, n), { stream: true });
    let nl = pending.indexOf("\n");
    while (nl >= 0) {
      yield pending.slice(0, nl).replace(/\r$/, "");
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
  }
  if (pending.trim()) yield pending;
}

/** "up,a" and "up a" both mean the same two things to a person typing fast. */
function names(arg: string): string[] {
  return arg.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

function printInspect(info: Record<string, unknown>): void {
  const scenes = Array.isArray(info.scenes)
    ? (info.scenes as string[]).join(",")
    : "?";
  console.log(`  scenes          ${scenes || "none"}`);
  console.log(`  frame           ${info.frame}`);
  console.log(`  displayObjects  ${info.displayObjects}`);
  console.log(
    `  player          ${
      info.player ? JSON.stringify(info.player) : "no scene exposes one"
    }`,
  );
  const counts = (info.visibleFrames ?? {}) as Record<string, number>;
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log(`  visibleFrames   ${rows.length} distinct frame names`);
  for (const [name, n] of rows.slice(0, VISIBLE_FRAME_LINES)) {
    console.log(`    ${String(n).padStart(4)}  ${name}`);
  }
  if (rows.length > VISIBLE_FRAME_LINES) {
    console.log(`    ... ${rows.length - VISIBLE_FRAME_LINES} more`);
  }
}

/**
 * The record to serve.
 *
 * Default is the shipped level read straight off disk — that is "the game foo",
 * the thing whose bugs are worth stepping through. Naming a character switches
 * to the same build-and-stack path the preview tool uses, so a character can be
 * debugged frame by frame before it is published anywhere.
 */
async function levelRecord(
  character: string | undefined,
  cloneFrom: string,
  mainProjectile: string,
  stage: number,
): Promise<LevelRecord> {
  const base = await readBaseLevel();
  if (!character) return base;

  // `mainProjectile` is NOT a CreateRequest field. It is sugar the MCP tool
  // layer owns (mcp/server.ts's toRequest), and buildCharacter ignores unknown
  // keys in silence — hand it `mainProjectile` and the character quietly keeps
  // the clone's own bullets, which looks exactly like a runtime bug from the
  // prompt. So fold it into projectiles[bulletDataA].texture here, the same way
  // scripts/verify-preview.ts does, rather than importing server.ts (which
  // connects a stdio transport at module scope).
  const refs = names(mainProjectile);
  const request: CreateRequest = {
    name: character,
    cloneFrom,
    ...(refs.length
      ? { projectiles: { [MAIN_PROJECTILE_KEY]: { texture: refs as never } } }
      : {}),
  };
  console.log(`building ${character} (clone of ${cloneFrom}) ...`);
  const built = await buildCharacter(request);
  if (built.unresolved.length) {
    // Not fatal the way it is in preview:verify. A character whose frames did
    // not resolve is a legitimate thing to want to stare at in the runtime —
    // but it must be said out loud, because on screen it just wears stock art.
    console.log(
      `  warning: ${built.unresolved.length} frame(s) have no pixels behind ` +
        `them and will render as stock art: ${built.unresolved.join(", ")}`,
    );
  }
  for (const w of built.warnings) console.log(`  warning: ${w}`);
  console.log(`  packed ${built.atlas.frameCount} frames`);
  return await buildPreviewLevel(built, { base, stage });
}

async function main(): Promise<number> {
  // `deno task game:debug -- --headed` forwards the separator itself, and
  // parseArgs treats a bare "--" as "stop parsing", which dumps every flag
  // after it into `_` — including --help. Drop it so both spellings work.
  const argv = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
  const args = parseArgs(argv, {
    boolean: ["help", "headless", "headed", "boss-rush"],
    negatable: ["boss-rush"],
    string: [
      "character",
      "clone-from",
      "main-projectile",
      "stage",
      "cdp-port",
      "serve-port",
      "shots",
      "chrome",
    ],
    default: {
      "clone-from": "dezaBoss0",
      "main-projectile": "",
      "stage": "0",
      "cdp-port": String(DEFAULT_CDP_PORT),
      "serve-port": String(DEFAULT_SERVE_PORT),
      "boss-rush": true,
    },
  });
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.headless && args.headed) {
    console.error("error: --headless and --headed contradict each other");
    return 2;
  }
  const headless = !args.headed;
  const stage = Number(args.stage);
  const cdpPort = Number(args["cdp-port"]);
  const servePort = Number(args["serve-port"]);
  for (
    const [flag, value] of [
      ["--stage", stage],
      ["--cdp-port", cdpPort],
      ["--serve-port", servePort],
    ] as const
  ) {
    if (!Number.isInteger(value) || value < 0) {
      console.error(`error: ${flag} wants a non-negative integer`);
      return 2;
    }
  }
  if (
    !args.character &&
    (args["main-projectile"] || args["clone-from"] !== "dezaBoss0")
  ) {
    console.error(
      "error: --clone-from and --main-projectile only mean something with " +
        "--character <name>; without it the SHIPPED level is served unchanged",
    );
    return 2;
  }

  // Under build/, which is gitignored: a debug session leaves screenshots
  // behind and they are not worth a .gitignore entry of their own.
  const shots = args.shots ??
    join(
      repoRoot(),
      "build/debug-shots",
      new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
    );

  let record: LevelRecord;
  try {
    record = await levelRecord(
      args.character,
      args["clone-from"]!,
      args["main-projectile"]!,
      stage,
    );
  } catch (err) {
    // buildCharacter throws with the atlas and its frame list already in the
    // message when a reference names something the catalog does not have.
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let launched: Awaited<ReturnType<typeof launchDebugBrowser>> | null = null;
  let dbg: GameDebug | null = null;
  let closing = false;

  /**
   * Kill the child before shutting the server down, and never wait forever on
   * either: Deno.serve's shutdown() drains in-flight requests, and a browser
   * still holding a keep-alive connection to the level can make that hang past
   * the point where anyone cares.
   */
  const teardown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      dbg?.close();
    } catch { /* socket already gone */ }
    try {
      launched?.cdp.close();
    } catch { /* ditto */ }
    try {
      launched?.kill();
    } catch { /* already dead */ }
    if (launched) await Promise.race([launched.stopServer(), sleep(3000)]);
  };

  try {
    launched = await launchDebugBrowser({
      record,
      servePort,
      cdpPort,
      headless,
      bossRush: args["boss-rush"],
      stage,
      chromeBin: args.chrome ?? null,
      log: (s) => console.log(s),
    });
  } catch (err) {
    await teardown();
    console.error(
      `error: the debug browser would not start — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  // Registered only now that there is something to clean up. Ctrl-C during the
  // three-minute walk has to take the browser and the server with it, or the
  // next run finds both ports busy.
  Deno.addSignalListener("SIGINT", () => {
    console.log("\ninterrupted — stopping the browser and the server");
    teardown().finally(() => Deno.exit(0));
  });

  let reached: DebugStatus;
  const started = Date.now();
  // driveToGame only speaks up when the scene changes, and the story is one
  // scene for about three minutes. Without a heartbeat that silence reads as a
  // hang, and the natural reaction is to Ctrl-C a run that was working.
  const heartbeat = setInterval(() => {
    console.log(
      `  ... ${
        Math.round((Date.now() - started) / 1000)
      }s — still tapping through the story (there is no skip; a press only ` +
        `completes the line it is on)`,
    );
  }, 15_000);
  try {
    console.log("walking the runtime to the stage ...");
    reached = await driveToGame(launched.cdp, { log: (s) => console.log(s) });
  } catch (err) {
    clearInterval(heartbeat);
    await teardown();
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    clearInterval(heartbeat);
  }
  console.log(
    `reached the stage after ${
      Math.round((Date.now() - started) / 1000)
    }s (frame ${reached.frame})`,
  );

  let paused: DebugStatus;
  try {
    dbg = await GameDebug.attach(cdpPort);
    paused = await dbg.pause();
  } catch (err) {
    await teardown();
    console.error(
      `error: the game reached the stage but could not be paused — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  const bar = "─".repeat(72);
  console.log(`\n${bar}`);
  console.log("HANDOVER — the game is paused on the stage and yours to drive");
  console.log(bar);
  console.log(`  DevTools port   ${launched.cdpPort}`);
  console.log(`  served URL      ${launched.url}`);
  console.log(`  frame           ${paused.frame} (paused)`);
  console.log(`  active scenes   ${paused.scenes.join(",") || "none"}`);
  console.log(`  screenshots     ${shots}`);
  console.log("");
  console.log("  Two ways to drive it, both against this same paused page:");
  console.log("");
  console.log("  1. this prompt — type ? for the full list:");
  console.log(
    "     s [n] step   r resume   p pause   c [path] screenshot",
  );
  console.log(
    "     b <buttons> press pad   k <keys> send keys   i inspect   " +
      "e <expr> eval   q quit",
  );
  console.log("");
  console.log(
    `  2. the shmupx_debug_* MCP tools, which attach over port ${launched.cdpPort}:`,
  );
  console.log(
    "     shmupx_debug_status, shmupx_debug_inspect, shmupx_debug_pause,",
  );
  console.log(
    "     shmupx_debug_resume, shmupx_debug_step, shmupx_debug_press,",
  );
  console.log(
    "     shmupx_debug_keys, shmupx_debug_eval, shmupx_debug_screenshot",
  );
  console.log("");
  console.log(
    "  Leave this running: it owns the server and the browser, so quitting " +
      "it\n  ends the session for the MCP tools too.",
  );
  console.log(`${bar}\n`);

  const prompt = () => {
    try {
      Deno.stdout.writeSync(new TextEncoder().encode("debug> "));
    } catch { /* stdout closed; the commands still work */ }
  };

  prompt();
  for await (const raw of stdinLines()) {
    const line = raw.trim();
    if (!line) {
      prompt();
      continue;
    }
    const token = line.split(/\s+/)[0];
    const cmd = token.toLowerCase();
    // The remainder verbatim, not re-joined: `e` and `c` both take arguments
    // whose spacing matters (an expression, a path).
    const rest = line.slice(token.length).trim();
    try {
      switch (cmd) {
        case "s": {
          const n = rest ? Number(rest) : 1;
          if (!Number.isInteger(n) || n < 1 || n > 3600) {
            console.log(`  s wants a whole number of frames, 1..3600`);
            break;
          }
          console.log(statusLine(await dbg.step(n)));
          break;
        }
        case "r":
          console.log(statusLine(await dbg.resume()));
          break;
        case "p":
          console.log(statusLine(await dbg.pause()));
          break;
        case "c": {
          const st = await dbg.status();
          const path = rest ||
            join(shots, `frame-${String(st.frame).padStart(6, "0")}.png`);
          const shot = await dbg.screenshot(path);
          // The size is printed because anything other than the game's own
          // 256x480 means the capture is a scaled render of the game rather
          // than its pixels, and the PNG gives no hint of that on its own.
          const size = `${shot.width}x${shot.height}`;
          const off = shot.width === GAME_WIDTH && shot.height === GAME_HEIGHT
            ? ""
            : ` — NOT ${GAME_WIDTH}x${GAME_HEIGHT}, so this is a scaled render`;
          console.log(
            `  wrote ${shot.path} (${size}, ${shot.bytes} bytes, frame ${shot.frame})${off}`,
          );
          console.log(statusLine(st));
          break;
        }
        case "b": {
          const buttons = names(rest);
          if (!buttons.length) {
            console.log(
              `  b wants at least one button: ${
                Object.keys(PAD_BUTTONS).join(" ")
              }`,
            );
            break;
          }
          console.log(statusLine(await dbg.press(buttons)));
          break;
        }
        case "k": {
          const keys = names(rest);
          if (!keys.length) {
            console.log(
              `  k wants at least one key: ${Object.keys(KEY_SPECS).join(" ")}`,
            );
            break;
          }
          console.log(statusLine(await dbg.keys(keys)));
          break;
        }
        case "i":
          printInspect(await dbg.inspect());
          console.log(statusLine(await dbg.status()));
          break;
        case "e": {
          if (!rest) {
            console.log("  e wants an expression, e.g. e window.__dbg.frame");
            break;
          }
          const value = await dbg.evaluate<unknown>(rest);
          console.log(
            `  ${
              value === undefined
                ? "undefined"
                : typeof value === "string"
                ? value
                : JSON.stringify(value, null, 2)
            }`,
          );
          console.log(statusLine(await dbg.status()));
          break;
        }
        case "q":
        case "quit":
        case "exit":
          console.log("stopping the browser and the server");
          await teardown();
          return 0;
        case "?":
        case "h":
        case "help":
          console.log(REPL_HELP);
          break;
        default:
          // An unknown command is a typo, not a reason to drop a session that
          // took three minutes to set up.
          console.log(`  unknown command "${cmd}"`);
          console.log(REPL_HELP);
      }
    } catch (err) {
      // A bad button name, an expression that throws in the page, an
      // unwritable screenshot path: all recoverable, none worth the session.
      console.log(`  ! ${err instanceof Error ? err.message : String(err)}`);
    }
    prompt();
  }

  // End of input rather than `q` — piped commands ran out, or the terminal
  // went away. Same shutdown either way.
  console.log("\nstdin closed — stopping the browser and the server");
  await teardown();
  return 0;
}

if (import.meta.main) Deno.exit(await main());
