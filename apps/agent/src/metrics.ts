import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessSample {
  pid: number;
  /** Cumulative CPU seconds consumed by the process. */
  cpuSeconds: number;
  rssBytes: number;
}

export interface ProcessUsage {
  pid: number;
  /** Percent of the whole machine (0..100), averaged since the previous sample. */
  cpuPercent: number;
  memRssMb: number;
}

/**
 * Cross-platform process sampler without native modules.
 *  - Windows: one long-lived PowerShell that answers `Get-Process` queries.
 *    (wmic, which older libraries rely on, is no longer shipped.)
 *  - Linux: /proc/<pid>/stat and statm.
 *  - macOS: `ps`.
 */
export class ProcessSampler {
  #prev = new Map<number, { at: number; cpuSeconds: number }>();
  #ps: ChildProcess | null = null;
  #psQueue: Array<(lines: string[]) => void> = [];
  #psBuffer: string[] = [];
  readonly #ncpu = Math.max(1, os.cpus().length);

  async sample(pids: number[]): Promise<ProcessUsage[]> {
    if (pids.length === 0) return [];
    let samples: ProcessSample[];
    switch (process.platform) {
      case "win32":
        samples = await this.#sampleWindows(pids);
        break;
      case "linux":
        samples = await this.#sampleLinux(pids);
        break;
      default:
        samples = await this.#sampleDarwin(pids);
    }
    const now = Date.now();
    const out: ProcessUsage[] = [];
    for (const s of samples) {
      const prev = this.#prev.get(s.pid);
      let cpuPercent = 0;
      if (prev && now > prev.at) {
        const dCpu = Math.max(0, s.cpuSeconds - prev.cpuSeconds);
        const dWall = (now - prev.at) / 1000;
        cpuPercent = Math.min(100, (dCpu / dWall / this.#ncpu) * 100);
      }
      this.#prev.set(s.pid, { at: now, cpuSeconds: s.cpuSeconds });
      out.push({ pid: s.pid, cpuPercent, memRssMb: s.rssBytes / 1024 / 1024 });
    }
    for (const pid of [...this.#prev.keys()]) if (!pids.includes(pid)) this.#prev.delete(pid);
    return out;
  }

  dispose(): void {
    this.#ps?.kill();
    this.#ps = null;
    this.#prev.clear();
  }

  // --- Windows -------------------------------------------------------------

  #ensurePowerShell(): ChildProcess {
    if (this.#ps && this.#ps.exitCode === null) return this.#ps;
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const rl = readline.createInterface({ input: ps.stdout as NodeJS.ReadableStream });
    rl.on("line", (line) => {
      if (line.trim() === "<<END>>") {
        const lines = this.#psBuffer;
        this.#psBuffer = [];
        this.#psQueue.shift()?.(lines);
      } else if (line.trim() !== "") {
        this.#psBuffer.push(line.trim());
      }
    });
    ps.on("exit", () => {
      this.#ps = null;
      for (const resolve of this.#psQueue.splice(0)) resolve([]);
    });
    this.#ps = ps;
    return ps;
  }

  async #sampleWindows(pids: number[]): Promise<ProcessSample[]> {
    const ps = this.#ensurePowerShell();
    const cmd = `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.CPU) $($_.WorkingSet64)" }; "<<END>>"\n`;
    const lines = await new Promise<string[]>((resolve) => {
      this.#psQueue.push(resolve);
      ps.stdin?.write(cmd);
    });
    const out: ProcessSample[] = [];
    for (const l of lines) {
      const [pid, cpu, rss] = l.split(/\s+/);
      if (!pid || !cpu || !rss) continue;
      out.push({ pid: Number(pid), cpuSeconds: Number(cpu) || 0, rssBytes: Number(rss) || 0 });
    }
    return out;
  }

  // --- Linux ---------------------------------------------------------------

  async #sampleLinux(pids: number[]): Promise<ProcessSample[]> {
    const clk = 100; // CLK_TCK is 100 on every mainstream distro
    const page = 4096;
    const out: ProcessSample[] = [];
    for (const pid of pids) {
      try {
        const stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf8");
        // comm can contain spaces; fields start after the closing paren.
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const utime = Number(rest[11]);
        const stime = Number(rest[12]);
        const statm = await fs.promises.readFile(`/proc/${pid}/statm`, "utf8");
        const resident = Number(statm.split(" ")[1]);
        out.push({ pid, cpuSeconds: (utime + stime) / clk, rssBytes: resident * page });
      } catch {
        // process gone
      }
    }
    return out;
  }

  // --- macOS / other unix --------------------------------------------------

  async #sampleDarwin(pids: number[]): Promise<ProcessSample[]> {
    try {
      const { stdout } = await execFileAsync("ps", [
        "-o",
        "pid=,cputime=,rss=",
        "-p",
        pids.join(","),
      ]);
      const out: ProcessSample[] = [];
      for (const line of stdout.split("\n")) {
        const [pid, cputime, rss] = line.trim().split(/\s+/);
        if (!pid || !cputime || !rss) continue;
        out.push({
          pid: Number(pid),
          cpuSeconds: parseCpuTime(cputime),
          rssBytes: Number(rss) * 1024,
        });
      }
      return out;
    } catch {
      return [];
    }
  }
}

/** "MM:SS.ss" or "HH:MM:SS" or "D-HH:MM:SS" -> seconds */
function parseCpuTime(s: string): number {
  let days = 0;
  let rest = s;
  if (rest.includes("-")) {
    const [d, r] = rest.split("-");
    days = Number(d);
    rest = r ?? "0";
  }
  const parts = rest.split(":").map(Number);
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  return days * 86400 + seconds;
}
