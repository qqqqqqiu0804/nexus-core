#!/usr/bin/env python3
"""验证 pipeline 的「不重复跑」逻辑 —— 不联网、不花钱

测什么：
    把 fetch_meta / fetch_audio / transcribe / summarize 全换成假的，
    数它们被调用了多少次。然后断言：
      - 第一次跑：下载 1 次、ASR 1 次、摘要 1 次
      - 第二次跑同一条：**下载 0 次、ASR 0 次**、摘要 0 次（同模型命中缓存）
      - 换摘要模型再跑：下载 0 次、ASR 0 次、摘要 1 次  ← 这是省钱的核心
      - --force：强制重跑，ASR 又跑一次
"""

import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import douyin_pipeline as P     # noqa: E402
from video_db import VideoDB    # noqa: E402

URL = 'https://www.douyin.com/video/7689106012851254514'
AWEME = '7689106012851254514'

# ---- 计数器 ----
CALLS = {'meta': 0, 'audio': 0, 'asr': 0, 'llm': 0}


def fake_meta(url, cookies, ytdlp):
    CALLS['meta'] += 1
    return {'title': '假标题', 'uploader': '假作者', 'duration': 60}


def fake_audio(url, cookies, ytdlp, workdir):
    CALLS['audio'] += 1
    f = workdir / 'audio.m4a'
    f.write_bytes(b'\x00' * 1024)
    return f


def fake_transcribe(audio, api_key, public_base, model='paraformer-v2'):
    CALLS['asr'] += 1
    return ('这是一段假的转写文本，用来验证缓存逻辑。' * 5, 60)


def fake_summarize(transcript, api_key, models):
    CALLS['llm'] += 1
    return {'point': '假观点', 'points': ['要点一', '要点二'],
            'tags': ['心理', '成长'], '_model': models[0]}


# 打桩
P.fetch_meta = fake_meta
P.fetch_audio = fake_audio
P.transcribe = fake_transcribe
P.summarize = fake_summarize
# 绕过公网目录检查（假的 transcribe 不需要它）
P.ASR_TMP_DIR = str(HERE)


class Args:
    cookies = None
    ytdlp = 'python'
    meta_only = False
    transcript_only = False
    asr_public = 'http://x/'
    asr_model = 'paraformer-v2'
    summary_models = ['qwen3.8-flash']
    force = False
    db = None


pass_n = fail_n = 0


def ok(name, cond, extra=''):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print('  [OK] ' + name + ('  ' + str(extra) if extra else ''))
    else:
        fail_n += 1
        print('  [XX] ' + name + ('  ' + str(extra) if extra else ''))


def reset():
    for k in CALLS:
        CALLS[k] = 0


def main():
    import tempfile
    db_path = Path(tempfile.mkdtemp()) / 'reuse-test.db'

    print('=== pipeline 复用逻辑测试 ===\n')

    # ---------- 第 1 次：全新，什么都得跑 ----------
    reset()
    a = Args()
    a.db = VideoDB(str(db_path))
    r1 = P.process_one(URL, a, 'fake-key')
    print('第 1 次跑（全新）')
    ok('成功', r1['ok'], r1.get('error', ''))
    ok('不是缓存', r1['cached'] is False)
    ok('下载 1 次', CALLS['audio'] == 1, CALLS['audio'])
    ok('ASR 1 次', CALLS['asr'] == 1, CALLS['asr'])
    ok('LLM 1 次', CALLS['llm'] == 1, CALLS['llm'])
    ok('转写已入库', a.db.get_transcript(AWEME) is not None)
    ok('摘要已入库', a.db.get_summary(AWEME) is not None)
    ok('状态是 summarized', a.db.get_video(AWEME)['status'] == 'summarized')
    ok('tags 写进 videos 了', a.db.get_video(AWEME)['tags'] == '["心理", "成长"]')

    # ---------- 第 2 次：完全相同的请求 → 应该全命中 ----------
    reset()
    b = Args()
    b.db = VideoDB(str(db_path))
    r2 = P.process_one(URL, b, 'fake-key')
    print('\n第 2 次跑（同一条，同模型）')
    ok('成功', r2['ok'], r2.get('error', ''))
    ok('★ 标记为命中缓存', r2['cached'] is True)
    ok('★ 下载 0 次（省了）', CALLS['audio'] == 0, CALLS['audio'])
    ok('★ ASR 0 次（省钱的关键）', CALLS['asr'] == 0, CALLS['asr'])
    ok('★ LLM 0 次（摘要也命中了）', CALLS['llm'] == 0, CALLS['llm'])
    ok('★ 本次 ASR 计费 0 秒', r2['asr_seconds'] == 0, r2['asr_seconds'])
    ok('结果仍然完整（观点回来了）', r2.get('point') == '假观点', r2.get('point'))
    ok('要点也回来了', len(r2.get('points') or []) == 2)

    # ---------- 第 3 次：换摘要模型 → ASR 必须不重跑 ----------
    reset()
    c = Args()
    c.summary_models = ['deepseek-v4.1-flash']
    c.db = VideoDB(str(db_path))
    r3 = P.process_one(URL, c, 'fake-key')
    print('\n第 3 次跑（换摘要模型）')
    ok('成功', r3['ok'], r3.get('error', ''))
    ok('★ 下载 0 次', CALLS['audio'] == 0, CALLS['audio'])
    ok('★★ ASR 0 次 —— 换模型不用重付 ASR（设计目标达成）',
       CALLS['asr'] == 0, CALLS['asr'])
    ok('LLM 跑了 1 次（新模型要重算）', CALLS['llm'] == 1, CALLS['llm'])
    ok('摘要模型记为新的', r3['summary_model'] == 'deepseek-v4.1-flash',
       r3['summary_model'])
    ok('新摘要已入库', c.db.get_summary(AWEME)['model'] == 'deepseek-v4.1-flash')
    ok('★ 但转写文本没变（还是原来那份）',
       c.db.get_transcript(AWEME).startswith('这是一段假的转写文本'))

    # ---------- 第 4 次：--force 必须真的重跑 ----------
    reset()
    d = Args()
    d.force = True
    d.db = VideoDB(str(db_path))
    r4 = P.process_one(URL, d, 'fake-key')
    print('\n第 4 次跑（--force 强制重跑）')
    ok('成功', r4['ok'], r4.get('error', ''))
    ok('下载 1 次', CALLS['audio'] == 1, CALLS['audio'])
    ok('ASR 1 次（强制重跑确实重跑了）', CALLS['asr'] == 1, CALLS['asr'])
    ok('不是缓存', r4['cached'] is False)

    # ---------- 第 5 次：meta-only 和 transcript-only ----------
    reset()
    e = Args()
    e.meta_only = True
    e.db = VideoDB(str(db_path))
    r5 = P.process_one(URL, e, 'fake-key')
    print('\n第 5 次跑（--meta-only）')
    ok('成功', r5['ok'])
    ok('★ ASR 0 次（只取元数据）', CALLS['asr'] == 0)

    reset()
    f = Args()
    f.transcript_only = True
    f.db = VideoDB(str(db_path))
    r6 = P.process_one(URL, f, 'fake-key')
    print('\n第 6 次跑（--transcript-only，缓存命中）')
    ok('成功', r6['ok'])
    ok('★ ASR 0 次（缓存里有转写）', CALLS['asr'] == 0)
    ok('★ LLM 0 次（不该做摘要）', CALLS['llm'] == 0)
    ok('转写文本回来了', r6.get('transcript', '').startswith('这是一段假的转写文本'))

    # ---------- 第 7 次：没有 DB 的情况不能崩 ----------
    reset()
    g = Args()
    g.db = None
    r7 = P.process_one(URL, g, 'fake-key')
    print('\n第 7 次跑（不用 DB）')
    ok('成功', r7['ok'], r7.get('error', ''))
    ok('ASR 跑了 1 次（没有缓存可用）', CALLS['asr'] == 1)
    ok('不标记缓存', r7['cached'] is False)

    # ---------- aweme_id 提取 ----------
    print('\naweme_id 提取')
    ok('标准 video 链接', P.extract_aweme_id(
        'https://www.douyin.com/video/7689106012851254514') == AWEME)
    ok('note 链接', P.extract_aweme_id(
        'https://www.douyin.com/note/7689106012851254514') == AWEME)
    ok('modal_id 形式', P.extract_aweme_id(
        'https://www.douyin.com/user/MS4w?modal_id=7689106012851254514') == AWEME)
    ok('短链抠不出（返回空，不瞎猜）', P.extract_aweme_id(
        'https://v.douyin.com/iABCdef/') == '')
    ok('空值不崩', P.extract_aweme_id('') == '' and P.extract_aweme_id(None) == '')

    # ---------- DB 统计 ----------
    h = VideoDB(str(db_path))
    s = h.stats()
    print('\n数据库统计')
    ok('视频 1 条', s['videos'] == 1, s['videos'])
    ok('转写 1 条', s['transcribed'] == 1, s['transcribed'])
    ok('摘要 1 条', s['summarized'] == 1, s['summarized'])
    h.close()

    print('\n' + ('全部通过' if fail_n == 0 else '有失败') +
          '（%d 项，%d 通过 / %d 失败）' % (pass_n + fail_n, pass_n, fail_n))
    return 0 if fail_n == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
