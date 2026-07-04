import { useState, type FormEvent } from "react";
import { api, type AssetType, type ExchangeRate } from "../api";
import { parseRate, rateToString } from "../money";

interface Props {
  sessionId: string;
  assets: AssetType[];
  rates: ExchangeRate[];
  onChanged: () => void;
}

export default function AssetsPanel({ sessionId, assets, rates, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [icon, setIcon] = useState("🪙");
  const [rateFrom, setRateFrom] = useState("");
  const [rateTo, setRateTo] = useState("");
  const [rateValue, setRateValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const active = assets.filter((a) => a.status === "active");
  const assetName = (id: number) => {
    const a = assets.find((x) => x.id === id);
    return a ? `${a.icon ?? ""} ${a.name}` : `#${id}`;
  };

  const field =
    "rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm outline-none focus:border-emerald-500";

  async function addAsset(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/api/v1/sessions/${sessionId}/assets`, { code: code.trim(), name: name.trim(), icon });
      setName("");
      setCode("");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeAsset(assetId: number) {
    setError(null);
    try {
      await api.delete(`/api/v1/sessions/${sessionId}/assets/${assetId}`);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function setRate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = parseRate(rateValue);
    if (!parsed) {
      setError("Tỷ giá không hợp lệ (số dương, tối đa 6 số lẻ)");
      return;
    }
    try {
      await api.put(`/api/v1/sessions/${sessionId}/rates`, {
        fromAssetId: Number(rateFrom),
        toAssetId: Number(rateTo),
        rateNum: parsed.num,
        rateDen: parsed.den,
      });
      setRateValue("");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="mt-8">
      <button onClick={() => setOpen(!open)} className="font-semibold text-slate-300 hover:text-slate-100">
        {open ? "▾" : "▸"} Tài sản & tỷ giá ({active.length})
      </button>
      {open && (
        <div className="mt-2 space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-4">
          <ul className="flex flex-wrap gap-2">
            {active.map((a) => (
              <li key={a.id} className="flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-1.5 text-sm">
                <span>
                  {a.icon} {a.name} <span className="text-slate-500">({a.code})</span>
                </span>
                {a.is_primary === 1 ? (
                  <span className="text-xs text-emerald-400">chính</span>
                ) : (
                  <button onClick={() => removeAsset(a.id)} className="text-slate-500 hover:text-red-300" title="Xóa/ẩn tài sản">
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>

          <form onSubmit={addAsset} className="flex flex-wrap items-end gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên (VD: Vàng)" className={`${field} w-32`} required />
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Mã (GOLD)" className={`${field} w-24 font-mono`} maxLength={10} required />
            <input value={icon} onChange={(e) => setIcon(e.target.value)} className={`${field} w-16 text-center`} maxLength={4} />
            <button className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold hover:bg-slate-600">+ Tài sản</button>
          </form>

          {active.length >= 2 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-400">Tỷ giá quy đổi</h3>
              <ul className="mb-2 space-y-1 text-sm">
                {rates.map((r) => (
                  <li key={r.id} className="text-slate-300">
                    1 {assetName(r.from_asset_id)} = <span className="font-mono text-emerald-400">{rateToString(r.rate_num, r.rate_den)}</span>{" "}
                    {assetName(r.to_asset_id)}
                  </li>
                ))}
                {rates.length === 0 && <li className="text-slate-500">Chưa có tỷ giá nào.</li>}
              </ul>
              <form onSubmit={setRate} className="flex flex-wrap items-center gap-2 text-sm">
                <span>1</span>
                <select value={rateFrom} onChange={(e) => setRateFrom(e.target.value)} className={field} required>
                  <option value="">— tài sản —</option>
                  {active.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.icon} {a.name}
                    </option>
                  ))}
                </select>
                <span>=</span>
                <input value={rateValue} onChange={(e) => setRateValue(e.target.value)} placeholder="10" className={`${field} w-24`} required />
                <select value={rateTo} onChange={(e) => setRateTo(e.target.value)} className={field} required>
                  <option value="">— tài sản —</option>
                  {active
                    .filter((a) => String(a.id) !== rateFrom)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.icon} {a.name}
                      </option>
                    ))}
                </select>
                <button className="rounded-lg bg-slate-700 px-4 py-2 font-semibold hover:bg-slate-600">Lưu tỷ giá</button>
              </form>
            </div>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      )}
    </section>
  );
}
