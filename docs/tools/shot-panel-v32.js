/* v3.2 面板截图 —— 三个状态都截下来给用户看
 * 跑法：NODE_PATH=... node shot-panel-v32.js douyin-favorites.user.js
 */
const fs = require('fs'), http = require('http');
const PW = 'C:/Users/HXT/.workbuddy-ai/binaries/node/workspace/node_modules/playwright';
const CHROME = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const src = fs.readFileSync(process.argv[2] || 'douyin-favorites.user.js', 'utf8');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:15px/1.7 -apple-system,"Segoe UI",sans-serif;background:#fff;color:#111;margin:0;padding:16px}
h1{font-size:18px;margin:0 0 4px}p{color:#888;font-size:12px;margin:0 0 14px}
.g{display:flex;flex-wrap:wrap;gap:10px}
.card{width:108px;height:78px;background:#f2f3f5;border-radius:10px;padding:9px;
font-size:12px;box-sizing:border-box}
.card b{display:block;margin-top:20px;color:#555;font-weight:500}
</style></head><body>
<h1>我的收藏</h1><p>（假页面，只为截面板）</p>
<div class="g">
<div class="card">对自己好<b>193</b></div><div class="card">猛学<b>404</b></div>
<div class="card">大学计算机<b>249</b></div><div class="card">锻炼<b>85</b></div>
</div></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url.includes('/collects/video/list/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      const n = Number(new URL('http://x' + req.url).searchParams.get('n') || 1);
      return res.end(JSON.stringify({
        status_code: 0, has_more: 1,
        aweme_list: Array.from({ length: 4 }, (_, i) => ({
          aweme_id: 'id' + n + '_' + i, desc: '测试内容' + i,
          author: { nickname: '作者' },
        })),
      }));
    }
    if (req.url.includes('/collects/list/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status_code: 0, collect_list: [
        { name: '对自己好', aweme_count: 193 }, { name: '猛学', aweme_count: 404 },
        { name: '大学计算机', aweme_count: 249 }, { name: '锻炼', aweme_count: 85 },
      ]}));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const { chromium } = require(PW);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.includes('douyin.com')) {
      const resp = await route.fetch({ url: 'http://127.0.0.1:' + port + new URL(u).pathname + (new URL(u).search || '') });
      await route.fulfill({ response: resp });
    } else await route.continue();
  });

  const page = await ctx.newPage();
  await page.addInitScript({ content: src });
  await page.goto('https://www.douyin.com/user/self?showTab=favorite_collection',
    { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const dir = 'C:/Users/HXT/WorkBuddy/2026-08-22-15-35-35/nexus-core/docs/tools/shots';
  fs.mkdirSync(dir, { recursive: true });

  // 状态 1：还没开始
  await page.screenshot({ path: dir + '/v32-1-idle.png' });
  console.log('① 未开始 →', dir + '/v32-1-idle.png');

  // 状态 2：正在记录（有数字）
  await page.evaluate(() => window.__nexusDyArm());
  await page.evaluate(() => {
    const x = new XMLHttpRequest();
    x.open('GET', '/aweme/v1/web/collects/video/list/?n=1'); x.send();
    const y = new XMLHttpRequest();
    y.open('GET', '/aweme/v1/web/collects/video/list/?n=2'); y.send();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: dir + '/v32-2-recording.png' });
  console.log('② 记录中 →', dir + '/v32-2-recording.png');

  // 状态 3：已停止 + 导出按钮
  await page.evaluate(() => window.__nexusDyDisarm());
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#nexus-dy-export button')]
      .find((x) => /停止记录/.test(x.textContent));
    if (b) b.click();
  });
  await page.waitForTimeout(300);
  // 手动让它显示导出按钮
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#nexus-dy-export button')];
    const ex = btns.find((b) => /导出/.test(b.textContent));
    if (ex) ex.style.display = 'block';
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: dir + '/v32-3-done.png' });
  console.log('③ 可导出 →', dir + '/v32-3-done.png');

  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
