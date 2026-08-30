// The PS2 sound packs: the base game's MP3s in, audsrv ADPCM and Ogg out.
//
// Gated on ffmpeg, which does both codecs — see lib/ps2/sound-pack.ts. The key
// lists are not gated: they have to keep matching the paths the ps2-sp port
// bakes into its bundle whether or not this host can encode anything.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import {
  bgmRequests,
  buildBgmPack,
  buildSfxPack,
  findFfmpeg,
  SFX_RATE,
  sfxRequests,
} from "../lib/ps2/sound-pack.ts";
import { ADPCM_BLOCK_SAMPLES } from "../lib/ps2/adpcm.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
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

Deno.test("the base game answers every request", gated, () => {
  // A key with no source is a silent effect on the console, so a drop here is
  // worth failing over rather than noting.
  assertEquals(pack!.files.length, sfxRequests().length);
});

Deno.test(
  "each effect is staged where the port will look for it",
  gated,
  () => {
    const staged = new Set(pack!.files.map((f) => f.path));
    for (const { path } of sfxRequests()) {
      const adp = path.replace(/\.[^./]*$/, "") + ".adp";
      assert(staged.has(adp), `not staged: ${adp}`);
    }
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
  // Staged as .ogg at the port's own path: unlike the effects, nothing swaps
  // an extension at runtime, because audsrv streams Ogg directly.
  assertEquals(byKey.get("adventure_bgm"), "assets/sounds/adventure_bgm.ogg");
  // In scene_continue/ in the base game, at the top of the port's tree.
  assertEquals(byKey.get("bgm_continue"), "assets/sounds/bgm_continue.ogg");
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

Deno.test("every track is a real Ogg stream", gated, () => {
  for (const file of music!.files) {
    assertEquals(
      new TextDecoder().decode(file.data.subarray(0, 4)),
      "OggS",
      file.path,
    );
    // The first page carries the Vorbis identification header, which is what
    // libVorbis on the console looks for. A container with the wrong codec
    // inside would still start "OggS".
    const head = new TextDecoder("latin1").decode(file.data.subarray(0, 128));
    assert(head.includes("vorbis"), `${file.path}: not Vorbis`);
    assert(file.data.length > 4096, `${file.path}: suspiciously short`);
  }
});

Deno.test("music is separable from the rest of the audio", gated, async () => {
  // It is most of the disc, so --no-music has to be able to drop it without
  // touching the effects.
  assertEquals(await buildBgmPack(GAME_DIR, { ffmpeg: null }), null);
  assert(pack!.files.length > 0);
});
