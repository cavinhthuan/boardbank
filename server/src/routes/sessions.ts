import type { FastifyInstance } from "fastify";
import { generateJoinCode } from "../lib/ids.js";
import { ensureAccount } from "../ledger.js";
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
        players,
        balances,
      },
    };
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
