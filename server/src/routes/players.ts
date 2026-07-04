import type { FastifyInstance } from "fastify";
import { ensureAccount, postTransaction } from "../ledger.js";
import { logAudit } from "../lib/audit.js";
import { getSessionOr404 } from "./sessions.js";

const DEFAULT_AVATARS = ["🦊", "🐼", "🦁", "🐸", "🐙", "🦄", "🐯", "🐨", "🐧", "🦖"];

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
      const session = getSessionOr404(app, sessionId);
      if (!session) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
      }
      if (session.status === "ended") {
        return reply.status(422).send({ ok: false, error: { code: "SESSION_ENDED", message: "Phiên đã kết thúc" } });
      }

      const dup = app.db
        .prepare("SELECT id FROM players WHERE session_id=? AND display_name=?")
        .get(sessionId, displayName.trim());
      if (dup) {
        return reply.status(409).send({ ok: false, error: { code: "NAME_TAKEN", message: "Tên đã được dùng trong phiên này" } });
      }

      const config = JSON.parse(session.config_json) as { initialBalance?: number };
      const initial = config.initialBalance ?? 0;

      const playerId = app.db.transaction(() => {
        const pickedAvatar =
          avatar ??
          DEFAULT_AVATARS[
            (app.db.prepare("SELECT COUNT(*) AS c FROM players WHERE session_id=?").get(sessionId) as { c: number }).c %
              DEFAULT_AVATARS.length
          ];
        const pr = app.db
          .prepare("INSERT INTO players (session_id, display_name, avatar) VALUES (?,?,?)")
          .run(sessionId, displayName.trim(), pickedAvatar);
        const pid = Number(pr.lastInsertRowid);

        const assets = app.db
          .prepare("SELECT id, is_primary FROM asset_types WHERE session_id=?")
          .all(sessionId) as { id: number; is_primary: number }[];
        for (const asset of assets) {
          const accId = ensureAccount(app.db, sessionId, "player", pid, asset.id);
          if (asset.is_primary && initial > 0) {
            const bankAccId = ensureAccount(app.db, sessionId, "bank", 0, asset.id);
            postTransaction(app.db, {
              sessionId,
              type: "issue",
              note: "Cấp số dư ban đầu",
              createdBy: "admin",
              entries: [
                { accountId: bankAccId, assetTypeId: asset.id, amount: -initial },
                { accountId: accId, assetTypeId: asset.id, amount: initial },
              ],
            });
          }
        }
        return pid;
      })();

      logAudit(app.db, { sessionId, actorType: "admin", action: "player.create", target: `player:${playerId}` });
      const player = app.db.prepare("SELECT * FROM players WHERE id=?").get(playerId);
      reply.status(201).send({ ok: true, data: player });
    },
  );

  app.delete("/api/v1/sessions/:id/players/:playerId", async (req, reply) => {
    const { id, playerId } = req.params as { id: string; playerId: string };
    const sessionId = Number(id);
    const pid = Number(playerId);
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
      logAudit(app.db, { sessionId, actorType: "admin", action: "player.soft_remove", target: `player:${pid}` });
      return { ok: true, data: { removed: "soft" } };
    }
    app.db.transaction(() => {
      app.db.prepare("DELETE FROM accounts WHERE session_id=? AND owner_type='player' AND owner_id=?").run(sessionId, pid);
      app.db.prepare("DELETE FROM players WHERE id=?").run(pid);
    })();
    logAudit(app.db, { sessionId, actorType: "admin", action: "player.delete", target: `player:${pid}` });
    return { ok: true, data: { removed: "hard" } };
  });
}
