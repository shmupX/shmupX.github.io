// The PS2 sound packs: the base game's MP3s in, audsrv ADPCM and Ogg out.
//
// Gated on ffmpeg, which does both codecs — see lib/ps2/sound-pack.ts. The key
// lists are not gated: they have to keep matching the paths the ps2-sp port
// bakes into its bundle whether or not this host can encode anything.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  BGM_RATE,
  bgmPlan,
  bgmRequests,
  buildBgmPack,
  buildSfxPack,
  FALLBACK_BOSS_BGM,
  findFfmpeg,
  SCENE_BGM,
  SFX_BUDGET_BYTES,
  SFX_DIR,
  SFX_GAIN,
  SFX_RATE,
  sfxRequests,
} from "../lib/ps2/sound-pack.ts";
import { ADPCM_BLOCK_SAMPLES } from "../lib/ps2/adpcm.ts";
import { repoRoot } from "../lib/repo-root.ts";

const ROOT = repoRoot();
const GAME_DIR = join(ROOT, "static", "games", "2028-ai");

const ffmpeg = await findFfmpeg();
const gated = { ignore: ffmpeg === null };
if (!ffmpeg) {
  console.log("  (sfx pack: skipped — no ffmpeg on this host)");
}

const pack = ffmpeg ? await buildSfxPack(GAME_DIR, { ffmpeg }) : null;
const music = ffmpeg ? await buildBgmPack(GAME_DIR, { ffmpeg }) : null;

Deno.test("every key the port loads has a request, at the port's own path", () => {
  const requests = sfxRequests();
  // 13 effects + 15 voices + 10 countdown + 3 yes + 2 no + 5 stage + 12 boss.
  assertEquals(requests.length, 60);
  assertEquals(new Set(requests.map((r) => r.key)).size, requests.length);

  const byKey = new Map(requests.map((r) => [r.key, r.path]));
  // The paths are the port's, not the game's. se_decision and voice_titlecall
  // sit in ui/ and scene_title/ in the base game but at the top of the port's
  // tree; voice_countdown7 and g_stage_voice_3 are in subdirectories in both,
  // and the port's names for them are the ones that count.
  assertEquals(byKey.get("se_shoot"), "assets/sounds/se_shoot.wav");
  assertEquals(byKey.get("se_decision"), "assets/sounds/se_decision.wav");
  assertEquals(
    byKey.get("voice_titlecall"),
    "assets/sounds/voice_titlecall.wav",
  );
  assertEquals(
    byKey.get("voice_countdown7"),
    "assets/sounds/scene_continue/voice_countdown7.wav",
  );
  assertEquals(
    byKey.get("g_stage_voice_3"),
    "assets/sounds/scene_game/g_stage_voice_3.wav",
  );
});

Deno.test("the base game answers every request", gated, async () => {
  // A key with no source would be a silent effect on the console. With the
  // budget lifted, every one of them has to encode.
  const all = await buildSfxPack(GAME_DIR, { ffmpeg, budgetBytes: Infinity });
  assertEquals(all!.files.length, sfxRequests().length);
});

Deno.test(
  "each effect is staged where the port will look for it",
  gated,
  () => {
    // Flat under assets/sounds/, whatever subdirectory the port's own path
    // named — runtime-sound.ts rewrites the path the same way.
    const wanted = new Set(
      sfxRequests().map(({ key }) => `${SFX_DIR}/${key}.adp`),
    );
    for (const file of pack!.files) {
      assert(wanted.has(file.path), `staged somewhere odd: ${file.path}`);
    }
    assert(
      pack!.files.every((f) => f.path.split("/").length === 3),
      "an effect is nested deeper than assets/sounds/",
    );
  },
);

Deno.test("the effects fit in IOP RAM, gameplay first", gated, () => {
  // audsrv DMAs every sample into the IOP's 2 MB, and AthenaEnv ignores the
  // return code — so going over is not an error anybody reports, it is a
  // console that falls over. The whole set is ~1.5 MB.
  const bytes = pack!.files.reduce((n, f) => n + f.data.length, 0);
  assert(
    bytes <= SFX_BUDGET_BYTES,
    `${bytes} bytes of ADPCM is over the ${SFX_BUDGET_BYTES} budget`,
  );

  // Whatever else is dropped, the sounds that fire during play are not.
  const staged = new Set(pack!.files.map((f) => f.path));
  for (const { key } of sfxRequests()) {
    if (!key.startsWith("se_")) continue;
    assert(
      staged.has(`${SFX_DIR}/${key}.adp`),
      `gameplay effect dropped: ${key}`,
    );
  }
});

Deno.test(
  "a tighter budget drops more, and never the shots",
  gated,
  async () => {
    const tight = await buildSfxPack(GAME_DIR, {
      ffmpeg,
      budgetBytes: 128 * 1024,
    });
    assert(tight!.files.length < pack!.files.length);
    const staged = new Set(tight!.files.map((f) => f.path));
    assert(staged.has("assets/sounds/se_shoot.adp"), "dropped se_shoot");
    assert(
      staged.has("assets/sounds/se_explosion.adp"),
      "dropped se_explosion",
    );
  },
);

Deno.test("every file is a one-shot APCM at the pack's rate", gated, () => {
  for (const file of pack!.files) {
    const view = new DataView(file.data.buffer, file.data.byteOffset);
    assertEquals(
      new TextDecoder().decode(file.data.subarray(0, 4)),
      "APCM",
      file.path,
    );
    assertEquals(file.data[5], 1, `${file.path}: channels`);
    // Not looping: an effect that loops never stops, and audsrv gives no way
    // to silence a one-shot voice.
    assertEquals(file.data[6], 0, `${file.path}: loop flag`);
    assertEquals(
      view.getUint32(8, true),
      Math.floor(SFX_RATE * 4096 / 48000),
      `${file.path}: pitch`,
    );
    const samples = view.getUint32(12, true);
    assert(samples > 0, `${file.path}: empty`);
    // 16-byte header, one 16-byte block per 28 samples, plus the terminator.
    const blocks = Math.ceil(samples / ADPCM_BLOCK_SAMPLES);
    assertEquals(
      file.data.length,
      16 + (blocks + 1) * 16,
      `${file.path}: size`,
    );
  }
});

Deno.test("nothing is claimed that cannot be encoded", async () => {
  // With ffmpeg forced absent the pack is null rather than empty, so the
  // caller can tell "no decoder" from "no sources" and log the right thing.
  assertEquals(await buildSfxPack(GAME_DIR, { ffmpeg: null }), null);
});

Deno.test("the music keys are the ones the port streams", () => {
  const requests = bgmRequests();
  assertEquals(requests.length, 9);
  const byKey = new Map(requests.map((r) => [r.key, r.path]));
  // Staged as .wav — the port asks for .ogg and runtime-sound.ts rewrites it,
  // because Vorbis decoding inside audsrv's fill callback crashes the console.
  assertEquals(byKey.get("adventure_bgm"), "assets/sounds/adventure_bgm.wav");
  // In scene_continue/ in the base game, at the top of the port's tree.
  assertEquals(byKey.get("bgm_continue"), "assets/sounds/bgm_continue.wav");
  // A boss track per boss, matching `"boss_" + bossData.name + "_bgm"`.
  for (const boss of ["bison", "barlog", "sagat", "vega", "goki", "fang"]) {
    assert(byKey.has(`boss_${boss}_bgm`), `no track for ${boss}`);
  }
});

Deno.test("the base game answers every music request", gated, () => {
  assertEquals(music!.files.length, bgmRequests().length);
  const staged = new Set(music!.files.map((f) => f.path));
  for (const { path } of bgmRequests()) {
    assert(staged.has(path), `not staged: ${path}`);
  }
});

Deno.test("every track is a WAV AthenaEnv's t_wave can read", gated, () => {
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  for (const file of music!.files) {
    const v = new DataView(file.data.buffer, file.data.byteOffset);
    assertEquals(text(file.data.subarray(0, 4)), "RIFF", file.path);
    assertEquals(text(file.data.subarray(8, 12)), "WAVE", file.path);
    assertEquals(text(file.data.subarray(12, 16)), "fmt ", file.path);
    // AthenaEnv freads sizeof(t_wave) — the canonical 44-byte header — and
    // reads channels, rate and bit depth straight out of it, so the layout
    // has to be exactly that, with the data chunk at offset 36.
    assertEquals(v.getUint32(16, true), 16, `${file.path}: fmt chunk size`);
    assertEquals(v.getUint16(20, true), 1, `${file.path}: PCM`);
    assertEquals(v.getUint16(22, true), 1, `${file.path}: mono`);
    assertEquals(v.getUint32(24, true), BGM_RATE, `${file.path}: rate`);
    assertEquals(v.getUint16(34, true), 16, `${file.path}: bits`);
    assertEquals(text(file.data.subarray(36, 40)), "data", file.path);
    // load_wav() seeks to 0x30 for the samples, four bytes past the 44-byte
    // header, so the track opens with four bytes of silence and the seek
    // lands on real audio instead of clipping it.
    assertEquals(v.getUint32(44, true), 0, `${file.path}: lead-in silence`);
    assert(file.data.length > 44 + 4, `${file.path}: suspiciously short`);
  }
});

Deno.test("music is separable from the rest of the audio", gated, async () => {
  // It is most of the disc, so --no-music has to be able to drop it without
  // touching the effects.
  assertEquals(await buildBgmPack(GAME_DIR, { ffmpeg: null }), null);
  assert(pack!.files.length > 0);
});

/** Is there a stock track by this key — what the base game's sound tree has. */
const stock = (key: string) => bgmRequests().some((r) => r.key === key);

Deno.test("a game's own bosses play the stock game's last track", () => {
  // gs: two stages, two bosses of its own, no music of its own.
  const plan = bgmPlan([
    { stage: 0, name: "geekstar" },
    { stage: 1, name: "Daltonius" },
  ], stock);
  assertEquals(FALLBACK_BOSS_BGM, "boss_fang_bgm");
  assertEquals(plan.keys, [...SCENE_BGM, "boss_fang_bgm"]);
  assertEquals(plan.alias, {
    boss_geekstar_bgm: "boss_fang_bgm",
    boss_Daltonius_bgm: "boss_fang_bgm",
  });
});

Deno.test("a boss with a track plays it, once, and the rest stay off", () => {
  const plan = bgmPlan([
    { stage: 0, name: "bison" },
    { stage: 1, name: "barlog" },
    { stage: 2, name: "bison" },
  ], stock);
  assertEquals(plan.keys, [...SCENE_BGM, "boss_bison_bgm", "boss_barlog_bgm"]);
  assertEquals(plan.alias, {});
  // A boss of the game's own WITH a track in the sound tree plays that.
  const own = bgmPlan(
    [{ stage: 0, name: "Daltonius" }],
    (key) => key === "boss_Daltonius_bgm",
  );
  assertEquals(own.keys, [...SCENE_BGM, "boss_Daltonius_bgm"]);
  assertEquals(own.alias, {});
  // No bosses at all still leaves the scenes their music.
  assertEquals(bgmPlan([], stock).keys, SCENE_BGM);
});

Deno.test("only the tracks the stages play are staged", gated, async () => {
  const two = await buildBgmPack(GAME_DIR, {
    ffmpeg,
    bosses: [{ stage: 0, name: "geekstar" }, { stage: 1, name: "Daltonius" }],
  });
  assertEquals(two!.keys.sort(), [...SCENE_BGM, "boss_fang_bgm"].sort());
  assertEquals(two!.alias!["boss_Daltonius_bgm"], "boss_fang_bgm");
  for (const file of two!.files) {
    assert(/^assets\/sounds\/\w+\.wav$/.test(file.path), file.path);
  }
});

/** Peak of an audsrv .adp, decoded the way the SPU2 does. */
function adpPeak(adp: Uint8Array): number {
  const filters = [[0, 0], [60, 0], [115, -52], [98, -55], [122, -60]];
  let s1 = 0, s2 = 0, peak = 0;
  for (let at = 16; at + 16 <= adp.length; at += 16) {
    const shift = adp[at] & 15;
    const [f0, f1] = filters[adp[at] >> 4] ?? [0, 0];
    for (let k = 0; k < 28; k++) {
      const byte = adp[at + 2 + (k >> 1)];
      const nibble = k & 1 ? byte >> 4 : byte & 15;
      let s = (((nibble << 12) << 16) >> 16) >> shift;
      s = Math.max(-32768, Math.min(32767, s + ((s1 * f0 + s2 * f1) >> 6)));
      s2 = s1;
      s1 = s;
      peak = Math.max(peak, Math.abs(s));
    }
  }
  return peak;
}

Deno.test("the explosions are encoded at the browser's mix", gated, () => {
  for (const gain of Object.values(SFX_GAIN)) assert(gain > 0 && gain < 1);
  for (const key of Object.keys(SFX_GAIN)) {
    assert(sfxRequests().some((r) => r.key === key), `no such effect: ${key}`);
  }
  // The source peaks at -1.3 dBFS (0.86 of full scale), so ungained it would
  // decode near 28,200; at a quarter it is near 7,100.
  const explosion = pack!.files.find((f) =>
    f.path === `${SFX_DIR}/se_explosion.adp`
  )!;
  const peak = adpPeak(explosion.data);
  assert(peak > 0, "se_explosion decodes to silence");
  assert(
    peak <= 32767 * 0.86 * SFX_GAIN.se_explosion + 512,
    `se_explosion peaks at ${peak}, not turned down`,
  );
});
