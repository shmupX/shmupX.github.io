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

// packages/shmup-engine/src/player2-art.js
var TROOPER_PALETTE = [
  0,
  185273343,
  252645375,
  286331391,
  303174399,
  336860159,
  353703423,
  370546431,
  387389439,
  404232447,
  421075455,
  437918463,
  454761471,
  471604479,
  488447487,
  505290495,
  522133503,
  538910719,
  538976511,
  555819519,
  572662527,
  589439743,
  589505535,
  606348543,
  623191295,
  623191551,
  639968767,
  640034559,
  656745727,
  656877567,
  673720575,
  690563583,
  690497791,
  707406591,
  724117503,
  757737727,
  824912383,
  724249599,
  741092351,
  741092607,
  757935615,
  791555583,
  774778623,
  791621631,
  808464639,
  825241855,
  825307647,
  858861567,
  842150655,
  858993663,
  875836671,
  892679679,
  909522687,
  993210367,
  993474047,
  926365695,
  943208703,
  960051711,
  976894719,
  993737471,
  993737727,
  1010580735,
  1027423743,
  1044266495,
  1044266751,
  1061109759,
  1077952767,
  1094795775,
  1111638783,
  1128481791,
  1145324799,
  1212037631,
  1162167807,
  1179010815,
  1195853823,
  1212696831,
  1229539839,
  1246382847,
  1263225855,
  1280068863,
  1329807103,
  1330202623,
  1296911871,
  1313754879,
  1330597887,
  1347440895,
  1364283903,
  1430930687,
  1397837823,
  1397969919,
  1414812927,
  1582320383,
  1632915455,
  1700221439,
  1784304639,
  1431655935,
  1448498943,
  1465341951,
  1482184959,
  1499027967,
  1532713983,
  1566399999,
  1583243007,
  1600086015,
  1734171135,
  1633772031,
  1667458047,
  1701144063,
  1751673087,
  1802202111,
  1835888127,
  1885296383,
  1902205695,
  1952734719,
  2036817919,
  1886219519,
  2087478527,
  2154718463,
  2205247999,
  1886417151,
  1920103167,
  1953789183,
  1987475199,
  2054781439,
  2122153471,
  2172748287,
  2223277311,
  2272553983,
  2339859711,
  2373612031,
  2440917759,
  2323939839,
  2307492351,
  2358021375,
  2425393407,
  2508290047,
  2642836223,
  2676654079,
  2593164543,
  2794423295,
  2794621439,
  2912390655,
  3047002623,
  2543294463,
  2644352511,
  2779096575,
  2880154623,
  3080754687,
  3131415807,
  3265896191,
  3417351167,
  2998055679,
  3082270719,
  3200171775,
  3334915839,
  3536438783,
  3520188927,
  3621246975,
  3840206079
];
var TROOPER_FRAMES = [
  { key: "trooper_0", w: 28, h: 40, rle: "ABCYAWkBABqaAXcBABqcAXcBABqcAXcBABqdAXcBHQEZAQAXZAGeAXcBIQEAEEYBVgFCAQAFZAGeAW0BHwEZAQAOMQFqAXoBYwErAQADQwFOAZ4BbQEeARcBAA4sAW4BhAFnATIBAAJBASABRgGeAW0BKAEeAQAOHgFrAYQBZgEzAX8BSwFUARcBVAGdAW4BABATAWQBggGNAZQBlgF2ATMBBwFMAZwBbgEAD4IBiQGMAZMBlAGOAoEBAAOcAXcBEwEADZUBmwGWAZMBjAKCAXABAASaAXgBJQEADIgBdQFRAT8BVwFbAVcBDwEJAQAEmgF5ASYBAAtwATYBKwFAAT4BKAEXASkBKAIWAQADmQF7ATMBAAsiASsBSAFVAVQBQwElARABFgEoASoBAAOYAXsBNAEACgcBJQFIAVUBYgFmAVYBQAEZAQ0BFgEZARIBAAKXAX0BQgEIAQAJDQE8AVMBaQGFAYQBVAE9AiwBFAExAhkBAAGXAX0BMgEACg0BPAFUAXkBmAFWAT0BQgFGAUEBLgEWARQBDQErAZEBfQEsAQQBAAIZAQAGCwEsAUoBYwFkAUABVQFrAW4BVgFhASgBDAEJAQsBSwFWATABAAIbAWUBRAEABQgBFAE6AUYBKgFKAWABdwGEAWYBWQE3AR8BCwERAUsBTAEiASQBDgEWAUICNwEABQkBGQFBASsBSQFfAYQBnAGEAVoBOQEwAQ8BMQIwAVcBjAFEARsBDQEOASgBAAUJAQ4BOQEnAUQBWQF5AZEBfgFkATwBOgEWATQBCAEFAUcBkwGCAUQBJwEPARABGwEABAkBGQFFASUBOgFTAWQBewGGAW0BQwFFASEBPgEJAQgBHAGIAZUBdQFCASoBDgESAQAEBwEKATEBKgErAUoBVgFtAY8BeQFKAUkBKgFCAQwBCgJQAYgBiQFvAUYBJQIABAIBCgEdASsBEwE8AUwBaQF+AW0BTQFGATMBQgEbAQ8BCgEkAV4BgAJDAUYBHwEABAEBEwEMAQ4BCgEbAT4BVgFpAWEBTAFAATcCLAEdAQ0BJAFbAYABiAFvAT4BDQEABQkBEwEKAQkBCgEhAUABRAFFAUABMgE3AjgBNwEdASQBRwFyAYsBgAEhAQkBAAYIAQwBCAINAR4BKAEyAUABTAFIAUUBSQFIAS4BJAFXAVsBcgF1AQwBCgEABwUBCQIIAQoBEwEyAWcBVgFPAUwBRgFDASABIgFwAXUBfwF0AVwBCgEACAkBCwEJAQgBGwE5AUkBTAFIAT4BNAEpARUBDwFXAXQBfwJdAQkBAAgCAQ4BDAEJARQBMgE4ATkBSgFOAUQBMgEWARQBLwFwAXEBcAELAQkBAAkMARIBDgENAR8COAFpAX0BXwE0ARcBFAEcAVwCGwELAQoBAAoTARYBEwEQARsBNwFnAX4BZwE3ARcBEAERAVABJQEfARABEgEACxcDGwEuAUEBTwFCATEBFAENAQIBEwEZARsBEwEWAQANHQIlATABNAExAR4BDAEJAQEBGwETARQBEwEUAQAOGwEZAR0BHgEWAQwBCAECAQABJQEXARYBEwEQAQAQCwEJAQcBCAEAAyUBHwEeARQBCwEAFxABJwEhARQBABkKAQ4BAAQ=" },
  { key: "trooper_1", w: 28, h: 40, rle: "AA+SAWMBABqcAXkBABqcAXsBABqcAX0BABqdAYUBABqdAYYBMwEbAQAXMAGcAY8BLAEUAR8BABUaAUIBmgGRATIBDwEbAQAUFgE+AQwBmAGSATkBHQEAFFEBWQE+AQ0BkQGSAUIBABEdAYEBjAGVAZMBTQExAQkBhgGXAUUBAA+BAYcBjAGTAZUBkwJcAQAChAGYAUIBAA2HAZYClQGNAYwChwEGAQADewGZAVIBEgEAC4IBiwF0AVsBXQFoAV0BUAFCAQ0BAANsAZkBVgEWAQALXgEjAS4BPAEyAR4BIgFOASoBHgESAQACdwGYAWEBKgEACxwBNAFLAVQBTQE0ARQBFgEgASkBKAEAAm0BlwFnASgBAAoLATMBTAFWAWMBYgFKAS4BHQEWAR4CEAEAAVQBlwFtATgBAAodAUgBWQFuAY8BewFKATwBQQEyARYBMwE0ARsBTwGXAXgBJwEAAx8BAAUFAR8BSgFiAYYBmgFLAT0BSAFKAUUBNAESAQ8BDQE3AZEBegEhAQACHQFjAT4BFgEABBQBQAFUAXcBagFBAVkBbAF4AVYBZAEuAQ4BCAEOAWoBYgErAQABAgEHASgBLAEwAQAECwErAUQBSwEsAUkBYAF4AY8BbAFWATcBJwEMARcBTAIgASQBDQEKAQwBDwEeATABAAMIAQ8BLAFFASwBRgFfAX4BnAGFAWABOgEyAQ8BMQERATABWwGOAUQBGQENARABFAEyAQAECAEMATQBJwFBAVYBbgGQAX4BZwE8AhYBNAEOAQgBRwGVAYkBRQEZAQ0BEwE0AQAECgEhAUYBKAE4AVMBYgF6AYYBdwFDAUYBHwE+AQoBCQEOAYABlgGHAUQBGwEfATMBAAQIAQ0BNwEsAScBSQFUAW0BhgF6AUoCKgFDARABCwEJATUBgAGLAXUBRQEnARQBAAQEAQsBFwEqARABOAFKAWcBfAFtAU0BRgEzAUMBIQEUAQsBHAFbAX8BhwFeATEBCwEABAEBDgEMAgkBFAE5AVQBZAFaAUsBPgEzAjABKgETASIBUAF1AYkBgAEhAQcBAAUNARIBCgEJAhsBPAFAAUMBPQE0ATkCOgE9ASsBIgE1AVsBggGLAW8BBgEABggBCgEIAgsBFwEfAS4BTAFZAUsBSAFJAUYBKwERAVcBXQFvAXUBXgEJAQAHAgEIAQkBCAEJARMBMwFqAWMBUgFDATQBKwEWAQgBNgF0AXYBggFwAQkBAAgGAQsBCgEIARMBNAFEAUwBSwFJAUQBNwEfAQ0BEgFeAXIBfwFwAQgBAAgBAQsBDQEJAQwBLAEzATIBTQFrAWMBQwEnAQ8BEgFQAWgBcAFcAQkBAAoPAgwBFwIwAVkBhQF8AUoBLAEQARIBNgFcAR4BDAELAQALEwEUARACKwFEAWwBZwFAASsBEAENARwBKAElARIBEwEADBIBFAETAR8BMQE+AT0BMwEdAQ0BCQESAR0BIQEWAgAOFwEWAR8BLgIfAQ4BCwECARcBFAEbARQBEwEADxABDgEQAgwBCQEEAQABIQEXARkBEgEPAQAXHgIbAQ4BABkbARQBBwEAHw==" },
  { key: "trooper_2", w: 28, h: 40, rle: "AA6XAWkBABqaAXwBABqZAYQBABqXAY8BSQEAGZEBkgFFAQAZkAGYAUoBHQEbAQAXhgGZAU0BDQEbASoBABU9AX0BnAFUARMBCgEAFRsBNwFnAZwBYwEXARsBABQxAVMBDwFUAZwBawEfASwBABGBAYsBlAFkAU8BMgE+AZwBeAEAEYIBiwGUAZUBlgGIAR0BAAKaAX0BGwEADYgBlQKOAYwCjQGJAQAEmAGGATMBAAyMAY4BfwFyAX8BdgFdAVcBAAWQAZEBPQEMAQAKdQFXARoBLAEwASYBKQEvAQAGhQGRAUsBFwEAAxMBAAZHARsBPAFLAU8BQwEnARcBJgEtASsBAAN6AZIBVgEdAQACEgFWAUsBDwEABBQBPgFPAVkBYwFVAT0BJwEqASUBHQEfAQACZwGSAWYBMAEAAQIBAwEoASUBCgEIAQACCAExAU0BYQF6AY8BZwFFAT0BQQEzARkBMQE4AQABZwGSAWwBGQEAAQUBAwELAQcBBAEPAQACDQE5AVIBbAGSAZkBQAFBAUsBTAFIAToBEgEMARQBSwGSAW4BFwENAQoCDAELAQ8BNwEAAgsBMAFLAWQBhQFqAUMBWgFsAXkBVgFmATMBEgEJARABegFkASYBCgELAQ0BDgIUAVQBAAIHARYBPAFLAVIBMAFIAWABegGRAXgBVgE4ASoBDQEbAUwBBQEgASQBEwESAQwBCwETAT0BAAMKAR4BOQFIASwBRQFfAXwBmgGFAWIBOgEzARABMQEUAQYBWwGTAXIBHwEOAQkBEgEuAQADCQEKARIBNwEoAUABVgFsAY8BfgFqATwCFgEzAQsBCQE2AZUBjQE8ARIBCQESARkBAAMHAQoBHgFCASoBMwFPAWABeAGGAXkBQwFGASEBPgEMAQkCXAGUAYsBNwELARIBDAEABAkBEwE9AS4BHwFGAVMBbAGGAXoBSQIqAUQBFgENAQkBIgFwAYsBhwExARMBCQEABAYBDAEWAScBDgEyAUgBZQF7AWwBTAFGATMBQgEqAR4BDQEVAVABdQGJAXYBFgEJAQAEAgEMAQ0BCwEJARABNAFPAV8BVQFKATwBMwIxATABHQEiATUBbwGJAYwBXgEIAQAFDgEPAQoBCQIWATcBPAFBAToBPQFAATwBPQFAAS4BFQE1AVABcAGJAX8BCQEABgkBCAMKARIBGwErAWEBZQFPAUYBOQExAR4BCQEjAV4BcAF0AXIBCAEABwIBCAEJAxMBMwFnAWYBVAFDAT0BNAEhAQ4BCwFXAXIBgQJdAQAIBAELAgkBDQExAUABSgFNAWABVgFIATABEwEPAS8BcAF0AXIBCAEACQcBDQELAQkBHgExASwBSAF7AYQBYwE8ARkBEAEgAV0BXgFdAQkBAAoKAQ8BDQEPARQBJwFCAXkBhAFhAT4BHgEPARUBWwEqAQ8BCgEACwwBEwESAQ4BHgEzAUoBVgFBATMBGQEPAQcBKwEyARsBDQEADQ0BEgEUAScBMgE4ATIBIQEPAQ0BAQEoATEBHQEJAQAPEAESAR0BJQEdARABCwEEAQgBFwEeARABABEIAQoBCwEKAQYBAAQHAQBY" },
  { key: "trooper_3", w: 28, h: 40, rle: "AA+PAU0BABluAZkBaQEAGXkBmgFqAQAanAFsAQAanQF3AQAangF6ASgBHQEAF0kBngF8ARkCJwEAFTIBSgGeAX4BJQEKARQBABQWAUABEwGcAYUBLAEZAQAUKwFgASgBGAGZAY8BOAEAEoEBiwGVAX8BSgE6AQ8BkgGRATwBAA92AYIBiwGUAZUCjQE2AQACkAGSATgBAA2HAZYCkwGMA4gBAASFAZcBSAENAQACBgENAQoBBwEEAQAEiQGNAXUBXQFwAXEBXQFQAQAFfAGYAU8BEAEAAg0BRAFKARIBCQEABF0BIAEuATkBLgEdASkBAAZzAZgBVgElAQABAwEHAS4BQAEPAQYBCAEAAkcBGgE4AUsBVAFLATEBFgEYASYBKQEAA2sBlwFjAScBAAELAgwBCwEDAQUBDAEAAg4BOAFNAVYBYwFgAUYBKwEeARkBHQEeARYBAAFfAZIBawE0AQABEwEUARcBEAEIARQBKwEAAQQBJQFKAVoBdwGPAXgBSAE8AUIBMwEZATMBNAEbAVkBkgF3ASEBEgEbASUBKAEdAQwBMwEwAQABCAErAUwBZAGPAZoBSAE+AUkBSgFFATcBEAENAQ4BOgGSAXgBHgEWAR8BLAEwAScBEAEnARsBAAEHARsBQwFWAXsBawFCAVkBbAF5AVYBZQEwAQ8BCAEQAW0BYwEpAQ4BHQEqASwBIQEPAR0BFAEAAg0BMQFGAUwBLgFJAWABeAGPAW0BVgE3ASgBDAEZAUsBUgEgASQBNwIqARsBDgEXAQsBAAIIARIBMAFFASwBRgFfAX0BnAGFAWEBOgEyAQ8BMgEIATABWwGOAU0BRAEsARIBDAELAQgBAAMIAQ0BNwEoAUEBVgFtAZABfgFnATwCFgE3AQ4BCQFHAZYBiwFGATIBDQEKAQkBCgEAAwkBIQFGASgBNwFSAWIBeQGGAXgBQwFGASEBPgEKAQkBDAF1AZUBiAEzAQ4BCgEMARIBAAMIAQ4BOQEsASUBSAFUAW0BhgF6AUoCKgFDARIBDAEJASQBdQGLAX8BFwEQARIBAAQEAQsBFwEqAQ8BNwFKAWcBfAFtAUwBRgEzAUIBJwEXAQsBHAFXAXYBiAFwARABCgEABAEBDgEMAQsBCQETATgBUwFjAVkBSwE+ATMCMAEsARUBIgFQAXUBiQGHAQgBAAYNARABCgEJAhkBOgE+AUIBPAE5ATwBOgI9AS0BIgEkAVsBfwGLAW8BAAcJAggCCwEWAR4BLAFSAWEBTAFJAUUBQgEnAQsBUAFeAW8BdAFvAQAIAgEIAQkDEwEzAWoBZAFTAUEBMwEoARcBCgEiAXEBdQGHAXQBAAkFAQsBCgEIARIBMwFDAUwBTQJIATwBJQENAQ4BVwFxAX8BcQEACQEBCgENAQoBCwEqATIBMQFMAW4BawFJASwBEAETATYBaAFwAV0BAAsPARABDAEUARcBLAFSAYQBfgFSATMBEwESAS8BXAEADQoBEgEUARABDwEoAT4BZQFkAUEBMAESAQ4BEQEADxcBEgETAh0BLgE6ATwBMwEeAQ0BCwEAEBYBJQEqARYBEwEbASoBKwEfAQ8BCwECAQARDgIAARABDQEOAQ8BDAEJAQUBAFw=" },
  { key: "trooper_4", w: 28, h: 40, rle: "ABCYAWkBABqaAXcBABqcAXcBABqcAXcBABqdAXcBHQEWAQAXZgGeAXcBIQEAGGMBngFtAR8BGwEABCEBKgEUAQAODQFFAUsBngFtAR0BGQEAAxMBSAFGAS4BCQEADT4BIAFGAZ4BbQEoAR8BAAMhAWEBVQEyAQoBAAt2AUoBVAEXAVUBnQFuAQAFKAFmAVkBNAEKAQAIggGNAZQBlgFzATMBCgFNAZwBbgEABSsBZwFhATwBCQEABYIBiQGMAZMBlAGOAn8BAAOcAXcBEwEAAwYBKwFlAWYBQgEKAQAElQGbAZYBjgGMAocBcAEABJoBeAElAQADBwExAU4BYAFBAQAEiQF2AVEBQgFYAVsBVwEABpoBeQEnAQADBQEOARIBJQErAQADcAE2ASsBQAE+ASgBFwEtAQAGmQF7ATMBAAIKARYBDAEGAQkBGwEAAyMBKwFJAVUBVAFDASUBEAEXASkBAASYAXsBNAEAAhkBZQE+AQwBCQEPAQACBQEnAUgBVQFiAWYBVgFAARkBDQEWARkBEgEAApcBfQFCAQgBBQEMAUQBNwEOAQsBDQEAAg0BPAFTAWkBhQGEAVQBPQIsARQBMQIaAQABlwF9ATIBAAEKAQUBCwEIAQYBDAEPAQACDQE8AVQBeQGYAVYBPQFCAUYBQQEuARYBFAENASsBkQF9ASwBBAENAQ8BEAENARABHgEAAwsBLAFKAWMBZAFAAVUBawFuAVYBYQEoAQwBCQELAUsBVgEwAQwBDQESARMBEgEWAS4BAAMIARQBOgFGASoBSgFgAXcBhAFmAVkBNwEfAQsBEQFOAUYBIgEkARYCEAEOARYBAAUKARkBQQErAUkBXwGEAZwBhAFaATkBMAEPATECMAFXAYwBPgEoARIBCwEUAQAFCQEOATkBJwFEAVkBeQGRAX4BZAE8AToBFgE0AQgBBQFHAZMBggE6ARYBCwEPAQAFCQEZAUUBJQE6AVMBZAF7AYYBbQFDAUUBIQE+AQkBCAEcAYgBlQF1ATIBDQEQAQAFBwEKATEBKgErAUoBVgFtAY8BeQFKAUkBKgFCAQwBCgJQAYgBiQFvASwBAAYCAQoBHQErARMBPAFMAWkBfgFtAU0BRgEzAUIBGwEPAQoBJAFeAYACQgEABgEBEwEMAQ4BCgEbAT4BVgFpAWEBTAFAATcCLAEdAQ0BJAFbAYABiAFvAQAHCQETAQoBCQEKASEBQAFEAUUBQAEyATcCOAE3AR0BJAFHAXIBiwGAAQAICAEMAQgCDQEeASgBMgFAAUwBSAFFAUkBSAEuASQBVwFbAXIBdQEACQUBCQIIAQoBEwEyAWcBVgFPAUwBRgFDASABIgFwAXUBfwF0AVwBAAkJAQsBCQEIARsBOQFJAUwBSAE+ATQBKQEVAQ8BVwF0AX8CXQEACQIBDgEMAQkBFAEyATgBOQFKAU4BRAEyARYBFAEvAXABcQFwAQALDAESAQ4BDQEfAjgBaQF9AV8BNAEXARQBHAFcAgANEwEWARMBEAEbATcBZwF+AWcBNwEXARABEQFQAQAODQEXAxsBLgFBAU8BQgExARQBDQECAQAPDQESAR0DJQEwATQBMQEeAQwBCQEBAQAPDQEPARsBIQEbARkBHQEeARYBDAEIAQIBABANARABHgElARkBAAELAQkBBwEIAQATEwEfASEBCwEAGAQBDQEIAQAQ" },
  { key: "trooper_5", w: 28, h: 40, rle: "ABGRAYYBTAEAGZgBhgFgAQAZmgGFAU4BABmcAYUBPgEAGZ4BhAE0AQAYTAGeAXwBHwEdAQAWOgFLAZ4BeAEZAQAWNAE4AVUBngFsAR4BFgEAFD0BQgEJAWoBngFnASEBABOLAYcBSwFFAQ4BbgGcAWMBABGCAYwBlAKVAWgBDwEAAXgBnAFZAQAEFAEqAR4BBwEABogBkwGOA40BjAGHAQADfQGaAVIBAAQyAUMBOQEWAQAFkwGbAZYBlAGMAYkBgQFxAQAEhAGZAVQBFAEAAgkBQgFjAU4BJwEABIABdAFXATIBNAFQAVcBAAZ+AZkBTwEQAQACDgFVAXgBYQEoAQAEVwEmATwBRQE5ARkBFAEpAQAFhgGXAVIBHgEAAQUBDwEeAU4BYQElAQAEGwFBAVQBVQFMAToBFwEPARkBAASPAZIBUgEbAQABGwFiATIBCwEyARcBAAMOATwBTwFaAWUBZAFOATMBEAENARsBEwEAApEBkAFfAR0BAwESAU4BNAEOAQ0CAAMbAUkBYAF7AYUBaQFEATwBKgEQASoBIQEUAQABkgGPAU0BBwIDAQwBBwEFAQ0BDAEAAxkBRgFiAYYBZgFBAT0CNwEhASUBIAENARsBkAGFAUMBBAEMAg0BCwEQAR8BEgEAAw8BPAFPAVIBPAFSAWUBZwFTAU8BGwELAQkCPAFOATcBBgEMAQ4BDwIUATIBEgEAAwoBJQFAAScBSwFhAXcBfAFgAWIBMwEZAQoBCwEJAUUBIwIUARMBDQIWASsBAAQIAQwBPAEqAUwBXwGGAZwBfgFVATkBLAEPATABMQEwAVABiAFAASEBDwEKARMBDQEABAkBFAFAASEBSAFZAXwBlwF+AV8BPAE5ARYBNAEFATEBRwGJAXUBPAESAQkBDgEABQkBDgFAAR8BQAFUAWkBfQGFAWoBQwFEASEBPQEGAQgBJAGCAY4BXgE0AQwBDgEABQMBCAEuASEBMgFMAVoBdwGPAXcBSgFIASoBQAEJAhEBXgGNAYIBPgEwAQAGBAENASUBKAEbAUEBUgFrAYUBbQFNAUYBMwFBARIBDAELATYBcgGBAW8BQwEABgEBGQEOARIBCwElAUMBYQFtAWMBTQFBAToBOAElARMBDAEvAW8BgQF2AT0BAAcFARQBCQEIAQsBKwFFAUoBSAFDATIBMwIyASgBEgE1AV0BhwGIAV4BAAgGAQ0BCAIQASgBMQE3AkIBRQFEAUYBQwEfASQBUAFvAYIBbwEACQcBCQIIAQsBEwEwAVYBTgFNAVIBUwFLASgBUAFxAXICXQEACQEBCwIIAQkBJwFAAU0BSgFLAUgBRAE0ASIBVwF/AocBcAEACgcBDwELAQkBJQE3AT0CPgE9ATIBIAIkAXECcgFdAQALEwEQAQsBFwEqASsBPgFhAUwBNwEfARMBFQFbAV0CAA0ZARYBFAEWASsBTQF+AXsBQQEbARIBEwFQAQAPGwEdAicBLAFAAWoBaQFAAR0BDQELAQAQDAETASoBJwExATQBPQE8ATEBFgEKAQIBABAJARABKAEnAjECKgEZAQsBBgEAEg0BHwEqARsBGQEWAQ4BCgEIAQATBQESAgAs" },
  { key: "trooper_6", w: 28, h: 40, rle: "ABKYAXwBABqaAXwBABqcAXoBABqdAW4BABl5AZ0BagEhAQAXEwGEAZwBYgEbASEBABUqASgBjwGaAUsBCwEAFRgBTgEGAZEBmAFDARQBABQmAVUBHgEOAZgBkgFAAQASfwGJAZQBdAFDAR8BFQGaAZABOQEAEIIBiwGTAZQBkwGMAS8BAAKcAYUBAA5/AZUBlgGUAZMBjQGMAYcBAASdAXwBHQEADIkBlgKOAY0BiQGHAXEBAAWdAXgBJQEADH8BVwE2ASgBNAFQAVcBAAVqAZoBbAEdAQALVwEvATcBRQFAASUBEAEiASgBAARqAZkBaQEoAQALEAE6AVIBVgFOAUMBIQENAREBKAEAA3oBmAFnASUBAAoIATABTQFZAWQBZQFVAT4BFwEMARQBDQEAAoQBkgFnASwBAAEWAToBEAEABg0BQAFWAW0BhQFuAU0BQAErARABHgEbARIBAAGQAZEBYgEMAQUBMQFmASwBDQEKAQAEDQE9AVUBfAFnAUEBPgI0AR4BLAEnAQ0BGwGPAk0BBQECAQcBFAEMAQ8BEgEABAoBLgFLAUkBOgFOAWECTwFIARYBCgEJAjABPQE5AQUBCQILAQ0BFAEdAQAECAEUATkBJwFMAWEBdwF4AVkBYwExARYBCQEKAQgBSAElASMBDwEMAQsBDwEXASoBAAQIAQoBOQEqAU0BXwGGAZoBfAFTATkBKgEQASsBCwExAVABgQFCARYBCwEMARsBLAEABAkBFAFCAR8BSgFZAX4BmAF9AVYBPQE3ARcBNwEHATEBRwGCAXEBQwESAQoBHwEbAQAEBwELAT0BHQFDAVQBbAF+AYQBZwFDAiEBPAEEAQkBNQF/AYwBNAFDARIBEwEKAQAEAgEJATEBHgE3AU0BYAF4AY8BbQFKAUYBKwE+AQcBCAEcAW8BjgF2ATQBQQEMAQgBAAQEARABKgElAR8BQgFUAWwBhgFsAU0BRQE0AT4BDgELAQ0BRwF1AYABXQFFARQBCwEABRkBEAEUAQ0BKgFGAWMBdwFjAU0BQQE9ATgBHQEQAQ0BNgFyAYABcQE+AScBCgEABQIBFAEJAQgBDQExAUkBTgFJAUUBMwIyATABHgEPATYBcgGIAYABPQEQAQgBAAYGAQ0BCAITAS4BMwE4ATQBPQFDAkQBPAEaASQBUAF2AYIBLAEJAQAIBwELAQoBCQEMARMBLAFNAUsBTAFPAVMBSwEjAVABcAFxAW8BXAEHAQAIAgELAggBCwEqAUMBTQFKAU4BUgFTAT4BIgFyAYABggGAAVwBAAoMAQ4BCgELASsBOAFAAj0BNwEwASMBJAFbAXIBdAFyAQAMFAEPAQsBHwEsATABQAFJATwBMAEWAR4BNQFdAV4BXQEADBQBGQEUARsCMQFiAX0BYgEsARIBGwEiAVsBAA8eAicBMgEzAVUBewFnATMBEAESAQoBABEQAScBMgE8AT0BRgFAAS4BDgEKAQEBABInASgBNAE9ATcBLAEXAQoBAwEAFCoBIQEoAR8BEAEKAQcBABgKAQAp" },
  { key: "trooper_7", w: 28, h: 40, rle: "ABGaAW4BABqcAXkBABqcAXgBABqdAW4BABqeAWwBJwEAGHkBngFnAQwBHgEAFjkBewGdAV8BEAEAFjEBLQF7AZwBVQEWAgAUOwFCAQQBfgGaAVIBHQEAE4sBiQFMAT8BDQGFAZkBTAEAEYIBjAGUApUBaAEOAQABhgGYAUkBAA6IAZMEjQGMAYcBAAOPAZkBQwEADZMBmwGWAZQBjAGLAYEBcQEABI8BmAFJAQAMgAFyAVEBMQE2AVABVwFgATABCgEAA5ABlwFGARABAAtQASUBPgFFATcBFwEVAR8BTQEPAQADkAGSAUsBHQEACgcBHgFDAVQBVQFLATcBEwEPARoBDgETAQACkQGQAUkBFAEAChIBQAFSAV8BZgFjAUsBLgEOAQ8BGgEQAQACkgGPAVQBEgEACQcBJQFMAWIBfAGFAWUBQgE9ASsBEgEsAScBFwEAAZcBhgFJAQcBAAIbAQAGCQEhAUoBZQGQAWQBQAE+AjgBJQEfASABDgEfAZEBhAE+AQUBAAEnAWEBLAEABhQBQAFUAVYBPQFTAWcBagFUAh4BCwEJAQoBQAFOATQBBQEEARMBOgE0ASoBAAULASsBQQEoAUsBYQF3AXwBYQI0ARsBCgEMAU4BRQEhASMBCwEKAQ0BEAEnAQAFCAEOAT0BKwFLAV8BhgGcAX4BVgE5AS4BDwExAjABUAGIAUQBGQENAQ8BFwEoAQAECQETAT0BIQFGAVkBfAGXAX4BYAE9ATkBFgE0AQMBMAFHAYsBdgFFAR0BDgEUARcBAAQIARABQgEfAT4BVAFpAXwBhQFrAUMBRAEfAT0BCAEJASQBggGTAXABRQEfASgBHgEABAQBCQEuASUBMQFMAVkBdwGPAXcBSgFJASoBQAEKAQkBDgFdAY0BhwExAUYBPQESAQAEAwEMASEBKgEZAUABTwFrAYQBbQFNAUYBMwFCARQBDQELATUBcAGBAXEBRAE8AQoBAAQBARkBDQEQAQoBIQFCAWABbAFjAU0BQQE5ATgBJwEWAQwBLwFvAYEBgAFCASEBCAEABQYBFAEJAQgBCwEqAUQBSQFGAUMBMgEzAysBEwEvAVsBhwGJAW8BDAEJAQAGBwENAQgCDwEnAS4BNAE4AUMBRQFEAUYBRAEmASQBUAFeAYEBcQEJAgAHBwEJAggBCgETATEBXwFPAU0BUwJLASUBUAFxAXQCXgEJAgAHAQELAgkCJQE+AU0BSwFKAUQBPgExASMBNgF2AocBcgEJAQgBAAgFAQ8BCwEJAR8BNAE8AkEBQAE3ASUBFwJeAXEBcgFeAQkCAAkQARIBDAEUASgBKgE9AWUBWgE6ASUBEgEXAVABXQIMAQsBDwEAChcBFgETARQBKgFIAXwBfgFKASEBEAETATYBCQEKAQ4BEgETAQALHQEbASEBKgE6AWMBZgFCASUBDQEMAQABEgEQARYBFwEADR0BIQErATIBOgIyARcBCwEEAQABEAEbAg4BAA4lASEBKwEuASgBGQELAQcBAQEAAggCABAXARMBEgENAQoBBQEAQg==" }
];
var TROOPER_PLAYER = {
  name: "trooper",
  texture: ["trooper_0", "trooper_1", "trooper_2", "trooper_3", "trooper_4", "trooper_5", "trooper_6", "trooper_7"]
};
var B642 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function fromBase642(s) {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(clean.length * 3 >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = acc << 6 | B642.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = acc >> bits & 255;
    }
  }
  return out;
}
function decodePlayer2Art() {
  return TROOPER_FRAMES.map(({ key, w, h, rle }) => {
    const runs = fromBase642(rle);
    const rgba = new Uint8ClampedArray(w * h * 4);
    let p = 0;
    for (let i = 0; i + 1 < runs.length; i += 2) {
      const colour = TROOPER_PALETTE[runs[i]];
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
var ANIM_PERIOD_TABLE = [60, 30, 15, 10, 5, 3, 2, 1];
var SCORE_TABLE = [50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4];
var HP_TABLE = [256, 12800, 25600, 51200, 102400, 204800, 256e3, 512e3];
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
function channel(a, b, c, { enabled, table, stepTable, angle, bits3 }) {
  const rawFrom = bits3 ? b & 7 : b & 15;
  const rawTo = bits3 ? b >> 4 & 7 : b >> 4 & 15;
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
var ZAKO_BAND_BASE = [0, 16, 24, 32, 48, 52, 56];
function zakoRecordFromKey(key) {
  const band = key >> 4 & 7;
  return ZAKO_BAND_BASE[band === 7 ? 0 : band] | key & 15;
}
function decodeDeathWord(b) {
  const mode = b[2] >> 6 & 3;
  const param = b[3];
  const present = b[4] >> 2 & 3;
  const death = {
    mode,
    // 0 none, 1 item, 2 child, 3 chain
    param,
    // The engine renders the death itself from byte 4: value 0 removes the
    // object with no explosion and no sound, value 2 picks the small blast
    // (and suppresses the rank-3 revenge shot); 1 and 3 are the full one.
    silent: present === 0,
    small: present === 2
  };
  if (mode === 1) {
    death.item = (param & 8) !== 0 ? 9 : (param & 7) + 1;
  } else if (mode >= 2) {
    death.key = param | 128;
    death.record = zakoRecordFromKey(death.key);
  }
  return death;
}
function decodeEnemyRecord(bytes) {
  const b = Array.from(bytes);
  const rotationMode = b[9] & 7;
  const scaleMode = b[12] & 3;
  return {
    appearance: b[0],
    // Engine durability units. There is no `speed` field: byte 2's low
    // bits are hp, and a scripted zako's motion comes from its appearance
    // script's amplitude words and the change channels below. The one
    // per-record speed the engine does read is byte 0 bits0-2, and only
    // for the 48 hard-coded AI appearance ids (classes 0x31-0x36), which
    // remap it through [128,256,384,512,640,768,1152,1536] units/frame
    // (+0x20560) — it rides along inside `appearance`, and the runtime
    // already drives it from there.
    hp: HP_TABLE[b[2] & 7],
    animPeriod: ANIM_PERIOD_TABLE[b[1] & 7],
    score: SCORE_TABLE[b[1] >> 4 & 7],
    ground: (b[1] & 128) !== 0,
    // The spawn packs b2 bits 4-5 and bit 3 into the per-object HIT
    // ATTRIBUTE byte 0x06091550, which the engine reads BITWISE. Named
    // (2026-08-31, FORMAT.md "Armour deflection"): bit 0 = ARMOUR — the
    // target is indestructible, ordinary shots die on it instead of
    // trading hp, the impact SFX changes, and sub weapon 6's ball bounces
    // off it; bit 1 = NO COLLISION AT ALL; bit 2 = the terrain-ride flag.
    // `mode` keeps the two-bit field the editor authors as a pair of
    // mutually exclusive checkboxes, so armour is `move.mode & 1`.
    movePattern: b[2] >> 4 & 3 | (b[2] & 8) >> 1,
    move: {
      mode: b[2] >> 4 & 3,
      // bit0 = armour, bit1 = no collision
      flag: (b[2] & 8) !== 0
      // terrain-ride (&4 of the packed byte)
    },
    fire: {
      // Two gates silence an enemy outright: the appearance's no-fire
      // bit, and byte 5's low nibble being 0 — the geometry table's
      // entry 0 is an empty routine (FORMAT.md "Zako firing,
      // re-traced"). `enabled` carries only the appearance gate; the
      // runtime combines it with `direction`.
      enabled: appearanceFires(b[0]),
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
    death: decodeDeathWord(b),
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
        angle: true,
        bits3: true
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
function zakoPlacementId(record) {
  let base = 0;
  for (const [first, count] of ZAKO_GROUPS) {
    if (record >= base && record < base + count) return first + (record - base);
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
function deathChildClosure(stage, placed) {
  const found = /* @__PURE__ */ new Set();
  const queue = [...placed];
  const seen = new Set(queue);
  while (queue.length) {
    const record = queue.pop();
    const entry = stage.enemies.records[record];
    if (!entry || !entry.defined) continue;
    const bytes = entry.bytes;
    if ((bytes[2] >> 6 & 3) !== 2) continue;
    const child = zakoRecordFromKey(bytes[3] | 128);
    if (child < 0 || child >= ZAKO_SLOT_COUNT || seen.has(child)) continue;
    seen.add(child);
    if (!stage.enemies.records[child] || !stage.enemies.records[child].defined) continue;
    found.add(child);
    queue.push(child);
  }
  return found;
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
    for (const record of deathChildClosure(st, placed)) placed.add(record);
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
        // 0 for a record the grid never places — it reaches the
        // screen only as another record's death-word child.
        placements: uses.get(key) || 0,
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

// packages/shmup-engine/src/decode/appearance-table.js
var APPEARANCE_FLAGS = {
  ADVANCE: 1,
  // advance to the next row when the duration expires
  NO_FIRE: 16,
  // this appearance never fires (48 of 256 ids)
  VEL_COS: 32,
  // velocity component A = amp * cos(angle)
  VEL_SIN: 64,
  // velocity component B = amp * sin(angle)
  INTERP2: 128,
  // run the turn-toward interpreter instead of polar drift
  GATE_A: 256,
  GATE_B: 512,
  HALF_DUR: 4096
  // duration halved for the band's "variant B" spawn
};
var RIDES_SCROLL = 32768;
var APPEARANCE_CLASSES = [48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 53, 53, 53, 53, 53, 53, 53, 53, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 54, 54, 54, 54, 54, 54, 54, 54, 49, 49, 49, 49, 49, 49, 49, 49, 51, 51, 51, 51, 51, 51, 51, 51, 50, 50, 50, 50, 50, 50, 50, 50, 52, 52, 52, 52, 52, 52, 52, 52];
var APPEARANCE_SCRIPTS = [[[32767, 49152, 0, 32768, 0]], [[32767, 49152, 0, 32768, 0]], [[32767, 49152, 0, 32768, 0]], [[32767, 49152, 0, 32768, 0]], [[32767, 49152, 0, 32768, 0]], [[32767, 49152, 0, 32768, 0]], [[32767, 49152, 0, 32768, 0]], [[32767, 49152, 0, 32768, 0]], [[0, 8192, 0, 33132, 1025], [255, 49152, 256, 32869, 1024]], [[0, 8192, 0, 32950, 1025], [127, 49152, 512, 32970, 1024]], [[0, 8192, 0, 33132, 1025], [255, 49152, 256, 32970, 1024]], [[0, 8192, 0, 32950, 1025], [127, 49152, 512, 33172, 1024]], [[0, 8192, 0, 33132, 1025], [255, 49152, 256, 33071, 1024]], [[0, 8192, 0, 32950, 1025], [127, 49152, 512, 33374, 1024]], [[0, 8192, 0, 33132, 1025], [255, 49152, 256, 33172, 1024]], [[0, 8192, 0, 32950, 1025], [127, 49152, 512, 33576, 1024]], [[32767, 49152, 256, 32896, 1088]], [[32767, 49152, 512, 33024, 1088]], [[32767, 49152, 768, 33152, 1088]], [[32767, 49152, 1024, 33280, 1088]], [[32767, 49152, 1280, 33408, 1088]], [[32767, 49152, 1536, 33536, 1088]], [[32767, 49152, 2304, 33920, 1088]], [[32767, 49152, 3072, 34304, 1088]], [[32767, 49152, 128, 32896, 1088]], [[32767, 49152, 256, 33024, 1088]], [[32767, 49152, 384, 33152, 1088]], [[32767, 49152, 512, 33280, 1088]], [[32767, 49152, 640, 33408, 1088]], [[32767, 49152, 768, 33536, 1088]], [[32767, 49152, 1152, 33920, 1088]], [[32767, 49152, 1536, 34304, 1088]], [[32767, 49152, 0, 128, 1]], [[32767, 49152, 0, 256, 1]], [[32767, 49152, 0, 384, 1]], [[32767, 49152, 0, 512, 1]], [[32767, 49152, 0, 640, 1]], [[32767, 49152, 0, 768, 1]], [[32767, 49152, 0, 1152, 1]], [[32767, 49152, 0, 1536, 1]], [[223, 49152, 0, 128, 4113], [95, 49152, 0, 0, 1], [32767, 49152, 0, 128, 1]], [[111, 49152, 0, 256, 4113], [80, 49152, 0, 0, 1], [32767, 49152, 0, 256, 1]], [[74, 49152, 0, 384, 4113], [73, 49152, 0, 0, 1], [32767, 49152, 0, 384, 1]], [[55, 49152, 0, 512, 4113], [65, 49152, 0, 0, 1], [32767, 49152, 0, 512, 1]], [[44, 49152, 0, 640, 4113], [57, 49152, 0, 0, 1], [32767, 49152, 0, 640, 1]], [[36, 49152, 0, 768, 4113], [49, 49152, 0, 0, 1], [32767, 49152, 0, 768, 1]], [[24, 49152, 0, 1152, 4113], [41, 49152, 0, 0, 1], [32767, 49152, 0, 1152, 1]], [[16, 49152, 0, 1536, 4113], [1, 49152, 0, 1152, 17], [31, 49152, 0, 0, 1], [32767, 49152, 0, 1536, 1]], [[223, 49152, 0, 128, 4113], [95, 49152, 0, 0, 1], [32767, 16384, 0, 128, 1]], [[111, 49152, 0, 256, 4113], [80, 49152, 0, 0, 1], [32767, 16384, 0, 256, 1]], [[74, 49152, 0, 384, 4113], [73, 49152, 0, 0, 1], [32767, 16384, 0, 384, 1]], [[55, 49152, 0, 512, 4113], [65, 49152, 0, 0, 1], [32767, 16384, 0, 512, 1]], [[44, 49152, 0, 640, 4113], [57, 49152, 0, 0, 1], [32767, 16384, 0, 640, 1]], [[36, 49152, 0, 768, 4113], [49, 49152, 0, 0, 1], [32767, 16384, 0, 768, 1]], [[24, 49152, 0, 1152, 4113], [41, 49152, 0, 0, 1], [32767, 16384, 0, 1152, 1]], [[16, 49152, 0, 1536, 4113], [1, 49152, 0, 1152, 17], [31, 49152, 0, 0, 1], [32767, 16384, 0, 1536, 1]], [[310, 49152, 0, 128, 4097], [20, 49152, 0, 64, 1], [10, 49152, 0, 0, 1], [20, 16384, 0, 48, 1], [200, 16384, 0, 96, 1], [20, 16384, 0, 32, 1], [10, 16384, 0, 0, 1], [20, 49152, 0, 64, 1], [32767, 49152, 0, 128, 1]], [[152, 49152, 0, 256, 4097], [12, 49152, 0, 128, 1], [10, 49152, 0, 0, 1], [12, 16384, 0, 80, 1], [114, 16384, 0, 160, 1], [12, 16384, 0, 80, 1], [8, 16384, 0, 0, 1], [16, 49152, 0, 128, 1], [32767, 49152, 0, 256, 1]], [[101, 49152, 0, 384, 4097], [12, 49152, 0, 144, 1], [10, 49152, 0, 0, 1], [12, 16384, 0, 144, 1], [64, 16384, 0, 256, 1], [12, 16384, 0, 144, 1], [10, 16384, 0, 0, 1], [10, 49152, 0, 224, 1], [32767, 49152, 0, 384, 1]], [[71, 49152, 0, 512, 4097], [12, 49152, 0, 288, 1], [8, 49152, 0, 0, 1], [12, 16384, 0, 256, 1], [45, 16384, 0, 320, 1], [13, 16384, 0, 144, 1], [8, 16384, 0, 0, 1], [10, 49152, 0, 384, 1], [32767, 49152, 0, 512, 1]], [[57, 49152, 0, 640, 4097], [12, 49152, 0, 320, 1], [8, 49152, 0, 0, 1], [12, 16384, 0, 288, 1], [34, 16384, 0, 384, 1], [12, 16384, 0, 256, 1], [6, 16384, 0, 0, 1], [10, 49152, 0, 368, 1], [32767, 49152, 0, 640, 1]], [[46, 49152, 0, 768, 4097], [10, 49152, 0, 384, 1], [6, 49152, 0, 0, 1], [8, 16384, 0, 320, 1], [26, 16384, 0, 512, 1], [10, 16384, 0, 288, 1], [8, 16384, 0, 0, 1], [8, 49152, 0, 384, 1], [32767, 49152, 0, 768, 1]], [[31, 49152, 0, 1152, 4097], [7, 49152, 0, 512, 1], [6, 49152, 0, 0, 1], [7, 16384, 0, 512, 1], [18, 16384, 0, 640, 1], [7, 16384, 0, 512, 1], [6, 16384, 0, 0, 1], [7, 49152, 0, 512, 1], [32767, 49152, 0, 1152, 1]], [[22, 49152, 0, 1536, 4097], [6, 49152, 0, 768, 1], [4, 49152, 0, 0, 1], [6, 16384, 0, 768, 1], [8, 16384, 0, 1024, 1], [6, 16384, 0, 768, 1], [4, 16384, 0, 0, 1], [6, 49152, 0, 768, 1], [32767, 49152, 0, 1536, 1]], [[280, 49152, 0, 128, 4097], [53, 49152, 0, 96, 1], [20, 49152, 0, 0, 1], [130, 49152, 255, 96, 1], [32767, 16384, 0, 128, 1]], [[138, 49152, 0, 256, 4097], [26, 49152, 0, 208, 1], [62, 49152, 512, 192, 1], [32767, 16384, 0, 256, 1]], [[93, 49152, 0, 384, 4097], [14, 49152, 0, 336, 1], [40, 49152, 852, 320, 1], [32767, 16384, 0, 384, 1]], [[67, 49152, 0, 512, 4097], [13, 49152, 0, 448, 1], [28, 49152, 1193, 448, 1], [32767, 16384, 0, 512, 1]], [[55, 49152, 0, 640, 4097], [8, 49152, 0, 592, 1], [24, 49152, 1398, 528, 1], [32767, 16384, 0, 640, 1]], [[45, 49152, 0, 768, 4097], [7, 49152, 0, 704, 1], [18, 49152, 1875, 704, 1], [32767, 16384, 0, 768, 1]], [[31, 49152, 0, 1152, 4097], [3, 49152, 0, 1104, 1], [13, 49152, 2336, 896, 1], [32767, 16384, 0, 1152, 1]], [[23, 49152, 0, 1536, 4097], [3, 49152, 0, 1120, 1], [9, 49152, 3308, 1120, 1], [32767, 16384, 0, 1536, 1]], [[287, 49152, 0, 128, 4097], [333, 49152, 97, 128, 1], [32767, 16384, 0, 128, 1]], [[144, 49152, 0, 256, 4097], [163, 49152, 194, 256, 1], [32767, 16384, 0, 256, 1]], [[96, 49152, 0, 384, 4097], [107, 49152, 292, 384, 1], [32767, 16384, 0, 384, 1]], [[71, 49152, 0, 512, 4097], [79, 49152, 389, 512, 1], [32767, 16384, 0, 512, 1]], [[57, 49152, 0, 640, 4097], [63, 49152, 487, 640, 1], [32767, 16384, 0, 640, 1]], [[47, 49152, 0, 768, 4097], [51, 49152, 560, 768, 1], [32767, 16384, 0, 768, 1]], [[31, 49152, 0, 1152, 4097], [33, 49152, 828, 1152, 1], [32767, 16384, 0, 1152, 1]], [[23, 49152, 0, 1536, 4097], [26, 49152, 1217, 1536, 1], [32767, 16384, 0, 1536, 1]], [[114, 49152, 0, 128, 4097], [333, 49152, 97, 128, 1], [32767, 16384, 0, 128, 1]], [[56, 49152, 0, 256, 4097], [168, 49152, 194, 256, 1], [32767, 16384, 0, 256, 1]], [[38, 49152, 0, 384, 4097], [110, 49152, 292, 384, 1], [32767, 16384, 0, 384, 1]], [[28, 49152, 0, 512, 4097], [82, 49152, 389, 512, 1], [32767, 16384, 0, 512, 1]], [[22, 49152, 0, 640, 4097], [66, 49152, 487, 640, 1], [32767, 16384, 0, 640, 1]], [[18, 49152, 0, 768, 4097], [57, 49152, 560, 768, 1], [32767, 16384, 0, 768, 1]], [[12, 49152, 0, 1152, 4097], [39, 49152, 828, 1152, 1], [32767, 16384, 0, 1152, 1]], [[10, 49152, 0, 1536, 4097], [26, 49152, 1217, 1536, 1], [32767, 16384, 0, 1536, 1]], [[114, 49152, 0, 128, 4113], [166, 49152, 97, 128, 17], [95, 0, 0, 0, 1], [167, 0, 97, 128, 1], [32767, 16384, 0, 128, 1]], [[56, 49152, 0, 256, 4113], [84, 49152, 194, 256, 17], [80, 0, 0, 0, 1], [84, 0, 194, 256, 1], [32767, 16384, 0, 256, 1]], [[38, 49152, 0, 384, 4113], [55, 49152, 292, 384, 17], [73, 0, 0, 0, 1], [55, 0, 292, 384, 1], [32767, 16384, 0, 384, 1]], [[28, 49152, 0, 512, 4113], [41, 49152, 389, 512, 17], [65, 0, 0, 0, 1], [41, 0, 389, 512, 1], [32767, 16384, 0, 512, 1]], [[22, 49152, 0, 640, 4113], [33, 49152, 487, 640, 17], [57, 0, 0, 0, 1], [33, 0, 487, 640, 1], [32767, 16384, 0, 640, 1]], [[18, 49152, 0, 768, 4113], [28, 49152, 560, 768, 17], [49, 0, 0, 0, 1], [29, 0, 560, 768, 1], [32767, 16384, 0, 768, 1]], [[12, 49152, 0, 1152, 4113], [19, 49152, 828, 1152, 17], [41, 0, 0, 0, 1], [20, 0, 828, 1152, 1], [32767, 16384, 0, 1152, 1]], [[10, 49152, 0, 1536, 4113], [13, 49152, 1217, 1536, 17], [31, 0, 0, 0, 1], [13, 0, 1217, 1536, 1], [32767, 16384, 0, 1536, 1]], [[98, 49152, 0, 128, 4097], [72, 49152, 227, 128, 1], [144, 0, -227, 128, 1], [144, 32768, 227, 128, 1], [144, 0, -227, 128, 1], [144, 32768, 227, 128, 1], [72, 0, -227, 128, 1], [32767, 49152, 0, 128, 1]], [[50, 49152, 0, 256, 4097], [36, 49152, 454, 256, 1], [72, 0, -454, 256, 1], [72, 32768, 454, 256, 1], [72, 0, -454, 256, 1], [72, 32768, 454, 256, 1], [36, 0, -454, 256, 1], [32767, 49152, 0, 256, 1]], [[33, 49152, 0, 384, 4097], [24, 49152, 682, 384, 1], [48, 0, -682, 384, 1], [48, 32768, 682, 384, 1], [48, 0, -682, 384, 1], [48, 32768, 682, 384, 1], [24, 0, -682, 384, 1], [32767, 49152, 0, 384, 1]], [[25, 49152, 0, 512, 4097], [18, 49152, 909, 512, 1], [36, 0, -909, 512, 1], [36, 32768, 909, 512, 1], [36, 0, -909, 512, 1], [36, 32768, 909, 512, 1], [18, 0, -909, 512, 1], [32767, 49152, 0, 512, 1]], [[18, 49152, 0, 640, 4097], [14, 49152, 1136, 640, 1], [28, 0, -1136, 640, 1], [28, 32768, 1136, 640, 1], [28, 0, -1136, 640, 1], [28, 32768, 1136, 640, 1], [14, 0, -1136, 640, 1], [32767, 49152, 0, 640, 1]], [[14, 49152, 0, 768, 4097], [12, 49152, 1364, 768, 1], [24, 0, -1364, 768, 1], [24, 32768, 1364, 768, 1], [24, 0, -1364, 768, 1], [24, 32768, 1364, 768, 1], [12, 0, -1364, 768, 1], [32767, 49152, 0, 768, 1]], [[10, 49152, 0, 1152, 4097], [8, 49152, 2046, 1152, 1], [16, 0, -2046, 1152, 1], [16, 32768, 2046, 1152, 1], [16, 0, -2046, 1152, 1], [16, 32768, 2046, 1152, 1], [8, 0, -2046, 1152, 1], [32767, 49152, 0, 1152, 1]], [[6, 49152, 0, 1536, 4097], [6, 49152, 2728, 1536, 1], [12, 0, -2728, 1536, 1], [12, 32768, 2728, 1536, 1], [12, 0, -2728, 1536, 1], [12, 32768, 2728, 1536, 1], [6, 0, -2728, 1536, 1], [32767, 49152, 0, 1536, 1]], [[98, 49152, 0, 128, 4097], [72, 49152, 227, 128, 1], [95, 0, 0, 128, 1], [144, 0, -227, 128, 1], [91, 32768, 0, 128, 1], [144, 32768, 227, 128, 1], [95, 0, 0, 128, 1], [144, 0, -227, 128, 1], [91, 32768, 0, 128, 1], [72, 32768, 227, 128, 1], [32767, 49152, 0, 128, 1]], [[50, 49152, 0, 256, 4097], [36, 49152, 454, 256, 1], [47, 0, 0, 256, 1], [72, 0, -454, 256, 1], [45, 32768, 0, 256, 1], [72, 32768, 454, 256, 1], [47, 0, 0, 256, 1], [72, 0, -454, 256, 1], [45, 32768, 0, 256, 1], [36, 32768, 454, 256, 1], [32767, 49152, 0, 256, 1]], [[33, 49152, 0, 384, 4097], [24, 49152, 682, 384, 1], [31, 0, 0, 384, 1], [48, 0, -682, 384, 1], [30, 32768, 0, 384, 1], [48, 32768, 682, 384, 1], [31, 0, 0, 384, 1], [48, 0, -682, 384, 1], [30, 32768, 0, 384, 1], [24, 32768, 682, 384, 1], [32767, 49152, 0, 384, 1]], [[25, 49152, 0, 512, 4097], [18, 49152, 909, 512, 1], [22, 0, 0, 512, 1], [36, 0, -909, 512, 1], [21, 32768, 0, 512, 1], [36, 32768, 909, 512, 1], [22, 0, 0, 512, 1], [36, 0, -909, 512, 1], [21, 32768, 0, 512, 1], [18, 32768, 909, 512, 1], [32767, 49152, 0, 512, 1]], [[18, 49152, 0, 640, 4097], [14, 49152, 1136, 640, 1], [17, 0, 0, 640, 1], [28, 0, -1136, 640, 1], [16, 32768, 0, 640, 1], [28, 32768, 1136, 640, 1], [17, 0, 0, 640, 1], [28, 0, -1136, 640, 1], [16, 32768, 0, 640, 1], [14, 32768, 1136, 640, 1], [32767, 49152, 0, 640, 1]], [[14, 49152, 0, 768, 4097], [12, 49152, 1364, 768, 1], [13, 0, 0, 768, 1], [24, 0, -1364, 768, 1], [12, 32768, 0, 768, 1], [24, 32768, 1364, 768, 1], [13, 0, 0, 768, 1], [24, 0, -1364, 768, 1], [12, 32768, 0, 768, 1], [12, 32768, 1364, 768, 1], [32767, 49152, 0, 768, 1]], [[10, 49152, 0, 1152, 4097], [8, 49152, 2046, 1152, 1], [9, 0, 0, 1152, 1], [16, 0, -2046, 1152, 1], [9, 32768, 0, 1152, 1], [16, 32768, 2046, 1152, 1], [9, 0, 0, 1152, 1], [16, 0, -2046, 1152, 1], [9, 32768, 0, 1152, 1], [8, 32768, 2046, 1152, 1], [32767, 49152, 0, 1152, 1]], [[6, 49152, 0, 1536, 4097], [6, 49152, 2728, 1536, 1], [6, 0, 0, 1536, 1], [12, 0, -2728, 1536, 1], [6, 32768, 0, 1536, 1], [12, 32768, 2728, 1536, 1], [6, 0, 0, 1536, 1], [12, 0, -2728, 1536, 1], [6, 32768, 0, 1536, 1], [6, 32768, 2728, 1536, 1], [32767, 49152, 0, 1536, 1]], [[126, 49152, 0, 128, 4097], [180, 0, 0, 128, 1], [64, 49152, 0, 128, 1], [180, 32768, 0, 128, 1], [64, 49152, 0, 128, 1], [180, 0, 0, 128, 1], [64, 49152, 0, 128, 1], [180, 32768, 0, 128, 1], [64, 49152, 0, 128, 1], [180, 0, 0, 128, 1], [64, 49152, 0, 128, 1], [180, 32768, 0, 128, 1], [64, 49152, 0, 128, 1], [32767, 49152, 0, 128, 1]], [[62, 49152, 0, 256, 4097], [88, 0, 0, 256, 1], [32, 49152, 0, 256, 1], [88, 32768, 0, 256, 1], [32, 49152, 0, 256, 1], [88, 0, 0, 256, 1], [32, 49152, 0, 256, 1], [88, 32768, 0, 256, 1], [32, 49152, 0, 256, 1], [88, 0, 0, 256, 1], [32, 49152, 0, 256, 1], [88, 32768, 0, 256, 1], [32, 49152, 0, 256, 1], [32767, 49152, 0, 256, 1]], [[42, 49152, 0, 384, 4097], [59, 0, 0, 384, 1], [20, 49152, 0, 384, 1], [59, 32768, 0, 384, 1], [20, 49152, 0, 384, 1], [59, 0, 0, 384, 1], [20, 49152, 0, 384, 1], [59, 32768, 0, 384, 1], [20, 49152, 0, 384, 1], [59, 0, 0, 384, 1], [20, 49152, 0, 384, 1], [59, 32768, 0, 384, 1], [20, 49152, 0, 384, 1], [32767, 49152, 0, 384, 1]], [[31, 49152, 0, 512, 4097], [44, 0, 0, 512, 1], [15, 49152, 0, 512, 1], [44, 32768, 0, 512, 1], [15, 49152, 0, 512, 1], [44, 0, 0, 512, 1], [15, 49152, 0, 512, 1], [44, 32768, 0, 512, 1], [15, 49152, 0, 512, 1], [44, 0, 0, 512, 1], [15, 49152, 0, 512, 1], [44, 32768, 0, 512, 1], [15, 49152, 0, 512, 1], [32767, 49152, 0, 512, 1]], [[25, 49152, 0, 640, 4097], [35, 0, 0, 640, 1], [12, 49152, 0, 640, 1], [35, 32768, 0, 640, 1], [12, 49152, 0, 640, 1], [35, 0, 0, 640, 1], [12, 49152, 0, 640, 1], [35, 32768, 0, 640, 1], [12, 49152, 0, 640, 1], [35, 0, 0, 640, 1], [12, 49152, 0, 640, 1], [35, 32768, 0, 640, 1], [12, 49152, 0, 640, 1], [32767, 49152, 0, 640, 1]], [[20, 49152, 0, 768, 4097], [29, 0, 0, 768, 1], [10, 49152, 0, 768, 1], [29, 32768, 0, 768, 1], [10, 49152, 0, 768, 1], [29, 0, 0, 768, 1], [10, 49152, 0, 768, 1], [29, 32768, 0, 768, 1], [10, 49152, 0, 768, 1], [29, 0, 0, 768, 1], [10, 49152, 0, 768, 1], [29, 32768, 0, 768, 1], [10, 49152, 0, 768, 1], [32767, 49152, 0, 768, 1]], [[14, 49152, 0, 1152, 4097], [19, 0, 0, 1152, 1], [6, 49152, 0, 1152, 1], [19, 32768, 0, 1152, 1], [6, 49152, 0, 1152, 1], [19, 0, 0, 1152, 1], [6, 49152, 0, 1152, 1], [19, 32768, 0, 1152, 1], [6, 49152, 0, 1152, 1], [19, 0, 0, 1152, 1], [6, 49152, 0, 1152, 1], [19, 32768, 0, 1152, 1], [6, 49152, 0, 1152, 1], [32767, 49152, 0, 1152, 1]], [[10, 49152, 0, 1536, 4097], [14, 0, 0, 1536, 1], [4, 49152, 0, 1536, 1], [14, 32768, 0, 1536, 1], [4, 49152, 0, 1536, 1], [14, 0, 0, 1536, 1], [4, 49152, 0, 1536, 1], [14, 32768, 0, 1536, 1], [4, 49152, 0, 1536, 1], [14, 0, 0, 1536, 1], [4, 49152, 0, 1536, 1], [14, 32768, 0, 1536, 1], [4, 49152, 0, 1536, 1], [32767, 49152, 0, 1536, 1]], [[223, 49152, 0, 128, 4113], [47, 49152, 0, 0, 1], [128, 54784, 0, 128, 17], [47, 54784, 0, 0, 1], [128, 10752, 0, 128, 17], [47, 10752, 0, 0, 1], [128, 32768, 0, 128, 17], [47, 32768, 0, 0, 1], [128, 54784, 0, 128, 17], [47, 54784, 0, 0, 1], [128, 10752, 0, 128, 17], [47, 10752, 0, 0, 1], [128, 32768, 0, 128, 17], [47, 32768, 0, 0, 1], [128, 54784, 0, 128, 17], [47, 54784, 0, 0, 1], [128, 10752, 0, 128, 17], [47, 10752, 0, 0, 1], [32767, 16384, 0, 128, 17]], [[111, 49152, 0, 256, 4113], [40, 49152, 0, 0, 1], [64, 54784, 0, 256, 17], [40, 54784, 0, 0, 1], [64, 10752, 0, 256, 17], [40, 10752, 0, 0, 1], [64, 32768, 0, 256, 17], [40, 32768, 0, 0, 1], [64, 54784, 0, 256, 17], [40, 54784, 0, 0, 1], [64, 10752, 0, 256, 17], [40, 10752, 0, 0, 1], [64, 32768, 0, 256, 17], [40, 32768, 0, 0, 1], [64, 54784, 0, 256, 17], [40, 54784, 0, 0, 1], [64, 10752, 0, 256, 17], [40, 10752, 0, 0, 1], [32767, 16384, 0, 256, 17]], [[74, 49152, 0, 384, 4113], [36, 49152, 0, 0, 1], [42, 54784, 0, 384, 17], [36, 54784, 0, 0, 1], [42, 10752, 0, 384, 17], [36, 10752, 0, 0, 1], [42, 32768, 0, 384, 17], [36, 32768, 0, 0, 1], [42, 54784, 0, 384, 17], [36, 54784, 0, 0, 1], [42, 10752, 0, 384, 17], [36, 10752, 0, 0, 1], [42, 32768, 0, 384, 17], [36, 32768, 0, 0, 1], [42, 54784, 0, 384, 17], [36, 54784, 0, 0, 1], [42, 10752, 0, 384, 17], [36, 10752, 0, 0, 1], [32767, 16384, 0, 384, 17]], [[55, 49152, 0, 512, 4113], [32, 49152, 0, 0, 1], [32, 54784, 0, 512, 17], [32, 54784, 0, 0, 1], [32, 10752, 0, 512, 17], [32, 10752, 0, 0, 1], [32, 32768, 0, 512, 17], [32, 32768, 0, 0, 1], [32, 54784, 0, 512, 17], [32, 54784, 0, 0, 1], [32, 10752, 0, 512, 17], [32, 10752, 0, 0, 1], [32, 32768, 0, 512, 17], [32, 32768, 0, 0, 1], [32, 54784, 0, 512, 17], [32, 54784, 0, 0, 1], [32, 10752, 0, 512, 17], [32, 10752, 0, 0, 1], [32767, 16384, 0, 512, 17]], [[44, 49152, 0, 640, 4113], [28, 49152, 0, 0, 1], [25, 54784, 0, 640, 17], [28, 54784, 0, 0, 1], [25, 10752, 0, 640, 17], [28, 10752, 0, 0, 1], [25, 32768, 0, 640, 17], [28, 32768, 0, 0, 1], [25, 54784, 0, 640, 17], [28, 54784, 0, 0, 1], [25, 10752, 0, 640, 17], [28, 10752, 0, 0, 1], [25, 32768, 0, 640, 17], [28, 32768, 0, 0, 1], [25, 54784, 0, 640, 17], [28, 54784, 0, 0, 1], [25, 10752, 0, 640, 17], [28, 10752, 0, 0, 1], [32767, 16384, 0, 640, 17]], [[36, 49152, 0, 768, 4113], [24, 49152, 0, 0, 1], [21, 54784, 0, 768, 17], [24, 54784, 0, 0, 1], [21, 10752, 0, 768, 17], [24, 10752, 0, 0, 1], [21, 32768, 0, 768, 17], [24, 32768, 0, 0, 1], [21, 54784, 0, 768, 17], [24, 54784, 0, 0, 1], [21, 10752, 0, 768, 17], [24, 10752, 0, 0, 1], [21, 32768, 0, 768, 17], [24, 32768, 0, 0, 1], [21, 54784, 0, 768, 17], [24, 54784, 0, 0, 1], [21, 10752, 0, 768, 17], [24, 10752, 0, 0, 1], [32767, 16384, 0, 768, 17]], [[24, 49152, 0, 1152, 4113], [20, 49152, 0, 0, 1], [14, 54784, 0, 1152, 17], [20, 54784, 0, 0, 1], [14, 10752, 0, 1152, 17], [20, 10752, 0, 0, 1], [14, 32768, 0, 1152, 17], [20, 32768, 0, 0, 1], [14, 54784, 0, 1152, 17], [20, 54784, 0, 0, 1], [14, 10752, 0, 1152, 17], [20, 10752, 0, 0, 1], [14, 32768, 0, 1152, 17], [20, 32768, 0, 0, 1], [14, 54784, 0, 1152, 17], [20, 54784, 0, 0, 1], [14, 10752, 0, 1152, 17], [20, 10752, 0, 0, 1], [32767, 16384, 0, 1152, 17]], [[16, 49152, 0, 1536, 4113], [15, 49152, 0, 0, 1], [10, 54784, 0, 1536, 17], [15, 54784, 0, 0, 1], [10, 10752, 0, 1536, 17], [15, 10752, 0, 0, 1], [10, 32768, 0, 1536, 17], [15, 32768, 0, 0, 1], [10, 54784, 0, 1536, 17], [15, 54784, 0, 0, 1], [10, 10752, 0, 1536, 17], [15, 10752, 0, 0, 1], [10, 32768, 0, 1536, 17], [15, 32768, 0, 0, 1], [10, 54784, 0, 1536, 17], [15, 54784, 0, 0, 1], [10, 10752, 0, 1536, 17], [15, 10752, 0, 0, 1], [32767, 16384, 0, 1536, 17]], [[127, 49152, 0, 128, 4113], [18, 49152, 0, 0, 1], [63, 0, 0, 128, 17], [18, 0, 0, 0, 1], [63, 49152, 0, 128, 17], [18, 49152, 0, 0, 1], [63, 0, 0, 128, 17], [18, 0, 0, 0, 1], [63, 49152, 0, 128, 17], [18, 49152, 0, 0, 1], [63, 0, 0, 128, 17], [18, 0, 0, 0, 1], [63, 49152, 0, 128, 17], [18, 49152, 0, 0, 1], [63, 0, 0, 128, 17], [18, 0, 0, 0, 1], [63, 49152, 0, 128, 17], [18, 49152, 0, 0, 1], [63, 0, 0, 128, 17], [18, 0, 0, 0, 1], [63, 49152, 0, 128, 17], [32767, 49152, 0, 128, 17]], [[63, 49152, 0, 256, 4113], [18, 49152, 0, 0, 1], [33, 0, 0, 256, 17], [18, 0, 0, 0, 1], [33, 49152, 0, 256, 17], [18, 49152, 0, 0, 1], [33, 0, 0, 256, 17], [18, 0, 0, 0, 1], [33, 49152, 0, 256, 17], [18, 49152, 0, 0, 1], [33, 0, 0, 256, 17], [18, 0, 0, 0, 1], [33, 49152, 0, 256, 17], [18, 49152, 0, 0, 1], [33, 0, 0, 256, 17], [18, 0, 0, 0, 1], [33, 49152, 0, 256, 17], [18, 49152, 0, 0, 1], [33, 0, 0, 256, 17], [18, 0, 0, 0, 1], [33, 49152, 0, 256, 17], [32767, 49152, 0, 256, 17]], [[41, 49152, 0, 384, 4113], [18, 49152, 0, 0, 1], [21, 0, 0, 384, 17], [18, 0, 0, 0, 1], [21, 49152, 0, 384, 17], [18, 49152, 0, 0, 1], [21, 0, 0, 384, 17], [18, 0, 0, 0, 1], [21, 49152, 0, 384, 17], [18, 49152, 0, 0, 1], [21, 0, 0, 384, 17], [18, 0, 0, 0, 1], [21, 49152, 0, 384, 17], [18, 49152, 0, 0, 1], [21, 0, 0, 384, 17], [18, 0, 0, 0, 1], [21, 49152, 0, 384, 17], [18, 49152, 0, 0, 1], [21, 0, 0, 384, 17], [18, 0, 0, 0, 1], [21, 49152, 0, 384, 17], [32767, 49152, 0, 384, 17]], [[31, 49152, 0, 512, 4113], [18, 49152, 0, 0, 1], [15, 0, 0, 512, 17], [18, 0, 0, 0, 1], [15, 49152, 0, 512, 17], [18, 49152, 0, 0, 1], [15, 0, 0, 512, 17], [18, 0, 0, 0, 1], [15, 49152, 0, 512, 17], [18, 49152, 0, 0, 1], [15, 0, 0, 512, 17], [18, 0, 0, 0, 1], [15, 49152, 0, 512, 17], [18, 49152, 0, 0, 1], [15, 0, 0, 512, 17], [18, 0, 0, 0, 1], [15, 49152, 0, 512, 17], [18, 49152, 0, 0, 1], [15, 0, 0, 512, 17], [18, 0, 0, 0, 1], [15, 49152, 0, 512, 17], [32767, 49152, 0, 512, 17]], [[25, 49152, 0, 640, 4113], [18, 49152, 0, 0, 1], [12, 0, 0, 640, 17], [18, 0, 0, 0, 1], [12, 49152, 0, 640, 17], [18, 49152, 0, 0, 1], [12, 0, 0, 640, 17], [18, 0, 0, 0, 1], [12, 49152, 0, 640, 17], [18, 49152, 0, 0, 1], [12, 0, 0, 640, 17], [18, 0, 0, 0, 1], [12, 49152, 0, 640, 17], [18, 49152, 0, 0, 1], [12, 0, 0, 640, 17], [18, 0, 0, 0, 1], [12, 49152, 0, 640, 17], [18, 49152, 0, 0, 1], [12, 0, 0, 640, 17], [18, 0, 0, 0, 1], [12, 49152, 0, 640, 17], [32767, 49152, 0, 640, 17]], [[20, 49152, 0, 768, 4113], [18, 49152, 0, 0, 1], [10, 0, 0, 768, 17], [18, 0, 0, 0, 1], [10, 49152, 0, 768, 17], [18, 49152, 0, 0, 1], [10, 0, 0, 768, 17], [18, 0, 0, 0, 1], [10, 49152, 0, 768, 17], [18, 49152, 0, 0, 1], [10, 0, 0, 768, 17], [18, 0, 0, 0, 1], [10, 49152, 0, 768, 17], [18, 49152, 0, 0, 1], [10, 0, 0, 768, 17], [18, 0, 0, 0, 1], [10, 49152, 0, 768, 17], [18, 49152, 0, 0, 1], [10, 0, 0, 768, 17], [18, 0, 0, 0, 1], [10, 49152, 0, 768, 17], [32767, 49152, 0, 768, 17]], [[13, 49152, 0, 1152, 4113], [18, 49152, 0, 0, 1], [6, 0, 0, 1152, 17], [18, 0, 0, 0, 1], [6, 49152, 0, 1152, 17], [18, 49152, 0, 0, 1], [6, 0, 0, 1152, 17], [18, 0, 0, 0, 1], [6, 49152, 0, 1152, 17], [18, 49152, 0, 0, 1], [6, 0, 0, 1152, 17], [18, 0, 0, 0, 1], [6, 49152, 0, 1152, 17], [18, 49152, 0, 0, 1], [6, 0, 0, 1152, 17], [18, 0, 0, 0, 1], [6, 49152, 0, 1152, 17], [18, 49152, 0, 0, 1], [6, 0, 0, 1152, 17], [18, 0, 0, 0, 1], [6, 49152, 0, 1152, 17], [32767, 49152, 0, 1152, 17]], [[10, 49152, 0, 1536, 4113], [18, 49152, 0, 0, 1], [4, 0, 0, 1536, 17], [18, 0, 0, 0, 1], [4, 49152, 0, 1536, 17], [18, 49152, 0, 0, 1], [4, 0, 0, 1536, 17], [18, 0, 0, 0, 1], [4, 49152, 0, 1536, 17], [18, 49152, 0, 0, 1], [4, 0, 0, 1536, 17], [18, 0, 0, 0, 1], [4, 49152, 0, 1536, 17], [18, 49152, 0, 0, 1], [4, 0, 0, 1536, 17], [18, 0, 0, 0, 1], [4, 49152, 0, 1536, 17], [18, 49152, 0, 0, 1], [4, 0, 0, 1536, 17], [18, 0, 0, 0, 1], [4, 49152, 0, 1536, 17], [32767, 49152, 0, 1536, 17]], [[32767, 49152, 0, 128, 513]], [[32767, 49152, 0, 256, 513]], [[32767, 49152, 0, 384, 513]], [[32767, 49152, 0, 512, 513]], [[32767, 49152, 0, 640, 513]], [[32767, 49152, 0, 768, 513]], [[32767, 49152, 0, 1152, 513]], [[32767, 49152, 0, 1536, 513]], [[120, 49152, 0, 128, 4097], [216, 49152, 37, 128, 1], [240, 57344, 68, 128, 1], [384, 8192, 85, 128, 1], [240, 40960, 68, 128, 1], [216, 57344, 37, 128, 1], [32767, 0, 0, 128, 1]], [[64, 49152, 0, 256, 4097], [108, 49152, 75, 256, 1], [120, 57344, 136, 256, 1], [192, 8192, 170, 256, 1], [120, 40960, 136, 256, 1], [108, 57344, 75, 256, 1], [32767, 0, 0, 256, 1]], [[38, 49152, 0, 384, 4097], [72, 49152, 113, 384, 1], [80, 57344, 204, 384, 1], [128, 8192, 255, 384, 1], [80, 40960, 204, 384, 1], [72, 57344, 113, 384, 1], [32767, 0, 0, 384, 1]], [[29, 49152, 0, 512, 4097], [54, 49152, 151, 512, 1], [60, 57344, 272, 512, 1], [96, 8192, 341, 512, 1], [60, 40960, 272, 512, 1], [54, 57344, 151, 512, 1], [32767, 0, 0, 512, 1]], [[21, 49152, 0, 640, 4097], [43, 49152, 189, 640, 1], [48, 57344, 341, 640, 1], [76, 8192, 426, 640, 1], [48, 40960, 341, 640, 1], [43, 57344, 189, 640, 1], [32767, 0, 0, 640, 1]], [[17, 49152, 0, 768, 4097], [36, 49152, 227, 768, 1], [40, 57344, 409, 768, 1], [64, 8192, 511, 768, 1], [40, 40960, 409, 768, 1], [36, 57344, 227, 768, 1], [32767, 0, 0, 768, 1]], [[11, 49152, 0, 1152, 4097], [24, 49152, 341, 1152, 1], [27, 57344, 613, 1152, 1], [42, 8192, 767, 1152, 1], [27, 40960, 613, 1152, 1], [24, 57344, 341, 1152, 1], [32767, 0, 0, 1152, 1]], [[9, 49152, 0, 1536, 4097], [18, 49152, 454, 1536, 1], [20, 57344, 818, 1536, 1], [32, 8192, 1023, 1536, 1], [20, 40960, 818, 1536, 1], [18, 57344, 454, 1536, 1], [32767, 0, 0, 1536, 1]], [[260, 49152, 0, 128, 4097], [1152, 49152, 85, 128, 1], [32767, 16384, 0, 128, 1]], [[129, 49152, 0, 256, 4097], [576, 49152, 170, 256, 1], [32767, 16384, 0, 256, 1]], [[86, 49152, 0, 384, 4097], [384, 49152, 255, 384, 1], [32767, 16384, 0, 384, 1]], [[64, 49152, 0, 512, 4097], [288, 49152, 341, 512, 1], [32767, 16384, 0, 512, 1]], [[51, 49152, 0, 640, 4097], [228, 49152, 426, 640, 1], [32767, 16384, 0, 640, 1]], [[43, 49152, 0, 768, 4097], [192, 49152, 511, 768, 1], [32767, 16384, 0, 768, 1]], [[28, 49152, 0, 1152, 4097], [126, 49152, 767, 1152, 1], [32767, 16384, 0, 1152, 1]], [[20, 49152, 0, 1536, 4097], [96, 49152, 1023, 1536, 1], [32767, 16384, 0, 1536, 1]], [[147, 49152, 0, 128, 4113], [144, 8192, -170, 128, 1], [16, 49152, 0, 128, 1], [144, 24576, 170, 128, 1], [16, 49152, 0, 128, 1], [144, 8192, -170, 128, 1], [16, 49152, 0, 128, 1], [144, 24576, 170, 128, 1], [16, 49152, 0, 128, 1], [144, 8192, -170, 128, 1], [16, 49152, 0, 128, 1], [144, 24576, 170, 128, 1], [32767, 49152, 0, 128, 1]], [[72, 49152, 0, 256, 4113], [72, 8192, -341, 256, 1], [8, 49152, 0, 256, 1], [72, 24576, 341, 256, 1], [8, 49152, 0, 256, 1], [72, 8192, -341, 256, 1], [8, 49152, 0, 256, 1], [72, 24576, 341, 256, 1], [8, 49152, 0, 256, 1], [72, 8192, -341, 256, 1], [8, 49152, 0, 256, 1], [72, 24576, 341, 256, 1], [32767, 49152, 0, 256, 1]], [[46, 49152, 0, 384, 4113], [48, 8192, -512, 384, 1], [6, 49152, 0, 384, 1], [48, 24576, 512, 384, 1], [6, 49152, 0, 384, 1], [48, 8192, -512, 384, 1], [6, 49152, 0, 384, 1], [48, 24576, 512, 384, 1], [6, 49152, 0, 384, 1], [48, 8192, -512, 384, 1], [6, 49152, 0, 384, 1], [48, 24576, 512, 384, 1], [32767, 49152, 0, 384, 1]], [[34, 49152, 0, 512, 4113], [36, 8192, -682, 512, 1], [5, 49152, 0, 512, 1], [36, 24576, 682, 512, 1], [5, 49152, 0, 512, 1], [36, 8192, -682, 512, 1], [5, 49152, 0, 512, 1], [36, 24576, 682, 512, 1], [5, 49152, 0, 512, 1], [36, 8192, -682, 512, 1], [5, 49152, 0, 512, 1], [36, 24576, 682, 512, 1], [32767, 49152, 0, 512, 1]], [[27, 49152, 0, 640, 4113], [29, 8192, -847, 640, 1], [4, 49152, 0, 640, 1], [29, 24576, 847, 640, 1], [4, 49152, 0, 640, 1], [29, 8192, -847, 640, 1], [4, 49152, 0, 640, 1], [29, 24576, 847, 640, 1], [4, 49152, 0, 640, 1], [29, 8192, -847, 640, 1], [4, 49152, 0, 640, 1], [29, 24576, 847, 640, 1], [32767, 49152, 0, 640, 1]], [[23, 49152, 0, 768, 4113], [24, 8192, -1024, 768, 1], [3, 49152, 0, 768, 1], [24, 24576, 1024, 768, 1], [3, 49152, 0, 768, 1], [24, 8192, -1024, 768, 1], [3, 49152, 0, 768, 1], [24, 24576, 1024, 768, 1], [3, 49152, 0, 768, 1], [24, 8192, -1024, 768, 1], [3, 49152, 0, 768, 1], [24, 24576, 1024, 768, 1], [32767, 49152, 0, 768, 1]], [[15, 49152, 0, 1152, 4113], [16, 8192, -1536, 1152, 1], [2, 49152, 0, 1152, 1], [16, 24576, 1536, 1152, 1], [2, 49152, 0, 1152, 1], [16, 8192, -1536, 1152, 1], [2, 49152, 0, 1152, 1], [16, 24576, 1536, 1152, 1], [2, 49152, 0, 1152, 1], [16, 8192, -1536, 1152, 1], [2, 49152, 0, 1152, 1], [16, 24576, 1536, 1152, 1], [32767, 49152, 0, 1152, 1]], [[11, 49152, 0, 1536, 4113], [12, 8192, -2048, 1536, 1], [1, 49152, 0, 1536, 1], [12, 24576, 2048, 1536, 1], [1, 49152, 0, 1536, 1], [12, 8192, -2048, 1536, 1], [1, 49152, 0, 1536, 1], [12, 24576, 2048, 1536, 1], [1, 49152, 0, 1536, 1], [12, 8192, -2048, 1536, 1], [1, 49152, 0, 1536, 1], [12, 24576, 2048, 1536, 1], [32767, 49152, 0, 1536, 1]], [[32767, 128, -4, 128, 128]], [[32767, 256, -12, 192, 128]], [[32767, 448, -20, 256, 128]], [[32767, 704, -36, 320, 128]], [[32767, 1024, -56, 384, 128]], [[32767, 1408, -80, 448, 128]], [[32767, 1856, -108, 512, 128]], [[32767, 2368, -140, 576, 128]], [[528, 49152, 31, 128, 1], [32767, 0, 0, 128, 1]], [[264, 49152, 62, 256, 1], [32767, 0, 0, 256, 1]], [[176, 49152, 93, 384, 1], [32767, 0, 0, 384, 1]], [[132, 49152, 124, 512, 1], [32767, 0, 0, 512, 1]], [[106, 49152, 155, 640, 1], [32767, 0, 0, 640, 1]], [[88, 49152, 186, 768, 1], [32767, 0, 0, 768, 1]], [[59, 49152, 279, 1152, 1], [32767, 0, 0, 1152, 1]], [[44, 49152, 372, 1536, 1], [32767, 0, 0, 1536, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[223, 49152, 0, 128, 4097], [20, 49152, 0, 0, 257], [32767, 0, 0, 128, 257]], [[111, 49152, 0, 256, 4097], [18, 49152, 0, 0, 257], [32767, 0, 0, 256, 257]], [[74, 49152, 0, 384, 4097], [16, 49152, 0, 0, 257], [32767, 0, 0, 384, 257]], [[55, 49152, 0, 512, 4097], [14, 49152, 0, 0, 257], [32767, 0, 0, 512, 257]], [[44, 49152, 0, 640, 4097], [12, 49152, 0, 0, 257], [32767, 0, 0, 640, 257]], [[36, 49152, 0, 768, 4097], [10, 49152, 0, 0, 257], [32767, 0, 0, 768, 257]], [[24, 49152, 0, 1152, 4097], [8, 49152, 0, 0, 257], [32767, 0, 0, 1152, 257]], [[16, 49152, 0, 1536, 4097], [1, 49152, 0, 1152, 1], [6, 49152, 0, 0, 257], [32767, 0, 0, 1536, 257]], [[320, 49152, 0, 128, 4097], [20, 49152, 0, 0, 257], [32767, 0, 0, 128, 257]], [[160, 49152, 0, 256, 4097], [18, 49152, 0, 0, 257], [32767, 0, 0, 256, 257]], [[106, 49152, 0, 384, 4097], [16, 49152, 0, 0, 257], [32767, 0, 0, 384, 257]], [[80, 49152, 0, 512, 4097], [14, 49152, 0, 0, 257], [32767, 0, 0, 512, 257]], [[64, 49152, 0, 640, 4097], [12, 49152, 0, 0, 257], [32767, 0, 0, 640, 257]], [[53, 49152, 0, 768, 4097], [10, 49152, 0, 0, 257], [32767, 0, 0, 768, 257]], [[35, 49152, 0, 1152, 4097], [1, 49152, 0, 640, 1], [8, 49152, 0, 0, 257], [32767, 0, 0, 1152, 257]], [[26, 49152, 0, 1536, 4097], [1, 49152, 0, 1024, 1], [6, 49152, 0, 0, 257], [32767, 0, 0, 1536, 257]], [[32767, 55296, 0, 128, 1]], [[32767, 55296, 0, 256, 1]], [[32767, 55296, 0, 384, 1]], [[32767, 55296, 0, 512, 1]], [[32767, 55296, 0, 640, 1]], [[32767, 55296, 0, 768, 1]], [[32767, 55296, 0, 1152, 1]], [[32767, 55296, 0, 1536, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]], [[32767, 49152, 0, 0, 1]]];
function appearanceAnchored(id) {
  const group = (id & 255) >> 3;
  return group === 0 || group === 2 || group === 3;
}
function appearanceScript(id) {
  const raw = APPEARANCE_SCRIPTS[id & 255];
  if (!raw) return null;
  return {
    id: id & 255,
    objectClass: APPEARANCE_CLASSES[id & 255],
    scripted: APPEARANCE_CLASSES[id & 255] === 48,
    anchored: appearanceAnchored(id),
    rows: raw.map(([dur, angle, turnRate, amp, flags]) => ({
      dur,
      // degrees, from the engine's 65536-unit circle
      angle: angle * 360 / 65536,
      turnRate: turnRate * 360 / 65536,
      amp: amp & 32767,
      ridesScroll: (amp & RIDES_SCROLL) !== 0,
      flags,
      advance: (flags & APPEARANCE_FLAGS.ADVANCE) !== 0,
      noFire: (flags & APPEARANCE_FLAGS.NO_FIRE) !== 0,
      velCos: (flags & APPEARANCE_FLAGS.VEL_COS) !== 0,
      velSin: (flags & APPEARANCE_FLAGS.VEL_SIN) !== 0,
      interp2: (flags & APPEARANCE_FLAGS.INTERP2) !== 0,
      halfDur: (flags & APPEARANCE_FLAGS.HALF_DUR) !== 0
    }))
  };
}

// packages/shmup-engine/src/map-to-game.js
var GRID_COLS = 8;
var MAX_STAGES2 = 10;
var SINGLE_LETTER_ENEMIES = 26;
var BLANK_WAVES = 8;
var FRAMES_PER_SOURCE_ROW = 8;
var PLAYER_SHOT_DAMAGE_BY_LEVEL = [9, 12, 15, 18, 21];
var ENGINE_SHOT_DAMAGE = 20;
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
  playerData2: TROOPER_PLAYER,
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
    playerData2: clone(defaults.playerData2),
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
  for (const frame of decodePlayer2Art()) {
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
      const armoured = !!(e.behavior.move && e.behavior.move.mode & 1);
      rec.hp = armoured ? "infinity" : Math.max(1, Math.ceil(e.behavior.hp / (shotDamage * 256)));
      rec.score = e.behavior.score;
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
        attributes: toHex(e.bytes),
        // The engine's FORMATION KEY: every grid-spawned enemy carries
        // its placement cell byte in `0x06090530[slot]`, and the death
        // word's chain mode sweeps everything sharing one. Record index
        // and cell byte are a bijection, so it is recoverable here.
        placementId: zakoPlacementId(e.record)
      };
      if (e.behavior) {
        rec.dezaemon.behavior = clone(e.behavior);
        const script = appearanceScript(e.behavior.appearance);
        if (script) {
          rec.dezaemon.entry = script.scripted ? { rows: APPEARANCE_SCRIPTS[script.id] } : { objectClass: script.objectClass };
          if (script.anchored) rec.dezaemon.entry.anchored = true;
        }
      }
    }
    enemyData[`enemy${letters}`] = rec;
  });
  const enemyKeyByStageRecord = /* @__PURE__ */ new Map();
  decodedEnemies.forEach((e, i) => {
    if (e.stage === void 0) return;
    enemyKeyByStageRecord.set(`${e.stage}:${e.record}`, `enemy${enemyLetterByIndex[i]}`);
  });
  decodedEnemies.forEach((e, i) => {
    const death = e.behavior && e.behavior.death;
    if (!death || death.mode !== 2) return;
    const child = enemyKeyByStageRecord.get(`${e.stage}:${death.record}`);
    const rec = enemyData[`enemy${enemyLetterByIndex[i]}`];
    if (child && rec && rec.dezaemon) rec.dezaemon.deathChild = child;
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
  const titleScreen = {};
  if (decoded.settings && decoded.settings.titleEntrance) {
    titleScreen.entrance = clone(decoded.settings.titleEntrance);
  }
  if (decoded.titleLayout) titleScreen.layout = clone(decoded.titleLayout);
  if (decoded.settings && decoded.settings.staffRoleIndices) {
    titleScreen.staffRoles = [...decoded.settings.staffRoleIndices];
    titleScreen.staffLabels = [...decoded.settings.staffRoles];
  }
  if (Object.keys(titleScreen).length) gameJson.dezaemonTitleScreen = titleScreen;
  gameJson.playerData = clone(DUKE_PLAYER);
  gameJson.playerData2 = clone(TROOPER_PLAYER);
  if (backgroundCells.length) gameJson.backgroundCells = backgroundCells;
  gameJson.enemyData = enemyData;
  gameJson.bossData = bossData;
  const sec6 = decoded.sections && decoded.sections[6] && decoded.sections[6].decompressed;
  if (decoded.settings && sec6 && decoded.songs) {
    const table = decoded.settings.bgmTable;
    const special = table.slice(0, 4);
    const stagePairs = [];
    for (let s2 = 0; s2 * 2 + 5 < table.length && s2 < stageCount; s2++) {
      stagePairs.push([table[4 + s2 * 2], table[5 + s2 * 2]]);
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
    if (art.player2 && art.player2.idle) {
      const idle2 = keysOf(art.player2.idle).filter(Boolean);
      if (idle2.length) {
        gameJson.playerData2 = { name: "dezaShip2", texture: idle2 };
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
      staffRoleIndices: decoded.settings.staffRoleIndices,
      titleEntrance: decoded.settings.titleEntrance,
      mainWeapon: decoded.settings.mainWeapon,
      mainWeapon2P: decoded.settings.loadouts ? decoded.settings.loadouts[decoded.settings.ships[1].startLoadout].main : void 0,
      // Both ship config blocks in full (+0x0C P1, +0x10 P2). P2 join-in
      // reads ships[1] for its own starting loadout, speed cap, power
      // levels and autofire cadence; `mainWeapon2P` above is the same
      // ship's starting MAIN weapon (byte0 bits4-6 — it followed the
      // 2026-09-02 MAIN/SUB correction), kept for callers that predate
      // this.
      ships: decoded.settings.ships ? decoded.settings.ships.map((sh) => ({
        startLoadout: sh.startLoadout,
        rapidParam: sh.rapidParam,
        maxSpeed: sh.maxSpeed,
        initialPower: sh.initialPower,
        maxPower: sh.maxPower,
        autofireFrames: sh.autofireFrames
      })) : void 0,
      // The four WEAPON LOADOUT presets in full — the editor's MAIN,
      // SUB, CHARGE and BOMB rows — plus which one each ship starts on.
      // Weapon-change items (types 0-3) switch between them mid-game, so
      // the runtime needs all four, not just the starting set.
      loadouts: decoded.settings.loadouts ? decoded.settings.loadouts.map((l) => ({
        main: l.main,
        sub: l.sub,
        charge: l.charge,
        bomb: l.bomb,
        bombVariant: l.bombVariant
      })) : void 0,
      startLoadout: decoded.settings.ships ? decoded.settings.ships.map((sh) => sh.startLoadout) : void 0,
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
      "this is a HORIZONTAL-scroll save (game mode bit 0) \u2014 the world plays correctly (the engine's horizontal mode is the same simulation drawn transposed, and the runtime applies its scroll rate, entry margin and trigger lines), but the art is authored for a landscape screen, so turn your device to read it the right way up"
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
function decompressCmp(raw) {
  if (!raw || raw.length < 4) {
    throw new Error("CMP: missing length header");
  }
  const len = (raw[0] | raw[1] << 8 | raw[2] << 16 | raw[3] << 24) >>> 0;
  if (4 + len > raw.length) {
    throw new Error(`CMP: header says ${len} bytes, only ${raw.length - 4} follow`);
  }
  return decompress(raw.subarray(4, 4 + len));
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
function rgb555ToRgb(raw) {
  const r5 = raw & 31;
  const g5 = raw >> 5 & 31;
  const b5 = raw >> 10 & 31;
  return {
    r: r5 << 3 | r5 >> 2,
    g: g5 << 3 | g5 >> 2,
    b: b5 << 3 | b5 >> 2
  };
}
function rgb555ToHex(raw) {
  const { r, g, b } = rgb555ToRgb(raw);
  return r << 16 | g << 8 | b;
}
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
      const { r, g, b } = rgb555ToRgb(raw);
      colors.push({
        raw,
        r,
        g,
        b,
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
  // OPTION A: 1280 tap, floored — the pods are untraced
  6: 5120,
  // OPTION B: 384/bullet at 1-frame intervals — floored
  7: 5120
  // OPTION C: no traced table — floored
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
var TITLE_ENTRANCE = {
  // vertical entry: start y (px) and per-frame step, landing on y = 80
  y: { 0: null, 1: { from: -64, step: 1.125 }, 2: { from: 304, step: -1.75 }, 3: null },
  // horizontal entry: start x (px) and per-frame step, landing on x = 160
  x: { 0: null, 1: { from: 448, step: -2.25 }, 2: { from: -128, step: 2.25 }, 3: null },
  // spin: whole turns over the 128 frames (+0x200 / -0x200 of 0x10000 a
  // frame); positive is clockwise on screen
  spin: { 0: 0, 1: 1, 2: -1, 3: 0 },
  // scale, as a multiple of the rest scale: from 2x shrinking (0x4000 ->
  // 0x2000 by -64 a frame) or from 0 growing (+64 a frame)
  scale: { 0: null, 1: { from: 2, step: -1 / 128 }, 2: { from: 0, step: 1 / 128 }, 3: null }
};
function titleEntranceFields(a, b) {
  return {
    y: a & 3,
    x: a >> 2 & 3,
    spin: a >> 4 & 3,
    scaleH: b & 3,
    scaleW: b >> 2 & 3,
    raw: [a, b]
  };
}
function decodeTitleEntrance(sec5, base) {
  return {
    // TITLE 1 is the front logo (sort byte 3 against TITLE 2's 4; the
    // engine's later layers sit further back)
    title1: titleEntranceFields(sec5[base + 43], sec5[base + 44]),
    title2: titleEntranceFields(sec5[base + 41], sec5[base + 42])
  };
}
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
    main: b0 >> 4 & 7,
    sub: b0 & 7,
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
    // Player 1's starting MAIN weapon (byte0 bits4-6). Metadata only —
    // nothing downstream branches on it.
    mainWeapon: startWeapons.main,
    // Shot damage stays keyed on byte0 bits0-2, the SUB field, because
    // that is the weapon the runtime's own autofire stands in for and the
    // field WEAPON_FULL_POWER_DAMAGE above was calibrated against. The
    // 2026-09-02 MAIN/SUB correction renamed the field under it and left
    // the value untouched; whether the pace should instead follow MAIN is
    // a separate question that would change every save's difficulty.
    shotDamage: weaponShotDamage(startWeapons.sub),
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
    // +0x41..+0x58: the 24-entry BGM assignment table. Four special
    // tracks first — +0x41 title, +0x42 game over, +0x43 stage clear,
    // +0x44 all-clear (it keeps playing through the staff roll) — then a
    // (main, boss) pair per stage row from +0x45 (engine-traced
    // 2026-09-01: the stage start reads settings[+0x45 + 2*row], the boss
    // spawn +0x46 + 2*row; the earlier "three special tracks" reading
    // was off by one).
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
    staffRoleIndices: [90, 91, 92].map((o) => sec5[base + o] & 15),
    // +0x29..+0x2C: the title screen's entrance program (TITLE_ENTRANCE).
    titleEntrance: decodeTitleEntrance(sec5, base),
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
  return { w, h, rgba, x: minX, y: minY };
}
function extractTitleArt(sec5, sections, palettes, baseIndex) {
  const sprites = [];
  const roles = {};
  const layout = { title: { w: 128, h: 64 }, strip: { w: 64, h: 16 }, credits: [] };
  const placeholder = findPlaceholderCell(sec5).cell;
  const renderSlot = (slot) => {
    const comp = readBankComposition(sec5, slot);
    if (!comp || isUnpainted({ frames: [comp] }, placeholder)) return null;
    return trimRgba(renderFrame(sections, palettes, comp));
  };
  const place = (img) => ({ x: img.x, y: img.y, w: img.w, h: img.h });
  const push = (key, img) => {
    const index = baseIndex + sprites.length;
    sprites.push({ key, w: img.w, h: img.h, rgba: img.rgba });
    return index;
  };
  const title1 = renderSlot(TITLE_SLOTS.title1);
  if (title1) {
    roles.title1 = push("dezaTitle1", title1);
    layout.title1 = place(title1);
  }
  const title2 = renderSlot(TITLE_SLOTS.title2);
  if (title2) {
    roles.title2 = push("dezaTitle2", title2);
    layout.title2 = place(title2);
  }
  const lines = [];
  const seen = /* @__PURE__ */ new Set();
  TITLE_SLOTS.credits.forEach((slot, k) => {
    const line = renderSlot(slot);
    layout.credits[k] = line ? place(line) : null;
    if (!line) return;
    roles[`credit${k}`] = push(`dezaCredit${k}`, line);
    const sig = line.rgba.join();
    if (seen.has(sig)) return;
    seen.add(sig);
    lines.push(line);
  });
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
  return { sprites, roles, layout };
}
var GLOBAL_ART_SLOTS = {
  playerIdle: { first: 8, w: 2, h: 2, frames: 2 },
  playerBankA: { first: 0, w: 2, h: 2, frames: 2 },
  playerBankB: { first: 16, w: 2, h: 2, frames: 2 },
  // P2's three pairs sit immediately after P1's, same geometry (refs 24-47).
  // Only a save authored for 2P join-in (game mode bit1) paints them, so the
  // all-or-nothing pushFrames rule below is what tells the two apart.
  player2Idle: { first: 32, w: 2, h: 2, frames: 2 },
  player2BankA: { first: 24, w: 2, h: 2, frames: 2 },
  player2BankB: { first: 40, w: 2, h: 2, frames: 2 },
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
  const idle2 = pushFrames("dezaShip2", GLOBAL_ART_SLOTS.player2Idle);
  if (idle2) {
    roles.player2 = { idle: idle2 };
    const bankA2 = pushFrames("dezaShip2L", GLOBAL_ART_SLOTS.player2BankA);
    const bankB2 = pushFrames("dezaShip2R", GLOBAL_ART_SLOTS.player2BankB);
    if (bankA2) roles.player2.bankA = bankA2;
    if (bankB2) roles.player2.bankB = bankB2;
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
var BOSS_ARRIVE_LATERAL = [160, -16, 160, 336];
var BOSS_ARRIVE_SCROLL = [56, 280, 56, -56];
var BOSS_DEATH_LATERAL = [160, 336, 160, -16];
var BOSS_DEATH_SCROLL = [56, -56, 56, 280];
var BOSS_CLASS_NUDGE = [0, 0, 32, 32];
var BOSS_PARK_LATERAL = BOSS_ARRIVE_LATERAL[0];
var BOSS_PARK_SCROLL = BOSS_ARRIVE_SCROLL[0];
function fxSpec(b) {
  return {
    zoom: (b & 1) !== 0,
    zoomFromLarge: (b & 2) === 0,
    // clear = start at 4.0x, set = start at 0
    spin: (b & 4) !== 0,
    spinReverse: (b & 8) !== 0
  };
}
function arriveSpec(b, sizeClass) {
  const usesScroll = (b & 80) !== 0;
  const nudge = BOSS_CLASS_NUDGE[sizeClass & 3];
  return {
    lateral: b & 64 ? BOSS_ARRIVE_LATERAL[b >> 6 & 3] : BOSS_PARK_LATERAL,
    scroll: (usesScroll ? BOSS_ARRIVE_SCROLL[b >> 4 & 3] : -56) + (b & 16 ? nudge : -nudge),
    defaultEntry: !usesScroll,
    ...fxSpec(b)
  };
}
function deathSpec(b, fadeOut) {
  return {
    // With neither gate bit set the boss dies where it stands.
    lateral: b & 64 ? BOSS_DEATH_LATERAL[b >> 6 & 3] : null,
    scroll: b & 16 ? BOSS_DEATH_SCROLL[b >> 4 & 3] : null,
    ...fxSpec(b),
    // record byte0 bit7: a 159-frame hold then a 64-frame level ramp to
    // nothing — the boss fades out rather than gaining a second spin.
    fadeOut
  };
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
    // Byte 6 / byte 7 decoded (2026-08-28): the off-screen start point
    // and the death-drift target, each picked out of two 4-entry
    // position preset tables, plus the spin/zoom flourishes.
    arrival: arriveSpec(t[6], t[0] & 3),
    dying: deathSpec(t[7], (t[0] & 128) !== 0),
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
var SHAPE_FAMILIES = 6;
var FAMILY_MESH_COUNTS = [32, 72, 36, 36, 36, 12];
var FAMILY_FILE_RANGES = [
  [1, 8],
  [9, 26],
  [27, 35],
  [36, 44],
  [45, 53],
  [54, 56]
];
var u16 = (b, o) => b[o] << 8 | b[o + 1];
var s32 = (b, o) => b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3] | 0;
function decodePart(bytes, off) {
  const shape = u16(bytes, off);
  const scale = {
    x: s32(bytes, off + 24) / 65536,
    y: s32(bytes, off + 28) / 65536,
    z: s32(bytes, off + 32) / 65536
  };
  return {
    shape,
    shapeFamily: shape >> 12 & 15,
    // Kept for compatibility: the low 12 bits as one number. The two
    // fields below are its decoded halves, masked the way the engine
    // masks them.
    shapeVariant: shape & 4095,
    colorSet: shape >> 8 & 15,
    meshIndex: shape & 255,
    position: {
      x: s32(bytes, off + 4) / 65536,
      y: s32(bytes, off + 8) / 65536,
      z: s32(bytes, off + 12) / 65536
    },
    // degrees, engine-stored as a u16 circle (65536 = 360). The editor
    // steps rotations by 18 degrees (65536/20) and stores them with a
    // rounding drift of one or two raw units — round, never compare.
    rotation: {
      x: u16(bytes, off + 16) * 360 / 65536,
      y: u16(bytes, off + 18) * 360 / 65536,
      z: u16(bytes, off + 20) * 360 / 65536
    },
    // x1.0 = 1; a negative scale mirrors its axis (the editor almost
    // always mirrors Y)
    scale,
    mirrored: scale.x * scale.y * scale.z < 0
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
      // RGB555 like the palette bank (R bits 0-4, G 5-9, B 10-14):
      // the whole-model tint the renderer folds into every polygon
      // colour (see the header); 0x7fff is neutral
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
              result.titleLayout = titleArt.layout;
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

// packages/shmup-engine/src/model/mesh-library.js
var LIBRARY_MESH_COUNT = 224;
var COLOR_SETS = 3;
var MESHES_PER_FILE = 4;
var MODEL_UNIT_RADIUS = 35;
var FAMILY_OFFSETS = (() => {
  const offsets = [];
  let at = 0;
  for (const count of FAMILY_MESH_COUNTS) {
    offsets.push(at);
    at += count;
  }
  return offsets;
})();
function libraryIndex(family, meshIndex) {
  if (family < 0 || family >= SHAPE_FAMILIES) return -1;
  if (meshIndex < 0 || meshIndex >= FAMILY_MESH_COUNTS[family]) return -1;
  return FAMILY_OFFSETS[family] + meshIndex;
}
function familyOfLibraryIndex(index) {
  for (let family = SHAPE_FAMILIES - 1; family >= 0; family--) {
    if (index >= FAMILY_OFFSETS[family]) {
      return { family, meshIndex: index - FAMILY_OFFSETS[family] };
    }
  }
  return null;
}
function mdldtFileFor(family, meshIndex) {
  if (libraryIndex(family, meshIndex) < 0) return null;
  return {
    file: FAMILY_FILE_RANGES[family][0] + (meshIndex >> 2),
    meshInFile: meshIndex & 3
  };
}
function familyForFile(file) {
  for (let family = 0; family < SHAPE_FAMILIES; family++) {
    const [first, last] = FAMILY_FILE_RANGES[family];
    if (file >= first && file <= last) {
      return { family, firstMeshIndex: (file - first) * MESHES_PER_FILE };
    }
  }
  return null;
}
function mdldtFileName(file) {
  return `MDLDT_${String(file).padStart(2, "0")}.CMP`;
}
function polygonCount(mesh) {
  return mesh.polygons.length >> 2;
}
function polygonNormals(vertices, polygons) {
  const count = polygons.length >> 2;
  const normals = new Float32Array(count * 3);
  for (let q = 0; q < count; q++) {
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < 4; k++) {
      const a = polygons[q * 4 + k] * 3;
      const b = polygons[q * 4 + (k + 1 & 3)] * 3;
      const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
      const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[q * 3] = -nx / len;
    normals[q * 3 + 1] = -ny / len;
    normals[q * 3 + 2] = -nz / len;
  }
  return normals;
}
function makeMesh({
  vertices,
  polygons,
  colorSets,
  normals,
  source = "placeholder",
  family = -1,
  meshIndex = -1
}) {
  const v = vertices instanceof Float32Array ? vertices : Float32Array.from(vertices);
  const p = polygons instanceof Uint16Array ? polygons : Uint16Array.from(polygons);
  const count = p.length >> 2;
  const sets = [];
  for (let s = 0; s < COLOR_SETS; s++) {
    const src = colorSets && colorSets[s];
    const set = new Uint16Array(count);
    if (src) {
      for (let q = 0; q < count; q++) set[q] = src[q % src.length] & 32767;
    }
    sets.push(set);
  }
  return {
    vertices: v,
    polygons: p,
    normals: normals ? Float32Array.from(normals) : polygonNormals(v, p),
    colorSets: sets,
    source,
    family,
    meshIndex
  };
}
function meshBounds(mesh) {
  const v = mesh.vertices;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let radius = 0;
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (v[i + k] < min[k]) min[k] = v[i + k];
      if (v[i + k] > max[k]) max[k] = v[i + k];
    }
    radius = Math.max(radius, Math.hypot(v[i], v[i + 1], v[i + 2]));
  }
  if (!v.length) return { min: [0, 0, 0], max: [0, 0, 0], radius: 0 };
  return { min, max, radius };
}
var PLACEHOLDER_COLOR_SETS = [
  [15],
  [992, 31, 31744, 1023],
  [21140]
];
function orientOutward(vertices, polygons) {
  const normals = polygonNormals(vertices, polygons);
  for (let q = 0; q < polygons.length >> 2; q++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 4; k++) {
      const a = polygons[q * 4 + k] * 3;
      cx += vertices[a];
      cy += vertices[a + 1];
      cz += vertices[a + 2];
    }
    const dot = normals[q * 3] * cx + normals[q * 3 + 1] * cy + normals[q * 3 + 2] * cz;
    if (dot < 0) {
      const a = polygons[q * 4], b = polygons[q * 4 + 1];
      const c = polygons[q * 4 + 2], d = polygons[q * 4 + 3];
      if (c === d) {
        polygons[q * 4] = a;
        polygons[q * 4 + 1] = c;
        polygons[q * 4 + 2] = b;
        polygons[q * 4 + 3] = b;
      } else {
        polygons[q * 4] = d;
        polygons[q * 4 + 1] = c;
        polygons[q * 4 + 2] = b;
        polygons[q * 4 + 3] = a;
      }
    }
  }
}
function primitive(vertices, polygons, meta) {
  const v = Float32Array.from(vertices);
  const p = Uint16Array.from(polygons);
  orientOutward(v, p);
  return makeMesh({
    vertices: v,
    polygons: p,
    colorSets: PLACEHOLDER_COLOR_SETS,
    source: "placeholder",
    ...meta
  });
}
function prismMesh(ring, hy, meta) {
  const n = ring.length;
  const vertices = [];
  for (const [x, z] of ring) vertices.push(x, hy, z);
  for (const [x, z] of ring) vertices.push(x, -hy, z);
  const polygons = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    polygons.push(i, j, n + j, n + i);
  }
  for (const base of [0, n]) {
    for (let i = 1; i + 1 < n; i += 2) {
      const c = base + i + 1;
      const d = i + 2 < n ? base + i + 2 : c;
      polygons.push(base, base + i, c, d);
    }
  }
  return primitive(vertices, polygons, meta);
}
function pyramidMesh(ring, hy, meta) {
  const n = ring.length;
  const vertices = [];
  for (const [x, z] of ring) vertices.push(x, hy, z);
  vertices.push(0, -hy, 0);
  const apex = n;
  const polygons = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    polygons.push(i, j, apex, apex);
  }
  for (let i = 1; i + 1 < n; i += 2) {
    const c = i + 1;
    const d = i + 2 < n ? i + 2 : c;
    polygons.push(0, i, c, d);
  }
  return primitive(vertices, polygons, meta);
}
function frustumMesh(ringTop, ringBottom, hy, meta) {
  const n = ringTop.length;
  const vertices = [];
  for (const [x, z] of ringTop) vertices.push(x, hy, z);
  for (const [x, z] of ringBottom) vertices.push(x, -hy, z);
  const polygons = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    polygons.push(i, j, n + j, n + i);
  }
  for (const base of [0, n]) {
    for (let i = 1; i + 1 < n; i += 2) {
      const c = base + i + 1;
      const d = i + 2 < n ? base + i + 2 : c;
      polygons.push(base, base + i, c, d);
    }
  }
  return primitive(vertices, polygons, meta);
}
function squareRing(r) {
  return [[r, r], [-r, r], [-r, -r], [r, -r]];
}
function polygonRing(r, segments) {
  const ring = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2 * Math.PI / segments;
    ring.push([r * Math.sin(a), r * Math.cos(a)]);
  }
  return ring;
}
function boxMesh(hx, hy, hz, meta) {
  return prismMesh([[hx, hz], [-hx, hz], [-hx, -hz], [hx, -hz]], hy, meta);
}
function wedgeMesh(hx, hy, zMin, zMax, meta) {
  return prismMesh([[-hx, zMin], [hx, zMin], [0, zMax]], hy, meta);
}
function hexPrismMesh(r, hy, meta) {
  const ring = [];
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    ring.push([r * Math.sin(a), r * Math.cos(a)]);
  }
  return prismMesh(ring, hy, meta);
}
function cylinderMesh(r, hy, segments = 16, meta) {
  const ring = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2 * Math.PI / segments;
    ring.push([r * Math.sin(a), r * Math.cos(a)]);
  }
  return prismMesh(ring, hy, meta);
}
function sphereMesh(r, rings = 9, segments = 10, meta) {
  const vertices = [0, r, 0];
  for (let i = 1; i <= rings; i++) {
    const lat = Math.PI * i / (rings + 1);
    const y = r * Math.cos(lat);
    const rr = r * Math.sin(lat);
    for (let j = 0; j < segments; j++) {
      const a = 2 * Math.PI * j / segments;
      vertices.push(rr * Math.sin(a), y, rr * Math.cos(a));
    }
  }
  vertices.push(0, -r, 0);
  const top = 0;
  const bottom = 1 + rings * segments;
  const ringAt = (i, j) => 1 + i * segments + j % segments;
  const polygons = [];
  for (let j = 0; j < segments; j++) {
    polygons.push(top, ringAt(0, j), ringAt(0, j + 1), ringAt(0, j + 1));
  }
  for (let i = 0; i + 1 < rings; i++) {
    for (let j = 0; j < segments; j++) {
      polygons.push(
        ringAt(i, j),
        ringAt(i, j + 1),
        ringAt(i + 1, j + 1),
        ringAt(i + 1, j)
      );
    }
  }
  for (let j = 0; j < segments; j++) {
    const a = ringAt(rings - 1, j);
    const b = ringAt(rings - 1, j + 1);
    polygons.push(bottom, b, a, a);
  }
  return primitive(vertices, polygons, meta);
}
var TRI_RING = [[-27.5, 15.58], [27.5, 15.58], [0, -31.76]];
var FAMILY5_TABLE = [
  (m) => boxMesh(20.5, 20.5, 20.5, m),
  //                  0  cube
  (m) => sphereMesh(27.5, 9, 10, m),
  //                     1  sphere
  (m) => wedgeMesh(27.5, 27.5, -15.88, 31.76, m),
  //        2  triangular prism
  (m) => hexPrismMesh(27.5, 27.5, m),
  //                    3  hexagonal prism
  (m) => cylinderMesh(27.5, 27.5, 16, m),
  //                4  16-gon cylinder
  (m) => pyramidMesh(TRI_RING, 20, m),
  //                   5  triangular pyramid
  (m) => pyramidMesh(squareRing(27.5), 20, m),
  //           6  square pyramid
  (m) => frustumMesh(squareRing(27.5), squareRing(15), 15, m),
  // 7  square frustum
  (m) => hexPrismMesh(27.5, 15, m),
  //                      8  flatter hex prism
  (m) => pyramidMesh(polygonRing(27.5, 16), 20, m),
  //      9  16-gon cone
  (m) => cylinderMesh(27.5, 15, 16, m),
  //                 10  flatter cylinder
  (m) => (
    //                                                11  triangular frustum
    frustumMesh(
      [[-27.5, -15.88], [27.5, -15.88], [0, 31.76]],
      [[-17.1875, -9.925], [17.1875, -9.925], [0, 19.85]],
      15,
      m
    )
  )
];
function placeholderMesh(family, meshIndex) {
  const meta = { family, meshIndex };
  if (family === 5 && meshIndex >= 0 && meshIndex < FAMILY5_TABLE.length) {
    return FAMILY5_TABLE[meshIndex](meta);
  }
  if (family === 4) return boxMesh(21.34, 35, 5, meta);
  if (family === 0) return boxMesh(35, 30, 12, meta);
  if (family >= 1 && family <= 3) return boxMesh(10, 35, 12, meta);
  return boxMesh(20, 20, 20, meta);
}
var placeholderCache = null;
function placeholderLibrary() {
  if (placeholderCache) return placeholderCache;
  const meshes = [];
  for (let i = 0; i < LIBRARY_MESH_COUNT; i++) {
    const { family, meshIndex } = familyOfLibraryIndex(i);
    meshes.push(placeholderMesh(family, meshIndex));
  }
  placeholderCache = { meshes, familyOffsets: FAMILY_OFFSETS, source: "placeholder" };
  return placeholderCache;
}
function meshFor(library, part) {
  const index = libraryIndex(part.shapeFamily, part.meshIndex);
  const mesh = index >= 0 && library ? library.meshes[index] : null;
  return mesh || placeholderMesh(part.shapeFamily, part.meshIndex);
}
var JSON_UNIT = 256;
function serializeMeshLibrary(library) {
  return {
    v: 1,
    source: library.source,
    unit: JSON_UNIT,
    meshes: library.meshes.map((mesh) => ({
      f: mesh.family,
      i: mesh.meshIndex,
      s: mesh.source,
      v: Array.from(mesh.vertices, (x) => Math.round(x * JSON_UNIT)),
      p: Array.from(mesh.polygons),
      c: mesh.colorSets.map((set) => Array.from(set))
    }))
  };
}
function meshLibraryFromJson(obj) {
  if (!obj || obj.v !== 1 || !Array.isArray(obj.meshes)) {
    throw new Error("mesh library: not a v1 library");
  }
  const unit = obj.unit || JSON_UNIT;
  const meshes = obj.meshes.map(
    (m) => makeMesh({
      vertices: Float32Array.from(m.v, (x) => x / unit),
      polygons: m.p,
      colorSets: m.c,
      source: m.s || obj.source || "mdldt",
      family: m.f,
      meshIndex: m.i
    })
  );
  return { meshes, familyOffsets: FAMILY_OFFSETS, source: obj.source || "mdldt" };
}

// packages/shmup-engine/src/model/decode-mdldt.js
var MDLDT_BASE = 3080192;
var MDLDT_FILE_COUNT = 56;
var PDATA_PER_FILE = 12;
var PDATA_SIZE = 24;
var POINT_SIZE = 12;
var POLYGON_SIZE = 20;
var ATTR_SIZE = 12;
var COLOR_SETS2 = 3;
function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function readPdata(dv, at) {
  return {
    pntbl: dv.getUint32(at) - MDLDT_BASE,
    nbPoint: dv.getUint32(at + 4),
    pltbl: dv.getUint32(at + 8) - MDLDT_BASE,
    nbPolygon: dv.getUint32(at + 12),
    attbl: dv.getUint32(at + 16) - MDLDT_BASE
  };
}
function decodeMdldt(bytes, { file = 0 } = {}) {
  if (!bytes || bytes.length < PDATA_PER_FILE * 4) {
    throw new Error("MDLDT: too short for a pointer table");
  }
  const dv = view(bytes);
  const slice = file ? familyForFile(file) : null;
  const meshes = [];
  for (let m = 0; m < MESHES_PER_FILE; m++) {
    const sets = [];
    for (let s = 0; s < COLOR_SETS2; s++) {
      const ptr = dv.getUint32((m * COLOR_SETS2 + s) * 4) - MDLDT_BASE;
      if (ptr < 0 || ptr + PDATA_SIZE > bytes.length) {
        throw new Error(`MDLDT: PDATA ${m * COLOR_SETS2 + s} out of range`);
      }
      sets.push(readPdata(dv, ptr));
    }
    const base = sets[0];
    for (const other of sets) {
      if (other.pntbl !== base.pntbl || other.pltbl !== base.pltbl || other.nbPoint !== base.nbPoint || other.nbPolygon !== base.nbPolygon) {
        throw new Error(`MDLDT: mesh ${m}'s colour sets disagree on geometry`);
      }
    }
    const end = Math.max(
      base.pntbl + base.nbPoint * POINT_SIZE,
      base.pltbl + base.nbPolygon * POLYGON_SIZE,
      ...sets.map((s) => s.attbl + base.nbPolygon * ATTR_SIZE)
    );
    if (end > bytes.length) throw new Error(`MDLDT: mesh ${m} runs past the file`);
    const vertices = new Float32Array(base.nbPoint * 3);
    for (let i = 0; i < base.nbPoint * 3; i++) {
      vertices[i] = dv.getInt32(base.pntbl + i * 4) / 65536;
    }
    const polygons = new Uint16Array(base.nbPolygon * 4);
    const normals = new Float32Array(base.nbPolygon * 3);
    for (let q = 0; q < base.nbPolygon; q++) {
      const at = base.pltbl + q * POLYGON_SIZE;
      normals[q * 3] = dv.getInt32(at) / 65536;
      normals[q * 3 + 1] = dv.getInt32(at + 4) / 65536;
      normals[q * 3 + 2] = dv.getInt32(at + 8) / 65536;
      for (let k = 0; k < 4; k++) {
        const index = dv.getUint16(at + 12 + k * 2);
        if (index >= base.nbPoint) {
          throw new Error(`MDLDT: mesh ${m} polygon ${q} indexes vertex ${index}`);
        }
        polygons[q * 4 + k] = index;
      }
    }
    const colorSets = sets.map((s) => {
      const colors = new Uint16Array(base.nbPolygon);
      for (let q = 0; q < base.nbPolygon; q++) {
        colors[q] = dv.getUint16(s.attbl + q * ATTR_SIZE + 6) & 32767;
      }
      return colors;
    });
    meshes.push(makeMesh({
      vertices,
      polygons,
      normals,
      colorSets,
      source: "mdldt",
      family: slice ? slice.family : -1,
      meshIndex: slice ? slice.firstMeshIndex + m : -1
    }));
  }
  return meshes;
}
function buildMeshLibrary(files) {
  const meshes = new Array(LIBRARY_MESH_COUNT).fill(null);
  let real = 0;
  for (let file = 1; file <= MDLDT_FILE_COUNT; file++) {
    const bytes = files[file - 1];
    if (!bytes) continue;
    const slice = familyForFile(file);
    const decoded = decodeMdldt(bytes, { file });
    for (let m = 0; m < decoded.length; m++) {
      const index = FAMILY_OFFSETS[slice.family] + slice.firstMeshIndex + m;
      meshes[index] = decoded[m];
      real++;
    }
  }
  for (let i = 0; i < LIBRARY_MESH_COUNT; i++) {
    if (meshes[i]) continue;
    const { family, meshIndex } = familyOfLibraryIndex(i);
    meshes[i] = placeholderMesh(family, meshIndex);
  }
  return {
    meshes,
    familyOffsets: FAMILY_OFFSETS,
    source: real === LIBRARY_MESH_COUNT ? "mdldt" : real ? "partial" : "placeholder",
    realMeshes: real
  };
}

// packages/shmup-engine/src/model/model-mesh.js
var ROT_ORDERS = ["xyz", "xzy", "yxz", "yzx", "zxy", "zyx"];
var ROTATION_ORDER = "zyx";
var ROTATION_QUANTUM = 18;
var SHADE_LEVELS = 32;
var SHADE_ZERO = 16;
var SHADE_FLOOR = 0;
var LIGHT_AZIMUTH = 45;
var LIGHT_TILT = -50;
var NEAR = 4;
function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
var DEG = Math.PI / 180;
function saturnLightView(azimuthDeg = LIGHT_AZIMUTH, tiltDeg = LIGHT_TILT) {
  const ca = Math.cos(azimuthDeg * DEG), sa = Math.sin(azimuthDeg * DEG);
  const ct = Math.cos(tiltDeg * DEG), st = Math.sin(tiltDeg * DEG);
  const x = -sa * -st, y = ca * -st, z = ct;
  return normalize3([-x, y, z]);
}
var LIGHT_VIEW = saturnLightView();
function tintRgb555(color, tint) {
  return shadeRgb555(color, SHADE_ZERO, tint, 0);
}
function shadeRgb555(color, row, tint = 32767, floor = SHADE_FLOOR) {
  const light = row - SHADE_ZERO;
  let out = 0;
  for (let shift = 0; shift <= 10; shift += 5) {
    const c = color >> shift & 31;
    const t = tint >> shift & 31;
    const v = Math.min(31, Math.max(floor, c + t - 31 + light));
    out |= v << shift;
  }
  return out;
}
function shadeRow(ndotl) {
  const row = Math.floor(16 * ndotl) + SHADE_ZERO;
  return row < 0 ? 0 : row > SHADE_LEVELS - 1 ? SHADE_LEVELS - 1 : row;
}
function quantizeRotation(deg, step = ROTATION_QUANTUM) {
  const q = Math.round(deg / step) * step;
  return (q % 360 + 360) % 360;
}
function rotationMatrix(axis, deg) {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  switch (axis) {
    case "x":
      return [1, 0, 0, 0, c, -s, 0, s, c];
    case "y":
      return [c, 0, s, 0, 1, 0, -s, 0, c];
    default:
      return [c, -s, 0, s, c, 0, 0, 0, 1];
  }
}
function mul3(a, b) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}
function composeTransform(part, { rotOrder = ROTATION_ORDER, quantize = true } = {}) {
  if (!ROT_ORDERS.includes(rotOrder)) {
    throw new Error(`unknown rotation order ${rotOrder}`);
  }
  const rot = part.rotation || { x: 0, y: 0, z: 0 };
  const angle = (axis) => quantize ? quantizeRotation(rot[axis] || 0) : rot[axis] || 0;
  let r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const axis of rotOrder) {
    r = mul3(rotationMatrix(axis, angle(axis)), r);
  }
  const s = part.scale || { x: 1, y: 1, z: 1 };
  const p = part.position || { x: 0, y: 0, z: 0 };
  const m = new Float64Array(12);
  for (let row = 0; row < 3; row++) {
    m[row * 4] = r[row * 3] * s.x;
    m[row * 4 + 1] = r[row * 3 + 1] * s.y;
    m[row * 4 + 2] = r[row * 3 + 2] * s.z;
  }
  m[3] = p.x;
  m[7] = p.y;
  m[11] = p.z;
  return m;
}
function transformPoint(m, x, y, z, out, o = 0) {
  out[o] = m[0] * x + m[1] * y + m[2] * z + m[3];
  out[o + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
  out[o + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  return out;
}
function normalMatrix(m) {
  const a = m[0], b = m[1], c = m[2];
  const d = m[4], e = m[5], f = m[6];
  const g = m[8], h = m[9], i = m[10];
  const co = [
    e * i - f * h,
    -(d * i - f * g),
    d * h - e * g,
    -(b * i - c * h),
    a * i - c * g,
    -(a * h - b * g),
    b * f - c * e,
    -(a * f - c * d),
    a * e - b * d
  ];
  const det = a * co[0] + b * co[1] + c * co[2];
  const inv = det === 0 ? 1 : 1 / det;
  return Float64Array.from(co, (v) => v * inv);
}
function buildModelMesh(model, {
  library = placeholderLibrary(),
  yDown = false,
  rotOrder = ROTATION_ORDER,
  quantize = true,
  tint = true,
  floor = SHADE_FLOOR
} = {}) {
  const partList = model && model.parts || [];
  const tintWord = tint && model && Number.isInteger(model.color) ? model.color & 32767 : 32767;
  const resolved = partList.map((part) => ({ part, mesh: meshFor(library, part) }));
  let triCount = 0;
  for (const { mesh } of resolved) {
    const polys = polygonCount(mesh);
    for (let q = 0; q < polys; q++) {
      triCount += mesh.polygons[q * 4 + 2] === mesh.polygons[q * 4 + 3] ? 1 : 2;
    }
  }
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 3);
  const colors = new Uint32Array(triCount);
  const colors555 = new Uint16Array(triCount);
  const partOf = new Uint8Array(triCount);
  const parts = [];
  const tmp = new Float64Array(3);
  const ySign = yDown ? -1 : 1;
  let t = 0;
  let placeholder = false;
  resolved.forEach(({ part, mesh }, index) => {
    const m = composeTransform(part, { rotOrder, quantize });
    const nm = normalMatrix(m);
    const setIndex = Math.min(Math.max(part.colorSet | 0, 0), mesh.colorSets.length - 1);
    const colorSet = mesh.colorSets[setIndex];
    const triStart = t;
    if (mesh.source !== "mdldt") placeholder = true;
    const polys = polygonCount(mesh);
    const emit = (q, a, b, c) => {
      const corners = [a, b, c];
      for (let k = 0; k < 3; k++) {
        const vi = corners[k] * 3;
        transformPoint(m, mesh.vertices[vi], mesh.vertices[vi + 1], mesh.vertices[vi + 2], tmp, 0);
        positions[t * 9 + k * 3] = tmp[0];
        positions[t * 9 + k * 3 + 1] = tmp[1] * ySign;
        positions[t * 9 + k * 3 + 2] = tmp[2];
      }
      const nx0 = mesh.normals[q * 3], ny0 = mesh.normals[q * 3 + 1], nz0 = mesh.normals[q * 3 + 2];
      let nx = nm[0] * nx0 + nm[1] * ny0 + nm[2] * nz0;
      let ny = nm[3] * nx0 + nm[4] * ny0 + nm[5] * nz0;
      let nz = nm[6] * nx0 + nm[7] * ny0 + nm[8] * nz0;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      normals[t * 3] = nx;
      normals[t * 3 + 1] = ny * ySign;
      normals[t * 3 + 2] = nz;
      colors555[t] = colorSet[q] & 32767;
      colors[t] = rgb555ToHex(shadeRgb555(colors555[t], SHADE_ZERO, tintWord, floor));
      partOf[t] = index;
      t++;
    };
    for (let q = 0; q < polys; q++) {
      const a = mesh.polygons[q * 4], b = mesh.polygons[q * 4 + 1];
      const c = mesh.polygons[q * 4 + 2], d = mesh.polygons[q * 4 + 3];
      emit(q, a, b, c);
      if (c !== d) emit(q, a, c, d);
    }
    parts.push({
      index,
      part,
      family: part.shapeFamily,
      meshIndex: part.meshIndex,
      colorSet: setIndex,
      source: mesh.source,
      triStart,
      triCount: t - triStart
    });
  });
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (positions[i + k] < min[k]) min[k] = positions[i + k];
      if (positions[i + k] > max[k]) max[k] = positions[i + k];
    }
  }
  if (!triCount) {
    min.fill(0);
    max.fill(0);
  }
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let radius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    radius = Math.max(
      radius,
      Math.hypot(positions[i] - center[0], positions[i + 1] - center[1], positions[i + 2] - center[2])
    );
  }
  return {
    positions,
    normals,
    colors,
    partOf,
    parts,
    triCount,
    bounds: { min, max, center, radius },
    placeholder,
    yDown,
    rotOrder,
    tint: tintWord,
    floor,
    colors555
  };
}
function allocFrame(mesh) {
  const n = mesh.triCount;
  return {
    triCount: n,
    xy: new Float32Array(n * 6),
    depth: new Float32Array(n),
    shade: new Uint8Array(n),
    visible: new Uint8Array(n),
    order: new Uint32Array(n),
    visibleCount: 0
  };
}
function orbitCamera({
  yaw = 35,
  pitch = 25,
  distance = 200,
  focal = 360,
  width = 640,
  height = 400,
  target = [0, 0, 0],
  near = NEAR
} = {}) {
  const t = yaw * DEG, p = pitch * DEG;
  const sinT = Math.sin(t), cosT = Math.cos(t);
  const sinP = Math.sin(p), cosP = Math.cos(p);
  const cam = [sinT * cosP, sinP, cosT * cosP];
  const right = [cosT, 0, -sinT];
  const up = [-sinT * sinP, cosP, -cosT * sinP];
  return {
    eye: [target[0] + cam[0] * distance, target[1] + cam[1] * distance, target[2] + cam[2] * distance],
    cam,
    right,
    up,
    focal,
    width,
    height,
    near,
    yaw,
    pitch,
    distance
  };
}
function projectModel(mesh, cam, frame, lightView = LIGHT_VIEW) {
  const { positions, normals, triCount } = mesh;
  const { eye, cam: dir, right, up, focal, width, height, near } = cam;
  const cx = width / 2, cy = height / 2;
  const { xy, depth, shade, visible, order } = frame;
  const lx = lightView[0] * right[0] + lightView[1] * up[0] + lightView[2] * dir[0];
  const ly = lightView[0] * right[1] + lightView[1] * up[1] + lightView[2] * dir[1];
  const lz = lightView[0] * right[2] + lightView[1] * up[2] + lightView[2] * dir[2];
  let n = 0;
  for (let t = 0; t < triCount; t++) {
    const p = t * 9;
    let far = -Infinity;
    let ok = true;
    let mx = 0, my = 0, mz = 0;
    for (let k = 0; k < 3 && ok; k++) {
      const px = positions[p + k * 3], py = positions[p + k * 3 + 1], pz = positions[p + k * 3 + 2];
      const dx = px - eye[0], dy = py - eye[1], dz = pz - eye[2];
      const vz = -(dx * dir[0] + dy * dir[1] + dz * dir[2]);
      if (vz < near) {
        ok = false;
        break;
      }
      const vx = dx * right[0] + dy * right[1] + dz * right[2];
      const vy = dx * up[0] + dy * up[1] + dz * up[2];
      xy[t * 6 + k * 2] = cx + focal * vx / vz;
      xy[t * 6 + k * 2 + 1] = cy - focal * vy / vz;
      if (vz > far) far = vz;
      mx += px;
      my += py;
      mz += pz;
    }
    if (!ok) {
      visible[t] = 0;
      continue;
    }
    const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
    const facing = nx * (eye[0] - mx / 3) + ny * (eye[1] - my / 3) + nz * (eye[2] - mz / 3);
    if (facing <= 0) {
      visible[t] = 0;
      continue;
    }
    visible[t] = 1;
    depth[t] = far;
    shade[t] = shadeRow(nx * lx + ny * ly + nz * lz);
    order[n++] = t;
  }
  const slice = order.subarray(0, n);
  slice.sort((a, b) => depth[b] - depth[a]);
  frame.visibleCount = n;
  return n;
}
var MAX_SWATCH_COLORS = 128;
var SWATCH_LAYOUT = { cellPx: 4, cols: 64, rows: 64, texPx: 256 };
function buildSwatchTable(mesh, maxColors = MAX_SWATCH_COLORS) {
  const index = /* @__PURE__ */ new Map();
  const colors = [];
  const triColor = new Uint16Array(mesh.triCount);
  for (let t = 0; t < mesh.triCount; t++) {
    const c = mesh.colors555[t];
    let i = index.get(c);
    if (i === void 0) {
      if (colors.length < maxColors) {
        i = colors.length;
        colors.push(c);
      } else {
        i = 0;
      }
      index.set(c, i);
    }
    triColor[t] = i;
  }
  return { colors: Uint16Array.from(colors), triColor };
}
function swatchCell(colorIndex, level) {
  return colorIndex * SHADE_LEVELS + level;
}
function swatchCellRect(cell, layout = SWATCH_LAYOUT) {
  const col = cell % layout.cols;
  const row = cell / layout.cols | 0;
  return { x: col * layout.cellPx, y: row * layout.cellPx, w: layout.cellPx, h: layout.cellPx };
}
function swatchUV(cell, layout = SWATCH_LAYOUT) {
  const r = swatchCellRect(cell, layout);
  return [(r.x + r.w / 2) / layout.texPx, (r.y + r.h / 2) / layout.texPx];
}
function swatchRgb(color555, row, tint = 32767, floor = SHADE_FLOOR) {
  return rgb555ToHex(shadeRgb555(color555, row, tint, floor));
}
function packMesh2D(mesh, frame, table, layout = SWATCH_LAYOUT, out = {}) {
  const n = frame.visibleCount;
  const vertices = out.vertices || (out.vertices = []);
  const indices = out.indices || (out.indices = []);
  vertices.length = n * 12;
  indices.length = n * 4;
  const { xy, shade, order } = frame;
  for (let r = 0; r < n; r++) {
    const t = order[r];
    const [u, v] = swatchUV(swatchCell(table.triColor[t], shade[t]), layout);
    for (let k = 0; k < 3; k++) {
      const o = r * 12 + k * 4;
      vertices[o] = xy[t * 6 + k * 2];
      vertices[o + 1] = xy[t * 6 + k * 2 + 1];
      vertices[o + 2] = u;
      vertices[o + 3] = v;
    }
    indices[r * 4] = r * 3;
    indices[r * 4 + 1] = r * 3 + 1;
    indices[r * 4 + 2] = r * 3 + 2;
    indices[r * 4 + 3] = 0;
  }
  out.count = n;
  return out;
}
function wireframeSegments(mesh, frame, out = []) {
  const n = frame.visibleCount;
  out.length = n * 12;
  const { xy, order } = frame;
  for (let r = 0; r < n; r++) {
    const t = order[r];
    for (let k = 0; k < 3; k++) {
      const a = t * 6 + k * 2, b = t * 6 + (k + 1) % 3 * 2;
      const o = r * 12 + k * 4;
      out[o] = xy[a];
      out[o + 1] = xy[a + 1];
      out[o + 2] = xy[b];
      out[o + 3] = xy[b + 1];
    }
  }
  return out;
}
function modelStats(models) {
  const list = models || [];
  let parts = 0;
  for (const m of list) parts += (m.parts || []).length;
  return { slots: list.length, parts };
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
  if (g.playerData2 !== void 0) {
    if (!isObj(g.playerData2)) {
      err("playerData2 must be an object when present");
    } else if (!isTextureArray(g.playerData2.texture)) {
      err("playerData2.texture must be a non-empty string array");
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

// packages/shmup-engine/src/audio/tone-bank-table.js
var LAYER_FIELDS = 20;
var LAYER = {
  NOTE_LO: 0,
  NOTE_HI: 1,
  OFFSET: 2,
  //         byte offset into SNDPAC.BIN
  FORMAT: 3,
  //         8 = signed 8-bit PCM, 16 = signed 16-bit BIG-endian
  LENGTH_SAMPLES: 4,
  LOOP_MODE: 5,
  //      SCSP LPCTL: 0 off, 1 forward, 2 reverse, 3 alternating
  LOOP_START: 6,
  //     in samples; the loop always runs to the last sample
  ROOT_PITCH: 7,
  FINE_TUNE: 8,
  //      1/256 semitone
  LEVEL: 9,
  //          attenuation, ~0.375 dB per step
  PAN: 10,
  //           SCSP pan byte
  VEL_CURVE: 11,
  EG_AR: 12,
  EG_D1R: 13,
  EG_D2R: 14,
  EG_RR: 15,
  EG_DL: 16,
  EG_KRS: 17,
  EG_EGHOLD: 18,
  EG_LPSLNK: 19
};
var INSTRUMENT_FIELDS = 4;
var INSTRUMENT = {
  FLAGS: 0,
  VOL_ADJ: 1,
  FIRST_LAYER: 2,
  LAYER_COUNT: 3
};
var TONE_INSTRUMENTS = [13, -58, 0, 4, 13, -77, 4, 2, 13, -62, 6, 6, 13, -71, 12, 6, 13, -68, 18, 8, 13, -64, 26, 1, 13, -52, 27, 3, 13, -53, 30, 2, 13, -53, 32, 2, 13, -44, 34, 4, 13, -56, 38, 1, 13, -60, 39, 4, 13, -77, 43, 4, 13, -53, 47, 8, 13, -44, 55, 5, 13, -51, 60, 3, 13, -8, 63, 7, 13, -40, 70, 6, 13, -35, 76, 2, 13, -48, 78, 4, 13, -53, 82, 4, 13, 0, 86, 6, 13, -47, 92, 2, 13, -58, 94, 2, 13, -51, 96, 2, 13, -62, 98, 4, 13, -61, 102, 3, 13, -73, 105, 1, 13, -55, 106, 3, 13, -51, 109, 6, 13, -45, 115, 10, 13, -47, 125, 7, 13, -79, 132, 4, 13, -68, 136, 2, 13, -52, 138, 8, 13, -52, 146, 7, 13, -50, 153, 2, 13, -55, 155, 2, 13, -49, 157, 5, 13, -56, 162, 6, 13, -53, 168, 3, 13, -51, 171, 6, 13, -54, 177, 1, 13, -49, 178, 3, 13, -37, 181, 7, 13, -30, 188, 6, 13, -59, 194, 6, 13, -45, 200, 7, 13, -69, 207, 1, 13, -72, 208, 6, 13, -44, 214, 7, 13, -56, 221, 1, 13, -50, 222, 6, 13, -63, 228, 6, 13, -58, 234, 6, 13, -46, 240, 8, 13, -58, 248, 7, 13, -68, 255, 2, 13, -40, 257, 2, 13, -44, 259, 5, 2, -8, 264, 4, 2, -8, 268, 15, 2, -8, 283, 16, 2, -8, 299, 15, 2, -8, 314, 15, 2, -8, 329, 18, 2, -8, 347, 17, 2, -8, 364, 24, 2, -8, 388, 18, 2, 0, 406, 9, 2, 0, 415, 6, 12, -12, 421, 3, 12, -42, 424, 6, 2, -37, 430, 3, 2, -16, 433, 3, 2, -18, 436, 3, 2, -3, 439, 3, 12, -39, 442, 4, 2, -7, 446, 3, 2, -14, 449, 5, 12, -32, 454, 18, 2, -8, 472, 3, 2, -20, 475, 3, 2, -9, 478, 3, 2, -9, 481, 6, 2, -8, 487, 3, 2, -14, 490, 6, 2, -2, 496, 6, 2, -13, 502, 3, 2, -1, 505, 3, 2, -10, 508, 6, 2, -9, 514, 6, 2, -7, 520, 3, 2, -12, 523, 3, 2, -9, 526, 3, 2, -14, 529, 3, 2, -17, 532, 3, 12, -15, 535, 3, 2, -30, 538, 3, 2, -26, 541, 3, 2, -3, 544, 3, 2, 0, 547, 4, 2, -19, 551, 3, 2, 0, 554, 6, 2, -35, 560, 3, 2, -29, 563, 3, 2, -27, 566, 3, 2, 0, 569, 5, 2, 0, 574, 3, 2, -3, 577, 3, 2, -3, 580, 3, 2, -43, 583, 2, 2, -43, 585, 1, 2, -43, 586, 2, 2, -43, 588, 1, 2, -43, 589, 1];
var TONE_LAYERS = [0, 58, 391550, 16, 3344, 1, 3301, 84, -10, 0, 224, 1, 31, 9, 9, 22, 5, 2, 0, 0, 0, 58, 391550, 16, 3344, 1, 3301, 84, 10, 15, 224, 1, 31, 9, 9, 22, 5, 2, 0, 0, 59, 127, 391550, 16, 3344, 1, 3301, 84, -10, 3, 224, 1, 31, 9, 9, 22, 5, 2, 0, 0, 59, 127, 391550, 16, 3344, 1, 3301, 84, 10, 18, 224, 1, 31, 9, 9, 22, 5, 2, 0, 0, 0, 127, 94822, 16, 674, 1, 631, 84, -8, 0, 241, 1, 31, 7, 7, 22, 5, 2, 0, 0, 0, 127, 94822, 16, 674, 1, 631, 84, 12, 0, 225, 1, 31, 7, 7, 22, 5, 2, 0, 0, 0, 59, 348062, 16, 541, 1, 498, 84, -12, 0, 241, 1, 31, 8, 8, 22, 5, 2, 0, 0, 0, 59, 348062, 16, 541, 1, 498, 84, 8, 10, 225, 1, 31, 8, 8, 22, 5, 2, 0, 0, 60, 82, 348062, 16, 541, 1, 498, 84, -12, 2, 241, 1, 31, 8, 8, 22, 5, 2, 0, 0, 60, 82, 348062, 16, 541, 1, 498, 84, 8, 12, 225, 1, 31, 8, 8, 22, 5, 2, 0, 0, 83, 127, 348062, 16, 541, 1, 498, 84, -12, 4, 241, 1, 31, 8, 8, 22, 5, 2, 0, 0, 83, 127, 348062, 16, 541, 1, 498, 84, 8, 14, 225, 1, 31, 8, 8, 22, 5, 2, 0, 0, 0, 64, 356766, 16, 287, 1, 243, 84, 94, 8, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 0, 64, 356766, 16, 287, 1, 243, 84, 114, 18, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 65, 83, 356766, 16, 287, 1, 243, 84, 94, 5, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 65, 83, 356766, 16, 287, 1, 243, 84, 114, 15, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 84, 127, 356766, 16, 287, 1, 243, 84, 94, 0, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 84, 127, 356766, 16, 287, 1, 243, 84, 114, 10, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 55, 58, 96172, 16, 1404, 1, 1347, 79, -14, 0, 241, 1, 31, 0, 0, 22, 0, 15, 0, 0, 55, 58, 96172, 16, 1404, 1, 1347, 79, 6, 0, 225, 1, 31, 0, 0, 22, 0, 15, 0, 0, 59, 67, 96172, 16, 1404, 1, 1347, 79, -14, 4, 241, 1, 31, 0, 0, 22, 0, 15, 0, 0, 59, 67, 96172, 16, 1404, 1, 1347, 79, 6, 4, 225, 1, 31, 0, 0, 22, 0, 15, 0, 0, 68, 77, 96172, 16, 1404, 1, 1347, 79, -14, 5, 241, 1, 31, 0, 0, 22, 0, 15, 0, 0, 68, 77, 96172, 16, 1404, 1, 1347, 79, 6, 5, 225, 1, 31, 0, 0, 22, 0, 15, 0, 0, 78, 127, 96172, 16, 1404, 1, 1347, 79, -14, 6, 241, 1, 31, 0, 0, 22, 0, 15, 0, 0, 78, 127, 96172, 16, 1404, 1, 1347, 79, 6, 6, 225, 1, 31, 0, 0, 22, 0, 15, 0, 0, 0, 127, 366126, 16, 3960, 1, 587, 84, 8, 0, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 0, 58, 170152, 8, 9449, 1, 377, 84, 12, 0, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 59, 74, 170152, 8, 9449, 1, 377, 84, 12, 3, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 75, 127, 170152, 8, 9449, 1, 377, 84, 12, 6, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 0, 58, 179602, 8, 9645, 1, 4148, 84, 0, 0, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 59, 127, 179602, 8, 9645, 1, 4148, 84, 0, 2, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 0, 58, 98982, 16, 655, 1, 485, 84, 18, 0, 224, 1, 31, 10, 10, 22, 5, 2, 0, 0, 59, 127, 98982, 16, 655, 1, 485, 84, 18, 4, 224, 1, 31, 10, 10, 22, 5, 2, 0, 0, 0, 58, 100294, 16, 1023, 1, 938, 84, -12, 0, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 59, 70, 100294, 16, 1023, 1, 938, 84, -12, 2, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 71, 77, 100294, 16, 1023, 1, 938, 84, -12, 5, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 78, 127, 100294, 16, 1023, 1, 938, 84, -12, 12, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 0, 127, 102342, 16, 828, 1, 785, 84, -10, 0, 224, 1, 31, 13, 13, 22, 5, 2, 0, 0, 0, 58, 277346, 16, 3469, 1, 3014, 91, 36, 0, 224, 1, 31, 7, 7, 20, 5, 2, 0, 0, 0, 58, 277346, 16, 3469, 1, 3014, 91, 56, 10, 224, 1, 31, 7, 7, 20, 5, 2, 0, 0, 59, 127, 277346, 16, 3469, 1, 3014, 91, 36, 2, 224, 1, 31, 7, 7, 20, 5, 2, 0, 0, 59, 127, 277346, 16, 3469, 1, 3014, 91, 56, 12, 224, 1, 31, 7, 7, 20, 5, 2, 0, 0, 0, 58, 387150, 16, 2199, 1, 2156, 84, -12, 0, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 0, 58, 387150, 16, 2199, 1, 2156, 84, 8, 0, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 59, 127, 387150, 16, 2199, 1, 2156, 84, -12, 2, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 59, 127, 387150, 16, 2199, 1, 2156, 84, 8, 2, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 0, 58, 104e3, 16, 2590, 1, 2255, 84, -40, 0, 224, 1, 31, 5, 5, 22, 5, 2, 0, 0, 59, 61, 104e3, 16, 2590, 1, 2255, 84, -40, 2, 224, 1, 31, 5, 5, 22, 5, 2, 0, 0, 62, 68, 104e3, 16, 2590, 1, 2255, 84, -40, 4, 224, 1, 31, 5, 5, 22, 5, 2, 0, 0, 69, 73, 104e3, 16, 2590, 1, 2255, 84, -40, 5, 224, 1, 31, 5, 5, 22, 5, 2, 0, 0, 74, 75, 104e3, 16, 2590, 1, 2255, 84, -40, 6, 224, 1, 31, 5, 5, 22, 5, 2, 0, 0, 76, 77, 104e3, 16, 2590, 1, 2255, 84, -40, 7, 224, 1, 31, 5, 5, 22, 5, 2, 0, 0, 78, 81, 104e3, 16, 2590, 1, 2255, 84, -40, 9, 224, 1, 31, 5, 5, 22, 5, 2, 0, 0, 82, 127, 104e3, 16, 2590, 1, 2255, 84, -40, 10, 224, 1, 31, 5, 5, 22, 5, 2, 0, 0, 0, 58, 109182, 16, 3223, 1, 2885, 84, 0, 0, 224, 1, 31, 0, 14, 22, 0, 15, 0, 0, 59, 68, 109182, 16, 3223, 1, 2885, 84, 0, 2, 224, 1, 31, 0, 14, 22, 0, 15, 0, 0, 69, 71, 109182, 16, 3223, 1, 2885, 84, 0, 4, 224, 1, 31, 0, 14, 22, 0, 15, 0, 0, 72, 83, 109182, 16, 3223, 1, 2885, 84, 0, 7, 224, 1, 31, 0, 14, 22, 0, 15, 0, 0, 84, 127, 109182, 16, 3223, 1, 2885, 84, 0, 10, 224, 1, 31, 0, 14, 22, 0, 15, 0, 0, 0, 58, 115630, 16, 3189, 1, 3104, 84, -10, 0, 224, 1, 31, 9, 9, 22, 5, 2, 0, 0, 59, 70, 115630, 16, 3189, 1, 3104, 84, -10, 3, 224, 1, 31, 9, 9, 22, 5, 2, 0, 0, 71, 127, 115630, 16, 3189, 1, 3104, 84, -10, 5, 224, 1, 31, 9, 9, 22, 5, 2, 0, 0, 0, 65, 381338, 16, 2905, 1, 2586, 85, -2, 0, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 66, 67, 381338, 16, 2905, 1, 2586, 85, -2, 5, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 68, 70, 381338, 16, 2905, 1, 2586, 85, -2, 8, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 71, 74, 381338, 16, 2905, 1, 2586, 85, -2, 16, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 75, 77, 381338, 16, 2905, 1, 2586, 85, -2, 20, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 78, 82, 381338, 16, 2905, 1, 2586, 85, -2, 25, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 83, 127, 381338, 16, 2905, 1, 2586, 85, -2, 30, 224, 1, 31, 8, 8, 22, 5, 2, 0, 0, 0, 68, 345152, 16, 1454, 1, 1115, 84, 18, 0, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 69, 70, 345152, 16, 1454, 1, 1115, 84, 18, 4, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 71, 75, 345152, 16, 1454, 1, 1115, 84, 18, 9, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 76, 80, 345152, 16, 1454, 1, 1115, 84, 18, 14, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 81, 82, 345152, 16, 1454, 1, 1115, 84, 18, 16, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 83, 127, 345152, 16, 1454, 1, 1115, 84, 18, 21, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 0, 71, 122010, 16, 2386, 1, 2048, 84, 0, 0, 224, 1, 31, 7, 7, 22, 5, 2, 0, 0, 72, 127, 122010, 16, 2386, 1, 2048, 84, 0, 3, 224, 1, 31, 7, 7, 22, 5, 2, 0, 0, 0, 69, 364144, 16, 990, 1, 652, 84, 0, 0, 224, 1, 31, 7, 7, 22, 5, 2, 0, 0, 70, 77, 364144, 16, 990, 1, 652, 84, 0, 3, 224, 1, 31, 7, 7, 22, 5, 2, 0, 0, 78, 83, 364144, 16, 990, 1, 652, 84, 0, 5, 224, 1, 31, 7, 7, 22, 5, 2, 0, 0, 84, 127, 364144, 16, 990, 1, 652, 84, 0, 7, 224, 1, 31, 7, 7, 22, 5, 2, 0, 0, 0, 58, 497324, 16, 2705, 1, 2666, 86, 58, 0, 224, 1, 31, 5, 5, 22, 5, 2, 0, 0, 0, 58, 497324, 16, 2705, 1, 2666, 86, 78, 20, 224, 1, 31, 5, 5, 22, 5, 2, 0, 0, 59, 127, 497324, 16, 2705, 1, 2666, 86, 58, 2, 224, 1, 31, 5, 5, 22, 5, 2, 0, 0, 59, 127, 497324, 16, 2705, 1, 2666, 86, 78, 22, 224, 1, 31, 5, 5, 22, 5, 2, 0, 0, 0, 59, 130620, 16, 2326, 1, 2175, 86, 0, 0, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 60, 64, 130620, 16, 2326, 1, 2175, 86, 0, 9, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 65, 70, 130620, 16, 2326, 1, 2175, 86, 0, 12, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 71, 76, 130620, 16, 2326, 1, 2175, 86, 0, 17, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 77, 80, 130620, 16, 2326, 1, 2175, 86, 0, 20, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 81, 127, 130620, 16, 2326, 1, 2175, 86, 0, 24, 224, 1, 31, 6, 6, 22, 5, 2, 0, 0, 0, 58, 421088, 16, 1887, 1, 1802, 84, -12, 0, 224, 1, 31, 9, 9, 22, 5, 2, 0, 0, 59, 127, 421088, 16, 1887, 1, 1802, 84, -12, 3, 224, 1, 31, 9, 9, 22, 5, 2, 0, 0, 0, 58, 189248, 8, 19123, 1, 3067, 84, 32, 0, 224, 1, 31, 0, 0, 20, 0, 15, 0, 0, 59, 127, 189248, 8, 19123, 1, 3067, 84, 32, 4, 224, 1, 31, 0, 0, 20, 0, 15, 0, 0, 0, 59, 502736, 16, 1450, 1, 1365, 84, -10, 0, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 60, 127, 502736, 16, 1450, 1, 1365, 84, -10, 1, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 0, 58, 126784, 16, 795, 1, 682, 79, -14, 0, 224, 1, 31, 1, 2, 22, 5, 2, 0, 0, 59, 66, 126784, 16, 795, 1, 682, 79, -14, 4, 224, 1, 31, 1, 2, 22, 5, 2, 0, 0, 67, 78, 126784, 16, 795, 1, 682, 79, -14, 6, 224, 1, 31, 1, 2, 22, 5, 2, 0, 0, 79, 127, 126784, 16, 795, 1, 682, 79, -14, 8, 224, 1, 31, 1, 2, 22, 5, 2, 0, 0, 0, 58, 128376, 16, 1121, 1, 1035, 84, 44, 0, 224, 1, 25, 2, 1, 22, 5, 2, 0, 0, 59, 76, 128376, 16, 1121, 1, 1035, 84, 44, 3, 224, 1, 25, 2, 1, 22, 5, 2, 0, 0, 77, 127, 128376, 16, 1121, 1, 1035, 84, 44, 6, 224, 1, 25, 2, 1, 22, 5, 2, 0, 0, 0, 127, 208372, 8, 1808, 1, 1765, 84, -10, 0, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 0, 58, 135274, 16, 8368, 1, 497, 84, 0, 0, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 59, 66, 135274, 16, 8368, 1, 497, 84, 0, 2, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 67, 127, 135274, 16, 8368, 1, 497, 84, 0, 3, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 0, 58, 210182, 8, 10426, 1, 2464, 84, 0, 10, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 59, 63, 210182, 8, 10426, 1, 2464, 84, 0, 7, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 64, 66, 210182, 8, 10426, 1, 2464, 84, 0, 6, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 67, 71, 210182, 8, 10426, 1, 2464, 84, 0, 3, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 72, 78, 210182, 8, 10426, 1, 2464, 84, 0, 2, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 79, 127, 210182, 8, 10426, 1, 2464, 84, 0, 0, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 0, 58, 429352, 16, 11941, 1, 0, 84, 0, 0, 224, 1, 7, 0, 17, 22, 0, 15, 1, 0, 59, 60, 429352, 16, 11941, 1, 0, 84, 0, 1, 224, 1, 7, 0, 20, 22, 0, 15, 1, 0, 61, 66, 429352, 16, 11941, 1, 0, 84, 0, 4, 224, 1, 8, 0, 27, 22, 0, 15, 1, 0, 67, 69, 429352, 16, 11941, 1, 0, 84, 0, 5, 224, 1, 9, 0, 19, 22, 0, 15, 1, 0, 70, 72, 429352, 16, 11941, 1, 0, 84, 0, 7, 224, 1, 9, 0, 22, 22, 0, 15, 1, 0, 73, 75, 429352, 16, 11941, 1, 0, 84, 0, 8, 224, 1, 10, 0, 20, 22, 0, 15, 1, 0, 76, 78, 429352, 16, 11941, 1, 0, 84, 0, 9, 224, 1, 11, 0, 19, 22, 0, 15, 1, 0, 79, 81, 429352, 16, 11941, 1, 0, 84, 0, 9, 224, 1, 11, 0, 20, 22, 0, 15, 1, 0, 82, 84, 429352, 16, 11941, 1, 0, 84, 0, 12, 224, 1, 11, 0, 24, 22, 0, 15, 1, 0, 85, 127, 429352, 16, 11941, 1, 0, 84, 0, 14, 224, 1, 12, 0, 22, 22, 0, 15, 1, 0, 0, 58, 410116, 8, 10971, 1, 0, 84, 0, 0, 224, 1, 7, 0, 18, 22, 0, 15, 1, 0, 59, 60, 410116, 8, 10971, 1, 0, 84, 0, 3, 224, 1, 8, 0, 16, 22, 0, 15, 1, 0, 61, 66, 410116, 8, 10971, 1, 0, 84, 0, 3, 224, 1, 9, 0, 17, 22, 0, 15, 1, 0, 67, 72, 410116, 8, 10971, 1, 0, 84, 0, 3, 224, 1, 10, 0, 18, 22, 0, 15, 1, 0, 73, 78, 410116, 8, 10971, 1, 0, 84, 0, 2, 224, 1, 11, 0, 19, 22, 0, 15, 1, 0, 79, 84, 410116, 8, 10971, 1, 0, 84, 0, 3, 224, 1, 12, 0, 20, 22, 0, 15, 1, 0, 85, 127, 410116, 8, 10971, 1, 0, 84, 0, 3, 224, 1, 12, 0, 22, 22, 0, 15, 1, 0, 0, 58, 152012, 16, 63, 1, 20, 84, -10, 0, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 59, 65, 152012, 16, 63, 1, 20, 84, -10, 4, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 66, 77, 152012, 16, 63, 1, 20, 84, -10, 6, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 78, 127, 152012, 16, 63, 1, 20, 84, -10, 7, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 0, 58, 152140, 16, 169, 1, 0, 72, -10, 0, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 59, 127, 152140, 16, 169, 1, 0, 72, -10, 4, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 0, 58, 152480, 16, 43, 1, 0, 84, -10, 0, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 59, 61, 152480, 16, 43, 1, 0, 84, -10, 4, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 62, 67, 152480, 16, 43, 1, 0, 84, -10, 7, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 68, 71, 152480, 16, 43, 1, 0, 84, -10, 11, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 72, 77, 152480, 16, 43, 1, 0, 84, -10, 14, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 78, 82, 152480, 16, 43, 1, 0, 84, -10, 17, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 83, 84, 152480, 16, 43, 1, 0, 84, -10, 16, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 85, 127, 152480, 16, 43, 1, 0, 84, -10, 26, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 0, 58, 152568, 16, 43, 1, 0, 84, -10, 0, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 59, 64, 152568, 16, 43, 1, 0, 84, -10, 3, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 65, 68, 152568, 16, 43, 1, 0, 84, -10, 7, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 69, 71, 152568, 16, 43, 1, 0, 84, -10, 9, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 72, 77, 152568, 16, 43, 1, 0, 84, -10, 10, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 78, 80, 152568, 16, 43, 1, 0, 84, -10, 14, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 81, 127, 152568, 16, 43, 1, 0, 84, -10, 17, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 0, 58, 284286, 16, 2137, 1, 1970, 84, -92, 0, 224, 1, 31, 11, 11, 22, 5, 2, 0, 0, 59, 127, 284286, 16, 2137, 1, 1970, 84, -92, 1, 224, 1, 31, 11, 11, 22, 5, 2, 0, 0, 0, 58, 220610, 8, 8010, 1, 2138, 84, 0, 0, 224, 1, 31, 0, 9, 22, 0, 15, 0, 0, 59, 127, 220610, 8, 8010, 1, 2138, 84, 0, 1, 224, 1, 31, 0, 9, 22, 0, 15, 0, 0, 0, 58, 228622, 8, 16184, 1, 2162, 84, -46, 0, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 59, 71, 228622, 8, 16184, 1, 2162, 84, -46, 4, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 72, 77, 228622, 8, 16184, 1, 2162, 84, -46, 5, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 78, 80, 228622, 8, 16184, 1, 2162, 84, -46, 6, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 81, 127, 228622, 8, 16184, 1, 2162, 84, -46, 7, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 0, 64, 357342, 8, 6800, 1, 0, 85, 0, 0, 224, 1, 31, 0, 9, 22, 0, 15, 0, 0, 65, 70, 357342, 8, 6800, 1, 0, 85, 0, 0, 224, 1, 31, 0, 9, 22, 0, 15, 0, 0, 71, 75, 357342, 8, 6800, 1, 0, 85, 0, 1, 224, 1, 31, 0, 9, 22, 0, 15, 0, 0, 76, 81, 357342, 8, 6800, 1, 0, 85, 0, 1, 224, 1, 31, 0, 9, 22, 0, 15, 0, 0, 82, 84, 357342, 8, 6800, 1, 0, 85, 0, 1, 224, 1, 31, 0, 9, 22, 0, 15, 0, 0, 85, 127, 357342, 8, 6800, 1, 0, 85, 0, 2, 224, 1, 31, 0, 9, 22, 0, 15, 0, 0, 0, 66, 152656, 16, 1756, 1, 1643, 79, -16, 6, 224, 1, 31, 10, 10, 22, 5, 2, 0, 0, 67, 76, 152656, 16, 1756, 1, 1643, 79, -16, 3, 224, 1, 31, 10, 10, 22, 5, 2, 0, 0, 77, 127, 152656, 16, 1756, 1, 1643, 79, -16, 0, 224, 1, 31, 10, 10, 22, 5, 2, 0, 0, 0, 58, 424864, 8, 4486, 1, 3167, 84, 44, 0, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 59, 68, 424864, 8, 4486, 1, 3167, 84, 44, 3, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 69, 71, 424864, 8, 4486, 1, 3167, 84, 44, 6, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 72, 77, 424864, 8, 4486, 1, 3167, 84, 44, 9, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 78, 85, 424864, 8, 4486, 1, 3167, 84, 44, 10, 224, 1, 31, 1, 1, 22, 5, 2, 0, 0, 86, 127, 424864, 8, 4486, 1, 3167, 84, 44, 13, 224, 0, 31, 1, 1, 22, 5, 2, 0, 0, 0, 127, 349146, 16, 3809, 1, 3697, 79, -54, 0, 224, 1, 31, 8, 8, 20, 5, 2, 0, 0, 0, 58, 156170, 16, 3866, 1, 3781, 84, -12, 0, 224, 1, 31, 10, 10, 22, 5, 2, 0, 0, 59, 70, 156170, 16, 3866, 1, 3781, 84, -12, 4, 224, 1, 31, 10, 10, 22, 5, 2, 0, 0, 71, 127, 156170, 16, 3866, 1, 3781, 84, -12, 6, 224, 1, 31, 10, 10, 22, 5, 2, 0, 0, 0, 58, 374048, 16, 3644, 1, 0, 84, 0, 0, 224, 1, 11, 0, 19, 25, 0, 15, 1, 0, 59, 60, 374048, 16, 3644, 1, 0, 84, 0, 3, 224, 1, 11, 0, 20, 25, 0, 15, 1, 0, 61, 66, 374048, 16, 3644, 1, 0, 84, 0, 3, 224, 1, 12, 0, 22, 22, 0, 15, 1, 0, 67, 72, 374048, 16, 3644, 1, 0, 84, 0, 4, 224, 1, 13, 0, 22, 22, 0, 15, 1, 0, 73, 78, 374048, 16, 3644, 1, 0, 84, 0, 7, 224, 1, 14, 0, 23, 22, 0, 15, 1, 0, 79, 84, 374048, 16, 3644, 1, 0, 84, 0, 8, 224, 1, 15, 0, 24, 22, 0, 15, 1, 0, 85, 127, 374048, 16, 3644, 1, 0, 84, 0, 9, 224, 1, 15, 0, 27, 22, 0, 15, 1, 0, 0, 74, 100294, 16, 1023, 1, 938, 96, 0, 0, 224, 1, 31, 10, 10, 22, 5, 15, 0, 0, 75, 76, 100294, 16, 1023, 1, 938, 96, 0, 3, 224, 1, 31, 10, 10, 22, 5, 15, 0, 0, 77, 78, 100294, 16, 1023, 1, 938, 96, 0, 5, 224, 1, 31, 10, 10, 22, 5, 15, 0, 0, 79, 81, 100294, 16, 1023, 1, 938, 96, 0, 8, 224, 1, 31, 10, 10, 22, 5, 15, 0, 0, 82, 84, 100294, 16, 1023, 1, 938, 96, 0, 12, 224, 1, 31, 10, 10, 22, 5, 15, 0, 0, 85, 127, 100294, 16, 1023, 1, 938, 96, 0, 16, 224, 1, 31, 10, 10, 22, 5, 15, 0, 0, 0, 60, 304778, 8, 6799, 1, 0, 84, 0, 3, 224, 1, 9, 0, 19, 22, 0, 15, 1, 0, 61, 66, 304778, 8, 6799, 1, 0, 84, 0, 2, 224, 1, 10, 0, 21, 22, 0, 15, 1, 0, 67, 72, 304778, 8, 6799, 1, 0, 84, 0, 1, 224, 1, 11, 0, 21, 22, 0, 15, 1, 0, 73, 78, 304778, 8, 6799, 1, 0, 84, 0, 0, 224, 1, 12, 0, 23, 22, 0, 15, 1, 0, 79, 84, 304778, 8, 6799, 1, 0, 84, 0, 0, 224, 1, 13, 0, 23, 22, 0, 15, 1, 0, 85, 127, 304778, 8, 6799, 1, 0, 84, 0, 0, 224, 1, 13, 0, 29, 22, 0, 15, 1, 0, 0, 60, 288562, 16, 8107, 1, 1, 84, 0, 4, 224, 1, 9, 0, 18, 22, 0, 15, 1, 0, 61, 66, 288562, 16, 8107, 1, 1, 84, 0, 2, 224, 1, 9, 0, 25, 22, 0, 15, 1, 0, 67, 68, 288562, 16, 8107, 1, 1, 84, 0, 2, 224, 1, 10, 0, 21, 22, 0, 15, 1, 0, 69, 72, 288562, 16, 8107, 1, 1, 84, 0, 4, 224, 1, 11, 0, 19, 22, 0, 15, 1, 0, 73, 78, 288562, 16, 8107, 1, 1, 84, 0, 5, 224, 1, 11, 0, 27, 22, 0, 15, 1, 0, 79, 84, 288562, 16, 8107, 1, 1, 84, 0, 7, 224, 1, 13, 0, 21, 22, 0, 15, 1, 0, 85, 127, 288562, 16, 8107, 1, 1, 84, 0, 6, 224, 1, 13, 0, 23, 22, 0, 15, 1, 0, 0, 127, 311578, 8, 15102, 1, 0, 72, 0, 0, 224, 1, 31, 0, 19, 22, 0, 15, 0, 0, 0, 60, 311578, 8, 15102, 1, 0, 72, 0, 5, 224, 1, 9, 0, 18, 22, 0, 15, 1, 0, 61, 66, 311578, 8, 15102, 1, 0, 72, 0, 5, 224, 1, 10, 0, 19, 22, 0, 15, 1, 0, 67, 72, 311578, 8, 15102, 1, 0, 72, 0, 4, 224, 1, 11, 0, 19, 22, 0, 15, 1, 0, 73, 78, 311578, 8, 15102, 1, 0, 72, 0, 0, 224, 1, 12, 0, 20, 22, 0, 15, 1, 0, 79, 84, 311578, 8, 15102, 1, 0, 72, 0, 0, 224, 1, 13, 0, 21, 22, 0, 15, 1, 0, 85, 127, 311578, 8, 15102, 1, 0, 72, 0, 0, 224, 1, 13, 0, 23, 22, 0, 15, 1, 0, 0, 63, 453236, 8, 44087, 1, 0, 72, 0, 0, 224, 1, 5, 0, 19, 22, 0, 15, 1, 0, 64, 66, 453236, 8, 44087, 1, 0, 72, 0, 2, 224, 1, 7, 0, 15, 22, 0, 15, 1, 0, 67, 68, 453236, 8, 44087, 1, 0, 72, 0, 3, 224, 1, 7, 0, 17, 22, 0, 15, 1, 0, 69, 72, 453236, 8, 44087, 1, 0, 72, 0, 4, 224, 1, 8, 0, 17, 22, 0, 15, 1, 0, 73, 78, 453236, 8, 44087, 1, 0, 72, 0, 4, 224, 1, 9, 0, 17, 22, 0, 15, 1, 0, 79, 84, 453236, 8, 44087, 1, 0, 72, 0, 3, 224, 1, 10, 0, 19, 22, 0, 15, 1, 0, 85, 127, 453236, 8, 44087, 1, 0, 72, 0, 0, 224, 1, 10, 0, 21, 22, 0, 15, 1, 0, 0, 127, 244808, 8, 21282, 1, 15812, 78, 116, 0, 224, 1, 31, 11, 12, 22, 5, 15, 0, 0, 0, 60, 163904, 16, 3123, 1, 3040, 84, 0, 0, 224, 1, 11, 0, 18, 22, 0, 15, 1, 0, 61, 66, 163904, 16, 3123, 1, 3040, 84, 0, 2, 224, 1, 13, 0, 18, 22, 0, 15, 1, 0, 67, 72, 163904, 16, 3123, 1, 3040, 84, 0, 1, 224, 1, 13, 0, 19, 22, 0, 15, 1, 0, 73, 78, 163904, 16, 3123, 1, 3040, 84, 0, 1, 224, 1, 14, 0, 21, 22, 0, 15, 1, 0, 79, 84, 163904, 16, 3123, 1, 3040, 84, 0, 1, 224, 1, 15, 0, 21, 22, 0, 15, 1, 0, 85, 127, 163904, 16, 3123, 1, 3040, 84, 0, 1, 224, 1, 15, 0, 25, 22, 0, 15, 1, 0, 0, 60, 333766, 8, 3912, 1, 0, 84, 0, 3, 224, 1, 11, 0, 20, 22, 0, 15, 1, 0, 61, 66, 333766, 8, 3912, 1, 0, 84, 0, 2, 224, 1, 12, 0, 21, 22, 0, 15, 1, 0, 67, 72, 333766, 8, 3912, 1, 0, 84, 0, 0, 224, 1, 13, 0, 22, 22, 0, 15, 1, 0, 73, 78, 333766, 8, 3912, 1, 0, 84, 0, 0, 224, 1, 14, 0, 23, 22, 0, 15, 1, 0, 79, 84, 333766, 8, 3912, 1, 0, 84, 0, 0, 224, 1, 15, 0, 23, 22, 0, 15, 1, 0, 85, 127, 333766, 8, 3912, 1, 0, 84, 0, 0, 224, 1, 15, 0, 25, 22, 0, 15, 1, 0, 0, 60, 326682, 16, 3541, 1, 0, 84, 0, 0, 224, 1, 11, 0, 19, 22, 0, 15, 1, 0, 61, 66, 326682, 16, 3541, 1, 0, 84, 0, 0, 224, 1, 12, 0, 21, 22, 0, 15, 1, 0, 67, 72, 326682, 16, 3541, 1, 0, 84, 0, 0, 224, 1, 13, 0, 21, 22, 0, 15, 1, 0, 73, 78, 326682, 16, 3541, 1, 0, 84, 0, 0, 224, 1, 14, 0, 22, 22, 0, 15, 1, 0, 79, 84, 326682, 16, 3541, 1, 0, 84, 0, 1, 224, 1, 15, 0, 24, 22, 0, 15, 1, 0, 85, 127, 326682, 16, 3541, 1, 0, 84, 0, 0, 224, 1, 15, 0, 25, 22, 0, 15, 1, 0, 0, 59, 398242, 16, 5936, 1, 0, 84, 0, 0, 224, 1, 9, 0, 21, 22, 0, 15, 1, 0, 60, 63, 398242, 16, 5936, 1, 0, 84, 0, 2, 224, 1, 10, 0, 21, 22, 0, 15, 1, 0, 64, 66, 398242, 16, 5936, 1, 0, 84, 0, 5, 224, 1, 11, 0, 19, 22, 0, 15, 1, 0, 67, 72, 398242, 16, 5936, 1, 0, 84, 0, 7, 224, 1, 11, 0, 25, 22, 0, 15, 1, 0, 73, 76, 398242, 16, 5936, 1, 0, 84, 0, 7, 224, 1, 12, 0, 24, 22, 0, 15, 1, 0, 77, 78, 398242, 16, 5936, 1, 0, 84, 0, 9, 224, 1, 13, 0, 21, 22, 0, 15, 1, 0, 79, 84, 398242, 16, 5936, 1, 0, 84, 0, 9, 224, 1, 13, 0, 26, 22, 0, 15, 1, 0, 85, 127, 398242, 16, 5936, 1, 0, 84, 0, 9, 224, 1, 14, 0, 24, 22, 0, 15, 1, 0, 0, 61, 304778, 8, 6799, 2, 0, 96, 0, 0, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 62, 65, 304778, 8, 6799, 2, 0, 96, 0, 3, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 66, 71, 304778, 8, 6799, 2, 0, 96, 0, 6, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 72, 75, 304778, 8, 6799, 2, 0, 96, 0, 7, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 76, 78, 304778, 8, 6799, 2, 0, 96, 0, 8, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 79, 83, 304778, 8, 6799, 2, 0, 96, 0, 10, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 84, 127, 304778, 8, 6799, 2, 0, 96, 0, 11, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 0, 58, 311578, 8, 15102, 2, 0, 87, 0, 0, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 59, 127, 311578, 8, 15102, 2, 0, 87, 0, 2, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 0, 58, 453236, 8, 44087, 2, 0, 87, 0, 0, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 59, 127, 453236, 8, 44087, 2, 0, 87, 0, 2, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 0, 58, 410116, 8, 10971, 2, 0, 96, 0, 0, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 59, 63, 410116, 8, 10971, 2, 0, 96, 0, 3, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 64, 68, 410116, 8, 10971, 2, 0, 96, 0, 5, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 69, 75, 410116, 8, 10971, 2, 0, 96, 0, 7, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 76, 127, 410116, 8, 10971, 2, 0, 96, 0, 9, 224, 1, 31, 0, 0, 22, 0, 15, 0, 0, 1, 1, 374048, 16, 3644, 1, 0, 13, 0, 35, 224, 1, 13, 0, 22, 24, 0, 15, 1, 0, 2, 2, 304778, 8, 6799, 1, 0, 14, 0, 54, 240, 1, 11, 0, 21, 24, 0, 15, 1, 0, 3, 3, 311578, 8, 15102, 1, 0, 3, 0, 62, 242, 1, 31, 0, 20, 24, 0, 15, 0, 0, 4, 4, 311578, 8, 15102, 1, 0, 4, 0, 68, 242, 1, 11, 0, 18, 25, 0, 15, 1, 0, 93, 97, 189248, 8, 19123, 1, 3067, 120, 32, 81, 227, 1, 31, 0, 0, 24, 0, 15, 0, 0, 85, 92, 189248, 8, 19123, 1, 3067, 108, 32, 81, 227, 1, 31, 0, 0, 24, 0, 15, 0, 0, 69, 78, 189248, 8, 19123, 1, 3067, 96, 32, 81, 243, 1, 31, 0, 0, 24, 0, 15, 0, 0, 67, 68, 189248, 8, 19123, 1, 3067, 84, 32, 81, 243, 1, 31, 0, 0, 24, 0, 15, 0, 0, 41, 45, 104e3, 16, 2590, 1, 2255, 60, -40, 62, 224, 1, 31, 7, 8, 24, 5, 2, 0, 0, 29, 40, 104e3, 16, 2590, 1, 2255, 48, -40, 62, 224, 1, 31, 6, 7, 24, 5, 2, 0, 0, 65, 66, 109182, 16, 3223, 1, 2885, 84, 0, 55, 224, 1, 31, 12, 13, 24, 5, 2, 0, 0, 55, 64, 109182, 16, 3223, 1, 2885, 72, 0, 55, 224, 1, 31, 12, 13, 24, 5, 2, 0, 0, 23, 25, 345152, 16, 1454, 1, 1115, 36, 18, 50, 224, 1, 31, 6, 6, 24, 5, 2, 0, 0, 16, 22, 345152, 16, 1454, 1, 1115, 36, 18, 44, 224, 1, 31, 6, 6, 24, 5, 2, 0, 0, 11, 15, 345152, 16, 1454, 1, 1115, 24, 18, 50, 224, 1, 31, 6, 6, 24, 5, 2, 0, 0, 5, 10, 345152, 16, 1454, 1, 1115, 24, 18, 44, 224, 1, 31, 6, 6, 24, 5, 2, 0, 0, 1, 1, 374048, 16, 3644, 1, 0, 13, 0, 35, 224, 1, 13, 0, 22, 24, 0, 15, 1, 0, 2, 2, 304778, 8, 6799, 1, 0, 14, 0, 54, 240, 1, 11, 0, 21, 24, 0, 15, 1, 0, 3, 3, 311578, 8, 15102, 1, 0, 3, 0, 68, 242, 1, 11, 0, 18, 24, 0, 15, 1, 0, 68, 73, 94822, 16, 674, 1, 631, 96, -8, 78, 227, 1, 31, 8, 8, 24, 5, 2, 0, 0, 61, 67, 94822, 16, 674, 1, 631, 84, -8, 78, 227, 1, 31, 8, 8, 24, 5, 2, 0, 0, 56, 58, 94822, 16, 674, 1, 631, 84, -8, 78, 243, 1, 31, 8, 8, 24, 5, 2, 0, 0, 46, 55, 94822, 16, 674, 1, 631, 72, -8, 78, 243, 1, 31, 8, 8, 24, 5, 2, 0, 0, 44, 44, 94822, 16, 674, 1, 631, 72, -8, 78, 224, 1, 31, 8, 8, 24, 5, 2, 0, 0, 32, 43, 94822, 16, 674, 1, 631, 60, -8, 78, 224, 1, 31, 8, 8, 24, 5, 2, 0, 0, 28, 31, 94822, 16, 674, 1, 631, 48, -8, 78, 224, 1, 31, 8, 8, 24, 5, 2, 0, 0, 16, 18, 345152, 16, 1454, 1, 1115, 36, 18, 34, 224, 1, 31, 12, 13, 24, 5, 2, 0, 0, 11, 15, 345152, 16, 1454, 1, 1115, 24, 18, 40, 224, 1, 31, 12, 13, 24, 5, 2, 0, 0, 7, 10, 345152, 16, 1454, 1, 1115, 24, 18, 36, 224, 1, 31, 12, 13, 24, 5, 2, 0, 0, 1, 1, 374048, 16, 3644, 1, 0, 13, 0, 35, 224, 1, 13, 0, 22, 24, 0, 15, 1, 0, 2, 2, 304778, 8, 6799, 1, 0, 14, 0, 54, 224, 1, 11, 0, 21, 24, 0, 15, 1, 0, 3, 3, 311578, 8, 15102, 1, 0, 3, 0, 78, 242, 1, 31, 0, 19, 24, 0, 15, 0, 0, 4, 4, 311578, 8, 15102, 1, 0, 4, 0, 62, 242, 1, 31, 0, 19, 24, 0, 15, 0, 0, 5, 5, 311578, 8, 15102, 1, 0, 5, 0, 52, 242, 1, 31, 0, 19, 24, 0, 15, 0, 0, 6, 6, 311578, 8, 15102, 1, 0, 6, 0, 68, 242, 1, 11, 0, 18, 24, 0, 15, 1, 0, 93, 97, 189248, 8, 19123, 1, 3067, 120, 32, 64, 227, 1, 31, 0, 0, 24, 0, 15, 0, 0, 83, 92, 189248, 8, 19123, 1, 3067, 108, 32, 64, 227, 1, 31, 0, 0, 24, 0, 15, 0, 0, 69, 71, 189248, 8, 19123, 1, 3067, 96, 32, 64, 243, 1, 31, 0, 0, 24, 0, 15, 0, 0, 57, 68, 189248, 8, 19123, 1, 3067, 84, 32, 64, 243, 1, 31, 0, 0, 24, 0, 15, 0, 0, 55, 56, 189248, 8, 19123, 1, 3067, 72, 32, 64, 243, 1, 31, 0, 0, 24, 0, 15, 0, 0, 33, 42, 189248, 8, 19123, 1, 3067, 60, 32, 64, 240, 1, 31, 0, 0, 24, 0, 15, 0, 0, 30, 32, 189248, 8, 19123, 1, 3067, 48, 32, 64, 240, 1, 31, 0, 0, 24, 0, 15, 0, 0, 2, 2, 304778, 8, 6799, 1, 0, 9, 0, 67, 241, 1, 12, 0, 31, 24, 0, 15, 1, 0, 3, 3, 304778, 8, 6799, 1, 0, 10, 0, 63, 241, 1, 12, 0, 31, 24, 0, 15, 1, 0, 4, 4, 304778, 8, 6799, 1, 0, 11, 0, 58, 241, 1, 12, 0, 31, 24, 0, 15, 1, 0, 5, 5, 304778, 8, 6799, 1, 0, 12, 0, 54, 241, 1, 12, 0, 31, 24, 0, 15, 1, 0, 6, 6, 304778, 8, 6799, 1, 0, 13, 0, 50, 241, 1, 12, 0, 31, 24, 0, 15, 1, 0, 16, 18, 410116, 8, 10971, 1, 0, 36, 0, 46, 224, 1, 9, 0, 17, 24, 0, 15, 1, 0, 11, 15, 410116, 8, 10971, 1, 0, 24, 0, 47, 224, 1, 10, 0, 20, 24, 0, 15, 1, 0, 7, 10, 410116, 8, 10971, 1, 0, 24, 0, 47, 224, 1, 9, 0, 19, 24, 0, 15, 1, 0, 69, 73, 284286, 16, 2137, 1, 1970, 108, -92, 55, 227, 1, 31, 13, 13, 24, 5, 2, 0, 0, 59, 68, 284286, 16, 2137, 1, 1970, 96, -92, 55, 227, 1, 31, 13, 13, 24, 5, 2, 0, 0, 57, 58, 284286, 16, 2137, 1, 1970, 96, -92, 55, 243, 1, 31, 13, 13, 24, 5, 2, 0, 0, 45, 56, 284286, 16, 2137, 1, 1970, 84, -92, 55, 243, 1, 31, 13, 13, 24, 5, 2, 0, 0, 43, 44, 284286, 16, 2137, 1, 1970, 72, -92, 55, 243, 1, 31, 13, 13, 24, 5, 2, 0, 0, 33, 42, 284286, 16, 2137, 1, 1970, 72, -92, 55, 224, 1, 31, 13, 13, 24, 5, 2, 0, 0, 29, 32, 284286, 16, 2137, 1, 1970, 60, -92, 55, 224, 1, 31, 13, 13, 24, 5, 2, 0, 0, 23, 25, 115630, 16, 3189, 1, 3104, 60, -12, 48, 224, 1, 20, 9, 9, 24, 5, 2, 0, 0, 16, 22, 115630, 16, 3189, 1, 3104, 60, -12, 44, 224, 1, 20, 9, 9, 24, 5, 2, 0, 0, 11, 15, 115630, 16, 3189, 1, 3104, 48, -12, 48, 224, 1, 20, 9, 9, 24, 5, 2, 0, 0, 7, 10, 115630, 16, 3189, 1, 3104, 48, -12, 44, 224, 1, 20, 9, 9, 24, 5, 2, 0, 0, 4, 4, 356766, 16, 287, 1, 243, 40, 0, 66, 226, 1, 31, 13, 12, 24, 5, 15, 0, 0, 3, 3, 356766, 16, 287, 1, 243, 39, 0, 69, 226, 1, 31, 0, 18, 24, 0, 15, 0, 0, 2, 2, 163904, 16, 3123, 1, 3040, 26, 0, 37, 224, 1, 20, 0, 10, 24, 0, 15, 0, 0, 1, 1, 163904, 16, 3123, 1, 3040, 25, 0, 52, 224, 1, 11, 0, 20, 24, 0, 15, 1, 0, 68, 73, 348062, 16, 541, 1, 498, 96, -12, 69, 227, 1, 31, 8, 8, 24, 5, 2, 0, 0, 61, 67, 348062, 16, 541, 1, 498, 84, -12, 69, 227, 1, 31, 8, 8, 24, 5, 2, 0, 0, 56, 58, 348062, 16, 541, 1, 498, 84, -12, 69, 243, 1, 31, 8, 8, 24, 5, 2, 0, 0, 46, 55, 348062, 16, 541, 1, 498, 72, -12, 69, 243, 1, 31, 8, 8, 24, 5, 2, 0, 0, 32, 42, 348062, 16, 541, 1, 498, 60, -12, 69, 224, 1, 31, 8, 8, 24, 5, 2, 0, 0, 28, 31, 348062, 16, 541, 1, 498, 48, -12, 69, 224, 1, 31, 8, 8, 24, 5, 2, 0, 0, 23, 27, 122010, 16, 2386, 1, 2048, 36, 2, 28, 224, 1, 31, 7, 8, 24, 5, 2, 0, 0, 16, 22, 122010, 16, 2386, 1, 2048, 36, 2, 28, 224, 1, 31, 7, 8, 24, 5, 2, 0, 0, 11, 15, 122010, 16, 2386, 1, 2048, 24, 2, 28, 224, 1, 31, 7, 8, 24, 5, 2, 0, 0, 7, 10, 122010, 16, 2386, 1, 2048, 24, 2, 28, 224, 1, 31, 7, 8, 24, 5, 2, 0, 0, 100, 100, 244808, 8, 21282, 1, 15812, 106, 116, 67, 226, 1, 31, 12, 13, 24, 5, 15, 0, 0, 101, 101, 244808, 8, 21282, 1, 15812, 107, 116, 63, 226, 1, 31, 12, 13, 24, 5, 15, 0, 0, 102, 102, 244808, 8, 21282, 1, 15812, 108, 116, 50, 226, 1, 31, 12, 13, 24, 5, 15, 0, 0, 1, 1, 374048, 16, 3644, 1, 0, 13, 0, 35, 224, 1, 13, 0, 22, 24, 0, 15, 1, 0, 2, 2, 304778, 8, 6799, 1, 0, 14, 0, 77, 224, 1, 11, 0, 21, 24, 0, 15, 1, 0, 3, 3, 304778, 8, 6799, 1, 0, 15, 0, 63, 224, 1, 11, 0, 21, 24, 0, 15, 1, 0, 4, 4, 304778, 8, 6799, 1, 0, 16, 0, 54, 224, 1, 11, 0, 21, 24, 0, 15, 1, 0, 5, 5, 304778, 8, 6799, 1, 0, 17, 0, 52, 224, 1, 11, 0, 21, 24, 0, 15, 1, 0, 93, 94, 179602, 8, 9645, 1, 4148, 120, 0, 51, 227, 1, 31, 15, 16, 24, 5, 15, 0, 0, 81, 92, 179602, 8, 9645, 1, 4148, 108, 0, 51, 227, 1, 31, 15, 16, 24, 5, 15, 0, 0, 73, 80, 179602, 8, 9645, 1, 4148, 96, 0, 51, 227, 1, 31, 15, 16, 24, 5, 15, 0, 0, 69, 70, 179602, 8, 9645, 1, 4148, 96, 0, 51, 243, 1, 31, 15, 16, 24, 5, 15, 0, 0, 57, 68, 179602, 8, 9645, 1, 4148, 84, 0, 51, 243, 1, 31, 15, 16, 24, 5, 15, 0, 0, 49, 56, 179602, 8, 9645, 1, 4148, 72, 0, 51, 243, 1, 31, 15, 16, 24, 5, 15, 0, 0, 45, 46, 179602, 8, 9645, 1, 4148, 72, 0, 51, 224, 1, 31, 15, 16, 24, 5, 15, 0, 0, 33, 44, 179602, 8, 9645, 1, 4148, 60, 0, 51, 224, 1, 31, 15, 16, 24, 5, 15, 0, 0, 25, 32, 179602, 8, 9645, 1, 4148, 48, 0, 51, 240, 1, 31, 15, 16, 24, 5, 15, 0, 0, 16, 18, 364144, 16, 990, 1, 652, 36, 0, 36, 224, 1, 31, 14, 13, 24, 5, 2, 0, 0, 10, 15, 364144, 16, 990, 1, 652, 24, 0, 38, 224, 1, 31, 14, 13, 24, 5, 2, 0, 0, 7, 9, 364144, 16, 990, 1, 652, 24, 0, 37, 224, 1, 31, 14, 13, 24, 5, 2, 0, 0, 1, 1, 304778, 8, 6799, 3, 0, 25, 0, 67, 224, 1, 7, 0, 24, 24, 0, 15, 1, 0, 2, 2, 304778, 8, 6799, 3, 0, 18, 0, 65, 225, 1, 9, 0, 24, 24, 0, 15, 1, 0, 3, 3, 304778, 8, 6799, 3, 0, 12, 0, 68, 226, 1, 11, 0, 24, 24, 0, 15, 1, 0, 4, 4, 311578, 8, 15102, 1, 0, 4, 0, 62, 226, 1, 31, 0, 19, 24, 0, 15, 0, 0, 5, 5, 311578, 8, 15102, 1, 0, 5, 0, 68, 242, 1, 11, 0, 18, 24, 0, 15, 1, 0, 68, 73, 115630, 16, 3189, 1, 3104, 84, -12, 74, 227, 1, 31, 10, 9, 24, 5, 2, 0, 0, 61, 67, 115630, 16, 3189, 1, 3104, 72, -12, 74, 227, 1, 31, 10, 9, 24, 5, 2, 0, 0, 56, 58, 115630, 16, 3189, 1, 3104, 72, -12, 74, 243, 1, 31, 10, 9, 24, 5, 2, 0, 0, 46, 55, 115630, 16, 3189, 1, 3104, 60, -12, 74, 243, 1, 31, 10, 9, 24, 5, 2, 0, 0, 32, 42, 115630, 16, 3189, 1, 3104, 48, -12, 74, 224, 1, 31, 10, 9, 24, 5, 2, 0, 0, 28, 31, 115630, 16, 3189, 1, 3104, 36, -12, 74, 224, 1, 31, 10, 9, 24, 5, 2, 0, 0, 104, 109, 115630, 16, 3189, 1, 3104, 120, -12, 55, 227, 1, 31, 0, 18, 24, 0, 2, 0, 0, 97, 103, 115630, 16, 3189, 1, 3104, 108, -12, 55, 227, 1, 31, 0, 18, 24, 0, 2, 0, 0, 92, 94, 115630, 16, 3189, 1, 3104, 108, -12, 55, 243, 1, 31, 0, 18, 24, 0, 2, 0, 0, 82, 91, 115630, 16, 3189, 1, 3104, 96, -12, 55, 243, 1, 31, 0, 18, 24, 0, 2, 0, 0, 23, 25, 345152, 16, 1454, 1, 1115, 36, 18, 50, 224, 1, 31, 6, 6, 24, 5, 2, 0, 0, 16, 22, 345152, 16, 1454, 1, 1115, 36, 18, 44, 224, 1, 31, 6, 6, 24, 5, 2, 0, 0, 11, 15, 345152, 16, 1454, 1, 1115, 24, 18, 50, 224, 1, 31, 6, 6, 24, 5, 2, 0, 0, 7, 10, 345152, 16, 1454, 1, 1115, 24, 18, 44, 224, 1, 31, 6, 6, 24, 5, 2, 0, 0, 1, 1, 374048, 16, 3644, 1, 0, 13, 0, 35, 224, 1, 13, 0, 22, 24, 0, 15, 1, 0, 2, 2, 304778, 8, 6799, 1, 0, 14, 0, 54, 240, 1, 11, 0, 21, 24, 0, 15, 1, 0, 3, 3, 163904, 16, 3123, 1, 3040, 20, 0, 48, 226, 1, 12, 0, 20, 24, 0, 15, 1, 0, 4, 4, 163904, 16, 3123, 1, 3040, 16, 0, 48, 227, 1, 13, 0, 20, 24, 0, 15, 1, 0, 5, 5, 333766, 8, 3912, 1, 0, 17, 0, 59, 226, 1, 13, 0, 21, 24, 0, 15, 1, 0, 6, 6, 333766, 8, 3912, 1, 0, 13, 0, 58, 227, 1, 13, 0, 25, 24, 0, 15, 1, 0, 122, 122, 333766, 8, 3912, 1, 0, 123, 0, 67, 227, 1, 31, 0, 19, 24, 0, 15, 0, 0, 123, 123, 98982, 16, 655, 1, 485, 124, 0, 74, 227, 1, 31, 12, 11, 24, 5, 15, 0, 0, 120, 120, 311578, 8, 15102, 1, 0, 90, 0, 93, 243, 1, 20, 16, 20, 24, 5, 15, 0, 0, 121, 121, 311578, 8, 15102, 1, 0, 91, 0, 75, 243, 1, 20, 16, 20, 24, 5, 15, 0, 0, 68, 73, 391550, 16, 3344, 1, 3301, 96, -10, 65, 227, 1, 31, 9, 9, 24, 5, 2, 0, 0, 61, 67, 391550, 16, 3344, 1, 3301, 84, -10, 65, 227, 1, 31, 9, 9, 24, 5, 2, 0, 0, 56, 58, 391550, 16, 3344, 1, 3301, 84, -10, 65, 243, 1, 31, 9, 9, 24, 5, 2, 0, 0, 46, 55, 391550, 16, 3344, 1, 3301, 72, -10, 65, 243, 1, 31, 9, 9, 24, 5, 2, 0, 0, 32, 42, 391550, 16, 3344, 1, 3301, 60, -10, 65, 224, 1, 31, 9, 9, 24, 5, 2, 0, 0, 29, 31, 391550, 16, 3344, 1, 3301, 48, -10, 65, 224, 1, 31, 9, 9, 24, 5, 2, 0, 0, 23, 25, 179602, 8, 9645, 1, 4148, 60, 0, 56, 224, 1, 31, 0, 0, 24, 0, 15, 0, 0, 16, 22, 179602, 8, 9645, 1, 4148, 60, 0, 53, 224, 1, 31, 0, 0, 24, 0, 15, 0, 0, 11, 15, 179602, 8, 9645, 1, 4148, 48, 0, 56, 224, 1, 31, 0, 0, 24, 0, 15, 0, 0, 7, 10, 179602, 8, 9645, 1, 4148, 48, 0, 53, 224, 1, 31, 0, 0, 24, 0, 15, 0, 0, 1, 1, 100294, 16, 1023, 1, 938, 25, 0, 24, 224, 1, 31, 14, 14, 30, 5, 15, 0, 0, 2, 2, 304778, 8, 6799, 1, 0, 2, 0, 64, 225, 1, 13, 0, 22, 24, 0, 15, 1, 0, 3, 3, 311578, 8, 15102, 1, 0, 3, 0, 62, 242, 1, 31, 0, 19, 24, 0, 15, 0, 0, 4, 4, 311578, 8, 15102, 1, 0, 4, 0, 68, 242, 1, 11, 0, 18, 24, 0, 15, 1, 0, 100, 100, 98982, 16, 655, 1, 485, 101, 0, 79, 243, 1, 31, 18, 20, 24, 5, 15, 0, 0, 101, 101, 98982, 16, 655, 1, 485, 102, 0, 68, 243, 1, 31, 12, 11, 24, 5, 15, 0, 0, 102, 102, 98982, 16, 655, 1, 485, 103, 0, 79, 227, 1, 31, 18, 20, 24, 5, 15, 0, 0, 103, 103, 98982, 16, 655, 1, 485, 104, 0, 68, 227, 1, 31, 12, 11, 24, 5, 15, 0, 0, 0, 0, 284286, 16, 2137, 1, 1970, 12, 0, 23, 224, 0, 20, 0, 0, 27, 0, 15, 0, 0, 4, 7, 102342, 16, 828, 1, 785, 12, 0, 20, 224, 0, 31, 0, 18, 27, 0, 15, 0, 0, 12, 28, 96172, 16, 1404, 1, 1347, 19, 0, 12, 224, 0, 31, 0, 19, 27, 0, 15, 0, 0, 40, 52, 152568, 16, 43, 1, 0, 72, 0, 11, 224, 0, 16, 0, 0, 31, 0, 15, 0, 0, 56, 56, 345152, 16, 1454, 1, 1115, 60, 0, 5, 224, 0, 18, 0, 0, 27, 0, 15, 0, 0, 64, 65, 96172, 16, 1404, 1, 1347, 55, 0, 30, 224, 0, 31, 0, 0, 27, 0, 15, 0, 0, 71, 71, 244808, 8, 21282, 1, 15812, 66, 116, 21, 224, 0, 31, 0, 20, 27, 0, 15, 0, 0, 76, 76, 98982, 16, 655, 1, 485, 84, 0, 10, 224, 0, 19, 0, 0, 27, 0, 15, 0, 0, 83, 83, 311578, 8, 15102, 0, 0, 48, 0, 19, 224, 0, 16, 0, 19, 27, 0, 15, 0, 0, 0, 0, 135274, 16, 8368, 1, 497, 24, 0, 5, 224, 0, 25, 0, 0, 27, 0, 15, 0, 0, 8, 8, 100294, 16, 1023, 1, 938, 24, 0, 13, 224, 0, 31, 0, 0, 27, 0, 15, 0, 0, 12, 12, 266092, 8, 11252, 1, 110, 24, 0, 9, 224, 0, 31, 0, 10, 27, 0, 15, 0, 0, 23, 35, 304778, 8, 6799, 1, 0, 84, 0, 18, 224, 0, 31, 11, 14, 27, 5, 15, 0, 0, 45, 45, 179602, 8, 9645, 1, 4148, 60, 0, 28, 224, 0, 31, 0, 0, 27, 0, 15, 0, 0, 59, 63, 410116, 8, 10971, 1, 0, 72, 0, 24, 224, 0, 10, 0, 21, 27, 0, 15, 1, 0, 0, 36, 266092, 8, 11252, 1, 110, 24, 0, 1, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 163904, 16, 3123, 1, 3040, 60, 0, 0, 224, 0, 31, 0, 18, 31, 0, 15, 0, 0, 91, 127, 387150, 16, 2199, 1, 2156, 120, 0, 20, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 304778, 8, 6799, 1, 0, 108, 0, 14, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 40, 266092, 8, 11252, 2, 110, 24, 0, 15, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 80, 80, 128376, 16, 1121, 3, 1035, 60, 0, 18, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 71, 71, 128376, 16, 1121, 3, 1035, 48, 0, 15, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 70, 128376, 16, 1121, 3, 1035, 36, 0, 18, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 44, 44, 128376, 16, 1121, 3, 1035, 12, 0, 18, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 104e3, 16, 2590, 1, 2255, 96, 0, 4, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 424864, 8, 4486, 1, 3167, 48, 0, 8, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 40, 210182, 8, 10426, 3, 2464, 0, 0, 23, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 84, 84, 366126, 16, 3960, 1, 587, 108, 0, 25, 224, 0, 17, 0, 0, 31, 0, 15, 0, 0, 48, 83, 210182, 8, 10426, 1, 2464, 48, 0, 17, 224, 0, 16, 0, 0, 31, 0, 15, 0, 0, 0, 36, 228622, 8, 16184, 1, 2162, 36, 0, 0, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 333766, 8, 3912, 2, 0, 72, 0, 0, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 410116, 8, 10971, 2, 0, 120, 0, 40, 224, 0, 20, 0, 0, 31, 0, 15, 0, 0, 91, 127, 228622, 8, 16184, 1, 2162, 96, 0, 3, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 60, 84, 163904, 16, 3123, 3, 3040, 72, 0, 8, 224, 0, 20, 0, 0, 31, 0, 15, 0, 0, 84, 127, 364144, 16, 990, 1, 652, 120, 0, 4, 224, 0, 20, 0, 0, 31, 0, 15, 0, 0, 0, 59, 96172, 16, 1404, 1, 1347, 7, 0, 39, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 96172, 16, 1404, 1, 1347, 67, 0, 1, 224, 0, 25, 0, 0, 31, 0, 15, 0, 0, 0, 36, 135274, 16, 8368, 1, 497, 0, 0, 11, 224, 0, 31, 0, 10, 31, 0, 15, 0, 0, 100, 100, 94822, 16, 674, 1, 631, 60, 0, 9, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 110, 110, 94822, 16, 674, 1, 631, 60, 0, 6, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 220610, 8, 8010, 1, 2138, 24, 0, 18, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 220610, 8, 8010, 1, 2138, 60, 0, 0, 224, 0, 15, 0, 0, 31, 0, 15, 0, 0, 85, 127, 152480, 16, 43, 1, 0, 108, 0, 36, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 364144, 16, 990, 1, 652, 120, 0, 1, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 311578, 8, 15102, 1, 0, 108, 0, 30, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 47, 84, 152012, 16, 63, 1, 20, 84, 0, 27, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 266092, 8, 11252, 1, 110, 36, 0, 1, 241, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 266092, 8, 11252, 1, 110, 36, 10, 1, 225, 0, 31, 0, 0, 31, 0, 15, 0, 0, 24, 24, 210182, 8, 10426, 3, 2464, 0, 0, 13, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 25, 25, 210182, 8, 10426, 3, 2464, 1, 0, 13, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 26, 26, 210182, 8, 10426, 3, 2464, 2, 0, 13, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 27, 27, 210182, 8, 10426, 3, 2464, 3, 0, 13, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 28, 28, 210182, 8, 10426, 3, 2464, 4, 0, 13, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 29, 29, 210182, 8, 10426, 3, 2464, 5, -60, 13, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 108, 108, 356766, 16, 287, 1, 243, 108, 0, 3, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 109, 109, 356766, 16, 287, 1, 243, 109, 0, 3, 224, 0, 31, 0, 0, 28, 0, 15, 0, 0, 110, 110, 356766, 16, 287, 1, 243, 110, 0, 3, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 111, 111, 356766, 16, 287, 1, 243, 111, 0, 3, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 112, 112, 356766, 16, 287, 1, 243, 112, 0, 3, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 113, 113, 356766, 16, 287, 1, 243, 113, -60, 3, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 72, 72, 100294, 16, 1023, 1, 938, 72, 0, 4, 224, 0, 19, 0, 0, 31, 0, 15, 0, 0, 73, 73, 100294, 16, 1023, 1, 938, 73, 0, 4, 224, 0, 16, 0, 0, 31, 0, 15, 0, 0, 74, 74, 100294, 16, 1023, 1, 938, 74, 0, 4, 224, 0, 16, 0, 0, 31, 0, 15, 0, 0, 75, 75, 100294, 16, 1023, 1, 938, 75, 0, 4, 224, 0, 16, 0, 0, 31, 0, 15, 0, 0, 76, 76, 100294, 16, 1023, 1, 938, 76, 0, 4, 224, 0, 16, 0, 0, 31, 0, 15, 0, 0, 77, 77, 100294, 16, 1023, 1, 938, 77, -60, 4, 224, 0, 21, 0, 0, 31, 0, 15, 0, 0, 85, 127, 374048, 16, 3644, 1, 0, 120, 0, 14, 224, 0, 21, 0, 0, 31, 0, 15, 0, 0, 0, 36, 244808, 8, 21282, 1, 15812, 12, 0, 33, 224, 0, 31, 0, 0, 31, 0, 14, 0, 0, 48, 84, 366126, 16, 3960, 1, 587, 96, 0, 1, 224, 0, 28, 0, 0, 31, 0, 15, 0, 0, 0, 36, 189248, 8, 19123, 1, 3067, 108, 0, 19, 224, 0, 6, 0, 12, 31, 0, 15, 1, 0, 91, 127, 333766, 8, 3912, 1, 0, 72, 0, 17, 224, 0, 6, 0, 12, 31, 0, 15, 1, 0, 48, 84, 98982, 16, 655, 3, 485, 72, 0, 1, 224, 0, 6, 0, 12, 31, 0, 15, 1, 0, 0, 36, 337680, 8, 7471, 3, 0, 60, 0, 23, 224, 0, 5, 0, 6, 31, 0, 15, 1, 0, 48, 84, 424864, 8, 4486, 3, 3167, 60, 0, 3, 224, 0, 5, 0, 6, 31, 0, 15, 1, 0, 91, 127, 374048, 16, 3644, 3, 0, 120, 0, 22, 224, 0, 10, 0, 0, 31, 0, 15, 0, 0, 91, 127, 364144, 16, 990, 1, 652, 108, 0, 2, 241, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 364144, 16, 990, 1, 652, 108, 30, 2, 225, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 304778, 8, 6799, 2, 0, 48, 0, 34, 241, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 304778, 8, 6799, 2, 0, 48, 30, 34, 225, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 163904, 16, 3123, 1, 3040, 96, 0, 28, 241, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 163904, 16, 3123, 1, 3040, 96, 20, 28, 225, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 357342, 8, 6800, 1, 0, 73, 0, 0, 224, 0, 6, 0, 7, 31, 0, 15, 1, 0, 48, 84, 277346, 16, 3469, 1, 3014, 7, 0, 31, 224, 0, 6, 0, 7, 31, 0, 15, 1, 0, 0, 36, 228622, 8, 16184, 3, 2162, 0, 0, 34, 224, 0, 6, 0, 7, 31, 0, 15, 1, 0, 91, 127, 94822, 16, 674, 1, 631, 120, 0, 11, 241, 0, 5, 0, 12, 31, 0, 15, 1, 0, 91, 127, 94822, 16, 674, 1, 631, 120, 30, 11, 225, 0, 5, 0, 12, 31, 0, 15, 1, 0, 0, 36, 228622, 8, 16184, 1, 2162, 24, 0, 24, 241, 0, 5, 0, 12, 31, 0, 15, 1, 0, 0, 36, 228622, 8, 16184, 1, 2162, 24, 30, 24, 225, 0, 5, 0, 12, 31, 0, 15, 1, 0, 48, 84, 135274, 16, 8368, 1, 497, 96, 0, 0, 241, 0, 5, 0, 12, 31, 0, 15, 1, 0, 48, 84, 135274, 16, 8368, 1, 497, 96, 30, 0, 225, 0, 5, 0, 12, 31, 0, 15, 1, 0, 91, 127, 311578, 8, 15102, 1, 0, 120, 0, 20, 241, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 311578, 8, 15102, 1, 0, 120, 30, 20, 225, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 288562, 16, 8107, 3, 1, 84, 0, 0, 241, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 288562, 16, 8107, 3, 1, 84, 30, 0, 225, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 356766, 16, 287, 3, 243, 84, 0, 24, 241, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 356766, 16, 287, 3, 243, 84, 30, 24, 225, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 244808, 8, 21282, 2, 15812, 24, 0, 28, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 228622, 8, 16184, 3, 2162, 108, 0, 0, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 208372, 8, 1808, 3, 1765, 72, 0, 23, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 244808, 8, 21282, 3, 15812, 48, 0, 29, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 228622, 8, 16184, 1, 2162, 120, 0, 0, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 52, 52, 208372, 8, 1808, 1, 1765, 60, 0, 30, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 76, 76, 102342, 16, 828, 1, 785, 96, 0, 12, 224, 0, 16, 0, 5, 31, 0, 15, 0, 0, 64, 64, 102342, 16, 828, 1, 785, 60, 0, 22, 224, 0, 16, 0, 0, 31, 0, 15, 0, 0, 16, 16, 410116, 8, 10971, 1, 0, 48, 0, 21, 224, 0, 15, 0, 4, 31, 0, 15, 0, 0, 4, 4, 410116, 8, 10971, 3, 0, 12, 0, 22, 224, 0, 31, 0, 5, 31, 0, 15, 0, 0, 100, 100, 366126, 16, 3960, 1, 587, 120, 0, 0, 224, 0, 31, 0, 6, 31, 0, 15, 0, 0, 88, 88, 366126, 16, 3960, 1, 587, 84, 0, 8, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 71, 71, 102342, 16, 828, 1, 785, 96, 0, 15, 224, 0, 21, 0, 0, 31, 0, 15, 0, 0, 83, 83, 102342, 16, 828, 1, 785, 84, 0, 18, 224, 0, 21, 0, 0, 31, 0, 15, 0, 0, 20, 20, 410116, 8, 10971, 1, 0, 48, 0, 21, 224, 0, 31, 0, 5, 31, 0, 15, 0, 0, 32, 32, 410116, 8, 10971, 1, 0, 36, 0, 23, 224, 0, 14, 0, 0, 31, 0, 15, 0, 0, 92, 92, 366126, 16, 3960, 1, 587, 120, 0, 1, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 104, 104, 366126, 16, 3960, 1, 587, 108, 0, 4, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 23, 410116, 8, 10971, 2, 0, 24, 0, 0, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 179602, 8, 9645, 3, 4148, 60, 0, 25, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 391550, 16, 3344, 3, 3301, 72, 0, 6, 224, 0, 11, 0, 0, 27, 0, 15, 0, 0, 84, 127, 210182, 8, 10426, 1, 2464, 108, 0, 0, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 228622, 8, 16184, 1, 2162, 0, 0, 32, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 83, 128376, 16, 1121, 1, 1035, 72, 0, 15, 224, 0, 25, 0, 0, 31, 0, 13, 0, 0, 71, 127, 179602, 8, 9645, 1, 4148, 108, 0, 10, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 228622, 8, 16184, 1, 2162, 24, 0, 0, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 70, 126784, 16, 795, 1, 682, 55, 0, 16, 224, 0, 25, 0, 0, 31, 0, 15, 0, 0, 0, 36, 135274, 16, 8368, 1, 497, 12, 0, 35, 224, 0, 25, 0, 0, 31, 0, 15, 0, 0, 48, 71, 100294, 16, 1023, 1, 938, 72, 0, 2, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 84, 127, 220610, 8, 8010, 1, 2138, 96, 0, 12, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 84, 127, 98982, 16, 655, 1, 485, 108, 0, 7, 224, 0, 31, 0, 17, 31, 0, 15, 0, 0, 0, 36, 100294, 16, 1023, 1, 938, 0, 0, 27, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 277346, 16, 3469, 1, 3014, 55, 0, 0, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 277346, 16, 3469, 1, 3014, 66, 0, 0, 224, 0, 31, 0, 10, 31, 0, 15, 0, 0, 0, 36, 98982, 16, 655, 1, 485, 12, 0, 5, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 284286, 16, 2137, 1, 1970, 110, 0, 10, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 84, 127, 94822, 16, 674, 1, 631, 96, 0, 8, 224, 0, 25, 0, 0, 31, 0, 15, 0, 0, 0, 36, 333766, 8, 3912, 3, 0, 24, 0, 12, 224, 0, 27, 0, 0, 31, 0, 15, 0, 0, 48, 84, 356766, 16, 287, 1, 243, 72, 0, 1, 224, 0, 25, 0, 0, 31, 0, 15, 0, 0, 91, 127, 98982, 16, 655, 1, 485, 72, 0, 4, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 356766, 16, 287, 1, 243, 72, 0, 1, 224, 0, 25, 0, 0, 31, 0, 15, 0, 0, 0, 36, 333766, 8, 3912, 1, 0, 12, 0, 12, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 96172, 16, 1404, 1, 1347, 115, 0, 5, 224, 0, 31, 0, 14, 31, 0, 15, 0, 0, 0, 48, 410116, 8, 10971, 1, 0, 24, 0, 0, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 502736, 16, 1450, 1, 1365, 72, 0, 2, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 366126, 16, 3960, 1, 587, 36, 0, 18, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 56, 56, 152656, 16, 1756, 1, 1643, 60, 0, 0, 224, 0, 18, 0, 0, 31, 0, 15, 0, 0, 68, 68, 152656, 16, 1756, 1, 1643, 84, 0, 5, 224, 0, 18, 0, 0, 31, 0, 15, 0, 0, 91, 127, 348062, 16, 541, 1, 498, 120, 0, 20, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 94822, 16, 674, 1, 631, 96, 0, 16, 224, 0, 23, 0, 0, 31, 0, 15, 0, 0, 48, 84, 128376, 16, 1121, 1, 1035, 72, 0, 0, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 47, 424864, 8, 4486, 1, 3167, 0, 0, 17, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 97, 127, 266092, 8, 11252, 2, 110, 120, 0, 5, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 96, 96, 266092, 8, 11252, 2, 110, 108, 0, 5, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 12, 12, 304778, 8, 6799, 2, 0, 48, 0, 1, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 12, 12, 304778, 8, 6799, 2, 0, 43, 0, 0, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 13, 36, 304778, 8, 6799, 2, 0, 48, 0, 27, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 337680, 8, 7471, 1, 0, 84, 0, 10, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 357342, 8, 6800, 3, 0, 48, 0, 0, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 337680, 8, 7471, 3, 0, 120, 0, 3, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 374048, 16, 3644, 1, 0, 36, 0, 13, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 82, 127, 74846, 16, 1, 0, 0, 60, 0, 14, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 94822, 16, 674, 1, 631, 72, 0, 0, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 244808, 8, 21282, 2, 15812, 127, 0, 21, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 91, 127, 333766, 8, 3912, 1, 0, 96, 0, 18, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 48, 84, 333766, 8, 3912, 1, 0, 72, 0, 1, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 179602, 8, 9645, 1, 4148, 0, 0, 20, 224, 0, 31, 0, 0, 31, 0, 15, 0, 0, 0, 36, 266092, 8, 11252, 2, 110, 24, 0, 0, 224, 0, 31, 0, 6, 17, 0, 15, 0, 0, 45, 59, 337680, 8, 7471, 3, 0, 72, 0, 9, 224, 0, 31, 0, 6, 17, 0, 15, 0, 0, 91, 127, 266092, 8, 11252, 1, 110, 120, 0, 0, 224, 0, 31, 0, 6, 17, 0, 15, 0, 0, 69, 81, 326682, 16, 3541, 3, 0, 84, 0, 9, 224, 0, 31, 0, 8, 18, 0, 15, 0, 0, 62, 64, 135274, 16, 8368, 1, 497, 72, 0, 15, 224, 0, 31, 0, 6, 17, 0, 15, 0, 0, 11, 44, 266092, 8, 11252, 2, 110, 36, 0, 0, 243, 0, 31, 0, 6, 14, 0, 15, 0, 0, 46, 80, 266092, 8, 11252, 2, 110, 72, 0, 0, 240, 0, 31, 0, 6, 14, 0, 15, 0, 0, 83, 116, 266092, 8, 11252, 2, 110, 108, 0, 0, 227, 0, 31, 0, 6, 14, 0, 15, 0, 0, 0, 40, 337680, 8, 7471, 3, 0, 48, 0, 0, 243, 0, 31, 0, 6, 14, 0, 15, 0, 0, 48, 84, 337680, 8, 7471, 2, 0, 96, 0, 33, 240, 0, 31, 0, 6, 16, 0, 15, 0, 0, 92, 127, 337680, 8, 7471, 3, 0, 120, 0, 0, 227, 0, 31, 0, 6, 14, 0, 15, 0, 0, 11, 44, 266092, 8, 11252, 1, 110, 36, 0, 0, 243, 0, 31, 0, 6, 14, 0, 15, 0, 0, 47, 80, 266092, 8, 11252, 1, 110, 72, 0, 0, 240, 0, 31, 0, 6, 14, 0, 15, 0, 0, 83, 116, 266092, 8, 11252, 1, 110, 108, 0, 0, 227, 0, 31, 0, 6, 14, 0, 15, 0, 0, 0, 127, 208372, 8, 1808, 1, 1765, 84, 0, 0, 243, 0, 31, 2, 2, 23, 5, 2, 0, 0, 0, 127, 208372, 8, 1808, 1, 1765, 84, 10, 0, 227, 0, 31, 2, 2, 23, 5, 2, 0, 0, 0, 127, 152480, 16, 43, 1, 0, 84, 0, 0, 224, 0, 25, 7, 7, 23, 5, 2, 0, 0, 0, 127, 98982, 16, 655, 1, 485, 84, 18, 0, 255, 0, 31, 10, 10, 19, 5, 2, 0, 0, 0, 127, 98982, 16, 655, 1, 485, 84, 38, 0, 239, 0, 31, 10, 10, 19, 5, 2, 0, 0, 0, 127, 345152, 16, 1454, 1, 1115, 84, 18, 0, 224, 0, 31, 6, 6, 23, 5, 2, 0, 0, 0, 127, 311578, 8, 15102, 1, 0, 42, 0, 0, 242, 0, 31, 0, 20, 23, 0, 15, 0, 0];

// packages/shmup-engine/src/audio/tone-bank.js
var SCSP_BASE_RATE = 14848;
var INSTRUMENT_COUNT = TONE_INSTRUMENTS.length / INSTRUMENT_FIELDS;
var LAYER_COUNT = TONE_LAYERS.length / LAYER_FIELDS;
var LOOP_OFF = 0;
var LOOP_FORWARD = 1;
var LOOP_REVERSE = 2;
var LOOP_ALTERNATE = 3;
function field(index, key) {
  return TONE_LAYERS[index * LAYER_FIELDS + key];
}
function layerAt(index) {
  if (!(index >= 0 && index < LAYER_COUNT)) return null;
  return {
    index,
    noteLo: field(index, LAYER.NOTE_LO),
    noteHi: field(index, LAYER.NOTE_HI),
    offset: field(index, LAYER.OFFSET),
    format: field(index, LAYER.FORMAT),
    lengthSamples: field(index, LAYER.LENGTH_SAMPLES),
    loopMode: field(index, LAYER.LOOP_MODE),
    loopStart: field(index, LAYER.LOOP_START),
    rootPitch: field(index, LAYER.ROOT_PITCH),
    fineTune: field(index, LAYER.FINE_TUNE),
    level: field(index, LAYER.LEVEL),
    pan: field(index, LAYER.PAN),
    velCurve: field(index, LAYER.VEL_CURVE),
    eg: {
      AR: field(index, LAYER.EG_AR),
      D1R: field(index, LAYER.EG_D1R),
      D2R: field(index, LAYER.EG_D2R),
      RR: field(index, LAYER.EG_RR),
      DL: field(index, LAYER.EG_DL),
      KRS: field(index, LAYER.EG_KRS),
      EGHOLD: field(index, LAYER.EG_EGHOLD),
      LPSLNK: field(index, LAYER.EG_LPSLNK)
    }
  };
}
function instrumentAt(instrument) {
  const i = instrument | 0;
  if (!(i >= 0 && i < INSTRUMENT_COUNT)) return null;
  const base = i * INSTRUMENT_FIELDS;
  return {
    instrument: i,
    flags: TONE_INSTRUMENTS[base + INSTRUMENT.FLAGS],
    volAdj: TONE_INSTRUMENTS[base + INSTRUMENT.VOL_ADJ],
    firstLayer: TONE_INSTRUMENTS[base + INSTRUMENT.FIRST_LAYER],
    layerCount: TONE_INSTRUMENTS[base + INSTRUMENT.LAYER_COUNT]
  };
}
function pickLayers(instrument, note) {
  const inst = instrumentAt(instrument);
  if (!inst || !inst.layerCount) return [];
  const hits = [];
  for (let k = 0; k < inst.layerCount; k++) {
    const index = inst.firstLayer + k;
    if (note >= field(index, LAYER.NOTE_LO) && note <= field(index, LAYER.NOTE_HI)) {
      hits.push(layerAt(index));
    }
  }
  return hits.length ? hits : [layerAt(inst.firstLayer)];
}
function playbackRate(layer, note, transpose = 0) {
  const semis = note - layer.rootPitch + layer.fineTune / 256 + transpose;
  return Math.pow(2, semis / 12);
}
function levelGain(level) {
  return Math.pow(10, -level * 0.375 / 20);
}
function panPosition(pan) {
  const side = pan & 15;
  return (pan & 16 ? -side : side) / 15;
}
function readPcm(sndpac, layer) {
  const { offset, format, lengthSamples } = layer;
  const bytes = format === 16 ? lengthSamples * 2 : lengthSamples;
  if (offset < 0 || offset + bytes > sndpac.length) return null;
  const out = new Int16Array(lengthSamples);
  if (format === 16) {
    for (let i = 0; i < lengthSamples; i++) {
      const at = offset + i * 2;
      out[i] = sndpac[at] << 8 | sndpac[at + 1];
    }
  } else {
    for (let i = 0; i < lengthSamples; i++) {
      out[i] = (sndpac[offset + i] << 24 >> 24) * 256;
    }
  }
  return out;
}
function cutLayer(sndpac, layer) {
  const raw = readPcm(sndpac, layer);
  if (!raw) return null;
  const len = layer.lengthSamples;
  const mode = layer.loopMode;
  const start = Math.min(Math.max(layer.loopStart | 0, 0), len);
  let pcm = raw;
  let loopStart = start;
  if (mode === LOOP_REVERSE) {
    pcm = Int16Array.from(raw);
    for (let a = start, b = len - 1; a < b; a++, b--) {
      const t = pcm[a];
      pcm[a] = pcm[b];
      pcm[b] = t;
    }
  } else if (mode === LOOP_ALTERNATE && len - start >= 3) {
    const mirror = len - start - 2;
    pcm = new Int16Array(len + mirror);
    pcm.set(raw, 0);
    for (let i = 0; i < mirror; i++) pcm[len + i] = raw[len - 2 - i];
  }
  return {
    pcm,
    sampleRate: SCSP_BASE_RATE,
    loop: mode !== LOOP_OFF,
    loopStart: mode === LOOP_OFF ? 0 : loopStart,
    loopEnd: pcm.length,
    loopMode: mode,
    rootPitch: layer.rootPitch,
    fineTune: layer.fineTune,
    level: layer.level,
    pan: layer.pan,
    velCurve: layer.velCurve,
    eg: layer.eg
  };
}
function toFloat32(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}
function uniqueSlices() {
  const byKey = /* @__PURE__ */ new Map();
  for (let index = 0; index < LAYER_COUNT; index++) {
    const l = layerAt(index);
    const key = `${l.offset}:${l.lengthSamples}:${l.format}:${l.loopMode}:${l.loopStart}`;
    let slice = byKey.get(key);
    if (!slice) {
      slice = {
        key,
        layerIndexes: [],
        offset: l.offset,
        format: l.format,
        lengthSamples: l.lengthSamples,
        loopMode: l.loopMode,
        loopStart: l.loopStart
      };
      byKey.set(key, slice);
    }
    slice.layerIndexes.push(index);
  }
  return [...byKey.values()];
}

// packages/shmup-engine/src/cd/iso9660-read.js
var GEOMETRIES = [
  [2048, 0],
  //  cooked .iso / .img
  [2352, 16],
  // MODE1/2352 raw rip (the common CD-ROM .bin)
  [2352, 24],
  // MODE2/2352 form 1
  [2336, 8],
  //  MODE2/2336
  [2448, 16]
  // MODE1/2352 + 96 bytes of subchannel
];
var PVD_LBA = 16;
var USER_SIZE = 2048;
var STANDARD_ID = [67, 68, 48, 48, 49];
function hasVolumeDescriptor(bytes, sectorSize, dataOffset) {
  const at = PVD_LBA * sectorSize + dataOffset;
  if (at + USER_SIZE > bytes.length) return false;
  for (let i = 0; i < STANDARD_ID.length; i++) {
    if (bytes[at + 1 + i] !== STANDARD_ID[i]) return false;
  }
  return bytes[at] === 1;
}
function openDisc(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer ?? bytes);
  for (const [sectorSize, dataOffset] of GEOMETRIES) {
    if (hasVolumeDescriptor(u8, sectorSize, dataOffset)) {
      return { bytes: u8, sectorSize, dataOffset };
    }
  }
  return null;
}
function sector(disc, lba) {
  const at = lba * disc.sectorSize + disc.dataOffset;
  return disc.bytes.subarray(at, at + USER_SIZE);
}
function readExtent(disc, lba, size) {
  const out = new Uint8Array(size);
  let written = 0;
  for (let i = 0; written < size; i++) {
    const chunk = sector(disc, lba + i);
    if (!chunk.length) break;
    const take = Math.min(USER_SIZE, size - written);
    out.set(chunk.subarray(0, take), written);
    written += take;
  }
  return written === size ? out : out.subarray(0, written);
}
function u32le(bytes, at) {
  return (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;
}
function parseDirectory(data) {
  const entries = [];
  let off = 0;
  while (off < data.length) {
    const len = data[off];
    if (len === 0) {
      off = (Math.floor(off / USER_SIZE) + 1) * USER_SIZE;
      if (off >= data.length) break;
      continue;
    }
    const nameLen = data[off + 32];
    const raw = data.subarray(off + 33, off + 33 + nameLen);
    let name = "";
    for (let i = 0; i < raw.length; i++) name += String.fromCharCode(raw[i]);
    if (nameLen !== 1 || raw[0] !== 0 && raw[0] !== 1) {
      entries.push({
        name,
        lba: u32le(data, off + 2),
        size: u32le(data, off + 10),
        isDir: (data[off + 25] & 2) !== 0
      });
    }
    off += len;
  }
  return entries;
}
function rootRecord(disc) {
  const pvd = sector(disc, PVD_LBA);
  return { lba: u32le(pvd, 156 + 2), size: u32le(pvd, 156 + 10) };
}
function listFiles(disc, dir) {
  const at = dir ?? rootRecord(disc);
  return parseDirectory(readExtent(disc, at.lba, at.size));
}
function sameName(entry, want) {
  const bare = entry.name.split(";")[0];
  return bare.toUpperCase() === want.toUpperCase();
}
function findEntry(disc, path) {
  const parts = String(path).split("/").filter(Boolean);
  let dir = rootRecord(disc);
  for (let i = 0; i < parts.length; i++) {
    const hit = listFiles(disc, dir).find((e) => sameName(e, parts[i]));
    if (!hit) return null;
    if (i === parts.length - 1) return hit;
    if (!hit.isDir) return null;
    dir = hit;
  }
  return null;
}
function readFile(disc, path) {
  const entry = findEntry(disc, path);
  if (!entry || entry.isDir) return null;
  return readExtent(disc, entry.lba, entry.size);
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
  COLOR_SETS,
  DUKE_PLAYER,
  ENEMY_BULLET_SPEED,
  ENGINE_SHOT_DAMAGE,
  ENTRY_FLAG,
  EVIL_INVADERS_PLAYER,
  FAMILY_FILE_RANGES,
  FAMILY_MESH_COUNTS,
  FAMILY_OFFSETS,
  FRAMES_PER_SOURCE_ROW,
  GRID_COLS,
  INSTRUMENT_COUNT,
  LAYER_COUNT,
  LIBRARY_MESH_COUNT,
  LIGHT_AZIMUTH,
  LIGHT_TILT,
  LIGHT_VIEW,
  LOOP_ALTERNATE,
  LOOP_FORWARD,
  LOOP_OFF,
  LOOP_REVERSE,
  MAGIC,
  MAX_STAGES2 as MAX_STAGES,
  MAX_SWATCH_COLORS,
  MDLDT_BASE,
  MDLDT_FILE_COUNT,
  MODEL_SLOTS,
  MODEL_UNIT_RADIUS,
  NEAR,
  PLAYER_SHOT_DAMAGE_BY_LEVEL,
  ROTATION_ORDER,
  ROTATION_QUANTUM,
  ROT_ORDERS,
  SCSP_BASE_RATE,
  SEC7_MAGIC,
  SECTION_COUNT,
  SECTION_HINTS,
  SECTION_SIZES,
  SHADE_FLOOR,
  SHADE_LEVELS,
  SHADE_ZERO,
  SHAPE_FAMILIES,
  SINGLE_LETTER_ENEMIES,
  SWATCH_LAYOUT,
  TABLE_SIZE,
  TROOPER_PLAYER,
  allocFrame,
  buildBlankGame,
  buildMeshLibrary,
  buildModelMesh,
  buildSwatchTable,
  bupDateToDate,
  byteSum,
  coalesceDiffRanges,
  composeTransform,
  cutLayer,
  decodeMdldt,
  decodeModels,
  decodePlayer2Art,
  decodePlayerArt,
  decodeSave,
  decompress,
  decompressCmp,
  deinterleave,
  detect,
  detectPartitions,
  emptyWave,
  enemyLetters,
  extractPayload,
  familyForFile,
  familyOfLibraryIndex,
  findEntries,
  findEntry,
  gunzip,
  instrumentAt,
  isGameSave,
  isGzip,
  layerAt,
  levelGain,
  libraryIndex,
  listFiles,
  makeMesh,
  mapSaveToGame,
  mdldtFileFor,
  mdldtFileName,
  meshBounds,
  meshFor,
  meshLibraryFromJson,
  modelStats,
  normalMatrix,
  normalize,
  openDisc,
  orbitCamera,
  packMesh2D,
  packShelf,
  panPosition,
  parse,
  parseEntry,
  parseSectionTable,
  pickLayers,
  placeholderLibrary,
  placeholderMesh,
  playbackRate,
  polygonNormals,
  projectModel,
  quantizeRotation,
  readExtent,
  readFile,
  rgb555ToHex,
  rgb555ToRgb,
  saturnLightView,
  serializeMeshLibrary,
  shadeRgb555,
  shadeRow,
  swatchCell,
  swatchCellRect,
  swatchRgb,
  swatchUV,
  tintRgb555,
  toFloat32,
  totalDiffBytes,
  transformPoint,
  uniqueSlices,
  validateGameJson,
  validateSectionTable,
  wireframeSegments
};
