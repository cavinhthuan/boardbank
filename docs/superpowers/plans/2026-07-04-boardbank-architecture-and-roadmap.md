# BoardBank — Kiến trúc & Kế hoạch triển khai tổng thể

> **For agentic workers:** Đây là MASTER PLAN (kiến trúc + lộ trình). Khi thực thi từng phase, dùng superpowers:writing-plans để viết plan chi tiết mức task cho phase đó, rồi dùng superpowers:subagent-driven-development hoặc superpowers:executing-plans để thực thi.

**Goal:** Xây dựng web app "ngân hàng số" trung lập với trò chơi (board game, chiến thuật, nhập vai, quản lý…) — nhiều ngân hàng, nhiều phiên chơi, đa tài sản, giao dịch, realtime — chạy ổn định trên VPS Ubuntu 1 vCPU / 512 MB RAM / 5 GB NVMe.

**Architecture:** Một tiến trình Node.js duy nhất (Fastify) phục vụ API + SSE realtime; SQLite (WAL) làm cơ sở dữ liệu nhúng; frontend React SPA build tĩnh do Caddy phục vụ kèm auto-HTTPS; systemd quản lý tiến trình; sao lưu bằng cron. Không container, không Redis, không DB server.

**Tech Stack:** Node.js 22 LTS + TypeScript + Fastify 5 + better-sqlite3 (SQLite WAL) + SSE · React 18 + Vite + Tailwind CSS + shadcn/ui · Caddy 2 · systemd · pino + logrotate.

## Global Constraints

- Hạ tầng mục tiêu: **1 vCPU, 512 MB RAM, 5 GB NVMe, Ubuntu Server 24.04 LTS** — mọi lựa chọn phải tối thiểu CPU/RAM/disk.
- **Một tiến trình ứng dụng duy nhất** (Node.js); ngoài ra chỉ có Caddy + systemd + cron. Không Docker, không PM2, không Redis, không DB server.
- **Trung lập với trò chơi**: không hard-code logic của bất kỳ game nào; tài sản, quy tắc, sự kiện đều do người tạo phiên định nghĩa.
- **Toàn vẹn giao dịch**: sổ cái append-only, không bao giờ UPDATE/DELETE bản ghi giao dịch; hoàn tác = giao dịch bù (compensating entry); mọi thay đổi số dư nằm trong SQLite transaction.
- **Tương thích ngược dữ liệu**: mọi migration chỉ thêm (additive); không xóa/đổi nghĩa cột đã có; schema_version theo dõi bằng `user_version` của SQLite.
- **Mỗi phase là một vertical slice**: sau mỗi phase hệ thống chạy được, test được, deploy được; không phá chức năng đã hoàn thành.
- **Không feature creep**: chức năng ngoài danh sách phase phải được ghi vào backlog, không tự ý làm.
- Mọi thao tác quan trọng ghi **audit log**; chức năng quản trị phải qua kiểm tra quyền; không dữ liệu mồ côi (FOREIGN KEY bật cứng `PRAGMA foreign_keys=ON`).
- Giới hạn dữ liệu: body request ≤ 256 KB (mặc định), upload ảnh (avatar/logo) ≤ 512 KB sau khi client tự resize; tổng dung lượng DB + backup + log phải nằm trong ~3.5 GB (chừa 1.5 GB cho OS).
- Ngôn ngữ giao diện: tiếng Việt trước, thiết kế sẵn i18n key đơn giản (JSON) để mở rộng.

---

# PHẦN A — KIẾN TRÚC & LỰA CHỌN CÔNG NGHỆ

## A1. Ngân sách tài nguyên (512 MB RAM)

| Thành phần | RAM dự kiến | Ghi chú |
|---|---|---|
| Ubuntu 24.04 minimal (kernel + systemd + sshd) | ~110–140 MB | Tắt snapd, cloud-init không cần thiết |
| Caddy 2 | ~30–50 MB | Reverse proxy + static + HTTPS |
| Node.js app (Fastify + better-sqlite3) | ~120–200 MB | `--max-old-space-size=192` để ép trần heap |
| Cron/backup (tạm thời) | ~10–20 MB | Chạy ngắn, ban đêm |
| Dự phòng + page cache | ~80–150 MB | SQLite hưởng lợi lớn từ page cache |
| **zram swap 256–512 MB** | — | Bảo hiểm chống OOM, nén trong RAM |

Disk 5 GB: OS ~1.5 GB · app + node_modules ~250 MB · DB dự kiến < 500 MB · backup nén xoay vòng ~500 MB · log xoay vòng ~100 MB → dư an toàn.

## A2. Lựa chọn công nghệ — lý do, tài nguyên, so sánh

### Runtime & framework: **Node.js 22 LTS + Fastify 5** ✅

- **Lý do:** event-loop bất đồng bộ khớp hoàn hảo với workload I/O nhẹ + nhiều kết nối SSE giữ lâu; một ngôn ngữ (TypeScript) cho cả front + back giảm chi phí bảo trì; hệ sinh thái plugin (rate-limit, static, cookie) trưởng thành. Fastify là framework Node nhanh nhất nhóm phổ biến (~2 lần Express về req/s), schema validation tích hợp (JSON Schema) — vừa nhanh vừa thay được lớp validate riêng.
- **Tài nguyên:** RSS khởi động ~60–80 MB, dưới tải vừa ~120–200 MB; khởi động < 1 s.
- **Hạn chế:** RAM cao hơn Go; single-thread CPU (chấp nhận được — workload không nặng CPU).
- **So sánh:** *Go* nhẹ nhất (~30–60 MB, binary tĩnh) nhưng tách đôi ngôn ngữ front/back, tốc độ phát triển chậm hơn cho CRUD + UI nhiều màn hình. *Bun* nhẹ và nhanh nhưng độ chín production kém hơn LTS Node. *Python (FastAPI/Django)* RAM ngang hoặc cao hơn Node, chậm hơn, thêm ngôn ngữ thứ hai. *Next.js SSR / NestJS*: chi phí RAM + build lớn, bị loại. → Node+Fastify là điểm cân bằng tối ưu giữa tài nguyên và tốc độ phát triển; nếu sau này cần siết RAM tuyệt đối, API layer có thể viết lại bằng Go mà không đổi DB/frontend.

### Cơ sở dữ liệu: **SQLite (WAL mode) qua better-sqlite3** ✅

- **Lý do:** DB nhúng — **0 MB RAM cho tiến trình DB riêng**, 0 kết nối mạng, độ trễ đọc ~µs. better-sqlite3 là API đồng bộ (sync) — nghe ngược đời nhưng đúng cho SQLite: mỗi truy vấn < 1 ms, tránh hoàn toàn race condition khi cập nhật số dư, transaction `BEGIN IMMEDIATE` gói chuyển khoản là nguyên tử tuyệt đối. WAL cho phép đọc song song trong khi ghi. Quy mô mục tiêu (vài chục phiên đồng thời, vài trăm người chơi, vài nghìn giao dịch/giờ) chỉ là ~vài chục ghi/giây — SQLite dư sức hàng trăm lần.
- **Sao lưu/phục hồi:** `VACUUM INTO` tạo snapshot nhất quán khi đang chạy; restore = copy file; nhân bản phiên = INSERT…SELECT.
- **Hạn chế:** một writer tại một thời điểm (không sao — ta chỉ có 1 tiến trình); không scale ra nhiều máy (khi cần thì migrate sang PostgreSQL — schema SQL chuẩn, đường nâng cấp rõ ràng).
- **So sánh:** *PostgreSQL* chiếm 100–150 MB RAM + tiến trình nền — quá đắt cho 512 MB, chỉ đáng khi cần multi-server. *MySQL/MariaDB* tương tự. *File JSON/lowdb* không có transaction/toàn vẹn — loại. → SQLite là lựa chọn đúng duy nhất ở cấu hình này.
- **Thiết kế:** MỘT file DB duy nhất `boardbank.db`, mọi bảng scope theo `session_id` (đơn giản, toàn vẹn FK xuyên suốt). Phương án mỗi-phiên-một-file bị hoãn (chỉ đáng nếu cần archive từng phiên rời — ghi backlog).

### Realtime: **Server-Sent Events (SSE)** ✅

- **Lý do:** luồng dữ liệu realtime của app này **một chiều** (server → client: số dư, thông báo, bảng xếp hạng); hành động của người chơi là POST bình thường. SSE chạy trên HTTP thuần → đi qua Caddy không cấu hình gì thêm, tự động reconnect có sẵn trong `EventSource`, chi phí mỗi kết nối chỉ là 1 socket + vài KB buffer. 100 kết nối SSE ≈ vài MB RAM.
- **Hạn chế:** một chiều (đủ dùng); giới hạn 6 kết nối/domain trên HTTP/1.1 (Caddy mặc định HTTP/2 → không còn vấn đề).
- **So sánh:** *WebSocket* hai chiều nhưng thêm thư viện (ws ~ +RAM), thêm heartbeat/reconnect tự viết, thêm cấu hình proxy — không mua thêm giá trị gì. *Polling* đơn giản nhất nhưng tốn CPU/băng thông theo chu kỳ và độ trễ cao. → SSE + polling dự phòng (client tự fallback) là rẻ nhất.

### Frontend: **React 18 + Vite + Tailwind CSS + shadcn/ui, build tĩnh (SPA)** ✅

- **Lý do:** build ra file tĩnh — **server không tốn 1 MB RAM nào cho render**; Caddy phục vụ kèm cache + nén. React + shadcn/ui cho UI "ngân hàng số hiện đại" nhanh nhất, responsive sẵn cho mobile/tablet/desktop. Vite build nhanh trên máy dev, VPS không bao giờ phải build.
- **Hạn chế:** bundle React ~140 KB gz (chấp nhận được, tải 1 lần); SEO không cần (app đăng nhập).
- **So sánh:** *SvelteKit* bundle nhỏ hơn nhưng hệ sinh thái component ít hơn; *Next.js SSR* cần Node render server — tốn RAM vô ích, loại. → React SPA tĩnh.

### Web server / reverse proxy: **Caddy 2** ✅

- **Lý do:** một binary duy nhất làm cả reverse proxy, phục vụ file tĩnh, **tự động HTTPS (Let's Encrypt) không cần certbot**, HTTP/2 mặc định (quan trọng cho SSE), nén gzip/zstd, header bảo mật — thay 3 công cụ bằng 1, cấu hình ~20 dòng.
- **Tài nguyên:** ~30–50 MB RAM.
- **So sánh:** *Nginx + certbot* nhẹ hơn ~20 MB nhưng 2 thành phần, cron gia hạn cert riêng, cấu hình dài hơn — chọn Nginx chỉ khi cần vắt kiệt RAM. *Expose Node trực tiếp*: mất HTTPS tự động, mất static cache — loại.

### Quản lý tiến trình: **systemd** ✅ (không PM2)

- `Restart=always`, `MemoryMax=280M` (OOM có kiểm soát), `NODE_OPTIONS=--max-old-space-size=192`. PM2 tốn thêm 40–60 MB RAM cho daemon — loại.

### Logging: **pino → file + logrotate** ✅

- pino là logger JSON nhanh nhất Node (ghi bất đồng bộ). Xoay vòng bằng logrotate (daily, giữ 7 ngày, nén). Audit log nghiệp vụ ghi vào bảng SQLite (truy vấn được), log kỹ thuật ra file.

### Xác thực & bảo mật cơ bản

- **Admin:** email/username + password (hash **scrypt — có sẵn trong `node:crypto`**, không cần cài bcrypt/argon2, không tốn RAM như argon2). Session cookie HttpOnly + SameSite=Lax, lưu bảng `sessions_auth` trong SQLite.
- **Người chơi:** vào phiên bằng **mã phiên (join code) + chọn tên + PIN 4–6 số** — đúng ngữ cảnh chơi nhóm, không bắt đăng ký email. PIN hash scrypt. Xác nhận giao dịch bằng PIN.
- **Rate limit:** `@fastify/rate-limit` in-memory (không Redis) — chặt trên `/api/auth/*` và tạo giao dịch.
- **Chống spam/abuse:** giới hạn body 256 KB, giới hạn số phiên/ngân hàng mỗi admin, CORS khóa về domain chính, header bảo mật qua Caddy.
- **HTTPS:** Caddy tự động; HSTS bật. (QR quét camera yêu cầu HTTPS — có sẵn.)

### Upload tệp (logo/avatar)

- Client resize bằng canvas về ≤ 256×256 WebP/JPEG trước khi upload (server **không** cài sharp — tiết kiệm ~50 MB RAM tiềm ẩn); server chỉ kiểm MIME + kích thước ≤ 512 KB, lưu vào `data/uploads/`, phục vụ qua Caddy với cache dài. Có bộ avatar/emoji mặc định để đa số không cần upload.

### Sao lưu & giám sát

- **Backup:** cron 03:00 chạy `sqlite3 boardbank.db "VACUUM INTO 'backup/bb-YYYYMMDD.db'"` + gzip + giữ 7 bản ngày / 4 bản tuần; tùy chọn `rclone` đẩy lên object storage miễn phí (Cloudflare R2/Backblaze). Restore drill là DoD của Phase 7.
- **Giám sát:** endpoint `/api/health` (uptime, RSS, kích thước DB, số kết nối SSE); systemd watchdog; cron 5 phút ghi 1 dòng metric vào file; uptime theo dõi từ ngoài bằng dịch vụ miễn phí (UptimeRobot) — **không** cài Netdata/Prometheus trên VPS (quá nặng).

### Cache

- Không hệ thống cache riêng. Cache trong tiến trình bằng `Map` cho dữ liệu nóng (cấu hình phiên, tỷ giá, leaderboard đã tính) + invalidate khi ghi. HTTP cache cho static do Caddy đảm nhiệm (`immutable` cho asset có hash).

### Triển khai (deploy)

- Git repo → VPS: script `deploy.sh` (rsync/git pull + `npm ci --omit=dev` + build sẵn frontend từ máy dev/CI + `systemctl restart boardbank`). Không Docker: tiết kiệm ~100 MB RAM + ~1 GB disk, khởi động nhanh, đơn giản. Khi nâng cấp VPS lớn hơn sau này, cùng codebase chạy y nguyên; khi cần multi-instance mới tính container + Postgres.

## A3. Mô hình dữ liệu lõi (SQLite)

```
banks(id, name, logo_path, owner_admin_id, created_at, status)
game_sessions(id, bank_id, name, join_code UNIQUE, status[draft|active|paused|ended],
              config_json, created_at, started_at, ended_at)
asset_types(id, session_id, code, name, icon, decimals, is_primary)
exchange_rates(id, session_id, from_asset_id, to_asset_id, rate, updated_by, updated_at)
players(id, session_id, display_name, avatar_path, pin_hash, role[player|admin],
        status[active|locked], created_at)
accounts(id, session_id, owner_type[player|bank], owner_id, asset_type_id,
         balance_cached, UNIQUE(owner_type,owner_id,asset_type_id))
transactions(id, session_id, code UNIQUE /* TX-XXXXXX */, type, status[pending|completed|reversed|failed],
             note, created_by, confirmed_by, reversed_by_tx_id, created_at, completed_at)
transaction_entries(id, transaction_id, account_id, asset_type_id, amount /* +/-, tổng mỗi asset trong 1 tx = 0 với transfer */)
notifications(id, session_id, player_id NULL=broadcast, type, payload_json, read_at, created_at)
audit_log(id, session_id NULL, actor_type, actor_id, action, target, detail_json, created_at)
auth_sessions(id, principal_type, principal_id, token_hash, expires_at)
```

Nguyên tắc: `transactions` + `transaction_entries` là **sổ cái append-only** (nguồn sự thật); `accounts.balance_cached` là số dư suy diễn được cập nhật trong cùng SQLite transaction + có job đối soát (`SUM(entries) == balance_cached`) chạy được thủ công/cron. Hoàn tác tạo transaction mới type `reversal` trỏ về tx gốc. Mọi loại giao dịch (chuyển khoản, phát hành, thu hồi, thưởng/phạt, vay, lãi, hóa đơn, quy đổi…) đều là tổ hợp entries — **một engine duy nhất, không case đặc biệt**.

## A4. Quy ước API & mở rộng không phá vỡ

- REST JSON dưới `/api/v1/…`; version trong path để phá vỡ có kiểm soát (dự kiến không cần v2 trước 1.0).
- Response bọc `{ ok, data, error:{code,message} }`; mã lỗi máy-đọc-được (`INSUFFICIENT_FUNDS`, `ACCOUNT_LOCKED`…).
- Mọi endpoint tạo giao dịch nhận `idempotency_key` (UNIQUE) — bấm đúp/mất mạng không tạo giao dịch trùng.
- Trường mới chỉ được **thêm** vào response/config_json; không đổi nghĩa trường cũ.
- SSE endpoint: `GET /api/v1/sessions/:id/events` — sự kiện `balance`, `transaction`, `notification`, `leaderboard`, `session_status`.

---

# PHẦN B — LỘ TRÌNH TRIỂN KHAI

## Phân loại phạm vi (và lý do)

| Nhóm | Nội dung | Lý do |
|---|---|---|
| **MVP bắt buộc (Phase 0–7 → v1.0)** | Ngân hàng, phiên chơi, người chơi, tài khoản, xác thực + phân quyền + khóa TK, đa tài sản + tỷ giá, engine giao dịch (chuyển khoản, phát hành/thu hồi, điều chỉnh, thưởng/phạt, hoàn tác), số dư realtime, lịch sử + tìm kiếm cơ bản, thông báo, dashboard quản trị, thống kê cơ bản, cấu hình phiên, kết thúc phiên + báo cáo, lưu/khôi phục/sao lưu/nhân bản | Đây là tập tối thiểu để MỘT phiên chơi vận hành trọn vòng đời thực tế. Thiếu bất kỳ mục nào thì không dùng thật được. |
| **Nên có trước 1.0 (nằm trong Phase 6–7)** | Đối soát sổ cái, restore drill, rate limit, idempotency | Rẻ khi làm sớm, cực đắt khi vá sau — bảo vệ toàn vẹn dữ liệu là giá trị cốt lõi của "ngân hàng". |
| **Sau 1.0 (Phase 8–12)** | QR, âm thanh + đọc giọng nói, giao dịch nhanh/mẫu/yêu thích, vay–tiết kiệm–hóa đơn–chia tiền–định kỳ–hàng loạt, bảng xếp hạng, màn trình chiếu, biểu đồ nâng cao | Tăng trải nghiệm, không chặn việc chơi. Trì hoãn để MVP ra sớm, tránh feature creep. Vay/tiết kiệm/hóa đơn tuy hấp dẫn nhưng là **tổ hợp của engine giao dịch đã có** nên làm sau rất rẻ. |
| **Backlog (chưa làm)** | Mỗi phiên một file DB, multi-server, PWA offline, OAuth | Chưa có nhu cầu thực tế — YAGNI. |

## Milestones

- **M1 — Nền chạy được** (Phase 0–1): deploy lên VPS, admin tạo được bank + phiên + người chơi, cấp số dư. *Đánh giá:* health OK trên HTTPS thật, RAM idle < 250 MB.
- **M2 — Giao dịch tin được** (Phase 2–3): chuyển khoản, sổ cái, phân quyền, PIN, audit. *Đánh giá:* test đối soát 1.000 giao dịch ngẫu nhiên, tổng entries = 0, không lệch số dư.
- **M3 — Chơi theo nhóm thời gian thực** (Phase 4–5): SSE, thông báo, đa tài sản + quy đổi. *Đánh giá:* 30 client SSE đồng thời, độ trễ cập nhật < 1 s, RAM < 350 MB.
- **M4 — v1.0 MVP hoàn chỉnh** (Phase 6–7): dashboard, thống kê, vòng đời phiên, backup/restore/clone. *Đánh giá:* chơi thử 1 ván board game thật từ tạo phiên → kết thúc → xem báo cáo; restore từ backup thành công.
- **M5 — Trải nghiệm ngân hàng số** (Phase 8–12): QR, giọng nói, quick actions, nghiệp vụ mở rộng, trình chiếu. *Đánh giá:* từng phase có tiêu chí riêng bên dưới; sau mỗi phase chạy `openwolf designqc`.

Mỗi milestone: **đầu vào** = mã nguồn + DoD milestone trước đã đạt; **đầu ra** = bản deploy chạy trên VPS + tag git `vX.Y`; **quyết định** = đạt tiêu chí đánh giá thì đi tiếp, không đạt thì sửa trước khi mở phase mới.

---

## Phase 0 — Bộ khung & đường ray deploy

- **Mục tiêu:** repo chạy được end-to-end trên VPS thật ngay từ ngày đầu.
- **Phạm vi:** monorepo `server/` (Fastify + TS + better-sqlite3, migration runner dùng `PRAGMA user_version`, pino, config qua env) + `web/` (Vite + React + Tailwind + shadcn/ui, trang placeholder); endpoint `/api/health`; Caddyfile; systemd unit; `deploy.sh`; zram swap; logrotate.
- **Chức năng bổ sung:** health check trả `{status, uptime, rss, dbSize}`.
- **DoD:** `npm test` xanh (test khung); truy cập `https://<domain>/` thấy trang web, `/api/health` trả 200 qua HTTPS thật; `systemctl restart boardbank` < 3 s; RAM idle toàn máy < 250 MB.
- **Test quan trọng:** health 200; migration chạy idempotent (chạy 2 lần không lỗi); server tự khởi động lại khi kill -9.
- **Rủi ro:** VPS chưa có domain → dùng IP + Caddy internal TLS tạm. **Phụ thuộc:** VPS + domain trỏ DNS.

## Phase 1 — Ngân hàng, phiên chơi, người chơi (slice dọc đầu tiên)

- **Mục tiêu:** admin tạo bank → tạo phiên → thêm người chơi → cấp số dư ban đầu, thấy trên UI.
- **Phạm vi:** bảng `banks, game_sessions, asset_types (1 tài sản mặc định "Tiền"), players, accounts`; CRUD API; UI admin: tạo bank (tên/logo), tạo phiên (đơn vị tiền, số dư ban đầu), thêm/sửa/xóa người chơi (tên + avatar mặc định); cấp số dư ban đầu ghi qua **giao dịch type `issue`** (sổ cái có mặt từ phase này, dạng tối giản).
- **DoD:** tạo được 2 bank, mỗi bank 2 phiên, mỗi phiên 4 người chơi với số dư đúng; dữ liệu phiên A không lẫn phiên B; xóa người chơi chưa có giao dịch thì xóa được, có giao dịch thì chỉ vô hiệu hóa.
- **Test quan trọng:** UNIQUE join_code; FK chặn tạo player với session không tồn tại; số dư khởi tạo = tổng entries.
- **Rủi ro:** thiết kế config_json phiên quá cứng → giữ tối thiểu (tên, đơn vị, số dư đầu), phần còn lại thêm dần. **Phụ thuộc:** Phase 0.

## Phase 2 — Engine giao dịch & lịch sử

- **Mục tiêu:** tiền di chuyển được, tin cậy tuyệt đối.
- **Phạm vi:** engine giao dịch chung (validate → BEGIN IMMEDIATE → entries → cập nhật balance_cached → COMMIT → emit event); loại giao dịch: `transfer` (P2P), `issue`/`recall` (bank↔player), `adjust`, `reward`/`penalty`; mã `TX-xxxxx`, note, idempotency_key; hoàn tác (`reversal`, chỉ admin); trang lịch sử giao dịch (phân trang, lọc theo người/loại/khoảng thời gian); job đối soát.
- **DoD:** chuyển khoản trên UI giữa 2 người chơi cập nhật đúng cả hai; không thể chuyển quá số dư (trừ khi phiên cho phép âm — config); hoàn tác tạo tx bù và khóa hoàn tác lần 2; đối soát 0 lệch sau bài test 1.000 giao dịch ngẫu nhiên song song.
- **Test quan trọng:** chuyển đồng thời 50 request từ 1 tài khoản 100đ, mỗi lệnh 10đ → đúng 10 lệnh thành công; idempotency_key trùng → trả tx cũ, không tạo mới; reversal của reversal bị chặn.
- **Rủi ro:** deadlock/blocking khi ghi — better-sqlite3 sync + 1 tiến trình đã loại trừ về nguyên lý, vẫn phải test tải. **Phụ thuộc:** Phase 1.

## Phase 3 — Xác thực, phân quyền, khóa tài khoản, audit

- **Mục tiêu:** đúng người đúng quyền; mọi hành động quan trọng truy vết được.
- **Phạm vi:** đăng ký/đăng nhập admin (scrypt + cookie session); người chơi vào bằng join_code + chọn tên + đặt PIN lần đầu; xác nhận giao dịch bằng PIN; role `admin`/`player` (+ ủy quyền admin phụ cho phiên); khóa/mở tài khoản; bảng `audit_log` ghi mọi hành động quản trị và giao dịch; rate limit auth; middleware phân quyền tập trung.
- **DoD:** player không gọi được API admin (403 + audit); tài khoản bị khóa không tạo được giao dịch nhưng vẫn nhận được; sai PIN 5 lần khóa tạm 5 phút; audit log xem được trên UI admin.
- **Test quan trọng:** ma trận quyền (mỗi endpoint × mỗi role); session hết hạn; PIN brute-force bị rate limit.
- **Rủi ro:** UX vào phiên rườm rà → tối ưu: 1 màn hình nhập join code, 1 màn chọn tên + PIN. **Phụ thuộc:** Phase 1–2.

## Phase 4 — Realtime & thông báo

- **Mục tiêu:** mọi người thấy biến động ngay lập tức — trải nghiệm "chơi cùng nhau".
- **Phạm vi:** SSE hub trong tiến trình (Map<sessionId, Set<connection>>); sự kiện balance/transaction/notification/session_status; bảng `notifications` + chuông thông báo trên UI; toast nổi khi nhận tiền; client tự reconnect + refetch khi nối lại; fallback polling 10 s khi SSE fail.
- **DoD:** A chuyển cho B → màn hình B cập nhật số dư + toast < 1 s không cần refresh; rớt mạng 30 s rồi nối lại → dữ liệu tự đồng bộ đúng; 30 kết nối SSE đồng thời RAM tăng < 20 MB.
- **Test quan trọng:** sự kiện chỉ phát cho đúng phiên; notification broadcast vs cá nhân; kết nối zombie bị dọn (heartbeat 30 s).
- **Rủi ro:** proxy buffer làm trễ SSE → Caddy tắt buffer cho route SSE (`flush_interval -1`). **Phụ thuộc:** Phase 2–3.

## Phase 5 — Đa tài sản & quy đổi

- **Mục tiêu:** phiên định nghĩa tài nguyên tùy ý (vàng, gỗ, năng lượng…) — tính "đa trò chơi" thành hình.
- **Phạm vi:** CRUD asset_types theo phiên (tên, icon, số thập phân); mỗi player một account/asset (tạo lười khi phát sinh); giao dịch chọn tài sản; tỷ giá do admin đặt + giao dịch `exchange` (2 cặp entries trong 1 tx); ví hiển thị danh mục đa tài sản.
- **DoD:** tạo phiên 3 tài sản, chuyển từng loại, quy đổi theo tỷ giá đúng (làm tròn theo decimals, ghi rõ trong entries); đổi tỷ giá không ảnh hưởng giao dịch cũ (rate snapshot lưu trong tx).
- **Test quan trọng:** làm tròn quy đổi không tạo/mất giá trị ngoài quy tắc đã định; xóa asset đã có giao dịch bị chặn (chỉ ẩn).
- **Rủi ro:** số thập phân float → lưu số nguyên minor-unit (nhân 10^decimals), hiển thị mới format. **Phụ thuộc:** Phase 2.

## Phase 6 — Dashboard quản trị, thống kê, vòng đời phiên

- **Mục tiêu:** admin điều hành cả phiên từ một màn hình; phiên có mở đầu – kết thúc – kết quả.
- **Phạm vi:** dashboard admin (tổng tài sản lưu thông, số dư từng người, giao dịch gần nhất, phát hành/thu hồi nhanh, khóa TK nhanh); trạng thái phiên draft→active→paused→ended; cấu hình phiên (cho phép số dư âm, giới hạn chuyển, bật/tắt loại giao dịch); màn hình tổng quan người chơi (số dư, biến động, thống kê thu/chi tuần); kết thúc phiên → trang kết quả (xếp hạng cuối, tổng thu/chi mỗi người) + phiên ended chỉ-đọc.
- **DoD:** vận hành trọn một ván chơi thử chỉ bằng dashboard; phiên ended chặn mọi giao dịch mới nhưng xem được toàn bộ lịch sử + kết quả.
- **Test quan trọng:** chuyển trạng thái không hợp lệ bị chặn (ended → active); thống kê khớp sổ cái (đối soát chéo bằng SQL độc lập).
- **Rủi ro:** phình phạm vi thống kê → chỉ 4 con số cốt lõi + 1 danh sách, biểu đồ đẹp để Phase 12. **Phụ thuộc:** Phase 2–5.

## Phase 7 — Sao lưu, khôi phục, nhân bản, cứng hóa production → **v1.0**

- **Mục tiêu:** dữ liệu không thể mất; hệ thống sẵn sàng dùng thật lâu dài.
- **Phạm vi:** cron backup `VACUUM INTO` + gzip + xoay vòng (7 ngày/4 tuần) + tùy chọn rclone offsite; lệnh restore có tài liệu + **diễn tập thật**; nhân bản phiên (copy cấu hình + người chơi + số dư đầu, không copy lịch sử); export phiên ra JSON (lưu kết quả vĩnh viễn); rate limit toàn cục; kiểm tra tải (k6/autocannon từ máy dev): 50 user ảo tạo giao dịch liên tục 10 phút; hardening (headers, giới hạn upload, fail2ban cho SSH).
- **DoD:** restore từ backup ra staging DB, đối soát khớp 100%; nhân bản phiên chơi được ngay; load test không lỗi, p95 API < 150 ms, RAM đỉnh < 400 MB; tag `v1.0`.
- **Test quan trọng:** backup trong lúc đang ghi giao dịch vẫn nhất quán; export → import lại đối soát khớp.
- **Rủi ro:** disk đầy vì backup → script tự xóa bản cũ + cảnh báo qua health khi disk > 80%. **Phụ thuộc:** Phase 0–6.

## Phase 8 — QR (sau 1.0)

- **Phạm vi:** QR tĩnh cho tài khoản (nhận tiền), QR động theo số tiền + nội dung, quét bằng camera (thư viện client-side `qr-scanner`, sinh QR client-side bằng `qrcode` — **server 0 chi phí**), chia sẻ QR (Web Share API).
- **DoD:** quét QR của bạn → form chuyển khoản điền sẵn → PIN → xong trong < 10 s.
- **Rủi ro:** camera cần HTTPS (đã có); payload QR có version để mở rộng.

## Phase 9 — Âm thanh & đọc giao dịch bằng giọng nói

- **Phạm vi:** hiệu ứng âm thanh + hoạt ảnh khi giao dịch xong; đọc thành tiếng "A chuyển B 500 đồng" bằng **Web Speech API (SpeechSynthesis) chạy trên trình duyệt — server 0 chi phí**; cài đặt bật/tắt theo người dùng; giọng tiếng Việt tùy hệ điều hành, fallback hiển thị banner to.
- **DoD:** nhận tiền → chuông + giọng đọc trên thiết bị người nhận; toggle tắt hoạt động.
- **Rủi ro:** chất lượng giọng Việt không đồng đều giữa thiết bị → đây là tiến bộ tăng dần (progressive enhancement), không phải tính năng chặn.

## Phase 10 — Thao tác nhanh & cá nhân hóa

- **Phạm vi:** người nhận thường xuyên (suy ra từ lịch sử), đánh dấu yêu thích, mẫu giao dịch, giao dịch nhanh 1 chạm từ màn hình chính, tìm kiếm/lọc nâng cao + lưu bộ lọc.
- **DoD:** chuyển tiền cho người hay giao dịch nhất trong ≤ 3 chạm.

## Phase 11 — Nghiệp vụ tài chính mở rộng

- **Phạm vi:** chia tiền nhóm, vay & trả nợ (theo dõi dư nợ), gửi tiết kiệm + lãi (admin đặt lãi suất, tính lãi khi có tương tác hoặc tick của admin — **không chạy scheduler nền phức tạp**), hóa đơn (tạo/thanh toán/nhắc), giao dịch định kỳ & hàng loạt (admin phát lương cho cả bàn 1 lệnh). Tất cả là tổ hợp entries của engine Phase 2 — không sửa lõi.
- **DoD:** mỗi nghiệp vụ chạy trọn vòng (tạo → thực hiện → thể hiện đúng trong lịch sử + thống kê + hoàn tác được theo quyền).
- **Rủi ro:** phức tạp nghiệp vụ lãi/nợ → giữ mô hình đơn giản nhất có giá trị (lãi đơn, kỳ hạn thủ công).

## Phase 12 — Trình diễn & phân tích

- **Phạm vi:** bảng xếp hạng realtime, màn hình trình chiếu cho cả bàn (route `/present/:joinCode`, font to, auto-update qua SSE), biểu đồ tài sản theo thời gian (sparkline từ sổ cái), nhật ký hoạt động toàn hệ thống cho admin, báo cáo nâng cao.
- **DoD:** mở màn trình chiếu trên TV, mọi giao dịch hiện lên < 1 s; biểu đồ khớp sổ cái.

---

## Quy tắc bắt buộc → cơ chế thực thi (đối chiếu)

| Quy tắc | Cơ chế trong thiết kế |
|---|---|
| Toàn vẹn giao dịch | Sổ cái append-only + SQLite transaction + đối soát định kỳ (A3, Phase 2) |
| Nhất quán dữ liệu | FK bật cứng, UNIQUE, CHECK, minor-unit integer (A3, Phase 5) |
| Truy vết | tx code + audit_log + reversal chain (Phase 2–3) |
| Phân quyền quản trị | middleware role tập trung + ma trận test quyền (Phase 3) |
| Không dữ liệu mồ côi | FK + soft-delete cho thực thể đã có giao dịch (Phase 1) |
| Tương thích ngược | migration additive + API v1 + trường chỉ-thêm (A4) |
| Lỗi được xử lý & ghi nhận | error envelope + pino + fastify error hook (A4) |
| Hiệu năng thấp | ngân sách RAM A1 + load test là DoD Phase 7 |
| Không gắn game cụ thể | asset/config/sự kiện đều data-driven theo phiên (A3, Phase 5) |
| Không feature creep | backlog riêng, phase sau 1.0 chỉ mở khi M4 đạt |

## Self-review đã thực hiện

- **Phủ spec:** từng chức năng bắt buộc trong yêu cầu đều trỏ được về Phase 0–7; nhóm mở rộng (QR, giọng nói, hiệu ứng, quick actions, vay/tiết kiệm/hóa đơn/định kỳ/hàng loạt, leaderboard, trình chiếu, báo cáo nâng cao) nằm ở Phase 8–12 đúng thứ tự ưu tiên người dùng yêu cầu (bắt buộc trước, mở rộng sau).
- **Placeholder:** tài liệu này là master plan — chi tiết mức task/code sẽ nằm trong plan con của từng phase (viết bằng superpowers:writing-plans khi bắt đầu phase, theo đúng cấu trúc TDD bite-sized).
- **Nhất quán kiểu dữ liệu:** schema A3 là nguồn chuẩn tên bảng/cột cho mọi phase.
