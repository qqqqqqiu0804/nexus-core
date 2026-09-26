// verify-wallet-mobile.js —— 记账一句话改造 手机端验收
//
// 覆盖用户在这次改动里的每一条要求：
//   1. 「目前的这个快速记账和记一笔都不要了」→ 旧 DOM 必须不存在
//   2. 「a 加 c 要猜」→ 账本页有输入框(A) + 今日页也有入口(C)
//   3. 「交易复盘…可以删掉了 顺便把历史复盘删了吧」→ 整块消失
//   4. 「近 6 个月趋势和交易记录，你加一个能收起来的」→ 可折叠 + 能记住
//   5. 「数据管理，也可以搞一个收起来的」→ 可折叠
//   6. 铁律：手机端 430px 不横向溢出；触摸目标 ≥26px；根字号 16px
//
// 关键：**真的记一笔**，然后验证账户余额被正确扣减（这是最容易改坏的地方）。
const { chromium } = require('playwright');
const path = require('path');

const HTML = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const CHROME = 'C:/Users/HXT/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';

let pass = 0, fail = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; fails.push(label + (extra ? '  → ' + extra : '')); console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}

// 预置一个干净的钱包：池账户 1000 元，方便验算
const SEED_WALLET = {
  cash: 1000, invest: 0, initialSet: true,
  cashAccounts: [{ id: '__pool__', name: '现金（不分账户）', amount: 1000 }],
  transactions: []
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 740 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();

  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await ctx.addInitScript(w => {
    localStorage.setItem('nexus_wallet', JSON.stringify(w));
    // ★ 必须同时置 initialized=true。
    // 踩过的坑：只写 wallet 不写 initialized，initData() 会认为这是首次启动，
    // 用 {cash:0, transactions:[]} 把我的种子数据整个覆盖掉 —— 表现为
    // 「余额断言全挂、池账户读出来是 0」，看着像记账没落账户，其实是测试没种对。
    localStorage.setItem('nexus_initialized', 'true');
    // 关掉同步，避免测试去请求真服务器
    localStorage.setItem('nexus_server_url', '');
  }, SEED_WALLET);

  await page.goto(HTML, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);

  // ============================================================ 1 旧 DOM 必须消失
  console.log('\n【1】旧录入方式已删除（用户要求「快速记账和记一笔都不要了」）');
  const gone = await page.evaluate(() => {
    const ids = ['quick-cats', 'quick-input-row', 'quick-amount', 'quick-cat-label',
                 'wallet-amount', 'wallet-category', 'wallet-note', 'wallet-when',
                 'wallet-account', 'wallet-add-btn', 'invest-journal', 'invest-history-list'];
    const present = ids.filter(i => document.getElementById(i));
    // 用 querySelector 找一下残留的旧 class
    const clsOld = ['.quick-add', '.wallet-add-form', '.wallet-type-toggle'].filter(s => document.querySelector(s));
    return { present, clsOld };
  });
  console.log('    仍存在的旧 id =', JSON.stringify(gone.present));
  ok(gone.present.length === 0, '旧录入相关 id 全部消失', gone.present.join(','));
  ok(gone.clsOld.length === 0, '旧 class（.quick-add/.wallet-add-form/.wallet-type-toggle）全部消失', gone.clsOld.join(','));

  const goneFn = await page.evaluate(() => {
    const names = ['quickPick', 'quickConfirm', 'quickCancel', 'renderQuickCats',
                   'addTransaction', 'editTransaction', 'saveEditTransaction',
                   'setWalletType', 'renderInvestJournal', 'saveInvestJournal', 'renderInvestHistory'];
    return names.filter(n => typeof window[n] === 'function');
  });
  ok(goneFn.length === 0, '旧函数全部移除', goneFn.join(','));

  // 复盘文案也必须没了
  const bodyTxt = await page.$eval('body', el => el.innerText);
  ok(!/交易复盘/.test(bodyTxt), '页面里没有「交易复盘」字样');
  ok(!/历史复盘/.test(bodyTxt), '页面里没有「历史复盘」字样');
  ok(!/快速记账/.test(bodyTxt), '页面里没有「快速记账」字样');

  // ============================================================ 2 账本页 A 入口
  console.log('\n【2】账本页：一句话记账（选项 A）');
  await page.click('.tab-item[data-panel="data"]');
  await page.waitForTimeout(500);
  ok(await page.isVisible('#exp-input'), '记账输入框可见');
  ok(await page.isVisible('#exp-submit'), '「记下」按钮可见');

  // 输入 → 实时预览
  await page.fill('#exp-input', '肠粉 8');
  await page.waitForTimeout(250);
  let prev = await page.$eval('#exp-preview', el => el.classList.contains('show') ? el.innerText.replace(/\s+/g, ' ') : '');
  console.log('    预览(肠粉 8) =', prev);
  ok(prev.length > 0, '实时预览出现');
  ok(/餐饮/.test(prev), '识别成餐饮');
  ok(/8\.00/.test(prev), '识别出金额 8.00');
  ok(/支出/.test(prev), '识别成支出');
  ok(/凭「肠粉」/.test(prev), '给出分类依据（会说「凭什么」）');

  // 收入句
  await page.fill('#exp-input', '工资 8000');
  await page.waitForTimeout(250);
  prev = await page.$eval('#exp-preview', el => el.innerText.replace(/\s+/g, ' '));
  console.log('    预览(工资 8000) =', prev);
  ok(/工资/.test(prev) && /收入/.test(prev), '「工资」→ 收入/工资');
  ok(/\+¥8000\.00/.test(prev), '收入显示 + 号');

  // 无金额的提示
  await page.fill('#exp-input', '不知道写什么');
  await page.waitForTimeout(250);
  prev = await page.$eval('#exp-preview', el => el.innerText.replace(/\s+/g, ' '));
  ok(/没找到金额/.test(prev), '没金额时明确提示', prev);

  // ============================================================ 3 真记一笔 + 验算余额
  console.log('\n【3】真的记一笔：余额必须正确扣减');
  await page.fill('#exp-input', '肠粉 8');
  await page.waitForTimeout(200);
  await page.click('#exp-submit');
  await page.waitForTimeout(600);

  const after = await page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem('nexus_wallet') || '{}');
    const pool = (w.cashAccounts || []).find(a => a.id === '__pool__') || {};
    return {
      n: (w.transactions || []).length,
      tx: (w.transactions || [])[0] || null,
      pool: Number(pool.amount || 0),
      cash: Number(w.cash || 0),
    };
  });
  console.log('    交易数 =', after.n, '池余额 =', after.pool, '现金总额 =', after.cash);
  ok(after.n === 1, '交易数 +1', String(after.n));
  ok(after.pool === 992, '池账户 1000 − 8 = 992', String(after.pool));
  ok(after.cash === 992, '现金总额同步 = 992（Σ账户 成立）', String(after.cash));
  ok(after.tx && after.tx.type === 'expense', '类型 = expense');
  ok(after.tx && after.tx.amount === 8, '金额 = 8');
  ok(after.tx && after.tx.category === '餐饮', '分类 = 餐饮', after.tx && after.tx.category);
  ok(after.tx && after.tx.account === '__pool__', '落到池账户', after.tx && after.tx.account);
  ok(after.tx && /^\d{4}-\d{2}-\d{2}T/.test(after.tx.date), '日期格式正确', after.tx && after.tx.date);

  // 输入框应被清空
  ok(await page.$eval('#exp-input', el => el.value === ''), '提交后输入框清空');
  ok(await page.$eval('#exp-preview', el => !el.classList.contains('show')), '提交后预览收起');

  // 头部数字跟着动
  const todayExp = await page.$eval('#wallet-today-expense', el => el.textContent);
  console.log('    今日支出 =', todayExp);
  ok(/8/.test(todayExp), '今日支出卡显示 8', todayExp);

  // ============================================================ 4 收入也真记一笔
  console.log('\n【4】收入也要能记');
  await page.fill('#exp-input', '生活费 1500');
  await page.waitForTimeout(200);
  await page.click('#exp-submit');
  await page.waitForTimeout(600);
  const after2 = await page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem('nexus_wallet') || '{}');
    const pool = (w.cashAccounts || []).find(a => a.id === '__pool__') || {};
    return { n: (w.transactions || []).length, pool: Number(pool.amount || 0), t0: (w.transactions || [])[0] };
  });
  console.log('    交易数 =', after2.n, '池余额 =', after2.pool);
  ok(after2.n === 2, '交易数 = 2');
  ok(after2.pool === 2492, '992 + 1500 = 2492', String(after2.pool));
  ok(after2.t0.type === 'income' && after2.t0.category === '生活费', '收入/生活费', after2.t0.type + '/' + after2.t0.category);

  // ============================================================ 5 编辑（走一句话框）
  console.log('\n【5】改一笔：走同一个框，余额要回滚再重算');
  await page.evaluate(() => expEditTxn(JSON.parse(localStorage.getItem('nexus_wallet')).transactions.find(t => t.type === 'expense').id));
  await page.waitForTimeout(500);
  const editVal = await page.$eval('#exp-input', el => el.value);
  console.log('    回填的句子 =', JSON.stringify(editVal));
  ok(editVal.length > 0, '整条记录被拼回输入框');
  ok(/8/.test(editVal), '句子里带金额');
  ok(await page.isVisible('#exp-cancel-edit'), '出现「取消修改」');
  ok(await page.$eval('#exp-submit', el => el.textContent.trim() === '保存修改'), '按钮变「保存修改」');

  // 改成 20
  await page.fill('#exp-input', '肠粉 20');
  await page.waitForTimeout(200);
  await page.click('#exp-submit');
  await page.waitForTimeout(600);
  const after3 = await page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem('nexus_wallet') || '{}');
    const pool = (w.cashAccounts || []).find(a => a.id === '__pool__') || {};
    return { n: (w.transactions || []).length, pool: Number(pool.amount || 0) };
  });
  console.log('    交易数 =', after3.n, '池余额 =', after3.pool);
  ok(after3.n === 2, '交易数不变（是改不是新增）', String(after3.n));
  ok(after3.pool === 2480, '回滚 8 再扣 20 → 2492+8-20 = 2480', String(after3.pool));
  ok(await page.$eval('#exp-submit', el => el.textContent.trim() === '记下'), '提交后按钮复位');

  // ============================================================ 6 今日页 C 入口
  console.log('\n【6】今日页入口（选项 C）');
  await page.click('.tab-item[data-panel="daily"]');
  await page.waitForTimeout(500);
  // 今日支出的区块默认是折叠的 → 先展开
  const collapsed = await page.$eval('#sec-expense', el => el.classList.contains('collapsed'));
  console.log('    sec-expense 初始折叠 =', collapsed);
  if (collapsed) {
    await page.click('#sec-expense > .section-header');
    await page.waitForTimeout(350);
  }
  ok(await page.isVisible('#daily-exp-input'), '今日页有记账输入框');
  ok(await page.isVisible('button:has-text("记下")'), '今日页有「记下」');

  // 关键回归：以前整块带 onclick=switchTab('data')，点输入框会被弹走
  const stillDaily = await page.$eval('#panel-daily', el => el.classList.contains('active'));
  ok(stillDaily, '点在输入框上不会把人弹去账本页');

  await page.fill('#daily-exp-input', '地铁 4');
  await page.waitForTimeout(300);
  const dprev = await page.$eval('#daily-exp-preview', el => el.classList.contains('show') ? el.innerText.replace(/\s+/g, ' ') : '');
  console.log('    今日页预览 =', dprev);
  ok(/交通/.test(dprev), '今日页识别成交通', dprev);
  ok(/4\.00/.test(dprev), '今日页识别出 4.00');

  await page.click('#daily-exp-input + button');
  await page.waitForTimeout(700);
  const after4 = await page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem('nexus_wallet') || '{}');
    const pool = (w.cashAccounts || []).find(a => a.id === '__pool__') || {};
    return { n: (w.transactions || []).length, pool: Number(pool.amount || 0), t0: (w.transactions || [])[0] };
  });
  console.log('    交易数 =', after4.n, '池余额 =', after4.pool);
  ok(after4.n === 3, '交易数 = 3');
  ok(after4.pool === 2476, '2480 − 4 = 2476', String(after4.pool));
  ok(after4.t0.category === '交通', '分类 = 交通');

  // 今日页小卡要立刻更新
  const dailyAmt = await page.$eval('#daily-expense-amt', el => el.textContent);
  console.log('    今日支出小卡 =', dailyAmt);
  ok(/24/.test(dailyAmt), '今日支出小卡 = 20+4 = 24', dailyAmt);
  ok(stillDaily, '记完仍在今日页（不跳走）');

  // ============================================================ 7 折叠
  console.log('\n【7】账本页折叠（用户要求「加一个能收起来的」）');
  await page.click('.tab-item[data-panel="data"]');
  await page.waitForTimeout(500);
  for (const [id, name] of [['sec-data-trend', '近 6 个月趋势'], ['sec-data-history', '交易记录'],
                            ['sec-data-calendar', '每日统计'], ['sec-data-journal-arch', '日记回顾'],
                            ['sec-data-ai', 'AI 报告']]) {
    const exists = await page.$('#' + id);
    ok(!!exists, name + ' 有折叠容器 #' + id);
    if (!exists) continue;
    const isCollapsed = await page.$eval('#' + id, el => el.classList.contains('collapsed'));
    ok(isCollapsed, name + ' 默认收起');
    // 折叠时内容必须不可见
    const contentHidden = await page.$eval('#' + id, el => {
      const kids = [...el.children].filter(c => !c.classList.contains('section-header'));
      return kids.every(k => getComputedStyle(k).display === 'none');
    });
    ok(contentHidden, name + ' 折叠时正文隐藏');
    // 头部触摸热区
    const hh = await page.$eval('#' + id + ' > .section-header', el => el.getBoundingClientRect().height);
    ok(hh >= 26, name + ' 头部热区 ≥26px', hh.toFixed(1) + 'px');
  }

  // 点一下能展开
  await page.click('#sec-data-trend > .section-header');
  await page.waitForTimeout(400);
  let nowCollapsed = await page.$eval('#sec-data-trend', el => el.classList.contains('collapsed'));
  ok(!nowCollapsed, '点标题后展开');
  const canvasVisible = await page.isVisible('#trend-chart');
  ok(canvasVisible, '展开后 trend-chart 可见');

  // 切换面板再回来，选择要留住
  await page.click('.tab-item[data-panel="daily"]');
  await page.waitForTimeout(400);
  await page.click('.tab-item[data-panel="data"]');
  await page.waitForTimeout(400);
  nowCollapsed = await page.$eval('#sec-data-trend', el => el.classList.contains('collapsed'));
  ok(!nowCollapsed, '切走再回来仍是展开（状态持久）');

  // 折叠时的角标
  const histCount = await page.$eval('#sec-data-history', el => {
    const b = el.querySelector('.sec-count-badge');
    return b ? b.textContent : '';
  });
  console.log('    交易记录角标 =', JSON.stringify(histCount));
  ok(/3/.test(histCount), '交易记录折叠时显示「3 笔」', histCount);

  // ============================================================ 8 数据管理折叠
  console.log('\n【8】我的 → 数据管理 折叠');
  await page.click('.tab-item[data-panel="settings"]');
  await page.waitForTimeout(500);
  const sdExist = await page.$('#sec-settings-data');
  ok(!!sdExist, '数据管理有折叠容器');
  if (sdExist) {
    ok(await page.$eval('#sec-settings-data', el => el.classList.contains('collapsed')), '数据管理默认收起');
    await page.click('#sec-settings-data > .section-header');
    await page.waitForTimeout(400);
    ok(!await page.$eval('#sec-settings-data', el => el.classList.contains('collapsed')), '点一下展开');
    const exportVisible = await page.isVisible('text=导出数据');
    ok(exportVisible, '展开后「导出数据」可见');
    const hh2 = await page.$eval('#sec-settings-data > .section-header', el => el.getBoundingClientRect().height);
    ok(hh2 >= 26, '数据管理头部热区 ≥26px', hh2.toFixed(1) + 'px');
  }

  // ============================================================ 9 手机端硬指标
  console.log('\n【9】手机端硬指标（430px）');
  for (const panel of ['daily', 'data', 'settings', 'inventory']) {
    await page.click(`.tab-item[data-panel="${panel}"]`);
    await page.waitForTimeout(400);
    const over = await page.evaluate(() => {
      const de = document.documentElement;
      if (de.scrollWidth <= de.clientWidth + 1) return null;
      // 找出溢出的元素，方便定位
      const bad = [];
      document.querySelectorAll('.panel.active *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > de.clientWidth + 1) {
          bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0]) + '@' + Math.round(r.right));
        }
      });
      return { sw: de.scrollWidth, cw: de.clientWidth, bad: bad.slice(0, 5) };
    });
    ok(!over, panel + ' 面板无横向溢出', over ? JSON.stringify(over) : '');
  }

  // 输入框字号必须 16px（iOS 下 <16px 会触发自动放大）
  await page.click('.tab-item[data-panel="data"]');
  await page.waitForTimeout(400);
  const fs = await page.$eval('#exp-input', el => getComputedStyle(el).fontSize);
  ok(parseFloat(fs) >= 16, '记账输入框字号 ≥16px（防 iOS 自动放大）', fs);

  // 根字号不能被动过
  const rootFs = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  ok(parseFloat(rootFs) === 16, '根字号仍是 16px', rootFs);

  // 提交按钮触摸目标
  const btnH = await page.$eval('#exp-submit', el => el.getBoundingClientRect().height);
  ok(btnH >= 40, '「记下」按钮高度 ≥40px', btnH.toFixed(1) + 'px');

  // ============================================================ 10 没有 JS 报错
  console.log('\n【10】运行期无报错');
  const realErrs = errs.filter(e => !/favicon|net::ERR|Failed to load resource|nexus_server|localhost:3458|ERR_CONNECTION/i.test(e));
  ok(realErrs.length === 0, '无未捕获 JS 错误', realErrs.slice(0, 4).join(' | '));

  console.log('\n============================');
  console.log('通过 %d / 失败 %d', pass, fail);
  if (fails.length) { console.log('\n失败明细:'); fails.forEach(f => console.log('  ✗ ' + f)); }

  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e); process.exit(2); });
