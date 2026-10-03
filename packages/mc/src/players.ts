import { createHash } from "node:crypto";
import { fetchJson, HttpError } from "./http.js";

export const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

export function isValidPlayerName(name: string): boolean {
  return PLAYER_NAME.test(name);
}

export function isValidIp(ip: string): boolean {
  const v4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  return v4.test(ip) || (/^[0-9a-f:]+$/i.test(ip) && ip.includes(":"));
}

/** Dashed UUID from 32 hex characters. */
export function dashUuid(hex: string): string {
  const h = hex.replace(/-/g, "").toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The UUID an offline-mode server assigns: a name-based (v3) UUID of
 * "OfflinePlayer:<name>", as in Java's UUID.nameUUIDFromBytes.
 */
export function offlineUuid(name: string): string {
  const md5 = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
  md5[6] = ((md5[6] as number) & 0x0f) | 0x30;
  md5[8] = ((md5[8] as number) & 0x3f) | 0x80;
  return dashUuid(md5.toString("hex"));
}

/** Look up a Microsoft account's UUID and exact name. Null when no such account exists. */
export async function lookupPlayer(name: string): Promise<{ uuid: string; name: string } | null> {
  try {
    const res = await fetchJson<{ id: string; name: string }>(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
    );
    return { uuid: dashUuid(res.id), name: res.name };
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 204)) return null;
    throw err;
  }
}

/** Timestamp format Minecraft uses in ban lists: "2026-09-28 14:03:12 +0000". */
export function banDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

// Shapes of the JSON lists a server keeps next to server.properties.
export interface OpEntry {
  uuid: string;
  name: string;
  level: number;
  bypassesPlayerLimit: boolean;
}
export interface WhitelistEntry {
  uuid: string;
  name: string;
}
export interface BanEntry {
  uuid: string;
  name: string;
  created: string;
  source: string;
  expires: string;
  reason: string;
}
export interface IpBanEntry {
  ip: string;
  created: string;
  source: string;
  expires: string;
  reason: string;
}
export interface UsercacheEntry {
  name: string;
  uuid: string;
  expiresOn: string;
}

export const PLAYER_LIST_FILES = {
  ops: "ops.json",
  whitelist: "whitelist.json",
  bans: "banned-players.json",
  ipBans: "banned-ips.json",
  usercache: "usercache.json",
} as const;
