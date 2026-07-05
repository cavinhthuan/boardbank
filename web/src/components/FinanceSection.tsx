import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type Player } from "../api";

interface Loan {
  id: number;
  principal: number;
  outstanding: number;
  status: "open" | "closed";
}

interface Savings {
  id: number;
  balance: number;
}

interface Invoice {
  id: number;
  from_player_id: number;
  to_player_id: number;
  amount: number;
  note: string | null;
  status: "pending" | "paid" | "canceled";
  from_name: string;
  to_name: string;
}

interface Props {
  sessionId: number;
  playerId: number;
  players: Player[]; // người chơi khác (active)
  assetName: string | undefined;
  refreshKey: number;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}

const field =
  "w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm outline-none focus:border-emerald-500";
const pinField = `${field} text-center font-mono tracking-[0.3em]`;
const btn = "rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-50";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-xl border border-slate-800 bg-slate-900">
      <summary className="cursor-pointer px-4 py-3 font-semibold hover:text-emerald-300">{title}</summary>
      <div className="border-t border-slate-800 p-4">{children}</div>
    </details>
  );
}

export default function FinanceSection({ sessionId, playerId, players, assetName, refreshKey, onDone, onError }: Props) {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [savings, setSavings] = useState<Savings | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);

  const [savAmount, setSavAmount] = useState("");
  const [savPin, setSavPin] = useState("");
  const [repayAmount, setRepayAmount] = useState("");
  const [repayPin, setRepayPin] = useState("");
  const [invTo, setInvTo] = useState("");
  const [invAmount, setInvAmount] = useState("");
  const [invNote, setInvNote] = useState("");
  const [payPin, setPayPin] = useState("");
  const [splitIds, setSplitIds] = useState<Set<number>>(new Set());
  const [splitEach, setSplitEach] = useState("");
  const [splitNote, setSplitNote] = useState("");
  const [splitPin, setSplitPin] = useState("");

  const load = useCallback(async () => {
    const [l, s, i] = await Promise.all([
      api.get<Loan[]>(`/api/v1/sessions/${sessionId}/loans`),
      api.get<Savings[]>(`/api/v1/sessions/${sessionId}/savings`),
      api.get<Invoice[]>(`/api/v1/sessions/${sessionId}/invoices`),
    ]);
    setLoans(l.filter((x) => x.status === "open"));
    setSavings(s[0] ?? null);
    setInvoices(i);
  }, [sessionId]);

  useEffect(() => {
    load().catch(() => {});
  }, [load, refreshKey]);

  async function act(fn: () => Promise<unknown>, msg: string): Promise<void> {
    try {
      await fn();
      onDone(msg);
      await load();
    } catch (err) {
      onError((err as Error).message);
    }
  }

  const fmt = (n: number) => n.toLocaleString("vi-VN");
  const totalDebt = loans.reduce((s, l) => s + l.outstanding, 0);
  const pendingToPay = invoices.filter((i) => i.status === "pending" && i.to_player_id === playerId);
  const pendingSent = invoices.filter((i) => i.status === "pending" && i.from_player_id === playerId);

  function savingsMove(kind: "deposit" | "withdraw") {
    const amount = Number(savAmount);
    if (!Number.isInteger(amount) || amount <= 0) return onError("Số tiền không hợp lệ");
    void act(
      () => api.post(`/api/v1/sessions/${sessionId}/savings/${kind}`, { playerId, amount, pin: savPin }),
      kind === "deposit" ? "✅ Đã gửi tiết kiệm" : "✅ Đã rút tiết kiệm",
    ).then(() => {
      setSavAmount("");
      setSavPin("");
    });
  }

  function submitSplit(e: FormEvent) {
    e.preventDefault();
    const each = Number(splitEach);
    if (splitIds.size === 0 || !Number.isInteger(each) || each <= 0) return onError("Chọn người nhận và số tiền hợp lệ");
    void act(
      () =>
        api.post(`/api/v1/sessions/${sessionId}/transactions/split`, {
          fromPlayerId: playerId,
          toPlayerIds: [...splitIds],
          amountEach: each,
          pin: splitPin,
          ...(splitNote.trim() ? { note: splitNote.trim() } : {}),
          idempotencyKey: crypto.randomUUID(),
        }),
      "✅ Đã chia tiền",
    ).then(() => {
      setSplitIds(new Set());
      setSplitEach("");
      setSplitNote("");
      setSplitPin("");
    });
  }

  return (
    <div className="mt-6 space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ngân hàng</div>

      <Section title={`🏦 Tiết kiệm — ${fmt(savings?.balance ?? 0)} ${assetName ?? ""}`}>
        <div className="grid grid-cols-2 gap-2">
          <input type="number" min={1} value={savAmount} onChange={(e) => setSavAmount(e.target.value)} placeholder="Số tiền" className={field} />
          <input type="password" inputMode="numeric" value={savPin} onChange={(e) => setSavPin(e.target.value.replace(/\D/g, ""))} placeholder="PIN" maxLength={6} className={pinField} />
        </div>
        <div className="mt-2 flex gap-2">
          <button onClick={() => savingsMove("deposit")} className={btn}>Gửi vào</button>
          <button onClick={() => savingsMove("withdraw")} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold hover:bg-slate-800">
            Rút ra
          </button>
        </div>
      </Section>

      <Section title={`💳 Khoản vay — dư nợ ${fmt(totalDebt)} ${assetName ?? ""}`}>
        {loans.length === 0 && <p className="text-sm text-slate-500">Bạn không có khoản vay nào. Hỏi quản trị viên để vay.</p>}
        {loans.map((loan) => (
          <div key={loan.id} className="mb-3 rounded-lg bg-slate-800/60 p-3">
            <div className="text-sm">
              Khoản vay #{loan.id}: gốc {fmt(loan.principal)} — còn nợ{" "}
              <span className="font-mono font-semibold text-amber-300">{fmt(loan.outstanding)}</span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <input type="number" min={1} value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)} placeholder="Trả bớt…" className={field} />
              <input type="password" inputMode="numeric" value={repayPin} onChange={(e) => setRepayPin(e.target.value.replace(/\D/g, ""))} placeholder="PIN" maxLength={6} className={pinField} />
              <button
                onClick={() =>
                  void act(
                    () => api.post(`/api/v1/sessions/${sessionId}/loans/${loan.id}/repay`, { amount: Number(repayAmount), pin: repayPin }),
                    "✅ Đã trả nợ",
                  ).then(() => {
                    setRepayAmount("");
                    setRepayPin("");
                  })
                }
                className={btn}
              >
                Trả nợ
              </button>
            </div>
          </div>
        ))}
      </Section>

      <Section title={`🧾 Hóa đơn${pendingToPay.length > 0 ? ` — ${pendingToPay.length} chờ bạn trả` : ""}`}>
        {pendingToPay.map((inv) => (
          <div key={inv.id} className="mb-2 rounded-lg border border-amber-800/60 bg-amber-950/30 p-3 text-sm">
            <div>
              <b>{inv.from_name}</b> đòi bạn <span className="font-mono font-semibold">{fmt(inv.amount)}</span> {assetName}
              {inv.note && <span className="text-slate-400"> — {inv.note}</span>}
            </div>
            <div className="mt-2 flex gap-2">
              <input type="password" inputMode="numeric" value={payPin} onChange={(e) => setPayPin(e.target.value.replace(/\D/g, ""))} placeholder="PIN" maxLength={6} className={`${pinField} w-28`} />
              <button
                onClick={() =>
                  void act(() => api.post(`/api/v1/sessions/${sessionId}/invoices/${inv.id}/pay`, { pin: payPin }), "✅ Đã thanh toán hóa đơn").then(() => setPayPin(""))
                }
                className={btn}
              >
                Thanh toán
              </button>
              <button
                onClick={() => void act(() => api.post(`/api/v1/sessions/${sessionId}/invoices/${inv.id}/cancel`, {}), "Đã từ chối hóa đơn")}
                className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800"
              >
                Từ chối
              </button>
            </div>
          </div>
        ))}
        {pendingSent.map((inv) => (
          <div key={inv.id} className="mb-2 flex items-center justify-between rounded-lg bg-slate-800/60 p-3 text-sm">
            <span>
              Đang đòi <b>{inv.to_name}</b> {fmt(inv.amount)} {assetName}
              {inv.note && <span className="text-slate-400"> — {inv.note}</span>}
            </span>
            <button
              onClick={() => void act(() => api.post(`/api/v1/sessions/${sessionId}/invoices/${inv.id}/cancel`, {}), "Đã hủy hóa đơn")}
              className="text-slate-500 hover:text-red-300"
            >
              ✕ Hủy
            </button>
          </div>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              () =>
                api.post(`/api/v1/sessions/${sessionId}/invoices`, {
                  toPlayerId: Number(invTo),
                  amount: Number(invAmount),
                  ...(invNote.trim() ? { note: invNote.trim() } : {}),
                }),
              "🧾 Đã gửi hóa đơn",
            ).then(() => {
              setInvTo("");
              setInvAmount("");
              setInvNote("");
            });
          }}
          className="mt-2 grid grid-cols-2 gap-2"
        >
          <select value={invTo} onChange={(e) => setInvTo(e.target.value)} className={field} required>
            <option value="">Đòi tiền ai…</option>
            {players.map((p) => (
              <option key={p.id} value={p.id}>
                {p.avatar} {p.display_name}
              </option>
            ))}
          </select>
          <input type="number" min={1} value={invAmount} onChange={(e) => setInvAmount(e.target.value)} placeholder="Số tiền" className={field} required />
          <input value={invNote} onChange={(e) => setInvNote(e.target.value)} placeholder="Lý do (tùy chọn)" maxLength={200} className={`${field} col-span-2`} />
          <button className={`${btn} col-span-2`}>Gửi hóa đơn</button>
        </form>
      </Section>

      <Section title="➗ Chia tiền nhóm">
        <form onSubmit={submitSplit}>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {players.map((p) => (
              <button
                type="button"
                key={p.id}
                onClick={() =>
                  setSplitIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(p.id)) next.delete(p.id);
                    else next.add(p.id);
                    return next;
                  })
                }
                className={`rounded-full border px-3 py-1.5 text-sm ${
                  splitIds.has(p.id) ? "border-emerald-500 bg-emerald-950/40" : "border-slate-700 bg-slate-950 hover:border-slate-500"
                }`}
              >
                {p.avatar} {p.display_name}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input type="number" min={1} value={splitEach} onChange={(e) => setSplitEach(e.target.value)} placeholder="Mỗi người nhận…" className={field} required />
            <input type="password" inputMode="numeric" value={splitPin} onChange={(e) => setSplitPin(e.target.value.replace(/\D/g, ""))} placeholder="PIN" maxLength={6} className={pinField} required />
            <input value={splitNote} onChange={(e) => setSplitNote(e.target.value)} placeholder="Ghi chú (tùy chọn)" maxLength={200} className={`${field} col-span-2`} />
          </div>
          {splitIds.size > 0 && splitEach && (
            <p className="mt-2 text-sm text-slate-400">
              Tổng chi: <span className="font-mono font-semibold">{fmt(Number(splitEach) * splitIds.size)}</span> {assetName} cho {splitIds.size} người
            </p>
          )}
          <button className={`${btn} mt-2 w-full`}>Chia tiền</button>
        </form>
      </Section>
    </div>
  );
}
