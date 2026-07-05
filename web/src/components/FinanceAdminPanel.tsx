import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Player } from "../api";

interface AdminLoan {
  id: number;
  player_id: number;
  display_name: string;
  principal: number;
  outstanding: number;
  status: string;
}

interface AdminSavings {
  id: number;
  player_id: number;
  display_name: string;
  balance: number;
}

interface Props {
  sessionId: string;
  players: Player[];
  refreshKey: number;
  onChanged: () => void;
}

const field =
  "rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm outline-none focus:border-emerald-500";

export default function FinanceAdminPanel({ sessionId, players, refreshKey, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [loans, setLoans] = useState<AdminLoan[]>([]);
  const [savings, setSavings] = useState<AdminSavings[]>([]);
  const [batchType, setBatchType] = useState("issue");
  const [batchIds, setBatchIds] = useState<Set<number>>(new Set());
  const [batchAmount, setBatchAmount] = useState("");
  const [batchNote, setBatchNote] = useState("");
  const [loanPlayer, setLoanPlayer] = useState("");
  const [loanAmount, setLoanAmount] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = players.filter((p) => p.status !== "removed");

  const load = useCallback(async () => {
    const [l, s] = await Promise.all([
      api.get<AdminLoan[]>(`/api/v1/sessions/${sessionId}/loans`),
      api.get<AdminSavings[]>(`/api/v1/sessions/${sessionId}/savings`),
    ]);
    setLoans(l.filter((x) => x.status === "open"));
    setSavings(s.filter((x) => x.balance > 0));
  }, [sessionId]);

  useEffect(() => {
    if (open) load().catch(() => {});
  }, [open, load, refreshKey]);

  async function act(fn: () => Promise<unknown>, success: string) {
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(success);
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function submitBatch(e: FormEvent) {
    e.preventDefault();
    const ids = batchIds.size > 0 ? [...batchIds] : active.map((p) => p.id);
    void act(
      () =>
        api.post(`/api/v1/sessions/${sessionId}/transactions/batch`, {
          type: batchType,
          playerIds: ids,
          amount: Number(batchAmount),
          ...(batchNote.trim() ? { note: batchNote.trim() } : {}),
          idempotencyKey: crypto.randomUUID(),
        }),
      `✅ Đã ${batchType === "issue" || batchType === "reward" ? "phát" : "thu"} ${Number(batchAmount).toLocaleString("vi-VN")} × ${ids.length} người trong 1 giao dịch`,
    );
  }

  const fmt = (n: number) => n.toLocaleString("vi-VN");

  return (
    <section className="mt-8">
      <button onClick={() => setOpen(!open)} className="font-semibold text-slate-300 hover:text-slate-100">
        {open ? "▾" : "▸"} Nghiệp vụ ngân hàng
      </button>
      {open && (
        <div className="mt-2 space-y-5 rounded-xl border border-slate-800 bg-slate-900 p-4">
          <form onSubmit={submitBatch}>
            <h3 className="mb-2 text-sm font-semibold text-slate-400">Giao dịch hàng loạt (1 lệnh cho cả bàn)</h3>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {active.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  onClick={() =>
                    setBatchIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.id)) next.delete(p.id);
                      else next.add(p.id);
                      return next;
                    })
                  }
                  className={`rounded-full border px-3 py-1 text-sm ${
                    batchIds.has(p.id) ? "border-emerald-500 bg-emerald-950/40" : "border-slate-700 bg-slate-950 hover:border-slate-500"
                  }`}
                >
                  {p.avatar} {p.display_name}
                </button>
              ))}
              <span className="self-center text-xs text-slate-500">
                {batchIds.size === 0 ? "(không chọn = tất cả)" : `${batchIds.size} người`}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <select value={batchType} onChange={(e) => setBatchType(e.target.value)} className={field}>
                <option value="issue">Phát tiền</option>
                <option value="reward">Thưởng</option>
                <option value="recall">Thu hồi</option>
                <option value="penalty">Phạt</option>
              </select>
              <input type="number" min={1} value={batchAmount} onChange={(e) => setBatchAmount(e.target.value)} placeholder="Số tiền/người" className={`${field} w-32`} required />
              <input value={batchNote} onChange={(e) => setBatchNote(e.target.value)} placeholder="Ghi chú (VD: Lương vòng 3)" maxLength={200} className={`${field} flex-1 min-w-40`} />
              <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500">Thực hiện</button>
            </div>
          </form>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-400">Khoản vay & lãi</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  () => api.post(`/api/v1/sessions/${sessionId}/loans`, { playerId: Number(loanPlayer), amount: Number(loanAmount) }),
                  "✅ Đã giải ngân khoản vay",
                ).then(() => {
                  setLoanPlayer("");
                  setLoanAmount("");
                });
              }}
              className="flex flex-wrap gap-2"
            >
              <select value={loanPlayer} onChange={(e) => setLoanPlayer(e.target.value)} className={field} required>
                <option value="">Cho ai vay…</option>
                {active
                  .filter((p) => p.status === "active")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.avatar} {p.display_name}
                    </option>
                  ))}
              </select>
              <input type="number" min={1} value={loanAmount} onChange={(e) => setLoanAmount(e.target.value)} placeholder="Số tiền" className={`${field} w-32`} required />
              <button className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold hover:bg-slate-600">💳 Giải ngân</button>
              <button
                type="button"
                onClick={() =>
                  void act(
                    async () => {
                      const r = await api.post<{ loansAccrued: number; savingsAccrued: number }>(
                        `/api/v1/sessions/${sessionId}/accrue-interest`,
                        {},
                      );
                      setMsg(`✅ Đã tính lãi: ${r.loansAccrued} khoản vay, ${r.savingsAccrued} sổ tiết kiệm`);
                    },
                    "✅ Đã tính lãi kỳ này",
                  )
                }
                className="rounded-lg border border-amber-700 px-4 py-2 text-sm font-semibold text-amber-300 hover:bg-amber-950/40"
                title="Áp lãi suất trong Cấu hình phiên lên mọi khoản vay và sổ tiết kiệm"
              >
                📈 Tính lãi kỳ này
              </button>
            </form>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-xs text-slate-500">Đang vay</div>
                <ul className="space-y-1 text-sm">
                  {loans.map((l) => (
                    <li key={l.id} className="flex justify-between rounded bg-slate-800/60 px-2 py-1">
                      <span>{l.display_name}</span>
                      <span className="font-mono text-amber-300">{fmt(l.outstanding)}</span>
                    </li>
                  ))}
                  {loans.length === 0 && <li className="text-slate-600">Không có</li>}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-xs text-slate-500">Sổ tiết kiệm</div>
                <ul className="space-y-1 text-sm">
                  {savings.map((s) => (
                    <li key={s.id} className="flex justify-between rounded bg-slate-800/60 px-2 py-1">
                      <span>{s.display_name}</span>
                      <span className="font-mono text-emerald-300">{fmt(s.balance)}</span>
                    </li>
                  ))}
                  {savings.length === 0 && <li className="text-slate-600">Không có</li>}
                </ul>
              </div>
            </div>
          </div>

          {msg && <p className="text-sm text-emerald-400">{msg}</p>}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      )}
    </section>
  );
}
