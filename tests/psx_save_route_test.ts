// /api/psx-save and lib/psx-mednafen.ts: a Dezaemon Kids! card into
// Mednafen's slot 1. The card installer runs against a temporary save
// directory; the route's decoder is held to the one shape a card has; the
// GET answers "local only" on Deploy without looking at the disk.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import { encodeBase64 } from "@std/encoding/base64";
import {
  biosCandidates,
  discBaseName,
  firmwareDirFor,
  installPsxCard,
  MednafenError,
  PSX_CARD_SIZE,
  psxLaunchArgs,
  slotCardName,
} from "../lib/psx-mednafen.ts";
import { decodeCardField, gameOf, handler } from "../routes/api/psx-save.ts";
import { buildMemoryCard } from "../packages/shmup-engine/src/psx/memcard-write.js";

function card(seed = 1): Uint8Array {
  const data = new Uint8Array(0x1e000);
  for (let i = 0; i < data.length; i++) data[i] = (i * seed) & 0xff;
  return buildMemoryCard([{ filename: "BISLPS-01503DEZAKIDS", data }]);
}

Deno.test("names: the card is <disc base>.0.mcr beside the firmware folder", () => {
  assertStrictEquals(
    discBaseName("/x/Dezaemon Kids! (Japan)/Dezaemon Kids! (Japan).cue"),
    "Dezaemon Kids! (Japan)",
  );
  assertStrictEquals(
    slotCardName("Dezaemon Kids! (Japan)"),
    "Dezaemon Kids! (Japan).0.mcr",
  );
  assertStrictEquals(slotCardName("x", 1), "x.1.mcr");
  assertStrictEquals(
    firmwareDirFor("/home/me/.mednafen/sav"),
    "/home/me/.mednafen/firmware",
  );
  // the BIOS: the firmware folder first, then the checkout's dev-fixtures
  const cands = biosCandidates("/m/firmware", "/repo");
  assertStrictEquals(cands[0], "/m/firmware/scph5500.bin");
  assert(cands.includes("/repo/dev-fixtures/bios/scph5500.bin"));
  // a copy outside the firmware folder rides the launch as -psx.bios_jp
  const bios = { dir: "/m/firmware", file: "scph5500.bin" };
  assertEquals(psxLaunchArgs({ ...bios, path: null }), []);
  assertEquals(
    psxLaunchArgs({ ...bios, path: "/m/firmware/scph5500.bin" }),
    [],
  );
  assertEquals(
    psxLaunchArgs({ ...bios, path: "/repo/dev-fixtures/bios/scph5500.bin" }),
    ["-psx.bios_jp", "/repo/dev-fixtures/bios/scph5500.bin"],
  );
});

Deno.test("installPsxCard writes slot 1, backs up what was there, and refuses what is not a card", async () => {
  const dir = await Deno.makeTempDir({ prefix: "psx-save-" });
  try {
    const savDir = join(dir, "sav");
    const first = card(1);
    const a = await installPsxCard(first, { savDir, name: "Kids" });
    assertStrictEquals(a.cardPath, join(savDir, "Kids.0.mcr"));
    assertStrictEquals(a.backupPath, null);
    assertStrictEquals(a.replaced, false);
    assertEquals(await Deno.readFile(a.cardPath), first);

    const second = card(3);
    const b = await installPsxCard(second, { savDir, name: "Kids" });
    assertStrictEquals(b.replaced, true);
    assert(
      b.backupPath &&
        b.backupPath.startsWith(join(savDir, "backup", "Kids.0.")),
    );
    assertEquals(
      await Deno.readFile(b.backupPath!),
      first,
      "the backup is the card that was there",
    );
    assertEquals(await Deno.readFile(b.cardPath), second);

    let refused = false;
    try {
      await installPsxCard(new Uint8Array(100), { savDir, name: "Kids" });
    } catch (e) {
      refused = e instanceof MednafenError;
    }
    assert(refused, "a 100-byte card is refused as a MednafenError");
    assertEquals(
      await Deno.readFile(b.cardPath),
      second,
      "and the slot is untouched",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('decodeCardField: base64, 131,072 bytes, "MC"', () => {
  const ok = decodeCardField(encodeBase64(card()));
  assert("bytes" in ok && ok.bytes.length === PSX_CARD_SIZE);
  assert("error" in decodeCardField(""));
  assert("error" in decodeCardField("not base64!!"));
  const short = decodeCardField(encodeBase64(new Uint8Array(0x1e000)));
  assert("error" in short && /131072/.test(short.error));
  const notMc = decodeCardField(encodeBase64(new Uint8Array(PSX_CARD_SIZE)));
  assert("error" in notMc && /MC/.test(notMc.error));
});

Deno.test("GET /api/psx-save on Deploy says local only without touching the disk", async () => {
  Deno.env.set("DENO_DEPLOYMENT_ID", "test");
  try {
    const req = new Request("http://localhost/api/psx-save");
    // deno-lint-ignore no-explicit-any
    const res = await (handler as any).GET({ req });
    assertStrictEquals(res.status, 200);
    const body = await res.json();
    assertStrictEquals(body.available, false);
    assertStrictEquals(body.reason, "local only");
  } finally {
    Deno.env.delete("DENO_DEPLOYMENT_ID");
  }
});

Deno.test("gameOf: kids by default, plus by name, anything else refused", () => {
  assertStrictEquals(gameOf(undefined), "kids");
  assertStrictEquals(gameOf(null), "kids");
  assertStrictEquals(gameOf(""), "kids");
  assertStrictEquals(gameOf("kids"), "kids");
  assertStrictEquals(gameOf("plus"), "plus");
  assertStrictEquals(gameOf("PLUS"), "plus");
  assertStrictEquals(gameOf("saturn"), null);
  assertStrictEquals(gameOf(7), null);
});

Deno.test("POST /api/psx-save refuses an unknown game before decoding the card", async () => {
  const req = new Request("http://localhost/api/psx-save", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ card: encodeBase64(card()), game: "saturn" }),
  });
  // deno-lint-ignore no-explicit-any
  const res = await (handler as any).POST({ req });
  assertStrictEquals(res.status, 400);
  const body = await res.json();
  assertStrictEquals(body.ok, false);
  assert(/kids|plus/.test(body.error));
});

Deno.test("POST /api/psx-save refuses a body that is not a card before looking for Mednafen", async () => {
  const req = new Request("http://localhost/api/psx-save", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ card: encodeBase64(new Uint8Array(10)) }),
  });
  // deno-lint-ignore no-explicit-any
  const res = await (handler as any).POST({ req });
  assertStrictEquals(res.status, 400);
  const body = await res.json();
  assertStrictEquals(body.ok, false);
  assert(/131072/.test(body.error));
});
