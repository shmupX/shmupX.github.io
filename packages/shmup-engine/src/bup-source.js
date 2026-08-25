// Container-format normalizer: turns whatever shape the user hands us into a
// raw Saturn BUP byte image that `bup-parse.js` can walk.
//
// Three wrappings observed in the wild:
//   - gzip: Mednafen / OpenEmu writes the Saturn cart as a gzip stream of the
//     raw 512KB image (file ends in .bcr). Magic 0x1f 0x8b at byte 0.
//   - 0xFF-interleaved: full hardware-style cart dumps with every even byte
//     set to 0xFF (the unused high half of each backup-RAM word). 1MB on disk,
//     512KB logical.
//   - raw: 32KB internal-RAM dumps (.bkr) and already-unwrapped cart images.
//
// Environment-neutral ESM: gunzip uses DecompressionStream, which exists as a
// global in both browsers and Node >= 18 — which is why normalize() is async.

import { detect as detectInterleave, deinterleave } from "./bup-deinterleave.js";

export function isGzip(buf) {
    return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

export async function gunzip(buf) {
    const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Returns { kind, data } where data is the raw BUP bytes as a Uint8Array.
export async function normalize(buf) {
    if (isGzip(buf)) return { kind: "gzip", data: await gunzip(buf) };
    if (detectInterleave(buf)) return { kind: "interleaved", data: deinterleave(buf) };
    return { kind: "raw", data: Uint8Array.prototype.slice.call(buf) };
}
