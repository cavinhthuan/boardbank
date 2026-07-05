import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { buildPayload, buildPayUrl } from "../qr";

interface Props {
  sessionId: number;
  playerId: number;
  joinCode: string;
  playerName: string;
  assetName: string | undefined;
}

export default function QrCodeCard({ sessionId, playerId, joinCode, playerName, assetName }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  const amountNum = Number(amount);
  const payload = buildPayload(
    sessionId,
    playerId,
    joinCode,
    Number.isInteger(amountNum) && amountNum > 0 ? amountNum : undefined,
    note,
  );
  const url = buildPayUrl(window.location.origin, payload);

  useEffect(() => {
    if (!canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, url, {
      width: 232,
      margin: 1,
      color: { dark: "#0f172a", light: "#f8fafc" },
    }).catch(() => {});
  }, [url]);

  async function share() {
    setShareMsg(null);
    const text = payload.a
      ? `Chuyển ${payload.a.toLocaleString("vi-VN")} ${assetName ?? ""} cho ${playerName}${payload.n ? ` — ${payload.n}` : ""}`
      : `Chuyển tiền cho ${playerName} trong BoardBank`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "BoardBank", text, url });
      } else {
        await navigator.clipboard.writeText(url);
        setShareMsg("Đã sao chép liên kết!");
      }
    } catch {
      // người dùng hủy share — bỏ qua
    }
  }

  const field =
    "w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 outline-none focus:border-emerald-500";

  return (
    <div className="mt-5 rounded-xl border border-slate-800 bg-slate-900 p-4">
      <h2 className="mb-3 font-semibold">Mã QR nhận tiền của bạn</h2>
      <div className="flex flex-col items-center gap-3">
        <div className="rounded-xl bg-slate-50 p-2">
          <canvas ref={canvasRef} />
        </div>
        <p className="text-center text-sm text-slate-400">
          {payload.a
            ? `QR động: nhận ${payload.a.toLocaleString("vi-VN")} ${assetName ?? ""}${payload.n ? ` — "${payload.n}"` : ""}`
            : "QR tĩnh — người quét tự nhập số tiền"}
        </p>
        <div className="grid w-full grid-cols-2 gap-2">
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={`Số tiền (${assetName ?? ""})`}
            className={field}
          />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nội dung" maxLength={100} className={field} />
        </div>
        <button onClick={share} className="w-full rounded-lg bg-slate-700 py-2 font-semibold hover:bg-slate-600">
          📤 Chia sẻ mã QR
        </button>
        {shareMsg && <p className="text-sm text-emerald-400">{shareMsg}</p>}
      </div>
    </div>
  );
}
