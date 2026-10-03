export { estimateJvmOverheadMb, estimateProcessMemoryMb } from "@cubehold/shared";

/** Relative to the server folder. The JVM cannot create directories, so the agent does. */
export const GC_LOG_FILE = ".cubehold/gc.log";

/**
 * JVM flags that write a small rotating GC log the agent reads for heap usage.
 * Unified logging exists from Java 9; older runtimes get no heap figure.
 * The path must stay relative: a Windows drive letter's colon would break
 * -Xlog's own colon-separated syntax.
 */
export function gcLogArgs(javaMajor: number): string[] {
  if (javaMajor < 9) return [];
  return [`-Xlog:gc:file=${GC_LOG_FILE}:uptime:filecount=2,filesize=1m`];
}

export interface HeapReading {
  /** Heap in use after the most recent collection. */
  usedMb: number;
  /** Heap the JVM has reserved from the OS, when the log states it. */
  committedMb: number | null;
}

const UNIT: Record<string, number> = { K: 1 / 1024, M: 1, G: 1024 };

/**
 * The latest heap reading from a GC log tail. Handles G1/Parallel/Serial
 * ("512M->128M(4096M)") and ZGC ("512M(12%)->128M(3%)").
 */
export function parseGcLog(text: string): HeapReading | null {
  const re = /(\d+)([KMG])(?:\(\d+%\))?->(\d+)([KMG])(?:\(\d+%\))?(?:\((\d+)([KMG])\))?/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return null;
  const used = Number(last[3]) * (UNIT[last[4] as string] ?? 1);
  const committed = last[5] ? Number(last[5]) * (UNIT[last[6] as string] ?? 1) : null;
  return {
    usedMb: Math.round(used),
    committedMb: committed === null ? null : Math.round(committed),
  };
}
