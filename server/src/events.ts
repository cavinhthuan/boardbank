import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

// SSE hub trong tiến trình — không Redis, không pub/sub ngoài.
// Mỗi kết nối ~vài KB; heartbeat 30s dọn kết nối zombie.

const HEARTBEAT_MS = 30_000;

interface SseWritable {
  write(chunk: string): boolean;
  end?(): void;
}

export interface SseClient {
  sessionId: number;
  /** null = admin theo dõi phiên (nhận mọi broadcast, không nhận event cá nhân) */
  playerId: number | null;
  raw: SseWritable;
}

export interface SseEvent {
  type: string;
  data: unknown;
  /** nếu đặt, chỉ gửi cho kết nối của đúng người chơi này */
  toPlayerId?: number;
}

export class EventHub {
  private bySession = new Map<number, Set<SseClient>>();
  private heartbeat: NodeJS.Timeout;

  constructor() {
    this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  subscribe(sessionId: number, playerId: number | null, raw: SseWritable): SseClient {
    const client: SseClient = { sessionId, playerId, raw };
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.bySession.set(sessionId, set);
    }
    set.add(client);
    return client;
  }

  unsubscribe(client: SseClient): void {
    const set = this.bySession.get(client.sessionId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) this.bySession.delete(client.sessionId);
  }

  publish(sessionId: number, event: SseEvent): void {
    const set = this.bySession.get(sessionId);
    if (!set) return;
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    for (const client of [...set]) {
      if (event.toPlayerId !== undefined && client.playerId !== event.toPlayerId) continue;
      this.safeWrite(client, frame);
    }
  }

  count(): number {
    let n = 0;
    for (const set of this.bySession.values()) n += set.size;
    return n;
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const set of this.bySession.values()) {
      for (const client of set) client.raw.end?.();
    }
    this.bySession.clear();
  }

  private ping(): void {
    for (const set of this.bySession.values()) {
      for (const client of [...set]) this.safeWrite(client, ": ping\n\n");
    }
  }

  private safeWrite(client: SseClient, chunk: string): void {
    try {
      client.raw.write(chunk);
    } catch {
      this.unsubscribe(client); // kết nối chết → dọn
    }
  }
}

declare module "fastify" {
  interface FastifyInstance {
    events: EventHub;
  }
}

export interface NotificationRow {
  id: number;
  session_id: number;
  player_id: number | null;
  type: string;
  payload_json: string;
  read_at: string | null;
  created_at: string;
}

export function createNotification(
  db: Database.Database,
  sessionId: number,
  playerId: number | null,
  type: string,
  payload: unknown,
): NotificationRow {
  const r = db
    .prepare("INSERT INTO notifications (session_id, player_id, type, payload_json) VALUES (?,?,?,?)")
    .run(sessionId, playerId, type, JSON.stringify(payload));
  return db.prepare("SELECT * FROM notifications WHERE id=?").get(r.lastInsertRowid) as NotificationRow;
}

/**
 * Sau khi một giao dịch hoàn tất: phát event 'tx' cho cả phiên,
 * tạo notification + event cá nhân cho từng người chơi liên quan (trừ người tạo).
 */
export function emitTxEvents(app: FastifyInstance, sessionId: number, txId: number): void {
  const tx = app.db
    .prepare("SELECT id, code, type, status, note, created_by, created_at FROM transactions WHERE id=?")
    .get(txId) as
    | { id: number; code: string; type: string; status: string; note: string | null; created_by: string | null; created_at: string }
    | undefined;
  if (!tx) return;

  const entries = app.db
    .prepare(
      `SELECT e.amount, e.asset_type_id, a.owner_type, a.owner_id,
              CASE WHEN a.owner_type='player' THEN (SELECT display_name FROM players p WHERE p.id=a.owner_id) ELSE 'Ngân hàng' END AS owner_name,
              (SELECT name FROM asset_types at2 WHERE at2.id=e.asset_type_id) AS asset_name
       FROM transaction_entries e JOIN accounts a ON a.id=e.account_id
       WHERE e.transaction_id=?`,
    )
    .all(txId) as {
    amount: number;
    asset_type_id: number;
    owner_type: string;
    owner_id: number;
    owner_name: string;
    asset_name: string;
  }[];

  app.events.publish(sessionId, { type: "tx", data: { id: tx.id, code: tx.code, type: tx.type, status: tx.status } });

  for (const entry of entries) {
    if (entry.owner_type !== "player") continue;
    if (tx.created_by === `player:${entry.owner_id}`) continue; // không tự thông báo cho chính mình
    const counterparty = entries.find((e) => Math.sign(e.amount) !== Math.sign(entry.amount));
    const notif = createNotification(app.db, sessionId, entry.owner_id, entry.amount > 0 ? "tx.received" : "tx.deducted", {
      txId: tx.id,
      code: tx.code,
      txType: tx.type,
      amount: Math.abs(entry.amount),
      assetTypeId: entry.asset_type_id,
      assetName: entry.asset_name,
      counterparty: counterparty?.owner_name ?? null,
      note: tx.note,
    });
    app.events.publish(sessionId, { type: "notification", toPlayerId: entry.owner_id, data: notif });
  }
}

/** Danh sách người chơi/trạng thái thay đổi — client refetch. */
export function emitPlayersChanged(app: FastifyInstance, sessionId: number): void {
  app.events.publish(sessionId, { type: "players", data: {} });
}
