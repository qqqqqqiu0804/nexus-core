// ==UserScript==
// @name         抖音收藏夹导出（供 nexus-core 分析）
// @namespace    nexus-core
// @version      3.0.0
// @description  把抖音收藏夹列表导出成 JSON。只读，不收藏/不取消/不点赞。
// @author       nexus-core
// @match        https://www.douyin.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

/* ============================================================================
 * v3 改动（2026-09-26）：从「弹不出来」改成「一定弹得出来」
 *
 * 用户反馈：脚本装上了（篡改猴显示已启用），但页面上没面板。
 *
 * 我复盘出三个问题，v3 逐条修：
 *
 *   问题 1：面板只在「判定为收藏夹页面」时才建。
 *           判定失败 = 面板完全不出现 = 用户以为脚本没生效，
 *           而我拿不到任何线索。**这是设计错误：把失败伪装成"没反应"。**
 *     → v3：面板**任何 douyin.com 页面都建**，只是内容分状态显示。
 *           判定不准时用户至少能看到"我在，但还没看到收藏夹数据"。
 *
 *   问题 2：不给用户看到"捕获到了什么接口"。
 *           用户只能看到数字不涨，没法告诉我卡在哪。
 *     → v3：面板上实时显示**最近捕获到的接口路径**（脱敏，只留路径）。
 *           这样用户截个图给我，我立刻知道该匹配哪个名字。
 *
 *   问题 3：只认 `listcollection` 一个路径。
 *           但用户的收藏夹是**分组式**的（一堆收藏夹封面卡片，
 *           比如"猛学 404 / 大学计算机 249"），
 *           这种页面调的接口和「某个收藏夹内的视频列表」不是同一个。
 *     → v3：改成**宽松匹配**（只要路径里含 collect/favorite 就记下来），
 *           并区分"分组列表"和"视频列表"两种数据形态，都能吃。
 *
 * 仍然不变的原则：**不自己算签名、不碰 cookie、只读。**
 * ========================================================================== */

(function () {
  'use strict';

  // 宽松匹配：宁可多记，不要漏记。真正的判断交给数据形态（见 absorb）
  const LOOSE = /\/aweme\/v1\/web\/[a-z0-9_/]*(collect|favorite|mix)[a-z0-9_/]*/i;

  const items = new Map();      // aweme_id -> 视频条目
  const groups = new Map();     // 收藏夹分组（名字 -> {name, count}）
  let pageCount = 0;
  const seenApis = [];          // 最近见过的接口路径
  const hookState = { xhr: false, fetch: false, lastHit: '' };

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
    title.textContent = '收藏夹导出';
    title.style.cssText = 'font-weight:700;font-size:14px;margin-bottom:7px;padding-right:18px;';

    bodyEl = document.createElement('div');
    bodyEl.style.cssText = '';

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
             '<span style="opacity:.6;font-size:12px">请进「我的收藏」并往下滚</span>';
    }

    bodyEl.innerHTML = main +
      '<br><span style="opacity:.55;font-size:12px">钩子：' + hooks + '</span>' +
      (note ? '<br><span style="font-size:12px">' + note + '</span>' : '');

    // 把见过的接口路径亮出来 —— 出问题时用户截图给我，我立刻能定位
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
    // 不用 new URL(相对路径, base) —— 那个依赖 location.origin 有值。
    // 真实浏览器里它一定有，但没必要为一个纯展示字段担这个风险：
    // 直接从字符串里抠路径即可（本身就是绝对 URL）。
    let short = '';
    try {
      const s = String(url);
      const m = s.match(/^https?:\/\/[^/]+(\/[^?#]*)/);
      short = m ? m[1] : (s.split('?')[0] || s);
      // 兜底：万一传进来是相对路径
      if (short && short[0] !== '/') short = '/' + short;
    } catch (e) {
      short = String(url || '').slice(0, 80);
    }
    if (!short) return;
    if (!seenApis.includes(short)) {
      seenApis.push(short);
      if (seenApis.length > 12) seenApis.shift();
    }
    hookState.lastHit = short;
  }

  function absorb(text, url) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return; }
    if (!data || typeof data !== 'object') return;

    // ---- 形态 A：视频列表 ----
    // 已知字段名：aweme_list（收藏夹内视频）/ data（部分接口）
    let list = data.aweme_list;
    if (!Array.isArray(list) && Array.isArray(data.data)) list = data.data;
    // 兼容 data 是对象且有 aweme_list 的嵌套形态
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

    // ---- 形态 B：收藏夹分组列表 ----
    // 兜底：从任意数组里找"看着像收藏夹"的对象
    // （有 name/title + 有 count/aweme_count 这类字段）
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
      this.addEventListener('load', () => {
        try { absorb(this.responseText, this.responseURL || ''); } catch (e) {}
      });
    }
    return XS.apply(this, arguments);
  };

  // ---------------- 钩子 2：fetch ----------------
  const OF = window.fetch;
  if (typeof OF === 'function') {
    window.fetch = function (input, init) {
      let url = '';
      try {
        url = (typeof input === 'string') ? input : (input && input.url) || '';
      } catch (e) {}
      const hit = LOOSE.test(url);
      if (hit) noteApi(url);
      const p = OF.apply(this, arguments);
      if (hit) {
        p.then((res) => {
          try {
            res.clone().text().then((t) => absorb(t, url)).catch(() => {});
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
      source: 'nexus-core-userscript',
      version: '3.0.0',
      groups: [...groups.values()],   // 顺带把分组信息也带上
      seen_apis: seenApis,            // 便于排查
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

  // 兜底入口（面板被关了也能导）
  window.__nexusDyExport = exportNow;
  window.__nexusDyStat = () => ({
    items: items.size, groups: [...groups.values()],
    apis: seenApis, hooks: hookState,
  });

  // ======================= 启动 =======================
  // v3：不再"判定失败就不建面板"。任何 douyin.com 页面都建，
  // 只是内容会告诉你当前处于哪个状态。
  function boot() { buildPanel(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 单页应用：路由切换不刷新。面板建好后若被移除（body 重建），重试补上。
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (tries > 60) return clearInterval(timer);
    if (document.body && !document.getElementById('nexus-dy-export')) buildPanel();
  }, 1000);
})();
