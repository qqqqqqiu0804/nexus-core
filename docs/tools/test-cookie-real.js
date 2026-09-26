#!/usr/bin/env node
/*
 * douyin-cookie.user.js 的真浏览器测试
 *
 * 测什么：
 *   1. 面板能出来（上次的教训：逻辑对但面板不出现 = 白干）
 *   2. 只提取 WANT 里的项
 *   3. **危险项绝不出现**（这是安全底线，泄露了就是账号风险）
 *   4. Netscape 格式能被 yt-dlp 解析
 *   5. 复制按钮真的能拿到内容
 *
 * 用 domain hijack 技术：拦截 douyin.com 请求，返回假页面。
 * 比改 hosts / 造证书干净。
 */

const path = require('path');
const NODE_WS = 'C:/Users/HXT/.workbuddy-ai/binaries/node/workspace/node_modules';
const { chromium } = require(path.join(NODE_WS, 'playwright'));

const SCRIPT = path.join(__dirname, 'douyin-cookie.user.js');
const EXE = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';

// 假 cookie：混入危险项，看脚本会不会漏出去
const REAL_COOKIES = [
  'ttwid=1%7CabcDEF1234567890abcdef',
  's_v_web_id=verify_msmvlk8g_XyZ123',
  'msToken=HfJ8kL2mNpQrStUvWxYz0123456789',
  'odin_tt=deadbeefcafe1234',
  'tt_scid=Zz9aabbcc-ddee-ff00-1122',
  'passport_csrf_token=0123456789abcdef',
  'UIFID=8f3a2b1c9d0e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a',
  'UIFID_TEMP=same_as_uifid_temp',
  // ↓↓↓ 危险项 —— 脚本必须排除
  'sessionid=SECRET_LOGIN_SESSION_DO_NOT_LEAK',
  'sessionid_ss=SECRET_LOGIN_SESSION_SS_DO_NOT_LEAK',
  'sid_tt=SECRET_SID_TT',
  'uid_tt=123456789',
  'passport_auth=SECRET_PASSPORT_AUTH',
].join('; ');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK] ' + name + (extra !== undefined ? '  ' + extra : '')); }
  else { fail++; console.log('  [XX] ' + name + (extra !== undefined ? '  ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3,
  });

  // 拦截 douyin.com，返回假页面
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.includes('douyin.com')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: { 'Set-Cookie': '__placeholder=1; Path=/' },
        body: '<!DOCTYPE html><html><head><title>假抖音</title></head><body><h1>douyin</h1></body></html>',
      });
      return;
    }
    await route.abort();
  });

  const page = await ctx.newPage();

  // 先注入 cookie（在导航前用 addCookies，更接近真实）
  const cookieObjs = REAL_COOKIES.split('; ').map((s) => {
    const i = s.indexOf('=');
    return {
      name: s.slice(0, i),
      value: s.slice(i + 1),
      domain: '.douyin.com',
      path: '/',
    };
  });
  await ctx.addCookies(cookieObjs);

  // 提前注入脚本（document-start 语义）
  const code = require('fs').readFileSync(SCRIPT, 'utf8');
  await ctx.addInitScript({ content: code });

  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  console.log('=== douyin-cookie.user.js 真浏览器测试 ===\n');

  // --- 1. 面板存在 ---
  const panel = await page.$('#__dyck');
  ok('面板出现在页面上', !!panel);

  // --- 2. 逃生舱 ---
  const hasApi = await page.evaluate(() => typeof window.__dyCookie === 'function');
  ok('逃生舱 window.__dyCookie 可用', hasApi);

  // --- 3. 提取结果 ---
  const r = await page.evaluate(() => {
    const x = window.__dyCookie();
    return { picked: Object.keys(x.picked), leaked: x.leaked, missing: x.missing, netscape: x.netscape, total: x.total };
  });

  ok('提取到 8 项', r.picked.length === 8, r.picked.length + ' 项');
  ok('含 ttwid（最关键）', r.picked.includes('ttwid'));
  ok('含 msToken', r.picked.includes('msToken'));
  ok('含 s_v_web_id', r.picked.includes('s_v_web_id'));
  ok('含 odin_tt', r.picked.includes('odin_tt'));
  ok('含 UIFID', r.picked.includes('UIFID'));

  // --- 4. ★ 安全底线：危险项必须被排除 ---
  ok('★ 未提取 sessionid（登录凭证）', !r.picked.includes('sessionid'));
  ok('★ 未提取 sessionid_ss', !r.picked.includes('sessionid_ss'));
  ok('★ 未提取 sid_tt', !r.picked.includes('sid_tt'));
  ok('★ 未提取 uid_tt', !r.picked.includes('uid_tt'));
  ok('★ 未提取 passport_auth', !r.picked.includes('passport_auth'));
  ok('★ Netscape 文本里不含 SECRET 字样', !/SECRET/.test(r.netscape));

  // --- 5. 但脚本应该**知道**危险项存在并报警 ---
  ok('★ 检测到危险项并报警（leaked 非空）', r.leaked.length === 5, r.leaked.join(','));

  // --- 6. Netscape 格式合法 ---
  const lines = r.netscape.split('\n').filter((l) => l && !l.startsWith('#'));
  ok('Netscape 行数 = 8', lines.length === 8, lines.length + ' 行');
  const okFmt = lines.every((l) => l.split('\t').length === 7);
  ok('每行 7 个 tab 分隔字段（yt-dlp 要求）', okFmt);
  const domains = lines.map((l) => l.split('\t')[0]);
  ok('域全是 .douyin.com', domains.every((d) => d === '.douyin.com'));
  const first = lines[0].split('\t');
  ok('第一行字段结构正确', first[0] === '.douyin.com' && first[1] === 'TRUE' && first[2] === '/',
     first.slice(0, 3).join('|'));

  // --- 7. 复制按钮 ---
  const btnMsg = await page.evaluate(async () => {
    const b = document.getElementById('__dyckCopy');
    if (!b) return 'no-button';
    b.click();
    await new Promise((r) => setTimeout(r, 300));
    const m = document.getElementById('__dyckMsg');
    return m ? m.textContent : 'no-msg';
  });
  ok('点击复制按钮有反馈', /已复制|失败/.test(btnMsg), btnMsg);

  // --- 8. 面板显示的项数 ---
  const shown = await page.evaluate(() => document.getElementById('__dyck').textContent);
  ok('面板显示"已提取（8 项）"', shown.includes('8 项'));
  ok('面板显示危险项警告', shown.includes('登录凭证'));

  // 截图
  const shot = path.join(__dirname, 'shots', 'cookie-panel.png');
  await page.screenshot({ path: shot });
  console.log('\n  截图: ' + shot);

  await browser.close();

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '（' + (pass + fail) + ' 项，' + pass + ' 通过 / ' + fail + ' 失败）');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('崩了:', e.message);
  process.exit(1);
});
