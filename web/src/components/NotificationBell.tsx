import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

interface NotificationRow {
  id: number;
  type: string;
  payload_json: string;
  read_at: string | null;
  created_at: string;
}

export function describeNotification(n: { type: string; payload_json: string }): string {
  try {
    const p = JSON.parse(n.payload_json) as {
      amount?: number;
      counterparty?: string | null;
      note?: string | null;
      assetName?: string;
      from?: string;
      interest?: number;
      outstanding?: number;
      balance?: number;
    };
    const fmt = (x: number | undefined) => (x ?? 0).toLocaleString("vi-VN");
    const amt = `${fmt(p.amount)} ${p.assetName ?? ""}`.trim();
    const note = p.note ? ` — ${p.note}` : "";
    switch (n.type) {
      case "tx.received":
        return `💰 Nhận ${amt} từ ${p.counterparty ?? "?"}${note}`;
      case "tx.deducted":
        return `📤 Bị trừ ${amt} (${p.counterparty ?? "ngân hàng"})${note}`;
      case "invoice.created":
        return `🧾 ${p.from ?? "?"} gửi hóa đơn ${fmt(p.amount)}${note}`;
      case "invoice.canceled":
        return `🧾 Hóa đơn ${fmt(p.amount)} đã bị hủy`;
      case "loan.interest":
        return `📈 Lãi vay +${fmt(p.interest)} — dư nợ ${fmt(p.outstanding)}`;
      case "saving.interest":
        return `🏦 Lãi tiết kiệm +${fmt(p.interest)} — sổ còn ${fmt(p.balance)}`;
      default:
        return n.type;
    }
  } catch {
    return n.type;
  }
}

export default function NotificationBell({
  sessionId,
  refreshKey,
}: {
  sessionId: number | string;
  refreshKey: number;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    const { data, meta } = await api.getWithMeta<NotificationRow[], { unread: number }>(
      `/api/v1/sessions/${sessionId}/notifications?limit=30`,
    );
    setRows(data);
    setUnread(meta.unread);
  }, [sessionId]);

  useEffect(() => {
    load().catch(() => {});
  }, [load, refreshKey]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      await api.post(`/api/v1/sessions/${sessionId}/notifications/read`, {}).catch(() => {});
      setUnread(0);
    }
  }

  return (
    <div className="relative">
      <button onClick={toggle} className="relative rounded-lg px-2 py-1.5 text-xl hover:bg-slate-800" title="Thông báo">
        🔔
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 max-h-80 w-72 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 shadow-xl">
          {rows.map((n) => (
            <div key={n.id} className={`border-b border-slate-800 px-3 py-2 text-sm last:border-0 ${n.read_at ? "text-slate-400" : ""}`}>
              {describeNotification(n)}
              <div className="mt-0.5 text-xs text-slate-500">{new Date(n.created_at).toLocaleTimeString("vi-VN")}</div>
            </div>
          ))}
          {rows.length === 0 && <div className="px-3 py-3 text-sm text-slate-500">Chưa có thông báo.</div>}
        </div>
      )}
    </div>
  );
}
