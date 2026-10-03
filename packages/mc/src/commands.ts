import type { ServerSoftware } from "@cubehold/shared";

/**
 * Parsers for the text Minecraft sends back over RCON. Responses may contain
 * § colour codes and, depending on the version, be joined with or without
 * newlines, so every parser works on the whole text.
 */

const COLOR = /§[0-9a-fk-orx]/gi;

export function stripColors(text: string): string {
  return text.replace(COLOR, "");
}

export interface TickStats {
  tps: number | null;
  mspt: number | null;
}

/**
 * The command that reports tick performance, or null when the server has none.
 * Paper and its forks have `tps` (and `mspt`); vanilla-based servers gained
 * `tick query` in 1.20.3.
 */
export function tpsCommandFor(
  software: ServerSoftware,
  mcVersion: string,
): "tps" | "tick query" | null {
  if (software === "paper" || software === "purpur") return "tps";
  return supportsTickQuery(mcVersion) ? "tick query" : null;
}

function supportsTickQuery(mcVersion: string): boolean {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(mcVersion);
  if (!m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (major > 1) return true; // 26.x and later
  if (minor !== 20) return minor > 20;
  return patch >= 3;
}

/** Paper `tps`: "TPS from last 1m, 5m, 15m: 20.0, 19.98, 20.0" → the 1-minute value. */
export function parseTpsOutput(text: string): number | null {
  const m = /TPS from last [^:]+:\s*([^\n]+)/i.exec(stripColors(text));
  if (!m) return null;
  const first = (m[1] as string).split(",")[0] ?? "";
  const n = Number.parseFloat(first.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? Math.min(20, n) : null;
}

/** Paper `mspt`: "Server tick times (avg/min/max) from last 5s, 10s, 1m:\n◴ 1.2/0.8/5.3, ..." → 5s average. */
export function parseMsptOutput(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)\/\d+(?:\.\d+)?\/\d+(?:\.\d+)?/.exec(stripColors(text));
  if (!m) return null;
  const n = Number.parseFloat(m[1] as string);
  return Number.isFinite(n) ? n : null;
}

/**
 * Vanilla `tick query`: "Target tick rate: 20.0 per second. Average time per
 * tick: 2.3ms (Target: 50.0ms)". TPS is the target rate unless ticks take
 * longer than their budget.
 */
export function parseTickQuery(text: string): TickStats {
  const plain = stripColors(text);
  const rate = /Target tick rate:\s*([\d.]+)/i.exec(plain);
  const avg = /Average time per tick:\s*([\d.]+)\s*ms/i.exec(plain);
  const target = rate ? Number.parseFloat(rate[1] as string) : 20;
  const mspt = avg ? Number.parseFloat(avg[1] as string) : null;
  if (mspt === null || !Number.isFinite(mspt)) return { tps: null, mspt: null };
  const tps = mspt <= 1000 / target ? target : 1000 / mspt;
  return { tps: Math.round(tps * 100) / 100, mspt: Math.round(mspt * 100) / 100 };
}

export interface ListOutput {
  online: number;
  max: number;
  players: string[];
}

/** `list`: "There are 2 of a max of 20 players online: Alex, Steve". */
export function parseListOutput(text: string): ListOutput | null {
  const m =
    /There are (\d+) (?:of a max(?: of)?|out of maximum) (\d+) players online[.:]?\s*(.*)$/is.exec(
      stripColors(text).trim(),
    );
  if (!m) return null;
  const players = (m[3] as string)
    .split(/[,\n]/)
    .map((s) => s.replace(/^[^:]*:\s*/, "").trim()) // Bukkit groups: "default: Alex"
    .filter((s) => /^[A-Za-z0-9_.]{1,32}$/.test(s));
  return { online: Number(m[1]), max: Number(m[2]), players };
}
