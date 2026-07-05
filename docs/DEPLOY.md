# Triển khai BoardBank lên VPS (Ubuntu 24.04, 1 vCPU / 512 MB / 5 GB)

Runbook production cho v1.0. Máy chỉ chạy: **Caddy + Node (1 tiến trình) + cron**.

## 1. Chuẩn bị máy

```bash
apt update && apt install -y caddy sqlite3 fail2ban
# Node 22 LTS qua nodesource
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
# zram swap 512MB (bảo hiểm OOM)
apt install -y zram-tools && echo -e "ALGO=zstd\nSIZE=512" > /etc/default/zramswap && systemctl restart zramswap
# Tắt snapd nếu có (tiết kiệm ~100MB)
systemctl disable --now snapd 2>/dev/null || true
```

## 2. Mã nguồn & build

```bash
useradd -r -m -s /usr/sbin/nologin boardbank
sudo -u boardbank git clone <repo> /home/boardbank/app
cd /home/boardbank/app
npm ci
npm run build            # typecheck server + build web ra web/dist
npm prune --omit=dev     # bỏ devDeps sau khi build — tiết kiệm disk
```

Cập nhật phiên bản mới: `git pull && npm ci && npm run build && npm prune --omit=dev && systemctl restart boardbank`.

## 3. systemd

`/etc/systemd/system/boardbank.service`:

```ini
[Unit]
Description=BoardBank
After=network.target

[Service]
User=boardbank
WorkingDirectory=/home/boardbank/app/server
Environment=NODE_ENV=production PORT=3000 HOST=127.0.0.1
Environment=DB_PATH=/home/boardbank/data/boardbank.db
Environment=BACKUP_DIR=/home/boardbank/data/backups
Environment=NODE_OPTIONS=--max-old-space-size=192
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=always
RestartSec=2
MemoryMax=280M

[Install]
WantedBy=multi-user.target
```

```bash
mkdir -p /home/boardbank/data && chown -R boardbank: /home/boardbank/data
systemctl enable --now boardbank
```

## 4. Caddy (HTTPS tự động + static + SSE)

`/etc/caddy/Caddyfile` (thay `bank.example.com`):

```caddy
bank.example.com {
    encode zstd gzip
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
    }

    handle /api/* {
        reverse_proxy 127.0.0.1:3000 {
            flush_interval -1   # bắt buộc cho SSE — không buffer
        }
    }
    handle {
        root * /home/boardbank/app/web/dist
        try_files {path} /index.html   # SPA routing
        file_server
        @assets path /assets/*
        header @assets Cache-Control "public, max-age=31536000, immutable"
    }
}
```

`systemctl reload caddy`. Xong — HTTPS tự cấp qua Let's Encrypt.

## 5. Sao lưu tự động (cron của user boardbank)

```cron
# Hằng ngày 03:00 — snapshot nhất quán + nén + xoay vòng 7 ngày
0 3 * * * sqlite3 /home/boardbank/data/boardbank.db "VACUUM INTO '/home/boardbank/data/backups/bb-$(date +\%Y\%m\%d-\%H\%M\%S).db'" && gzip /home/boardbank/data/backups/bb-*.db && ls -t /home/boardbank/data/backups/bb-*.db.gz | tail -n +8 | xargs -r rm
# Chủ nhật — giữ bản weekly (4 tuần)
30 3 * * 0 cp "$(ls -t /home/boardbank/data/backups/bb-*.db.gz | head -1)" /home/boardbank/data/backups/weekly/ && ls -t /home/boardbank/data/backups/weekly/*.gz | tail -n +5 | xargs -r rm
# (tùy chọn) đẩy offsite bằng rclone lên R2/B2
45 3 * * * rclone copy /home/boardbank/data/backups remote:boardbank-backups --max-age 24h
```

Ngoài ra admin bấm **💾 Sao lưu** trên UI bất kỳ lúc nào (`POST /api/v1/admin/backup` — tự verify integrity + đối soát sổ cái).

## 6. Khôi phục (restore drill — tập trước khi cần!)

```bash
systemctl stop boardbank
gunzip -k /home/boardbank/data/backups/bb-YYYYMMDD-HHMMSS.db.gz
sqlite3 bb-YYYYMMDD-HHMMSS.db "PRAGMA integrity_check;"        # phải ra 'ok'
mv /home/boardbank/data/boardbank.db /home/boardbank/data/boardbank.db.bad
mv bb-YYYYMMDD-HHMMSS.db /home/boardbank/data/boardbank.db
chown boardbank: /home/boardbank/data/boardbank.db
systemctl start boardbank
curl -s localhost:3000/api/health   # kiểm tra sống
```

## 7. Giám sát tối giản

- `curl https://bank.example.com/api/health` → `{status, rss, dbSize, sseClients}`.
- UptimeRobot (miễn phí) ping URL trên mỗi 5 phút.
- Cảnh báo disk: cron `df -h / | awk 'NR==2 {if ($5+0 > 80) print "DISK "$5}'` gửi mail/telegram tùy chọn.
- fail2ban mặc định bảo vệ SSH; API đã có rate limit ở tầng ứng dụng.

## 8. Load test (chạy từ máy dev, KHÔNG chạy trên VPS)

```bash
node server/scripts/loadtest.mjs https://bank.example.com 50 60000
```

Tiêu chí v1.0: 0 lỗi 5xx, p95 < 150 ms (LAN/local), RSS < 400 MB.
