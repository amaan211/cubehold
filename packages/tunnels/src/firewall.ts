import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Windows Defender Firewall, read without admin rights through the
 * HNetCfg.FwPolicy2 COM object (fast: all rules in well under a second),
 * and changed through one elevated PowerShell run (a UAC prompt).
 *
 * The usual trouble on a home PC: the first time Java listens, Windows asks
 * whether to allow it. "Allow" creates rules that open every port for that
 * java.exe (the game port, but also RCON and anything a plugin opens);
 * "Cancel" creates block rules, and block rules beat allow rules, so
 * nobody can connect until they are removed.
 */

const PROFILE = { domain: 1, private: 2, public: 4 } as const;
export type ProfileName = keyof typeof PROFILE;

export interface FirewallRule {
  name: string;
  /** Program path, or null when the rule covers every program. */
  program: string | null;
  /** 6 = TCP, 17 = UDP, 256 = any. */
  protocol: number;
  /** "*", or a list like "25565,19132-19133". */
  localPorts: string;
  action: "allow" | "block";
  /** Bit mask of profiles (1 domain, 2 private, 4 public). */
  profiles: number;
  remoteAddresses: string;
  group: string | null;
}

export interface FirewallSnapshot {
  /** Profiles in force right now (bit mask). */
  currentProfiles: number;
  profiles: Array<{ name: ProfileName; enabled: boolean; blockInbound: boolean }>;
  /** Inbound, enabled rules for any program or one of the programs asked about. */
  rules: FirewallRule[];
  /** Connected networks and how Windows classifies them. */
  networks: Array<{ name: string; adapter: string; category: string }>;
}

export interface InboundVerdict {
  allowed: boolean;
  because: "firewall-off" | "allow-rule" | "block-rule" | "no-rule";
  rule: string | null;
  /** The allowing rule opens every port for this program. */
  programWide: boolean;
}

// --- reading -------------------------------------------------------------------------

/** Inbound rules that could apply to these programs. Windows only. */
export async function readWindowsFirewall(programs: string[]): Promise<FirewallSnapshot> {
  if (process.platform !== "win32") throw new Error("Windows Firewall only exists on Windows");
  const wanted = programs.map((p) => p.toLowerCase());
  const script = `
$ErrorActionPreference = 'Stop'
$wanted = ConvertFrom-Json '${psQuote(JSON.stringify(wanted))}'
$fw = New-Object -ComObject HNetCfg.FwPolicy2
$rules = @()
foreach ($r in $fw.Rules) {
  if ($r.Direction -ne 1 -or -not $r.Enabled) { continue }
  if ($r.ServiceName -and $r.ServiceName -ne '*') { continue }
  $app = $r.ApplicationName
  if ($app -and -not ($wanted -contains $app.ToLower())) { continue }
  $rules += @{ name = $r.Name; program = $app; protocol = $r.Protocol; localPorts = $r.LocalPorts; action = $r.Action; profiles = $r.Profiles; remoteAddresses = $r.RemoteAddresses; group = $r.Grouping }
}
$profiles = @()
foreach ($t in 1,2,4) { $profiles += @{ type = $t; enabled = $fw.FirewallEnabled($t); inbound = $fw.DefaultInboundAction($t) } }
$networks = @()
try { foreach ($n in Get-NetConnectionProfile) { $networks += @{ name = $n.Name; adapter = $n.InterfaceAlias; category = [string]$n.NetworkCategory } } } catch {}
@{ current = $fw.CurrentProfileTypes; profiles = $profiles; rules = $rules; networks = $networks } | ConvertTo-Json -Depth 4 -Compress
`;
  const out = await powershell(script, 30_000);
  const raw = JSON.parse(out) as {
    current: number;
    profiles: Array<{ type: number; enabled: boolean; inbound: number }>;
    rules: Array<{
      name: string;
      program: string | null;
      protocol: number;
      localPorts: string | null;
      action: number;
      profiles: number;
      remoteAddresses: string | null;
      group: string | null;
    }>;
    networks: Array<{ name: string; adapter: string; category: string }>;
  };
  const names = Object.fromEntries(Object.entries(PROFILE).map(([k, v]) => [v, k])) as Record<
    number,
    ProfileName
  >;
  return {
    currentProfiles: raw.current,
    profiles: raw.profiles.map((p) => ({
      name: names[p.type] ?? "public",
      enabled: p.enabled,
      blockInbound: p.inbound === 0,
    })),
    rules: raw.rules.map((r) => ({
      name: r.name,
      program: r.program || null,
      protocol: r.protocol,
      localPorts: r.localPorts || "*",
      action: r.action === 1 ? "allow" : "block",
      profiles: r.profiles,
      remoteAddresses: r.remoteAddresses || "*",
      group: r.group || null,
    })),
    networks: raw.networks ?? [],
  };
}

// --- evaluating -----------------------------------------------------------------------

export function portListMatches(list: string, port: number): boolean {
  if (list.trim() === "*") return true;
  return list.split(",").some((part) => {
    const p = part.trim();
    const range = /^(\d+)-(\d+)$/.exec(p);
    if (range) return port >= Number(range[1]) && port <= Number(range[2]);
    return /^\d+$/.test(p) && Number(p) === port;
  });
}

function sameProgram(a: string, b: string): boolean {
  return path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
}

/**
 * Would Windows let a connection in to `program` on this port? Block rules
 * win over allow rules; with no rule the profile default (block) applies.
 */
export function evaluateInbound(
  snap: FirewallSnapshot,
  target: { program: string; protocol: "TCP" | "UDP"; port: number },
): InboundVerdict {
  const active = snap.profiles.filter((p) => snap.currentProfiles & PROFILE[p.name]);
  if (active.length > 0 && active.every((p) => !p.enabled)) {
    return { allowed: true, because: "firewall-off", rule: null, programWide: false };
  }
  const proto = target.protocol === "TCP" ? 6 : 17;
  const matching = snap.rules.filter(
    (r) =>
      (r.profiles & snap.currentProfiles) !== 0 &&
      (r.program === null || sameProgram(r.program, target.program)) &&
      (r.protocol === 256 || r.protocol === proto) &&
      portListMatches(r.localPorts, target.port),
  );
  const block = matching.find((r) => r.action === "block");
  if (block) return { allowed: false, because: "block-rule", rule: block.name, programWide: false };
  const allow =
    matching.find((r) => r.action === "allow" && r.program !== null && r.localPorts !== "*") ??
    matching.find((r) => r.action === "allow");
  if (allow) {
    return {
      allowed: true,
      because: "allow-rule",
      rule: allow.name,
      programWide: allow.program !== null && allow.localPorts.trim() === "*",
    };
  }
  const defaultBlock = active.length === 0 || active.some((p) => p.enabled && p.blockInbound);
  return { allowed: !defaultBlock, because: "no-rule", rule: null, programWide: false };
}

/** Allow rules that open every port to this program. */
export function programWideRules(snap: FirewallSnapshot, program: string): FirewallRule[] {
  return snap.rules.filter(
    (r) =>
      r.action === "allow" &&
      r.program !== null &&
      sameProgram(r.program, program) &&
      r.localPorts.trim() === "*" &&
      (r.profiles & snap.currentProfiles) !== 0,
  );
}

/** How Windows classifies the connected network, e.g. "Public". */
export function activeNetworkCategory(snap: FirewallSnapshot): string | null {
  return snap.networks[0]?.category ?? null;
}

// --- changing ---------------------------------------------------------------------------

export type FirewallFix =
  | {
      kind: "allow-port";
      /** Rule name; replaced if it exists. */
      name: string;
      program: string;
      protocol: "TCP" | "UDP";
      port: number;
    }
  | {
      /** Drop this program's block rules, or its allow-every-port rules. */
      kind: "remove-program-rules";
      program: string;
      which: "block" | "all-ports";
    };

export function firewallFixScript(fixes: FirewallFix[], errorFile: string): string {
  const lines = ["$ErrorActionPreference = 'Stop'", "try {"];
  for (const f of fixes) {
    if (f.kind === "remove-program-rules") {
      lines.push(
        `  $prog = '${psQuote(path.win32.normalize(f.program))}'`,
        "  $filters = Get-NetFirewallApplicationFilter | Where-Object { $_.Program -and ([Environment]::ExpandEnvironmentVariables($_.Program)) -ieq $prog }",
        "  foreach ($r in ($filters | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' })) {",
        f.which === "block"
          ? "    if ($r.Action -eq 'Block') { Remove-NetFirewallRule -InputObject $r }"
          : "    if ($r.Action -eq 'Allow' -and (($r | Get-NetFirewallPortFilter).LocalPort -eq 'Any')) { Remove-NetFirewallRule -InputObject $r }",
        "  }",
      );
    } else {
      const name = psQuote(f.name.replace(/[^\x20-\x7e]/g, "").slice(0, 120));
      lines.push(
        `  Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
        `  New-NetFirewallRule -DisplayName '${name}' -Group 'cubehold' -Direction Inbound -Action Allow -Protocol ${f.protocol} -LocalPort ${Math.trunc(f.port)} -Program '${psQuote(path.win32.normalize(f.program))}' -Profile Any | Out-Null`,
      );
    }
  }
  lines.push(
    "  exit 0",
    `} catch { $_.Exception.Message | Out-File -FilePath '${psQuote(errorFile)}' -Encoding utf8; exit 1 }`,
  );
  return lines.join("\r\n");
}

/**
 * Run a script as administrator. Windows shows its UAC prompt on this
 * desktop; declining it rejects with a clear message.
 */
export async function runElevated(fixes: FirewallFix[]): Promise<void> {
  if (process.platform !== "win32") throw new Error("Only supported on Windows");
  const errorFile = path.join(
    os.tmpdir(),
    `cubehold-firewall-${randomBytes(6).toString("hex")}.txt`,
  );
  const inner = encode(firewallFixScript(fixes, errorFile));
  const outer = `
$ErrorActionPreference = 'Stop'
try {
  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${inner}'
  exit $p.ExitCode
} catch {
  Write-Output 'UAC-DECLINED'
  exit 2
}`;
  try {
    await powershell(outer, 5 * 60_000);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    const detail = fs.existsSync(errorFile) ? fs.readFileSync(errorFile, "utf8").trim() : "";
    fs.rmSync(errorFile, { force: true });
    if (/UAC-DECLINED/.test(text)) {
      throw new Error("Windows did not get permission: the administrator prompt was declined.");
    }
    throw new Error(detail || `Changing the firewall failed: ${text}`);
  }
  fs.rmSync(errorFile, { force: true });
}

// --- helpers ------------------------------------------------------------------------------

function psQuote(s: string): string {
  return s.replace(/'/g, "''");
}

function encode(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function powershell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encode(script),
      ],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${stdout}\n${stderr}`.trim() || err.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}
