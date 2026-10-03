import { createHash } from "node:crypto";
import { type AwsOptions, AwsProvider } from "./aws.js";
import { DigitalOceanProvider } from "./digitalocean.js";
import { HetznerProvider } from "./hetzner.js";
import { LinodeProvider } from "./linode.js";
import type { CloudProvider, FetchLike, ProviderCredential, ProviderId } from "./types.js";
import { VultrProvider } from "./vultr.js";

export { AwsProvider, awsError, parsePrice } from "./aws.js";
export { DigitalOceanProvider } from "./digitalocean.js";
export { HetznerProvider } from "./hetzner.js";
export { errorText, RestClient } from "./http.js";
export { LinodeProvider, linodeLabel } from "./linode.js";
export * from "./pricing.js";
export * from "./types.js";
export { VultrProvider } from "./vultr.js";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  currency: "EUR" | "USD";
  credential: "token" | "aws-key";
  /** Where the token is made. */
  tokenUrl: string;
  /** Exact steps shown in the account wizard. */
  steps: string[];
  /** A stopped VM costs (almost) nothing, so "stop when idle" saves money. */
  stopSavesMoney: boolean;
  /** Snapshot-and-delete is available to save money while nobody plays. */
  snapshots: boolean;
  notes: string[];
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  hetzner: {
    id: "hetzner",
    label: "Hetzner Cloud",
    currency: "EUR",
    credential: "token",
    tokenUrl: "https://console.hetzner.com/projects",
    steps: [
      "Open the Hetzner Console and pick a project, or create one called Minecraft.",
      "In the project, open Security → API tokens and press Generate API token.",
      'Name it cubehold and choose "Read & Write".',
      "Copy the token (Hetzner shows it only once) and paste it below.",
    ],
    stopSavesMoney: false,
    snapshots: true,
    notes: ["Prices exclude VAT.", "A token only sees its own project."],
  },
  digitalocean: {
    id: "digitalocean",
    label: "DigitalOcean",
    currency: "USD",
    credential: "token",
    tokenUrl: "https://cloud.digitalocean.com/account/api/tokens",
    steps: [
      "Open API → Tokens in the DigitalOcean control panel and press Generate New Token.",
      "Name it cubehold and pick an expiry you are comfortable with.",
      'Choose "Full Access", or Custom Scopes with read and write for droplet, ssh_key, firewall, snapshot, tag and image, plus read for account, actions, regions and sizes.',
      "Copy the token (shown only once) and paste it below.",
    ],
    stopSavesMoney: false,
    snapshots: true,
    notes: [],
  },
  vultr: {
    id: "vultr",
    label: "Vultr",
    currency: "USD",
    credential: "token",
    tokenUrl: "https://my.vultr.com/settings/#settingsapi",
    steps: [
      "Open Account → API in the Vultr control panel and press Enable API.",
      "Under Access Control, add this computer's public IP address, or allow all IPv4 if it changes often.",
      "Copy the API key and paste it below.",
    ],
    stopSavesMoney: false,
    snapshots: true,
    notes: ["The key controls the whole account; keep it private."],
  },
  linode: {
    id: "linode",
    label: "Linode (Akamai)",
    currency: "USD",
    credential: "token",
    tokenUrl: "https://cloud.linode.com/profile/tokens",
    steps: [
      "Open your profile → API Tokens in Cloud Manager and press Create a Personal Access Token.",
      "Label it cubehold and pick an expiry.",
      "Set Linodes, Images and Firewalls to Read/Write; everything else can stay None.",
      "Create it, copy the token (shown only once) and paste it below.",
    ],
    stopSavesMoney: false,
    snapshots: true,
    notes: [],
  },
  aws: {
    id: "aws",
    label: "Amazon Web Services (EC2)",
    currency: "USD",
    credential: "aws-key",
    tokenUrl: "https://console.aws.amazon.com/iam/home#/policies",
    steps: [
      "In the IAM console, open Policies → Create policy → JSON, paste the policy below, and save it as cubehold.",
      "Open Users → Create user, name it cubehold, leave console access off, and attach the cubehold policy.",
      "Open the user → Security credentials → Create access key → Third-party service.",
      "Copy the access key ID and the secret access key and paste them below with the region you use most.",
    ],
    stopSavesMoney: true,
    snapshots: false,
    notes: [
      "New accounts often have a low vCPU limit; if creating fails, request more under Service Quotas (Running On-Demand Standard instances).",
      "Public IPv4 addresses cost $0.005 an hour while the instance runs, and the address changes after a stop unless you add an Elastic IP.",
    ],
  },
};

/** Least privilege for the panel's IAM user; starting, stopping and deleting only touch its own instances. */
export const AWS_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "Read",
      Effect: "Allow",
      Action: [
        "ec2:DescribeRegions",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeImages",
        "ec2:DescribeInstances",
        "ec2:DescribeVpcs",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeKeyPairs",
        "pricing:GetProducts",
      ],
      Resource: "*",
    },
    {
      Sid: "Create",
      Effect: "Allow",
      Action: [
        "ec2:RunInstances",
        "ec2:CreateTags",
        "ec2:ImportKeyPair",
        "ec2:DeleteKeyPair",
        "ec2:CreateSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupIngress",
      ],
      Resource: "*",
    },
    {
      Sid: "OwnInstancesOnly",
      Effect: "Allow",
      Action: [
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:TerminateInstances",
        "ec2:DeleteSecurityGroup",
      ],
      Resource: "*",
      Condition: { Null: { "aws:ResourceTag/cubehold-host": "false" } },
    },
  ],
};

export interface ProviderDeps {
  fetch?: FetchLike;
  aws?: AwsOptions;
}

export function createProvider(
  id: ProviderId,
  cred: ProviderCredential,
  deps: ProviderDeps = {},
): CloudProvider {
  if (id === "aws") {
    if (!cred.accessKeyId || !cred.secretAccessKey) throw new Error("AWS needs an access key");
    return new AwsProvider(
      {
        accessKeyId: cred.accessKeyId,
        secretAccessKey: cred.secretAccessKey,
        region: cred.region || "us-east-1",
      },
      deps.aws,
    );
  }
  if (!cred.token) throw new Error(`${PROVIDERS[id].label} needs an API token`);
  const opts = { fetch: deps.fetch };
  switch (id) {
    case "hetzner":
      return new HetznerProvider(cred.token, opts);
    case "digitalocean":
      return new DigitalOceanProvider(cred.token, opts);
    case "vultr":
      return new VultrProvider(cred.token, opts);
    case "linode":
      return new LinodeProvider(cred.token, opts);
  }
}

/** Short, stable tag for a host that every provider accepts in labels, tags and names. */
export function hostTag(hostId: string): string {
  return `cubehold-${createHash("sha256").update(hostId).digest("hex").slice(0, 12)}`;
}
