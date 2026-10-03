import path from "node:path";
import { z } from "zod";
import { defaultDataDir, isDist } from "./dist.js";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default(isDist ? "production" : "development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Directory for the SQLite DB, servers, backups and downloaded JDKs. */
  DATA_DIR: z
    .string()
    .default(defaultDataDir())
    .transform((d) => path.resolve(d)),
  /** Optional hex-encoded 32-byte master key for unattended boots. */
  CUBEHOLD_MASTER_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "CUBEHOLD_MASTER_KEY must be 64 hex characters")
    .optional(),
  /**
   * "daemon" (default): the panel starts the local agent as a detached process.
   * "external": a service manager runs it (the Docker image's agent container);
   * the panel only connects, using the state file the agent writes to DATA_DIR.
   */
  CUBEHOLD_AGENT: z.enum(["daemon", "external"]).default("daemon"),
  /** External agent only: its address when it is not on this machine's loopback. */
  CUBEHOLD_AGENT_HOST: z.string().default("127.0.0.1"),
  /** The built web app to serve; a release build finds its own. */
  CUBEHOLD_WEB_DIR: z.string().optional(),
  /** Tests only: path of a module whose deps() replaces the cloud providers' APIs. */
  CUBEHOLD_FAKE_CLOUD: z.string().optional(),
  /** Set to "true" when served over HTTPS so cookies are marked Secure. */
  SECURE_COOKIES: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = {
  ...parsed.data,
  isDev: parsed.data.NODE_ENV === "development",
  isProduction: parsed.data.NODE_ENV === "production",
  dbPath: path.join(parsed.data.DATA_DIR, "cubehold.db"),
  serversDir: path.join(parsed.data.DATA_DIR, "servers"),
  backupsDir: path.join(parsed.data.DATA_DIR, "backups"),
  javaDir: path.join(parsed.data.DATA_DIR, "java"),
  /** Game textures per Minecraft version, for drawing inventories. */
  assetsDir: path.join(parsed.data.DATA_DIR, "assets"),
};

export type Config = typeof config;
