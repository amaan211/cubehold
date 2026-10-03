import type { ServerAutomation, ServerNotifications } from "@cubehold/shared";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { CloudMeta } from "../cloud/types.js";

export interface ServerSettings {
  /** Jar file name inside the server directory; for launch "argsFile", the folder of the args files. */
  jarFile?: string;
  /** Forge and NeoForge 1.17+ start through win_args.txt / unix_args.txt instead of a jar. */
  launch?: "jar" | "argsFile";
  /** The loader version a modpack requires; reinstalls keep it. */
  loaderVersion?: string;
  /** The modpack the server was created from. */
  modpack?: { name: string; version: string };
  /** Software build identifier (Paper build number, Fabric loader version). */
  build?: string | null;
  recommendedJvmFlags?: string[] | null;
  extraJvmArgs?: string[];
  /** Mirror of online-mode in server.properties, for list views. */
  onlineMode?: boolean;
  /** RCON the panel configures before every start; used for replies, TPS and players. */
  rcon?: { port: number; password: string };
  automation?: ServerAutomation;
  /** Automatic (scheduled, pre-restore) backups to keep. */
  backupKeep?: number;
  /** Keep router port forwards (UPnP) for this server's ports. */
  upnp?: boolean;
  /** Share through the host's ngrok agent (a TCP endpoint). */
  ngrok?: boolean;
  /** UDP port Geyser listens on for Bedrock players; unique per host, from 19132. */
  bedrockPort?: number | null;
  /** Discord webhook and the events it hears about. */
  notifications?: ServerNotifications;
}

export interface CrashRecord {
  at: string;
  code: number | null;
  reason: string | null;
  /** Crash report relative to the server folder, when one was written. */
  report: string | null;
  /** Set when the agent restarted the server by itself. */
  restartInMs: number | null;
  /** What analyzeCrash made of the report or the last console lines. */
  analysis?: {
    cause: string;
    title: string;
    hint: string;
    suspects: string[];
    exception: string | null;
  };
}

export interface ServerMeta {
  installError?: string | null;
  versionChangeError?: string | null;
  versionHistory?: Array<{ from: string; to: string; at: string }>;
  /** Set while a delete is in progress; hides the server from lists. */
  deletingSince?: string | null;
  lastExitCode?: number | null;
  lastExitReason?: string | null;
  lastStartedAt?: string | null;
  lastStoppedAt?: string | null;
  /** Newest last, at most 20. */
  crashes?: CrashRecord[];
}

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
};

/** Single owner account (multi-user is a later milestone). */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  ...timestamps,
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** sha256 of the cookie token; the raw token is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: text("expires_at").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Key/value settings, including the wrapped master key. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamps.updatedAt,
});

/** Cloud / hosting credentials, encrypted with the master key (AES-256-GCM). */
export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  label: text("label").notNull(),
  /** JSON payload encrypted; format: base64(iv).base64(tag).base64(ciphertext) */
  encrypted: text("encrypted").notNull(),
  ...timestamps,
});

export const hosts = sqliteTable("hosts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // local | ssh | cloud
  provider: text("provider"), // CloudProviderId when kind = cloud
  providerRef: text("provider_ref"), // instance id on the provider
  credentialId: text("credential_id").references(() => credentials.id, { onDelete: "set null" }),
  publicIp: text("public_ip"),
  sshUser: text("ssh_user"),
  sshPort: integer("ssh_port"),
  sshKeyId: text("ssh_key_id"),
  agentToken: text("agent_token"),
  status: text("status").notNull().default("unknown"),
  meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
  /** Cloud hosts: VM, firewall, power and usage. Written only by the cloud service. */
  cloud: text("cloud", { mode: "json" }).$type<CloudMeta>(),
  ...timestamps,
});

export const servers = sqliteTable(
  "servers",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    software: text("software").notNull(),
    mcVersion: text("mc_version").notNull(),
    javaVersion: integer("java_version").notNull(),
    memoryMb: integer("memory_mb").notNull(),
    port: integer("port").notNull(),
    status: text("status").notNull().default("stopped"),
    /** Path of the server directory on its host. */
    directory: text("directory").notNull(),
    settings: text("settings", { mode: "json" }).$type<ServerSettings>(),
    /** Runtime bookkeeping: last exit code, install errors and the like. */
    meta: text("meta", { mode: "json" }).$type<ServerMeta>(),
    ...timestamps,
  },
  (t) => [index("servers_host_idx").on(t.hostId)],
);

export const backups = sqliteTable(
  "backups",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    label: text("label"),
    /** Size of the zip. */
    sizeBytes: integer("size_bytes"),
    /** Absolute path of the zip on the server's host. */
    path: text("path").notNull(),
    kind: text("kind").notNull().default("manual"), // BackupKind
    scope: text("scope").notNull().default("full"), // BackupScope
    state: text("state").notNull().default("ready"), // BackupState
    error: text("error"),
    fileCount: integer("file_count"),
    mcVersion: text("mc_version"),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("backups_server_idx").on(t.serverId)],
);

export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    action: text("action").notNull(), // ScheduleAction
    payload: text("payload"),
    warnSeconds: integer("warn_seconds"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastRunAt: text("last_run_at"),
    lastResult: text("last_result"), // ok | skipped | failed
    lastMessage: text("last_message"),
    ...timestamps,
  },
  (t) => [index("schedules_server_idx").on(t.serverId)],
);

/** One stay of a player on a server, from join to leave. Feeds history and playtime. */
export const playerSessions = sqliteTable(
  "player_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    joinedAt: text("joined_at").notNull(),
    /** Null while the player is online. */
    leftAt: text("left_at"),
  },
  (t) => [index("player_sessions_server_name_idx").on(t.serverId, t.name)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id"),
    action: text("action").notNull(),
    target: text("target"),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);
