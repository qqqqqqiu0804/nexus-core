# -*- coding: utf-8 -*-
"""从会话记录里把用户粘贴的采集导出 JSON 抠出来。

用户把 JSON 直接粘在对话里（没落盘成文件）。会话记录 jsonl 的 message
记录里 content 是原文列表，从中切出那个对象。

⚠️ 重要：粘贴内容会被**截断**（实测 170 条只到第 85 条，且最后一条
play_url 被腰斩）。所以本脚本要：
  1. 按括号配对切完整对象；切不出来就走「降级模式」——
     逐条正则抠 item，丢掉最后那个不完整的。
  2. 明确报告「拿到几条 / 原声明几条」，别让人误以为拿全了。
"""
import json, re, sys
from pathlib import Path

SRC = Path(r"C:/Users/HXT/.workbuddy-ai/projects/"
           r"c-Users-HXT-WorkBuddy AI-2026-09-26-00-16-26/"
           r"e109297b-cfb1-4fd1-80e8-6d0ee08f0db3.jsonl")
MARK = '7684244498288839990'


def message_texts():
    for line in SRC.open(encoding='utf-8', errors='replace'):
        if MARK not in line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get('type') != 'message':
            continue
        c = rec.get('content')
        if isinstance(c, str):
            yield c
        elif isinstance(c, list):
            yield ''.join(p.get('text', '') for p in c if isinstance(p, dict))


def cut_object(txt):
    """从 "exported_at" 处向前找 '{'，括号配对切完整对象。失败返回 None。"""
    pos = txt.find('"exported_at"')
    if pos < 0:
        return None
    start = txt.rfind('{', 0, pos)
    if start < 0:
        return None
    depth = 0; in_str = False; esc = False
    for j in range(start, len(txt)):
        c = txt[j]
        if in_str:
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': in_str = False
        else:
            if c == '"': in_str = True
            elif c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(txt[start:j+1]), txt[start:j+1]
                    except Exception:
                        return None
    return None


ITEM_RE = re.compile(
    r'\{\s*"aweme_id"\s*:\s*"(\d{15,25})"\s*,(?P<body>.*?)\n\s*\}',
    re.S)


def salvage_items(txt):
    """降级：逐条抠 item，play_url 必须完整（以引号收尾）才算数。"""
    items = []
    for m in ITEM_RE.finditer(txt):
        aid = m.group(1)
        body = m.group('body')
        def field(name):
            mm = re.search(r'"%s"\s*:\s*"((?:[^"\\]|\\.)*)"' % name, body)
            return mm.group(1) if mm else ''
        def num(name):
            mm = re.search(r'"%s"\s*:\s*(-?\d+)' % name, body)
            return int(mm.group(1)) if mm else 0
        url = field('play_url')
        items.append({
            'aweme_id': aid,
            'desc': field('desc').replace('\\n', '\n'),
            'author': field('author'),
            'duration_ms': num('duration_ms'),
            'create_time': num('create_time'),
            'digg_count': num('digg_count'),
            'aweme_type': field('aweme_type'),
            'play_url': url,
            'url': field('url'),
        })
    return items


txt = max(message_texts(), key=len, default='')
if not txt:
    print('会话记录里找不到那条消息', file=sys.stderr); sys.exit(1)

declared = 0
m = re.search(r'"count"\s*:\s*(\d+)', txt)
if m:
    declared = int(m.group(1))

cut = cut_object(txt)
if cut:
    obj, _ = cut
    items = obj.get('items', [])
    mode = '完整解析'
    meta = {k: obj.get(k) for k in ('exported_at', 'version', 'source')}
else:
    items = salvage_items(txt)
    mode = '降级抠取（原文被截断）'
    meta = {'exported_at': '2026-09-26T09:26:00.155Z', 'version': '4.0.0',
            'source': 'nexus-core-collect'}

# 丢掉 play_url 不完整的
good = [i for i in items if i.get('play_url', '').startswith('http')
        and not i['play_url'].endswith(('&br=', '&bt=', '?', '&l=', '='))]
dropped = len(items) - len(good)

out = Path('favorites.json')
out.write_text(json.dumps({
    'exported_at': meta.get('exported_at'),
    'version': meta.get('version'),
    'source': meta.get('source'),
    'note': '从会话记录提取，原文被截断',
    'declared_count': declared,
    'count': len(good),
    'with_url': sum(1 for i in good if i.get('play_url')),
    'items': good,
}, ensure_ascii=False, indent=1), encoding='utf-8')

print('解析模式     : %s' % mode)
print('原声明条数   : %s' % (declared or '?'))
print('实际拿到     : %d 条（丢弃不完整 %d 条）' % (len(good), dropped))
print('含播放地址   : %d 条' % sum(1 for i in good if i.get('play_url')))
print('已写出       : %s' % out)
if declared and len(good) < declared:
    print()
    print('!! 少了 %d 条 —— 粘贴内容被截断，剩下那些不在会话记录里。' %
          (declared - len(good)))
