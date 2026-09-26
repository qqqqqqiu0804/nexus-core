#!/usr/bin/env python3
"""
抖音收藏视频 → 文稿 → 观点分析 流水线。

用法（在服务器上跑）：
    python3 pipeline.py --cookies /root/nexus-core/server/.douyin-cookies.txt \
                        --url "https://v.douyin.com/xxxxx/"

设计要点：
1. **只依赖两个外部服务**：yt-dlp（下载）+ DashScope（ASR/LLM）。都不需要 GPU。
2. **失败必须显式暴露**：任何一步失败都写清楚是哪一步、为什么，
   不允许「静默返回空摘要」——那会让用户以为视频没内容，而不是工具坏了。
3. **视频不留存**：转写完立即删掉 mp4/m4a。服务器带宽和磁盘都不宽裕
   （出网实测 424 KB/s），留着只会拖垮工作台。
4. **限速**：批量时串行 + 间隔，避免触发抖音风控。

环境变量：
    DASHSCOPE_API_KEY   阿里云 DashScope key（ASR + LLM 都用它）
    YTDLP                yt-dlp 可执行路径（默认 tools/venv/bin/python -m yt_dlp）
"""
import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_YTDLP = HERE / 'venv' / 'bin' / 'python'
DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1'

# 临时音频托管目录（nginx 静态托管，公网可读）。
# 为什么必须这样：Paraformer 官方明确「不支持 Base64 或本地路径」，
# 音频必须是公网 HTTP URL。文件名用随机 token，转写完立即删除。
ASR_TMP_DIR = '/var/www/asrtmp'
ASR_PUBLIC_BASE = 'https://nexus.kotete.xyz/asrtmp'


# ---------- 通用：带超时的 HTTP JSON ----------
def post_json(url, payload, api_key, timeout=180, async_header=None):
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }
    # 提交异步任务必须显式 enable，否则会被当成同步请求拒绝
    if async_header:
        headers['X-DashScope-Async'] = async_header
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers=headers,
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')[:500]
        raise RuntimeError(f'HTTP {e.code}: {body}') from None


def get_json(url, api_key, timeout=60):
    req = urllib.request.Request(
        url,
        headers={'Authorization': f'Bearer {api_key}'},
        method='GET',
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')[:500]
        raise RuntimeError(f'HTTP {e.code}: {body}') from None


# ---------- 步骤 1：取元数据 ----------
def fetch_meta(url, cookies, ytdlp_py):
    """拿标题/作者/时长。不下视频。"""
    cmd = [str(ytdlp_py), '-m', 'yt_dlp', '--no-warnings',
           '--skip-download', '--dump-json']
    if cookies:
        cmd += ['--cookies', str(cookies)]
    cmd.append(url)
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        err = (p.stderr or '').strip().split('\n')[-1] if p.stderr else '未知错误'
        # 这个报错要原样透出：它是最可能发生、也最需要用户处理的失败
        if 'cookie' in err.lower():
            raise RuntimeError(
                f'抖音要求有效 cookie，当前 cookie 不可用或已过期。\n原始报错：{err}')
        raise RuntimeError(f'yt-dlp 取元数据失败：{err}')
    try:
        return json.loads(p.stdout.strip().split('\n')[0])
    except Exception:
        raise RuntimeError('yt-dlp 输出的 JSON 解析失败')


# ---------- 步骤 2：下载音频 ----------
def fetch_audio(url, cookies, ytdlp_py, workdir):
    """只下音频（体积最小）。返回音频文件路径。"""
    out_tpl = str(workdir / 'audio.%(ext)s')
    cmd = [str(ytdlp_py), '-m', 'yt_dlp', '--no-warnings',
           '-f', 'bestaudio/best',
           '-x', '--audio-format', 'm4a', '--audio-quality', '5',
           '-o', out_tpl]
    if cookies:
        cmd += ['--cookies', str(cookies)]
    cmd.append(url)
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    files = list(workdir.glob('audio.*'))
    if p.returncode != 0 or not files:
        err = (p.stderr or '').strip().split('\n')[-1] if p.stderr else '未知错误'
        if 'cookie' in err.lower():
            raise RuntimeError(f'下载被拒（cookie 问题）：{err}')
        raise RuntimeError(f'yt-dlp 下载失败：{err}')
    return files[0]


# ---------- 步骤 3：ASR 转写 ----------
#
# ⚠️ 2026-09-26 重要修正：我第一版写错了接口形态。
#
# 查阿里云官方文档后确认三件事（每一条都会导致运行失败）：
#   1. 模型名是 `paraformer-v2`，不是 `paraformer-realtime-v2`
#      —— 后者是「实时流式」模型，走 WebSocket，不接受文件。
#   2. **音频必须通过公网可访问的 HTTP/HTTPS URL 提供**，
#      官方原文：「不支持 Base64 编码或本地文件路径」。
#      我第一版传 `data:audio/m4a;base64,...`，必然失败。
#   3. 提交任务的 header 必须 `X-DashScope-Async: enable`（不是 disable），
#      且轮询用 GET /tasks/{task_id}。
#
# 解决方案（对应第 2 点）：服务器上跑一个极小的「临时音频托管」——
# 把音频写进 nginx 已托管的目录，带随机 token 文件名，转写完立即删除。
# 复用的是项目里已有的 /dropimg/ 同款模式（token 路径 + 静态托管 + 随机名），
# 不新造轮子、不新开端口。

ASR_MODEL = 'paraformer-v2'

# ---------- 成本计量（防止「意外账单」这件最讨厌的事）----------
#
# 为什么必须做：ASR 免费额度是 **10 小时/月**，超出后 **0.6 元/小时**。
# 如果不计量，批量跑一个大收藏夹就可能悄悄跨过免费线开始扣钱。
# 这里在**本地**记流水，跑到预算上限就停，不依赖云端额度查询。
#
# 云端额度是「每月 1 日 0 点自动重置」的，所以用量也按自然月记账。

ASR_FREE_SECONDS_PER_MONTH = 10 * 3600      # 10 小时/月，每月 1 日重置
ASR_PRICE_PER_HOUR = 0.6                    # 元/小时（超出后）
USAGE_FILE = HERE / 'usage.json'


def _this_month():
    return time.strftime('%Y-%m')


def load_usage():
    """读本月已消耗的音频秒数。文件损坏时按 0 处理（宁可少报也不崩）。"""
    if not USAGE_FILE.exists():
        return {'month': _this_month(), 'asr_seconds': 0}
    try:
        u = json.loads(USAGE_FILE.read_text('utf-8'))
    except Exception:
        return {'month': _this_month(), 'asr_seconds': 0}
    # 跨月了：额度已重置，计数器也归零
    if u.get('month') != _this_month():
        return {'month': _this_month(), 'asr_seconds': 0}
    return {'month': u.get('month'), 'asr_seconds': int(u.get('asr_seconds') or 0)}


def add_usage(seconds):
    u = load_usage()
    u['asr_seconds'] += int(seconds)
    USAGE_FILE.write_text(json.dumps(u, ensure_ascii=False, indent=1), encoding='utf-8')
    return u


def cost_report(u):
    """把秒数翻译成人话：用了多少 / 免费还剩多少 / 超了要花多少。"""
    used = u['asr_seconds']
    free = ASR_FREE_SECONDS_PER_MONTH
    over = max(0, used - free)
    yuan = over / 3600 * ASR_PRICE_PER_HOUR
    return (f'本月 ASR 已用 {used/3600:.2f} 小时 / 免费 {free/3600:.0f} 小时'
            f'（{u["month"]}）'
            + (f'，⚠️ 已超出 {over/3600:.2f} 小时 → 约 {yuan:.2f} 元'
               if over else f'，剩余 {free-used:.0f} 秒额度'))


def precheck_budget(n_items, avg_seconds, budget_seconds):
    """开跑前先估：这批要多少额度、会不会超预算。超了就拒绝启动。

    avg_seconds 只能是猜（还没下载不知道时长），所以用保守值，
    并在真正处理时按**实际**时长累加。
    """
    u = load_usage()
    est = n_items * avg_seconds
    after = u['asr_seconds'] + est
    if budget_seconds and after > budget_seconds:
        return (False,
                f'按平均 {avg_seconds} 秒 × {n_items} 条估算，本月将达 '
                f'{after/3600:.2f} 小时，超过你设的预算上限 '
                f'{budget_seconds/3600:.2f} 小时。\n'
                f'当前：{cost_report(u)}\n'
                f'要么调大 --budget-seconds，要么减少条数，要么下月再跑（额度会重置）。')
    return True, ''


def transcribe(audio_path, api_key, public_base, model=ASR_MODEL):
    """把音频通过公网 URL 提交给 Paraformer，轮询拿文稿。

    public_base: 形如 'https://nexus.kotete.xyz/asrtmp'
                 指向 nginx 上托管临时音频的目录（结尾不带 /）。
    """
    # 随机文件名：不可猜测，避免别人扫到你的音频
    token = secrets.token_urlsafe(24)
    ext = audio_path.suffix or '.m4a'
    filename = f'{token}{ext}'
    tmp_dir = Path(ASR_TMP_DIR)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    dest = tmp_dir / filename
    last_usage = {'seconds': 0}

    try:
        shutil.copyfile(audio_path, dest)
        audio_url = f'{public_base.rstrip("/")}/{filename}'

        # ---- 提交任务 ----
        payload = {
            'model': model,
            'input': {'file_urls': [audio_url]},
            'parameters': {'language_hints': ['zh', 'en']},
        }
        res = post_json(f'{DASHSCOPE_BASE}/services/audio/asr/transcription',
                        payload, api_key, async_header='enable')
        task_id = (res.get('output') or {}).get('task_id')
        if not task_id:
            raise RuntimeError(
                f'ASR 未返回 task_id：{json.dumps(res, ensure_ascii=False)[:300]}')

        # ---- 轮询（官方建议 1 秒一次；这里 2 秒，够快也不打搅）----
        for _ in range(150):          # 上限 300 秒
            time.sleep(2)
            chk = get_json(f'{DASHSCOPE_BASE}/tasks/{task_id}', api_key)
            out = chk.get('output') or {}
            st = out.get('task_status')
            if st == 'SUCCEEDED':
                # usage.duration 是官方给的**计费时长**（秒），拿它记账最准，
                # 不要用文件大小或元数据里的 duration 估 —— 差一点都会算错钱。
                last_usage['seconds'] = _usage_seconds(chk)
                text = _extract_text(out)
                # 记账放在这里（成功且有官方时长），不在 finally 里 ——
                # 失败的调用不计费，记进去会虚报用量、吓到自己。
                if last_usage['seconds']:
                    add_usage(last_usage['seconds'])
                return text, last_usage['seconds']
            if st == 'FAILED':
                raise RuntimeError(
                    f'ASR 任务失败：{json.dumps(chk, ensure_ascii=False)[:400]}')
            # PENDING / RUNNING 继续等
        raise RuntimeError('ASR 超时（5 分钟未完成）')
    finally:
        # 不管成败，临时音频立刻删 —— 它是公网可见的，多留一秒都是风险
        dest.unlink(missing_ok=True)


def _usage_seconds(res):
    """从查询结果里取官方计费时长（秒）。取不到时返回 0（不瞎猜）。"""
    try:
        return int(((res.get('usage') or {}).get('duration')) or 0)
    except Exception:
        return 0


def _extract_text(out):
    """从 DashScope 查询结果里把文稿抠出来。

    成功形态（实测文档）：
      output.results[].transcription_url → 再 GET 一次拿 JSON
      该 JSON 的 transcripts[].text 是完整文本，sentences[].text 是分句。
    优先用 transcripts[].text（拼好的整段，比分句再拼更准）。
    """
    results = out.get('results') or []
    if not results:
        raise RuntimeError('ASR 结果里没有 results 字段')

    # 单文件任务只有一个 result，但按文档「部分失败」也可能有多个
    r = results[0]
    sub = r.get('subtask_status')
    if sub and sub != 'SUCCEEDED':
        raise RuntimeError(
            f'ASR 子任务未成功（{sub}）：{r.get("message") or ""}')

    turl = r.get('transcription_url')
    if not turl:
        raise RuntimeError(
            f'ASR 结果里没有 transcription_url：{json.dumps(r, ensure_ascii=False)[:300]}')

    with urllib.request.urlopen(turl, timeout=60) as f:
        j = json.loads(f.read().decode('utf-8'))

    trs = j.get('transcripts') or []
    if not trs:
        raise RuntimeError('转写结果里没有 transcripts（可能音频没人声）')

    # transcripts[].text 是完整识别文本；多音轨时合并
    parts = [t.get('text', '') for t in trs if t.get('text')]
    if not parts:
        # 退一步：用分句拼
        for t in trs:
            for s in (t.get('sentences') or []):
                if s.get('text'):
                    parts.append(s['text'])
    text = ''.join(parts).strip()
    if not text:
        raise RuntimeError('转写结果为空（视频可能无人声，或全是背景音乐）')
    return text


# ---------- 步骤 4：LLM 总结 ----------
SUMMARY_PROMPT = """你是一个帮人提炼成长类短视频观点的助手。

请基于下面的视频文稿，输出严格 JSON（不要 markdown 代码块，不要任何额外说明）：
{
  "point": "一句话核心观点，不超过 40 字，用你自己的话概括，不要照抄原文",
  "points": ["要点1", "要点2", "要点3"],
  "tags": ["主题标签"]
}

要求：
- point 是这条视频最值得记住的那一句，要有信息量，不要空洞（禁止「讲了成长的重要性」这类废话）
- points 是 2-3 条可执行的要点或关键事实，每条不超过 30 字
- tags 从这几个里选：女性成长 / 心理成长 / AI学习 / 认知输入 / 其他
- 如果文稿内容太碎、没有实质信息，point 写「（内容过短，无法提炼）」并让 points 为空数组"""


# 总结用的模型。**必须可配置**，原因见下方注释。
#
# ⚠️ 2026-09-26 教训：我原来把 'qwen-plus' 硬编码在这里，
# 结果用户把自己控制台的免费额度列表发过来，里面**根本没有 qwen-plus** ——
# 他的账号有 qwen3.8-flash / qwen3.8-max / deepseek / glm 等的额度，
# 但没有旧命名的 qwen-plus。硬编码一个「我以为是默认」的模型名，
# 等于把一个必然失败换成另一个必然失败。
#
# 更糟的是：百炼一直在下线旧命名模型（2026-07-13 下线 qwen-turbo 等 10 个，
# 2026-10-10 还要再下线一批）。今天能用的名字，下个月可能就是 404。
#
# 所以：
#   1. 模型名走环境变量 / 命令行参数，不写死
#   2. 带一个**候选链**，主模型 404/无权限就自动降级到下一个
#   3. 提供 --list-models 让你直接问「我这个 key 到底能用哪些」
DEFAULT_SUMMARY_MODELS = [
    'qwen3.8-flash',      # 用户额度列表里确认有 1M
    'qwen3.8-max-0902',   # 备选，额度列表里也有
    'qwen-plus',          # 旧命名，兼容老账号
]


def summarize(transcript, api_key, models):
    """按候选链依次尝试，第一个成功的就返回。

    models 可以是字符串（单个）或列表（候选链）。
    这样做的理由：模型下线/无权限是**这个平台最常见的失败**，
    不该让用户因为「模型名过期」而拿到一个空结果。
    """
    if isinstance(models, str):
        models = [models]
    errs = []
    for model in models:
        try:
            return _summarize_one(transcript, api_key, model)
        except Exception as e:
            msg = str(e)
            # 只对「模型不存在/无权限」这类错误降级；
            # 别的错误（比如网络断了）降级也没用，直接抛出来更诚实
            if 'Model not exist' in msg or 'model not found' in msg.lower() \
                    or 'AccessDenied' in msg or 'InvalidParameter' in msg \
                    or 'HTTP 404' in msg:
                errs.append(f'{model}: {msg[:160]}')
                continue
            raise
    raise RuntimeError(
        '所有候选模型都不可用，请用 --list-models 查你账号能用哪些，'
        '再用 --summary-model 指定。\n明细：\n  ' + '\n  '.join(errs))


def _summarize_one(transcript, api_key, model):
    payload = {
        'model': model,
        'input': {'messages': [
            {'role': 'system', 'content': SUMMARY_PROMPT},
            {'role': 'user', 'content': '视频文稿：\n' + transcript[:12000]},
        ]},
        'parameters': {'result_format': 'message'},
    }
    res = post_json(f'{DASHSCOPE_BASE}/services/aigc/text-generation/generation',
                    payload, api_key)
    out = (res.get('output') or {})
    txt = ''
    if isinstance(out.get('choices'), list) and out['choices']:
        txt = (out['choices'][0].get('message') or {}).get('content', '')
    if not txt:
        txt = out.get('text', '')
    if not txt:
        raise RuntimeError(f'LLM 未返回内容：{json.dumps(res, ensure_ascii=False)[:300]}')

    # 容错解析：模型有时会包 ```json
    m = re.search(r'\{[\s\S]*\}', txt)
    if not m:
        raise RuntimeError(f'LLM 返回的不是 JSON：{txt[:200]}')
    try:
        summary = json.loads(m.group(0))
    except Exception:
        raise RuntimeError(f'LLM JSON 解析失败：{m.group(0)[:200]}')
    summary['_model'] = model      # 记下这条是谁总结的，方便排查质量差异
    return summary


def probe_models(api_key, candidates):
    """逐个试探候选模型，报告哪个能用。

    这是我能给用户的最实用的一个命令：与其猜「我的 key 能用什么」，
    不如直接问。用最小 token 请求，几乎不花钱。
    """
    results = []
    for m in candidates:
        row = {'model': m, 'ok': False, 'detail': ''}
        try:
            payload = {
                'model': m,
                'input': {'messages': [{'role': 'user', 'content': 'hi'}]},
                'parameters': {'result_format': 'message', 'max_tokens': 1},
            }
            post_json(f'{DASHSCOPE_BASE}/services/aigc/text-generation/generation',
                      payload, api_key)
            row['ok'] = True
            row['detail'] = '可用'
        except Exception as e:
            row['detail'] = str(e)[:200]
        results.append(row)
    return results


# ---------- 主流程 ----------
def process_one(url, args, api_key):
    result = {'url': url, 'ok': False, 'steps': {}}
    workdir = Path(tempfile.mkdtemp(prefix='dy-'))
    try:
        meta = fetch_meta(url, args.cookies, args.ytdlp)
        result['title'] = meta.get('title') or ''
        result['uploader'] = meta.get('uploader') or ''
        result['duration'] = meta.get('duration')
        result['steps']['meta'] = 'ok'

        if args.meta_only:
            result['ok'] = True
            return result

        audio = fetch_audio(url, args.cookies, args.ytdlp, workdir)
        result['steps']['download'] = f'ok ({audio.stat().st_size} bytes)'

        transcript, used_sec = transcribe(audio, api_key, args.asr_public,
                                         model=args.asr_model)
        result['transcript_len'] = len(transcript)
        result['asr_seconds'] = used_sec
        result['steps']['asr'] = f'ok ({used_sec}s 计费)'
        # 视频不留存：转写完立刻删
        for f in workdir.iterdir():
            f.unlink(missing_ok=True)

        if args.transcript_only:
            result['transcript'] = transcript
            result['ok'] = True
            return result

        summary = summarize(transcript, api_key, args.summary_models)
        result['point'] = summary.get('point', '')
        result['points'] = summary.get('points', [])
        result['tags'] = summary.get('tags', [])
        result['summary_model'] = summary.get('_model', '')
        result['steps']['summary'] = f"ok ({summary.get('_model', '?')})"
        result['ok'] = True
        return result
    except Exception as e:
        result['error'] = str(e)
        return result
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description='抖音视频 → 文稿 → 观点分析')
    ap.add_argument('--cookies', help='Netscape 格式 cookie 文件路径')
    ap.add_argument('--url', help='单个视频链接')
    ap.add_argument('--urls-file', help='每行一个链接的文件路径')
    ap.add_argument('--out', help='结果写到这个 JSON 文件（默认 stdout）')
    ap.add_argument('--meta-only', action='store_true', help='只取元数据，不下载')
    ap.add_argument('--transcript-only', action='store_true', help='只转写，不做 LLM 总结')
    ap.add_argument('--delay', type=float, default=3.0, help='批量时每条之间的间隔秒数')
    ap.add_argument('--ytdlp', default=str(DEFAULT_YTDLP), help='yt-dlp 的 python 路径')
    ap.add_argument('--asr-public', default=ASR_PUBLIC_BASE,
                    help='临时音频对外的公网前缀（Paraformer 要求音频走公网 URL）')
    ap.add_argument('--budget-seconds', type=int, default=ASR_FREE_SECONDS_PER_MONTH,
                    help='本月 ASR 用量上限（秒），默认 = 免费额度 10 小时。'
                         '超过就拒绝启动，防止意外扣费。传 0 表示不限制')
    ap.add_argument('--avg-seconds', type=int, default=120,
                    help='批量预估用的单条平均时长（秒），默认 120')
    ap.add_argument('--summary-model',
                    help='总结用哪个模型（单个）。不给就用内置候选链依次试')
    ap.add_argument('--asr-model', default=ASR_MODEL,
                    help=f'ASR 模型名，默认 {ASR_MODEL}')
    ap.add_argument('--list-models', action='store_true',
                    help='逐个试探候选模型，报告你账号能用哪些（几乎不花钱）')
    args = ap.parse_args()

    api_key = os.environ.get('DASHSCOPE_API_KEY', '').strip()

    # 「我这个 key 到底能用什么模型」—— 与其猜，不如直接问。
    # 这个分支放在最前面，因为它连 yt-dlp 和音频目录都不需要。
    if args.list_models:
        if not api_key:
            print('错误：需要 DASHSCOPE_API_KEY 环境变量', file=sys.stderr)
            sys.exit(2)
        cands = ([args.summary_model] if args.summary_model
                 else DEFAULT_SUMMARY_MODELS)
        print('逐个试探候选模型（每个只发 1 个 token 的请求）：\n', file=sys.stderr)
        rows = probe_models(api_key, cands)
        for r in rows:
            mark = '✅' if r['ok'] else '❌'
            print(f'  {mark} {r["model"]:<24} {r["detail"]}', file=sys.stderr)
        good = [r['model'] for r in rows if r['ok']]
        print(f'\n可用 {len(good)}/{len(rows)}：{", ".join(good) or "（全不可用）"}',
              file=sys.stderr)
        sys.exit(0 if good else 1)

    # 候选链：--summary-model 优先（用户明确指定），否则用内置链
    args.summary_models = ([args.summary_model] if args.summary_model
                           else DEFAULT_SUMMARY_MODELS)

    need_asr = not args.meta_only
    if need_asr and not api_key:
        print('错误：需要 DASHSCOPE_API_KEY 环境变量（ASR 和总结都依赖它）', file=sys.stderr)
        sys.exit(2)
    if not os.path.exists(args.ytdlp):
        print(f'错误：找不到 yt-dlp 运行时 {args.ytdlp}', file=sys.stderr)
        sys.exit(2)
    # 转写要把音频吐到公网目录，先确认那里可写；否则会卡在 ASR 才报错，浪费时间
    if need_asr and not os.path.isdir(ASR_TMP_DIR):
        print(f'错误：临时音频目录不存在 {ASR_TMP_DIR}（ASR 需要公网可读的托管目录）',
              file=sys.stderr)
        sys.exit(2)

    urls = []
    if args.url:
        urls.append(args.url)
    if args.urls_file:
        urls += [l.strip() for l in Path(args.urls_file).read_text('utf-8').splitlines()
                 if l.strip() and not l.startswith('#')]
    if not urls:
        print('错误：需要 --url 或 --urls-file', file=sys.stderr)
        sys.exit(2)

    # ---- 开跑前的成本闸门 ----
    # 这一步存在的唯一理由：ASR 免费额度只有 10 小时/月，超了要花钱。
    # 与其「跑完才发现扣钱」，不如「先算清楚、超了就停」。
    if need_asr and args.budget_seconds:
        ok, why = precheck_budget(len(urls), args.avg_seconds, args.budget_seconds)
        if not ok:
            print(f'已阻止执行（成本保护）：\n{why}', file=sys.stderr)
            sys.exit(2)
    if need_asr:
        print(f'【成本】{cost_report(load_usage())}', file=sys.stderr)
        print(f'       这批 {len(urls)} 条，预估约 '
              f'{len(urls)*args.avg_seconds/3600:.2f} 小时\n', file=sys.stderr)

    out = []
    for i, u in enumerate(urls):
        print(f'[{i+1}/{len(urls)}] {u}', file=sys.stderr)
        out.append(process_one(u, args, api_key))
        if i < len(urls) - 1:
            time.sleep(args.delay)   # 限速：避免触发风控

    text = json.dumps(out, ensure_ascii=False, indent=1)
    if args.out:
        Path(args.out).write_text(text, encoding='utf-8')
        print(f'已写入 {args.out}', file=sys.stderr)
    else:
        print(text)

    ok = sum(1 for r in out if r['ok'])
    print(f'\n成功 {ok}/{len(out)}', file=sys.stderr)
    if need_asr:
        print(f'【成本】{cost_report(load_usage())}', file=sys.stderr)
    sys.exit(0 if ok == len(out) else 1)


if __name__ == '__main__':
    main()
