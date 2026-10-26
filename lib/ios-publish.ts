// lib/ios-publish.ts — publish one cloud level as an iOS build, on a Mac this
// machine does not have.
//
// Every other target the editor exports is built right here (lib/export-build
// in @shmupx/shmup-harbor): the Android SDK for an APK, Deno alone for the
// desktop three and the PS2 disc. iOS is the one target only Xcode can finish,
// and Xcode runs only on a Mac — so off a Mac the local export has always
// stopped at an Xcode project, which nobody can install, and the editor said
// so. PUBLISH IOS BUILD takes the other road: it dispatches
// .github/workflows/ios-publish.yml, a GitHub-hosted Mac that stages the level
// with the very tool the local export uses, signs the archive with the Apple
// certificate in the repository's secrets, exports an .ipa and uploads it to
// TestFlight — the pipeline 2019-es7 has shipped through for a year, pointed at
// a level instead of a checkout.
//
// This module is the client end of that, shared by routes/api/publish-ios.ts
// (the editor's button) and scripts/publish-ios.ts (the terminal):
//
//   * where the workflow lives and what may dispatch it — the repository and
//     ref, and a token: GITHUB_TOKEN, GH_TOKEN, or whatever `gh auth token`
//     answers, so a machine with the GitHub CLI signed in needs nothing set;
//   * a thin GitHub Actions client, with every refusal explained in terms of
//     what to do about it (push the workflow, widen the token);
//   * the matching rule that finds a run after a dispatch, since the dispatch
//     API answers 204 and names none: the run's title carries a request id
//     this side minted (the workflow's `run-name`), and the newest run whose
//     title ends in it is the one;
//   * summarizeRun — the one reading of a run both the status line and the
//     terminal show: which step it is on, whether it signed, whether Apple
//     took the upload, and the workflow's own ::error annotations, which is
//     how "Apple wants an agreement signed" reaches the editor instead of
//     "exit 1".
//
// Nothing here touches the disk or Apple. The build, the signing and the upload
// are the workflow's; this knows the GitHub API and the workflow's step names,
// and tests/ios_publish_test.ts pins that the two agree.

export const WORKFLOW_FILE = "ios-publish.yml";
export const DEFAULT_REPO = "shmupX/shmupX.github.io";
export const DEFAULT_REF = "main";

// The bundle id the workflow signs and uploads as when nothing says otherwise:
// 2019-es7's "2028.ai", the App Store Connect record the cloud game "foo" has
// been uploaded to and tested on devices under. Repeated here only so the
// status line can name it; the workflow owns the default.
export const DEFAULT_BUNDLE_ID = "com.easierbycode.game2028";

// Step names, as the workflow spells them. summarizeRun reads a run's outcome
// off these — tests/ios_publish_test.ts checks the YAML still carries them.
export const STEP_STAGE = "Stage the game as an Xcode project";
export const STEP_SIGNED = "Archive and export the signed .ipa";
export const STEP_UNSIGNED = "Archive an unsigned .ipa";
export const STEP_UPLOAD = "Upload to TestFlight";

export type Env = Record<string, string | undefined>;

export interface PublishConfig {
  /** owner/name of the repository whose Actions build the app. */
  repo: string;
  /** The branch (or tag) the workflow file is read from. */
  ref: string;
  /** The workflow file's name under .github/workflows. */
  workflow: string;
}

/**
 * Which repository and ref to dispatch. SHMUPX_IOS_REPO / SHMUPX_IOS_REF
 * override the defaults for a fork, or for trying the workflow on a branch
 * before it is on main — workflow_dispatch only knows a workflow file that is
 * on the ref it is asked for.
 */
export function publishConfig(env: Env = Deno.env.toObject()): PublishConfig {
  return {
    repo: (env.SHMUPX_IOS_REPO ?? "").trim() || DEFAULT_REPO,
    ref: (env.SHMUPX_IOS_REF ?? "").trim() || DEFAULT_REF,
    workflow: WORKFLOW_FILE,
  };
}

export function actionsUrl(cfg: PublishConfig): string {
  return `https://github.com/${cfg.repo}/actions/workflows/${cfg.workflow}`;
}

// ── The token ───────────────────────────────────────────────────────────────

export type TokenSource = "GITHUB_TOKEN" | "GH_TOKEN" | "gh";
export interface Token {
  token: string;
  source: TokenSource;
}

/** Run a command and hand back its trimmed stdout, or null when it is not there or fails. */
export type Exec = (cmd: string, args: string[]) => Promise<string | null>;

export const execCapture: Exec = async (cmd, args) => {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "null",
      stdin: "null",
      signal: AbortSignal.timeout(8000),
    }).output();
    if (!out.success) return null;
    const text = new TextDecoder().decode(out.stdout).trim();
    return text || null;
  } catch {
    return null;
  }
};

/**
 * The token a dispatch goes out with: GITHUB_TOKEN, then GH_TOKEN, then what
 * the GitHub CLI is signed in with. The environment wins over the CLI so a
 * token meant for this (say, one scoped to the one repository) is never
 * shadowed by whatever `gh` happens to hold.
 */
export async function resolveToken(
  env: Env = Deno.env.toObject(),
  exec: Exec = execCapture,
): Promise<Token | null> {
  for (const source of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
    const token = (env[source] ?? "").trim();
    if (token) return { token, source };
  }
  const fromGh = await exec("gh", ["auth", "token"]);
  if (fromGh) return { token: fromGh.split("\n")[0].trim(), source: "gh" };
  return null;
}

export function noTokenHint(cfg: PublishConfig): string {
  return `Set GITHUB_TOKEN to a token that may run Actions on ${cfg.repo} ` +
    "(classic: the repo and workflow scopes; fine-grained: Actions read and " +
    "write), or sign the GitHub CLI in with `gh auth login` — the server reads " +
    "`gh auth token`.";
}

// ── Naming the run ──────────────────────────────────────────────────────────

// No 0/1/i/l/o: an id is read back off a run title by eye as often as by code.
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** A request id: ten letters nobody will type, unique enough for a run list. */
export function newRequestId(
  random: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => {
    crypto.getRandomValues(b);
  },
): string {
  const bytes = new Uint8Array(10);
  random(bytes);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

/** The workflow's `run-name`, as it will read with this level and request. */
export function runNameFor(level: string, request: string): string {
  return `iOS · ${level} · ${request}`;
}

/** Is this run the one dispatched under `request`? The title ends in the id. */
export function matchesRequest(
  run: { display_title?: string | null; name?: string | null },
  request: string,
): boolean {
  if (!request) return false;
  const title = run.display_title ?? run.name ?? "";
  return title.endsWith(` · ${request}`);
}

// ── The GitHub Actions client ───────────────────────────────────────────────

/** A refusal the caller should relay: the status an HTTP route answers with, and what to do. */
export class PublishError extends Error {
  constructor(
    message: string,
    /** HTTP status for the API route; 502 for GitHub's own failures. */
    readonly status = 502,
    /** The way through, when there is one. */
    readonly hint = "",
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export interface WorkflowRun {
  id: number;
  name: string;
  display_title: string;
  html_url: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  run_number: number;
  event: string;
}

export interface WorkflowStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  steps?: WorkflowStep[];
}

export interface RunArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  archive_download_url: string;
}

export interface Annotation {
  annotation_level: string;
  title: string | null;
  message: string;
}

export type Sleep = (ms: number) => Promise<void>;
const sleepFor: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface GitHubActionsOptions {
  token: string;
  repo: string;
  fetch?: typeof fetch;
  apiBase?: string;
}

export class GitHubActions {
  readonly repo: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiBase: string;

  constructor(opts: GitHubActionsOptions) {
    this.repo = opts.repo;
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? fetch;
    this.apiBase = (opts.apiBase ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "shmupX ios-publish",
    };
  }

  private async api(
    method: string,
    path: string,
    body?: unknown,
    init: RequestInit = {},
  ): Promise<Response> {
    const res = await this.fetchFn(`${this.apiBase}${path}`, {
      method,
      headers: {
        ...this.headers(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
    if (!res.ok) throw await this.explain(res, path);
    return res;
  }

  /** GitHub's refusal, in terms of what to do about it. */
  private async explain(res: Response, path: string): Promise<PublishError> {
    let message = "";
    try {
      const data = await res.json();
      message = typeof data?.message === "string" ? data.message : "";
    } catch { /* no body */ }
    const where = this.repo;
    switch (res.status) {
      case 401:
        return new PublishError(
          "GitHub rejected the token.",
          401,
          "Set GITHUB_TOKEN to a current token, or `gh auth login` again.",
        );
      case 403:
        return new PublishError(
          `The token may not run Actions on ${where}` +
            (message ? ` (${message})` : "") + ".",
          403,
          "A classic token needs the repo and workflow scopes; a fine-grained " +
            "one needs Actions read and write on this repository.",
        );
      case 404:
        return new PublishError(
          `GitHub has nothing at ${path} on ${where}.`,
          404,
          `Either ${WORKFLOW_FILE} is not on that ref yet — push it — or the ` +
            "token cannot see the repository.",
        );
      case 422:
        return new PublishError(
          `GitHub refused the request${message ? `: ${message}` : "."}`,
          422,
        );
      default:
        return new PublishError(
          `GitHub answered ${res.status}${message ? `: ${message}` : ""}.`,
          502,
        );
    }
  }

  /** Dispatch `workflow` on `ref` with `inputs` (strings: booleans spelled out). */
  async dispatch(
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void> {
    await this.api(
      "POST",
      `/repos/${this.repo}/actions/workflows/${workflow}/dispatches`,
      { ref, inputs },
    );
  }

  async listRuns(
    workflow: string,
    opts: { event?: string; perPage?: number } = {},
  ): Promise<WorkflowRun[]> {
    const q = new URLSearchParams({
      event: opts.event ?? "workflow_dispatch",
      per_page: String(opts.perPage ?? 20),
    });
    const res = await this.api(
      "GET",
      `/repos/${this.repo}/actions/workflows/${workflow}/runs?${q}`,
    );
    const data = await res.json();
    return Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
  }

  async run(id: number): Promise<WorkflowRun> {
    const res = await this.api("GET", `/repos/${this.repo}/actions/runs/${id}`);
    return await res.json();
  }

  async jobs(runId: number): Promise<WorkflowJob[]> {
    const res = await this.api(
      "GET",
      `/repos/${this.repo}/actions/runs/${runId}/jobs?per_page=50`,
    );
    const data = await res.json();
    return Array.isArray(data?.jobs) ? data.jobs : [];
  }

  async artifacts(runId: number): Promise<RunArtifact[]> {
    const res = await this.api(
      "GET",
      `/repos/${this.repo}/actions/runs/${runId}/artifacts`,
    );
    const data = await res.json();
    return Array.isArray(data?.artifacts) ? data.artifacts : [];
  }

  /**
   * The repository's secret NAMES — never a value; GitHub has no call that
   * gives one — or null when the token may not list them (a fine-grained
   * token without Secrets read, a collaborator's classic one). The PUBLISH
   * panel's credential lines read off this; a run says for itself otherwise.
   */
  async secretNames(): Promise<string[] | null> {
    try {
      const res = await this.api(
        "GET",
        `/repos/${this.repo}/actions/secrets?per_page=100`,
      );
      const data = await res.json();
      return Array.isArray(data?.secrets)
        ? data.secrets.map((s: { name: string }) => String(s.name))
        : [];
    } catch (e) {
      if (e instanceof PublishError && (e.status === 403 || e.status === 404)) {
        return null;
      }
      throw e;
    }
  }

  /** The repository's variables (name → value), or null when not readable. */
  async variables(): Promise<Record<string, string> | null> {
    try {
      const res = await this.api(
        "GET",
        `/repos/${this.repo}/actions/variables?per_page=100`,
      );
      const data = await res.json();
      const out: Record<string, string> = {};
      for (const v of Array.isArray(data?.variables) ? data.variables : []) {
        if (v && typeof v.name === "string") out[v.name] = String(v.value ?? "");
      }
      return out;
    } catch (e) {
      if (e instanceof PublishError && (e.status === 403 || e.status === 404)) {
        return null;
      }
      throw e;
    }
  }

  /** A job is a check run, and the workflow's ::error lines are its annotations. */
  async annotations(jobId: number): Promise<Annotation[]> {
    const res = await this.api(
      "GET",
      `/repos/${this.repo}/check-runs/${jobId}/annotations`,
    );
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }

  /**
   * The artifact's zip. GitHub answers with a redirect to a signed blob URL
   * that must be fetched WITHOUT the token — the store refuses a request that
   * carries two credentials — so the redirect is followed by hand.
   */
  async downloadArtifact(id: number): Promise<Response> {
    const first = await this.fetchFn(
      `${this.apiBase}/repos/${this.repo}/actions/artifacts/${id}/zip`,
      { headers: this.headers(), redirect: "manual" },
    );
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get("location");
      if (!location) {
        throw new PublishError("GitHub redirected the download nowhere.");
      }
      await first.body?.cancel();
      const blob = await this.fetchFn(location);
      if (!blob.ok) {
        throw new PublishError(
          `The artifact store answered ${blob.status}.`,
        );
      }
      return blob;
    }
    if (!first.ok) throw await this.explain(first, `/actions/artifacts/${id}`);
    return first;
  }

  /**
   * The run a dispatch started. GitHub registers it a few seconds after the
   * 204, so this looks `attempts` times, `delayMs` apart, for the newest run
   * whose title ends in `request`.
   */
  async findRun(
    workflow: string,
    request: string,
    opts: { attempts?: number; delayMs?: number; sleep?: Sleep } = {},
  ): Promise<WorkflowRun | null> {
    const attempts = Math.max(1, opts.attempts ?? 1);
    const sleep = opts.sleep ?? sleepFor;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(opts.delayMs ?? 1500);
      const runs = await this.listRuns(workflow);
      const hit = runs.find((r) => matchesRequest(r, request));
      if (hit) return hit;
    }
    return null;
  }
}

// ── Reading a run ───────────────────────────────────────────────────────────

export interface StepSummary {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface RunSummary {
  id: number;
  url: string;
  /** queued | in_progress | completed (GitHub's own words). */
  status: string;
  /** success | failure | cancelled | … once completed, else null. */
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  /** The step running now, or the one that failed. */
  step: string | null;
  steps: StepSummary[];
  /** Signed with the repository's certificate — null until the run has said. */
  signed: boolean | null;
  /** TestFlight has the build — false once skipped or refused, null until known. */
  uploaded: boolean | null;
  /** The workflow's ::error annotations, "Title: message". */
  errors: string[];
  /** One line for a status row. */
  headline: string;
}

function stepNamed(steps: StepSummary[], name: string): StepSummary | null {
  return steps.find((s) => s.name === name) ?? null;
}

/** What a run is up to, in the terms the status line needs. */
export function summarizeRun(
  run: WorkflowRun,
  jobs: WorkflowJob[] = [],
  annotations: Annotation[] = [],
): RunSummary {
  const steps: StepSummary[] = [];
  for (const job of jobs) {
    for (const s of job.steps ?? []) {
      steps.push({ name: s.name, status: s.status, conclusion: s.conclusion });
    }
  }
  const running = steps.find((s) => s.status === "in_progress");
  const failed = steps.find((s) => s.conclusion === "failure");
  const step = running?.name ?? failed?.name ?? null;

  const signedStep = stepNamed(steps, STEP_SIGNED);
  const unsignedStep = stepNamed(steps, STEP_UNSIGNED);
  let signed: boolean | null = null;
  if (signedStep?.conclusion === "success") signed = true;
  else if (unsignedStep?.conclusion === "success") signed = false;
  else if (signedStep?.conclusion === "skipped") signed = false;

  const uploadStep = stepNamed(steps, STEP_UPLOAD);
  let uploaded: boolean | null = null;
  if (uploadStep?.conclusion === "success") uploaded = true;
  else if (
    uploadStep?.conclusion === "skipped" || uploadStep?.conclusion === "failure"
  ) uploaded = false;
  else if (run.status === "completed") uploaded = false;

  const errors = annotations
    .filter((a) => a.annotation_level === "failure" && a.message)
    .map((a) => (a.title ? `${a.title}: ${a.message}` : a.message).trim());

  let headline: string;
  if (run.status === "completed") {
    if (run.conclusion === "success") {
      headline = uploaded
        ? "Uploaded to TestFlight."
        : signed === false
        ? "Unsigned .ipa built — nothing went to TestFlight."
        : "Signed .ipa built; not uploaded.";
    } else if (run.conclusion === "cancelled") {
      headline = "Cancelled.";
    } else {
      headline = (step ? `Failed at "${step}".` : "Failed.") +
        (errors[0] ? ` ${errors[0]}` : "");
    }
  } else if (run.status === "in_progress") {
    headline = step ? `${step}…` : "Building…";
  } else {
    headline = "Waiting for a GitHub Mac…";
  }

  return {
    id: run.id,
    url: run.html_url,
    status: run.status,
    conclusion: run.conclusion ?? null,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    step,
    steps,
    signed,
    uploaded,
    errors,
    headline,
  };
}

export interface ArtifactSummary {
  id: number;
  name: string;
  size: number;
}

/** The artifacts still there to download, smallest shape the UI needs. */
export function summarizeArtifacts(list: RunArtifact[]): ArtifactSummary[] {
  return list
    .filter((a) => !a.expired)
    .map((a) => ({ id: a.id, name: a.name, size: a.size_in_bytes }));
}

/** The inputs a dispatch carries, as strings — the API takes no booleans. */
export function dispatchInputs(opts: {
  level: string;
  request: string;
  bundleId?: string | null;
  upload?: boolean;
}): Record<string, string> {
  const inputs: Record<string, string> = {
    level: opts.level,
    request: opts.request,
  };
  const bundleId = (opts.bundleId ?? "").trim();
  if (bundleId) inputs.bundle_id = bundleId;
  if (opts.upload === false) inputs.upload = "false";
  return inputs;
}
