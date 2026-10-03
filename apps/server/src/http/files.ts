import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import { SESSION_COOKIE } from "@cubehold/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AssetService } from "../assets/service.js";
import { resolveSession } from "../auth/session.js";
import type { Db } from "../db/index.js";
import type { BackupService } from "../servers/backups.js";
import type { FileService } from "../servers/files.js";
import type { ModpackService } from "../servers/modpacks.js";
import { errMessage, ServerError } from "../servers/service.js";

/** Header the web app sets on uploads; a cross-site form cannot, so it doubles as CSRF protection. */
export const UPLOAD_HEADER = "x-cubehold-upload";

/**
 * Streams that do not fit tRPC: file and folder downloads, uploads, backup
 * downloads. Authenticated with the session cookie like everything else.
 */
export async function registerFileRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    files: FileService;
    backups: BackupService;
    assets: AssetService;
    modpacks: ModpackService;
  },
) {
  // Keep upload bodies as raw streams; they can be gigabytes.
  app.addContentTypeParser("application/octet-stream", (_req, _payload, done) => done(null));

  const auth = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await resolveSession(deps.db, token) : null;
    if (!user) {
      await reply.code(401).send({ error: "Please log in" });
      return false;
    }
    return true;
  };

  const fail = (reply: FastifyReply, err: unknown) => {
    const status =
      err instanceof ServerError
        ? { NOT_FOUND: 404, CONFLICT: 409, VALIDATION: 400, BAD_STATE: 409 }[err.code]
        : 500;
    return reply.code(status).send({ error: errMessage(err) });
  };

  const sendDownload = (
    reply: FastifyReply,
    dl: { body: NodeJS.ReadableStream; sizeBytes: number | null; name: string },
    type = "application/octet-stream",
  ) => {
    reply.header("content-type", type);
    reply.header("content-disposition", contentDisposition(dl.name));
    reply.header("cache-control", "no-store");
    if (dl.sizeBytes !== null) reply.header("content-length", String(dl.sizeBytes));
    return reply.send(dl.body);
  };

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/servers/:id/files/download",
    async (req, reply) => {
      if (!(await auth(req, reply))) return;
      try {
        return sendDownload(reply, await deps.files.download(req.params.id, req.query.path ?? ""));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { dir?: string; names?: string } }>(
    "/api/servers/:id/files/zip",
    async (req, reply) => {
      if (!(await auth(req, reply))) return;
      try {
        const names = req.query.names ? (JSON.parse(req.query.names) as unknown) : [];
        if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
          throw new ServerError("VALIDATION", "names must be a list of file names");
        }
        const dl = await deps.files.downloadZip(
          req.params.id,
          req.query.dir ?? "",
          names as string[],
        );
        return sendDownload(reply, dl, "application/zip");
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.put<{
    Params: { id: string };
    Querystring: { dir?: string; name?: string; overwrite?: string };
  }>("/api/servers/:id/files/upload", async (req, reply) => {
    if (!(await auth(req, reply))) return;
    if (req.headers[UPLOAD_HEADER] !== "1") {
      return reply.code(403).send({ error: `Missing ${UPLOAD_HEADER} header` });
    }
    try {
      const result = await deps.files.upload(
        req.params.id,
        req.query.dir ?? "",
        req.query.name ?? "",
        req.raw as IncomingMessage,
        req.query.overwrite === "1",
      );
      return reply.send(result);
    } catch (err) {
      req.raw.resume(); // drain so the client sees the error instead of a reset
      return fail(reply, err);
    }
  });

  // A .mrpack from the browser; answers with what installing it would do.
  app.put("/api/modpacks/upload", async (req, reply) => {
    if (!(await auth(req, reply))) return;
    if (req.headers[UPLOAD_HEADER] !== "1") {
      return reply.code(403).send({ error: `Missing ${UPLOAD_HEADER} header` });
    }
    try {
      return reply.send(await deps.modpacks.fromUpload(req.raw as IncomingMessage));
    } catch (err) {
      req.raw.resume();
      return fail(reply, err);
    }
  });

  // Game textures for drawing inventories. Version-specific, so they never change.
  app.get<{ Params: { version: string; "*": string } }>(
    "/api/assets/:version/*",
    async (req, reply) => {
      if (!(await auth(req, reply))) return;
      const file = deps.assets.textureFile(req.params.version, req.params["*"]);
      if (!file) return reply.code(404).send({ error: "Not found" });
      reply.header("content-type", "image/png");
      reply.header("cache-control", "private, max-age=31536000, immutable");
      return reply.send(fs.createReadStream(file));
    },
  );

  app.get<{ Params: { id: string; backupId: string } }>(
    "/api/servers/:id/backups/:backupId/download",
    async (req, reply) => {
      if (!(await auth(req, reply))) return;
      try {
        const dl = await deps.backups.download(req.params.id, req.params.backupId);
        return sendDownload(reply, dl, "application/zip");
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}

/** RFC 6266 filename, with an ASCII fallback for old clients. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
