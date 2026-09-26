/**
 * 饮食记录一句话录入 —— 手机端全流程验证。
 *
 * 要 Playwright，只在本地跑，不进 CI（跟 verify-wallet-mobile.js 同理）。
 *
 * ★ 种子数据必须同时写 nexus_initialized=true。
 *   踩过的坑（verify-wallet-mobile.js 那次）：只写 nexus_dailyLog 不写 initialized，
 *   initData() 会认为这是首次启动，把种子整个覆盖掉，测出来全是 0。
 */
const { chromium } = require('playwright');
const path = require('path');

const HTML = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const CHROME = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';

const SEED_LOG = {
  '2026-09-26': { meals: [], totalKcal: 0 },
  // 造几天历史，让「常吃」有东西可长
  '2026-09-25': {
    meals: [
      { type: 'lunch', name: '肉丝滑蛋饭', kcal: 620, ts: 1 },
      { type: 'dinner', name: '鸭腿饭', kcal: 700, ts: 2 }
    ], totalKcal: 1320
  },
  '2026-09-24': {
    meals: [
      { type: 'lunch', name: '肉丝滑蛋饭', kcal: 620, ts: 3 },
      { type: 'snack', name: '酸奶加梨', kcal: 230, ts: 4 }
    ], totalKcal: 850
  }
};

const TODAY = '2026-09-26';

let pass = 0, fail = 0;
const fails = [];
function ok(m) { pass++; }
function bad(m) { fail++; fails.push(m); }
function chk(c, m) { c ? ok(m) : bad(m); }

(async () => {
  const b = await chromium.launch({ executablePath: CHROME });
  const c = await b.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true
  });
  await c.addInitScript(function (seed) {
    localStorage.setItem('nexus_dailyLog', JSON.stringify(seed.log));
    localStorage.setItem('nexus_initialized', 'true');
    localStorage.setItem('nexus_server_url', '');
  }, { log: SEED_LOG });

  const p = await c.newPage();
  const errs = [];
  p.on('pageerror', function (e) { errs.push(e.message); });
  p.on('console', function (m) { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await p.goto(HTML, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2200);

  // ---------- 1. 结构：四件套没了、新输入在 ----------
  const struct = await p.evaluate(function () {
    return {
      hasName: !!document.getElementById('meal-name'),
      hasKcal: !!document.getElementById('meal-kcal'),
      hasInput: !!document.getElementById('meal-input'),
      hasPreview: !!document.getElementById('meal-preview'),
      hasSubmit: !!document.getElementById('meal-submit'),
      hasTypeRow: !!document.getElementById('meal-type-row'),
      hasSuggest: !!document.getElementById('meal-suggest'),
      hasList: !!document.getElementById('meal-list')
    };
  });
  chk(struct.hasName === false, '旧的名字输入框 meal-name 已删除');
  chk(struct.hasKcal === false, '旧的热量输入框 meal-kcal 已删除');
  chk(struct.hasInput === true, '新的一句话输入 meal-input 存在');
  chk(struct.hasPreview === true, '实时预览 meal-preview 存在');
  chk(struct.hasSubmit === true, '记下按钮存在');
  chk(struct.hasTypeRow === true, '餐次 chip 行保留（按时段猜了要能改）');
  chk(struct.hasList === true, '已记列表 meal-list 保留');

  // ---------- 2. 实时预览：打字就有反馈 ----------
  await p.click('.tab-item[data-panel="daily"]');
  await p.waitForTimeout(700);
  await p.fill('#meal-input', '肉丝滑蛋饭');
  await p.waitForTimeout(400);
  const prev = await p.$eval('#meal-preview', function (el) {
    return { shown: el.classList.contains('show'), text: el.innerText.replace(/\n/g, ' | ') };
  });
  chk(prev.shown === true, '预览在输入后显示');
  chk(prev.text.indexOf('620') >= 0, '预览里出现估出的热量 620（实际「' + prev.text + '」）');
  chk(prev.text.indexOf('盖饭') >= 0, '预览里说明了依据是「盖饭」（实际「' + prev.text + '」）');
  chk(prev.text.indexOf('肉丝滑蛋饭') >= 0, '预览里回显了名称（实际「' + prev.text + '」）');
  console.log('  预览文案 →', prev.text);

  // ---------- 3. 回车提交 ----------
  const before = await p.evaluate(function (d) {
    const log = JSON.parse(localStorage.getItem('nexus_dailyLog') || '{}');
    return (log[d] && log[d].meals || []).length;
  }, TODAY);
  await p.press('#meal-input', 'Enter');
  await p.waitForTimeout(500);
  const after = await p.evaluate(function (d) {
    const log = JSON.parse(localStorage.getItem('nexus_dailyLog') || '{}');
    const ms = (log[d] && log[d].meals) || [];
    return { n: ms.length, last: ms[ms.length - 1], total: log[d].totalKcal };
  }, TODAY);
  chk(after.n === before + 1, '回车记入了一条（' + before + ' → ' + after.n + '）');
  chk(after.last && after.last.name === '肉丝滑蛋饭', '存的名称正确（实际「' + (after.last && after.last.name) + '」）');
  chk(after.last && after.last.kcal === 620, '存的热量正确 620（实际 ' + (after.last && after.last.kcal) + '）');
  chk(after.total === 620, '合计 kcal 累加正确 620（实际 ' + after.total + '）');
  chk((await p.$eval('#meal-input', function (el) { return el.value; })) === '', '提交后输入框已清空');

  // ---------- 4. 热量合计显示在标题行 ----------
  const totalTxt = await p.$eval('#daily-kcal-total', function (el) { return el.textContent; });
  chk(totalTxt.indexOf('620') >= 0, '标题行显示「合计 620 kcal」（实际「' + totalTxt + '」）');

  // ---------- 5. 餐次按时段猜 + 可改 ----------
  await p.fill('#meal-input', '酸奶加梨');
  await p.waitForTimeout(400);
  const typeNow = await p.$eval('#meal-type-row', function (el) {
    const on = el.querySelector('.chip[aria-pressed="true"]');
    return on ? on.textContent : '(无)';
  });
  chk(['早餐', '午餐', '晚餐', '零食'].indexOf(typeNow) >= 0, '有一个餐次被选中（实际「' + typeNow + '」）');
  // 手动改成早餐，再提交
  await p.evaluate(function () {
    const btns = document.querySelectorAll('#meal-type-row .chip');
    for (const b of btns) { if (b.textContent === '早餐') { b.click(); return; } }
  });
  await p.waitForTimeout(300);
  const prevAfter = await p.$eval('#meal-preview', function (el) { return el.innerText; });
  chk(prevAfter.indexOf('早餐') >= 0, '改成早餐后预览跟着变（实际「' + prevAfter.replace(/\n/g, ' | ') + '」）');
  await p.click('#meal-submit');
  await p.waitForTimeout(500);
  const after2 = await p.evaluate(function (d) {
    const log = JSON.parse(localStorage.getItem('nexus_dailyLog') || '{}');
    const ms = (log[d] && log[d].meals) || [];
    return { last: ms[ms.length - 1], total: log[d].totalKcal };
  }, TODAY);
  chk(after2.last && after2.last.type === 'breakfast', '手动选的餐次生效（实际 ' + (after2.last && after2.last.type) + '）');
  chk(after2.last && after2.last.kcal === 230, '酸奶加梨 = 230（实际 ' + (after2.last && after2.last.kcal) + '）');
  chk(after2.total === 850, '合计 620+230 = 850（实际 ' + after2.total + '）');

  // ---------- 6. 已记列表渲染 + 走 escHtml ----------
  const listInfo = await p.evaluate(function () {
    const el = document.getElementById('meal-list');
    return {
      html: el.innerHTML,
      rows: el.querySelectorAll('div').length,
      text: el.innerText.replace(/\n/g, ' | ')
    };
  });
  chk(listInfo.rows === 2, '列表里两行（实际 ' + listInfo.rows + '）');
  chk(listInfo.text.indexOf('肉丝滑蛋饭') >= 0, '列表里有「肉丝滑蛋饭」');
  chk(listInfo.text.indexOf('620') >= 0, '列表里显示 620kcal');
  chk(listInfo.text.indexOf('早餐') >= 0, '列表里显示餐次「早餐」');

  // XSS：塞一条带标签的名称，必须被转义而不是被当 HTML
  await p.evaluate(function (d) {
    const log = JSON.parse(localStorage.getItem('nexus_dailyLog') || '{}');
    log[d].meals.push({ type: 'snack', name: '<img src=x onerror="window.__XSS__=1">', kcal: 10, ts: 99 });
    localStorage.setItem('nexus_dailyLog', JSON.stringify(log));
  }, TODAY);
  await p.evaluate(function () { renderMeals(); });
  await p.waitForTimeout(300);
  const xss = await p.evaluate(function () {
    return {
      got: window.__XSS__ === 1,
      imgInList: document.querySelectorAll('#meal-list img').length,
      text: document.getElementById('meal-list').innerText
    };
  });
  chk(xss.got === false, '带 onerror 的名称没有执行（XSS 被挡住）');
  chk(xss.imgInList === 0, '名称没有被当成 HTML 插入（列表里没有 img）');
  chk(xss.text.indexOf('<img') >= 0, '名称是以纯文本显示的');
  await p.evaluate(function (d) {
    const log = JSON.parse(localStorage.getItem('nexus_dailyLog') || '{}');
    log[d].meals.pop();
    localStorage.setItem('nexus_dailyLog', JSON.stringify(log));
  }, TODAY);

  // ---------- 7. 删除 ----------
  await p.evaluate(function () { renderMeals(); });
  await p.waitForTimeout(200);
  const delBefore = await p.evaluate(function (d) {
    const log = JSON.parse(localStorage.getItem('nexus_dailyLog') || '{}');
    return ((log[d] && log[d].meals) || []).length;
  }, TODAY);
  await p.evaluate(function () {
    document.querySelectorAll('#meal-list button').forEach(function (b) { if (b.textContent === '×') b.click(); });
  });
  await p.waitForTimeout(400);
  const delAfter = await p.evaluate(function (d) {
    const log = JSON.parse(localStorage.getItem('nexus_dailyLog') || '{}');
    return { n: ((log[d] && log[d].meals) || []).length, total: log[d].totalKcal, last: (log[d].meals || []).slice(-1)[0] };
  }, TODAY);
  chk(delAfter.n === delBefore - 1, '删除生效（' + delBefore + ' → ' + delAfter.n + '）');
  // 删掉的是列表第一行 = 最早记的那条「肉丝滑蛋饭」(620)，剩下「酸奶加梨」(230)。
  // ★ 这里别写死 620 —— 第一版就写错了：我以为删的是最后一条，
  //   实际列表是按记录顺序渲染的，第一个 × 对应第一条。断言要对着真实语义写。
  chk(delAfter.total === 230, '删除后合计重算为 230（实际 ' + delAfter.total + '）');
  chk(delAfter.last && delAfter.last.name === '酸奶加梨', '剩下的是「酸奶加梨」（实际 ' + (delAfter.last && delAfter.last.name) + '）');

  // ---------- 8. 「常吃」现在也带热量 ----------
  const sugInfo = await p.evaluate(function () {
    const el = document.getElementById('meal-suggest');
    const chips = Array.from(el.querySelectorAll('.chip')).map(function (b) { return b.textContent; });
    return { chips: chips };
  });
  chk(sugInfo.chips.indexOf('肉丝滑蛋饭') >= 0, '「常吃」里有出现两次的「肉丝滑蛋饭」（实际 ' + JSON.stringify(sugInfo.chips) + '）');
  // 点一下「常吃」，确认估了热量而不是 0
  const beforeSug = await p.evaluate(function (d) {
    const log = JSON.parse(localStorage.getItem('nexus_dailyLog') || '{}');
    return ((log[d] && log[d].meals) || []).length;
  }, TODAY);
  await p.evaluate(function () {
    const btns = document.querySelectorAll('#meal-suggest .chip');
    for (const b of btns) { if (b.textContent === '肉丝滑蛋饭') { b.click(); return; } }
  });
  await p.waitForTimeout(400);
  const sugAfter = await p.evaluate(function (d) {
    const log = JSON.parse(localStorage.getItem('nexus_dailyLog') || '{}');
    const ms = (log[d] && log[d].meals) || [];
    return { n: ms.length, last: ms[ms.length - 1] };
  }, TODAY);
  chk(sugAfter.n === beforeSug + 1, '点「常吃」记入一条');
  chk(sugAfter.last && sugAfter.last.kcal === 620, '「常吃」也估出了热量 620（实际 ' + (sugAfter.last && sugAfter.last.kcal) + '）—— 不能是 0');

  // ---------- 9. 无 JS 报错 ----------
  chk(errs.length === 0, '全流程无 JS 报错' + (errs.length ? '（实际：' + errs.slice(0, 3).join(' / ') + '）' : ''));

  // ---------- 10. 截图留档 ----------
  await p.evaluate(function (d) {
    const log = JSON.parse(localStorage.getItem('nexus_dailyLog') || '{}');
    log[d].meals = [
      { type: 'breakfast', name: 'corn and egg', kcal: 205, ts: 1 },
      { type: 'lunch', name: '肉丝滑蛋饭', kcal: 620, ts: 2 },
      { type: 'dinner', name: '烤鸭腿饭 西兰花 蒸蛋', kcal: 855, ts: 3 }
    ];
    log[d].totalKcal = 1680;
    localStorage.setItem('nexus_dailyLog', JSON.stringify(log));
  }, TODAY);
  await p.evaluate(function () { renderMeals(); });
  await p.fill('#meal-input', '酸奶加梨');
  await p.waitForTimeout(400);
  await p.evaluate(function () {
    const el = document.getElementById('sec-meals');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(500);
  const OUT = 'C:/Users/HXT/WorkBuddy AI/2026-09-26-00-16-26/shots';
  await p.screenshot({ path: OUT + '/20-今日页-饮食记录一句话.png' });

  await b.close();

  console.log('\n--- 结果 ---');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) {
    console.log('\n失败明细：');
    fails.forEach(function (f) { console.log('  ✗ ' + f); });
    process.exit(1);
  }
  console.log('全部通过');
})();
