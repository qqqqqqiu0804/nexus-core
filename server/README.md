# nexus-core 后端

Node 22 + Express 4 + 内置 `node:sqlite`。**946 行，2 个依赖（`express` / `cors`）**，
零原生模块 —— 这是它能在一台国内裸机上一次装成的根本原因。

它不是「日记后端」了：日记只是它管的三个通道之一，它还管 KV 同步、文件上传、
外站标题抓取、行情代理、以及 AI 报告的 SSE 网关。前端整个 `index.html` 也由它托管。

> **要部署到服务器？看 [DEPLOY.md](./DEPLOY.md)** —— 那是照敲即可的作战手册。
> **想理解整体架构？看 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)**。

## 启动

```bash
cd server
npm install
AUTH_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm start
```

启动后浏览器开 **http://localhost:3458** —— 后端顺带托管了前端（`../index.html`），
同源访问，全部功能可用（不只是日记）。

Windows PowerShell 里想手动设 token：

```powershell
$env:AUTH_TOKEN = "自己编一个长随机串"; npm start
```

> ⚠️ `AUTH_TOKEN` **没有默认值**。不设会直接 `process.exit(1)` 并打印生成命令，
> 而不是带着空 token 跑起来（这是有意的）。

### 端口

| 角色 | 端口 |
|---|---|
| Node 后端（内部，`PORT` 可覆盖） | **3458** |
| Nginx 对外 | **3457** |

**这两个数不要混。** 曾把 `listen` 和 `proxy_pass` 都写成 3457，
照抄会让 Nginx 代理自己形成死循环。

## 环境变量

优先级：`server/.env`（不入库，`chmod 600`）> shell 环境变量 > `ecosystem.config.js` 默认值。
模板见 [`.env.example`](./.env.example)。

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `AUTH_TOKEN` | ✅ | 无（缺失即拒启动） | 访问令牌，前端在「我的 → 高级设置」填同一个值 |
| `PORT` | | `3458` | Node 监听端口 |
| `CORS_ORIGIN` | | 见示例 | 逗号分隔白名单；同源访问用不到 |
| `DB_PATH` | | `server/journal.db` | SQLite 路径 |
| `DATA_DIR` | | `server/data` | 上传文件目录 |
| `REPORT_DIR` | | `report/` | 静态报告目录 |
| `BACKUP_DIR` | | `/root/backups` | `/api/health` 读取的备份目录 |
| `OLLAMA_URL` | | `http://localhost:11434` | AI 报告转发目标 |

## 接口一览

除下列**免鉴权**项外，所有 `/api/*` 需带 `Authorization: Bearer <AUTH_TOKEN>`。

### 免鉴权

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/files/:id` | 读图片。`id` 是 32 位十六进制，**本身即凭证**（`<img>` 带不了请求头） |
| GET | `/api/public/:key` | 白名单键的公开只读（键名在 JS 侧硬编码） |

### 鉴权

| 方法 | 路径 | 作用 |
|---|---|---|
| GET / PUT / DELETE | `/api/kv` · `/api/kv/:key` | 业务数据双向同步（逐键比时间戳，后写胜出） |
| GET / PUT / DELETE | `/api/entries/:date` | 日记读 / 写 / 删（`date` 格式 `YYYY-MM-DD`） |
| GET | `/api/entries` | 全量日记 |
| POST | `/api/entries/import` | 日记批量导入 |
| POST / GET / DELETE | `/api/files` | 图片上传（仅 PNG/JPG/WebP，**拒 SVG**）/ 读取 / 删除 |
| GET | `/api/health` | 备份状态（最近备份时间、份数、库体积） |
| GET | `/api/link-title?url=` | 代抓网页标题（`LINK_HOSTS` 白名单，视频收藏用） |
| GET | `/api/quotes` | 行情（域名写死 + 只收 6 位代码） |
| POST | `/api/ai/weekly` | AI 周报 / 月报（**SSE** 流式，转发到 Ollama） |

**鉴权边界**：`app.use('/api', authMiddleware)` 注册在 `server.js:299`，
而 `/api/files/:id`（272 行）和 `/api/public/:key`（417 行）在它**之前**。
这个顺序是**故意**的 —— 改动路由位置时务必小心。

## 数据在哪

```
server/journal.db     ← SQLite 主库。kv 表是真数据，entries 表只有日记
server/data/files/    ← 上传的图片
```

**看到 `entries=5` 不代表数据丢了** —— 记账 / 投资 / 任务这些都在 `kv` 表里。

⚠️ 两个坑：

1. **WAL 模式下不要裸拷 `.db`**，会拿到不一致状态。备份用
   `sqlite3 journal.db ".backup 'xxx.db'"`。
   `journal.db-wal` 有几 MB **是正常的**，不代表未落盘。
2. `journal.db` / `-wal` / `-shm` 和 `data/`、`.env` 都在 `server/.gitignore` 里，
   **不入库**。

## 测试

```bash
cd server
npm test          # 268 项断言，7 个套件（不需要起服务）
npm run test:smoke # 3 套冒烟，会真起服务（需 AUTH_TOKEN）
```

冒烟脚本用固定端口 `3995~3999`，避开线上的 3458。

## 开发约定

**加一个后端路由：**

1. 想清楚要不要鉴权。要 → 放在 `app.use('/api', ...)`（299 行）**之后**
2. 免鉴权的例外只有两类：capability URL、硬编码白名单
3. 静态文件路由**必须**用文件名白名单正则，不能信任 `req.params`
4. 500 响应**不要回显 `e.message`** —— 有全局 error handler 统一回 `'internal error'`

**改完安全相关代码，务必跑防回归：**

```bash
node ../tests/security-regression.test.js   # 42 项
```

变红**不要改测试去迁就代码** —— 先确认是不是把某个修复改回去了
（`../docs/ARCHITECTURE.md` 第四节有逐条对照）。
