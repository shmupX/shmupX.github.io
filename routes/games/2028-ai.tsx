import { Head } from "fresh/runtime";
import { define } from "../../utils.ts";

// "2028.Ai" — a self-contained build of the 2019-es7 Phaser shooter, hosted
// inside cmg. The game scenes are shipped as one esbuild bundle
// (/games/2028-ai/game.bundle.js, built by scripts/build-2028-ai.ts). The
// level is fetched from foo.json and resolved at runtime by the level-loader
// ScenePlugin; Phaser and all assets/audio are served locally.
//
// Screen-fit + portrait lock mirror 2019-es7/phaser-game.html: the 256x480
// canvas is CSS-scaled to fill the viewport (preserving aspect), and a
// landscape viewport is rotated -90deg so the game is always presented
// portrait. The input-mapping patches keep Phaser's pointer→game coordinate
// transforms correct under that CSS scale/rotation.

import {
  AUDIO_UNLOCK,
  CHARACTERS_MODULE,
  FIT_PORTRAIT,
  FONT_PRELOAD,
  GAME_PAGE_CSS,
  LEVEL_EDITOR_BROADCAST,
  OSD_BRIDGE,
  PHASER_IMPORT_MAP,
} from "../../lib/game-page.ts";

// The inline scripts and the stylesheet live in lib/game-page.ts, which also
// renders this page standalone for the eShop's 2019 archive — one copy, read
// by both.

export default define.page(function Game2028() {
  return (
    <>
      <Head>
        <title>2028.Ai</title>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"
        />
        <meta name="theme-color" content="#000000" />
        {
          /* Declared so the browser stops probing /apple-touch-icon.png at the
             root and 404ing: with no link element it guesses that path itself.
             Same icon the dashboard uses, so a home-screen shortcut to a game
             matches a shortcut to the launcher. */
        }
        <link
          key="apple-touch"
          rel="apple-touch-icon"
          href="/app-icons/ios/icon-180.png"
        />
        <style>{GAME_PAGE_CSS}</style>
        {
          /* Lets a player scene script (and the 5velte-ph4ser build it may
             pull from esm.sh with ?external=phaser) resolve a bare
             `import Phaser from "phaser"`. Phaser ships here as a UMD global,
             so the specifier maps to a shim re-exporting globalThis.Phaser —
             pointing it at a CDN ESM build instead would give scripts a
             second, unrelated Phaser. Must precede any module script. */
        }
        <script
          type="importmap"
          dangerouslySetInnerHTML={{ __html: PHASER_IMPORT_MAP }}
        />
        <script src="/gamepad-compatibility-plugin.js"></script>
        {
          /* Leaderboard. The config is the same file tools/build-level stages
             into an exported app, so a level scores to one board wherever it is
             played. The compat SDK is deferred (never blocking the bundle) and
             firebaseScores.js waits a bounded time for it, so a slow or absent
             network costs boot time nothing and just leaves the local cache. */
        }
        <script src="/firebase-config.js"></script>
        <script
          defer
          src="https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js"
        >
        </script>
        <script
          defer
          src="https://www.gstatic.com/firebasejs/10.12.5/firebase-database-compat.js"
        >
        </script>
        <script dangerouslySetInnerHTML={{ __html: CHARACTERS_MODULE }} />
        <script dangerouslySetInnerHTML={{ __html: OSD_BRIDGE }} />
        <script dangerouslySetInnerHTML={{ __html: LEVEL_EDITOR_BROADCAST }} />
        <script dangerouslySetInnerHTML={{ __html: AUDIO_UNLOCK }} />
        <script dangerouslySetInnerHTML={{ __html: FONT_PRELOAD }} />
        <script dangerouslySetInnerHTML={{ __html: FIT_PORTRAIT }} />
      </Head>

      {
        /* Read by the level-loader plugin's custom-BGM path. Kept relative
          ("./") because the Phaser loader already has setBaseURL("/games/2028-ai/"),
          so an absolute value here would double the prefix. */
      }
      <div id="baseUrl" hidden>./</div>
      <div id="phaser-canvas"></div>

      <script src="/games/2028-ai/lib/phaser.min.js" defer></script>
      <script src="/games/2028-ai/game.bundle.js" defer></script>

      {
        /* EXTRACT MODE: save any paused sprite to the shared character
          library — rides the standalone PAUSE panel the bundle builds. */
      }
      <script src="/phaser-plugins/extract-mode.js" defer></script>

      {
        /* ONLINE 2P: the live-runs panel and the guest view. Inert unless the
          page is opened with ?online=1 — see static/phaser-plugins/netplay-lobby.js
          and the cmgNet* host half in game.bundle.js. */
      }
      <script src="/phaser-plugins/netplay-lobby.js" type="module" defer>
      </script>

      {
        /* ENGINE COMPARISON (debug): with ?debug=1 the page can play its
          level on the Saturn (Mednafen) and here at the same moment and show
          the two side by side — on this machine, or on the desktop paired
          with ?builder=CODE. Inert otherwise. */
      }
      <script src="/phaser-plugins/engine-compare.js" defer></script>
    </>
  );
});
