#!/usr/bin/env bash
#
# Nexus 安全部署脚本 —— 在阿里云服务器上执行
#
# 设计原则：**先验证，再重启**。任何一步失败都在重启之前中止，线上保持旧版本可用。
#
# 用法：
#   bash server/deploy.sh              # 正常部署
#   bash server/deploy.sh --dry-run    # 只看会做什么，不改动任何东西
#
set -euo pipefail

# ---------- 配置 ----------
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PM2_NAME="${PM2_NAME:-nexus-api}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/.backup-deploy}"
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# ---------- 输出 ----------
C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_BLU=$'\033[36m'
say(){ printf '%s\n' "$*"; }
step(){ printf '\n%s▶ %s%s\n' "$C_BLU" "$*" "$C_RESET"; }
ok(){ printf '  %s✓%s %s\n' "$C_GRN" "$C_RESET" "$*"; }
warn(){ printf '  %s!%s %s\n' "$C_YLW" "$C_RESET" "$*"; }
die(){ printf '\n%s✗ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }
run(){
  if [ "$DRY" = "1" ]; then
    printf '  %s[dry-run]%s %s\n' "$C_DIM" "$C_RESET" "$*"
  else
    "$@"
  fi
}

[ "$DRY" = "1" ] && warn "DRY RUN 模式：不会改动任何文件、不会重启服务"

cd "$APP_DIR"

# ---------- 0. 前置检查 ----------
step "0/7 前置检查"
[ -d .git ] || die "这里不是 git 仓库：$APP_DIR"
command -v node >/dev/null || die "找不到 node"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "需要 Node 22+（node:sqlite），当前 $(node -v)"
ok "Node $(node -v)"

if command -v pm2 >/dev/null; then
  PM2_OK=1; ok "pm2 已安装"
else
  PM2_OK=0; warn "没装 pm2 —— 最后一步会跳过重启"
fi

PREV_COMMIT="$(git rev-parse HEAD)"
PREV_SUBJECT="$(git log -1 --pretty=%s)"
ok "当前版本 ${PREV_COMMIT:0:8} —— $PREV_SUBJECT"

# 有未提交改动就拦下来，避免覆盖你手改的东西
if [ -n "$(git status --porcelain)" ]; then
  warn "工作区有未提交改动："
  git status --short | sed 's/^/      /'
  die "请先 commit 或 stash，再部署（脚本不会替你丢弃改动）"
fi
ok "工作区干净"

# ---------- 1. 备份 ----------
step "1/7 备份当前版本"
STAMP="$(date +%Y%m%d-%H%M%S)"
run mkdir -p "$BACKUP_DIR"
run git bundle create "$BACKUP_DIR/repo-$STAMP.bundle" --all >/dev/null 2>&1 || warn "git bundle 失败（不影响继续）"

# 数据库是唯一不可再生的东西，单独备份
DB_CANDIDATES="$(find "$APP_DIR/server" -maxdepth 2 -name '*.db' 2>/dev/null || true)"
if [ -n "$DB_CANDIDATES" ]; then
  echo "$DB_CANDIDATES" | while read -r db; do
    [ -f "$db" ] || continue
    run cp "$db" "$BACKUP_DIR/$(basename "$db").$STAMP"
    ok "备份 $(basename "$db")"
  done
else
  warn "没找到 .db 文件（如果数据在别处，请手动确认）"
fi
ok "备份目录：$BACKUP_DIR"

# 只保留最近 N 份
if [ "$DRY" = "0" ]; then
  ls -1t "$BACKUP_DIR"/*.bundle 2>/dev/null | tail -n +$((KEEP_BACKUPS+1)) | xargs -r rm -f
  ls -1t "$BACKUP_DIR"/*.db.* 2>/dev/null | tail -n +$((KEEP_BACKUPS+1)) | xargs -r rm -f
fi

# ---------- 2. 拉取新代码 ----------
step "2/7 拉取新代码"
if [ "$DRY" = "1" ]; then
  printf '  %s[dry-run]%s git fetch --all && git merge --ff-only\n' "$C_DIM" "$C_RESET"
else
  git fetch --all --prune
  git merge --ff-only "@{u}" || die "无法快进合并（分支已分叉）。请手动处理后再部署。"
fi
NEW_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo "$PREV_COMMIT")"
ok "新版本 ${NEW_COMMIT:0:8}"

if [ "$NEW_COMMIT" = "$PREV_COMMIT" ]; then
  warn "代码没有变化 —— 仍然会继续（可能是只改了配置）"
fi

# ---------- 3. 依赖 ----------
step "3/7 依赖检查"
if [ -f server/package-lock.json ]; then
  run bash -c "cd '$APP_DIR/server' && npm ci --omit=dev --no-audit --no-fund"
  ok "npm ci 完成"
else
  warn "没有 package-lock.json，跳过"
fi

# ---------- 4. 验证（重启之前的最后一道闸）----------
step "4/7 跑测试 —— 失败就在这里中止，线上不受影响"

run node --check server/server.js
ok "后端语法"

if [ -f tests/xiangqi-moves.test.js ]; then
  run node tests/xiangqi-moves.test.js >/dev/null || die "象棋测例失败"
  ok "象棋测例"
fi

if [ -f tests/ai-report.test.js ]; then
  run node tests/ai-report.test.js >/dev/null || die "AI 报告测例失败"
  ok "AI 报告测例"
fi

if [ -f tests/smoke-server.sh ]; then
  if AUTH_TOKEN=deploy-probe PORT=3997 bash tests/smoke-server.sh >/dev/null 2>&1; then
    ok "后端冒烟（鉴权 / gzip / ETag）"
  else
    die "后端冒烟失败 —— 中止，线上未受影响"
  fi
fi

if [ -f tests/smoke-report.sh ]; then
  if AUTH_TOKEN=deploy-probe PORT=3996 bash tests/smoke-report.sh >/dev/null 2>&1; then
    ok "月报路由冒烟"
  else
    die "月报路由冒烟失败 —— 中止，线上未受影响"
  fi
fi

# ---------- 5. Nginx 端口自环检查 ----------
step "5/7 Nginx 配置检查"
NGINX_CONF="/etc/nginx/sites-enabled/nexus"
if [ -f "$NGINX_CONF" ]; then
  LISTEN_PORT="$(grep -oE 'listen[[:space:]]+[0-9]+' "$NGINX_CONF" | grep -oE '[0-9]+' | head -1)"
  PROXY_PORT="$(grep -oE 'proxy_pass[[:space:]]+http://127\.0\.0\.1:[0-9]+' "$NGINX_CONF" | grep -oE '[0-9]+$' | head -1)"
  APP_PORT="$(node -p "require('fs').existsSync('$APP_DIR/server/.env') ? (require('fs').readFileSync('$APP_DIR/server/.env','utf8').match(/^PORT=(\d+)/m)||[,'3458'])[1] : '3458'")"

  say "      nginx listen  = ${LISTEN_PORT:-未知}"
  say "      nginx 转发到   = ${PROXY_PORT:-未知}"
  say "      应用监听      = ${APP_PORT}"

  if [ -n "$PROXY_PORT" ] && [ "$PROXY_PORT" = "$APP_PORT" ]; then
    ok "端口正确（nginx 对外 ≠ 应用内部）"
  else
    warn "转发端口($PROXY_PORT) 与 应用端口($APP_PORT) 不一致 —— 请手动确认"
  fi

  # 自环 = proxy_pass 指回 nginx 自己监听的端口
  if [ -n "$LISTEN_PORT" ] && [ -n "$PROXY_PORT" ] && [ "$LISTEN_PORT" = "$PROXY_PORT" ]; then
    die "检测到端口自环：nginx 监听 $LISTEN_PORT 又转发到 $LISTEN_PORT"
  fi

  if nginx -t 2>/dev/null; then ok "nginx 配置语法正确"; else warn "nginx -t 未通过（需 sudo 时可能误报）"; fi
else
  warn "找不到 $NGINX_CONF，跳过（可能路径不同）"
fi

# ---------- 6. 重启 ----------
step "6/7 重启服务"
if [ "$PM2_OK" = "1" ]; then
  if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
    run pm2 restart "$PM2_NAME" --update-env
    ok "pm2 重启 $PM2_NAME"
  else
    warn "pm2 里没有 $PM2_NAME，跳过重启"
  fi
else
  warn "未安装 pm2，跳过"
fi

# ---------- 7. 验证线上 ----------
step "7/7 线上验证"
if [ "$DRY" = "0" ]; then
  sleep 1.5
  HEALTH_PORT="${APP_PORT:-3458}"
  if curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HEALTH_PORT/api/health" | grep -q 200; then
    ok "健康检查通过（本地 :$HEALTH_PORT）"
  else
    warn "本地健康检查未通过 —— 请查看 pm2 logs $PM2_NAME"
  fi

  PX="$(curl -s --noproxy '*' -D - -o /dev/null "http://127.0.0.1:$HEALTH_PORT/" | grep -i 'x-powered-by' || true)"
  if [ -z "$PX" ]; then ok "X-Powered-By 已隐藏"; else warn "X-Powered-By 仍在：$PX"; fi

  RCODE="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HEALTH_PORT/report/2026-09.html")"
  if [ "$RCODE" = "200" ]; then ok "月报页可访问（/report/2026-09.html）"; else warn "月报页返回 $RCODE"; fi
fi

# ---------- 完成 ----------
printf '\n%s────────────────────────────────%s\n' "$C_DIM" "$C_RESET"
ok "部署完成：${PREV_COMMIT:0:8} → ${NEW_COMMIT:0:8}"
say ""
say "  手机访问： https://nexus.kotete.xyz/report"
say "  完整月报： https://nexus.kotete.xyz/report/2026-09.html"
say ""
say "  回滚命令："
say "    cd $APP_DIR && git reset --hard $PREV_COMMIT && pm2 restart $PM2_NAME"
say ""
if [ -d "$BACKUP_DIR" ]; then
  say "  本次备份： $BACKUP_DIR/repo-$STAMP.bundle"
fi
