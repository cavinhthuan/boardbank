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

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->

- [2026-07-04] **Stack:** Node.js 22 + Fastify + TypeScript + better-sqlite3 (SQLite WAL) + SSE + React/Vite/Tailwind/shadcn SPA tĩnh + Caddy + systemd. Lý do: VPS 1 vCPU/512MB — một tiến trình, không Docker/PM2/Redis/Postgres. Chi tiết so sánh trong docs/superpowers/plans/2026-07-04-boardbank-architecture-and-roadmap.md.
- [2026-07-04] **Dữ liệu:** MỘT file SQLite duy nhất, scope bằng session_id (không mỗi-phiên-một-file). Sổ cái append-only (transactions + transaction_entries), balance_cached là suy diễn, hoàn tác = giao dịch bù, số tiền lưu integer minor-unit.
- [2026-07-04] **Realtime:** SSE (không WebSocket) — luồng một chiều server→client, hành động là POST; fallback polling.
- [2026-07-04] **Auth:** admin = password scrypt (node:crypto, không bcrypt/argon2); player = join code + PIN. Cookie session lưu SQLite.
- [2026-07-04] **Lộ trình:** MVP = Phase 0–7 (v1.0); QR/TTS/quick-actions/vay-tiết kiệm-hóa đơn/leaderboard/trình chiếu = Phase 8–12 sau 1.0. TTS và QR xử lý hoàn toàn client-side (Web Speech API, qrcode/qr-scanner) — server 0 chi phí.
