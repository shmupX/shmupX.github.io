// Putting one level into one Dezaemon 2 save slot, without disturbing anything
// else the cartridge holds.
//
// A level goes into ONE slot (DEZA2____NN) on a 512 KB backup cartridge and
// every other save on that cart stays byte-identical. Only the .bcr is ever
// written. The .bkr — the console's own 32 KB internal memory, which holds
// Dezaemon 2's DEZA2___SYS options record — is never opened at all: a freshly
// built .sav's internal partition is a formatted but EMPTY partition, so
// writing it could only ever destroy something, and Mednafen formats internal
// RAM by itself the first time it boots a disc with no .bkr beside it (every
// untouched .bkr in a Mednafen save directory is byte-for-byte
// `formatPartition(32768, 64)`). The .smpc, the emulated clock, is likewise
// left alone.
//
// The previous cart is copied to backup/ first, the new one is written to a
// temp file and renamed over the old, and then read back through the same
// parser the console uses — the injected level checked three ways and every
// pre-existing save compared byte for byte — before this reports success. Any
// mismatch restores the backup.
//
// This is the one place in the repo that writes a cart, and both ways into one
// reach it: `deno task sav:inject` through scripts/inject-cart.ts and its
// per-platform legs, and `deno task sav:run` / POST /api/saturn-save through
// installCartSave() in lib/mednafen.ts. It lives in lib/ rather than scripts/
// because a Fresh route may not import a script; it reports by throwing
// InjectError and says nothing at all unless a caller passes `log`, because a
// library called from an HTTP handler must not write to stdout.

import { basename, dirname, join, resolve } from "@std/path";
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

/** Every failure a caller should report as `error: <message>` and exit 2. */
export class InjectError extends Error {
  override name = "InjectError";
}

/** The name an existing cart is backed up under, in the save directory's
 * backup/ folder. */
export function backupFileName(name: string, now: Date): string {
  return `${name}.${now.toISOString().replace(/[:.]/g, "-")}.bcr`;
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
  /** The built .sav the level comes out of: its bytes, or a path to read.
   * The editor's route has only bytes and never a file, so both are taken. */
  sav: Uint8Array | string;
  /** The .bcr to merge into. It need not exist: a cart the game has never
   * written is started from a freshly formatted partition. */
  cart: string;
  /** "1".."5", or "" for the rule below (same-comment slot, else lowest free). */
  slot?: string;
  /** Report and write nothing. */
  dryRun?: boolean;
  /** Named in the closing "load it" line: OpenEmu, Mednafen, or "" for neither. */
  emulator?: string;
  /** How THIS caller's user picks a different slot, for the two no-room
   * refusals. Default: sav:inject's --slot flag. sav:run and the editor's route
   * have no such flag, and on macOS sav:inject writes OpenEmu's cart rather
   * than the one they merge into, so naming it there would send somebody to
   * fill a slot on the wrong cartridge. It has to read both after a semicolon
   * and, capitalized, as a sentence of its own. */
  advice?: string;
  /** Where the human report goes. Default: nowhere — a library called from an
   * HTTP handler must not write to stdout, so a CLI passes console.log. */
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
  const log = req.log ?? (() => {});
  const dryRun = req.dryRun === true;
  const advice = req.advice ?? "pass --slot 1-5 to replace one";
  const asSentence = req.advice
    ? `${advice[0].toUpperCase()}${advice.slice(1)}.`
    : "Free a slot, or pass --slot 1-5 to replace one.";

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
    const bytes = typeof req.sav === "string"
      ? await Deno.readFile(req.sav)
      : req.sav;
    const got = gamePayloadFromSav((await normalize(bytes)).data);
    payload = got.payload;
    entry = got.entry;
  } catch (e) {
    fail(
      `${
        typeof req.sav === "string" ? req.sav : "the save"
      } is not a Dezaemon 2 .sav: ${(e as Error).message}`,
    );
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
      }; ${advice}`,
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
    fail(`${(e as Error).message}. ${asSentence}`);
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
  // One name per cart, deliberately: two merges racing on the same cart collide
  // here and both refuse, which is the outcome to want. Giving each run a name
  // of its own lets both writes through, and then the loser's read-back sees
  // the winner's cart, restores its backup over it, and BOTH callers are told
  // their level is on a cart that holds one of them (measured: 3 runs in 4).
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
    // Whatever went wrong here, the one thing that must survive is the sentence
    // saying where the cart is. A copy that fails on its way back — a full
    // disk, a directory that turned read-only mid-run — would otherwise replace
    // this with a raw Deno error, and the route would answer 500 instead of the
    // 400 its callers read.
    let putBack: string | null = null;
    if (backup) {
      try {
        await Deno.copyFile(backup, bcrPath);
        putBack = `. The previous cart has been restored from backup/${
          basename(backup)
        }`;
      } catch (e) {
        putBack = `. The previous cart could NOT be put back (${
          (e as Error).message
        }) — restore it yourself with: cp ${tilde(backup)} ${tilde(bcrPath)}`;
      }
    } else {
      // There was no cart here before, so leaving the rejected one behind would
      // hand Mednafen a file to boot from that nothing has vouched for.
      await Deno.remove(bcrPath).catch(() => {});
    }
    return new InjectError(
      `the cart written to ${
        tilde(bcrPath)
      } did not read back correctly (${why})` + (putBack ?? ""),
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
