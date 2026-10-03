import type { ServerSoftware } from "@cubehold/shared";
import { gcLogArgs } from "./memory.js";

/**
 * Aikar's flags, the community-standard G1GC tuning for Minecraft servers.
 * https://docs.papermc.io/paper/aikars-flags
 */
export function aikarFlags(memoryMb: number): string[] {
  const large = memoryMb >= 12 * 1024;
  return [
    "-XX:+UseG1GC",
    "-XX:+ParallelRefProcEnabled",
    "-XX:MaxGCPauseMillis=200",
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+DisableExplicitGC",
    "-XX:+AlwaysPreTouch",
    `-XX:G1NewSizePercent=${large ? 40 : 30}`,
    `-XX:G1MaxNewSizePercent=${large ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${large ? "16M" : "8M"}`,
    `-XX:G1ReservePercent=${large ? 15 : 20}`,
    "-XX:G1HeapWastePercent=5",
    "-XX:G1MixedGCCountTarget=4",
    `-XX:InitiatingHeapOccupancyPercent=${large ? 20 : 15}`,
    "-XX:G1MixedGCLiveThresholdPercent=90",
    "-XX:G1RSetUpdatingPauseTimePercent=5",
    "-XX:SurvivorRatio=32",
    "-XX:+PerfDisableSharedMem",
    "-XX:MaxTenuringThreshold=1",
    "-Dusing.aikars.flags=https://mcflags.emc.gs",
    "-Daikars.new.flags=true",
  ];
}

export interface LaunchSpec {
  software: ServerSoftware;
  memoryMb: number;
  jarFile: string;
  /** Vendor-recommended flags, used instead of Aikar's when provided. */
  recommendedJvmFlags?: string[] | null;
  extraJvmArgs?: string[];
  /** Java major version the server runs on; enables the GC log on 9+. */
  javaMajor?: number;
  /** Flags the panel adds for its own features (log4j fix, Geyser port); before the user's. */
  managedArgs?: string[];
  /** Forge/NeoForge 1.17+: launch through this args file (relative) instead of `-jar jarFile`. */
  argsFile?: string;
}

/** Build the java argument list (everything after the java executable). */
export function buildJavaArgs(spec: LaunchSpec): string[] {
  const flags =
    spec.recommendedJvmFlags && spec.recommendedJvmFlags.length > 0
      ? spec.recommendedJvmFlags
      : aikarFlags(spec.memoryMb);
  return [
    `-Xms${spec.memoryMb}M`,
    `-Xmx${spec.memoryMb}M`,
    ...flags,
    ...gcLogArgs(spec.javaMajor ?? 0),
    "-Dfile.encoding=UTF-8",
    "-Dterminal.jline=false",
    "-Dterminal.ansi=true",
    "-Dlog4j2.formatMsgNoLookups=true",
    ...(spec.managedArgs ?? []),
    ...(spec.extraJvmArgs ?? []),
    ...(spec.argsFile ? [`@${spec.argsFile}`] : ["-jar", spec.jarFile]),
    "--nogui",
  ];
}
