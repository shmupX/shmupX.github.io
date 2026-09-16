import { define } from "../../utils.ts";
import { crossSiteGuard, isDeploy } from "../../lib/local-guards.ts";
import {
  DEZAEMON_PSX_TITLE,
  findPsxCards,
  findPsxDiscs,
  PSX_PLAYER_BIOS,
  PSX_REGION_BIOS,
  psxDiscZipEtag,
  psxDiscZipLength,
  psxDiscZipStream,
  repoRoot,
} from "../../lib/dezaemon-psx.ts";

// GET /api/dezaemon-psx            — which PlayStation Dezaemons are on this
//                                    machine, and which memory cards.
// GET /api/dezaemon-psx?zip=<id>   — one of those discs, as the zip the PSX
//                                    player boots.
//
// The third of these: /api/dezaemon-disc asks the same question of the Sega
// Saturn and /api/dezaemon-sfc of the Super Famicom. The launcher asks after
// it has read the emulator catalogue, and a yes is what gives the PLAYSTATION
// section its local rows — one per disc found in dev-fixtures/ — and installs
// the psx core for them (Dashboard.svelte, initDezaemonPsx). Launching one of
// those rows opens cmg's /psx/play.html in bring-your-own-disc mode, and when
// the player says it is ready the launcher fetches the second URL and posts
// the zip into the frame as a File — which is how a disc that exists only on
// this disk reaches a player that otherwise loads its games from the cmg
// origin. lib/dezaemon-psx.ts finds the discs, reads the cards and streams
// the zip.
//
// A disc is named here by its PRODUCT CODE — ?zip=slps-01503 — and not by its
// game. The Saturn route gets away with a boolean ?zip=1 because there is one
// Dezaemon 2 image and there can only ever be one; this route knows three
// discs across two games, and two of them are the same game: Dezaemon+
// (SLPS-00335) and its 1998 re-release Dezaemon Plus Select 100 (SLPS-01504).
// ?zip=plus would boot whichever of the two the directory listing happened to
// sort first, silently. So a bare ?zip=1 is refused with a 400 that names the
// ids this machine actually has, rather than guessing at one.
//
// The memory cards are LISTED, and that is the whole of it. The fixtures tree
// this was written against holds 165 of them and every one is readable —
// lib/dezaemon-psx.ts names each from its title frame without decompressing
// anything — but nothing in this project can yet write a card into the
// emulator's memory card, and nothing maps one to a game.json either. So no
// card bytes leave this route, there is no ?card= branch, and the launcher
// draws one row per game instead of 165 rows with no Play behind them.
//
// Each disc reports the BIOS its own region wants (`bios`, derived from the
// product code's prefix) beside the one the player will actually load
// (`playerBios`). They differ for every disc that can turn up here: both
// Dezaemons are Japanese SLPS discs, and /psx/play.html hardcodes
// EJS_biosUrl = "/bios/scph5501.bin", the US image. /bios/scph5500.bin is
// mirrored onto this origin and perfectly reachable, but that page is cmg's
// and the bring-your-own-disc message it reads carries a file and a name and
// nothing else — so reporting both and letting the row say "JP disc, US BIOS"
// is not a stopgap, it is everything this repository can do about it.
//
// There is no `mednafen` field, unlike the Saturn answer above it: there is
// no PlayStation companion in packages/shmup-harbor to ask, and a field that
// is always null reads as a promise that one is coming.
//
// LOCAL-ONLY: it describes and serves files from the user's disk. On the
// hosted deploy (which has no dev-fixtures/ anyway) it answers "not
// available" rather than looking; elsewhere the Fetch Metadata gate keeps a
// cross-site page from reading which files the user has.

// The pregap clause is not padding: a dump that keeps track 1's 150-sector
// lead-in pushes the volume descriptor 150 sectors past where openDisc looks
// for it, and openDisc then returns null with no error of its own. This
// string is the only place a user is ever told that their image is fine and
// their dump is not.
const NOT_HERE = "no PlayStation Dezaemon disc image in dev-fixtures/ (a " +
  ".cue, .bin, .iso or .img whose SYSTEM.CNF boots SLPS-01503, SLPS-00335 " +
  "or SLPS-01504, or whose ISO 9660 root holds KIDS.EXE and KIDS_DAT.BIN, " +
  "or MAIN.EXE and an UPLOAD directory; a dump carrying track 1's 150-sector " +
  "pregap is not read, and $DEZAEMON_PSX_DISC is looked at too)";

/**
 * The BIOS a disc's region asks for, or null when the product code's prefix
 * is not one this repo has a mapping for. Null rather than a guess: the
 * launcher builds its caveat by comparing this against the player's
 * hardcoded BIOS, so an invented value would either manufacture a mismatch
 * that is not there or paper over one that is.
 */
function regionBios(region: string | null): string | null {
  if (!region) return null;
  return PSX_REGION_BIOS[region as keyof typeof PSX_REGION_BIOS] ?? null;
}

export const handler = define.handlers({
  async GET(ctx) {
    const url = new URL(ctx.req.url);
    // An id, not a flag — see the header. null means "just the listing".
    const wantZip = url.searchParams.get("zip");
    if (isDeploy()) {
      // Empty arrays rather than absent fields. Every consumer of this
      // answer reads `discs` and `cards` straight — the row builder maps one
      // and the card grouping filters the other — and this is the one reply
      // that can reach a browser with nothing to retry against, so it is the
      // one worth spending two tokens to make unsurprising.
      return Response.json(
        { available: false, reason: "local only", discs: [], cards: [] },
        { status: wantZip ? 404 : 200 },
      );
    }
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;

    const extra = [Deno.env.get("DEZAEMON_PSX_DISC") ?? ""].filter(Boolean);
    const root = await repoRoot();

    if (wantZip !== null) {
      const discs = await findPsxDiscs(root, { extra });
      if (wantZip === "1" || wantZip === "") {
        // Answering the Saturn's spelling with a disc would be worse than
        // answering it with an error: two of the three codes are the same
        // game, so "the first one" is a coin toss the caller cannot see.
        return Response.json({
          ok: false,
          error: "name a disc: ?zip=<product code>, e.g. ?zip=slps-01503" +
            (discs.length
              ? "; here: " + discs.map((d) => d.id).join(", ")
              : ""),
        }, { status: 400 });
      }
      const disc = discs.find((d) => d.id === wantZip.toLowerCase()) ?? null;
      if (!disc) {
        return Response.json({ ok: false, error: NOT_HERE }, { status: 404 });
      }
      // Before the stream exists, not after: the launcher asks for these
      // bytes on every PlayStation launch and the body is the whole disc — a
      // MODE2/2352 rip of Dezaemon Kids! is 511,229,376 bytes of .bin — so a
      // 304 here is the difference between half a gigabyte read off the disk
      // and none of it. The tag covers the track files' names, sizes and
      // mtimes and the cue text, which is exactly the set of things that can
      // change the zip's bytes.
      const etag = await psxDiscZipEtag(disc);
      if (ctx.req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      // A real content-length for a body that is never assembled: every entry
      // in the zip is STORED, so its total is arithmetic over the entry sizes
      // and psxDiscZipLength knows it before the first sector is read. That
      // buys the browser a progress bar instead of an open-ended chunked
      // download — and it has to agree with the stream to the byte, or the
      // player unzips a truncated disc and blames the rip.
      return new Response(psxDiscZipStream(disc), {
        headers: {
          "content-type": "application/zip",
          "content-length": String(psxDiscZipLength(disc)),
          "content-disposition": `attachment; filename="${disc.content}.zip"`,
          etag,
        },
      });
    }

    // No ?card= branch, and this is the deliberate absence rather than an
    // oversight: nothing downstream consumes card bytes — neither the mapper
    // that would turn a save into a game.json nor the writer that would push
    // one into the emulator's memory card exists — so serving them would be
    // opening files from a query string for no reader. A route that serves no
    // path the caller named cannot be argued into serving the wrong one, and
    // the alternative is the realPath-and-containment dance at
    // routes/api/build-artifact.ts:117-135.
    const discs = await findPsxDiscs(root, { extra });
    const cards = await findPsxCards(root);
    const answer = {
      // Discs alone decide. A section carrying only card rows is a section
      // there is nothing to press A in, and turning this one on auto-installs
      // a MIRRORED core — a service-worker registration that outlives the
      // visit, plus ~12 MB warmed (static/ps2-library.js:170-177 makes this
      // argument at length for the local cores that avoid it).
      available: discs.length > 0,
      title: DEZAEMON_PSX_TITLE,
      discs: discs.map((d) => ({
        id: d.id,
        game: d.game,
        title: d.title,
        // The code this disc carries, not the code its game is filed under:
        // a Select 100 row that claimed SLPS-00335 would send someone
        // hunting for a disc they do not own.
        code: d.code,
        codeFrom: d.codeFrom,
        region: d.region,
        content: d.content,
        cue: `${d.content}.cue`,
        // Reported, never smoothed over: a cue written here is a single
        // TRACK 01 / INDEX 01 00:00:00, so a rip whose BGM is Red Book audio
        // boots with silent music and nothing on screen to say why. The row
        // is where that becomes a sentence; here it is just the fact.
        cueFrom: d.cueFrom,
        // Names and sizes, never d.files[i].path. The answer says what the
        // user has, not where on their disk it is sitting.
        files: d.files.map((f) => ({ name: f.name, size: f.size })),
        zip: `/api/dezaemon-psx?zip=${d.id}`,
        zipName: `${d.content}.zip`,
        zipSize: psxDiscZipLength(d),
        bios: regionBios(d.region),
        playerBios: PSX_PLAYER_BIOS,
      })),
      // Field by field rather than the record itself: JSON.stringify renders
      // a Uint8Array as {"0":12,"1":255,…}, so the day a card record grows a
      // `data` or `graphics` field this would quietly become a megabyte of
      // JSON per save. The cheap path in lib/dezaemon-psx.ts holds no sample
      // buffers today; this is what keeps that true if it ever does.
      cards: cards.map((c) => ({
        id: c.id,
        game: c.game,
        name: c.name,
        title: c.title,
        filename: c.filename,
        container: c.container,
        from: c.from,
        size: c.size,
        fileSize: c.fileSize,
        deleted: c.deleted,
      })),
      // The same number as `cards.length` by construction — the array above is
      // a one-for-one projection of this one — and stated anyway, because this
      // answer is read raw as often as it is read by the launcher (the
      // launcher itself groups by game and counts per group) and because the
      // cap needs somewhere to be admitted: psxCardCandidates stops at
      // CARD_LIMIT candidate FILES, so a fixtures tree bigger than that
      // under-counts both this and `cards` alike rather than going slow.
      cardsTotal: cards.length,
    };
    if (answer.available) return Response.json(answer);
    return Response.json({ ...answer, reason: NOT_HERE });
  },
});
