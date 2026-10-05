import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const HostKind = z.enum(["local", "ssh", "cloud"]);
export type HostKind = z.infer<typeof HostKind>;

export const HostStatus = z.enum(["unknown", "online", "offline", "provisioning", "error"]);
export type HostStatus = z.infer<typeof HostStatus>;

export const CloudProviderId = z.enum([
  "hetzner",
  "aws",
  "gcp",
  "azure",
  "linode",
  "digitalocean",
  "vultr",
  "oracle",
]);
export type CloudProviderId = z.infer<typeof CloudProviderId>;

export const ServerSoftware = z.enum(["vanilla", "paper", "purpur", "fabric", "forge", "neoforge"]);
export type ServerSoftware = z.infer<typeof ServerSoftware>;

export const ServerStatus = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
  "installing",
  "sleeping",
]);
export type ServerStatus = z.infer<typeof ServerStatus>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "At least 3 characters")
  .max(32, "At most 32 characters")
  .regex(/^[a-zA-Z0-9_.-]+$/, "Letters, numbers, dots, dashes and underscores only");

export const passwordSchema = z
  .string()
  .min(10, "At least 10 characters")
  .max(256, "At most 256 characters");

export const setupOwnerInput = z.object({
  username: usernameSchema,
  password: passwordSchema,
});
export type SetupOwnerInput = z.infer<typeof setupOwnerInput>;

export const loginInput = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginInput>;

export const authStatus = z.object({
  needsSetup: z.boolean(),
  authenticated: z.boolean(),
  user: z.object({ id: z.string(), username: z.string() }).nullable(),
});
export type AuthStatus = z.infer<typeof authStatus>;

// ---------------------------------------------------------------------------
// Domain objects (API shapes, not DB rows)
// ---------------------------------------------------------------------------

export const hostSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: HostKind,
  provider: CloudProviderId.nullable(),
  status: HostStatus,
  publicIp: z.string().nullable(),
  createdAt: z.string(),
});
export type Host = z.infer<typeof hostSchema>;

export const serverSchema = z.object({
  id: z.string(),
  hostId: z.string(),
  name: z.string(),
  software: ServerSoftware,
  mcVersion: z.string(),
  javaVersion: z.number().int(),
  memoryMb: z.number().int(),
  port: z.number().int(),
  status: ServerStatus,
  /** false = offline mode: no Microsoft/Mojang account checks. */
  onlineMode: z.boolean(),
  createdAt: z.string(),
});
export type Server = z.infer<typeof serverSchema>;

export const serverNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-zA-Z0-9 _.-]+$/, "Letters, numbers, spaces, dots, dashes and underscores only");

export const createServerInput = z.object({
  hostId: z.string(),
  name: serverNameSchema,
  software: ServerSoftware,
  mcVersion: z.string().min(1),
  memoryMb: z.number().int().min(512).max(262144),
  port: z.number().int().min(1024).max(65535).default(25565),
  /** Require Microsoft accounts. false turns off every Mojang auth check. */
  onlineMode: z.boolean().default(true),
  acceptEula: z.literal(true, { error: "You must accept the Minecraft EULA" }),
});
export type CreateServerInput = z.infer<typeof createServerInput>;

export const serverIdInput = z.object({ serverId: z.string().min(1) });

// --- Modpacks -------------------------------------------------------------------

export const modpackSearchInput = z.object({
  query: z.string().trim().max(100),
  offset: z.number().int().min(0).max(10_000).default(0),
});
export const modpackVersionsInput = z.object({ projectId: z.string().min(1).max(100) });
export const prepareModpackInput = z.object({
  versionId: z.string().min(1).max(100),
  iconUrl: z.url().nullable().default(null),
});
export const installModpackInput = z.object({
  packId: z.string().min(1).max(64),
  hostId: z.string(),
  name: serverNameSchema,
  memoryMb: z.number().int().min(1024).max(262144),
  port: z.number().int().min(1024).max(65535),
  onlineMode: z.boolean(),
  acceptEula: z.literal(true, { error: "You must accept the Minecraft EULA" }),
});
export type InstallModpackInput = z.infer<typeof installModpackInput>;

export const setAuthModeInput = serverIdInput.extend({ onlineMode: z.boolean() });

// --- Version changes ----------------------------------------------------------

/**
 * What to do with the world when moving to an older version. Minecraft cannot
 * load worlds saved by a newer version reliably.
 *  - restore: bring back the snapshot taken when the server last ran the target version
 *  - keep:    keep the current world anyway (chunks may fail to load)
 *  - fresh:   start a new world (the current one is kept in a snapshot)
 */
export const DowngradeWorldAction = z.enum(["restore", "keep", "fresh"]);
export type DowngradeWorldAction = z.infer<typeof DowngradeWorldAction>;

export const changeVersionInput = serverIdInput.extend({
  mcVersion: z.string().min(1),
  worldAction: DowngradeWorldAction.optional(),
});

export const versionSnapshot = z.object({
  id: z.string(),
  mcVersion: z.string(),
  software: ServerSoftware,
  createdAt: z.string(),
  sizeBytes: z.number(),
  folders: z.array(z.string()),
});
export type VersionSnapshot = z.infer<typeof versionSnapshot>;

// --- Deletion -----------------------------------------------------------------

/** Groups of server files the user can export before deleting a server. */
export const BackupCategory = z.enum(["world", "addons", "config", "logs", "snapshots", "other"]);
export type BackupCategory = z.infer<typeof BackupCategory>;

export const deleteServerInput = serverIdInput.extend({
  backup: z
    .object({
      destination: z.string().trim().min(1, "Choose a folder"),
      include: z.array(BackupCategory).min(1, "Choose at least one thing to keep"),
    })
    .optional(),
});
export type DeleteServerInput = z.infer<typeof deleteServerInput>;

export const sendCommandInput = serverIdInput.extend({
  command: z.string().trim().min(1).max(1024),
});

// --- Server settings ------------------------------------------------------------

/** What the agent does on its own, even while the panel is closed. */
export const serverAutomation = z.object({
  /** Start the server again after a crash (at most 3 times in 10 minutes). */
  autoRestart: z.boolean(),
  /** Stop the server after this many minutes with nobody online. 0 = never. */
  idleStopMinutes: z.number().int().min(0).max(1440),
  /** After an idle stop, keep answering on the port and start when someone joins. */
  wakeOnJoin: z.boolean(),
  /**
   * Cloud hosts: what happens to the VM once idle stops leave nothing running
   * on it. "stop" powers it off (saves money on AWS), "hibernate" saves it as
   * a snapshot and deletes it (saves money everywhere, slower to start).
   */
  vmIdle: z.enum(["keep", "stop", "hibernate"]),
});
export type ServerAutomation = z.infer<typeof serverAutomation>;

export const DEFAULT_AUTOMATION: ServerAutomation = {
  autoRestart: true,
  idleStopMinutes: 0,
  wakeOnJoin: true,
  vmIdle: "keep",
};

/** A server on a cloud VM stops after this long with nobody online, unless the owner changes it. */
export const CLOUD_IDLE_STOP_MINUTES = 15;

// --- Notifications ------------------------------------------------------------

/**
 * A Discord webhook (Server Settings → Integrations → Webhooks → Copy Webhook
 * URL). Only Discord's own hosts are accepted: the panel posts to this URL.
 */
export const discordWebhookUrl = z
  .string()
  .trim()
  .regex(
    /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[\w-]{20,120}(?:\?thread_id=\d{5,30})?$/,
    "Paste a Discord webhook URL (https://discord.com/api/webhooks/…)",
  );

export const NotifyEvent = z.enum([
  /** Started, stopped, sleeping. */
  "status",
  "crash",
  /** Joins and leaves. */
  "players",
  "backup",
  "backupFailed",
  /** The cloud VM under the server started, stopped or was saved as a snapshot. */
  "vm",
]);
export type NotifyEvent = z.infer<typeof NotifyEvent>;

export const DEFAULT_NOTIFY_EVENTS: NotifyEvent[] = [
  "status",
  "crash",
  "players",
  "backupFailed",
  "vm",
];

export const serverNotifications = z.object({
  /** null: no notifications. */
  discordWebhook: discordWebhookUrl.nullable(),
  events: z.array(NotifyEvent),
});
export type ServerNotifications = z.infer<typeof serverNotifications>;

export const setNotificationsInput = serverIdInput.extend(serverNotifications.shape);

/** Send a sample message, to the given URL or the saved one. */
export const testNotificationInput = serverIdInput.extend({
  discordWebhook: discordWebhookUrl.optional(),
});

export const updateServerInput = serverIdInput.extend({
  name: serverNameSchema.optional(),
  memoryMb: z.number().int().min(512).max(262144).optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  extraJvmArgs: z.array(z.string().trim().min(1).max(512)).max(64).optional(),
  automation: serverAutomation.partial().optional(),
  /** Scheduled and pre-restore backups to keep; manual backups are never pruned. */
  backupKeep: z.number().int().min(1).max(200).optional(),
});
export type UpdateServerInput = z.infer<typeof updateServerInput>;

// --- Players --------------------------------------------------------------------

export const PlayerAction = z.enum([
  "kick",
  "ban",
  "pardon",
  "op",
  "deop",
  "whitelist_add",
  "whitelist_remove",
  "ban_ip",
  "pardon_ip",
]);
export type PlayerAction = z.infer<typeof PlayerAction>;

export const playerActionInput = serverIdInput.extend({
  action: PlayerAction,
  /** Player name, or an IP address for ban_ip / pardon_ip. */
  target: z.string().trim().min(1).max(64),
  reason: z.string().trim().max(256).optional(),
});
export type PlayerActionInput = z.infer<typeof playerActionInput>;

export const setWhitelistInput = serverIdInput.extend({ enabled: z.boolean() });

/** A player name, or a UUID for players whose name the server no longer remembers. */
export const playerNameInput = serverIdInput.extend({
  name: z
    .string()
    .trim()
    .regex(
      /^([A-Za-z0-9_]{1,16}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
      "Not a player name",
    ),
});

export const playerDetailsInput = playerNameInput.extend({
  /** Ask the server to save player data now (throttled), for an up-to-date inventory. */
  fresh: z.boolean().optional(),
});

export const GameMode = z.enum(["survival", "creative", "adventure", "spectator"]);
export type GameMode = z.infer<typeof GameMode>;

const coordinate = z.number().finite().min(-30_000_000).max(30_000_000);
const resourceId = z
  .string()
  .trim()
  .regex(/^([a-z0-9_.-]+:)?[a-z0-9_./-]+$/, "Not a valid id, e.g. minecraft:diamond");

/** In-game actions on one online player. */
export const PlayerCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("kill") }),
  z.object({ type: z.literal("heal") }),
  z.object({ type: z.literal("feed") }),
  z.object({ type: z.literal("starve") }),
  z.object({ type: z.literal("clear") }),
  z.object({ type: z.literal("gamemode"), mode: GameMode }),
  z.object({
    type: z.literal("teleport"),
    x: coordinate,
    y: coordinate,
    z: coordinate,
    dimension: resourceId.optional(),
  }),
  z.object({
    type: z.literal("teleportToPlayer"),
    target: z.string().regex(/^[A-Za-z0-9_]{1,16}$/, "Not a player name"),
  }),
  z.object({
    type: z.literal("give"),
    item: resourceId,
    count: z.number().int().min(1).max(6400),
  }),
  z.object({ type: z.literal("message"), text: z.string().trim().min(1).max(256) }),
]);
export type PlayerCommand = z.infer<typeof PlayerCommand>;

export const playerCommandInput = playerNameInput.extend({ command: PlayerCommand });

/** One stack in an inventory, flattened from the game's NBT. */
export interface ItemView {
  id: string;
  count: number;
  /** Custom name set with an anvil or a command, as plain text. */
  customName: string | null;
  enchantments: Array<{ id: string; level: number }>;
  /** Damage taken, for tools and armor. */
  damage: number | null;
  maxDamage: number | null;
  lore: string[];
  /** Dye or potion colour (0xRRGGBB) when the item has one. */
  color: number | null;
}

export interface Location {
  x: number;
  y: number;
  z: number;
  dimension: string;
}

export interface PlayerInventoryView {
  /** Slots 0-8. */
  hotbar: Array<ItemView | null>;
  /** Slots 9-35, row by row. */
  main: Array<ItemView | null>;
  armor: {
    head: ItemView | null;
    chest: ItemView | null;
    legs: ItemView | null;
    feet: ItemView | null;
  };
  offhand: ItemView | null;
  /** Selected hotbar slot, 0-8. */
  selected: number;
}

export interface PlayerStatsView {
  playTimeMs: number;
  deaths: number;
  mobKills: number;
  playerKills: number;
  /** Walking, sprinting, swimming, flying and riding, in blocks. */
  distanceBlocks: number;
  jumps: number;
  damageDealt: number;
  damageTaken: number;
  blocksMined: number;
  itemsCrafted: number;
  fishCaught: number;
  animalsBred: number;
  timesLeft: number;
  timeSinceDeathMs: number | null;
  mostMined: { id: string; count: number } | null;
  mostKilled: { id: string; count: number } | null;
  killedBy: { id: string; count: number } | null;
}

export interface PlayerDetails {
  name: string;
  uuid: string | null;
  online: boolean;
  /** live: read from the running server just now; saved: from its last save to disk. */
  source: "live" | "saved" | "none";
  savedAt: string | null;
  gameMode: GameMode | null;
  health: number | null;
  maxHealth: number;
  absorption: number;
  food: number | null;
  saturation: number | null;
  xpLevel: number | null;
  /** Progress towards the next level, 0..1. */
  xpProgress: number | null;
  xpTotal: number | null;
  position: Location | null;
  respawn: Location | null;
  lastDeath: Location | null;
  inventory: PlayerInventoryView | null;
  enderChest: Array<ItemView | null> | null;
  stats: PlayerStatsView | null;
  advancements: number | null;
  status: { op: boolean; whitelisted: boolean; banned: boolean; banReason: string | null };
  /** From the panel's own session log. */
  sessions: { count: number; firstSeen: string | null; lastSeen: string | null };
  mcVersion: string;
}

// --- Item icons -----------------------------------------------------------------

/** A texture (path under textures/, no extension) and its size in pixels. */
export interface TextureRef {
  texture: string;
  size: [number, number];
}

/** One textured area of a cube face; uv in texture pixels, x/y as fractions of the face. */
export interface FacePart extends TextureRef {
  uv: [number, number, number, number];
  x: [number, number];
  y: [number, number];
  /** Multiply colour, 0xRRGGBB. */
  tint: number | null;
}

export type ItemIcon =
  | {
      kind: "flat";
      /**
       * dyeable: the item's own colour (dyed leather, potion) replaces the default tint.
       * uv: crop in texture pixels, for sprites cut out of an atlas (the shield).
       */
      layers: Array<
        TextureRef & {
          tint: number | null;
          dyeable?: boolean;
          uv?: [number, number, number, number];
        }
      >;
    }
  | {
      kind: "block";
      /** Box height as a fraction of a full block (slabs are 0.5). */
      height: number;
      /** Overall size relative to a full block icon (heads are smaller). */
      scale: number;
      top: FacePart[];
      left: FacePart[];
      right: FacePart[];
    }
  | { kind: "missing" };

/** GUI textures from the game, each with a crop when it lives in an atlas. */
export interface GuiSprite extends TextureRef {
  crop: [number, number, number, number] | null;
}

export interface GuiTextures {
  inventory: GuiSprite | null;
  chest: GuiSprite | null;
  heartFull: GuiSprite | null;
  heartHalf: GuiSprite | null;
  heartContainer: GuiSprite | null;
  heartAbsorbingFull: GuiSprite | null;
  heartAbsorbingHalf: GuiSprite | null;
  foodFull: GuiSprite | null;
  foodHalf: GuiSprite | null;
  foodEmpty: GuiSprite | null;
  xpBackground: GuiSprite | null;
  xpProgress: GuiSprite | null;
  slotHelmet: GuiSprite | null;
  slotChestplate: GuiSprite | null;
  slotLeggings: GuiSprite | null;
  slotBoots: GuiSprite | null;
  slotShield: GuiSprite | null;
}

export const itemIconsInput = z.object({
  mcVersion: z.string().min(1).max(64),
  ids: z.array(resourceId).max(500),
});

// --- Files ----------------------------------------------------------------------

const relPath = z.string().max(1024);

export const filePathInput = serverIdInput.extend({ path: relPath });
export const writeFileInput = filePathInput.extend({
  content: z.string().max(5 * 1024 * 1024),
});
export const renamePathInput = serverIdInput.extend({ from: relPath.min(1), to: relPath.min(1) });
export const deletePathsInput = serverIdInput.extend({
  paths: z.array(relPath.min(1)).min(1).max(1000),
});
export const archivePathsInput = serverIdInput.extend({
  /** Directory the entries live in, relative to the server folder. */
  dir: relPath,
  names: z.array(z.string().min(1).max(255)).min(1).max(1000),
  /** Name of the zip to create inside `dir`. */
  archiveName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/\.zip$/i, "Must end in .zip"),
});
export const extractArchiveInput = serverIdInput.extend({ path: relPath.min(1), into: relPath });

export interface FileEntry {
  name: string;
  kind: "file" | "dir";
  sizeBytes: number;
  modifiedAt: string;
}

// --- Backups --------------------------------------------------------------------

/** full: everything except downloaded files (jar, libraries, caches, logs). world: world folders only. */
export const BackupScope = z.enum(["full", "world"]);
export type BackupScope = z.infer<typeof BackupScope>;

export const BackupKind = z.enum(["manual", "scheduled", "pre-restore"]);
export type BackupKind = z.infer<typeof BackupKind>;

export const BackupState = z.enum(["creating", "ready", "failed"]);
export type BackupState = z.infer<typeof BackupState>;

export const createBackupInput = serverIdInput.extend({
  label: z.string().trim().max(80).optional(),
  scope: BackupScope.default("full"),
});
export const backupIdInput = serverIdInput.extend({ backupId: z.string().min(1) });
export const restoreBackupInput = backupIdInput.extend({
  /** Back up the current state first so the restore can be undone. */
  safetyBackup: z.boolean().default(true),
  /** Start the server when the restore is done. */
  startAfter: z.boolean().default(false),
});

export interface BackupInfo {
  id: string;
  serverId: string;
  label: string | null;
  kind: BackupKind;
  scope: BackupScope;
  state: BackupState;
  error: string | null;
  sizeBytes: number | null;
  files: number | null;
  mcVersion: string | null;
  createdAt: string;
}

// --- Schedules ------------------------------------------------------------------

export const ScheduleAction = z.enum([
  "restart",
  "backup",
  "command",
  "broadcast",
  "start",
  "stop",
]);
export type ScheduleAction = z.infer<typeof ScheduleAction>;

export const scheduleFields = z.object({
  name: z.string().trim().min(1).max(60),
  /** Five-field cron expression in the panel machine's time zone. */
  cron: z.string().trim().min(9).max(120),
  action: ScheduleAction,
  /** Command for "command", message for "broadcast". */
  payload: z.string().trim().max(1024).optional(),
  /** restart/stop: warn players this many seconds ahead. */
  warnSeconds: z.number().int().min(0).max(3600).optional(),
  enabled: z.boolean().default(true),
});
export const createScheduleInput = serverIdInput.extend(scheduleFields.shape);
export const updateScheduleInput = createScheduleInput.extend({ scheduleId: z.string().min(1) });
export const scheduleIdInput = serverIdInput.extend({ scheduleId: z.string().min(1) });
export const previewCronInput = z.object({ cron: z.string().trim().max(120) });

// --- Plugins and mods -------------------------------------------------------------

/** geysermc: Geyser and Floodgate for Paper, from GeyserMC's own download site. */
export const AddonSource = z.enum(["modrinth", "hangar", "geysermc"]);
export type AddonSource = z.infer<typeof AddonSource>;

export const addonSearchInput = serverIdInput.extend({
  source: AddonSource,
  query: z.string().trim().max(100),
  offset: z.number().int().min(0).max(10_000).default(0),
});
export const addonInstallInput = serverIdInput.extend({
  source: AddonSource,
  projectId: z.string().min(1).max(200),
  /** Also install required dependencies that are missing. */
  withDependencies: z.boolean().default(true),
});
export const addonFileInput = serverIdInput.extend({ file: z.string().min(1).max(255) });
export const addonRemoveInput = addonFileInput.extend({
  /** Also delete the plugin's config folder. */
  deleteConfig: z.boolean().default(false),
});
export const addonToggleInput = addonFileInput.extend({ enabled: z.boolean() });

/** A selectable Minecraft version as shown in the create wizard. */
export const mcVersionOption = z.object({
  id: z.string(),
  /** release | snapshot | pre-release etc. Only "release" is shown by default. */
  kind: z.enum(["release", "snapshot"]),
  releasedAt: z.string().nullable(),
});
export type McVersionOption = z.infer<typeof mcVersionOption>;

/** One entry in server.properties as described by the typed schema. */
export const propertySpec = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  group: z.string(),
  type: z.enum(["boolean", "integer", "string", "enum"]),
  default: z.union([z.string(), z.number(), z.boolean()]),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Editing is disabled in the UI because the panel manages it. */
  managed: z.boolean().optional(),
});
export type PropertySpec = z.infer<typeof propertySpec>;

export const propertyValue = z.union([z.string(), z.number(), z.boolean()]);
export type PropertyValue = z.infer<typeof propertyValue>;

export const updatePropertiesInput = serverIdInput.extend({
  values: z.record(z.string(), propertyValue),
});

// ---------------------------------------------------------------------------
// Realtime events (WebSocket)
// ---------------------------------------------------------------------------

export const metricsTick = z.object({
  serverId: z.string(),
  at: z.number(),
  cpuPercent: z.number(),
  /** Whole Java process (heap + JVM overhead), as the OS sees it. */
  memUsedMb: z.number(),
  /** Configured heap (-Xmx). */
  memMaxMb: z.number(),
  /** Heap still in use after the last garbage collection; null until the first GC. */
  heapUsedMb: z.number().nullable(),
  tps: z.number().nullable(),
  /** Milliseconds per tick; 50 is the budget for 20 TPS. */
  mspt: z.number().nullable(),
  playersOnline: z.number().int(),
});
export type MetricsTick = z.infer<typeof metricsTick>;

export const consoleLine = z.object({
  serverId: z.string(),
  at: z.number(),
  line: z.string(),
  stream: z.enum(["stdout", "stderr", "system"]),
});
export type ConsoleLine = z.infer<typeof consoleLine>;

export const statusChanged = z.object({
  serverId: z.string(),
  at: z.number(),
  status: ServerStatus,
});
export type StatusChanged = z.infer<typeof statusChanged>;

export const installProgress = z.object({
  serverId: z.string(),
  at: z.number(),
  step: z.enum(["java", "download", "configure", "done", "failed"]),
  message: z.string(),
  /** 0..100 when known. */
  percent: z.number().nullable(),
});
export type InstallProgress = z.infer<typeof installProgress>;

export const playersChanged = z.object({
  serverId: z.string(),
  at: z.number(),
  players: z.array(z.string()),
});
export type PlayersChanged = z.infer<typeof playersChanged>;

/** Progress of a background job on a server: backup, restore, archive, plugin install. */
export const taskProgress = z.object({
  serverId: z.string(),
  at: z.number(),
  taskId: z.string(),
  kind: z.enum(["backup", "restore", "archive", "extract", "addon", "move"]),
  label: z.string(),
  state: z.enum(["running", "done", "failed"]),
  /** 0..100 when known. */
  percent: z.number().nullable(),
  message: z.string().nullable(),
});
export type TaskProgress = z.infer<typeof taskProgress>;

export const realtimeEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("metrics.tick"), data: metricsTick }),
  z.object({ type: z.literal("console.line"), data: consoleLine }),
  z.object({ type: z.literal("status.changed"), data: statusChanged }),
  z.object({ type: z.literal("install.progress"), data: installProgress }),
  z.object({ type: z.literal("players.changed"), data: playersChanged }),
  z.object({ type: z.literal("task.progress"), data: taskProgress }),
]);
export type RealtimeEvent = z.infer<typeof realtimeEvent>;
export type RealtimeEventType = RealtimeEvent["type"];

/** Sent once per subscription so the client can render history immediately. */
export const serverSnapshot = z.object({
  serverId: z.string(),
  status: ServerStatus,
  players: z.array(z.string()),
  console: z.array(consoleLine),
  metrics: z.array(metricsTick),
  /** Background jobs still running, so a freshly opened page shows them. */
  tasks: z.array(taskProgress),
});
export type ServerSnapshot = z.infer<typeof serverSnapshot>;

export const serverMessage = z.union([
  realtimeEvent,
  z.object({ type: z.literal("snapshot"), data: serverSnapshot }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof serverMessage>;

/** Messages the browser sends over the WebSocket. */
export const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), serverId: z.string() }),
  z.object({ type: z.literal("unsubscribe"), serverId: z.string() }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * JVM memory beyond the heap: metaspace, JIT code cache, thread stacks, GC
 * bookkeeping, network buffers. Minecraft servers typically need 0.5-1.5 GB
 * on top of -Xmx; this estimate errs on the generous side.
 */
export function estimateJvmOverheadMb(heapMb: number): number {
  return Math.round(300 + heapMb * 0.1);
}

/** What the whole Java process is likely to use for a given heap. */
export function estimateProcessMemoryMb(heapMb: number): number {
  return heapMb + estimateJvmOverheadMb(heapMb);
}

/** Memory kept free for the operating system and everything else on the host. */
export const HOST_RESERVE_MB = 1024;

/**
 * Memory slider limits for a machine with `totalMb`: the heap plus Java's own
 * overhead must leave HOST_RESERVE_MB for everything else.
 */
export function heapLimits(totalMb: number) {
  let maxHeap = 512;
  while (estimateProcessMemoryMb(maxHeap + 512) <= totalMb - HOST_RESERVE_MB) maxHeap += 512;
  const maxMemMb = Math.max(1024, maxHeap);
  return {
    maxMemMb,
    defaultMemMb: Math.min(4096, Math.max(1024, Math.floor(totalMb / 4 / 512) * 512)),
  };
}

export type WorkloadKind = "vanilla" | "plugins" | "light-mods" | "modpack";

/** VPS memory sizes providers sell, in MB. */
const VPS_SIZES_MB = [2048, 4096, 8192, 12288, 16384, 24576, 32768, 49152, 65536];

/**
 * How big a VPS to rent: a heap for the players and kind of server, the
 * memory that heap needs with Java's overhead and the system's share, and
 * how many CPU cores. Minecraft ticks a world on one core, so single-core
 * speed matters more than the core count.
 */
export function recommendVps(players: number, kind: WorkloadKind) {
  const p = Math.max(1, Math.round(players));
  const base = p <= 10 ? 2048 : p <= 20 ? 3072 : p <= 40 ? 5120 : 7168;
  const heapMb =
    kind === "vanilla"
      ? base
      : kind === "plugins"
        ? base + 1024
        : kind === "light-mods"
          ? Math.max(4096, base + 2048)
          : Math.max(6144, base + 4096);
  const needed = estimateProcessMemoryMb(heapMb) + HOST_RESERVE_MB;
  const ramMb = VPS_SIZES_MB.find((s) => s >= needed) ?? needed;
  const vcpus = kind === "modpack" ? (p > 20 ? 8 : 4) : p > 20 || kind === "light-mods" ? 4 : 2;
  return { heapMb, ramMb, vcpus };
}

/**
 * Whether a VM or VPS size is big enough for recommendVps's answer. Providers
 * round memory a little differently, so a few percent short still counts.
 */
export function vpsFits(
  size: { memoryMb: number; vcpus: number },
  rec: { ramMb: number; vcpus: number },
): boolean {
  return size.memoryMb >= rec.ramMb * 0.94 && size.vcpus >= Math.min(rec.vcpus, 4);
}

// ---------------------------------------------------------------------------
// Network and security (M3)
// ---------------------------------------------------------------------------

export const hostIdInput = z.object({
  hostId: z.string().min(1),
  /** Search for the router and public address again instead of using the last result. */
  refresh: z.boolean().optional(),
});

export const setUpnpInput = serverIdInput.extend({ enabled: z.boolean() });

/** Check that players can reach the server: at the public IP (port forwarding) or through playit.gg. */
export const reachabilityInput = serverIdInput.extend({
  via: z.enum(["public", "playit"]),
});

export const setBedrockInput = serverIdInput.extend({ enabled: z.boolean() });

/** An ngrok authtoken or Cloudflare tunnel token (or the whole command it came in). */
export const tunnelTokenInput = z.object({ token: z.string().trim().min(10).max(4096) });
export const tunnelProviderInput = z.object({ provider: z.enum(["ngrok", "cloudflared"]) });
export const shareInput = serverIdInput.extend({ enabled: z.boolean() });
export const funnelInput = serverIdInput.extend({
  port: z.union([z.literal(443), z.literal(8443), z.literal(10000)]).nullable(),
});
export const playitCreateInput = serverIdInput.extend({ kind: z.enum(["java", "bedrock"]) });

export const securityFixInput = serverIdInput.extend({ checkId: z.string().min(1).max(64) });

/** One-click hardening: every automatic fix, plus optional recommended plugins. */
export const hardenInput = serverIdInput.extend({
  plugins: z.array(z.string().min(1).max(64)).max(10).default([]),
});

export type CheckStatus = "pass" | "warn" | "fail" | "info";
export type CheckSeverity = "critical" | "high" | "medium" | "low";

export interface SecurityCheck {
  id: string;
  title: string;
  status: CheckStatus;
  severity: CheckSeverity;
  /** One sentence: what is the case right now. */
  summary: string;
  /** Why it matters or what to do, when there is more to say. */
  detail: string | null;
  fix: {
    label: string;
    /** "admin": Windows asks for permission first. "host": changes the VPS itself over SSH. */
    kind: "auto" | "admin" | "host";
    /** Takes effect after a restart. */
    restart: boolean;
  } | null;
}

/** Points lost per check, by severity; warnings cost half. */
export const SEVERITY_WEIGHT: Record<CheckSeverity, number> = {
  critical: 40,
  high: 20,
  medium: 10,
  low: 4,
};

export function securityScore(checks: Array<Pick<SecurityCheck, "status" | "severity">>): number {
  let score = 100;
  for (const c of checks) {
    const w = SEVERITY_WEIGHT[c.severity];
    if (c.status === "fail") score -= w;
    else if (c.status === "warn") score -= w / 2;
  }
  return Math.max(0, Math.round(score));
}

export function securityGrade(score: number): "A" | "B" | "C" | "D" | "F" {
  return score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
}

// ---------------------------------------------------------------------------
// Remote hosts over SSH (M4)
// ---------------------------------------------------------------------------

export const hostNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-zA-Z0-9 _.()-]+$/, "Letters, numbers, spaces, dots, dashes and brackets only");

/** How to log in to a VPS the first time. Used once; the panel installs its own key. */
export const sshLoginInput = z.object({
  address: z
    .string()
    .trim()
    .min(1, "Enter the server's IP address")
    .max(253)
    .regex(/^[a-zA-Z0-9.:[\]-]+$/, "An IP address or host name, without http:// or a path"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/, "A Linux user name, e.g. root or ubuntu"),
  auth: z.discriminatedUnion("method", [
    z.object({ method: z.literal("password"), password: z.string().min(1).max(1024) }),
    z.object({
      method: z.literal("key"),
      privateKey: z.string().trim().min(40, "Paste the whole private key").max(32_768),
      passphrase: z.string().max(1024).optional(),
    }),
  ]),
  /** Only when the user is not root and sudo asks for a password. */
  sudoPassword: z.string().max(1024).optional(),
});
export type SshLoginInput = z.infer<typeof sshLoginInput>;

const fingerprintSchema = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "Unexpected fingerprint");

export const addHostInput = sshLoginInput.extend({
  name: hostNameSchema,
  /** The host key the user saw and accepted. */
  fingerprint: fingerprintSchema,
  firewall: z.boolean().default(true),
  fail2ban: z.boolean().default(true),
  autoUpdates: z.boolean().default(true),
});
export type AddHostInput = z.infer<typeof addHostInput>;

/** Run setup again; with a login when the panel's key is not installed yet or the host was reinstalled. */
export const retryHostInput = z.object({
  hostId: z.string().min(1),
  login: sshLoginInput.extend({ fingerprint: fingerprintSchema }).optional(),
});

export const removeHostInput = z.object({
  hostId: z.string().min(1),
  /** Remove the agent, its service account and the panel's key from the machine. */
  uninstall: z.boolean().default(true),
  /** Also delete worlds and backups left in the agent's data folder. */
  deleteData: z.boolean().default(false),
});

export const HostHardenAction = z.enum([
  "firewall",
  "fail2ban",
  "auto-updates",
  "password-login-off",
]);
export type HostHardenAction = z.infer<typeof HostHardenAction>;
export const hardenHostInput = z.object({ hostId: z.string().min(1), action: HostHardenAction });

export const renameHostInput = z.object({ hostId: z.string().min(1), name: hostNameSchema });

/** Move a server to another host with its world, settings, history and backups. */
export const moveServerInput = serverIdInput.extend({
  hostId: z.string().min(1),
  /** Game port on the new host; defaults to the current one. */
  port: z.number().int().min(1024).max(65535).optional(),
  /** Bring backups and version snapshots along (they can be large). */
  includeBackups: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Cloud providers (M5)
// ---------------------------------------------------------------------------

export const CloudProviderSupported = z.enum(["hetzner", "digitalocean", "vultr", "linode", "aws"]);
export type CloudProviderSupported = z.infer<typeof CloudProviderSupported>;

export const addCloudAccountInput = z.object({
  provider: CloudProviderSupported,
  label: z.string().trim().min(1).max(48),
  token: z.string().trim().min(10).max(512).optional(),
  accessKeyId: z
    .string()
    .trim()
    .regex(/^(AKIA|ASIA)[A-Z0-9]{12,}$/, "An AWS access key ID starts with AKIA")
    .optional(),
  secretAccessKey: z.string().trim().min(20).max(128).optional(),
  /** AWS: the region used for account-wide calls. */
  region: z.string().trim().max(32).optional(),
});
export type AddCloudAccountInput = z.infer<typeof addCloudAccountInput>;

export const cloudAccountInput = z.object({ accountId: z.string().min(1) });
export const cloudSizesInput = cloudAccountInput.extend({ region: z.string().min(1).max(64) });

/** A server to create on a host as soon as its setup finishes. */
export const pendingServerInput = createServerInput.omit({ hostId: true });
export type PendingServerInput = z.infer<typeof pendingServerInput>;

export const createCloudHostInput = cloudAccountInput.extend({
  region: z.string().min(1).max(64),
  size: z.string().min(1).max(64),
  name: hostNameSchema,
  firewall: z.boolean().default(true),
  fail2ban: z.boolean().default(true),
  autoUpdates: z.boolean().default(true),
  /** Create this Minecraft server on the VM once it is set up (New server → cloud). */
  server: pendingServerInput.optional(),
});
export type CreateCloudHostInput = z.infer<typeof createCloudHostInput>;

export const CloudResourceKind = z.enum([
  "vm",
  "snapshot",
  "firewall",
  "ssh-key",
  "volume",
  "ip",
  "tag",
]);

/**
 * Delete what cubehold made in these accounts: its cloud hosts (with the
 * servers on them) and anything it left behind. `others` are things it did
 * not make that the user picked one by one.
 */
export const cloudCleanupInput = z.object({
  accountIds: z.array(z.string().min(1)).min(1),
  others: z
    .array(
      z.object({ accountId: z.string().min(1), kind: CloudResourceKind, id: z.string().min(1) }),
    )
    .max(200)
    .default([]),
  /** Forget the accounts' tokens afterwards. */
  disconnect: z.boolean().default(false),
  confirm: z.literal(true),
});
export type CloudCleanupInput = z.infer<typeof cloudCleanupInput>;

/** Delete one thing the panel made but no longer uses (a leftover). */
export const cloudDeleteResourceInput = z.object({
  accountId: z.string().min(1),
  kind: CloudResourceKind,
  id: z.string().min(1),
});

export const cloudCostsInput = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .optional(),
  })
  .optional();

export const cloudPowerInput = z.object({
  hostId: z.string().min(1),
  action: z.enum(["start", "stop", "hibernate"]),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "cubehold_session";
export const SESSION_TTL_DAYS = 14;
export const LOCAL_HOST_ID = "local";
