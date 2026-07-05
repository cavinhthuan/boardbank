import type { FastifyInstance } from "fastify";
import { createBackup, rotateBackups, verifyBackup } from "../backup.js";
import { deny } from "../auth.js";
import { logAudit } from "../lib/audit.js";

export function adminRoutes(app: FastifyInstance): void {
  // Sao lưu theo yêu cầu (cron trên VPS dùng sqlite3 CLI — xem docs/DEPLOY.md)
  app.post("/api/v1/admin/backup", async (req, reply) => {
    if (req.principal?.type !== "admin") return deny(app, req, reply);
    const result = createBackup(app.db, app.config.backupDir);
    const removed = rotateBackups(app.config.backupDir, 7);
    const verified = verifyBackup(result.file);
    logAudit(app.db, {
      actorType: "admin",
      actorId: req.principal.id,
      action: "backup.create",
      detail: { file: result.file, bytes: result.bytes, verified: verified.ok },
    });
    return { ok: true, data: { ...result, rotatedOut: removed.length, verify: verified } };
  });

  // Nhật ký hoạt động toàn hệ thống: mọi phiên thuộc bank của admin này + hành động của chính họ
  app.get(
    "/api/v1/admin/audit",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      if (req.principal?.type !== "admin") return deny(app, req, reply);
      const { limit } = req.query as { limit: number };
      const rows = app.db
        .prepare(
          `SELECT al.*, s.name AS session_name
           FROM audit_log al
           LEFT JOIN game_sessions s ON s.id = al.session_id
           WHERE al.session_id IN (
                   SELECT s2.id FROM game_sessions s2 JOIN banks b ON b.id = s2.bank_id WHERE b.owner_admin_id = ?
                 )
              OR (al.actor_type = 'admin' AND al.actor_id = ?)
           ORDER BY al.id DESC LIMIT ?`,
        )
        .all(req.principal.id, req.principal.id, limit);
      return { ok: true, data: rows };
    },
  );
}
