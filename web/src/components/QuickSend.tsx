import { api, type Player } from "../api";

export interface QuickTemplate {
  id: number;
  to_player_id: number;
  asset_type_id: number;
  amount: number;
  note: string | null;
  to_name: string;
  to_avatar: string | null;
}

export interface QuickData {
  favorites: number[];
  frequent: { playerId: number; cnt: number }[];
  templates: QuickTemplate[];
}

export interface QuickPick {
  toId: number;
  amount?: number;
  note?: string;
  assetId?: number;
}

interface Props {
  sessionId: number;
  quick: QuickData;
  players: Player[]; // những người chơi khác (active)
  onPick: (p: QuickPick) => void;
  onChanged: () => void;
}

export default function QuickSend({ sessionId, quick, players, onPick, onChanged }: Props) {
  const byId = new Map(players.map((p) => [p.id, p]));
  // Người đã có chip mẫu thì không lặp lại ở yêu thích/hay gửi
  const templateTargets = new Set(quick.templates.map((t) => t.to_player_id));
  const favoriteChips = quick.favorites.filter((id) => byId.has(id) && !templateTargets.has(id));
  const frequentChips = quick.frequent
    .map((f) => f.playerId)
    .filter((id) => byId.has(id) && !templateTargets.has(id) && !quick.favorites.includes(id));

  if (quick.templates.length === 0 && favoriteChips.length === 0 && frequentChips.length === 0) return null;

  async function removeTemplate(id: number) {
    try {
      await api.delete(`/api/v1/sessions/${sessionId}/me/templates/${id}`);
      onChanged();
    } catch {
      /* mẫu đã bị xóa — refresh sẽ đồng bộ */
    }
  }

  const chip =
    "flex shrink-0 items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm hover:border-emerald-600";

  return (
    <div className="mt-4">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Gửi nhanh</div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {quick.templates.map((t) => (
          <span key={`t${t.id}`} className={chip}>
            <button
              onClick={() =>
                onPick({ toId: t.to_player_id, amount: t.amount, note: t.note ?? undefined, assetId: t.asset_type_id })
              }
              className="flex items-center gap-1.5"
              title={t.note ?? undefined}
            >
              ⚡ {t.to_avatar} {t.to_name} · <span className="font-mono">{t.amount.toLocaleString("vi-VN")}</span>
            </button>
            <button onClick={() => removeTemplate(t.id)} className="text-slate-600 hover:text-red-400" title="Xóa mẫu">
              ✕
            </button>
          </span>
        ))}
        {favoriteChips.map((id) => {
          const p = byId.get(id)!;
          return (
            <button key={`f${id}`} onClick={() => onPick({ toId: id })} className={chip}>
              ⭐ {p.avatar} {p.display_name}
            </button>
          );
        })}
        {frequentChips.map((id) => {
          const p = byId.get(id)!;
          return (
            <button key={`q${id}`} onClick={() => onPick({ toId: id })} className={chip}>
              {p.avatar} {p.display_name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
