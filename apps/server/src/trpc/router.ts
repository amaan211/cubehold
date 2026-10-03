import { authRouter } from "./routers/auth.js";
import { cloudRouter } from "./routers/cloud.js";
import { hostsRouter } from "./routers/hosts.js";
import {
  addonsRouter,
  assetsRouter,
  backupsRouter,
  filesRouter,
  playersRouter,
  schedulesRouter,
} from "./routers/manage.js";
import { mcRouter } from "./routers/mc.js";
import { modpacksRouter } from "./routers/modpacks.js";
import { bedrockRouter, networkRouter, securityRouter } from "./routers/network.js";
import { notificationsRouter } from "./routers/notifications.js";
import { onboardingRouter } from "./routers/onboarding.js";
import { serversRouter } from "./routers/servers.js";
import { systemRouter } from "./routers/system.js";
import { router } from "./trpc.js";

export const appRouter = router({
  auth: authRouter,
  system: systemRouter,
  hosts: hostsRouter,
  cloud: cloudRouter,
  servers: serversRouter,
  players: playersRouter,
  files: filesRouter,
  backups: backupsRouter,
  schedules: schedulesRouter,
  addons: addonsRouter,
  assets: assetsRouter,
  mc: mcRouter,
  network: networkRouter,
  bedrock: bedrockRouter,
  security: securityRouter,
  notifications: notificationsRouter,
  onboarding: onboardingRouter,
  modpacks: modpacksRouter,
});

export type AppRouter = typeof appRouter;
