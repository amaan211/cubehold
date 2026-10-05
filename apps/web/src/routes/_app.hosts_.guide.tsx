import { alwaysOnMonthly } from "@cubehold/providers/pricing";
import { recommendVps, vpsFits, type WorkloadKind } from "@cubehold/shared";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, Cloud, ExternalLink, Plus } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, formatMb, formatMoney } from "@/lib/utils";

export const Route = createFileRoute("/_app/hosts_/guide")({
  component: Guide,
});

/** When the prices below were last looked up. */
const CHECKED = "October 2026";
/** For sorting only: roughly what a dollar is in euros. */
const USD_IN_EUR = 0.92;

interface Plan {
  provider: string;
  plan: string;
  vcpus: number;
  memoryMb: number;
  /** What a month costs with the server on all month, its IPv4 address included. */
  monthly: number;
  currency: "EUR" | "USD";
  /** Contract or tax terms the price needs, shown next to it. */
  terms?: string;
  url: string;
  notes: string;
  arm?: boolean;
  /** The panel can create this one for you from a connected account. */
  inPanel?: boolean;
}

/** Hetzner's list prices; the month adds the €0.50 IPv4 address, as Create a cloud server does. */
const hetzner = (priceHourly: number, priceMonthly: number, diskGb: number) =>
  alwaysOnMonthly("hetzner", { priceHourly, priceMonthly, diskGb });

const PLANS: Plan[] = [
  {
    provider: "Oracle Cloud",
    plan: "Always Free Ampere A1",
    vcpus: 2,
    memoryMb: 12288,
    monthly: 0,
    currency: "USD",
    arm: true,
    url: "https://www.oracle.com/cloud/free/",
    notes:
      "Free for good, but halved to 2 cores and 12 GB in June 2026, and machines are often out of stock in busy regions. Needs a card to sign up. Open ports in the VCN security list as well.",
  },
  {
    provider: "OVHcloud",
    plan: "VPS-1",
    vcpus: 2,
    memoryMb: 4096,
    monthly: 4.54,
    currency: "USD",
    terms: "paid yearly",
    url: "https://www.ovhcloud.com/en/vps/",
    notes:
      "Game-grade anti-DDoS and unlimited traffic included. More per month without the yearly commitment. Data centres in Europe, North America and Asia.",
  },
  {
    provider: "OVHcloud",
    plan: "VPS-2",
    vcpus: 4,
    memoryMb: 8192,
    monthly: 8.5,
    currency: "USD",
    terms: "paid yearly",
    url: "https://www.ovhcloud.com/en/vps/",
    notes: "The same with room for plugins and more players.",
  },
  {
    provider: "Contabo",
    plan: "Cloud VPS 4",
    vcpus: 4,
    memoryMb: 8192,
    monthly: 5.5,
    currency: "EUR",
    terms: "24-month term, VAT included",
    url: "https://contabo.com/en/vps/",
    notes:
      "Lots of memory for the money on a long contract; shorter terms cost more a month. Cores are slower and busier than elsewhere.",
  },
  {
    provider: "Hetzner",
    plan: "CX23",
    vcpus: 2,
    memoryMb: 4096,
    monthly: hetzner(0.0088, 5.49, 40),
    currency: "EUR",
    terms: "before VAT",
    url: "https://www.hetzner.com/cloud/",
    inPanel: true,
    notes:
      "€5.49 plus €0.50 for the IPv4 address. Fast and reliable; Germany and Finland only, and often sold out since September 2026. Billed by the hour, so you can delete it any time.",
  },
  {
    provider: "Hetzner",
    plan: "CX33",
    vcpus: 4,
    memoryMb: 8192,
    monthly: hetzner(0.0136, 8.49, 80),
    currency: "EUR",
    terms: "before VAT",
    url: "https://www.hetzner.com/cloud/",
    inPanel: true,
    notes: "€8.49 plus €0.50 for the IPv4 address. Prices went up twice in 2026.",
  },
  {
    provider: "Hetzner",
    plan: "CX43",
    vcpus: 8,
    memoryMb: 16384,
    monthly: hetzner(0.0256, 15.99, 160),
    currency: "EUR",
    terms: "before VAT",
    url: "https://www.hetzner.com/cloud/",
    inPanel: true,
    notes: "€15.99 plus €0.50 for the IPv4 address. For modpacks.",
  },
  {
    provider: "DigitalOcean",
    plan: "Basic 4 GB",
    vcpus: 2,
    memoryMb: 4096,
    monthly: 24,
    currency: "USD",
    terms: "before tax",
    url: "https://www.digitalocean.com/pricing/droplets",
    inPanel: true,
    notes: "Easy to use and well documented, but several times the price of the above.",
  },
  {
    provider: "AWS Lightsail",
    plan: "4 GB",
    vcpus: 2,
    memoryMb: 4096,
    monthly: 24,
    currency: "USD",
    terms: "before tax",
    url: "https://aws.amazon.com/lightsail/pricing/",
    notes:
      "Fine if you already use AWS; the IPv4 address is included. Open the port under Networking as well. (The panel's own AWS option makes EC2 instances, priced separately.)",
  },
];

const inEur = (p: Plan) => (p.currency === "EUR" ? p.monthly : p.monthly * USD_IN_EUR);

const KINDS: Array<{ id: WorkloadKind; label: string; hint: string }> = [
  { id: "vanilla", label: "Vanilla or Paper", hint: "No or few plugins" },
  { id: "plugins", label: "Paper with plugins", hint: "Maps, economy, protection…" },
  { id: "light-mods", label: "A few mods", hint: "Fabric or Forge, under 50 mods" },
  { id: "modpack", label: "Modpack", hint: "100+ mods, e.g. from CurseForge" },
];

function Guide() {
  const [players, setPlayers] = useState(8);
  const [kind, setKind] = useState<WorkloadKind>("plugins");
  const rec = recommendVps(players, kind);
  const fits = (p: Plan) => vpsFits(p, rec);
  const cheapest = PLANS.filter((p) => fits(p) && p.monthly > 0).sort(
    (a, b) => inEur(a) - inEur(b),
  )[0];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/hosts">
          <ArrowLeft /> Hosts
        </Link>
      </Button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Getting a VPS</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A VPS is a small Linux server you rent by the month. It stays online when your computer is
          off, and players connect straight to its address: no port forwarding, no tunnels.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>How big?</CardTitle>
          <CardDescription>Memory is what matters most for Minecraft.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="players">Players at once</Label>
              <Input
                id="players"
                type="number"
                min={1}
                max={200}
                value={players}
                onChange={(e) => setPlayers(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>What you run</Label>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => setKind(k.id)}
                    className={cn(
                      "rounded-lg border p-2 text-left text-sm transition-colors",
                      kind === k.id
                        ? "border-primary bg-accent/60"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    {k.label}
                    <span className="block text-xs text-muted-foreground">{k.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded-lg bg-muted/60 p-4 text-sm">
            <p className="text-base font-medium">
              {formatMb(rec.ramMb)} memory, {rec.vcpus} CPU cores
            </p>
            <p className="mt-1 text-muted-foreground">
              That gives the server a {formatMb(rec.heapMb)} heap, plus room for Java itself and the
              system. Fast cores beat many cores: Minecraft runs each world on one.
              {cheapest && (
                <>
                  {" "}
                  Cheapest fit below:{" "}
                  <strong className="text-foreground">
                    {cheapest.provider} {cheapest.plan}
                  </strong>{" "}
                  at {formatMoney(cheapest.monthly, cheapest.currency)} a month
                  {cheapest.terms ? ` (${cheapest.terms})` : ""}.
                </>
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where</CardTitle>
          <CardDescription>
            Prices checked in {CHECKED}, for a month with the server always on and its IPv4 address
            included; they change, so check the provider's page. Pick a location close to your
            players.
          </CardDescription>
        </CardHeader>
        <CardContent className="relative overflow-x-auto p-0 sm:p-6 sm:pt-0">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 pl-6 font-medium sm:pl-0">Provider</th>
                <th className="py-2 pr-3 font-medium">Size</th>
                <th className="py-2 pr-3 font-medium">Per month</th>
                <th className="py-2 pr-6 font-medium sm:pr-0">Good to know</th>
              </tr>
            </thead>
            <tbody>
              {PLANS.map((p) => (
                <tr
                  key={`${p.provider}-${p.plan}`}
                  className={cn(
                    "border-b border-border align-top last:border-0",
                    !fits(p) && "opacity-55",
                  )}
                >
                  <td className="py-2.5 pr-3 pl-6 sm:pl-0">
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-medium hover:underline"
                    >
                      {p.provider} <ExternalLink className="size-3" />
                    </a>
                    <span className="block text-xs text-muted-foreground">{p.plan}</span>
                  </td>
                  <td className="py-2.5 pr-3 whitespace-nowrap">
                    {formatMb(p.memoryMb)}, {p.vcpus} cores
                    {p.arm && (
                      <Badge variant="outline" className="ml-1.5">
                        ARM
                      </Badge>
                    )}
                    {fits(p) && (
                      <span className="flex items-center gap-1 text-xs text-primary">
                        <CheckCircle2 className="size-3" /> fits
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-3 whitespace-nowrap">
                    {p.monthly === 0 ? "Free" : formatMoney(p.monthly, p.currency)}
                    {p.terms && (
                      <span className="block text-xs text-muted-foreground">{p.terms}</span>
                    )}
                    {p.inPanel && (
                      <Link
                        to="/hosts/cloud"
                        className="mt-0.5 flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <Cloud className="size-3" /> cubehold can create it
                      </Link>
                    )}
                  </td>
                  <td className="py-2.5 pr-6 text-xs text-muted-foreground sm:pr-0">{p.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Then</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Create the server in the provider's control panel. Choose{" "}
              <strong>Ubuntu 24.04 LTS</strong> (Debian 12 works too) and the size from above.
            </li>
            <li>
              For the login, pick a <strong>root password</strong>, or add an SSH key if you have
              one. The provider shows the server's <strong>IP address</strong> once it is running.
            </li>
            <li>
              If the provider has its own firewall (AWS and Oracle always do; Hetzner and others
              only if you create one), allow <strong>TCP 22</strong> for SSH and{" "}
              <strong>TCP 25565</strong> for Minecraft, plus <strong>UDP 19132</strong> if Bedrock
              players will join. The panel runs a firewall on the VPS itself.
            </li>
            <li>
              Add it here. The panel logs in once, installs what it needs and hardens the VPS; your
              password is not kept.
            </li>
          </ol>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild>
              <Link to="/hosts/new">
                <Plus /> Add a VPS
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/servers/new" search={{ cloud: true }}>
                <Cloud /> Or let cubehold create one
              </Link>
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            With a Hetzner, DigitalOcean, Vultr, Linode or AWS account, the panel can create the VM
            and the Minecraft server in one go, and turn the VM off while nobody plays. It shows the
            same prices as this page.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
