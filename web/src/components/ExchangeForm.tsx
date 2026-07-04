import { useState, type FormEvent } from "react";
import { api, type AssetType, type ExchangeRate } from "../api";
import { convertPreview, formatMinor } from "../money";

interface Props {
  sessionId: number;
  playerId: number;
  assets: AssetType[];
  rates: ExchangeRate[];
  onDone: () => void;
}

/** Tìm tỷ giá hiệu lực: chiều thuận hoặc nghịch đảo — giống logic server. */
function effectiveRate(rates: ExchangeRate[], fromId: number, toId: number): { num: number; den: number } | null {
  const direct = rates.find((r) => r.from_asset_id === fromId && r.to_asset_id === toId);
  if (direct) return { num: direct.rate_num, den: direct.rate_den };
  const reverse = rates.find((r) => r.from_asset_id === toId && r.to_asset_id === fromId);
  if (reverse) return { num: reverse.rate_den, den: reverse.rate_num };
  return null;
}

export default function ExchangeForm({ sessionId, playerId, assets, rates, onDone }: Props) {
  const active = assets.filter((a) => a.status === "active");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (active.length < 2 || rates.length === 0) return null;

  const from = active.find((a) => String(a.id) === fromId);
  const to = active.find((a) => String(a.id) === toId);
  const rate = from && to ? effectiveRate(rates, from.id, to.id) : null;
  const amountNum = Number(amount);
  const preview =
    rate && Number.isInteger(amountNum) && amountNum > 0 ? convertPreview(amountNum, rate.num, rate.den) : null;

  const field =
    "w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 outline-none focus:border-emerald-500";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/api/v1/sessions/${sessionId}/exchange`, {
        playerId,
        fromAssetId: Number(fromId),
        toAssetId: Number(toId),
        amount: amountNum,
        pin,
        idempotencyKey: crypto.randomUUID(),
      });
      setAmount("");
      setPin("");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form onSubmit={submit} className="mt-5 rounded-xl border border-slate-800 bg-slate-900 p-4">
      <h2 className="mb-3 font-semibold">Quy đổi tài sản</h2>
      <div className="grid grid-cols-2 gap-3">
        <select value={fromId} onChange={(e) => setFromId(e.target.value)} className={field} required>
          <option value="">Từ…</option>
          {active.map((a) => (
            <option key={a.id} value={a.id}>
              {a.icon} {a.name}
            </option>
          ))}
        </select>
        <select value={toId} onChange={(e) => setToId(e.target.value)} className={field} required>
          <option value="">Sang…</option>
          {active
            .filter((a) => String(a.id) !== fromId)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.icon} {a.name}
              </option>
            ))}
        </select>
        <input
          type="number"
          min={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Số lượng"
          className={field}
          required
        />
        <input
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          placeholder="PIN"
          className={`${field} text-center font-mono tracking-[0.3em]`}
          minLength={4}
          maxLength={6}
          required
        />
      </div>
      {from && to && !rate && <p className="mt-2 text-sm text-amber-400">Chưa có tỷ giá cho cặp này.</p>}
      {preview !== null && to && (
        <p className="mt-2 text-sm text-slate-300">
          Nhận được: <span className="font-mono font-semibold text-emerald-400">{formatMinor(preview, to.decimals)}</span> {to.name}
        </p>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <button
        disabled={!rate}
        className="mt-3 w-full rounded-lg bg-emerald-600 py-2.5 font-semibold hover:bg-emerald-500 disabled:opacity-50"
      >
        Quy đổi
      </button>
    </form>
  );
}
