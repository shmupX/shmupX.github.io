// packages/shmup-engine/src/bup-deinterleave.js
function detect(buf) {
  if (buf.length < 64 || (buf.length & 1) !== 0) return false;
  const probe = Math.min(256, buf.length);
  let ffCount = 0;
  let evens = 0;
  for (let i = 0; i < probe; i += 2) {
    evens++;
    if (buf[i] === 255) ffCount++;
  }
  return ffCount / evens >= 0.95;
}
function deinterleave(buf) {
  if (!detect(buf)) return Uint8Array.prototype.slice.call(buf);
  const out = new Uint8Array(buf.length >>> 1);
  for (let i = 0, j = 1; j < buf.length; i++, j += 2) out[i] = buf[j];
  return out;
}

// packages/shmup-engine/src/bup-source.js
function isGzip(buf) {
  return buf.length >= 2 && buf[0] === 31 && buf[1] === 139;
}
async function gunzip(buf) {
  const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function normalize(buf) {
  if (isGzip(buf)) return { kind: "gzip", data: await gunzip(buf) };
  if (detect(buf)) return { kind: "interleaved", data: deinterleave(buf) };
  return { kind: "raw", data: Uint8Array.prototype.slice.call(buf) };
}

// packages/shmup-engine/src/bup-parse.js
var MAGIC = new TextEncoder().encode("BackUpRam Format");
var ENTRY_FLAG = 2147483648;
function dataView(data) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
function findBytes(hay, needle, from = 0) {
  const n = needle.length;
  outer: for (let i = from; i + n <= hay.length; i++) {
    if (hay[i] !== needle[0]) continue;
    for (let j = 1; j < n; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
function magicRunStarts(data) {
  const starts = [];
  let idx = findBytes(data, MAGIC, 0);
  let prev = -32;
  while (idx !== -1) {
    if (idx !== prev + 16) starts.push(idx);
    prev = idx;
    idx = findBytes(data, MAGIC, idx + 16);
  }
  return starts;
}
function detectPartitions(data) {
  return magicRunStarts(data).map((base, i, starts) => {
    const end = i + 1 < starts.length ? starts[i + 1] : data.length;
    const size = end - base;
    return { base, size, blockSize: size >= 524288 ? 512 : 64 };
  });
}
function readAscii(data, off, max) {
  let end = off;
  const limit = Math.min(off + max, data.length);
  while (end < limit && data[end] !== 0) end++;
  let s = "";
  for (let i = off; i < end; i++) s += String.fromCharCode(data[i]);
  return s;
}
function decodeComment(data, off, max) {
  let end = off;
  const limit = Math.min(off + max, data.length);
  while (end < limit && data[end] !== 0) end++;
  const bytes = data.subarray(off, end);
  try {
    return new TextDecoder("shift-jis").decode(bytes);
  } catch {
    return readAscii(data, off, max);
  }
}
function parseEntry(data, off) {
  const dv = dataView(data);
  if (dv.getUint32(off) !== ENTRY_FLAG) {
    throw new Error(`no BUP entry flag at 0x${off.toString(16)}`);
  }
  return {
    offset: off,
    filename: readAscii(data, off + 4, 12),
    comment: decodeComment(data, off + 16, 10),
    language: data[off + 26],
    date: data[off + 27] << 16 | data[off + 28] << 8 | data[off + 29],
    datasize: dv.getUint32(off + 30)
  };
}
function bupDateToDate(minutes) {
  const epoch1980 = Date.UTC(1980, 0, 1, 0, 0, 0);
  return new Date(epoch1980 + minutes * 6e4);
}
function makeStream(data, base, blockSize, entryOff, chain) {
  let seg = -1;
  let pos = entryOff + 34;
  let segEnd = entryOff + blockSize;
  return {
    readByte() {
      while (pos >= segEnd) {
        seg++;
        if (seg >= chain.length) {
          throw new Error("save data stream exhausted before datasize bytes were read");
        }
        const n = chain[seg];
        pos = base + n * blockSize + 4;
        segEnd = base + (n + 1) * blockSize;
        if (segEnd > data.length) {
          throw new Error(`block ${n} lies outside the image`);
        }
      }
      return data[pos++];
    },
    tell() {
      return pos;
    }
  };
}
function extractPayload(data, partition, entry) {
  const { base, blockSize } = partition;
  const chain = [];
  const stream = makeStream(data, base, blockSize, entry.offset, chain);
  for (; ; ) {
    const hi = stream.readByte();
    const lo = stream.readByte();
    const v = hi << 8 | lo;
    if (v === 0) break;
    chain.push(v);
  }
  const start = stream.tell();
  const buffer = new Uint8Array(entry.datasize);
  for (let w = 0; w < entry.datasize; w++) buffer[w] = stream.readByte();
  return { start, blocks: chain, buffer };
}
function findEntries(data) {
  const dv = dataView(data);
  const offs = [];
  for (const part of detectPartitions(data)) {
    const numBlocks = Math.floor(part.size / part.blockSize);
    for (let n = 1; n < numBlocks; n++) {
      const off = part.base + n * part.blockSize;
      if (off + 34 > data.length) break;
      if (dv.getUint32(off) !== ENTRY_FLAG) continue;
      const name = readAscii(data, off + 4, 12);
      if (name.length >= 1 && /^[\x20-\x7e]+$/.test(name)) offs.push(off);
    }
  }
  return offs;
}
function parse(data) {
  const partitions = detectPartitions(data);
  if (partitions.length === 0) {
    throw new Error('not a Saturn backup image ("BackUpRam Format" magic not found)');
  }
  const dv = dataView(data);
  const saves = [];
  for (const part of partitions) {
    const numBlocks = Math.floor(part.size / part.blockSize);
    for (let n = 1; n < numBlocks; n++) {
      const off = part.base + n * part.blockSize;
      if (off + 34 > data.length) break;
      if (dv.getUint32(off) !== ENTRY_FLAG) continue;
      const name = readAscii(data, off + 4, 12);
      if (name.length < 1 || !/^[\x20-\x7e]+$/.test(name)) continue;
      const entry = parseEntry(data, off);
      let payload = null;
      let payloadError = null;
      let blocks = [];
      try {
        const extracted = extractPayload(data, part, entry);
        blocks = extracted.blocks;
        payload = { start: extracted.start, buffer: extracted.buffer };
      } catch (err) {
        payloadError = err.message;
      }
      saves.push({
        ...entry,
        blocks,
        partition: { base: part.base, blockSize: part.blockSize },
        payload,
        payloadError
      });
    }
  }
  return saves;
}

// packages/shmup-engine/src/payload-table.js
var TABLE_SIZE = 108;
var SECTION_COUNT = 8;
function byteSum(data, start, end) {
  let s = 0;
  for (let i = start; i < end; i++) s = s + data[i] >>> 0;
  return s;
}
function parseSectionTable(payload, { validate = true } = {}) {
  if (payload.length < TABLE_SIZE) {
    throw new Error(`payload too small for a section table (${payload.length} < ${TABLE_SIZE} bytes)`);
  }
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const table = {
    checksumTotal: dv.getUint32(0),
    tableAddr: dv.getUint32(4),
    endAddr: dv.getUint32(8),
    sections: []
  };
  let offset = TABLE_SIZE;
  for (let i = 0; i < SECTION_COUNT; i++) {
    const p = 12 + i * 12;
    const section = {
      index: i,
      checksum: dv.getUint32(p),
      addr: dv.getUint32(p + 4),
      size: dv.getUint32(p + 8),
      offset
    };
    table.sections.push(section);
    offset += section.size;
  }
  if (validate) validateSectionTable(payload, table);
  return table;
}
function validateSectionTable(payload, table) {
  const { sections } = table;
  const total = sections.reduce((a, s) => a + s.size, TABLE_SIZE);
  if (total !== payload.length) {
    throw new Error(`section sizes + table (${total}) != payload length (${payload.length})`);
  }
  if (sections[0].addr !== table.tableAddr + TABLE_SIZE) {
    throw new Error(
      `section 0 addr 0x${sections[0].addr.toString(16)} != tableAddr+0x6C 0x${(table.tableAddr + TABLE_SIZE).toString(16)}`
    );
  }
  for (let i = 1; i < sections.length; i++) {
    const expected = sections[i - 1].addr + sections[i - 1].size;
    if (sections[i].addr !== expected) {
      throw new Error(
        `section ${i} addr 0x${sections[i].addr.toString(16)} breaks the chain (expected 0x${expected.toString(16)})`
      );
    }
  }
  const last = sections[sections.length - 1];
  if (table.endAddr !== last.addr + last.size) {
    throw new Error(
      `endAddr 0x${table.endAddr.toString(16)} != last section end 0x${(last.addr + last.size).toString(16)}`
    );
  }
  let sum = 0;
  for (const s of sections) {
    const actual = byteSum(payload, s.offset, s.offset + s.size);
    if (actual !== s.checksum) {
      throw new Error(
        `section ${s.index} checksum mismatch: stored 0x${s.checksum.toString(16)}, computed 0x${actual.toString(16)}`
      );
    }
    sum = sum + s.checksum >>> 0;
  }
  if (sum !== table.checksumTotal) {
    throw new Error(
      `checksumTotal 0x${table.checksumTotal.toString(16)} != sum of section checksums 0x${sum.toString(16)}`
    );
  }
}
function isGameSave(entry) {
  return /^DEZA2____\d\d$/.test(entry.filename);
}

// packages/shmup-engine/src/player-art.js
var PLAYER_PALETTE = [
  0,
  1635363583,
  1970106879,
  2034576639,
  2188737023,
  1835099647,
  1296648703,
  1633246719,
  1094466815,
  1498501631,
  1633499391,
  942945535,
  2253205759,
  2593035007,
  2862523135,
  2323481343,
  2525662975,
  1431647487,
  2037729791,
  1009790207,
  1294735615,
  537921791,
  1630806271,
  1159993599,
  402915583,
  201590015,
  1429216511,
  2455583999,
  403440895,
  1765549311,
  403967231,
  404232447,
  2387949823,
  2725071359,
  1160249599,
  672402687,
  3886182911,
  4088290815,
  3750910463,
  1900095743,
  2590328319,
  3619034367,
  4157044223,
  3130157567,
  2187658495,
  1010312447,
  269754623,
  673716479,
  1968768255,
  3417182463,
  4089079295,
  3683010047,
  807674111,
  875309311,
  1161898239,
  606085375,
  538972415,
  67371263,
  740830463,
  2927450623,
  4157832703,
  2524803583,
  1296903423,
  1834832383,
  2188206591,
  2036685311,
  2859815423,
  1699027199,
  1296120063,
  2995151359,
  1430602239,
  1700089343,
  1093939455,
  1768243711,
  1832386815,
  2727779071,
  4087501311,
  4019341823,
  2454257919,
  1496318207,
  2390059519,
  3132274431,
  808459519,
  471078143,
  807145727,
  1565345279,
  673193215,
  202119423,
  202115327,
  538712319,
  606882303,
  67372287,
  255,
  2929100543,
  3063844607,
  3485977599,
  3688356863,
  2997792511,
  201326847,
  3283794687,
  3620721663,
  1770172159,
  1228682495,
  404763903,
  3618803455,
  3614781695,
  4091221247,
  539509247,
  337128703,
  2790326527,
  3479771391,
  1766917375,
  3411870975,
  2185298175,
  874250495,
  2389510399,
  2930158335,
  1008735487,
  2659613183,
  3822837759,
  269226239,
  67637503,
  1904916223,
  2039660287,
  2391430655,
  3197792767,
  2256687615,
  1902986751,
  1432984319,
  2928543999,
  3484320511,
  3686995199,
  3349314047,
  3198292223,
  135279871,
  3059025151,
  134758911,
  671351039,
  4281156607,
  4282606335,
  4284653055,
  4278190335,
  4287606527,
  4289655295,
  3523215615,
  4292935679,
  2919235839,
  4289601535,
  4294938623,
  4291970047,
  4292914943,
  4294955775,
  4052692479,
  4292878335,
  4294967295,
  7077887,
  10878975,
  15728639,
  16764671,
  3892312063,
  3456106751,
  4283564287,
  4285726975,
  4288413951,
  13534463,
  15179007,
  2700144895,
  2425393407,
  3031741695,
  4244438271
];
var PLAYER_FRAMES = [
  { key: "duke_0", w: 31, h: 38, rle: "ABkBAQICABsDAQQBAgEFAQAbBgECAQUBBwEAGwgBCQEHAQoBABsLAQUBAgIMAQAaBgENAQUBBAEOAQAaBgEEAQcBDwEQAQAaEQECAQkBBAESAQAaBwECAQkBBAIAFxMBFAEVAQgBBAICAgAWFgEXARgBGQEJAQIBBwEFAQQBABQaARYBGwEaARwBGAEJAQIBBgEFARABABIaAh0BDAEbARQBHgEfAQUBBAEFAgQBAA8WAR0BAwEgAQwBIQEMASIBIwEAAgIFAAwaAh0BAwEkASUBJgEgAQMBJwEABAIFAAgUARoBFgEnAigBKQEqBCsBFgEABQUBBAECAwAEFgEdAQMBLAEtAR4BLgEvATABMQEqATIEKgEzAR0BLgEAAxECBQECAgADIAEDASEBIAEUATQBLwE1AS4BMAEqATIBKgEyASoBMgIqATYBNwE4AQACAgEKAQkBAgIAAicBLAEgAQMBFAE5AToBCQEFATUBOwE8ATIBKgQyASoBPQEHAT4BJwEAAT8BIQFAAUEBQAEaAQABQgEgAUMBHQEoARcBCwEFAQQBRAEzASoBMgEqATIBKgEyAiUBRQEEAQUBRgEnARYBKAFDAQwBIAEWAQABDAEdAUMBGgEnAggBBQEEAUcBJgEyAyoCJQEyASUBRQECAQUBRgEMAScCRwEbASgBAwEAAR0CRgEWARcBAwEJAQ8BAgFIASYBJQMyASUEQgFJAQQBBwEgAQMBHQFGARsBIQEgAQABGgEdAUgBAwEXAUoBQQFLAQQBLwEoAUwEJQFMAU0BMwFDAQcBEAEHAU4BTwEDAUYBIAEbAQwBFgEaAScBRAEDAhcBUAFRAQ8BUgEUARsBQgEzAzsBIQEMATUBBwFLAVABFAEaAUcBQwEoASEBIAEDAQABIgEdAUQBIAFPAQUBDgEFAS8BFAETAVMCHAFTASMBVAIeAQYBEAFVASMBHQFGAQMBIAEoASwBIAEAAkQBBgE/AQwBVgEGAS8BVwETAUMBSAEUARYBFAFIAUQBUwFYAVkBCAE0ARUBNQETARcBGgEdAUMBJwEABAYBRgFaAVsCXAFZAQYBUAFdAl4BEAEJAVkBXAFbAgsBSAELARkCHAE0AU8BGgEABT4BBAELAQUDEAFfAWABXwFgAWEBDwEFAgkBBgEFAQkBIwFiARkBWQFDARQBFQEABREBYQIEAVEBEAJjAWQBXwFkAWEBDwEQAQ4BAgFgAQQBDAEAAVwBYgEcAVQBWAEABkgBDQECARABDQEPARABXwFkAV8BYAEOAQQBDwEEAksBZQEnAQABIwE5ARkBHgFUAQAGBQELAQ8BYwEHAQUBBAFjAV8BYwFfARABAgEFAg4BAgE+AQwBAAIYAVgBIwEAB0YBCAEJAQcBNQICAVEBYQJRAQIBCQE1AgUBZgELAQAOZwFZAi8CBwEFBTUBLwI3AR8BNwEADx4BWAIeATUGWQEeAi4BIwEAECMBLgFYAR4IWAIjAQARLgFTAVkBHgcuAVMBHgEuAQASLgFYAS4BHwEeBC4BVgEAGS4EUwEADg==" },
  { key: "duke_1", w: 31, h: 48, rle: "ABcCAUEBAgEAHGUBAgFJAQAbZgECAgoBAwEAGgsBBwEJAREBEwEAGhMBBQJJAQAbSAEQAQICDQEAGgkBDQEHAQIBDQEAGgYBAgEJAQICABoHAQIBBgECARIBABoHAUkBBQMAGkYBDwEHAQUBAgEAFh0BFgFUARwBCAEEAQYBBwEPAQAUHQEDASABFAEZARwBBQEEAQcBBQEEAQASAwEgASgBAwEUARcBHAE1AQIFAA8DAQwBIAEbASgBAwEaARcBVAE5AS8BAgUADR0BIAEoASUBMwEgAR0CFAEABAIFAAsdATsBJAElAWgBKwFQARYBFAEABgQBBQECAgUBAAkdAUIBJAEzAWkBIQEoAQwBFwEWASEBGwEMARYBAAMFAQkBBwEFAQIBAAgbASgBVQFIAT8BGwEnARYBFwEoASUBKgNqAUIBAAIFAhEBBgEHAQAHJwElASYBQgEbAS4BHQEMASMBGwEqAjIBJQIyASoBEgFrAWwBLwEDAUYBJwEABicBUAE9AUMBEwFIAVgBFwEMAWYBTAEqAjIFJQEJARoBJwFtASgBGwFuAQAEJwFGAW8BQwFUAVkCLwEXAQwBIAEqATICKgEyBEwBBQFEAScBFgEMAR0BcAEbAQACHQFJAVQBJwEUAVMBLwFmAQUBSAEUAUIBKgEyAioBMgMlASYBAgFmAXEBAwJEAUIBIQEgAQABKAEMARMBFgFcAVQBSAEGAUkBQQFyASYBJQIyBCUCQgECAQcBAwIMAUQBOwFFASEBAAEbAkgBVAEjAR0BRAERAQICFAE7AUwBJQFMAiUBTAJNASgBBQEPAUgBIwEWAUQBIAEhAXMBFAEDAQwBRAE0AXIBGgEWAQIBEAEEAUQBAwFCAUwFJgEhAUQBBQF0AUQBYgFZAUgBFwEdAUMBFAEaARQBFwFmAXUBIwFPAUEBYQEQAQgBFwETARQBHQEwASgBGwEwARcBVwEIAQUBRwFUAS8BNAFUARcBFgEaAQABIgEXARQBRAFPAXUBQwFRAQ8BCwFZAQwBEwFTASMBGQI0AQsBWwEeAVgBCwFGAToBIwEXAUMBAwEWAQACIgEUAUgBVQEWAVQBBQEJAVkBWwETAUcBQQF2AgUBCwIIAQkBBgEQAQkBBgFUARMBDAJUAQADFAEWATYBPwETAVkBHgFcAVsBBgEPAVEBXwJjAQQBBwEFAgkBYQEFAQYBGQFTATQBHgEjAQAFFAFGAQcBLwIFAg8CYQFkAWMBXwFLARADDwIEAQkBCwFcAR4BNQEaAQAGdQEGARABDwJLAQ8BEAEOAWQBXwFkAWEBDwIFAQIBdwECAQQBRgEjAUQBFAEAB1QBIwEFAQ0BCAEQAQ8BEAFLAWQBXwFgAWQBAgEFAQYCBwEJATUBHAEvAVIBAAk6AQkBCAECAWEBBwEFARABYwNfARABBgEIAQsBLwEfARQBAAxZAQUBCAIHATUBCwEFAQ8BBAECAQUBBwELAR4BUwEfASMBAA4fAToBLwQLAQYBCAILATUCHgIfAQAQLgEeAVMBHgJZAS8GWQIuAQARNwEuAXgBHgRZAx4BWQEuAgATHgEuAlMBHgQvAS4CABcfAR4BWQIvATUBeQFbAQAXWwEuAR4CWAE5AWIBWwEAF1sCXARbAQAZWwFcBFsBABlbAVwEABpbAVwEABs5AVgBeAF5AQAbeQF4AS4BeQEAHHkBVwEACw==" },
  { key: "duke_2", w: 31, h: 39, rle: "ABgPAWUBAQEFAQAbBQEEAgkBABsRAQUBCQIAGwoBBQIRAQAbEQEQAQUBCgEAG3oBBAEJAXsBIQEAGnoBBAEHAXsBKAEAGhABBQEGAXwBCQEAGgQBBQIEARsBABUXASMBdQEjAVQBBQECAQUBEgEMAQATHQEgAUMBIwEXARoBNAECAQUBCQF7ASgBABEWAR0BDAEhAQMBdQEXAhQBDwECAQkBewEoAQAPFgEnASABKAEhAUMBNAJTAgkBAgMEASABAA0WAQMBKAEbASYBIQEWARoBAAQMAQQBAgIEAUcBAAoWAR0BAwEgASgBQgEqAX0BRQEMAQAFAwF+AQICBAEHAQAGHQEnAQMBVAEuARsBRQEmASoBMgEqAzwBIAEABFUBSQECAgQBBwEABAMCLAIUAVkBLgFSARsBKgQyAioCFAFYAR4BAAEDAX8BCQEFAQQBBwEAAywBQQEgAhwBUwE1AQgBVgEoASoFMgIqAUABOgFSAQABJwGAAQcBCQECAUcBAAJCAUEBAwJCARQBLwEHAQIBSAGBASoBMgIqAzICKwEFAQcBGgEWAUYBIAFDAVUBAwEAAhsBDAFvARoBKAEgAQsBBQEEAUcBJgEqATIBKgIyAioBMgFFAQQBSQEJAScBTwEMAVUBDAEgAQACDAEdAUcBTwEWASABZgEFAQIBRwFNASUIRQECAkYBJwEDARYBVQEgARsBAwEAAQMCRAEDARcBDAFHAQ8BAgE1ATsBJQVMAiYBIAEFAQQBCQEMAh0BVQEbAiABAAFDAScBRAEMARYCQAFLAQ8BOgEWATsBTQElAUwCJgEzARsBEwEHAQ0BQQEgARoBRAFHAUUBOwEgAQABHQEDAR0BRAEgAXUBUAFjAQ8BNQEUARMBcgETARQDFwETAS8BBwFLAQUBFQEjAUQBQwFCAjABAAIiAQwBRAEbAScBRAEQAQkBHwFEAW8BNQFZASMBUwFUARoBIwFYAQsBAgFIAWIBVAFIARcBHQEMAR0BGgEAAhYBRAFHAT8BLwJYAVsBWQFEAVUBIAEbASgBPwFGAVMBWwFYAVkBNQFUATUBUwEcAVQBFAFPAUMBAARGAQkCWAEvAVkBCAECAVEBYwFRAV8BDgECAQkBLwFZAVgBBgJSAWIBUwETAUMBFgEMAQAFEQEOAQ8CYQEQAmMBZAFfAWABDgEPARABSwEFAQ4BBAFbARUBOQEcARoBIAEnATQBAAUGAWEBSwEEAQ4BDwEQAV8BZAFfAWABYQEPARABBAECAWQBZQFbAQABXAEZAVkBNAFTAR8BAAUGAQUBDwFjAQ8BBAEPAV8BZAFfAWABDgEEAQ8BBAENAQIBfwEAAlwCWwEeARcBIgEABQIBCwEEAUsBCwEJAQIBYwFfAWMBXwEPAQUBCAEGAWEBAgEIAQADOQEjARoBRAEUAQAGLwE3AS8BCwICAUsBDQJLAQIBCAE1AgsBSAEvAQAEHgE4AVQBAAcfAlkCLwEIAQYCCQEGAjUBWQMfAVsBAA9TAVgCHgEvBlkBWAIuAVsCABAuAh4KHwFbAgASHwEeBlMBWQEcATUBLgEAFB8BHgQfAngCHgF5AQAaWwF5AhkBWwEAG1sDAAo=" },
  { key: "duke_3", w: 31, h: 44, rle: "ABhAAQICAwEAGwICfwEMAQAbSQECAUkBCQEAGz4BBQEHAQgBABsRAQIBBAFmAQAbSQEEAQkBEgEAG0sBBAEJAXsBABkUARYBDQEFAQkBEgEAGSMBBgEPAQYCfgEWAQAWFAEaARQBBgEPAQQDGgEAERQBFgEnARYBFwEUARoBFwETAQIBBQM0AQANFwEaAScBDAEgASgBIQFCASABVAEeAkYBEAEJAQcBDwFUAQAIHQEnAQMBDAEgARsBJAGCASUBIQEbASABGwEXAWIBIwFUAWYBAgEHAQkBDwEABycBQQFAAUIBGwEvAT4BgwE8BIQBFgEUARwBAAMCAQUBAgMABSEBVQEMAUICEwEeAVMBKwE8ASoEPAGFATcBZwGGAQACAgR/AQAEQgFBAQMBhwEdAVMBWQE6AUQBKggHAWsBhgE6AgIBBAECAwADAwFCAT8BDAEoAVQBIwEGAQkBKAEqBzwBOwGIAS4BGQEXAQsBCQEFAQICAAMDAQwBRAEWAScBDAE1AUkBAgE7ASoIJQFUAR4BWQEVAQsBBgE1AQcBAgEAAycBHQETAUoBFwEDAWYBAgEEASEBMgEqBjIBJQFVAQYBCwFZAQsBBgELATUBCAEAAycBHQETAQwBGgEnAQcBBAEFAQwBJQEyASUBMgIlATICJgE/AUkBBgETARcCAwEIARYBAAMdAQMBSAEbAQMBGgEEAQ8BBgFUATMBJQZNASgBRgEFAQkBRAEgAScBDAFVAYcBAAREAUgBGwFtAQcBYwENATUBFwEMASEBMwMhARsBQwICAQQBBQEWASgBFgFVAUMBhwEDAQAEZgEnASABBQFLAQUBVgEgAW8BIwEcAhkCUwEcAUgBAgENAQcBIAIXAUYBJwEbAW0BAwEABDYBCQE1AS8BHgJHAkQBFwEUAUgBGgEdARkBNQECAQ4BbwEMARcBBgEbAyABHQEABAYBBQILAQgBBgNAAiEBdgE9ARoBWwFZAQcBQQEXASMBZgFHARsBOwEhAScBFAEABAkBSwEQAQUBDQEPAQIBDgFfAlEBDwEQAQUBWQFYAS8BWQEZAQsBSAEUAScBGwEgARoBFwEABAoBDwFLAmEBDgJfAmQBYQEPAgQBBwELAVgBVgEGAToBGAFTARcBFgIaAUMBFwEAA0kBYQF3AQcBDwFLAQ4BZAFfAWQBSwEQAQ8BEAEOAQcCBQFSAVQCLwEUARoBFwEDAW8BOgEAAwYBBwIJAQUBEAFgAmQCSwEQAwcBBQFLAQsBVAEAARcBLwEgARsBDAEnAVIBNwEAA2cBNwE1AQgBBgEOAXcBXwJjAUsBEAECAQQBDwEGAQcBOAEAAzkBGgEdARoBWQFTARQBAAQfAVMBHgELAQcBBQEEAQ8BEAEFAQkBCwEHAQIBNQEFAS0BAANcARkBWAEeAVkBFAEABSMBHwEeATUBCwIIAgYBCAFZAS8FAAQVATkBVAEWAVIBGgEABR4BWQE3AS8BNQEvAzUBLwEeAlkBUwEfAQAGGAEeAVQBNwEABi4BUwFZAR4BWQQeAngCHgEfAQARWAFnAVoBLwFZAR4FLgEeAQgBABJ4AVwBVwE1AS8BWQIeAS4BHwEVATcBABRcAlsBHgQjAQAXiQFcBAAaeAFcBAAaXARiAQAZiQFcBGIBABl4AVwBUwE3AVwBiQEAGlwBLwFIAVwBABxiAVwCABY=" },
  { key: "bigProjectile_0.png", w: 23, h: 8, rle: "AA6KAosEjAEADo0CiwGMAY4BjwOOAYwBAAuQAo4BiwGMAY4BjwKRAo8BjgGKAZIFkASNAowBjgKPApEFjwGLAZIFkASNAowBjgKPApEFjwGLAQAKkAKOAYsBjAGOAY8CkQKPAY4BigEADI0CiwGMAY4BjwOOAYsBAA+KAosFAAI=" },
  { key: "bigProjectile_1.png", w: 24, h: 12, rle: "ABCSBAASkgKTAZQClQGSAQAPkgOWA5cClAGSAQANkgGYAZMBmQGUAZYBmgOWAZQBkgEACJIEmAGVAZQBlwGWAZoFlwGVAZIHkwOZA5cBlgGaCJQBkgeTA5kDlwGWAZoIlAGSAQAHkgSYAZUBlAGXAZYBmgWXAZUBkgEAC5IBmAGTAZkBlAGWAZoDlgGUAZIBAA2SA5UBlgKXApQBkgEAEJIBlgGTAZQClQGSAQATkgQABA==" },
  { key: "bigProjectile_2.png", w: 29, h: 18, rle: "ABKYAQAblwKYAQAbmAGSAgABkgGTApIBABWSApMClASZAQAUkgGTAZUBlAGXA5QCmQEAEZQBkwGVAZkBlAGXApYDlAKSAQAMkgOYAZUCmQGUAZcBlgKaA5cBlAGVAQAJkgWYAZUCmQGUAZcBlgGaBpYBlAGSBZgDkweZAZQBlwGWAZoIlgGXAZIFmAOTB5kBlAGXAZYBmgiWAZcBAAmSBZgBlQKZAZQBlwGWAZoGlgGUAQAMkgOYAZUCmQGUAZcBlgKaA5cBlAGVAQAQlAGTAZUBmQGUAZcBlgSUApIBABKSAZMBmQGUAZcDlAKZAQATkgKYAZMBlASZAQAUmAGSAgABkgGTApIBABSXApgBABuYAQAK" },
  { key: "bigProjectile_3.png", w: 30, h: 18, rle: "ABOSBAAXkgKXAZIDmQGSBAASkgSVA5YBlQOSAgAOkgSYAZMBlQKZA5YBlQSSAQAHkgKUAZIEmASVApkBlAGXApYClAGWAZUBkgIAC5IDmAKZAZUBlAOXApYDlAGWAZUBkgEACZIGmQKUApcDlgGaA5YBlAGVAZgBAAeYAZMDkgKZA5QDlwKWAZoFlgGUAZgBkgSYApIBlQOYAZkDlAKXA5YBmgiUAZUBkgSYApIBlQOYAZkDlAKXA5YBmgiUAZUBAAeYAZMDkgKZA5QDlwKWAZoFlgGUAZgBAAmSBpkClAOXApYBmgOWAZQBlQGYAQALkgOYApkBlQGUA5cClgKUApYBlQGSAQAGkgKUAZIEmASVApkBlAGWAZQBlwGWAZQBlgGVAZICAAySBJgBkwGVApkDlgGVBJIBABCSBJUDlgGVA5ICABKSApcBkgOZAZIEABaSBAAH" },
  { key: "bigProjectile0.png", w: 14, h: 12, rle: "AASbBgAGmwKcAZ0GnAEAA5sBnAGdAZ4CnwSeAZ0BnAEAAZsBnAGdAZ4BnweeAZ0BnAKdAZ4BnwmeAZwBnQGeAZ8LnQKeAZ8LnQGcAZ0BngGfCZ4BnAGbAZwBnQGeAZ8HngGdAZwBAAGbAZwBnQGeAp8EngGdAZwBAAObApwBnQacAQAGmwYABA==" },
  { key: "bigProjectile1.png", w: 14, h: 12, rle: "AASgBgAGoAKhAqIEoQIAA6ABoQGiAqMGogGhAQABoAGhAaIBowKfBqMBogGhAqIBowGfCaMBoQGiAaMBnwqjAaICowGfCqMBogGhAaIBowGfCaMBoQGgAaEBogGjAp8GowGiAaEBAAGgAaEBogKjBqIBoQEAA6ACoQKiBKECAAagBgAE" },
  { key: "bigProjectile2.png", w: 14, h: 12, rle: "AASkBgAGpAKlAp4EpQGkAQADpAGlAZ4CnwWeAqQBAAGkAaUBngGfCZ4BpAGlAZ4BnwulAZ4BnwyeAp8MngGlAZ4BnwulAaQBpQGeAZ8JngGkAQABpAGlAZ4CnwWeAqQBAAOkAqUCngSlAaQBAAakBgAE" },
  { key: "hadoken0.png", w: 15, h: 9, rle: "ABWmBwAGpgiaAaYBAAOmBZoEpgKaAaYFmgimAZoBpgEAAqYFmgSmApoBpgEABKYImgGmAQAHpgcAEQ==" },
  { key: "hadoken1.png", w: 15, h: 9, rle: "AAemBgAHpgkABKYHmgOmAgABpgeaBqYImgemAQABpgeaBqYBAAOmB5oDpgIABaYJAAimBgAC" },
  { key: "shield0.png", w: 96, h: 96, rle: "ACanFABMpxQARKckADynJAA4pywANKcsADCnNAAspzQAKqc4ACinOAAkpxaoFKcWACCnFqgUpxYAHqcSqCCnEgAcpxKoIKcSABqnEKgopxAAGKcQqCinEAAWpxCoDqcQqA6nEAAUpxCoDqcQqA6nEAAUpwyoDKccqAynDAAUpwyoDKccqAynDAASpwyoCqckqAqnDAAQpwyoCqckqAqnDAAOpwyoCqcoqAqnDAAMpwyoCqcoqAqnDAAMpwyoCKcOqBCnDqgIpwwADKcMqAinDqgQpw6oCKcMAAqnDKgIpwyoGKcMqAinDAAIpwyoCKcMqBinDKgIpwwACKcKqAinCqggpwqoCKcKAAinCqgIpwqoIKcKqAinCgAGpwyoBqcKqCSnCqgGpwwABKcMqAanCqgkpwqoBqcMAASnCqgIpwioDqkMqA6nCKgIpwoABKcKqAinCKgOqQyoDqcIqAinCgAEpwqoBqcKqAqpFKgKpwqoBqcKAASnCqgGpwqoCqkUqAqnCqgGpwoABKcKqAanCKgKqRioCqcIqAanCgAEpwqoBqcIqAqpGKgKpwioBqcKAAKnCqgIpwioCKkcqAinCKgIpxSoCKcIqAipHKgIpwioCKcUqAanCKgKqRyoCqcIqAanFKgGpwioCqkcqAqnCKgGpxSoBqcIqAipIKgIpwioBqcUqAanCKgIqSCoCKcIqAanFKgGpwioCKkgqAinCKgGpxSoBqcIqAipIKgIpwioBqcUqAanCKgIqSCoCKcIqAanFKgGpwioCKkgqAinCKgGpxSoBqcIqAipIKgIpwioBqcUqAanCKgIqSCoCKcIqAanFKgGpwioCKkgqAinCKgGpxSoBqcIqAipIKgIpwioBqcUqAanCKgIqSCoCKcIqAanFKgGpwioCKkgqAinCKgGpxSoBqcIqAqpHKgKpwioBqcUqAanCKgKqRyoCqcIqAanFKgIpwioCKkcqAinCKgIpxSoCKcIqAipHKgIpwioCKcKAAKnCqgGpwioCqkYqAqnCKgGpwoABKcKqAanCKgKqRioCqcIqAanCgAEpwqoBqcKqAqpFKgKpwqoBqcKAASnCqgGpwqoCqkUqAqnCqgGpwoABKcKqAinCKgOqQyoDqcIqAinCgAEpwqoCKcIqA6pDKgOpwioCKcKAASnDKgGpwqoJKcKqAanDAAEpwyoBqcKqCSnCqgGpwwABqcKqAinCqggpwqoCKcKAAinCqgIpwqoIKcKqAinCgAIpwyoCKcMqBinDKgIpwwACKcMqAinDKgYpwyoCKcMAAqnDKgIpw6oEKcOqAinDAAMpwyoCKcOqBCnDqgIpwwADKcMqAqnKKgKpwwADKcMqAqnKKgKpwwADqcMqAqnJKgKpwwAEKcMqAqnJKgKpwwAEqcMqAynHKgMpwwAFKcMqAynHKgMpwwAFKcQqA6nEKgOpxAAFKcQqA6nEKgOpxAAFqcQqCinEAAYpxCoKKcQABqnEqggpxIAHKcSqCCnEgAepxaoFKcWACCnFqgUpxYAJKc4ACinOAAqpzQALKc0ADCnLAA0pywAOKckADynJABEpxQATKcUACY=" },
  { key: "shield1.png", w: 96, h: 96, rle: "ACanFABMpxQARKckADynJAA4pywANKcsADCnNAAspzQAKqc4ACinOAAkpxaoFKcWACCnFqgUpxYAHqcSqCCnEgAcpxKoIKcSABqnEKgopxAAGKcQqCinEAAWpxCoDgAQqA6nEAAUpxCoDgAQqA6nEAAUpwyoDAAcqAynDAAUpwyoDAAcqAynDAASpwyoCgAkqAqnDAAQpwyoCgAkqAqnDAAOpwyoCgAoqAqnDAAMpwyoCgAoqAqnDAAMpwyoCAAsqAinDAAMpwyoCAAsqAinDAAKpwyoCAAwqAinDAAIpwyoCAAwqAinDAAIpwqoCAA0qAinCgAIpwqoCAA0qAinCgAGpwyoBgA4qAanDAAEpwyoBgA4qAanDAAEpwqoCAA4qAinCgAEpwqoCAA4qAinCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgACpwqoCAA8qAinFKgIADyoCKcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoCAA8qAinFKgIADyoCKcKAAKnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgIADioCKcKAASnCqgIADioCKcKAASnDKgGADioBqcMAASnDKgGADioBqcMAAanCqgIADSoCKcKAAinCqgIADSoCKcKAAinDKgIADCoCKcMAAinDKgIADCoCKcMAAqnDKgIACyoCKcMAAynDKgIACyoCKcMAAynDKgKACioCqcMAAynDKgKACioCqcMAA6nDKgKACSoCqcMABCnDKgKACSoCqcMABKnDKgMAByoDKcMABSnDKgMAByoDKcMABSnEKgOABCoDqcQABSnEKgOABCoDqcQABanEKgopxAAGKcQqCinEAAapxKoIKcSABynEqggpxIAHqcWqBSnFgAgpxaoFKcWACSnOAAopzgAKqc0ACynNAAwpywANKcsADinJAA8pyQARKcUAEynFAAm" },
  { key: "shield2.png", w: 96, h: 96, rle: "ACanFABMpxQARKckADynJAA4pywANKcsADCnNAAspzQAKqc4ACinOAAkpxaoFKcWACCnFqgUpxYAHqcSqCCnEgAcpxKoIKcSABqnEKgopxAAGKcQqCinEAAWpxCoDqcQqA6nEAAUpxCoDqcQqA6nEAAUpwyoDKccqAynDAAUpwyoDKccqAynDAASpwyoCqcKqBCnCqgKpwwAEKcMqAqnCqgQpwqoCqcMAA6nDKgKpwaoHKcGqAqnDAAMpwyoCqcGqBynBqgKpwwADKcMqAinBKgKqRCoCqcEqAinDAAMpwyoCKcEqAqpEKgKpwSoCKcMAAqnDKgIpwSoCKkYqAinBKgIpwwACKcMqAinBKgIqRioCKcEqAinDAAIpwqoCKcEqAapIKgGpwSoCKcKAAinCqgIpwSoBqkgqAanBKgIpwoABqcMqAanBKgGqSSoBqcEqAanDAAEpwyoBqcEqAapJKgGpwSoBqcMAASnCqgIpwSoBKkOpwypDqgEpwSoCKcKAASnCqgIpwSoBKkOpwypDqgEpwSoCKcKAASnCqgGpwSoBqkKpxSpCqgGpwSoBqcKAASnCqgGpwSoBqkKpxSpCqgGpwSoBqcKAASnCqgGpwSoBKkKpxipCqgEpwSoBqcKAASnCqgGpwSoBKkKpxipCqgEpwSoBqcKAAKnCqgIpwSoBKkIpxypCKgEpwSoCKcUqAinBKgEqQinHKkIqASnBKgIpxSoBqcEqASpCqccqQqoBKcEqAanFKgGpwSoBKkKpxypCqgEpwSoBqcUqAanBKgEqQinIKkIqASnBKgGpxSoBqcEqASpCKcgqQioBKcEqAanFKgGpwSoBKkIpyCpCKgEpwSoBqcUqAanBKgEqQinIKkIqASnBKgGpxSoBqcEqASpCKcgqQioBKcEqAanFKgGpwSoBKkIpyCpCKgEpwSoBqcUqAanBKgEqQinIKkIqASnBKgGpxSoBqcEqASpCKcgqQioBKcEqAanFKgGpwSoBKkIpyCpCKgEpwSoBqcUqAanBKgEqQinIKkIqASnBKgGpxSoBqcEqASpCKcgqQioBKcEqAanFKgGpwSoBKkIpyCpCKgEpwSoBqcUqAanBKgEqQqnHKkKqASnBKgGpxSoBqcEqASpCqccqQqoBKcEqAanFKgIpwSoBKkIpxypCKgEpwSoCKcUqAinBKgEqQinHKkIqASnBKgIpwoAAqcKqAanBKgEqQqnGKkKqASnBKgGpwoABKcKqAanBKgEqQqnGKkKqASnBKgGpwoABKcKqAanBKgGqQqnFKkKqAanBKgGpwoABKcKqAanBKgGqQqnFKkKqAanBKgGpwoABKcKqAinBKgEqQ6nDKkOqASnBKgIpwoABKcKqAinBKgEqQ6nDKkOqASnBKgIpwoABKcMqAanBKgGqSSoBqcEqAanDAAEpwyoBqcEqAapJKgGpwSoBqcMAAanCqgIpwSoBqkgqAanBKgIpwoACKcKqAinBKgGqSCoBqcEqAinCgAIpwyoCKcEqAipGKgIpwSoCKcMAAinDKgIpwSoCKkYqAinBKgIpwwACqcMqAinBKgKqRCoCqcEqAinDAAMpwyoCKcEqAqpEKgKpwSoCKcMAAynDKgKpwaoHKcGqAqnDAAMpwyoCqcGqBynBqgKpwwADqcMqAqnCqgQpwqoCqcMABCnDKgKpwqoEKcKqAqnDAASpwyoDKccqAynDAAUpwyoDKccqAynDAAUpxCoDqcQqA6nEAAUpxCoDqcQqA6nEAAWpxCoKKcQABinEKgopxAAGqcSqCCnEgAcpxKoIKcSAB6nFqgUpxYAIKcWqBSnFgAkpzgAKKc4ACqnNAAspzQAMKcsADSnLAA4pyQAPKckAESnFABMpxQAJg==" },
  { key: "shield3.png", w: 96, h: 96, rle: "ACanFABMpxQARKckADynJAA4pywANKcsADCnNAAspzQAKqc4ACinOAAkpxaoFKcWACCnFqgUpxYAHqcSqCCnEgAcpxKoIKcSABqnEKgopxAAGKcQqCinEAAWpxCoDgAQqA6nEAAUpxCoDgAQqA6nEAAUpwyoDAAcqAynDAAUpwyoDAAcqAynDAASpwyoCgAkqAqnDAAQpwyoCgAkqAqnDAAOpwyoCgAoqAqnDAAMpwyoCgAoqAqnDAAMpwyoCAAsqAinDAAMpwyoCAAsqAinDAAKpwyoCAAwqAinDAAIpwyoCAAwqAinDAAIpwqoCAA0qAinCgAIpwqoCAA0qAinCgAGpwyoBgA4qAanDAAEpwyoBgA4qAanDAAEpwqoCAA4qAinCgAEpwqoCAA4qAinCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgACpwqoCAA8qAinFKgIADyoCKcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoCAA8qAinFKgIADyoCKcKAAKnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgIADioCKcKAASnCqgIADioCKcKAASnDKgGADioBqcMAASnDKgGADioBqcMAAanCqgIADSoCKcKAAinCqgIADSoCKcKAAinDKgIADCoCKcMAAinDKgIADCoCKcMAAqnDKgIACyoCKcMAAynDKgIACyoCKcMAAynDKgKACioCqcMAAynDKgKACioCqcMAA6nDKgKACSoCqcMABCnDKgKACSoCqcMABKnDKgMAByoDKcMABSnDKgMAByoDKcMABSnEKgOABCoDqcQABSnEKgOABCoDqcQABanEKgopxAAGKcQqCinEAAapxKoIKcSABynEqggpxIAHqcWqBSnFgAgpxaoFKcWACSnOAAopzgAKqc0ACynNAAwpywANKcsADinJAA8pyQARKcUAEynFAAm" },
  { key: "shield4.png", w: 96, h: 96, rle: "ACanFABMpxQARKckADynJAA4pywANKcsADCnNAAspzQAKqc4ACinOAAkpxaoFKcWACCnFqgUpxYAHqcSqCCnEgAcpxKoIKcSABqnEKgopxAAGKcQqCinEAAWpxCoDqcQqA6nEAAUpxCoDqcQqA6nEAAUpwyoDKcGqBCnBqgMpwwAFKcMqAynBqgQpwaoDKcMABKnDKgKpwSoBqkQqAanBKgKpwwAEKcMqAqnBKgGqRCoBqcEqAqnDAAOpwyoCqcCqASpHKgEpwKoCqcMAAynDKgKpwKoBKkcqASnAqgKpwwADKcMqAinAqgCqQqnEKkKqAKnAqgIpwwADKcMqAinAqgCqQqnEKkKqAKnAqgIpwwACqcMqAinAqgCqQinGKkIqAKnAqgIpwwACKcMqAinAqgCqQinGKkIqAKnAqgIpwwACKcKqAinAqgCqQanIKkGqAKnAqgIpwoACKcKqAinAqgCqQanIKkGqAKnAqgIpwoABqcMqAanAqgCqQanJKkGqAKnAqgGpwwABKcMqAanAqgCqQanJKkGqAKnAqgGpwwABKcKqAinAqgCqQSnKKkEqAKnAqgIpwoABKcKqAinAqgCqQSnKKkEqAKnAqgIpwoABKcKqAanAqgCqQanKKkGqAKnAqgGpwoABKcKqAanAqgCqQanKKkGqAKnAqgGpwoABKcKqAanAqgCqQSnLKkEqAKnAqgGpwoABKcKqAanAqgCqQSnLKkEqAKnAqgGpwoAAqcKqAinAqgCqQSnLKkEqAKnAqgIpxSoCKcCqAKpBKcsqQSoAqcCqAinFKgGpwKoAqkEpzCpBKgCpwKoBqcUqAanAqgCqQSnMKkEqAKnAqgGpxSoBqcCqAKpBKcwqQSoAqcCqAanFKgGpwKoAqkEpzCpBKgCpwKoBqcUqAanAqgCqQSnMKkEqAKnAqgGpxSoBqcCqAKpBKcwqQSoAqcCqAanFKgGpwKoAqkEpzCpBKgCpwKoBqcUqAanAqgCqQSnMKkEqAKnAqgGpxSoBqcCqAKpBKcwqQSoAqcCqAanFKgGpwKoAqkEpzCpBKgCpwKoBqcUqAanAqgCqQSnMKkEqAKnAqgGpxSoBqcCqAKpBKcwqQSoAqcCqAanFKgGpwKoAqkEpzCpBKgCpwKoBqcUqAanAqgCqQSnMKkEqAKnAqgGpxSoBqcCqAKpBKcwqQSoAqcCqAanFKgGpwKoAqkEpzCpBKgCpwKoBqcUqAinAqgCqQSnLKkEqAKnAqgIpxSoCKcCqAKpBKcsqQSoAqcCqAinCgACpwqoBqcCqAKpBKcsqQSoAqcCqAanCgAEpwqoBqcCqAKpBKcsqQSoAqcCqAanCgAEpwqoBqcCqAKpBqcoqQaoAqcCqAanCgAEpwqoBqcCqAKpBqcoqQaoAqcCqAanCgAEpwqoCKcCqAKpBKcoqQSoAqcCqAinCgAEpwqoCKcCqAKpBKcoqQSoAqcCqAinCgAEpwyoBqcCqAKpBqckqQaoAqcCqAanDAAEpwyoBqcCqAKpBqckqQaoAqcCqAanDAAGpwqoCKcCqAKpBqcgqQaoAqcCqAinCgAIpwqoCKcCqAKpBqcgqQaoAqcCqAinCgAIpwyoCKcCqAKpCKcYqQioAqcCqAinDAAIpwyoCKcCqAKpCKcYqQioAqcCqAinDAAKpwyoCKcCqAKpCqcQqQqoAqcCqAinDAAMpwyoCKcCqAKpCqcQqQqoAqcCqAinDAAMpwyoCqcCqASpHKgEpwKoCqcMAAynDKgKpwKoBKkcqASnAqgKpwwADqcMqAqnBKgGqRCoBqcEqAqnDAAQpwyoCqcEqAapEKgGpwSoCqcMABKnDKgMpwaoEKcGqAynDAAUpwyoDKcGqBCnBqgMpwwAFKcQqA6nEKgOpxAAFKcQqA6nEKgOpxAAFqcQqCinEAAYpxCoKKcQABqnEqggpxIAHKcSqCCnEgAepxaoFKcWACCnFqgUpxYAJKc4ACinOAAqpzQALKc0ADCnLAA0pywAOKckADynJABEpxQATKcUACY=" },
  { key: "shield5.png", w: 96, h: 96, rle: "ACanFABMpxQARKckADynJAA4pywANKcsADCnNAAspzQAKqc4ACinOAAkpxaoFKcWACCnFqgUpxYAHqcSqCCnEgAcpxKoIKcSABqnEKgopxAAGKcQqCinEAAWpxCoDgAQqA6nEAAUpxCoDgAQqA6nEAAUpwyoDAAcqAynDAAUpwyoDAAcqAynDAASpwyoCgAkqAqnDAAQpwyoCgAkqAqnDAAOpwyoCgAoqAqnDAAMpwyoCgAoqAqnDAAMpwyoCAAsqAinDAAMpwyoCAAsqAinDAAKpwyoCAAwqAinDAAIpwyoCAAwqAinDAAIpwqoCAA0qAinCgAIpwqoCAA0qAinCgAGpwyoBgA4qAanDAAEpwyoBgA4qAanDAAEpwqoCAA4qAinCgAEpwqoCAA4qAinCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgACpwqoCAA8qAinFKgIADyoCKcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoCAA8qAinFKgIADyoCKcKAAKnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgIADioCKcKAASnCqgIADioCKcKAASnDKgGADioBqcMAASnDKgGADioBqcMAAanCqgIADSoCKcKAAinCqgIADSoCKcKAAinDKgIADCoCKcMAAinDKgIADCoCKcMAAqnDKgIACyoCKcMAAynDKgIACyoCKcMAAynDKgKACioCqcMAAynDKgKACioCqcMAA6nDKgKACSoCqcMABCnDKgKACSoCqcMABKnDKgMAByoDKcMABSnDKgMAByoDKcMABSnEKgOABCoDqcQABSnEKgOABCoDqcQABanEKgopxAAGKcQqCinEAAapxKoIKcSABynEqggpxIAHqcWqBSnFgAgpxaoFKcWACSnOAAopzgAKqc0ACynNAAwpywANKcsADinJAA8pyQARKcUAEynFAAm" },
  { key: "shield6.png", w: 96, h: 96, rle: "ACanFABMpxQARKckADynJAA4pywANKcsADCnNAAspzQAKqc4ACinOAAkpxaoFKcWACCnFqgUpxYAHqcSqCCnEgAcpxKoIKcSABqnEKgopxAAGKcQqCinEAAWpxCoLKcQABSnEKgspxAAFKcMqBKpEKgSpwwAFKcMqBKpEKgSpwwAEqcMqA6pBqcQqQaoDqcMABCnDKgOqQanEKkGqA6nDAAOpwyoDKkEpxypBKgMpwwADKcMqAypBKccqQSoDKcMAAynDKgKqQKnJKkCqAqnDAAMpwyoCqkCpySpAqgKpwwACqcMqAqpAqcoqQKoCqcMAAinDKgKqQKnKKkCqAqnDAAIpwqoCqkCpyypAqgKpwoACKcKqAqpAqcsqQKoCqcKAAanDKgIqQKnMKkCqAinDAAEpwyoCKkCpzCpAqgIpwwABKcKqAqpAqcwqQKoCqcKAASnCqgKqQKnMKkCqAqnCgAEpwqoCKkCpzSpAqgIpwoABKcKqAipAqc0qQKoCKcKAASnCqgIqQKnNKkCqAinCgAEpwqoCKkCpzSpAqgIpwoAAqcKqAqpAqc0qQKoCqcUqAqpAqc0qQKoCqcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAipAqc4qQKoCKcUqAqpAqc0qQKoCqcUqAqpAqc0qQKoCqcKAAKnCqgIqQKnNKkCqAinCgAEpwqoCKkCpzSpAqgIpwoABKcKqAipAqc0qQKoCKcKAASnCqgIqQKnNKkCqAinCgAEpwqoCqkCpzCpAqgKpwoABKcKqAqpAqcwqQKoCqcKAASnDKgIqQKnMKkCqAinDAAEpwyoCKkCpzCpAqgIpwwABqcKqAqpAqcsqQKoCqcKAAinCqgKqQKnLKkCqAqnCgAIpwyoCqkCpyipAqgKpwwACKcMqAqpAqcoqQKoCqcMAAqnDKgKqQKnJKkCqAqnDAAMpwyoCqkCpySpAqgKpwwADKcMqAypBKccqQSoDKcMAAynDKgMqQSnHKkEqAynDAAOpwyoDqkGpxCpBqgOpwwAEKcMqA6pBqcQqQaoDqcMABKnDKgSqRCoEqcMABSnDKgSqRCoEqcMABSnEKgspxAAFKcQqCynEAAWpxCoKKcQABinEKgopxAAGqcSqCCnEgAcpxKoIKcSAB6nFqgUpxYAIKcWqBSnFgAkpzgAKKc4ACqnNAAspzQAMKcsADSnLAA4pyQAPKckAESnFABMpxQAJg==" },
  { key: "shield7.png", w: 96, h: 96, rle: "ACanFABMpxQARKckADynJAA4pywANKcsADCnNAAspzQAKqc4ACinOAAkpxaoFKcWACCnFqgUpxYAHqcSqCCnEgAcpxKoIKcSABqnEKgopxAAGKcQqCinEAAWpxCoDgAQqA6nEAAUpxCoDgAQqA6nEAAUpwyoDAAcqAynDAAUpwyoDAAcqAynDAASpwyoCgAkqAqnDAAQpwyoCgAkqAqnDAAOpwyoCgAoqAqnDAAMpwyoCgAoqAqnDAAMpwyoCAAsqAinDAAMpwyoCAAsqAinDAAKpwyoCAAwqAinDAAIpwyoCAAwqAinDAAIpwqoCAA0qAinCgAIpwqoCAA0qAinCgAGpwyoBgA4qAanDAAEpwyoBgA4qAanDAAEpwqoCAA4qAinCgAEpwqoCAA4qAinCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgACpwqoCAA8qAinFKgIADyoCKcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoCAA8qAinFKgIADyoCKcKAAKnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgIADioCKcKAASnCqgIADioCKcKAASnDKgGADioBqcMAASnDKgGADioBqcMAAanCqgIADSoCKcKAAinCqgIADSoCKcKAAinDKgIADCoCKcMAAinDKgIADCoCKcMAAqnDKgIACyoCKcMAAynDKgIACyoCKcMAAynDKgKACioCqcMAAynDKgKACioCqcMAA6nDKgKACSoCqcMABCnDKgKACSoCqcMABKnDKgMAByoDKcMABSnDKgMAByoDKcMABSnEKgOABCoDqcQABSnEKgOABCoDqcQABanEKgopxAAGKcQqCinEAAapxKoIKcSABynEqggpxIAHqcWqBSnFgAgpxaoFKcWACSnOAAopzgAKqc0ACynNAAwpywANKcsADinJAA8pyQARKcUAEynFAAm" },
  { key: "shield8.png", w: 96, h: 96, rle: "ACanFABMpxQARKckADynJAA4pywANKcsADCnNAAspzQAKqc4ACinOAAkpxaoFKcWACCnFqgUpxYAHqcSqCCnEgAcpxKoIKcSABqnEKgopxAAGKcQqCinEAAWpxCoDqkQqA6nEAAUpxCoDqkQqA6nEAAUpwyoDKkGpxCpBqgMpwwAFKcMqAypBqcQqQaoDKcMABKnDKgKqQSnHKkEqAqnDAAQpwyoCqkEpxypBKgKpwwADqcMqAqpAqckqQKoCqcMAAynDKgKqQKnJKkCqAqnDAAMpwyoCKkCpyipAqgIpwwADKcMqAipAqcoqQKoCKcMAAqnDKgIqQKnLKkCqAinDAAIpwyoCKkCpyypAqgIpwwACKcKqAipAqcwqQKoCKcKAAinCqgIqQKnMKkCqAinCgAGpwyoBqkCpzSpAqgGpwwABKcMqAapAqc0qQKoBqcMAASnCqgIqQKnFKgMpxSpAqgIpwoABKcKqAipAqcUqAynFKkCqAinCgAEpwqoBqkCpxKoFKcSqQKoBqcKAASnCqgGqQKnEqgUpxKpAqgGpwoABKcKqAapAqcQqBinEKkCqAanCgAEpwqoBqkCpxCoGKcQqQKoBqcKAAKnCqgIqQKnDqgcpw6pAqgIpxSoCKkCpw6oHKcOqQKoCKcUqAapAqcQqBynEKkCqAanFKgGqQKnEKgcpxCpAqgGpxSoBqkCpw6oIKcOqQKoBqcUqAapAqcOqCCnDqkCqAanFKgGqQKnDqggpw6pAqgGpxSoBqkCpw6oIKcOqQKoBqcUqAapAqcOqCCnDqkCqAanFKgGqQKnDqggpw6pAqgGpxSoBqkCpw6oIKcOqQKoBqcUqAapAqcOqCCnDqkCqAanFKgGqQKnDqggpw6pAqgGpxSoBqkCpw6oIKcOqQKoBqcUqAapAqcOqCCnDqkCqAanFKgGqQKnDqggpw6pAqgGpxSoBqkCpxCoHKcQqQKoBqcUqAapAqcQqBynEKkCqAanFKgIqQKnDqgcpw6pAqgIpxSoCKkCpw6oHKcOqQKoCKcKAAKnCqgGqQKnEKgYpxCpAqgGpwoABKcKqAapAqcQqBinEKkCqAanCgAEpwqoBqkCpxKoFKcSqQKoBqcKAASnCqgGqQKnEqgUpxKpAqgGpwoABKcKqAipAqcUqAynFKkCqAinCgAEpwqoCKkCpxSoDKcUqQKoCKcKAASnDKgGqQKnNKkCqAanDAAEpwyoBqkCpzSpAqgGpwwABqcKqAipAqcwqQKoCKcKAAinCqgIqQKnMKkCqAinCgAIpwyoCKkCpyypAqgIpwwACKcMqAipAqcsqQKoCKcMAAqnDKgIqQKnKKkCqAinDAAMpwyoCKkCpyipAqgIpwwADKcMqAqpAqckqQKoCqcMAAynDKgKqQKnJKkCqAqnDAAOpwyoCqkEpxypBKgKpwwAEKcMqAqpBKccqQSoCqcMABKnDKgMqQanEKkGqAynDAAUpwyoDKkGpxCpBqgMpwwAFKcQqA6pEKgOpxAAFKcQqA6pEKgOpxAAFqcQqCinEAAYpxCoKKcQABqnEqggpxIAHKcSqCCnEgAepxaoFKcWACCnFqgUpxYAJKc4ACinOAAqpzQALKc0ADCnLAA0pywAOKckADynJABEpxQATKcUACY=" },
  { key: "shield9.png", w: 96, h: 96, rle: "ACanFABMpxQARKckADynJAA4pywANKcsADCnNAAspzQAKqc4ACinOAAkpxaoFKcWACCnFqgUpxYAHqcSqCCnEgAcpxKoIKcSABqnEKgopxAAGKcQqCinEAAWpxCoDgAQqA6nEAAUpxCoDgAQqA6nEAAUpwyoDAAcqAynDAAUpwyoDAAcqAynDAASpwyoCgAkqAqnDAAQpwyoCgAkqAqnDAAOpwyoCgAoqAqnDAAMpwyoCgAoqAqnDAAMpwyoCAAsqAinDAAMpwyoCAAsqAinDAAKpwyoCAAwqAinDAAIpwyoCAAwqAinDAAIpwqoCAA0qAinCgAIpwqoCAA0qAinCgAGpwyoBgA4qAanDAAEpwyoBgA4qAanDAAEpwqoCAA4qAinCgAEpwqoCAA4qAinCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgAEpwqoBgA8qAanCgACpwqoCAA8qAinFKgIADyoCKcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoBgBAqAanFKgGAECoBqcUqAYAQKgGpxSoCAA8qAinFKgIADyoCKcKAAKnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgGADyoBqcKAASnCqgIADioCKcKAASnCqgIADioCKcKAASnDKgGADioBqcMAASnDKgGADioBqcMAAanCqgIADSoCKcKAAinCqgIADSoCKcKAAinDKgIADCoCKcMAAinDKgIADCoCKcMAAqnDKgIACyoCKcMAAynDKgIACyoCKcMAAynDKgKACioCqcMAAynDKgKACioCqcMAA6nDKgKACSoCqcMABCnDKgKACSoCqcMABKnDKgMAByoDKcMABSnDKgMAByoDKcMABSnEKgOABCoDqcQABSnEKgOABCoDqcQABanEKgopxAAGKcQqCinEAAapxKoIKcSABynEqggpxIAHqcWqBSnFgAgpxaoFKcWACSnOAAopzgAKqc0ACynNAAwpywANKcsADinJAA8pyQARKcUAEynFAAm" }
];
var DUKE_PLAYER = {
  name: "duke",
  maxHp: 3,
  spDamage: 50,
  speed: 150,
  defaultShootName: "normal",
  defaultShootSpeed: "speed_normal",
  texture: ["duke_0", "duke_1", "duke_2", "duke_3"],
  shootNormal: {
    name: "normal",
    damage: 1,
    hp: 1,
    interval: 23,
    texture: ["bigProjectile_0.png", "bigProjectile_1.png", "bigProjectile_2.png", "bigProjectile_3.png"]
  },
  shootBig: {
    name: "big",
    damage: 2,
    hp: 100,
    interval: 39,
    texture: ["bigProjectile0.png", "bigProjectile1.png", "bigProjectile2.png"]
  },
  shoot3way: {
    name: "3way",
    damage: 1,
    hp: 1,
    interval: 31,
    texture: ["hadoken0.png", "hadoken1.png"]
  },
  barrier: {
    time: 4,
    texture: ["shield0.png", "shield1.png", "shield2.png", "shield3.png", "shield4.png", "shield5.png", "shield6.png", "shield7.png", "shield8.png", "shield9.png"]
  }
};
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function fromBase64(s) {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(clean.length * 3 >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = acc << 6 | B64.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = acc >> bits & 255;
    }
  }
  return out;
}
function decodePlayerArt() {
  return PLAYER_FRAMES.map(({ key, w, h, rle }) => {
    const runs = fromBase64(rle);
    const rgba = new Uint8ClampedArray(w * h * 4);
    let p = 0;
    for (let i = 0; i + 1 < runs.length; i += 2) {
      const colour = PLAYER_PALETTE[runs[i]];
      const r = colour >>> 24 & 255;
      const g = colour >>> 16 & 255;
      const b = colour >>> 8 & 255;
      const a = colour & 255;
      for (let n = runs[i + 1]; n > 0; n--) {
        const o = p++ * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = a;
      }
    }
    return { key, w, h, rgba };
  });
}

// packages/shmup-engine/src/decode/decode-enemy.js
var HP_TABLE = [60, 30, 15, 10, 5, 3, 2, 1];
var SCORE_TABLE = [50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4];
var SPEED_TABLE = [256, 12800, 25600, 51200, 102400, 204800, 256e3, 512e3];
var FIRE_WINDOW_TABLE = [29, 22, 16, 11, 7, 4, 2, 1];
var FIRE_INTERVAL_TABLE = [119, 59, 29, 19, 9, 5, 3, 1];
var FIRE_INTERVAL_TABLE_ALT = [119, 59, 39, 19, 11, 7, 3, 1];
var FACTOR_TABLE = [0, 4, 8, 12, 16, 24, 32, 48, 64];
var ROTATION_TABLE = [0, 32, 64, 96, 128, 160, 192, 224];
var DIRECTION_TABLE = [0, 16, 32, 48, 64, 80, 96, 112, 128];
var APPEARANCE_NOFIRE_HEX = "0000000000ffff00000000ff000000ffff000000ff0000000000000000000000";
function appearanceFires(appearance) {
  const byte = parseInt(
    APPEARANCE_NOFIRE_HEX.slice((appearance >> 3) * 2, (appearance >> 3) * 2 + 2),
    16
  );
  return (byte & 1 << (appearance & 7)) === 0;
}
var SPECIAL_FIRE_PATTERNS = { 10: 0, 11: 1, 12: 2 };
var FACTOR_STEP_TABLE = [16, 32, 64, 128, 256, 384, 512, 1024];
var ROTATION_STEP_TABLE = [16, 32, 64, 128, 256, 512, 1024, 2048];
var DIRECTION_STEP_TABLE = [128, 256, 512, 768, 1024, 1536, 2048, 32767];
var clampIndex = (v, table) => table[Math.min(v, table.length - 1)];
function channel(a, b, c, { enabled, table, stepTable, angle }) {
  const rawFrom = angle ? b & 7 : b & 15;
  const rawTo = angle ? b >> 4 & 7 : b >> 4 & 15;
  const from = clampIndex(rawFrom, table);
  const to = clampIndex(rawTo, table);
  const step = stepTable[a >> 4 & 7] / 256;
  const scale = angle ? 360 / 256 : 1 / 16;
  return {
    enabled,
    from: from * scale,
    to: to * scale,
    // sign follows the engine: it negates the step when start > end
    step: (from > to ? -step : step) * scale,
    repeat: c >> 4 & 3,
    // 0 once, 1 loop, 2 ping-pong
    trigger: c & 7
  };
}
function decodeEnemyRecord(bytes) {
  const b = Array.from(bytes);
  const rotationMode = b[9] & 7;
  const scaleMode = b[12] & 3;
  return {
    appearance: b[0],
    hp: HP_TABLE[b[1] & 7],
    score: SCORE_TABLE[b[1] >> 4 & 7],
    ground: (b[1] & 128) !== 0,
    speed: SPEED_TABLE[b[2] & 7] / 65536,
    // The spawn packs b2 bits 4-5 and bit 3 into one byte (0x6091550), and
    // the engine reads that byte BITWISE — masks 0x1/0x2/0x3 (the low
    // two-bit mode) and 0x4 (an independent flag) across its 56 read
    // sites. So this is a 2-bit mode plus a flag, not an 8-way enum;
    // movePattern keeps the packed value for continuity.
    movePattern: b[2] >> 4 & 3 | (b[2] & 8) >> 1,
    move: {
      mode: b[2] >> 4 & 3,
      // engine tests &1, &2, &3
      flag: (b[2] & 8) !== 0
      // engine tests &4 of the packed byte
    },
    fire: {
      // Two gates silence an enemy outright: the appearance's no-fire
      // bit, and byte 5's low nibble being 0 — the geometry table's
      // entry 0 is an empty routine (FORMAT.md "Zako firing,
      // re-traced"). `enabled` carries only the appearance gate; the
      // runtime combines it with `direction`.
      enabled: appearanceFires(b[0]),
      type: b[2] >> 6 & 3,
      // b2 bits 6-7 (semantics open)
      count: (b[3] & 7) + 1,
      wide: (b[3] & 8) !== 0,
      param: b[3],
      // raw
      // b4 & 3 = BULLET TYPE: which of the save's four global bullet
      // configs this enemy fires (settings +37..+40). Bullet types
      // 0-2 reload from the short table [14,12,10,8,6,4,2,1]
      // (0x6085f70); only type 3 uses the long tables kept here — the
      // runtime substitutes the short table for types 0-2.
      mode: b[4] & 3,
      interval: clampIndex(
        b[4] >> 4 & 7,
        (b[4] & 3) === 3 ? FIRE_INTERVAL_TABLE_ALT : FIRE_INTERVAL_TABLE
      ),
      window: FIRE_WINDOW_TABLE[b[4] >> 4 & 7],
      // Byte 5's low nibble picks a bullet-geometry function from the
      // 16-pointer table at 0x6086074 — all 16 traced (2026-08-28):
      // 0 silent, 1/10 single, 2 = ±8-unit pair, 3 = 0,±8 fan,
      // 4 = 0,±16, 5 = ±8,±24 (no center), 6 = 0,±8,±16,
      // 7 = 0,±16,±32, 8 = same as 7 with curving bullets, 9 = homing
      // single, 11 = single with (rand&31)−16 unit jitter, 12 = single
      // stepping +16 units (22.5°) per shot through a full circle,
      // 13 = ±64 perpendicular pair, 14 = 0,±64,128 cross, 15 = 8-way
      // star (angle units = 1/256 circle). Values 10/11/12 ALSO route
      // the fire routine to burst handlers (+0x193d0/+0x19538/+0x196a8):
      // 10 = 4 volleys one fire-tick apart, 11 = 5 jittered volleys,
      // 12 = 16 shots on consecutive frames — the rotating spiral.
      // Bit 4 (0x10) aims the volley at the player (re-aimed every
      // shot); otherwise shots leave along the enemy's facing.
      geometry: b[5] & 15,
      aimed: (b[5] & 16) !== 0,
      pattern: SPECIAL_FIRE_PATTERNS[b[5] & 15] ?? null,
      direction: SPECIAL_FIRE_PATTERNS[b[5] & 15] !== void 0 ? 0 : b[5] & 31,
      directionEx: b[5] >> 5 & 7
    },
    speedChange: channel(b[6], b[7], b[8], {
      enabled: (b[6] & 1) !== 0,
      table: FACTOR_TABLE,
      stepTable: FACTOR_STEP_TABLE,
      angle: false
    }),
    rotation: {
      ...channel(b[9], b[10], b[11], {
        enabled: rotationMode !== 0,
        table: ROTATION_TABLE,
        stepTable: ROTATION_STEP_TABLE,
        angle: true
      }),
      mode: rotationMode
    },
    scale: {
      ...channel(b[12], b[13], b[14], {
        enabled: scaleMode !== 0,
        table: FACTOR_TABLE,
        stepTable: FACTOR_STEP_TABLE,
        angle: false
      }),
      // which axes the channel drives
      axes: scaleMode === 1 ? "xy" : scaleMode === 2 ? "x" : scaleMode === 3 ? "y" : "",
      repeatY: b[14] >> 2 & 3
    },
    direction: channel(b[15], b[16], b[17], {
      enabled: (b[15] & 1) !== 0,
      table: DIRECTION_TABLE,
      stepTable: DIRECTION_STEP_TABLE,
      angle: true
    })
  };
}

// packages/shmup-engine/src/decode/decode-stage.js
var SEC5_REGIONS = {
  stageBanks: { offset: 0, count: 10, stride: 21504 },
  scrollCurves: { offset: 215040, count: 10, stride: 192 },
  placement: { offset: 216960, count: 10, stride: 15360 },
  settings: { offset: 370560, count: 1, stride: 96 },
  enemies: { offset: 370656, count: 10, stride: 1144 },
  spriteBank: { offset: 382096, count: 1, stride: 464 },
  spriteStages: { offset: 382560, count: 10, stride: 1408 }
};
var MAX_STAGES = 10;
var BG_COLS = 14;
var BG_ROWS = 768;
var BG_ROWS_PER_PART = 16;
var BG_PARTS = BG_ROWS / BG_ROWS_PER_PART;
var BG_EMPTY = 65535;
function decodeStageBackground(sec5, stage) {
  const { offset, stride } = SEC5_REGIONS.stageBanks;
  const base = offset + stage * stride;
  const tiles = new Array(BG_COLS * BG_ROWS);
  const partUsed = new Uint8Array(BG_PARTS);
  let usedTiles = 0;
  for (let i = 0; i < tiles.length; i++) {
    const o = base + i * 2;
    const word = sec5[o] << 8 | sec5[o + 1];
    if (word === BG_EMPTY) {
      tiles[i] = null;
      continue;
    }
    tiles[i] = {
      cell: word & 1023,
      hflip: (word & 16384) !== 0,
      vflip: (word & 32768) !== 0
    };
    usedTiles++;
    partUsed[i / (BG_COLS * BG_ROWS_PER_PART) | 0] = 1;
  }
  let partCount = 0;
  for (const u of partUsed) partCount += u;
  return {
    stage,
    cols: BG_COLS,
    rows: BG_ROWS,
    tiles,
    partUsed,
    partCount,
    usedTiles,
    empty: partCount === 0
  };
}
function decodeStages(sec5) {
  const stages = [];
  for (let s = 0; s < MAX_STAGES; s++) {
    const bg = decodeStageBackground(sec5, s);
    stages.push({
      ...bg,
      placement: decodeStagePlacement(sec5, s),
      enemies: decodeStageEnemies(sec5, s),
      scrollCurve: scrollCurveBytes(sec5, s)
    });
  }
  let stageCount = 0;
  stages.forEach((s, i) => {
    if (s.placement.objects.length) stageCount = i + 1;
  });
  return { stages, stageCount };
}
function scrollCurveBytes(sec5, stage) {
  const { offset, stride } = SEC5_REGIONS.scrollCurves;
  const base = offset + stage * stride;
  return sec5.subarray(base, base + stride);
}
var PLACEMENT_COLS = 20;
var PLACEMENT_ROWS = 768;
var PLAYFIELD_COL_START = 3;
var PLAYFIELD_COL_END = 16;
var ZAKO_GROUPS = [[128, 24], [160, 8], [176, 16], [192, 4], [208, 4], [224, 4]];
var ZAKO_SLOT_COUNT = 60;
function isBoss(id) {
  return id >= 240 && id <= 243;
}
function zakoRecordIndex(id) {
  let base = 0;
  for (const [first, count] of ZAKO_GROUPS) {
    if (id >= first && id < first + count) return base + (id - first);
    base += count;
  }
  return -1;
}
function describePlacementId(id) {
  if (isBoss(id)) return { id, kind: "boss", sizeClass: id & 15, record: -1 };
  if (id >= 232 && id <= 239) return { id, kind: "item", slot: id & 7, record: -1 };
  const record = zakoRecordIndex(id);
  if (record >= 0) return { id, kind: "zako", record, group: id >> 4, slot: id & 15 };
  return { id, kind: "unknown", record: -1 };
}
function decodeStagePlacement(sec5, stage) {
  const { offset, stride } = SEC5_REGIONS.placement;
  const base = offset + stage * stride;
  const objects = [];
  let boss = null;
  for (let row = 0; row < PLACEMENT_ROWS; row++) {
    for (let col = 0; col < PLACEMENT_COLS; col++) {
      const id = sec5[base + row * PLACEMENT_COLS + col];
      if (!id) continue;
      const obj = { ...describePlacementId(id), row, col, part: row / BG_ROWS_PER_PART | 0 };
      objects.push(obj);
      if (obj.kind === "boss") boss = obj;
    }
  }
  return { stage, cols: PLACEMENT_COLS, rows: PLACEMENT_ROWS, objects, boss };
}
var ENEMY_RECORD_SIZE = 18;
function decodeStageEnemies(sec5, stage) {
  const { offset, stride } = SEC5_REGIONS.enemies;
  const base = offset + stage * stride;
  const records = [];
  for (let i = 0; i < ZAKO_SLOT_COUNT; i++) {
    const at = base + i * ENEMY_RECORD_SIZE;
    const bytes = sec5.subarray(at, at + ENEMY_RECORD_SIZE);
    let defined = false;
    for (const b of bytes) if (b) {
      defined = true;
      break;
    }
    records.push({ index: i, defined, bytes });
  }
  return {
    stage,
    records,
    definedCount: records.filter((r) => r.defined).length,
    trailer: sec5.subarray(base + ZAKO_SLOT_COUNT * ENEMY_RECORD_SIZE, base + stride)
  };
}
var PLAYFIELD_COLS = PLAYFIELD_COL_END - PLAYFIELD_COL_START + 1;
function placementColumn(col) {
  return Math.min(PLACEMENT_COLS - 1, Math.max(0, col));
}
function enemyPairKey(stage, record) {
  return `${stage}:${record}`;
}
function projectForEditor(stages, { cols = PLACEMENT_COLS, itemSlots = null } = {}) {
  const uses = /* @__PURE__ */ new Map();
  stages.forEach((st, s) => {
    for (const o of st.placement.objects) {
      if (o.kind !== "zako") continue;
      const key = enemyPairKey(s, o.record);
      uses.set(key, (uses.get(key) || 0) + 1);
    }
  });
  const enemies = [];
  const indexOf = /* @__PURE__ */ new Map();
  stages.forEach((st, s) => {
    const placed = new Set(
      st.placement.objects.filter((o) => o.kind === "zako").map((o) => o.record)
    );
    for (const record of [...placed].sort((a, b) => a - b)) {
      const key = enemyPairKey(s, record);
      indexOf.set(key, enemies.length);
      const bytes = st.enemies.records[record] ? st.enemies.records[record].bytes : null;
      enemies.push({
        // stage-qualified so two stages' record 7 stay distinct
        name: `deza${s}_${String(record).padStart(2, "0")}`,
        stage: s,
        record,
        key,
        placements: uses.get(key),
        // The 18-byte definition decoded into named fields — hp, score,
        // speed, fire config and the four change channels. Engine-traced
        // (see decode-enemy.js); this is what makes imported enemies
        // play with their own stats instead of defaults.
        behavior: bytes ? decodeEnemyRecord(bytes) : null,
        // The raw 18 bytes still ride along for auditability.
        bytes
      });
    }
  });
  const stagesUsing = /* @__PURE__ */ new Map();
  stages.forEach((st, i) => {
    for (const o of st.placement.objects) {
      if (o.kind !== "zako") continue;
      if (!stagesUsing.has(o.record)) stagesUsing.set(o.record, []);
      const list = stagesUsing.get(o.record);
      if (!list.includes(i)) list.push(i);
    }
  });
  const projected = stages.map((st, s) => {
    const byRow = /* @__PURE__ */ new Map();
    const rowOf = (row) => {
      if (!byRow.has(row)) byRow.set(row, new Array(cols).fill(null));
      return byRow.get(row);
    };
    for (const o of st.placement.objects) {
      if (o.kind !== "zako") continue;
      const idx = indexOf.get(enemyPairKey(s, o.record));
      if (idx === void 0) continue;
      rowOf(o.row)[placementColumn(o.col)] = { enemy: idx, drop: 0 };
    }
    const items = st.placement.objects.filter((o) => o.kind === "item").map((o) => {
      const def = itemSlots && itemSlots[o.slot & 7];
      return {
        slot: o.slot,
        row: o.row,
        col: placementColumn(o.col),
        ...def ? { type: def.type, movement: def.movement } : {}
      };
    });
    const sortedRows = [...byRow.keys()].sort((a, b) => a - b);
    for (const item of items) {
      const host = nearestSpawn(byRow, sortedRows, item.row, item.col);
      if (!host) continue;
      host.drop = item.type !== void 0 ? ITEM_TYPE_DROPS[item.type] ?? 0 : ITEM_SLOT_DROPS[item.slot % ITEM_SLOT_DROPS.length];
    }
    return {
      rows: sortedRows.map((r) => byRow.get(r)),
      // Scroll row each wave came from, same order as `rows`.
      waveRows: sortedRows,
      cols,
      boss: st.placement.boss || null,
      items,
      // The stage's own scroll curve (192 raw bytes — see the region
      // decoder above), so the mapper can ship the save's pacing.
      scrollCurve: st.scrollCurve || null
    };
  });
  return { enemies, stages: projected, stagesUsing };
}
var ITEM_TYPE_DROPS = [2, 2, 2, 2, 9, 5, 4, 1, 3];
var ITEM_SLOT_DROPS = [1, 1, 2, 2, 3, 3, 9, 9];
function nearestSpawn(byRow, sortedRows, row, col) {
  let best = null;
  let bestDist = Infinity;
  for (const r of sortedRows) {
    const d = Math.abs(r - row);
    if (d >= bestDist) continue;
    const cell = byRow.get(r)[col];
    if (!cell) continue;
    best = cell;
    bestDist = d;
  }
  return best;
}
function sec5Regions(sec5) {
  return Object.entries(SEC5_REGIONS).map(([name, r]) => ({
    name,
    offset: r.offset,
    count: r.count,
    stride: r.stride,
    length: r.count * r.stride
  }));
}

// packages/shmup-engine/src/map-to-game.js
var GRID_COLS = 8;
var MAX_STAGES2 = 10;
var SINGLE_LETTER_ENEMIES = 26;
var BLANK_WAVES = 8;
var FRAMES_PER_SOURCE_ROW = 8;
var PLAYER_SHOT_DAMAGE_BY_LEVEL = [9, 12, 15, 18, 21];
var ENGINE_SHOT_DAMAGE = PLAYER_SHOT_DAMAGE_BY_LEVEL[PLAYER_SHOT_DAMAGE_BY_LEVEL.length - 1];
var ENEMY_BULLET_SPEED = 2.5;
function enemyLetters(index) {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + n % 26) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}
var EVIL_INVADERS_PLAYER = {
  name: "G",
  maxHp: 3,
  spDamage: 50,
  defaultShootName: "normal",
  defaultShootSpeed: "speed_normal",
  texture: ["player00.gif", "player01.gif", "player02.gif", "player03.gif", "player04.gif", "player05.gif"],
  shootNormal: {
    name: "normal",
    damage: 1,
    hp: 1,
    interval: 23,
    texture: ["shot00.gif", "shot01.gif", "shot02.gif", "shot03.gif"]
  },
  shootBig: {
    name: "big",
    damage: 2,
    hp: 100,
    interval: 39,
    texture: ["shotBig00.gif", "shotBig01.gif", "shotBig02.gif", "shotBig03.gif"]
  },
  shoot3way: {
    name: "3way",
    damage: 1,
    hp: 1,
    interval: 31,
    texture: ["shot00.gif", "shot01.gif", "shot02.gif", "shot03.gif"]
  },
  barrier: {
    time: 4,
    texture: ["barrier0.gif", "barrier1.gif", "barrier2.gif", "barrier3.gif"]
  }
};
var BUILTIN_DEFAULTS = {
  playerData: DUKE_PLAYER,
  starterEnemy: {
    name: "soliderA",
    score: 100,
    spgage: 4,
    hp: 1,
    speed: 0.8,
    interval: 300,
    texture: ["soliderA0.gif", "soliderA1.gif", "soliderA2.gif"],
    shadowReverse: true,
    shadowOffsetY: 10,
    bulletData: {
      score: 100,
      spgage: 2,
      hp: 1,
      speed: 1,
      damage: 1,
      texture: ["normalProjectile0.gif", "normalProjectile1.gif", "normalProjectile2.gif"]
    }
  },
  starterBoss: {
    name: "bison",
    score: 2200,
    spgage: 30,
    hp: 150,
    interval: 100,
    shadowReverse: true,
    shadowOffsetY: 50,
    anim: {
      idle: ["bison_idle0.gif", "bison_idle1.gif", "bison_idle2.gif", "bison_idle3.gif"],
      attack: ["bison_attack0.gif", "bison_attack1.gif"]
    },
    bulletData: {}
  }
};
var clone = (o) => JSON.parse(JSON.stringify(o));
function emptyWave(cols = GRID_COLS) {
  return new Array(cols).fill("00");
}
function buildBlankGame(defaults = BUILTIN_DEFAULTS) {
  return {
    stage0: { enemylist: Array.from({ length: BLANK_WAVES }, emptyWave) },
    playerData: clone(defaults.playerData),
    enemyData: { enemyA: clone(defaults.starterEnemy) },
    bossData: { boss0: clone(defaults.starterBoss) },
    meta: { version: "1.0" },
    continueComment: "",
    continueCommentEn: ""
  };
}
function sanitizeSpriteKey(raw, used) {
  let base = String(raw || "sprite").replace(/\.(gif|png)$/i, "").replace(/[^A-Za-z0-9_-]/g, "_");
  if (!base) base = "sprite";
  let key = `${base}.gif`;
  for (let n = 2; used.has(key); n++) key = `${base}_${n}.gif`;
  used.add(key);
  return key;
}
var NUMERIC_ENEMY_FIELDS = ["score", "spgage", "hp", "speed", "interval", "shadowOffsetY"];
var toHex = (bytes) => bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") : null;
var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesToBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[a >> 2] + B64_ALPHABET[(a & 3) << 4 | b >> 4] + (i + 1 < bytes.length ? B64_ALPHABET[(b & 15) << 2 | c >> 6] : "=") + (i + 2 < bytes.length ? B64_ALPHABET[c & 63] : "=");
  }
  return out;
}
function mapSaveToGame(decoded, { defaults = BUILTIN_DEFAULTS, sourceEntry = null, importedAt = null } = {}) {
  const warnings = [];
  const usedKeys = /* @__PURE__ */ new Set();
  const spriteKeyByIndex = [];
  const sprites = (decoded.sprites || []).map((s, i) => {
    const key = sanitizeSpriteKey(s.key || `deza_cg${i}`, usedKeys);
    spriteKeyByIndex[i] = key;
    return { key, w: s.w, h: s.h, rgba: s.rgba };
  });
  const backgroundCells = (decoded.bgCells || []).map((cell) => {
    const key = sanitizeSpriteKey(cell.key, usedKeys);
    sprites.push({ key, w: cell.w, h: cell.h, rgba: cell.rgba });
    return key;
  });
  const playerArt = decodePlayerArt();
  for (const frame of playerArt) {
    usedKeys.add(frame.key);
    sprites.push(frame);
  }
  const shotDamage = decoded.settings && decoded.settings.shotDamage || ENGINE_SHOT_DAMAGE;
  const decodedEnemies = decoded.enemies || [];
  const enemyData = {};
  const enemyLetterByIndex = [];
  decodedEnemies.forEach((e, i) => {
    const letters = enemyLetters(i);
    enemyLetterByIndex[i] = letters;
    const rec = clone(defaults.starterEnemy);
    if (e.name != null) rec.name = String(e.name);
    for (const f of NUMERIC_ENEMY_FIELDS) {
      if (Number.isFinite(e[f])) rec[f] = e[f];
    }
    if (e.behavior) {
      rec.hp = Math.max(1, Math.ceil(e.behavior.hp / shotDamage));
      rec.score = e.behavior.score;
      rec.speed = Math.round(e.behavior.speed * 100) / 100;
      rec.interval = e.behavior.fire.enabled ? e.behavior.fire.interval : -1;
      if (e.behavior.fire.enabled && rec.bulletData) {
        const cfg = decoded.settings && decoded.settings.bullets && decoded.settings.bullets.configs[e.behavior.fire.mode];
        rec.bulletData.speed = cfg ? Math.round(((8 + 8 * e.stage) * 4 / 512 + cfg.speedAdd) * 2 * 100) / 100 : ENEMY_BULLET_SPEED;
      }
    }
    if (Array.isArray(e.spriteKeys) && e.spriteKeys.length) {
      rec.texture = e.spriteKeys.map(
        (idx) => typeof idx === "number" ? spriteKeyByIndex[idx] || rec.texture[0] : String(idx)
      );
    }
    if (e.bytes || e.stage !== void 0) {
      rec.dezaemon = {
        stage: e.stage,
        record: e.record,
        placements: e.placements,
        attributes: toHex(e.bytes)
      };
      if (e.behavior) rec.dezaemon.behavior = clone(e.behavior);
    }
    enemyData[`enemy${letters}`] = rec;
  });
  if (Object.keys(enemyData).length === 0) {
    enemyData.enemyA = clone(defaults.starterEnemy);
  }
  const decodedStages = decoded.stages || [];
  if (decodedStages.length > MAX_STAGES2) {
    warnings.push(
      `save has ${decodedStages.length} stages; the runtime plays ${MAX_STAGES2} (stage0..stage${MAX_STAGES2 - 1}) \u2014 dropped ${decodedStages.length - MAX_STAGES2}`
    );
  }
  const gameJson = {};
  const stageCount = Math.max(1, Math.min(decodedStages.length, MAX_STAGES2));
  for (let s = 0; s < stageCount; s++) {
    const decodedStage = decodedStages[s] || {};
    const rows = decodedStage.rows || [];
    const cols = decodedStage.cols || (rows[0] ? rows[0].length : GRID_COLS);
    const enemylist = rows.map((row) => {
      const out = emptyWave(cols);
      for (let c = 0; c < Math.min(cols, row.length); c++) {
        const cell = row[c];
        if (!cell) continue;
        const letters = enemyLetterByIndex[cell.enemy];
        if (letters === void 0) continue;
        const drop = Number.isInteger(cell.drop) && cell.drop >= 0 && cell.drop <= 9 ? cell.drop : 0;
        out[c] = `${letters}${drop}`;
      }
      return out;
    });
    enemylist.reverse();
    const stage = {
      enemylist: enemylist.length ? enemylist : Array.from({ length: BLANK_WAVES }, () => emptyWave(cols))
    };
    if (Array.isArray(decodedStage.waveRows) && decodedStage.waveRows.length === rows.length && rows.length) {
      stage.waveRows = decodedStage.waveRows.slice().reverse();
      stage.waveInterval = FRAMES_PER_SOURCE_ROW;
    }
    if (decodedStage.items && decodedStage.items.length) stage.items = decodedStage.items;
    if (decodedStage.scrollCurve && decodedStage.scrollCurve.length) {
      stage.scroll = { curve: bytesToBase64(decodedStage.scrollCurve) };
      const extent = decoded.settings && decoded.settings.stageExtents && decoded.settings.stageExtents[s];
      if (extent) {
        stage.scroll.loopPart = extent.loopPart;
        stage.scroll.endPart = extent.endPart;
      }
    }
    const bgStage = (decoded.bgStages || [])[s];
    if (bgStage && bgStage.words) {
      const bytes = new Uint8Array(bgStage.words.length * 2);
      bgStage.words.forEach((w, i) => {
        bytes[i * 2] = w >> 8;
        bytes[i * 2 + 1] = w & 255;
      });
      stage.background = {
        cols: bgStage.cols,
        rows: bgStage.rows,
        tiles: bytesToBase64(bytes)
      };
    }
    gameJson[`stage${s}`] = stage;
  }
  const bossData = {};
  const bossByStage = new Map((decoded.bosses || []).map((b) => [b.stage, b]));
  for (let s = 0; s < stageCount; s++) {
    const rec = clone(defaults.starterBoss);
    rec.name = `dezaBoss${s}`;
    const decodedBoss = bossByStage.get(s);
    if (decodedBoss) {
      rec.dezaemon = { sizeClass: decodedBoss.sizeClass, row: decodedBoss.row, col: decodedBoss.col };
      if (decodedBoss.behavior) {
        rec.dezaemon.boss = decodedBoss.behavior;
        rec.hp = Math.max(1, Math.ceil(decodedBoss.behavior.hp / (shotDamage * 1024)));
        rec.score = decodedBoss.behavior.score;
      }
      if (decodedBoss.partArt) {
        const partArt = {};
        for (const [record, keys] of Object.entries(decodedBoss.partArt)) {
          const frames = keys.map((i) => spriteKeyByIndex[i]).filter(Boolean);
          if (frames.length) partArt[record] = frames;
        }
        if (Object.keys(partArt).length) rec.dezaemon.partArt = partArt;
      }
      if (Array.isArray(decodedBoss.spriteKeys) && decodedBoss.spriteKeys.length) {
        const frames = decodedBoss.spriteKeys.map((idx) => spriteKeyByIndex[idx]).filter(Boolean);
        if (frames.length) {
          rec.anim = decodedBoss.coreArt ? { idle: frames, attack: frames } : { idle: [frames[0]], attack: [frames[1] || frames[0]] };
          rec.dezaemon.coreArt = decodedBoss.coreArt === true;
        }
      }
    }
    bossData[`boss${s}`] = rec;
  }
  gameJson.noStory = true;
  if (decoded.titleArt) {
    const dezaemonTitle = {};
    for (const [role, idx] of Object.entries(decoded.titleArt)) {
      const key = spriteKeyByIndex[idx];
      if (key) dezaemonTitle[role] = key;
    }
    if (Object.keys(dezaemonTitle).length) gameJson.dezaemonTitle = dezaemonTitle;
  }
  gameJson.playerData = clone(DUKE_PLAYER);
  if (backgroundCells.length) gameJson.backgroundCells = backgroundCells;
  gameJson.enemyData = enemyData;
  gameJson.bossData = bossData;
  const sec6 = decoded.sections && decoded.sections[6] && decoded.sections[6].decompressed;
  if (decoded.settings && sec6 && decoded.songs) {
    const table = decoded.settings.bgmTable;
    const special = table.slice(0, 3);
    const stagePairs = [];
    for (let s2 = 0; s2 * 2 + 4 < table.length && s2 < stageCount; s2++) {
      stagePairs.push([table[3 + s2 * 2], table[4 + s2 * 2]]);
    }
    const used = /* @__PURE__ */ new Set([...special, ...stagePairs.flat()]);
    const songs = {};
    for (const idx of used) {
      if (idx == null || idx < 0 || idx >= 24) continue;
      const song = decoded.songs[idx];
      if (!song || !song.noteCount) continue;
      songs[idx] = bytesToBase64(sec6.subarray(idx * 4228, (idx + 1) * 4228));
    }
    if (Object.keys(songs).length) {
      const tempos = {};
      for (const idx of Object.keys(songs)) tempos[idx] = decoded.songs[idx].stepSeconds;
      gameJson.dezaemonBgm = {
        sfxSet: decoded.settings.sfxSet,
        special,
        stages: stagePairs,
        songs,
        tempos
      };
    }
  }
  if (decoded.settings && decoded.settings.bullets) {
    gameJson.dezaemonBullets = clone(decoded.settings.bullets);
  }
  if (decoded.settings && decoded.settings.itemSlots) {
    gameJson.dezaemonItems = {
      score: decoded.settings.scoreItemValue,
      slots: clone(decoded.settings.itemSlots)
    };
  }
  if (decoded.globalArt) {
    const art = decoded.globalArt;
    const keysOf = (indices) => (indices || []).map((i) => i != null ? spriteKeyByIndex[i] : null);
    if (art.player && art.player.idle) {
      const idle = keysOf(art.player.idle).filter(Boolean);
      if (idle.length) {
        gameJson.playerData.texture = idle;
        gameJson.playerData.name = "dezaShip";
      }
    }
    if (gameJson.dezaemonBullets && art.bullets) {
      gameJson.dezaemonBullets.art = art.bullets.map((frames) => {
        const keys = keysOf(frames).filter(Boolean);
        return keys.length ? keys : null;
      });
    }
    if (gameJson.dezaemonBullets && (art.blastA || art.blastB)) {
      gameJson.dezaemonBullets.blastArt = {};
      if (art.blastA) gameJson.dezaemonBullets.blastArt.a = keysOf(art.blastA).filter(Boolean);
      if (art.blastB) gameJson.dezaemonBullets.blastArt.b = keysOf(art.blastB).filter(Boolean);
    }
    if (gameJson.dezaemonItems && art.items) {
      const icons = keysOf(art.items);
      gameJson.dezaemonItems.icons = icons;
      const iconByDrop = {};
      decoded.settings.itemSlots.forEach((slot, s) => {
        const drop = ITEM_TYPE_DROPS[slot.type];
        if (drop != null && icons[s] && iconByDrop[drop] === void 0) {
          iconByDrop[drop] = icons[s];
        }
      });
      if (Object.keys(iconByDrop).length) gameJson.dezaemonItems.iconByDrop = iconByDrop;
    }
  }
  gameJson.meta = { version: "1.0", source: "dezaemon2" };
  if (decoded.settings) {
    gameJson.meta.dezaemonSettings = {
      gameMode: decoded.settings.gameMode,
      // gameMode decoded (2026-08-28): bit0 = horizontal scroller,
      // bit1 = two players
      horizontal: (decoded.settings.gameMode & 1) !== 0,
      twoPlayer: (decoded.settings.gameMode & 2) !== 0,
      staffRoles: decoded.settings.staffRoles,
      mainWeapon: decoded.settings.mainWeapon,
      mainWeapon2P: decoded.settings.loadouts ? decoded.settings.loadouts[decoded.settings.ships[1].startLoadout].main : void 0,
      shotDamage,
      sfxSet: decoded.settings.sfxSet
    };
  }
  if (decoded.title) gameJson.meta.sourceTitle = decoded.title;
  if (sourceEntry) {
    gameJson.meta.sourceComment = sourceEntry.comment;
    gameJson.meta.sourceFilename = sourceEntry.filename;
  }
  if (importedAt) gameJson.meta.importedAt = importedAt;
  gameJson.continueComment = "";
  gameJson.continueCommentEn = "";
  const savedSprites = (decoded.sprites || []).length;
  if (!savedSprites) {
    warnings.push(
      decodedEnemies.length ? "no CG/sprite data decoded for these enemies \u2014 using the default art (their identity and placement are real)" : "no CG/sprite data decoded from this save \u2014 using the default art"
    );
  }
  {
    const decodedAttrs = decodedEnemies.filter((e) => e.behavior).length;
    if (decodedEnemies.length && !decodedAttrs) {
      warnings.push(
        "enemy attribute records did not decode \u2014 every imported enemy uses the default stats"
      );
    }
  }
  if (!decodedEnemies.length) {
    warnings.push("no enemy table decoded from this save \u2014 using the default starter enemy");
  }
  if (!decodedStages.length) {
    warnings.push(
      "no stage layout decoded from this save \u2014 every wave is empty, so nothing will spawn"
    );
  }
  if (decoded.settings && decoded.settings.gameMode & 1) {
    warnings.push(
      "this is a HORIZONTAL-scroll save (game mode bit 0) \u2014 the runtime still plays it as a vertical scroller, so its stages will read sideways"
    );
  }
  if (!savedSprites && !decodedEnemies.length && !decodedStages.length) {
    warnings.push(
      "this import carries the save's identity but none of its content yet; decoding the section contents is still open work (see FORMAT.md)"
    );
  }
  return { gameJson, sprites, warnings };
}

// packages/shmup-engine/src/decompress.js
var RING_SIZE = 4096;
var RING_MASK = RING_SIZE - 1;
var RING_INIT = 4078;
function decompress(input) {
  const out = [];
  const ring = new Uint8Array(RING_SIZE);
  let rpos = RING_INIT;
  let i = 0;
  let flags = 0;
  let flagCount = 0;
  while (i < input.length) {
    if (flagCount === 0) {
      flags = input[i++];
      flagCount = 8;
      if (i >= input.length) break;
    }
    const literal = flags & 1;
    flags >>= 1;
    flagCount--;
    if (literal) {
      if (i >= input.length) break;
      const b = input[i++];
      out.push(b);
      ring[rpos] = b;
      rpos = rpos + 1 & RING_MASK;
    } else {
      if (i + 1 >= input.length) break;
      const b1 = input[i++];
      const b2 = input[i++];
      const off = b1 | (b2 & 240) << 4;
      const len = (b2 & 15) + 3;
      for (let k = 0; k < len; k++) {
        const b = ring[off + k & RING_MASK];
        out.push(b);
        ring[rpos] = b;
        rpos = rpos + 1 & RING_MASK;
      }
    }
    if (out.length > 8e6) {
      throw new Error("LZSS runaway: output exceeded 8MB");
    }
  }
  return Uint8Array.from(out);
}
var SECTION_SIZES = [65536, 65536, 65536, 65536, 512, 396640, 101472, 5828];
var SECTION_HINTS = [
  "CG art page 1 (128x512 8bpp, 16x16 cells, pixel=(pal<<4)|color)",
  "CG art page 2",
  "CG art page 3",
  "CG art page 4",
  "palettes: 16x16 u16be RGB555 (12 preset + 4 user)",
  "game assembly: backgrounds/placement/enemies/sprites/settings",
  "BGM: 24 song slots x 4228B (4 parts x 32 measures x 32 steps)",
  "3D models: magic + 16 slots x 328B part lists (poly-kichi editor)"
];

// packages/shmup-engine/src/decode/decode-cg.js
var CG_PAGE_SIZE = 65536;
var CG_CELL_DIM = 16;
var CG_CELLS_PER_PAGE = 256;
var CG_CELLS_PER_ROW = 8;
var CG_PAGE_WIDTH = CG_CELLS_PER_ROW * CG_CELL_DIM;
var CG_PAGE_HEIGHT = CG_CELLS_PER_PAGE / CG_CELLS_PER_ROW * CG_CELL_DIM;
var PALETTE_COUNT = 16;
var COLORS_PER_PALETTE = 16;
function decodePalettes(sec4) {
  if (sec4.length < PALETTE_COUNT * COLORS_PER_PALETTE * 2) {
    throw new Error(`palette bank too small: ${sec4.length}`);
  }
  const palettes = [];
  for (let p = 0; p < PALETTE_COUNT; p++) {
    const colors = [];
    for (let c = 0; c < COLORS_PER_PALETTE; c++) {
      const off = (p * COLORS_PER_PALETTE + c) * 2;
      const raw = sec4[off] << 8 | sec4[off + 1];
      const r5 = raw & 31;
      const g5 = raw >> 5 & 31;
      const b5 = raw >> 10 & 31;
      colors.push({
        raw,
        // 5->8 bit with bit replication so pure white is 255,255,255
        r: r5 << 3 | r5 >> 2,
        g: g5 << 3 | g5 >> 2,
        b: b5 << 3 | b5 >> 2,
        empty: raw === 0
      });
    }
    palettes.push({ colors });
  }
  return palettes;
}
function decodeCgPage(section) {
  if (section.length < CG_PAGE_SIZE) {
    throw new Error(`CG page too small: ${section.length}`);
  }
  const out = new Uint8Array(CG_PAGE_WIDTH * CG_PAGE_HEIGHT);
  for (let cell = 0; cell < CG_CELLS_PER_PAGE; cell++) {
    const cellX = cell % CG_CELLS_PER_ROW * CG_CELL_DIM;
    const cellY = (cell / CG_CELLS_PER_ROW | 0) * CG_CELL_DIM;
    const base = cell * 256;
    for (let y = 0; y < CG_CELL_DIM; y++) {
      for (let x = 0; x < CG_CELL_DIM; x++) {
        out[(cellY + y) * CG_PAGE_WIDTH + cellX + x] = section[base + y * CG_CELL_DIM + x];
      }
    }
  }
  return out;
}
function indexedToRgba(indexed, palettes, { transparentZero = true } = {}) {
  const rgba = new Uint8ClampedArray(indexed.length * 4);
  for (let i = 0; i < indexed.length; i++) {
    const v = indexed[i];
    if (transparentZero && v === 0) continue;
    const color = palettes[v >> 4].colors[v & 15];
    const o = i * 4;
    rgba[o] = color.r;
    rgba[o + 1] = color.g;
    rgba[o + 2] = color.b;
    rgba[o + 3] = 255;
  }
  return rgba;
}
function cellIndexed(sections, cellIndex) {
  const page = cellIndex >> 8;
  const cell = cellIndex & 255;
  const section = sections[page];
  if (!section) throw new Error(`cell ${cellIndex}: page ${page} missing`);
  return section.subarray(cell * 256, cell * 256 + 256);
}
function cellIsBlank(sections, cellIndex) {
  const bytes = cellIndexed(sections, cellIndex);
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
  return true;
}
function decodeCg(sections, sec4) {
  const palettes = decodePalettes(sec4);
  const pages = sections.map((section, p) => {
    const indexed = decodeCgPage(section);
    const usedCells = new Uint8Array(CG_CELLS_PER_PAGE);
    let usedCount = 0;
    for (let c = 0; c < CG_CELLS_PER_PAGE; c++) {
      if (!cellIsBlank(sections, p * 256 + c)) {
        usedCells[c] = 1;
        usedCount++;
      }
    }
    return {
      page: p,
      width: CG_PAGE_WIDTH,
      height: CG_PAGE_HEIGHT,
      indexed,
      rgba: indexedToRgba(indexed, palettes),
      usedCells,
      usedCount
    };
  });
  return { palettes, pages };
}

// packages/shmup-engine/src/decode/decode-song.js
var SONG_SIZE = 4228;
var SONG_SLOTS = 24;
var SONG_HEADER = 4;
var MEASURES = 32;
var MEASURE_SIZE = 132;
var MEASURE_HEADER = 4;
var PARTS = 4;
var STEPS_PER_MEASURE = 16;
var PART_BLOCK = 32;
var VOICE_OFFSET = 0;
var PITCH_OFFSET = 16;
var STEP_EMPTY = 0;
var NOTE_MIN = 1;
var NOTE_MAX = 59;
function isNote(step) {
  return step >= NOTE_MIN && step <= NOTE_MAX;
}
function isSustain(step) {
  return (step & 128) !== 0;
}
function readPartEvents(bytes, part) {
  const events = [];
  let current = null;
  for (let m = 0; m < MEASURES; m++) {
    const base = SONG_HEADER + m * MEASURE_SIZE + MEASURE_HEADER + part * PART_BLOCK;
    for (let st = 0; st < STEPS_PER_MEASURE; st++) {
      const voice = bytes[base + VOICE_OFFSET + st];
      const pitch = bytes[base + PITCH_OFFSET + st];
      const at = m * STEPS_PER_MEASURE + st;
      if (voice === STEP_EMPTY) {
        current = null;
      } else if (isSustain(voice)) {
        if (current) current.len = at - current.step + 1;
      } else if (isNote(pitch)) {
        current = { step: at, note: pitch, instrument: voice, len: 1 };
        events.push(current);
      } else {
        current = null;
      }
    }
  }
  return events;
}
var SONG_LOOP_START_OFFSET = 0;
var SONG_LOOP_END_OFFSET = 1;
var SONG_ECHO_OFFSET = 2;
var SONG_TEMPO_OFFSET = 3;
var TEMPO_TABLE = [
  66,
  60,
  57,
  54,
  52,
  49,
  47,
  45,
  43,
  42,
  40,
  39,
  38,
  36,
  35,
  34,
  33,
  32,
  31,
  30,
  29,
  28,
  27,
  26,
  25,
  24,
  23,
  22,
  21,
  20,
  19,
  18
];
var TRANSPOSE_TABLE = [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6, -5, -4];
function songStepSeconds(tempoIndex) {
  return TEMPO_TABLE[tempoIndex & 31] / 240;
}
function decodeSong(bytes, slot = 0) {
  if (bytes.length < SONG_SIZE) throw new Error(`song too small: ${bytes.length}`);
  const measures = [];
  let soundingSteps = 0;
  for (let m = 0; m < MEASURES; m++) {
    const base = SONG_HEADER + m * MEASURE_SIZE;
    const parts = [];
    for (let p = 0; p < PARTS; p++) {
      const at = base + MEASURE_HEADER + p * PART_BLOCK;
      const steps = bytes.subarray(at, at + PART_BLOCK);
      for (let st = 0; st < STEPS_PER_MEASURE; st++) {
        if (steps[VOICE_OFFSET + st] !== STEP_EMPTY) soundingSteps++;
      }
      parts.push(steps);
    }
    const control = bytes.subarray(base, base + MEASURE_HEADER);
    measures.push({
      index: m,
      control,
      // accompaniment transpose — see TRANSPOSE_TABLE
      transpose: TRANSPOSE_TABLE[control[3]] || 0,
      parts
    });
  }
  const events = [];
  for (let p = 0; p < PARTS; p++) events.push(readPartEvents(bytes, p));
  const tempoIndex = bytes[SONG_TEMPO_OFFSET] & 31;
  return {
    slot,
    header: bytes.subarray(0, SONG_HEADER),
    tempoIndex,
    stepSeconds: songStepSeconds(tempoIndex),
    echoLevel: bytes[SONG_ECHO_OFFSET] & 7,
    loopStart: bytes[SONG_LOOP_START_OFFSET],
    loopEnd: bytes[SONG_LOOP_END_OFFSET],
    measures,
    events,
    noteCount: soundingSteps,
    onsetCount: events.reduce((n, e) => n + e.length, 0),
    empty: soundingSteps === 0
  };
}
function decodeSongs(sec6) {
  const songs = [];
  for (let i = 0; i < SONG_SLOTS; i++) {
    songs.push(decodeSong(sec6.subarray(i * SONG_SIZE, (i + 1) * SONG_SIZE), i));
  }
  return { songs, usedCount: songs.filter((s) => !s.empty).length };
}

// packages/shmup-engine/src/decode/decode-settings.js
var WEAPON_FULL_POWER_DAMAGE = {
  0: 5120,
  // fires no main shot; keep the anchor pace
  1: 5120,
  2: 11520,
  3: 5120,
  // homing stream: 128/contact, many contacts/frame — floored
  4: 5120,
  // twin 1152 missiles + sub coverage — floored
  5: 5120,
  // 1280 tap + 7168/pellet charge — floored
  6: 5120,
  // 384/bullet at 1-frame intervals — floored
  7: 5120
  // 3584..7680 per beam frame — floored
};
var DEFAULT_SHOT_DAMAGE = 20;
function weaponShotDamage(weapon) {
  const units = WEAPON_FULL_POWER_DAMAGE[weapon];
  return units ? Math.round(units / 256) : DEFAULT_SHOT_DAMAGE;
}
var BULLET_DAMAGE_TABLE = [60, 30, 15, 10, 5, 3, 2, 1];
var BULLET_SPEED_ADD_TABLE = [128, 256, 512, 896];
var BLAST_HOLD_TABLE = [8, 7, 6, 5, 4, 3, 2, 1];
function bulletConfig(byte) {
  return {
    raw: byte,
    damage: BULLET_DAMAGE_TABLE[byte & 7],
    // px/frame at 60 Hz, before the rank-driven base
    speedAdd: BULLET_SPEED_ADD_TABLE[byte >> 4 & 3] / 512,
    flag: (byte & 128) !== 0
  };
}
var AUTOFIRE_RATE_TABLE = [60, 30, 15, 10, 5, 3, 2, 1];
var STAFF_ROLE_LABELS = [
  "",
  "PLANNING",
  "PRODUCE",
  "SFX PLAY",
  "ENEMY DESIGN",
  "MAP DESIGN",
  "CHARACTER DESIGN",
  "TITLE LOGO",
  "2D GRAPHIC",
  "3D GRAPHIC",
  "DEBUG",
  "SPECIAL THANKS",
  "PRESENTED BY",
  "GRAPHIC",
  "MUSIC",
  "THANKS"
];
function shipBlock(sec5, base) {
  return {
    startLoadout: sec5[base] & 3,
    rapidParam: sec5[base + 1] & 7,
    // manual fire interval = 8 - v frames
    maxSpeed: sec5[base + 1] >> 4 & 7,
    initialPower: sec5[base + 2] & 7,
    maxPower: Math.min(4, sec5[base + 2] >> 4 & 7),
    // frames between autofire volleys
    autofireFrames: AUTOFIRE_RATE_TABLE[sec5[base + 3] & 7],
    raw: [...sec5.subarray(base, base + 4)]
  };
}
function loadout(sec5, base) {
  const b0 = sec5[base];
  const b1 = sec5[base + 1];
  return {
    main: b0 & 7,
    sub: b0 >> 4 & 7,
    charge: b1 & 3,
    bomb: b1 >> 4 & 7,
    bombVariant: (b1 & 128) !== 0,
    raw: [b0, b1]
  };
}
function decodeSettings(sec5) {
  const base = SEC5_REGIONS.settings.offset;
  const ships = [shipBlock(sec5, base + 12), shipBlock(sec5, base + 16)];
  const loadouts = [0, 1, 2, 3].map((k) => loadout(sec5, base + 20 + k * 2));
  const startWeapons = loadouts[ships[0].startLoadout];
  const stageExtents = [];
  for (let s = 0; s < 10; s++) {
    stageExtents.push({
      loopPart: sec5[base + 45 + s * 2],
      endPart: sec5[base + 46 + s * 2]
    });
  }
  return {
    gameMode: sec5[base] & 3,
    ships,
    loadouts,
    // per-save shot damage: player 1's starting main weapon sets the pace
    mainWeapon: startWeapons.main,
    shotDamage: weaponShotDamage(startWeapons.main),
    // The 8 item slots (+0x1C..+0x23) — decoded 2026-08-28: each byte is
    // (movement << 4) | itemType. Types (effect pointer table +0x25ACC):
    // 0-3 = weapon change to loadout preset 0-3 (presets at +0x14..+0x1B),
    // 4 = barrier, 5 = bomb stock +1, 6 = score bonus (value picked by
    // byte +0x24 through the boss score table), 7 = power-up (shot level
    // +1), 8 = speed-up. Movement: 0 = launch-and-drift, 1 = bouncer,
    // 2 = scroll-anchored (rides the background).
    itemSlots: [...sec5.subarray(base + 28, base + 36)].map((byte) => ({
      raw: byte,
      type: byte & 15,
      movement: byte >> 4 & 3
    })),
    // +0x24: game-wide score-item value index into the boss score table
    // [5000,10000,20000,50000,100000,200000,500000,1000000] (+0x21F00).
    scoreItemValue: [5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6][sec5[base + 36] & 7],
    bullets: {
      configs: [37, 38, 39, 40].map((o) => bulletConfig(sec5[base + o])),
      blast: {
        a: BLAST_HOLD_TABLE[sec5[base + 40] & 7],
        b: BLAST_HOLD_TABLE[sec5[base + 40] >> 4 & 7]
      }
    },
    stageExtents,
    bgmTable: [...sec5.subarray(base + 65, base + 89)],
    sfxSet: sec5[base + 89],
    // +0x01: HUD dressing — bits4-6 frame-graphic select (7 VDP2 tile
    // sets), bits0-2 HUD palette select (traced 2026-08-28).
    hudStyle: {
      frame: sec5[base + 1] >> 4 & 7,
      palette: sec5[base + 1] & 7
    },
    // +0x02..+0x0B: per-stage flag bytes. bit0 CLEAR = the row starts a
    // NEW numbered stage; SET = a continuation part (the stage number
    // holds and the music carries over — polarity adversarially
    // verified). bit6 = keep the scroll position on player death,
    // bit7 = the final stage (the game ends after it).
    stageFlags: [...sec5.subarray(base + 2, base + 12)].map((b) => ({
      newStage: (b & 1) === 0,
      keepScrollOnDeath: (b & 64) !== 0,
      finalStage: (b & 128) !== 0
    })),
    // +0x5A..+0x5C: the staff roll's three role labels — indices into the
    // engine's fixed 16-entry list (GAME.bin +0x20164).
    staffRoles: [90, 91, 92].map((o) => STAFF_ROLE_LABELS[sec5[base + o] & 15]),
    confidence: {
      mainWeapon: "confirmed",
      loadouts: "confirmed",
      itemSlots: "confirmed",
      bullets: "confirmed",
      stageExtents: "confirmed",
      bgmTable: "confirmed",
      sfxSet: "confirmed"
    }
  };
}

// packages/shmup-engine/src/decode/decode-sprites.js
var RECORD_ART = [
  { first: 0, count: 16, frames: 4, w: 1, h: 1, base: 0 },
  { first: 16, count: 8, frames: 4, w: 2, h: 1, base: 128 },
  { first: 24, count: 8, frames: 4, w: 1, h: 2, base: 256 },
  { first: 32, count: 16, frames: 4, w: 2, h: 2, base: 384 },
  { first: 48, count: 4, frames: 2, w: 4, h: 2, base: 896 },
  { first: 52, count: 4, frames: 2, w: 2, h: 4, base: 1024 },
  { first: 56, count: 4, frames: 1, w: 4, h: 4, base: 1152 }
];
var BOSS_CORE_OFFSET = 1280;
var BOSS_CORE_GEOM = [
  { frames: 4, w: 4, h: 4 },
  // F0: four 64x64
  { frames: 2, w: 8, h: 4 },
  // F1: two 128x64
  { frames: 2, w: 4, h: 8 },
  // F2: two 64x128
  { frames: 1, w: 8, h: 8 }
  // F3: one 128x128
];
var EMPTY_REF = 65535;
function recordArt(record) {
  for (const band of RECORD_ART) {
    if (record >= band.first && record < band.first + band.count) return band;
  }
  return null;
}
function decodeWord(word) {
  return {
    empty: word === EMPTY_REF,
    cell: word & 1023,
    hflip: (word & 16384) !== 0,
    vflip: (word & 32768) !== 0
  };
}
function readWords(sec5, stage, byteOffset, count) {
  const { offset, stride } = SEC5_REGIONS.spriteStages;
  const base = offset + stage * stride + byteOffset;
  const words = [];
  for (let k = 0; k < count; k++) {
    const at = base + k * 2;
    words.push(sec5[at] << 8 | sec5[at + 1]);
  }
  return words;
}
function readEnemyFrames(sec5, stage, record) {
  const band = recordArt(record);
  if (!band) return null;
  const cellsPerFrame = band.w * band.h;
  const byteOffset = band.base + (record - band.first) * band.frames * cellsPerFrame * 2;
  const words = readWords(sec5, stage, byteOffset, band.frames * cellsPerFrame);
  if (words.every((w) => w === EMPTY_REF)) return null;
  const frames = [];
  for (let f = 0; f < band.frames; f++) {
    const cells = words.slice(f * cellsPerFrame, (f + 1) * cellsPerFrame).map(decodeWord);
    if (cells.every((c) => c.empty)) continue;
    frames.push({ w: band.w, h: band.h, cells });
  }
  return frames.length ? { record, w: band.w, h: band.h, frames } : null;
}
function coreCellOrder(w, h) {
  const order = [];
  const blocksPerRow = w / 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const block = (y >> 2) * blocksPerRow + (x >> 2);
      order.push(block * 16 + (y & 3) * 4 + (x & 3));
    }
  }
  return order;
}
function readBossCore(sec5, stage, sizeClass) {
  const geom = BOSS_CORE_GEOM[sizeClass & 3];
  const cellsPerFrame = geom.w * geom.h;
  const words = readWords(sec5, stage, BOSS_CORE_OFFSET, geom.frames * cellsPerFrame);
  if (words.every((w) => w === EMPTY_REF)) return null;
  const order = coreCellOrder(geom.w, geom.h);
  const frames = [];
  for (let f = 0; f < geom.frames; f++) {
    const frameWords = words.slice(f * cellsPerFrame, (f + 1) * cellsPerFrame);
    const cells = order.map((i) => decodeWord(frameWords[i]));
    if (cells.every((c) => c.empty)) continue;
    frames.push({ w: geom.w, h: geom.h, cells });
  }
  return frames.length ? { stage, sizeClass, w: geom.w, h: geom.h, frames } : null;
}
function renderFrame(sections, palettes, frame) {
  const pxW = frame.w * CG_CELL_DIM;
  const pxH = frame.h * CG_CELL_DIM;
  const indexed = new Uint8Array(pxW * pxH);
  frame.cells.forEach((c, i) => {
    if (c.empty) return;
    const cell = cellIndexed(sections, c.cell);
    const ox = i % frame.w * CG_CELL_DIM;
    const oy = (i / frame.w | 0) * CG_CELL_DIM;
    for (let y = 0; y < CG_CELL_DIM; y++) {
      for (let x = 0; x < CG_CELL_DIM; x++) {
        const sx = c.hflip ? CG_CELL_DIM - 1 - x : x;
        const sy = c.vflip ? CG_CELL_DIM - 1 - y : y;
        indexed[(oy + y) * pxW + ox + x] = cell[sy * CG_CELL_DIM + sx];
      }
    }
  });
  return { w: pxW, h: pxH, rgba: indexedToRgba(indexed, palettes) };
}
function findPlaceholderCell(sec5, stageCount = 10) {
  const { offset, stride } = SEC5_REGIONS.spriteStages;
  const freq = /* @__PURE__ */ new Map();
  for (let st = 0; st < stageCount; st++) {
    for (let i = 0; i < stride / 2; i++) {
      const at = offset + st * stride + i * 2;
      const word = (sec5[at] << 8 | sec5[at + 1]) & 65535;
      if (word === EMPTY_REF) continue;
      const cell = word & 1023;
      freq.set(cell, (freq.get(cell) || 0) + 1);
    }
  }
  let best = null;
  let bestN = 0;
  for (const [cell, n] of freq) if (n > bestN) {
    best = cell;
    bestN = n;
  }
  return { cell: best, count: bestN };
}
function isUnpainted(art, placeholder) {
  if (placeholder === null) return false;
  return art.frames.every((f) => f.cells.every((c) => c.empty || c.cell === placeholder));
}
function artSignature(art) {
  return art.frames.map((f) => f.cells.map((c) => c.empty ? "-" : `${c.cell}${c.hflip ? "h" : ""}${c.vflip ? "v" : ""}`).join(",")).join("|");
}
function extractEnemySprites(sec5, sections, palettes, enemies, stagesPlacing) {
  const sprites = [];
  const spriteKeysByEnemy = /* @__PURE__ */ new Map();
  const bySignature = /* @__PURE__ */ new Map();
  const placeholder = findPlaceholderCell(sec5).cell;
  for (const enemy of enemies) {
    const fallbacks = stagesPlacing.get(enemy.record) || [];
    const candidates = [enemy.stage, ...fallbacks.filter((s) => s !== enemy.stage)];
    let art = null;
    for (const stage of candidates) {
      if (stage === void 0) continue;
      const a = readEnemyFrames(sec5, stage, enemy.record);
      if (!a) continue;
      if (!isUnpainted(a, placeholder)) {
        art = a;
        break;
      }
      if (!art) art = a;
    }
    if (!art || isUnpainted(art, placeholder)) continue;
    const sig = artSignature(art);
    const shared = bySignature.get(sig);
    if (shared) {
      spriteKeysByEnemy.set(enemy.key, shared);
      continue;
    }
    const keys = [];
    art.frames.forEach((frame, i) => {
      const { w, h, rgba } = renderFrame(sections, palettes, frame);
      let opaque = false;
      for (let p = 3; p < rgba.length; p += 4) if (rgba[p]) {
        opaque = true;
        break;
      }
      if (!opaque) return;
      keys.push(sprites.length);
      sprites.push({ key: `${enemy.name}_${i}`, w, h, rgba });
    });
    if (!keys.length) continue;
    bySignature.set(sig, keys);
    spriteKeysByEnemy.set(enemy.key, keys);
  }
  return { sprites, spriteKeysByEnemy };
}
function extractBackgroundCells(backgrounds, sections, palettes, stageCount) {
  const ordinalByCell = /* @__PURE__ */ new Map();
  const cells = [];
  const stages = [];
  for (let s = 0; s < stageCount; s++) {
    const bg = backgrounds[s];
    if (!bg || bg.empty) {
      stages.push(null);
      continue;
    }
    let lastRow = -1;
    for (let i = 0; i < bg.tiles.length; i++) {
      if (bg.tiles[i]) lastRow = Math.max(lastRow, i / bg.cols | 0);
    }
    if (lastRow < 0) {
      stages.push(null);
      continue;
    }
    const rows = lastRow + 1;
    const words = new Uint16Array(rows * bg.cols).fill(65535);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < bg.cols; c++) {
        const t = bg.tiles[r * bg.cols + c];
        if (!t) continue;
        if (!ordinalByCell.has(t.cell)) {
          ordinalByCell.set(t.cell, cells.length);
          const indexed = cellIndexed(sections, t.cell);
          cells.push({
            key: `dezaBgCell${t.cell}`,
            w: CG_CELL_DIM,
            h: CG_CELL_DIM,
            rgba: indexedToRgba(indexed, palettes)
          });
        }
        words[r * bg.cols + c] = ordinalByCell.get(t.cell) | (t.hflip ? 32768 : 0) | (t.vflip ? 16384 : 0);
      }
    }
    stages.push({ rows, cols: bg.cols, words });
  }
  return { cells, stages };
}
var TITLE_SLOTS = {
  title1: { first: 144, w: 8, h: 4 },
  title2: { first: 176, w: 8, h: 4 },
  credits: [
    { first: 208, w: 4, h: 1 },
    { first: 212, w: 4, h: 1 },
    { first: 216, w: 4, h: 1 },
    { first: 220, w: 4, h: 1 },
    { first: 224, w: 4, h: 1 },
    { first: 228, w: 4, h: 1 }
  ]
};
function readBankComposition(sec5, slot) {
  const { offset } = SEC5_REGIONS.spriteBank;
  const cells = [];
  for (let i = 0; i < slot.w * slot.h; i++) {
    const at = offset + (slot.first + i) * 2;
    cells.push(decodeWord(sec5[at] << 8 | sec5[at + 1]));
  }
  if (cells.every((c) => c.empty)) return null;
  return { w: slot.w, h: slot.h, cells };
}
function trimRgba(img) {
  let minX = img.w, minY = img.h, maxX = -1, maxY = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.rgba[(y * img.w + x) * 4 + 3]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((minY + y) * img.w + minX) * 4;
    rgba.set(img.rgba.subarray(src, src + w * 4), y * w * 4);
  }
  return { w, h, rgba };
}
function extractTitleArt(sec5, sections, palettes, baseIndex) {
  const sprites = [];
  const roles = {};
  const placeholder = findPlaceholderCell(sec5).cell;
  const renderSlot = (slot) => {
    const comp = readBankComposition(sec5, slot);
    if (!comp || isUnpainted({ frames: [comp] }, placeholder)) return null;
    return trimRgba(renderFrame(sections, palettes, comp));
  };
  const title1 = renderSlot(TITLE_SLOTS.title1);
  if (title1) {
    roles.title1 = baseIndex + sprites.length;
    sprites.push({ key: "dezaTitle1", ...title1 });
  }
  const title2 = renderSlot(TITLE_SLOTS.title2);
  if (title2) {
    roles.title2 = baseIndex + sprites.length;
    sprites.push({ key: "dezaTitle2", ...title2 });
  }
  const lines = [];
  const seen = /* @__PURE__ */ new Set();
  for (const slot of TITLE_SLOTS.credits) {
    const line = renderSlot(slot);
    if (!line) continue;
    const sig = line.rgba.join();
    if (seen.has(sig)) continue;
    seen.add(sig);
    lines.push(line);
  }
  if (lines.length) {
    const w = Math.max(...lines.map((l) => l.w));
    const h = lines.reduce((sum, l) => sum + l.h, 0);
    const rgba = new Uint8ClampedArray(w * h * 4);
    let y = 0;
    for (const line of lines) {
      const x0 = w - line.w >> 1;
      for (let ly = 0; ly < line.h; ly++) {
        rgba.set(
          line.rgba.subarray(ly * line.w * 4, (ly + 1) * line.w * 4),
          ((y + ly) * w + x0) * 4
        );
      }
      y += line.h;
    }
    roles.credit = baseIndex + sprites.length;
    sprites.push({ key: "dezaCredit", w, h, rgba });
  }
  return { sprites, roles };
}
var GLOBAL_ART_SLOTS = {
  playerIdle: { first: 8, w: 2, h: 2, frames: 2 },
  playerBankA: { first: 0, w: 2, h: 2, frames: 2 },
  playerBankB: { first: 16, w: 2, h: 2, frames: 2 },
  blastA: { first: 102, w: 1, h: 1, frames: 6 },
  blastB: { first: 108, w: 2, h: 2, frames: 6 }
};
function extractGlobalArt(sec5, sections, palettes, baseIndex) {
  const sprites = [];
  const roles = {};
  const placeholder = findPlaceholderCell(sec5).cell;
  const renderCells = (first, w, h) => {
    const comp = readBankComposition(sec5, { first, w, h });
    if (!comp || isUnpainted({ frames: [comp] }, placeholder)) return null;
    return renderFrame(sections, palettes, comp);
  };
  const pushFrames = (name, slot) => {
    const cells = slot.w * slot.h;
    const out = [];
    for (let f = 0; f < slot.frames; f++) {
      const img = renderCells(slot.first + f * cells, slot.w, slot.h);
      if (!img) return null;
      out.push(baseIndex + sprites.length);
      sprites.push({ key: `${name}${f}`, ...img });
    }
    return out;
  };
  const idle = pushFrames("dezaShip", GLOBAL_ART_SLOTS.playerIdle);
  if (idle) {
    roles.player = { idle };
    const bankA = pushFrames("dezaShipL", GLOBAL_ART_SLOTS.playerBankA);
    const bankB = pushFrames("dezaShipR", GLOBAL_ART_SLOTS.playerBankB);
    if (bankA) roles.player.bankA = bankA;
    if (bankB) roles.player.bankB = bankB;
  }
  const icons = [];
  for (let i = 0; i < 8; i++) {
    const img = renderCells(94 + i, 1, 1);
    if (img) {
      icons[i] = baseIndex + sprites.length;
      sprites.push({ key: `dezaItem${i}`, ...img });
    } else {
      icons[i] = null;
    }
  }
  if (icons.some((i) => i !== null)) roles.items = icons;
  const blastA = pushFrames("dezaBlastA", GLOBAL_ART_SLOTS.blastA);
  if (blastA) roles.blastA = blastA;
  const blastB = pushFrames("dezaBlastB", GLOBAL_ART_SLOTS.blastB);
  if (blastB) roles.blastB = blastB;
  const bullets = [];
  for (let t = 0; t < 3; t++) {
    const frames = pushFrames(`dezaBullet${t}_`, {
      first: 132 + t * 4,
      w: 1,
      h: 1,
      frames: 4
    });
    bullets[t] = frames;
  }
  if (bullets.some(Boolean)) roles.bullets = bullets;
  return { sprites, roles };
}
function extractBossSprites(sec5, sections, palettes, bosses) {
  const sprites = [];
  const spriteKeysByStage = /* @__PURE__ */ new Map();
  const placeholder = findPlaceholderCell(sec5).cell;
  const emit = (stage, frames, core) => {
    const keys = [];
    frames.forEach((frame) => {
      const { w, h, rgba } = renderFrame(sections, palettes, frame);
      let opaque = false;
      for (let p = 3; p < rgba.length; p += 4) if (rgba[p]) {
        opaque = true;
        break;
      }
      if (!opaque) return;
      keys.push(sprites.length);
      sprites.push({ key: `dezaBoss${stage}_${keys.length - 1}`, w, h, rgba });
    });
    if (keys.length) spriteKeysByStage.set(stage, { keys, core });
  };
  for (const { stage, sizeClass } of bosses) {
    const core = readBossCore(sec5, stage, sizeClass);
    if (core && !isUnpainted(core, placeholder)) {
      emit(stage, core.frames, true);
      continue;
    }
    const pieces = [];
    for (let record = 56; record <= 59 && pieces.length < 2; record++) {
      const art = readEnemyFrames(sec5, stage, record);
      if (!art || isUnpainted(art, placeholder)) continue;
      pieces.push(art.frames[0]);
    }
    emit(stage, pieces, false);
  }
  return { sprites, spriteKeysByStage };
}
function extractBossPartSprites(sec5, sections, palettes, bosses, enemies, baseIndex) {
  const sprites = [];
  const partKeysByStage = /* @__PURE__ */ new Map();
  const placeholder = findPlaceholderCell(sec5).cell;
  const byPair = /* @__PURE__ */ new Map();
  for (const e of enemies || []) {
    if (e.spriteKeys && e.spriteKeys.length) byPair.set(`${e.stage}:${e.record}`, e.spriteKeys);
  }
  const bySignature = /* @__PURE__ */ new Map();
  for (const boss of bosses) {
    if (!boss.behavior) continue;
    const records = /* @__PURE__ */ new Set();
    for (const pattern of boss.behavior.patterns) {
      for (const fp of pattern.firePoints) {
        if (fp.spawn && fp.spawn.record != null) records.add(fp.spawn.record);
      }
    }
    const art = {};
    for (const record of records) {
      const existing = byPair.get(`${boss.stage}:${record}`);
      if (existing) {
        art[record] = existing;
        continue;
      }
      const a = readEnemyFrames(sec5, boss.stage, record);
      if (!a || isUnpainted(a, placeholder)) continue;
      const sig = artSignature(a);
      const shared = bySignature.get(sig);
      if (shared) {
        art[record] = shared;
        continue;
      }
      const keys = [];
      a.frames.forEach((frame, i) => {
        const { w, h, rgba } = renderFrame(sections, palettes, frame);
        let opaque = false;
        for (let p = 3; p < rgba.length; p += 4) if (rgba[p]) {
          opaque = true;
          break;
        }
        if (!opaque) return;
        keys.push(baseIndex + sprites.length);
        sprites.push({ key: `dezaPart${boss.stage}_${record}_${i}`, w, h, rgba });
      });
      if (!keys.length) continue;
      bySignature.set(sig, keys);
      art[record] = keys;
    }
    if (Object.keys(art).length) partKeysByStage.set(boss.stage, art);
  }
  return { sprites, partKeysByStage };
}

// packages/shmup-engine/src/decode/decode-boss.js
var BOSS_TRAILER_OFFSET = 1080;
var BOSS_TRAILER_SIZE = 64;
var BOSS_HP_TABLE = [1024e3, 1536e3, 2304e3, 3328e3, 4608e3, 6144e3, 7936e3, 9984e3];
var BOSS_SCORE_TABLE = [5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6];
var BOSS_FIRE_TICK_FRAMES = [60, 30, 15, 10, 5, 3, 2, 1];
var PART_GROUPS = ["zako16x16", "zako32x16", "zako16x32", "zako32x32", "part64x32", "part32x64", "part64x64"];
var s8 = (b) => b >= 128 ? b - 256 : b;
function partRecord(group, piece) {
  const band = RECORD_ART[group];
  if (!band) return null;
  return band.first + piece % band.count;
}
function decodeFirePoint(f) {
  const type = f[2] & 7;
  const fp = {
    dx: s8(f[0]),
    dy: s8(f[1]),
    type,
    rate: f[2] >> 4 & 7,
    param: f[3]
  };
  if (type === 3 || type === 4) {
    const group = f[3] >> 4 & 7;
    fp.spawn = {
      group: PART_GROUPS[group],
      piece: f[3] & 15,
      record: partRecord(group, f[3] & 15),
      oneShot: type === 4
    };
  } else if (type <= 2) {
    fp.shot = {
      weapon: type,
      // A/B/C
      fn: f[3] & 15,
      aimed: (f[3] & 16) !== 0,
      arg: f[3] >> 5
    };
  }
  return fp;
}
function decodeBossTrailer(t) {
  if (!t || t.length < BOSS_TRAILER_SIZE) return null;
  let any = false;
  for (let i = 0; i < BOSS_TRAILER_SIZE; i++) if (t[i]) {
    any = true;
    break;
  }
  if (!any) return null;
  const patterns = [];
  for (let p = 0; p < 4; p++) {
    const r = t.subarray ? t.subarray(8 + p * 14, 8 + p * 14 + 14) : t.slice(8 + p * 14, 8 + p * 14 + 14);
    patterns.push({
      moveScript: r[0] >> 3,
      moveSpeed: r[0] & 7,
      fireTickFrames: BOSS_FIRE_TICK_FRAMES[r[1] & 7],
      firePoints: [0, 1, 2].map((i) => decodeFirePoint(r.subarray ? r.subarray(2 + i * 4, 6 + i * 4) : r.slice(2 + i * 4, 6 + i * 4)))
    });
  }
  return {
    sizeClass: t[0] & 3,
    hpStages: (t[0] >> 4 & 3) + 1,
    rotate: (t[0] & 64) !== 0,
    deathSpin: (t[0] & 128) !== 0,
    hp: BOSS_HP_TABLE[t[1] & 7],
    score: BOSS_SCORE_TABLE[t[1] >> 4 & 7],
    optionFlag: (t[1] >> 3 & 1) === 0,
    // stored inverted by the editor
    // per HP stage, the loop of four pattern ids (LSB-first)
    playlist: [t[2], t[3], t[4], t[5]].map((b) => [b & 3, b >> 2 & 3, b >> 4 & 3, b >> 6 & 3]),
    arrive: t[6],
    death: t[7],
    patterns
  };
}
function readBossTrailer(sec5, stage) {
  const { offset, stride } = SEC5_REGIONS.enemies;
  const base = offset + stage * stride + BOSS_TRAILER_OFFSET;
  return decodeBossTrailer(sec5.subarray(base, base + BOSS_TRAILER_SIZE));
}

// packages/shmup-engine/src/decode/decode-model.js
var SEC7_MAGIC = 305419896;
var MODEL_SLOTS = 16;
var MODEL_SLOT_SIZE = 328;
var MAX_PARTS = 9;
var PART_SIZE = 36;
var u16 = (b, o) => b[o] << 8 | b[o + 1];
var s32 = (b, o) => b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3] | 0;
function decodePart(bytes, off) {
  const shape = u16(bytes, off);
  return {
    shape,
    // Observed families across the disc corpus: 0x0-0x5 in the high
    // nibble with variant bits below. Which family is which primitive
    // (cube/cylinder/cone/sphere/plane) awaits a POLYKITI mesh trace, so
    // the split is carried as data, not names.
    shapeFamily: shape >> 12 & 15,
    shapeVariant: shape & 4095,
    position: {
      x: s32(bytes, off + 4) / 65536,
      y: s32(bytes, off + 8) / 65536,
      z: s32(bytes, off + 12) / 65536
    },
    // degrees, engine-stored as a u16 circle (65536 = 360)
    rotation: {
      x: u16(bytes, off + 16) * 360 / 65536,
      y: u16(bytes, off + 18) * 360 / 65536,
      z: u16(bytes, off + 20) * 360 / 65536
    },
    // x1.0 = 1; a negative scale mirrors its axis
    scale: {
      x: s32(bytes, off + 24) / 65536,
      y: s32(bytes, off + 28) / 65536,
      z: s32(bytes, off + 32) / 65536
    }
  };
}
function decodeModels(sec7) {
  if (!sec7 || sec7.length < 4 + MODEL_SLOTS * MODEL_SLOT_SIZE) return null;
  const magic = s32(sec7, 0) >>> 0;
  if (magic !== SEC7_MAGIC) return null;
  const models = [];
  for (let slot = 0; slot < MODEL_SLOTS; slot++) {
    const base = 4 + slot * MODEL_SLOT_SIZE;
    const partCount = u16(sec7, base);
    if (partCount === 0 || partCount > MAX_PARTS) continue;
    const parts = [];
    for (let p = 0; p < partCount; p++) {
      parts.push(decodePart(sec7, base + 4 + p * PART_SIZE));
    }
    models.push({
      slot,
      // RGB555 like the palette bank (R bits 0-4, G 5-9, B 10-14)
      color: u16(sec7, base + 2),
      parts
    });
  }
  return { models };
}

// packages/shmup-engine/src/decode/index.js
function decodeSave(payload) {
  const result = {
    title: null,
    confidence: {},
    cg: null,
    // {palettes, pages} from decode-cg.js (art pages + palette bank)
    cgError: null,
    backgrounds: null,
    // per-stage background tilemaps from decode-stage.js
    backgroundError: null,
    stageCount: 0,
    songs: null,
    // 24 BGM slots from decode-song.js
    songError: null,
    songCount: 0,
    sprites: [],
    // {key, w, h, rgba: Uint8ClampedArray}
    enemies: [],
    // {name, stage, record, bytes, placements, spriteKeys?}
    stages: [],
    // {rows, waveRows, cols, boss, items} in spawn order
    bosses: [],
    // {stage, sizeClass, row, col, spriteKeys?}
    bgCells: [],
    // distinct background tiles: {key, w, h, rgba}
    bgStages: [],
    // per stage: {rows, cols, words: Uint16Array} | null
    regions: [],
    // {name, offset, length, decoded, decompressedSize?}
    sections: null,
    tableError: null
  };
  try {
    const table = parseSectionTable(payload);
    result.sections = table.sections.map((s) => {
      const compressed = payload.subarray(s.offset, s.offset + s.size);
      let decompressed = null;
      let decompressError = null;
      try {
        decompressed = decompress(compressed);
      } catch (err) {
        decompressError = err.message;
      }
      return {
        index: s.index,
        size: s.size,
        checksum: s.checksum,
        addr: s.addr,
        offset: s.offset,
        decompressedSize: decompressed ? decompressed.length : null,
        sizeMatchesKnown: decompressed ? decompressed.length === SECTION_SIZES[s.index] : false,
        hint: SECTION_HINTS[s.index],
        decompressed,
        decompressError
      };
    });
    result.confidence.decompression = result.sections.every((s) => s.sizeMatchesKnown) ? "confirmed" : "heuristic";
    const cgSections = [0, 1, 2, 3].map((i) => result.sections[i]);
    const palSection = result.sections[4];
    if (cgSections.every((s) => s?.sizeMatchesKnown) && palSection?.sizeMatchesKnown) {
      try {
        result.cg = decodeCg(cgSections.map((s) => s.decompressed), palSection.decompressed);
        result.confidence.cg = "confirmed";
      } catch (err) {
        result.cgError = err.message;
      }
    }
    const assembly = result.sections[5];
    if (assembly?.sizeMatchesKnown) {
      try {
        const { stages, stageCount } = decodeStages(assembly.decompressed);
        result.backgrounds = stages;
        result.stageCount = stageCount;
        result.confidence.backgrounds = "confirmed";
        result.sec5Regions = sec5Regions(assembly.decompressed);
        try {
          result.settings = decodeSettings(assembly.decompressed);
          result.confidence.settings = result.settings.confidence.mainWeapon;
        } catch (err) {
          result.settingsError = err.message;
        }
        const projected = projectForEditor(stages.slice(0, stageCount), {
          itemSlots: result.settings ? result.settings.itemSlots : null
        });
        result.enemies = projected.enemies;
        result.stages = projected.stages;
        result.bosses = projected.stages.map((st, stage) => st.boss ? {
          stage,
          sizeClass: st.boss.sizeClass,
          row: st.boss.row,
          col: st.boss.col,
          behavior: readBossTrailer(assembly.decompressed, stage)
        } : null).filter(Boolean);
        result.confidence.enemies = "confirmed";
        result.confidence.attributes = "confirmed";
        result.confidence.stages = "confirmed";
        if (result.cg) {
          try {
            const cgPages = result.sections.slice(0, 4).map((s) => s.decompressed);
            const { sprites, spriteKeysByEnemy } = extractEnemySprites(
              assembly.decompressed,
              cgPages,
              result.cg.palettes,
              result.enemies,
              projected.stagesUsing
            );
            for (const e of result.enemies) {
              const keys = spriteKeysByEnemy.get(e.key);
              if (keys) e.spriteKeys = keys;
            }
            const boss = extractBossSprites(
              assembly.decompressed,
              cgPages,
              result.cg.palettes,
              result.bosses
            );
            for (const b of result.bosses) {
              const entry = boss.spriteKeysByStage.get(b.stage);
              if (entry) {
                b.spriteKeys = entry.keys.map((i) => i + sprites.length);
                b.coreArt = entry.core;
              }
            }
            const parts = extractBossPartSprites(
              assembly.decompressed,
              cgPages,
              result.cg.palettes,
              result.bosses,
              result.enemies,
              sprites.length + boss.sprites.length
            );
            for (const b of result.bosses) {
              const partArt = parts.partKeysByStage.get(b.stage);
              if (partArt) b.partArt = partArt;
            }
            const titleArt = extractTitleArt(
              assembly.decompressed,
              cgPages,
              result.cg.palettes,
              sprites.length + boss.sprites.length + parts.sprites.length
            );
            if (Object.keys(titleArt.roles).length) {
              result.titleArt = titleArt.roles;
            }
            const globalArt = extractGlobalArt(
              assembly.decompressed,
              cgPages,
              result.cg.palettes,
              sprites.length + boss.sprites.length + parts.sprites.length + titleArt.sprites.length
            );
            if (Object.keys(globalArt.roles).length) {
              result.globalArt = globalArt.roles;
            }
            result.sprites = sprites.concat(boss.sprites, parts.sprites, titleArt.sprites, globalArt.sprites);
            if (result.sprites.length) result.confidence.sprites = "heuristic";
            const bg = extractBackgroundCells(
              result.backgrounds,
              cgPages,
              result.cg.palettes,
              stageCount
            );
            result.bgCells = bg.cells;
            result.bgStages = bg.stages;
          } catch (err) {
            result.spriteError = err.message;
          }
        }
      } catch (err) {
        result.backgroundError = err.message;
      }
    }
    const bgm = result.sections[6];
    if (bgm?.sizeMatchesKnown) {
      try {
        const { songs, usedCount } = decodeSongs(bgm.decompressed);
        result.songs = songs;
        result.songCount = usedCount;
        result.confidence.songs = "confirmed";
      } catch (err) {
        result.songError = err.message;
      }
    }
    const modelSection = result.sections[7];
    if (modelSection?.sizeMatchesKnown) {
      try {
        result.models = decodeModels(modelSection.decompressed);
        if (result.models) result.confidence.models = "confirmed";
      } catch (err) {
        result.modelError = err.message;
      }
    }
    result.regions = result.sections.map((s) => ({
      name: `sec${s.index}: ${s.hint}`,
      offset: s.offset,
      length: s.size,
      decoded: Boolean(result.cg) && s.index <= 4 || Boolean(result.backgrounds) && s.index === 5 || Boolean(result.songs) && s.index === 6 || Boolean(result.models) && s.index === 7,
      decompressedSize: s.decompressedSize
    }));
  } catch (err) {
    result.tableError = err.message;
    result.regions = [{ name: "payload", offset: 0, length: payload.length, decoded: false }];
  }
  return result;
}

// packages/shmup-engine/src/atlas-pack.js
function packShelf(items, { maxWidth = 2048, pad = 4 } = {}) {
  const sorted = items.slice().sort((a, b) => b.h - a.h);
  let cx = pad;
  let cy = pad;
  let rowH = 0;
  let fullH = 0;
  const placements = {};
  const frames = {};
  for (const s of sorted) {
    if (cx + s.w + pad > maxWidth) {
      cy += rowH + pad;
      cx = pad;
      rowH = 0;
    }
    placements[s.key] = { x: cx, y: cy };
    cx += s.w + pad;
    rowH = Math.max(rowH, s.h);
    fullH = Math.max(fullH, cy + s.h + pad);
  }
  for (const s of sorted) {
    const p = placements[s.key];
    frames[s.key] = {
      frame: { x: p.x, y: p.y, w: s.w, h: s.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: s.w, h: s.h },
      sourceSize: { w: s.w, h: s.h }
    };
  }
  return {
    width: maxWidth,
    height: fullH,
    placements,
    frames,
    order: sorted.map((s) => s.key)
  };
}

// packages/shmup-engine/src/game-schema.js
var CELL_RE = /^(00|[A-Z]+[0-9])$/;
var ENEMY_KEY_RE = /^enemy[A-Z]+$/;
var BOSS_KEY_RE = /^boss(\d+|Extra)$/;
var STAGE_KEY_RE = /^stage(\d+)$/;
var MAX_STAGE_ID = 9;
var MAX_GRID_COLS = 20;
function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isTextureArray(v) {
  return Array.isArray(v) && v.length > 0 && v.every((t) => typeof t === "string" && t.length > 0);
}
function validateGameJson(g) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  if (!isObj(g)) {
    return { ok: false, errors: ["game.json root must be an object"], warnings };
  }
  const enemyLetters2 = /* @__PURE__ */ new Set();
  if (!isObj(g.enemyData)) {
    err("enemyData must be an object");
  } else {
    const keys = Object.keys(g.enemyData);
    for (const k of keys) {
      if (!ENEMY_KEY_RE.test(k)) {
        err(`enemyData key "${k}" must match enemy[A-Z]+`);
        continue;
      }
      enemyLetters2.add(k.slice(5));
      const e = g.enemyData[k];
      if (!isObj(e)) {
        err(`${k} must be an object`);
        continue;
      }
      if (!Number.isFinite(e.hp) && e.hp !== "infinity") err(`${k}.hp must be a number or "infinity"`);
      if (!Number.isFinite(e.score)) err(`${k}.score must be a number`);
      if (!isTextureArray(e.texture)) err(`${k}.texture must be a non-empty string array`);
    }
  }
  const stageKeys = Object.keys(g).filter((k) => STAGE_KEY_RE.test(k));
  if (!g.stage0) err("stage0 is required");
  for (const k of stageKeys) {
    const num = Number(k.match(STAGE_KEY_RE)[1]);
    if (num > MAX_STAGE_ID) {
      warn(`${k} is unreachable in Phaser (BootScene clamps stages to 0..${MAX_STAGE_ID})`);
    }
    const st = g[k];
    if (!isObj(st) || !Array.isArray(st.enemylist) || st.enemylist.length === 0) {
      err(`${k}.enemylist must be a non-empty array of rows`);
      continue;
    }
    const width = Array.isArray(st.enemylist[0]) ? st.enemylist[0].length : 0;
    if (!(width >= 1 && width <= MAX_GRID_COLS)) {
      err(`${k}.enemylist rows must be 1..${MAX_GRID_COLS} cells wide (got ${width})`);
      continue;
    }
    st.enemylist.forEach((row, r) => {
      if (!Array.isArray(row) || row.length !== width) {
        err(`${k}.enemylist[${r}] must be an array of exactly ${width} cells`);
        return;
      }
      row.forEach((cell, c) => {
        if (typeof cell !== "string" || !CELL_RE.test(cell)) {
          err(`${k}.enemylist[${r}][${c}] = ${JSON.stringify(cell)} is not "00" or "<A-Z\u2026><0-9>"`);
        } else if (cell !== "00" && !enemyLetters2.has(cell.slice(0, -1))) {
          err(`${k}.enemylist[${r}][${c}] references enemy${cell.slice(0, -1)}, which is not in enemyData`);
        }
      });
    });
    if (st.waveRows !== void 0) {
      if (!Array.isArray(st.waveRows) || st.waveRows.length !== st.enemylist.length) {
        err(`${k}.waveRows must have one entry per wave (${st.enemylist.length})`);
      } else if (!st.waveRows.every((n) => Number.isInteger(n) && n >= 0)) {
        err(`${k}.waveRows entries must be non-negative integers`);
      }
    }
    if (st.waveInterval !== void 0 && !(Number.isFinite(st.waveInterval) && st.waveInterval > 0)) {
      err(`${k}.waveInterval must be a positive number`);
    }
    if (st.background !== void 0) {
      const bg = st.background;
      if (!isObj(bg) || !Number.isInteger(bg.cols) || !Number.isInteger(bg.rows) || bg.cols < 1 || bg.rows < 1 || typeof bg.tiles !== "string") {
        err(`${k}.background must be {cols, rows, tiles} with a base64 tile grid`);
      } else if (!Array.isArray(g.backgroundCells) || g.backgroundCells.length === 0) {
        err(`${k}.background needs a non-empty top-level backgroundCells list`);
      } else {
        const expect = Math.ceil(bg.rows * bg.cols * 2 / 3) * 4;
        if (bg.tiles.length !== expect) {
          err(`${k}.background.tiles is ${bg.tiles.length} chars; ${bg.rows}x${bg.cols} words need ${expect}`);
        }
      }
    }
  }
  if (!isObj(g.playerData)) {
    err("playerData must be an object");
  } else {
    const p = g.playerData;
    if (!Number.isFinite(p.maxHp)) err("playerData.maxHp must be a number");
    if (!isTextureArray(p.texture)) err("playerData.texture must be a non-empty string array");
    for (const shoot of ["shootNormal", "shootBig", "shoot3way"]) {
      if (!isObj(p[shoot]) || !isTextureArray(p[shoot].texture)) {
        err(`playerData.${shoot} must be an object with a non-empty texture array`);
      }
    }
    if (!isObj(p.barrier) || !isTextureArray(p.barrier.texture)) {
      err("playerData.barrier must be an object with a non-empty texture array");
    }
  }
  if (!isObj(g.bossData)) {
    err("bossData must be an object");
  } else {
    for (const [k, b] of Object.entries(g.bossData)) {
      if (!BOSS_KEY_RE.test(k)) {
        err(`bossData key "${k}" must match boss<N>/bossExtra`);
        continue;
      }
      if (!isObj(b)) {
        err(`${k} must be an object`);
        continue;
      }
      if (!Number.isFinite(b.hp)) err(`${k}.hp must be a number`);
      if (!isObj(b.anim) || !isTextureArray(b.anim.idle)) err(`${k}.anim.idle must be a non-empty string array`);
    }
    for (const k of stageKeys) {
      const num = Number(k.match(STAGE_KEY_RE)[1]);
      if (num <= MAX_STAGE_ID && !g.bossData[`boss${num}`]) warn(`${k} has no matching boss${num} \u2014 boss spawn will fail`);
    }
  }
  if (!isObj(g.meta) || typeof g.meta.version !== "string") err("meta.version must be a string");
  return { ok: errors.length === 0, errors, warnings };
}

// packages/shmup-engine/src/diff-ranges.js
function coalesceDiffRanges(a, b, minGap = 8) {
  const n = Math.min(a.length, b.length);
  const ranges = [];
  let runStart = -1;
  let lastDiff = -1;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      if (runStart === -1) runStart = i;
      else if (i - lastDiff > minGap) {
        ranges.push([runStart, lastDiff]);
        runStart = i;
      }
      lastDiff = i;
    }
  }
  if (runStart !== -1) ranges.push([runStart, lastDiff]);
  return ranges;
}
function totalDiffBytes(ranges) {
  let total = 0;
  for (const [s, e] of ranges) total += e - s + 1;
  return total;
}
export {
  BLANK_WAVES,
  BUILTIN_DEFAULTS,
  DUKE_PLAYER,
  ENEMY_BULLET_SPEED,
  ENGINE_SHOT_DAMAGE,
  ENTRY_FLAG,
  EVIL_INVADERS_PLAYER,
  FRAMES_PER_SOURCE_ROW,
  GRID_COLS,
  MAGIC,
  MAX_STAGES2 as MAX_STAGES,
  MODEL_SLOTS,
  PLAYER_SHOT_DAMAGE_BY_LEVEL,
  SEC7_MAGIC,
  SECTION_COUNT,
  SECTION_HINTS,
  SECTION_SIZES,
  SINGLE_LETTER_ENEMIES,
  TABLE_SIZE,
  buildBlankGame,
  bupDateToDate,
  byteSum,
  coalesceDiffRanges,
  decodeModels,
  decodePlayerArt,
  decodeSave,
  decompress,
  deinterleave,
  detect,
  detectPartitions,
  emptyWave,
  enemyLetters,
  extractPayload,
  findEntries,
  gunzip,
  isGameSave,
  isGzip,
  mapSaveToGame,
  normalize,
  packShelf,
  parse,
  parseEntry,
  parseSectionTable,
  totalDiffBytes,
  validateGameJson,
  validateSectionTable
};
