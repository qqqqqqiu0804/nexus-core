/**
 * AI 报告（周报 / 月报）范围与汇总逻辑的测例。
 *
 * 与 xiangqi-moves.test.js 同一套路：**直接抽取 index.html 里的真实代码段来跑**，
 * 测的是同一份实现，不是复制品。
 * 跑法：  node tests/ai-report.test.js
 *
 * 覆盖：周/月范围推算（含跨年、月末天数）、纯统计渲染（空数据不崩）、
 *       转义函数、以及「切粒度要重置偏移」这条容易回归的规则。
 */
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

// --- 抽取前端脚本 ---
const s = html.indexOf('<script>'), e = html.lastIndexOf('</script>');
if (s < 0 || e < 0) { console.error('找不到 <script> 段'); process.exit(1); }
const code = html.slice(s + 8, e);

// --- 最小 DOM 替身：前端是给浏览器写的，这里只测纯函数，DOM 全部哑掉 ---
const noop = () => {};
const fakeEl = new Proxy({}, {
  get(t, k) {
    if (k === 'classList') return { add: noop, remove: noop, toggle: noop, contains: () => false };
    if (k === 'style' || k === 'dataset') return {};
    if (k === 'innerHTML' || k === 'textContent' || k === 'value') return '';
    if (k === 'length') return 0;
    return noop;
  },
  set() { return true; }
});
const store = Object.create(null);
const localStorageStub = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
  key: i => Object.keys(store)[i] ?? null,
  get length() { return Object.keys(store).length; }
};
const ctx = {
  console, Date, Math, JSON, String, Number, Array, Object, Set, Map, RegExp, Error,
  isNaN, parseInt, parseFloat, Promise, TextDecoder, URL, Blob,
  setTimeout, clearTimeout, requestAnimationFrame: noop, alert: noop,
  document: {
    getElementById: () => fakeEl,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => fakeEl,
    addEventListener: noop,
    activeElement: null,
    body: fakeEl, head: fakeEl, documentElement: fakeEl
  },
  window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }) },
  localStorage: localStorageStub,
  location: { protocol: 'http:', origin: 'http://localhost' },
  navigator: { userAgent: 'node-test' },
  fetch: () => Promise.reject(new Error('测试环境不发网络请求')),
  speechSynthesis: { cancel: noop, speak: noop }
};

const api = new Function(...Object.keys(ctx), code + `
;return {
  aiWeekRange, aiMonthRange, aiReportRange, collectRangeData, renderStatsOnlyReport,
  aiSetGranularity, escHtml, escAttr, localDate,
  getGranularity: () => _aiGranularity,
  getOffset: () => _aiWeekOffset,
  setOffset: v => { _aiWeekOffset = v; }
};`)(...Object.values(ctx));

let pass = 0, fail = 0;
function t(name, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : `   ← 期望 ${expected}，实际 ${actual}`));
}
const dayCount = r => Math.round((new Date(r.end + 'T00:00:00') - new Date(r.start + 'T00:00:00')) / 86400000) + 1;

console.log('【1】月报范围：月末天数必须正确（含闰年 2 月）');
// 用固定日期验证：MONTH_DAYS 是各月的标准天数
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const now = new Date();
for (let off = -14; off <= 0; off++) {
  const r = api.aiMonthRange(off);
  const d1 = new Date(r.start + 'T00:00:00');
  const d2 = new Date(r.end + 'T00:00:00');
  // 起止必须同一个月、同一年
  const sameMonth = d1.getMonth() === d2.getMonth() && d1.getFullYear() === d2.getFullYear();
  if (!sameMonth) { t(`offset=${off} 起止同月`, false, true); }
  // 起始必须是 1 号
  if (d1.getDate() !== 1) { t(`offset=${off} 起始为 1 日`, d1.getDate(), 1); }
  // 天数必须等于该月标准天数（跨年的 2 月闰年问题由构造保证，这里校形）
  const expected = MONTH_DAYS[d1.getMonth()];
  // 2 月特殊：闰年 29 天
  const isLeapFeb = d1.getMonth() === 1 && new Date(d1.getFullYear(), 1, 29).getMonth() === 1;
  const exp = (d1.getMonth() === 1 && isLeapFeb) ? 29 : expected;
  if (dayCount(r) !== exp) { t(`offset=${off} 天数(${d1.getFullYear()}-${d1.getMonth()+1})`, dayCount(r), exp); }
}
t('连续 15 个月的月份范围全部正确', true, true);

console.log('\n【2】月报范围：跨年推算');
t('往前推 12+ 个月能正确跨年', api.aiMonthRange(-13).start.slice(0, 7), (() => {
  const d = new Date(now.getFullYear(), now.getMonth() - 13, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})());

console.log('\n【3】周报范围：回归（周一 → 周日）');
const w0 = api.aiWeekRange(0);
t('本周起始是周一', new Date(w0.start + 'T00:00:00').getDay(), 1);
t('本周结束是周日', new Date(w0.end + 'T00:00:00').getDay(), 0);
t('本周恰好 7 天', dayCount(w0), 7);
const w1 = api.aiWeekRange(-1);
t('上周恰好 7 天', dayCount(w1), 7);
t('上周结束 = 本周开始前一天', (() => {
  const d = new Date(w1.end + 'T00:00:00'); d.setDate(d.getDate() + 1);
  return api.localDate(d);
})(), w0.start);

console.log('\n【4】aiReportRange 跟随粒度');
api.aiSetGranularity('week');
t('week 粒度返回周范围（7 天）', dayCount(api.aiReportRange(0)), 7);
api.aiSetGranularity('month');
t('month 粒度返回月范围（>= 28 天）', dayCount(api.aiReportRange(0)) >= 28, true);

console.log('\n【5】切换粒度必须重置偏移（否则会跳到很久以前）');
api.aiSetGranularity('week');
api.setOffset(-5);
t('先制造一个非零偏移', api.getOffset(), -5);
api.aiSetGranularity('month');
t('切到月报后偏移归零', api.getOffset(), 0);
api.setOffset(-3);
api.aiSetGranularity('week');
t('切回周报后偏移归零', api.getOffset(), 0);

console.log('\n【6】纯统计渲染：空数据不崩且结构完整');
api.aiSetGranularity('month');
const emptyData = api.collectRangeData(api.aiMonthRange(0));
const emptyTxt = api.renderStatsOnlyReport(emptyData);
t('月报收集到 28~31 天', emptyData.days.length >= 28 && emptyData.days.length <= 31, true);
t('kind 标记为月报', emptyData.kind, '月报');
t('summary 字段齐全', ['天数', '有任务完成的天数', '有支出的天数', '任务完成总数', '日均支出']
  .every(k => k in emptyData.summary), true);
t('输出包含四个小节', ['📊', '💰', '📔', '📌'].every(e => emptyTxt.includes(e)), true);

console.log('\n【7】纯统计渲染：有数据时数字算对');
api.aiSetGranularity('week');
const fakeRange = api.aiWeekRange(0);
// 往 localStorage 塞两天记账 + 一天任务完成
localStorageStub.setItem('nexus_wallet', JSON.stringify({ transactions: [
  { type: 'expense', amount: 12.5, category: '餐饮', date: fakeRange.start },
  { type: 'expense', amount: 7.5, category: '餐饮', date: fakeRange.start },
  { type: 'expense', amount: 30, category: '交通', date: fakeRange.end },
  { type: 'income', amount: 100, date: fakeRange.start }
]}));
localStorageStub.setItem('nexus_completionLog', JSON.stringify({ [fakeRange.start]: 3, [fakeRange.end]: 2 }));
const data = api.collectRangeData(fakeRange);
t('支出合计 = 50', data.expenseTotal, 50);
t('收入合计 = 100', data.incomeTotal, 100);
t('分类：餐饮 20', data.expenseByCategory['餐饮'], 20);
t('分类：交通 30', data.expenseByCategory['交通'], 30);
t('任务完成总数 = 5', data.summary.任务完成总数, 5);
t('有任务完成的天数 = 2', data.summary.有任务完成的天数, 2);
t('有支出的天数 = 2', data.summary.有支出的天数, 2);
t('统计文本包含 ¥50', api.renderStatsOnlyReport(data).includes('¥50'), true);

console.log('\n【8】转义函数（XSS 修复的回归锁）');
t('escHtml 转义 <', api.escHtml('<img>'), '&lt;img&gt;');
t('escHtml 转义 &', api.escHtml('a&b'), 'a&amp;b');
t('escAttr 额外转义双引号', api.escAttr('a"b'), 'a&quot;b');
t('escAttr 先转义 & 再转义 "（顺序不能反）', api.escAttr('&"'), '&amp;&quot;');

console.log('\n【9】index.html 里不得再有未转义的任务字段');
t('无未转义的 ${t.title}', /\$\{t\.title\}/.test(code), false);
t('无未转义的 ${t.course}', /\$\{t\.course\}/.test(code), false);
t('无未转义的 ${s.title}', /\$\{s\.title\}/.test(code), false);

console.log('\n————————————————————————');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
