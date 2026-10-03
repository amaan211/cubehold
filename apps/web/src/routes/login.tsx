import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Blocks } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/login")({
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(context.trpc.auth.status.queryOptions());
    if (status.needsSetup) throw redirect({ to: "/setup" });
    if (status.authenticated) throw redirect({ to: "/" });
  },
  component: Login,
});

function Login() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { redirect: target } = Route.useSearch();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation(
    trpc.auth.login.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries();
        await navigate({ to: target?.startsWith("/") ? target : "/" });
      },
    }),
  );

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <span className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Blocks className="size-5" />
          </span>
          <CardTitle className="mt-2 text-lg">Welcome back</CardTitle>
          <CardDescription>Sign in to manage your servers.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate({ username, password });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {login.error && (
              <p className="text-sm text-destructive" role="alert">
                {errorMessage(login.error)}
              </p>
            )}
            <Button type="submit" disabled={login.isPending || !username || !password}>
              {login.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
