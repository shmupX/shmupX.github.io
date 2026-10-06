// routes/api/player.ts names whoever is at the serving machine, which the
// editor credits a Dezaemon export to. The name is the account's, else the
// home directory's, and it is told only to that machine's own browser.

import { assertEquals, assertStrictEquals } from "@std/assert";
import { handler, hostUser } from "../routes/api/player.ts";

const env = (vars: Record<string, string>) => (key: string) => vars[key];

Deno.test("the player is the account name, else the home directory's", () => {
  assertStrictEquals(hostUser(env({ USER: "dan", HOME: "/home/x" })), "dan");
  assertStrictEquals(hostUser(env({ USERNAME: "Deck" })), "Deck");
  // A sandbox that clears USER still has somewhere to live.
  assertStrictEquals(hostUser(env({ HOME: "/var/home/dan" })), "dan");
  assertStrictEquals(
    hostUser(env({ USERPROFILE: "C:\\Users\\deck" })),
    "deck",
  );
  assertStrictEquals(hostUser(env({})), null);
});

Deno.test("one variable the process may not read does not cost the others", () => {
  assertStrictEquals(
    hostUser((key) => {
      if (key === "USER") throw new Error("denied");
      return key === "HOME" ? "/home/dan" : undefined;
    }),
    "dan",
  );
});

type Get = (ctx: unknown) => Response | Promise<Response>;
const get = (handler as unknown as { GET: Get }).GET;
const ask = async (
  hostname: string | null,
  headers: Record<string, string> = {},
) => {
  const res = await get({
    req: new Request("http://127.0.0.1:8787/api/player", { headers }),
    info: hostname
      ? { remoteAddr: { transport: "tcp", hostname, port: 1 } }
      : undefined,
  });
  return { status: res.status, body: await res.json() };
};

Deno.test("only the machine's own browser is told the name", async () => {
  const own = await ask("127.0.0.1", { host: "127.0.0.1:8787" });
  assertEquals(own.body, { available: true, user: hostUser() });

  // A second PC on the LAN, and a phone on the dev tunnel.
  for (
    const remote of [
      await ask("192.168.1.20", { host: "192.168.1.5:8787" }),
      await ask("127.0.0.1", {
        host: "abc.ts.net",
        "x-forwarded-for": "203.0.113.9",
      }),
    ]
  ) {
    assertEquals(remote.body, { available: false, reason: "remote client" });
  }

  // Another site's page cannot read it either.
  const cross = await ask("127.0.0.1", {
    host: "127.0.0.1:8787",
    "sec-fetch-site": "cross-site",
  });
  assertStrictEquals(cross.status, 403);
  assertStrictEquals("user" in cross.body, false);
});
