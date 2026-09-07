// The GIF decoder behind `deno task build:sav`'s title logos: the editor
// stores a logo as whatever the user dropped in, and foo.json's is a GIF.

import { assert, assertStrictEquals } from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { decodeGif, isGif } from "../lib/ps2/gif.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

function dataUrlBytes(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

Deno.test("decodeGif reads foo's 256x91 logo with its transparent backdrop", async () => {
  const foo = JSON.parse(
    await Deno.readTextFile(
      join(ROOT, "static", "games", "2028-ai", "foo.json"),
    ),
  );
  assert(/^data:image\/gif/.test(foo.logoDataURL));
  const bytes = dataUrlBytes(foo.logoDataURL);
  assert(isGif(bytes));
  const img = decodeGif(bytes);
  assertStrictEquals(img.width, 256);
  assertStrictEquals(img.height, 91);
  let opaque = 0, transparent = 0;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i]) opaque++;
    else transparent++;
  }
  assert(opaque > 10000, `the numerals are painted (${opaque} px)`);
  assert(transparent > 1000, `the backdrop is transparent (${transparent} px)`);
  // the top-left corner is backdrop, the middle of the first digit is not
  assertStrictEquals(img.data[3], 0);
  assertStrictEquals(img.data[(45 * 256 + 20) * 4 + 3], 255);
});

Deno.test("decodeGif handles the 1x1 transparent GIF and rejects non-GIFs", () => {
  const bytes = dataUrlBytes(
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  );
  const img = decodeGif(bytes);
  assertStrictEquals(img.width, 1);
  assertStrictEquals(img.height, 1);
  assertStrictEquals(img.data[3], 0);
  assert(!isGif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])));
});
