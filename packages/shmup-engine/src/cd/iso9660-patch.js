// Replace one file on an ISO 9660 data track — the writing counterpart of
// iso9660-read.js for exactly one job: swapping a file's bytes on a mastered
// disc without re-mastering it.
//
// The image is never rebuilt from a file list (that is the PS2 export's
// writer, packages/shmup-harbor/lib/ps2/iso9660.ts). Everything a console
// game might depend on stays where the master put it: the system area, the
// volume descriptors, every other file's sectors and position, the directory's
// order. Only three things change:
//
//   - the file's sectors: the new bytes, zero-padded to the end of the
//     extent's allocation the way a master leaves a file's slack
//   - its directory record: the data length (and, when it moved, the extent),
//     both copies of each, since ISO 9660 stores every number little-endian
//     then big-endian and readers differ in which one they trust (SEGA's GFS
//     takes the big-endian copy, most PC tools the little-endian one)
//   - when it moved, the volume space size in the primary volume descriptor
//
// In place first: a file may grow into the slack up to the next extent on the
// disc (in the master's layout, the next file). When it does not fit there,
// it is appended after the last extent of the volume, the track grows by the
// sectors it needs, a postgap of empty sectors is kept behind it (a data track
// followed by an audio track ends in 150 of them, 2 s, on every master), and
// its old allocation is cleared. A disc whose other tracks each live in their
// own file (a .cue with one FILE per track) needs nothing else for that. The
// image handed in must be the data track alone: one that runs on into audio
// tracks in the same .bin would have them shifted, and its cue's INDEX times
// wrong, so a caller has to cut the data track out first (the disc injector
// refuses such a rip instead).
//
// Every sector it writes on a raw MODE1/2352 image gets a fresh EDC and ECC
// (cd-sector.js); a cooked 2048-byte image has neither. MODE2 images are
// refused: none of the discs this repo patches is one.
//
// Environment-neutral ESM (Deno + browser). Takes and returns Uint8Array; the
// input image is never modified.

import { openDisc } from "./iso9660-read.js";
import { buildMode1Sector, SECTOR_SIZE, USER_OFFSET, USER_SIZE } from "./cd-sector.js";

const PVD_LBA = 16;
/** The root directory record inside the PVD. */
const PVD_ROOT_RECORD = 156;
/** The volume space size inside the PVD, both-endian. */
const PVD_VOLUME_SPACE = 80;
/** Empty sectors kept after the data on a track that grows. */
export const DEFAULT_POSTGAP = 150;

const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** Write `value` as an ISO 9660 both-endian u32 (LE then BE) at `at`. */
export function setBoth32(bytes, at, value) {
    bytes[at] = value & 0xff;
    bytes[at + 1] = (value >>> 8) & 0xff;
    bytes[at + 2] = (value >>> 16) & 0xff;
    bytes[at + 3] = value >>> 24;
    bytes[at + 4] = value >>> 24;
    bytes[at + 5] = (value >>> 16) & 0xff;
    bytes[at + 6] = (value >>> 8) & 0xff;
    bytes[at + 7] = value & 0xff;
}

/** The sector accessors for one image's geometry, or a refusal. */
function geometryOf(image) {
    const disc = openDisc(image);
    if (!disc) throw new Error("no ISO 9660 volume in this image");
    const { sectorSize, dataOffset } = disc;
    if (sectorSize === SECTOR_SIZE && dataOffset === USER_OFFSET) {
        return {
            kind: "MODE1/2352",
            sectorSize,
            user: (img, lba) => img.slice(lba * SECTOR_SIZE + USER_OFFSET, lba * SECTOR_SIZE + USER_OFFSET + USER_SIZE),
            write: (img, lba, user) =>
                buildMode1Sector(lba, user, img.subarray(lba * SECTOR_SIZE, (lba + 1) * SECTOR_SIZE)),
        };
    }
    if (sectorSize === USER_SIZE && dataOffset === 0) {
        return {
            kind: "MODE1/2048",
            sectorSize,
            user: (img, lba) => img.slice(lba * USER_SIZE, (lba + 1) * USER_SIZE),
            write: (img, lba, user) => {
                img.fill(0, lba * USER_SIZE, (lba + 1) * USER_SIZE);
                img.set(user, lba * USER_SIZE);
            },
        };
    }
    throw new Error(`${sectorSize}-byte sectors with user data at +${dataOffset}: only MODE1 images can be patched`);
}

/**
 * Every directory record on the volume, the root's first, each with where it
 * sits (`dirLba`, `offset` into that sector) so it can be rewritten. `path` is
 * the record's '/'-joined bare name (the ";1" version suffix cut), `name` the
 * name as stored.
 */
export function directoryRecords(image) {
    const geo = geometryOf(image);
    const pvd = geo.user(image, PVD_LBA);
    if (pvd[0] !== 1 || String.fromCharCode(...pvd.subarray(1, 6)) !== "CD001") {
        throw new Error(`no primary volume descriptor at LBA ${PVD_LBA}`);
    }
    const out = [];
    const seen = new Set();
    const walk = (lba, size, prefix) => {
        if (seen.has(lba)) return;
        seen.add(lba);
        for (let s = 0; s < Math.ceil(size / USER_SIZE); s++) {
            const sector = geo.user(image, lba + s);
            // Records never straddle a sector: a zero length byte is padding
            // to the end of this one.
            for (let off = 0; off < USER_SIZE && sector[off] !== 0; off += sector[off]) {
                const nameLength = sector[off + 32];
                const raw = sector.subarray(off + 33, off + 33 + nameLength);
                if (nameLength === 1 && raw[0] < 2) continue; // "." and ".."
                const name = String.fromCharCode(...raw);
                const record = {
                    name,
                    path: prefix + name.split(";")[0],
                    dirLba: lba + s,
                    offset: off,
                    extent: le32(sector, off + 2),
                    size: le32(sector, off + 10),
                    isDir: (sector[off + 25] & 0x02) !== 0,
                };
                if (be32(sector, off + 6) !== record.extent || be32(sector, off + 14) !== record.size) {
                    throw new Error(`${record.path}: its little- and big-endian fields disagree`);
                }
                out.push(record);
                if (record.isDir) walk(record.extent, record.size, record.path + "/");
            }
        }
    };
    walk(le32(pvd, PVD_ROOT_RECORD + 2), le32(pvd, PVD_ROOT_RECORD + 10), "");
    return out;
}

const sectorsFor = (bytes) => Math.ceil(bytes / USER_SIZE);

/** The LBA of the volume descriptor set terminator (type 255), the last
 * sector of the set that starts with the PVD at 16; nothing a file owns may
 * lie at or before it. */
function descriptorSetEnd(geo, image, count) {
    for (let lba = PVD_LBA; lba < Math.min(count, PVD_LBA + 64); lba++) {
        const d = geo.user(image, lba);
        if (String.fromCharCode(...d.subarray(1, 6)) !== "CD001") break;
        if (d[0] === 255) return lba;
    }
    return PVD_LBA;
}

/**
 * Replace the file at `path` ("SGM_INIT.CMP", or "DIR/FILE.BIN") with `data`.
 *
 * Returns {image, record, placement: "in-place" | "relocated", extent,
 * allocation (sectors the file may fill where it was), grownBy (sectors added
 * to the track), touched (every LBA rewritten, ascending)}.
 *
 * `relocate: false` turns a file that does not fit where it is into an error
 * instead of a move. `postgap` is the run of empty sectors kept after the data
 * when the track grows.
 */
export function replaceFile(image, path, data, { relocate = true, postgap = DEFAULT_POSTGAP } = {}) {
    const geo = geometryOf(image);
    const count = Math.floor(image.length / geo.sectorSize);
    const records = directoryRecords(image);
    const want = String(path).split("/").filter(Boolean).join("/").toUpperCase();
    const record = records.find((r) => r.path.toUpperCase() === want);
    if (!record) throw new Error(`${path}: no such file on the disc`);
    if (record.isDir) throw new Error(`${path} is a directory`);

    // The extent's allocation runs to the next extent anything else on the
    // volume starts at — another file, a directory, or the path tables and the
    // root. A file with no bytes owns no sectors (a master gives it the next
    // file's extent, or 0), and neither does one whose extent another record
    // shares (a master that stores two identical files once): either is moved
    // rather than written over what really lives there.
    const pvd = geo.user(image, PVD_LBA);
    const terminator = descriptorSetEnd(geo, image, count);
    if (record.size > 0 && record.extent <= terminator) {
        throw new Error(`${path}: its extent, LBA ${record.extent}, lies in the volume descriptors`);
    }
    // Only records that own sectors bound anything: an empty file's extent is
    // borrowed (often the very next file's), so it neither ends a neighbour's
    // allocation nor marks where the volume's data stops.
    const owners = records.filter((r) => r.isDir || r.size > 0);
    const starts = owners.filter((r) => r !== record).map((r) => r.extent);
    // Path tables: type L (and its optional copy) little-endian at +140/+144,
    // type M (and its copy) big-endian at +148/+152.
    starts.push(le32(pvd, 140), le32(pvd, 144), be32(pvd, 148), be32(pvd, 152), le32(pvd, PVD_ROOT_RECORD + 2));
    const ends = owners.map((r) => r.extent + sectorsFor(r.size));
    const lastEnd = Math.max(...ends, le32(pvd, PVD_ROOT_RECORD + 2) + sectorsFor(le32(pvd, PVD_ROOT_RECORD + 10)));
    if (lastEnd > count) {
        throw new Error(
            `the directory names sectors up to ${lastEnd} and the image has ${count}: is this the whole data track?`,
        );
    }
    const later = starts.filter((e) => e >= record.extent);
    const allocation = record.size === 0 ? 0 : (later.length ? Math.min(...later) : lastEnd) - record.extent;
    const needed = Math.max(1, sectorsFor(data.length));
    const slice = (i) => data.subarray(i * USER_SIZE, (i + 1) * USER_SIZE);
    const empty = new Uint8Array(0);
    const touched = new Set();

    let out;
    let extent = record.extent;
    let grownBy = 0;
    let placement = "in-place";
    if (needed <= allocation) {
        out = image.slice();
        for (let i = 0; i < allocation; i++) {
            geo.write(out, extent + i, i < needed ? slice(i) : empty);
            touched.add(extent + i);
        }
    } else {
        if (!relocate) {
            throw new Error(
                `${path}: ${data.length} bytes need ${needed} sectors and the file has ${allocation} where it is`,
            );
        }
        // Past the last extent is the track's tail. It has to be empty, or
        // something the directory does not name lives there.
        for (let lba = lastEnd; lba < count; lba++) {
            if (geo.user(image, lba).some((b) => b !== 0)) {
                throw new Error(`sector ${lba}, past the last file, holds data the directory does not name`);
            }
        }
        extent = lastEnd;
        placement = "relocated";
        const total = Math.max(count, lastEnd + needed + postgap);
        grownBy = total - count;
        out = new Uint8Array(total * geo.sectorSize);
        out.set(image.subarray(0, count * geo.sectorSize));
        for (let lba = lastEnd; lba < total; lba++) {
            const i = lba - extent;
            geo.write(out, lba, i < needed ? slice(i) : empty);
            touched.add(lba);
        }
        for (let i = 0; i < allocation; i++) {
            geo.write(out, record.extent + i, empty);
            touched.add(record.extent + i);
        }
        if (grownBy) {
            const volume = geo.user(out, PVD_LBA);
            setBoth32(volume, PVD_VOLUME_SPACE, le32(volume, PVD_VOLUME_SPACE) + grownBy);
            geo.write(out, PVD_LBA, volume);
            touched.add(PVD_LBA);
        }
    }

    // The record itself.
    const dir = geo.user(out, record.dirLba);
    setBoth32(dir, record.offset + 2, extent);
    setBoth32(dir, record.offset + 10, data.length);
    geo.write(out, record.dirLba, dir);
    touched.add(record.dirLba);

    return {
        image: out,
        record,
        placement,
        extent,
        allocation,
        grownBy,
        touched: [...touched].sort((a, b) => a - b),
    };
}
