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

# 数据层：让「跑过的不用重跑」成立。
# 用 try 是因为 pipeline 在 --list-models 这类不用 DB 的场景下也应该能跑。
try:
    sys.path.insert(0, str(HERE))
    from video_db import VideoDB
    DB_PATH = HERE.parent / 'videos.db'
except Exception:      # noqa: BLE001
    VideoDB = None
    DB_PATH = None

DEFAULT_YTDLP = HERE / 'venv' / 'bin' / 'python'

# ⚠️ 2026-09-26 实测结论：**用公开域名，不要用工作空间专属域名。**
#
# 用户控制台上写的专属域名是
#   https://ws-01q7948czi100mb.cn-beijing.maas.aliyuncs.com/api/v1
# 我按它配了，结果**所有模型都返回 403 Endpoint.AccessDenied**——
# 不是模型没有权限，是这个入口对该 key 没开通。
# 换回公开域名 https://dashscope.aliyuncs.com/api/v1 之后 10/10 全部可用。
#
# 所以默认走公开域名；DASHSCOPE_BASE 环境变量仍可覆盖，
# 但**不要**在没有实测通过的情况下把专属域名填进去。
DASHSCOPE_BASE = os.environ.get('DASHSCOPE_BASE', '').strip() \
    or 'https://dashscope.aliyuncs.com/api/v1'

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
# ⚠️ 2026-09-26 教训一：我原来把 'qwen-plus' 硬编码在这里，
# 结果用户把自己控制台的免费额度列表发过来，里面**根本没有 qwen-plus**。
# 硬编码一个「我以为是默认」的模型名，等于把一个必然失败换成另一个必然失败。
#
# ⚠️ 2026-09-26 教训二（更贵的一课）：**模型还分属两个不同的接口端点。**
# 我原来一律打到 /services/aigc/text-generation/generation，
# 结果 10 个模型里有 7 个返回 400 InvalidParameter「url error」。
# 那个报错信息是**误导性**的——它跟 url 毫无关系，真实原因是
# 「该模型不属于这个端点家族」。实测矩阵：
#
#   text-generation 家族：deepseek-v4-flash-0731 / glm-5.3 / deepseek-v4-pro-0813
#   multimodal 家族     ：qwen3.8-27b / qwen3.7-flash-2026-07-15 / qwen3.8-flash /
#                        kimi-k3 / qwen3.8-max-0902 / deepseek-v4.1-flash /
#                        qwen3.8-2.4t-a95b
#
# 而且两个端点的**响应体形状也不一样**：
#   text-generation  → choices[0].message.content 是 **字符串** "收到"
#   multimodal       → choices[0].message.content 是 **列表** [{"text":"收到"}]
# 我原来的解析只处理字符串，遇到列表会拿不到内容（或静默拼错）。
#
# 所以现在：端点由 ENDPOINT_HINTS 决定（认识的直接路由），
# 不认识的**两端点都试一遍**，试出哪个能通就记住 —— 不靠我猜。
DEFAULT_SUMMARY_MODELS = [
    # 按「便宜 + 够用」排序，第一个就是默认要跑的
    'qwen3.8-flash',            # 最快最便宜，日常首选
    'deepseek-v4.1-flash',      # 次便宜，中文理解好，质量兜底
    'qwen3.7-flash-2026-07-15', # flash 同档
    'qwen3.8-27b',              # 小参数，稳
    'kimi-k3',                  # 长文本友好（转写稿都很长）
    'glm-5.3',                  # 跨家族兜底（text 端点）
    'deepseek-v4-flash-0731',   # text 端点
    'qwen3.8-max-0902',         # 贵但质量最好，留给重要的重跑
]

# 2026-09-26 实测：以下 10 个全部可用
#   多模态端点: qwen3.8-flash / qwen3.7-flash-2026-07-15 / deepseek-v4.1-flash
#              / kimi-k3 / qwen3.8-27b / qwen3.8-2.4t-a95b / qwen3.8-max-0902
#   文本端点:   deepseek-v4-flash-0731 / deepseek-v4-pro-0813 / glm-5.3

EP_TEXT = '/services/aigc/text-generation/generation'
EP_MULTI = '/services/aigc/multimodal-generation/generation'

# 只登记「实测确认过」的，没登记的走自动探测，而不是瞎猜
ENDPOINT_HINTS = {
    'glm-5.3': EP_TEXT,
    'deepseek-v4-flash-0731': EP_TEXT,
    'deepseek-v4-pro-0813': EP_TEXT,
    'qwen3.8-flash': EP_MULTI,
    'qwen3.8-max-0902': EP_MULTI,
    'qwen3.8-27b': EP_MULTI,
    'qwen3.8-2.4t-a95b': EP_MULTI,
    'qwen3.7-flash-2026-07-15': EP_MULTI,
    'deepseek-v4.1-flash': EP_MULTI,
    'kimi-k3': EP_MULTI,
}

# 探测成功后的缓存，避免同一个模型每次调用都白试一次
_ENDPOINT_CACHE = {}


def _pick_content(msg):
    """把两种响应体形状统一成字符串。

    这是本次踩坑的**根因所在**，单独抽成函数并加注释，
    防止以后有人「顺手简化」掉。
    """
    c = (msg or {}).get('content', '')
    if isinstance(c, str):
        return c                                  # text-generation 家族
    if isinstance(c, list):                       # multimodal 家族
        return ''.join(p.get('text', '') for p in c
                       if isinstance(p, dict) and p.get('text'))
    return ''


def _extract_llm_text(res):
    """从任意家族的响应里取出正文。取不到返回空串。"""
    out = res.get('output') or {}
    choices = out.get('choices')
    if isinstance(choices, list) and choices:
        txt = _pick_content(choices[0].get('message'))
        if txt:
            return txt
    return out.get('text', '') or ''


def _endpoints_for(model):
    """这个模型该打哪个端点。认识就直接给，不认识就给两个让调用方试。"""
    if model in _ENDPOINT_CACHE:
        return [_ENDPOINT_CACHE[model]]
    if model in ENDPOINT_HINTS:
        return [ENDPOINT_HINTS[model]]
    return [EP_MULTI, EP_TEXT]      # 不认识 → 都试，试出来就记住


def _is_endpoint_mismatch(msg):
    """判断这个报错是不是「端点选错了」。

    关键点：阿里云对「模型不在这个端点」返回的是
    400 InvalidParameter「url error, please check url！」
    ——这条信息具有**严重的误导性**，跟 url 一点关系都没有。
    实测验证过：同一个 url、同一个 payload，只换端点就从 400 变 200。
    """
    return ('url error' in msg.lower()
            or 'InvalidParameter' in msg
            or 'Model not exist' in msg
            or 'model not found' in msg.lower())


def summarize(transcript, api_key, models):
    """按候选链依次尝试，第一个成功的就返回。

    models 可以是字符串（单个）或列表（候选链）。
    这样做的理由：模型下线/无权限/端点错配是**这个平台最常见的失败**，
    不该让用户因为「我猜错了协议」而拿到一个空结果。
    """
    if isinstance(models, str):
        models = [models]
    errs = []
    for model in models:
        try:
            return _summarize_one(transcript, api_key, model)
        except Exception as e:
            msg = str(e)
            # 只对「模型/端点/权限」这类问题降级；
            # 别的错误（比如网络断了）降级也没用，直接抛出来更诚实
            if _is_endpoint_mismatch(msg) or 'AccessDenied' in msg \
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

    res = None
    last_err = None
    for ep in _endpoints_for(model):
        try:
            res = post_json(f'{DASHSCOPE_BASE}{ep}', payload, api_key)
            if model not in ENDPOINT_HINTS:
                _ENDPOINT_CACHE[model] = ep   # 探测到的路由记下来，下次直接用
            break
        except Exception as e:
            last_err = e
            if _is_endpoint_mismatch(str(e)):
                continue          # 换下一个端点再试
            raise

    if res is None:
        raise last_err or RuntimeError(f'{model} 无可用端点')

    txt = _extract_llm_text(res)
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
    """逐个试探候选模型，报告哪个能用 + 走哪个端点。

    这是我能给用户的最实用的一个命令：与其猜「我的 key 能用什么、
    该走哪个端点」，不如直接问。用最小 token 请求，几乎不花钱。
    """
    results = []
    for m in candidates:
        row = {'model': m, 'ok': False, 'detail': '', 'endpoint': ''}
        payload = {
            'model': m,
            'input': {'messages': [{'role': 'user', 'content': 'hi'}]},
            'parameters': {'result_format': 'message', 'max_tokens': 1},
        }
        tried = []
        for ep in _endpoints_for(m):
            try:
                post_json(f'{DASHSCOPE_BASE}{ep}', payload, api_key)
                row['ok'] = True
                row['endpoint'] = ep
                row['detail'] = '可用'
                break
            except Exception as e:
                tried.append(f'{ep.split("/")[-2]}={str(e)[:70]}')
        if not row['ok']:
            row['detail'] = ' | '.join(tried)[:240]
        results.append(row)
    return results


# ---------- 主流程 ----------
def extract_aweme_id(url):
    """从各种链接形式里抠出 aweme_id

    支持的形态：
      https://www.douyin.com/video/7689106012851254514
      https://www.douyin.com/note/7689106012851254514
      https://v.douyin.com/xxxxx/          ← 短链，抠不出，返回 ''
      https://www.douyin.com/user/xxx?modal_id=7689106012851254514
    """
    if not url:
        return ''
    m = re.search(r'/video/(\d{15,25})', url) or \
        re.search(r'/note/(\d{15,25})', url) or \
        re.search(r'modal_id=(\d{15,25})', url)
    return m.group(1) if m else ''


def process_one(url, args, api_key):
    """处理单条视频

    ★ 复用逻辑（2026-09-26 加）：
      开跑前先问数据库"这条的转写有吗"。
      有 → 跳过下载 + ASR（省时间，更省钱 —— ASR 0.6 元/小时）。
      没有 → 正常跑，跑完写回数据库。
    这就是「下次不用重复跑同一条视频」的落地点。
    """
    result = {'url': url, 'ok': False, 'steps': {}, 'cached': False}
    workdir = Path(tempfile.mkdtemp(prefix='dy-'))
    db = getattr(args, 'db', None)
    aweme_id = extract_aweme_id(url)
    result['aweme_id'] = aweme_id
    try:
        # ---------- ★ 查缓存：有转写就不下载、不 ASR ----------
        transcript = None
        if db and aweme_id and not args.force:
            cached = db.get_transcript(aweme_id)   # 返回纯文本 或 None
            if cached:
                transcript = cached
                result['cached'] = True
                result['transcript_len'] = len(cached)
                result['steps']['db'] = 'hit（已有转写，跳过下载+ASR）'
                result['asr_seconds'] = 0
                print('       ↳ 命中缓存，跳过 ASR', file=sys.stderr)
                # 缓存命中时也把标题/作者带出来（DB 里存着）
                v = db.get_video(aweme_id)
                if v:
                    result['title'] = v.get('desc') or ''
                    result['uploader'] = v.get('author') or ''
                    result['duration'] = (v.get('duration_ms') or 0) / 1000
                if args.transcript_only:
                    result['transcript'] = transcript
                    result['ok'] = True
                    return result
        elif db and aweme_id and args.force:
            result['steps']['db'] = 'ignore（--force 强制重跑）'

        # ---------- 缓存没命中：走正常流程 ----------
        if transcript is None:
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

            # ★ 转写完立刻入库 —— 后面 LLM 失败也不影响这段已花的钱
            if db and aweme_id:
                db.upsert_video(aweme_id, url=url,
                                desc=result.get('title') or '',
                                author=result.get('uploader') or '',
                                duration_ms=int((result.get('duration') or 0) * 1000))
                db.save_transcript(aweme_id, transcript, used_sec,
                                   asr_model=args.asr_model,
                                   duration_ms=int((result.get('duration') or 0) * 1000))
                result['steps']['save_transcript'] = 'ok'

            if args.transcript_only:
                result['transcript'] = transcript
                result['ok'] = True
                return result
        else:
            # 缓存命中但没进上面分支（transcript_only 已提前返回）——
            # 标题/作者上面已经带出来了，这里不用再取
            pass

        # ---------- 摘要（缓存命中时也要跑，除非 DB 里已有同模型的）----------
        want_models = args.summary_models
        if db and aweme_id and not args.force:
            old = db.get_summary(aweme_id)
            if old and old.get('model') in want_models:
                result['point'] = old.get('point') or ''
                result['points'] = old.get('points') or []
                v = db.get_video(aweme_id)
                result['tags'] = json.loads((v or {}).get('tags') or '[]')
                result['summary_model'] = old.get('model')
                result['steps']['summary'] = f"cached ({old.get('model')})"
                result['asr_seconds'] = result.get('asr_seconds', 0)
                result['ok'] = True
                print('       ↳ 摘要也命中缓存', file=sys.stderr)
                return result

        summary = summarize(transcript, api_key, args.summary_models)
        result['point'] = summary.get('point', '')
        result['points'] = summary.get('points', [])
        result['tags'] = summary.get('tags', [])
        result['summary_model'] = summary.get('_model', '')
        result['steps']['summary'] = f"ok ({summary.get('_model', '?')})"

        # ★ 摘要入库
        if db and aweme_id:
            db.save_summary(aweme_id, result['point'], result['points'],
                            model=result['summary_model'],
                            tags=result['tags'])
            result['steps']['save_summary'] = 'ok'

        result['ok'] = True
        return result
    except Exception as e:
        result['error'] = str(e)
        # 失败也记一笔状态，方便下次知道哪条卡住了
        if db and aweme_id:
            try:
                db.upsert_video(aweme_id, url=url, status='failed')
            except Exception:
                pass
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
    ap.add_argument('--db', default=str(DB_PATH) if DB_PATH else '',
                    help='结果库路径（默认 server/videos.db）。'
                         '有转写的视频会自动跳过下载+ASR，不重复花钱')
    ap.add_argument('--no-db', action='store_true',
                    help='完全不用数据库（不读也不写）')
    ap.add_argument('--force', action='store_true',
                    help='忽略缓存，强制重跑（换 ASR 模型验证效果时用）')
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
        print(f'域名：{DASHSCOPE_BASE}', file=sys.stderr)
        print('逐个试探候选模型（每个只发 1 个 token 的请求）：\n', file=sys.stderr)
        rows = probe_models(api_key, cands)
        for r in rows:
            mark = '✅' if r['ok'] else '❌'
            # 端点也要报：这个平台的端点错配会伪装成「url error」，
            # 不报出来用户就没法自己判断该不该换模型
            fam = r['endpoint'].split('/')[-2] if r['endpoint'] else '-'
            print(f'  {mark} {r["model"]:<24} {fam:<22} {r["detail"]}',
                  file=sys.stderr)
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

    # ---- 打开结果库 ----
    # 为什么在 precheck 之前打开：这样启动时就能报「库里已有多少条不用重跑」，
    # 用户能在花时间之前看到复用效果。
    args.db = None
    if not args.no_db and VideoDB and args.db:
        try:
            args.db = VideoDB(args.db)
            s = args.db.stats()
            print(f'【库】{args.db} 已有 {s["videos"]} 条，'
                  f'其中 {s["transcribed"]} 条已转写（这些会跳过 ASR）',
                  file=sys.stderr)
        except Exception as e:      # noqa: BLE001
            print(f'警告：打开数据库失败（{e}），本次不使用缓存', file=sys.stderr)
            args.db = None

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
    cached = sum(1 for r in out if r.get('cached'))
    print(f'\n成功 {ok}/{len(out)}' + (f'（其中 {cached} 条命中缓存，未重复花钱）' if cached else ''),
          file=sys.stderr)
    if need_asr:
        print(f'【成本】{cost_report(load_usage())}', file=sys.stderr)
    if args.db:
        args.db.close()
    sys.exit(0 if ok == len(out) else 1)


if __name__ == '__main__':
    main()
