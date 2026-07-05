import { useEffect, useState } from "react";
import { api, type AssetType, type SessionStats } from "../api";
import { formatMinor } from "../money";

const MEDALS = ["🥇", "🥈", "🥉"];

interface Props {
  sessionId: number | string;
  primaryAsset: AssetType | undefined;
  title?: string;
  refreshKey?: number;
}

export default function SessionResults({ sessionId, primaryAsset, title = "Kết quả chung cuộc", refreshKey = 0 }: Props) {
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<SessionStats>(`/api/v1/sessions/${sessionId}/stats`)
      .then(setStats)
      .catch((e) => setError((e as Error).message));
  }, [sessionId, refreshKey]);

  if (error) return <p className="text-red-400">{error}</p>;
  if (!stats) return <p className="text-slate-500">Đang tải kết quả…</p>;

  const decimals = primaryAsset?.decimals ?? 0;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="mb-4 text-xl font-bold">🏁 {title}</h2>
      <ol className="space-y-2">
        {stats.players.map((p, i) => (
          <li
            key={p.id}
            className={`flex items-center justify-between rounded-lg px-4 py-3 ${
              i === 0 ? "bg-amber-950/40 border border-amber-700/40" : "bg-slate-800/60"
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="w-8 text-center text-xl">{MEDALS[i] ?? `${i + 1}.`}</span>
              <span className="text-2xl">{p.avatar}</span>
              <div>
                <div className="font-semibold">{p.display_name}</div>
                <div className="text-xs text-slate-400">
                  Thu {formatMinor(p.total_in, decimals)} · Chi {formatMinor(p.total_out, decimals)} · {p.tx_count} giao dịch
                </div>
              </div>
            </div>
            <span className="font-mono text-lg font-bold">
              {formatMinor(p.balance, decimals)} <span className="text-sm font-normal text-slate-400">{primaryAsset?.name}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-sm text-slate-500">
        Tổng {stats.totalTx} giao dịch ·{" "}
        {formatMinor(stats.circulating.find((c) => c.asset_type_id === stats.primaryAssetId)?.total ?? 0, decimals)}{" "}
        {primaryAsset?.name} đang lưu thông
      </p>
    </section>
  );
}
