#!/usr/bin/env node
/*
 * 直接从本机真实浏览器抓 ttwid，不依赖用户操作
 *
 * 原理：Playwright 启动真 Chromium 访问抖音首页，
 * 抖音的 JS 会自己生成并写入 ttwid（HttpOnly）。
 * Playwright 的 ctx.cookies() 能读到 HttpOnly cookie（它是 CDP 层）。
 *
 * 只取访客标识，不取登录凭证。
 * 输出 Netscape 格式，可直接给 yt-dlp 用。
 */
const path = require('path');
const fs = require('fs');
const NODE_WS = 'C:/Users/HXT/.workbuddy-ai/binaries/node/workspace/node_modules';
const { chromium } = require(path.join(NODE_WS, 'playwright'));
const EXE = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';

// 要的：访客标识（ttwid / odin_tt 是 HttpOnly，只有这里能拿到）
const WANT = ['ttwid', 'odin_tt', 'msToken', 's_v_web_id', 'tt_scid',
              'passport_csrf_token', 'UIFID', 'UIFID_TEMP', '__ac_nonce'];
// 绝不导出：登录凭证
const DANGER = ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt', 'sid_guard',
                'passport_auth', 'sid_ucp_v1', 'ssid_ucp_v1', 'login_time'];

const OUT = path.join(__dirname, 'douyin-cookie-netscape.txt');

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  console.log('访问抖音首页，等 JS 生成访客标识...');
  try {
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log('导航异常: ' + e.message.slice(0, 70) + '（继续看已生成的 cookie）');
  }
  // 给 JS 足够时间写 ttwid
  await page.waitForTimeout(6000);

  const all = await ctx.cookies();
  console.log('总共拿到 %d 项 cookie', all.length);

  const picked = {};
  const httpOnly = [];
  const leaked = [];
  all.forEach((c) => {
    if (WANT.includes(c.name)) {
      picked[c.name] = c.value;
      if (c.httpOnly) httpOnly.push(c.name);
    }
    if (DANGER.includes(c.name)) leaked.push(c.name);
  });

  console.log('\n提取到的访客标识:');
  Object.keys(picked).forEach((k) => {
    console.log('  %s  len=%d  %s', k.padEnd(20), picked[k].length,
      httpOnly.includes(k) ? '(HttpOnly)' : '');
  });

  console.log('\n自动排除的登录凭证: %s', leaked.length ? leaked.join(', ') : '（未检测到）');

  if (!picked.ttwid) {
    console.log('\n❌ 没拿到 ttwid —— 方案不可行');
    await browser.close();
    process.exit(1);
  }

  console.log('\n✅ ttwid 到手（len=%d）', picked.ttwid.length);

  // 写 Netscape 格式
  const exp = Math.floor(Date.now() / 1000) + 86400 * 30;
  const lines = [
    '# Netscape HTTP Cookie File',
    '# nexus-core 自动提取 —— 仅访客标识',
    '# ' + new Date().toISOString(),
  ];
  Object.keys(picked).forEach((k) => {
    lines.push(['.douyin.com', 'TRUE', '/', 'FALSE', exp, k, picked[k]].join('\t'));
  });
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  console.log('已写入 ' + OUT);

  // 安全检查：确认没漏出凭证
  const content = fs.readFileSync(OUT, 'utf8');
  const bad = DANGER.filter((d) => content.includes(d + '\t'));
  console.log('泄漏检查: ' + (bad.length ? '❌ ' + bad.join(',') : '✅ 无登录凭证'));

  await browser.close();
  process.exit(bad.length ? 2 : 0);
})().catch((e) => { console.error('崩了:', e.message); process.exit(1); });
