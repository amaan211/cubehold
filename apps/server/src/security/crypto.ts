/**
 * Credential encryption.
 *
 * Design:
 *  - A random 32-byte MASTER KEY encrypts every stored credential (AES-256-GCM).
 *  - The master key is itself wrapped with a KEY-ENCRYPTION KEY derived from the
 *    owner's password via argon2id. Changing the password only re-wraps the master
 *    key; stored credentials never need re-encrypting.
 *  - The unwrapped master key lives in memory only while the owner is logged in,
 *    or is supplied via CUBEHOLD_MASTER_KEY for unattended boots.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export function generateMasterKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function generateSalt(): Buffer {
  return randomBytes(16);
}

/** Derive a 32-byte key-encryption key from a password with argon2id. */
export async function deriveKek(password: string, salt: Buffer): Promise<Buffer> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    salt,
    raw: true,
    hashLength: KEY_BYTES,
    memoryCost: 64 * 1024, // 64 MiB
    timeCost: 3,
    parallelism: 1,
  });
}

/** Encrypt bytes with AES-256-GCM. Output: base64(iv).base64(tag).base64(ciphertext) */
export function encrypt(key: Buffer, plaintext: Buffer | string, aad?: string): string {
  if (key.length !== KEY_BYTES) throw new Error("encrypt: key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

export function decrypt(key: Buffer, payload: string, aad?: string): Buffer {
  if (key.length !== KEY_BYTES) throw new Error("decrypt: key must be 32 bytes");
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("decrypt: malformed payload");
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
}

export function encryptJson(key: Buffer, value: unknown, aad?: string): string {
  return encrypt(key, JSON.stringify(value), aad);
}

export function decryptJson<T = unknown>(key: Buffer, payload: string, aad?: string): T {
  return JSON.parse(decrypt(key, payload, aad).toString("utf8")) as T;
}

/** Wrap the master key with the password-derived KEK. */
export function wrapMasterKey(kek: Buffer, masterKey: Buffer): string {
  return encrypt(kek, masterKey, "master-key");
}

export function unwrapMasterKey(kek: Buffer, wrapped: string): Buffer {
  const key = decrypt(kek, wrapped, "master-key");
  if (key.length !== KEY_BYTES) throw new Error("unwrapped master key has wrong length");
  return key;
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Holds the unwrapped master key in memory for the lifetime of a login.
 * Callers that need to read credentials must check `isUnlocked()` first.
 */
export class KeyVault {
  #key: Buffer | null = null;
  #onUnlock = new Set<() => void>();

  constructor(initial?: Buffer) {
    if (initial) this.#key = Buffer.from(initial);
  }

  isUnlocked(): boolean {
    return this.#key !== null;
  }

  unlock(key: Buffer): void {
    if (key.length !== KEY_BYTES) throw new Error("master key must be 32 bytes");
    const wasLocked = this.#key === null;
    this.#key = Buffer.from(key);
    if (wasLocked) {
      for (const fn of this.#onUnlock) {
        try {
          fn();
        } catch (err) {
          console.error("vault unlock listener failed", err);
        }
      }
    }
  }

  /** Run when the vault goes from locked to unlocked (the owner logged in). */
  onUnlock(fn: () => void): () => void {
    this.#onUnlock.add(fn);
    return () => this.#onUnlock.delete(fn);
  }

  lock(): void {
    if (this.#key) this.#key.fill(0);
    this.#key = null;
  }

  /** Throws if locked. */
  key(): Buffer {
    if (!this.#key) throw new Error("credential store is locked; log in to unlock");
    return this.#key;
  }
}
