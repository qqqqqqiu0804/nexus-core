// 紧凑模式验证：确认压缩了留白，但没把功能压坏。
const { chromium, devices } = require('playwright');
const CHROME = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const TOKEN = process.env.NX_TOKEN;

(async () => {
  const b = await chromium.launch({ executablePath: CHROME });
  const c = await b.newContext({ ...devices['iPhone 14 Pro Max'], ignoreHTTPSErrors: true });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });

  let pass = 0, fail = 0;
  const chk = (n, ok, extra) => {
    console.log((ok ? '  ✓ ' : '  ✗ ') + n + (extra ? '  ' + extra : ''));
    ok ? pass++ : fail++;
  };

  await p.goto('https://nexus.kotete.xyz', { waitUntil: 'domcontentloaded' });
  await p.evaluate(t => {
    localStorage.setItem('nexus_serverToken', JSON.stringify(t));
    localStorage.setItem('nexus_serverBase', JSON.stringify(''));
    localStorage.setItem('nexus_font_px', '16');
    localStorage.removeItem('nexus_sectionOpenByDay');
  }, TOKEN);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);

  console.log('=== ① 折叠块高度（原来 75~97px）===');
  const secs = await p.$$eval('#panel-daily .daily-section.collapsible.collapsed', els =>
    els.map(e => ({
      id: e.id,
      title: (e.querySelector('.section-title') || {}).textContent?.trim() || '',
      h: Math.round(e.getBoundingClientRect().height),
      hasLead: !!e.querySelector('.sec-always-show'),
    })));
  secs.forEach(s => console.log('  ' + s.title.padEnd(10) + s.h + 'px' +
    (s.hasLead ? '   (含常显正文，本就该高)' : '')));
  // ★ 每日观点折叠时还要显示那句话，注定比「光标题」高 —— 排除它单独判
  const plain = secs.filter(s => !s.hasLead);
  const maxH = Math.max(...plain.map(s => s.h));
  chk('纯标题折叠块高度都 ≤70px（原来 75~97）', maxH <= 70, '最大 ' + maxH + 'px');
  const leadSec = secs.find(s => s.hasLead);
  if (leadSec) {
    chk('每日观点（含正文）≤130px 且确实带了正文', leadSec.h <= 130 && leadSec.h > 60,
      leadSec.h + 'px');
  }
  const sum = secs.reduce((a, s) => a + s.h, 0);
  console.log('  合计 ' + sum + 'px（原来 750px）');
  chk('折叠块总高度明显下降（<500px）', sum < 500, sum + 'px');

  console.log('\n=== ② 触摸热区没被压坏 ===');
  const touch = await p.$$eval('#panel-daily .daily-section.collapsible.collapsed > .section-header',
    els => els.map(e => {
      const r = e.getBoundingClientRect();
      return { t: (e.querySelector('.section-title') || {}).textContent?.trim() || '',
        h: Math.round(r.height), w: Math.round(r.width) };
    }));
  touch.forEach(t => console.log('  ' + t.t.padEnd(10) + t.w + 'x' + t.h + 'px'));
  chk('每个可点标题高度 ≥26px（手指点得中）', touch.every(t => t.h >= 26),
    '最小 ' + Math.min(...touch.map(t => t.h)) + 'px');

  console.log('\n=== ③ 折叠/展开仍然正常 ===');
  const before = await p.$eval('#sec-chess', e => e.classList.contains('collapsed'));
  await p.click('#sec-chess > .section-header');
  await p.waitForTimeout(400);
  const after = await p.$eval('#sec-chess', e => e.classList.contains('collapsed'));
  chk('点标题能展开', before && !after);
  const expandedH = await p.$eval('#sec-chess', e => Math.round(e.getBoundingClientRect().height));
  console.log('  展开后高度 ' + expandedH + 'px');
  chk('展开后内容区高度正常（>100px）', expandedH > 100, expandedH + 'px');
  // 展开状态下 header 的分隔线应该回来了
  const hasBorder = await p.$eval('#sec-chess > .section-header',
    e => getComputedStyle(e).borderBottomStyle !== 'none');
  chk('展开后标题分隔线恢复（说明只压折叠态）', hasBorder);
  await p.click('#sec-chess > .section-header');
  await p.waitForTimeout(400);

  console.log('\n=== ④ 每日观点：折叠时仍显示那句话 ===');
  const lead = await p.evaluate(() => {
    const el = document.getElementById('daily-point-lead');
    if (!el) return null;
    const sec = document.getElementById('sec-daily-point');
    return {
      txt: (el.textContent || '').trim().slice(0, 40),
      visible: el.getBoundingClientRect().height > 0,
      collapsed: sec ? sec.classList.contains('collapsed') : null,
    };
  });
  console.log('  内容: "' + (lead ? lead.txt : '(无)') + '"');
  chk('每日观点折叠时那句话可见', lead && lead.visible && lead.collapsed);

  console.log('\n=== ⑤ 首屏信息量 ===');
  const first = await p.evaluate(() => {
    const out = [];
    document.querySelectorAll('#panel-daily .daily-section').forEach(s => {
      const r = s.getBoundingClientRect();
      if (r.top < 700) out.push({
        title: (s.querySelector('.section-title') || {}).textContent?.trim() || '',
        top: Math.round(r.top),
      });
    });
    const hd = document.querySelector('.header');
    return { out, headerH: hd ? Math.round(hd.getBoundingClientRect().height) : 0 };
  });
  console.log('  顶部 header 现在 ' + first.headerH + 'px（原来 114px）');
  first.out.forEach(o => console.log('    ' + o.title + ' @y=' + o.top));
  chk('header 压到 ≤90px', first.headerH <= 90, first.headerH + 'px');
  chk('首屏能看到 ≥5 个区块', first.out.length >= 5, first.out.length + ' 个');

  console.log('\n=== ⑥ 正文没被压（只压折叠态）===');
  await p.click('#sec-meals > .section-header');   // 展开饮食记录
  await p.waitForTimeout(500);
  const inner = await p.evaluate(() => {
    const s = document.getElementById('sec-meals');
    const cs = getComputedStyle(s);
    return { pad: cs.padding, mb: cs.marginBottom };
  });
  console.log('  展开的「饮食记录」: padding=' + inner.pad + ' margin-bottom=' + inner.mb);
  chk('展开状态 padding 恢复 16px（正文有呼吸感）', inner.pad.startsWith('16px'), inner.pad);

  chk('无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  await p.evaluate(() => {
    localStorage.setItem('nexus_font_px', '13');
    localStorage.removeItem('nexus_sectionOpenByDay');
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2200);
  await p.screenshot({ path: 'shot-compact.png' });

  console.log('\n──────────────');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
