# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-07-04

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

## Key Learnings

- **Project:** BoardBank

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

- [2026-07-04] PowerShell tool lỗi `spawn D:\WORK\pwsh.cmd EINVAL` trên máy này — luôn dùng Bash tool (Git Bash) thay thế.
- [2026-07-04] Dừng server nền bằng TaskStop trên Windows để lại node con mồ côi giữ file SQLite + port 3000. Trước khi khởi động lại server: `netstat -ano | grep :3000` rồi `taskkill //F //PID <pid>` (xem bug-002).
- [2026-07-04] Fastify setErrorHandler cần khai báo kiểu `(err: FastifyError, ...)` tường minh, nếu không tsc strict báo TS18046 'err is unknown' (xem bug-001).

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->

- [2026-07-04] **Stack:** Node.js 22 + Fastify + TypeScript + better-sqlite3 (SQLite WAL) + SSE + React/Vite/Tailwind/shadcn SPA tĩnh + Caddy + systemd. Lý do: VPS 1 vCPU/512MB — một tiến trình, không Docker/PM2/Redis/Postgres. Chi tiết so sánh trong docs/superpowers/plans/2026-07-04-boardbank-architecture-and-roadmap.md.
- [2026-07-04] **Dữ liệu:** MỘT file SQLite duy nhất, scope bằng session_id (không mỗi-phiên-một-file). Sổ cái append-only (transactions + transaction_entries), balance_cached là suy diễn, hoàn tác = giao dịch bù, số tiền lưu integer minor-unit.
- [2026-07-04] **Realtime:** SSE (không WebSocket) — luồng một chiều server→client, hành động là POST; fallback polling.
- [2026-07-04] **Auth:** admin = password scrypt (node:crypto, không bcrypt/argon2); player = join code + PIN. Cookie session lưu SQLite.
- [2026-07-04] **Lộ trình:** MVP = Phase 0–7 (v1.0); QR/TTS/quick-actions/vay-tiết kiệm-hóa đơn/leaderboard/trình chiếu = Phase 8–12 sau 1.0. TTS và QR xử lý hoàn toàn client-side (Web Speech API, qrcode/qr-scanner) — server 0 chi phí.
- [2026-07-05] **Tài chính mở rộng (Phase 11):** loans/savings/invoices là TRẠNG THÁI HỢP ĐỒNG (bảng riêng) — tiền chỉ di chuyển qua sổ cái; lãi vay/tiết kiệm tăng contract state không sinh bút toán (bank liability), chi trả thật khi rút/trả. Lãi tính khi admin bấm accrue-interest theo config.loanRate/savingsRate — KHÔNG có scheduler nền. Batch/split = một giao dịch nhiều bút toán (nguyên tử, zero-sum). Helper `authorizeWalletAction` dùng chung: admin mọi ví không PIN, player chỉ ví mình + PIN + phiên active.
- [2026-07-05] **QR (Phase 8):** payload version hóa `{v:1,t:"bbpay",s,p,c,a?,n?}` mã hóa base64url trong URL `/pay?d=…` — camera hệ thống quét ra cũng mở được app; parsePayInput chấp nhận cả JSON thô lẫn URL, trả null với input lạ. Sinh QR bằng `qrcode`, quét bằng `qr-scanner` (worker lazy chunk) — toàn bộ client-side, server 0 chi phí. Luồng người lạ quét: /pay → sessionStorage `bb.pendingPay` → /join (prefill mã) → /play (prefill form).
- [2026-07-05] **Vòng đời & cấu hình phiên (Phase 6):** draft→active⇄paused→ended (ended là cuối, chỉ-đọc). Người chơi CHỈ giao dịch khi active; admin thao tác được ở mọi trạng thái trừ ended. Ràng buộc config (transferLimit, disabledTxTypes, allowNegative) chỉ áp lên người chơi, không áp lên admin. PATCH config là merge chỉ-thêm.
- [2026-07-04] **Mô hình quyền (Phase 3):** bank thuộc admin tạo ra nó (owner_admin_id, admin khác thấy 404); session-admin = chủ bank HOẶC player role='admin' trong phiên; member = mọi player của phiên. Player thường chỉ được transfer từ chính mình + bắt buộc PIN; admin không cần PIN. Mọi từ chối 403 đều ghi audit `auth.denied`. PIN sai 5 lần khóa 5 phút (pin_locked_until).
