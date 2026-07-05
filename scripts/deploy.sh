#!/usr/bin/env bash
# Deploy BoardBank lên VPS — BUILD Ở MÁY DEV, server chỉ nhận artifact.
# (VPS 512MB không đủ RAM để chạy tsc/vite — sẽ bị OOM kill.)
#
# Cách dùng (Git Bash trên Windows cũng chạy được):
#   bash scripts/deploy.sh root@your-vps [/duong/dan/app]
#
# Lưu ý: SSH bằng root@ — user 'boardbank' là system user (shell nologin),
# KHÔNG đăng nhập SSH được; nó chỉ dùng để chạy service. Script tự chown
# lại quyền về boardbank sau khi cập nhật.
set -euo pipefail

HOST="${1:?Cách dùng: deploy.sh root@host [app_dir]}"
APP_DIR="${2:-/home/boardbank/app}"
SSH_OPTS="-o StrictHostKeyChecking=accept-new"

echo "==> [1/4] Build tại máy dev (typecheck server + build web)…"
npm run build

echo "==> [2/4] Cập nhật mã nguồn server (git pull) + cài prod deps…"
ssh $SSH_OPTS "$HOST" "set -e; cd '$APP_DIR' \
  && git pull --ff-only \
  && npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force >/dev/null 2>&1 || true"

echo "==> [3/4] Upload web/dist đã build…"
tar -czf - -C web/dist . | ssh $SSH_OPTS "$HOST" "set -e; rm -rf '$APP_DIR/web/dist' && mkdir -p '$APP_DIR/web/dist' && tar -xzf - -C '$APP_DIR/web/dist'"

echo "==> [4/4] Trả quyền cho boardbank + khởi động lại dịch vụ…"
ssh $SSH_OPTS "$HOST" "set -e; chown -R boardbank: '$APP_DIR' 2>/dev/null || true; \
  SUDO=''; [ \"\$(id -u)\" != 0 ] && SUDO=sudo; \
  \$SUDO systemctl restart boardbank && sleep 2 && curl -sf http://127.0.0.1:3000/api/health"
echo ""
echo "✅ Deploy xong."
