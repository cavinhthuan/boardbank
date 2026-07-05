# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-05T16:32:34.790Z
> Files: 84 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `.gitignore` — Git ignore rules (~23 tok)
- `CLAUDE.md` — OpenWolf (~57 tok)
- `package.json` — Node.js package manifest (~90 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## docs/

- `DEPLOY.md` — Triển khai BoardBank lên VPS (Ubuntu 24.04, 1 vCPU / 512 MB / 5 GB) (~1076 tok)

## docs/superpowers/plans/

- `2026-07-04-boardbank-architecture-and-roadmap.md` — BoardBank — Kiến trúc & Kế hoạch triển khai tổng thể (~6620 tok)

## server/

- `package.json` — Node.js package manifest (~148 tok)
- `tsconfig.json` — TypeScript configuration (~96 tok)

## server/scripts/

- `loadtest.mjs` — Load test v1.0: N user ảo tạo giao dịch liên tục qua HTTP thật. (~785 tok)

## server/src/

- `app.ts` — API routes: GET (1 endpoints) (~798 tok)
- `auth.ts` — Gắn req.principal cho mọi request từ cookie (nếu có). (~1823 tok)
- `backup.ts` — Giữ lại `keep` bản mới nhất, xóa phần còn lại. Trả về danh sách file đã xóa. (~705 tok)
- `config.ts` — Exports Config, loadConfig (~170 tok)
- `db.ts` — Migration là additive-only (quy tắc tương thích ngược trong master plan). (~2591 tok)
- `events.ts` — null = admin theo dõi phiên (nhận mọi broadcast, không nhận event cá nhân) (~1567 tok)
- `index.ts` — Declares config (~139 tok)
- `ledger.ts` — account id được phép âm số dư (vd: kho bạc bank khi phát hành tiền) (~2034 tok)

## server/src/lib/

- `audit.ts` — Exports logAudit (~174 tok)
- `ids.ts` — Bỏ các ký tự dễ nhầm lẫn khi đọc to giữa bàn chơi: 0/O, 1/I/L (~131 tok)
- `passwords.ts` — scrypt có sẵn trong node:crypto — không cần bcrypt/argon2. (~265 tok)

## server/src/routes/

- `admin.ts` — API routes: POST, GET (2 endpoints) (~584 tok)
- `assets.ts` — Tìm tỷ giá cho cặp tài sản: ưu tiên chiều thuận, tự nghịch đảo chiều ngược (phân số → chính xác). (~4300 tok)
- `auth.ts` — API routes: POST, GET (7 endpoints) (~2415 tok)
- `banks.ts` — API routes: POST, GET (2 endpoints) (~442 tok)
- `events.ts` — API routes: GET, POST (3 endpoints) (~1033 tok)
- `finance.ts` — Ủy quyền một hành động trên ví của `playerId`: (~9090 tok)
- `personal.ts` — Các endpoint /me/* chỉ dành cho người chơi của đúng phiên đó. (~1932 tok)
- `players.ts` — API routes: POST, DELETE (3 endpoints) (~1570 tok)
- `present.ts` — Màn hình trình chiếu cho TV: CHỦ ĐÍCH không cần đăng nhập — (~1009 tok)
- `sessions.ts` — API routes: POST, GET, PATCH (6 endpoints) (~6244 tok)
- `transactions.ts` — Các loại giao dịch Phase 2. Tất cả đều là tổ hợp entries của cùng một engine: (~3928 tok)

## server/src/services/

- `playerService.ts` — Tạo người chơi trong phiên + mở tài khoản cho mọi tài sản + cấp số dư ban đầu (~806 tok)

## server/test/

- `health.test.ts` — Declares config (~404 tok)
- `helpers.ts` — Exports Cookies, registerAdmin, cookiesFrom (~217 tok)
- `phase1.test.ts` — Cookies: createBank, createSession, addPlayer (~1604 tok)
- `phase10.test.ts` — Cookies: setup, transferAs (~2378 tok)
- `phase11.test.ts` — Cookies: setup, bal (~3447 tok)
- `phase12.test.ts` — Cookies: setup, transfer (~2006 tok)
- `phase2.test.ts` — Cookies: setup, balanceOf, tx (~2504 tok)
- `phase3.test.ts` — Cookies: setupSession, claimPlayer (~3115 tok)
- `phase4.test.ts` — Cookies: fakeRaw, setupSession (~2213 tok)
- `phase5.test.ts` — Cookies: setup, balanceOf (~3471 tok)
- `phase6.test.ts` — Cookies: setup, setStatus, playerCookies (~2830 tok)
- `phase7.test.ts` — Exports sums (~2291 tok)

## web/

- `index.html` — BoardBank (~79 tok)
- `package.json` — Node.js package manifest (~151 tok)
- `tsconfig.json` — TypeScript configuration (~78 tok)
- `vite.config.ts` (~78 tok)

## web/src/

- `api.ts` — Exports ApiError, ApiRequestError, api, Bank + 11 more (~955 tok)
- `App.tsx` — Guard (~641 tok)
- `auth.tsx` — AuthContext (~390 tok)
- `index.css` — Styles: 3 rules (~68 tok)
- `main.tsx` (~66 tok)
- `money.ts` — "12,5" hoặc "12.5" → minor units; null nếu không hợp lệ hoặc quá nhiều số lẻ. (~528 tok)
- `qr.ts` — session id (~675 tok)
- `settings.ts` — Cài đặt theo thiết bị (localStorage) — mỗi người chơi tự bật/tắt trên máy mình. (~190 tok)
- `sound.ts` — Hiệu ứng âm thanh sinh bằng WebAudio — không cần file audio, 0 KB asset. (~323 tok)
- `speech.ts` — Câu đọc cho một thông báo giao dịch — số để trần (không dấu chấm ngăn cách) cho TTS đọc đúng. (~681 tok)

## web/src/components/

- `AssetsPanel.tsx` — AssetsPanel — renders form (~1723 tok)
- `AuditLog.tsx` — AuditLog — renders table (~615 tok)
- `ConfigPanel.tsx` — ConfigPanel — renders form (~1431 tok)
- `ExchangeForm.tsx` — Tìm tỷ giá hiệu lực: chiều thuận hoặc nghịch đảo — giống logic server. (~1243 tok)
- `FinanceAdminPanel.tsx` — field — renders form (~2570 tok)
- `FinanceSection.tsx` — field — renders form (~3551 tok)
- `GlobalAudit.tsx` — GlobalAudit — renders table (~636 tok)
- `NotificationBell.tsx` — describeNotification (~982 tok)
- `QrCodeCard.tsx` — QrCodeCard (~872 tok)
- `QrScannerModal.tsx` — QrScannerModal (~543 tok)
- `QuickSend.tsx` — QuickSend (~904 tok)
- `SessionResults.tsx` — MEDALS (~712 tok)
- `TimelineChart.tsx` — Palette categorical (dark) đã validate bằng dataviz validator trên nền #0f172a: (~1493 tok)
- `Toasts.tsx` — useToasts (~338 tok)
- `TransactionForm.tsx` — TX_TYPES — renders form (~1550 tok)
- `TransactionHistory.tsx` — TYPE_LABELS (~1823 tok)

## web/src/hooks/

- `useSessionEvents.ts` — gọi khi kết nối lại sau khi rớt, và mỗi 10s khi SSE đang hỏng (fallback polling) (~612 tok)

## web/src/pages/

- `BanksPage.tsx` — BanksPage — renders form (~1409 tok)
- `JoinPage.tsx` — pendingJoinCode — renders form (~1734 tok)
- `LoginPage.tsx` — LoginPage — renders form (~825 tok)
- `NewSessionPage.tsx` — NewSessionPage — renders form (~804 tok)
- `PayPage.tsx` — Đích đến của QR khi quét bằng camera hệ thống: /pay?d=<payload>. (~296 tok)
- `PlayerPage.tsx` — fmt (~5464 tok)
- `PresentPage.tsx` — MEDALS (~2256 tok)
- `SessionPage.tsx` — STATUS_LABELS — renders form (~3636 tok)
