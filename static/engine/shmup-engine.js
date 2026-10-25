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
function makeStream(data, base, blockSize2, entryOff, chain) {
  let seg2 = -1;
  let pos = entryOff + 34;
  let segEnd = entryOff + blockSize2;
  return {
    readByte() {
      while (pos >= segEnd) {
        seg2++;
        if (seg2 >= chain.length) {
          throw new Error("save data stream exhausted before datasize bytes were read");
        }
        const n = chain[seg2];
        pos = base + n * blockSize2 + 4;
        segEnd = base + (n + 1) * blockSize2;
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
  const { base, blockSize: blockSize2 } = partition;
  const chain = [];
  const stream = makeStream(data, base, blockSize2, entry.offset, chain);
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
var FACTOR_TABLE = [
  0,
  4,
  8,
  12,
  16,
  24,
  32,
  48,
  64,
  // the nine authored factors
  0,
  0,
  16,
  0,
  32,
  0,
  64
  // the pad byte, then FACTOR_STEP_TABLE's bytes
];
var ROTATION_TABLE = [0, 32, 64, 96, 128, 160, 192, 224];
var DIRECTION_TABLE = [
  0,
  16,
  32,
  48,
  64,
  80,
  96,
  112,
  128,
  // the nine authored headings
  0,
  0,
  128,
  1,
  0,
  2,
  0
  // pad, then DIRECTION_STEP_TABLE's bytes
];
var APPEARANCE_NOFIRE_HEX = "0000000000ffff00000000ff000000ffff000000ff0000000000000000000000";
function appearanceFires(appearance) {
  const byte = parseInt(
    APPEARANCE_NOFIRE_HEX.slice((appearance >> 3) * 2, (appearance >> 3) * 2 + 2),
    16
  );
  return (byte & 1 << (appearance & 7)) === 0;
}
var BIG_SHOT_BANDS = Object.freeze([
  { base: 67, frames: 4, mask: 15 },
  { base: 131, frames: 4, mask: 15 },
  { base: 163, frames: 4, mask: 15 },
  { base: 195, frames: 4, mask: 15 },
  { base: 259, frames: 2, mask: 3 },
  { base: 267, frames: 2, mask: 3 },
  { base: 275, frames: 1, mask: 3 }
]);
var BIG_SHOT_TYPE = 3;
function decodeBigShot(b5) {
  const band = (b5 >> 4 & 7) % BIG_SHOT_BANDS.length;
  const spec = BIG_SHOT_BANDS[band];
  const index = b5 & spec.mask;
  return { band, index, character: spec.base + index * spec.frames, frames: spec.frames };
}
var SPECIAL_FIRE_PATTERNS = { 10: 0, 11: 1, 12: 2 };
var BULLET_STEERING = Object.freeze({ KINK: 19, SPLIT: 17, SPLIT_AIMED: 18 });
function bulletSteering(geometry, aimed) {
  if (geometry === 8) return BULLET_STEERING.KINK;
  if (geometry === 9) return aimed ? BULLET_STEERING.SPLIT_AIMED : BULLET_STEERING.SPLIT;
  return null;
}
var FACTOR_STEP_TABLE = [16, 32, 64, 128, 256, 384, 512, 1024];
var ROTATION_STEP_TABLE = [16, 32, 64, 128, 256, 512, 1024, 2048];
var DIRECTION_STEP_TABLE = [128, 256, 512, 768, 1024, 1536, 2048, 32767];
var clampIndex = (v, table) => table[Math.min(v, table.length - 1)];
var CHANNEL_REPEAT = Object.freeze(["hold", "pingpong", "loop", "special"]);
function sweepUnits(from, to, negative) {
  return negative ? from - to & 255 : to - from & 255;
}
function channel(a, b, c, { enabled, table, stepTable, angle, bits3, negative, fullCircle }) {
  const rawFrom = bits3 ? b & 7 : b & 15;
  const rawTo = bits3 ? b >> 4 & 7 : b >> 4 & 15;
  const from = table[rawFrom];
  const to = fullCircle && table[rawTo] === from ? negative ? from + 1 & 255 : from - 1 & 255 : table[rawTo];
  const down = negative === void 0 ? from > to : negative;
  const step = stepTable[a >> 4 & 7] / 256;
  const scale = angle ? 360 / 256 : 1 / 16;
  const repeat = c >> 4 & 3;
  return {
    enabled,
    from: from * scale,
    to: to * scale,
    sweep: (step === 0 ? 0 : sweepUnits(from, to, down)) * scale,
    step: (down ? -step : step) * scale,
    repeat,
    repeatName: CHANNEL_REPEAT[repeat],
    trigger: c & 7
  };
}
var SCALE_AXES = ["", "xy", "x", "y"];
var ROTATION_MODE = ["off", "cw", "ccw", "home", "track"];
function decodeRotationChannel(b, mode) {
  const ch = channel(b[9], b[10], b[11], {
    enabled: mode !== 0,
    table: ROTATION_TABLE,
    stepTable: ROTATION_STEP_TABLE,
    angle: true,
    bits3: true,
    negative: mode === 2,
    fullCircle: true
  });
  if (mode < 3) return ch;
  return {
    ...ch,
    repeat: mode,
    repeatName: ROTATION_MODE[mode],
    // the authored bits, kept for anyone diffing records
    authoredRepeat: ch.repeat
  };
}
var CHANNEL_TRIGGER_FIELDS = Object.freeze({
  scale: 1,
  rotation: 4,
  zoom: 7,
  direction: 10
});
function normalizeChannelTrigger(mode, ground) {
  mode &= 7;
  if (!ground) return mode;
  return mode === 0 ? 4 : mode === 4 ? 0 : mode;
}
function packChannelTriggers(bytes, ground) {
  const b = bytes;
  const g = ground === void 0 ? (b[1] & 128) !== 0 : !!ground;
  return normalizeChannelTrigger(b[14], g) << CHANNEL_TRIGGER_FIELDS.scale | normalizeChannelTrigger(b[11], g) << CHANNEL_TRIGGER_FIELDS.rotation | normalizeChannelTrigger(b[8], g) << CHANNEL_TRIGGER_FIELDS.zoom | normalizeChannelTrigger(b[17], g) << CHANNEL_TRIGGER_FIELDS.direction;
}
var CHANNEL_TRIGGER_BASE_PX = Object.freeze([0, 62, 112, 164]);
var CHANNEL_TRIGGER_BASE_PX_H = Object.freeze([0, 14, 48, 116]);
var CHANNEL_TRIGGER_BAND_OFFSET = Object.freeze([-16, -16, -8, -8, -8, 8, 8, 0]);
var CHANNEL_TRIGGER_BAND_OFFSET_H = Object.freeze([-16, -8, -16, -8, 8, -8, 8, 0]);
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
      // Bullet type 3 is a different weapon entirely, and the two gates
      // that make it so are at 0x0607D828 and 0x0607D89A: both compare
      // the spawn-cached b4 & 3 against 2 and, when it is greater, jump
      // past the "low nibble 0 = never fires" early-out AND past the
      // whole 16-way geometry dispatcher. The shooter's own jump table
      // (0x0607CFE4) sends it to 0x0607D0AE, which spawns ONE object of
      // class 99 out of the enemy art. So for this type byte 5 is art,
      // there is no aim bit, the reload is deterministic (no random
      // window, and it ticks every serviced frame rather than on the
      // fire pulse), and a low nibble of 0 does not silence anything.
      bigShot: (b[4] & 3) === BIG_SHOT_TYPE ? decodeBigShot(b[5]) : null,
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
      // 8 and 9 additionally stamp a STEERING STATE on what they fire:
      // 8's fan flies 64 px and then snaps parallel to the volley's
      // centre, and 9's single shot bursts into five after 64 px (96 px
      // and re-aimed when the aim bit is set). Neither one homes — see
      // bulletSteering() above.
      // Bit 4 (0x10) aims the volley at the player (re-aimed every
      // shot); otherwise shots leave along the enemy's facing.
      geometry: (b[4] & 3) === BIG_SHOT_TYPE ? null : b[5] & 15,
      aimed: (b[4] & 3) === BIG_SHOT_TYPE ? false : (b[5] & 16) !== 0,
      pattern: (b[4] & 3) === BIG_SHOT_TYPE ? null : SPECIAL_FIRE_PATTERNS[b[5] & 15] ?? null,
      direction: (b[4] & 3) === BIG_SHOT_TYPE ? 0 : SPECIAL_FIRE_PATTERNS[b[5] & 15] !== void 0 ? 0 : b[5] & 31,
      directionEx: b[5] >> 5 & 7,
      // Which steering state this geometry's shots carry, if any.
      steering: (b[4] & 3) === BIG_SHOT_TYPE ? null : bulletSteering(b[5] & 15, (b[5] & 16) !== 0)
    },
    death: decodeDeathWord(b),
    zoom: channel(b[6], b[7], b[8], {
      enabled: (b[6] & 1) !== 0,
      table: FACTOR_TABLE,
      stepTable: FACTOR_STEP_TABLE,
      angle: false
    }),
    rotation: {
      ...decodeRotationChannel(b, rotationMode),
      mode: rotationMode
    },
    scale: {
      ...channel(b[12], b[13], b[14], {
        enabled: scaleMode !== 0,
        table: FACTOR_TABLE,
        stepTable: FACTOR_STEP_TABLE,
        angle: false
      }),
      // The mode really does pick axes, exactly as the editor's
      // XY / X / Y list says. One ramp, armed onto one or both
      // registers (see SCALE_AXES).
      axes: SCALE_AXES[scaleMode],
      mode: scaleMode
    },
    direction: channel(b[15], b[16], b[17], {
      enabled: (b[15] & 1) !== 0,
      table: DIRECTION_TABLE,
      stepTable: DIRECTION_STEP_TABLE,
      angle: true
    }),
    // The four channels' triggers as the spawn packs them into the
    // per-slot status word 0x06093C50 — four independent 3-bit fields,
    // ground swap applied (see CHANNEL_TRIGGER_FIELDS). Each channel's
    // own `trigger` above is the raw authored field.
    triggerWord: packChannelTriggers(b, (b[1] & 128) !== 0)
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
function deathDrop(enemy, itemSlots, cycle) {
  const death = enemy && enemy.behavior && enemy.behavior.death;
  if (!death || death.mode !== 1 || !death.item) return 0;
  const slot = death.item === 9 ? cycle.n++ & 7 : death.item - 1 & 7;
  const def = itemSlots && itemSlots[slot];
  return def && def.type !== void 0 ? ITEM_TYPE_DROPS[def.type] ?? 0 : ITEM_SLOT_DROPS[slot % ITEM_SLOT_DROPS.length];
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
    const cycle = { n: 0 };
    for (const o of st.placement.objects) {
      if (o.kind !== "zako") continue;
      const idx = indexOf.get(enemyPairKey(s, o.record));
      if (idx === void 0) continue;
      rowOf(o.row)[placementColumn(o.col)] = { enemy: idx, drop: deathDrop(enemies[idx], itemSlots, cycle) };
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
function isUnpainted(art2, placeholder) {
  if (placeholder === null) return false;
  return art2.frames.every((f) => f.cells.every((c) => c.empty || c.cell === placeholder));
}
function artSignature(art2) {
  return art2.frames.map((f) => f.cells.map((c) => c.empty ? "-" : `${c.cell}${c.hflip ? "h" : ""}${c.vflip ? "v" : ""}`).join(",")).join("|");
}
function extractEnemySprites(sec5, sections, palettes, enemies, stagesPlacing) {
  const sprites = [];
  const spriteKeysByEnemy = /* @__PURE__ */ new Map();
  const bySignature = /* @__PURE__ */ new Map();
  const placeholder = findPlaceholderCell(sec5).cell;
  for (const enemy of enemies) {
    const fallbacks = stagesPlacing.get(enemy.record) || [];
    const candidates = [enemy.stage, ...fallbacks.filter((s) => s !== enemy.stage)];
    let art2 = null;
    for (const stage of candidates) {
      if (stage === void 0) continue;
      const a = readEnemyFrames(sec5, stage, enemy.record);
      if (!a) continue;
      if (!isUnpainted(a, placeholder)) {
        art2 = a;
        break;
      }
      if (!art2) art2 = a;
    }
    if (!art2 || isUnpainted(art2, placeholder)) continue;
    const sig = artSignature(art2);
    const shared = bySignature.get(sig);
    if (shared) {
      spriteKeysByEnemy.set(enemy.key, shared);
      continue;
    }
    const keys = [];
    art2.frames.forEach((frame, i) => {
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
function trimRgba(img, cutoff = 1) {
  let minX = img.w, minY = img.h, maxX = -1, maxY = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.rgba[(y * img.w + x) * 4 + 3] >= cutoff) {
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
var GLOBAL_WEAPON_SLOTS = [
  { first: 48, w: 2, h: 2, role: "charge" },
  // slot 12: charge glow
  // The player weapon SHOT refs (traced 2026-09-07, GAME 0x060790C4 ->
  // 0x0606F080; FORMAT.md "Player shot sprites"): weapons 1-7 draw from refs
  // 53/54/55/57/59/61/68. The roles below only steer the placeholder art the
  // writer paints; the actual player bolt is placed by game-to-save.js
  // (PLAYER_SHOT_SLOTS) over these cells.
  { first: 52, w: 1, h: 1, role: "shot" },
  { first: 53, w: 1, h: 1, role: "shot" },
  // weapon 1 (VULCAN A) shot
  { first: 54, w: 1, h: 1, role: "shot" },
  // weapon 2 shot
  { first: 55, w: 1, h: 1, role: "shot" },
  // weapon 3 shot
  { first: 56, w: 1, h: 1, role: "shot" },
  { first: 57, w: 1, h: 2, role: "beamV" },
  // slot 18: weapon 4 shot (16x32)
  { first: 59, w: 2, h: 1, role: "beamH" },
  // slot 19: weapon 5 shot (32x16)
  { first: 61, w: 1, h: 1, role: "shot" },
  // weapon 6 shot
  { first: 62, w: 1, h: 1, role: "shot" },
  { first: 63, w: 1, h: 1, role: "shot" },
  { first: 64, w: 1, h: 1, role: "shot" },
  { first: 65, w: 1, h: 1, role: "shot" },
  { first: 66, w: 1, h: 1, role: "missile" },
  { first: 67, w: 1, h: 1, role: "shot" },
  { first: 68, w: 1, h: 1, role: "missile" },
  // slot 24: weapon 7 shot
  ...Array.from({ length: 10 }, (_, i) => ({ first: 69 + i, w: 1, h: 1, role: "option" })),
  { first: 79, w: 2, h: 2, role: "bomb" },
  // slot 38: bomb 4
  { first: 83, w: 2, h: 2, role: "bomb" },
  // slot 39
  { first: 87, w: 1, h: 1, role: "spark" },
  // slot 40: bomb 5
  { first: 88, w: 2, h: 1, role: "dome" },
  // slot 41: bomb-7 dome
  { first: 90, w: 1, h: 1, role: "spark" },
  // slot 42
  { first: 91, w: 1, h: 2, role: "missileTall" },
  // slot 43: sub-2 object
  { first: 93, w: 1, h: 1, role: "smoke" }
  // slot 44: missile smoke
];
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
      const art2 = readEnemyFrames(sec5, stage, record);
      if (!art2 || isUnpainted(art2, placeholder)) continue;
      pieces.push(art2.frames[0]);
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
    const art2 = {};
    for (const record of records) {
      const existing = byPair.get(`${boss.stage}:${record}`);
      if (existing) {
        art2[record] = existing;
        continue;
      }
      const a = readEnemyFrames(sec5, boss.stage, record);
      if (!a || isUnpainted(a, placeholder)) continue;
      const sig = artSignature(a);
      const shared = bySignature.get(sig);
      if (shared) {
        art2[record] = shared;
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
      art2[record] = keys;
    }
    if (Object.keys(art2).length) partKeysByStage.set(boss.stage, art2);
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
var PART_RESPAWN_FRAMES = [119, 59, 29, 19, 9, 5, 3, 1];
var PART_RESPAWN_FRAMES_F0 = [119, 59, 39, 19, 11, 7, 3, 1];
var s8 = (b) => b >= 128 ? b - 256 : b;
var RECORD_BAND_BASE = RECORD_ART.map((band) => band.first);
function partRecord(group, piece) {
  const base = RECORD_BAND_BASE[group];
  if (base === void 0) return null;
  return base | piece;
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
      oneShot: type === 4,
      // Where this part's hp comes from. A turret's is decided here,
      // by the rate nibble off the BOSS table; a mobile part's needs
      // the record, so it is filled in by readBossTrailer.
      hpSource: type === 4 ? "boss" : "record"
    };
    if (type === 4) fp.spawn.hp = BOSS_HP_TABLE[fp.rate] >> 2;
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
  const respawn = (t[0] & 3) === 0 ? PART_RESPAWN_FRAMES_F0 : PART_RESPAWN_FRAMES;
  for (const pattern of patterns) {
    for (const fp of pattern.firePoints) {
      if (fp.type === 3 && fp.spawn) fp.spawn.respawnFrames = respawn[fp.rate];
    }
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
var RECORDS_PER_STAGE = BOSS_TRAILER_OFFSET / ENEMY_RECORD_SIZE;
function resolvePartRecords(sec5, stage, boss) {
  const { offset, stride } = SEC5_REGIONS.enemies;
  const recordBase = offset + stage * stride;
  const cache = /* @__PURE__ */ new Map();
  const readRecord = (record) => {
    if (!Number.isInteger(record) || record < 0 || record >= RECORDS_PER_STAGE) return null;
    if (!cache.has(record)) {
      const at = recordBase + record * ENEMY_RECORD_SIZE;
      cache.set(record, decodeEnemyRecord(sec5.subarray(at, at + ENEMY_RECORD_SIZE)));
    }
    return cache.get(record);
  };
  for (const pattern of boss.patterns) {
    for (const fp of pattern.firePoints) {
      const spawn = fp.spawn;
      if (!spawn) continue;
      const rec = readRecord(spawn.record);
      if (!rec) continue;
      spawn.score = rec.score;
      spawn.armour = (rec.move.mode & 1) !== 0;
      if (spawn.hpSource === "record") spawn.hp = rec.hp;
    }
  }
}
function readBossTrailer(sec5, stage) {
  const { offset, stride } = SEC5_REGIONS.enemies;
  const base = offset + stage * stride + BOSS_TRAILER_OFFSET;
  const boss = decodeBossTrailer(sec5.subarray(base, base + BOSS_TRAILER_SIZE));
  if (boss) resolvePartRecords(sec5, stage, boss);
  return boss;
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
function sizePartHp(boss, shotDamage) {
  for (const pattern of boss.patterns || []) {
    for (const fp of pattern.firePoints || []) {
      const spawn = fp.spawn;
      if (!spawn) continue;
      if (spawn.armour) {
        spawn.hp = "infinity";
      } else if (Number.isFinite(spawn.hp)) {
        spawn.hp = Math.max(1, Math.ceil(spawn.hp / (shotDamage * 256)));
      }
    }
  }
}
function setPartSpgage(boss, defaults) {
  const zako = defaults && defaults.starterEnemy ? defaults.starterEnemy.spgage : void 0;
  const spgage = Number.isFinite(zako) ? zako : BUILTIN_DEFAULTS.starterEnemy.spgage;
  for (const pattern of boss.patterns || []) {
    for (const fp of pattern.firePoints || []) {
      if (fp.spawn) fp.spawn.spgage = spgage;
    }
  }
}
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
        rec.dezaemon.boss = clone(decodedBoss.behavior);
        rec.hp = Math.max(1, Math.ceil(decodedBoss.behavior.hp / (shotDamage * 256)));
        rec.score = decodedBoss.behavior.score;
        sizePartHp(rec.dezaemon.boss, shotDamage);
        setPartSpgage(rec.dezaemon.boss, defaults);
      } else {
        rec.hp = Math.max(1, Math.ceil(BOSS_HP_TABLE[0] / (shotDamage * 256)));
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
  if (decoded.models && decoded.models.models && decoded.models.models.length) {
    gameJson.dezaemonModels = clone(decoded.models.models);
  }
  if (decoded.settings && decoded.settings.itemSlots) {
    gameJson.dezaemonItems = {
      score: decoded.settings.scoreItemValue,
      slots: clone(decoded.settings.itemSlots)
    };
  }
  if (decoded.globalArt) {
    const art2 = decoded.globalArt;
    const keysOf = (indices) => (indices || []).map((i) => i != null ? spriteKeyByIndex[i] : null);
    if (art2.player && art2.player.idle) {
      const idle = keysOf(art2.player.idle).filter(Boolean);
      if (idle.length) {
        gameJson.playerData.texture = idle;
        gameJson.playerData.name = "dezaShip";
      }
    }
    if (art2.player2 && art2.player2.idle) {
      const idle2 = keysOf(art2.player2.idle).filter(Boolean);
      if (idle2.length) {
        gameJson.playerData2 = { name: "dezaShip2", texture: idle2 };
      }
    }
    if (gameJson.dezaemonBullets && art2.bullets) {
      gameJson.dezaemonBullets.art = art2.bullets.map((frames) => {
        const keys = keysOf(frames).filter(Boolean);
        return keys.length ? keys : null;
      });
    }
    if (gameJson.dezaemonBullets && (art2.blastA || art2.blastB)) {
      gameJson.dezaemonBullets.blastArt = {};
      if (art2.blastA) gameJson.dezaemonBullets.blastArt.a = keysOf(art2.blastA).filter(Boolean);
      if (art2.blastB) gameJson.dezaemonBullets.blastArt.b = keysOf(art2.blastB).filter(Boolean);
    }
    if (gameJson.dezaemonItems && art2.items) {
      const icons = keysOf(art2.items);
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
      // Per-stage flag bytes (+0x02..+0x0B); the runtime reads
      // `dropShadow` to draw the Saturn's zoom-offset shadow pass on
      // the stages that ask for it, and none on the stages that don't.
      stageFlags: decoded.settings.stageFlags,
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
        // Ship byte +2 under its traced name: the OPTION-pod count
        // and its cap. Same two nibbles as the pair above.
        initialOptions: sh.initialOptions,
        maxOptions: sh.maxOptions,
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
      if (isSustain(voice)) {
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
        if (steps[PITCH_OFFSET + st] !== STEP_EMPTY) soundingSteps++;
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
    // Byte +1 is the POWER stat: bits 0-2 the level the ship starts on,
    // bits 4-7 its cap. Corrected 2026-09-03 — it used to be read off byte
    // +2, which is the OPTION stat. The two pickup handlers settle it by
    // reading DIFFERENT bytes: POWER (+0x1D1A4) reads settings +0x0D / +0x11
    // and clamps to 7, OPTION (+0x1D0F4) reads +0x0E / +0x12 and clamps to
    // 4. The cap is `>> 4` over the WHOLE nibble and then clamped, so a
    // nibble of 8-15 caps at 7 rather than wrapping.
    initialPower: sec5[base + 1] & 7,
    maxPower: Math.min(7, sec5[base + 1] >> 4 & 15),
    // Byte +2 is the OPTION-POD stat, same shape. The engine seeds its
    // pod-count array from these low 3 bits at +0x92E6.
    initialOptions: sec5[base + 2] & 7,
    maxOptions: Math.min(4, sec5[base + 2] >> 4 & 15),
    // Kept because callers predate the correction, and both still hold the
    // bits they always held — only their names were wrong. There is no
    // separate speed stat to read: the ship's velocity table (+0x21A22, 64
    // bytes per level) is indexed by the POWER level at +0xABE8, so how fast
    // you fly IS your power level. `rapidParam` is byte +1's low bits, which
    // are the starting power.
    maxSpeed: sec5[base + 1] >> 4 & 7,
    rapidParam: sec5[base + 1] & 7,
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
      finalStage: (b & 128) !== 0,
      // bit5: the renderer's drop-shadow pass (FORMAT.md, settings
      // +0x02..+0x0B) — every visible object drawn a second time, a
      // mesh shadow offset by its zoom. 35 of 262 corpus saves set it
      // on stage 0 (Ramsie, DAIOH, Laire II, ...).
      dropShadow: (b & 32) !== 0
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

// packages/shmup-engine/src/cover/compose-cover.js
var COVER_W = 256;
var COVER_H = 480;
var TILE = 16;
var BG_X = 16;
var BG_SCREEN_ROWS = COVER_H / TILE;
var TITLE_BLOCK = { first: 144, w: 8, h: 11 };
var TITLE_SCALE = 2;
var TITLE_Y = 40;
var BACKDROP_DIM = 0.45;
var DARK_INK_LUMA = 40;
var DARK_INK_MAX = 0.65;
var PLATE_RGB = [176, 176, 176];
function makeCanvas(w, h, rgb = [0, 0, 0]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = rgb[0];
    px[i * 4 + 1] = rgb[1];
    px[i * 4 + 2] = rgb[2];
    px[i * 4 + 3] = 255;
  }
  return px;
}
function blit(dst, dw, dh, src, sw, sh, dx, dy, opts = {}) {
  const { scale = 1, hflip = false, vflip = false } = opts;
  for (let y = 0; y < sh * scale; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dh) continue;
    let sy = y / scale | 0;
    if (vflip) sy = sh - 1 - sy;
    for (let x = 0; x < sw * scale; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dw) continue;
      let sx = x / scale | 0;
      if (hflip) sx = sw - 1 - sx;
      const so = (sy * sw + sx) * 4;
      const a = src[so + 3];
      if (!a) continue;
      const to = (ty * dw + tx) * 4;
      if (a === 255) {
        dst[to] = src[so];
        dst[to + 1] = src[so + 1];
        dst[to + 2] = src[so + 2];
        dst[to + 3] = 255;
      } else {
        const ia = 255 - a;
        dst[to] = (src[so] * a + dst[to] * ia) / 255;
        dst[to + 1] = (src[so + 1] * a + dst[to + 1] * ia) / 255;
        dst[to + 2] = (src[so + 2] * a + dst[to + 2] * ia) / 255;
        dst[to + 3] = Math.max(dst[to + 3], a);
      }
    }
  }
}
function dim(px, f) {
  for (let i = 0; i < px.length; i += 4) {
    px[i] *= f;
    px[i + 1] *= f;
    px[i + 2] *= f;
  }
}
function readBankBlock(sec5, first, w, h) {
  const { offset } = SEC5_REGIONS.spriteBank;
  const cells = [];
  for (let i = 0; i < w * h; i++) {
    const at = offset + (first + i) * 2;
    const word = sec5[at] << 8 | sec5[at + 1];
    cells.push({
      empty: word === 65535,
      cell: word & 1023,
      hflip: (word & 16384) !== 0,
      vflip: (word & 32768) !== 0
    });
  }
  return { w, h, cells };
}
function renderTitlePage(decoded, block = TITLE_BLOCK) {
  const sec5 = decoded.sections?.[5]?.decompressed;
  const pages = decoded.sections?.slice(0, 4).map((s) => s.decompressed);
  const palettes = decoded.cg?.palettes;
  if (!sec5 || !palettes || !pages || pages.some((p) => !p)) return null;
  return renderFrame(
    pages,
    palettes,
    readBankBlock(sec5, block.first, block.w, block.h)
  );
}
function imgInk(img) {
  let minX = img.w, minY = img.h, maxX = -1, maxY = -1, n = 0, luma = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const o = (y * img.w + x) * 4;
      if (!img.rgba[o + 3]) continue;
      n++;
      luma += 0.299 * img.rgba[o] + 0.587 * img.rgba[o + 1] + 0.114 * img.rgba[o + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!n) return null;
  return { minX, minY, maxX, maxY, opaque: n, meanLuma: luma / n };
}
function pickBackdrop(bgStages) {
  let best = { stage: -1, row: 0, tiles: 0 };
  for (let s = 0; s < bgStages.length; s++) {
    const g = bgStages[s];
    if (!g) continue;
    const perRow = new Int32Array(g.rows);
    for (let r = 0; r < g.rows; r++) {
      let n = 0;
      for (let c = 0; c < g.cols; c++) {
        if (g.words[r * g.cols + c] !== 65535) n++;
      }
      perRow[r] = n;
    }
    const win = Math.min(BG_SCREEN_ROWS, g.rows);
    let sum = 0;
    for (let r = 0; r < win; r++) sum += perRow[r];
    let bestRow = 0, bestSum = sum;
    for (let r0 = 1; r0 + win <= g.rows; r0++) {
      sum += perRow[r0 + win - 1] - perRow[r0 - 1];
      if (sum > bestSum) {
        bestSum = sum;
        bestRow = r0;
      }
    }
    if (bestSum > best.tiles) best = { stage: s, row: bestRow, tiles: bestSum };
  }
  return best;
}
function drawBackdrop(canvas, decoded, stageIdx, row0 = 0) {
  const g = decoded.bgStages[stageIdx];
  if (!g) return 0;
  let drawn = 0;
  const rows = Math.min(BG_SCREEN_ROWS, g.rows - row0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const word = g.words[(row0 + r) * g.cols + c];
      if (word === 65535) continue;
      const cell = decoded.bgCells[word & 1023];
      if (!cell) continue;
      blit(
        canvas,
        COVER_W,
        COVER_H,
        cell.rgba,
        cell.w,
        cell.h,
        BG_X + c * TILE,
        (BG_SCREEN_ROWS - 1 - r) * TILE,
        { hflip: (word & 32768) !== 0, vflip: (word & 16384) !== 0 }
      );
      drawn++;
    }
  }
  return drawn;
}
function bestBossSprite(decoded) {
  let best = null, area = 0;
  for (const b of decoded.bosses || []) {
    const k = (b.spriteKeys || [])[0];
    const s = k === void 0 ? null : decoded.sprites[k];
    if (s && s.w * s.h > area) {
      area = s.w * s.h;
      best = s;
    }
  }
  return best;
}
function enemyStrip(decoded, max = 12) {
  const seen = /* @__PURE__ */ new Set(), out = [];
  for (const e of decoded.enemies || []) {
    const k = (e.spriteKeys || [])[0];
    if (k === void 0 || seen.has(k)) continue;
    const s = decoded.sprites[k];
    if (!s) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
function composeCover(decoded, opts = {}) {
  const {
    dimFactor = BACKDROP_DIM,
    titleScale = TITLE_SCALE,
    titleY = TITLE_Y,
    upscale = 1,
    backdrop = true
  } = opts;
  let canvas = makeCanvas(COVER_W, COVER_H);
  const layers2 = [];
  const pick = backdrop ? pickBackdrop(decoded.bgStages || []) : { stage: -1, row: 0, tiles: 0 };
  let bgTiles = 0;
  if (pick.stage >= 0) {
    bgTiles = drawBackdrop(canvas, decoded, pick.stage, pick.row);
    layers2.push({
      layer: "backdrop",
      stage: pick.stage,
      row: pick.row,
      tiles: bgTiles
    });
  }
  const page = renderTitlePage(decoded);
  const ink = page ? imgInk(page) : null;
  const hasTitle = !!ink;
  if (bgTiles && hasTitle) dim(canvas, dimFactor);
  if (hasTitle) {
    const pageX = Math.round(COVER_W / 2 - page.w * titleScale / 2);
    let darkInk = 0, behindDark = 0, seen = 0;
    for (let y = 0; y < page.h; y++) {
      for (let x = 0; x < page.w; x++) {
        const so = (y * page.w + x) * 4;
        if (!page.rgba[so + 3]) continue;
        const li = 0.299 * page.rgba[so] + 0.587 * page.rgba[so + 1] + 0.114 * page.rgba[so + 2];
        if (li < DARK_INK_LUMA) darkInk++;
        const tx = pageX + x * titleScale, ty = titleY + y * titleScale;
        if (tx < 0 || tx >= COVER_W || ty < 0 || ty >= COVER_H) continue;
        const to = (ty * COVER_W + tx) * 4;
        seen++;
        const lb = 0.299 * canvas[to] + 0.587 * canvas[to + 1] + 0.114 * canvas[to + 2];
        if (lb < DARK_INK_LUMA) behindDark++;
      }
    }
    const darkInkFraction = darkInk / ink.opaque;
    const darkBehindFraction = seen ? behindDark / seen : 1;
    if (darkInkFraction > DARK_INK_MAX && darkBehindFraction > 0.5) {
      const rx = pageX + ink.minX * titleScale - 4;
      const ry = titleY + ink.minY * titleScale - 4;
      const rw = (ink.maxX - ink.minX + 1) * titleScale + 8;
      const rh = (ink.maxY - ink.minY + 1) * titleScale + 8;
      for (let y = Math.max(0, ry); y < Math.min(COVER_H, ry + rh); y++) {
        for (let x = Math.max(0, rx); x < Math.min(COVER_W, rx + rw); x++) {
          const o = (y * COVER_W + x) * 4;
          canvas[o] = PLATE_RGB[0];
          canvas[o + 1] = PLATE_RGB[1];
          canvas[o + 2] = PLATE_RGB[2];
        }
      }
      layers2.push({
        layer: "plate",
        darkInkFraction: +darkInkFraction.toFixed(3),
        darkBehindFraction: +darkBehindFraction.toFixed(3),
        meanLuma: +ink.meanLuma.toFixed(1)
      });
    }
    blit(canvas, COVER_W, COVER_H, page.rgba, page.w, page.h, pageX, titleY, {
      scale: titleScale
    });
    layers2.push({
      layer: "titlePage",
      w: page.w,
      h: page.h,
      scale: titleScale,
      opaque: ink.opaque,
      meanLuma: +ink.meanLuma.toFixed(1)
    });
  } else {
    const boss = bestBossSprite(decoded);
    if (boss) {
      const k = Math.max(1, Math.min(224 / boss.w | 0, 300 / boss.h | 0));
      if (bgTiles) dim(canvas, dimFactor);
      blit(
        canvas,
        COVER_W,
        COVER_H,
        boss.rgba,
        boss.w,
        boss.h,
        Math.round(COVER_W / 2 - boss.w * k / 2),
        Math.round(190 - boss.h * k / 2),
        { scale: k }
      );
      layers2.push({
        layer: "fallback-boss",
        key: boss.key,
        w: boss.w,
        h: boss.h,
        scale: k
      });
    }
    const strip = enemyStrip(decoded);
    if (strip.length) {
      if (!boss && bgTiles) dim(canvas, dimFactor);
      const CELL = 56, PER_ROW = 4;
      const rows = Math.ceil(strip.length / PER_ROW);
      const x0 = Math.round(COVER_W / 2 - PER_ROW * CELL / 2);
      const y0 = Math.round(340 - rows * CELL / 2);
      strip.forEach((s, i) => {
        const k = Math.max(
          1,
          Math.min((CELL - 4) / s.w | 0, (CELL - 4) / s.h | 0)
        );
        blit(
          canvas,
          COVER_W,
          COVER_H,
          s.rgba,
          s.w,
          s.h,
          Math.round(x0 + i % PER_ROW * CELL + CELL / 2 - s.w * k / 2),
          Math.round(y0 + (i / PER_ROW | 0) * CELL + CELL / 2 - s.h * k / 2),
          { scale: k }
        );
      });
      layers2.push({ layer: "fallback-enemies", count: strip.length });
    }
    if (!boss && !strip.length && !bgTiles && decoded.cg?.pages?.[0]) {
      const p = decoded.cg.pages[0];
      blit(canvas, COVER_W, COVER_H, p.rgba, p.width, p.height, 64, 0);
      layers2.push({ layer: "fallback-cgpage", w: p.width, h: p.height });
    }
  }
  let w = COVER_W, h = COVER_H;
  if (upscale > 1) {
    const up = makeCanvas(COVER_W * upscale, COVER_H * upscale);
    blit(
      up,
      COVER_W * upscale,
      COVER_H * upscale,
      canvas,
      COVER_W,
      COVER_H,
      0,
      0,
      { scale: upscale }
    );
    canvas = up;
    w *= upscale;
    h *= upscale;
  }
  return {
    w,
    h,
    rgba: canvas,
    layers: layers2,
    backdropStage: pick.stage,
    backdropRow: pick.row,
    hasTitleArt: hasTitle
  };
}
function inkStats(rgba) {
  let ink = 0, lumaSum = 0, alpha = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    lumaSum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    if (rgba[i] || rgba[i + 1] || rgba[i + 2]) ink++;
    if (rgba[i + 3]) alpha++;
  }
  return {
    pixels: n,
    inkFraction: ink / n,
    alphaFraction: alpha / n,
    meanLuma: lumaSum / n
  };
}

// packages/shmup-engine/src/write/encode-model.js
var SEC7_SIZE = 4 + MODEL_SLOTS * MODEL_SLOT_SIZE + 576;
var PART_SIZE2 = 36;
var NEUTRAL_COLOR = 32767;
var S32_MIN = -2147483648;
var S32_MAX = 2147483647;
function putU16(bytes, at, v) {
  bytes[at] = v >> 8 & 255;
  bytes[at + 1] = v & 255;
}
function putS32(bytes, at, v) {
  bytes[at] = v >> 24 & 255;
  bytes[at + 1] = v >> 16 & 255;
  bytes[at + 2] = v >> 8 & 255;
  bytes[at + 3] = v & 255;
}
function fixed16(value) {
  if (!Number.isFinite(value)) return 0;
  const raw = Math.round(value * 65536);
  return raw < S32_MIN ? S32_MIN : raw > S32_MAX ? S32_MAX : raw;
}
function encodeRotation(deg) {
  if (!Number.isFinite(deg)) return 0;
  const raw = Math.round(deg * 65536 / 360);
  return (raw % 65536 + 65536) % 65536;
}
function encodeShapeWord(part) {
  if (Number.isInteger(part.shape)) return part.shape & 65535;
  const family = (part.shapeFamily | 0) & 15;
  const colorSet = (part.colorSet | 0) & 15;
  const meshIndex = (part.meshIndex | 0) & 255;
  return family << 12 | colorSet << 8 | meshIndex;
}
function encodePart(bytes, at, part) {
  const pos = part.position || {};
  const rot = part.rotation || {};
  const scale = part.scale || {};
  putU16(bytes, at, encodeShapeWord(part));
  putS32(bytes, at + 4, fixed16(pos.x));
  putS32(bytes, at + 8, fixed16(pos.y));
  putS32(bytes, at + 12, fixed16(pos.z));
  putU16(bytes, at + 16, encodeRotation(rot.x));
  putU16(bytes, at + 18, encodeRotation(rot.y));
  putU16(bytes, at + 20, encodeRotation(rot.z));
  putS32(bytes, at + 24, fixed16(scale.x === void 0 ? 1 : scale.x));
  putS32(bytes, at + 28, fixed16(scale.y === void 0 ? 1 : scale.y));
  putS32(bytes, at + 32, fixed16(scale.z === void 0 ? 1 : scale.z));
}
function encodeModels(models, { warn } = {}) {
  const bytes = new Uint8Array(SEC7_SIZE);
  const list = Array.isArray(models) ? models : models && models.models;
  if (!Array.isArray(list) || !list.length) return bytes;
  const say = typeof warn === "function" ? warn : () => {
  };
  const taken = /* @__PURE__ */ new Map();
  let written = 0;
  list.forEach((model, index) => {
    if (!model || typeof model !== "object") return;
    let slot = Number.isInteger(model.slot) ? model.slot : -1;
    if (slot < 0 || slot >= MODEL_SLOTS) {
      if (Number.isInteger(model.slot)) {
        say(`3D model ${index}: slot ${model.slot} is outside 0-${MODEL_SLOTS - 1} \u2014 skipped`);
        return;
      }
      slot = 0;
      while (slot < MODEL_SLOTS && taken.has(slot)) slot++;
      if (slot >= MODEL_SLOTS) {
        say(`3D model ${index}: no free slot among ${MODEL_SLOTS} \u2014 skipped`);
        return;
      }
    }
    const parts = Array.isArray(model.parts) ? model.parts : [];
    if (!parts.length) {
      say(`3D model ${index} (slot ${slot}): no parts \u2014 skipped`);
      return;
    }
    if (taken.has(slot)) {
      say(`3D model ${index}: slot ${slot} already holds model ${taken.get(slot)} \u2014 skipped`);
      return;
    }
    let use = parts;
    if (parts.length > MAX_PARTS) {
      say(
        `3D model ${index} (slot ${slot}): ${parts.length} parts, the format holds ${MAX_PARTS} \u2014 the rest are dropped`
      );
      use = parts.slice(0, MAX_PARTS);
    }
    taken.set(slot, index);
    const base = 4 + slot * MODEL_SLOT_SIZE;
    putU16(bytes, base, use.length);
    putU16(bytes, base + 2, Number.isInteger(model.color) ? model.color & 65535 : NEUTRAL_COLOR);
    use.forEach((part, p) => {
      if (part && typeof part === "object") {
        encodePart(bytes, base + 4 + p * PART_SIZE2, part);
      }
    });
    written++;
  });
  if (written) putS32(bytes, 0, SEC7_MAGIC | 0);
  return bytes;
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
  dualPlane,
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
  const flags = new Uint8Array(count);
  if (dualPlane) {
    for (let q = 0; q < count; q++) flags[q] = dualPlane[q] ? 1 : 0;
  }
  return {
    vertices: v,
    polygons: p,
    normals: normals ? Float32Array.from(normals) : polygonNormals(v, p),
    dualPlane: flags,
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
var JSON_NORMAL_UNIT = 4096;
function serializeMeshLibrary(library) {
  return {
    v: 1,
    source: library.source,
    unit: JSON_UNIT,
    normalUnit: JSON_NORMAL_UNIT,
    meshes: library.meshes.map((mesh) => {
      const out = {
        f: mesh.family,
        i: mesh.meshIndex,
        s: mesh.source,
        v: Array.from(mesh.vertices, (x) => Math.round(x * JSON_UNIT)),
        p: Array.from(mesh.polygons),
        n: Array.from(mesh.normals, (x) => Math.round(x * JSON_NORMAL_UNIT)),
        c: mesh.colorSets.map((set) => Array.from(set))
      };
      const flagged2 = [];
      const flags = mesh.dualPlane;
      if (flags) {
        for (let q = 0; q < flags.length; q++) if (flags[q]) flagged2.push(q);
      }
      if (flagged2.length) out.d = flagged2;
      return out;
    })
  };
}
function meshLibraryFromJson(obj) {
  if (!obj || obj.v !== 1 || !Array.isArray(obj.meshes)) {
    throw new Error("mesh library: not a v1 library");
  }
  const unit = obj.unit || JSON_UNIT;
  const normalUnit = obj.normalUnit || JSON_NORMAL_UNIT;
  const meshes = obj.meshes.map((m) => {
    const polygonCount2 = m.p.length >> 2;
    const dualPlane = new Uint8Array(polygonCount2);
    if (Array.isArray(m.d)) {
      for (const q of m.d) if (q >= 0 && q < polygonCount2) dualPlane[q] = 1;
    }
    return makeMesh({
      vertices: Float32Array.from(m.v, (x) => x / unit),
      polygons: m.p,
      // Older libraries carry no `n`; makeMesh recomputes when it is absent.
      normals: m.n ? Float32Array.from(m.n, (x) => x / normalUnit) : void 0,
      dualPlane,
      colorSets: m.c,
      source: m.s || obj.source || "mdldt",
      family: m.f,
      meshIndex: m.i
    });
  });
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
    const dualPlane = new Uint8Array(base.nbPolygon);
    for (let q = 0; q < base.nbPolygon; q++) {
      dualPlane[q] = dv.getUint8(sets[0].attbl + q * ATTR_SIZE) & 1;
    }
    for (const other of sets) {
      for (let q = 0; q < base.nbPolygon; q++) {
        if ((dv.getUint8(other.attbl + q * ATTR_SIZE) & 1) !== dualPlane[q]) {
          throw new Error(
            `MDLDT: mesh ${m} polygon ${q} disagrees on the dual-plane flag between colour sets`
          );
        }
      }
    }
    meshes.push(makeMesh({
      vertices,
      polygons,
      normals,
      colorSets,
      dualPlane,
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
var SORT_KEY = "cen";
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
  let polyCount = 0;
  for (const { mesh } of resolved) {
    const polys = polygonCount(mesh);
    polyCount += polys;
    for (let q = 0; q < polys; q++) {
      triCount += mesh.polygons[q * 4 + 2] === mesh.polygons[q * 4 + 3] ? 1 : 2;
    }
  }
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 3);
  const colors = new Uint32Array(triCount);
  const colors555 = new Uint16Array(triCount);
  const partOf = new Uint8Array(triCount);
  const twoSided = new Uint8Array(triCount);
  const polyOf = new Uint32Array(triCount);
  const polyCenter = new Float32Array(polyCount * 3);
  const parts = [];
  const tmp = new Float64Array(3);
  const ySign = yDown ? -1 : 1;
  let t = 0;
  let poly = 0;
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
      twoSided[t] = mesh.dualPlane && mesh.dualPlane[q] ? 1 : 0;
      polyOf[t] = poly;
      t++;
    };
    for (let q = 0; q < polys; q++) {
      const a = mesh.polygons[q * 4], b = mesh.polygons[q * 4 + 1];
      const c = mesh.polygons[q * 4 + 2], d = mesh.polygons[q * 4 + 3];
      let sx = 0, sy = 0, sz = 0;
      for (const vi of [a, b, c, d]) {
        const at = vi * 3;
        transformPoint(m, mesh.vertices[at], mesh.vertices[at + 1], mesh.vertices[at + 2], tmp, 0);
        sx += tmp[0];
        sy += tmp[1] * ySign;
        sz += tmp[2];
      }
      polyCenter[poly * 3] = sx / 4;
      polyCenter[poly * 3 + 1] = sy / 4;
      polyCenter[poly * 3 + 2] = sz / 4;
      emit(q, a, b, c);
      if (c !== d) emit(q, a, c, d);
      poly++;
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
    twoSided,
    polyOf,
    polyCenter,
    polyCount,
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
function projectModel(mesh, cam, frame, lightView = LIGHT_VIEW, { sortKey = SORT_KEY } = {}) {
  const { positions, normals, triCount, twoSided, polyOf, polyCenter } = mesh;
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
    let nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
    const facing = nx * (eye[0] - mx / 3) + ny * (eye[1] - my / 3) + nz * (eye[2] - mz / 3);
    if (facing <= 0) {
      if (!(twoSided && twoSided[t])) {
        visible[t] = 0;
        continue;
      }
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    visible[t] = 1;
    if (sortKey === "cen" && polyOf && polyCenter) {
      const c = polyOf[t] * 3;
      const dx = polyCenter[c] - eye[0];
      const dy = polyCenter[c + 1] - eye[1];
      const dz = polyCenter[c + 2] - eye[2];
      depth[t] = -(dx * dir[0] + dy * dir[1] + dz * dir[2]);
    } else {
      depth[t] = far;
    }
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

// packages/shmup-engine/src/compress.js
var RING_SIZE2 = 4096;
var RING_MASK2 = RING_SIZE2 - 1;
var RING_INIT2 = 4078;
var MIN_MATCH = 3;
var MAX_MATCH = 18;
var HASH_BITS = 14;
var HASH_SIZE = 1 << HASH_BITS;
var MAX_CHAIN = 128;
function hash3(a, b, c) {
  return (a * 7967 + b * 61 + c ^ a << 7 ^ c << 3) & HASH_SIZE - 1;
}
function compress(input) {
  const n = input.length;
  const ring = new Uint8Array(RING_SIZE2);
  const head = new Int32Array(HASH_SIZE).fill(-2147483647);
  const prev = new Int32Array(RING_SIZE2).fill(-2147483647);
  const ringIndex = (p) => RING_INIT2 + p & RING_MASK2;
  const insert = (p, h) => {
    prev[p & RING_MASK2] = head[h];
    head[h] = p;
  };
  const zeroHash = hash3(0, 0, 0);
  for (const p of [-4096, -3584, -3072, -2560, -2048, -1536, -1024, -512, -256, -64, -MAX_MATCH]) {
    insert(p, zeroHash);
  }
  const out = [];
  let flagPos = -1;
  let flagBits = 0;
  let flagCount = 0;
  const item = (literal) => {
    if (flagCount === 0) {
      flagPos = out.length;
      out.push(0);
      flagBits = 0;
    }
    if (literal) flagBits |= 1 << flagCount;
    flagCount++;
    out[flagPos] = flagBits;
    if (flagCount === 8) flagCount = 0;
  };
  const sourceByte = (p, k, cur2, i2) => {
    const d = cur2 - p;
    return k < d ? ring[ringIndex(p + k)] : input[i2 + k - d];
  };
  let i = 0;
  let cur = 0;
  while (i < n) {
    let bestLen = 0;
    let bestPos = 0;
    if (i + MIN_MATCH <= n) {
      const h = hash3(input[i], input[i + 1], input[i + 2]);
      const limit = Math.min(MAX_MATCH, n - i);
      const oldest = cur - RING_SIZE2;
      let p = head[h];
      let steps = 0;
      while (p >= oldest && steps < MAX_CHAIN) {
        let k = 0;
        while (k < limit && sourceByte(p, k, cur, i) === input[i + k]) k++;
        if (k > bestLen) {
          bestLen = k;
          bestPos = p;
          if (k === limit) break;
        }
        p = prev[p & RING_MASK2];
        steps++;
      }
    }
    if (bestLen >= MIN_MATCH) {
      const off = ringIndex(bestPos);
      item(false);
      out.push(off & 255, (off >> 8 & 15) << 4 | bestLen - MIN_MATCH);
      for (let k = 0; k < bestLen; k++) {
        const b = input[i + k];
        ring[ringIndex(cur)] = b;
        if (i + k + MIN_MATCH <= n) insert(cur, hash3(b, input[i + k + 1], input[i + k + 2]));
        cur++;
      }
      i += bestLen;
    } else {
      const b = input[i];
      item(true);
      out.push(b);
      ring[ringIndex(cur)] = b;
      if (i + MIN_MATCH <= n) insert(cur, hash3(b, input[i + 1], input[i + 2]));
      cur++;
      i++;
    }
  }
  return Uint8Array.from(out);
}
function compressCmp(raw) {
  const stream = compress(raw);
  const out = new Uint8Array(4 + stream.length);
  out[0] = stream.length & 255;
  out[1] = stream.length >> 8 & 255;
  out[2] = stream.length >> 16 & 255;
  out[3] = stream.length >>> 24 & 255;
  out.set(stream, 4);
  return out;
}

// packages/shmup-engine/src/bup-write.js
var CART_PARTITION_SIZE = 524288;
var INTERNAL_PARTITION_SIZE = 32768;
var CART_BLOCK_SIZE = 512;
var INTERNAL_BLOCK_SIZE = 64;
var STREAM_OFFSET = 34;
var FIRST_SAVE_BLOCK = 2;
var MISTER_SAV_SIZE = (INTERNAL_PARTITION_SIZE + CART_PARTITION_SIZE) * 2;
var DEFAULT_TABLE_ADDR = 2919044;
var GAME_SAVE_SLOTS = 5;
var BUP_LANGUAGE = Object.freeze({
  japanese: 0,
  english: 1,
  french: 2,
  german: 3,
  spanish: 4,
  italian: 5
});
function buildPayload(sections, { tableAddr = DEFAULT_TABLE_ADDR, precompressed = false } = {}) {
  if (!Array.isArray(sections) || sections.length !== SECTION_COUNT) {
    throw new Error(`a payload needs exactly ${SECTION_COUNT} sections, got ${sections ? sections.length : 0}`);
  }
  if (!precompressed) {
    sections.forEach((s, i) => {
      if (s.length !== SECTION_SIZES[i]) {
        throw new Error(`sec${i} is ${s.length} bytes, expected ${SECTION_SIZES[i]}`);
      }
    });
  }
  const streams = precompressed ? sections.map((s) => Uint8Array.from(s)) : sections.map((s) => compress(s));
  const total = streams.reduce((a, s) => a + s.length, TABLE_SIZE);
  const payload = new Uint8Array(total);
  const dv = new DataView(payload.buffer);
  let addr = tableAddr + TABLE_SIZE;
  let offset = TABLE_SIZE;
  let checksumTotal = 0;
  streams.forEach((s, i) => {
    payload.set(s, offset);
    const checksum = byteSum(s, 0, s.length);
    dv.setUint32(12 + i * 12, checksum);
    dv.setUint32(12 + i * 12 + 4, addr);
    dv.setUint32(12 + i * 12 + 8, s.length);
    checksumTotal = checksumTotal + checksum >>> 0;
    addr += s.length;
    offset += s.length;
  });
  dv.setUint32(0, checksumTotal);
  dv.setUint32(4, tableAddr);
  dv.setUint32(8, addr);
  parseSectionTable(payload);
  return payload;
}
function bupDateFromDate(date = /* @__PURE__ */ new Date()) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  const minutes = Math.floor((ms - Date.UTC(1980, 0, 1)) / 6e4);
  return Math.max(0, Math.min(16777215, minutes));
}
function gameSaveFilename(slot = 1) {
  if (!Number.isInteger(slot) || slot < 1 || slot > GAME_SAVE_SLOTS) {
    throw new Error(`Dezaemon 2 has ${GAME_SAVE_SLOTS} game slots (1-${GAME_SAVE_SLOTS}), got ${slot}`);
  }
  return `DEZA2____${String(slot).padStart(2, "0")}`;
}
function encodeComment(comment, max = 10) {
  const out = new Uint8Array(max);
  if (comment instanceof Uint8Array) {
    out.set(comment.subarray(0, max));
    return out;
  }
  const s = String(comment ?? "");
  let n = 0;
  for (const ch of s) {
    if (n >= max) break;
    const code = ch.codePointAt(0);
    out[n++] = code >= 32 && code < 127 ? code : 95;
  }
  return out;
}
function encodeFilename(name) {
  const out = new Uint8Array(12);
  const s = String(name ?? "");
  if (!/^[\x21-\x7e]{1,11}$/.test(s)) {
    throw new Error(`BUP filename must be 1-11 printable ASCII characters, got ${JSON.stringify(s)}`);
  }
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function formatPartition(size, blockSize2) {
  const part = new Uint8Array(size);
  for (let off = 0; off + MAGIC.length <= blockSize2; off += MAGIC.length) part.set(MAGIC, off);
  return part;
}
function dataBlocksFor(datasize, blockSize2) {
  const headerRoom = blockSize2 - STREAM_OFFSET;
  const blockRoom = blockSize2 - 4;
  let n = 0;
  while (headerRoom + n * blockRoom < 2 * (n + 1) + datasize) n++;
  return n;
}
function writeSaveEntry(partition, blockSize2, save, firstBlock = FIRST_SAVE_BLOCK) {
  const payload = save.payload;
  const numBlocks = Math.floor(partition.length / blockSize2);
  const dataBlocks = dataBlocksFor(payload.length, blockSize2);
  const header = firstBlock;
  const chain = [];
  for (let k = 0; k < dataBlocks; k++) chain.push(header + 1 + k);
  const last = header + dataBlocks;
  if (last >= numBlocks) {
    throw new Error(
      `save needs ${dataBlocks + 1} blocks from block ${header}, partition has ${numBlocks}`
    );
  }
  const dv = new DataView(partition.buffer, partition.byteOffset, partition.byteLength);
  const h = header * blockSize2;
  dv.setUint32(h, 2147483648);
  partition.set(encodeFilename(save.filename), h + 4);
  partition.set(encodeComment(save.comment), h + 16);
  partition[h + 26] = (save.language ?? BUP_LANGUAGE.english) & 255;
  const date = save.date === void 0 ? bupDateFromDate() : save.date;
  partition[h + 27] = date >> 16 & 255;
  partition[h + 28] = date >> 8 & 255;
  partition[h + 29] = date & 255;
  dv.setUint32(h + 30, payload.length);
  let seg2 = -1;
  let pos = h + STREAM_OFFSET;
  let segEnd = h + blockSize2;
  const put = (b) => {
    while (pos >= segEnd) {
      seg2++;
      const n = chain[seg2];
      if (n === void 0) throw new Error("block chain exhausted while writing the data stream");
      const start = n * blockSize2;
      dv.setUint32(start, 0);
      pos = start + 4;
      segEnd = start + blockSize2;
    }
    partition[pos++] = b;
  };
  for (const n of chain) {
    put(n >> 8 & 255);
    put(n & 255);
  }
  put(0);
  put(0);
  for (let i = 0; i < payload.length; i++) put(payload[i]);
  return { header, blocks: chain, next: last + 1 };
}
function interleave(logical) {
  const out = new Uint8Array(logical.length * 2);
  for (let i = 0, j = 0; i < logical.length; i++, j += 2) {
    out[j] = 255;
    out[j + 1] = logical[i];
  }
  return out;
}
function buildBupImage(saves, { layout = "mister" } = {}) {
  if (!Array.isArray(saves) || !saves.length) throw new Error("buildBupImage needs at least one save");
  const partSize = layout === "internal" ? INTERNAL_PARTITION_SIZE : CART_PARTITION_SIZE;
  const blockSize2 = layout === "internal" ? INTERNAL_BLOCK_SIZE : CART_BLOCK_SIZE;
  const part = formatPartition(partSize, blockSize2);
  let next = FIRST_SAVE_BLOCK;
  const entries = [];
  for (const save of saves) {
    const placed = writeSaveEntry(part, blockSize2, save, next);
    entries.push({ filename: save.filename, ...placed });
    next = placed.next;
  }
  if (layout === "cart" || layout === "internal") return { image: part, entries, layout };
  if (layout !== "mister") throw new Error(`unknown layout ${JSON.stringify(layout)}`);
  const logical = new Uint8Array(INTERNAL_PARTITION_SIZE + CART_PARTITION_SIZE);
  logical.set(formatPartition(INTERNAL_PARTITION_SIZE, INTERNAL_BLOCK_SIZE), 0);
  logical.set(part, INTERNAL_PARTITION_SIZE);
  return { image: interleave(logical), logical, entries, layout };
}
function buildGameSave(sections, {
  slot = 1,
  comment = "shmupX",
  language = BUP_LANGUAGE.english,
  date,
  layout = "mister",
  tableAddr = DEFAULT_TABLE_ADDR
} = {}) {
  const payload = buildPayload(sections, { tableAddr });
  const filename = gameSaveFilename(slot);
  const built = buildBupImage([{ filename, comment, language, date, payload }], { layout });
  return { sav: built.image, logical: built.logical || built.image, payload, entry: built.entries[0], filename };
}

// packages/shmup-engine/src/bup-place.js
var INTERNAL_SRM_SIZE = INTERNAL_PARTITION_SIZE * 2;
var MISTER_LOGICAL_SIZE = INTERNAL_PARTITION_SIZE + CART_PARTITION_SIZE;
var PartitionFullError = class extends Error {
  constructor({ payloadBytes, freeBytes, capacityBytes, freeBlocks, neededBlocks, blockSize: blockSize2 }) {
    super(
      `a ${payloadBytes}-byte save needs ${neededBlocks} ${blockSize2}-byte blocks; the ${capacityBytes}-byte partition has room for a ${freeBytes}-byte save at most`
    );
    this.name = "PartitionFullError";
    this.payloadBytes = payloadBytes;
    this.freeBytes = freeBytes;
    this.capacityBytes = capacityBytes;
    this.freeBlocks = freeBlocks;
    this.neededBlocks = neededBlocks;
    this.blockSize = blockSize2;
  }
};
function payloadCapacity(blocks, blockSize2) {
  if (blocks < 1) return 0;
  return blockSize2 - STREAM_OFFSET - 2 + (blocks - 1) * (blockSize2 - 6);
}
var INTERNAL_RAM_PAYLOAD_CAPACITY = payloadCapacity(
  INTERNAL_PARTITION_SIZE / INTERNAL_BLOCK_SIZE - FIRST_SAVE_BLOCK,
  INTERNAL_BLOCK_SIZE
);
var MIN_GAME_PAYLOAD_BYTES = SECTION_SIZES.reduce((sum, n) => {
  const items = Math.ceil(n / 18);
  return sum + items * 2 + Math.ceil(items / 8);
}, TABLE_SIZE);
function partitionOf(partition, blockSize2) {
  const parts = detectPartitions(partition);
  if (parts.length === 0 || parts[0].base !== 0) {
    throw new Error('partition is not formatted ("BackUpRam Format" magic missing from block 0)');
  }
  if (parts.length > 1) {
    throw new Error(`expected one partition, found ${parts.length}; pass a bare partition`);
  }
  if (parts[0].blockSize !== blockSize2) {
    throw new Error(
      `${blockSize2}-byte blocks do not match a ${partition.length}-byte partition (${parts[0].blockSize}-byte blocks)`
    );
  }
  return parts[0];
}
function placeSaveInPartition(partition, blockSize2, save, { replace } = {}) {
  if (!(save?.payload instanceof Uint8Array)) throw new Error("save.payload must be a Uint8Array");
  partitionOf(partition, blockSize2);
  const numBlocks = Math.floor(partition.length / blockSize2);
  const entries = parse(partition);
  let replaced = null;
  const doomed = new Set([save.filename, replace].filter((n) => typeof n === "string" && n));
  const kept = [];
  for (const entry of entries) {
    if (!doomed.has(entry.filename)) {
      kept.push(entry);
      continue;
    }
    const header = entry.offset / blockSize2;
    for (const n of [header, ...entry.blocks]) {
      if (n < numBlocks) partition.fill(0, n * blockSize2, (n + 1) * blockSize2);
    }
    if (replaced === null || entry.filename === replace) replaced = entry.filename;
  }
  const used = new Uint8Array(numBlocks);
  used[0] = 1;
  used[1] = 1;
  for (const entry of kept) {
    used[entry.offset / blockSize2] = 1;
    for (const n of entry.blocks) if (n < numBlocks) used[n] = 1;
  }
  const needed = 1 + dataBlocksFor(save.payload.length, blockSize2);
  let start = -1;
  let run = 0;
  let longest = 0;
  let freeBlocks = 0;
  for (let n = FIRST_SAVE_BLOCK; n < numBlocks; n++) {
    if (used[n]) {
      run = 0;
      continue;
    }
    freeBlocks++;
    run++;
    if (run > longest) longest = run;
    if (run === needed && start === -1) start = n - needed + 1;
  }
  if (start === -1) {
    throw new PartitionFullError({
      payloadBytes: save.payload.length,
      freeBytes: payloadCapacity(longest, blockSize2),
      capacityBytes: partition.length,
      freeBlocks,
      neededBlocks: needed,
      blockSize: blockSize2
    });
  }
  partition.fill(0, start * blockSize2, (start + needed) * blockSize2);
  const placed = writeSaveEntry(partition, blockSize2, save, start);
  return { ...placed, replaced };
}
function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error("expected bytes (Uint8Array or ArrayBuffer)");
}
function isBlank(logical) {
  const first = logical[0];
  if (first !== 0 && first !== 255) return false;
  return logical.every((b) => b === first);
}
function internalRamFromImage(bytes) {
  if (bytes == null) return formatPartition(INTERNAL_PARTITION_SIZE, INTERNAL_BLOCK_SIZE);
  const buf = bytesOf(bytes);
  let logical;
  if (buf.length === INTERNAL_SRM_SIZE) {
    if (detect(buf)) logical = deinterleave(buf);
    else if (isBlank(buf)) logical = buf.slice(0, INTERNAL_PARTITION_SIZE);
    else throw new Error("a 65,536-byte image should be 0xFF-interleaved (yabause .srm); this one is not");
  } else if (buf.length === INTERNAL_PARTITION_SIZE) {
    logical = buf.slice();
  } else if (buf.length === MISTER_SAV_SIZE) {
    if (!detect(buf)) throw new Error("a 1,114,112-byte .sav should be 0xFF-interleaved; this one is not");
    logical = deinterleave(buf.subarray(0, INTERNAL_SRM_SIZE));
  } else if (buf.length === MISTER_LOGICAL_SIZE) {
    logical = buf.slice(0, INTERNAL_PARTITION_SIZE);
  } else {
    throw new Error(
      `${buf.length} bytes is not a Saturn internal memory image (expected 32,768 logical, 65,536 interleaved, or a 557,056 / 1,114,112-byte .sav)`
    );
  }
  if (isBlank(logical)) return formatPartition(INTERNAL_PARTITION_SIZE, INTERNAL_BLOCK_SIZE);
  return logical;
}
function commentKey(comment) {
  if (comment === void 0 || comment === null) return null;
  let s = "";
  for (const b of encodeComment(comment)) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}
function stageSaveInInternalRam(existing, { payload, filename, comment, language, date, slot } = {}) {
  if (!(payload instanceof Uint8Array)) throw new Error("payload must be a Uint8Array");
  const image = internalRamFromImage(existing);
  let name = filename;
  if (!name && slot !== void 0 && slot !== null) name = gameSaveFilename(slot);
  if (!name) {
    const games = parse(image).filter(isGameSave);
    const key = commentKey(comment);
    const same = key === null ? void 0 : games.find((g) => g.comment === key);
    if (same) name = same.filename;
    else {
      const taken = new Set(games.map((g) => g.filename));
      for (let s = 1; s <= GAME_SAVE_SLOTS && !name; s++) {
        if (!taken.has(gameSaveFilename(s))) name = gameSaveFilename(s);
      }
    }
    if (!name) {
      throw new Error(
        `all ${GAME_SAVE_SLOTS} DEZA2____NN slots are in use and none carries the comment ${JSON.stringify(key ?? "")}; pass slot to replace one`
      );
    }
  }
  const placed = placeSaveInPartition(
    image,
    INTERNAL_BLOCK_SIZE,
    { filename: name, comment, language, date, payload },
    { replace: name }
  );
  const { replaced, ...entry } = placed;
  return { image, interleaved: interleave(image), entry, filename: name, replaced };
}
function gamePayloadFromSav(bytes, { filename } = {}) {
  const buf = bytesOf(bytes);
  if (buf.length >= 2 && buf[0] === 31 && buf[1] === 139) {
    throw new Error("gzip-wrapped image: await normalize(bytes) and pass .data");
  }
  const data = detect(buf) ? deinterleave(buf) : buf;
  const games = parse(data).filter(isGameSave);
  const entry = filename ? games.find((g) => g.filename === filename) : games.find((g) => g.payload) ?? games[0];
  if (!entry) {
    throw new Error(
      filename ? `no ${filename} save in this image` : "no DEZA2____NN game save in this image"
    );
  }
  if (!entry.payload) throw new Error(`${entry.filename}: ${entry.payloadError}`);
  return { payload: entry.payload.buffer, entry };
}

// packages/shmup-engine/src/palette/deza2-palette.js
var DEZA2_PALETTE_COLS = 16;
var DEZA2_PALETTE_ROWS = 18;
var DEZA2_PALETTE_SIZE = DEZA2_PALETTE_COLS * DEZA2_PALETTE_ROWS;
var DEZA2_SYSTEM_ROWS = 12;
var DEZA2_USER_ROWS = 4;
var DEZA2_UI_ROWS = 2;
var DEZA2_CG_COLORS = (DEZA2_SYSTEM_ROWS + DEZA2_USER_ROWS) * DEZA2_PALETTE_COLS;
var DEZA2_PALETTE_PNG = "/palette.png";
var DEZA2_PALETTE_WORDS = Object.freeze([
  // row  0 — system 0
  0,
  21470,
  16350,
  990,
  9022,
  6814,
  4606,
  2398,
  190,
  30,
  25,
  20,
  15,
  10,
  6,
  3,
  // row  1 — system 1
  29692,
  25592,
  21492,
  17392,
  13292,
  9192,
  5092,
  992,
  832,
  736,
  640,
  544,
  448,
  352,
  256,
  160,
  // row  2 — system 2
  32756,
  32741,
  31620,
  29507,
  27394,
  25281,
  23168,
  21056,
  18944,
  16832,
  14720,
  12608,
  10496,
  8384,
  6272,
  4160,
  // row  3 — system 3
  32764,
  32665,
  32567,
  32468,
  32369,
  32303,
  32204,
  32106,
  32007,
  31908,
  31809,
  31744,
  25600,
  20480,
  15360,
  10240,
  // row  4 — system 4
  32767,
  31710,
  29596,
  27482,
  25368,
  23254,
  21140,
  19026,
  16912,
  14798,
  12684,
  10570,
  8456,
  6342,
  4228,
  2114,
  // row  5 — system 5
  17115,
  15001,
  12887,
  10773,
  8660,
  6546,
  6513,
  6480,
  5423,
  5390,
  5389,
  4331,
  2250,
  2184,
  2150,
  1092,
  // row  6 — system 6
  602,
  470,
  338,
  206,
  74,
  6,
  3,
  9116,
  7993,
  6870,
  5747,
  4624,
  3501,
  2378,
  1255,
  132,
  // row  7 — system 7
  30750,
  26650,
  22550,
  18450,
  14350,
  10250,
  6150,
  31764,
  31760,
  28686,
  24588,
  20490,
  16392,
  12294,
  8196,
  4098,
  // row  8 — system 8
  29599,
  25374,
  23261,
  19036,
  14811,
  10586,
  6361,
  22098,
  19984,
  17870,
  15756,
  13642,
  11528,
  9414,
  7300,
  5186,
  // row  9 — system 9
  26558,
  21306,
  18136,
  13908,
  6576,
  1324,
  136,
  17215,
  15101,
  15067,
  15034,
  12921,
  11863,
  10805,
  7601,
  5386,
  // row 10 — system 10
  29695,
  27614,
  25500,
  23386,
  21272,
  19158,
  17044,
  14930,
  12816,
  10702,
  8588,
  6474,
  4360,
  2246,
  132,
  66,
  // row 11 — system 11
  30719,
  28605,
  26491,
  24377,
  22263,
  20149,
  18035,
  15921,
  13807,
  11693,
  9579,
  7465,
  5351,
  3237,
  1123,
  33,
  // row 12 — user 0
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  33,
  // row 13 — user 1
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  33,
  // row 14 — user 2
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  33,
  // row 15 — user 3
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  33,
  // row 16 — ui 0
  57,
  14592,
  8480,
  16448,
  57,
  0,
  8480,
  16448,
  0,
  57,
  8481,
  16448,
  0,
  14647,
  8512,
  8512,
  // row 17 — ui 1
  0,
  14647,
  8512,
  16448,
  57,
  14625,
  8481,
  16416,
  57,
  33,
  16417,
  16416,
  0,
  33,
  13600,
  16448
]);
function deza2PaletteBand(index) {
  const row = index >> 4;
  if (index < 0 || index >= DEZA2_PALETTE_SIZE) return null;
  if (row < DEZA2_SYSTEM_ROWS) return "system";
  if (row < DEZA2_SYSTEM_ROWS + DEZA2_USER_ROWS) return "user";
  return "ui";
}
function rgb8ToRgb555(r, g, b) {
  return r >> 3 | g >> 3 << 5 | b >> 3 << 10;
}
function deza2PaletteRgb(words = DEZA2_PALETTE_WORDS) {
  const out = new Array(words.length);
  for (let i = 0; i < words.length; i++) {
    const raw = words[i] & 32767;
    const { r, g, b } = rgb555ToRgb(raw);
    out[i] = { r, g, b, raw, band: deza2PaletteBand(i) };
  }
  return out;
}
function deza2PaletteRaster(words = DEZA2_PALETTE_WORDS) {
  const data = new Uint8Array(words.length * 4);
  const rgb = deza2PaletteRgb(words);
  for (let i = 0; i < rgb.length; i++) {
    data[i * 4] = rgb[i].r;
    data[i * 4 + 1] = rgb[i].g;
    data[i * 4 + 2] = rgb[i].b;
    data[i * 4 + 3] = 255;
  }
  return { width: 1, height: words.length, data };
}
function paletteWordsFromRgba(rgba, count = rgba.length >> 2) {
  const words = new Array(count);
  for (let i = 0; i < count; i++) {
    words[i] = rgb8ToRgb555(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  return words;
}
function nearestPaletteIndex(r, g, b, palette, { cgOnly = true, allowTransparent = false } = {}) {
  const limit = cgOnly ? Math.min(palette.length, DEZA2_CG_COLORS) : palette.length;
  let best = -1;
  let bestD = Infinity;
  for (let i = allowTransparent ? 0 : 1; i < limit; i++) {
    const p = palette[i];
    const dr = p.r - r, dg = p.g - g, db = p.b - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
var CG_CELL = 16;
var CG_CELL_BYTES = CG_CELL * CG_CELL;
function indexedToCells(indexed, w, h) {
  const cw = w / CG_CELL, ch = h / CG_CELL;
  if (!Number.isInteger(cw) || !Number.isInteger(ch)) {
    throw new Error(`sprite ${w}x${h} is not a whole number of 16x16 cells`);
  }
  const out = new Uint8Array(w * h);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const base = (cy * cw + cx) * CG_CELL_BYTES;
      for (let y = 0; y < CG_CELL; y++) {
        const srcRow = (cy * CG_CELL + y) * w + cx * CG_CELL;
        out.set(indexed.subarray(srcRow, srcRow + CG_CELL), base + y * CG_CELL);
      }
    }
  }
  return out;
}
function cellsToIndexed(cells, w, h) {
  const cw = w / CG_CELL, ch = h / CG_CELL;
  const out = new Uint8Array(w * h);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const base = (cy * cw + cx) * CG_CELL_BYTES;
      for (let y = 0; y < CG_CELL; y++) {
        const dstRow = (cy * CG_CELL + y) * w + cx * CG_CELL;
        out.set(cells.subarray(base + y * CG_CELL, base + (y + 1) * CG_CELL), dstRow);
      }
    }
  }
  return out;
}
function indexedToRgbaWith(indexed, palette) {
  const rgba = new Uint8ClampedArray(indexed.length * 4);
  for (let i = 0; i < indexed.length; i++) {
    const v = indexed[i];
    if (v === 0) continue;
    const p = palette[v];
    if (!p) continue;
    const o = i * 4;
    rgba[o] = p.r;
    rgba[o + 1] = p.g;
    rgba[o + 2] = p.b;
    rgba[o + 3] = 255;
  }
  return rgba;
}
function paletteBankWords(words = DEZA2_PALETTE_WORDS) {
  const bank = new Array(DEZA2_CG_COLORS);
  for (let i = 0; i < DEZA2_CG_COLORS; i++) {
    const w = words[i] & 32767;
    bank[i] = i >> 4 < DEZA2_SYSTEM_ROWS ? w : w ? 32768 | w : 0;
  }
  return bank;
}
var DEZA2_ZAKO_SIZES = Object.freeze([
  { w: 16, h: 16, frames: 4, label: "16\xD716" },
  { w: 32, h: 16, frames: 4, label: "32\xD716" },
  { w: 16, h: 32, frames: 4, label: "16\xD732" },
  { w: 32, h: 32, frames: 4, label: "32\xD732" },
  { w: 64, h: 32, frames: 2, label: "64\xD732" },
  { w: 32, h: 64, frames: 2, label: "32\xD764" },
  { w: 64, h: 64, frames: 1, label: "64\xD764" }
]);

// packages/shmup-engine/src/palette/palette-target.js
var PALETTE_TARGETS = Object.freeze({
  saturn: Object.freeze({
    id: "saturn",
    label: "SATURN \xB7 DEZAEMON 2 (192 SYSTEM + 64 USER)",
    console: "Sega Saturn",
    bitsPerPixel: 8,
    rowsPerSprite: 16,
    colorsPerRow: 16
  }),
  snes: Object.freeze({
    id: "snes",
    label: "SUPER FAMICOM \xB7 15-BIT BGR, 1 ROW PER SPRITE",
    console: "Super Famicom",
    bitsPerPixel: 4,
    rowsPerSprite: 1,
    colorsPerRow: 15
  })
});
var ALPHA_CUTOFF = 128;
var USER_ROW_FIRST = DEZA2_SYSTEM_ROWS;
var USER_COLOR_COUNT = DEZA2_USER_ROWS * DEZA2_PALETTE_COLS;
var SEC4_WORD0 = 32768;
var DISC_USER_END_MARKER = 33;
var USER_COLOR_FLAG = 32768;
var SYSTEM_COLORS = DEZA2_SYSTEM_ROWS * DEZA2_PALETTE_COLS;
var to5 = (v) => v >> 3;
var word5 = (r5, g5, b5) => r5 | g5 << 5 | b5 << 10;
var r5of = (w) => w & 31;
var g5of = (w) => w >> 5 & 31;
var b5of = (w) => w >> 10 & 31;
function dist2(w, r, g, b) {
  const dr = r5of(w) - r, dg = g5of(w) - g, db = b5of(w) - b;
  return dr * dr + dg * dg + db * db;
}
function colorHistogram(frames) {
  const hist = /* @__PURE__ */ new Map();
  for (const f of frames) {
    const px = f.rgba;
    for (let i = 0; i < f.w * f.h; i++) {
      const o = i * 4;
      if (px[o + 3] < ALPHA_CUTOFF) continue;
      const w = word5(to5(px[o]), to5(px[o + 1]), to5(px[o + 2]));
      hist.set(w, (hist.get(w) || 0) + 1);
    }
  }
  return hist;
}
function medianCut(hist, maxColors) {
  const entries = [...hist.entries()].map(([w, n]) => ({ r: r5of(w), g: g5of(w), b: b5of(w), n }));
  if (!entries.length || maxColors <= 0) return [];
  if (entries.length <= maxColors) return entries.map((e) => word5(e.r, e.g, e.b));
  const boxes = [entries];
  const range = (box, ch) => {
    let lo = 31, hi = 0;
    for (const e of box) {
      if (e[ch] < lo) lo = e[ch];
      if (e[ch] > hi) hi = e[ch];
    }
    return hi - lo;
  };
  while (boxes.length < maxColors) {
    let bi = -1, best = -1;
    boxes.forEach((box2, i) => {
      if (box2.length < 2) return;
      const spread = Math.max(range(box2, "r"), range(box2, "g"), range(box2, "b"));
      const pop = box2.reduce((a, e) => a + e.n, 0);
      const score = spread * Math.log2(1 + pop);
      if (score > best) {
        best = score;
        bi = i;
      }
    });
    if (bi < 0) break;
    const box = boxes[bi];
    const ch = ["r", "g", "b"].reduce((a, c) => range(box, c) > range(box, a) ? c : a, "r");
    box.sort((a, b) => a[ch] - b[ch]);
    const total = box.reduce((a, e) => a + e.n, 0);
    let acc = 0, cut = 0;
    while (cut < box.length - 1 && acc + box[cut].n < total / 2) acc += box[cut++].n;
    if (cut === 0) cut = 1;
    boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const e of box) {
      r += e.r * e.n;
      g += e.g * e.n;
      b += e.b * e.n;
      n += e.n;
    }
    return word5(Math.round(r / n), Math.round(g / n), Math.round(b / n));
  });
}
function candidateSet(list) {
  const memo = /* @__PURE__ */ new Map();
  const wordOf = new Map(list.map((c) => [c.index, c.word]));
  let error = 0, count = 0;
  return {
    list,
    // [{index, word}]
    wordOf,
    nearest(w) {
      let idx = memo.get(w);
      if (idx !== void 0) return idx;
      const r = r5of(w), g = g5of(w), b = b5of(w);
      let best = -1, bestD = Infinity;
      for (const c of list) {
        const d = dist2(c.word, r, g, b);
        if (d < bestD) {
          bestD = d;
          best = c.index;
          if (d === 0) break;
        }
      }
      memo.set(w, best);
      return best;
    },
    account(w, idx) {
      error += Math.sqrt(dist2(wordOf.get(idx), r5of(w), g5of(w), b5of(w)) / 3);
      count++;
    },
    meanError() {
      return count ? error / count * 8 : 0;
    }
    // 8-bit units
  };
}
function indexFrame(frame, cands) {
  const out = new Uint8Array(frame.w * frame.h);
  const px = frame.rgba;
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    if (px[o + 3] < ALPHA_CUTOFF) continue;
    const w = word5(to5(px[o]), to5(px[o + 1]), to5(px[o + 2]));
    const idx = cands.nearest(w);
    out[i] = idx;
    cands.account(w, idx);
  }
  return out;
}
function systemCandidates() {
  const list = [];
  for (let i = 1; i < SYSTEM_COLORS; i++) list.push({ index: i, word: DEZA2_PALETTE_WORDS[i] & 32767 });
  return list;
}
function emptyBank() {
  const bank = new Uint16Array(DEZA2_CG_COLORS);
  for (let i = 0; i < SYSTEM_COLORS; i++) bank[i] = DEZA2_PALETTE_WORDS[i] & 32767;
  bank[0] = SEC4_WORD0;
  for (let row = USER_ROW_FIRST; row < USER_ROW_FIRST + DEZA2_USER_ROWS; row++) {
    bank[row * DEZA2_PALETTE_COLS + DEZA2_PALETTE_COLS - 1] = DISC_USER_END_MARKER;
  }
  return bank;
}
function frameGroup(key) {
  return String(key).replace(/\.[a-z0-9]+$/i, "").replace(/[_-]?\d+$/, "").replace(/[_-]?\d+$/, "") || String(key);
}
function quantizeSaturn(frames, { userColors = USER_COLOR_COUNT, threshold = 12 } = {}) {
  const hist = colorHistogram(frames);
  const system = systemCandidates();
  const sys = candidateSet(system);
  const poor = /* @__PURE__ */ new Map();
  for (const [w, n] of hist) {
    const idx = sys.nearest(w);
    if (dist2(sys.wordOf.get(idx), r5of(w), g5of(w), b5of(w)) > threshold) poor.set(w, n);
  }
  const bank = emptyBank();
  const cands = system.slice();
  const chosen = medianCut(poor, Math.min(userColors, USER_COLOR_COUNT));
  const have = new Set(cands.map((c) => c.word));
  let slot = 0;
  for (const w of chosen) {
    if (have.has(w) || slot >= USER_COLOR_COUNT) continue;
    have.add(w);
    const index = USER_ROW_FIRST * DEZA2_PALETTE_COLS + slot;
    bank[index] = USER_COLOR_FLAG | w;
    cands.push({ index, word: w });
    slot++;
  }
  const set = candidateSet(cands);
  const indexed = frames.map((f) => ({ key: f.key, w: f.w, h: f.h, group: f.group, indexed: indexFrame(f, set), row: null }));
  return {
    bank,
    frames: indexed,
    report: {
      target: "saturn",
      sourceColors: hist.size,
      userColors: slot,
      poorlyServed: poor.size,
      meanError: Math.round(set.meanError() * 100) / 100
    }
  };
}
function quantizeSnes(frames, { rows = DEZA2_USER_ROWS, colorsPerRow = 15, firstRow = USER_ROW_FIRST } = {}) {
  if (firstRow < 0 || firstRow + rows > DEZA2_CG_COLORS / DEZA2_PALETTE_COLS) {
    throw new Error(`palette rows ${firstRow}..${firstRow + rows - 1} do not fit a 16-row bank`);
  }
  const groups = /* @__PURE__ */ new Map();
  for (const f of frames) {
    const g = f.group || frameGroup(f.key);
    if (!groups.has(g)) groups.set(g, { name: g, frames: [], hist: null, pixels: 0 });
    groups.get(g).frames.push(f);
  }
  for (const g of groups.values()) {
    g.hist = colorHistogram(g.frames);
    for (const n of g.hist.values()) g.pixels += n;
  }
  const merge2 = (a, b) => {
    const m = new Map(a);
    for (const [w, n] of b) m.set(w, (m.get(w) || 0) + n);
    return m;
  };
  const errorOf = (hist, palette) => {
    if (!palette.length) return hist.size ? Infinity : 0;
    let e = 0, n = 0;
    for (const [w, cnt] of hist) {
      let best = Infinity;
      for (const p of palette) {
        const d = dist2(p, r5of(w), g5of(w), b5of(w));
        if (d < best) best = d;
      }
      e += best * cnt;
      n += cnt;
    }
    return n ? e / n : 0;
  };
  const rowSets = [];
  const ordered = [...groups.values()].filter((g) => g.hist.size).sort((a, b) => b.pixels - a.pixels);
  for (const g of ordered) {
    const alone = errorOf(g.hist, medianCut(g.hist, colorsPerRow));
    let bestRow = -1, bestErr = Infinity;
    rowSets.forEach((row, i) => {
      const merged = merge2(row.hist, g.hist);
      const err = errorOf(merged, medianCut(merged, colorsPerRow));
      if (err < bestErr) {
        bestErr = err;
        bestRow = i;
      }
    });
    if (rowSets.length < rows && (bestRow < 0 || bestErr > alone)) {
      rowSets.push({ hist: new Map(g.hist), groups: [g] });
    } else {
      rowSets[bestRow].hist = merge2(rowSets[bestRow].hist, g.hist);
      rowSets[bestRow].groups.push(g);
    }
  }
  const bank = emptyBank();
  const rowOfGroup = /* @__PURE__ */ new Map();
  const rowCands = [];
  rowSets.forEach((row, i) => {
    const palRow = firstRow + i;
    bank[palRow * DEZA2_PALETTE_COLS + DEZA2_PALETTE_COLS - 1] = 0;
    const words = medianCut(row.hist, colorsPerRow);
    const cands = [];
    words.forEach((w, k) => {
      const index = palRow * DEZA2_PALETTE_COLS + 1 + k;
      bank[index] = USER_COLOR_FLAG | w;
      cands.push({ index, word: w });
    });
    rowCands.push(candidateSet(cands));
    for (const g of row.groups) rowOfGroup.set(g.name, i);
  });
  let error = 0, count = 0;
  const indexed = frames.map((f) => {
    const g = f.group || frameGroup(f.key);
    const r = rowOfGroup.get(g);
    if (r === void 0) {
      return { key: f.key, w: f.w, h: f.h, group: g, indexed: new Uint8Array(f.w * f.h), row: null };
    }
    const set = rowCands[r];
    const out = indexFrame(f, set);
    return { key: f.key, w: f.w, h: f.h, group: g, indexed: out, row: firstRow + r };
  });
  for (const set of rowCands) {
    error += set.meanError();
    count++;
  }
  return {
    bank,
    frames: indexed,
    report: {
      target: "snes",
      sourceColors: colorHistogram(frames).size,
      rows: rowSets.map((row, i) => ({
        row: firstRow + i,
        colors: Math.min(colorsPerRow, row.hist.size),
        groups: row.groups.map((g) => g.name)
      })),
      groups: groups.size,
      meanError: count ? Math.round(error / count * 100) / 100 : 0
    }
  };
}
function quantizeFrames(frames, target = "saturn", options = {}) {
  const spec = PALETTE_TARGETS[target];
  if (!spec) throw new Error(`unknown palette target ${JSON.stringify(target)} (saturn | snes)`);
  for (const f of frames) {
    if (!f || !f.rgba || f.rgba.length < f.w * f.h * 4) {
      throw new Error(`frame ${f && f.key}: rgba must hold w*h*4 bytes`);
    }
  }
  const out = target === "snes" ? quantizeSnes(frames, options) : quantizeSaturn(frames, options);
  return { target: spec, ...out };
}
function indexWithBank(frames, bank, target = "saturn") {
  if (!PALETTE_TARGETS[target]) throw new Error(`unknown palette target ${JSON.stringify(target)} (saturn | snes)`);
  const userEntries = (first, last) => {
    const out = [];
    for (let i = first; i < last; i++) {
      if (bank[i] & USER_COLOR_FLAG) out.push({ index: i, word: bank[i] & 32767 });
    }
    return out;
  };
  if (target === "snes") {
    const rows = [];
    for (let r = USER_ROW_FIRST; r < DEZA2_CG_COLORS / DEZA2_PALETTE_COLS; r++) {
      const cands = userEntries(r * DEZA2_PALETTE_COLS + 1, (r + 1) * DEZA2_PALETTE_COLS);
      if (cands.length) rows.push({ row: r, set: candidateSet(cands) });
    }
    return frames.map((f) => {
      if (!rows.length) return { key: f.key, w: f.w, h: f.h, group: f.group, indexed: new Uint8Array(f.w * f.h), row: null };
      let best = rows[0], bestError = Infinity;
      for (const r of rows) {
        let e = 0;
        for (const [w, n] of colorHistogram([f])) {
          e += dist2(r.set.wordOf.get(r.set.nearest(w)), r5of(w), g5of(w), b5of(w)) * n;
        }
        if (e < bestError) {
          bestError = e;
          best = r;
        }
      }
      return { key: f.key, w: f.w, h: f.h, group: f.group, indexed: indexFrame(f, best.set), row: best.row };
    });
  }
  const set = candidateSet([...systemCandidates(), ...userEntries(USER_ROW_FIRST * DEZA2_PALETTE_COLS, DEZA2_CG_COLORS)]);
  return frames.map((f) => ({ key: f.key, w: f.w, h: f.h, group: f.group, indexed: indexFrame(f, set), row: null }));
}
function bankToSec4(bank) {
  const sec4 = new Uint8Array(512);
  for (let i = 0; i < 256; i++) {
    sec4[i * 2] = bank[i] >> 8;
    sec4[i * 2 + 1] = bank[i] & 255;
  }
  return sec4;
}
function bankToPalettes(bank) {
  const palettes = [];
  for (let p = 0; p < 16; p++) {
    const colors = [];
    for (let c = 0; c < 16; c++) {
      const raw = bank[p * 16 + c];
      colors.push({ raw, ...rgb555ToRgb(raw & 32767), empty: raw === 0 });
    }
    palettes.push({ colors });
  }
  return palettes;
}
function snesCgramBytes(bank) {
  const out = new Uint8Array(512);
  for (let i = 0; i < 256; i++) {
    const w = i === 0 ? 0 : bank[i] & 32767;
    out[i * 2] = w & 255;
    out[i * 2 + 1] = w >> 8;
  }
  return out;
}

// packages/shmup-engine/src/write/cg-pack.js
var CG_PAGE_COUNT = 4;
var CG_PAGE_BYTES = 65536;
var CG_CELL_CAPACITY = CG_PAGE_COUNT * (CG_PAGE_BYTES / CG_CELL_BYTES);
var REF_HFLIP = 16384;
var REF_VFLIP = 32768;
var CgFullError = class extends Error {
  constructor(need2) {
    super(`the four CG pages hold ${CG_CELL_CAPACITY} cells and every one is taken (needed ${need2} more)`);
    this.name = "CgFullError";
  }
};
function flipH(cell) {
  const out = new Uint8Array(CG_CELL_BYTES);
  for (let y = 0; y < CG_CELL; y++) {
    for (let x = 0; x < CG_CELL; x++) out[y * CG_CELL + x] = cell[y * CG_CELL + (CG_CELL - 1 - x)];
  }
  return out;
}
function flipV(cell) {
  const out = new Uint8Array(CG_CELL_BYTES);
  for (let y = 0; y < CG_CELL; y++) {
    out.set(cell.subarray((CG_CELL - 1 - y) * CG_CELL, (CG_CELL - y) * CG_CELL), y * CG_CELL);
  }
  return out;
}
function keyOf(cell) {
  let s = "";
  for (let i = 0; i < CG_CELL_BYTES; i++) s += String.fromCharCode(cell[i]);
  return s;
}
var CgPacker = class {
  constructor({ capacity = CG_CELL_CAPACITY, reuseFlips = true } = {}) {
    this.capacity = Math.min(capacity, CG_CELL_CAPACITY);
    this.reuseFlips = reuseFlips;
    this.pages = Array.from({ length: CG_PAGE_COUNT }, () => new Uint8Array(CG_PAGE_BYTES));
    this.used = 0;
    this.byKey = /* @__PURE__ */ new Map();
    this.shared = 0;
  }
  get free() {
    return this.capacity - this.used;
  }
  /** Store (or find) one 256-byte cell; returns its composition ref. */
  addCell(cell) {
    let blank = true;
    for (let i = 0; i < CG_CELL_BYTES; i++) if (cell[i]) {
      blank = false;
      break;
    }
    if (blank) return EMPTY_REF;
    const key = keyOf(cell);
    const hit = this.byKey.get(key);
    if (hit) {
      this.shared++;
      return hit.index | hit.flags;
    }
    if (this.used >= this.capacity) throw new CgFullError(1);
    const index = this.used++;
    this.pages[index >> 8].set(cell, (index & 255) * CG_CELL_BYTES);
    this.byKey.set(key, { index, flags: 0 });
    if (this.reuseFlips) {
      const h = flipH(cell), v = flipV(cell), hv = flipV(h);
      for (const [bytes, flags] of [[h, REF_HFLIP], [v, REF_VFLIP], [hv, REF_HFLIP | REF_VFLIP]]) {
        const k = keyOf(bytes);
        if (!this.byKey.has(k)) this.byKey.set(k, { index, flags });
      }
    }
    return index;
  }
  /**
   * The new cells storing every one of `frames` ({indexed, w, h}, w and h
   * multiples of 16) would take — a blank cell, or one already stored or
   * already counted, costs nothing — without storing anything. What
   * addFrame checks for one frame, asked of several at once.
   */
  cellsNeeded(frames) {
    let need2 = 0;
    const seen = /* @__PURE__ */ new Set();
    for (const f of frames) {
      const cells = indexedToCells(f.indexed, f.w, f.h);
      for (let c = 0; c < cells.length / CG_CELL_BYTES; c++) {
        const cell = cells.subarray(c * CG_CELL_BYTES, (c + 1) * CG_CELL_BYTES);
        let blank = true;
        for (let i = 0; i < CG_CELL_BYTES; i++) if (cell[i]) {
          blank = false;
          break;
        }
        if (blank) continue;
        const k = keyOf(cell);
        if (this.byKey.has(k) || seen.has(k)) continue;
        seen.add(k);
        need2++;
      }
    }
    return need2;
  }
  /**
   * Store an indexed frame whose w and h are multiples of 16. Returns its
   * refs in reading order (cellsW * cellsH words). Throws CgFullError —
   * with nothing partially stored — when the frame does not fit.
   */
  addFrame(indexed, w, h) {
    const cells = indexedToCells(indexed, w, h);
    const count = cells.length / CG_CELL_BYTES;
    const need2 = this.cellsNeeded([{ indexed, w, h }]);
    if (need2 > this.free) throw new CgFullError(need2 - this.free);
    const refs = new Uint16Array(count);
    for (let c = 0; c < count; c++) {
      refs[c] = this.addCell(cells.subarray(c * CG_CELL_BYTES, (c + 1) * CG_CELL_BYTES));
    }
    return refs;
  }
};

// packages/shmup-engine/src/write/attribution.js
var ATTRIBUTION_ROLES = 3;
var NAMES_PER_ROLE = 2;
var DEFAULT_ATTRIBUTION_ROLE = "PRESENTED BY";
var CREDIT_STRIP_W = 64;
var CREDIT_STRIP_H = 16;
var CREDIT_LINE_CHARS = 16;
var CREDIT_STRIP_CHARS = CREDIT_LINE_CHARS * 2;
var GLYPH_W = 3;
var GLYPH_H = 5;
var ADVANCE = 4;
var GLYPHS = {
  " ": "000000000000000",
  A: "010101111101101",
  B: "110101110101110",
  C: "011100100100011",
  D: "110101101101110",
  E: "111100110100111",
  F: "111100110100100",
  G: "011100101101011",
  H: "101101111101101",
  I: "111010010010111",
  J: "001001001101010",
  K: "101101110101101",
  L: "100100100100111",
  M: "101111111101101",
  N: "110101101101101",
  O: "010101101101010",
  P: "110101110100100",
  Q: "010101101111011",
  R: "110101110101101",
  S: "011100010001110",
  T: "111010010010010",
  U: "101101101101111",
  V: "101101101101010",
  W: "101101111111101",
  X: "101101010101101",
  Y: "101101010010010",
  Z: "111001010100111",
  0: "111101101101111",
  1: "010110010010111",
  2: "110001010100111",
  3: "110001010001110",
  4: "101101111001001",
  5: "111100110001110",
  6: "011100111101111",
  7: "111001010010010",
  8: "111101111101111",
  9: "111101111001110",
  ".": "000000000000010",
  ",": "000000000010100",
  "-": "000000111000000",
  _: "000000000000111",
  "'": "010010000000000",
  "!": "010010010000010",
  "?": "110001010000010",
  "&": "010101010101011",
  "/": "001001010100100",
  ":": "000010000010000",
  "+": "000010111010000",
  "@": "111101111100111",
  "#": "101111101111101",
  "(": "001010010010001",
  ")": "100010010010100",
  "*": "101010101000000"
};
var FOLD = { "\u2018": "'", "\u2019": "'", "`": "'", "\u201C": "'", "\u201D": "'", '"': "'", "\u2013": "-", "\u2014": "-", "	": " " };
function foldCreditText(text) {
  let dropped = "";
  const folded = [...String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "")].map((ch) => FOLD[ch] ?? ch).join("").toUpperCase();
  let out = "";
  for (const ch of folded) {
    if (ch === "\n" || GLYPHS[ch] !== void 0) out += ch;
    else if (!dropped.includes(ch)) dropped += ch;
  }
  const lines = out.split("\n").map((l) => l.replace(/ +/g, " ").trim());
  return { text: lines.join("\n").replace(/^\n+|\n+$/g, ""), dropped };
}
function wrapLine(line, cols) {
  const out = [];
  let cur = "";
  for (let word of line.split(" ").filter(Boolean)) {
    while (word.length > cols) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      out.push(word.slice(0, cols));
      word = word.slice(cols);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= cols) cur += " " + word;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  return out;
}
function creditStripRgba(text) {
  const folded = foldCreditText(text);
  if (!folded.text.replace(/\n/g, "")) return null;
  const asked = folded.text.split("\n").filter(Boolean);
  let lines, sx = 1, sy = 1;
  if (asked.length === 1 && asked[0].length <= CREDIT_LINE_CHARS / 2) {
    lines = asked;
    sx = 2;
    sy = 2;
  } else if (asked.length === 1 && asked[0].length <= CREDIT_LINE_CHARS) {
    lines = asked;
    sy = 2;
  } else {
    lines = asked.flatMap((l) => wrapLine(l, CREDIT_LINE_CHARS));
  }
  const truncated = lines.length > 2;
  lines = lines.slice(0, 2);
  const rgba = new Uint8Array(CREDIT_STRIP_W * CREDIT_STRIP_H * 4);
  const put = (x, y, v) => {
    if (x < 0 || y < 0 || x >= CREDIT_STRIP_W || y >= CREDIT_STRIP_H) return;
    const o = (y * CREDIT_STRIP_W + x) * 4;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
    rgba[o + 3] = 255;
  };
  const lineH = GLYPH_H * sy, pitch = lineH + 2;
  const top = Math.floor((CREDIT_STRIP_H - (lineH + (lines.length - 1) * pitch + 1)) / 2);
  const draw = (dx, dy, v) => lines.forEach((line, n) => {
    const left = Math.floor((CREDIT_STRIP_W - (line.length * ADVANCE * sx - sx + 1)) / 2);
    [...line].forEach((ch, c) => {
      const bits = GLYPHS[ch];
      for (let gy = 0; gy < GLYPH_H; gy++) {
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (bits[gy * GLYPH_W + gx] !== "1") continue;
          for (let py = 0; py < sy; py++) {
            for (let px = 0; px < sx; px++) {
              put(left + (c * ADVANCE + gx) * sx + px + dx, top + n * pitch + gy * sy + py + dy, v);
            }
          }
        }
      }
    });
  });
  draw(1, 1, 0);
  draw(0, 0, 255);
  return { w: CREDIT_STRIP_W, h: CREDIT_STRIP_H, rgba, lines, dropped: folded.dropped, truncated };
}
function roleIndex(role) {
  if (Number.isInteger(role)) return role >= 0 && role < STAFF_ROLE_LABELS.length ? role : -1;
  if (typeof role !== "string") return -1;
  return STAFF_ROLE_LABELS.indexOf(role.trim().replace(/\s+/g, " ").toUpperCase());
}
var cleanName = (v) => typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
function normalizeAttribution(value, warn = () => {
}) {
  if (value === false) return { credits: [] };
  if (value === void 0 || value === null || value === true) return null;
  if (typeof value === "string" || typeof value === "number") {
    const author = cleanName(value);
    return author ? { credits: [{ role: DEFAULT_ATTRIBUTION_ROLE, names: [author] }] } : null;
  }
  if (typeof value !== "object") return null;
  const list = Array.isArray(value) ? value : value.credits;
  if (!Array.isArray(list)) return normalizeAttribution(value.author ?? null, warn);
  if (list.length > ATTRIBUTION_ROLES) {
    warn(`attribution: a staff roll holds ${ATTRIBUTION_ROLES} roles; dropped ${list.length - ATTRIBUTION_ROLES}`);
  }
  const credits = list.slice(0, ATTRIBUTION_ROLES).map((entry) => {
    if (typeof entry === "string" || typeof entry === "number") entry = { names: [entry] };
    if (!entry || typeof entry !== "object") return { role: "", names: [] };
    const raw = Array.isArray(entry.names) ? entry.names : [entry.names ?? entry.name];
    const names = raw.map(cleanName);
    const over = names.slice(NAMES_PER_ROLE).filter(Boolean);
    if (over.length) warn(`attribution: a role holds ${NAMES_PER_ROLE} names; dropped "${over.join('", "')}"`);
    const kept = names.slice(0, NAMES_PER_ROLE);
    while (kept.length && !kept[kept.length - 1]) kept.pop();
    const presented = STAFF_ROLE_LABELS.indexOf(DEFAULT_ATTRIBUTION_ROLE);
    let index;
    if (entry.role === void 0 || entry.role === null) {
      index = kept.length ? presented : 0;
    } else {
      index = roleIndex(entry.role);
      if (index < 0) {
        warn(`attribution: "${entry.role}" is not one of the staff roll's labels \u2014 using ${DEFAULT_ATTRIBUTION_ROLE}`);
        index = presented;
      }
    }
    return { role: STAFF_ROLE_LABELS[index], names: kept };
  });
  while (credits.length && !credits[credits.length - 1].role && !credits[credits.length - 1].names.length) credits.pop();
  return { credits };
}
function cameOffACart(level) {
  return !!(level && (level.dezaemonTitle || level.dezaemonTitleScreen || level.meta && level.meta.source === "dezaemon2"));
}
function resolveAttribution(level, { attribution, author } = {}, warn = () => {
}) {
  const asked = normalizeAttribution(attribution, warn);
  if (asked) return { source: "option", credits: asked.credits };
  const own = normalizeAttribution(level && level.attribution, warn);
  if (own) return { source: "level", credits: own.credits };
  if (cameOffACart(level)) return { source: "cart", credits: [] };
  const fallback = normalizeAttribution(cleanName(author), warn);
  if (fallback) return { source: "default", credits: fallback.credits };
  return { source: "none", credits: [] };
}
function staffRolesFor(credits) {
  return Array.from({ length: ATTRIBUTION_ROLES }, (_, i) => Math.max(0, roleIndex(credits[i] ? credits[i].role : "")));
}
function authorFromEnvironment(env = {}) {
  const read = (key) => typeof env[key] === "string" ? env[key].trim() : "";
  const user = read("USER") || read("LOGNAME") || read("USERNAME");
  if (user) return user;
  const home = (read("HOME") || read("USERPROFILE")).replace(/[\\/]+$/, "");
  return home.split(/[\\/]/).pop() || null;
}

// packages/shmup-engine/src/boss-stage2.js
var BOSS_STAGE2_HP_BELOW = 0.5;
var BOSS_WEAPON_SUFFIXES = Object.freeze(["", "A", "B", "C"]);
function bossStage2Record(bossData) {
  const stage2 = bossData && bossData.stage2;
  if (!stage2 || typeof stage2 !== "object") return null;
  const merged = { ...bossData, ...stage2 };
  delete merged.stage2;
  merged.anim = { ...bossData.anim || {}, ...stage2.anim || {} };
  for (const suffix of BOSS_WEAPON_SUFFIXES) {
    const bullet = `bulletData${suffix}`, projectile = `projectileData${suffix}`;
    if (stage2[bullet] && !stage2[projectile]) delete merged[projectile];
    if (stage2[projectile] && !stage2[bullet]) delete merged[bullet];
  }
  const below = Number(stage2.hpBelow);
  merged.hpBelow = below > 0 && below < 1 ? below : BOSS_STAGE2_HP_BELOW;
  return merged;
}
function splitBossStage2(bossData) {
  const second = bossStage2Record(bossData);
  if (!second) return null;
  const hpBelow = second.hpBelow;
  delete second.hpBelow;
  const first = { ...bossData };
  delete first.stage2;
  const hp = Number(bossData.hp);
  if (bossData.hp !== "infinity" && Number.isFinite(hp) && hp > 0) {
    const top = Math.max(1, Math.round(hp * (1 - hpBelow)));
    first.hp = top;
    second.hp = Math.max(1, Math.round(hp) - top);
  }
  return { first, second, hpBelow };
}
function bossWeapons(bossData) {
  const out = [];
  if (!bossData) return out;
  for (const suffix of BOSS_WEAPON_SUFFIXES) {
    const weapon = bossData[`bulletData${suffix}`] || bossData[`projectileData${suffix}`];
    if (weapon && typeof weapon === "object") out.push({ slot: suffix, weapon });
  }
  return out;
}
function weaponTextures(weapon) {
  const t = weapon && weapon.texture;
  if (typeof t === "string" && t) return [t];
  return Array.isArray(t) ? t.filter((n) => typeof n === "string" && n) : [];
}
function bossBodyFrames(bossData) {
  const anim = bossData && bossData.anim;
  if (anim && Array.isArray(anim.idle) && anim.idle.length) return anim.idle.slice();
  return Array.isArray(bossData && bossData.texture) ? bossData.texture.slice() : [];
}

// packages/shmup-engine/src/write/game-to-save.js
var FIRST_SPAWN_ROW = 8;
var ROW_STEP = 12;
var BOSS_ROW_GAP = 24;
var MAX_SPAWN_ROW = PLACEMENT_ROWS - 32;
var PLAYFIELD_FIRST_COL = 3;
var PLAYFIELD_COLS2 = 14;
var BOSS_COL = 9;
var DEFAULT_ITEM_TYPES = [7, 7, 7, 6, 5, 4, 1, 2];
var DEFAULT_ITEM_LETTERS = Object.freeze(["f", "s", "r", null, null, "b", null, null]);
var EMBLEM_LETTER_BY_TYPE = Object.freeze({ 4: "b", 7: "f" });
var DEFAULT_ITEM_MOVEMENT = 1;
var DROP_TO_SLOT = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 9: 5 };
var STRAIGHT_APPEARANCE_BASE = 32;
var STORY_FIRST_ROW = 3;
var STORY_LEAD_ROWS = 8;
var STORY_SCROLL_SPEEDS = [1, 2];
var STRAIGHT_SPEEDS = [128, 256, 384, 512, 640, 768, 1152, 1536];
var SHOT_UNITS = 5120;
var BOSS_UNITS_PER_HIT = SHOT_UNITS;
var RUNTIME_TO_SATURN_SPEED = 0.5;
var DEFAULT_SCROLL_BYTE = 4;
var DEFAULT_BULLET_CONFIG = 19;
var DEFAULT_BLAST_BYTE = 51;
var DEFAULT_LOADOUTS = [[17, 17], [34, 17], [51, 33], [68, 49]];
var DEFAULT_SHIP_BLOCK = [16, 65, 33, 4];
var DEFAULT_TITLE_ENTRANCE = [5, 0, 10, 0];
var DEFAULT_STAFF_ROLES = [12, 0, 0];
var BULLET_ENGINE_SLOTS = [
  [{ ref: 104, w: 1, h: 1 }, { ref: 105, w: 1, h: 1 }, { ref: 106, w: 1, h: 1 }, { ref: 107, w: 1, h: 1 }],
  [{ ref: 108, w: 2, h: 2 }, { ref: 112, w: 2, h: 2 }, { ref: 116, w: 2, h: 2 }, { ref: 120, w: 2, h: 2 }],
  [{ ref: 124, w: 2, h: 2 }, { ref: 128, w: 2, h: 2 }, { ref: 132, w: 1, h: 1 }, { ref: 136, w: 1, h: 1 }]
];
var PLAYER_SHOT_SLOTS = [
  { ref: 53, w: 1, h: 1 },
  // weapon 1 (VULCAN A) — the default
  { ref: 54, w: 1, h: 1 },
  // weapon 2
  { ref: 55, w: 1, h: 1 },
  // weapon 3
  { ref: 57, w: 1, h: 2 },
  // weapon 4 (16x32)
  { ref: 59, w: 2, h: 1 },
  // weapon 5 (32x16)
  { ref: 61, w: 1, h: 1 },
  // weapon 6
  { ref: 68, w: 1, h: 1 }
  // weapon 7
];
var GLOBAL_SLOTS = {
  shipBankA: 0,
  shipIdle: 8,
  shipBankB: 16,
  ship2BankA: 24,
  ship2Idle: 32,
  ship2BankB: 40,
  items: 94,
  blastA: 102,
  blastB: 108,
  bullets: 132
};
function decodeFrameKey(key) {
  return String(key).replace(/․/g, ".");
}
function nearestIndex(table, value) {
  let best = 0, bestD = Infinity;
  table.forEach((v, i) => {
    const d = Math.abs(v - value);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function extentAfter(lastRow, firstRow = 0) {
  const end = clamp(Math.ceil((lastRow + 32) / 16 / 2) * 2, 2, 48);
  return [Math.min(end - 2, Math.max(0, end - 4, Math.ceil(firstRow / 16))), end];
}
function b64ToBytes(b64) {
  const bin = atob(String(b64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hexToBytes(hex2, len) {
  const s = String(hex2 || "").replace(/[^0-9a-f]/gi, "");
  if (s.length !== len * 2) return null;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function fitRgba(frame, boxW, boxH) {
  const out = new Uint8Array(boxW * boxH * 4);
  const scale = Math.min(1, boxW / frame.w, boxH / frame.h);
  const w = Math.max(1, Math.round(frame.w * scale));
  const h = Math.max(1, Math.round(frame.h * scale));
  const ox = Math.floor((boxW - w) / 2);
  const oy = Math.floor((boxH - h) / 2);
  for (let y = 0; y < h; y++) {
    const sy = scale === 1 ? y : Math.min(frame.h - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < w; x++) {
      const sx = scale === 1 ? x : Math.min(frame.w - 1, Math.floor((x + 0.5) / scale));
      const s = (sy * frame.w + sx) * 4;
      const d = ((oy + y) * boxW + ox + x) * 4;
      out[d] = frame.rgba[s];
      out[d + 1] = frame.rgba[s + 1];
      out[d + 2] = frame.rgba[s + 2];
      out[d + 3] = frame.rgba[s + 3];
    }
  }
  return { w: boxW, h: boxH, rgba: out, scaled: scale < 1 };
}
function hflipRgba(frame) {
  const out = new Uint8Array(frame.rgba.length);
  for (let y = 0; y < frame.h; y++) {
    for (let x = 0; x < frame.w; x++) {
      const s = (y * frame.w + (frame.w - 1 - x)) * 4;
      const d = (y * frame.w + x) * 4;
      out[d] = frame.rgba[s];
      out[d + 1] = frame.rgba[s + 1];
      out[d + 2] = frame.rgba[s + 2];
      out[d + 3] = frame.rgba[s + 3];
    }
  }
  return { w: frame.w, h: frame.h, rgba: out };
}
function bandFor(w, h) {
  for (let i = 0; i < RECORD_ART.length; i++) {
    const b = RECORD_ART[i];
    if (b.w * CG_CELL >= w && b.h * CG_CELL >= h) return i;
  }
  return RECORD_ART.length - 1;
}
function bossClassFor(w, h) {
  if (w <= 64 && h <= 64) return 0;
  if (h <= 64) return 1;
  if (w <= 64) return 2;
  return 3;
}
function mapColumn(col, width) {
  if (width >= PLACEMENT_COLS) return clamp(col, 0, PLACEMENT_COLS - 1);
  if (width <= PLAYFIELD_COLS2) {
    if (width <= 1) return PLAYFIELD_FIRST_COL + Math.floor(PLAYFIELD_COLS2 / 2);
    return PLAYFIELD_FIRST_COL + Math.round(col * (PLAYFIELD_COLS2 - 1) / (width - 1));
  }
  return Math.round(col * (PLACEMENT_COLS - 1) / (width - 1));
}
function pickEnemyClass(classes, used, w, h) {
  const aw = Math.min(w, Math.max(...classes.map((c) => c.w)));
  const ah = Math.min(h, Math.max(...classes.map((c) => c.h)));
  const free = classes.map((c, klass) => ({ ...c, klass })).filter((c) => used[c.klass] < c.count);
  const holds = free.filter((c) => c.w >= aw && c.h >= ah).sort((a, b) => a.w * a.h - b.w * b.h);
  if (holds.length) return { klass: holds[0].klass, shrunk: false };
  const scale = (c) => Math.min(c.w / aw, c.h / ah);
  const smaller = free.sort((a, b) => scale(b) - scale(a) || a.w * a.h - b.w * b.h);
  return smaller.length ? { klass: smaller[0].klass, shrunk: true } : { klass: -1, shrunk: false };
}
function spreadFrames(list, count) {
  if (!list.length) return [];
  if (list.length === count) return list.slice();
  if (list.length < count) return Array.from({ length: count }, (_, i) => list[i % list.length]);
  return Array.from({ length: count }, (_, i) => list[Math.floor(i * list.length / count)]);
}
function levelStages(level) {
  const out = [];
  const stageMap = level.stages && typeof level.stages === "object" ? level.stages : null;
  const keys = stageMap ? Object.keys(stageMap).filter((k) => /^stage\d+$/.test(k) && stageMap[k] && Array.isArray(stageMap[k].enemylist)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))) : [];
  if (keys.length) {
    for (const k of keys) out.push({ key: k, ...stageMap[k] });
  } else if (Array.isArray(level.enemylist)) {
    out.push({
      key: level.stageKey || "stage0",
      enemylist: level.enemylist,
      waveRows: level.waveRows,
      waveInterval: level.waveInterval,
      items: level.items,
      background: level.background,
      scroll: level.scroll
    });
  } else {
    for (let s = 0; s < MAX_STAGES; s++) {
      const st = level[`stage${s}`];
      if (st && Array.isArray(st.enemylist)) out.push({ key: `stage${s}`, ...st });
    }
  }
  return out.map((st) => ({
    ...st,
    enemylist: st.enemylist.map((row) => Array.isArray(row) ? row.map((c) => typeof c === "string" && c ? c : "00") : [])
  }));
}
function encodeEnemyRecord({
  appearance = STRAIGHT_APPEARANCE_BASE,
  animIndex = 3,
  scoreIndex = 1,
  ground = false,
  hpIndex = 0,
  armour = false,
  noCollision = false,
  deathMode = 0,
  deathParam = 0,
  bulletType = 0,
  deathPresentation = 1,
  fireRateIndex = 0,
  fireGeometry = 0,
  aimed = true
} = {}) {
  const b = new Uint8Array(18);
  b[0] = appearance & 255;
  b[1] = animIndex & 7 | (scoreIndex & 7) << 4 | (ground ? 128 : 0);
  b[2] = hpIndex & 7 | (armour ? 16 : 0) | (noCollision ? 32 : 0) | (deathMode & 3) << 6;
  b[3] = deathParam & 255;
  b[4] = bulletType & 3 | (deathPresentation & 3) << 2 | (fireRateIndex & 7) << 4;
  b[5] = fireGeometry & 15 | (aimed && fireGeometry ? 16 : 0);
  return b;
}
function withDeathDrop(bytes, slot) {
  const b = Uint8Array.from(bytes);
  b[2] = b[2] & 63 | 1 << 6;
  b[3] = slot & 7;
  return b;
}
function withDeathChild(bytes, index) {
  const b = Uint8Array.from(bytes);
  b[2] = b[2] & 63 | 2 << 6;
  b[3] = zakoPlacementId(index) & 127;
  return b;
}
function enemyRecordFromEditor(rec, { bulletType = 0, dropSlot = null } = {}) {
  const speed = Number.isFinite(rec.speed) ? rec.speed : 1;
  const hits = rec.hp === "infinity" ? 1 : Math.max(1, Number(rec.hp) || 1);
  const interval = Number(rec.interval);
  const fires = Number.isFinite(interval) && interval > 0;
  return encodeEnemyRecord({
    appearance: STRAIGHT_APPEARANCE_BASE + nearestIndex(STRAIGHT_SPEEDS, speed * RUNTIME_TO_SATURN_SPEED * 256),
    animIndex: Number.isFinite(rec.frameRate) && rec.frameRate > 0 ? nearestIndex(ANIM_PERIOD_TABLE, 60 / rec.frameRate) : 3,
    scoreIndex: nearestIndex(SCORE_TABLE, Number(rec.score) || 100),
    hpIndex: nearestIndex(HP_TABLE, hits * SHOT_UNITS),
    armour: rec.hp === "infinity",
    deathMode: dropSlot === null ? 0 : 1,
    deathParam: dropSlot === null ? 0 : dropSlot & 7,
    bulletType,
    fireRateIndex: fires ? nearestIndex(FIRE_INTERVAL_TABLE, interval) : 0,
    fireGeometry: fires ? 1 : 0,
    aimed: true
  });
}
function encodeBossTrailer(spec = {}) {
  const t = new Uint8Array(BOSS_TRAILER_SIZE);
  const sizeClass = spec.sizeClass & 3;
  const hpStages = clamp(spec.hpStages || 2, 1, 4);
  t[0] = sizeClass | hpStages - 1 << 4 | (spec.rotate ? 64 : 0) | (spec.deathSpin ? 128 : 0);
  const hpIndex = Number.isInteger(spec.hpIndex) ? spec.hpIndex : nearestIndex(BOSS_HP_TABLE, Number(spec.hp) || BOSS_HP_TABLE[2]);
  const scoreIndex = Number.isInteger(spec.scoreIndex) ? spec.scoreIndex : nearestIndex(BOSS_SCORE_TABLE, Number(spec.score) || BOSS_SCORE_TABLE[2]);
  t[1] = hpIndex & 7 | (spec.optionFlag ? 0 : 8) | (scoreIndex & 7) << 4;
  const playlist = spec.playlist || [[0, 0, 1, 1], [1, 1, 2, 2], [2, 3, 2, 3], [3, 3, 3, 3]];
  for (let k = 0; k < 4; k++) {
    const ids = playlist[k] || playlist[playlist.length - 1] || [0, 0, 0, 0];
    t[2 + k] = ids[0] & 3 | (ids[1] & 3) << 2 | (ids[2] & 3) << 4 | (ids[3] & 3) << 6;
  }
  t[6] = (spec.arrive || 0) & 255;
  t[7] = (spec.death || 0) & 255;
  const patterns = spec.patterns || DEFAULT_BOSS_PATTERNS;
  for (let p = 0; p < 4; p++) {
    const pat = patterns[p] || patterns[patterns.length - 1];
    const base = 8 + p * 14;
    t[base] = (pat.moveScript & 31) << 3 | pat.moveSpeed & 7;
    t[base + 1] = Number.isInteger(pat.fireTickIndex) ? pat.fireTickIndex & 7 : nearestIndex(BOSS_FIRE_TICK_FRAMES, pat.fireTickFrames || 15);
    for (let i = 0; i < 3; i++) {
      const fp = (pat.firePoints || [])[i] || { dx: 0, dy: 0, type: 0, rate: 0, param: 0 };
      t[base + 2 + i * 4] = fp.dx & 255;
      t[base + 3 + i * 4] = fp.dy & 255;
      t[base + 4 + i * 4] = (fp.rate & 7) << 4 | fp.type & 7;
      t[base + 5 + i * 4] = fp.param & 255;
    }
  }
  return t;
}
function saturnStage2Bands(hpBelow) {
  let best = { hpStages: 2, bands: 1 }, bestD = Infinity;
  for (const [hpStages, bands] of [[2, 1], [3, 1], [3, 2], [4, 1], [4, 3]]) {
    const d = Math.abs(bands / hpStages - hpBelow);
    if (d < bestD - 1e-9) {
      bestD = d;
      best = { hpStages, bands };
    }
  }
  return best;
}
function saturnTransform(built, bulletTypes) {
  const parts = [];
  for (const b of built) {
    const st2 = b.boss && b.boss.stage2;
    if (!st2) continue;
    const fired = [...new Set(st2.weapons.filter((t) => t !== null).map((t) => bulletTypes[t] && bulletTypes[t].first).filter(Boolean))];
    const bands = st2.bands === 1 ? `the last of ${st2.hpStages} hp stages` : `the last ${st2.bands} of ${st2.hpStages} hp stages`;
    parts.push(`${b.key} ${b.boss.name}: ${bands} fire ${fired.length ? fired.join(", ") : "its first stage's bullets (no bullet type was left)"}`);
  }
  return parts.length ? `approximated: the boss's own hp stages change its patterns and bullets at the line (${parts.join("; ")}); its core keeps the first form's art` : "none";
}
var DEFAULT_BOSS_PATTERNS = [
  { moveScript: 1, moveSpeed: 3, fireTickIndex: 2, firePoints: [{ dx: 0, dy: 24, type: 0, rate: 2, param: 17 }] },
  {
    moveScript: 3,
    moveSpeed: 3,
    fireTickIndex: 2,
    firePoints: [{ dx: -24, dy: 16, type: 0, rate: 2, param: 19 }, { dx: 24, dy: 16, type: 0, rate: 2, param: 19 }]
  },
  { moveScript: 9, moveSpeed: 4, fireTickIndex: 1, firePoints: [{ dx: 0, dy: 0, type: 1, rate: 3, param: 31 }] },
  { moveScript: 0, moveSpeed: 3, fireTickIndex: 3, firePoints: [{ dx: 0, dy: 24, type: 0, rate: 4, param: 17 }] }
];
function encodeSettings({
  gameMode = 0,
  hud = 0,
  stageCount = 1,
  ships = [DEFAULT_SHIP_BLOCK, DEFAULT_SHIP_BLOCK],
  loadouts = DEFAULT_LOADOUTS,
  itemSlots = DEFAULT_ITEM_TYPES.map((t) => DEFAULT_ITEM_MOVEMENT << 4 | t),
  scoreItemIndex = 1,
  bullets = [DEFAULT_BULLET_CONFIG, DEFAULT_BULLET_CONFIG, DEFAULT_BULLET_CONFIG],
  blast = DEFAULT_BLAST_BYTE,
  titleEntrance = DEFAULT_TITLE_ENTRANCE,
  extents = [],
  bgmTable = new Array(24).fill(0),
  sfxSet = 1,
  staffRoles = DEFAULT_STAFF_ROLES,
  shadow = false
} = {}) {
  const s = new Uint8Array(SEC5_REGIONS.settings.stride);
  s[0] = gameMode & 3;
  s[1] = hud & 119;
  for (let i = 0; i < MAX_STAGES; i++) {
    if (i < stageCount) s[2 + i] = (i === stageCount - 1 ? 128 : 0) | (shadow ? 32 : 0);
  }
  s.set(ships[0].slice(0, 4), 12);
  s.set((ships[1] || ships[0]).slice(0, 4), 16);
  for (let k = 0; k < 4; k++) {
    const l = loadouts[k] || DEFAULT_LOADOUTS[k];
    s[20 + k * 2] = l[0];
    s[21 + k * 2] = l[1];
  }
  for (let i = 0; i < 8; i++) s[28 + i] = itemSlots[i] ?? 0;
  s[36] = scoreItemIndex & 7;
  for (let i = 0; i < 3; i++) s[37 + i] = bullets[i] ?? DEFAULT_BULLET_CONFIG;
  s[40] = blast;
  for (let i = 0; i < 4; i++) s[41 + i] = titleEntrance[i] ?? 0;
  for (let i = 0; i < MAX_STAGES; i++) {
    const [loop, end] = extents[i] || [0, 48];
    s[45 + i * 2] = loop & 255;
    s[46 + i * 2] = end & 255;
  }
  for (let i = 0; i < 24; i++) s[65 + i] = clamp(bgmTable[i] ?? 0, 0, 23);
  s[89] = sfxSet;
  for (let i = 0; i < 3; i++) s[90 + i] = (staffRoles[i] ?? 0) & 15;
  return s;
}
function emptySong() {
  const song = new Uint8Array(SONG_SIZE);
  song.set([0, 31, 3, 15], 0);
  for (let m = 0; m < MEASURES; m++) song.set([0, 0, 128, 3], 4 + m * MEASURE_SIZE);
  return song;
}
function emptySongBank() {
  const sec6 = new Uint8Array(SECTION_SIZES[6]);
  const song = emptySong();
  for (let s = 0; s < SONG_SLOTS; s++) sec6.set(song, s * SONG_SIZE);
  return sec6;
}
function rgbaFrame(w, h) {
  return { w, h, rgba: new Uint8Array(w * h * 4) };
}
function plot(frame, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= frame.w || y >= frame.h) return;
  const o = (y * frame.w + x) * 4;
  frame.rgba[o] = r;
  frame.rgba[o + 1] = g;
  frame.rgba[o + 2] = b;
  frame.rgba[o + 3] = 255;
}
function blastFrames(size, count = 6) {
  const ramp = [[255, 255, 255], [255, 240, 120], [255, 170, 40], [230, 90, 30], [150, 50, 40], [80, 60, 70]];
  const frames = [];
  const c = size / 2 - 0.5;
  for (let f = 0; f < count; f++) {
    const fr = rgbaFrame(size, size);
    const radius = (f + 1) / count * (size / 2 - 1);
    const thick = Math.max(1.5, size / 10);
    const [r, g, b] = ramp[Math.min(ramp.length - 1, f)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - c, y - c);
        if (Math.abs(d - radius) <= thick / 2 || f === 0 && d <= radius) plot(fr, x, y, r, g, b);
      }
    }
    frames.push(fr);
  }
  return frames;
}
function itemIcon(type) {
  const tints = {
    0: [70, 120, 255],
    1: [70, 200, 120],
    2: [190, 90, 240],
    3: [60, 200, 220],
    4: [120, 200, 255],
    5: [255, 140, 40],
    6: [255, 220, 60],
    7: [255, 70, 70],
    8: [90, 230, 90]
  };
  const [r, g, b] = tints[type] || [200, 200, 200];
  const fr = rgbaFrame(16, 16);
  for (let y = 2; y < 14; y++) {
    for (let x = 2; x < 14; x++) {
      const edge = x === 2 || y === 2 || x === 13 || y === 13;
      const corner = (x === 2 || x === 13) && (y === 2 || y === 13);
      if (corner) continue;
      if (edge) plot(fr, x, y, r >> 2, g >> 2, b >> 2);
      else plot(fr, x, y, r, g, b);
    }
  }
  for (let i = 4; i < 8; i++) plot(fr, i, 4, 255, 255, 255);
  plot(fr, 4, 5, 255, 255, 255);
  return fr;
}
function rotateCcwRgba(frame) {
  const w = frame.h, h = frame.w;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (x * frame.w + (h - 1 - y)) * 4;
      const d = (y * w + x) * 4;
      out[d] = frame.rgba[s];
      out[d + 1] = frame.rgba[s + 1];
      out[d + 2] = frame.rgba[s + 2];
      out[d + 3] = frame.rgba[s + 3];
    }
  }
  return { w, h, rgba: out };
}
function placeRgba(frame, boxW, boxH, slotW, slotH, ox, oy) {
  const fitted = fitRgba(frame, boxW, boxH);
  const out = new Uint8Array(slotW * slotH * 4);
  for (let y = 0; y < boxH; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= slotH) continue;
    for (let x = 0; x < boxW; x++) {
      const tx = ox + x;
      if (tx < 0 || tx >= slotW) continue;
      const s = (y * boxW + x) * 4;
      const d = (ty * slotW + tx) * 4;
      out[d] = fitted.rgba[s];
      out[d + 1] = fitted.rgba[s + 1];
      out[d + 2] = fitted.rgba[s + 2];
      out[d + 3] = fitted.rgba[s + 3];
    }
  }
  return { w: slotW, h: slotH, rgba: out, scaled: fitted.scaled };
}
var SHOT_TINTS = [[255, 240, 120], [120, 200, 255], [255, 120, 200], [140, 255, 140], [255, 170, 60]];
function shotSprite(w = 16, h = 16, tint = SHOT_TINTS[0]) {
  const fr = rgbaFrame(w, h);
  const cx = (w - 1) / 2;
  const [r, g, b] = tint;
  for (let y = 1; y < h - 1; y++) {
    const t = (y - 1) / Math.max(1, h - 3);
    const half = Math.max(0.5, w / 6 * (0.3 + 0.7 * t));
    for (let x = 0; x < w; x++) {
      const d = Math.abs(x - cx);
      if (d > half) continue;
      if (d <= half / 2 && y > 2) plot(fr, x, y, 255, 255, 255);
      else plot(fr, x, y, r, g, b);
    }
  }
  return fr;
}
function beamSprite(w, h, tint = SHOT_TINTS[1]) {
  const fr = rgbaFrame(w, h);
  const vertical = h >= w;
  const [r, g, b] = tint;
  const span = vertical ? w : h;
  const c = (span - 1) / 2;
  const half = Math.max(1, span / 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.abs((vertical ? x : y) - c);
      if (d > half) continue;
      if (d <= half / 2) plot(fr, x, y, 255, 255, 255);
      else plot(fr, x, y, r, g, b);
    }
  }
  return fr;
}
function missileSprite(w = 16, h = 16, tint = SHOT_TINTS[4]) {
  const fr = rgbaFrame(w, h);
  const cx = Math.floor(w / 2) - 1;
  const bodyW = Math.max(2, Math.round(w / 5));
  const nose = Math.max(2, Math.round(h / 5));
  const tail = h - Math.max(2, Math.round(h / 6));
  const [r, g, b] = tint;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      if (y < nose) {
        if (Math.abs(dx - 0.5) <= bodyW / 2 * (y / nose) + 0.5) plot(fr, x, y, 90, 90, 110);
      } else if (y < tail) {
        if (dx >= -Math.floor(bodyW / 2) && dx <= Math.ceil(bodyW / 2)) plot(fr, x, y, 200, 200, 215);
        if (y >= tail - 3 && Math.abs(dx) <= bodyW + 1 && Math.abs(dx) > bodyW / 2) plot(fr, x, y, r, g, b);
      } else if (Math.abs(dx - 0.5) <= 1) {
        plot(fr, x, y, 255, 255, 200);
      }
    }
  }
  return fr;
}
function glowSprite(size = 32, tint = SHOT_TINTS[1]) {
  const fr = rgbaFrame(size, size);
  const c = size / 2 - 0.5;
  const [r, g, b] = tint;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / (size / 2);
      if (d > 0.95) continue;
      if (d < 0.35) plot(fr, x, y, 255, 255, 255);
      else if (d < 0.7) plot(fr, x, y, r, g, b);
      else if ((x + y & 1) === 0) plot(fr, x, y, r >> 1, g >> 1, b >> 1);
    }
  }
  return fr;
}
function domeSprite(w = 32, h = 16, tint = SHOT_TINTS[1]) {
  const fr = rgbaFrame(w, h);
  const cx = (w - 1) / 2;
  const [r, g, b] = tint;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x - cx) / (w / 2), ny = (h - 1 - y) / h;
      const d = Math.hypot(nx, ny);
      if (d > 1) continue;
      if (d > 0.8) plot(fr, x, y, 255, 255, 255);
      else if (d > 0.6) plot(fr, x, y, r, g, b);
      else if ((x + y & 1) === 0) plot(fr, x, y, r >> 1, g >> 1, b >> 1);
    }
  }
  return fr;
}
function puffSprite(size = 16) {
  const fr = rgbaFrame(size, size);
  const c = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / (size / 2);
      if (d < 0.45) plot(fr, x, y, 200, 200, 200);
      else if (d < 0.8 && (x + y & 1) === 0) plot(fr, x, y, 140, 140, 150);
    }
  }
  return fr;
}
function buildSaveFromGame(level, art2, options = {}) {
  const opts = { palette: "saturn", gameMode: 0, title1: null, title2: null, titleG: null, itemEmblems: null, storyBackdrops: null, useBackground: true, attribution: null, author: null, ...options };
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const artMap = /* @__PURE__ */ new Map();
  for (const [k, v] of Object.entries(art2 || {})) {
    if (v && v.rgba && v.w > 0 && v.h > 0) artMap.set(decodeFrameKey(k), { key: decodeFrameKey(k), ...v });
  }
  const lookup = (name) => name ? artMap.get(decodeFrameKey(name)) || null : null;
  let stages = levelStages(level);
  if (!stages.length) throw new Error("the level has no stage with an enemylist");
  if (stages.length > MAX_STAGES) {
    warn(`level has ${stages.length} stages; a save holds ${MAX_STAGES} \u2014 dropped the rest`);
    stages = stages.slice(0, MAX_STAGES);
  }
  const enemyData = level.enemyData || {};
  const bossData = level.bossData || {};
  const importedSlots = level.dezaemonItems && Array.isArray(level.dezaemonItems.slots) && level.dezaemonItems.slots.length === 8 ? level.dezaemonItems.slots : null;
  const itemSlotBytes = importedSlots ? importedSlots.map((s) => Number.isInteger(s.raw) ? s.raw : (s.movement & 3) << 4 | s.type & 15) : DEFAULT_ITEM_TYPES.map((t) => DEFAULT_ITEM_MOVEMENT << 4 | t);
  const dropToSlot = (drop) => {
    if (!drop) return null;
    if (importedSlots) {
      const i = importedSlots.findIndex((s) => ITEM_TYPE_DROPS[s.type & 15] === drop);
      return i >= 0 ? i : null;
    }
    return DROP_TO_SLOT[drop] ?? null;
  };
  const plan = /* @__PURE__ */ new Map();
  const planFrame = (planKey, frame, boxW, boxH, group, priority) => {
    if (!plan.has(planKey)) {
      const fitted = fitRgba(frame, boxW, boxH);
      plan.set(planKey, { key: planKey, w: boxW, h: boxH, rgba: fitted.rgba, group, priority, scaled: fitted.scaled });
    }
    return planKey;
  };
  let shipSource = "level";
  let shipFrames = (level.playerData && level.playerData.texture || []).map(lookup).filter(Boolean);
  if (!shipFrames.length) {
    shipSource = "duke";
    const duke = decodePlayerArt().filter((f) => /^duke_\d$/.test(f.key));
    shipFrames = duke.slice(0, 2);
  }
  const shipIdle = spreadFrames(shipFrames, 2).map((f, i) => planFrame(`ship:${i}:${f.key}`, f, 32, 32, "player", 0));
  const ship2Frames = (level.playerData2 && level.playerData2.texture || []).map(lookup).filter(Boolean);
  const ship2Idle = opts.gameMode & 2 ? ship2Frames.length ? spreadFrames(ship2Frames, 2).map((f, i) => planFrame(`ship2:${i}:${f.key}`, f, 32, 32, "player2", 0)) : shipIdle : [];
  const bulletTypes = [null, null, null];
  const bulletTypeOf = /* @__PURE__ */ new Map();
  const paintedTypes = () => bulletTypes.filter(Boolean).length;
  const planBulletType = (t, first, frames, speed) => {
    bulletTypes[t] = {
      first,
      speed,
      src: frames,
      frames: frames.map((f, i) => planFrame(`bullet:${t}:${i}:${f.key}`, f, 16, 16, `bullet${t}`, 1)),
      // The same projectile, fitted to each engine char-slot frame's geometry, so
      // the bullet the hardware actually draws (char slots 55/59/63) shows it.
      engine: BULLET_ENGINE_SLOTS[t].map((slot, i) => planFrame(`bulletE:${t}:${i}:${frames[i % frames.length].key}`, frames[i % frames.length], slot.w * CG_CELL, slot.h * CG_CELL, `bulletE${t}`, 1))
    };
  };
  const bankArt = level.dezaemonBullets && Array.isArray(level.dezaemonBullets.art) ? level.dezaemonBullets.art : [];
  const bankType2 = Array.isArray(bankArt[2]) && bankArt[2].length > 0;
  for (let t = 0; t < 3; t++) {
    let names = Array.isArray(bankArt[t]) ? bankArt[t] : [];
    if (!names.length) continue;
    if (t < 2 && bankType2 && names.length > 1) names = names.slice(1);
    const frames = spreadFrames(names.map(lookup).filter(Boolean), 4);
    if (!frames.length) {
      warn(`bullet type ${t}: the cart's own art (${names[0]}) is not in the atlas \u2014 left unpainted`);
      continue;
    }
    const cfg = level.dezaemonBullets.configs && level.dezaemonBullets.configs[t];
    planBulletType(t, names[0], frames, cfg && Number.isFinite(cfg.speedAdd) ? cfg.speedAdd / RUNTIME_TO_SATURN_SPEED : 1);
  }
  const claimBulletType = (proj, owner) => {
    const tex = proj && Array.isArray(proj.texture) ? proj.texture : null;
    if (!tex || !tex.length) return null;
    const have = bulletTypes.findIndex((b) => b && b.first === tex[0]);
    if (have >= 0) return have;
    const frames = spreadFrames(tex.map(lookup).filter(Boolean), 4);
    if (!frames.length) return null;
    const t = bulletTypes.indexOf(null);
    if (t < 0) {
      warn(`${owner}: a save holds three bullet types and they are all taken \u2014 ${tex[0]} is not one of them`);
      return null;
    }
    planBulletType(t, tex[0], frames, Number(proj.speed) || 1);
    return t;
  };
  const bossWeaponTypes = /* @__PURE__ */ new Map();
  const armed = (...slots) => slots.find((p) => p && Array.isArray(p.texture) && p.texture.length) || null;
  const weaponSlots = (b) => [
    armed(b.bulletDataA, b.projectileDataA, b.bulletData, b.projectileData),
    armed(b.bulletDataB, b.projectileDataB),
    armed(b.bulletDataC, b.projectileDataC)
  ];
  const bossOwner = (st, b) => `${st.key}: boss (${b.name || "?"})`;
  stages.forEach((st, s) => {
    const b = bossData[`boss${s}`];
    if (!b) return;
    bossWeaponTypes.set(s, [claimBulletType(weaponSlots(b)[0], bossOwner(st, b)), null, null]);
  });
  const usedLetters = /* @__PURE__ */ new Set();
  for (const st of stages) for (const row of st.enemylist) for (const c of row) if (c !== "00") usedLetters.add(c.slice(0, -1));
  for (const letter of usedLetters) {
    const rec = enemyData[`enemy${letter}`];
    const t = claimBulletType(rec && rec.projectileData, `enemy${letter}`);
    if (t !== null) bulletTypeOf.set(letter, t);
  }
  const bossStage2 = /* @__PURE__ */ new Map();
  stages.forEach((st, s) => {
    const b = bossData[`boss${s}`];
    if (!b) return;
    const owner = bossOwner(st, b);
    const own = weaponSlots(b);
    const types = bossWeaponTypes.get(s);
    types[1] = claimBulletType(own[1], owner);
    types[2] = claimBulletType(own[2], owner);
    const s2 = !(b.dezaemon && b.dezaemon.boss) ? bossStage2Record(b) : null;
    if (!s2) return;
    const claimed = /* @__PURE__ */ new Map();
    bossStage2.set(s, {
      record: s2,
      weapons: weaponSlots(s2).map((w, i) => {
        if (!w) return null;
        if (w === own[i]) return types[i];
        const first = weaponTextures(w)[0];
        if (!claimed.has(first)) claimed.set(first, claimBulletType(w, `${owner} stage 2`));
        return claimed.get(first);
      })
    });
  });
  const built = stages.map((st, s) => {
    const width = Math.max(1, st.enemylist[0] ? st.enemylist[0].length : level.width || 8);
    const spawnRows = st.enemylist.slice().reverse();
    const waveRows = Array.isArray(st.waveRows) && st.waveRows.length === st.enemylist.length ? st.waveRows.slice().reverse() : null;
    const placements = [];
    const usage = /* @__PURE__ */ new Map();
    let lastRow = FIRST_SPAWN_ROW;
    spawnRows.forEach((row, k) => {
      const scrollRow = waveRows ? clamp(Math.round(waveRows[k]), 0, PLACEMENT_ROWS - 1) : Math.min(MAX_SPAWN_ROW, FIRST_SPAWN_ROW + k * ROW_STEP);
      row.forEach((cell, c) => {
        if (!cell || cell === "00") return;
        const letter = cell.slice(0, -1);
        const drop = Number(cell.slice(-1)) || 0;
        placements.push({ row: scrollRow, col: mapColumn(c, width), letter, drop });
        if (!usage.has(letter)) usage.set(letter, { count: 0, digits: /* @__PURE__ */ new Map() });
        const u = usage.get(letter);
        u.count++;
        u.digits.set(drop, (u.digits.get(drop) || 0) + 1);
        lastRow = Math.max(lastRow, scrollRow);
      });
    });
    const taken = /* @__PURE__ */ new Set();
    const records = /* @__PURE__ */ new Map();
    const recordOf = /* @__PURE__ */ new Map();
    const letters = [...usage.keys()].sort((a, b) => usage.get(b).count - usage.get(a).count);
    const freeIndex = (band, preferred) => {
      for (let b = band; b < RECORD_ART.length; b++) {
        const def = RECORD_ART[b];
        if (preferred >= def.first && preferred < def.first + def.count && !taken.has(preferred)) return { index: preferred, band: b };
        for (let i = def.first; i < def.first + def.count; i++) {
          if (!taken.has(i)) return { index: i, band: b };
        }
      }
      return null;
    };
    const zakoArt = (letter, rec) => {
      const frames = (Array.isArray(rec.texture) ? rec.texture : []).map(lookup).filter(Boolean);
      if (!frames.length) warn(`${st.key}: enemy${letter} (${rec.name || "?"}) has no art in the atlas \u2014 placed invisible`);
      const maxW = frames.reduce((a, f) => Math.max(a, f.w), 16);
      const maxH = frames.reduce((a, f) => Math.max(a, f.h), 16);
      if (frames.length && (maxW > 64 || maxH > 64)) {
        warn(`${st.key}: enemy${letter} (${rec.name || "?"}) is ${maxW}x${maxH}; zako art tops out at 64x64 \u2014 downscaled`);
      }
      return { frames, minBand: bandFor(maxW, maxH) };
    };
    for (const letter of letters) {
      const rec = enemyData[`enemy${letter}`];
      if (!rec) {
        warn(`${st.key}: grid names enemy${letter} but enemyData has no such record \u2014 cells left empty`);
        continue;
      }
      const { frames, minBand } = zakoArt(letter, rec);
      const preferred = rec.dezaemon && Number.isInteger(rec.dezaemon.record) ? rec.dezaemon.record : -1;
      const verbatim = rec.dezaemon ? hexToBytes(rec.dezaemon.attributes, 18) : null;
      const digits = [...usage.get(letter).digits.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
      let first = null;
      for (const digit of digits) {
        const found = freeIndex(minBand, first ? -1 : preferred);
        if (!found) {
          if (!first) {
            warn(`${st.key}: no free enemy record for enemy${letter} \u2014 a stage holds 60 \u2014 cells left empty`);
            break;
          }
          warn(`${st.key}: enemy${letter} carries several drop digits and the stage is out of records \u2014 its drop-${digit} cells drop ${first.drop ? "item " + first.drop : "nothing"} instead`);
          recordOf.set(letter + digit, first.key);
          continue;
        }
        taken.add(found.index);
        const def = RECORD_ART[found.band];
        const bw = def.w * CG_CELL, bh = def.h * CG_CELL;
        const chosen = spreadFrames(frames, def.frames);
        const planKeys = chosen.map((f) => planFrame(`e:${f.key}:${bw}x${bh}`, f, bw, bh, frameGroup(f.key), 2));
        const drop = digit || 0;
        const slot = dropToSlot(drop);
        let bytes;
        if (!verbatim) {
          bytes = enemyRecordFromEditor(rec, { bulletType: bulletTypeOf.get(letter) || 0, dropSlot: slot });
        } else if (slot === null) {
          bytes = verbatim;
        } else {
          bytes = withDeathDrop(verbatim, slot);
          if (verbatim[2] >> 6 >= 2) {
            warn(`${st.key}: enemy${letter} (${rec.name || "?"}) spawns a child when it dies; on its drop-${drop} cells the drop takes that word's place`);
          }
        }
        const key = letter + digit;
        const entry = { key, letter, index: found.index, band: found.band, frames: planKeys, bytes, name: rec.name || `enemy${letter}`, drop };
        records.set(key, entry);
        recordOf.set(key, key);
        if (!first) first = entry;
      }
    }
    const childLetterOf = (rec) => {
      const k = rec && rec.dezaemon ? rec.dezaemon.deathChild : null;
      return typeof k === "string" && k.startsWith("enemy") ? k.slice("enemy".length) : null;
    };
    const spawnsChild = (entry) => entry.bytes[2] >> 6 === 2;
    const pending = [...records.values()].filter(spawnsChild);
    while (pending.length) {
      const parent = pending.shift();
      const childLetter = childLetterOf(enemyData[`enemy${parent.letter}`]);
      if (!childLetter) continue;
      let child = records.get(childLetter + 0) || records.get(childLetter + "c") || null;
      if (!child) {
        const rec = enemyData[`enemy${childLetter}`];
        if (!rec) {
          warn(`${st.key}: enemy${parent.letter} (${parent.name}) spawns enemy${childLetter} when it dies, but enemyData has no such record \u2014 it dies alone`);
          continue;
        }
        const { frames, minBand } = zakoArt(childLetter, rec);
        const preferred = rec.dezaemon && Number.isInteger(rec.dezaemon.record) ? rec.dezaemon.record : -1;
        const found = freeIndex(minBand, preferred);
        if (!found) {
          warn(`${st.key}: no free enemy record for enemy${childLetter} (${rec.name || "?"}), which enemy${parent.letter} spawns when it dies \u2014 a stage holds 60 \u2014 it dies alone`);
          continue;
        }
        taken.add(found.index);
        const def = RECORD_ART[found.band];
        const bw = def.w * CG_CELL, bh = def.h * CG_CELL;
        const planKeys = spreadFrames(frames, def.frames).map((f) => planFrame(`e:${f.key}:${bw}x${bh}`, f, bw, bh, frameGroup(f.key), 2));
        const verbatim = rec.dezaemon ? hexToBytes(rec.dezaemon.attributes, 18) : null;
        const bytes = verbatim || enemyRecordFromEditor(rec, { bulletType: bulletTypeOf.get(childLetter) || 0, dropSlot: null });
        child = { key: childLetter + "c", letter: childLetter, index: found.index, band: found.band, frames: planKeys, bytes, name: rec.name || `enemy${childLetter}`, drop: 0 };
        records.set(child.key, child);
        if (spawnsChild(child)) pending.push(child);
      }
      parent.bytes = withDeathChild(parent.bytes, child.index);
    }
    let boss = null;
    const bossRec = bossData[`boss${s}`] || (s === 0 && !bossData.boss0 ? null : null);
    if (bossRec) {
      const names = bossRec.anim && Array.isArray(bossRec.anim.idle) ? [...bossRec.anim.idle, ...Array.isArray(bossRec.anim.attack) ? bossRec.anim.attack : []] : Array.isArray(bossRec.texture) ? bossRec.texture : [];
      const frames = names.map(lookup).filter(Boolean);
      const dz = bossRec.dezaemon || {};
      const maxW = frames.reduce((a, f) => Math.max(a, f.w), 64);
      const maxH = frames.reduce((a, f) => Math.max(a, f.h), 64);
      const sizeClass = Number.isInteger(dz.sizeClass) ? dz.sizeClass & 3 : bossClassFor(maxW, maxH);
      const geom = BOSS_CORE_GEOM[sizeClass];
      const bw = geom.w * CG_CELL, bh = geom.h * CG_CELL;
      if (frames.length && (maxW > bw || maxH > bh)) {
        warn(`${st.key}: boss (${bossRec.name || "?"}) is ${maxW}x${maxH}; class F${sizeClass} art is ${bw}x${bh} \u2014 downscaled`);
      }
      if (!frames.length) warn(`${st.key}: boss (${bossRec.name || "?"}) has no art in the atlas \u2014 its core is unpainted`);
      const chosen = spreadFrames(frames, geom.frames);
      const planKeys = chosen.map((f) => planFrame(`boss:${f.key}:${bw}x${bh}`, f, bw, bh, `boss${s}`, 2));
      const row = Number.isInteger(dz.row) ? clamp(dz.row, 0, PLACEMENT_ROWS - 1) : Math.min(PLACEMENT_ROWS - 8, lastRow + BOSS_ROW_GAP);
      const col = Number.isInteger(dz.col) ? clamp(dz.col, 0, PLACEMENT_COLS - 1) : BOSS_COL;
      const decoded = dz.boss || null;
      const weaponTypes = bossWeaponTypes.get(s) || [null, null, null];
      const fireType = (type) => type <= 2 ? weaponTypes[type] ?? weaponTypes[0] ?? type : type;
      const remapFirePoints = (fps) => fps.map((fp) => ({ ...fp, type: fireType(fp.type) }));
      const second = bossStage2.get(s) || null;
      let stage2 = null;
      let fight = {
        hpStages: 2,
        patterns: DEFAULT_BOSS_PATTERNS.map((p) => ({ ...p, firePoints: remapFirePoints(p.firePoints) }))
      };
      if (second && !decoded) {
        const { hpStages, bands } = saturnStage2Bands(second.record.hpBelow);
        const w2 = second.weapons;
        const fireType2 = (type) => type <= 2 ? w2[type] ?? w2[0] ?? fireType(type) : type;
        const remap2 = (fps) => fps.map((fp) => ({ ...fp, type: fireType2(fp.type) }));
        const [p0, p1, p2] = DEFAULT_BOSS_PATTERNS;
        const first = [0, 0, 1, 1], last = [2, 2, 3, 3];
        fight = {
          hpStages,
          playlist: [0, 1, 2, 3].map((k) => k < hpStages - bands ? first : last),
          patterns: [
            { ...p0, firePoints: remapFirePoints(p0.firePoints) },
            { ...p2, firePoints: remapFirePoints(p2.firePoints) },
            { ...p1, firePoints: remap2(p1.firePoints) },
            { ...p2, firePoints: remap2(p2.firePoints) }
          ]
        };
        stage2 = { hpStages, bands, hpBelow: second.record.hpBelow, weapons: w2 };
      }
      const trailer = encodeBossTrailer(decoded ? {
        sizeClass,
        hpStages: decoded.hpStages,
        rotate: decoded.rotate,
        deathSpin: decoded.deathSpin,
        hp: decoded.hp,
        score: decoded.score,
        optionFlag: decoded.optionFlag,
        playlist: decoded.playlist,
        arrive: decoded.arrive,
        death: decoded.death,
        patterns: (decoded.patterns || []).map((p) => ({
          moveScript: p.moveScript,
          moveSpeed: p.moveSpeed,
          fireTickFrames: p.fireTickFrames,
          firePoints: remapFirePoints((p.firePoints || []).map((fp) => ({ dx: fp.dx, dy: fp.dy, type: fp.type, rate: fp.rate, param: fp.param })))
        }))
      } : {
        sizeClass,
        hp: Math.max(1, Number(bossRec.hp) || 100) * BOSS_UNITS_PER_HIT,
        score: Number(bossRec.score) || BOSS_SCORE_TABLE[2],
        optionFlag: false,
        ...fight
      });
      boss = { sizeClass, row, col, frames: planKeys, trailer, name: bossRec.name || `boss${s}`, weapons: weaponTypes, rowFromWaves: !Number.isInteger(dz.row) };
      if (stage2) boss.stage2 = stage2;
      else if (second) warn(`${st.key}: boss (${bossRec.name || "?"}) keeps its cart's own trailer \u2014 its stage2 block is not written`);
      lastRow = Math.max(lastRow, row);
    }
    const items = [];
    for (const it of Array.isArray(st.items) ? st.items : []) {
      if (!Number.isInteger(it.row) || !Number.isInteger(it.col)) continue;
      items.push({ row: clamp(it.row, 0, PLACEMENT_ROWS - 1), col: mapColumn(it.col, PLACEMENT_COLS), slot: (it.slot ?? 0) & 7 });
    }
    let background = null;
    const cells = Array.isArray(level.backgroundCells) ? level.backgroundCells : null;
    if (opts.useBackground && st.background && st.background.tiles && cells) {
      try {
        const bytes = b64ToBytes(st.background.tiles);
        const cols = st.background.cols || BG_COLS;
        const words = new Uint16Array(bytes.length >> 1);
        for (let i = 0; i < words.length; i++) words[i] = bytes[i * 2] << 8 | bytes[i * 2 + 1];
        const planKeys = /* @__PURE__ */ new Map();
        for (const w of words) {
          if (w === 65535) continue;
          const ordinal = w & 1023;
          if (planKeys.has(ordinal)) continue;
          const frame = lookup(cells[ordinal]);
          if (!frame) {
            planKeys.set(ordinal, null);
            continue;
          }
          planKeys.set(ordinal, planFrame(`bg:${frame.key}`, frame, 16, 16, "background", 5));
        }
        background = { cols, words, planKeys };
      } catch (e) {
        warn(`${st.key}: could not read the background grid (${e.message}) \u2014 scenery skipped`);
      }
    }
    let curve = null;
    let extent = null;
    if (st.scroll && typeof st.scroll === "object") {
      if (st.scroll.curve) {
        try {
          const c = b64ToBytes(st.scroll.curve);
          if (c.length === SEC5_REGIONS.scrollCurves.stride) curve = c;
        } catch (_e) {
        }
      }
      if (Number.isInteger(st.scroll.loopPart) && Number.isInteger(st.scroll.endPart)) {
        extent = [st.scroll.loopPart, st.scroll.endPart];
      }
    }
    const extentFromRows = !extent;
    if (!extent) extent = extentAfter(lastRow);
    return { key: st.key, placements, records, recordOf, boss, items, background, curve, extent, extentFromRows, lastRow, story: null };
  });
  const importedIcons = importedSlots && level.dezaemonItems && Array.isArray(level.dezaemonItems.icons) ? level.dezaemonItems.icons : null;
  const itemKeys = itemSlotBytes.map((b, i) => {
    const type = b & 15;
    const own = importedIcons ? lookup(importedIcons[i]) : null;
    const letter = importedSlots ? EMBLEM_LETTER_BY_TYPE[type] || null : DEFAULT_ITEM_LETTERS[i];
    const supplied = letter && opts.itemEmblems ? opts.itemEmblems[letter] : null;
    const frame = own ? own : supplied && supplied.rgba && supplied.w > 0 && supplied.h > 0 ? supplied : itemIcon(type);
    return planFrame(`item:${i}:${type}`, frame, 16, 16, "items", 3);
  });
  const blastAKeys = blastFrames(16).map((f, i) => planFrame(`blastA:${i}`, f, 16, 16, "blast", 3));
  const blastBKeys = blastFrames(32).map((f, i) => planFrame(`blastB:${i}`, f, 32, 32, "blast", 3));
  const titleLayout = level.dezaemonTitleScreen && level.dezaemonTitleScreen.layout || {};
  const drawnTitle = (role) => lookup(level.dezaemonTitle && level.dezaemonTitle[role]);
  const titleW = TITLE_SLOTS.title1.w * CG_CELL, titleH = TITLE_SLOTS.title1.h * CG_CELL;
  const subtitleH = CG_CELL;
  const uploaded1 = opts.title1 && opts.title1.rgba ? opts.title1 : null;
  const uploaded2 = opts.title2 && opts.title2.rgba ? opts.title2 : null;
  const ownG = !uploaded1 && !uploaded2 && !drawnTitle("title1") && !drawnTitle("title2") && opts.titleG && opts.titleG.rgba ? trimRgba(opts.titleG, ALPHA_CUTOFF) : null;
  const title1Art = uploaded1 || drawnTitle("title1") || ownG;
  const title2Art = uploaded2 || drawnTitle("title2");
  const hasTitle1 = !!title1Art;
  const hasTitle2 = !!title2Art;
  const placed = (art3, role, box) => {
    const at = !uploaded1 && !uploaded2 && !ownG ? titleLayout[role] : null;
    if (at && Number.isInteger(at.x) && Number.isInteger(at.y)) {
      return placeRgba(art3, Math.min(art3.w, titleW), Math.min(art3.h, titleH), titleW, titleH, at.x, at.y);
    }
    return box ? placeRgba(art3, titleW, box.h, titleW, titleH, 0, box.y) : art3;
  };
  const title1Key = hasTitle1 ? planFrame(
    "title1",
    placed(title1Art, "title1", hasTitle2 ? { h: titleH - subtitleH, y: 0 } : null),
    titleW,
    titleH,
    "title1",
    4
  ) : null;
  const title2Key = hasTitle2 ? planFrame(
    "title2",
    placed(title2Art, "title2", hasTitle1 ? { h: subtitleH, y: titleH - subtitleH } : null),
    titleW,
    titleH,
    "title2",
    4
  ) : null;
  const attribution = resolveAttribution(level, opts, warn);
  const typedCredits = attribution.source !== "cart" && attribution.source !== "none";
  const stripW = TITLE_SLOTS.credits[0].w * CG_CELL, stripH = TITLE_SLOTS.credits[0].h * CG_CELL;
  const creditKeys = TITLE_SLOTS.credits.map((_slot, i) => {
    if (typedCredits) {
      const credit = attribution.credits[Math.floor(i / NAMES_PER_ROLE)];
      const name = credit && credit.names[i % NAMES_PER_ROLE];
      if (!name) return null;
      const strip = creditStripRgba(name);
      if (!strip) {
        warn(`credit "${name}" has no character the staff roll's face can draw \u2014 left off the cart`);
        return null;
      }
      if (strip.dropped) warn(`credit "${name}": no glyph for "${strip.dropped}" \u2014 drawn as "${strip.lines.join(" / ")}"`);
      if (strip.truncated) warn(`credit "${name}" is longer than a strip holds \u2014 cut to "${strip.lines.join(" / ")}"`);
      return planFrame(`credit${i}`, strip, stripW, stripH, "credits", 4);
    }
    const art3 = drawnTitle(`credit${i}`);
    if (!art3) return null;
    const at = titleLayout.credits && titleLayout.credits[i];
    const frame = at && Number.isInteger(at.x) && Number.isInteger(at.y) ? placeRgba(art3, Math.min(art3.w, stripW), Math.min(art3.h, stripH), stripW, stripH, at.x, at.y) : art3;
    return planFrame(`credit${i}`, frame, stripW, stripH, "credits", 4);
  });
  const pd = level.playerData || {};
  const shotFrames = [];
  const seenShots = /* @__PURE__ */ new Set();
  for (const mode of ["shootNormal", "shoot3way", "shootBig"]) {
    const tex = pd[mode] && Array.isArray(pd[mode].texture) ? pd[mode].texture : [];
    for (const f of tex.map(lookup).filter(Boolean)) {
      if (seenShots.has(f.key)) continue;
      seenShots.add(f.key);
      shotFrames.push(f.w > f.h ? { ...rotateCcwRgba(f), key: f.key } : f);
    }
  }
  let shotN = 0, bombN = 0, sparkN = 0;
  const weaponKeys = GLOBAL_WEAPON_SLOTS.map((slot, i) => {
    const w = slot.w * CG_CELL, h = slot.h * CG_CELL;
    const tint = SHOT_TINTS[i % SHOT_TINTS.length];
    switch (slot.role) {
      case "shot": {
        const f = shotFrames.length ? shotFrames[shotN++ % shotFrames.length] : null;
        return f ? planFrame(`weapon:${f.key}:${w}x${h}`, f, w, h, "weapon", 3) : planFrame(`weapon:shot:${i}`, shotSprite(w, h, tint), w, h, "weapon", 3);
      }
      case "missile":
      case "missileTall":
        return planFrame(`weapon:missile:${w}x${h}`, missileSprite(w, h), w, h, "weapon", 3);
      case "beamV":
      case "beamH":
        return planFrame(`weapon:beam:${w}x${h}`, beamSprite(w, h), w, h, "weapon", 3);
      case "charge":
        return planFrame("weapon:charge", glowSprite(w), w, h, "weapon", 3);
      case "dome":
        return planFrame("weapon:dome", domeSprite(w, h), w, h, "weapon", 3);
      case "smoke":
        return planFrame("weapon:smoke", puffSprite(w), w, h, "weapon", 3);
      case "option":
        return planFrame(`weapon:option:${shipFrames[0].key}`, shipFrames[0], w, h, "player", 3);
      case "bomb":
        return blastBKeys[bombN++ % 2 ? 4 : 2];
      case "spark":
        return blastAKeys[sparkN++ % 2 ? 2 : 0];
      default:
        return null;
    }
  });
  const playerShotKeys = PLAYER_SHOT_SLOTS.map((slot, i) => {
    const w = slot.w * CG_CELL, h = slot.h * CG_CELL;
    const f = shotFrames.length ? shotFrames[i % shotFrames.length] : null;
    const tint = SHOT_TINTS[i % SHOT_TINTS.length];
    return f ? planFrame(`pshot:${i}:${f.key}:${w}x${h}`, f, w, h, "weapon", 3) : planFrame(`pshot:${i}:${w}x${h}`, shotSprite(w, h, tint), w, h, "weapon", 3);
  });
  const planned = [...plan.values()];
  const q = quantizeFrames(planned, opts.palette);
  const indexedByKey = new Map(q.frames.map((f) => [f.key, f]));
  const packer = new CgPacker();
  const refsByKey = /* @__PURE__ */ new Map();
  const fullWarned = /* @__PURE__ */ new Set();
  for (const f of planned.slice().sort((a, b) => a.priority - b.priority)) {
    const idx = indexedByKey.get(f.key);
    try {
      refsByKey.set(f.key, packer.addFrame(idx.indexed, f.w, f.h));
    } catch (e) {
      if (!(e instanceof CgFullError)) throw e;
      if (!fullWarned.has(f.group)) {
        fullWarned.add(f.group);
        warn(`CG pages full (1024 cells): ${f.group} art left unpainted`);
      }
      refsByKey.set(f.key, null);
    }
  }
  const refsOf = (key, count) => {
    const r = key ? refsByKey.get(key) : null;
    return r || new Uint16Array(count).fill(EMPTY_REF);
  };
  const painted = (key) => !!(key && refsByKey.get(key));
  const storyCandidates = [];
  for (const sb of Array.isArray(opts.storyBackdrops) ? opts.storyBackdrops : []) {
    const b = built[sb && sb.stage];
    if (!b) continue;
    if (b.background) {
      warn(`${b.key}: keeps its own scenery \u2014 its story is not drawn`);
      continue;
    }
    const variants = (Array.isArray(sb.variants) ? sb.variants : []).filter(
      (v) => v && v.w === BG_COLS * CG_CELL && v.h > 0 && v.h % CG_CELL === 0 && v.h <= BG_ROWS * CG_CELL && v.rgba && v.rgba.length >= v.w * v.h * 4
    );
    if (variants.length) storyCandidates.push({ stage: sb.stage, variants, indexed: /* @__PURE__ */ new Map() });
    else warn(`${b.key}: its story is not ${BG_COLS * CG_CELL} px wide in whole 16-px rows \u2014 not drawn`);
  }
  const storyFrame = (c, v) => {
    if (!c.indexed.has(v)) {
      const [f] = indexWithBank([{ key: `story:${c.stage}:${v.label}`, w: v.w, h: v.h, rgba: v.rgba }], q.bank, opts.palette);
      c.indexed.set(v, { indexed: f.indexed, w: v.w, h: v.h });
    }
    return c.indexed.get(v);
  };
  const pickAt = (k) => storyCandidates.map((c) => ({ c, v: c.variants[Math.min(k, c.variants.length - 1)] }));
  let storyPicks = [];
  const sizes = storyCandidates.reduce((n, c) => Math.max(n, c.variants.length), 0);
  for (let k = 0; k < sizes; k++) {
    const picks = pickAt(k);
    if (packer.cellsNeeded(picks.map(({ c, v }) => storyFrame(c, v))) <= packer.free) {
      storyPicks = picks;
      break;
    }
  }
  if (!storyPicks.length && storyCandidates.length) {
    storyPicks = pickAt(sizes - 1).filter(({ c, v }) => {
      if (packer.cellsNeeded([storyFrame(c, v)]) <= packer.free) return true;
      warn(`${built[c.stage].key}: no CG cells left for its story \u2014 not drawn`);
      return false;
    });
  }
  for (const { c, v } of storyPicks) {
    const before = packer.used;
    let refs;
    try {
      const f = storyFrame(c, v);
      refs = packer.addFrame(f.indexed, f.w, f.h);
    } catch (e) {
      if (!(e instanceof CgFullError)) throw e;
      warn(`${built[c.stage].key}: no CG cells left for its story \u2014 not drawn`);
      continue;
    }
    const b = built[c.stage];
    const rows = v.h / CG_CELL;
    const top = STORY_FIRST_ROW + rows;
    const shift = top + STORY_LEAD_ROWS;
    for (const p of b.placements) p.row = Math.min(PLACEMENT_ROWS - 1, p.row + shift);
    if (b.boss && b.boss.rowFromWaves) b.boss.row = Math.min(PLACEMENT_ROWS - 8, b.boss.row + shift);
    b.lastRow = Math.min(PLACEMENT_ROWS - 1, b.lastRow + shift);
    if (b.extentFromRows) b.extent = extentAfter(b.lastRow, top);
    const curve = b.curve ? b.curve.slice() : new Uint8Array(SEC5_REGIONS.scrollCurves.stride).fill(DEFAULT_SCROLL_BYTE);
    for (let i = 0; i < Math.min(curve.length, Math.ceil(top / 4)); i++) {
      curve[i] = curve[i] & ~7 | STORY_SCROLL_SPEEDS[Math.min(i, STORY_SCROLL_SPEEDS.length - 1)];
    }
    b.curve = curve;
    b.story = { size: v.label, rows, cols: v.w / CG_CELL, refs, cells: packer.used - before };
  }
  const sec5 = new Uint8Array(SECTION_SIZES[5]);
  const putWord2 = (at, w) => {
    sec5[at] = w >> 8;
    sec5[at + 1] = w & 255;
  };
  sec5.fill(255, SEC5_REGIONS.stageBanks.offset, SEC5_REGIONS.stageBanks.offset + SEC5_REGIONS.stageBanks.count * SEC5_REGIONS.stageBanks.stride);
  sec5.fill(255, SEC5_REGIONS.spriteBank.offset, SEC5_REGIONS.spriteStages.offset + SEC5_REGIONS.spriteStages.count * SEC5_REGIONS.spriteStages.stride);
  sec5.fill(DEFAULT_SCROLL_BYTE, SEC5_REGIONS.scrollCurves.offset, SEC5_REGIONS.scrollCurves.offset + SEC5_REGIONS.scrollCurves.count * SEC5_REGIONS.scrollCurves.stride);
  const extents = [];
  built.forEach((b, s) => {
    const placeBase = SEC5_REGIONS.placement.offset + s * SEC5_REGIONS.placement.stride;
    for (const p of b.placements) {
      const rec = b.records.get(b.recordOf.get(p.letter + p.drop));
      if (!rec) continue;
      sec5[placeBase + p.row * PLACEMENT_COLS + p.col] = zakoPlacementId(rec.index);
    }
    for (const it of b.items) {
      const at = placeBase + it.row * PLACEMENT_COLS + it.col;
      if (!sec5[at]) sec5[at] = 232 | it.slot;
    }
    const enemyBase = SEC5_REGIONS.enemies.offset + s * SEC5_REGIONS.enemies.stride;
    const bankBase = SEC5_REGIONS.spriteStages.offset + s * SEC5_REGIONS.spriteStages.stride;
    for (const rec of b.records.values()) {
      sec5.set(rec.bytes, enemyBase + rec.index * 18);
      const def = RECORD_ART[rec.band];
      const cellsPerFrame = def.w * def.h;
      const slot = bankBase + def.base + (rec.index - def.first) * def.frames * cellsPerFrame * 2;
      rec.frames.forEach((key, f) => {
        const refs = refsOf(key, cellsPerFrame);
        for (let c = 0; c < cellsPerFrame; c++) putWord2(slot + (f * cellsPerFrame + c) * 2, refs[c]);
      });
    }
    if (b.boss) {
      sec5[placeBase + b.boss.row * PLACEMENT_COLS + b.boss.col] = 240 | b.boss.sizeClass;
      sec5.set(b.boss.trailer, enemyBase + BOSS_TRAILER_OFFSET);
      const geom = BOSS_CORE_GEOM[b.boss.sizeClass];
      const cellsPerFrame = geom.w * geom.h;
      const order = coreCellOrder(geom.w, geom.h);
      b.boss.frames.forEach((key, f) => {
        const refs = refsOf(key, cellsPerFrame);
        for (let c = 0; c < cellsPerFrame; c++) {
          putWord2(bankBase + BOSS_CORE_OFFSET + (f * cellsPerFrame + order[c]) * 2, refs[c]);
        }
      });
    }
    if (b.curve) sec5.set(b.curve, SEC5_REGIONS.scrollCurves.offset + s * SEC5_REGIONS.scrollCurves.stride);
    extents.push(b.extent);
    if (b.background) {
      const bgBase = SEC5_REGIONS.stageBanks.offset + s * SEC5_REGIONS.stageBanks.stride;
      const cols = b.background.cols;
      const rows = Math.min(BG_ROWS, Math.floor(b.background.words.length / cols));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < Math.min(cols, BG_COLS); c++) {
          const w = b.background.words[r * cols + c];
          if (w === 65535) continue;
          const key = b.background.planKeys.get(w & 1023);
          const refs = key ? refsByKey.get(key) : null;
          if (!refs || refs[0] === EMPTY_REF) continue;
          const h = (w & 32768) !== 0, v = (w & 16384) !== 0;
          let ref = refs[0];
          if (h) ref ^= REF_HFLIP;
          if (v) ref ^= REF_VFLIP;
          putWord2(bgBase + (r * BG_COLS + c) * 2, ref);
        }
      }
    }
    if (b.story) {
      const bgBase = SEC5_REGIONS.stageBanks.offset + s * SEC5_REGIONS.stageBanks.stride;
      const { rows, cols, refs } = b.story;
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const ref = refs[cy * cols + cx];
          if (ref !== EMPTY_REF) putWord2(bgBase + ((STORY_FIRST_ROW + rows - 1 - cy) * BG_COLS + cx) * 2, ref);
        }
      }
    }
  });
  const gb = SEC5_REGIONS.spriteBank.offset;
  const putRefs = (slot, refs) => refs.forEach((r, i) => putWord2(gb + (slot + i) * 2, r));
  for (const pose of [GLOBAL_SLOTS.shipBankA, GLOBAL_SLOTS.shipIdle, GLOBAL_SLOTS.shipBankB]) {
    shipIdle.forEach((key, f) => putRefs(pose + f * 4, refsOf(key, 4)));
  }
  itemKeys.forEach((key, i) => putRefs(GLOBAL_SLOTS.items + i, refsOf(key, 1)));
  blastAKeys.forEach((key, i) => putRefs(GLOBAL_SLOTS.blastA + i, refsOf(key, 1)));
  blastBKeys.forEach((key, i) => putRefs(GLOBAL_SLOTS.blastB + i * 4, refsOf(key, 4)));
  bulletTypes.forEach((b, t) => b && b.frames.forEach((key, f) => putRefs(GLOBAL_SLOTS.bullets + t * 4 + f, refsOf(key, 1))));
  bulletTypes.forEach((b, t) => {
    if (!b || !b.engine) return;
    BULLET_ENGINE_SLOTS[t].forEach((slot, f) => putRefs(slot.ref, refsOf(b.engine[f], slot.w * slot.h)));
  });
  weaponKeys.forEach((key, i) => {
    const slot = GLOBAL_WEAPON_SLOTS[i];
    putRefs(slot.first, refsOf(key, slot.w * slot.h));
  });
  playerShotKeys.forEach((key, i) => {
    const slot = PLAYER_SHOT_SLOTS[i];
    putRefs(slot.ref, refsOf(key, slot.w * slot.h));
  });
  for (const pose of [GLOBAL_SLOTS.ship2BankA, GLOBAL_SLOTS.ship2Idle, GLOBAL_SLOTS.ship2BankB]) {
    ship2Idle.forEach((key, f) => putRefs(pose + f * 4, refsOf(key, 4)));
  }
  if (title1Key) putRefs(TITLE_SLOTS.title1.first, refsOf(title1Key, 32));
  if (title2Key) putRefs(TITLE_SLOTS.title2.first, refsOf(title2Key, 32));
  creditKeys.forEach((key, i) => {
    if (!key) return;
    const slot = TITLE_SLOTS.credits[i];
    putRefs(slot.first, refsOf(key, slot.w * slot.h));
  });
  const bgm = level.dezaemonBgm && typeof level.dezaemonBgm === "object" ? level.dezaemonBgm : null;
  const bgmTable = new Array(24).fill(0);
  if (bgm) {
    (bgm.special || []).slice(0, 4).forEach((v, i) => {
      bgmTable[i] = v;
    });
    (bgm.stages || []).slice(0, 10).forEach((pair, s) => {
      if (Array.isArray(pair)) {
        bgmTable[4 + s * 2] = pair[0] ?? 0;
        bgmTable[5 + s * 2] = pair[1] ?? 0;
      }
    });
  }
  const bulletBytes = [0, 1, 2].map((t) => {
    const cfg = level.dezaemonBullets && level.dezaemonBullets.configs && level.dezaemonBullets.configs[t];
    if (cfg && Number.isInteger(cfg.raw)) return cfg.raw;
    const b = bulletTypes[t];
    if (!b) return DEFAULT_BULLET_CONFIG;
    const add = nearestIndex([0.5, 1, 2, 3.5], b.speed * RUNTIME_TO_SATURN_SPEED);
    return 3 | add << 4;
  });
  const ts = level.dezaemonTitleScreen || {};
  const entrance = ts.entrance && ts.entrance.title2 && ts.entrance.title1 ? [...ts.entrance.title2.raw || [0, 0], ...ts.entrance.title1.raw || [0, 0]] : DEFAULT_TITLE_ENTRANCE;
  const settings = encodeSettings({
    gameMode: opts.gameMode,
    stageCount: built.length,
    itemSlots: itemSlotBytes,
    bullets: bulletBytes,
    titleEntrance: entrance,
    extents,
    bgmTable,
    sfxSet: bgm && Number.isInteger(bgm.sfxSet) ? bgm.sfxSet : 1,
    // The labels belong to whoever the strips belong to.
    staffRoles: typedCredits ? staffRolesFor(attribution.credits) : Array.isArray(ts.staffRoles) && ts.staffRoles.length === 3 ? ts.staffRoles : DEFAULT_STAFF_ROLES
  });
  sec5.set(settings, SEC5_REGIONS.settings.offset);
  const sec6 = emptySongBank();
  if (bgm && bgm.songs && typeof bgm.songs === "object") {
    for (const [idx, b64] of Object.entries(bgm.songs)) {
      const slot = Number(idx);
      if (!Number.isInteger(slot) || slot < 0 || slot >= SONG_SLOTS) continue;
      try {
        const bytes = b64ToBytes(b64);
        if (bytes.length === SONG_SIZE) sec6.set(bytes, slot * SONG_SIZE);
        else warn(`song slot ${slot} is ${bytes.length} bytes, not ${SONG_SIZE} \u2014 skipped`);
      } catch (e) {
        warn(`song slot ${slot} could not be read (${e.message})`);
      }
    }
  }
  const sec7 = encodeModels(level.dezaemonModels, { warn });
  const sections = [
    ...packer.pages,
    bankToSec4(q.bank),
    sec5,
    sec6,
    sec7
  ];
  return {
    sections,
    bank: q.bank,
    warnings,
    report: {
      palette: q.report,
      stages: built.map((b) => ({
        key: b.key,
        placements: b.placements.length,
        records: [...b.records.values()].map((r) => ({ name: r.name, record: r.index, band: r.band, ...r.drop ? { drop: r.drop } : {} })),
        // weapons: the global bullet type each of the boss's own
        // weapons A/B/C landed in, null where it carries none.
        // stage2: the hp stages a second stage rides on and the types
        // its weapons landed in (bossStage2 above).
        boss: b.boss ? { name: b.boss.name, sizeClass: b.boss.sizeClass, row: b.boss.row, col: b.boss.col, weapons: b.boss.weapons, ...b.boss.stage2 ? { stage2: b.boss.stage2 } : {} } : null,
        items: b.items.length,
        background: !!b.background,
        // What of the stage's story landed on its opening rows, if any.
        story: b.story ? { size: b.story.size, rows: b.story.rows, cells: b.story.cells } : null,
        extent: b.extent
      })),
      ship: shipSource,
      transform: saturnTransform(built, bulletTypes),
      player2: ship2Idle.length > 0,
      bulletTypes: paintedTypes(),
      weaponArt: { slots: weaponKeys.filter(Boolean).length, levelShotFrames: shotFrames.length },
      frames: planned.length,
      cells: packer.used,
      sharedCells: packer.shared,
      title: {
        // What actually landed on the cart, not what was planned: on a
        // save dense enough to fill the CG pages the packer drops these
        // last and says so, and the report must agree with the bytes.
        title1: painted(title1Key),
        title2: painted(title2Key),
        credits: creditKeys.filter(painted).length,
        // Where the art came from, so a caller can say whether the cart
        // kept its own title screen or wears an uploaded one.
        source: uploaded1 || uploaded2 ? "uploaded" : ownG ? painted(title1Key) ? "titleG" : "none" : painted(title1Key) || painted(title2Key) ? "cart" : "none"
      },
      // Who the staff roll credits and on whose say-so (attribution.js):
      // "option" | "level" | "cart" | "default" | "none". `credits` is
      // the typed roll; a cart's own strips are art and count above.
      attribution: { source: attribution.source, credits: attribution.credits }
    }
  };
}

// packages/shmup-engine/src/audio/song-write.js
var SONG_STEPS = MEASURES * STEPS_PER_MEASURE;
var CONTROL_DEFAULT = Object.freeze([0, 0, 128, 3]);
var PITCH_TO_MIDI = 35;
var MIDI_MIN = NOTE_MIN + PITCH_TO_MIDI;
var MIDI_MAX = NOTE_MAX + PITCH_TO_MIDI;
var INSTRUMENT_MAX = 127;
var TIE = 128;
function midiToPitch(midi) {
  const m = Math.round(midi);
  if (m < MIDI_MIN || m > MIDI_MAX) return null;
  return m - PITCH_TO_MIDI;
}
function foldMidiToPitch(midi) {
  let m = Math.round(midi);
  if (!Number.isFinite(m)) return null;
  while (m < MIDI_MIN) m += 12;
  while (m > MIDI_MAX) m -= 12;
  return m - PITCH_TO_MIDI;
}
function pitchToMidi(pitch) {
  return pitch + PITCH_TO_MIDI;
}
function stepSecondsOf(tempoIndex) {
  return TEMPO_TABLE[tempoIndex & 31] / 240;
}
function tempoIndexForStepSeconds(stepSeconds) {
  let best = 0;
  let bestErr = Infinity;
  for (let i = 0; i < TEMPO_TABLE.length; i++) {
    const err = Math.abs(Math.log(stepSecondsOf(i) / stepSeconds));
    if (err < bestErr) {
      bestErr = err;
      best = i;
    }
  }
  return best;
}
function tempoIndexForBpm(bpm) {
  return tempoIndexForStepSeconds(60 / bpm / 4);
}
function bpmOfTempoIndex(tempoIndex) {
  return 60 / (stepSecondsOf(tempoIndex) * 4);
}
function fail(what) {
  throw new RangeError(`song-write: ${what}`);
}
function checkInt(v, lo, hi, what) {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    fail(`${what} must be an integer ${lo}..${hi}, got ${v}`);
  }
  return v;
}
function stepOffsets(part, step) {
  const m = Math.floor(step / STEPS_PER_MEASURE);
  const st = step % STEPS_PER_MEASURE;
  const base = SONG_HEADER + m * MEASURE_SIZE + MEASURE_HEADER + part * PART_BLOCK;
  return [base + VOICE_OFFSET + st, base + PITCH_OFFSET + st];
}
function encodeDezaSong(song = {}) {
  const bytes = new Uint8Array(SONG_SIZE);
  const tempoIndex = checkInt(song.tempoIndex ?? 15, 0, 31, "tempoIndex");
  const echo = checkInt(song.echo ?? 3, 0, 7, "echo");
  const loopStart = checkInt(song.loopStart ?? 0, 0, MEASURES - 1, "loopStart");
  const loopEnd = checkInt(song.loopEnd ?? MEASURES - 1, 0, MEASURES - 1, "loopEnd");
  if (loopEnd < loopStart) fail(`loopEnd ${loopEnd} is before loopStart ${loopStart}`);
  bytes[SONG_LOOP_START_OFFSET] = loopStart;
  bytes[SONG_LOOP_END_OFFSET] = loopEnd;
  bytes[SONG_ECHO_OFFSET] = echo;
  bytes[SONG_TEMPO_OFFSET] = tempoIndex;
  for (let m = 0; m < MEASURES; m++) {
    bytes.set(CONTROL_DEFAULT, SONG_HEADER + m * MEASURE_SIZE);
  }
  const parts = Array.isArray(song.parts) ? song.parts : [];
  if (parts.length > PARTS) fail(`${parts.length} parts; a song has ${PARTS}`);
  for (let p = 0; p < parts.length; p++) {
    const events = parts[p] || [];
    if (!Array.isArray(events)) fail(`part ${p} is not an array of events`);
    const sorted = events.slice().sort((a, b) => a.step - b.step);
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      const step = checkInt(e.step, 0, SONG_STEPS - 1, `part ${p} event ${i} step`);
      const note = checkInt(e.note ?? e.pitch, NOTE_MIN, NOTE_MAX, `part ${p} step ${step} note`);
      const instrument = checkInt(
        e.instrument ?? e.inst ?? 0,
        0,
        INSTRUMENT_MAX,
        `part ${p} step ${step} instrument`
      );
      const len = checkInt(e.len ?? 1, 1, SONG_STEPS, `part ${p} step ${step} len`);
      if (i > 0 && sorted[i - 1].step === step) {
        fail(`part ${p} has two events on step ${step}`);
      }
      const next = i + 1 < sorted.length ? sorted[i + 1].step : SONG_STEPS;
      const end = Math.min(step + len, next, SONG_STEPS);
      const [v0, p0] = stepOffsets(p, step);
      bytes[v0] = instrument;
      bytes[p0] = note;
      for (let s = step + 1; s < end; s++) {
        const [v, q] = stepOffsets(p, s);
        bytes[v] = TIE;
        bytes[q] = note;
      }
    }
  }
  return bytes;
}
function cellsToEvents(cells) {
  const events = [];
  let current = null;
  for (let step = 0; step < cells.length && step < SONG_STEPS; step++) {
    const c = cells[step];
    if (!c) {
      current = null;
      continue;
    }
    if (c.tie && current) {
      current.len = step - current.step + 1;
      continue;
    }
    current = {
      step,
      note: c.note ?? c.pitch,
      instrument: c.instrument ?? c.inst ?? 0,
      len: 1
    };
    events.push(current);
  }
  return events;
}
function bytesToB64(bytes) {
  if (typeof btoa === "function") {
    let s = "";
    for (let i = 0; i < bytes.length; i += 32768) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    }
    return btoa(s);
  }
  return Buffer.from(bytes).toString("base64");
}
function buildDezaemonBgm(options = {}) {
  const slots = (options.songs || []).map((s, i) => {
    if (!(s instanceof Uint8Array) || s.length !== SONG_SIZE) {
      fail(`songs[${i}] is not a ${SONG_SIZE}-byte slot`);
    }
    return s;
  });
  if (!slots.length) fail("no songs");
  if (slots.length > SONG_SLOTS) fail(`${slots.length} songs; a bank holds ${SONG_SLOTS}`);
  const n = slots.length;
  const last = n - 1;
  const silent = n < SONG_SLOTS ? n : last;
  const songs = {};
  const tempos = {};
  slots.forEach((s, i) => {
    songs[String(i)] = bytesToB64(s);
    tempos[String(i)] = stepSecondsOf(s[SONG_TEMPO_OFFSET]);
  });
  let stages = options.stages;
  if (!Array.isArray(stages)) {
    const stageCount = Math.max(1, Math.min(10, options.stageCount || Math.ceil(n / 2)));
    stages = [];
    for (let r = 0; r < stageCount; r++) {
      const main = Math.min(Math.floor(r * n / stageCount), last);
      stages.push([main, Math.min(main + 1, last)]);
    }
  }
  stages.forEach((pair, r) => {
    if (!Array.isArray(pair) || pair.length !== 2) fail(`stages[${r}] is not a [main, boss] pair`);
    pair.forEach((slot, k) => checkInt(slot, 0, SONG_SLOTS - 1, `stages[${r}][${k}]`));
  });
  if (stages.length > 10) fail(`${stages.length} stage pairs; the table holds 10`);
  const special = Array.isArray(options.special) ? options.special : [0, silent, silent, last];
  if (special.length !== 4) fail("special must be [title, gameover, clear, ending]");
  special.forEach((slot, k) => checkInt(slot, 0, SONG_SLOTS - 1, `special[${k}]`));
  const out = {
    sfxSet: checkInt(options.sfxSet ?? 1, 1, 3, "sfxSet"),
    special: special.slice(),
    stages: stages.map((p) => p.slice()),
    songs,
    tempos
  };
  if (options.sequence !== false) {
    out.sequence = Array.isArray(options.sequence) ? options.sequence.map((slot, k) => {
      checkInt(slot, 0, SONG_SLOTS - 1, `sequence[${k}]`);
      if (!(String(slot) in songs)) fail(`sequence[${k}] names slot ${slot}, which songs does not carry`);
      return slot;
    }) : slots.map((_, i) => i);
  }
  return out;
}

// packages/shmup-engine/src/write/export-sav.js
function savFileName(title) {
  const clean = String(title || "game").replace(/[\\/:*?"<>|]+/g, "-").trim() || "game";
  return `Dez 2 - ${clean}.sav`;
}
function savComment(title) {
  return String(title || "shmupX").replace(/[^\x20-\x7e]/g, "_").slice(0, 10);
}
function exportLevelToSav(level, art2, options = {}) {
  const {
    slot = 1,
    comment,
    language = BUP_LANGUAGE.english,
    date,
    layout = "mister",
    ...buildOptions
  } = options;
  const built = buildSaveFromGame(level, art2, buildOptions);
  const title = level && level.name || "game";
  const save = buildGameSave(built.sections, {
    slot,
    comment: comment === void 0 ? savComment(title) : comment,
    language,
    date,
    layout
  });
  return {
    sav: save.sav,
    payload: save.payload,
    sections: built.sections,
    bank: built.bank,
    entry: save.entry,
    filename: save.filename,
    fileName: savFileName(title),
    warnings: built.warnings,
    report: built.report
  };
}

// packages/shmup-engine/src/story/bitmap-font.js
var FIRST_CODE = 32;
function newRaster(width, height) {
  return { width, height, data: new Uint8Array(width * height * 4) };
}
function bitmapFontFromSheet(sheet, glyphW = 8, glyphH = 8) {
  if (sheet.height < glyphH) {
    throw new Error(`font: ${sheet.height} rows cannot hold a ${glyphH}px glyph`);
  }
  const count = Math.floor(sheet.width / glyphW);
  const glyphs = [];
  for (let g = 0; g < count; g++) {
    const mask = new Uint8Array(glyphW * glyphH);
    for (let y = 0; y < glyphH; y++) {
      for (let x = 0; x < glyphW; x++) {
        const s = (y * sheet.width + g * glyphW + x) * 4;
        mask[y * glyphW + x] = sheet.data[s + 3] ? 1 : 0;
      }
    }
    glyphs.push(mask);
  }
  return { glyphW, glyphH, glyphs };
}
function wrapText(text, cols) {
  const out = [];
  for (const paragraph of foldToAscii(text).split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      while (word.length > cols) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, cols));
        word = word.slice(cols);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= cols) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}
var FOLD2 = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201A": ",",
  "\u201C": '"',
  "\u201D": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u2026": "...",
  "\xA0": " ",
  "\xB4": "'",
  "`": "'"
};
function foldToAscii(text) {
  let out = "";
  for (const ch of String(text ?? "")) out += FOLD2[ch] ?? ch;
  return out;
}
function glyphIndex(font, ch) {
  const code = ch.codePointAt(0) ?? 32;
  const index = code - FIRST_CODE;
  return index >= 0 && index < font.glyphs.length ? index : -1;
}
function renderText(font, text, w, h, opts = {}) {
  const colour = opts.colour ?? [255, 255, 255];
  const align = opts.align ?? "centre";
  const lineGap = opts.lineGap ?? font.glyphH + 1;
  const out = newRaster(w, h);
  const cols = Math.max(1, Math.floor(w / font.glyphW));
  const rows = Math.max(1, Math.floor((h + (lineGap - font.glyphH)) / lineGap));
  const lines = wrapText(text, cols).slice(0, rows);
  if (!lines.length) return out;
  const blockH = lines.length * lineGap - (lineGap - font.glyphH);
  const top = Math.max(0, Math.floor((h - blockH) / 2));
  const plot2 = (px, py, r, g, b) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const d = (py * w + px) * 4;
    out.data[d] = r;
    out.data[d + 1] = g;
    out.data[d + 2] = b;
    out.data[d + 3] = 255;
  };
  lines.forEach((line, row) => {
    const lineW = line.length * font.glyphW;
    const left = align === "centre" ? Math.floor((w - lineW) / 2) : 0;
    const y0 = top + row * lineGap;
    for (let i = 0; i < line.length; i++) {
      const gi = glyphIndex(font, line[i]);
      if (gi < 0) continue;
      const mask = font.glyphs[gi];
      const x0 = left + i * font.glyphW;
      if (opts.shadow) {
        for (let y = 0; y < font.glyphH; y++) {
          for (let x = 0; x < font.glyphW; x++) {
            if (mask[y * font.glyphW + x]) plot2(x0 + x + 1, y0 + y + 1, 0, 0, 0);
          }
        }
      }
      for (let y = 0; y < font.glyphH; y++) {
        for (let x = 0; x < font.glyphW; x++) {
          if (mask[y * font.glyphW + x]) plot2(x0 + x, y0 + y, colour[0], colour[1], colour[2]);
        }
      }
    }
  });
  return out;
}

// packages/shmup-engine/src/story/story-panels.js
var BACKDROP_W = 224;
var BACKDROP_ROW = 16;
var BACKDROP_H = 12 * BACKDROP_ROW;
function fitPanel(src, w, h) {
  const out = newRaster(w, h);
  const scale = Math.min(src.width / w, src.height / h);
  const cropW = Math.min(src.width, Math.round(w * scale));
  const cropH = Math.min(src.height, Math.round(h * scale));
  const cropX = Math.floor((src.width - cropW) / 2);
  const cropY = Math.floor((src.height - cropH) / 2);
  for (let y = 0; y < h; y++) {
    const sy0 = cropY + Math.floor(y * cropH / h);
    const sy1 = Math.max(sy0 + 1, cropY + Math.floor((y + 1) * cropH / h));
    for (let x = 0; x < w; x++) {
      const sx0 = cropX + Math.floor(x * cropW / w);
      const sx1 = Math.max(sx0 + 1, cropX + Math.floor((x + 1) * cropW / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < src.height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < src.width; sx++) {
          const s = (sy * src.width + sx) * 4;
          const sa = src.data[s + 3];
          if (sa) {
            r += src.data[s] * sa;
            g += src.data[s + 1] * sa;
            b += src.data[s + 2] * sa;
          }
          a += sa;
          n++;
        }
      }
      if (!n) continue;
      const d = (y * w + x) * 4;
      const alpha = a / n;
      out.data[d + 3] = Math.round(alpha);
      if (a > 0) {
        out.data[d] = Math.round(r / a);
        out.data[d + 1] = Math.round(g / a);
        out.data[d + 2] = Math.round(b / a);
      }
    }
  }
  return out;
}
function containPicture(src, w, h) {
  const scale = Math.min(w / src.width, h / src.height);
  return fitPanel(
    src,
    Math.max(1, Math.round(src.width * scale)),
    Math.max(1, Math.round(src.height * scale))
  );
}
function storyParts(storyData, stage) {
  const st = storyData && storyData[`stage${stage}`];
  if (!st || !Array.isArray(st.part)) return [];
  return st.part.map((p) => p && typeof p.text === "string" ? p.text : "").filter((t) => t.trim());
}
function storySpeaker(storyData) {
  const own = storyData && storyData.speaker;
  return typeof own === "string" && own.trim() ? own.trim() : "G";
}
var BORDER = 1;
var PAD = 3;
var GAP = 4;
var WHITE = [255, 255, 255];
function fillRect(r, x0, y0, w, h, rgb) {
  for (let y = Math.max(0, y0); y < Math.min(r.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(r.width, x0 + w); x++) {
      r.data.set([rgb[0], rgb[1], rgb[2], 255], (y * r.width + x) * 4);
    }
  }
}
function frameBox(r, x, y, w, h) {
  fillRect(r, x, y, w, h, WHITE);
  fillRect(r, x + BORDER, y + BORDER, w - 2 * BORDER, h - 2 * BORDER, [0, 0, 0]);
}
function blit2(dst, src, x0, y0) {
  for (let y = 0; y < src.height; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      if (!src.data[s + 3]) continue;
      dst.data.set(src.data.subarray(s, s + 4), (dy * dst.width + dx) * 4);
    }
  }
}
function wordsHeight(font, lines) {
  const plateH = font.glyphH + 2 * (BORDER + PAD);
  const boxH = lines * (font.glyphH + 1) - 1 + 2 * (BORDER + PAD);
  return plateH - BORDER + boxH;
}
function composeBackdrop(font, speaker, lines, picture) {
  const gw = font?.glyphW ?? 8, gh = font?.glyphH ?? 8;
  const lineGap = gh + 1;
  const words = font && lines.length > 0;
  const plateW = speaker.length * gw + 2 * (BORDER + PAD);
  const plateH = gh + 2 * (BORDER + PAD);
  const boxH = lines.length * lineGap - 1 + 2 * (BORDER + PAD);
  const wordsH = words ? wordsHeight(font, lines.length) : 0;
  const pictureY = words && picture ? wordsH + GAP : wordsH;
  const contentH = pictureY + (picture ? picture.height : 0);
  const h = Math.max(BACKDROP_ROW, Math.ceil(contentH / BACKDROP_ROW) * BACKDROP_ROW);
  const out = newRaster(BACKDROP_W, h);
  if (words) {
    const boxY = plateH - BORDER;
    frameBox(out, 0, boxY, BACKDROP_W, boxH);
    frameBox(out, 4, 0, plateW, plateH);
    blit2(
      out,
      renderText(font, speaker, speaker.length * gw, gh, { colour: WHITE }),
      4 + BORDER + PAD,
      BORDER + PAD
    );
    const inner = BACKDROP_W - 2 * (BORDER + PAD);
    blit2(
      out,
      renderText(font, lines.join("\n"), inner, lines.length * lineGap - 1, {
        colour: WHITE,
        align: "left",
        lineGap
      }),
      BORDER + PAD,
      boxY + BORDER + PAD
    );
  }
  if (picture) {
    blit2(out, picture, Math.floor((BACKDROP_W - picture.width) / 2), pictureY);
  }
  return out;
}
function boxLines(font, parts) {
  const cols = Math.floor((BACKDROP_W - 2 * (BORDER + PAD)) / font.glyphW);
  return parts.flatMap((p) => wrapText(p, cols));
}
function storyLogLine(backdrops, stages) {
  if (!backdrops.length) {
    return "story: the level tells none \u2014 stages open as they are";
  }
  const keys = new Set(stages.map((s) => s.key));
  const drawn = stages.filter((s) => s.story).map(
    (s) => `${s.key} ${s.story.size} (${s.story.seconds !== void 0 ? `${s.story.seconds} s` : `${s.story.rows} rows`})`
  );
  const beyond = backdrops.filter((b) => !keys.has(`stage${b.stage}`)).map((b) => b.stage);
  return `story: ${drawn.length ? `opens ${drawn.join(", ")}` : "no stage has room for it"}${beyond.length ? ` (stage${beyond.length === 1 ? "" : "s"} ${beyond.join(", ")} of the story ${beyond.length === 1 ? "has" : "have"} no stage on the cart)` : ""}`;
}
var variant = (label, r) => ({ label, w: r.width, h: r.height, rgba: r.data });
async function storyBackdrops(storyData, { font = null, decodePicture = null, onWarn = () => {
}, height = BACKDROP_H } = {}) {
  const sd = storyData;
  if (!sd || typeof sd !== "object") return [];
  const images = sd.customImages && typeof sd.customImages === "object" ? sd.customImages : {};
  const speaker = storySpeaker(sd);
  const out = [];
  for (let stage = 0; stage < 16; stage++) {
    const parts = storyParts(sd, stage);
    const key = Object.keys(images).filter((k) => new RegExp("^stage" + stage + "_part\\d+$").test(k)).sort((a, b) => Number(a.split("part")[1]) - Number(b.split("part")[1])).find((k) => typeof images[k] === "string") ?? null;
    let source = null;
    if (key && decodePicture) {
      try {
        source = await decodePicture(images[key]);
      } catch (e) {
        onWarn(`story picture for stage ${stage} (${key}): ${e && e.message || e}`);
      }
    }
    const lines = font ? boxLines(font, parts) : [];
    if (!source && !lines.length) continue;
    const variants = [];
    const words = font && lines.length ? composeBackdrop(font, speaker, lines, null) : null;
    if (source) {
      const room = height - (words ? wordsHeight(font, lines.length) + GAP : 0);
      const heights = room >= 48 ? [room, Math.round(room * 2 / 3), Math.round(room * 2 / 5)] : [Math.round(height / 3)];
      const seen = /* @__PURE__ */ new Set();
      for (const h of heights) {
        const pic = containPicture(source, BACKDROP_W, h);
        const size = `${pic.width}x${pic.height}`;
        if (seen.has(size) || pic.height < 16) continue;
        seen.add(size);
        variants.push(
          variant(
            `picture ${size}${words ? " + words" : ""}`,
            composeBackdrop(font, speaker, words ? lines : [], pic)
          )
        );
      }
    }
    if (words) {
      variants.push(variant("words", words));
      const opening = boxLines(font, parts.slice(0, 1));
      if (parts.length > 1 && opening.length < lines.length) {
        variants.push(variant("opening words", composeBackdrop(font, speaker, opening, null)));
      }
    }
    out.push({ stage, sourceKey: source ? key : null, speaker, parts, variants });
  }
  return out;
}

// packages/shmup-engine/src/psx/kids-palette.js
var KIDS_PALETTE = Object.freeze([
  0,
  959,
  1471,
  31,
  31775,
  32083,
  31744,
  32326,
  32736,
  992,
  3493,
  8627,
  21407,
  25368,
  32767,
  3171,
  6590,
  7710,
  8862,
  7934,
  9086,
  2015,
  1019,
  5109,
  992,
  15343,
  21474,
  23364,
  25290,
  29290,
  32228,
  32067,
  31517,
  26366,
  24383,
  23423,
  21407,
  24511,
  24575,
  21500,
  25595,
  27639,
  32761,
  32567,
  31547,
  31643,
  26425,
  25500,
  30272,
  32418,
  31470,
  31572,
  30618,
  28606,
  19391,
  18271,
  7935,
  10909,
  14905,
  16819,
  22831,
  25740,
  22535,
  18437,
  28671,
  24575,
  18399,
  2015,
  11135,
  9983,
  5791,
  542,
  415,
  31,
  2331,
  277,
  2289,
  173,
  2153,
  2118,
  2370,
  2435,
  517,
  644,
  783,
  884,
  987,
  1023,
  926,
  795,
  664,
  599,
  501,
  403,
  304,
  205,
  2277,
  3400,
  2508,
  4688,
  8916,
  11031,
  14170,
  17243,
  19291,
  19226,
  16056,
  12885,
  10738,
  7567,
  4396,
  1258,
  25500,
  21272,
  17077,
  13873,
  9645,
  6441,
  4294,
  2180,
  32767,
  26425,
  21140,
  16912,
  12684,
  8456,
  5285,
  2114,
  31579,
  30392,
  32278,
  32115,
  30800,
  20652,
  12327,
  7205,
  30586,
  26358,
  22130,
  17902,
  14731,
  10503,
  7332,
  5218,
  32665,
  32564,
  32462,
  32326,
  23936,
  15584,
  9344,
  6208,
  32534,
  32403,
  32238,
  32041,
  31746,
  20480,
  12288,
  7168,
  27640,
  24564,
  21474,
  19275,
  14948,
  11682,
  8484,
  6336,
  32729,
  32757,
  32736,
  26400,
  20032,
  13696,
  10496,
  7328,
  20477,
  16314,
  5114,
  4916,
  3630,
  3433,
  1221,
  1122,
  23548,
  19449,
  14325,
  992,
  6824,
  3494,
  1249,
  129,
  24575,
  19423,
  14303,
  991,
  5913,
  528,
  330,
  198,
  18235,
  15130,
  9878,
  5650,
  4494,
  232,
  133,
  1091,
  21407,
  16223,
  7967,
  767,
  568,
  367,
  200,
  100,
  24511,
  20284,
  16057,
  12887,
  8626,
  4364,
  3240,
  2149,
  24383,
  20127,
  14879,
  9567,
  31,
  5332,
  1067,
  5,
  23423,
  19263,
  14047,
  607,
  1535,
  340,
  171,
  2150,
  31517,
  32415,
  32255,
  31775,
  23575,
  16400,
  10250,
  6150,
  27455,
  24255,
  22079,
  17823,
  15391,
  9237,
  5133,
  3079
]);
var KIDS_PALETTE_SIZE = KIDS_PALETTE.length;
var KIDS_TRANSPARENT_INDEX = 0;

// packages/shmup-engine/src/psx/memcard.js
var CARD_SIZE = 131072;
var FRAME_SIZE = 128;
var BLOCK_SIZE = 8192;
var BLOCK_COUNT = 15;
var DIRECTORY_OFFSET = FRAME_SIZE;
var FILENAME_OFFSET = 10;
var FILENAME_LENGTH = 20;
var NO_NEXT = 65535;
var CARD_MAGIC = "MC";
var GME_HEADER_SIZE = 3904;
var GME_MAGIC = "123-456-STD";
var PSV_HEADER_SIZE = 132;
var MCS_HEADER_SIZE = FRAME_SIZE;
var STATUS = Object.freeze({
  FIRST: 81,
  MIDDLE: 82,
  LAST: 83,
  FREE: 160,
  DELETED_FIRST: 161,
  DELETED_MIDDLE: 162,
  DELETED_LAST: 163,
  UNUSABLE: 255
});
function latin1(bytes, offset, length) {
  let s = "";
  for (let i = 0; i < length && offset + i < bytes.length; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}
function cString(bytes, offset, length) {
  let end = offset;
  while (end < offset + length && end < bytes.length && bytes[end] !== 0) end++;
  return latin1(bytes, offset, end - offset);
}
function u16le(bytes, at) {
  return bytes[at] | bytes[at + 1] << 8;
}
function u32le(bytes, at) {
  return (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;
}
function frameChecksum(frame) {
  let x = 0;
  for (let i = 0; i < FRAME_SIZE - 1 && i < frame.length; i++) x ^= frame[i];
  return x;
}
function isCardImage(bytes) {
  return bytes.length === CARD_SIZE && latin1(bytes, 0, 2) === CARD_MAGIC;
}
function isGmeImage(bytes) {
  return bytes.length === GME_HEADER_SIZE + CARD_SIZE && latin1(bytes, 0, GME_MAGIC.length) === GME_MAGIC;
}
function isPsvImage(bytes) {
  return bytes.length > PSV_HEADER_SIZE && bytes[0] === 0 && latin1(bytes, 1, 3) === "VSP";
}
function isMcsImage(bytes) {
  return bytes.length > MCS_HEADER_SIZE && (bytes.length - MCS_HEADER_SIZE) % BLOCK_SIZE === 0 && (bytes[0] & 240) === 80 && latin1(bytes, MCS_HEADER_SIZE, 2) === "SC";
}
function isBareSave(bytes) {
  return bytes.length >= BLOCK_SIZE && bytes.length % BLOCK_SIZE === 0 && latin1(bytes, 0, 2) === "SC";
}
function parseDirectoryFrame(card, index) {
  const at = DIRECTORY_OFFSET + index * FRAME_SIZE;
  const frame = card.subarray(at, at + FRAME_SIZE);
  const status = frame[0];
  return {
    block: index + 1,
    offset: at,
    status,
    size: u32le(frame, 4),
    next: u16le(frame, 8),
    filename: cString(frame, FILENAME_OFFSET, FILENAME_LENGTH),
    checksum: frame[FRAME_SIZE - 1],
    checksumOk: frameChecksum(frame) === frame[FRAME_SIZE - 1],
    live: status === STATUS.FIRST || status === STATUS.MIDDLE || status === STATUS.LAST,
    deleted: status === STATUS.DELETED_FIRST || status === STATUS.DELETED_MIDDLE || status === STATUS.DELETED_LAST,
    free: status === STATUS.FREE,
    first: status === STATUS.FIRST || status === STATUS.DELETED_FIRST,
    last: status === STATUS.LAST || status === STATUS.DELETED_LAST
  };
}
function blockBytes(card, block) {
  return card.subarray(block * BLOCK_SIZE, (block + 1) * BLOCK_SIZE);
}
function chainFrom(frames, firstIndex) {
  const chain = [];
  const seen = /* @__PURE__ */ new Set();
  let index = firstIndex;
  while (index >= 0 && index < frames.length && !seen.has(index)) {
    seen.add(index);
    chain.push(index + 1);
    const frame = frames[index];
    if (frame.last || frame.next === NO_NEXT) break;
    index = frame.next;
  }
  return chain;
}
function parseMemoryCard(card) {
  const magic = latin1(card, 0, 2);
  const frames = [];
  for (let i = 0; i < BLOCK_COUNT; i++) frames.push(parseDirectoryFrame(card, i));
  const files = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame.first) continue;
    const blocks = chainFrom(frames, i);
    const parts = blocks.map((b) => blockBytes(card, b));
    const joined = new Uint8Array(parts.length * BLOCK_SIZE);
    parts.forEach((p, k) => joined.set(p, k * BLOCK_SIZE));
    const size = Math.min(frame.size, joined.length);
    files.push({
      filename: frame.filename,
      firstBlock: frame.block,
      blocks,
      size: frame.size,
      complete: frame.size <= joined.length && blocks.length > 0 && frames[blocks[blocks.length - 1] - 1].last,
      deleted: frame.deleted,
      data: joined.subarray(0, size)
    });
  }
  return {
    magic,
    magicOk: magic === CARD_MAGIC,
    headerChecksumOk: frameChecksum(card.subarray(0, FRAME_SIZE)) === card[FRAME_SIZE - 1],
    frames,
    files,
    freeBlocks: frames.filter((f) => f.free).length
  };
}
function locateSaves(bytes) {
  if (isCardImage(bytes) || isGmeImage(bytes)) {
    const container = isGmeImage(bytes) ? "gme" : "card";
    const card = parseMemoryCard(container === "gme" ? bytes.subarray(GME_HEADER_SIZE) : bytes);
    return {
      container,
      card,
      saves: card.files.map((f) => ({ filename: f.filename, data: f.data, deleted: f.deleted }))
    };
  }
  if (isMcsImage(bytes)) {
    const size = u32le(bytes, 4) || bytes.length - MCS_HEADER_SIZE;
    return {
      container: "mcs",
      card: null,
      saves: [{
        filename: cString(bytes, FILENAME_OFFSET, FILENAME_LENGTH),
        data: bytes.subarray(MCS_HEADER_SIZE, MCS_HEADER_SIZE + size),
        deleted: false
      }]
    };
  }
  if (isPsvImage(bytes)) {
    return {
      container: "psv",
      card: null,
      saves: [{ filename: cString(bytes, 100, FILENAME_LENGTH), data: bytes.subarray(PSV_HEADER_SIZE), deleted: false }]
    };
  }
  if (isBareSave(bytes)) {
    return { container: "bare", card: null, saves: [{ filename: "", data: bytes, deleted: false }] };
  }
  return { container: "unknown", card: null, saves: [] };
}

// packages/shmup-engine/src/psx/save-header.js
var SAVE_MAGIC = "SC";
var TITLE_FRAME_SIZE = 128;
var ICON_FRAME_SIZE = 128;
var TITLE_OFFSET = 4;
var TITLE_LENGTH = 64;
var CLUT_OFFSET = 96;
var ICON_DIM = 16;
var sjis = null;
function shiftJisDecoder() {
  if (sjis === null) {
    try {
      sjis = new TextDecoder("shift_jis");
    } catch {
      sjis = false;
    }
  }
  return sjis || null;
}
function decodeShiftJis(bytes) {
  const decoder = shiftJisDecoder();
  return decoder ? decoder.decode(bytes) : latin1(bytes, 0, bytes.length);
}
function narrow(text) {
  return text.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248)).replace(/　/g, " ");
}
function bracketedName(title) {
  const m = /『(.*?)』/.exec(title);
  if (!m) return null;
  return m[1].replace(/^[\s　]+|[\s　]+$/g, "");
}
function decodeClut(bytes, offset) {
  const colors = [];
  for (let i = 0; i < 16; i++) colors.push(u16le(bytes, offset + i * 2));
  return colors;
}
function decodeIconFrame(bytes, offset) {
  const out = new Uint8Array(ICON_DIM * ICON_DIM);
  for (let i = 0; i < out.length; i += 2) {
    const b = bytes[offset + (i >> 1)];
    out[i] = b & 15;
    out[i + 1] = b >> 4;
  }
  return out;
}
function parseSaveHeader(data) {
  const magic = latin1(data, 0, 2);
  const iconFlag = data[2];
  const iconFrames = (iconFlag & 240) === 16 ? Math.min(3, Math.max(1, iconFlag & 15)) : 0;
  let titleEnd = TITLE_OFFSET;
  while (titleEnd < TITLE_OFFSET + TITLE_LENGTH && data[titleEnd] !== 0) titleEnd++;
  const titleBytes = data.subarray(TITLE_OFFSET, titleEnd);
  const title = decodeShiftJis(titleBytes);
  const icons = [];
  for (let i = 0; i < iconFrames; i++) icons.push(decodeIconFrame(data, TITLE_FRAME_SIZE + i * ICON_FRAME_SIZE));
  return {
    magic,
    magicOk: magic === SAVE_MAGIC,
    iconFlag,
    iconFrames,
    blockCount: data[3],
    title,
    titleAscii: narrow(title),
    titleBytes,
    clut: decodeClut(data, CLUT_OFFSET),
    icons,
    /** Where the game's own data starts: after the title and icon frames. */
    bodyOffset: TITLE_FRAME_SIZE + iconFrames * ICON_FRAME_SIZE
  };
}

// packages/shmup-engine/src/psx/kids.js
var KIDS_PRODUCT = "BISLPS-01503DEZAKIDS";
var KIDS_TITLE_PREFIX = "\u30C7\u30B6\u30A8\u30E2\u30F3\uFF2B\uFF49\uFF44\uFF53\uFF01";
var KIDS_BLOCK_SIZE = 122880;
var KIDS_SECTOR = 128;
var KIDS_TABLE_OFFSET = 256;
var KIDS_TABLE_WORDS = 11;
var KIDS_FIRST_SECTION = 384;
var KIDS_TAIL_SIZE = 256;
var KIDS_GRAPHICS_SIZE = 4 * CG_PAGE_SIZE;
var KIDS_DATA_SIZE = 64712;
var KIDS_CELL_COUNT = KIDS_GRAPHICS_SIZE / 256;
var KIDS_STAGES = 6;
var KIDS_HISCORE_COUNT = 10;
var KIDS_HISCORE_SIZE = 16;
var KIDS_OPTIONS_OFFSET = KIDS_HISCORE_COUNT * KIDS_HISCORE_SIZE;
var KIDS_OPTIONS_SIZE = 28;
var KIDS_TAIL_UNUSED_OFFSET = KIDS_OPTIONS_OFFSET + KIDS_OPTIONS_SIZE;
var KIDS_ALL_CLEAR = 128;
var KIDS_LEVELS = Object.freeze(["EASY", "NORMAL", "HARD", "MANIAC"]);
var KIDS_MUTEKI_LEVEL = 4;
var KIDS_MAP_COLUMNS = 7;
var KIDS_MAP_ROWS = 384;
var KIDS_MAP_STAGE_BYTES = KIDS_MAP_COLUMNS * KIDS_MAP_ROWS * 2;
var KIDS_CHIP_DIM = 32;
var KIDS_CELL_ALIGN = 9;
var KIDS_HFLIP = 8192;
var KIDS_VFLIP = 16384;
var KIDS_BLANK = 32768;
var KIDS_SCROLL_STAGE_BYTES = 96;
var KIDS_SCROLL_UNITS = KIDS_SCROLL_STAGE_BYTES * 2;
var KIDS_SCROLL_UNIT_PIXELS = 64;
var KIDS_SCROLL_SPEEDS = Object.freeze([0, 0.25, 1, 4]);
var KIDS_APPEAR_STAGE_BYTES = 3456;
var KIDS_APPEAR_COLUMNS = 9;
var KIDS_APPEAR_ROWS = 384;
var KIDS_APPEAR_ROW_PIXELS = 32;
var KIDS_APPEAR_CLASSES = Object.freeze([
  { klass: 0, size: "32x32", count: 16 },
  { klass: 1, size: "64x32", count: 8 },
  { klass: 2, size: "32x64", count: 8 },
  { klass: 3, size: "64x64", count: 8 }
]);
var KIDS_APPEAR_CELLS = Object.freeze([[1, 1], [2, 1], [1, 2], [2, 2]]);
var KIDS_APPEAR_PRESENT = 128;
var KIDS_APPEAR_CLASS_MASK = 112;
var KIDS_APPEAR_ID_MASK = 15;
var KIDS_APPEAR_FOOTPRINT_CLASS = 5;
var KIDS_APPEAR_BOSS_CLASS = 4;
var KIDS_RECORDS_STAGE_BYTES = 230;
var KIDS_RECORD_SIZE = 5;
var KIDS_RECORD_COUNT = 40;
var KIDS_CLASS_BASE = Object.freeze([0, 16, 24, 32]);
var KIDS_BOSS_OFFSET = 200;
var KIDS_BOSS_SIZE = 15;
var KIDS_BOSS_COUNT = 2;
var KIDS_BOSS_SIZES = Object.freeze(["64x64", "128x64", "64x128", "128x128"]);
var KIDS_SHIP_TABLE_BYTES = 436;
var KIDS_SPRITE_STAGE_BYTES = 1536;
var KIDS_SPRITE_CLASS_OFFSETS = Object.freeze([0, 512, 768, 1024]);
var KIDS_SPRITE_ENTRY_WORDS = 16;
var KIDS_SPRITE_BOSS_OFFSETS = Object.freeze([1280, 1408]);
var KIDS_SPRITE_BOSS_WORDS = 64;
var KIDS_POINT_SMALL = Object.freeze([100, 500, 1e3, 0]);
var KIDS_POINT_LARGE = Object.freeze([5e3, 1e4, 5e4, 0]);
var KIDS_BG_SPEEDS = Object.freeze([0, 4, 12, 24]);
var KIDS_FONT_FILES = Object.freeze(["FN1", "FN2", "FN3", "FN4"]);
var KIDS_BGM_BANKS = Object.freeze(["G_BGM1", "G_BGM2", "G_BGM3", "G_BGM4"]);
function region(name, label, offset, end, stride, confidence, note) {
  return Object.freeze({ name, label, offset, end, length: end - offset, stride, confidence, note });
}
var KIDS_REGIONS = Object.freeze([
  region(
    "map",
    "MAP",
    0,
    32256,
    KIDS_MAP_STAGE_BYTES,
    "confirmed",
    "6 stages x 0x1500: 384 rows of 7 u16 chips. A chip is 32x32 px drawn from the CG cells n, n+1, n+8, n+9, so n is always 2x2-aligned; bits 0-9 name n, bit 13 h-flip, bit 14 v-flip, bit 15 blank (0x8080 and 0x8000 are the commonest of 14 blank words)."
  ),
  region(
    "scroll",
    "SCROLL",
    32256,
    32832,
    KIDS_SCROLL_STAGE_BYTES,
    "confirmed",
    "6 x 0x60: one nibble per 64 px of map, low nibble first. value & 3 picks 0, 0.25, 1 or 4 px per frame; 0x22 is the fill."
  ),
  region(
    "appear",
    "APPEAR",
    32832,
    53568,
    KIDS_APPEAR_STAGE_BYTES,
    "confirmed",
    "6 x 0xD80: 384 rows of 9 slot bytes, one per 32 px across and down. A byte is present(bit 7) | class(bits 4-6) | id(bits 0-3); classes 0-3 are the enemy sizes, 4 the boss, and 5 a footprint mark (0x50 | dx << 2 | dy) giving the cell offset inside the owning enemy rectangle."
  ),
  region(
    "config",
    "CONFIG",
    53568,
    53680,
    0,
    "confirmed",
    "0x70 bytes of game-wide settings (RAM 0x8005D140): scroll direction, the last stage, sixteen 4-byte sound entries, per-stage ship speed and background set."
  ),
  region(
    "records",
    "RECORDS",
    53680,
    55060,
    KIDS_RECORDS_STAGE_BYTES,
    "confirmed",
    "6 x 0xE6: 40 five-byte enemy records indexed by class base 0/16/24/32 plus id, then two 15-byte boss records at +0xC8."
  ),
  region(
    "ship",
    "SHIP",
    55060,
    55496,
    0,
    "confirmed",
    "0x1B4 bytes of u16 cell words in the map's encoding: the two ships' three poses each, their shots, the item icons and the title blocks."
  ),
  region(
    "sprites",
    "SPRITES",
    55496,
    64712,
    KIDS_SPRITE_STAGE_BYTES,
    "confirmed",
    "6 x 0x600 of u16 cell words: 16 entries of 16 cells for class 0 at +0, 8 each for classes 1-3 at +0x200/+0x300/+0x400, and two 64-cell boss parts at +0x500 and +0x580. Ends exactly at 0xFCC8 \u2014 there is no trailer."
  )
]);
var KIDS_REGION = Object.freeze(Object.fromEntries(KIDS_REGIONS.map((r) => [r.name, r])));
function roundUp(n, to) {
  return Math.ceil(n / to) * to;
}
function byteSum2(bytes, start, end) {
  let sum = 0;
  for (let i = start; i < end && i < bytes.length; i++) sum += bytes[i];
  return sum >>> 0;
}
function isKidsBlock(block) {
  if (block.length < KIDS_TABLE_OFFSET + KIDS_TABLE_WORDS * 4) return false;
  return parseKidsTable(block).consistent;
}
function parseKidsTable(block) {
  const words = [];
  for (let i = 0; i < KIDS_TABLE_WORDS; i++) words.push(u32le(block, KIDS_TABLE_OFFSET + i * 4));
  const [end, gfxSize, dataSize, gfxOffset, gfxSum, dataOffset, dataSum, tailOffset, tailSum, gfxPadded, dataPadded] = words;
  const problems = [];
  if (gfxOffset !== KIDS_FIRST_SECTION) problems.push(`graphics offset ${gfxOffset.toString(16)} != 0x180`);
  if (gfxPadded !== roundUp(gfxSize, KIDS_SECTOR)) problems.push("graphics padded size != roundUp(size, 0x80)");
  if (dataOffset !== gfxOffset + gfxPadded) problems.push("data offset != graphics offset + padded size");
  if (dataPadded !== roundUp(dataSize, KIDS_SECTOR)) problems.push("data padded size != roundUp(size, 0x80)");
  if (tailOffset !== dataOffset + dataPadded) problems.push("tail offset != data offset + padded size");
  if (end !== tailOffset + KIDS_TAIL_SIZE) problems.push("end != tail offset + 0x100");
  if (end > block.length) problems.push(`end ${end.toString(16)} past the block (${block.length.toString(16)})`);
  return {
    words,
    end,
    sections: {
      graphics: { offset: gfxOffset, size: gfxSize, padded: gfxPadded, checksum: gfxSum },
      data: { offset: dataOffset, size: dataSize, padded: dataPadded, checksum: dataSum },
      tail: { offset: tailOffset, size: KIDS_TAIL_SIZE, padded: KIDS_TAIL_SIZE, checksum: tailSum }
    },
    problems,
    consistent: problems.length === 0
  };
}
function validateKidsTable(block, table = parseKidsTable(block)) {
  const check2 = (s) => byteSum2(block, s.offset, s.offset + s.padded) === s.checksum;
  const graphics = check2(table.sections.graphics);
  const data = check2(table.sections.data);
  const tail = check2(table.sections.tail);
  return { graphics, data, tail, ok: graphics && data && tail };
}
function decodeKidsHiScores(tail, offset = 0) {
  const entries = [];
  for (let i = 0; i < KIDS_HISCORE_COUNT; i++) {
    const at = offset + i * KIDS_HISCORE_SIZE;
    const stage = tail[at + 4];
    const allClear = (stage & KIDS_ALL_CLEAR) !== 0;
    const level = tail[at + 5];
    entries.push({
      rank: i + 1,
      score: u32le(tail, at),
      stage: allClear ? null : stage,
      allClear,
      level,
      levelName: KIDS_LEVELS[level & 3],
      muteki: level === KIDS_MUTEKI_LEVEL,
      name: latin1(tail, at + 8, 8)
    });
  }
  return entries;
}
function decodeKidsOptions(tail) {
  const at = (i) => tail[KIDS_OPTIONS_OFFSET + i];
  return {
    bytes: tail.subarray(KIDS_OPTIONS_OFFSET, KIDS_OPTIONS_OFFSET + KIDS_OPTIONS_SIZE),
    unused: tail.subarray(KIDS_TAIL_UNUSED_OFFSET, KIDS_TAIL_SIZE),
    screenWidth: at(0),
    //  tail+0xA0
    stereo: at(14),
    //       tail+0xAE
    presetBgm: at(22),
    //    tail+0xB6
    seMuted: at(23) !== 0,
    // tail+0xB7
    backdropWhite: (at(24) & 1) !== 0,
    // tail+0xB8 bit 0
    bgmFile: at(25),
    //      tail+0xB9
    bgmVolume: at(26)
    //    tail+0xBA
  };
}
function decodeKidsMap(data) {
  const stages = [];
  for (let s = 0; s < KIDS_STAGES; s++) {
    const base = KIDS_REGION.map.offset + s * KIDS_MAP_STAGE_BYTES;
    const words = new Uint16Array(KIDS_MAP_COLUMNS * KIDS_MAP_ROWS);
    let used = 0;
    for (let i = 0; i < words.length; i++) {
      const w = u16le(data, base + i * 2);
      words[i] = w;
      if ((w & KIDS_BLANK) === 0) used++;
    }
    stages.push({
      stage: s,
      columns: KIDS_MAP_COLUMNS,
      rows: KIDS_MAP_ROWS,
      chipDim: KIDS_CHIP_DIM,
      width: KIDS_MAP_COLUMNS * KIDS_CHIP_DIM,
      height: KIDS_MAP_ROWS * KIDS_CHIP_DIM,
      words,
      used
    });
  }
  return stages;
}
function decodeKidsScroll(data) {
  const stages = [];
  for (let s = 0; s < KIDS_STAGES; s++) {
    const base = KIDS_REGION.scroll.offset + s * KIDS_SCROLL_STAGE_BYTES;
    const steps = [];
    for (let i = 0; i < KIDS_SCROLL_UNITS; i++) {
      const b = data[base + (i >> 1)];
      const nibble = i & 1 ? b >> 4 : b & 15;
      steps.push({ nibble, speed: KIDS_SCROLL_SPEEDS[nibble & 3] });
    }
    stages.push({ stage: s, unitPixels: KIDS_SCROLL_UNIT_PIXELS, steps });
  }
  return stages;
}
function decodeKidsAppearSlot(byte) {
  if (byte === 0) return null;
  const klass = (byte & KIDS_APPEAR_CLASS_MASK) >> 4;
  const id = byte & KIDS_APPEAR_ID_MASK;
  if (klass === KIDS_APPEAR_BOSS_CLASS && byte & KIDS_APPEAR_PRESENT) {
    return { raw: byte, boss: true, klass: null, id: null };
  }
  if ((byte & KIDS_APPEAR_PRESENT) === 0) {
    const footprint = klass === KIDS_APPEAR_FOOTPRINT_CLASS;
    return { raw: byte, boss: false, klass: null, id: null, footprint, dx: id >> 2 & 3, dy: id & 3 };
  }
  const spec = KIDS_APPEAR_CLASSES[klass];
  if (!spec) return { raw: byte, boss: false, klass: null, id: null, unknown: true };
  return { raw: byte, boss: false, klass, id, size: spec.size };
}
function kidsFootprintOwner(index, dx, dy, horizontal) {
  const owner = horizontal ? index - 9 * dx - dy : index + 9 * dy - dx;
  return owner >= 0 && owner < KIDS_APPEAR_STAGE_BYTES ? owner : null;
}
function decodeKidsAppear(data, { horizontal = false } = {}) {
  const stages = [];
  for (let s = 0; s < KIDS_STAGES; s++) {
    const base = KIDS_REGION.appear.offset + s * KIDS_APPEAR_STAGE_BYTES;
    const bytes = data.subarray(base, base + KIDS_APPEAR_STAGE_BYTES);
    const spawns = [];
    const byIndex = /* @__PURE__ */ new Map();
    const marks = [];
    let boss = null;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (byte === 0) continue;
      const row = i / KIDS_APPEAR_COLUMNS | 0;
      const col = i % KIDS_APPEAR_COLUMNS;
      const slot = decodeKidsAppearSlot(byte);
      if (!slot) continue;
      if ((byte & KIDS_APPEAR_PRESENT) === 0) {
        if (slot.footprint) marks.push({ ...slot, index: i, row, col });
        continue;
      }
      const placed = {
        ...slot,
        row,
        col,
        x: col * KIDS_APPEAR_ROW_PIXELS,
        y: row * KIDS_APPEAR_ROW_PIXELS,
        covers: []
      };
      byIndex.set(i, placed);
      if (slot.boss) boss = placed;
      else spawns.push(placed);
    }
    let orphans = 0;
    for (const mark of marks) {
      const at = kidsFootprintOwner(mark.index, mark.dx, mark.dy, horizontal);
      const owner = at === null ? void 0 : byIndex.get(at);
      if (!owner) {
        orphans++;
        continue;
      }
      mark.owner = { row: owner.row, col: owner.col };
      owner.covers.push({ row: mark.row, col: mark.col });
    }
    stages.push({
      stage: s,
      columns: KIDS_APPEAR_COLUMNS,
      rows: KIDS_APPEAR_ROWS,
      bytes,
      spawns,
      boss,
      marks,
      orphanMarks: orphans
    });
  }
  return stages;
}
function kidsBackgroundFile(set, horizontal) {
  const value = set & 127;
  if (value === 0 || value > 38) return null;
  const second = value > 16;
  const dir = `${horizontal ? "SIDE" : "LENGTH"}${second ? 2 : 1}`;
  const name = horizontal ? "BGY" : "BGT";
  const number = second ? value + 34 : value;
  return `GAME\\${dir}\\${name}${String(number).padStart(2, "0")}.CMP`;
}
function kidsSoundEntry(bytes, at) {
  const b0 = bytes[at];
  return {
    preset: (b0 & 128) !== 0,
    sequenceVolume: b0 & 127,
    bgm: bytes[at + 1],
    presetNumber: bytes[at + 2] & 127,
    volume: bytes[at + 3] & 127
  };
}
function kidsBgmFile(number) {
  if (number === 0 || number > 99) return null;
  const bank = number < 30 ? 0 : number < 60 ? 1 : number < 90 ? 2 : 3;
  return `SOUND\\${KIDS_BGM_BANKS[bank]}\\BGM${String(number).padStart(2, "0")}.CMP`;
}
function decodeKidsConfig(data) {
  const r = KIDS_REGION.config;
  const bytes = data.subarray(r.offset, r.end);
  const horizontal = (bytes[0] & 1) !== 0;
  const stages = [];
  for (let s = 0; s < KIDS_STAGES; s++) {
    const flags = bytes[3 + s];
    const motion = bytes[99 + s];
    const set = bytes[105 + s];
    stages.push({
      stage: s,
      last: (flags & 128) !== 0,
      chained: (flags & 1) !== 0,
      flags,
      scrollSpeed: KIDS_SCROLL_SPEEDS[motion & 3],
      scrollReverse: (motion & 4) !== 0,
      backgroundSpeed: KIDS_BG_SPEEDS[motion >> 4 & 3],
      backgroundSet: set & 127,
      backgroundFile: kidsBackgroundFile(set, horizontal)
    });
  }
  const lastStage = stages.findIndex((st) => st.last);
  const stageCount = lastStage + 1 || KIDS_STAGES;
  const sound = [];
  for (let i = 0; i < 16; i++) {
    const entry = kidsSoundEntry(bytes, 35 + i * 4);
    entry.scope = i < 4 ? "game" : `stage ${i - 4 >> 1}`;
    entry.file = entry.preset ? null : kidsBgmFile(entry.bgm);
    sound.push(entry);
  }
  return {
    bytes,
    horizontal,
    font: {
      typeface: bytes[1] & 7,
      colour: bytes[1] >> 3 & 7,
      file: KIDS_FONT_FILES[bytes[1] >> 6]
    },
    soundBank: bytes[2],
    stages,
    stageCount,
    pointItems: {
      small: KIDS_POINT_SMALL[bytes[15] & 3],
      large: KIDS_POINT_LARGE[bytes[16] & 3]
    },
    /** Two three-byte player-ship records; only byte 2 has a play-mode reader. */
    ships: [bytes.subarray(9, 12), bytes.subarray(12, 15)],
    /** Seven item records and two more of the same shape. */
    items: Array.from({ length: 9 }, (_, i) => ({
      a: bytes[17 + i] & 3,
      b: bytes[17 + i] >> 2 & 3
    })),
    unknown1A: bytes[26],
    /** Two four-byte player-shot records, one per ship. */
    shots: [bytes.subarray(27, 31), bytes.subarray(31, 35)],
    sound,
    /** Sound entries past this are zeroed when the game loads. */
    liveSoundEntries: 2 * stageCount + 4
  };
}
function decodeKidsRecord(bytes, at, index) {
  const b = [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3], bytes[at + 4]];
  return {
    index,
    bytes: b,
    movement: b[0] & 31,
    movementVariant: b[0] >> 5 & 3,
    fromBehind: (b[0] & 128) !== 0,
    spawnFlag: (b[0] & 128) !== 0,
    hardness: b[1] & 7,
    hitPoints: b[1] & 3,
    scoreTier: b[1] >> 3 & 3,
    scoreClass: b[1] >> 3 & 3,
    opacity: b[1] >> 5 & 7,
    bullet: b[2] & 15,
    fireTiming: b[2] >> 4 & 3,
    animInterval: KIDS_ANIM_INTERVALS[b[2] >> 6 & 3],
    fireInterval: b[2] >> 6 & 3,
    shotPattern: b[3] & 15,
    aim: (b[3] & 16) !== 0,
    item: b[3] >> 5 & 7,
    rotation: b[4] & 7,
    scale: b[4] >> 3 & 7,
    ground: (b[4] & 128) !== 0
  };
}
var KIDS_ANIM_INTERVALS = Object.freeze([30, 10, 2, 0]);
function decodeKidsBoss(bytes, at, index) {
  const head = bytes[at];
  const weapons = [];
  for (let w = 0; w < 3; w++) {
    const o = at + 3 + w * 4;
    weapons.push({
      dx: bytes[o] << 24 >> 24,
      dy: bytes[o + 1] << 24 >> 24,
      bullet: bytes[o + 2] & 15,
      timing: bytes[o + 2] >> 4 & 3,
      pattern: bytes[o + 3] & 15,
      aim: (bytes[o + 3] & 16) !== 0
    });
  }
  return {
    index,
    phase: index + 1,
    bytes: bytes.subarray(at, at + KIDS_BOSS_SIZE),
    pattern: head & 15,
    speedClass: head >> 4 & 3,
    sizeClass: head >> 6,
    size: KIDS_BOSS_SIZES[head >> 6],
    hpClass: bytes[at + 1] & 3,
    scoreClass: bytes[at + 1] >> 3 & 3,
    opacity: bytes[at + 1] >> 5 & 7,
    rotation: bytes[at + 2] & 7,
    scale: bytes[at + 2] >> 3 & 7,
    ground: (bytes[at + 2] & 128) !== 0,
    weapons
  };
}
function decodeKidsRecords(data) {
  const stages = [];
  for (let s = 0; s < KIDS_STAGES; s++) {
    const base = KIDS_REGION.records.offset + s * KIDS_RECORDS_STAGE_BYTES;
    const enemies = [];
    for (let i = 0; i < KIDS_RECORD_COUNT; i++) enemies.push(decodeKidsRecord(data, base + i * KIDS_RECORD_SIZE, i));
    const bosses = [];
    for (let i = 0; i < KIDS_BOSS_COUNT; i++) bosses.push(decodeKidsBoss(data, base + KIDS_BOSS_OFFSET + i * KIDS_BOSS_SIZE, i));
    stages.push({ stage: s, enemies, bosses });
  }
  return stages;
}
function cellWords(data, at, count) {
  const words = new Uint16Array(count);
  for (let i = 0; i < count; i++) words[i] = u16le(data, at + i * 2);
  return words;
}
function decodeKidsSprites(data) {
  const ship = cellWords(data, KIDS_REGION.ship.offset, KIDS_SHIP_TABLE_BYTES / 2);
  const stages = [];
  for (let s = 0; s < KIDS_STAGES; s++) {
    const base = KIDS_REGION.sprites.offset + s * KIDS_SPRITE_STAGE_BYTES;
    const classes = KIDS_APPEAR_CLASSES.map((spec, k) => {
      const at = base + KIDS_SPRITE_CLASS_OFFSETS[k];
      const entries = [];
      for (let i = 0; i < spec.count; i++) {
        entries.push(cellWords(data, at + i * KIDS_SPRITE_ENTRY_WORDS * 2, KIDS_SPRITE_ENTRY_WORDS));
      }
      return { klass: k, size: spec.size, entries };
    });
    const bosses = KIDS_SPRITE_BOSS_OFFSETS.map((off, i) => ({
      part: i,
      words: cellWords(data, base + off, KIDS_SPRITE_BOSS_WORDS)
    }));
    stages.push({ stage: s, classes, bosses });
  }
  return { ship, stages };
}
function kidsCgPages(graphics) {
  const pages = [];
  for (let p = 0; p < 4; p++) pages.push(decodeCgPage(graphics.subarray(p * CG_PAGE_SIZE, (p + 1) * CG_PAGE_SIZE)));
  return pages;
}
function attempt(result, block, fn) {
  try {
    result[block] = fn();
  } catch (err) {
    result[block] = null;
    result.errors.push({ block, message: err.message });
  }
}
function parseKidsSave(block, { filename = "" } = {}) {
  const result = {
    game: "kids",
    filename,
    productOk: filename === "" || filename === KIDS_PRODUCT,
    size: block.length,
    sizeOk: block.length === KIDS_BLOCK_SIZE,
    header: null,
    gameName: null,
    gameNameAscii: null,
    table: null,
    checksums: null,
    graphics: null,
    data: null,
    tail: null,
    hiScores: null,
    options: null,
    map: null,
    scroll: null,
    appear: null,
    config: null,
    records: null,
    sprites: null,
    pages: null,
    regions: KIDS_REGIONS,
    errors: []
  };
  attempt(result, "header", () => parseSaveHeader(block));
  if (result.header) {
    result.gameName = bracketedName(result.header.title);
    result.gameNameAscii = result.gameName === null ? null : narrow(result.gameName).replace(/\s+/g, " ").trim();
  }
  attempt(result, "table", () => parseKidsTable(block));
  const table = result.table;
  if (!table) return result;
  if (!table.consistent) result.errors.push({ block: "table", message: table.problems.join("; ") });
  attempt(result, "checksums", () => validateKidsTable(block, table));
  const section = (s) => block.subarray(s.offset, Math.min(s.offset + s.size, block.length));
  attempt(result, "graphics", () => {
    const out = Uint8Array.from(decompress(section(table.sections.graphics)));
    if (out.length !== KIDS_GRAPHICS_SIZE) throw new Error(`graphics decompress to ${out.length}, expected ${KIDS_GRAPHICS_SIZE}`);
    return out;
  });
  attempt(result, "data", () => {
    const out = Uint8Array.from(decompress(section(table.sections.data)));
    if (out.length !== KIDS_DATA_SIZE) throw new Error(`data decompress to ${out.length}, expected ${KIDS_DATA_SIZE}`);
    return out;
  });
  attempt(result, "tail", () => section(table.sections.tail));
  if (result.tail) {
    attempt(result, "hiScores", () => decodeKidsHiScores(result.tail));
    attempt(result, "options", () => decodeKidsOptions(result.tail));
  }
  if (result.data) {
    attempt(result, "map", () => decodeKidsMap(result.data));
    attempt(result, "scroll", () => decodeKidsScroll(result.data));
    attempt(result, "config", () => decodeKidsConfig(result.data));
    attempt(result, "appear", () => decodeKidsAppear(result.data, { horizontal: result.config?.horizontal ?? false }));
    attempt(result, "records", () => decodeKidsRecords(result.data));
    attempt(result, "sprites", () => decodeKidsSprites(result.data));
  }
  if (result.graphics) attempt(result, "pages", () => kidsCgPages(result.graphics));
  return result;
}

// packages/shmup-engine/src/psx/kids-edit.js
function putU16le(bytes, at, v) {
  bytes[at] = v & 255;
  bytes[at + 1] = v >> 8 & 255;
}
function putU32le(bytes, at, v) {
  putU16le(bytes, at, v & 65535);
  putU16le(bytes, at + 2, v >>> 16 & 65535);
}
function hex(n) {
  return "0x" + n.toString(16);
}
function intIn(name, v, lo, hi) {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    throw new Error(`${name} is ${v}; the range is ${lo}..${hi}`);
  }
  return v;
}
function assertKidsBlock(block) {
  if (!(block instanceof Uint8Array)) {
    throw new Error(`a Dezaemon Kids! block must be a Uint8Array; got ${typeof block}`);
  }
  if (block.length !== KIDS_BLOCK_SIZE) {
    throw new Error(`editing needs the whole ${KIDS_BLOCK_SIZE}-byte block; got ${block.length}`);
  }
}
var KIDS_TABLE_WORD_NAMES = Object.freeze([
  "end",
  "graphicsSize",
  "dataSize",
  "graphicsOffset",
  "graphicsSum",
  "dataOffset",
  "dataSum",
  "tailOffset",
  "tailSum",
  "graphicsPadded",
  "dataPadded"
]);
function kidsLayout(graphicsSize, dataSize) {
  const graphicsPadded = roundUp(graphicsSize, KIDS_SECTOR);
  const dataPadded = roundUp(dataSize, KIDS_SECTOR);
  const graphicsOffset = KIDS_FIRST_SECTION;
  const dataOffset = graphicsOffset + graphicsPadded;
  const tailOffset = dataOffset + dataPadded;
  return {
    graphicsSize,
    dataSize,
    graphicsPadded,
    dataPadded,
    graphicsOffset,
    dataOffset,
    tailOffset,
    end: tailOffset + KIDS_TAIL_SIZE
  };
}
function assertFits(layout, what) {
  if (layout.end <= KIDS_BLOCK_SIZE) return;
  throw new Error(
    `${what} needs ${layout.end} bytes \u2014 graphics ${layout.graphicsSize} padded to ${layout.graphicsPadded}, data ${layout.dataSize} padded to ${layout.dataPadded}, a ${KIDS_TAIL_SIZE}-byte tail, all after ${hex(KIDS_FIRST_SECTION)} \u2014 and a memory-card file holds ${KIDS_BLOCK_SIZE} (${hex(KIDS_BLOCK_SIZE)}); it is ${layout.end - KIDS_BLOCK_SIZE} bytes over`
  );
}
function sealKidsTable(block, { graphics, data } = {}) {
  assertKidsBlock(block);
  const current = parseKidsTable(block);
  if (graphics === void 0 || graphics === null || data === void 0 || data === null) {
    if (!current.consistent) {
      throw new Error(
        `the block's own directory is inconsistent (${current.problems.join("; ")}), so the omitted compressed size cannot be read back from it; pass {graphics, data} explicitly`
      );
    }
    graphics ??= current.sections.graphics.size;
    data ??= current.sections.data.size;
  }
  intIn("graphics compressed size", graphics, 1, KIDS_BLOCK_SIZE);
  intIn("data compressed size", data, 1, KIDS_BLOCK_SIZE);
  const layout = kidsLayout(graphics, data);
  assertFits(layout, "the directory these sizes describe");
  const table = [
    layout.end,
    layout.graphicsSize,
    layout.dataSize,
    layout.graphicsOffset,
    byteSum2(block, layout.graphicsOffset, layout.graphicsOffset + layout.graphicsPadded),
    layout.dataOffset,
    byteSum2(block, layout.dataOffset, layout.dataOffset + layout.dataPadded),
    layout.tailOffset,
    byteSum2(block, layout.tailOffset, layout.end),
    layout.graphicsPadded,
    layout.dataPadded
  ];
  const words = [];
  for (let i = 0; i < KIDS_TABLE_WORDS; i++) {
    const offset = KIDS_TABLE_OFFSET + i * 4;
    const before = u32le(block, offset);
    const after = table[i] >>> 0;
    if (before === after) continue;
    putU32le(block, offset, after);
    words.push({ index: i, name: KIDS_TABLE_WORD_NAMES[i], offset, before, after });
  }
  const sealed = parseKidsTable(block);
  return {
    words,
    table,
    bytes: words.length * 4,
    checksums: validateKidsTable(block, sealed),
    consistent: sealed.consistent,
    end: layout.end,
    slack: KIDS_BLOCK_SIZE - layout.end
  };
}
var KIDS_HISCORE_NAME_PAD = 46;
var KIDS_TITLE_NAME_OFFSET = TITLE_OFFSET + 42;
var KIDS_TITLE_NAME_BYTES = 20;
var KIDS_TITLE_NAME_CHARS = KIDS_TITLE_NAME_BYTES / 2;
var KIDS_TITLE_OPEN = 33143;
var KIDS_TITLE_CLOSE = 33144;
var KIDS_TITLE_PAD = 33088;
if (KIDS_TITLE_NAME_OFFSET + KIDS_TITLE_NAME_BYTES + 2 !== TITLE_OFFSET + TITLE_LENGTH) {
  throw new Error("the Kids! name field no longer ends flush with the 0x40-byte title");
}
var SJIS_PUNCTUATION = Object.freeze({
  " ": KIDS_TITLE_PAD,
  "!": 33097,
  "#": 33172,
  "$": 33168,
  "%": 33171,
  "&": 33173,
  "(": 33129,
  ")": 33130,
  "*": 33174,
  "+": 33147,
  ",": 33091,
  "-": 33148,
  ".": 33092,
  "/": 33118,
  ":": 33094,
  ";": 33095,
  "<": 33155,
  "=": 33153,
  ">": 33156,
  "?": 33096,
  "@": 33175,
  "[": 33133,
  "\\": 33119,
  "]": 33134,
  "^": 33103,
  "_": 33105,
  "`": 33101,
  "{": 33135,
  "|": 33122,
  "}": 33136,
  "~": 33120
});
function sjisWord(ch) {
  if (ch === "\u3000") return KIDS_TITLE_PAD;
  const code = ch.charCodeAt(0);
  const ascii = code >= 65281 && code <= 65374 ? String.fromCharCode(code - 65248) : ch;
  if (ascii >= "0" && ascii <= "9") return 33359 + (ascii.charCodeAt(0) - 48);
  if (ascii >= "A" && ascii <= "Z") return 33376 + (ascii.charCodeAt(0) - 65);
  if (ascii >= "a" && ascii <= "z") return 33409 + (ascii.charCodeAt(0) - 97);
  return SJIS_PUNCTUATION[ascii] ?? null;
}
function kidsNameBytes(text) {
  if (typeof text !== "string") throw new Error(`a game name is a string; got ${typeof text}`);
  const chars = [...text];
  if (chars.length > KIDS_TITLE_NAME_CHARS) {
    throw new Error(
      `the title's name field is ${KIDS_TITLE_NAME_CHARS} fullwidth characters (${KIDS_TITLE_NAME_BYTES} bytes, fixed); "${text}" is ${chars.length}`
    );
  }
  const out = new Uint8Array(KIDS_TITLE_NAME_BYTES);
  for (let i = 0; i < KIDS_TITLE_NAME_CHARS; i++) {
    const word = i < chars.length ? sjisWord(chars[i]) : KIDS_TITLE_PAD;
    if (word === null) {
      throw new Error(
        `"${chars[i]}" has no ASCII Shift-JIS form; kidsNameBytes encodes 0x20..0x7E and their fullwidth twins only, and 54 of the 77 community names are katakana \u2014 pass raw Shift-JIS bytes to setKidsGameName for those`
      );
    }
    out[i * 2] = word >> 8 & 255;
    out[i * 2 + 1] = word & 255;
  }
  return out;
}

// packages/shmup-engine/src/psx/memcard-write.js
var BROKEN_LIST_FIRST_FRAME = 16;
var BROKEN_LIST_FRAMES = 20;
var BROKEN_DATA_FIRST_FRAME = 36;
var WRITE_TEST_FRAME = 63;
var NO_BROKEN_SECTOR = 4294967295;
function putU16le2(bytes, at, v) {
  bytes[at] = v & 255;
  bytes[at + 1] = v >> 8 & 255;
}
function putU32le2(bytes, at, v) {
  putU16le2(bytes, at, v & 65535);
  putU16le2(bytes, at + 2, v >>> 16 & 65535);
}
function seal(frame) {
  frame[FRAME_SIZE - 1] = frameChecksum(frame);
}
function formatMemoryCard() {
  const card = new Uint8Array(CARD_SIZE);
  const header = card.subarray(0, FRAME_SIZE);
  header[0] = 77;
  header[1] = 67;
  seal(header);
  for (let i = 0; i < BLOCK_COUNT; i++) {
    const frame = card.subarray(DIRECTORY_OFFSET + i * FRAME_SIZE, DIRECTORY_OFFSET + (i + 1) * FRAME_SIZE);
    frame[0] = STATUS.FREE;
    putU16le2(frame, 8, NO_NEXT);
    seal(frame);
  }
  for (let i = 0; i < BROKEN_LIST_FRAMES; i++) {
    const at = (BROKEN_LIST_FIRST_FRAME + i) * FRAME_SIZE;
    const frame = card.subarray(at, at + FRAME_SIZE);
    putU32le2(frame, 0, NO_BROKEN_SECTOR);
    seal(frame);
  }
  card.fill(255, BROKEN_DATA_FIRST_FRAME * FRAME_SIZE, WRITE_TEST_FRAME * FRAME_SIZE);
  card.set(header, WRITE_TEST_FRAME * FRAME_SIZE);
  return card;
}
function encodeCardFilename(filename) {
  if (typeof filename !== "string" || !filename.length) throw new Error("a card file needs a name");
  if (filename.length > FILENAME_LENGTH) {
    throw new Error(`a card file name is at most ${FILENAME_LENGTH} bytes; "${filename}" is ${filename.length}`);
  }
  const out = new Uint8Array(FILENAME_LENGTH);
  for (let i = 0; i < filename.length; i++) {
    const c = filename.charCodeAt(i);
    if (c < 32 || c > 126) throw new Error(`"${filename[i]}" is not printable ASCII; a card file name is`);
    out[i] = c;
  }
  return out;
}
function buildMemoryCard(files) {
  const card = formatMemoryCard();
  let next = 1;
  for (const file of files) {
    if (!(file.data instanceof Uint8Array) || !file.data.length) {
      throw new Error(`${file.filename || "(unnamed)"}: a card file is a non-empty Uint8Array`);
    }
    const blocks = Math.ceil(file.data.length / BLOCK_SIZE);
    if (next + blocks - 1 > BLOCK_COUNT) {
      throw new Error(
        `${file.filename} needs ${blocks} block${blocks === 1 ? "" : "s"} and the card has ${BLOCK_COUNT - next + 1} free of ${BLOCK_COUNT}`
      );
    }
    const name = encodeCardFilename(file.filename);
    for (let k = 0; k < blocks; k++) {
      const block = next + k;
      const frame = card.subarray(DIRECTORY_OFFSET + (block - 1) * FRAME_SIZE, DIRECTORY_OFFSET + block * FRAME_SIZE);
      frame.fill(0);
      const last = k === blocks - 1;
      frame[0] = k === 0 ? STATUS.FIRST : last ? STATUS.LAST : STATUS.MIDDLE;
      if (k === 0) {
        putU32le2(frame, 4, file.data.length);
        frame.set(name, FILENAME_OFFSET);
      }
      putU16le2(frame, 8, last ? NO_NEXT : block);
      seal(frame);
      card.set(file.data.subarray(k * BLOCK_SIZE, (k + 1) * BLOCK_SIZE), block * BLOCK_SIZE);
    }
    next += blocks;
  }
  const back = parseMemoryCard(card);
  if (!back.magicOk || !back.headerChecksumOk || !back.frames.every((f) => f.checksumOk)) {
    throw new Error("the card this built does not read back: a directory frame failed its checksum");
  }
  for (const file of files) {
    const found = back.files.find((f) => f.filename === file.filename);
    if (!found || !found.complete || found.size !== file.data.length) {
      throw new Error(`${file.filename} did not come back off the card it was just written to`);
    }
    for (let i = 0; i < file.data.length; i++) {
      if (found.data[i] !== file.data[i]) {
        throw new Error(`${file.filename} read back with a different byte at 0x${i.toString(16)}`);
      }
    }
  }
  return card;
}

// packages/shmup-engine/src/psx/kids-write.js
var KIDS_SPRITE_STRIPS = Object.freeze([
  Object.freeze({ klass: 0, w: 2, h: 2, frames: 4, stripW: 8, stripH: 2 }),
  Object.freeze({ klass: 1, w: 4, h: 2, frames: 2, stripW: 8, stripH: 2 }),
  Object.freeze({ klass: 2, w: 2, h: 4, frames: 2, stripW: 4, stripH: 4 }),
  Object.freeze({ klass: 3, w: 4, h: 4, frames: 1, stripW: 4, stripH: 4 })
]);
var KIDS_CLASS_BOXES = Object.freeze(KIDS_SPRITE_STRIPS.map(
  (strip, k) => Object.freeze({ w: strip.w * CG_CELL, h: strip.h * CG_CELL, count: KIDS_APPEAR_CLASSES[k].count })
));
var KIDS_BOSS_GRID = 8;
var KIDS_BOSS_ART_CELLS = Object.freeze([[4, 4], [8, 4], [4, 8], [8, 8]]);
var KIDS_BOSS_FOOTPRINT = Object.freeze([[2, 2], [4, 2], [2, 4], [4, 4]]);
var KIDS_SHIP_LAYOUT = Object.freeze({
  ship1: Object.freeze({ poses: [0, 4, 8], shot: 12, bomb: 16 }),
  ship2: Object.freeze({ poses: [32, 36, 40], shot: 44, bomb: 48 }),
  title1: Object.freeze({ at: 64, w: 8, h: 6 }),
  title2: Object.freeze({ at: 112, w: 8, h: 6 }),
  items: Object.freeze({ at: 160, count: 6 }),
  blast: Object.freeze({ at: 166, frames: 6 }),
  bullets: Object.freeze({ at: 190, count: 7, frames: 4 })
});
function blastWords(f) {
  const base = f < 3 ? 166 + 2 * f : 178 + 2 * (f - 3);
  return [base, base + 1, base + 6, base + 7];
}
function bombWords(at, f) {
  return [at + f * 2, at + f * 2 + 1, at + 8 + f * 2, at + 8 + f * 2 + 1];
}
var KIDS_SHIP_TABLE_WORDS = KIDS_SHIP_TABLE_BYTES / 2;
var KIDS_ITEM_SLOTS = Object.freeze([
  Object.freeze({ name: "POWER UP", frames: ["powerupBig0.gif", "powerupBig0.png", "powerupBig1.gif"], fallback: "square", type: 7 }),
  Object.freeze({ name: "SPEED UP", frames: ["speedupItem0.gif", "speedupItem0.png", "speedupItem1.gif"], fallback: "square", type: 8 }),
  Object.freeze({ name: "BOMB UP", frames: ["barrierItem0.gif", "barrierItem0.png", "barrierItem1.gif"], fallback: "square", type: 5 }),
  Object.freeze({ name: "1UP", frames: ["1upItem0.gif", "1upItem0.png"], fallback: "ship", type: 4 }),
  Object.freeze({ name: "1000PTS", frames: ["scoreItem0.gif", "scoreItem0.png"], fallback: "coin", type: 6 }),
  Object.freeze({ name: "50000PTS", frames: ["scoreItem1.gif", "scoreItem1.png"], fallback: "bigCoin", type: 6 })
]);
var KIDS_STOCK_ITEM_FRAMES = Object.freeze(KIDS_ITEM_SLOTS.flatMap((s) => s.frames));
var KIDS_MOVE_STRAIGHT = 4;
var KIDS_STRAIGHT_SPEEDS = Object.freeze([1, 2, 4.5]);
var RUNTIME_TO_KIDS_SPEED = 0.5;
var KIDS_GROUND_MARK = 128;
var KIDS_HP_TABLES = Object.freeze([
  Object.freeze([256, 38400, 102400, 512e3]),
  Object.freeze([12800, 76800, 204800, 512e3]),
  Object.freeze([12800, 76800, 204800, 512e3]),
  Object.freeze([25600, 153600, 409600, 512e3])
]);
var KIDS_SHOT_UNITS = 5120;
var KIDS_SCORE_TABLES = Object.freeze([
  Object.freeze([50, 100, 200]),
  Object.freeze([500, 1e3, 2e3]),
  Object.freeze([500, 1e3, 2e3]),
  Object.freeze([2e3, 5e3, 1e4])
]);
var KIDS_ITEM_FOR_DROP = Object.freeze({ 1: 1, 2: 1, 3: 2, 9: 3 });
var KIDS_BOSS_HP = Object.freeze([512e3, 2304e3, 4608e3, 768e4]);
var KIDS_BOSS_SCORE = Object.freeze([5e4, 11e4, 55e4]);
var KIDS_BOSS_SPEEDS = 3;
function encodeKidsRecord({
  movement = KIDS_MOVE_STRAIGHT,
  variant: variant2 = 0,
  fromBehind = false,
  hardness = 0,
  scoreTier = 0,
  opacity = 0,
  bullet = 0,
  timing = 0,
  animIndex = 1,
  shotPattern = 0,
  aim = false,
  item = 0,
  rotation = 0,
  scale = 0,
  ground = false
} = {}) {
  return [
    movement & 31 | variant2 % 3 << 5 | (fromBehind ? 128 : 0),
    hardness & 7 | (scoreTier & 3) << 3 | opacity % 5 << 5,
    bullet % 9 | (timing & 3) << 4 | (animIndex & 3) << 6,
    shotPattern & 15 | (aim ? 16 : 0) | (item & 7) << 5,
    rotation % 5 | scale % 5 << 3 | (ground ? KIDS_GROUND_MARK : 0)
  ];
}
function encodeKidsBoss({
  pattern = 0,
  speed = 1,
  sizeClass = 3,
  hpClass = 1,
  scoreClass = 1,
  opacity = 0,
  rotation = 0,
  scale = 0,
  ground = false,
  weapons = []
} = {}) {
  const b = new Uint8Array(KIDS_BOSS_SIZE);
  b[0] = pattern & 15 | speed % KIDS_BOSS_SPEEDS << 4 | (sizeClass & 3) << 6;
  b[1] = hpClass & 3 | (scoreClass & 3) << 3 | opacity % 5 << 5;
  b[2] = rotation % 5 | scale % 5 << 3 | (ground ? 128 : 0);
  for (let w = 0; w < 3; w++) {
    const wp = weapons[w] || { dx: 0, dy: 0, bullet: 0, timing: 0, pattern: 0, aim: false };
    b[3 + w * 4] = wp.dx & 255;
    b[4 + w * 4] = wp.dy & 255;
    b[5 + w * 4] = wp.bullet % 9 | (wp.timing & 3) << 4;
    b[6 + w * 4] = wp.pattern & 15 | (wp.aim ? 16 : 0);
  }
  return b;
}
var KIDS_BOSS_BEHAVIOUR = Object.freeze([
  Object.freeze({ pattern: 1, speed: 1, weapons: [{ dx: 0, dy: 27, bullet: 1, timing: 2, pattern: 6, aim: true }, { dx: 6, dy: 32, bullet: 1, timing: 1, pattern: 13, aim: false }, { dx: 6, dy: 16, bullet: 0, timing: 1, pattern: 0, aim: true }] }),
  Object.freeze({ pattern: 10, speed: 1, weapons: [{ dx: -26, dy: -1, bullet: 0, timing: 2, pattern: 3, aim: true }, { dx: 25, dy: -1, bullet: 0, timing: 2, pattern: 3, aim: true }, { dx: 0, dy: 0, bullet: 3, timing: 1, pattern: 6, aim: false }] }),
  Object.freeze({ pattern: 2, speed: 0, weapons: [{ dx: -6, dy: -12, bullet: 6, timing: 2, pattern: 9, aim: false }, { dx: -24, dy: -12, bullet: 4, timing: 1, pattern: 0, aim: true }, { dx: 12, dy: -13, bullet: 4, timing: 1, pattern: 0, aim: true }] }),
  Object.freeze({ pattern: 12, speed: 1, weapons: [{ dx: 0, dy: 53, bullet: 7, timing: 2, pattern: 0, aim: false }, { dx: 0, dy: -30, bullet: 3, timing: 0, pattern: 3, aim: true }, { dx: -1, dy: 2, bullet: 1, timing: 1, pattern: 3, aim: false }] })
]);
function kidsBossWeapons(sample, rec, quadOf) {
  const slots = bossWeapons(rec);
  const quadOfSlot = (i) => {
    const hit = slots[i] || slots[0];
    const first = hit ? weaponTextures(hit.weapon)[0] : null;
    return first ? quadOf(first) : null;
  };
  return sample.map((w, i) => {
    const q = quadOfSlot(i);
    return q === null ? { ...w } : { ...w, bullet: q };
  });
}
var KIDS_BOSS_DEFAULT = Object.freeze(Array.from(encodeKidsBoss({ pattern: 0, speed: 1, sizeClass: 0, hpClass: 1, scoreClass: 1 })));
var KIDS_CONFIG_TEMPLATE = Object.freeze([
  0,
  162,
  3,
  1,
  32,
  1,
  0,
  1,
  129,
  128,
  71,
  1,
  130,
  70,
  1,
  2,
  2,
  9,
  9,
  9,
  9,
  5,
  5,
  5,
  1,
  9,
  5,
  0,
  0,
  0,
  1,
  0,
  0,
  3,
  0,
  127,
  3,
  0,
  31,
  127,
  1,
  0,
  0,
  127,
  6,
  0,
  32,
  127,
  5,
  0,
  32,
  127,
  2,
  0,
  24,
  127,
  0,
  0,
  24,
  127,
  16,
  0,
  87,
  127,
  16,
  0,
  87,
  127,
  18,
  0,
  24,
  127,
  0,
  0,
  24,
  127,
  0,
  0,
  85,
  127,
  32,
  0,
  61,
  127,
  88,
  0,
  58,
  127,
  0,
  0,
  24,
  127,
  0,
  0,
  24,
  127,
  0,
  0,
  24,
  7,
  7,
  1,
  7,
  17,
  20,
  6,
  6,
  22,
  22,
  3,
  25,
  0
]);
var KIDS_CONFIG_SOUND_OFFSET = 35;
var KIDS_CONFIG_MOTION_OFFSET = 99;
var KIDS_CONFIG_BACKGROUND_OFFSET = 105;
var KIDS_CONFIG_LAST_STAGE = 128;
var KIDS_MOTION_DEFAULT = 2;
var KIDS_MOTION_BACKGROUND = 32;
var KIDS_BACKGROUND_SETS = 38;
var KIDS_FACTORY_OPTIONS = Object.freeze([
  1,
  1,
  160,
  80,
  1,
  160,
  80,
  0,
  1,
  160,
  80,
  8,
  2,
  1,
  1,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  0,
  0,
  2,
  0,
  127,
  0
]);
var KIDS_FACTORY_LEVEL = 1;
var KIDS_FIRST_SPAWN_ROW = 4;
var KIDS_ROW_STEP = 6;
var KIDS_BOSS_ROW_GAP = 12;
var KIDS_MAX_SPAWN_ROW = KIDS_APPEAR_ROWS - 16;
var KIDS_FIRST_VISIBLE_COLUMN = 1;
var KIDS_VISIBLE_COLUMNS = KIDS_MAP_COLUMNS;
var KIDS_BOSS_COLUMN = Object.freeze([3, 2, 3, 2]);
var KIDS_SCROLL_RUN = 2;
var KIDS_SCROLL_HALT = 0;
var KIDS_MAP_FILL = 32896;
var KIDS_STORY_TOP_ROW = 4;
var KIDS_STORY_ROWS = KIDS_STORY_TOP_ROW + 1;
var KIDS_STORY_LEAD_ROWS = 4;
var KIDS_STORY_SCROLL = 1;
var KIDS_STORY_SLOW_UNITS = 1;
var clamp2 = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function nearestIndex2(table, value) {
  let best = 0, bestD = Infinity;
  table.forEach((v, i) => {
    const d = Math.abs(v - value);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
function putU16le3(bytes, at, v) {
  bytes[at] = v & 255;
  bytes[at + 1] = v >> 8 & 255;
}
function putU32le3(bytes, at, v) {
  putU16le3(bytes, at, v & 65535);
  putU16le3(bytes, at + 2, v >>> 16 & 65535);
}
function b64ToBytes2(b64) {
  const bin = atob(String(b64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function mapKidsColumn(col, width, cellsWide = 1) {
  const last = KIDS_FIRST_VISIBLE_COLUMN + KIDS_VISIBLE_COLUMNS - cellsWide;
  if (width <= 1) return clamp2(KIDS_FIRST_VISIBLE_COLUMN + Math.floor((KIDS_VISIBLE_COLUMNS - cellsWide) / 2), KIDS_FIRST_VISIBLE_COLUMN, last);
  const c = KIDS_FIRST_VISIBLE_COLUMN + Math.round(col * (KIDS_VISIBLE_COLUMNS - 1) / (width - 1));
  return clamp2(c, KIDS_FIRST_VISIBLE_COLUMN, last);
}
function kidsClassFor(w, h) {
  if (w <= 32 && h <= 32) return 0;
  if (h <= 32) return 1;
  if (w <= 32) return 2;
  return 3;
}
function kidsBossClassFor(w, h) {
  if (w <= 64 && h <= 64) return 0;
  if (h <= 64) return 1;
  if (w <= 64) return 2;
  return 3;
}
var paletteRgb = null;
var nearestCache = /* @__PURE__ */ new Map();
function nearestKidsIndex(r, g, b) {
  const key = r << 16 | g << 8 | b;
  const hit = nearestCache.get(key);
  if (hit !== void 0) return hit;
  if (!paletteRgb) paletteRgb = KIDS_PALETTE.map((w) => rgb555ToRgb(w & 32767));
  let best = 1, bestD = Infinity;
  for (let i = 1; i < paletteRgb.length; i++) {
    const p = paletteRgb[i];
    const dr = p.r - r, dg = p.g - g, db = p.b - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  nearestCache.set(key, best);
  return best;
}
var KIDS_ALPHA_CUTOFF = 128;
function quantizeKidsFrame(frame) {
  const out = new Uint8Array(frame.w * frame.h);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    if (frame.rgba[o + 3] < KIDS_ALPHA_CUTOFF) {
      out[i] = KIDS_TRANSPARENT_INDEX;
      continue;
    }
    out[i] = nearestKidsIndex(frame.rgba[o], frame.rgba[o + 1], frame.rgba[o + 2]);
  }
  return out;
}
var KidsBankFullError = class extends Error {
  constructor(what) {
    super(`the four CG pages hold ${KIDS_CELL_COUNT} cells and every one is taken (${what})`);
    this.name = "KidsBankFullError";
  }
};
function cellKey(cell) {
  let s = "";
  for (let i = 0; i < cell.length; i++) s += String.fromCharCode(cell[i]);
  return s;
}
function flipCellH(cell, dim2) {
  const out = new Uint8Array(cell.length);
  for (let y = 0; y < dim2; y++) for (let x = 0; x < dim2; x++) out[y * dim2 + x] = cell[y * dim2 + (dim2 - 1 - x)];
  return out;
}
function flipCellV(cell, dim2) {
  const out = new Uint8Array(cell.length);
  for (let y = 0; y < dim2; y++) out.set(cell.subarray((dim2 - 1 - y) * dim2, (dim2 - y) * dim2), y * dim2);
  return out;
}
function isBlank2(bytes) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i]) return false;
  return true;
}
var KidsCellBank = class {
  constructor() {
    this.graphics = new Uint8Array(KIDS_GRAPHICS_SIZE);
    this.taken = new Uint8Array(KIDS_CELL_COUNT);
    this.used = 0;
    this.chips = 0;
    this.sprites = 0;
    this.shared = 0;
    this.cellByKey = /* @__PURE__ */ new Map();
    this.chipByKey = /* @__PURE__ */ new Map();
    this.nextSingle = KIDS_CELL_COUNT - 1;
  }
  get free() {
    return KIDS_CELL_COUNT - this.used;
  }
  _store(index, cell) {
    this.graphics.set(cell, index * CG_CELL_BYTES);
    this.taken[index] = 1;
    this.used++;
  }
  /** One 16x16 cell -> its word (cell | flips), or KIDS_BLANK. */
  addCell(cell) {
    if (isBlank2(cell)) return KIDS_BLANK;
    const key = cellKey(cell);
    const hit = this.cellByKey.get(key);
    if (hit) {
      this.shared++;
      return hit;
    }
    let index = this.nextSingle;
    while (index >= 0 && this.taken[index]) index--;
    if (index < 0) throw new KidsBankFullError("a sprite cell");
    this.nextSingle = index - 1;
    this._store(index, cell);
    this.sprites++;
    this.cellByKey.set(key, index);
    const h = flipCellH(cell, CG_CELL), v = flipCellV(cell, CG_CELL);
    for (const [bytes, flags] of [[h, KIDS_HFLIP], [v, KIDS_VFLIP], [flipCellV(h, CG_CELL), KIDS_HFLIP | KIDS_VFLIP]]) {
      const k = cellKey(bytes);
      if (!this.cellByKey.has(k)) this.cellByKey.set(k, index | flags);
    }
    return index;
  }
  /** A 32x32 indexed chip (row-major, 1,024 bytes) -> its map word. */
  addChip(chip) {
    if (isBlank2(chip)) return KIDS_MAP_FILL;
    const key = cellKey(chip);
    const hit = this.chipByKey.get(key);
    if (hit !== void 0) {
      this.shared++;
      return hit;
    }
    let n = -1;
    for (let c = 0; c < KIDS_CELL_COUNT; c++) {
      if ((c & KIDS_CELL_ALIGN) !== 0) continue;
      if (this.taken[c] || this.taken[c + 1] || this.taken[c + 8] || this.taken[c + 9]) continue;
      n = c;
      break;
    }
    if (n < 0) throw new KidsBankFullError("a map chip");
    const dim2 = 2 * CG_CELL;
    for (const [cy, cx, index] of [[0, 0, n], [0, 1, n + 1], [1, 0, n + 8], [1, 1, n + 9]]) {
      const cell = new Uint8Array(CG_CELL_BYTES);
      for (let y = 0; y < CG_CELL; y++) {
        cell.set(chip.subarray((cy * CG_CELL + y) * dim2 + cx * CG_CELL, (cy * CG_CELL + y) * dim2 + cx * CG_CELL + CG_CELL), y * CG_CELL);
      }
      this._store(index, cell);
    }
    this.chips++;
    this.chipByKey.set(key, n);
    const h = flipCellH(chip, dim2), v = flipCellV(chip, dim2);
    for (const [bytes, flags] of [[h, KIDS_HFLIP], [v, KIDS_VFLIP], [flipCellV(h, dim2), KIDS_HFLIP | KIDS_VFLIP]]) {
      const k = cellKey(bytes);
      if (!this.chipByKey.has(k)) this.chipByKey.set(k, n | flags);
    }
    return n;
  }
  /**
   * An indexed frame whose w and h are multiples of 16 -> one word per cell
   * in reading order. Throws KidsBankFullError with nothing stored when the
   * frame's new cells do not fit.
   */
  addFrame(indexed, w, h) {
    const cw = w / CG_CELL, ch = h / CG_CELL;
    const cells = [];
    let need2 = 0;
    const seen = /* @__PURE__ */ new Set();
    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        const cell = new Uint8Array(CG_CELL_BYTES);
        for (let y = 0; y < CG_CELL; y++) {
          cell.set(indexed.subarray((cy * CG_CELL + y) * w + cx * CG_CELL, (cy * CG_CELL + y) * w + cx * CG_CELL + CG_CELL), y * CG_CELL);
        }
        cells.push(cell);
        if (isBlank2(cell)) continue;
        const k = cellKey(cell);
        if (this.cellByKey.has(k) || seen.has(k)) continue;
        seen.add(k);
        need2++;
      }
    }
    if (need2 > this.free) throw new KidsBankFullError(`${need2} new cells for a ${w}x${h} frame, ${this.free} free`);
    return Uint16Array.from(cells, (c) => this.addCell(c));
  }
};
function encodeKidsIcon(frame) {
  const fitted = fitRgba(frame, ICON_DIM, ICON_DIM);
  const hist = colorHistogram([fitted]);
  const words = medianCut(hist, 15);
  const clut = new Uint16Array(16);
  words.forEach((w, i) => {
    clut[i + 1] = w === 0 ? 32768 : w;
  });
  const pixels = new Uint8Array(ICON_DIM * ICON_DIM / 2);
  const to52 = (v) => v >> 3;
  for (let i = 0; i < ICON_DIM * ICON_DIM; i++) {
    const o = i * 4;
    let index = 0;
    if (fitted.rgba[o + 3] >= KIDS_ALPHA_CUTOFF && words.length) {
      const r = to52(fitted.rgba[o]), g = to52(fitted.rgba[o + 1]), b = to52(fitted.rgba[o + 2]);
      let best = 0, bestD = Infinity;
      words.forEach((w, k) => {
        const dr = (w & 31) - r, dg = (w >> 5 & 31) - g, db = (w >> 10 & 31) - b;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      });
      index = best + 1;
    }
    if (i & 1) pixels[i >> 1] |= index << 4;
    else pixels[i >> 1] |= index;
  }
  return { clut, pixels };
}
function coinSprite(size = 12) {
  const dim2 = 16;
  const rgba = new Uint8Array(dim2 * dim2 * 4);
  const c = (dim2 - 1) / 2, r = size / 2;
  for (let y = 0; y < dim2; y++) {
    for (let x = 0; x < dim2; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d > r) continue;
      const o = (y * dim2 + x) * 4;
      const rim = d > r - 1.6;
      const glint = x - c < -r * 0.25 && y - c < -r * 0.25 && d < r - 2;
      rgba[o] = rim ? 150 : glint ? 255 : 250;
      rgba[o + 1] = rim ? 95 : glint ? 250 : 200;
      rgba[o + 2] = rim ? 20 : glint ? 190 : 40;
      rgba[o + 3] = 255;
    }
  }
  return { w: dim2, h: dim2, rgba };
}
function defaultKidsIcon() {
  const rgba = new Uint8Array(ICON_DIM * ICON_DIM * 4);
  const rows = [
    "................",
    ".##############.",
    ".#............#.",
    ".#.##....##...#.",
    ".#.##...##....#.",
    ".#.##..##.....#.",
    ".#.##.##......#.",
    ".#.####.......#.",
    ".#.####.......#.",
    ".#.##.##......#.",
    ".#.##..##.....#.",
    ".#.##...##....#.",
    ".#.##....##...#.",
    ".#............#.",
    ".##############.",
    "................"
  ];
  for (let y = 0; y < ICON_DIM; y++) {
    for (let x = 0; x < ICON_DIM; x++) {
      const o = (y * ICON_DIM + x) * 4;
      const ink = rows[y][x] === "#";
      rgba[o] = ink ? 255 : 40;
      rgba[o + 1] = ink ? 220 : 40;
      rgba[o + 2] = ink ? 80 : 60;
      rgba[o + 3] = 255;
    }
  }
  return { w: ICON_DIM, h: ICON_DIM, rgba };
}
function kidsGameNameFor(name) {
  const source = String(name ?? "").trim() || "my game";
  const kept = [];
  let dropped = false;
  for (const ch of source) {
    try {
      kidsNameBytes(ch);
      kept.push(ch);
    } catch {
      dropped = true;
    }
  }
  let text = kept.join("").replace(/\s+/g, " ").trim();
  const cut = [...text].length > KIDS_TITLE_NAME_CHARS;
  if (cut) text = [...text].slice(0, KIDS_TITLE_NAME_CHARS).join("");
  if (!text) text = "GAME";
  return { text, bytes: kidsNameBytes(text), changed: dropped || cut || text !== source };
}
var KIDS_TITLE_PREFIX_BYTES = Object.freeze([
  131,
  102,
  131,
  85,
  131,
  71,
  131,
  130,
  131,
  147,
  // デザエモン
  130,
  106,
  130,
  137,
  130,
  132,
  130,
  147,
  129,
  73,
  // Ｋｉｄｓ！
  131,
  134,
  129,
  91,
  131,
  85,
  129,
  91,
  131,
  81,
  129,
  91,
  131,
  128,
  131,
  102,
  129,
  91,
  131,
  94,
  // ユーザーゲームデータ
  KIDS_TITLE_OPEN >> 8 & 255,
  KIDS_TITLE_OPEN & 255
  // 『
]);
function buildKidsBlock({ graphics, data, tail, name, icon }) {
  if (!(graphics instanceof Uint8Array) || graphics.length !== KIDS_GRAPHICS_SIZE) {
    throw new Error(`graphics must be ${KIDS_GRAPHICS_SIZE} bytes`);
  }
  if (!(data instanceof Uint8Array) || data.length !== KIDS_DATA_SIZE) throw new Error(`data must be ${KIDS_DATA_SIZE} bytes`);
  if (!(tail instanceof Uint8Array) || tail.length !== KIDS_TAIL_SIZE) throw new Error(`the tail must be ${KIDS_TAIL_SIZE} bytes`);
  if (!(name instanceof Uint8Array) || name.length !== KIDS_TITLE_NAME_BYTES) {
    throw new Error(`the name must be ${KIDS_TITLE_NAME_BYTES} bytes of Shift-JIS (kidsNameBytes)`);
  }
  const block = new Uint8Array(KIDS_BLOCK_SIZE);
  block[0] = 83;
  block[1] = 67;
  block[2] = 17;
  block[3] = KIDS_BLOCK_SIZE / 8192;
  block.set(KIDS_TITLE_PREFIX_BYTES, TITLE_OFFSET);
  block.set(name, KIDS_TITLE_NAME_OFFSET);
  block[KIDS_TITLE_NAME_OFFSET + KIDS_TITLE_NAME_BYTES] = KIDS_TITLE_CLOSE >> 8 & 255;
  block[KIDS_TITLE_NAME_OFFSET + KIDS_TITLE_NAME_BYTES + 1] = KIDS_TITLE_CLOSE & 255;
  if (KIDS_TITLE_NAME_OFFSET + KIDS_TITLE_NAME_BYTES + 2 !== TITLE_OFFSET + TITLE_LENGTH) {
    throw new Error("the title no longer ends flush with its 0x40 bytes");
  }
  for (let i = 0; i < 16; i++) putU16le3(block, CLUT_OFFSET + i * 2, icon.clut[i] ?? 0);
  block.set(icon.pixels.subarray(0, 128), TITLE_FRAME_SIZE);
  const gfx = compress(graphics);
  const dat = compress(data);
  const round = (n) => Math.ceil(n / 128) * 128;
  const dataOffset = KIDS_FIRST_SECTION + round(gfx.length);
  const tailOffset = dataOffset + round(dat.length);
  const end = tailOffset + KIDS_TAIL_SIZE;
  if (end > KIDS_BLOCK_SIZE) {
    throw new Error(
      `the game does not fit a memory-card file: graphics pack to ${gfx.length} bytes and data to ${dat.length}, ${end - KIDS_BLOCK_SIZE} bytes over the ${KIDS_BLOCK_SIZE} a Kids! save holds`
    );
  }
  block.set(gfx, KIDS_FIRST_SECTION);
  block.set(dat, dataOffset);
  block.set(tail, tailOffset);
  const seal2 = sealKidsTable(block, { graphics: gfx.length, data: dat.length });
  if (!seal2.consistent || !seal2.checksums.ok) throw new Error("the block's own directory does not verify after sealing");
  const back = parseKidsSave(block);
  if (back.errors.length) throw new Error(`the block does not read back: ${back.errors.map((e) => e.message).join("; ")}`);
  for (const [label, want, got] of [["graphics", graphics, back.graphics], ["data", data, back.data]]) {
    if (!got || got.length !== want.length) throw new Error(`the ${label} section does not decompress to its size`);
    for (let i = 0; i < want.length; i++) {
      if (got[i] !== want[i]) throw new Error(`the ${label} section differs at 0x${i.toString(16)} after the round trip`);
    }
  }
  return { block, seal: seal2, sizes: { graphics: gfx.length, data: dat.length } };
}
function factoryKidsTail() {
  const tail = new Uint8Array(KIDS_TAIL_SIZE);
  for (let i = 0; i < KIDS_HISCORE_COUNT; i++) {
    const at = i * KIDS_HISCORE_SIZE;
    putU32le3(tail, at, (KIDS_HISCORE_COUNT - i) * 100);
    tail[at + 5] = KIDS_FACTORY_LEVEL;
    tail.fill(KIDS_HISCORE_NAME_PAD, at + 8, at + 16);
  }
  tail.set(KIDS_FACTORY_OPTIONS, KIDS_OPTIONS_OFFSET);
  return tail;
}
function buildKidsGameFromLevel(level, art2, options = {}) {
  const opts = { name: null, title1: null, title2: null, backgroundSet: 0, horizontal: false, storyBackdrops: null, storyPicks: null, storyMinSize: 0, ...options };
  if (!opts.storyPicks && Array.isArray(opts.storyBackdrops) && opts.storyBackdrops.length) {
    return buildKidsWithStory(level, art2, opts);
  }
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const artMap = /* @__PURE__ */ new Map();
  for (const [k, v] of Object.entries(art2 || {})) {
    if (v && v.rgba && v.w > 0 && v.h > 0) artMap.set(decodeFrameKey(k), { key: decodeFrameKey(k), ...v });
  }
  const lookup = (n) => n ? artMap.get(decodeFrameKey(n)) || null : null;
  let stages = levelStages(level);
  if (!stages.length) throw new Error("the level has no stage with an enemylist");
  if (stages.length > KIDS_STAGES) {
    warn(`level has ${stages.length} stages; a Kids! save holds ${KIDS_STAGES} \u2014 dropped the rest`);
    stages = stages.slice(0, KIDS_STAGES);
  }
  if (opts.horizontal) warn("the grid is horizontal; a Kids! game is written as a vertical one here \u2014 enemies come down the screen");
  const enemyData = level.enemyData || {};
  const bossData = level.bossData || {};
  const bank = new KidsCellBank();
  const fullWarned = /* @__PURE__ */ new Set();
  const bankFrame = (indexed, w, h, what) => {
    try {
      return bank.addFrame(indexed, w, h);
    } catch (e) {
      if (!(e instanceof KidsBankFullError)) throw e;
      if (!fullWarned.has(what)) {
        fullWarned.add(what);
        warn(`CG pages full (${KIDS_CELL_COUNT} cells): ${what} art left unpainted`);
      }
      return null;
    }
  };
  const fitIndexed2 = (frame, w, h) => quantizeKidsFrame(fitRgba(frame, w, h));
  const data = new Uint8Array(KIDS_DATA_SIZE);
  const putWords = (at, list) => {
    for (let i = 0; i < list.length; i++) putU16le3(data, at + i * 2, list[i]);
  };
  for (let i = 0; i < KIDS_REGION.map.length; i += 2) putU16le3(data, KIDS_REGION.map.offset + i, KIDS_MAP_FILL);
  let shipSource = "level";
  let shipFrames = (level.playerData && level.playerData.texture || []).map(lookup).filter(Boolean);
  if (!shipFrames.length) {
    shipSource = "duke";
    shipFrames = decodePlayerArt().filter((f) => /^duke_\d$/.test(f.key)).slice(0, 2);
  }
  const shipWords = new Uint16Array(KIDS_SHIP_TABLE_WORDS).fill(KIDS_BLANK);
  const poseWords = (frame) => {
    if (!frame) return new Uint16Array(4).fill(KIDS_BLANK);
    return bankFrame(fitIndexed2(frame, 32, 32), 32, 32, "player") || new Uint16Array(4).fill(KIDS_BLANK);
  };
  const centre = shipFrames[0] || null;
  const bank0 = shipFrames.length > 1 ? shipFrames[1] : centre;
  const poses = [poseWords(bank0), poseWords(centre), poseWords(bank0 ? hflipRgba(fitRgba(bank0, 32, 32)) : null)];
  for (const ship of [KIDS_SHIP_LAYOUT.ship1, KIDS_SHIP_LAYOUT.ship2]) {
    ship.poses.forEach((at, i) => shipWords.set(poses[i], at));
  }
  const pd = level.playerData || {};
  const shotArt = [];
  for (const mode of ["shootNormal", "shoot3way", "shootBig"]) {
    const tex = pd[mode] && Array.isArray(pd[mode].texture) ? pd[mode].texture : [];
    for (const f of tex.map(lookup).filter(Boolean)) {
      if (shotArt.some((s) => s.key === f.key)) continue;
      shotArt.push(f.w > f.h ? { ...rotateCcwRgba(f), key: f.key } : f);
    }
  }
  const shotFrames = spreadFrames(shotArt.length ? shotArt : [shotSprite(16, 16)], 4);
  const shotWords = shotFrames.map((f) => (bankFrame(fitIndexed2(f, 16, 16), 16, 16, "player shot") || new Uint16Array([KIDS_BLANK]))[0]);
  const blastRings = blastFrames(32, KIDS_SHIP_LAYOUT.blast.frames);
  const blastCells = blastRings.map((f) => bankFrame(quantizeKidsFrame(f), 32, 32, "blast") || new Uint16Array(4).fill(KIDS_BLANK));
  for (const ship of [KIDS_SHIP_LAYOUT.ship1, KIDS_SHIP_LAYOUT.ship2]) {
    shotWords.forEach((w, i) => {
      shipWords[ship.shot + i] = w;
    });
    for (let f = 0; f < 4; f++) bombWords(ship.bomb, f).forEach((at, i) => {
      shipWords[at] = blastCells[f][i];
    });
  }
  const bulletArt = [];
  const usedLetters = /* @__PURE__ */ new Set();
  for (const st of stages) for (const row of st.enemylist) for (const c of row) if (c !== "00") usedLetters.add(c.slice(0, -1));
  for (const letter of usedLetters) {
    const rec = enemyData[`enemy${letter}`];
    const tex = rec && rec.projectileData && Array.isArray(rec.projectileData.texture) ? rec.projectileData.texture : [];
    const frames = tex.map(lookup).filter(Boolean);
    if (frames.length && !bulletArt.some((b) => b[0].key === frames[0].key)) bulletArt.push(frames);
  }
  const bossSplits = /* @__PURE__ */ new Map();
  for (let s = 0; s < stages.length; s++) {
    const b = bossData[`boss${s}`];
    if (!b) continue;
    for (const slot of ["bulletDataA", "projectileDataA", "bulletData", "projectileData", "bulletDataB", "projectileDataB", "bulletDataC", "projectileDataC"]) {
      const tex = b[slot] && Array.isArray(b[slot].texture) ? b[slot].texture : [];
      const frames = tex.map(lookup).filter(Boolean);
      if (frames.length && !bulletArt.some((x) => x[0].key === frames[0].key)) bulletArt.push(frames);
    }
    const split = splitBossStage2(b);
    if (!split) continue;
    bossSplits.set(s, split);
    for (const { weapon } of bossWeapons(split.second)) {
      const frames = weaponTextures(weapon).map(lookup).filter(Boolean);
      if (frames.length && !bulletArt.some((x) => x[0].key === frames[0].key)) bulletArt.push(frames);
    }
  }
  const bulletTints = [[255, 240, 120], [120, 200, 255], [255, 120, 200], [140, 255, 140], [255, 170, 60], [200, 200, 255], [255, 255, 255]];
  const bulletSlots = [];
  const quadOfArt = /* @__PURE__ */ new Map();
  for (let q = 0; q < KIDS_SHIP_LAYOUT.bullets.count; q++) {
    const frames = bulletArt.length ? bulletArt[q % bulletArt.length] : [shotSprite(16, 16, bulletTints[q])];
    if (bulletArt.length && !quadOfArt.has(frames[0].key)) quadOfArt.set(frames[0].key, q);
    const chosen = spreadFrames(frames, KIDS_SHIP_LAYOUT.bullets.frames);
    const out = chosen.map((f) => (bankFrame(fitIndexed2(f, 16, 16), 16, 16, "enemy bullet") || new Uint16Array([KIDS_BLANK]))[0]);
    shipWords.set(out, KIDS_SHIP_LAYOUT.bullets.at + q * KIDS_SHIP_LAYOUT.bullets.frames);
    bulletSlots.push(frames[0].key || "procedural");
  }
  blastCells.forEach((cells, f) => blastWords(f).forEach((at, i) => {
    shipWords[at] = cells[i];
  }));
  const itemSources = KIDS_ITEM_SLOTS.map((slot, i) => {
    let frame = null, source = null;
    for (const name2 of slot.frames) {
      const f = lookup(name2);
      if (f) {
        frame = f;
        source = f.key;
        break;
      }
    }
    if (!frame && slot.fallback === "ship" && centre) {
      frame = centre;
      source = "ship";
    }
    if (!frame && slot.fallback === "coin") {
      frame = coinSprite(11);
      source = "coin";
    }
    if (!frame && slot.fallback === "bigCoin") {
      frame = coinSprite(14);
      source = "coin";
    }
    if (!frame) {
      frame = itemIcon(slot.type);
      source = "square";
    }
    const w = bankFrame(fitIndexed2(frame, 16, 16), 16, 16, "items") || new Uint16Array([KIDS_BLANK]);
    shipWords[KIDS_SHIP_LAYOUT.items.at + i] = w[0];
    return source;
  });
  const built = stages.map((st, s) => {
    const width = Math.max(1, st.enemylist[0] ? st.enemylist[0].length : level.width || 8);
    const story = opts.storyPicks ? opts.storyPicks.get(s) || null : null;
    const storyShift = story ? KIDS_STORY_TOP_ROW + 1 + KIDS_STORY_LEAD_ROWS : 0;
    const spawnRows = st.enemylist.slice().reverse();
    const waveRows = Array.isArray(st.waveRows) && st.waveRows.length === st.enemylist.length ? st.waveRows.slice().reverse() : null;
    const appear = new Uint8Array(KIDS_APPEAR_STAGE_BYTES);
    const counts = KIDS_APPEAR_CLASSES.map(() => 0);
    const records = /* @__PURE__ */ new Map();
    const usage = /* @__PURE__ */ new Map();
    for (const row of spawnRows) {
      for (const cell of row) {
        if (!cell || cell === "00") continue;
        const letter = cell.slice(0, -1), digit = cell.slice(-1);
        if (!usage.has(letter)) usage.set(letter, { count: 0, digits: /* @__PURE__ */ new Map() });
        const u = usage.get(letter);
        u.count++;
        u.digits.set(digit, (u.digits.get(digit) || 0) + 1);
      }
    }
    const letters = [...usage.keys()].sort((a, b) => usage.get(b).count - usage.get(a).count);
    for (const letter of letters) {
      const rec = enemyData[`enemy${letter}`];
      if (!rec) {
        warn(`${st.key}: grid names enemy${letter} but enemyData has no such record \u2014 cells left empty`);
        continue;
      }
      const frames = (Array.isArray(rec.texture) ? rec.texture : []).map(lookup).filter(Boolean);
      if (!frames.length) warn(`${st.key}: enemy${letter} (${rec.name || "?"}) has no art in the atlas \u2014 placed invisible`);
      const maxW = frames.reduce((a, f) => Math.max(a, f.w), 16);
      const maxH = frames.reduce((a, f) => Math.max(a, f.h), 16);
      if (frames.length && (maxW > 64 || maxH > 64)) {
        warn(`${st.key}: enemy${letter} (${rec.name || "?"}) is ${maxW}x${maxH}; zako art tops out at 64x64 \u2014 downscaled`);
      }
      const artClass = kidsClassFor(maxW, maxH);
      const strips = /* @__PURE__ */ new Map();
      const stripFor = (klass) => {
        if (strips.has(klass)) return strips.get(klass);
        const strip = KIDS_SPRITE_STRIPS[klass];
        const bw = strip.w * CG_CELL, bh = strip.h * CG_CELL;
        const stripWords = new Uint16Array(KIDS_SPRITE_ENTRY_WORDS).fill(KIDS_BLANK);
        spreadFrames(frames, strip.frames).forEach((f, fi) => {
          const cells = bankFrame(fitIndexed2(f, bw, bh), bw, bh, `enemy${letter}`);
          if (!cells) return;
          for (let cy = 0; cy < strip.h; cy++) {
            for (let cx = 0; cx < strip.w; cx++) stripWords[cy * strip.stripW + fi * strip.w + cx] = cells[cy * strip.w + cx];
          }
        });
        strips.set(klass, stripWords);
        return stripWords;
      };
      const speed = (Number.isFinite(rec.speed) ? rec.speed : 1) * RUNTIME_TO_KIDS_SPEED;
      const hits = rec.hp === "infinity" ? Infinity : Math.max(1, Number(rec.hp) || 1);
      const interval = Number(rec.interval);
      const fires = Number.isFinite(interval) && interval > 0;
      const timing = !fires ? 0 : interval >= 90 ? 1 : interval >= 45 ? 2 : 3;
      const proj = rec.projectileData && Array.isArray(rec.projectileData.texture) ? rec.projectileData.texture[0] : null;
      const bulletKey = proj ? (lookup(proj) || {}).key : null;
      const digits = [...usage.get(letter).digits.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
      let first = null;
      for (const digit of digits) {
        const box = first ? KIDS_CLASS_BOXES[first.klass] : { w: maxW, h: maxH };
        const pick = pickEnemyClass(KIDS_CLASS_BOXES, counts, box.w, box.h);
        const klass = pick.klass >= 0 && !(first && pick.shrunk) ? pick.klass : KIDS_APPEAR_CLASSES.length;
        const item = KIDS_ITEM_FOR_DROP[digit] || 0;
        if (!first && pick.shrunk) {
          const want = KIDS_CLASS_BOXES[artClass], got = KIDS_CLASS_BOXES[klass];
          warn(`${st.key}: the stage's ${want.w}x${want.h} records are all taken \u2014 enemy${letter} (${rec.name || "?"}) drawn ${got.w}x${got.h}`);
        }
        if (klass >= KIDS_APPEAR_CLASSES.length) {
          if (first) {
            warn(`${st.key}: enemy${letter} carries several drop digits and the stage is out of records \u2014 its drop-${digit} cells drop ${first.item ? KIDS_ITEM_SLOTS[first.item - 1].name : "nothing"} instead`);
            records.set(letter + digit, first);
          } else {
            warn(`${st.key}: no free record for enemy${letter} (${rec.name || "?"}) \u2014 a stage holds 16 + 8 + 8 + 8 \u2014 cells left empty`);
          }
          continue;
        }
        const id = counts[klass]++;
        const hardness = hits === Infinity ? 3 : nearestIndex2(KIDS_HP_TABLES[klass].slice(0, 3), hits * KIDS_SHOT_UNITS);
        const scoreTier = nearestIndex2(KIDS_SCORE_TABLES[klass], Number(rec.score) || KIDS_SCORE_TABLES[klass][1]);
        const bytes = encodeKidsRecord({
          movement: KIDS_MOVE_STRAIGHT,
          variant: nearestIndex2(KIDS_STRAIGHT_SPEEDS, speed),
          hardness,
          scoreTier,
          bullet: bulletKey && quadOfArt.has(bulletKey) ? quadOfArt.get(bulletKey) : 0,
          timing,
          animIndex: Number.isFinite(rec.frameRate) && rec.frameRate > 0 ? nearestIndex2(KIDS_ANIM_INTERVALS, 60 / rec.frameRate) : 1,
          aim: fires,
          item
        });
        const entry = { klass, id, bytes, name: rec.name || `enemy${letter}`, letter, digit, strip: stripFor(klass), frames: frames.length, item };
        records.set(letter + digit, entry);
        if (!first) first = entry;
      }
    }
    const cellAt = (row, col) => row * KIDS_APPEAR_COLUMNS + col;
    const rectFree = (row, col, w, h) => {
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const r = row - dy, c = col + dx;
          if (r < 0 || r >= KIDS_APPEAR_ROWS || c < 0 || c >= KIDS_APPEAR_COLUMNS) return false;
          if (appear[cellAt(r, c)]) return false;
        }
      }
      return true;
    };
    const stamp = (row, col, w, h, byte) => {
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          appear[cellAt(row - dy, col + dx)] = dx === 0 && dy === 0 ? byte : KIDS_APPEAR_FOOTPRINT_CLASS << 4 | dx << 2 | dy;
        }
      }
    };
    let placed = 0, dropped = 0, lastRow = KIDS_FIRST_SPAWN_ROW + storyShift;
    spawnRows.forEach((row, k) => {
      const scrollRow = clamp2(
        (waveRows ? Math.round(waveRows[k] / 2) : KIDS_FIRST_SPAWN_ROW + k * KIDS_ROW_STEP) + storyShift,
        0,
        KIDS_MAX_SPAWN_ROW
      );
      row.forEach((cell, c) => {
        if (!cell || cell === "00") return;
        const rec = records.get(cell);
        if (!rec) return;
        const [w, h] = KIDS_APPEAR_CELLS[rec.klass];
        const col = mapKidsColumn(c, width, w);
        const r = Math.max(scrollRow, h - 1);
        let at = null;
        for (const dc of [0, 1, -1, 2, -2]) {
          const cc = col + dc;
          if (cc < KIDS_FIRST_VISIBLE_COLUMN || cc + w - 1 > KIDS_FIRST_VISIBLE_COLUMN + KIDS_VISIBLE_COLUMNS - 1) continue;
          if (rectFree(r, cc, w, h)) {
            at = cc;
            break;
          }
        }
        if (at === null) {
          dropped++;
          return;
        }
        stamp(r, at, w, h, KIDS_APPEAR_PRESENT | rec.klass << 4 | rec.id);
        placed++;
        lastRow = Math.max(lastRow, r);
      });
    });
    if (dropped) warn(`${st.key}: ${dropped} placement${dropped === 1 ? "" : "s"} overlapped another enemy's cells and ${dropped === 1 ? "was" : "were"} left out`);
    let boss = null;
    const bossWords = [new Uint16Array(KIDS_SPRITE_BOSS_WORDS).fill(KIDS_BLANK), new Uint16Array(KIDS_SPRITE_BOSS_WORDS).fill(KIDS_BLANK)];
    const bossRecords = [Uint8Array.from(KIDS_BOSS_DEFAULT), Uint8Array.from(KIDS_BOSS_DEFAULT)];
    const split = bossSplits.get(s) || null;
    const bossRec = split ? split.first : bossData[`boss${s}`];
    if (bossRec && split) {
      const phases = [split.first, split.second].map((rec, phase) => {
        const frames = bossBodyFrames(rec).map(lookup).filter(Boolean);
        const label = phase ? `${rec.name || "?"} stage 2` : rec.name || "?";
        const maxW = frames.reduce((a, f) => Math.max(a, f.w), 64);
        const maxH = frames.reduce((a, f) => Math.max(a, f.h), 64);
        const sizeClass2 = kidsBossClassFor(maxW, maxH);
        const [aw, ah] = KIDS_BOSS_ART_CELLS[sizeClass2];
        if (frames.length && (maxW > aw * CG_CELL || maxH > ah * CG_CELL)) {
          warn(`${st.key}: boss (${label}) is ${maxW}x${maxH}; its art is ${aw * CG_CELL}x${ah * CG_CELL} \u2014 downscaled`);
        }
        if (!frames.length) warn(`${st.key}: boss (${label}) has no art in the atlas \u2014 its sprite is unpainted`);
        if (frames.length) {
          const cells = bankFrame(fitIndexed2(frames[0], aw * CG_CELL, ah * CG_CELL), aw * CG_CELL, ah * CG_CELL, `boss${s}`);
          if (cells) for (let cy = 0; cy < ah; cy++) for (let cx = 0; cx < aw; cx++) bossWords[phase][cy * KIDS_BOSS_GRID + cx] = cells[cy * aw + cx];
        }
        const hits = rec.hp === "infinity" ? Infinity : Math.max(1, Number(rec.hp) || 50);
        const hpClass = hits === Infinity ? 3 : nearestIndex2(KIDS_BOSS_HP, hits * KIDS_SHOT_UNITS);
        const scoreClass = nearestIndex2(KIDS_BOSS_SCORE, Number(rec.score) || KIDS_BOSS_SCORE[1]);
        const behaviour = KIDS_BOSS_BEHAVIOUR[sizeClass2];
        const weapons = kidsBossWeapons(behaviour.weapons, rec, (n) => {
          const f = lookup(n);
          return f && quadOfArt.has(f.key) ? quadOfArt.get(f.key) : null;
        });
        bossRecords[phase] = encodeKidsBoss({ ...behaviour, weapons, sizeClass: sizeClass2, hpClass, scoreClass });
        return { sizeClass: sizeClass2, frames: frames.length, hits, hpClass, bullets: weapons.map((w) => w.bullet) };
      });
      const sizeClass = Math.max(phases[0].sizeClass, phases[1].sizeClass);
      const [fw, fh] = KIDS_BOSS_FOOTPRINT[sizeClass];
      let row = Math.min(KIDS_APPEAR_ROWS - 1, Math.max(lastRow + KIDS_BOSS_ROW_GAP, fh - 1));
      const col = KIDS_BOSS_COLUMN[sizeClass];
      while (row < KIDS_APPEAR_ROWS && !rectFree(row, col, fw, fh)) row++;
      if (row >= KIDS_APPEAR_ROWS) {
        warn(`${st.key}: no room left for the boss past the last wave \u2014 it is left out`);
      } else {
        stamp(row, col, fw, fh, KIDS_APPEAR_PRESENT | KIDS_APPEAR_BOSS_CLASS << 4);
        const [p1, p2] = phases;
        boss = {
          name: bossRec.name || `boss${s}`,
          sizeClass: p1.sizeClass,
          row,
          col,
          frames: p1.frames,
          hits: p1.hits,
          hpClass: p1.hpClass,
          bullets: p1.bullets,
          stage2: { sizeClass: p2.sizeClass, frames: p2.frames, hits: p2.hits, hpClass: p2.hpClass, bullets: p2.bullets, hpBelow: split.hpBelow }
        };
        lastRow = Math.max(lastRow, row);
      }
    } else if (bossRec) {
      const names = bossRec.anim && Array.isArray(bossRec.anim.idle) ? [...bossRec.anim.idle, ...Array.isArray(bossRec.anim.attack) ? bossRec.anim.attack : []] : Array.isArray(bossRec.texture) ? bossRec.texture : [];
      const frames = names.map(lookup).filter(Boolean);
      const maxW = frames.reduce((a, f) => Math.max(a, f.w), 64);
      const maxH = frames.reduce((a, f) => Math.max(a, f.h), 64);
      const sizeClass = kidsBossClassFor(maxW, maxH);
      const [aw, ah] = KIDS_BOSS_ART_CELLS[sizeClass];
      if (frames.length && (maxW > aw * CG_CELL || maxH > ah * CG_CELL)) {
        warn(`${st.key}: boss (${bossRec.name || "?"}) is ${maxW}x${maxH}; its art is ${aw * CG_CELL}x${ah * CG_CELL} \u2014 downscaled`);
      }
      if (!frames.length) warn(`${st.key}: boss (${bossRec.name || "?"}) has no art in the atlas \u2014 its sprite is unpainted`);
      const phaseFrames = frames.length ? [frames[0], frames[1] || frames[0]] : [];
      phaseFrames.forEach((f, phase) => {
        const cells = bankFrame(fitIndexed2(f, aw * CG_CELL, ah * CG_CELL), aw * CG_CELL, ah * CG_CELL, `boss${s}`);
        if (!cells) return;
        for (let cy = 0; cy < ah; cy++) for (let cx = 0; cx < aw; cx++) bossWords[phase][cy * KIDS_BOSS_GRID + cx] = cells[cy * aw + cx];
      });
      const hits = bossRec.hp === "infinity" ? Infinity : Math.max(1, Number(bossRec.hp) || 100);
      const hpClass = hits === Infinity ? 3 : nearestIndex2(KIDS_BOSS_HP, hits / 2 * KIDS_SHOT_UNITS);
      const scoreClass = nearestIndex2(KIDS_BOSS_SCORE, Number(bossRec.score) || KIDS_BOSS_SCORE[1]);
      const behaviour = KIDS_BOSS_BEHAVIOUR[sizeClass];
      for (let phase = 0; phase < 2; phase++) {
        bossRecords[phase] = encodeKidsBoss({ ...behaviour, sizeClass, hpClass, scoreClass });
      }
      const [fw, fh] = KIDS_BOSS_FOOTPRINT[sizeClass];
      let row = Math.min(KIDS_APPEAR_ROWS - 1, Math.max(lastRow + KIDS_BOSS_ROW_GAP, fh - 1));
      const col = KIDS_BOSS_COLUMN[sizeClass];
      while (row < KIDS_APPEAR_ROWS && !rectFree(row, col, fw, fh)) row++;
      if (row >= KIDS_APPEAR_ROWS) {
        warn(`${st.key}: no room left for the boss past the last wave \u2014 it is left out`);
      } else {
        stamp(row, col, fw, fh, KIDS_APPEAR_PRESENT | KIDS_APPEAR_BOSS_CLASS << 4);
        boss = { name: bossRec.name || `boss${s}`, sizeClass, row, col, frames: frames.length, hits, hpClass };
        lastRow = Math.max(lastRow, row);
      }
    }
    let chips = 0;
    const mapWords = new Uint16Array(KIDS_MAP_COLUMNS * KIDS_MAP_ROWS).fill(KIDS_MAP_FILL);
    const cellsList = Array.isArray(level.backgroundCells) ? level.backgroundCells : null;
    if (st.background && st.background.tiles && cellsList) {
      try {
        const bytes = b64ToBytes2(st.background.tiles);
        const cols = st.background.cols || 14;
        const tiles = new Uint16Array(bytes.length >> 1);
        for (let i = 0; i < tiles.length; i++) tiles[i] = bytes[i * 2] << 8 | bytes[i * 2 + 1];
        const rows = Math.floor(tiles.length / cols);
        const cellRgba = /* @__PURE__ */ new Map();
        const cellOf = (ordinal) => {
          if (!cellRgba.has(ordinal)) {
            const f = lookup(cellsList[ordinal]);
            cellRgba.set(ordinal, f ? fitRgba(f, CG_CELL, CG_CELL) : null);
          }
          return cellRgba.get(ordinal);
        };
        const chipRgba = new Uint8Array(32 * 32 * 4);
        const firstCol = Math.max(0, Math.floor((cols - KIDS_MAP_COLUMNS * 2) / 2));
        let chipsFull = false;
        for (let cr = 0; cr < Math.min(KIDS_MAP_ROWS, Math.ceil(rows / 2)) && !chipsFull; cr++) {
          for (let cc = 0; cc < KIDS_MAP_COLUMNS; cc++) {
            chipRgba.fill(0);
            let any = false;
            for (let dy = 0; dy < 2; dy++) {
              for (let dx = 0; dx < 2; dx++) {
                const r = cr * 2 + 1 - dy, c = firstCol + cc * 2 + dx;
                if (r >= rows || c >= cols) continue;
                const w = tiles[r * cols + c];
                if (w === 65535) continue;
                const f = cellOf(w & 1023);
                if (!f) continue;
                const hf = (w & 32768) !== 0, vf = (w & 16384) !== 0;
                for (let y = 0; y < CG_CELL; y++) {
                  for (let x = 0; x < CG_CELL; x++) {
                    const sx = hf ? CG_CELL - 1 - x : x, sy = vf ? CG_CELL - 1 - y : y;
                    const si = (sy * CG_CELL + sx) * 4, di = ((dy * CG_CELL + y) * 32 + dx * CG_CELL + x) * 4;
                    chipRgba[di] = f.rgba[si];
                    chipRgba[di + 1] = f.rgba[si + 1];
                    chipRgba[di + 2] = f.rgba[si + 2];
                    chipRgba[di + 3] = f.rgba[si + 3];
                    any = true;
                  }
                }
              }
            }
            if (!any) continue;
            try {
              const word = bank.addChip(quantizeKidsFrame({ w: 32, h: 32, rgba: chipRgba }));
              mapWords[cr * KIDS_MAP_COLUMNS + cc] = word;
              if (word !== KIDS_MAP_FILL) chips++;
            } catch (e) {
              if (!(e instanceof KidsBankFullError)) throw e;
              warn(`${st.key}: CG pages full (${KIDS_CELL_COUNT} cells) \u2014 scenery past chip row ${cr} left unpainted`);
              chipsFull = true;
              break;
            }
          }
        }
      } catch (e) {
        warn(`${st.key}: could not read the background grid (${e.message}) \u2014 scenery skipped`);
      }
    }
    let storyReport = null;
    if (story && !chips) {
      const before = bank.used;
      const chipRgba = new Uint8Array(32 * 32 * 4);
      try {
        for (let cy = 0; cy < story.chipRows; cy++) {
          for (let cc = 0; cc < KIDS_MAP_COLUMNS; cc++) {
            chipRgba.fill(0);
            for (let y = 0; y < 32; y++) {
              const sy = cy * 32 + y;
              if (sy >= story.h) break;
              chipRgba.set(story.rgba.subarray((sy * story.w + cc * 32) * 4, (sy * story.w + cc * 32 + 32) * 4), y * 32 * 4);
            }
            const word = bank.addChip(quantizeKidsFrame({ w: 32, h: 32, rgba: chipRgba }));
            mapWords[(KIDS_STORY_TOP_ROW - cy) * KIDS_MAP_COLUMNS + cc] = word;
          }
        }
        storyReport = { size: story.label, rows: story.chipRows, cells: bank.used - before, top: KIDS_STORY_TOP_ROW };
      } catch (e) {
        if (!(e instanceof KidsBankFullError)) throw e;
        warn(`${st.key}: CG pages full (${KIDS_CELL_COUNT} cells) \u2014 its story left unfinished`);
      }
    }
    const scroll = new Uint8Array(KIDS_SCROLL_STAGE_BYTES);
    const haltRow = boss ? boss.row : Math.min(KIDS_APPEAR_ROWS - 1, lastRow + KIDS_BOSS_ROW_GAP);
    const haltUnit = Math.floor(haltRow * 32 / KIDS_SCROLL_UNIT_PIXELS);
    for (let u = 0; u < KIDS_SCROLL_UNITS; u++) {
      const nibble = storyReport && u < KIDS_STORY_SLOW_UNITS ? KIDS_STORY_SCROLL : u < haltUnit ? KIDS_SCROLL_RUN : KIDS_SCROLL_HALT;
      if (u & 1) scroll[u >> 1] |= nibble << 4;
      else scroll[u >> 1] |= nibble;
    }
    return { key: st.key, appear, records, bossWords, bossRecords, boss, mapWords, chips, scroll, placed, dropped, lastRow, story: storyReport };
  });
  let title = "none";
  for (const [art3, t] of [[opts.title1, KIDS_SHIP_LAYOUT.title1], [opts.title2, KIDS_SHIP_LAYOUT.title2]]) {
    if (!art3 || !art3.rgba) continue;
    const w = bankFrame(fitIndexed2(art3, t.w * CG_CELL, t.h * CG_CELL), t.w * CG_CELL, t.h * CG_CELL, "title");
    if (w) {
      shipWords.set(w, t.at);
      title = "uploaded";
    }
  }
  const stageCount = built.length;
  built.forEach((b, s) => {
    putWords(KIDS_REGION.map.offset + s * KIDS_MAP_STAGE_BYTES, b.mapWords);
    data.set(b.scroll, KIDS_REGION.scroll.offset + s * KIDS_SCROLL_STAGE_BYTES);
    data.set(b.appear, KIDS_REGION.appear.offset + s * KIDS_APPEAR_STAGE_BYTES);
    const recBase = KIDS_REGION.records.offset + s * KIDS_RECORDS_STAGE_BYTES;
    for (const r of new Set(b.records.values())) data.set(r.bytes, recBase + (KIDS_CLASS_BASE[r.klass] + r.id) * KIDS_RECORD_SIZE);
    b.bossRecords.forEach((rec, i) => data.set(rec, recBase + KIDS_BOSS_OFFSET + i * KIDS_BOSS_SIZE));
    const sprBase = KIDS_REGION.sprites.offset + s * KIDS_SPRITE_STAGE_BYTES;
    for (let i = 0; i < KIDS_SPRITE_STAGE_BYTES; i += 2) putU16le3(data, sprBase + i, KIDS_BLANK);
    for (const r of new Set(b.records.values())) {
      putWords(sprBase + KIDS_SPRITE_CLASS_OFFSETS[r.klass] + r.id * KIDS_SPRITE_ENTRY_WORDS * 2, r.strip);
    }
    b.bossWords.forEach((w, i) => putWords(sprBase + KIDS_SPRITE_BOSS_OFFSETS[i], w));
  });
  for (let s = stageCount; s < KIDS_STAGES; s++) {
    const sprBase = KIDS_REGION.sprites.offset + s * KIDS_SPRITE_STAGE_BYTES;
    for (let i = 0; i < KIDS_SPRITE_STAGE_BYTES; i += 2) putU16le3(data, sprBase + i, KIDS_BLANK);
    const recBase = KIDS_REGION.records.offset + s * KIDS_RECORDS_STAGE_BYTES;
    for (let i = 0; i < 2; i++) data.set(KIDS_BOSS_DEFAULT, recBase + KIDS_BOSS_OFFSET + i * KIDS_BOSS_SIZE);
    data.fill(KIDS_SCROLL_RUN | KIDS_SCROLL_RUN << 4, KIDS_REGION.scroll.offset + s * KIDS_SCROLL_STAGE_BYTES, KIDS_REGION.scroll.offset + (s + 1) * KIDS_SCROLL_STAGE_BYTES);
  }
  putWords(KIDS_REGION.ship.offset, shipWords);
  const config = Uint8Array.from(KIDS_CONFIG_TEMPLATE);
  config[0] = 0;
  const backgroundSet = Number.isInteger(opts.backgroundSet) ? clamp2(opts.backgroundSet, 0, KIDS_BACKGROUND_SETS) : 0;
  for (let s = 0; s < KIDS_STAGES; s++) {
    config[3 + s] = s === stageCount - 1 ? KIDS_CONFIG_LAST_STAGE : 0;
    config[KIDS_CONFIG_MOTION_OFFSET + s] = s < stageCount ? KIDS_MOTION_DEFAULT | (backgroundSet ? KIDS_MOTION_BACKGROUND : 0) : 0;
    config[KIDS_CONFIG_BACKGROUND_OFFSET + s] = s < stageCount ? backgroundSet : 0;
  }
  const templateStagePairs = 6;
  for (let s = 0; s < KIDS_STAGES; s++) {
    for (let k = 0; k < 2; k++) {
      const at = KIDS_CONFIG_SOUND_OFFSET + (4 + s * 2 + k) * 4;
      if (s < stageCount) {
        const from = KIDS_CONFIG_SOUND_OFFSET + (4 + s % templateStagePairs * 2 + k) * 4;
        config.set(KIDS_CONFIG_TEMPLATE.slice(from, from + 4), at);
      } else config.fill(0, at, at + 4);
    }
  }
  config[111] = 0;
  data.set(config, KIDS_REGION.config.offset);
  const tail = factoryKidsTail();
  const name = kidsGameNameFor(opts.name ?? level.name);
  if (name.changed) warn(`the game is named "${name.text}" on the card: the title field holds ten ASCII characters`);
  const icon = encodeKidsIcon(centre || defaultKidsIcon());
  return {
    graphics: bank.graphics,
    data,
    tail,
    name,
    icon,
    warnings,
    report: {
      name: name.text,
      stages: built.map((b) => ({
        key: b.key,
        placements: b.placed,
        dropped: b.dropped,
        records: [...new Set(b.records.values())].map((r) => ({ name: r.name, cell: r.letter + r.digit, klass: r.klass, id: r.id, frames: r.frames, ...r.item ? { item: KIDS_ITEM_SLOTS[r.item - 1].name } : {} })),
        boss: b.boss ? {
          name: b.boss.name,
          sizeClass: b.boss.sizeClass,
          row: b.boss.row,
          col: b.boss.col,
          frames: b.boss.frames,
          hpClass: b.boss.hpClass,
          // A second stage: record 1, its class and bullets.
          ...b.boss.stage2 ? { bullets: b.boss.bullets, stage2: b.boss.stage2 } : {}
        } : null,
        chips: b.chips,
        lastRow: b.lastRow,
        story: b.story
      })),
      ship: shipSource,
      items: itemSources,
      bullets: bulletSlots,
      // The format's own two boss phases carry a stage2 block (boss-stage2.js).
      transform: built.some((b) => b.boss && b.boss.stage2) ? "native" : "none",
      title,
      backgroundSet,
      cells: { used: bank.used, chips: bank.chips, sprites: bank.sprites, shared: bank.shared, free: bank.free }
    }
  };
}
function buildKidsWithStory(level, art2, opts) {
  const dry = buildKidsGameFromLevel(level, art2, { ...opts, storyBackdrops: null, storyPicks: null });
  const notes = [];
  const w = KIDS_MAP_COLUMNS * 32;
  const candidates = [];
  for (const sb of opts.storyBackdrops) {
    const s = dry.report.stages.findIndex((st) => st.key === `stage${sb && sb.stage}`);
    if (s < 0) continue;
    const key = dry.report.stages[s].key;
    if (dry.report.stages[s].chips > 0) {
      notes.push(`${key}: keeps its own scenery \u2014 its story is not drawn`);
      continue;
    }
    const variants = [];
    for (const v of Array.isArray(sb.variants) ? sb.variants : []) {
      if (!v || v.w !== w || !v.h || !v.rgba) continue;
      const chipRows = Math.ceil(v.h / 32);
      if (chipRows > KIDS_STORY_ROWS) continue;
      const probe = new KidsCellBank();
      const chipRgba = new Uint8Array(32 * 32 * 4);
      try {
        for (let cy = 0; cy < chipRows; cy++) {
          for (let cc = 0; cc < KIDS_MAP_COLUMNS; cc++) {
            chipRgba.fill(0);
            for (let y = 0; y < 32 && cy * 32 + y < v.h; y++) {
              const sy = cy * 32 + y;
              chipRgba.set(v.rgba.subarray((sy * w + cc * 32) * 4, (sy * w + cc * 32 + 32) * 4), y * 128);
            }
            probe.addChip(quantizeKidsFrame({ w: 32, h: 32, rgba: chipRgba }));
          }
        }
      } catch (e) {
        if (!(e instanceof KidsBankFullError)) throw e;
        continue;
      }
      variants.push({ pick: { ...v, chipRows }, cells: probe.used });
    }
    if (variants.length) candidates.push({ s, key, variants });
  }
  const free = dry.report.cells.free;
  const cost = (picks2) => picks2.reduce((n, p) => n + p.v.cells, 0);
  const pickAt = (k) => candidates.map((c) => ({ c, v: c.variants[Math.min(k, c.variants.length - 1)] }));
  const sizes = Math.max(0, ...candidates.map((c) => c.variants.length));
  const start = Math.max(0, opts.storyMinSize || 0);
  let picks = [];
  if (start >= sizes) {
    if (candidates.length) notes.push(`the story packs past what a Kids! save holds at every size \u2014 not drawn`);
  } else {
    for (let k = start; k < sizes && !picks.length; k++) {
      if (cost(pickAt(k)) <= free) picks = pickAt(k);
    }
    if (!picks.length && candidates.length) {
      for (const p of pickAt(sizes - 1)) {
        if (cost([...picks, p]) <= free) picks.push(p);
        else notes.push(`${p.c.key}: no cells left in the save's graphics for its story \u2014 not drawn`);
      }
    }
  }
  const built = buildKidsGameFromLevel(level, art2, {
    ...opts,
    storyBackdrops: null,
    storyPicks: new Map(picks.map(({ c, v }) => [c.s, v.pick]))
  });
  built.warnings.push(...notes);
  return built;
}
function kidsCardFileName(name) {
  const clean = String(name || "game").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "game";
  return `Dezaemon Kids - ${clean}.mcr`;
}
function exportLevelToKidsCard(level, art2, options = {}) {
  let game, packed;
  const first = options.storyMinSize || 0;
  let size = first;
  for (; ; size++) {
    game = buildKidsGameFromLevel(level, art2, { ...options, storyMinSize: size });
    try {
      packed = buildKidsBlock({
        graphics: game.graphics,
        data: game.data,
        tail: game.tail,
        name: game.name.bytes,
        icon: game.icon
      });
      break;
    } catch (e) {
      const story = game.report.stages.some((st) => st.story);
      if (!story || !/does not fit a memory-card file/.test(String(e && e.message))) throw e;
    }
  }
  if (size > first) game.warnings.push("the story was drawn smaller so the save fits its fifteen blocks");
  const { block, seal: seal2, sizes } = packed;
  const card = buildMemoryCard([{ filename: KIDS_PRODUCT, data: block }]);
  return {
    card,
    block,
    fileName: kidsCardFileName(game.name.text),
    name: game.name.text,
    warnings: game.warnings,
    report: { ...game.report, sizes, slack: seal2.slack, end: seal2.end }
  };
}

// packages/shmup-engine/src/psx/plus.js
var PLUS_PRODUCT = "BISLPS-00335DEZA";
var PLUS_TITLE_PREFIX = "\u30C7\u30B6\u30A8\u30E2\u30F3\uFF0B";
var PLUS_BLOCK_SIZE = 122880;
var PLUS_GRAPHICS_OFFSET = 256;
var PLUS_GRAPHICS_SIZE = 65536;
var PLUS_GRAPHICS_WIDTH = 256;
var PLUS_GRAPHICS_HEIGHT = 512;
var PLUS_GRAPHICS_PAGES = 2;
var PLUS_PAGE_HEIGHT = 256;
var PLUS_PALETTE_OFFSET = 65792;
var PLUS_PALETTE_ROWS = 24;
var PLUS_PALETTE_ROW_BYTES = 32;
var PLUS_STAGES_OFFSET = 66560;
var PLUS_STAGE_SIZE = 8764;
var PLUS_STAGES = 5;
var PLUS_GLOBAL_OFFSET = 110380;
var PLUS_SOUND_OFFSET = 110736;
var PLUS_SOUND_SIZE = 11776;
var PLUS_SONG_SIZE = 736;
var PLUS_SONG_COUNT = PLUS_SOUND_SIZE / PLUS_SONG_SIZE;
var PLUS_HISCORE_OFFSET = 122512;
var PLUS_HISCORE_TABLE_BYTES = 160;
var PLUS_HISCORE_TABLES = 2;
var PLUS_HISCORE_COUNT = 10;
var PLUS_HISCORE_SIZE = 16;
var PLUS_SETTINGS_OFFSET = 122832;
var PLUS_SETTINGS_SIZE = 8;
var PLUS_CHECKSUM_OFFSET = 122840;
var PLUS_CHECKSUM_COUNT = 20;
var PLUS_CHECKSUM_SIZE = PLUS_CHECKSUM_COUNT * 2;
var PLUS_CHECKED_GROUPS = 19;
var PLUS_MAP_ROW_BYTES = 18;
var PLUS_MAP_ROWS = 128;
var PLUS_MAP_COLUMNS = 16;
var PLUS_CHIP_DIM = 16;
var PLUS_MAP_HALVES = Object.freeze([
  { chips: [0, 1, 2, 3, 4, 5, 6, 7], flags: 8 },
  { chips: [9, 10, 11, 12, 13, 14, 15, 16], flags: 17 }
]);
var PLUS_APPEAR_RECORDS = 256;
var PLUS_APPEAR_RECORD_SIZE = 14;
var PLUS_APPEAR_ROW_TABLE = 1024;
var PLUS_APPEAR_END_MARK = 255;
var PLUS_ENEMY_SIZE = 8;
var PLUS_BOSS_OFFSET = 480;
var PLUS_BOSS_SIZE = 32;
var PLUS_APPEAR_CLASSES = Object.freeze([
  { nibble: 8, size: "16x16", base: 0, mask: 15 },
  { nibble: 9, size: "32x16", base: 16, mask: 15 },
  { nibble: 10, size: "16x32", base: 32, mask: 15 },
  { nibble: 11, size: "32x32", base: 48, mask: 7 },
  { nibble: 12, size: "64x64", base: 56, mask: 3 }
]);
var PLUS_APPEAR_BOSS_NIBBLE = 13;
var PLUS_ITEM_EFFECTS = Object.freeze([
  null,
  "weapon 0",
  "weapon 1",
  "weapon 2",
  "weapon 3",
  "weapon 4",
  "weapon 5",
  "bomb",
  "score",
  "power up",
  "speed up",
  "option"
]);
var PLUS_SCORE_BONUS = Object.freeze([5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6]);
var PLUS_BGM_SLOTS = Object.freeze([
  "stage 0",
  "stage 1",
  "stage 2",
  "stage 3",
  "stage 4",
  "stage 5",
  "boss 0",
  "boss 1",
  "boss 2",
  "boss 3",
  "boss 4",
  "boss 5",
  "title",
  "game over",
  "ending",
  "preloaded"
]);
var PLUS_BUTTONS = Object.freeze(["circle", "cross", "triangle", "square", "L1", "L2", "R1", "R2"]);
var PLUS_ENEMY_HP = Object.freeze([1, 50, 100, 200, 400, 800, 1e3, 2e3]);
var PLUS_ENEMY_SCORE = Object.freeze([50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4]);
var PLUS_SCALE_RATES = Object.freeze([32, 64, 128, 256, 384, 512, 640, 768]);
var PLUS_SCALES = Object.freeze([0, 6, 8, 16, 24, 32, 48, 64]);
var PLUS_TURN_RATES = Object.freeze([16, 32, 64, 128, 256, 384, 512, 2048]);
var PLUS_START_ANGLES = Object.freeze([0, 224, 192, 160, 128, 96, 64, 32]);
var PLUS_ANIM_INTERVALS = Object.freeze([59, 29, 14, 9, 5, 2, 1, 0]);
function region2(name, label, offset, end, confidence, note) {
  return Object.freeze({ name, label, offset, end, length: end - offset, confidence, note });
}
function tableEntry(index, offset, length, ram, flag, kind, group, sub) {
  return Object.freeze({ index, offset, length, ram, flag, kind, group, sub });
}
var STAGE_PIECES = [
  ["map", "MAP", 2304, 2148818056],
  ["scroll", "SCROLL", 512, 2148831880],
  ["mapGroup", "MAP GROUP", 256, 2149106352],
  ["enemyGroup", "ENEMY GROUP", 128, 2148668128],
  ["enemyData", "ENEMY DATA", 512, 2148621136],
  ["spriteLayout", "SPRITE LAYOUT", 320, 2149111400],
  ["appear", "APPEAR", 4608, 2148638800],
  ["config", "STAGE CONFIG", 60, 2148667072],
  ["bossGroup", "BOSS GROUP", 64, 2148636712]
];
var GLOBAL_PIECES = [
  ["titleType", "TITLE TYPE", 2, 2148608560],
  ["titleGroup", "TITLE GROUP", 64, 2148668896],
  ["endingGroup", "ENDING GROUP", 24, 2148835560],
  ["shipGroup", "MY SHIP GROUP", 154, 2149108200],
  ["shipOdr", "MY SHIP ODR", 77, 2148667840],
  ["itemTable", "ITEM TABLE", 16, 2148837184],
  ["gameSettings", "GAME SETTINGS", 3, 2148608594],
  ["bgmAssignment", "BGM ASSIGNMENT", 16, 2149108760]
];
var HEADER_PIECES = [
  [4, 2148608140],
  [64, 2147852932],
  [28, 2147852996],
  [32, 2147853024],
  [128, 2147853056]
];
var SETTINGS_PIECES = [[1, 2148608604], [1, 2148608605], [2, 2148608684], [4, 2148608548]];
function buildTable() {
  const rows = [];
  let offset = 0;
  const push = (length, ram, flag, kind, group, sub = "") => {
    rows.push(tableEntry(rows.length, offset, length, ram, flag, kind, group, sub));
    offset += length;
  };
  for (const [length, ram] of HEADER_PIECES) push(length, ram, 0, 0, "header");
  for (let q = 0; q < 4; q++) push(16384, 2147922472 + q * 16384, 1 + q, 1, "graphics", `quarter ${q}`);
  push(768, 2148837304, 5, 1, "palettes");
  for (let s = 0; s < PLUS_STAGES; s++) {
    for (const [name, label, length, ram] of STAGE_PIECES) {
      push(length, ram + s * length, 6 + s, 2, `stage ${s}`, `${label} (${name})`);
    }
  }
  for (const [name, label, length, ram] of GLOBAL_PIECES) push(length, ram, 11, 2, "global", `${label} (${name})`);
  for (let q = 0; q < 4; q++) push(2944, 2148624776 + q * 2944, 12 + q, 3, "sound", `quarter ${q}`);
  push(PLUS_HISCORE_TABLE_BYTES, 2148835400, 16, 4, "hiScores", "table A");
  push(PLUS_HISCORE_TABLE_BYTES, 2148636552, 17, 4, "hiScores", "table B");
  for (const [length, ram] of SETTINGS_PIECES) push(length, ram, 18, 4, "settings");
  push(PLUS_CHECKSUM_SIZE, 2148609008, 19, 5, "checksums");
  return Object.freeze(rows);
}
var PLUS_TABLE = buildTable();
function plusChecksums(block) {
  if (block.length < PLUS_BLOCK_SIZE) {
    throw new Error(`a checksum needs the whole ${PLUS_BLOCK_SIZE}-byte block; got ${block.length}`);
  }
  const cs = new Uint16Array(PLUS_CHECKSUM_COUNT + 1);
  let entry = 0;
  let within = 0;
  for (let pos = 0; pos < PLUS_BLOCK_SIZE; pos++) {
    const row = PLUS_TABLE[entry];
    if (!row) break;
    if ((pos & 127) === 0) cs[row.flag] += entry;
    cs[row.flag] += block[pos] * (within & 31) + entry;
    within++;
    if (within >= row.length) {
      const next = PLUS_TABLE[entry + 1];
      if (next && next.flag !== row.flag && row.kind !== 5) cs[row.flag + 1] = 0;
      entry++;
      within = 0;
    }
  }
  const computed = Array.from(cs.subarray(0, PLUS_CHECKSUM_COUNT));
  const stored = [];
  for (let i = 0; i < PLUS_CHECKSUM_COUNT; i++) stored.push(u16le(block, PLUS_CHECKSUM_OFFSET + i * 2));
  const bad = [];
  for (let i = 0; i < PLUS_CHECKED_GROUPS; i++) if (computed[i] !== stored[i]) bad.push(i);
  return { computed, stored, bad, ok: bad.length === 0, checkedGroups: PLUS_CHECKED_GROUPS };
}
var PLUS_REGIONS = Object.freeze([
  region2(
    "header",
    "SC HEADER",
    0,
    PLUS_GRAPHICS_OFFSET,
    "confirmed",
    "Title frame and one icon frame, built from five pieces of the program's own template; the title text is fixed."
  ),
  region2(
    "graphics",
    "GRAPHICS",
    PLUS_GRAPHICS_OFFSET,
    PLUS_GRAPHICS_OFFSET + PLUS_GRAPHICS_SIZE,
    "confirmed",
    "Two 256x256 4bpp PlayStation texture pages, a 128-byte row pitch, low nibble = left pixel. The four 0x4000 quarters are checksum groups, not picture boundaries."
  ),
  region2(
    "palettes",
    "PALETTES",
    PLUS_PALETTE_OFFSET,
    PLUS_STAGES_OFFSET,
    "confirmed",
    "24 rows x 16 RGB555 words, little-endian, bit 15 = STP, colour 0 transparent. LoadImage'd to VRAM (0, 480+row); the map draws with row = stage."
  ),
  region2(
    "stages",
    "STAGES",
    PLUS_STAGES_OFFSET,
    PLUS_GLOBAL_OFFSET,
    "confirmed",
    "5 x 0x223C, each nine pieces (PLUS_STAGE_LAYOUT). The stride is exact: the checksum reproduces every community save under it and none under 0x2240."
  ),
  region2(
    "global",
    "GLOBAL",
    PLUS_GLOBAL_OFFSET,
    PLUS_SOUND_OFFSET,
    "confirmed",
    "0x164 of game-wide tables: title type and group, ending, the ship's group and ODR, the stage list, game config and the BGM patch list."
  ),
  region2(
    "sound",
    "SOUND",
    PLUS_SOUND_OFFSET,
    PLUS_HISCORE_OFFSET,
    "confirmed",
    "16 songs of 0x2E0 bytes, bit-packed: 16 bars of a 14-bit header and 32 steps of 11 bits, then a 16-bit tail."
  ),
  region2(
    "hiScores",
    "HIGH SCORE",
    PLUS_HISCORE_OFFSET,
    PLUS_SETTINGS_OFFSET,
    "confirmed",
    "Two tables of ten 16-byte entries: u32le score, four bytes, an 8-character name. The factory ladder is 1000..100 in both."
  ),
  region2(
    "settings",
    "SETTINGS",
    PLUS_SETTINGS_OFFSET,
    PLUS_CHECKSUM_OFFSET,
    "likely",
    "Eight bytes from four separate variables (u8, u8, u16, u32); which option each is has not been traced."
  ),
  region2(
    "checksums",
    "CHECKSUMS",
    PLUS_CHECKSUM_OFFSET,
    PLUS_BLOCK_SIZE,
    "confirmed",
    "Twenty u16 checksums, one per flag group; the game verifies groups 0x00..0x12 on load."
  )
]);
var PLUS_REGION = Object.freeze(Object.fromEntries(PLUS_REGIONS.map((r) => [r.name, r])));
var PLUS_STAGE_LAYOUT = Object.freeze((() => {
  const out = [];
  let at = 0;
  for (const [name, label, length] of STAGE_PIECES) {
    out.push(Object.freeze({ name, label, offset: at, end: at + length, length }));
    at += length;
  }
  return out;
})());
var PLUS_STAGE_PIECE = Object.freeze(Object.fromEntries(PLUS_STAGE_LAYOUT.map((p) => [p.name, p])));
var PLUS_GLOBAL_LAYOUT = Object.freeze((() => {
  const out = [];
  let at = 0;
  for (const [name, label, length] of GLOBAL_PIECES) {
    out.push(Object.freeze({ name, label, offset: at, end: at + length, length }));
    at += length;
  }
  return out;
})());
function decodePlusPalettes(block) {
  const rows = [];
  for (let r = 0; r < PLUS_PALETTE_ROWS; r++) {
    const colors = [];
    for (let c = 0; c < 16; c++) {
      const raw = u16le(block, PLUS_PALETTE_OFFSET + r * PLUS_PALETTE_ROW_BYTES + c * 2);
      colors.push({ raw, ...rgb555ToRgb(raw), stp: (raw & 32768) !== 0, empty: raw === 0 });
    }
    rows.push({ row: r, colors, blank: colors.every((c) => c.empty) });
  }
  return rows;
}
function plusPaletteRow(what, stage = 0) {
  switch (what) {
    case "map":
      return stage;
    case "enemy":
      return 6 + stage;
    case "boss":
      return 12 + stage;
    case "player":
      return 18;
    case "title":
      return 19;
    case "shot":
      return 20;
    case "effect":
      return 21;
    default:
      return null;
  }
}
function decodePlusGraphics(block) {
  const indexed = new Uint8Array(PLUS_GRAPHICS_WIDTH * PLUS_GRAPHICS_HEIGHT);
  let used = 0;
  for (let i = 0; i < PLUS_GRAPHICS_SIZE; i++) {
    const b = block[PLUS_GRAPHICS_OFFSET + i];
    indexed[i * 2] = b & 15;
    indexed[i * 2 + 1] = b >> 4;
    if (b) used++;
  }
  return {
    width: PLUS_GRAPHICS_WIDTH,
    height: PLUS_GRAPHICS_HEIGHT,
    pages: PLUS_GRAPHICS_PAGES,
    pageHeight: PLUS_PAGE_HEIGHT,
    indexed,
    usedBytes: used,
    blank: used === 0
  };
}
function plusStageOffset(stage) {
  return PLUS_STAGES_OFFSET + stage * PLUS_STAGE_SIZE;
}
function decodePlusMapRow(row) {
  const chips = [];
  for (const half of PLUS_MAP_HALVES) {
    const flags = row[half.flags];
    half.chips.forEach((at, i) => {
      const b = row[at];
      chips.push({
        raw: b,
        group: b & 127,
        hflip: (b & 128) !== 0,
        vflip: (flags >> 7 - i & 1) !== 0,
        blank: (b & 127) === 0
      });
    });
  }
  return chips;
}
function decodePlusStage(block, stage) {
  const base = plusStageOffset(stage);
  const parts = {};
  for (const p of PLUS_STAGE_LAYOUT) parts[p.name] = block.subarray(base + p.offset, base + p.end);
  const rows = [];
  let used = 0;
  for (let r = 0; r < PLUS_MAP_ROWS; r++) {
    const chips = decodePlusMapRow(parts.map.subarray(r * PLUS_MAP_ROW_BYTES, (r + 1) * PLUS_MAP_ROW_BYTES));
    for (const c of chips) if (!c.blank) used++;
    rows.push(chips);
  }
  return {
    stage,
    offset: base,
    columns: PLUS_MAP_COLUMNS,
    rows: PLUS_MAP_ROWS,
    chipDim: PLUS_CHIP_DIM,
    map: parts.map,
    mapRows: rows,
    used,
    parts
  };
}
function decodePlusStages(block) {
  const stages = [];
  for (let s = 0; s < PLUS_STAGES; s++) stages.push(decodePlusStage(block, s));
  return stages;
}
function decodePlusGlobals(block) {
  const parts = {};
  for (const p of PLUS_GLOBAL_LAYOUT) {
    parts[p.name] = block.subarray(PLUS_GLOBAL_OFFSET + p.offset, PLUS_GLOBAL_OFFSET + p.end);
  }
  const items = [];
  for (let i = 1; i < 8; i++) {
    const word = u16le(parts.itemTable, i * 2);
    const effect = word & 255;
    items.push({ slot: i - 1, effect, name: PLUS_ITEM_EFFECTS[effect] ?? null, enabled: word >> 8 !== 0 });
  }
  const settings = parts.gameSettings;
  const bgm = Array.from(parts.bgmAssignment, (song, i) => ({ slot: PLUS_BGM_SLOTS[i], song }));
  return {
    parts,
    items,
    /** The weapon a new game starts with, from item slot 0. */
    startingWeapon: (u16le(parts.itemTable, 2) & 255) - 1,
    bgm,
    scoreBonus: PLUS_SCORE_BONUS[settings[0] & 7],
    /** Frames the hold-to-charge weapon needs. */
    chargeFrames: (5 - Math.min(settings[1], 5)) * 45 + 40,
    stageCount: settings[2] + 1
  };
}
function decodePlusSound(block) {
  const songs = [];
  for (let i = 0; i < PLUS_SONG_COUNT; i++) {
    const at = PLUS_SOUND_OFFSET + i * PLUS_SONG_SIZE;
    songs.push({ index: i, bytes: block.subarray(at, at + PLUS_SONG_SIZE) });
  }
  return songs;
}
function decodePlusHiScores(block, { stageCount = null } = {}) {
  const entries = [];
  for (let t = 0; t < PLUS_HISCORE_TABLES; t++) {
    for (let i = 0; i < PLUS_HISCORE_COUNT; i++) {
      const at = PLUS_HISCORE_OFFSET + t * PLUS_HISCORE_TABLE_BYTES + i * PLUS_HISCORE_SIZE;
      const stage = block[at + 4];
      entries.push({
        rank: i + 1,
        table: t,
        owner: t === 0 ? "built-in" : "user game",
        score: u32le(block, at),
        stage,
        allClear: stageCount !== null && stage >= stageCount,
        pad: Array.from(block.subarray(at + 5, at + 8)),
        name: latin1(block, at + 8, 8)
      });
    }
  }
  return entries;
}
function plusButtons(mask) {
  return PLUS_BUTTONS.filter((_, i) => mask >> i & 1);
}
function decodePlusSettings(block) {
  const at = PLUS_SETTINGS_OFFSET;
  const keys = [];
  for (let i = 0; i < 4; i++) {
    const mask = block[at + 4 + i];
    keys.push({ action: i, mask, buttons: plusButtons(mask) });
  }
  return {
    bytes: block.subarray(at, at + PLUS_SETTINGS_SIZE),
    cursorSpeed: block[at],
    fontBank: block[at + 1],
    menuBgm: block[at + 2] < 4 ? block[at + 2] : null,
    stereo: block[at + 3] !== 0,
    keys
  };
}
function attempt2(result, block, fn) {
  try {
    result[block] = fn();
  } catch (err) {
    result[block] = null;
    result.errors.push({ block, message: err.message });
  }
}
function parsePlusSave(block, { filename = "" } = {}) {
  const result = {
    game: "plus",
    filename,
    productOk: filename === "" || filename === PLUS_PRODUCT,
    size: block.length,
    sizeOk: block.length === PLUS_BLOCK_SIZE,
    header: null,
    checksums: null,
    palettes: null,
    graphics: null,
    stages: null,
    globals: null,
    sound: null,
    hiScores: null,
    settings: null,
    table: PLUS_TABLE,
    regions: PLUS_REGIONS,
    stageLayout: PLUS_STAGE_LAYOUT,
    globalLayout: PLUS_GLOBAL_LAYOUT,
    errors: []
  };
  attempt2(result, "header", () => parseSaveHeader(block));
  if (block.length < PLUS_BLOCK_SIZE) {
    result.errors.push({ block: "size", message: `${block.length} bytes; a Dezaemon+ save is ${PLUS_BLOCK_SIZE}` });
    return result;
  }
  attempt2(result, "checksums", () => plusChecksums(block));
  attempt2(result, "palettes", () => decodePlusPalettes(block));
  attempt2(result, "graphics", () => decodePlusGraphics(block));
  attempt2(result, "stages", () => decodePlusStages(block));
  attempt2(result, "globals", () => decodePlusGlobals(block));
  attempt2(result, "sound", () => decodePlusSound(block));
  attempt2(result, "hiScores", () => decodePlusHiScores(block, { stageCount: result.globals?.stageCount ?? null }));
  attempt2(result, "settings", () => decodePlusSettings(block));
  return result;
}

// packages/shmup-engine/src/psx/plus-edit.js
function putU16le4(bytes, at, v) {
  bytes[at] = v & 255;
  bytes[at + 1] = v >> 8 & 255;
}
var PLUS_UNSEALED_GROUP = 19;
var PLUS_UNSEALED_OFFSET = PLUS_CHECKSUM_OFFSET + PLUS_UNSEALED_GROUP * 2;
var PLUS_SEALED_GROUPS = PLUS_CHECKED_GROUPS;
function assertPlusBlock(block) {
  if (!(block instanceof Uint8Array)) {
    throw new Error(`a Dezaemon+ block must be a Uint8Array; got ${typeof block}`);
  }
  if (block.length !== PLUS_BLOCK_SIZE) {
    throw new Error(`editing needs the whole ${PLUS_BLOCK_SIZE}-byte block; got ${block.length}`);
  }
}
function sealPlusChecksums(block) {
  assertPlusBlock(block);
  const { computed } = plusChecksums(block);
  const words = [];
  const groups = [];
  for (let group = 0; group < PLUS_SEALED_GROUPS; group++) {
    const offset = PLUS_CHECKSUM_OFFSET + group * 2;
    const before = u16le(block, offset);
    const after = computed[group];
    if (before === after) continue;
    putU16le4(block, offset, after);
    words.push({ group, offset, before, after });
    groups.push(group);
  }
  return {
    words,
    groups,
    bytes: words.length * 2,
    unsealedGroup: PLUS_UNSEALED_GROUP,
    unsealedOffset: PLUS_UNSEALED_OFFSET,
    ok: plusChecksums(block).ok
  };
}
var GLOBAL_PIECE = Object.freeze(Object.fromEntries(PLUS_GLOBAL_LAYOUT.map((p) => [p.name, p])));
var GRAPHICS_ROW_BYTES = PLUS_GRAPHICS_WIDTH / 2;
var GROUP_TABLES = Object.freeze({
  title: "titleGroup",
  ending: "endingGroup",
  ship: "shipGroup"
});
var PLUS_SHIP_GROUP_FORCED = Object.freeze([61, 62, 63]);

// packages/shmup-engine/src/psx/plus-factory-data.js
var PLUS_FACTORY_ROWS = Object.freeze({
  20: Object.freeze([0, 32799, 33023, 33279, 33567, 33695, 40959, 46079, 52223, 59391, 65535, 32791, 32782, 32778, 32773, 32769]),
  21: Object.freeze([0, 32768, 41224, 49680, 57079, 65535, 32949, 33119, 36543, 38911, 57664, 61988, 65255, 34336, 33504, 33760]),
  22: Object.freeze([0, 40167, 48623, 65535, 32771, 32775, 32783, 32799, 32864, 32992, 33248, 33760, 35840, 39936, 48128, 64512]),
  23: Object.freeze([0, 65535, 32768, 49680, 32799, 33760, 64512, 33791, 65312, 33040, 64525, 37407, 45687, 65422, 59807, 33184])
});
var PLUS_FACTORY_SHIP_TILES = Object.freeze([
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  28,
  29,
  30,
  31,
  32,
  33,
  34,
  35,
  36,
  37,
  38,
  39,
  40,
  41,
  42,
  43,
  44,
  45,
  46,
  47,
  44,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  48,
  41,
  47,
  47,
  41
]);
var PLUS_FACTORY_SHEET_BASE64 = [
  "AAAAAAAAoKoAAAAAAKC6uwAAAAAAuru7AAAAAKC7u7sAAAAAuru7uwAAAKC7u7u7AAAAuru7u7sAAAC6u7u7uwAAoLu7u7u7AAC6",
  "u7u7u7sAALq7u7u7uwCgu7u7u7u7AKC7u7u7u7sAuru7u7u7uwC6u7u7y8vLoLu7u7y8vLyqAAAAAAAAALuqAAAAAAAAu7sKAAAA",
  "AAC7u6sAAAAAALu7uwoAAAAAu7u7qwAAAAC7u7u7CgAAALu7u7sKAAAAu7u7u6sAAAC7u7u7uwoAALu7u7u7CgAAu7u7u7urAAC7",
  "u7u7u6sAALu7u7u7uwoAy8u7u7u7CgC8vLy8u7urAKC7u8vLy8vLoLu7vLy8vLy6u8vLy8vLy7q7vLy8vMzMusvLy8vMzMy7u7zM",
  "zMzMzLvLy8zMzMzMu7zMzMzMzMzLy8zMzMzAwLvMzMwMDAwMy8vMzMDAwMC8zAwMDAwAAMvMwMAAAAAAzAwMAAAAAADMwAAAAAAA",
  "AAwAAAAAAAAAy8vLy7u7qwC8vLy8vLurAMvLy8vLu7sKzLy8vLy8uwrMzMzLy8u7CszMzMy8vLsLzMzMzMzLuwvMzMzMzLy8C8DA",
  "zMzMzMsLDAwMzMzMvAvAwMDAzMzLCwAADAwMzLwMAAAAwMDAzAsAAAAAAAzMDAAAAAAAwMAMAAAAAAAAAAwAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAMAAAAAAACjOgAAAAAAMKqqAwAAAAAwqqoDAAAAAACjOgAAAAAAADADAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAgAgAAAAAAADIjAAAAAAAgkzkCAAAAACCTOQIAAAAAADIjAAAAAAAAIAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAwAAAAAAAKM6AAAAAAAwqqoDAAAA",
  "AKOqqjoAAAAAo6qqOgAAAAAwqqoDAAAAAACjOgAAAAAAADADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACACAAAAAAAAMiMAAAAAACBDNAIAAAAAMqRKIwAAAAAypEojAAAAACBDNAIA",
  "AAAAADIjAAAAAAAAIAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAC7CwAAAAAAADuzCwAAAAAAO1a0AAAAAACwlUYLAAAAALBkWQsAAAAAAEtVswAAAAAAsDuzAAAAAAAAsLsAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAsAsAAAAAAAA7swAAAAAAAFu1AAAA",
  "AACwhEgLAAAAALCESAsAAAAAsIRICwAAAACwhEgLAAAAAABbtQAAAAAAADuzAAAAAAAAsAsAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACwuwAAAAAAsDuzAAAAAABLZbMAAAAAsGRZCwAAAACwlUYL",
  "AAAAADtVtAAAAAAAO7MLAAAAAAC7CwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC7uwAAAAAAu0REuwAAALBTiIg1CwAAsFOIiDULAAAAu0REuwAAAAAAu7sAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAwAAAAAAQ5lpRwAAAFCZqqqaNQAAlaqqqqpZ",
  "AwCnqqqqqpoEQKmqqqqqqgVAqaqqqqqqN1Cpqqqqqqo3QKmqqqqqqicwpaqqqqqaBQB0qqqqqnkEAFOpqqqaVwAAMHSZmXcEAAAA",
  "QFRVJAAAAAAAAAAAAAAAAAAAAAAAAAAAwLvLDAAAAMAbMjQSDAAAsDJUVVbCAAAbVHeHiBYAAEuVmHmZSQsAQZeqmqqKAsBCmKqq",
  "qooCwEGWqqqaaQLAQYeamqpYAgAxZVeoqngLABwyQ2WJNgAAsLEyZXbDAAAALENFIwwAAAAALLsMAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAANC8uwwAAAAAy8wrIwsAAMC9O1JVAgAA3RtDhHnFAADMMYWpqjgAAM5ClqqqSgAAzUGoqqpqAADNS5apqkoAAN0c",
  "ZKiaOAAA3bwxhIkWAADQvBtDVgQAAAC8IUMjAAAAAADAzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4O7ODAAAAADg3b0R",
  "DAAAANDMGxHDAAAAzRsjIxQAAOC9MkQkNAwA4BsyhENKAADgu0JEpHoMAAC9IkSoqgwA4L4RMqeKAAAA7t0xqloAAOAA7juqxAAA",
  "AO7dSzcAAAAAAMDLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgAAAAAAAAAAAAAAAAAAAM3LDQ4AAODgvCvS3gAAANDd",
  "zbO8AAAA4ADOIiIAAADgAMCyIwAAAAAAzjIoAAAAAADOM8gAAAAA4LyjBgAAAADeQkgMAAAAAN4rDAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADg6+7gAAAAAC4O4A4OAAAA6wAADg4AAAALAADg3gAAAA4AAMDNAAAA",
  "4AAAwNMAAADgAAAuAgAAAA4AzkMMAAAA0DJDswAAAAAA0NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "ACIzAAAAAAAyREQAAAAARHWZmQAAAEN3mZmpAABAd5mpqqoAAFSZqqqqqgAwd6qqqqqqAFKXqqqqqqoAU6mqqqqqqgB0qaqqqqqq",
  "IFWqqqqqqqowdaqqqqqqqjB1qqqqqqqqMHWqqqqqqqoAAAAAAAAAAAAAAAAAAAAAIgAAAAAAAABEMwIAAAAAAJl2RCMAAAAAmpl3",
  "NAIAAACqqql5RAAAAKqqqplFAwAAqqqqqnlEAACqqqqqeUUAAKqqqqqaVwMAqqqqqqpZJACqqqqqqnk1AKqqqqqqeUUAqqqqqqqJ",
  "VQCqqqqqqolVADB1qqqqqqqqMHWpqqqqqqogdamqqqqqqgB1qaqqqqqqAFSXqqqqqqoAVJeqqqqqqgBCdamqqqqqADB1maqqqqoA",
  "AESXmaqqqgAAQ3WZqqmqAAAwRFWHeZkAAAAyVHV3dwAAAAAyRFVVAAAAAAAyM0QAAAAAAAAAAAAAAAAAAAAAqqqqqqqJRQCqqqqq",
  "qolFAKqqqqqqeUUAqqqqqqp5RACqqqqqmXc0AKqqqqqZdyQAqqqqmplVAwCqqqqZd0UAAKqqmnlXNAAAqqqZeUcDAACZmXdXMwAA",
  "AHd3V0UCAAAAVUU0AgAAAABEMwIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMy7u7sAAADAu7siIgAA",
  "ALwbISJDAADAuxEiMzMAALwRM0NURQAAuxFDRIdVAMAbMnZ1d3cAwBtFhYeYiQC8O1R1mJmJALxRVIaZqpkAu1NWmKmqqgC7U1aY",
  "qaqqALtUdZiqqqoAu1RlmKqqqgAAAAAAAAAAAAAAAAAAAAC7zAAAAAAAABG7zAAAAAAANCIiywAAAABERDOyzAAAAFVlVjS7DAAA",
  "ZmZmVRIMAACFiIiIJLEAAIiIiIhHsgAAmZmZmWkSAACZmaqqmTQLAJqYqqqaRgEAmpiqqppGAQCqmKqqimWxAKqqqqqZRbEAALtj",
  "dpiqqqoAu0N2l6mqqgC7S0SHmZmZALw7VGeZmZkAvLFDZFdXdwC8sTFFZUZUAMAbuyJDQ3UAALuxGzNCVQAAzBu7ITNEAADAuxER",
  "MkMAAADAuzNEVAAAAAC8IkREAAAAAADMuyIAAAAAAADMzAAAAAAAAAAAAAAAAAAAAACqqqqZeUWyAKmqmohYRQIAqqqqmVhDAQCq",
  "qqqaWDMLAJiqqppoJAwAmKqqmmgTDAB3iIiYdsIAAHeIiJhEwgAARVZ1RCMMAABUVVU0wgAAAEVDIssAAAAAMzO7zAAAAACyzAAA",
  "AAAAAMwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAO4AAAAA7gDu",
  "3gAAAO4A7s3cAAAADgDezM0AAAAA4M28uwAA4ADezbwbAAAO4N7MGyIAAA7gzbsRIgDgAO7MERJDAOAA3bwbM0MADgDOvBEyRADu",
  "AN67ETJ1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADNzAAAAAAAAL3LzAAAAAAAzBwRywAAAAC7uyGxDAAAABERuzOx",
  "AAAAIhIhQxMMAAAzITQzNAsAADMzMzJEwQAAM4RFNHexAABEhTREd7EAAIg3RHh6EwAAiEREqqoTAAAADgDNzBsyJADgAN7NEUJE",
  "AAAA7swRITMA4ADuvLsRMgAAAODNG7sSAAAA3t3MvBsAAA4A7d7uvAAA4AAO7t7NAAAADQAA7b0AAADuAA7uzQAAAODu3t3MAAAA",
  "AN7e3bwAAAAAAODdvAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHdHo6qqFAAAR3SoqqoUAABDVKeqqhQAADNEqqqqFQAAMlOqqqoV",
  "AAAiVKqqqsMAACJUqqqKAQAAIXSqqloMAAAhdKp3EwAAACF0qkTBAAAAMac1ywAAAABDNLEMAAAAALsMAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAA",
  "AODu7gAAAADgvN0OAAAAAN7S7u4AAAAALO7gAAAAAAArDuDgAAAA4NvgAAAAAADQ3AAAAAAAANDuAAAAAAAA4A4AAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0A4A7gAAAAAADg7gAAAAAAAM",
  "DgDgAAAAAO4OAA4AAAAAAA4A7QAAAADuDgDdAAAAAADgDs0AAAAADuDszQAAAAAAAAAOAAAAAAAAAO4AAAAAAAAADgAAAAAAAADg",
  "AAAAAAAAAAAAAAAAAADgAAAAAAAAAAAOAAAAAAAAAO3u4N4AAAAA4L0jMgAAAAAA3SJDAAAAAAAA7s0AAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADO7LwOAAAAAM7usg4AAADgzr6yAAAAAODOK7IAAAAADswz2wAAAADuLDTrAAAA7ixD",
  "Iw4AAAC8MkTCAAAAAENEIw0AAAAARDPbAAAAAADd7gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAEQRUTMAAABAVSFTRAMAAFRVIVNENABAVUUREUREA1RVFGZmQUQ0VEVhd2YWRDQREXZVZ2YRESESdlVnZiESMRN2d2Z2IRJE",
  "FGZmZnZBMzFDYWZmFyQSMTMUdndBIhIQM0MRESQiAQAxMyFDIhIAABAzIUMiAQAAABERQREAAAAQAREREAEAACEWYiZhEgAQMhdz",
  "N3EjASFDGBERgTQSMVQhmZkiRRMxFZIZkSlSE3EYkikiGYIXESEimSISEhERISIimSISEXEokiKSKYIXMSWSKZIZUhMxVCKZmRFF",
  "EyFDKBIRgTQSEDIXERFxIwEAIRYTMWESAAAQEQEQEQEAERERARARERGRiBgTMYGIF4GJQSRCFHgWgRgUERFRYRaBQfH//x8VFhEU",
  "9h8R/0ERMRT2H2b/QRMQEvYfZv8hARAS9v//HyEBMRT2HxERQRMRFPYfZmZBEYFR8R9mFhUWgRgVERFRYRaBZ0EkQhRmFnFmFhMx",
  "YWYWERERARAREREAAEQRUTMAAABAVSFTRAMAAFRVIVNENABAVUUREUREA1RVFN3dQUQ0VEXR7t0dRDQREe1V3t0RESES7VXe3SES",
  "MRPt7t3tIRJEFN3d3e1BMzFD0d3dHiQSMTMU7e5BIhIQM0MRESQiAQAxMyFDIhIAABAzIUMiAQAAABERQREAAAAREQAAEREAECIi",
  "ARAiIgEhMyMRETIzEiFTFKEaQTUSIUORmZkRNBIhEpEZkRkhEhChmhmaGRoBAKGamZkRGgAAoZoZkakaABChmhmaGRoAIRKRmZkR",
  "IQEhQxERERE0EiFTFKqqQTUSITMjEREyMxIQIiIBACEiAQAREQAAEBEAAABEEVEzAAAAQFUhU0QDAABUVSFTRDQAQFVFERFERANU",
  "VRSqqkFENFRFobuqGkQ0ERG6VauqEREhErpVq6ohEjETuruquiESRBSqqqq6QTMxQ6GqqhskEjEzFLq7QSISEDNDEREkIgEAMTMh",
  "QyISAAAQMyFDIgEAAAAREUERAAARERFmZhEREUFEJJmIMTMTQREREREREROGIbsrsiIrF4axErGyIRsXEbEhsrEhGxGGsSEisSEb",
  "F4YhzCzCzBwXESESwcIRHBFBwSLCwSEcE0HBIcLBIRwTQSHMLMEhEhMQRBIRIiEzAQBBREQzMxMAABBBRDMTAQAAABAREQEAAAAA",
  "AAAAAAAAAACHB3B4AAAAAJgIgIkAAAAAmQmQmQAAAACZCZCZAAAAAJkJkJkAAAAAmAiAiQAAAACYCICJAAAAAIcHcHgAAAAAdwdw",
  "dwAAAAB2BmBnAAAAAGYGYGYAAAAAZgZgZgAAAABgAAAGAAAAAGAAAAYAAAAAAAAAAAAAAAAA3d0AAAAAAN3u7t0AAADQ7u7u7g0A",
  "AO3u///u3gAA7f7//+/eANDu/1VV/+4N0O5fVVX17g3Q7l9VVfXuDdDuX1VV9e4N0O5fVVX17g3Q7v9VVf/uDQDt/v//794AAO3u",
  "///u3gAA0O7u7u4NAAAA3e7u3QAAAAAA3d0AAAAAAAAwAQAAAAAAAFMRAAAAAAAAUxEAAAAAAABTEQAAAAAAACERAAAAAAAAyxoA",
  "AAAAAABTEQAAAAAAAFMRAAAAAAAAUxEAAAAAAAAhEQAAAAAAE1MTIQAAADAUExExAgAAQxRRFTEjADAUEVzFETECMAGgy7wKEAIQ",
  "AAC6qwAAAQAAADAAAAAAAAAAUwMAAAAAAADBAQAAAAAAAMsLAAAAAAAAUwMAAAAAAABTAwAAAAAAAFMDAAAAAAAAUwMAAAAAAAAx",
  "AQAAAAAAQDFBAAAAAABEQkIEAAAAAAAcDAAAAAAAsFy8AAAAAACgzKwAAAAAAADKCgAAAAAAAKAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAACgAAAAAAAAAPurAAAAAACgEREBAAAAAAAAEQEAAAAAAAAQEQEAAAAAABARAQAAAAAAEBERAAAA",
  "AAAAEBEAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqg",
  "AAAAAAAA6woAAAAAALAREQAAAAAAoAAaAQEAAAAAABARAQAAAAAAABEBAAAAAAAREQEAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAACwsLCwsAAAAAsLCwsLCwAAsLCwsLAAAAALCwsLCwsAALCwsLCwAAAACwsLCwsLAACwsLCwsAAAAAsL",
  "CwsLCwAAsLCwsLAAAAALCwsLCwsAALCwsLCwAAAACwsLCwsLAACwsLCwsAAAAAsLCwsLCwAAsLCwsLAAAAALCwsLCwsAAAAAAAAA",
  "AAAAAACIiAAAAAAAiJmZiAAAAICZRESZCAAAmERERESJAACYRERERIkAgElERERElAiASURERESUCIBJRERERJQIgElERERElAgA",
  "mERERESJAACYRERERIkAAICZRESZCAAAAIiZmYgAAAAAAIiIAAAAAAAAAAAAAAA="
].join("");
var sheetTiles = null;
function plusFactorySheet() {
  if (!sheetTiles) {
    const bin = typeof atob === "function" ? atob(PLUS_FACTORY_SHEET_BASE64) : Buffer.from(PLUS_FACTORY_SHEET_BASE64, "base64").toString("latin1");
    sheetTiles = [];
    for (let t = 0; t * 128 < bin.length; t++) {
      const tile = new Uint8Array(256);
      for (let i = 0; i < 128; i++) {
        const b = bin.charCodeAt(t * 128 + i);
        tile[i * 2] = b & 15;
        tile[i * 2 + 1] = b >> 4;
      }
      sheetTiles.push(tile);
    }
  }
  return sheetTiles;
}

// packages/shmup-engine/src/psx/plus-write.js
var PLUS_TILE_COLS = 16;
var PLUS_TILE_ROWS = 32;
var PLUS_TILE_COUNT = PLUS_TILE_COLS * PLUS_TILE_ROWS;
var PLUS_TILE_CAPACITY = PLUS_TILE_COUNT - 4;
var PLUS_ROW_PITCH = 128;
var PLUS_EMPTY_TILE = 1023;
var PLUS_GROUP_HFLIP = 16384;
var PLUS_GROUP_VFLIP = 32768;
var PLUS_LAYOUT_HFLIP = 64;
var PLUS_LAYOUT_VFLIP = 128;
function plusTileWord(n) {
  const col = n % PLUS_TILE_COLS;
  const row = Math.floor(n / PLUS_TILE_COLS) % 16;
  const half = n >= 256 ? 1 : 0;
  return col & 7 | (col & 8) << 4 | row << 3 | half << 8;
}
var PlusBankFullError = class extends Error {
  constructor(what) {
    super(`the graphics bank holds ${PLUS_TILE_CAPACITY} tiles and every one is taken (${what})`);
    this.name = "PlusBankFullError";
  }
};
function tileKey(t) {
  let s = "";
  for (let i = 0; i < t.length; i++) s += String.fromCharCode(t[i]);
  return s;
}
function flipTileH(t) {
  const out = new Uint8Array(256);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) out[y * 16 + x] = t[y * 16 + 15 - x];
  return out;
}
function flipTileV(t) {
  const out = new Uint8Array(256);
  for (let y = 0; y < 16; y++) out.set(t.subarray((15 - y) * 16, (16 - y) * 16), y * 16);
  return out;
}
var PlusTileBank = class {
  constructor() {
    this.tiles = [];
    this.byKey = /* @__PURE__ */ new Map();
    this.shared = 0;
  }
  get used() {
    return this.tiles.length;
  }
  get free() {
    return PLUS_TILE_CAPACITY - this.tiles.length;
  }
  /** An all-zero tile is the empty word; otherwise the tile's number. */
  add(indices) {
    let blank = true;
    for (let i = 0; i < indices.length; i++) if (indices[i]) {
      blank = false;
      break;
    }
    if (blank) return null;
    const key = tileKey(indices);
    const hit = this.byKey.get(key);
    if (hit !== void 0) {
      this.shared++;
      return hit;
    }
    if (this.tiles.length >= PLUS_TILE_CAPACITY) throw new PlusBankFullError("a tile");
    const n = this.tiles.length;
    this.tiles.push(Uint8Array.from(indices));
    this.byKey.set(key, n);
    return n;
  }
  /** As add(), but a stored mirror serves: returns {tile, hflip, vflip} or null for blank. */
  addFlippable(indices) {
    let blank = true;
    for (let i = 0; i < indices.length; i++) if (indices[i]) {
      blank = false;
      break;
    }
    if (blank) return null;
    const hit = this.byKey.get(tileKey(indices));
    if (hit !== void 0) {
      this.shared++;
      return { tile: hit, hflip: false, vflip: false };
    }
    const h = flipTileH(indices);
    const hv = flipTileV(h);
    const v = flipTileV(indices);
    for (const [bytes, hflip, vflip] of [[h, true, false], [v, false, true], [hv, true, true]]) {
      const m = this.byKey.get(tileKey(bytes));
      if (m !== void 0) {
        this.shared++;
        return { tile: m, hflip, vflip };
      }
    }
    return { tile: this.add(indices), hflip: false, vflip: false };
  }
  /** The 0x10000-byte 4bpp bitmap, low nibble = left pixel. */
  toBitmap() {
    const out = new Uint8Array(PLUS_GRAPHICS_SIZE);
    this.tiles.forEach((t, n) => {
      const col = n % PLUS_TILE_COLS, row = Math.floor(n / PLUS_TILE_COLS);
      for (let y = 0; y < 16; y++) {
        const base = (row * 16 + y) * PLUS_ROW_PITCH + col * 8;
        for (let x = 0; x < 16; x += 2) out[base + (x >> 1)] = t[y * 16 + x] & 15 | (t[y * 16 + x + 1] & 15) << 4;
      }
    });
    return out;
  }
};
var PLUS_OPAQUE = 32768;
var PLUS_COLORS_PER_ROW = 15;
var PlusPaletteRow = class {
  constructor(row) {
    this.row = row;
    this.frames = [];
    this.words = null;
    this.cands = null;
    this.cache = /* @__PURE__ */ new Map();
  }
  consider(frame) {
    this.frames.push(frame);
  }
  build() {
    const hist = colorHistogram(this.frames);
    const chosen = medianCut(hist, PLUS_COLORS_PER_ROW);
    this.words = new Uint16Array(16);
    chosen.forEach((w, i) => {
      this.words[i + 1] = PLUS_OPAQUE | w;
    });
    this.cands = chosen.map((w, i) => ({ index: i + 1, r: w & 31, g: w >> 5 & 31, b: w >> 10 & 31 }));
    this.count = chosen.length;
    return this;
  }
  nearest(r8, g8, b8) {
    const key = r8 >> 3 << 10 | g8 >> 3 << 5 | b8 >> 3;
    const hit = this.cache.get(key);
    if (hit !== void 0) return hit;
    const r = r8 >> 3, g = g8 >> 3, b = b8 >> 3;
    let best = 1, bestD = Infinity;
    for (const c of this.cands) {
      const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c.index;
      }
    }
    if (!this.cands.length) best = 0;
    this.cache.set(key, best);
    return best;
  }
  /** An RGBA frame as w*h indices into this row (0 where transparent). */
  index(frame) {
    if (!this.words) this.build();
    const out = new Uint8Array(frame.w * frame.h);
    for (let i = 0; i < out.length; i++) {
      const o = i * 4;
      if (frame.rgba[o + 3] < KIDS_ALPHA_CUTOFF) continue;
      out[i] = this.nearest(frame.rgba[o], frame.rgba[o + 1], frame.rgba[o + 2]);
    }
    return out;
  }
};
function indexedTiles(indexed, w, h) {
  const cw = w / CG_CELL, ch = h / CG_CELL;
  const tiles = [];
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const t = new Uint8Array(256);
      for (let y = 0; y < 16; y++) t.set(indexed.subarray((cy * 16 + y) * w + cx * 16, (cy * 16 + y) * w + cx * 16 + 16), y * 16);
      tiles.push(t);
    }
  }
  return tiles;
}
var PLUS_TITLE_BYTES = Object.freeze([
  131,
  102,
  131,
  85,
  131,
  71,
  131,
  130,
  131,
  147,
  129,
  123,
  129,
  105,
  131,
  118,
  131,
  137,
  131,
  88,
  129,
  106,
  129,
  64,
  131,
  134,
  129,
  91,
  131,
  85,
  129,
  91,
  131,
  81,
  129,
  91,
  131,
  128,
  131,
  102,
  129,
  91,
  131,
  94
]);
var PLUS_FACTORY_SETTINGS = Object.freeze([0, 0, 0, 0, 2, 1, 8, 2]);
var PLUS_FACTORY_NAME = 46;
var PLUS_TITLE_TYPE = Object.freeze([10, 2]);
var PLUS_ITEM_TABLE = Object.freeze([0, 0, 6, 1, 11, 1, 9, 1, 2, 1, 10, 1, 3, 1, 7, 1]);
var PLUS_SCORE_BONUS_INDEX = 4;
var PLUS_CHARGE_TIME = 2;
var PLUS_BGM_ASSIGNMENT = Object.freeze([17, 18, 19, 20, 22, 22, 22, 23, 24, 22, 24, 26, 16, 28, 29, 27]);
var PLUS_BOSS_COLUMN = 5;
var PLUS_STAGE_CONFIG_DEFAULT = 0;
var PLUS_SCROLL_EFFECT_DEFAULT = 66;
var PLUS_DEF_CLASSES = Object.freeze([
  Object.freeze({ nibble: 8, base: 0, count: 16, w: 16, h: 16, frames: 4 }),
  Object.freeze({ nibble: 9, base: 16, count: 16, w: 32, h: 16, frames: 2 }),
  Object.freeze({ nibble: 10, base: 32, count: 16, w: 16, h: 32, frames: 2 }),
  Object.freeze({ nibble: 11, base: 48, count: 8, w: 32, h: 32, frames: 2 }),
  Object.freeze({ nibble: 12, base: 56, count: 4, w: 64, h: 64, frames: 1 })
]);
var PLUS_BOSS_ART = Object.freeze({ horizontal: { w: 128, h: 64 }, vertical: { w: 64, h: 128 } });
var PLUS_BOSS_HP = Object.freeze([2e3, 4e3, 8e3, 12e3, 16e3, 18e3, 24e3, 32e3]);
var PLUS_BOSS_SCORE = Object.freeze([5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6]);
var PLUS_BOSS_SCRIPTS = 80;
var PLUS_SCROLL_BANDS = PLUS_APPEAR_ROW_TABLE;
var PLUS_FIRST_SPAWN_ROW = 8;
var PLUS_ROW_STEP = 12;
var PLUS_BOSS_ROW_GAP = 24;
var PLUS_MAX_SPAWN_ROW = PLUS_SCROLL_BANDS - 64;
var PLUS_STORY_TOP_ROW = 11;
var PLUS_STORY_LEAD_ROWS = 8;
var PLUS_STORY_MIN_BOSS_ROW = 80;
var PLUS_STORY_SCROLL_EFFECT = 65;
var PLUS_STORY_W = 14 * CG_CELL;
var PLUS_SPAWN_COLUMNS = PLUS_APPEAR_RECORD_SIZE;
var RUNTIME_TO_PLUS_SPEED = 0.5;
var PLUS_SHOT_DAMAGE = 24;
var PLUS_MOVE_STRAIGHT_BASE = 8;
var PLUS_STRAIGHT_SPEEDS = Object.freeze([0.5, 1, 1.5, 2, 2.5, 3, 4.5, 6]);
var clamp3 = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function nearestIndex3(table, value) {
  let best = 0, bestD = Infinity;
  table.forEach((v, i) => {
    const d = Math.abs(v - value);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
function putU16le5(bytes, at, v) {
  bytes[at] = v & 255;
  bytes[at + 1] = v >> 8 & 255;
}
function putU32le4(bytes, at, v) {
  putU16le5(bytes, at, v & 65535);
  putU16le5(bytes, at + 2, v >>> 16 & 65535);
}
function b64ToBytes3(b64) {
  const bin = atob(String(b64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function plusClassFor(w, h) {
  for (let k = 0; k < PLUS_DEF_CLASSES.length; k++) {
    const c = PLUS_DEF_CLASSES[k];
    if (w <= c.w && h <= c.h) return k;
  }
  return PLUS_DEF_CLASSES.length - 1;
}
function mapPlusColumn(col, width, cellsWide = 1) {
  const last = PLUS_SPAWN_COLUMNS - cellsWide;
  if (width <= 1) return clamp3(Math.floor((PLUS_SPAWN_COLUMNS - cellsWide) / 2), 0, last);
  return clamp3(Math.round(col * (PLUS_SPAWN_COLUMNS - 1) / (width - 1)), 0, last);
}
function encodePlusEnemy({
  movement = 0,
  shotPattern = 0,
  fireRate = 0,
  shotMode = 0,
  dropsItem = false,
  scaleRateIndex = 0,
  scalesX = false,
  scalesY = false,
  hpIndex = 0,
  scaleLimitAction = 0,
  hitFlags = 0,
  scoreIndex = 0,
  turnEndAction = 0,
  animIndex = 0,
  shotParameter = 0,
  depthGate = false,
  rotation = 0,
  endScaleIndex = 0,
  startScaleIndex = 0,
  startTrigger = 0,
  headingIndex = 0,
  turnRateIndex = 0
} = {}) {
  const b = new Uint8Array(PLUS_ENEMY_SIZE);
  b[0] = movement & 255;
  b[1] = shotPattern & 31 | (fireRate & 7) << 5;
  b[2] = shotMode & 3 | (dropsItem ? 4 : 0) | (scaleRateIndex & 7) << 3 | (scalesX ? 64 : 0) | (scalesY ? 128 : 0);
  b[3] = hpIndex & 7 | (scaleLimitAction & 3) << 3 | (hitFlags & 7) << 5;
  b[4] = scoreIndex & 7 | (turnEndAction & 3) << 3 | (animIndex & 7) << 5;
  b[5] = shotParameter & 127 | (depthGate ? 128 : 0);
  b[6] = rotation & 3 | (endScaleIndex & 7) << 2 | (startScaleIndex & 7) << 5;
  b[7] = startTrigger & 3 | (headingIndex & 7) << 2 | (turnRateIndex & 7) << 5;
  return b;
}
function encodePlusBoss({
  scripts = [0, 0, 0],
  guns = [{ pattern: 0, rate: 0 }, { pattern: 0, rate: 0 }, { pattern: 0, rate: 0 }],
  modes = [0, 0, 0],
  vertical = false,
  offsets = [[0, 0], [0, 0], [0, 0]],
  hpIndex = 0,
  armour = false,
  scoreIndex = 0,
  parameters = [0, 0, 0],
  music = true
} = {}) {
  const b = new Uint8Array(PLUS_BOSS_SIZE);
  for (let i = 0; i < 3; i++) {
    b[i] = clamp3(scripts[i] ?? 0, 0, PLUS_BOSS_SCRIPTS - 1);
    const g = guns[i] || { pattern: 0, rate: 0 };
    b[3 + i] = clamp3(g.pattern ?? 0, 0, 19) | ((g.rate ?? 0) & 7) << 5;
    b[7 + i * 2] = (offsets[i]?.[0] ?? 0) & 255;
    b[8 + i * 2] = (offsets[i]?.[1] ?? 0) & 255;
    b[15 + i] = (parameters[i] ?? 0) & 127;
  }
  b[6] = modes[0] & 3 | (modes[1] & 3) << 2 | (modes[2] & 3) << 4 | (vertical ? 64 : 0);
  b[13] = hpIndex & 7 | (armour ? 64 : 0);
  b[14] = scoreIndex & 7;
  b[31] = music ? 1 : 0;
  return b;
}
var PLUS_BOSS_BEHAVIOUR = Object.freeze({
  scripts: Object.freeze([28, 32, 20]),
  guns: Object.freeze([Object.freeze({ pattern: 0, rate: 0 }), Object.freeze({ pattern: 16, rate: 3 }), Object.freeze({ pattern: 0, rate: 0 })]),
  modes: Object.freeze([0, 0, 3]),
  offsets: Object.freeze([Object.freeze([-33, -12]), Object.freeze([-33, 15]), Object.freeze([31, 17])])
});
function plusLayoutIndexFor(cx, cy) {
  if (cy < 8) return cy * 16 + cx;
  if (cy < 12) {
    const r2 = cy - 8;
    return 128 + (r2 >> 1) * 32 + cx * 2 + (r2 & 1);
  }
  if (cy < 16) {
    const r2 = cy - 12;
    return 192 + (r2 >> 1) * 32 + (cx >> 1) * 4 + (r2 & 1) * 2 + (cx & 1);
  }
  const r = cy - 16;
  return 256 + (cx >> 2) * 16 + r * 4 + (cx & 3);
}
function plusFrameRect(klass, n, k) {
  const c = PLUS_DEF_CLASSES[klass];
  let u = 0, v = 0;
  switch (klass) {
    case 0:
      u = (n & 3) * 64;
      v = (n >> 2) * 16;
      break;
    case 1:
      u = (n & 3) * 64;
      v = (n >> 2) * 16 + 64;
      break;
    case 2:
      u = (n & 7) * 32;
      v = (n >> 3) * 32 + 128;
      break;
    case 3:
      u = (n & 3) * 64;
      v = (n >> 2) * 32 + 192;
      break;
    default:
      u = (n & 3) * 64;
      v = 256;
      break;
  }
  return { x: u + k * c.w, y: v, w: c.w, h: c.h };
}
function layoutEnemySheet(defs) {
  const enemyGroup = new Uint16Array(64).fill(PLUS_EMPTY_TILE);
  const spriteLayout = new Uint8Array(PLUS_STAGE_PIECE.spriteLayout.length);
  const entryOfTile = /* @__PURE__ */ new Map();
  let entries = 1;
  let painted = 0, dropped = 0;
  const leftOut = [], oneFrame = [];
  const fresh = (frames) => new Set(frames.flat().filter((t) => t && !entryOfTile.has(t.tile)).map((t) => t.tile)).size;
  for (const d of defs) {
    const c = PLUS_DEF_CLASSES[d.klass];
    const cw = c.w / CG_CELL, ch = c.h / CG_CELL;
    let frames = d.tiles.slice(0, c.frames);
    if (d.shrunk && fresh(frames) > 64 - entries) {
      frames = frames.map(() => frames[0] || []);
      if (fresh(frames) > 64 - entries) {
        leftOut.push(d);
        continue;
      }
      oneFrame.push(d);
    }
    frames.forEach((cells, k) => {
      const r = plusFrameRect(d.klass, d.id, k);
      for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
          const t = cells[cy * cw + cx];
          const at = plusLayoutIndexFor(r.x / CG_CELL + cx, r.y / CG_CELL + cy);
          if (!t) {
            spriteLayout[at] = 0;
            continue;
          }
          let e = entryOfTile.get(t.tile);
          if (e === void 0) {
            if (entries >= 64) {
              dropped++;
              spriteLayout[at] = 0;
              continue;
            }
            e = entries++;
            entryOfTile.set(t.tile, e);
            enemyGroup[e] = plusTileWord(t.tile);
          }
          spriteLayout[at] = e | (t.hflip ? PLUS_LAYOUT_HFLIP : 0) | (t.vflip ? PLUS_LAYOUT_VFLIP : 0);
          painted++;
        }
      }
    });
  }
  return { enemyGroup, spriteLayout, painted, entries: entries - 1, dropped, leftOut, oneFrame };
}
function layoutBoss(tiles, vertical = false) {
  const words = new Uint16Array(32).fill(PLUS_EMPTY_TILE);
  const cols = vertical ? 4 : 8;
  for (let i = 0; i < 32; i++) {
    const block = i >> 4, row = i >> 2 & 3, col = i & 3;
    const x = vertical ? col : block * 4 + col;
    const y = vertical ? block * 4 + row : row;
    const t = tiles[y * cols + x];
    if (!t) continue;
    words[i] = plusTileWord(t.tile) | (t.hflip ? PLUS_GROUP_HFLIP : 0) | (t.vflip ? PLUS_GROUP_VFLIP : 0);
  }
  return words;
}
function layoutTitle(tiles) {
  return layoutBoss(tiles.map((t) => t === null || t === void 0 ? null : typeof t === "number" ? { tile: t } : t), false);
}
function layoutShip(poses, factory = []) {
  const group = PLUS_GLOBAL_LAYOUT.find((p) => p.name === "shipGroup").length / 2;
  const shipGroup = new Uint16Array(group).fill(PLUS_EMPTY_TILE);
  const shipOdr = new Uint8Array(PLUS_GLOBAL_LAYOUT.find((p) => p.name === "shipOdr").length);
  let painted = 0;
  factory.forEach((tile, i) => {
    if (tile !== null && tile !== void 0 && i < group) shipGroup[i] = plusTileWord(tile);
  });
  poses.slice(0, 3).forEach((tiles, p) => {
    tiles.forEach((t, i) => {
      if (!t || i >= 4) return;
      shipGroup[p * 4 + i] = plusTileWord(t.tile);
      shipOdr[p * 4 + i] = (t.hflip ? PLUS_LAYOUT_HFLIP : 0) | (t.vflip ? PLUS_LAYOUT_VFLIP : 0);
      painted++;
    });
  });
  [1020, 1021, 1022].forEach((w, i) => {
    shipGroup[61 + i] = w;
  });
  for (let i = 64; i < 72; i++) shipGroup[i] = 0;
  return { shipGroup, shipOdr, painted };
}
function buildPlusGameFromLevel(level, art2, options = {}) {
  const opts = { name: null, title1: null, horizontal: false, storyBackdrops: null, storyPicks: null, ...options };
  if (!opts.storyPicks && Array.isArray(opts.storyBackdrops) && opts.storyBackdrops.length) {
    return buildPlusWithStory(level, art2, opts);
  }
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const artMap = /* @__PURE__ */ new Map();
  for (const [k, v] of Object.entries(art2 || {})) {
    if (v && v.rgba && v.w > 0 && v.h > 0) artMap.set(decodeFrameKey(k), { key: decodeFrameKey(k), ...v });
  }
  const lookup = (n) => n ? artMap.get(decodeFrameKey(n)) || null : null;
  let stages = levelStages(level);
  if (!stages.length) throw new Error("the level has no stage with an enemylist");
  if (stages.length > PLUS_STAGES) {
    warn(`level has ${stages.length} stages; a Dezaemon+ save holds ${PLUS_STAGES} \u2014 dropped the rest`);
    stages = stages.slice(0, PLUS_STAGES);
  }
  if (opts.horizontal) warn("the grid is horizontal; a Dezaemon+ game is written as a vertical one here");
  const enemyData = level.enemyData || {};
  const bossData = level.bossData || {};
  const bank = new PlusTileBank();
  const rows = Array.from({ length: PLUS_PALETTE_ROWS }, (_, r) => new PlusPaletteRow(r));
  const fullWarned = /* @__PURE__ */ new Set();
  const tilesOf = (row, frame, w, h, what) => {
    const fitted = fitRgba(frame, w, h);
    rows[row].consider(fitted);
    return { row, fitted, w, h, what };
  };
  const plans = [];
  const plan = (row, frame, w, h, what) => {
    const p = tilesOf(row, frame, w, h, what);
    plans.push(p);
    return p;
  };
  let shipSource = "level";
  let shipFrames = (level.playerData && level.playerData.texture || []).map(lookup).filter(Boolean);
  if (!shipFrames.length) {
    shipSource = "duke";
    shipFrames = decodePlayerArt().filter((f) => /^duke_\d$/.test(f.key)).slice(0, 2);
  }
  const shipPlans = [shipFrames[0], shipFrames[1] || shipFrames[0], shipFrames[1] || shipFrames[0]].map((f, i) => plan(plusPaletteRow("player"), f, 32, 32, `ship ${i}`));
  const titlePlan = opts.title1 && opts.title1.rgba ? plan(plusPaletteRow("title"), opts.title1, 128, 64, "title") : null;
  const stagePlan = [];
  const splits = [];
  let spare = PLUS_STAGES - stages.length;
  stages.forEach((st, s) => {
    const rec = bossData[`boss${s}`];
    const split = rec ? splitBossStage2(rec) : null;
    if (split && spare <= 0) {
      warn(`${st.key}: boss (${rec.name || "?"}) has a second stage, but the save's ${PLUS_STAGES} stages are full \u2014 it flies its first form alone, the whole bar`);
    }
    if (!split || spare <= 0) {
      stagePlan.push({ st, bossRec: rec, form: 0 });
      return;
    }
    spare--;
    const key = `${st.key}:stage2`;
    stagePlan.push({ st, bossRec: split.first, form: 1 });
    stagePlan.push({ st: { key, enemylist: [], background: st.background, scroll: st.scroll }, bossRec: split.second, form: 2 });
    splits.push({ stage: st.key, into: key, name: rec.name || `boss${s}`, second: bossBodyFrames(split.second)[0] || "?", hp: [split.first.hp, split.second.hp] });
  });
  const built = stagePlan.map(({ st, bossRec, form }, s) => {
    const width = Math.max(1, st.enemylist[0] ? st.enemylist[0].length : level.width || 8);
    const spawnRows = st.enemylist.slice().reverse();
    const waveRows = Array.isArray(st.waveRows) && st.waveRows.length === st.enemylist.length ? st.waveRows.slice().reverse() : null;
    const usage = /* @__PURE__ */ new Map();
    for (const row of spawnRows) for (const cell of row) if (cell && cell !== "00") usage.set(cell.slice(0, -1), (usage.get(cell.slice(0, -1)) || 0) + 1);
    const letters = [...usage.keys()].sort((a, b) => usage.get(b) - usage.get(a));
    const counts = PLUS_DEF_CLASSES.map(() => 0);
    const defs = /* @__PURE__ */ new Map();
    for (const letter of letters) {
      const rec = enemyData[`enemy${letter}`];
      if (!rec) {
        warn(`${st.key}: grid names enemy${letter} but enemyData has no such record \u2014 cells left empty`);
        continue;
      }
      const frames = (Array.isArray(rec.texture) ? rec.texture : []).map(lookup).filter(Boolean);
      if (!frames.length) warn(`${st.key}: enemy${letter} (${rec.name || "?"}) has no art in the atlas \u2014 placed invisible`);
      const maxW = frames.reduce((a, f) => Math.max(a, f.w), 16);
      const maxH = frames.reduce((a, f) => Math.max(a, f.h), 16);
      if (frames.length && (maxW > 64 || maxH > 64)) {
        warn(`${st.key}: enemy${letter} (${rec.name || "?"}) is ${maxW}x${maxH}; zako art tops out at 64x64 \u2014 downscaled`);
      }
      const { klass, shrunk } = pickEnemyClass(PLUS_DEF_CLASSES, counts, maxW, maxH);
      if (klass < 0) {
        warn(`${st.key}: no free definition for enemy${letter} (${rec.name || "?"}) \u2014 a stage holds 16 + 16 + 16 + 8 + 4 \u2014 cells left empty`);
        continue;
      }
      const c = PLUS_DEF_CLASSES[klass];
      const want = PLUS_DEF_CLASSES[plusClassFor(maxW, maxH)];
      const id = counts[klass]++;
      const hits = rec.hp === "infinity" ? 2e3 / PLUS_SHOT_DAMAGE : Math.max(1, Number(rec.hp) || 1);
      const interval = Number(rec.interval);
      const fires = Number.isFinite(interval) && interval > 0;
      const speed = (Number.isFinite(rec.speed) ? rec.speed : 1) * RUNTIME_TO_PLUS_SPEED;
      const bytes = encodePlusEnemy({
        movement: PLUS_MOVE_STRAIGHT_BASE + nearestIndex3(PLUS_STRAIGHT_SPEEDS, speed),
        shotPattern: fires ? 1 : 0,
        fireRate: fires ? clamp3(Math.round(7 - Math.min(6, interval / 30)), 1, 7) : 0,
        hpIndex: nearestIndex3(PLUS_ENEMY_HP, hits * PLUS_SHOT_DAMAGE),
        scoreIndex: nearestIndex3(PLUS_ENEMY_SCORE, Number(rec.score) || 100),
        animIndex: Number.isFinite(rec.frameRate) && rec.frameRate > 0 ? nearestIndex3(PLUS_ANIM_INTERVALS, 60 / rec.frameRate) : 3
      });
      const framePlans = spreadFrames(frames, c.frames).map((f, i) => plan(plusPaletteRow("enemy", s), f, c.w, c.h, `${st.key} enemy${letter} ${i}`));
      defs.set(letter, { klass, id, index: c.base + id, bytes, frames: framePlans, name: rec.name || `enemy${letter}`, shrunk, why: `the stage's ${want.w}x${want.h} definitions are all taken \u2014 enemy${letter} (${rec.name || "?"})` });
    }
    const story = opts.storyPicks ? opts.storyPicks.get(s) || null : null;
    const storyShift = story ? PLUS_STORY_TOP_ROW + 1 + PLUS_STORY_LEAD_ROWS : 0;
    const bands = /* @__PURE__ */ new Map();
    let placed = 0, dropped = 0, lastRow = PLUS_FIRST_SPAWN_ROW + storyShift;
    spawnRows.forEach((row, k) => {
      const band = clamp3(
        (waveRows ? Math.round(waveRows[k]) : PLUS_FIRST_SPAWN_ROW + k * PLUS_ROW_STEP) + storyShift,
        0,
        PLUS_MAX_SPAWN_ROW
      );
      row.forEach((cell, col) => {
        if (!cell || cell === "00") return;
        const def = defs.get(cell.slice(0, -1));
        if (!def) return;
        const c = PLUS_DEF_CLASSES[def.klass];
        const column = mapPlusColumn(col, width, c.w / 16);
        if (!bands.has(band)) bands.set(band, new Uint8Array(PLUS_APPEAR_RECORD_SIZE));
        const rec = bands.get(band);
        let at = null;
        for (const dc of [0, 1, -1, 2, -2]) {
          const cc = column + dc;
          if (cc < 0 || cc >= PLUS_SPAWN_COLUMNS || rec[cc]) continue;
          at = cc;
          break;
        }
        if (at === null) {
          dropped++;
          return;
        }
        rec[at] = 128 | c.nibble << 4 | def.id & 15;
        placed++;
        lastRow = Math.max(lastRow, band);
      });
    });
    if (dropped) warn(`${st.key}: ${dropped} placement${dropped === 1 ? "" : "s"} overlapped another in the same band and ${dropped === 1 ? "was" : "were"} left out`);
    let boss = null;
    if (bossRec) {
      const names = bossRec.anim && Array.isArray(bossRec.anim.idle) ? [...bossRec.anim.idle, ...Array.isArray(bossRec.anim.attack) ? bossRec.anim.attack : []] : Array.isArray(bossRec.texture) ? bossRec.texture : [];
      const frames = names.map(lookup).filter(Boolean);
      if (!frames.length) warn(`${st.key}: boss (${bossRec.name || "?"}) has no art in the atlas \u2014 its picture is unpainted`);
      const first = frames[0] || { w: 128, h: 64 };
      const vertical = first.h > first.w;
      const box = vertical ? PLUS_BOSS_ART.vertical : PLUS_BOSS_ART.horizontal;
      if (frames.length && (first.w > box.w || first.h > box.h)) {
        warn(`${st.key}: boss (${bossRec.name || "?"}) is ${first.w}x${first.h}; a Dezaemon+ boss is ${box.w}x${box.h} \u2014 downscaled`);
      }
      const picture = frames.length ? plan(plusPaletteRow("boss", s), first, box.w, box.h, `${st.key} boss`) : null;
      const hits = bossRec.hp === "infinity" ? PLUS_BOSS_HP[7] / PLUS_SHOT_DAMAGE : Math.max(1, Number(bossRec.hp) || 100);
      const record = encodePlusBoss({
        ...PLUS_BOSS_BEHAVIOUR,
        vertical,
        hpIndex: nearestIndex3(PLUS_BOSS_HP, hits * PLUS_SHOT_DAMAGE),
        scoreIndex: nearestIndex3(PLUS_BOSS_SCORE, Number(bossRec.score) || PLUS_BOSS_SCORE[1])
      });
      const band = Math.min(
        PLUS_SCROLL_BANDS - 8,
        Math.max(lastRow + PLUS_BOSS_ROW_GAP, story ? PLUS_STORY_MIN_BOSS_ROW : 0)
      );
      if (!bands.has(band)) bands.set(band, new Uint8Array(PLUS_APPEAR_RECORD_SIZE));
      bands.get(band)[PLUS_BOSS_COLUMN] = 128 | PLUS_APPEAR_BOSS_NIBBLE << 4;
      boss = { name: bossRec.name || `boss${s}`, band, picture, vertical, record, frameCount: frames.length, hits };
      if (form) boss.form = form;
      lastRow = Math.max(lastRow, band);
    }
    const scenery = [];
    const cellsList = Array.isArray(level.backgroundCells) ? level.backgroundCells : null;
    if (st.background && st.background.tiles && cellsList) {
      try {
        const bytes = b64ToBytes3(st.background.tiles);
        const cols = st.background.cols || 14;
        const tiles = new Uint16Array(bytes.length >> 1);
        for (let i = 0; i < tiles.length; i++) tiles[i] = bytes[i * 2] << 8 | bytes[i * 2 + 1];
        const rowsIn = Math.floor(tiles.length / cols);
        if (rowsIn > PLUS_MAP_ROWS) warn(`${st.key}: the scenery is ${rowsIn} rows and the map holds ${PLUS_MAP_ROWS}; the first ${PLUS_MAP_ROWS} loop`);
        const firstCol = Math.max(0, Math.floor((cols - 14) / 2));
        const planByOrdinal = /* @__PURE__ */ new Map();
        for (let r = 0; r < Math.min(rowsIn, PLUS_MAP_ROWS); r++) {
          for (let c = 0; c < 14; c++) {
            const w = tiles[r * cols + firstCol + c];
            if (w === 65535 || firstCol + c >= cols) continue;
            const ordinal = w & 1023;
            if (!planByOrdinal.has(ordinal)) {
              const f = lookup(cellsList[ordinal]);
              planByOrdinal.set(ordinal, f ? plan(plusPaletteRow("map", s), f, 16, 16, `${st.key} scenery`) : null);
            }
            const p = planByOrdinal.get(ordinal);
            if (!p) continue;
            scenery.push({ row: r, col: c + 1, plan: p, hflip: (w & 32768) !== 0, vflip: (w & 16384) !== 0 });
          }
        }
      } catch (e) {
        warn(`${st.key}: could not read the background grid (${e.message}) \u2014 scenery skipped`);
      }
    }
    const storyPlan = story && !scenery.length ? { ...plan(plusPaletteRow("map", s), story, story.w, story.h, `${st.key} story`), label: story.label } : null;
    return { key: st.key, defs, bands, boss, scenery, storyPlan, placed, dropped, lastRow };
  });
  for (const r of rows) if (r.frames.length) r.build();
  const indexedOf = (p) => rows[p.row].index(p.fitted);
  const bankTiles = (p, flippable = false) => {
    const tiles = indexedTiles(indexedOf(p), p.w, p.h);
    try {
      return tiles.map((t) => flippable ? bank.addFlippable(t) : bank.add(t));
    } catch (e) {
      if (!(e instanceof PlusBankFullError)) throw e;
      const group = p.what.replace(/ \d+$/, "");
      if (!fullWarned.has(group)) {
        fullWarned.add(group);
        warn(`graphics bank full (${PLUS_TILE_COUNT} tiles): ${group} art left unpainted`);
      }
      return tiles.map(() => null);
    }
  };
  const factorySheet = plusFactorySheet();
  const ship = layoutShip(
    shipPlans.map((p) => bankTiles(p, true)),
    PLUS_FACTORY_SHIP_TILES.map((t) => t < 0 ? null : bank.add(factorySheet[t]))
  );
  const block = new Uint8Array(PLUS_BLOCK_SIZE);
  const stageReports = built.map((b, s) => {
    const base = PLUS_STAGES_OFFSET + s * PLUS_STAGE_SIZE;
    const piece = (name2) => block.subarray(base + PLUS_STAGE_PIECE[name2].offset, base + PLUS_STAGE_PIECE[name2].end);
    const map = piece("map");
    const mapGroup = piece("mapGroup");
    for (let i = 0; i < mapGroup.length; i += 2) putU16le5(mapGroup, i, PLUS_EMPTY_TILE);
    const groupOfTile = /* @__PURE__ */ new Map();
    let groups = 1, chips = 0, sceneryDropped = 0;
    const tileOfPlan = /* @__PURE__ */ new Map();
    for (const sc of b.scenery) {
      if (!tileOfPlan.has(sc.plan)) tileOfPlan.set(sc.plan, bankTiles(sc.plan, true)[0]);
      const t = tileOfPlan.get(sc.plan);
      if (!t) continue;
      let g = groupOfTile.get(t.tile);
      if (g === void 0) {
        if (groups >= 128) {
          sceneryDropped++;
          continue;
        }
        g = groups++;
        groupOfTile.set(t.tile, g);
        putU16le5(mapGroup, g * 2, plusTileWord(t.tile));
      }
      putPlusMapCell(map, sc.row, sc.col, g, sc.hflip !== t.hflip, sc.vflip !== t.vflip);
      chips++;
    }
    if (sceneryDropped) warn(`${b.key}: the scenery needs more than 127 distinct tiles; ${sceneryDropped} chips left blank`);
    let story = null;
    if (b.storyPlan) {
      const tiles = bankTiles(b.storyPlan, true);
      const cols = b.storyPlan.w / CG_CELL, storyRows = b.storyPlan.h / CG_CELL;
      let painted = 0;
      tiles.forEach((t, i) => {
        if (!t) return;
        let g = groupOfTile.get(t.tile);
        if (g === void 0) {
          if (groups >= 128) return;
          g = groups++;
          groupOfTile.set(t.tile, g);
          putU16le5(mapGroup, g * 2, plusTileWord(t.tile));
        }
        const cy = Math.floor(i / cols), cx = i % cols;
        putPlusMapCell(map, PLUS_STORY_TOP_ROW - cy, 1 + cx, g, t.hflip, t.vflip);
        painted++;
      });
      story = { size: b.storyPlan.label, rows: storyRows, chips: painted, top: PLUS_STORY_TOP_ROW };
    }
    const scroll = piece("scroll");
    const opening = story ? Math.ceil((PLUS_STORY_TOP_ROW + 1) / 4) : 0;
    for (let i = 0; i < 256; i++) scroll[i] = i < 32 || !opening ? i % 32 : opening + (i - opening) % (32 - opening);
    scroll.fill(PLUS_SCROLL_EFFECT_DEFAULT, 256, 512);
    if (opening) scroll.fill(PLUS_STORY_SCROLL_EFFECT, 256, 256 + opening);
    const bossTiles = b.boss && b.boss.picture ? bankTiles(b.boss.picture, true) : [];
    const sheetDefs = [...b.defs.values()].sort((x, y) => x.shrunk - y.shrunk);
    const sheet = layoutEnemySheet(sheetDefs.map((d) => ({ ...d, tiles: d.frames.map((p) => bankTiles(p, true)) })));
    if (sheet.dropped) warn(`${b.key}: the enemies need more than 63 distinct tiles; ${sheet.dropped} cells left blank`);
    const leftOut = new Set(sheet.leftOut.map((d) => d.index));
    const leftOutSpawns = new Set(sheet.leftOut.map((d) => 128 | PLUS_DEF_CLASSES[d.klass].nibble << 4 | d.id & 15));
    for (const d of sheetDefs.filter((x) => x.shrunk)) {
      const c = PLUS_DEF_CLASSES[d.klass];
      warn(`${b.key}: ${d.why} ${leftOut.has(d.index) ? `left out: the enemy sheet's 63 tiles cannot hold it even ${c.w}x${c.h}` : sheet.oneFrame.some((x) => x.index === d.index) ? `drawn ${c.w}x${c.h}, its first frame only (the enemy sheet is near its 63 tiles)` : `drawn ${c.w}x${c.h}`}`);
    }
    const enemyGroup = piece("enemyGroup");
    for (let i = 0; i < 64; i++) putU16le5(enemyGroup, i * 2, sheet.enemyGroup[i]);
    piece("spriteLayout").set(sheet.spriteLayout);
    const appear = piece("appear");
    appear.fill(PLUS_APPEAR_END_MARK, PLUS_APPEAR_RECORD_SIZE, 2 * PLUS_APPEAR_RECORD_SIZE);
    let next = 2;
    const rowTable = appear.subarray(PLUS_APPEAR_RECORDS * PLUS_APPEAR_RECORD_SIZE);
    let bandsDropped = 0, unplaced = 0;
    for (const [band, spawns] of [...b.bands.entries()].sort((x, y) => x[0] - y[0])) {
      const rec = Uint8Array.from(spawns);
      for (let i = 0; i < rec.length; i++) {
        if (leftOutSpawns.has(rec[i])) {
          rec[i] = 0;
          unplaced++;
        }
      }
      if (rec.every((v) => !v)) continue;
      if (next >= PLUS_APPEAR_RECORDS) {
        bandsDropped++;
        continue;
      }
      appear.set(rec, next * PLUS_APPEAR_RECORD_SIZE);
      rowTable[band] = next++;
    }
    if (bandsDropped) warn(`${b.key}: more than 254 bands spawn something; ${bandsDropped} left empty`);
    const enemyData2 = piece("enemyData");
    const config = piece("config");
    config.fill(PLUS_STAGE_CONFIG_DEFAULT);
    for (const d of b.defs.values()) if (!leftOut.has(d.index)) enemyData2.set(d.bytes, d.index * PLUS_ENEMY_SIZE);
    const bossGroup = piece("bossGroup");
    let bossPainted = 0;
    if (b.boss) {
      enemyData2.set(b.boss.record, PLUS_BOSS_OFFSET);
      const words = layoutBoss(bossTiles, b.boss.vertical);
      for (let i = 0; i < words.length; i++) putU16le5(bossGroup, i * 2, words[i]);
      bossPainted = words.filter((w) => w !== PLUS_EMPTY_TILE).length;
    } else {
      for (let i = 0; i < bossGroup.length; i += 2) putU16le5(bossGroup, i, PLUS_EMPTY_TILE);
    }
    return {
      key: b.key,
      placements: b.placed - unplaced,
      dropped: b.dropped,
      definitions: [...b.defs.values()].filter((d) => !leftOut.has(d.index)).map((d) => ({ name: d.name, klass: d.klass, id: d.id, index: d.index })),
      boss: b.boss ? { name: b.boss.name, band: b.boss.band, frames: b.boss.frameCount, vertical: b.boss.vertical, tiles: bossPainted, hits: b.boss.hits, ...b.boss.form ? { form: b.boss.form } : {} } : null,
      chips,
      groups: groups - 1,
      enemyTiles: sheet.painted,
      enemyEntries: sheet.entries,
      story
    };
  });
  for (let s = built.length; s < PLUS_STAGES; s++) {
    const base = PLUS_STAGES_OFFSET + s * PLUS_STAGE_SIZE;
    for (const name2 of ["mapGroup", "enemyGroup", "bossGroup"]) {
      const p = block.subarray(base + PLUS_STAGE_PIECE[name2].offset, base + PLUS_STAGE_PIECE[name2].end);
      for (let i = 0; i < p.length; i += 2) putU16le5(p, i, PLUS_EMPTY_TILE);
    }
    block.subarray(base + PLUS_STAGE_PIECE.appear.offset + PLUS_APPEAR_RECORD_SIZE, base + PLUS_STAGE_PIECE.appear.offset + 2 * PLUS_APPEAR_RECORD_SIZE).fill(PLUS_APPEAR_END_MARK);
    block.subarray(base + PLUS_STAGE_PIECE.scroll.offset + 256, base + PLUS_STAGE_PIECE.scroll.end).fill(PLUS_SCROLL_EFFECT_DEFAULT);
    block.subarray(base + PLUS_STAGE_PIECE.config.offset, base + PLUS_STAGE_PIECE.config.end).fill(PLUS_STAGE_CONFIG_DEFAULT);
  }
  const global = (name2) => {
    const p = PLUS_GLOBAL_LAYOUT.find((x) => x.name === name2);
    return block.subarray(PLUS_GLOBAL_OFFSET + p.offset, PLUS_GLOBAL_OFFSET + p.end);
  };
  global("titleType").set(PLUS_TITLE_TYPE);
  const titleGroup = global("titleGroup");
  let titlePainted = 0;
  {
    const words = layoutTitle(titlePlan ? bankTiles(titlePlan, true) : []);
    for (let i = 0; i < 32; i++) putU16le5(titleGroup, i * 2, words[i]);
    titlePainted = words.filter((w) => w !== PLUS_EMPTY_TILE).length;
  }
  const ending = global("endingGroup");
  for (let i = 0; i < ending.length; i += 2) putU16le5(ending, i, PLUS_EMPTY_TILE);
  const shipGroup = global("shipGroup");
  for (let i = 0; i < ship.shipGroup.length; i++) putU16le5(shipGroup, i * 2, ship.shipGroup[i]);
  global("shipOdr").set(ship.shipOdr);
  global("itemTable").set(PLUS_ITEM_TABLE);
  global("gameSettings").set([PLUS_SCORE_BONUS_INDEX, PLUS_CHARGE_TIME, built.length - 1]);
  global("bgmAssignment").set(PLUS_BGM_ASSIGNMENT);
  block.fill(0, PLUS_SOUND_OFFSET, PLUS_SOUND_OFFSET + PLUS_SONG_COUNT * PLUS_SONG_SIZE);
  for (let t = 0; t < PLUS_HISCORE_TABLES; t++) {
    for (let i = 0; i < PLUS_HISCORE_COUNT; i++) {
      const at = PLUS_HISCORE_OFFSET + t * PLUS_HISCORE_TABLE_BYTES + i * PLUS_HISCORE_SIZE;
      putU32le4(block, at, (PLUS_HISCORE_COUNT - i) * 100);
      block.fill(PLUS_FACTORY_NAME, at + 8, at + 16);
    }
  }
  block.set(PLUS_FACTORY_SETTINGS, PLUS_SETTINGS_OFFSET);
  block.set(bank.toBitmap(), PLUS_GRAPHICS_OFFSET);
  rows.forEach((r, i) => {
    const words = r.words || PLUS_FACTORY_ROWS[i] || new Uint16Array(16);
    for (let c = 0; c < 16; c++) putU16le5(block, PLUS_PALETTE_OFFSET + i * PLUS_PALETTE_ROW_BYTES + c * 2, words[c]);
  });
  block[0] = 83;
  block[1] = 67;
  block[2] = 17;
  block[3] = PLUS_BLOCK_SIZE / 8192;
  block.set(PLUS_TITLE_BYTES, TITLE_OFFSET);
  const icon = encodeKidsIcon(shipFrames[0] || defaultKidsIcon());
  for (let i = 0; i < 16; i++) putU16le5(block, CLUT_OFFSET + i * 2, icon.clut[i] ?? 0);
  block.set(icon.pixels.subarray(0, 128), TITLE_FRAME_SIZE);
  const name = String(opts.name ?? level.name ?? "game").trim() || "game";
  return {
    block,
    warnings,
    report: {
      name,
      stages: stageReports,
      ship: shipSource,
      shipTiles: ship.painted,
      title: titlePainted ? "uploaded" : "none",
      rows: rows.map((r) => ({ row: r.row, colors: r.count || 0 })).filter((r) => r.colors),
      tiles: { used: bank.used, shared: bank.shared, free: bank.free },
      // How the save's bosses carry their second stages (boss-stage2.js).
      transform: splits.length ? `approximated: two chained bosses across a stage break (${splits.map((x) => `${x.stage} ${x.name}, then ${x.into} its second form ${x.second}`).join("; ")}); a Dezaemon+ save has no bullet art, so the guns keep the sample's` : "none",
      splits
    }
  };
}
function putPlusMapCell(map, row, col, group, hflip, vflip) {
  const half = PLUS_MAP_HALVES[col < 8 ? 0 : 1];
  const k = col < 8 ? col : col - 8;
  const at = row * PLUS_MAP_ROW_BYTES;
  map[at + half.chips[k]] = group | (hflip ? 128 : 0);
  if (vflip) map[at + half.flags] |= 1 << 7 - k;
}
function buildPlusWithStory(level, art2, opts) {
  const dry = buildPlusGameFromLevel(level, art2, { ...opts, storyBackdrops: null, storyPicks: null });
  const notes = [];
  const candidates = [];
  for (const sb of opts.storyBackdrops) {
    const s = dry.report.stages.findIndex((st) => st.key === `stage${sb && sb.stage}`);
    if (s < 0) continue;
    const key = dry.report.stages[s].key;
    if (dry.report.stages[s].chips > 0) {
      notes.push(`${key}: keeps its own scenery \u2014 its story is not drawn`);
      continue;
    }
    const variants = [];
    for (const v of Array.isArray(sb.variants) ? sb.variants : []) {
      if (!v || v.w !== PLUS_STORY_W || !v.h || v.h % CG_CELL || !v.rgba) continue;
      if (v.h / CG_CELL > PLUS_STORY_TOP_ROW + 1) continue;
      const row = new PlusPaletteRow(0);
      row.consider(v);
      const tiles = indexedTiles(row.build().index(v), v.w, v.h);
      const probe = new PlusTileBank();
      for (const t of tiles) probe.addFlippable(t);
      if (probe.used > 127) continue;
      variants.push({ v, tiles: probe.used });
    }
    if (variants.length) candidates.push({ s, key, variants });
    else notes.push(`${key}: no size of its story fits a stage map (${PLUS_STORY_W} px wide, ${PLUS_STORY_TOP_ROW + 1} rows, 127 distinct tiles) \u2014 not drawn`);
  }
  const free = dry.report.tiles.free;
  const cost = (picks2) => picks2.reduce((n, p) => n + p.pick.tiles, 0);
  const pickAt = (k) => candidates.map((c) => ({ c, pick: c.variants[Math.min(k, c.variants.length - 1)] }));
  const sizes = Math.max(0, ...candidates.map((c) => c.variants.length));
  let picks = [];
  for (let k = 0; k < sizes && !picks.length; k++) {
    if (cost(pickAt(k)) <= free) picks = pickAt(k);
  }
  if (!picks.length && candidates.length) {
    for (const p of pickAt(sizes - 1)) {
      if (cost([...picks, p]) <= free) picks.push(p);
      else notes.push(`${p.c.key}: no tiles left in the save's graphics for its story \u2014 not drawn`);
    }
  }
  const built = buildPlusGameFromLevel(level, art2, {
    ...opts,
    storyBackdrops: null,
    storyPicks: new Map(picks.map(({ c, pick }) => [c.s, pick.v]))
  });
  built.warnings.push(...notes);
  return built;
}
function buildPlusBlock(block) {
  if (!(block instanceof Uint8Array) || block.length !== PLUS_BLOCK_SIZE) throw new Error(`a Dezaemon+ block is ${PLUS_BLOCK_SIZE} bytes`);
  const seal2 = sealPlusChecksums(block);
  const back = parsePlusSave(block, { filename: PLUS_PRODUCT });
  if (back.errors.length) throw new Error(`the block does not read back: ${back.errors.map((e) => e.message).join("; ")}`);
  if (!back.checksums || !back.checksums.ok) throw new Error("the block's group checksums do not verify after sealing");
  return { block, seal: seal2, parsed: back };
}
function plusCardFileName(name) {
  const clean = String(name || "game").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "game";
  return `Dezaemon Plus - ${clean}.mcr`;
}
function exportLevelToPlusCard(level, art2, options = {}) {
  const game = buildPlusGameFromLevel(level, art2, options);
  const { block, seal: seal2 } = buildPlusBlock(game.block);
  const card = buildMemoryCard([{ filename: PLUS_PRODUCT, data: block }]);
  return {
    card,
    block,
    fileName: plusCardFileName(game.report.name),
    name: game.report.name,
    warnings: game.warnings,
    report: { ...game.report, sealedGroups: seal2.groups ? seal2.groups.length : void 0, checksumBytes: seal2.bytes }
  };
}

// packages/shmup-engine/src/psx/plus-song.js
var PLUS_SONG_BARS = 16;
var PLUS_SONG_VOICES = 2;
var PLUS_SONG_STEPS = 16;
var PLUS_SONG_CELLS = PLUS_SONG_VOICES * PLUS_SONG_STEPS;
var PLUS_SONG_BAR_STRIDE = 68;
var PLUS_SONG_UNPACKED_SIZE = PLUS_SONG_BARS * PLUS_SONG_BAR_STRIDE + 4;
var PLUS_SONG_BITS = PLUS_SONG_BARS * (14 + PLUS_SONG_CELLS * 11) + 16;
var PLUS_SONG_PACKED_BYTES = PLUS_SONG_BITS / 8;
var PLUS_INSTRUMENT_PERM = Object.freeze([
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  16,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  7,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  31,
  24,
  28,
  27,
  25,
  29,
  26,
  30
]);
var PLUS_INSTRUMENT_UNPERM = Object.freeze((() => {
  const a = new Array(32);
  PLUS_INSTRUMENT_PERM.forEach((v, i) => a[v] = i);
  return a;
})());
var PLUS_INSTRUMENT_PROGRAMS = Object.freeze([
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  32,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  7,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  25,
  28,
  30,
  27,
  33,
  29,
  31,
  24
]);
var PLUS_VOICE_PROGRAM_BIAS = Object.freeze([1, 91]);
var PLUS_TEMPO_TABLE = Object.freeze([
  92,
  82,
  73,
  67,
  61,
  56,
  52,
  49,
  46,
  43,
  41,
  38,
  36,
  35,
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
  18,
  17,
  16
]);
var PLUS_TEMPO_TICKS_PER_FRAME = 4;
var PLUS_STEPS_PER_BEAT = 4;
var PLUS_FRAMES_PER_SECOND = 60;
var PLUS_BPM_NUMERATOR = 60 * PLUS_FRAMES_PER_SECOND * PLUS_TEMPO_TICKS_PER_FRAME / PLUS_STEPS_PER_BEAT;
var PLUS_VOLUME_TABLE = Object.freeze([0, 8, 16, 24, 32, 40, 48, 56]);
var PLUS_ACCOMP_ROM = Object.freeze({
  address: 2148486060,
  bytes: 92160,
  patternAStride: 10240,
  patternBStride: 2560,
  patternCStride: 512,
  trackStride: 64,
  stepStride: 4,
  halfStride: 2,
  shape: "9 patternA x 4 patternB x 5 patternC x 8 tracks x 16 steps x 2 half-steps x (instrument, note)"
});
var PLUS_ACCOMP_FOLD_LO = Object.freeze([56, 32, 44, 44, 15]);
var PLUS_ACCOMP_FOLD_MID = Object.freeze([81, 57, 69, 69, 255]);
var PLUS_ACCOMP_FOLD_HI = Object.freeze([92, 68, 80, 80, 255]);

// packages/shmup-engine/src/psx/index.js
var CONFIDENCES = Object.freeze(["confirmed", "likely", "open"]);
var PSX_GAMES = Object.freeze({
  kids: Object.freeze({ id: "kids", product: KIDS_PRODUCT, title: "Dezaemon Kids!", code: "SLPS-01503", titlePrefix: KIDS_TITLE_PREFIX }),
  plus: Object.freeze({ id: "plus", product: PLUS_PRODUCT, title: "Dezaemon+", code: "SLPS-00335", titlePrefix: PLUS_TITLE_PREFIX })
});
function identifyGame(block, filename = "") {
  if (filename === KIDS_PRODUCT) return "kids";
  if (filename === PLUS_PRODUCT) return "plus";
  if (block.length < 256) return null;
  const header = parseSaveHeader(block);
  if (!header.magicOk) return null;
  if (header.title.startsWith(KIDS_TITLE_PREFIX)) return "kids";
  if (header.title.startsWith(PLUS_TITLE_PREFIX)) return "plus";
  if (isKidsBlock(block)) return "kids";
  return null;
}
function parsePsxSav(bytes) {
  const located = locateSaves(bytes);
  const result = { container: located.container, card: located.card, saves: [], others: [], errors: [] };
  if (located.container === "unknown") {
    result.errors.push({ block: "container", message: `${bytes.length} bytes: not a memory card image, .gme, .mcs, .psv or "SC" save block` });
    return result;
  }
  for (const save of located.saves) {
    const game = identifyGame(save.data, save.filename);
    if (!game) {
      result.others.push({ filename: save.filename, size: save.data.length, deleted: save.deleted });
      continue;
    }
    const parsed = game === "kids" ? parseKidsSave(save.data, { filename: save.filename }) : parsePlusSave(save.data, { filename: save.filename });
    parsed.deleted = save.deleted;
    result.saves.push(parsed);
  }
  return result;
}

// packages/shmup-engine/src/n64/geometry.js
var SECTORS_PER_BLOCK = 85;
var BLOCKS_PER_TRACK = 2;
var ZONE_SECTOR_SIZES = Object.freeze([232, 216, 208, 192, 176, 160, 144, 128, 112]);
var PZONE_SECTOR_SIZES = Object.freeze([
  232,
  216,
  208,
  192,
  176,
  160,
  144,
  128,
  216,
  208,
  192,
  176,
  160,
  144,
  128,
  112
]);
var PZONE_TRACKS = Object.freeze([
  158,
  158,
  149,
  149,
  149,
  149,
  149,
  114,
  158,
  158,
  149,
  149,
  149,
  149,
  149,
  114
]);
var SPARE_TRACKS_PER_ZONE = 12;
var DISK_TYPE_ZONES = Object.freeze([
  Object.freeze([0, 1, 2, 9, 8, 3, 4, 5, 6, 7, 15, 14, 13, 12, 11, 10]),
  Object.freeze([0, 1, 2, 3, 10, 9, 8, 4, 5, 6, 7, 15, 14, 13, 12, 11]),
  Object.freeze([0, 1, 2, 3, 4, 11, 10, 9, 8, 5, 6, 7, 15, 14, 13, 12]),
  Object.freeze([0, 1, 2, 3, 4, 5, 12, 11, 10, 9, 8, 6, 7, 15, 14, 13]),
  Object.freeze([0, 1, 2, 3, 4, 5, 6, 13, 12, 11, 10, 9, 8, 7, 15, 14]),
  Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 14, 13, 12, 11, 10, 9, 8, 15]),
  Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 15, 14, 13, 12, 11, 10, 9, 8])
]);
var DISK_TYPE_COUNT = DISK_TYPE_ZONES.length;
var DEZAEMON_DISK_TYPE = 0;
var TOTAL_LBAS = 4316;
var SYSTEM_AREA_LBAS = 24;
var USER_LBA_COUNT = TOTAL_LBAS - SYSTEM_AREA_LBAS;
var MAX_USER_LBA = USER_LBA_COUNT - 1;
var SYSTEM_AREA_BYTES = SYSTEM_AREA_LBAS * SECTORS_PER_BLOCK * 232;
var DDD_IMAGE_BYTES = 64458560;
var NDD_IMAGE_BYTES = DDD_IMAGE_BYTES + SYSTEM_AREA_BYTES;
function pzoneBlockSize(pzone) {
  return PZONE_SECTOR_SIZES[pzone] * SECTORS_PER_BLOCK;
}
function pzoneBlocks(pzone) {
  return (PZONE_TRACKS[pzone] - SPARE_TRACKS_PER_ZONE) * BLOCKS_PER_TRACK;
}
function checkType(type) {
  if (!Number.isInteger(type) || type < 0 || type >= DISK_TYPE_COUNT) {
    throw new Error(`disk type ${type} is not one of 0..${DISK_TYPE_COUNT - 1}`);
  }
}
function romZoneCount(type) {
  checkType(type);
  return Math.min(16, 5 + 2 * type);
}
var tables = /* @__PURE__ */ new Map();
function zoneTable(type = DEZAEMON_DISK_TYPE) {
  checkType(type);
  if (tables.has(type)) return tables.get(type);
  const rom = romZoneCount(type);
  const zones = [];
  let lba = 0;
  let offset = 0;
  DISK_TYPE_ZONES[type].forEach((pzone, vzone) => {
    const blockSize2 = pzoneBlockSize(pzone);
    const blockCount = pzoneBlocks(pzone) - (vzone === 0 ? SYSTEM_AREA_LBAS : 0);
    zones.push(Object.freeze({
      vzone,
      pzone,
      sectorSize: PZONE_SECTOR_SIZES[pzone],
      blockSize: blockSize2,
      firstLba: lba,
      blockCount,
      offset,
      rom: vzone < rom
    }));
    lba += blockCount;
    offset += blockCount * blockSize2;
  });
  const table = Object.freeze(zones);
  tables.set(type, table);
  return table;
}
function zoneOf(lba, type = DEZAEMON_DISK_TYPE) {
  if (!Number.isInteger(lba) || lba < 0 || lba > MAX_USER_LBA) return null;
  for (const z of zoneTable(type)) {
    if (lba < z.firstLba + z.blockCount) return z;
  }
  return null;
}
function blockSize(lba, type = DEZAEMON_DISK_TYPE) {
  const z = zoneOf(lba, type);
  return z ? z.blockSize : null;
}
function lbaToOffset(lba, type = DEZAEMON_DISK_TYPE) {
  if (!Number.isInteger(lba) || lba < 0 || lba > USER_LBA_COUNT) return null;
  if (lba === USER_LBA_COUNT) return DDD_IMAGE_BYTES;
  const z = zoneOf(lba, type);
  return z.offset + (lba - z.firstLba) * z.blockSize;
}
function extentBytes(lba, count, type = DEZAEMON_DISK_TYPE) {
  if (!Number.isInteger(count) || count < 0) return null;
  const from = lbaToOffset(lba, type);
  const to = lbaToOffset(lba + count, type);
  if (from === null || to === null) return null;
  return to - from;
}
function blocksFor(lba, bytes, type = DEZAEMON_DISK_TYPE) {
  if (!Number.isInteger(bytes) || bytes < 0 || lbaToOffset(lba, type) === null) return null;
  let count = 0;
  let left = bytes;
  while (left > 0) {
    const size = blockSize(lba + count, type);
    if (size === null) return null;
    left -= size;
    count++;
  }
  return count;
}
function romEndLba(type = DEZAEMON_DISK_TYPE) {
  const zones = zoneTable(type);
  const last = zones[romZoneCount(type) - 1];
  return last.firstLba + last.blockCount - 1;
}
function ramStartLba(type = DEZAEMON_DISK_TYPE) {
  const end = romEndLba(type);
  return end >= MAX_USER_LBA ? null : end + 1;
}
function ramEndLba(type = DEZAEMON_DISK_TYPE) {
  return ramStartLba(type) === null ? null : MAX_USER_LBA;
}
function isDddSize(size) {
  return size === DDD_IMAGE_BYTES;
}
function isNddSize(size) {
  return size === NDD_IMAGE_BYTES;
}
function userArea(image) {
  if (isNddSize(image.length)) return image.subarray(SYSTEM_AREA_BYTES);
  if (isDddSize(image.length)) return image;
  throw new Error(`a 64DD image is ${DDD_IMAGE_BYTES} (.ddd) or ${NDD_IMAGE_BYTES} (.ndd) bytes; this one is ${image.length}`);
}
function systemAreaOf(image) {
  if (isNddSize(image.length)) return image.subarray(0, SYSTEM_AREA_BYTES);
  if (isDddSize(image.length)) return null;
  throw new Error(`a 64DD image is ${DDD_IMAGE_BYTES} (.ddd) or ${NDD_IMAGE_BYTES} (.ndd) bytes; this one is ${image.length}`);
}
function nddFromDdd(image, systemArea) {
  if (!(systemArea instanceof Uint8Array) || systemArea.length !== SYSTEM_AREA_BYTES) {
    throw new Error(`a system area is ${SYSTEM_AREA_BYTES} bytes`);
  }
  const user = userArea(image);
  const out = new Uint8Array(NDD_IMAGE_BYTES);
  out.set(systemArea, 0);
  out.set(user, SYSTEM_AREA_BYTES);
  return out;
}

// packages/shmup-engine/src/n64/directory.js
var DIRECTORY_OFFSET2 = 25996554;
var DIRECTORY_SLOTS = 834;
var NAMES = DIRECTORY_OFFSET2;
var START_LBA = NAMES + DIRECTORY_SLOTS * 11;
var BLOCK_COUNT2 = START_LBA + DIRECTORY_SLOTS * 2;
var RESERVED = BLOCK_COUNT2 + DIRECTORY_SLOTS * 2;
var STORED_SIZE = RESERVED + DIRECTORY_SLOTS * 2;
var DIRECTORY_END = STORED_SIZE + DIRECTORY_SLOTS * 4;
var DIRECTORY_COPIES = Object.freeze([0, 34680, 83640]);
var DIRECTORY_LBA = 1417;
var DIRECTORY_IN_BLOCK_OFFSET = 834;
var DIRECTORY_COPY_LBAS = Object.freeze([1417, 1419, 1422]);
var SLOT_BYTES = 21;
var DIRECTORY_BYTES = DIRECTORY_SLOTS * SLOT_BYTES;
var FIRST_FILE_LBA = 9;
var NAME_CHARS = 8;
var EXT_CHARS = 3;
var GLOBAL_EXTS = Object.freeze(["GAM", "CGR", "CMD", "CBL", "ULB", "MUS"]);
var STAGES = Object.freeze([0, 1, 2, 3, 4, 5, 6, 8]);
var STAGE_EXTS = Object.freeze(["BL", "MD", "GR"]);
var PROJECT_FILE_COUNT = GLOBAL_EXTS.length + STAGES.length * STAGE_EXTS.length;
var DOCUMENTED_SIZES = Object.freeze({
  GAM: 1369,
  CGR: 163840,
  CMD: 62120,
  CBL: 2484,
  ULB: 57600,
  MUS: 274032,
  BL: 35639,
  GR: 1064960,
  MD: 403780
});
function u162(bytes, at) {
  return bytes[at] << 8 | bytes[at + 1];
}
function u32(bytes, at) {
  return (bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3]) >>> 0;
}
function sizeKey(ext) {
  return /^[0-9]/.test(ext) ? ext.slice(1) : ext;
}
function readDirectory(bytes) {
  if (bytes.length < DIRECTORY_END) throw new Error(`image is ${bytes.length} bytes, too short for the directory at 0x${DIRECTORY_OFFSET2.toString(16)}`);
  const entries = [];
  for (let slot = 0; slot < DIRECTORY_SLOTS; slot++) {
    const at = NAMES + slot * 11;
    let raw = "";
    let printable = true;
    for (let i = 0; i < 11; i++) {
      const c = bytes[at + i];
      if (c < 32 || c > 126) {
        printable = false;
        break;
      }
      raw += String.fromCharCode(c);
    }
    if (!printable || raw.trim() === "") break;
    const ext = raw.slice(8);
    const startLba = u162(bytes, START_LBA + slot * 2);
    const blockCount = u162(bytes, BLOCK_COUNT2 + slot * 2);
    const storedSize = u32(bytes, STORED_SIZE + slot * 4);
    const key = sizeKey(ext);
    entries.push(Object.freeze({
      slot,
      name: raw.slice(0, 8).trimEnd(),
      ext,
      stage: /^[0-9]/.test(ext) ? Number(ext[0]) : null,
      startLba,
      blockCount,
      storedSize,
      offset: lbaToOffset(startLba),
      capacity: extentBytes(startLba, blockCount),
      documentedSize: key in DOCUMENTED_SIZES ? DOCUMENTED_SIZES[key] : null
    }));
  }
  return entries;
}
function checkDirectory(entries) {
  const contiguous = entries.every((e, i) => i === 0 || entries[i - 1].startLba + entries[i - 1].blockCount === e.startLba);
  const blocksFit = entries.every((e) => {
    const bs = blockSize(e.startLba);
    return bs !== null && Math.ceil(e.storedSize / bs) === e.blockCount;
  });
  const withinCapacity = entries.every((e) => e.capacity !== null && e.storedSize <= e.capacity);
  const last = entries[entries.length - 1];
  return {
    contiguous,
    blocksFit,
    withinCapacity,
    end: last && last.offset !== null ? last.offset + last.storedSize : null
  };
}
function projectExts(stages = STAGES) {
  return [...GLOBAL_EXTS, ...stages.flatMap((s) => STAGE_EXTS.map((e) => `${s}${e}`))];
}
function extOrder(ext) {
  const i = projectExts().indexOf(String(ext).toUpperCase());
  return i < 0 ? PROJECT_FILE_COUNT : i;
}
function normalizeProjectName(name) {
  const clean = String(name ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, NAME_CHARS);
  if (!clean) throw new Error(`"${name}" leaves no letters or digits for a project name`);
  return clean;
}
function directoryOffsets(type = DEZAEMON_DISK_TYPE) {
  return DIRECTORY_COPY_LBAS.map((lba) => lbaToOffset(lba, type) + DIRECTORY_IN_BLOCK_OFFSET);
}
function encodeSlotName(name, ext) {
  const n = String(name);
  const e = String(ext);
  if (n.length < 1 || n.length > NAME_CHARS) throw new Error(`a project name is 1..${NAME_CHARS} characters; "${n}" is not`);
  if (e.length !== EXT_CHARS) throw new Error(`an extension is ${EXT_CHARS} characters; "${e}" is not`);
  const out = new Uint8Array(NAME_CHARS + EXT_CHARS);
  const label = n.padEnd(NAME_CHARS) + e;
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i);
    if (c < 33 && i < n.length) throw new Error(`"${n}" has a blank in its name`);
    if (c < 32 || c > 126) throw new Error(`"${label[i]}" is not printable ASCII; a directory name is`);
    out[i] = c;
  }
  return out;
}
function encodeDirectory(entries, { slots = DIRECTORY_SLOTS } = {}) {
  if (entries.length > slots) throw new Error(`the directory holds ${slots} files; ${entries.length} were given`);
  const out = new Uint8Array(slots * SLOT_BYTES);
  const names = 0;
  const startLba = names + slots * 11;
  const blockCount = startLba + slots * 2;
  const reserved = blockCount + slots * 2;
  const storedSize = reserved + slots * 2;
  entries.forEach((e, slot) => {
    out.set(encodeSlotName(e.name, e.ext), names + slot * 11);
    for (const [at2, v, what] of [[startLba, e.startLba, "start LBA"], [blockCount, e.blockCount, "block count"], [reserved, e.reserved ?? 0, "reserved word"]]) {
      if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error(`${e.name}.${e.ext}: ${what} ${v} is not a u16`);
      out[at2 + slot * 2] = v >> 8;
      out[at2 + slot * 2 + 1] = v & 255;
    }
    if (!Number.isInteger(e.storedSize) || e.storedSize < 0 || e.storedSize > 4294967295) throw new Error(`${e.name}.${e.ext}: stored size ${e.storedSize} is not a u32`);
    const at = storedSize + slot * 4;
    out[at] = e.storedSize >>> 24 & 255;
    out[at + 1] = e.storedSize >>> 16 & 255;
    out[at + 2] = e.storedSize >>> 8 & 255;
    out[at + 3] = e.storedSize & 255;
  });
  return out;
}
function writeDirectory(user, entries, type = DEZAEMON_DISK_TYPE) {
  const bytes = encodeDirectory(entries);
  for (const at of directoryOffsets(type)) {
    if (at + bytes.length > user.length) throw new Error(`the image is ${user.length} bytes, too short for a directory copy at 0x${at.toString(16)}`);
    user.set(bytes, at);
  }
  return bytes;
}
function layoutFiles(files, { firstLba = FIRST_FILE_LBA, type = DEZAEMON_DISK_TYPE } = {}) {
  const lastLba = romEndLba(type) - 1;
  const out = [];
  let lba = firstLba;
  for (const f of files) {
    const blocks = blocksFor(lba, f.storedSize, type);
    if (blocks === null || lba + blocks - 1 > lastLba) {
      const used = lbaToOffset(lba, type) - lbaToOffset(firstLba, type);
      const room = lbaToOffset(lastLba + 1, type) - lbaToOffset(firstLba, type);
      throw new Error(
        `the ROM area is full at ${f.name}.${f.ext}: ${used} bytes of files already laid out and ${room} available between LBA ${firstLba} and the directory at LBA ${lastLba + 1}`
      );
    }
    out.push({
      name: f.name,
      ext: f.ext,
      startLba: lba,
      blockCount: blocks,
      storedSize: f.storedSize,
      offset: lbaToOffset(lba, type),
      capacity: extentBytes(lba, blocks, type) ?? 0
    });
    lba += blocks;
  }
  return out;
}

// packages/shmup-engine/src/n64/system-area.js
var REGION_JAPAN = 3897086742;
var FORMAT_RETAIL = 16;
var SYSTEM_DATA_BYTES = 232;
var DISK_ID_BYTES = 32;
var SYSTEM_SECTOR_BYTES = ZONE_SECTOR_SIZES[0];
var SYSTEM_SECTOR_BYTES_DEV = ZONE_SECTOR_SIZES[3];
var SYSTEM_DATA_LBAS = Object.freeze([0, 1, 8, 9]);
var SYSTEM_DATA_LBAS_DEV = Object.freeze([2, 3, 10, 11]);
var DISK_ID_LBAS = Object.freeze([14, 15]);
var SYSTEM_BLOCK_BYTES = SECTORS_PER_BLOCK * SYSTEM_SECTOR_BYTES;
var DEZAEMON_IPL_BLOCKS = 9;
var DEZAEMON_IPL_ADDRESS = 2147484672;
var DEZAEMON_INITIAL_CODE = "DEZA";
var DEZAEMON_COMPANY_CODE = "E7";
var DEZAEMON_FREE_AREA_PREFIX = "ATNFS";
function dezaemonFreeArea(diskType = 0) {
  if (!Number.isInteger(diskType) || diskType < 0 || diskType >= DISK_TYPE_COUNT) {
    throw new Error(`disk type ${diskType} is not one of 0..${DISK_TYPE_COUNT - 1}`);
  }
  return `${DEZAEMON_FREE_AREA_PREFIX}${diskType}`;
}
function u163(bytes, at) {
  return bytes[at] << 8 | bytes[at + 1];
}
function u322(bytes, at) {
  return (bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3]) >>> 0;
}
function putU162(bytes, at, v) {
  bytes[at] = v >> 8 & 255;
  bytes[at + 1] = v & 255;
}
function putU32(bytes, at, v) {
  bytes[at] = v >>> 24 & 255;
  bytes[at + 1] = v >>> 16 & 255;
  bytes[at + 2] = v >>> 8 & 255;
  bytes[at + 3] = v & 255;
}
function bcd(n) {
  return Math.floor(n / 10) % 10 << 4 | n % 10;
}
function putAscii(bytes, at, len, text, what) {
  const s = String(text ?? "");
  if (s.length > len) throw new Error(`${what} is at most ${len} characters; "${s}" is ${s.length}`);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 126) throw new Error(`${what} is ASCII; "${s[i]}" is not`);
    bytes[at + i] = c;
  }
}
function encodeSystemData(fields = {}) {
  const diskType = fields.diskType ?? 0;
  if (!Number.isInteger(diskType) || diskType < 0 || diskType >= DISK_TYPE_COUNT) {
    throw new Error(`disk type ${diskType} is not one of 0..${DISK_TYPE_COUNT - 1}`);
  }
  const retail = fields.retail ?? true;
  const out = new Uint8Array(SYSTEM_DATA_BYTES);
  putU32(out, 0, fields.region ?? REGION_JAPAN);
  out[4] = fields.format ?? (retail ? FORMAT_RETAIL : 0);
  out[5] = (retail ? FORMAT_RETAIL : 0) | diskType;
  const blocks = fields.iplLoadBlocks ?? DEZAEMON_IPL_BLOCKS;
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > MAX_USER_LBA) {
    throw new Error(`the IPL load size is 1..${MAX_USER_LBA} blocks; ${blocks} is not (an emulator refuses 0)`);
  }
  putU162(out, 6, blocks);
  const address = fields.iplLoadAddress ?? DEZAEMON_IPL_ADDRESS;
  if (!Number.isInteger(address) || address < 2147483648 || address >= 2155872256) {
    throw new Error(`the IPL load address is 0x80000000..0x807FFFFF; 0x${(address >>> 0).toString(16)} is not`);
  }
  putU32(out, 28, address);
  const offsets = fields.defectOffsets ?? [];
  for (let i = 0; i < 16; i++) out[8 + i] = (offsets[i] ?? 0) & 255;
  const tracks = fields.defectTracks ?? [];
  for (let i = 0; i < 192; i++) out[32 + i] = (tracks[i] ?? 0) & 255;
  const ramStart = ramStartLba(diskType);
  putU162(out, 224, fields.romEndLba ?? romEndLba(diskType));
  putU162(out, 226, fields.ramStartLba ?? (ramStart === null ? 65535 : ramStart));
  putU162(out, 228, fields.ramEndLba ?? (ramStart === null ? 65535 : ramEndLba(diskType)));
  return out;
}
function decodeSystemData(bytes) {
  if (bytes.length < SYSTEM_DATA_BYTES) throw new Error(`a system data record is ${SYSTEM_DATA_BYTES} bytes`);
  return {
    region: u322(bytes, 0),
    format: bytes[4],
    retail: (bytes[5] & FORMAT_RETAIL) !== 0,
    diskType: bytes[5] & 15,
    iplLoadBlocks: u163(bytes, 6),
    iplLoadAddress: u322(bytes, 28),
    defectOffsets: Array.from(bytes.subarray(8, 24)),
    defectTracks: Array.from(bytes.subarray(32, 224)),
    romEndLba: u163(bytes, 224),
    ramStartLba: u163(bytes, 226),
    ramEndLba: u163(bytes, 228)
  };
}
function encodeDiskId(fields = {}) {
  const out = new Uint8Array(DISK_ID_BYTES);
  const code = fields.initialCode ?? DEZAEMON_INITIAL_CODE;
  if (String(code).length !== 4) throw new Error(`an initial code is four characters; "${code}" is not`);
  putAscii(out, 0, 4, code, "the initial code");
  out[4] = (fields.version ?? 0) & 255;
  out[5] = (fields.diskNumber ?? 0) & 255;
  out[6] = (fields.ramUse ?? 1) & 255;
  out[7] = (fields.diskUse ?? 0) & 255;
  const date = fields.date === void 0 ? /* @__PURE__ */ new Date() : fields.date;
  if (date) {
    const year = date.getFullYear();
    out[17] = bcd(Math.floor(year / 100));
    out[18] = bcd(year % 100);
    out[19] = bcd(date.getMonth() + 1);
    out[20] = bcd(date.getDate());
    out[21] = bcd(date.getHours());
    out[22] = bcd(date.getMinutes());
    out[23] = bcd(date.getSeconds());
  }
  putAscii(out, 24, 2, fields.companyCode ?? DEZAEMON_COMPANY_CODE, "the company code");
  putAscii(out, 26, 6, fields.freeArea ?? dezaemonFreeArea(fields.diskType ?? 0), "the free area");
  return out;
}
function fillBlock(area, lba, sector2, sectorBytes) {
  const base = lba * SYSTEM_BLOCK_BYTES;
  for (let s = 0; s < SECTORS_PER_BLOCK; s++) area.set(sector2.subarray(0, sectorBytes), base + s * sectorBytes);
}
function buildSystemArea({ systemData, diskId } = {}) {
  const sys = systemData instanceof Uint8Array ? systemData : encodeSystemData(systemData);
  const type = systemData instanceof Uint8Array ? decodeSystemData(systemData).diskType : (systemData && systemData.diskType) ?? 0;
  const id = diskId instanceof Uint8Array ? diskId : encodeDiskId({ diskType: type, ...diskId || {} });
  const sysSector = new Uint8Array(SYSTEM_SECTOR_BYTES);
  sysSector.set(sys.subarray(0, Math.min(sys.length, SYSTEM_SECTOR_BYTES)));
  const idSector = new Uint8Array(SYSTEM_SECTOR_BYTES);
  idSector.set(id.subarray(0, Math.min(id.length, SYSTEM_SECTOR_BYTES)));
  const area = new Uint8Array(SYSTEM_AREA_BYTES);
  for (const lba of SYSTEM_DATA_LBAS) fillBlock(area, lba, sysSector, SYSTEM_SECTOR_BYTES);
  for (const lba of DISK_ID_LBAS) fillBlock(area, lba, idSector, SYSTEM_SECTOR_BYTES);
  return area;
}

// packages/shmup-engine/src/n64/disk-write.js
var DEZA64_NOTICE_OFFSET = 167552;
var DEZA64_NOTICE = Object.freeze([
  "KONO DISK WA DEZA64 DATA DISK DESU",
  "ICHIDO DENGEN WO KIRI DEZA64 NO",
  "ROMCARTRIDGE WO SOUNYUUSHITE",
  "DENGEN WO IRENAOSHITE KUDASAI"
]);
var BLANK_BYTE = 255;
var DISK_FORMATS = Object.freeze(["ddd", "ndd"]);
function imageFormat(image) {
  if (isNddSize(image.length)) return "ndd";
  if (isDddSize(image.length)) return "ddd";
  return null;
}
function writeNotice(user) {
  let at = DEZA64_NOTICE_OFFSET;
  for (const line of DEZA64_NOTICE) {
    for (let i = 0; i < line.length; i++) user[at++] = line.charCodeAt(i);
    user[at++] = 0;
  }
}
function readProjects(image) {
  const user = userArea(image);
  const entries = readDirectory(user);
  const inv = checkDirectory(entries);
  if (entries.length && (!inv.blocksFit || !inv.withinCapacity)) {
    throw new Error("the disk's directory does not agree with the 64DD geometry; refusing to rewrite it");
  }
  const projects = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (e.offset === null) throw new Error(`${e.name}.${e.ext} starts at LBA ${e.startLba}, off the disk`);
    if (e.offset + e.storedSize > user.length) throw new Error(`${e.name}.${e.ext} runs past the end of the image`);
    if (!projects.has(e.name)) projects.set(e.name, { name: e.name, files: [] });
    projects.get(e.name).files.push({
      ext: e.ext,
      stream: user.subarray(e.offset, e.offset + e.storedSize),
      storedSize: e.storedSize,
      startLba: e.startLba,
      blockCount: e.blockCount
    });
  }
  return [...projects.values()];
}
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function packProject(project) {
  const name = normalizeProjectName(project.name);
  const files = (project.files || []).map((f, i) => {
    const ext = String(f.ext || "").toUpperCase();
    if (ext.length !== 3) throw new Error(`${name}: "${f.ext}" is not a three-character extension`);
    if (!(f.data instanceof Uint8Array) || !f.data.length) throw new Error(`${name}.${ext}: a file is a non-empty Uint8Array`);
    return { ext, data: f.data, i };
  });
  if (!files.length) throw new Error(`${name}: a project has at least one file`);
  const seen = /* @__PURE__ */ new Set();
  for (const f of files) {
    if (seen.has(f.ext)) throw new Error(`${name}: ${f.ext} is given twice`);
    seen.add(f.ext);
  }
  files.sort((a, b) => extOrder(a.ext) - extOrder(b.ext) || a.i - b.i);
  return files.map((f) => ({ name, ext: f.ext, raw: f.data, stream: compress(f.data) }));
}
function buildDisk(options = {}) {
  const { base = null, projects = [], remove = [], boot = null, type = DEZAEMON_DISK_TYPE } = options;
  const warnings = [];
  if (type !== DEZAEMON_DISK_TYPE) {
    warnings.push(`disk type ${type}: only type 0's directory block has been measured; the directory is written where type 0 keeps it`);
  }
  let baseFormat = null;
  if (base !== null) {
    baseFormat = imageFormat(base);
    if (!baseFormat) throw new Error(`a base disk is ${DDD_IMAGE_BYTES} (.ddd) or ${NDD_IMAGE_BYTES} (.ndd) bytes; this one is ${base.length}`);
  }
  const format = options.format ?? baseFormat ?? "ddd";
  if (!DISK_FORMATS.includes(format)) throw new Error(`format is "ddd" or "ndd", not "${format}"`);
  const dropped = new Set(remove.map((n) => normalizeProjectName(n)));
  const fresh = /* @__PURE__ */ new Map();
  for (const p of projects) {
    const packed = packProject(p);
    const name = packed[0].name;
    if (fresh.has(name)) throw new Error(`project ${name} is given twice`);
    fresh.set(name, packed);
  }
  const laid = [];
  const order = [];
  const kept = [];
  const baseUser = base === null ? null : userArea(base);
  if (baseUser !== null) {
    for (const p of readProjects(baseUser)) {
      if (dropped.has(p.name)) continue;
      if (fresh.has(p.name)) {
        order.push(p.name);
        continue;
      }
      order.push(p.name);
      kept.push(p.name);
      for (const f of p.files) laid.push({ name: p.name, ext: f.ext, stream: f.stream, raw: null, kept: true });
    }
  }
  for (const name of fresh.keys()) if (!order.includes(name)) order.push(name);
  const byName = new Map(order.map((n) => [n, []]));
  for (const f of laid) byName.get(f.name).push(f);
  for (const [name, packed] of fresh) byName.set(name, packed.map((f) => ({ ...f, kept: false })));
  const files = order.flatMap((n) => byName.get(n));
  for (const name of dropped) {
    if (baseUser === null || !readProjects(baseUser).some((p) => p.name === name)) warnings.push(`${name} is not on the disk, so there was nothing to remove`);
  }
  const entries = layoutFiles(files.map((f) => ({ name: f.name, ext: f.ext, storedSize: f.stream.length })), { type });
  const user = new Uint8Array(DDD_IMAGE_BYTES);
  const firstFile = lbaToOffset(FIRST_FILE_LBA, type);
  const directoryBlock = lbaToOffset(DIRECTORY_LBA, type);
  if (baseUser !== null) {
    user.set(baseUser);
  } else {
    if (boot) {
      if (!(boot instanceof Uint8Array) || boot.length > firstFile) throw new Error(`a boot program is at most ${firstFile} bytes (nine blocks); this one is ${boot ? boot.length : "not bytes"}`);
      user.set(boot, 0);
    } else {
      writeNotice(user);
    }
  }
  user.fill(BLANK_BYTE, firstFile, directoryBlock);
  entries.forEach((e, i) => user.set(files[i].stream, e.offset));
  const directoryBytes = writeDirectory(user, entries, type);
  const back = readDirectory(user);
  if (back.length !== entries.length) throw new Error(`the directory read back with ${back.length} files, not ${entries.length}`);
  back.forEach((b, i) => {
    const e = entries[i];
    if (b.name !== e.name || b.ext !== e.ext || b.startLba !== e.startLba || b.blockCount !== e.blockCount || b.storedSize !== e.storedSize) {
      throw new Error(`${e.name}.${e.ext} read back differently from the directory it was written to`);
    }
  });
  const inv = checkDirectory(back);
  if (back.length && !(inv.contiguous && inv.blocksFit && inv.withinCapacity)) {
    const bad = back.filter((b) => !checkDirectory([b]).blocksFit || !checkDirectory([b]).withinCapacity).map((b) => `${b.name}.${b.ext} (LBA ${b.startLba}+${b.blockCount}, ${b.storedSize} bytes)`);
    throw new Error(
      "the directory this wrote fails its own invariants (contiguous, blocksFit, withinCapacity)" + (bad.length ? `: ${bad.join(", ")}` : "")
    );
  }
  back.forEach((b, i) => {
    const f = files[i];
    const stream = user.subarray(b.offset, b.offset + b.storedSize);
    if (!sameBytes(stream, f.stream)) throw new Error(`${b.name}.${b.ext}: the stream on the disk is not the one written`);
    if (f.raw) {
      const out = decompress(stream);
      if (!sameBytes(out, f.raw)) throw new Error(`${b.name}.${b.ext}: does not decompress to the bytes given`);
    }
  });
  for (const at of directoryOffsets(type)) {
    if (!sameBytes(user.subarray(at, at + directoryBytes.length), directoryBytes)) throw new Error(`the directory copy at 0x${at.toString(16)} did not land`);
  }
  let image = user;
  if (format === "ndd") {
    const systemArea = options.systemArea ?? (baseFormat === "ndd" ? systemAreaOf(base) : buildSystemArea({ systemData: { diskType: type }, diskId: { diskType: type } }));
    image = nddFromDdd(user, systemArea);
  }
  const last = entries[entries.length - 1];
  const nextLba = last ? last.startLba + last.blockCount : FIRST_FILE_LBA;
  const report = {
    format,
    type,
    base: baseFormat,
    projects: order.map((name) => {
      const own = entries.filter((e) => e.name === name);
      return {
        name,
        kept: kept.includes(name),
        files: own.map((e) => {
          const f = files[entries.indexOf(e)];
          return {
            ext: e.ext,
            raw: f.raw ? f.raw.length : null,
            stored: e.storedSize,
            startLba: e.startLba,
            blockCount: e.blockCount,
            ratio: f.raw ? Number((e.storedSize / f.raw.length).toFixed(3)) : null
          };
        }),
        stored: own.reduce((a, e) => a + e.storedSize, 0),
        firstLba: own.length ? own[0].startLba : null,
        blockCount: own.reduce((a, e) => a + e.blockCount, 0)
      };
    }),
    removed: [...dropped],
    files: entries.length,
    firstLba: FIRST_FILE_LBA,
    nextLba,
    romEnd: last ? last.offset + last.storedSize : firstFile,
    romBytes: directoryBlock - firstFile,
    romFree: directoryBlock - lbaToOffset(nextLba, type),
    directoryLba: DIRECTORY_LBA,
    directoryOffsets: directoryOffsets(type),
    romEndLba: romEndLba(type)
  };
  return { image, format, directory: back, report, warnings };
}

// packages/shmup-engine/src/n64/graphics.js
var TILE_WIDTH = 64;
var TILE_HEIGHT = 32;
var TILE_BYTES = TILE_WIDTH * TILE_HEIGHT * 2;

// packages/shmup-engine/src/n64/records.js
function check(name, v, min, max) {
  if (typeof v === "boolean") v = v ? 1 : 0;
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${name} is ${v}; it must be an integer ${min}..${max}`);
  }
  return v;
}
var s82 = (b, at) => b[at] << 24 >> 24;
var u164 = (b, at) => b[at] << 8 | b[at + 1];
var s16 = (b, at) => u164(b, at) << 16 >> 16;
var u323 = (b, at) => (b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3]) >>> 0;
var s322 = (b, at) => u323(b, at) | 0;
function putU8(b, at, name, v) {
  b[at] = check(name, v, 0, 255);
}
function putS8(b, at, name, v) {
  b[at] = check(name, v, -128, 127) & 255;
}
function putU163(b, at, name, v) {
  check(name, v, 0, 65535);
  b[at] = v >> 8;
  b[at + 1] = v & 255;
}
function putS16(b, at, name, v) {
  check(name, v, -32768, 32767);
  b[at] = v >> 8 & 255;
  b[at + 1] = v & 255;
}
function putU322(b, at, name, v) {
  check(name, v, 0, 4294967295);
  b[at] = v >>> 24 & 255;
  b[at + 1] = v >>> 16 & 255;
  b[at + 2] = v >>> 8 & 255;
  b[at + 3] = v & 255;
}
function putS322(b, at, name, v) {
  check(name, v, -2147483648, 2147483647);
  putU322(b, at, name, v >>> 0);
}
function putIndex(b, at, name, v) {
  b[at] = check(name, v, -1, 254) & 255;
}
var getIndex = (b, at) => b[at] === 255 ? -1 : b[at];
function shiftOf(mask) {
  let s = 0;
  while (!(mask >> s & 1)) s++;
  return s;
}
function pack(label, fields, values) {
  let out = 0;
  for (const f of fields) {
    const shift = shiftOf(f.mask);
    const v = check(`${label}.${f.name}`, values[f.name], 0, f.max ?? f.mask >> shift);
    out |= v << shift;
  }
  return out >>> 0;
}
function unpack(fields, word) {
  const out = {};
  for (const f of fields) {
    const v = (word & f.mask) >>> shiftOf(f.mask);
    out[f.name] = f.bool ? v !== 0 : v;
  }
  return out;
}
var isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v);
function merge(label, defaults, given) {
  if (given === void 0 || given === null) return defaults;
  if (ArrayBuffer.isView(defaults)) {
    if (!ArrayBuffer.isView(given) && !Array.isArray(given)) throw new Error(`${label} is ${defaults.length} raw bytes`);
    if (given.length !== defaults.length) throw new Error(`${label} is ${defaults.length} raw bytes; ${given.length} were given`);
    return Uint8Array.from(given);
  }
  if (Array.isArray(defaults)) {
    if (!Array.isArray(given)) throw new Error(`${label} is a list`);
    if (defaults.length === 0) return given;
    if (given.length > defaults.length) throw new Error(`${label} holds ${defaults.length} entries; ${given.length} were given`);
    return defaults.map((d, i) => merge(`${label}[${i}]`, d, given[i]));
  }
  if (isPlain(defaults)) {
    if (!isPlain(given)) throw new Error(`${label} is an object`);
    for (const k of Object.keys(given)) {
      if (!(k in defaults)) throw new Error(`${label}.${k} is not a field of ${label}`);
    }
    const out = {};
    for (const k of Object.keys(defaults)) out[k] = merge(`${label}.${k}`, defaults[k], given[k]);
    return out;
  }
  return given;
}
var fill = (n, v) => Array.from({ length: n }, () => typeof v === "function" ? v() : v);
function needBytes(label, bytes, at, n) {
  if (!(bytes instanceof Uint8Array)) throw new Error(`${label}: bytes are a Uint8Array`);
  if (at + n > bytes.length) throw new Error(`${label}: ${n} bytes at 0x${at.toString(16)} run past the end of ${bytes.length}`);
}
function isZero(bytes, at, n) {
  for (let i = at; i < at + n; i++) if (bytes[i] !== 0) return false;
  return true;
}
var ENEMY_ENTRY_BYTES = 92;
var ENEMY_SCORE_TABLE = Object.freeze([
  0,
  50,
  100,
  200,
  300,
  500,
  1e3,
  2e3,
  3e3,
  5e3,
  1e4,
  2e4,
  5e4,
  1e5,
  5e5,
  1e6
]);
var ENEMY_FLAGS = [
  { name: "rotationDisabled", mask: 128, bool: true },
  { name: "scalingDisabled", mask: 64, bool: true },
  { name: "transparencyDisabled", mask: 32, bool: true },
  { name: "unknownBits", mask: 31 }
];
var ALTITUDE_SETTINGS = [
  { name: "rate", mask: 3, max: 2 },
  { name: "loopType", mask: 224, max: 4 },
  { name: "unknownBits", mask: 28 }
];
var ROTATION_1B = [
  { name: "clockwise", mask: 128, bool: true },
  { name: "axis", mask: 3, max: 2 },
  { name: "unknownBits1B", mask: 124 }
];
var ROTATION_1C = [
  { name: "look", mask: 192 },
  { name: "loopType", mask: 3 },
  { name: "unknownBits1C", mask: 60 }
];
var SHOT_TYPE = [
  { name: "type", mask: 192 },
  { name: "direction", mask: 32 },
  { name: "variant", mask: 15 },
  { name: "unknownBits24", mask: 16 }
  // not `unknownBits`: the settings byte's is spread into the same object
];
var SHOT_SETTINGS = [
  { name: "speed", mask: 224 },
  { name: "aimAtPlayer", mask: 16, bool: true },
  { name: "timing", mask: 7 },
  { name: "unknownBits", mask: 8 }
];
var HIT_SETTINGS = [
  { name: "lockOn", mask: 128, bool: true },
  { name: "stageClear", mask: 64, bool: true },
  { name: "hpMode", mask: 3 },
  { name: "unknownBits", mask: 60 }
];
var BLAST_SETTINGS = [
  { name: "pattern", mask: 48 },
  { name: "type", mask: 8 },
  { name: "particle", mask: 4, bool: true },
  { name: "scale", mask: 3 },
  { name: "unknownBits", mask: 192 }
];
var flagged = (max) => [
  { name: "enabled", mask: 128, bool: true },
  { name: "value", mask: 127, max }
];
var ITEM_FLAGGED = flagged(6);
var DEATH_FLAGGED = flagged(7);
function shotDefaults() {
  return {
    type: 0,
    direction: 0,
    variant: 0,
    speed: 0,
    aimAtPlayer: false,
    timing: 0,
    unknownBits: 0,
    unknownBits24: 0,
    launchedEnemy: 0,
    x: 0,
    y: 0,
    z: 0,
    se: -1,
    seVolume: 3
  };
}
function enemyEntryDefaults() {
  return {
    score: 0,
    hp: 0,
    animation: { disabled: true, frameSpeed: 127, models: [255, 255, 255, 255] },
    flags: { rotationDisabled: true, scalingDisabled: true, transparencyDisabled: true, unknownBits: 0 },
    altitude: { cue: 0, initial: 0, final: 0, speed: 0, rate: 0, loopType: 0, unknownBits: 0 },
    unknown11: 0,
    scale: 100,
    scaling: { cue: 0, initial: 3, final: 3, speed: 3, loopType: 1 },
    rotation: {
      cue: 0,
      start: 0,
      end: 0,
      speed: 0,
      clockwise: false,
      axis: 1,
      look: 0,
      loopType: 0,
      unknownBits1B: 0,
      unknownBits1C: 0
    },
    motion: {
      birth: 0,
      in: 0,
      type: 0,
      orbit1: 0,
      orbit2: 0,
      orbit3: 0,
      speed1: 0,
      speed2: 0,
      speed3: 0,
      death: 7,
      deathEnabled: false
    },
    shots: [shotDefaults(), shotDefaults(), shotDefaults()],
    unknown2D: 0,
    hit: { lockOn: false, stageClear: false, hpMode: 0, size: 0, x: 0, y: 0, z: 0, unknownBits: 0 },
    blast: { pattern: 0, type: 0, particle: false, scale: 1, se: -1, seVolume: 3, unknownBits: 0 },
    item: { enabled: false, value: 0 },
    enemySet: -1,
    enemyRise: -1,
    unknown47: 0,
    transparency: { cue: 0, initial: 0, final: 0, speed: 0, loopType: 1 },
    unknown5B: 0
  };
}
function encodeEnemyEntry(entry = {}, label = "enemy") {
  const e = merge(label, enemyEntryDefaults(), entry);
  const b = new Uint8Array(ENEMY_ENTRY_BYTES);
  const m = e.motion;
  putU8(b, 0, `${label}.motion.birth`, check(`${label}.motion.birth`, m.birth, 0, 7));
  putU8(b, 1, `${label}.motion.in`, check(`${label}.motion.in`, m.in, 0, 1));
  putU8(b, 2, `${label}.score`, check(`${label}.score`, e.score, 0, 15));
  putU8(b, 3, `${label}.hp`, check(`${label}.hp`, e.hp, 0, 15));
  const a = e.animation;
  b[4] = check(`${label}.animation.disabled`, a.disabled, 0, 1) << 7 | check(`${label}.animation.frameSpeed`, a.frameSpeed, 0, 127);
  for (let i = 0; i < 4; i++) putU8(b, 5 + i, `${label}.animation.models[${i}]`, a.models[i]);
  b[9] = pack(`${label}.flags`, ENEMY_FLAGS, e.flags);
  const alt = e.altitude;
  putU8(b, 10, `${label}.altitude.cue`, check(`${label}.altitude.cue`, alt.cue, 0, 7));
  putU8(b, 11, `${label}.altitude.initial`, check(`${label}.altitude.initial`, alt.initial, 0, 8));
  putU8(b, 12, `${label}.altitude.final`, check(`${label}.altitude.final`, alt.final, 0, 8));
  putU8(b, 13, `${label}.altitude.speed`, check(`${label}.altitude.speed`, alt.speed, 0, 7));
  b[14] = pack(`${label}.altitude`, ALTITUDE_SETTINGS, alt);
  const sc = e.scaling;
  putU8(b, 15, `${label}.scaling.cue`, check(`${label}.scaling.cue`, sc.cue, 0, 7));
  const r = e.rotation;
  putU8(b, 16, `${label}.rotation.cue`, check(`${label}.rotation.cue`, r.cue, 0, 7));
  putU8(b, 17, `${label}.unknown11`, e.unknown11);
  putU163(b, 18, `${label}.scale`, check(`${label}.scale`, e.scale, 0, 9999));
  putU8(b, 20, `${label}.scaling.initial`, check(`${label}.scaling.initial`, sc.initial, 0, 7));
  putU8(b, 21, `${label}.scaling.final`, check(`${label}.scaling.final`, sc.final, 0, 7));
  putU8(b, 22, `${label}.scaling.speed`, check(`${label}.scaling.speed`, sc.speed, 0, 7));
  putU8(b, 23, `${label}.scaling.loopType`, check(`${label}.scaling.loopType`, sc.loopType, 0, 3));
  putU8(b, 24, `${label}.rotation.start`, r.start);
  putU8(b, 25, `${label}.rotation.end`, r.end);
  putU8(b, 26, `${label}.rotation.speed`, check(`${label}.rotation.speed`, r.speed, 0, 7));
  b[27] = pack(`${label}.rotation`, ROTATION_1B, r);
  b[28] = pack(`${label}.rotation`, ROTATION_1C, r);
  putU8(b, 29, `${label}.motion.type`, check(`${label}.motion.type`, m.type, 0, 1));
  putU8(b, 30, `${label}.motion.orbit1`, check(`${label}.motion.orbit1`, m.orbit1, 0, 29));
  putU8(b, 31, `${label}.motion.orbit2`, check(`${label}.motion.orbit2`, m.orbit2, 0, 19));
  putU8(b, 32, `${label}.motion.orbit3`, check(`${label}.motion.orbit3`, m.orbit3, 0, 19));
  putU8(b, 33, `${label}.motion.speed1`, check(`${label}.motion.speed1`, m.speed1, 0, 7));
  putU8(b, 34, `${label}.motion.speed2`, check(`${label}.motion.speed2`, m.speed2, 0, 7));
  putU8(b, 35, `${label}.motion.speed3`, check(`${label}.motion.speed3`, m.speed3, 0, 7));
  e.shots.forEach((s, i) => {
    const sl = `${label}.shots[${i}]`;
    b[36 + i] = pack(sl, SHOT_TYPE, s);
    b[39 + i] = pack(sl, SHOT_SETTINGS, s);
    putIndex(b, 42 + i, `${sl}.launchedEnemy`, s.launchedEnemy);
    putS16(b, 46 + i * 2, `${sl}.x`, s.x);
    putS16(b, 52 + i * 2, `${sl}.y`, s.y);
    putS16(b, 58 + i * 2, `${sl}.z`, s.z);
    putS8(b, 83 + i, `${sl}.se`, s.se);
    putU8(b, 87 + i, `${sl}.seVolume`, check(`${sl}.seVolume`, s.seVolume, 0, 7));
  });
  putU8(b, 45, `${label}.unknown2D`, e.unknown2D);
  const h = e.hit;
  b[64] = pack(`${label}.hit`, HIT_SETTINGS, h);
  putU8(b, 65, `${label}.hit.size`, check(`${label}.hit.size`, h.size, 0, 7));
  const bl = e.blast;
  b[66] = pack(`${label}.blast`, BLAST_SETTINGS, bl);
  b[67] = pack(`${label}.item`, ITEM_FLAGGED, e.item);
  putIndex(b, 68, `${label}.enemySet`, e.enemySet);
  putIndex(b, 69, `${label}.enemyRise`, e.enemyRise);
  b[70] = pack(`${label}.motion.death`, DEATH_FLAGGED, { enabled: m.deathEnabled, value: m.death });
  putU8(b, 71, `${label}.unknown47`, e.unknown47);
  putS16(b, 72, `${label}.hit.x`, h.x);
  putS16(b, 74, `${label}.hit.y`, h.y);
  putS16(b, 76, `${label}.hit.z`, h.z);
  const t = e.transparency;
  putU8(b, 78, `${label}.transparency.cue`, check(`${label}.transparency.cue`, t.cue, 0, 7));
  putU8(b, 79, `${label}.transparency.initial`, check(`${label}.transparency.initial`, t.initial, 0, 7));
  putU8(b, 80, `${label}.transparency.final`, check(`${label}.transparency.final`, t.final, 0, 7));
  putU8(b, 81, `${label}.transparency.speed`, check(`${label}.transparency.speed`, t.speed, 0, 7));
  putU8(b, 82, `${label}.transparency.loopType`, check(`${label}.transparency.loopType`, t.loopType, 0, 3));
  putS8(b, 86, `${label}.blast.se`, bl.se);
  putU8(b, 90, `${label}.blast.seVolume`, check(`${label}.blast.seVolume`, bl.seVolume, 0, 7));
  putU8(b, 91, `${label}.unknown5B`, e.unknown5B);
  return b;
}
function decodeEnemyEntry(bytes, at = 0) {
  needBytes("enemy", bytes, at, ENEMY_ENTRY_BYTES);
  const b = bytes.subarray(at, at + ENEMY_ENTRY_BYTES);
  const death = unpack(DEATH_FLAGGED, b[70]);
  return {
    score: b[2],
    hp: b[3],
    animation: { disabled: (b[4] & 128) !== 0, frameSpeed: b[4] & 127, models: [b[5], b[6], b[7], b[8]] },
    flags: unpack(ENEMY_FLAGS, b[9]),
    altitude: { cue: b[10], initial: b[11], final: b[12], speed: b[13], ...unpack(ALTITUDE_SETTINGS, b[14]) },
    unknown11: b[17],
    scale: u164(b, 18),
    scaling: { cue: b[15], initial: b[20], final: b[21], speed: b[22], loopType: b[23] },
    rotation: {
      cue: b[16],
      start: b[24],
      end: b[25],
      speed: b[26],
      ...unpack(ROTATION_1B, b[27]),
      ...unpack(ROTATION_1C, b[28])
    },
    motion: {
      birth: b[0],
      in: b[1],
      type: b[29],
      orbit1: b[30],
      orbit2: b[31],
      orbit3: b[32],
      speed1: b[33],
      speed2: b[34],
      speed3: b[35],
      death: death.value,
      deathEnabled: death.enabled
    },
    shots: [0, 1, 2].map((i) => ({
      ...unpack(SHOT_TYPE, b[36 + i]),
      ...unpack(SHOT_SETTINGS, b[39 + i]),
      launchedEnemy: getIndex(b, 42 + i),
      x: s16(b, 46 + i * 2),
      y: s16(b, 52 + i * 2),
      z: s16(b, 58 + i * 2),
      se: s82(b, 83 + i),
      seVolume: b[87 + i]
    })),
    unknown2D: b[45],
    hit: { ...unpack(HIT_SETTINGS, b[64]), size: b[65], x: s16(b, 72), y: s16(b, 74), z: s16(b, 76) },
    blast: { ...unpack(BLAST_SETTINGS, b[66]), se: s82(b, 86), seVolume: b[90] },
    item: unpack(ITEM_FLAGGED, b[67]),
    enemySet: getIndex(b, 68),
    enemyRise: getIndex(b, 69),
    unknown47: b[71],
    transparency: { cue: b[78], initial: b[79], final: b[80], speed: b[81], loopType: b[82] },
    unknown5B: b[91]
  };
}
var LAYOUT_ENTRY_BYTES = 12;
var LAYOUT_MAX_ENEMIES = 1e3;
var LAYOUT_BYTES = (LAYOUT_MAX_ENEMIES + 3) * LAYOUT_ENTRY_BYTES;
var LAYOUT_LAYERS = Object.freeze(["map", "a", "b"]);
function layoutEntryDefaults() {
  return { enemy: 0, unknown01: 0, x: 0, y: 0, unknown06: 0, frame: 0 };
}
function encodeLayoutEntry(entry = {}, label = "layout entry") {
  const e = merge(label, layoutEntryDefaults(), entry);
  const b = new Uint8Array(LAYOUT_ENTRY_BYTES);
  putIndex(b, 0, `${label}.enemy`, e.enemy);
  putU8(b, 1, `${label}.unknown01`, e.unknown01);
  putS16(b, 2, `${label}.x`, e.x);
  putS16(b, 4, `${label}.y`, e.y);
  putU163(b, 6, `${label}.unknown06`, e.unknown06);
  putS322(b, 8, `${label}.frame`, e.frame);
  return b;
}
function decodeLayoutEntry(bytes, at = 0) {
  needBytes("layout entry", bytes, at, LAYOUT_ENTRY_BYTES);
  return {
    enemy: getIndex(bytes, at),
    unknown01: bytes[at + 1],
    x: s16(bytes, at + 2),
    y: s16(bytes, at + 4),
    unknown06: u164(bytes, at + 6),
    frame: s322(bytes, at + 8)
  };
}
function layers(layout) {
  const l = merge("layout", { map: [], a: [], b: [] }, layout);
  for (const k of LAYOUT_LAYERS) if (!Array.isArray(l[k])) throw new Error(`layout.${k} is a list of positions`);
  return l;
}
function layoutIndices(layout = {}) {
  const l = layers(layout);
  const enemies = l.map.length + l.a.length + l.b.length;
  return {
    map: 0,
    a: l.map.length + 1,
    b: l.map.length + l.a.length + 2,
    enemies,
    slots: enemies + 3
  };
}
function encodeLayout(layout = {}) {
  const l = layers(layout);
  const idx = layoutIndices(l);
  if (idx.enemies > LAYOUT_MAX_ENEMIES) {
    throw new Error(`the layout holds ${LAYOUT_MAX_ENEMIES} enemies across its three layers; ${idx.enemies} were given`);
  }
  const out = new Uint8Array(LAYOUT_BYTES);
  let at = 0;
  for (const k of LAYOUT_LAYERS) {
    l[k].forEach((e, i) => {
      const entry = encodeLayoutEntry(e, `layout.${k}[${i}]`);
      if (entry[0] === 255) throw new Error(`layout.${k}[${i}].enemy is -1, which marks the end of a layer`);
      out.set(entry, at);
      at += LAYOUT_ENTRY_BYTES;
    });
    out[at] = 255;
    at += LAYOUT_ENTRY_BYTES;
  }
  return out;
}
function decodeLayout(bytes, at = 0) {
  const out = { map: [], a: [], b: [] };
  const end = Math.min(bytes.length, at + LAYOUT_BYTES);
  let layer = 0, enemies = 0;
  for (let p = at; p + LAYOUT_ENTRY_BYTES <= end && layer < LAYOUT_LAYERS.length; p += LAYOUT_ENTRY_BYTES) {
    const e = decodeLayoutEntry(bytes, p);
    if (e.enemy === -1) layer++;
    else if (enemies < LAYOUT_MAX_ENEMIES) {
      out[LAYOUT_LAYERS[layer]].push(e);
      enemies++;
    } else break;
  }
  return out;
}
var MAP_SETTINGS_BYTES = 3;
var MAP_ENTRY_BYTES = 4;
var MAP_ENTRIES = 256;
var MAP_BYTES = MAP_ENTRIES * MAP_ENTRY_BYTES;
var MAP_TEXTURE_UNSET = 150;
function mapSettingsDefaults() {
  return { scale: 5, loopStart: 0, loopEnd: 3 };
}
function encodeMapSettings(settings = {}) {
  const s = merge("map settings", mapSettingsDefaults(), settings);
  const b = new Uint8Array(MAP_SETTINGS_BYTES);
  putU8(b, 0, "map settings.scale", s.scale);
  putU8(b, 1, "map settings.loopStart", s.loopStart);
  putU8(b, 2, "map settings.loopEnd", s.loopEnd);
  return b;
}
function decodeMapSettings(bytes, at = 0) {
  needBytes("map settings", bytes, at, MAP_SETTINGS_BYTES);
  return { scale: bytes[at], loopStart: bytes[at + 1], loopEnd: bytes[at + 2] };
}
var MAP_EFFECTS = [
  { name: "transparency", mask: 57344 },
  { name: "type", mask: 7168 },
  { name: "speed", mask: 896 },
  { name: "intensity", mask: 112 },
  { name: "cycle", mask: 12 },
  { name: "noise", mask: 3 }
];
function mapEntryDefaults() {
  return { transparency: 7, type: 0, speed: 7, intensity: 5, cycle: 1, noise: 0, hit: false, texture: MAP_TEXTURE_UNSET };
}
function encodeMapEntry(entry = {}, label = "map entry") {
  const e = merge(label, mapEntryDefaults(), entry);
  const b = new Uint8Array(MAP_ENTRY_BYTES);
  putU163(b, 0, label, pack(label, MAP_EFFECTS, e));
  b[2] = check(`${label}.hit`, e.hit, 0, 1);
  putU8(b, 3, `${label}.texture`, e.texture);
  return b;
}
function decodeMapEntry(bytes, at = 0) {
  needBytes("map entry", bytes, at, MAP_ENTRY_BYTES);
  return { ...unpack(MAP_EFFECTS, u164(bytes, at)), hit: bytes[at + 2] !== 0, texture: bytes[at + 3] };
}
function encodeMapEntries(entries = []) {
  if (!Array.isArray(entries)) throw new Error("map entries are a list");
  if (entries.length > MAP_ENTRIES) throw new Error(`the map holds ${MAP_ENTRIES} entries; ${entries.length} were given`);
  const out = new Uint8Array(MAP_BYTES);
  for (let i = 0; i < MAP_ENTRIES; i++) out.set(encodeMapEntry(entries[i] ?? {}, `map[${i}]`), i * MAP_ENTRY_BYTES);
  return out;
}
function decodeMapEntries(bytes, at = 0) {
  needBytes("map", bytes, at, MAP_BYTES);
  return fill(MAP_ENTRIES, () => null).map((_, i) => decodeMapEntry(bytes, at + i * MAP_ENTRY_BYTES));
}
var EFFECT_ENTRY_BYTES = 12;
var EFFECT_ENTRIES = 500;
var EFFECT_BYTES = EFFECT_ENTRIES * EFFECT_ENTRY_BYTES;
var EFFECT_COMMANDS = Object.freeze([
  "soundEffect",
  // v1 SE, v2 volume, v3 loop start/end
  "portrait",
  // v1 set/clear, v2 texture, v3 position, v4 flags
  "fog",
  // v1..v3 RGB, v4 level
  "altitude",
  // v1 altitude 0..0xA, v2 speed
  "cameraAngle",
  // v2 position, v3 speed
  "cameraRotation",
  // v2 position, v3 speed
  "cameraZoom",
  // v2 position, v3 speed
  "backgroundTexture",
  // v2 texture
  "scrollBackground",
  // v1 x, v2 y, v3 free/zero
  "stageClear",
  "playerVisibility",
  // v1 on/off
  "playerHitDetection",
  // v1 on/off
  "playerSplash",
  // v1 off/constant/contact
  "song",
  // v1 song, v2 volume
  "demoMode",
  // v1 on/off
  "vibration",
  // v1 level
  "mapScrollRate",
  // v1 rate, v2 speed
  "layerAScrollRate",
  // v1 rate, v2 speed
  "layerBScrollRate"
  // v1 rate, v2 speed
]);
function effectCommand(command) {
  if (typeof command === "string") {
    const n = EFFECT_COMMANDS.indexOf(command);
    if (n < 0) throw new Error(`"${command}" is not a layout effect command; one of ${EFFECT_COMMANDS.join(", ")}`);
    return n;
  }
  return check("effect.command", command, 0, EFFECT_COMMANDS.length - 1);
}
function layoutEffectDefaults() {
  return { frame: 0, values: [0, 0, 0, 0], command: 0, reserved: [0, 0, 0] };
}
function encodeLayoutEffect(effect = {}, label = "effect") {
  const e = merge(label, layoutEffectDefaults(), effect);
  const b = new Uint8Array(EFFECT_ENTRY_BYTES);
  putU322(b, 0, `${label}.frame`, e.frame);
  e.values.forEach((v, i) => {
    b[4 + i] = check(`${label}.values[${i}]`, v, -128, 255) & 255;
  });
  b[8] = effectCommand(e.command);
  e.reserved.forEach((v, i) => putU8(b, 9 + i, `${label}.reserved[${i}]`, v));
  return b;
}
function decodeLayoutEffect(bytes, at = 0) {
  needBytes("effect", bytes, at, EFFECT_ENTRY_BYTES);
  return {
    frame: u323(bytes, at),
    values: [bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]],
    command: bytes[at + 8],
    reserved: [bytes[at + 9], bytes[at + 10], bytes[at + 11]]
  };
}
function encodeLayoutEffects(effects = []) {
  if (!Array.isArray(effects)) throw new Error("effects are a list");
  if (effects.length > EFFECT_ENTRIES) throw new Error(`a stage holds ${EFFECT_ENTRIES} layout effects; ${effects.length} were given`);
  const out = new Uint8Array(EFFECT_BYTES);
  effects.forEach((e, i) => out.set(encodeLayoutEffect(e, `effects[${i}]`), i * EFFECT_ENTRY_BYTES));
  return out;
}
function decodeLayoutEffects(bytes, at = 0, count = null) {
  needBytes("effects", bytes, at, EFFECT_BYTES);
  let n = EFFECT_ENTRIES;
  while (n > (count ?? 0) && isZero(bytes, at + (n - 1) * EFFECT_ENTRY_BYTES, EFFECT_ENTRY_BYTES)) n--;
  return fill(n, () => null).map((_, i) => decodeLayoutEffect(bytes, at + i * EFFECT_ENTRY_BYTES));
}
var BL_TAIL_BYTES = 16;
var BL_ENEMY_COUNT = 180;
var BL_OFFSETS = Object.freeze({
  enemies: 0,
  layout: BL_ENEMY_COUNT * ENEMY_ENTRY_BYTES,
  // 0x40B0
  mapSettings: BL_ENEMY_COUNT * ENEMY_ENTRY_BYTES + LAYOUT_BYTES,
  // 0x6FB4
  map: BL_ENEMY_COUNT * ENEMY_ENTRY_BYTES + LAYOUT_BYTES + MAP_SETTINGS_BYTES,
  // 0x6FB7
  effects: BL_ENEMY_COUNT * ENEMY_ENTRY_BYTES + LAYOUT_BYTES + MAP_SETTINGS_BYTES + MAP_BYTES,
  // 0x73B7
  tail: BL_ENEMY_COUNT * ENEMY_ENTRY_BYTES + LAYOUT_BYTES + MAP_SETTINGS_BYTES + MAP_BYTES + EFFECT_BYTES
  // 0x8B27
});
function blTailDefaults() {
  return { totalEffects: 0, firstMap: 0, firstA: 1, firstB: 2, unknown2F: 0, word33: 512, unknown35: 0 };
}
function encodeBlTail(tail = {}) {
  const t = merge("tail", blTailDefaults(), tail);
  const b = new Uint8Array(BL_TAIL_BYTES);
  putU163(b, 0, "tail.totalEffects", t.totalEffects);
  putU163(b, 2, "tail.firstMap", t.firstMap);
  putU163(b, 4, "tail.firstA", t.firstA);
  putU163(b, 6, "tail.firstB", t.firstB);
  putU322(b, 8, "tail.unknown2F", t.unknown2F);
  putU163(b, 12, "tail.word33", t.word33);
  putU163(b, 14, "tail.unknown35", t.unknown35);
  return b;
}
function decodeBlTail(bytes, at = 0) {
  needBytes("tail", bytes, at, BL_TAIL_BYTES);
  return {
    totalEffects: u164(bytes, at),
    firstMap: u164(bytes, at + 2),
    firstA: u164(bytes, at + 4),
    firstB: u164(bytes, at + 6),
    unknown2F: u323(bytes, at + 8),
    word33: u164(bytes, at + 12),
    unknown35: u164(bytes, at + 14)
  };
}
function enemyTable(list, count, label) {
  if (!Array.isArray(list)) throw new Error(`${label} is a list of enemy entries`);
  if (list.length > count) throw new Error(`${label} holds ${count} entries; ${list.length} were given`);
  const out = new Uint8Array(count * ENEMY_ENTRY_BYTES);
  for (let i = 0; i < count; i++) out.set(encodeEnemyEntry(list[i] ?? {}, `${label}[${i}]`), i * ENEMY_ENTRY_BYTES);
  return out;
}
function enemyList(bytes, at, count) {
  return fill(count, () => null).map((_, i) => decodeEnemyEntry(bytes, at + i * ENEMY_ENTRY_BYTES));
}
function buildStageBl({ enemies = [], layout = {}, mapSettings = {}, map = [], effects = [], tail = {} } = {}) {
  const out = new Uint8Array(DOCUMENTED_SIZES.BL);
  out.set(enemyTable(enemies, BL_ENEMY_COUNT, "enemies"), BL_OFFSETS.enemies);
  out.set(encodeLayout(layout), BL_OFFSETS.layout);
  out.set(encodeMapSettings(mapSettings), BL_OFFSETS.mapSettings);
  out.set(encodeMapEntries(map), BL_OFFSETS.map);
  out.set(encodeLayoutEffects(effects), BL_OFFSETS.effects);
  const idx = layoutIndices(layout);
  const t = merge("tail", blTailDefaults(), tail);
  const given = tail ?? {};
  const computed = {
    ...t,
    totalEffects: given.totalEffects ?? effects.length,
    firstA: given.firstA ?? idx.a,
    firstB: given.firstB ?? idx.b
  };
  out.set(encodeBlTail(computed), BL_OFFSETS.tail);
  return out;
}
function parseStageBl(bytes) {
  needBytes("#BL", bytes, 0, DOCUMENTED_SIZES.BL);
  const tail = decodeBlTail(bytes, BL_OFFSETS.tail);
  return {
    enemies: enemyList(bytes, BL_OFFSETS.enemies, BL_ENEMY_COUNT),
    layout: decodeLayout(bytes, BL_OFFSETS.layout),
    mapSettings: decodeMapSettings(bytes, BL_OFFSETS.mapSettings),
    map: decodeMapEntries(bytes, BL_OFFSETS.map),
    effects: decodeLayoutEffects(bytes, BL_OFFSETS.effects, tail.totalEffects),
    tail
  };
}
var CBL_ENEMY_COUNT = 20;
var CBL_ITEMS = Object.freeze(["shot", "laser", "bomb", "shield", "oneUp", "bonus1", "bonus2"]);
var CBL_ITEMS_OFFSET = CBL_ENEMY_COUNT * ENEMY_ENTRY_BYTES;
function buildCbl({ enemies = [], items = {} } = {}) {
  const out = new Uint8Array(DOCUMENTED_SIZES.CBL);
  out.set(enemyTable(enemies, CBL_ENEMY_COUNT, "enemies"), 0);
  let byName;
  if (Array.isArray(items)) {
    if (items.length > CBL_ITEMS.length) throw new Error(`CBL holds ${CBL_ITEMS.length} items; ${items.length} were given`);
    byName = Object.fromEntries(items.map((it, i) => [CBL_ITEMS[i], it]));
  } else {
    if (!isPlain(items)) throw new Error("items are {shot, laser, bomb, shield, oneUp, bonus1, bonus2} or a list");
    for (const k of Object.keys(items)) {
      if (!CBL_ITEMS.includes(k)) throw new Error(`items.${k} is not an item; the items are ${CBL_ITEMS.join(", ")}`);
    }
    byName = items;
  }
  CBL_ITEMS.forEach((name, i) => {
    out.set(encodeEnemyEntry(byName[name] ?? {}, `items.${name}`), CBL_ITEMS_OFFSET + i * ENEMY_ENTRY_BYTES);
  });
  return out;
}
var MODEL_BYTES = 3104;
var MODEL_MAX_VERTICES = 100;
var MODEL_MAX_FACES = 100;
var MODEL_TILES = 16;
var VERTEX_BYTES = 6;
var FACE_BYTES = 20;
var MODEL_TILE_BYTES = 20;
var MODEL_OFFSETS = Object.freeze({
  vertices: 2,
  faces: 602,
  unknownA2A: 2602,
  tiles: 2604,
  hScale: 2924,
  vScale: 2956,
  groups: 2988,
  light: 3088,
  unknownC11: 3089
});
var TILE_SCALE_MAX = 1024;
var TILE_OFFSET_MAX = 495;
var LIGHT_POSITION_MAX = 29;
function tilePixels(power) {
  return 1 << check("tile power", power, 0, 7) + 1;
}
function tileHeightPixels(power) {
  return 1 << check("tile power", power, 1, 7) - 1;
}
var FACE_TEXTURING = [
  { name: "untextured", mask: 128, bool: true },
  { name: "lightMask", mask: 64, bool: true },
  { name: "tile", mask: 15 },
  { name: "unknownBits", mask: 48 }
];
function vertexDefaults() {
  return { x: 0, y: 0, z: 0 };
}
function faceDefaults() {
  return {
    vertices: [0, 0, 0],
    pad: 0,
    uv: [[0, 0], [0, 0], [0, 0]],
    light: [255, 255, 255],
    untextured: false,
    lightMask: false,
    tile: 0,
    unknownBits: 0
  };
}
function tileDefaults() {
  return { offset: 0, mirrorV: false, widthPower: 5, mirrorH: false, heightPower: 6 };
}
function modelDefaults() {
  return {
    vertexCount: null,
    faceCount: null,
    vertices: [],
    faces: [],
    unknownA2A: 0,
    tiles: fill(MODEL_TILES, tileDefaults),
    hScale: fill(MODEL_TILES, TILE_SCALE_MAX),
    vScale: fill(MODEL_TILES, TILE_SCALE_MAX),
    groups: null,
    light: 0,
    unknownC11: new Uint8Array(MODEL_BYTES - 3089)
  };
}
function encodeFace(face = {}, label = "face") {
  const f = merge(label, faceDefaults(), face);
  const b = new Uint8Array(FACE_BYTES);
  f.vertices.forEach((v, i) => putU8(b, i, `${label}.vertices[${i}]`, check(`${label}.vertices[${i}]`, v, 0, MODEL_MAX_VERTICES - 1)));
  putU8(b, 3, `${label}.pad`, f.pad);
  f.uv.forEach(([u, v], i) => {
    putS16(b, 4 + i * 4, `${label}.uv[${i}][0]`, u);
    putS16(b, 6 + i * 4, `${label}.uv[${i}][1]`, v);
  });
  f.light.forEach((c, i) => putU8(b, 16 + i, `${label}.light[${i}]`, c));
  b[19] = pack(label, FACE_TEXTURING, f);
  return b;
}
function decodeFace(bytes, at = 0) {
  needBytes("face", bytes, at, FACE_BYTES);
  return {
    vertices: [bytes[at], bytes[at + 1], bytes[at + 2]],
    pad: bytes[at + 3],
    uv: [0, 1, 2].map((i) => [s16(bytes, at + 4 + i * 4), s16(bytes, at + 6 + i * 4)]),
    light: [bytes[at + 16], bytes[at + 17], bytes[at + 18]],
    ...unpack(FACE_TEXTURING, bytes[at + 19])
  };
}
function encodeTile(tile = {}, label = "tile") {
  const t = merge(label, tileDefaults(), tile);
  const b = new Uint8Array(MODEL_TILE_BYTES);
  putU322(b, 0, `${label}.offset`, check(`${label}.offset`, t.offset, 0, TILE_OFFSET_MAX));
  putU322(b, 4, `${label}.mirrorV`, check(`${label}.mirrorV`, t.mirrorV, 0, 1));
  putU322(b, 8, `${label}.widthPower`, check(`${label}.widthPower`, t.widthPower, 0, 7));
  putU322(b, 12, `${label}.mirrorH`, check(`${label}.mirrorH`, t.mirrorH, 0, 1));
  putU322(b, 16, `${label}.heightPower`, check(`${label}.heightPower`, t.heightPower, 0, 7));
  return b;
}
function decodeTile(bytes, at = 0) {
  needBytes("tile", bytes, at, MODEL_TILE_BYTES);
  return {
    offset: u323(bytes, at),
    mirrorV: u323(bytes, at + 4) !== 0,
    widthPower: u323(bytes, at + 8),
    mirrorH: u323(bytes, at + 12) !== 0,
    heightPower: u323(bytes, at + 16)
  };
}
function encodeModel(model = {}, label = "model") {
  const m = merge(label, modelDefaults(), model);
  if (m.vertices.length > MODEL_MAX_VERTICES) throw new Error(`${label}.vertices holds ${MODEL_MAX_VERTICES}; ${m.vertices.length} were given`);
  if (m.faces.length > MODEL_MAX_FACES) throw new Error(`${label}.faces holds ${MODEL_MAX_FACES}; ${m.faces.length} were given`);
  const b = new Uint8Array(MODEL_BYTES);
  putU8(b, 0, `${label}.vertexCount`, check(`${label}.vertexCount`, m.vertexCount ?? m.vertices.length, 0, MODEL_MAX_VERTICES));
  putU8(b, 1, `${label}.faceCount`, check(`${label}.faceCount`, m.faceCount ?? m.faces.length, 0, MODEL_MAX_FACES));
  m.vertices.forEach((v, i) => {
    const p = merge(`${label}.vertices[${i}]`, vertexDefaults(), v);
    const at = MODEL_OFFSETS.vertices + i * VERTEX_BYTES;
    putS16(b, at, `${label}.vertices[${i}].x`, p.x);
    putS16(b, at + 2, `${label}.vertices[${i}].y`, p.y);
    putS16(b, at + 4, `${label}.vertices[${i}].z`, p.z);
  });
  m.faces.forEach((f, i) => b.set(encodeFace(f, `${label}.faces[${i}]`), MODEL_OFFSETS.faces + i * FACE_BYTES));
  putU163(b, MODEL_OFFSETS.unknownA2A, `${label}.unknownA2A`, m.unknownA2A);
  m.tiles.forEach((t, i) => b.set(encodeTile(t, `${label}.tiles[${i}]`), MODEL_OFFSETS.tiles + i * MODEL_TILE_BYTES));
  m.hScale.forEach((v, i) => putU163(b, MODEL_OFFSETS.hScale + i * 2, `${label}.hScale[${i}]`, v));
  m.vScale.forEach((v, i) => putU163(b, MODEL_OFFSETS.vScale + i * 2, `${label}.vScale[${i}]`, v));
  const groups = m.groups ?? fill(MODEL_MAX_VERTICES, () => 0).map((_, i) => i < m.vertices.length ? -1 : 0);
  if (!Array.isArray(groups) || groups.length !== MODEL_MAX_VERTICES) throw new Error(`${label}.groups is one byte per vertex slot, ${MODEL_MAX_VERTICES} of them`);
  groups.forEach((g, i) => putS8(b, MODEL_OFFSETS.groups + i, `${label}.groups[${i}]`, g));
  putU8(b, MODEL_OFFSETS.light, `${label}.light`, check(`${label}.light`, m.light, 0, LIGHT_POSITION_MAX));
  b.set(m.unknownC11, MODEL_OFFSETS.unknownC11);
  return b;
}
function decodeModel(bytes, at = 0) {
  needBytes("model", bytes, at, MODEL_BYTES);
  const vertexCount = bytes[at];
  const faceCount = bytes[at + 1];
  let nv = MODEL_MAX_VERTICES;
  while (nv > vertexCount && isZero(bytes, at + MODEL_OFFSETS.vertices + (nv - 1) * VERTEX_BYTES, VERTEX_BYTES)) nv--;
  let nf = MODEL_MAX_FACES;
  while (nf > faceCount && isZero(bytes, at + MODEL_OFFSETS.faces + (nf - 1) * FACE_BYTES, FACE_BYTES)) nf--;
  return {
    vertexCount,
    faceCount,
    vertices: fill(nv, () => null).map((_, i) => {
      const p = at + MODEL_OFFSETS.vertices + i * VERTEX_BYTES;
      return { x: s16(bytes, p), y: s16(bytes, p + 2), z: s16(bytes, p + 4) };
    }),
    faces: fill(nf, () => null).map((_, i) => decodeFace(bytes, at + MODEL_OFFSETS.faces + i * FACE_BYTES)),
    unknownA2A: u164(bytes, at + MODEL_OFFSETS.unknownA2A),
    tiles: fill(MODEL_TILES, () => null).map((_, i) => decodeTile(bytes, at + MODEL_OFFSETS.tiles + i * MODEL_TILE_BYTES)),
    hScale: fill(MODEL_TILES, () => 0).map((_, i) => u164(bytes, at + MODEL_OFFSETS.hScale + i * 2)),
    vScale: fill(MODEL_TILES, () => 0).map((_, i) => u164(bytes, at + MODEL_OFFSETS.vScale + i * 2)),
    groups: fill(MODEL_MAX_VERTICES, () => 0).map((_, i) => s82(bytes, at + MODEL_OFFSETS.groups + i)),
    light: bytes[at + MODEL_OFFSETS.light],
    unknownC11: bytes.slice(at + MODEL_OFFSETS.unknownC11, at + MODEL_BYTES)
  };
}
var MD_MODEL_COUNT = 130;
var CMD_MODEL_COUNT = 20;
var ULB_MODEL_COUNT = 8;
var ULB_TEXTURE_COUNT = 8;
var MD_TEXTURE_INDEX_OFFSET = MD_MODEL_COUNT * MODEL_BYTES;
var CMD_TEXTURE_INDEX_OFFSET = CMD_MODEL_COUNT * MODEL_BYTES;
var ULB_TEXTURES_OFFSET = ULB_MODEL_COUNT * MODEL_BYTES;
function buildModelFile(label, models, textureIndices, count, size) {
  if (!Array.isArray(models)) throw new Error(`${label} models are a list`);
  if (!Array.isArray(textureIndices)) throw new Error(`${label} texture indices are a list`);
  if (models.length > count) throw new Error(`${label} holds ${count} models; ${models.length} were given`);
  if (textureIndices.length > count) throw new Error(`${label} holds ${count} texture indices; ${textureIndices.length} were given`);
  const out = new Uint8Array(size);
  models.forEach((m, i) => {
    if (m !== null && m !== void 0) out.set(encodeModel(m, `${label} models[${i}]`), i * MODEL_BYTES);
  });
  textureIndices.forEach((t, i) => putU163(out, count * MODEL_BYTES + i * 2, `${label} textureIndices[${i}]`, t ?? 0));
  return out;
}
function parseModelFile(label, bytes, count, size) {
  needBytes(label, bytes, 0, size);
  return {
    models: fill(count, () => null).map((_, i) => isZero(bytes, i * MODEL_BYTES, MODEL_BYTES) ? null : decodeModel(bytes, i * MODEL_BYTES)),
    textureIndices: fill(count, () => 0).map((_, i) => u164(bytes, count * MODEL_BYTES + i * 2))
  };
}
function buildMdFile(models = [], textureIndices = []) {
  return buildModelFile("#MD", models, textureIndices, MD_MODEL_COUNT, DOCUMENTED_SIZES.MD);
}
function buildCmdFile(models = [], textureIndices = []) {
  return buildModelFile("CMD", models, textureIndices, CMD_MODEL_COUNT, DOCUMENTED_SIZES.CMD);
}
function parseCmdFile(bytes) {
  return parseModelFile("CMD", bytes, CMD_MODEL_COUNT, DOCUMENTED_SIZES.CMD);
}
function buildUlbFile(models = [], textures = []) {
  if (!Array.isArray(textures)) throw new Error("ULB textures are a list");
  if (textures.length > ULB_TEXTURE_COUNT) throw new Error(`ULB holds ${ULB_TEXTURE_COUNT} textures; ${textures.length} were given`);
  const out = buildModelFile("ULB", models, [], ULB_MODEL_COUNT, DOCUMENTED_SIZES.ULB);
  textures.forEach((t, i) => {
    if (t === null || t === void 0) return;
    if (!(t instanceof Uint8Array) || t.length !== TILE_BYTES) throw new Error(`ULB textures[${i}] is a ${TILE_BYTES}-byte texture`);
    out.set(t, ULB_TEXTURES_OFFSET + i * TILE_BYTES);
  });
  return out;
}
function billboardModel({ width = 64, height = 32, tileWidthPower = 5, tileHeightPower = 6, tileOffset = 0, tile = 0, light = 0 } = {}) {
  check("billboard.width", width, 1, 32767);
  check("billboard.height", height, 1, 32767);
  check("billboard.tile", tile, 0, MODEL_TILES - 1);
  const u = tilePixels(tileWidthPower);
  const v = tileHeightPixels(tileHeightPower);
  const x0 = -(width >> 1), x1 = width - (width >> 1);
  const zFar = -(height >> 1), zNear = height - (height >> 1);
  const tiles = fill(MODEL_TILES, tileDefaults);
  tiles[tile] = { offset: tileOffset, mirrorV: false, widthPower: tileWidthPower, mirrorH: false, heightPower: tileHeightPower };
  const face = (vertices, uv) => ({ ...faceDefaults(), vertices, uv, tile });
  return {
    // near-left, near-right, far-right, far-left
    vertices: [{ x: x0, y: 0, z: zNear }, { x: x1, y: 0, z: zNear }, { x: x1, y: 0, z: zFar }, { x: x0, y: 0, z: zFar }],
    faces: [face([0, 1, 2], [[0, v], [u, v], [u, 0]]), face([0, 2, 3], [[0, v], [u, 0], [0, 0]])],
    tiles,
    light
  };
}
var GAM_HIGH_SCORES_BYTES = 160;
var GAM_PALETTE_BYTES = 512;
var GAM_LIGHTS = 30;
var GAM_SPRITES = Object.freeze([
  "playerShot",
  "playerSplash",
  "playerLaser",
  "enemyLaser1",
  "enemyShot1Frame1",
  "enemyShot1Frame2",
  "enemyShot1Frame3",
  "enemyShot1Frame4",
  "playerLaserFlash",
  "enemyLaser1Flash",
  "enemyLaser2",
  "playerBomb",
  "enemyShot2Frame1",
  "enemyShot2Frame2",
  "enemyShot2Frame3",
  "enemyShot2Frame4",
  "blastParticleFrame1",
  "blastParticleFrame2",
  "blastParticleFrame3",
  "blastParticleFrame4",
  "playerDustFrame1",
  "playerDustFrame2",
  "playerDustFrame3",
  "playerDustFrame4",
  "playerMuzzleFlashFrame1",
  "playerMuzzleFlashFrame2",
  "playerMuzzleFlashFrame3",
  "playerMuzzleFlashFrame4",
  "playerMark",
  "playerSight",
  "playerSightClosed",
  "blast1Frame1",
  "blast1Frame2",
  "blast1Frame3",
  "blast1Frame4",
  "blast1Frame5",
  "blast1Frame6",
  "blast2Frame1",
  "blast2Frame2",
  "blast2Frame3",
  "blast2Frame4",
  "blast2Frame5",
  "blast2Frame6",
  "playerStockShip",
  "playerStockBomb",
  "playerBoost"
]);
var GAM_FONT_COLORS = Object.freeze(["gray", "green", "purple", "orange", "magenta", "blue", "yellow", "red"]);
var GAM_LIGHT_POSITIONS = Object.freeze([
  "topDownRightFront",
  "topDownRightSide",
  "topDownRightRear",
  "topDownFront",
  "topDown",
  "topDownBack",
  "topDownLeftFront",
  "topDownLeftSide",
  "topDownLeftRear",
  "middleRightFront",
  "middleRightSide",
  "middleRightRear",
  "middleFront",
  "middleBack",
  "middleLeftFront",
  "middleLeftSide",
  "middleLeftRear",
  "bottomUpRightFront",
  "bottomUpRightSide",
  "bottomUpRightRear",
  "bottomUpFront",
  "bottomUp",
  "bottomUpBack",
  "bottomUpLeftFront",
  "bottomUpLeftSide",
  "bottomUpLeftRear"
]);
var GAM_OFFSETS = Object.freeze({
  finalStage: 0,
  unknown01: 1,
  fontFace: 2,
  fontColor: 3,
  timeAttackStage: 4,
  timeAttackLimit: 5,
  highScores1: 6,
  item1Score: 166,
  item2Score: 167,
  unknownA8: 168,
  loadout: 178,
  initialAltitude: 179,
  highScores2: 180,
  playerScale: 340,
  shieldScale: 342,
  playerFrameSpeed: 344,
  shieldFrameSpeed: 345,
  playerModels: 346,
  shieldModels: 350,
  playerTransparency: 354,
  shieldTransparency: 355,
  spriteX: 364,
  spriteY: 456,
  vibration: 548,
  title1Settings: 558,
  title2Settings: 560,
  title1Y: 562,
  title2Y: 564,
  ending: 566,
  lightPositions: 569,
  lightColors: 599,
  modelToolBackground: 779,
  layoutBackground: 782,
  palette: 785,
  titleBackgroundTexture: 1297,
  commonModelIndices: 1299,
  commonTextureIndices: 1319,
  bgm: 1363,
  unknown557: 1367,
  unknown558: 1368
});
var LOADOUT = [
  { name: "shotPower", mask: 192, max: 2 },
  { name: "laserPower", mask: 48, max: 2 },
  { name: "bombs", mask: 3 },
  { name: "unknownBits", mask: 12 }
];
var TITLE_SETTINGS = [
  { name: "wave", mask: 24576 },
  { name: "blink", mask: 4096, bool: true },
  { name: "transparency", mask: 3072 },
  { name: "inTop", mask: 64, bool: true },
  { name: "inBottom", mask: 128, bool: true },
  { name: "inLeft", mask: 256, bool: true },
  { name: "inRight", mask: 512, bool: true },
  { name: "width", mask: 48, max: 2 },
  { name: "height", mask: 12, max: 2 },
  { name: "roll", mask: 3, max: 2 },
  { name: "unknownBits", mask: 32768 }
];
function defaultHighScores() {
  const out = new Uint8Array(GAM_HIGH_SCORES_BYTES);
  for (let i = 0; i < 10; i++) {
    out.fill(46, i * 16, i * 16 + 8);
    putU322(out, i * 16 + 12, "score", 1e4 - i * 1e3);
  }
  return out;
}
var DEFAULT_PALETTE_HEX = "0000f801fa81ffc107c107ff003f502be327fde9f7e1a7ebb4fff7bd8421084300031087210b318f42135297631b739f842394a7a52bb5afc633d6b7e73bfffff469fde3fea3ffe3dfa3b7279f2f97398eff963b9df9ad35d535dcf3f471f46d637d73fd8cbda53db5bdc63dd6bdef7ffc87fccdfd13fd99fde1fe67feadff35f801f909fa11fb19fc21fd29fe31ff39fa81fb09fbd1fc99fd61fe29fef1ffb9f781f787f78ff797f79df7a5f7adfff50541258945d166598ea3af2bcf73f7fd014b02d7056b07ff3fff7fffb7fff7ff003f213f423f6b7f8c7fb5bfd6bfffff502b612d7a2f9333a435bd39d63bef3f502b606978e98969a1a7b227caa7e327280151077a0da313d45bdd21ede7feef620d728f8b539bd7b499c51ddde1f6a5600180c1a981ca41f301f445f58bf711f801f901fa01fb41fc41fd81fe81ffc1ffc1d7c1b7c18fc16fc147c127c107c107c707cf07d707df07e707ef07f707ff06ff05ff04ff03ff02ff01ff00ff003f083b1039183728353031382f402d502b60257021881d9817a813c00fd009e005fb41fbc3fc87fd0bfdcdfe51ff15ffd910013001500170019001b001d001f8011001304150c171019141b1c1d201fa8110813141524173419c41bd41de41ff0100810141020102c10381040104c105810003000b0015001d0025002d0035003f100b180f20132819301d38214025502b";
function hexBytes(hex2, n) {
  if (hex2.length !== n * 2) throw new Error(`a ${n}-byte constant has ${hex2.length / 2} bytes`);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex2.slice(i * 2, i * 2 + 2), 16);
  return out;
}
var DEFAULT_SPRITE_X = [
  0,
  16,
  32,
  32,
  64,
  80,
  96,
  112,
  0,
  16,
  32,
  48,
  64,
  80,
  96,
  112,
  0,
  16,
  32,
  48,
  64,
  80,
  96,
  112,
  0,
  16,
  32,
  48,
  64,
  80,
  96,
  0,
  32,
  64,
  96,
  0,
  32,
  64,
  96,
  0,
  32,
  64,
  96,
  0,
  16,
  16
];
var DEFAULT_SPRITE_Y = [
  448,
  448,
  448,
  456,
  448,
  448,
  448,
  448,
  464,
  464,
  464,
  464,
  464,
  464,
  464,
  464,
  480,
  480,
  480,
  480,
  480,
  480,
  480,
  480,
  496,
  496,
  496,
  496,
  496,
  496,
  496,
  512,
  512,
  512,
  512,
  544,
  544,
  544,
  544,
  576,
  576,
  576,
  576,
  608,
  608,
  464
];
var DEFAULT_LIGHT_POSITIONS = [0, 0, 19, 25, 25, 0, 19, 8, 16, 8, 2, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
var DEFAULT_LIGHT_COLORS = [
  [[255, 255, 255], [64, 64, 64]],
  [[248, 192, 64], [69, 28, 8]],
  [[248, 168, 56], [123, 67, 23]],
  [[240, 248, 248], [93, 80, 131]],
  [[248, 144, 104], [53, 29, 10]],
  [[248, 168, 112], [76, 54, 22]],
  [[248, 184, 128], [44, 46, 33]],
  [[216, 216, 248], [24, 24, 40]],
  [[240, 240, 248], [24, 24, 72]],
  [[255, 255, 255], [64, 64, 64]],
  [[223, 223, 255], [24, 24, 40]],
  [[255, 255, 255], [64, 64, 64]],
  [[255, 255, 255], [64, 64, 64]],
  [[255, 255, 255], [64, 64, 64]],
  [[255, 255, 255], [64, 64, 64]],
  [[255, 255, 255], [64, 64, 64]]
];
function transparencyDefaults(final) {
  return { enabled: false, initial: 0, final, speed: -1, loopType: 0 };
}
function titleDefaults(word, y) {
  return { ...unpack(TITLE_SETTINGS, word), y };
}
function gamDefaults() {
  const commonModels = new Uint8Array(20);
  [660, 661, 662, 663, 664, 665, 666, 667, 668, 270].forEach((v, i) => putU163(commonModels, i * 2, "model", v));
  const commonTextures = new Uint8Array(44);
  [628, 629, 630, 631, 632, 633, 634, 635, 636, 560, 638, 639, 640, 641, 10226, 643, 644, 645, 646, 647, 648, 649].forEach((v, i) => putU163(commonTextures, i * 2, "texture", v));
  return {
    finalStage: 2,
    unknown01: 0,
    fontFace: 0,
    fontColor: 4,
    timeAttackStage: 1,
    timeAttackLimit: 0,
    highScores1: defaultHighScores(),
    item1Score: 1,
    item2Score: 2,
    unknownA8: new Uint8Array(10),
    loadout: { shotPower: 0, laserPower: 0, bombs: 0, unknownBits: 0 },
    initialAltitude: 9,
    highScores2: defaultHighScores(),
    player: { scale: 66, frameSpeed: -1, models: [10, 0, 0, 0], transparency: transparencyDefaults(0) },
    shield: { scale: 89, frameSpeed: -1, models: [7, 5, 5, 5], transparency: transparencyDefaults(3) },
    spriteX: DEFAULT_SPRITE_X.slice(),
    spriteY: DEFAULT_SPRITE_Y.slice(),
    vibration: { death: 4, bomb: 4, blast1: [0, 0, 0, 0], blast2: [0, 0, 0, 0] },
    title1: titleDefaults(8469, 928),
    title2: titleDefaults(14870, 928),
    ending: { type: 0, startTexture: 29, endTexture: 41 },
    lightPositions: DEFAULT_LIGHT_POSITIONS.slice(),
    lightColors: fill(GAM_LIGHTS, () => null).map((_, i) => {
      const c = DEFAULT_LIGHT_COLORS[i];
      return c ? { directional: c[0].slice(), ambient: c[1].slice() } : { directional: [0, 0, 0], ambient: [0, 0, 0] };
    }),
    modelToolBackground: [0, 0, 176],
    layoutBackground: [3, 3, 6],
    palette: hexBytes(DEFAULT_PALETTE_HEX, GAM_PALETTE_BYTES),
    titleBackgroundTexture: 20,
    commonModelIndices: commonModels,
    commonTextureIndices: commonTextures,
    bgm: { title: 37, ending: 28, gameOver: 40, stageClear: 11 },
    unknown557: 46,
    unknown558: 46
  };
}
function putTransparency(b, at, label, t) {
  b[at] = check(`${label}.enabled`, t.enabled, 0, 1);
  putU8(b, at + 2, `${label}.initial`, check(`${label}.initial`, t.initial, 0, 7));
  putU8(b, at + 4, `${label}.final`, check(`${label}.final`, t.final, 0, 7));
  putS8(b, at + 6, `${label}.speed`, check(`${label}.speed`, t.speed, -1, 7));
  putU8(b, at + 8, `${label}.loopType`, check(`${label}.loopType`, t.loopType, 0, 3));
}
function encodeGam(gam = {}) {
  const { missing: _missing, ...given } = gam ?? {};
  const g = merge("gam", gamDefaults(), given);
  const b = new Uint8Array(DOCUMENTED_SIZES.GAM);
  const o = GAM_OFFSETS;
  putU8(b, o.finalStage, "gam.finalStage", g.finalStage);
  putU8(b, o.unknown01, "gam.unknown01", g.unknown01);
  putU8(b, o.fontFace, "gam.fontFace", check("gam.fontFace", g.fontFace, 0, 5));
  putU8(b, o.fontColor, "gam.fontColor", check("gam.fontColor", g.fontColor, 0, 7));
  putU8(b, o.timeAttackStage, "gam.timeAttackStage", g.timeAttackStage);
  putU8(b, o.timeAttackLimit, "gam.timeAttackLimit", g.timeAttackLimit);
  b.set(g.highScores1, o.highScores1);
  putU8(b, o.item1Score, "gam.item1Score", check("gam.item1Score", g.item1Score, 0, 7));
  putU8(b, o.item2Score, "gam.item2Score", check("gam.item2Score", g.item2Score, 0, 7));
  b.set(g.unknownA8, o.unknownA8);
  b[o.loadout] = pack("gam.loadout", LOADOUT, g.loadout);
  putU8(b, o.initialAltitude, "gam.initialAltitude", check("gam.initialAltitude", g.initialAltitude, 0, 10));
  b.set(g.highScores2, o.highScores2);
  putU163(b, o.playerScale, "gam.player.scale", g.player.scale);
  putU163(b, o.shieldScale, "gam.shield.scale", g.shield.scale);
  putS8(b, o.playerFrameSpeed, "gam.player.frameSpeed", check("gam.player.frameSpeed", g.player.frameSpeed, -1, 7));
  putS8(b, o.shieldFrameSpeed, "gam.shield.frameSpeed", check("gam.shield.frameSpeed", g.shield.frameSpeed, -1, 7));
  g.player.models.forEach((m, i) => putU8(b, o.playerModels + i, `gam.player.models[${i}]`, m));
  g.shield.models.forEach((m, i) => putU8(b, o.shieldModels + i, `gam.shield.models[${i}]`, m));
  putTransparency(b, o.playerTransparency, "gam.player.transparency", g.player.transparency);
  putTransparency(b, o.shieldTransparency, "gam.shield.transparency", g.shield.transparency);
  g.spriteX.forEach((v, i) => putU163(b, o.spriteX + i * 2, `gam.spriteX[${i}] (${GAM_SPRITES[i]})`, v));
  g.spriteY.forEach((v, i) => putU163(b, o.spriteY + i * 2, `gam.spriteY[${i}] (${GAM_SPRITES[i]})`, v));
  putU8(b, o.vibration, "gam.vibration.death", g.vibration.death);
  putU8(b, o.vibration + 1, "gam.vibration.bomb", g.vibration.bomb);
  g.vibration.blast1.forEach((v, i) => putU8(b, o.vibration + 2 + i, `gam.vibration.blast1[${i}]`, v));
  g.vibration.blast2.forEach((v, i) => putU8(b, o.vibration + 6 + i, `gam.vibration.blast2[${i}]`, v));
  putU163(b, o.title1Settings, "gam.title1", pack("gam.title1", TITLE_SETTINGS, g.title1));
  putU163(b, o.title2Settings, "gam.title2", pack("gam.title2", TITLE_SETTINGS, g.title2));
  putU163(b, o.title1Y, "gam.title1.y", g.title1.y);
  putU163(b, o.title2Y, "gam.title2.y", g.title2.y);
  putU8(b, o.ending, "gam.ending.type", check("gam.ending.type", g.ending.type, 0, 1));
  putU8(b, o.ending + 1, "gam.ending.startTexture", g.ending.startTexture);
  putU8(b, o.ending + 2, "gam.ending.endTexture", g.ending.endTexture);
  g.lightPositions.forEach((v, i) => putU8(b, o.lightPositions + i, `gam.lightPositions[${i}]`, check(`gam.lightPositions[${i}]`, v, 0, GAM_LIGHT_POSITIONS.length - 1)));
  g.lightColors.forEach((c, i) => {
    c.directional.forEach((v, k) => putU8(b, o.lightColors + i * 6 + k, `gam.lightColors[${i}].directional[${k}]`, v));
    c.ambient.forEach((v, k) => putU8(b, o.lightColors + i * 6 + 3 + k, `gam.lightColors[${i}].ambient[${k}]`, v));
  });
  g.modelToolBackground.forEach((v, k) => putU8(b, o.modelToolBackground + k, `gam.modelToolBackground[${k}]`, v));
  g.layoutBackground.forEach((v, k) => putU8(b, o.layoutBackground + k, `gam.layoutBackground[${k}]`, v));
  b.set(g.palette, o.palette);
  putS16(b, o.titleBackgroundTexture, "gam.titleBackgroundTexture", g.titleBackgroundTexture);
  b.set(g.commonModelIndices, o.commonModelIndices);
  b.set(g.commonTextureIndices, o.commonTextureIndices);
  putS8(b, o.bgm, "gam.bgm.title", g.bgm.title);
  putS8(b, o.bgm + 1, "gam.bgm.ending", g.bgm.ending);
  putS8(b, o.bgm + 2, "gam.bgm.gameOver", g.bgm.gameOver);
  putS8(b, o.bgm + 3, "gam.bgm.stageClear", g.bgm.stageClear);
  putU8(b, o.unknown557, "gam.unknown557", g.unknown557);
  putU8(b, o.unknown558, "gam.unknown558", g.unknown558);
  return b;
}
var PROTOTYPE_GAM_BYTES = DOCUMENTED_SIZES.GAM - 9;
var PROTOTYPE_GAM_GAP = 168;
function repairPrototypeGam(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error("GAM: bytes are a Uint8Array");
  if (bytes.length === DOCUMENTED_SIZES.GAM) return bytes;
  if (bytes.length !== PROTOTYPE_GAM_BYTES) return null;
  const missing = DOCUMENTED_SIZES.GAM - PROTOTYPE_GAM_BYTES;
  const out = new Uint8Array(DOCUMENTED_SIZES.GAM);
  out.set(bytes.subarray(0, PROTOTYPE_GAM_GAP));
  out.set(gamDefaults().unknownA8.subarray(0, missing), PROTOTYPE_GAM_GAP);
  out.set(bytes.subarray(PROTOTYPE_GAM_GAP), PROTOTYPE_GAM_GAP + missing);
  return out;
}
var SONG_BYTES = 11418;
var SONG_HEADER_BYTES = 26;
var SONG_COUNT = 24;
var SONG_BLOCKS = 32;
var SCORE_BLOCK_BYTES = 132;
var SCORE_BYTES = SONG_BLOCKS * SCORE_BLOCK_BYTES;
var ACCOMPANIMENT_BLOCK_BYTES = 224;
var ACCOMPANIMENT_BYTES = SONG_BLOCKS * ACCOMPANIMENT_BLOCK_BYTES;
var SCORE_OFFSET = SONG_HEADER_BYTES;
var ACCOMPANIMENT_OFFSET = SONG_HEADER_BYTES + SCORE_BYTES;
var MUS_TEMPO_TABLE = Object.freeze([
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
]);
var MUS_ECHO_TABLE = Object.freeze([0, 20, 30, 35, 40, 45, 50, 64]);
var PAN_CENTER = 64;
var INSTRUMENT_YELLOW_DRUMKIT = 50;
var TRACK_VOLUME = [
  { name: "muted", mask: 128, bool: true },
  { name: "volume", mask: 127 }
];
function songHeaderDefaults() {
  return {
    tempo: 16,
    echo: 2,
    loopStart: 0,
    length: SONG_BLOCKS - 1,
    tracks: fill(4, () => ({ volume: 90, muted: false })),
    instrumentVolumes: fill(7, 90),
    trackPans: fill(4, PAN_CENTER),
    instrumentPans: fill(7, PAN_CENTER)
  };
}
function encodeSongHeader(header = {}, label = "song") {
  const h = merge(label, songHeaderDefaults(), header);
  const b = new Uint8Array(SONG_HEADER_BYTES);
  putU8(b, 0, `${label}.tempo`, check(`${label}.tempo`, h.tempo, 0, 32));
  putU8(b, 1, `${label}.echo`, check(`${label}.echo`, h.echo, 0, MUS_ECHO_TABLE.length - 1));
  putU8(b, 2, `${label}.loopStart`, check(`${label}.loopStart`, h.loopStart, 0, SONG_BLOCKS - 1));
  putU8(b, 3, `${label}.length`, check(`${label}.length`, h.length, 0, SONG_BLOCKS - 1));
  h.tracks.forEach((t, i) => {
    b[4 + i] = pack(`${label}.tracks[${i}]`, TRACK_VOLUME, t);
  });
  h.instrumentVolumes.forEach((v, i) => putU8(b, 8 + i, `${label}.instrumentVolumes[${i}]`, v));
  h.trackPans.forEach((v, i) => putU8(b, 15 + i, `${label}.trackPans[${i}]`, v));
  h.instrumentPans.forEach((v, i) => putU8(b, 19 + i, `${label}.instrumentPans[${i}]`, v));
  return b;
}
function blankScore() {
  const out = new Uint8Array(SCORE_BYTES);
  for (let i = 0; i < SONG_BLOCKS; i++) out.set([255, 0, 1, 0], i * SCORE_BLOCK_BYTES);
  return out;
}
function blankAccompaniment() {
  const out = new Uint8Array(ACCOMPANIMENT_BYTES);
  for (let i = 0; i < SONG_BLOCKS; i++) {
    const drums = i * ACCOMPANIMENT_BLOCK_BYTES + 112 + 4 * 16;
    out.fill(INSTRUMENT_YELLOW_DRUMKIT, drums, drums + 3 * 16);
  }
  return out;
}
function songDefaults() {
  return { ...songHeaderDefaults(), score: blankScore(), accompaniment: blankAccompaniment() };
}
function encodeSong(song = {}, label = "song") {
  const s = merge(label, songDefaults(), song);
  const { score, accompaniment, ...header } = s;
  const b = new Uint8Array(SONG_BYTES);
  b.set(encodeSongHeader(header, label), 0);
  b.set(score, SCORE_OFFSET);
  b.set(accompaniment, ACCOMPANIMENT_OFFSET);
  return b;
}
function buildMusFile(songs = []) {
  if (!Array.isArray(songs)) throw new Error("MUS songs are a list");
  if (songs.length > SONG_COUNT) throw new Error(`MUS holds ${SONG_COUNT} songs; ${songs.length} were given`);
  const out = new Uint8Array(DOCUMENTED_SIZES.MUS);
  for (let i = 0; i < SONG_COUNT; i++) out.set(encodeSong(songs[i] ?? {}, `songs[${i}]`), i * SONG_BYTES);
  return out;
}

// packages/shmup-engine/src/n64/project-write.js
var N64_CGR_TEXTURES = DOCUMENTED_SIZES.CGR / TILE_BYTES;
var N64_GR_TEXTURES = DOCUMENTED_SIZES.GR / TILE_BYTES;
var N64_CMD_MODELS = CMD_MODEL_COUNT;
var N64_MD_MODELS = MD_MODEL_COUNT;
var N64_CBL_ENEMIES = 20;
var N64_BL_ENEMIES = BL_ENEMY_COUNT;
var N64_STAGE_COUNT = STAGES.length;
var N64_TITLE_COLS = 2;
var N64_TITLE_ROWS = 2;
var N64_FRAMES_PER_ENEMY = 4;
var N64_MODEL_NUMBER_BASE = N64_CMD_MODELS;
var N64_PLAYER_MODEL = 10;
var N64_ITEM_MODELS = Object.freeze([12, 13, 14, 15, 16, 17, 18]);
var N64_SPRITE_SCALE = 40;
var N64_SPRITE_ATLAS_WIDTH = 2 * TILE_WIDTH;
var N64_STOCK_ICON = 16;
function spriteAtlasTexel(x, y, textures = N64_CGR_TEXTURES) {
  if (x < 0 || y < 0 || x >= N64_SPRITE_ATLAS_WIDTH) return null;
  const texture = Math.floor(y / TILE_HEIGHT) * 2 + Math.floor(x / TILE_WIDTH);
  if (texture >= textures) return null;
  return { texture, x: x % TILE_WIDTH, y: y % TILE_HEIGHT };
}
function isN64ItemFrame(key) {
  return /item|powerup|speedup|1up/i.test(key);
}
var N64_UNITS_PER_PIXEL = 10;
var N64_LAYOUT_HALF_WIDTH = 220;
var N64_PLANE_Y = 800;
var N64_SCROLL_PER_ROW = 160;
var N64_STAGE_SCENE = Object.freeze([
  Object.freeze({ frame: 0, command: "altitude", values: Object.freeze([10, 7, 0, 0]) }),
  Object.freeze({ frame: 0, command: "fog", values: Object.freeze([56, 24, 0, 0]) }),
  Object.freeze({ frame: 0, command: "cameraZoom", values: Object.freeze([0, 0, 3, 0]) }),
  Object.freeze({ frame: 0, command: "cameraAngle", values: Object.freeze([0, 0, 3, 0]) }),
  Object.freeze({ frame: 0, command: "cameraRotation", values: Object.freeze([0, 10, 1, 0]) })
]);
var N64_GR_TEXTURE_BASE = N64_CGR_TEXTURES;
var N64_ENEMY_NUMBER_BASE = N64_CBL_ENEMIES;
var N64_STORY_COLS = 5;
var N64_STORY_ROWS = 8;
var N64_STORY_W = N64_STORY_COLS * TILE_WIDTH;
var N64_STORY_H = 240;
var N64_PORTRAIT_MAX_TEXTURE = 255;
function portraitPosition(row, col) {
  return row * 10 + col * 2;
}
var N64_PORTRAIT_SET = 1;
var N64_PORTRAIT_CLEAR = Object.freeze([255, 255, 0, 12]);
var N64_EFFECT_FPS = 30;
var N64_STORY_BASE_FRAMES = 4 * N64_EFFECT_FPS;
var N64_STORY_MIN_FRAMES = 6 * N64_EFFECT_FPS;
var N64_STORY_MAX_FRAMES = 15 * N64_EFFECT_FPS;
var N64_SCROLL_RATE = 3;
var N64_SCROLL_START = 404;
function storyFrames(parts = []) {
  const chars = parts.join(" ").length;
  return clamp4(N64_STORY_BASE_FRAMES + Math.ceil(chars / 2), N64_STORY_MIN_FRAMES, N64_STORY_MAX_FRAMES);
}
function storyScreen(variant2) {
  const w = N64_STORY_W, h = N64_STORY_ROWS * TILE_HEIGHT;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const x0 = Math.floor((w - variant2.w) / 2), y0 = Math.floor((N64_STORY_H - variant2.h) / 2);
  for (let y = 0; y < variant2.h; y++) {
    for (let x = 0; x < variant2.w; x++) {
      const s = (y * variant2.w + x) * 4;
      if (variant2.rgba[s + 3] < 128) continue;
      rgba.set([variant2.rgba[s], variant2.rgba[s + 1], variant2.rgba[s + 2], 255], ((y0 + y) * w + x0 + x) * 4);
    }
  }
  const { tiles } = textureGrid({ w, h, rgba });
  const textures = [], seen = /* @__PURE__ */ new Map(), cells = [];
  for (const t of tiles) {
    const key = t.join(",");
    if (!seen.has(key)) {
      seen.set(key, textures.length);
      textures.push(t);
    }
    cells.push(seen.get(key));
  }
  return { cells, textures };
}
function storyEffects(textureNumbers, frames) {
  const effects = [
    { frame: 0, command: "playerVisibility", values: [0, 0, 0, 0] },
    { frame: 0, command: "mapScrollRate", values: [0, 7, 0, 0] }
  ];
  textureNumbers.forEach((texture, k) => {
    const row = Math.floor(k / N64_STORY_COLS), col = k % N64_STORY_COLS;
    effects.push({ frame: 0, command: "portrait", values: [0, texture, portraitPosition(row, col), N64_PORTRAIT_SET] });
  });
  effects.push(
    { frame: frames, command: "portrait", values: [...N64_PORTRAIT_CLEAR] },
    { frame: frames, command: "playerVisibility", values: [1, 0, 0, 0] },
    { frame: frames, command: "mapScrollRate", values: [N64_SCROLL_RATE, 7, 0, 0] }
  );
  return effects;
}
var N64_SPEED_TABLE = Object.freeze([0, 0.5, 1, 1.5, 2, 3, 4, 6]);
var N64_HIT_SIZE_TABLE = Object.freeze([8, 16, 24, 32, 48, 64, 96, 128]);
var N64_DROP_ITEMS = Object.freeze({ 1: 0, 2: 0, 3: 0, 4: 5, 5: 2, 9: 3 });
var N64_ITEM_ENTRY = Object.freeze({ hitMode: 2, hitSize: 4 });
var N64_ITEM_SCALES = Object.freeze([33, 45, 45, 32, 45, 76, 32]);
function fileSizeFor(ext) {
  const key = sizeKey(String(ext).toUpperCase());
  return key in DOCUMENTED_SIZES ? DOCUMENTED_SIZES[key] : null;
}
var clamp4 = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function nearestIndex4(table, value) {
  let best = 0, bestD = Infinity;
  table.forEach((v, i) => {
    const d = Math.abs(v - value);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
function encodeRgba5551(frame, { alphaCutoff = 128 } = {}) {
  const n = frame.w * frame.h;
  const out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = frame.rgba[o + 3] >= alphaCutoff;
    const r = a ? Math.round(frame.rgba[o] * 31 / 255) : 0;
    const g = a ? Math.round(frame.rgba[o + 1] * 31 / 255) : 0;
    const b = a ? Math.round(frame.rgba[o + 2] * 31 / 255) : 0;
    const v = r << 11 | g << 6 | b << 1 | (a ? 1 : 0);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 255;
  }
  return out;
}
function textureGrid(frame, options = {}) {
  const cols = Math.max(1, Math.ceil(frame.w / TILE_WIDTH));
  const rows = Math.max(1, Math.ceil(frame.h / TILE_HEIGHT));
  const tiles = [];
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const cut = { w: TILE_WIDTH, h: TILE_HEIGHT, rgba: new Uint8Array(TILE_WIDTH * TILE_HEIGHT * 4) };
      for (let y = 0; y < TILE_HEIGHT; y++) {
        const sy = ty * TILE_HEIGHT + y;
        if (sy >= frame.h) break;
        for (let x = 0; x < TILE_WIDTH; x++) {
          const sx = tx * TILE_WIDTH + x;
          if (sx >= frame.w) break;
          const s = (sy * frame.w + sx) * 4;
          const d = (y * TILE_WIDTH + x) * 4;
          cut.rgba[d] = frame.rgba[s];
          cut.rgba[d + 1] = frame.rgba[s + 1];
          cut.rgba[d + 2] = frame.rgba[s + 2];
          cut.rgba[d + 3] = frame.rgba[s + 3];
        }
      }
      tiles.push(encodeRgba5551(cut, options));
    }
  }
  return { cols, rows, tiles };
}
function shrinkRgba(frame, maxW = TILE_WIDTH, maxH = TILE_HEIGHT) {
  const scale = Math.min(1, maxW / frame.w, maxH / frame.h);
  if (scale === 1) return { w: frame.w, h: frame.h, rgba: frame.rgba, scaled: false };
  const w = Math.max(1, Math.round(frame.w * scale));
  const h = Math.max(1, Math.round(frame.h * scale));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(frame.h - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(frame.w - 1, Math.floor((x + 0.5) / scale));
      const s = (sy * frame.w + sx) * 4;
      const d = (y * w + x) * 4;
      out[d] = frame.rgba[s];
      out[d + 1] = frame.rgba[s + 1];
      out[d + 2] = frame.rgba[s + 2];
      out[d + 3] = frame.rgba[s + 3];
    }
  }
  return { w, h, rgba: out, scaled: true };
}
function spriteTexture(frame, options = {}) {
  const small = shrinkRgba(frame);
  return { grid: textureGrid(small, options), w: small.w, h: small.h, scaled: small.scaled };
}
function spriteModel(sprite, light = 0, shown = sprite) {
  const w = Math.max(1, sprite.w), h = Math.max(1, sprite.h);
  const model = billboardModel({
    width: clamp4(Math.max(1, shown.w) * N64_UNITS_PER_PIXEL, 1, 32767),
    height: clamp4(Math.max(1, shown.h) * N64_UNITS_PER_PIXEL, 1, 32767),
    tileWidthPower: 5,
    tileHeightPower: 6,
    tile: 1,
    light
  });
  model.faces[0].uv = [[0, h], [w, h], [w, 0]];
  model.faces[1].uv = [[0, h], [w, 0], [0, 0]];
  return model;
}
function isBlankTexture(bytes) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
  return true;
}
var TextureSheet = class {
  /**
   * @param {number} count
   * @param {Uint8Array|null} [template]  `count` x 0x1000 bytes, or null for an empty sheet
   */
  constructor(count, template = null) {
    this.count = count;
    this.bytes = new Uint8Array(count * TILE_BYTES);
    if (template) {
      if (template.length !== this.bytes.length) throw new Error(`a sheet of ${count} textures is ${this.bytes.length} bytes; the template is ${template.length}`);
      this.bytes.set(template);
    }
    this.blank = Array.from({ length: count }, (_, i) => isBlankTexture(this.bytes.subarray(i * TILE_BYTES, (i + 1) * TILE_BYTES)));
    this.painted = this.blank.filter((b) => !b).length;
    this.placed = [];
  }
  /** Textures still blank. */
  get free() {
    return this.blank.filter(Boolean).length;
  }
  /**
   * @param {string} key   what the report calls the frame
   * @param {{cols: number, rows: number, tiles: Uint8Array[]}} grid
   * @returns {number|null}  the first texture's index, or null when no run of blanks fits
   */
  place(key, grid) {
    const need2 = grid.tiles.length;
    let run = 0;
    for (let i = 0; i < this.count; i++) {
      run = this.blank[i] ? run + 1 : 0;
      if (run === need2) {
        const first = i - need2 + 1;
        grid.tiles.forEach((t, k) => {
          this.bytes.set(t, (first + k) * TILE_BYTES);
          this.blank[first + k] = false;
        });
        this.placed.push({ key, index: first, cols: grid.cols, rows: grid.rows, textures: need2 });
        return first;
      }
    }
    return null;
  }
  /**
   * Single textures for art that need not lie in a run — a portrait names
   * each cell's texture by itself, a model its one texture: blank ones
   * first, then painted ones `reclaim(index)` allows (a template's art
   * nothing this project writes points at), from the bottom up or, with
   * `fromTop`, from the top down; none past `max`. The textures this sheet
   * placed are never taken back.
   * @param {string} key
   * @param {Uint8Array[]} textures
   * @param {{max?: number, reclaim?: ((index: number) => boolean)|null, fromTop?: boolean}} [options]
   * @returns {{indices: number[], reclaimed: number}|null}  null when too few are left
   */
  claim(key, textures, { max = this.count - 1, reclaim = null, fromTop = false } = {}) {
    const ours = /* @__PURE__ */ new Set();
    for (const p of this.placed) {
      for (const i of p.indices ?? Array.from({ length: p.textures }, (_, k) => p.index + k)) ours.add(i);
    }
    const blank = [], painted = [];
    for (let i = 0; i <= Math.min(max, this.count - 1); i++) {
      if (this.blank[i]) blank.push(i);
      else if (reclaim && !ours.has(i) && reclaim(i)) painted.push(i);
    }
    if (fromTop) painted.reverse();
    if (blank.length + painted.length < textures.length) return null;
    const indices = [...blank, ...painted].slice(0, textures.length);
    indices.forEach((i, k) => {
      this.bytes.set(textures[k], i * TILE_BYTES);
      this.blank[i] = false;
    });
    const reclaimed = Math.max(0, textures.length - blank.length);
    this.placed.push({ key, index: indices[0] ?? 0, cols: textures.length, rows: 1, textures: textures.length, indices, reclaimed });
    return { indices, reclaimed };
  }
  /**
   * A sprite painted at (x, y) of the sheet read as GAM's sprite atlas
   * (spriteAtlasTexel), over whatever is there, its clear pixels clearing
   * it: a HUD icon belongs where the GAM points, not where room is. The
   * textures it touches are no longer blank, so no frame is placed over it.
   * @param {{w: number, h: number, rgba: Uint8Array|Uint8ClampedArray}} sprite
   * @returns {number[]|null}  the textures painted, or null when the sprite runs off the atlas
   */
  paintAtlas(x, y, sprite) {
    const words = encodeRgba5551(sprite);
    const spots = [];
    for (let py = 0; py < sprite.h; py++) {
      for (let px = 0; px < sprite.w; px++) {
        const t = spriteAtlasTexel(x + px, y + py, this.count);
        if (!t) return null;
        spots.push([t, (py * sprite.w + px) * 2]);
      }
    }
    const touched = /* @__PURE__ */ new Set();
    for (const [t, w] of spots) {
      const at = t.texture * TILE_BYTES + (t.y * TILE_WIDTH + t.x) * 2;
      this.bytes[at] = words[w];
      this.bytes[at + 1] = words[w + 1];
      this.blank[t.texture] = false;
      touched.add(t.texture);
    }
    return [...touched];
  }
};
var ModelTable = class {
  constructor(count) {
    this.count = count;
    this.models = [];
    this.textures = [];
  }
  /** @returns {number|null} the slot, or null when the table is full */
  add(model, texture) {
    if (this.models.length >= this.count) return null;
    this.models.push(model);
    this.textures.push(texture);
    return this.models.length - 1;
  }
  get used() {
    return this.models.length;
  }
};
function cellParts(cell) {
  if (typeof cell !== "string" || cell.length < 2 || cell === "00") return null;
  const m = /^([A-Za-z]+)(\d)$/.exec(cell);
  return m ? { letter: m[1].toUpperCase(), drop: Number(m[2]) } : null;
}
function asFrame(f) {
  if (!f || !f.rgba || !(f.w > 0) || !(f.h > 0)) return null;
  return { w: f.w, h: f.h, rgba: f.rgba };
}
function animationModels(slots) {
  const numbers = slots.filter((s) => s >= 0).map((s) => N64_MODEL_NUMBER_BASE + s);
  if (!numbers.length) return [255, 255, 255, 255];
  return [0, 1, 2, 3].map((i) => numbers[Math.min(i, numbers.length - 1)]);
}
function enemyEntryFromEditor(rec, { slots, size, frames, drop = null, boss = false }) {
  const r = rec || {};
  const infinite = r.hp === "infinity";
  const hits = infinite ? 16 : Math.max(1, Math.ceil(Number(r.hp)) || (boss ? 16 : 1));
  const speed = Number.isFinite(r.speed) ? r.speed : 1;
  const frameRate = Number(r.frameRate);
  const animated = frames > 1 && Number.isFinite(frameRate) && frameRate > 0;
  const armed = boss ? bossWeapons(r).find((w) => weaponTextures(w.weapon).length) : null;
  const proj = r.projectileData || (armed ? armed.weapon : null);
  const interval = Number(r.interval);
  const fires = !!proj && Number.isFinite(interval) && interval > 0;
  const item = drop !== null && drop in N64_DROP_ITEMS ? N64_DROP_ITEMS[drop] : null;
  const blastScale = size < 24 ? 0 : size < 48 ? 1 : size < 96 ? 2 : 3;
  const entry = {
    score: nearestIndex4(ENEMY_SCORE_TABLE, Number(r.score) || (boss ? 1e4 : 100)),
    hp: clamp4(hits - 1, 0, 15),
    animation: {
      disabled: !animated,
      frameSpeed: animated ? nearestIndex4(ANIM_PERIOD_TABLE, 60 / frameRate) : 127,
      models: animationModels(slots)
    },
    scale: N64_SPRITE_SCALE,
    motion: { type: boss ? 1 : 0, speed1: nearestIndex4(N64_SPEED_TABLE, speed) },
    hit: {
      lockOn: boss,
      stageClear: boss,
      hpMode: infinite && !boss ? 2 : 0,
      size: nearestIndex4(N64_HIT_SIZE_TABLE, size)
    },
    blast: { particle: true, scale: blastScale }
  };
  if (fires) {
    entry.shots = [{
      type: 0,
      // bullet 1
      direction: 0,
      variant: 1,
      speed: nearestIndex4(N64_SPEED_TABLE, Number(proj.speed) || 2),
      aimAtPlayer: true,
      timing: nearestIndex4(FIRE_INTERVAL_TABLE, interval)
    }];
  }
  if (item !== null) entry.item = { enabled: true, value: item };
  return entry;
}
function itemEntry(model, scale) {
  return {
    animation: { disabled: true, frameSpeed: 127, models: [model, model, model, model] },
    scale,
    hit: { hpMode: N64_ITEM_ENTRY.hitMode, size: N64_ITEM_ENTRY.hitSize }
  };
}
function buildN64ProjectFromLevel(level, art2, options = {}) {
  const { template = null, title1 = null, title2 = null, framesPerEnemy = N64_FRAMES_PER_ENEMY, storyBackdrops: storyBackdrops2 = null } = options;
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const name = normalizeProjectName(options.name ?? (level && level.name) ?? "SHMUPX");
  const templateFiles = /* @__PURE__ */ new Map();
  if (template) {
    const list = template instanceof Map ? [...template.entries()].map(([ext, data]) => ({ ext, data })) : template;
    for (const f of list) {
      const ext = String(f.ext).toUpperCase();
      if (!(f.data instanceof Uint8Array)) throw new Error(`template ${ext}: a file is a Uint8Array`);
      templateFiles.set(ext, f.data);
    }
  }
  const artMap = /* @__PURE__ */ new Map();
  for (const [k, v] of Object.entries(art2 || {})) {
    const f = asFrame(v);
    if (f) artMap.set(decodeFrameKey(k), { key: decodeFrameKey(k), ...f });
  }
  const lookup = (n) => n ? artMap.get(decodeFrameKey(n)) || null : null;
  let stages = levelStages(level || {});
  if (!stages.length) throw new Error("the level has no stage with an enemylist");
  if (stages.length > N64_STAGE_COUNT) {
    warn(`level has ${stages.length} stages; a project holds ${N64_STAGE_COUNT} \u2014 dropped the rest`);
    stages = stages.slice(0, N64_STAGE_COUNT);
  }
  const enemyData = level && level.enemyData || {};
  const bossData = level && level.bossData || {};
  const sheetFrom = (ext, count) => {
    const t = templateFiles.get(ext) || null;
    if (t && t.length !== count * TILE_BYTES) {
      warn(`template ${ext} is ${t.length} bytes, not the ${count * TILE_BYTES} of ${count} textures; built on a blank sheet instead`);
      templateFiles.delete(ext);
      return new TextureSheet(count, null);
    }
    return new TextureSheet(count, t);
  };
  const cgr = sheetFrom("CGR", N64_CGR_TEXTURES);
  const common = { placed: [], missed: [], models: [], scaled: [] };
  let hud = null;
  const cmd = /* @__PURE__ */ new Map();
  const placeCommon = (key, grid) => {
    const at = cgr.place(key, grid);
    if (at === null) common.missed.push(key);
    return at;
  };
  const frameNames = (v) => Array.isArray(v) ? v : [];
  let shipFrames = frameNames((level && level.playerData || {}).texture).map(lookup).filter(Boolean);
  let shipSource = "level";
  if (!shipFrames.length) {
    shipSource = "duke";
    shipFrames = decodePlayerArt().filter((f) => /^duke_\d$/.test(f.key)).slice(0, 2);
  }
  const templateGam = templateFiles.get("GAM") || null;
  const repaired = templateGam ? repairPrototypeGam(templateGam) : null;
  if (templateGam && !repaired) warn(`template GAM is ${templateGam.length} bytes, neither the cartridge's ${DOCUMENTED_SIZES.GAM} nor the prototype's; carried as it is, its ship and sprites unread`);
  const gam = Uint8Array.from(templateGam ? repaired ?? templateGam : encodeGam({}));
  const gamRepaired = !!repaired && repaired !== templateGam;
  const gamKnown = gam.length === DOCUMENTED_SIZES.GAM;
  const u166 = (b, at) => b[at] << 8 | b[at + 1];
  if (gamKnown && shipFrames.length) {
    const k = GAM_SPRITES.indexOf("playerStockShip");
    const x = u166(gam, GAM_OFFSETS.spriteX + k * 2), y = u166(gam, GAM_OFFSETS.spriteY + k * 2);
    const textures = cgr.paintAtlas(x, y, fitRgba(shipFrames[0], N64_STOCK_ICON, N64_STOCK_ICON));
    if (textures) hud = { stockShip: { x, y, textures, key: shipFrames[0].key } };
    else warn(`the GAM puts the stock ship at (${x}, ${y}), off the CGR sheet's sprite atlas; the HUD keeps what is there`);
  }
  for (const [key, pic] of [["title1", title1], ["title2", title2]]) {
    const f = asFrame(pic);
    if (!f) continue;
    placeCommon(key, textureGrid(fitRgba(f, N64_TITLE_COLS * TILE_WIDTH, N64_TITLE_ROWS * TILE_HEIGHT)));
  }
  spreadFrames(shipFrames, Math.min(2, shipFrames.length)).forEach((f, i) => {
    const t = spriteTexture(f);
    if (t.scaled) common.scaled.push(`ship:${i}:${f.key}`);
    const at = placeCommon(`ship:${i}:${f.key}`, t.grid);
    if (at !== null && i === 0) cmd.set(N64_PLAYER_MODEL, { model: spriteModel(t, 0, f), texture: at, key: `ship:${f.key}` });
  });
  const itemFrames = Object.entries(art2 || {}).filter(([k]) => isN64ItemFrame(k)).slice(0, 8);
  itemFrames.forEach(([k], i) => {
    const f = lookup(k);
    if (!f) return;
    const t = spriteTexture(f);
    if (t.scaled) common.scaled.push(`item:${decodeFrameKey(k)}`);
    const at = placeCommon(`item:${decodeFrameKey(k)}`, t.grid);
    if (at !== null && i < N64_ITEM_MODELS.length) {
      cmd.set(N64_ITEM_MODELS[i], { model: spriteModel(t, 0, f), texture: at, key: `item:${decodeFrameKey(k)}` });
    }
  });
  common.placed = cgr.placed;
  const stagePlan = [];
  const splits = [];
  let spare = N64_STAGE_COUNT - stages.length;
  stages.forEach((st, i) => {
    const rec = bossData[`boss${i}`] || null;
    const split = rec ? splitBossStage2(rec) : null;
    if (split && spare <= 0) {
      warn(`${st.key}: boss${i} has a second stage, but the project's ${N64_STAGE_COUNT} stages are full \u2014 it flies its first form alone, the whole bar`);
    }
    if (!split || spare <= 0) {
      stagePlan.push({ st, boss: rec, bossKey: `boss${i}`, form: 0 });
      return;
    }
    spare--;
    const key = `${st.key}:stage2`;
    stagePlan.push({ st, boss: split.first, bossKey: `boss${i}`, form: 1 });
    stagePlan.push({ st: { key, enemylist: [] }, boss: split.second, bossKey: `boss${i}:stage2`, form: 2 });
    splits.push({ stage: st.key, into: key, name: rec.name || `boss${i}`, second: bossBodyFrames(split.second)[0] || "?", hp: [split.first.hp, split.second.hp] });
  });
  const stageReports = [];
  const built = /* @__PURE__ */ new Map();
  stagePlan.forEach(({ st, boss, bossKey, form }, i) => {
    const stage = STAGES[i];
    const grExt = `${stage}GR`, mdExt = `${stage}MD`, blExt = `${stage}BL`;
    const sheet = sheetFrom(grExt, N64_GR_TEXTURES);
    const models = new ModelTable(N64_MD_MODELS);
    const entries = [];
    const placements = [];
    const missed = [];
    const scaled = [];
    let mapSettings = {}, map = [];
    const templateBl = templateFiles.get(blExt);
    if (templateBl) {
      try {
        const t = parseStageBl(templateBl);
        mapSettings = t.mapSettings;
        map = t.map;
      } catch (e) {
        warn(`${st.key}: the template's ${blExt} could not be read for its map (${e.message}); the map is unset`);
      }
    }
    const mapTextures = /* @__PURE__ */ new Set();
    for (const m of map) {
      if (m.texture === MAP_TEXTURE_UNSET) continue;
      mapTextures.add(m.texture);
      mapTextures.add(m.texture - N64_GR_TEXTURE_BASE);
    }
    const unnamedByMap = (index) => !mapTextures.has(index);
    const placeFrame = (key, frame) => {
      if (models.used >= models.count) {
        missed.push(key);
        return -1;
      }
      const t = spriteTexture(frame);
      if (t.scaled) scaled.push(key);
      let at = sheet.place(key, t.grid);
      if (at === null) {
        const got = sheet.claim(key, t.grid.tiles, { reclaim: unnamedByMap, fromTop: true });
        at = got ? got.indices[0] : null;
      }
      if (at === null) {
        missed.push(key);
        return -1;
      }
      return models.add(spriteModel(t, 0, frame), N64_GR_TEXTURE_BASE + at);
    };
    const width = Math.max(1, level && level.width || 0, ...st.enemylist.map((row) => row.length));
    const spawnRows = st.enemylist.slice().reverse();
    const waveRows = Array.isArray(st.waveRows) && st.waveRows.length === st.enemylist.length ? st.waveRows.slice().reverse() : null;
    const usage = /* @__PURE__ */ new Map();
    const cells = [];
    let lastRow = FIRST_SPAWN_ROW;
    spawnRows.forEach((row, k) => {
      const scrollRow = waveRows ? clamp4(Math.round(waveRows[k]), 0, MAX_SPAWN_ROW) : Math.min(MAX_SPAWN_ROW, FIRST_SPAWN_ROW + k * ROW_STEP);
      row.forEach((cell, col) => {
        const parts = cellParts(cell);
        if (!parts) return;
        cells.push({ ...parts, col, row: scrollRow });
        if (!usage.has(parts.letter)) usage.set(parts.letter, { count: 0, digits: /* @__PURE__ */ new Map() });
        const u = usage.get(parts.letter);
        u.count++;
        u.digits.set(parts.drop, (u.digits.get(parts.drop) || 0) + 1);
        lastRow = Math.max(lastRow, scrollRow);
      });
    });
    const letters = [...usage.keys()].sort((a, b) => usage.get(b).count - usage.get(a).count);
    const gridLetters = [];
    for (const row of st.enemylist) {
      for (const cell of row) {
        const parts = cellParts(cell);
        if (parts && !gridLetters.includes(parts.letter)) gridLetters.push(parts.letter);
      }
    }
    const entryOf = /* @__PURE__ */ new Map();
    const stageEnemies = [];
    for (const letter of letters) {
      const rec = enemyData[`enemy${letter}`];
      if (!rec) {
        warn(`${st.key}: cell ${letter} names no enemyData.enemy${letter}; nothing drawn for it`);
        continue;
      }
      if (entries.length >= N64_BL_ENEMIES) {
        warn(`${st.key}: a stage holds ${N64_BL_ENEMIES} enemy entries and they are all taken \u2014 enemy${letter} is left out`);
        continue;
      }
      const frames = frameNames(rec.texture).map(lookup).filter(Boolean);
      if (!frames.length) warn(`${st.key}: enemy${letter} (${rec.name || "unnamed"}) has no frame in the art`);
      const kept = spreadFrames(frames, Math.min(framesPerEnemy, frames.length));
      const slots = kept.map((f, k) => placeFrame(`enemy${letter}:${k}:${f.key}`, f));
      const size = frames.reduce((a, f) => Math.max(a, f.w, f.h), 16);
      const digits = [...usage.get(letter).digits.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
      let first = null;
      for (const drop of digits) {
        if (entries.length >= N64_BL_ENEMIES) {
          warn(`${st.key}: no entry left for enemy${letter}'s drop ${drop}; it drops what its first entry does`);
          entryOf.set(`${letter}${drop}`, first);
          continue;
        }
        const index = entries.length;
        entries.push(enemyEntryFromEditor(rec, { slots, size, frames: kept.length, drop }));
        entryOf.set(`${letter}${drop}`, index);
        if (first === null) first = index;
      }
      if (first !== null) stageEnemies.push({ letter, name: rec.name || null, entries: digits.map((d) => entryOf.get(`${letter}${d}`)), slots, size });
    }
    for (const c of cells) {
      const index = entryOf.get(`${c.letter}${c.drop}`);
      if (index === void 0) continue;
      const x = width <= 1 ? 0 : Math.round(-N64_LAYOUT_HALF_WIDTH + c.col * 2 * N64_LAYOUT_HALF_WIDTH / (width - 1));
      placements.push({ enemy: N64_ENEMY_NUMBER_BASE + index, x, y: N64_PLANE_Y, frame: -(c.row * N64_SCROLL_PER_ROW) });
    }
    placements.sort((a, b) => b.frame - a.frame);
    const room = LAYOUT_MAX_ENEMIES - (boss ? 1 : 0);
    if (placements.length > room) {
      warn(`${st.key}: a stage's layout holds ${LAYOUT_MAX_ENEMIES} enemies${boss ? " with the boss" : ""}; ${placements.length - room} dropped from the end`);
      placements.length = room;
    }
    let bossEntry = null;
    if (boss) {
      const names = boss.anim && Array.isArray(boss.anim.idle) && boss.anim.idle.length ? boss.anim.idle : frameNames(boss.texture);
      const frames = names.map(lookup).filter(Boolean);
      if (!frames.length) warn(`${st.key}: ${bossKey} has no idle frame in the art`);
      const kept = spreadFrames(frames, Math.min(framesPerEnemy, frames.length));
      const slots = kept.map((f, k) => placeFrame(`${bossKey}:${k}:${f.key}`, f));
      const size = frames.reduce((a, f) => Math.max(a, f.w, f.h), 64);
      if (entries.length >= N64_BL_ENEMIES) {
        warn(`${st.key}: no enemy entry left for ${bossKey}; the stage has no end`);
      } else {
        bossEntry = entries.length;
        entries.push(enemyEntryFromEditor(boss, { slots, size, frames: kept.length, boss: true }));
        placements.push({ enemy: N64_ENEMY_NUMBER_BASE + bossEntry, x: 0, y: N64_PLANE_Y, frame: -((lastRow + BOSS_ROW_GAP) * N64_SCROLL_PER_ROW) });
      }
    }
    if (missed.length) warn(`${st.key}: the ${grExt} sheet or the ${mdExt} table ran out of room; not drawn: ${missed.join(", ")}`);
    let story = null;
    let effects = N64_STAGE_SCENE.map((e) => ({ frame: e.frame, command: e.command, values: [...e.values] }));
    const backdrop = /^stage\d+$/.test(st.key) && Array.isArray(storyBackdrops2) ? storyBackdrops2.find((b) => `stage${b.stage}` === st.key) || null : null;
    if (backdrop) {
      const max = N64_PORTRAIT_MAX_TEXTURE - N64_GR_TEXTURE_BASE;
      const tried = [];
      for (const v of backdrop.variants || []) {
        if (!(v.w <= N64_STORY_W && v.h <= N64_STORY_H)) {
          tried.push(`${v.label} is ${v.w}x${v.h}, over the screen's ${N64_STORY_W}x${N64_STORY_H}`);
          continue;
        }
        const screen = storyScreen(v);
        const got = sheet.claim(`${st.key}:story`, screen.textures, { max, reclaim: unnamedByMap });
        if (!got) {
          tried.push(`${v.label} needs ${screen.textures.length} textures`);
          continue;
        }
        const frames = storyFrames(backdrop.parts || []);
        effects = [...effects, ...storyEffects(screen.cells.map((c) => N64_GR_TEXTURE_BASE + got.indices[c]), frames)].slice(0, EFFECT_ENTRIES);
        story = { size: v.label, textures: screen.textures.length, reclaimed: got.reclaimed, frames, seconds: Math.round(frames / N64_EFFECT_FPS) };
        break;
      }
      if (story) {
        for (const p of placements) p.frame -= N64_SCROLL_START;
      } else {
        warn(`${st.key}: no size of its story fits the ${grExt} sheet's textures up to tile ${max} (${tried.join("; ") || "no sizes"}) \u2014 not drawn`);
      }
    }
    built.set(grExt, sheet.bytes);
    built.set(mdExt, buildMdFile(models.models, models.textures));
    built.set(blExt, buildStageBl({ enemies: entries, layout: { map: placements }, mapSettings, map, effects }));
    stageReports.push({
      key: st.key,
      stage,
      ext: grExt,
      enemies: gridLetters,
      boss: boss ? bossKey : null,
      ...boss && form ? { form } : {},
      textures: sheet.placed,
      painted: sheet.painted,
      used: sheet.count - sheet.free,
      free: sheet.free,
      missed,
      scaled,
      // the template's textures taken back, the story's among them
      reclaimed: sheet.placed.reduce((a, p) => a + (p.reclaimed ?? 0), 0),
      story,
      records: {
        entries: entries.length,
        models: models.used,
        placements: placements.length,
        enemies: stageEnemies,
        bossEntry,
        map: templateBl ? "template" : "unset"
      }
    });
  });
  if (common.missed.length) warn(`the CGR sheet ran out of blank textures; not drawn: ${common.missed.join(", ")}`);
  const finalStage = STAGES[stagePlan.length - 1];
  let cmdOverTemplate = false;
  const templateCmd = templateFiles.get("CMD") || null;
  if (!templateCmd) {
    const cmdModels = [], cmdTextures = [];
    for (const [slot, m] of cmd) {
      cmdModels[slot] = m.model;
      cmdTextures[slot] = m.texture;
    }
    for (let s = 0; s < cmdModels.length; s++) if (cmdModels[s] === void 0) cmdModels[s] = null;
    for (let s = 0; s < cmdTextures.length; s++) if (cmdTextures[s] === void 0) cmdTextures[s] = 0;
    built.set("CMD", buildCmdFile(cmdModels, cmdTextures));
  } else if (cmd.size) {
    try {
      const t = parseCmdFile(templateCmd);
      for (const [slot, m] of cmd) {
        t.models[slot] = m.model;
        t.textureIndices[slot] = m.texture;
      }
      built.set("CMD", buildCmdFile(t.models, t.textureIndices));
      cmdOverTemplate = true;
    } catch (e) {
      warn(`the template's CMD could not be read (${e.message}); carried as it is, so the ship and the items show its models`);
    }
  }
  const cmdOurs = !templateCmd || cmdOverTemplate;
  common.models = cmdOurs ? [...cmd.entries()].map(([slot, m]) => ({ slot, texture: m.texture, key: m.key })) : [];
  if (!templateFiles.has("CBL")) {
    const items = {};
    if (cmdOurs) {
      CBL_ITEMS.forEach((item, k) => {
        const slot = N64_ITEM_MODELS[k];
        if (cmd.has(slot)) items[item] = itemEntry(slot, N64_ITEM_SCALES[k]);
      });
    }
    built.set("CBL", buildCbl({ items }));
  }
  const shipOurs = cmdOurs && cmd.has(N64_PLAYER_MODEL);
  if (gam.length) gam[GAM_OFFSETS.finalStage] = finalStage;
  if (gamKnown && shipOurs) {
    gam[GAM_OFFSETS.playerScale] = N64_SPRITE_SCALE >> 8;
    gam[GAM_OFFSETS.playerScale + 1] = N64_SPRITE_SCALE & 255;
    gam.fill(N64_PLAYER_MODEL, GAM_OFFSETS.playerModels, GAM_OFFSETS.playerModels + 4);
  }
  built.set("GAM", gam);
  if (!templateFiles.has("MUS")) built.set("MUS", buildMusFile([]));
  if (!templateFiles.has("ULB")) built.set("ULB", buildUlbFile([], []));
  const files = [];
  const sources = [];
  const sheets = /* @__PURE__ */ new Set(["CGR", ...stagePlan.map((_, i) => `${STAGES[i]}GR`)]);
  for (const ext of projectExts()) {
    let data;
    let source;
    const fromTemplate = templateFiles.get(ext);
    if (ext === "CGR") {
      data = cgr.bytes;
      source = fromTemplate ? "art over template" : "art";
    } else if (built.has(ext)) {
      data = built.get(ext);
      if (sheets.has(ext)) source = fromTemplate ? "art over template" : "art";
      else if (ext === "GAM" && fromTemplate) {
        source = `template${gamRepaired ? " in the cartridge's layout" : ""}, final stage${gamKnown && shipOurs ? " and ship" : ""} set`;
      } else if (ext === "CMD" && fromTemplate) source = "template, ship and items set";
      else source = "records";
    } else if (fromTemplate) {
      data = fromTemplate;
      source = "template";
    } else {
      data = new Uint8Array(fileSizeFor(ext) ?? 0);
      source = "blank";
    }
    files.push({ ext, data });
    sources.push({ ext, bytes: data.length, source });
  }
  for (const ext of templateFiles.keys()) {
    if (!projectExts().includes(ext)) warn(`template file ${ext} is not one of a project's thirty and was not written`);
  }
  const report = {
    name,
    template: templateFiles.size ? [...templateFiles.keys()] : null,
    ship: shipSource,
    finalStage,
    common: { textures: cgr.placed, painted: cgr.painted, used: cgr.count - cgr.free, free: cgr.free, missed: common.missed, scaled: common.scaled, models: common.models, hud },
    gam: { repaired: gamRepaired, ship: gamKnown && shipOurs },
    stages: stageReports,
    // How the project's bosses carry their second stages (boss-stage2.js).
    transform: splits.length ? `approximated: two chained bosses across a stage break (${splits.map((x) => `${x.stage} ${x.name}, then ${x.into} its second form ${x.second}`).join("; ")}); the bullets are the project's own two, not the weapons' art` : "none",
    splits,
    files: sources,
    bytes: files.reduce((a, f) => a + f.data.length, 0)
  };
  return { name, files, report, warnings };
}

// packages/shmup-engine/src/n64/export-ddd.js
function dddFileName(title, format = "ndd") {
  const clean = String(title || "game").replace(/[\\/:*?"<>|]+/g, "-").trim() || "game";
  return `Dezaemon 3D - ${clean}.${format === "ddd" ? "ddd" : "ndd"}`;
}
function templateFromDisk(image, name = null) {
  const projects = readProjects(image);
  const pick = name ? projects.find((p) => p.name === String(name).toUpperCase()) : projects[0];
  if (!pick) return null;
  return { name: pick.name, files: pick.files.map((f) => ({ ext: f.ext, data: Uint8Array.from(decompress(f.stream)) })) };
}
function exportLevelToDdd(level, art2, options = {}) {
  const { disk = null, format = "ndd", systemArea, template: templateOption = disk ? "disk" : null, ...projectOptions } = options;
  if (disk !== null && !imageFormat(disk)) throw new Error(`the donor disk is ${disk.length} bytes, neither a .ddd nor an .ndd`);
  let template = null;
  let templateName = null;
  if (templateOption === "disk" || typeof templateOption === "string" && templateOption !== "") {
    if (disk === null) throw new Error("a template project needs a donor disk to come from");
    const t = templateFromDisk(disk, templateOption === "disk" ? null : templateOption);
    if (!t) throw new Error(templateOption === "disk" ? "the donor disk has no project to use as a template" : `the donor disk has no project named ${templateOption}`);
    template = t.files;
    templateName = t.name;
  } else if (Array.isArray(templateOption) || templateOption instanceof Map) {
    template = templateOption;
  }
  const project = buildN64ProjectFromLevel(level, art2, { ...projectOptions, template });
  const built = buildDisk({ base: disk, projects: [{ name: project.name, files: project.files }], format, systemArea });
  const title = level && level.name || project.name;
  return {
    image: built.image,
    format: built.format,
    fileName: dddFileName(title, built.format),
    name: project.name,
    project: project.report,
    directory: built.directory,
    report: { ...built.report, project: project.report, templateProject: templateName, transform: project.report.transform },
    warnings: [...project.warnings, ...built.warnings]
  };
}

// packages/shmup-engine/src/n64/regions.js
function region3(name, label, offset, end, confidence, note) {
  return Object.freeze({ name, label, offset, end, length: end - offset, confidence, note });
}
var N64_REGIONS = Object.freeze([
  region3(
    "boot",
    "IPL PROGRAM",
    0,
    168992,
    "confirmed",
    "A complete libultra executable, load address 0x80000400, entry 0x80000560. The entry stub's bzero loop gives the BSS bounds (t0 = 0x80029820, length 0x48180) and the 0xFF filler begins on exactly the byte BSS starts, which pins both the load address and the image end. Holds ~3.9 KB of 64DD block-mode driver (ASIC registers 0x05000508/0x05000510, sector buffer 0x05000000) and the romaji 'KONO DISK WA DEZA64 DATA DISK DESU' notice at 0x28E80. It contains no filesystem code at all: no filename constant, no DEZA3D, no extension table, and all 274 'jr ra' instructions in the whole 64 MB fall inside it. The filesystem lives on the cartridge."
  ),
  region3(
    "bootPad",
    "IPL PAD",
    168992,
    177480,
    "open",
    "Between the end of the program image and the first file at LBA 9. Not read by anything here."
  ),
  region3(
    "files",
    "SAMPLE FILES",
    177480,
    7106952,
    "confirmed",
    "The 60 LZSS streams of the two pressed sample projects, laid end to end in directory order with no padding between them. Every one extracts, and 58 of the 60 decompress to exactly the size the published format documentation predicts."
  ),
  region3(
    "blank",
    "UNWRITTEN",
    7106952,
    25995720,
    "confirmed",
    "18,888,768 bytes of 0xFF: unwritten media, not corruption, and the only 0xFF run of any size in the image. The ROM area ends flush against it \u2014 the last sample file's extent ends at 0x6C7187."
  ),
  region3(
    "saveArea",
    "SAVE AREA",
    25995720,
    DDD_IMAGE_BYTES,
    "likely",
    "The writable half of the disk: the read-only directory and its two backup copies, the writable directory with its allocation map, and the DST user project. Note that 64dd.org labels this dump the old one \u2014 it differs from the current deza1.NDD in 175,897 bytes, every one of them inside this region. Read DST from deza1.NDD, not from this fixture."
  )
]);
var REGION = Object.freeze(Object.fromEntries(N64_REGIONS.map((r) => [r.name, r])));
var CONFIDENCES2 = Object.freeze(["confirmed", "likely", "open"]);

// packages/shmup-engine/src/n64/xz.js
var XZ_MAGIC = [253, 55, 122, 88, 90, 0];
var XZ_FOOTER_MAGIC = [89, 90];
var FILTER_LZMA2 = 33;
var FILTER_NAMES = {
  3: "Delta",
  4: "BCJ x86",
  5: "BCJ PowerPC",
  6: "BCJ IA-64",
  7: "BCJ ARM",
  8: "BCJ ARM-Thumb",
  9: "BCJ SPARC",
  10: "BCJ ARM64",
  11: "BCJ RISC-V",
  33: "LZMA2"
};
var XZ_CHECKS = Object.freeze([
  { name: "none", size: 0 },
  { name: "CRC32", size: 4 },
  { name: "reserved", size: 4 },
  { name: "reserved", size: 4 },
  { name: "CRC64", size: 8 },
  { name: "reserved", size: 8 },
  { name: "reserved", size: 8 },
  { name: "reserved", size: 16 },
  { name: "reserved", size: 16 },
  { name: "reserved", size: 16 },
  { name: "SHA-256", size: 32 },
  { name: "reserved", size: 32 },
  { name: "reserved", size: 32 },
  { name: "reserved", size: 64 },
  { name: "reserved", size: 64 },
  { name: "reserved", size: 64 }
].map(Object.freeze));
var CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
  CRC32_TABLE[i] = c >>> 0;
}
function crc32(bytes, start = 0, end = bytes.length) {
  let c = 4294967295;
  for (let i = start; i < end; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
var CRC64_LO = new Uint32Array(256);
var CRC64_HI = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let lo = i, hi = 0;
  for (let k = 0; k < 8; k++) {
    const bit = lo & 1;
    lo = (lo >>> 1 | hi << 31) >>> 0;
    hi = hi >>> 1;
    if (bit) {
      lo = (lo ^ 3615952706) >>> 0;
      hi = (hi ^ 3379320725) >>> 0;
    }
  }
  CRC64_LO[i] = lo;
  CRC64_HI[i] = hi;
}
function crc64(bytes, start = 0, end = bytes.length) {
  let lo = 4294967295, hi = 4294967295;
  for (let i = start; i < end; i++) {
    const idx = (lo ^ bytes[i]) & 255;
    lo = ((lo >>> 8 | hi << 24) ^ CRC64_LO[idx]) >>> 0;
    hi = (hi >>> 8 ^ CRC64_HI[idx]) >>> 0;
  }
  return { lo: (lo ^ 4294967295) >>> 0, hi: (hi ^ 4294967295) >>> 0 };
}
function readU32LE(bytes, at) {
  return (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;
}
function readVli(bytes, at, end) {
  let value = 0, scale = 1;
  for (let i = 0; i < 9; i++) {
    if (at + i >= end) return null;
    const b = bytes[at + i];
    value += (b & 127) * scale;
    if ((b & 128) === 0) {
      if (i > 0 && b === 0) throw new Error("XZ: multibyte integer with a redundant trailing byte");
      return { value, next: at + i + 1 };
    }
    scale *= 128;
  }
  throw new Error("XZ: multibyte integer longer than 9 bytes");
}
var PROB_INIT = 1024;
var IS_MATCH = 0;
var IS_REP = IS_MATCH + 192;
var IS_REP_G0 = IS_REP + 12;
var IS_REP_G1 = IS_REP_G0 + 12;
var IS_REP_G2 = IS_REP_G1 + 12;
var IS_REP0_LONG = IS_REP_G2 + 12;
var POS_SLOT = IS_REP0_LONG + 192;
var SPEC_POS = POS_SLOT + 256;
var ALIGN = SPEC_POS + 115;
var LEN_CODER = ALIGN + 16;
var REP_LEN_CODER = LEN_CODER + 514;
var LITERAL = REP_LEN_CODER + 514;
var LEN_CHOICE = 0;
var LEN_CHOICE2 = 1;
var LEN_LOW = 2;
var LEN_MID = 2 + 128;
var LEN_HIGH = 2 + 256;
var END_POS_MODEL_INDEX = 14;
var MATCH_MIN_LEN = 2;
var LzmaState = class {
  constructor() {
    this.out = new Uint8Array(1 << 16);
    this.outLength = 0;
    this.dictStart = 0;
    this.dictSize = 0;
    this.lc = 0;
    this.lp = 0;
    this.pb = 0;
    this.probs = null;
    this.state = 0;
    this.rep0 = 0;
    this.rep1 = 0;
    this.rep2 = 0;
    this.rep3 = 0;
    this.range = 0;
    this.code = 0;
    this.input = null;
    this.inPos = 0;
    this.inEnd = 0;
  }
  reserve(extra) {
    const need2 = this.outLength + extra;
    if (need2 <= this.out.length) return;
    let size = this.out.length * 2;
    while (size < need2) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.out.subarray(0, this.outLength));
    this.out = grown;
  }
  setProps(byte) {
    if (byte >= 9 * 5 * 5) throw new Error(`LZMA2: properties byte 0x${byte.toString(16)} is out of range`);
    const lc = byte % 9;
    const rest = (byte - lc) / 9;
    const lp = rest % 5;
    const pb = (rest - lp) / 5;
    if (lc + lp > 4) throw new Error(`LZMA2: lc + lp = ${lc + lp}, more than the 4 LZMA2 allows`);
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    this.probs = new Uint16Array(LITERAL + (768 << lc + lp));
  }
  resetState() {
    this.probs.fill(PROB_INIT);
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }
  resetDict() {
    this.dictStart = this.outLength;
  }
  appendPlain(bytes, start, end) {
    this.reserve(end - start);
    this.out.set(bytes.subarray(start, end), this.outLength);
    this.outLength += end - start;
  }
  // --- range decoder
  rcInit(input, at, end) {
    if (end - at < 5) throw new Error("LZMA: chunk shorter than the range coder's 5 initial bytes");
    if (input[at] !== 0) throw new Error("LZMA: the range coder's first byte is not zero");
    this.code = (input[at + 1] << 24 | input[at + 2] << 16 | input[at + 3] << 8 | input[at + 4]) >>> 0;
    this.range = 4294967295;
    if (this.code === this.range) throw new Error("LZMA: corrupted range coder state");
    this.input = input;
    this.inPos = at + 5;
    this.inEnd = end;
  }
  rcByte() {
    if (this.inPos >= this.inEnd) throw new Error("LZMA: chunk's compressed data ends early");
    return this.input[this.inPos++];
  }
  bit(i) {
    const probs = this.probs;
    const prob = probs[i];
    const bound = (this.range >>> 11) * prob;
    let bit;
    if (this.code < bound) {
      probs[i] = prob + (2048 - prob >> 5);
      this.range = bound;
      bit = 0;
    } else {
      probs[i] = prob - (prob >> 5);
      this.code -= bound;
      this.range -= bound;
      bit = 1;
    }
    if (this.range < 16777216) {
      this.range = this.range << 8 >>> 0;
      this.code = (this.code << 8 | this.rcByte()) >>> 0;
    }
    return bit;
  }
  directBits(count) {
    let result = 0;
    for (let i = 0; i < count; i++) {
      this.range = this.range >>> 1;
      this.code -= this.range;
      let bit = 1;
      if (this.code < 0) {
        this.code += this.range;
        bit = 0;
      }
      if (this.code === this.range) throw new Error("LZMA: corrupted range coder state");
      if (this.range < 16777216) {
        this.range = this.range << 8 >>> 0;
        this.code = (this.code << 8 | this.rcByte()) >>> 0;
      }
      result = result * 2 + bit;
    }
    return result;
  }
  bitTree(base, numBits) {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) + this.bit(base + m);
    return m - (1 << numBits);
  }
  bitTreeReverse(base, numBits) {
    let m = 1, symbol = 0;
    for (let i = 0; i < numBits; i++) {
      const b = this.bit(base + m);
      m = (m << 1) + b;
      symbol |= b << i;
    }
    return symbol;
  }
  decodeLen(base, posState) {
    if (this.bit(base + LEN_CHOICE) === 0) return this.bitTree(base + LEN_LOW + posState * 8, 3);
    if (this.bit(base + LEN_CHOICE2) === 0) return 8 + this.bitTree(base + LEN_MID + posState * 8, 3);
    return 16 + this.bitTree(base + LEN_HIGH, 8);
  }
  decodeDistance(len) {
    const lenState = len < 3 ? len : 3;
    const posSlot = this.bitTree(POS_SLOT + lenState * 64, 6);
    if (posSlot < 4) return posSlot;
    const numDirectBits = (posSlot >> 1) - 1;
    let dist = (2 | posSlot & 1) * Math.pow(2, numDirectBits);
    if (posSlot < END_POS_MODEL_INDEX) {
      dist += this.bitTreeReverse(SPEC_POS + dist - posSlot, numDirectBits);
    } else {
      dist += this.directBits(numDirectBits - 4) * 16;
      dist += this.bitTreeReverse(ALIGN, 4);
    }
    return dist;
  }
  /**
   * Decode one LZMA2 compressed chunk: exactly `unpacked` bytes out of
   * exactly `packed` bytes in, with no end marker, continuing the state.
   */
  decodeChunk(input, at, packed, unpacked) {
    this.rcInit(input, at, at + packed);
    this.reserve(unpacked);
    const out = this.out;
    const end = this.outLength + unpacked;
    const dictStart = this.dictStart;
    const dictSize = this.dictSize;
    const lc = this.lc;
    const lpMask = (1 << this.lp) - 1;
    const pbMask = (1 << this.pb) - 1;
    let outPos = this.outLength;
    let state = this.state;
    let rep0 = this.rep0, rep1 = this.rep1, rep2 = this.rep2, rep3 = this.rep3;
    while (outPos < end) {
      const pos = outPos - dictStart;
      const posState = pos & pbMask;
      if (this.bit(IS_MATCH + (state << 4) + posState) === 0) {
        const prevByte = pos > 0 ? out[outPos - 1] : 0;
        const litBase = LITERAL + 768 * (((pos & lpMask) << lc) + (prevByte >> 8 - lc));
        let symbol = 1;
        if (state >= 7) {
          let matchByte = out[outPos - rep0 - 1];
          do {
            const matchBit = matchByte >> 7 & 1;
            matchByte <<= 1;
            const b = this.bit(litBase + (1 + matchBit << 8) + symbol);
            symbol = symbol << 1 | b;
            if (matchBit !== b) break;
          } while (symbol < 256);
        }
        while (symbol < 256) symbol = symbol << 1 | this.bit(litBase + symbol);
        out[outPos++] = symbol & 255;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let len;
      if (this.bit(IS_REP + state) !== 0) {
        if (pos === 0) throw new Error("LZMA: repeat match before any dictionary");
        if (this.bit(IS_REP_G0 + state) === 0) {
          if (this.bit(IS_REP0_LONG + (state << 4) + posState) === 0) {
            if (rep0 >= pos) throw new Error("LZMA: match distance past the dictionary");
            state = state < 7 ? 9 : 11;
            out[outPos] = out[outPos - rep0 - 1];
            outPos++;
            continue;
          }
        } else {
          let dist;
          if (this.bit(IS_REP_G1 + state) === 0) {
            dist = rep1;
          } else {
            if (this.bit(IS_REP_G2 + state) === 0) {
              dist = rep2;
            } else {
              dist = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist;
        }
        len = this.decodeLen(REP_LEN_CODER, posState);
        state = state < 7 ? 8 : 11;
      } else {
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        len = this.decodeLen(LEN_CODER, posState);
        state = state < 7 ? 7 : 10;
        rep0 = this.decodeDistance(len);
        if (rep0 === 4294967295) throw new Error("LZMA: end marker inside an LZMA2 chunk");
        if (rep0 >= dictSize) throw new Error("LZMA: match distance larger than the dictionary");
      }
      if (rep0 >= pos) throw new Error("LZMA: match distance past the dictionary");
      len += MATCH_MIN_LEN;
      if (outPos + len > end) throw new Error("LZMA: match runs past the end of its chunk");
      let src = outPos - rep0 - 1;
      for (let i = 0; i < len; i++) out[outPos++] = out[src++];
    }
    if (this.inPos !== this.inEnd) throw new Error(`LZMA: chunk left ${this.inEnd - this.inPos} compressed bytes unread`);
    if (this.code !== 0) throw new Error("LZMA: range coder did not finish cleanly");
    this.outLength = outPos;
    this.state = state;
    this.rep0 = rep0;
    this.rep1 = rep1;
    this.rep2 = rep2;
    this.rep3 = rep3;
  }
};
var XzDecoder = class {
  /**
   * @param {{verify?: boolean}} [options]  verify: check header CRCs and
   *   CRC32/CRC64 block checks (default true)
   */
  constructor({ verify = true } = {}) {
    this.verify = verify;
    this.phase = "stream-header";
    this.pending = null;
    this.checkType = 0;
    this.streamFlags = null;
    this.blocks = [];
    this.block = null;
    this.blockOutStart = 0;
    this.indexStart = 0;
    this.indexSize = 0;
    this.needDictReset = true;
    this.needProps = true;
    this.needState = true;
    this.finished = false;
    this.lzma = new LzmaState();
  }
  /** Everything decoded so far, as a view. */
  get output() {
    return this.lzma.out.subarray(0, this.lzma.outLength);
  }
  /** Bytes of a partial unit waiting for more input. */
  get pendingLength() {
    return this.pending ? this.pending.length : 0;
  }
  /**
   * Feed the next piece of the stream.
   * @param {Uint8Array} bytes
   * @returns {Uint8Array} the bytes this piece produced (a view into the decoder's buffer)
   */
  decode(bytes) {
    let input = bytes;
    if (this.pending) {
      input = new Uint8Array(this.pending.length + bytes.length);
      input.set(this.pending);
      input.set(bytes, this.pending.length);
      this.pending = null;
    }
    const from = this.lzma.outLength;
    let at = 0;
    const end = input.length;
    while (at < end) {
      const next = this.step(input, at, end);
      if (next === null) {
        this.pending = input.slice(at);
        break;
      }
      at = next;
    }
    return this.lzma.out.subarray(from, this.lzma.outLength);
  }
  /**
   * Declare the input over. Throws if a unit was cut short, or, with
   * complete, if the stream never reached its footer.
   * @param {{complete?: boolean}} [options]
   */
  end({ complete = false } = {}) {
    if (this.pending) {
      throw new Error(`XZ: input ends ${this.pendingLength} bytes into an unfinished ${this.phase.replace("-", " ")} unit`);
    }
    if (complete && !this.finished) {
      throw new Error(`XZ: stream has no footer (stopped in its ${this.phase.replace("-", " ")})`);
    }
  }
  /** One unit at `at`; the position after it, or null when it is incomplete. */
  step(input, at, end) {
    switch (this.phase) {
      case "stream-header":
        return this.streamHeader(input, at, end);
      case "block-or-index":
        return input[at] === 0 ? this.index(input, at, end) : this.blockHeader(input, at, end);
      case "chunks":
        return this.chunk(input, at, end);
      case "block-check":
        return this.blockCheck(input, at, end);
      case "footer":
        return this.footer(input, at, end);
      case "done":
        return this.afterStream(input, at, end);
      default:
        throw new Error(`XZ: unknown phase ${this.phase}`);
    }
  }
  streamHeader(input, at, end) {
    if (end - at < 12) return null;
    for (let i = 0; i < 6; i++) {
      if (input[at + i] !== XZ_MAGIC[i]) throw new Error("XZ: not an .xz stream (bad magic)");
    }
    const flags0 = input[at + 6], flags1 = input[at + 7];
    if (flags0 !== 0 || (flags1 & 240) !== 0) throw new Error("XZ: reserved stream flag bits are set");
    if (this.verify && crc32(input, at + 6, at + 8) !== readU32LE(input, at + 8)) {
      throw new Error("XZ: stream header CRC32 mismatch");
    }
    this.checkType = flags1 & 15;
    this.streamFlags = [flags0, flags1];
    this.phase = "block-or-index";
    return at + 12;
  }
  blockHeader(input, at, end) {
    const size = (input[at] + 1) * 4;
    if (end - at < size) return null;
    const flags = input[at + 1];
    if ((flags & 60) !== 0) throw new Error("XZ: reserved block flag bits are set");
    const filterCount = (flags & 3) + 1;
    let p = at + 2;
    const limit = at + size - 4;
    let declaredCompressed = null, declaredUncompressed = null;
    if (flags & 64) {
      const v = readVli(input, p, limit);
      if (!v) throw new Error("XZ: block header ends inside its compressed size");
      declaredCompressed = v.value;
      p = v.next;
    }
    if (flags & 128) {
      const v = readVli(input, p, limit);
      if (!v) throw new Error("XZ: block header ends inside its uncompressed size");
      declaredUncompressed = v.value;
      p = v.next;
    }
    let dictSize = 0;
    for (let f = 0; f < filterCount; f++) {
      const id = readVli(input, p, limit);
      if (!id) throw new Error("XZ: block header ends inside a filter id");
      const propsSize = readVli(input, id.next, limit);
      if (!propsSize) throw new Error("XZ: block header ends inside a filter's property size");
      p = propsSize.next + propsSize.value;
      if (p > limit) throw new Error("XZ: filter properties run past the block header");
      if (id.value !== FILTER_LZMA2 || filterCount !== 1) {
        const name = FILTER_NAMES[id.value] || "unknown";
        throw new Error(`XZ: filter 0x${id.value.toString(16)} (${name}) is not supported; only a lone LZMA2 filter is, which is all xdelta3 and xz write by default`);
      }
      if (propsSize.value !== 1) throw new Error("XZ: LZMA2 properties are not one byte");
      const bits = input[propsSize.next] & 63;
      if (bits > 40) throw new Error("XZ: LZMA2 dictionary size code out of range");
      dictSize = bits === 40 ? 4294967295 : (2 | bits & 1) * Math.pow(2, Math.floor(bits / 2) + 11);
    }
    for (; p < limit; p++) {
      if (input[p] !== 0) throw new Error("XZ: block header padding is not zero");
    }
    if (this.verify && crc32(input, at, limit) !== readU32LE(input, limit)) {
      throw new Error("XZ: block header CRC32 mismatch");
    }
    this.block = {
      headerSize: size,
      compressedSize: 0,
      uncompressedSize: 0,
      declaredCompressedSize: declaredCompressed,
      declaredUncompressedSize: declaredUncompressed,
      dictSize
    };
    this.blocks.push(this.block);
    this.blockOutStart = this.lzma.outLength;
    this.lzma.dictSize = dictSize;
    this.needDictReset = true;
    this.needProps = true;
    this.needState = true;
    this.phase = "chunks";
    return at + size;
  }
  chunk(input, at, end) {
    const control = input[at];
    const lzma = this.lzma;
    if (control === 0) {
      this.block.compressedSize += 1;
      this.phase = "block-check";
      return at + 1;
    }
    if (control === 1 || control === 2) {
      if (end - at < 3) return null;
      const size = (input[at + 1] << 8 | input[at + 2]) + 1;
      if (end - at < 3 + size) return null;
      if (control === 1) {
        lzma.resetDict();
        this.needDictReset = false;
        this.needProps = true;
        this.needState = true;
      } else if (this.needDictReset) {
        throw new Error("LZMA2: first chunk does not reset the dictionary");
      }
      lzma.appendPlain(input, at + 3, at + 3 + size);
      this.block.compressedSize += 3 + size;
      this.block.uncompressedSize += size;
      return at + 3 + size;
    }
    if (control < 128) throw new Error(`LZMA2: invalid chunk control byte 0x${control.toString(16)}`);
    const mode = control >> 5 & 3;
    const headerSize = mode >= 2 ? 6 : 5;
    if (end - at < headerSize) return null;
    const unpacked = ((control & 31) << 16) + (input[at + 1] << 8 | input[at + 2]) + 1;
    const packed = (input[at + 3] << 8 | input[at + 4]) + 1;
    if (end - at < headerSize + packed) return null;
    if (mode === 3) {
      lzma.resetDict();
      this.needDictReset = false;
    } else if (this.needDictReset) {
      throw new Error("LZMA2: first chunk does not reset the dictionary");
    }
    if (mode >= 2) {
      lzma.setProps(input[at + 5]);
      this.needProps = false;
    } else if (this.needProps) {
      throw new Error("LZMA2: chunk needs properties none was given");
    }
    if (mode >= 1) {
      lzma.resetState();
      this.needState = false;
    } else if (this.needState) {
      throw new Error("LZMA2: chunk continues a state that was never set");
    }
    lzma.decodeChunk(input, at + headerSize, packed, unpacked);
    this.block.compressedSize += headerSize + packed;
    this.block.uncompressedSize += unpacked;
    return at + headerSize + packed;
  }
  blockCheck(input, at, end) {
    const block = this.block;
    const padding = (4 - block.compressedSize % 4) % 4;
    const checkSize = XZ_CHECKS[this.checkType].size;
    if (end - at < padding + checkSize) return null;
    for (let i = 0; i < padding; i++) {
      if (input[at + i] !== 0) throw new Error("XZ: block padding is not zero");
    }
    if (block.declaredCompressedSize !== null && block.declaredCompressedSize !== block.compressedSize) {
      throw new Error(`XZ: block holds ${block.compressedSize} compressed bytes, header said ${block.declaredCompressedSize}`);
    }
    if (block.declaredUncompressedSize !== null && block.declaredUncompressedSize !== block.uncompressedSize) {
      throw new Error(`XZ: block decoded to ${block.uncompressedSize} bytes, header said ${block.declaredUncompressedSize}`);
    }
    if (this.verify) {
      const out = this.lzma.out, from = this.blockOutStart, to = this.lzma.outLength;
      const checkAt = at + padding;
      if (this.checkType === 1) {
        if (crc32(out, from, to) !== readU32LE(input, checkAt)) throw new Error("XZ: block CRC32 mismatch");
      } else if (this.checkType === 4) {
        const got = crc64(out, from, to);
        if (got.lo !== readU32LE(input, checkAt) || got.hi !== readU32LE(input, checkAt + 4)) {
          throw new Error("XZ: block CRC64 mismatch");
        }
      }
    }
    this.block = null;
    this.phase = "block-or-index";
    return at + padding + checkSize;
  }
  index(input, at, end) {
    const count = readVli(input, at + 1, end);
    if (!count) return null;
    let p = count.next;
    const records = [];
    for (let i = 0; i < count.value; i++) {
      const unpadded = readVli(input, p, end);
      if (!unpadded) return null;
      const uncompressed = readVli(input, unpadded.next, end);
      if (!uncompressed) return null;
      records.push({ unpaddedSize: unpadded.value, uncompressedSize: uncompressed.value });
      p = uncompressed.next;
    }
    const padding = (4 - (p - at) % 4) % 4;
    if (end < p + padding + 4) return null;
    for (let i = 0; i < padding; i++) {
      if (input[p + i] !== 0) throw new Error("XZ: index padding is not zero");
    }
    if (this.verify && crc32(input, at, p + padding) !== readU32LE(input, p + padding)) {
      throw new Error("XZ: index CRC32 mismatch");
    }
    if (records.length !== this.blocks.length) {
      throw new Error(`XZ: index lists ${records.length} blocks, the stream had ${this.blocks.length}`);
    }
    const checkSize = XZ_CHECKS[this.checkType].size;
    records.forEach((record, i) => {
      const block = this.blocks[i];
      const unpadded = block.headerSize + block.compressedSize + checkSize;
      if (record.unpaddedSize !== unpadded || record.uncompressedSize !== block.uncompressedSize) {
        throw new Error(`XZ: index record ${i} disagrees with block ${i} (${record.unpaddedSize}/${record.uncompressedSize} vs ${unpadded}/${block.uncompressedSize})`);
      }
    });
    this.indexStart = at;
    this.indexSize = p + padding + 4 - at;
    this.phase = "footer";
    return p + padding + 4;
  }
  footer(input, at, end) {
    if (end - at < 12) return null;
    if (this.verify && crc32(input, at + 4, at + 10) !== readU32LE(input, at)) {
      throw new Error("XZ: stream footer CRC32 mismatch");
    }
    const backward = (readU32LE(input, at + 4) + 1) * 4;
    if (backward !== this.indexSize) {
      throw new Error(`XZ: footer's backward size ${backward} is not the index's ${this.indexSize}`);
    }
    if (input[at + 8] !== this.streamFlags[0] || input[at + 9] !== this.streamFlags[1]) {
      throw new Error("XZ: footer's stream flags differ from the header's");
    }
    if (input[at + 10] !== XZ_FOOTER_MAGIC[0] || input[at + 11] !== XZ_FOOTER_MAGIC[1]) {
      throw new Error("XZ: bad stream footer magic");
    }
    this.finished = true;
    this.phase = "done";
    return at + 12;
  }
  /** After a footer: zero padding in fours, or another stream. */
  afterStream(input, at, end) {
    if (input[at] === XZ_MAGIC[0]) {
      this.phase = "stream-header";
      this.finished = false;
      this.blocks = [];
      return at;
    }
    if (end - at < 4) return null;
    for (let i = 0; i < 4; i++) {
      if (input[at + i] !== 0) throw new Error("XZ: bytes after the stream footer are neither padding nor a stream");
    }
    return at + 4;
  }
};

// packages/shmup-engine/src/n64/vcdiff.js
var VCDIFF_MAGIC = [214, 195, 196, 0];
var VCD_DECOMPRESS = 1;
var VCD_CODETABLE = 2;
var VCD_APPHEADER = 4;
var VCD_SOURCE = 1;
var VCD_TARGET = 2;
var VCD_ADLER32 = 4;
var VCD_DATACOMP = 1;
var VCD_INSTCOMP = 2;
var VCD_ADDRCOMP = 4;
var VCD_SECONDARY_NAMES = Object.freeze({ 1: "DJW", 2: "LZMA", 16: "FGK" });
var NOOP = 0;
var ADD = 1;
var RUN = 2;
var COPY = 3;
var NEAR_SLOTS = 4;
var SAME_SLOTS = 3;
var VCDIFF_CODE_TABLE = (() => {
  const table = [];
  const put = (t1, s1, m1, t2 = NOOP, s2 = 0, m2 = 0) => table.push(Object.freeze([t1, s1, m1, t2, s2, m2]));
  put(RUN, 0, 0);
  for (let size = 0; size <= 17; size++) put(ADD, size, 0);
  for (let mode = 0; mode < 9; mode++) {
    put(COPY, 0, mode);
    for (let size = 4; size <= 18; size++) put(COPY, size, mode);
  }
  for (let mode = 0; mode < 9; mode++) {
    for (let addSize = 1; addSize <= 4; addSize++) {
      const copySizes = mode < 6 ? [4, 5, 6] : [4];
      for (const copySize of copySizes) put(ADD, addSize, 0, COPY, copySize, mode);
    }
  }
  for (let mode = 0; mode < 9; mode++) put(COPY, 4, mode, ADD, 1, 0);
  if (table.length !== 256) throw new Error(`code table has ${table.length} entries`);
  return Object.freeze(table);
})();
function adler32(bytes, start = 0, end = bytes.length) {
  let a = 1, b = 0;
  let at = start;
  while (at < end) {
    const stop = Math.min(end, at + 5552);
    for (; at < stop; at++) {
      a += bytes[at];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return (b << 16 | a) >>> 0;
}
function hex8(n) {
  return n.toString(16).padStart(8, "0");
}
var Reader = class {
  constructor(bytes, at = 0, end = bytes.length, what = "patch") {
    this.bytes = bytes;
    this.at = at;
    this.end = end;
    this.what = what;
  }
  byte(field2) {
    if (this.at >= this.end) throw new Error(`${this.what} ends at byte ${this.at}, inside ${field2}`);
    return this.bytes[this.at++];
  }
  int(field2) {
    let value = 0;
    for (let i = 0; i < 9; i++) {
      const b = this.byte(field2);
      value = value * 128 + (b & 127);
      if ((b & 128) === 0) return value;
    }
    throw new Error(`${this.what}: ${field2} is an integer longer than 9 bytes`);
  }
  take(count, field2) {
    if (this.at + count > this.end) throw new Error(`${this.what} ends at byte ${this.end}, inside ${field2} (${count} bytes from ${this.at})`);
    const slice = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return slice;
  }
};
function parseVcdiff(patch) {
  const r = new Reader(patch);
  for (let i = 0; i < 4; i++) {
    if (r.byte("the magic") !== VCDIFF_MAGIC[i]) throw new Error("not a VCDIFF patch (bad magic)");
  }
  const hdrIndicator = r.byte("hdr_indicator");
  if (hdrIndicator & ~(VCD_DECOMPRESS | VCD_CODETABLE | VCD_APPHEADER)) {
    throw new Error(`hdr_indicator 0x${hdrIndicator.toString(16)} has reserved bits set`);
  }
  let secondaryId = null;
  if (hdrIndicator & VCD_DECOMPRESS) {
    secondaryId = r.byte("the secondary compressor id");
    if (secondaryId !== 2) {
      const name = VCD_SECONDARY_NAMES[secondaryId] || "unknown";
      throw new Error(`secondary compressor ${secondaryId} (${name}) is not supported; only xdelta3's LZMA (2) is`);
    }
  }
  if (hdrIndicator & VCD_CODETABLE) {
    throw new Error("the patch carries a custom code table, which is not supported (xdelta3 never writes one)");
  }
  let appHeader = null;
  if (hdrIndicator & VCD_APPHEADER) {
    const length = r.int("the application header length");
    appHeader = r.take(length, "the application header");
  }
  const windows = [];
  let targetLength = 0;
  let sourceLengthNeeded = 0;
  let usesSource = false, usesTarget = false;
  while (r.at < r.end) {
    const index = windows.length;
    const w = new Reader(patch, r.at, r.end, `window ${index}`);
    const offset = w.at;
    const winIndicator = w.byte("win_indicator");
    if (winIndicator & ~(VCD_SOURCE | VCD_TARGET | VCD_ADLER32)) {
      throw new Error(`window ${index}: win_indicator 0x${winIndicator.toString(16)} has reserved bits set`);
    }
    if (winIndicator & VCD_SOURCE && winIndicator & VCD_TARGET) {
      throw new Error(`window ${index}: both VCD_SOURCE and VCD_TARGET are set`);
    }
    let segment = null;
    if (winIndicator & (VCD_SOURCE | VCD_TARGET)) {
      const length = w.int("the segment length");
      const position = w.int("the segment position");
      segment = { from: winIndicator & VCD_SOURCE ? "source" : "target", position, length };
    }
    const deltaLength = w.int("the delta encoding length");
    const deltaStart = w.at;
    const windowTarget = w.int("the target window length");
    const deltaIndicator = w.byte("del_indicator");
    if (deltaIndicator & ~(VCD_DATACOMP | VCD_INSTCOMP | VCD_ADDRCOMP)) {
      throw new Error(`window ${index}: del_indicator 0x${deltaIndicator.toString(16)} has reserved bits set`);
    }
    if (deltaIndicator !== 0 && secondaryId === null) {
      throw new Error(`window ${index}: sections are marked compressed but the header names no secondary compressor`);
    }
    const dataLength = w.int("the data section length");
    const instLength = w.int("the instruction section length");
    const addrLength = w.int("the address section length");
    let checksum = null;
    if (winIndicator & VCD_ADLER32) {
      const b = w.take(4, "the Adler-32");
      checksum = (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0;
    }
    const section = (name, length, bit) => {
      const compressed = (deltaIndicator & bit) !== 0;
      const start = w.at;
      const bytes = w.take(length, `the ${name} section`);
      if (!compressed) return { offset: start, length, compressed, decodedLength: length, payloadOffset: start };
      const s = new Reader(bytes, 0, bytes.length, `window ${index}'s ${name} section`);
      const decodedLength = s.int("the decoded length");
      if (decodedLength === 0) throw new Error(`window ${index}: the ${name} section decodes to 0 bytes`);
      return { offset: start, length, compressed, decodedLength, payloadOffset: start + s.at };
    };
    const data = section("data", dataLength, VCD_DATACOMP);
    const inst = section("inst", instLength, VCD_INSTCOMP);
    const addr = section("addr", addrLength, VCD_ADDRCOMP);
    if (w.at - deltaStart !== deltaLength) {
      throw new Error(`window ${index}: the delta encoding length says ${deltaLength} bytes, the sections add up to ${w.at - deltaStart}`);
    }
    if (segment) {
      if (segment.from === "source") {
        usesSource = true;
        sourceLengthNeeded = Math.max(sourceLengthNeeded, segment.position + segment.length);
      } else {
        usesTarget = true;
        if (segment.position + segment.length > targetLength) {
          throw new Error(`window ${index}: its target segment [${segment.position}, ${segment.position + segment.length}) is not decoded yet`);
        }
      }
    }
    windows.push({
      index,
      offset,
      winIndicator,
      segment,
      deltaLength,
      targetLength: windowTarget,
      targetOffset: targetLength,
      deltaIndicator,
      adler32: checksum,
      data,
      inst,
      addr
    });
    targetLength += windowTarget;
    r.at = w.at;
  }
  return {
    hdrIndicator,
    secondaryId,
    secondaryName: secondaryId === null ? null : VCD_SECONDARY_NAMES[secondaryId],
    appHeader,
    appHeaderText: appHeader ? String.fromCharCode(...appHeader) : null,
    windows,
    targetLength,
    sourceLengthNeeded,
    usesSource,
    usesTarget
  };
}
function makeDecoders() {
  return { data: null, inst: null, addr: null };
}
function sectionBytes(patch, window, name, decoders) {
  const section = window[name];
  if (!section.compressed) return patch.subarray(section.offset, section.offset + section.length);
  if (!decoders[name]) decoders[name] = new XzDecoder();
  const decoder = decoders[name];
  const out = decoder.decode(patch.subarray(section.payloadOffset, section.offset + section.length));
  if (decoder.pendingLength !== 0) {
    throw new Error(`window ${window.index}: the ${name} section ends inside a compressed unit`);
  }
  if (out.length !== section.decodedLength) {
    throw new Error(`window ${window.index}: the ${name} section decoded to ${out.length} bytes, not the ${section.decodedLength} it declares`);
  }
  return out;
}
function walkWindow(window, data, inst, addr, sink) {
  const segmentLength = window.segment ? window.segment.length : 0;
  const targetLength = window.targetLength;
  const instReader = new Reader(inst, 0, inst.length, `window ${window.index}'s instruction section`);
  const addrReader = new Reader(addr, 0, addr.length, `window ${window.index}'s address section`);
  const near = new Array(NEAR_SLOTS).fill(0);
  const same = new Array(SAME_SLOTS * 256).fill(0);
  let nextNear = 0;
  let dataAt = 0;
  let out = 0;
  const counts = { instructions: 0, add: 0, run: 0, copySource: 0, copyTarget: 0, addBytes: 0, runBytes: 0, copySourceBytes: 0, copyTargetBytes: 0, sourceLow: Infinity, sourceHigh: 0 };
  const decodeAddress = (mode, here) => {
    let address;
    if (mode === 0) {
      address = addrReader.int("an address");
    } else if (mode === 1) {
      address = here - addrReader.int("an address");
    } else if (mode < 2 + NEAR_SLOTS) {
      address = near[mode - 2] + addrReader.int("an address");
    } else {
      address = same[(mode - 2 - NEAR_SLOTS) * 256 + addrReader.byte("an address")];
    }
    near[nextNear] = address;
    nextNear = (nextNear + 1) % NEAR_SLOTS;
    same[address % (SAME_SLOTS * 256)] = address;
    return address;
  };
  const run = (type, size, mode) => {
    if (size === 0) size = instReader.int("an instruction size");
    if (out + size > targetLength) {
      throw new Error(`window ${window.index}: an instruction at output byte ${out} runs ${out + size - targetLength} bytes past the window`);
    }
    counts.instructions++;
    if (type === ADD) {
      if (dataAt + size > data.length) throw new Error(`window ${window.index}: ADD at output byte ${out} reads past the data section`);
      sink.add(data, dataAt, size);
      dataAt += size;
      counts.add++;
      counts.addBytes += size;
    } else if (type === RUN) {
      if (dataAt >= data.length) throw new Error(`window ${window.index}: RUN at output byte ${out} reads past the data section`);
      sink.run(data[dataAt++], size);
      counts.run++;
      counts.runBytes += size;
    } else {
      const here = segmentLength + out;
      const address = decodeAddress(mode, here);
      if (address >= here) {
        throw new Error(`window ${window.index}: COPY at output byte ${out} reads address ${address}, which is not written yet`);
      }
      if (address < segmentLength) {
        if (address + size > segmentLength) {
          throw new Error(`window ${window.index}: COPY at output byte ${out} runs past the ${window.segment.from} segment`);
        }
        sink.copy(address, size, true);
        counts.copySource++;
        counts.copySourceBytes += size;
        const low = window.segment.position + address;
        if (low < counts.sourceLow) counts.sourceLow = low;
        if (low + size > counts.sourceHigh) counts.sourceHigh = low + size;
      } else {
        sink.copy(address - segmentLength, size, false);
        counts.copyTarget++;
        counts.copyTargetBytes += size;
      }
    }
    out += size;
  };
  while (instReader.at < instReader.end) {
    const entry = VCDIFF_CODE_TABLE[instReader.byte("an instruction code")];
    run(entry[0], entry[1], entry[2]);
    if (entry[3] !== NOOP) run(entry[3], entry[4], entry[5]);
  }
  if (out !== targetLength) {
    throw new Error(`window ${window.index}: its instructions produce ${out} bytes, the header says ${targetLength}`);
  }
  if (dataAt !== data.length) {
    throw new Error(`window ${window.index}: ${data.length - dataAt} bytes of the data section are left over`);
  }
  if (addrReader.at !== addrReader.end) {
    throw new Error(`window ${window.index}: ${addrReader.end - addrReader.at} bytes of the address section are left over`);
  }
  if (counts.sourceLow === Infinity) counts.sourceLow = null;
  return counts;
}
function applyVcdiff(source, patch, { verify = true } = {}) {
  const parsed = parseVcdiff(patch);
  if (parsed.usesSource && source.length < parsed.sourceLengthNeeded) {
    throw new Error(`the source is ${source.length} bytes but the patch reads its first ${parsed.sourceLengthNeeded}`);
  }
  const target = new Uint8Array(parsed.targetLength);
  const decoders = makeDecoders();
  for (const window of parsed.windows) {
    const data = sectionBytes(patch, window, "data", decoders);
    const inst = sectionBytes(patch, window, "inst", decoders);
    const addr = sectionBytes(patch, window, "addr", decoders);
    const out = target.subarray(window.targetOffset, window.targetOffset + window.targetLength);
    let segment = null;
    if (window.segment) {
      const { from, position: position2, length } = window.segment;
      segment = (from === "source" ? source : target).subarray(position2, position2 + length);
    }
    let position = 0;
    walkWindow(window, data, inst, addr, {
      add(bytes, from, size) {
        out.set(bytes.subarray(from, from + size), position);
        position += size;
      },
      run(byte, size) {
        out.fill(byte, position, position + size);
        position += size;
      },
      copy(address, size, fromSegment) {
        if (fromSegment) {
          out.set(segment.subarray(address, address + size), position);
        } else if (address + size <= position) {
          out.set(out.subarray(address, address + size), position);
        } else {
          for (let i = 0; i < size; i++) out[position + i] = out[address + i];
        }
        position += size;
      }
    });
    if (verify && window.adler32 !== null) {
      const got = adler32(out);
      if (got !== window.adler32) {
        throw new Error(
          `window ${window.index} (target bytes ${window.targetOffset}..${window.targetOffset + window.targetLength}) checksum mismatch: the patch expects Adler-32 ${hex8(window.adler32)}, the output has ${hex8(got)}; the source is not the file this patch was made for`
        );
      }
    }
  }
  return target;
}

// packages/shmup-engine/src/n64/index.js
function isDddImage(bytes) {
  if (!isDddSize(bytes.length)) return false;
  const mark = "DEZA64 DATA DISK";
  for (let at = 163840; at < 172032 - mark.length; at++) {
    let hit = true;
    for (let i = 0; i < mark.length; i++) {
      if (bytes[at + i] !== mark.charCodeAt(i)) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
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
function u32le2(bytes, at) {
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
        lba: u32le2(data, off + 2),
        size: u32le2(data, off + 10),
        isDir: (data[off + 25] & 2) !== 0
      });
    }
    off += len;
  }
  return entries;
}
function rootRecord(disc) {
  const pvd = sector(disc, PVD_LBA);
  return { lba: u32le2(pvd, 156 + 2), size: u32le2(pvd, 156 + 10) };
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

// packages/shmup-engine/src/sfc/regions.js
function region4(name, label, offset, end, confidence, note) {
  return Object.freeze({ name, label, offset, end, length: end - offset, confidence, note });
}
var SFC_REGIONS = Object.freeze([
  region4(
    "checksum",
    "CHECK SUM",
    0,
    32,
    "confirmed",
    "16 words, copied verbatim at 0x7E5A. Traced in the ROM ($00:847B computes, $00:8482 verifies): each word is 0xFFFF minus the mod-2^16 sum of the 16-bit little-endian words over a scatter/gather segment list, the descriptors being a 17-pointer table at $80:8665. Word 15 covers the first fifteen, so the block always totals 0xFFFF. See FORMAT-SFC.md for the segment map."
  ),
  region4(
    "reserved0",
    "RESERVED",
    32,
    64,
    "confirmed",
    "Never read by the boot or load paths; zero but for the word 0x3160 at 0x3E in the ROM's default image."
  ),
  region4(
    "palette",
    "PALETTE DATA",
    64,
    832,
    "confirmed",
    "24 rows of 16 BGR555 little-endian words. Rows 0-5 colour the stages' scenery, 6-11 their enemies, 12-17 their bosses, 18 the ship, 19 the title and ending, 20 items and weapons, 21 is free; 22-23 are the editor's own colour picker (bit-15 words, never copied to CGRAM)."
  ),
  region4(
    "map",
    "MAP DATA",
    832,
    14656,
    "confirmed",
    "6 stages x 0x900: 128 rows of 18 bytes, row 0 the stage start. A row is two halves of eight cells and a flag byte: cell bit 7 = H flip, bits 0-6 = MAP GROUP slot; flag bit 7-k = V flip of cell k. 16 chips (256 px) wide, 2,048 px tall ($00:9B9C; rendered)."
  ),
  region4(
    "scroll",
    "SCROLL EFECT",
    14656,
    17728,
    "likely",
    "6 x 0x200: two 256-byte tables, one entry per 8-px band \u2014 +0x000 an effect index (cleared to i & 0x1F), +0x100 the band's scroll speed (cleared to 0x42; 0x40 reads as 1 px/frame). The play-time reader is untraced."
  ),
  region4(
    "mapGroup",
    "MAP GROUP",
    17728,
    19264,
    "confirmed",
    "6 stages x 128 chip words: word k is the chip copied into BG slot k, which a map cell names. 0xFFFF (or 0x03FF) is the blank chip; the editor clears a stage's table to 0xFF with word 0 = 0x03FF."
  ),
  region4(
    "myShipOdr",
    "MY SHIP ODR",
    19264,
    19328,
    "confirmed",
    "64 bytes, 56 used: bits 6-7 are the V/H flips of the ship sheet's chips 0-55 ($00:9D8B); zero in both dumps."
  ),
  region4(
    "enemyGroup",
    "ENEMY GROUP",
    19328,
    20096,
    "confirmed",
    "6 stages x 64 chip words: the stage's enemy sprite sheet, 8x8 chips, assembled into OBJ names 0x100-0x1FF; ENEMY ODR references its slots. Cleared to 0xFFFF/0x03FF."
  ),
  region4(
    "bossGroup",
    "BOSS GROUP",
    20096,
    20480,
    "confirmed",
    "6 stages x 32 chip words: the boss as an 8x4-chip BG sheet at tiles 0x20-0x9F. Cleared to 0x03FF."
  ),
  region4(
    "titleGroup",
    "TITLE GROUP",
    20480,
    20544,
    "confirmed",
    "32 chip words: the title picture, assembled like a stage sheet (bits 11-13 masked on save)."
  ),
  region4(
    "endingGroup",
    "ENDING GROUP",
    20544,
    20568,
    "confirmed",
    "12 chip words for the ending screen; 0x03FF when unused."
  ),
  region4(
    "sound",
    "SOUND DATA",
    20568,
    32344,
    "open",
    "16 songs x 0x2E0 bytes; the editor clears every slot to one ROM block ($80:8E46). The sample's BGM PATCH points at ROM songs, so its stream is never played. The note format is open."
  ),
  region4(
    "titleType",
    "TITLE TYPE",
    32344,
    32346,
    "confirmed",
    "u16: the title animation ($00:B182) \u2014 byte 0 bits 0-1 / 2-3 / 4-5 the X, Y and third motion of element 1, byte 1 of element 2; 0x020A in the sample."
  ),
  region4("checksumCopy", "CHECK SUM COPY", 32346, 32378, "confirmed", "Byte-identical to CHECK SUM."),
  region4(
    "mouseSpeed",
    "MOUSE SPEED",
    32378,
    32380,
    "confirmed",
    "u16: the low byte is the option; the boot writes its SRAM-size probe into the high byte every start, so only the low byte is the save's."
  ),
  region4(
    "editBgm",
    "EDIT BGM",
    32380,
    32382,
    "confirmed",
    "u16: the song slot the composer was editing."
  ),
  region4(
    "bgmPatch",
    "BGM PATCH",
    32382,
    32398,
    "confirmed",
    "16 bytes, each & 0x3F: slots 0-5 stage n's song, 6-11 stage n's boss song, 12 the title, 13-15 ending / clear / game over; 0-15 pick SOUND DATA songs, 0x10 and up the ROM's own."
  ),
  region4(
    "hiScore",
    "HIGH SCORE",
    32398,
    32718,
    "confirmed",
    "20 entries x 16 bytes: u32 score, 4 bytes (the stage reached, likely), char[8] name \u2014 entries 0-9 are the sample game's table, 10-19 the user game's ($05:D087). The factory ladder 1000..100 with '........' names fills both."
  ),
  region4(
    "keyConfig",
    "KEY CONFIG",
    32718,
    32722,
    "confirmed",
    "Two u16 button assignments ($03:C134); 20 08 10 20 is the default."
  ),
  region4(
    "reserved1",
    "RESERVED",
    32722,
    32760,
    "confirmed",
    "38 bytes; never read. The ROM's default image leaves 20 of them 0xFF."
  ),
  region4(
    "checkString",
    "CHECK STRINGS",
    32760,
    32768,
    "confirmed",
    "ASCII 'T.TABATA' \u2014 the programmer's initials (ROM credits: TSUTOMU TABATA 94/01/27), used as the formatted-SRAM magic."
  ),
  region4(
    "enemyData",
    "ENEMY DATA",
    32768,
    35840,
    "likely",
    "6 stages x 0x200: eight-byte entries in five classes \u2014 0-2 sixteen each at +0/+0x80/+0x100, 3 eight at +0x180, 4 four at +0x1C0 \u2014 then a 32-byte boss block at +0x1E0. The entries' bit fields are the editor's ($04:E2F0); what each means to the play engine is read off ranges, not traced."
  ),
  region4(
    "appear",
    "APPEAR DATA",
    35840,
    63488,
    "confirmed",
    "6 stages x 0x1200: 256 records of 14 spawn bytes (one per playfield column 1..14: valid bit 7, class bits 4-6, entry bits 0-3), then a 1,024-byte line table \u2014 one entry per 2 px of the stage, the record that fires there. Record 0 is empty and record 1 the END code the loader forces."
  ),
  region4(
    "enemyOdr",
    "ENEMY ODR",
    63488,
    65408,
    "confirmed",
    "6 stages x 320 bytes: 80 four-byte quads of slot references ([V][H][row:3][col:3]) into the stage's enemy sheet, 16 quads a class \u2014 classes 0-2 one quad (four 16x16 frames) an entry, class 3 two quads (a 32x32 sprite, two frames), class 4 four."
  ),
  region4(
    "myShipGroup",
    "MY SHIP GROUP",
    65408,
    65536,
    "confirmed",
    "64 chip words: the ship sheet (8x8 chips) assembled into OBJ names 0x000-0x0FF \u2014 poses, shots, weapons, items; slots 61-63 are forced to 0x3FC-0x3FE."
  ),
  region4(
    "graphics",
    "GRAPIC DATA",
    65536,
    131072,
    "confirmed",
    "Two 32 KB sheets of 4bpp tiles, each 16 tiles wide: 32 chip rows of 8 chips, a chip 0x40 bytes with its tiles at +0/+0x20/+0x200/+0x220. A group word's bits 8-10 pick the sheet (0/1 here; 2/3 the ROM's factory art), bits 3-7 the row, 0-2 the column."
  )
]);
var REGION2 = Object.freeze(Object.fromEntries(SFC_REGIONS.map((r) => [r.name, r])));
var CONFIDENCES3 = Object.freeze(["confirmed", "likely", "open"]);

// packages/shmup-engine/src/sfc/sram.js
var SRAM_SIZE = 131072;
var SEGMENT_SIZE = 32768;
var SEGMENT_COUNT = 4;
var ACCEPTED_SIZES = Object.freeze([65536, SRAM_SIZE]);
var CHECK_STRING = "T.TABATA";
var CHECK_STRING_OFFSET = REGION2.checkString.offset;
var CHECKSUM_OFFSET = REGION2.checksum.offset;
var CHECKSUM_SIZE = REGION2.checksum.length;
var CHECKSUM_COPY_OFFSET = REGION2.checksumCopy.offset;
function latin12(bytes, offset, length) {
  let s = "";
  for (let i = 0; i < length && offset + i < bytes.length; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}
function readCheckString(bytes) {
  return latin12(bytes, CHECK_STRING_OFFSET, REGION2.checkString.length);
}
function hasCheckString(bytes) {
  return bytes.length >= CHECK_STRING_OFFSET + CHECK_STRING.length && readCheckString(bytes) === CHECK_STRING;
}
function isSfcSav(bytes) {
  return ACCEPTED_SIZES.includes(bytes.length) && hasCheckString(bytes);
}
function isBlank3(bytes) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
  return true;
}
function splitSegments(bytes) {
  const segments = [];
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const offset = i * SEGMENT_SIZE;
    const present = bytes.length >= offset + SEGMENT_SIZE;
    const view2 = present ? bytes.subarray(offset, offset + SEGMENT_SIZE) : bytes.subarray(0, 0);
    segments.push({ index: i, offset, bank: 112 + i, present, bytes: view2, blank: !present || isBlank3(view2) });
  }
  return segments;
}
function readChecksumBlocks(bytes) {
  const primary = bytes.subarray(CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_SIZE);
  const copy = bytes.subarray(CHECKSUM_COPY_OFFSET, CHECKSUM_COPY_OFFSET + CHECKSUM_SIZE);
  let equal = primary.length === CHECKSUM_SIZE && copy.length === CHECKSUM_SIZE;
  for (let i = 0; equal && i < CHECKSUM_SIZE; i++) if (primary[i] !== copy[i]) equal = false;
  const words = new Uint16Array(CHECKSUM_SIZE / 2);
  for (let i = 0; i < words.length; i++) words[i] = primary[i * 2] | primary[i * 2 + 1] << 8;
  return { primary, copy, equal, words };
}

// packages/shmup-engine/src/sfc/cgram.js
var CGRAM_ROW_COLORS = 16;
var CGRAM_ROW_BYTES = CGRAM_ROW_COLORS * 2;
var PALETTE_ROW_COUNT = REGION2.palette.length / CGRAM_ROW_BYTES;
var PALETTE_ROW_STAGE_BG = 0;
var PALETTE_ROW_STAGE_ENEMY = 6;
var PALETTE_ROW_STAGE_BOSS = 12;
var PALETTE_ROW_SHIP = 18;
var PALETTE_ROW_TITLE = 19;
function paletteRowRole(row) {
  if (row < 6) return `stage ${row} scenery`;
  if (row < 12) return `stage ${row - 6} enemies`;
  if (row < 18) return `stage ${row - 12} boss`;
  return ["ship", "title and ending", "items and weapons", "free", "editor picker", "editor picker"][row - 18] ?? `row ${row}`;
}
function readColorWord(bytes, offset) {
  return bytes[offset] | bytes[offset + 1] << 8;
}
function writeCgramRow(bytes, row, words) {
  if (row < 0 || row >= PALETTE_ROW_COUNT) throw new Error(`palette row ${row} is outside 0..${PALETTE_ROW_COUNT - 1}`);
  const at = REGION2.palette.offset + row * CGRAM_ROW_BYTES;
  for (let i = 0; i < CGRAM_ROW_COLORS; i++) {
    const w = (words[i] ?? 0) & 32767;
    bytes[at + i * 2] = w & 255;
    bytes[at + i * 2 + 1] = w >> 8;
  }
  return bytes;
}
function decodeCgramRow(bytes, offset) {
  if (offset + CGRAM_ROW_BYTES > bytes.length) {
    throw new Error(`palette row at 0x${offset.toString(16)} runs past the end (${bytes.length})`);
  }
  const raw = new Uint16Array(CGRAM_ROW_COLORS);
  const colors = [];
  let color = true;
  for (let i = 0; i < CGRAM_ROW_COLORS; i++) {
    const word = readColorWord(bytes, offset + i * 2);
    raw[i] = word;
    if (word & 32768) color = false;
    const { r, g, b } = rgb555ToRgb(word & 32767);
    colors.push({ raw: word, r, g, b });
  }
  return { offset, raw, colors, color };
}
function decodeCgramRows(bytes, offset, count) {
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(decodeCgramRow(bytes, offset + i * CGRAM_ROW_BYTES));
  return rows;
}
var TRANSPARENT_COLOR = Object.freeze({ raw: 0, r: 0, g: 0, b: 0 });
function rowsToPalettes(rows) {
  return rows.map((row) => ({ colors: [TRANSPARENT_COLOR, ...row.colors.slice(0, CGRAM_ROW_COLORS - 1)] }));
}
function decodePaletteData(bytes) {
  const rows = decodeCgramRows(bytes, REGION2.palette.offset, PALETTE_ROW_COUNT);
  const colorRowCount = rows.filter((row) => row.color).length;
  return {
    offset: REGION2.palette.offset,
    rows: rows.map((row, i) => ({ ...row, row: i, role: paletteRowRole(i) })),
    palettes: rowsToPalettes(rows),
    colorRowCount,
    allColor: colorRowCount === rows.length
  };
}

// packages/shmup-engine/src/sfc/map.js
var STAGE_COUNT = 6;
var MAP_STAGE_BYTES = REGION2.map.length / STAGE_COUNT;
var MAP_ROW_BYTES = 18;
var MAP_COLUMNS = 16;
var MAP_ROWS = MAP_STAGE_BYTES / MAP_ROW_BYTES;
var MAP_CELL_SLOT_MASK = 127;
var MAP_CELL_HFLIP = 128;
var SCROLL_STAGE_BYTES = REGION2.scroll.length / STAGE_COUNT;
var SCROLL_BANDS = 256;
var SCROLL_SPEED_OFFSET = 256;
var SCROLL_DEFAULT_SPEED = 66;
function scrollDefaultEffect(band) {
  return band & 31;
}
function stageSlice(bytes, region5, stage, size) {
  const offset = region5.offset + stage * size;
  if (offset + size > bytes.length) {
    throw new Error(`${region5.label} stage ${stage} at 0x${offset.toString(16)} runs past the end (${bytes.length})`);
  }
  return { offset, view: bytes.subarray(offset, offset + size) };
}
function decodeMapRow(bytes, at) {
  const cells = [];
  for (let half = 0; half < 2; half++) {
    const base = at + half * 9;
    const flags = bytes[base + 8];
    for (let k = 0; k < 8; k++) {
      const b = bytes[base + k];
      cells.push({ slot: b & MAP_CELL_SLOT_MASK, hflip: (b & MAP_CELL_HFLIP) !== 0, vflip: (flags >> 7 - k & 1) !== 0 });
    }
  }
  return cells;
}
function encodeMapRow(bytes, at, cells) {
  for (let half = 0; half < 2; half++) {
    const base = at + half * 9;
    let flags = 0;
    for (let k = 0; k < 8; k++) {
      const c = cells[half * 8 + k] || { slot: 0 };
      bytes[base + k] = c.slot & MAP_CELL_SLOT_MASK | (c.hflip ? MAP_CELL_HFLIP : 0);
      if (c.vflip) flags |= 1 << 7 - k;
    }
    bytes[base + 8] = flags;
  }
  return bytes;
}
function decodeMapStage(bytes, stage) {
  const { offset, view: view2 } = stageSlice(bytes, REGION2.map, stage, MAP_STAGE_BYTES);
  const n = MAP_COLUMNS * MAP_ROWS;
  const slots = new Uint8Array(n), hflips = new Uint8Array(n), vflips = new Uint8Array(n);
  let used = 0, flipped = 0, maxSlot = 0;
  for (let r = 0; r < MAP_ROWS; r++) {
    const cells = decodeMapRow(view2, r * MAP_ROW_BYTES);
    cells.forEach((c, k) => {
      const i = r * MAP_COLUMNS + k;
      slots[i] = c.slot;
      hflips[i] = c.hflip ? 1 : 0;
      vflips[i] = c.vflip ? 1 : 0;
      if (c.slot) {
        used++;
        if (c.slot > maxSlot) maxSlot = c.slot;
      }
      if (c.hflip || c.vflip) flipped++;
    });
  }
  return { stage, offset, columns: MAP_COLUMNS, rows: MAP_ROWS, slots, hflips, vflips, used, flipped, maxSlot };
}
function decodeMapData(bytes) {
  const stages = [];
  for (let s = 0; s < STAGE_COUNT; s++) stages.push(decodeMapStage(bytes, s));
  return stages;
}
function decodeScrollEffect(bytes) {
  const stages = [];
  for (let s = 0; s < STAGE_COUNT; s++) {
    const { offset, view: view2 } = stageSlice(bytes, REGION2.scroll, s, SCROLL_STAGE_BYTES);
    const effect = view2.subarray(0, SCROLL_BANDS);
    const speed = view2.subarray(SCROLL_SPEED_OFFSET, SCROLL_SPEED_OFFSET + SCROLL_BANDS);
    let min = 255, max = 0;
    for (let i = 0; i < speed.length; i++) {
      if (speed[i] < min) min = speed[i];
      if (speed[i] > max) max = speed[i];
    }
    stages.push({ stage: s, offset, bytes: view2, effect, speed, min, max });
  }
  return stages;
}
var MAP_BLOCK_ROWS = 4;
function storyScrollSequence(openingBlocks) {
  const blocks = MAP_ROWS / MAP_BLOCK_ROWS;
  const k = Math.max(0, Math.min(blocks - 1, openingBlocks));
  const seq = new Uint8Array(SCROLL_BANDS);
  for (let i = 0; i < SCROLL_BANDS; i++) seq[i] = i < blocks ? i : k + (i - k) % (blocks - k);
  return seq;
}
function writeScrollSequence(bytes, stage, seq) {
  bytes.set(seq.subarray(0, SCROLL_BANDS), REGION2.scroll.offset + stage * SCROLL_STAGE_BYTES);
  return bytes;
}
function writeDefaultScroll(bytes, stage) {
  const at = REGION2.scroll.offset + stage * SCROLL_STAGE_BYTES;
  for (let i = 0; i < SCROLL_BANDS; i++) {
    bytes[at + i] = scrollDefaultEffect(i);
    bytes[at + SCROLL_SPEED_OFFSET + i] = SCROLL_DEFAULT_SPEED;
  }
  return bytes;
}

// packages/shmup-engine/src/sfc/tiles.js
var TILE_DIM = 8;
var TILE_PIXELS = TILE_DIM * TILE_DIM;
var TILE_BYTES_4BPP = 32;
var TILE_BYTES_2BPP = 16;
function decodeTile4bpp(bytes, offset, out = new Uint8Array(TILE_PIXELS)) {
  for (let y = 0; y < TILE_DIM; y++) {
    const p0 = bytes[offset + y * 2];
    const p1 = bytes[offset + y * 2 + 1];
    const p2 = bytes[offset + 16 + y * 2];
    const p3 = bytes[offset + 16 + y * 2 + 1];
    for (let x = 0; x < TILE_DIM; x++) {
      const bit = 7 - x;
      out[y * TILE_DIM + x] = p0 >> bit & 1 | (p1 >> bit & 1) << 1 | (p2 >> bit & 1) << 2 | (p3 >> bit & 1) << 3;
    }
  }
  return out;
}
function decodeTile2bpp(bytes, offset, out = new Uint8Array(TILE_PIXELS)) {
  for (let y = 0; y < TILE_DIM; y++) {
    const p0 = bytes[offset + y * 2];
    const p1 = bytes[offset + y * 2 + 1];
    for (let x = 0; x < TILE_DIM; x++) {
      const bit = 7 - x;
      out[y * TILE_DIM + x] = p0 >> bit & 1 | (p1 >> bit & 1) << 1;
    }
  }
  return out;
}
function encodeTile4bpp(indices, out = new Uint8Array(TILE_BYTES_4BPP)) {
  out.fill(0);
  for (let y = 0; y < TILE_DIM; y++) {
    for (let x = 0; x < TILE_DIM; x++) {
      const v = indices[y * TILE_DIM + x] & 15;
      const bit = 7 - x;
      out[y * 2] |= (v & 1) << bit;
      out[y * 2 + 1] |= (v >> 1 & 1) << bit;
      out[16 + y * 2] |= (v >> 2 & 1) << bit;
      out[16 + y * 2 + 1] |= (v >> 3 & 1) << bit;
    }
  }
  return out;
}
function decodeTileSheet(bytes, offset, count, { bpp = 4 } = {}) {
  const stride = bpp === 2 ? TILE_BYTES_2BPP : TILE_BYTES_4BPP;
  const decode = bpp === 2 ? decodeTile2bpp : decodeTile4bpp;
  if (offset + count * stride > bytes.length) {
    throw new Error(`${count} ${bpp}bpp tiles at 0x${offset.toString(16)} run past the end (${bytes.length})`);
  }
  const tiles = [];
  for (let t = 0; t < count; t++) tiles.push(decode(bytes, offset + t * stride));
  return tiles;
}
function tileIsBlank(tile) {
  for (let i = 0; i < tile.length; i++) if (tile[i] !== 0) return false;
  return true;
}
function withPaletteRow(indices, row) {
  const out = new Uint8Array(indices.length);
  const tag = (row & 15) << 4;
  for (let i = 0; i < indices.length; i++) out[i] = indices[i] ? tag | indices[i] & 15 : 0;
  return out;
}

// packages/shmup-engine/src/sfc/chips.js
var CHIP_DIM = 16;
var CHIP_PIXELS = CHIP_DIM * CHIP_DIM;
var CHIP_SHEET_BYTES = 32768;
var CHIP_SHEET_COLS = 8;
var CHIP_SHEET_ROWS = 32;
var CHIPS_PER_SHEET = CHIP_SHEET_COLS * CHIP_SHEET_ROWS;
var CHIP_ROW_BYTES = 1024;
var CHIP_COL_BYTES = 64;
var CHIP_TILE_OFFSETS = Object.freeze([0, 32, 512, 544]);
var CHIP_HFLIP = 16384;
var CHIP_VFLIP = 32768;
var CHIP_FLIP_MASK = CHIP_HFLIP | CHIP_VFLIP;
var CHIP_WORD_MASK = 2047;
var CHIP_EMPTY_WORD = 65535;
var CHIP_BLANK_WORD = 1023;
var USER_CHIP_COUNT = 2 * CHIPS_PER_SHEET;
var SFC_SHEETS = Object.freeze([
  Object.freeze({ sheet: 0, source: "sram", offset: REGION2.graphics.offset, what: "GRAPIC DATA, first half" }),
  Object.freeze({ sheet: 1, source: "sram", offset: REGION2.graphics.offset + CHIP_SHEET_BYTES, what: "GRAPIC DATA, second half" }),
  Object.freeze({ sheet: 2, source: "rom", offset: 262144, what: "factory art" }),
  Object.freeze({ sheet: 3, source: "rom", offset: 294912, what: "factory art" }),
  Object.freeze({ sheet: 4, source: "rom", offset: 393216, what: "editor icons" })
]);
function decodeChipWord(word) {
  const sheet = word >> 8 & 7;
  const row = word >> 3 & 31;
  const col = word & 7;
  const empty = word === CHIP_EMPTY_WORD || (word & CHIP_WORD_MASK) === CHIP_BLANK_WORD;
  return {
    word,
    sheet,
    row,
    col,
    hflip: (word & CHIP_HFLIP) !== 0,
    vflip: (word & CHIP_VFLIP) !== 0,
    empty,
    user: !empty && sheet < 2,
    rom: !empty && sheet >= 2 && sheet < SFC_SHEETS.length,
    index: !empty && sheet < 2 ? sheet * CHIPS_PER_SHEET + row * CHIP_SHEET_COLS + col : null
  };
}
function chipWordForIndex(index, { hflip = false, vflip = false } = {}) {
  if (index < 0 || index >= USER_CHIP_COUNT) throw new Error(`chip index ${index} is outside the two user sheets (0..${USER_CHIP_COUNT - 1})`);
  return index | (hflip ? CHIP_HFLIP : 0) | (vflip ? CHIP_VFLIP : 0);
}
function chipSource(word) {
  const d = decodeChipWord(word);
  if (d.empty || d.sheet >= SFC_SHEETS.length) return null;
  const sheet = SFC_SHEETS[d.sheet];
  return { source: sheet.source, offset: sheet.offset + d.row * CHIP_ROW_BYTES + d.col * CHIP_COL_BYTES, sheet: d.sheet, row: d.row, col: d.col };
}
function chipIndexOffset(index) {
  if (index < 0 || index >= USER_CHIP_COUNT) throw new Error(`chip index ${index} is outside the two user sheets`);
  return REGION2.graphics.offset + (index >> 8) * CHIP_SHEET_BYTES + (index >> 3 & 31) * CHIP_ROW_BYTES + (index & 7) * CHIP_COL_BYTES;
}
function decodeChipPixels(word, { sram, rom = null } = {}) {
  const src = chipSource(word);
  if (!src) return null;
  const bytes = src.source === "sram" ? sram : rom;
  if (!bytes || src.offset + CHIP_TILE_OFFSETS[3] + TILE_BYTES_4BPP > bytes.length) return null;
  const d = decodeChipWord(word);
  const out = new Uint8Array(CHIP_PIXELS);
  const tile = new Uint8Array(TILE_DIM * TILE_DIM);
  CHIP_TILE_OFFSETS.forEach((off, q) => {
    decodeTile4bpp(bytes, src.offset + off, tile);
    const ox = (q & 1) * TILE_DIM, oy = (q >> 1) * TILE_DIM;
    for (let y = 0; y < TILE_DIM; y++) {
      for (let x = 0; x < TILE_DIM; x++) {
        const px = ox + x, py = oy + y;
        const dx = d.hflip ? CHIP_DIM - 1 - px : px;
        const dy = d.vflip ? CHIP_DIM - 1 - py : py;
        out[dy * CHIP_DIM + dx] = tile[y * TILE_DIM + x];
      }
    }
  });
  return out;
}
function encodeChipPixels(sram, index, pixels) {
  const at = chipIndexOffset(index);
  const tile = new Uint8Array(TILE_DIM * TILE_DIM);
  CHIP_TILE_OFFSETS.forEach((off, q) => {
    const ox = (q & 1) * TILE_DIM, oy = (q >> 1) * TILE_DIM;
    for (let y = 0; y < TILE_DIM; y++) {
      for (let x = 0; x < TILE_DIM; x++) tile[y * TILE_DIM + x] = pixels[(oy + y) * CHIP_DIM + ox + x] & 15;
    }
    encodeTile4bpp(tile, sram.subarray(at + off, at + off + TILE_BYTES_4BPP));
  });
  return sram;
}
function flipChip(pixels, hflip, vflip) {
  if (!hflip && !vflip) return pixels;
  const out = new Uint8Array(CHIP_PIXELS);
  for (let y = 0; y < CHIP_DIM; y++) {
    const sy = vflip ? CHIP_DIM - 1 - y : y;
    for (let x = 0; x < CHIP_DIM; x++) out[y * CHIP_DIM + x] = pixels[sy * CHIP_DIM + (hflip ? CHIP_DIM - 1 - x : x)];
  }
  return out;
}
var ODR_HFLIP = 64;
var ODR_VFLIP = 128;
var ODR_SLOT_MASK = 63;
function decodeOdrByte(b) {
  return { byte: b, slot: b & ODR_SLOT_MASK, row: b >> 3 & 7, col: b & 7, hflip: (b & ODR_HFLIP) !== 0, vflip: (b & ODR_VFLIP) !== 0 };
}
function encodeOdrByte({ slot = 0, hflip = false, vflip = false } = {}) {
  return slot & ODR_SLOT_MASK | (hflip ? ODR_HFLIP : 0) | (vflip ? ODR_VFLIP : 0);
}

// packages/shmup-engine/src/sfc/tilemap.js
function readWords2(bytes, offset, count) {
  if (offset + count * 2 > bytes.length) {
    throw new Error(`${count} words at 0x${offset.toString(16)} run past the end (${bytes.length})`);
  }
  const words = new Uint16Array(count);
  for (let i = 0; i < count; i++) words[i] = bytes[offset + i * 2] | bytes[offset + i * 2 + 1] << 8;
  return words;
}
function writeWords(bytes, offset, words) {
  if (offset + words.length * 2 > bytes.length) {
    throw new Error(`${words.length} words at 0x${offset.toString(16)} run past the end (${bytes.length})`);
  }
  for (let i = 0; i < words.length; i++) {
    bytes[offset + i * 2] = words[i] & 255;
    bytes[offset + i * 2 + 1] = words[i] >> 8 & 255;
  }
  return bytes;
}

// packages/shmup-engine/src/sfc/groups.js
var STAGE_COUNT2 = 6;
var MAP_GROUP_CHIPS = REGION2.mapGroup.length / STAGE_COUNT2 / 2;
var MAP_GROUP_STAGE_BYTES = MAP_GROUP_CHIPS * 2;
var ENEMY_GROUP_CHIPS = REGION2.enemyGroup.length / STAGE_COUNT2 / 2;
var ENEMY_GROUP_STAGE_BYTES = ENEMY_GROUP_CHIPS * 2;
var BOSS_GROUP_CHIPS = REGION2.bossGroup.length / STAGE_COUNT2 / 2;
var BOSS_GROUP_STAGE_BYTES = BOSS_GROUP_CHIPS * 2;
var TITLE_GROUP_CHIPS = REGION2.titleGroup.length / 2;
function titleSlotForCell(cx, cy) {
  return (cx >> 2) * 16 + cy * 4 + (cx & 3);
}
function bossSlotForCell(cx, cy, tall = false) {
  return tall ? cy * 4 + cx : titleSlotForCell(cx, cy);
}
var ENDING_GROUP_CHIPS = REGION2.endingGroup.length / 2;
var MY_SHIP_GROUP_CHIPS = REGION2.myShipGroup.length / 2;
var MY_SHIP_FORCED_SLOTS = Object.freeze([[61, 1020], [62, 1021], [63, 1022]]);
var ENEMY_ODR_STAGE_BYTES = REGION2.enemyOdr.length / STAGE_COUNT2;
var ENEMY_ODR_QUADS = ENEMY_ODR_STAGE_BYTES / 4;
var MY_SHIP_ODR_BYTES = REGION2.myShipOdr.length;
var BOSS_SHEET_COLS = 8;
var BOSS_SHEET_ROWS = 4;
function decodeChipTable(bytes, offset, count) {
  const words = readWords2(bytes, offset, count);
  return Array.from(words, (word, slot) => ({ slot, offset: offset + slot * 2, ...decodeChipWord(word) }));
}
function decodeMapGroup(bytes, stage) {
  const offset = REGION2.mapGroup.offset + stage * MAP_GROUP_STAGE_BYTES;
  return { stage, offset, chips: decodeChipTable(bytes, offset, MAP_GROUP_CHIPS) };
}
function decodeEnemyGroup(bytes, stage) {
  const offset = REGION2.enemyGroup.offset + stage * ENEMY_GROUP_STAGE_BYTES;
  return { stage, offset, chips: decodeChipTable(bytes, offset, ENEMY_GROUP_CHIPS) };
}
function decodeBossGroup(bytes, stage) {
  const offset = REGION2.bossGroup.offset + stage * BOSS_GROUP_STAGE_BYTES;
  return { stage, offset, chips: decodeChipTable(bytes, offset, BOSS_GROUP_CHIPS) };
}
function decodeTitleGroup(bytes) {
  return decodeChipTable(bytes, REGION2.titleGroup.offset, TITLE_GROUP_CHIPS);
}
function decodeEndingGroup(bytes) {
  return decodeChipTable(bytes, REGION2.endingGroup.offset, ENDING_GROUP_CHIPS);
}
function decodeMyShipGroup(bytes) {
  return decodeChipTable(bytes, REGION2.myShipGroup.offset, MY_SHIP_GROUP_CHIPS);
}
function decodeEnemyOdr(bytes, stage) {
  const offset = REGION2.enemyOdr.offset + stage * ENEMY_ODR_STAGE_BYTES;
  if (offset + ENEMY_ODR_STAGE_BYTES > bytes.length) {
    throw new Error(`ENEMY ODR stage ${stage} at 0x${offset.toString(16)} runs past the end (${bytes.length})`);
  }
  const quads = [];
  for (let q = 0; q < ENEMY_ODR_QUADS; q++) {
    const at = offset + q * 4;
    const refs = Array.from(bytes.subarray(at, at + 4), decodeOdrByte);
    quads.push({ quad: q, offset: at, refs, blank: refs.every((r) => r.byte === 0) });
  }
  return { stage, offset, quads };
}
function decodeMyShipOdr(bytes) {
  const { offset, end } = REGION2.myShipOdr;
  if (end > bytes.length) throw new Error(`MY SHIP ODR at 0x${offset.toString(16)} runs past the end (${bytes.length})`);
  return Array.from(bytes.subarray(offset, end), decodeOdrByte);
}
function decodeGroups(bytes) {
  const stages = Array.from({ length: STAGE_COUNT2 }, (_, s) => s);
  return {
    map: stages.map((s) => decodeMapGroup(bytes, s)),
    enemy: stages.map((s) => decodeEnemyGroup(bytes, s)),
    boss: stages.map((s) => decodeBossGroup(bytes, s)),
    enemyOdr: stages.map((s) => decodeEnemyOdr(bytes, s)),
    title: decodeTitleGroup(bytes),
    ending: decodeEndingGroup(bytes),
    myShip: decodeMyShipGroup(bytes),
    myShipOdr: decodeMyShipOdr(bytes)
  };
}

// packages/shmup-engine/src/sfc/tables.js
var HI_SCORE_ENTRY_BYTES = 16;
var HI_SCORE_COUNT = REGION2.hiScore.length / HI_SCORE_ENTRY_BYTES;
var HI_SCORE_NAME_LENGTH = 8;
var HI_SCORE_TABLE_SIZE = 10;
var HI_SCORE_USER_TABLE = 10;
var BGM_PATCH_COUNT = REGION2.bgmPatch.length;
var KEY_CONFIG_BYTES = REGION2.keyConfig.length;
var SOUND_SONG_COUNT = 16;
var SOUND_SONG_BYTES = REGION2.sound.length / SOUND_SONG_COUNT;
function u165(bytes, offset) {
  return bytes[offset] | bytes[offset + 1] << 8;
}
function u324(bytes, offset) {
  return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
}
function need(bytes, region5) {
  if (bytes.length < region5.end) {
    throw new Error(`${region5.label} at 0x${region5.offset.toString(16)} runs past the end (${bytes.length})`);
  }
}
function decodeHiScores(bytes) {
  need(bytes, REGION2.hiScore);
  const entries = [];
  for (let i = 0; i < HI_SCORE_COUNT; i++) {
    const offset = REGION2.hiScore.offset + i * HI_SCORE_ENTRY_BYTES;
    entries.push({
      rank: i % HI_SCORE_TABLE_SIZE + 1,
      table: i < HI_SCORE_USER_TABLE ? "sample" : "user",
      offset,
      score: u324(bytes, offset),
      extra: bytes.subarray(offset + 4, offset + 8),
      name: latin12(bytes, offset + 8, HI_SCORE_NAME_LENGTH)
    });
  }
  return entries;
}
function decodeConfig(bytes) {
  for (const r of [REGION2.titleType, REGION2.mouseSpeed, REGION2.editBgm, REGION2.bgmPatch, REGION2.keyConfig, REGION2.reserved1]) {
    need(bytes, r);
  }
  return {
    titleType: u165(bytes, REGION2.titleType.offset),
    mouseSpeed: u165(bytes, REGION2.mouseSpeed.offset),
    editBgm: u165(bytes, REGION2.editBgm.offset),
    bgmPatch: bytes.subarray(REGION2.bgmPatch.offset, REGION2.bgmPatch.end),
    keyConfig: bytes.subarray(REGION2.keyConfig.offset, REGION2.keyConfig.end),
    reserved0: bytes.subarray(REGION2.reserved0.offset, REGION2.reserved0.end),
    reserved1: bytes.subarray(REGION2.reserved1.offset, REGION2.reserved1.end)
  };
}
function sliceSound(bytes) {
  need(bytes, REGION2.sound);
  const songs = [];
  for (let i = 0; i < SOUND_SONG_COUNT; i++) {
    const at = REGION2.sound.offset + i * SOUND_SONG_BYTES;
    songs.push({ index: i, offset: at, bytes: bytes.subarray(at, at + SOUND_SONG_BYTES) });
  }
  return { offset: REGION2.sound.offset, length: REGION2.sound.length, bytes: bytes.subarray(REGION2.sound.offset, REGION2.sound.end), songs };
}

// packages/shmup-engine/src/sfc/enemy.js
var STAGE_COUNT3 = 6;
var ENEMY_STAGE_BYTES = REGION2.enemyData.length / STAGE_COUNT3;
var ENEMY_ENTRY_BYTES2 = 8;
var BOSS_BLOCK_OFFSET = 480;
var BOSS_BLOCK_BYTES = 32;
var SFC_ENEMY_CLASSES = Object.freeze([
  Object.freeze({ klass: 0, base: 0, entries: 16, odrBase: 0, cols: 1, rows: 1, frames: 4, w: 16, h: 16 }),
  Object.freeze({ klass: 1, base: 128, entries: 16, odrBase: 64, cols: 2, rows: 1, frames: 2, w: 32, h: 16 }),
  Object.freeze({ klass: 2, base: 256, entries: 16, odrBase: 128, cols: 1, rows: 2, frames: 2, w: 16, h: 32 }),
  Object.freeze({ klass: 3, base: 384, entries: 8, odrBase: 192, cols: 2, rows: 2, frames: 2, w: 32, h: 32 }),
  Object.freeze({ klass: 4, base: 448, entries: 4, odrBase: 256, cols: 4, rows: 4, frames: 1, w: 64, h: 64 })
]);
var APPEAR_BOSS_CLASS = 5;
var SFC_ENEMY_CONTACT = Object.freeze([1, 5, 5, 12, 24]);
var SFC_ENEMY_HP = Object.freeze([1, 50, 100, 200, 400, 800, 1e3, 2e3]);
var SFC_ENEMY_SCORE = Object.freeze([50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4]);
var SFC_ANIM_INTERVALS = Object.freeze([59, 29, 14, 9, 5, 2, 1, 0]);
var SFC_SHOT_RATES = Object.freeze([31, 31, 15, 15, 7, 3, 1, 0]);
var SFC_SHOT_SPEEDS = Object.freeze([20, 18, 14, 10, 8, 4, 2, 1]);
var SFC_STRAIGHT_SPEEDS = Object.freeze([1, 2, 3, 4, 5, 6, 9, 12]);
var SFC_HOMING_SPEEDS = Object.freeze([1.5, 2, 2.5, 3, 3.5, 4, 6, 8]);
var SFC_MOVE_FAMILIES = Object.freeze([
  "stationary on the ground",
  "straight down",
  "down, pause, down",
  "down, curve back up and leave",
  "U-turn",
  "U-turn (later)",
  "arc, exit sideways",
  "zig-zag, then sideways",
  "down, long turn, up",
  "ground vehicle",
  "square patrol",
  "down with weaving turns",
  "bobbing",
  "down, retreat, down",
  "stepwise",
  "down, then sweeps",
  "down, stop, exit up-right",
  "homing",
  "level with the player, dash",
  "wait, aim, dash"
]);
var SFC_MOVE_STRAIGHT = 1;
var SFC_BOSS_HP = Object.freeze([24, 2e3, 4e3, 8e3, 12e3, 16e3, 18e3, 24e3]);
function decodeEnemyEntry2(bytes, at) {
  const b = Array.from(bytes.subarray(at, at + ENEMY_ENTRY_BYTES2));
  return {
    offset: at,
    bytes: b,
    blank: b.every((v) => v === 0),
    fields: {
      family: b[0] >> 3,
      variant: b[0] & 7,
      aim: b[1] & 31,
      rate: b[1] >> 5,
      shotType: b[2] & 3,
      itemDrop: (b[2] >> 2 & 1) !== 0,
      hp: b[3] & 7,
      flags: b[3] >> 5,
      score: b[4] & 7,
      anim: b[4] >> 5,
      shotParam: b[5]
    }
  };
}
function encodeEnemyEntry2({ family = 0, variant: variant2 = 0, aim = 0, rate = 0, shotType = 0, itemDrop = false, hp = 0, flags = 0, score = 0, anim = 0, shotParam = 0 } = {}) {
  return [
    (family & 31) << 3 | variant2 & 7,
    aim & 31 | (rate & 7) << 5,
    shotType & 3 | (itemDrop ? 4 : 0),
    hp & 7 | (flags & 7) << 5,
    score & 7 | (anim & 7) << 5,
    shotParam & 255,
    0,
    0
  ];
}
function decodeBossBlock(bytes, at) {
  const b = Array.from(bytes.subarray(at, at + BOSS_BLOCK_BYTES));
  return {
    offset: at,
    bytes: b,
    blank: b.every((v) => v === 0),
    anim: [b[0], b[1], b[2]],
    phases: [0, 1, 2].map((p) => ({
      aim: b[3 + p] & 31,
      rate: b[3 + p] >> 5,
      shotType: b[6] >> p * 2 & 3,
      pair: [b[7 + p * 2], b[8 + p * 2]],
      shotParam: b[15 + p] & 127
    })),
    tall: (b[6] & 64) !== 0,
    hp: b[13] & 7,
    priority: (b[13] & 64) !== 0,
    score: b[14] & 7
  };
}
function decodeEnemyStage(bytes, stage) {
  const offset = REGION2.enemyData.offset + stage * ENEMY_STAGE_BYTES;
  if (offset + ENEMY_STAGE_BYTES > bytes.length) {
    throw new Error(`ENEMY DATA stage ${stage} at 0x${offset.toString(16)} runs past the end (${bytes.length})`);
  }
  let used = 0;
  const classes = SFC_ENEMY_CLASSES.map((spec) => {
    const entries = [];
    for (let e = 0; e < spec.entries; e++) {
      const entry = decodeEnemyEntry2(bytes, offset + spec.base + e * ENEMY_ENTRY_BYTES2);
      if (!entry.blank) used++;
      entries.push({ index: e, ...entry });
    }
    return { klass: spec.klass, offset: offset + spec.base, entries };
  });
  return { stage, offset, classes, boss: decodeBossBlock(bytes, offset + BOSS_BLOCK_OFFSET), used };
}
function decodeEnemyData(bytes) {
  const stages = [];
  for (let s = 0; s < STAGE_COUNT3; s++) stages.push(decodeEnemyStage(bytes, s));
  return stages;
}
var APPEAR_STAGE_BYTES = REGION2.appear.length / STAGE_COUNT3;
var APPEAR_RECORDS = 256;
var APPEAR_RECORD_BYTES = 14;
var APPEAR_COLUMNS = 14;
var APPEAR_FIRST_COLUMN = 1;
var APPEAR_TABLE_B_OFFSET = APPEAR_RECORDS * APPEAR_RECORD_BYTES;
var APPEAR_LINES = APPEAR_STAGE_BYTES - APPEAR_TABLE_B_OFFSET;
var APPEAR_RECORD_END = 1;
var APPEAR_VALID = 128;
function decodeAppearByte(b) {
  return { byte: b, valid: (b & APPEAR_VALID) !== 0, klass: b >> 4 & 7, entry: b & 15 };
}
function encodeAppearByte({ klass, entry }) {
  return APPEAR_VALID | (klass & 7) << 4 | entry & 15;
}
function decodeAppearStage(bytes, stage) {
  const offset = REGION2.appear.offset + stage * APPEAR_STAGE_BYTES;
  if (offset + APPEAR_STAGE_BYTES > bytes.length) {
    throw new Error(`APPEAR DATA stage ${stage} at 0x${offset.toString(16)} runs past the end (${bytes.length})`);
  }
  const records = [];
  for (let r = 0; r < APPEAR_RECORDS; r++) {
    const at = offset + r * APPEAR_RECORD_BYTES;
    const view2 = bytes.subarray(at, at + APPEAR_RECORD_BYTES);
    const spawns2 = [];
    view2.forEach((b, k) => {
      const d = decodeAppearByte(b);
      if (d.valid && r !== APPEAR_RECORD_END) spawns2.push({ column: APPEAR_FIRST_COLUMN + k, klass: d.klass, entry: d.entry });
    });
    records.push({ index: r, offset: at, bytes: view2, spawns: spawns2, blank: isBlank3(view2) });
  }
  const lines = bytes.subarray(offset + APPEAR_TABLE_B_OFFSET, offset + APPEAR_STAGE_BYTES);
  let used = 0, spawns = 0, lastLine = -1;
  for (let l = 0; l < lines.length; l++) {
    if (!lines[l]) continue;
    used++;
    lastLine = l;
    spawns += records[lines[l]].spawns.length;
  }
  return { stage, offset, records, lines, used, spawns, lastLine, blank: used === 0 };
}
function decodeAppearData(bytes) {
  const stages = [];
  for (let s = 0; s < STAGE_COUNT3; s++) stages.push(decodeAppearStage(bytes, s));
  return stages;
}

// packages/shmup-engine/src/sfc/graphics.js
var GRAPHICS_TILE_COUNT = REGION2.graphics.length / TILE_BYTES_4BPP;
function decodeGraphics(bytes) {
  const { offset, end } = REGION2.graphics;
  const present = bytes.length >= end;
  if (!present) return { offset, present, blank: true, tiles: [], usedCount: 0 };
  const view2 = bytes.subarray(offset, end);
  if (isBlank3(view2)) return { offset, present, blank: true, tiles: [], usedCount: 0 };
  const tiles = decodeTileSheet(bytes, offset, GRAPHICS_TILE_COUNT);
  let usedCount = 0;
  for (const tile of tiles) if (!tileIsBlank(tile)) usedCount++;
  return { offset, present, blank: false, tiles, usedCount };
}

// packages/shmup-engine/src/sfc/rom.js
var ROM_HEADER_OFFSET = 32704;
var ROM_DEFAULT_IMAGE_OFFSET = 327680;
var ROM_DEFAULT_IMAGE_SIZE = 65536;
var ROM_TITLE = "DEZAEMON";
function copierHeaderSize(rom) {
  return rom.length % 32768 === 512 ? 512 : 0;
}
function latin13(bytes, offset, length) {
  let s = "";
  for (let i = 0; i < length && offset + i < bytes.length; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}
function readRomHeader(rom) {
  const skip = copierHeaderSize(rom);
  const h = skip + ROM_HEADER_OFFSET;
  if (h + 32 > rom.length) throw new Error(`ROM too small for a LoROM header: ${rom.length} bytes`);
  const complement = rom[h + 28] | rom[h + 29] << 8;
  const checksum = rom[h + 30] | rom[h + 31] << 8;
  const romSizeCode = rom[h + 23];
  const sramSizeCode = rom[h + 24];
  return {
    copierHeader: skip,
    headerOffset: h,
    title: latin13(rom, h, 21).trimEnd(),
    mapMode: rom[h + 21],
    cartType: rom[h + 22],
    romSizeCode,
    romSizeBytes: romSizeCode ? 1024 << romSizeCode : 0,
    sramSizeCode,
    sramSizeBytes: sramSizeCode ? 1024 << sramSizeCode : 0,
    region: rom[h + 25],
    version: rom[h + 27],
    complement,
    checksum,
    valid: (complement ^ checksum) === 65535
  };
}
function isDezaemonRom(rom) {
  try {
    const header = readRomHeader(rom);
    return header.title === ROM_TITLE && header.sramSizeBytes === 131072;
  } catch {
    return false;
  }
}
var TABLE_ROW = /([0-9A-F]{5})-([0-9A-F]{5})\s+([A-Z][A-Z ]*[A-Z])/g;
function parseRomRegionTable(rom) {
  const text = latin13(rom, 0, rom.length);
  const rows = [];
  for (const m of text.matchAll(TABLE_ROW)) {
    rows.push({ offset: parseInt(m[1], 16), end: parseInt(m[2], 16) + 1, label: m[3], at: m.index });
  }
  return rows;
}
function regionTableMatches(rows, regions = SFC_REGIONS) {
  const key = (r) => `${r.offset}:${r.end}:${r.label}`;
  const ours = new Set(regions.map(key));
  const theirs = new Set(rows.map(key));
  const missing = regions.filter((r) => !theirs.has(key(r))).map((r) => r.label);
  const unexpected = rows.filter((r) => !ours.has(key(r))).map((r) => r.label);
  return { matches: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}
function romDefaultImage(rom) {
  const at = copierHeaderSize(rom) + ROM_DEFAULT_IMAGE_OFFSET;
  if (at + ROM_DEFAULT_IMAGE_SIZE > rom.length) throw new Error(`ROM too small for the default image: ${rom.length} bytes`);
  return rom.subarray(at, at + ROM_DEFAULT_IMAGE_SIZE);
}
function compareWithRomDefault(sav, rom) {
  const image = romDefaultImage(rom);
  const total = Math.min(image.length, sav.length);
  let equal = 0;
  for (let i = 0; i < total; i++) if (sav[i] === image[i]) equal++;
  return { equal, total, identical: equal === image.length };
}

// packages/shmup-engine/src/sfc/checksum.js
var STAGES2 = 6;
var seg = (offset, length) => Object.freeze({ offset, length });
function stageSegments(n) {
  return [
    seg(REGION2.map.offset + n * 2304, 2304),
    seg(REGION2.scroll.offset + n * 512, 512),
    seg(REGION2.mapGroup.offset + n * 256, 256)
  ];
}
function stageTables(n) {
  return [
    seg(REGION2.enemyGroup.offset + n * 128, 128),
    seg(REGION2.enemyOdr.offset + n * 320, 320),
    seg(REGION2.bossGroup.offset + n * 64, 64),
    seg(REGION2.enemyData.offset + n * 512, 512),
    seg(REGION2.appear.offset + n * 4608, 4608)
  ];
}
var SFC_CHECKSUM_DESCRIPTORS = Object.freeze([
  Object.freeze({ at: 0, name: "graphics + palettes", segments: Object.freeze([seg(REGION2.graphics.offset, 32768), seg(REGION2.graphics.offset + 32768, 32768), seg(REGION2.palette.offset, REGION2.palette.length)]) }),
  ...Array.from({ length: STAGES2 }, (_, n) => Object.freeze({ at: 2 + n * 2, name: `stage ${n} map, scroll, map group`, segments: Object.freeze(stageSegments(n)) })),
  ...Array.from({ length: STAGES2 }, (_, n) => Object.freeze({ at: 14 + n * 2, name: `stage ${n} enemies, appear`, segments: Object.freeze(stageTables(n)) })),
  Object.freeze({
    at: 26,
    name: "ship, title, ending, config, hi-scores",
    segments: Object.freeze([
      seg(REGION2.myShipOdr.offset, REGION2.myShipOdr.length),
      seg(REGION2.myShipGroup.offset, REGION2.myShipGroup.length),
      seg(REGION2.titleGroup.offset, REGION2.titleGroup.length),
      seg(REGION2.titleType.offset, REGION2.titleType.length),
      seg(REGION2.endingGroup.offset, REGION2.endingGroup.length),
      seg(REGION2.mouseSpeed.offset, REGION2.mouseSpeed.length),
      seg(REGION2.editBgm.offset, REGION2.editBgm.length),
      seg(REGION2.hiScore.offset, REGION2.hiScore.length),
      seg(REGION2.keyConfig.offset, REGION2.keyConfig.length)
    ])
  }),
  Object.freeze({ at: 28, name: "sound + bgm patch", segments: Object.freeze([seg(REGION2.sound.offset, REGION2.sound.length), seg(REGION2.bgmPatch.offset, REGION2.bgmPatch.length)]) }),
  Object.freeze({ at: 30, name: "the block's first fifteen words", segments: Object.freeze([seg(REGION2.checksum.offset, 30)]) }),
  Object.freeze({ at: REGION2.checksumCopy.offset + 30, name: "the copy's first fifteen words", segments: Object.freeze([seg(REGION2.checksumCopy.offset, 30)]) })
]);
function sfcChecksumWord(bytes, segments) {
  let sum = 0;
  for (const { offset, length } of segments) {
    if (offset + length > bytes.length) throw new Error(`checksum segment 0x${offset.toString(16)}+0x${length.toString(16)} runs past the end (${bytes.length})`);
    for (let i = offset; i < offset + length; i += 2) sum = sum + (bytes[i] | bytes[i + 1] << 8) & 65535;
  }
  return 65535 - sum & 65535;
}
function putWord(bytes, at, word) {
  bytes[at] = word & 255;
  bytes[at + 1] = word >> 8 & 255;
}
function getWord(bytes, at) {
  return bytes[at] | bytes[at + 1] << 8;
}
function sealSfcChecksums(bytes) {
  if (bytes.length < REGION2.graphics.end) throw new Error(`a Dezaemon SRAM image is ${REGION2.graphics.end} bytes; got ${bytes.length}`);
  for (let i = 0; i < 16; i++) {
    const d = SFC_CHECKSUM_DESCRIPTORS[i];
    putWord(bytes, d.at, sfcChecksumWord(bytes, d.segments));
  }
  bytes.set(bytes.subarray(REGION2.checksum.offset, REGION2.checksum.end), REGION2.checksumCopy.offset);
  const copy = SFC_CHECKSUM_DESCRIPTORS[16];
  putWord(bytes, copy.at, sfcChecksumWord(bytes, copy.segments));
  return bytes;
}
function verifySfcChecksums(bytes) {
  const words = SFC_CHECKSUM_DESCRIPTORS.map((d) => {
    let computed = null;
    try {
      computed = sfcChecksumWord(bytes, d.segments);
    } catch {
      computed = null;
    }
    const stored = d.at + 1 < bytes.length ? getWord(bytes, d.at) : null;
    return { name: d.name, at: d.at, stored, computed, ok: computed !== null && stored === computed };
  });
  return { ok: words.every((w) => w.ok), words, blockOk: words[15].ok, copyOk: words[16].ok };
}

// packages/shmup-engine/src/sfc/cover.js
var SFC_COVER_W = 256;
var SFC_COVER_H = 480;
var SFC_COVER_CHIP = 16;
var SFC_COVER_COLUMNS = SFC_COVER_W / SFC_COVER_CHIP;
var SFC_COVER_ROWS = SFC_COVER_H / SFC_COVER_CHIP;
function art(parsed) {
  const { graphics, groups, palettes, bytes, romBytes } = parsed ?? {};
  if (!graphics || !graphics.present || !groups?.map || !palettes || !bytes) return null;
  return { sram: bytes, rom: romBytes ?? null, groups: groups.map, palettes: palettes.palettes };
}
function chipThroughRow(px, palettes, row) {
  return indexedToRgba(withPaletteRow(px, 0), [palettes[row] ?? palettes[0]]);
}
function windowCells(map, top) {
  let n = 0;
  for (let r = top; r < top + SFC_COVER_ROWS && r < map.rows; r++) {
    for (let c = 0; c < SFC_COVER_COLUMNS; c++) {
      if (map.slots[r * MAP_COLUMNS + c]) n++;
    }
  }
  return n;
}
function pickSfcCoverWindow(maps, { stage = null } = {}) {
  const list = (maps ?? []).map((m, i) => ({ map: m, stage: i })).filter(({ map, stage: i }) => map && (stage === null || stage === i));
  let best = null;
  for (const { map, stage: i } of list) {
    const last = Math.max(map.rows - SFC_COVER_ROWS, 0);
    for (let top = 0; top <= last; top++) {
      const cells = windowCells(map, top);
      if (best && cells <= best.cells) continue;
      best = { stage: i, top, cells };
    }
  }
  return best && best.cells > 0 ? best : null;
}
function blitChip(canvas, x, y, rgba) {
  for (let r = 0; r < SFC_COVER_CHIP; r++) {
    const ty = y + r;
    if (ty < 0 || ty >= SFC_COVER_H) continue;
    for (let c = 0; c < SFC_COVER_CHIP; c++) {
      const tx = x + c;
      if (tx < 0 || tx >= SFC_COVER_W) continue;
      const s = (r * SFC_COVER_CHIP + c) * 4;
      if (!rgba[s + 3]) continue;
      const d = (ty * SFC_COVER_W + tx) * 4;
      canvas[d] = rgba[s];
      canvas[d + 1] = rgba[s + 1];
      canvas[d + 2] = rgba[s + 2];
      canvas[d + 3] = 255;
    }
  }
}
function composeSfcCover(parsed, { stage = null } = {}) {
  const a = art(parsed);
  if (!a) return null;
  const pick = pickSfcCoverWindow(parsed.maps, { stage });
  if (!pick) return null;
  const back = a.palettes[0]?.colors?.[1] ?? { r: 0, g: 0, b: 0 };
  const canvas = new Uint8ClampedArray(SFC_COVER_W * SFC_COVER_H * 4);
  for (let i = 0; i < SFC_COVER_W * SFC_COVER_H; i++) {
    canvas[i * 4] = back.r;
    canvas[i * 4 + 1] = back.g;
    canvas[i * 4 + 2] = back.b;
    canvas[i * 4 + 3] = 255;
  }
  const map = parsed.maps[pick.stage];
  const group = a.groups[pick.stage].chips;
  let drawn = 0;
  for (let r = 0; r < SFC_COVER_ROWS; r++) {
    const row = pick.top + r;
    if (row >= map.rows) break;
    for (let c = 0; c < SFC_COVER_COLUMNS; c++) {
      const i = row * MAP_COLUMNS + c;
      const slot = map.slots[i];
      if (!slot) continue;
      const chip = group[slot];
      if (!chip || chip.empty) continue;
      const px = decodeChipPixels(chip.word, { sram: a.sram, rom: a.rom });
      if (!px || !px.some((v) => v)) continue;
      const rgba = chipThroughRow(flipChip(px, !!map.hflips[i], !!map.vflips[i]), a.palettes, pick.stage);
      blitChip(canvas, c * SFC_COVER_CHIP, r * SFC_COVER_CHIP, rgba);
      drawn++;
    }
  }
  if (!drawn) return null;
  return {
    w: SFC_COVER_W,
    h: SFC_COVER_H,
    rgba: canvas,
    stage: pick.stage,
    top: pick.top,
    cells: pick.cells,
    source: "scenery"
  };
}

// packages/shmup-engine/src/sfc/factory-data.js
var SFC_FACTORY_SOUND_BASE64 = [
  "AIFgA/B+D8H4P//g/aSD8H4P//g/B+D9ogPwfg/B+D8H4Pwfg/B+D8H4Pwfg/AIP/g///j/Bp/z/5ZmplLLc2cqZdy9N7/4Pwf4/",
  "wFg3BuAsG4N6pgLBvVOqYCGFWOg/B+xsH4P2KA/B+D8H4PwfsUYyxRjIP2HMSB+D9iAPwfhJCaE4JoTgpBZHOWOg/B+xsH4P2JA/",
  "B/5nzIPvNg+86D9jIP2JMUB+D9hoP/u/d+p9T53zu/9UEFQPf/A6CJv4IG/gZ/+xtjrHgfsdYyxsDLf/OgS835334EvMz/n/NKf8",
  "/5qT/EFwPf/BACRv4Im/gb/+xtjzIAfseZEyADbf/Mgg8z5tv4FPNz/n/NCf8/5pT/HWfReib96ByXonfeg9F6Cf3op/YCwED9jr",
  "EmMsbc2xByjEsuuUcy1Kf7kGpN/HWfReib96ByXom/eg9F6Cf3op/YCwED9jrEmMsbc2xByjEsuuUcy1Kf7kGpN/EFQPA/BEB0H4",
  "IgSApB+CAETPwNgUb/j+aWf3HTUz+46bOf3JOOm646bc2Z/t/EOQMg/zBn/MTfwOgSB/5kv3mfNl+AiBKaQP5oO+mk5nzvm3Jegd",
  "96D0WfgKAZEMgIZ/AcBDP4G8/gUA2B0DwG8/gSA8CABoP3FgNckBJzIEGqO/A2BKf4DgNgdFFAPA/BCB4HwG5mgdB/NHBuBJpYNm",
  "pn8CIPwOgRy2BTLoGQf5gB+A3LwDgIg+GOQRM/nEz8EAIgOgrBID8FIImfsQYl1QDoP5ug/A2B0DLkgQOUBEB2bM25u9/GFQRM/n",
  "Ez8EAIgOgrBID8FIImfsQYl1QDoP5ug/A2B0DLkgQOUBEB2aU1Js9/EFwRN/BA38EQIM/Apz8CQFIHcfAeBJP+bZf5qF/m3N0v81",
  "HKOOchNt37kpsz/HWQSAiB/n8EmfgUgiB+BICAGQfgRAk3+agP3JOZmg5SZs0mpO/+7936n1PnfOsc8AABDfyGf/JeQz+7/KR//H",
  "eQD+H/Jefwfg/ygD/KWUGfo/yzn8H+U8/g/ykD8H4PxBXyGf/JeQz+7/KTv/HeQB+z/Jefwfg/ygD/KWUGfo/yyD8H+Uwfg/ykD8",
  "H4PxBPyGf/JeQz+7/KTv/HeQB+z+bjP5/g/ygD/KWUGfo/yyD8H+Uwfg/yyD/LgPxRLLeW8k5Zyyz/LeWynFTKllLP+UMnd/6p1R",
  "n/VOoM/6p1RCSE0MocR+j9DffxDfKGf8/u/8hD7yHvvJ+Qp/5Kf4P8od/ymz9DYP0Jg/QyD9DaE0focB+D9DYPxBXKWf2f5/8z5n",
  "33kvM+TZ/5Jn7P8nM/QmhlCYPkJIQZ+g5n4Pwfh/z+H/qnVBBPKDP2fs/8n77zLPvM+TZ/5n37P8oM/Z8z5CYP0IA/QkD9CaEEfI",
  "cB+D9DYPxRLKXv/N+b8z57qnVMwZgZ/3/L2Xmf9/QyD9DyP0MocR8hxH//0N//z+xBhzCxBPMTjMxZgcZl4H+YC/uMagD/KWWct5",
  "cYSwxhjf2GMQB+w4H7f2GA/mgD8H4PxBXMTjsxZgcdl4H+YC/uOakD/KWWct5cYYw5hzf2HMTB+xIH7f2HA/mkD/qnVBDfMTkMxZ",
  "gchl4H+YC/uZamD/KWWct5cYcxDzLEPM+bYgw5iDDjxs/m3P+f8/xTfMTkMxZgchl4H+YC/uca2D/L2Xs/9/YcxDzLEPM+bYgw5i",
  "DDjxs/m3P+f8/xBPMTjMx5gcZmkH2Yy/uMagD/KWWct5cYYwlhjf2GMQB+w4H7f2GA/mgD8H4PxBXMTjsx5gcdmsH+aS/uOakD/K",
  "WWct5cYcwxhzf2HMTB+xIH7f2HA/mkD/qnVBDfMTkMx5gchmMH+YC/uZamD/KWWct5cYcxDzLEPM+bYgw5iDDjxs/m9P+f8/xTfM",
  "TkMx5gchmMH+YC/uca2D/Lmf+/9/YcxDzLEPM+bYgw5iDDjxs/nBP+f8/3RPAAA1FizFyL0WYuReizFyL0WYuRejDGCLkXlHI+Uc",
  "p7zykVJ+eUb5zzynvPKMUcj40DizFyMEXouRgi9FyMEXouRgi1F6KMU1GKOUYpzzyjlIeeU55zzykPPKMU4D41FizFyL0WYuReiz",
  "FyL0WYuRejDGCLkXlHI+Ucp7zykVJ+eUb5zzynvPKMUcj48DizFyMEXouRgi9FyMEXouRgi1F6KMU1GKOUYpzzyjlIeeU55zzykP",
  "PKMU4D4lFDCGAL0/w/n/miH+aYfw/zRD+H8LgWlHI+Ucj5RykVJo+Uaj5TinkfKMUcowkBDCH8P8/w/h/miH+bIfw/zaD+H8MYf1",
  "HKRUcj5TyvlGKOUYj5SakVfKcU8o4kDDAGEME/5/h/mnP+bgfwvTaD+FwP4f1HI+Ucj5RykVJo+Uaj5TinkfKMUcowlAC0H8P4fw",
  "/h/CyH+aYf5/zZR+j9DiP1HI+U8o5Xyk1GKOUyr5TinlfKTUZ1R5FQ8hxDyP8/z/n/P+f8/5/z/n/P9DiGlHKeU9llRynlGI+Ucp",
  "lTinlHKZUmr54BRCD8H6IAfA/Q0D8/56T/I/PUj9FSP1HKcU9lpRymVGI+Ucp5TinlfKOUio55HRSipFKI8tA/RCiNEKIM/ohRGD",
  "5ECPlHKeU9lNRynlGI+UcplTinspq/UypN5FQ8hxDSGQfnpPHn/7v3TyfU+cd7v/VFHKcU8j5RymVGI+Ucp5TinlfKOUio6BFizF",
  "yL0WYuReizFyL0WYuRejDGCLkXlHI+Ucj5RykVJo+Uaj5Tins/KMUcoyADizFyMEXouRgi9FyMEXouRgi1F6KMU1GKOUZ35SIPlI",
  "d+U4D5RikFfKMU51SBFizFyL0WYuReizFyL0WYuRejDGCLkXlHI+Ucj5RykVJo+Uaj5Tins/KMUcoyADizFyMEXouRgi9FyMEXou",
  "Rgi1F6KMU1GKOUZ35SIPlId+U4D5RikFfKMU51R1TwAAGNGOsdY+x1jrIGOsdZIx1jrImOsdZAx07Z3eqHdz+ds8XVDtnd6od3P5",
  "2zwd/GEmOsdY+x1jrIGOsdZIx1jrImOsdZAx07Z3eqHdz+ds8XVDtnd6od3P52zwd/GEGOsdY+x1jrIGOsdZIx1jrImOsdZAx07Z",
  "3eqHdz+ds8XVDtnd6od3P52zwd/HG2OMcY6xxjjH2OMcZIxxjjImOMcY+xw7J3OqHcz+dk8XVDsnc6odzP52Tyd/GNGNsdZ8xRjr",
  "P2PsgZ8yIHzJGfsiZAx/KGUuqZPyllD3/f5wZ/6pN/P+VJt9UGEGPsgZ8x1j7PmOsgZ+D8H4PwfsdY+yDKGUuqZPyllD3/f5wZ/6",
  "pN/P+WZt9UGNmRMgB8x1j7G2RMgB8x9jrKWSMiZAx/J+UOqZNyhk/LeWZxA/6pOAH+WZv9UGG2SMiZ8yJkDPmPsgZEyRkTIGfsiZ",
  "Ax/J+UOqZNyhk/3/f5wZ/6pN/P+VJudUFVGfsgY+x1n7P2fs/Z+z9nzIGfMfY6xs7Z3XKHd6ods8DlHfuSco1kH7kmqA/GEGMs/Z",
  "+z9kDP2fs/Y+yBnzIGfMfY6z87J3XKHd6ods8DlAfuSco1kH7kmqA/GEmPs+Y6xtn7IGPsiZ8yRlLPmSMiZ8xs7J23JHb6odk77k",
  "gfuQcy1sH7kmsg/HG2Ps/Y6yBn7H2QM+Y/39kTJO/sUYyxs7J3HKHc6odk77lAfuSco1wH7kmsg/GNGOsfY6yBn7P2fs/Z+z9n7P",
  "2f5kzIz87Z3XKHd+ods8AP3IOUB81QH7kmug/GM8xMfZAyJjrPwfs/ZAD9n7H2fg/ZAD9rgP3Otc7+x9kDImOniB+xs8AP2On/GE",
  "mOsfY6yBn7P2fs/Z+z9n7P2f5izEz87Z3XJHd+ods8AP3IOSB81IH7kGtg/HG8vsfZAyJjjPwfs/ZAD9n7H2fg/ZAD9rgP3MtUB+",
  "x9kTJGOnid+xw8Dv2Og/aw8AAFVkDIPwfg/B+D8H4Pwfg/B+BkH4PwJA/YgxIrrEmIFdYgxIrbEmIFdYlNKaE0lRcCgPwfg/B+D8",
  "H4Pwfg/B+BQH4PwIA/YgxIrrEmIFdYgxIrbEmIFdYlNSaU0FRUCQPwfg/B+D8H4Pwfg/B+D8H4Pwfg/YgxIrrEmIFdYgxIrbEmIF",
  "dYlNKaE0lRQCgPwfg/AyD8DYPwfg/A6D8CgP+qdUYcxErrEWJFdYoxIrbEWJFdYbNGaU1FVkCgPwfg/B+D8DIPwMg/B+D8H4Pwfg",
  "/YgxIrrEmIFdYgxIrbEmIFdYlNKaE0lRcCgPwfg/B+D8DIPwMg/B+D8CAPwfg/YgxIrrEmIFdYgxIrbEmIFdYlNSaU0FRUDYPwfg",
  "ZB+D8DYPwMg/B+D8DoP+qdUYgxIrrEmIFdYgxIrbEmIFdYlNKaE0nRQCIPwfg/B+FEKQVAohNCiFIKgUQthdYcxErrEWJFdYoxIr",
  "bEWJFdYbNGaU1HhUzwPzQGiZ+z8zIPyxM/LEz8sBYjRA/mcz9xM0HHONmkz8r0/yvT/K6V7H+v3hdn7fzRN/NA39v7fyuz/LBP8r",
  "xXTQF/mgz9xM0nIOOmoz8sE/yyT/LEV6f+v3hQ35ojSG/M6z8H4Pywg/LCD8rxYTQM/ma39wk0XGuLmo40rs/yuz/K2V3H+v3lk0",
  "TPzQGiZ+D8H4Piul/LEX8sBYjQA/cg5KbLnXJTUc3NIrLfyut/K2V1yQP3hUzwPzQGiZ+z8zIPyxM/LEz8sBYjRA/mcz9xM0HHON",
  "mkz8r0/yvT/K6V7H+v3hdn7fzVt/NSaRn7Pyuz/LBP8rxXTQF/mgz9xM0nIOOmoz8sE/yyT/LEV7qjf3lk0QPzQGdB/781IPzSG/",
  "z+aI38PzQF/maD9yUy3IOSmaD87Lv3IHbd+5A7uf3hQFIJAQgiBCB0DwGwOsUYplsH2W8ug/BCB4DoHgOgUA2BICjEWI5UwBlTKm",
  "AnUPAAAYz5ED8H4Pwfg/B/z8P4Pwf8/B/yoH/KTmHMZ8cxnxzTmccB+D8H/Hwfg/B/z4YzB+D8H4Pwfg/B/xIH4Pwfg/44D/j4Pz",
  "mHMB8cwHxzTmc+B8D4H8i1/g/B+D8Yz5ED8H4Pwfg/B/z8P4Pwf8/B/yoH/KTmHMZ8cxnxzTmccB+D8H/Hwfg/B/z4YzB+D8H4Pw",
  "fg/B+D8H4Pwf8PB+D/jIPzmHMB8cwHxzTmc+B8D4H0hF/g/B+D8Yw5AD8H4Pwfg/B+D9aIPwfrTB+D9bgPzknJB8ckHxyjk7+WyD",
  "/f629/7/W+D8YwW2D8H4Pwfg/B+D9aYPwfi/WgD8X4P1vL/B+v8H6/1/7UB+D8H4Pwfg/B+D8Y7WeD8H4Pwfg/B+D+agPwfzbB+D",
  "+b4P1iL/B+v8H6/1/7TB+D8H4Pwfg/B+D8Y7m8D8H4Pwfg/B+D8H/Dgfg/5CD8H4P1iL/X+v9f6/1/g/48D8H+/9/8U3+D8ZE46D",
  "8H/Hwfg/5AD8H4Pwfg/B+U8H4P0mpLmgk1f6TklpL78D+aHfim2/KgD8Ym48D8H/Hwfg/5CD8H4Pwfg/B+U8H5f0npPmkk5f6TUn",
  "pP78D+aXfim2/Khb8Yp4+D8H/IAfg/5ED/n/P+f8r7/3/lIP0pJSmkkpJaTUpJS78D+aXfinlQKklMYr5SD/n/P+f8/5/z/kgPwf",
  "g/5+D/iQP0qJU24kwH+3UqJU28X/cG3y/z/S2D8Y0J+T8n5P+fk/5/z/iBPyfk/J+T8n5P0/E/B/ITv5P9/yA7+T8H5P+/k/T+T4",
  "Y1J+T8n5P+fk/J+T/hxPyfk/J+T8n5P0/E+B9IkH5PwfyAB+T8H5Pwfk/T+T4ZbJ+T8n5Pyfk/J+T/hhPyfk/5+T/n5P0/E+B8T4",
  "HxPgfSEB+T8H5Pwfk/T+T4YIJ+T8n5Pyfk/J+T+ZM/5/zNB+D+YIP0qJZSyln/6SUkpJ/9v7/2/t/f+39/5iDwAAEVGOs/Z+x8H4",
  "P2RM/ZAD8H7P2fg/B+D/Kjfym5UKWU3KhUMqN/KblQpZTcqFQENmPs/Z+yAH4P2RM/ZSz8H7JAfg/Y+D/KTfyn5TKaU/KRUsst/K",
  "flkppT8slSGVWPA/Z8x0HzPmPA/Z8x0HwPmQA+Y8D7LLf8HZUL/gnLJf8HZUL/g7LOCcqY/HVGOsfY6x9jrH2OsfZIylkjKWSMpZ",
  "IynKjfym5UKWU3KhUMqN/KblQpZTcqFQENGOsbY6yRjrImOsgY6xRkTFGQMfYoxuYgP3GzNB+42aDi2mg/B+D+SgPwfg/ENmOsZY",
  "6x9jLIGPspZIx9kTGWOseY6x+YgP3GzPB+42aTi2mg/B+D+SgPwfg/EVWPMZY6x5jLIGRMpY8x1kjHmRMgY6x6YgP3HTOB+46bLj",
  "WnA/n+D+SQPwfg/FVGOsNYgxJiDFGNsdYoxtjrG2QMiZAySagP2mz/B+42aTi2mg/B+D+aAPwfg/EEGOsbY6yJn7IGfsfY6z8H4P",
  "wfg/B+D/KDf8mu/yg7937vwfsQYoxln7FGQA/EEmNsdY2yRn7ImfsgY+z8H4Pwfg/B+D/P4Pwfs/z+z9n7P2Ns/Z+xln7P2KA/EM",
  "2OMdY4yRn7ImfsgY+z8H7IAfg/ZED9iTP2fsPZ+z9iDP2KM/Z+xwH7P2Pg/FNGQK+Z8yBXwPmQK+B8yAHzIGPg/ZAD9juS8msdyX",
  "k1juS8msdz8x1jYP2Og/EEGOsbY6yJn7IGfsfY6z9j4P2QA/ZED/LIPwf5fz/n8H+f5oA/P/Nuf5/5ug/FEmPg/Z+yIH4P2QA/Y+",
  "D9kAP2PsbZ+D/LYPwf5fz+D/P4P5tg/m7P+bc35/g/GVGOg/B+z8H4P2fg/B+D8H4Pwfg/B+D/LoPyqZbz+VvLoPyul/wJgTBoPw",
  "fg/HVGIMPYgxRjbFGNsdY+xtjrH2QMdZAyTLoPyqZbz+VvLoPyug/wJgTBoPwfg/lg8AAACQnwP+/EOJ+D8h5PyHA/B+D8H4Pwfg",
  "/IaD8H4Pwfg/B+D8hoPwfg/kWD8H4PwCcnwPwfkPJ+D8iAPyHg/B+D8H4Pwfg/IcD8H4Pwfg/B+D8hwPwfg/kaD8H4PwCknwPwfk",
  "RJ+D8iQPyIk/J+RMn4PyJA/Ihj+f8/5/z/n/P8iBP8f4UwXgvAGCxVkjIPwfg/B+D8H4Pyfg/B+T8H4Pyfg/IkD9YUkpKSSx+v9Y",
  "S0gfrQWEstYSyYFlYS0lqLCW2t1YS0lhLSWosJba3VhLSPED+bJ4EfzZPDP89IP5qI/PJP8H4P4FlYS0lqLCW2t1YS0lhLSWosJb",
  "a3VhLSO8D+bJ3wfzZPSD88gP5qA/PGD8H4P4hhYK0VprBWyttYK0VgrRWmsFbK21grRO+eEH523IORPIj9yJ42/uRck1EH4P4hhY",
  "K0VprBWyttYK0VgrRWmsFbK21grRO+eEH523IORPIj9yJ42/uRck1EH4P4FlYS0lqLCW2t1YS0lhLSWosJba3VhLSPED+bJ4EfzZ",
  "PDP89IP5qI/PJP8H4P4FlYS0lqLCW2t1YS0lhLSWosJba3VhLSO8D+bJ3wfzZPSD88gP5qA/PGD8H4P4jpYa01qLDW2t1Ya01hrT",
  "WosNba3VhrTPGeA7p6gfg/PAd09QPzyHqPGj9H6P4jpYa01qLDW2t1Ya01hrTWosNba3VhrTB+D88B3TvHbR+eMH7kzyA/ckekH7",
  "f4VdYC0FlrAzAstYC0FtrQWyttZawFoLL3AD8H4P8/5/B+D/bYPwfg/B+D/b24IVpYa01lrDzAstYa01trTWyttZaw1prL3HuDbo",
  "P8/5/3TuRH4P2pNTB+j/cG44RtYi1FnLEzAs5Yi1FvLUW6t5ZyxFqLO3ID8H4P8/5/28D8H7f8/5/3A3/P7f4VpYa01lrDWmstYa",
  "01trTWyttZaw1prL26D8H4P8x5/B+D+ScjpISNB+D8H4P5FPAAAAry7NTLeXZqN/y236agP8pZTypn8H+f1iA/B+D8H4Pwfg/B+D",
  "8H4Pwfg/B+D8Ary7NTLeXZqN/y236agP8t5cy7n8H+f1lg/B+D8H4Pwfg/B+D8H4Pwfg/B+D8Iry7NTLeXZqN/y236agP8pZTypn",
  "8H+f1mg/B+D8H4Pwfg/WcD8H4Pwfg/B+D8Iky7NTLeXZqN/y236agP8t5cy7n8H+f1oA/agtAH7UFoA/WiD/H+P8F4JwWD8RbYoz",
  "5igP2NA/Yoz5igP2Ng/Yoz5igP8uzUy3l2ajf8tt+moD/KWU8qZ/B/n8RbY+D9ijPmKA/Y6D9ijPmKA/Y2D9igP8uzUy3l2ajf8t",
  "t+moD/KWU8qZ/B/1QRbYoz5igP2NA/Yoz5igP2Ng/Yoz5igP8uzUy3l2ajf8tt+moD/KWU8qZ/B/n8VbY+D9ijPmKA/Y6D9ijPmK",
  "A/Y2D9igP8uzUy3l2ajf8tt+moD/KWU8qZ/B/1QRUY6D5joP2QA/Y6D5joP2RA/Y6D5joP8uzUy3l2ajf8tt+moD/LeXMu5/B/n8",
  "RUZID9joPmOg/ZED9joPmOg/ZAD9joP8uzUy3l2ajf8tt+moD/LeXMu5/B/1QRUY6D5joP2QA/Y6D5joP2RA/Y6D5joP8uzUy3l2",
  "ajf8tt+moD/LeXMu5/7/38VUZID9joPmOg/ZED9joPmOg/ZAD9joP8uzUy3l2ajf8tt+moD/LeXMu5/6p1QQXZAD9j7IgfsbY+yB",
  "kgP2fsiZ+D9kAP8wTay/NDMAP5tT/m3l/ME3cv5gm2D8VZZED9kDJAfsgZCyJlQP2fskZ+D9kQP8xTazBNLMQP5tT/m3mDMU3cwZ",
  "im2D8ZbB8D7MgP2SA/ZEysH7P2RM/ZID9lQPzpHUy8D87eXm/nUy83/LwPz/4EwI38dWO+D87rfzwHfb+d9n7E2KMaYoxNn7P2Rz",
  "/Z+z9v+Wm/5aB+3/7f2/qfU+h9CWTwAAAINng/B+D/f4Pwfg/2gD8H+z9/g/2aD/ZIP9/g/3+D8H4P9lg/B/snf4P9kg/HVNp4/x",
  "///Lv1Mu5b+9lT8H5MGYAx+D7boPwfg/B+D8H4P8B4DL/gPAZf8B4DGWcuz/m3l2f82ctz/mplvLs4s/n/P+D9iTEmMsSY2x1iDE",
  "gfMSYyxJjbHWIMSGOsuz/m3l2f82ctz/mplvLs48/n/P+D9ibE2MsTY2x1iTEwfMTYyxNjbHWJMTGF8tz/mzluf81Mtz/mllvLs5",
  "M/n/P+D9iDEGKMQYyxthzEAfMQYoxBjLHWPMfHOMtz/mzluf81MtzSmpNvAM3sAzhy3OFiLEWKMRYyxtiDEZozUYpNtjM22QzbGW",
  "cuz/m3l2f82ctz/mplvLs4s/n/P+D9iTEmMsSY2x1iDEgfMSYyxJjbHWIMSGOsuz/m3l2f82ctz/mplvLs48/n/P+z9ibE2MsTY2",
  "x1iTEwfMTYyxNjbHWJMTGF8tz/mzluf81Mtz/mllvLs5M/n/P+D9iDEGKMQYyxthzEAfMQYoxBjLHWPMfHOMtz/mzluf81MtzSmp",
  "NvAM3sAzhy3OFiLEWKMRYyxtiDEZozUYpNtjM22QzbEWcuzQzBNLMWYJszeB/N3P+WQf5bZ/l1qDUipFdKkVIrpUmoNSKkV0qRUi",
  "ulSFWcuzQzBNLMWYJszgB/OLP+WQf5bZ/l1qDUipFdKkVIrpUmoNSKkV0qRUiulSEKVpL/X+s1f6/1/r/X+v9f6/1/r/X+v/yXf+",
  "/+Z9/3/v/f+/sQYkw1kDP2PseEKll5/P+tPP5/8/5/X/n/P6/8/n/X+f/f+/9/7/3/v/f+/9t7/3/t3f+/9vb/EJ1oZ/P+svP5/8",
  "/5/Wdn/P5/8/n/z+f/bu/9/7b3/v/bO/9/7N3/v/Z2/9ob/AKdpA/B+D8H4Pwfg/B+D8H4Pwfg/B+D9aQPwfg/B+D8H4P+qdU6p1",
  "TqnVOqdUjysAAACQfwzR/jNH+M0f40BpD/H+NAf40h/jLGWP8f4/x/j/GWP8f4zR/jNH+M0f4/wCAagPxpDQB+P8f4Pwfj/B+D/K",
  "Wfwfg/GgD8H4PwfjLB+M0H4Pwf4/z/lTP4PwERxbjXfNNd+41xbkHJONd81B37UnfuLB+D8H4Pwfg/B+D8H4Pwfg/B+D8H4PwABq",
  "jv3JNQd+4t3zS3fuNaa793+VHfu/Z+7934P3fu/d+z8H7v3fu/yzn8H4PxjRxbjWmtNd+41xbkHJNNd+1B37UnfuLY2x0HzEmGsg",
  "Y+D9jrP2PsdZ+x8H4PxhBqjv3JNQd+4tpbTXfuNcW0137jWm9UY2x0HzEGGsgY+D9kDP2RMgZ+x8H4PxlRpbjWmtNd+41xbkHJNN",
  "d+1B37UnfuLZAx9jrImSMfZEyIH7IGQA/Y+x8H7GxxBqjv3JNQd+4tpbS3ftNd+41pvVGodUZAyIH7H2Pg/Y2x0H+VMs4+y3j7Lu",
  "PiESaAP8uzQB/l2aGW8uz/PEeTqh4ppdUcW41RrjVGuNUa41SDjVHqPV+5BSCvyCSaAP8uzQB/l2aGW8u5/PEeDqh35nz/cW41Rr",
  "jVGuNUa41SDjVFqLV+5RQivy0SaAP8uzQB/l2aGW8uz/PEeTqh4ppdUcW41RrjVGuNUa41SDjVHqPV+5BSCvyySaAP8uzQB/l2aG",
  "W8u5/PEeDqh35nz/cW41RrjVGuNUa41SDjVFqLV+5RQifxhBjLP2KMZB+xsH7HWfsfY6D8H4Pwfg/myD9xM1N/uEmg0kH81HCOJm",
  "zP+boPxjFjrH2QMdB+x9kDImfsiZIx9n4P+/9/m0D9xU1N/uJmk0oH81HEuKm1P+boPxhJj7HWOMgY+xxkTIGPskZEyBlLJGRMrm",
  "2D9xc2d/uJmk0sH83XEuLm3P+agPxzNnzKWU9+ZIyTqjImRdUZIyRn+T8ng/m4D+bs3MnzdylN+f8/2GMP7+wxh/VLJPAAAZJyll",
  "LAWUspYCyllLAWUspZSyzg3KmAlBOCcEoJwDglBOCUA4BwCgHEuEUA0A0JwFlDKWfwfg/B+D9YQPwfg/B+D8H4P2/uA+793//1Pq",
  "f/aED8H4P+/9////8Ag66D8H4Pwfg/B+D8HwPgfA+B8D4HwPv/g/B+D4H4Pwfg/B+D4H4Pwfg/B+D8Ag/9/7/3/gfA+B8D4HwPgf",
  "A+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4AgB8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4",
  "AgB8D4HwPgfA+B8D4PwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4AgB8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4",
  "HwPgfA+B8D4HwPgfA+B8D4AgB8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4AgB8D4HwPgfA+B8D4",
  "HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4AgB8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA",
  "+B8D4AgB8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4AgB8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA",
  "+B8D4HwPgfA+B8D4HwPgfA+B8D4AgB8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4AgB8D4HwPgfA",
  "+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4AgB8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4H",
  "wPgfA+B8D4AgB8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D4HwPgfA+B8D6OMwAAAIMtn+yjllYCwMqLAyk0A/7Q",
  "j/n/P+f9xaP3GuRwaj9x2fnGrAz+sLP+f0fg/AIAfg/B+D8H4PgfA+B+D4HwPgfd+6p1Tv3fv/f+78D4HwPu/d+B8D7vwPgfA+YW",
  "QMg/A2BkH4HQfgZB+BsDIPwOg/AyD8CQPwIASB+BAH4EgfgQAkD8CAPwJA/YFQMt/A2Blv4HW/gZb+BsDLfwOt/Ay38CTvwIASd+",
  "BB34EnfgQAk78CDvwJO/YFwKN/AyBRv4G2/gUb+BkCjfwNt/Ao38CDvwHAQd+A534EHfgOAg78BzvwIO/YFAKN/AyBRv4G2/gUb+",
  "BkCjfwOt/A238CLvwGgRd+A134EXfgNAi78CnfwKd/aOQJA/AkD8H4PwKA/B+BIH4PwJA/B+D8DIPwMgQB+BkH4HQfg/A2D8DIPw",
  "fg/aFQJA/AkD8H4PwJA/B+BkH4PwJA/B+D8DIPwMgOB+BkH4Hgfg/A6D8DIPwfg/aFAIg/AiD8H4PwKA/B+BsH4PwKA/AyD8DYPw",
  "NgUB+BsH4Hgfg/A6D8DYPwOg/aWQKA/AoBIH4FAfg/AyD8H4PwKA/B+D8DYPwfg/B+D8H4PwOg/B+D8DYPwfg/ZFQJA/AkD8H4Pw",
  "KA/B+BIH4PwJA/B+D8DIPwMgQB+BkH4Hgfg/A6D8DIPwfg/ZUgHA/AcD8H4PwJA/B+BsH4PwJA/B+D8DIPwMgSB+BsH4Hgfg/A6D",
  "8DYPwfg/ZWwKA/AoD8H4PwKA/B+BsH4PwJA/A2D8DYPwNgSB+BsH4Hgfg/A6D8DYPwPA/bFARA/B+CEH4PwRA/BED8H4PwSA/B+D",
  "8DoPwNgdB+BsDoPwPA/B+D8EIPwfg/ASQOgeA2D8DoPwMgbB+BQDIPwJA/AyD8EQPwfg/B+D8H4Pwfg/B+D8H4Pwfg/ASQJA/AkD",
  "8H4Pwfg/B+D8H4PwMg/6p1QHwEAfg/B+D8H4PwfA/AgD8H4FAfg/0C8AADVYZ4yhpDRGkM8aQ0RnjKGkNEaQzxpDRY+z9jTImfs/",
  "Z+z9n7P2Qs/ZEz9j7PzZUZ4yhpDRGkM8aQ0RnjKGkNEaQzxpDRZCz9j7JGfs/Z+z9n7P2SM/ZEz9kLPzhQZ4yhpDRGkM8aQ0RnjK",
  "GkNEaQzxpDRZCz9kTJGfs/Z+z9n7P2Vs/ZUz9kLPzxUZ4yhpDRGkM8aQ0RnjKGkNEaQzxpDRZEz9jzP2SM/ZCz9ijEWNMeZCxRjz",
  "ITlZjQP3fsUB+79j4P2NA/d+xQH7v2Pg/E+J0T4oRRCfFCKIX4nxQiiFCJ8Tonz1higP3fsRB+79jYP2KA/d+xoH7v2Ng/FCJ4UI",
  "ohSChFEKQX4oRRCkFEKETwnzltj4P3fsdB+79jYP2Pg/d+xsH7v2O9UFIKIUIqxfiiFCJ8UQoRPikF+J0TYoTxFjTEGMsaY8x9kL",
  "Imf4/x/j9kLP8fs/E8J8TwnxPCfE8J8RwkRNCeEiJoTwoTRIj5GyREbI+RskRGyPkbJERsj5GyREb5Fz/knH+f8/5/z/jfP+f8i5",
  "/z/kPPzVMj5HCREcI+RwkRHCPkcJERwj5HCREc4+D/kPHAfg/mjNIH4P+O8iB+D/kIPzRQkJHSSEdJCR0khHSQkdJIR0kJHSSEd5",
  "JyEH/JAfg/P+D/kgPwf8qB+D/lYPzVUkJHiSEeJCR4khHiQkeJIR4kJHiSEe5UD8H4P5vTdm3NoH4DgIgUA0BQCQDjAIB4Pwfg/B",
  "+D8H4PwFg/B+AsH4PwFg/AWD8BQCwfgSB+D8CIPwfgPB+D8CIPzQQBoPwfg/B+D8H4PwKA/B+BIH4PwIg/AID8H+BMCA/B+D8CIP",
  "wfgPB+D8BvfzlYCQPwfg/B+D8H4Pwfg/B+BEH4PwIg/AeD8H+Xx/j/y+D8HwPwfgNB+D8BoPzxUCQPwfg/B+D8H4Pwfg/B+D8H4P",
  "wf9/AcD8H+Xgf5/y8D9hTDmJMaYoxpiLEs0PAAAAAH8M0aQ2RqDNGoNsbI/xuj/GiP8bo/xhD/GkP8f4/xoj/GkM0aQ2RqDNGoNs",
  "AAGkM0aQ2RqDNGoNsbI/xpD/H+P8fw/hsj/GkP8aI/xmj/GkM0aQ2RqDNGoNsAAH8N0bI3RpDZGaNAZw/xpD/G2P8bw/xsj/GkP8",
  "Zo/xkj/G2NIZw0hljOGEMkAAH+Nsag2xoDUGWM4Zo/xpD/GyP8bo/xiD/GWP8f4/xqD/H+NAZo0BkjNGAMQAAH+NkaQ2RnD/G2P8",
  "f41BoDUGaP8bI/xhD/GSP8ZYzhiDLGAP8Yg/xkjNGkMkAAH+NIZw0hlj/GoP8bI/x/j/H8P4fw/hnD/GWP8aA/xnDQGSNAbI3Rtj",
  "QG2N4AAH8NAbI3RtjQG2N4bo/xwD/GoP8cA/xuj/GyP8ag/xoD/GyNAbI3RtjQG2N4AAGyNAbI3RtjQG2N4bo/xsj/HAP8bo/xuj",
  "/GyP8fw/h/D+H8OAbo4BsjdGgMsAAHSOIbo4hsjdGkNkbY/xvj/HEP8dI/xpD/GyP8bo/xwD/G+OIbY3xpDbGeNIAAHIOAbY4BqD",
  "bGgNQbI/xuj/HAP8cg/xoD/GoP8bY/xvj/G6OIbI3RpDZGeNIAAHEN8bg3xqDcGeNIaA/xwD/H+N0bI3Rnj/GkP8ag/xuD/H8N0b",
  "I3RpDZG6OAAAGkP8b4/x/jbGoNsaA/xuj/H+NkaQ2RvjbGoNsaA1BtjfG6NkaQ2RnjSGyP8AAGeOAb43RuDfGoNwbo/x/j/H8P4f",
  "w/hsjUGyNIag/xiD/GaN0ag0BmjEGAMQAAH8OAcY4BujgG0N0cA3RtDdGkP8fw/hmj/H+P8aA/xpj/GUP8fw/h/DgG8N0AAH8N4c",
  "Q3htjeGoNsbw2xqD/H8P4fw/htj/GWP8Zw/xoj/GIP8fw/hwDeG6NsAAH8N0cA3RsjdGkNkbg2RpDZGeP8fw/hsj/GSP8Zo/xnj/",
  "GEP8fw/h/DdG4NqoDwAAAAGIE/B+D9jZPwfg/YmT8H4Pwfg/YkT9gBPwfs/YWT8H4P2Bk/YYD9hYP2Ek/ACWIA/Yn39iXP2IA/Yf",
  "39iXf2F9/7/35gYP2Fk/Yhz9hIP2F9/Yf39gXf+/9+Gd2Id/YWD9iQP2Fg/Ynz9iTEGJd/YWD9hff2Bg/YWD9gYP2Ic/Ycwxh3f2",
  "BA/GdWIA/YWxBiXP2FsSYn/9iTEGJMLY2xlhYP2BsLYdz9gTDmIf/YcwxhzAmJsSGc2JsSYgxNiTEGHsSYgwtiDEmJsZY2x1iDDm",
  "GMLYSwNgTCWBsAYGwlhbDWHMNGcmPMdY2x5jrG2NMdY2D9iQP2Ng/Y6D9hbP2fs/Ykz9n7P2HA/Z+D9n4P2Gg/GcGPMgY8yBkTIG",
  "PMgZExJiDEmNMSYgxJhYP2HA/YaD9hYP2Eg/YaD9gQP2FMNGe2NsSYgxJjrEmIMSY8xJiDEmOsSYgxJhYP2fsNZ+D9hwPwfsCYGw",
  "lhbDWHMQGeWPMiZAyJjrImQsick5NyTk3JOTck5NjbHmOseY0x1jjHeRA/B+D8H4Pwfg/GeWPMiZAyJjrImQsick5NyTk3JOTck5",
  "NjbHmOseY0x1jjHcBYCR/gJH+EsG4/Gc2EsLB8wwHzDgfMQB8xIHzE2MsTYkxBgTA2fMJZ8wsHzDAfMOB8xBiTEGHMMGc2GA/B+D",
  "8H4P2HM/B+D8H7P2IA/B+D9hIPwfg/B+D9hbPwfg/B+z9hgPwfg/GdWJsSYgxlibEmNsZYmxxjbGWPMcY2xliDDmGMSYgw5ibEmI",
  "MZYmxJjbGWJsSHZeRA/B+D8H4Pwfg/z/n/LeWz1nbOXn9jzf2vNecc45rwP8f4/wFgvH+AsF4/GemIE/B+D9jZPwfg/YmT8H4Pwf",
  "g/YkT9gZPwfs/YgT8H4P2Fk/B+D8H4P2Ek/GeWIA/Yn39iXP2IMPZ8xJn7EGHsLYaw9hYP2Id/Ydz9hjC2fsPZ+w1hbAmEsLlS8A",
  "AA=="
].join("");
var soundBytes = null;
function sfcFactorySound() {
  if (!soundBytes) {
    const bin = typeof atob === "function" ? atob(SFC_FACTORY_SOUND_BASE64) : Buffer.from(SFC_FACTORY_SOUND_BASE64, "base64").toString("latin1");
    soundBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) soundBytes[i] = bin.charCodeAt(i);
  }
  return soundBytes;
}
var SFC_FACTORY_BGM_PATCH = Object.freeze([
  17,
  18,
  19,
  20,
  21,
  22,
  22,
  23,
  24,
  22,
  25,
  26,
  16,
  28,
  29,
  27
]);
var SFC_FACTORY_PICKER_ROWS = Object.freeze([
  231,
  28,
  239,
  61,
  255,
  127,
  3,
  0,
  7,
  0,
  15,
  0,
  31,
  0,
  96,
  0,
  224,
  0,
  224,
  1,
  224,
  3,
  0,
  12,
  0,
  28,
  0,
  60,
  0,
  124,
  247,
  135,
  255,
  127,
  0,
  0,
  16,
  66,
  31,
  0,
  224,
  3,
  0,
  124,
  255,
  3,
  32,
  127,
  16,
  1,
  13,
  124,
  31,
  18,
  119,
  50,
  142,
  127,
  159,
  105,
  160,
  1,
  110,
  183
]);
var SFC_FACTORY_RESERVED0 = Object.freeze([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  96,
  49
]);
var SFC_FACTORY_RESERVED1 = Object.freeze([
  127,
  223,
  255,
  126,
  255,
  255,
  255,
  255,
  253,
  251,
  255,
  255,
  254,
  205,
  255,
  255,
  247,
  255,
  255,
  251,
  223,
  247,
  255,
  247,
  255,
  135,
  255,
  125,
  255,
  255,
  247,
  255,
  255,
  186,
  255,
  238,
  255,
  251
]);
var SFC_FACTORY_SHIP_WORDS = Object.freeze([
  512,
  513,
  520,
  521,
  514,
  515,
  522,
  523,
  516,
  517,
  524,
  525,
  518,
  519,
  526,
  527,
  528,
  529,
  530,
  531,
  532,
  533,
  534,
  535,
  552,
  553,
  554,
  555,
  556,
  557,
  536,
  537,
  544,
  545,
  538,
  539,
  546,
  547,
  540,
  541,
  548,
  549,
  542,
  543,
  550,
  551,
  558,
  559,
  560,
  561,
  562,
  563,
  564,
  565,
  566,
  567,
  568,
  569,
  570,
  571,
  572,
  1020,
  1021,
  1022
]);
var SFC_FACTORY_GLOBAL_ROWS = Object.freeze([
  0,
  0,
  136,
  49,
  179,
  86,
  222,
  123,
  192,
  2,
  227,
  43,
  15,
  0,
  57,
  17,
  159,
  62,
  35,
  85,
  75,
  114,
  118,
  127,
  16,
  2,
  57,
  43,
  255,
  103,
  0,
  0,
  10,
  78,
  76,
  82,
  110,
  90,
  176,
  94,
  210,
  98,
  20,
  107,
  86,
  111,
  120,
  119,
  186,
  123,
  255,
  123,
  0,
  52,
  162,
  2,
  41,
  3,
  143,
  3,
  245,
  3,
  160,
  1,
  31,
  0,
  255,
  0,
  255,
  1,
  31,
  3,
  159,
  3,
  255,
  31,
  255,
  51,
  255,
  75,
  255,
  103,
  255,
  127,
  23,
  0,
  14,
  0,
  10,
  0,
  5,
  0,
  1,
  0,
  160,
  1,
  0,
  0,
  8,
  33,
  16,
  66,
  247,
  94,
  255,
  127,
  181,
  0,
  95,
  1,
  191,
  14,
  255,
  23,
  64,
  97,
  36,
  114,
  231,
  126,
  32,
  6,
  224,
  2,
  224,
  3,
  255,
  127
]);
var SFC_FACTORY_BOSS_BLOCK = Object.freeze([
  28,
  32,
  20,
  0,
  112,
  0,
  112,
  223,
  244,
  223,
  244,
  31,
  17,
  2,
  2,
  48,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1
]);
var SFC_FACTORY_TITLE_TYPE = 522;
var SFC_FACTORY_MOUSE_SPEED = 0;
var SFC_FACTORY_EDIT_BGM = 0;
var SFC_FACTORY_KEY_CONFIG = Object.freeze([32, 8, 16, 32]);

// packages/shmup-engine/src/sfc/sfc-format.js
var SFC_EMPTY_WORD = CHIP_BLANK_WORD;
var APPEAR_HEADER_ZEROS = 14;
var APPEAR_HEADER_FFS = 14;
var FACTORY_HI_SCORES = Object.freeze([1e3, 900, 800, 700, 600, 500, 400, 300, 200, 100]);
var FACTORY_HI_SCORE_NAME = "........";
function putU164(bytes, at, v) {
  bytes[at] = v & 255;
  bytes[at + 1] = v >> 8 & 255;
}
function putU323(bytes, at, v) {
  bytes[at] = v & 255;
  bytes[at + 1] = v >> 8 & 255;
  bytes[at + 2] = v >> 16 & 255;
  bytes[at + 3] = v >>> 24 & 255;
}
function writeHiScore(bytes, index, { score, name = FACTORY_HI_SCORE_NAME }) {
  const at = REGION2.hiScore.offset + index * HI_SCORE_ENTRY_BYTES;
  putU323(bytes, at, score >>> 0);
  bytes.fill(0, at + 4, at + 8);
  const text = String(name).padEnd(HI_SCORE_NAME_LENGTH, " ").slice(0, HI_SCORE_NAME_LENGTH);
  for (let i = 0; i < HI_SCORE_NAME_LENGTH; i++) bytes[at + 8 + i] = text.charCodeAt(i) & 255;
}
function writeFactoryHiScores(bytes) {
  for (let t = 0; t < HI_SCORE_COUNT / FACTORY_HI_SCORES.length; t++) {
    FACTORY_HI_SCORES.forEach((score, i) => writeHiScore(bytes, t * FACTORY_HI_SCORES.length + i, { score }));
  }
}
function blankQuadRegion(bytes, region5, word = SFC_EMPTY_WORD) {
  const words = new Uint16Array(region5.length / 2).fill(word);
  writeWords(bytes, region5.offset, words);
}
function writeClearedTables(bytes) {
  for (let s = 0; s < STAGE_COUNT3; s++) {
    const mapAt = REGION2.mapGroup.offset + s * MAP_GROUP_STAGE_BYTES;
    bytes.fill(255, mapAt, mapAt + MAP_GROUP_STAGE_BYTES);
    writeWords(bytes, mapAt, [CHIP_BLANK_WORD]);
    const enemyAt = REGION2.enemyGroup.offset + s * ENEMY_GROUP_STAGE_BYTES;
    bytes.fill(255, enemyAt, enemyAt + ENEMY_GROUP_STAGE_BYTES);
    writeDefaultScroll(bytes, s);
  }
  blankQuadRegion(bytes, REGION2.bossGroup);
  blankQuadRegion(bytes, REGION2.titleGroup);
  blankQuadRegion(bytes, REGION2.myShipGroup);
  for (const [slot, word] of MY_SHIP_FORCED_SLOTS) writeWords(bytes, REGION2.myShipGroup.offset + slot * 2, [word]);
  return bytes;
}
function writeAppearHeaders(bytes) {
  for (let s = 0; s < STAGE_COUNT3; s++) {
    const at = REGION2.appear.offset + s * APPEAR_STAGE_BYTES;
    bytes.fill(0, at, at + APPEAR_STAGE_BYTES);
    bytes.fill(255, at + APPEAR_HEADER_ZEROS, at + APPEAR_HEADER_ZEROS + APPEAR_HEADER_FFS);
  }
}
function formatSfcSram({ seal: seal2 = true } = {}) {
  const bytes = new Uint8Array(SRAM_SIZE);
  for (let i = 0; i < CHECK_STRING.length; i++) bytes[CHECK_STRING_OFFSET + i] = CHECK_STRING.charCodeAt(i);
  bytes.set(SFC_FACTORY_RESERVED0, REGION2.reserved0.offset);
  bytes.set(SFC_FACTORY_RESERVED1, REGION2.reserved1.offset);
  bytes.set(SFC_FACTORY_PICKER_ROWS, REGION2.palette.offset + 22 * 32);
  putU164(bytes, REGION2.titleType.offset, SFC_FACTORY_TITLE_TYPE);
  putU164(bytes, REGION2.mouseSpeed.offset, SFC_FACTORY_MOUSE_SPEED);
  putU164(bytes, REGION2.editBgm.offset, SFC_FACTORY_EDIT_BGM);
  bytes.set(SFC_FACTORY_BGM_PATCH, REGION2.bgmPatch.offset);
  bytes.set(SFC_FACTORY_KEY_CONFIG, REGION2.keyConfig.offset);
  bytes.set(sfcFactorySound(), REGION2.sound.offset);
  writeFactoryHiScores(bytes);
  blankQuadRegion(bytes, REGION2.endingGroup);
  writeClearedTables(bytes);
  writeAppearHeaders(bytes);
  if (seal2) sealSfcChecksums(bytes);
  return bytes;
}

// packages/shmup-engine/src/sfc/sfc-write.js
var SFC_FIRST_SPAWN_LINE = 2;
var SFC_LINE_STEP = 4;
var SFC_BOSS_LINE_GAP = 12;
var SFC_LAST_SPAWN_LINE = APPEAR_LINES - 2;
var SFC_STORY_TOP_ROW = 11;
var SFC_STORY_LEAD_LINES = 8;
var SFC_STORY_MIN_BOSS_LINE = 80;
var SFC_STORY_FIRST_COL = 1;
var SFC_HIT_UNITS = 25;
var SFC_DEFAULT_AIM = 13;
var SFC_TITLE_COLS = 8;
var SFC_TITLE_ROWS = 4;
var SFC_SHIP_POSE_PX = 32;
var SFC_SHIP_POSE_SLOTS = Object.freeze({ left: 0, centre: 4, right: 8 });
var SFC_TITLE_SCENE = Object.freeze({ w: 256, h: 480, logoY: 75, subtitleY: 130 });
function nearestIndex5(table, value) {
  let best = 0, bestD = Infinity;
  table.forEach((v, i) => {
    const d = Math.abs(v - value);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
function clamp5(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function b64ToBytes4(b64) {
  const bin = atob(String(b64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function sfcBossIsTall(w, h) {
  const wideW = BOSS_SHEET_COLS * CHIP_DIM, wideH = BOSS_SHEET_ROWS * CHIP_DIM;
  const scaleWide = Math.min(1, wideW / w, wideH / h);
  const scaleTall = Math.min(1, wideH / w, wideW / h);
  return scaleTall > scaleWide;
}
function sfcSpawnColumn(col, width) {
  if (width <= 1) return APPEAR_FIRST_COLUMN + Math.floor(APPEAR_COLUMNS / 2);
  return APPEAR_FIRST_COLUMN + Math.round(clamp5(col, 0, width - 1) * (APPEAR_COLUMNS - 1) / (width - 1));
}
function sfcClassFor(w, h) {
  if (w <= 16 && h <= 16) return 0;
  if (w <= 32 && h <= 16) return 1;
  if (w <= 16 && h <= 32) return 2;
  if (w <= 32 && h <= 32) return 3;
  return 4;
}
var SFC_CLASS_BOXES = Object.freeze(SFC_ENEMY_CLASSES.map((c) => Object.freeze({ w: c.w, h: c.h, count: c.entries })));
function sfcSramFileName(name) {
  const safe = String(name || "game").replace(/[\\/:*?"<>|]+/g, " ").trim() || "game";
  return `Dezaemon SFC - ${safe}.srm`;
}
var SfcChipBank = class {
  constructor(capacity = USER_CHIP_COUNT) {
    this.capacity = capacity;
    this.chips = [];
    this.byKey = /* @__PURE__ */ new Map();
    this.shared = 0;
  }
  get used() {
    return this.chips.length;
  }
  /** {chip, hflip, vflip} for a 256-index raster, null when the bank is full. */
  add(pixels) {
    const key = keyOf2(pixels);
    const hit = this.byKey.get(key);
    if (hit) {
      if (hit.hflip || hit.vflip) this.shared++;
      return hit;
    }
    if (this.chips.length >= this.capacity) return null;
    const chip = this.chips.length;
    this.chips.push(Uint8Array.from(pixels));
    const plain = { chip, hflip: false, vflip: false };
    this.byKey.set(key, plain);
    for (const [h, v] of [[true, false], [false, true], [true, true]]) {
      const k = keyOf2(flipChip(pixels, h, v));
      if (!this.byKey.has(k)) this.byKey.set(k, { chip, hflip: h, vflip: v });
    }
    return plain;
  }
  /** Every chip into the image's two sheets. */
  writeTo(bytes) {
    this.chips.forEach((px, i) => encodeChipPixels(bytes, i, px));
  }
};
function keyOf2(pixels) {
  let s = "";
  for (let i = 0; i < pixels.length; i++) s += String.fromCharCode(pixels[i] & 15);
  return s;
}
function isTransparent(pixels) {
  for (let i = 0; i < pixels.length; i++) if (pixels[i]) return false;
  return true;
}
function quantizeToRow(frames) {
  if (!frames.length) return { frames: [], words: [], colors: 0 };
  const q = quantizeFrames(frames.map((f, i) => ({ ...f, key: f.key ?? `f${i}`, group: "row" })), "snes", { firstRow: 0, rows: 1 });
  const words = [];
  for (let k = 1; k < 16; k++) {
    const w = q.bank[k];
    words.push(w & USER_COLOR_FLAG ? w & 32767 : 0);
  }
  const out = q.frames.map((f) => {
    const indices = new Uint8Array(f.indexed.length);
    for (let i = 0; i < indices.length; i++) indices[i] = f.indexed[i] & 15;
    return { key: f.key, w: f.w, h: f.h, indices };
  });
  return { frames: out, words, colors: q.report.rows[0] ? q.report.rows[0].colors : 0 };
}
function cutChip(indices, w, cx, cy) {
  const out = new Uint8Array(CHIP_DIM * CHIP_DIM);
  for (let y = 0; y < CHIP_DIM; y++) {
    for (let x = 0; x < CHIP_DIM; x++) out[y * CHIP_DIM + x] = indices[(cy * CHIP_DIM + y) * w + cx * CHIP_DIM + x];
  }
  return out;
}
function composeTitlePicture({ logo = null, subtitle = null, backdrop = null } = {}) {
  const W = SFC_TITLE_COLS * CHIP_DIM, H = SFC_TITLE_ROWS * CHIP_DIM;
  const scene = SFC_TITLE_SCENE;
  const has = (f) => !!(f && f.rgba && f.w > 0 && f.h > 0);
  const plates = [];
  if (has(logo)) plates.push({ x: 0, y: scene.logoY, w: logo.w, h: logo.h, rgba: logo.rgba });
  if (has(subtitle)) plates.push({ x: 0, y: scene.subtitleY, w: subtitle.w, h: subtitle.h, rgba: subtitle.rgba });
  const bg = has(backdrop) ? backdrop : null;
  if (!plates.length && !bg) return null;
  let box = { x: 0, y: scene.logoY, w: scene.w, h: H };
  if (plates.length) {
    const x0 = Math.min(...plates.map((p) => p.x)), y0 = Math.min(...plates.map((p) => p.y));
    const x1 = Math.max(...plates.map((p) => p.x + p.w)), y1 = Math.max(...plates.map((p) => p.y + p.h));
    box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const scale = Math.min(1, W / box.w, H / box.h);
  const ww = W / scale, wh = H / scale;
  const within = (at, size, span2) => bg && size <= span2 ? Math.min(Math.max(at, 0), span2 - size) : at;
  const wx = Math.round(within(box.x + (box.w - ww) / 2, ww, scene.w));
  const wy = Math.round(within(box.y + (box.h - wh) / 2, wh, scene.h));
  const over = (dst, f, x, y) => {
    const s = (y * f.w + x) * 4;
    const a = f.rgba[s + 3] / 255;
    if (!a) return;
    const keep = 1 - a;
    dst[0] = f.rgba[s] * a + dst[0] * keep;
    dst[1] = f.rgba[s + 1] * a + dst[1] * keep;
    dst[2] = f.rgba[s + 2] * a + dst[2] * keep;
    dst[3] = 255 * a + dst[3] * keep;
  };
  const px = [0, 0, 0, 0];
  const sceneAt = (x, y) => {
    px[0] = px[1] = px[2] = px[3] = 0;
    if (x < 0 || y < 0 || x >= scene.w || y >= scene.h) return px;
    if (bg) over(px, bg, x % bg.w, y % bg.h);
    for (const p of plates) {
      if (x >= p.x && y >= p.y && x < p.x + p.w && y < p.y + p.h) over(px, p, x - p.x, y - p.y);
    }
    return px;
  };
  const out = new Uint8Array(W * H * 4);
  const span = (from, to) => [Math.floor(from), Math.max(Math.ceil(to), Math.floor(from) + 1)];
  for (let oy = 0; oy < H; oy++) {
    const [y0, y1] = span(wy + oy / scale, wy + (oy + 1) / scale);
    for (let ox = 0; ox < W; ox++) {
      const [x0, x1] = span(wx + ox / scale, wx + (ox + 1) / scale);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = sceneAt(x, y);
          r += p[0];
          g += p[1];
          b += p[2];
          a += p[3];
          n++;
        }
      }
      if (!a) continue;
      const d = (oy * W + ox) * 4;
      out[d] = Math.round(r * 255 / a);
      out[d + 1] = Math.round(g * 255 / a);
      out[d + 2] = Math.round(b * 255 / a);
      out[d + 3] = Math.round(a / n);
    }
  }
  return { w: W, h: H, rgba: out };
}
function buildSfcGameFromLevel(level, art2, options = {}) {
  const opts = { name: null, title1: null, title2: null, titleBg: null, horizontal: false, storyBackdrops: null, storyPicks: null, ...options };
  if (!opts.storyPicks && Array.isArray(opts.storyBackdrops) && opts.storyBackdrops.length) {
    return buildWithStory(level, art2, opts);
  }
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const name = String(opts.name || level.name || "game").trim() || "game";
  const artMap = /* @__PURE__ */ new Map();
  for (const [k, v] of Object.entries(art2 || {})) {
    if (v && v.rgba && v.w > 0 && v.h > 0) artMap.set(decodeFrameKey(k), { key: decodeFrameKey(k), ...v });
  }
  const lookup = (n) => n ? artMap.get(decodeFrameKey(n)) || null : null;
  let stages = levelStages(level);
  if (!stages.length) throw new Error("the level has no stage with an enemylist");
  if (stages.length > STAGE_COUNT) {
    warn(`level has ${stages.length} stages; a Super Famicom save holds ${STAGE_COUNT} \u2014 dropped the rest`);
    stages = stages.slice(0, STAGE_COUNT);
  }
  if (opts.horizontal) warn("the grid is horizontal; the Super Famicom game scrolls vertically and is written as such \u2014 enemies come down the screen");
  const enemyData = level.enemyData || {};
  const bossData = level.bossData || {};
  const plan = [];
  const splits = [];
  let spare = STAGE_COUNT - stages.length;
  stages.forEach((st, s) => {
    const rec = bossData[`boss${s}`] || (s === 0 && stages.length === 1 ? bossData.boss0 : null);
    const split = rec ? splitBossStage2(rec) : null;
    if (split && spare <= 0) {
      warn(`${st.key}: boss (${rec.name || "?"}) has a second stage, but the save's ${STAGE_COUNT} stages are full \u2014 it flies its first form alone, the whole bar`);
    }
    if (!split || spare <= 0) {
      plan.push({ st, bossRec: rec, form: 0 });
      return;
    }
    spare--;
    const key = `${st.key}:stage2`;
    plan.push({ st, bossRec: split.first, form: 1 });
    plan.push({ st: { key, enemylist: [], background: st.background, scroll: st.scroll }, bossRec: split.second, form: 2 });
    splits.push({ stage: st.key, into: key, name: rec.name || `boss${s}`, second: bossBodyFrames(split.second)[0] || "?", hp: [split.first.hp, split.second.hp] });
  });
  const transform = splits.length ? `approximated: two chained bosses across a stage break (${splits.map((x) => `${x.stage} ${x.name}, then ${x.into} its second form ${x.second}`).join("; ")}); the bullets stay the ROM's` : "none";
  const bytes = formatSfcSram({ seal: false });
  const bank = new SfcChipBank();
  const fullWarned = /* @__PURE__ */ new Set();
  const bankChip = (pixels, what) => {
    const hit = bank.add(pixels);
    if (!hit && !fullWarned.has(what)) {
      fullWarned.add(what);
      warn(`the save's two sheets are full (${USER_CHIP_COUNT} chips): ${what} art left unpainted`);
    }
    return hit;
  };
  const rows = [];
  bytes.set(SFC_FACTORY_GLOBAL_ROWS, REGION2.palette.offset + PALETTE_ROW_SHIP * 32);
  const shipWords = Uint16Array.from(SFC_FACTORY_SHIP_WORDS);
  let shipFrames = (level.playerData && level.playerData.texture || []).map(lookup).filter(Boolean);
  let shipSource = "level";
  if (!shipFrames.length) {
    shipSource = "duke";
    shipFrames = decodePlayerArt().filter((f) => /^duke_\d$/.test(f.key)).slice(0, 2);
  }
  const shipLevel = fitRgba(shipFrames[0], SFC_SHIP_POSE_PX, SFC_SHIP_POSE_PX);
  const shipBank = shipFrames.length > 1 ? fitRgba(shipFrames[1], SFC_SHIP_POSE_PX, SFC_SHIP_POSE_PX) : shipLevel;
  const shipQuant = quantizeToRow([
    { key: "left", ...shipBank },
    { key: "centre", ...shipLevel },
    { key: "right", ...hflipRgba(shipBank) }
  ]);
  writeCgramRow(bytes, PALETTE_ROW_SHIP, shipQuant.words);
  rows.push({ row: PALETTE_ROW_SHIP, owner: "ship", colors: shipQuant.colors });
  const shipOdr = new Uint8Array(MY_SHIP_ODR_BYTES);
  let shipChips = 0;
  const poseSlots = [SFC_SHIP_POSE_SLOTS.left, SFC_SHIP_POSE_SLOTS.centre, SFC_SHIP_POSE_SLOTS.right];
  shipQuant.frames.forEach((f, p) => {
    for (let cy = 0; cy < 2; cy++) {
      for (let cx = 0; cx < 2; cx++) {
        const px = cutChip(f.indices, SFC_SHIP_POSE_PX, cx, cy);
        const slot = poseSlots[p] + cy * 2 + cx;
        let word = CHIP_BLANK_WORD;
        if (!isTransparent(px)) {
          const hit = bankChip(px, "ship");
          if (hit) {
            word = chipWordForIndex(hit.chip);
            shipOdr[slot] = (hit.hflip ? ODR_HFLIP : 0) | (hit.vflip ? ODR_VFLIP : 0);
            shipChips++;
          }
        }
        shipWords[slot] = word;
      }
    }
  });
  writeWords(bytes, REGION2.myShipGroup.offset, shipWords);
  bytes.set(shipOdr, REGION2.myShipOdr.offset);
  let title = "none";
  const titleParts = [["logo", opts.title1], ["subtitle", opts.title2], ["backdrop", opts.titleBg]].filter(([, f]) => f && f.rgba).map(([what]) => what);
  const picture = composeTitlePicture({ logo: opts.title1, subtitle: opts.title2, backdrop: opts.titleBg });
  if (picture) {
    const q = quantizeToRow([{ key: "title", ...picture }]);
    writeCgramRow(bytes, PALETTE_ROW_TITLE, q.words);
    rows.push({ row: PALETTE_ROW_TITLE, owner: "title", colors: q.colors });
    const words = new Uint16Array(TITLE_GROUP_CHIPS).fill(CHIP_BLANK_WORD);
    for (let cy = 0; cy < SFC_TITLE_ROWS; cy++) {
      for (let cx = 0; cx < SFC_TITLE_COLS; cx++) {
        const px = cutChip(q.frames[0].indices, picture.w, cx, cy);
        if (isTransparent(px)) continue;
        const hit = bankChip(px, "title");
        if (hit) words[titleSlotForCell(cx, cy)] = chipWordForIndex(hit.chip, hit);
      }
    }
    writeWords(bytes, REGION2.titleGroup.offset, words);
    title = "uploaded";
  }
  const built = plan.map(({ st, bossRec, form }, s) => {
    const width = Math.max(1, st.enemylist[0] ? st.enemylist[0].length : level.width || 8);
    const stageReport = { key: st.key, placements: 0, records: 0, lines: 0, enemies: [], boss: null, mapChips: 0, cellsDrawn: 0, rowsDrawn: 0, story: null };
    const mapGroup = new Uint16Array(MAP_GROUP_CHIPS).fill(CHIP_EMPTY_WORD);
    mapGroup[0] = CHIP_BLANK_WORD;
    const mapSlotOfChip = /* @__PURE__ */ new Map();
    const cells = [];
    for (let r = 0; r < MAP_ROWS; r++) cells.push(Array.from({ length: MAP_COLUMNS }, () => ({ slot: 0, hflip: false, vflip: false })));
    const cellsList = Array.isArray(level.backgroundCells) ? level.backgroundCells : null;
    if (st.background && st.background.tiles && cellsList) {
      try {
        const tileBytes = b64ToBytes4(st.background.tiles);
        const cols = st.background.cols || 14;
        const tiles = new Uint16Array(tileBytes.length >> 1);
        for (let i = 0; i < tiles.length; i++) tiles[i] = tileBytes[i * 2] << 8 | tileBytes[i * 2 + 1];
        const gridRows = Math.floor(tiles.length / cols);
        if (gridRows > MAP_ROWS) warn(`${st.key}: the scenery grid is ${gridRows} rows; a stage map holds ${MAP_ROWS} \u2014 the rest is left out`);
        const ordinals = /* @__PURE__ */ new Set();
        for (let r = 0; r < Math.min(gridRows, MAP_ROWS); r++) {
          for (let c = 0; c < cols; c++) {
            const w = tiles[r * cols + c];
            if (w !== 65535) ordinals.add(w & 1023);
          }
        }
        const frames = [];
        for (const o of ordinals) {
          const f = lookup(cellsList[o]);
          if (f) frames.push({ key: `cell${o}`, ...fitRgba(f, CHIP_DIM, CHIP_DIM) });
        }
        const q = quantizeToRow(frames);
        if (frames.length) {
          writeCgramRow(bytes, PALETTE_ROW_STAGE_BG + s, q.words);
          rows.push({ row: PALETTE_ROW_STAGE_BG + s, owner: `${st.key} scenery`, colors: q.colors });
        }
        const indexedOf = new Map(q.frames.map((f) => [f.key, f.indices]));
        const firstCol = Math.max(0, Math.floor((MAP_COLUMNS - cols) / 2));
        let slotsFull = false;
        for (let r = 0; r < Math.min(gridRows, MAP_ROWS); r++) {
          for (let c = 0; c < cols; c++) {
            const mc = firstCol + c;
            if (mc >= MAP_COLUMNS) continue;
            const w = tiles[r * cols + c];
            if (w === 65535) continue;
            const px = indexedOf.get(`cell${w & 1023}`);
            if (!px || isTransparent(px)) continue;
            const hit = bankChip(px, `${st.key} scenery`);
            if (!hit) continue;
            let slot = mapSlotOfChip.get(hit.chip);
            if (slot === void 0) {
              if (mapSlotOfChip.size >= MAP_GROUP_CHIPS - 1) {
                if (!slotsFull) warn(`${st.key}: more than ${MAP_GROUP_CHIPS - 1} distinct scenery chips; the rest are left blank`);
                slotsFull = true;
                continue;
              }
              slot = mapSlotOfChip.size + 1;
              mapSlotOfChip.set(hit.chip, slot);
              mapGroup[slot] = chipWordForIndex(hit.chip);
            }
            cells[r][mc] = { slot, hflip: (w & 32768) !== 0 !== hit.hflip, vflip: (w & 16384) !== 0 !== hit.vflip };
            stageReport.cellsDrawn++;
            stageReport.rowsDrawn = Math.max(stageReport.rowsDrawn, r + 1);
          }
        }
        stageReport.mapChips = mapSlotOfChip.size;
      } catch (e) {
        warn(`${st.key}: could not read the background grid (${e.message}) \u2014 scenery skipped`);
      }
    }
    const story = opts.storyPicks ? opts.storyPicks.get(s) : null;
    if (story && !stageReport.mapChips) {
      writeCgramRow(bytes, PALETTE_ROW_STAGE_BG + s, story.q.words);
      rows.push({ row: PALETTE_ROW_STAGE_BG + s, owner: `${st.key} story`, colors: story.q.colors });
      const before = bank.used;
      const cols = MAP_COLUMNS - 2 * SFC_STORY_FIRST_COL;
      for (let cy = 0; cy < story.rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const px = cutChip(story.q.frames[0].indices, cols * CHIP_DIM, cx, cy);
          if (isTransparent(px)) continue;
          const hit = bankChip(px, `${st.key} story`);
          if (!hit) continue;
          let slot = mapSlotOfChip.get(hit.chip);
          if (slot === void 0) {
            if (mapSlotOfChip.size >= MAP_GROUP_CHIPS - 1) continue;
            slot = mapSlotOfChip.size + 1;
            mapSlotOfChip.set(hit.chip, slot);
            mapGroup[slot] = chipWordForIndex(hit.chip);
          }
          cells[SFC_STORY_TOP_ROW - cy][SFC_STORY_FIRST_COL + cx] = { slot, hflip: hit.hflip, vflip: hit.vflip };
        }
      }
      stageReport.story = { size: story.label, rows: story.rows, chips: bank.used - before, top: SFC_STORY_TOP_ROW };
    }
    const mapAt = REGION2.map.offset + s * MAP_STAGE_BYTES;
    for (let r = 0; r < MAP_ROWS; r++) encodeMapRow(bytes, mapAt + r * MAP_ROW_BYTES, cells[r]);
    writeWords(bytes, REGION2.mapGroup.offset + s * MAP_GROUP_STAGE_BYTES, mapGroup);
    if (stageReport.story) {
      writeScrollSequence(bytes, s, storyScrollSequence(Math.ceil((SFC_STORY_TOP_ROW + 1) / MAP_BLOCK_ROWS)));
    }
    const storyShift = stageReport.story ? SFC_STORY_TOP_ROW + 1 + SFC_STORY_LEAD_LINES : 0;
    const spawnRows = st.enemylist.slice().reverse();
    const waveRows = Array.isArray(st.waveRows) && st.waveRows.length === st.enemylist.length ? st.waveRows.slice().reverse() : null;
    const usage = /* @__PURE__ */ new Map();
    for (const row of spawnRows) {
      for (const cell of row) {
        if (!cell || cell === "00") continue;
        const letter = cell.slice(0, -1), digit = cell.slice(-1);
        if (!usage.has(letter)) usage.set(letter, { count: 0, digits: /* @__PURE__ */ new Map() });
        const u = usage.get(letter);
        u.count++;
        u.digits.set(digit, (u.digits.get(digit) || 0) + 1);
      }
    }
    const letters = [...usage.keys()].sort((a, b) => usage.get(b).count - usage.get(a).count);
    const counts = SFC_ENEMY_CLASSES.map(() => 0);
    const enemyGroup = new Uint16Array(ENEMY_GROUP_CHIPS).fill(CHIP_EMPTY_WORD);
    enemyGroup[0] = CHIP_BLANK_WORD;
    const sheetSlotOfChip = /* @__PURE__ */ new Map();
    const odr = new Uint8Array(ENEMY_ODR_STAGE_BYTES);
    const entryData = new Uint8Array(ENEMY_STAGE_BYTES);
    const records = /* @__PURE__ */ new Map();
    let sheetFull = false;
    const enemyFrames = [];
    const framesOf = /* @__PURE__ */ new Map();
    for (const letter of letters) {
      const rec = enemyData[`enemy${letter}`];
      if (!rec) continue;
      const frames = (Array.isArray(rec.texture) ? rec.texture : []).map(lookup).filter(Boolean);
      framesOf.set(letter, frames);
      for (const f of frames) if (!enemyFrames.some((e) => e.key === f.key)) enemyFrames.push(f);
    }
    const quant = quantizeToRow(enemyFrames.map((f) => ({ key: f.key, w: f.w, h: f.h, rgba: f.rgba })));
    if (enemyFrames.length) {
      writeCgramRow(bytes, PALETTE_ROW_STAGE_ENEMY + s, quant.words);
      rows.push({ row: PALETTE_ROW_STAGE_ENEMY + s, owner: `${st.key} enemies`, colors: quant.colors });
    }
    const indexedByKey = new Map(quant.frames.map((f) => [f.key, f]));
    const sheetSlot = (px) => {
      if (isTransparent(px)) return { slot: 0, hflip: false, vflip: false };
      const hit = bankChip(px, `${st.key} enemy`);
      if (!hit) return null;
      let slot = sheetSlotOfChip.get(hit.chip);
      if (slot === void 0) {
        if (sheetSlotOfChip.size >= ENEMY_GROUP_CHIPS - 1) {
          if (!sheetFull) warn(`${st.key}: the enemy sheet is full (${ENEMY_GROUP_CHIPS - 1} chips); later enemies draw blank`);
          sheetFull = true;
          return null;
        }
        slot = sheetSlotOfChip.size + 1;
        sheetSlotOfChip.set(hit.chip, slot);
        enemyGroup[slot] = chipWordForIndex(hit.chip);
      }
      return { slot, hflip: hit.hflip, vflip: hit.vflip };
    };
    const paintChips = (chips) => {
      for (const { at, px } of chips) {
        const ref = sheetSlot(px);
        if (ref) odr[at] = encodeOdrByte(ref);
      }
    };
    const freshChips = (chips) => {
      const fresh = /* @__PURE__ */ new Set();
      for (const { px } of chips) {
        if (isTransparent(px)) continue;
        const hit = bank.byKey.get(keyOf2(px));
        if (hit && sheetSlotOfChip.has(hit.chip)) continue;
        fresh.add(hit ? hit.chip : [[false, false], [true, false], [false, true], [true, true]].map(([h, v]) => keyOf2(flipChip(px, h, v))).sort()[0]);
      }
      return fresh.size;
    };
    const shrunkPaints = [];
    for (const letter of letters) {
      const rec = enemyData[`enemy${letter}`];
      if (!rec) {
        warn(`${st.key}: grid names enemy${letter} but enemyData has no such record \u2014 cells left empty`);
        continue;
      }
      const frames = framesOf.get(letter) || [];
      if (!frames.length) warn(`${st.key}: enemy${letter} (${rec.name || "?"}) has no art in the atlas \u2014 placed invisible`);
      const maxW = frames.reduce((a, f) => Math.max(a, f.w), 16);
      const maxH = frames.reduce((a, f) => Math.max(a, f.h), 16);
      if (frames.length && (maxW > 64 || maxH > 64)) warn(`${st.key}: enemy${letter} (${rec.name || "?"}) is ${maxW}x${maxH}; a sprite tops out at 64x64 \u2014 downscaled`);
      const { klass, shrunk } = pickEnemyClass(SFC_CLASS_BOXES, counts, maxW, maxH);
      if (klass < 0) {
        warn(`${st.key}: no free entry for enemy${letter} (${rec.name || "?"}) \u2014 a stage holds 16 + 16 + 16 + 8 + 4 \u2014 cells left empty`);
        continue;
      }
      const spec = SFC_ENEMY_CLASSES[klass];
      const want = SFC_ENEMY_CLASSES[sfcClassFor(maxW, maxH)];
      const why = `the stage's ${want.w}x${want.h} entries are all taken \u2014 enemy${letter} (${rec.name || "?"})`;
      const digits = [...usage.get(letter).digits.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
      const speed = Number.isFinite(rec.speed) ? Math.max(0.5, rec.speed) : 1;
      const interval = Number(rec.interval);
      const fires = Number.isFinite(interval) && interval > 0;
      const hits = rec.hp === "infinity" ? Infinity : Math.max(1, Number(rec.hp) || 1);
      const fields = {
        family: SFC_MOVE_STRAIGHT,
        variant: nearestIndex5(SFC_STRAIGHT_SPEEDS, speed),
        aim: fires ? SFC_DEFAULT_AIM : 0,
        rate: fires ? nearestIndex5(SFC_SHOT_RATES, clamp5(interval, 0, 31)) : 0,
        shotType: 0,
        hp: hits === Infinity ? SFC_ENEMY_HP.length - 1 : hits <= 1 ? 0 : nearestIndex5(SFC_ENEMY_HP, hits * SFC_HIT_UNITS),
        flags: 0,
        score: nearestIndex5(SFC_ENEMY_SCORE, Number(rec.score) || 100),
        anim: Number.isFinite(rec.frameRate) && rec.frameRate > 0 ? nearestIndex5(SFC_ANIM_INTERVALS, 60 / rec.frameRate) : 3
      };
      let first = null;
      for (const digit of digits) {
        const again = first ? pickEnemyClass(SFC_CLASS_BOXES, counts, spec.w, spec.h) : null;
        const k = !first ? klass : again.klass >= 0 && !again.shrunk ? again.klass : void 0;
        if (k === void 0) {
          warn(`${st.key}: enemy${letter} carries several drop digits and the stage is out of entries \u2014 its drop-${digit} cells ${first.itemDrop ? "drop an item" : "drop nothing"} too`);
          records.set(letter + digit, first);
          continue;
        }
        const kspec = SFC_ENEMY_CLASSES[k];
        const entry = counts[k]++;
        const itemDrop = digit !== "0";
        entryData.set(encodeEnemyEntry2({ ...fields, itemDrop }), kspec.base + entry * ENEMY_ENTRY_BYTES2);
        const chipsPerFrame = kspec.cols * kspec.rows;
        const chipsOf = (list) => {
          const out = [];
          spreadFrames(list, kspec.frames).forEach((f, fi) => {
            const q = indexedByKey.get(f.key);
            if (!q) return;
            const fitted = fitIndexed(q, kspec.w, kspec.h);
            for (let cy = 0; cy < kspec.rows; cy++) {
              for (let cx = 0; cx < kspec.cols; cx++) {
                out.push({ at: kspec.odrBase + entry * chipsPerFrame * kspec.frames + fi * chipsPerFrame + cy * kspec.cols + cx, px: cutChip(fitted, kspec.w, cx, cy) });
              }
            }
          });
          return out;
        };
        const made = { klass: k, entry, itemDrop, name: rec.name || `enemy${letter}`, cell: letter + digit, frames: frames.length };
        const reported = { name: made.name, cell: made.cell, klass: k, entry, size: `${kspec.w}x${kspec.h}`, frames: Math.min(kspec.frames, Math.max(1, frames.length)), itemDrop };
        if (shrunk) shrunkPaints.push({ made, reported, why, all: () => chipsOf(frames), one: () => chipsOf(frames.slice(0, 1)) });
        else paintChips(chipsOf(frames));
        records.set(letter + digit, made);
        if (!first) first = made;
        stageReport.enemies.push(reported);
      }
    }
    for (const { made, reported, why, all, one } of shrunkPaints) {
      const room = ENEMY_GROUP_CHIPS - 1 - sheetSlotOfChip.size;
      const runs = [all(), one()];
      const pick = runs.findIndex((c) => freshChips(c) <= room);
      if (pick >= 0) {
        paintChips(runs[pick]);
        warn(`${st.key}: ${why} drawn ${reported.size}${pick ? `, its first frame only (the enemy sheet is near its ${ENEMY_GROUP_CHIPS - 1} chips)` : ""}`);
        continue;
      }
      for (const [cell, r] of records) if (r === made) records.delete(cell);
      stageReport.enemies.splice(stageReport.enemies.indexOf(reported), 1);
      warn(`${st.key}: ${why} left out: the enemy sheet's ${ENEMY_GROUP_CHIPS - 1} chips cannot hold it even ${reported.size}`);
    }
    const bossWords = new Uint16Array(BOSS_GROUP_CHIPS).fill(CHIP_BLANK_WORD);
    const bossBlock = Uint8Array.from(SFC_FACTORY_BOSS_BLOCK);
    let boss = null;
    if (bossRec) {
      const names = bossRec.anim && Array.isArray(bossRec.anim.idle) ? [...bossRec.anim.idle, ...Array.isArray(bossRec.anim.attack) ? bossRec.anim.attack : []] : Array.isArray(bossRec.texture) ? bossRec.texture : [];
      const frames = names.map(lookup).filter(Boolean);
      if (!frames.length) warn(`${st.key}: boss (${bossRec.name || "?"}) has no art in the atlas \u2014 drawn blank`);
      const tall = frames.length > 0 && sfcBossIsTall(frames[0].w, frames[0].h);
      const cols = tall ? BOSS_SHEET_ROWS : BOSS_SHEET_COLS, rowsOf = tall ? BOSS_SHEET_COLS : BOSS_SHEET_ROWS;
      const boxW = cols * CHIP_DIM, boxH = rowsOf * CHIP_DIM;
      if (frames.length && (frames[0].w > boxW || frames[0].h > boxH)) {
        warn(`${st.key}: boss (${bossRec.name || "?"}) is ${frames[0].w}x${frames[0].h}; a ${tall ? "tall" : "wide"} Super Famicom boss is ${boxW}x${boxH} \u2014 downscaled`);
      }
      if (frames.length) {
        const fitted = fitRgba(frames[0], boxW, boxH);
        const q = quantizeToRow([{ key: "boss", ...fitted }]);
        writeCgramRow(bytes, PALETTE_ROW_STAGE_BOSS + s, q.words);
        rows.push({ row: PALETTE_ROW_STAGE_BOSS + s, owner: `${st.key} boss`, colors: q.colors });
        for (let cy = 0; cy < rowsOf; cy++) {
          for (let cx = 0; cx < cols; cx++) {
            const px = cutChip(q.frames[0].indices, fitted.w, cx, cy);
            if (isTransparent(px)) continue;
            const hit = bankChip(px, `${st.key} boss`);
            if (hit) bossWords[bossSlotForCell(cx, cy, tall)] = chipWordForIndex(hit.chip, hit);
          }
        }
      }
      const hits = bossRec.hp === "infinity" ? Infinity : Math.max(1, Number(bossRec.hp) || 100);
      bossBlock[13] = bossBlock[13] & 248 | (hits === Infinity ? SFC_BOSS_HP.length - 1 : nearestIndex5(SFC_BOSS_HP, hits * SFC_HIT_UNITS));
      if (tall) bossBlock[6] |= 64;
      else bossBlock[6] &= ~64;
      boss = { name: bossRec.name || `boss${s}`, hits, hpIndex: bossBlock[13] & 7, frames: frames.length, tall };
      if (form) boss.form = form;
    }
    writeWords(bytes, REGION2.bossGroup.offset + s * BOSS_GROUP_STAGE_BYTES, bossWords);
    entryData.set(bossBlock, BOSS_BLOCK_OFFSET);
    const appear = new Uint8Array(APPEAR_STAGE_BYTES);
    appear.fill(255, APPEAR_RECORD_END * APPEAR_RECORD_BYTES, (APPEAR_RECORD_END + 1) * APPEAR_RECORD_BYTES);
    const lines = appear.subarray(APPEAR_TABLE_B_OFFSET, APPEAR_TABLE_B_OFFSET + APPEAR_LINES);
    const recordIndex = /* @__PURE__ */ new Map();
    let nextRecord = APPEAR_RECORD_END + 1;
    let recordsFull = false;
    const addRecord = (record) => {
      const key = Array.from(record).join(",");
      if (recordIndex.has(key)) return recordIndex.get(key);
      if (nextRecord >= APPEAR_RECORDS) {
        if (!recordsFull) warn(`${st.key}: more than ${APPEAR_RECORDS - 2} distinct spawn lines; the rest are left out`);
        recordsFull = true;
        return null;
      }
      const index = nextRecord++;
      appear.set(record, index * APPEAR_RECORD_BYTES);
      recordIndex.set(key, index);
      return index;
    };
    let lastLine = -1, placed = 0, dropped = 0;
    spawnRows.forEach((row, k) => {
      const line = clamp5((waveRows ? Math.round(waveRows[k]) : SFC_FIRST_SPAWN_LINE + k * SFC_LINE_STEP) + storyShift, 0, SFC_LAST_SPAWN_LINE);
      const record = new Uint8Array(APPEAR_RECORD_BYTES);
      let any = false;
      row.forEach((cell, c) => {
        if (!cell || cell === "00") return;
        const made = records.get(cell);
        if (!made) return;
        const column = sfcSpawnColumn(c, width);
        const at = column - APPEAR_FIRST_COLUMN;
        if (record[at]) {
          dropped++;
          return;
        }
        record[at] = encodeAppearByte({ klass: made.klass, entry: made.entry });
        any = true;
        placed++;
      });
      if (!any) return;
      if (lines[line]) {
        const prev = appear.subarray(lines[line] * APPEAR_RECORD_BYTES, (lines[line] + 1) * APPEAR_RECORD_BYTES);
        const merged = Uint8Array.from(prev);
        record.forEach((b, i) => {
          if (!b) return;
          if (merged[i]) dropped++;
          else merged[i] = b;
        });
        const idx2 = addRecord(merged);
        if (idx2 !== null) lines[line] = idx2;
        lastLine = Math.max(lastLine, line);
        return;
      }
      const idx = addRecord(record);
      if (idx === null) return;
      lines[line] = idx;
      lastLine = Math.max(lastLine, line);
    });
    if (dropped) warn(`${st.key}: ${dropped} placement${dropped === 1 ? "" : "s"} shared a column with another on the same line and ${dropped === 1 ? "was" : "were"} left out`);
    if (boss) {
      const line = clamp5(
        Math.max(lastLine + SFC_BOSS_LINE_GAP, stageReport.story ? SFC_STORY_MIN_BOSS_LINE : 0),
        SFC_BOSS_LINE_GAP,
        SFC_LAST_SPAWN_LINE
      );
      const record = new Uint8Array(APPEAR_RECORD_BYTES);
      record[Math.floor(APPEAR_COLUMNS / 2)] = encodeAppearByte({ klass: APPEAR_BOSS_CLASS, entry: 0 });
      const idx = addRecord(record);
      if (idx !== null) lines[line] = idx;
      boss.line = line;
      lastLine = Math.max(lastLine, line);
    }
    stageReport.placements = placed;
    stageReport.records = nextRecord - 2;
    stageReport.lines = lastLine + 1;
    stageReport.boss = boss;
    bytes.set(entryData, REGION2.enemyData.offset + s * ENEMY_STAGE_BYTES);
    bytes.set(appear, REGION2.appear.offset + s * APPEAR_STAGE_BYTES);
    bytes.set(odr, REGION2.enemyOdr.offset + s * ENEMY_ODR_STAGE_BYTES);
    writeWords(bytes, REGION2.enemyGroup.offset + s * ENEMY_GROUP_STAGE_BYTES, enemyGroup);
    return stageReport;
  });
  bank.writeTo(bytes);
  sealSfcChecksums(bytes);
  const report = {
    name,
    stages: built,
    chips: { used: bank.used, capacity: USER_CHIP_COUNT, shared: bank.shared, free: USER_CHIP_COUNT - bank.used },
    rows,
    ship: shipSource,
    shipChips,
    title,
    titleParts,
    sound: "factory",
    transform,
    splits
  };
  return { bytes, name, warnings, report };
}
function buildWithStory(level, art2, opts) {
  const dry = buildSfcGameFromLevel(level, art2, { ...opts, storyBackdrops: null, storyPicks: null });
  const notes = [];
  const cols = MAP_COLUMNS - 2 * SFC_STORY_FIRST_COL;
  const candidates = [];
  for (const sb of opts.storyBackdrops) {
    const s = dry.report.stages.findIndex((st) => st.key === `stage${sb && sb.stage}`);
    if (s < 0) continue;
    const key = dry.report.stages[s].key;
    if (dry.report.stages[s].mapChips > 0) {
      notes.push(`${key}: keeps its own scenery \u2014 its story is not drawn`);
      continue;
    }
    const variants = [];
    for (const v of Array.isArray(sb.variants) ? sb.variants : []) {
      if (!v || v.w !== cols * CHIP_DIM || !v.h || v.h % CHIP_DIM || !v.rgba) continue;
      const rows = v.h / CHIP_DIM;
      if (rows > SFC_STORY_TOP_ROW + 1) continue;
      const q = quantizeToRow([{ key: "story", w: v.w, h: v.h, rgba: v.rgba }]);
      const chips = /* @__PURE__ */ new Set();
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const px = cutChip(q.frames[0].indices, v.w, cx, cy);
          if (!isTransparent(px)) chips.add(keyOf2(px));
        }
      }
      if (chips.size > MAP_GROUP_CHIPS - 1) continue;
      variants.push({ label: v.label, rows, q, chips });
    }
    if (variants.length) candidates.push({ s, key, variants });
    else notes.push(`${key}: no size of its story fits a stage map (${cols * CHIP_DIM} px wide, ${SFC_STORY_TOP_ROW + 1} rows, ${MAP_GROUP_CHIPS - 1} distinct chips) \u2014 not drawn`);
  }
  const free = dry.report.chips.free;
  const cost = (picks2) => new Set(picks2.flatMap(({ v }) => [...v.chips])).size;
  const pickAt = (k) => candidates.map((c) => ({ c, v: c.variants[Math.min(k, c.variants.length - 1)] }));
  const sizes = Math.max(0, ...candidates.map((c) => c.variants.length));
  let picks = [];
  for (let k = 0; k < sizes && !picks.length; k++) {
    if (cost(pickAt(k)) <= free) picks = pickAt(k);
  }
  if (!picks.length && candidates.length) {
    for (const p of pickAt(sizes - 1)) {
      if (cost([...picks, p]) <= free) picks.push(p);
      else notes.push(`${p.c.key}: no chips left in the save's two sheets for its story \u2014 not drawn`);
    }
  }
  const built = buildSfcGameFromLevel(level, art2, {
    ...opts,
    storyBackdrops: null,
    storyPicks: new Map(picks.map(({ c, v }) => [c.s, v]))
  });
  built.warnings.push(...notes);
  return built;
}
function fitIndexed(frame, w, h) {
  if (frame.w === w && frame.h === h) return frame.indices;
  const out = new Uint8Array(w * h);
  const scale = Math.min(1, w / frame.w, h / frame.h);
  const fw = Math.max(1, Math.round(frame.w * scale)), fh = Math.max(1, Math.round(frame.h * scale));
  const ox = Math.floor((w - fw) / 2), oy = Math.floor((h - fh) / 2);
  for (let y = 0; y < fh; y++) {
    const sy = scale === 1 ? y : Math.min(frame.h - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < fw; x++) {
      const sx = scale === 1 ? x : Math.min(frame.w - 1, Math.floor((x + 0.5) / scale));
      out[(oy + y) * w + ox + x] = frame.indices[sy * frame.w + sx];
    }
  }
  return out;
}
function exportLevelToSfcSram(level, art2, options = {}) {
  const built = buildSfcGameFromLevel(level, art2, options);
  const parsed = parseSfcSav(built.bytes);
  if (!parsed.isSfcSav) throw new Error("the built image does not read back as a Dezaemon save");
  if (parsed.errors.length) throw new Error(`the built image does not parse: ${parsed.errors.map((e) => `${e.block}: ${e.message}`).join("; ")}`);
  const v = verifySfcChecksums(built.bytes);
  if (!v.ok) throw new Error(`the built image's checksums do not verify: ${v.words.filter((w) => !w.ok).map((w) => w.name).join(", ")}`);
  if (built.bytes.length !== SRAM_SIZE) throw new Error(`the image is ${built.bytes.length} bytes, not ${SRAM_SIZE}`);
  return { sram: built.bytes, fileName: sfcSramFileName(built.name), name: built.name, warnings: built.warnings, report: built.report };
}

// packages/shmup-engine/src/sfc/index.js
function attempt3(result, block, fn) {
  try {
    result[block] = fn();
  } catch (err) {
    result[block] = null;
    result.errors.push({ block, message: err.message });
  }
}
function parseSfcSav(bytes, { rom = null } = {}) {
  const result = (
    /** @type {SfcSave} */
    {
      size: bytes.length,
      sizeOk: ACCEPTED_SIZES.includes(bytes.length),
      complete: bytes.length >= SRAM_SIZE,
      checkString: readCheckString(bytes),
      checkStringOk: hasCheckString(bytes),
      isSfcSav: isSfcSav(bytes),
      segments: splitSegments(bytes),
      confidence: {},
      errors: [],
      checksum: null,
      palettes: null,
      maps: null,
      scroll: null,
      groups: null,
      hiScores: null,
      config: null,
      sound: null,
      enemies: null,
      appear: null,
      graphics: null,
      regions: SFC_REGIONS,
      rom: null,
      /** The dump itself and, when given, the ROM — what drawing a chip needs. */
      bytes,
      romBytes: rom || null
    }
  );
  attempt3(result, "checksum", () => {
    const blocks = readChecksumBlocks(bytes);
    let verified = null;
    try {
      verified = bytes.length >= SRAM_SIZE ? verifySfcChecksums(bytes) : null;
    } catch {
      verified = null;
    }
    return { ...blocks, verified };
  });
  attempt3(result, "palettes", () => decodePaletteData(bytes));
  attempt3(result, "maps", () => decodeMapData(bytes));
  attempt3(result, "scroll", () => decodeScrollEffect(bytes));
  attempt3(result, "groups", () => decodeGroups(bytes));
  attempt3(result, "hiScores", () => decodeHiScores(bytes));
  attempt3(result, "config", () => decodeConfig(bytes));
  attempt3(result, "sound", () => sliceSound(bytes));
  attempt3(result, "enemies", () => decodeEnemyData(bytes));
  attempt3(result, "appear", () => decodeAppearData(bytes));
  attempt3(result, "graphics", () => decodeGraphics(bytes));
  result.confidence = {
    checksum: REGION2.checksum.confidence,
    palettes: REGION2.palette.confidence,
    maps: REGION2.map.confidence,
    scroll: REGION2.scroll.confidence,
    groups: REGION2.mapGroup.confidence,
    hiScores: REGION2.hiScore.confidence,
    config: REGION2.titleType.confidence,
    sound: REGION2.sound.confidence,
    enemies: REGION2.enemyData.confidence,
    appear: REGION2.appear.confidence,
    graphics: REGION2.graphics.confidence
  };
  if (rom) {
    attempt3(result, "rom", () => {
      const header = readRomHeader(rom);
      const table = parseRomRegionTable(rom);
      return {
        header,
        isDezaemon: isDezaemonRom(rom),
        regionTable: table,
        regionTableMatches: regionTableMatches(table),
        defaultImage: compareWithRomDefault(bytes, rom)
      };
    });
  }
  return result;
}
function summarizeSfcSav(parsed) {
  const lines = [];
  lines.push(`size ${parsed.size} (${parsed.sizeOk ? "ok" : "unexpected"}), check string ${JSON.stringify(parsed.checkString)}${parsed.checkStringOk ? "" : ` (expected ${CHECK_STRING})`}`);
  lines.push(`segments: ${parsed.segments.map((s) => `$${s.bank.toString(16)} ${!s.present ? "absent" : s.blank ? "blank" : "data"}`).join(", ")}`);
  if (parsed.checksum) {
    const v = parsed.checksum.verified;
    lines.push(`checksum copy ${parsed.checksum.equal ? "matches" : "DIFFERS"}${v ? `; ${v.ok ? "all 17 words verify" : `${v.words.filter((w) => !w.ok).length} of 17 words FAIL (${v.words.filter((w) => !w.ok).map((w) => w.name).join(", ")})`}` : ""}`);
  }
  if (parsed.palettes) lines.push(`palettes: ${parsed.palettes.colorRowCount}/${parsed.palettes.rows.length} rows are colour words`);
  if (parsed.maps) lines.push(`maps: ${parsed.maps.map((m) => m.used).join("/")} cells used per stage`);
  if (parsed.groups) {
    const chips = (list) => list.filter((c) => !c.empty).length;
    const romArt = parsed.groups.map.some((g) => g.chips.some((c) => c.rom)) || parsed.groups.myShip.some((c) => c.rom);
    lines.push(`chips: map ${parsed.groups.map.map((g) => chips(g.chips)).join("/")}, enemies ${parsed.groups.enemy.map((g) => chips(g.chips)).join("/")}, bosses ${parsed.groups.boss.map((g) => chips(g.chips)).join("/")}, ship ${chips(parsed.groups.myShip)}, title ${chips(parsed.groups.title)}; art ${romArt ? "partly from the ROM's sheets" : "from the save's sheets"}`);
  }
  if (parsed.hiScores) lines.push(`hi-scores: ${parsed.hiScores.slice(0, 3).map((h) => `${h.score} ${h.name.trim() || "-"}`).join(", ")} \u2026`);
  if (parsed.enemies) lines.push(`enemies: ${parsed.enemies.map((e) => e.used).join("/")} entries per stage${parsed.appear ? `; spawn lines ${parsed.appear.map((a) => a.used).join("/")}` : ""}`);
  if (parsed.graphics) lines.push(`graphics: ${!parsed.graphics.present ? "absent (64 KB dump)" : parsed.graphics.blank ? "blank" : `${parsed.graphics.usedCount} tiles in use`}`);
  if (parsed.rom) {
    const r = parsed.rom;
    lines.push(`rom: ${r.header.title} sram ${r.header.sramSizeBytes} B, region table ${r.regionTableMatches.matches ? "matches" : "DIFFERS"}, default image ${r.defaultImage.identical ? "identical" : `${r.defaultImage.equal}/${r.defaultImage.total} bytes equal`}`);
  }
  for (const e of parsed.errors) lines.push(`error in ${e.block}: ${e.message}`);
  return lines.join("\n");
}

// packages/shmup-engine/src/legacy-names.js
var FRAME_RENAMES = [
  // `<x>Tama<A-C?><n>` -> `<x>Projectile<A-C?><n>`: normalTama0, vegaTama2.
  [/Tama(?=[A-Z]?\d+[.․](?:gif|png)$)/, "Projectile"],
  // `<boss>_tama<A-C?><n>` -> `<boss>_projectile<A-C?><n>`: sagat_tamaA0.
  [/_tama(?=[A-Z]?\d+[.․](?:gif|png)$)/, "_projectile"],
  // The CA BOMB's blast is the SP blast now.
  [/^caExplosion(?=\d+[.․](?:gif|png)$)/, "spExplosion"]
];
var FIELD_RENAMES = { cagage: "spgage", caDamage: "spDamage" };
var TEXTURE_KEYS = /* @__PURE__ */ new Set(["texture", "attackTexture", "itemTexture"]);
function legacyFrameName(name) {
  if (typeof name !== "string") return name;
  let out = name;
  for (const [pattern, to] of FRAME_RENAMES) out = out.replace(pattern, to);
  return out;
}
function normalizeRecord(record, path, report, seen) {
  if (!record || typeof record !== "object" || seen.has(record)) return;
  seen.add(record);
  if (Array.isArray(record)) {
    for (let i = 0; i < record.length; i++) {
      normalizeRecord(record[i], `${path}[${i}]`, report, seen);
    }
    return;
  }
  for (const [from, to] of Object.entries(FIELD_RENAMES)) {
    if (!(from in record)) continue;
    if (!(to in record)) record[to] = record[from];
    delete record[from];
    report.fields.push({ path: `${path}.${from}`, to });
  }
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (TEXTURE_KEYS.has(key) && Array.isArray(value)) {
      renameFrames(value, `${path}.${key}`, report);
    } else if (key === "anim" && value && typeof value === "object") {
      for (const [animName, frames] of Object.entries(value)) {
        if (Array.isArray(frames)) {
          renameFrames(frames, `${path}.anim.${animName}`, report);
        }
      }
    } else if (value && typeof value === "object") {
      normalizeRecord(value, `${path}.${key}`, report, seen);
    }
  }
}
function renameFrames(list, path, report) {
  for (let i = 0; i < list.length; i++) {
    const to = legacyFrameName(list[i]);
    if (to === list[i]) continue;
    report.frames.push({ path: `${path}[${i}]`, from: list[i], to });
    list[i] = to;
  }
}
function normalizeLegacyGame(game) {
  const report = { frames: [], fields: [] };
  if (!game || typeof game !== "object") return report;
  const seen = /* @__PURE__ */ new Set();
  for (const key of ["enemyData", "bossData", "playerData", "playerData2"]) {
    if (game[key] && typeof game[key] === "object") {
      normalizeRecord(game[key], key, report, seen);
    }
  }
  return report;
}
function normalizeLegacyAtlasFrames(frames) {
  if (!frames || typeof frames !== "object") return frames;
  const out = {};
  for (const [key, value] of Object.entries(frames)) {
    const renamed = legacyFrameName(key);
    if (renamed !== key && (renamed in frames || renamed in out)) {
      out[key] = value;
      continue;
    }
    out[renamed] = value;
  }
  return (
    /** @type {T} */
    out
  );
}
export {
  ALPHA_CUTOFF,
  ATTRIBUTION_ROLES,
  BLANK_WAVES,
  BUILTIN_DEFAULTS,
  BUP_LANGUAGE,
  CART_PARTITION_SIZE,
  CG_CELL,
  CG_CELL_BYTES,
  CG_CELL_CAPACITY,
  COLOR_SETS,
  CONTROL_DEFAULT,
  COVER_H,
  COVER_W,
  CREDIT_LINE_CHARS,
  CREDIT_STRIP_CHARS,
  CgFullError,
  CgPacker,
  DDD_IMAGE_BYTES,
  DEFAULT_ATTRIBUTION_ROLE,
  DEFAULT_BOSS_PATTERNS,
  DEFAULT_ITEM_LETTERS,
  DEFAULT_ITEM_TYPES,
  DEFAULT_TABLE_ADDR,
  DEZA2_CG_COLORS,
  DEZA2_PALETTE_COLS,
  DEZA2_PALETTE_PNG,
  DEZA2_PALETTE_ROWS,
  DEZA2_PALETTE_SIZE,
  DEZA2_PALETTE_WORDS,
  DEZA2_SYSTEM_ROWS,
  DEZA2_UI_ROWS,
  DEZA2_USER_ROWS,
  DEZA2_ZAKO_SIZES,
  DROP_TO_SLOT,
  DUKE_PLAYER,
  EMBLEM_LETTER_BY_TYPE,
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
  INTERNAL_PARTITION_SIZE,
  INTERNAL_RAM_PAYLOAD_CAPACITY,
  INTERNAL_SRM_SIZE,
  KIDS_BACKGROUND_SETS,
  KIDS_STOCK_ITEM_FRAMES,
  KIDS_STORY_ROWS,
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
  MAX_PARTS,
  MAX_STAGES2 as MAX_STAGES,
  MAX_SWATCH_COLORS,
  MDLDT_BASE,
  MDLDT_FILE_COUNT,
  MIN_GAME_PAYLOAD_BYTES,
  MISTER_LOGICAL_SIZE,
  MISTER_SAV_SIZE,
  MODEL_SLOTS,
  MODEL_SLOT_SIZE,
  MODEL_UNIT_RADIUS,
  NAMES_PER_ROLE,
  NDD_IMAGE_BYTES,
  NEAR,
  NEUTRAL_COLOR,
  PALETTE_TARGETS,
  PLAYER_SHOT_DAMAGE_BY_LEVEL,
  PartitionFullError,
  REF_HFLIP,
  REF_VFLIP,
  ROTATION_ORDER,
  ROTATION_QUANTUM,
  ROT_ORDERS,
  ROW_STEP,
  SCSP_BASE_RATE,
  SEC7_MAGIC,
  SEC7_SIZE,
  SECTION_COUNT,
  SECTION_HINTS,
  SECTION_SIZES,
  ACCEPTED_SIZES as SFC_ACCEPTED_SIZES,
  CHECK_STRING as SFC_CHECK_STRING,
  SFC_COVER_H,
  SFC_COVER_W,
  SRAM_SIZE as SFC_SRAM_SIZE,
  SHADE_FLOOR,
  SHADE_LEVELS,
  SHADE_ZERO,
  SHAPE_FAMILIES,
  SINGLE_LETTER_ENEMIES,
  SONG_STEPS,
  STAFF_ROLE_LABELS,
  STRAIGHT_APPEARANCE_BASE,
  SWATCH_LAYOUT,
  TABLE_SIZE,
  TROOPER_PLAYER,
  USER_ROW_FIRST,
  allocFrame,
  applyVcdiff,
  authorFromEnvironment,
  bandFor,
  bankToPalettes,
  bankToSec4,
  bitmapFontFromSheet,
  blastFrames,
  bossClassFor,
  bpmOfTempoIndex,
  buildBlankGame,
  buildBupImage,
  buildDezaemonBgm,
  buildGameSave,
  buildKidsGameFromLevel,
  buildMemoryCard,
  buildMeshLibrary,
  buildModelMesh,
  buildN64ProjectFromLevel,
  buildPayload,
  buildPlusGameFromLevel,
  buildSaveFromGame,
  buildSfcGameFromLevel,
  buildSwatchTable,
  bupDateFromDate,
  bupDateToDate,
  byteSum,
  cellsToEvents,
  cellsToIndexed,
  coalesceDiffRanges,
  colorHistogram,
  composeCover,
  composeSfcCover,
  composeTransform,
  compress,
  compressCmp,
  creditStripRgba,
  cutLayer,
  dataBlocksFor,
  dddFileName,
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
  deza2PaletteBand,
  deza2PaletteRaster,
  deza2PaletteRgb,
  emptyBank,
  emptySong,
  emptySongBank,
  emptyWave,
  encodeBossTrailer,
  encodeComment,
  encodeDezaSong,
  encodeEnemyRecord,
  encodeModels,
  encodeRotation,
  encodeSettings,
  encodeShapeWord,
  enemyLetters,
  enemyRecordFromEditor,
  exportLevelToDdd,
  exportLevelToKidsCard,
  exportLevelToPlusCard,
  exportLevelToSav,
  exportLevelToSfcSram,
  extractPayload,
  familyForFile,
  familyOfLibraryIndex,
  findEntries,
  findEntry,
  fitRgba,
  foldCreditText,
  foldMidiToPitch,
  formatMemoryCard,
  formatPartition,
  frameGroup,
  gamePayloadFromSav,
  gameSaveFilename,
  gunzip,
  indexedToCells,
  indexedToRgbaWith,
  inkStats,
  instrumentAt,
  interleave,
  internalRamFromImage,
  isDddImage,
  isGameSave,
  isGzip,
  isN64ItemFrame,
  isSfcSav,
  itemIcon,
  kidsCardFileName,
  layerAt,
  legacyFrameName,
  levelGain,
  levelStages,
  libraryIndex,
  listFiles,
  makeMesh,
  mapColumn,
  mapSaveToGame,
  mdldtFileFor,
  mdldtFileName,
  medianCut,
  meshBounds,
  meshFor,
  meshLibraryFromJson,
  midiToPitch,
  modelStats,
  imageFormat as n64ImageFormat,
  normalizeProjectName as n64ProjectName,
  readProjects as n64ReadProjects,
  templateFromDisk as n64TemplateFromDisk,
  nearestPaletteIndex,
  normalMatrix,
  normalize,
  normalizeAttribution,
  normalizeLegacyAtlasFrames,
  normalizeLegacyGame,
  openDisc,
  orbitCamera,
  packMesh2D,
  packShelf,
  paletteBankWords,
  paletteWordsFromRgba,
  panPosition,
  parse,
  parseEntry,
  parsePsxSav,
  parseSectionTable,
  parseSfcSav,
  parseVcdiff,
  payloadCapacity,
  pickLayers,
  pickSfcCoverWindow,
  pitchToMidi,
  placeSaveInPartition,
  placeholderLibrary,
  placeholderMesh,
  playbackRate,
  plusCardFileName,
  polygonNormals,
  projectModel,
  quantizeFrames,
  quantizeRotation,
  readExtent,
  readFile,
  renderTitlePage,
  resolveAttribution,
  rgb555ToHex,
  rgb555ToRgb,
  rgb8ToRgb555,
  saturnLightView,
  savComment,
  savFileName,
  serializeMeshLibrary,
  sfcSramFileName,
  shadeRgb555,
  shadeRow,
  snesCgramBytes,
  spreadFrames,
  stageSaveInInternalRam,
  stepSecondsOf,
  storyBackdrops,
  storyLogLine,
  summarizeSfcSav,
  swatchCell,
  swatchCellRect,
  swatchRgb,
  swatchUV,
  tempoIndexForBpm,
  tempoIndexForStepSeconds,
  tintRgb555,
  toFloat32,
  totalDiffBytes,
  transformPoint,
  uniqueSlices,
  validateGameJson,
  validateSectionTable,
  wireframeSegments,
  writeSaveEntry
};
