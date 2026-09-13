// Minimal 65C816 disassembler for tracing the Super Famicom Dezaemon ROM
// (SHVC-66, 512 KB LoROM — dev-fixtures/, gitignored). The SNES counterpart
// of sh2dis.mjs (Saturn, SH-2) and mipsdis.mjs (PlayStation, MIPS), and the
// first tool in this repo that reads 65C816.
//
// Two things make this worth a file rather than a one-off scan. The 65C816 has
// variable-length instructions whose IMMEDIATE width depends on processor
// state — REP/SEP flip the M and X flags, so `LDA #$12` and `LDA #$1234` are
// the same opcode — which means you cannot decode a stream without tracking
// those flags; this follows them, and prints the width it assumed. And SRAM is
// reached by long addressing, so `--xref $70:0000` finds every reader and
// writer of a save region across the whole ROM, which is how the CHECK SUM
// sites were found.
//
//   node dev-fixtures/debug-tools/w65c816dis.mjs <start> [count]
//       disassemble from a ROM offset (0x...) or a CPU address (bank:addr)
//   node dev-fixtures/debug-tools/w65c816dis.mjs --xref <bank:addr>
//       every long-addressed access (LDA/STA/ADC/EOR/... long) to that address
//   node dev-fixtures/debug-tools/w65c816dis.mjs --calls <bank:addr>
//       every JSR/JSL whose target is that address
//
// Addresses accept 0x hex for ROM offsets and bb:aaaa for CPU addresses.
// W65_BIN overrides the ROM path. --mx=MX seeds the M/X flags (default 11,
// both 8-bit, which is the state after reset); the disassembler updates them
// itself on REP/SEP, so seeding only matters when you start mid-routine.
//
// LoROM: ROM offset o lives at bank o>>15, address 0x8000|(o&0x7FFF); banks
// $80-$FF mirror $00-$7F. Data regions disassemble as garbage — a run of
// nonsense after an RTS/RTL is a table, not code.
import fs from "node:fs";

const ROM = fs.readFileSync(
  process.env.W65_BIN || "./dev-fixtures/Deza.sfc",
);
// A 512-byte copier header shifts every offset; drop it so offsets are pure.
const COPIER = ROM.length % 0x8000 === 512 ? 512 : 0;
const rom = COPIER ? ROM.subarray(COPIER) : ROM;

const hex = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, "0");
/** ROM offset -> {bank, addr} under LoROM. */
const toCpu = (o) => ({ bank: o >>> 15, addr: 0x8000 | (o & 0x7fff) });
/** CPU bank:addr -> ROM offset, or -1 when it is not ROM. */
const toRom = (bank, addr) =>
  addr < 0x8000 ? -1 : ((bank & 0x7f) * 0x8000 + (addr - 0x8000));
const cpuStr = (o) => {
  const { bank, addr } = toCpu(o);
  return `$${hex(bank)}:${hex(addr, 4)}`;
};

// --- the opcode table ------------------------------------------------------
//
// Each entry is [mnemonic, mode]. Operand length comes from the mode, except
// imm_m / imm_x which are 1 or 2 bytes as the M / X flag says.
const IMP = "imp", ACC = "acc", IMM_M = "imm_m", IMM_X = "imm_x", IMM8 = "imm8";
const DP = "dp", DPX = "dpx", DPY = "dpy", IDP = "idp", IDX = "idx";
const IDY = "idy", IDL = "idl", IDLY = "idly", ABS = "abs", ABX = "abx";
const ABY = "aby", ABL = "abl", ABLX = "ablx", IND = "ind", IAX = "iax";
const IAL = "ial", REL = "rel", RELL = "rell", SR = "sr", SRY = "sry";
const BM = "bm";

const LEN = {
  [IMP]: 1, [ACC]: 1, [IMM8]: 2, [DP]: 2, [DPX]: 2, [DPY]: 2, [IDP]: 2,
  [IDX]: 2, [IDY]: 2, [IDL]: 2, [IDLY]: 2, [ABS]: 3, [ABX]: 3, [ABY]: 3,
  [ABL]: 4, [ABLX]: 4, [IND]: 3, [IAX]: 3, [IAL]: 3, [REL]: 2, [RELL]: 3,
  [SR]: 2, [SRY]: 2, [BM]: 3,
};

const OP = new Array(256).fill(["???", IMP]);
const set = (map) => {
  for (const [k, v] of Object.entries(map)) OP[Number(k)] = v;
};
// Built column by column: the 65C816 map is regular enough that the
// low-nibble groups repeat across the ALU ops.
const ALU = { ORA: 0x00, AND: 0x20, EOR: 0x40, ADC: 0x60, STA: 0x80, LDA: 0xa0, CMP: 0xc0, SBC: 0xe0 };
const ALU_MODES = [
  [0x01, IDX], [0x03, SR], [0x05, DP], [0x07, IDL], [0x09, IMM_M], [0x0d, ABS],
  [0x0f, ABL], [0x11, IDY], [0x12, IDP], [0x13, SRY], [0x15, DPX], [0x17, IDLY],
  [0x19, ABY], [0x1d, ABX], [0x1f, ABLX],
];
for (const [name, base] of Object.entries(ALU)) {
  for (const [off, mode] of ALU_MODES) {
    // STA has no immediate form; 0x89 is BIT #imm.
    if (name === "STA" && off === 0x09) continue;
    OP[base + off] = [name, mode];
  }
}
set({
  0x00: ["BRK", IMM8], 0x02: ["COP", IMM8], 0x42: ["WDM", IMM8],
  0x04: ["TSB", DP], 0x0c: ["TSB", ABS], 0x14: ["TRB", DP], 0x1c: ["TRB", ABS],
  0x06: ["ASL", DP], 0x0a: ["ASL", ACC], 0x0e: ["ASL", ABS], 0x16: ["ASL", DPX], 0x1e: ["ASL", ABX],
  0x26: ["ROL", DP], 0x2a: ["ROL", ACC], 0x2e: ["ROL", ABS], 0x36: ["ROL", DPX], 0x3e: ["ROL", ABX],
  0x46: ["LSR", DP], 0x4a: ["LSR", ACC], 0x4e: ["LSR", ABS], 0x56: ["LSR", DPX], 0x5e: ["LSR", ABX],
  0x66: ["ROR", DP], 0x6a: ["ROR", ACC], 0x6e: ["ROR", ABS], 0x76: ["ROR", DPX], 0x7e: ["ROR", ABX],
  0x08: ["PHP", IMP], 0x28: ["PLP", IMP], 0x48: ["PHA", IMP], 0x68: ["PLA", IMP],
  0x0b: ["PHD", IMP], 0x2b: ["PLD", IMP], 0x4b: ["PHK", IMP], 0x6b: ["RTL", IMP],
  0x8b: ["PHB", IMP], 0xab: ["PLB", IMP], 0x5a: ["PHY", IMP], 0x7a: ["PLY", IMP],
  0xda: ["PHX", IMP], 0xfa: ["PLX", IMP], 0x62: ["PER", RELL], 0xd4: ["PEI", DP],
  0xf4: ["PEA", ABS],
  0x10: ["BPL", REL], 0x30: ["BMI", REL], 0x50: ["BVC", REL], 0x70: ["BVS", REL],
  0x90: ["BCC", REL], 0xb0: ["BCS", REL], 0xd0: ["BNE", REL], 0xf0: ["BEQ", REL],
  0x80: ["BRA", REL], 0x82: ["BRL", RELL],
  0x18: ["CLC", IMP], 0x38: ["SEC", IMP], 0x58: ["CLI", IMP], 0x78: ["SEI", IMP],
  0xb8: ["CLV", IMP], 0xd8: ["CLD", IMP], 0xf8: ["SED", IMP], 0xfb: ["XCE", IMP],
  0xc2: ["REP", IMM8], 0xe2: ["SEP", IMM8],
  0x1a: ["INC", ACC], 0x3a: ["DEC", ACC], 0xe6: ["INC", DP], 0xee: ["INC", ABS],
  0xf6: ["INC", DPX], 0xfe: ["INC", ABX], 0xc6: ["DEC", DP], 0xce: ["DEC", ABS],
  0xd6: ["DEC", DPX], 0xde: ["DEC", ABX],
  0xe8: ["INX", IMP], 0xc8: ["INY", IMP], 0xca: ["DEX", IMP], 0x88: ["DEY", IMP],
  0x1b: ["TCS", IMP], 0x3b: ["TSC", IMP], 0x5b: ["TCD", IMP], 0x7b: ["TDC", IMP],
  0xaa: ["TAX", IMP], 0xa8: ["TAY", IMP], 0x8a: ["TXA", IMP], 0x98: ["TYA", IMP],
  0x9a: ["TXS", IMP], 0xba: ["TSX", IMP], 0x9b: ["TXY", IMP], 0xbb: ["TYX", IMP],
  0xeb: ["XBA", IMP], 0xea: ["NOP", IMP], 0xdb: ["STP", IMP], 0xcb: ["WAI", IMP],
  0x20: ["JSR", ABS], 0x22: ["JSL", ABL], 0xfc: ["JSR", IAX],
  0x4c: ["JMP", ABS], 0x5c: ["JML", ABL], 0x6c: ["JMP", IND], 0x7c: ["JMP", IAX],
  0xdc: ["JML", IAL], 0x60: ["RTS", IMP], 0x6b: ["RTL", IMP], 0x40: ["RTI", IMP],
  0x24: ["BIT", DP], 0x2c: ["BIT", ABS], 0x34: ["BIT", DPX], 0x3c: ["BIT", ABX],
  0x89: ["BIT", IMM_M],
  0x64: ["STZ", DP], 0x74: ["STZ", DPX], 0x9c: ["STZ", ABS], 0x9e: ["STZ", ABX],
  0xa0: ["LDY", IMM_X], 0xa4: ["LDY", DP], 0xac: ["LDY", ABS], 0xb4: ["LDY", DPX], 0xbc: ["LDY", ABX],
  0xa2: ["LDX", IMM_X], 0xa6: ["LDX", DP], 0xae: ["LDX", ABS], 0xb6: ["LDX", DPY], 0xbe: ["LDX", ABY],
  0x84: ["STY", DP], 0x8c: ["STY", ABS], 0x94: ["STY", DPX],
  0x86: ["STX", DP], 0x8e: ["STX", ABS], 0x96: ["STX", DPY],
  0xc0: ["CPY", IMM_X], 0xc4: ["CPY", DP], 0xcc: ["CPY", ABS],
  0xe0: ["CPX", IMM_X], 0xe4: ["CPX", DP], 0xec: ["CPX", ABS],
  0x44: ["MVP", BM], 0x54: ["MVN", BM],
});

/** Instruction length at ROM offset o, given M/X flag state. */
function ilen(o, m, x) {
  const [, mode] = OP[rom[o]];
  if (mode === IMM_M) return m ? 2 : 3;
  if (mode === IMM_X) return x ? 2 : 3;
  return LEN[mode];
}

/** Decode one instruction. Returns {text, len, m, x} with flags AFTER it. */
function decode(o, m, x) {
  const op = rom[o];
  const [name, mode] = OP[op];
  const len = ilen(o, m, x);
  const b1 = rom[o + 1], b2 = rom[o + 2], b3 = rom[o + 3];
  const w = b1 | (b2 << 8);
  const { bank } = toCpu(o);
  let arg = "";
  switch (mode) {
    case IMP: break;
    case ACC: arg = "A"; break;
    case IMM8: arg = `#$${hex(b1)}`; break;
    case IMM_M: arg = m ? `#$${hex(b1)}` : `#$${hex(w, 4)}`; break;
    case IMM_X: arg = x ? `#$${hex(b1)}` : `#$${hex(w, 4)}`; break;
    case DP: arg = `$${hex(b1)}`; break;
    case DPX: arg = `$${hex(b1)},X`; break;
    case DPY: arg = `$${hex(b1)},Y`; break;
    case IDP: arg = `($${hex(b1)})`; break;
    case IDX: arg = `($${hex(b1)},X)`; break;
    case IDY: arg = `($${hex(b1)}),Y`; break;
    case IDL: arg = `[$${hex(b1)}]`; break;
    case IDLY: arg = `[$${hex(b1)}],Y`; break;
    case SR: arg = `$${hex(b1)},S`; break;
    case SRY: arg = `($${hex(b1)},S),Y`; break;
    case ABS: arg = `$${hex(w, 4)}`; break;
    case ABX: arg = `$${hex(w, 4)},X`; break;
    case ABY: arg = `$${hex(w, 4)},Y`; break;
    case IND: arg = `($${hex(w, 4)})`; break;
    case IAX: arg = `($${hex(w, 4)},X)`; break;
    case IAL: arg = `[$${hex(w, 4)}]`; break;
    case ABL: arg = `$${hex(b3)}:${hex(w, 4)}`; break;
    case ABLX: arg = `$${hex(b3)}:${hex(w, 4)},X`; break;
    case BM: arg = `$${hex(b1)},$${hex(b2)}`; break;
    case REL: {
      const d = b1 & 0x80 ? b1 - 0x100 : b1;
      arg = `$${hex(bank)}:${hex((o + 2 + d) & 0x7fff | 0x8000, 4)}`;
      break;
    }
    case RELL: {
      const d = w & 0x8000 ? w - 0x10000 : w;
      arg = `$${hex(bank)}:${hex((o + 3 + d) & 0x7fff | 0x8000, 4)}`;
      break;
    }
  }
  // REP clears the flags its mask names, SEP sets them. $20 is M, $10 is X.
  let nm = m, nx = x;
  if (name === "REP") { if (b1 & 0x20) nm = 0; if (b1 & 0x10) nx = 0; }
  if (name === "SEP") { if (b1 & 0x20) nm = 1; if (b1 & 0x10) nx = 1; }
  return { text: arg ? `${name} ${arg}` : name, len, m: nm, x: nx };
}

/** Parse "0x1234" (ROM offset) or "bb:aaaa" (CPU address) to a ROM offset. */
function parseAddr(s) {
  if (s.includes(":")) {
    const [b, a] = s.replace(/\$/g, "").split(":");
    const off = toRom(parseInt(b, 16), parseInt(a, 16));
    if (off < 0) throw new Error(`${s} is not a ROM address under LoROM`);
    return off;
  }
  return Number(s);
}

const argv = process.argv.slice(2);
let mFlag = 1, xFlag = 1;
const rest = [];
for (const a of argv) {
  const mx = /^--mx=([01])([01])$/.exec(a);
  if (mx) { mFlag = Number(mx[1]); xFlag = Number(mx[2]); continue; }
  rest.push(a);
}

if (!rest.length || rest[0] === "--help" || rest[0] === "-h") {
  console.log(
    "usage:\n" +
      "  w65c816dis.mjs <start> [count]      disassemble (0x... offset, or bb:aaaa)\n" +
      "  w65c816dis.mjs --xref <bank:addr>   long-addressed readers/writers\n" +
      "  w65c816dis.mjs --calls <bank:addr>  JSR/JSL sites targeting addr\n" +
      "  --mx=MX                             seed M/X flags (default 11)",
  );
  process.exit(rest.length ? 0 : 2);
}

if (rest[0] === "--xref") {
  const [bs, as] = rest[1].replace(/\$/g, "").split(":");
  const wantBank = parseInt(bs, 16), wantAddr = parseInt(as, 16);
  // Every opcode whose mode is ABL or ABLX carries a 24-bit target.
  const longOps = [];
  for (let i = 0; i < 256; i++) {
    const [name, mode] = OP[i];
    if (mode === ABL || mode === ABLX) longOps.push([i, name, mode]);
  }
  const byOp = new Map(longOps.map(([i, name, mode]) => [i, [name, mode]]));
  for (let o = 0; o + 3 < rom.length; o++) {
    const e = byOp.get(rom[o]);
    if (!e) continue;
    if (rom[o + 3] !== wantBank) continue;
    const addr = rom[o + 1] | (rom[o + 2] << 8);
    if (addr !== wantAddr) continue;
    const [name, mode] = e;
    console.log(
      `${("0x" + o.toString(16)).padEnd(9)} ${cpuStr(o)}  ${name} $${hex(wantBank)}:${hex(wantAddr, 4)}${mode === ABLX ? ",X" : ""}`,
    );
  }
  process.exit(0);
}

if (rest[0] === "--calls") {
  const [bs, as] = rest[1].replace(/\$/g, "").split(":");
  const wantBank = parseInt(bs, 16), wantAddr = parseInt(as, 16);
  for (let o = 0; o + 3 < rom.length; o++) {
    const op = rom[o];
    if (op === 0x22 || op === 0x5c) { // JSL / JML long
      const addr = rom[o + 1] | (rom[o + 2] << 8);
      if (rom[o + 3] === wantBank && addr === wantAddr) {
        console.log(`${("0x" + o.toString(16)).padEnd(9)} ${cpuStr(o)}  ${op === 0x22 ? "JSL" : "JML"}`);
      }
    } else if (op === 0x20 || op === 0x4c) { // JSR / JMP abs, same bank
      const addr = rom[o + 1] | (rom[o + 2] << 8);
      if (toCpu(o).bank === wantBank && addr === wantAddr) {
        console.log(`${("0x" + o.toString(16)).padEnd(9)} ${cpuStr(o)}  ${op === 0x20 ? "JSR" : "JMP"}`);
      }
    }
  }
  process.exit(0);
}

let off = parseAddr(rest[0]);
const count = rest[1] ? Number(rest[1]) : 40;
let m = mFlag, x = xFlag;
for (let n = 0; n < count && off < rom.length; n++) {
  const d = decode(off, m, x);
  const bytes = Array.from(rom.subarray(off, off + d.len), (b) => hex(b)).join(" ");
  console.log(
    `${("0x" + off.toString(16)).padEnd(8)} ${cpuStr(off)}  ${bytes.padEnd(12)} ${`m${m}x${x}`}  ${d.text}`,
  );
  off += d.len;
  m = d.m; x = d.x;
}
