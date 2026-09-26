// verify-firstload.js —— 验证「首次打开今日页就看到快过期卡片」
// 这是刚修掉的真 bug：renderAll() 原先没调 renderInvAlertCard()。
const { chromium } = require('playwright');
const path = require('path');

const HTML = 'file:///' + path.resolve('C:/Users/HXT/WorkBuddy/2026-08-22-15-35-35/nexus-core/index.html').replace(/\\/g, '/');
const CHROME = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 740 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();

  // 预置两条数据：一条今天到期，一条 2 天后到期
  await page.addInitScript(() => {
    const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0') + '-' + String(x.getDate()).padStart(2,'0'); };
    localStorage.setItem('nexus_inventory', JSON.stringify([
      { id: 'a', name: '牛奶', qty: '1', unit: '盒', loc: 'fridge', expireAt: d(0), createdAt: '' },
      { id: 'b', name: '面包', qty: '1', unit: '袋', loc: 'ambient', expireAt: d(2), createdAt: '' },
      { id: 'c', name: '大米', qty: '5', unit: '斤', loc: 'cabinet', expireAt: d(180), createdAt: '' },
    ]));
  });

  await page.goto(HTML, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const vis = await page.isVisible('#inv-alert-card');
  const txt = vis ? await page.$eval('#inv-alert-card', el => el.innerText.replace(/\s+/g, ' ')) : '';
  console.log('首次加载（今日页）卡片可见 =', vis);
  console.log('卡片内容 =', txt);

  let pass = 0, fail = 0;
  const chk = (c, l) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l); } };
  chk(vis, '首屏就显示快过期卡片（无需切换页面）');
  chk(/牛奶/.test(txt), '列出了「牛奶」');
  chk(/面包/.test(txt), '列出了「面包」');
  chk(!/大米/.test(txt), '180天的大米没被误报');
  chk(/2 样|快过期/.test(txt), '汇总文案正确');

  // 点卡片能跳转
  await page.click('#inv-alert-card .card');
  await page.waitForTimeout(500);
  const onInv = await page.$eval('#panel-inventory', el => el.classList.contains('active'));
  chk(onInv, '点卡片跳到物品页');

  console.log('\n通过 %d / 失败 %d', pass, fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
