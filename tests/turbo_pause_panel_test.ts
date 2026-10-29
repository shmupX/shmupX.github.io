// The standalone PAUSE panel's TURBO switch.
//
// In the launcher a game runs in a frame and Turbo is a row of the launcher's
// Guide, fed by the runtime's cmg-turbo advert. Standalone — an exported app
// (the APK, a desktop build, an eShop web build) or a direct visit — there is
// no Guide, and the runtime raises its own PAUSE panel (cmgEnsurePanel in
// game.bundle.js, hand-patched), which had BGM, SFX and RESUME and no Turbo.
// Now it carries a TURBO row between the sliders and RESUME, flipping the
// same cmgSetTurbo the Guide's cmg-turbo-set reply does, and cmgSetTurbo
// shows a change made elsewhere on the switch.

import { assert, assertEquals } from "@std/assert";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

/** A top-level `function name(...) {...}` of the bundle, as source. */
function lift(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start > 0, `no function ${name} in the bundle`);
  let depth = 0;
  for (let i = js.indexOf("{", start); i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}" && --depth === 0) return js.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

// Enough of a DOM for cmgToggleRow: elements with a style, children, event
// listeners and a querySelector that finds a descendant by tag.
// deno-lint-ignore no-explicit-any
type Node = any;
function fakeDocument() {
  const createElement = (tag: string): Node => {
    const node: Node = {
      tag,
      style: { cssText: "" },
      children: [] as Node[],
      listeners: {} as Record<string, ((ev?: unknown) => void)[]>,
      textContent: "",
      type: "",
      checked: false,
    };
    node.appendChild = (c: Node) => {
      node.children.push(c);
      return c;
    };
    node.addEventListener = (t: string, f: (ev?: unknown) => void) => {
      (node.listeners[t] ??= []).push(f);
    };
    node.querySelector = (sel: string): Node | null => {
      const walk = (n: Node): Node | null => {
        for (const c of n.children) {
          if (c.tag === sel) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(node);
    };
    return node;
  };
  return { createElement };
}

Deno.test("cmgToggleRow: a labelled switch with a reading, flipped on change", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const src = lift(bundle, "cmgToggleRow");
  const cmgToggleRow = new Function(
    "document",
    `${src}; return cmgToggleRow;`,
  )(fakeDocument());
  const seen: boolean[] = [];
  const row = cmgToggleRow(
    "TURBO",
    false,
    (on: boolean) => (on ? "2X" : "1X"),
    (on: boolean) => seen.push(on),
  );
  // The row is the switch's label: a tap anywhere along it flips it.
  assertEquals(row.tag, "label");
  const [lbl, slot, val] = row.children;
  assertEquals(lbl.textContent, "TURBO");
  const input = row.querySelector("input");
  assertEquals(slot.children[0], input);
  assertEquals(input.type, "checkbox");
  assertEquals(input.checked, false);
  assertEquals(val.textContent, "1X");
  // Flipped: the handler hears the new state, the reading follows.
  input.checked = true;
  for (const f of input.listeners.change) f();
  assertEquals(seen, [true]);
  assertEquals(val.textContent, "2X");
  input.checked = false;
  for (const f of input.listeners.change) f();
  assertEquals(seen, [true, false]);
  assertEquals(val.textContent, "1X");
  // Built on: it reads so from the start.
  const on = cmgToggleRow(
    "TURBO",
    true,
    (v: boolean) => (v ? "2X" : "1X"),
    () => {},
  );
  assertEquals(on.querySelector("input").checked, true);
  assertEquals(on.children[2].textContent, "2X");
});

Deno.test("the PAUSE panel carries TURBO between the sliders and RESUME, on cmgSetTurbo", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const panel = lift(bundle, "cmgEnsurePanel");
  const sfx = panel.indexOf('cmgSliderRow("SFX", "sfx")');
  const turbo = panel.indexOf('cmgToggleRow("TURBO", cmgTimeScale !== 1,');
  const resume = panel.indexOf('btn.textContent = "RESUME"');
  assert(
    sfx > 0 && turbo > sfx && resume > turbo,
    "TURBO is not between SFX and RESUME",
  );
  assert(
    panel.includes("}, cmgSetTurbo);"),
    "the switch does not flip cmgSetTurbo",
  );
  assert(panel.includes('cmgTurboInput = turbo.querySelector("input");'));
  // Its reading: 2X on, 1X off.
  assert(panel.includes('return on ? "2X" : "1X";'));
  // And a change from elsewhere (?turbo=1, cmg-turbo-set) shows on the switch.
  const set = lift(bundle, "cmgSetTurbo");
  assert(
    set.includes(
      "if (cmgTurboInput) cmgTurboInput.checked = cmgTimeScale !== 1;",
    ),
  );
});
