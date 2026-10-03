import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Lock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";

/**
 * After the panel restarts, the session survives but the key to the
 * credential store does not. Remote hosts and tunnels wait for it.
 */
export function UnlockBanner() {
  const trpc = useTRPC();
  const overview = useQuery(
    trpc.system.overview.queryOptions(undefined, { refetchInterval: 30_000 }),
  );
  const [password, setPassword] = useState("");
  const unlock = useMutation(
    trpc.auth.unlock.mutationOptions({
      onSuccess: () => {
        setPassword("");
        toast.success("Unlocked; reconnecting");
        void queryClient.invalidateQueries();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  if (!overview.data || overview.data.vaultUnlocked) return null;
  return (
    <form
      className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (password) unlock.mutate({ password });
      }}
    >
      <Lock className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <span className="min-w-0 flex-1">
        The panel restarted, so saved logins are locked. Enter your password to reconnect VPS hosts
        and tunnels.
      </span>
      <Input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="h-8 w-44"
        autoComplete="current-password"
      />
      <Button size="sm" type="submit" disabled={!password || unlock.isPending}>
        {unlock.isPending && <Loader2 className="animate-spin" />} Unlock
      </Button>
    </form>
  );
}
