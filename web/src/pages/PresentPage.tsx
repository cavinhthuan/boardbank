import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { formatMinor } from "../money";
import { playChime } from "../sound";
import { speak } from "../speech";
import { loadSettings, saveSettings, type AppSettings } from "../settings";

const MEDALS = ["🥇", "🥈", "🥉"];

interface PresentEntry {
  amount: number;
  owner_name: string;
}

interface PresentTx {
  id: number;
  code: string;
  type: string;
  note: string | null;
  created_at: string;
  entries: PresentEntry[];
}

interface PresentData {
  session: { id: number; name: string; status: string; join_code: string };
  asset: { name: string; icon: string | null; decimals: number } | null;
  circulating: number;
  players: { id: number; display_name: string; avatar: string | null; status: string; balance: number }[];
  recent: PresentTx[];
}

function describeTx(tx: PresentTx, assetName: string, decimals: number): string {
  const from = tx.entries.find((e) => e.amount < 0);
  const to = tx.entries.find((e) => e.amount > 0);
  const amount = tx.entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
  return `${from?.owner_name ?? "?"} chuyển ${to?.owner_name ?? "?"} ${formatMinor(amount, decimals)} ${assetName}${tx.note ? ` — ${tx.note}` : ""}`;
}

export default function PresentPage() {
  const { code } = useParams();
  const [data, setData] = useState<PresentData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const lastTxId = useRef<number | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/present/${code}`);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error?.message ?? "Lỗi");
    const d = body.data as PresentData;
    setData(d);
    setError(null);

    // Xướng giao dịch mới cho cả bàn nghe (chime + giọng đọc)
    const newest = d.recent[0];
    if (newest && lastTxId.current !== null && newest.id > lastTxId.current) {
      if (settingsRef.current.sound) playChime("receive");
      if (settingsRef.current.voice && d.asset) {
        speak(describeTx(newest, d.asset.name, 0).replace(/\./g, ""));
      }
    }
    if (newest) lastTxId.current = newest.id;
    else lastTxId.current = 0;
  }, [code]);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
    let es: EventSource | null = null;
    let poll: number | null = null;
    const stopPoll = () => {
      if (poll !== null) {
        clearInterval(poll);
        poll = null;
      }
    };
    es = new EventSource(`/api/v1/present/${code}/events`);
    es.onopen = stopPoll;
    es.onerror = () => {
      if (poll === null) poll = window.setInterval(() => load().catch(() => {}), 15_000);
    };
    const refetch = () => load().catch(() => {});
    es.addEventListener("tx", refetch);
    es.addEventListener("players", refetch);
    es.addEventListener("session", refetch);
    return () => {
      es?.close();
      stopPoll();
    };
  }, [code, load]);

  if (error) {
    return <div className="flex min-h-screen items-center justify-center text-2xl text-red-400">{error}</div>;
  }
  if (!data) {
    return <div className="flex min-h-screen items-center justify-center text-2xl text-slate-400">Đang tải…</div>;
  }

  const decimals = data.asset?.decimals ?? 0;
  const assetName = data.asset?.name ?? "";
  const top = data.players[0]?.balance ?? 1;

  function toggle(key: keyof AppSettings) {
    setSettings((s) => {
      const next = { ...s, [key]: !s[key] };
      saveSettings(next);
      return next;
    });
  }

  return (
    <div className="min-h-screen p-8">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-5xl font-bold tracking-tight">🏦 {data.session.name}</h1>
          <p className="mt-2 text-2xl text-slate-400">
            Tham gia với mã <span className="font-mono text-4xl font-bold text-emerald-400">{data.session.join_code}</span>
            {data.session.status === "paused" && <span className="ml-4 text-amber-400">⏸ tạm dừng</span>}
            {data.session.status === "ended" && <span className="ml-4">🏁 đã kết thúc</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => toggle("sound")} className={`text-3xl ${settings.sound ? "" : "opacity-40"}`} title="Âm thanh">
            {settings.sound ? "🔊" : "🔇"}
          </button>
          <button onClick={() => toggle("voice")} className={`text-3xl ${settings.voice ? "" : "opacity-40"}`} title="Đọc giao dịch">
            {settings.voice ? "🗣️" : "🤐"}
          </button>
          <div className="rounded-2xl border border-slate-800 bg-slate-900 px-6 py-4 text-right">
            <div className="text-lg text-slate-400">Đang lưu thông</div>
            <div className="text-4xl font-bold text-emerald-400">
              {data.asset?.icon} {formatMinor(data.circulating, decimals)} {assetName}
            </div>
          </div>
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[3fr_2fr]">
        <section>
          <h2 className="mb-4 text-2xl font-semibold text-slate-300">Bảng xếp hạng</h2>
          <ol className="space-y-3">
            {data.players.map((p, i) => (
              <li key={p.id} className={`relative overflow-hidden rounded-2xl border px-6 py-4 ${i === 0 ? "border-amber-600/60 bg-amber-950/30" : "border-slate-800 bg-slate-900"}`}>
                <div
                  className="absolute inset-y-0 left-0 bg-emerald-500/10"
                  style={{ width: `${Math.max(0, (p.balance / Math.max(1, top)) * 100)}%` }}
                />
                <div className="relative flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <span className="w-10 text-center text-3xl">{MEDALS[i] ?? `${i + 1}.`}</span>
                    <span className="text-4xl">{p.avatar}</span>
                    <span className="text-3xl font-semibold">
                      {p.display_name}
                      {p.status === "locked" && <span className="ml-2 text-xl">🔒</span>}
                    </span>
                  </div>
                  <span className="font-mono text-4xl font-bold">{formatMinor(p.balance, decimals)}</span>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h2 className="mb-4 text-2xl font-semibold text-slate-300">Giao dịch trực tiếp</h2>
          <ul className="space-y-2">
            {data.recent.map((tx, i) => {
              const from = tx.entries.find((e) => e.amount < 0);
              const to = tx.entries.find((e) => e.amount > 0);
              const amount = tx.entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
              return (
                <li key={tx.id} className={`rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 ${i === 0 ? "border-emerald-700" : ""}`}>
                  <div className="text-xl">
                    <b>{from?.owner_name}</b> → <b>{to?.owner_name}</b>{" "}
                    <span className="font-mono font-bold text-emerald-400">{formatMinor(amount, decimals)}</span>
                  </div>
                  <div className="mt-0.5 text-sm text-slate-500">
                    {tx.note && <span>{tx.note} · </span>}
                    {new Date(tx.created_at).toLocaleTimeString("vi-VN")}
                  </div>
                </li>
              );
            })}
            {data.recent.length === 0 && <li className="text-slate-500">Chưa có giao dịch nào.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
