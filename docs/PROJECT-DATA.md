# PROJECT-DATA —— 工作台依赖的外部资源台账

> 这个文件存在的理由：这个项目依赖一堆**外部服务**（阿里云百炼、抖音、服务器）。
> 每个服务都有一套「额度多少 / 什么时候到期 / 超了多少钱 / 什么名字能用」的规则，
> 而这些规则**散在控制台、邮件、官方公告里**，过一阵就记不清了。
>
> 记不清的代价是具体的：我因为这个把模型名写错过一次（见 §3.2），
> 把接口端点选错过一次（见 §3.3），两次都是**跑起来才发现**。
>
> 所以把这些数字**落到文件里**。查额度不用登控制台，看这里。
>
> **更新约定**：凡是实测/查证得到的新数字，直接改这里，并在「变更记录」追加一行。
> 不要只写在聊天里 —— 聊天会滚走，文件不会。

最后核对：2026-09-26

---

## 1. 阿里云百炼（DashScope / Model Studio）

### 1.1 接入点

| 项 | 值 | 状态 |
|---|---|---|
| **公开域名（唯一在用）** | `https://dashscope.aliyuncs.com/api/v1` | ✅ 实测 10/10 模型可用 |
| 工作空间专属域名 | `https://ws-01q7948czi100mb.cn-beijing.maas.aliyuncs.com/api/v1` | ❌ **实测全不可用** |
| OpenAI 兼容端点 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | ⚠️ 未使用，且**不是** `api/v1` 下的路径 |

**⚠️ 专属域名的坑（实测，别再踩第二次）**

控制台上给的专属域名，配上去之后**所有模型一律 403 `Endpoint.AccessDenied`**。
我一开始以为是「模型没开权限」，逐个试了 6 个模型全是同样报错，
换成公开域名立刻 10/10 全通。**是入口本身对这个 key 没开通，跟模型无关。**

> 结论：`DASHSCOPE_BASE` 留空，走代码里的默认值（公开域名）。
> 代码里刻意做成「环境变量优先、留空即用公开域名」，
> 就是为了下次有人想填专属域名时，不填也不会坏。

**⚠️ 兼容端点的坑**

它是**独立域名**，不是 `api/v1` 下的子路径。
我试过 `https://dashscope.aliyuncs.com/api/v1/services/aigc/compatible-mode/v1/chat/completions`，
返回 `No static resource api/v1/aigc/compatible-mode/v1/chat/completions` —— 路径不存在。
本项目走**原生协议**，不用兼容端点，这里只做记录免得再试一遍。

### 1.2 两个原生端点家族（这是最容易搞错的地方）

**同一个模型名，打错端点会返回 400 `InvalidParameter`，错误信息是
`url error, please check url！`** —— 这条信息具有**严重误导性**，它跟 url 毫无关系。

实测证据：同一个 url、同一个 payload，**只换端点**，从 400 变 200。

| 端点家族 | 路径 | 本 key 实测可用的模型 |
|---|---|---|
| **text-generation** | `/services/aigc/text-generation/generation` | `glm-5.3`、`deepseek-v4-flash-0731`、`deepseek-v4-pro-0813` |
| **multimodal-generation** | `/services/aigc/multimodal-generation/generation` | `qwen3.8-flash`、`qwen3.8-max-0902`、`qwen3.8-27b`、`qwen3.8-2.4t-a95b`、`qwen3.7-flash-2026-07-15`、`deepseek-v4.1-flash`、`kimi-k3` |

**两个家族的响应体形状不同，解析代码必须都处理：**

| 家族 | `output.choices[0].message.content` 的类型 | 例子 |
|---|---|---|
| text-generation | **字符串** | `"收到"` |
| multimodal-generation | **列表** | `[{"text": "收到"}]` |

我第一版只处理字符串，遇到 multimodal 的列表会拿不到内容。
代码里的 `_pick_content()` 就是干这个的，**有注释钉着，别顺手"简化"掉。**

> 代码里 `ENDPOINT_HINTS` 登记了上面这张实测表；
> 没登记的模型**自动两个端点都试**，试通就写进缓存 —— 不靠猜。

### 1.3 免费额度（关键数字）

| 服务 | 模型 | 免费额度 | 有效期 | 是否共享 |
|---|---|---|---|---|
| **语音识别 ASR** | `paraformer-v2` | **10 小时/月** | **每月 1 日自动重置** | — |
| 文本生成 | 各模型**分别** 1M tokens | 1M tokens | 开通后 90 天 | ❌ **不共享**，一个模型一份 |

**⚠️ ASR 和其它文本模型的重置规则不同，这是官方文档里的一个例外：**

- 文本模型额度：**一次性** 90 天，用完就没有，不会每月回来
- ASR（Paraformer）：**每月 1 日重置**，是订阅式的

所以对「每天跑几条视频」这个用法，**ASR 是可持续的**，文本额度才是会耗尽的那个。

### 1.4 你账号的 10 个模型（2026-09-26 截图核对）

| 模型名 | 端点家族 | 免费额度 | 用完即停 |
|---|---|---|---|
| `qwen3.8-27b` | multimodal | 1M / 1M | 未开启 |
| `qwen3.7-flash-2026-07-15` | multimodal | 1M / 1M | 未开启 |
| `qwen3.8-flash` | multimodal | 1M / 1M | 未开启 |
| `kimi-k3` | multimodal | 1M / 1M | 未开启 |
| `deepseek-v4-flash-0731` | text | 1M / 1M | 未开启 |
| `qwen3.8-max-0902` | multimodal | 1M / 1M | 未开启 |
| `deepseek-v4.1-flash` | multimodal | 1M / 1M | 未开启 |
| `glm-5.3` | text | 1M / 1M | 未开启 |
| `deepseek-v4-pro-0813` | text | 1M / 1M | 未开启 |
| `qwen3.8-2.4t-a95b` | multimodal | 1M / 1M | 未开启 |

**⚠️ 你的账号里没有 `qwen-plus`。** 我原来把它当"默认模型"硬编码，
实测返回 `AllocationQuota.FreeTierOnly`（免费额度已耗尽）。别再用这个名。

**⚠️「用完即停」全部是「未开启」状态。** 这意味着额度用完后会**继续调用并扣费**。
建议去控制台把它打开（见 §1.7）。

### 1.5 价格（超出免费额度后）

| 服务 | 单价 | 备注 |
|---|---|---|
| Paraformer ASR | **0.6 元/小时** | 按音频时长计费 |
| 文本模型 | 各模型不同 | 见控制台；本项目单次消耗很小（见下） |

### 1.6 成本实算：100 条 2 分钟的视频

| 项 | 用量 | 免费额度 | 占比 |
|---|---|---|---|
| ASR | 100 × 2 min = **3.33 小时** | 10 小时/月 | **33%** |
| 文本（每条约 1350 tokens 输入 + 输出） | 约 **13.5 万 tokens** | 100 万 | **13.5%** |

**合计：0 元。** 100 条视频跑完，ASR 用掉三成、文本用掉一成多，都还在免费线内。

**什么时候会花钱：** 当月累计超过 **300 分钟（5 小时）** 音频后，
每多 1 小时 0.6 元。也就是要跑到**第 251 条左右**才开始触及免费边界。

**代码里的保护：** `--budget-seconds` 参数会在开跑前估算本批用量，
超过就**拒绝启动**并说明原因。默认值就是 10 小时免费额度。
本地台账 `tools/usage.json` 按自然月累计，跨月自动归零（和云端重置对齐）。

### 1.7 ASR 接口的硬性要求（实测）

| 要求 | 不满足时 | 说明 |
|---|---|---|
| 模型名必须是 `paraformer-v2` | 404 | **不是** `paraformer-realtime-v2` |
| 音频必须是**公网 HTTP/HTTPS URL** | 拒绝 | 官方原文：「不支持 Base64 编码或本地文件路径」 |
| 必须带 `X-DashScope-Async: enable` | **403** | 见下 |

**关于 `X-DashScope-Async` 的实测证据：**

漏掉这个 header 时，返回的是：

```
403 AccessDenied: current user api does not support synchronous calls
```

报错说的是「本用户的 api 不支持同步调用」——
也就是说，**这个 key 根本不允许同步调用**，异步是硬性要求，不是可选优化。

（我第一次试的时候带了 header → HTTP 200，拿到 `task_id`；
第二次忘了带 → 403。同一个 key、同一个请求体，差别只在这个 header。）

**⚠️ 这个报错也很容易误判：** 看到 `AccessDenied` 第一反应是"没权限/没额度"，
实际只是"你这个调用方式不对"。**它跟额度完全无关。**

### 1.8 模型下线时间表

百炼会定期下线旧命名模型。已知的两批：

| 日期 | 内容 |
|---|---|
| 2026-07-13 | 下线 `qwen-turbo`、`qwen-vl-max`、`qwq-plus` 等 10 个 |
| 2026-10-10 | 再下线一批（公告编号 118177） |

**这对本项目的意义：** 模型名**不能硬编码**。
代码里 `DEFAULT_SUMMARY_MODELS` 是个**候选链**，第一个不行自动降级到下一个；
`--list-models` 让你随时问「我这个 key 现在能用哪些」。
**模型名失效时，跑一次 `--list-models` 就知道该换成什么。**

### 1.9 常见报错对照表

| 报错 | 真实含义 | 怎么办 |
|---|---|---|
| `InvalidParameter: url error, please check url！` | **端点家族选错**（不是 url 问题！） | 换另一个端点 |
| `AccessDenied: does not support synchronous calls` | 漏了 `X-DashScope-Async: enable` | 补 header |
| `Endpoint.AccessDenied` | 用错域名（专属域名对该 key 未开通） | 换回公开域名 |
| `AllocationQuota.FreeTierOnly` | 免费额度真的用完了 | 换模型，或下月再来 |
| `Model not exist` / 404 | 模型名已下线 | `--list-models`，换名 |

### 1.10 环境变量（存在服务器 `/root/nexus-core/server/.env`，`chmod 600`）

| 变量 | 说明 |
|---|---|
| `DASHSCOPE_API_KEY` | 百炼 key，ASR + 文本生成共用 |
| `DASHSCOPE_BASE` | **建议留空**（留空=用公开域名）。填专属域名会全 403 |
| `AUTH_TOKEN` | 工作台自己的鉴权 token |

---

## 2. 抖音

| 项 | 值 |
|---|---|
| 下载工具 | `yt-dlp 2026.08.19`（有原生 Douyin extractor） |
| 位置 | `/root/nexus-core/server/tools/venv` |
| Cookie 格式 | **Netscape**（`--cookies` 参数要求） |
| Cookie 必要性 | 无 cookie 时常报 `Fresh cookies (not necessarily logged in) are needed` |

**cookie 的验证在抖音侧。** 我实测过一个**格式正确但内容无效**的 cookie，
报错和「完全没给 cookie」**一模一样** —— 说明服务端不区分这两种情况，
只有抖音自己能判定 cookie 是否有效。

**这带来两个结论：**
1. 我无法伪造 cookie，也不需要伪造（验证不在我这边）
2. cookie 过期时，你会看到和「完全没登录」相同的报错，这是正常的

**⚠️ cookie 会过期。** 目前没有自动刷新机制，过期了需要重新导出一份。
导出方式和文件格式见 `docs/COOKIE-AND-KEY.md`。

---

## 3. 服务器

| 项 | 值 |
|---|---|
| 地址 | `8.134.190.49` |
| 域名 | `nexus.kotete.xyz` |
| 系统 | Ubuntu 24.04 |
| Node | v22.23.2 |
| Python | 3.12.3 |
| ffmpeg | 6.1.1-3ubuntu5 |
| 出网带宽 | **实测约 424 KB/s**（这是限制批量速度的主因） |

**pm2 服务：**

| 名称 | 端口 |
|---|---|
| `drop` | 3460 |
| `nexus-api` | 3458 |
| `nexus-tts` | — |
| `reader` | — |

### 3.1 临时音频托管 `/asrtmp/`

ASR 要求音频走公网 URL，所以转写期间音频会短暂地放在 nginx 静态目录里。

| 项 | 值 |
|---|---|
| 目录 | `/var/www/asrtmp` |
| 公网前缀 | `https://nexus.kotete.xyz/asrtmp` |
| 文件名 | `secrets.token_urlsafe(24)` 随机 |
| 生命周期 | **转写完立即删除**（成败都删） |

**两个反复踩到的 nginx 坑（已写进 `tools/nginx-asrtmp.conf` 注释）：**

| 错法 | 症状 | 真因 |
|---|---|---|
| 白名单正则**嵌**在 `location /asrtmp/` 里 | **301** 跳到 `/asrtmp/x.m4a/` | 嵌套正则 + alias 语义混乱 |
| 兜底用 `location ^~ /asrtmp/` | 合法音频也 **403** | `^~` 匹配后**跳过所有正则求值**，白名单正则根本没被执行 |

正解是**两个平级的 location**：正则白名单 + 普通前缀兜底。

---

## 4. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-26 | 建档。记录公开域名 vs 专属域名的实测差异、两个端点家族及响应体差异、ASR 10h/月与文本 1M/90 天的区别、10 个模型的端点归类、`X-DashScope-Async` 的实测证据、ngora 两个坑 |

---

## 附：怎么自己核对这些数字

```bash
# 1. 看 key 现在能用哪些模型（每个只花 1 个 token）
ssh root@8.134.190.49 'cd /root/nexus-core/server && set -a; . ./.env; set +a; \
  python3 tools/douyin_pipeline.py --list-models'

# 2. 看本月 ASR 用了多少 / 还剩多少
ssh root@8.134.190.49 'cat /root/nexus-core/server/tools/usage.json'

# 3. 看当前生效的域名（值已脱敏）
ssh root@8.134.190.49 'grep -o "^[A-Z_]*=" /root/nexus-core/server/.env'
```

**数字会变。** 额度、价格、模型名都可能调整。
这份文件是**快照 + 核对方法**，不是永久真理 —— 拿不准的时候，用上面三条命令实测。
