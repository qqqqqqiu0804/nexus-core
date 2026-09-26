/* 篡改猴脚本的「真浏览器」测试 —— 补上假 DOM 测试够不到的那一块
 *
 * 假 DOM 测试能验证「逻辑对不对」，但验证不了「在真浏览器里会不会建出来」。
 * 上次 v2 出问题的正是后者：逻辑没错，面板根本没建。
 *
 * 这个测试做的事：
 *   1. 起一个本地 http 服务，伪装成 www.douyin.com（用 hostResolver 劫持）
 *   2. 用真实 Chromium 打开，注入脚本（等同篡改猴的 document-start 注入）
 *   3. 让页面自己发一次 XHR 打收藏夹接口，返回假的分组数据
 *   4. 断言：面板真的出现在 DOM 里、且真的显示了「N 个收藏夹分组」
 *
 * 跑法（在 docs/tools 下）：
 *   node test-userscript-real.js douyin-favorites.user.js
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const PW = 'C:/Users/HXT/.workbuddy-ai/binaries/node/workspace/node_modules/playwright';
const CHROME = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';

const src = fs.readFileSync(process.argv[2] || 'douyin-favorites.user.js', 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK] ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  ' + extra : '')); }
}

// 假的分组式收藏夹响应（形状照抄真实接口）
const FAKE_GROUPS = {
  status_code: 0,
  collect_list: [
    { name: '对自己好', aweme_count: 193 },
    { name: '猛学', aweme_count: 404 },
    { name: '大学计算机', aweme_count: 249 },
    { name: 'AI学习', aweme_count: 88 },
  ],
};

(async () => {
  // ---- 1. 本地服务 ----
  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>我的收藏</title></head><body>
<h1>我的收藏（假页面）</h1>
<script>
  // 页面自己发一次 XHR，打"收藏夹分组"接口
  setTimeout(function () {
    var x = new XMLHttpRequest();
    x.open('GET', '/aweme/v1/web/collect/listcollection/?count=20');
    x.onload = function () {};
    x.send();
  }, 60);
</script>
</body></html>`;

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/aweme/v1/web/collect/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(FAKE_GROUPS));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log('本地服务端口：' + port);

  const { chromium } = require(PW);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 },
  });

  // 关键：把 www.douyin.com 劫持到本地服务，这样 @match 才会命中
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.includes('douyin.com')) {
      const p = new URL(u).pathname;
      const target = 'http://127.0.0.1:' + port + p;
      const resp = await route.fetch({ url: target });
      await route.fulfill({ response: resp });
    } else {
      await route.continue();
    }
  });

  const page = await ctx.newPage();

  // 等同篡改猴 document-start 注入
  await page.addInitScript({ content: src });

  await page.goto('https://www.douyin.com/user/self?showTab=collection', {
    waitUntil: 'domcontentloaded',
  });

  await page.waitForTimeout(1200);

  // ---- 4. 断言 ----
  console.log('=== 真浏览器测试 ===');

  const panel = await page.$('#nexus-dy-export');
  ok('面板已注入到真实 DOM', !!panel, panel ? '(找到 #nexus-dy-export)' : '(没找到)');

  if (panel) {
    const text = await page.evaluate(
      () => document.getElementById('nexus-dy-export').innerText
    );
    ok('面板显示识别到分组', /个收藏夹分组/.test(text));
    ok('面板显示分组数量 4', /4\s*<\/?b?[^>]*>\s*个收藏夹分组/.test(text) || text.includes('4 个收藏夹分组')
       || /发现\s*4\s*个收藏夹分组/.test(text.replace(/\s+/g, ' ')),
       '(' + text.replace(/\s+/g, ' ').slice(0, 90) + ')');
    ok('面板显示最近接口', text.includes('最近接口') && text.includes('collect'));
  }

  const stat = await page.evaluate(() => {
    try { return window.__nexusDyStat ? window.__nexusDyStat() : null; }
    catch (e) { return { err: String(e) }; }
  });
  ok('逃生命令 __nexusDyStat 可用', !!stat && !stat.err, JSON.stringify(stat));

  if (stat && stat.groups) {
    ok('分组数 = 4', stat.groups.length === 4, '实际 ' + stat.groups.length);
    const names = stat.groups.map((g) => g.name).sort();
    ok('分组名正确', names.includes('猛学') && names.includes('大学计算机'),
       names.join('/'));
  }
  if (stat && stat.hooks) {
    ok('XHR 钩子已生效', stat.hooks.xhr === true);
  }

  // 面板位置（手机端视角：不能盖住整屏、不能溢出）
  const rect = panel ? await page.evaluate(() => {
    const r = document.getElementById('nexus-dy-export').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }) : null;
  if (rect) {
    ok('面板未溢出屏幕', rect.x >= 0 && rect.y >= 0
       && rect.x + rect.w <= 430 && rect.y + rect.h <= 932,
       JSON.stringify(rect));
    ok('面板宽度 <= 320（手机端不挡内容）', rect.w <= 322, '宽 ' + rect.w);
  }

  await browser.close();
  server.close();

  console.log('');
  console.log(fail === 0
    ? '全部通过（' + pass + ' 项）'
    : pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(2);
});
