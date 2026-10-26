// PUBLISH IOS BUILD has two ends that never run together: a GitHub Actions
// workflow on a Mac (.github/workflows/ios-publish.yml) and the client that
// dispatches it and reads it back (lib/ios-publish.ts, behind
// routes/api/publish-ios.ts and scripts/publish-ios.ts). They agree on the
// run's title, on the step names the summary keys off and on the inputs only
// by construction, so this pins the seams: the YAML carries what the client
// expects, a run is found by the id its title ends in, the token comes from
// where it should, GitHub's refusals turn into things to do, and the route
// refuses on Deploy, without a level, and without a token — and watches a
// dispatch against a fake GitHub otherwise.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  DEFAULT_BUNDLE_ID,
  DEFAULT_REF,
  DEFAULT_REPO,
  dispatchInputs,
  GitHubActions,
  matchesRequest,
  newRequestId,
  publishConfig,
  PublishError,
  resolveToken,
  runNameFor,
  STEP_SIGNED,
  STEP_STAGE,
  STEP_UNSIGNED,
  STEP_UPLOAD,
  summarizeArtifacts,
  summarizeRun,
  WORKFLOW_FILE,
  type WorkflowJob,
  type WorkflowRun,
  type WorkflowStep,
} from "../lib/ios-publish.ts";
import { handler, setPublishDeps } from "../routes/api/publish-ios.ts";

const WORKFLOW = await Deno.readTextFile(
  new URL(`../.github/workflows/${WORKFLOW_FILE}`, import.meta.url),
);

Deno.test("the workflow carries the names the client reads it by", () => {
  for (const name of [STEP_STAGE, STEP_SIGNED, STEP_UNSIGNED, STEP_UPLOAD]) {
    assertStringIncludes(WORKFLOW, `- name: ${name}\n`);
  }
  // The run title: "iOS · <level> · <request>", matched on the tail.
  assertStringIncludes(
    WORKFLOW,
    'run-name: "iOS · ${{ inputs.level }} · ${{ inputs.request',
  );
  // Every input a dispatch may send is declared, and the default app is the
  // one the client names in its status line.
  for (const key of ["level", "bundle_id", "upload", "request"]) {
    assertStringIncludes(WORKFLOW, `\n      ${key}:\n`);
  }
  assertStringIncludes(WORKFLOW, `id="${DEFAULT_BUNDLE_ID}"`);
  // The tool flags it leans on exist in the tool.
  const tool = Deno.readTextFileSync(
    new URL(
      "../packages/shmup-harbor/tools/build-level/index.js",
      import.meta.url,
    ),
  );
  for (const flag of ["--project-only", "--build-number"]) {
    assertStringIncludes(WORKFLOW, flag);
    assertStringIncludes(tool, `"${flag.slice(2)}"`);
  }
});

Deno.test("a run is the one dispatched when its title ends in the request id", () => {
  const id = newRequestId();
  assertEquals(id.length, 10);
  assert(/^[a-z2-9]+$/.test(id), id);
  assert(!/[01ilo]/.test(id), "no look-alike letters: " + id);
  assert(newRequestId() !== id);
  const title = runNameFor("foo", id);
  assertEquals(title, `iOS · foo · ${id}`);
  assert(matchesRequest({ display_title: title }, id));
  assert(matchesRequest({ name: title }, id));
  assert(!matchesRequest({ display_title: runNameFor("foo", "other") }, id));
  assert(!matchesRequest({ display_title: title }, ""));
  // A level whose own name ends in the id, run by hand, is not the dispatch.
  assert(
    !matchesRequest(
      { display_title: runNameFor(`foo · ${id}`, "by hand") },
      id,
    ),
  );
});

Deno.test("the token: the environment first, then the GitHub CLI, else nothing", async () => {
  const gh = (answer: string | null) => () => Promise.resolve(answer);
  assertEquals(
    await resolveToken({ GITHUB_TOKEN: " a ", GH_TOKEN: "b" }, gh("c")),
    { token: "a", source: "GITHUB_TOKEN" },
  );
  assertEquals(await resolveToken({ GH_TOKEN: "b" }, gh("c")), {
    token: "b",
    source: "GH_TOKEN",
  });
  assertEquals(await resolveToken({}, gh("c\n")), { token: "c", source: "gh" });
  assertEquals(await resolveToken({ GITHUB_TOKEN: "  " }, gh(null)), null);
});

Deno.test("publishConfig: the repository and ref, overridable for a fork or a branch", () => {
  assertEquals(publishConfig({}), {
    repo: DEFAULT_REPO,
    ref: DEFAULT_REF,
    workflow: WORKFLOW_FILE,
  });
  assertEquals(
    publishConfig({ SHMUPX_IOS_REPO: " me/fork ", SHMUPX_IOS_REF: "try-ios" }),
    { repo: "me/fork", ref: "try-ios", workflow: WORKFLOW_FILE },
  );
});

Deno.test("dispatchInputs sends strings, and only what was asked for", () => {
  assertEquals(dispatchInputs({ level: "foo", request: "abc" }), {
    level: "foo",
    request: "abc",
  });
  assertEquals(
    dispatchInputs({
      level: "foo",
      request: "abc",
      bundleId: " com.x.y ",
      upload: false,
    }),
    { level: "foo", request: "abc", bundle_id: "com.x.y", upload: "false" },
  );
  // upload: true is the workflow's default and is not spelled out.
  assertEquals(
    dispatchInputs({
      level: "foo",
      request: "abc",
      bundleId: "",
      upload: true,
    }),
    { level: "foo", request: "abc" },
  );
});

const run = (status: string, conclusion: string | null): WorkflowRun => ({
  id: 7,
  name: "ios-publish",
  display_title: "iOS · foo · abcdefghjk",
  html_url: "https://github.com/o/r/actions/runs/7",
  status,
  conclusion,
  created_at: "2026-10-25T14:30:00Z",
  updated_at: "2026-10-25T14:31:00Z",
  run_number: 3,
  event: "workflow_dispatch",
});
const job = (
  steps: Omit<WorkflowStep, "number">[],
  conclusion: string | null = null,
): WorkflowJob[] => [{
  id: 90,
  name: "ios",
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  html_url: "https://github.com/o/r/actions/runs/7/job/90",
  steps: steps.map((s, i) => ({ number: i + 1, ...s })),
}];
const done = (
  name: string,
  conclusion: string,
): Omit<WorkflowStep, "number"> => ({
  name,
  status: "completed",
  conclusion,
});

Deno.test("summarizeRun: the step it is on, whether it signed, whether Apple took it", () => {
  // Queued: nothing to say yet.
  let s = summarizeRun(run("queued", null));
  assertEquals(s.headline, "Waiting for a GitHub Mac…");
  assertEquals([s.step, s.signed, s.uploaded], [null, null, null]);

  // In progress, archiving.
  s = summarizeRun(
    run("in_progress", null),
    job([done(STEP_STAGE, "success"), {
      name: STEP_SIGNED,
      status: "in_progress",
      conclusion: null,
    }]),
  );
  assertEquals(s.step, STEP_SIGNED);
  assertEquals(s.headline, STEP_SIGNED + "…");
  assertEquals([s.signed, s.uploaded], [null, null]);
  assertEquals(s.id, 7);
  assertEquals(s.url, "https://github.com/o/r/actions/runs/7");

  // Success, uploaded.
  s = summarizeRun(
    run("completed", "success"),
    job([
      done(STEP_SIGNED, "success"),
      done(STEP_UNSIGNED, "skipped"),
      done(STEP_UPLOAD, "success"),
    ], "success"),
  );
  assertEquals([s.signed, s.uploaded], [true, true]);
  assertEquals(s.headline, "Uploaded to TestFlight.");
  assertEquals(s.step, null);

  // Success, but the repository had no Apple secrets.
  s = summarizeRun(
    run("completed", "success"),
    job([
      done(STEP_SIGNED, "skipped"),
      done(STEP_UNSIGNED, "success"),
      done(STEP_UPLOAD, "skipped"),
    ], "success"),
  );
  assertEquals([s.signed, s.uploaded], [false, false]);
  assertEquals(s.headline, "Unsigned .ipa built — nothing went to TestFlight.");

  // Signed, upload switched off.
  s = summarizeRun(
    run("completed", "success"),
    job(
      [done(STEP_SIGNED, "success"), done(STEP_UPLOAD, "skipped")],
      "success",
    ),
  );
  assertEquals([s.signed, s.uploaded], [true, false]);
  assertEquals(s.headline, "Signed .ipa built; not uploaded.");

  // Apple refused the upload, and the workflow said why.
  s = summarizeRun(
    run("completed", "failure"),
    job(
      [done(STEP_SIGNED, "success"), done(STEP_UPLOAD, "failure")],
      "failure",
    ),
    [
      {
        annotation_level: "failure",
        title: "TestFlight",
        message: "Apple refused the upload: a Developer Program agreement " +
          "needs accepting.",
      },
      { annotation_level: "warning", title: null, message: "Node 20…" },
    ],
  );
  assertEquals(s.step, STEP_UPLOAD);
  assertEquals([s.signed, s.uploaded], [true, false]);
  assertEquals(s.errors, [
    "TestFlight: Apple refused the upload: a Developer Program agreement needs accepting.",
  ]);
  assertEquals(
    s.headline,
    `Failed at "${STEP_UPLOAD}". TestFlight: Apple refused the upload: a ` +
      "Developer Program agreement needs accepting.",
  );

  // Cancelled.
  s = summarizeRun(run("completed", "cancelled"), job([], "cancelled"));
  assertEquals(s.headline, "Cancelled.");
  assertEquals(s.uploaded, false);

  assertEquals(
    summarizeArtifacts([
      {
        id: 1,
        name: "ios-ipa",
        size_in_bytes: 5,
        expired: false,
        archive_download_url: "u",
      },
      {
        id: 2,
        name: "old",
        size_in_bytes: 5,
        expired: true,
        archive_download_url: "u",
      },
    ]),
    [{ id: 1, name: "ios-ipa", size: 5 }],
  );
});

/** A GitHub that takes a dispatch and lists the run for it under the id sent. */
function fakeGitHub() {
  const calls: { url: string; init?: RequestInit }[] = [];
  let request = "";
  const runs = () =>
    Response.json({
      workflow_runs: [
        {
          ...run("completed", "success"),
          id: 5,
          display_title: "iOS · bar · zzzzzzzzzz",
        },
        {
          ...run("in_progress", null),
          id: 7,
          display_title: `iOS · foo · ${request}`,
        },
      ],
    });
  const fetchFn: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/dispatches")) {
      request = JSON.parse(String(init?.body)).inputs.request;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.includes("/runs?")) return Promise.resolve(runs());
    if (url.endsWith("/actions/runs/7")) {
      return Promise.resolve(Response.json(run("completed", "success")));
    }
    if (url.includes("/actions/runs/7/jobs")) {
      return Promise.resolve(Response.json({
        jobs: job(
          [done(STEP_SIGNED, "success"), done(STEP_UPLOAD, "success")],
          "success",
        ),
      }));
    }
    if (url.includes("/actions/runs/7/artifacts")) {
      return Promise.resolve(Response.json({
        artifacts: [{
          id: 42,
          name: "ios-ipa",
          size_in_bytes: 1048576,
          expired: false,
          archive_download_url: "x",
        }],
      }));
    }
    return Promise.resolve(
      Response.json({ message: "Not Found" }, { status: 404 }),
    );
  };
  return { calls, fetchFn, request: () => request };
}

Deno.test("GitHubActions: the dispatch, the run it started, and refusals explained", async () => {
  const gh0 = fakeGitHub();
  const gh = new GitHubActions({ token: "t", repo: "o/r", fetch: gh0.fetchFn });
  await gh.dispatch(WORKFLOW_FILE, "main", {
    level: "foo",
    request: "abcdefghjk",
  });
  assertEquals(
    gh0.calls[0].url,
    `https://api.github.com/repos/o/r/actions/workflows/${WORKFLOW_FILE}/dispatches`,
  );
  assertEquals(JSON.parse(String(gh0.calls[0].init?.body)), {
    ref: "main",
    inputs: { level: "foo", request: "abcdefghjk" },
  });
  const headers = gh0.calls[0].init?.headers as Record<string, string>;
  assertEquals(headers.authorization, "Bearer t");
  assertEquals(headers.accept, "application/vnd.github+json");

  const found = await gh.findRun(WORKFLOW_FILE, "abcdefghjk");
  assertEquals(found?.id, 7);
  assertEquals(await gh.findRun(WORKFLOW_FILE, "nothere"), null);

  const refusing = (status: number, message: string) =>
    new GitHubActions({
      token: "t",
      repo: "o/r",
      fetch: () => Promise.resolve(Response.json({ message }, { status })),
    });
  const e404 = await assertRejects(
    () => refusing(404, "Not Found").dispatch(WORKFLOW_FILE, "main", {}),
    PublishError,
  );
  assertEquals(e404.status, 404);
  assertStringIncludes(e404.hint, "push it");
  const e403 = await assertRejects(
    () =>
      refusing(403, "Resource not accessible by integration").dispatch(
        WORKFLOW_FILE,
        "main",
        {},
      ),
    PublishError,
  );
  assertEquals(e403.status, 403);
  assertStringIncludes(e403.hint, "workflow scopes");
  const e401 = await assertRejects(
    () => refusing(401, "Bad credentials").dispatch(WORKFLOW_FILE, "main", {}),
    PublishError,
  );
  assertEquals(e401.status, 401);
  const e422 = await assertRejects(
    () =>
      refusing(422, 'Unexpected inputs provided: ["colour"]').dispatch(
        WORKFLOW_FILE,
        "main",
        {},
      ),
    PublishError,
  );
  assertEquals(e422.status, 422);
  assertStringIncludes(e422.message, "colour");
});

Deno.test("downloadArtifact follows GitHub's redirect to the store without the token", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = String(input);
    const h = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, auth: h.authorization ?? null });
    if (url.includes("/artifacts/42/zip")) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://blob.example/x.zip?sig=1" },
        }),
      );
    }
    return Promise.resolve(new Response("ZIP", { status: 200 }));
  };
  const gh = new GitHubActions({ token: "t", repo: "o/r", fetch: fetchFn });
  const res = await gh.downloadArtifact(42);
  assertEquals(await res.text(), "ZIP");
  assertEquals(seen.length, 2);
  assertEquals(seen[0].auth, "Bearer t");
  assertEquals(seen[1].url, "https://blob.example/x.zip?sig=1");
  assertEquals(seen[1].auth, null);
});

// deno-lint-ignore no-explicit-any
const h = handler as any;
const post = (body: unknown) =>
  h.POST({
    req: new Request("http://localhost/api/publish-ios", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  }) as Promise<Response>;
const get = (query = "") =>
  h.GET({
    req: new Request("http://localhost/api/publish-ios" + query),
  }) as Promise<Response>;

Deno.test("the route refuses on Deploy, without a level, and without a token", async () => {
  Deno.env.set("DENO_DEPLOYMENT_ID", "x");
  try {
    assertEquals((await post({ level: "foo" })).status, 403);
    assertEquals((await get()).status, 403);
  } finally {
    Deno.env.delete("DENO_DEPLOYMENT_ID");
  }

  const restore = setPublishDeps({
    env: () => ({}),
    token: () => Promise.resolve(null),
    fetch: () => Promise.reject(new Error("no network expected")),
    sleep: () => Promise.resolve(),
  });
  try {
    let res = await post("not json");
    assertEquals(res.status, 400);
    res = await post({});
    assertEquals(res.status, 400);
    res = await post({ level: "foo" });
    assertEquals(res.status, 412);
    const body = await res.json();
    assertStringIncludes(body.hint, "gh auth login");
    // The status readout says so too, without a token being an error there.
    res = await get();
    assertEquals(res.status, 200);
    const status = await res.json();
    assertEquals(status.configured, false);
    assertEquals(status.repo, DEFAULT_REPO);
    assertStringIncludes(status.hint, "GITHUB_TOKEN");
    // A cross-site page is not a caller.
    res = await h.POST({
      req: new Request("http://localhost/api/publish-ios", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
        body: "{}",
      }),
    });
    assertEquals(res.status, 403);
  } finally {
    restore();
  }
});

Deno.test("GitHub's refusals come back as 502, never as a 403/404 of the route's own", async () => {
  // The editor falls back to the local export on a 403 or 404 FROM THE ROUTE
  // (no publisher on this origin). A workflow that is not on main yet is
  // GitHub's 404, and must reach the status line as the thing to fix instead.
  const restore = setPublishDeps({
    env: () => ({}),
    token: () => Promise.resolve({ token: "t", source: "GH_TOKEN" }),
    fetch: () =>
      Promise.resolve(Response.json({ message: "Not Found" }, { status: 404 })),
    sleep: () => Promise.resolve(),
  });
  try {
    const res = await post({ level: "foo" });
    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.github, 404);
    assertStringIncludes(body.error, WORKFLOW_FILE);
    assertStringIncludes(body.hint, "push it");
    assertEquals((await get("?run=7")).status, 502);
  } finally {
    restore();
  }
});

Deno.test("the route dispatches, finds the run, and reads it back with its artifact", async () => {
  const gh0 = fakeGitHub();
  const restore = setPublishDeps({
    env: () => ({ SHMUPX_IOS_REPO: "o/r", SHMUPX_IOS_REF: "try-ios" }),
    token: () => Promise.resolve({ token: "t", source: "GITHUB_TOKEN" }),
    fetch: gh0.fetchFn,
    sleep: () => Promise.resolve(),
  });
  try {
    const res = await post({ level: " foo ", bundleId: "com.x.y" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    assertEquals(body.level, "foo");
    assertEquals(body.request, gh0.request());
    assertEquals(body.bundleId, "com.x.y");
    assertEquals(body.ref, "try-ios");
    assertEquals(body.run.id, 7);
    assertEquals(body.run.status, "in_progress");
    assertEquals(
      body.actionsUrl,
      `https://github.com/o/r/actions/workflows/${WORKFLOW_FILE}`,
    );
    // The dispatch named the configured repository and ref, with the inputs.
    const dispatch = gh0.calls.find((c) => c.url.endsWith("/dispatches"))!;
    assertStringIncludes(dispatch.url, "/repos/o/r/actions/workflows/");
    assertEquals(JSON.parse(String(dispatch.init?.body)), {
      ref: "try-ios",
      inputs: { level: "foo", request: body.request, bundle_id: "com.x.y" },
    });

    // Watching it, by request id and then by run id.
    let watched = await (await get(`?request=${body.request}`)).json();
    assertEquals(watched.run.id, 7);
    watched = await (await get("?run=7")).json();
    assertEquals(watched.run.headline, "Uploaded to TestFlight.");
    assertEquals(watched.run.uploaded, true);
    assertEquals(watched.artifacts, [{
      id: 42,
      name: "ios-ipa",
      size: 1048576,
      url: "/api/publish-ios?artifact=42",
    }]);
    // An unknown request id is "not listed yet", not an error.
    const none = await (await get("?request=qqqqqqqqqq")).json();
    assertEquals(none.run, null);
    assertEquals((await get("?run=abc")).status, 400);
  } finally {
    restore();
  }
});
