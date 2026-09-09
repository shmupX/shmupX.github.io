// The Saturn backup images the two merge suites write to a temp directory.
//
// tests/inject_cart_test.ts (`deno task sav:inject`) and
// tests/mednafen_lib_test.ts (installCartSave, behind `deno task sav:run` and
// POST /api/saturn-save) put a level into one slot of the same 512 KB
// cartridge, and both have to prove the same thing afterwards: every other
// save on that cart came back byte for byte, and the .bkr beside it — the
// console's own 32 KB memory, where Dezaemon 2 keeps DEZA2___SYS — was not
// touched at all.
//
// That proof is only worth something if the payloads are discriminating, which
// is what markerPayload() is for: each one opens with its own name in ASCII and
// continues with a fill derived from it, so a save written over its neighbour
// cannot compare equal by accident and a failing diff says which one was lost.

import {
  buildBupImage,
  CART_PARTITION_SIZE,
  formatPartition,
  gameSaveFilename,
  INTERNAL_PARTITION_SIZE,
  placeSaveInPartition,
} from "../../packages/shmup-engine/mod.js";
import {
  CART_BLOCK_SIZE,
  INTERNAL_BLOCK_SIZE,
} from "../../packages/shmup-engine/src/bup-write.js";

/** A payload no other payload can be mistaken for: `[tag]` in ASCII, then a
 * fill seeded from the tag. Two saves of the same size differ everywhere. */
export function markerPayload(tag: string, size: number): Uint8Array {
  const out = new Uint8Array(size);
  const label = new TextEncoder().encode(`[${tag}]`);
  out.set(label.subarray(0, size));
  let h = 0x811c9dc5;
  for (const c of label) h = Math.imul(h ^ c, 0x01000193) >>> 0;
  for (let i = label.length; i < size; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    out[i] = (h >>> 24) & 0xff;
  }
  return out;
}

/** One save on a cart: the slot it sits in, the name the LOAD screen shows,
 * and how many payload bytes it carries. */
export interface CartSave {
  slot: number;
  comment: string;
  size: number;
  /** What markerPayload() seeds from. Default: the comment. */
  tag?: string;
}

/** A 512 KB cart partition holding these saves, as a real cartridge would. */
export function cartOf(saves: CartSave[]): Uint8Array {
  const part = formatPartition(CART_PARTITION_SIZE, CART_BLOCK_SIZE);
  for (const save of saves) {
    placeSaveInPartition(part, CART_BLOCK_SIZE, {
      filename: gameSaveFilename(save.slot),
      comment: save.comment,
      language: 0,
      date: 0,
      payload: markerPayload(save.tag ?? save.comment, save.size),
    });
  }
  return part;
}

/** The one-save case, which is most of them. */
export function cartWith(
  slot: number,
  comment: string,
  size: number,
): Uint8Array {
  return cartOf([{ slot, comment, size }]);
}

/** A built .sav: the 1,114,112-byte MiSTer image `deno task build:sav` writes,
 * one level in the cart partition and an empty internal partition beside it —
 * the empty partition being exactly why the .bkr must never be written from
 * one of these. */
export function savWithLevel(
  comment: string,
  size: number,
  { slot = 1 }: { slot?: number } = {},
): Uint8Array {
  return buildBupImage([{
    filename: gameSaveFilename(slot),
    comment,
    language: 0,
    date: 0,
    payload: markerPayload(comment, size),
  }], { layout: "mister" }).image;
}

/** A .bkr as a played console leaves one: 32 KB of internal memory with
 * Dezaemon 2's own options record on it. Nothing the level pipeline writes
 * ever looks like this — which is the point of comparing against it. */
export function internalRamWith(comment = "OPTIONS"): Uint8Array {
  const part = formatPartition(INTERNAL_PARTITION_SIZE, INTERNAL_BLOCK_SIZE);
  placeSaveInPartition(part, INTERNAL_BLOCK_SIZE, {
    filename: "DEZA2___SYS",
    comment,
    language: 0,
    date: 0,
    payload: markerPayload("DEZA2___SYS", 64),
  });
  return part;
}

/** Break one save's block chain, the way a half-written cart is broken: it
 * claims more data than its blocks hold, so the parser can no longer say which
 * blocks are its own. Returns the same buffer. */
export function damage(cart: Uint8Array, filename: string): Uint8Array {
  const dv = new DataView(cart.buffer, cart.byteOffset, cart.byteLength);
  for (
    let off = CART_BLOCK_SIZE;
    off + 0x22 <= cart.length;
    off += CART_BLOCK_SIZE
  ) {
    if (dv.getUint32(off) !== 0x80000000) continue;
    const name = new TextDecoder().decode(cart.subarray(off + 4, off + 16))
      .replace(/\0.*$/, "");
    if (name === filename) dv.setUint32(off + 0x1e, CART_PARTITION_SIZE);
  }
  return cart;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await new Response(
      new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(
        new CompressionStream("gzip"),
      ),
    ).arrayBuffer(),
  );
}
