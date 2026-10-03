import { useMutation, useQuery } from "@tanstack/react-query";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { OfflineModeWarning } from "@/components/offline-mode-warning";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";

/** One switch for every Microsoft/Mojang authentication setting. */
export function AuthCard({ serverId, disabled }: { serverId: string; disabled?: boolean }) {
  const trpc = useTRPC();
  const props = useQuery(trpc.servers.properties.queryOptions({ serverId }));
  const [confirmOff, setConfirmOff] = useState(false);
  const online = props.data?.values["online-mode"] !== false;

  const setMode = useMutation(
    trpc.servers.setAuthMode.mutationOptions({
      onSuccess: async (data, vars) => {
        queryClient.setQueryData(trpc.servers.properties.queryKey({ serverId }), data);
        await queryClient.invalidateQueries({ queryKey: trpc.servers.get.queryKey({ serverId }) });
        await queryClient.invalidateQueries({ queryKey: trpc.servers.list.queryKey() });
        const what = vars.onlineMode ? "Online mode on" : "Offline mode on";
        toast.success(data.requiresRestart ? `${what}. Restart the server to apply.` : what);
        setConfirmOff(false);
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {online ? (
            <ShieldCheck className="size-4 text-primary" />
          ) : (
            <ShieldOff className="size-4 text-amber-500" />
          )}
          Player login
        </CardTitle>
        <CardDescription>
          {online
            ? "Players sign in with a Microsoft account and Mojang verifies every join."
            : "Authentication is off. Players can join without a Microsoft account."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="auth-online">Require a Microsoft account</Label>
          <Switch
            id="auth-online"
            checked={online}
            disabled={disabled || setMode.isPending || !props.data}
            onCheckedChange={(next) => {
              if (next) setMode.mutate({ serverId, onlineMode: true });
              else setConfirmOff(true);
            }}
          />
        </div>
        {!online && <OfflineModeWarning existingWorld />}
      </CardContent>

      <Dialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title="Turn off Microsoft/Mojang authentication?"
        description="This sets online-mode and enforce-secure-profile to false in server.properties."
        className="max-w-lg"
      >
        <OfflineModeWarning existingWorld />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmOff(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={setMode.isPending}
            onClick={() => setMode.mutate({ serverId, onlineMode: false })}
          >
            Turn off authentication
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
