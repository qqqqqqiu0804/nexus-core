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
const zlib = require('zlib');
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
// CORS 白名单：逗号分隔可配多个。
// 只有「从 A 域名打开的页面去调 B 域名的 API」才算跨域，同源访问根本不受影响。
// 主入口是 https://nexus.kotete.xyz（手机直接打开它，同源，用不到 CORS），
// 下面这些是「从别的域名/IP 打开页面但连这台服务器」的场景。
// 2026-09-26 移除了 https://qqqqqqiu0804.github.io —— GitHub Pages 已不再使用。
// 若哪天又用 Pages 部署前端，把它加回 CORS_ORIGIN 环境变量即可，不用改代码。
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'https://nexus.kotete.xyz')
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

// 迁移：给日记加「客户端修改时间」(毫秒)。
// 为什么需要：日记原本是「后写覆盖」——两台设备都写同一天时，最后到的那个赢，
// 中途失败的推送则永远落后。加上客户端时间戳后可以判定谁更新，旧的推不动新的。
// 老数据默认为 0 —— 任何一次新推送都能覆盖它们，符合预期。
{
  const cols = db.prepare('PRAGMA table_info(entries)').all().map(c => c.name);
  if (!cols.includes('client_ts')) {
    db.exec('ALTER TABLE entries ADD COLUMN client_ts INTEGER NOT NULL DEFAULT 0');
    console.log('[migrate] entries 表已加 client_ts 列');
  }
}

const stmts = {
  all: db.prepare('SELECT date, content, chars, updated_at, client_ts FROM entries ORDER BY date DESC'),
  get: db.prepare('SELECT date, content, chars, updated_at, client_ts FROM entries WHERE date = ?'),
  upsert: db.prepare(`INSERT INTO entries (date, content, chars, client_ts) VALUES (?, ?, ?, ?)
                      ON CONFLICT(date) DO UPDATE SET content = excluded.content,
                      chars = excluded.chars, client_ts = excluded.client_ts,
                      updated_at = datetime('now','localtime')`),
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
// 默认会带 `X-Powered-By: Express`，等于对外广播后端技术栈，方便攻击者匹配已知 CVE。
// 一行关掉，零成本。
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' })); // 图片 base64 上传需要更大的体积上限
app.use(cors({ origin: CORS_ORIGINS })); // 白名单内多个来源；同源访问不受影响
// 只托管前端单文件——不把整个仓库目录（含 journal.db）暴露成静态资源
//
// 单文件前端 400 KB+，冷启动全量下载在移动网络上很浪费，而 gzip 后只有约 124 KB（省约 69%）。
// 这里用 Node 内置 zlib，**不引入 compression 包**（守住「零多余依赖」的红线）。
// 关键：gzip 在启动时算一次并缓存，绝对不要每请求压缩——2C2G 的 CPU 不该耗在这。
const INDEX_HTML_PATH = path.join(__dirname, '..', 'index.html');
let _htmlCache = null;   // { raw: Buffer, gz: Buffer, etag: string }
function indexHtml() {
  if (_htmlCache) return _htmlCache;
  const raw = fs.readFileSync(INDEX_HTML_PATH);
  _htmlCache = {
    raw,
    gz: zlib.gzipSync(raw, { level: 6 }),
    // ETag 用内容哈希：文件一改，哈希就变，浏览器自然拿到新版
    etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"'
  };
  return _htmlCache;
}
// 文件更新后（git pull）需要让缓存失效。pm2 restart 会重建进程，所以正常部署无需手动调；
// 但开发时热改 index.html 想立刻生效，可以走下面这个 fs.watch。
if (process.env.NODE_ENV !== 'production') {
  try { fs.watch(INDEX_HTML_PATH, () => { _htmlCache = null; }); } catch { /* 平台不支持就算了 */ }
}

app.get(['/', '/index.html'], (req, res) => {
  let c;
  try { c = indexHtml(); }
  catch (e) { res.status(500).send('index.html 读取失败'); return; }

  res.setHeader('ETag', c.etag);
  // no-cache ≠ 不缓存：是「每次都回源协商」。命中则 304 零字节，
  // 既省流量又保证 git pull 后用户立刻看到新版（不会卡在旧界面）。
  res.setHeader('Cache-Control', 'no-cache');

  if (req.get('If-None-Match') === c.etag) { res.status(304).end(); return; }

  const wantsGzip = /\bgzip\b/.test(req.get('Accept-Encoding') || '');
  if (wantsGzip) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Vary', 'Accept-Encoding');   // 让中间层按编码区分缓存
    res.end(c.gz);
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(c.raw);
});

// GET /report —— 个人月报（只读页，给手机浏览器看）
//
// 与 index.html 一样走「启动时预压缩 + ETag 协商」，理由相同：报告页带内联 CSS/JS，体积不小，
// 移动网络下 gzip 收益明显。同样**不引入 compression 包**。
//
// 安全：文件名白名单（只允许 [A-Za-z0-9._-]），杜绝 ../ 穿越读到 journal.db。
// 这个页面是纯静态展示、不含任何用户数据查询接口，所以与 /api 不同，不需要鉴权。
// REPORT_DIR 可用环境变量覆盖：测试要造隔离的报告目录，不应污染仓库里的 report/。
const REPORT_DIR = path.resolve(process.env.REPORT_DIR || path.join(__dirname, '..', 'report'));
const REPORT_NAME_RE = /^[A-Za-z0-9._-]+\.html$/;
const _reportCache = new Map();   // name -> { raw, gz, etag }

function reportFile(name) {
  if (_reportCache.has(name)) return _reportCache.get(name);
  const raw = fs.readFileSync(path.join(REPORT_DIR, name));
  const entry = {
    raw,
    // 与 index.html 一致，启动时预压缩。
    // 别按需 gzipSync：Node 是单线程，请求内同步压缩一个大 HTML 会把
    // 整个事件循环卡住，期间连 /api/* 都停摆 —— 是个现成的 DoS 放大点。
    gz: zlib.gzipSync(raw, { level: 6 }),
    etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"'
  };
  _reportCache.set(name, entry);
  return entry;
}

// 启动时把所有报告预压缩进缓存（懒压缩的阻塞问题见上）。
function warmReportCache() {
  let n = 0;
  try {
    for (const name of fs.readdirSync(REPORT_DIR)) {
      if (!REPORT_NAME_RE.test(name)) continue;
      try { reportFile(name); n++; } catch { /* 单个文件坏了不影响其它 */ }
    }
  } catch { /* 目录不存在就是没报告，正常 */ }
  if (n) console.log(`  月报预压缩: ${n} 份`);
}

app.get('/report', (_req, res) => {
  const dir = REPORT_DIR;
  let names = [];
  try {
    names = fs.readdirSync(dir)
      .filter(n => REPORT_NAME_RE.test(n))
      .sort()
      .reverse();   // 文件名带日期，倒序 = 最新的在前
  } catch { /* 目录不存在时给个空列表 */ }

  const items = names.map(n => {
    const label = n.replace(/\.html$/, '');
    return `<li><a href="/report/${encodeURIComponent(n)}">${label}</a></li>`;
  }).join('');

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexus 报告</title>
<style>
body{margin:0;background:#0f1115;color:#e8eaf0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:40px 20px;line-height:1.7}
.w{max-width:560px;margin:0 auto}
h1{font-size:24px;margin:0 0 6px}
p.s{color:#6b7285;font-size:13px;margin:0 0 26px}
ul{list-style:none;padding:0;margin:0}
li{margin-bottom:10px}
a{display:block;background:#171a21;border:1px solid rgba(255,255,255,.08);border-radius:14px;
  padding:15px 18px;color:#e8eaf0;text-decoration:none;font-size:15px;transition:.2s}
a:hover{border-color:rgba(91,155,245,.5);background:#1d212a}
.empty{color:#6b7285;font-size:14px}
</style></head><body><div class="w">
<h1>Nexus 报告</h1>
<p class="s">按时间倒序 · 点击查看</p>
<ul>${items || '<li class="empty">还没有报告</li>'}</ul>
</div></body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(html);
});

app.get('/report/:name', (req, res) => {
  const name = req.params.name;
  if (!REPORT_NAME_RE.test(name)) { res.status(400).send('非法文件名'); return; }

  let c;
  try { c = reportFile(name); }
  catch { res.status(404).send('报告不存在'); return; }

  res.setHeader('ETag', c.etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (req.get('If-None-Match') === c.etag) { res.status(304).end(); return; }

  if (/\bgzip\b/.test(req.get('Accept-Encoding') || '')) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Vary', 'Accept-Encoding');
    res.end(c.gz);
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(c.raw);
});

// GET /api/files/:id —— 读图（**故意放在鉴权之前**（**免鉴权**：<img> 标签没法带 Authorization 头，
// 靠 32 位十六进制随机 id 当能力凭证；这也意味着拿到链接的人能看到图）
app.get('/api/files/:id', (req, res) => {
  const id = String(req.params.id).replace(/[^a-zA-Z0-9._-]/g, '');
  const row = fileStmts.get.get(id);
  const p = path.join(FILES_DIR, id);
  if (!row || !fs.existsSync(p)) { res.status(404).json({ error: '文件不存在' }); return; }
  res.type(row.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');                     // 阻止浏览器把图片当 HTML/脚本嗅探执行
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');   // id 不变，内容就不变
  res.sendFile(p);
});

// 恒定时间比较：字符串 !== 会在首个不同字节处短路返回，
// 理论上是可利用的时序侧信道（可逐字节爆破 token）。
// 实测跨公网时延抖动远超单字符比较的纳秒差，现实中难以利用——
// 但改用 timingSafeEqual 成本极低，顺手把审计红灯消掉。
// 注意 lengths 不等时也不能直接 return false：那样长度信息会泄漏。
function safeTokenEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);   // 仍然做一次等长比较，抹平时间差
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// 鉴权中间件：只保护 /api/*，静态文件不拦
app.use('/api', (req, res, next) => {
  // 公开只读接口放行：给站点 htt.kotete.xyz 读「切片 / 物料」用。
  // 这里放行的只是路径前缀，具体能读哪些 key 由下面 /api/public/:key 的硬编码白名单决定。
  if (req.path.startsWith('/public/')) return next();
  const auth = req.get('Authorization') || '';
  if (!safeTokenEqual(auth, `Bearer ${TOKEN}`)) {
    return res.status(401).json({ error: '未授权：token 缺失或不正确' });
  }
  next();
});

// 小工具：包一层 try/catch，数据库出错统一返回 500，不让进程崩
// 错误信息不在响应里回显细节：这个服务曾经在 NODE_ENV 未设时把
// 完整的 SyntaxError 堆栈（含 node_modules 绝对路径、依赖行号）回给调用方，
// 等于免费给攻击者一份内部目录结构 + 依赖版本清单，用来精确匹配已知 CVE。
// 只回一句固定的 'internal error'，真正的堆栈留在服务端日志里。
const internalError = (res) => res.status(500).json({ error: 'internal error' });
const wrap = fn => (req, res) => {
  try { res.json(fn(req, res)); }
  catch (e) { console.error('[wrap]', e); internalError(res); }
};

// 异步版：抓外部页面这类要 await 的路由用它（wrap 直接 res.json(Promise) 会序列化成 {}）
const wrapAsync = fn => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) { console.error('[wrapAsync]', e); internalError(res); }
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

// PUT /api/entries/:date —— 写/改某一天
// 带客户端时间戳做「后写胜出」：服务端版本更新时不覆盖，而是把服务端版本回给前端，
// 让两端收敛到同一份内容（与 /api/kv 同一套策略）。
app.put('/api/entries/:date', wrap(req => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');
  const content = String(req.body?.content ?? '');
  const clientTs = Number(req.body?.updatedAt) || Date.now();
  // 读-改-写在事务内完成：同一天并发写入时不会再出现「读到旧值→覆盖掉另一端的更新」。
  db.exec('BEGIN');
  try {
    const cur = stmts.get.get(date);
    if (cur && cur.client_ts > clientTs) {
      db.exec('COMMIT');
      return {
        ok: true, conflict: true,
        entry: { date: cur.date, content: cur.content, chars: cur.chars, updatedAt: cur.client_ts }
      };
    }
    const info = stmts.upsert.run(date, content, content.length, clientTs);
    db.exec('COMMIT');
    return { ok: true, changes: Number(info.changes), updatedAt: clientTs };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
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
    for (const e of valid) stmts.upsert.run(e.date, e.content, e.content.length, Number(e.updatedAt) || Date.now());
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

// ===== 公开只读接口（免鉴权，给站点 htt.kotete.xyz 用）=====
// 安全要点：白名单是**硬编码**的——只有下面这两个 key 能被匿名读到。
// 其余任何 key（wallet / tasks / journal / entries …）就算猜到名字，也只会拿到 404。
// ⚠️ 不要把它改成「排除法」，也不要从别处动态取 key 列表——那等于把私人数据挂到公网上。
const PUBLIC_KEYS = ['slices', 'assets'];
app.get('/api/public/:key', (req, res) => {
  const key = String(req.params.key);
  if (PUBLIC_KEYS.indexOf(key) < 0) { res.status(404).json({ ok: false, error: 'not found' }); return; }
  let value = [];
  try {
    const row = kvStmts.get.get(key);
    if (row && row.value) value = JSON.parse(row.value);
  } catch (e) { value = []; }
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ ok: true, value: value });
});

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
      // 相等时间戳也算「服务端更新」，必须是 >= 而不是 >。
      // 原来 > / < 两个分支都不覆盖 ts === cur.updated_at：
      // 那种情况下什么都没写，却照样返回 ok:true —— 前端以为成功了不重试，
      // 也在 conflicts 里找不到这个键不会收敛，数据就这样静默丢了。
      // 前端 updatedAt 用的是 Date.now()（毫秒），同毫秒双写并非天方夜谭。
      if (!cur || ts >= Number(cur.updated_at)) {
        kvStmts.put.run(k, JSON.stringify(v.value ?? null), ts);
        applied.push(k);
      } else {
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

// GET /api/health —— 数据健康自检（「我的」页面用它显示备份状态）
//   备份由 /root/backup-nexus.sh 每天 03:00 生成 journal-<日期>.db，保留 14 天。
//   BACKUP_DIR 可覆盖（跑测试时务必指向临时目录，别去读真机备份）。
app.get('/api/health', wrap(() => {
  const dir = process.env.BACKUP_DIR || '/root/backups';
  let lastBackup = null, backups = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('journal-') || !f.endsWith('.db')) continue;
      backups++;
      const ms = fs.statSync(path.join(dir, f)).mtimeMs;
      if (lastBackup === null || ms > lastBackup) lastBackup = ms;
    }
  } catch { /* 备份目录不存在不算故障：给 null，前端显示「未知」 */ }
  let dbBytes = 0;
  try { dbBytes = fs.statSync(DB_PATH).size; } catch {}
  return { ok: true, lastBackup, backups, dbBytes, serverTime: Date.now() };
}));

const QUERY_POINTS = `
  SELECT v.aweme_id, v.desc, v.author, v.url, v.tags, v.create_time,
         s.point, s.points, s.model
  FROM summaries s
  JOIN videos v ON v.aweme_id = s.aweme_id
  ORDER BY s.created_at DESC
`;

const QUERY_DAILY = `
  SELECT v.aweme_id, v.desc, v.author, v.url, v.tags, v.create_time,
         s.point, s.points, '' AS model
  FROM summaries s
  JOIN videos v ON v.aweme_id = s.aweme_id
`;

// ===== 观点库（videos.db）=====
// 这是「收藏夹 → 转写 → 摘要」流水线的出口。数据库由 tools/run_batch.py 写，
// 本服务只读，不碰写路径 —— 两边职责分开，跑批崩了也不会把接口带下去。
//
// 为什么单开一个库文件：videos.db 和 journal.db 生命周期完全不同。
// journal 是每天都要备份的个人数据；videos.db 是可重建的衍生数据
// （原始视频还在抖音上，重跑一遍就有）。混在一起会让每日备份白白变大。
//
// 只读打开：万一有 bug 想往里写，会直接报错，而不是悄悄改坏已跑好的批次。
const VIDEOS_DB = path.resolve(process.env.VIDEOS_DB || path.join(__dirname, 'videos.db'));
let vdb = null;
function videosDb() {
  if (vdb) return vdb;
  if (!fs.existsSync(VIDEOS_DB)) return null;   // 还没跑过批：当作空库，不是故障
  vdb = new DatabaseSync(VIDEOS_DB, { readOnly: true });
  return vdb;
}

// 摘要里的 points 是 JSON 字符串存的（SQLite 没有数组类型），读出来要还原。
// 解析失败返回空数组而不是抛错：单条脏数据不该把整个列表接口带崩。
const parseList = (raw) => {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; }
  catch { return []; }
};

// 把「摘要 + 视频元信息」的行统一转成前端要的形状。
// 前端不认识 raw_scores / asr_seconds 这些内部字段，多传就是浪费手机流量。
const toPoint = (r) => ({
  aweme_id: r.aweme_id,
  point:    r.point || '',
  points:   parseList(r.points),
  tags:     parseList(r.tags),
  author:   r.author || '',
  desc:     r.desc || '',
  url:      r.url || ('https://www.douyin.com/video/' + r.aweme_id),
  ts:       r.create_time ? r.create_time * 1000 : null,
  model:    r.model || ''
});

// 「内容过短，无法提炼」是跑批对碎碎念的正常输出，不是错误 ——
// 但它也不能算一条「观点」，不然观点库里全是空话。
const isRealPoint = (it) => it.point && it.point.indexOf('内容过短') < 0;

// GET /api/points —— 观点库列表
//   ?limit=50   默认 50，上限 200（手机上一屏一屏加载）
//   ?offset=0   分页
//   ?tag=xxx    按标签过滤
//   ?q=关键词    观点/要点/标题/作者 全文搜
app.get('/api/points', wrap(req => {
  const dbv = videosDb();
  if (!dbv) return { ok: true, total: 0, items: [], tags: [], note: 'videos.db 还没生成' };

  const limit  = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const tag    = String(req.query.tag || '').trim();
  const q      = String(req.query.q || '').trim();

  // JOIN 两张表：只有摘要存在才算一条「观点」。
  // 光转写还没摘要的（批量跑到一半）不该出现在这里，不然点开是空的。
  const rows = dbv.prepare(QUERY_POINTS).all();

  let items = rows.map(toPoint).filter(isRealPoint);

  if (tag) items = items.filter(it => it.tags.includes(tag));
  if (q) {
    const k = q.toLowerCase();
    items = items.filter(it =>
      (it.point + ' ' + it.points.join(' ') + ' ' + it.desc + ' ' + it.author)
        .toLowerCase().indexOf(k) >= 0);
  }

  const total = items.length;
  return {
    ok: true,
    total,
    items: items.slice(offset, offset + limit),
    // 所有出现过的标签一次给全，前端做筛选条不用再发请求
    tags: Array.from(new Set(items.flatMap(it => it.tags))).sort()
  };
}));

// GET /api/points/daily —— 今日观点（「今日」页面的每日观点分享用）
//
// 关键：**同一天必须永远是同一条**。
// 如果用随机数，用户下拉刷新一次就换一条，那就不叫「每日」了，叫彩票。
// 所以用日期当种子算一个稳定下标。
app.get('/api/points/daily', wrap(req => {
  const dbv = videosDb();
  if (!dbv) return { ok: true, item: null };

  // 用上海时区算「今天」：服务器时区未必是东八区，
  // 直接用本地日期的话，晚上 8 点后会跳到第二天，用户会觉得「今天」不对。
  const date = String(req.query.date || '').trim() ||
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

  const rows = dbv.prepare(QUERY_DAILY).all();

  // 挑出来的必须像「观点」：一句话太短没信息量；points 为空说明没提炼出来。
  // 宁可今天不推，也不要推一条「（内容过短，无法提炼）」给人看。
  const cand = rows.map(toPoint)
    .filter(it => isRealPoint(it) && it.point.length >= 12 && it.points.length > 0);

  if (!cand.length) return { ok: true, date, item: null, pool: 0 };

  let h = 0;
  for (let i = 0; i < date.length; i++) h = (h * 31 + date.charCodeAt(i)) >>> 0;
  return { ok: true, date, item: cand[h % cand.length], pool: cand.length };
}));

// ===== 链接标题（「视频收藏」用）=====
// GET /api/link-title?url=...

// 只放行这些站点，不做通用代理——否则等于在公网上开了个 SSRF 跳板。
const LINK_HOSTS = [
  'bilibili.com', 'b23.tv', 'youtube.com', 'youtu.be', 'douyin.com',
  'v.qq.com', 'youku.com', 'iqiyi.com', 'mgtv.com', 'weibo.com',
  'zhihu.com', 'xiaohongshu.com', 'xhslink.com'
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function linkHostAllowed(host) {
  const h = String(host || '').toLowerCase();
  return LINK_HOSTS.some(d => h === d || h.endsWith('.' + d));
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// 带超时 + 读取上限的取文，避免大页面把内存吃满
// extraHeaders 可选：东方财富的净值文件带不带 Referer 结果不同（不带会返回空）
//
// 重定向必须手动跟随并在每一跳重新校验：fetch 的 redirect:'follow' 只在
// 首跳前跑过一次调用方的 host 白名单，一旦对方 302 到 http://127.0.0.1/...
// 就会直接把内网内容抓回来（条件性 SSRF，需要白名单站点上有开放重定向）。
// 这里每跳都问一次 validateHop，问不过就立刻断，不回传任何内容。
async function fetchCapped(url, capBytes, timeoutMs, extraHeaders, validateHop) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const MAX_HOPS = 5;
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: Object.assign(
          { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
          extraHeaders || {}
        )
      });
      // 3xx：取 Location，校验后再来一轮
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { status: res.status, text: '', finalUrl: current };
        let next;
        try { next = new URL(loc, current).href; } catch { return { status: res.status, text: '', finalUrl: current }; }
        if (validateHop && !validateHop(next)) return { status: res.status, text: '', finalUrl: current, blocked: true };
        current = next;
        continue;
      }
      if (!res.ok || !res.body) return { status: res.status, text: '', finalUrl: current };
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        chunks.push(Buffer.from(value));
        if (total >= capBytes) { try { await reader.cancel(); } catch {} break; }
      }
      return { status: res.status, text: Buffer.concat(chunks).toString('utf8'), finalUrl: current };
    }
    return { status: 508, text: '', finalUrl: current, error: 'too_many_redirects' };
  } finally {
    clearTimeout(timer);
  }
}

// 跳转目标校验：协议必须是 http(s)，且（可选）host 仍在白名单内。
function hopGuard(allowHosts) {
  return (href) => {
    let u;
    try { u = new URL(href); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (allowHosts && !linkHostAllowed(u.hostname)) return false;
    return true;
  };
}

// B 站页面给无 Cookie 的请求返回 412（风控），所以走它的公开 view 接口拿标题。
// b23.tv 短链先跟随 302 换成带 BV 号的地址。
async function bilibiliTitle(url) {
  let finalUrl = url;
  if (/^https?:\/\/b23\.tv\//i.test(url)) {
    // 短链跳转也在白名单内（b23.tv → bilibili.com），跳出去就断
    const r = await fetchCapped(url, 1, 6000, null, hopGuard(true));
    if (r.finalUrl) finalUrl = r.finalUrl;
  }
  const m = finalUrl.match(/\/(BV[0-9A-Za-z]{10})/) || finalUrl.match(/[?&]bvid=(BV[0-9A-Za-z]{10})/i);
  if (!m) return '';
  const r = await fetchCapped(`https://api.bilibili.com/x/web-interface/view?bvid=${m[1]}`, 64 * 1024, 8000);
  try {
    const j = JSON.parse(r.text);
    if (j && j.code === 0 && j.data && j.data.title) return String(j.data.title).trim();
  } catch {}
  return '';
}

app.get('/api/link-title', wrapAsync(async req => {
  const raw = String(req.query.url || '').trim();
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'invalid_url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'bad_protocol' };
  if (!linkHostAllowed(u.hostname)) return { ok: false, error: 'host_not_allowed' };

  const host = u.hostname.toLowerCase();
  if (host === 'b23.tv' || host.endsWith('bilibili.com')) {
    try {
      const t = await bilibiliTitle(u.href);
      if (t) return { ok: true, title: t };
    } catch { /* 落到下面的通用兜底 */ }
  }

  try {
    // 这是唯一由用户直接给 URL 的抓取路径，跳转必须逐跳复查白名单
    const r = await fetchCapped(u.href, 200 * 1024, 8000, null, hopGuard(true));
    let t = '';
    const og = r.text.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]*>/i);
    if (og) {
      const c = og[0].match(/content=["']([^"']*)["']/i);
      if (c) t = c[1];
    }
    if (!t) {
      const mt = r.text.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
      if (mt) t = mt[1];
    }
    t = decodeEntities(t).replace(/\s+/g, ' ').trim();
    return { ok: !!t, title: t };
  } catch {
    return { ok: false, error: 'fetch_failed' };
  }
}));

// ===== 行情（「投资台账」用）=====
// GET /api/quotes?funds=000217,161725&gold=1
//
// 为什么要后端取：浏览器直连东方财富会被 CORS 拦掉，而且金价站是 http，
// 从 https 页面请求属于混合内容，浏览器直接拒绝。
//
// 不接受任意 URL —— 只收 6 位数字代码，域名是写死的，避免变成 SSRF 跳板。
const FUND_CODE_RE = /^\d{6}$/;

// 东财给的是 UTC 午夜的毫秒时间戳（1778774400000 = 北京时间 2026-05-15 00:00），
// 直接 toISOString().slice(0,10) 会少一天；固定 +8 小时，不依赖服务器时区。
const toCstDate = ms => new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 10);

// 东方财富的净值文件是 JS 不是 JSON，只能正则抠两个变量：
//   var fS_name = "华夏回报混合A";
//   var Data_netWorthTrend = [{x:毫秒时间戳, y:单位净值, equityReturn:当日涨跌%}, ...]
// 这个接口对 Referer 敏感：不带 Referer 会返回空内容。
async function fetchFundQuote(code) {
  const r = await fetchCapped(
    `https://fund.eastmoney.com/pingzhongdata/${code}.js`,
    3 * 1024 * 1024, 12000,
    { Referer: 'https://fund.eastmoney.com/' }
  );
  if (r.status !== 200 || !r.text) return null;

  const nameM = r.text.match(/var\s+fS_name\s*=\s*"([^"]*)"/);
  const trendM = r.text.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!trendM) return null;

  let trend;
  try { trend = JSON.parse(trendM[1]); } catch { return null; }
  if (!Array.isArray(trend) || !trend.length) return null;

  const last = trend[trend.length - 1];
  return {
    name: nameM ? nameM[1] : code,
    nav: Number(last.y),
    navDate: toCstDate(last.x),
    pct: Number(last.equityReturn) || 0,
    // 只回传近 90 个交易日：前端拿它估「照这个速度还要几天回本」，再往前的用不上。
    // 统一成 [「YYYY-MM-DD」, 数值]，和金价保持同一种形状，前端不用分两套。
    trend: trend.slice(-90).map(p => [toCstDate(p.x), Number(p.y)])
  };
}

// 上海黄金交易所 Au99.99 金价。两个接口配合：
//   POST /graph/Dailyhq   → 历史日线 {"time":[["2016-12-19",开,收,低,高], ...]}
//   GET  /graph/quotations → 当日分时 {times,data,min,max,heyue,delaystr}
//
// 当前价**优先取日线最后一天的收盘价**，不是分时的末值。原因：
//   ① 算「照这个速度还要几天回本」用的是日线涨跌，当前价和历史必须同一口径，
//      否则拿分时价对比日线趋势会算出错的日均；
//   ② 非交易时段的分时数据自相矛盾 —— 实测周末拿到末值 936.5，而同一响应里
//      min 是 938，末值比自己当日最低还低。日线收盘价是可复现的。
// 分时只在日线拿不到时兜底。
//
// 它是 http 站，从服务器取正好绕开浏览器的混合内容限制。
async function fetchGoldQuote() {
  let trend = [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const hr = await fetch('https://www.sge.com.cn/graph/Dailyhq', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://www.sge.com.cn/'
        },
        body: 'instid=Au99.99'
      });
      const hj = JSON.parse(await hr.text());
      const rows = Array.isArray(hj && hj.time) ? hj.time : [];
      // 近 90 个交易日足够估日均，再多没必要传
      trend = rows.slice(-90)
        .map(row => [String(row[0]), Number(row[2])])   // row[2] 是收盘价
        .filter(p => p[1]);
    } finally { clearTimeout(timer); }
  } catch { /* 历史拿不到就走下面的分时兜底 */ }

  if (trend.length) {
    const last = trend[trend.length - 1];
    return { name: 'Au99.99', price: last[1], priceDate: last[0], source: 'daily', trend };
  }

  const r = await fetchCapped('https://www.sge.com.cn/graph/quotations', 512 * 1024, 12000);
  if (r.status !== 200 || !r.text) return null;
  let j;
  try { j = JSON.parse(r.text); } catch { return null; }
  if (!j || String(j.heyue || '') !== 'Au99.99') return null;
  const arr = Array.isArray(j.data) ? j.data.filter(v => v !== '' && v != null) : [];
  const price = Number(arr[arr.length - 1]);
  if (!price) return null;
  // delaystr 形如「2026年09月21日 02:29:57」，是行情时间戳，不是抓取时间
  return { name: 'Au99.99', price, priceDate: null, asOf: j.delaystr || null, source: 'intraday', trend: [] };
}

// 场内品种（股票 / ETF / LOF）走腾讯行情 —— 券商账户里那些买在交易所的东西，
// 价格是盘中实时变动的，跟场外基金的「每天一个净值」不是一回事。
//
// 两个必须处理的地方：
//   ① 只给 6 位数字是不够的，腾讯要 sh/sz 前缀 —— 按首位自己补（6/5/9 沪市，其余深市）
//   ② 它返回的是 **GBK**，用 UTF-8 解会把名字变成乱码，得用 TextDecoder('gbk')
//      （所以这里不走 fetchCapped，那个固定按 utf8 解）
//
// 返回字段用「~」分隔，实测下标：1=名称 3=现价 4=昨收 32=涨跌幅%
function marketOf(code) {
  const c = String(code)[0];
  return (c === '6' || c === '5' || c === '9') ? 'sh' : 'sz';
}

async function fetchStockQuoteMap(codes) {
  if (!codes.length) return {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`https://qt.gtimg.cn/q=${codes.map(c => marketOf(c) + c).join(',')}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' }
    });
    if (!r.ok) return {};
    const txt = new TextDecoder('gbk').decode(Buffer.from(await r.arrayBuffer()));

    const map = {};
    txt.split(';').forEach(line => {
      const m = line.match(/v_([a-z]{2})(\d{6})="([^"]*)"/i);
      if (!m) return;
      const f = m[3].split('~');
      const price = Number(f[3]);
      if (!(price > 0)) return;    // 停牌时现价可能是 0，宁可不给也不显示 0
      map[m[2]] = {
        name: f[1] || m[2],
        price,
        prevClose: Number(f[4]) || null,
        pct: Number(f[32]) || 0,
        market: m[1]
      };
    });
    return map;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/quotes', wrapAsync(async req => {
  const codes = String(req.query.funds || '')
    .split(',').map(s => s.trim()).filter(s => FUND_CODE_RE.test(s))
    .filter((c, i, a) => a.indexOf(c) === i)   // 去重
    .slice(0, 30);
  const stockCodes = String(req.query.stocks || '')
    .split(',').map(s => s.trim()).filter(s => FUND_CODE_RE.test(s))
    .filter((c, i, a) => a.indexOf(c) === i)
    .slice(0, 30);
  const wantGold = String(req.query.gold || '') === '1';

  const out = { ok: true, funds: {}, stocks: {}, gold: null, fetchedAt: Date.now(), errors: [] };

  await Promise.all([
    ...codes.map(async c => {
      try {
        const q = await fetchFundQuote(c);
        if (q) out.funds[c] = q;
        else out.errors.push(c);
      } catch { out.errors.push(c); }
    }),
    (async () => {
      if (!stockCodes.length) return;
      try {
        out.stocks = await fetchStockQuoteMap(stockCodes);
        stockCodes.forEach(c => { if (!out.stocks[c]) out.errors.push(c); });
      } catch { stockCodes.forEach(c => out.errors.push(c)); }
    })(),
    (async () => {
      if (!wantGold) return;
      try { out.gold = await fetchGoldQuote(); } catch { out.errors.push('gold'); }
    })()
  ]);

  return out;
}));

// ===== 文件 API（灵感库的图片）=====
// POST /api/files —— 接收 dataUrl（base64），落盘并返回 id。
// 用 base64 而非 multipart：不引入新依赖（multer 在国内网络下装起来容易翻车）。
app.post('/api/files', wrap(req => {
  const { name = '', dataUrl = '' } = req.body || {};
  const m = String(dataUrl).match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('dataUrl 格式不对（应为 data:image/png;base64,...）');
  const mime = m[1];
  if (!mime.startsWith('image/')) throw new Error('只接受图片');
  // SVG 可在浏览器里执行 <script>，当图片存会有存储型 XSS 风险，拒绝。
  if (/svg/i.test(mime)) throw new Error('不支持 SVG（有脚本执行风险），请改用 PNG/JPG/WebP');
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

// 兜底错误处理：必须放在所有路由之后。
// 没有它的时候，Express 默认错误页在 NODE_ENV!=production 下会把
// body-parser 的 SyntaxError 堆栈（含绝对路径）原样回给客户端。
app.use((err, _req, res, _next) => {
  console.error('[global]', err);
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 400 ? 'bad request' : 'internal error' });
});

// 兜底：任何漏网的 async 未捕获拒绝在 Node 22 默认是 exit(1)，
// 一旦发生整个服务会重启（pm2 会拉起，但期间请求全失败）。
// 记日志即可 —— 不 exit，让当前进程继续服务。
process.on('unhandledRejection', (r) => { console.error('[unhandledRejection]', r); });

app.listen(PORT, () => {
  console.log(`[nexus-core server] 已启动 → http://localhost:${PORT}`);
  console.log(`  日记 API: http://localhost:${PORT}/api/entries`);
  console.log(`  KV 同步:  GET/PUT http://localhost:${PORT}/api/kv`);
  console.log(`  文件 API: POST/GET http://localhost:${PORT}/api/files`);
  console.log(`  文件目录: ${FILES_DIR}`);
  console.log(`  AI 周报:  POST ${PORT === 80 ? '' : ':' + PORT}/api/ai/weekly (SSE) → Ollama ${OLLAMA_URL}`);
  console.log(`  CORS 放行: ${CORS_ORIGINS.join(' , ')}`);
  console.log(`  数据库: ${DB_PATH}`);
  warmReportCache();
});
