// The game's own audio, rendered as PS2 audio.
//
// Two packs, because audsrv plays the two kinds differently. Effects and
// voices are one-shots, which the SPU2 takes only as PS2 ADPCM (`Sound.Sfx`);
// music is streamed, which AthenaEnv decodes with the libVorbis it links, so
// it stays Ogg (`Sound.Stream`). The ADPCM encoder is ours (adpcm.ts, a
// transliteration of ps2sdk's adpenc); the MP3 decode and the Vorbis encode
// are ffmpeg's, because shipping either codec to run once at build time is not
// a trade worth making. No ffmpeg on the host means no packs and a silent
// export, exactly like a missing SNDPAC.BIN — see findFfmpeg().
//
// Output, mirroring the paths the ps2-sp port asks for:
//
//   assets/sounds/se_shoot.adp
//   assets/sounds/scene_continue/voice_countdown0.adp
//   assets/sounds/boss_sagat_bgm.ogg
//   …
//
// The port calls `loadSfx(key, "assets/sounds/<key>.wav")` and
// `loadStream(key, "assets/sounds/<key>.ogg")` with paths baked into the
// bundle, and those paths do not match the base game's own layout
// (`se_decision` lives in `ui/`, `bgm_continue` in `scene_continue/`). So the
// key lists here are the port's, the search is over the game's tree, and what
// lands on the disc is the port's path — runtime-sound.ts swaps the effects'
// extension to `.adp` and nothing else has to agree.

import { basename, dirname, extname, join, relative } from "@std/path";
import { encodeAdp, encodeWav, fitToHeadroom } from "./adpcm.ts";
import type { StageBoss, StagedFile } from "./assets.ts";
import { harborRoot } from "../repo-root.ts";

/**
 * Rate the effects are resampled to. The SPU2 tops out at 48 kHz and these are
 * short voice and impact samples that were already lossy at source, so 22.05
 * kHz costs nothing audible and halves the disc space: ADPCM is 16 bytes per
 * 28 samples, i.e. ~12.6 KB per second.
 */
export const SFX_RATE = 22_050;

/**
 * Music is streamed rather than sampled, so the SPU2 never sees it — the EE
 * feeds audsrv 4 KB at a time. Mono at the effects' rate keeps the files to
 * something a USB stick will not mind.
 */
export const BGM_RATE = 22_050;

/**
 * How much ADPCM the effects may add up to, in bytes.
 *
 * This is not a disc-space limit — it is SPU2 RAM. audsrv's IOP side packs
 * every loaded sample end to end into the SPU2's 2 MB, starting at 0x5010 and
 * never freeing any of it (ps2sdk `iop/sound/audsrv/src/adpcm.c`). The whole
 * set is 1.5 MB, which does fit — but the base address is a guess that the
 * code's own comment admits does not account for the PCM streaming space, and
 * the music streams through the same core. Leaving half the SPU2 free is
 * cheap insurance against a collision nobody would be able to debug from a
 * flickering screen.
 *
 * 85% of the set is long voice lines; the thirteen `se_*` effects that carry
 * the actual gameplay come to 225 KB. So the pack spends the budget gameplay
 * first and drops what will not fit, which keeps every sound that fires during
 * play and loses boss taunts at the margin.
 */
export const SFX_BUDGET_BYTES = 1024 * 1024;

/**
 * Effects that are encoded quieter than their source, as a gain on the PCM.
 *
 * The port fires every effect at full voice volume (`playSfx` with no volume)
 * and the browser does not: it plays the voices at 0.7 and the explosions at
 * 0.175 and 0.15, a quarter of that and less. On the console the explosion was
 * therefore the loudest thing in the game, four times the browser's balance,
 * on every kill — and a wave going down at once stacks a voice per enemy. The
 * encode was not at fault (it decodes within 0.1 dB of the source at 29 dB
 * SNR, nothing clipped); the level was. So the browser's balance is baked in:
 * its volume over the voices' 0.7, applied before encoding, which costs the
 * ADPCM nothing since every block picks its own shift.
 */
export const SFX_GAIN: Readonly<Record<string, number>> = {
  se_explosion: 0.175 / 0.7,
  se_sp_explosion: 0.15 / 0.7,
};

/** Where the effects land on the disc — one flat directory. */
export const SFX_DIR = "assets/sounds";

/** `assets/sounds/se_shoot.adp` -> `se_shoot`: the key the port asks for. */
function keyOf(path: string): string {
  return path.replace(/^.*\//, "").replace(/\.[^.]*$/, "");
}

/** Extensions worth looking for, best source first. */
const SOURCE_EXTENSIONS = [".wav", ".mp3", ".ogg"];

/**
 * Every key the ps2-sp port loads, with the path it loads it from. Kept in the
 * order and shape the port builds them so the two lists can be diffed by eye
 * against `loadAllAssets` in @easierbycode/svelte-ps2/ps2-sp.
 */
export function sfxRequests(): { key: string; path: string }[] {
  const out: { key: string; path: string }[] = [];
  const at = (key: string, dir = "") =>
    out.push({
      key,
      path: `assets/sounds/${dir}${key}.wav`,
    });

  for (
    const key of [
      "se_shoot",
      "se_shoot_b",
      "se_explosion",
      "se_damage",
      "se_guard",
      "se_sp",
      "se_sp_explosion",
      "se_barrier_start",
      "se_barrier_end",
      "se_decision",
      "se_correct",
      "se_cursor",
      "se_over",
    ]
  ) at(key);

  for (
    const key of [
      "voice_titlecall",
      "voice_fight",
      "voice_ko",
      "voice_another_fighter",
      "voice_congra",
      "voice_gameover",
      "voice_round0",
      "voice_round1",
      "voice_round2",
      "voice_round3",
      "g_damage_voice",
      "g_powerup_voice",
      "g_sp_voice",
      "g_adbenture_voice0",
      "voice_thankyou",
    ]
  ) at(key);

  for (let i = 0; i <= 9; i++) at(`voice_countdown${i}`, "scene_continue/");
  for (let i = 0; i < 3; i++) at(`g_continue_yes_voice${i}`, "scene_continue/");
  for (let i = 0; i < 2; i++) at(`g_continue_no_voice${i}`, "scene_continue/");
  for (let i = 0; i < 5; i++) at(`g_stage_voice_${i}`, "scene_game/");

  for (
    const boss of ["bison", "barlog", "sagat", "vega", "goki", "fang"]
  ) {
    at(`boss_${boss}_voice_add`);
    at(`boss_${boss}_voice_ko`);
  }
  return out;
}

/**
 * Every music key the port streams. `playBgm` loops these; `playSound` fires
 * one of them (`bgm_gameover`) as a jingle — see runtime-sound.ts.
 *
 * The port asks for `.ogg`; the disc carries `.wav`, and runtime-sound.ts
 * rewrites the extension. See encodeWavTrack() for why it is not Ogg.
 */
export function bgmRequests(): { key: string; path: string }[] {
  return [
    "adventure_bgm",
    "boss_bison_bgm",
    "boss_barlog_bgm",
    "boss_sagat_bgm",
    "boss_vega_bgm",
    "boss_goki_bgm",
    "boss_fang_bgm",
    "bgm_continue",
    "bgm_gameover",
  ].map((key) => ({ key, path: `assets/sounds/${key}.wav` }));
}

/**
 * The music every game plays whatever its stages: the interlude before each
 * stage, the continue countdown and the game-over jingle.
 */
export const SCENE_BGM = ["adventure_bgm", "bgm_continue", "bgm_gameover"];

/**
 * What a boss with no track of its own plays: the stock game's last stage's.
 *
 * The port names a stage's music after its boss, so a game's own boss —
 * gs's Daltonius — asks for `boss_Daltonius_bgm`, which nothing on the disc
 * answers, and its stage would play in silence.
 */
export const FALLBACK_BOSS_BGM = "boss_fang_bgm";

/** The music one disc carries, and what plays in place of a missing track. */
export interface BgmPlan {
  /** Every track the console can reach, in the order they are first heard. */
  keys: string[];
  /** A boss's own key -> the track it plays instead, when it has none. */
  alias: Record<string, string>;
}

/**
 * The tracks a game's stages actually play, worked out from its bosses.
 *
 * All nine of the port's tracks are 33 MB of WAV, most of a disc, and a game
 * with two stages plays five of them at most. So the disc carries the
 * scene music, plus each boss's own track when the game's sound tree has one
 * under that name (`has`), plus FALLBACK_BOSS_BGM for every boss that does
 * not. Stock bosses all have one; a level's own bosses rarely do.
 */
export function bgmPlan(
  bosses: StageBoss[],
  has: (key: string) => boolean,
): BgmPlan {
  const keys = [...SCENE_BGM];
  const alias: Record<string, string> = {};
  for (const { name } of bosses) {
    const own = `boss_${name}_bgm`;
    const plays = has(own) ? own : FALLBACK_BOSS_BGM;
    if (plays !== own) alias[own] = plays;
    if (!keys.includes(plays)) keys.push(plays);
  }
  return { keys, alias };
}

export interface SoundPack {
  /** Files to stage on the disc. */
  files: StagedFile[];
  /**
   * The keys this pack actually carries.
   *
   * Not every key the port asks for survives the IOP budget, and a key that
   * did not make it is one the console must never go looking for: cdfs answers
   * a miss with a full directory scan and a `CAN NOT FOUND` line, which costs
   * real boot time and reads like a broken disc. build.ts hands this list to
   * the runtime so a dropped effect is skipped rather than searched for — see
   * `__PS2_SFX__` in lib/ps2/runtime-sound.ts.
   */
  keys: string[];
  /**
   * Music only: a boss's own track key -> the track it plays instead (see
   * bgmPlan). build.ts hands it to runtime-sound.ts as `__PS2_BGM__`.
   */
  alias?: Record<string, string>;
  notes: string[];
}

/**
 * A pack the last build made from the same inputs, or a fresh one from
 * `make`.
 *
 * Neither pack depends on the level: both are the base game's sound tree run
 * through ffmpeg and this file's encoders, and that is most of a build's time
 * — half a minute of decoding the same sixty effects and nine tracks for a
 * disc whose only change is a sprite. So a pack is kept in `cacheDir` under a
 * key made of everything that can change it: every file in the sound tree by
 * path, size and modification time, `settings` (the effects' budget), and the
 * text of this file and adpcm.ts. Any of those moving makes a fresh pack,
 * which then replaces the kept one. The cache is beside the bundled runtime
 * and athena.elf, not in a build's own folder, because `--zip` removes that
 * folder and every level shares the one pack anyway.
 *
 * Where the encoders' source cannot be read (a packaged app carries no
 * checkout) nothing is kept and `make` runs as before.
 */
export async function cachedSoundPack(
  cacheDir: string,
  kind: "sfx" | "bgm",
  gameDir: string,
  settings: Record<string, unknown>,
  make: () => Promise<SoundPack | null>,
): Promise<{ pack: SoundPack | null; reused: boolean }> {
  const key = await soundPackKey(kind, gameDir, settings);
  if (!key) return { pack: await make(), reused: false };
  const dir = join(cacheDir, "sounds", kind);
  const manifest = join(dir, "pack.json");

  try {
    const kept = JSON.parse(await Deno.readTextFile(manifest)) as {
      key: string;
      paths: string[];
      keys: string[];
      alias?: Record<string, string>;
      notes: string[];
    };
    if (kept.key === key) {
      const files: StagedFile[] = [];
      for (const path of kept.paths) {
        files.push({ path, data: await Deno.readFile(join(dir, path)) });
      }
      return {
        pack: {
          files,
          keys: kept.keys,
          ...(kept.alias ? { alias: kept.alias } : {}),
          notes: kept.notes,
        },
        reused: true,
      };
    }
  } catch {
    // Nothing kept, or not all of it: make it again.
  }

  const pack = await make();
  // No ffmpeg makes no pack; keep nothing, so the next build tries again.
  if (!pack) return { pack, reused: false };
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  for (const file of pack.files) {
    const target = join(dir, file.path);
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.writeFile(target, file.data);
  }
  // Last, so a build stopped halfway leaves no manifest to trust.
  await Deno.writeTextFile(
    manifest,
    JSON.stringify({
      key,
      paths: pack.files.map((file) => file.path),
      keys: pack.keys,
      alias: pack.alias,
      notes: pack.notes,
    }),
  );
  return { pack, reused: false };
}

/** What a sound pack is made from, hashed; null when it cannot be known. */
async function soundPackKey(
  kind: string,
  gameDir: string,
  settings: Record<string, unknown>,
): Promise<string | null> {
  const parts: string[] = [kind, JSON.stringify(settings)];
  try {
    for (const file of ["sound-pack.ts", "adpcm.ts"]) {
      parts.push(
        await Deno.readTextFile(join(harborRoot(), "lib", "ps2", file)),
      );
    }
  } catch {
    return null;
  }
  const soundsDir = join(gameDir, "assets", "sounds");
  const listing: string[] = [];
  const walk = async (dir: string) => {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      const stat = await Deno.stat(path);
      listing.push(
        `${relative(soundsDir, path).replaceAll("\\", "/")} ${stat.size} ${
          stat.mtime?.getTime() ?? 0
        }`,
      );
    }
  };
  try {
    await walk(soundsDir);
  } catch {
    // No sound tree: the pack is empty, and that is a key like any other.
  }
  parts.push(...listing.sort());
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\n")),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * ffmpeg, or null. Looked up rather than assumed: it is a build-host tool, not
 * a dependency of this repo, and everything degrades to silence without it.
 */
export async function findFfmpeg(): Promise<string | null> {
  for (
    const candidate of ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/bin/ffmpeg"]
  ) {
    try {
      const cmd = new Deno.Command(candidate, {
        args: ["-version"],
        stdout: "null",
        stderr: "null",
      });
      if ((await cmd.output()).success) return candidate;
    } catch {
      // Not on PATH, or not executable. Try the next one.
    }
  }
  return null;
}

/**
 * Index the game's sound tree by basename. The port's paths and the game's
 * layout disagree, so the only thing they share is the file's own name.
 */
async function indexSources(
  soundsDir: string,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const rank = (path: string) => {
    const at = SOURCE_EXTENSIONS.indexOf(extname(path).toLowerCase());
    return at === -1 ? SOURCE_EXTENSIONS.length : at;
  };
  const walk = async (dir: string) => {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.includes(ext)) continue;
      const stem = basename(entry.name, extname(entry.name));
      const have = found.get(stem);
      if (have === undefined || rank(path) < rank(have)) found.set(stem, path);
    }
  };
  try {
    await walk(soundsDir);
  } catch {
    // No sound tree at all; the caller reports it as an empty pack.
  }
  return found;
}

/** Decode anything ffmpeg reads into mono s16 PCM at `rate`. */
async function decodeMono(
  ffmpeg: string,
  path: string,
  rate: number = SFX_RATE,
): Promise<Int16Array | null> {
  const cmd = new Deno.Command(ffmpeg, {
    args: [
      "-v",
      "error",
      "-i",
      path,
      "-ac",
      "1",
      "-ar",
      String(rate),
      "-f",
      "s16le",
      "-",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  if (!out.success || out.stdout.length < 2) return null;
  // ffmpeg writes native-endian s16le; every host this builds on is LE, and a
  // BE host would produce noise rather than a wrong length, so assert nothing.
  const even = out.stdout.length - (out.stdout.length % 2);
  return new Int16Array(out.stdout.buffer.slice(0, even));
}

/** `pcm` times `gain`, rounded; only ever used to turn something down. */
function scaled(pcm: Int16Array, gain: number): Int16Array {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.round(pcm[i] * gain);
  return out;
}

/**
 * Encode every effect the port asks for. Returns null when there is no ffmpeg
 * to decode with — the caller then builds silent, as it always could.
 */
export async function buildSfxPack(
  gameDir: string,
  options: { ffmpeg?: string | null; budgetBytes?: number } = {},
): Promise<SoundPack | null> {
  const ffmpeg = options.ffmpeg === undefined
    ? await findFfmpeg()
    : options.ffmpeg;
  if (!ffmpeg) return null;

  const sources = await indexSources(join(gameDir, "assets", "sounds"));
  const budget = options.budgetBytes ?? SFX_BUDGET_BYTES;
  const missing: string[] = [];
  let attenuated = 0;

  // Encode everything first, then decide what fits: the cost of a key is not
  // knowable until it has been through the encoder.
  const encoded: {
    key: string;
    path: string;
    data: Uint8Array;
    seconds: number;
  }[] = [];
  for (const { key } of sfxRequests()) {
    const source = sources.get(key);
    if (!source) {
      missing.push(key);
      continue;
    }
    const pcm = await decodeMono(ffmpeg, source);
    if (!pcm) {
      missing.push(key);
      continue;
    }
    const gain = SFX_GAIN[key] ?? 1;
    const fitted = fitToHeadroom(gain === 1 ? pcm : scaled(pcm, gain));
    if (fitted.scale !== 1) attenuated++;
    encoded.push({
      key,
      // Flat, whatever the port's own path was. Effect keys are unique, and
      // AthenaEnv's loaders null-deref rather than fail on a path cdfs cannot
      // resolve, so the fewer directory levels the disc asks a PS2 to walk the
      // better — runtime-sound.ts rewrites the port's path the same way.
      path: `${SFX_DIR}/${key}.adp`,
      data: encodeAdp(fitted.pcm, { rate: SFX_RATE }),
      seconds: pcm.length / SFX_RATE,
    });
  }

  // Gameplay first, then shortest first.
  //
  // The `se_*` effects are the ones that fire every few frames — shots, hits,
  // explosions, menu blips — and together they are only a quarter of the
  // budget, so they all go in. What is left buys as many voice lines as it
  // can, shortest first, which is why a four-second boss taunt is the thing
  // that goes. Sorting on size alone loses `se_sp_explosion` to a taunt,
  // which is the wrong trade.
  const tier = (key: string) => (key.startsWith("se_") ? 0 : 1);
  const dropped: string[] = [];
  const files: StagedFile[] = [];
  let bytes = 0;
  let seconds = 0;
  const order = [...encoded].sort((a, b) =>
    tier(a.key) - tier(b.key) || a.data.length - b.data.length
  );
  for (const item of order) {
    if (bytes + item.data.length > budget) {
      dropped.push(item.key);
      continue;
    }
    bytes += item.data.length;
    seconds += item.seconds;
    files.push({ path: item.path, data: item.data });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));

  const notes = [
    `sound effects: ${files.length} of ${sfxRequests().length} keys, ${
      seconds.toFixed(0)
    }s as ${(bytes / 1024).toFixed(0)} KB of ADPCM (IOP budget ${
      (budget / 1024).toFixed(0)
    } KB)`,
  ];
  if (dropped.length) {
    // Named in full, not the usual first-three-and-an-ellipsis: these are the
    // keys the console will play silently, and the whole list is what tells
    // you whether `--sfx-budget` is worth raising.
    notes.push(
      `sound effects: ${dropped.length} over the IOP budget and dropped — ` +
        `${dropped.join(", ")} (raise --sfx-budget to keep them)`,
    );
  }
  const quieter = Object.entries(SFX_GAIN)
    .filter(([key]) => files.some((f) => keyOf(f.path) === key));
  if (quieter.length) {
    notes.push(
      `sound effects: ${
        quieter.map(([key, gain]) =>
          `${key} ${(20 * Math.log10(gain)).toFixed(1)} dB`
        ).join(", ")
      }, to the browser's mix`,
    );
  }
  if (attenuated) {
    notes.push(
      `sound effects: ${attenuated} pulled under the SPU2 encoder's headroom`,
    );
  }
  if (missing.length) {
    notes.push(
      `sound effects: no source for ${missing.length} key(s) — ${
        missing.slice(0, 4).join(", ")
      }${missing.length > 4 ? ", …" : ""}`,
    );
  }
  return { files, keys: files.map((f) => keyOf(f.path)), notes };
}

/**
 * Render one track as the WAV AthenaEnv's streamer reads.
 *
 * NOT Ogg, though the port asks for `.ogg` and AthenaEnv links libVorbis.
 * Its `load_ogg()` returns `-ENOENT` — a pointer value of 0xFFFFFFFE — from a
 * function typed `SoundStream*` whenever `ov_open_callbacks` refuses the
 * stream, and the caller dereferences it, so an Ogg libVorbis dislikes is not
 * a silent track, it is a dead console with no way for JS to see it coming.
 * The Ogg this build could produce came from ffmpeg's own *experimental*
 * Vorbis encoder (no libvorbis in the host ffmpeg), and it crashed the game
 * the moment the adventure scene started the music. WAV has no decoder to
 * refuse it.
 *
 * `load_wav()` reads the canonical 44-byte header into its `t_wave` — which
 * is exactly that layout — and then seeks to 0x30 for the samples, four bytes
 * past the header. That looks like an off-by-four in AthenaEnv, so the file
 * opens with four bytes of silence and the seek lands on the first real
 * sample rather than clipping it.
 */
async function encodeWavTrack(
  ffmpeg: string,
  path: string,
): Promise<Uint8Array | null> {
  const pcm = await decodeMono(ffmpeg, path, BGM_RATE);
  if (!pcm) return null;
  const padded = new Int16Array(pcm.length + 2);
  padded.set(pcm, 2);
  return encodeWav(padded, BGM_RATE);
}

/**
 * Transcode the music. Separate from the effects because it is streamed, not
 * sampled: it is decoded on the EE and fed to audsrv a buffer at a time.
 *
 * `bosses` is the game's stages (StageResult.bosses), and with it only the
 * tracks those stages play are staged — see bgmPlan. Without it, every track
 * the port loads is.
 */
export async function buildBgmPack(
  gameDir: string,
  options: { ffmpeg?: string | null; bosses?: StageBoss[] } = {},
): Promise<SoundPack | null> {
  const ffmpeg = options.ffmpeg === undefined
    ? await findFfmpeg()
    : options.ffmpeg;
  if (!ffmpeg) return null;

  const sources = await indexSources(join(gameDir, "assets", "sounds"));
  const plan: BgmPlan = options.bosses
    ? bgmPlan(options.bosses, (key) => sources.has(key))
    : { keys: bgmRequests().map((r) => r.key), alias: {} };
  const files: StagedFile[] = [];
  const missing: string[] = [];
  let bytes = 0;

  for (const key of plan.keys) {
    const source = sources.get(key);
    if (!source) {
      missing.push(key);
      continue;
    }
    const wav = await encodeWavTrack(ffmpeg, source);
    if (!wav) {
      missing.push(key);
      continue;
    }
    bytes += wav.length;
    files.push({ path: `assets/sounds/${key}.wav`, data: wav });
  }

  const notes = [
    `music: ${files.length} of ${plan.keys.length} tracks, ${
      (bytes / 1048576).toFixed(1)
    } MB of ${BGM_RATE / 1000} kHz mono WAV`,
  ];
  if (options.bosses) {
    const stages = options.bosses.map(({ stage, name }) => {
      const own = `boss_${name}_bgm`;
      return `stage${stage} ${plan.alias[own] ?? own}` +
        (plan.alias[own] ? ` (${name} has no ${own})` : "");
    });
    notes.push(
      `music: ${stages.length ? stages.join(", ") : "no stage has a boss"}`,
    );
    const unplayed = bgmRequests().map((r) => r.key)
      .filter((key) => !plan.keys.includes(key));
    if (unplayed.length) {
      notes.push(
        `music: left off the disc, as no stage plays them — ${
          unplayed.join(", ")
        }`,
      );
    }
  }
  if (missing.length) {
    notes.push(`music: no source for ${missing.join(", ")}`);
  }
  return {
    files,
    keys: files.map((f) => keyOf(f.path)),
    alias: plan.alias,
    notes,
  };
}
