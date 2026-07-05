import Database from "better-sqlite3";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reconcile } from "./ledger.js";

// Sao lưu bằng VACUUM INTO — snapshot nhất quán kể cả khi đang có giao dịch (WAL).

export interface BackupResult {
  file: string;
  bytes: number;
}

export function createBackup(db: Database.Database, dir: string): BackupResult {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const raw = join(dir, `bb-${stamp}.db`);
  db.prepare("VACUUM INTO ?").run(raw);
  const gz = `${raw}.gz`;
  writeFileSync(gz, gzipSync(readFileSync(raw)));
  unlinkSync(raw);
  return { file: gz, bytes: statSync(gz).size };
}

/** Giữ lại `keep` bản mới nhất, xóa phần còn lại. Trả về danh sách file đã xóa. */
export function rotateBackups(dir: string, keep = 7): string[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^bb-.*\.db\.gz$/.test(f));
  } catch {
    return [];
  }
  files.sort().reverse(); // tên chứa timestamp → sort = thứ tự thời gian
  const removed = files.slice(keep);
  for (const f of removed) unlinkSync(join(dir, f));
  return removed;
}

export interface VerifyResult {
  ok: boolean;
  integrity: string;
  sessions: number;
  transactions: number;
  reconcileMismatches: number;
}

/** Diễn tập khôi phục: giải nén, mở, kiểm toàn vẹn + đối soát toàn bộ sổ cái. */
export function verifyBackup(gzPath: string): VerifyResult {
  const tmp = join(tmpdir(), `bb-verify-${Date.now()}.db`);
  writeFileSync(tmp, gunzipSync(readFileSync(gzPath)));
  const db = new Database(tmp, { readonly: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true }) as string;
    const sessions = db.prepare("SELECT id FROM game_sessions").all() as { id: number }[];
    const transactions = (db.prepare("SELECT COUNT(*) AS c FROM transactions").get() as { c: number }).c;
    let mismatches = 0;
    for (const s of sessions) mismatches += reconcile(db, s.id).length;
    return {
      ok: integrity === "ok" && mismatches === 0,
      integrity,
      sessions: sessions.length,
      transactions,
      reconcileMismatches: mismatches,
    };
  } finally {
    db.close();
    rmSync(tmp, { force: true });
  }
}
