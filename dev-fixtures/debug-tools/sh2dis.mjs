// Minimal SH-2 disassembler for tracing the Dezaemon 2 play engine
// (GAME.bin, extracted by extract-cmp.mjs, loaded at 0x06064000). Fixed
// 16-bit big-endian opcodes; PC-relative literal loads are resolved and
// printed inline, which is what makes table tracing practical — a
// `mov.l [0x607d8e4]=0x608fd40,r1` line hands you the array a routine
// walks without any cross-referencing by hand.
//
//   node dev-fixtures/debug-tools/sh2dis.mjs <start> <end>
//       disassemble a RAM address range
//   node dev-fixtures/debug-tools/sh2dis.mjs --xref <ramaddr>
//       every PC-relative literal load whose pool value == addr
//       (finds all readers/writers of a RAM array, callers via jsr @rN)
//   node dev-fixtures/debug-tools/sh2dis.mjs --calls <ramaddr>
//       every BRA/BSR whose displacement targets addr
//
// Addresses accept 0x hex. SH2DIS_BIN overrides the binary path (default
// ./GAME.bin in the current directory); SH2DIS_BASE the load address.
// Data regions disassemble as garbage — literal pools live between
// functions, so a run of `.word`/nonsense after an rts is the pool, not
// code. The FORMAT.md fire-engine trace was made with exactly this tool.
import fs from "node:fs";

const bin = fs.readFileSync(process.env.SH2DIS_BIN || "./GAME.bin");
const BASE = Number(process.env.SH2DIS_BASE || 0x06064000);
const END = BASE + bin.length;
const u16 = (ram) => bin.readUInt16BE(ram - BASE);
const u32 = (ram) => bin.readUInt32BE(ram - BASE);
const inRange = (ram) => ram >= BASE && ram + 1 < END;
const hex = (v) => "0x" + (v >>> 0).toString(16);

const sext8 = (v) => (v & 0x80) ? v - 0x100 : v;
const sext12 = (v) => (v & 0x800) ? v - 0x1000 : v;

export function dis1(pc) {
  const op = u16(pc);
  const n = (op >> 8) & 0xf;
  const m = (op >> 4) & 0xf;
  const d4 = op & 0xf;
  const d8 = op & 0xff;
  const i8 = op & 0xff;
  const top = op >> 12;
  const R = (r) => "r" + r;
  const lit = (addr, word) => {
    if (!inRange(addr)) return `[${hex(addr)}]`;
    const v = word ? u16(addr) : u32(addr);
    return `[${hex(addr)}]=${hex(v)}`;
  };
  switch (top) {
    case 0x0:
      switch (op & 0xff) {
        case 0x02:
          return `stc sr,${R(n)}`;
        case 0x12:
          return `stc gbr,${R(n)}`;
        case 0x22:
          return `stc vbr,${R(n)}`;
        case 0x03:
          return `bsrf ${R(n)}`;
        case 0x23:
          return `braf ${R(n)}`;
        case 0x0a:
          return `sts mach,${R(n)}`;
        case 0x1a:
          return `sts macl,${R(n)}`;
        case 0x2a:
          return `sts pr,${R(n)}`;
        case 0x08:
          return op === 0x0008 ? "clrt" : null;
        case 0x18:
          return op === 0x0018 ? "sett" : null;
        case 0x19:
          return op === 0x0019 ? "div0u" : null;
        case 0x09:
          return op === 0x0009 ? "nop" : null;
        case 0x0b:
          return op === 0x000b ? "rts" : null;
        case 0x28:
          return op === 0x0028 ? "clrmac" : null;
        case 0x2b:
          return op === 0x002b ? "rte" : null;
      }
      switch (d4) {
        case 0x4:
          return `mov.b ${R(m)},@(r0,${R(n)})`;
        case 0x5:
          return `mov.w ${R(m)},@(r0,${R(n)})`;
        case 0x6:
          return `mov.l ${R(m)},@(r0,${R(n)})`;
        case 0x7:
          return `mul.l ${R(m)},${R(n)}`;
        case 0xc:
          return `mov.b @(r0,${R(m)}),${R(n)}`;
        case 0xd:
          return `mov.w @(r0,${R(m)}),${R(n)}`;
        case 0xe:
          return `mov.l @(r0,${R(m)}),${R(n)}`;
        case 0xf:
          return `mac.l @${R(m)}+,@${R(n)}+`;
      }
      return null;
    case 0x1:
      return `mov.l ${R(m)},@(${d4 * 4},${R(n)})`;
    case 0x2:
      switch (d4) {
        case 0x0:
          return `mov.b ${R(m)},@${R(n)}`;
        case 0x1:
          return `mov.w ${R(m)},@${R(n)}`;
        case 0x2:
          return `mov.l ${R(m)},@${R(n)}`;
        case 0x4:
          return `mov.b ${R(m)},@-${R(n)}`;
        case 0x5:
          return `mov.w ${R(m)},@-${R(n)}`;
        case 0x6:
          return `mov.l ${R(m)},@-${R(n)}`;
        case 0x7:
          return `div0s ${R(m)},${R(n)}`;
        case 0x8:
          return `tst ${R(m)},${R(n)}`;
        case 0x9:
          return `and ${R(m)},${R(n)}`;
        case 0xa:
          return `xor ${R(m)},${R(n)}`;
        case 0xb:
          return `or ${R(m)},${R(n)}`;
        case 0xc:
          return `cmp/str ${R(m)},${R(n)}`;
        case 0xd:
          return `xtrct ${R(m)},${R(n)}`;
        case 0xe:
          return `mulu.w ${R(m)},${R(n)}`;
        case 0xf:
          return `muls.w ${R(m)},${R(n)}`;
      }
      return null;
    case 0x3: {
      const ops3 = {
        0: "cmp/eq",
        2: "cmp/hs",
        3: "cmp/ge",
        4: "div1",
        5: "dmulu.l",
        6: "cmp/hi",
        7: "cmp/gt",
        8: "sub",
        10: "subc",
        11: "subv",
        12: "add",
        13: "dmuls.l",
        14: "addc",
        15: "addv",
      };
      const o = ops3[d4];
      return o ? `${o} ${R(m)},${R(n)}` : null;
    }
    case 0x4:
      switch (op & 0xff) {
        case 0x00:
          return `shll ${R(n)}`;
        case 0x01:
          return `shlr ${R(n)}`;
        case 0x04:
          return `rotl ${R(n)}`;
        case 0x05:
          return `rotr ${R(n)}`;
        case 0x08:
          return `shll2 ${R(n)}`;
        case 0x09:
          return `shlr2 ${R(n)}`;
        case 0x0b:
          return `jsr @${R(n)}`;
        case 0x10:
          return `dt ${R(n)}`;
        case 0x11:
          return `cmp/pz ${R(n)}`;
        case 0x15:
          return `cmp/pl ${R(n)}`;
        case 0x18:
          return `shll8 ${R(n)}`;
        case 0x19:
          return `shlr8 ${R(n)}`;
        case 0x1b:
          return `tas.b @${R(n)}`;
        case 0x20:
          return `shal ${R(n)}`;
        case 0x21:
          return `shar ${R(n)}`;
        case 0x22:
          return `sts.l pr,@-${R(n)}`;
        case 0x24:
          return `rotcl ${R(n)}`;
        case 0x25:
          return `rotcr ${R(n)}`;
        case 0x26:
          return `lds.l @${R(n)}+,pr`;
        case 0x28:
          return `shll16 ${R(n)}`;
        case 0x29:
          return `shlr16 ${R(n)}`;
        case 0x2a:
          return `lds ${R(n)},pr`;
        case 0x2b:
          return `jmp @${R(n)}`;
        case 0x0e:
          return `ldc ${R(n)},sr`;
        case 0x1e:
          return `ldc ${R(n)},gbr`;
        case 0x2e:
          return `ldc ${R(n)},vbr`;
        case 0x02:
          return `sts.l mach,@-${R(n)}`;
        case 0x12:
          return `sts.l macl,@-${R(n)}`;
        case 0x06:
          return `lds.l @${R(n)}+,mach`;
        case 0x16:
          return `lds.l @${R(n)}+,macl`;
        case 0x0a:
          return `lds ${R(n)},mach`;
        case 0x1a:
          return `lds ${R(n)},macl`;
      }
      if (d4 === 0xf) return `mac.w @${R(m)}+,@${R(n)}+`;
      return null;
    case 0x5:
      return `mov.l @(${d4 * 4},${R(m)}),${R(n)}`;
    case 0x6: {
      const ops6 = [
        "mov.b @%m,%n",
        "mov.w @%m,%n",
        "mov.l @%m,%n",
        "mov %m,%n",
        "mov.b @%m+,%n",
        "mov.w @%m+,%n",
        "mov.l @%m+,%n",
        "not %m,%n",
        "swap.b %m,%n",
        "swap.w %m,%n",
        "negc %m,%n",
        "neg %m,%n",
        "extu.b %m,%n",
        "extu.w %m,%n",
        "exts.b %m,%n",
        "exts.w %m,%n",
      ];
      return ops6[d4].replace("%m", R(m)).replace("%n", R(n));
    }
    case 0x7:
      return `add #${sext8(i8)},${R(n)}`;
    case 0x8:
      switch (n) {
        case 0x0:
          return `mov.b r0,@(${d4},${R(m)})`;
        case 0x1:
          return `mov.w r0,@(${d4 * 2},${R(m)})`;
        case 0x4:
          return `mov.b @(${d4},${R(m)}),r0`;
        case 0x5:
          return `mov.w @(${d4 * 2},${R(m)}),r0`;
        case 0x8:
          return `cmp/eq #${sext8(i8)},r0`;
        case 0x9:
          return `bt ${hex(pc + 4 + sext8(d8) * 2)}`;
        case 0xb:
          return `bf ${hex(pc + 4 + sext8(d8) * 2)}`;
        case 0xd:
          return `bt/s ${hex(pc + 4 + sext8(d8) * 2)}`;
        case 0xf:
          return `bf/s ${hex(pc + 4 + sext8(d8) * 2)}`;
      }
      return null;
    case 0x9: {
      const addr = pc + 4 + d8 * 2;
      return `mov.w ${lit(addr, true)},${R(n)}`;
    }
    case 0xa:
      return `bra ${hex(pc + 4 + sext12(op & 0xfff) * 2)}`;
    case 0xb:
      return `bsr ${hex(pc + 4 + sext12(op & 0xfff) * 2)}`;
    case 0xc:
      switch (n) {
        case 0x0:
          return `mov.b r0,@(${d8},gbr)`;
        case 0x1:
          return `mov.w r0,@(${d8 * 2},gbr)`;
        case 0x2:
          return `mov.l r0,@(${d8 * 4},gbr)`;
        case 0x3:
          return `trapa #${d8}`;
        case 0x4:
          return `mov.b @(${d8},gbr),r0`;
        case 0x5:
          return `mov.w @(${d8 * 2},gbr),r0`;
        case 0x6:
          return `mov.l @(${d8 * 4},gbr),r0`;
        case 0x7:
          return `mova ${
            lit((pc & ~3) + 4 + d8 * 4, false).replace("=", " -> ")
          },r0`;
        case 0x8:
          return `tst #${d8},r0`;
        case 0x9:
          return `and #${d8},r0`;
        case 0xa:
          return `xor #${d8},r0`;
        case 0xb:
          return `or #${d8},r0`;
        case 0xc:
          return `tst.b #${d8},@(r0,gbr)`;
        case 0xd:
          return `and.b #${d8},@(r0,gbr)`;
        case 0xe:
          return `xor.b #${d8},@(r0,gbr)`;
        case 0xf:
          return `or.b #${d8},@(r0,gbr)`;
      }
      return null;
    case 0xd: {
      const addr = (pc & ~3) + 4 + d8 * 4;
      return `mov.l ${lit(addr, false)},${R(n)}`;
    }
    case 0xe:
      return `mov #${sext8(i8)},${R(n)}`;
  }
  return null;
}

export function disRange(start, end) {
  const lines = [];
  for (let pc = start; pc < end; pc += 2) {
    const op = u16(pc);
    const asm = dis1(pc) ?? `.word ${hex(op)}`;
    lines.push(
      `${hex(pc)} (+${(pc - BASE).toString(16)}): ${
        op.toString(16).padStart(4, "0")
      }  ${asm}`,
    );
  }
  return lines;
}

// literal-pool xrefs: every mov.l @(disp,PC) or mova whose pool slot holds `target`
export function xrefs(target) {
  const out = [];
  for (let pc = BASE; pc + 1 < END; pc += 2) {
    const op = u16(pc);
    const top = op >> 12;
    if (top === 0xd || (top === 0xc && ((op >> 8) & 0xf) === 7)) {
      const addr = (pc & ~3) + 4 + (op & 0xff) * 4;
      if (inRange(addr) && addr + 3 < END && u32(addr) === target) out.push(pc);
    }
    if (top === 0x9) {
      const addr = pc + 4 + (op & 0xff) * 2;
      if (
        inRange(addr) && u16(addr) === (target & 0xffff) && target <= 0xffff
      ) out.push(pc);
    }
  }
  return out;
}

export function calls(target) {
  const out = [];
  for (let pc = BASE; pc + 1 < END; pc += 2) {
    const op = u16(pc);
    const top = op >> 12;
    if (top === 0xa || top === 0xb) {
      const t = pc + 4 + sext12(op & 0xfff) * 2;
      if (t === target) out.push(pc);
    }
  }
  return out;
}

// CLI
const argv = process.argv.slice(2);
if (argv[0] === "--xref") {
  const t = Number(argv[1]);
  for (const pc of xrefs(t)) {
    console.log(`${hex(pc)} (+${(pc - BASE).toString(16)}): ${dis1(pc)}`);
  }
} else if (argv[0] === "--calls") {
  const t = Number(argv[1]);
  for (const pc of calls(t)) {
    console.log(`${hex(pc)} (+${(pc - BASE).toString(16)}): ${dis1(pc)}`);
  }
} else if (argv.length >= 2) {
  console.log(disRange(Number(argv[0]), Number(argv[1])).join("\n"));
}
