// End to end: one .sav through tools/sav-profiler — Mednafen and the shmupX
// runtime started on the same Start press, five seconds recorded from both
// starting 44 s in, and the runtime's own samples checked for the effect the
// window is expected to hold: an object drawn off unity scale AND under full
// alpha, the runtime's rendering of a Dezaemon scale channel riding down from
// large (an object falling in from above).
//
// This needs the display, the Accessibility grant, Mednafen with the BIOS,
// the disc image, Chrome and ffmpeg, and takes a minute (plus ~90 s the first
// time a save is armed), so it runs only when asked:
//
//   SAV_PROFILER_E2E=1 SAV_PROFILER_SAV="dev-fixtures/Dez 2 - X.sav" \
//     deno test -A tests/sav_profiler_e2e_test.ts
//
// SAV_PROFILER_FROM / SAV_PROFILER_FOR move the window (default 44 / 5).

import { assert } from "@std/assert";
import { join } from "@std/path";
import { defaults, profile } from "../tools/sav-profiler/main.ts";

const enabled = Deno.env.get("SAV_PROFILER_E2E") === "1";
const sav = Deno.env.get("SAV_PROFILER_SAV") ?? "";
const from = Number(Deno.env.get("SAV_PROFILER_FROM") ?? 44);
const len = Number(Deno.env.get("SAV_PROFILER_FOR") ?? 5);

Deno.test({
  name: `sav-profiler: ${sav || "(set SAV_PROFILER_SAV)"} at ${from}s..${
    from + len
  }s shows a zoomed object with its drop shadow on both sides`,
  ignore: !enabled || !sav,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const lines: string[] = [];
    const r = await profile({
      ...defaults(),
      sav,
      from,
      len,
      fps: 10,
      log: (line) => {
        lines.push(line);
        console.log(line);
      },
    });

    // Both recordings covered the window.
    assert(r.t0 !== null, "no Start press was made");
    assert(
      r.saturnStartSec !== null,
      "the Start press was not found in the Saturn recording",
    );
    assert(
      r.saturnFrames.length >= len * 10 - 1,
      `only ${r.saturnFrames.length} Saturn frames in the window`,
    );
    assert(
      r.webFrames.length >= len * 10,
      `only ${r.webFrames.length} web frames in the window`,
    );
    assert(
      r.gameStartedAfterMs !== null && r.gameStartedAfterMs < from * 1000,
      "the runtime never started the level before the window",
    );
    // The intro-card skip for imported carts: gameplay inside two seconds of
    // Start, as on the Saturn, not 2028.Ai's 3.7 s.
    assert(
      r.gameStartedAfterMs < 2000,
      `runtime gameplay began ${r.gameStartedAfterMs} ms after Start`,
    );

    // The effect: something drawn off unity scale inside the window, with
    // the Saturn's drop-shadow pass under it — the translucent (alpha 0.5)
    // shadow the zoom throws away from the object and pulls back as it
    // lands. That pair is the "falling from above" look.
    const zoomed = r.sightings.filter((s) =>
      s.scaleMax > 1.01 || s.scaleMin < 0.99
    );
    assert(
      zoomed.length > 0,
      `no enemy was drawn off unity scale in ${from}s..${
        from + len
      }s; sightings: ${JSON.stringify(r.sightings)}`,
    );
    const shadowed = zoomed.filter((s) =>
      s.shadowAlpha !== null && s.shadowAlpha < 1 &&
      s.shadowOffsetMax !== null && s.shadowOffsetMin !== null &&
      s.shadowOffsetMax > s.shadowOffsetMin + 4
    );
    assert(
      shadowed.length > 0,
      `no zoomed enemy carried a translucent shadow whose offset moved with the zoom; ${
        JSON.stringify(zoomed)
      }`,
    );
    assert(
      r.strongest !== null && r.strongest.sx !== 1,
      "the strongest sighting is not a scaled one",
    );

    // The pictures exist and are what the report points at.
    assert(r.sheet && (await Deno.stat(r.sheet)).size > 0, "no sheet.png");
    assert(r.moment && (await Deno.stat(r.moment)).size > 0, "no moment.png");
    assert(r.video && (await Deno.stat(r.video)).size > 0, "no compare.mp4");
    const report = await Deno.readTextFile(join(r.runDir, "report.md"));
    assert(
      report.includes("Strongest:"),
      "report.md names no strongest sighting",
    );
    console.log(`screenshot: ${r.moment}`);
  },
});
