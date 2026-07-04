import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type SessionDetail } from "../api";
import TransactionForm from "../components/TransactionForm";
import TransactionHistory from "../components/TransactionHistory";

function formatAmount(n: number): string {
  return n.toLocaleString("vi-VN");
}

export default function SessionPage() {
  const { id } = useParams();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    setDetail(await api.get<SessionDetail>(`/api/v1/sessions/${id}`));
  }, [id]);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  async function addPlayer(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      setError(null);
      await api.post(`/api/v1/sessions/${id}/players`, { displayName: newName.trim() });
      setNewName("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removePlayer(playerId: number) {
    try {
      await api.delete(`/api/v1/sessions/${id}/players/${playerId}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!detail) {
    return <div className="p-6 text-slate-400">{error ?? "Đang tải…"}</div>;
  }

  const { session, bank, assets, players, balances } = detail;
  const primaryAsset = assets.find((a) => a.is_primary) ?? assets[0];
  const balanceOf = (playerId: number) =>
    balances.find((b) => b.owner_type === "player" && b.owner_id === playerId && b.asset_type_id === primaryAsset?.id)
      ?.balance_cached ?? 0;
  const circulating = balances
    .filter((b) => b.owner_type === "player" && b.asset_type_id === primaryAsset?.id)
    .reduce((sum, b) => sum + b.balance_cached, 0);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link to="/" className="text-sm text-slate-400 hover:text-slate-200">← {bank.name}</Link>
      <header className="mt-2 mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{session.name}</h1>
          <p className="mt-1 text-slate-400">
            Mã tham gia: <span className="font-mono text-lg text-emerald-400">{session.join_code}</span>
          </p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-right">
          <div className="text-sm text-slate-400">Đang lưu thông</div>
          <div className="text-xl font-bold text-emerald-400">
            {primaryAsset?.icon} {formatAmount(circulating)} {primaryAsset?.name}
          </div>
        </div>
      </header>

      <form onSubmit={addPlayer} className="mb-6 flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Tên người chơi mới…"
          className="flex-1 rounded-lg bg-slate-900 border border-slate-700 px-4 py-2.5 outline-none focus:border-emerald-500"
        />
        <button className="rounded-lg bg-emerald-600 px-5 py-2.5 font-semibold hover:bg-emerald-500">
          + Thêm
        </button>
      </form>
      {error && <p className="mb-4 text-red-400">{error}</p>}

      <ul className="space-y-2">
        {players.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900 px-4 py-3"
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">{p.avatar}</span>
              <span className="font-semibold">{p.display_name}</span>
            </div>
            <div className="flex items-center gap-4">
              <span className="font-mono text-lg">
                {formatAmount(balanceOf(p.id))} <span className="text-slate-400 text-sm">{primaryAsset?.name}</span>
              </span>
              <button
                onClick={() => removePlayer(p.id)}
                className="rounded-lg px-2 py-1 text-slate-500 hover:bg-red-900/40 hover:text-red-300"
                title="Xóa người chơi"
              >
                ✕
              </button>
            </div>
          </li>
        ))}
        {players.length === 0 && <li className="text-slate-500">Chưa có người chơi — thêm ở trên.</li>}
      </ul>

      {players.length >= 1 && (
        <div className="mt-8">
          <TransactionForm
            sessionId={id!}
            players={players}
            asset={primaryAsset}
            onDone={() => {
              load().catch(() => {});
              setRefreshKey((k) => k + 1);
            }}
          />
        </div>
      )}

      <TransactionHistory
        sessionId={id!}
        players={players}
        refreshKey={refreshKey}
        onChanged={() => {
          load().catch(() => {});
          setRefreshKey((k) => k + 1);
        }}
      />
    </div>
  );
}
