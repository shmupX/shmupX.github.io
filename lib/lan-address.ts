// Which of this machine's addresses a phone on the same network can actually
// open.
//
// The launcher serves on 127.0.0.1 by default, which is the right answer for
// the window it opens and useless for anything else: a finished APK sitting on
// this disk is only installable on the phone that will run it if that phone can
// fetch it, and no phone can fetch loopback. So when the launcher offers a
// build to another device — as a link, or as the QR code beside it — it has to
// name an address on the local network instead.
//
// Picking one is a judgement, not a lookup. A desktop typically has several:
// loopback, a wired interface, wi-fi, and on a developer's machine a pile of
// virtual ones (Docker bridges, VPN tunnels, VirtualBox host-only adapters)
// that are up, have addresses, and go nowhere a phone can follow. The order
// below is what survives that: real private ranges first, in the order a home
// network actually uses them, and the well-known virtual ranges last.
//
// routes/api/host.ts serves the result; nothing here touches the network.

/** One interface, narrowed to what choosing needs. Mirrors `Deno.NetworkInterfaceInfo`. */
export interface NetInterface {
  name: string;
  family: string;
  address: string;
}

/**
 * Interface-name prefixes that are somebody else's network, not this one.
 *
 * A Docker bridge answers, routes, and is invisible to every device in the
 * room. A VPN tunnel is worse: it may well carry the request somewhere real,
 * just not to the phone two feet away.
 */
const VIRTUAL_NAMES = [
  "docker",
  "br-",
  "veth",
  "virbr",
  "vboxnet",
  "vmnet",
  "utun",
  "tun",
  "tap",
  "zt",
  "wg",
  "tailscale",
  "ham",
  "awdl", // Apple Wireless Direct Link — peer-to-peer, not the LAN
  "llw",
  "bridge",
];

/** How good an address looks, lowest first. Below zero is not offered at all. */
function rank(iface: NetInterface): number {
  if (iface.family !== "IPv4") return -1;
  const address = iface.address;
  if (address.startsWith("127.")) return -1;
  // Link-local: what an interface gives itself when DHCP never answered.
  if (address.startsWith("169.254.")) return -1;
  const name = iface.name.toLowerCase();
  const virtual = VIRTUAL_NAMES.some((prefix) => name.startsWith(prefix));
  if (address.startsWith("192.168.")) return virtual ? 40 : 0;
  // 172.16-31 is private; 172.17 in particular is Docker's default bridge.
  const octets = address.split(".").map(Number);
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
    return virtual || octets[1] === 17 ? 41 : 1;
  }
  if (address.startsWith("10.")) return virtual ? 42 : 2;
  // A public address on a desktop is a hosting box, not a living room, but it
  // is still better than nothing.
  return virtual ? 50 : 10;
}

/**
 * The address to hand another device, or null when this machine has none.
 *
 * Ties break on interface name so the answer does not move between calls on a
 * machine with two equally good interfaces — a link that changes every time it
 * is looked at is worse than one that is occasionally the wrong half of a
 * dual-homed desktop.
 */
export function pickLanAddress(interfaces: NetInterface[]): string | null {
  const usable = interfaces
    .map((iface) => ({ iface, rank: rank(iface) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) =>
      a.rank - b.rank || a.iface.name.localeCompare(b.iface.name) ||
      a.iface.address.localeCompare(b.iface.address)
    );
  return usable.length ? usable[0].iface.address : null;
}

/**
 * That address as an origin another device can open, given the port this
 * server answers on.
 *
 * Null rather than a guess when there is no address to offer: the caller says
 * "this machine is not reachable from your phone", which is a better answer
 * than a link that times out.
 */
export function lanOrigin(
  interfaces: NetInterface[],
  port: number,
): string | null {
  const address = pickLanAddress(interfaces);
  if (!address) return null;
  return `http://${address}:${port}`;
}

/** This machine's interfaces, or none when the runtime will not say. */
export function localInterfaces(): NetInterface[] {
  try {
    return (Deno.networkInterfaces() as NetInterface[]).map((iface) => ({
      name: iface.name,
      family: iface.family,
      address: iface.address,
    }));
  } catch {
    // --allow-sys was not granted. Not being able to name an address is the
    // same outcome as not having one.
    return [];
  }
}
