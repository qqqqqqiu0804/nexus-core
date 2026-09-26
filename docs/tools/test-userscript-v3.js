/* 篡改猴脚本 v3 的专项测试 —— 覆盖 v2 修掉的三个设计缺陷
 *
 *   缺陷 1：面板只在"判定为收藏夹页面"时才建 → 判定失败就完全没反应
 *   缺陷 2：不给用户看到捕获了什么接口 → 用户没法告诉我卡在哪
 *   缺陷 3：只认 listcollection 一个路径 → 分组式收藏夹完全收不到
 *
 * ⚠️ 沙箱必须提供 location.origin —— 第一版沙箱只给了 href，
 *    导致 new URL(u, undefined) 抛错被吞，误报成"脚本有 bug"。
 *    （教训记在这里，别再犯）
 *
 * 跑法：node test-userscript-v3.js douyin-favorites.user.js
 */
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');

const store = {};
class FakeXHR {
  constructor(){ this._l={}; }
  open(m,u){ this._m=m; this._u=u; }
  send(){}
  addEventListener(ev,fn){ (this._l[ev]=this._l[ev]||[]).push(fn); }
  _fire(ev){ (this._l[ev]||[]).forEach(f=>f.call(this)); }
}
const panels = [];
function mkEl() {
  const e = {
    style:{}, children:[], _t:'', onclick:null,
    set textContent(v){ this._t=v }, get textContent(){ return this._t },
    set innerHTML(v){ this._h=v }, get innerHTML(){ return this._h },
    appendChild(c){ this.children.push(c) }, remove(){}, click(){}, 
    querySelector(){ return null },
  };
  return e;
}
const sandbox = {
  console,
  XMLHttpRequest: FakeXHR,
  location:{ href:'https://www.douyin.com/user/self?showTab=favorite_collection' },
  document:{
    title:'收藏夹', readyState:'complete',
    body:{ innerText:'收藏', appendChild(c){ panels.push(c); }, removeChild(){} },
    getElementById(){ return panels.length ? panels[0] : null },
    createElement(){ const e = mkEl(); return e; },
    addEventListener(){},
  },
  setInterval:()=>0, clearInterval(){}, setTimeout:()=>0,
  Blob: class { constructor(p){ store.blob = p[0]; } },
  URL:{ createObjectURL:()=>'blob:x', revokeObjectURL(){} },
  Date, JSON, Array, Object, String, Number, Boolean, Math, RegExp, URL: undefined,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
sandbox.URL = { createObjectURL:()=>'blob:x', revokeObjectURL(){} };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename:'us.js' });

let pass = 0, fail = 0;
const chk = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log('  [' + (ok?'OK':'FAIL') + '] ' + label + (ok?'':'  got='+JSON.stringify(got)+' want='+JSON.stringify(want)));
  ok ? pass++ : fail++;
};

console.log('=== v3 测试 ===');

// [1] 面板必须无条件建出来（v2 的 bug：判定失败就完全没有面板）
chk('面板已创建', panels.length > 0, true);
console.log('      面板数：' + panels.length);

// [2] 宽松匹配：分组接口也应该被捕获（老脚本只认 listcollection）
function fire(url, body) {
  const x = new sandbox.XMLHttpRequest();
  x.open('GET', url);
  x.send();
  x.responseText = JSON.stringify(body);
  x._fire('load');
}
// 分组形态（用户截图里那种「猛学 404」）
fire('https://www.douyin.com/aweme/v1/web/collects/list/?count=20', {
  collect_list: [
    { name:'对自己好', count:193 }, { name:'猛学', count:404 },
    { name:'大学计算机', count:249 }, { name:'期末备考', count:47 },
  ],
  has_more: 0,
});
let st = sandbox.window.__nexusDyStat();
chk('分组被识别（4 个）', st.groups.length, 4);
chk('分组名正确', st.groups.map(g=>g.name), ['对自己好','猛学','大学计算机','期末备考']);
chk('宽松匹配记录到接口', st.apis.some(a=>a.includes('collects/list')), true);

// [3] 视频形态仍然能收（不能为了分组把老功能弄坏）
fire('https://www.douyin.com/aweme/v1/web/aweme/listcollection/?cursor=0', {
  aweme_list: [
    { aweme_id:'v1', desc:' 视频一 ', author:{nickname:'A'}, video:{duration:1000}, statistics:{digg_count:5} },
    { aweme_id:'v2', desc:'视频二', author:{nickname:'B'}, video:{duration:2000}, statistics:{digg_count:6} },
  ],
  has_more: 0,
});
st = sandbox.window.__nexusDyStat();
chk('视频被收集（2 条）', st.items, 2);
chk('接口记录含 listcollection', st.apis.some(a=>a.includes('listcollection')), true);
chk('XHR 钩子已触发', st.hooks.xhr, true);

// [4] 导出应同时带上分组和接口清单（便于排查）
sandbox.window.__nexusDyExport();
const out = JSON.parse(store.blob);
chk('导出含 items', out.items.length, 2);
chk('导出含 groups', out.groups.length, 4);
chk('导出含 seen_apis', Array.isArray(out.seen_apis) && out.seen_apis.length >= 2, true);
chk('标题空格已清理', out.items[0].desc, '视频一');
chk('版本号已更新', out.version, '3.0.0');

console.log();
console.log(fail === 0 ? '全部通过（' + pass + ' 项）' : '失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
