// Build Super Mario SP -- a Super Famicom cartridge -- and install it into
// static/games/super-mario-sp/.
//
//   deno task super-mario-sp:rom
//
// The ROM is NovaSquirrel's MIT-licensed snes-platformer-example (vendored
// under upstream/, see NOTICE.md) rethemed with mario-sp's art and carrying
// mario-sp's level 1, converted by convert/convert.py. What this script adds
// around that is the part a vendored makefile cannot do for itself:
//
//   1. STAGING. Nothing is ever built in the tree. Everything is copied into
//      build/super-mario-sp/ first, and the copy skips macOS's AppleDouble
//      `._name` sidecars. This checkout lives on an exFAT volume, where macOS
//      scatters one beside every file it touches, and upstream's makefile globs
//      with a bare $(wildcard tilesets4/*.png) -- which matches them and hands
//      a 4 KB binary blob to pilbmp2nes.py as if it were a PNG. Staging makes
//      the whole class of failure impossible instead of patching nine globs.
//
//   2. PATCHES. Four values in the engine have to change for this game. They
//      are applied as exact string replacements that FAIL if the text is not
//      found, so a future re-vendor breaks loudly here rather than silently
//      building the wrong game.
//
//   3. VERIFICATION. The linked ROM is checked against the SNES header it
//      claims -- size, map mode, title, and the checksum/complement pair --
//      before it is allowed anywhere near static/.

import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL(".", import.meta.url));
const REPO = fromFileUrl(new URL("../../", import.meta.url));
const UPSTREAM = join(ROOT, "upstream");
const OVERLAY = join(ROOT, "overlay");
const PREBUILT = join(ROOT, "audio-prebuilt");
const STAGE = join(REPO, "build", "super-mario-sp");
const GAME = join(REPO, "static", "games", "super-mario-sp");

const ROM_NAME = "super-mario-sp";
const TITLE = "SUPER MARIO SP"; // 21 bytes max, space padded by snesheader.s

// The stage is 150 blocks wide and sits at row 5 of the engine's 256x32 grid;
// convert.py owns both numbers and convert-report.md prints them.
const STAGE_BLOCKS_WIDE = 150;

/** Every file under `dir`, relative, with AppleDouble sidecars left behind. */
async function* walk(dir: string, prefix = ""): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    if (e.name.startsWith("._") || e.name === ".DS_Store") continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) yield* walk(join(dir, e.name), rel);
    else if (e.isFile) yield rel;
  }
}

async function copyTree(from: string, to: string) {
  for await (const rel of walk(from)) {
    const dest = join(to, rel);
    await Deno.mkdir(dirname(dest), { recursive: true });
    await Deno.copyFile(join(from, rel), dest);
  }
}

/** Replace `find` with `replace` in a staged file, or fail saying which. */
async function patch(rel: string, find: string, replace: string) {
  const path = join(STAGE, rel);
  const text = await Deno.readTextFile(path);
  if (!text.includes(find)) {
    throw new Error(
      `${rel} no longer contains ${
        JSON.stringify(find)
      }. The vendored engine ` +
        `changed under this patch -- re-read the file and update main.ts.`,
    );
  }
  await Deno.writeTextFile(path, text.replace(find, replace));
}

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
) {
  const p = new Deno.Command(cmd, {
    args,
    cwd,
    env: { ...Deno.env.toObject(), ...env },
  });
  const { code, stdout, stderr } = await p.output();
  if (code !== 0) {
    console.error(new TextDecoder().decode(stdout));
    console.error(new TextDecoder().decode(stderr));
    throw new Error(`${cmd} ${args.join(" ")} failed with ${code}`);
  }
  return new TextDecoder().decode(stdout);
}

/** Refuse to ship a file the SNES header does not describe. */
function verifyRom(rom: Uint8Array) {
  const problems: string[] = [];
  const h = 0xFFC0;
  if (rom.length % 32768 !== 0) {
    problems.push(`size ${rom.length} is not a multiple of 32 KB`);
  }
  const title = new TextDecoder().decode(rom.subarray(h, h + 21));
  if (title.trimEnd() !== TITLE) {
    problems.push(`header title is ${JSON.stringify(title)}`);
  }
  if ((rom[h + 0x15] & 0x0F) !== 1) {
    problems.push(`map mode $${rom[h + 0x15].toString(16)} is not HiROM`);
  }
  const complement = rom[h + 0x1c] | (rom[h + 0x1d] << 8);
  const checksum = rom[h + 0x1e] | (rom[h + 0x1f] << 8);
  if ((checksum ^ complement) !== 0xFFFF) {
    problems.push("checksum/complement pair is inconsistent");
  }
  let sum = 0;
  for (const b of rom) sum += b;
  if ((sum & 0xFFFF) !== checksum) {
    problems.push("checksum does not match the ROM's bytes");
  }
  const reset = rom[0xFFFC] | (rom[0xFFFD] << 8);
  if (reset < 0x8000) {
    problems.push(`reset vector $${reset.toString(16)} is not in ROM`);
  }
  if (problems.length) {
    throw new Error(
      "the linked ROM is not a valid SNES image:\n  " + problems.join("\n  "),
    );
  }
  return { bytes: rom.length, title: title.trimEnd(), checksum, reset };
}

async function main() {
  // 1. convert mario-sp's assets into the engine's inputs
  console.log("converting mario-sp assets…");
  console.log(
    await run("python3", [join(ROOT, "convert", "convert.py")], ROOT),
  );

  // 2. stage upstream + overlay + the committed audio
  console.log("staging…");
  await Deno.remove(STAGE, { recursive: true }).catch(() => {});
  await copyTree(UPSTREAM, STAGE);
  await copyTree(OVERLAY, STAGE);
  try {
    await copyTree(PREBUILT, STAGE);
  } catch {
    throw new Error(
      `no audio in ${PREBUILT}. Run with --rebuild-audio and a --tad-compiler ` +
        `path to regenerate it (see NOTICE.md for how that binary is built).`,
    );
  }
  await Deno.mkdir(join(STAGE, "obj", "snes"), { recursive: true });

  // 3. the four engine values this game changes
  await patch(
    "src/snesheader.s",
    `.byte "PLATFORMER EXAMPLE"`,
    `.byte "${TITLE}"`,
  );
  // Mario is 16 pixels tall; the GrafxKid character this engine shipped with is 28.
  await patch("src/global.inc", "PlayerHeight = 28*16", "PlayerHeight = 16*16");
  // The camera stopped after 15 screens of the engine's own demo level. Ours is
  // 150 blocks wide and the screen is 16 of them.
  await patch(
    "src/levelload.s",
    "lda #(15*16)*256 ; 15 screens of 16 tiles, each containing 256 subpixels",
    `lda #(${STAGE_BLOCKS_WIDE}-16)*256 ; the stage is ${STAGE_BLOCKS_WIDE} blocks wide, the screen 16`,
  );
  // Pin the camera to the top of the level. scrolling.s locks ScrollY to
  // ScrollYLimit whenever VerticalScrollEnabled is clear, and the stage is laid
  // out to fill the screen from row 0, so both go to zero.
  await patch(
    "src/levelload.s",
    "lda #(16+2)*256  ; 1 screen of 16 tiles, each containing 256 subpixels. Add 2 tiles because (224 - 256) = 32 pixels.",
    "lda #0           ; the stage is one screen tall, pinned to the top",
  );
  await patch(
    "src/levelload.s",
    "  sta PlayerHealth\n  sta VerticalScrollEnabled",
    "  sta PlayerHealth\n  stz VerticalScrollEnabled ; one screen tall: never scroll vertically",
  );
  await patch("makefile", "title = platformer-example", `title = ${ROM_NAME}`);
  // The audio is prebuilt and committed under audio-prebuilt/, so drop the
  // rules that would rebuild it. tad-compiler is a Rust binary whose own build
  // script assembles the SPC700 driver with wiz, a C++ project, and upstream
  // ships win64 binaries only -- three toolchains nobody should have to install
  // to rebuild a level. The audio project never changes for this game, so its
  // four outputs are generated once and committed, exactly the way every other
  // derived artifact in this repo is. NOTICE.md says how to regenerate them.
  await patch(
    "makefile",
    `$(srcdir)/audio_enum.inc: $(audiodir)/example-project.terrificaudio $(TAD_COMPILER)
	$(TAD_COMPILER) ca65-enums --output $@ $(audiodir)/example-project.terrificaudio

$(audiodir)/audio_common.bin: $(audiodir)/example-project.terrificaudio $(audiodir)/sound-effects.txt $(wildcard $(audiodir)/songs/*.mml) $(TAD_COMPILER)
	$(TAD_COMPILER) common --output $@ $(audiodir)/example-project.terrificaudio

$(patsubst %.mml,%.bin,$(wildcard $(audiodir)/songs/*.mml)): $(audiodir)/songs/*.mml $(TAD_COMPILER)
	$(TAD_COMPILER) song --output $@ $(audiodir)/example-project.terrificaudio $(patsubst %.bin,%.mml, $@)`,
    `# audio_enum.inc, audio_common.bin and songs/*.bin are staged in from
# tools/super-mario-sp/audio-prebuilt/ -- see main.ts.`,
  );

  // 4. build
  console.log("assembling…");
  await run("make", [`${ROM_NAME}.sfc`, "PY=python3"], STAGE);

  // 5. verify, then install
  const rom = await Deno.readFile(join(STAGE, `${ROM_NAME}.sfc`));
  const info = verifyRom(rom);
  await Deno.mkdir(GAME, { recursive: true });
  await Deno.writeFile(join(GAME, `${ROM_NAME}.sfc`), rom);
  console.log(
    `\n${ROM_NAME}.sfc  ${info.bytes.toLocaleString("en-US")} bytes  ` +
      `"${info.title}"  checksum $${info.checksum.toString(16).toUpperCase()}`,
  );
  console.log(`installed to static/games/${ROM_NAME}/`);
}

if (import.meta.main) await main();
