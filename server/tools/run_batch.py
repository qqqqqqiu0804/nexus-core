#!/usr/bin/env python3
"""批量处理：采集导出 → 下载 → 抽音频 → ASR → LLM → 入库

这是「浏览器采集 + 服务器处理」方案的服务器端。

用法：
    python3 run_batch.py <采集导出.json> [--collection 名字] [--limit 5]
                         [--summary-model qwen3.8-flash] [--dry-run]

设计要点：

1. **只下音频，不下视频**
   实测：18.8 分钟视频 = 116MB，抽音频后 9.3MB（12.5x）。
   但抖音只给视频流地址，所以必须「下载视频 → 立刻抽音频 → 删视频」。
   下载期间磁盘峰值 = 单个视频大小，处理完立即释放。

2. **每条独立 try，一条失败不影响其他**
   长跑任务最怕「跑到第 30 条崩了，前 29 条白跑」。
   所以每条都包 try，失败记 status=failed 继续下一条。

3. **花过的钱必须落库**
   转写一到手立刻入库，后面 LLM 挂了也不影响已花的 ASR 费用。

4. **地址有时效**
   采集导出里的 play_url 通常几小时内有效。
   过期会 403，脚本会提示重新采集，而不是死循环重试。
"""

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from video_db import VideoDB          # noqa: E402
import douyin_pipeline as P           # noqa: E402

DB_PATH = HERE.parent / 'videos.db'
ASR_TMP = Path('/var/www/asrtmp')
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')


def download_audio(url, workdir, timeout=300):
    """下载视频 → 抽音频 → 删视频。返回音频路径。

    为什么不用 yt-dlp：实测 yt-dlp 对抖音必 403（它走详情接口，需要签名）。
    而 CDN 直链**不需要签名**，curl 带上 Referer 就能下。
    """
    mp4 = workdir / 'v.mp4'
    m4a = workdir / 'v.m4a'

    p = subprocess.run([
        'curl', '-s', '-L', '--max-time', str(timeout),
        '-o', str(mp4),
        '-H', 'User-Agent: ' + UA,
        '-H', 'Referer: https://www.douyin.com/',
        url,
    ], capture_output=True, text=True)

    if not mp4.exists() or mp4.stat().st_size < 10000:
        # 分情况给提示，别让用户猜
        raise RuntimeError('下载失败（%d 字节）—— 地址可能已过期，请重新采集'
                           % (mp4.stat().st_size if mp4.exists() else 0))

    # 抽音频：体积小 12 倍，ASR 上传也快
    r = subprocess.run([
        'ffmpeg', '-y', '-i', str(mp4), '-vn',
        '-c:a', 'aac', '-b:a', '64k', str(m4a),
    ], capture_output=True, text=True)

    if not m4a.exists() or m4a.stat().st_size < 1000:
        raise RuntimeError('抽音频失败：%s' % (r.stderr or '')[-200:])

    vsecs = 0
    try:
        pr = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                             'format=duration', '-of', 'default=nw=1:nk=1',
                             str(mp4)], capture_output=True, text=True)
        vsecs = float((pr.stdout or '0').strip() or 0)
    except Exception:
        pass

    # 立刻删视频，省磁盘
    mp4.unlink(missing_ok=True)
    return m4a, vsecs


def main():
    ap = argparse.ArgumentParser(description='批量跑采集到的收藏')
    ap.add_argument('json_file', help='篡改猴采集导出的 JSON')
    ap.add_argument('--collection', default='', help='收藏夹名')
    ap.add_argument('--db', default=str(DB_PATH))
    ap.add_argument('--limit', type=int, default=0, help='最多处理几条（0=全部）')
    ap.add_argument('--summary-model', default='qwen3.8-flash')
    ap.add_argument('--asr-model', default='paraformer-v2')
    ap.add_argument('--asr-public', default=P.ASR_PUBLIC_BASE)
    ap.add_argument('--only-new', action='store_true', default=True,
                    help='跳过已有转写的（默认开）')
    ap.add_argument('--force', action='store_true', help='已有转写也重跑')
    ap.add_argument('--dry-run', action='store_true', help='只列出来，不跑')
    ap.add_argument('--delay', type=float, default=2.0, help='每条之间间隔秒')
    ap.add_argument('--budget-seconds', type=int, default=P.ASR_FREE_SECONDS_PER_MONTH)
    args = ap.parse_args()

    key = os.environ.get('DASHSCOPE_API_KEY', '').strip()
    if not key:
        print('错误：需要 DASHSCOPE_API_KEY', file=sys.stderr)
        return 2

    data = json.loads(Path(args.json_file).read_text(encoding='utf-8'))
    items = data.get('items', [])
    print('读取 %s' % Path(args.json_file).name)
    print('  导出时间: %s' % data.get('exported_at', '?'))
    print('  条目 %d 条，其中含播放地址 %d 条' %
          (len(items), data.get('with_url', sum(1 for i in items if i.get('play_url')))))
    print()

    # 只要带地址的
    usable = [i for i in items if i.get('play_url') and i.get('aweme_id')]
    no_url = len(items) - len(usable)
    if no_url:
        print('  跳过 %d 条没有播放地址的（图文类，无音频可转写）' % no_url)

    db = VideoDB(args.db)

    # 先入库元信息（不花钱，保证不丢）
    meta_only = [{k: v for k, v in i.items() if k != 'play_url'} for i in usable]
    r = db.import_favorites(meta_only, collection=args.collection)
    print('  元信息入库: 新增 %d / 已有 %d' % (r['new'], r['existing']))
    print()

    # 挑出要跑的
    todo = []
    skipped = 0
    for i in usable:
        if not args.force and db.get_transcript(i['aweme_id']):
            skipped += 1
            continue
        todo.append(i)
    if args.limit:
        todo = todo[:args.limit]

    print('待处理 %d 条，跳过 %d 条（已有转写，不重复花钱）' %
          (len(todo), skipped))
    if not todo:
        print('\n没有要跑的。所有条目都已有转写。')
        db.close()
        return 0

    # 成本闸门
    est = sum((i.get('duration_ms') or 120000) / 1000 for i in todo)
    month_used = db.stats()['asr_seconds_total']
    print('\n【成本】本月已用 %.2f 小时，本批预估 %.2f 小时' %
          (month_used / 3600, est / 3600))
    if month_used + est > args.budget_seconds:
        print('⚠️  本批会超出预算 %.1f 小时（免费额度 %d 小时/月）' %
              (args.budget_seconds / 3600, args.budget_seconds / 3600))
        print('    超出部分按 %.1f 元/小时计费' % P.ASR_PRICE_PER_HOUR)
        print('    加 --budget-seconds 调整上限，或 --limit 减少条数')
    print()

    if args.dry_run:
        print('（--dry-run，不实际跑）')
        for i in todo[:20]:
            print('  %s  %s  %s' % (i['aweme_id'],
                                    '%5.1f分' % ((i.get('duration_ms') or 0) / 60000),
                                    (i.get('desc') or '')[:40]))
        db.close()
        return 0

    # ---- 开跑 ----
    ok_n = fail_n = 0
    for idx, it in enumerate(todo, 1):
        aid = it['aweme_id']
        desc = (it.get('desc') or '')[:34]
        dur_min = (it.get('duration_ms') or 0) / 60000
        print('[%d/%d] %s  %.1f分  %s' % (idx, len(todo), aid, dur_min, desc))

        work = Path(tempfile.mkdtemp(prefix='dy-b-'))
        public = None
        try:
            audio, vsecs = download_audio(it['play_url'], work)
            print('       下载+抽音频 OK（%.1f MB）' % (audio.stat().st_size / 1024 / 1024))

            token = secrets.token_hex(12)
            public = ASR_TMP / (token + '.m4a')
            public.write_bytes(audio.read_bytes())
            public_url = args.asr_public.rstrip('/') + '/' + token + '.m4a'

            text, secs = P.transcribe(audio, key, args.asr_public,
                                      model=args.asr_model)
            print('       ASR OK（%.0f 秒计费，%d 字）' % (secs, len(text)))

            # ★ 立刻存转写 —— 后面 LLM 挂了也不丢已花的钱
            db.save_transcript(aid, text, secs, asr_model=args.asr_model,
                               duration_ms=it.get('duration_ms') or 0)

            s = P.summarize(text, key, [args.summary_model])
            print('       摘要 OK（%s）：%s' % (s.get('_model'),
                                               (s.get('point') or '')[:50]))
            db.save_summary(aid, s.get('point', ''), s.get('points', []),
                            model=s.get('_model', ''), tags=s.get('tags', []))
            ok_n += 1

        except Exception as e:
            fail_n += 1
            print('       ❌ %s' % str(e)[:180])
            try:
                db.upsert_video(aid, status='failed')
            except Exception:
                pass
        finally:
            if public:
                public.unlink(missing_ok=True)
            shutil.rmtree(work, ignore_errors=True)

        if idx < len(todo):
            time.sleep(args.delay)

    st = db.stats()
    print('\n=== 完成 ===')
    print('成功 %d / 失败 %d' % (ok_n, fail_n))
    print('库: 视频 %d / 转写 %d / 摘要 %d' %
          (st['videos'], st['transcribed'], st['summarized']))
    print('ASR 累计 %.2f 小时（免费额度 %d 小时/月）' %
          (st['asr_seconds_total'] / 3600, args.budget_seconds / 3600))
    db.close()
    return 0 if fail_n == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
