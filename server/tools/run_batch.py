#!/usr/bin/env python3
"""批量处理：采集导出 → 下载 → 抽音频 → ASR → LLM → 入库

这是「浏览器采集 + 服务器处理」方案的服务器端。

用法：
    python3 run_batch.py <采集导出.json> [--collection 名字] [--limit 5]
                         [--summary-model qwen3.8-flash] [--dry-run]

设计要点：

1. **不落地视频文件，ffmpeg 直接从网络流抽音频**
   抖音只给视频流地址（`mime_type=video_mp4`），拿不到纯人声轨道，
   所以「直接下音频」在抖音这儿不存在。但**不必把视频先存下来**：
   ffmpeg 自己就是下载器，`-i <URL> -vn` 边读边丢视频数据，只留音频。
   实测 18.8 分钟视频 = 116MB，产出音频 9.3MB，**全程磁盘零峰值**。
   改之前是「curl 下完整 116MB → 写盘 → 再读回 → 抽音频」，多一轮 I/O。

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
from filter_noise import classify     # noqa: E402

DB_PATH = HERE.parent / 'videos.db'
ASR_TMP = Path('/var/www/asrtmp')
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')


def extract_audio(url, workdir, timeout=300, clip=None):
    """ffmpeg 直接从 CDN 流里抽音频 —— 视频数据不落盘。

    url   : CDN 直链（video_mp4 流，含人声）
    clip  : (start_sec, duration_sec) 只处理片段，None = 全部
            用途：长视频可以只转写前 N 分钟先看效果，省钱。

    返回 (音频路径, 音频时长秒, 拉取字节数)。

    为什么不用 yt-dlp：实测 yt-dlp 对抖音必 403（它走详情接口，需要签名）。
    而 CDN 直链**不需要签名**，带上 UA + Referer 就能拿（实测支持 Range，206）。

    为什么不再 curl 落盘：抖音的音频和画面在同一条流里，要拿到人声
    就必须经过这条流。但「经过」不等于「存下来」—— ffmpeg 的
    http 输入是流式的，`-vn` 读到音频轨结束就收工，视频字节边读边丢。
    结果：磁盘占用从「峰值 116MB」降到「全程 ~9MB」，也省掉一轮写读 I/O。
    """
    m4a = workdir / 'v.m4a'

    cmd = [
        'ffmpeg', '-y',
        '-nostdin',                      # 别等 stdin，否则被 ssh 挂住
        '-user_agent', UA,               # ffmpeg 原生支持，不用额外头文件
        '-headers', 'Referer: https://www.douyin.com/\r\n',
        '-rw_timeout', str(timeout * 1000 * 1000),   # 微秒；网络卡死时能退出
    ]
    if clip:
        cmd += ['-ss', str(clip[0]), '-t', str(clip[1])]
    cmd += ['-i', url, '-vn', '-c:a', 'aac', '-b:a', '64k',
            '-movflags', '+faststart', str(m4a)]

    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 60)

    if not m4a.exists() or m4a.stat().st_size < 1000:
        # 把 ffmpeg 的真实报错挖出来。403 / 过期在这里能看出来，
        # 别吞掉错误信息让调用方猜。
        err = (r.stderr or '')
        hint = ''
        for line in err.splitlines():
            if any(k in line for k in ('403', 'Forbidden', '404', 'Not Found',
                                       'Server returned', 'Invalid data')):
                hint = line.strip()[:160]
                break
        last = err.strip().splitlines()[-1][:200] if err.strip() else '无输出'
        raise RuntimeError('抽音频失败%s：%s' %
                           ('（%s）' % hint if hint else '', last))

    secs = probe_duration(m4a)
    try:
        size = m4a.stat().st_size
    except OSError:
        size = 0
    return m4a, secs, size


def probe_duration(path):
    """读媒体时长（秒）。取不到返回 0 —— 不瞎猜。"""
    try:
        pr = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                             'format=duration', '-of', 'default=nw=1:nk=1',
                             str(path)], capture_output=True, text=True, timeout=30)
        return float((pr.stdout or '0').strip() or 0)
    except Exception:
        return 0


# ★★ 单位陷阱：采集脚本导出的 duration_ms 实际是**微秒** ★★
#
# 实测（用 ffprobe 对真实 CDN 流核对，三条全中）：
#   字段 30434000 → 真实 30.43 秒   （比值 1000000）
#   字段 52167000 → 真实 52.17 秒   （比值 1000000）
#   字段 109400000 → 真实 109.40 秒 （比值 1000000）
#
# 名字叫 _ms 但单位是 _us。按毫秒读会放大 1000 倍：
# 一条 30 秒的短视频被当成 8.5 小时，成本闸门直接失控。
#
# ★ 踩过的二次坑：我第一版写了「量级判断」——
#   `if v > 3*3600*1000: v //= 1000`，想法是"超过 3 小时就肯定是微秒"。
#   错的。15134000µs = 15.1 秒，但它 < 10,800,000 这个阈值，
#   于是被当成 15134 毫秒留下，估算直接虚高到 6.94 小时。
#   **单位是字段的属性，不是数值的属性** —— 不能靠量级猜，
#   要么信字段、要么实测量。这里选择：一律按微秒，再用量级做合理性校验。
US_PER_MS = 1000
MAX_PLAUSIBLE_SEC = 3 * 3600     # 短视频不可能超过 3 小时


def norm_duration_ms(raw):
    """把采集来的 duration 归一化成毫秒。

    采集脚本的 duration_ms 实测单位是微秒，统一 //1000 得到毫秒。
    之后做一次合理性校验：若换算后仍 > 3 小时，说明单位假设错了，
    宁可返回 0（下游会按默认 2 分钟估），也不要让一个虚高的数字
    把成本闸门骗过去 —— 钱的事，宁小不大。
    """
    try:
        v = int(raw or 0)
    except Exception:
        return 0
    if v <= 0:
        return 0
    ms = v // US_PER_MS
    if ms > MAX_PLAUSIBLE_SEC * 1000:
        return 0
    return ms


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
    ap.add_argument('--clip', default='',
                    help='只处理前 N 秒，如 --clip 300（省钱试效果用）')
    ap.add_argument('--keep-noise', action='store_true',
                    help='不过滤噪音，处理全部（默认会先过滤）')
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

    # ★ 单位归一化：采集脚本的 duration_ms 实际是微秒（实测比值 1000000）。
    # 在这里统一改掉，下游（成本估算、打印、写库）就都不用再操心。
    fixed = 0
    for i in items:
        raw = i.get('duration_ms') or 0
        n = norm_duration_ms(raw)
        if n != raw:
            fixed += 1
        i['duration_ms'] = n
    if fixed:
        print('  ⚠ 修正 %d 条时长单位（采集脚本给的是微秒，已按毫秒归一）'
              % fixed)
    print()

    # 只要带地址的
    usable = [i for i in items if i.get('play_url') and i.get('aweme_id')]
    no_url = len(items) - len(usable)
    if no_url:
        print('  跳过 %d 条没有播放地址的（图文类，无音频可转写）' % no_url)

    # ★ 噪音过滤 —— 必须在花钱之前跑
    #
    # 教训：第一版没接过滤器，直接跑前 5 条，结果 2 条 ASR 失败。
    # 一看那 2 条正是演唱会内容 —— filter_noise 早就把它们标成
    # 「强特征词: 演唱会」了。**过滤器就是为省这笔钱存在的，
    # 不接上就等于白写。**
    dropped_noise = []
    if not args.keep_noise:
        kept = []
        for i in usable:
            v = classify(i)
            if v['keep']:
                kept.append(i)
            else:
                dropped_noise.append((i, v['reason']))
        usable = kept
    if dropped_noise:
        print('  过滤噪音 %d 条（不花钱、不转写）：' % len(dropped_noise))
        for i, why in dropped_noise[:12]:
            print('    - %s | %s' % (why, (i.get('desc') or '')[:36]))
        if len(dropped_noise) > 12:
            print('    ... 另有 %d 条' % (len(dropped_noise) - 12))
    print()

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
    #
    # 估算依据：优先用库里的 duration_ms（已归一化），没有就按 2 分钟猜。
    # 注意 ASR **按真实音频时长计费**，和视频声明时长可能差几秒，
    # 所以这里只当"预估值"，最终以 DashScope 返回的 usage.duration 为准
    # （那是真正记账用的数字）。
    est = sum((i.get('duration_ms') or 120000) / 1000 for i in todo)
    month_used = db.stats()['asr_seconds_total']
    print('\n【成本】本月已用 %.2f 小时，本批预估 %.2f 小时' %
          (month_used / 3600, est / 3600))
    if month_used + est > args.budget_seconds:
        over = (month_used + est - args.budget_seconds) / 3600
        print('⚠️  超出预算 %.2f 小时，超出部分按 %.1f 元/小时计费（约 %.1f 元）'
              % (over, P.ASR_PRICE_PER_HOUR, over * P.ASR_PRICE_PER_HOUR))
        print('    加 --budget-seconds 调整上限，或 --limit 减少条数')
    else:
        left = (args.budget_seconds - month_used - est) / 3600
        print('    免费额度够用，跑完还剩约 %.2f 小时' % left)
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
            clip = (0, float(args.clip)) if args.clip else None
            audio, asecs, abytes = extract_audio(it['play_url'], work, clip=clip)
            print('       抽音频 OK（%.1f MB / %.1f 分钟%s）' %
                  (abytes / 1024 / 1024, asecs / 60,
                   '，只取前 %s 秒' % args.clip if clip else ''))

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
