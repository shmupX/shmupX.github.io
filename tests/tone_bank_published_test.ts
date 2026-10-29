// The Saturn tone bank, published with the game.
//
// static/games/2028-ai/assets/tone-bank/ holds the bank cut for the browser
// (`deno task deza:tonebank --web`, packages/shmup-harbor/lib/sndpac.ts): the
// runtime (game.bundle.js loadDezaToneBank) and the editor's MUSIC
// (bgm-player.js loadToneBank) play it everywhere, where the samples used to
// be a localhost-only Vite route. Pinned here: the files are what they say
// they are, they match the engine's instrument map, they are exactly what the
// cutter makes from SNDPAC.BIN (when a disc is here to check against), the
// runtime asks for them where the game serves them — online and in an
// exported app — and the raw disc file is still nowhere in git.

import { assert, assertEquals } from "@std/assert";
import {
  INSTRUMENT_COUNT,
  instrumentAt,
  layerAt,
  SCSP_BASE_RATE,
  uniqueSlices,
} from "../packages/shmup-engine/src/audio/tone-bank.js";
import { webToneBankFiles } from "../packages/shmup-harbor/lib/sndpac.ts";
import { hasSoundBank, loadSoundBank } from "../packages/shmup-engine/test/_fixtures.js";

const DIR = new URL("../static/games/2028-ai/assets/tone-bank/", import.meta.url);
const json = await Deno.readTextFile(new URL("tone-bank.json", DIR));
const pcm = await Deno.readFile(new URL("tone-bank.pcm", DIR));
const bank = JSON.parse(json);

async function sha256(bytes: Uint8Array) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("the published bank says what it is, and its PCM is the PCM it names", async () => {
  assertEquals(bank.format, "deza-web-tone-bank");
  assertEquals(bank.version, 1);
  assertEquals(bank.sampleRate, SCSP_BASE_RATE);
  assertEquals(bank.instruments.length, INSTRUMENT_COUNT);
  assertEquals(bank.slices.length, uniqueSlices().length);
  const samples = bank.slices.reduce((n: number, s: { samples: number }) => n + s.samples, 0);
  assertEquals(pcm.length, samples * 2);
  assertEquals(bank.pcmBytes, pcm.length);
  assertEquals(bank.pcmSha256, await sha256(pcm));
  // Slices are packed end to end in order.
  let at = 0;
  for (const s of bank.slices) {
    assertEquals(s.at, at);
    at += s.samples;
  }
});

Deno.test("every instrument's layers are the engine's instrument map", () => {
  for (let i = 0; i < INSTRUMENT_COUNT; i++) {
    const info = instrumentAt(i)!;
    const want = [];
    for (let k = 0; k < info.layerCount; k++) {
      const l = layerAt(info.firstLayer + k)!;
      want.push([l.noteLo, l.noteHi, l.rootPitch, l.fineTune, l.level, l.pan]);
    }
    const got = bank.instruments[i].layers.map((l: Record<string, number>) => [
      l.noteLo,
      l.noteHi,
      l.rootPitch,
      l.fineTune,
      l.level,
      l.pan,
    ]);
    assertEquals(got, want, `instrument ${i}`);
    for (const l of bank.instruments[i].layers) assert(l.slice >= 0 && l.slice < bank.slices.length);
  }
});

Deno.test({
  name: "the committed files are byte for byte what the cutter makes of SNDPAC.BIN",
  ignore: !hasSoundBank(),
  async fn() {
    const files = await webToneBankFiles(loadSoundBank()!);
    assertEquals(files.json, json, "tone-bank.json drifted: run deno task deza:tonebank --web");
    assertEquals(await sha256(files.pcm), await sha256(pcm), "tone-bank.pcm drifted");
  },
});

const BUNDLE = (await Deno.readTextFile(new URL("../static/games/2028-ai/game.bundle.js", import.meta.url)))
  .replaceAll("\r\n", "\n");

function loaderAsked(assetBase: string): Promise<string[]> {
  const start = BUNDLE.indexOf("\n  function loadDezaToneBank(");
  const src = BUNDLE.slice(start, BUNDLE.indexOf("\n  }\n", start) + 4);
  const asked: string[] = [];
  const fetchStub = (url: string) => {
    asked.push(url);
    return Promise.resolve({ ok: false });
  };
  const load = new Function(
    "fetch",
    "ASSET_BASE",
    `var DEZA_TONE_BANK = null; var dezaToneBankPending = null;${src}\nreturn loadDezaToneBank;`,
  )(fetchStub, assetBase);
  return Promise.resolve(load()).then(() => asked);
}

Deno.test("the runtime asks for the bank where the game serves it, online and in an exported app", async () => {
  assertEquals(await loaderAsked("/games/2028-ai/"), [
    "/games/2028-ai/assets/tone-bank/tone-bank.json",
    "/games/2028-ai/assets/tone-bank/tone-bank.pcm",
  ]);
  // build-level patches ASSET_BASE to "" for an offline app.
  assertEquals(await loaderAsked(""), ["assets/tone-bank/tone-bank.json", "assets/tone-bank/tone-bank.pcm"]);
  // The dev-only route and its localhost gate are gone.
  assert(!BUNDLE.includes("/dev/tone-bank"));
  const vite = await Deno.readTextFile(new URL("../vite.config.ts", import.meta.url));
  assert(!vite.includes("/dev/tone-bank.json"));
});

Deno.test("the raw SNDPAC.BIN is nowhere in git", async () => {
  const out = await new Deno.Command("git", { args: ["ls-files"], stdout: "piped" }).output();
  const files = new TextDecoder().decode(out.stdout).split("\n");
  assert(!files.some((f) => /sndpac\.bin$/i.test(f)), "SNDPAC.BIN is tracked");
});
