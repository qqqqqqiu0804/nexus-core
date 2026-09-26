/**
 * 饮食一句话解析器测例。
 *
 * ★ 语料全部取自服务器 journal.db 里真实的饮食记录
 *   （2026-09-17 ~ 2026-09-26，7 天 17 条，唯一食物名 16 个）。
 *   不自己编「标准菜名」——那测出来的是我的想象，不是用户的写法。
 *
 * 纯函数、零依赖、无浏览器 → 可以进 CI。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ---- 从 index.html 里抠出解析器模块（跟 verify-expense-parser.js 同一套手法）----
const START = '// === 饮食一句话解析 START ===';
const END = '// === 饮食一句话解析 END ===';
const a = HTML.indexOf(START);
const b = HTML.indexOf(END);
if (a < 0 || b < 0) { console.error('✗ 抠不出饮食解析模块，断言会静默失效'); process.exit(1); }
const SRC = HTML.slice(a, b + END.length);

// ---- 造一个最小沙箱：解析器只依赖 Date / Math / String ----
const sandbox = { console, Date, Math, JSON, String, Number, Array, Object, parseInt, parseFloat, isNaN, RegExp };
vm.createContext(sandbox);
try {
  vm.runInContext(SRC + '\n;this.__p = parseMealSentence; this.__g = guessMealKcal; this.__d = defaultMealType; this.__l = mealTypeLabel; this.__w = mealKcalWhy; this.__n = normalizeMealText;',
    sandbox, { filename: 'meal-parser.js' });
} catch (e) {
  console.error('✗ 解析模块执行失败: ' + e.message);
  process.exit(1);
}
const parse = sandbox.__p;
const defaultMealType = sandbox.__d;
const mealTypeLabel = sandbox.__l;
const mealKcalWhy = sandbox.__w;

let pass = 0, fail = 0;
const fails = [];
function ok(msg) { pass++; }
function bad(msg) { fail++; fails.push(msg); }

function chk(cond, msg) { cond ? ok(msg) : bad(msg); }

// 固定一个「当前时间」的替身 —— 解析器里 defaultMealType(hour) 支持传参，
// 所以直接传 hour，不污染全局 Date（CI 里跑的时间不确定，不能依赖真实时钟）。
const H = { BREAKFAST: 8, LUNCH: 12, DINNER: 18, SNACK: 22 };

console.log('=== 一、真实语料：17 条原样跑一遍，必须条条可用 ===');
const CORPUS = [
  ['corn and egg', H.BREAKFAST, 'breakfast'],
  ['肉丝滑蛋饭', H.LUNCH, 'lunch'],
  ['自助饭', H.LUNCH, 'lunch'],
  ['西兰花加鸡蛋', H.DINNER, 'dinner'],
  ['番茄炒鸡胸肉面', H.LUNCH, 'lunch'],
  ['土豆片炒肉', H.DINNER, 'dinner'],
  ['饺子', H.DINNER, 'dinner'],
  ['两个鸡蛋和酸奶', H.BREAKFAST, 'breakfast'],
  ['鸭腿饭', H.LUNCH, 'lunch'],
  ['辣牛肉河粉', H.LUNCH, 'lunch'],
  ['酸奶加梨', H.SNACK, 'snack'],
  ['烤鸭腿饭 西兰花 蒸蛋', H.DINNER, 'dinner'],
  ['培根煎蛋堡', H.BREAKFAST, 'breakfast'],
  ['一点点藏青盐咸奶绿', H.SNACK, 'snack'],
  ['五谷渔粉', H.LUNCH, 'lunch'],
  ['鸡蛋，火腿肠，刀削面', H.BREAKFAST, 'breakfast'],
  ['西兰花加鸡蛋', H.DINNER, 'dinner']
];
CORPUS.forEach(function (row) {
  const input = row[0], hour = row[1], wantType = row[2];
  const p = parse(input, hour);
  chk(p.ok === true, '「' + input + '」ok=true');
  chk(p.name.length > 0, '「' + input + '」有名字');
  chk(p.type === wantType, '「' + input + '」餐次=' + wantType + '（实际 ' + p.type + '）');
  chk(p.kcal > 0, '「' + input + '」估出热量 >0（实际 ' + p.kcal + '）');
  chk(p.kcal < 4000, '「' + input + '」热量没夸张到 4000 以上（实际 ' + p.kcal + '）');
});

console.log('\n=== 二、热量估算的具体值（防回归，不是「感觉差不多」）===');
const KCAL_CASES = [
  // [输入, 期望值, 说明]
  ['米饭', 230, '单一主食'],
  ['肉丝滑蛋饭', 620, '描述性菜名 → 盖饭'],
  ['烤鸭腿饭', 700, '烤鸭饭'],
  ['鸭腿饭', 700, '别名命中'],
  ['奶茶', 450, '饮品'],
  ['一点点藏青盐咸奶绿', 450, '长商品名里含「藏青盐咸奶绿」→ 奶茶'],
  ['鸡蛋', 75, '蛋类'],
  ['酸奶加梨', 230, '两项相加 130+100'],
  ['烤鸭腿饭 西兰花 蒸蛋', 855, '三项相加 700+80+75'],
  ['西兰花加鸡蛋', 155, '两项相加 80+75'],
  ['corn and egg', 205, '英文 → 玉米130+鸡蛋75'],
  ['饺子', 450, '单份主食'],
  ['培根煎蛋堡', 400, '三明治类（先命中「培根煎蛋堡」整词）'],
  ['土豆片炒肉', 320, '菜名优先于「土豆」'],
  ['五谷渔粉', 450, '渔粉 → 河粉类']
];
KCAL_CASES.forEach(function (row) {
  const p = parse(row[0], H.LUNCH);
  chk(p.kcal === row[1], '「' + row[0] + '」= ' + row[1] + ' kcal（实际 ' + p.kcal + '）  // ' + row[2]);
});

console.log('\n=== 三、用户手填的数字压过估算 ===');
[['奶茶 500', 500], ['500kcal 鸡胸肉', 500], ['鸡胸肉 200大卡', 200], ['面条 800', 800]].forEach(function (row) {
  const p = parse(row[0], H.LUNCH);
  chk(p.kcal === row[1], '「' + row[0] + '」采用手填 ' + row[1] + '（实际 ' + p.kcal + '）');
  chk(p.kcalExact === true, '「' + row[0] + '」标记为手填');
  chk(p.kcalHits.length === 0, '「' + row[0] + '」手填时不给估算依据');
});

console.log('\n=== 四、数字不该被误当热量 ===');
// 「2 个鸡蛋」「3 两饭」这种小数字是数量不是热量。阈值 2 位数起步就是为这个。
[['2个鸡蛋', 75], ['3两米饭', 230], ['一份薯条', 300]].forEach(function (row) {
  const p = parse(row[0], H.LUNCH);
  chk(p.kcalExact === false, '「' + row[0] + '」小数字没被当成热量');
  chk(p.kcal > 0, '「' + row[0] + '」仍然估出了热量（实际 ' + p.kcal + '）');
});

console.log('\n=== 五、餐次猜测 ===');
// 按时段猜
const HOUR_CASES = [
  [2, 'snack', '凌晨2点 → 夜宵/零食'],
  [8, 'breakfast', '早8点 → 早餐'],
  [9, 'breakfast', '早9点 → 早餐'],
  [12, 'lunch', '午12点 → 午餐'],
  [14, 'lunch', '午14点 → 午餐'],
  [18, 'dinner', '晚18点 → 晚餐'],
  [20, 'dinner', '晚20点 → 晚餐'],
  [22, 'snack', '晚22点 → 零食']
];
HOUR_CASES.forEach(function (row) {
  const got = defaultMealType(row[0]);
  chk(got === row[1], '时段 ' + row[0] + ' 点 → ' + row[1] + '（实际 ' + got + '）  // ' + row[2]);
});
// 句首餐次词优先于时段
[['早餐 包子', 'breakfast'], ['午饭 面条', 'lunch'], ['晚饭 炒饭', 'dinner'], ['夜宵 烧烤', 'snack'],
 ['下午茶 蛋糕', 'snack']].forEach(function (row) {
  const p = parse(row[0], H.LUNCH);  // 故意传 LUNCH，验证文本里的餐次词能压过去
  chk(p.type === row[1], '「' + row[0] + '」餐次词生效 → ' + row[1] + '（实际 ' + p.type + '）');
  chk(p.typeGuessed === false, '「' + row[0] + '」标记为「非猜测」');
  chk(p.name.indexOf('早餐') < 0 && p.name.indexOf('午饭') < 0 && p.name.indexOf('晚饭') < 0,
      '「' + row[0] + '」餐次词已从名字里剥掉（实际名「' + p.name + '」）');
});

console.log('\n=== 六、动词 / 噪声词剥离 ===');
[['吃了碗面', '面'], ['喝了一杯奶茶', '奶茶'], ['来了一份饺子', '饺子']].forEach(function (row) {
  const p = parse(row[0], H.LUNCH);
  chk(p.name.indexOf(row[1]) >= 0, '「' + row[0] + '」名字里保留「' + row[1] + '」（实际「' + p.name + '」）');
  chk(p.kcal > 0, '「' + row[0] + '」仍然估出热量（实际 ' + p.kcal + '）');
});

console.log('\n=== 七、名称保留原话，不做「标准化」===');
chk(parse('corn and egg', H.BREAKFAST).name === 'corn and egg',
    '「corn and egg」原样存（实际「' + parse('corn and egg', H.BREAKFAST).name + '」）');
chk(parse('两个鸡蛋和酸奶', H.BREAKFAST).name === '两个鸡蛋和酸奶',
    '「两个鸡蛋和酸奶」原样存（实际「' + parse('两个鸡蛋和酸奶', H.BREAKFAST).name + '」）');
chk(parse('烤鸭腿饭 西兰花 蒸蛋', H.DINNER).name === '烤鸭腿饭 西兰花 蒸蛋',
    '一条多样不拆、原样存（实际「' + parse('烤鸭腿饭 西兰花 蒸蛋', H.DINNER).name + '」）');

console.log('\n=== 八、依据文案 ===');
const pw = parse('酸奶加梨', H.SNACK);
chk(mealKcalWhy(pw).indexOf('估') >= 0, '估算的依据文案带「估」字（实际「' + mealKcalWhy(pw) + '」）');
chk(mealKcalWhy(pw).indexOf('酸奶') >= 0 && mealKcalWhy(pw).indexOf('梨') >= 0,
    '依据里列出了两项（实际「' + mealKcalWhy(pw) + '」）');
const pe = parse('奶茶 500', H.SNACK);
chk(mealKcalWhy(pe) === '你填的', '手填的依据是「你填的」（实际「' + mealKcalWhy(pe) + '」）');
chk(mealKcalWhy(parse('', H.LUNCH)) === '', '空输入没有依据文案');

console.log('\n=== 九、契约：永远返回可用结果，绝不抛错 ===');
const NASTY = [
  '', '   ', null, undefined, '???', '。。。', '123', '0', '-5', 'a'.repeat(500),
  '<script>alert(1)</script>', '%%%', '🎉🎉', '　', '\t\n', 'kcal', '500kcal',
  '很大一碗超级无敌豪华全家福炒饭', '奶茶' .repeat(50)
];
NASTY.forEach(function (s) {
  let threw = null, p = null;
  try { p = parse(s, H.LUNCH); } catch (e) { threw = e.message; }
  chk(threw === null, '输入 ' + JSON.stringify(String(s).slice(0, 30)) + ' 不抛错' + (threw ? '（抛了：' + threw + '）' : ''));
  if (p) {
    chk(typeof p.name === 'string', '  返回的 name 是字符串');
    chk(typeof p.kcal === 'number' && !isNaN(p.kcal), '  返回的 kcal 是有效数字（实际 ' + p.kcal + '）');
    chk(['breakfast', 'lunch', 'dinner', 'snack'].indexOf(p.type) >= 0, '  返回的 type 合法（实际 ' + p.type + '）');
  }
});
// 空输入必须 ok=false
chk(parse('', H.LUNCH).ok === false, '空输入 ok=false');
chk(parse('   ', H.LUNCH).ok === false, '纯空白 ok=false');
chk(parse(null, H.LUNCH).ok === false, 'null ok=false');

console.log('\n=== 十、无重复计（同一食物只算一次）===');
const dup = parse('鸡蛋 鸡蛋 鸡蛋', H.LUNCH);
chk(dup.kcal === 75, '「鸡蛋 鸡蛋 鸡蛋」只算一次 75（实际 ' + dup.kcal + '）');
const dup2 = parse('鸡蛋，火腿肠', H.BREAKFAST);
chk(dup2.kcal === 425, '「鸡蛋，火腿肠」= 75+350（实际 ' + dup2.kcal + '）');

console.log('\n=== 十一、长词优先（防「饭」吃掉「烤鸭腿饭」）===');
// 这是一整类坑：短词必须不能抢先命中长词。
[['烤鸭腿饭', 700], ['滑蛋饭', 620], ['刀削面', 550], ['土豆片炒肉', 320], ['五谷渔粉', 450]]
  .forEach(function (row) {
    const p = parse(row[0], H.LUNCH);
    chk(p.kcal === row[1], '「' + row[0] + '」长词优先 = ' + row[1] + '（实际 ' + p.kcal + '）');
  });

console.log('\n--- 结果 ---');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) {
  console.log('\n失败明细：');
  fails.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
}
console.log('全部通过');
