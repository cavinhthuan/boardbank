import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { formatMinor } from "../money";

// Palette categorical (dark) đã validate bằng dataviz validator trên nền #0f172a:
// PASS lightness/chroma/contrast; CVD ở dải sàn → nhãn tên trực tiếp cuối đường là mã hóa phụ.
const COLORS = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"];

interface TimelineData {
  players: { id: number; display_name: string; avatar: string | null }[];
  points: { t: string; values: number[] }[];
}

const W = 640;
const H = 240;
const PAD = { l: 10, r: 96, t: 12, b: 8 };

export default function TimelineChart({
  sessionId,
  decimals,
  refreshKey,
}: {
  sessionId: string;
  decimals: number;
  refreshKey: number;
}) {
  const [data, setData] = useState<TimelineData | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const load = useCallback(async () => {
    setData(await api.get<TimelineData>(`/api/v1/sessions/${sessionId}/timeline`));
  }, [sessionId]);

  useEffect(() => {
    load().catch(() => {});
  }, [load, refreshKey]);

  if (!data || data.points.length < 2 || data.players.length === 0) {
    return <p className="mt-3 text-sm text-slate-500">Chưa đủ giao dịch để vẽ biểu đồ.</p>;
  }

  const { players, points } = data;
  const allValues = points.flatMap((p) => p.values);
  const yMin = Math.min(0, ...allValues);
  const yMax = Math.max(1, ...allValues);
  const x = (i: number) => PAD.l + (i / (points.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);

  // Lưới ngang recessive: 3 mức
  const gridLevels = [yMax, (yMax + yMin) / 2, yMin];

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (points.length - 1));
    setHoverIdx(Math.max(0, Math.min(points.length - 1, i)));
  }

  const hover = hoverIdx !== null ? points[hoverIdx]! : null;

  return (
    <div className="mt-3">
      {/* Legend — luôn có khi ≥2 series; chữ mang màu chữ, chấm mang màu series */}
      <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
        {players.map((p, i) => (
          <span key={p.id} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
            {p.avatar} {p.display_name}
          </span>
        ))}
      </div>
      <div className="relative overflow-x-auto">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full min-w-[420px] select-none"
          onMouseMove={onMove}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {gridLevels.map((v, i) => (
            <g key={i}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#334155" strokeWidth="1" strokeDasharray="2 4" />
              <text x={W - PAD.r + 4} y={y(v) + 3} fontSize="9" fill="#64748b">
                {formatMinor(Math.round(v), decimals)}
              </text>
            </g>
          ))}
          {players.map((p, s) => (
            <g key={p.id}>
              <polyline
                fill="none"
                stroke={COLORS[s % COLORS.length]}
                strokeWidth="2"
                strokeLinejoin="round"
                points={points.map((pt, i) => `${x(i)},${y(pt.values[s]!)}`).join(" ")}
              />
              {/* Nhãn trực tiếp cuối đường — mã hóa phụ cho CVD */}
              <text
                x={x(points.length - 1) + 5}
                y={y(points[points.length - 1]!.values[s]!) + 3 + (s % 2 === 0 ? 0 : 8)}
                fontSize="10"
                fill="#e2e8f0"
              >
                {p.display_name}
              </text>
            </g>
          ))}
          {hover && hoverIdx !== null && (
            <g>
              <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={PAD.t} y2={H - PAD.b} stroke="#94a3b8" strokeWidth="1" />
              {players.map((_, s) => (
                <circle key={s} cx={x(hoverIdx)} cy={y(hover.values[s]!)} r="3.5" fill={COLORS[s % COLORS.length]} stroke="#0f172a" strokeWidth="2" />
              ))}
            </g>
          )}
        </svg>
        {hover && (
          <div className="pointer-events-none absolute left-2 top-2 rounded-lg border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs shadow-lg">
            <div className="mb-1 text-slate-400">{new Date(hover.t).toLocaleTimeString("vi-VN")}</div>
            {players.map((p, s) => (
              <div key={p.id} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: COLORS[s % COLORS.length] }} />
                <span className="text-slate-200">{p.display_name}:</span>
                <span className="font-mono">{formatMinor(hover.values[s]!, decimals)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
