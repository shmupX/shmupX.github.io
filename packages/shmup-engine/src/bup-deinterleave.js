// Saturn backup-RAM cartridge dumps store data with 0xFF in every even byte
// (the high half of each 16-bit word is unused by the backup memory chip).
// Internal-RAM dumps from emulators are usually already de-interleaved.
//
// detect() returns true if the buffer looks interleaved. Decision rule:
//   - file length is even
//   - of the first 256 bytes, >=95% of even-indexed bytes are 0xFF
//
// deinterleave() returns a new Uint8Array containing just the odd bytes.
//
// Environment-neutral ESM: runs in Node and browsers unchanged.

export function detect(buf) {
    if (buf.length < 64 || (buf.length & 1) !== 0) return false;
    const probe = Math.min(256, buf.length);
    let ffCount = 0;
    let evens = 0;
    for (let i = 0; i < probe; i += 2) {
        evens++;
        if (buf[i] === 0xff) ffCount++;
    }
    return (ffCount / evens) >= 0.95;
}

export function deinterleave(buf) {
    if (!detect(buf)) return Uint8Array.prototype.slice.call(buf);
    const out = new Uint8Array(buf.length >>> 1);
    for (let i = 0, j = 1; j < buf.length; i++, j += 2) out[i] = buf[j];
    return out;
}
