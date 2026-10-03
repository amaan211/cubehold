import { LOCAL_HOST_ID } from "@cubehold/shared";
import { desc, eq, ne } from "drizzle-orm";
import { schema } from "../../db/index.js";
import { protectedProcedure, router } from "../trpc.js";

const DISMISSED = "onboarding.dismissed";

export type OnboardingStep = "create" | "start" | "friends" | "secure" | "backups" | "discord";

/**
 * The first-run checklist on the Servers page. Each step is worked out from
 * what the panel already knows, so it ticks itself off as the owner goes.
 */
export const onboardingRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const dismissed =
      (await ctx.db.select().from(schema.settings).where(eq(schema.settings.key, DISMISSED)).get())
        ?.value === "1";
    const servers = await ctx.db
      .select()
      .from(schema.servers)
      .orderBy(desc(schema.servers.createdAt));
    const first = servers[0] ?? null;
    if (dismissed) return { dismissed, serverId: first?.id ?? null, steps: [] };

    const remoteHost = await ctx.db
      .select({ id: schema.hosts.id })
      .from(schema.hosts)
      .where(ne(schema.hosts.id, LOCAL_HOST_ID))
      .limit(1)
      .get();
    const playit = await ctx.services.playit.status().catch(() => null);
    const backupSchedule = await ctx.db
      .select({ id: schema.schedules.id })
      .from(schema.schedules)
      .where(eq(schema.schedules.action, "backup"))
      .limit(1)
      .get();
    // The score from the last time the Security tab (or a fix) built the report: building one
    // here would make the checklist wait on router and firewall checks.
    const score = first ? ctx.services.security.lastScore(first.id) : null;

    const done: Record<OnboardingStep, boolean> = {
      create: servers.length > 0,
      start: servers.some((s) => !!s.meta?.lastStartedAt),
      // Reachable from elsewhere: a tunnel, a router forward, or a server on a VPS or cloud VM.
      friends:
        !!playit?.linked ||
        !!remoteHost ||
        servers.some((s) => s.settings?.upnp || s.settings?.ngrok),
      secure: score !== null && score >= 80,
      backups: !!backupSchedule,
      discord: servers.some((s) => !!s.settings?.notifications?.discordWebhook),
    };
    const order: OnboardingStep[] = ["create", "start", "friends", "secure", "backups", "discord"];
    return {
      dismissed,
      serverId: first?.id ?? null,
      steps: order.map((id) => ({ id, done: done[id] })),
    };
  }),

  dismiss: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .insert(schema.settings)
      .values({ key: DISMISSED, value: "1" })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1" } });
  }),

  /** Bring the list back (Settings). */
  show: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.delete(schema.settings).where(eq(schema.settings.key, DISMISSED));
  }),
});
