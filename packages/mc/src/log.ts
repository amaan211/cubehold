/**
 * Parse Minecraft server log lines into events. Handles both the vanilla
 * format `[12:00:00] [Server thread/INFO]: msg` and Paper's `[12:00:00 INFO]: msg`.
 */

export type LogEvent =
  | { type: "done"; seconds: number | null }
  | { type: "join"; player: string }
  | { type: "leave"; player: string }
  | { type: "stopping" }
  | { type: "eula" }
  | { type: "port_in_use" }
  | { type: "outdated_java"; message: string }
  | { type: "crash"; message: string }
  | { type: "tps"; values: number[] };

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the point
const ANSI = /\x1b\[[0-9;]*m/g;
const PREFIX = /^\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]?(?: \[[^\]]*\])?(?: [A-Z]+)?\]?:? ?/;
/**
 * Bracket groups up to the first "]: ":
 *   [12:00:00] [Server thread/INFO]: …                              vanilla, Fabric
 *   [12:00:00 INFO]: …                                              Paper, Purpur
 *   [12:00:00] [Server thread/INFO] [minecraft/DedicatedServer]: …  Forge, NeoForge
 * A message that itself starts with brackets ("[Not Secure] <Steve> hi") keeps them.
 */
const PREFIX_GROUPS = /^\[\d{2}:\d{2}:\d{2}[^\]]*\](?: ?\[[^\]]*\])*?: /;

/** Strip the timestamp / thread / level prefix, returning the message body. */
export function stripPrefix(line: string): string {
  const clean = line.replace(ANSI, "");
  const m = PREFIX_GROUPS.exec(clean);
  return (m ? clean.slice(m[0].length) : clean.replace(PREFIX, "")).trim();
}

const DONE = /^Done \(([\d.]+)s\)!/;
const JOIN = /^([A-Za-z0-9_.]{1,32}) joined the game$/;
const LEAVE = /^([A-Za-z0-9_.]{1,32}) (?:left the game$|lost connection:)/;
const OUTDATED_JAVA =
  /UnsupportedClassVersionError|has been compiled by a more recent version of the Java Runtime|requires (running the server with )?Java (\d+)/i;
const CRASH =
  /Encountered an unexpected exception|This crash report has been saved to|Exception in thread "main"|OutOfMemoryError/;
const TPS = /TPS from last (?:1m, 5m, 15m|5s, 10s, 1m, 5m, 15m): (.+)$/;

export function parseLogLine(line: string): LogEvent | null {
  const msg = stripPrefix(line);
  if (msg === "") return null;

  const done = DONE.exec(msg);
  if (done) return { type: "done", seconds: Number(done[1]) };
  if (/^Done!?/.test(msg) && /For help, type/.test(msg)) return { type: "done", seconds: null };

  const join = JOIN.exec(msg);
  if (join) return { type: "join", player: join[1] as string };
  const leave = LEAVE.exec(msg);
  if (leave) return { type: "leave", player: leave[1] as string };

  if (/^Stopping (the )?server/.test(msg)) return { type: "stopping" };
  if (/You need to agree to the EULA/i.test(msg)) return { type: "eula" };
  if (/FAILED TO BIND TO PORT|Address already in use/i.test(msg)) return { type: "port_in_use" };
  if (OUTDATED_JAVA.test(msg)) return { type: "outdated_java", message: msg };
  if (CRASH.test(msg)) return { type: "crash", message: msg };

  // Paper "tps" output: TPS from last 1m, 5m, 15m: *20.0, 20.0, 20.0
  const tps = TPS.exec(msg);
  if (tps) {
    const values = (tps[1] as string)
      .split(",")
      .map((s) => Number.parseFloat(s.replace(/[^\d.]/g, "")))
      .filter((n) => Number.isFinite(n));
    if (values.length) return { type: "tps", values };
  }
  return null;
}
