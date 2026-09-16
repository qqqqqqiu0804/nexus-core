/**
 * nexus-core 日记后端（v1 最小闭环）
 *
 * 学点对照（你定的学习路线 → 本文件怎么体现）：
 * - HTTP：路由 = 「方法 + 路径」对应一个动作。GET 读、PUT 写、DELETE 删。
 * - 中间件：app.use(...) 像流水线，请求进来先过一道道检查（日志 → CORS → 鉴权）。
 * - 数据库：SQLite 单文件（journal.db）。用的是 Node 22 内置的 node:sqlite，
 *   不需要任何原生编译依赖（better-sqlite3 在国内网络下装二进制经常失败，内置版无此烦恼）。
 * - 鉴权：第一版用固定 token（环境变量），请求头带上才放行。JWT 是第二期的作业。
 *
 * 启动：
 *   1) 在 server/ 目录执行 npm install
 *   2) 设置环境变量 AUTH_TOKEN（自己编一个长随机串）：
 *        Windows PowerShell:  $env:AUTH_TOKEN="你的token"; npm start
 *        Windows CMD:         set AUTH_TOKEN=你的token && npm start
 *   3) 浏览器打开 http://localhost:3000 —— 前端后端同源，日记全功能可用
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { DatabaseSync } = require('node:sqlite');

// ===== 配置 =====
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.AUTH_TOKEN;
if (!TOKEN) {
  console.error('[启动失败] 请设置 AUTH_TOKEN 环境变量（自己编一个长随机串）');
  process.exit(1);
}
// GitHub Pages 的页面是 HTTPS，调本机 HTTP API 属于跨域，需要后端明确放行
// 允许的来源，逗号分隔可配多个：Pages 页面、服务器 IP、域名（HTTP/HTTPS）都算跨域来源
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'https://qqqqqqiu0804.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);
// SSE 端点要手动写响应头，这里挑出与请求匹配的来源
function allowedOrigin(req) {
  const o = req.headers.origin;
  return (o && CORS_ORIGINS.includes(o)) ? o : CORS_ORIGINS[0];
}

// ===== 数据库 =====
// 默认 journal.db 生成在 server/ 目录。备份 = 复制这个文件。
// DB_PATH 环境变量可改路径——**跑测试时务必指向临时文件**，
// 免得误删/误写真实数据（2026-09-14 有过一次教训）。
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, 'journal.db'));
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;'); // 写入性能优化，断电也不丢已提交数据
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL UNIQUE,          -- YYYY-MM-DD，一天一篇
    content    TEXT NOT NULL DEFAULT '',
    chars      INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
`);

const stmts = {
  all: db.prepare('SELECT date, content, chars, updated_at FROM entries ORDER BY date DESC'),
  get: db.prepare('SELECT date, content, chars, updated_at FROM entries WHERE date = ?'),
  upsert: db.prepare(`INSERT INTO entries (date, content, chars) VALUES (?, ?, ?)
                      ON CONFLICT(date) DO UPDATE SET content = excluded.content,
                      chars = excluded.chars, updated_at = datetime('now','localtime')`),
  del: db.prepare('DELETE FROM entries WHERE date = ?')
};

// ===== 文件存储（灵感库的图片）=====
// 图片走独立文件接口而不是 KV：KV 传的是 JSON 文本，塞不下二进制。
// 元数据（含 fileId）仍走 KV 同步，所以换设备能看到卡片、按需拉图。
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    mime       TEXT NOT NULL DEFAULT '',
    size       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);
const fileStmts = {
  put: db.prepare('INSERT OR REPLACE INTO files (id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?)'),
  get: db.prepare('SELECT * FROM files WHERE id = ?'),
  del: db.prepare('DELETE FROM files WHERE id = ?'),
  list: db.prepare('SELECT id, name, size, created_at FROM files ORDER BY created_at DESC')
};
// 单张图上限（base64 后约 1.33 倍，前端会先压到长边 1600px）
const MAX_IMG_BYTES = 8 * 1024 * 1024;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ===== 应用 =====
const app = express();
app.use(express.json({ limit: '12mb' })); // 图片 base64 上传需要更大的体积上限
app.use(cors({ origin: CORS_ORIGINS })); // 白名单内多个来源；同源访问不受影响
// 只托管前端单文件——不把整个仓库目录（含 journal.db）暴露成静态资源
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

// GET /api/files/:id —— 读图（**故意放在鉴权之前**（**免鉴权**：<img> 标签没法带 Authorization 头，
// 靠 32 位十六进制随机 id 当能力凭证；这也意味着拿到链接的人能看到图）
app.get('/api/files/:id', (req, res) => {
  const id = String(req.params.id).replace(/[^a-zA-Z0-9._-]/g, '');
  const row = fileStmts.get.get(id);
  const p = path.join(FILES_DIR, id);
  if (!row || !fs.existsSync(p)) { res.status(404).json({ error: '文件不存在' }); return; }
  res.type(row.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');   // id 不变，内容就不变
  res.sendFile(p);
});

// 鉴权中间件：只保护 /api/*，静态文件不拦
app.use('/api', (req, res, next) => {
  const auth = req.get('Authorization') || '';
  if (auth !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: '未授权：token 缺失或不正确' });
  }
  next();
});

// 小工具：包一层 try/catch，数据库出错统一返回 500，不让进程崩
const wrap = fn => (req, res) => {
  try { res.json(fn(req, res)); }
  catch (e) { console.error(e); res.status(500).json({ error: String(e.message || e) }); }
};

// ===== 日记 API =====

// GET /api/entries —— 全量日记（单人使用量级很小，直接全给，前端做搜索/统计）
app.get('/api/entries', wrap(() => stmts.all.all()));

// GET /api/entries/:date —— 某一天的日记
app.get('/api/entries/:date', wrap(req => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');
  return stmts.get.get(date) || null;
}));

// PUT /api/entries/:date —— 写/改某一天（同一天重复写 = 覆盖更新）
app.put('/api/entries/:date', wrap(req => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');
  const content = String(req.body?.content ?? '');
  const info = stmts.upsert.run(date, content, content.length);
  return { ok: true, changes: Number(info.changes) };
}));

// DELETE /api/entries/:date
app.delete('/api/entries/:date', wrap(req => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');
  return { ok: true, changes: Number(stmts.del.run(date).changes) };
}));

// POST /api/entries/import —— 旧 localStorage 日记一次性导入（事务：全成功或全回滚）
app.post('/api/entries/import', wrap(req => {
  const list = Array.isArray(req.body?.entries) ? req.body.entries : [];
  const valid = list.filter(e => e && DATE_RE.test(e.date) && typeof e.content === 'string');
  db.exec('BEGIN');
  try {
    for (const e of valid) stmts.upsert.run(e.date, e.content, e.content.length);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK'); // 出错全回滚，不会导一半
    throw err;
  }
  return { ok: true, imported: valid.length, skipped: list.length - valid.length };
}));

// ===== KV 存储 API（v2：让服务器接管全部前端数据）=====
// 为什么用 KV 而不是给每种数据建表？
//   前端数据形状变化很快（今天加记账、明天加习惯），KV 让它零成本演进：
//   前端存什么后端就存什么，不用改表结构。代价是失去 SQL 查询能力——
//   对「单人使用 + 全量读取」这个量级来说，不亏。
// 合并策略：逐键「后写胜出」(last-write-wins)，按客户端 updatedAt 毫秒数比较。
//   冲突时**不覆盖服务端**，而是把服务端的值回给前端，由前端更新本地——
//   这样两端永远收敛到同一状态，不会各说各话。这也是旧 JSONBin 方案最大的缺陷：
//   它只会整体覆盖，导致 2026-09-13 那次数据丢失事故。
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,      -- JSON 字符串
    updated_at INTEGER NOT NULL    -- 客户端写入时间（毫秒时间戳）
  );
`);

const kvStmts = {
  all: db.prepare('SELECT key, value, updated_at FROM kv'),
  get: db.prepare('SELECT value, updated_at FROM kv WHERE key = ?'),
  put: db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                   updated_at = excluded.updated_at`),
  del: db.prepare('DELETE FROM kv WHERE key = ?')
};

// GET /api/kv —— 全量读出（单人量级，直接全给，合并交给前端）
app.get('/api/kv', wrap(() => {
  const data = {}, meta = {};
  for (const r of kvStmts.all.all()) {
    try { data[r.key] = JSON.parse(r.value); meta[r.key] = Number(r.updated_at); }
    catch { /* 坏数据跳过，不影响其它键 */ }
  }
  return { ok: true, data, meta };
}));

// PUT /api/kv —— 批量合并写入
app.put('/api/kv', wrap(req => {
  const items = req.body?.items;
  if (!items || typeof items !== 'object') throw new Error('缺少 items');
  const applied = [], conflicts = {};
  db.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries(items)) {
      if (!k || typeof v !== 'object' || v === null) continue;
      const ts = Number(v.updatedAt) || 0;
      const cur = kvStmts.get.get(k);
      if (!cur || ts > Number(cur.updated_at)) {
        kvStmts.put.run(k, JSON.stringify(v.value ?? null), ts);
        applied.push(k);
      } else if (ts < Number(cur.updated_at)) {
        // 服务端更新 → 回给前端，让前端更新本地（前端负责收敛）
        try { conflicts[k] = { value: JSON.parse(cur.value), updatedAt: Number(cur.updated_at) }; }
        catch { /* 服务端数据坏了，忽略此键 */ }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, applied, conflicts };
}));

// DELETE /api/kv/:key —— 删单个键（前端重置某类数据时用）
app.delete('/api/kv/:key', wrap(req => ({
  ok: true,
  changes: Number(kvStmts.del.run(String(req.params.key)).changes)
})));

// ===== 文件 API（灵感库的图片）=====
// POST /api/files —— 接收 dataUrl（base64），落盘并返回 id。
// 用 base64 而非 multipart：不引入新依赖（multer 在国内网络下装起来容易翻车）。
app.post('/api/files', wrap(req => {
  const { name = '', dataUrl = '' } = req.body || {};
  const m = String(dataUrl).match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('dataUrl 格式不对（应为 data:image/png;base64,...）');
  const mime = m[1];
  if (!mime.startsWith('image/')) throw new Error('只接受图片');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMG_BYTES) throw new Error('图片太大（上限 8MB）');
  const ext = (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
  const id = crypto.randomBytes(16).toString('hex') + '.' + ext;   // 32 hex：不可猜，等于一个「不公开链接」
  fs.writeFileSync(path.join(FILES_DIR, id), buf);
  fileStmts.put.run(id, String(name).slice(0, 200), mime, buf.length, Date.now());
  return { ok: true, id, url: '/api/files/' + id, size: buf.length };
}));

// DELETE /api/files/:id —— 同时删记录与磁盘文件
app.delete('/api/files/:id', wrap(req => {
  const id = String(req.params.id).replace(/[^a-zA-Z0-9._-]/g, '');
  const row = fileStmts.get.get(id);
  if (!row) return { ok: true, changes: 0 };
  try { fs.unlinkSync(path.join(FILES_DIR, id)); } catch {}
  fileStmts.del.run(id);
  return { ok: true, changes: 1 };
}));

// POST /api/ai/weekly —— AI 周报（流式）。
// 学点：SSE（Server-Sent Events）。前端 fetch 拿到的不是一次性 JSON，
// 而是 ReadableStream——后端从 Ollama 的 JSON-lines 流里逐个抠出 token，
// 以 `data: {...}\n\n` 的格式边收边转发，前端打字机效果就是这么来的。
// Ollama 是本地进程，浏览器直连会被 CORS 拦，所以由后端代理（后端没有同源限制）。
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

app.post('/api/ai/weekly', async (req, res) => {
  const { model = 'qwen2.5:7b', system, user } = req.body || {};
  if (!user) { res.status(400).json({ error: '缺少 user 提示词' }); return; }

  // SSE 响应头：text/event-stream 是协议约定，no-cache 禁止中间层缓冲
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': allowedOrigin(req)
  });
  const send = (event, data) => res.write(`data: ${JSON.stringify({ event, data })}\n\n`);

  let ollamaRes;
  try {
    ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: 'system', content: system || '你是学生的个人周报助手，用简洁的中文输出。' },
          { role: 'user', content: user }
        ]
      })
    });
    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text().catch(() => '');
      send('error', `Ollama 返回 ${ollamaRes.status}：${errText.slice(0, 200)}（模型名是否正确？）`);
      return res.end();
    }
  } catch (e) {
    send('error', `连不上 Ollama（${OLLAMA_URL}）：${e.message}。确认已运行 ollama serve。`);
    return res.end();
  }

  // Ollama 的流是「每行一个 JSON」；逐行解析，只转发新增的文字
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of ollamaRes.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          if (j.message?.content) send('token', j.message.content);
          if (j.done) send('done', { total_duration: j.total_duration });
        } catch { /* 忽略不完整行 */ }
      }
    }
  } catch (e) {
    send('error', `流中断：${e.message}`);
  }
  res.end();
});

app.listen(PORT, () => {
  console.log(`[nexus-core server] 已启动 → http://localhost:${PORT}`);
  console.log(`  日记 API: http://localhost:${PORT}/api/entries`);
  console.log(`  KV 同步:  GET/PUT http://localhost:${PORT}/api/kv`);
  console.log(`  文件 API: POST/GET http://localhost:${PORT}/api/files`);
  console.log(`  文件目录: ${FILES_DIR}`);
  console.log(`  AI 周报:  POST ${PORT === 80 ? '' : ':' + PORT}/api/ai/weekly (SSE) → Ollama ${OLLAMA_URL}`);
  console.log(`  CORS 放行: ${CORS_ORIGINS.join(' , ')}`);
  console.log(`  数据库: ${DB_PATH}`);
});
