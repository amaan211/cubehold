import { discordWebhookUrl, type NotifyEvent } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, BellRing, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";

const EVENTS: Array<{ id: NotifyEvent; label: string; cloudOnly?: boolean }> = [
  { id: "status", label: "Starts, stops and sleep" },
  { id: "crash", label: "Crashes" },
  { id: "players", label: "Players joining and leaving" },
  { id: "backupFailed", label: "Failed backups" },
  { id: "backup", label: "Finished backups" },
  { id: "vm", label: "Cloud VM turned on or off", cloudOnly: true },
];

/** Discord messages about this server through a channel webhook. */
export function NotificationsCard({ serverId, cloud }: { serverId: string; cloud: boolean }) {
  const trpc = useTRPC();
  const current = useQuery(trpc.notifications.get.queryOptions({ serverId }));
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<NotifyEvent[]>([]);

  useEffect(() => {
    if (!current.data) return;
    setUrl(current.data.discordWebhook ?? "");
    setEvents(current.data.events);
  }, [current.data]);

  const save = useMutation(
    trpc.notifications.set.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.notifications.get.queryKey({ serverId }),
        });
        toast.success("Saved");
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const test = useMutation(
    trpc.notifications.test.mutationOptions({
      onSuccess: () => toast.success("Sent. Check the Discord channel."),
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );

  if (!current.data) return null;
  const trimmed = url.trim();
  const valid = trimmed === "" || discordWebhookUrl.safeParse(trimmed).success;
  const dirty =
    trimmed !== (current.data.discordWebhook ?? "") ||
    events.slice().sort().join() !== current.data.events.slice().sort().join();
  const toggle = (id: NotifyEvent, on: boolean) =>
    setEvents((list) => (on ? [...new Set([...list, id])] : list.filter((e) => e !== id)));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="size-4" /> Discord notifications
        </CardTitle>
        <CardDescription>
          In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
          Paste it here to get messages in that channel.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-1.5">
          <Label htmlFor="discord-webhook">Webhook URL</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="discord-webhook"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://discord.com/api/webhooks/…"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              disabled={!trimmed || !valid || test.isPending}
              onClick={() => test.mutate({ serverId, discordWebhook: trimmed })}
            >
              <Send /> Send a test
            </Button>
          </div>
          {!valid && (
            <p className="text-xs text-destructive">
              That is not a Discord webhook URL. It starts with https://discord.com/api/webhooks/.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Anyone with this URL can post in the channel, so keep it private.
          </p>
        </div>

        <fieldset className="grid gap-3 sm:grid-cols-2" disabled={!trimmed}>
          <legend className="mb-2 text-sm font-medium">Tell me about</legend>
          {EVENTS.filter((e) => !e.cloudOnly || cloud).map((e) => (
            <div key={e.id} className="flex items-center justify-between gap-3">
              <Label htmlFor={`notify-${e.id}`} className="font-normal">
                {e.label}
              </Label>
              <Switch
                id={`notify-${e.id}`}
                checked={events.includes(e.id)}
                onCheckedChange={(on) => toggle(e.id, on)}
                disabled={!trimmed}
              />
            </div>
          ))}
        </fieldset>

        {current.data.lastError && (
          <p className="flex gap-1.5 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            The last message did not arrive: {current.data.lastError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {current.data.discordWebhook && (
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => save.mutate({ serverId, discordWebhook: null, events })}
            >
              Turn off
            </Button>
          )}
          <Button
            type="button"
            disabled={!dirty || !valid || save.isPending}
            onClick={() => save.mutate({ serverId, discordWebhook: trimmed || null, events })}
          >
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
