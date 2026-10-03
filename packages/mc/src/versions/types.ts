import type { ServerSoftware } from "@cubehold/shared";

export interface ResolvedDownload {
  software: ServerSoftware;
  mcVersion: string;
  /** File name to save the jar as inside the server directory. */
  fileName: string;
  url: string;
  sha1?: string;
  sha256?: string;
  /** Only Purpur publishes nothing stronger. */
  md5?: string;
  sizeBytes: number | null;
  /** Java major version required, when the source states it. */
  javaMajor: number | null;
  /** Build identifier for softwares that have one (Paper build number, Fabric loader). */
  build: string | null;
  /** Extra JVM flags recommended by the software vendor. */
  recommendedJvmFlags?: string[];
  /**
   * The download is an installer (Forge, NeoForge) to run with --installServer.
   * It writes a launch args file into argsDir (win_args.txt / unix_args.txt),
   * or, for old versions, a jar starting with jarPrefix to run instead.
   */
  installer?: { argsDir: string; jarPrefix?: string };
}
