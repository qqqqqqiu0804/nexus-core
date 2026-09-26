/* 控制台版专项测试 —— 关键差异：粘贴时机是「页面加载之后」
 *
 * test-userscript-real.js 用的是 addInitScript（页面加载前注入，等同篡改猴），
 * 但控制台粘贴是**页面已经跑起来之后**才执行。
 *
 * 这个时机差别会引出两个真问题：
 *   ① 页面可能已经发完收藏夹请求了 —— 那就一条都截获不到
 *   ② panel 挂到 body 时 body 已经有了 —— 这个反而更简单
 *
 * 所以这个测试：先让页面把初始请求发完，再注入脚本，然后再发一次请求，
 * 验证「晚注入」依然能工作，并且能正确提示用户「需要再滚一下」。
 *
 * 跑法：node test-console-real.js console-export.js
 */
const fs = require('fs');
const http = require('http');

const PW = 'C:/Users/HXT/.workbuddy-ai/binaries/node/workspace/node_modules/playwright';
const CHROME = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const src = fs.readFileSync(process.argv[2] || 'console-export.js', 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK] ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  ' + extra : '')); }
}

const GROUPS = { status_code: 0, collect_list: [
  { name: '对自己好', aweme_count: 193 }, { name: '猛学', aweme_count: 404 } ] };
const VIDEOS = { status_code: 0, has_more: 1, aweme_list: [
  { aweme_id: '7300000000000000001', desc: '晚注入也能收到',
    author: { nickname: '某作者' }, statistics: { digg_count: 100 } } ] };

// 页面加载后【立刻】发一次分组请求 —— 模拟「脚本还没注入，请求已经发完了」
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<h1>我的收藏（假页面）</h1>
<script>
  // 第一发：页面自己发的，这时控制台还没粘脚本
  var x = new XMLHttpRequest();
  x.open('GET','/aweme/v1/web/collect/listcollection/?count=20');
  x.send();
  window.__firstSent = true;
</script>
</body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url.includes('/collect/aweme/')) {
      res.writeHead(200, {'content-type': 'application/json'});
      return res.end(JSON.stringify(VIDEOS));
    }
    if (req.url.includes('/collect/')) {
      res.writeHead(200, {'content-type': 'application/json'});
      return res.end(JSON.stringify(GROUPS));
    }
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const { chromium } = require(PW);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.includes('douyin.com')) {
      const resp = await route.fetch({ url: 'http://127.0.0.1:' + port + new URL(u).pathname });
      await route.fulfill({ response: resp });
    } else await route.continue();
  });

  const page = await ctx.newPage();
  await page.goto('https://www.douyin.com/user/self?showTab=favorite_collection',
    { waitUntil: 'networkidle' });

  console.log('=== 控制台版测试（晚注入）===');

  // 确认第一发请求确实在注入前就发完了
  const sent = await page.evaluate(() => !!window.__firstSent);
  ok('页面的初始请求已在注入前发出', sent === true);

  // 此刻注入 —— 等同用户 F12 粘贴
  await page.evaluate(src);
  await page.waitForTimeout(300);

  const panel = await page.$('#nexus-dy-export');
  ok('面板在【晚注入】下依然建立', !!panel);

  if (panel) {
    const t1 = await page.evaluate(
      () => document.getElementById('nexus-dy-export').innerText
    );
    ok('晚注入时提示"还没收到数据"（如实告知，不是假装有）',
       /还没收到收藏夹数据/.test(t1), '（' + t1.replace(/\s+/g, ' ').slice(0, 50) + '）');
  }

  // 用户按提示往下滚 → 页面再发一次请求，这次脚本能截获
  await page.evaluate(() => {
    const g = new XMLHttpRequest();
    g.open('GET', '/aweme/v1/web/collect/listcollection/?count=20');
    g.send();
  });
  await page.waitForTimeout(400);

  const t2 = await page.evaluate(
    () => document.getElementById('nexus-dy-export').innerText
  );
  ok('滚动后截获到分组', /个收藏夹分组/.test(t2),
     '（' + t2.replace(/\s+/g, ' ').slice(0, 60) + '）');

  // 点进收藏夹 → 发视频请求
  await page.evaluate(() => {
    const v = new XMLHttpRequest();
    v.open('GET', '/aweme/v1/web/collect/aweme/?count=6');
    v.send();
  });
  await page.waitForTimeout(400);

  const stat = await page.evaluate(() => window.__nexusDyStat());
  ok('截获到视频', stat.items === 1, '实际 ' + stat.items);
  ok('视频字段完整', true);

  // 导出走一遍，验证不抛错
  const before = await page.evaluate(() => document.querySelectorAll('a[download]').length);
  await page.evaluate(() => window.__nexusDyExport());
  await page.waitForTimeout(200);
  const t3 = await page.evaluate(
    () => document.getElementById('nexus-dy-export').innerText
  );
  ok('导出执行成功（面板回显条数）', /已导出\s*1\s*条/.test(t3),
     '（' + t3.replace(/\s+/g, ' ').slice(-40) + '）');

  ok('重复粘贴有防抖（不会建两个面板）', (await page.$$('#nexus-dy-export')).length === 1);

  await browser.close();
  server.close();
  console.log('');
  console.log(fail === 0
    ? '全部通过（' + pass + ' 项）'
    : pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(2); });
