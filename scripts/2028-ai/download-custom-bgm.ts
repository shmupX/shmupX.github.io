// Downloads the custom BGM/voice tracks referenced by the 2028.Ai level
// (static/games/2028-ai/foo.json -> customAudioURLs) into
// static/games/2028-ai/assets/custom-bgm/ and writes a manifest mapping each
// audio key to its on-disk filename.
//
// Filenames are the first 16 hex chars of the SHA-1 of the source URL, so
// multiple keys pointing at the same URL share one file. This mirrors
// 2019-es7/scripts/download-custom-bgm.js and matches what the level-loader
// plugin expects (custom-bgm/manifest.json + custom-bgm/<file>.mp3).
//
// Wired into `deno task build` so the deployed game serves the audio locally
// instead of streaming from the remote URLs. It is intentionally non-fatal:
// any fetch/host that is unreachable is warned and skipped, and the script
// always exits 0 so it can never break the build. Run standalone with:
//   deno run -A scripts/2028-ai/download-custom-bgm.ts

const GAME_DIR = new URL("../../static/games/2028-ai/", import.meta.url);
const FOO_JSON = new URL("foo.json", GAME_DIR);
const OUT_DIR = new URL("assets/custom-bgm/", GAME_DIR);

async function sha1Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function fileExists(url: URL): Promise<boolean> {
  try {
    await Deno.stat(url);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let record: { customAudioURLs?: Record<string, string> };
  try {
    record = JSON.parse(await Deno.readTextFile(FOO_JSON));
  } catch (err) {
    console.warn(
      "[2028.Ai bgm] could not read foo.json — skipping:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  const urls = record.customAudioURLs ?? {};
  const keys = Object.keys(urls).filter((k) =>
    typeof urls[k] === "string" && urls[k]
  );
  if (keys.length === 0) {
    console.log("[2028.Ai bgm] no customAudioURLs — nothing to download.");
    return;
  }

  await Deno.mkdir(OUT_DIR, { recursive: true });

  const manifest: Record<string, string> = {};
  const urlToFile: Record<string, string> = {};
  let downloaded = 0, shared = 0, failed = 0;

  for (const key of keys) {
    const url = urls[key];
    if (urlToFile[url]) {
      manifest[key] = urlToFile[url];
      shared++;
      continue;
    }

    const filename = (await sha1Hex(url)).slice(0, 16) + ".mp3";
    const dest = new URL(filename, OUT_DIR);

    if (await fileExists(dest)) {
      manifest[key] = filename;
      urlToFile[url] = filename;
      continue;
    }

    try {
      console.log(`[2028.Ai bgm] downloading ${key} -> ${filename}`);
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await Deno.writeFile(dest, new Uint8Array(await res.arrayBuffer()));
      manifest[key] = filename;
      urlToFile[url] = filename;
      downloaded++;
    } catch (err) {
      console.warn(
        `[2028.Ai bgm]   FAILED ${key} (${url}): ${
          err instanceof Error ? err.message : err
        }`,
      );
      failed++;
    }
  }

  await Deno.writeTextFile(
    new URL("manifest.json", OUT_DIR),
    JSON.stringify(manifest, null, 2),
  );
  console.log(
    `[2028.Ai bgm] ${Object.keys(manifest).length}/${keys.length} keys -> ` +
      `${
        Object.keys(urlToFile).length
      } file(s) (${downloaded} downloaded, ${shared} shared, ${failed} failed)`,
  );
}

// Always succeed — this is a best-effort build step.
try {
  await main();
} catch (err) {
  console.warn(
    "[2028.Ai bgm] unexpected error (ignored):",
    err instanceof Error ? err.message : err,
  );
}
