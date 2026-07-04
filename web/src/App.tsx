import { useEffect, useState } from "react";

interface Health {
  status: string;
  uptime: number;
  rss: number;
  dbSize: number;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((body) => setHealth(body.data))
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 p-8 shadow-xl">
        <h1 className="text-3xl font-bold tracking-tight">
          🏦 BoardBank
        </h1>
        <p className="mt-2 text-slate-400">
          Ngân hàng số cho mọi trò chơi — Phase 0
        </p>
        <div className="mt-6 rounded-lg bg-slate-800/60 p-4 text-sm font-mono">
          {error && <span className="text-red-400">API lỗi: {error}</span>}
          {!error && !health && <span className="text-slate-500">Đang kiểm tra API…</span>}
          {health && (
            <ul className="space-y-1">
              <li>
                trạng thái: <span className="text-emerald-400">{health.status}</span>
              </li>
              <li>uptime: {health.uptime}s</li>
              <li>RAM server: {(health.rss / 1024 / 1024).toFixed(1)} MB</li>
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
