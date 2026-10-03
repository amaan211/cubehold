import dgram from "node:dgram";
import http from "node:http";
import { candidateAddresses } from "./network.js";

/**
 * UPnP Internet Gateway Device client: find the router, read its public
 * address, and forward ports to this machine. Only what port forwarding
 * needs (IGD v1 and v2, WANIPConnection and WANPPPConnection).
 * Spec: https://openconnectivity.org/developer/specifications/upnp-resources/upnp/internet-gateway-device-igd-v-2-0/
 */

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
/** Services that can forward ports, best first. */
const WAN_SERVICES = [
  "urn:schemas-upnp-org:service:WANIPConnection:2",
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANPPPConnection:1",
];
const SEARCH_TARGETS = [
  "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
  "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
  ...WAN_SERVICES,
];
const HTTP_TIMEOUT_MS = 8_000;

export type PortProtocol = "TCP" | "UDP";

export interface Gateway {
  /** Device description URL from the SSDP reply. */
  location: string;
  controlUrl: string;
  serviceType: string;
  friendlyName: string | null;
  manufacturer: string | null;
  modelName: string | null;
  /** This machine's address on the router's network: where forwarded ports point. */
  localAddress: string;
}

export interface PortMapping {
  protocol: PortProtocol;
  externalPort: number;
  internalPort: number;
  internalClient: string;
  description: string;
  enabled: boolean;
  leaseSeconds: number;
}

const ERRORS: Record<number, string> = {
  402: "the router rejected the request",
  501: "the router could not do it",
  606: "the router does not allow port changes over UPnP",
  713: "no such entry",
  714: "no such entry",
  715: "the router needs a specific remote host",
  716: "the router needs a specific external port",
  718: "the router already forwards this port to another device",
  724: "the router needs the same external and internal port",
  725: "the router only supports permanent port forwards",
  726: "the router only supports forwarding from any remote host",
  727: "the router only supports wildcard external ports",
  728: "the router has no room for more port forwards",
  729: "the port conflicts with another forwarding mechanism on the router",
};

export class UpnpError extends Error {
  constructor(
    readonly code: number | null,
    readonly description: string,
  ) {
    super(
      code !== null && ERRORS[code]
        ? `${capitalize(ERRORS[code])} (UPnP error ${code})`
        : `Router error${code !== null ? ` ${code}` : ""}: ${description || "no details"}`,
    );
  }
}

// --- discovery ----------------------------------------------------------------------

/**
 * Find the router over SSDP. Machines often have several network adapters
 * (VPN, VirtualBox, WSL, Hyper-V); multicast leaves through whichever one the
 * OS picks unless told otherwise, so the search goes out on each LAN
 * address, the one with the default route first.
 */
export async function discoverGateway(
  opts: { timeoutMs?: number; addresses?: string[] } = {},
): Promise<Gateway | null> {
  const addresses = opts.addresses ?? (await candidateAddresses());
  const replies = await Promise.all(
    addresses.map((a) => searchFrom(a, opts.timeoutMs ?? 2_500).catch(() => [] as string[])),
  );
  // Address priority first, then reply order.
  const seen = new Set<string>();
  for (const [i, locations] of replies.entries()) {
    const localAddress = addresses[i] as string;
    for (const location of locations) {
      if (seen.has(location)) continue;
      seen.add(location);
      const gw = await describe(location, localAddress).catch(() => null);
      if (gw) return gw;
    }
  }
  return null;
}

function searchFrom(localAddress: string, timeoutMs: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const locations: string[] = [];
    let finished = false;
    const done = (err?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(locations);
    };
    const timer = setTimeout(() => done(), timeoutMs);
    socket.on("error", (err) => done(err));
    socket.on("message", (msg) => {
      const location = /^location:\s*(\S+)/im.exec(msg.toString("utf8"))?.[1];
      if (location && /^http:\/\//i.test(location) && !locations.includes(location)) {
        locations.push(location);
      }
    });
    socket.bind(0, localAddress, () => {
      try {
        socket.setMulticastInterface(localAddress);
        socket.setMulticastTTL(2);
      } catch {
        // some adapters refuse; the search still goes out on the default one
      }
      for (const st of SEARCH_TARGETS) {
        const search = Buffer.from(
          `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`,
        );
        socket.send(search, SSDP_PORT, SSDP_ADDRESS);
      }
    });
  });
}

/** Read a device description and pick its best port-forwarding service. */
export async function describe(location: string, localAddress: string): Promise<Gateway | null> {
  const xml = await httpText(location);
  const base = xmlTag(xml, "URLBase") || location;
  const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => ({
    type: xmlTag(m[1] ?? "", "serviceType"),
    control: xmlTag(m[1] ?? "", "controlURL"),
  }));
  for (const wanted of WAN_SERVICES) {
    for (const s of services) {
      if (s.type !== wanted || !s.control) continue;
      const gw: Gateway = {
        location,
        controlUrl: new URL(s.control, base).toString(),
        serviceType: s.type,
        friendlyName: xmlTag(xml, "friendlyName") || null,
        manufacturer: xmlTag(xml, "manufacturer") || null,
        modelName: xmlTag(xml, "modelName") || null,
        localAddress,
      };
      // Some routers list an unused WAN connection first (IPTV, a second line).
      const ip = await externalIp(gw).catch(() => "");
      if (ip) return gw;
    }
  }
  return null;
}

// --- actions --------------------------------------------------------------------------

export async function externalIp(gw: Gateway): Promise<string> {
  const r = await soap(gw, "GetExternalIPAddress", []);
  return r.NewExternalIPAddress ?? "";
}

/**
 * Forward a port. Routers that only take permanent forwards (error 725) get
 * one; callers remove it again when it is no longer wanted.
 */
export async function addPortMapping(
  gw: Gateway,
  m: Omit<PortMapping, "enabled" | "internalClient"> & { internalClient?: string },
): Promise<{ leaseSeconds: number }> {
  const add = (lease: number) =>
    soap(gw, "AddPortMapping", [
      ["NewRemoteHost", ""],
      ["NewExternalPort", m.externalPort],
      ["NewProtocol", m.protocol],
      ["NewInternalPort", m.internalPort],
      ["NewInternalClient", m.internalClient ?? gw.localAddress],
      ["NewEnabled", 1],
      ["NewPortMappingDescription", m.description],
      ["NewLeaseDuration", lease],
    ]);
  try {
    await add(m.leaseSeconds);
    return { leaseSeconds: m.leaseSeconds };
  } catch (err) {
    if (err instanceof UpnpError && err.code === 725 && m.leaseSeconds !== 0) {
      await add(0);
      return { leaseSeconds: 0 };
    }
    throw err;
  }
}

export async function deletePortMapping(
  gw: Gateway,
  protocol: PortProtocol,
  externalPort: number,
): Promise<void> {
  await soap(gw, "DeletePortMapping", [
    ["NewRemoteHost", ""],
    ["NewExternalPort", externalPort],
    ["NewProtocol", protocol],
  ]);
}

/** The forward for one external port, or null when there is none. */
export async function getPortMapping(
  gw: Gateway,
  protocol: PortProtocol,
  externalPort: number,
): Promise<PortMapping | null> {
  try {
    const r = await soap(gw, "GetSpecificPortMappingEntry", [
      ["NewRemoteHost", ""],
      ["NewExternalPort", externalPort],
      ["NewProtocol", protocol],
    ]);
    return {
      protocol,
      externalPort,
      internalPort: Number(r.NewInternalPort),
      internalClient: r.NewInternalClient ?? "",
      description: r.NewPortMappingDescription ?? "",
      enabled: r.NewEnabled === "1" || r.NewEnabled === "true",
      leaseSeconds: Number(r.NewLeaseDuration) || 0,
    };
  } catch (err) {
    // 714 is the standard answer; some routers send 402 or 501 instead.
    if (err instanceof UpnpError && [713, 714, 402, 501].includes(err.code ?? 0)) return null;
    throw err;
  }
}

/** Every forward on the router, read until the first gap. */
export async function listPortMappings(gw: Gateway, max = 256): Promise<PortMapping[]> {
  const out: PortMapping[] = [];
  for (let i = 0; i < max; i++) {
    let r: Record<string, string>;
    try {
      r = await soap(gw, "GetGenericPortMappingEntry", [["NewPortMappingIndex", i]]);
    } catch (err) {
      if (err instanceof UpnpError) break; // 713 marks the end
      throw err;
    }
    out.push({
      protocol: (r.NewProtocol ?? "").toUpperCase() === "UDP" ? "UDP" : "TCP",
      externalPort: Number(r.NewExternalPort),
      internalPort: Number(r.NewInternalPort),
      internalClient: r.NewInternalClient ?? "",
      description: r.NewPortMappingDescription ?? "",
      enabled: r.NewEnabled === "1" || r.NewEnabled === "true",
      leaseSeconds: Number(r.NewLeaseDuration) || 0,
    });
  }
  return out;
}

// --- SOAP ---------------------------------------------------------------------------

async function soap(
  gw: Gateway,
  action: string,
  args: Array<[string, string | number]>,
): Promise<Record<string, string>> {
  // Argument order matters to some routers, hence a list rather than an object.
  const body =
    `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:${action} xmlns:u="${gw.serviceType}">` +
    args.map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`).join("") +
    `</u:${action}></s:Body></s:Envelope>\r\n`;
  const headers = {
    "Content-Type": 'text/xml; charset="utf-8"',
    SOAPAction: `"${gw.serviceType}#${action}"`,
  };
  const { status, text } = await httpRequest("POST", gw.controlUrl, body, headers);
  if (status !== 200 || /<(?:\w+:)?Fault>/i.test(text)) {
    const code = Number(xmlTag(text, "errorCode"));
    throw new UpnpError(
      Number.isFinite(code) && code > 0 ? code : null,
      xmlTag(text, "errorDescription") || `HTTP ${status}`,
    );
  }
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/<(?:\w+:)?(New\w+)\s*>([^<]*)<\//g)) {
    out[m[1] as string] = unescapeXml(m[2] ?? "");
  }
  return out;
}

/**
 * Some routers (pupnp-based ones among them) drop every other connection
 * made in quick succession; a prompt retry gets through.
 */
async function httpRequest(
  method: "GET" | "POST",
  url: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await httpOnce(method, url, body, headers);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 2 || (code !== "ECONNRESET" && code !== "EPIPE")) throw err;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

/**
 * Plain node:http rather than fetch: router firmware can be picky about
 * header case (SOAPAction) and chunked bodies, and fetch controls neither.
 */
function httpOnce(
  method: "GET" | "POST",
  url: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "http:") {
      reject(new Error(`Unsupported gateway URL ${url}`));
      return;
    }
    const data = body ? Buffer.from(body, "utf8") : null;
    const req = http.request(
      {
        method,
        host: u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        headers: {
          ...headers,
          Connection: "close",
          ...(data ? { "Content-Length": String(data.length) } : {}),
        },
        timeout: HTTP_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 1024 * 1024) req.destroy(new Error("Gateway reply too large"));
          else chunks.push(c);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("The router did not answer")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function httpText(url: string): Promise<string> {
  const { status, text } = await httpRequest("GET", url);
  if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
  return text;
}

// --- XML helpers ----------------------------------------------------------------------

/** Text of the first element with this local name (namespace prefixes ignored). */
export function xmlTag(xml: string, name: string): string {
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${name}>`, "i").exec(
    xml,
  );
  return m ? unescapeXml(m[1] ?? "").trim() : "";
}

function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c,
  );
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
