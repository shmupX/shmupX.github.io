// The pure half of `deno task ps2:page`: the download / PLAY page and the
// README for one game's PlayStation 2 build, laid out after Sh'M↑ Party's
// (github.com/easierbycode/shmup-party-ps2 — index.html and README.md). The
// script (scripts/ps2-page.ts) builds the disc and the web build and writes
// these beside them.

export interface Ps2PageInput {
  /** The game's name as players see it. */
  title: string;
  /** The level the page is built from, as the build commands name it. */
  level: string;
  /** The folder under static/games/ the page lives in, e.g. "squad". */
  slug: string;
  /** File names beside the page. */
  iso: string;
  zip: string;
  /** The preview GIF beside the page, or null when there is none yet. */
  gif: string | null;
  /** Sizes in bytes, for the buttons' hints. */
  isoBytes: number;
  zipBytes: number;
  /** What the GIF shows, for its alt text and the README's caption. */
  gifCaption?: string;
}

const esc = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

/** The controls every PS2 export plays with (lib/ps2/web-build.ts's keys). */
export const CONTROLS = [
  ["Move", "D-pad / left stick", "Arrow keys"],
  ["Fire", "CROSS (the ship autofires)", "Z / Space"],
  ["Special", "TRIANGLE", "C"],
  ["Back", "CIRCLE", "X"],
  ["Pause", "START", "Enter"],
  ["Turbo", "SELECT on the title", "Shift on the title"],
  [
    "God mode",
    "Hold L1+R1 while pressing START or SELECT on the title",
    "Hold Q+E with Enter or Shift",
  ],
] as const;

/** The download / PLAY page. */
export function ps2PageHtml(p: Ps2PageInput): string {
  const title = esc(p.title);
  const gifAlt = esc(p.gifCaption ?? `${p.title} in play`);
  const rows = CONTROLS.map(([what, pad, keys]) =>
    `          <li><b>${esc(what)}:</b> ${esc(pad)} · keyboard ${
      esc(keys)
    }</li>`
  ).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title} — PlayStation 2</title>
    <meta name="description" content="${title} for PlayStation 2 — download the ISO or the USB folder, or play the same build in the browser." />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@500;700;800&display=swap"
      rel="stylesheet"
    />
    <style>
      /* The Sh'M↑ Party PS2 page's theme — design tokens from cmg's dashboard. */
      :root {
        --green: #9cff6b;
        --green-deep: #0e6a2b;
        --yellow: #f6ff4a;
        --tile-edge: rgba(140, 255, 110, 0.55);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--green);
        font-family: 'Share Tech Mono', monospace;
        background:
          radial-gradient(ellipse 80% 60% at 38% 55%, rgba(20, 90, 40, 0.45), transparent 70%),
          radial-gradient(ellipse 60% 70% at 50% 50%, rgba(8, 40, 18, 0.85), #000 80%),
          #000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 32px 16px;
      }
      main { width: min(720px, 100%); text-align: center; }
      h1 {
        font-family: 'Orbitron', sans-serif;
        font-weight: 800;
        font-size: clamp(22px, 5vw, 38px);
        letter-spacing: 0.14em;
        margin: 0 0 4px;
        text-shadow: 0 0 14px rgba(124, 255, 79, 0.55);
      }
      .sub {
        color: rgba(220, 255, 180, 0.55);
        letter-spacing: 0.28em;
        font-size: 13px;
        margin-bottom: 24px;
      }
      .preview {
        display: block;
        width: 100%;
        height: auto;
        image-rendering: pixelated;
        border: 1px solid rgba(140, 255, 110, 0.25);
        border-radius: 8px;
        margin: 0 auto 28px;
        box-shadow: 0 0 24px rgba(124, 255, 79, 0.18);
      }
      .buttons { display: flex; flex-direction: column; gap: 14px; align-items: center; }
      .btn {
        display: inline-block;
        width: min(440px, 100%);
        padding: 16px 22px;
        border: 1px solid var(--tile-edge);
        border-radius: 8px;
        text-decoration: none;
        font-family: 'Orbitron', sans-serif;
        letter-spacing: 0.12em;
        transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
      }
      .btn .hint {
        display: block;
        font-family: 'Share Tech Mono', monospace;
        font-weight: 400;
        font-size: 11px;
        letter-spacing: 0.2em;
        margin-top: 4px;
      }
      .btn-primary {
        font-weight: 800;
        font-size: 17px;
        color: #04180a;
        background: linear-gradient(180deg, var(--green) 0%, #5fd63a 55%, var(--green-deep) 160%);
        box-shadow: 0 0 22px rgba(124, 255, 79, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.35);
      }
      .btn-primary .hint { color: rgba(4, 30, 12, 0.75); }
      .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 0 34px rgba(124, 255, 79, 0.65), inset 0 1px 0 rgba(255, 255, 255, 0.35); }
      .btn-secondary { font-weight: 700; font-size: 13px; color: var(--green); background: rgba(14, 106, 43, 0.16); }
      .btn-secondary .hint { color: rgba(220, 255, 180, 0.6); }
      .btn-secondary:hover { background: rgba(14, 106, 43, 0.34); box-shadow: 0 0 18px rgba(124, 255, 79, 0.3); }
      .howto {
        margin: 40px auto 0;
        width: min(560px, 100%);
        text-align: left;
        border: 1px solid rgba(140, 255, 110, 0.25);
        border-radius: 8px;
        padding: 18px 22px;
        background: rgba(4, 24, 10, 0.55);
      }
      .howto h2 {
        font-family: 'Orbitron', sans-serif;
        font-size: 13px;
        letter-spacing: 0.22em;
        color: var(--yellow);
        margin: 0 0 10px;
      }
      .howto li { margin: 8px 0; font-size: 13px; line-height: 1.5; color: rgba(220, 255, 180, 0.8); }
      .howto b { color: var(--green); }
      footer { margin-top: 40px; font-size: 11px; letter-spacing: 0.18em; color: rgba(220, 255, 180, 0.35); }
      footer a { color: rgba(156, 255, 107, 0.6); }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <div class="sub">PLAYSTATION 2 // ATHENAENV // SHMUPX</div>
${
    p.gif
      ? `      <img class="preview" src="./${esc(p.gif)}" alt="${gifAlt}" />\n`
      : ""
  }
      <div class="buttons">
        <a class="btn btn-primary" href="./${esc(p.iso)}" download>
          ⬇ DOWNLOAD PS2 ISO
          <span class="hint">${esc(p.iso)} · ${
    mb(p.isoBytes)
  } — PS2 / PCSX2 / Play!</span>
        </a>
        <a class="btn btn-secondary" href="./${esc(p.zip)}" download>
          ⬇ DOWNLOAD USB FOLDER
          <span class="hint">${esc(p.zip)} · ${
    mb(p.zipBytes)
  } — wLaunchELF / OPL</span>
        </a>
        <a class="btn btn-secondary" href="./play/">▶ PLAY IN BROWSER
          <span class="hint">the same main.js, on the web build of AthenaEnv</span>
        </a>
      </div>

      <div class="howto">
        <h2>HOW TO PLAY</h2>
        <ul>
          <li><b>Emulator:</b> open the ISO in PCSX2.</li>
          <li><b>Real hardware:</b> unzip the USB folder onto a stick and launch <b>athena.elf</b> from wLaunchELF or OPL, or burn the ISO to DVD-R for a softmodded console.</li>
          <li><b>Browser:</b> PLAY IN BROWSER runs the disc's own main.js — a gamepad works too.</li>
${rows}
        </ul>
      </div>

      <footer>
        BUILT WITH <a href="https://github.com/easierbycode/svelte-ps2">5VELTE-PS2</a> ·
        EXPORTED BY <a href="https://github.com/easierbycode/shmupX.github.io">SHMUPX</a>
      </footer>
    </main>
  </body>
</html>
`;
}

/** The README beside the page. */
export function ps2Readme(p: Ps2PageInput): string {
  const caption = p.gifCaption ?? `${p.title} in play`;
  const controls = CONTROLS.map(([what, pad, keys]) =>
    `- **${what}** — ${pad} (keyboard: ${keys})`
  ).join("\n");
  return `# ${p.title} — PlayStation 2

${
    p.gif
      ? `![${caption}](${p.gif})\n\n${caption}.\n\n`
      : ""
  }${p.title} is a shmupX game exported to the PlayStation 2 by
\`deno task build:ps2\`: [svelte-ps2](https://github.com/easierbycode/svelte-ps2)'s
AthenaEnv port of the shooter, with the level's own art, enemies and bosses.
**One build, three ways to play it:**

- **[⬇ ${p.iso}](${p.iso})** (${mb(p.isoBytes)}) — a bootable disc image for
  PCSX2, or a DVD-R for a softmodded console.
- **[⬇ ${p.zip}](${p.zip})** (${mb(p.zipBytes)}) — the same game as a folder
  (\`athena.elf\` + \`main.js\` + \`assets/\`) to launch from a USB stick with
  wLaunchELF or OPL.
- **[▶ Play in the browser](play/)** — the disc's own \`main.js\`, unmodified,
  on the web build of AthenaEnv (\`lib/ps2/web-host.ts\`): Phaser underneath,
  AthenaEnv's globals on top.

The download page is [index.html](index.html).

## Controls

${controls}

## Secrets

- **TURBO** — press SELECT instead of START on the title.
- **God mode** — hold L1 and R1 while pressing START (or SELECT, for both) on
  the title. A chime says it took.

## Rebuilding

\`\`\`sh
deno task ps2:page ${p.level}               # the disc, the USB folder, the web build and this page
deno task testdrive:parity ${p.level}       # the preview GIF, every target side by side
\`\`\`

Everything here is committed, the ISO, the zip and \`play/\` included: the site
is deployed from this repository, and a build output git does not carry is a
dead link on the live page.
`;
}
