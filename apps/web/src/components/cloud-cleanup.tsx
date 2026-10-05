import { useMutation, useQuery } from "@tanstack/react-query";
import type { inferOutput } from "@trpc/tanstack-react-query";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { JobSteps } from "@/components/hosts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn, formatMoney, timeAgo } from "@/lib/utils";

type Trpc = ReturnType<typeof useTRPC>;
type Scan = inferOutput<Trpc["cloud"]["scan"]>;
type Item = Scan["accounts"][number]["items"][number];
export interface PickedOther {
  accountId: string;
  kind: Item["kind"];
  id: string;
}

const KIND: Record<Item["kind"], string> = {
  vm: "VM",
  snapshot: "Snapshot",
  firewall: "Firewall",
  "ssh-key": "SSH key",
  volume: "Volume",
  ip: "IP address",
  tag: "Tag",
};

function perMonth(n: number | null, currency: "EUR" | "USD") {
  if (n === null) return "price unknown";
  if (n === 0) return "free";
  return `${formatMoney(n, currency)}/month`;
}

/** Ask the connected accounts what is in them; shared by both cards below. */
export function useCloudScan(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.cloud.scan.queryOptions(undefined, {
      enabled,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    }),
  );
}

/** What is in each cloud account right now, and what it costs a month. */
export function CloudInventory({
  scan,
  picked,
  onPick,
}: {
  scan: ReturnType<typeof useCloudScan>;
  picked: PickedOther[];
  onPick: (next: PickedOther[]) => void;
}) {
  const trpc = useTRPC();
  const [confirm, setConfirm] = useState<(Item & { accountId: string }) | null>(null);
  const del = useMutation(
    trpc.cloud.deleteResource.mutationOptions({
      onSuccess: () => {
        toast.success("Deleted");
        setConfirm(null);
        void scan.refetch();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const isPicked = (accountId: string, r: Item) =>
    picked.some((p) => p.accountId === accountId && p.kind === r.kind && p.id === r.id);

  return (
    <Card>
      <CardHeader className="flex-col items-start justify-between gap-3 space-y-0 sm:flex-row">
        <div>
          <CardTitle>In your cloud accounts</CardTitle>
          <CardDescription>
            Asked from the providers just now: everything cubehold made, and anything else in the
            accounts that costs money. Monthly prices assume it stays as it is.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void scan.refetch()}
          disabled={scan.isFetching}
        >
          <RefreshCw className={cn(scan.isFetching && "animate-spin")} /> Check again
        </Button>
      </CardHeader>
      <CardContent className="space-y-6 text-sm">
        {scan.isPending && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Asking the providers…
          </p>
        )}
        {scan.isError && <p className="text-destructive">{errorMessage(scan.error)}</p>}
        {scan.data?.accounts.map((a) => {
          const used = a.items.filter((r) => r.inUse);
          const leftover = a.items.filter((r) => r.ours && !r.inUse);
          const others = a.items.filter((r) => !r.ours);
          const monthly = a.items.reduce((n, r) => n + (r.monthly ?? 0), 0);
          return (
            <section key={a.accountId} className="space-y-3">
              <h3 className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {a.label}{" "}
                  <span className="font-normal text-muted-foreground">{a.providerLabel}</span>
                </span>
                {!a.error && (
                  <span className="text-muted-foreground">
                    about{" "}
                    <strong className="text-foreground">{formatMoney(monthly, a.currency)}</strong>{" "}
                    a month in all
                  </span>
                )}
              </h3>
              {a.error && (
                <p className="flex gap-1.5 text-destructive">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {a.error}
                </p>
              )}
              {!a.error && a.items.length === 0 && (
                <p className="flex items-center gap-1.5 text-muted-foreground">
                  <CheckCircle2 className="size-4 text-primary" /> Nothing in this account.
                </p>
              )}
              {used.length > 0 && (
                <Group title="Used by your hosts">
                  {used.map((r) => (
                    <Row key={`${r.kind}/${r.id}`} r={r} currency={a.currency}>
                      <span className="text-xs text-muted-foreground">{r.hostName}</span>
                    </Row>
                  ))}
                </Group>
              )}
              {leftover.length > 0 && (
                <Group
                  title="Left over by cubehold"
                  hint="Made by cubehold but used by no host any more, for example from a setup that failed or a host deleted outside the panel."
                >
                  {leftover.map((r) => (
                    <Row key={`${r.kind}/${r.id}`} r={r} currency={a.currency}>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirm({ ...r, accountId: a.accountId })}
                      >
                        <Trash2 /> Delete
                      </Button>
                    </Row>
                  ))}
                </Group>
              )}
              {others.length > 0 && (
                <Group
                  title="Not made by cubehold"
                  hint="Left alone unless you tick them for the clean-up below."
                >
                  {others.map((r) => (
                    <Row key={`${r.kind}/${r.id}`} r={r} currency={a.currency}>
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          className="size-4 accent-[var(--destructive)]"
                          checked={isPicked(a.accountId, r)}
                          onChange={(e) =>
                            onPick(
                              e.target.checked
                                ? [...picked, { accountId: a.accountId, kind: r.kind, id: r.id }]
                                : picked.filter(
                                    (p) =>
                                      !(
                                        p.accountId === a.accountId &&
                                        p.kind === r.kind &&
                                        p.id === r.id
                                      ),
                                  ),
                            )
                          }
                        />
                        Delete too
                      </label>
                    </Row>
                  ))}
                </Group>
              )}
            </section>
          );
        })}
        {scan.data && (
          <p className="text-xs text-muted-foreground">Checked {timeAgo(scan.data.at)}</p>
        )}
      </CardContent>
      <Dialog open={!!confirm} onClose={() => setConfirm(null)} title="Delete this?">
        {confirm && (
          <div className="space-y-4 text-sm">
            <p>
              {KIND[confirm.kind]} <strong>{confirm.name}</strong>
              {confirm.detail ? ` (${confirm.detail})` : ""} is deleted at the provider. This cannot
              be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={del.isPending}
                onClick={() =>
                  del.mutate({ accountId: confirm.accountId, kind: confirm.kind, id: confirm.id })
                }
              >
                {del.isPending && <Loader2 className="animate-spin" />} Delete
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

function Group({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <ul className="mt-1 divide-y divide-border rounded-lg border border-border">{children}</ul>
    </div>
  );
}

function Row({
  r,
  currency,
  children,
}: {
  r: Item;
  currency: "EUR" | "USD";
  children?: React.ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{KIND[r.kind]}</Badge>
          <span className="break-all">{r.name}</span>
        </span>
        <span className="block text-xs text-muted-foreground">
          {[r.detail, r.region, perMonth(r.monthly, currency)].filter(Boolean).join(" · ")}
        </span>
      </span>
      {children}
    </li>
  );
}

/**
 * Delete everything cubehold made in the cloud accounts, with the servers on
 * those VMs, after the user types "delete".
 */
export function CleanupCard({
  scan,
  picked,
}: {
  scan: ReturnType<typeof useCloudScan>;
  picked: PickedOther[];
}) {
  const trpc = useTRPC();
  const accounts = useQuery(trpc.cloud.accounts.queryOptions());
  const hosts = useQuery(trpc.hosts.list.queryOptions());
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [disconnect, setDisconnect] = useState(false);
  const status = useQuery(
    trpc.cloud.cleanupStatus.queryOptions(undefined, {
      refetchInterval: (q) => (q.state.data?.state === "running" ? 1_000 : false),
    }),
  );
  const start = useMutation(
    trpc.cloud.cleanup.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        setTyped("");
        void status.refetch();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const running = status.data?.state === "running";
  // Once a clean-up ends, everything it touched needs fresh data.
  const finishedAt = status.data?.finishedAt;
  useEffect(() => {
    if (!finishedAt) return;
    void queryClient.invalidateQueries({ queryKey: trpc.hosts.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.servers.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.cloud.pathKey() });
  }, [finishedAt, trpc]);

  const cloudHosts = (hosts.data ?? []).filter((h) => h.kind === "cloud");
  const servers = cloudHosts.reduce((n, h) => n + h.servers, 0);
  const ours = (scan.data?.accounts ?? []).flatMap((a) =>
    a.items.filter((r) => r.ours).map((r) => ({ ...r, currency: a.currency })),
  );
  const pickedItems = (scan.data?.accounts ?? []).flatMap((a) =>
    a.items
      .filter((r) =>
        picked.some((p) => p.accountId === a.accountId && p.kind === r.kind && p.id === r.id),
      )
      .map((r) => ({ ...r, currency: a.currency })),
  );
  const savings = new Map<"EUR" | "USD", number>();
  for (const r of [...ours, ...pickedItems])
    savings.set(r.currency, (savings.get(r.currency) ?? 0) + (r.monthly ?? 0));
  const count = (kind: Item["kind"]) => ours.filter((r) => r.kind === kind).length;
  const unreadable = (scan.data?.accounts ?? []).filter((a) => a.error);
  const nothing =
    scan.data && unreadable.length === 0 && ours.length === 0 && pickedItems.length === 0;
  const accountIds = (accounts.data ?? []).map((a) => a.id);

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trash2 className="size-4 text-destructive" /> Clean up the cloud
        </CardTitle>
        <CardDescription>
          Deletes everything cubehold made in your cloud accounts so nothing keeps costing money:
          every cloud VM with its disk, its snapshots, firewalls and SSH keys. The Minecraft servers
          on those VMs are deleted with them, worlds included; to keep one, move it to this computer
          first (its Settings tab, under Host).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {status.data && (
          <div className="space-y-3 rounded-lg bg-muted/50 p-3">
            <p className="font-medium">
              {running
                ? "Cleaning up…"
                : status.data.state === "done"
                  ? "Clean-up finished"
                  : "Clean-up finished with problems"}
              {status.data.finishedAt && (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {timeAgo(status.data.finishedAt)}
                </span>
              )}
            </p>
            <JobSteps
              job={status.data}
              defaultLog={status.data.state === "failed"}
              logLabel="the clean-up log"
            />
            {status.data.state === "failed" && status.data.error && (
              <p className="text-destructive">{status.data.error}</p>
            )}
          </div>
        )}
        {unreadable.length > 0 && (
          <p className="flex gap-1.5 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> Could not look in{" "}
            {unreadable.map((a) => a.label).join(", ")} (see above). The clean-up still deletes the
            cloud hosts the panel knows about there, but cannot find anything left over.
          </p>
        )}
        {scan.isPending ? (
          <p className="text-muted-foreground">Looking at the accounts first…</p>
        ) : nothing ? (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <CheckCircle2 className="size-4 text-primary" /> Nothing of cubehold's is in your cloud
            accounts.
          </p>
        ) : (
          <ul className="list-disc space-y-0.5 pl-5">
            {cloudHosts.length > 0 && (
              <li>
                {cloudHosts.length} cloud host{cloudHosts.length === 1 ? "" : "s"} (
                {cloudHosts.map((h) => h.name).join(", ")})
                {servers > 0 ? ` with ${servers} Minecraft server${servers === 1 ? "" : "s"}` : ""}
              </li>
            )}
            {count("vm") > 0 && <li>{count("vm")} VM(s)</li>}
            {count("snapshot") + count("volume") > 0 && (
              <li>{count("snapshot") + count("volume")} snapshot(s) and disk(s)</li>
            )}
            {count("firewall") + count("ssh-key") + count("tag") > 0 && (
              <li>
                {count("firewall") + count("ssh-key") + count("tag")} firewall(s), key(s), tag(s)
              </li>
            )}
            {pickedItems.length > 0 && (
              <li className="text-destructive">
                {pickedItems.length} thing(s) not made by cubehold that you ticked
              </li>
            )}
            {[...savings.entries()].map(([c, n]) => (
              <li key={c}>
                Saves about <strong>{formatMoney(n, c)}</strong> a month
              </li>
            ))}
          </ul>
        )}
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={disconnect}
            onChange={(e) => setDisconnect(e.target.checked)}
          />
          Also disconnect the accounts (the panel forgets their tokens)
        </label>
        <Button
          variant="destructive"
          disabled={running || accountIds.length === 0 || scan.isPending}
          onClick={() => setOpen(true)}
        >
          {running && <Loader2 className="animate-spin" />} Clean up…
        </Button>
      </CardContent>
      <Dialog open={open} onClose={() => setOpen(false)} title="Delete everything in the cloud?">
        <div className="space-y-4 text-sm">
          <p>
            This deletes{" "}
            {cloudHosts.length > 0
              ? `${cloudHosts.map((h) => h.name).join(", ")}${servers > 0 ? ` and the ${servers} Minecraft server(s) on them, with their worlds and backups, ` : " "}`
              : ""}
            and everything else cubehold made in{" "}
            {(accounts.data ?? []).map((a) => a.label).join(", ")}
            {pickedItems.length > 0 ? `, plus the ${pickedItems.length} thing(s) you ticked` : ""}.
            It cannot be undone.
          </p>
          <div className="space-y-1.5">
            <label htmlFor="cleanup-confirm" className="text-xs text-muted-foreground">
              Type <strong className="text-foreground">delete</strong> to go ahead
            </label>
            <Input
              id="cleanup-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={typed.trim().toLowerCase() !== "delete" || start.isPending}
              onClick={() =>
                start.mutate({ accountIds, others: picked, disconnect, confirm: true })
              }
            >
              {start.isPending && <Loader2 className="animate-spin" />} Delete everything
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
