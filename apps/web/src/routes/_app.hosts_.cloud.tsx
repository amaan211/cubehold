import { recommendVps, type WorkloadKind } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, Plus, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConnectAccountDialog } from "@/components/cloud-accounts";
import { JobSteps, useHostJob } from "@/components/hosts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn, formatMb } from "@/lib/utils";

export const Route = createFileRoute("/_app/hosts_/cloud")({
  component: CreateCloudHost,
});

const KINDS: Array<{ id: WorkloadKind; label: string }> = [
  { id: "vanilla", label: "Vanilla or Paper" },
  { id: "plugins", label: "Paper with plugins" },
  { id: "light-mods", label: "A few mods" },
  { id: "modpack", label: "Modpack" },
];

function money(n: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: n < 1 ? 3 : 2,
  }).format(n);
}

function CreateCloudHost() {
  const trpc = useTRPC();
  const accounts = useQuery(trpc.cloud.accounts.queryOptions());
  const [connecting, setConnecting] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [region, setRegion] = useState("");
  const [size, setSize] = useState("");
  const [name, setName] = useState("Minecraft");
  const [players, setPlayers] = useState(8);
  const [kind, setKind] = useState<WorkloadKind>("plugins");
  const [firewall, setFirewall] = useState(true);
  const [fail2ban, setFail2ban] = useState(true);
  const [autoUpdates, setAutoUpdates] = useState(true);
  const [hostId, setHostId] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId && accounts.data?.[0]) setAccountId(accounts.data[0].id);
  }, [accounts.data, accountId]);
  const account = accounts.data?.find((a) => a.id === accountId);

  const regions = useQuery(
    trpc.cloud.regions.queryOptions({ accountId }, { enabled: !!accountId, staleTime: 3_600_000 }),
  );
  useEffect(() => {
    if (regions.data && !regions.data.some((r) => r.id === region))
      setRegion(regions.data[0]?.id ?? "");
  }, [regions.data, region]);
  const sizes = useQuery(
    trpc.cloud.sizes.queryOptions(
      { accountId, region },
      { enabled: !!accountId && !!region, staleTime: 3_600_000 },
    ),
  );
  const rec = recommendVps(players, kind);
  const fitting = useMemo(
    () =>
      (sizes.data ?? []).filter(
        (s) => s.memoryMb >= rec.ramMb * 0.94 && s.vcpus >= Math.min(rec.vcpus, 4),
      ),
    [sizes.data, rec.ramMb, rec.vcpus],
  );
  const best = fitting[0];
  useEffect(() => {
    if (best && !sizes.data?.some((s) => s.id === size)) setSize(best.id);
  }, [best, size, sizes.data]);
  const chosen = sizes.data?.find((s) => s.id === size);

  const create = useMutation(
    trpc.cloud.createHost.mutationOptions({
      onSuccess: (r) => {
        setHostId(r.hostId);
        void queryClient.invalidateQueries({ queryKey: trpc.hosts.pathKey() });
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const job = useHostJob(hostId);

  const byContinent = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof regions.data>>();
    for (const r of regions.data ?? []) {
      const k = r.continent ?? "Other";
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return [...groups.entries()];
  }, [regions.data]);

  if (hostId) {
    const j = job.data;
    return (
      <Page>
        <Card>
          <CardHeader>
            <CardTitle>
              {j?.state === "done"
                ? `${name} is ready`
                : j?.state === "failed"
                  ? "Setup stopped"
                  : `Creating ${name}`}
            </CardTitle>
            <CardDescription>
              {j?.state === "running"
                ? "The provider builds the VM, then the panel sets it up over SSH. About 3 to 6 minutes; you can leave this page."
                : null}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {j ? (
              <JobSteps job={j} defaultLog={j.state === "failed"} />
            ) : (
              <Loader2 className="animate-spin" />
            )}
            {j?.state === "failed" && (
              <p className="flex gap-1.5 text-sm text-destructive">
                <XCircle className="mt-0.5 size-4 shrink-0" /> {j.error} The VM (if it was created)
                is listed under Hosts, where you can delete it.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {j?.state === "done" && (
                <Button asChild>
                  <Link to="/servers/new" search={{ hostId }}>
                    <Plus /> Create a Minecraft server on it
                  </Link>
                </Button>
              )}
              <Button asChild variant="outline">
                <Link to="/hosts">Back to hosts</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </Page>
    );
  }

  if (accounts.data && accounts.data.length === 0) {
    return (
      <Page>
        <Card>
          <CardHeader>
            <CardTitle>Connect a cloud account first</CardTitle>
            <CardDescription>
              The panel needs an API token (or an AWS access key) to create VMs for you.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => setConnecting(true)}>Connect an account</Button>
          </CardContent>
        </Card>
        <ConnectAccountDialog open={connecting} onClose={() => setConnecting(false)} />
      </Page>
    );
  }

  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle>Where</CardTitle>
          <CardDescription>Pick a location close to your players.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="acct">Account</Label>
            <Select id="acct" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} ({a.providerLabel})
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="region">Location</Label>
            <Select
              id="region"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              disabled={!regions.data}
            >
              {!regions.data && <option>{regions.isError ? "Could not load" : "Loading…"}</option>}
              {byContinent.map(([continent, list]) => (
                <optgroup key={continent} label={continent}>
                  {list.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            {regions.isError && (
              <p className="text-xs text-destructive">{errorMessage(regions.error)}</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Size</CardTitle>
          <CardDescription>
            For {players} players ({KINDS.find((k) => k.id === kind)?.label}): {formatMb(rec.ramMb)}{" "}
            memory and {rec.vcpus} cores. Prices are the provider's, per month; the second column
            assumes 3 hours of play a day with the VM turned off the rest of the time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-28 space-y-1.5">
              <Label htmlFor="players">Players</Label>
              <Input
                id="players"
                type="number"
                min={1}
                value={players}
                onChange={(e) => setPlayers(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <div className="w-48 space-y-1.5">
              <Label htmlFor="kind">Server</Label>
              <Select
                id="kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as WorkloadKind)}
              >
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {sizes.isError && <p className="text-sm text-destructive">{errorMessage(sizes.error)}</p>}
          {!sizes.data && !sizes.isError && (
            <p className="text-sm text-muted-foreground">Loading sizes and prices…</p>
          )}
          {sizes.data && (
            <div className="max-h-96 overflow-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="p-2 font-medium">Size</th>
                    <th className="p-2 font-medium">Machine</th>
                    <th className="p-2 font-medium">Always on</th>
                    <th className="p-2 font-medium">3 h a day</th>
                  </tr>
                </thead>
                <tbody>
                  {sizes.data.map((s) => {
                    const fits = fitting.includes(s);
                    return (
                      <tr
                        key={s.id}
                        onClick={() => setSize(s.id)}
                        className={cn(
                          "cursor-pointer border-b border-border last:border-0 hover:bg-muted/60",
                          size === s.id && "bg-accent/60",
                          !fits && "text-muted-foreground",
                        )}
                      >
                        <td className="p-2">
                          <span className="flex items-center gap-1.5">
                            <input
                              type="radio"
                              readOnly
                              checked={size === s.id}
                              className="accent-[var(--primary)]"
                            />
                            {s.label}
                            {s === best && <Badge variant="success">best fit</Badge>}
                          </span>
                        </td>
                        <td className="p-2 whitespace-nowrap">
                          {s.vcpus} {s.dedicated ? "dedicated" : ""} CPU · {formatMb(s.memoryMb)} ·{" "}
                          {s.diskGb} GB{s.arch === "arm64" ? " · ARM" : ""}
                          {s.burstable ? " · burstable" : ""}
                        </td>
                        <td className="p-2 whitespace-nowrap">
                          {money(s.estimate.alwaysOn, s.currency)}
                          {s.priceSource === "estimate" ? "*" : ""}
                        </td>
                        <td className="p-2 whitespace-nowrap">
                          {money(s.estimate.threeHoursADay, s.currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {chosen?.burstable && (
            <p className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Burstable instances are cheap
              for light use; a busy server pays extra for CPU above the baseline.
            </p>
          )}
          {sizes.data?.some((s) => s.priceSource === "estimate") && (
            <p className="text-xs text-muted-foreground">
              * US East price; the access key may not read AWS's price list for this region.
            </p>
          )}
          {account?.provider === "hetzner" && (
            <p className="text-xs text-muted-foreground">
              Hetzner prices exclude VAT and €0.50/month for the IPv4 address.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Name and protection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="space-y-1.5 sm:max-w-sm">
            <Label htmlFor="host-name">Name in the panel</Label>
            <Input
              id="host-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={48}
            />
          </div>
          <Toggle
            id="fw"
            checked={firewall}
            onChange={setFirewall}
            label="Firewall on the VM (ufw)"
            hint="The provider firewall is set up either way."
          />
          <Toggle
            id="f2b"
            checked={fail2ban}
            onChange={setFail2ban}
            label="fail2ban"
            hint="Blocks addresses that keep failing to log in."
          />
          <Toggle
            id="upd"
            checked={autoUpdates}
            onChange={setAutoUpdates}
            label="Automatic security updates"
            hint="Installs security fixes every day."
          />
          <p className="flex gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" /> SSH accepts only the
            panel's key; the VM gets Ubuntu 24.04 and the same setup as any VPS host.
          </p>
          {chosen && (
            <p>
              This VM costs {money(chosen.priceHourly, chosen.currency)} an hour, up to{" "}
              {money(chosen.estimate.alwaysOn, chosen.currency)} a month if it never turns off.
            </p>
          )}
          <Button
            disabled={!chosen || !name.trim() || create.isPending}
            onClick={() =>
              create.mutate({
                accountId,
                region,
                size,
                name: name.trim(),
                firewall,
                fail2ban,
                autoUpdates,
              })
            }
          >
            {create.isPending && <Loader2 className="animate-spin" />} Create the VM
          </Button>
        </CardContent>
      </Card>
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/hosts">
          <ArrowLeft /> Hosts
        </Link>
      </Button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create a cloud server</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The panel creates a VM in your account, sets it up, and can turn it off while nobody
          plays.
        </p>
      </div>
      {children}
    </div>
  );
}

function Toggle({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <Label htmlFor={id} className="block font-normal">
        {label}
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
