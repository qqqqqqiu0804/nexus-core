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
                return _extract_text(out)
            if st == 'FAILED':
                raise RuntimeError(
                    f'ASR 任务失败：{json.dumps(chk, ensure_ascii=False)[:400]}')
            # PENDING / RUNNING 继续等
        raise RuntimeError('ASR 超时（5 分钟未完成）')
    finally:
        # 不管成败，临时音频立刻删 —— 它是公网可见的，多留一秒都是风险
        dest.unlink(missing_ok=True)


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


def summarize(transcript, api_key, model='qwen-plus'):
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
        return json.loads(m.group(0))
    except Exception:
        raise RuntimeError(f'LLM JSON 解析失败：{m.group(0)[:200]}')


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

        transcript = transcribe(audio, api_key, args.asr_public)
        result['transcript_len'] = len(transcript)
        result['steps']['asr'] = 'ok'
        # 视频不留存：转写完立刻删
        for f in workdir.iterdir():
            f.unlink(missing_ok=True)

        if args.transcript_only:
            result['transcript'] = transcript
            result['ok'] = True
            return result

        summary = summarize(transcript, api_key)
        result['point'] = summary.get('point', '')
        result['points'] = summary.get('points', [])
        result['tags'] = summary.get('tags', [])
        result['steps']['summary'] = 'ok'
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
    args = ap.parse_args()

    api_key = os.environ.get('DASHSCOPE_API_KEY', '').strip()
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
    sys.exit(0 if ok == len(out) else 1)


if __name__ == '__main__':
    main()
