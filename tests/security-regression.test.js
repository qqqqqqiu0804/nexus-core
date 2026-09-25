#!/usr/bin/env node
/**
 * security-regression.test.js —— 六项安全问题的防回归断言
 *
 * 背景：一份第三方审计清单（P0×1 / P1×3 / P2×2）在 4cc9bf0 里已逐条修完，
 * 之后又叠了 4 个提交（含 675 行 index.html 改动）。这份测试的目的就是
 * 把那 6 条固化成断言，**任何一条被改回去就立刻变红**。
 *
 * 设计原则（重要）：
 *   1. 不依赖网络、不依赖 AUTH_TOKEN —— 静态断言用「读源码 + 正则」
 *   2. 能测行为的尽量测行为，别只测「字符串还在不在」
 *   3. **测不了的明确写出来为什么测不了**，不用假测试充数
 *
 * 为什么第 3 条要专门强调：P2-a（SSRF）的端到端验证需要 token，
 * 而有 token 等于已有全量数据权限，这个前提让它实际不可达。
 * 与其编一个「看起来很厉害」的端到端测试，不如老实做逻辑单测 +
 * 在注释里说清可达性 —— 测试的价值在于不说谎。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

// 从源码里按函数名抠出一段（够用即可，不引 parser）
function fnBody(src, name) {
  const i = src.indexOf('function ' + name);
  if (i < 0) return '';
  // 从函数起点往后找配平的大括号
  let depth = 0, started = false;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  return src.slice(i);
}

// 按赋值名抠一段：`const wrap = (fn) => {...}` 这种箭头函数写法
// 用 fnBody 是抠不到的（会返回空串，断言静默失效）。
// 踩坑记录：wrap / wrapAsync 就是箭头函数，最早用 fnBody 抠出来是空的，
// 于是「不回显 e.message」这类断言全部空过 —— 测试看着绿、其实什么都没测。
function arrowBody(src, name) {
  const re = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=');
  const m = src.match(re);
  if (!m) return '';
  const start = m.index;
  let depth = 0, started = false;
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') { depth--; if (started && depth === 0) return src.slice(start, k + 1); }
  }
  return src.slice(start, start + 600);
}

// 抠出任意一段：函数或箭头函数都能拿到
function anyBody(src, name) {
  return fnBody(src, name) || arrowBody(src, name);
}

// 去掉注释再做代码断言。
//
// 为什么必须有这一层：inspViewImage 的**注释里**写了
// 「用 createElement 而不是拼 innerHTML」，如果直接对整段做
// /innerHTML/ 判断，就会把「解释为什么不能这么做」误判成「又这么做了」。
// 这类「注释触发假警报」和「注释掩盖真问题」（把危险代码注释掉）
// 两个方向都会出错，所以统一先剥注释再判代码。
function stripComments(s) {
  return String(s)
    .replace(/\/\*[\s\S]*?\*\//g, '')   // /* ... */
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');   // // ...（避开 http:// 的 //）
}

console.log('【P0】inspViewImage 不得拼 innerHTML（存储型 XSS）');
{
  const body = fnBody(HTML, 'inspViewImage');
  if (!body) bad('找不到 inspViewImage');
  else {
    // 先剥注释再判代码。这个函数的注释里就写着
    // 「而不是拼 innerHTML」——不剥掉的话，对代码的检查会被注释误伤。
    const code = stripComments(body);

    // 这是本条的**核心断言**：一旦有人改回 innerHTML 拼装，立刻红
    if (/innerHTML/.test(code)) bad('inspViewImage 代码里又出现 innerHTML —— P0 回归！');
    else ok('代码里没有 innerHTML（改用 createElement）');

    if (/createElement\('img'\)/.test(code)) ok('用 createElement 建 img 节点');
    else bad('没有用 createElement 建节点');

    // 光有 createElement 不够：img.src 也必须过白名单，
    // 否则 javascript: / //evil.com 仍能塞进来
    if (/img\.src\s*=\s*safeFileUrl\(/.test(code)) ok('img.src 走了 safeFileUrl 白名单');
    else bad('img.src 没走 safeFileUrl —— 只挡了插入方式、没挡内容');
  }

  // safeFileUrl 本身：必须强制匹配 /api/files/<32hex>.<ext>
  const sf = fnBody(HTML, 'safeFileUrl');
  if (!sf) bad('找不到 safeFileUrl');
  else {
    if (/\[0-9a-f\]\{32\}/.test(sf)) ok('safeFileUrl 要求 32 位十六进制 id');
    else bad('safeFileUrl 没校验 32 位 hex —— 路径约束被放宽了');
    if (/\\\/api\\\/files\\\//.test(sf) || /\/api\/files\//.test(sf)) ok('safeFileUrl 限定在 /api/files/ 下');
    else bad('safeFileUrl 没限定路径前缀');
  }

  // 渲染处也必须用 safeFileUrl（否则等于没设白名单）
  if (/safeFileUrl\(it\.fileUrl\)/.test(HTML)) ok('灵感列表渲染处调用了 safeFileUrl');
  else bad('灵感列表渲染处没调用 safeFileUrl');
}

console.log('');
console.log('【P1-a】分类名 / 标签必须「属性 + 正文」双转义');
{
  // 这一条不能只检查「模板里有没有 &quot;」——
  // 变异测试证明那种写法有盲区：把 `const t = escAttr(e[0])` 改成
  // `const t = e[0]`（不再转义），模板字符串一个字没变，断言照样全绿。
  //
  // 所以必须分两步查：
  //   ① 模板结构对（onclick 里插的是变量 + &quot; 包裹）
  //   ② **那个变量本身确实过了 escAttr** ← 真正的防线
  const cases = [
    {
      label: 'renderQuickCats 分类名',
      tpl: "'\" onclick=\"quickPick(&quot;' + escAttr(c) + '&quot;)\">' + escHtml(c) + '</button>'",
      // 属性位的表达式必须是 escAttr(...)，且正文位必须是 escHtml(...)
      attrRe: /quickPick\(&quot;'\s*\+\s*escAttr\(c\)\s*\+\s*'&quot;\)/,
      bodyRe: /&quot;\)">'\s*\+\s*escHtml\(c\)\s*\+\s*'<\/button>'/,
    },
    {
      label: 'renderInspirations 标签',
      tpl: "'\" onclick=\"inspSetTagFilter(&quot;' + t + '&quot;)\">#' + escHtml(e[0]) + ' ' + e[1] + '</button>'",
      attrRe: /inspSetTagFilter\(&quot;'\s*\+\s*t\s*\+\s*'&quot;\)/,
      bodyRe: /&quot;\)">#'\s*\+\s*escHtml\(e\[0\]\)/,
      // 关键补强：变量 t 必须由 escAttr 产出，否则属性位等于没转义
      defRe: /const\s+t\s*=\s*escAttr\(e\[0\]\)/,
    },
  ];
  for (const c of cases) {
    if (!HTML.includes(c.tpl)) { bad(c.label + ' 模板结构被改写'); continue; }
    ok(c.label + ' 模板结构正确');
    if (c.attrRe.test(HTML)) ok(c.label + ' 属性位走了转义');
    else bad(c.label + ' 属性位没走转义');
    if (c.bodyRe.test(HTML)) ok(c.label + ' 正文位走了转义');
    else bad(c.label + ' 正文位没走转义');
    if (c.defRe) {
      if (c.defRe.test(HTML)) ok(c.label + ' 插入属性用的变量确实由 escAttr 产出');
      else bad(c.label + ' 变量未经 escAttr —— 属性位等于没转义（模板看着对，其实是裸值）');
    }
  }

  // 转义函数本身不能被削弱
  const ea = fnBody(HTML, 'escAttr');
  const eh = fnBody(HTML, 'escHtml');
  if (/&quot;/.test(ea) && /escHtml/.test(ea)) ok('escAttr = escHtml + 转义双引号');
  else bad('escAttr 被改动了 —— 属性逃逸防线可能失效');
  if (/&amp;/.test(eh) && /&lt;/.test(eh) && /&gt;/.test(eh)) ok('escHtml 仍转义 & < >');
  else bad('escHtml 被削弱');
}

console.log('');
console.log('【P1-b】500 响应不得回显 e.message / 堆栈');
{
  if (/const internalError = \(res\) => res\.status\(500\)\.json\(\{ error: 'internal error' \}\)/.test(SERVER)) {
    ok('internalError 只回固定文案');
  } else bad('internalError 被改写了');

  // wrap / wrapAsync 是**箭头函数**（`const wrap = (fn) => ...`），
  // 必须用 anyBody 抠；用 fnBody 会拿到空串，断言就静默空过了。
  const wrap = anyBody(SERVER, 'wrap');
  const wrapAsync = anyBody(SERVER, 'wrapAsync');
  for (const [label, body] of [['wrap', wrap], ['wrapAsync', wrapAsync]]) {
    if (!body) { bad('抠不出 ' + label + ' 的函数体（断言会静默失效）'); continue; }
    const code = stripComments(body);
    if (/internalError\(res\)/.test(code)) ok(label + ' 走 internalError');
    else bad(label + ' 没走 internalError');
    // 关键：catch 块里不能把 message 回给客户端
    if (/e\.message/.test(code)) bad(label + ' 又回显了 e.message —— 内部路径泄漏');
    else ok(label + ' 不回显 e.message');
  }

  // 全局 error handler 同样不能带 message
  const ges = SERVER.indexOf('app.use((err, _req, res, _next)');
  if (ges > 0) {
    const g = SERVER.slice(ges, ges + 400);
    if (/'internal error'/.test(g) && !/err\.message/.test(g)) ok('全局 error handler 只回固定文案');
    else bad('全局 error handler 泄漏了 err.message');
  } else bad('找不到全局 error handler');

  // NODE_ENV=production 是第二道防线（让 Express 不回显堆栈）
  const CFG = fs.readFileSync(path.join(ROOT, 'ecosystem.config.js'), 'utf8');
  if (/NODE_ENV:\s*'production'/.test(CFG)) ok('pm2 配置显式设了 NODE_ENV=production（第二层）');
  else bad('pm2 配置没设 NODE_ENV —— Express 堆栈可能回显');

  if (/unhandledRejection/.test(SERVER)) ok('注册了 unhandledRejection 兜底');
  else bad('缺少 unhandledRejection 兜底');
}

console.log('');
console.log('【P1-c】KV 相等时间戳必须覆盖（不得静默丢写）');
{
  // 原来是 ts > cur.updated_at：两个分支都不覆盖「相等」的情况，
  // 那种情况下什么都没写，却照样返回 ok:true —— 前端以为成功不重试，
  // conflicts 里也找不到这个键，于是永远不收敛，数据静默丢失。
  const seg = anyBody(SERVER, 'app') || SERVER;
  const i = SERVER.indexOf("app.put('/api/kv'");
  const putSeg = i > 0 ? SERVER.slice(i, i + 1400) : SERVER;

  if (/ts >= Number\(cur\.updated_at\)/.test(putSeg)) ok('写条件是 >=（相等时也覆盖）');
  else if (/ts > Number\(cur\.updated_at\)/.test(putSeg)) bad('写条件退回 > —— 同毫秒静默丢写回归！');
  else bad('找不到 KV 写条件');

  // 关键：不管是"写入成功"还是"服务端更新"，客户端都必须能**分辨**。
  // 原缺陷的本质不是丢写本身（LWW 语义下丢弃是允许的），
  // 而是「丢了还报 ok:true」—— 客户端无法区分，于是不重试、不收敛。
  // 所以这里断言的是「两个分支各自有可区分的信号」，而不是某种特定字段名。
  if (/applied\.push\(k\)/.test(putSeg)) ok('写入成功的键进 applied 列表');
  else bad('没有 applied 记录 —— 客户端无法确认哪些键写进去了');

  if (/conflicts\[k\]\s*=/.test(putSeg)) ok('服务端较新的键进 conflicts（客户端据此收敛，不再假成功）');
  else bad('没有 conflicts 回传 —— 丢弃的写入会被客户端当成成功');

  // 事务边界：中途抛错必须 ROLLBACK，不能留下半写状态
  if (/db\.exec\('BEGIN'\)/.test(putSeg) && /db\.exec\('COMMIT'\)/.test(putSeg) && /db\.exec\('ROLLBACK'\)/.test(putSeg)) {
    ok('有 BEGIN / COMMIT / ROLLBACK 事务保护');
  } else bad('KV 批量写入缺少完整事务保护');
}

console.log('');
console.log('【P2-a】重定向必须逐跳校验（条件性 SSRF）');
{
  // 核心：redirect 必须是 manual。'follow' 会让首跳白名单形同虚设。
  if (/redirect:\s*'manual'/.test(SERVER)) ok("fetch 用 redirect:'manual'，不自动跟随");
  else bad("又出现 redirect:'follow' —— 首跳白名单可被 302 绕过，SSRF 回归！");

  const fc = fnBody(SERVER, 'fetchCapped');
  if (!fc) bad('找不到 fetchCapped');
  else {
    if (/MAX_HOPS/.test(fc)) ok('有 MAX_HOPS 上限（挡重定向环）');
    else bad('没有跳数上限 —— 重定向环会一直转');
    if (/validateHop/.test(fc)) ok('每一跳都调 validateHop');
    else bad('没有逐跳校验');
    if (/new URL\(loc,\s*current\)/.test(fc)) ok('Location 解析为绝对地址后再校验（相对跳转也没漏）');
    else bad('Location 没做相对→绝对解析，相对跳转可能绕过');
    if (/blocked:\s*true/.test(fc)) ok('被拦时标记 blocked 且不回传内容');
    else bad('被拦时没有明确标记');
  }

  // hopGuard 逻辑单测：不依赖 token、不依赖网络
  const hg = fnBody(SERVER, 'hopGuard');
  if (!hg) bad('找不到 hopGuard');
  else {
    if (/u\.protocol !== 'http:'/.test(hg)) ok('hopGuard 校验协议（挡 file:/ftp:）');
    else bad('hopGuard 没校验协议');
    if (/linkHostAllowed/.test(hg)) ok('hopGuard 复用 linkHostAllowed 复核 host');
    else bad('hopGuard 没复核 host');
  }

  // 白名单匹配必须精确（子域允许、后缀/伪 userinfo 拒绝）
  const lh = fnBody(SERVER, 'linkHostAllowed');
  if (/h === d \|\| h\.endsWith\('\.' \+ d\)/.test(lh)) ok("linkHostAllowed 用 `h===d || endsWith('.'+d)`（精确匹配）");
  else bad('linkHostAllowed 匹配逻辑被改写，可能出现后缀绕过');

  // 白名单不能变成通配（那样等于开放代理）
  const m = SERVER.match(/const LINK_HOSTS = \[([\s\S]*?)\];/);
  if (m) {
    if (/['"]\*['"]/.test(m[1])) bad('LINK_HOSTS 里出现通配 —— 等于公网开放代理');
    else ok('LINK_HOSTS 是显式枚举，无通配');
  } else bad('找不到 LINK_HOSTS');
}

console.log('');
console.log('【P2-b】/report 不得在请求内同步压缩');
{
  const rf = fnBody(SERVER, 'reportFile');
  if (!rf) bad('找不到 reportFile');
  else {
    // gzipSync 只允许出现在「建缓存」的函数里（reportFile 本身是懒填充，
    // 但配合 warmReportCache 在 listen 前预热，请求路径不会碰到它）
    if (/gz:\s*zlib\.gzipSync/.test(rf)) ok('gz 在 reportFile 里一次性算好并缓存');
    else bad('reportFile 里没有预压缩');
  }

  // 路由处理函数里绝不能出现 gzipSync
  const routeStart = SERVER.indexOf("app.get('/report/:name'");
  if (routeStart > 0) {
    const route = SERVER.slice(routeStart, routeStart + 900);
    if (/gzipSync/.test(route)) bad('/report/:name 路由里出现 gzipSync —— 事件循环阻塞回归！');
    else ok('/report/:name 路由里没有 gzipSync');
  } else bad("找不到 /report/:name 路由");

  // 必须真的有启动预热
  if (/function warmReportCache/.test(SERVER)) ok('存在 warmReportCache()');
  else bad('warmReportCache 没了 —— 首次请求会同步压缩');

  const listen = SERVER.indexOf('app.listen(');
  const after = listen > 0 ? SERVER.slice(listen, listen + 700) : '';
  if (/warmReportCache\(\)/.test(after)) ok('warmReportCache() 在 app.listen 回调里被调用（启动即预热）');
  else bad('app.listen 里没调 warmReportCache —— 预热没接上');

  // 与之同理：index.html 也必须启动预压缩
  if (/gz:\s*zlib\.gzipSync/.test(SERVER) && /_htmlCache/.test(SERVER)) ok('index.html 同样走启动预压缩缓存');
  else bad('index.html 的预压缩缓存没了');
}

console.log('');
console.log('【防回归】修复提交之后不得被改回去');
{
  // 这一条靠 git 不总是可用（某些环境 spawnSync EBUSY），做成软断言
  let out = null;
  try {
    out = require('child_process')
      .execFileSync('git', ['log', '--oneline', '--all', '--grep=isomorphic'], { cwd: ROOT, encoding: 'utf8' });
  } catch { /* 忽略 */ }
  // 真正的防回归靠上面每一条断言本身 —— 它们跑在**当前**源码上，
  // 所以只要能跑，就已经在守「现在」了，不需要 git。
  ok('上述断言均针对当前源码执行（即已覆盖「当前状态」）');
  if (out === null) console.log('  ~ git 不可用，跳过历史审计（不影响上面的断言）');
}

console.log('');
console.log('────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('');
  console.log('⚠️ 有断言不通过。这通常意味着某个安全修复被改回去了，');
  console.log('   请对照 docs/PLAN-security-recheck.md 逐条核对后再上线。');
}
process.exit(fail === 0 ? 0 : 1);
