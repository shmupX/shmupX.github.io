/**
 * Tell each game's daily world champion: whoever holds TODAY'S BEST when the
 * UTC day ends gets a push notification (lib/daily-champion/job.ts).
 *
 *   deno task champion:run                      # dry run: who would be told, for yesterday (UTC)
 *   deno task champion:run --date 2026-10-30    # another day that has ended
 *   deno task champion:run --send               # send, and record it under shmupX/champions/sent
 *
 * The keys come from DAILY_CHAMPION_KEYS (scripts/daily-champion-keys.ts).
 * A dry run without them still lists each game's record and holder, and
 * whether that browser subscribed; with them it opens each box too. The
 * scheduled runs are .github/workflows/daily-champion.yml, at 00:07 UTC and
 * again at 04:07 for anything the first could not finish.
 *
 * It exits 1 only for trouble on our side: the database unreachable, or a
 * push service down or timing out (status "failed"). A box someone else
 * wrote, or a push service turning one subscription away, is reported.
 */

import { parseArgs } from "@std/cli/parse-args";
import { parseKeys, runDailyChampion } from "../lib/daily-champion/job.ts";

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["date", "db"],
    boolean: ["send"],
  });
  const secret = Deno.env.get("DAILY_CHAMPION_KEYS") ?? "";
  const keys = secret ? parseKeys(secret) : null;
  if (args.send && !keys) {
    console.error("--send needs DAILY_CHAMPION_KEYS in the environment");
    Deno.exit(2);
  }
  let run;
  try {
    run = await runDailyChampion({
      date: args.date,
      db: args.db,
      send: args.send,
      keys,
    });
  } catch (e) {
    console.log(`daily-champion: ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }
  const { date, results } = run;
  console.log(
    `daily world champions of ${date} (UTC)${args.send ? "" : " — dry run"}`,
  );
  for (const r of results) {
    const who = r.holder ? ` holder ${r.holder.slice(0, 8)}…` : "";
    const score = r.value ? ` ${r.value.toLocaleString("en-US")}` : "";
    // JSON keeps whatever a push service or a box said on one quoted line
    const detail = r.detail ? ` ${JSON.stringify(r.detail)}` : "";
    console.log(
      `  ${r.gameId.padEnd(24)} ${r.status.padEnd(14)}${score}${who}${detail}`,
    );
  }
  if (results.some((r) => r.status === "failed")) Deno.exit(1);
}
