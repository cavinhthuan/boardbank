// Tiền lưu dạng số nguyên minor-unit; chỉ format khi hiển thị.

export function formatMinor(minor: number, decimals: number): string {
  if (decimals === 0) return minor.toLocaleString("vi-VN");
  const sign = minor < 0 ? "-" : "";
  const s = Math.abs(minor).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals);
  return `${sign}${Number(int).toLocaleString("vi-VN")},${frac}`;
}

/** "12,5" hoặc "12.5" → minor units; null nếu không hợp lệ hoặc quá nhiều số lẻ. */
export function toMinor(input: string, decimals: number): number | null {
  const t = input.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [intPart, fracPart = ""] = t.split(".");
  if (fracPart.length > decimals) return null;
  const minor = Number(intPart) * 10 ** decimals + Number(fracPart.padEnd(decimals, "0") || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

/** "10" → {num:10,den:1}; "0.5" → {num:5,den:10}. Tối đa 6 số lẻ. */
export function parseRate(input: string): { num: number; den: number } | null {
  const t = input.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [intPart, fracPart = ""] = t.split(".");
  if (fracPart.length > 6) return null;
  const den = 10 ** fracPart.length;
  const num = Number(intPart) * den + Number(fracPart || "0");
  if (num < 1 || !Number.isSafeInteger(num)) return null;
  return { num, den };
}

export function rateToString(num: number, den: number): string {
  const v = num / den;
  return v.toLocaleString("vi-VN", { maximumFractionDigits: 6 });
}

/** Cùng quy tắc floor với server. An toàn vì amount ≤ 1e12, num ≤ 1e9 → dùng BigInt. */
export function convertPreview(amount: number, num: number, den: number): number {
  return Number((BigInt(amount) * BigInt(num)) / BigInt(den));
}
