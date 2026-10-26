// lib/store-publish.ts — the editor's PUBLISH panel: one cloud game to the
// stores, every build on a GitHub runner.
//
// lib/ios-publish.ts took the first store there: a GitHub Mac signs the game
// and uploads it to TestFlight, and the editor watches the run. The panel
// generalises that to three stores, each a workflow of its own under
// .github/workflows, dispatched with the level's name and read back the same
// way — a run found by the request id its title ends in, its steps turned into
// the chips the panel draws, its ::error annotations into the reason a run
// failed and its ::notice ones into what a run did:
//
//   ios     ios-publish.yml     a GitHub Mac: stage, sign, upload to TestFlight,
//                               and (review on) submit the processed build for
//                               App Store review with the listing
//   steam   steam-publish.yml   a Linux runner: the Linux and Windows desktop
//                               apps, laid into one depot, uploaded with
//                               SteamPipe, set live on a branch
//   itch    itch-publish.yml    a Linux runner: one build per picked channel,
//                               packed, pushed with butler
//
// This module is the shared vocabulary — which workflow, which inputs, which
// step names mean which chip, which repository secrets a store needs, and how
// a run reads — behind routes/api/publish.ts (the panel's HTTP face). The
// GitHub client itself, the token and the request ids are lib/ios-publish.ts's,
// reused as they are; tests/store_publish_test.ts pins that the three YAML
// files carry the names this reads them by.

import {
  type Annotation,
  type Env,
  matchesRequest,
  type PublishConfig,
  publishConfig,
  type RunArtifact,
  STEP_SIGNED,
  STEP_STAGE,
  STEP_UNSIGNED,
  STEP_UPLOAD,
  summarizeArtifacts,
  summarizeRun,
  type WorkflowJob,
  type WorkflowRun,
} from "./ios-publish.ts";

export type StoreId = "ios" | "steam" | "itch";
export const STORE_IDS: readonly StoreId[] = ["ios", "steam", "itch"];

/** The App Store review step, as ios-publish.yml spells it. */
export const STEP_REVIEW = "Submit the processed build for App Store review";
// steam-publish.yml
export const STEAM_STEP_BUILD = "Build the Linux and Windows desktop apps";
export const STEAM_STEP_DEPOT = "Lay the builds into the depot";
export const STEAM_STEP_UPLOAD = "Upload with SteamPipe";
export const STEAM_STEP_LIVE = "Set live on the branch";
// itch-publish.yml
export const ITCH_STEP_BUILD = "Build the picked channels";
export const ITCH_STEP_PACK = "Pack one zip per channel";
export const ITCH_STEP_PUSH = "butler push, per channel";

/** The itch.io channels a publish may push, in the panel's order. */
export const ITCH_CHANNELS = ["win", "linux", "mac", "web"] as const;
export type ItchChannel = typeof ITCH_CHANNELS[number];
/** What each channel is called on itch.io, which reads the platform off it. */
export const ITCH_CHANNEL_NAMES: Record<ItchChannel, string> = {
  win: "windows",
  linux: "linux",
  mac: "osx",
  web: "html5",
};

export const STEAM_BRANCHES = ["default", "beta"] as const;
export type SteamBranch = typeof STEAM_BRANCHES[number];

/** One chip in the panel's run row: a label over the step(s) it stands for. */
export interface ChipSpec {
  key: string;
  label: string;
  /** The step names (any of them) in the workflow, as `- name:` spells them. */
  steps: string[];
  /** Drawn only when one of its steps is in the run (REVIEW, when it was asked for). */
  optional?: boolean;
}

export interface StoreSpec {
  id: StoreId;
  badge: string;
  name: string;
  sub: string;
  workflow: string;
  /** The run title's first word: `<prefix> · <level> · <request>`. */
  runPrefix: string;
  chips: ChipSpec[];
  /** What the run row says while GitHub has not started it. */
  queued: string;
  /** Repository secrets the workflow reads, in the order the notes name them. */
  secrets: string[];
  /** Repository variables that default the panel's settings. */
  variables: string[];
}

export const STORES: Record<StoreId, StoreSpec> = {
  ios: {
    id: "ios",
    badge: "TF",
    name: "APP STORE CONNECT",
    sub: "TESTFLIGHT · SIGNED ON A GITHUB MAC",
    workflow: "ios-publish.yml",
    runPrefix: "iOS",
    chips: [
      { key: "STAGE", label: "STAGE", steps: [STEP_STAGE] },
      { key: "SIGN", label: "SIGN", steps: [STEP_SIGNED, STEP_UNSIGNED] },
      { key: "UPLOAD", label: "UPLOAD", steps: [STEP_UPLOAD] },
      { key: "REVIEW", label: "REVIEW", steps: [STEP_REVIEW], optional: true },
    ],
    queued: "Waiting for a GitHub Mac…",
    secrets: [
      "BUILD_CERTIFICATE_BASE64",
      "P12_PASSWORD",
      "BUILD_PROVISION_PROFILE_BASE64",
      "KEYCHAIN_PASSWORD",
      "APPLE_TEAM_ID",
      "CODE_SIGN_IDENTITY",
      "ASC_KEY_ID",
      "ASC_ISSUER_ID",
      "ASC_API_KEY",
    ],
    variables: ["IOS_BUNDLE_ID"],
  },
  steam: {
    id: "steam",
    badge: "ST",
    name: "STEAM",
    sub: "STEAMPIPE · GITHUB RUNNER",
    workflow: "steam-publish.yml",
    runPrefix: "Steam",
    chips: [
      { key: "STAGE", label: "STAGE", steps: [STEAM_STEP_BUILD] },
      { key: "DEPOT", label: "DEPOT", steps: [STEAM_STEP_DEPOT] },
      { key: "UPLOAD", label: "UPLOAD", steps: [STEAM_STEP_UPLOAD] },
      { key: "BRANCH", label: "BRANCH", steps: [STEAM_STEP_LIVE] },
    ],
    queued: "Waiting for a GitHub runner…",
    secrets: ["STEAM_USERNAME", "STEAM_CONFIG_VDF"],
    variables: ["STEAM_APP_ID", "STEAM_DEPOT_ID"],
  },
  itch: {
    id: "itch",
    badge: "IT",
    name: "ITCH.IO",
    sub: "BUTLER · GITHUB RUNNER",
    workflow: "itch-publish.yml",
    runPrefix: "itch.io",
    chips: [
      { key: "STAGE", label: "STAGE", steps: [ITCH_STEP_BUILD] },
      { key: "PACK", label: "PACK", steps: [ITCH_STEP_PACK] },
      { key: "PUSH", label: "PUSH", steps: [ITCH_STEP_PUSH] },
    ],
    queued: "Waiting for a GitHub runner…",
    secrets: ["BUTLER_API_KEY"],
    variables: ["ITCH_TARGET"],
  },
};

export function isStoreId(x: unknown): x is StoreId {
  return typeof x === "string" && (STORE_IDS as readonly string[]).includes(x);
}

// ── Where the workflows are ─────────────────────────────────────────────────

/**
 * One repository and ref for every store. SHMUPX_PUBLISH_REPO / _REF first;
 * then the iOS pair lib/ios-publish.ts already honours, so a fork that set
 * those keeps working; then the defaults.
 */
export function storePublishConfig(
  store: StoreId,
  env: Env = Deno.env.toObject(),
): PublishConfig {
  const base = publishConfig(env);
  return {
    repo: (env.SHMUPX_PUBLISH_REPO ?? "").trim() || base.repo,
    ref: (env.SHMUPX_PUBLISH_REF ?? "").trim() || base.ref,
    workflow: STORES[store].workflow,
  };
}

// ── Naming the run ──────────────────────────────────────────────────────────

export function storeRunName(
  store: StoreId,
  level: string,
  request: string,
): string {
  return `${STORES[store].runPrefix} · ${level} · ${request}`;
}

/** Is this run one of `level`'s? The title is `<prefix> · <level> · <id>`. */
export function runIsLevel(
  run: { display_title?: string | null; name?: string | null },
  store: StoreId,
  level: string,
): boolean {
  const title = run.display_title ?? run.name ?? "";
  return title.startsWith(`${STORES[store].runPrefix} · ${level} · `);
}

export { matchesRequest };

// ── The inputs a dispatch carries ───────────────────────────────────────────

export interface IosSettings {
  bundleId?: string | null;
  upload?: boolean;
  review?: boolean;
}
export interface SteamSettings {
  appId?: string | null;
  depotId?: string | null;
  branch?: string | null;
  description?: string | null;
}
export interface ItchSettings {
  target?: string | null;
  version?: string | null;
  channels?: string[] | null;
}
export interface StoreSettings {
  ios?: IosSettings;
  steam?: SteamSettings;
  itch?: ItchSettings;
}

/** A refusal before anything is dispatched: the setting that is missing. */
export class SettingsError extends Error {
  constructor(message: string, readonly store: StoreId) {
    super(message);
    this.name = "SettingsError";
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** itch.io's version string: digits, dots and dashes, as butler takes it. */
export function defaultItchVersion(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}.1`;
}

/**
 * The strings a store's workflow is dispatched with (the API takes no other
 * type). Booleans at their default are left out, as lib/ios-publish.ts does.
 */
export function storeDispatchInputs(
  store: StoreId,
  opts: { level: string; request: string; settings?: StoreSettings },
): Record<string, string> {
  const inputs: Record<string, string> = {
    level: opts.level,
    request: opts.request,
  };
  const s = opts.settings ?? {};
  if (store === "ios") {
    const ios = s.ios ?? {};
    const bundleId = str(ios.bundleId);
    if (bundleId) inputs.bundle_id = bundleId;
    if (ios.upload === false) inputs.upload = "false";
    if (ios.review === true) inputs.review = "true";
    return inputs;
  }
  if (store === "steam") {
    const st = s.steam ?? {};
    const appId = str(st.appId);
    const depotId = str(st.depotId);
    if (!/^\d+$/.test(appId)) {
      throw new SettingsError("Steam needs the app id (a number).", "steam");
    }
    if (!/^\d+$/.test(depotId)) {
      throw new SettingsError("Steam needs the depot id (a number).", "steam");
    }
    inputs.app_id = appId;
    inputs.depot_id = depotId;
    const branch = str(st.branch) || "default";
    if (!(STEAM_BRANCHES as readonly string[]).includes(branch)) {
      throw new SettingsError(
        `Steam branch "${branch}" is not one of ${STEAM_BRANCHES.join(", ")}.`,
        "steam",
      );
    }
    inputs.branch = branch;
    const description = str(st.description);
    if (description) inputs.description = description.slice(0, 200);
    return inputs;
  }
  const it = s.itch ?? {};
  const target = str(it.target);
  if (!/^[a-z0-9_-]+\/[a-z0-9_-]+$/i.test(target)) {
    throw new SettingsError(
      "itch.io needs the target as user/game, the page's own address.",
      "itch",
    );
  }
  inputs.target = target.toLowerCase();
  const version = str(it.version) || defaultItchVersion();
  if (!/^[0-9][0-9A-Za-z.-]*$/.test(version)) {
    throw new SettingsError(
      "itch.io's version is digits, dots and dashes (20261026.1).",
      "itch",
    );
  }
  inputs.version = version;
  const channels = (it.channels ?? []).filter((c): c is ItchChannel =>
    (ITCH_CHANNELS as readonly string[]).includes(c)
  );
  if (!channels.length) {
    throw new SettingsError("itch.io needs at least one channel.", "itch");
  }
  inputs.channels = ITCH_CHANNELS.filter((c) => channels.includes(c)).join(
    ",",
  );
  return inputs;
}

// ── Reading a run ───────────────────────────────────────────────────────────

export type ChipState = "todo" | "run" | "done" | "fail" | "skip";

export interface Chip {
  key: string;
  label: string;
  /** The step's name, for the chip's title. */
  title: string;
  state: ChipState;
}

export type Outcome = "run" | "ok" | "warn" | "fail";

export interface StoreRunSummary {
  store: StoreId;
  id: number;
  number: number;
  url: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  /** The step running now, or the one that failed. */
  step: string | null;
  chips: Chip[];
  /** One line for the run row. */
  headline: string;
  /** What the run did, from the workflow's `::notice title=Detail::` line. */
  detail: string;
  /** The workflow's ::error annotations, "Title: message". */
  errors: string[];
  /** ok once a run succeeded outright; warn when it built but shipped nothing. */
  outcome: Outcome;
  // iOS only, from lib/ios-publish.ts; null for the other stores.
  signed: boolean | null;
  uploaded: boolean | null;
}

function stepsOf(jobs: WorkflowJob[]) {
  const out: { name: string; status: string; conclusion: string | null }[] = [];
  for (const job of jobs) {
    for (const s of job.steps ?? []) {
      out.push({ name: s.name, status: s.status, conclusion: s.conclusion });
    }
  }
  return out;
}

/** The chip's state off the steps it stands for, across every job. */
export function chipState(
  spec: ChipSpec,
  steps: { name: string; status: string; conclusion: string | null }[],
): { state: ChipState; title: string; present: boolean } {
  const mine = steps.filter((s) => spec.steps.includes(s.name));
  const live = mine.find((s) =>
    s.status === "in_progress" || s.status === "queued"
  );
  if (live) return { state: "run", title: live.name, present: true };
  const failed = mine.find((s) => s.conclusion === "failure");
  if (failed) return { state: "fail", title: failed.name, present: true };
  const done = mine.find((s) => s.conclusion === "success");
  if (done) return { state: "done", title: done.name, present: true };
  if (mine.length && mine.every((s) => s.conclusion === "skipped")) {
    return { state: "skip", title: mine[0].name, present: true };
  }
  return { state: "todo", title: spec.steps[0], present: mine.length > 0 };
}

function notice(annotations: Annotation[], title: string): string {
  const hit = annotations.find((a) =>
    a.annotation_level === "notice" && (a.title ?? "") === title
  );
  return hit ? hit.message.trim() : "";
}

/**
 * A run in the panel's terms: its chips, a headline, the detail line the log
 * keeps, and the outcome colour. The iOS reading (signed, uploaded, the
 * headline wording the status line has always used) is lib/ios-publish.ts's.
 */
export function summarizeStoreRun(
  store: StoreId,
  run: WorkflowRun,
  jobs: WorkflowJob[] = [],
  annotations: Annotation[] = [],
  opts: { review?: boolean } = {},
): StoreRunSummary {
  const spec = STORES[store];
  const steps = stepsOf(jobs);
  const base = summarizeRun(run, jobs, annotations);
  const chips: Chip[] = [];
  for (const c of spec.chips) {
    const st = chipState(c, steps);
    if (c.optional && !st.present && !(store === "ios" && opts.review)) {
      continue;
    }
    chips.push({
      key: c.key,
      label: c.label,
      title: st.title,
      state: st.state,
    });
  }
  const errors = base.errors;
  const detail = notice(annotations, "Detail");
  const result = notice(annotations, "Result");
  const completed = run.status === "completed";
  const success = completed && run.conclusion === "success";
  const reviewed = chips.some((c) => c.key === "REVIEW" && c.state === "done");

  let headline: string;
  let outcome: Outcome;
  if (!completed) {
    headline = run.status === "in_progress"
      ? (base.step ? `${base.step}…` : "Building…")
      : spec.queued;
    outcome = "run";
  } else if (run.conclusion === "cancelled") {
    headline = "Cancelled.";
    outcome = "fail";
  } else if (!success) {
    headline = (base.step ? `Failed at "${base.step}".` : "Failed.") +
      (errors[0] ? ` ${errors[0]}` : "");
    outcome = "fail";
  } else if (store === "ios") {
    headline = base.uploaded
      ? (reviewed
        ? "Uploaded to TestFlight and submitted for review."
        : "Uploaded to TestFlight.")
      : base.headline;
    outcome = base.uploaded ? "ok" : "warn";
  } else {
    headline = result ||
      (store === "steam" ? "Uploaded with SteamPipe." : "Pushed with butler.");
    outcome = "ok";
  }

  return {
    store,
    id: run.id,
    number: run.run_number,
    url: run.html_url,
    status: run.status,
    conclusion: run.conclusion ?? null,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    step: base.step,
    chips,
    headline,
    detail,
    errors,
    outcome,
    signed: store === "ios" ? base.signed : null,
    uploaded: store === "ios" ? base.uploaded : null,
  };
}

export interface StoreArtifact {
  id: number;
  name: string;
  size: number;
  /** DOWNLOAD .IPA (ZIP, 48.2 MB) — what the link reads. */
  label: string;
}

/** The artifacts a run left, each with the label its link wears. */
export function storeArtifacts(list: RunArtifact[]): StoreArtifact[] {
  return summarizeArtifacts(list).map((a) => {
    const mb = (a.size / 1048576).toFixed(1);
    const what = a.name === "ios-ipa"
      ? ".IPA"
      : a.name.startsWith("steam-depot")
      ? "DEPOT"
      : a.name.startsWith("itch-")
      ? a.name.slice(5).toUpperCase()
      : a.name.toUpperCase();
    return { ...a, label: `DOWNLOAD ${what} (ZIP, ${mb} MB)` };
  });
}

// ── The repository's secrets, as the panel reads them ───────────────────────

export interface CredentialNote {
  /** true: the store can ship; false: the run stops short; null: not readable. */
  ok: boolean | null;
  text: string;
  /** The names that are not there, for the settings note. */
  missing: string[];
}

/**
 * What the STORES card says under the store's name, from the names GitHub
 * lists (null when the token may not list them — a run says for itself then).
 */
export function credentialNote(
  store: StoreId,
  names: string[] | null,
): CredentialNote {
  if (names === null) {
    return {
      ok: null,
      text: "SECRETS NOT READABLE WITH THIS TOKEN · THE RUN SAYS",
      missing: [],
    };
  }
  const has = (n: string) => names.includes(n);
  const missing = STORES[store].secrets.filter((n) => !has(n));
  if (store === "ios") {
    const signing = has("BUILD_CERTIFICATE_BASE64") &&
      has("BUILD_PROVISION_PROFILE_BASE64");
    const asc = has("ASC_KEY_ID") && has("ASC_ISSUER_ID") && has("ASC_API_KEY");
    if (!signing) {
      return {
        ok: false,
        text: "NO APPLE SECRETS · UNSIGNED DRY RUN",
        missing,
      };
    }
    return asc
      ? {
        ok: true,
        text: "APPLE SECRETS PRESENT · ASC API KEY PRESENT",
        missing,
      }
      : {
        ok: false,
        text: "APPLE SECRETS PRESENT · NO ASC API KEY · STOPS BEFORE UPLOAD",
        missing,
      };
  }
  if (store === "steam") {
    return has("STEAM_CONFIG_VDF") && has("STEAM_USERNAME")
      ? { ok: true, text: "STEAM_CONFIG_VDF PRESENT", missing }
      : { ok: false, text: "NO STEAM SECRETS · STOPS BEFORE UPLOAD", missing };
  }
  return has("BUTLER_API_KEY")
    ? { ok: true, text: "BUTLER_API_KEY PRESENT", missing }
    : { ok: false, text: "NO BUTLER_API_KEY · STOPS BEFORE PUSH", missing };
}

// ── The log ─────────────────────────────────────────────────────────────────

export interface LogEntry {
  store: StoreId;
  id: number;
  number: number;
  url: string;
  createdAt: string;
  outcome: Outcome;
  headline: string;
  detail: string;
  artifacts: (StoreArtifact & { url: string })[];
}

/** Newest first, whatever the store. */
export function sortLog<T extends { createdAt: string }>(entries: T[]): T[] {
  return entries.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
