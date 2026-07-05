import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { LedgerError, ensureAccount, postTransaction, type EntryInput } from "../ledger.js";
import { logAudit } from "../lib/audit.js";
import { getSessionOr404 } from "./sessions.js";
import { deny, isSessionAdmin, verifyPin, type Principal } from "../auth.js";
import { createNotification, emitTxEvents } from "../events.js";

// Phase 11: mọi nghiệp vụ đều là tổ hợp bút toán của engine sổ cái — không sửa lõi.

interface SessionRow {
  id: number;
  status: string;
  config_json: string;
}

function sendErr(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

function sendLedgerError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof LedgerError) return sendErr(reply, err.statusCode, err.code, err.message);
  throw err;
}

function getLiveSession(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply): SessionRow | null {
  const sessionId = Number((req.params as { id: string }).id);
  const session = getSessionOr404(app, sessionId) as SessionRow | undefined;
  if (!session) {
    sendErr(reply, 404, "SESSION_NOT_FOUND", "Phiên không tồn tại");
    return null;
  }
  if (session.status === "ended") {
    sendErr(reply, 422, "SESSION_ENDED", "Phiên đã kết thúc");
    return null;
  }
  return session;
}

function resolveAsset(app: FastifyInstance, sessionId: number, assetTypeId?: number): { id: number } | undefined {
  return (
    assetTypeId
      ? app.db.prepare("SELECT id FROM asset_types WHERE id=? AND session_id=? AND status='active'").get(assetTypeId, sessionId)
      : app.db.prepare("SELECT id FROM asset_types WHERE session_id=? AND is_primary=1").get(sessionId)
  ) as { id: number } | undefined;
}

/**
 * Ủy quyền một hành động trên ví của `playerId`:
 * session-admin làm được cho bất kỳ ai (không PIN); người chơi chỉ cho chính mình,
 * phiên phải active và bắt buộc PIN. Trả về principal hoặc null (đã gửi reply).
 */
function authorizeWalletAction(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  session: SessionRow,
  playerId: number,
  pin: string | undefined,
): Principal | null {
  const principal = req.principal;
  if (!principal) {
    deny(app, req, reply, session.id);
    return null;
  }
  if (isSessionAdmin(app.db, principal, session.id)) return principal;
  if (principal.type !== "player" || principal.sessionId !== session.id || principal.id !== playerId) {
    deny(app, req, reply, session.id);
    return null;
  }
  if (session.status !== "active") {
    sendErr(reply, 422, "SESSION_NOT_ACTIVE", "Phiên chưa bắt đầu hoặc đang tạm dừng");
    return null;
  }
  try {
    if (!pin) throw new LedgerError("PIN_REQUIRED", "Cần nhập PIN để xác nhận giao dịch", 422);
    verifyPin(app.db, principal.id, pin);
  } catch (err) {
    sendLedgerError(reply, err);
    return null;
  }
  return principal;
}

function notify(app: FastifyInstance, sessionId: number, playerId: number, type: string, payload: unknown): void {
  const n = createNotification(app.db, sessionId, playerId, type, payload);
  app.events.publish(sessionId, { type: "notification", toPlayerId: playerId, data: n });
}

function playerName(app: FastifyInstance, playerId: number): string {
  const row = app.db.prepare("SELECT display_name FROM players WHERE id=?").get(playerId) as
    | { display_name: string }
    | undefined;
  return row?.display_name ?? `#${playerId}`;
}

const BATCH_SIGNS: Record<string, 1 | -1> = { issue: 1, reward: 1, recall: -1, penalty: -1 };

export function financeRoutes(app: FastifyInstance): void {
  // ---- Giao dịch hàng loạt (admin): phát lương/thu thuế cả bàn trong MỘT giao dịch ----
  app.post(
    "/api/v1/sessions/:id/transactions/batch",
    {
      schema: {
        body: {
          type: "object",
          required: ["type", "playerIds", "amount"],
          properties: {
            type: { type: "string", enum: ["issue", "reward", "recall", "penalty"] },
            playerIds: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 100 },
            amount: { type: "integer", minimum: 1, maximum: 1_000_000_000_000 },
            assetTypeId: { type: "integer" },
            note: { type: "string", maxLength: 200 },
            idempotencyKey: { type: "string", minLength: 8, maxLength: 64 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const session = getLiveSession(app, req, reply);
      if (!session) return;
      if (!req.principal || !isSessionAdmin(app.db, req.principal, session.id)) return deny(app, req, reply, session.id);
      const body = req.body as {
        type: string;
        playerIds: number[];
        amount: number;
        assetTypeId?: number;
        note?: string;
        idempotencyKey?: string;
      };
      const asset = resolveAsset(app, session.id, body.assetTypeId);
      if (!asset) return sendErr(reply, 404, "ASSET_NOT_FOUND", "Tài sản không tồn tại");

      const ids = [...new Set(body.playerIds)];
      const sign = BATCH_SIGNS[body.type]!;
      const entries: EntryInput[] = [];
      for (const pid of ids) {
        const player = app.db
          .prepare("SELECT id FROM players WHERE id=? AND session_id=? AND status != 'removed'")
          .get(pid, session.id);
        if (!player) return sendErr(reply, 404, "PLAYER_NOT_FOUND", `Người chơi ${pid} không tồn tại`);
        entries.push({ accountId: ensureAccount(app.db, session.id, "player", pid, asset.id), assetTypeId: asset.id, amount: sign * body.amount });
      }
      const bankAcc = ensureAccount(app.db, session.id, "bank", 0, asset.id);
      entries.push({ accountId: bankAcc, assetTypeId: asset.id, amount: -sign * body.amount * ids.length });

      try {
        // Nguyên tử: một người không đủ tiền (recall/penalty) → cả lô thất bại
        const tx = postTransaction(app.db, {
          sessionId: session.id,
          type: body.type,
          note: body.note ?? `Hàng loạt (${ids.length} người)`,
          createdBy: `${req.principal.type}:${req.principal.id}`,
          idempotencyKey: body.idempotencyKey,
          entries,
          meta: { batch: true, playerIds: ids, amountEach: body.amount },
        });
        logAudit(app.db, {
          sessionId: session.id,
          actorType: req.principal.type,
          actorId: req.principal.id,
          action: `tx.batch.${body.type}`,
          target: `tx:${tx.id}`,
          detail: { playerIds: ids, amount: body.amount },
        });
        emitTxEvents(app, session.id, tx.id);
        reply.status(201).send({ ok: true, data: { ...tx, count: ids.length } });
      } catch (err) {
        return sendLedgerError(reply, err);
      }
    },
  );

  // ---- Chia tiền: một người trả cho nhiều người trong MỘT giao dịch ----
  app.post(
    "/api/v1/sessions/:id/transactions/split",
    {
      schema: {
        body: {
          type: "object",
          required: ["fromPlayerId", "toPlayerIds", "amountEach"],
          properties: {
            fromPlayerId: { type: "integer" },
            toPlayerIds: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 50 },
            amountEach: { type: "integer", minimum: 1, maximum: 1_000_000_000_000 },
            assetTypeId: { type: "integer" },
            note: { type: "string", maxLength: 200 },
            pin: { type: "string", pattern: "^[0-9]{4,6}$" },
            idempotencyKey: { type: "string", minLength: 8, maxLength: 64 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const session = getLiveSession(app, req, reply);
      if (!session) return;
      const body = req.body as {
        fromPlayerId: number;
        toPlayerIds: number[];
        amountEach: number;
        assetTypeId?: number;
        note?: string;
        pin?: string;
        idempotencyKey?: string;
      };
      const config = JSON.parse(session.config_json) as { transferLimit?: number; disabledTxTypes?: string[] };
      const principal = authorizeWalletAction(app, req, reply, session, body.fromPlayerId, body.pin);
      if (!principal) return;
      const isAdmin = isSessionAdmin(app.db, principal, session.id);
      const ids = [...new Set(body.toPlayerIds)].filter((pid) => pid !== body.fromPlayerId);
      if (ids.length === 0) return sendErr(reply, 400, "NO_RECIPIENTS", "Chưa chọn người nhận hợp lệ");
      const total = body.amountEach * ids.length;
      if (!isAdmin) {
        if (config.disabledTxTypes?.includes("transfer")) {
          return sendErr(reply, 422, "TX_TYPE_DISABLED", "Chuyển khoản đang bị tắt trong phiên");
        }
        if (config.transferLimit && total > config.transferLimit) {
          return sendErr(reply, 422, "LIMIT_EXCEEDED", `Tổng chia (${total}) vượt giới hạn mỗi lần chuyển (${config.transferLimit})`);
        }
      }
      const asset = resolveAsset(app, session.id, body.assetTypeId);
      if (!asset) return sendErr(reply, 404, "ASSET_NOT_FOUND", "Tài sản không tồn tại");

      const entries: EntryInput[] = [
        {
          accountId: ensureAccount(app.db, session.id, "player", body.fromPlayerId, asset.id),
          assetTypeId: asset.id,
          amount: -total,
        },
      ];
      for (const pid of ids) {
        const player = app.db
          .prepare("SELECT id FROM players WHERE id=? AND session_id=? AND status='active'")
          .get(pid, session.id);
        if (!player) return sendErr(reply, 404, "PLAYER_NOT_FOUND", `Người nhận ${pid} không hợp lệ`);
        entries.push({ accountId: ensureAccount(app.db, session.id, "player", pid, asset.id), assetTypeId: asset.id, amount: body.amountEach });
      }

      try {
        const tx = postTransaction(app.db, {
          sessionId: session.id,
          type: "split",
          note: body.note,
          createdBy: `${principal.type}:${principal.id}`,
          idempotencyKey: body.idempotencyKey,
          entries,
          meta: { split: true, amountEach: body.amountEach, count: ids.length },
        });
        logAudit(app.db, {
          sessionId: session.id,
          actorType: principal.type,
          actorId: principal.id,
          action: "tx.split",
          target: `tx:${tx.id}`,
          detail: { toPlayerIds: ids, amountEach: body.amountEach },
        });
        emitTxEvents(app, session.id, tx.id);
        reply.status(201).send({ ok: true, data: { ...tx, total, count: ids.length } });
      } catch (err) {
        return sendLedgerError(reply, err);
      }
    },
  );

  // ---- Vay & trả nợ ----
  app.post(
    "/api/v1/sessions/:id/loans",
    {
      schema: {
        body: {
          type: "object",
          required: ["playerId", "amount"],
          properties: {
            playerId: { type: "integer" },
            amount: { type: "integer", minimum: 1, maximum: 1_000_000_000_000 },
            assetTypeId: { type: "integer" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const session = getLiveSession(app, req, reply);
      if (!session) return;
      if (!req.principal || !isSessionAdmin(app.db, req.principal, session.id)) return deny(app, req, reply, session.id);
      const body = req.body as { playerId: number; amount: number; assetTypeId?: number };
      const player = app.db
        .prepare("SELECT id FROM players WHERE id=? AND session_id=? AND status='active'")
        .get(body.playerId, session.id);
      if (!player) return sendErr(reply, 404, "PLAYER_NOT_FOUND", "Người chơi không hợp lệ");
      const asset = resolveAsset(app, session.id, body.assetTypeId);
      if (!asset) return sendErr(reply, 404, "ASSET_NOT_FOUND", "Tài sản không tồn tại");

      const loan = app.db.transaction(() => {
        const playerAcc = ensureAccount(app.db, session.id, "player", body.playerId, asset.id);
        const bankAcc = ensureAccount(app.db, session.id, "bank", 0, asset.id);
        const tx = postTransaction(app.db, {
          sessionId: session.id,
          type: "loan",
          note: "Giải ngân khoản vay",
          createdBy: `${req.principal!.type}:${req.principal!.id}`,
          entries: [
            { accountId: bankAcc, assetTypeId: asset.id, amount: -body.amount },
            { accountId: playerAcc, assetTypeId: asset.id, amount: body.amount },
          ],
        });
        const r = app.db
          .prepare("INSERT INTO loans (session_id, player_id, asset_type_id, principal, outstanding) VALUES (?,?,?,?,?)")
          .run(session.id, body.playerId, asset.id, body.amount, body.amount);
        return { id: Number(r.lastInsertRowid), txId: tx.id };
      })();

      logAudit(app.db, {
        sessionId: session.id,
        actorType: req.principal.type,
        actorId: req.principal.id,
        action: "loan.create",
        target: `loan:${loan.id}`,
        detail: body,
      });
      emitTxEvents(app, session.id, loan.txId);
      const row = app.db.prepare("SELECT * FROM loans WHERE id=?").get(loan.id);
      reply.status(201).send({ ok: true, data: row });
    },
  );

  app.get("/api/v1/sessions/:id/loans", async (req, reply) => {
    const sessionId = Number((req.params as { id: string }).id);
    if (!getSessionOr404(app, sessionId)) return sendErr(reply, 404, "SESSION_NOT_FOUND", "Phiên không tồn tại");
    const principal = req.principal;
    if (!principal) return deny(app, req, reply, sessionId);
    if (isSessionAdmin(app.db, principal, sessionId)) {
      return {
        ok: true,
        data: app.db
          .prepare(
            `SELECT l.*, p.display_name FROM loans l JOIN players p ON p.id=l.player_id
             WHERE l.session_id=? ORDER BY l.status, l.id DESC`,
          )
          .all(sessionId),
      };
    }
    if (principal.type !== "player" || principal.sessionId !== sessionId) return deny(app, req, reply, sessionId);
    return {
      ok: true,
      data: app.db.prepare("SELECT * FROM loans WHERE session_id=? AND player_id=? ORDER BY status, id DESC").all(sessionId, principal.id),
    };
  });

  app.post(
    "/api/v1/sessions/:id/loans/:loanId/repay",
    {
      schema: {
        body: {
          type: "object",
          required: ["amount"],
          properties: {
            amount: { type: "integer", minimum: 1, maximum: 1_000_000_000_000 },
            pin: { type: "string", pattern: "^[0-9]{4,6}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const session = getLiveSession(app, req, reply);
      if (!session) return;
      const loanId = Number((req.params as { loanId: string }).loanId);
      const body = req.body as { amount: number; pin?: string };
      const loan = app.db
        .prepare("SELECT * FROM loans WHERE id=? AND session_id=?")
        .get(loanId, session.id) as
        | { id: number; player_id: number; asset_type_id: number; outstanding: number; status: string }
        | undefined;
      if (!loan) return sendErr(reply, 404, "LOAN_NOT_FOUND", "Khoản vay không tồn tại");
      if (loan.status !== "open") return sendErr(reply, 422, "LOAN_CLOSED", "Khoản vay đã tất toán");
      if (body.amount > loan.outstanding) {
        return sendErr(reply, 422, "OVER_REPAY", `Dư nợ chỉ còn ${loan.outstanding}`);
      }
      const principal = authorizeWalletAction(app, req, reply, session, loan.player_id, body.pin);
      if (!principal) return;

      try {
        const txId = app.db.transaction(() => {
          const playerAcc = ensureAccount(app.db, session.id, "player", loan.player_id, loan.asset_type_id);
          const bankAcc = ensureAccount(app.db, session.id, "bank", 0, loan.asset_type_id);
          const tx = postTransaction(app.db, {
            sessionId: session.id,
            type: "loan_repay",
            note: `Trả nợ khoản vay #${loan.id}`,
            createdBy: `${principal.type}:${principal.id}`,
            entries: [
              { accountId: playerAcc, assetTypeId: loan.asset_type_id, amount: -body.amount },
              { accountId: bankAcc, assetTypeId: loan.asset_type_id, amount: body.amount },
            ],
          });
          const remaining = loan.outstanding - body.amount;
          app.db
            .prepare(
              `UPDATE loans SET outstanding=?, status=CASE WHEN ?=0 THEN 'closed' ELSE 'open' END,
               closed_at=CASE WHEN ?=0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id=?`,
            )
            .run(remaining, remaining, remaining, loan.id);
          return tx.id;
        })();
        emitTxEvents(app, session.id, txId);
        const row = app.db.prepare("SELECT * FROM loans WHERE id=?").get(loan.id);
        return { ok: true, data: row };
      } catch (err) {
        return sendLedgerError(reply, err);
      }
    },
  );

  // ---- Tiết kiệm ----
  const savingsMove = (kind: "deposit" | "withdraw") =>
    async function handler(req: FastifyRequest, reply: FastifyReply) {
      const session = getLiveSession(app, req, reply);
      if (!session) return;
      const body = req.body as { playerId: number; amount: number; pin?: string };
      const principal = authorizeWalletAction(app, req, reply, session, body.playerId, body.pin);
      if (!principal) return;
      const asset = resolveAsset(app, session.id);
      if (!asset) return sendErr(reply, 404, "ASSET_NOT_FOUND", "Tài sản không tồn tại");
      const player = app.db
        .prepare("SELECT id FROM players WHERE id=? AND session_id=? AND status='active'")
        .get(body.playerId, session.id);
      if (!player) return sendErr(reply, 404, "PLAYER_NOT_FOUND", "Người chơi không hợp lệ");

      const row = app.db
        .prepare("SELECT * FROM savings WHERE session_id=? AND player_id=? AND asset_type_id=?")
        .get(session.id, body.playerId, asset.id) as { id: number; balance: number } | undefined;
      if (kind === "withdraw" && (!row || row.balance < body.amount)) {
        return sendErr(reply, 422, "INSUFFICIENT_SAVINGS", `Sổ tiết kiệm chỉ còn ${row?.balance ?? 0}`);
      }

      try {
        const txId = app.db.transaction(() => {
          const playerAcc = ensureAccount(app.db, session.id, "player", body.playerId, asset.id);
          const bankAcc = ensureAccount(app.db, session.id, "bank", 0, asset.id);
          const sign = kind === "deposit" ? -1 : 1; // deposit: tiền rời ví người chơi
          const tx = postTransaction(app.db, {
            sessionId: session.id,
            type: kind === "deposit" ? "saving_deposit" : "saving_withdraw",
            note: kind === "deposit" ? "Gửi tiết kiệm" : "Rút tiết kiệm",
            createdBy: `${principal.type}:${principal.id}`,
            entries: [
              { accountId: playerAcc, assetTypeId: asset.id, amount: sign * body.amount },
              { accountId: bankAcc, assetTypeId: asset.id, amount: -sign * body.amount },
            ],
          });
          if (row) {
            app.db
              .prepare("UPDATE savings SET balance = balance + ? WHERE id=?")
              .run(kind === "deposit" ? body.amount : -body.amount, row.id);
          } else {
            app.db
              .prepare("INSERT INTO savings (session_id, player_id, asset_type_id, balance) VALUES (?,?,?,?)")
              .run(session.id, body.playerId, asset.id, body.amount);
          }
          return tx.id;
        })();
        emitTxEvents(app, session.id, txId);
        const updated = app.db
          .prepare("SELECT * FROM savings WHERE session_id=? AND player_id=? AND asset_type_id=?")
          .get(session.id, body.playerId, asset.id);
        return { ok: true, data: updated };
      } catch (err) {
        return sendLedgerError(reply, err);
      }
    };

  const savingsSchema = {
    body: {
      type: "object",
      required: ["playerId", "amount"],
      properties: {
        playerId: { type: "integer" },
        amount: { type: "integer", minimum: 1, maximum: 1_000_000_000_000 },
        pin: { type: "string", pattern: "^[0-9]{4,6}$" },
      },
      additionalProperties: false,
    },
  };
  app.post("/api/v1/sessions/:id/savings/deposit", { schema: savingsSchema }, savingsMove("deposit"));
  app.post("/api/v1/sessions/:id/savings/withdraw", { schema: savingsSchema }, savingsMove("withdraw"));

  app.get("/api/v1/sessions/:id/savings", async (req, reply) => {
    const sessionId = Number((req.params as { id: string }).id);
    if (!getSessionOr404(app, sessionId)) return sendErr(reply, 404, "SESSION_NOT_FOUND", "Phiên không tồn tại");
    const principal = req.principal;
    if (!principal) return deny(app, req, reply, sessionId);
    if (isSessionAdmin(app.db, principal, sessionId)) {
      return {
        ok: true,
        data: app.db
          .prepare(
            "SELECT s.*, p.display_name FROM savings s JOIN players p ON p.id=s.player_id WHERE s.session_id=? ORDER BY s.balance DESC",
          )
          .all(sessionId),
      };
    }
    if (principal.type !== "player" || principal.sessionId !== sessionId) return deny(app, req, reply, sessionId);
    return {
      ok: true,
      data: app.db.prepare("SELECT * FROM savings WHERE session_id=? AND player_id=?").all(sessionId, principal.id),
    };
  });

  // ---- Tính lãi kỳ này (admin bấm tay — không scheduler nền, đúng master plan) ----
  app.post("/api/v1/sessions/:id/accrue-interest", async (req, reply) => {
    const session = getLiveSession(app, req, reply);
    if (!session) return;
    if (!req.principal || !isSessionAdmin(app.db, req.principal, session.id)) return deny(app, req, reply, session.id);
    const config = JSON.parse(session.config_json) as { loanRate?: number; savingsRate?: number };
    const loanRate = config.loanRate ?? 0;
    const savingsRate = config.savingsRate ?? 0;

    const result = app.db.transaction(() => {
      let loansAccrued = 0;
      let savingsAccrued = 0;
      if (loanRate > 0) {
        const loans = app.db
          .prepare("SELECT id, player_id, outstanding FROM loans WHERE session_id=? AND status='open'")
          .all(session.id) as { id: number; player_id: number; outstanding: number }[];
        for (const loan of loans) {
          const interest = Math.floor((loan.outstanding * loanRate) / 100);
          if (interest <= 0) continue;
          app.db.prepare("UPDATE loans SET outstanding = outstanding + ? WHERE id=?").run(interest, loan.id);
          notify(app, session.id, loan.player_id, "loan.interest", {
            loanId: loan.id,
            interest,
            outstanding: loan.outstanding + interest,
            ratePercent: loanRate,
          });
          loansAccrued++;
        }
      }
      if (savingsRate > 0) {
        const rows = app.db
          .prepare("SELECT id, player_id, balance FROM savings WHERE session_id=? AND balance > 0")
          .all(session.id) as { id: number; player_id: number; balance: number }[];
        for (const s of rows) {
          const interest = Math.floor((s.balance * savingsRate) / 100);
          if (interest <= 0) continue;
          app.db.prepare("UPDATE savings SET balance = balance + ? WHERE id=?").run(interest, s.id);
          notify(app, session.id, s.player_id, "saving.interest", {
            savingsId: s.id,
            interest,
            balance: s.balance + interest,
            ratePercent: savingsRate,
          });
          savingsAccrued++;
        }
      }
      return { loansAccrued, savingsAccrued, loanRate, savingsRate };
    })();

    logAudit(app.db, {
      sessionId: session.id,
      actorType: req.principal.type,
      actorId: req.principal.id,
      action: "interest.accrue",
      detail: result,
    });
    return { ok: true, data: result };
  });

  // ---- Hóa đơn giữa người chơi ----
  app.post(
    "/api/v1/sessions/:id/invoices",
    {
      schema: {
        body: {
          type: "object",
          required: ["toPlayerId", "amount"],
          properties: {
            toPlayerId: { type: "integer" },
            amount: { type: "integer", minimum: 1, maximum: 1_000_000_000_000 },
            assetTypeId: { type: "integer" },
            note: { type: "string", maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const session = getLiveSession(app, req, reply);
      if (!session) return;
      const principal = req.principal;
      // Người tạo hóa đơn phải là người chơi của phiên (người thu tiền)
      if (!principal || principal.type !== "player" || principal.sessionId !== session.id) {
        return deny(app, req, reply, session.id);
      }
      const body = req.body as { toPlayerId: number; amount: number; assetTypeId?: number; note?: string };
      if (body.toPlayerId === principal.id) return sendErr(reply, 422, "SELF_INVOICE", "Không thể tự gửi hóa đơn cho mình");
      const payer = app.db
        .prepare("SELECT id FROM players WHERE id=? AND session_id=? AND status='active'")
        .get(body.toPlayerId, session.id);
      if (!payer) return sendErr(reply, 404, "PLAYER_NOT_FOUND", "Người trả không hợp lệ");
      const asset = resolveAsset(app, session.id, body.assetTypeId);
      if (!asset) return sendErr(reply, 404, "ASSET_NOT_FOUND", "Tài sản không tồn tại");

      const r = app.db
        .prepare("INSERT INTO invoices (session_id, from_player_id, to_player_id, asset_type_id, amount, note) VALUES (?,?,?,?,?,?)")
        .run(session.id, principal.id, body.toPlayerId, asset.id, body.amount, body.note ?? null);
      const invoice = app.db.prepare("SELECT * FROM invoices WHERE id=?").get(r.lastInsertRowid);
      notify(app, session.id, body.toPlayerId, "invoice.created", {
        invoiceId: Number(r.lastInsertRowid),
        amount: body.amount,
        from: playerName(app, principal.id),
        note: body.note ?? null,
      });
      logAudit(app.db, {
        sessionId: session.id,
        actorType: "player",
        actorId: principal.id,
        action: "invoice.create",
        target: `invoice:${r.lastInsertRowid}`,
      });
      reply.status(201).send({ ok: true, data: invoice });
    },
  );

  app.get("/api/v1/sessions/:id/invoices", async (req, reply) => {
    const sessionId = Number((req.params as { id: string }).id);
    if (!getSessionOr404(app, sessionId)) return sendErr(reply, 404, "SESSION_NOT_FOUND", "Phiên không tồn tại");
    const principal = req.principal;
    if (!principal) return deny(app, req, reply, sessionId);
    const base = `SELECT i.*,
                    (SELECT display_name FROM players WHERE id=i.from_player_id) AS from_name,
                    (SELECT display_name FROM players WHERE id=i.to_player_id) AS to_name
                  FROM invoices i WHERE i.session_id=?`;
    if (isSessionAdmin(app.db, principal, sessionId)) {
      return { ok: true, data: app.db.prepare(`${base} ORDER BY i.id DESC LIMIT 100`).all(sessionId) };
    }
    if (principal.type !== "player" || principal.sessionId !== sessionId) return deny(app, req, reply, sessionId);
    return {
      ok: true,
      data: app.db
        .prepare(`${base} AND (i.from_player_id=? OR i.to_player_id=?) ORDER BY i.status='pending' DESC, i.id DESC LIMIT 100`)
        .all(sessionId, principal.id, principal.id),
    };
  });

  app.post(
    "/api/v1/sessions/:id/invoices/:invoiceId/pay",
    {
      schema: {
        body: {
          type: "object",
          properties: { pin: { type: "string", pattern: "^[0-9]{4,6}$" } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const session = getLiveSession(app, req, reply);
      if (!session) return;
      const invoiceId = Number((req.params as { invoiceId: string }).invoiceId);
      const body = (req.body ?? {}) as { pin?: string };
      const invoice = app.db
        .prepare("SELECT * FROM invoices WHERE id=? AND session_id=?")
        .get(invoiceId, session.id) as
        | { id: number; from_player_id: number; to_player_id: number; asset_type_id: number; amount: number; note: string | null; status: string }
        | undefined;
      if (!invoice) return sendErr(reply, 404, "INVOICE_NOT_FOUND", "Hóa đơn không tồn tại");
      if (invoice.status !== "pending") return sendErr(reply, 409, "INVOICE_RESOLVED", "Hóa đơn đã được xử lý");
      // Chỉ người bị đòi tiền (hoặc admin thay mặt) được thanh toán
      const principal = authorizeWalletAction(app, req, reply, session, invoice.to_player_id, body.pin);
      if (!principal) return;

      try {
        const txId = app.db.transaction(() => {
          const payerAcc = ensureAccount(app.db, session.id, "player", invoice.to_player_id, invoice.asset_type_id);
          const receiverAcc = ensureAccount(app.db, session.id, "player", invoice.from_player_id, invoice.asset_type_id);
          const tx = postTransaction(app.db, {
            sessionId: session.id,
            type: "invoice_payment",
            note: invoice.note ? `Thanh toán hóa đơn: ${invoice.note}` : `Thanh toán hóa đơn #${invoice.id}`,
            createdBy: `${principal.type}:${principal.id}`,
            entries: [
              { accountId: payerAcc, assetTypeId: invoice.asset_type_id, amount: -invoice.amount },
              { accountId: receiverAcc, assetTypeId: invoice.asset_type_id, amount: invoice.amount },
            ],
          });
          app.db
            .prepare("UPDATE invoices SET status='paid', tx_id=?, resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
            .run(tx.id, invoice.id);
          return tx.id;
        })();
        emitTxEvents(app, session.id, txId);
        const updated = app.db.prepare("SELECT * FROM invoices WHERE id=?").get(invoice.id);
        return { ok: true, data: updated };
      } catch (err) {
        return sendLedgerError(reply, err);
      }
    },
  );

  app.post("/api/v1/sessions/:id/invoices/:invoiceId/cancel", async (req, reply) => {
    const session = getLiveSession(app, req, reply);
    if (!session) return;
    const invoiceId = Number((req.params as { invoiceId: string }).invoiceId);
    const invoice = app.db
      .prepare("SELECT * FROM invoices WHERE id=? AND session_id=?")
      .get(invoiceId, session.id) as
      | { id: number; from_player_id: number; to_player_id: number; amount: number; status: string }
      | undefined;
    if (!invoice) return sendErr(reply, 404, "INVOICE_NOT_FOUND", "Hóa đơn không tồn tại");
    if (invoice.status !== "pending") return sendErr(reply, 409, "INVOICE_RESOLVED", "Hóa đơn đã được xử lý");
    const principal = req.principal;
    const canCancel =
      principal &&
      (isSessionAdmin(app.db, principal, session.id) ||
        (principal.type === "player" &&
          principal.sessionId === session.id &&
          (principal.id === invoice.from_player_id || principal.id === invoice.to_player_id)));
    if (!canCancel) return deny(app, req, reply, session.id);

    app.db
      .prepare("UPDATE invoices SET status='canceled', resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .run(invoice.id);
    // Báo cho phía bên kia
    const other = principal!.type === "player" && principal!.id === invoice.from_player_id ? invoice.to_player_id : invoice.from_player_id;
    notify(app, session.id, other, "invoice.canceled", { invoiceId: invoice.id, amount: invoice.amount });
    logAudit(app.db, {
      sessionId: session.id,
      actorType: principal!.type,
      actorId: principal!.id,
      action: "invoice.cancel",
      target: `invoice:${invoice.id}`,
    });
    return { ok: true, data: { id: invoice.id, status: "canceled" } };
  });
}
