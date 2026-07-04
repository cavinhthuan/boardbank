import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, type Bank, type GameSession } from "../api";

export default function BanksPage() {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [sessionsByBank, setSessionsByBank] = useState<Record<number, GameSession[]>>({});
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const list = await api.get<Bank[]>("/api/v1/banks");
    setBanks(list);
    const entries = await Promise.all(
      list.map(async (b) => [b.id, await api.get<GameSession[]>(`/api/v1/banks/${b.id}/sessions`)] as const),
    );
    setSessionsByBank(Object.fromEntries(entries));
  }

  useEffect(() => {
    load().catch((e) => setError(String(e.message ?? e)));
  }, []);

  async function createBank(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api.post("/api/v1/banks", { name: name.trim() });
      setName("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">🏦 BoardBank</h1>
        <p className="mt-1 text-slate-400">Chọn ngân hàng hoặc tạo mới để bắt đầu</p>
      </header>

      <form onSubmit={createBank} className="mb-8 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tên ngân hàng mới…"
          className="flex-1 rounded-lg bg-slate-900 border border-slate-700 px-4 py-2.5 outline-none focus:border-emerald-500"
        />
        <button className="rounded-lg bg-emerald-600 px-5 py-2.5 font-semibold hover:bg-emerald-500">
          Tạo ngân hàng
        </button>
      </form>

      {error && <p className="mb-4 text-red-400">{error}</p>}

      <div className="space-y-4">
        {banks.map((bank) => (
          <div key={bank.id} className="rounded-xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">{bank.name}</h2>
              <Link
                to={`/banks/${bank.id}/new-session`}
                className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700"
              >
                + Phiên mới
              </Link>
            </div>
            <ul className="mt-3 space-y-1.5">
              {(sessionsByBank[bank.id] ?? []).map((s) => (
                <li key={s.id}>
                  <Link
                    to={`/sessions/${s.id}`}
                    className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-slate-800"
                  >
                    <span>{s.name}</span>
                    <span className="text-sm text-slate-400">
                      {s.player_count} người chơi · mã <span className="font-mono text-emerald-400">{s.join_code}</span>
                    </span>
                  </Link>
                </li>
              ))}
              {(sessionsByBank[bank.id] ?? []).length === 0 && (
                <li className="px-3 py-2 text-sm text-slate-500">Chưa có phiên chơi nào</li>
              )}
            </ul>
          </div>
        ))}
        {banks.length === 0 && !error && (
          <p className="text-slate-500">Chưa có ngân hàng nào — tạo cái đầu tiên ở trên nhé.</p>
        )}
      </div>
    </div>
  );
}
