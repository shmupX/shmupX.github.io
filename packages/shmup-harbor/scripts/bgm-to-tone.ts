// scripts/bgm-to-tone.ts — an MP3 as a Dezaemon 2 tone-bank soundtrack.
//
//   deno task bgm:tone song.mp3 --out foo-bgm.json                  # 5 stages, sixteenth grid
//   deno task bgm:tone https://…/song.mp3 --out foo-bgm.json --stages 5
//   deno task bgm:tone song.mp3 --out foo-bgm.json --report report.md --render render.wav
//   deno task bgm:tone song.mp3 --out foo-bgm.json --grid 8          # eighths: half the resolution, twice the reach
//   deno task bgm:tone song.mp3 --out foo-bgm.json --max-slots 10
//   deno task bgm:tone song.mp3 --out foo-bgm.json --lead 16 --bass 9 --pad 30 --kick 9 --snare 40 --hat 48
//   deno task bgm:tone song.mp3 --out foo-bgm.json --parts lead,bass,drums
//   deno task bgm:tone song.mp3 --out foo-bgm.json --alias slow      # an 80/160 tie goes to 80
//
// lib/bgm-transcribe.ts listens; this prints what it heard and writes the
// level's `dezaemonBgm` (the object buildDezaemonBgm returns) beside a
// `report` of the evidence: the tempo sections, every slot's span, index and
// note counts, the chroma and onset scores against the source, the timings.
// The engineer wiring it into a level reads the summary, listens to the
// render, and PATCHes the object where the level lives.
//
// Nothing here is a byte decision: the slot layout is the engine's
// (song-write.js), and the four parts are lead / bass / pad / drums at the
// runtime's fixed gains 1 / 0.8 / 1.2 / 0.5. Instruments default to the
// survey's picks (13 saw lead, 18 synth bass, 23 strings pad; 41 sine kick
// at pitch 3, 40 pluck snare at 25, 48 noise hat at 50) and every one is a
// flag. The sixteenth grid is the default; when the song needs more than
// --max-slots at sixteenths the converter falls back to eighths and SAYS so,
// in the summary and the report — it never truncates.

import { parseArgs } from "@std/cli/parse-args";
import { dirname } from "@std/path";
import {
  DEFAULT_INSTRUMENTS,
  fmtTime,
  type InstrumentChoice,
  PART_NAMES,
  type PartName,
  type TempoOptions,
  transcribe,
  type TranscribeResult,
} from "../lib/bgm-transcribe.ts";

const USAGE =
  `usage: deno task bgm:tone <mp3 path or https URL> --out <file.json>
       [--stages 5] [--max-slots 24] [--grid 16|8]
       [--lead I --bass I --pad I --kick I --snare I --hat I]
       [--kick-pitch 3 --snare-pitch 25 --hat-pitch 50]
       [--parts lead,bass,pad,drums] [--alias onsets|slow|fast]
       [--echo 3] [--sfx-set 1] [--report <file.md>] [--render <file.wav>]
       [--no-verify] [--ffmpeg <path>]`;

const args = parseArgs(Deno.args, {
  string: [
    "out",
    "stages",
    "max-slots",
    "grid",
    "lead",
    "bass",
    "pad",
    "kick",
    "snare",
    "hat",
    "kick-pitch",
    "snare-pitch",
    "hat-pitch",
    "parts",
    "alias",
    "echo",
    "sfx-set",
    "report",
    "render",
    "ffmpeg",
  ],
  boolean: ["verify", "help"],
  default: { verify: true },
  negatable: ["verify"],
  // A misspelled flag (--stage 3) must not quietly become the default.
  unknown: (arg, key) => {
    if (key === undefined) return true; // the positional input
    console.error(`unknown flag ${arg}\n${USAGE}`);
    Deno.exit(2);
  },
});

if (args.help) {
  console.log(USAGE);
  Deno.exit(0);
}
if (args._.length !== 1 || !args.out) {
  console.error(USAGE);
  Deno.exit(2);
}
const input = String(args._[0]);
// A URL streams through ffmpeg's own HTTP input — https only, not every
// scheme ffmpeg knows (http:, ftp:, file:, concat: …).
const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]+):/.exec(input)?.[1];
if (scheme && scheme.toLowerCase() !== "https") {
  console.error(
    `input must be a local path or an https:// URL, not ${scheme}:`,
  );
  Deno.exit(2);
}

function intFlag(
  name: string,
  lo: number,
  hi: number,
  fallback: number,
): number {
  const raw = args[name as keyof typeof args];
  if (raw === undefined) return fallback;
  // Plain decimal digits: Number() would take "0x3" and "1e1".
  const v = /^\s*\d+\s*$/.test(String(raw)) ? Number(raw) : NaN;
  if (!Number.isInteger(v) || v < lo || v > hi) {
    console.error(`--${name} must be an integer ${lo}..${hi}, got ${raw}`);
    Deno.exit(2);
  }
  return v;
}

const stages = intFlag("stages", 1, 10, 5);
const maxSlots = intFlag("max-slots", 1, 24, 24);
const gridFlag = intFlag("grid", 8, 16, 16);
if (gridFlag !== 8 && gridFlag !== 16) {
  console.error("--grid must be 16 or 8");
  Deno.exit(2);
}
const grid = gridFlag as 16 | 8;
const instruments: InstrumentChoice = {
  lead: intFlag("lead", 0, 127, DEFAULT_INSTRUMENTS.lead),
  bass: intFlag("bass", 0, 127, DEFAULT_INSTRUMENTS.bass),
  pad: intFlag("pad", 0, 127, DEFAULT_INSTRUMENTS.pad),
  kick: intFlag("kick", 0, 127, DEFAULT_INSTRUMENTS.kick),
  snare: intFlag("snare", 0, 127, DEFAULT_INSTRUMENTS.snare),
  hat: intFlag("hat", 0, 127, DEFAULT_INSTRUMENTS.hat),
  kickPitch: intFlag("kick-pitch", 1, 59, DEFAULT_INSTRUMENTS.kickPitch),
  snarePitch: intFlag("snare-pitch", 1, 59, DEFAULT_INSTRUMENTS.snarePitch),
  hatPitch: intFlag("hat-pitch", 1, 59, DEFAULT_INSTRUMENTS.hatPitch),
};
const parts: PartName[] = args.parts
  ? args.parts.split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    if (!(PART_NAMES as string[]).includes(p)) {
      console.error(`--parts: unknown part "${p}" (lead, bass, pad, drums)`);
      Deno.exit(2);
    }
    return p as PartName;
  })
  : PART_NAMES;
const alias = (args.alias ?? "onsets") as TempoOptions["aliasPrefer"];
if (!["onsets", "slow", "fast"].includes(String(alias))) {
  console.error("--alias must be onsets, slow or fast");
  Deno.exit(2);
}
const echo = intFlag("echo", 0, 7, 3);
const sfxSet = intFlag("sfx-set", 1, 3, 1);

// Output directories first, so a typo is found in milliseconds rather than
// after fourteen seconds of analysis.
for (const path of [args.out, args.report, args.render]) {
  if (!path) continue;
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
  } catch (e) {
    console.error(
      `error: cannot create ${dirname(path)}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    Deno.exit(2);
  }
}

let result: TranscribeResult;
try {
  result = await transcribe(input, {
    ffmpeg: args.ffmpeg,
    stageCount: stages,
    maxSlots,
    grid,
    echo,
    sfxSet,
    instruments,
    parts,
    tempo: { aliasPrefer: alias },
    verify: args.verify,
    renderPath: args.render,
    log: (line) => console.error(`  ${line}`),
  });
} catch (e) {
  // A missing ffmpeg, an unreadable file, a dead URL: one line, not a stack.
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  Deno.exit(1);
}

// ── The summary ─────────────────────────────────────────────────────────────

const counts = (r: TranscribeResult, i: number) =>
  r.slots[i].parts.map((p) => p.length);
const pad = (s: string | number, w: number) => String(s).padStart(w);
const padR = (s: string | number, w: number) => String(s).padEnd(w);

const header = [
  padR("slot", 4),
  padR("start", 8),
  pad("src s", 6),
  pad("play s", 6),
  pad("idx", 3),
  pad("BPM", 6),
  pad("steps", 5),
  pad("lead", 5),
  pad("bass", 5),
  pad("pad", 4),
  pad("drums", 5),
  pad("chroma", 6),
  pad("onsetF", 6),
].join("  ");
const rows = result.slots.map((s, i) => {
  const [lead, bass, padN, drums] = counts(result, i);
  const score = result.verification?.slots[i];
  return [
    padR(i, 4),
    padR(fmtTime(s.startTime), 8),
    pad((s.endTime - s.startTime).toFixed(1), 6),
    pad(s.playSeconds.toFixed(1), 6),
    pad(s.tempoIndex, 3),
    pad(s.bpm.toFixed(1), 6),
    pad(Math.floor(s.stepCount / s.grid), 5),
    pad(lead, 5),
    pad(bass, 5),
    pad(padN, 4),
    pad(drums, 5),
    pad(score ? score.chroma.toFixed(3) : "-", 6),
    pad(score ? score.onsetF.toFixed(3) : "-", 6),
  ].join("  ");
});

const tempoLines = result.tempo.sections.map(
  (s) => `${fmtTime(s.start)}–${fmtTime(s.end)}  ${s.bpm.toFixed(1)} BPM`,
);
const totalSeconds = result.timings.totalMs / 1000;
const v = result.verification;

console.log(`${input}`);
console.log(
  `  ${fmtTime(result.audio.duration)} of audio, decoded peak ${
    result.audio.peak.toFixed(3)
  }; ` +
    `${result.slots.length} slot${result.slots.length === 1 ? "" : "s"} at a ${
      result.grid === 16 ? "sixteenth" : "EIGHTH"
    } grid for ${stages} stage${stages === 1 ? "" : "s"}`,
);
if (result.gridFallback) console.log(`  NOTE ${result.gridFallback}`);
for (const s of result.slots) {
  if (Math.abs(s.tempoError) > 0.05) {
    console.log(
      `  NOTE slot ${s.index} plays ${
        (Math.abs(s.tempoError) * 100).toFixed(0)
      }% ${s.tempoError > 0 ? "slower" : "faster"} than the record: its step (${
        s.sourceStepSeconds.toFixed(3)
      } s) is off the tempo table and was pinned to index ${s.tempoIndex}`,
    );
  }
}
console.log(`  tempo: ${tempoLines.join("; ")}`);
console.log(
  `  downbeat phase ${result.downbeatPhase}, ${result.beats.length} beats`,
);
console.log("");
console.log(header);
for (const r of rows) console.log(r);
console.log("");
if (v) {
  console.log(
    `  chroma cosine (per beat, source vs render): mean ${
      v.chromaMean.toFixed(3)
    }`,
  );
  console.log(
    `  onset agreement ±70 ms (lead+drum strikes vs source flux peaks): ` +
      `F ${v.onsetF.toFixed(3)}  precision ${
        v.onsetPrecision.toFixed(3)
      }  recall ${
        v.onsetRecall.toFixed(3)
      }  (${v.transcribedOnsets} transcribed, ${v.sourceOnsets} in the source)`,
  );
  console.log(
    `  the same against a 25 s rolling threshold (a quiet passage's peaks count): F ${
      v.onsetFLocal.toFixed(3)
    }  (${v.sourceOnsetsLocal} source peaks)`,
  );
}
console.log(
  `  wall clock ${totalSeconds.toFixed(1)} s (decode ${
    (result.timings.decodeMs / 1000).toFixed(1)
  }, onsets ${(result.timings.onsetMs / 1000).toFixed(1)}, pitch ${
    (result.timings.pitchMs / 1000).toFixed(1)
  }, render+verify ${
    ((result.timings.renderMs + result.timings.verifyMs) / 1000).toFixed(1)
  })`,
);

// ── The files ───────────────────────────────────────────────────────────────

const report = {
  generatedAt: new Date().toISOString(),
  source: { input, ...result.audio },
  options: {
    stages,
    maxSlots,
    gridRequested: grid,
    gridUsed: result.grid,
    instruments,
    parts,
    alias,
    echo,
    sfxSet,
  },
  gridFallback: result.gridFallback,
  tempoSections: result.tempo.sections.map((s) => ({
    start: s.start,
    end: s.end,
    bpm: s.bpm,
  })),
  beats: result.beats.length,
  downbeatPhase: result.downbeatPhase,
  slots: result.slots.map((s, i) => {
    const [lead, bass, padN, drums] = counts(result, i);
    const score = result.verification?.slots[i];
    return {
      index: i,
      startTime: s.startTime,
      endTime: s.endTime,
      sourceSeconds: s.endTime - s.startTime,
      playSeconds: s.playSeconds,
      tempoIndex: s.tempoIndex,
      bpm: s.bpm,
      stepSeconds: s.stepSeconds,
      sourceStepSeconds: s.sourceStepSeconds,
      tempoError: s.tempoError,
      songSteps: Math.floor(s.stepCount / s.grid),
      loopEnd: s.loopEnd,
      notes: { lead, bass, pad: padN, drums },
      chroma: score?.chroma ?? null,
      onsetF: score?.onsetF ?? null,
      onsetPrecision: score?.onsetPrecision ?? null,
      onsetRecall: score?.onsetRecall ?? null,
      onsetFLocal: score?.onsetFLocal ?? null,
    };
  }),
  verification: v
    ? {
      chromaMean: v.chromaMean,
      onsetF: v.onsetF,
      onsetPrecision: v.onsetPrecision,
      onsetRecall: v.onsetRecall,
      sourceOnsets: v.sourceOnsets,
      transcribedOnsets: v.transcribedOnsets,
      onsetFLocal: v.onsetFLocal,
      sourceOnsetsLocal: v.sourceOnsetsLocal,
    }
    : null,
  timings: result.timings,
};

await Deno.writeTextFile(
  args.out,
  JSON.stringify({ dezaemonBgm: result.dezaemonBgm, report }, null, 2),
);
console.log(`  wrote ${args.out}`);

if (args.report) {
  const md: string[] = [];
  md.push(`# ${input} → Dezaemon 2 tone-bank song`);
  md.push("");
  md.push(`Generated ${report.generatedAt} by \`deno task bgm:tone\`.`);
  md.push("");
  md.push("## Source");
  md.push("");
  md.push(
    `- ${fmtTime(result.audio.duration)} (${
      result.audio.duration.toFixed(1)
    } s), decoded at ${result.audio.sampleRate} Hz mono; the float decode peaked at ${
      result.audio.peak.toFixed(3)
    } and was scaled to 1.0 before analysis.`,
  );
  md.push(
    `- ${result.beats.length} beats tracked; downbeat phase ${result.downbeatPhase}.`,
  );
  md.push("");
  md.push("## Tempo path");
  md.push("");
  md.push("| from | to | BPM |");
  md.push("|---|---|---|");
  for (const s of result.tempo.sections) {
    md.push(
      `| ${fmtTime(s.start)} | ${fmtTime(s.end)} | ${s.bpm.toFixed(2)} |`,
    );
  }
  md.push("");
  md.push("## Slots");
  md.push("");
  md.push(
    `${result.slots.length} slots at a ${
      result.grid === 16 ? "sixteenth" : "eighth"
    } grid, ${stages} stages (\`stages\`/\`special\`/\`sequence\` left to buildDezaemonBgm's defaults).` +
      (result.gridFallback ? `\n\n**${result.gridFallback}**` : ""),
  );
  md.push("");
  md.push(
    "| slot | start | source s | play s | tempo idx | BPM | tempo err | song steps | loopEnd | lead | bass | pad | drums | chroma | onset F |",
  );
  md.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of report.slots) {
    md.push(
      `| ${s.index} | ${fmtTime(s.startTime)} | ${
        s.sourceSeconds.toFixed(1)
      } | ${s.playSeconds.toFixed(1)} | ${s.tempoIndex} | ${
        s.bpm.toFixed(1)
      } | ${
        (s.tempoError * 100).toFixed(1)
      }% | ${s.songSteps} | ${s.loopEnd} | ${s.notes.lead} | ${s.notes.bass} | ${s.notes.pad} | ${s.notes.drums} | ${
        s.chroma === null ? "-" : s.chroma.toFixed(3)
      } | ${s.onsetF === null ? "-" : s.onsetF.toFixed(3)} |`,
    );
  }
  md.push("");
  md.push("## Verification");
  md.push("");
  if (v) {
    md.push(
      `- Chroma: the slots were rendered offline from the bank's harmonic profiles (\`bgm-voices.json\`) at their tempo indices and compared beat by beat with the source over 100–2000 Hz. Mean cosine similarity **${
        v.chromaMean.toFixed(3)
      }** (per slot in the table).`,
    );
    md.push(
      `- Onsets: lead and drum strikes (in source time) against the source's broadband flux peaks, ±70 ms. **F ${
        v.onsetF.toFixed(3)
      }**, precision ${v.onsetPrecision.toFixed(3)}, recall ${
        v.onsetRecall.toFixed(3)
      } (${v.transcribedOnsets} transcribed strikes, ${v.sourceOnsets} source peaks).`,
    );
    md.push(
      `- The same against source peaks over a 25 s rolling threshold, which still counts a quiet passage's onsets: **F ${
        v.onsetFLocal.toFixed(3)
      }** (${v.sourceOnsetsLocal} source peaks; per slot in the \`onsetFLocal\` field of the JSON report).`,
    );
  } else {
    md.push("- Skipped (`--no-verify`).");
  }
  if (args.render) {
    md.push(`- Render: \`${args.render}\` (22.05 kHz, 16-bit mono).`);
  }
  md.push("");
  md.push("## Instruments and parts");
  md.push("");
  md.push(
    `- lead ${instruments.lead}, bass ${instruments.bass}, pad ${instruments.pad}; kick ${instruments.kick} @ pitch ${instruments.kickPitch}, snare ${instruments.snare} @ ${instruments.snarePitch}, hat ${instruments.hat} @ ${instruments.hatPitch}; parts ${
      parts.join(", ")
    }; echo ${echo}; sfxSet ${sfxSet}; octave ties broken by \`${alias}\`.`,
  );
  md.push("");
  md.push("## Timings");
  md.push("");
  const t = result.timings;
  md.push(
    `Wall clock ${(t.totalMs / 1000).toFixed(1)} s: decode ${
      (t.decodeMs / 1000).toFixed(1)
    }, onsets ${(t.onsetMs / 1000).toFixed(1)}, tempo ${
      (t.tempoMs / 1000).toFixed(1)
    }, beats ${(t.beatMs / 1000).toFixed(1)}, pitch ${
      (t.pitchMs / 1000).toFixed(1)
    }, drums ${(t.drumMs / 1000).toFixed(1)}, parts ${
      (t.assignMs / 1000).toFixed(1)
    }, encode ${(t.encodeMs / 1000).toFixed(1)}, render ${
      (t.renderMs / 1000).toFixed(1)
    }, verify ${(t.verifyMs / 1000).toFixed(1)}.`,
  );
  md.push("");
  await Deno.writeTextFile(args.report, md.join("\n"));
  console.log(`  wrote ${args.report}`);
}
