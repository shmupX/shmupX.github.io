// routes/api/host.ts answers only the machine it runs on: the DMI strings
// describe the machine serving the launcher, and a phone on the dev tunnel or
// a second PC on the LAN must not inherit a Legion Go's split-controller
// default.

import { assert } from "@std/assert";
import { isOwnMachine } from "../routes/api/host.ts";

const tcp = (hostname: string): Deno.Addr => ({
  transport: "tcp",
  hostname,
  port: 1,
});
const h = (init: Record<string, string> = {}) => new Headers(init);

Deno.test("loopback clients — and callers with no address — are the machine itself", () => {
  for (const ip of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"]) {
    assert(isOwnMachine(tcp(ip), h({ host: "127.0.0.1:8787" })), ip);
  }
  // desktop.ts's in-process server.fetch carries no address at all.
  assert(isOwnMachine(undefined, h()));
  // A unix socket is local by construction.
  assert(isOwnMachine({ transport: "unix", path: "/tmp/x.sock" }, h()));
});

Deno.test("the desktop binary bound to a LAN address still answers its own window", () => {
  // SHMUPX_HOST=192.168.1.5: the Legion's own browser reaches its own
  // interface, so the client address is the address it asked for.
  assert(isOwnMachine(tcp("192.168.1.5"), h({ host: "192.168.1.5:8787" })));
  assert(isOwnMachine(tcp("fd00::5"), h({ host: "[fd00::5]:8787" })));
  // ...while a second PC on that LAN is not.
  assert(!isOwnMachine(tcp("192.168.1.20"), h({ host: "192.168.1.5:8787" })));
});

Deno.test("LAN and tunnel clients are not", () => {
  for (const ip of ["192.168.1.20", "10.0.0.5", "fe80::1", "203.0.113.9"]) {
    assert(!isOwnMachine(tcp(ip), h({ host: "192.168.1.5:8787" })), ip);
  }
  // The dev tunnel's agent connects from loopback but says it forwarded.
  assert(
    !isOwnMachine(
      tcp("127.0.0.1"),
      h({ host: "abc.ngrok.app", "x-forwarded-for": "203.0.113.9" }),
    ),
  );
  assert(
    !isOwnMachine(
      tcp("127.0.0.1"),
      h({ host: "127.0.0.1:8787", "x-forwarded-host": "abc.ngrok.app" }),
    ),
  );
});
