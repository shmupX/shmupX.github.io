// lib/host-device.ts decides whether the launcher is on a Lenovo Legion Go —
// and whether that Legion's controller comes apart — from the machine's DMI
// strings. The strings a real handheld reports cannot be checked here, so the
// ones Lenovo's firmware is known to write are pinned as fixtures: a wrong
// answer on the Legion Go itself would silently leave Split Controller mode
// off on the very machine it exists for, and a false positive would split a
// laptop's pad in two.

import { assertEquals } from "@std/assert";
import { classifyHost, readLinuxDmi } from "../lib/host-device.ts";

Deno.test("Legion Go: the family/version strings, the 83E1 code, and both together", () => {
  const full = classifyHost({
    vendor: "LENOVO",
    product: "83E1",
    family: "Legion Go",
    version: "Legion Go 8APU1",
  });
  assertEquals(full, { legionGo: true, detachable: true, model: "Legion Go" });
  // Firmware that fills only the version, or only the code.
  assertEquals(
    classifyHost({ vendor: "LENOVO", version: "Legion Go 8APU1" }),
    { legionGo: true, detachable: true, model: "Legion Go" },
  );
  assertEquals(
    classifyHost({ vendor: "LENOVO", product: "83E1" }),
    { legionGo: true, detachable: true, model: "Legion Go" },
  );
});

Deno.test("Legion Go S: a Legion whose controller does not come apart", () => {
  assertEquals(
    classifyHost({ vendor: "LENOVO", product: "83L3", family: "Legion Go S" }),
    { legionGo: true, detachable: false, model: "Legion Go S" },
  );
  // Words only — and "Legion Go S" must not read as a plain Legion Go.
  assertEquals(
    classifyHost({ vendor: "LENOVO", version: "Legion Go S 8ARP1" }),
    { legionGo: true, detachable: false, model: "Legion Go S" },
  );
});

Deno.test("Legion Go 2: detachable again, by code and by name", () => {
  assertEquals(
    classifyHost({ vendor: "LENOVO", product: "83N0", family: "Legion Go 2" }),
    { legionGo: true, detachable: true, model: "Legion Go 2" },
  );
  assertEquals(
    classifyHost({ vendor: "LENOVO", family: "Legion Go 2" }),
    { legionGo: true, detachable: true, model: "Legion Go 2" },
  );
});

Deno.test("anything else is not a Legion Go", () => {
  const no = { legionGo: false, detachable: false, model: null };
  assertEquals(
    classifyHost({ vendor: "Valve", product: "Jupiter", family: "Steam Deck" }),
    no,
  );
  // A Lenovo laptop of the Legion line is not a Legion Go.
  assertEquals(
    classifyHost({
      vendor: "LENOVO",
      product: "82RB",
      family: "Legion 5 15IAH7H",
      version: "Legion 5 15IAH7H",
    }),
    no,
  );
  assertEquals(classifyHost({}), no);
});

Deno.test("readLinuxDmi reads the sysfs files it finds and skips the rest", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/sys_vendor`, "LENOVO\n");
    await Deno.writeTextFile(`${dir}/product_name`, "83E1\n");
    await Deno.writeTextFile(`${dir}/product_version`, "Legion Go 8APU1\n");
    // No product_family file at all, and an empty one is the same as none.
    const dmi = await readLinuxDmi(dir);
    assertEquals(dmi, {
      vendor: "LENOVO",
      product: "83E1",
      family: undefined,
      version: "Legion Go 8APU1",
    });
    assertEquals(classifyHost(dmi).model, "Legion Go");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the words outrank the code, and the code only speaks for a Lenovo", () => {
  // Firmware whose words say Go S but whose code says Go: the words win.
  assertEquals(
    classifyHost({ vendor: "LENOVO", product: "83E1", family: "Legion Go S" }),
    { legionGo: true, detachable: false, model: "Legion Go S" },
  );
  // Words that stop at "Legion Go" with a code that knows the 2: the code
  // breaks the tie.
  assertEquals(
    classifyHost({ vendor: "LENOVO", product: "83N0", family: "Legion Go" }),
    { legionGo: true, detachable: true, model: "Legion Go 2" },
  );
  // Another vendor's product_name happening to start with a Legion code.
  assertEquals(
    classifyHost({ vendor: "Valve", product: "83E1", family: "Jupiter" }),
    { legionGo: false, detachable: false, model: null },
  );
  // No vendor at all, but the words are unambiguous.
  assertEquals(
    classifyHost({ product: "83L3", version: "Legion Go S 8ARP1" }),
    { legionGo: true, detachable: false, model: "Legion Go S" },
  );
});
