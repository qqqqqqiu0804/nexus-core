---
name: douyin-favorites-pipeline
description: 把抖音收藏夹变成可检索的学习库（转写 + 观点提取 + 去重复用）。当需要采集抖音收藏、跑 ASR 转写、提取观点、处理"抖音风控导致下载失败"、或排查抖音采集脚本问题时使用。内含绕过风控的正确方案、成本控制参数、106 项测试清单。
agent_created: true
---

# 抖音收藏 → 学习库

把用户抖音收藏夹里的视频转成文字和观点，存进可复用的数据库。

## 一、最重要的认知：服务器自己下载是死路

**别再试。** 已穷尽验证（2026-09-26）：

| 方式 | 结果 |
|---|---|
| yt-dlp | 403 |
| f2（a_bogus 签名**合法**） | 403 |
| 手写 fetch（页面上下文） | **挂死 30 秒不返回** |
| **真实浏览器页面自己发** | **200 ✅** |

根因：**抖音对自动化环境弹滑块验证**（headed 截图确认「请完成下列验证后继续」）。
不是 cookie、不是签名、不是代码问题。**做任何对抗都是浪费。**

**报错会骗人，必须记住**：
- yt-dlp 的 `Fresh cookies (not necessarily logged in) are needed`
  **真实含义是 HTTP 403**。要看真相必须加 `-v`。
- `SUCCESS_WITH_NO_VALID_FRAGMENT` ≠ 故障，是「任务成功但音频里没人声」。

**`ttwid` / `odin_tt` 是 HttpOnly**，`document.cookie` 读不到。
`document.cookie` 能拿到的那几项看着不少，但**最关键的那个恰好缺席** ——
会让「让用户复制 cookie」这个通用套路静默失败。

## 二、正确架构

```
用户浏览器采集（含 CDN 播放地址）  ← 唯一能拿到视频的入口
  → 导出 JSON → 粘给我
  → run_batch.py：流式抽音频 → ASR → LLM → 入库
```

**CDN 直链服务器可直接下**：带 `Referer: https://www.douyin.com/` 即可，
**不需要签名、不需要 cookie**。实测支持 Range 请求（`206`）。
> 别用 `aweme/v1/play/` 接口 —— 返回 200 但 0 字节（是 302 入口）。

**「直接下音频」在抖音不存在 —— 但也不必把视频落盘**（容易搞错的一点）：
- 抖音只给 `mime_type=video_mp4` 的流，**人声和画面在同一条流里**，没有纯人声轨道。
- 导出里的 `*.douyinstatic.com/.../*.mp3` 是**背景音乐**，不是人说话的声音，
  拿去转写会得到空文本（或 `SUCCESS_WITH_NO_VALID_FRAGMENT`）。
- 正确做法：**让 ffmpeg 直接吃 URL**，`-vn` 丢视频轨，边读边丢、视频不落盘：
  ```bash
  ffmpeg -y -nostdin -user_agent "<UA>" \
         -headers "Referer: https://www.douyin.com/\r\n" \
         -i "$URL" -vn -c:a aac -b:a 64k out.m4a
  ```
  `-nostdin` 必须加，否则 ffmpeg 会等 stdin 把 ssh 挂住。
  实测 15 秒视频耗时 1.1 秒，磁盘上只有 `v.m4a`，没有 mp4。
- 附带收益：**报错更准**。旧写法（curl 落盘）过期地址只能报「0 字节」，
  新写法直接报 `HTTP error 403 Forbidden`。

> 早期版本是「curl 下完整 mp4 → 写盘 → ffmpeg 读回来抽音频」，能用但多一轮 I/O，
> 且磁盘峰值 = 视频大小（18.8 分钟 ≈ 116MB）。已改为流式。

## 三、用户侧操作（5 分钟）

1. 篡改猴装 `docs/tools/douyin-collect.user.js`
2. 进收藏夹 → 点面板绿色 **「⏺ 开始采集」**
3. **往下滑，让每个视频都播一下** ← 只有播过才有地址
4. 面板会显示「含播放地址 X 条」，X 上不去就是没播
5. 点「导出 N 条」→ 复制 → 发给助手

> ⚠️ **CDN 地址有时效（几小时）**。导出后尽快处理，别隔夜。

## 四、服务器侧命令

```bash
cd /root/nexus-core/server/tools
set -a && . /root/nexus-core/server/.env && set +a   # key 在 ../.env，不是 /root/.env

python3 db_status.py                                # 看库状态
python3 run_batch.py x.json --collection "名字" --dry-run
python3 run_batch.py x.json --collection "名字" --limit 5
python3 run_batch.py x.json --collection "名字" --clip 300   # 只转写前 5 分钟（省钱）
python3 run_batch.py x.json --summary-model deepseek-v4.1-flash
```

**key 的位置别猜**：`/root/nexus-core/server/.env`，且用 `set -a; . .env` 加载。
`grep -oP` 取出来会掺进引号，容易把 116 字符的 key 搞坏。

**长任务必须脱离 ssh**（`nohup &` 会随连接被杀）：
```bash
setsid nohup ./venv/bin/python run_batch.py x.json < /dev/null > /tmp/b.log 2>&1 &
```
或写成 `.sh` 上传执行。**误判陷阱**：以为进程被杀了，其实它在服务端跑完了 —— 
检查日志末尾和 DB 状态，别急着重跑（会重复花钱）。

## 五、成本控制（关键）

| 项 | 值 |
|---|---|
| ASR 免费额度 | **10 小时/月**（阿里云 Paraformer，每月 1 日重置）|
| 超出价格 | 0.6 元/小时 |
| 典型收藏夹 | 160 条约 = **8 小时**（几乎一批吃满一个月）|

**跑前必做**：
1. `--dry-run` 看会处理哪些、跳过哪些
2. 看「本月已用 X 小时」的输出
3. **测新功能用短视频**（>20 分钟的视频一条就烧 0.3 小时额度）

**省钱的核心机制**：转写按 `aweme_id` 存，`get_transcript()` 非 None 就跳过 ASR。
换摘要模型时**不重付 ASR**（ASR 0.6 元/时 vs LLM 每百万 token 几毛钱）。

**长视频不见得要看全部**：`--clip 300` 只转写前 5 分钟。
判断「这条值不值得全转」用它 —— 界面全是知识类，前 5 分钟的信息量就够了。

## 五之二、已验证事实（可放心引用）

| 事实 | 验证方式 |
|---|---|
| CDN 支持 Range | `curl -r 0-200000` → `206`，`size=200001` |
| ffmpeg 能直读 https | `ffmpeg -protocols` 输出含 `https` / `tls` |
| 流式抽音频不落 mp4 | 抽完目录里只有 `v.m4a`（8 项断言全过）|
| clip 生效 | `--clip 5` → 5.0 秒 / 42KB（原 15.1 秒）|
| 过期地址报 403 | `HTTP error 403 Forbidden`（不是「0 字节」）|
| 人声和画面同流 | 导出的 `.mp3` 是 BGM；`video_mp4` 才是含人声的 |

## 六、模型选择（实测）

可用 10 个，便宜优先序：
`qwen3.8-flash` → `deepseek-v4.1-flash` → `qwen3.7-flash-2026-07-15`
→ `qwen3.8-27b` → `kimi-k3` → `glm-5.3` → `deepseek-v4-flash-0731`
→ `qwen3.8-max-0902`

**实测结论**（同一段 18.8 分钟真视频）：
- `qwen3.8-flash`：观点较泛
- **`deepseek-v4.1-flash` 明显更好** —— 抓到视频里的具体说法，qwen 没提

→ **长内容（>10 分钟）用 `deepseek-v4.1-flash`；短内容用 `qwen3.8-flash` 省钱**

端点两族（`content` 类型不同，容易搞错）：
- 多模态：`content` 是 **list** `[{"text":...}]`
- 文本：`content` 是 **str**

## 七、ASR 三个必要件（缺一即失败）

1. 模型名 `paraformer-v2`（`-realtime-` 版只走 WebSocket，不收文件）
2. 音频必须**公网 HTTP URL**（不支持 base64 / 本地路径）
   → 用 `/var/www/asrtmp`，nginx 白名单只放行音频扩展名
   → **403 是正确的**（安全策略生效）。验证方法：换成 `.m4a` 再试，
     200 才是通。
3. header `X-DashScope-Async: enable` + 轮询 `GET /tasks/{task_id}`

## 八、测试（106 项，全绿）

```bash
# Python（本地或服务器都行）
./venv/bin/python test_video_db.py    # 25 项 数据层
./venv/bin/python test_reuse.py       # 45 项 复用逻辑 ← 最重要

# JS（本地，需要 NODE_PATH）
cd docs/tools
NODE_PATH="C:/Users/HXT/.workbuddy-ai/binaries/node/workspace/node_modules" \
  "C:/Users/HXT/.workbuddy-ai/binaries/node/versions/22.22.2-3/node.exe" \
  test-collect-real.js                # 23 项 采集脚本
```

**改 `process_one` 后必跑 `test_reuse.py`** —— 它打桩数调用次数，
能立刻发现「缓存没生效」这类静默 bug。

## 九、排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| 「地址可能已过期」 | 导出放太久 | 重新采集 |
| 「含播放地址 0 条」 | 没播视频 | 往下滑让视频真的播 |
| 「跳过 N 条（已有转写）」 | **好事** | 说明省钱了 |
| 面板不出现 | 篡改猴没权限 | 右键篡改猴图标 → 网站访问权限 → 检查是否被拒 |
| `string indices must be integers` | `get_transcript()` 返回**纯字符串**不是 dict | 别写 `cached['text']` |

## 十、反复踩的坑（记住能省很多轮次）

1. **heredoc / ssh 嵌套引号**：`ssh '... python3 -c "..." '` 里带括号必炸
   （`%(ext)s`、`list(s.keys())` 都炸过）。
   → **铁律：写本地文件 → scp → 远程执行。别试内联。**
2. **假 DOM 测试报错，先查 harness 缺什么方法**，不是代码错。
   （缺过 `remove()`、`location.origin`、`el().click()`）
3. **「逻辑对但界面不出现」是独立的失败模式** —— 必须用真浏览器测。
   用 `ctx.route('**/*')` 域名劫持，比改 hosts 干净。
