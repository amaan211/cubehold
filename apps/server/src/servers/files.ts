import path from "node:path";
import type { Readable } from "node:stream";
import type { AgentDownload } from "@cubehold/agent";
import type { FileEntry } from "@cubehold/shared";
import { errMessage, ServerError, type ServerRow, type ServerService } from "./service.js";
import type { Tasks } from "./tasks.js";

const EDITOR_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Normalise a path from the browser: forward slashes, no leading slash, no
 * "." or ".." segments. The agent also refuses anything outside the server
 * folder; this just gives a clear error first.
 */
export function cleanPath(rel: string): string {
  const parts = rel
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw new ServerError("VALIDATION", "Paths cannot contain ..");
  return parts.join("/");
}

function cleanName(name: string): string {
  const n = name.trim();
  if (!n || n === "." || n === ".." || /[/\\:*?"<>|\0]/.test(n)) {
    throw new ServerError("VALIDATION", `Invalid file name: ${name}`);
  }
  return n;
}

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Browse and edit a server's folder through its agent. */
export class FileService {
  constructor(
    private readonly servers: ServerService,
    private readonly tasks: Tasks,
  ) {}

  async list(serverId: string, rel: string): Promise<{ path: string; entries: FileEntry[] }> {
    const row = await this.servers.row(serverId);
    const dir = cleanPath(rel);
    try {
      return { path: dir, entries: await this.servers.agentOf(row).listDir(row.directory, dir) };
    } catch (err) {
      throw new ServerError(
        "NOT_FOUND",
        `Cannot open ${dir || "the server folder"}: ${errMessage(err)}`,
      );
    }
  }

  async read(serverId: string, rel: string) {
    const row = await this.servers.row(serverId);
    const file = cleanPath(rel);
    let content: string;
    try {
      content = await this.servers.agentOf(row).readFile(row.directory, file, EDITOR_MAX_BYTES);
    } catch (err) {
      throw new ServerError("BAD_STATE", errMessage(err));
    }
    if (content.includes("\u0000")) {
      throw new ServerError("BAD_STATE", "This is a binary file; download it instead of editing");
    }
    return { path: file, content };
  }

  async write(serverId: string, rel: string, content: string): Promise<void> {
    const row = await this.#writable(serverId);
    const file = cleanPath(rel);
    if (!file) throw new ServerError("VALIDATION", "Missing file name");
    await this.servers.agentOf(row).writeFile(row.directory, file, content);
  }

  async mkdir(serverId: string, rel: string): Promise<void> {
    const row = await this.#writable(serverId);
    const dir = cleanPath(rel);
    if (!dir) throw new ServerError("VALIDATION", "Missing folder name");
    cleanName(path.posix.basename(dir));
    await this.servers.agentOf(row).makeDir(row.directory, dir);
  }

  async rename(serverId: string, from: string, to: string): Promise<void> {
    const row = await this.#writable(serverId);
    const src = cleanPath(from);
    const dest = cleanPath(to);
    if (!src || !dest) throw new ServerError("VALIDATION", "Missing name");
    cleanName(path.posix.basename(dest));
    try {
      await this.servers.agentOf(row).rename(row.directory, src, dest);
    } catch (err) {
      throw new ServerError("BAD_STATE", errMessage(err));
    }
  }

  async remove(serverId: string, rels: string[]): Promise<void> {
    const row = await this.#writable(serverId);
    const paths = rels.map(cleanPath);
    if (paths.some((p) => p === ""))
      throw new ServerError("VALIDATION", "Cannot delete the server folder");
    try {
      await this.servers.agentOf(row).removePaths(row.directory, paths);
    } catch (err) {
      throw new ServerError("BAD_STATE", errMessage(err));
    }
  }

  /** Zip entries of a folder into a new archive next to them. Runs as a task. */
  async archive(serverId: string, dirRel: string, names: string[], archiveName: string) {
    const row = await this.#writable(serverId);
    const dir = cleanPath(dirRel);
    const entries = names.map((n) => join(dir, cleanName(n)));
    const target = join(dir, cleanName(archiveName));
    const agent = this.servers.agentOf(row);
    const [exists] = await agent.stat(row.directory, [target]);
    if (exists?.exists) throw new ServerError("CONFLICT", `${archiveName} already exists`);
    const result = await this.tasks.run(
      serverId,
      "archive",
      `Compressing ${names.length === 1 ? names[0] : `${names.length} items`}`,
      (task) =>
        agent.zip(
          row.directory,
          entries,
          this.servers.hostPath(row).join(row.directory, ...target.split("/")),
          {
            skipNames: ["session.lock"],
            taskId: task.id,
          },
        ),
      (r) => `${r.files} files`,
    );
    return { path: target, ...result };
  }

  /** Extract a zip into a folder (created if needed). Existing files are not replaced. */
  async extract(serverId: string, rel: string, intoRel: string) {
    const row = await this.#writable(serverId);
    const file = cleanPath(rel);
    const into = cleanPath(intoRel);
    if (!/\.(zip|jar|mrpack)$/i.test(file)) {
      throw new ServerError("VALIDATION", "Only .zip archives can be extracted");
    }
    const agent = this.servers.agentOf(row);
    const hp = this.servers.hostPath(row);
    const abs = (p: string) => hp.join(row.directory, ...p.split("/").filter(Boolean));
    try {
      return await this.tasks.run(
        serverId,
        "extract",
        `Extracting ${path.posix.basename(file)}`,
        (task) => agent.unzip(abs(file), abs(into), { taskId: task.id }),
        (r) => `${r.files} files`,
      );
    } catch (err) {
      throw new ServerError("BAD_STATE", errMessage(err));
    }
  }

  // --- streams -----------------------------------------------------------------------

  async download(serverId: string, rel: string): Promise<AgentDownload & { name: string }> {
    const row = await this.servers.row(serverId);
    const file = cleanPath(rel);
    if (!file) throw new ServerError("VALIDATION", "Missing file");
    try {
      const dl = await this.servers.remoteOf(row).download(row.directory, file);
      return { ...dl, name: path.posix.basename(file) };
    } catch (err) {
      throw new ServerError("NOT_FOUND", errMessage(err));
    }
  }

  /** Stream a folder (or a selection in it) as a zip. */
  async downloadZip(
    serverId: string,
    dirRel: string,
    names: string[],
  ): Promise<AgentDownload & { name: string }> {
    const row = await this.servers.row(serverId);
    const dir = cleanPath(dirRel);
    let entries = names.map((n) => join(dir, cleanName(n)));
    if (entries.length === 0) {
      // The whole folder; for the server root, its top-level entries.
      entries = dir
        ? [dir]
        : (await this.servers.agentOf(row).listDir(row.directory, "")).map((e) => e.name);
    }
    const base =
      names.length === 1 ? (names[0] as string) : dir ? path.posix.basename(dir) : slug(row.name);
    try {
      const dl = await this.servers.remoteOf(row).downloadZip(row.directory, entries);
      return { ...dl, name: `${base}.zip` };
    } catch (err) {
      throw new ServerError("BAD_STATE", errMessage(err));
    }
  }

  async upload(
    serverId: string,
    dirRel: string,
    name: string,
    body: Readable,
    overwrite: boolean,
  ): Promise<{ path: string; sizeBytes: number }> {
    const row = await this.#writable(serverId);
    const target = join(cleanPath(dirRel), cleanName(name));
    try {
      const sizeBytes = await this.servers
        .remoteOf(row)
        .upload(row.directory, target, body, overwrite);
      return { path: target, sizeBytes };
    } catch (err) {
      const message = errMessage(err);
      throw new ServerError(/exists/.test(message) ? "CONFLICT" : "BAD_STATE", message);
    }
  }

  async #writable(serverId: string): Promise<ServerRow> {
    const row = await this.servers.row(serverId);
    this.servers.assertIdle(row);
    return row;
  }
}

function slug(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}
