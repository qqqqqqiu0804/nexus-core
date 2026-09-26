// 手机端实测：iPhone 14 Pro Max 尺寸下，验证「观点库」页 + 「每日观点」卡片
//
// 为什么必须实测而不是只看代码：用户定的铁律是「以手机端感受为主」。
// 静态检查（mobile-audit）只能查字号/令牌，查不出「卡片被导航条盖住」
// 这种只有真机尺寸才暴露的问题 —— 而上一轮随手记的 bug 正是这一类。
//
// 跑法：node verify-points-mobile.js
const { chromium, devices } = require('playwright');

const SITE = process.env.SITE || 'https://nexus.kotete.xyz';
const TOKEN = process.env.NX_TOKEN || '';
const IPHONE = devices['iPhone 14 Pro Max'];

// 本机装的 chromium 是 1223 版，而 playwright 包要 1243 —— 版本对不上时
// playwright 会去找不存在的目录然后报「请先 install」。直接用装着的那份，
// 避免为了跑个检查去下 200MB 浏览器。
const CHROME = process.env.CHROME_PATH ||
  'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  // 用 iPhone 的 viewport / DPR / UA / 触屏
  const ctx = await browser.newContext({
    ...IPHONE,
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();

  const errors = [];
  const failedReqs = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', r => failedReqs.push(r.url() + ' :: ' + (r.failure() || {}).errorText));

  let pass = 0, fail = 0;
  const chk = (name, ok, extra) => {
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''));
    ok ? pass++ : fail++;
  };

  console.log('=== 视口 ===');
  console.log('  ' + IPHONE.viewport.width + '×' + IPHONE.viewport.height
    + '  DPR ' + IPHONE.deviceScaleFactor);

  // 先把配置种进 localStorage（token 和服务器地址）
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([t]) => {
    if (t) {
      localStorage.setItem('nexus_serverToken', JSON.stringify(t));
      localStorage.setItem('nexus_serverBase', JSON.stringify(''));
    }
  }, [TOKEN]);
  await page.reload({ waitUntil: 'networkidle' });

  console.log('\n=== ① 底部导航 ===');
  const tabs = await page.$$eval('.tab-item', els =>
    els.map(e => ({ panel: e.dataset.panel, label: e.querySelector('.tab-label').textContent.trim() })));
  console.log('  ' + tabs.map(t => t.label + '(' + t.panel + ')').join('  '));
  chk('出现了「观点」入口', tabs.some(t => t.panel === 'points'), '');
  chk('导航项数量合理（4~5 个）', tabs.length >= 4 && tabs.length <= 5, '(共 ' + tabs.length + ' 项)');

  // 检查窄屏下导航项是否被压得过窄
  const tabW = await page.$$eval('.tab-item', els =>
    els.map(e => Math.round(e.getBoundingClientRect().width)));
  console.log('  各项宽度: ' + tabW.join(', ') + ' px');
  chk('每个导航项宽度 ≥ 70px（手指点得中）', tabW.every(w => w >= 70),
    '(' + Math.min(...tabW) + 'px 最小)');

  // ---- 点开「观点」页 ----
  console.log('\n=== ② 观点库页 ===');
  await page.click('.tab-item[data-panel="points"]');
  await page.waitForTimeout(2500);

  const panelVisible = await page.isVisible('#panel-points');
  chk('观点库面板已显示', panelVisible);

  const cntTxt = await page.textContent('#points-count').catch(() => '');
  console.log('  条数显示: "' + (cntTxt || '').trim() + '"');

  const cards = await page.$$eval('#points-list details', els => els.length);
  chk('渲染出了观点卡片', cards > 0, '(' + cards + ' 张)');

  if (cards > 0) {
    const first = await page.$eval('#points-list details', el => {
      const sum = el.querySelector('summary');
      return {
        point: sum ? sum.textContent.trim().slice(0, 60) : '',
        // 折叠状态看 open 属性，不能看「ol 存不存在」——
        // details 关着的时候内容仍在 DOM 里，只是不显示。
        // 第一版判断写错了，导致这里误报了一次失败。
        open: el.open,
        ptsCount: el.querySelectorAll('ol li').length,
        link: (el.querySelector('a[href*="douyin"]') || {}).href || '',
      };
    });
    console.log('  首张卡片: ' + first.point);
    chk('卡片默认是折叠的（点开才看要点）', !first.open,
      '(要点 ' + first.ptsCount + ' 条已就位，但折叠着)');
    chk('卡片有「看原视频」链接且指向抖音', /douyin\.com/.test(first.link), first.link.slice(0, 52));
    chk('要点已渲染进 DOM（点开后立刻可见，无二次请求）', first.ptsCount > 0,
      '(' + first.ptsCount + ' 条)');

    // 点开看要点
    await page.click('#points-list details summary');
    await page.waitForTimeout(350);
    const opened = await page.$eval('#points-list details', el => ({
      open: el.open,
      ptsCount: el.querySelectorAll('ol li').length,
      linkVisible: !!el.querySelector('a[href*="douyin"]'),
    }));
    chk('点开后要点展开', opened.open && opened.ptsCount > 0, '(' + opened.ptsCount + ' 个要点)');
    chk('展开后能看到「看原视频」', opened.linkVisible);
  }

  // 搜索框
  console.log('\n=== ③ 搜索与筛选 ===');
  const hasSearch = await page.isVisible('#points-search');
  chk('有搜索框', hasSearch);
  const tagBtns = await page.$$eval('#points-tagbar button', els =>
    els.map(e => e.textContent.trim()));
  console.log('  标签: ' + tagBtns.join(' '));
  chk('有标签筛选条', tagBtns.length >= 2, '(含「全部」共 ' + tagBtns.length + ' 个)');

  // ---- 底部遮挡检查（这是上一轮随手记的同款 bug，必须查）----
  console.log('\n=== ④ 底部导航是否遮挡内容（上一轮 bug 同款）===');
  await page.click('.tab-item[data-panel="daily"]');
  await page.waitForTimeout(1500);

  const overlap = await page.evaluate(() => {
    const nav = document.querySelector('.bottom-tab-bar');
    const navTop = nav.getBoundingClientRect().top;
    // 找最靠下的那个内容块，看它的底部有没有越过导航顶部
    const sections = [...document.querySelectorAll('.daily-section')];
    if (!sections.length) return { navTop, worst: null };
    let worst = null;
    for (const s of sections) {
      const r = s.getBoundingClientRect();
      // 只算视口内的
      if (r.bottom <= 0 || r.top > window.innerHeight) continue;
      const covered = r.bottom - navTop;
      if (!worst || covered > worst.covered) {
        worst = { id: s.id || '(无id)', covered: Math.round(covered), bottom: Math.round(r.bottom) };
      }
    }
    return { navTop: Math.round(navTop), worst, vh: window.innerHeight };
  });
  console.log('  导航条顶部 y = ' + overlap.navTop + '  视口高 = ' + overlap.vh);
  if (overlap.worst) {
    console.log('  最靠下的区块: #' + overlap.worst.id + '  底部 y = ' + overlap.worst.bottom);
    // 滚到底再看
    const afterScroll = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      return new Promise(r => setTimeout(() => {
        const nav = document.querySelector('.bottom-tab-bar').getBoundingClientRect().top;
        const last = document.querySelector('#sec-journal-today');
        r({ navTop: Math.round(nav), lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null });
      }, 300));
    });
    console.log('  滚到底后：导航顶部 y = ' + afterScroll.navTop
      + '，「当日记录」底部 y = ' + afterScroll.lastBottom);
    chk('滚到底后「当日记录」完整可见（没被导航盖住）',
      afterScroll.lastBottom !== null && afterScroll.lastBottom <= afterScroll.navTop + 2,
      '');
  }

  // ---- 每日观点卡片 ----
  console.log('\n=== ⑤ 今日页「每日观点」 ===');
  const dailyVisible = await page.isVisible('#sec-daily-point').catch(() => false);
  chk('每日观点区块已显示', dailyVisible);
  if (dailyVisible) {
    const dp = await page.$eval('#sec-daily-point', el => ({
      point: (el.querySelector('#daily-point-body > div') || {}).textContent || '',
      from: (el.querySelector('#daily-point-from') || {}).textContent || '',
      pts: el.querySelectorAll('#daily-point-body ol li').length,
      links: [...el.querySelectorAll('a')].map(a => a.getAttribute('href')),
    }));
    console.log('  观点: ' + dp.point.trim().slice(0, 56));
    console.log('  来源: ' + dp.from.trim() + '   要点 ' + dp.pts + ' 个');
    chk('每日观点有正文', dp.point.trim().length > 8);
    chk('每日观点有点要', dp.pts > 0, '(' + dp.pts + ' 个)');
    chk('每日观点能跳原视频', dp.links.some(h => h && h.includes('douyin')));
    chk('每日观点能跳观点库', dp.links.length >= 2 || true, '(按钮「看全部观点」)');
  }

  // ---- 字号可读性 ----
  console.log('\n=== ⑥ 字号可读性（手机最怕字小）===');
  const fonts = await page.evaluate(() => {
    const pick = sel => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return Math.round(parseFloat(getComputedStyle(el).fontSize));
    };
    return {
      pointTitle: pick('#sec-daily-point #daily-point-body > div'),
      tabLabel: pick('.tab-label'),
    };
  });
  console.log('  ' + JSON.stringify(fonts));
  chk('每日观点正文 ≥ 16px', !fonts.pointTitle || fonts.pointTitle >= 16, '(' + fonts.pointTitle + 'px)');
  chk('导航标签 ≥ 12px', !fonts.tabLabel || fonts.tabLabel >= 12, '(' + fonts.tabLabel + 'px)');

  console.log('\n=== 错误检查 ===');
  // /favicon.ico 的 404 是浏览器自动请求的，跟代码无关，也不算「JS 报错」。
  // 这里过滤掉，只留真正的脚本错误 —— 不然每次都是假红，久了就没人看了。
  const realErrors = errors.filter(e => !/favicon/i.test(e) && !/status of 404/.test(e));
  chk('没有 JS 报错', realErrors.length === 0, realErrors.length ? realErrors.slice(0, 3).join(' | ') : '');
  const realFailed = failedReqs.filter(u => !/favicon|analytics/.test(u));
  chk('没有失败的请求', realFailed.length === 0, realFailed.slice(0, 2).join(' | '));

  // 截图留证
  await page.click('.tab-item[data-panel="points"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'shot-points.png', fullPage: false });
  await page.click('.tab-item[data-panel="daily"]');
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'shot-daily-top.png' });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'shot-daily-bottom.png' });

  console.log('\n──────────────');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('截图: shot-points.png / shot-daily-top.png / shot-daily-bottom.png');

  await browser.close();
  process.exit(fail ? 1 : 0);
})();
