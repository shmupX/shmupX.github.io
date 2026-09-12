// A small ISO 9660 writer, enough to make a PlayStation 2 boot disc.
//
// The console's boot ROM reads SYSTEM.CNF from the root of a plain ISO 9660
// volume and jumps to the ELF it names; AthenaEnv then chdir()s to `cdfs:/`
// and opens its data files through ps2sdk's cdfs driver, which compares names
// case-insensitively and strips the `;1` version suffix. So the image needs no
// Joliet or Rock Ridge extension — uppercase names with a version suffix are
// found by lowercase fopen() paths — and writing it here rather than shelling
// out to mkisofs/xorriso keeps `deno task build:ps2` free of host tooling.

const SECTOR = 2048;
const SYSTEM_AREA_SECTORS = 16;

export interface IsoFile {
  /** Path inside the image, '/'-separated, e.g. "assets/game.json". */
  path: string;
  data: Uint8Array;
}

export interface IsoOptions {
  /** Volume identifier, trimmed to 32 characters. */
  volumeId: string;
  files: IsoFile[];
  /** Fixed timestamp, so the same inputs produce the same image. */
  date?: Date;
}

// ISO 9660 d-characters, plus the '.' and ';' the name grammar adds, and
// lowercase. Anything else is folded to '_' rather than dropped, so two
// different source names cannot silently collapse onto one another.
//
// Level 2 names (up to 30 characters, one dot, a ';1' version suffix) rather
// than 8.3: `game_asset.json` has to survive intact, since that is the name
// the game asks cdfs for.
//
// CASE IS PRESERVED, which strict ECMA-119 does not allow — d-characters are
// upper case only. It is preserved because the name the game asks cdfs for is
// the one that has to be on the disc: the runtime opens `assets/game_ui.png`,
// and an image storing `ASSETS/GAME_UI.PNG` only works if the console's
// filesystem happens to fold case. A working AthenaEnv disc built by
// genisoimage keeps its `assets`, `main.js` and `athena.ini` lowercase in the
// primary descriptor, so this follows it. The boot executable stays upper
// case, as it is on that disc, because SYSTEM.CNF's BOOT2 has to name it
// exactly and that is the one lookup the BIOS makes before anything of ours
// is running.
const MAX_IDENTIFIER = 30;

function mangle(name: string, isDirectory: boolean): string {
  const clean = name.replace(/[^A-Za-z0-9_.]/g, "_");
  if (isDirectory) {
    return clean.replace(/\./g, "_").slice(0, MAX_IDENTIFIER) || "_";
  }
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 ? clean.slice(dot + 1) : "";
  const room = MAX_IDENTIFIER - 2 - (ext ? ext.length + 1 : 0); // ';1' and '.'
  const stem =
    (dot > 0 ? clean.slice(0, dot) : clean).slice(0, Math.max(1, room)) ||
    "_";
  return (ext ? `${stem}.${ext}` : stem) + ";1";
}

function both16(view: DataView, at: number, value: number): void {
  view.setUint16(at, value, true);
  view.setUint16(at + 2, value, false);
}

function both32(view: DataView, at: number, value: number): void {
  view.setUint32(at, value, true);
  view.setUint32(at + 4, value, false);
}

function ascii(
  bytes: Uint8Array,
  at: number,
  text: string,
  length: number,
): void {
  for (let i = 0; i < length; i++) {
    bytes[at + i] = i < text.length ? text.charCodeAt(i) & 0x7f : 0x20;
  }
}

// The 7-byte form used inside directory records.
function recordingDate(bytes: Uint8Array, at: number, date: Date): void {
  bytes[at] = date.getUTCFullYear() - 1900;
  bytes[at + 1] = date.getUTCMonth() + 1;
  bytes[at + 2] = date.getUTCDate();
  bytes[at + 3] = date.getUTCHours();
  bytes[at + 4] = date.getUTCMinutes();
  bytes[at + 5] = date.getUTCSeconds();
  bytes[at + 6] = 0; // GMT
}

// The 17-byte "digits" form used inside the volume descriptor.
//
// `null` writes the ECMA-119 "not specified" value — sixteen ASCII zeros, not
// a zero date. The distinction matters for the expiration field at offset 847:
// all-zeros means the volume never expires, while a real date means it is
// obsolete after that instant. Writing the Unix epoch there, as this did,
// stamps every disc as having expired on 1970-01-01, which a conforming reader
// is entitled to refuse. A disc that genisoimage builds leaves it unspecified.
function volumeDate(bytes: Uint8Array, at: number, date: Date | null): void {
  if (date === null) {
    for (let i = 0; i < 16; i++) bytes[at + i] = 0x30; // '0'
    bytes[at + 16] = 0;
    return;
  }
  const pad = (value: number, width: number) =>
    String(value).padStart(width, "0");
  const text = pad(date.getUTCFullYear(), 4) + pad(date.getUTCMonth() + 1, 2) +
    pad(date.getUTCDate(), 2) + pad(date.getUTCHours(), 2) +
    pad(date.getUTCMinutes(), 2) + pad(date.getUTCSeconds(), 2) + "00";
  for (let i = 0; i < 16; i++) bytes[at + i] = text.charCodeAt(i);
  bytes[at + 16] = 0;
}

interface Node {
  name: string; // mangled identifier
  isDirectory: boolean;
  data?: Uint8Array;
  children: Node[];
  parent: Node | null;
  extent: number;
  length: number;
  /** 1-based index in the path table; directories only. */
  number: number;
}

function newDirectory(name: string, parent: Node | null): Node {
  return {
    name,
    isDirectory: true,
    children: [],
    parent,
    extent: 0,
    length: 0,
    number: 0,
  };
}

function sectorsFor(bytes: number): number {
  return Math.ceil(bytes / SECTOR) || 1;
}

// A directory record. `identifier` is a raw byte for the '.' and '..' entries
// (0x00 / 0x01) and a mangled name otherwise.
function directoryRecordLength(identifier: string | number): number {
  const nameLength = typeof identifier === "number" ? 1 : identifier.length;
  const length = 33 + nameLength;
  return length + (length % 2); // records are padded to an even length
}

function writeDirectoryRecord(
  out: Uint8Array,
  at: number,
  identifier: string | number,
  extent: number,
  length: number,
  isDirectory: boolean,
  date: Date,
): number {
  const size = directoryRecordLength(identifier);
  const view = new DataView(out.buffer, out.byteOffset + at, size);
  out.fill(0, at, at + size);
  out[at] = size;
  both32(view, 2, extent);
  both32(view, 10, length);
  recordingDate(out, at + 18, date);
  out[at + 25] = isDirectory ? 0x02 : 0x00;
  both16(view, 28, 1); // volume sequence number
  if (typeof identifier === "number") {
    out[at + 32] = 1;
    out[at + 33] = identifier;
  } else {
    out[at + 32] = identifier.length;
    for (let i = 0; i < identifier.length; i++) {
      out[at + 33 + i] = identifier.charCodeAt(i);
    }
  }
  return size;
}

// Total bytes a directory's extent occupies. Records may not straddle a sector
// boundary, so a record that would cross one starts the next sector instead.
function directoryExtentSize(node: Node): number {
  let used = directoryRecordLength(0) + directoryRecordLength(1);
  let sectors = 1;
  for (const child of node.children) {
    const size = directoryRecordLength(child.name);
    if (used + size > SECTOR * sectors) {
      sectors++;
      used = SECTOR * (sectors - 1);
    }
    used += size;
  }
  return sectors * SECTOR;
}

/** Build an ISO 9660 image containing `files`. */
export function buildIso(options: IsoOptions): Uint8Array {
  const date = options.date ?? new Date(0);
  const root = newDirectory("", null);

  for (const file of options.files) {
    const parts = file.path.split("/").filter(Boolean);
    const leaf = parts.pop();
    if (!leaf) throw new Error(`iso: empty path in file list`);
    let dir = root;
    for (const part of parts) {
      const name = mangle(part, true);
      let next = dir.children.find((c) => c.isDirectory && c.name === name);
      if (!next) {
        next = newDirectory(name, dir);
        dir.children.push(next);
      }
      dir = next;
    }
    const name = mangle(leaf, false);
    if (dir.children.some((c) => c.name === name)) {
      throw new Error(
        `iso: "${file.path}" collides with another file once shortened to "${name}"`,
      );
    }
    dir.children.push({
      name,
      isDirectory: false,
      data: file.data,
      children: [],
      parent: dir,
      extent: 0,
      length: file.data.length,
      number: 0,
    });
  }

  // ISO 9660 wants directory records in ascending identifier order, and the
  // path table in breadth-first order.
  // Breadth-first, so a directory's path-table number always precedes its
  // children's — which is what the path table requires.
  const directories: Node[] = [];
  const queue: Node[] = [root];
  root.children.sort((
    a,
    b,
  ) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  while (queue.length) {
    const node = queue.shift()!;
    directories.push(node);
    node.number = directories.length;
    for (const child of node.children) {
      if (!child.isDirectory) continue;
      child.children.sort((
        a,
        b,
      ) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      queue.push(child);
    }
  }

  // Path table: one record per directory, root's identifier being a single
  // zero byte.
  let pathTableSize = 0;
  for (const dir of directories) {
    const nameLength = dir.parent === null ? 1 : dir.name.length;
    pathTableSize += 8 + nameLength + (nameLength % 2);
  }

  // Layout: system area, PVD, terminator, both path tables, directory
  // extents, then file data.
  let sector = SYSTEM_AREA_SECTORS;
  const pvdSector = sector++;
  const terminatorSector = sector++;
  const pathTableSectors = sectorsFor(pathTableSize);
  const lPathSector = sector;
  sector += pathTableSectors;
  const mPathSector = sector;
  sector += pathTableSectors;

  for (const dir of directories) {
    dir.length = directoryExtentSize(dir);
    dir.extent = sector;
    sector += dir.length / SECTOR;
  }
  for (const dir of directories) {
    for (const child of dir.children) {
      if (child.isDirectory) continue;
      child.extent = sector;
      sector += sectorsFor(child.length);
    }
  }
  const totalSectors = sector;

  const image = new Uint8Array(totalSectors * SECTOR);

  // --- Primary volume descriptor ---
  const pvd = image.subarray(pvdSector * SECTOR, (pvdSector + 1) * SECTOR);
  const pvdView = new DataView(pvd.buffer, pvd.byteOffset, SECTOR);
  pvd[0] = 1;
  ascii(pvd, 1, "CD001", 5);
  pvd[6] = 1;
  ascii(pvd, 8, "PLAYSTATION", 32);
  ascii(pvd, 40, options.volumeId.toUpperCase().slice(0, 32), 32);
  both32(pvdView, 80, totalSectors);
  both16(pvdView, 120, 1);
  both16(pvdView, 124, 1);
  both16(pvdView, 128, SECTOR);
  both32(pvdView, 132, pathTableSize);
  pvdView.setUint32(140, lPathSector, true);
  pvdView.setUint32(144, 0, true);
  pvdView.setUint32(148, mPathSector, false);
  pvdView.setUint32(152, 0, false);
  writeDirectoryRecord(pvd, 156, 0, root.extent, root.length, true, date);
  ascii(pvd, 190, "", 128); // volume set
  ascii(pvd, 318, "", 128); // publisher
  ascii(pvd, 446, "SHMUPX", 128); // data preparer
  ascii(pvd, 574, "ATHENAENV", 128); // application
  ascii(pvd, 702, "", 37);
  ascii(pvd, 739, "", 37);
  ascii(pvd, 776, "", 37);
  volumeDate(pvd, 813, date);
  volumeDate(pvd, 830, date);
  volumeDate(pvd, 847, null); // never expires
  volumeDate(pvd, 864, date);
  pvd[881] = 1; // file structure version

  // --- Volume descriptor set terminator ---
  const terminator = image.subarray(terminatorSector * SECTOR);
  terminator[0] = 0xff;
  ascii(terminator, 1, "CD001", 5);
  terminator[6] = 1;

  // --- Path tables (little-endian and big-endian copies) ---
  for (
    const [start, littleEndian] of [
      [lPathSector, true],
      [mPathSector, false],
    ] as [number, boolean][]
  ) {
    let at = start * SECTOR;
    for (const dir of directories) {
      const isRoot = dir.parent === null;
      const name = isRoot ? "\0" : dir.name;
      const view = new DataView(image.buffer, at, 8);
      image[at] = name.length;
      image[at + 1] = 0;
      view.setUint32(2, dir.extent, littleEndian);
      view.setUint16(6, isRoot ? 1 : dir.parent!.number, littleEndian);
      for (let i = 0; i < name.length; i++) {
        image[at + 8 + i] = name.charCodeAt(i);
      }
      at += 8 + name.length + (name.length % 2);
    }
  }

  // --- Directory extents ---
  for (const dir of directories) {
    const base = dir.extent * SECTOR;
    let at = base;
    at += writeDirectoryRecord(
      image,
      at,
      0,
      dir.extent,
      dir.length,
      true,
      date,
    );
    const parent = dir.parent ?? dir;
    at += writeDirectoryRecord(
      image,
      at,
      1,
      parent.extent,
      parent.length,
      true,
      date,
    );
    for (const child of dir.children) {
      const size = directoryRecordLength(child.name);
      const sectorEnd = base +
        (Math.floor((at - base) / SECTOR) + 1) * SECTOR;
      if (at + size > sectorEnd) at = sectorEnd;
      at += writeDirectoryRecord(
        image,
        at,
        child.name,
        child.extent,
        child.length,
        child.isDirectory,
        date,
      );
    }
  }

  // --- File data ---
  for (const dir of directories) {
    for (const child of dir.children) {
      if (child.isDirectory || !child.data) continue;
      image.set(child.data, child.extent * SECTOR);
    }
  }

  return image;
}
