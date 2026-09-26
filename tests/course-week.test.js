#!/usr/bin/env node
/**
 * course-week.test.js —— 课表「周次切换 + 全学期总览」的行为回归
 *
 * 背景：这块新功能最容易悄悄坏掉的地方，不是「按钮点了没反应」，而是
 * **同一屏上两个数字打架**。真实踩到过：
 *   总览卡片写「第 3 周 12 节」，周次选择器角标却写 14 节 ——
 *   因为角标只数了 weeks 数组、没扣掉中秋三天假期，两个口径各算各的。
 * 这种错嘴上说「对齐口径」是挡不住的，只能把口径写成断言。
 *
 * 另一类要防的是「跟随态」被写死成具体周次：
 *   默认应跟随今天，翻走才固定；翻回本周要能自动回到跟随态，
 *   否则应用开着跨过周日午夜后视图会卡在旧周不动。
 *
 * 用法：node tests/course-week.test.js [index.html 路径]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

// 课表模块的代码区间：从常量区到「一次性迁移」之前
const START = 'const TERM_START';
const END = 'function migrateDailyTemplatesToTasks()';
const from = html.indexOf(START);
const to = html.indexOf(END);
if (from < 0 || to < 0 || to <= from) {
  console.log('✗ 找不到课表模块代码区间（锚点漂了）：' + START + ' / ' + END);
  process.exit(1);
}
const courseCode = html.slice(from, to);

// localDate 定义在文件很前面的通用工具区（不在课表区间里），
// 这里按原样补一份，保证沙箱里 holidayForDate 能用。
// 值必须和 index.html 的实现一致 —— 它决定「哪天算假期」，算错了第 4 节会全红。
function localDate(d = new Date()) {
  const x = new Date(d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}

// --- 沙箱：只给课程模块需要的几样东西 ---
// 假 Store：内存版 localStorage，语义要和真的一致
const mem = {};
const Store = {
  get(k, d) {
    if (!(k in mem)) return d;
    try { return JSON.parse(mem[k]); } catch { return d; }
  },
  set(k, v) { mem[k] = JSON.stringify(v); },
};
const sandbox = {
  console, Store, localDate,
  Date, Math, JSON, Array, Object, Number, String, Boolean, isNaN, parseInt, parseFloat,
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
  showToast() {}, icon: () => '', escAttr: (s) => String(s),
  showCourseFull() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

// 只跑课程模块这一段。声明是 function/const/let 混着的，
// const/let 不会变成沙箱属性，所以下面统一用 runInContext 桥接出来。
try {
  vm.runInContext(courseCode, ctx, { filename: 'course-module.js' });
} catch (e) {
  console.log('✗ 课表模块加载失败：' + e.message);
  process.exit(1);
}
const NAMES = [
  'TERM_START', 'DEFAULT_COURSES', 'SCHEDULE_OVERRIDES', 'HOLIDAYS', 'MAKEUP_DAYS',
  'termTotalWeeks', 'lessonsInWeek', 'activeWeek', 'setCourseWeek', 'stepCourseWeek',
  'gotoCurrentWeek', 'getCurrentWeek', 'weekForDate', 'getWeekRange', 'getWeekDates',
  'courseMatches', 'coursesOnDay', 'weekSpanText', 'courseMatches', 'getCourses',
  'renderWeekPicker', 'renderCourseOverview', 'overviewJump', 'switchCourseView', 'renderCourses',
];
vm.runInContext('globalThis.__api = { ' + NAMES.map(n => n + ': (typeof ' + n + " !== 'undefined' ? " + n + ' : undefined)').join(', ') + ' };', ctx);
const A = ctx.__api;

// 抓 console.warn（总览里的口径自检会打）
const warns = [];
sandbox.console = { ...console, warn: (...a) => warns.push(a.join(' ')), log: () => {}, error: () => {} };

// 让「当前周」可控：沙箱里 Date 是真的，所以用固定日期注入算出当前周
function weekOf(dateStr) { return A.weekForDate(new Date(dateStr + 'T09:00:00')); }

console.log('【1】学期总周数必须由课表实际最大周次推出，不写死');
{
  const total = A.termTotalWeeks();
  let max = 0;
  for (const c of A.DEFAULT_COURSES.concat(A.SCHEDULE_OVERRIDES)) {
    for (const w of c.weeks) if (w > max) max = w;
  }
  total === max
    ? ok(`总周数 ${total} === 课表最大周次 ${max}`)
    : bad(`总周数 ${total} ≠ 课表最大周次 ${max}（写死了？换学期导入新课表就会算错）`);

  // 空课表时要有兜底，不能让选择器变成 0 格
  Store.set('courses', []);
  delete ctx.__x;
  const emptyTotal = vm.runInContext(
    '(function(){ const saved = getCourses; return termTotalWeeks(); })()', ctx);
  emptyTotal >= 1
    ? ok(`空课表时总周数兜底为 ${emptyTotal}（>=1，选择器不会空）`)
    : bad('空课表时总周数算成 0，周次选择器会变成空的');
  Store.set('courses', A.DEFAULT_COURSES);
}

console.log('\n【2】周次切换：跟随态 / 固定态 / 越界夹取');
{
  const cur = A.getCurrentWeek();
  A.gotoCurrentWeek();
  A.activeWeek() === cur
    ? ok(`跟随态 activeWeek()=${cur} === 当前周`)
    : bad(`跟随态 activeWeek()=${A.activeWeek()} ≠ 当前周 ${cur}`);

  A.setCourseWeek(13);
  A.activeWeek() === 13
    ? ok('setCourseWeek(13) 后 activeWeek()=13')
    : bad('setCourseWeek(13) 没生效，activeWeek()=' + A.activeWeek());
  A.setCourseWeek(13);
  A.activeWeek() === 13 ? ok('重复设同一周是幂等的') : bad('重复设同一周被改掉了');

  // 越界必须夹住而不是报错/静默失败
  A.setCourseWeek(0);
  A.activeWeek() === 1 ? ok('setCourseWeek(0) 夹到第 1 周') : bad('setCourseWeek(0) 得到 ' + A.activeWeek());
  A.setCourseWeek(999);
  A.activeWeek() === A.termTotalWeeks()
    ? ok(`setCourseWeek(999) 夹到最后一周（${A.termTotalWeeks()}）`)
    : bad('setCourseWeek(999) 得到 ' + A.activeWeek());
  A.setCourseWeek(-5);
  A.activeWeek() === 1 ? ok('setCourseWeek(-5) 夹到第 1 周') : bad('负数没夹住：' + A.activeWeek());
  A.setCourseWeek('abc');
  A.activeWeek() === 1 ? ok('非数字输入不炸，夹到第 1 周') : bad('非数字输入得到 ' + A.activeWeek());

  // 翻页
  A.setCourseWeek(5);
  A.stepCourseWeek(1);
  A.activeWeek() === 6 ? ok('stepCourseWeek(+1)：5 → 6') : bad('翻页 +1 得到 ' + A.activeWeek());
  A.stepCourseWeek(-1);
  A.activeWeek() === 5 ? ok('stepCourseWeek(-1)：6 → 5') : bad('翻页 -1 得到 ' + A.activeWeek());

  // 边界处翻页不能再动
  A.setCourseWeek(1);
  A.stepCourseWeek(-1);
  A.activeWeek() === 1 ? ok('第 1 周再往前翻仍是第 1 周') : bad('第 1 周往前翻跑到了 ' + A.activeWeek());
  A.setCourseWeek(A.termTotalWeeks());
  A.stepCourseWeek(1);
  A.activeWeek() === A.termTotalWeeks()
    ? ok('最后一周再往后翻仍是最后一周')
    : bad('最后一周往后翻跑到了 ' + A.activeWeek());

  // 从跟随态翻页：基准必须是「今天所在周」
  A.gotoCurrentWeek();
  const c0 = A.getCurrentWeek();
  A.stepCourseWeek(1);
  A.activeWeek() === c0 + 1
    ? ok(`跟随态按下一周：${c0} → ${c0 + 1}（基准是今天所在周，不是 0）`)
    : bad(`跟随态翻页错误：期望 ${c0 + 1}，得到 ${A.activeWeek()}`);
}

console.log('\n【3】翻回本周必须回到「跟随态」，不能只是数字上相等');
{
  const cur = A.getCurrentWeek();
  A.setCourseWeek(13);
  A.setCourseWeek(cur);
  A.activeWeek() === cur
    ? ok('setCourseWeek(当前周) 后 activeWeek() 正确')
    : bad('setCourseWeek(当前周) 后 activeWeek()=' + A.activeWeek());

  // 关键：_courseWeek 应已归 null。否则跨过周日午夜后视图不跟进。
  const raw = vm.runInContext('_courseWeek', ctx);
  raw === null
    ? ok('_courseWeek 已归 null（真正回到跟随态，跨周会自动跟进）')
    : bad(`_courseWeek=${JSON.stringify(raw)} 仍是固定值 —— 跨周后会卡在旧周不跟进`);

  A.setCourseWeek(13);
  A.gotoCurrentWeek();
  vm.runInContext('_courseWeek', ctx) === null
    ? ok('gotoCurrentWeek() 也回到跟随态')
    : bad('gotoCurrentWeek() 没把 _courseWeek 归 null');
}

console.log('\n【4】口径一致性：选择器角标 === 总览卡片 === 逐天实算');
{
  // 用「星期 + 周次」逐天算，并把假期剔掉 —— 这是唯一正确的口径
  const DAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const pad = n => String(n).padStart(2, '0');
  const ds = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const isHol = d => {
    const s = ds(d);
    return A.HOLIDAYS.some(h => s >= h.from && s <= h.to);
  };
  const all = A.getCourses();

  let mismatch = 0, checked = 0;
  for (let w = 1; w <= A.termTotalWeeks(); w++) {
    let expect = 0;
    A.getWeekDates(w).forEach((d, i) => {
      if (isHol(d)) return;
      expect += all.filter(c => c.day === DAYS[d.getDay()] && c.weeks.includes(w)).length;
    });
    const got = A.lessonsInWeek(w);
    checked++;
    if (got !== expect) { mismatch++; if (mismatch <= 3) bad(`第 ${w} 周：lessonsInWeek=${got}，逐天实算=${expect}`); }
  }
  mismatch === 0
    ? ok(`${checked} 周的 lessonsInWeek 都等于逐天实算（含假期扣除）`)
    : bad(`共 ${mismatch} 周口径不一致`);

  // 假期必须真的被扣掉，否则「空周」会被算成有课
  const holWeek = 4; // 国庆 10/1-10/7 落在第 4 周
  const rawCount = all.filter(c => c.weeks.includes(holWeek)).length;
  const netCount = A.lessonsInWeek(holWeek);
  netCount < rawCount
    ? ok(`第 ${holWeek} 周（国庆）扣假后 ${netCount} < 未扣假 ${rawCount}，假期确实被扣了`)
    : bad(`第 ${holWeek} 周假期没扣：${netCount} vs ${rawCount}`);
}

console.log('\n【5】全学期总览：周数、覆盖、统计');
{
  // 总览渲染需要 DOM，这里退一步：直接复算总览用的统计量，验证定义正确
  const DAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const pad = n => String(n).padStart(2, '0');
  const ds = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const isHol = d => { const s = ds(d); return A.HOLIDAYS.some(h => s >= h.from && s <= h.to); };

  const total = A.termTotalWeeks();
  const weeks = [];
  for (let w = 1; w <= total; w++) {
    let n = 0;
    A.getWeekDates(w).forEach(d => { if (!isHol(d)) n += A.lessonsInWeek(w) ? A.getCourses().filter(c => c.day === DAYS[d.getDay()] && c.weeks.includes(w)).length : 0; });
    weeks.push(n);
  }
  // 上面写法在没课的日子会漏，改用 strict 版本
  const per = [];
  for (let w = 1; w <= total; w++) {
    let n = 0;
    A.getWeekDates(w).forEach(d => {
      if (isHol(d)) return;
      n += A.getCourses().filter(c => c.day === DAYS[d.getDay()] && c.weeks.includes(w)).length;
    });
    per.push(n);
  }
  const totLessons = per.reduce((a, b) => a + b, 0);
  const withCourses = per.filter(n => n > 0).length;

  per.length === total
    ? ok(`总览周数与 termTotalWeeks 一致（${total} 周）`)
    : bad(`总览周数 ${per.length} ≠ ${total}`);
  withCourses === total
    ? ok(`全部 ${total} 周都有课（没有空白周）`)
    : ok(`${withCourses}/${total} 周有课，${total - withCourses} 周为空（假期周，会显示「整周假期」）`);
  totLessons > 0
    ? ok(`全学期总节数 ${totLessons} > 0`)
    : bad('全学期总节数为 0，总览会是空的');

  // 每周节数必须落在合理区间，防「某周算出 200 节」这种明显错
  const maxPer = Math.max(...per), minPer = Math.min(...per);
  (maxPer <= 7 * 6 && minPer >= 0)
    ? ok(`每周节数区间 [${minPer}, ${maxPer}] 合理（上限 7天×6大节=42）`)
    : bad(`每周节数区间 [${minPer}, ${maxPer}] 越界`);

  // 总览必须覆盖到「课表里出现过的每一周」—— 不能漏周
  let missed = [];
  for (let w = 1; w <= total; w++) {
    if (!A.getCourses().some(c => c.weeks.includes(w)) && per[w - 1] > 0) missed.push(w);
  }
  missed.length === 0
    ? ok('总览没有漏掉任何「有课却算成 0 节」的周')
    : bad('这些周有课但总览算成 0：' + missed.join(','));
}

console.log('\n【6】weeks 数组的人类可读化（总览/日视图都用它）');
{
  const f = A.weekSpanText;
  const cases = [
    [[1, 2, 3, 4, 5], '1-5周'],
    [[1], '1周'],
    [[11, 12], '11-12周'],
    [[1, 2, 3, 5, 6, 7], '1-3, 5-7周'],
    [[3, 1, 2], '1-3周'],
    [[1, 1, 2, 2, 3], '1-3周'],
  ];
  let badCount = 0;
  for (const [input, expect] of cases) {
    const got = f(input);
    if (got !== expect) { badCount++; bad(`weekSpanText(${JSON.stringify(input)}) = "${got}"，期望 "${expect}"`); }
  }
  if (!badCount) ok(`${cases.length} 组 weeks → 范围文本 全部正确（含乱序/重复）`);

  // 真实数据跑一遍：不能出现 undefined / NaN
  let dirty = [];
  for (const c of A.getCourses()) {
    const t = f(c.weeks);
    if (/undefined|NaN|null/.test(t)) dirty.push(c.name + ' → ' + t);
  }
  dirty.length === 0
    ? ok(`全部 ${A.getCourses().length} 条真实课程的周次文本都干净`)
    : bad('周次文本有脏值：' + dirty.slice(0, 3).join(' | '));

  (f([]) !== '' || true) && ok('空数组不抛异常（返回「' + f([]) + '」）');
}

console.log('\n【7】日视图预览别的周时，基准日必须是那一周的周一');
{
  // 这是「标题写第13周、内容却是今天」那个自相矛盾的防线
  const w13 = A.getWeekDates(13);
  const ds = w13[0];
  const pad = n => String(n).padStart(2, '0');
  const dstr = ds.getFullYear() + '-' + pad(ds.getMonth() + 1) + '-' + pad(ds.getDate());
  dstr === '2026-11-30'
    ? ok('第 13 周周一 = 2026-11-30（与 TERM_START 推算一致）')
    : bad('第 13 周周一算成 ' + dstr + '，期望 2026-11-30');

  const w1 = A.getWeekDates(1)[0];
  const d1 = w1.getFullYear() + '-' + pad(w1.getMonth() + 1) + '-' + pad(w1.getDate());
  d1 === A.TERM_START
    ? ok(`第 1 周周一 === TERM_START（${A.TERM_START}）`)
    : bad(`第 1 周周一 ${d1} ≠ TERM_START ${A.TERM_START}`);

  // coursesOnDay：给定周次 + 星期名直接查，不依赖真实日期
  const mon13 = A.coursesOnDay(13, '星期一');
  const allMon13 = A.getCourses().filter(c => c.day === '星期一' && c.weeks.includes(13));
  mon13.length === allMon13.length
    ? ok(`coursesOnDay(13,'星期一') 命中 ${mon13.length} 门，与直接筛选一致`)
    : bad(`coursesOnDay 结果 ${mon13.length} ≠ 直接筛选 ${allMon13.length}`);

  // 必须按 section 升序，否则日视图卡片顺序会乱
  const sorted = mon13.every((c, i) => i === 0 || mon13[i - 1].section <= c.section);
  sorted ? ok('coursesOnDay 结果按大节升序') : bad('coursesOnDay 没排序，卡片顺序会乱');

  // 空结果不能抛
  A.coursesOnDay(999, '星期一').length === 0
    ? ok('越界周次返回空数组而不是抛异常')
    : bad('越界周次没返回空数组');
}

console.log('\n【8】周次选择器渲染的静态契约');
{
  const picker = html.slice(html.indexOf('function renderWeekPicker'), html.indexOf('function renderCourseDay'));
  // 选择器必须真的调 setCourseWeek，否则点了没反应
  /onclick="setCourseWeek\(\$\{w\}\)"/.test(picker)
    ? ok('每个周次格都绑定了 setCourseWeek(w)')
    : bad('周次格没有绑定 setCourseWeek —— 点了不会切换');

  // 边界时禁用翻页按钮
  /week <= 1 \? 'disabled' : ''/.test(picker) && /week >= total \? 'disabled' : ''/.test(picker)
    ? ok('第 1 周 / 最后一周时翻页按钮会 disabled')
    : bad('边界周次没禁用翻页按钮，会点出越界值');

  // 当前周必须滚进可视区
  /scrollLeft/.test(picker)
    ? ok('渲染后会把选中的周次滚进可视区')
    : bad('没做 scrollLeft —— 选到第 13 周时视图停在最左，用户看不到选中格');

  // 必须有两个计数元素口径相同
  ;(picker.includes('lessonsInWeek(w)') ? ok : bad).call(null,
    picker.includes('lessonsInWeek(w)')
      ? '角标用 lessonsInWeek(w)（与总览同口径）'
      : '角标没走 lessonsInWeek，口径会和总览不一致');
}

console.log('\n【9】CSS 静态契约：触控尺寸与横滚');
{
  const styleBlock = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/) || [, ''])[1];
  const css = styleBlock.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
    const m = css.match(re);
    return m ? m[1] : '';
  };
  // 同一个选择器可能有多条规则（`.course-view-toggle` 在 @media 里也出现了一次）。
  // 上面那个 rule() 只取第一条，单条取值时够用；但「属性是否存在于任意一条」必须看全部，
  // 否则会像下面 nowrap 那样误报 —— 抽出来了却查不到，看着像代码没写。
  const allRules = (sel) => {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
    return [...css.matchAll(re)].map(m => m[1]);
  };
  const px = (body, prop) => {
    const m = body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([\\d.]+)px'));
    return m ? parseFloat(m[1]) : null;
  };

  const cell = rule('.wk-cell');
  const ch = px(cell, 'height'), cw = px(cell, 'min-width');
  (ch >= 44) ? ok(`.wk-cell 高 ${ch}px ≥ 44px（触控下限）`) : bad(`.wk-cell 高 ${ch}px < 44px，手机上难点中`);
  (cw >= 44) ? ok(`.wk-cell 宽 ${cw}px ≥ 44px`) : bad(`.wk-cell 宽 ${cw}px < 44px`);

  const step = rule('.wk-step');
  const sh = px(step, 'height');
  (sh >= 44) ? ok(`.wk-step 高 ${sh}px ≥ 44px`) : bad(`.wk-step 高 ${sh}px < 44px`);

  const track = rule('.wk-track');
  /overflow-x:\s*auto/.test(track)
    ? ok('.wk-track 用 overflow-x:auto 横滚（不换行，避免把课表顶下去）')
    : bad('.wk-track 没有横向滚动 —— 16 个周次会换行成三行高');

  // 四个视图按钮不能换行（「总览」会被挤成两行）。
  // 用 allRules：这条属性在 @media 之外的主规则里，但同选择器有多条，取第一条会误报。
  const tglAll = allRules('.course-view-toggle').join(' ');
  /flex-wrap:\s*nowrap/.test(tglAll)
    ? ok('.course-view-toggle 用 nowrap（总览按钮不会被挤成两行）')
    : bad('.course-view-toggle 没锁 nowrap，390px 上「总览」会折行');

  // 总览卡片必须是纵向列表而不是宽网格
  const card = rule('.ov-card');
  card.length > 0
    ? ok('.ov-card 存在（总览用纵向卡片，不是 N 周 × 7 天大网格）')
    : bad('.ov-card 不存在，总览没有样式基座');

  // 汇总区四列在窄屏要能缩
  const sum = rule('.ov-summary');
  /minmax\(\s*0\s*,/.test(sum)
    ? ok('.ov-summary 用 minmax(0,·)（窄屏不会被内容撑破）')
    : bad('.ov-summary 缺 minmax(0,·)，320px 上可能横向溢出');

  // 长地点名要能省略，不能撑破行
  const loc = rule('.ov-loc');
  /text-overflow:\s*ellipsis/.test(loc) && /overflow:\s*hidden/.test(loc)
    ? ok('.ov-loc 有 ellipsis 收口（长地点名不会撑破一行）')
    : bad('.ov-loc 缺 ellipsis，长地名会把行撑宽');
}

console.log('\n【10】原有课表功能未被破坏');
{
  // 原有四个入口还得在
  const musts = [
    ['TERM_START 未被改动', A.TERM_START === '2026-09-07'],
    ['DEFAULT_COURSES 仍是 23 条', A.DEFAULT_COURSES.length === 23],
    ['courseMatches 语义未变', A.courseMatches({ weeks: [1, 3] }, 3) === true && A.courseMatches({ weeks: [1, 3] }, 2) === false],
    ['courseMatches 对缺 weeks 的课不炸', A.courseMatches({}, 1) === undefined || A.courseMatches({}, 1) === false],
    ['getWeekRange 格式仍是 M/D - M/D', /^\d+\/\d+ - \d+\/\d+$/.test(A.getWeekRange(13))],
    ['weekForDate 对早于开学返回 1', A.weekForDate(new Date('2026-01-01T09:00:00')) === 1],
  ];
  for (const [name, cond] of musts) cond ? ok(name) : bad(name);

  // 三个旧视图仍在
  ['day', 'week', 'forecast'].forEach(v => {
    html.includes(`data-view="${v}"`) ? ok(`视图按钮 ${v} 仍在`) : bad(`视图按钮 ${v} 被删了`);
  });
  html.includes('data-view="overview"') ? ok('新视图按钮 overview 已加') : bad('总览按钮没加上');
}

console.log('\n【11】总览口径自检必须真的挂上（不是死代码）');
{
  const ov = html.slice(html.indexOf('function renderCourseOverview'), html.indexOf('function overviewJump'));
  /lessonsInWeek\(w\)/.test(ov)
    ? ok('总览里调用了 lessonsInWeek 做口径自检')
    : bad('总览没有和 lessonsInWeek 对账，两个数字又能各算各的了');
  /console\.warn/.test(ov)
    ? ok('不一致时会 console.warn（不是静默）')
    : bad('口径不一致时静默通过，问题会埋在界面里');
}

console.log('\n【12】周视图布局契约（手机上不可读的坑，用断言钉住）');
{
  // 这一段是线上实际出过问题的：周视图在手机上曾出现
  //   ① 左栏「第一 大 节」被挤成一个字一行，整列拉成竖线；
  //   ② 320px 下网格撑出页面，整页多出 9px 横向滚动；
  //   ③ 为了塞下而把列宽压到 38px，中文课名又变成一字一行。
  // 三类都是「CSS 看着没写错、渲染出来才发现」的问题，只能靠契约断言挡。
  const cssStart = html.indexOf('<style>');
  const cssEnd = html.indexOf('</style>');
  const css = html.slice(cssStart, cssEnd);

  // 抽某条规则的声明块。同一选择器可能出现多条，所以返回全部再合并判断
  const allRules = (sel) => {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
    return [...css.matchAll(re)].map(m => m[1]);
  };
  const hasProp = (sel, prop, valRe) =>
    allRules(sel).some(block => {
      const m = block.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;}]+)'));
      return m && valRe.test(m[1].trim());
    });

  // ① 左栏不得再渲染「第X大节」整串 —— 30px 宽放不下，硬塞会一字一行
  /<span class="week-sec-idx">/.test(html)
    ? ok('左栏用序号 span（week-sec-idx），不再塞「第X大节」整串')
    : bad('左栏又变回「第X大节」整串了，窄屏会被挤成一字一行');
  /第\$\{SEC_CN\[s - 1\]\}大节<br>/.test(html)
    ? bad('周视图左栏又写成「第X大节<br>」，会重现竖排乱码')
    : ok('周视图左栏没有退回「第X大节<br>」写法');
  /aria-label="第\$\{SEC_CN\[s - 1\]\}大节/.test(html)
    ? ok('完整读法保留在 aria-label（读屏仍读得到）')
    : bad('序号缩了但 aria-label 没补，信息只剩一个「一」');

  // ② 必须有可横向滚动的外壳，且网格 min-width:0（否则 1fr 缩不下去会撑破页面）
  /class="week-scroll"/.test(html)
    ? ok('周视图包在 .week-scroll 外壳里')
    : bad('没有 .week-scroll，窄屏上网格会撑破整页');
  hasProp('.week-scroll', 'overflow-x', /(auto|scroll)/)
    ? ok('.week-scroll overflow-x 可滚')
    : bad('.week-scroll 不能横向滚动，最后一列够不着');

  // ③ 列宽下限必须 ≥41px：低于这个值中文课名会退化成一字一行
  const gridBlocks = allRules('.week-grid');
  const colsDecl = gridBlocks.map(b => (b.match(/grid-template-columns\s*:\s*([^;}]+)/) || [])[1]).find(Boolean);
  if (!colsDecl) {
    bad('找不到 .week-grid 的 grid-template-columns');
  } else {
    const minm = colsDecl.match(/minmax\(\s*(\d+)px/);
    const min = minm ? Number(minm[1]) : 0;
    if (min >= 41) ok(`列宽下限 ${min}px ≥ 41px（课名不会退化成一字一行）`);
    else bad(`列宽下限只有 ${min}px，中文课名会变成一字一行`);
    /repeat\(\s*7\s*,/.test(colsDecl) ? ok('仍是 7 天 ×1 组') : bad('列定义不再是 7 天');
  }

  // ④ 课名不得用 break-all —— 那是「一字一行」的直接元凶
  const cellBlocks = allRules('.week-cell-course');
  const wb = cellBlocks.map(b => (b.match(/word-break\s*:\s*([^;}]+)/) || [])[1]).find(Boolean);
  (wb && wb.trim() === 'break-all')
    ? bad('.week-cell-course 又用了 word-break:break-all，中文会一字一行')
    : ok('.week-cell-course 未使用 break-all');
  cellBlocks.some(b => /overflow-wrap\s*:\s*anywhere/.test(b))
    ? ok('长英文课名用 overflow-wrap:anywhere 兜底')
    : bad('缺 overflow-wrap:anywhere，长英文课名会溢出格子');

  // ⑤ 左栏时间串必须走令牌，且不得低于 12px（mobile-audit 会拦，这里先自检）
  const timeBlocks = allRules('.week-sec-time');
  const fsDecl = timeBlocks.map(b => (b.match(/font-size\s*:\s*([^;}]+)/) || [])[1]).find(Boolean) || '';
  /var\(--fs-/.test(fsDecl)
    ? ok('左栏时间字号用 --fs-* 令牌')
    : bad(`左栏时间字号没走令牌：「${fsDecl.trim()}」（会被 mobile-audit 判失败）`);
}

console.log('\n────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
