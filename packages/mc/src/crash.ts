/**
 * Explain why a server crashed from a crash report, a JVM error log or the
 * last console lines. Pattern-based: good at the common causes, and always
 * returns something a person can act on.
 */

export interface CrashAnalysis {
  cause:
    | "out_of_memory"
    | "port_in_use"
    | "java_version"
    | "eula"
    | "world_locked"
    | "loader_too_old"
    | "mod_dependencies"
    | "watchdog"
    | "stack_overflow"
    | "jvm_crash"
    | "world_data"
    | "tick_exception"
    | "killed"
    | "unknown";
  title: string;
  hint: string;
  /** Plugins, mods or packages that appear in the stack trace, most likely first. */
  suspects: string[];
  /** The report's own "Description:" line, when present. */
  description: string | null;
  /** First exception line. */
  exception: string | null;
}

interface Rule {
  cause: CrashAnalysis["cause"];
  test: RegExp;
  title: string;
  hint: string;
}

const RULES: Rule[] = [
  {
    cause: "out_of_memory",
    test: /java\.lang\.OutOfMemoryError/,
    title: "Out of memory",
    hint: "The server filled its whole heap. Give it more memory in Settings, lower the view distance, or remove heavy plugins or mods.",
  },
  {
    cause: "port_in_use",
    test: /FAILED TO BIND TO PORT|Address already in use|BindException/i,
    title: "Port already in use",
    hint: "Something else is listening on this server's port, often another copy of the server. Stop it or change the port in Settings.",
  },
  {
    cause: "java_version",
    test: /UnsupportedClassVersionError|compiled by a more recent version of the Java Runtime/,
    title: "Wrong Java version",
    hint: "The server or one of its plugins/mods needs a newer Java than the one it runs on. Update the plugin, or change the server version so the panel picks a newer Java.",
  },
  {
    cause: "eula",
    test: /You need to agree to the EULA/i,
    title: "EULA not accepted",
    hint: "Set eula=true in eula.txt (Files tab) and start again.",
  },
  {
    cause: "world_locked",
    test: /session\.lock|already locked|being used by another process/i,
    title: "World is locked",
    hint: "Another process has the world open, usually a second copy of this server. Stop it and start again.",
  },
  {
    cause: "loader_too_old",
    test: /Mod \S+ requires (neoforge|forge|fabricloader|fabric-loader|fabric|quilt_loader) \S+ or above/i,
    title: "A mod needs a newer mod loader",
    hint: "A mod was made for a newer NeoForge, Forge or Fabric Loader than this server runs (the details below name it). Use a version of the mod made for this loader, or move the server to a newer Minecraft version in Settings, which installs the newest loader.",
  },
  {
    cause: "mod_dependencies",
    test: /Incompatible mods? (set|found)|Mod resolution (failed|encountered)|which is missing!|Missing or unsupported mandatory dependencies|requires (any version of|version) .* of|ModLoadingException/i,
    title: "Missing or incompatible mods",
    hint: "A mod needs another mod, or a different version of one. The details below name them; add or update those mods in the Mods tab.",
  },
  {
    cause: "watchdog",
    test: /Watchdog|The server has stopped responding|A single server tick took|Considering it to be crashed/i,
    title: "Server froze",
    hint: "One tick took so long that the watchdog stopped the server. Usual causes: a misbehaving plugin or mod, huge entity or redstone farms, or not enough CPU.",
  },
  {
    cause: "stack_overflow",
    test: /java\.lang\.StackOverflowError/,
    title: "Stack overflow",
    hint: "Almost always a plugin or mod bug (endless recursion). Update or remove the suspect below.",
  },
  {
    cause: "jvm_crash",
    test: /A fatal error has been detected by the Java Runtime Environment|EXCEPTION_ACCESS_VIOLATION|SIGSEGV|SIGBUS/,
    title: "Java itself crashed",
    hint: "The Java runtime crashed, not Minecraft. If it happens again, a mod with native code may be at fault; deleting the runtime under data/java makes the panel download a fresh one.",
  },
  {
    cause: "world_data",
    test: /Failed to load (level|world)|Couldn't load chunk|Exception reading .*\.mca|RegionFile\w*.*(Exception|corrupt)|Chunk file at .* is (in the wrong location|corrupt)|level\.dat.*(corrupt|Exception|failed)/i,
    title: "World data problem",
    hint: "Part of the world could not be read. If chunks are damaged, restore a backup from the Backups tab.",
  },
  {
    cause: "tick_exception",
    test: /Exception in server tick loop|Ticking (entity|block entity|player|world)|Exception ticking world/i,
    title: "Error while ticking",
    hint: "Something threw an error during a game tick. The stack trace usually points at the plugin or mod responsible.",
  },
];

/** Stack frames and jar names that belong to the server itself, not to plugins or mods. */
const CORE =
  /^(java|javax|jdk|sun|com\.sun|net\.minecraft|com\.mojang|io\.papermc|org\.bukkit|org\.spigotmc|net\.md_5|net\.fabricmc|net\.minecraftforge|net\.neoforged|cpw\.mods|com\.google|io\.netty|it\.unimi|org\.apache|org\.slf4j|org\.objectweb|org\.spongepowered|ca\.spottedleaf|co\.aikar|org\.purpurmc|com\.destroystokyo|org\.jline|joptsimple|oshi|com\.electronwill|org\.yaml|com\.zaxxer|net\.kyori)\b/;
const CORE_JAR =
  /^(paper|purpur|server|minecraft|patched_|fabric-loader|fabric-api|forge|neoforge|fmlloader|fmlcore|bootstraplauncher|securejarhandler|modlauncher|log4j|netty|guava|datafixerupper|brigadier|authlib|java\.base|launcher|jopt|mixin|sponge-mixin)/i;

/**
 * The error-looking lines of a console tail. Without a crash report, only
 * these are worth analysing: the rest is the ordinary startup log, which
 * mentions worlds, regions and plugins all the time.
 */
export function errorLines(lines: string[]): string[] {
  const out: string[] = [];
  let inTrace = false;
  for (const line of lines) {
    const isError =
      /\b(ERROR|FATAL|SEVERE)\b|Exception|Error:|^\s*Caused by:|FAILED TO BIND|You need to agree to the EULA|Watchdog|A single server tick took/i.test(
        line,
      );
    const isTrace = /^\s+at |^\s+\.\.\. \d+ more/.test(line);
    if (isError || (inTrace && isTrace)) out.push(line);
    inTrace = isError || (inTrace && isTrace);
  }
  return out;
}

/** A crash with no report and no errors in the log. */
export function unexplainedExit(code: number | null): CrashAnalysis {
  return {
    cause: "killed",
    title: "The process ended without an error",
    hint: `Nothing in the log explains it${code !== null ? ` (exit code ${code})` : ""}. It was most likely ended from outside: Task Manager or kill, a system shutdown, or the operating system reclaiming memory when the machine ran out.`,
    suspects: [],
    description: null,
    exception: null,
  };
}

export function analyzeCrash(text: string): CrashAnalysis {
  const rule = RULES.find((r) => r.test.test(text));
  const description = /^Description: (.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const exception =
    /^\s*(?:Caused by: )?((?:[a-z][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error)\b[^\n]*)/m
      .exec(text)?.[1]
      ?.trim()
      .slice(0, 300) ?? null;
  return {
    cause: rule?.cause ?? "unknown",
    title: rule?.title ?? "The server stopped unexpectedly",
    hint:
      rule?.hint ??
      "No known cause matched. The report below has the details; the stack trace often names the plugin or mod involved.",
    suspects: findSuspects(text),
    description,
    exception,
  };
}

function findSuspects(text: string): string[] {
  const found = new Map<string, number>();
  const add = (name: string, weight: number) => found.set(name, (found.get(name) ?? 0) + weight);

  // Paper/log4j frames name the jar: "at x.y.Z.m(Z.java:1) ~[LuckPerms-5.5.jar:?]"
  for (const m of text.matchAll(/~?\[([^\]\s:]+\.jar)(?::[^\]]*)?\]/g)) {
    const jar = m[1] as string;
    if (!CORE_JAR.test(jar)) add(jar, 3);
  }
  // Plain stack frames: use the first three package segments of non-core classes.
  for (const m of text.matchAll(/^\s*at ([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)+)\./gm)) {
    const cls = m[1] as string;
    if (CORE.test(cls)) continue;
    const pkg = cls.split(".").slice(0, 3).join(".");
    add(pkg, 1);
  }
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);
}
