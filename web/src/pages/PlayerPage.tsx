import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SessionDetail, type Tx } from "../api";
import { useAuth, type PlayerMe } from "../auth";
import { useSessionEvents } from "../hooks/useSessionEvents";
import { ToastStack, useToasts } from "../components/Toasts";
import NotificationBell, { describeNotification } from "../components/NotificationBell";
import ExchangeForm from "../components/ExchangeForm";
import SessionResults from "../components/SessionResults";
import QrCodeCard from "../components/QrCodeCard";
import QrScannerModal from "../components/QrScannerModal";
import { parsePayInput, type PayPayload } from "../qr";
import { formatMinor } from "../money";
import { playChime } from "../sound";
import { speak, speechAvailable, speechTextFor } from "../speech";
import { loadSettings, saveSettings, type AppSettings } from "../settings";
import QuickSend, { type QuickData, type QuickPick } from "../components/QuickSend";
import FinanceSection from "../components/FinanceSection";

function fmt(n: number): string {
  return n.toLocaleString("vi-VN");
}

export default function PlayerPage() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const player = me as PlayerMe;

  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [assetId, setAssetId] = useState("");
  const [note, setNote] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [notifKey, setNotifKey] = useState(0);
  const [showQr, setShowQr] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [balancePop, setBalancePop] = useState(false);
  const [quick, setQuick] = useState<QuickData>({ favorites: [], frequent: [], templates: [] });
  const { toasts, addToast } = useToasts();

  function toggleSetting(key: keyof AppSettings) {
    setSettings((s) => {
      const next = { ...s, [key]: !s[key] };
      saveSettings(next);
      if (key === "sound" && next.sound) playChime("send"); // nghe thử ngay
      if (key === "voice" && next.voice) speak("Đã bật đọc giao dịch");
      return next;
    });
  }

  function applyQuickPick(p: QuickPick): void {
    setToId(String(p.toId));
    setAmount(p.amount ? String(p.amount) : "");
    setNote(p.note ?? "");
    if (p.assetId) setAssetId(String(p.assetId));
    addToast("⚡ Đã điền sẵn — nhập PIN để chuyển", "info");
  }

  async function toggleFavorite(): Promise<void> {
    const target = Number(toId);
    if (!target) return;
    try {
      if (quick.favorites.includes(target)) {
        await api.delete(`/api/v1/sessions/${player.sessionId}/me/favorites/${target}`);
      } else {
        await api.put(`/api/v1/sessions/${player.sessionId}/me/favorites/${target}`, {});
      }
      const q = await api.get<QuickData>(`/api/v1/sessions/${player.sessionId}/me/quick`);
      setQuick(q);
    } catch (err) {
      addToast((err as Error).message, "warn");
    }
  }

  async function saveTemplate(): Promise<void> {
    const amt = Number(amount);
    if (!Number(toId) || !Number.isInteger(amt) || amt <= 0) {
      addToast("Chọn người nhận và số tiền trước khi lưu mẫu", "warn");
      return;
    }
    try {
      await api.post(`/api/v1/sessions/${player.sessionId}/me/templates`, {
        toPlayerId: Number(toId),
        amount: amt,
        ...(selectedAsset && !selectedAsset.is_primary ? { assetTypeId: selectedAsset.id } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      const q = await api.get<QuickData>(`/api/v1/sessions/${player.sessionId}/me/quick`);
      setQuick(q);
      addToast("💾 Đã lưu mẫu giao dịch", "success");
    } catch (err) {
      addToast((err as Error).message, "warn");
    }
  }

  function applyPayPayload(p: PayPayload): void {
    if (p.s !== player.sessionId) {
      addToast("Mã QR này thuộc phiên chơi khác", "warn");
      return;
    }
    if (p.p === player.id) {
      addToast("Đây là mã QR của chính bạn", "warn");
      return;
    }
    setToId(String(p.p));
    setAmount(p.a ? String(p.a) : "");
    setNote(p.n ?? "");
    addToast("✅ Đã điền sẵn từ QR — nhập PIN để chuyển", "success");
  }

  function handleScan(text: string): void {
    setShowScanner(false);
    const p = parsePayInput(text);
    if (!p) {
      addToast("Không phải mã QR BoardBank hợp lệ", "warn");
      return;
    }
    applyPayPayload(p);
  }

  // QR quét từ camera ngoài app → /pay lưu payload chờ ở sessionStorage
  useEffect(() => {
    const raw = sessionStorage.getItem("bb.pendingPay");
    if (!raw) return;
    sessionStorage.removeItem("bb.pendingPay");
    try {
      const p = JSON.parse(raw) as PayPayload;
      applyPayPayload(p);
    } catch {
      /* payload hỏng — bỏ qua */
    }
    // chỉ chạy một lần khi vào trang
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    const d = await api.get<SessionDetail>(`/api/v1/sessions/${player.sessionId}`);
    setDetail(d);
    const { data } = await api.getWithMeta<Tx[], unknown>(
      `/api/v1/sessions/${player.sessionId}/transactions?playerId=${player.id}&limit=15`,
    );
    setTxs(data);
    api
      .get<QuickData>(`/api/v1/sessions/${player.sessionId}/me/quick`)
      .then(setQuick)
      .catch(() => {});
  }, [player.sessionId, player.id]);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  useSessionEvents(player.sessionId, {
    onTx: () => {
      load().catch(() => {});
    },
    onPlayers: () => {
      load().catch(() => {});
    },
    onNotification: (n) => {
      addToast(describeNotification(n), n.type === "tx.received" ? "success" : "warn");
      if (settings.sound) playChime(n.type === "tx.received" ? "receive" : "send");
      if (settings.voice) {
        const text = speechTextFor(n);
        if (text) speak(text);
      }
      setNotifKey((k) => k + 1);
      load().catch(() => {});
    },
    onSession: () => {
      load().catch(() => {});
    },
    onResync: () => {
      load().catch(() => {});
      setNotifKey((k) => k + 1);
    },
  });

  // Hoạt ảnh "nảy" thẻ số dư mỗi khi số dư tài sản chính thay đổi
  const prevBalRef = useRef<number | null>(null);
  useEffect(() => {
    if (!detail) return;
    const active = detail.assets.filter((a) => a.status === "active");
    const primary = active.find((a) => a.is_primary) ?? active[0];
    const bal =
      detail.balances.find(
        (b) => b.owner_type === "player" && b.owner_id === player.id && b.asset_type_id === primary?.id,
      )?.balance_cached ?? 0;
    if (prevBalRef.current !== null && prevBalRef.current !== bal) {
      setBalancePop(true);
      const t = setTimeout(() => setBalancePop(false), 600);
      prevBalRef.current = bal;
      return () => clearTimeout(t);
    }
    prevBalRef.current = bal;
  }, [detail, player.id]);

  if (!detail) return <div className="p-6 text-slate-400">{error ?? "Đang tải…"}</div>;

  const activeAssets = detail.assets.filter((a) => a.status === "active");
  const primaryAsset = activeAssets.find((a) => a.is_primary) ?? activeAssets[0];
  const balanceFor = (aid: number | undefined) =>
    detail.balances.find((b) => b.owner_type === "player" && b.owner_id === player.id && b.asset_type_id === aid)
      ?.balance_cached ?? 0;
  const myBalance = balanceFor(primaryAsset?.id);
  const meRow = detail.players.find((p) => p.id === player.id);
  const others = detail.players.filter((p) => p.id !== player.id && p.status === "active");
  const selectedAsset = activeAssets.find((a) => String(a.id) === assetId) ?? primaryAsset;
  const secondaryAssets = activeAssets.filter((a) => !a.is_primary);

  async function transfer(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFlash(null);
    try {
      await api.post(`/api/v1/sessions/${player.sessionId}/transactions`, {
        type: "transfer",
        fromPlayerId: player.id,
        toPlayerId: Number(toId),
        amount: Number(amount),
        ...(selectedAsset && !selectedAsset.is_primary ? { assetTypeId: selectedAsset.id } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        pin,
        idempotencyKey: crypto.randomUUID(),
      });
      const recipient = others.find((p) => p.id === Number(toId));
      setAmount("");
      setNote("");
      setPin("");
      setFlash("✅ Chuyển tiền thành công!");
      if (settings.sound) playChime("send");
      if (settings.voice && recipient) {
        speak(`Đã chuyển ${Number(amount)} ${selectedAsset?.name ?? ""} cho ${recipient.display_name}`);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
      if (settings.sound) playChime("error");
    }
  }

  const field =
    "w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 outline-none focus:border-emerald-500";

  return (
    <div className="mx-auto max-w-md p-5">
      <ToastStack toasts={toasts} />
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-3xl">{meRow?.avatar}</span>
          <div>
            <div className="font-bold">{player.displayName}</div>
            <div className="text-xs text-slate-500">{detail.session.name}</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => toggleSetting("sound")}
            className={`rounded-lg px-2 py-1.5 text-lg ${settings.sound ? "" : "opacity-40"} hover:bg-slate-800`}
            title={settings.sound ? "Tắt âm thanh" : "Bật âm thanh"}
          >
            {settings.sound ? "🔊" : "🔇"}
          </button>
          {speechAvailable() && (
            <button
              onClick={() => toggleSetting("voice")}
              className={`rounded-lg px-2 py-1.5 text-lg ${settings.voice ? "" : "opacity-40"} hover:bg-slate-800`}
              title={settings.voice ? "Tắt đọc giao dịch" : "Bật đọc giao dịch"}
            >
              {settings.voice ? "🗣️" : "🤐"}
            </button>
          )}
          <NotificationBell sessionId={player.sessionId} refreshKey={notifKey} />
          <button
            onClick={async () => {
              await logout();
              navigate("/join");
            }}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800"
          >
            Thoát
          </button>
        </div>
      </header>

      <div className={`mt-5 rounded-2xl bg-gradient-to-br from-emerald-700 to-emerald-900 p-6 shadow-lg ${balancePop ? "balance-pop" : ""}`}>
        <div className="text-sm text-emerald-200">Số dư của bạn</div>
        <div className="mt-1 text-4xl font-bold tracking-tight">
          {fmt(myBalance)} <span className="text-lg font-normal text-emerald-200">{primaryAsset?.name}</span>
        </div>
        {secondaryAssets.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-emerald-600/40 pt-3">
            {secondaryAssets.map((a) => (
              <span key={a.id} className="rounded-lg bg-emerald-950/50 px-2.5 py-1 text-sm">
                {a.icon} {formatMinor(balanceFor(a.id), a.decimals)} {a.name}
              </span>
            ))}
          </div>
        )}
        {meRow?.status === "locked" && (
          <div className="mt-2 rounded bg-red-950/60 px-2 py-1 text-sm text-red-300">🔒 Tài khoản đang bị khóa</div>
        )}
      </div>

      {detail.session.status === "active" && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            onClick={() => setShowQr(!showQr)}
            className={`rounded-xl border px-3 py-2.5 text-sm font-semibold ${
              showQr ? "border-emerald-600 bg-emerald-950/40" : "border-slate-700 bg-slate-900 hover:bg-slate-800"
            }`}
          >
            🧾 Mã QR của tôi
          </button>
          <button
            onClick={() => setShowScanner(true)}
            className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm font-semibold hover:bg-slate-800"
          >
            📷 Quét QR
          </button>
        </div>
      )}
      {showQr && detail.session.status === "active" && (
        <QrCodeCard
          sessionId={player.sessionId}
          playerId={player.id}
          joinCode={detail.session.join_code}
          playerName={player.displayName}
          assetName={primaryAsset?.name}
        />
      )}
      {showScanner && <QrScannerModal onResult={handleScan} onClose={() => setShowScanner(false)} />}

      {detail.session.status === "active" && (
        <QuickSend
          sessionId={player.sessionId}
          quick={quick}
          players={others}
          onPick={applyQuickPick}
          onChanged={() => {
            load().catch(() => {});
          }}
        />
      )}

      {detail.session.status === "paused" && (
        <div className="mt-4 rounded-xl border border-amber-800 bg-amber-950/40 px-4 py-3 text-amber-200">
          ⏸ Phiên đang tạm dừng — giao dịch sẽ mở lại khi quản trị viên tiếp tục.
        </div>
      )}
      {detail.session.status === "ended" && (
        <div className="mt-5">
          <SessionResults sessionId={player.sessionId} primaryAsset={primaryAsset} />
        </div>
      )}

      {detail.session.status === "active" && (
      <form onSubmit={transfer} className="mt-5 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h2 className="mb-3 font-semibold">Chuyển tiền</h2>
        <div className="space-y-3">
          <div className="flex gap-2">
            <select value={toId} onChange={(e) => setToId(e.target.value)} className={field} required>
              <option value="">— chọn người nhận —</option>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.avatar} {p.display_name}
                </option>
              ))}
            </select>
            {toId && (
              <button
                type="button"
                onClick={toggleFavorite}
                className="shrink-0 rounded-lg border border-slate-700 px-3 text-lg hover:bg-slate-800"
                title={quick.favorites.includes(Number(toId)) ? "Bỏ yêu thích" : "Đánh dấu yêu thích"}
              >
                {quick.favorites.includes(Number(toId)) ? "⭐" : "☆"}
              </button>
            )}
          </div>
          {activeAssets.length > 1 && (
            <select value={assetId || String(primaryAsset?.id ?? "")} onChange={(e) => setAssetId(e.target.value)} className={field}>
              {activeAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.icon} {a.name}
                </option>
              ))}
            </select>
          )}
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={`Số tiền (${selectedAsset?.name})`}
            className={field}
            required
          />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú (tùy chọn)" maxLength={200} className={field} />
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            placeholder="PIN xác nhận"
            className={`${field} text-center font-mono tracking-[0.3em]`}
            minLength={4}
            maxLength={6}
            required
          />
        </div>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        {flash && <p className="mt-2 text-sm text-emerald-400">{flash}</p>}
        <div className="mt-3 flex gap-2">
          <button className="flex-1 rounded-lg bg-emerald-600 py-2.5 font-semibold hover:bg-emerald-500">
            Chuyển
          </button>
          <button
            type="button"
            onClick={saveTemplate}
            className="shrink-0 rounded-lg border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-800"
            title="Lưu người nhận + số tiền + ghi chú thành mẫu gửi nhanh"
          >
            💾 Lưu mẫu
          </button>
        </div>
      </form>
      )}

      {detail.session.status === "active" && (
        <ExchangeForm
          sessionId={player.sessionId}
          playerId={player.id}
          assets={detail.assets}
          rates={detail.rates}
          onDone={() => {
            setFlash("✅ Quy đổi thành công!");
            load().catch(() => {});
          }}
        />
      )}

      {detail.session.status === "active" && (
        <FinanceSection
          sessionId={player.sessionId}
          playerId={player.id}
          players={others}
          assetName={primaryAsset?.name}
          refreshKey={notifKey}
          onDone={(msg) => {
            addToast(msg, "success");
            load().catch(() => {});
          }}
          onError={(msg) => addToast(msg, "warn")}
        />
      )}

      <section className="mt-6">
        <h2 className="mb-2 font-semibold">Giao dịch gần đây</h2>
        <ul className="space-y-1.5">
          {txs.map((tx) => {
            const myEntry = tx.entries.find((e) => e.owner_type === "player" && e.owner_id === player.id);
            const other = tx.entries.find((e) => !(e.owner_type === "player" && e.owner_id === player.id));
            const delta = myEntry?.amount ?? 0;
            return (
              <li
                key={tx.id}
                className={`flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 ${
                  tx.status === "reversed" ? "opacity-50" : ""
                }`}
              >
                <div>
                  <div className="text-sm">
                    {delta >= 0 ? `Nhận từ ${other?.owner_name}` : `Chuyển cho ${other?.owner_name}`}
                    {tx.status === "reversed" && <span className="ml-1 text-xs text-amber-400">(đã hoàn tác)</span>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {tx.note ? `${tx.note} · ` : ""}
                    {new Date(tx.created_at).toLocaleTimeString("vi-VN")}
                  </div>
                </div>
                <span className={`font-mono font-semibold ${delta >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {delta >= 0 ? "+" : ""}
                  {fmt(delta)}
                </span>
              </li>
            );
          })}
          {txs.length === 0 && <li className="text-sm text-slate-500">Chưa có giao dịch nào.</li>}
        </ul>
      </section>
    </div>
  );
}
