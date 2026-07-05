import type { FastifyInstance, FastifyReply } from "fastify";
import { LedgerError, ensureAccount, postTransaction } from "../ledger.js";
import { logAudit } from "../lib/audit.js";
import { getSessionOr404 } from "./sessions.js";
import { deny, isSessionAdmin, isSessionMember, verifyPin } from "../auth.js";
import { emitTxEvents } from "../events.js";

function sendLedgerError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof LedgerError) {
    return reply.status(err.statusCode).send({ ok: false, error: { code: err.code, message: err.message } });
  }
  throw err;
}

interface RateRow {
  rate_num: number;
  rate_den: number;
}

/** Tìm tỷ giá cho cặp tài sản: ưu tiên chiều thuận, tự nghịch đảo chiều ngược (phân số → chính xác). */
export function findRate(
  app: FastifyInstance,
  sessionId: number,
  fromAssetId: number,
  toAssetId: number,
): { num: number; den: number } | null {
  const direct = app.db
    .prepare("SELECT rate_num, rate_den FROM exchange_rates WHERE session_id=? AND from_asset_id=? AND to_asset_id=?")
    .get(sessionId, fromAssetId, toAssetId) as RateRow | undefined;
  if (direct) return { num: direct.rate_num, den: direct.rate_den };
  const reverse = app.db
    .prepare("SELECT rate_num, rate_den FROM exchange_rates WHERE session_id=? AND from_asset_id=? AND to_asset_id=?")
    .get(sessionId, toAssetId, fromAssetId) as RateRow | undefined;
  if (reverse) return { num: reverse.rate_den, den: reverse.rate_num };
  return null;
}

/** Quy tắc làm tròn quy đổi DUY NHẤT của hệ thống: floor(amount * num / den), tính bằng BigInt. */
export function convertAmount(amount: number, num: number, den: number): number {
  return Number((BigInt(amount) * BigInt(num)) / BigInt(den));
}

export function assetRoutes(app: FastifyInstance): void {
  app.post(
    "/api/v1/sessions/:id/assets",
    {
      schema: {
        body: {
          type: "object",
          required: ["code", "name"],
          properties: {
            code: { type: "string", minLength: 1, maxLength: 10, pattern: "^[A-Za-z0-9_]+$" },
            name: { type: "string", minLength: 1, maxLength: 40 },
            icon: { type: "string", maxLength: 8, default: "🪙" },
            decimals: { type: "integer", minimum: 0, maximum: 6, default: 0 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const sessionId = Number((req.params as { id: string }).id);
      const body = req.body as { code: string; name: string; icon: string; decimals: number };
      if (!getSessionOr404(app, sessionId)) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
      }
      if (!req.principal || !isSessionAdmin(app.db, req.principal, sessionId)) return deny(app, req, reply, sessionId);

      const code = body.code.toUpperCase();
      const dup = app.db.prepare("SELECT id FROM asset_types WHERE session_id=? AND code=?").get(sessionId, code);
      if (dup) {
        return reply.status(409).send({ ok: false, error: { code: "ASSET_CODE_TAKEN", message: "Mã tài sản đã tồn tại trong phiên" } });
      }
      const assetId = app.db.transaction(() => {
        const r = app.db
          .prepare("INSERT INTO asset_types (session_id, code, name, icon, decimals, is_primary) VALUES (?,?,?,?,?,0)")
          .run(sessionId, code, body.name.trim(), body.icon, body.decimals);
        const id = Number(r.lastInsertRowid);
        ensureAccount(app.db, sessionId, "bank", 0, id); // kho bạc cho tài sản mới
        return id;
      })();
      logAudit(app.db, {
        sessionId,
        actorType: req.principal.type,
        actorId: req.principal.id,
        action: "asset.create",
        target: `asset:${assetId}`,
      });
      app.events.publish(sessionId, { type: "players", data: {} }); // client refetch chi tiết phiên
      const asset = app.db.prepare("SELECT * FROM asset_types WHERE id=?").get(assetId);
      reply.status(201).send({ ok: true, data: asset });
    },
  );

  app.delete("/api/v1/sessions/:id/assets/:assetId", async (req, reply) => {
    const { id, assetId } = req.params as { id: string; assetId: string };
    const sessionId = Number(id);
    const aid = Number(assetId);
    if (!getSessionOr404(app, sessionId)) {
      return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
    }
    if (!req.principal || !isSessionAdmin(app.db, req.principal, sessionId)) return deny(app, req, reply, sessionId);
    const asset = app.db
      .prepare("SELECT id, is_primary, status FROM asset_types WHERE id=? AND session_id=?")
      .get(aid, sessionId) as { id: number; is_primary: number; status: string } | undefined;
    if (!asset || asset.status === "hidden") {
      return reply.status(404).send({ ok: false, error: { code: "ASSET_NOT_FOUND", message: "Tài sản không tồn tại" } });
    }
    if (asset.is_primary) {
      return reply.status(422).send({ ok: false, error: { code: "PRIMARY_ASSET", message: "Không thể xóa tài sản chính của phiên" } });
    }

    const hasEntries = app.db
      .prepare("SELECT 1 FROM transaction_entries WHERE asset_type_id=? LIMIT 1")
      .get(aid);
    if (hasEntries) {
      // Đã có giao dịch → chỉ ẩn, giữ toàn vẹn sổ cái
      app.db.prepare("UPDATE asset_types SET status='hidden' WHERE id=?").run(aid);
      logAudit(app.db, { sessionId, actorType: req.principal.type, actorId: req.principal.id, action: "asset.hide", target: `asset:${aid}` });
      app.events.publish(sessionId, { type: "players", data: {} });
      return { ok: true, data: { removed: "hidden" } };
    }
    app.db.transaction(() => {
      app.db.prepare("DELETE FROM exchange_rates WHERE session_id=? AND (from_asset_id=? OR to_asset_id=?)").run(sessionId, aid, aid);
      app.db.prepare("DELETE FROM accounts WHERE session_id=? AND asset_type_id=?").run(sessionId, aid);
      app.db.prepare("DELETE FROM asset_types WHERE id=?").run(aid);
    })();
    logAudit(app.db, { sessionId, actorType: req.principal.type, actorId: req.principal.id, action: "asset.delete", target: `asset:${aid}` });
    app.events.publish(sessionId, { type: "players", data: {} });
    return { ok: true, data: { removed: "hard" } };
  });

  // Đặt/cập nhật tỷ giá: to = from * rateNum / rateDen
  app.put(
    "/api/v1/sessions/:id/rates",
    {
      schema: {
        body: {
          type: "object",
          required: ["fromAssetId", "toAssetId", "rateNum", "rateDen"],
          properties: {
            fromAssetId: { type: "integer" },
            toAssetId: { type: "integer" },
            rateNum: { type: "integer", minimum: 1, maximum: 1_000_000_000 },
            rateDen: { type: "integer", minimum: 1, maximum: 1_000_000_000 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const sessionId = Number((req.params as { id: string }).id);
      const body = req.body as { fromAssetId: number; toAssetId: number; rateNum: number; rateDen: number };
      if (!getSessionOr404(app, sessionId)) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
      }
      if (!req.principal || !isSessionAdmin(app.db, req.principal, sessionId)) return deny(app, req, reply, sessionId);
      if (body.fromAssetId === body.toAssetId) {
        return reply.status(400).send({ ok: false, error: { code: "SAME_ASSET", message: "Hai tài sản phải khác nhau" } });
      }
      for (const aid of [body.fromAssetId, body.toAssetId]) {
        const a = app.db.prepare("SELECT id FROM asset_types WHERE id=? AND session_id=? AND status='active'").get(aid, sessionId);
        if (!a) {
          return reply.status(404).send({ ok: false, error: { code: "ASSET_NOT_FOUND", message: "Tài sản không tồn tại" } });
        }
      }
      app.db
        .prepare(
          `INSERT INTO exchange_rates (session_id, from_asset_id, to_asset_id, rate_num, rate_den, updated_by, updated_at)
           VALUES (?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(session_id, from_asset_id, to_asset_id)
           DO UPDATE SET rate_num=excluded.rate_num, rate_den=excluded.rate_den,
                         updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
        )
        .run(sessionId, body.fromAssetId, body.toAssetId, body.rateNum, body.rateDen, `${req.principal.type}:${req.principal.id}`);
      logAudit(app.db, { sessionId, actorType: req.principal.type, actorId: req.principal.id, action: "rate.set", detail: body });
      app.events.publish(sessionId, { type: "players", data: {} });
      const rate = app.db
        .prepare("SELECT * FROM exchange_rates WHERE session_id=? AND from_asset_id=? AND to_asset_id=?")
        .get(sessionId, body.fromAssetId, body.toAssetId);
      return { ok: true, data: rate };
    },
  );

  app.get("/api/v1/sessions/:id/rates", async (req, reply) => {
    const sessionId = Number((req.params as { id: string }).id);
    if (!getSessionOr404(app, sessionId)) {
      return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
    }
    if (!req.principal || !isSessionMember(app.db, req.principal, sessionId)) return deny(app, req, reply, sessionId);
    const rates = app.db.prepare("SELECT * FROM exchange_rates WHERE session_id=?").all(sessionId);
    return { ok: true, data: rates };
  });

  // Quy đổi tài sản: người chơi (chính mình + PIN) hoặc admin (bất kỳ ai)
  app.post(
    "/api/v1/sessions/:id/exchange",
    {
      schema: {
        body: {
          type: "object",
          required: ["playerId", "fromAssetId", "toAssetId", "amount"],
          properties: {
            playerId: { type: "integer" },
            fromAssetId: { type: "integer" },
            toAssetId: { type: "integer" },
            amount: { type: "integer", minimum: 1, maximum: 1_000_000_000_000 },
            pin: { type: "string", pattern: "^[0-9]{4,6}$" },
            idempotencyKey: { type: "string", minLength: 8, maxLength: 64 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const sessionId = Number((req.params as { id: string }).id);
      const body = req.body as {
        playerId: number;
        fromAssetId: number;
        toAssetId: number;
        amount: number;
        pin?: string;
        idempotencyKey?: string;
      };
      const session = getSessionOr404(app, sessionId);
      if (!session) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
      }
      if (session.status === "ended") {
        return reply.status(422).send({ ok: false, error: { code: "SESSION_ENDED", message: "Phiên đã kết thúc" } });
      }
      const principal = req.principal;
      if (!principal) return deny(app, req, reply, sessionId);
      const admin = isSessionAdmin(app.db, principal, sessionId);
      if (!admin) {
        if (principal.type !== "player" || principal.sessionId !== sessionId || body.playerId !== principal.id) {
          return deny(app, req, reply, sessionId);
        }
        if (session.status !== "active") {
          return reply
            .status(422)
            .send({ ok: false, error: { code: "SESSION_NOT_ACTIVE", message: "Phiên chưa bắt đầu hoặc đang tạm dừng" } });
        }
        const cfg = JSON.parse(session.config_json) as { disabledTxTypes?: string[] };
        if (cfg.disabledTxTypes?.includes("exchange")) {
          return reply
            .status(422)
            .send({ ok: false, error: { code: "TX_TYPE_DISABLED", message: "Quy đổi đang bị tắt trong phiên" } });
        }
        try {
          if (!body.pin) throw new LedgerError("PIN_REQUIRED", "Cần nhập PIN để xác nhận giao dịch", 422);
          verifyPin(app.db, principal.id, body.pin);
        } catch (err) {
          return sendLedgerError(reply, err);
        }
      }

      const player = app.db
        .prepare("SELECT id, status FROM players WHERE id=? AND session_id=? AND status='active'")
        .get(body.playerId, sessionId) as { id: number } | undefined;
      if (!player) {
        return reply.status(404).send({ ok: false, error: { code: "PLAYER_NOT_FOUND", message: "Người chơi không hợp lệ hoặc đang bị khóa" } });
      }
      for (const aid of [body.fromAssetId, body.toAssetId]) {
        const a = app.db.prepare("SELECT id FROM asset_types WHERE id=? AND session_id=? AND status='active'").get(aid, sessionId);
        if (!a) {
          return reply.status(404).send({ ok: false, error: { code: "ASSET_NOT_FOUND", message: "Tài sản không tồn tại" } });
        }
      }
      const rate = findRate(app, sessionId, body.fromAssetId, body.toAssetId);
      if (!rate) {
        return reply.status(422).send({ ok: false, error: { code: "NO_RATE", message: "Chưa thiết lập tỷ giá cho cặp tài sản này" } });
      }
      const toAmount = convertAmount(body.amount, rate.num, rate.den);
      if (toAmount < 1) {
        return reply.status(422).send({ ok: false, error: { code: "EXCHANGE_TOO_SMALL", message: "Số lượng quá nhỏ để quy đổi" } });
      }

      try {
        const fromAcc = ensureAccount(app.db, sessionId, "player", player.id, body.fromAssetId);
        const toAcc = ensureAccount(app.db, sessionId, "player", player.id, body.toAssetId);
        const bankFrom = ensureAccount(app.db, sessionId, "bank", 0, body.fromAssetId);
        const bankTo = ensureAccount(app.db, sessionId, "bank", 0, body.toAssetId);
        const tx = postTransaction(app.db, {
          sessionId,
          type: "exchange",
          createdBy: `${principal.type}:${principal.id}`,
          idempotencyKey: body.idempotencyKey,
          // Snapshot tỷ giá — đổi tỷ giá sau này KHÔNG ảnh hưởng giao dịch đã chốt
          meta: {
            fromAssetId: body.fromAssetId,
            toAssetId: body.toAssetId,
            fromAmount: body.amount,
            toAmount,
            rateNum: rate.num,
            rateDen: rate.den,
          },
          entries: [
            { accountId: fromAcc, assetTypeId: body.fromAssetId, amount: -body.amount },
            { accountId: bankFrom, assetTypeId: body.fromAssetId, amount: body.amount },
            { accountId: bankTo, assetTypeId: body.toAssetId, amount: -toAmount },
            { accountId: toAcc, assetTypeId: body.toAssetId, amount: toAmount },
          ],
        });
        logAudit(app.db, {
          sessionId,
          actorType: principal.type,
          actorId: principal.id,
          action: "tx.exchange",
          target: `tx:${tx.id}`,
          detail: { ...body, pin: undefined, toAmount },
        });
        emitTxEvents(app, sessionId, tx.id);
        reply.status(201).send({ ok: true, data: { ...tx, toAmount } });
      } catch (err) {
        return sendLedgerError(reply, err);
      }
    },
  );
}
