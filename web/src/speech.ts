// Đọc giao dịch thành tiếng bằng Web Speech API — chạy trên thiết bị người dùng,
// server 0 chi phí. Giọng tiếng Việt tùy hệ điều hành; không có thì toast là fallback.

let viVoice: SpeechSynthesisVoice | null | undefined;

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => v.lang.toLowerCase().startsWith("vi")) ?? null;
}

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

if (speechAvailable()) {
  // danh sách giọng tải bất đồng bộ trên nhiều trình duyệt
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    viVoice = pickVoice();
  });
}

export function speak(text: string): boolean {
  if (!speechAvailable()) return false;
  try {
    // Tránh dồn hàng đợi khi giao dịch tới dồn dập — câu mới thay câu đang chờ
    if (window.speechSynthesis.pending) window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "vi-VN";
    if (viVoice === undefined) viVoice = pickVoice();
    if (viVoice) u.voice = viVoice;
    u.rate = 1.05;
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

/** Câu đọc cho một thông báo giao dịch — số để trần (không dấu chấm ngăn cách) cho TTS đọc đúng. */
export function speechTextFor(n: { type: string; payload_json: string }): string | null {
  try {
    const p = JSON.parse(n.payload_json) as {
      amount?: number;
      counterparty?: string | null;
      assetName?: string;
      note?: string | null;
      from?: string;
      interest?: number;
    };
    const amt = `${p.amount ?? 0} ${p.assetName ?? ""}`.trim();
    const note = p.note ? `. Nội dung: ${p.note}` : "";
    switch (n.type) {
      case "tx.received":
        return `${p.counterparty ?? "Ngân hàng"} chuyển cho bạn ${amt}${note}`;
      case "tx.deducted":
        return `Bạn bị trừ ${amt} bởi ${p.counterparty ?? "ngân hàng"}${note}`;
      case "invoice.created":
        return `${p.from ?? "Ai đó"} gửi bạn hóa đơn ${p.amount ?? 0}${note}`;
      case "loan.interest":
        return `Khoản vay của bạn bị tính lãi ${p.interest ?? 0}`;
      case "saving.interest":
        return `Sổ tiết kiệm của bạn nhận lãi ${p.interest ?? 0}`;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
