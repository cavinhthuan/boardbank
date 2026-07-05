import { useEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";

interface Props {
  onResult: (text: string) => void;
  onClose: () => void;
}

export default function QrScannerModal({ onResult, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!videoRef.current) return;
    const scanner = new QrScanner(
      videoRef.current,
      (result) => {
        scanner.stop();
        onResult(result.data);
      },
      { returnDetailedScanResult: true, highlightScanRegion: true, preferredCamera: "environment" },
    );
    scanner.start().catch((e: Error) => {
      setError(
        e?.name === "NotAllowedError"
          ? "Không có quyền dùng camera — hãy cấp quyền trong trình duyệt."
          : "Không mở được camera (cần HTTPS hoặc localhost).",
      );
    });
    return () => {
      scanner.destroy();
    };
    // onResult được giữ ổn định bởi trang cha
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-slate-900 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">📷 Quét mã QR</h2>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-800">
            ✕ Đóng
          </button>
        </div>
        <div className="overflow-hidden rounded-xl bg-black">
          <video ref={videoRef} className="h-72 w-full object-cover" />
        </div>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <p className="mt-3 text-center text-xs text-slate-500">Hướng camera vào mã QR của người nhận</p>
      </div>
    </div>
  );
}
