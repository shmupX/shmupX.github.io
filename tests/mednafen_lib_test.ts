// lib/mednafen.ts, the parts that do not need a Mednafen: the .sav → .bcr/.bkr
// conversion, the save-directory install (into a temp dir), the argument list
// and the naming. Launching is the CLI's and the route's business and is not
// exercised here — nothing in CI has the emulator, the disc or the BIOS.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  backupFileName,
  baseName,
  installCartSave,
  isWslExe,
  mednafenArgs,
  MednafenError,
  NO_DISC_MESSAGE,
  resolveMednafen,
  toMednafenPair,
} from "../lib/mednafen.ts";
import {
  CART_PARTITION_SIZE,
  interleave,
  INTERNAL_PARTITION_SIZE,
  MISTER_SAV_SIZE,
} from "../packages/shmup-engine/mod.js";

const LOGICAL = INTERNAL_PARTITION_SIZE + CART_PARTITION_SIZE;

/** A logical image whose every byte says where it is, so a mix-up shows. */
function logicalImage(): Uint8Array {
  const out = new Uint8Array(LOGICAL);
  for (let i = 0; i < out.length; i++) out[i] = (i * 7 + (i >>> 12)) & 0xff;
  return out;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
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

Deno.test("toMednafenPair splits the MiSTer image into a gzipped cart and a raw internal RAM", async () => {
  const logical = logicalImage();
  const { bcr, bkr } = await toMednafenPair(interleave(logical));
  assertEquals(bkr, logical.subarray(0, INTERNAL_PARTITION_SIZE));
  assertEquals(bcr[0], 0x1f, "the cart is a gzip stream");
  assertEquals(bcr[1], 0x8b);
  assertEquals(await gunzip(bcr), logical.subarray(INTERNAL_PARTITION_SIZE));
  // The logical bytes themselves are accepted too (normalize() calls them raw).
  assertEquals((await toMednafenPair(logical)).bkr, bkr);
});

Deno.test("a save of the wrong size is refused before anything is written", async () => {
  await assertRejects(
    () => toMednafenPair(new Uint8Array(MISTER_SAV_SIZE - 2)),
    MednafenError,
    "expected 557056",
  );
});

Deno.test("installCartSave writes <name>.bcr/.bkr and backs up the cart it replaces", async () => {
  const savDir = join(
    await Deno.makeTempDir({ prefix: "mednafen-sav-" }),
    "sav",
  );
  const name = "Dezaemon 2 (Japan)";
  try {
    const first = await installCartSave(interleave(logicalImage()), {
      savDir,
      name,
    });
    assertEquals(first.backupPath, null, "nothing to back up the first time");
    assertEquals(first.bcrPath, join(savDir, `${name}.bcr`));
    assertEquals(first.bkrPath, join(savDir, `${name}.bkr`));
    assertEquals(
      (await Deno.stat(first.bkrPath)).size,
      INTERNAL_PARTITION_SIZE,
    );
    assertEquals(first.bkrBytes, INTERNAL_PARTITION_SIZE);
    const firstCart = await Deno.readFile(first.bcrPath);

    const other = logicalImage().map((b) => b ^ 0x55);
    const now = new Date("2026-09-07T13:10:03.754Z");
    const second = await installCartSave(interleave(other), { savDir, name }, {
      now,
    });
    assertEquals(
      second.backupPath,
      join(savDir, "backup", backupFileName(name, now)),
    );
    assertEquals(await Deno.readFile(second.backupPath!), firstCart);
    assertEquals(
      await gunzip(await Deno.readFile(second.bcrPath)),
      other.subarray(INTERNAL_PARTITION_SIZE),
    );
  } finally {
    await Deno.remove(join(savDir, ".."), { recursive: true });
  }
});

Deno.test("resolveMednafen reports what is missing instead of failing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mednafen-res-" });
  try {
    const disc = join(dir, "Dezaemon 2 (Japan).cue");
    await Deno.writeTextFile(disc, 'FILE "x.bin" BINARY\n');
    const savDir = join(dir, "sav");

    const noBin = await resolveMednafen({
      bin: join(dir, "no-such-mednafen.exe"),
      disc,
      savDir,
    });
    assertEquals(noBin.available, false);
    assert(noBin.reason?.includes("could not find"), noBin.reason ?? "");
    assertEquals(noBin.disc, disc);
    assertEquals(noBin.name, "Dezaemon 2 (Japan)");
    assertEquals(noBin.savDir, savDir);

    const bin = join(dir, "mednafen.exe");
    await Deno.writeFile(bin, new Uint8Array(0));
    const ok = await resolveMednafen({ bin, disc, savDir });
    assertEquals(ok.available, true);
    assertEquals(ok.reason, null);

    const noDisc = await resolveMednafen({
      bin,
      disc: join(dir, "missing.cue"),
      savDir,
    });
    // Only when nothing else supplies a disc: the env and the home probe may.
    if (!noDisc.available) assertEquals(noDisc.reason, NO_DISC_MESSAGE);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
