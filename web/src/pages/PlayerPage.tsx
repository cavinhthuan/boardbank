import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SessionDetail, type Tx } from "../api";
import { useAuth, type PlayerMe } from "../auth";

function fmt(n: number): string {
  return n.toLocaleString("vi-VN");
}

export default function PlayerPage() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const player = me as PlayerMe;

  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await api.get<SessionDetail>(`/api/v1/sessions/${player.sessionId}`);
    setDetail(d);
    const { data } = await api.getWithMeta<Tx[], unknown>(
      `/api/v1/sessions/${player.sessionId}/transactions?playerId=${player.id}&limit=15`,
    );
    setTxs(data);
  }, [player.sessionId, player.id]);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  if (!detail) return <div className="p-6 text-slate-400">{error ?? "Đang tải…"}</div>;

  const primaryAsset = detail.assets.find((a) => a.is_primary) ?? detail.assets[0];
  const myBalance =
    detail.balances.find(
      (b) => b.owner_type === "player" && b.owner_id === player.id && b.asset_type_id === primaryAsset?.id,
    )?.balance_cached ?? 0;
  const meRow = detail.players.find((p) => p.id === player.id);
  const others = detail.players.filter((p) => p.id !== player.id && p.status === "active");

  async function transfer(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFlash(null);
    try {
      await api.post(`/api/v1/sessions/${player.sessionId}/transactions`, {
        type: "transfer",
        fromPlayerId: player.id,
        toPlayerId: Number(toId),
        amount: Number(amount),
        ...(note.trim() ? { note: note.trim() } : {}),
        pin,
        idempotencyKey: crypto.randomUUID(),
      });
      setAmount("");
      setNote("");
      setPin("");
      setFlash("✅ Chuyển tiền thành công!");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const field =
    "w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 outline-none focus:border-emerald-500";

  return (
    <div className="mx-auto max-w-md p-5">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-3xl">{meRow?.avatar}</span>
          <div>
            <div className="font-bold">{player.displayName}</div>
            <div className="text-xs text-slate-500">{detail.session.name}</div>
          </div>
        </div>
        <button
          onClick={async () => {
            await logout();
            navigate("/join");
          }}
          className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800"
        >
          Thoát
        </button>
      </header>

      <div className="mt-5 rounded-2xl bg-gradient-to-br from-emerald-700 to-emerald-900 p-6 shadow-lg">
        <div className="text-sm text-emerald-200">Số dư của bạn</div>
        <div className="mt-1 text-4xl font-bold tracking-tight">
          {fmt(myBalance)} <span className="text-lg font-normal text-emerald-200">{primaryAsset?.name}</span>
        </div>
        {meRow?.status === "locked" && (
          <div className="mt-2 rounded bg-red-950/60 px-2 py-1 text-sm text-red-300">🔒 Tài khoản đang bị khóa</div>
        )}
      </div>

      <form onSubmit={transfer} className="mt-5 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h2 className="mb-3 font-semibold">Chuyển tiền</h2>
        <div className="space-y-3">
          <select value={toId} onChange={(e) => setToId(e.target.value)} className={field} required>
            <option value="">— chọn người nhận —</option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.avatar} {p.display_name}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={`Số tiền (${primaryAsset?.name})`}
            className={field}
            required
          />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú (tùy chọn)" maxLength={200} className={field} />
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            placeholder="PIN xác nhận"
            className={`${field} text-center font-mono tracking-[0.3em]`}
            minLength={4}
            maxLength={6}
            required
          />
        </div>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        {flash && <p className="mt-2 text-sm text-emerald-400">{flash}</p>}
        <button className="mt-3 w-full rounded-lg bg-emerald-600 py-2.5 font-semibold hover:bg-emerald-500">
          Chuyển
        </button>
      </form>

      <section className="mt-6">
        <h2 className="mb-2 font-semibold">Giao dịch gần đây</h2>
        <ul className="space-y-1.5">
          {txs.map((tx) => {
            const myEntry = tx.entries.find((e) => e.owner_type === "player" && e.owner_id === player.id);
            const other = tx.entries.find((e) => !(e.owner_type === "player" && e.owner_id === player.id));
            const delta = myEntry?.amount ?? 0;
            return (
              <li
                key={tx.id}
                className={`flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 ${
                  tx.status === "reversed" ? "opacity-50" : ""
                }`}
              >
                <div>
                  <div className="text-sm">
                    {delta >= 0 ? `Nhận từ ${other?.owner_name}` : `Chuyển cho ${other?.owner_name}`}
                    {tx.status === "reversed" && <span className="ml-1 text-xs text-amber-400">(đã hoàn tác)</span>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {tx.note ? `${tx.note} · ` : ""}
                    {new Date(tx.created_at).toLocaleTimeString("vi-VN")}
                  </div>
                </div>
                <span className={`font-mono font-semibold ${delta >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {delta >= 0 ? "+" : ""}
                  {fmt(delta)}
                </span>
              </li>
            );
          })}
          {txs.length === 0 && <li className="text-sm text-slate-500">Chưa có giao dịch nào.</li>}
        </ul>
      </section>
    </div>
  );
}
