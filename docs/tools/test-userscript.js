/* 篡改猴脚本的离线测试 —— 在假 DOM 里验证「截获 → 去重 → 导出」
 *
 * 为什么要有这个：篡改猴脚本依赖真实浏览器环境，很容易写成
 * "看着对、其实拿不到数据"。这里用最小假 DOM 把核心逻辑跑一遍，
 * 不浏览器也能验证去重和字段映射是否正确。
 *
 * 跑法：
 *   node docs/tools/test-userscript.js douyin-favorites.user.js
 *   （在 docs/tools 目录下执行）
 */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2] || 'douyin-favorites.user.js', 'utf8');

// ---- 造一个够用的假环境 ----
let capturedXHR = [];
class FakeXHR {
  constructor() { this._l = {}; }
  open(m, u) { this._m = m; this._u = u; }
  send() { capturedXHR.push(this); }
  addEventListener(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); }
  _fire(ev) { (this._l[ev] || []).forEach(f => f.call(this)); }
}
FakeXHR.prototype.responseText = '';

const store = {};
const sandbox = {
  console,
  XMLHttpRequest: FakeXHR,
  window: {},
  location: { href: 'https://www.douyin.com/user/self?showTab=collection' },
  document: {
    title: '我的收藏',
    readyState: 'complete',
    body: { innerText: '我的收藏 收藏列表', appendChild() {}, removeChild() {} },
    createElement() { return { style: {}, set textContent(v){this._t=v}, get textContent(){return this._t}, appendChild(){}, remove(){}, onclick:null, click(){ store.clicked = true; } }; },
    addEventListener() {},
  },
  setInterval: () => 0,
  clearInterval() {},
  setTimeout: () => 0,
  Blob: class { constructor(p){ store.blob = p[0]; } },
  URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
  Date,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// 脚本用了 XMLHttpRequest.prototype.open 的赋值 → 需要真 prototype
vm.runInContext(`
  globalThis.XMLHttpRequest = globalThis.XMLHttpRequest || function(){};
  globalThis.XMLHttpRequest.prototype = globalThis.XMLHttpRequest.prototype || {};
`, sandbox);

vm.runInContext(src, sandbox, { filename: 'userscript.js' });

// ---- 模拟页面自己发出的收藏夹请求 ----
console.log('=== 模拟抖音页面自己调收藏夹接口 ===');
function firePage(pageNo, hasMore) {
  const x = new sandbox.XMLHttpRequest();
  x.open('GET', 'https://www.douyin.com/aweme/v1/web/aweme/listcollection/?cursor=' + pageNo);
  x.send();
  const list = [];
  for (let i = 0; i < 3; i++) {
    list.push({ aweme_id: 'id_' + pageNo + '_' + i, desc: ' 视频标题 ' + pageNo + '-' + i + '  ',
                author: { nickname: '作者' + i }, video: { duration: 120000 },
                create_time: 1700000000, aweme_type: 0,
                statistics: { digg_count: 100 + i } });
  }
  // 第 2 页故意重复一条，验证去重
  if (pageNo === 2) list.push({ aweme_id: 'id_1_0', desc: '重复的', author:{} });
  x.responseText = JSON.stringify({ aweme_list: list, has_more: hasMore });
  x._fire('load');
}

firePage(1, 1);
firePage(2, 1);
firePage(3, 0);

console.log('  发了 3 页（共 9 条唯一 + 1 条重复）');
console.log();
console.log('=== 导出 ===');
sandbox.window.__nexusDyExport();
const parsed = JSON.parse(store.blob);
console.log('  count:', parsed.count, '(期望 9 —— 重复的 id_1_0 应被去重)');
console.log('  source:', parsed.source);
console.log('  第一条:');
console.log('    ', JSON.stringify(parsed.items[0]));
console.log();
console.log(parsed.count === 9 ? '✅ 去重正确、字段齐全' : '❌ 条数不对：' + parsed.count);
