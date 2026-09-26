#!/usr/bin/env python3
"""video_db 的测试 —— 重点是「复用」这个核心承诺

用户明确要求：「跑完的要存数据库，可以重复利用，下次就不用重复跑同一条视频」

所以最关键的不变量是：
  **已经转写过的，绝不能再花一次 ASR 的钱。**

这个测试就是要证明这一点，而不是只测"能不能写进去"。
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from video_db import VideoDB

passed = failed = 0


def ok(name, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'  [OK] {name}' + (f'  {extra}' if extra else ''))
    else:
        failed += 1
        print(f'  [FAIL] {name}' + (f'  {extra}' if extra else ''))


tmp = Path(tempfile.mkdtemp()) / 'test.db'

print('=== video_db 测试 ===')

# ---------------- 1. 基本读写 ----------------
db = VideoDB(tmp)
db.upsert_video('V001', desc='测试视频一', author='作者A',
                duration_ms=73000, collection='对自己好')
r = db.conn.execute('SELECT * FROM videos WHERE aweme_id=?', ('V001',)).fetchone()
ok('能写入视频元信息', r is not None and r['desc'] == '测试视频一')
ok('初始状态是 pending', r['status'] == 'pending', r['status'])

# ---------------- 2. 核心：转写复用 ----------------
ok('未转写时 get_transcript 返回 None',
   db.get_transcript('V001') is None)

db.save_transcript('V001', '这是转写出来的文稿内容', asr_seconds=73,
                   asr_model='paraformer-v2', duration_ms=73000)

t = db.get_transcript('V001')
ok('转写后能取回', t == '这是转写出来的文稿内容')
ok('状态变成 transcribed',
   db.conn.execute('SELECT status FROM videos WHERE aweme_id=?',
                   ('V001',)).fetchone()['status'] == 'transcribed')

# ★ 这条是核心：调用方靠 get_transcript 非 None 来跳过 ASR
ok('★ 已有转写 → 下次能跳过 ASR（省钱的关键）', db.get_transcript('V001') is not None)

# ---------------- 3. 重复导入不覆盖转写 ----------------
# 场景：用户又导出了一次收藏夹，同一条视频还在里面
db.import_favorites([
    {'aweme_id': 'V001', 'desc': '标题改了', 'author': '作者A',
     'duration_ms': 73000, 'url': 'https://x/1'},
], collection='对自己好')

ok('重复导入后转写仍在（没被覆盖）',
   db.get_transcript('V001') == '这是转写出来的文稿内容')
ok('重复导入会更新元信息',
   db.conn.execute('SELECT desc FROM videos WHERE aweme_id=?',
                   ('V001',)).fetchone()['desc'] == '标题改了')

# ---------------- 4. 摘要存储 ----------------
db.save_summary('V001', '用拒绝守住边界，关系才更真实',
                ['接纳自己的需要', '练习直接说不', '留下的更真实'],
                model='qwen3.8-flash')
s = db.get_summary('V001')
ok('能存摘要', s and s['point'] == '用拒绝守住边界，关系才更真实')
ok('要点是数组', isinstance(s['points'], list) and len(s['points']) == 3)
ok('记下了模型名', s['model'] == 'qwen3.8-flash')
ok('状态变成 summarized',
   db.conn.execute('SELECT status FROM videos WHERE aweme_id=?',
                   ('V001',)).fetchone()['status'] == 'summarized')

# ---------------- 5. 换模型重跑：ASR 不该重跑 ----------------
old = db.get_transcript('V001')
db.save_summary('V001', '换个模型重新总结的观点',
                ['要点1'], model='glm-5.3')
ok('换模型重跑摘要后，转写没变（ASR 不用重跑）',
   db.get_transcript('V001') == old)
ok('摘要已更新为新模型的结果',
   db.get_summary('V001')['model'] == 'glm-5.3')

# ---------------- 6. todo 只列没做完的 ----------------
db.upsert_video('V002', desc='第二条', collection='对自己好')
db.upsert_video('V003', desc='第三条', collection='猛学')
todo = db.todo()
ids = [t['aweme_id'] for t in todo]
ok('todo 不含已完成的', 'V001' not in ids, str(ids))
ok('todo 含未完成的', 'V002' in ids and 'V003' in ids, str(ids))
ok('todo 能按收藏夹过滤',
   [t['aweme_id'] for t in db.todo(collection='猛学')] == ['V003'])

# ---------------- 7. 批量导入 ----------------
db2 = VideoDB(Path(tempfile.mkdtemp()) / 'b.db')
res = db2.import_favorites([
    {'aweme_id': 'A1', 'desc': 'x'}, {'aweme_id': 'A2', 'desc': 'y'},
    {'aweme_id': 'A3', 'desc': 'z'},
], collection='对自己好')
ok('批量导入计数正确', res['new'] == 3, str(res))
res2 = db2.import_favorites([
    {'aweme_id': 'A1', 'desc': 'x'}, {'aweme_id': 'A4', 'desc': 'w'},
], collection='对自己好')
ok('二次导入识别出已有', res2['new'] == 1 and res2['existing'] == 1, str(res2))

# ---------------- 8. 统计 ----------------
st = db.stats()
ok('统计：视频总数', st['videos'] == 3, str(st['videos']))
ok('统计：转写数', st['transcribed'] == 1, str(st['transcribed']))
ok('统计：摘要数', st['summarized'] == 1, str(st['summarized']))
ok('统计：ASR 累计秒数', st['asr_seconds_total'] == 73,
   str(st['asr_seconds_total']))
ok('统计：收藏夹分布', len(st['collections']) == 2, str(st['collections']))

# ---------------- 9. 边界 ----------------
try:
    db.upsert_video('', desc='空 id')
    ok('空 aweme_id 应报错', False)
except ValueError:
    ok('空 aweme_id 会报错（不静默写入脏数据）', True)

db.close()
print()
print(f'全部通过（{passed} 项）' if failed == 0
      else f'{passed} 通过 / {failed} 失败')
sys.exit(0 if failed == 0 else 1)
