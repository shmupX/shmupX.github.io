// scripts/level-alias.ts — give a cloud game other names to be reached by.
//
//   deno task level:alias                                        # every alias
//   deno task level:alias 2019-PS2                               # one game's
//   deno task level:alias 2019-PS2 2019 streetfighter            # what it would add; writes nothing
//   deno task level:alias 2019-PS2 2019 streetfighter -- --write # add them
//   deno task level:alias -- --remove streetfighter --write      # take one back
//
// An alias is another label for a level: with `2019 -> 2019-PS2`,
// 2019.codemonkey.games opens the game the way 2019-ps2.codemonkey.games does,
// and so does /games/2028-ai?level=2019. The index is RTDB
// `levelAliases/<alias>` = the level's key, beside `levels/`; the subdomain
// redirect (lib/level-subdomain.ts) and the level loader's fetchLevel both
// read it. lib/level-subdomain.ts's planAliases has the rules: a lowercase DNS
// label, never a name a level already has, never one another level holds.
//
// WRITES ARE OPT-IN, as in level:normalize: without `--write` this prints what
// it would set and stops. A write PATCHes only the aliases named.

import {
  ALIASES_PATH,
  isAliasName,
  LEVELS_DB,
  LEVELS_PATH,
  planAliases,
} from "../lib/level-subdomain.ts";

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${LEVELS_DB}/${path}`);
  if (!res.ok) fail(`could not read ${path}: ${res.status}`);
  return await res.json();
}

async function patchAliases(body: Record<string, string | null>) {
  const res = await fetch(`${LEVELS_DB}/${ALIASES_PATH}.json?print=silent`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(`could not write ${ALIASES_PATH}: ${res.status}`);
}

const args = Deno.args.filter((arg) => arg !== "--");
const write = args.includes("--write");
const removeAt = args.indexOf("--remove");
const removing = removeAt >= 0
  ? args.slice(removeAt + 1).filter((a) => !a.startsWith("--"))
  : [];
const names = (removeAt >= 0 ? args.slice(0, removeAt) : args)
  .filter((arg) => !arg.startsWith("--"));

const rawAliases = (await getJson(`${ALIASES_PATH}.json`) ?? {}) as Record<
  string,
  unknown
>;
const aliases: Record<string, string> = {};
for (const [name, key] of Object.entries(rawAliases)) {
  if (typeof key === "string") aliases[name] = key;
}

const list = (only?: string) => {
  const rows = Object.entries(aliases)
    .filter(([, key]) => only === undefined || key === only)
    .sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) {
    console.log(
      only === undefined ? "No aliases yet." : `"${only}" has no aliases.`,
    );
  }
  for (const [name, key] of rows) console.log(`${name} -> ${key}`);
};

if (removing.length) {
  const body: Record<string, null> = {};
  for (const raw of removing) {
    const name = raw.toLowerCase();
    if (!isAliasName(name) || !Object.hasOwn(aliases, name)) {
      fail(`"${raw}" is not an alias`);
    }
    body[name] = null;
    console.log(`- ${name} (was ${aliases[name]})`);
  }
  if (!write) {
    console.log("\nDry run — nothing written. Re-run with --write to remove.");
    Deno.exit(0);
  }
  await patchAliases(body);
  console.log("Removed.");
  Deno.exit(0);
}

if (names.length === 0) {
  list();
  Deno.exit(0);
}

const keys = Object.keys(
  (await getJson(`${LEVELS_PATH}.json?shallow=true`) ?? {}) as object,
);
const [level, ...wanted] = names;
const plan = planAliases(level, wanted, keys, aliases);
if (plan.errors.length) fail(plan.errors.join("\n       "));
if (wanted.length === 0) {
  list(plan.key!);
  Deno.exit(0);
}
const adds = Object.entries(plan.set);
if (!adds.length) {
  console.log(`Nothing to add: "${plan.key}" already answers to those.`);
  Deno.exit(0);
}
for (const [name, key] of adds) console.log(`+ ${name} -> ${key}`);
if (!write) {
  console.log("\nDry run — nothing written. Re-run with --write to add them.");
  Deno.exit(0);
}
await patchAliases(plan.set);
console.log("Added.");
