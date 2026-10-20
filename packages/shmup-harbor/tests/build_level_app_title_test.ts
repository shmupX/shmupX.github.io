// What a phone calls an exported game: the record's title, not its key.
//
// tools/build-level names the app (config.xml's <name>, the launcher label
// Android shows; manifest.json; the second screen's title) after the record's
// `title` when it has one — gs's is SQUAD — and after the build name
// otherwise. The slug and the package id stay the build name's either way, so
// retitling a game that is already installed updates com.easierbycode.gs in
// place instead of installing a second app beside it. tools/build-level is
// excluded from deno's check, so this runs the Node code for real.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { harborRoot } from "../lib/repo-root.ts";

const LIB = join(harborRoot(), "tools", "build-level", "lib");

async function haveNode(): Promise<boolean> {
  try {
    return (await new Deno.Command("node", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch (_e) {
    return false;
  }
}

const nodeAvailable = await haveNode();

interface Branded {
  title: string;
  packageId: string;
  name: string | null;
  widgetId: string | null;
  manifest: { name: string; short_name: string };
}

async function brand(
  levelName: string,
  levelData: unknown,
): Promise<Branded> {
  const script = `
    const path = require("path");
    const lib = ${JSON.stringify(LIB)};
    const { appTitleFor, rebrandConfigXml, rebrandManifestJson } =
      require(path.join(lib, "rebrand.js"));
    const { packageIdFor } = require(path.join(lib, "slug.js"));
    const [levelName, levelData] = JSON.parse(process.argv[1]);
    const scaffold = path.join(lib, "..", "scaffold");
    const title = appTitleFor(levelName, levelData);
    const packageId = packageIdFor(levelName);
    const xml = rebrandConfigXml(path.join(scaffold, "config.xml"), title, packageId);
    const m = rebrandManifestJson(path.join(scaffold, "manifest.json"), title);
    const pick = (re) => (xml.match(re) || [])[1] || null;
    process.stdout.write(JSON.stringify({
      title,
      packageId,
      name: pick(/<name>([^<]*)<\\/name>/),
      widgetId: pick(/<widget\\s+id="([^"]*)"/),
      manifest: { name: m.name, short_name: m.short_name },
    }));
  `;
  const out = await new Deno.Command("node", {
    args: ["-e", script, JSON.stringify([levelName, levelData])],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

Deno.test({
  name: "a record's title names the app; its key keeps the package id",
  ignore: !nodeAvailable,
  async fn() {
    const gs = await brand("gs", { name: "gs", title: " SQUAD " });
    assertEquals(gs.title, "SQUAD");
    assertEquals(gs.name, "SQUAD");
    assertEquals(gs.manifest, { name: "SQUAD", short_name: "SQUAD" });
    assertEquals(gs.packageId, "com.easierbycode.gs");
    assertEquals(gs.widgetId, "com.easierbycode.gs");
  },
});

Deno.test({
  name: "a record with no title is called what it was built as",
  ignore: !nodeAvailable,
  async fn() {
    for (const data of [{ name: "gs" }, { name: "gs", title: "  " }, null]) {
      const b = await brand("gs", data);
      assertEquals(b.title, "gs");
      assertEquals(b.name, "gs");
      assertEquals(b.widgetId, "com.easierbycode.gs");
    }
  },
});

Deno.test({
  name: "a title is escaped into config.xml",
  ignore: !nodeAvailable,
  async fn() {
    const b = await brand("gs", { title: "R&D <2>" });
    assertEquals(b.name, "R&amp;D &lt;2&gt;");
  },
});
