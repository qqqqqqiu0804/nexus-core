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
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://qqqqqqiu0804.github.io';

// ===== 数据库 =====
// journal.db 会自动生成在 server/ 目录。备份 = 复制这个文件。
const db = new DatabaseSync(path.join(__dirname, 'journal.db'));
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ===== 应用 =====
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: CORS_ORIGIN })); // 只放行你的 Pages 域名；localhost:3000 同源访问不受影响
// 只托管前端单文件——不把整个仓库目录（含 journal.db）暴露成静态资源
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

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
    'Access-Control-Allow-Origin': CORS_ORIGIN
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
  console.log(`  AI 周报:  POST ${PORT === 80 ? '' : ':' + PORT}/api/ai/weekly (SSE) → Ollama ${OLLAMA_URL}`);
  console.log(`  CORS 放行: ${CORS_ORIGIN}`);
  console.log(`  数据库: ${path.join(__dirname, 'journal.db')}`);
});
