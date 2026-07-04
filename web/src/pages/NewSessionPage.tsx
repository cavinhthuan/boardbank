import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type GameSession } from "../api";

export default function NewSessionPage() {
  const { bankId } = useParams();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [currencyName, setCurrencyName] = useState("Tiền");
  const [currencyIcon, setCurrencyIcon] = useState("💰");
  const [initialBalance, setInitialBalance] = useState(1500);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const session = await api.post<GameSession>(`/api/v1/banks/${bankId}/sessions`, {
        name: name.trim(),
        currencyName: currencyName.trim(),
        currencyIcon,
        initialBalance,
      });
      navigate(`/sessions/${session.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const field =
    "w-full rounded-lg bg-slate-900 border border-slate-700 px-4 py-2.5 outline-none focus:border-emerald-500";

  return (
    <div className="mx-auto max-w-md p-6">
      <Link to="/" className="text-sm text-slate-400 hover:text-slate-200">← Ngân hàng</Link>
      <h1 className="mt-2 mb-6 text-2xl font-bold">Tạo phiên chơi mới</h1>
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm text-slate-400">Tên phiên</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Cờ tỷ phú tối thứ 7" className={field} required />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm text-slate-400">Tên đơn vị tiền</span>
            <input value={currencyName} onChange={(e) => setCurrencyName(e.target.value)} className={field} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-slate-400">Biểu tượng</span>
            <input value={currencyIcon} onChange={(e) => setCurrencyIcon(e.target.value)} className={field} maxLength={4} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-sm text-slate-400">Số dư ban đầu mỗi người chơi</span>
          <input
            type="number"
            min={0}
            value={initialBalance}
            onChange={(e) => setInitialBalance(Number(e.target.value))}
            className={field}
          />
        </label>
        {error && <p className="text-red-400">{error}</p>}
        <button className="w-full rounded-lg bg-emerald-600 py-3 font-semibold hover:bg-emerald-500">
          Tạo phiên
        </button>
      </form>
    </div>
  );
}
