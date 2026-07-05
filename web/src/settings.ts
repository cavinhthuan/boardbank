// Cài đặt theo thiết bị (localStorage) — mỗi người chơi tự bật/tắt trên máy mình.

export interface AppSettings {
  sound: boolean;
  voice: boolean;
}

const KEY = "bb.settings";
const DEFAULTS: AppSettings = { sound: true, voice: true };

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* chế độ riêng tư — bỏ qua */
  }
}
