import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

interface JoinPreview {
  session: { id: number; name: string; status: string };
  players: { id: number; display_name: string; avatar: string | null; status: string; has_pin: number }[];
}

export default function JoinPage() {
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<JoinPreview | null>(null);
  const [selected, setSelected] = useState<number | "new" | null>(null);
  const [newName, setNewName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const field =
    "w-full rounded-lg bg-slate-900 border border-slate-700 px-4 py-2.5 outline-none focus:border-emerald-500";

  async function lookup(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setPreview(await api.get<JoinPreview>(`/api/v1/join/${code.trim().toUpperCase()}`));
      setSelected(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function enter(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const joinCode = code.trim().toUpperCase();
    try {
      if (selected === "new") {
        await api.post(`/api/v1/join/${joinCode}/register`, { displayName: newName.trim(), pin });
      } else {
        await api.post(`/api/v1/join/${joinCode}/claim`, { playerId: selected, pin });
      }
      await refresh();
      navigate("/play");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const selectedPlayer = preview?.players.find((p) => p.id === selected);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <h1 className="text-center text-3xl font-bold">🎲 Tham gia phiên chơi</h1>

      {!preview && (
        <form onSubmit={lookup} className="mt-8 space-y-3">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Nhập mã phiên (6 ký tự)"
            className={`${field} text-center font-mono text-2xl tracking-[0.3em] uppercase`}
            maxLength={6}
            required
          />
          {error && <p className="text-center text-sm text-red-400">{error}</p>}
          <button className="w-full rounded-lg bg-emerald-600 py-3 font-semibold hover:bg-emerald-500">
            Tìm phiên
          </button>
        </form>
      )}

      {preview && (
        <div className="mt-8">
          <p className="text-center text-slate-400">
            Phiên: <span className="font-semibold text-slate-100">{preview.session.name}</span>
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {preview.players
              .filter((p) => p.status !== "removed")
              .map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setSelected(p.id);
                    setError(null);
                  }}
                  className={`rounded-xl border p-3 text-left ${
                    selected === p.id ? "border-emerald-500 bg-emerald-950/40" : "border-slate-800 bg-slate-900 hover:border-slate-600"
                  }`}
                >
                  <div className="text-2xl">{p.avatar}</div>
                  <div className="mt-1 font-semibold">{p.display_name}</div>
                  <div className="text-xs text-slate-500">{p.has_pin ? "đã có PIN" : "chưa đặt PIN"}</div>
                </button>
              ))}
            <button
              onClick={() => {
                setSelected("new");
                setError(null);
              }}
              className={`rounded-xl border border-dashed p-3 text-left ${
                selected === "new" ? "border-emerald-500 bg-emerald-950/40" : "border-slate-700 text-slate-400 hover:border-slate-500"
              }`}
            >
              <div className="text-2xl">➕</div>
              <div className="mt-1 font-semibold">Tên mới…</div>
            </button>
          </div>

          {selected !== null && (
            <form onSubmit={enter} className="mt-4 space-y-3">
              {selected === "new" && (
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Tên của bạn"
                  className={field}
                  maxLength={40}
                  required
                />
              )}
              <input
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                placeholder={
                  selected === "new" || (selectedPlayer && !selectedPlayer.has_pin)
                    ? "Đặt PIN mới (4–6 số)"
                    : "Nhập PIN của bạn"
                }
                className={`${field} text-center font-mono text-xl tracking-[0.3em]`}
                minLength={4}
                maxLength={6}
                required
              />
              {error && <p className="text-center text-sm text-red-400">{error}</p>}
              <button className="w-full rounded-lg bg-emerald-600 py-3 font-semibold hover:bg-emerald-500">
                Vào phiên
              </button>
            </form>
          )}
        </div>
      )}

      <p className="mt-8 text-center text-sm text-slate-500">
        <Link to="/login" className="hover:text-slate-300">
          Khu vực quản trị →
        </Link>
      </p>
    </div>
  );
}
