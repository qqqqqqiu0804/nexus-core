// ==UserScript==
// @name         抖音收藏夹导出（供 nexus-core 分析）
// @namespace    nexus-core
// @version      3.1.0
// @description  把抖音收藏夹列表导出成 JSON。只读，不收藏/不取消/不点赞。
// @author       nexus-core
// @match        https://www.douyin.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

/* ============================================================================
 * v3.1 改动（2026-09-26）：按接口分流 —— 修「193 条变 337 条」的根源
 *
 * 用户发现的问题：想抓「对自己好」（193 条）却抓到 337 条，
 * 且里面混着美食、追星、小说、游戏 —— 明显不是一个夹的内容。
 *
 * 我复盘出的原因：
 *   抖音「我的收藏」页面同时会打三类接口
 *     /aweme/v1/web/aweme/favorite/        ← 全部收藏混合流（所有夹混在一起）
 *     /aweme/v1/web/collects/list/         ← 收藏夹分组列表
 *     /aweme/v1/web/collects/video/list/   ← 某个分组内的视频
 *   v3.0 把三者返回的数据**全塞进同一个 items**，没记来源，
 *   于是「在混合流里滚动」收到的 337 条，被当成了「对自己好」的 193 条。
 *
 * v3.1 修法：
 *   1. 每次 absorb 都带上**当时的接口路径**，每条记录标注 `from`（来源接口）
 *   2. 导出时分两组：`items`（明确来自某个分组的）和 `mixed`（混合流来的）
 *   3. 面板上分开显示两个数字，用户一眼就知道自己的操作生效了没有
 *
 * 这样「点进分组再滚」和「在混合流里滚」的结果不会再混淆。
 * ========================================================================== */

(function () {
  'use strict';

  // 宽松匹配：宁可多记，不要漏记。真正的判断交给数据形态（见 absorb）
  const LOOSE = /\/aweme\/v1\/web\/[a-z0-9_/]*(collect|favorite|mix)[a-z0-9_/]*/i;

  const items = new Map();      // aweme_id -> 视频条目（**明确来自某个分组**）
  const mixed = new Map();      // aweme_id -> 视频条目（来自"全部收藏"混合流）
  const groups = new Map();     // 收藏夹分组（名字 -> {name, count}）
  let pageCount = 0;
  const seenApis = [];          // 最近见过的接口路径
  const hookState = { xhr: false, fetch: false, lastHit: '' };

  // v3.1：判断这个接口是不是「全部收藏混合流」
  // 混合流的特征是路径里是 favorite 但没有 collects（分组）
  function isMixedStream(path) {
    const p = String(path || '');
    if (!/favorite/i.test(p)) return false;
    if (/collects/i.test(p)) return false;   // 分组相关，不是混合流
    return true;
  }

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
    if (items.size || mixed.size) {
      // v3.1：两个数字分开显示，用户一眼看出自己是在分组里还是在混合流里
      main = '';
      if (items.size) {
        main += '分组内视频 <b style="color:#7dd3fc;font-size:15px">' +
                items.size + '</b> 条';
      }
      if (mixed.size) {
        if (main) main += '<br>';
        main += '<span style="color:#fbbf24">混合流 <b style="font-size:15px">' +
                mixed.size + '</b> 条</span>' +
                '<br><span style="opacity:.75;font-size:12px">' +
                '（混合流=全部收藏，不是某个分组；' +
                '要抓某个夹请<b>点进那个夹</b>）</span>';
      }
      if (pageCount) {
        main += '<br><span style="opacity:.55;font-size:12px">' +
                pageCount + ' 次响应</span>';
      }
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
  // v3.1：把 URL 归一成「路径」，用于判断来源接口
  function pathOf(url) {
    try {
      const s = String(url);
      const m = s.match(/^https?:\/\/[^/]+(\/[^?#]*)/);
      return m ? m[1] : (s.split('?')[0] || '');
    } catch (e) { return ''; }
  }

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

    // v3.1：先判断这条数据是从哪个接口来的，决定进哪个桶
    const path = pathOf(url);
    const target = isMixedStream(path) ? mixed : items;

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
        if (a && a.aweme_id && !target.has(a.aweme_id)) {
          // v3.1：每条都记下来源接口，导出的 JSON 里能看出是哪抓的
          a.__nexus_from = path || '(未知)';
          target.set(a.aweme_id, a);
          added++;
        }
      });
      if (added || list.some((a) => a && a.aweme_id)) {
        pageCount++;
        render(added ? '' : '<span style="opacity:.6">（本页都是重复的）</span>');
        const hm = data.has_more;
        const atEnd = (hm === 0 || hm === false);
        if (atEnd && (items.size || mixed.size)) {
          btnEl.style.display = 'block';
          btnEl.textContent = '导出 ' + (items.size + mixed.size) + ' 条';
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
  function toRow(a) {
    return {
      aweme_id: a.aweme_id,
      desc: String(a.desc || '').replace(/\s+/g, ' ').trim(),
      url: 'https://www.douyin.com/video/' + a.aweme_id,
      author: (a.author && (a.author.nickname || a.author.unique_id)) || '',
      duration_ms: (a.video && a.video.duration) || a.duration || 0,
      create_time: a.create_time || 0,
      aweme_type: a.aweme_type || a.media_type || '',
      digg_count: (a.statistics && a.statistics.digg_count) || 0,
      from: a.__nexus_from || '',          // v3.1：来源接口，便于分辨是哪个夹
    };
  }

  function exportNow() {
    // v3.1：分组内 / 混合流 分开导出，不再混在一起
    const grouped = [...items.values()].map(toRow);
    const mixedRows = [...mixed.values()].map(toRow);

    const payload = {
      exported_at: new Date().toISOString(),
      count: grouped.length + mixedRows.length,
      source: 'nexus-core-userscript',
      version: '3.1.0',
      groups: [...groups.values()],
      seen_apis: seenApis,
      // ⚠️ 两桶分开：别混着用
      grouped: grouped,     // 来自「某个收藏夹内部」，可用
      mixed: mixedRows,     // 来自「全部收藏」混合流，含各夹内容，需自行过滤
      // 兼容旧格式（下游按 items 读的不用改）
      items: grouped.length ? grouped : mixedRows,
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

    render('<span style="color:#6ee7a8">已导出：分组 ' + grouped.length +
           ' + 混合流 ' + mixedRows.length + ' → douyin-favorites.json</span>');
  }

  // 兜底入口（面板被关了也能导）
  window.__nexusDyExport = exportNow;
  window.__nexusDyStat = () => ({
    groupedItems: items.size, mixedItems: mixed.size,
    groups: [...groups.values()],
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
