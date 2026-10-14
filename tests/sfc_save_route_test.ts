// /api/sfc-save and lib/sfc-mednafen.ts: the Super Famicom save as Mednafen's
// SRAM for the Dezaemon cart. The install and the field decoder run on
// synthetic images; nothing here needs the ROM or Mednafen.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import { encodeBase64 } from "@std/encoding/base64";
import {
  installSfcSram,
  MednafenError,
  romBaseName,
  SFC_SRAM_SIZE,
  sramFileName,
} from "../lib/sfc-mednafen.ts";
import { decodeSramField, handler } from "../routes/api/sfc-save.ts";
import {
  CHECK_STRING,
  CHECK_STRING_OFFSET,
} from "../packages/shmup-engine/src/sfc/sram.js";

function image(seed = 1): Uint8Array {
  const bytes = new Uint8Array(SFC_SRAM_SIZE);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * seed) & 0xff;
  for (let i = 0; i < CHECK_STRING.length; i++) {
    bytes[CHECK_STRING_OFFSET + i] = CHECK_STRING.charCodeAt(i);
  }
  return bytes;
}

Deno.test("names: the save is <rom base>.srm", () => {
  assertStrictEquals(
    romBaseName("/x/SNES Dezaemon/Dezaemon (EN).sfc"),
    "Dezaemon (EN)",
  );
  assertStrictEquals(sramFileName("Dezaemon (EN)"), "Dezaemon (EN).srm");
});

Deno.test("installSfcSram writes the save, backs up what was there, and refuses what is not one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sfc-save-" });
  try {
    const savDir = join(dir, "sav");
    const first = image(1);
    const a = await installSfcSram(first, { savDir, name: "Deza" });
    assertStrictEquals(a.sramPath, join(savDir, "Deza.srm"));
    assertStrictEquals(a.backupPath, null);
    assertStrictEquals(a.replaced, false);
    assertEquals(await Deno.readFile(a.sramPath), first);

    const second = image(3);
    const b = await installSfcSram(second, { savDir, name: "Deza" });
    assertStrictEquals(b.replaced, true);
    assert(
      b.backupPath && b.backupPath.startsWith(join(savDir, "backup", "Deza.")),
    );
    assertEquals(await Deno.readFile(b.backupPath!), first);
    assertEquals(await Deno.readFile(b.sramPath), second);

    for (const bad of [new Uint8Array(100), new Uint8Array(SFC_SRAM_SIZE)]) {
      let refused = false;
      try {
        await installSfcSram(bad, { savDir, name: "Deza" });
      } catch (e) {
        refused = e instanceof MednafenError;
      }
      assert(refused, `${bad.length} bytes refused as a MednafenError`);
    }
    assertEquals(
      await Deno.readFile(b.sramPath),
      second,
      "the slot is untouched",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('decodeSramField: base64, 131,072 bytes, "T.TABATA"', () => {
  const ok = decodeSramField(encodeBase64(image()));
  assert("bytes" in ok && ok.bytes.length === SFC_SRAM_SIZE);
  assert("error" in decodeSramField(""));
  assert("error" in decodeSramField("not base64!!"));
  const short = decodeSramField(encodeBase64(new Uint8Array(0x10000)));
  assert("error" in short && /131072/.test(short.error));
  const noMagic = decodeSramField(encodeBase64(new Uint8Array(SFC_SRAM_SIZE)));
  assert("error" in noMagic && /T\.TABATA/.test(noMagic.error));
});

Deno.test("GET /api/sfc-save on Deploy says local only without touching the disk", async () => {
  const prev = Deno.env.get("DENO_DEPLOYMENT_ID");
  Deno.env.set("DENO_DEPLOYMENT_ID", "test");
  try {
    const req = new Request("http://localhost/api/sfc-save");
    // deno-lint-ignore no-explicit-any
    const res = await (handler as any).GET({ req });
    const body = await res.json();
    assertStrictEquals(body.available, false);
    assertStrictEquals(body.reason, "local only");
  } finally {
    if (prev === undefined) Deno.env.delete("DENO_DEPLOYMENT_ID");
    else Deno.env.set("DENO_DEPLOYMENT_ID", prev);
  }
});

Deno.test("POST /api/sfc-save refuses a body that is not a save before looking for Mednafen", async () => {
  const req = new Request("http://localhost/api/sfc-save", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ sram: encodeBase64(new Uint8Array(10)) }),
  });
  // deno-lint-ignore no-explicit-any
  const res = await (handler as any).POST({ req });
  assertStrictEquals(res.status, 400);
  const body = await res.json();
  assertStrictEquals(body.ok, false);
  assert(/131072/.test(body.error));
});
