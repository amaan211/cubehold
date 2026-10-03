import { recommendVps, type WorkloadKind } from "@cubehold/shared";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, ExternalLink, Plus } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, formatMb } from "@/lib/utils";

export const Route = createFileRoute("/_app/hosts_/guide")({
  component: Guide,
});

/** When the prices below were last looked up. */
const CHECKED = "September 2026";

interface Plan {
  provider: string;
  plan: string;
  vcpus: number;
  ramMb: number;
  price: string;
  /** For sorting and "cheapest that fits"; monthly, roughly in euros. */
  approxEur: number;
  url: string;
  notes: string;
  arm?: boolean;
}

const PLANS: Plan[] = [
  {
    provider: "Oracle Cloud",
    plan: "Always Free Ampere A1",
    vcpus: 2,
    ramMb: 12288,
    price: "Free",
    approxEur: 0,
    arm: true,
    url: "https://www.oracle.com/cloud/free/",
    notes:
      "Free for good, but halved to 2 cores and 12 GB in June 2026, and machines are often out of stock in busy regions. Needs a card to sign up. Open ports in the VCN security list as well.",
  },
  {
    provider: "OVHcloud",
    plan: "VPS-1",
    vcpus: 2,
    ramMb: 4096,
    price: "$4.54",
    approxEur: 4.2,
    url: "https://www.ovhcloud.com/en/vps/",
    notes:
      "Game-grade anti-DDoS and unlimited traffic included. Data centres in Europe, North America and Asia.",
  },
  {
    provider: "OVHcloud",
    plan: "VPS-2",
    vcpus: 4,
    ramMb: 8192,
    price: "$8.50",
    approxEur: 7.9,
    url: "https://www.ovhcloud.com/en/vps/",
    notes: "The same with room for plugins and more players.",
  },
  {
    provider: "Contabo",
    plan: "Cloud VPS 4",
    vcpus: 4,
    ramMb: 8192,
    price: "€5.50",
    approxEur: 5.5,
    url: "https://contabo.com/en/vps/",
    notes:
      "Lots of memory for the money, on long contracts (monthly billing costs more). Cores are slower and busier than elsewhere.",
  },
  {
    provider: "Hetzner",
    plan: "CX23",
    vcpus: 2,
    ramMb: 4096,
    price: "€5.49",
    approxEur: 5.49,
    url: "https://www.hetzner.com/cloud/",
    notes: "Fast and reliable; Germany and Finland at this price. Excl. VAT; raised twice in 2026.",
  },
  {
    provider: "Hetzner",
    plan: "CX33",
    vcpus: 4,
    ramMb: 8192,
    price: "€8.49",
    approxEur: 8.49,
    url: "https://www.hetzner.com/cloud/",
    notes: "Excl. VAT. Hourly billing, so you can delete it any time.",
  },
  {
    provider: "Hetzner",
    plan: "CX43",
    vcpus: 8,
    ramMb: 16384,
    price: "€15.99",
    approxEur: 15.99,
    url: "https://www.hetzner.com/cloud/",
    notes: "Excl. VAT. For modpacks.",
  },
  {
    provider: "DigitalOcean",
    plan: "Basic 4 GB",
    vcpus: 2,
    ramMb: 4096,
    price: "$24",
    approxEur: 22,
    url: "https://www.digitalocean.com/pricing/droplets",
    notes: "Easy to use and well documented, but several times the price of the above.",
  },
  {
    provider: "AWS Lightsail",
    plan: "4 GB",
    vcpus: 2,
    ramMb: 4096,
    price: "$24",
    approxEur: 22,
    url: "https://aws.amazon.com/lightsail/pricing/",
    notes: "Fine if you already use AWS. Open the port under Networking as well.",
  },
];

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
  const fits = (p: Plan) => p.ramMb >= rec.ramMb && p.vcpus >= Math.min(rec.vcpus, 4);
  const cheapest = PLANS.filter((p) => fits(p) && p.approxEur > 0).sort(
    (a, b) => a.approxEur - b.approxEur,
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
                  at {cheapest.price} a month.
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
            Monthly prices checked in {CHECKED}; they change, so check the provider's page. Pick a
            location close to your players.
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
                    {formatMb(p.ramMb)}, {p.vcpus} cores
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
                  <td className="py-2.5 pr-3 whitespace-nowrap">{p.price}</td>
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
          <Button asChild className="mt-4">
            <Link to="/hosts/new">
              <Plus /> Add a VPS
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
