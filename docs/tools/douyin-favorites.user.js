// ==UserScript==
// @name         抖音收藏夹导出（供 nexus-core 分析）
// @namespace    nexus-core
// @version      3.2.0
// @description  把抖音收藏夹列表导出成 JSON。只读，不收藏/不取消/不点赞。
// @author       nexus-core
// @match        https://www.douyin.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

/* ============================================================================
 * v3.2 改动（2026-09-26）：加「记录开关」—— 用户手动控制从哪一刻开始收
 *
 * 用户的原话：「要不你给加个开关吧，我进我想爬的收藏夹页面再开爬取」
 *
 * 为什么需要这个（v3.1 按接口名分流的方案失败了）：
 *   我以为「混合流」和「分组内」是不同的接口，按接口名就能分开。
 *   实测发现**同一个接口 /collects/video/list/ 两种场景都会调** ——
 *   在「全部收藏」滚动时，抖音内部也走这个接口。
 *   所以**接口名根本分不出来源，我的判断依据是错的**。
 *
 *   证据（用户第二次导出的文件）：
 *     grouped 323 条，from 全部是 /collects/video/list/
 *     但内容里仍混着「黄婷婷」追星 —— 显然不是「对自己好」这个夹。
 *
 * 所以改用**最可靠的那把尺子：用户自己**。
 *   - 默认 **不记录**（armed = false），页面滚动什么样都不收
 *   - 面板上一个按钮：「⏺ 开始记录」
 *   - 用户进到目标收藏夹、看到内容出来了，再点它
 *   - 按钮变成「⏹ 停止并导出」，收了 N 条一目了然
 *
 * 这样就不需要我猜抖音的接口语义了 —— 用户说从哪开始就从哪开始。
 *
 * 保留 v3.1 的分流信息（from 字段），但不再用它做"归属判断"，
 * 只作为参考线索留在导出里。
 * ========================================================================== */

(function () {
  'use strict';

  // 宽松匹配：宁可多记，不要漏记。真正的判断交给数据形态（见 absorb）
  const LOOSE = /\/aweme\/v1\/web\/[a-z0-9_/]*(collect|favorite|mix)[a-z0-9_/]*/i;

  const items = new Map();      // aweme_id -> 视频条目（**记录开关打开后收到的**）

  const groups = new Map();     // 收藏夹分组（名字 -> {name, count}）
  let pageCount = 0;
  const seenApis = [];          // 最近见过的接口路径
  const hookState = { xhr: false, fetch: false, lastHit: '' };

  // v3.2：记录开关。默认关 —— 用户点「开始记录」才开始收。
  let armed = false;

  // ⚠️ v3.1 曾用 isMixedStream() 按接口名判断数据归属 —— 实测**不可靠**：
  //    同一个 /collects/video/list/ 在「全部收藏」和「某个夹内」两种场景都会调。
  //    v3.2 已删除该判断，改用用户手动开关（见 armed）。
  //    这个教训留着：**别拿接口名当语义标签，接口名的语义比想象中含糊。**

  // ======================= 面板 =======================
  let box = null, bodyEl = null, btnEl = null, apiEl = null, armEl = null;

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

    // v3.2：记录开关 —— 面板上最显眼的按钮
    armEl = document.createElement('button');
    armEl.style.cssText = [
      'margin-top:10px', 'width:100%', 'padding:11px', 'border:0',
      'border-radius:8px', 'background:#16a34a', 'color:#fff',
      'font-size:13px', 'font-weight:700', 'cursor:pointer',
    ].join(';');
    armEl.onclick = toggleArm;

    apiEl = document.createElement('div');
    apiEl.style.cssText = [
      'margin-top:8px', 'padding-top:8px', 'border-top:1px solid #2c3038',
      'font:11px/1.5 ui-monospace,Consolas,monospace',
      'opacity:.62', 'word-break:break-all', 'max-height:76px', 'overflow:auto',
    ].join(';');

    btnEl = document.createElement('button');
    btnEl.style.cssText = [
      'margin-top:8px', 'width:100%', 'padding:10px', 'border:0',
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
    box.appendChild(armEl);      // 开关在数字下面、导出上面
    box.appendChild(apiEl);
    box.appendChild(btnEl);
    document.body.appendChild(box);
    render();
  }

  // v3.2：切换记录状态
  function toggleArm() {
    armed = !armed;
    if (armed) {
      // 开始记录：清空之前收到的（关键！否则还是在混）
      items.clear();

      pageCount = 0;
      btnEl.style.display = 'none';
      render('<span style="color:#6ee7a8">已开始记录 —— 现在收到的都算</span>');
    } else {
      // 停止：有数据就亮出导出按钮
      if (items.size) {
        btnEl.style.display = 'block';
        btnEl.textContent = '导出 ' + items.size + ' 条';
      }
      render('<span style="color:#fbbf24">已停止记录</span>');
    }
  }

  function render(note) {
    if (!bodyEl) return;
    const hooks = (hookState.xhr ? 'XHR ✅' : 'XHR ⏳') +
                  ' · ' + (hookState.fetch ? 'fetch ✅' : 'fetch ⏳');

    let main;

    // v3.2：开关状态是最重要的信息，放最上面
    if (armed) {
      main = '<span style="color:#6ee7a8;font-weight:700">⏺ 正在记录</span>' +
             '<br>已收到 <b style="color:#7dd3fc;font-size:17px">' + items.size +
             '</b> 条' +
             (pageCount ? '<span style="opacity:.55;font-size:12px">（' +
                          pageCount + ' 次响应）</span>' : '') +
             '<br><span style="opacity:.7;font-size:12px">' +
             '滚到底后点下面的按钮停止</span>';
    } else if (items.size) {
      main = '已收到 <b style="color:#7dd3fc;font-size:17px">' + items.size +
             '</b> 条 <span style="color:#fbbf24">（已停止）</span>' +
             '<br><span style="opacity:.7;font-size:12px">' +
             '要重新收就先点「重新开始记录」</span>';
    } else if (groups.size) {
      main = '<span style="opacity:.8">看到 ' + groups.size +
             ' 个收藏夹分组</span><br>' +
             '<span style="opacity:.8">→ <b>先点进你要的收藏夹</b>，' +
             '再点下面绿色按钮开始记录</span>';
    } else {
      main = '<span style="opacity:.85">还没开始记录</span><br>' +
             '<span style="opacity:.65;font-size:12px">' +
             '① 进「我的收藏」<br>② 点进你要的收藏夹<br>' +
             '③ 点下面的绿色按钮</span>';
    }

    // 按钮文字随状态变
    if (armEl) {
      armEl.textContent = armed
        ? '⏹ 停止记录'
        : (items.size ? '🔄 重新开始记录' : '⏺ 开始记录');
      armEl.style.background = armed ? '#dc2626' : '#16a34a';
    }

    bodyEl.innerHTML = main +
      '<br><span style="opacity:.45;font-size:11px">钩子：' + hooks + '</span>' +
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
    // v3.2：开关没开就只记接口名（给用户看），**不收数据**
    if (!armed) {
      // 还是解析一下，为了识别"看到了几个分组"给用户提示
      try {
        const d = JSON.parse(text);
        const arrs = [d && d.collect_list, d && d.collection_list]
          .filter(Array.isArray);
        for (const arr of arrs) {
          arr.forEach((g) => {
            if (!g || typeof g !== 'object') return;
            const name = g.name || g.title || g.collect_name;
            const cnt = g.count ?? g.aweme_count ?? g.total;
            if (name && (cnt !== undefined)) groups.set(String(name), { name: String(name), count: cnt });
          });
        }
        if (groups.size) render();
      } catch (e) {}
      return;
    }

    let data;
    try { data = JSON.parse(text); } catch (e) { return; }
    if (!data || typeof data !== 'object') return;

    // v3.1/v3.2：记下来源接口（仅作线索，不再拿它判断归属）
    const path = pathOf(url);
    const target = items;

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
    // v3.2：只有一个桶了，导出即"你开了开关之后收到的"
    const rows = [...items.values()].map(toRow);

    const payload = {
      exported_at: new Date().toISOString(),
      count: rows.length,
      source: 'nexus-core-userscript',
      version: '3.2.0',
      // 说明数据是怎么来的，便于以后回溯
      capture_note: '仅包含用户点击「开始记录」之后收到的数据',
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

  // 兜底入口（面板被关了也能用）
  window.__nexusDyExport = exportNow;
  window.__nexusDyArm = () => { armed = true; items.clear();
    pageCount = 0; render('已开始记录'); };
  window.__nexusDyDisarm = () => { armed = false; render('已停止记录'); };
  window.__nexusDyStat = () => ({
    armed, items: items.size, groups: [...groups.values()],
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
