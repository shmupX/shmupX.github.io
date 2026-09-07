import { define } from "../../../utils.ts";

// GET /api/eshop/zip?repo=<owner/name>&branch=<branch>[&ref=<40-hex sha>] —
// same-origin proxy for a GitHub zipball.
//
// The eShop installs a "web" game entirely in the browser: fetch a zip, unzip
// it (static/zip-read.js), file every entry in Cache Storage under
// /eshop/<id>/ (static/eshop-library.js). That fetch runs from the page, and
// codeload.github.com sends NO CORS headers, so the browser cannot read a
// codeload zip directly. This route fetches it server-side and streams it
// back from our own origin — which is why a github catalog entry with no
// downloadUrl of its own still installs (the installer defaults to this URL,
// C1 of the redesign), and why a build never has to be committed anywhere.
// Read-only — it proxies bytes and writes nothing — so it is allowed on the
// hosted deploy as well as local launchers. Ported from cmg's
// routes/api/cmgnet/zip.ts.
//
// `ref` pins the archive to one commit (the sha static/eshop-library.js's
// latestSha resolved) so an install is the exact newest build rather than
// whatever a CDN still holds for the branch.
//
// The upstream URL is built only from values that passed the patterns below —
// never from anything URL-shaped a caller sends — so the route cannot be
// turned into an open proxy, and a "branch" of "../../x" cannot walk the
// codeload path.

const OWNER_OR_NAME = /^[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9_./-]+$/;
const SHA = /^[0-9a-f]{40}$/;

/** "owner/name", or null when it is anything else. */
export function parseRepo(
  raw: string,
): { owner: string; name: string } | null {
  const parts = raw.trim().split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!OWNER_OR_NAME.test(owner) || !OWNER_OR_NAME.test(name)) return null;
  // "." and ".." pass the character class but are not repository names.
  if (/^\.\.?$/.test(owner) || /^\.\.?$/.test(name)) return null;
  return { owner, name };
}

/** A branch name codeload will accept in a path: no empty or dot segments. */
export function validBranch(branch: string): boolean {
  return BRANCH.test(branch) &&
    branch.split("/").every((seg) => seg && seg !== "." && seg !== "..");
}

export function codeloadUrl(
  owner: string,
  name: string,
  branch: string,
  ref: string | null,
): string {
  const base = `https://codeload.github.com/${owner}/${name}/zip/`;
  return ref
    ? `${base}${ref}`
    : `${base}refs/heads/${
      branch.split("/").map(encodeURIComponent).join("/")
    }`;
}

export const handler = define.handlers({
  async GET(ctx) {
    const url = new URL(ctx.req.url);
    const repo = parseRepo(url.searchParams.get("repo") || "");
    if (!repo) {
      return Response.json(
        { ok: false, error: 'repo must be "owner/name"' },
        { status: 400 },
      );
    }
    const branch = (url.searchParams.get("branch") || "main").trim() || "main";
    if (!validBranch(branch)) {
      return Response.json({ ok: false, error: "invalid branch" }, {
        status: 400,
      });
    }
    const ref = url.searchParams.get("ref");
    if (ref !== null && !SHA.test(ref)) {
      return Response.json(
        { ok: false, error: "ref must be a 40-hex commit sha" },
        { status: 400 },
      );
    }

    const zipUrl = codeloadUrl(repo.owner, repo.name, branch, ref);
    let upstream: Response;
    try {
      upstream = await fetch(zipUrl);
    } catch (e) {
      return Response.json(
        { ok: false, error: `upstream fetch failed: ${(e as Error).message}` },
        { status: 502 },
      );
    }
    if (!upstream.ok || !upstream.body) {
      return Response.json(
        {
          ok: false,
          error:
            `github returned HTTP ${upstream.status} for ${repo.owner}/${repo.name}@${
              ref ?? branch
            }`,
        },
        { status: upstream.status === 404 ? 404 : 502 },
      );
    }
    // Stream the bytes straight through. Content-Length is usually absent on
    // codeload (chunked), so the installer's progress runs on bytes seen and
    // finishes during the unzip. no-store: the sha in the URL is the freshness
    // guarantee, a cached branch zip would defeat it.
    return new Response(upstream.body, {
      headers: {
        "content-type": "application/zip",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${repo.name}-${
          ref ? ref.slice(0, 7) : branch.replaceAll("/", "-")
        }.zip"`,
      },
    });
  },
});
