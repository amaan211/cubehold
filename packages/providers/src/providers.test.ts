import { describe, expect, it } from "vitest";
import {
  AWS_POLICY,
  AwsProvider,
  awsError,
  CloudError,
  type CloudProvider,
  type CloudSize,
  costOf,
  createProvider,
  exactCostOf,
  hostTag,
  hourlyRate,
  linodeLabel,
  monthlyEstimate,
  type ProviderId,
  parsePrice,
} from "./index.js";

// --- a tiny fake HTTP API ---------------------------------------------------------------

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  auth: string | null;
}
type Handler = (
  m: RegExpMatchArray,
  body: Record<string, unknown> | null,
  url: URL,
) => { status?: number; json?: unknown } | undefined;

function fakeApi(routes: Array<[string, RegExp, Handler]>, token = "good-token") {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ method, path: u.pathname, body, auth });
    if (auth !== `Bearer ${token}`)
      return new Response(JSON.stringify({ message: "Unable to authenticate you" }), {
        status: 401,
      });
    for (const [m, re, h] of routes) {
      const match = u.pathname.match(re);
      if (m === method && match) {
        const r = h(match, body, u) ?? {};
        const status = r.status ?? 200;
        const empty = r.json === undefined || status === 204;
        return new Response(empty ? null : JSON.stringify(r.json), { status });
      }
    }
    return new Response(JSON.stringify({ message: `no route ${method} ${u.pathname}` }), {
      status: 404,
    });
  };
  return { fetch, calls };
}

/** The same story on every provider, with the parts that differ asserted by each test. */
async function lifecycle(p: CloudProvider, region: string, size: string) {
  expect((await p.regions()).some((r) => r.id === region)).toBe(true);
  const sizes = await p.sizes(region);
  const s = sizes.find((x) => x.id === size);
  expect(s).toBeTruthy();
  expect(s?.priceMonthly).toBeGreaterThan(0);
  const key = await p.ensureSshKey("cubehold-test", "ssh-ed25519 AAAAC3Nza test", region);
  const fw = await p.createFirewall("cubehold-test", region, hostTag("h1"), [
    { protocol: "tcp", port: 25565 },
  ]);
  const vm = await p.createVm({
    name: "cubehold-test",
    region,
    size,
    arch: "x64",
    image: { kind: "ubuntu" },
    sshKeyId: key,
    publicKey: "ssh-ed25519 AAAAC3Nza test",
    firewallId: fw,
    tag: hostTag("h1"),
  });
  let now = await p.getVm(vm.id);
  for (let i = 0; i < 5 && now?.status !== "running"; i++) now = await p.getVm(vm.id);
  expect(now).toMatchObject({ status: "running", ipv4: "203.0.113.7" });
  await p.setFirewall(fw, [
    { protocol: "tcp", port: 25565 },
    { protocol: "udp", port: 19132 },
  ]);
  await p.stopVm(vm.id);
  now = await p.getVm(vm.id);
  expect(now?.status).toBe("stopped");
  return { key, fw, vm };
}

// --- Hetzner ------------------------------------------------------------------------------

function fakeHetzner() {
  let server: { id: number; status: string } | null = null;
  const images: Record<number, string> = {};
  return fakeApi([
    ["GET", /^\/v1\/servers$/, () => ({ json: { servers: [] } })],
    [
      "GET",
      /^\/v1\/locations$/,
      () => ({ json: { locations: [{ name: "fsn1", city: "Falkenstein", country: "DE" }] } }),
    ],
    [
      "GET",
      /^\/v1\/server_types$/,
      () => ({
        json: {
          server_types: [
            {
              id: 1,
              name: "cx23",
              description: "CX23",
              cores: 2,
              memory: 4,
              disk: 40,
              cpu_type: "shared",
              architecture: "x86",
              deprecation: null,
              prices: [
                {
                  location: "fsn1",
                  price_hourly: { net: "0.0088" },
                  price_monthly: { net: "5.4900" },
                },
              ],
            },
            {
              id: 2,
              name: "cx11",
              cores: 1,
              memory: 2,
              disk: 20,
              cpu_type: "shared",
              architecture: "x86",
              deprecation: { announced: "x" },
              prices: [],
            },
          ],
          meta: { pagination: { next_page: null } },
        },
      }),
    ],
    [
      "GET",
      /^\/v1\/datacenters$/,
      () => ({
        json: { datacenters: [{ location: { name: "fsn1" }, server_types: { available: [1] } }] },
      }),
    ],
    [
      "GET",
      /^\/v1\/ssh_keys$/,
      () => ({ json: { ssh_keys: [], meta: { pagination: { next_page: null } } } }),
    ],
    ["POST", /^\/v1\/ssh_keys$/, () => ({ status: 201, json: { ssh_key: { id: 11 } } })],
    ["POST", /^\/v1\/firewalls$/, () => ({ status: 201, json: { firewall: { id: 22 } } })],
    [
      "POST",
      /^\/v1\/firewalls\/22\/actions\/set_rules$/,
      () => ({ status: 201, json: { actions: [] } }),
    ],
    [
      "GET",
      /^\/v1\/firewalls\/22$/,
      () => ({
        json: {
          firewall: {
            applied_to: [
              { type: "label_selector", label_selector: { selector: "cubehold-host=x" } },
            ],
          },
        },
      }),
    ],
    [
      "POST",
      /^\/v1\/firewalls\/22\/actions\/remove_from_resources$/,
      () => ({ status: 201, json: {} }),
    ],
    ["DELETE", /^\/v1\/firewalls\/22$/, () => ({ status: 204 })],
    [
      "POST",
      /^\/v1\/servers$/,
      () => {
        server = { id: 33, status: "initializing" };
        return { status: 201, json: { server: hz(server) } };
      },
    ],
    [
      "GET",
      /^\/v1\/servers\/33$/,
      () => {
        if (!server)
          return {
            status: 404,
            json: { error: { code: "not_found", message: "server not found" } },
          };
        if (server.status === "initializing") server.status = "running";
        return { json: { server: hz(server) } };
      },
    ],
    [
      "POST",
      /^\/v1\/servers\/33\/actions\/(shutdown|poweroff)$/,
      () => {
        if (server) server.status = "off";
        return { status: 201, json: { action: { id: 1 } } };
      },
    ],
    [
      "POST",
      /^\/v1\/servers\/33\/actions\/create_image$/,
      () => {
        images[44] = "creating";
        return { status: 201, json: { image: { id: 44 } } };
      },
    ],
    [
      "GET",
      /^\/v1\/images\/44$/,
      () => {
        const st = images[44] ?? "gone";
        images[44] = "available";
        return st === "gone"
          ? { status: 404, json: { error: { message: "not found" } } }
          : { json: { image: { id: 44, status: st, image_size: 1.8, disk_size: 40 } } };
      },
    ],
    [
      "DELETE",
      /^\/v1\/images\/44$/,
      () => {
        delete images[44];
        return { status: 204 };
      },
    ],
    [
      "DELETE",
      /^\/v1\/servers\/33$/,
      () => {
        server = null;
        return { json: { action: { id: 2 } } };
      },
    ],
  ]);
}
const hz = (s: { id: number; status: string }) => ({
  id: s.id,
  status: s.status,
  public_net: { ipv4: { ip: "203.0.113.7" }, ipv6: { ip: "2a01:4f8:1:2::/64" } },
});

describe("Hetzner", () => {
  it("runs the whole VM life cycle with the right requests", async () => {
    const api = fakeHetzner();
    const p = createProvider("hetzner", { token: "good-token" }, { fetch: api.fetch });
    await p.verify();
    const sizes = await p.sizes("fsn1");
    expect(sizes.map((s) => s.id)).toEqual(["cx23"]); // deprecated one dropped
    expect(sizes[0]).toMatchObject({ memoryMb: 4096, priceMonthly: 5.49, currency: "EUR" });
    const { vm, fw } = await lifecycle(p, "fsn1", "cx23");
    const create = api.calls.find((c) => c.method === "POST" && c.path === "/v1/servers");
    expect(create?.body).toMatchObject({
      server_type: "cx23",
      location: "fsn1",
      image: "ubuntu-24.04",
      ssh_keys: [11],
      labels: { "cubehold-host": hostTag("h1") },
    });
    const fwCall = api.calls.find((c) => c.path === "/v1/firewalls" && c.method === "POST");
    expect(JSON.stringify(fwCall?.body)).toContain(`cubehold-host=${hostTag("h1")}`);
    const rules = api.calls.find((c) => c.path.endsWith("set_rules"))?.body?.rules as Array<{
      port?: string;
      protocol: string;
    }>;
    expect(rules.map((r) => `${r.protocol}/${r.port ?? ""}`)).toEqual([
      "tcp/22",
      "icmp/",
      "tcp/25565",
      "udp/19132",
    ]);
    expect((await p.getVm(vm.id))?.ipv6).toBe("2a01:4f8:1:2::1");

    const handle = await p.snapshotVm(vm.id, "cubehold-snap");
    expect(await p.snapshotState(handle)).toMatchObject({ status: "pending" });
    expect(await p.snapshotState(handle)).toMatchObject({
      status: "ready",
      imageId: "44",
      sizeGb: 1.8,
    });
    await p.deleteVm(vm.id);
    expect(await p.getVm(vm.id)).toBeNull();
    await p.deleteFirewall(fw);
    await p.deleteSnapshot("44");
    expect((await p.snapshotState("44")).status).toBe("missing");
  });

  it("explains a bad token", async () => {
    const api = fakeHetzner();
    const p = createProvider("hetzner", { token: "wrong" }, { fetch: api.fetch });
    const err = await p.verify().catch((e) => e);
    expect(err).toBeInstanceOf(CloudError);
    expect(err.code).toBe("auth");
    expect(err.message).toMatch(/Hetzner did not accept the API token/);
  });
});

// --- DigitalOcean ---------------------------------------------------------------------------

describe("DigitalOcean", () => {
  it("tags the droplet so its firewall follows it, and finds snapshots by name", async () => {
    let status = "new";
    let actionDone = false;
    const api = fakeApi([
      [
        "GET",
        /^\/v2\/account$/,
        () => ({ json: { account: { email: "me@example.com", status: "active" } } }),
      ],
      [
        "GET",
        /^\/v2\/regions$/,
        () => ({ json: { regions: [{ slug: "ams3", name: "Amsterdam 3", available: true }] } }),
      ],
      [
        "GET",
        /^\/v2\/sizes$/,
        () => ({
          json: {
            sizes: [
              {
                slug: "s-2vcpu-4gb",
                memory: 4096,
                vcpus: 2,
                disk: 80,
                price_monthly: 24,
                price_hourly: 0.0357,
                regions: ["ams3"],
                available: true,
                description: "Basic",
              },
            ],
          },
        }),
      ],
      ["GET", /^\/v2\/account\/keys$/, () => ({ json: { ssh_keys: [] } })],
      ["POST", /^\/v2\/account\/keys$/, () => ({ status: 201, json: { ssh_key: { id: 5 } } })],
      ["POST", /^\/v2\/tags$/, () => ({ status: 201, json: { tag: {} } })],
      ["POST", /^\/v2\/firewalls$/, () => ({ status: 202, json: { firewall: { id: "fw-1" } } })],
      [
        "GET",
        /^\/v2\/firewalls\/fw-1$/,
        () => ({
          json: {
            firewall: {
              id: "fw-1",
              name: "cubehold-test",
              inbound_rules: [],
              outbound_rules: [{ protocol: "tcp" }],
              tags: [hostTag("h1")],
              droplet_ids: [],
            },
          },
        }),
      ],
      ["PUT", /^\/v2\/firewalls\/fw-1$/, () => ({ json: { firewall: {} } })],
      ["POST", /^\/v2\/droplets$/, () => ({ status: 202, json: { droplet: drop(1, status) } })],
      [
        "GET",
        /^\/v2\/droplets\/1$/,
        () => {
          if (status === "new") status = "active";
          return { json: { droplet: drop(1, status) } };
        },
      ],
      [
        "POST",
        /^\/v2\/droplets\/1\/actions$/,
        (_m, body) => {
          if (body?.type === "shutdown") status = "off";
          return { status: 201, json: { action: { id: 77 } } };
        },
      ],
      [
        "GET",
        /^\/v2\/actions\/77$/,
        () => {
          const st = actionDone ? "completed" : "in-progress";
          actionDone = true;
          return { json: { action: { status: st } } };
        },
      ],
      [
        "GET",
        /^\/v2\/snapshots$/,
        () => ({
          json: { snapshots: [{ id: "900", name: "cubehold-snap", size_gigabytes: 2.2 }] },
        }),
      ],
    ]);
    const p = createProvider("digitalocean", { token: "good-token" }, { fetch: api.fetch });
    expect(await p.verify()).toEqual({ account: "me@example.com" });
    await lifecycle(p, "ams3", "s-2vcpu-4gb");
    const create = api.calls.find((c) => c.method === "POST" && c.path === "/v2/droplets");
    expect(create?.body).toMatchObject({
      image: "ubuntu-24-04-x64",
      ssh_keys: [5],
      tags: [hostTag("h1"), "cubehold"],
    });
    const fw = api.calls.find((c) => c.method === "POST" && c.path === "/v2/firewalls")?.body;
    expect(fw?.tags).toEqual([hostTag("h1")]);
    expect(fw?.outbound_rules as unknown[]).toHaveLength(3); // outbound must be allowed explicitly
    const put = api.calls.find((c) => c.method === "PUT")?.body;
    expect(JSON.stringify(put?.inbound_rules)).toContain('"ports":"19132"');
    const h = await p.snapshotVm("1", "cubehold-snap");
    expect((await p.snapshotState(h)).status).toBe("pending");
    expect(await p.snapshotState(h)).toEqual({ status: "ready", imageId: "900", sizeGb: 2.2 });
  });
});
const drop = (id: number, status: string) => ({
  id,
  status,
  networks: {
    v4: [
      { ip_address: "10.0.0.2", type: "private" },
      { ip_address: "203.0.113.7", type: "public" },
    ],
    v6: [],
  },
});

// --- Vultr ----------------------------------------------------------------------------------

describe("Vultr", () => {
  it("adds firewall rules for IPv4 and IPv6 and syncs them", async () => {
    let power = "running";
    let server = "installingbooting";
    const rules: Array<{ id: number; ip_type: string; protocol: string; port: string }> = [];
    let nextRule = 1;
    const api = fakeApi([
      [
        "GET",
        /^\/v2\/regions$/,
        () => ({
          json: { regions: [{ id: "fra", city: "Frankfurt", country: "DE", continent: "Europe" }] },
        }),
      ],
      [
        "GET",
        /^\/v2\/plans$/,
        () => ({
          json: {
            plans: [
              {
                id: "vc2-2c-4gb",
                vcpu_count: 2,
                ram: 4096,
                disk: 80,
                monthly_cost: 20,
                type: "vc2",
                locations: ["fra"],
              },
              {
                id: "vcg-a100",
                vcpu_count: 12,
                ram: 92160,
                disk: 1400,
                monthly_cost: 1750,
                type: "vcg",
                locations: ["fra"],
              },
            ],
          },
        }),
      ],
      [
        "GET",
        /^\/v2\/ssh-keys$/,
        () => ({ json: { ssh_keys: [{ id: "k-1", ssh_key: "ssh-ed25519 BBBBother other" }] } }),
      ],
      ["POST", /^\/v2\/ssh-keys$/, () => ({ status: 201, json: { ssh_key: { id: "k-2" } } })],
      [
        "POST",
        /^\/v2\/firewalls$/,
        () => ({ status: 201, json: { firewall_group: { id: "g-1" } } }),
      ],
      [
        "POST",
        /^\/v2\/firewalls\/g-1\/rules$/,
        (_m, b) => {
          rules.push({
            id: nextRule++,
            ip_type: String(b?.ip_type),
            protocol: String(b?.protocol),
            port: String(b?.port ?? ""),
          });
          return { status: 201, json: {} };
        },
      ],
      ["GET", /^\/v2\/firewalls\/g-1\/rules$/, () => ({ json: { firewall_rules: rules } })],
      [
        "DELETE",
        /^\/v2\/firewalls\/g-1\/rules\/(\d+)$/,
        (m) => {
          rules.splice(
            rules.findIndex((r) => r.id === Number(m[1])),
            1,
          );
          return { status: 204 };
        },
      ],
      [
        "GET",
        /^\/v2\/os$/,
        () => ({ json: { os: [{ id: 2284, name: "Ubuntu 24.04 LTS x64", arch: "x64" }] } }),
      ],
      [
        "POST",
        /^\/v2\/instances$/,
        () => ({ status: 202, json: { instance: vu(power, server, "pending") } }),
      ],
      [
        "GET",
        /^\/v2\/instances\/i-1$/,
        () => {
          const r = vu(power, server, "active");
          server = "ok";
          return { json: { instance: r } };
        },
      ],
      [
        "POST",
        /^\/v2\/instances\/i-1\/halt$/,
        () => {
          power = "stopped";
          return { status: 204 };
        },
      ],
    ]);
    const p = createProvider("vultr", { token: "good-token" }, { fetch: api.fetch });
    expect((await p.sizes("fra")).map((s) => s.id)).toEqual(["vc2-2c-4gb"]);
    expect((await p.sizes("fra"))[0]?.priceHourly).toBeCloseTo(20 / 672, 3);
    await lifecycle(p, "fra", "vc2-2c-4gb");
    const create = api.calls.find((c) => c.method === "POST" && c.path === "/v2/instances")?.body;
    expect(create).toMatchObject({
      os_id: 2284,
      sshkey_id: ["k-2"],
      firewall_group_id: "g-1",
      enable_ipv6: true,
    });
    expect(rules.map((r) => `${r.ip_type}/${r.protocol}/${r.port}`).sort()).toEqual(
      [
        "v4/icmp/",
        "v4/tcp/22",
        "v4/tcp/25565",
        "v4/udp/19132",
        "v6/icmp/",
        "v6/tcp/22",
        "v6/tcp/25565",
        "v6/udp/19132",
      ].sort(),
    );
  });
});
const vu = (power: string, server: string, status: string) => ({
  id: "i-1",
  main_ip: status === "pending" ? "0.0.0.0" : "203.0.113.7",
  v6_main_ip: "",
  status,
  power_status: power,
  server_status: server,
});

// --- Linode ---------------------------------------------------------------------------------

describe("Linode", () => {
  it("passes the key inline, a throwaway root password, and images the main disk", async () => {
    let status = "provisioning";
    const api = fakeApi([
      [
        "GET",
        /^\/v4\/regions$/,
        () => ({
          json: {
            data: [
              {
                id: "eu-central",
                label: "Frankfurt, DE",
                country: "de",
                status: "ok",
                capabilities: ["Linodes"],
              },
            ],
          },
        }),
      ],
      [
        "GET",
        /^\/v4\/linode\/types$/,
        () => ({
          json: {
            data: [
              {
                id: "g6-standard-2",
                label: "Linode 4GB",
                memory: 4096,
                vcpus: 2,
                disk: 81920,
                class: "standard",
                price: { hourly: 0.036, monthly: 24 },
                region_prices: [],
              },
              {
                id: "g1-gpu",
                label: "GPU",
                memory: 32768,
                vcpus: 8,
                disk: 1,
                class: "gpu",
                price: { hourly: 1, monthly: 1000 },
              },
            ],
          },
        }),
      ],
      ["POST", /^\/v4\/networking\/firewalls$/, () => ({ json: { id: 8 } })],
      ["PUT", /^\/v4\/networking\/firewalls\/8\/rules$/, () => ({ json: {} })],
      ["POST", /^\/v4\/linode\/instances$/, () => ({ json: li(status) })],
      [
        "GET",
        /^\/v4\/linode\/instances\/9$/,
        () => {
          const r = li(status);
          if (status === "provisioning") status = "running";
          return { json: r };
        },
      ],
      [
        "POST",
        /^\/v4\/linode\/instances\/9\/shutdown$/,
        () => {
          status = "offline";
          return { json: {} };
        },
      ],
      [
        "GET",
        /^\/v4\/linode\/instances\/9\/disks$/,
        () => ({
          json: {
            data: [
              { id: 1, filesystem: "swap", size: 512 },
              { id: 2, filesystem: "ext4", size: 80000 },
            ],
          },
        }),
      ],
      ["POST", /^\/v4\/images$/, () => ({ json: { id: "private/55", status: "creating" } })],
      [
        "GET",
        /^\/v4\/images\/private\/55$/,
        () => ({ json: { id: "private/55", status: "available", size: 2048 } }),
      ],
    ]);
    const p = createProvider("linode", { token: "good-token" }, { fetch: api.fetch });
    expect((await p.sizes("eu-central")).map((s) => s.id)).toEqual(["g6-standard-2"]);
    await lifecycle(p, "eu-central", "g6-standard-2");
    const create = api.calls.find(
      (c) => c.method === "POST" && c.path === "/v4/linode/instances",
    )?.body;
    expect(create).toMatchObject({
      image: "linode/ubuntu24.04",
      authorized_keys: ["ssh-ed25519 AAAAC3Nza test"],
      firewall_id: 8,
      booted: true,
    });
    expect(String(create?.root_pass).length).toBeGreaterThan(30);
    const handle = await p.snapshotVm("9", "cubehold-snap");
    expect(api.calls.find((c) => c.path === "/v4/images")?.body).toMatchObject({ disk_id: 2 });
    expect(await p.snapshotState(handle)).toEqual({
      status: "ready",
      imageId: "private/55",
      sizeGb: 2,
    });
    expect(linodeLabel("My  Server!!")).toBe("My-Server");
    expect(linodeLabel("__")).toBe("cubehold-server");
  });
});
const li = (status: string) => ({
  id: 9,
  status,
  ipv4: ["192.168.130.4", "203.0.113.7"],
  ipv6: "2600:3c00::1/128",
});

// --- AWS --------------------------------------------------------------------------------------

describe("AWS", () => {
  it("runs Ubuntu in a security group, with prices from the Price List API", async () => {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    let state = "pending";
    const perms: Array<{ IpProtocol: string; FromPort: number; ToPort: number }> = [];
    const ec2 = () => ({
      async send(cmd: unknown) {
        const name = (cmd as object).constructor.name.replace(/Command$/, "");
        const input = (cmd as { input: Record<string, unknown> }).input;
        sent.push({ name, input });
        switch (name) {
          case "DescribeRegions":
            return { Regions: [{ RegionName: "eu-central-1" }] };
          case "DescribeInstanceTypeOfferings":
            return {
              InstanceTypeOfferings: [
                { InstanceType: "t3a.medium" },
                { InstanceType: "m7g.large" },
              ],
            };
          case "DescribeInstanceTypes":
            return {
              InstanceTypes: [
                {
                  InstanceType: "t3a.medium",
                  VCpuInfo: { DefaultVCpus: 2 },
                  MemoryInfo: { SizeInMiB: 4096 },
                  ProcessorInfo: { SupportedArchitectures: ["x86_64"] },
                  BurstablePerformanceSupported: true,
                },
                {
                  InstanceType: "m7g.large",
                  VCpuInfo: { DefaultVCpus: 2 },
                  MemoryInfo: { SizeInMiB: 8192 },
                  ProcessorInfo: { SupportedArchitectures: ["arm64"] },
                },
              ],
            };
          case "DescribeKeyPairs":
            return { KeyPairs: [] };
          case "ImportKeyPair":
            return {};
          case "DescribeVpcs":
            return { Vpcs: [{ VpcId: "vpc-1" }] };
          case "CreateSecurityGroup":
            return { GroupId: "sg-1" };
          case "AuthorizeSecurityGroupIngress":
            perms.push(...(input.IpPermissions as typeof perms));
            return {};
          case "RevokeSecurityGroupIngress":
            for (const p of input.IpPermissions as typeof perms)
              perms.splice(
                perms.findIndex((x) => x.FromPort === p.FromPort && x.IpProtocol === p.IpProtocol),
                1,
              );
            return {};
          case "DescribeSecurityGroups":
            return { SecurityGroups: [{ IpPermissions: perms }] };
          case "DescribeImages":
            return {
              Images: [
                { ImageId: "ami-old", CreationDate: "2025-01-01", RootDeviceName: "/dev/sda1" },
                { ImageId: "ami-new", CreationDate: "2026-09-01", RootDeviceName: "/dev/sda1" },
              ],
            };
          case "RunInstances":
            return { Instances: [{ InstanceId: "i-1", State: { Name: "pending" } }] };
          case "DescribeInstances": {
            const r = {
              Reservations: [
                {
                  Instances: [
                    { InstanceId: "i-1", State: { Name: state }, PublicIpAddress: "203.0.113.7" },
                  ],
                },
              ],
            };
            if (state === "pending") state = "running";
            return r;
          }
          case "StopInstances":
            state = "stopped";
            return {};
          default:
            throw Object.assign(new Error(`unexpected ${name}`), { name: "Unsupported" });
        }
      },
    });
    const pricing = () => ({
      async send(cmd: unknown) {
        const f = (cmd as { input: { Filters: Array<{ Field: string; Value: string }> } }).input
          .Filters;
        if (f.find((x) => x.Field === "instanceType")?.Value === "m7g.large") {
          throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
        }
        return {
          PriceList: [
            JSON.stringify({
              terms: {
                OnDemand: {
                  a: { priceDimensions: { b: { pricePerUnit: { USD: "0.0432000000" } } } },
                },
              },
            }),
          ],
        };
      },
    });
    const p = new AwsProvider(
      { accessKeyId: "AKIAEXAMPLE1234", secretAccessKey: "s", region: "eu-central-1" },
      { ec2, pricing },
    );
    expect((await p.verify()).account).toBe("access key AKIA…1234");
    const sizes = await p.sizes("eu-central-1");
    expect(sizes.find((s) => s.id === "t3a.medium")).toMatchObject({
      priceHourly: 0.0432,
      priceSource: "api",
      burstable: true,
      arch: "x64",
    });
    expect(sizes.find((s) => s.id === "m7g.large")).toMatchObject({
      priceSource: "estimate",
      arch: "arm64",
    });
    const { vm } = await lifecycle(p, "eu-central-1", "t3a.medium");
    expect(vm.id).toBe("eu-central-1:i-1");
    const run = sent.find((s) => s.name === "RunInstances")?.input;
    expect(run).toMatchObject({
      ImageId: "ami-new",
      KeyName: "cubehold-test",
      SecurityGroupIds: ["sg-1"],
      InstanceInitiatedShutdownBehavior: "stop",
    });
    expect(perms.map((x) => `${x.IpProtocol}/${x.FromPort}`).sort()).toEqual([
      "icmp/8",
      "tcp/22",
      "tcp/25565",
      "udp/19132",
    ]);
    await expect(p.snapshotVm()).rejects.toThrow(/stopping/);
  });

  it("turns SDK errors into advice", () => {
    expect(awsError(Object.assign(new Error("x"), { name: "VcpuLimitExceeded" })).message).toMatch(
      /Service Quotas/,
    );
    expect(awsError(Object.assign(new Error("x"), { name: "AuthFailure" })).code).toBe("auth");
    expect(awsError(Object.assign(new Error("x"), { name: "OptInRequired" })).message).toMatch(
      /not enabled/,
    );
    expect(
      parsePrice([
        "not json",
        JSON.stringify({
          terms: { OnDemand: { x: { priceDimensions: { y: { pricePerUnit: { USD: "0" } } } } } },
        }),
      ]),
    ).toBeNull();
    // Every action the provider uses is in the policy the wizard shows.
    const actions = AWS_POLICY.Statement.flatMap((s) => s.Action);
    for (const a of [
      "ec2:RunInstances",
      "ec2:ImportKeyPair",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:StopInstances",
      "pricing:GetProducts",
    ]) {
      expect(actions).toContain(a);
    }
  });
});

// --- costs --------------------------------------------------------------------------------------

describe("costs", () => {
  const size = { priceHourly: 0.0088, priceMonthly: 5.49, diskGb: 40 };
  it("caps at the monthly price and bills stopped VMs where providers do", () => {
    expect(
      costOf("hetzner", size, { running: 730, stopped: 0, hibernated: 0, snapshotGb: 0 }).compute,
    ).toBe(5.49);
    const stopped = costOf("hetzner", size, {
      running: 100,
      stopped: 630,
      hibernated: 0,
      snapshotGb: 0,
    });
    expect(stopped.compute).toBe(5.49); // Hetzner bills a stopped server in full
    expect(stopped.ip).toBeCloseTo(0.5, 2);
  });

  it("makes hibernating cheap and AWS stops cheap", () => {
    const keep = monthlyEstimate("hetzner", size, 3, "keep");
    const hib = monthlyEstimate("hetzner", size, 3, "hibernate");
    expect(hib.total).toBeLessThan(keep.total / 4);
    const aws = { priceHourly: 0.0376, priceMonthly: 27.45, diskGb: 30 };
    const awsStop = monthlyEstimate("aws", aws, 3, "stop");
    expect(awsStop.compute).toBeCloseTo(0.0376 * 91.25, 1);
    // The EBS disk is billed the whole month, running or stopped.
    expect(awsStop.storage).toBeCloseTo(30 * 0.08, 2);
    expect(monthlyEstimate("aws", aws, 24, "keep").total).toBeCloseTo(27.45 + 3.65 + 2.4, 2);
  });

  it("gives every provider a tag they accept", () => {
    const t = hostTag("_Aca7hxp9z04JRHK");
    expect(t).toMatch(/^cubehold-[0-9a-f]{12}$/);
    const ids: ProviderId[] = ["hetzner", "digitalocean", "vultr", "linode", "aws"];
    expect(ids.length).toBe(5);
  });
});

// --- what is in an account, and deleting it -------------------------------------------------

describe("inventory", () => {
  const tag = hostTag("h1");

  it("Hetzner: finds the panel's things by label and prices what costs money", async () => {
    const api = fakeApi([
      [
        "GET",
        /^\/v1\/servers$/,
        () => ({
          json: {
            servers: [
              {
                id: 7,
                name: "survival-a1b2c3",
                status: "running",
                labels: { cubehold: "1", "cubehold-host": tag },
                public_net: { ipv4: { ip: "203.0.113.7" }, ipv6: null },
                server_type: {
                  name: "cx23",
                  disk: 40,
                  prices: [
                    {
                      location: "fsn1",
                      price_hourly: { net: "0.0088" },
                      price_monthly: { net: "5.4900" },
                    },
                  ],
                },
                datacenter: { location: { name: "fsn1" } },
              },
              {
                id: 8,
                name: "my-blog",
                status: "off",
                labels: {},
                public_net: { ipv4: null, ipv6: null },
                server_type: {
                  name: "cx33",
                  disk: 80,
                  prices: [
                    {
                      location: "nbg1",
                      price_hourly: { net: "0.0136" },
                      price_monthly: { net: "8.4900" },
                    },
                  ],
                },
                datacenter: { location: { name: "nbg1" } },
              },
              {
                id: 9,
                name: "going",
                status: "deleting",
                labels: { cubehold: "1" },
                public_net: { ipv4: null, ipv6: null },
                server_type: { name: "cx23", disk: 40, prices: [] },
              },
            ],
          },
        }),
      ],
      [
        "GET",
        /^\/v1\/images$/,
        (_m, _b, url) => {
          expect(url.searchParams.get("type")).toBe("snapshot");
          return {
            json: {
              images: [
                {
                  id: 31,
                  description: `${tag}-2026-10-01-12-00`,
                  image_size: 4,
                  status: "available",
                  labels: { cubehold: "1" },
                },
              ],
            },
          };
        },
      ],
      [
        "GET",
        /^\/v1\/firewalls$/,
        () => ({
          json: {
            firewalls: [
              { id: 41, name: tag, labels: { cubehold: "1" } },
              { id: 42, name: "office", labels: {} },
            ],
          },
        }),
      ],
      [
        "GET",
        /^\/v1\/ssh_keys$/,
        () => ({ json: { ssh_keys: [{ id: 51, name: tag, labels: { cubehold: "1" } }] } }),
      ],
      [
        "GET",
        /^\/v1\/primary_ips$/,
        () => ({
          json: {
            primary_ips: [
              { id: 61, name: "spare", type: "ipv4", ip: "198.51.100.2", assignee_id: null },
              { id: 62, name: "used", type: "ipv4", ip: "198.51.100.3", assignee_id: 7 },
            ],
          },
        }),
      ],
      ["GET", /^\/v1\/volumes$/, () => ({ json: { volumes: [] } })],
      [
        "GET",
        /^\/v1\/firewalls\/41$/,
        () => ({
          json: {
            firewall: {
              applied_to: [
                { type: "label_selector", label_selector: { selector: `cubehold-host=${tag}` } },
              ],
            },
          },
        }),
      ],
      ["POST", /^\/v1\/firewalls\/41\/actions\/remove_from_resources$/, () => ({ json: {} })],
      ["DELETE", /^\/v1\/(servers|images|firewalls|ssh_keys|primary_ips)\/\d+$/, () => ({})],
    ]);
    const p = createProvider("hetzner", { token: "good-token" }, { fetch: api.fetch });
    const all = await p.inventory();
    const byId = (kind: string, id: string) => all.find((r) => r.kind === kind && r.id === id);
    expect(all.some((r) => r.id === "9")).toBe(false); // already being deleted
    expect(byId("vm", "7")).toMatchObject({ ours: true, tag, region: "fsn1", monthly: 5.99 });
    expect(byId("vm", "8")).toMatchObject({ ours: false, tag: null });
    expect(byId("vm", "8")?.monthly).toBeCloseTo(8.49, 2); // no IPv4 on that one
    expect(byId("snapshot", "31")).toMatchObject({ ours: true, tag, detail: "4 GB" });
    expect(byId("snapshot", "31")?.monthly).toBeCloseTo(4 * 0.0143, 4);
    expect(byId("firewall", "41")).toMatchObject({ ours: true, tag, monthly: 0 });
    expect(byId("firewall", "42")).toBeUndefined(); // free and not ours: not listed
    expect(byId("ssh-key", "51")).toMatchObject({ ours: true, tag });
    expect(byId("ip", "61")).toMatchObject({ ours: false });
    expect(byId("ip", "61")?.monthly).toBeCloseTo(0.5, 2);
    expect(byId("ip", "62")).toBeUndefined();

    for (const r of all.filter((x) => x.ours)) await p.deleteResource(r);
    const deletes = api.calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(deletes).toEqual([
      "/v1/servers/7",
      "/v1/images/31",
      "/v1/firewalls/41",
      "/v1/ssh_keys/51",
    ]);
    expect(api.calls.some((c) => c.path.endsWith("/remove_from_resources"))).toBe(true);
  });

  it("DigitalOcean: follows pages and recognises the panel's names and tags", async () => {
    const api = fakeApi([
      [
        "GET",
        /^\/v2\/droplets$/,
        (_m, _b, url) =>
          url.searchParams.get("page") === "1"
            ? {
                json: {
                  droplets: [
                    {
                      id: 1,
                      name: "mc-1",
                      status: "active",
                      tags: ["cubehold", tag],
                      size_slug: "s-2vcpu-4gb",
                      size: { price_monthly: 24, price_hourly: 0.03571, disk: 80 },
                      region: { slug: "fra1" },
                      networks: { v4: [], v6: [] },
                    },
                  ],
                  links: { pages: { next: "https://api.digitalocean.com/v2/droplets?page=2" } },
                },
              }
            : {
                json: {
                  droplets: [
                    {
                      id: 2,
                      name: "other",
                      status: "off",
                      tags: [],
                      size_slug: "s-1vcpu-1gb",
                      size: { price_monthly: 6, price_hourly: 0.00893, disk: 25 },
                      region: { slug: "nyc1" },
                      networks: { v4: [], v6: [] },
                    },
                  ],
                  links: {},
                },
              },
      ],
      [
        "GET",
        /^\/v2\/snapshots$/,
        () => ({
          json: {
            snapshots: [
              { id: "77", name: `${tag}-2026-10-01-09-00`, size_gigabytes: 3, regions: ["fra1"] },
            ],
          },
        }),
      ],
      ["GET", /^\/v2\/firewalls$/, () => ({ json: { firewalls: [{ id: "fw-1", name: tag }] } })],
      ["GET", /^\/v2\/account\/keys$/, () => ({ json: { ssh_keys: [{ id: 5, name: tag }] } })],
      ["GET", /^\/v2\/tags$/, () => ({ json: { tags: [{ name: tag }, { name: "cubehold" }] } })],
      ["GET", /^\/v2\/volumes$/, () => ({ json: { volumes: [] } })],
      [
        "GET",
        /^\/v2\/reserved_ips$/,
        () => ({ json: { reserved_ips: [{ ip: "192.0.2.9", droplet: null }] } }),
      ],
      ["DELETE", /^\/v2\/tags\/(.+)$/, () => ({ status: 204 })],
    ]);
    const p = createProvider("digitalocean", { token: "good-token" }, { fetch: api.fetch });
    const all = await p.inventory();
    expect(all.find((r) => r.id === "1")).toMatchObject({ kind: "vm", ours: true, tag });
    expect(all.find((r) => r.id === "1")?.monthly).toBe(24);
    expect(all.find((r) => r.id === "2")).toMatchObject({ kind: "vm", ours: false });
    expect(all.find((r) => r.id === "77")).toMatchObject({ kind: "snapshot", ours: true, tag });
    expect(all.find((r) => r.id === "77")?.monthly).toBeCloseTo(0.18, 4);
    expect(all.filter((r) => r.kind === "tag").map((r) => r.id)).toEqual([tag]);
    expect(all.find((r) => r.kind === "ip")).toMatchObject({ ours: false, monthly: 5 });
    await p.deleteResource({ kind: "tag", id: tag });
    expect(api.calls.at(-1)).toMatchObject({ method: "DELETE", path: `/v2/tags/${tag}` });
  });

  it("Vultr: pages with a cursor and prices instances from their plan", async () => {
    const api = fakeApi([
      [
        "GET",
        /^\/v2\/instances$/,
        (_m, _b, url) =>
          url.searchParams.get("cursor")
            ? { json: { instances: [], meta: { links: { next: "" } } } }
            : {
                json: {
                  instances: [
                    {
                      id: "i-1",
                      label: "mc",
                      region: "ams",
                      plan: "vc2-2c-4gb",
                      status: "active",
                      power_status: "running",
                      server_status: "ok",
                      tags: ["cubehold", tag],
                      main_ip: "203.0.113.7",
                      v6_main_ip: "",
                    },
                  ],
                  meta: { links: { next: "abc" } },
                },
              },
      ],
      [
        "GET",
        /^\/v2\/plans$/,
        () => ({ json: { plans: [{ id: "vc2-2c-4gb", monthly_cost: 20, disk: 80 }] } }),
      ],
      [
        "GET",
        /^\/v2\/snapshots$/,
        () => ({
          json: {
            snapshots: [
              {
                id: "s-1",
                description: `${tag}-x`,
                size: 25e9,
                compressed_size: 2e9,
                status: "complete",
              },
            ],
          },
        }),
      ],
      [
        "GET",
        /^\/v2\/firewalls$/,
        () => ({ json: { firewall_groups: [{ id: "f-1", description: tag }] } }),
      ],
      ["GET", /^\/v2\/ssh-keys$/, () => ({ json: { ssh_keys: [{ id: "k-1", name: tag }] } })],
      ["GET", /^\/v2\/blocks$/, () => ({ json: { blocks: [] } })],
      ["GET", /^\/v2\/reserved-ips$/, () => ({ json: { reserved_ips: [] } })],
    ]);
    const p = createProvider("vultr", { token: "good-token" }, { fetch: api.fetch });
    const all = await p.inventory();
    expect(all.find((r) => r.id === "i-1")).toMatchObject({ ours: true, tag, monthly: 20 });
    expect(all.find((r) => r.id === "s-1")?.monthly).toBeCloseTo(2 * 0.05, 4);
    expect(all.filter((r) => r.ours).length).toBe(4);
    expect(api.calls.filter((c) => c.path === "/v2/instances").length).toBe(2);
  });

  it("Linode: private images only, and region prices", async () => {
    const api = fakeApi([
      [
        "GET",
        /^\/v4\/linode\/instances$/,
        () => ({
          json: {
            data: [
              {
                id: 11,
                label: "mc",
                region: "id-cgk",
                type: "g6-standard-2",
                status: "offline",
                tags: ["cubehold", tag],
                ipv4: [],
                ipv6: null,
              },
            ],
            pages: 1,
          },
        }),
      ],
      [
        "GET",
        /^\/v4\/linode\/types$/,
        () => ({
          json: {
            data: [
              {
                id: "g6-standard-2",
                label: "Linode 4GB",
                memory: 4096,
                vcpus: 2,
                disk: 81920,
                class: "standard",
                price: { hourly: 0.036, monthly: 24 },
                region_prices: [{ id: "id-cgk", hourly: 0.043, monthly: 28.8 }],
              },
            ],
            pages: 1,
          },
        }),
      ],
      [
        "GET",
        /^\/v4\/images$/,
        () => ({
          json: {
            data: [
              { id: "linode/ubuntu24.04", label: "Ubuntu", size: 2500, is_public: true },
              { id: "private/5", label: `${tag}-x`, size: 3072, is_public: false },
            ],
            pages: 1,
          },
        }),
      ],
      [
        "GET",
        /^\/v4\/networking\/firewalls$/,
        () => ({ json: { data: [{ id: 3, label: tag, tags: ["cubehold"] }], pages: 1 } }),
      ],
      ["GET", /^\/v4\/volumes$/, () => ({ json: { data: [], pages: 1 } })],
    ]);
    const p = createProvider("linode", { token: "good-token" }, { fetch: api.fetch });
    const all = await p.inventory();
    expect(all.find((r) => r.id === "11")).toMatchObject({ ours: true, tag, monthly: 28.8 });
    expect(all.some((r) => r.id === "linode/ubuntu24.04")).toBe(false);
    expect(all.find((r) => r.id === "private/5")?.monthly).toBeCloseTo(0.3, 4);
    expect(all.find((r) => r.kind === "firewall")).toMatchObject({ id: "3", ours: true, tag });
  });

  it("AWS: looks in every region and skips the ones the key cannot use", async () => {
    const ec2 = (region: string) => ({
      async send(cmd: unknown) {
        const name = (cmd as object).constructor.name.replace(/Command$/, "");
        if (name === "DescribeRegions")
          return { Regions: [{ RegionName: "eu-central-1" }, { RegionName: "me-south-1" }] };
        if (region === "me-south-1") {
          throw Object.assign(new Error("not enabled"), { name: "UnauthorizedOperation" });
        }
        switch (name) {
          case "DescribeInstances":
            return {
              Reservations: [
                {
                  Instances: [
                    {
                      InstanceId: "i-1",
                      InstanceType: "t3a.medium",
                      State: { Name: "running" },
                      Tags: [
                        { Key: "Name", Value: "mc" },
                        { Key: "cubehold-host", Value: tag },
                      ],
                    },
                    {
                      InstanceId: "i-2",
                      InstanceType: "t3a.medium",
                      State: { Name: "stopped" },
                      Tags: [{ Key: "cubehold-host", Value: tag }],
                    },
                  ],
                },
              ],
            };
          case "DescribeSecurityGroups":
            return {
              SecurityGroups: [
                { GroupId: "sg-1", GroupName: tag, Tags: [{ Key: "cubehold-host", Value: tag }] },
              ],
            };
          case "DescribeKeyPairs":
            return { KeyPairs: [{ KeyName: tag }] };
        }
        return {};
      },
    });
    const pricing = () => ({
      async send() {
        throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      },
    });
    const p = new AwsProvider(
      {
        accessKeyId: "AKIA0000000000000000",
        secretAccessKey: "x".repeat(40),
        region: "eu-central-1",
      },
      { ec2, pricing },
    );
    const all = await p.inventory();
    expect(all.map((r) => r.id).sort()).toEqual(
      ["eu-central-1:i-1", "eu-central-1:i-2", `eu-central-1:${tag}`, "eu-central-1:sg-1"].sort(),
    );
    // Running: compute, IPv4 and the 30 GB disk. Stopped: only the disk.
    expect(all.find((r) => r.id === "eu-central-1:i-1")?.monthly).toBeCloseTo(
      0.0376 * 730 + 0.005 * 730 + 30 * 0.08,
      1,
    );
    expect(all.find((r) => r.id === "eu-central-1:i-2")?.monthly).toBeCloseTo(2.4, 2);
    await expect(p.deleteResource({ kind: "volume", id: "x" })).rejects.toThrow(/AWS console/);
  });
});

describe("billing details", () => {
  const hz = { priceHourly: 0.0088, priceMonthly: 5.49, diskGb: 40 };
  it("charges by the hour, IPv4 included, until the monthly cap", () => {
    expect(hourlyRate("hetzner", hz, "running")).toBeCloseTo(0.0088 + 0.5 / 730, 6);
    // Hetzner bills a stopped server in full, with its address.
    expect(hourlyRate("hetzner", hz, "stopped")).toBeCloseTo(0.0088 + 0.5 / 730, 6);
    // Past the VM's monthly cap only the address costs, until it reaches its own cap.
    expect(hourlyRate("hetzner", hz, "running", 0, 700)).toBeCloseTo(0.5 / 730, 6);
    expect(hourlyRate("hetzner", hz, "running", 0, 740)).toBe(0);
    // A 31-day month costs no more than a 30-day one.
    const october = costOf("hetzner", hz, {
      running: 744,
      stopped: 0,
      hibernated: 0,
      snapshotGb: 0,
    });
    expect(october.total).toBe(5.99);
    expect(hourlyRate("hetzner", hz, "hibernated", 4)).toBeCloseTo((4 * 0.0143) / 730, 8);
    expect(hourlyRate("hetzner", hz, "gone")).toBe(0);
    const aws = { priceHourly: 0.0376, priceMonthly: 27.45, diskGb: 30 };
    expect(hourlyRate("aws", aws, "stopped")).toBeCloseTo((30 * 0.08) / 730, 6);
  });

  it("uses the snapshot's real GB-hours when they are known", () => {
    const c = exactCostOf("hetzner", hz, {
      running: 0,
      stopped: 0,
      hibernated: 730,
      snapshotGb: 99,
      snapshotGbHours: 730 * 4,
    });
    expect(c.storage).toBeCloseTo(4 * 0.0143, 6);
  });
});

// --- plans billed by the hour only, and prices per location ------------------------------------

describe("hourly-only and per-location prices", () => {
  // Linode's G8 Dedicated plans have no monthly price (seen in /linode/types, October 2026).
  const g8 = {
    id: "g8-dedicated-4-2",
    label: "G8 Dedicated 4x2",
    memory: 4096,
    vcpus: 2,
    disk: 41984,
    class: "dedicated",
    price: { hourly: 0.07, monthly: null },
    region_prices: [{ id: "br-gru", hourly: 0.098, monthly: null }],
  };

  it("Linode: a plan with no monthly price is billed by the hour, never free", async () => {
    const api = fakeApi([
      ["GET", /^\/v4\/linode\/types$/, () => ({ json: { data: [g8], pages: 1 } })],
      [
        "GET",
        /^\/v4\/linode\/instances$/,
        () => ({
          json: {
            data: [
              {
                id: 5,
                label: "linode-server-f9c069",
                region: "gb-lon",
                type: "g8-dedicated-4-2",
                status: "running",
                tags: ["cubehold"],
                ipv4: [],
                ipv6: null,
              },
            ],
            pages: 1,
          },
        }),
      ],
      ["GET", /^\/v4\/images$/, () => ({ json: { data: [], pages: 1 } })],
      ["GET", /^\/v4\/networking\/firewalls$/, () => ({ json: { data: [], pages: 1 } })],
      ["GET", /^\/v4\/volumes$/, () => ({ json: { data: [], pages: 1 } })],
    ]);
    const p = createProvider("linode", { token: "good-token" }, { fetch: api.fetch });
    const [size] = await p.sizes("gb-lon");
    expect(size).toMatchObject({ priceHourly: 0.07, priceMonthly: 51.1, noMonthlyCap: true });
    expect(monthlyEstimate("linode", size as CloudSize, 24, "keep").total).toBeCloseTo(51.1, 2);
    // A 31-day month is not capped either.
    expect(
      costOf("linode", size as CloudSize, {
        running: 744,
        stopped: 0,
        hibernated: 0,
        snapshotGb: 0,
      }).compute,
    ).toBeCloseTo(52.08, 2);
    const [sao] = await p.sizes("br-gru");
    expect(sao?.priceHourly).toBe(0.098);
    const vm = (await p.inventory()).find((r) => r.id === "5");
    expect(vm?.monthly).toBeCloseTo(51.1, 2);
  });

  it("a size saved without a monthly price is not treated as free", () => {
    const saved = { priceHourly: 0.07, priceMonthly: null as unknown as number, diskGb: 40 };
    expect(monthlyEstimate("linode", saved, 24, "keep").total).toBeCloseTo(51.1, 2);
    expect(hourlyRate("linode", saved, "running", 0, 700)).toBe(0.07);
  });

  it("Vultr: a location's own price, and hourly-invoiced plans without a cap", async () => {
    const api = fakeApi([
      [
        "GET",
        /^\/v2\/plans$/,
        () => ({
          json: {
            plans: [
              {
                id: "vc2-2c-4gb",
                type: "vc2",
                vcpu_count: 2,
                ram: 4096,
                disk: 80,
                monthly_cost: 20,
                hourly_cost: 0.027,
                invoice_type: "monthly",
                location_cost: { sao: { monthly_cost: 30, hourly_cost: 0.041 } },
                locations: ["ams", "sao"],
              },
              {
                id: "vhp-2c-4gb-amd",
                type: "vhp",
                vcpu_count: 2,
                ram: 4096,
                disk: 100,
                monthly_cost: 43.8,
                hourly_cost: 0.06,
                invoice_type: "hourly",
                location_cost: {},
                locations: ["ams"],
              },
            ],
          },
        }),
      ],
    ]);
    const p = createProvider("vultr", { token: "good-token" }, { fetch: api.fetch });
    const ams = await p.sizes("ams");
    expect(ams.find((s) => s.id === "vc2-2c-4gb")).toMatchObject({
      priceMonthly: 20,
      priceHourly: 0.027,
      noMonthlyCap: false,
    });
    expect(ams.find((s) => s.id === "vhp-2c-4gb-amd")).toMatchObject({ noMonthlyCap: true });
    const sao = await p.sizes("sao");
    expect(sao[0]).toMatchObject({ priceMonthly: 30, priceHourly: 0.041 });
    // The hourly price for 730 hours stays under the cap here.
    expect(monthlyEstimate("vultr", sao[0] as CloudSize, 24, "keep").total).toBe(29.93);
  });
});
