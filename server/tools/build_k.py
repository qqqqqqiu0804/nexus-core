"""从 Netscape cookie 文件拼出 f2 的 -k 参数字符串

踩过的坑：用 `awk` 拼串时第一项会带一个空键（`=; ...`），
导致 f2 报 `Illegal header value b'=; ...'`。
用 Python 老老实实拼，并且过滤空键。

用法: python3 build_k.py <netscape文件>
"""
import sys
from pathlib import Path

p = Path(sys.argv[1] if len(sys.argv) > 1 else '/root/nexus-core/server/.douyin-cookie.txt')
parts = []
for line in p.read_text(encoding='utf-8').splitlines():
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    f = line.split('\t')
    if len(f) < 7:
        continue
    name, value = f[5].strip(), f[6].strip()
    if not name or not value:          # ★ 关键：空键直接跳过
        continue
    parts.append('%s=%s' % (name, value))

s = '; '.join(parts)
print(s, end='')
