import type { FastifyInstance } from "fastify";
import { LedgerError, ensureAccount, postTransaction, reverseTransaction, type EntryInput } from "../ledger.js";
import { logAudit } from "../lib/audit.js";
import { getSessionOr404 } from "./sessions.js";

// Các loại giao dịch Phase 2. Tất cả đều là tổ hợp entries của cùng một engine:
//   transfer        người chơi → người chơi
//   issue | reward  kho bạc bank → người chơi (phát hành / thưởng)
//   recall | penalty người chơi → kho bạc bank (thu hồi / phạt)
//   adjust          admin điều chỉnh ±delta (cho phép âm)
const PLAYER_TO_PLAYER = new Set(["transfer"]);
const BANK_TO_PLAYER = new Set(["issue", "reward"]);
const PLAYER_TO_BANK = new Set(["recall", "penalty"]);

interface CreateTxBody {
  type: string;
  amount?: number;
  delta?: number;
  fromPlayerId?: number;
  toPlayerId?: number;
  playerId?: number;
  assetTypeId?: number;
  note?: string;
  idempotencyKey?: string;
}

function getActivePlayer(app: FastifyInstance, sessionId: number, playerId: number) {
  return app.db
    .prepare("SELECT id, display_name, status FROM players WHERE id=? AND session_id=? AND status != 'removed'")
    .get(playerId, sessionId) as { id: number; display_name: string; status: string } | undefined;
}

export function transactionRoutes(app: FastifyInstance): void {
  app.post(
    "/api/v1/sessions/:id/transactions",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        body: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["transfer", "issue", "reward", "recall", "penalty", "adjust"] },
            amount: { type: "integer", minimum: 1, maximum: 1_000_000_000_000 },
            delta: { type: "integer", minimum: -1_000_000_000_000, maximum: 1_000_000_000_000 },
            fromPlayerId: { type: "integer" },
            toPlayerId: { type: "integer" },
            playerId: { type: "integer" },
            assetTypeId: { type: "integer" },
            note: { type: "string", maxLength: 200 },
            idempotencyKey: { type: "string", minLength: 8, maxLength: 64 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const sessionId = (req.params as { id: number }).id;
      const body = req.body as CreateTxBody;
      const session = getSessionOr404(app, sessionId);
      if (!session) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
      }
      if (session.status === "ended") {
        return reply.status(422).send({ ok: false, error: { code: "SESSION_ENDED", message: "Phiên đã kết thúc" } });
      }
      const config = JSON.parse(session.config_json) as { allowNegative?: boolean };

      // Tài sản: mặc định là tài sản chính của phiên
      const asset = body.assetTypeId
        ? (app.db.prepare("SELECT id FROM asset_types WHERE id=? AND session_id=?").get(body.assetTypeId, sessionId) as
            | { id: number }
            | undefined)
        : (app.db.prepare("SELECT id FROM asset_types WHERE session_id=? AND is_primary=1").get(sessionId) as
            | { id: number }
            | undefined);
      if (!asset) {
        return reply.status(404).send({ ok: false, error: { code: "ASSET_NOT_FOUND", message: "Loại tài sản không tồn tại trong phiên" } });
      }

      const fail = (code: string, message: string, status = 400) =>
        reply.status(status).send({ ok: false, error: { code, message } });

      const entries: EntryInput[] = [];
      const allowNegative: number[] = [];

      try {
        if (PLAYER_TO_PLAYER.has(body.type)) {
          if (!body.amount) return fail("MISSING_FIELD", "Thiếu amount");
          if (!body.fromPlayerId || !body.toPlayerId) return fail("MISSING_FIELD", "Thiếu fromPlayerId/toPlayerId");
          if (body.fromPlayerId === body.toPlayerId) return fail("SELF_TRANSFER", "Không thể tự chuyển cho chính mình");
          const from = getActivePlayer(app, sessionId, body.fromPlayerId);
          const to = getActivePlayer(app, sessionId, body.toPlayerId);
          if (!from || !to) return fail("PLAYER_NOT_FOUND", "Người chơi không tồn tại", 404);
          if (from.status === "locked") return fail("ACCOUNT_LOCKED", "Tài khoản gửi đang bị khóa", 422);
          const fromAcc = ensureAccount(app.db, sessionId, "player", from.id, asset.id);
          const toAcc = ensureAccount(app.db, sessionId, "player", to.id, asset.id);
          entries.push(
            { accountId: fromAcc, assetTypeId: asset.id, amount: -body.amount },
            { accountId: toAcc, assetTypeId: asset.id, amount: body.amount },
          );
          if (config.allowNegative) allowNegative.push(fromAcc);
        } else if (BANK_TO_PLAYER.has(body.type) || PLAYER_TO_BANK.has(body.type)) {
          if (!body.amount) return fail("MISSING_FIELD", "Thiếu amount");
          const pid = BANK_TO_PLAYER.has(body.type) ? body.toPlayerId : body.fromPlayerId;
          if (!pid) return fail("MISSING_FIELD", "Thiếu người chơi");
          const player = getActivePlayer(app, sessionId, pid);
          if (!player) return fail("PLAYER_NOT_FOUND", "Người chơi không tồn tại", 404);
          const playerAcc = ensureAccount(app.db, sessionId, "player", player.id, asset.id);
          const bankAcc = ensureAccount(app.db, sessionId, "bank", 0, asset.id);
          const sign = BANK_TO_PLAYER.has(body.type) ? 1 : -1;
          entries.push(
            { accountId: bankAcc, assetTypeId: asset.id, amount: -sign * body.amount },
            { accountId: playerAcc, assetTypeId: asset.id, amount: sign * body.amount },
          );
        } else {
          // adjust
          if (!body.delta) return fail("MISSING_FIELD", "Thiếu delta (khác 0)");
          if (!body.playerId) return fail("MISSING_FIELD", "Thiếu playerId");
          const player = getActivePlayer(app, sessionId, body.playerId);
          if (!player) return fail("PLAYER_NOT_FOUND", "Người chơi không tồn tại", 404);
          const playerAcc = ensureAccount(app.db, sessionId, "player", player.id, asset.id);
          const bankAcc = ensureAccount(app.db, sessionId, "bank", 0, asset.id);
          entries.push(
            { accountId: bankAcc, assetTypeId: asset.id, amount: -body.delta },
            { accountId: playerAcc, assetTypeId: asset.id, amount: body.delta },
          );
          allowNegative.push(playerAcc); // admin điều chỉnh được phép đưa số dư về âm
        }

        const tx = postTransaction(app.db, {
          sessionId,
          type: body.type,
          note: body.note,
          createdBy: "admin",
          idempotencyKey: body.idempotencyKey,
          entries,
          allowNegative,
        });
        logAudit(app.db, { sessionId, actorType: "admin", action: `tx.${body.type}`, target: `tx:${tx.id}`, detail: body });
        reply.status(201).send({ ok: true, data: tx });
      } catch (err) {
        if (err instanceof LedgerError) {
          return reply.status(err.statusCode).send({ ok: false, error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  app.post("/api/v1/sessions/:id/transactions/:txId/reverse", async (req, reply) => {
    const { id, txId } = req.params as { id: string; txId: string };
    const sessionId = Number(id);
    const session = getSessionOr404(app, sessionId);
    if (!session) {
      return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
    }
    try {
      const reversal = reverseTransaction(app.db, sessionId, Number(txId), "admin");
      logAudit(app.db, { sessionId, actorType: "admin", action: "tx.reverse", target: `tx:${txId}`, detail: { reversalId: reversal.id } });
      reply.status(201).send({ ok: true, data: reversal });
    } catch (err) {
      if (err instanceof LedgerError) {
        return reply.status(err.statusCode).send({ ok: false, error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  app.get(
    "/api/v1/sessions/:id/transactions",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            before: { type: "integer" },
            playerId: { type: "integer" },
            type: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const sessionId = Number((req.params as { id: string }).id);
      const q = req.query as { limit: number; before?: number; playerId?: number; type?: string };
      if (!getSessionOr404(app, sessionId)) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
      }

      const conds = ["t.session_id = ?"];
      const params: unknown[] = [sessionId];
      if (q.before) {
        conds.push("t.id < ?");
        params.push(q.before);
      }
      if (q.type) {
        conds.push("t.type = ?");
        params.push(q.type);
      }
      if (q.playerId) {
        conds.push(
          `EXISTS (SELECT 1 FROM transaction_entries e JOIN accounts a ON a.id=e.account_id
                   WHERE e.transaction_id=t.id AND a.owner_type='player' AND a.owner_id=?)`,
        );
        params.push(q.playerId);
      }

      const txs = app.db
        .prepare(
          `SELECT t.id, t.code, t.type, t.status, t.note, t.created_by, t.reversed_by_tx_id, t.created_at
           FROM transactions t WHERE ${conds.join(" AND ")} ORDER BY t.id DESC LIMIT ?`,
        )
        .all(...params, q.limit) as { id: number }[];

      const getEntries = app.db.prepare(
        `SELECT e.amount, e.asset_type_id, a.owner_type, a.owner_id,
                CASE WHEN a.owner_type='player' THEN (SELECT display_name FROM players p WHERE p.id=a.owner_id) ELSE 'Ngân hàng' END AS owner_name
         FROM transaction_entries e JOIN accounts a ON a.id=e.account_id
         WHERE e.transaction_id=? ORDER BY e.amount`,
      );
      const data = txs.map((t) => ({ ...t, entries: getEntries.all(t.id) }));
      return { ok: true, data, meta: { nextBefore: txs.length === q.limit ? txs[txs.length - 1]!.id : null } };
    },
  );
}
