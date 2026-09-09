// The merge behind `deno task sav:inject`, shared by all three platforms.
//
// A level goes into ONE Dezaemon 2 save slot (DEZA2____NN) on a 512 KB backup
// cartridge and every other save on that cart stays byte-identical. Only the
// .bcr is ever written: the .bkr is the console's own 32 KB memory, which holds
// Dezaemon 2's DEZA2___SYS options record, and a freshly built .sav's internal
// partition parses to zero entries — writing it could only ever destroy
// something, which is why installCartSave() from lib/mednafen.ts is not reused
// here. The .smpc (the emulated clock) is never touched either.
//
// The previous cart is copied to backup/ first, the new one is written to a
// temp file and renamed over the old, and then read back through the same
// parser the console uses — the injected level checked three ways and every
// pre-existing save compared byte for byte — before this reports success. Any
// mismatch restores the backup.
//
// Who calls what:
//
//   scripts/inject-openemu.sh   (macOS)   runs this file as a CLI, positionally
//   scripts/inject-mednafen.sh  (Linux)   ...through that script's --cart
//   scripts/inject-mednafen-win.ts        imports injectCart() and friends,
//                                         because native Windows has no `sh`
//
// The legs do discovery, the is-the-emulator-running guard and launching.
// Everything that touches a byte is here, once.
import { basename, dirname, fromFileUrl, join, resolve } from "@std/path";
import { backupFileName } from "@/lib/mednafen.ts";
import {
  CART_BLOCK_SIZE,
  GAME_SAVE_SLOTS,
} from "@/packages/shmup-engine/src/bup-write.js";
import {
  CART_PARTITION_SIZE,
  formatPartition,
  gamePayloadFromSav,
  gameSaveFilename,
  normalize,
  parse,
  placeSaveInPartition,
} from "@/packages/shmup-engine/mod.js";

/** The repo root, from this file — never from the cwd. */
export const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

/** Every failure a caller should report as `error: <message>` and exit 2. */
export class InjectError extends Error {
  override name = "InjectError";
}

/** Stop with a message meant for the person who ran the task. */
function fail(m: string): never {
  throw new InjectError(m);
}

/** One save as packages/shmup-engine's parse() returns it. */
interface BupEntry {
  offset: number;
  filename: string;
  comment: string;
  language: number;
  date: number;
  datasize: number;
  blocks: number[];
  payload: { start: number; buffer: Uint8Array } | null;
  payloadError: string | null;
}

const HOME = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
const IS_WINDOWS = Deno.build.os === "windows";
const HOME_MARK = IS_WINDOWS ? "%USERPROFILE%" : "~";
/** A path with the home directory folded back to ~ (or %USERPROFILE%).
 *
 * The backslash only counts as a separator on Windows: it is a legal character
 * in a macOS or Linux file name, so folding "$HOME\odd/x.bcr" there would print
 * a ~ path that names a different file. */
export const tilde = (p: string): string =>
  HOME &&
    (p.startsWith(HOME + "/") || (IS_WINDOWS && p.startsWith(HOME + "\\")))
    ? HOME_MARK + p.slice(HOME.length)
    : p;

const slotOf = (name: string) => String(Number(name.slice(-2)));
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
/** The five DEZA2____NN names, in slot order. */
const SLOT_NAMES: string[] = Array.from(
  { length: GAME_SAVE_SLOTS },
  (_, i) => gameSaveFilename(i + 1),
);

export interface InjectRequest {
  /** The built .sav the level comes out of. */
  sav: string;
  /** The .bcr to merge into. It need not exist: a cart the game has never
   * written is started from a freshly formatted partition. */
  cart: string;
  /** "1".."5", or "" for the rule below (same-comment slot, else lowest free). */
  slot?: string;
  /** Report and write nothing. */
  dryRun?: boolean;
  /** Named in the closing "load it" line: OpenEmu, Mednafen, or "" for neither. */
  emulator?: string;
  /** Where the report goes. Default: stdout. */
  log?: (line: string) => void;
}

export interface InjectResult {
  /** The cart written, after symlinks. */
  cart: string;
  /** 1-5, and the DEZA2____NN name it belongs to. */
  slot: number;
  filename: string;
  /** The level's name as the LOAD screen shows it (first 10 chars). */
  comment: string;
  /** Payload bytes, and the gzip the cart file holds. */
  bytes: number;
  gzipBytes: number;
  /** Saves that were already there and stayed byte-identical. */
  kept: number;
  /** Whether the slot was occupied before. */
  replaced: boolean;
  /** The backup made first, or null when there was no cart to back up. */
  backup: string | null;
  dryRun: boolean;
}

/**
 * Merge the level in `sav` into one slot of the cart at `cart`.
 *
 * Nothing on disk changes until the dry-run branch has been passed, so
 * `dryRun` is provably side-effect-free. Throws InjectError, with the message
 * to print, for every refusal.
 */
export async function injectCart(req: InjectRequest): Promise<InjectResult> {
  const log = req.log ?? ((line: string) => console.log(line));
  const dryRun = req.dryRun === true;

  // Follow a symlinked cart to the file it names: renaming over the link would
  // replace it with a regular file and leave the real cart untouched.
  let bcrPath = resolve(req.cart);
  try {
    bcrPath = await Deno.realPath(bcrPath);
  } catch { /* no such file yet — the game has never written the cart */ }

  // The level, out of the built .sav: payload bytes plus the directory record
  // (comment, language, date) the cart entry should carry.
  let payload: Uint8Array;
  let entry: { comment: string; language: number; date: number };
  try {
    const got = gamePayloadFromSav(
      (await normalize(await Deno.readFile(req.sav))).data,
    );
    payload = got.payload;
    entry = got.entry;
  } catch (e) {
    fail(`${req.sav} is not a Dezaemon 2 .sav: ${(e as Error).message}`);
  }

  // The cart as it stands. A missing .bcr means the game has never written the
  // cartridge — start from a freshly formatted partition.
  let cart: Uint8Array<ArrayBuffer>;
  let cartExisted = true;
  let mode: number | null = null;
  try {
    const stat = await Deno.stat(bcrPath);
    mode = stat.mode;
    const { data } = await normalize(await Deno.readFile(bcrPath));
    if (data.length !== CART_PARTITION_SIZE) {
      fail(
        `the cart save at ${
          tilde(bcrPath)
        } unpacks to ${data.length} bytes, not ${CART_PARTITION_SIZE} — that is not a 512 KB backup cartridge`,
      );
    }
    cart = data;
  } catch (e) {
    if (e instanceof InjectError) throw e;
    if (e instanceof Deno.errors.NotFound) {
      cartExisted = false;
      cart = formatPartition(CART_PARTITION_SIZE, CART_BLOCK_SIZE);
    } else {
      // Unreadable, or gzip that will not unpack — a half-written cart. Say so
      // rather than unwinding as a stack trace.
      fail(
        `cannot read the cart save at ${tilde(bcrPath)}: ${
          (e as Error).message
        }`,
      );
    }
  }
  let all: BupEntry[];
  try {
    all = parse(cart);
  } catch (e) {
    fail(
      `the cart save at ${tilde(bcrPath)} is not a Saturn backup image: ${
        (e as Error).message
      }`,
    );
  }

  // The slot: --slot wins; else the one already holding this level (so a rebuild
  // replaces itself rather than filling the cart with copies); else the lowest free.
  let name: string | undefined;
  if (req.slot) name = gameSaveFilename(Number(req.slot));
  else {
    name = all.find((g) =>
      SLOT_NAMES.includes(g.filename) && g.comment === entry.comment
    )?.filename;
    name ??= SLOT_NAMES.find((f) => !all.some((g) => g.filename === f));
  }
  if (!name) {
    fail(
      `all ${GAME_SAVE_SLOTS} DEZA2____NN slots are in use and none is named ${
        JSON.stringify(entry.comment)
      }; pass --slot 1-5 to replace one`,
    );
  }
  const slotName: string = name;

  // Everything staying put. A save whose block chain the parser cannot follow has
  // no known data blocks, so placement would treat them as free and write over
  // them — refuse rather than quietly eat somebody's level.
  const kept = all.filter((g) => g.filename !== slotName);
  const damaged = kept.filter((g) => !g.payload);
  if (damaged.length) {
    fail(
      `${
        damaged.map((g) => `${g.filename} (${g.payloadError})`).join(", ")
      } on ${tilde(bcrPath)} ` +
        `cannot be read, so the blocks it occupies cannot be identified and a merge would write over them. ` +
        `Delete that save from the Saturn BIOS backup manager, or point --cart at a copy you can afford to lose.`,
    );
  }

  let placed: { replaced: string | null };
  try {
    placed = placeSaveInPartition(cart, CART_BLOCK_SIZE, {
      filename: slotName,
      comment: entry.comment,
      language: entry.language,
      date: entry.date,
      payload,
    }, { replace: slotName });
  } catch (e) {
    fail(
      `${
        (e as Error).message
      }. Free a slot, or pass --slot 1-5 to replace one.`,
    );
  }
  const gz = new Uint8Array(
    await new Response(
      new Blob([cart]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );

  const summary = (verb: string) => {
    log(`cart     : ${tilde(bcrPath)}`);
    log(
      `slot     : ${slotOf(slotName)}  ${slotName}  ${
        JSON.stringify(entry.comment)
      }  ${payload.length} bytes` +
        (placed.replaced ? ` (${verb} what was there)` : ""),
    );
  };
  const result = (backup: string | null): InjectResult => ({
    cart: bcrPath,
    slot: Number(slotOf(slotName)),
    filename: slotName,
    comment: entry.comment,
    bytes: payload.length,
    gzipBytes: gz.length,
    kept: kept.length,
    replaced: placed.replaced !== null,
    backup,
    dryRun,
  });

  if (dryRun) {
    summary("would replace");
    log(
      `would write: ${gz.length} bytes gzip to ${
        tilde(bcrPath)
      }, keeping ${kept.length} other save${kept.length === 1 ? "" : "s"}`,
    );
    if (cartExisted) {
      log(
        `would back up the cart to backup/${
          backupFileName(basename(bcrPath, ".bcr"), new Date())
        }`,
      );
    }
    log("dry run  : nothing was written");
    return result(null);
  }

  // Nothing on disk has changed until here. Back the old cart up, then swap the
  // new one in with a same-directory rename, which is atomic.
  const dir = dirname(bcrPath);
  let backup: string | null = null;
  if (cartExisted) {
    const path = join(
      dir,
      "backup",
      backupFileName(basename(bcrPath, ".bcr"), new Date()),
    );
    try {
      await Deno.mkdir(join(dir, "backup"), { recursive: true });
      await Deno.copyFile(bcrPath, path);
      backup = path;
    } catch (e) {
      fail(
        `cannot back the cart up to ${join(dir, "backup")}: ${
          (e as Error).message
        }`,
      );
    }
  }
  const tmp = `${bcrPath}.tmp`;
  try {
    await Deno.writeFile(tmp, gz);
    // Keep the save set uniform: a fresh file would otherwise land on the umask
    // default while its .bkr and .smpc siblings keep the mode Mednafen gave them.
    // Windows has no such mode, and Deno.chmod there only moves the read-only bit.
    if (mode !== null && Deno.build.os !== "windows") {
      await Deno.chmod(tmp, mode & 0o7777);
    }
    await Deno.rename(tmp, bcrPath);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    fail(`cannot write ${tilde(bcrPath)}: ${(e as Error).message}`);
  }

  // Read the file back through the same parser the console does. `restore`
  // puts the backup back and returns the error to throw, so every one of its
  // call sites reads as the dead end it is.
  const restore = async (why: string): Promise<InjectError> => {
    if (backup) await Deno.copyFile(backup, bcrPath);
    return new InjectError(
      `the cart written to ${
        tilde(bcrPath)
      } did not read back correctly (${why})` +
        (backup
          ? `. The previous cart has been restored from backup/${
            basename(backup)
          }`
          : ""),
    );
  };
  let after: BupEntry[];
  try {
    const round = await normalize(await Deno.readFile(bcrPath));
    if (round.kind !== "gzip" || round.data.length !== CART_PARTITION_SIZE) {
      throw await restore(`${round.kind}, ${round.data.length} bytes`);
    }
    after = parse(round.data);
  } catch (e) {
    // restore() has already run when this is one of ours; anything else is the
    // reader refusing what was just written, which is the same emergency.
    if (e instanceof InjectError) throw e;
    throw await restore((e as Error).message);
  }
  const mine = after.find((g) => g.filename === slotName);
  if (
    !mine || !mine.payload || mine.datasize !== payload.length ||
    !same(mine.payload.buffer, payload)
  ) {
    throw await restore(
      mine
        ? `${slotName} is ${mine.datasize} bytes, ${
          mine.payloadError ?? "not the level that went in"
        }`
        : `${slotName} is missing`,
    );
  }
  // Every other save, compared by its bytes rather than by its header — a
  // neighbour whose data blocks were overwritten still reports its old datasize.
  for (const g of kept) {
    const still = after.find((s) => s.filename === g.filename);
    if (
      !still || !still.payload || !g.payload ||
      !same(still.payload.buffer, g.payload.buffer)
    ) {
      throw await restore(
        `${g.filename} was ${still ? "overwritten" : "lost"}`,
      );
    }
  }

  summary("replacing");
  if (backup) log(`backed up: backup/${basename(backup)}`);
  log(
    `wrote    : ${gz.length} bytes gzip, ${after.length} save${
      after.length === 1 ? "" : "s"
    } on the cart (.bkr and .smpc untouched)`,
  );
  log(
    `load it  : start Dezaemon 2${
      req.emulator ? ` in ${req.emulator}` : ""
    }, then LOAD -> slot ${slotOf(slotName)}`,
  );
  return result(backup);
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
  // only the merge. (The Windows leg imports injectCart() instead.)
  const [sav, cart, slot, dry, emulator] = Deno.args;
  if (!sav || sav === "-h" || sav === "--help" || sav.startsWith("-")) {
    console.log(USAGE);
    console.log(
      "\n(scripts/inject-cart.ts is the shared merge; run the task, not this file.)",
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
    });
  } catch (e) {
    if (e instanceof InjectError) {
      console.error(`error: ${e.message}`);
      Deno.exit(2);
    }
    throw e;
  }
}
