import { useEffect, useState } from "react";
import { api } from "../api";

interface AuditRow {
  id: number;
  session_id: number | null;
  session_name: string | null;
  actor_type: string;
  actor_id: number | null;
  action: string;
  target: string | null;
  created_at: string;
}

export default function GlobalAudit() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api
      .get<AuditRow[]>("/api/v1/admin/audit?limit=150")
      .then(setRows)
      .catch((e) => setError((e as Error).message));
  }, [open]);

  return (
    <section className="mt-10">
      <button onClick={() => setOpen(!open)} className="font-semibold text-slate-300 hover:text-slate-100">
        {open ? "▾" : "▸"} Nhật ký hoạt động toàn hệ thống
      </button>
      {open && (
        <div className="mt-2 max-h-96 overflow-y-auto rounded-lg border border-slate-800 bg-slate-900">
          {error && <p className="p-3 text-sm text-red-400">{error}</p>}
          <table className="w-full text-left text-xs">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-3 py-1.5 whitespace-nowrap text-slate-500">
                    {new Date(r.created_at).toLocaleString("vi-VN")}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-slate-400">{r.session_name ?? "—"}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-slate-400">
                    {r.actor_type}
                    {r.actor_id ? `#${r.actor_id}` : ""}
                  </td>
                  <td className="px-2 py-1.5 font-mono">{r.action}</td>
                  <td className="px-2 py-1.5 text-slate-500">{r.target}</td>
                </tr>
              ))}
              {rows.length === 0 && !error && (
                <tr>
                  <td className="px-3 py-2 text-slate-500">Trống.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
