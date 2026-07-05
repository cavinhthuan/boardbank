import { useState, type FormEvent } from "react";
import { api, type SessionConfig } from "../api";

interface Props {
  sessionId: string;
  config: SessionConfig;
  onChanged: () => void;
}

export default function ConfigPanel({ sessionId, config, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(config.transferLimit ? String(config.transferLimit) : "");
  const [loanRate, setLoanRate] = useState(String((config as { loanRate?: number }).loanRate ?? 0));
  const [savingsRate, setSavingsRate] = useState(String((config as { savingsRate?: number }).savingsRate ?? 0));
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>) {
    setError(null);
    try {
      await api.patch(`/api/v1/sessions/${sessionId}/config`, body);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function saveLimit(e: FormEvent) {
    e.preventDefault();
    const v = limit.trim();
    await patch({ transferLimit: v === "" ? null : Number(v) });
  }

  const disabled = new Set(config.disabledTxTypes ?? []);

  function toggleType(type: "transfer" | "exchange") {
    const next = new Set(disabled);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    void patch({ disabledTxTypes: [...next] });
  }

  return (
    <section className="mt-8">
      <button onClick={() => setOpen(!open)} className="font-semibold text-slate-300 hover:text-slate-100">
        {open ? "▾" : "▸"} Cấu hình phiên
      </button>
      {open && (
        <div className="mt-2 space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.allowNegative ?? false}
              onChange={(e) => void patch({ allowNegative: e.target.checked })}
              className="h-4 w-4 accent-emerald-500"
            />
            Cho phép người chơi chuyển âm số dư
          </label>

          <form onSubmit={saveLimit} className="flex items-center gap-2">
            <span>Giới hạn mỗi lần người chơi chuyển:</span>
            <input
              type="number"
              min={1}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="không giới hạn"
              className="w-36 rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 outline-none focus:border-emerald-500"
            />
            <button className="rounded-lg bg-slate-700 px-3 py-1.5 font-semibold hover:bg-slate-600">Lưu</button>
          </form>

          <div className="flex items-center gap-4">
            <span>Cho phép người chơi:</span>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={!disabled.has("transfer")}
                onChange={() => toggleType("transfer")}
                className="h-4 w-4 accent-emerald-500"
              />
              Chuyển khoản
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={!disabled.has("exchange")}
                onChange={() => toggleType("exchange")}
                className="h-4 w-4 accent-emerald-500"
              />
              Quy đổi
            </label>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void patch({ loanRate: Number(loanRate) || 0, savingsRate: Number(savingsRate) || 0 });
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <span>Lãi suất mỗi kỳ (%):</span>
            <label className="flex items-center gap-1">
              vay
              <input
                type="number"
                min={0}
                max={1000}
                value={loanRate}
                onChange={(e) => setLoanRate(e.target.value)}
                className="w-20 rounded-lg bg-slate-950 border border-slate-700 px-2 py-1.5 outline-none focus:border-emerald-500"
              />
            </label>
            <label className="flex items-center gap-1">
              tiết kiệm
              <input
                type="number"
                min={0}
                max={1000}
                value={savingsRate}
                onChange={(e) => setSavingsRate(e.target.value)}
                className="w-20 rounded-lg bg-slate-950 border border-slate-700 px-2 py-1.5 outline-none focus:border-emerald-500"
              />
            </label>
            <button className="rounded-lg bg-slate-700 px-3 py-1.5 font-semibold hover:bg-slate-600">Lưu lãi suất</button>
            <span className="text-xs text-slate-500">(áp khi bấm "Tính lãi kỳ này")</span>
          </form>
          {error && <p className="text-red-400">{error}</p>}
        </div>
      )}
    </section>
  );
}
