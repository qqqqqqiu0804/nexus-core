#!/usr/bin/env bash
# 冒烟测试：验证 /report 路由 + 原有安全头
# 用法：bash tests/smoke-report.sh
set -u

NODE="${NODE:-node}"
PORT="${PORT:-3499}"
BASE="http://127.0.0.1:${PORT}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
no(){ echo "  ✗ $1"; fail=$((fail+1)); }

# 起服务
PORT="$PORT" AUTH_TOKEN="smoke-test-token" "$NODE" "$ROOT/server/server.js" >/tmp/nexus-smoke.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

# 等就绪
for i in $(seq 1 50); do
  curl -s --noproxy '*' -o /dev/null "$BASE/api/health" && break
  sleep 0.2
done

echo "【1】X-Powered-By 必须消失"
hdr=$(curl -s --noproxy '*' -D - -o /dev/null "$BASE/")
if echo "$hdr" | grep -qi "x-powered-by"; then no "仍在泄露技术栈"; else ok "已关闭"; fi

echo "【2】/report 列表页"
body=$(curl -s --noproxy '*' "$BASE/report")
if echo "$body" | grep -q "2026-09"; then ok "列表包含 2026-09"; else no "列表缺少报告"; fi

echo "【3】/report/2026-09.html 正文"
code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$BASE/report/2026-09.html")
if [ "$code" = "200" ]; then ok "HTTP 200"; else no "HTTP $code"; fi
body=$(curl -s --noproxy '*' "$BASE/report/2026-09.html")
if echo "$body" | grep -q "2026 年 9 月"; then ok "含标题"; else no "标题缺失"; fi

echo "【4】gzip 生效且体积更小"
raw=$(curl -s --noproxy '*' "$BASE/report/2026-09.html" | wc -c)
gz=$(curl -s --noproxy '*' -H 'Accept-Encoding: gzip' "$BASE/report/2026-09.html" | wc -c)
enc=$(curl -s --noproxy '*' -D - -o /dev/null -H 'Accept-Encoding: gzip' "$BASE/report/2026-09.html" | grep -i "content-encoding" | tr -d '\r')
if echo "$enc" | grep -qi gzip; then ok "Content-Encoding: gzip"; else no "无 gzip 头"; fi
if [ "$gz" -lt "$raw" ]; then ok "gzip $gz < raw $raw 字节"; else no "gzip 未减小"; fi

echo "【5】ETag / 304"
etag=$(curl -s --noproxy '*' -D - -o /dev/null "$BASE/report/2026-09.html" | grep -i "^etag" | sed 's/[Ee][Tt]ag: //' | tr -d '\r')
if [ -n "$etag" ]; then ok "返回 ETag $etag"; else no "无 ETag"; fi
code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$BASE/report/2026-09.html")
if [ "$code" = "304" ]; then ok "命中 304"; else no "期望 304，得 $code"; fi

echo "【6】路径穿越必须被挡"
for bad in "../server/journal.db" "..%2Fserver%2Fjournal.db" "a/b.html"; do
  code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$BASE/report/$bad")
  if [ "$code" = "400" ] || [ "$code" = "404" ]; then ok "挡住：$bad → $code"; else no "未挡住：$bad → $code"; fi
done

echo "【7】index.html 仍正常"
code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$BASE/")
if [ "$code" = "200" ]; then ok "HTTP 200"; else no "HTTP $code"; fi

echo "【8】鉴权仍生效"
code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$BASE/api/kv")
if [ "$code" = "401" ]; then ok "无 token → 401"; else no "期望 401，得 $code"; fi

echo ""
echo "————————————————————————"
echo "通过 $pass 项，失败 $fail 项"
[ "$fail" -eq 0 ] || exit 1
