import type { PropertySpec, PropertyValue } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AuthCard } from "@/components/auth-card";
import { AutomationCard } from "@/components/automation-card";
import { GeneralCard } from "@/components/general-card";
import { MoveCard } from "@/components/move-card";
import { NotificationsCard } from "@/components/notifications-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { VersionCard } from "@/components/version-card";
import { useServerLive } from "@/lib/realtime";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/_app/servers/$id/settings")({
  // Prefetch only: while a cloud VM is down these fail, and the rest of the page still works.
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.prefetchQuery(
        context.trpc.servers.properties.queryOptions({ serverId: params.id }),
      ),
      context.queryClient.prefetchQuery(
        context.trpc.servers.versionInfo.queryOptions({ serverId: params.id }),
      ),
    ]),
  component: Settings,
});

// "Authentication" keys are edited through the Player login card instead.
const GROUPS = ["General", "World", "Performance", "Security"];

function Settings() {
  const { id } = Route.useParams();
  const trpc = useTRPC();
  const live = useServerLive(id);
  const busy = live.status === "installing";
  const props = useQuery(trpc.servers.properties.queryOptions({ serverId: id }));
  const server = useQuery(trpc.servers.get.queryOptions({ serverId: id }));
  const hosts = useQuery(trpc.hosts.list.queryOptions());
  const onCloud = hosts.data?.find((h) => h.id === server.data?.hostId)?.kind === "cloud";
  const [draft, setDraft] = useState<Record<string, PropertyValue>>({});

  useEffect(() => {
    if (props.data) setDraft(props.data.values);
  }, [props.data]);

  // A finished install or version change can rewrite server.properties.
  useEffect(() => {
    if (!busy) {
      void queryClient.invalidateQueries({
        queryKey: trpc.servers.properties.queryKey({ serverId: id }),
      });
    }
  }, [busy, id, trpc]);

  const changed = useMemo(() => {
    const out: Record<string, PropertyValue> = {};
    for (const [k, v] of Object.entries(draft))
      if (props.data && props.data.values[k] !== v) out[k] = v;
    return out;
  }, [draft, props.data]);
  const dirty = Object.keys(changed).length > 0;

  const save = useMutation(
    trpc.servers.updateProperties.mutationOptions({
      onSuccess: async (data) => {
        queryClient.setQueryData(trpc.servers.properties.queryKey({ serverId: id }), data);
        await queryClient.invalidateQueries({
          queryKey: trpc.servers.properties.queryKey({ serverId: id }),
        });
        toast.success(data.requiresRestart ? "Saved. Restart the server to apply." : "Saved");
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );

  const data = props.data;
  const byGroup = new Map<string, PropertySpec[]>();
  for (const s of data?.specs ?? []) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);

  return (
    <div className="space-y-6">
      <GeneralCard serverId={id} disabled={busy} />
      <AutomationCard serverId={id} disabled={busy} />
      <NotificationsCard serverId={id} cloud={onCloud} />
      <VersionCard serverId={id} />
      <AuthCard serverId={id} disabled={busy} />
      <MoveCard serverId={id} disabled={busy} />
      {!data && props.error && (
        <Card>
          <CardHeader>
            <CardTitle>server.properties</CardTitle>
            <CardDescription>{errorMessage(props.error)}</CardDescription>
          </CardHeader>
        </Card>
      )}
      {data && (
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) save.mutate({ serverId: id, values: changed });
          }}
        >
          <div className="flex items-center justify-between gap-4 pt-2">
            <div>
              <h2 className="text-base font-semibold">server.properties</h2>
              <p className="text-sm text-muted-foreground">
                Comments and keys not shown here are preserved.
                {data.requiresRestart
                  ? " The server is running, so changes apply after a restart."
                  : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={!dirty}
                onClick={() => setDraft(props.data?.values ?? {})}
              >
                Discard
              </Button>
              <Button type="submit" disabled={!dirty || save.isPending || busy}>
                {save.isPending
                  ? "Saving…"
                  : `Save${dirty ? ` (${Object.keys(changed).length})` : ""}`}
              </Button>
            </div>
          </div>

          {GROUPS.map((group) => (
            <Card key={group}>
              <CardHeader>
                <CardTitle>{group}</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-border">
                {byGroup.get(group)?.map((spec) => (
                  <Field
                    key={spec.key}
                    spec={spec}
                    value={draft[spec.key] ?? spec.default}
                    onChange={(v) => setDraft((d) => ({ ...d, [spec.key]: v }))}
                  />
                ))}
              </CardContent>
            </Card>
          ))}

          {Object.keys(data.unknown).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Other keys</CardTitle>
                <CardDescription>
                  Present in the file but not editable here yet. They are preserved as-is.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {Object.entries(data.unknown)
                    .map(([k, v]) => `${k}=${v}`)
                    .join("\n")}
                </pre>
              </CardContent>
            </Card>
          )}
        </form>
      )}
    </div>
  );
}

function Field({
  spec,
  value,
  onChange,
}: {
  spec: PropertySpec;
  value: PropertyValue;
  onChange: (v: PropertyValue) => void;
}) {
  const id = `prop-${spec.key}`;
  return (
    <div className="grid gap-3 py-3 sm:grid-cols-[1fr_16rem] sm:items-center">
      <div>
        <Label htmlFor={id}>{spec.label}</Label>
        <p className="mt-0.5 text-xs text-muted-foreground">{spec.description}</p>
      </div>
      <div className="sm:justify-self-end sm:w-64">
        {spec.type === "boolean" && (
          <div className="flex justify-end">
            <Switch
              id={id}
              checked={Boolean(value)}
              onCheckedChange={onChange}
              disabled={spec.managed}
              aria-label={spec.label}
            />
          </div>
        )}
        {spec.type === "enum" && (
          <Select
            id={id}
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
            disabled={spec.managed}
          >
            {spec.options?.map((o) => (
              <option key={o} value={o}>
                {o.replace(/^minecraft:/, "")}
              </option>
            ))}
          </Select>
        )}
        {spec.type === "integer" && (
          <Input
            id={id}
            type="number"
            min={spec.min}
            max={spec.max}
            value={Number(value)}
            disabled={spec.managed}
            onChange={(e) =>
              onChange(e.target.value === "" ? (spec.default as number) : Number(e.target.value))
            }
          />
        )}
        {spec.type === "string" && (
          <Input
            id={id}
            value={String(value)}
            disabled={spec.managed}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}
