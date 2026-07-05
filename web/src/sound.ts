// Hiệu ứng âm thanh sinh bằng WebAudio — không cần file audio, 0 KB asset.

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

const CHIMES: Record<string, number[]> = {
  receive: [659.25, 783.99, 1046.5], // E5-G5-C6 — vui khi nhận tiền
  send: [523.25, 659.25], // C5-E5 — xác nhận đã chuyển
  error: [233.08, 196.0], // trầm — thất bại
};

export function playChime(kind: "receive" | "send" | "error"): void {
  const c = ensureCtx();
  if (!c) return;
  const notes = CHIMES[kind]!;
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(c.destination);
    const t = c.currentTime + i * 0.12;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc.start(t);
    osc.stop(t + 0.4);
  });
}
