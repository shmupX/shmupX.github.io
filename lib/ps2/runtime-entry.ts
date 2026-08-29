// The script that runs on the console.
//
// `deno task build:ps2` bundles this file — and everything it imports — into a
// single main.js next to athena.elf, which AthenaEnv evaluates as a module on
// boot. 5velte-ps2 supplies both halves: `native` wraps AthenaEnv's own
// globals in the runtime interface, and `ps2-sp` is the vertical shooter
// itself, so the only thing this file decides is where the exported level's
// three files live on the disc. Nothing here runs under Deno — it is compiled
// for QuickJS, which is the JavaScript engine inside athena.elf.

import {
  createNativeRuntime,
  runNativeLoop,
} from "@easierbycode/svelte-ps2/native";
import { createGame } from "@easierbycode/svelte-ps2/ps2-sp";

const runtime = createNativeRuntime();

createGame(runtime, {
  // Paths are relative to the boot directory: `cdfs:/` on a disc, the app's
  // own folder on a USB stick. lib/ps2/build.ts writes exactly these three.
  level: {
    dataPath: "assets/level.json",
    atlasPngPath: "assets/level_atlas.png",
    atlasJsonPath: "assets/level_atlas.json",
  },
});

runNativeLoop(runtime);
