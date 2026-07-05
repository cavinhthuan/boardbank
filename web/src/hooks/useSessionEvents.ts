import { useEffect, useRef } from "react";

export interface NotificationData {
  id: number;
  type: string;
  payload_json: string;
  created_at: string;
}

interface Handlers {
  onTx?: (data: { id: number; code: string; type: string; status: string }) => void;
  onNotification?: (n: NotificationData) => void;
  onPlayers?: () => void;
  onSession?: (data: { status: string }) => void;
  /** gọi khi kết nối lại sau khi rớt, và mỗi 10s khi SSE đang hỏng (fallback polling) */
  onResync?: () => void;
}

export function useSessionEvents(sessionId: number | string | undefined, handlers: Handlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!sessionId) return;
    let es: EventSource | null = null;
    let pollTimer: number | null = null;
    let hadError = false;
    let closed = false;

    const stopPoll = () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    const startPoll = () => {
      if (pollTimer !== null) return;
      pollTimer = window.setInterval(() => ref.current.onResync?.(), 10_000);
    };

    const connect = () => {
      if (closed) return;
      es = new EventSource(`/api/v1/sessions/${sessionId}/events`);
      es.onopen = () => {
        stopPoll();
        if (hadError) {
          hadError = false;
          ref.current.onResync?.(); // đồng bộ lại dữ liệu bị lỡ khi mất kết nối
        }
      };
      es.onerror = () => {
        // EventSource tự retry; trong lúc đó dùng polling làm lưới an toàn
        hadError = true;
        startPoll();
      };
      es.addEventListener("tx", (e) => ref.current.onTx?.(JSON.parse((e as MessageEvent).data)));
      es.addEventListener("notification", (e) => ref.current.onNotification?.(JSON.parse((e as MessageEvent).data)));
      es.addEventListener("players", () => ref.current.onPlayers?.());
      es.addEventListener("session", (e) => ref.current.onSession?.(JSON.parse((e as MessageEvent).data)));
    };

    connect();
    return () => {
      closed = true;
      es?.close();
      stopPoll();
    };
  }, [sessionId]);
}
