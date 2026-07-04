import type Database from "better-sqlite3";
import { LedgerError, ensureAccount, postTransaction } from "../ledger.js";

const DEFAULT_AVATARS = ["🦊", "🐼", "🦁", "🐸", "🐙", "🦄", "🐯", "🐨", "🐧", "🦖"];

export interface PlayerRow {
  id: number;
  session_id: number;
  display_name: string;
  avatar: string | null;
  role: string;
  status: string;
  created_at: string;
}

/**
 * Tạo người chơi trong phiên + mở tài khoản cho mọi tài sản + cấp số dư ban đầu
 * (qua giao dịch 'issue'). Dùng chung cho admin thêm người chơi và người chơi tự tham gia.
 */
export function createPlayer(
  db: Database.Database,
  sessionId: number,
  displayName: string,
  avatar?: string,
  pinHash?: string,
): PlayerRow {
  const session = db.prepare("SELECT id, status, config_json FROM game_sessions WHERE id=?").get(sessionId) as
    | { id: number; status: string; config_json: string }
    | undefined;
  if (!session) throw new LedgerError("SESSION_NOT_FOUND", "Phiên không tồn tại", 404);
  if (session.status === "ended") throw new LedgerError("SESSION_ENDED", "Phiên đã kết thúc", 422);

  const name = displayName.trim();
  const dup = db.prepare("SELECT id FROM players WHERE session_id=? AND display_name=?").get(sessionId, name);
  if (dup) throw new LedgerError("NAME_TAKEN", "Tên đã được dùng trong phiên này", 409);

  const config = JSON.parse(session.config_json) as { initialBalance?: number };
  const initial = config.initialBalance ?? 0;

  const playerId = db.transaction(() => {
    const pickedAvatar =
      avatar ??
      DEFAULT_AVATARS[
        (db.prepare("SELECT COUNT(*) AS c FROM players WHERE session_id=?").get(sessionId) as { c: number }).c %
          DEFAULT_AVATARS.length
      ];
    const pr = db
      .prepare("INSERT INTO players (session_id, display_name, avatar, pin_hash) VALUES (?,?,?,?)")
      .run(sessionId, name, pickedAvatar, pinHash ?? null);
    const pid = Number(pr.lastInsertRowid);

    const assets = db.prepare("SELECT id, is_primary FROM asset_types WHERE session_id=?").all(sessionId) as {
      id: number;
      is_primary: number;
    }[];
    for (const asset of assets) {
      const accId = ensureAccount(db, sessionId, "player", pid, asset.id);
      if (asset.is_primary && initial > 0) {
        const bankAccId = ensureAccount(db, sessionId, "bank", 0, asset.id);
        postTransaction(db, {
          sessionId,
          type: "issue",
          note: "Cấp số dư ban đầu",
          createdBy: "system",
          entries: [
            { accountId: bankAccId, assetTypeId: asset.id, amount: -initial },
            { accountId: accId, assetTypeId: asset.id, amount: initial },
          ],
        });
      }
    }
    return pid;
  })();

  return db.prepare("SELECT * FROM players WHERE id=?").get(playerId) as PlayerRow;
}
