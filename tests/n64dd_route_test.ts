// /api/n64dd-disk and /api/dezaemon-n64: parking a built disk for the
// Nintendo 64DD player, and the cartridge route's refusals.
//
// The disk route is driven against a temporary directory ($SHMUPX_N64DD_DIR):
// a .ddd the engine built is posted and comes back as the .ndd the player
// mounts, a bad name and a non-image are refused, the listing names what was
// parked. The cartridge route is held to what it can be here — no dump is in
// CI — which is its "local only" answer on Deploy and the shape of its
// refusal.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  diskDir,
  handler as diskHandler,
  safeDiskName,
} from "../routes/api/n64dd-disk.ts";
import { handler as romHandler } from "../routes/api/dezaemon-n64.ts";
import {
  buildDisk,
  DDD_IMAGE_BYTES,
  imageFormat,
  NDD_IMAGE_BYTES,
  readDirectory,
  readSystemArea,
  userArea,
} from "../packages/shmup-engine/src/n64/index.js";

// deno-lint-ignore no-explicit-any
type Any = any;

function ctxFor(req: Request): Any {
  return { req, url: new URL(req.url) };
}

Deno.test("a disk's file name is cut to a safe spelling and always ends in .ndd", () => {
  assertEquals(
    safeDiskName("Dezaemon 3D - Tiny game!.ndd"),
    "Dezaemon 3D - Tiny game-.ndd",
  );
  assertEquals(safeDiskName("foo.ddd"), "foo.ndd");
  assertEquals(safeDiskName("foo"), "foo.ndd");
  assertEquals(
    safeDiskName("../../etc/passwd"),
    "-..-etc-passwd.ndd",
    "no separator survives",
  );
  assertEquals(safeDiskName("  "), null);
  assertEquals(safeDiskName(42), null);
  assertEquals(safeDiskName(".ndd"), "ndd.ndd", "a bare extension gets a name");
  assertEquals(
    safeDiskName("Dezaemon 3D - 日本の級.ndd"),
    "Dezaemon 3D - 日本の級.ndd",
    "a title in another script keeps its name, so two such levels do not park as one",
  );
  assertEquals(safeDiskName("a/b\\c\u0000d.ndd"), "a-b-c-d.ndd");
});

Deno.test("a built .ddd parks as the .ndd the player mounts, and comes back by name", async () => {
  const dir = await Deno.makeTempDir({ prefix: "shmupx-n64dd-" });
  Deno.env.set("SHMUPX_N64DD_DIR", dir);
  try {
    assertEquals(await diskDir(), dir);
    const ddd = buildDisk({
      projects: [{
        name: "TINY",
        files: [{ ext: "GAM", data: new Uint8Array(0x559).fill(3) }],
      }],
      format: "ddd",
    }).image;
    const posted = await diskHandler.POST!(ctxFor(
      new Request(
        "http://localhost/api/n64dd-disk?name=Dezaemon%203D%20-%20Tiny.ddd",
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: ddd,
        },
      ),
    ));
    assertEquals(posted.status, 200);
    const body = await posted.json();
    assertEquals(body.ok, true);
    assertEquals(body.file, "Dezaemon 3D - Tiny.ndd");
    assertEquals(body.converted, true);
    assertEquals(body.bytes, NDD_IMAGE_BYTES);
    assertEquals(body.url, "/api/n64dd-disk?file=Dezaemon%203D%20-%20Tiny.ndd");
    const onDisk = await Deno.readFile(join(dir, body.file));
    assertEquals(onDisk.length, NDD_IMAGE_BYTES);
    assertEquals(imageFormat(onDisk), "ndd");
    assertEquals(readSystemArea(onDisk).errors, []);
    assertEquals(readDirectory(userArea(onDisk)).map((e) => e.name), ["TINY"]);
    // served back
    const got = await diskHandler.GET!(
      ctxFor(new Request("http://localhost" + body.url)),
    );
    assertEquals(got.status, 200);
    assertEquals(got.headers.get("content-length"), String(NDD_IMAGE_BYTES));
    const back = new Uint8Array(await got.arrayBuffer());
    assertEquals(back.length, onDisk.length);
    assert(
      back.every((b, i) => b === onDisk[i]),
      "the parked disk comes back byte for byte",
    );
    // listed
    const list = await (await diskHandler.GET!(
      ctxFor(new Request("http://localhost/api/n64dd-disk")),
    )).json();
    assertEquals(list.disks.map((d: { file: string }) => d.file), [
      "Dezaemon 3D - Tiny.ndd",
    ]);
    // refusals
    const bad = await diskHandler.POST!(
      ctxFor(
        new Request("http://localhost/api/n64dd-disk?name=x.ndd", {
          method: "POST",
          body: new Uint8Array(10),
        }),
      ),
    );
    assertEquals(bad.status, 400);
    assertStringIncludes((await bad.json()).error, String(DDD_IMAGE_BYTES));
    const noName = await diskHandler.POST!(
      ctxFor(
        new Request("http://localhost/api/n64dd-disk", {
          method: "POST",
          body: ddd,
        }),
      ),
    );
    assertEquals(noName.status, 400);
    const missing = await diskHandler.GET!(
      ctxFor(new Request("http://localhost/api/n64dd-disk?file=nope.ndd")),
    );
    assertEquals(missing.status, 404);
    const traversal = await diskHandler.GET!(
      ctxFor(
        new Request("http://localhost/api/n64dd-disk?file=..%2F..%2Fx.ndd"),
      ),
    );
    assertEquals(traversal.status, 400);
  } finally {
    Deno.env.delete("SHMUPX_N64DD_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("both routes answer 'local only' on Deploy without looking at the disk", async () => {
  Deno.env.set("DENO_DEPLOYMENT_ID", "test");
  try {
    const rom = await romHandler.GET!(
      ctxFor(new Request("http://localhost/api/dezaemon-n64")),
    );
    assertEquals(await rom.json(), { available: false, reason: "local only" });
    const romFile = await romHandler.GET!(
      ctxFor(new Request("http://localhost/api/dezaemon-n64?rom=1")),
    );
    assertEquals(romFile.status, 404);
    const disk = await diskHandler.GET!(
      ctxFor(new Request("http://localhost/api/n64dd-disk")),
    );
    assertEquals(await disk.json(), { available: false, reason: "local only" });
    const post = await diskHandler.POST!(
      ctxFor(
        new Request("http://localhost/api/n64dd-disk?name=x", {
          method: "POST",
          body: new Uint8Array(1),
        }),
      ),
    );
    assertEquals(post.status, 403);
  } finally {
    Deno.env.delete("DENO_DEPLOYMENT_ID");
  }
});

Deno.test("the cartridge route names the pair it wants when a checkout has neither", async () => {
  // This checkout has no dump and no IPL (neither is ours to ship), so the
  // route's answer is the two reasons; a checkout that has them answers
  // available: true with both URLs — that half runs only on such a machine.
  const res = await romHandler.GET!(
    ctxFor(new Request("http://localhost/api/dezaemon-n64")),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.available, "boolean");
  assert(body.patch && body.patch.url.endsWith(".xdelta"));
  if (!body.available) {
    assert(typeof body.reason === "string" && body.reason.length > 0);
  } else {
    assertEquals(body.rom.url, "/api/dezaemon-n64?rom=1");
    assertEquals(body.ipl.url, "/api/dezaemon-n64?ipl=1");
  }
});
