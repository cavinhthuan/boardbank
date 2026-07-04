import type Database from "better-sqlite3";
import { generateTxCode } from "./lib/ids.js";

// Sổ cái append-only: mọi loại giao dịch đều là một tập entries có tổng = 0
// theo từng tài sản. Số dư accounts.balance_cached được cập nhật trong CÙNG
// SQLite transaction — nguồn sự thật vẫn là transaction_entries.

export class LedgerError extends Error {
  statusCode: number;
  code: string;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface EntryInput {
  accountId: number;
  assetTypeId: number;
  amount: number; // integer minor-unit, +/-; khác 0
}

export interface PostTxInput {
  sessionId: number;
  type: string;
  note?: string;
  createdBy?: string;
  idempotencyKey?: string;
  entries: EntryInput[];
  /** account id được phép âm số dư (vd: kho bạc bank khi phát hành tiền) */
  allowNegative?: number[];
}

export interface TxRecord {
  id: number;
  code: string;
  type: string;
  status: string;
  note: string | null;
  created_at: string;
}

export function ensureAccount(
  db: Database.Database,
  sessionId: number,
  ownerType: "player" | "bank",
  ownerId: number,
  assetTypeId: number,
): number {
  const found = db
    .prepare(
      `SELECT id FROM accounts
       WHERE session_id=? AND owner_type=? AND owner_id=? AND asset_type_id=?`,
    )
    .get(sessionId, ownerType, ownerId, assetTypeId) as { id: number } | undefined;
  if (found) return found.id;
  const r = db
    .prepare(
      `INSERT INTO accounts (session_id, owner_type, owner_id, asset_type_id)
       VALUES (?,?,?,?)`,
    )
    .run(sessionId, ownerType, ownerId, assetTypeId);
  return Number(r.lastInsertRowid);
}

export function postTransaction(db: Database.Database, input: PostTxInput): TxRecord {
  if (input.entries.length === 0) {
    throw new LedgerError("EMPTY_TRANSACTION", "Giao dịch không có bút toán");
  }
  for (const e of input.entries) {
    if (!Number.isInteger(e.amount) || e.amount === 0) {
      throw new LedgerError("INVALID_AMOUNT", "Số tiền phải là số nguyên khác 0");
    }
  }
  // Tổng mỗi tài sản phải = 0 (zero-sum) — tiền không tự sinh/mất
  const sums = new Map<number, number>();
  for (const e of input.entries) {
    sums.set(e.assetTypeId, (sums.get(e.assetTypeId) ?? 0) + e.amount);
  }
  for (const [asset, sum] of sums) {
    if (sum !== 0) {
      throw new LedgerError("UNBALANCED", `Bút toán tài sản ${asset} không cân bằng (lệch ${sum})`);
    }
  }

  const run = db.transaction((): TxRecord => {
    if (input.idempotencyKey) {
      const dup = db
        .prepare("SELECT id, code, type, status, note, created_at FROM transactions WHERE idempotency_key=?")
        .get(input.idempotencyKey) as TxRecord | undefined;
      if (dup) return dup;
    }

    const txr = db
      .prepare(
        `INSERT INTO transactions (session_id, code, type, status, note, created_by, idempotency_key, completed_at)
         VALUES (?,?,?,'completed',?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(
        input.sessionId,
        generateTxCode(),
        input.type,
        input.note ?? null,
        input.createdBy ?? null,
        input.idempotencyKey ?? null,
      );
    const txId = Number(txr.lastInsertRowid);

    const insEntry = db.prepare(
      "INSERT INTO transaction_entries (transaction_id, account_id, asset_type_id, amount) VALUES (?,?,?,?)",
    );
    const updBalance = db.prepare(
      "UPDATE accounts SET balance_cached = balance_cached + ? WHERE id=? AND session_id=?",
    );
    const getAccount = db.prepare(
      "SELECT id, balance_cached, owner_type FROM accounts WHERE id=? AND session_id=?",
    );

    for (const e of input.entries) {
      const acc = getAccount.get(e.accountId, input.sessionId) as
        | { id: number; balance_cached: number; owner_type: string }
        | undefined;
      if (!acc) {
        throw new LedgerError("ACCOUNT_NOT_FOUND", `Tài khoản ${e.accountId} không thuộc phiên này`, 404);
      }
      const newBalance = acc.balance_cached + e.amount;
      const mayGoNegative =
        acc.owner_type === "bank" || input.allowNegative?.includes(e.accountId);
      if (newBalance < 0 && !mayGoNegative) {
        throw new LedgerError("INSUFFICIENT_FUNDS", "Số dư không đủ", 422);
      }
      insEntry.run(txId, e.accountId, e.assetTypeId, e.amount);
      updBalance.run(e.amount, e.accountId, input.sessionId);
    }

    return db
      .prepare("SELECT id, code, type, status, note, created_at FROM transactions WHERE id=?")
      .get(txId) as TxRecord;
  });

  return run();
}

/** Đối soát: balance_cached phải khớp SUM(entries) cho mọi tài khoản của phiên. */
export function reconcile(db: Database.Database, sessionId: number): { accountId: number; cached: number; actual: number }[] {
  const rows = db
    .prepare(
      `SELECT a.id AS accountId, a.balance_cached AS cached,
              COALESCE((SELECT SUM(e.amount) FROM transaction_entries e WHERE e.account_id = a.id), 0) AS actual
       FROM accounts a WHERE a.session_id = ?`,
    )
    .all(sessionId) as { accountId: number; cached: number; actual: number }[];
  return rows.filter((r) => r.cached !== r.actual);
}
