import { recommendVps, vpsFits, type WorkloadKind } from "@cubehold/shared";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, Loader2, Plus, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConnectAccountDialog } from "@/components/cloud-accounts";
import {
  CloudPriceNotes,
  CloudSizeTable,
  CloudWhereFields,
  useCloudCatalog,
} from "@/components/cloud-picker";
import { JobSteps, useHostJob } from "@/components/hosts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { formatMb } from "@/lib/utils";

export const Route = createFileRoute("/_app/hosts_/cloud")({
  component: CreateCloudHost,
});

const KINDS: Array<{ id: WorkloadKind; label: string }> = [
  { id: "vanilla", label: "Vanilla or Paper" },
  { id: "plugins", label: "Paper with plugins" },
  { id: "light-mods", label: "A few mods" },
  { id: "modpack", label: "Modpack" },
];

function CreateCloudHost() {
  const trpc = useTRPC();
  const catalog = useCloudCatalog();
  const { accounts, accountId, region, sizes } = catalog;
  const [connecting, setConnecting] = useState(false);
  const [size, setSize] = useState("");
  const [name, setName] = useState("Minecraft");
  const [players, setPlayers] = useState(8);
  const [kind, setKind] = useState<WorkloadKind>("plugins");
  const [firewall, setFirewall] = useState(true);
  const [fail2ban, setFail2ban] = useState(true);
  const [autoUpdates, setAutoUpdates] = useState(true);
  const [hostId, setHostId] = useState<string | null>(null);

  const rec = recommendVps(players, kind);
  const fitting = useMemo(
    () => (sizes.data ?? []).filter((s) => vpsFits(s, rec)),
    [sizes.data, rec],
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
        <CardContent>
          <CloudWhereFields catalog={catalog} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Size</CardTitle>
          <CardDescription>
            For {players} players ({KINDS.find((k) => k.id === kind)?.label}): {formatMb(rec.ramMb)}{" "}
            memory and {rec.vcpus} cores, the same advice as in Getting a VPS.
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
          <CloudSizeTable
            catalog={catalog}
            fits={() => true}
            dim={(s) => !fitting.includes(s)}
            best={best}
            selected={size}
            onSelect={setSize}
          />
          <CloudPriceNotes catalog={catalog} chosen={chosen} />
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
          plays. To make a Minecraft server on a new VM in one go, use{" "}
          <Link to="/servers/new" search={{ cloud: true }} className="text-primary hover:underline">
            New server
          </Link>
          .
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
