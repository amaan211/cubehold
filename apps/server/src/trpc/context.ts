import "@fastify/cookie";
import { SESSION_COOKIE } from "@cubehold/shared";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { AssetService } from "../assets/service.js";
import { resolveSession, type SessionUser } from "../auth/session.js";
import type { CloudService } from "../cloud/service.js";
import type { Db } from "../db/index.js";
import type { HostManager } from "../hosts/manager.js";
import type { HostService } from "../hosts/service.js";
import type { BedrockService } from "../network/bedrock.js";
import type { PlayitService } from "../network/playit.js";
import type { NetworkService } from "../network/service.js";
import type { TailscaleService } from "../network/tailscale.js";
import type { TunnelService } from "../network/tunnels.js";
import type { NotificationService } from "../notify/service.js";
import type { RealtimeBus } from "../realtime/bus.js";
import type { SecurityService } from "../security/audit.js";
import type { KeyVault } from "../security/crypto.js";
import type { AddonService } from "../servers/addons.js";
import type { BackupService } from "../servers/backups.js";
import type { FileService } from "../servers/files.js";
import type { ModpackService } from "../servers/modpacks.js";
import type { ServerMover } from "../servers/move.js";
import type { PlayerService } from "../servers/players.js";
import type { ScheduleService } from "../servers/schedules.js";
import type { ServerService } from "../servers/service.js";

export interface AppServices {
  db: Db;
  vault: KeyVault;
  services: {
    servers: ServerService;
    players: PlayerService;
    files: FileService;
    backups: BackupService;
    schedules: ScheduleService;
    addons: AddonService;
    assets: AssetService;
    hosts: HostManager;
    hostAdmin: HostService;
    mover: ServerMover;
    cloud: CloudService;
    bus: RealtimeBus;
    network: NetworkService;
    playit: PlayitService;
    tunnels: TunnelService;
    tailscale: TailscaleService;
    bedrock: BedrockService;
    security: SecurityService;
    notifications: NotificationService;
    modpacks: ModpackService;
  };
}

export function createContextFactory(services: AppServices) {
  return async function createContext({ req, res }: CreateFastifyContextOptions) {
    const token = req.cookies[SESSION_COOKIE];
    const user: SessionUser | null = token ? await resolveSession(services.db, token) : null;
    return {
      ...services,
      req,
      res,
      user,
      sessionToken: token ?? null,
    };
  };
}

export type Context = Awaited<ReturnType<ReturnType<typeof createContextFactory>>>;
