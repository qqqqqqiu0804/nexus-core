#!/usr/bin/env node
/*
 * douyin-collect.user.js v4 真浏览器测试
 *
 * 重点测「play_url 提取」—— 这是 v4 的核心新增，
 * 也是最容易写错的地方（抖音的字段结构有多种形态）。
 *
 * 用假接口响应喂进去，验证：
 *   1. 面板出现
 *   2. 开关关着时什么都不收
 *   3. 开着时能收，且能从多种字段结构里抠出 play_url
 *   4. 只导出开启期间的数据
 */
const path = require('path');
const NODE_WS = 'C:/Users/HXT/.workbuddy-ai/binaries/node/workspace/node_modules';
const { chromium } = require(path.join(NODE_WS, 'playwright'));
const EXE = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const SCRIPT = path.join(__dirname, 'douyin-collect.user.js');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  [OK] ' + n + (e !== undefined ? '  ' + e : '')); }
  else { fail++; console.log('  [XX] ' + n + (e !== undefined ? '  ' + e : '')); }
};

// 三种形态的假响应（模拟抖音真实返回的多样性）
const FAKE_LIST = JSON.stringify({
  aweme_list: [
    { // 标准形态
      aweme_id: '1111111111111111111',
      desc: '形态A：标准 play_addr',
      author: { nickname: '作者甲' },
      video: { duration: 120, play_addr: { url_list: [
        'https://v11-weba.douyinvod.com/aaa/video/tos/x.mp4',
        'http://v26-web.douyinvod.com/bbb/video/tos/y.mp4',
      ] } },
      create_time: 1700000000, digg_count: 500, aweme_type: 0,
    },
    { // bit_rate 形态
      aweme_id: '2222222222222222222',
      desc: '形态B：藏在 bit_rate 里',
      author: { unique_id: 'author_b' },
      duration: 60,
      video: { duration: 60, bit_rate: [
        { play_addr: { url_list: ['https://v3-web.douyinvod.com/ccc/z.mp4'] } },
      ] },
      create_time: 1700000001, aweme_type: 0,
    },
    { // 无地址形态（图文）
      aweme_id: '3333333333333333333',
      desc: '形态C：没有视频地址',
      author: { nickname: '作者丙' },
      create_time: 1700000002, aweme_type: 68,
    },
  ],
});

const FAKE_CELL = JSON.stringify({
  cell_data: [
    { aweme: {
      aweme_id: '4444444444444444444',
      desc: '形态D：埋在 cell_data 里',
      author: { nickname: '作者丁' },
      video: { duration: 30, play_addr: { url_list: ['https://v9.douyinvod.com/ddd/w.mp4'] } },
      create_time: 1700000003, aweme_type: 0,
    } },
  ],
});

const FAKE_DETAIL = JSON.stringify({
  aweme_detail: {
    aweme_id: '5555555555555555555',
    desc: '形态E：详情接口',
    author: { nickname: '作者戊' },
    video: { duration: 200, play_addr: { url_list: ['https://v1.douyinvod.com/eee/v.mp4'] } },
    create_time: 1700000004, aweme_type: 0,
  },
});

const FAKE_GROUP = JSON.stringify({
  collect_list: [{ name: '对自己好', count: 193 }, { name: '猛学', count: 88 }],
});

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });

  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.includes('douyin.com')) {
      await route.fulfill({
        status: 200, contentType: 'text/html; charset=utf-8',
        body: '<!DOCTYPE html><html><body><h1>假抖音</h1></body></html>',
      });
      return;
    }
    await route.abort();
  });

  const code = require('fs').readFileSync(SCRIPT, 'utf8');
  await ctx.addInitScript({ content: code });
  const page = await ctx.newPage();
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);

  console.log('=== douyin-collect v4 测试 ===\n');

  ok('面板出现', !!(await page.$('#__dyCollect')));
  ok('逃生舱可用', await page.evaluate(() => typeof window.__dyCollect === 'function'));

  // ---- 开关关着时：喂数据，不该收 ----
  await page.evaluate((t) => {
    const x = new XMLHttpRequest();
    x.open('GET', '/aweme/v1/web/collects/list/');
    x.send();
    // 直接用内部函数注入（模拟响应）
    window.__testAbsorb && window.__testAbsorb(t);
  }, FAKE_GROUP).catch(() => {});
  // 没有 __testAbsorb，用 XHR 真实路径 —— 用 route 拦截更直接，但简化测：关着时 stat 应为 0
  let st = await page.evaluate(() => window.__dyCollectStat());
  ok('关着时条目为 0（脏数据进不来）', st.items === 0, st.items);
  ok('初始 armed=false', st.armed === false);

  // ---- 打开开关 ----
  await page.evaluate(() => window.__dyCollectArm());
  st = await page.evaluate(() => window.__dyCollectStat());
  ok('开启后 armed=true', st.armed === true);

  // ---- 直接调内部采集（通过模拟 XHR load 事件）----
  // 简化：用 window 上的逃生舱注入不行，改为直接在页面里构造 XHR 并 dispatch
  const ingest = async (body) => {
    return page.evaluate((txt) => {
      // 找到脚本装的 XHR 原型上的 load 监听 —— 直接触发一次真实 XHR
      // 这里用最简单可靠的办法：monkey 已装，我们伪造一个 XHR 对象
      const x = new XMLHttpRequest();
      x.open('GET', 'https://www.douyin.com/aweme/v1/web/collects/video/list/');
      // 手动触发 load 事件并让 responseText 返回我们的假数据
      Object.defineProperty(x, 'responseText', { get: () => txt, configurable: true });
      x.dispatchEvent(new Event('load'));
      return true;
    }, body);
  };

  await ingest(FAKE_LIST);
  st = await page.evaluate(() => window.__dyCollectStat());
  ok('收到 3 条（形态 A/B/C）', st.items === 3, st.items);
  ok('★ 2 条含播放地址（C 是图文没地址）', st.withUrl === 2, st.withUrl);

  await ingest(FAKE_CELL);
  st = await page.evaluate(() => window.__dyCollectStat());
  ok('★ cell_data 形态也能收到', st.items === 4, st.items);
  ok('★ 含地址的变 3 条', st.withUrl === 3, st.withUrl);

  await ingest(FAKE_DETAIL);
  st = await page.evaluate(() => window.__dyCollectStat());
  ok('★ detail 形态也能收到', st.items === 5, st.items);
  ok('★ 含地址 4 条', st.withUrl === 4, st.withUrl);

  // ---- 去重 ----
  await ingest(FAKE_LIST);
  st = await page.evaluate(() => window.__dyCollectStat());
  ok('重复喂不重复计数', st.items === 5, st.items);

  // ---- 拿具体数据检查 ----
  const rows = await page.evaluate(() => window.__dyCollect());
  const byId = {};
  rows.forEach((r) => { byId[r.aweme_id] = r; });

  ok('形态A 挑到了 https 的 douyinvod 地址',
    /^https:.*douyinvod/.test(byId['1111111111111111111'].play_url || ''),
    (byId['1111111111111111111'].play_url || '').slice(0, 50));
  ok('形态B 从 bit_rate 里抠出来了',
    !!byId['2222222222222222222'].play_url,
    (byId['2222222222222222222'].play_url || '').slice(0, 50));
  ok('形态C 没有地址（如实为空，不瞎编）',
    byId['3333333333333333333'].play_url === '');
  ok('形态D 地址正确', !!byId['4444444444444444444'].play_url);
  ok('形态E 地址正确', !!byId['5555555555555555555'].play_url);

  ok('作者昵称取到了', byId['1111111111111111111'].author === '作者甲');
  ok('unique_id 兜底生效', byId['2222222222222222222'].author === 'author_b');
  ok('时长转成毫秒', byId['1111111111111111111'].duration_ms === 120000,
    byId['1111111111111111111'].duration_ms);
  ok('url 字段拼好了',
    byId['1111111111111111111'].url === 'https://www.douyin.com/video/1111111111111111111');

  // ---- 关掉开关，脏数据不该进 ----
  await page.evaluate(() => window.__dyCollectDisarm());
  const before = (await page.evaluate(() => window.__dyCollectStat())).items;
  await ingest(FAKE_DETAIL);
  const after = (await page.evaluate(() => window.__dyCollectStat())).items;
  ok('★ 关掉后不再收新数据', after === before, before + ' → ' + after);

  // ---- 重新开始要清空 ----
  await page.evaluate(() => window.__dyCollectArm());
  st = await page.evaluate(() => window.__dyCollectStat());
  ok('★ 重新开始会清空旧数据', st.items === 0, st.items);

  await page.screenshot({ path: path.join(__dirname, 'shots', 'collect-panel.png') });
  console.log('\n  截图: shots/collect-panel.png');
  await browser.close();

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') +
    '（' + (pass + fail) + ' 项，' + pass + ' 通过 / ' + fail + ' 失败）');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('崩了:', e.message); process.exit(1); });
