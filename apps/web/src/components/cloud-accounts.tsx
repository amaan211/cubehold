import type { CloudProviderSupported } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Cloud, ExternalLink, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/network";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/** Connected cloud accounts on the Hosts page. */
export function CloudAccounts() {
  const trpc = useTRPC();
  const accounts = useQuery(trpc.cloud.accounts.queryOptions());
  const [adding, setAdding] = useState(false);
  const remove = useMutation(
    trpc.cloud.removeAccount.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: trpc.cloud.pathKey() }),
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const list = accounts.data ?? [];
  return (
    <Card>
      <CardHeader className="flex-col items-start justify-between gap-3 space-y-0 sm:flex-row">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cloud className="size-4" /> Cloud accounts
          </CardTitle>
          <CardDescription>
            Let the panel create VMs in your Hetzner, DigitalOcean, Vultr, Linode or AWS account,
            and turn them off while nobody plays.
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2 sm:shrink-0">
          {list.length > 0 && (
            <Button asChild size="sm">
              <Link to="/hosts/cloud">
                <Plus /> Create a cloud server
              </Link>
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            Connect an account
          </Button>
        </div>
      </CardHeader>
      {list.length > 0 && (
        <CardContent>
          <ul className="divide-y divide-border text-sm">
            {list.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                <span>
                  <span className="font-medium">{a.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {a.providerLabel}
                    {a.account ? ` · ${a.account}` : ""} · {a.hosts} host{a.hosts === 1 ? "" : "s"}
                  </span>
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Disconnect ${a.label}`}
                  className="text-muted-foreground hover:text-destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ accountId: a.id })}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
      <ConnectAccountDialog open={adding} onClose={() => setAdding(false)} />
    </Card>
  );
}

export function ConnectAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const trpc = useTRPC();
  const info = useQuery(trpc.cloud.providers.queryOptions());
  const [provider, setProvider] = useState<CloudProviderSupported>("hetzner");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [region, setRegion] = useState("eu-central-1");
  const add = useMutation(
    trpc.cloud.addAccount.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.account ? `Connected (${r.account})` : "Connected");
        void queryClient.invalidateQueries({ queryKey: trpc.cloud.pathKey() });
        setToken("");
        setSecret("");
        onClose();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const p = info.data?.providers.find((x) => x.id === provider);
  const aws = provider === "aws";
  return (
    <Dialog open={open} onClose={onClose} title="Connect a cloud account" className="max-w-2xl">
      <form
        className="space-y-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate({
            provider,
            label: label.trim() || (p?.label ?? provider),
            ...(aws
              ? {
                  accessKeyId: accessKeyId.trim(),
                  secretAccessKey: secret.trim(),
                  region: region.trim(),
                }
              : { token: token.trim() }),
          });
        }}
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {info.data?.providers.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => setProvider(x.id as CloudProviderSupported)}
              className={cn(
                "flex items-center justify-between rounded-lg border p-2 text-left text-xs transition-colors",
                provider === x.id ? "border-primary bg-accent/60" : "border-border hover:bg-muted",
              )}
            >
              {x.label.replace(/ \(.*\)$/, "")}
              {provider === x.id && <Check className="size-3.5 text-primary" />}
            </button>
          ))}
        </div>
        {p && (
          <>
            <ol className="list-decimal space-y-1.5 pl-5">
              {p.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <a
              href={p.tokenUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Open {p.label} <ExternalLink className="size-3.5" />
            </a>
            {aws && info.data && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">IAM policy</span>
                  <CopyButton value={info.data.awsPolicy} label="Copy" />
                </div>
                <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px]">
                  {info.data.awsPolicy}
                </pre>
              </div>
            )}
            {p.notes.length > 0 && (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {p.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="acct-label">Name in the panel</Label>
            <Input
              id="acct-label"
              value={label}
              placeholder={p?.label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={48}
            />
          </div>
          {aws ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="acct-key">Access key ID</Label>
                <Input
                  id="acct-key"
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                  placeholder="AKIA…"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="acct-secret">Secret access key</Label>
                <Input
                  id="acct-secret"
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="acct-region">Main region</Label>
                <Input
                  id="acct-region"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="acct-token">API token</Label>
              <Input
                id="acct-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          The panel checks the token right away and stores it encrypted with your password. Nothing
          is created until you create a server.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={add.isPending || (aws ? !accessKeyId || !secret : token.trim().length < 10)}
          >
            {add.isPending && <Loader2 className="animate-spin" />} Check and connect
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
