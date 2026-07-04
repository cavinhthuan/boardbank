import type { FastifyInstance, FastifyReply } from "fastify";
import { COOKIE_NAME, createAuthSession, destroyAuthSession, verifyPin } from "../auth.js";
import { hashSecret, verifySecret } from "../lib/passwords.js";
import { logAudit } from "../lib/audit.js";
import { LedgerError } from "../ledger.js";
import { createPlayer } from "../services/playerService.js";

const PIN_PATTERN = "^[0-9]{4,6}$";
// Chặt trên các endpoint auth để chống dò mật khẩu/PIN (DoD Phase 3)
const AUTH_RATE_LIMIT = { rateLimit: { max: 20, timeWindow: "1 minute" } };

function setAuthCookie(app: FastifyInstance, reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 86400,
    secure: app.config.cookieSecure,
  });
}

function sendLedgerError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof LedgerError) {
    return reply.status(err.statusCode).send({ ok: false, error: { code: err.code, message: err.message } });
  }
  throw err;
}

export function authRoutes(app: FastifyInstance): void {
  app.post(
    "/api/v1/auth/admin/register",
    {
      config: AUTH_RATE_LIMIT,
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string", minLength: 3, maxLength: 32, pattern: "^[a-zA-Z0-9_.-]+$" },
            password: { type: "string", minLength: 6, maxLength: 128 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { username, password } = req.body as { username: string; password: string };
      const exists = app.db.prepare("SELECT id FROM admins WHERE username=?").get(username);
      if (exists) {
        return reply.status(409).send({ ok: false, error: { code: "USERNAME_TAKEN", message: "Tên đăng nhập đã tồn tại" } });
      }
      const r = app.db
        .prepare("INSERT INTO admins (username, password_hash) VALUES (?,?)")
        .run(username, hashSecret(password));
      const adminId = Number(r.lastInsertRowid);
      logAudit(app.db, { actorType: "admin", actorId: adminId, action: "admin.register" });
      setAuthCookie(app, reply, createAuthSession(app.db, "admin", adminId));
      reply.status(201).send({ ok: true, data: { type: "admin", id: adminId, username } });
    },
  );

  app.post(
    "/api/v1/auth/admin/login",
    {
      config: AUTH_RATE_LIMIT,
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          properties: { username: { type: "string" }, password: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { username, password } = req.body as { username: string; password: string };
      const admin = app.db.prepare("SELECT id, username, password_hash FROM admins WHERE username=?").get(username) as
        | { id: number; username: string; password_hash: string }
        | undefined;
      if (!admin || !verifySecret(password, admin.password_hash)) {
        return reply
          .status(401)
          .send({ ok: false, error: { code: "INVALID_CREDENTIALS", message: "Sai tên đăng nhập hoặc mật khẩu" } });
      }
      logAudit(app.db, { actorType: "admin", actorId: admin.id, action: "admin.login" });
      setAuthCookie(app, reply, createAuthSession(app.db, "admin", admin.id));
      return { ok: true, data: { type: "admin", id: admin.id, username: admin.username } };
    },
  );

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const token = req.cookies[COOKIE_NAME];
    if (token) destroyAuthSession(app.db, token);
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true, data: null };
  });

  app.get("/api/v1/auth/me", async (req) => {
    return { ok: true, data: req.principal };
  });

  // ---- Người chơi tham gia phiên bằng mã ----

  app.get("/api/v1/join/:code", async (req, reply) => {
    const code = ((req.params as { code: string }).code ?? "").toUpperCase();
    const session = app.db
      .prepare("SELECT id, name, status FROM game_sessions WHERE join_code=?")
      .get(code) as { id: number; name: string; status: string } | undefined;
    if (!session || session.status === "ended") {
      return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Mã phiên không hợp lệ" } });
    }
    const players = app.db
      .prepare(
        `SELECT id, display_name, avatar, status, (pin_hash IS NOT NULL) AS has_pin
         FROM players WHERE session_id=? AND status != 'removed' ORDER BY id`,
      )
      .all(session.id);
    return { ok: true, data: { session, players } };
  });

  app.post(
    "/api/v1/join/:code/claim",
    {
      config: AUTH_RATE_LIMIT,
      schema: {
        body: {
          type: "object",
          required: ["playerId", "pin"],
          properties: {
            playerId: { type: "integer" },
            pin: { type: "string", pattern: PIN_PATTERN },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const code = ((req.params as { code: string }).code ?? "").toUpperCase();
      const { playerId, pin } = req.body as { playerId: number; pin: string };
      const session = app.db.prepare("SELECT id, status FROM game_sessions WHERE join_code=?").get(code) as
        | { id: number; status: string }
        | undefined;
      if (!session || session.status === "ended") {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Mã phiên không hợp lệ" } });
      }
      const player = app.db
        .prepare("SELECT id, pin_hash, display_name FROM players WHERE id=? AND session_id=? AND status != 'removed'")
        .get(playerId, session.id) as { id: number; pin_hash: string | null; display_name: string } | undefined;
      if (!player) {
        return reply.status(404).send({ ok: false, error: { code: "PLAYER_NOT_FOUND", message: "Người chơi không tồn tại" } });
      }

      try {
        if (player.pin_hash === null) {
          // Lần đầu nhận nhân vật: đặt PIN
          app.db.prepare("UPDATE players SET pin_hash=? WHERE id=?").run(hashSecret(pin), player.id);
          logAudit(app.db, { sessionId: session.id, actorType: "player", actorId: player.id, action: "player.set_pin" });
        } else {
          verifyPin(app.db, player.id, pin);
        }
      } catch (err) {
        return sendLedgerError(reply, err);
      }
      logAudit(app.db, { sessionId: session.id, actorType: "player", actorId: player.id, action: "player.join" });
      setAuthCookie(app, reply, createAuthSession(app.db, "player", player.id));
      return { ok: true, data: { type: "player", id: player.id, sessionId: session.id, displayName: player.display_name } };
    },
  );

  app.post(
    "/api/v1/join/:code/register",
    {
      config: AUTH_RATE_LIMIT,
      schema: {
        body: {
          type: "object",
          required: ["displayName", "pin"],
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 40 },
            pin: { type: "string", pattern: PIN_PATTERN },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const code = ((req.params as { code: string }).code ?? "").toUpperCase();
      const { displayName, pin } = req.body as { displayName: string; pin: string };
      const session = app.db.prepare("SELECT id, status FROM game_sessions WHERE join_code=?").get(code) as
        | { id: number; status: string }
        | undefined;
      if (!session || session.status === "ended") {
        return reply.status(404).send({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "Mã phiên không hợp lệ" } });
      }
      try {
        const player = createPlayer(app.db, session.id, displayName, undefined, hashSecret(pin));
        logAudit(app.db, { sessionId: session.id, actorType: "player", actorId: player.id, action: "player.self_join" });
        setAuthCookie(app, reply, createAuthSession(app.db, "player", player.id));
        reply
          .status(201)
          .send({ ok: true, data: { type: "player", id: player.id, sessionId: session.id, displayName: player.display_name } });
      } catch (err) {
        return sendLedgerError(reply, err);
      }
    },
  );
}
