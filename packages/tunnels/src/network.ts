import dgram from "node:dgram";
import os from "node:os";
import { USER_AGENT } from "@cubehold/mc";

/** Adapters that are not the home network: VMs, containers, VPNs, overlay networks. */
const VIRTUAL_ADAPTER =
  /vEthernet|Hyper-V|WSL|VMware|VirtualBox|vboxnet|docker|br-|veth|virbr|lxc|tap|tun\d|utun|wg\d|OpenVPN|Surfshark|NordLynx|ProtonVPN|WireGuard|ZeroTier|Tailscale|Loopback/i;

export interface LanAddress {
  /** Adapter name as the OS reports it ("Wi-Fi", "eth0"). */
  name: string;
  address: string;
  /** VM, container or VPN adapter rather than the real network. */
  virtual: boolean;
}

export function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** 100.64.0.0/10: carrier-grade NAT, also used by Tailscale. */
export function isSharedIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p[0] === 100 && (p[1] as number) >= 64 && (p[1] as number) <= 127;
}

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** IPv4 addresses on this machine that could face a home network, real adapters first. */
export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (!isPrivateIPv4(a.address)) continue;
      out.push({ name, address: a.address, virtual: VIRTUAL_ADAPTER.test(name) });
    }
  }
  return out.sort((x, y) => Number(x.virtual) - Number(y.virtual));
}

/** This machine's Tailscale address (100.x.y.z), when Tailscale is running. */
export function tailscaleAddress(): string | null {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && isSharedIPv4(a.address) && /tailscale/i.test(name)) {
        return a.address;
      }
    }
  }
  return null;
}

/**
 * The local address the OS would use to reach the internet. Connecting a
 * UDP socket only picks a route; no packet is sent.
 */
export function defaultRouteAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    const done = (v: string | null) => {
      try {
        s.close();
      } catch {
        // already closed
      }
      resolve(v);
    };
    s.on("error", () => done(null));
    s.connect(53, "1.1.1.1", () => {
      try {
        const a = s.address().address;
        done(a && a !== "0.0.0.0" ? a : null);
      } catch {
        done(null);
      }
    });
  });
}

/** Addresses to look for a router from: the default route first, then real adapters. */
export async function candidateAddresses(): Promise<string[]> {
  const primary = await defaultRouteAddress();
  const lan = lanAddresses()
    .filter((a) => !a.virtual)
    .map((a) => a.address);
  const list = primary && isPrivateIPv4(primary) ? [primary, ...lan] : lan;
  return [...new Set(list)];
}

/**
 * What the router's WAN side looks like, from its own idea of its address
 * and what the internet sees:
 *  - public: port forwarding reaches this network directly
 *  - cgnat: the provider shares one address between customers; forwarding cannot work
 *  - double-nat: another router sits in front of this one; forward on both
 */
export type WanKind = "public" | "cgnat" | "double-nat" | "unknown";

export function classifyWan(routerIp: string | null, publicIp: string | null): WanKind {
  if (!routerIp) return "unknown";
  if (isSharedIPv4(routerIp)) return "cgnat";
  if (isPrivateIPv4(routerIp)) return "double-nat";
  if (publicIp && routerIp !== publicIp) return "cgnat";
  return "public";
}

/** This network's public addresses as the internet sees them. */
export async function publicAddresses(): Promise<{ ipv4: string | null; ipv6: string | null }> {
  const get = async (urls: string[], want: RegExp) => {
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: { "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(5_000),
        });
        const text = (await res.text()).trim();
        if (res.ok && want.test(text)) return text;
      } catch {
        // try the next service
      }
    }
    return null;
  };
  const [ipv4, ipv6] = await Promise.all([
    get(["https://api.ipify.org", "https://ipv4.icanhazip.com"], /^\d{1,3}(\.\d{1,3}){3}$/),
    get(["https://api6.ipify.org", "https://ipv6.icanhazip.com"], /^[0-9a-f:]+$/i),
  ]);
  return { ipv4, ipv6 };
}
