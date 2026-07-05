import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";
import { parsePayInput } from "../qr";

/**
 * Đích đến của QR khi quét bằng camera hệ thống: /pay?d=<payload>.
 * Lưu payload chờ rồi đưa người dùng tới đúng nơi:
 *  - đã là người chơi đúng phiên → /play (tự điền form chuyển)
 *  - chưa đăng nhập → /join (tự điền mã phiên)
 */
export default function PayPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { me, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    const d = params.get("d");
    const payload = d ? parsePayInput(`${window.location.origin}/pay?d=${d}`) : null;
    if (payload) sessionStorage.setItem("bb.pendingPay", JSON.stringify(payload));
    if (me?.type === "player") navigate("/play", { replace: true });
    else navigate("/join", { replace: true });
  }, [loading, me, params, navigate]);

  return <div className="p-6 text-slate-400">Đang mở giao dịch…</div>;
}
