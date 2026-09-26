// verify-expense-parser.js —— 记账解析器验证
// 测试语料**不是编的**，是用户真实 111 笔交易里的备注和习惯。
const fs = require('fs');
const path = require('path');

// 用相对于仓库根的位置解析，别写绝对路径 —— CI 在别的机器上跑，绝对路径必挂。
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const a = html.indexOf('// === 记账一句话解析 START ===');
const b = html.indexOf('// === 记账一句话解析 END ===');
if (a < 0 || b < 0) throw new Error('找不到记账解析段落');
const code = html.slice(a, b);

const stubs = `
  const Store = { get: function(k, d){ return d === undefined ? null : d; }, set: function(){} };
  const CASH_POOL_ID = '__pool__';
  function loadWallet(){ return { transactions: [], cashAccounts: [] }; }
  function localStamp(){ return '2026-09-26T20:00:00'; }
`;
const fn = new Function(stubs + code + '\n; return { parseExpenseSentence, guessCategory, cnMoneyToNum, CAT_WORDS };');
const M = fn();
const { parseExpenseSentence, guessCategory, cnMoneyToNum } = M;

let pass = 0, fail = 0;
const fails = [];
function ok(c, l, e) { if (c) pass++; else { fail++; fails.push(l + (e ? '  → ' + e : '')); } }

console.log('=== 中文金额 ===');
ok(cnMoneyToNum('5') === 5, '5=5');
ok(cnMoneyToNum('五') === 5, '五=5');
ok(cnMoneyToNum('十') === 10, '十=10');
ok(cnMoneyToNum('十五') === 15, '十五=15');
ok(cnMoneyToNum('三十') === 30, '三十=30');
ok(cnMoneyToNum('三百') === 300, '三百=300');
ok(cnMoneyToNum('8.5') === 8.5, '8.5=8.5');

console.log('\n=== 用户真实备注 → 分类（这是核心，餐饮占 59%）===');
// 全部取自用户真实的 111 笔交易备注
const realCases = [
  ['肠粉 8', '餐饮'], ['塔斯汀汉堡 32', '餐饮'], ['土豆炒肉 15', '餐饮'],
  ['3升矿泉水 6', '餐饮'], ['鸡丝拌粉 12', '餐饮'], ['绿豆沙 5', '餐饮'],
  ['皮蛋瘦肉粥 9', '餐饮'], ['烤鸭饭 18', '餐饮'], ['肉丝滑蛋饭 17', '餐饮'],
  ['自助饭 22', '餐饮'], ['鲜肉饼 7', '餐饮'], ['包子 4', '餐饮'],
  ['两个梨子 12', '餐饮'], ['嚼酸奶16袋 30', '餐饮'], ['买菜 45', '餐饮'],
  ['地铁 4', '交通'], ['地铁 4', '交通'], ['地铁 4', '交通'],
];
for (const [text, want] of realCases) {
  const r = parseExpenseSentence(text);
  ok(r.category === want, text + ' → ' + want, '实际 ' + r.category + ' (hit=' + r.catHit + ')');
}

console.log('\n=== 其他分类（也取自真实数据）===');
const others = [
  ['联通话费 30', '生活'], ['租相机 60', '生活'],
  ['买服务器 一年99', '购物'], ['域名购买 45', '购物'],
  ['代抢四级 20', '学习'], ['算综测 15', '学习'],
  ['陪玩 20', '娱乐'], ['两张免单卡 10', '娱乐'],
];
for (const [text, want] of others) {
  const r = parseExpenseSentence(text);
  ok(r.category === want, text + ' → ' + want, '实际 ' + r.category + ' (hit=' + r.catHit + ')');
}

console.log('\n=== 金额识别 ===');
let r = parseExpenseSentence('咖啡 32');
ok(r.amount === 32, '「咖啡 32」金额=32', String(r.amount));
ok(r.type === 'expense', '类型=支出', r.type);
ok(r.category === '餐饮', '分类=餐饮', r.category);

r = parseExpenseSentence('¥32.5 午饭');
ok(r.amount === 32.5, '「¥32.5」金额=32.5', String(r.amount));

r = parseExpenseSentence('花了32 午饭');
ok(r.amount === 32, '「花了32」剥掉干扰词', String(r.amount));

r = parseExpenseSentence('奶茶 十五块');
ok(r.amount === 15, '中文金额「十五块」=15', String(r.amount));

r = parseExpenseSentence('8.5 地铁');
ok(r.amount === 8.5, '金额在前也认', String(r.amount));
ok(r.category === '交通', '分类=交通', r.category);

console.log('\n=== 收入识别（真实分类：生活费/工资/兼职）===');
r = parseExpenseSentence('工资 8000');
ok(r.type === 'income', '「工资」→ 收入', r.type);
ok(r.category === '工资', '分类=工资', r.category);
ok(r.amount === 8000, '金额=8000', String(r.amount));

r = parseExpenseSentence('生活费 1500');
ok(r.type === 'income', '「生活费」→ 收入', r.type);
ok(r.category === '生活费', '分类=生活费', r.category);

r = parseExpenseSentence('兼职 300');
ok(r.type === 'income' && r.category === '兼职', '「兼职」→ 收入/兼职', r.type + '/' + r.category);

console.log('\n=== 日期（真实用户会补记）===');
r = parseExpenseSentence('买菜 45 昨天');
ok(/T/.test(r.date), '有日期', r.date);
const y = new Date(); y.setDate(y.getDate() - 1);
const yStr = y.getFullYear() + '-' + String(y.getMonth()+1).padStart(2,'0') + '-' + String(y.getDate()).padStart(2,'0');
ok(r.date.startsWith(yStr), '「昨天」= 昨天日期', r.date + ' 期望前缀 ' + yStr);
ok(r.category === '餐饮', '「买菜」→餐饮', r.category);
ok(r.amount === 45, '金额=45', String(r.amount));

r = parseExpenseSentence('地铁 4 前天');
const d2 = new Date(); d2.setDate(d2.getDate() - 2);
const d2Str = d2.getFullYear() + '-' + String(d2.getMonth()+1).padStart(2,'0') + '-' + String(d2.getDate()).padStart(2,'0');
ok(r.date.startsWith(d2Str), '「前天」正确', r.date);

r = parseExpenseSentence('晚饭 30 今天');
const t0 = new Date();
const t0Str = t0.getFullYear() + '-' + String(t0.getMonth()+1).padStart(2,'0') + '-' + String(t0.getDate()).padStart(2,'0');
ok(r.date.startsWith(t0Str), '「今天」正确', r.date);

console.log('\n=== 备注保留 ===');
r = parseExpenseSentence('塔斯汀汉堡 32');
ok(/塔斯汀/.test(r.note), '备注含塔斯汀', r.note);
ok(r.amount === 32 && r.category === '餐饮', '金额分类都对');

r = parseExpenseSentence('奶茶 15');
ok(r.note === '奶茶' || r.note === '', '「奶茶」要么当备注要么被吃掉', JSON.stringify(r.note));

console.log('\n=== 极端输入不能崩（关键契约）===');
const weird = ['', '   ', '???', '今天', '123', '不知道写什么反正就是一段很长的话没有任何数字',
               '¥', '，，，', 'aaa 999999', '昨天买了点东西'];
for (const w of weird) {
  let crashed = false, res = null;
  try { res = parseExpenseSentence(w); } catch (e) { crashed = true; }
  ok(!crashed, '不崩: ' + JSON.stringify(w).slice(0, 24), crashed ? 'crashed' : '');
}
ok(parseExpenseSentence('').ok === false, '空输入 ok=false');
ok(parseExpenseSentence('???').amount === 0, '无金额时 amount=0');
ok(parseExpenseSentence('工资 8000').ok === true, '有金额 ok=true');

console.log('\n=== 长关键词优先（防误判）===');
// 「水费」该归生活，不能因为含「水」被归餐饮
r = parseExpenseSentence('水费 50');
ok(r.category === '生活', '「水费」→生活（不是餐饮）', r.category);
// 「地铁」该归交通，「铁」不是关键词
r = parseExpenseSentence('地铁 4');
ok(r.category === '交通', '「地铁」→交通', r.category);

console.log('\n============================');
console.log('通过 %d / 失败 %d', pass, fail);
if (fails.length) { console.log('\n失败明细:'); fails.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
console.log('全部通过');
