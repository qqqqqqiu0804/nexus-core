#!/bin/bash
# 后端冒烟测试：真起服务，验 gzip / ETag / 鉴权。
# 用法： AUTH_TOKEN=x bash tests/smoke-server.sh
# 本地跑和 CI 跑同一份，避免「CI 绿了但本地坏」这类偏差。
set -u
PORT="${PORT:-3999}"
TOKEN="${AUTH_TOKEN:-smoke-token}"
DB="${DB_PATH:-/tmp/nexus-smoke.db}"
cd "$(dirname "$0")/.."

echo "启动后端（port=$PORT）…"
AUTH_TOKEN="$TOKEN" PORT="$PORT" DB_PATH="$DB" NODE_ENV=production node server/server.js >/tmp/nexus-smoke.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

BASE="http://127.0.0.1:$PORT"
for i in $(seq 1 30); do
  curl -sf -o /dev/null "$BASE/" 2>/dev/null && break
  sleep 0.5
done

fail=0
check() { # check <描述> <实际> <期望>
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1（期望 $3，实际 $2）"; fail=1; fi
}

echo ""
echo "【鉴权】"
C=$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' "$BASE/api/entries")
check "错误 token → 401" "$C" "401"
C=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/entries")
check "正确 token → 200" "$C" "200"
C=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/entries")
check "无 token → 401" "$C" "401"

echo ""
echo "【gzip】"
curl -s -H 'Accept-Encoding: gzip' -o /tmp/nexus-gz.html -D /tmp/nexus-gz.hdr "$BASE/"
grep -qi 'content-encoding: gzip' /tmp/nexus-gz.hdr && echo "  ✓ 声明 Content-Encoding: gzip" || { echo "  ✗ 缺 gzip 头"; fail=1; }
GZ=$(wc -c < /tmp/nexus-gz.html)
RAW=$(curl -s "$BASE/" | wc -c)
echo "  原始 $RAW 字节 / gzip $GZ 字节（省 $(( (RAW-GZ)*100/RAW ))%）"
[ "$GZ" -lt "$RAW" ] && echo "  ✓ 压缩后更小" || { echo "  ✗ 未压缩"; fail=1; }
gzip -dc /tmp/nexus-gz.html > /tmp/nexus-unzipped.html 2>/dev/null
if cmp -s /tmp/nexus-unzipped.html /tmp/nexus-gz.html; then
  echo "  ✗ 解压失败"
  fail=1
else
  echo "  ✓ 解压成功（内容完整）"
fi

echo ""
echo "【ETag 协商缓存】"
ETAG=$(grep -i '^etag' /tmp/nexus-gz.hdr | tr -d '\r' | cut -d' ' -f2)
echo "  ETag=$ETAG"
C=$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $ETAG" "$BASE/")
check "带 If-None-Match → 304" "$C" "304"
S=$(curl -s -o /dev/null -w '%{size_download}' -H "If-None-Match: $ETAG" "$BASE/")
check "304 传输 0 字节" "$S" "0"

echo ""
if [ "$fail" = "0" ]; then echo "后端冒烟测试全部通过 ✓"; else echo "后端冒烟测试有失败项 ✗"; fi
exit $fail
