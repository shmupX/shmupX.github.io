// lib/ps2/runtime-patches.ts — the edits the exporter makes to the port it
// ships.
//
// main.js is @easierbycode/svelte-ps2's ps2-sp bundled for QuickJS, and a few
// things a disc needs live where runtime-entry.ts cannot reach them: inside a
// function private to one of the port's modules. Each patch here is one
// anchored edit to the bundled text, applied every time the bundle is handed
// out (buildRuntimeBundle), so the cached bundle stays the bundler's own
// output. An anchor that is not there exactly once fails the build rather
// than shipping a disc without the change: the pin moving under a patch is
// the thing to hear about. Each one belongs upstream in svelte-ps2; this is
// where it lives until it lands there.

export interface RuntimePatch {
  name: string;
  find: RegExp;
  replace: string;
}

export const RUNTIME_PATCHES: readonly RuntimePatch[] = [
  {
    // God mode. The title's L+R+START secret (runtime-entry.ts) sets
    // `state.godMode`, which the port has no notion of. Every way it hurts the
    // player — a shot, a collision, the boss timer running out — goes through
    // playerOnDamage, so one guard at its top covers them all, the way the
    // browser's playerDamage returns early on gameState.godFlg. The flinch,
    // the voice and the HP bar go with it.
    name: "god mode",
    find: /(function playerOnDamage\((\w+), \w+, \w+\) \{\r?\n)/,
    replace: "$1  if ($2.state.godMode) return;\n",
  },
];

/** `js` with every patch applied; throws when an anchor is missing. */
export function patchRuntime(js: string): string {
  let out = js;
  for (const patch of RUNTIME_PATCHES) {
    const hits = out.match(new RegExp(patch.find.source, "g"))?.length ?? 0;
    if (hits !== 1) {
      throw new Error(
        `PS2 runtime patch "${patch.name}": its anchor is in main.js ` +
          `${hits} times, not once — the @easierbycode/svelte-ps2 pin has ` +
          `moved under it (lib/ps2/runtime-patches.ts)`,
      );
    }
    out = out.replace(patch.find, patch.replace);
  }
  return out;
}
