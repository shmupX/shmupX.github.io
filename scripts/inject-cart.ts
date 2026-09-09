// The command line behind `deno task sav:inject`: the argument grammar, the
// .sav build, and the entry point the shell legs call.
//
// The merge itself — the one place a cart is written — moved to
// lib/cart-inject.ts, because routes/api/saturn-save.ts needs it too and a
// Fresh route may not import a script. This file re-exports it so the legs and
// the tests keep one name for it.
//
// Who calls what:
//
//   scripts/inject-openemu.sh   (macOS)   runs this file as a CLI, positionally
//   scripts/inject-mednafen.sh  (Linux)   ...through that script's --cart
//   scripts/inject-mednafen-win.ts        imports injectCart() and friends,
//                                         because native Windows has no `sh`
//
// The legs do discovery, the is-the-emulator-running guard and launching.
// Everything that touches a byte is in lib/cart-inject.ts, once.
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { injectCart, InjectError } from "@/lib/cart-inject.ts";

export {
  backupFileName,
  injectCart,
  InjectError,
  type InjectRequest,
  type InjectResult,
  tilde,
} from "@/lib/cart-inject.ts";

/** The repo root, from this file — never from the cwd. */
export const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

/** Stop with a message meant for the person who ran the task. */
function fail(m: string): never {
  throw new InjectError(m);
}

// --- the command line, for the legs that are not shell -----------------------

export const USAGE =
  `usage: deno task sav:inject [level] [--slot 1-5] [--sav FILE] [--cart FILE]
                            [--dry-run] [--force] [--no-launch]
                            [--] [build:sav flags...]

  level          a cloud level name, a path to a level .json, or nothing for the
                 bundled base game — whatever \`deno task build:sav\` accepts
  --slot 1-5     the Dezaemon 2 save slot (DEZA2____NN). Default: the slot whose
                 comment already matches this level, else the lowest free one
  --sav FILE     inject a .sav that already exists instead of building one
  --cart FILE    write this .bcr instead of finding the emulator's
  --dry-run      report the slot, the size and the backup — write nothing
  --force        write even while the emulator is running
  --no-launch    inject only; do not start the game afterwards. It is not
                 started either when the cart written is not the one your own
                 launcher's Mednafen would open — --cart somewhere else,
                 %MEDNAFEN_SAV%, a MEDNAFEN_BIN elsewhere — because its LOAD
                 screen would not show the level. The run says which happened
  --             everything after this goes to build:sav, flags above included
  anything else  passed straight to scripts/build-sav.ts (--palette, --comment,
                 --horizontal, --two-player, ...)

The cart it replaces is kept: restore one with
  cp <saves>/backup/<name>.<timestamp>.bcr <saves>/<name>.bcr`;

export interface InjectArgs {
  slot: string;
  sav: string;
  cart: string;
  force: boolean;
  dryRun: boolean;
  /** true for --launch, false for --no-launch, null for the leg's default. */
  launch: boolean | null;
  help: boolean;
  /** Everything else, in order: scripts/build-sav.ts's argument list. */
  rest: string[];
}

/**
 * The same argument grammar scripts/inject-openemu.sh implements in POSIX sh
 * (its `while` loop). It lives twice because native Windows has no `sh` and
 * that script is the verified macOS leg, which is not rewritten to suit this
 * one; keep the two in step. Throws InjectError for a usage mistake.
 */
export function parseInjectArgs(argv: string[]): InjectArgs {
  const out: InjectArgs = {
    slot: "",
    sav: "",
    cart: "",
    force: false,
    dryRun: false,
    launch: null,
    help: false,
    rest: [],
  };
  let slotSet = false;
  const need = (i: number, flag: string, what: string): string => {
    if (i >= argv.length) fail(`${flag} needs ${what}`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slot") {
      out.slot = need(++i, "--slot", "a number 1-5");
      slotSet = true;
    } else if (a.startsWith("--slot=")) {
      out.slot = a.slice("--slot=".length);
      slotSet = true;
    } else if (a === "--sav") out.sav = need(++i, "--sav", "a path");
    else if (a.startsWith("--sav=")) out.sav = a.slice("--sav=".length);
    else if (a === "--cart") out.cart = need(++i, "--cart", "a path");
    else if (a.startsWith("--cart=")) out.cart = a.slice("--cart=".length);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--launch") out.launch = true;
    else if (a === "--no-launch") out.launch = false;
    else if (a === "--out" || a.startsWith("--out=")) {
      // build:sav's --out would send the .sav somewhere this task then would
      // not read; it owns that path. Say so rather than build into the void.
      fail(
        "--out belongs to build:sav, which this task drives; sav:inject writes the cart, not a .sav. Build it yourself (deno task build:sav --out FILE) and pass it back with --sav FILE.",
      );
    } else if (a === "-h" || a === "--help") out.help = true;
    // Everything after -- is build:sav's, even if it looks like one of ours.
    else if (a === "--") out.rest.push(...argv.slice(i + 1)), i = argv.length;
    else out.rest.push(a);
  }
  if (slotSet && !/^[1-5]$/.test(out.slot)) {
    fail(
      `--slot must be 1-5 (Dezaemon 2 has five game slots), got ${
        JSON.stringify(out.slot)
      }`,
    );
  }
  if (out.sav && out.rest.length) {
    fail(
      `--sav takes an existing .sav; drop ${out.rest[0]} (nothing is built)`,
    );
  }
  return out;
}

/** Build a .sav with scripts/build-sav.ts, exactly as the shell legs do.
 * Returns its exit code; its own output is inherited. */
export async function buildSav(rest: string[], out: string): Promise<number> {
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(ROOT, "scripts", "build-sav.ts"),
      "--out",
      out,
      ...rest,
    ],
    cwd: ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return code;
}

if (import.meta.main) {
  // The shell legs' entry point: they have already parsed the flags, built the
  // .sav and found the cart, so this takes five positional arguments and does
  // only the merge. (The Windows leg imports injectCart() instead.) This is a
  // command line, so it is the one that asks for the report on stdout.
  const [sav, cart, slot, dry, emulator] = Deno.args;
  if (!sav || sav === "-h" || sav === "--help" || sav.startsWith("-")) {
    console.log(USAGE);
    console.log(
      "\n(this is sav:inject's command line; the merge is lib/cart-inject.ts. Run the task, not this file.)",
    );
    Deno.exit(
      sav && sav.startsWith("-") && sav !== "-h" && sav !== "--help" ? 2 : 0,
    );
  }
  try {
    await injectCart({
      sav,
      cart,
      slot: slot ?? "",
      dryRun: dry === "1",
      emulator: emulator ?? "",
      log: (line) => console.log(line),
    });
  } catch (e) {
    if (e instanceof InjectError) {
      console.error(`error: ${e.message}`);
      Deno.exit(2);
    }
    throw e;
  }
}
