import { type SshLoginInput, sshLoginInput } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { inferOutput } from "@trpc/tanstack-react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Fingerprint,
  KeyRound,
  Loader2,
  Plus,
  ShieldCheck,
  Upload,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { JobSteps, useHostJob } from "@/components/hosts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn, formatMb } from "@/lib/utils";

export const Route = createFileRoute("/_app/hosts_/new")({
  validateSearch: (s: Record<string, unknown>): { retry?: string } => ({
    retry: typeof s.retry === "string" ? s.retry : undefined,
  }),
  component: AddHost,
});

type CheckResult = inferOutput<ReturnType<typeof useTRPC>["hosts"]["check"]>;

function AddHost() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { retry } = Route.useSearch();
  const hosts = useQuery(trpc.hosts.list.queryOptions());
  const retrying = retry ? hosts.data?.find((h) => h.id === retry) : undefined;

  const [name, setName] = useState("My VPS");
  const [address, setAddress] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("root");
  const [method, setMethod] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [sudoPassword, setSudoPassword] = useState("");
  const [firewall, setFirewall] = useState(true);
  const [fail2ban, setFail2ban] = useState(true);
  const [autoUpdates, setAutoUpdates] = useState(true);
  const [checked, setChecked] = useState<CheckResult | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Retrying a failed setup: start from what was entered before.
  useEffect(() => {
    if (!retrying) return;
    setName(retrying.name);
    setAddress(retrying.address ?? "");
    setPort(retrying.sshPort ?? 22);
    setUsername(retrying.sshUser ?? "root");
  }, [retrying]);

  const login: SshLoginInput = {
    address,
    port,
    username,
    auth:
      method === "password"
        ? { method: "password", password }
        : { method: "key", privateKey, passphrase: passphrase || undefined },
    sudoPassword: sudoPassword || undefined,
  };
  const valid = sshLoginInput.safeParse(login);
  const firstError = valid.success ? null : valid.error.issues[0]?.message;

  const check = useMutation(
    trpc.hosts.check.mutationOptions({
      onSuccess: (r) => setChecked(r),
      onError: (err) => {
        setChecked(null);
        toast.error(errorMessage(err));
      },
    }),
  );
  const onDone = (id: string) => {
    setHostId(id);
    void queryClient.invalidateQueries({ queryKey: trpc.hosts.pathKey() });
  };
  const add = useMutation(
    trpc.hosts.add.mutationOptions({
      onSuccess: (r) => onDone(r.hostId),
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const redo = useMutation(
    trpc.hosts.retry.mutationOptions({
      onSuccess: () => retry && onDone(retry),
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const job = useHostJob(hostId);

  // Anything edited after the check invalidates it.
  const loginKey = JSON.stringify(login);
  const checkedFor = useRef<string | null>(null);
  useEffect(() => {
    if (checked && checkedFor.current !== loginKey) setChecked(null);
  }, [loginKey, checked]);

  const blocking = checked
    ? checked.problems.filter((p) => !(checked.needsSudoPassword && /sudo/.test(p)))
    : [];
  const canSetUp = !!checked && blocking.length === 0 && !checked.needsSudoPassword;

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
                  : `Setting up ${name}`}
            </CardTitle>
            <CardDescription>
              {j?.state === "running"
                ? "This takes 2 to 5 minutes, mostly installing packages. You can leave this page; it keeps going."
                : j?.state === "done"
                  ? "The agent runs as a service and starts again by itself after a reboot."
                  : null}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {j ? (
              <JobSteps job={j} defaultLog={j.state === "failed"} />
            ) : (
              <Loader2 className="animate-spin" />
            )}
            {j?.state === "done" && j.warnings.length > 0 && (
              <ul className="space-y-1 text-sm text-amber-700 dark:text-amber-400">
                {j.warnings.map((w) => (
                  <li key={w} className="flex gap-1.5">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {w}
                  </li>
                ))}
              </ul>
            )}
            {j?.state === "failed" && (
              <p className="flex gap-1.5 text-sm text-destructive">
                <XCircle className="mt-0.5 size-4 shrink-0" /> {j.error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {j?.state === "done" && (
                <Button asChild>
                  <Link to="/servers/new" search={{ hostId }}>
                    <Plus /> Create a server on {name}
                  </Link>
                </Button>
              )}
              {j?.state === "failed" && (
                <Button
                  onClick={() => {
                    setHostId(null);
                    setChecked(null);
                    void navigate({ to: "/hosts/new", search: { retry: hostId } });
                  }}
                >
                  Change details and try again
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

  return (
    <Page>
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid.success) return;
          checkedFor.current = loginKey;
          check.mutate(valid.data);
        }}
      >
        <Card>
          <CardHeader>
            <CardTitle>1. Log in to the VPS</CardTitle>
            <CardDescription>
              Your provider shows the IP address and login in its control panel or welcome email.
              These details are used once: the panel then installs its own SSH key and forgets your
              password.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-6">
            <Field label="Name in the panel" className="sm:col-span-6">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} />
            </Field>
            <Field label="IP address or host name" className="sm:col-span-4">
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value.trim())}
                placeholder="203.0.113.10"
                autoFocus
              />
            </Field>
            <Field label="SSH port" className="sm:col-span-2">
              <Input
                type="number"
                value={port}
                min={1}
                max={65535}
                onChange={(e) => setPort(Number(e.target.value))}
              />
            </Field>
            <Field
              label="User"
              hint="root on most providers; ubuntu on AWS, Oracle and Google Cloud."
              className="sm:col-span-6"
            >
              <Input value={username} onChange={(e) => setUsername(e.target.value.trim())} />
            </Field>
            <div className="flex gap-2 sm:col-span-6">
              {(["password", "key"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  className={cn(
                    "flex flex-1 items-center gap-2 rounded-lg border p-3 text-left text-sm transition-colors",
                    method === m ? "border-primary bg-accent/60" : "border-border hover:bg-muted",
                  )}
                >
                  {m === "password" ? (
                    <KeyRound className="size-4" />
                  ) : (
                    <Fingerprint className="size-4" />
                  )}
                  {m === "password" ? "Password" : "SSH key file"}
                </button>
              ))}
            </div>
            {method === "password" ? (
              <Field label="Password" className="sm:col-span-6">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                />
              </Field>
            ) : (
              <>
                <Field
                  label="Private key"
                  hint="The .pem or id_ed25519 file your provider gave you, or that you created."
                  className="sm:col-span-6"
                >
                  <textarea
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    spellCheck={false}
                    className="min-h-28 w-full rounded-md border border-input bg-transparent p-2 font-mono text-xs shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 dark:bg-card"
                  />
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) setPrivateKey(await f.text());
                      e.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => fileRef.current?.click()}
                  >
                    <Upload /> Choose the key file
                  </Button>
                </Field>
                <Field label="Key passphrase (if it has one)" className="sm:col-span-6">
                  <Input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    autoComplete="off"
                  />
                </Field>
              </>
            )}
            {(username !== "root" || checked?.needsSudoPassword) && (
              <Field
                label="Password for sudo"
                hint={
                  checked?.needsSudoPassword
                    ? "This user needs a password to become root."
                    : "Only if sudo asks for one. Leave empty on AWS, Oracle and Google Cloud."
                }
                className="sm:col-span-6"
              >
                <Input
                  type="password"
                  value={sudoPassword}
                  onChange={(e) => setSudoPassword(e.target.value)}
                  autoComplete="off"
                />
              </Field>
            )}
            <div className="flex flex-wrap items-center gap-3 sm:col-span-6">
              <Button type="submit" disabled={!valid.success || check.isPending}>
                {check.isPending && <Loader2 className="animate-spin" />} Check the connection
              </Button>
              {firstError && address && (
                <span className="text-xs text-muted-foreground">{firstError}</span>
              )}
            </div>
          </CardContent>
        </Card>
      </form>

      {checked && (
        <Card>
          <CardHeader>
            <CardTitle>2. Check and set up</CardTitle>
            <CardDescription>
              {checked.facts.os ?? "Linux"} · {checked.facts.arch} ·{" "}
              {checked.facts.memMb ? formatMb(checked.facts.memMb) : "?"} memory ·{" "}
              {checked.facts.cpus ?? "?"} CPU ·{" "}
              {checked.facts.diskFreeMb ? `${formatMb(checked.facts.diskFreeMb)} free disk` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 text-sm">
            {checked.problems.length > 0 && (
              <ul className="space-y-1.5 text-destructive">
                {checked.problems.map((p) => (
                  <li key={p} className="flex gap-1.5">
                    <XCircle className="mt-0.5 size-4 shrink-0" /> {p}
                  </li>
                ))}
              </ul>
            )}
            {checked.warnings.length > 0 && (
              <ul className="space-y-1.5 text-amber-700 dark:text-amber-400">
                {checked.warnings.map((w) => (
                  <li key={w} className="flex gap-1.5">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {w}
                  </li>
                ))}
              </ul>
            )}
            {checked.problems.length === 0 && (
              <p className="flex gap-1.5 text-muted-foreground">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" /> Logged in
                {checked.root === "root" ? " as root" : " and sudo works"}. The system is supported.
              </p>
            )}

            <div className="rounded-lg border border-border p-3">
              <p className="flex items-center gap-2 font-medium">
                <Fingerprint className="size-4" /> The server's identity
              </p>
              <p className="mt-1 font-mono text-xs break-all">
                {checked.hostKey.type} {checked.hostKey.fingerprint}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                The panel remembers this and refuses to connect if it ever changes, which would mean
                someone is in between. Some providers show it in the server's console output; if
                yours does, check that it matches.
              </p>
            </div>

            <div className="space-y-3">
              <p className="flex items-center gap-2 font-medium">
                <ShieldCheck className="size-4" /> Protect the VPS
              </p>
              <Toggle
                id="fw"
                checked={firewall}
                onChange={setFirewall}
                label="Firewall"
                hint="Only SSH and your game ports are reachable. Checked with a second login first, so it cannot lock the panel out."
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
            </div>

            <p className="text-xs text-muted-foreground">
              Setup installs Node.js and the cubehold agent under /opt/cubehold, runs it as its own
              unprivileged account (cubehold) with its data in /var/lib/cubehold, and adds the
              panel's key to ~/.ssh/authorized_keys of {username}. The agent only listens on the VPS
              itself; the panel reaches it through SSH.
            </p>

            <Button
              disabled={!canSetUp || add.isPending || redo.isPending}
              onClick={() => {
                if (!valid.success || !checked) return;
                const opts = { fingerprint: checked.hostKey.fingerprint };
                if (retry) redo.mutate({ hostId: retry, login: { ...valid.data, ...opts } });
                else add.mutate({ ...valid.data, ...opts, name, firewall, fail2ban, autoUpdates });
              }}
            >
              {(add.isPending || redo.isPending) && <Loader2 className="animate-spin" />}
              Set up this VPS
            </Button>
          </CardContent>
        </Card>
      )}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/hosts">
          <ArrowLeft /> Hosts
        </Link>
      </Button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Add a VPS</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A Linux server you rent (Ubuntu 24.04 or Debian 12). No VPS yet?{" "}
          <Link to="/hosts/guide" className="text-primary hover:underline">
            Which one to get
          </Link>
          .
        </p>
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
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
