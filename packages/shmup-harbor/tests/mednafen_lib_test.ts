// lib/mednafen.ts, the parts that do not need a Mednafen: the merge into the
// save directory's cart, the argument list and the naming. Launching is the
// CLI's and the route's business and is not exercised here — nothing in CI has
// the emulator, the disc or the BIOS.
//
// The merge is the load-bearing half. installCartSave() is what `deno task
// sav:run` and POST /api/saturn-save call, and it used to REPLACE the cart with
// a freshly formatted partition holding one save, and to write the .bkr from
// the built .sav's empty internal partition — flattening the other four
// Dezaemon 2 slots and erasing DEZA2___SYS. So these tests put real saves on a
// real cart in a temp directory and read them back through the same parser the
// console uses: the level in its slot, every neighbour byte for byte, and the
// .bkr not opened at all.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { basename, join } from "@std/path";
import {
  baseName,
  installCartSave,
  isWslExe,
  mednafenArgs,
  MednafenError,
  NO_DISC_MESSAGE,
  resolveMednafen,
} from "../lib/mednafen.ts";
import { backupFileName } from "../lib/cart-inject.ts";
import {
  CART_PARTITION_SIZE,
  INTERNAL_PARTITION_SIZE,
  normalize,
  parse,
} from "@shmupx/shmup-engine";
import {
  cartOf,
  damage,
  gzip,
  internalRamWith,
  markerPayload,
  savWithLevel,
} from "./support/cart_fixtures.ts";

const NAME = "Dezaemon 2 (Japan)";

/** A Mednafen save directory in a temp dir. `cart` is written as the gzip
 * Mednafen keeps; `bkr` is written raw, the way the console's own memory is
 * stored. Returns the paths and a reader that parses the cart back. */
async function savDir(
  { cart, bkr, hashedCart, create = true }: {
    cart?: Uint8Array;
    bkr?: Uint8Array;
    /** A cart under Mednafen's other, MD5-hashed save name. */
    hashedCart?: Uint8Array;
    /** false: the directory does not exist yet, as on a fresh machine. */
    create?: boolean;
  } = {},
) {
  const root = await Deno.makeTempDir({ prefix: "mednafen-sav-" });
  const dir = join(root, "sav");
  if (create) await Deno.mkdir(dir, { recursive: true });
  const bcrPath = join(dir, `${NAME}.bcr`);
  const bkrPath = join(dir, `${NAME}.bkr`);
  const hashedPath = join(
    dir,
    `${NAME}.c35796654a4f523d460609299a5d2a6d.bcr`,
  );
  if (cart) await Deno.writeFile(bcrPath, await gzip(cart));
  if (bkr) await Deno.writeFile(bkrPath, bkr);
  if (hashedCart) await Deno.writeFile(hashedPath, await gzip(hashedCart));
  return {
    dir,
    bcrPath,
    bkrPath,
    hashedPath,
    /** The cart as the console reads it back. */
    async saves() {
      return parse((await normalize(await Deno.readFile(bcrPath))).data);
    },
    /** Everything in the save directory, sorted — nothing else may appear. */
    entries: () => [...Deno.readDirSync(dir)].map((e) => e.name).sort(),
    clean: () => Deno.remove(root, { recursive: true }),
  };
}

Deno.test("baseName is the disc's save name", () => {
  assertEquals(
    baseName("C:\\saturn\\Dezaemon 2 (Japan)\\Dezaemon 2 (Japan).cue"),
    "Dezaemon 2 (Japan)",
  );
  assertEquals(baseName("/home/me/saturn/dez2.m3u"), "dez2");
  assertEquals(baseName("plain"), "plain");
});

Deno.test("a Windows .exe named from a non-Windows Deno is the WSL interop case", () => {
  assertEquals(isWslExe("/mnt/c/mednafen/mednafen.exe", "linux"), true);
  assertEquals(isWslExe("C:\\mednafen\\mednafen.exe", "windows"), false);
  assertEquals(isWslExe("mednafen", "linux"), false);
});

Deno.test("the argument list forces the save name and translates the disc for a WSL exe", () => {
  const disc = "/mnt/c/saturn/Dezaemon 2 (Japan).cue";
  assertEquals(
    mednafenArgs(disc, ["-sound", "0"], { bin: "mednafen", os: "linux" }),
    [
      "-filesys.fname_sav",
      "%f.%x",
      "-cd.image_memcache",
      "1",
      "-sound",
      "0",
      disc,
    ],
  );
  const winPath = (p: string) => "C:\\saturn\\" + p.split("/").pop();
  assertEquals(
    mednafenArgs(disc, [], {
      bin: "/mnt/c/mednafen/mednafen.exe",
      os: "linux",
      winPath,
    }).at(-1),
    "C:\\saturn\\Dezaemon 2 (Japan).cue",
  );
});

Deno.test("backupFileName stamps the previous cart with a filesystem-safe time", () => {
  assertEquals(
    backupFileName("Dezaemon 2 (Japan)", new Date("2026-09-07T13:10:03.754Z")),
    "Dezaemon 2 (Japan).2026-09-07T13-10-03-754Z.bcr",
  );
});

Deno.test("installCartSave merges into a free slot and leaves the other saves byte for byte", async () => {
  const d = await savDir({
    cart: cartOf([
      { slot: 3, comment: "GRAVEYARD", size: 9000 },
      { slot: 4, comment: "neighbour", size: 4096 },
    ]),
  });
  try {
    const install = await installCartSave(savWithLevel("foo", 3000), {
      savDir: d.dir,
      name: NAME,
    });

    // Slot 1 is the top row of the LOAD screen, and the lowest one free here.
    assertEquals(install.slot, 1);
    assertEquals(install.filename, "DEZA2____01");
    assertEquals(install.replaced, false);
    assertEquals(install.kept, 2, "both saves that were already on the cart");
    // The path is the file actually written: injectCart follows symlinks, so
    // on macOS a /var/folders temp dir comes back as /private/var/folders.
    assertEquals(install.bcrPath, await Deno.realPath(d.bcrPath));
    assertEquals(
      install.note,
      null,
      "one cart, one name, nothing to warn about",
    );
    assertEquals(
      install.gzipBytes,
      (await Deno.stat(d.bcrPath)).size,
      "the size reported is the cart file's own",
    );

    const after = await d.saves();
    assertEquals(
      after.length,
      3,
      "the cart was merged into, not replaced by a fresh partition",
    );
    assertEquals(
      after.find((g) => g.filename === "DEZA2____01")?.payload?.buffer,
      markerPayload("foo", 3000),
    );
    // The two that were there. markerPayload gives every save a different byte
    // sequence, so one written over its neighbour cannot compare equal.
    assertEquals(
      after.find((g) => g.filename === "DEZA2____03")?.payload?.buffer,
      markerPayload("GRAVEYARD", 9000),
      "the slot 3 save was flattened",
    );
    assertEquals(
      after.find((g) => g.filename === "DEZA2____04")?.payload?.buffer,
      markerPayload("neighbour", 4096),
      "the slot 4 save was flattened",
    );
    assertEquals(
      after.find((g) => g.filename === "DEZA2____03")?.comment,
      "GRAVEYARD",
    );
  } finally {
    await d.clean();
  }
});

Deno.test("installCartSave never opens the .bkr Dezaemon 2 keeps its options in", async () => {
  const sys = internalRamWith("OPTIONS");
  const d = await savDir({
    cart: cartOf([{ slot: 4, comment: "neighbour", size: 4096 }]),
    bkr: sys,
  });
  try {
    const install = await installCartSave(savWithLevel("foo", 3000), {
      savDir: d.dir,
      name: NAME,
    });
    assertEquals(install.slot, 1);
    // The whole file, not just its size: the .sav's own internal partition is
    // 32 KB too, so a re-added `Deno.writeFile(bkrPath, bkr)` would pass a
    // length check while erasing DEZA2___SYS.
    assertEquals(
      await Deno.readFile(d.bkrPath),
      sys,
      "the console's internal memory was written over — DEZA2___SYS is gone",
    );
    assertEquals(
      parse(await Deno.readFile(d.bkrPath)).map((g) => g.filename),
      ["DEZA2___SYS"],
    );
  } finally {
    await d.clean();
  }
});

Deno.test("installCartSave writes no .bkr where there is none: Mednafen formats its own", async () => {
  const d = await savDir({
    cart: cartOf([{ slot: 4, comment: "n", size: 512 }]),
  });
  try {
    await installCartSave(savWithLevel("foo", 3000), {
      savDir: d.dir,
      name: NAME,
    });
    assertEquals(d.entries(), ["Dezaemon 2 (Japan).bcr", "backup"]);
  } finally {
    await d.clean();
  }
});

Deno.test("installCartSave keeps the cart it merged into", async () => {
  const before = cartOf([{ slot: 4, comment: "neighbour", size: 4096 }]);
  const d = await savDir({ cart: before });
  try {
    const was = await Deno.readFile(d.bcrPath);
    const install = await installCartSave(savWithLevel("foo", 3000), {
      savDir: d.dir,
      name: NAME,
    });
    assert(install.backupPath, "the cart it changed is kept");
    assertEquals(await Deno.readFile(install.backupPath!), was);
    assertEquals(basename(join(install.backupPath!, "..")), "backup");
    assert(
      basename(install.backupPath!).startsWith(`${NAME}.`) &&
        install.backupPath!.endsWith(".bcr"),
      install.backupPath!,
    );
  } finally {
    await d.clean();
  }
});

Deno.test("a first install makes the save directory and backs nothing up", async () => {
  // Not created: resolveMednafen() builds savDir by joining paths and never
  // asks whether it is there, so the route's first run on a fresh machine
  // reaches installCartSave with nothing on disk under it.
  const d = await savDir({ create: false });
  try {
    const install = await installCartSave(savWithLevel("foo", 3000), {
      savDir: d.dir,
      name: NAME,
    });
    assertEquals(install.backupPath, null, "there was nothing to back up");
    assertEquals(install.kept, 0);
    assertEquals(d.entries(), ["Dezaemon 2 (Japan).bcr"]);
    assertEquals((await d.saves()).length, 1);
  } finally {
    await d.clean();
  }
});

Deno.test("the same level built again lands back in its own slot, not another copy", async () => {
  const d = await savDir({
    cart: cartOf([
      { slot: 1, comment: "other", size: 2048 },
      { slot: 2, comment: "foo", size: 5000, tag: "old foo" },
    ]),
  });
  try {
    const install = await installCartSave(savWithLevel("foo", 3000), {
      savDir: d.dir,
      name: NAME,
    });
    assertEquals(
      install.slot,
      2,
      "the slot whose comment is already this level",
    );
    assertEquals(install.replaced, true);
    const after = await d.saves();
    assertEquals(after.length, 2, "no third copy of the same level");
    assertEquals(
      after.find((g) => g.filename === "DEZA2____02")?.payload?.buffer,
      markerPayload("foo", 3000),
    );
    assertEquals(
      after.find((g) => g.filename === "DEZA2____01")?.payload?.buffer,
      markerPayload("other", 2048),
    );
  } finally {
    await d.clean();
  }
});

Deno.test("a save that is not a Dezaemon 2 .sav is refused before the cart is touched", async () => {
  const before = cartOf([{ slot: 4, comment: "neighbour", size: 4096 }]);
  const d = await savDir({ cart: before });
  try {
    const was = await Deno.readFile(d.bcrPath);
    // Exactly the 557,056 logical bytes a built .sav has, and not a save: a
    // size check alone waves this through, which is how the code this replaced
    // came to write it over the cart.
    await assertRejects(
      () =>
        installCartSave(
          new Uint8Array(INTERNAL_PARTITION_SIZE + CART_PARTITION_SIZE),
          {
            savDir: d.dir,
            name: NAME,
          },
        ),
      MednafenError,
      "is not a Dezaemon 2 .sav",
    );
    assertEquals(await Deno.readFile(d.bcrPath), was, "the cart was written");
    assertEquals(d.entries(), ["Dezaemon 2 (Japan).bcr"], "no backup/ either");
  } finally {
    await d.clean();
  }
});

Deno.test("installCartSave refuses a cart holding a save it cannot read", async () => {
  const before = damage(
    cartOf([{ slot: 4, comment: "neighbour", size: 4096 }]),
    "DEZA2____04",
  );
  const d = await savDir({ cart: before });
  try {
    const was = await Deno.readFile(d.bcrPath);
    await assertRejects(
      () =>
        installCartSave(savWithLevel("foo", 3000), {
          savDir: d.dir,
          name: NAME,
        }),
      MednafenError,
      "cannot be read",
    );
    assertEquals(await Deno.readFile(d.bcrPath), was);
  } finally {
    await d.clean();
  }
});

Deno.test("a full cart is refused rather than one of its five slots picked", async () => {
  const d = await savDir({
    cart: cartOf([1, 2, 3, 4, 5].map((slot) => ({
      slot,
      comment: `keep ${slot}`,
      size: 2048,
    }))),
  });
  try {
    const was = await Deno.readFile(d.bcrPath);
    const e = await assertRejects(
      () =>
        installCartSave(savWithLevel("foo", 3000), {
          savDir: d.dir,
          name: NAME,
        }),
      MednafenError,
      "slots are in use",
    );
    // Not sav:inject's --slot: sav:run has no such flag, and on macOS
    // sav:inject writes OpenEmu's cart, not this one.
    assert(
      !e.message.includes("sav:inject") && !e.message.includes("--slot"),
      `advice this caller's user cannot follow: ${e.message}`,
    );
    assertEquals(await Deno.readFile(d.bcrPath), was);
  } finally {
    await d.clean();
  }
});

Deno.test("installCartSave writes the un-hashed name sav:run's Mednafen opens, and nothing else", async () => {
  const d = await savDir({
    cart: cartOf([{ slot: 4, comment: "neighbour", size: 4096 }]),
  });
  try {
    // The same disc under Mednafen's other, MD5-hashed save name — what a
    // launcher that does not pass -filesys.fname_sav leaves behind. sav:run
    // forces the un-hashed name, so this file must come back untouched.
    const hashed = join(d.dir, `${NAME}.c35796654a4f523d460609299a5d2a6d.bcr`);
    const other = await gzip(
      cartOf([{ slot: 2, comment: "elsewhere", size: 800 }]),
    );
    await Deno.writeFile(hashed, other);

    const install = await installCartSave(savWithLevel("foo", 3000), {
      savDir: d.dir,
      name: NAME,
    });
    assertEquals(
      await Deno.readFile(hashed),
      other,
      "the cart under Mednafen's other name was written",
    );
    assertEquals(
      install.note,
      null,
      "the cart Mednafen opens is right here: nothing to explain",
    );
  } finally {
    await d.clean();
  }
});

Deno.test("installCartSave says nothing unless a caller asks for the report", async () => {
  const d = await savDir();
  try {
    const lines: string[] = [];
    await installCartSave(savWithLevel("foo", 3000), {
      savDir: d.dir,
      name: NAME,
    }, { log: (l) => lines.push(l) });
    assert(
      lines.some((l) => l.startsWith("slot     : 1  DEZA2____01")),
      lines.join("\n"),
    );
    assert(
      lines.some((l) => l.includes("Mednafen")),
      "the closing line names the emulator this side launches",
    );

    // ...and with no log, nothing at all. POST /api/saturn-save calls this
    // inside a request handler, where a report on stdout is a library talking
    // over the server's own log.
    const said: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => said.push(a.map(String).join(" "));
    try {
      await installCartSave(savWithLevel("foo", 3000), {
        savDir: d.dir,
        name: NAME,
      });
    } finally {
      console.log = real;
    }
    assertEquals(
      said,
      [],
      "a library an HTTP route calls must not write to stdout",
    );
  } finally {
    await d.clean();
  }
});

Deno.test("a save directory holding only the hashed cart is said out loud", async () => {
  // What a machine looks like when Mednafen has only ever been started by a
  // launcher that does not pass -filesys.fname_sav (and what OpenEmu's save
  // directory always looks like): the user's real cart is under the MD5 name,
  // so sav:run's merge writes a SECOND cart. Nothing is lost, but the LOAD
  // screen is about to show one save where they have three.
  const theirs = cartOf([
    { slot: 1, comment: "MY GAME", size: 40000 },
    { slot: 2, comment: "ANOTHER", size: 30000 },
    { slot: 3, comment: "THIRD", size: 20000 },
  ]);
  const d = await savDir({ hashedCart: theirs });
  try {
    const was = await Deno.readFile(d.hashedPath);
    const lines: string[] = [];
    const install = await installCartSave(savWithLevel("foo", 3000), {
      savDir: d.dir,
      name: NAME,
    }, { log: (l) => lines.push(l) });

    assert(install.note, "the other cart has to be mentioned");
    assert(
      install.note!.includes("c35796654a4f523d460609299a5d2a6d.bcr"),
      install.note!,
    );
    assert(
      lines.some((l) => l.startsWith("note     :")),
      `the report has to carry it too:\n${lines.join("\n")}`,
    );
    assertEquals(install.kept, 0, "the cart written is a new one");
    assertEquals(
      await Deno.readFile(d.hashedPath),
      was,
      "their real cart was written",
    );
    assertEquals(
      (await d.saves()).map((g) => g.filename),
      ["DEZA2____01"],
    );
  } finally {
    await d.clean();
  }
});

Deno.test("resolveMednafen reports what is missing instead of failing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mednafen-res-" });
  try {
    const disc = join(dir, "Dezaemon 2 (Japan).cue");
    await Deno.writeTextFile(disc, 'FILE "x.bin" BINARY\n');
    const savDirPath = join(dir, "sav");

    const noBin = await resolveMednafen({
      bin: join(dir, "no-such-mednafen.exe"),
      disc,
      savDir: savDirPath,
    });
    assertEquals(noBin.available, false);
    assert(noBin.reason?.includes("could not find"), noBin.reason ?? "");
    assertEquals(noBin.disc, disc);
    assertEquals(noBin.name, "Dezaemon 2 (Japan)");
    assertEquals(noBin.savDir, savDirPath);

    const bin = join(dir, "mednafen.exe");
    await Deno.writeFile(bin, new Uint8Array(0));
    const ok = await resolveMednafen({ bin, disc, savDir: savDirPath });
    assertEquals(ok.available, true);
    assertEquals(ok.reason, null);

    const noDisc = await resolveMednafen({
      bin,
      disc: join(dir, "missing.cue"),
      savDir: savDirPath,
    });
    // Only when nothing else supplies a disc: the env and the home probe may.
    if (!noDisc.available) assertEquals(noDisc.reason, NO_DISC_MESSAGE);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
