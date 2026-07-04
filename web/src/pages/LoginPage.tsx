import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { refresh } = useAuth();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/api/v1/auth/admin/${mode}`, { username: username.trim(), password });
      await refresh();
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const field =
    "w-full rounded-lg bg-slate-900 border border-slate-700 px-4 py-2.5 outline-none focus:border-emerald-500";

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-3xl font-bold">🏦 BoardBank</h1>
        <p className="mt-1 text-center text-slate-400">Khu vực quản trị</p>

        <div className="mt-6 flex rounded-lg bg-slate-900 p-1">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 rounded-md py-2 text-sm font-semibold ${
                mode === m ? "bg-emerald-600" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {m === "login" ? "Đăng nhập" : "Đăng ký"}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="mt-4 space-y-3">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Tên đăng nhập"
            className={field}
            autoComplete="username"
            required
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mật khẩu (≥ 6 ký tự)"
            className={field}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button className="w-full rounded-lg bg-emerald-600 py-2.5 font-semibold hover:bg-emerald-500">
            {mode === "login" ? "Đăng nhập" : "Tạo tài khoản quản trị"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-500">
          Là người chơi?{" "}
          <Link to="/join" className="text-emerald-400 hover:underline">
            Tham gia phiên bằng mã →
          </Link>
        </p>
      </div>
    </div>
  );
}
