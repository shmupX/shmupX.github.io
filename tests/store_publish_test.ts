// The PUBLISH panel has three workflows on GitHub and one client that
// dispatches them and reads them back (lib/store-publish.ts behind
// routes/api/publish.ts). They agree on the run titles, the step names the
// chips key off and the inputs only by construction, so this pins the seams:
// each YAML carries the names the client reads it by, a run is a level's by
// its title, a store's inputs are the strings its workflow declares, a run's
// steps become the chips the panel draws, the secrets a store needs read as
// the card's credential line — and the route refuses on Deploy and without a
// token, then dispatches two stores at once against a fake GitHub, reading
// one back with its chips and its artifact.

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type Annotation,
  STEP_SIGNED,
  STEP_STAGE,
  STEP_UNSIGNED,
  STEP_UPLOAD,
  type WorkflowJob,
  type WorkflowRun,
  type WorkflowStep,
} from "../lib/ios-publish.ts";
import {
  chipState,
  credentialNote,
  defaultItchVersion,
  ITCH_CHANNEL_NAMES,
  ITCH_STEP_BUILD,
  ITCH_STEP_PACK,
  ITCH_STEP_PUSH,
  runIsLevel,
  SettingsError,
  sortLog,
  STEAM_STEP_BUILD,
  STEAM_STEP_DEPOT,
  STEAM_STEP_LIVE,
  STEAM_STEP_UPLOAD,
  STEP_REVIEW,
  STORE_IDS,
  storeArtifacts,
  storeDispatchInputs,
  storePublishConfig,
  storeRunName,
  STORES,
  summarizeStoreRun,
} from "../lib/store-publish.ts";
import { handler, setPublishDeps } from "../routes/api/publish.ts";
import {
  allShots,
  captureArgs,
  containedShot,
  middleFrame,
  SHOT_SIZES,
  stillArgs,
} from "../lib/store-shots.ts";

const yaml = (file: string) =>
  Deno.readTextFileSync(
    new URL(`../.github/workflows/${file}`, import.meta.url),
  );

Deno.test("each store's workflow carries the names the panel reads it by", () => {
  const steps = {
    ios: [STEP_STAGE, STEP_SIGNED, STEP_UNSIGNED, STEP_UPLOAD, STEP_REVIEW],
    steam: [
      STEAM_STEP_BUILD,
      STEAM_STEP_DEPOT,
      STEAM_STEP_UPLOAD,
      STEAM_STEP_LIVE,
    ],
    itch: [ITCH_STEP_BUILD, ITCH_STEP_PACK, ITCH_STEP_PUSH],
  };
  const inputs = {
    ios: ["level", "bundle_id", "upload", "review", "request"],
    steam: ["level", "app_id", "depot_id", "branch", "description", "request"],
    itch: ["level", "target", "version", "channels", "request"],
  };
  for (const id of STORE_IDS) {
    const spec = STORES[id];
    const text = yaml(spec.workflow);
    for (const name of steps[id]) {
      assertStringIncludes(
        text,
        `- name: ${name}\n`,
        `${spec.workflow}: ${name}`,
      );
    }
    // Every chip stands for a step the workflow has.
    for (const chip of spec.chips) {
      for (const s of chip.steps) assertStringIncludes(text, `- name: ${s}\n`);
    }
    // The run title: "<prefix> · <level> · <request>", matched on the tail.
    assertStringIncludes(
      text,
      `run-name: "${spec.runPrefix} · \${{ inputs.level }} · \${{ inputs.request`,
    );
    for (const key of inputs[id]) {
      assertStringIncludes(
        text,
        `\n      ${key}:\n`,
        `${spec.workflow}: input ${key}`,
      );
    }
    // The secrets the card names are the ones the YAML reads.
    for (const secret of spec.secrets) {
      assertStringIncludes(
        text,
        `secrets.${secret}`,
        `${spec.workflow}: ${secret}`,
      );
    }
    // What a run says reaches the panel as annotations with these titles.
    assertStringIncludes(text, "::notice title=Detail::");
    if (id !== "ios") assertStringIncludes(text, "::notice title=Result::");
  }
  // The review step runs the script that does the App Store Connect part.
  assertStringIncludes(yaml("ios-publish.yml"), "scripts/asc-review.ts");
  assert(
    Deno.statSync(new URL("../scripts/asc-review.ts", import.meta.url)).isFile,
  );
  // itch.io reads the platform off the channel's name.
  const itch = yaml("itch-publish.yml");
  for (const name of Object.values(ITCH_CHANNEL_NAMES)) {
    assertStringIncludes(itch, `"$out/${name}"`);
  }
});

Deno.test("a run is a level's by its title, whatever the store", () => {
  assertEquals(storeRunName("steam", "foo", "abc"), "Steam · foo · abc");
  assertEquals(storeRunName("itch", "foo", "abc"), "itch.io · foo · abc");
  assertEquals(storeRunName("ios", "foo", "abc"), "iOS · foo · abc");
  assert(runIsLevel({ display_title: "Steam · foo · abc" }, "steam", "foo"));
  assert(
    runIsLevel({ display_title: "Steam · foo · by hand" }, "steam", "foo"),
  );
  assert(!runIsLevel({ display_title: "Steam · foo2 · abc" }, "steam", "foo"));
  assert(!runIsLevel({ display_title: "iOS · foo · abc" }, "steam", "foo"));
  assert(!runIsLevel({ display_title: "Steam · foo · abc" }, "itch", "foo"));
});

Deno.test("one repository and ref for every store, overridable together or as iOS was", () => {
  assertEquals(storePublishConfig("steam", {}), {
    repo: "shmupX/shmupX.github.io",
    ref: "main",
    workflow: "steam-publish.yml",
  });
  assertEquals(
    storePublishConfig("itch", {
      SHMUPX_IOS_REPO: "me/fork",
      SHMUPX_IOS_REF: "try",
    }),
    { repo: "me/fork", ref: "try", workflow: "itch-publish.yml" },
  );
  assertEquals(
    storePublishConfig("ios", {
      SHMUPX_IOS_REPO: "me/fork",
      SHMUPX_PUBLISH_REPO: " you/fork ",
      SHMUPX_PUBLISH_REF: "stores",
    }),
    { repo: "you/fork", ref: "stores", workflow: "ios-publish.yml" },
  );
});

Deno.test("storeDispatchInputs: strings only, each store's own, refused when a setting is missing", () => {
  assertEquals(
    storeDispatchInputs("ios", {
      level: "foo",
      request: "r",
      settings: { ios: { bundleId: " com.x.y ", upload: false, review: true } },
    }),
    {
      level: "foo",
      request: "r",
      bundle_id: "com.x.y",
      upload: "false",
      review: "true",
    },
  );
  assertEquals(storeDispatchInputs("ios", { level: "foo", request: "r" }), {
    level: "foo",
    request: "r",
  });
  assertEquals(
    storeDispatchInputs("steam", {
      level: "foo",
      request: "r",
      settings: {
        steam: {
          appId: "3482910",
          depotId: "3482911",
          branch: "beta",
          description: "x",
        },
      },
    }),
    {
      level: "foo",
      request: "r",
      app_id: "3482910",
      depot_id: "3482911",
      branch: "beta",
      description: "x",
    },
  );
  assertEquals(
    storeDispatchInputs("steam", {
      level: "foo",
      request: "r",
      settings: { steam: { appId: "1", depotId: "2" } },
    }).branch,
    "default",
  );
  const refused = (
    store: "steam" | "itch",
    settings: Record<string, unknown>,
  ) =>
    assertThrows(
      () =>
        storeDispatchInputs(store, { level: "foo", request: "r", settings }),
      SettingsError,
    );
  assertStringIncludes(
    refused("steam", { steam: { appId: "x", depotId: "2" } }).message,
    "app id",
  );
  assertStringIncludes(
    refused("steam", { steam: { appId: "1", depotId: "" } }).message,
    "depot id",
  );
  assertStringIncludes(
    refused("steam", { steam: { appId: "1", depotId: "2", branch: "main" } })
      .message,
    "branch",
  );
  assertEquals(
    storeDispatchInputs("itch", {
      level: "foo",
      request: "r",
      settings: {
        itch: {
          target: "EasierByCode/foo",
          version: "20261026.1",
          channels: ["web", "win", "bogus"],
        },
      },
    }),
    {
      level: "foo",
      request: "r",
      target: "easierbycode/foo",
      version: "20261026.1",
      channels: "win,web",
    },
  );
  assertStringIncludes(
    refused("itch", { itch: { target: "foo", channels: ["win"] } }).message,
    "user/game",
  );
  assertStringIncludes(
    refused("itch", { itch: { target: "a/b", channels: [] } }).message,
    "channel",
  );
  assertStringIncludes(
    refused("itch", {
      itch: { target: "a/b", version: "v 1", channels: ["win"] },
    }).message,
    "version",
  );
  // No version: today's, in itch.io's shape.
  const v = storeDispatchInputs("itch", {
    level: "foo",
    request: "r",
    settings: { itch: { target: "a/b", channels: ["linux"] } },
  }).version;
  assert(/^\d{8}\.1$/.test(v), v);
  assertEquals(
    defaultItchVersion(new Date("2026-10-26T23:59:00Z")),
    "20261026.1",
  );
});

const run = (
  status: string,
  conclusion: string | null,
  title = "Steam · foo · abcdefghjk",
): WorkflowRun => ({
  id: 7,
  name: "steam-publish",
  display_title: title,
  html_url: "https://github.com/o/r/actions/runs/7",
  status,
  conclusion,
  created_at: "2026-10-26T14:30:00Z",
  updated_at: "2026-10-26T14:31:00Z",
  run_number: 12,
  event: "workflow_dispatch",
});
const job = (
  steps: Omit<WorkflowStep, "number">[],
  conclusion: string | null = null,
): WorkflowJob[] => [{
  id: 90,
  name: "steam",
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
const live = (name: string): Omit<WorkflowStep, "number"> => ({
  name,
  status: "in_progress",
  conclusion: null,
});
const notice = (title: string, message: string): Annotation => ({
  annotation_level: "notice",
  title,
  message,
});

Deno.test("chipState: the step's state across the jobs, either of two steps for SIGN", () => {
  const sign = STORES.ios.chips[1];
  assertEquals(
    chipState(sign, [
      done(STEP_SIGNED, "success"),
      done(STEP_UNSIGNED, "skipped"),
    ]).state,
    "done",
  );
  assertEquals(
    chipState(sign, [
      done(STEP_SIGNED, "skipped"),
      done(STEP_UNSIGNED, "success"),
    ]).state,
    "done",
  );
  assertEquals(chipState(sign, [live(STEP_SIGNED)]).state, "run");
  assertEquals(chipState(sign, [done(STEP_SIGNED, "failure")]).state, "fail");
  assertEquals(
    chipState(sign, [
      done(STEP_SIGNED, "skipped"),
      done(STEP_UNSIGNED, "skipped"),
    ]).state,
    "skip",
  );
  const todo = chipState(sign, []);
  assertEquals([todo.state, todo.present, todo.title], [
    "todo",
    false,
    STEP_SIGNED,
  ]);
});

Deno.test("summarizeStoreRun: the chips, the headline, the detail, the outcome", () => {
  // Queued.
  let s = summarizeStoreRun("steam", run("queued", null));
  assertEquals(s.headline, "Waiting for a GitHub runner…");
  assertEquals(s.chips.map((c) => c.key + ":" + c.state), [
    "STAGE:todo",
    "DEPOT:todo",
    "UPLOAD:todo",
    "BRANCH:todo",
  ]);
  assertEquals(s.outcome, "run");
  assertEquals(s.number, 12);

  // Running the depot.
  s = summarizeStoreRun(
    "steam",
    run("in_progress", null),
    job([done(STEAM_STEP_BUILD, "success"), live(STEAM_STEP_DEPOT)]),
  );
  assertEquals(s.headline, STEAM_STEP_DEPOT + "…");
  assertEquals(s.chips.map((c) => c.state), ["done", "run", "todo", "todo"]);
  assertEquals(s.chips[1].title, STEAM_STEP_DEPOT);

  // Through, with what the workflow said.
  s = summarizeStoreRun(
    "steam",
    run("completed", "success"),
    job([
      done(STEAM_STEP_BUILD, "success"),
      done(STEAM_STEP_DEPOT, "success"),
      done(STEAM_STEP_UPLOAD, "success"),
      done(STEAM_STEP_LIVE, "success"),
    ], "success"),
    [
      notice("Result", "Build 21374 is live on the beta branch."),
      notice("Detail", "depot 3482911 · beta · build 21374"),
    ],
  );
  assertEquals(s.headline, "Build 21374 is live on the beta branch.");
  assertEquals(s.detail, "depot 3482911 · beta · build 21374");
  assertEquals(s.outcome, "ok");
  assertEquals(s.chips.every((c) => c.state === "done"), true);

  // Stopped before the upload: no secret.
  s = summarizeStoreRun(
    "itch",
    run("completed", "failure", "itch.io · foo · abcdefghjk"),
    job([
      done(ITCH_STEP_BUILD, "success"),
      done(ITCH_STEP_PACK, "success"),
      done(ITCH_STEP_PUSH, "failure"),
    ], "failure"),
    [{
      annotation_level: "failure",
      title: "butler",
      message:
        "No BUTLER_API_KEY in this repository's secrets, so every channel was built and packed but nothing was pushed.",
    }],
  );
  assertEquals(s.outcome, "fail");
  assertEquals(s.chips.map((c) => c.state), ["done", "done", "fail"]);
  assertStringIncludes(
    s.headline,
    `Failed at "${ITCH_STEP_PUSH}". butler: No BUTLER_API_KEY`,
  );
  // GitHub lists its own "exit code 1" before the workflow's titled reason;
  // the titled one leads the headline (seen on the first real dry run).
  s = summarizeStoreRun(
    "itch",
    run("completed", "failure", "itch.io · foo · abcdefghjk"),
    job([done(ITCH_STEP_PUSH, "failure")], "failure"),
    [
      {
        annotation_level: "failure",
        title: null,
        message: "Process completed with exit code 1.",
      },
      {
        annotation_level: "failure",
        title: "butler",
        message: "No BUTLER_API_KEY in this repository's secrets.",
      },
    ],
  );
  assertEquals(s.errors, [
    "butler: No BUTLER_API_KEY in this repository's secrets.",
    "Process completed with exit code 1.",
  ]);
  assertStringIncludes(s.headline, "butler: No BUTLER_API_KEY");

  // iOS keeps lib/ios-publish.ts's reading, plus the REVIEW chip when asked.
  s = summarizeStoreRun(
    "ios",
    run("completed", "success", "iOS · foo · abcdefghjk"),
    job([
      done(STEP_STAGE, "success"),
      done(STEP_SIGNED, "skipped"),
      done(STEP_UNSIGNED, "success"),
      done(STEP_UPLOAD, "skipped"),
    ], "success"),
    [notice(
      "Detail",
      "com.easierbycode.game2028 · build 20261026.1430.213 · unsigned",
    )],
  );
  assertEquals(s.headline, "Unsigned .ipa built — nothing went to TestFlight.");
  assertEquals([s.signed, s.uploaded, s.outcome], [false, false, "warn"]);
  assertEquals(s.chips.map((c) => c.key + ":" + c.state), [
    "STAGE:done",
    "SIGN:done",
    "UPLOAD:skip",
  ]);
  assertEquals(
    s.detail,
    "com.easierbycode.game2028 · build 20261026.1430.213 · unsigned",
  );
  s = summarizeStoreRun("ios", run("queued", null, "iOS · foo · x"), [], [], {
    review: true,
  });
  assertEquals(s.chips.map((c) => c.key), [
    "STAGE",
    "SIGN",
    "UPLOAD",
    "REVIEW",
  ]);
  assertEquals(s.headline, "Waiting for a GitHub Mac…");
  s = summarizeStoreRun(
    "ios",
    run("completed", "success", "iOS · foo · x"),
    job([
      done(STEP_SIGNED, "success"),
      done(STEP_UPLOAD, "success"),
      done(STEP_REVIEW, "success"),
    ], "success"),
  );
  assertEquals(s.headline, "Uploaded to TestFlight and submitted for review.");
  assertEquals(s.chips.map((c) => c.key + ":" + c.state), [
    "STAGE:todo",
    "SIGN:done",
    "UPLOAD:done",
    "REVIEW:done",
  ]);
  assertEquals(s.outcome, "ok");

  // Cancelled.
  s = summarizeStoreRun(
    "itch",
    run("completed", "cancelled"),
    job([], "cancelled"),
  );
  assertEquals([s.headline, s.outcome], ["Cancelled.", "fail"]);

  assertEquals(
    storeArtifacts([
      {
        id: 1,
        name: "ios-ipa",
        size_in_bytes: 50541773,
        expired: false,
        archive_download_url: "u",
      },
      {
        id: 2,
        name: "itch-channels",
        size_in_bytes: 1048576,
        expired: false,
        archive_download_url: "u",
      },
      {
        id: 3,
        name: "old",
        size_in_bytes: 5,
        expired: true,
        archive_download_url: "u",
      },
    ]).map((a) => a.label),
    ["DOWNLOAD .IPA (ZIP, 48.2 MB)", "DOWNLOAD CHANNELS (ZIP, 1.0 MB)"],
  );
  assertEquals(
    sortLog([{ createdAt: "2026-10-25T10:00:00Z" }, {
      createdAt: "2026-10-26T10:00:00Z",
    }]).map((e) => e.createdAt),
    ["2026-10-26T10:00:00Z", "2026-10-25T10:00:00Z"],
  );
});

Deno.test("credentialNote: what the card says under the store's name", () => {
  const all = [
    "BUILD_CERTIFICATE_BASE64",
    "BUILD_PROVISION_PROFILE_BASE64",
    "ASC_KEY_ID",
    "ASC_ISSUER_ID",
    "ASC_API_KEY",
    "STEAM_USERNAME",
    "STEAM_CONFIG_VDF",
    "BUTLER_API_KEY",
  ];
  assertEquals(credentialNote("ios", all).ok, true);
  assertEquals(
    credentialNote("ios", all).text,
    "APPLE SECRETS PRESENT · ASC API KEY PRESENT",
  );
  assertEquals(
    credentialNote("ios", []).text,
    "NO APPLE SECRETS · UNSIGNED DRY RUN",
  );
  assertEquals(
    credentialNote("ios", [
      "BUILD_CERTIFICATE_BASE64",
      "BUILD_PROVISION_PROFILE_BASE64",
    ]).text,
    "APPLE SECRETS PRESENT · NO ASC API KEY · STOPS BEFORE UPLOAD",
  );
  assertEquals(credentialNote("steam", all), {
    ok: true,
    text: "STEAM_CONFIG_VDF PRESENT",
    missing: [],
  });
  assertEquals(
    credentialNote("steam", ["STEAM_USERNAME"]).text,
    "NO STEAM SECRETS · STOPS BEFORE UPLOAD",
  );
  assertEquals(credentialNote("steam", ["STEAM_USERNAME"]).missing, [
    "STEAM_CONFIG_VDF",
  ]);
  assertEquals(credentialNote("itch", all).text, "BUTLER_API_KEY PRESENT");
  assertEquals(
    credentialNote("itch", []).text,
    "NO BUTLER_API_KEY · STOPS BEFORE PUSH",
  );
  assertEquals(credentialNote("itch", null).ok, null);
});

Deno.test("store-shots: the sizes, the command lines, the stills kept inside the root", () => {
  const shots = allShots("foo");
  assertEquals(
    shots.length,
    SHOT_SIZES.ios.length + SHOT_SIZES.steam.length + SHOT_SIZES.itch.length,
  );
  assertEquals(shots[0].path, "foo/shots/ios/iphone-67.png");
  assertEquals(captureArgs("foo", "/out").slice(0, 4), [
    "run",
    "-A",
    "scripts/testdrive-parity.ts",
    "foo",
  ]);
  assertEquals(captureArgs("foo", "/out").slice(4), [
    "--targets",
    "web",
    "--attempts",
    "1",
    "--keep-frames",
    "--max-mb",
    "0",
    "--out",
    "/out",
  ]);
  const args = stillArgs("in.mp4", { w: 616, h: 353 }, 12.5, "out.png");
  assertEquals(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2), [
    "-ss",
    "12.50",
  ]);
  const vf = args[args.indexOf("-vf") + 1];
  assertStringIncludes(
    vf,
    "scale=616:353:force_original_aspect_ratio=decrease:flags=neighbor",
  );
  assertStringIncludes(vf, "pad=616:353:");
  // No clip: the newest attempt's middle frame, PNGs only.
  assertEquals(
    middleFrame([
      { name: "web-1", files: ["f000000.png", "f000001.png"] },
      {
        name: "web-2",
        files: ["f000000.png", "f000001.png", "f000002.png", "notes.txt"],
      },
      { name: "ps2-1", files: ["f000000.png"] },
    ]),
    { dir: "web-2", file: "f000001.png" },
  );
  assertEquals(middleFrame([{ name: "web-3", files: ["a.txt"] }]), null);
  assertEquals(middleFrame([]), null);
  assert(containedShot("/root/build/publish", "foo/shots/ios/iphone-67.png"));
  assertEquals(containedShot("/root/build/publish", "../etc/passwd"), null);
  assertEquals(
    containedShot("/root/build/publish", "foo/shots/ios/iphone-67.jpg"),
    null,
  );
  assertEquals(
    containedShot("/root/build/publish", "foo/shots/other/x.png"),
    null,
  );
});

// ── The route ───────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
const h = handler as any;
const post = (body: unknown) =>
  h.POST({
    req: new Request("http://localhost/api/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  }) as Promise<Response>;
const get = (query = "") =>
  h.GET({
    req: new Request("http://localhost/api/publish" + query),
  }) as Promise<Response>;

Deno.test("the route refuses on Deploy, without a store, and without a token", async () => {
  Deno.env.set("DENO_DEPLOYMENT_ID", "x");
  try {
    assertEquals(
      (await post({ level: "foo", stores: { steam: {} } })).status,
      403,
    );
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
    assertEquals((await post("not json")).status, 400);
    assertEquals((await post({ level: "foo" })).status, 400);
    assertEquals((await post({ level: "", stores: { ios: {} } })).status, 400);
    const res = await post({ level: "foo", stores: { ios: {} } });
    assertEquals(res.status, 412);
    assertStringIncludes((await res.json()).hint, "gh auth login");
    const status = await (await get("?level=foo")).json();
    assertEquals(status.configured, false);
    assertEquals(status.stores.steam.cred, null);
    assertEquals(status.stores.steam.workflow, "steam-publish.yml");
    assertStringIncludes(status.hint, "GITHUB_TOKEN");
    assertEquals((await get("?store=nope&run=1")).status, 400);
    assertEquals((await get("?store=steam&run=1")).status, 412);
    const cross = await h.POST({
      req: new Request("http://localhost/api/publish", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
        body: "{}",
      }),
    });
    assertEquals(cross.status, 403);
  } finally {
    restore();
  }
});

/** A GitHub with two workflows, secrets, and runs that read back by store. */
function fakeGitHub() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const requests: Record<string, string> = {};
  const fetchFn: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const m = /workflows\/([a-z-]+\.yml)\/dispatches$/.exec(url);
    if (m) {
      requests[m[1]] = JSON.parse(String(init?.body)).inputs.request;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.includes("/actions/secrets")) {
      return Promise.resolve(Response.json({
        secrets: [{ name: "STEAM_USERNAME" }, { name: "STEAM_CONFIG_VDF" }, {
          name: "ASC_KEY_ID",
        }],
      }));
    }
    if (url.includes("/actions/variables")) {
      return Promise.resolve(Response.json({
        variables: [{ name: "STEAM_APP_ID", value: "3482910" }, {
          name: "IOS_BUNDLE_ID",
          value: "com.x.y",
        }],
      }));
    }
    if (url.includes("/workflows/steam-publish.yml/runs")) {
      return Promise.resolve(Response.json({
        workflow_runs: [
          { ...run("completed", "success", "Steam · bar · zzzzzzzzzz"), id: 5 },
          {
            ...run(
              "completed",
              "success",
              `Steam · foo · ${requests["steam-publish.yml"] ?? "none"}`,
            ),
            id: 7,
          },
          {
            ...run("completed", "failure", "Steam · foo · by hand"),
            id: 6,
            created_at: "2026-10-20T10:00:00Z",
          },
        ],
      }));
    }
    if (url.includes("/workflows/itch-publish.yml/runs")) {
      return Promise.resolve(Response.json({
        // Before the dispatch, another game's run; after it, foo's.
        workflow_runs: [{
          ...run(
            "queued",
            null,
            requests["itch-publish.yml"]
              ? `itch.io · foo · ${requests["itch-publish.yml"]}`
              : "itch.io · bar · by hand",
          ),
          id: 8,
          created_at: "2026-10-26T14:31:00Z",
        }],
      }));
    }
    if (url.includes("/workflows/ios-publish.yml/runs")) {
      return Promise.resolve(
        Response.json({ message: "Not Found" }, { status: 404 }),
      );
    }
    if (url.endsWith("/actions/runs/7")) {
      return Promise.resolve(Response.json(run("completed", "success")));
    }
    if (url.endsWith("/actions/runs/6")) {
      return Promise.resolve(
        Response.json({
          ...run("completed", "failure", "Steam · foo · by hand"),
          id: 6,
        }),
      );
    }
    if (
      url.includes("/actions/runs/7/jobs") ||
      url.includes("/actions/runs/6/jobs")
    ) {
      return Promise.resolve(Response.json({
        jobs: job([
          done(STEAM_STEP_BUILD, "success"),
          done(STEAM_STEP_DEPOT, "success"),
          done(STEAM_STEP_UPLOAD, "success"),
          done(STEAM_STEP_LIVE, "success"),
        ], "success"),
      }));
    }
    if (url.includes("/actions/runs/8/jobs")) {
      return Promise.resolve(Response.json({ jobs: [] }));
    }
    if (url.includes("/check-runs/90/annotations")) {
      return Promise.resolve(Response.json([
        notice("Result", "Build 21374 is live on the beta branch."),
        notice("Detail", "depot 3482911 · beta · build 21374"),
      ]));
    }
    if (
      url.includes("/actions/runs/7/artifacts") ||
      url.includes("/actions/runs/6/artifacts")
    ) {
      return Promise.resolve(Response.json({
        artifacts: [{
          id: 42,
          name: "steam-depot",
          size_in_bytes: 1048576,
          expired: false,
          archive_download_url: "x",
        }],
      }));
    }
    if (url.includes("/artifacts")) {
      return Promise.resolve(Response.json({ artifacts: [] }));
    }
    return Promise.resolve(
      Response.json({ message: "Not Found" }, { status: 404 }),
    );
  };
  return { calls, fetchFn, requests };
}

Deno.test("the route reads the repository, dispatches two stores at once, and watches each", async () => {
  const gh = fakeGitHub();
  const restore = setPublishDeps({
    env: () => ({ SHMUPX_PUBLISH_REPO: "o/r", SHMUPX_PUBLISH_REF: "stores" }),
    token: () => Promise.resolve({ token: "t", source: "GITHUB_TOKEN" }),
    fetch: gh.fetchFn,
    sleep: () => Promise.resolve(),
  });
  try {
    // The opening read: secrets as credential lines, variables as defaults,
    // the level's log newest first (the iOS workflow not on the ref lists
    // nothing, which is not an error).
    const status = await (await get("?level=foo")).json();
    assertEquals(status.configured, true);
    assertEquals(status.repo, "o/r");
    assertEquals(status.secretsReadable, true);
    assertEquals(status.stores.steam.cred.ok, true);
    assertEquals(
      status.stores.itch.cred.text,
      "NO BUTLER_API_KEY · STOPS BEFORE PUSH",
    );
    assertEquals(status.stores.ios.cred.ok, false);
    assertEquals(status.stores.steam.variables, { STEAM_APP_ID: "3482910" });
    assertEquals(status.stores.ios.variables, { IOS_BUNDLE_ID: "com.x.y" });
    assertEquals(status.log.map((l: { id: number }) => l.id), [7, 6]);
    assertEquals(
      status.log[0].headline,
      "Build 21374 is live on the beta branch.",
    );
    assertEquals(status.log[0].detail, "depot 3482911 · beta · build 21374");
    assertEquals(
      status.log[0].artifacts[0].url,
      "/api/publish?store=steam&artifact=42",
    );
    assertEquals(status.log[1].outcome, "fail");

    // Two stores: one dispatch each, one refusal that stops neither.
    const res = await post({
      level: " foo ",
      stores: {
        steam: { appId: "3482910", depotId: "3482911", branch: "beta" },
        itch: { target: "easierbycode/foo", channels: ["web"] },
        ios: { bundleId: "" },
      },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.level, "foo");
    assertEquals(body.results.steam.ok, true);
    assertEquals(body.results.steam.request, gh.requests["steam-publish.yml"]);
    assertEquals(body.results.steam.run.id, 7);
    assertEquals(body.results.steam.run.chips.length, 4);
    assertEquals(body.results.itch.ok, true);
    assertEquals(body.results.itch.run.id, 8);
    assertEquals(
      body.results.itch.run.headline,
      "Waiting for a GitHub runner…",
    );
    assertEquals(body.results.ios.ok, false);
    assertEquals(body.results.ios.github, 404);
    assertStringIncludes(body.results.ios.hint, "push it");
    const dispatches = gh.calls.filter((c) => c.url.endsWith("/dispatches"));
    assertEquals(dispatches.length, 3);
    const steam = dispatches.find((c) =>
      c.url.includes("/steam-publish.yml/")
    )!;
    assertStringIncludes(
      steam.url,
      "/repos/o/r/actions/workflows/steam-publish.yml/",
    );
    assertEquals(JSON.parse(String(steam.init?.body)), {
      ref: "stores",
      inputs: {
        level: "foo",
        request: body.results.steam.request,
        app_id: "3482910",
        depot_id: "3482911",
        branch: "beta",
      },
    });
    const itch = dispatches.find((c) => c.url.includes("/itch-publish.yml/"))!;
    assertEquals(JSON.parse(String(itch.init?.body)).inputs.channels, "web");
    // A setting missing is refused before GitHub is asked.
    const bad =
      await (await post({ level: "foo", stores: { steam: { appId: "x" } } }))
        .json();
    assertEquals(bad.results.steam.ok, false);
    assertStringIncludes(bad.results.steam.error, "app id");

    // Watching: by request id, then by run id, with chips and the artifact.
    let watched =
      await (await get(`?store=steam&request=${body.results.steam.request}`))
        .json();
    assertEquals(watched.run.id, 7);
    watched = await (await get("?store=steam&run=7")).json();
    assertEquals(
      watched.run.headline,
      "Build 21374 is live on the beta branch.",
    );
    assertEquals(watched.run.outcome, "ok");
    assertEquals(watched.run.chips.map((c: { state: string }) => c.state), [
      "done",
      "done",
      "done",
      "done",
    ]);
    assertEquals(watched.artifacts, [{
      id: 42,
      name: "steam-depot",
      size: 1048576,
      label: "DOWNLOAD DEPOT (ZIP, 1.0 MB)",
      url: "/api/publish?store=steam&artifact=42",
    }]);
    const none = await (await get("?store=itch&request=qqqqqqqqqq")).json();
    assertEquals(none.run, null);
    assertEquals((await get("?store=steam&run=abc")).status, 400);
    assertEquals((await get("?store=steam")).status, 400);
  } finally {
    restore();
  }
});
