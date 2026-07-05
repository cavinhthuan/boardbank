#!/usr/bin/env bash
# Deploy BoardBank lên VPS — BUILD Ở MÁY DEV, server chỉ nhận artifact.
# (VPS 512MB không đủ RAM để chạy tsc/vite — sẽ bị OOM kill.)
#
# Cách dùng (Git Bash trên Windows cũng chạy được):
#   bash scripts/deploy.sh user@your-vps [/duong/dan/app]
#
# Yêu cầu: SSH key đã cài lên server; server đã setup theo docs/DEPLOY.md.
set -euo pipefail

HOST="${1:?Cách dùng: deploy.sh user@host [app_dir]}"
APP_DIR="${2:-/home/boardbank/app}"

echo "==> [1/4] Build tại máy dev (typecheck server + build web)…"
npm run build

echo "==> [2/4] Cập nhật mã nguồn server (git pull) + cài prod deps…"
ssh "$HOST" "cd '$APP_DIR' \
  && git pull --ff-only \
  && npm ci --omit=dev --no-audit --no-fund"

echo "==> [3/4] Upload web/dist đã build…"
tar -czf - -C web/dist . | ssh "$HOST" "rm -rf '$APP_DIR/web/dist' && mkdir -p '$APP_DIR/web/dist' && tar -xzf - -C '$APP_DIR/web/dist'"

echo "==> [4/4] Khởi động lại dịch vụ…"
ssh "$HOST" "sudo systemctl restart boardbank && sleep 2 && curl -sf http://127.0.0.1:3000/api/health"
echo ""
echo "✅ Deploy xong."
