import { describe, expect, it } from "vitest";
import {
  decrypt,
  decryptJson,
  deriveKek,
  encrypt,
  encryptJson,
  generateMasterKey,
  generateSalt,
  KeyVault,
  unwrapMasterKey,
  wrapMasterKey,
} from "./crypto.js";

describe("crypto", () => {
  it("round-trips bytes and strings", () => {
    const key = generateMasterKey();
    const payload = encrypt(key, "hello world");
    expect(payload.split(".")).toHaveLength(3);
    expect(decrypt(key, payload).toString("utf8")).toBe("hello world");
  });

  it("round-trips JSON with AAD", () => {
    const key = generateMasterKey();
    const value = { token: "abc", region: "eu-central", n: 3 };
    const payload = encryptJson(key, value, "credential:1");
    expect(decryptJson(key, payload, "credential:1")).toEqual(value);
  });

  it("rejects tampering, wrong key and wrong AAD", () => {
    const key = generateMasterKey();
    const other = generateMasterKey();
    const payload = encrypt(key, "secret", "a");
    expect(() => decrypt(other, payload, "a")).toThrow();
    expect(() => decrypt(key, payload, "b")).toThrow();
    const [iv, tag, ct] = payload.split(".") as [string, string, string];
    const flipped = Buffer.from(ct, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() => decrypt(key, `${iv}.${tag}.${flipped.toString("base64")}`, "a")).toThrow();
  });

  it("produces distinct ciphertexts for the same plaintext", () => {
    const key = generateMasterKey();
    expect(encrypt(key, "x")).not.toBe(encrypt(key, "x"));
  });

  it("wraps and unwraps the master key with a password-derived KEK", async () => {
    const salt = generateSalt();
    const kek = await deriveKek("correct horse battery staple", salt);
    const master = generateMasterKey();
    const wrapped = wrapMasterKey(kek, master);
    expect(unwrapMasterKey(kek, wrapped).equals(master)).toBe(true);

    const wrongKek = await deriveKek("wrong password", salt);
    expect(() => unwrapMasterKey(wrongKek, wrapped)).toThrow();
  });

  it("KeyVault locks and unlocks", () => {
    const vault = new KeyVault();
    expect(vault.isUnlocked()).toBe(false);
    expect(() => vault.key()).toThrow(/locked/);
    const k = generateMasterKey();
    vault.unlock(k);
    expect(vault.isUnlocked()).toBe(true);
    expect(vault.key().equals(k)).toBe(true);
    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
  });
});
