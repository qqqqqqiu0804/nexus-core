/* v3.2 真浏览器测试 —— 开关在真实 Chromium 里的交互
 *
 * 假 DOM 测了逻辑，但测不到"按钮真的能点、点完状态真的变"。
 * v2 栽过一次"逻辑对但东西不出现"，所以关键交互都要在真浏览器过一遍。
 *
 * 断言：
 *   ① 面板出现，初始是"还没开始记录" + 绿色「开始记录」按钮
 *   ② 点击后变 ⏺ 正在记录 + 按钮变红「停止记录」
 *   ③ 记录期间发请求 → 数字上涨
 *   ④ 再点 → 停止 + 出现蓝色导出按钮
 *   ⑤ 停止后发请求 → 数字不动（关键：脏数据进不来）
 *
 * 跑法：NODE_PATH=... node test-userscript-v32-real.js douyin-favorites.user.js
 */
const fs = require('fs'), http = require('http');
const PW = 'C:/Users/HXT/.workbuddy-ai/binaries/node/workspace/node_modules/playwright';
const CHROME = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const src = fs.readFileSync(process.argv[2] || 'douyin-favorites.user.js', 'utf8');

let pass = 0, fail = 0;
function ok(n, c, e) {
  if (c) { pass++; console.log('  [OK] ' + n + (e ? '  ' + e : '')); }
  else { fail++; console.log('  [FAIL] ' + n + (e ? '  ' + e : '')); }
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:15px/1.7 sans-serif;background:#fff;color:#111;margin:0;padding:18px}
h1{font-size:19px;margin:0 0 14px}.card{display:inline-block;width:110px;height:80px;
background:#f2f3f5;border-radius:10px;margin:0 10px 10px 0;padding:10px;font-size:13px}
</style></head><body><h1>某个收藏夹</h1>
<div class="card">视频1</div><div class="card">视频2</div><div class="card">视频3</div>
</body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url.includes('/collects/video/list/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      const n = Number(new URL('http://x' + req.url).searchParams.get('n') || 1);
      return res.end(JSON.stringify({
        status_code: 0, has_more: 1,
        aweme_list: Array.from({ length: 5 }, (_, i) => ({
          aweme_id: 'id' + n + '_' + i, desc: '第 ' + n + ' 批第 ' + i + ' 条',
          author: { nickname: '作者' },
        })),
      }));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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
      const resp = await route.fetch({ url: 'http://127.0.0.1:' + port + new URL(u).pathname + (new URL(u).search || '') });
      await route.fulfill({ response: resp });
    } else await route.continue();
  });

  const page = await ctx.newPage();
  await page.addInitScript({ content: src });
  await page.goto('https://www.douyin.com/user/self?showTab=favorite_collection',
    { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  console.log('=== v3.2 真浏览器交互测试 ===');

  const panel = await page.$('#nexus-dy-export');
  ok('面板已注入真实 DOM', !!panel);

  const txt = () => page.evaluate(
    () => document.getElementById('nexus-dy-export').innerText);
  const btnTexts = () => page.evaluate(() => [...document.querySelectorAll(
    '#nexus-dy-export button')].map((b) => b.textContent));

  // ---- ① 初始状态 ----
  let t = await txt();
  ok('初始显示"还没开始记录"', /还没开始记录/.test(t), t.replace(/\s+/g, ' ').slice(0, 40));
  let btns = await btnTexts();
  ok('有「开始记录」按钮', btns.some((b) => /开始记录/.test(b)), btns.join(' | '));

  // ---- ② 点击开始 ----
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#nexus-dy-export button')]
      .find((x) => /开始记录/.test(x.textContent));
    b.click();
  });
  await page.waitForTimeout(150);
  t = await txt();
  ok('点击后变成"正在记录"', /正在记录/.test(t), t.replace(/\s+/g, ' ').slice(0, 40));
  btns = await btnTexts();
  ok('按钮变成「停止记录」', btns.some((b) => /停止记录/.test(b)), btns.join(' | '));

  // ---- ③ 记录期间收数据 ----
  await page.evaluate(() => {
    const x = new XMLHttpRequest();
    x.open('GET', '/aweme/v1/web/collects/video/list/?n=1');
    x.send();
  });
  await page.waitForTimeout(400);
  let st = await page.evaluate(() => window.__nexusDyStat());
  ok('记录期间收到 5 条', st.items === 5, '收到 ' + st.items);

  // ---- ④ 再点停止 ----
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#nexus-dy-export button')]
      .find((x) => /停止记录/.test(x.textContent));
    b.click();
  });
  await page.waitForTimeout(150);
  btns = await btnTexts();
  ok('出现导出按钮', btns.some((b) => /导出\s*5\s*条/.test(b)), btns.join(' | '));

  // ---- ⑤ 停止后发请求，数字不该动（最关键）----
  await page.evaluate(() => {
    const x = new XMLHttpRequest();
    x.open('GET', '/aweme/v1/web/collects/video/list/?n=2');
    x.send();
  });
  await page.waitForTimeout(400);
  st = await page.evaluate(() => window.__nexusDyStat());
  ok('停止后脏数据进不来', st.items === 5, '仍是 ' + st.items + ' 条');

  // ---- ⑥ 导出内容正确 ----
  const exported = await page.evaluate(() => {
    let cap = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (blob) => { cap = blob; return 'blob:test'; };
    window.__nexusDyExport();
    URL.createObjectURL = orig;
    return cap ? cap.text() : null;
  });
  const payload = exported ? JSON.parse(exported) : null;
  ok('能导出', !!payload);
  if (payload) {
    ok('导出 5 条', payload.items.length === 5, payload.items.length + ' 条');
    ok('是第 1 批（n=1）的内容',
       payload.items.every((r) => /id1_/.test(r.aweme_id)),
       payload.items[0].aweme_id);
    ok('第 2 批（n=2）没混进来',
       !payload.items.some((r) => /id2_/.test(r.aweme_id)));
  }

  // ---- ⑦ 面板不溢出手机屏 ----
  const r = await page.evaluate(() => {
    const b = document.getElementById('nexus-dy-export').getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  ok('面板不溢出 430x932', r.x >= 0 && r.y >= 0 && r.x + r.w <= 430 && r.y + r.h <= 932,
     JSON.stringify(r));

  await browser.close();
  server.close();
  console.log('');
  console.log(fail === 0 ? '全部通过（' + pass + ' 项）' : pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('崩溃：', e); process.exit(2); });
