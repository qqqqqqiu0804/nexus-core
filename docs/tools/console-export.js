/* ============================================================================
 * 抖音收藏夹导出 · 控制台版（不依赖篡改猴）
 *
 * 为什么有这个：篡改猴在你电脑上的站点权限出了问题（Edge 层拒绝，
 * 且篡改猴设置页里查不到拒绝记录）。折腾权限不划算 ——
 * 这个版本绕开扩展，直接在浏览器控制台里跑一次。
 *
 * 用法（60 秒）：
 *   1. 抖音网页版 → 打开「我的收藏」
 *   2. 按 F12 → 切到「控制台 / Console」标签
 *   3. 打开 docs/tools/console-export.js 全选复制 → 粘进控制台 → 回车
 *   4. 页面往下滚，点进一个收藏夹，滚到底
 *   5. 面板上会出现「导出 N 条」按钮，点它
 *
 * 只读。不收藏、不取消、不点赞、不发任何请求。
 * ========================================================================== */

(function () {
  'use strict';

  // 防止重复粘贴
  if (window.__nexusConsoleLoaded) {
    console.log('%c[nexus] 已经加载过了，不用再贴一次', 'color:#f59e0b');
    return;
  }
  window.__nexusConsoleLoaded = true;

  const LOOSE = /\/aweme\/v1\/web\/[a-z0-9_/]*(collect|favorite|mix)[a-z0-9_/]*/i;

  const items = new Map();
  const groups = new Map();
  let pageCount = 0;
  const seenApis = [];
  const hookState = { xhr: false, fetch: false };

  // ======================= 面板 =======================
  let box = null, bodyEl = null, btnEl = null, apiEl = null;

  function buildPanel() {
    if (box) return;
    if (!document.body) return;

    box = document.createElement('div');
    box.id = 'nexus-dy-export';
    box.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
      'background:#16181d', 'color:#e8eaed', 'padding:14px 16px 12px',
      'border-radius:12px', 'font:13px/1.65 -apple-system,"Segoe UI",sans-serif',
      'max-width:320px', 'min-width:250px',
      'box-shadow:0 8px 32px rgba(0,0,0,.45)',
      'border:1px solid #2c3038',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '收藏夹导出（控制台版）';
    title.style.cssText =
      'font-weight:700;font-size:14px;margin-bottom:7px;padding-right:18px;';

    bodyEl = document.createElement('div');

    apiEl = document.createElement('div');
    apiEl.style.cssText = [
      'margin-top:8px', 'padding-top:8px', 'border-top:1px solid #2c3038',
      'font:11px/1.5 ui-monospace,Consolas,monospace',
      'opacity:.62', 'word-break:break-all', 'max-height:76px', 'overflow:auto',
    ].join(';');

    btnEl = document.createElement('button');
    btnEl.style.cssText = [
      'margin-top:10px', 'width:100%', 'padding:10px', 'border:0',
      'border-radius:8px', 'background:#2f6fed', 'color:#fff',
      'font-size:13px', 'font-weight:600', 'cursor:pointer', 'display:none',
    ].join(';');
    btnEl.onclick = exportNow;

    const close = document.createElement('span');
    close.textContent = '✕';
    close.style.cssText = [
      'position:absolute', 'top:9px', 'right:12px', 'cursor:pointer',
      'opacity:.45', 'font-size:13px', 'line-height:1',
    ].join(';');
    close.onclick = () => { box.remove(); box = null; };

    box.appendChild(close);
    box.appendChild(title);
    box.appendChild(bodyEl);
    box.appendChild(apiEl);
    box.appendChild(btnEl);
    document.body.appendChild(box);
    render();
  }

  function render(note) {
    if (!bodyEl) return;
    const hooks = (hookState.xhr ? 'XHR ✅' : 'XHR ⏳') +
                  ' · ' + (hookState.fetch ? 'fetch ✅' : 'fetch ⏳');

    let main;
    if (items.size) {
      main = '视频 <b style="color:#7dd3fc;font-size:15px">' + items.size +
             '</b> 条' + (pageCount ? '（' + pageCount + ' 次响应）' : '');
    } else if (groups.size) {
      main = '发现 <b style="color:#fbbf24;font-size:15px">' + groups.size +
             '</b> 个收藏夹分组<br>' +
             '<span style="opacity:.8">需要<b>点进某个收藏夹</b>才能拿到视频</span>';
    } else {
      main = '<span style="opacity:.8">还没收到收藏夹数据</span><br>' +
             '<span style="opacity:.6;font-size:12px">请往下滚一屏</span>';
    }

    bodyEl.innerHTML = main +
      '<br><span style="opacity:.55;font-size:12px">钩子：' + hooks + '</span>' +
      (note ? '<br><span style="font-size:12px">' + note + '</span>' : '');

    apiEl.innerHTML = seenApis.length
      ? '最近接口：<br>' + seenApis.slice(-4).map(escapeHtml).join('<br>')
      : '最近接口：（暂无）';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  // ======================= 收集 =======================
  function noteApi(url) {
    let short = '';
    try {
      const s = String(url);
      const m = s.match(/^https?:\/\/[^/]+(\/[^?#]*)/);
      short = m ? m[1] : (s.split('?')[0] || s);
      if (short && short[0] !== '/') short = '/' + short;
    } catch (e) {
      short = String(url || '').slice(0, 80);
    }
    if (!short) return;
    if (!seenApis.includes(short)) {
      seenApis.push(short);
      if (seenApis.length > 12) seenApis.shift();
    }
  }

  function absorb(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return; }
    if (!data || typeof data !== 'object') return;

    // ---- 形态 A：视频列表 ----
    let list = data.aweme_list;
    if (!Array.isArray(list) && Array.isArray(data.data)) list = data.data;
    if (!Array.isArray(list) && data.data && Array.isArray(data.data.aweme_list)) {
      list = data.data.aweme_list;
    }

    if (Array.isArray(list) && list.length) {
      let added = 0;
      list.forEach((a) => {
        if (a && a.aweme_id && !items.has(a.aweme_id)) {
          items.set(a.aweme_id, a);
          added++;
        }
      });
      if (added || list.some((a) => a && a.aweme_id)) {
        pageCount++;
        render(added ? '' : '<span style="opacity:.6">（本页都是重复的）</span>');
        const hm = data.has_more;
        const atEnd = (hm === 0 || hm === false);
        if (atEnd && items.size) {
          btnEl.style.display = 'block';
          btnEl.textContent = '导出 ' + items.size + ' 条';
          render('<span style="color:#6ee7a8">已到底部，可以导出了</span>');
        }
        return;
      }
    }

    // ---- 形态 B：收藏夹分组 ----
    const arrs = [data.collect_list, data.collection_list, data.data, data.list]
      .filter(Array.isArray);
    for (const arr of arrs) {
      arr.forEach((g) => {
        if (!g || typeof g !== 'object') return;
        const name = g.name || g.title || g.collect_name;
        const cnt = g.count ?? g.aweme_count ?? g.total;
        if (name && (cnt !== undefined)) {
          groups.set(String(name), { name: String(name), count: cnt });
        }
      });
    }
    if (groups.size) render();
  }

  // ---------------- 钩子 1：XHR ----------------
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__nexusHit = LOOSE.test(String(url || ''));
      if (this.__nexusHit) noteApi(String(url));
    } catch (e) {}
    return XO.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (this.__nexusHit) {
      hookState.xhr = true;
      render();
      this.addEventListener('load', () => {
        try { absorb(this.responseText); } catch (e) {}
      });
    }
    return XS.apply(this, arguments);
  };

  // ---------------- 钩子 2：fetch ----------------
  const OF = window.fetch;
  if (typeof OF === 'function') {
    window.fetch = function (input) {
      let url = '';
      try {
        url = (typeof input === 'string') ? input : (input && input.url) || '';
      } catch (e) {}
      const hit = LOOSE.test(url);
      if (hit) { noteApi(url); hookState.fetch = true; render(); }
      const p = OF.apply(this, arguments);
      if (hit) {
        p.then((res) => {
          try {
            res.clone().text().then((t) => absorb(t)).catch(() => {});
          } catch (e) {}
        }).catch(() => {});
      }
      return p;
    };
  }

  // ======================= 导出 =======================
  function exportNow() {
    const rows = [...items.values()].map((a) => ({
      aweme_id: a.aweme_id,
      desc: String(a.desc || '').replace(/\s+/g, ' ').trim(),
      url: 'https://www.douyin.com/video/' + a.aweme_id,
      author: (a.author && (a.author.nickname || a.author.unique_id)) || '',
      duration_ms: (a.video && a.video.duration) || a.duration || 0,
      create_time: a.create_time || 0,
      aweme_type: a.aweme_type || a.media_type || '',
      digg_count: (a.statistics && a.statistics.digg_count) || 0,
    }));

    const payload = {
      exported_at: new Date().toISOString(),
      count: rows.length,
      source: 'nexus-core-console',
      version: '1.0.0',
      groups: [...groups.values()],
      seen_apis: seenApis,
      items: rows,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'douyin-favorites.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);

    render('<span style="color:#6ee7a8">已导出 ' + rows.length +
           ' 条 → douyin-favorites.json</span>');
  }

  window.__nexusDyExport = exportNow;
  window.__nexusDyStat = () => ({
    items: items.size, groups: [...groups.values()],
    apis: seenApis, hooks: hookState,
  });

  // ======================= 启动 =======================
  buildPanel();
  // 单页应用路由切换时 body 可能被重建，补上
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (tries > 60) return clearInterval(timer);
    if (document.body && !document.getElementById('nexus-dy-export')) buildPanel();
  }, 1000);

  console.log('%c[nexus] 收藏夹导出已启动（控制台版）',
    'color:#6ee7a8;font-weight:700');
  console.log('  · 面板在页面右下角');
  console.log('  · 命令：__nexusDyStat() 看状态、__nexusDyExport() 手动导出');
  console.log('  · 只读，不发任何写请求');
})();
