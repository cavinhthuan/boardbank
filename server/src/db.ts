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

  // 002: lõi domain Phase 1 — bank, phiên chơi, tài sản, người chơi, tài khoản, sổ cái
  `CREATE TABLE banks (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    logo_path TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE game_sessions (
    id INTEGER PRIMARY KEY,
    bank_id INTEGER NOT NULL REFERENCES banks(id),
    name TEXT NOT NULL,
    join_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','ended')),
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at TEXT,
    ended_at TEXT
  );
  CREATE TABLE asset_types (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES game_sessions(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    decimals INTEGER NOT NULL DEFAULT 0,
    is_primary INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, code)
  );
  CREATE TABLE players (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES game_sessions(id),
    display_name TEXT NOT NULL,
    avatar TEXT,
    pin_hash TEXT,
    role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player','admin')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','removed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(session_id, display_name)
  );
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES game_sessions(id),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('player','bank')),
    owner_id INTEGER NOT NULL,
    asset_type_id INTEGER NOT NULL REFERENCES asset_types(id),
    balance_cached INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, owner_type, owner_id, asset_type_id)
  );
  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES game_sessions(id),
    code TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','reversed','failed')),
    note TEXT,
    created_by TEXT,
    idempotency_key TEXT UNIQUE,
    reversed_by_tx_id INTEGER REFERENCES transactions(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at TEXT
  );
  CREATE INDEX idx_tx_session ON transactions(session_id, created_at);
  CREATE TABLE transaction_entries (
    id INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    asset_type_id INTEGER NOT NULL REFERENCES asset_types(id),
    amount INTEGER NOT NULL
  );
  CREATE INDEX idx_entries_tx ON transaction_entries(transaction_id);
  CREATE INDEX idx_entries_account ON transaction_entries(account_id);`,

  // 003: xác thực & phân quyền Phase 3
  `CREATE TABLE admins (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE auth_sessions (
    id INTEGER PRIMARY KEY,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('admin','player')),
    principal_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  ALTER TABLE banks ADD COLUMN owner_admin_id INTEGER REFERENCES admins(id);
  ALTER TABLE players ADD COLUMN pin_failed_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE players ADD COLUMN pin_locked_until TEXT;`,

  // 004: thông báo Phase 4 (player_id NULL = broadcast cho cả phiên)
  `CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES game_sessions(id),
    player_id INTEGER REFERENCES players(id),
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_notif_target ON notifications(session_id, player_id, id);`,

  // 005: đa tài sản & quy đổi Phase 5
  // Tỷ giá lưu dạng phân số nguyên (num/den) — tính bằng BigInt, không sai số float.
  `CREATE TABLE exchange_rates (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES game_sessions(id),
    from_asset_id INTEGER NOT NULL REFERENCES asset_types(id),
    to_asset_id INTEGER NOT NULL REFERENCES asset_types(id),
    rate_num INTEGER NOT NULL CHECK (rate_num > 0),
    rate_den INTEGER NOT NULL DEFAULT 1 CHECK (rate_den > 0),
    updated_by TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(session_id, from_asset_id, to_asset_id)
  );
  ALTER TABLE asset_types ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE transactions ADD COLUMN meta_json TEXT;`,
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
