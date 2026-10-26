import { define } from "../../utils.ts";
import { crossSiteGuard, isDeploy } from "../../lib/local-guards.ts";
import { sanitizeLevelName } from "@shmupx/shmup-harbor/export";
import {
  actionsUrl,
  dispatchInputs,
  type Env,
  GitHubActions,
  newRequestId,
  noTokenHint,
  publishConfig,
  PublishError,
  resolveToken,
  type Sleep,
  summarizeArtifacts,
  summarizeRun,
  type Token,
} from "../../lib/ios-publish.ts";

// /api/publish-ios — the editor's PUBLISH IOS BUILD.
//
// /api/build-apk builds on this machine, and for iOS that has only ever meant
// an Xcode project (a Mac with Xcode gets an unsigned .ipa). This route builds
// on a Mac GitHub lends: it dispatches .github/workflows/ios-publish.yml for
// the level, which signs and uploads to TestFlight, and then reads the run
// back for the status line. lib/ios-publish.ts is all of the thinking; this is
// its HTTP face.
//
//   POST { level, bundleId?, upload? }
//        → { ok, request, run, actionsUrl, … }   the run once GitHub lists it,
//                                                null if it has not within ~12 s
//   GET  ?run=<id>       → { ok, run, artifacts }  a run's summary
//   GET  ?request=<id>   → the same, found by the request id (or run: null)
//   GET  ?artifact=<id>  → the artifact's zip, streamed (the .ipa is inside)
//   GET                  → { ok, configured, tokenSource, repo, ref, … }
//
// LOCAL-ONLY, like every route that needs a credential this machine holds:
// the token comes from this process's environment or its `gh` login, neither
// of which the hosted origin has, and the Fetch Metadata gate keeps a
// cross-site page from spending it. A 403/404 from here is the editor's cue to
// fall back to the local export, as it does for /api/build-apk — which is why
// nothing GitHub says is ever answered with those two: a missing token is 412,
// and a refusal from GitHub is 502 with GitHub's status in the body.

export interface PublishDeps {
  env: () => Env;
  fetch: typeof fetch;
  token: (env: Env) => Promise<Token | null>;
  sleep: Sleep;
}

let deps: PublishDeps = {
  env: () => Deno.env.toObject(),
  fetch: (input, init) => fetch(input, init),
  token: (env) => resolveToken(env),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Tests swap the network and the token out; the return puts them back. */
export function setPublishDeps(next: Partial<PublishDeps>): () => void {
  const before = deps;
  deps = { ...deps, ...next };
  return () => {
    deps = before;
  };
}

function offline(): Response {
  return Response.json(
    {
      ok: false,
      error: "iOS publishing runs from a local install: it needs a GitHub " +
        "token to dispatch the Mac build with, and the website holds none.",
    },
    { status: 403 },
  );
}

function noToken(hint: string): Response {
  return Response.json(
    {
      ok: false,
      error: "No GitHub token on this machine, so nothing can dispatch the " +
        "Mac build.",
      hint,
    },
    { status: 412 },
  );
}

// GitHub's refusals come back as 502, never as their own status: the editor
// reads a 403 or 404 FROM THIS ROUTE as "no publisher on this origin" and
// falls back to the local export, and a workflow that is not on main yet
// must not look like that. The upstream status rides in the body.
function failed(e: unknown): Response {
  if (e instanceof PublishError) {
    return Response.json(
      {
        ok: false,
        error: e.message,
        github: e.status,
        ...(e.hint ? { hint: e.hint } : {}),
      },
      { status: 502 },
    );
  }
  return Response.json({ ok: false, error: (e as Error).message }, {
    status: 500,
  });
}

export const handler = define.handlers({
  async GET(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (isDeploy()) return offline();
    const env = deps.env();
    const cfg = publishConfig(env);
    const url = new URL(ctx.req.url);
    const artifact = url.searchParams.get("artifact");
    const runId = url.searchParams.get("run");
    const request = url.searchParams.get("request");

    const token = await deps.token(env);
    if (!artifact && !runId && !request) {
      return Response.json({
        ok: true,
        configured: token !== null,
        tokenSource: token?.source ?? null,
        repo: cfg.repo,
        ref: cfg.ref,
        workflow: cfg.workflow,
        actionsUrl: actionsUrl(cfg),
        ...(token ? {} : { hint: noTokenHint(cfg) }),
      });
    }
    if (!token) return noToken(noTokenHint(cfg));
    const gh = new GitHubActions({
      token: token.token,
      repo: cfg.repo,
      fetch: deps.fetch,
    });

    try {
      if (artifact) {
        const id = Number(artifact);
        if (!Number.isInteger(id) || id <= 0) {
          return Response.json({ ok: false, error: "Bad artifact id." }, {
            status: 400,
          });
        }
        const blob = await gh.downloadArtifact(id);
        return new Response(blob.body, {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="ios-ipa-${id}.zip"`,
            ...(blob.headers.get("content-length")
              ? { "content-length": blob.headers.get("content-length")! }
              : {}),
          },
        });
      }

      let run;
      if (runId) {
        const id = Number(runId);
        if (!Number.isInteger(id) || id <= 0) {
          return Response.json({ ok: false, error: "Bad run id." }, {
            status: 400,
          });
        }
        run = await gh.run(id);
      } else {
        run = await gh.findRun(cfg.workflow, request!, { attempts: 1 });
        if (!run) return Response.json({ ok: true, request, run: null });
      }
      const jobs = await gh.jobs(run.id);
      const failedJob = jobs.find((j) => j.conclusion === "failure");
      const annotations = failedJob
        ? await gh.annotations(failedJob.id).catch(() => [])
        : [];
      const summary = summarizeRun(run, jobs, annotations);
      const artifacts = run.status === "completed"
        ? summarizeArtifacts(await gh.artifacts(run.id).catch(() => []))
          .map((a) => ({ ...a, url: `/api/publish-ios?artifact=${a.id}` }))
        : [];
      return Response.json({ ok: true, run: summary, artifacts });
    } catch (e) {
      return failed(e);
    }
  },

  async POST(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (isDeploy()) return offline();

    let body: { level?: string; bundleId?: string; upload?: boolean };
    try {
      body = await ctx.req.json();
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON body." }, {
        status: 400,
      });
    }
    const level = sanitizeLevelName(String(body.level ?? ""));
    if (!level) {
      return Response.json({ ok: false, error: "Missing 'level'." }, {
        status: 400,
      });
    }
    const env = deps.env();
    const cfg = publishConfig(env);
    const token = await deps.token(env);
    if (!token) return noToken(noTokenHint(cfg));
    const gh = new GitHubActions({
      token: token.token,
      repo: cfg.repo,
      fetch: deps.fetch,
    });

    const request = newRequestId();
    const inputs = dispatchInputs({
      level,
      request,
      bundleId: typeof body.bundleId === "string" ? body.bundleId : null,
      upload: body.upload !== false,
    });
    try {
      await gh.dispatch(cfg.workflow, cfg.ref, inputs);
      // GitHub lists the run a few seconds after the 204. Wait a little here
      // so the editor usually gets a run to watch in the first answer; it
      // asks again by request id when it does not.
      const run = await gh.findRun(cfg.workflow, request, {
        attempts: 8,
        delayMs: 1500,
        sleep: deps.sleep,
      });
      return Response.json({
        ok: true,
        request,
        level,
        bundleId: inputs.bundle_id ?? null,
        repo: cfg.repo,
        ref: cfg.ref,
        actionsUrl: actionsUrl(cfg),
        run: run ? summarizeRun(run) : null,
      });
    } catch (e) {
      return failed(e);
    }
  },
});
