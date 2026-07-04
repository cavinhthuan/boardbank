import type Database from "better-sqlite3";

export function logAudit(
  db: Database.Database,
  entry: {
    sessionId?: number | null;
    actorType: string;
    actorId?: number | null;
    action: string;
    target?: string;
    detail?: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO audit_log (session_id, actor_type, actor_id, action, target, detail_json)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    entry.sessionId ?? null,
    entry.actorType,
    entry.actorId ?? null,
    entry.action,
    entry.target ?? null,
    entry.detail === undefined ? null : JSON.stringify(entry.detail),
  );
}
