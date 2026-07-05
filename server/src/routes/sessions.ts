import type { FastifyInstance } from "fastify";
import { generateJoinCode } from "../lib/ids.js";
import { ensureAccount, postTransaction } from "../ledger.js";
import { logAudit } from "../lib/audit.js";
import { deny, isSessionAdmin, isSessionMember } from "../auth.js";

export interface SessionConfig {
  initialBalance: number;
}

export function getSessionOr404(app: FastifyInstance, id: number) {
  return app.db.prepare("SELECT * FROM game_sessions WHERE id=?").get(id) as
    | {
        id: number;
        bank_id: number;
        name: string;
        join_code: string;
        status: string;
        config_json: string;
      }
    | undefined;
}

export function sessionRoutes(app: FastifyInstance): void {
  app.post(
    "/api/v1/banks/:bankId/sessions",
    {
      schema: {
        params: {
          type: "object",
          properties: { bankId: { type: "integer" } },
          required: ["bankId"],
        },
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            currencyName: { type: "string", minLength: 1, maxLength: 40, default: "Tiền" },
            currencyCode: { type: "string", minLength: 1, maxLength: 10, default: "CASH" },
            currencyIcon: { type: "string", maxLength: 8, default: "💰" },
            initialBalance: { type: "integer", minimum: 0, default: 0 },
            allowNegative: { type: "boolean", default: false },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      if (req.principal?.type !== "admin") return deny(app, req, reply);
      const { bankId } = req.params as { bankId: number };
      const body = req.body as {
        name: string;
        currencyName: string;
        currencyCode: string;
        currencyIcon: string;
        initialBalance: number;
        allowNegative: boolean;
      };
      const bank = app.db
        .prepare("SELECT id FROM banks WHERE id=? AND owner_admin_id=?")
        .get(bankId, req.principal.id);
      if (!bank) {
        return reply.status(404).send({ ok: false, error: { code: "BANK_NOT_FOUND", message: "Ngân hàng không tồn tại" } });
      }

      const created = app.db.transaction(() => {
        // join_code hiếm khi trùng; retry tối đa 5 lần cho chắc
        let sessionId = 0;
        for (let attempt = 0; ; attempt++) {
          try {
            const r = app.db
              .prepare(
                "INSERT INTO game_sessions (bank_id, name, join_code, config_json) VALUES (?,?,?,?)",
              )
              .run(
                bankId,
                body.name.trim(),
                generateJoinCode(),
                JSON.stringify({ initialBalance: body.initialBalance, allowNegative: body.allowNegative }),
              );
            sessionId = Number(r.lastInsertRowid);
            break;
          } catch (e) {
            if (attempt >= 4) throw e;
          }
        }
        const ar = app.db
          .prepare(
            "INSERT INTO asset_types (session_id, code, name, icon, decimals, is_primary) VALUES (?,?,?,?,0,1)",
          )
          .run(sessionId, body.currencyCode.trim().toUpperCase(), body.currencyName.trim(), body.currencyIcon);
        // Kho bạc của bank trong phiên (owner_id = 0)
        ensureAccount(app.db, sessionId, "bank", 0, Number(ar.lastInsertRowid));
        return sessionId;
      })();

      logAudit(app.db, { sessionId: created, actorType: "admin", action: "session.create", target: `session:${created}` });
      const session = app.db.prepare("SELECT * FROM game_sessions WHERE id=?").get(created);
      reply.status(201).send({ ok: true, data: session });
    },
  );

  app.get("/api/v1/banks/:bankId/sessions", async (req, reply) => {
    if (req.principal?.type !== "admin") return deny(app, req, reply);
    const { bankId } = req.params as { bankId: string };
    const owns = app.db
      .prepare("SELECT id FROM banks WHERE id=? AND owner_admin_id=?")
      .get(Number(bankId), req.principal.id);
    if (!owns) {
      return reply.status(404).send({ ok: false, error: { code: "BANK_NOT_FOUND", message: "Ngân hàng không tồn tại" } });
    }
    const sessions = app.db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM players p WHERE p.session_id = s.id AND p.status != 'removed') AS player_count
         FROM game_sessions s WHERE s.bank_id=? ORDER BY s.id DESC`,
      )
      .all(Number(bankId));
    return { ok: true, data: sessions };
  });

  app.get("/api/v1/sessions/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const session = getSessionOr404(app, id);
    if (!session) {
      return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
    }
    if (!req.principal || !isSessionMember(app.db, req.principal, id)) return deny(app, req, reply, id);
    const assets = app.db.prepare("SELECT * FROM asset_types WHERE session_id=?").all(id);
    const rates = app.db.prepare("SELECT * FROM exchange_rates WHERE session_id=?").all(id);
    const players = app.db
      .prepare(
        `SELECT p.id, p.display_name, p.avatar, p.role, p.status, p.created_at
         FROM players p WHERE p.session_id=? AND p.status != 'removed' ORDER BY p.id`,
      )
      .all(id) as { id: number }[];
    const balances = app.db
      .prepare(
        `SELECT a.owner_type, a.owner_id, a.asset_type_id, a.balance_cached
         FROM accounts a WHERE a.session_id=?`,
      )
      .all(id);
    const bank = app.db.prepare("SELECT * FROM banks WHERE id=?").get(session.bank_id);
    return {
      ok: true,
      data: {
        session: { ...session, config: JSON.parse(session.config_json) },
        bank,
        assets,
        rates,
        players,
        balances,
      },
    };
  });

  // Vòng đời phiên: draft → active ⇄ paused → ended (ended là trạng thái cuối)
  const TRANSITIONS: Record<string, string[]> = {
    draft: ["active"],
    active: ["paused", "ended"],
    paused: ["active", "ended"],
    ended: [],
  };

  app.post(
    "/api/v1/sessions/:id/status",
    {
      schema: {
        body: {
          type: "object",
          required: ["status"],
          properties: { status: { type: "string", enum: ["active", "paused", "ended"] } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const { status: next } = req.body as { status: string };
      const session = getSessionOr404(app, id);
      if (!session) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
      }
      if (!req.principal || !isSessionAdmin(app.db, req.principal, id)) return deny(app, req, reply, id);
      if (!TRANSITIONS[session.status]?.includes(next)) {
        return reply.status(422).send({
          ok: false,
          error: { code: "INVALID_TRANSITION", message: `Không thể chuyển từ '${session.status}' sang '${next}'` },
        });
      }
      app.db
        .prepare(
          `UPDATE game_sessions SET status=?,
             started_at = CASE WHEN ?='active' THEN COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE started_at END,
             ended_at   = CASE WHEN ?='ended'  THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE ended_at END
           WHERE id=?`,
        )
        .run(next, next, next, id);
      logAudit(app.db, {
        sessionId: id,
        actorType: req.principal.type,
        actorId: req.principal.id,
        action: "session.status",
        detail: { from: session.status, to: next },
      });
      app.events.publish(id, { type: "session", data: { status: next } });
      const updated = app.db.prepare("SELECT * FROM game_sessions WHERE id=?").get(id);
      return { ok: true, data: updated };
    },
  );

  app.patch(
    "/api/v1/sessions/:id/config",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            allowNegative: { type: "boolean" },
            transferLimit: { type: ["integer", "null"], minimum: 1, maximum: 1_000_000_000_000 },
            disabledTxTypes: {
              type: "array",
              items: { type: "string", enum: ["transfer", "exchange"] },
              maxItems: 2,
            },
            loanRate: { type: "integer", minimum: 0, maximum: 1000 },
            savingsRate: { type: "integer", minimum: 0, maximum: 1000 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const session = getSessionOr404(app, id);
      if (!session) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
      }
      if (!req.principal || !isSessionAdmin(app.db, req.principal, id)) return deny(app, req, reply, id);
      const patch = req.body as Record<string, unknown>;
      // Merge chỉ-thêm: trường không gửi giữ nguyên — tương thích ngược
      const config = { ...JSON.parse(session.config_json), ...patch };
      if (patch.transferLimit === null) delete config.transferLimit;
      app.db.prepare("UPDATE game_sessions SET config_json=? WHERE id=?").run(JSON.stringify(config), id);
      logAudit(app.db, {
        sessionId: id,
        actorType: req.principal.type,
        actorId: req.principal.id,
        action: "session.config",
        detail: patch,
      });
      app.events.publish(id, { type: "session", data: { status: session.status } });
      return { ok: true, data: config };
    },
  );

  // Thống kê tính TRỰC TIẾP từ sổ cái — nguồn sự thật duy nhất
  app.get("/api/v1/sessions/:id/stats", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!getSessionOr404(app, id)) {
      return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
    }
    if (!req.principal || !isSessionMember(app.db, req.principal, id)) return deny(app, req, reply, id);

    const primary = app.db
      .prepare("SELECT id FROM asset_types WHERE session_id=? AND is_primary=1")
      .get(id) as { id: number } | undefined;
    const circulating = app.db
      .prepare(
        `SELECT asset_type_id, SUM(balance_cached) AS total
         FROM accounts WHERE session_id=? AND owner_type='player' GROUP BY asset_type_id`,
      )
      .all(id);
    const totalTx = (
      app.db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE session_id=?").get(id) as { c: number }
    ).c;
    const players = app.db
      .prepare(
        `SELECT p.id, p.display_name, p.avatar, p.status,
                COALESCE((SELECT balance_cached FROM accounts a
                          WHERE a.session_id=p.session_id AND a.owner_type='player' AND a.owner_id=p.id AND a.asset_type_id=?), 0) AS balance,
                COALESCE((SELECT SUM(e.amount) FROM transaction_entries e JOIN accounts a ON a.id=e.account_id
                          WHERE a.owner_type='player' AND a.owner_id=p.id AND a.session_id=p.session_id
                            AND a.asset_type_id=? AND e.amount>0), 0) AS total_in,
                COALESCE((SELECT SUM(-e.amount) FROM transaction_entries e JOIN accounts a ON a.id=e.account_id
                          WHERE a.owner_type='player' AND a.owner_id=p.id AND a.session_id=p.session_id
                            AND a.asset_type_id=? AND e.amount<0), 0) AS total_out,
                (SELECT COUNT(DISTINCT e.transaction_id) FROM transaction_entries e JOIN accounts a ON a.id=e.account_id
                 WHERE a.owner_type='player' AND a.owner_id=p.id AND a.session_id=p.session_id) AS tx_count
         FROM players p WHERE p.session_id=? AND p.status != 'removed'
         ORDER BY balance DESC`,
      )
      .all(primary?.id ?? 0, primary?.id ?? 0, primary?.id ?? 0, id);
    return { ok: true, data: { totalTx, circulating, players, primaryAssetId: primary?.id ?? null } };
  });

  // Nhân bản phiên: copy cấu hình + tài sản + tỷ giá + người chơi (giữ PIN) + số dư ban đầu.
  // KHÔNG copy lịch sử giao dịch — phiên mới bắt đầu sạch ở trạng thái draft.
  app.post("/api/v1/sessions/:id/clone", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const session = getSessionOr404(app, id);
    if (!session) {
      return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
    }
    if (!req.principal || !isSessionAdmin(app.db, req.principal, id)) return deny(app, req, reply, id);

    const config = JSON.parse(session.config_json) as { initialBalance?: number };
    const initial = config.initialBalance ?? 0;

    const newId = app.db.transaction(() => {
      let sid = 0;
      for (let attempt = 0; ; attempt++) {
        try {
          const r = app.db
            .prepare("INSERT INTO game_sessions (bank_id, name, join_code, config_json) VALUES (?,?,?,?)")
            .run(session.bank_id, `${session.name} (bản sao)`, generateJoinCode(), session.config_json);
          sid = Number(r.lastInsertRowid);
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
        }
      }

      const assets = app.db
        .prepare("SELECT * FROM asset_types WHERE session_id=? AND status='active'")
        .all(id) as { id: number; code: string; name: string; icon: string | null; decimals: number; is_primary: number }[];
      const assetMap = new Map<number, number>();
      for (const a of assets) {
        const r = app.db
          .prepare("INSERT INTO asset_types (session_id, code, name, icon, decimals, is_primary) VALUES (?,?,?,?,?,?)")
          .run(sid, a.code, a.name, a.icon, a.decimals, a.is_primary);
        assetMap.set(a.id, Number(r.lastInsertRowid));
        ensureAccount(app.db, sid, "bank", 0, Number(r.lastInsertRowid));
      }

      const rates = app.db.prepare("SELECT * FROM exchange_rates WHERE session_id=?").all(id) as {
        from_asset_id: number;
        to_asset_id: number;
        rate_num: number;
        rate_den: number;
      }[];
      for (const r of rates) {
        const from = assetMap.get(r.from_asset_id);
        const to = assetMap.get(r.to_asset_id);
        if (from && to) {
          app.db
            .prepare("INSERT INTO exchange_rates (session_id, from_asset_id, to_asset_id, rate_num, rate_den) VALUES (?,?,?,?,?)")
            .run(sid, from, to, r.rate_num, r.rate_den);
        }
      }

      const players = app.db
        .prepare("SELECT display_name, avatar, pin_hash, role FROM players WHERE session_id=? AND status != 'removed'")
        .all(id) as { display_name: string; avatar: string | null; pin_hash: string | null; role: string }[];
      for (const p of players) {
        const pr = app.db
          .prepare("INSERT INTO players (session_id, display_name, avatar, pin_hash, role) VALUES (?,?,?,?,?)")
          .run(sid, p.display_name, p.avatar, p.pin_hash, p.role);
        const pid = Number(pr.lastInsertRowid);
        for (const [oldAid, newAid] of assetMap) {
          const accId = ensureAccount(app.db, sid, "player", pid, newAid);
          const isPrimary = assets.find((a) => a.id === oldAid)?.is_primary;
          if (isPrimary && initial > 0) {
            const bankAcc = ensureAccount(app.db, sid, "bank", 0, newAid);
            postTransaction(app.db, {
              sessionId: sid,
              type: "issue",
              note: "Cấp số dư ban đầu",
              createdBy: "system",
              entries: [
                { accountId: bankAcc, assetTypeId: newAid, amount: -initial },
                { accountId: accId, assetTypeId: newAid, amount: initial },
              ],
            });
          }
        }
      }
      return sid;
    })();

    logAudit(app.db, {
      sessionId: newId,
      actorType: req.principal.type,
      actorId: req.principal.id,
      action: "session.clone",
      detail: { from: id },
    });
    const created = app.db.prepare("SELECT * FROM game_sessions WHERE id=?").get(newId);
    reply.status(201).send({ ok: true, data: created });
  });

  // Export toàn bộ dữ liệu phiên ra JSON — lưu kết quả vĩnh viễn (không kèm PIN hash)
  app.get("/api/v1/sessions/:id/export", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const session = getSessionOr404(app, id);
    if (!session) {
      return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
    }
    if (!req.principal || !isSessionAdmin(app.db, req.principal, id)) return deny(app, req, reply, id);

    const txs = app.db
      .prepare("SELECT id, code, type, status, note, created_by, reversed_by_tx_id, meta_json, created_at FROM transactions WHERE session_id=? ORDER BY id")
      .all(id) as { id: number }[];
    const getEntries = app.db.prepare(
      "SELECT account_id, asset_type_id, amount FROM transaction_entries WHERE transaction_id=? ORDER BY id",
    );
    const data = {
      format: "boardbank-session-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      session: { ...session, config: JSON.parse(session.config_json) },
      bank: app.db.prepare("SELECT id, name FROM banks WHERE id=?").get(session.bank_id),
      assets: app.db.prepare("SELECT * FROM asset_types WHERE session_id=?").all(id),
      rates: app.db.prepare("SELECT * FROM exchange_rates WHERE session_id=?").all(id),
      players: app.db
        .prepare("SELECT id, display_name, avatar, role, status, created_at FROM players WHERE session_id=?")
        .all(id),
      accounts: app.db
        .prepare("SELECT id, owner_type, owner_id, asset_type_id, balance_cached FROM accounts WHERE session_id=?")
        .all(id),
      transactions: txs.map((t) => ({ ...t, entries: getEntries.all(t.id) })),
    };
    logAudit(app.db, { sessionId: id, actorType: req.principal.type, actorId: req.principal.id, action: "session.export" });
    reply.header("content-disposition", `attachment; filename="boardbank-session-${id}.json"`);
    return { ok: true, data };
  });

  app.get(
    "/api/v1/sessions/:id/audit",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const { limit } = req.query as { limit: number };
      if (!getSessionOr404(app, id)) {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Phiên không tồn tại" } });
      }
      if (!req.principal || !isSessionAdmin(app.db, req.principal, id)) return deny(app, req, reply, id);
      const rows = app.db
        .prepare("SELECT * FROM audit_log WHERE session_id=? ORDER BY id DESC LIMIT ?")
        .all(id, limit);
      return { ok: true, data: rows };
    },
  );
}
