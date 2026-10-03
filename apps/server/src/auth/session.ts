import { createHash, randomBytes } from "node:crypto";
import { SESSION_TTL_DAYS } from "@cubehold/shared";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";

const { sessions, users } = schema;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newId(): string {
  return randomBytes(12).toString("base64url");
}

export interface SessionUser {
  id: string;
  username: string;
}

export async function createSession(
  db: Db,
  userId: string,
  meta: { userAgent?: string | undefined; ip?: string | undefined },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({
    id: newId(),
    userId,
    tokenHash: hashToken(token),
    expiresAt: expiresAt.toISOString(),
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
  });
  return { token, expiresAt };
}

export async function resolveSession(db: Db, token: string): Promise<SessionUser | null> {
  const now = new Date().toISOString();
  const row = await db
    .select({ id: users.id, username: users.username })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
    .get();
  return row ?? null;
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function purgeExpiredSessions(db: Db): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString()));
}
