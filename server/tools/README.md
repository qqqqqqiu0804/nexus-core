# server/tools/ —— 抖音收藏视频分析的工具链

> 这个目录不属于工作台运行时（`server.js`），是**离线批处理工具**。
> 用法：在服务器上手动/定时跑。

## 一句话说清它干什么

```
抖音收藏链接
   ↓ yt-dlp 取元数据 + 下载（只要音频）
   ↓ ffmpeg 转 m4a
   ↓ 临时挂到 /asrtmp/ 让 DashScope 能拉
   ↓ Paraformer 转中文文稿
   ↓ qwen-plus 提炼「一句话观点 + 3 要点 + 标签」
   ↓ 写回工作台 videos 条目
```

## 依赖

| 组件 | 版本 | 说明 |
|---|---|---|
| ffmpeg | 6.1.1 | 抽音频 |
| yt-dlp | 2026.08.19 | 装在 `tools/venv`（隔离，不污染系统 Python） |
| Python | 3.12.3 | 系统自带够用 |
| DashScope API Key | — | ASR + LLM 都要，走 `DASHSCOPE_API_KEY` 环境变量 |

`venv/` 是隔离环境，**不入库**（见 `.gitignore`）。

## nginx 前置要求

ASR 要求音频走公网 URL，所以必须先配好 `/asrtmp/`：
见 `nginx-asrtmp.conf`（含两个反直觉的坑，配之前务必读）。

```bash
mkdir -p /var/www/asrtmp && chmod 755 /var/www/asrtmp
```

## 用法

```bash
cd /root/nexus-core/server/tools

# ① 先只取元数据，验证 cookie 有效（最便宜的一步，不下视频）
DASHSCOPE_API_KEY=... python3 douyin_pipeline.py \
    --cookies /root/nexus-core/server/.douyin-cookies.txt \
    --url "https://v.douyin.com/xxxxx/" \
    --meta-only

# ② 只转写，不做 LLM 总结（想先看文稿质量时用）
DASHSCOPE_API_KEY=... python3 douyin_pipeline.py \
    --cookies /root/nexus-core/server/.douyin-cookies.txt \
    --url "https://v.douyin.com/xxxxx/" \
    --transcript-only

# ③ 完整跑一条（下载 → 转写 → 总结）
DASHSCOPE_API_KEY=... python3 douyin_pipeline.py \
    --cookies /root/nexus-core/server/.douyin-cookies.txt \
    --url "https://v.douyin.com/xxxxx/" \
    --out /tmp/one.json

# ④ 批量（从文件读链接，每条间隔 5 秒防风控）
DASHSCOPE_API_KEY=... python3 douyin_pipeline.py \
    --cookies /root/nexus-core/server/.douyin-cookies.txt \
    --urls-file /tmp/urls.txt \
    --delay 5 \
    --out /tmp/batch.json
```

`--urls-file` 格式：每行一个链接，`#` 开头的行为注释。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 全部成功 |
| 1 | 有失败条目（看 JSON 里的 `error` 字段） |
| 2 | 参数/环境不对（缺 key、缺 url、目录不存在等） |

## 成本（2026-09 查证阿里云官方）

| 模型 | 免费额度 | 有效期 | 超出后 |
|---|---|---|---|
| Paraformer-V2 | **10 小时/月** | **每月 1 日 0 点重置** | 0.6 元/小时 |
| 文本模型 | 每个 100 万 Token | 90 天（各模型不同） | 视模型而定 |

**100 条视频（平均 2 分钟）**：ASR 3.3 小时（33%，且月月重置）+ LLM 13.5 万 Token（13.5%）
→ **0 元**。即使平均 5 分钟（8.3 小时）仍在免费内。

## ⚠️ 模型名不能写死（2026-09-26 踩过）

原来总结模型硬编码成 `qwen-plus`，**用户账号里根本没有这个模型**。
百炼一直在下线旧命名（2026-07-13 下线 `qwen-turbo` 等 10 个，
2026-10-10 还有一批），**今天能用的名字下个月可能就是 404**。

现在的做法：

```bash
# ① 先问「我这个 key 能用什么」（每模型只发 1 token，几乎不花钱）
DASHSCOPE_API_KEY=sk-xxx python3 douyin_pipeline.py --list-models

# ② 明确指定
python3 douyin_pipeline.py --url "..." --summary-model qwen3.8-flash
```

内置候选链：`qwen3.8-flash` → `qwen3.8-max-0902` → `qwen-plus`。
**只在「模型不存在/无权限」时降级**；网络错误直接抛（降级也没用，抛出来更诚实）。
结果里带 `summary_model` 字段，记录这条是谁总结的，方便对比质量。

### 成本闸门（防止「跑完才发现扣钱」）

| 机制 | 说明 |
|---|---|
| 按官方计费时长记账 | 用 `usage.duration`，不用文件大小估 |
| 账本按自然月 | 跨月读取自动归零（对应官方重置） |
| 批量前预估并拦截 | 超预算**第一条都不跑** |
| 每次运行报账 | 打印本月已用 / 免费 10 小时 |

默认预算 = 免费额度。想超额需**显式**放宽：

```bash
# 默认：超了就停，不产生任何费用
python3 douyin_pipeline.py --urls-file /tmp/urls.txt

# 明确允许花最多 2 元（约 3.3 小时）：
python3 douyin_pipeline.py --urls-file /tmp/urls.txt --budget-seconds 48000

# 不限制（不推荐）
python3 douyin_pipeline.py --urls-file /tmp/urls.txt --budget-seconds 0
```

另建议在阿里云控制台把 Paraformer 的 **「免费额度用完即停」** 打开，
作为云端双保险 —— 即使本地记账有偏差也不会被扣钱。

### 测试

- `python3 test_usage.py`（14 项）—— 计量、跨月归零、预算边界
- `python3 test_summarize.py`（16 项）—— 候选链降级、错误分类、JSON 容错

两个都已接入 `npm test`。

## 设计原则（改这个脚本时请遵守）

1. **失败必须显式暴露。** 任何一步失败都写清楚「哪一步、为什么」。
   **绝不静默返回空摘要** —— 那会让你以为视频没内容，而不是工具坏了。
2. **视频不留存。** 转写完立即删音频 + 删临时公网文件。
   服务器出网只有 424 KB/s，磁盘也不宽裕。
3. **限速。** 批量串行 + `--delay`，避免触发抖音风控。
4. **凭据不落库。** cookie 放 `server/.env`（`chmod 600`），不入 git、不回显。

## 已知约束

| 约束 | 说明 |
|---|---|
| cookie 会过期 | 抖音 cookie 通常几天到几周；过期时报错是明确的一句话，不会静默 |
| `--cookies-from-browser` 本机不可用 | yt-dlp #7271，浏览器占用数据库锁；且你的抖音登录在 iPhone，用不上 |
| ASR 要公网 URL | 官方硬要求，所以有 `/asrtmp/`；这是设计约束，不是可以绕的 |
| 免费额度有限 | 先跑 1 条估消耗，再决定批量规模 |
