// lib/lan-address.ts picks the address the launcher hands another device — the
// link and the QR code under a finished build.
//
// The machine this runs on cannot be made to have a Docker bridge, a VPN tunnel
// and two wi-fi interfaces on demand, so the interface lists are fixtures:
// real `Deno.networkInterfaces()` output shapes from the kinds of machine that
// break this. Getting it wrong is quiet — the link simply times out on the
// phone, with nothing on the desktop to say why — which is the whole reason the
// choice is a pure function with a test rather than a first-match loop.

import { assertEquals } from "@std/assert";
import { lanOrigin, pickLanAddress } from "../lib/lan-address.ts";

const v4 = (name: string, address: string) => ({
  name,
  family: "IPv4",
  address,
});
const v6 = (name: string, address: string) => ({
  name,
  family: "IPv6",
  address,
});

Deno.test("a plain laptop: loopback loses to the wi-fi address", () => {
  assertEquals(
    pickLanAddress([v4("lo0", "127.0.0.1"), v4("en0", "192.168.0.174")]),
    "192.168.0.174",
  );
});

Deno.test("a developer's machine: the Docker bridge and the VPN do not win", () => {
  // 172.17.0.1 is Docker's default bridge; utun3 is a VPN that would carry the
  // request somewhere real, just not to the phone in the room.
  assertEquals(
    pickLanAddress([
      v4("lo0", "127.0.0.1"),
      v4("docker0", "172.17.0.1"),
      v4("utun3", "10.2.0.4"),
      v4("vboxnet0", "192.168.56.1"),
      v4("en0", "192.168.0.174"),
    ]),
    "192.168.0.174",
  );
});

Deno.test("a wired desktop on 10/8 still gets an answer", () => {
  assertEquals(
    pickLanAddress([v4("lo0", "127.0.0.1"), v4("eth0", "10.0.1.22")]),
    "10.0.1.22",
  );
});

Deno.test("link-local is not an address anything can reach", () => {
  // What an interface gives itself when DHCP never answered.
  assertEquals(
    pickLanAddress([v4("lo0", "127.0.0.1"), v4("en0", "169.254.7.9")]),
    null,
  );
});

Deno.test("IPv6 is left alone — the link this builds is v4", () => {
  assertEquals(
    pickLanAddress([v6("en0", "fe80::1"), v6("en0", "2001:db8::1")]),
    null,
  );
  assertEquals(
    pickLanAddress([v6("en0", "2001:db8::1"), v4("en0", "192.168.1.5")]),
    "192.168.1.5",
  );
});

Deno.test("a machine with nothing to offer says so rather than guessing", () => {
  assertEquals(pickLanAddress([]), null);
  assertEquals(pickLanAddress([v4("lo0", "127.0.0.1")]), null);
  assertEquals(lanOrigin([v4("lo0", "127.0.0.1")], 8787), null);
});

Deno.test("two equally good interfaces pick the same one every time", () => {
  const both = [v4("en1", "192.168.0.9"), v4("en0", "192.168.0.174")];
  const first = pickLanAddress(both);
  assertEquals(first, pickLanAddress([...both].reverse()));
  assertEquals(first, "192.168.0.174", "ties break on interface name");
});

Deno.test("the origin carries the port the server actually answers on", () => {
  assertEquals(
    lanOrigin([v4("lo0", "127.0.0.1"), v4("en0", "192.168.0.174")], 8787),
    "http://192.168.0.174:8787",
  );
});
