import { useState, type FormEvent } from "react";
import { api, type AssetType, type Player } from "../api";

const TX_TYPES = [
  { value: "transfer", label: "Chuyển khoản", needsFrom: true, needsTo: true },
  { value: "issue", label: "Phát hành (bank → người chơi)", needsFrom: false, needsTo: true },
  { value: "reward", label: "Thưởng", needsFrom: false, needsTo: true },
  { value: "recall", label: "Thu hồi (người chơi → bank)", needsFrom: true, needsTo: false },
  { value: "penalty", label: "Phạt", needsFrom: true, needsTo: false },
] as const;

interface Props {
  sessionId: string;
  players: Player[];
  asset: AssetType | undefined;
  onDone: () => void;
}

export default function TransactionForm({ sessionId, players, asset, onDone }: Props) {
  const [type, setType] = useState<(typeof TX_TYPES)[number]["value"]>("transfer");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const spec = TX_TYPES.find((t) => t.value === type)!;
  const field =
    "rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 outline-none focus:border-emerald-500 w-full";

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt <= 0) {
      setError("Số tiền phải là số nguyên dương");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/sessions/${sessionId}/transactions`, {
        type,
        amount: amt,
        ...(spec.needsFrom ? { fromPlayerId: Number(fromId) } : {}),
        ...(spec.needsTo ? { toPlayerId: Number(toId) } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        idempotencyKey: crypto.randomUUID(),
      });
      setAmount("");
      setNote("");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const playerOptions = players
    .filter((p) => p.status === "active")
    .map((p) => (
      <option key={p.id} value={p.id}>
        {p.avatar} {p.display_name}
      </option>
    ));

  return (
    <form onSubmit={submit} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <h2 className="mb-3 font-semibold">Tạo giao dịch</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-sm text-slate-400">Loại giao dịch</span>
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)} className={field}>
            {TX_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {spec.needsFrom && (
          <label className="block">
            <span className="mb-1 block text-sm text-slate-400">Từ</span>
            <select value={fromId} onChange={(e) => setFromId(e.target.value)} className={field} required>
              <option value="">— chọn người chơi —</option>
              {playerOptions}
            </select>
          </label>
        )}
        {spec.needsTo && (
          <label className="block">
            <span className="mb-1 block text-sm text-slate-400">Đến</span>
            <select value={toId} onChange={(e) => setToId(e.target.value)} className={field} required>
              <option value="">— chọn người chơi —</option>
              {playerOptions}
            </select>
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-sm text-slate-400">Số tiền ({asset?.name})</span>
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={field}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-slate-400">Ghi chú</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className={field} placeholder="tùy chọn" />
        </label>
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <button
        disabled={busy}
        className="mt-4 w-full rounded-lg bg-emerald-600 py-2.5 font-semibold hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy ? "Đang xử lý…" : "Thực hiện"}
      </button>
    </form>
  );
}
