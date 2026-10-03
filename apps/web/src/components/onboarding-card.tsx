import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Circle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { queryClient, useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type StepId = "create" | "start" | "friends" | "secure" | "backups" | "discord";

const STEPS: Record<
  StepId,
  {
    title: string;
    description: string;
    action: string;
    /** Where the action goes; server tabs need a server. */
    to:
      | "/servers/new"
      | "/servers/$id"
      | "/servers/$id/network"
      | "/servers/$id/security"
      | "/servers/$id/schedules"
      | "/servers/$id/settings";
  }
> = {
  create: {
    title: "Create a server",
    description:
      "Pick Paper, a version and how much memory. Java and the server files download by themselves.",
    action: "New server",
    to: "/servers/new",
  },
  start: {
    title: "Start it and join",
    description: "Press Start, then connect from Minecraft with the address on the Overview tab.",
    action: "Open server",
    to: "/servers/$id",
  },
  friends: {
    title: "Let friends join from anywhere",
    description:
      "Use playit.gg (works on any network), a router port forward, or run the server on a VPS.",
    action: "Network",
    to: "/servers/$id/network",
  },
  secure: {
    title: "Check its security",
    description:
      "A whitelist, online mode and a rollback plugin keep griefers out. One button applies them.",
    action: "Security",
    to: "/servers/$id/security",
  },
  backups: {
    title: "Back up the world every night",
    description: "Add a backup schedule so a bad night never costs you the world.",
    action: "Schedules",
    to: "/servers/$id/schedules",
  },
  discord: {
    title: "Get Discord messages (optional)",
    description: "Hear when the server starts, crashes, or friends join, in your Discord channel.",
    action: "Settings",
    to: "/servers/$id/settings",
  },
};

/** First-run checklist. Steps tick themselves off; the owner can hide it. */
export function OnboardingCard() {
  const trpc = useTRPC();
  const data = useQuery(trpc.onboarding.get.queryOptions(undefined, { refetchInterval: 15_000 }));
  const dismiss = useMutation(
    trpc.onboarding.dismiss.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.onboarding.get.queryKey() }),
    }),
  );
  const d = data.data;
  if (!d || d.dismissed || d.steps.length === 0) return null;
  const doneCount = d.steps.filter((s) => s.done).length;
  const next = d.steps.find((s) => !s.done)?.id;
  const allDone = !next;

  return (
    <Card className="border-primary/30">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>{allDone ? "You're all set" : "Getting started"}</CardTitle>
          <CardDescription>
            {allDone
              ? "Every step is done. You can hide this list."
              : `${doneCount} of ${d.steps.length} done. The list updates as you go.`}
          </CardDescription>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Hide getting started"
          onClick={() => dismiss.mutate()}
          disabled={dismiss.isPending}
        >
          <X />
        </Button>
      </CardHeader>
      <CardContent>
        <div
          className="mb-4 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={d.steps.length}
          aria-valuenow={doneCount}
          aria-label="Getting started progress"
        >
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${(doneCount / d.steps.length) * 100}%` }}
          />
        </div>
        <ol className="space-y-1">
          {d.steps.map((s) => {
            const step = STEPS[s.id as StepId];
            const needsServer = step.to !== "/servers/new";
            const current = s.id === next;
            return (
              <li
                key={s.id}
                className={cn(
                  "flex flex-col gap-2 rounded-md px-3 py-2.5 sm:flex-row sm:items-center",
                  current && "bg-accent/50",
                )}
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  {s.done ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                  ) : (
                    <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0">
                    <p
                      className={cn(
                        "text-sm font-medium",
                        s.done && "text-muted-foreground line-through",
                      )}
                    >
                      {step.title}
                    </p>
                    {!s.done && <p className="text-xs text-muted-foreground">{step.description}</p>}
                  </div>
                </div>
                {!s.done && (!needsServer || d.serverId) && (
                  <Button
                    asChild
                    size="sm"
                    variant={current ? "default" : "outline"}
                    className="shrink-0 self-start sm:self-auto"
                  >
                    {needsServer ? (
                      <Link to={step.to} params={{ id: d.serverId ?? "" }}>
                        {step.action} <ArrowRight />
                      </Link>
                    ) : (
                      <Link to="/servers/new">
                        {step.action} <ArrowRight />
                      </Link>
                    )}
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
