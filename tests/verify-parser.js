// verify-parser.js —— 一句话解析器的单元验证
// 从 index.html 里把解析相关的代码抽出来，在 node 里跑，不依赖浏览器。
const fs = require('fs');
const path = require('path');

const htmlPath = 'C:/Users/HXT/WorkBuddy/2026-08-22-15-35-35/nexus-core/index.html';
const html = fs.readFileSync(htmlPath, 'utf8');

// --- 抽出需要的段落 ---
function slice(startMark, endMark) {
  const a = html.indexOf(startMark);
  const b = html.indexOf(endMark, a);
  if (a < 0 || b < 0) throw new Error('找不到段落: ' + startMark);
  return html.slice(a, b);
}

const code = slice('// === 物品管理 / 库存 START ===', '// === 物品管理 / 库存 END ===');

// 在 node 里执行（纯解析函数不碰 DOM，但这个块里也含给浮层注册的 document 监听，
// 所以塞一个最小桩子 —— 见【踩过的坑】④）
const stubs = `
  const document = { addEventListener: function(){}, getElementById: function(){ return null; },
                     querySelectorAll: function(){ return []; }, body: { style: {} } };
  const window = {};
  const localStorage = { getItem: function(){ return null; }, setItem: function(){}, removeItem: function(){} };
  const Store = { get: function(k, d){ return d === undefined ? null : d; }, set: function(){} };
  const toast = function(){};
`;
const M = {};
const body = stubs + code + '\n; return { parseItemSentence, invSuggestDays, invLookupShelf, invStatus, invDaysLeft, invMakeItem, cnNumToInt, FOOD_INDEX, FOOD_SHELF_RAW, CAT_SHELF, INV_LOCATIONS };';
const fn = new Function(body);
Object.assign(M, fn());
const { parseItemSentence, invSuggestDays, invStatus, invDaysLeft, cnNumToInt, FOOD_INDEX, FOOD_SHELF_RAW } = M;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(label + (extra ? '  → ' + extra : '')); }
}

console.log('=== 表规模 ===');
console.log('  食材表条目:', FOOD_SHELF_RAW.length, ' 查询索引(含别名):', FOOD_INDEX.size);
ok(FOOD_SHELF_RAW.length >= 100, '食材表 >= 100 条', '实际 ' + FOOD_SHELF_RAW.length);

console.log('\n=== 中文数字 ===');
ok(cnNumToInt('两') === 2, '两=2');
ok(cnNumToInt('十') === 10, '十=10');
ok(cnNumToInt('十五') === 15, '十五=15');
ok(cnNumToInt('二十') === 20, '二十=20');
ok(cnNumToInt('二十三') === 23, '二十三=23');
ok(cnNumToInt('5') === 5, '5=5');

console.log('\n=== 解析：名称+数量+位置 ===');
let p = parseItemSentence('鸡蛋 10个 冷藏');
ok(p.name === '鸡蛋', '名称=鸡蛋', p.name);
ok(p.qty === '10' && p.unit === '个', '数量10个', p.qty + p.unit);
ok(p.loc === 'fridge', '位置=冷藏', p.loc);
ok(!!p.expireAt, '推出到期日', p.expireAt);
ok(p.days === 35, '冷藏鸡蛋=35天', String(p.days));

console.log('\n=== 解析：显式天数覆盖表 ===');
p = parseItemSentence('面包 常温 3天');
ok(p.name === '面包', '名称=面包', p.name);
ok(p.loc === 'ambient', '位置=常温', p.loc);
ok(p.days === 3, '用户说的3天优先', String(p.days));

console.log('\n=== 解析：绝对日期 ===');
p = parseItemSentence('牛奶 9月30日');
ok(p.name === '牛奶', '名称=牛奶', p.name);
ok(/^\d{4}-09-30$/.test(p.expireAt), '到期=9/30', p.expireAt);

console.log('\n=== 解析：中文数字数量 ===');
p = parseItemSentence('两提纸巾 储物柜');
ok(p.name === '纸巾', '名称=纸巾', p.name);
ok(p.qty === '两' && p.unit === '提', '数量两提', p.qty + p.unit);
ok(p.loc === 'cabinet', '位置=储物柜', p.loc);

console.log('\n=== 解析：相对时间 + 名称在前 ===');
p = parseItemSentence('西红柿2斤 冷藏 一周');
ok(p.name === '西红柿', '名称=西红柿', p.name);
ok(p.qty === '2' && p.unit === '斤', '数量2斤', p.qty + p.unit);
ok(p.days === 7, '一周=7天', String(p.days));

console.log('\n=== 解析：只有名称也能用（关键契约）===');
p = parseItemSentence('酱油');
ok(p.ok === true, 'ok=true');
ok(p.name === '酱油', '名称=酱油', p.name);
ok(p.loc === 'ambient', '默认位置=常温', p.loc);
ok(!!p.expireAt, '表里有酱油 → 自动推到期日', p.expireAt);

console.log('\n=== 解析：表里没有的怪句子，绝不能崩 ===');
p = parseItemSentence('昨天买的牛奶还剩半盒得赶紧喝');
ok(p.ok === true, '仍然 ok=true');
ok(p.name.length > 0, '有名称（当作整句）', p.name);

console.log('\n=== 解析：空输入 ===');
p = parseItemSentence('');
ok(p.ok === false, '空输入 ok=false');
ok(p.name === '', '空输入无名称');

console.log('\n=== 别名命中 ===');
p = parseItemSentence('车厘子 冷藏');
ok(p.name === '车厘子', '名称保留用户原词', p.name);
ok(p.days === 4, '车厘子命中樱桃=冷藏4天', String(p.days));

console.log('\n=== 位置与表不符时的提示 ===');
p = parseItemSentence('青菜 冷冻');
ok(!!p.shelfHint || p.days > 0, '青菜冷冻：给了个可用天数', JSON.stringify({ days: p.days, hint: p.shelfHint }));

console.log('\n=== invStatus 分档 ===');
const mk = (offset) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  const s = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  return { expireAt: s };
};
ok(invStatus(mk(-1)) === 'expired', '昨天=expired');
ok(invStatus(mk(0)) === 'soon', '今天=soon');
ok(invStatus(mk(2)) === 'soon', '+2=soon');
ok(invStatus(mk(3)) === 'soon', '+3=soon');
ok(invStatus(mk(5)) === 'week', '+5=week');
ok(invStatus(mk(20)) === 'ok', '+20=ok');
ok(invStatus({}) === 'none', '无到期日=none');

console.log('\n=== 建议天数覆盖抽查 ===');
const cases = [
  ['牛奶','fridge',5], ['鸡蛋','fridge',35], ['苹果','ambient',14],
  ['面包','ambient',2], ['猪肉','fridge',3], ['纸巾','ambient',1095],
];
for (const [n, loc, want] of cases) {
  const s = invSuggestDays(n, loc);
  ok(s.days === want, n + '/' + loc + ' = ' + want + '天', '实际 ' + s.days + ' (src=' + s.src + ')');
}

console.log('\n============================');
console.log('通过 %d / 失败 %d', pass, fail);
if (fails.length) {
  console.log('\n失败明细:');
  fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log('全部通过');
}
