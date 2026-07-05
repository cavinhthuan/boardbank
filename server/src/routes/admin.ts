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
}
