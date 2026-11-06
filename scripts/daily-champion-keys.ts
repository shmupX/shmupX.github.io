/**
 * The daily world champion's two key pairs: VAPID (ECDSA P-256), which signs
 * every push the midnight job sends, and the box (ECDH P-256), which pages
 * seal a browser's push subscription to before it goes into the open
 * database (static/champion/box.js).
 *
 *   deno task champion:keys --secret-out ~/daily-champion-keys.json
 *   deno task champion:keys --check               # DAILY_CHAMPION_KEYS against config.json
 *
 * Generating writes the public halves to static/champion/config.json (commit
 * it: pages subscribe and seal with them) and the private halves, as the one
 * JSON value the job reads, to --secret-out with mode 0600 — never to the
 * terminal. That JSON is the repository secret DAILY_CHAMPION_KEYS
 * (.github/workflows/daily-champion.yml). New keys orphan every browser that
 * subscribed under the old ones until it plays a TODAY'S BEST again.
 *
 * --check reads DAILY_CHAMPION_KEYS from the environment and says whether its
 * public halves are the ones config.json carries.
 */

import { parseArgs } from "@std/cli/parse-args";
import { fromFileUrl, resolve } from "@std/path";
import { b64url } from "../static/champion/box.js";
import { rawPublicKey } from "../lib/daily-champion/web-push.ts";
import {
  CONFIG_URL,
  parseKeys,
  publicConfigFor,
} from "../lib/daily-champion/job.ts";

const SUBJECT = "https://codemonkey.games";

async function pair(algorithm: EcKeyGenParams, usages: KeyUsage[]) {
  const keys = await crypto.subtle.generateKey(algorithm, true, usages);
  return await crypto.subtle.exportKey("jwk", keys.privateKey);
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["secret-out"],
    boolean: ["check"],
  });
  if (args.check) {
    const keys = parseKeys(Deno.env.get("DAILY_CHAMPION_KEYS") ?? "");
    const config = JSON.parse(await Deno.readTextFile(CONFIG_URL));
    const want = publicConfigFor(keys);
    const ok = want.vapidPublicKey === config.vapidPublicKey &&
      want.boxPublicKey === config.boxPublicKey;
    console.log(
      ok
        ? "DAILY_CHAMPION_KEYS matches static/champion/config.json"
        : "DAILY_CHAMPION_KEYS does NOT match static/champion/config.json",
    );
    Deno.exit(ok ? 0 : 1);
  }
  const out = args["secret-out"];
  // Never into the checkout, where one `git add .` would publish them.
  const repo = fromFileUrl(new URL("..", import.meta.url));
  if (out && resolve(out).startsWith(repo)) {
    console.error(
      `--secret-out ${out} is inside the repository; put the private keys elsewhere`,
    );
    Deno.exit(2);
  }
  if (!out) {
    console.error(
      "--secret-out <file> is required (the private keys go there)",
    );
    Deno.exit(2);
  }
  const keys = {
    v: 1,
    subject: SUBJECT,
    vapid: await pair({ name: "ECDSA", namedCurve: "P-256" }, ["sign"]),
    box: await pair({ name: "ECDH", namedCurve: "P-256" }, ["deriveBits"]),
  };
  parseKeys(JSON.stringify(keys)); // the shape the job reads
  await Deno.writeTextFile(out, JSON.stringify(keys) + "\n", { mode: 0o600 });
  const config = publicConfigFor(parseKeys(JSON.stringify(keys)));
  await Deno.writeTextFile(CONFIG_URL, JSON.stringify(config, null, 2) + "\n");
  console.log(`private keys: ${out} (the DAILY_CHAMPION_KEYS secret)`);
  console.log(`public keys:  static/champion/config.json`);
  console.log(
    `vapid ${config.vapidPublicKey.slice(0, 16)}… box ${
      b64url(rawPublicKey(keys.box)).slice(0, 16)
    }…`,
  );
}
