import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Migration là additive-only (quy tắc tương thích ngược trong master plan).
// Mỗi phần tử chạy đúng một lần, theo dõi bằng PRAGMA user_version.
const MIGRATIONS: string[] = [
  // 001: audit log — nền tảng truy vết cho mọi phase sau
  `CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    session_id INTEGER,
    actor_type TEXT NOT NULL,
    actor_id INTEGER,
    action TEXT NOT NULL,
    target TEXT,
    detail_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_audit_session ON audit_log(session_id, created_at);`,
];

export function openDb(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Database.Database): number {
  let version = db.pragma("user_version", { simple: true }) as number;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
    version++;
  }
  return version;
}
