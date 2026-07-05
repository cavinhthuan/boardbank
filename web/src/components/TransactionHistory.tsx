import { useCallback, useEffect, useState } from "react";
import { api, type Player, type Tx } from "../api";

const TYPE_LABELS: Record<string, string> = {
  transfer: "Chuyển khoản",
  issue: "Phát hành",
  reward: "Thưởng",
  recall: "Thu hồi",
  penalty: "Phạt",
  adjust: "Điều chỉnh",
  reversal: "Hoàn tác",
};

interface Props {
  sessionId: string;
  players: Player[];
  refreshKey: number;
  onChanged: () => void;
}

function describe(tx: Tx): string {
  const neg = tx.entries.find((e) => e.amount < 0);
  const pos = tx.entries.find((e) => e.amount > 0);
  if (!neg || !pos) return "";
  return `${neg.owner_name} → ${pos.owner_name}`;
}

function amountOf(tx: Tx): number {
  return tx.entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
}

interface SavedFilter {
  type?: string;
  playerId?: string;
  q?: string;
}

function loadFilter(sessionId: string): SavedFilter {
  try {
    return JSON.parse(localStorage.getItem(`bb.histfilter.${sessionId}`) ?? "{}") as SavedFilter;
  } catch {
    return {};
  }
}

export default function TransactionHistory({ sessionId, players, refreshKey, onChanged }: Props) {
  const saved = loadFilter(sessionId);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState(saved.type ?? "");
  const [playerFilter, setPlayerFilter] = useState(saved.playerId ?? "");
  const [search, setSearch] = useState(saved.q ?? "");
  const [error, setError] = useState<string | null>(null);

  // Lưu bộ lọc theo phiên — mở lại vẫn giữ nguyên
  useEffect(() => {
    try {
      localStorage.setItem(
        `bb.histfilter.${sessionId}`,
        JSON.stringify({ type: typeFilter, playerId: playerFilter, q: search }),
      );
    } catch {
      /* chế độ riêng tư */
    }
  }, [sessionId, typeFilter, playerFilter, search]);

  const load = useCallback(
    async (before?: number) => {
      const params = new URLSearchParams({ limit: "20" });
      if (before) params.set("before", String(before));
      if (typeFilter) params.set("type", typeFilter);
      if (playerFilter) params.set("playerId", playerFilter);
      if (search.trim()) params.set("q", search.trim());
      const { data, meta } = await api.getWithMeta<Tx[], { nextBefore: number | null }>(
        `/api/v1/sessions/${sessionId}/transactions?${params}`,
      );
      setTxs((prev) => (before ? [...prev, ...data] : data));
      setNextBefore(meta.nextBefore);
    },
    [sessionId, typeFilter, playerFilter, search],
  );

  // debounce nhẹ cho ô tìm kiếm
  useEffect(() => {
    const t = setTimeout(() => {
      load().catch((e) => setError((e as Error).message));
    }, 250);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  async function reverse(txId: number) {
    try {
      setError(null);
      await api.post(`/api/v1/sessions/${sessionId}/transactions/${txId}/reverse`, {});
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const select =
    "rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm outline-none focus:border-emerald-500";

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Lịch sử giao dịch</h2>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={select}>
          <option value="">Mọi loại</option>
          {Object.entries(TYPE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select value={playerFilter} onChange={(e) => setPlayerFilter(e.target.value)} className={select}>
          <option value="">Mọi người chơi</option>
          {players.map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 ghi chú, mã TX, tên…"
          className={`${select} min-w-40 flex-1`}
        />
      </div>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}

      <ul className="space-y-1.5">
        {txs.map((tx) => (
          <li
            key={tx.id}
            className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 ${
              tx.status === "reversed" ? "opacity-50" : ""
            }`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">
                  {TYPE_LABELS[tx.type] ?? tx.type}
                </span>
                <span className="truncate text-sm">{describe(tx)}</span>
                {tx.status === "reversed" && <span className="text-xs text-amber-400">đã hoàn tác</span>}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                <span className="font-mono">{tx.code}</span>
                {tx.note && <span> · {tx.note}</span>}
                <span> · {new Date(tx.created_at).toLocaleTimeString("vi-VN")}</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono font-semibold">{amountOf(tx).toLocaleString("vi-VN")}</span>
              {tx.status === "completed" && tx.type !== "reversal" && (
                <button
                  onClick={() => reverse(tx.id)}
                  className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-amber-900/40 hover:text-amber-300"
                  title="Hoàn tác giao dịch này"
                >
                  ↩ Hoàn tác
                </button>
              )}
            </div>
          </li>
        ))}
        {txs.length === 0 && <li className="text-sm text-slate-500">Chưa có giao dịch nào.</li>}
      </ul>
      {nextBefore && (
        <button
          onClick={() => load(nextBefore).catch((e) => setError((e as Error).message))}
          className="mt-3 w-full rounded-lg border border-slate-800 py-2 text-sm text-slate-400 hover:bg-slate-900"
        >
          Tải thêm
        </button>
      )}
    </section>
  );
}
