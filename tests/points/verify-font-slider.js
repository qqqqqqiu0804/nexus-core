// 字号滑条：手机端实测。
// 重点验证两件事：
//   1) 滑条能拖、数值实时更新、设置能持久化
//   2) ★ 滑到最小 13px 时，--fs-2xs / --fs-xs 仍然 ≥12px（这是选「只缩正文」的目的）
const { chromium, devices } = require('playwright');
const SITE = 'https://nexus.kotete.xyz';
const TOKEN = process.env.NX_TOKEN || '';
const CHROME = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ ...devices['iPhone 14 Pro Max'], ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text());
  });

  let pass = 0, fail = 0;
  const chk = (n, ok, extra) => {
    console.log((ok ? '  ✓ ' : '  ✗ ') + n + (extra ? '  ' + extra : ''));
    ok ? pass++ : fail++;
  };

  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(t => {
    localStorage.setItem('nexus_serverToken', JSON.stringify(t));
    localStorage.setItem('nexus_serverBase', JSON.stringify(''));
    localStorage.removeItem('nexus_font_px');
    localStorage.removeItem('nexus_font_scale');
  }, TOKEN);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);

  // ---- ① 面板默认隐藏，点 A 才出现 ----
  console.log('\n=== ① 面板开关 ===');
  const hidden0 = await page.$eval('#font-panel', e => e.hasAttribute('hidden'));
  chk('面板默认是关的（不占地方）', hidden0);
  await page.click('#font-toggle');
  await page.waitForTimeout(400);
  const hidden1 = await page.$eval('#font-panel', e => e.hasAttribute('hidden'));
  chk('点 A 后面板打开', !hidden1);
  const rangeExists = await page.$('#font-range');
  chk('面板里有滑条（不是按钮了）', !!rangeExists);
  const attr = await page.$eval('#font-range', e => ({
    type: e.type, min: e.min, max: e.max, step: e.step, value: e.value,
  }));
  console.log('  滑条属性: type=' + attr.type + ' min=' + attr.min + ' max=' + attr.max +
    ' step=' + attr.step + ' value=' + attr.value);
  chk('范围是 13–22px（用户选的）', attr.min === '13' && attr.max === '22');
  chk('步进 0.5px（连续可调）', attr.step === '0.5');

  // ---- ② 拖动真的改变字号 ----
  console.log('\n=== ② 拖动改字号 ===');
  const readPx = () => page.evaluate(() => ({
    r: getComputedStyle(document.documentElement).getPropertyValue('--fs-r').trim(),
    sm: getComputedStyle(document.documentElement).getPropertyValue('--fs-sm').trim(),
    label: (document.getElementById('font-px-label') || {}).textContent,
    bodyPx: (() => {
      const el = document.querySelector('.daily-section .section-title')
        || document.querySelector('.section-title');
      return el ? parseFloat(getComputedStyle(el).fontSize) : null;
    })(),
  }));

  const at16 = await readPx();
  console.log('  默认: --fs-r=' + at16.r + '  --fs-sm=' + at16.sm +
    '  标签=' + at16.label + '  标题实测=' + at16.bodyPx + 'px');
  chk('默认是 16px', at16.label === '16px');

  // 拖到最小
  await page.$eval('#font-range', el => {
    el.value = '13';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const at13 = await readPx();
  console.log('  最小: --fs-r=' + at13.r + '  --fs-sm=' + at13.sm +
    '  标签=' + at13.label + '  标题实测=' + at13.bodyPx + 'px');
  chk('拖到 13px 标签跟着变', at13.label === '13px');
  chk('正文字号真的变小了', at13.bodyPx < at16.bodyPx,
    '(' + at16.bodyPx + ' → ' + at13.bodyPx + ')');

  // 拖到最大
  await page.$eval('#font-range', el => {
    el.value = '22';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const at22 = await readPx();
  console.log('  最大: --fs-r=' + at22.r + '  --fs-sm=' + at22.sm +
    '  标签=' + at22.label + '  标题实测=' + at22.bodyPx + 'px');
  chk('拖到 22px 标签跟着变', at22.label === '22px');
  chk('最大值比默认大', at22.bodyPx > at16.bodyPx,
    '(' + at16.bodyPx + ' → ' + at22.bodyPx + ')');

  // ---- ③ ★ 小字保底 12px（这是本次设计的核心）----
  console.log('\n=== ③ 小字保底 12px（滑到最小也不能破）===');
  await page.$eval('#font-range', el => {
    el.value = '13';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const smalls = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const sub = (expr) => {
      // 用临时元素解析 calc() 后的最终 px
      const d = document.createElement('div');
      d.style.fontSize = expr;
      document.body.appendChild(d);
      const v = parseFloat(getComputedStyle(d).fontSize);
      d.remove();
      return v;
    };
    return {
      fs2xs: sub('var(--fs-2xs)'),
      fsXs: sub('var(--fs-xs)'),
      // 实际页面里最小的渲染字号
      realMin: Math.min(...[...document.querySelectorAll('*')]
        .filter(e => !e.children.length && e.textContent.trim())
        .map(e => parseFloat(getComputedStyle(e).fontSize))),
    };
  });
  console.log('  滑到 13px 时: --fs-2xs=' + smalls.fs2xs + 'px  --fs-xs=' + smalls.fsXs +
    'px  全页最小实测=' + smalls.realMin + 'px');
  chk('★ 13px 档下 --fs-2xs 仍 ≥12px', smalls.fs2xs >= 12, '(' + smalls.fs2xs + 'px)');
  chk('★ 全页最小字号 ≥12px（没有蚂蚁字）', smalls.realMin >= 12, '(' + smalls.realMin + 'px)');

  // ---- ④ 持久化 + 刷新后保持 ----
  console.log('\n=== ④ 设置能记住 ===');
  await page.$eval('#font-range', el => {
    el.value = '19';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const afterReload = await readPx();
  console.log('  刷新后: 标签=' + afterReload.label + '  --fs-sm=' + afterReload.sm);
  chk('刷新后字号保持 19px', afterReload.label === '19px');
  const rangeVal = await page.$eval('#font-range', e => e.value);
  chk('滑条位置也恢复（不是回默认）', rangeVal === '19');

  // ---- ⑤ 恢复默认 ----
  console.log('\n=== ⑤ 恢复默认按钮 ===');
  await page.click('#font-toggle');
  await page.waitForTimeout(300);
  await page.click('.font-panel-reset');
  await page.waitForTimeout(400);
  const afterReset = await readPx();
  chk('一键回到 16px', afterReset.label === '16px', '(' + afterReset.label + ')');

  // ---- ⑥ 点外面能关 ----
  // 注意：必须用真实鼠标点击（page.mouse.click），不能用 document.body.click()。
  // 后者派发的是 click 事件，而关闭逻辑监听的是 mousedown —— 用合成事件会假失败。
  // 也要注意：刷新后面板是关着的（hidden 是初始态），所以每个用例都要先确保打开。
  console.log('\n=== ⑥ 点空白处关闭 ===');
  const ensureOpen = async () => {
    await page.evaluate(() => {
      const pn = document.getElementById('font-panel');
      if (pn && pn.hasAttribute('hidden')) document.getElementById('font-toggle').click();
    });
    await page.waitForTimeout(350);
    return page.$eval('#font-panel', e => !e.hasAttribute('hidden'));
  };
  const isOpen = () => page.$eval('#font-panel', e => !e.hasAttribute('hidden'));

  const opened = await ensureOpen();
  chk('面板已打开（前置条件）', opened);
  await page.mouse.click(103, 400);            // 页面中部空白，远离面板
  await page.waitForTimeout(350);
  chk('点空白处面板关闭', !(await isOpen()));

  // 点面板内部不该关（否则拖滑条会误关）
  await ensureOpen();
  const box = await page.$eval('#font-panel', e => {
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(350);
  chk('点面板内部不会误关（拖滑条不会被关掉）', await isOpen());

  // ---- ⑦ 滑条的触摸尺寸 ----
  console.log('\n=== ⑦ 手机好不好拖 ===');
  await ensureOpen();                    // 上一步点过面板内部，这里是开着的；确保一下
  const dims = await page.evaluate(() => {
    const r = document.querySelector('#font-range').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log('  滑条可拖区域: ' + dims.w + 'x' + dims.h + 'px');
  chk('触摸高度 ≥28px（手指点得中）', dims.h >= 28, '(' + dims.h + 'px)');
  chk('宽度够拖（≥150px）', dims.w >= 150, '(' + dims.w + 'px)');

  chk('无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  // 截图
  await page.evaluate(() => {
    const r = document.getElementById('font-range');
    if (r) { r.value = '16'; r.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'shot-font-slider.png' });

  console.log('\n──────────────');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
