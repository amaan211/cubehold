import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { config } from "../config.js";
import { distFile } from "../dist.js";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(dbPath = config.dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const client = createClient({ url: pathToFileURL(dbPath).href });
  return drizzle(client, { schema });
}

export async function initDb(db: Db) {
  await db.run("PRAGMA journal_mode = WAL");
  await db.run("PRAGMA foreign_keys = ON");
  await db.run("PRAGMA busy_timeout = 5000");
  const here = path.dirname(fileURLToPath(import.meta.url));
  // From source: apps/server/src/db -> apps/server/drizzle. A release ships drizzle/ next to server.mjs.
  const migrationsFolder = distFile("drizzle") ?? path.resolve(here, "../../drizzle");
  await migrate(db, { migrationsFolder });
}

export { schema };
