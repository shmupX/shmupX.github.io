// scripts/inject-cart.ts — the merge behind `deno task sav:inject`, and the
// two pieces of per-platform logic that only Windows would otherwise reach.
//
// The merge is exercised for real: a cart with a neighbouring save is written
// to a temp dir, a level is merged into a slot, and the result is read back —
// the neighbour byte for byte, the backup, and the refusal to touch anything
// else. The routing (scripts/sav-inject.ts) is checked without spawning, and
// the Linux leg is driven end to end against a fake $HOME, which covers its
// discovery glob and its two-cart-names rule. Only the emulators themselves are
// out of reach: nothing in CI has one, or a disc.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  injectCart,
  InjectError,
  parseInjectArgs,
} from "../scripts/inject-cart.ts";
import {
  chooseCart,
  isHashed,
  mednafenBase,
  probeBases,
} from "../scripts/inject-mednafen-win.ts";
import { legFor, unsupportedMessage } from "../scripts/sav-inject.ts";
import { normalize, parse } from "../packages/shmup-engine/mod.js";
import { cartWith, gzip, markerPayload } from "./support/cart_fixtures.ts";

Deno.test("injectCart merges into a free slot and leaves the neighbour alone", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bcr = join(dir, "Dezaemon 2 (Japan).bcr");
    const before = cartWith(4, "neighbour", 4096);
    await Deno.writeFile(bcr, await gzip(before));
    // The .bkr must never be written: it holds DEZA2___SYS.
    const bkr = join(dir, "Dezaemon 2 (Japan).bkr");
    await Deno.writeFile(bkr, new Uint8Array([1, 2, 3, 4]));
    await Deno.writeFile(join(dir, "level.sav"), cartWith(1, "foo", 3000));

    const lines: string[] = [];
    const r = await injectCart({
      sav: join(dir, "level.sav"),
      cart: bcr,
      emulator: "Mednafen",
      log: (l) => lines.push(l),
    });
    assertEquals(r.slot, 1);
    assertEquals(r.filename, "DEZA2____01");
    assertEquals(r.comment, "foo");
    assertEquals(r.kept, 1);
    assert(r.backup, "the cart it replaced is kept");

    const after = parse((await normalize(await Deno.readFile(bcr))).data);
    assertEquals(after.length, 2);
    const mine = after.find((g) => g.filename === "DEZA2____01");
    assertEquals(mine?.comment, "foo");
    assertEquals(mine?.datasize, 3000);
    const neighbour = after.find((g) => g.filename === "DEZA2____04");
    assertEquals(neighbour?.payload?.buffer, markerPayload("neighbour", 4096));
    assertEquals(await Deno.readFile(bkr), new Uint8Array([1, 2, 3, 4]));
    assert(
      lines.some((l) =>
        l.startsWith("load it  : start Dezaemon 2 in Mednafen")
      ),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("injectCart --dry-run writes nothing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bcr = join(dir, "c.bcr");
    const packed = await gzip(cartWith(4, "neighbour", 4096));
    await Deno.writeFile(bcr, packed);
    await Deno.writeFile(join(dir, "level.sav"), cartWith(1, "foo", 3000));
    const r = await injectCart({
      sav: join(dir, "level.sav"),
      cart: bcr,
      slot: "2",
      dryRun: true,
      log: () => {},
    });
    assertEquals(r.slot, 2);
    assertEquals(await Deno.readFile(bcr), packed);
    assertEquals([...Deno.readDirSync(dir)].length, 2, "no backup/ either");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("injectCart refuses a .sav that is not one", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeFile(join(dir, "bad.sav"), new Uint8Array(64));
    await assertRejects(
      () =>
        injectCart({
          sav: join(dir, "bad.sav"),
          cart: join(dir, "c.bcr"),
          log: () => {},
        }),
      InjectError,
      "is not a Dezaemon 2 .sav",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseInjectArgs: the same grammar the shell leg implements", () => {
  const a = parseInjectArgs([
    "foo",
    "--slot",
    "3",
    "--dry-run",
    "--palette",
    "snes",
  ]);
  assertEquals(a.slot, "3");
  assertEquals(a.dryRun, true);
  assertEquals(a.rest, ["foo", "--palette", "snes"]);

  assertEquals(parseInjectArgs(["--cart=/x/y.bcr"]).cart, "/x/y.bcr");
  assertEquals(parseInjectArgs(["--no-launch"]).launch, false);
  assertEquals(parseInjectArgs(["--launch"]).launch, true);
  assertEquals(parseInjectArgs([]).launch, null);
  // Everything after -- is build:sav's, even when it looks like one of ours.
  assertEquals(parseInjectArgs(["--", "--force", "--slot", "9"]).rest, [
    "--force",
    "--slot",
    "9",
  ]);
  assertEquals(parseInjectArgs(["--", "--force"]).force, false);

  assertThrows(
    () => parseInjectArgs(["--slot", "9"]),
    InjectError,
    "must be 1-5",
  );
  assertThrows(
    () => parseInjectArgs(["--slot"]),
    InjectError,
    "needs a number",
  );
  assertThrows(
    () => parseInjectArgs(["--out", "x"]),
    InjectError,
    "belongs to build:sav",
  );
  assertThrows(
    () => parseInjectArgs(["--sav", "x.sav", "foo"]),
    InjectError,
    "nothing is built",
  );
});

Deno.test("chooseCart follows Mednafen's own two-pass save name", () => {
  const dir = "C:\\saturn\\mednafen\\sav";
  assertEquals(
    chooseCart(["Dezaemon 2 (Japan).bcr", "Dezaemon 2 (Japan).bkr"], dir),
    { stem: "Dezaemon 2 (Japan)", note: null },
  );
  // The cart itself is absent until the game first saves; the .bkr names it.
  assertEquals(
    chooseCart(["Dezaemon 2 (Japan).bkr"], dir).stem,
    "Dezaemon 2 (Japan)",
  );
  assertEquals(
    chooseCart(["Dezaemon 2 (Japan).c35796654a4f523d460609299a5d2a6d.bcr"], dir)
      .stem,
    "Dezaemon 2 (Japan).c35796654a4f523d460609299a5d2a6d",
  );
  // Both names, one disc: Mednafen opens the un-hashed one when it exists.
  const both = chooseCart([
    "Dezaemon 2 (Japan).bcr",
    "Dezaemon 2 (Japan).c35796654a4f523d460609299a5d2a6d.bcr",
  ], dir);
  assertEquals(both.stem, "Dezaemon 2 (Japan)");
  assert(both.note?.includes("un-hashed"));
  // Two discs is a question only the person can answer.
  assertThrows(
    () => chooseCart(["Dezaemon 2 (Japan).bcr", "Dezaemon 2 (USA).bcr"], dir),
    InjectError,
    "cannot tell which disc",
  );
  assertThrows(
    () => chooseCart(["Baroque (Japan).bcr"], dir),
    InjectError,
    "no Dezaemon 2 save",
  );
  // The un-hashed stem wins only when it is the stem with the CART on it. Here
  // it is a bare .bkr and the cart is under the hashed name: choosing the plain
  // one would create a second .bcr from a blank partition, which Mednafen would
  // then read in place of the real cart, orphaning every save on it.
  assertEquals(
    chooseCart([
      "Dezaemon 2 (Japan).bkr",
      "Dezaemon 2 (Japan).c35796654a4f523d460609299a5d2a6d.bcr",
      "Dezaemon 2 (Japan).c35796654a4f523d460609299a5d2a6d.bkr",
    ], dir),
    { stem: "Dezaemon 2 (Japan).c35796654a4f523d460609299a5d2a6d", note: null },
  );
  // ...and with no .bcr anywhere, the .bkr pair decides, un-hashed first —
  // nothing can be orphaned, because there is no cart yet.
  assertEquals(
    chooseCart([
      "Dezaemon 2 (Japan).bkr",
      "Dezaemon 2 (Japan).c35796654a4f523d460609299a5d2a6d.bkr",
    ], dir).stem,
    "Dezaemon 2 (Japan)",
  );

  assert(isHashed("Dezaemon 2 (Japan).c35796654a4f523d460609299a5d2a6d"));
  assert(!isHashed("Dezaemon 2 (Japan)"));
  assert(!isHashed("Dezaemon 2 (Japan).notahash"));
});

Deno.test("probeBases looks in OneDrive too, and never twice", () => {
  const env: Record<string, string> = {
    USERPROFILE: "C:\\Users\\dan",
    OneDrive: "C:\\Users\\dan\\OneDrive",
  };
  // join() writes the host's separator, so match on the parts, not the shape.
  const dirs = probeBases((k) => env[k] ?? "", "C:\\repo\\shmupX");
  assert(
    dirs[0].endsWith("Desktop"),
    `the Desktop is looked in first, got ${dirs[0]}`,
  );
  assert(dirs.some((d) => d.endsWith("saturn")));
  assert(dirs.some((d) => d.includes("OneDrive") && d.endsWith("Desktop")));
  assert(dirs.includes("C:\\repo\\shmupX"));
  assertEquals(new Set(dirs).size, dirs.length);
});

Deno.test("mednafenBase follows Mednafen's documented rule, %HOME% included", () => {
  const at = (e: Record<string, string>) => (k: string) => e[k] ?? "";
  // The usual Windows session: neither variable set, so the exe's own folder.
  assertEquals(mednafenBase(at({}), "C:\\dez\\mednafen"), "C:\\dez\\mednafen");
  // Git Bash / MSYS2 / Cygwin set HOME, and then Mednafen reads ~/.mednafen —
  // NOT the folder beside mednafen.exe. Writing the wrong one of those puts the
  // level on a cart the LOAD screen never shows.
  assert(
    mednafenBase(at({ HOME: "/c/Users/dan" }), "C:\\dez\\mednafen").endsWith(
      ".mednafen",
    ),
  );
  // MEDNAFEN_HOME is applied last by the documentation, so it wins over HOME.
  assertEquals(
    mednafenBase(at({ HOME: "/c/Users/dan", MEDNAFEN_HOME: "/opt/med" })),
    "/opt/med",
  );
});

Deno.test("sav:inject routes to one leg per platform", () => {
  assertEquals(legFor("darwin", "/S", "/D"), {
    cmd: "sh",
    args: ["/S/inject-openemu.sh"],
    script: "/S/inject-openemu.sh",
  });
  assertEquals(legFor("linux", "/S", "/D"), {
    cmd: "sh",
    args: ["/S/inject-mednafen.sh"],
    script: "/S/inject-mednafen.sh",
  });
  // Windows runs the leg with the deno already running, never one off PATH.
  const win = legFor("windows", "/S", "/D/deno.exe");
  assertEquals(win?.cmd, "/D/deno.exe");
  assertEquals(win?.args, ["run", "-A", "/S/inject-mednafen-win.ts"]);
  assertEquals(legFor("freebsd", "/S", "/D"), null);

  // The message an OS with no leg gets has to name a leg that would work there.
  const msg = unsupportedMessage("freebsd");
  assert(msg.includes("freebsd"));
  assert(
    msg.includes("scripts/inject-mednafen.sh"),
    "nothing in the Linux leg is Linux-specific, so say so",
  );
  assert(msg.includes("--cart"));
});

// The Linux leg, for real: discovery by glob, the un-hashed cart preferred when
// both of Mednafen's names are there, the merge, and the .bkr left alone. Run
// under a fake $HOME so nothing outside the temp dir is touched. `sh` is what
// scripts/sav-inject.ts spawns; Windows has no sh and does not run this leg.
Deno.test({
  name: "the Linux leg finds the cart under a fake $HOME and merges into it",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const home = await Deno.makeTempDir();
    try {
      const sav = join(home, ".mednafen", "sav");
      await Deno.mkdir(sav, { recursive: true });
      const cart = await gzip(cartWith(3, "NEIGHBOUR", 4096));
      // Both of Mednafen's names for one disc. The un-hashed one is the live
      // cart; the hashed one must come back byte-identical.
      const hashed = join(
        sav,
        "Dezaemon 2 (Japan).c35796654a4f523d460609299a5d2a6d.bcr",
      );
      await Deno.writeFile(join(sav, "Dezaemon 2 (Japan).bcr"), cart);
      await Deno.writeFile(hashed, cart);
      const bkr = join(sav, "Dezaemon 2 (Japan).bkr");
      await Deno.writeFile(bkr, new Uint8Array([9, 9, 9, 9]));
      const level = join(home, "level.sav");
      await Deno.writeFile(level, cartWith(1, "foo", 3000));

      const leg = new URL("../scripts/inject-mednafen.sh", import.meta.url);
      const { code, stdout } = await new Deno.Command("sh", {
        args: [
          leg.pathname,
          "--sav",
          level,
          "--no-launch",
        ],
        // Deno.Command MERGES env with this process's, and the leg reads
        // MEDNAFEN_SAV and MEDNAFEN_HOME before $HOME/.mednafen/sav — which is
        // exactly what the script tells WSL users to export. Blank them, or a
        // developer who has one set watches this test merge a level into their
        // own live cart. The script's guards are [ -n "${VAR:-}" ], so "" is
        // as good as unset.
        env: {
          HOME: home,
          MEDNAFEN_SAV: "",
          MEDNAFEN_HOME: "",
          MEDNAFEN_BIN: "",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(stdout);
      assertEquals(code, 0, out);
      // Slot 1 is the top row of the LOAD screen, and the whole point.
      assert(
        out.includes('slot     : 1  DEZA2____01  "foo"'),
        `wrong slot line in:\n${out}`,
      );
      assert(
        out.includes("un-hashed name"),
        `both names are there, so say which was written:\n${out}`,
      );

      const after = parse(
        (await normalize(
          await Deno.readFile(join(sav, "Dezaemon 2 (Japan).bcr")),
        ))
          .data,
      );
      assertEquals(after.length, 2);
      assertEquals(
        after.find((g) => g.filename === "DEZA2____01")?.comment,
        "foo",
      );
      // The neighbour, the other name, and the .bkr are all untouched.
      assertEquals(
        after.find((g) => g.filename === "DEZA2____03")?.payload?.buffer,
        markerPayload("NEIGHBOUR", 4096),
      );
      assertEquals(await Deno.readFile(hashed), cart);
      assertEquals(await Deno.readFile(bkr), new Uint8Array([9, 9, 9, 9]));
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  },
});
