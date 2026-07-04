import { useCallback, useRef, useState } from "react";

export interface Toast {
  id: number;
  text: string;
  tone: "success" | "info" | "warn";
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const addToast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  return { toasts, addToast };
}

const TONE_STYLES: Record<Toast["tone"], string> = {
  success: "border-emerald-600 bg-emerald-950/90",
  info: "border-slate-600 bg-slate-900/95",
  warn: "border-amber-600 bg-amber-950/90",
};

export function ToastStack({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`w-full max-w-sm rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur ${TONE_STYLES[t.tone]}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
