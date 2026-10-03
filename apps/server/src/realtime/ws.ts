import { clientMessage, type RealtimeEvent, SESSION_COOKIE } from "@cubehold/shared";
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { resolveSession } from "../auth/session.js";
import type { Db } from "../db/index.js";
import type { RealtimeBus } from "./bus.js";

const PING_INTERVAL_MS = 30_000;

/**
 * GET /ws — authenticated with the same session cookie as tRPC. Clients
 * subscribe to server ids and receive a snapshot followed by live events.
 */
export async function registerWebSocket(app: FastifyInstance, deps: { db: Db; bus: RealtimeBus }) {
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.get("/ws", { websocket: true }, async (socket: WebSocket, req) => {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await resolveSession(deps.db, token) : null;
    if (!user) {
      socket.close(4401, "unauthorized");
      return;
    }

    const subscriptions = new Set<string>();
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    const onEvent = (event: RealtimeEvent) => {
      if (subscriptions.has(event.data.serverId)) send(event);
    };
    deps.bus.on("event", onEvent);

    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, PING_INTERVAL_MS);

    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const msg = clientMessage.safeParse(parsed);
      if (!msg.success) return;
      switch (msg.data.type) {
        case "subscribe":
          subscriptions.add(msg.data.serverId);
          send({ type: "snapshot", data: deps.bus.snapshot(msg.data.serverId) });
          break;
        case "unsubscribe":
          subscriptions.delete(msg.data.serverId);
          break;
        case "ping":
          send({ type: "pong" });
          break;
      }
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      deps.bus.off("event", onEvent);
    });
    socket.on("error", () => {
      clearInterval(heartbeat);
      deps.bus.off("event", onEvent);
    });
  });
}
