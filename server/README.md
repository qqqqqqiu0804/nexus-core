# nexus-core 日记后端

Node/Express + SQLite 的单人日记服务。这是「真后端」学习路线的第一站。

> **要部署到服务器（买机器 → 域名 → HTTPS → 备份）？看 [DEPLOY.md](./DEPLOY.md)** —— 那是照敲即可的作战手册。

## 启动（Windows）

```powershell
cd server
npm install
$env:AUTH_TOKEN = "自己编一个长随机串"   # PowerShell
npm start
```

CMD 用户：`set AUTH_TOKEN=你的token && npm start`

启动后浏览器开 **http://localhost:3000** —— 后端顺带托管了前端（`../index.html`），同源访问，日记全功能可用。

## API 一览

所有 `/api/*` 请求需带请求头 `Authorization: Bearer <AUTH_TOKEN>`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/entries` | 全量日记（含正文） |
| GET | `/api/entries/:date` | 某天日记，`date` 格式 `YYYY-MM-DD` |
| PUT | `/api/entries/:date` | 写/改某天，body `{"content":"..."}` |
| DELETE | `/api/entries/:date` | 删某天 |
| POST | `/api/entries/import` | 批量导入，body `{"entries":[{"date":"...","content":"..."}]}` |

## 数据在哪

`server/journal.db` —— 单文件 SQLite。**备份 = 复制这个文件**（建议顺手扔网盘）。
`journal.db-wal` / `-shm` 是 SQLite 的运行时附属文件，不用管。

## 路线图

- [x] v1：日记 CRUD + 固定 token 鉴权 + 静态托管前端
- [ ] v2：JWT 鉴权（学习：签发/校验/过期）
- [ ] v3：迁移学生机（Nginx + HTTPS 证书），SQLite 文件直接拷走
- [ ] v4：其他模块（任务/打卡）逐步迁后端，练事务
