import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deny, type PlayerPrincipal } from "../auth.js";
import { getSessionOr404 } from "./sessions.js";

const MAX_TEMPLATES = 10;

/** Các endpoint /me/* chỉ dành cho người chơi của đúng phiên đó. */
function requirePlayer(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  sessionId: number,
): PlayerPrincipal | null {
  if (!getSessionOr404(app, sessionId)) {
    reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
    return null;
  }
  if (!req.principal || req.principal.type !== "player" || req.principal.sessionId !== sessionId) {
    deny(app, req, reply, sessionId);
    return null;
  }
  return req.principal;
}

export function personalRoutes(app: FastifyInstance): void {
  // Một call trả đủ dữ liệu cá nhân hóa: yêu thích + hay gửi nhất + mẫu giao dịch
  app.get("/api/v1/sessions/:id/me/quick", async (req, reply) => {
    const sessionId = Number((req.params as { id: string }).id);
    const me = requirePlayer(app, req, reply, sessionId);
    if (!me) return;

    const favorites = (
      app.db
        .prepare(
          `SELECT f.favorite_player_id AS id FROM player_favorites f
           JOIN players p ON p.id = f.favorite_player_id AND p.status = 'active'
           WHERE f.player_id=? ORDER BY f.id`,
        )
        .all(me.id) as { id: number }[]
    ).map((r) => r.id);

    const frequent = app.db
      .prepare(
        `SELECT a.owner_id AS playerId, COUNT(*) AS cnt
         FROM transactions t
         JOIN transaction_entries e ON e.transaction_id = t.id
         JOIN accounts a ON a.id = e.account_id
         JOIN players p ON p.id = a.owner_id AND p.status = 'active'
         WHERE t.session_id=? AND t.created_by=? AND t.type='transfer'
           AND e.amount > 0 AND a.owner_type='player'
         GROUP BY a.owner_id ORDER BY cnt DESC, MAX(t.id) DESC LIMIT 5`,
      )
      .all(sessionId, `player:${me.id}`);

    const templates = app.db
      .prepare(
        `SELECT t.id, t.to_player_id, t.asset_type_id, t.amount, t.note,
                p.display_name AS to_name, p.avatar AS to_avatar
         FROM tx_templates t JOIN players p ON p.id = t.to_player_id
         WHERE t.player_id=? AND p.status='active' ORDER BY t.id`,
      )
      .all(me.id);

    return { ok: true, data: { favorites, frequent, templates } };
  });

  app.put("/api/v1/sessions/:id/me/favorites/:playerId", async (req, reply) => {
    const { id, playerId } = req.params as { id: string; playerId: string };
    const sessionId = Number(id);
    const target = Number(playerId);
    const me = requirePlayer(app, req, reply, sessionId);
    if (!me) return;
    if (target === me.id) {
      return reply.status(422).send({ ok: false, error: { code: "SELF_FAVORITE", message: "Không thể tự yêu thích chính mình" } });
    }
    const exists = app.db
      .prepare("SELECT id FROM players WHERE id=? AND session_id=? AND status != 'removed'")
      .get(target, sessionId);
    if (!exists) {
      return reply.status(404).send({ ok: false, error: { code: "PLAYER_NOT_FOUND", message: "Người chơi không tồn tại" } });
    }
    app.db
      .prepare("INSERT OR IGNORE INTO player_favorites (session_id, player_id, favorite_player_id) VALUES (?,?,?)")
      .run(sessionId, me.id, target);
    return { ok: true, data: { favorite: target } };
  });

  app.delete("/api/v1/sessions/:id/me/favorites/:playerId", async (req, reply) => {
    const { id, playerId } = req.params as { id: string; playerId: string };
    const me = requirePlayer(app, req, reply, Number(id));
    if (!me) return;
    app.db.prepare("DELETE FROM player_favorites WHERE player_id=? AND favorite_player_id=?").run(me.id, Number(playerId));
    return { ok: true, data: null };
  });

  app.post(
    "/api/v1/sessions/:id/me/templates",
    {
      schema: {
        body: {
          type: "object",
          required: ["toPlayerId", "amount"],
          properties: {
            toPlayerId: { type: "integer" },
            assetTypeId: { type: "integer" },
            amount: { type: "integer", minimum: 1, maximum: 1_000_000_000_000 },
            note: { type: "string", maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const sessionId = Number((req.params as { id: string }).id);
      const me = requirePlayer(app, req, reply, sessionId);
      if (!me) return;
      const body = req.body as { toPlayerId: number; assetTypeId?: number; amount: number; note?: string };

      const count = (app.db.prepare("SELECT COUNT(*) AS c FROM tx_templates WHERE player_id=?").get(me.id) as { c: number }).c;
      if (count >= MAX_TEMPLATES) {
        return reply
          .status(422)
          .send({ ok: false, error: { code: "TEMPLATE_LIMIT", message: `Tối đa ${MAX_TEMPLATES} mẫu — hãy xóa bớt` } });
      }
      const target = app.db
        .prepare("SELECT id FROM players WHERE id=? AND session_id=? AND status != 'removed'")
        .get(body.toPlayerId, sessionId);
      if (!target || body.toPlayerId === me.id) {
        return reply.status(404).send({ ok: false, error: { code: "PLAYER_NOT_FOUND", message: "Người nhận không hợp lệ" } });
      }
      const asset = body.assetTypeId
        ? app.db.prepare("SELECT id FROM asset_types WHERE id=? AND session_id=? AND status='active'").get(body.assetTypeId, sessionId)
        : app.db.prepare("SELECT id FROM asset_types WHERE session_id=? AND is_primary=1").get(sessionId);
      if (!asset) {
        return reply.status(404).send({ ok: false, error: { code: "ASSET_NOT_FOUND", message: "Tài sản không tồn tại" } });
      }
      const r = app.db
        .prepare("INSERT INTO tx_templates (session_id, player_id, to_player_id, asset_type_id, amount, note) VALUES (?,?,?,?,?,?)")
        .run(sessionId, me.id, body.toPlayerId, (asset as { id: number }).id, body.amount, body.note ?? null);
      const template = app.db.prepare("SELECT * FROM tx_templates WHERE id=?").get(r.lastInsertRowid);
      reply.status(201).send({ ok: true, data: template });
    },
  );

  app.delete("/api/v1/sessions/:id/me/templates/:templateId", async (req, reply) => {
    const { id, templateId } = req.params as { id: string; templateId: string };
    const me = requirePlayer(app, req, reply, Number(id));
    if (!me) return;
    const r = app.db.prepare("DELETE FROM tx_templates WHERE id=? AND player_id=?").run(Number(templateId), me.id);
    if (r.changes === 0) {
      return reply.status(404).send({ ok: false, error: { code: "TEMPLATE_NOT_FOUND", message: "Mẫu không tồn tại" } });
    }
    return { ok: true, data: null };
  });
}
