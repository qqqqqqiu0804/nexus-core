/* 把面板在真浏览器里的样子截下来 —— 让用户先看到，再决定要不要装
 * 跑法：node shot-panel.js douyin-favorites.user.js
 */
const fs = require('fs'); const http = require('http');
const PW = 'C:/Users/HXT/.workbuddy-ai/binaries/node/workspace/node_modules/playwright';
const CHROME = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const src = fs.readFileSync(process.argv[2] || 'douyin-favorites.user.js', 'utf8');

const GROUPS = { status_code: 0, collect_list: [
  { name: '对自己好', aweme_count: 193 }, { name: '猛学', aweme_count: 404 },
  { name: '大学计算机', aweme_count: 249 }, { name: 'AI学习', aweme_count: 88 } ] };
const VIDEOS = { status_code: 0, has_more: 1, aweme_list: Array.from({length:6},(_,i)=>({
  aweme_id: '73' + (1000000 + i), desc: '第 ' + (i+1) + ' 条测试视频标题',
  author: { nickname: '某作者' }, create_time: 1700000000, statistics: { digg_count: 1200 } })) };

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:15px/1.7 -apple-system,"Segoe UI",sans-serif;background:#fff;color:#111;margin:0;padding:18px}
h1{font-size:19px;margin:0 0 6px}p{color:#666;font-size:13px;margin:0 0 16px}
.card{display:inline-block;width:118px;height:88px;background:#f2f3f5;border-radius:10px;
margin:0 10px 10px 0;padding:10px;vertical-align:top;font-size:13px}
.card b{display:block;margin-top:22px;font-size:12px;color:#333}
</style></head><body>
<h1>我的收藏</h1><p>（这是假页面，只为截面板的样子）</p>
<div class="card">对自己好<b>193</b></div><div class="card">猛学<b>404</b></div>
<div class="card">大学计算机<b>249</b></div><div class="card">AI学习<b>88</b></div>
<script>
setTimeout(function(){var x=new XMLHttpRequest();
x.open('GET','/aweme/v1/web/collect/listcollection/?count=20');x.send();},50);
setTimeout(function(){var y=new XMLHttpRequest();
y.open('GET','/aweme/v1/web/collect/aweme/?count=6');y.send();},1100);
</script></body></html>`;

(async () => {
  const server = http.createServer((req,res)=>{
    if (req.url.includes('/aweme/v1/web/collect/aweme/')) {
      res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(VIDEOS));
    }
    if (req.url.includes('/aweme/v1/web/collect/')) {
      res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(GROUPS));
    }
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port = server.address().port;
  const { chromium } = require(PW);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport:{width:430,height:932}, deviceScaleFactor:2 });
  await ctx.route('**/*', async (route)=>{
    const u = route.request().url();
    if (u.includes('douyin.com')) {
      const resp = await route.fetch({ url:'http://127.0.0.1:'+port+new URL(u).pathname });
      await route.fulfill({ response: resp });
    } else await route.continue();
  });
  const page = await ctx.newPage();
  await page.addInitScript({ content: src });
  await page.goto('https://www.douyin.com/user/self?showTab=collection',{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(700);
  const outDir = 'C:/Users/HXT/WorkBuddy/2026-08-22-15-35-35/nexus-core/docs/tools/shots';
  fs.mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: outDir + '/panel-1-groups.png' });
  console.log('① 分组态 →', outDir + '/panel-1-groups.png');
  await page.waitForTimeout(1400);
  await page.screenshot({ path: outDir + '/panel-2-videos.png' });
  console.log('② 视频态 →', outDir + '/panel-2-videos.png');
  await browser.close(); server.close();
})().catch(e=>{console.error(e);process.exit(1);});
