import type { FastifyInstance } from "fastify";
import { deny, isSessionMember } from "../auth.js";
import { getSessionOr404 } from "./sessions.js";

export function eventRoutes(app: FastifyInstance): void {
  // SSE stream cho một phiên — member (player hoặc admin của bank)
  app.get("/api/v1/sessions/:id/events", async (req, reply) => {
    const sessionId = Number((req.params as { id: string }).id);
    if (!getSessionOr404(app, sessionId)) {
      return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
    }
    if (!req.principal || !isSessionMember(app.db, req.principal, sessionId)) return deny(app, req, reply, sessionId);

    const playerId = req.principal.type === "player" ? req.principal.id : null;

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    const client = app.events.subscribe(sessionId, playerId, reply.raw);
    req.raw.on("close", () => app.events.unsubscribe(client));
  });

  app.get(
    "/api/v1/sessions/:id/notifications",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const sessionId = Number((req.params as { id: string }).id);
      const { limit } = req.query as { limit: number };
      if (!getSessionOr404(app, sessionId)) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
      }
      if (!req.principal || !isSessionMember(app.db, req.principal, sessionId)) return deny(app, req, reply, sessionId);

      if (req.principal.type === "player") {
        const pid = req.principal.id;
        const rows = app.db
          .prepare(
            `SELECT * FROM notifications WHERE session_id=? AND (player_id=? OR player_id IS NULL)
             ORDER BY id DESC LIMIT ?`,
          )
          .all(sessionId, pid, limit);
        const unread = app.db
          .prepare(
            `SELECT COUNT(*) AS c FROM notifications
             WHERE session_id=? AND (player_id=? OR player_id IS NULL) AND read_at IS NULL`,
          )
          .get(sessionId, pid) as { c: number };
        return { ok: true, data: rows, meta: { unread: unread.c } };
      }
      const rows = app.db
        .prepare("SELECT * FROM notifications WHERE session_id=? ORDER BY id DESC LIMIT ?")
        .all(sessionId, limit);
      return { ok: true, data: rows, meta: { unread: 0 } };
    },
  );

  // Đánh dấu đã đọc toàn bộ thông báo của người chơi hiện tại
  app.post("/api/v1/sessions/:id/notifications/read", async (req, reply) => {
    const sessionId = Number((req.params as { id: string }).id);
    if (!getSessionOr404(app, sessionId)) {
      return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
    }
    if (!req.principal || req.principal.type !== "player" || req.principal.sessionId !== sessionId) {
      return deny(app, req, reply, sessionId);
    }
    app.db
      .prepare(
        `UPDATE notifications SET read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE session_id=? AND (player_id=? OR player_id IS NULL) AND read_at IS NULL`,
      )
      .run(sessionId, req.principal.id);
    return { ok: true, data: null };
  });
}
