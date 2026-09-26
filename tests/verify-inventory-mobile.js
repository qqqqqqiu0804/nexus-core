// verify-inventory-mobile.js —— 物品管理系统 手机端验收
// iPhone 14 Pro Max: 430x932 CSS px, DPR 3
const { chromium } = require('playwright');
const path = require('path');

const HTML = 'file:///' + path.resolve('C:/Users/HXT/WorkBuddy/2026-08-22-15-35-35/nexus-core/index.html').replace(/\\/g, '/');
const CHROME = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';

let pass = 0, fail = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; fails.push(label + (extra ? '  → ' + extra : '')); console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 740 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();

  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto(HTML, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);

  console.log('\n【1】底部导航');
  const tabs = await page.$$eval('.tab-item .tab-label', els => els.map(e => e.textContent.trim()));
  console.log('    tabs =', JSON.stringify(tabs));
  ok(tabs.length === 5, '仍是 5 格', '实际 ' + tabs.length);
  ok(tabs.includes('物品'), '有「物品」');
  ok(!tabs.includes('观点'), '没有「观点」tab');
  const invTab = await page.$('.tab-item[data-panel="inventory"]');
  ok(!!invTab, 'data-panel=inventory 存在');

  console.log('\n【2】切到物品面板');
  await page.click('.tab-item[data-panel="inventory"]');
  await page.waitForTimeout(400);
  const panelVisible = await page.$eval('#panel-inventory', el => el.classList.contains('active'));
  ok(panelVisible, '物品面板已激活');
  ok(await page.isVisible('#inv-stats'), '三计数可见');
  ok(await page.isVisible('#inv-input'), '输入框可见');

  console.log('\n【3】三计数初始状态');
  const statsText = await page.$eval('#inv-stats', el => el.innerText.replace(/\s+/g, ' '));
  console.log('    stats =', statsText);
  ok(/已过期/.test(statsText), '有「已过期」');
  ok(/3天内/.test(statsText), '有「3天内」');
  ok(/本周内/.test(statsText), '有「本周内」');

  console.log('\n【4】一句话录入（真实交互）');
  await page.fill('#inv-input', '鸡蛋 10个 冷藏');
  await page.waitForTimeout(300);
  const prev = await page.$eval('#inv-preview', el => el.style.display !== 'none' ? el.innerText.replace(/\s+/g,' ') : '');
  console.log('    预览 =', prev);
  ok(prev.length > 0, '实时预览出现');
  ok(/鸡蛋/.test(prev), '预览识别出「鸡蛋」');
  ok(/10个/.test(prev), '预览识别出数量 10个');
  ok(/冷藏/.test(prev), '预览识别出位置 冷藏');
  ok(/35/.test(prev) || /到期/.test(prev), '预览显示到期信息', prev);

  await page.click('text=记下来');
  await page.waitForTimeout(500);
  const listText = await page.$eval('#inv-list', el => el.innerText.replace(/\s+/g, ' '));
  console.log('    清单 =', listText.slice(0, 160));
  ok(/鸡蛋/.test(listText), '鸡蛋已进清单');
  const inputCleared = await page.$eval('#inv-input', el => el.value);
  ok(inputCleared === '', '保存后输入框已清空');

  console.log('\n【5】再录两条（测排序与分档）');
  await page.fill('#inv-input', '面包 常温 1天');
  await page.waitForTimeout(250);
  await page.click('text=记下来');
  await page.waitForTimeout(400);
  await page.fill('#inv-input', '两提纸巾 储物柜');
  await page.waitForTimeout(250);
  await page.click('text=记下来');
  await page.waitForTimeout(500);

  const names = await page.$$eval('#inv-list .inv-item', els =>
    els.map(e => e.querySelector('b') ? e.querySelector('b').textContent.trim() : ''));
  console.log('    清单顺序 =', JSON.stringify(names));
  ok(names.length === 3, '清单 3 条', '实际 ' + names.length);
  ok(names[0] === '面包', '最快过期的排最上（面包）', names[0]);
  ok(names.includes('纸巾'), '纸巾在列');

  const statsText2 = await page.$eval('#inv-stats', el => el.innerText.replace(/\s+/g, ' '));
  console.log('    stats2 =', statsText2);
  const soonNum = (statsText2.match(/(\d+)\s*3天内/) || [])[1];
  ok(Number(soonNum) >= 1, '「3天内」计数 ≥1', String(soonNum));

  console.log('\n【6】位置筛选');
  const chips = await page.$$eval('#inv-locbar .inv-locchip', els => els.map(e => e.textContent.trim()));
  console.log('    chips =', JSON.stringify(chips));
  ok(chips.length >= 2, '有筛选 chip');
  await page.click('#inv-locbar .inv-locchip:nth-child(2)');
  await page.waitForTimeout(350);
  const filtered = await page.$$eval('#inv-list .inv-item', els => els.length);
  console.log('    筛选后条数 =', filtered);
  ok(filtered > 0 && filtered < 3, '筛选生效', String(filtered));
  await page.click('#inv-locbar .inv-locchip:nth-child(1)');
  await page.waitForTimeout(350);
  const back = await page.$$eval('#inv-list .inv-item', els => els.length);
  ok(back === 3, '点「全部」恢复 3 条', String(back));

  console.log('\n【7】吃掉一条');
  await page.click('#inv-list .inv-item:nth-child(1) button');
  await page.waitForTimeout(500);
  const afterEat = await page.$$eval('#inv-list .inv-item', els => els.length);
  ok(afterEat === 2, '吃完后剩 2 条', String(afterEat));

  console.log('\n【8】今日页快过期卡片');
  // 【踩过的坑】第一版这里直接切到今日页就断言卡片可见 —— 但此时清单里剩的是
  // 「鸡蛋 35天」和「纸巾 1095天」，本来就没有 3 天内到期的，卡片不显示才是对的。
  // 所以必须先构造一个真的快到期的，再验证卡片出现。
  await page.click('.tab-item[data-panel="inventory"]');
  await page.waitForTimeout(300);
  await page.fill('#inv-input', '酸奶 冷藏 1天');
  await page.waitForTimeout(250);
  await page.click('text=记下来');
  await page.waitForTimeout(400);
  await page.click('.tab-item[data-panel="daily"]');
  await page.waitForTimeout(700);
  const alertVisible = await page.isVisible('#inv-alert-card');
  const alertText = alertVisible ? await page.$eval('#inv-alert-card', el => el.innerText.replace(/\s+/g,' ')) : '';
  console.log('    卡片 =', alertText.slice(0, 120));
  ok(alertVisible, '有快过期时卡片显示');
  ok(/过期|快过期/.test(alertText), '卡片文案正确');
  ok(/酸奶/.test(alertText), '卡片点出了具体是哪个东西');

  console.log('\n【8b】没有快过期时卡片应隐藏');
  // 把酸奶吃掉，再切回来 —— 卡片应消失
  await page.click('.tab-item[data-panel="inventory"]');
  await page.waitForTimeout(300);
  const eatIdx = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#inv-list .inv-item')];
    const i = items.findIndex(e => /酸奶/.test(e.innerText));
    if (i >= 0) items[i].querySelector('button').click();
    return i;
  });
  await page.waitForTimeout(400);
  await page.click('.tab-item[data-panel="daily"]');
  await page.waitForTimeout(600);
  const alertGone = await page.$eval('#inv-alert-card', el => el.style.display === 'none');
  ok(eatIdx >= 0, '找到并吃掉了酸奶', 'idx=' + eatIdx);
  ok(alertGone, '没有快过期时卡片自动隐藏');

  console.log('\n【9】观点库浮层');
  // 每日观点是异步拉的，没连服务器时可能没有按钮；直接调函数验证
  await page.evaluate(() => openPoints());
  await page.waitForTimeout(400);
  const ovOpen = await page.$eval('#points-overlay', el => el.style.display !== 'none');
  ok(ovOpen, 'openPoints() 能打开浮层');
  const ovBox = await page.$eval('#points-overlay', el => { const r = el.getBoundingClientRect(); return [r.width, r.height]; });
  ok(ovBox[0] === 430 && ovBox[1] >= 700, '浮层全屏', JSON.stringify(ovBox));
  await page.evaluate(() => closePoints());
  await page.waitForTimeout(300);
  const ovClosed = await page.$eval('#points-overlay', el => el.style.display === 'none');
  ok(ovClosed, 'closePoints() 能关闭');

  console.log('\n【10】随手记 placeholder');
  const ph = await page.$eval('#daily-journal', el => el.getAttribute('placeholder'));
  console.log('    placeholder =', ph);
  ok(!/Ctrl|⌘/.test(ph), '已无键盘快捷键提示');
  const hasKd = await page.$eval('#daily-journal', el => el.hasAttribute('onkeydown'));
  ok(!hasKd, 'onkeydown 已移除');

  console.log('\n【11】手机端横向溢出');
  await page.click('.tab-item[data-panel="inventory"]');
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => {
    const de = document.documentElement;
    return { scrollW: de.scrollWidth, clientW: de.clientWidth };
  });
  console.log('    scrollWidth=%d clientWidth=%d', overflow.scrollW, overflow.clientW);
  ok(overflow.scrollW <= overflow.clientW + 1, '无横向溢出',
     overflow.scrollW + ' vs ' + overflow.clientW);

  console.log('\n【12】触摸热区');
  const smalls = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('#panel-inventory button, #panel-inventory .inv-locchip, #inv-input').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.height < 26) {
        bad.push((el.textContent || el.id || '?').trim().slice(0, 14) + ' h=' + Math.round(r.height));
      }
    });
    return bad;
  });
  console.log('    过小的热区 =', JSON.stringify(smalls));
  ok(smalls.length === 0, '物品面板控件热区 ≥26px', smalls.join(', '));

  console.log('\n【13】JS 错误');
  const realErrs = errs.filter(e => !/favicon|net::ERR|Failed to fetch|ERR_CONNECTION|401|404/i.test(e));
  console.log('    errors =', JSON.stringify(realErrs.slice(0, 6)));
  ok(realErrs.length === 0, '无 JS 报错', realErrs.slice(0, 3).join(' | '));

  console.log('\n【14】数据持久化（KV 键）');
  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem('nexus_kv_inventory') || localStorage.getItem('inventory');
    if (raw) return raw;
    // 兜底：翻所有 key 找
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/inventory/.test(k)) return localStorage.getItem(k);
    }
    return null;
  });
  console.log('    存储 =', String(stored).slice(0, 160));
  ok(stored && /面包|纸巾/.test(stored), '已写入本地存储');

  console.log('\n============================');
  console.log('通过 %d / 失败 %d', pass, fail);
  if (fails.length) {
    console.log('\n失败明细:');
    fails.forEach(f => console.log('  ✗ ' + f));
  }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e); process.exit(2); });
