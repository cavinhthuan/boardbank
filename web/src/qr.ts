// Payload QR của BoardBank — có version để mở rộng không phá vỡ (quy tắc master plan).
// Dạng chia sẻ: URL `${origin}/pay?d=<base64url(JSON)>` — camera thường quét ra cũng mở được app.

export interface PayPayload {
  v: 1;
  t: "bbpay";
  /** session id */
  s: number;
  /** player id người NHẬN */
  p: number;
  /** join code — cho người quét chưa vào phiên */
  c: string;
  /** amount (minor units) — QR động */
  a?: number;
  /** note — QR động */
  n?: string;
}

export function buildPayload(
  sessionId: number,
  playerId: number,
  joinCode: string,
  amount?: number,
  note?: string,
): PayPayload {
  const p: PayPayload = { v: 1, t: "bbpay", s: sessionId, p: playerId, c: joinCode };
  if (amount && amount > 0) p.a = amount;
  if (note?.trim()) p.n = note.trim();
  return p;
}

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function buildPayUrl(origin: string, payload: PayPayload): string {
  return `${origin}/pay?d=${toBase64Url(JSON.stringify(payload))}`;
}

function isValid(p: unknown): p is PayPayload {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    o.v === 1 &&
    o.t === "bbpay" &&
    typeof o.s === "number" &&
    typeof o.p === "number" &&
    typeof o.c === "string" &&
    (o.a === undefined || (typeof o.a === "number" && Number.isInteger(o.a) && o.a > 0)) &&
    (o.n === undefined || typeof o.n === "string")
  );
}

/** Chấp nhận cả JSON thô lẫn URL /pay?d=… . Trả null nếu không phải QR BoardBank hợp lệ. */
export function parsePayInput(text: string): PayPayload | null {
  const t = text.trim();
  try {
    if (t.startsWith("{")) {
      const p = JSON.parse(t);
      return isValid(p) ? p : null;
    }
    const url = new URL(t);
    const d = url.searchParams.get("d");
    if (!d) return null;
    const p = JSON.parse(fromBase64Url(d));
    return isValid(p) ? p : null;
  } catch {
    return null;
  }
}
