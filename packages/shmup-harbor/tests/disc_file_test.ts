// lib/disc-file.ts: opening a disc image at a path the caller named.
//
// tools/deza-disc takes `--disc PATH` for a disc kept outside the dev-fixtures/
// top level — a Redump set in its own folder, where the data track sits beside
// an audio track and a .cue. The images here come from the repo's own ISO 9660
// writer, so no disc is needed.

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { buildIso } from "../lib/ps2/iso9660.ts";
import {
  openDiscImages,
  openDiscImagesIn,
  openDiscPath,
} from "../lib/disc-file.ts";
import { readFile } from "@shmupx/shmup-engine/iso9660-read";

const encoder = new TextEncoder();

function iso(marker: string): Uint8Array {
  return buildIso({
    volumeId: "TESTDISC",
    files: [{ path: "MARK.TXT", data: encoder.encode(marker) }],
    date: new Date("2000-03-04T00:00:00Z"),
  });
}

/** A Redump-shaped folder: data track, audio track, cue. */
async function redumpSet() {
  const dir = await Deno.makeTempDir({ prefix: "disc-file-" });
  await Deno.writeFile(join(dir, "Game (Track 1).bin"), iso("data"));
  await Deno.writeFile(join(dir, "Game (Track 2).bin"), new Uint8Array(65536));
  await Deno.writeTextFile(
    join(dir, "Game.cue"),
    'FILE "Game (Track 1).bin" BINARY\n  TRACK 01 MODE1/2048\n',
  );
  return { dir, done: () => Deno.remove(dir, { recursive: true }) };
}

const mark = (disc: unknown) =>
  new TextDecoder().decode(readFile(disc, "MARK.TXT")!);

Deno.test("openDiscPath on a folder opens the data track and skips the audio", async () => {
  const set = await redumpSet();
  try {
    const images = await openDiscPath(set.dir);
    assertEquals(images.map((i) => i.name), ["Game (Track 1).bin"]);
    assertEquals(mark(images[0].disc), "data");
    assertEquals(
      (await openDiscImagesIn(set.dir)).map((i) => i.name),
      ["Game (Track 1).bin"],
    );
  } finally {
    await set.done();
  }
});

Deno.test("openDiscPath on an image file opens that image", async () => {
  const set = await redumpSet();
  try {
    const images = await openDiscPath(join(set.dir, "Game (Track 1).bin"));
    assertEquals(images.map((i) => i.name), ["Game (Track 1).bin"]);
    assertEquals(mark(images[0].disc), "data");
  } finally {
    await set.done();
  }
});

Deno.test("openDiscPath refuses a path with no disc on it", async () => {
  const set = await redumpSet();
  try {
    await assertRejects(
      () => openDiscPath(join(set.dir, "Game (Track 2).bin")),
      Error,
      "no disc image",
    );
    await assertRejects(
      () => openDiscPath(join(set.dir, "missing.bin")),
      Error,
      "cannot read",
    );
    const empty = join(set.dir, "empty");
    await Deno.mkdir(empty);
    await assertRejects(() => openDiscPath(empty), Error, "no disc image");
  } finally {
    await set.done();
  }
});

Deno.test("openDiscImages still scans only the dev-fixtures/ top level", async () => {
  const root = await Deno.makeTempDir({ prefix: "disc-file-root-" });
  try {
    const nested = join(root, "dev-fixtures", "Saturn", "Game");
    await Deno.mkdir(nested, { recursive: true });
    await Deno.writeFile(join(nested, "Game (Track 1).bin"), iso("nested"));
    assertEquals(await openDiscImages(root), []);
    await Deno.writeFile(join(root, "dev-fixtures", "top.iso"), iso("top"));
    const images = await openDiscImages(root);
    assertEquals(images.map((i) => i.name), ["top.iso"]);
    assertEquals(mark(images[0].disc), "top");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
