// lib/tailscale.ts is the pure half of the dev server's Tailscale tunnel:
// which CLI to run, what its status means, which URL a run yields, and what
// its errors mean. None of it can be exercised against a real tailnet here,
// so the shapes the CLI is known to produce are pinned as fixtures.

import { assert, assertEquals } from "@std/assert";
import {
  explainTunnelError,
  parseStatus,
  tailscaleCandidates,
  tunnelArgs,
  tunnelModeFromEnv,
  tunnelOffArgs,
  tunnelUrl,
  urlInLine,
} from "../lib/tailscale.ts";

Deno.test("SHMUPX_TUNNEL picks the mode; Funnel is the default", () => {
  assertEquals(tunnelModeFromEnv(undefined), "funnel");
  assertEquals(tunnelModeFromEnv(""), "funnel");
  assertEquals(tunnelModeFromEnv("funnel"), "funnel");
  assertEquals(tunnelModeFromEnv("public"), "funnel");
  assertEquals(tunnelModeFromEnv("serve"), "serve");
  assertEquals(tunnelModeFromEnv("Tailnet"), "serve");
  for (const off of ["off", "0", "false", "none", " OFF "]) {
    assertEquals(tunnelModeFromEnv(off), "off", off);
  }
});

Deno.test("the CLI is looked for on PATH first, then where the installers put it", () => {
  assertEquals(tailscaleCandidates("darwin")[0], "tailscale");
  assert(
    tailscaleCandidates("darwin").includes(
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ),
  );
  assertEquals(
    tailscaleCandidates("windows", { ProgramFiles: "D:\\Programs" })[1],
    "D:\\Programs\\Tailscale\\tailscale.exe",
  );
  assertEquals(
    tailscaleCandidates("windows")[1],
    "C:\\Program Files\\Tailscale\\tailscale.exe",
  );
  assert(tailscaleCandidates("linux").includes("/usr/bin/tailscale"));
});

Deno.test("status: the machine's name, tailnet, certificates and state", () => {
  const status = parseStatus(JSON.stringify({
    BackendState: "Running",
    Self: {
      HostName: "legion-go",
      DNSName: "legion-go.tail1234.ts.net.",
      TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
    },
    CurrentTailnet: {
      Name: "daniel@example.com",
      MagicDNSSuffix: "tail1234.ts.net",
    },
    CertDomains: ["legion-go.tail1234.ts.net"],
  }));
  assertEquals(status, {
    backendState: "Running",
    dnsName: "legion-go.tail1234.ts.net",
    hostName: "legion-go",
    magicDnsSuffix: "tail1234.ts.net",
    certDomains: ["legion-go.tail1234.ts.net"],
    tailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
  });
  // A logged-out daemon, and garbage, both read as "nothing to use".
  assertEquals(
    parseStatus('{"BackendState":"NeedsLogin"}').backendState,
    "NeedsLogin",
  );
  assertEquals(parseStatus('{"BackendState":"NeedsLogin"}').dnsName, "");
  assertEquals(parseStatus("not json").backendState, "");
  assertEquals(parseStatus("null").dnsName, "");
});

Deno.test("the URL a run answers at, and the commands that start and clear it", () => {
  assertEquals(
    tunnelUrl("legion-go.tail1234.ts.net"),
    "https://legion-go.tail1234.ts.net/",
  );
  assertEquals(
    tunnelUrl("legion-go.tail1234.ts.net", 8443),
    "https://legion-go.tail1234.ts.net:8443/",
  );
  assertEquals(tunnelUrl(""), "");
  assertEquals(tunnelArgs("funnel", 5173), ["funnel", "5173"]);
  assertEquals(tunnelArgs("serve", 5173), ["serve", "5173"]);
  assertEquals(tunnelOffArgs("funnel"), ["funnel", "--https=443", "off"]);
  assertEquals(tunnelOffArgs("serve"), ["serve", "--https=443", "off"]);
});

Deno.test("the URL is also read off the CLI's own output", () => {
  assertEquals(
    urlInLine("https://legion-go.tail1234.ts.net/"),
    "https://legion-go.tail1234.ts.net/",
  );
  assertEquals(
    urlInLine("|-- https://legion-go.tail1234.ts.net:8443 -> proxy"),
    "https://legion-go.tail1234.ts.net:8443",
  );
  assertEquals(urlInLine("Available on the internet:"), "");
  assertEquals(urlInLine("|-- proxy http://127.0.0.1:5173"), "");
});

Deno.test("the CLI's complaints become instructions, and Funnel falls back to Serve", () => {
  const notEnabled = explainTunnelError(
    "funnel",
    "Funnel not enabled on this node.\nTo enable, visit:\n\n\thttps://login.tailscale.com/f/funnel?node=abc123\n",
  );
  assert(notEnabled.fallbackToServe);
  assert(
    notEnabled.lines.some((l) =>
      l.includes("https://login.tailscale.com/f/funnel?node=abc123")
    ),
  );
  // Serve itself failing the same way does not fall back to itself.
  assert(
    !explainTunnelError("serve", "Funnel not enabled on this node.")
      .fallbackToServe,
  );
  const certs = explainTunnelError(
    "funnel",
    "error: HTTPS is not enabled for this tailnet. Enable it at https://login.tailscale.com/admin/dns",
  );
  assert(!certs.fallbackToServe);
  assert(certs.lines.some((l) => l.includes("admin/dns")));
  const stopped = explainTunnelError("funnel", "Tailscale is stopped.");
  assert(stopped.lines.some((l) => l.includes("tailscale up")));
  assertEquals(explainTunnelError("funnel", "something else entirely"), {
    fallbackToServe: false,
    lines: [],
  });
});
