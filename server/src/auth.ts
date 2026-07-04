import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifySecret } from "./lib/passwords.js";
import { logAudit } from "./lib/audit.js";
import { LedgerError } from "./ledger.js";

export const COOKIE_NAME = "bb_token";
const SESSION_TTL_DAYS = 30;
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MINUTES = 5;

export interface AdminPrincipal {
  type: "admin";
  id: number;
  username: string;
}

export interface PlayerPrincipal {
  type: "player";
  id: number;
  sessionId: number;
  role: "player" | "admin";
  status: string;
  displayName: string;
}

export type Principal = AdminPrincipal | PlayerPrincipal;

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createAuthSession(
  db: Database.Database,
  principalType: "admin" | "player",
  principalId: number,
): string {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
  db.prepare(
    "INSERT INTO auth_sessions (principal_type, principal_id, token_hash, expires_at) VALUES (?,?,?,?)",
  ).run(principalType, principalId, hashToken(token), expires);
  return token;
}

export function destroyAuthSession(db: Database.Database, token: string): void {
  db.prepare("DELETE FROM auth_sessions WHERE token_hash=?").run(hashToken(token));
}

export function resolvePrincipal(db: Database.Database, token: string): Principal | null {
  const row = db
    .prepare("SELECT principal_type, principal_id, expires_at FROM auth_sessions WHERE token_hash=?")
    .get(hashToken(token)) as { principal_type: string; principal_id: number; expires_at: string } | undefined;
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    db.prepare("DELETE FROM auth_sessions WHERE token_hash=?").run(hashToken(token));
    return null;
  }
  if (row.principal_type === "admin") {
    const admin = db.prepare("SELECT id, username FROM admins WHERE id=?").get(row.principal_id) as
      | { id: number; username: string }
      | undefined;
    return admin ? { type: "admin", id: admin.id, username: admin.username } : null;
  }
  const player = db
    .prepare("SELECT id, session_id, role, status, display_name FROM players WHERE id=? AND status != 'removed'")
    .get(row.principal_id) as
    | { id: number; session_id: number; role: "player" | "admin"; status: string; display_name: string }
    | undefined;
  return player
    ? {
        type: "player",
        id: player.id,
        sessionId: player.session_id,
        role: player.role,
        status: player.status,
        displayName: player.display_name,
      }
    : null;
}

/** Gắn req.principal cho mọi request từ cookie (nếu có). */
export function registerAuthHook(app: FastifyInstance): void {
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[COOKIE_NAME];
    req.principal = token ? resolvePrincipal(app.db, token) : null;
  });
}

/** Session-admin = admin sở hữu bank của phiên HOẶC player role 'admin' trong phiên. */
export function isSessionAdmin(db: Database.Database, principal: Principal, sessionId: number): boolean {
  if (principal.type === "admin") {
    const row = db
      .prepare(
        `SELECT 1 FROM game_sessions s JOIN banks b ON b.id = s.bank_id
         WHERE s.id=? AND b.owner_admin_id=?`,
      )
      .get(sessionId, principal.id);
    return !!row;
  }
  return principal.sessionId === sessionId && principal.role === "admin";
}

export function isSessionMember(db: Database.Database, principal: Principal, sessionId: number): boolean {
  if (principal.type === "player") return principal.sessionId === sessionId;
  return isSessionAdmin(db, principal, sessionId);
}

/** Từ chối truy cập: trả 401/403 và GHI AUDIT (yêu cầu DoD Phase 3). */
export function deny(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  sessionId?: number,
): FastifyReply {
  if (!req.principal) {
    return reply.status(401).send({ ok: false, error: { code: "UNAUTHENTICATED", message: "Chưa đăng nhập" } });
  }
  logAudit(app.db, {
    sessionId: sessionId ?? null,
    actorType: req.principal.type,
    actorId: req.principal.id,
    action: "auth.denied",
    target: `${req.method} ${req.url}`,
  });
  return reply.status(403).send({ ok: false, error: { code: "FORBIDDEN", message: "Không có quyền thực hiện" } });
}

/**
 * Xác minh PIN với khóa tạm: sai PIN_MAX_FAILS lần liên tiếp → khóa PIN_LOCK_MINUTES phút.
 * Ném LedgerError với code PIN_LOCKED / PIN_INVALID / PIN_NOT_SET.
 */
export function verifyPin(db: Database.Database, playerId: number, pin: string): void {
  const player = db
    .prepare("SELECT id, pin_hash, pin_failed_count, pin_locked_until FROM players WHERE id=?")
    .get(playerId) as
    | { id: number; pin_hash: string | null; pin_failed_count: number; pin_locked_until: string | null }
    | undefined;
  if (!player) throw new LedgerError("PLAYER_NOT_FOUND", "Người chơi không tồn tại", 404);
  if (!player.pin_hash) throw new LedgerError("PIN_NOT_SET", "Chưa thiết lập PIN", 422);

  const now = new Date().toISOString();
  if (player.pin_locked_until && player.pin_locked_until > now) {
    throw new LedgerError("PIN_LOCKED", `Nhập sai PIN quá ${PIN_MAX_FAILS} lần — thử lại sau ${PIN_LOCK_MINUTES} phút`, 423);
  }

  if (!verifySecret(pin, player.pin_hash)) {
    const fails = player.pin_failed_count + 1;
    if (fails >= PIN_MAX_FAILS) {
      const until = new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString();
      db.prepare("UPDATE players SET pin_failed_count=0, pin_locked_until=? WHERE id=?").run(until, playerId);
      throw new LedgerError("PIN_LOCKED", `Nhập sai PIN quá ${PIN_MAX_FAILS} lần — thử lại sau ${PIN_LOCK_MINUTES} phút`, 423);
    }
    db.prepare("UPDATE players SET pin_failed_count=? WHERE id=?").run(fails, playerId);
    throw new LedgerError("PIN_INVALID", "PIN không đúng", 422);
  }

  if (player.pin_failed_count > 0 || player.pin_locked_until) {
    db.prepare("UPDATE players SET pin_failed_count=0, pin_locked_until=NULL WHERE id=?").run(playerId);
  }
}
