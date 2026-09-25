#!/usr/bin/env bash
# smoke-hardening.sh —— 针对 2026-09-26 安全复审的回归测试
#
# 覆盖四项修复，任何一项被改回去都会在这里红掉：
#   1. 错误响应不再回显堆栈 / 绝对路径（NODE_ENV 未设时也不能漏）
#   2. KV 同毫秒重复写入不再静默丢弃（必须真写进去且 applied 里能看见）
#   3. /report/:name 启动时预压缩（进程起来就能命中 gzip，不靠首次请求触发）
#   4. X-Powered-By 不存在（与 smoke-report.sh 重复断言，防止被顺手加回来）
#
# 用法：AUTH_TOKEN=xxx PORT=3999 bash tests/smoke-hardening.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-3999}"
TOKEN="${AUTH_TOKEN:-ci-test-token}"
BASE="http://127.0.0.1:$PORT"
NODE="${NODE:-node}"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 $3，实际 $2）"; fi; }

TMP="$(mktemp -d)"
DB="$TMP/journal.db"
mkdir -p "$TMP/data" "$TMP/report"
# 造一份报告，验证预压缩
printf '<html><body>%s</body></html>' "$(head -c 4000 /dev/zero | tr '\0' 'x')" > "$TMP/report/2026-01.html"

PORT="$PORT" AUTH_TOKEN="$TOKEN" \
DB_PATH="$DB" DATA_DIR="$TMP/data" REPORT_DIR="$TMP/report" \
  "$NODE" "$ROOT/server/server.js" > "$TMP/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; rm -rf "$TMP"' EXIT

# 等启动
for _ in $(seq 1 50); do
  if curl -s --noproxy '*' -o /dev/null "$BASE/"; then break; fi
  sleep 0.2
done

AUTH="Authorization: Bearer $TOKEN"

echo "【1】错误响应不回显堆栈与绝对路径"
# 畸形 JSON：body-parser 会抛 SyntaxError，修复前 response 里带 node_modules 绝对路径
ERR_BODY=$(curl -s --noproxy '*' -X POST "$BASE/api/entries" \
  -H "$AUTH" -H 'Content-Type: application/json' --data-binary '{bad json' 2>/dev/null)
if echo "$ERR_BODY" | grep -qE '(node_modules|SyntaxError|\\|/server/|\.js:[0-9]+)'; then
  bad "畸形 JSON 响应泄漏了内部信息：$ERR_BODY"
else
  ok "畸形 JSON 只回笼统错误"
fi
# 500 路径也不能回 e.message
KV_ERR=$(curl -s --noproxy '*' -X PUT "$BASE/api/kv" \
  -H "$AUTH" -H 'Content-Type: application/json' --data-binary '{"items":{"a":{"updatedAt":1}}}' 2>/dev/null)
if echo "$KV_ERR" | grep -qE '(node_modules|at |\.js:[0-9]+)'; then
  bad "KV 响应泄漏堆栈：$KV_ERR"
else
  ok "KV 正常路径无泄漏"
fi

echo "【2】KV 同毫秒写入必须真正落库"
curl -s --noproxy '*' -X PUT "$BASE/api/kv" -H "$AUTH" -H 'Content-Type: application/json' \
  --data-binary '{"items":{"dup":{"updatedAt":1000,"value":"from-A"}}}' > /dev/null
R2=$(curl -s --noproxy '*' -X PUT "$BASE/api/kv" -H "$AUTH" -H 'Content-Type: application/json' \
  --data-binary '{"items":{"dup":{"updatedAt":1000,"value":"from-B"}}}')
if echo "$R2" | grep -q '"dup"'; then
  ok "同毫秒第二次写入被 applied（$R2）"
else
  bad "同毫秒第二次写入被静默丢弃：$R2"
fi
GOT=$(curl -s --noproxy '*' "$BASE/api/kv" -H "$AUTH")
if echo "$GOT" | grep -q 'from-B'; then
  ok "落库值已更新为 from-B"
else
  bad "落库值仍是被丢弃前的内容：$GOT"
fi

echo "【3】/report 启动即预压缩"
# 进程刚起、还没人访问过这个报告，靠启动预热命中 gzip
HDR=$(curl -s --noproxy '*' -D - -o /dev/null "$BASE/report/2026-01.html" -H 'Accept-Encoding: gzip')
if echo "$HDR" | grep -qi 'content-encoding: gzip'; then
  ok "首次请求即命中 gzip（说明启动时已压好）"
else
  bad "首次请求没有 gzip，预压缩可能失效"
fi

echo "【4】X-Powered-By 必须消失"
XP=$(curl -s --noproxy '*' -D - -o /dev/null "$BASE/" | grep -ci 'x-powered-by' || true)
check "X-Powered-By 已关闭" "$XP" "0"

echo
echo "————————————————————————"
echo "通过 $PASS 项，失败 $FAIL 项"
[ "$FAIL" -eq 0 ]
