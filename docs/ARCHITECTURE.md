# nexus-core 技术栈与架构说明

> 版本：`4cc9bf0`（2026-09-26 安全复审后）
> 线上：https://nexus.kotete.xyz
> 本文件描述「现在是什么样」，不是「应该是什么样」。设计红线和已知欠债都如实写。

---

## 一、一句话概括

一个**单人自用**的个人数据台（记账 / 投资 / 任务 / 日记 / 灵感 / 阅读 / 象棋），
前端是**一个 7,704 行的 `index.html`**，后端是**一个 942 行的 `server.js`**，
除了 Express 和 cors **没有任何第三方运行时依赖**。

核心取舍是：**用「零构建」换「改完就能上」**。
不引入构建工具、不引入框架、不引入 CDN —— 代价是单文件很大，
收益是 `git pull` 就等于部署，且十年后还能跑。

---

## 二、技术栈（全部实测确认）

### 前端

| 项 | 选型 | 为什么是这个 |
|---|---|---|
| 形态 | 单文件 SPA，`index.html` 内联全部 HTML/CSS/JS | 无构建步骤，`git pull` 即部署 |
| 框架 | **无**。原生 DOM + 手写渲染函数 | 避免依赖链老化；个人项目不需要虚拟 DOM |
| 样式 | 原生 CSS + CSS 变量设计令牌 | `--accent` / `--ease` / `--fs-display` 等；换肤只改一处 |
| 图标 | 内联 SVG（`icon(name, size)` 工厂函数） | 不请求任何图标字体 |
| 构建 | **无**。没有 webpack/vite/rollup | 这条是红线 |
| CDN | **无**。所有资源本地内联 | 断网、被墙都能用 |
| 持久化 | `localStorage`（`nexus_*` 前缀）+ 可选服务端 KV 同步 | 离线优先，服务端是可选的 |
| 图表 | 手写 SVG / canvas（`sparkline`、进度环） | 不引 Chart.js |

**红线**：`index.html` 必须能双击直接打开就干活。任何需要「先 build」的方案都被否决过。

### 后端

| 项 | 选型 | 为什么是这个 |
|---|---|---|
| 运行时 | **Node.js 22**（线上 v22.23.2） | `node:sqlite` 需要 22+ |
| Web 框架 | Express 4 | 唯一两个依赖之一 |
| 数据库 | **`node:sqlite` 的 `DatabaseSync`**（Node 内置） | **关键决策**：`better-sqlite3` 需要编译原生模块，在国内网络下二进制下载几乎必失败。内置模块零安装 |
| 原生模块 | **零** | 同上。这是能在一台裸机上一次装成的根本原因 |
| 依赖总数 | `express` + `cors`（2 个） | — |
| 数据模式 | WAL（Write-Ahead Logging） | 读写不互斥，单人场景足够 |
| 压缩 | **Node 内置 `zlib`** 的 `gzipSync` | 不引 `compression` 中间件；启动时预压缩 |
| 缓存协商 | 自己算 `sha1` ETag + `Cache-Control: no-cache` | 手写 304，不引 `etag` 包 |
| 实时推送 | **SSE**（Server-Sent Events） | 比 WebSocket 简单，单向足够（AI 报告流式输出） |
| 鉴权 | 固定 Bearer Token + `crypto.timingSafeEqual` | 单人使用，不需要用户体系 |

### 部署

| 层 | 组件 |
|---|---|
| 边缘 | 阿里云 ESA（CNAME → `*.a1.initxb.com`，TLS 用自传证书） |
| 回源 | `8.134.190.49:443`，Nginx（`/etc/nginx/sites-enabled/nexus`） |
| 证书 | Let's Encrypt（`acme.sh` 自动续期） |
| 反代 | Nginx `location /` → `proxy_pass http://127.0.0.1:3458` |
| 进程 | **pm2**，进程名 `nexus-api` |
| 端口 | **Nginx 外部 3457 / Node 内部 3458**（这两个数不要混） |
| 机器 | 阿里云 2C2G，广州，hostname `iZ7xv0wsl39ujt87g37ae3Z` |

> ⚠️ **注意**：线上**没有** `ecosystem.config.js` 文件。pm2 是当年用 CLI `--env` 起的，
> 配置只存在于 `/root/.pm2/dump.pm2`。这是已知脆弱点（见第五节）。

---

## 三、架构

### 3.1 请求链路

```
浏览器
  │  HTTPS
  ▼
阿里云 ESA 边缘节点（CDN/WAF，CNAME → *.a1.initxb.com）
  │  回源 443
  ▼
Nginx（8.134.190.49:443，Let's Encrypt）
  │  location / → proxy_pass
  ▼
Node / Express（127.0.0.1:3458）
  │
  ├─ 静态：index.html（启动时预压缩 + ETag）
  ├─ 静态：/report/:name（启动时预压缩 + ETag + 文件名白名单）
  └─ /api/*（Bearer Token 鉴权）
        │
        ▼
    node:sqlite（journal.db，WAL）
```

### 3.2 前端内部结构

虽然是单文件，但内部是分层写的，按注释段落可以切开：

```
┌─ CSS ────────────────────────────────┐
│ 设计令牌（:root 变量）                 │
│ 组件样式（.card / .insp-* / .btn）     │
└──────────────────────────────────────┘
┌─ HTML ───────────────────────────────┐
│ 顶部导航（tab 切换）                    │
│ 各 panel（渲染函数按需填充）            │
│ 浮层（灵感库 / 阅读器 / 抽屉）          │
└──────────────────────────────────────┘
┌─ JS ─────────────────────────────────┐
│ ① 工具层    localDate / escHtml / safeUrl / safeFileUrl
│ ② 存储层    Store.get/set（localStorage 包装）
│ ③ 同步层    KV 推送/拉取、冲突收敛、备份
│ ④ 领域层    钱包 / 任务 / 日记 / 灵感 / 投资 / 象棋
│ ⑤ 渲染层    renderPanel() 按 tab 分发
│ ⑥ 入口      boot() + 定时器
└──────────────────────────────────────┘
```

**关键设计**：面板渲染是**按需的**。`renderPanel(name)` 只在切到那个 tab 时调用对应
`renderXxx()`，不是一次性把全部面板渲染一遍。这避免了「数据一多首屏就卡」。

### 3.3 数据通道（这是整个项目最容易搞错的地方）

有**三条独立的持久化通道**，各自解决不同问题：

```
通道 A：localStorage（本地，始终存在）
   nexus_tasks, nexus_wallet, nexus_inspirations …
   离线可用，是数据的「本体」

通道 B：KV 同步（可选，/api/kv）
   把 A 里的白名单键推送到服务器
   17 个键在 SYNC_KEYS 里，per-key 最后写入者胜
   冲突判定用「客户端毫秒时间戳」放在 _kv_meta

通道 C：日记 API（/api/entries，服务端 SQLite）
   日记**故意不在** SYNC_KEYS 里
   原因：日记走专属 REST API，如果同时进 KV 通道，
        两个通道写同一条数据会互相覆盖
```

#### SYNC_KEYS 白名单（17 个）

```
tasks, wallet, courses, completionLog, dailyLog,
dailyTemplates, profile, aiReports, aiModel,
investJournal, scheduleOverride, budget, inspirations,
videos, investments, investShots, gadgets
```

**故意排除**：
- `journal` —— 走通道 C，避免双写覆盖
- `investQuotes` —— 行情缓存，随时可重拉；同步只会让两台设备互相覆盖，还把日志表撑大

#### 文件存储

图片走 `/api/files/:id`，**读取故意不鉴权**。
理由：URL 里的 `id` 是 32 位十六进制（`crypto.randomUUID` 级别不可猜），
本身就是一个 capability URL。这样 `<img src>` 才能直接加载（浏览器不会给你带 Authorization 头）。
上传和删除**需要** token。

### 3.4 同步的冲突收敛

```
前端改动 → kvTouch(key) 写入 Date.now() 到 nexus_kv_meta
        → 把 {key: {value, updatedAt}} PUT /api/kv

服务端：ts >= cur.updated_at  → 写入，进 applied
        ts <  cur.updated_at  → 不进库，进 conflicts 返回给前端
        （相等也写入 —— 相等时原来是静默丢弃，见第四节）

前端拿到 conflicts → 用服务端值覆盖本地（服务端权威）
```

> ⚠️ 相等时间戳的行为在 `4cc9bf0` 有过修正。原实现 `>` / `<` 两个分支都不覆盖
> `ts === cur.updated_at`，导致同毫秒双写**不报错也不写库**，是真实的数据丢失路径。

### 3.5 路由全清单

```
静态（无需鉴权）
  GET  /report                报告列表页
  GET  /report/:name          报告正文（文件名白名单 /^[A-Za-z0-9._-]+\.html$/）
  GET  /                      前端 index.html

免鉴权 API
  GET  /api/files/:id         读文件（capability URL）
  GET  /api/public/:key       白名单键的公开只读（键名 JS 侧硬编码白名单）

鉴权 API（app.use('/api', ...) 之后）
  日记
    GET    /api/entries
    GET    /api/entries/:date
    PUT    /api/entries/:date
    DELETE /api/entries/:date
    POST   /api/entries/import
  KV
    GET    /api/kv
    PUT    /api/kv
    DELETE /api/kv/:key
  文件
    POST   /api/files
    DELETE /api/files/:id
  其他
    GET    /api/health
    GET    /api/link-title    抓外站标题（LINK_HOSTS 白名单）
    GET    /api/quotes        行情（域名写死 + 6 位代码）
    POST   /api/ai/weekly     SSE 流式代理到本地 Ollama
```

**鉴权边界**：`app.use('/api', authMiddleware)` 注册在第 279 行；
`GET /api/files/:id`（252 行）和 `GET /api/public/:key`（391 行）在它**之前**。
这个顺序是**故意**的，改动时要小心。

---

## 四、`4cc9bf0` 这轮修了什么（安全复审结果）

完整复审 + 修复，全部有回归测试。**106 项测试 + 6 项新增加固回归**。

### 已修

| # | 问题 | 位置 | 严重度 | 修法 |
|---|---|---|---|---|
| 1 | `inspViewImage` 拼 `innerHTML`，`fileUrl` 来自 KV 同步的任意字符串 → **存储型 XSS** | `index.html` | **P0** | 改 `createElement`；新增 `safeFileUrl()` 只放行 `/api/files/<32hex>.<ext>` |
| 2 | `renderQuickCats` 分类名未转义（`onclick` 属性） | `index.html` | P1 | 补 `escAttr` + `escHtml` |
| 3 | `inspSetTagFilter` 标签未转义 | `index.html` | P1 | 同上 |
| 4 | 500 响应回显 `e.message`；`NODE_ENV` 未设时 body-parser 的 `SyntaxError` **堆栈含绝对路径** | `server.js:293` | P1 | 统一回 `'internal error'` + 全局 error handler |
| 5 | KV 相等时间戳**静默丢写却报 `ok:true`** → 真实数据丢失 | `server.js:425` | P1 | `>` 改 `>=` |
| 6 | `fetchCapped` 用 `redirect:'follow'`，**首跳白名单校验被 302 绕过** → 条件性 SSRF | `server.js:525` | P2 | 改 `manual` + 逐跳 `hopGuard(true)` 复查 |
| 7 | `/report/:name` **请求内同步 `gzipSync`** → 阻塞事件循环 | `server.js:180` | P2 | 启动时 `warmReportCache()` 预压缩 |

### 复审查过、确认**没问题**的（不用再担心）

| 项 | 结论 |
|---|---|
| SQL 注入 | **无**。20+ 条 SQL 全部 `?` 占位符或纯静态字面量，无动态表名/列名拼接 |
| 路径穿越 `/report/:name` | **挡得住**。`..%2f` / `%2e%2e%2f` / `..%5c` / `%00` / `....//` 实测全拒 |
| 路径穿越 `/api/files/:id` | **挡得住**。`replace(/[^a-zA-Z0-9._-]/g,'')` 把 `/` 全删，`../../` 塌缩成普通文件名 |
| `LINK_HOSTS` 白名单 | **不可绕**。userinfo（`evil.com@bilibili.com`）、后缀（`bilibili.com.evil.com`）、IDN 实测全拒 |
| `fetchCapped` 字节上限 | **真实字节上限**，流式累加，不信任可伪造的 `Content-Length` |
| `AUTH_TOKEN` 默认回退 | **无**。缺失直接 `process.exit(1)`，不存在 `\|\| 'dev'` 静默放行 |
| `X-Powered-By` | **已关**。线上实测响应头无此项 |

### 已知未修（有意保留 / 待决策）

| 项 | 状态 |
|---|---|
| **`AUTH_TOKEN` 仍是泄漏过的那个值** | 用户选择「先不动」。`/root/.pm2/dump.pm2` 里仍是 `3137...5650`。**建议尽快轮换** |
| 线上无 `ecosystem.config.js` | 配置只在 pm2 dump 里。换机器/重装 pm2 会丢环境变量 |
| `https://qqqqqqiu0804.github.io` 仍在 `CORS_ORIGIN` | 用户已不用 GH Pages，可移除（**功能上无害**，删掉只是更干净） |
| `deploy.sh:155` 读 `.env` 拿端口 | 该文件不存在，恒回退硬编码 `3458`。恰好等于真实值所以「蒙对」，改端口会误报 |
| `entries.updated_at` 用 `datetime('now','localtime')` | 依赖服务器时区。阿里云默认 UTC 的话展示时间会偏 8 小时（冲突判定用 `client_ts`，**不影响收敛**） |
| `parseStamp` 解析空格分隔日期 | Safari 对 `"2026-09-26 10:00"` 解析可能失败（Chrome/Firefox 宽松）。未在 Safari 实测 |

---

## 五、目录结构

```
nexus-core/
├── index.html              前端全部（7,704 行 / 403 KB）
├── README.md               使用与部署说明
├── report/
│   └── 2026-09.html        月报（静态，启动时预压缩）
├── server/
│   ├── server.js           后端全部（942 行）
│   ├── package.json        2 个依赖
│   ├── deploy.sh           回滚安全的部署脚本（支持 --dry-run）
│   ├── DEPLOY.md           部署细节
│   ├── journal.db          SQLite（WAL，线上唯一真数据）
│   └── data/files/         上传的图片
├── tests/
│   ├── ai-report.test.js        31 项（从 index.html 抽真实代码跑）
│   ├── xiangqi-moves.test.js    62 项（象棋走子规则）
│   ├── smoke-server.sh          后端冒烟（gzip/ETag/鉴权）
│   ├── smoke-report.sh          13 项（月报路由/路径穿越）
│   └── smoke-hardening.sh        6 项（本轮安全修复回归）
├── tools/                  辅助脚本
├── docs/                   文档
└── .github/workflows/ci.yml
```

### 数据在哪（重要）

**真实用户数据在 `kv` 表，不在 `entries` 表。**

```
kv 表      ← 15 个键的 JSON（wallet 14.6KB / investments 9.7KB / tasks …
entries 表 ← 只有 5 天日记（2026-09-13 ~ 09-25）
```

看到 `entries=5` **不代表数据丢了**。查数据先看 `kv`。

### 数据库操作注意

- WAL 模式：`journal.db-wal` 有 1.8 MB **是正常的**，不代表未落盘
  （实测 `PRAGMA wal_checkpoint(PASSIVE)` 返回 `0|442|442` = 已 checkpoint，只是文件没截断）
- **备份必须用 `sqlite3 .backup`**，不能裸拷 `.db`（WAL 下会拷到不一致状态）

---

## 六、开发约定

### 加一个数据字段
1. 在 `SYNC_KEYS`（`index.html:1691`）确认是否要让它是同步的
2. 若在 `SYNC_SKIP_KEYS`，说明这是设备本地配置，不同步
3. 同步的键**必须**走 `kvTouch(key)` 打时间戳，否则冲突判定会错

### 加一个后端路由
1. 想清楚要不要鉴权。要 → 放在 `app.use('/api', ...)`（279 行）**之后**
2. 免鉴权的例外只有两类：capability URL、硬编码白名单
3. 静态文件路由**必须**用文件名白名单正则，不能信任 `req.params`

### 加一个前端渲染
- 任何进 `innerHTML` 的字符串：文本用 `escHtml`，属性用 `escAttr`
- 任何进 `href`/`src` 的 URL：`safeUrl`（http/https/mailto）或 `safeFileUrl`
- **别拼 `onclick="fn('+x+')"`** —— 这是历史 bug 的重灾区。用 `escAttr(x)`

### 测试
```bash
cd server && npm test          # 93 项单元测试
npm run test:smoke             # 后端 + 月报 + 加固冒烟
```

### 部署
```bash
bash server/deploy.sh --dry-run   # 先看要做什么
bash server/deploy.sh             # 真部署（自动备份 + 测试 + 回滚提示）
```

> ⚠️ **本机网络**：GitHub 被代理挡（`CONNECT tunnel failed, 502`）。
> `git push` 会失败。替代路径：`git bundle` + `scp` + 服务器 `git fetch <bundle>` + `merge --ff-only`。
> 本地 curl 访问自己的域名要加 `--noproxy '*'`。

---

## 七、这套架构的边界（说人话的优缺点）

### 好的地方
- **零依赖**：一个 Node 22 + 两个 npm 包就是全部。国内网络能一次装成
- **零构建**：改 HTML 存盘即生效，手机上都能改
- **离线优先**：localStorage 是本体，服务端挂了照样记账
- **可读**：没有抽象层，`grep` 就能找到任何逻辑

### 代价（不是 bug，是取舍）
- **单文件 7,700 行**：编辑器里跳转靠搜索，没有模块边界
- **手写渲染**：每次都要自己记得转义，容易漏（本轮 3 个 XSS 就是这么来的）
- **无用户体系**：单 token，泄漏即全开
- **同步是 LWW**（最后写入者胜）：没有 CRDT，时间戳错了就是数据错

### 如果重来
不会改。这个项目的**真实约束**是「一个人、网络差、要能立刻改」，
单文件 + 零依赖恰好是最优解。模块化会带来构建步骤，
而构建步骤在国内网络下就是「改不动」。
