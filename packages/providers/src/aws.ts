import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteKeyPairCommand,
  DeleteSecurityGroupCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeInstanceTypesCommand,
  DescribeKeyPairsCommand,
  DescribeRegionsCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
  EC2Client,
  ImportKeyPairCommand,
  type IpPermission,
  RevokeSecurityGroupIngressCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { GetProductsCommand, PricingClient } from "@aws-sdk/client-pricing";
import { continentOf } from "./http.js";
import { alwaysOnMonthly, BILLING, HOURS_PER_MONTH } from "./pricing.js";
import {
  CloudError,
  type CloudErrorCode,
  type CloudProvider,
  type CloudRegion,
  type CloudResource,
  type CloudSize,
  type CloudVm,
  type CreateVmRequest,
  type FirewallPort,
  type SnapshotState,
  type VmStatus,
} from "./types.js";

/** Anything with the SDK clients' send(); tests pass a fake. */
export interface AwsSender {
  send(command: unknown): Promise<unknown>;
}

export interface AwsOptions {
  ec2?: (region: string) => AwsSender;
  pricing?: () => AwsSender;
}

/** Instance types worth running Minecraft on, with US East on-demand prices as a fallback. */
const TYPES: Record<string, number> = {
  "t3a.medium": 0.0376,
  "t3a.large": 0.0752,
  "t3a.xlarge": 0.1504,
  "t4g.medium": 0.0336,
  "t4g.large": 0.0672,
  "t4g.xlarge": 0.1344,
  "m7i.large": 0.1008,
  "m7i.xlarge": 0.2016,
  "m7g.large": 0.0816,
  "m7g.xlarge": 0.1632,
  "c7i.large": 0.0893,
  "c7i.xlarge": 0.1785,
  "c7g.large": 0.0725,
  "c7g.xlarge": 0.145,
};

const REGION_NAMES: Record<string, [string, string]> = {
  "us-east-1": ["US East (N. Virginia)", "US"],
  "us-east-2": ["US East (Ohio)", "US"],
  "us-west-1": ["US West (N. California)", "US"],
  "us-west-2": ["US West (Oregon)", "US"],
  "ca-central-1": ["Canada (Central)", "CA"],
  "sa-east-1": ["South America (São Paulo)", "BR"],
  "eu-west-1": ["Europe (Ireland)", "IE"],
  "eu-west-2": ["Europe (London)", "GB"],
  "eu-west-3": ["Europe (Paris)", "FR"],
  "eu-central-1": ["Europe (Frankfurt)", "DE"],
  "eu-central-2": ["Europe (Zurich)", "CH"],
  "eu-north-1": ["Europe (Stockholm)", "SE"],
  "eu-south-1": ["Europe (Milan)", "IT"],
  "eu-south-2": ["Europe (Spain)", "ES"],
  "ap-south-1": ["Asia Pacific (Mumbai)", "IN"],
  "ap-southeast-1": ["Asia Pacific (Singapore)", "SG"],
  "ap-southeast-2": ["Asia Pacific (Sydney)", "AU"],
  "ap-northeast-1": ["Asia Pacific (Tokyo)", "JP"],
  "ap-northeast-2": ["Asia Pacific (Seoul)", "KR"],
  "ap-northeast-3": ["Asia Pacific (Osaka)", "JP"],
  "ap-east-1": ["Asia Pacific (Hong Kong)", "HK"],
  "me-central-1": ["Middle East (UAE)", "AE"],
  "af-south-1": ["Africa (Cape Town)", "ZA"],
};

/** The root disk the panel gives every instance. */
const ROOT_DISK_GB = 30;

const ALL_V4 = [{ CidrIp: "0.0.0.0/0" }];
const ALL_V6 = [{ CidrIpv6: "::/0" }];

/**
 * Amazon EC2 with an IAM user's access key. VMs live in the region's default
 * VPC with their own security group; ids are "region:id" since every EC2
 * resource is regional. Stopping an instance ends compute billing, so there
 * are no snapshots here.
 */
export class AwsProvider implements CloudProvider {
  readonly id = "aws" as const;
  readonly loginUser = "ubuntu";
  #ec2 = new Map<string, AwsSender>();
  #makeEc2: (region: string) => AwsSender;
  #pricing: () => AwsSender;
  #prices = new Map<string, { at: number; price: number | null }>();

  constructor(
    private readonly cred: { accessKeyId: string; secretAccessKey: string; region: string },
    opts: AwsOptions = {},
  ) {
    const credentials = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };
    this.#makeEc2 =
      opts.ec2 ?? ((region) => new EC2Client({ region, credentials, maxAttempts: 3 }));
    this.#pricing =
      opts.pricing ??
      (() => new PricingClient({ region: "us-east-1", credentials, maxAttempts: 2 }));
  }

  async verify() {
    await this.#send(this.cred.region, new DescribeRegionsCommand({}));
    const k = this.cred.accessKeyId;
    return { account: `access key ${k.slice(0, 4)}…${k.slice(-4)}` };
  }

  async regions(): Promise<CloudRegion[]> {
    const r = (await this.#send(this.cred.region, new DescribeRegionsCommand({}))) as {
      Regions?: Array<{ RegionName?: string }>;
    };
    return (r.Regions ?? [])
      .map((x) => x.RegionName ?? "")
      .filter(Boolean)
      .map((id) => {
        const [name, country] = REGION_NAMES[id] ?? [id, null];
        return { id, name: `${name} (${id})`, country, continent: continentOf(country) };
      });
  }

  async sizes(region: string): Promise<CloudSize[]> {
    const offered = (await this.#send(
      region,
      new DescribeInstanceTypeOfferingsCommand({
        LocationType: "region",
        Filters: [{ Name: "instance-type", Values: Object.keys(TYPES) }],
      }),
    )) as { InstanceTypeOfferings?: Array<{ InstanceType?: string }> };
    const names = (offered.InstanceTypeOfferings ?? [])
      .map((o) => o.InstanceType ?? "")
      .filter((t) => t in TYPES);
    if (names.length === 0) return [];
    const info = (await this.#send(
      region,
      new DescribeInstanceTypesCommand({ InstanceTypes: names as never }),
    )) as {
      InstanceTypes?: Array<{
        InstanceType?: string;
        VCpuInfo?: { DefaultVCpus?: number };
        MemoryInfo?: { SizeInMiB?: number };
        ProcessorInfo?: { SupportedArchitectures?: string[] };
        BurstablePerformanceSupported?: boolean;
      }>;
    };
    const prices = await Promise.all(names.map((t) => this.#price(t, region)));
    const out: CloudSize[] = [];
    for (const t of info.InstanceTypes ?? []) {
      const name = t.InstanceType ?? "";
      const listed = prices[names.indexOf(name)];
      const hourly = listed ?? TYPES[name] ?? 0;
      out.push({
        id: name,
        label: name,
        vcpus: t.VCpuInfo?.DefaultVCpus ?? 0,
        memoryMb: t.MemoryInfo?.SizeInMiB ?? 0,
        diskGb: ROOT_DISK_GB,
        arch: t.ProcessorInfo?.SupportedArchitectures?.includes("arm64") ? "arm64" : "x64",
        dedicated: false,
        burstable: t.BurstablePerformanceSupported === true || /^t\d/.test(name),
        priceHourly: hourly,
        priceMonthly: Math.round(hourly * 730 * 100) / 100,
        currency: "USD",
        priceSource: listed === null || listed === undefined ? "estimate" : "api",
      });
    }
    return out.sort((a, b) => a.priceMonthly - b.priceMonthly);
  }

  async ensureSshKey(name: string, publicKey: string, region: string): Promise<string> {
    const keyName = name.replace(/[^\w.-]/g, "-").slice(0, 255);
    const existing = (await this.#send(
      region,
      new DescribeKeyPairsCommand({ Filters: [{ Name: "key-name", Values: [keyName] }] }),
    ).catch(() => ({ KeyPairs: [] }))) as { KeyPairs?: unknown[] };
    if ((existing.KeyPairs ?? []).length === 0) {
      await this.#send(
        region,
        new ImportKeyPairCommand({ KeyName: keyName, PublicKeyMaterial: Buffer.from(publicKey) }),
      );
    }
    return `${region}:${keyName}`;
  }

  async deleteSshKey(id: string): Promise<void> {
    const [region, name] = split(id);
    await this.#send(region, new DeleteKeyPairCommand({ KeyName: name })).catch(ignoreMissing);
  }

  async createFirewall(
    name: string,
    region: string,
    tag: string,
    ports: FirewallPort[],
  ): Promise<string> {
    const vpcs = (await this.#send(
      region,
      new DescribeVpcsCommand({ Filters: [{ Name: "is-default", Values: ["true"] }] }),
    )) as { Vpcs?: Array<{ VpcId?: string }> };
    const vpc = vpcs.Vpcs?.[0]?.VpcId;
    if (!vpc) {
      throw new CloudError(
        "invalid",
        `This AWS region has no default VPC. Create one (VPC console → Your VPCs → Actions → Create default VPC) and try again.`,
      );
    }
    const sg = (await this.#send(
      region,
      new CreateSecurityGroupCommand({
        GroupName: name.replace(/[^\w .-]/g, "-").slice(0, 255),
        Description: "cubehold: SSH and Minecraft",
        VpcId: vpc,
        TagSpecifications: [
          { ResourceType: "security-group", Tags: [{ Key: "cubehold-host", Value: tag }] },
        ],
      }),
    )) as { GroupId?: string };
    const id = `${region}:${sg.GroupId}`;
    await this.#authorize(region, sg.GroupId ?? "", wanted(ports));
    return id;
  }

  async setFirewall(id: string, ports: FirewallPort[]): Promise<void> {
    const [region, group] = split(id);
    const r = (await this.#send(
      region,
      new DescribeSecurityGroupsCommand({ GroupIds: [group] }),
    )) as { SecurityGroups?: Array<{ IpPermissions?: IpPermission[] }> };
    const have = r.SecurityGroups?.[0]?.IpPermissions ?? [];
    const want = wanted(ports);
    const key = (p: IpPermission) => `${p.IpProtocol}/${p.FromPort}/${p.ToPort}`;
    const wantKeys = new Set(want.map(key));
    const haveKeys = new Set(have.map(key));
    const revoke = have.filter((p) => !wantKeys.has(key(p)));
    const add = want.filter((p) => !haveKeys.has(key(p)));
    if (revoke.length > 0) {
      await this.#send(
        region,
        new RevokeSecurityGroupIngressCommand({ GroupId: group, IpPermissions: revoke }),
      );
    }
    if (add.length > 0) await this.#authorize(region, group, add);
  }

  async deleteFirewall(id: string): Promise<void> {
    const [region, group] = split(id);
    await this.#send(region, new DeleteSecurityGroupCommand({ GroupId: group })).catch(
      ignoreMissing,
    );
  }

  async createVm(req: CreateVmRequest): Promise<CloudVm> {
    if (req.image.kind !== "ubuntu")
      throw new CloudError("unsupported", "AWS VMs are stopped, not imaged");
    const image = await this.#ubuntu(req.region, req.arch);
    const [, keyName] = split(req.sshKeyId);
    const [, group] = split(req.firewallId);
    const tags = [
      { Key: "Name", Value: req.name },
      { Key: "cubehold-host", Value: req.tag },
    ];
    const r = (await this.#send(
      req.region,
      new RunInstancesCommand({
        ImageId: image.id,
        InstanceType: req.size as never,
        MinCount: 1,
        MaxCount: 1,
        KeyName: keyName,
        SecurityGroupIds: [group],
        InstanceInitiatedShutdownBehavior: "stop",
        MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
        BlockDeviceMappings: [
          {
            DeviceName: image.rootDevice,
            Ebs: {
              VolumeSize: req.diskGb ?? 30,
              VolumeType: "gp3",
              DeleteOnTermination: true,
              Encrypted: true,
            },
          },
        ],
        TagSpecifications: [
          { ResourceType: "instance", Tags: tags },
          { ResourceType: "volume", Tags: tags },
        ],
      }),
    )) as { Instances?: AwsInstance[] };
    const inst = r.Instances?.[0];
    if (!inst?.InstanceId)
      throw new CloudError("unavailable", "AWS did not return the new instance");
    return vmOf(req.region, inst);
  }

  async getVm(id: string): Promise<CloudVm | null> {
    const [region, instance] = split(id);
    try {
      const r = (await this.#send(
        region,
        new DescribeInstancesCommand({ InstanceIds: [instance] }),
      )) as { Reservations?: Array<{ Instances?: AwsInstance[] }> };
      const inst = r.Reservations?.[0]?.Instances?.[0];
      if (!inst || inst.State?.Name === "terminated") return null;
      return vmOf(region, inst);
    } catch (err) {
      if (err instanceof CloudError && err.code === "not-found") return null;
      throw err;
    }
  }

  async startVm(id: string): Promise<void> {
    const [region, instance] = split(id);
    await this.#send(region, new StartInstancesCommand({ InstanceIds: [instance] }));
  }

  async stopVm(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const [region, instance] = split(id);
    await this.#send(
      region,
      new StopInstancesCommand({ InstanceIds: [instance], Force: opts.force }),
    );
  }

  async deleteVm(id: string): Promise<void> {
    const [region, instance] = split(id);
    await this.#send(region, new TerminateInstancesCommand({ InstanceIds: [instance] })).catch(
      ignoreMissing,
    );
  }

  async snapshotVm(): Promise<string> {
    throw new CloudError(
      "unsupported",
      "On AWS, stopping the instance already ends compute charges.",
    );
  }

  async snapshotState(): Promise<SnapshotState> {
    return { status: "missing", imageId: null, sizeGb: null };
  }

  async deleteSnapshot(): Promise<void> {}

  /** Instances in every enabled region, and the panel's security groups and key pairs. */
  async inventory(): Promise<CloudResource[]> {
    const r = (await this.#send(this.cred.region, new DescribeRegionsCommand({}))) as {
      Regions?: Array<{ RegionName?: string }>;
    };
    const regions = (r.Regions ?? []).map((x) => x.RegionName ?? "").filter(Boolean);
    const out: CloudResource[] = [];
    const queue = [...regions];
    const worker = async () => {
      for (let region = queue.shift(); region; region = queue.shift()) {
        out.push(...(await this.#regionInventory(region)));
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
    return out;
  }

  async #regionInventory(region: string): Promise<CloudResource[]> {
    type Tags = Array<{ Key?: string; Value?: string }>;
    let found: unknown[];
    try {
      found = await Promise.all([
        this.#send(
          region,
          new DescribeInstancesCommand({
            Filters: [
              {
                Name: "instance-state-name",
                Values: ["pending", "running", "stopping", "stopped"],
              },
            ],
          }),
        ),
        this.#send(
          region,
          new DescribeSecurityGroupsCommand({
            Filters: [{ Name: "tag-key", Values: ["cubehold-host"] }],
          }),
        ),
        this.#send(
          region,
          new DescribeKeyPairsCommand({ Filters: [{ Name: "key-name", Values: ["cubehold-*"] }] }),
        ),
      ]);
    } catch (err) {
      // A region the account cannot use (not opted in, or blocked by policy) has nothing in it.
      if (err instanceof CloudError && (err.code === "permission" || err.code === "auth"))
        return [];
      throw err;
    }
    const inst = found[0] as {
      Reservations?: Array<{
        Instances?: Array<AwsInstance & { InstanceType?: string; Tags?: Tags }>;
      }>;
    };
    const groups = found[1] as {
      SecurityGroups?: Array<{ GroupId?: string; GroupName?: string; Tags?: Tags }>;
    };
    const keys = found[2] as { KeyPairs?: Array<{ KeyName?: string }> };
    const out: CloudResource[] = [];
    for (const res of inst.Reservations ?? []) {
      for (const i of res.Instances ?? []) {
        if (!i.InstanceId) continue;
        const tag = i.Tags?.find((t) => t.Key === "cubehold-host")?.Value ?? null;
        const name = i.Tags?.find((t) => t.Key === "Name")?.Value ?? i.InstanceId;
        const type = i.InstanceType ?? "";
        const state = i.State?.Name ?? "unknown";
        const hourly = (await this.#price(type, region)) ?? TYPES[type] ?? null;
        // Other people's disks are not visible to the panel's policy; ours are 30 GB.
        const diskGb = tag ? ROOT_DISK_GB : 0;
        const disk = diskGb * BILLING.aws.diskPerGbMonth || 0;
        const monthly =
          state === "stopped"
            ? disk
            : hourly === null
              ? null
              : alwaysOnMonthly("aws", {
                  priceHourly: hourly,
                  priceMonthly: hourly * HOURS_PER_MONTH,
                  diskGb,
                });
        out.push({
          kind: "vm",
          id: `${region}:${i.InstanceId}`,
          name,
          region,
          ours: !!tag,
          tag,
          detail: `${type}, ${state === "stopped" ? "stopped" : state}`,
          monthly,
        });
      }
    }
    for (const g of groups.SecurityGroups ?? []) {
      if (!g.GroupId) continue;
      out.push({
        kind: "firewall",
        id: `${region}:${g.GroupId}`,
        name: g.GroupName ?? g.GroupId,
        region,
        ours: true,
        tag: g.Tags?.find((t) => t.Key === "cubehold-host")?.Value ?? null,
        detail: "Security group",
        monthly: 0,
      });
    }
    for (const k of keys.KeyPairs ?? []) {
      if (!k.KeyName) continue;
      out.push({
        kind: "ssh-key",
        id: `${region}:${k.KeyName}`,
        name: k.KeyName,
        region,
        ours: true,
        tag: /^(cubehold-[0-9a-f]{12})$/.exec(k.KeyName)?.[1] ?? null,
        detail: "Key pair",
        monthly: 0,
      });
    }
    return out;
  }

  async deleteResource(r: Pick<CloudResource, "kind" | "id">): Promise<void> {
    switch (r.kind) {
      case "vm":
        return this.deleteVm(r.id);
      case "firewall":
        return this.deleteFirewall(r.id);
      case "ssh-key":
        return this.deleteSshKey(r.id);
      default:
        throw new CloudError("unsupported", "Delete this in the AWS console.");
    }
  }

  async #ubuntu(
    region: string,
    arch: "x64" | "arm64",
  ): Promise<{ id: string; rootDevice: string }> {
    const r = (await this.#send(
      region,
      new DescribeImagesCommand({
        Owners: ["099720109477"], // Canonical
        Filters: [
          {
            Name: "name",
            Values: [
              `ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${arch === "arm64" ? "arm64" : "amd64"}-server-*`,
            ],
          },
          { Name: "state", Values: ["available"] },
        ],
      }),
    )) as { Images?: Array<{ ImageId?: string; CreationDate?: string; RootDeviceName?: string }> };
    const newest = (r.Images ?? [])
      .filter((i) => i.ImageId)
      .sort((a, b) => (b.CreationDate ?? "").localeCompare(a.CreationDate ?? ""))[0];
    if (!newest?.ImageId) {
      throw new CloudError("unavailable", `No Ubuntu 24.04 image for ${arch} in ${region}`);
    }
    return { id: newest.ImageId, rootDevice: newest.RootDeviceName ?? "/dev/sda1" };
  }

  /** On-demand Linux price from the Price List API; null when the key may not read it. */
  async #price(type: string, region: string): Promise<number | null> {
    const key = `${region}/${type}`;
    const hit = this.#prices.get(key);
    if (hit && Date.now() - hit.at < 24 * 60 * 60_000) return hit.price;
    let price: number | null = null;
    try {
      const f = (Field: string, Value: string) => ({ Type: "TERM_MATCH" as const, Field, Value });
      const r = (await this.#pricing().send(
        new GetProductsCommand({
          ServiceCode: "AmazonEC2",
          Filters: [
            f("instanceType", type),
            f("regionCode", region),
            f("operatingSystem", "Linux"),
            f("tenancy", "Shared"),
            f("preInstalledSw", "NA"),
            f("capacitystatus", "Used"),
            f("licenseModel", "No License required"),
          ],
          MaxResults: 5,
        }),
      )) as { PriceList?: unknown[] };
      price = parsePrice(r.PriceList ?? []);
    } catch {
      price = null;
    }
    this.#prices.set(key, { at: Date.now(), price });
    return price;
  }

  async #authorize(region: string, group: string, perms: IpPermission[]): Promise<void> {
    await this.#send(
      region,
      new AuthorizeSecurityGroupIngressCommand({ GroupId: group, IpPermissions: perms }),
    ).catch((err) => {
      if (err instanceof CloudError && /Duplicate/i.test(err.message)) return;
      throw err;
    });
  }

  async #send(region: string, command: unknown): Promise<unknown> {
    let client = this.#ec2.get(region);
    if (!client) {
      client = this.#makeEc2(region);
      this.#ec2.set(region, client);
    }
    try {
      return await client.send(command);
    } catch (err) {
      throw awsError(err);
    }
  }
}

interface AwsInstance {
  InstanceId?: string;
  State?: { Name?: string };
  PublicIpAddress?: string;
  Ipv6Address?: string;
}

function vmOf(region: string, i: AwsInstance): CloudVm {
  const map: Record<string, VmStatus> = {
    pending: "starting",
    running: "running",
    stopping: "stopping",
    stopped: "stopped",
    "shutting-down": "deleting",
  };
  return {
    id: `${region}:${i.InstanceId}`,
    status: map[i.State?.Name ?? ""] ?? "unknown",
    ipv4: i.PublicIpAddress ?? null,
    ipv6: i.Ipv6Address ?? null,
  };
}

function wanted(ports: FirewallPort[]): IpPermission[] {
  const perm = (
    IpProtocol: string,
    FromPort: number,
    ToPort: number,
    note: string,
  ): IpPermission => ({
    IpProtocol,
    FromPort,
    ToPort,
    IpRanges: ALL_V4.map((r) => ({ ...r, Description: note })),
    Ipv6Ranges: ALL_V6.map((r) => ({ ...r, Description: note })),
  });
  return [
    perm("tcp", 22, 22, "SSH"),
    perm("icmp", 8, -1, "ping"),
    ...ports.map((p) => perm(p.protocol, p.port, p.port, (p.note ?? "Minecraft").slice(0, 255))),
  ];
}

export function parsePrice(list: unknown[]): number | null {
  for (const item of list) {
    try {
      const doc = (typeof item === "string" ? JSON.parse(item) : JSON.parse(String(item))) as {
        terms?: {
          OnDemand?: Record<
            string,
            { priceDimensions?: Record<string, { pricePerUnit?: { USD?: string } }> }
          >;
        };
      };
      for (const term of Object.values(doc.terms?.OnDemand ?? {})) {
        for (const dim of Object.values(term.priceDimensions ?? {})) {
          const usd = Number(dim.pricePerUnit?.USD);
          if (usd > 0) return usd;
        }
      }
    } catch {
      // not JSON; try the next entry
    }
  }
  return null;
}

function split(id: string): [string, string] {
  const i = id.indexOf(":");
  return [id.slice(0, i), id.slice(i + 1)];
}

function ignoreMissing(err: unknown): void {
  if (err instanceof CloudError && err.code === "not-found") return;
  throw err;
}

/** SDK exceptions to CloudError with what to do about them. */
export function awsError(err: unknown): CloudError {
  if (err instanceof CloudError) return err;
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = e.name ?? "";
  const msg = e.message ?? String(err);
  const table: Array<[RegExp, CloudErrorCode, string]> = [
    [
      /AuthFailure|InvalidClientTokenId|SignatureDoesNotMatch|UnrecognizedClient/,
      "auth",
      "AWS did not accept the access key. Create a new one for the IAM user and paste it again.",
    ],
    [
      /OptInRequired/,
      "permission",
      "This AWS region is not enabled for the account. Enable it under Account → AWS Regions, or pick another region.",
    ],
    [
      /PendingVerification/,
      "limit",
      "AWS is still verifying the account; new accounts can take a few hours before they can start instances.",
    ],
    [
      /UnauthorizedOperation|AccessDenied/,
      "permission",
      "The IAM user may not do this. Attach the cubehold policy shown in the account wizard.",
    ],
    [
      /VcpuLimitExceeded|InstanceLimitExceeded|MaxSpotInstanceCountExceeded/,
      "limit",
      'The account\'s vCPU limit is reached. New AWS accounts start with a low limit; request an increase for "Running On-Demand Standard instances" under Service Quotas.',
    ],
    [
      /InsufficientInstanceCapacity/,
      "capacity",
      "AWS has no capacity for this instance type there right now. Try another size or region.",
    ],
    [/NotFound/, "not-found", msg],
    [
      /RequestLimitExceeded|Throttling/,
      "rate-limit",
      "AWS asks the panel to slow down; try again in a minute.",
    ],
    [/Unsupported/, "unsupported", msg],
  ];
  for (const [re, code, text] of table) {
    if (re.test(name)) return new CloudError(code, text, e.$metadata?.httpStatusCode ?? null);
  }
  return new CloudError("invalid", `AWS: ${msg}`, e.$metadata?.httpStatusCode ?? null);
}
