import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

/** Paths the panel's API owns; everything else may be a page of the web app. */
const API_PREFIXES = ["/trpc", "/api", "/ws", "/health"];

/**
 * Serve the built web app (release builds; in development Vite does this).
 * Hashed files under /assets are cached for good, index.html never, and any
 * other GET for a page falls back to index.html so deep links work.
 */
export async function registerWebApp(app: FastifyInstance, root: string): Promise<void> {
  const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const csp = contentSecurityPolicy(indexHtml);

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });

  await app.register(fastifyStatic, {
    root,
    index: false,
    setHeaders(reply, file) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      reply.header(
        "cache-control",
        rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      );
    },
  });

  const sendIndex = (reply: FastifyReply) =>
    reply
      .header("cache-control", "no-cache")
      .header("content-security-policy", csp)
      .header("x-frame-options", "DENY")
      .type("text/html; charset=utf-8")
      .send(indexHtml);

  app.get("/", (_req, reply) => sendIndex(reply));

  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split("?")[0] ?? "/";
    const isApi = API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
    // A page (no file extension) that the client-side router knows; files that are missing stay 404.
    if (req.method === "GET" && !isApi && !path.extname(pathname)) return sendIndex(reply);
    return reply.code(404).send({ error: "Not found" });
  });
}

/**
 * Scripts only from the panel itself plus the inline theme script (allowed by
 * its hash, read from the built page), images also from the few sites the
 * panel shows pictures from, and no framing.
 */
function contentSecurityPolicy(html: string): string {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) =>
      `'sha256-${createHash("sha256")
        .update(m[1] ?? "")
        .digest("base64")}'`,
  );
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    // Player heads; plugin, mod and modpack icons.
    "img-src 'self' data: blob: https://mc-heads.net https://cdn.modrinth.com https://hangarcdn.papermc.io",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
