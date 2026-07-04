export interface ApiError {
  code: string;
  message: string;
}

export class ApiRequestError extends Error {
  code: string;
  constructor(err: ApiError) {
    super(err.message);
    this.code = err.code;
  }
}

async function requestFull<T, M = unknown>(url: string, init?: RequestInit): Promise<{ data: T; meta: M }> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json();
  if (!body.ok) throw new ApiRequestError(body.error ?? { code: "UNKNOWN", message: "Lỗi không xác định" });
  return { data: body.data as T, meta: body.meta as M };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  return (await requestFull<T>(url, init)).data;
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  getWithMeta: <T, M>(url: string) => requestFull<T, M>(url),
  post: <T>(url: string, data: unknown) =>
    request<T>(url, { method: "POST", body: JSON.stringify(data) }),
  delete: <T>(url: string) => request<T>(url, { method: "DELETE" }),
};

export interface Bank {
  id: number;
  name: string;
  created_at: string;
  session_count: number;
}

export interface GameSession {
  id: number;
  bank_id: number;
  name: string;
  join_code: string;
  status: "draft" | "active" | "paused" | "ended";
  created_at: string;
  player_count?: number;
}

export interface AssetType {
  id: number;
  code: string;
  name: string;
  icon: string | null;
  decimals: number;
  is_primary: number;
}

export interface Player {
  id: number;
  display_name: string;
  avatar: string | null;
  role: string;
  status: string;
}

export interface Balance {
  owner_type: "player" | "bank";
  owner_id: number;
  asset_type_id: number;
  balance_cached: number;
}

export interface TxEntry {
  amount: number;
  asset_type_id: number;
  owner_type: "player" | "bank";
  owner_id: number;
  owner_name: string;
}

export interface Tx {
  id: number;
  code: string;
  type: string;
  status: "pending" | "completed" | "reversed" | "failed";
  note: string | null;
  created_by: string | null;
  reversed_by_tx_id: number | null;
  created_at: string;
  entries: TxEntry[];
}

export interface SessionDetail {
  session: GameSession & { config: { initialBalance: number } };
  bank: Bank;
  assets: AssetType[];
  players: Player[];
  balances: Balance[];
}
