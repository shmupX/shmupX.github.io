// Steam's binary KeyValues, which is how `shortcuts.vdf` stores the games you
// added yourself.
//
// The launcher's whole story on a handheld is "add it as a non-Steam game"
// (lib/desktop-browser.ts:7 says what that costs it), and doing that by hand is
// six steps in Big Picture with a file picker that hides AppImages. This is the
// half that lets one button do it instead: read the file Steam already has,
// put an entry in it, write it back.
//
// THE FORMAT, which is not documented anywhere by Valve
// A node is a type byte, a NUL-terminated key, then a payload:
//   0x00  a nested map — child nodes, then 0x08 to close it
//   0x01  a string — NUL-terminated UTF-8
//   0x02  an int32 — four bytes, little-endian, SIGNED
// The file is one implicit root map holding a single map called "shortcuts",
// whose children are keyed by their position as a string: "0", "1", "2"… After
// the last child come two 0x08 bytes, one closing "shortcuts" and one closing
// the root. Other type bytes exist in Steam's other KeyValues files (0x03
// float, 0x07 uint64) and shortcuts.vdf does not use them; this refuses them
// rather than guessing, because a half-understood file written back is a file
// that loses somebody's library.
//
// Nothing here touches the disk or knows where Steam is — lib/steam-library.ts
// does that — so every rule above is checked by tests/steam_vdf_test.ts without
// Steam being installed.

/** A value in a binary KeyValues tree. */
export type VdfValue = string | number | VdfMap;

/** One map node. Insertion order is preserved, because Steam's is meaningful. */
export interface VdfMap {
  [key: string]: VdfValue;
}

const TYPE_MAP = 0x00;
const TYPE_STRING = 0x01;
const TYPE_INT32 = 0x02;
const TYPE_END = 0x08;

/** A shortcuts.vdf this code will not risk rewriting. */
export class VdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VdfError";
  }
}

// ── reading ─────────────────────────────────────────────────────────────────

class Reader {
  #bytes: Uint8Array;
  #at = 0;
  #decoder = new TextDecoder("utf-8", { fatal: false });

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get done(): boolean {
    return this.#at >= this.#bytes.length;
  }

  byte(): number {
    if (this.done) throw new VdfError("the file ends mid-node");
    return this.#bytes[this.#at++];
  }

  /** Up to the next NUL, which is consumed. */
  string(): string {
    const start = this.#at;
    while (this.#at < this.#bytes.length && this.#bytes[this.#at] !== 0) {
      this.#at++;
    }
    if (this.#at >= this.#bytes.length) {
      throw new VdfError("a string runs off the end of the file");
    }
    const text = this.#decoder.decode(this.#bytes.subarray(start, this.#at));
    this.#at++; // the NUL
    return text;
  }

  int32(): number {
    if (this.#at + 4 > this.#bytes.length) {
      throw new VdfError("an int32 runs off the end of the file");
    }
    const view = new DataView(
      this.#bytes.buffer,
      this.#bytes.byteOffset + this.#at,
      4,
    );
    this.#at += 4;
    return view.getInt32(0, true);
  }
}

function readMap(reader: Reader, depth: number): VdfMap {
  if (depth > 32) throw new VdfError("nested past any shape Steam writes");
  const out: VdfMap = {};
  for (;;) {
    if (reader.done) {
      // The outermost map of a shortcuts.vdf is closed by its own 0x08; a file
      // that simply stops is one Steam would not have written.
      throw new VdfError("the file ends with a map still open");
    }
    const type = reader.byte();
    if (type === TYPE_END) return out;
    const key = reader.string();
    if (type === TYPE_MAP) out[key] = readMap(reader, depth + 1);
    else if (type === TYPE_STRING) out[key] = reader.string();
    else if (type === TYPE_INT32) out[key] = reader.int32();
    else {
      throw new VdfError(
        `type byte 0x${type.toString(16).padStart(2, "0")} is not one of the ` +
          `three shortcuts.vdf uses — refusing to rewrite a file this code ` +
          `does not fully understand`,
      );
    }
  }
}

/**
 * A binary KeyValues file as a tree.
 *
 * An EMPTY file is an empty tree rather than an error: Steam creates
 * shortcuts.vdf lazily, so "no shortcuts yet" and "no file" are the same state
 * and both have to be addable to.
 */
export function parseBinaryVdf(bytes: Uint8Array): VdfMap {
  if (!bytes.length) return {};
  const reader = new Reader(bytes);
  const out: VdfMap = {};
  // The root is a sequence of nodes rather than a map node of its own, and it
  // may or may not carry a closing 0x08 depending on the client that wrote it.
  for (;;) {
    if (reader.done) return out;
    const type = reader.byte();
    if (type === TYPE_END) return out;
    const key = reader.string();
    if (type === TYPE_MAP) out[key] = readMap(reader, 1);
    else if (type === TYPE_STRING) out[key] = reader.string();
    else if (type === TYPE_INT32) out[key] = reader.int32();
    else {
      throw new VdfError(
        `type byte 0x${
          type.toString(16).padStart(2, "0")
        } at the root is not ` +
          `one of the three shortcuts.vdf uses`,
      );
    }
  }
}

// ── writing ─────────────────────────────────────────────────────────────────

function pushString(out: number[], text: string): void {
  for (const byte of new TextEncoder().encode(text)) out.push(byte);
  out.push(0);
}

function pushNode(out: number[], key: string, value: VdfValue): void {
  if (typeof value === "string") {
    out.push(TYPE_STRING);
    pushString(out, key);
    pushString(out, value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new VdfError(`"${key}" is ${value}; this format holds int32 only`);
    }
    out.push(TYPE_INT32);
    pushString(out, key);
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setInt32(0, value | 0, true);
    for (const byte of buf) out.push(byte);
    return;
  }
  out.push(TYPE_MAP);
  pushString(out, key);
  for (const [childKey, childValue] of Object.entries(value)) {
    pushNode(out, childKey, childValue);
  }
  out.push(TYPE_END);
}

/**
 * The tree back to bytes, closed the way Steam closes it.
 *
 * `parseBinaryVdf(writeBinaryVdf(tree))` is `tree` — which is the property that
 * matters, because every write here starts as somebody else's file.
 */
export function writeBinaryVdf(root: VdfMap): Uint8Array {
  const out: number[] = [];
  for (const [key, value] of Object.entries(root)) pushNode(out, key, value);
  out.push(TYPE_END);
  return Uint8Array.from(out);
}
