# nexus-core

个人工作台 —— 一个自托管的单页应用：课表、任务、饮食、记账、投资台账、随手记、灵感库、视频收藏、每日象棋。数据全部躺在自己的服务器上。

线上：**https://nexus.kotete.xyz**

---

## 快速开始

```bash
cd server
npm install
AUTH_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm start
```

浏览器开 **http://localhost:3458** —— 后端顺手把 `../index.html` 也托管了，同源访问，全部功能可用。

**环境要求**：Node.js **22+**（`node:sqlite` 需要；本地实测 v22.23.2）。
不需要构建工具、不需要 Docker、不需要数据库服务。

---

## 它长什么样

| | |
|---|---|
| 前端 | 一个 `index.html`（HTML / CSS / JS 全内联，**没有构建步骤、没有框架、没有依赖、没有 CDN**） |
| 后端 | `server/server.js`（Node 22 + Express 4 + 内置 `node:sqlite`，**零原生模块**） |
| 依赖总数 | **2 个**（`express` + `cors`） |
| 体量 | `index.html` 8,175 行 / 429 KB（gzip 后 136.8 KB，省 68%）；`server.js` 946 行 |
| 部署 | 阿里云 ESA 边缘 → Nginx → Node，pm2 守护 |

单文件前端不是行为艺术，是刻意的：**改完直接上线就生效**，不需要装 node_modules、不需要 build、不需要 CDN。

> **红线**：`index.html` 必须能双击直接打开就干活。任何需要「先 build」的方案都被否决过。

---

## 功能

**今日**（`panel-daily`）—— 默认落地页，聚合当天要处理的事。含 4 个**可折叠区块**（有数据自动展开、无数据折成一行，手动点过就记住你的选择）：

- **饮食** —— 一餐可以记多条（午餐吃了两样就记两条），**卡路里选填**；「常吃」从你自己的历史里自动学出来，点一下就能记一条；按当前时段自动预选餐次。
- **支出** —— 快速记账入口，收支流水进账本。
- **英语** —— 每日六级词汇 / 短句。
- **象棋** —— 每日残局闯关，见下方专节。

外加：**任务**（周期任务 + 限时任务，聚合出"今天要做的"；完成记录进 `completionLog`，连续签到算 `streak`；周期任务按 `seriesId` 串联，未到期的副本不显示）、**随手记**（memos / flomo 那种，一天可以记多条，每条自动带时间戳，`Ctrl/⌘ + Enter` 或点「记下」即存）。

**课表**（`panel-courses`）—— 内置 2026-2027-1 学期全量课程。两套作息按月份自动切换（5–9 月夏季、10 月起春秋冬季）；能识别**假期**（放假当天不显示课，改标假期）和**调休补课**（表头标"补课"并说明补的是哪一周的课）；周视图 / 日视图 / 明日预告 / 下周预告四个视角。

**账本**（`panel-data`）—— 钱包记账（收支流水、分类占比、6 个月趋势、月度预算）、投资台账、历史日历、日记归档（按月 / 搜索）。

**投资台账** —— 手填一个「投资市值」答不了"赚了还是亏了"。现在按笔记：只要抄**持有金额**和**持仓收益**两个数，成本自动反推（`成本 = 持有金额 − 持仓收益`），份额则按 `持有金额 ÷ 当日净值` 倒着算 —— **不必知道份额，市值照样能每天自动更新**。基金净值取自东方财富，金价取自上海黄金交易所（用日线收盘价，跟算"日均涨跌"的历史同源；分时接口在非交易时段会自相矛盾）。行情接口**只收 6 位数字代码、域名写死**，不会变成公网上的 SSRF 跳板。每笔给出盈亏与收益率；亏着的时候给「还差 ¥X 回本 · 需涨 Y%」，下面再附一行按近 30 个交易日速度的**数学外推** —— 写着"外推，不是预测"，走势向下时直说算不出来，不编数字。

> 手机上抄那些数字很烦，所以支持**传持仓截图**（一次可选多张，浏览器里压到 1800px 再传）。图只落在你自己的服务器上，识别交给对话里的 AI —— 这台 2 核 2G 的机器跑不动视觉模型，与其硬塞一个，不如把边界说清楚。

**我的**（`panel-settings`）—— 服务器连接、数据健康条（最近备份时间 + 本机待上传条数）、AI 报告（周报 / 月报）、主题切换、令牌管理。

**灵感库** —— 想法 + 素材图片（图片在浏览器里压到 1600px 再上传）。

**视频收藏** —— 只存链接，**不做播放器**。粘一个链接，或者把整段分享文案（`【标题】https://…`）丢进去，标题会从文案里提出来；文案里没带标题的，服务器代抓（B 站页面给无 Cookie 的请求返回 412，所以走它的公开 view 接口，`b23.tv` 短链也先还原）。能加备注和标签、能搜。

> 为什么不自己托管视频文件：这台服务器出网实测 **424 KB/s（约 3.4 Mbps）**，自己放视频最多只够 480p，还会把工作台和书库的带宽一起吃光。存链接的话视频由原平台的 CDN 分发，服务器零带宽消耗。

**数据面板** —— 日历式历史、日记归档（按月/搜索）、全量导出与导入。

### 每日象棋（今日 → 象棋区块）

题库 **104 题**，取自开源实战棋谱库（`maksimKorzh/wukong-xiangqi` 的 puzzle_generator 数据集，3386 题，原库按「几步将死」分档）。精选后用 `index.html` 里**同一套走法规则**反向验算过：难度标定正确、每题都有正解着法。

局面用坐标写（比 FEN 直观、手写不易错），走法校验器与关卡数据都有测试覆盖（`xiangqi-moves.test.js` 62 项）。

---

## 目录结构

```
nexus-core/
├── index.html                整个前端（单文件，8,175 行）
├── README.md                 你正在看的
├── ecosystem.config.js       pm2 配置（端口/内存上限/重启策略；密钥走 server/.env）
├── report/                   月报页 / 周报页（静态 HTML，丢进来即可）
│   └── 2026-09.html
├── tests/                    全部测例（不需要构建）
│   ├── import-validation.test.js    88 项  导入校验 / 原型污染 / 限流
│   ├── chess-ui.test.js             22 项  象棋界面结构 + 窄屏兜底
│   ├── xiangqi-moves.test.js        62 项  象棋走子规则
│   ├── ai-report.test.js            31 项  报告范围 / 汇总 / 转义
│   ├── mobile-audit.js               5 项  字号 / 根字号 / title / viewport
│   ├── ecosystem-config.test.js     18 项  pm2 配置不变量
│   ├── security-regression.test.js  42 项  安全修复防回归
│   ├── smoke-server.sh              后端冒烟：gzip / ETag / 鉴权
│   ├── smoke-report.sh              月报路由冒烟：/report + 路径穿越防护
│   └── smoke-hardening.sh           安全加固回归：不泄堆栈 / KV 同毫秒不丢写
├── tools/
│   ├── xiangqi-levels.json   象棋题库源数据
│   └── dump-pm2-env.js       从 pm2 dump 导出环境变量（排查用）
├── docs/
│   ├── ARCHITECTURE.md       技术栈与架构说明（含逐轮安全修复台账）
│   ├── CHESS-UI-REDESIGN.md  象棋界面视觉重构：几何/配色实测 + 样式速查
│   └── PLAN-security-recheck.md  安全复审计划与逐条对照
├── .github/workflows/ci.yml  CI：跑全部测例 + 语法检查，无构建步骤
└── server/
    ├── server.js             整个后端（946 行）
    ├── package.json          2 个依赖
    ├── deploy.sh             安全部署（先验证再重启，失败即中止；支持 --dry-run）
    ├── README.md             后端说明 + API 一览 + 环境变量
    ├── DEPLOY.md             从买服务器到上线的作战手册
    ├── .env.example          环境变量模板（可入库；真实 .env 不入库）
    ├── journal.db            SQLite 数据文件（备份 = 用 .backup 导它，别裸拷）
    └── data/files/           上传的图片
```

---

## 关键命令

| 目的 | 命令 |
|---|---|
| 装依赖 | `cd server && npm install` |
| 本地起服务 | `cd server && AUTH_TOKEN=xxx npm start` |
| 跑全部单元测例 | `cd server && npm test` （268 项） |
| 跑冒烟测试 | `cd server && npm run test:smoke` （真起服务） |
| 安全防回归 | `node tests/security-regression.test.js` （42 项） |
| 手机端体验审计 | `node tests/mobile-audit.js` |
| 部署（先演练） | `bash server/deploy.sh --dry-run` |
| 部署（真做） | `bash server/deploy.sh` |

### 测试怎么写的

**所有前端测例都从 `index.html` 抽取真实代码段求值**，测的是同一份实现，不是复制品。
所以改了 `index.html` 就不可能「测过了但还是坏的」。

变红时**不要改测试去迁就代码** —— 先确认是不是把某个修复改回去了
（`docs/ARCHITECTURE.md` 第四节有逐条对照）。

冒烟脚本会真的把服务起起来，验 gzip 编解码、ETag 304、鉴权矩阵、以及 `/report` 的**路径穿越防护**。
它们固定用 `3995~3999` 端口，避开线上的 3458。

想单独开前端也可以（直接双击 `index.html`），但**必须走 HTTP(S)** 才能连后端；
`file://` 下浏览器会拦跨域请求。

---

## 数据是怎么存的

三层，各管各的。这是整个项目最容易搞错的地方：

**① 业务数据 —— KV 双向同步。**
前端所有状态走 `Store`（localStorage + `nexus_` 前缀，这是数据的**本体**，离线可用）。
白名单 `SYNC_KEYS` 里的 **17 个键**会同步到服务器：每次写入记录时间戳，
1.5 秒防抖后整批 `PUT /api/kv`，**逐键比时间戳、后写胜出**；服务端若更新则把服务端版本回传，两端收敛。
首屏加载不算"用户修改"，不会用新设备的默认值覆盖云端。

```
SYNC_KEYS（17 个）
tasks, wallet, courses, completionLog, dailyLog,
dailyTemplates, profile, aiReports, aiModel,
investJournal, scheduleOverride, budget, inspirations,
videos, investments, investShots, gadgets
```

**故意排除**：
- `journal` —— 走通道 ③，两个通道同时写同一条数据会互相覆盖
- `investQuotes` —— 行情缓存，随时可重拉；同步只会让两台设备互相覆盖，还把日志表撑大

`SYNC_SKIP_KEYS` 则是**每台设备各自的配置**，永不同步：服务器地址、令牌、折叠偏好、时间戳元数据。

**② 日记 —— 独立通道，走 SQLite。**
它走 `GET/PUT /api/entries/:date`，服务端存在 `entries` 表里。写入失败会进 `nexus_journalPending` 队列，联网后自动补推，界面上常驻一行提示直到真的传上去。

时间戳是关键：本地 `journalMeta` 记录"本机最后一次改动某天"的时刻，和服务端的 `client_ts` 比大小决定谁赢 —— 没有它就只能后写覆盖，两台设备会互相抹掉。

**③ 文件 —— capability URL。**
图片走 `/api/files/:id`，**读取故意不鉴权**：URL 里的 `id` 是 32 位十六进制，本身就是一个凭证。
这样 `<img src>` 才能直接加载（浏览器不会给你带 Authorization 头）。上传和删除**需要** token。

### 备份

`/root/backup-nexus.sh` 每天 03:00 做 SQLite 快照 + 图片打包，保留 14 天；
「我的」页面的数据健康条会显示最近一次备份是几点（`GET /api/health`）。

> ⚠️ **备份必须用 `sqlite3 .backup`**，WAL 模式下裸拷 `.db` 会拿到不一致状态。
> `journal.db-wal` 有几 MB 是正常的，不代表未落盘。

---

## 接口

`/api/*` 全部需要 `Authorization: Bearer <AUTH_TOKEN>`（**图片读取除外**，见上）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET / PUT / DELETE | `/api/kv` · `/api/kv/:key` | 业务数据的双向同步 |
| GET / PUT / DELETE | `/api/entries/:date` | 日记的读 / 写 / 删 |
| POST | `/api/entries/import` | 日记批量导入 |
| POST / GET / DELETE | `/api/files` | 图片上传（仅 PNG/JPG/WebP，拒绝 SVG 等可执行类型）/ 读取 / 删除 |
| GET | `/api/health` | 备份状态（最近备份时间、份数、库体积） |
| GET | `/api/link-title?url=` | 代抓网页标题（白名单域名，视频收藏用） |
| GET | `/api/quotes` | 行情（域名写死 + 只收 6 位代码） |
| POST | `/api/ai/weekly` | AI 周报 / 月报（SSE，转发到 Ollama） |

完整清单（含免鉴权项与注册顺序的坑）见 **[server/README.md](./server/README.md)**。

---

## AI 报告（周报 / 月报）

「我的」面板 → **AI 报告**，可切换 **周报 / 月报**，左右箭头翻期。

- **数据来源**：全部来自 localStorage（含 `completedArchive` 的任务历史），前端是数据真相源，**后端只当 AI 网关**。
- **算力在你自己的电脑上**。后端通过 `OLLAMA_URL`（默认 `http://localhost:11434`）转发到 Ollama。服务器是 2C2G，跑不动 7B 模型——分工是「服务器管数据，PC 管算力」。也就是说：**手机在外网时，AI 报告需要你家里电脑开着并连上 Ollama**。
- **Ollama 没开也有兜底**：只要后端在跑，生成失败时会自动退回一份**纯统计报告**（完成数、收支分类占比、日记覆盖天数、任务清单），不依赖任何模型。
- 报告存在本机 `aiReports`（最多 30 份），可回看、可删。

> 月报跨 31 天，日记会**按天截断到 400 字**（周报是 1200 字），否则光日记就吃满上下文，模型反而看不到任务和收支。

---

## 月报页

`/report` 下放**只读的静态报告页**，专为手机浏览器看：

| 路径 | 说明 |
|---|---|
| `/report` | 报告列表（按文件名倒序） |
| `/report/2026-09.html` | 具体某期报告 |

放一个新的报告 = 往 `report/` 目录丢一个 `.html`，不用改代码（服务会读目录）。

设计要点：

- 走和 `index.html` 一样的**启动时预压缩 + ETag 协商**
- **文件名白名单** `^[A-Za-z0-9._-]+\.html$`，杜绝 `../` 穿越读到 `journal.db`
- 页面本身**不含任何用户数据查询接口**，是纯静态展示，因此不需要鉴权
  （和 `/api/files/:id` 同样的取舍：能拿到 URL 的人就能看到）

---

## 配置

环境变量优先级：

```
server/.env（不入库，chmod 600）  >  shell 环境变量  >  ecosystem.config.js 里的默认值
```

模板见 [`server/.env.example`](./server/.env.example)。常用项：

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `AUTH_TOKEN` | ✅ | **无（缺失即拒启动）** | 访问令牌。前端在「我的 → 高级设置」填同一个值 |
| `PORT` | | `3458` | Node 监听端口 |
| `CORS_ORIGIN` | | 见示例 | 逗号分隔白名单；同源访问用不到 |
| `DB_PATH` | | `server/journal.db` | SQLite 路径 |
| `DATA_DIR` | | `server/data` | 上传文件目录 |
| `OLLAMA_URL` | | `http://localhost:11434` | AI 报告转发目标 |

> `AUTH_TOKEN` **没有默认值**，不设会直接 `process.exit(1)` 并打印生成命令，
> 而不是带着空 token 跑起来。这是有意的。

### 端口约定

| 角色 | 端口 | 说明 |
|---|---|---|
| Nginx（对外） | **3457** | 安全组/防火墙只需放行这个（备案后改 443） |
| Node 后端（内部） | **3458** | 只监听回环，`proxy_pass` 到这里；**不要对外放行** |

> ⚠️ 这里曾有个坑：`DEPLOY.md` 曾把 `listen` 和 `proxy_pass` 都写成 3457，
> **照抄会让 Nginx 代理自己，形成死循环**。现已修正，改配置前请对照上表。

---

## 部署

从买机器到 HTTPS 上线的完整流程（含踩过的坑）在 **[server/DEPLOY.md](./server/DEPLOY.md)**。

一键安全部署（**先验证再重启**，测试挂了就中止、线上保持旧版本）：

```bash
bash server/deploy.sh --dry-run   # 先看会做什么
bash server/deploy.sh             # 真部署
```

脚本会：备份（含数据库）→ `git fetch` + `merge --ff-only` → `npm ci` → 跑全部测试
→ 检查 Nginx 端口自环 → `pm2 restart` → 线上验证 → **打印回滚命令**。

几个反复踩过、值得记一笔的：

- 国内服务器 **npm 必须换源**（`registry.npmmirror.com`），官方源会卡死
- Nginx 改配置一律**先 `nginx -t` 通过再 reload**，否则一个手滑全站 502
- 域名要能访问，**光备案通过不够**，还得为这台服务器做"接入备案"
- 这台机器**拉不到任何 Docker 镜像**（Docker Hub 被墙、CNB 地址 404）—— 所以凡是能源码跑的服务就别用容器
- **本机开发环境**：GitHub 被代理挡（`CONNECT tunnel failed, 502`），`git push` 会失败。
  替代路径：`git bundle` + `scp` + 服务器 `git fetch <bundle>` + `merge --ff-only`。
  本地 curl 访问自己的域名要加 `--noproxy '*'`

---

## 设计原则

- **一切改动以手机端体验为准** —— 这是本项目的最高约束，高于代码优雅、高于功能完整。改动前先回答：手机上点得到吗？看得清吗？够不够大？（详见 `docs/ARCHITECTURE.md` 第零节）
- **「墨与信号」**：中性墨底 + 单一克制的蓝 accent，语义色只用来标状态；等宽字体只给数据。霓虹光晕、粒子雨、扫描线这些装饰已经全部退役，不复活。
- **不做"看起来完整"的功能**。日程的时间分配、睡眠记录、习惯打卡都曾写出来过，四天零数据 → 直接整块删掉，连同 CSS 和历史记录里的引用一起清干净。**判断一个功能该不该留，看数据，不看当初的设计文档。**
- **记录类功能的第一原则是降低门槛**：饮食不强迫你算卡路里，随手记不要求你写一段话。写不出来的功能等于不存在。
- **单文件前端就该配 gzip + ETag**。429 KB 冷启动下载在移动网络上很浪费，gzip 后 136.8 KB（省 68%），二次访问走 `If-None-Match` 直接 304 零传输。用 Node 内置 `zlib`，**不引入 `compression` 包**——守住「零多余依赖」。压缩在启动时算一次并缓存，不要每请求压。
- **所有插值到 innerHTML 的用户数据必须过 `escHtml` / `escAttr`**。任务标题、课程名这些能粘贴进来的字段都算用户数据；漏一个就是存储型 XSS，而且会经 `/api/kv` 同步到所有设备。**别拼 `onclick="fn('+x+')"`** —— 这是历史 bug 的重灾区。
- **不对外暴露技术栈**。`app.disable('x-powered-by')` —— 默认的 `X-Powered-By: Express` 等于给攻击者一张匹配已知 CVE 的清单，关掉零成本。
- **静态文件路由一律用文件名白名单**，不拼路径。

---

## 文档索引

| 文档 | 什么时候看 |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 想理解技术栈、请求链路、数据通道、字号体系、历轮安全修复 |
| [server/README.md](./server/README.md) | 改后端：完整 API、环境变量、路由注册顺序的坑 |
| [server/DEPLOY.md](./server/DEPLOY.md) | 从零买机器到 HTTPS 上线 |
| [docs/CHESS-UI-REDESIGN.md](./docs/CHESS-UI-REDESIGN.md) | 改象棋界面：几何/配色实测表 + 样式速查 |
| [docs/PLAN-security-recheck.md](./docs/PLAN-security-recheck.md) | 安全复审的逐条对照与结论 |
