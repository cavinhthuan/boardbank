import type { FastifyInstance } from "fastify";
import { LedgerError } from "../ledger.js";
import { logAudit } from "../lib/audit.js";
import { getSessionOr404 } from "./sessions.js";
import { deny, isSessionAdmin } from "../auth.js";
import { createPlayer } from "../services/playerService.js";

export function playerRoutes(app: FastifyInstance): void {
  app.post(
    "/api/v1/sessions/:id/players",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        body: {
          type: "object",
          required: ["displayName"],
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 40 },
            avatar: { type: "string", maxLength: 8 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const sessionId = (req.params as { id: number }).id;
      const { displayName, avatar } = req.body as { displayName: string; avatar?: string };
      if (!getSessionOr404(app, sessionId)) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
      }
      if (!req.principal || !isSessionAdmin(app.db, req.principal, sessionId)) return deny(app, req, reply, sessionId);

      try {
        const player = createPlayer(app.db, sessionId, displayName, avatar);
        logAudit(app.db, {
          sessionId,
          actorType: req.principal.type,
          actorId: req.principal.id,
          action: "player.create",
          target: `player:${player.id}`,
        });
        reply.status(201).send({ ok: true, data: player });
      } catch (err) {
        if (err instanceof LedgerError) {
          return reply.status(err.statusCode).send({ ok: false, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  app.post(
    "/api/v1/sessions/:id/players/:playerId/lock",
    {
      schema: {
        body: {
          type: "object",
          required: ["locked"],
          properties: { locked: { type: "boolean" } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { id, playerId } = req.params as { id: string; playerId: string };
      const sessionId = Number(id);
      const pid = Number(playerId);
      const { locked } = req.body as { locked: boolean };
      if (!getSessionOr404(app, sessionId)) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
      }
      if (!req.principal || !isSessionAdmin(app.db, req.principal, sessionId)) return deny(app, req, reply, sessionId);

      const player = app.db
        .prepare("SELECT id, status FROM players WHERE id=? AND session_id=? AND status != 'removed'")
        .get(pid, sessionId) as { id: number; status: string } | undefined;
      if (!player) {
        return reply.status(404).send({ ok: false, error: { code: "PLAYER_NOT_FOUND", message: "Người chơi không tồn tại" } });
      }
      app.db.prepare("UPDATE players SET status=? WHERE id=?").run(locked ? "locked" : "active", pid);
      logAudit(app.db, {
        sessionId,
        actorType: req.principal.type,
        actorId: req.principal.id,
        action: locked ? "player.lock" : "player.unlock",
        target: `player:${pid}`,
      });
      return { ok: true, data: { id: pid, status: locked ? "locked" : "active" } };
    },
  );

  app.delete("/api/v1/sessions/:id/players/:playerId", async (req, reply) => {
    const { id, playerId } = req.params as { id: string; playerId: string };
    const sessionId = Number(id);
    const pid = Number(playerId);
    if (!getSessionOr404(app, sessionId)) {
      return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
    }
    if (!req.principal || !isSessionAdmin(app.db, req.principal, sessionId)) return deny(app, req, reply, sessionId);

    const player = app.db
      .prepare("SELECT id FROM players WHERE id=? AND session_id=? AND status != 'removed'")
      .get(pid, sessionId);
    if (!player) {
      return reply.status(404).send({ ok: false, error: { code: "PLAYER_NOT_FOUND", message: "Người chơi không tồn tại" } });
    }

    const hasEntries = app.db
      .prepare(
        `SELECT 1 FROM transaction_entries e
         JOIN accounts a ON a.id = e.account_id
         WHERE a.session_id=? AND a.owner_type='player' AND a.owner_id=? LIMIT 1`,
      )
      .get(sessionId, pid);

    if (hasEntries) {
      // Đã có giao dịch → chỉ vô hiệu hóa, giữ toàn vẹn sổ cái (không dữ liệu mồ côi)
      app.db.prepare("UPDATE players SET status='removed' WHERE id=?").run(pid);
      logAudit(app.db, {
        sessionId,
        actorType: req.principal.type,
        actorId: req.principal.id,
        action: "player.soft_remove",
        target: `player:${pid}`,
      });
      return { ok: true, data: { removed: "soft" } };
    }
    app.db.transaction(() => {
      app.db.prepare("DELETE FROM accounts WHERE session_id=? AND owner_type='player' AND owner_id=?").run(sessionId, pid);
      app.db.prepare("DELETE FROM players WHERE id=?").run(pid);
    })();
    logAudit(app.db, {
      sessionId,
      actorType: req.principal.type,
      actorId: req.principal.id,
      action: "player.delete",
      target: `player:${pid}`,
    });
    return { ok: true, data: { removed: "hard" } };
  });
}
