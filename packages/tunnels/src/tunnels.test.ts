import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, describe as group, it } from "vitest";
import {
  evaluateInbound,
  type FirewallSnapshot,
  firewallFixScript,
  portListMatches,
  programWideRules,
} from "./firewall.js";
import { PortMapper } from "./mapper.js";
import { classifyWan, isPrivateIPv4, isSharedIPv4 } from "./network.js";
import {
  claimUrl,
  describeCreateError,
  generateClaimCode,
  PlayitError,
  parseRundata,
  playitAssetName,
} from "./playit.js";
import {
  cloudflaredAssetName,
  friendCommands,
  isNgrokToken,
  ngrokConfig,
  ngrokDownload,
  ngrokEndpointName,
  parseTunnelToken,
  servicePort,
  tcpAddress,
} from "./providers.js";
import { chatToText, splitAddress } from "./status.js";
import {
  addPortMapping,
  deletePortMapping,
  describe,
  externalIp,
  type Gateway,
  getPortMapping,
  listPortMappings,
  UpnpError,
  xmlTag,
} from "./upnp.js";

// --- a fake router ------------------------------------------------------------------

interface FakeMapping {
  protocol: string;
  externalPort: number;
  internalPort: number;
  client: string;
  description: string;
  lease: number;
}

class FakeRouter {
  mappings: FakeMapping[] = [];
  permanentOnly = false;
  /** Like the Sagemcom router this was written against: every other connection is dropped. */
  flaky = false;
  requests = 0;
  #server = http.createServer((req, res) => this.#handle(req, res));
  base = "";

  async start(): Promise<void> {
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.#server.close(() => r()));
  }

  #handle(req: http.IncomingMessage, res: http.ServerResponse) {
    this.requests++;
    if (this.flaky && this.requests % 2 === 1) {
      req.socket.destroy();
      return;
    }
    if (req.method === "GET" && req.url === "/desc.xml") {
      res.end(`<?xml version="1.0"?><root><device><friendlyName>Fake Router</friendlyName><manufacturer>Test</manufacturer><modelName>R1</modelName>
<serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service></serviceList>
<deviceList><device><deviceList><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></deviceList></device></deviceList></device></root>`);
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const action = /#(\w+)"/.exec(String(req.headers.soapaction))?.[1] ?? "";
      const arg = (n: string) => xmlTag(body, n);
      const fault = (code: number, desc: string) => {
        res.statusCode = 500;
        res.end(
          `<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`,
        );
      };
      const ok = (inner: string) =>
        res.end(
          `<s:Envelope><s:Body><u:${action}Response xmlns:u="x">${inner}</u:${action}Response></s:Body></s:Envelope>`,
        );
      const find = () =>
        this.mappings.find(
          (m) =>
            m.protocol === arg("NewProtocol") && m.externalPort === Number(arg("NewExternalPort")),
        );
      switch (action) {
        case "GetExternalIPAddress":
          return ok("<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>");
        case "AddPortMapping": {
          const lease = Number(arg("NewLeaseDuration"));
          if (this.permanentOnly && lease !== 0) return fault(725, "OnlyPermanentLeasesSupported");
          const existing = find();
          if (existing && existing.client !== arg("NewInternalClient")) {
            return fault(718, "ConflictInMappingEntry");
          }
          if (existing) this.mappings.splice(this.mappings.indexOf(existing), 1);
          this.mappings.push({
            protocol: arg("NewProtocol"),
            externalPort: Number(arg("NewExternalPort")),
            internalPort: Number(arg("NewInternalPort")),
            client: arg("NewInternalClient"),
            description: arg("NewPortMappingDescription"),
            lease,
          });
          return ok("");
        }
        case "DeletePortMapping": {
          const m = find();
          if (!m) return fault(714, "NoSuchEntryInArray");
          this.mappings.splice(this.mappings.indexOf(m), 1);
          return ok("");
        }
        case "GetSpecificPortMappingEntry": {
          const m = find();
          if (!m) return fault(714, "NoSuchEntryInArray");
          return ok(
            `<NewInternalPort>${m.internalPort}</NewInternalPort><NewInternalClient>${m.client}</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>${m.description}</NewPortMappingDescription><NewLeaseDuration>${m.lease}</NewLeaseDuration>`,
          );
        }
        case "GetGenericPortMappingEntry": {
          const m = this.mappings[Number(arg("NewPortMappingIndex"))];
          if (!m) return fault(713, "SpecifiedArrayIndexInvalid");
          return ok(
            `<NewRemoteHost></NewRemoteHost><NewExternalPort>${m.externalPort}</NewExternalPort><NewProtocol>${m.protocol}</NewProtocol><NewInternalPort>${m.internalPort}</NewInternalPort><NewInternalClient>${m.client}</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>${m.description}</NewPortMappingDescription><NewLeaseDuration>${m.lease}</NewLeaseDuration>`,
          );
        }
        default:
          return fault(401, "Invalid Action");
      }
    });
  }
}

const router = new FakeRouter();
let gw: Gateway;

beforeAll(async () => {
  await router.start();
  const found = await describe(`${router.base}/desc.xml`, "192.168.1.50");
  if (!found) throw new Error("fake router not described");
  gw = found;
});
afterAll(() => router.stop());

group("UPnP client", () => {
  it("finds the WAN service in a nested device description", () => {
    expect(gw.controlUrl).toBe(`${router.base}/ctl`);
    expect(gw.serviceType).toBe("urn:schemas-upnp-org:service:WANIPConnection:1");
    expect(gw.friendlyName).toBe("Fake Router");
    expect(gw.localAddress).toBe("192.168.1.50");
  });

  it("adds, reads, lists and deletes forwards", async () => {
    expect(await externalIp(gw)).toBe("203.0.113.7");
    await addPortMapping(gw, {
      protocol: "TCP",
      externalPort: 25565,
      internalPort: 25565,
      description: "cubehold test",
      leaseSeconds: 3600,
    });
    const m = await getPortMapping(gw, "TCP", 25565);
    expect(m).toMatchObject({
      internalClient: "192.168.1.50",
      leaseSeconds: 3600,
      description: "cubehold test",
    });
    expect(await getPortMapping(gw, "UDP", 25565)).toBeNull();
    expect((await listPortMappings(gw)).map((x) => x.externalPort)).toEqual([25565]);
    await deletePortMapping(gw, "TCP", 25565);
    expect(await listPortMappings(gw)).toEqual([]);
  });

  it("falls back to a permanent forward when the router refuses leases", async () => {
    router.permanentOnly = true;
    try {
      const r = await addPortMapping(gw, {
        protocol: "UDP",
        externalPort: 19132,
        internalPort: 19132,
        description: "x",
        leaseSeconds: 3600,
      });
      expect(r.leaseSeconds).toBe(0);
    } finally {
      router.permanentOnly = false;
      router.mappings = [];
    }
  });

  it("explains router errors", async () => {
    const err = await deletePortMapping(gw, "TCP", 1).catch((e) => e);
    expect(err).toBeInstanceOf(UpnpError);
    expect(err.code).toBe(714);
  });

  it("retries a router that drops every other connection", async () => {
    router.flaky = true;
    try {
      for (let i = 0; i < 4; i++) expect(await externalIp(gw)).toBe("203.0.113.7");
    } finally {
      router.flaky = false;
    }
  });
});

group("PortMapper", () => {
  it("keeps the wanted set, detects conflicts and cleans up", async () => {
    router.mappings = [
      {
        protocol: "TCP",
        externalPort: 25570,
        internalPort: 25570,
        client: "192.168.1.99",
        description: "someone else",
        lease: 0,
      },
    ];
    const mapper = new PortMapper({ deps: { discover: async () => gw }, renewMs: 60_000 });
    try {
      const states = await mapper.set([
        { key: "a:java", protocol: "TCP", port: 25565, description: "cubehold Survival ✓" },
        { key: "b:java", protocol: "TCP", port: 25570, description: "cubehold Other" },
      ]);
      const a = states.find((s) => s.key === "a:java");
      const b = states.find((s) => s.key === "b:java");
      expect(a).toMatchObject({
        status: "active",
        externalIp: "203.0.113.7",
        internalClient: "192.168.1.50",
      });
      expect(router.mappings.find((m) => m.externalPort === 25565)?.description).toBe(
        "cubehold Survival",
      );
      expect(b?.status).toBe("failed");
      expect(b?.error).toMatch(/192\.168\.1\.99/);

      // A forward of ours that is still there from an earlier lease is simply renewed.
      await mapper.renew();
      expect(router.mappings.filter((m) => m.externalPort === 25565)).toHaveLength(1);

      await mapper.set([
        { key: "b:java", protocol: "TCP", port: 25570, description: "cubehold Other" },
      ]);
      expect(router.mappings.some((m) => m.externalPort === 25565)).toBe(false);
      await mapper.clear();
      // Never removes forwards it did not make.
      expect(router.mappings.map((m) => m.client)).toEqual(["192.168.1.99"]);
    } finally {
      mapper.dispose();
      router.mappings = [];
    }
  });

  it("reports a missing router", async () => {
    const mapper = new PortMapper({ deps: { discover: async () => null } });
    try {
      const [s] = await mapper.set([{ key: "x", protocol: "TCP", port: 1, description: "x" }]);
      expect(s?.status).toBe("failed");
      expect(s?.error).toMatch(/No UPnP router/);
    } finally {
      mapper.dispose();
    }
  });
});

group("Windows Firewall rules", () => {
  const java = "C:\\data\\java\\21\\jre\\bin\\java.exe";
  const snap = (rules: FirewallSnapshot["rules"], currentProfiles = 4): FirewallSnapshot => ({
    currentProfiles,
    profiles: [
      { name: "domain", enabled: true, blockInbound: true },
      { name: "private", enabled: true, blockInbound: true },
      { name: "public", enabled: true, blockInbound: true },
    ],
    rules,
    networks: [{ name: "Home", adapter: "Wi-Fi", category: "Public" }],
  });
  const rule = (r: Partial<FirewallSnapshot["rules"][number]>) => ({
    name: "r",
    program: java,
    protocol: 6,
    localPorts: "*",
    action: "allow" as const,
    profiles: 4,
    remoteAddresses: "*",
    group: null,
    ...r,
  });

  it("matches port lists", () => {
    expect(portListMatches("*", 1)).toBe(true);
    expect(portListMatches("25565,19132-19140", 19135)).toBe(true);
    expect(portListMatches("25565, 80", 80)).toBe(true);
    expect(portListMatches("RPC", 135)).toBe(false);
  });

  it("sees the every-port rule Windows makes for Java", () => {
    const s = snap([rule({ name: "OpenJDK Platform binary", program: java.toLowerCase() })]);
    const v = evaluateInbound(s, { program: java, protocol: "TCP", port: 25575 });
    expect(v).toMatchObject({ allowed: true, programWide: true });
    expect(programWideRules(s, java)).toHaveLength(1);
  });

  it("lets block rules win and ignores rules for other profiles", () => {
    const s = snap([
      rule({ name: "allow game", localPorts: "25565" }),
      rule({ name: "cancelled prompt", action: "block", protocol: 256 }),
    ]);
    expect(evaluateInbound(s, { program: java, protocol: "TCP", port: 25565 })).toMatchObject({
      allowed: false,
      because: "block-rule",
      rule: "cancelled prompt",
    });
    const privateOnly = snap([rule({ profiles: 2, localPorts: "25565" })]);
    expect(
      evaluateInbound(privateOnly, { program: java, protocol: "TCP", port: 25565 }).because,
    ).toBe("no-rule");
    const off = { ...snap([]), profiles: snap([]).profiles.map((p) => ({ ...p, enabled: false })) };
    expect(evaluateInbound(off, { program: java, protocol: "UDP", port: 19132 }).because).toBe(
      "firewall-off",
    );
  });

  it("writes a fix script that quotes paths", () => {
    const script = firewallFixScript(
      [
        { kind: "remove-program-rules", program: "C:\\it's\\java.exe", which: "block" },
        {
          kind: "allow-port",
          name: "cubehold Survival (TCP 25565)",
          program: java,
          protocol: "TCP",
          port: 25565,
        },
      ],
      "C:\\tmp\\err.txt",
    );
    expect(script).toContain("'C:\\it''s\\java.exe'");
    expect(script).toContain("-Protocol TCP -LocalPort 25565");
    expect(script).toContain("-Group 'cubehold'");
  });
});

group("network helpers", () => {
  it("classifies addresses and the WAN side", () => {
    expect(isPrivateIPv4("192.168.1.21")).toBe(true);
    expect(isPrivateIPv4("172.32.0.1")).toBe(false);
    expect(isSharedIPv4("100.100.1.1")).toBe(true);
    expect(classifyWan("95.44.69.65", "95.44.69.65")).toBe("public");
    expect(classifyWan("100.72.3.4", "95.44.69.65")).toBe("cgnat");
    expect(classifyWan("192.168.0.2", "95.44.69.65")).toBe("double-nat");
    expect(classifyWan("81.2.3.4", "95.44.69.65")).toBe("cgnat");
    expect(classifyWan(null, "95.44.69.65")).toBe("unknown");
  });

  it("splits addresses and flattens chat", () => {
    expect(splitAddress("play.example.com")).toEqual({
      host: "play.example.com",
      port: 25565,
      explicitPort: false,
    });
    expect(splitAddress("1.2.3.4:25570")).toMatchObject({ port: 25570, explicitPort: true });
    expect(splitAddress("[2001:db8::1]:25566")).toMatchObject({ host: "2001:db8::1", port: 25566 });
    expect(chatToText({ text: "§aHi ", extra: [{ text: "there" }, "!"] })).toBe("Hi there!");
  });
});

group("ngrok and Cloudflare helpers", () => {
  it("writes an ngrok v3 config with one TCP endpoint per server and no token", () => {
    const yml = ngrokConfig(
      [
        { name: ngrokEndpointName("abc123"), port: 25565 },
        { name: "cubehold-b", port: 25570 },
      ],
      "127.0.0.1:4551",
    );
    expect(yml).toContain("version: 3");
    expect(yml).toContain("web_addr: 127.0.0.1:4551");
    expect(yml).toContain(
      "  - name: cubehold-abc123\n    url: tcp://\n    upstream:\n      url: 127.0.0.1:25565",
    );
    expect(yml).not.toMatch(/authtoken/);
    expect(tcpAddress("tcp://0.tcp.eu.ngrok.io:12345")).toBe("0.tcp.eu.ngrok.io:12345");
    expect(isNgrokToken("2abcDEF_1234567890abcdefghijklmnopqrstuv")).toBe(true);
    expect(isNgrokToken("not a token")).toBe(false);
    expect(ngrokDownload("win32", "x64")?.url).toMatch(/windows-amd64\.zip$/);
  });

  it("reads Cloudflare tunnel tokens and ingress services", () => {
    const token = Buffer.from(
      JSON.stringify({ a: "acc", t: "11111111-2222-3333-4444-555555555555", s: "c2VjcmV0" }),
    ).toString("base64");
    expect(parseTunnelToken(token)).toEqual({
      accountTag: "acc",
      tunnelId: "11111111-2222-3333-4444-555555555555",
    });
    expect(parseTunnelToken("eyJub3QiOiJhIHRva2VuIn0=")).toBeNull();
    expect(servicePort("tcp://localhost:25565")).toBe(25565);
    expect(servicePort("tcp://127.0.0.1:25570")).toBe(25570);
    expect(servicePort("http://localhost:8080")).toBeNull();
    expect(cloudflaredAssetName("win32", "x64")).toBe("cloudflared-windows-amd64.exe");
    expect(friendCommands("mc.example.com").windows).toContain(
      "cloudflared access tcp --hostname mc.example.com --url 127.0.0.1:25565",
    );
  });

  it("explains why playit.gg refused to create a tunnel", () => {
    expect(describeCreateError(new PlayitError("fail", "RequiresVerifiedAccount", "x"))).toEqual({
      message: "Verify your email on playit.gg first, then try again.",
      websiteOnly: false,
    });
    expect(
      describeCreateError(
        new PlayitError("error", { type: "auth", message: "ScopeNotAllowed" }, "x"),
      ).websiteOnly,
    ).toBe(true);
  });
});

group("playit.gg", () => {
  it("makes claim codes and links like the official agent", () => {
    const code = generateClaimCode();
    expect(code).toMatch(/^[0-9a-f]{10}$/);
    expect(claimUrl(code)).toBe(`https://playit.gg/claim/${code}`);
    expect(() => claimUrl("nope")).toThrow();
  });

  it("picks the right daemon build", () => {
    expect(playitAssetName("win32", "x64")).toBe("playit-windows-x86_64-signed.exe");
    expect(playitAssetName("linux", "arm64")).toBe("playit-linux-aarch64");
    expect(playitAssetName("darwin", "arm64")).toBeNull();
  });

  it("reads tunnels and where they lead", () => {
    const data = parseRundata({
      agent_id: "a1",
      tunnels: [
        {
          id: "t1",
          name: "Survival",
          display_address: "fox-ring.gl.joinmc.link",
          port_type: "tcp",
          tunnel_type: "minecraft-java",
          tunnel_type_display: "Minecraft Java",
          agent_config: {
            fields: [
              { name: "local_ip", value: "127.0.0.1" },
              { name: "local_port", value: "25570" },
            ],
          },
          disabled_reason: null,
        },
        {
          id: "t2",
          name: "Bedrock",
          display_address: "147.185.221.20:19132",
          port_type: "udp",
          tunnel_type: "minecraft-bedrock",
          tunnel_type_display: "Minecraft Bedrock",
          agent_config: { fields: [] },
          disabled_reason: "requires premium",
        },
      ],
      pending: [],
      notices: [{ priority: "Low", message: "hello", resolve_link: null }],
      permissions: { has_premium: false, account_status: "verified" },
    });
    expect(data.tunnels[0]).toMatchObject({
      localIp: "127.0.0.1",
      localPort: 25570,
      address: "fox-ring.gl.joinmc.link",
    });
    // Without local_port the agent uses the public port, and so does this.
    expect(data.tunnels[1]).toMatchObject({
      localPort: 19132,
      localIp: "127.0.0.1",
      disabledReason: "requires premium",
    });
    expect(data.accountStatus).toBe("verified");
  });
});
