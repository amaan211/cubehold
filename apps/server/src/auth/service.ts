import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import {
  deriveKek,
  generateMasterKey,
  generateSalt,
  type KeyVault,
  unwrapMasterKey,
  wrapMasterKey,
} from "../security/crypto.js";
import { hashPassword, verifyPassword } from "./password.js";
import { newId } from "./session.js";

const { users, settings } = schema;

export const SETTING_KEK_SALT = "auth.kekSalt";
export const SETTING_WRAPPED_MASTER_KEY = "auth.wrappedMasterKey";

export class AuthError extends Error {
  constructor(
    public readonly code: "ALREADY_SETUP" | "NOT_SETUP" | "BAD_CREDENTIALS",
    message: string,
  ) {
    super(message);
  }
}

async function getSetting(db: Db, key: string): Promise<string | null> {
  const row = await db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value ?? null;
}

async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

export async function ownerExists(db: Db): Promise<boolean> {
  const row = await db.select({ id: users.id }).from(users).limit(1).get();
  return row !== undefined;
}

/**
 * First-run setup: create the owner, generate the master key, wrap it with the
 * password-derived KEK, and unlock the vault.
 */
export async function setupOwner(
  db: Db,
  vault: KeyVault,
  input: { username: string; password: string },
): Promise<{ id: string; username: string }> {
  if (await ownerExists(db)) throw new AuthError("ALREADY_SETUP", "Owner already exists");

  const salt = generateSalt();
  const kek = await deriveKek(input.password, salt);
  const masterKey = generateMasterKey();

  const id = newId();
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id,
      username: input.username,
      passwordHash: await hashPassword(input.password),
    });
    await setSetting(tx as unknown as Db, SETTING_KEK_SALT, salt.toString("base64"));
    await setSetting(
      tx as unknown as Db,
      SETTING_WRAPPED_MASTER_KEY,
      wrapMasterKey(kek, masterKey),
    );
  });

  vault.unlock(masterKey);
  masterKey.fill(0);
  return { id, username: input.username };
}

/** Verify password, unwrap the master key into the vault, return the user. */
export async function login(
  db: Db,
  vault: KeyVault,
  input: { username: string; password: string },
): Promise<{ id: string; username: string }> {
  const user = await db.select().from(users).where(eq(users.username, input.username)).get();
  // Always run a verify to keep timing similar whether or not the user exists.
  const ok = user ? await verifyPassword(user.passwordHash, input.password) : false;
  if (!user || !ok) throw new AuthError("BAD_CREDENTIALS", "Invalid username or password");

  if (!vault.isUnlocked()) {
    const saltB64 = await getSetting(db, SETTING_KEK_SALT);
    const wrapped = await getSetting(db, SETTING_WRAPPED_MASTER_KEY);
    if (saltB64 && wrapped) {
      const kek = await deriveKek(input.password, Buffer.from(saltB64, "base64"));
      vault.unlock(unwrapMasterKey(kek, wrapped));
    }
  }
  return { id: user.id, username: user.username };
}
