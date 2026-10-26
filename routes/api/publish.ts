import { define } from "../../utils.ts";
import { crossSiteGuard, isDeploy } from "../../lib/local-guards.ts";
import { sanitizeLevelName } from "@shmupx/shmup-harbor/export";
import {
  actionsUrl,
  type Env,
  GitHubActions,
  newRequestId,
  noTokenHint,
  PublishError,
  resolveToken,
  type Sleep,
  type Token,
} from "../../lib/ios-publish.ts";
import {
  credentialNote,
  isStoreId,
  type LogEntry,
  runIsLevel,
  SettingsError,
  sortLog,
  STORE_IDS,
  type StoreArtifact,
  storeArtifacts,
  storeDispatchInputs,
  type StoreId,
  storePublishConfig,
  type StoreRunSummary,
  STORES,
  type StoreSettings,
  summarizeStoreRun,
} from "../../lib/store-publish.ts";

// /api/publish — the editor's PUBLISH panel: one saved game to the stores.
//
// Every store builds on a GitHub runner (.github/workflows/<store>-publish.yml)
// and this machine only needs a token to dispatch it with; lib/store-publish.ts
// is the thinking — which workflow, which inputs, how a run reads — and this is
// its HTTP face. The iOS half is the same workflow routes/api/publish-ios.ts
// drives; this route answers for all three.
//
//   GET                       → { ok, configured, repo, ref, stores: { <id>:
//                                 { actionsUrl, cred, variables } } }
//   GET ?level=<name>         → …plus log: that game's runs, newest first
//   GET ?store=<id>&run=<id>  → { ok, run, artifacts }   a run, read back
//   GET ?store=<id>&request=<id>                          the same, found by
//                                                         request id (run: null
//                                                         while not listed)
//   GET ?store=<id>&artifact=<id>                         the artifact's zip
//   POST { level, stores: { ios?: {…}, steam?: {…}, itch?: {…} } }
//                             → { ok, level, results: { <id>: { ok, request,
//                                 run, actionsUrl } | { ok: false, error, hint } } }
//
// LOCAL-ONLY, for the reason publish-ios.ts is: the token is this process's,
// and the Fetch Metadata gate keeps a cross-site page from spending it. A
// missing token is 412; GitHub's refusals ride in a 502 so the editor never
// mistakes one for "no publisher on this origin" (a 403/404 of the route's).

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
  summaryCache.clear();
  return () => {
    deps = before;
    summaryCache.clear();
  };
}

// A completed run never changes, and reading one is three calls (jobs,
// annotations, artifacts); the log asks for a dozen at a time.
const summaryCache = new Map<
  number,
  { run: StoreRunSummary; artifacts: StoreArtifact[] }
>();

function offline(): Response {
  return Response.json(
    {
      ok: false,
      error: "Publishing runs from a local install: it needs a GitHub " +
        "token to dispatch the builds with, and the website holds none.",
    },
    { status: 403 },
  );
}

function noToken(hint: string): Response {
  return Response.json(
    {
      ok: false,
      error: "No GitHub token on this machine, so nothing can dispatch a " +
        "build.",
      hint,
    },
    { status: 412 },
  );
}

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

function client(env: Env, token: Token, store: StoreId): GitHubActions {
  return new GitHubActions({
    token: token.token,
    repo: storePublishConfig(store, env).repo,
    fetch: deps.fetch,
  });
}

function artifactUrl(store: StoreId, id: number): string {
  return `/api/publish?store=${store}&artifact=${id}`;
}

/** A run read back in full: chips, headline, artifacts — cached once done. */
async function readRun(
  gh: GitHubActions,
  store: StoreId,
  run: Awaited<ReturnType<GitHubActions["run"]>>,
  opts: { review?: boolean } = {},
): Promise<{ run: StoreRunSummary; artifacts: StoreArtifact[] }> {
  const kept = summaryCache.get(run.id);
  if (kept) return kept;
  const jobs = await gh.jobs(run.id);
  // The notices (Result, Detail) are on the job that wrote them, the
  // failures on the one that failed: read every finished job's.
  const annotations = [];
  for (const job of jobs) {
    if (job.status !== "completed") continue;
    annotations.push(...await gh.annotations(job.id).catch(() => []));
  }
  const summary = summarizeStoreRun(store, run, jobs, annotations, opts);
  const artifacts = run.status === "completed"
    ? storeArtifacts(await gh.artifacts(run.id).catch(() => []))
    : [];
  const out = { run: summary, artifacts };
  if (run.status === "completed") summaryCache.set(run.id, out);
  return out;
}

const LOG_PER_STORE = 8;

/** The game's runs across the stores, newest first, each read back. */
async function levelLog(
  env: Env,
  token: Token,
  level: string,
): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  for (const store of STORE_IDS) {
    const cfg = storePublishConfig(store, env);
    const gh = client(env, token, store);
    let runs;
    try {
      runs = await gh.listRuns(cfg.workflow, { perPage: 40 });
    } catch (e) {
      // A workflow not on the ref yet lists nothing, which is not a failure
      // of the log.
      if (e instanceof PublishError && e.status === 404) continue;
      throw e;
    }
    const mine = runs.filter((r) => runIsLevel(r, store, level)).slice(
      0,
      LOG_PER_STORE,
    );
    for (const r of mine) {
      const { run, artifacts } = await readRun(gh, store, r);
      entries.push({
        store,
        id: run.id,
        number: run.number,
        url: run.url,
        createdAt: run.createdAt,
        outcome: run.outcome,
        headline: run.headline,
        detail: run.detail,
        artifacts: artifacts.map((a) => ({
          ...a,
          url: artifactUrl(store, a.id),
        })),
      });
    }
  }
  return sortLog(entries);
}

export const handler = define.handlers({
  async GET(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (isDeploy()) return offline();
    const env = deps.env();
    const url = new URL(ctx.req.url);
    const storeParam = url.searchParams.get("store");
    const artifact = url.searchParams.get("artifact");
    const runId = url.searchParams.get("run");
    const request = url.searchParams.get("request");
    const level = sanitizeLevelName(url.searchParams.get("level") ?? "");

    const token = await deps.token(env);

    // The panel's opening read: is there a token, which store needs what.
    if (!storeParam) {
      const cfg = storePublishConfig("ios", env);
      const stores: Record<string, unknown> = {};
      let names: string[] | null = null;
      let variables: Record<string, string> | null = null;
      let log: LogEntry[] = [];
      let logError = "";
      if (token) {
        const gh = client(env, token, "ios");
        try {
          names = await gh.secretNames();
          variables = await gh.variables();
        } catch (e) {
          return failed(e);
        }
        if (level) {
          try {
            log = await levelLog(env, token, level);
          } catch (e) {
            logError = e instanceof PublishError
              ? e.message + (e.hint ? ` ${e.hint}` : "")
              : (e as Error).message;
          }
        }
      }
      for (const id of STORE_IDS) {
        const spec = STORES[id];
        const vars: Record<string, string> = {};
        for (const v of spec.variables) {
          if (variables && v in variables) vars[v] = variables[v];
        }
        stores[id] = {
          workflow: spec.workflow,
          actionsUrl: actionsUrl(storePublishConfig(id, env)),
          cred: token ? credentialNote(id, names) : null,
          variables: vars,
        };
      }
      return Response.json({
        ok: true,
        configured: token !== null,
        tokenSource: token?.source ?? null,
        repo: cfg.repo,
        ref: cfg.ref,
        secretsReadable: names !== null,
        stores,
        ...(level ? { level, log } : {}),
        ...(logError ? { logError } : {}),
        ...(token ? {} : { hint: noTokenHint(cfg) }),
      });
    }

    if (!isStoreId(storeParam)) {
      return Response.json({ ok: false, error: "Unknown store." }, {
        status: 400,
      });
    }
    const store = storeParam;
    const cfg = storePublishConfig(store, env);
    if (!token) return noToken(noTokenHint(cfg));
    const gh = client(env, token, store);

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
            "content-disposition":
              `attachment; filename="${store}-publish-${id}.zip"`,
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
      } else if (request) {
        run = await gh.findRun(cfg.workflow, request, { attempts: 1 });
        if (!run) return Response.json({ ok: true, store, request, run: null });
      } else {
        return Response.json({ ok: false, error: "Name a run or a request." }, {
          status: 400,
        });
      }
      const review = url.searchParams.get("review") === "1";
      const read = await readRun(gh, store, run, { review });
      return Response.json({
        ok: true,
        store,
        run: read.run,
        artifacts: read.artifacts.map((a) => ({
          ...a,
          url: artifactUrl(store, a.id),
        })),
      });
    } catch (e) {
      return failed(e);
    }
  },

  async POST(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (isDeploy()) return offline();

    let body: { level?: string; stores?: StoreSettings };
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
    const settings = body.stores && typeof body.stores === "object"
      ? body.stores
      : {};
    const picked = STORE_IDS.filter((id) =>
      settings[id] && typeof settings[id] === "object"
    );
    if (!picked.length) {
      return Response.json({ ok: false, error: "Pick a store." }, {
        status: 400,
      });
    }
    const env = deps.env();
    const token = await deps.token(env);
    if (!token) return noToken(noTokenHint(storePublishConfig("ios", env)));

    // Each store on its own: one refusal (a workflow not on the ref yet, a
    // setting missing) must not stop the others, and the answer says which.
    const results: Record<string, unknown> = {};
    for (const store of picked) {
      const cfg = storePublishConfig(store, env);
      const gh = client(env, token, store);
      const request = newRequestId();
      let inputs: Record<string, string>;
      try {
        inputs = storeDispatchInputs(store, { level, request, settings });
      } catch (e) {
        results[store] = {
          ok: false,
          error: e instanceof SettingsError ? e.message : (e as Error).message,
        };
        continue;
      }
      try {
        await gh.dispatch(cfg.workflow, cfg.ref, inputs);
        const run = await gh.findRun(cfg.workflow, request, {
          attempts: 6,
          delayMs: 1500,
          sleep: deps.sleep,
        });
        results[store] = {
          ok: true,
          request,
          inputs,
          actionsUrl: actionsUrl(cfg),
          run: run
            ? summarizeStoreRun(store, run, [], [], {
              review: inputs.review === "true",
            })
            : null,
        };
      } catch (e) {
        results[store] = e instanceof PublishError
          ? {
            ok: false,
            error: e.message,
            github: e.status,
            ...(e.hint ? { hint: e.hint } : {}),
          }
          : { ok: false, error: (e as Error).message };
      }
    }
    return Response.json({ ok: true, level, results });
  },
});
