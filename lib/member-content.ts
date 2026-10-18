// What the Steam build leaves out, and the member packs that bring it back.
//
// Everything under static/ reaches a packaged launcher (the binary embeds
// _fresh/client, Vite's copy of static/). Some of it is not this project's to
// put on a storefront: a commercial cartridge and the console firmware it
// boots on, arcade boards, other people's saves, commercial music, a Nintendo
// ROM hack. `deno task build:steam` leaves every file these rules match out of
// the binary and writes them into member packs instead — one zip per pack,
// holding the files at their own URL paths plus a member.json — and the Steam
// build serves a pack's files from the zip itself once it is dropped into a
// members folder (lib/member-packs.ts). Nothing is extracted and nothing is
// fetched: the pack is the content.
//
// The table is the whole policy. A file belongs to the first pack whose rule
// matches its URL path; a pack whose files are absent from this checkout is
// simply not written. REVIEW lists what the rules cannot separate by file and
// is printed on every Steam build, because a judgement about what may be sold
// is the project owner's, not this script's.

import { ROMSET_PATH } from "./streamed-payloads.ts";

/** One member pack: what it holds, whose it is, and which paths it takes. */
export interface MemberPack {
  /** The zip is `shmupx-member-<id>.zip`. */
  id: string;
  title: string;
  /** Why the Steam build cannot carry it. */
  why: string;
  /** Does this URL path ("/snes/Dezaemon.sfc") belong to the pack? */
  match(path: string): boolean;
}

/**
 * A served file the Steam build still answers for when its pack is absent:
 * the saves manifest lists the whole collection, so without the saves the
 * shelf must see an empty one rather than a list of files that 404.
 */
export const MEMBER_DEFAULTS: Readonly<Record<string, string>> = {
  "/editor/dezaemon/saves.manifest.json": JSON.stringify({ saves: [] }),
};

const re = (...patterns: RegExp[]) => (path: string) =>
  patterns.some((p) => p.test(path));

/**
 * The packs. `arcadeRomsets` is the catalogue's own list (data/eshop.json's
 * arcade rows), so a board added to the eShop moves into the arcade pack
 * without this table changing; any other path of a romset's shape counts too,
 * so a board the catalogue gains after the build is never downloaded by a
 * Steam build either.
 */
export function memberPacks(arcadeRomsets: readonly string[]): MemberPack[] {
  const romsets = new Set(arcadeRomsets);
  return [
    {
      id: "dezaemon-sfc",
      title: "Dezaemon (Super Famicom) cartridge",
      why: "Athena's 1994 cartridge, staged by `deno task sfc:stage`",
      match: re(/^\/snes\/[^/]+\.(sfc|smc)$/i),
    },
    {
      id: "dezaemon-3d",
      title: "Dezaemon 3D and the 64DD IPL",
      why: "Athena's cartridge and Nintendo's IPL (`deno task n64:stage`), " +
        "with the fan translation's patch, which is useless without them",
      match: re(/^\/n64dd\/[^/]+\.(z64|n64|v64|bin|ndd|xdelta)$/i),
    },
    {
      id: "dezaemon-2-disc",
      title: "Dezaemon 2's 3D part library",
      why: "ポリ吉's meshes, decoded off Athena's Saturn disc " +
        "(`deno task deza:meshlib`); the model viewer draws placeholders " +
        "without them",
      match: re(/^\/editor\/dezaemon\/mesh-library\.json$/),
    },
    {
      id: "dezaemon-saves",
      title: "The community Dezaemon 2 save collection",
      why: "other people's games, collected in static/editor/dezaemon/saves/",
      match: re(
        /^\/editor\/dezaemon\/saves\//,
        /^\/editor\/dezaemon\/saves\.manifest\.json$/,
      ),
    },
    {
      id: "arcade",
      title: "Arcade boards",
      why: "commercial arcade romsets (the eShop's arcade rows)",
      match: (path) => romsets.has(path) || ROMSET_PATH.test(path),
    },
    {
      id: "2028-ai-soundtrack",
      title: "2028.Ai's custom soundtrack",
      why: "commercial tracks (`deno task 2028-ai:bgm`)",
      match: re(/^\/games\/2028-ai\/assets\/custom-bgm\//),
    },
    {
      id: "2028-ai-street-fighter",
      title: "2028.Ai's boss music and voices",
      why: "Capcom's Street Fighter music and voice clips for the six bosses",
      match: re(
        /^\/games\/2028-ai\/assets\/sounds\/boss_(barlog|bison|fang|goki|sagat|vega)_[^/]+$/,
      ),
    },
    {
      id: "super-mario-sp",
      title: "Super Mario SP",
      why: "a Super Mario World ROM hack: Nintendo's game and characters",
      // Its eShop archive is LEFT_OUT of every packaged build already.
      match: re(/^\/games\/super-mario-sp\//),
    },
  ];
}

/** The pack a URL path belongs to, or null when the Steam build carries it. */
export function packFor(
  path: string,
  packs: readonly MemberPack[],
): MemberPack | null {
  return packs.find((p) => p.match(path)) ?? null;
}

/**
 * What the rules cannot take out by file, said on every Steam build. Each is
 * a call for the project's owner to make before a store page goes up.
 */
export const REVIEW: readonly string[] = [
  "2028.Ai's sprite atlas (static/games/2028-ai/assets/img/game_asset.png) " +
  "packs the Street Fighter bosses' frames (bison_*, barlog_*, fang_*…) in " +
  "with the game's own art, so they cannot be left out by file; their music " +
  "and voices are in the 2028-ai-street-fighter pack.",
  "2028.Ai's announcer voices (assets/sounds/voice_*: ROUND, FIGHT, K.O.) " +
  "are not traced to a source here.",
  "The engine and the 2028-ai bundle carry tables extracted from Dezaemon " +
  "2's binaries (packages/shmup-engine/data: boss movement and appearance " +
  "scripts, the accompaniment patterns, the tone bank map).",
  "Online, the Dezaemon shelf still lists the community library from the " +
  "Realtime Database, and eShop entries and emulator cores still download " +
  "on request, as they do on the website.",
];

/** The archive name of a pack. */
export function packFileName(id: string): string {
  return `shmupx-member-${id}.zip`;
}

/** What a pack carries about itself, as member.json at the archive's root. */
export interface MemberManifest {
  format: "shmupx.member-pack";
  version: 1;
  id: string;
  title: string;
  why: string;
  /** When it was packed, ISO 8601. */
  built: string;
  /** URL paths, sorted. */
  files: string[];
}

export const MEMBER_FORMAT = "shmupx.member-pack";
