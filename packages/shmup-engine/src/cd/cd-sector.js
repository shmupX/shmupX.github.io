// CD-ROM MODE1/2352 sectors: the sync pattern, the BCD header, the EDC and
// the two Reed-Solomon parity blocks (ECC P and Q).
//
// iso9660-read.js only ever reads the 2048 user bytes out of a raw sector and
// skips the rest. Writing a disc image back (iso9660-patch.js, and through it
// the Dezaemon 2 disc injection in write/disc-inject.js) needs the rest too:
// every MODE1 sector carries an error-detection code and error-correction
// parity over its own contents, so a sector whose user data changes has to
// have both recomputed. An emulator that ignores them (yabause) would boot a
// sector with stale ones; a real drive, an optical-drive emulator, a burned
// CD-R or an emulator that checks (Mednafen does: "Uncorrectable error(s) in
// sector N") would report it bad, or "correct" the new bytes back towards the
// old ones.
//
// The retail Dezaemon 2 Track 1 carries a valid EDC and valid P/Q on every one
// of its 3,251 sectors, and buildMode1Sector() rebuilds each of them byte for
// byte from nothing but its LBA and its 2048 user bytes
// (test/cd-sector.test.js holds that on the whole track when the disc is
// present, and on fixed known answers when it is not).
//
// Layout of one 2352-byte MODE1 sector:
//
//   0..11       sync: 00, ten FF, 00
//   12..15      header: minute, second, frame of the FAD (= LBA + 150), BCD;
//               then the mode byte, 01
//   16..2063    the 2048 user bytes
//   2064..2067  EDC: CRC-32 over bytes 0..2063, reflected polynomial
//               0xD8018001, initial value 0, stored little-endian
//   2068..2075  eight zero bytes
//   2076..2247  ECC P: 86 RS(26,24) codewords, 2 parity bytes each, over
//               bytes 12..2075 (the header included)
//   2248..2351  ECC Q: 52 RS(45,43) codewords over bytes 12..2247 (P included)
//
// The parity arithmetic is GF(2^8) over x^8+x^4+x^3+x^2+1 (0x11D), in the
// two-table formulation of Neill Corlett's ECM.
//
// Environment-neutral ESM (Deno + browser).

export const SECTOR_SIZE = 2352;
export const USER_OFFSET = 16;
export const USER_SIZE = 2048;
/** A sector's FAD (frame address) is its LBA plus the two-second lead-in. */
export const FAD_OFFSET = 150;

const EDC_AT = 2064;
const ECC_P_AT = 2076;
const ECC_Q_AT = 2248;

const EDC_TABLE = new Uint32Array(256);
const ECC_F = new Uint8Array(256);
const ECC_B = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    let e = i;
    for (let k = 0; k < 8; k++) e = (e >>> 1) ^ (e & 1 ? 0xd8018001 : 0);
    EDC_TABLE[i] = e >>> 0;
    const f = ((i << 1) ^ (i & 0x80 ? 0x11d : 0)) & 0xff;
    ECC_F[i] = f;
    ECC_B[i ^ f] = i;
}

/** The CD-ROM EDC of `bytes[start..end)`. */
export function cdEdc(bytes, start = 0, end = bytes.length) {
    let crc = 0;
    for (let i = start; i < end; i++) {
        crc = (crc >>> 8) ^ EDC_TABLE[(crc ^ bytes[i]) & 0xff];
    }
    return crc >>> 0;
}

// One parity block. The codewords run diagonally through the 2064 bytes from
// the header on (P down the columns, Q along the diagonals), which is all the
// major/minor stepping below expresses.
function eccBlock(sector, majorCount, minorCount, majorMult, minorInc, dest) {
    const size = majorCount * minorCount;
    for (let major = 0; major < majorCount; major++) {
        let index = (major >> 1) * majorMult + (major & 1);
        let a = 0;
        let b = 0;
        for (let minor = 0; minor < minorCount; minor++) {
            const t = sector[12 + index];
            index += minorInc;
            if (index >= size) index -= size;
            a ^= t;
            b ^= t;
            a = ECC_F[a];
        }
        a = ECC_B[ECC_F[a] ^ b];
        sector[dest + major] = a;
        sector[dest + major + majorCount] = a ^ b;
    }
}

const bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);

/** The BCD minute, second and frame of `lba`'s FAD. */
export function msfFromLba(lba) {
    const fad = lba + FAD_OFFSET;
    return [
        bcd(Math.floor(fad / 4500)),
        bcd(Math.floor(fad / 75) % 60),
        bcd(fad % 75),
    ];
}

/**
 * A complete MODE1/2352 sector for `lba` carrying `user` (at most 2048 bytes,
 * zero-padded to 2048). Written into `out` when given — a subarray of a whole
 * image rebuilds that sector in place — and returned.
 */
export function buildMode1Sector(lba, user, out = new Uint8Array(SECTOR_SIZE)) {
    if (!Number.isInteger(lba) || lba < 0) throw new Error(`bad LBA ${lba}`);
    if (user.length > USER_SIZE) {
        throw new Error(`sector ${lba}: ${user.length} bytes of user data, a sector holds ${USER_SIZE}`);
    }
    if (out.length !== SECTOR_SIZE) throw new Error(`a MODE1 sector is ${SECTOR_SIZE} bytes, got ${out.length}`);
    out[0] = 0x00;
    out.fill(0xff, 1, 11);
    out[11] = 0x00;
    out.set(msfFromLba(lba), 12);
    out[15] = 1;
    out.fill(0, USER_OFFSET, USER_OFFSET + USER_SIZE);
    out.set(user, USER_OFFSET);
    const sum = cdEdc(out, 0, EDC_AT);
    out[EDC_AT] = sum & 0xff;
    out[EDC_AT + 1] = (sum >>> 8) & 0xff;
    out[EDC_AT + 2] = (sum >>> 16) & 0xff;
    out[EDC_AT + 3] = sum >>> 24;
    out.fill(0, EDC_AT + 4, ECC_P_AT);
    eccBlock(out, 86, 24, 2, 86, ECC_P_AT);
    eccBlock(out, 52, 43, 86, 88, ECC_Q_AT);
    return out;
}

/** Whether `sector` is exactly the MODE1 sector `lba` would be for its own
 * user bytes: sync, header, EDC, the zero gap and both parity blocks. */
export function isValidMode1Sector(sector, lba) {
    if (sector.length !== SECTOR_SIZE) return false;
    const again = buildMode1Sector(lba, sector.subarray(USER_OFFSET, USER_OFFSET + USER_SIZE));
    for (let i = 0; i < SECTOR_SIZE; i++) if (again[i] !== sector[i]) return false;
    return true;
}
