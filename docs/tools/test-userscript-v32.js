/* v3.2 专项测试 —— 记录开关
 *
 * 为什么加这个开关（写在这里，免得以后有人"优化"掉）：
 *   v3.1 想按接口名自动判断数据归属，实测**失败** ——
 *   同一个 /collects/video/list/ 在「全部收藏」和「某个夹内」两种场景都会调。
 *   接口名不带语义标签，猜不出来。
 *
 *   → 改用最可靠的尺子：**用户自己**。
 *     默认不收；用户进到目标收藏夹、看到内容了，点「开始记录」。
 *
 * 这个测试要守住的不变量：
 *   ① 开关关着时，收到任何数据都**不写入**
 *   ② 开关打开时，才开始收
 *   ③ 重新打开时**清空旧数据**（否则还是在混）
 *   ④ 导出只含开关打开后的数据
 *
 * 跑法：node test-userscript-v32.js douyin-favorites.user.js
 */
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[2] || 'douyin-favorites.user.js', 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK] ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  ' + extra : '')); }
}

const store = {};
class FakeXHR {
  constructor() { this._l = {}; }
  open(m, u) { this._m = m; this._u = u; }
  send() {}
  addEventListener(k, fn) { this._l[k] = fn; }
  fire(text) { this.responseText = text; this.responseURL = this._u; this._l.load && this._l.load(); }
  remove() {}
}
// 假元素：方法齐全，别让测试桩的缺陷伪装成被测代码的 bug（已踩三次）
const el = () => ({
  style: { cssText: '', background: '' }, textContent: '', innerHTML: '',
  appendChild() {}, remove() {}, click() {},
  set onclick(v) {}, get onclick() { return null; },
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
});

const sandbox = {
  document: {
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
  setTimeout: () => 0, clearInterval() {}, setInterval: () => 0,
  console, JSON, Date, String, Array, Object, Map, RegExp,
};
sandbox.window = sandbox;
sandbox.window.fetch = undefined;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const W = sandbox.window;
const XHRP = sandbox.XMLHttpRequest.prototype;

function fire(url, body) {
  const x = new FakeXHR();
  XHRP.open.call(x, 'GET', url);
  XHRP.send.call(x);
  x.fire(JSON.stringify(body));
}

const mkList = (ids, prefix) => ({
  status_code: 0, has_more: 1,
  aweme_list: ids.map((id) => ({
    aweme_id: id, desc: prefix + ' ' + id, author: { nickname: '某某' },
  })),
});

console.log('=== v3.2 开关测试 ===');

// ---- ① 开关默认关着：数据不该进来 ----
fire('https://www.douyin.com/aweme/v1/web/collects/video/list/?collect_id=1',
     mkList(['A1', 'A2', 'A3'], '进目标夹之前的脏数据'));

let st = W.__nexusDyStat();
ok('开关默认是关的', st.armed === false, 'armed=' + st.armed);
ok('关着时收不到数据', st.items === 0, '收到 ' + st.items + ' 条');

// ---- ② 打开开关 ----
W.__nexusDyArm();
st = W.__nexusDyStat();
ok('可以打开开关', st.armed === true);

// ---- ③ 打开后开始收 ----
fire('https://www.douyin.com/aweme/v1/web/collects/video/list/?collect_id=9',
     mkList(['B1', 'B2'], '目标夹内容'));

st = W.__nexusDyStat();
ok('打开后收到 2 条', st.items === 2, '收到 ' + st.items + ' 条');

// ---- ④ 关键：关着时再发数据，不能再进 ----
W.__nexusDyDisarm();
fire('https://www.douyin.com/aweme/v1/web/collects/video/list/?collect_id=99',
     mkList(['C1', 'C2', 'C3'], '停手之后的脏数据'));

st = W.__nexusDyStat();
ok('关掉后不再收', st.items === 2, '仍是 ' + st.items + ' 条');

// ---- ⑤ 导出只含开关打开期间的数据 ----
W.__nexusDyExport();
const payload = JSON.parse(store.blob);
const ids = payload.items.map((r) => r.aweme_id).sort().join(',');

ok('导出条数 = 2', payload.items.length === 2, '实际 ' + payload.items.length);
ok('导出内容只有目标夹的（B1,B2）', ids === 'B1,B2', ids);
ok('脏数据 A1-A3 没进来', !ids.includes('A1'), ids);
ok('脏数据 C1-C3 没进来', !ids.includes('C1'), ids);

// ---- ⑥ 重新打开要清空旧数据 ----
W.__nexusDyArm();
st = W.__nexusDyStat();
ok('重新打开时清空旧数据', st.items === 0, '清空后 ' + st.items + ' 条');

fire('https://www.douyin.com/aweme/v1/web/collects/video/list/?collect_id=77',
     mkList(['D1'], '重新开始后的内容'));
st = W.__nexusDyStat();
ok('重新打开后只收新数据', st.items === 1, st.items + ' 条');

W.__nexusDyExport();
const p2 = JSON.parse(store.blob);
ok('第二次导出的内容是新数据', p2.items[0].aweme_id === 'D1', p2.items[0].aweme_id);

// ---- ⑦ 版本与说明 ----
ok('版本号 3.2.0', p2.version === '3.2.0', p2.version);
ok('导出带回溯说明', typeof p2.capture_note === 'string' && p2.capture_note.length > 0,
   p2.capture_note);

console.log('');
console.log(fail === 0
  ? '全部通过（' + pass + ' 项）'
  : pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
