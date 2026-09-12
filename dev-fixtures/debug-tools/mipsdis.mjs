// Minimal MIPS I (R3000) disassembler for tracing the PlayStation Dezaemons
// (Dezaemon+ SLPS-00335 / Select 100 SLPS-01504, Dezaemon Kids! SLPS-01503)
// — the counterpart of sh2dis.mjs for the Saturn. Fixed 32-bit little-endian
// opcodes. What makes table tracing practical here is address synthesis: MIPS
// builds a 32-bit address as `lui rX,hi` followed by `addiu/ori rX,rX,lo` or
// a load/store `lw rY,lo(rX)`, so the tool tracks lui values per register and
// prints the resolved absolute address inline (`lw v0,0x1234(v1)  ; @0x80101234`),
// which is what --xref searches.
//
//   node dev-fixtures/debug-tools/mipsdis.mjs <start> <end>
//       disassemble a RAM address range
//   node dev-fixtures/debug-tools/mipsdis.mjs --xref <ramaddr> [len]
//       every instruction that synthesises an address in [addr, addr+len)
//       (len defaults to 1): readers, writers, and address-taking addiu/ori
//   node dev-fixtures/debug-tools/mipsdis.mjs --calls <ramaddr>
//       every j/jal whose target is addr
//   node dev-fixtures/debug-tools/mipsdis.mjs --funcs
//       function prologues (addiu sp,sp,-N), with the ra-saving ones marked
//   node dev-fixtures/debug-tools/mipsdis.mjs --strings [minlen]
//       printable ASCII runs with their RAM addresses
//   node dev-fixtures/debug-tools/mipsdis.mjs --find <hexbytes>
//       byte-pattern search, e.g. --find ee0f0000 (bytes as stored)
//   node dev-fixtures/debug-tools/mipsdis.mjs --words <ramaddr> [count]
//       dump u32 words at an address (little-endian)
//   node dev-fixtures/debug-tools/mipsdis.mjs --imm <value>
//       every instruction whose 16-bit immediate equals value (constants
//       such as 0xfee, 0x1e000, 0xfcc8 are how you find a routine)
//
// Addresses accept 0x hex. MIPSDIS_BIN names the binary (default ./MAIN.EXE
// in the current directory); a file that starts with "PS-X EXE" is opened as
// an executable — text loaded at the header's t_addr (0x18), initial pc and
// gp printed — anything else is raw with MIPSDIS_BASE as its load address
// (default 0x80010000). KSEG0/KSEG1/KUSEG aliases of one address are treated
// as the same address. Data regions disassemble as nonsense; a run of `.word`
// after `jr ra; nop` is a table, not code. Each function's lui tracking
// restarts at its prologue, so an address built across a call boundary or a
// branch is missed — grep the raw `lui` when --xref comes up empty.
import fs from "node:fs";

const path = process.env.MIPSDIS_BIN || "./MAIN.EXE";
const raw = fs.readFileSync(path);
let bin = raw;
let BASE = Number(process.env.MIPSDIS_BASE || 0x80010000);
let PC0 = null;
let GP0 = null;
if (raw.length > 0x800 && raw.toString("latin1", 0, 8) === "PS-X EXE") {
  PC0 = raw.readUInt32LE(0x10);
  GP0 = raw.readUInt32LE(0x14);
  BASE = raw.readUInt32LE(0x18);
  const size = raw.readUInt32LE(0x1c);
  bin = raw.subarray(0x800, 0x800 + size);
}
const END = BASE + bin.length;
const norm = (a) => (a >>> 0) & 0x1fffffff; // fold KSEG0/KSEG1/KUSEG
const BASEN = norm(BASE);
const inRange = (ram) =>
  norm(ram) >= BASEN && norm(ram) + 3 < BASEN + bin.length;
const u32 = (ram) => bin.readUInt32LE(norm(ram) - BASEN);
const hex = (v) => "0x" + (v >>> 0).toString(16);
const sext16 = (v) => (v & 0x8000 ? v - 0x10000 : v);

const REG = [
  "zero",
  "at",
  "v0",
  "v1",
  "a0",
  "a1",
  "a2",
  "a3",
  "t0",
  "t1",
  "t2",
  "t3",
  "t4",
  "t5",
  "t6",
  "t7",
  "s0",
  "s1",
  "s2",
  "s3",
  "s4",
  "s5",
  "s6",
  "s7",
  "t8",
  "t9",
  "k0",
  "k1",
  "gp",
  "sp",
  "fp",
  "ra",
];
const SPECIAL = {
  0: "sll",
  2: "srl",
  3: "sra",
  4: "sllv",
  6: "srlv",
  7: "srav",
  8: "jr",
  9: "jalr",
  12: "syscall",
  13: "break",
  16: "mfhi",
  17: "mthi",
  18: "mflo",
  19: "mtlo",
  24: "mult",
  25: "multu",
  26: "div",
  27: "divu",
  32: "add",
  33: "addu",
  34: "sub",
  35: "subu",
  36: "and",
  37: "or",
  38: "xor",
  39: "nor",
  42: "slt",
  43: "sltu",
};
const IMM = {
  4: "beq",
  5: "bne",
  6: "blez",
  7: "bgtz",
  8: "addi",
  9: "addiu",
  10: "slti",
  11: "sltiu",
  12: "andi",
  13: "ori",
  14: "xori",
  15: "lui",
  32: "lb",
  33: "lh",
  34: "lwl",
  35: "lw",
  36: "lbu",
  37: "lhu",
  38: "lwr",
  40: "sb",
  41: "sh",
  42: "swl",
  43: "sw",
  46: "swr",
  50: "lwc2",
  58: "swc2",
};
const LOADS = new Set([32, 33, 34, 35, 36, 37, 38, 50]);
const STORES = new Set([40, 41, 42, 43, 46, 58]);

/**
 * Decode one instruction. `regs` is the lui-tracking state (a 32-entry array
 * of known 32-bit values or null); the decoder updates it as a side effect
 * and returns {text, addr, kind, target}: addr is a synthesised absolute
 * address (or null), kind is "load", "store", "addr", "call" or "jump", and
 * target a branch/jump destination.
 */
export function dis1(pc, regs) {
  const op = u32(pc);
  const opc = op >>> 26;
  const rs = (op >>> 21) & 31, rt = (op >>> 16) & 31, rd = (op >>> 11) & 31;
  const sa = (op >>> 6) & 31, fn = op & 63;
  const imm = op & 0xffff, simm = sext16(imm);
  const R = (r) => REG[r];
  const out = { text: null, addr: null, kind: null, target: null };
  const kill = (r) => {
    if (r !== 0) regs[r] = null;
  };
  if (opc === 0) {
    const name = SPECIAL[fn];
    if (name === undefined) return { ...out, text: `.word ${hex(op)}` };
    switch (fn) {
      case 0:
        out.text = op === 0 ? "nop" : `sll ${R(rd)},${R(rt)},${sa}`;
        kill(rd);
        break;
      case 2:
      case 3:
        out.text = `${name} ${R(rd)},${R(rt)},${sa}`;
        kill(rd);
        break;
      case 4:
      case 6:
      case 7:
        out.text = `${name} ${R(rd)},${R(rt)},${R(rs)}`;
        kill(rd);
        break;
      case 8:
        out.text = `jr ${R(rs)}`;
        break;
      case 9:
        out.text = rd === 31 ? `jalr ${R(rs)}` : `jalr ${R(rd)},${R(rs)}`;
        kill(rd);
        out.kind = "call";
        break;
      case 12:
        out.text = `syscall ${hex((op >>> 6) & 0xfffff)}`;
        break;
      case 13:
        out.text = `break ${hex((op >>> 6) & 0xfffff)}`;
        break;
      case 16:
      case 18:
        out.text = `${name} ${R(rd)}`;
        kill(rd);
        break;
      case 17:
      case 19:
        out.text = `${name} ${R(rs)}`;
        break;
      case 24:
      case 25:
      case 26:
      case 27:
        out.text = `${name} ${R(rs)},${R(rt)}`;
        break;
      default:
        out.text = `${name} ${R(rd)},${R(rs)},${R(rt)}`;
        kill(rd);
        break;
    }
    return out;
  }
  if (opc === 1) {
    const names = { 0: "bltz", 1: "bgez", 16: "bltzal", 17: "bgezal" };
    const name = names[rt];
    if (!name) return { ...out, text: `.word ${hex(op)}` };
    out.target = (pc + 4 + simm * 4) >>> 0;
    out.text = `${name} ${R(rs)},${hex(out.target)}`;
    if (rt >= 16) kill(31);
    return out;
  }
  if (opc === 2 || opc === 3) {
    out.target = (((pc + 4) & 0xf0000000) | ((op & 0x3ffffff) << 2)) >>> 0;
    out.text = `${opc === 2 ? "j" : "jal"} ${hex(out.target)}`;
    out.kind = opc === 3 ? "call" : "jump";
    if (opc === 3) kill(31);
    return out;
  }
  if (opc === 16 || opc === 18) {
    const cop = opc === 16 ? "cop0" : "cop2";
    if (opc === 16 && (op & 0x3f) === 16 && rs === 16) {
      return { ...out, text: "rfe" };
    }
    if (rs >= 16) return { ...out, text: `${cop} ${hex(op & 0x1ffffff)}` };
    const kinds = { 0: "mfc", 2: "cfc", 4: "mtc", 6: "ctc" };
    const k = kinds[rs];
    if (!k) return { ...out, text: `.word ${hex(op)}` };
    if (rs === 0 || rs === 2) kill(rt);
    return { ...out, text: `${k}${opc === 16 ? 0 : 2} ${R(rt)},$${rd}` };
  }
  const name = IMM[opc];
  if (!name) return { ...out, text: `.word ${hex(op)}` };
  switch (opc) {
    case 4:
    case 5:
      out.target = (pc + 4 + simm * 4) >>> 0;
      out.text = `${name} ${R(rs)},${R(rt)},${hex(out.target)}`;
      return out;
    case 6:
    case 7:
      out.target = (pc + 4 + simm * 4) >>> 0;
      out.text = `${name} ${R(rs)},${hex(out.target)}`;
      return out;
    case 15:
      out.text = `lui ${R(rt)},${hex(imm)}`;
      if (rt !== 0) regs[rt] = (imm << 16) >>> 0;
      return out;
    case 8:
    case 9: {
      const base = regs[rs];
      out.text = `${name} ${R(rt)},${R(rs)},${simm}`;
      if (base !== null && base !== undefined) {
        out.addr = (base + simm) >>> 0;
        out.kind = "addr";
        if (rt !== 0) regs[rt] = out.addr;
      } else kill(rt);
      return out;
    }
    case 13: {
      const base = regs[rs];
      out.text = `ori ${R(rt)},${R(rs)},${hex(imm)}`;
      if (base !== null && base !== undefined) {
        out.addr = (base | imm) >>> 0;
        out.kind = "addr";
        if (rt !== 0) regs[rt] = out.addr;
      } else kill(rt);
      return out;
    }
    case 10:
    case 11:
    case 12:
    case 14:
      out.text = `${name} ${R(rt)},${R(rs)},${
        opc === 12 || opc === 14 ? hex(imm) : simm
      }`;
      kill(rt);
      return out;
  }
  // loads and stores
  const base = regs[rs];
  out.text = `${name} ${R(rt)},${simm}(${R(rs)})`;
  if (base !== null && base !== undefined) {
    out.addr = (base + simm) >>> 0;
    out.kind = LOADS.has(opc) ? "load" : STORES.has(opc) ? "store" : null;
  }
  if (LOADS.has(opc) && opc !== 50) kill(rt);
  return out;
}

function freshRegs() {
  const regs = new Array(32).fill(null);
  if (GP0) regs[28] = GP0 >>> 0;
  return regs;
}

function resetRegs(regs) {
  regs.fill(null);
  if (GP0) regs[28] = GP0 >>> 0;
}

function isPrologue(op) {
  // addiu sp,sp,-N
  return (op >>> 16) === 0x27bd && (op & 0x8000) !== 0;
}

function line(pc, regs) {
  const op = u32(pc);
  const d = dis1(pc, regs);
  let note = "";
  if (d.addr !== null) {
    note = `  ; ${d.kind === "addr" ? "=" : "@"}${hex(d.addr)}`;
  }
  return `${hex(pc)}: ${op.toString(16).padStart(8, "0")}  ${d.text}${note}`;
}

function findFunction(pc) {
  // nearest preceding prologue, searching back up to 64 KB
  for (let p = pc; p >= BASE && pc - p < 0x10000; p -= 4) {
    if (isPrologue(u32(p))) return p;
  }
  return null;
}

const args = process.argv.slice(2);
const num = (s) => Number(s);
if (PC0 !== null && !args.includes("--quiet")) {
  console.error(
    `# ${path}: PS-X EXE text ${hex(BASE)}..${
      hex(END)
    } (${bin.length} bytes), pc0 ${hex(PC0)}, gp ${hex(GP0)}`,
  );
}

if (args[0] === "--xref") {
  const target = norm(num(args[1]));
  const len = args[2] ? num(args[2]) : 1;
  const regs = freshRegs();
  for (let pc = BASE; pc + 3 < END; pc += 4) {
    if (isPrologue(u32(pc))) resetRegs(regs);
    const before = regs.slice();
    const d = dis1(pc, regs);
    if (d.addr !== null) {
      const a = norm(d.addr);
      if (a >= target && a < target + len) {
        const fn = findFunction(pc);
        console.log(
          `${line(pc, before)}${fn !== null ? `  [fn ${hex(fn)}]` : ""}`,
        );
      }
    }
  }
} else if (args[0] === "--calls") {
  const target = norm(num(args[1]));
  for (let pc = BASE; pc + 3 < END; pc += 4) {
    const op = u32(pc);
    const opc = op >>> 26;
    if (opc === 2 || opc === 3) {
      const t = (((pc + 4) & 0xf0000000) | ((op & 0x3ffffff) << 2)) >>> 0;
      if (norm(t) === target) {
        const fn = findFunction(pc);
        console.log(
          `${hex(pc)}: ${opc === 3 ? "jal" : "j"} ${hex(t)}${
            fn !== null ? `  [fn ${hex(fn)}]` : ""
          }`,
        );
      }
    }
  }
} else if (args[0] === "--imm") {
  const want = num(args[1]) & 0xffff;
  const regs = freshRegs();
  for (let pc = BASE; pc + 3 < END; pc += 4) {
    if (isPrologue(u32(pc))) resetRegs(regs);
    const op = u32(pc);
    const opc = op >>> 26;
    const before = regs.slice();
    dis1(pc, regs);
    if (opc >= 4 && opc !== 16 && opc !== 18 && (op & 0xffff) === want) {
      const fn = findFunction(pc);
      console.log(
        `${line(pc, before)}${fn !== null ? `  [fn ${hex(fn)}]` : ""}`,
      );
    }
  }
} else if (args[0] === "--funcs") {
  for (let pc = BASE; pc + 3 < END; pc += 4) {
    const op = u32(pc);
    if (!isPrologue(op)) continue;
    const frame = 0x10000 - (op & 0xffff);
    let savesRa = false;
    for (let p = pc + 4; p < pc + 64 && p + 3 < END; p += 4) {
      const o = u32(p);
      if ((o >>> 16) === 0xafbf) {
        savesRa = true;
        break;
      } // sw ra,N(sp)
      if (isPrologue(o)) break;
    }
    console.log(`${hex(pc)}  frame ${frame}${savesRa ? "  (calls out)" : ""}`);
  }
} else if (args[0] === "--strings") {
  const min = args[1] ? num(args[1]) : 5;
  let start = -1;
  for (let i = 0; i <= bin.length; i++) {
    const b = i < bin.length ? bin[i] : 0;
    const printable = b >= 0x20 && b < 0x7f;
    if (printable && start < 0) start = i;
    if (!printable && start >= 0) {
      if (i - start >= min) {
        console.log(
          `${hex(BASE + start)}  ${
            JSON.stringify(bin.toString("latin1", start, i))
          }`,
        );
      }
      start = -1;
    }
  }
} else if (args[0] === "--find") {
  const pat = Buffer.from(args[1].replace(/^0x/, ""), "hex");
  let at = bin.indexOf(pat);
  while (at >= 0) {
    console.log(hex(BASE + at));
    at = bin.indexOf(pat, at + 1);
  }
} else if (args[0] === "--words") {
  const at = num(args[1]);
  const count = args[2] ? num(args[2]) : 16;
  for (let i = 0; i < count; i++) {
    const a = at + i * 4;
    if (!inRange(a)) break;
    console.log(`${hex(a)}: ${hex(u32(a))}`);
  }
} else if (args.length >= 2 && !args[0].startsWith("--")) {
  const start = num(args[0]);
  const end = num(args[1]);
  const regs = freshRegs();
  for (let pc = start; pc < end && inRange(pc); pc += 4) {
    if (isPrologue(u32(pc))) {
      resetRegs(regs);
      console.log(`; ---- function ${hex(pc)}`);
    }
    console.log(line(pc, regs));
  }
} else {
  console.error(
    "usage: mipsdis.mjs <start> <end> | --xref <addr> [len] | --calls <addr> | --imm <value> | --funcs | --strings [min] | --find <hex> | --words <addr> [n]",
  );
  process.exit(2);
}
