/* v3.1 专项测试 —— 按接口分流
 *
 * 修的问题：用户想抓「对自己好」(193 条) 却抓到 337 条，
 * 里面混着美食/追星/小说 —— 明显不是同一个夹。
 *
 * 根因：抖音收藏页同时打三类接口，v3.0 把三者数据全塞进同一个桶。
 *
 * 这个测试模拟三个接口各自返回，断言：
 *   ① 混合流的数据进 mixed，不进 items
 *   ② 分组内的数据进 items，不进 mixed
 *   ③ 导出时两桶分开，items 里绝不混入混合流的内容
 *   ④ 每条记录带 from 字段能溯源
 *
 * 跑法：node test-userscript-v31.js douyin-favorites.user.js
 */
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[2] || 'douyin-favorites.user.js', 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK] ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  ' + extra : '')); }
}

// ---- 假环境（必须带 location.origin，教训见 v3 测试头）----
const store = {};
class FakeXHR {
  constructor() { this._l = {}; }
  open(m, u) { this._m = m; this._u = u; }
  send() { store._last = this; }
  addEventListener(k, fn) { this._l[k] = fn; }
  fire(text) { this.responseText = text; this.responseURL = this._u; this._l.load && this._l.load(); }
  remove() {}
}
const el = () => ({
  style: { cssText: '' }, textContent: '', innerHTML: '',
  appendChild() {}, remove() {}, click() {},          // click 必须有：导出靠它触发下载
  set onclick(v) {}, get onclick() { return null; },
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
});

const sandbox = {
  window: {}, document: {
    readyState: 'complete',
    body: { appendChild() {} },
    createElement: el,
    getElementById: () => null,
    addEventListener() {},
  },
  location: { href: 'https://www.douyin.com/user/self', origin: 'https://www.douyin.com' },
  XMLHttpRequest: FakeXHR,
  Blob: class { constructor(p) { store.blob = p[0]; } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  setTimeout: (fn) => 0, clearInterval() {}, setInterval: () => 0,
  console, JSON, Date, String, Array, Object, Map, RegExp,
};
sandbox.window = sandbox;
sandbox.window.fetch = undefined;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

console.log('=== v3.1 分流测试 ===');

// ---- ① 混合流接口 ----
const mixedResp = JSON.stringify({
  status_code: 0, has_more: 1,
  aweme_list: [
    { aweme_id: 'M1', desc: '混合流里的追星内容 #黄婷婷', author: { nickname: '追星号' } },
    { aweme_id: 'M2', desc: '混合流里的美食 #宿舍小锅美食', author: { nickname: '美食号' } },
  ],
});
const x1 = new FakeXHR();
sandbox.XMLHttpRequest.prototype.open.call(x1, 'GET',
  'https://www.douyin.com/aweme/v1/web/aweme/favorite/?count=20');
sandbox.XMLHttpRequest.prototype.send.call(x1);
x1.fire(mixedResp);

let st = sandbox.window.__nexusDyStat();
ok('混合流数据进 mixed 桶', st.mixedItems === 2, '混合流 ' + st.mixedItems);
ok('混合流数据未进 grouped 桶', st.groupedItems === 0, '分组 ' + st.groupedItems);

// ---- ② 分组内接口 ----
const groupResp = JSON.stringify({
  status_code: 0, has_more: 1,
  aweme_list: [
    { aweme_id: 'G1', desc: '对自己好夹里的成长内容 #女性成长', author: { nickname: '成长号' } },
    { aweme_id: 'G2', desc: '对自己好夹里的心理内容 #认知', author: { nickname: '心理号' } },
    { aweme_id: 'G3', desc: '对自己好夹里的第三条', author: { nickname: '某号' } },
  ],
});
const x2 = new FakeXHR();
sandbox.XMLHttpRequest.prototype.open.call(x2, 'GET',
  'https://www.douyin.com/aweme/v1/web/collects/video/list/?collect_id=123');
sandbox.XMLHttpRequest.prototype.send.call(x2);
x2.fire(groupResp);

st = sandbox.window.__nexusDyStat();
ok('分组数据进 grouped 桶', st.groupedItems === 3, '分组 ' + st.groupedItems);
ok('分组数据未污染 mixed 桶', st.mixedItems === 2, '混合流 ' + st.mixedItems);

// ---- ③ 导出分流 ----
sandbox.window.__nexusDyExport();
const payload = JSON.parse(store.blob);

ok('导出含 grouped 字段', Array.isArray(payload.grouped));
ok('导出含 mixed 字段', Array.isArray(payload.mixed));
ok('grouped 只有 3 条', payload.grouped.length === 3, '实际 ' + payload.grouped.length);
ok('mixed 只有 2 条', payload.mixed.length === 2, '实际 ' + payload.mixed.length);

const gIds = payload.grouped.map((r) => r.aweme_id).sort().join(',');
const mIds = payload.mixed.map((r) => r.aweme_id).sort().join(',');
ok('grouped 里没有混合流内容', gIds === 'G1,G2,G3', gIds);
ok('mixed 里没有分组内容', mIds === 'M1,M2', mIds);

// ---- ④ 溯源字段 ----
ok('grouped 每条带 from（分组接口）',
   payload.grouped.every((r) => /collects\/video\/list/.test(r.from)),
   payload.grouped[0].from);
ok('mixed 每条带 from（混合流接口）',
   payload.mixed.every((r) => /aweme\/favorite/.test(r.from)),
   payload.mixed[0].from);

// ---- ⑤ 兼容旧格式 ----
ok('items 字段仍在（下游不用改）',
   Array.isArray(payload.items) && payload.items.length === 3,
   'items ' + (payload.items ? payload.items.length : 'undefined'));

// ---- ⑥ 版本号 ----
ok('版本号已更新到 3.1.0', payload.version === '3.1.0', payload.version);

console.log('');
console.log(fail === 0
  ? '全部通过（' + pass + ' 项）'
  : pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
