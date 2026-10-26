#!/usr/bin/env -S deno run -A
// scripts/publish-ios.ts — the editor's PUBLISH IOS BUILD, from a terminal.
//
//   deno task publish:ios foo                        build foo on a GitHub Mac,
//                                                    sign it, upload to TestFlight
//   deno task publish:ios foo --no-upload            …sign, attach, don't upload
//   deno task publish:ios foo --bundle-id com.x.y    …as another App Store app
//   deno task publish:ios --run 1234567890           watch a run already going
//   deno task publish:ios foo --download build/ios   …and save the .ipa's zip
//
// What happens, where: .github/workflows/ios-publish.yml is dispatched on the
// repository SHMUPX_IOS_REPO names (default shmupX/shmupX.github.io) at
// SHMUPX_IOS_REF (default main), with GITHUB_TOKEN, GH_TOKEN or the GitHub
// CLI's own login. lib/ios-publish.ts is the shared half; this prints what the
// editor's status line shows, and exits 1 if the run did not end in success.

import { parseArgs } from "@std/cli/parse-args";
import { dirname, join } from "@std/path";
import {
  actionsUrl,
  dispatchInputs,
  GitHubActions,
  newRequestId,
  noTokenHint,
  publishConfig,
  PublishError,
  resolveToken,
  type RunSummary,
  summarizeArtifacts,
  summarizeRun,
} from "../lib/ios-publish.ts";

const args = parseArgs(Deno.args, {
  string: ["bundle-id", "run", "download", "repo", "ref"],
  boolean: ["upload", "watch", "help"],
  default: { upload: true, watch: true },
  negatable: ["upload", "watch"],
});

if (args.help || (!args._[0] && !args.run)) {
  console.log(
    "Usage: deno task publish:ios <level> [--bundle-id ID] [--no-upload] " +
      "[--no-watch] [--download DIR] [--repo owner/name] [--ref branch]\n" +
      "       deno task publish:ios --run <id> [--download DIR]",
  );
  Deno.exit(args.help ? 0 : 2);
}

const env = Deno.env.toObject();
if (args.repo) env.SHMUPX_IOS_REPO = args.repo;
if (args.ref) env.SHMUPX_IOS_REF = args.ref;
const cfg = publishConfig(env);

const token = await resolveToken(env);
if (!token) {
  console.error("No GitHub token. " + noTokenHint(cfg));
  Deno.exit(1);
}
console.log(`Token from ${token.source}; repository ${cfg.repo} @ ${cfg.ref}`);
const gh = new GitHubActions({ token: token.token, repo: cfg.repo });

function die(e: unknown): never {
  if (e instanceof PublishError) {
    console.error(e.message + (e.hint ? "\n  " + e.hint : ""));
  } else console.error((e as Error).message);
  Deno.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let runId: number;
if (args.run) {
  runId = Number(args.run);
  if (!Number.isInteger(runId) || runId <= 0) die(new Error("Bad --run id."));
} else {
  const level = String(args._[0]);
  const request = newRequestId();
  const inputs = dispatchInputs({
    level,
    request,
    bundleId: args["bundle-id"] ?? null,
    upload: args.upload,
  });
  console.log(
    `Dispatching ${cfg.workflow} for "${level}"` +
      (inputs.bundle_id ? ` as ${inputs.bundle_id}` : "") +
      (args.upload ? "" : ", no upload") + ` (request ${request})…`,
  );
  try {
    await gh.dispatch(cfg.workflow, cfg.ref, inputs);
  } catch (e) {
    die(e);
  }
  const run = await gh.findRun(cfg.workflow, request, {
    attempts: 20,
    delayMs: 2000,
  }).catch(die);
  if (!run) {
    console.error(
      "GitHub accepted the dispatch but listed no run for it within 40 s. " +
        `Look at ${actionsUrl(cfg)}.`,
    );
    Deno.exit(1);
  }
  runId = run.id;
  console.log(`Run ${run.id}: ${run.html_url}`);
}

if (!args.watch && !args.run) Deno.exit(0);

let last = "";
let summary: RunSummary;
for (;;) {
  let run;
  try {
    run = await gh.run(runId);
  } catch (e) {
    die(e);
  }
  const jobs = await gh.jobs(run.id).catch(() => []);
  const failedJob = jobs.find((j) => j.conclusion === "failure");
  const annotations = failedJob
    ? await gh.annotations(failedJob.id).catch(() => [])
    : [];
  summary = summarizeRun(run, jobs, annotations);
  if (summary.headline !== last) {
    console.log(`[${summary.status}] ${summary.headline}`);
    last = summary.headline;
  }
  if (summary.status === "completed") break;
  await sleep(10_000);
}

for (const line of summary.errors.slice(1)) console.log("  " + line);
if (summary.signed !== null) {
  console.log(summary.signed ? "Signed." : "Unsigned (no Apple secrets).");
}

if (args.download) {
  const artifacts = summarizeArtifacts(
    await gh.artifacts(runId).catch(() => []),
  );
  if (!artifacts.length) console.log("No artifact to download.");
  for (const a of artifacts) {
    const path = join(args.download, `${a.name}-${runId}.zip`);
    await Deno.mkdir(dirname(path), { recursive: true });
    try {
      const res = await gh.downloadArtifact(a.id);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await Deno.writeFile(path, bytes);
      console.log(`Saved ${path} (${(bytes.length / 1048576).toFixed(1)} MB)`);
    } catch (e) {
      die(e);
    }
  }
}

Deno.exit(summary.conclusion === "success" ? 0 : 1);
