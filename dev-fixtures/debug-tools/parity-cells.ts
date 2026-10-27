// The character cells a Dezaemon 2 cart draws for the engine bullet slots (refs 104-136) and the decoder bullet refs (132-143),
// six rows of four at 6x, with a line per row naming each ref's cell, ink and top colours.
// usage: deno run -A dev-fixtures/debug-tools/parity-cells.ts <cart.sav> <out.png>
import { normalize, parse, decodeSave } from "../../packages/shmup-engine/mod.js";
import { cellIndexed } from "../../packages/shmup-engine/src/decode/decode-cg.js";
import { encodePng } from "../../packages/shmup-harbor/lib/ps2/png.ts";
const raw = await Deno.readFile(Deno.args[0]);
const norm = await normalize(raw);
type SaveEntry = { isGameSave?: boolean; filename: string; payload: { buffer: Uint8Array } | null };
// decodeSave's result starts out all-null in the decoder's own typing; the
// four CG pages, the palettes and section 5 are what this sheet reads.
type Decoded = {
  sections: { decompressed: Uint8Array }[];
  cg: { palettes: { colors: { r: number; g: number; b: number }[] }[] };
};
const entries = parse(norm.data) as SaveEntry[];
const save = entries.find((e) => e.isGameSave || /^DEZA2/.test(e.filename)) ?? entries[0];
if (!save?.payload) throw new Error(`no game save in ${Deno.args[0]}`);
const d = decodeSave(save.payload.buffer) as unknown as Decoded;
const cgPages = d.sections.slice(0, 4).map((s) => s.decompressed);
const pal = d.cg.palettes;
const sec5 = d.sections[5].decompressed as Uint8Array;
const gb = 0x5D490;
const refWord = (r: number) => (sec5[gb + r * 2] << 8) | sec5[gb + r * 2 + 1];
const groups: [string, number[]][] = [
  ["refs 104-107 (engine char slots 55-58)", [104, 105, 106, 107]],
  ["refs 132-135 (decoder bullet type 0)", [132, 133, 134, 135]],
  ["refs 108,112,116,120 (slots 59-62)", [108, 112, 116, 120]],
  ["refs 136-139 (decoder type 1)", [136, 137, 138, 139]],
  ["refs 124,128,132,136 (slots 63-66)", [124, 128, 132, 136]],
  ["refs 140-143 (decoder type 2)", [140, 141, 142, 143]],
];
const S = 6, cw = 16 * S + 4, rowH = 16 * S + 4;
const out = { width: cw * 4, height: rowH * groups.length, data: new Uint8Array(cw * 4 * rowH * groups.length * 4) };
groups.forEach(([label, refs], gi) => {
  const desc: string[] = [];
  refs.forEach((r, i) => {
    const w = refWord(r);
    if (w === 0xffff) { desc.push(`${r}:EMPTY`); return; }
    const cell = w & 0x3ff;
    const px = cellIndexed(cgPages, cell) as Uint8Array;
    let ink = 0; const hist = new Map<number, number>();
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const sx = (w & 0x4000) ? 15 - x : x, sy = (w & 0x8000) ? 15 - y : y;
      const idx = px[sy * 16 + sx];
      if (!idx) continue;
      ink++; hist.set(idx, (hist.get(idx) ?? 0) + 1);
      const c = pal[idx >> 4].colors[idx & 15];
      for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
        const ox = i * cw + 2 + x * S + dx, oy = gi * rowH + 2 + y * S + dy;
        const di = (oy * out.width + ox) * 4;
        out.data[di] = c.r; out.data[di + 1] = c.g; out.data[di + 2] = c.b; out.data[di + 3] = 255;
      }
    }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([v, n]) => { const c = pal[v >> 4].colors[v & 15]; return `#${[c.r, c.g, c.b].map((q: number) => q.toString(16).padStart(2, "0")).join("")}x${n}`; });
    desc.push(`${r}:cell${cell}${w & 0x4000 ? "h" : ""}${w & 0x8000 ? "v" : ""} ink${ink} ${top.join(",")}`);
  });
  console.log(label, "->", desc.join(" | "));
});
const dest = Deno.args[1];
await Deno.writeFile(dest, (await encodePng(out as never)) as Uint8Array);
console.log(dest);
