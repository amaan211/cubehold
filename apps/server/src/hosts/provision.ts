/**
 * What the panel runs on a fresh VPS to make it a host: the scripts are
 * plain functions of their inputs so they can be read and tested without a
 * server. Debian and Ubuntu (apt + systemd) are supported.
 */
import { shq } from "./ssh.js";

export const AGENT_USER = "cubehold";
export const AGENT_DATA_DIR = "/var/lib/cubehold";
export const AGENT_HOME = "/opt/cubehold";
export const AGENT_ENV_FILE = "/etc/cubehold/agent.env";
export const AGENT_UNIT = "cubehold-agent";
export const AGENT_BASE_PORT = 47700;
/** Tag on firewall rules the panel owns. */
export const UFW_TAG = "cubehold";

// --- facts -----------------------------------------------------------------------

export interface HostFacts {
  os: string | null;
  osId: string | null;
  osVersion: string | null;
  /** ID plus ID_LIKE, e.g. ["ubuntu", "debian"]. */
  family: string[];
  arch: string | null;
  kernel: string | null;
  systemd: boolean;
  apt: boolean;
  memMb: number | null;
  cpus: number | null;
  diskFreeMb: number | null;
  /** Ports sshd listens on (from its config), when readable. */
  sshPorts: number[];
  /** An agent from an earlier setup is installed. */
  agentInstalled: boolean;
  hostname: string | null;
}

/** One command that prints key=value facts; safe to run as any user. */
export const FACTS_SCRIPT = [
  "echo __os; cat /etc/os-release 2>/dev/null",
  "echo __end",
  'echo "arch=$(uname -m)"',
  'echo "kernel=$(uname -r)"',
  'echo "hostname=$(hostname 2>/dev/null)"',
  "if [ -d /run/systemd/system ]; then echo systemd=1; else echo systemd=0; fi",
  "if command -v apt-get >/dev/null 2>&1; then echo apt=1; else echo apt=0; fi",
  "echo \"mem=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)\"",
  'echo "cpus=$(nproc 2>/dev/null)"',
  "echo \"disk=$(df -Pm / 2>/dev/null | awk 'NR==2 {print $4}')\"",
  `if [ -f /etc/systemd/system/${AGENT_UNIT}.service ]; then echo agent=1; else echo agent=0; fi`,
  "echo \"sshports=$( (sshd -T 2>/dev/null || /usr/sbin/sshd -T 2>/dev/null) | awk '/^port / {print $2}' | tr '\\n' ' ')\"",
].join("; ");

export function parseFacts(out: string): HostFacts {
  const osBlock = /__os\n([\s\S]*?)__end/.exec(out)?.[1] ?? "";
  const osVar = (k: string) => {
    const m = new RegExp(`^${k}="?([^"\\n]*)"?$`, "m").exec(osBlock);
    return m?.[1]?.trim() || null;
  };
  const kv = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(out)?.[1]?.trim() ?? "";
  const num = (k: string) => {
    const n = Number.parseInt(kv(k), 10);
    return Number.isFinite(n) ? n : null;
  };
  const osId = osVar("ID");
  return {
    os: osVar("PRETTY_NAME"),
    osId,
    osVersion: osVar("VERSION_ID"),
    family: [osId, ...(osVar("ID_LIKE") ?? "").split(/\s+/)].filter((x): x is string => !!x),
    arch: kv("arch") || null,
    kernel: kv("kernel") || null,
    systemd: kv("systemd") === "1",
    apt: kv("apt") === "1",
    memMb: num("mem"),
    cpus: num("cpus"),
    diskFreeMb: num("disk"),
    sshPorts: kv("sshports")
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0),
    agentInstalled: kv("agent") === "1",
    hostname: kv("hostname") || null,
  };
}

/** Node.js build name for a machine type, or null when unsupported. */
export function nodeArch(machine: string | null): "x64" | "arm64" | null {
  if (machine === "x86_64" || machine === "amd64") return "x64";
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  return null;
}

export interface FactCheck {
  problems: string[];
  warnings: string[];
}

/** Can this machine be a host? Problems block setup; warnings do not. */
export function checkFacts(facts: HostFacts): FactCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const debianLike = facts.family.some((f) => f === "debian" || f === "ubuntu");
  if (!debianLike || !facts.apt) {
    problems.push(
      `${facts.os ?? "This system"} is not supported yet. Reinstall the server with Ubuntu 24.04 LTS (or Debian 12) from your provider's control panel.`,
    );
  }
  if (!facts.systemd) {
    problems.push("systemd is not running, so the agent cannot run as a service.");
  }
  if (!nodeArch(facts.arch)) {
    problems.push(
      `The processor type ${facts.arch ?? "unknown"} is not supported (x86_64 or ARM64 only).`,
    );
  }
  if (facts.memMb !== null && facts.memMb < 1500) {
    problems.push(
      `Only ${facts.memMb} MB of memory. A Minecraft server needs at least 2 GB; pick a bigger plan.`,
    );
  } else if (facts.memMb !== null && facts.memMb < 3500) {
    warnings.push(
      `${facts.memMb} MB of memory is enough for a small vanilla or Paper server; modpacks need 6 GB or more.`,
    );
  }
  if (facts.diskFreeMb !== null && facts.diskFreeMb < 3000) {
    problems.push(`Only ${facts.diskFreeMb} MB free on disk; at least 3 GB is needed.`);
  }
  if (facts.agentInstalled) {
    warnings.push(
      "An cubehold agent from an earlier setup is installed; it will be replaced and linked to this panel.",
    );
  }
  return { problems, warnings };
}

// --- scripts ---------------------------------------------------------------------

/** Wait for cloud-init and other apt users, then install packages. */
export function packagesScript(opts: {
  firewall: boolean;
  fail2ban: boolean;
  autoUpdates: boolean;
}) {
  const pkgs = ["curl", "ca-certificates", "xz-utils", "tar", "iproute2"];
  if (opts.firewall) pkgs.push("ufw");
  if (opts.fail2ban) pkgs.push("fail2ban");
  if (opts.autoUpdates) pkgs.push("unattended-upgrades");
  return `set -e
export DEBIAN_FRONTEND=noninteractive
if command -v cloud-init >/dev/null 2>&1; then
  echo "Waiting for the provider's first-boot setup (cloud-init) to finish..."
  timeout 600 cloud-init status --wait >/dev/null 2>&1 || true
fi
APT="apt-get -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
$APT update -q
$APT install -y -q --no-install-recommends ${pkgs.join(" ")}
`;
}

export function userScript(): string {
  return `set -e
if ! id ${AGENT_USER} >/dev/null 2>&1; then
  useradd --system --user-group --home-dir ${AGENT_DATA_DIR} --create-home --shell /usr/sbin/nologin ${AGENT_USER}
  echo "Created the ${AGENT_USER} account"
fi
install -d -o ${AGENT_USER} -g ${AGENT_USER} -m 750 ${AGENT_DATA_DIR}
install -d -m 755 ${AGENT_HOME} ${AGENT_HOME}/agent
install -d -m 750 -o root -g root /etc/cubehold
`;
}

export interface NodeRelease {
  version: string;
  arch: "x64" | "arm64";
  url: string;
  sha256: string;
  dir: string;
}

export function nodeScript(r: NodeRelease): string {
  return `set -e
DIR=${shq(`${AGENT_HOME}/${r.dir}`)}
if [ ! -x "$DIR/bin/node" ]; then
  TMP=$(mktemp -d)
  echo "Downloading Node.js ${r.version} (${r.arch})"
  curl -fsSL --retry 3 -o "$TMP/node.tar.xz" ${shq(r.url)}
  echo "${r.sha256}  $TMP/node.tar.xz" | sha256sum -c --quiet -
  tar -xJf "$TMP/node.tar.xz" -C ${AGENT_HOME}
  rm -rf "$TMP"
fi
ln -sfn "$DIR" ${AGENT_HOME}/node
${AGENT_HOME}/node/bin/node --version
# Older runtimes from earlier panel versions.
for d in ${AGENT_HOME}/node-v*; do
  [ "$d" = "$DIR" ] || rm -rf "$d"
done
`;
}

/** Pick a free loopback port for the agent (the one already configured if it is set). */
export function agentPortScript(): string {
  return `CUR=$(sed -n 's/^CUBEHOLD_AGENT_PORT=//p' ${AGENT_ENV_FILE} 2>/dev/null)
if [ -n "$CUR" ]; then echo "port=$CUR"; exit 0; fi
for p in $(seq ${AGENT_BASE_PORT} ${AGENT_BASE_PORT + 99}); do
  if ! ss -Htln 2>/dev/null | awk '{print $4}' | grep -q ":$p$"; then echo "port=$p"; exit 0; fi
done
echo "no free port" >&2; exit 1
`;
}

export function envFile(opts: { token: string; port: number; build: string }): string {
  return [
    "# Written by the cubehold panel. The token lets the panel control this agent.",
    `CUBEHOLD_AGENT_TOKEN=${opts.token}`,
    `CUBEHOLD_AGENT_PORT=${opts.port}`,
    `CUBEHOLD_AGENT_DATA=${AGENT_DATA_DIR}`,
    `CUBEHOLD_AGENT_BUILD=${opts.build}`,
    "CUBEHOLD_AGENT_SERVICE=1",
    "",
  ].join("\n");
}

/**
 * The agent runs as the unprivileged cubehold account, can only write its data
 * folder, and listens on 127.0.0.1 only; the panel reaches it through SSH.
 * On stop it gives each Minecraft server time to save.
 */
export function unitFile(): string {
  return `[Unit]
Description=cubehold agent (runs Minecraft servers for the cubehold panel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${AGENT_USER}
Group=${AGENT_USER}
EnvironmentFile=${AGENT_ENV_FILE}
WorkingDirectory=${AGENT_DATA_DIR}
ExecStart=${AGENT_HOME}/node/bin/node ${AGENT_HOME}/agent/agent.mjs
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=180
LimitNOFILE=65536
UMask=0027
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=${AGENT_DATA_DIR}
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
`;
}

/** Enable and (re)start the agent, then wait until it listens. */
export function startAgentScript(port: number): string {
  return `set -e
systemctl daemon-reload
systemctl enable ${AGENT_UNIT} >/dev/null 2>&1
systemctl restart ${AGENT_UNIT}
for i in $(seq 1 30); do
  if ss -Htln 2>/dev/null | awk '{print $4}' | grep -q "^127.0.0.1:${port}$"; then echo "Agent is listening"; exit 0; fi
  sleep 1
done
echo "The agent did not start. Its log:" >&2
journalctl -u ${AGENT_UNIT} -n 30 --no-pager >&2 || true
exit 1
`;
}

/** Add the panel's key for the login user (not root: this runs as that user). */
export function authorizeKeyScript(publicKeyLine: string): string {
  const body = publicKeyLine.split(/\s+/).slice(0, 2).join(" ");
  return `umask 077
mkdir -p ~/.ssh
touch ~/.ssh/authorized_keys
grep -qF ${shq(body)} ~/.ssh/authorized_keys || printf '%s\\n' ${shq(publicKeyLine)} >> ~/.ssh/authorized_keys
echo ok`;
}

export function removeKeyScript(hostId: string): string {
  return `[ -f ~/.ssh/authorized_keys ] && sed -i ${shq(`/ cubehold-panel-${hostId}$/d`)} ~/.ssh/authorized_keys; echo ok`;
}

export function keyComment(hostId: string): string {
  return `cubehold-panel-${hostId}`;
}

// --- firewall --------------------------------------------------------------------

export interface FirewallRule {
  port: number;
  protocol: "tcp" | "udp";
  comment: string | null;
}

/** `ufw show added` lists rules as the commands that made them, active or not. */
export function parseUfwAdded(out: string): FirewallRule[] {
  const rules: FirewallRule[] = [];
  for (const line of out.split("\n")) {
    const m = /^ufw allow (\d+)\/(tcp|udp)(?: comment '(.*)')?\s*$/.exec(line.trim());
    if (m)
      rules.push({ port: Number(m[1]), protocol: m[2] as "tcp" | "udp", comment: m[3] ?? null });
  }
  return rules;
}

/**
 * Turn ufw on without locking ourselves out: SSH ports are allowed first,
 * and a timer turns ufw off again after 3 minutes unless the panel confirms
 * a fresh login works and cancels it (see cancelGuardScript).
 */
export function enableFirewallScript(sshPorts: number[], game: FirewallRule[]): string {
  const lines = ["set -e"];
  for (const p of [...new Set(sshPorts)]) {
    lines.push(`ufw allow ${p}/tcp comment 'SSH' >/dev/null`);
  }
  for (const r of game) {
    lines.push(`ufw allow ${r.port}/${r.protocol} comment ${shq(r.comment ?? UFW_TAG)} >/dev/null`);
  }
  lines.push(
    "ufw default deny incoming >/dev/null",
    "ufw default allow outgoing >/dev/null",
    // Oracle Cloud images reject everything but SSH in their own iptables rules, ahead of
    // ufw's; with ufw in charge those rules only block the game ports.
    "iptables -D INPUT -j REJECT --reject-with icmp-host-prohibited 2>/dev/null || true",
    "iptables -D FORWARD -j REJECT --reject-with icmp-host-prohibited 2>/dev/null || true",
    "if ufw status | grep -q '^Status: active'; then echo 'The firewall was already on'; exit 0; fi",
    "systemctl stop cubehold-ufw-guard.timer >/dev/null 2>&1 || true",
    "systemd-run --quiet --unit=cubehold-ufw-guard --on-active=180 /usr/sbin/ufw --force disable",
    "ufw --force enable",
    "echo guard=1",
  );
  return lines.join("\n");
}

export const CANCEL_GUARD_SCRIPT =
  "systemctl stop cubehold-ufw-guard.timer >/dev/null 2>&1; systemctl reset-failed cubehold-ufw-guard.service >/dev/null 2>&1; echo ok";

/** Open and close game ports so the rules tagged for cubehold match `wanted`. */
export function syncFirewallScript(
  existing: FirewallRule[],
  wanted: FirewallRule[],
): string | null {
  const key = (r: FirewallRule) => `${r.port}/${r.protocol}`;
  const ours = existing.filter((r) => r.comment?.startsWith(UFW_TAG));
  const wantedKeys = new Set(wanted.map(key));
  const lines: string[] = [];
  for (const r of ours) {
    if (!wantedKeys.has(key(r))) lines.push(`ufw delete allow ${key(r)} >/dev/null || true`);
  }
  const have = new Set(existing.map(key));
  for (const r of wanted) {
    if (!have.has(key(r))) {
      lines.push(`ufw allow ${key(r)} comment ${shq(r.comment ?? UFW_TAG)} >/dev/null`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

// --- hardening -------------------------------------------------------------------

export function fail2banScript(): string {
  return `set -e
export DEBIAN_FRONTEND=noninteractive
command -v fail2ban-server >/dev/null 2>&1 || apt-get -o DPkg::Lock::Timeout=600 install -y -q fail2ban
# Debian and Ubuntu enable the sshd jail by default; make sure a jail file exists.
if [ ! -f /etc/fail2ban/jail.d/defaults-debian.conf ] && [ ! -f /etc/fail2ban/jail.d/cubehold.conf ]; then
  printf '[sshd]\\nenabled = true\\n' > /etc/fail2ban/jail.d/cubehold.conf
fi
systemctl enable --now fail2ban >/dev/null 2>&1
systemctl is-active fail2ban
`;
}

export function autoUpdatesScript(): string {
  return `set -e
export DEBIAN_FRONTEND=noninteractive
dpkg -s unattended-upgrades >/dev/null 2>&1 || apt-get -o DPkg::Lock::Timeout=600 install -y -q unattended-upgrades
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CUBEHOLD_EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CUBEHOLD_EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
echo ok
`;
}

/** Keys only from now on. Written as a drop-in that sorts before cloud-init's. */
export function disablePasswordLoginScript(): string {
  return `set -e
cat > /etc/ssh/sshd_config.d/10-cubehold.conf <<'CUBEHOLD_EOF'
# Written by the cubehold panel: log in with SSH keys only.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
CUBEHOLD_EOF
chmod 644 /etc/ssh/sshd_config.d/10-cubehold.conf
if ! grep -qE '^\\s*Include\\s+/etc/ssh/sshd_config.d/' /etc/ssh/sshd_config; then
  rm -f /etc/ssh/sshd_config.d/10-cubehold.conf
  echo "This SSH server does not read sshd_config.d; change /etc/ssh/sshd_config by hand." >&2
  exit 3
fi
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd
echo ok
`;
}

export interface HostSecurity {
  firewall: "active" | "inactive" | "missing";
  /** Rules the panel added for game ports. */
  openPorts: FirewallRule[];
  fail2ban: "active" | "inactive" | "missing";
  autoUpdates: boolean;
  passwordLogin: boolean | null;
  rootLogin: string | null;
  rebootRequired: boolean;
  checkedAt: string;
}

export const SECURITY_SCRIPT = [
  'if command -v ufw >/dev/null 2>&1; then echo "ufw=$(ufw status 2>/dev/null | head -1)"; echo __rules; ufw show added 2>/dev/null; echo __end; else echo ufw=missing; fi',
  'if command -v fail2ban-server >/dev/null 2>&1; then echo "fail2ban=$(systemctl is-active fail2ban 2>/dev/null)"; else echo fail2ban=missing; fi',
  'echo "autoupdates=$(apt-config dump 2>/dev/null | grep -c \'APT::Periodic::Unattended-Upgrade "1"\')"',
  "(sshd -T 2>/dev/null || /usr/sbin/sshd -T 2>/dev/null) | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '",
  "if [ -f /var/run/reboot-required ]; then echo reboot=1; else echo reboot=0; fi",
].join("; ");

export function parseSecurity(out: string): HostSecurity {
  const kv = (k: string) => new RegExp(`^${k}[= ](.*)$`, "m").exec(out)?.[1]?.trim() ?? "";
  const ufw = kv("ufw");
  const rules = /__rules\n([\s\S]*?)__end/.exec(out)?.[1] ?? "";
  const f2b = kv("fail2ban");
  const pw = kv("passwordauthentication");
  const kbd = kv("kbdinteractiveauthentication");
  return {
    firewall:
      ufw === "missing"
        ? "missing"
        : /active/.test(ufw) && !/inactive/.test(ufw)
          ? "active"
          : "inactive",
    openPorts: parseUfwAdded(rules).filter((r) => r.comment?.startsWith(UFW_TAG)),
    fail2ban: f2b === "missing" ? "missing" : f2b === "active" ? "active" : "inactive",
    autoUpdates: Number(kv("autoupdates")) > 0,
    passwordLogin: pw ? pw === "yes" || kbd === "yes" : null,
    rootLogin: kv("permitrootlogin") || null,
    rebootRequired: kv("reboot") === "1",
    checkedAt: new Date().toISOString(),
  };
}

/** Remove everything the panel installed. Data (worlds, backups) only with deleteData. */
export function uninstallScript(opts: { deleteData: boolean }): string {
  return `systemctl disable --now ${AGENT_UNIT} >/dev/null 2>&1 || true
rm -f /etc/systemd/system/${AGENT_UNIT}.service
systemctl daemon-reload
rm -rf ${AGENT_HOME} /etc/cubehold
if command -v ufw >/dev/null 2>&1; then
  ufw show added 2>/dev/null | sed -n "s/^ufw allow \\([0-9]*\\/[a-z]*\\) comment '${UFW_TAG}.*$/\\1/p" | while read -r r; do ufw delete allow "$r" >/dev/null || true; done
fi
${opts.deleteData ? `rm -rf ${AGENT_DATA_DIR}; userdel ${AGENT_USER} >/dev/null 2>&1 || true` : `echo "Kept ${AGENT_DATA_DIR} (servers and backups)"`}
echo ok
`;
}
