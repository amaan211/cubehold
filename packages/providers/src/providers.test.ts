import { describe, expect, it } from "vitest";
import {
  AWS_POLICY,
  AwsProvider,
  awsError,
  CloudError,
  type CloudProvider,
  costOf,
  createProvider,
  hostTag,
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
    expect(awsStop.storage).toBeCloseTo((30 * 0.08 * (730 - 91.25)) / 730, 1);
  });

  it("gives every provider a tag they accept", () => {
    const t = hostTag("_Aca7hxp9z04JRHK");
    expect(t).toMatch(/^cubehold-[0-9a-f]{12}$/);
    const ids: ProviderId[] = ["hetzner", "digitalocean", "vultr", "linode", "aws"];
    expect(ids.length).toBe(5);
  });
});
