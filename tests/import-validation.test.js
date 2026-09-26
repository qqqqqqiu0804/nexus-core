#!/usr/bin/env node
/**
 * import-validation.test.js —— 导入通道的值校验回归
 *
 * 背景：importAllData 是唯一「把外部文件里的任意内容写进 localStorage」的入口。
 * 原来它不做任何校验，把文件里的键值原样写进去。两种真实故障：
 *
 *   ① 类型不对但能解析：文件里 tasks 是 {} 而不是 []，
 *      下游 getTasks().filter(...) 抛 TypeError → 整个面板白屏。
 *      （Store.get 对 JSON.parse 失败是吞掉的，所以坏 JSON 不会立刻炸，
 *        真正难查的是「能解析但类型错」。）
 *   ② 键名恶意：__proto__ / constructor 作为键名会污染 Object.prototype。
 *      上游六项安全复审里 P1a/P1b 就是「拼 innerHTML 未转义」，
 *      而 innerHTML 的内容源头正是这些导入的数据 —— 导入校验是那道闸门。
 *
 * 本测试通过 vm 在沙箱里加载 index.html 的脚本，注入假 localStorage，
 * 然后直接调 importAllData / importKeyIsSafe / importValueCheck。
 *
 * 用法：node tests/import-validation.test.js [index.html 路径]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');
const script = (html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/) || [, ''])[1];

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(`${label}：${a}`);
  else bad(`${label} 期望 ${e}，实际 ${a}`);
}
function truthy(v, label) { v ? ok(label) : bad(label); }
function falsy(v, label) { !v ? ok(label) : bad(label); }

// ---------- 沙箱：假 DOM + 真 localStorage 语义 ----------
function makeStorage(init) {
  const m = Object.create(null);
  for (const [k, v] of Object.entries(init || {})) m[k] = String(v);
  return {
    _m: m,
    get length() { return Object.keys(m).length; },
    key(i) { return Object.keys(m)[i] ?? null; },
    getItem(k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem(k, v) { m[k] = String(v); },
    removeItem(k) { delete m[k]; },
    clear() { for (const k of Object.keys(m)) delete m[k]; },
  };
}

function loadSandbox(seed) {
  const storage = makeStorage(seed);
  const noop = () => {};
  const fakeEl = new Proxy({ style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    innerHTML: '', textContent: '', value: '', addEventListener: noop, appendChild: noop,
    querySelector: () => null, querySelectorAll: () => [], setAttribute: noop,
    getAttribute: () => null, removeAttribute: noop, focus: noop, blur: noop,
    dataset: {}, children: [], parentNode: null, onclick: null },
    { get(t, k) { if (k in t) return t[k]; return undefined; }, set(t, k, v) { t[k] = v; return true; } });

  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    localStorage: storage,
    document: { getElementById: () => fakeEl, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => fakeEl, addEventListener: noop, body: fakeEl,
      documentElement: { classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: {} } },
    window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }),
      location: { hash: '', pathname: '/' }, innerWidth: 390 },
    navigator: { userAgent: 'node' },
    location: { hash: '', pathname: '/', reload: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (f) => f(),
    alert: noop, confirm: () => false,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(script, sandbox, { filename: 'index.inline.js' }); }
  catch (e) { /* 启动期个别 DOM 操作会抛，不影响我们要测的纯函数 */ }
  // script 里的 const/let 只存在于脚本的词法作用域，不会成为沙箱对象的属性。
  // 这些又都是 const 声明的，所以显式求值一次把它们挂到沙箱上。
  try {
    vm.runInContext(
      'globalThis.SYNC_KEYS = SYNC_KEYS;' +
      'globalThis.SYNC_SKIP_KEYS = SYNC_SKIP_KEYS;' +
      'globalThis.IMPORT_SCHEMA = IMPORT_SCHEMA;' +
      'globalThis.importAllData = importAllData;' +
      'globalThis.importKeyIsSafe = importKeyIsSafe;' +
      'globalThis.importValueCheck = importValueCheck;' +
      'globalThis.importResultMessage = importResultMessage;' +
      'globalThis.Store = Store;',
      sandbox, { filename: 'bridge.js' });
  } catch (e) { /* 若某个标识符不存在，交由各段测试自己报错 */ }
  return { sandbox, storage };
}

// ---------- 【1】schema 覆盖面：白名单里的键都必须有期望类型 ----------
console.log('【1】IMPORT_SCHEMA 必须覆盖所有同步键');
const { sandbox: sb } = loadSandbox();
const SYNC_KEYS = sb.SYNC_KEYS, SCHEMA = sb.IMPORT_SCHEMA;
// IMPORT_SCHEMA 的键是不带 nexus_ 前缀的业务名；且它必须覆盖 SYNC_KEYS 里的每一项，
// 否则那个键查表查不到、落到 'any'，等于没有类型约束。
const missing = (SYNC_KEYS || []).filter(k => !(k in (SCHEMA || {})));
if (!Array.isArray(SYNC_KEYS) || !SCHEMA) {
  bad('取不到 SYNC_KEYS 或 IMPORT_SCHEMA');
} else if (missing.length === 0) {
  ok(`同步键 ${SYNC_KEYS.length} 个全部有期望类型`);
} else {
  bad(`这些同步键没有类型约束：${missing.join(', ')} —— 它们能被导入成任意类型`);
}
// 反向：schema 里不该有 SYNC_KEYS 之外的多余项（写了也没人查）
const extra = Object.keys(SCHEMA || {}).filter(k => !SYNC_KEYS.includes(k));
if (extra.length === 0) ok('IMPORT_SCHEMA 没有多余项');
else bad(`IMPORT_SCHEMA 有 ${extra.length} 项不在 SYNC_KEYS 里（写了也不会被查）：${extra.join(', ')}`);

// ---------- 【2】键名合法性 ----------
console.log('【2】危险 / 非法键名必须被拒');
const safe = sb.importKeyIsSafe;
if (typeof safe !== 'function') {
  bad('importKeyIsSafe 不存在');
} else {
  [['nexus_tasks', true], ['nexus_wallet', true], ['nexus_a-b.c', true],
   ['__proto__', false], ['nexus___proto__', false], ['constructor', false],
   ['nexus_constructor', false], ['prototype', false], ['nexus_prototype', false],
   // 下划线打头一律拒绝（__proto__ 的各种变体都从这个口子进来）。
   // 这几条是专门为「剥前缀后以下划线打头」这条规则加的 ——
   // 变异测试发现原来没有用例覆盖它，把规则注释掉测试居然还是全绿。
   ['nexus__x', false], ['_x', false], ['nexus_', false], ['nexus__', false],
   ['', false], [null, false], [123, false],
   ['nexus_' + 'x'.repeat(80), false],
   ['nexus_ bad', false], ['nexus_a;b', false], ['nexus_a/b', false]].forEach(([k, want]) => {
    const got = safe(k);
    if (got === want) ok(`importKeyIsSafe(${JSON.stringify(k)}) = ${want}`);
    else bad(`importKeyIsSafe(${JSON.stringify(k)}) 期望 ${want}，实际 ${got}`);
  });
}

// ---------- 【3】类型校验 ----------
console.log('【3】类型不符必须被拒');
const chk = sb.importValueCheck;
if (typeof chk !== 'function') {
  bad('importValueCheck 不存在');
} else {
  [['nexus_tasks', [], true],  ['nexus_tasks', {}, false], ['nexus_tasks', 'x', false],
   ['nexus_tasks', null, false], ['nexus_tasks', 1, false],
   ['nexus_wallet', {}, true], ['nexus_wallet', [], false], ['nexus_wallet', null, false],
   ['nexus_scheduleOverride', null, true], ['nexus_scheduleOverride', {}, true],
   ['nexus_scheduleOverride', [], false], ['nexus_scheduleOverride', 'x', false],
   ['nexus_unknown_future_key', 'anything', true], ['nexus_unknown_future_key', {}, true]].forEach(([k, v, want]) => {
    const got = chk(k, v).ok === true;
    const label = `${k} = ${Array.isArray(v) ? '[]' : v === null ? 'null' : typeof v === 'object' ? '{}' : JSON.stringify(v)}`;
    if (got === want) ok(`${label} → ${want ? '通过' : '拒绝'}`);
    else bad(`${label} 期望 ${want ? '通过' : '拒绝'}，实际 ${got ? '通过' : '拒绝'}`);
  });
}

// ---------- 【4】正常导入 ----------
console.log('【4】合法数据正常导入');
{
  const { sandbox: s, storage } = loadSandbox({ nexus_tasks: '[]' });
  const r = s.importAllData({
    app: 'nexus-core', version: '2.0',
    data: { tasks: [{ id: 1, text: 'a' }], wallet: { cash: 10, transactions: [] }, profile: { level: 2 } }
  });
  eq(r.imported, 3, '导入 3 项');
  eq(r.rejected, [], '无拒绝项');
  truthy(storage.getItem('nexus_tasks') !== null, 'nexus_tasks 已写入');
  eq(JSON.parse(storage.getItem('nexus_wallet')).cash, 10, 'wallet 内容正确');
  truthy(storage.getItem('nexus_backup_before_import') !== null, '写入了导入前备份');
}

// ---------- 【5】裸 dump 格式（手机导出常见） ----------
console.log('【5】裸 dump 格式也要能导入');
{
  const { sandbox: s } = loadSandbox({});
  const r = s.importAllData({ tasks: [], wallet: {} });      // 没有外层 data
  eq(r.imported, 2, '裸 dump 导入 2 项（键自动补 nexus_ 前缀）');
}

// ---------- 【6】类型错的键被跳过，合法的照常导入 ----------
console.log('【6】部分不合法：拒绝该键，其余照常导入');
{
  const { sandbox: s, storage } = loadSandbox({});
  const r = s.importAllData({ tasks: { not: 'an array' }, wallet: { cash: 5 }, inspirations: 'oops' });
  eq(r.imported, 1, '只有 wallet 被导入');
  eq(r.rejected.length, 2, '2 项被拒（tasks / inspirations）');
  truthy(storage.getItem('nexus_tasks') === null, '畸形 tasks 没有被写入 ← 这是本测试的核心');
  truthy(storage.getItem('nexus_inspirations') === null, '畸形 inspirations 没有被写入');
  eq(JSON.parse(storage.getItem('nexus_wallet')).cash, 5, '合法 wallet 正常落盘');
  truthy(r.rejected.some(x => x.key === 'nexus_tasks'), '拒绝理由里点名了 nexus_tasks');
}

// ---------- 【7】全部不合法 → 整体失败，且不动数据 ----------
console.log('【7】全不合法：必须整体失败且不动本机数据');
{
  const { sandbox: s, storage } = loadSandbox({ nexus_tasks: '[{"id":1}]', nexus_wallet: '{"cash":99}' });
  const before = storage.getItem('nexus_tasks');
  const r = s.importAllData({ tasks: 'bad', wallet: 'also bad' });
  truthy(!!r.error, '返回了 error');
  eq(storage.getItem('nexus_tasks'), before, '本机 nexus_tasks 未被改动');
  truthy(storage.getItem('nexus_backup_before_import') === null, '没有留下无用的备份');
}

// ---------- 【8】原型污染必须被挡住 ----------
console.log('【8】原型污染键必须被拒');
{
  const { sandbox: s, storage } = loadSandbox({});
  // 用 JSON.parse 构造：只有这种方式能让 '__proto__' 成为一个**自有可枚举属性**，
  // 字面量写法 `{__proto__: x}` 会被 JS 当成设置原型而不是加一个键。
  // （上一版用 Object.defineProperty 在这里会炸，导致「无输出」而不是干净失败。）
  const payload = JSON.parse('{"tasks":[],"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":{"y":1}}');
  const r = s.importAllData(payload);
  falsy(storage.getItem('nexus___proto__'), 'nexus___proto__ 没有被写入');
  falsy(storage.getItem('__proto__'), '__proto__ 没有被写入');
  eq(Object.prototype.polluted, undefined, 'Object.prototype 未被污染');
  truthy(r.imported >= 1, '合法键仍导入了');
  const badKeys = (r.rejected || []).map(x => x.key).sort();
  truthy(badKeys.includes('nexus___proto__'), '拒绝名单里有 nexus___proto__');
  truthy(badKeys.includes('nexus_constructor'), '拒绝名单里有 nexus_constructor');
  truthy(badKeys.includes('nexus_prototype'), '拒绝名单里有 nexus_prototype');
}

// ---------- 【9】异常输入不抛异常 ----------
console.log('【9】畸形顶层输入必须返回 error 而不是抛异常');
{
  const { sandbox: s } = loadSandbox({});
  [[null, 'null'], [undefined, 'undefined'], ['str', '字符串'], [123, '数字'],
   [[], '空数组'], [{}, '空对象'], [{ data: [] }, 'data 是数组']].forEach(([v, label]) => {
    let threw = false, r;
    try { r = s.importAllData(v); } catch (e) { threw = true; }
    if (!threw && r && r.error) ok(`${label} → error（未抛异常）`);
    else bad(`${label} → ${threw ? '抛了异常' : '没有返回 error'}`);
  });
}

// ---------- 【10】键数量上限 ----------
console.log('【10】键太多必须被拒（防塞满 localStorage）');
{
  const { sandbox: s } = loadSandbox({});
  const big = {};
  for (let i = 0; i < 500; i++) big['k' + i] = 1;
  const r = s.importAllData(big);
  truthy(!!r.error, '500 个键被拒绝');
  const okSize = {};
  for (let i = 0; i < 100; i++) okSize['k' + i] = 1;
  const r2 = s.importAllData(okSize);
  eq(r2.imported, 100, '100 个键正常通过');
}

// ---------- 【11】重复键 ----------
console.log('【11】同一键出现两次要按重复处理');
{
  const { sandbox: s } = loadSandbox({});
  // 构造一个「nexus_tasks 与 tasks 同时存在」的 payload（会被规范成同一个键）
  const r = s.importAllData({ tasks: [{ id: 1 }], nexus_tasks: [{ id: 2 }] });
  eq(r.imported, 1, '只导入 1 次');
  eq((r.rejected || []).filter(x => x.reason === '重复键').length, 1, '另一条记为重复键');
}

// ---------- 【12】SYNC_SKIP_KEYS 不得被导入 ----------
console.log('【12】连接配置类键不得被导入覆盖');
{
  const { sandbox: s, storage } = loadSandbox({ nexus_serverToken: 'MY_REAL_TOKEN' });
  const r = s.importAllData({ serverToken: 'EVIL', serverBase: 'http://evil.example', tasks: [] });
  eq(storage.getItem('nexus_serverToken'), 'MY_REAL_TOKEN', '本机 token 未被覆盖 ← 核心');
  truthy(storage.getItem('nexus_serverBase') === null, 'serverBase 没有被写入');
  eq(r.imported, 1, '只有 tasks 被导入');
}

// ---------- 【13】下游消费方不会因导入数据而崩 ----------
console.log('【13】导入畸形数据后，下游数组操作不应抛异常');
{
  const { sandbox: s } = loadSandbox({});
  // 模拟一个攻击性文件：所有数组键都写成对象
  s.importAllData({
    tasks: {}, courses: {}, inspirations: [], videos: {}, investments: {},
    wallet: { cash: 0, transactions: 'not-an-array' }
  });
  // 逐个断言「拿到的东西能直接当数组用」
  let crashed = [];
  ['tasks', 'courses', 'videos', 'investments', 'inspirations'].forEach(k => {
    const v = s.Store.get(k, []);
    try { v.filter(() => true); } catch { crashed.push(k); }
  });
  if (crashed.length === 0) ok('数组型键拿到的一定是数组（.filter 不炸）');
  else bad(`这些键拿到后 .filter 会抛错：${crashed.join(', ')} —— 畸形数据落盘了`);
  // wallet.transactions 是内层数组，schema 只校验到对象层
  const w = s.Store.get('wallet', {});
  truthy(typeof w.transactions === 'string', 'wallet.transactions 的字符串值确实落盘了（内层不做校验，见下方说明）');
}

// ---------- 【14】importResultMessage 文案 ----------
console.log('【14】给用户的结果文案');
{
  const { sandbox: s } = loadSandbox({});
  if (typeof s.importResultMessage !== 'function') {
    bad('importResultMessage 不存在');
  } else {
    const m1 = s.importResultMessage({ ok: true, imported: 3, rejected: [] });
    truthy(/已导入 3 项/.test(m1) && !/跳过/.test(m1), '全部成功时只说已导入');
    const m2 = s.importResultMessage({ ok: true, imported: 2, rejected: [{ key: 'x', reason: 'y' }] });
    truthy(/已导入 2 项/.test(m2) && /跳过 1 项/.test(m2), '有跳过时明确提示');
    truthy(/格式/.test(s.importResultMessage({ error: '文件格式不对：顶层应为对象' })), 'error 情况直接透传');
  }
}

// ---------- 【15】单键体积上限（防一个键就撑爆 5MB 配额） ----------
console.log('【15】超大单值必须被拒');
{
  const { sandbox: s, storage } = loadSandbox({});
  const huge = 'x'.repeat(1024 * 1024 + 1000);       // 略超 1MB
  const r = s.importAllData({ tasks: [{ id: 1, blob: huge }], wallet: { cash: 1 } });
  falsy(storage.getItem('nexus_tasks'), '超大 tasks 未被写入');
  eq(JSON.parse(storage.getItem('nexus_wallet')).cash, 1, '同批的小 wallet 正常导入');
  truthy((r.rejected || []).some(x => x.key === 'nexus_tasks' && /过大/.test(x.reason)), '拒绝理由说明「过大」');
  // 边界内应通过
  const okSmall = 'x'.repeat(1024);                  // 1KB
  const r2 = s.importAllData({ tasks: [{ id: 1, blob: okSmall }] });
  eq(r2.imported, 1, '正常体积不受影响');
}

// ---------- 【16】备份写不进去时必须中止，不能留下不可回滚的状态 ----------
console.log('【16】备份失败必须中止导入（否则没有退路）');
{
  const { sandbox: s, storage } = loadSandbox({ nexus_tasks: '[{"id":9}]' });
  // 让 setItem 在写「导入前备份」时抛错（模拟配额满）
  const origSet = storage.setItem.bind(storage);
  storage.setItem = (k, v) => {
    if (k === 'nexus_backup_before_import') throw new Error('QuotaExceededError');
    return origSet(k, v);
  };
  const r = s.importAllData({ tasks: [{ id: 1 }] });
  truthy(!!r.error, '返回 error');
  truthy(/备份/.test(r.error), '错误信息里说明是备份失败');
  eq(storage.getItem('nexus_tasks'), '[{"id":9}]', '本机数据完全没动 ← 核心');
}

// ---------- 【17】快照还原通道也要校验 ----------
console.log('【17】导入前快照还原时必须同样校验');
{
  const { sandbox: s, storage } = loadSandbox({});
  // 伪造一份含畸形数据的快照
  storage.setItem('nexus_backup_before_import', JSON.stringify({
    at: Date.now(),
    data: { nexus_tasks: '{"not":"an array"}', nexus_wallet: '{"cash":7}', 'nexus___proto__': '{"x":1}' }
  }));
  s.confirm = () => true;                            // 跳过确认弹窗
  let threw = false;
  try { s.restorePreImportBackup(); } catch (e) { threw = true; }
  falsy(threw, '还原过程未抛异常');
  truthy(storage.getItem('nexus_tasks') === null || storage.getItem('nexus_tasks') === 'null',
    '畸形 tasks 未被回写 ← 核心');
  eq(JSON.parse(storage.getItem('nexus_wallet')).cash, 7, '合法 wallet 正常还原');
  falsy(storage.getItem('nexus___proto__'), '危险键未被回写');
}

console.log('\n────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
