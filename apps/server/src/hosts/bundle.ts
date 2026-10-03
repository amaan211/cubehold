import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { distFile } from "../dist.js";

export interface AgentBundle {
  /** The whole agent (daemon, Minecraft and tunnel code, ws, zip libraries) as one ES module. */
  code: Buffer;
  /** Short hash of the code: the agent reports it back as its build. */
  build: string;
}

/**
 * esbuild settings for the agent bundle, shared with the release build so a
 * release ships exactly what a panel run from source would upload.
 */
export const AGENT_BUNDLE_OPTIONS = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  // Optional speedups of ws; it works without them.
  external: ["bufferutil", "utf-8-validate"],
  // CommonJS dependencies (ws, yauzl) call require().
  banner: {
    js: "import { createRequire as __cubeholdRequire } from 'node:module'; const require = __cubeholdRequire(import.meta.url);",
  },
} as const;

export function agentBuildId(code: Buffer): string {
  return createHash("sha256").update(code).digest("hex").slice(0, 16);
}

let cached: Promise<AgentBundle> | null = null;

/**
 * The agent for remote hosts, bundled into a single file so a host needs
 * only a Node.js runtime. A release build ships it as agent.mjs, which the
 * local daemon runs too. From source it is built once per panel process from
 * the same sources the local agent runs, so both are always the same version.
 */
export function agentBundle(): Promise<AgentBundle> {
  cached ??= loadBundle().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

async function loadBundle(): Promise<AgentBundle> {
  const shipped = distFile("agent.mjs");
  const code = shipped ? await fs.promises.readFile(shipped) : await buildFromSource();
  return { code, build: agentBuildId(code) };
}

async function buildFromSource(): Promise<Buffer> {
  // Only needed from source; a release has no esbuild.
  const { build } = await import("esbuild");
  const entry = fileURLToPath(import.meta.resolve("@cubehold/agent/daemon"));
  const result = await build({
    ...AGENT_BUNDLE_OPTIONS,
    external: [...AGENT_BUNDLE_OPTIONS.external],
    entryPoints: [entry],
    write: false,
    logLevel: "silent",
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error("esbuild produced no agent bundle");
  return Buffer.from(file.contents);
}
