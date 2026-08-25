// Phaser Global Shim — exposes the page's UMD Phaser global as an ES module.
//
// Pages that load Phaser as a classic script (lib/phaser.min.js, which assigns
// globalThis.Phaser) have no way to resolve a BARE module specifier: a player
// scene script — or a library like 5velte-ph4ser loaded from esm.sh with
// `?external=phaser` — containing `import Phaser from "phaser"` fails with
// "Failed to resolve module specifier". Such a page maps the specifier here:
//
//   <script type="importmap">
//     { "imports": { "phaser": "/phaser-plugins/phaser-global.js" } }
//   </script>
//
// Why re-export the global instead of mapping straight to a CDN ESM build:
// the UMD bundle and the ESM bundle are two independent module graphs. Mapping
// to the CDN would hand scripts a SECOND Phaser whose classes are unrelated to
// the running game's — `instanceof` checks inside the display list fail, the
// per-graph PluginCache has none of the game's registrations, and ~1.3 MB is
// parsed for a copy that never renders. Re-exporting the global keeps exactly
// one Phaser: the one the game is already running.
//
// Games whose page already import-maps "phaser" to a real ESM build (e.g. the
// standalone 2019-turbo) do NOT need this shim — there, the map already points
// at the same module instance the game itself imported.
//
// Ordering: this module reads globalThis.Phaser at evaluation time, which
// happens on the first bare-specifier import — i.e. when a scene script loads,
// long after the deferred phaser.min.js has run. It is never imported during
// page parse.

const P = globalThis.Phaser;

if (!P) {
  throw new Error(
    '[phaser-global] globalThis.Phaser is undefined — the page must load its ' +
      'Phaser build (lib/phaser.min.js) before anything imports "phaser".',
  );
}

// Namespaces + constants exposed by the UMD global, re-exported so scripts can
// also write `import { Scene, AUTO } from "phaser"` the way the real ESM build
// allows. `Math` is aliased rather than destructured so the shim body never
// shadows the JS built-in.
const PhaserMath = P.Math;

export const {
  Actions,
  Animations,
  BlendModes,
  Cache,
  Cameras,
  Class,
  Core,
  Curves,
  Data,
  Display,
  DOM,
  Events,
  Filters,
  Game,
  GameObjects,
  Geom,
  Input,
  Loader,
  Physics,
  Plugins,
  Renderer,
  Scale,
  ScaleModes,
  Scene,
  Scenes,
  Sound,
  Structs,
  Textures,
  Tilemaps,
  Time,
  TintModes,
  Tweens,
  Utils,
  VERSION,
  AUTO,
  CANVAS,
  WEBGL,
  HEADLESS,
  FOREVER,
  NONE,
  UP,
  DOWN,
  LEFT,
  RIGHT,
} = P;

export { PhaserMath as Math };

export default P;
