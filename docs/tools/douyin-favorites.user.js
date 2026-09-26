// ==UserScript==
// @name         抖音收藏夹导出（供 nexus-core 分析）
// @namespace    nexus-core
// @version      2.0.0
// @description  把抖音收藏夹列表导出成 JSON。只读，不收藏/不取消/不点赞。
// @author       nexus-core
// @match        https://www.douyin.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

/* ============================================================================
 * 为什么用篡改猴而不是控制台粘贴
 *
 *   控制台粘贴有两个问题：
 *     1. 刷新页面就没了，中途刷新要重新粘
 *     2. 抖音页面上有一堆自己的报错（比如 imapi 那类 CORS 报错），
 *        粘进去的代码容易被淹没、也容易误判成"我们的脚本坏了"
 *   篡改猴在 document-start 就注入，刷新自动重跑，且有自己的面板区分状态。
 *
 * ----------------------------------------------------------------------------
 * ⚠️ 技术难点与对策（这是我实测踩出来的，不是抄的）
 *
 * 难点：抖音的收藏夹接口带一层反爬（ArgusSecurityPlugin），
 *       它要求 URL 上有 a_bogus 签名、header 里有 UIFID。
 *       **我不会自己算签名** —— 算了也大概率算错（签名要匹配当前时刻的
 *       浏览器环境，网上那些查表法的映射表都停在 2024 年初，早失效了）。
 *
 * 对策：**不自己发请求，只截获页面自己发的请求。**
 *       抖音页面自己会调 listcollection 接口，它算的签名一定是对的。
 *       我们挂两个钩子把它的返回抄下来即可：
 *         1. XMLHttpRequest.prototype.open/send  —— 页面用的是 XHR
 *         2. window.fetch                          —— 万一它改用 fetch
 *       两个都挂上，不管页面用哪个都能截到。
 *
 * 难点二：抖音的请求可能走 Web Worker 或 iframe，钩子挂不到。
 *       对策：@noframes 明确只在主框架跑 + 同时挂 XHR 和 fetch 两条路，
 *             并在面板上如实显示"已挂 XHR / 已挂 fetch"的状态，
 *             一个都没触发就说明是第三种情况，需要换方案（不会让你瞎猜）。
 *
 * 难点三：翻页是"滚动加载"，没有"下一页"按钮可点。
 *       对策：脚本不主动翻页（主动翻页要和签名打架），
 *             而是在面板上提示你"往下滚"，你滚它就收。
 *             滚到底出现"导出"按钮。
 * ========================================================================== */

(function () {
  'use strict';

  // 收藏夹接口的两个可能路径（PC 端 web / 移动端 web）
  const MATCH = /\/aweme\/v1\/web\/aweme\/(listcollection|collect\/list)\//i;

  const items = new Map();     // aweme_id -> 条目，自动去重
  let pageCount = 0;
  let sawXHR = false;
  let sawFetch = false;
  let lastHasMore = null;

  // ======================= 面板 =======================
  let box = null;
  let bodyEl = null;
  let btnEl = null;

  function buildPanel() {
    if (box || !document.body) return;
    box = document.createElement('div');
    box.id = 'nexus-dy-export';
    box.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
      'background:#16181d', 'color:#e8eaed', 'padding:14px 16px',
      'border-radius:12px', 'font:13px/1.65 -apple-system,"Segoe UI",sans-serif',
      'max-width:310px', 'min-width:260px',
      'box-shadow:0 8px 32px rgba(0,0,0,.45)',
      'border:1px solid #2c3038', 'user-select:none',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '收藏夹导出';
    title.style.cssText = 'font-weight:700;font-size:14px;margin-bottom:6px;';

    bodyEl = document.createElement('div');
    bodyEl.style.cssText = 'opacity:.92;';

    btnEl = document.createElement('button');
    btnEl.textContent = '导出';
    btnEl.style.cssText = [
      'margin-top:11px', 'width:100%', 'padding:10px', 'border:0',
      'border-radius:8px', 'background:#2f6fed', 'color:#fff',
      'font-size:13px', 'font-weight:600', 'cursor:pointer',
      'display:none',
    ].join(';');
    btnEl.onclick = exportNow;

    const close = document.createElement('span');
    close.textContent = '✕';
    close.style.cssText = [
      'position:absolute', 'top:9px', 'right:12px', 'cursor:pointer',
      'opacity:.45', 'font-size:13px', 'line-height:1',
    ].join(';');
    close.onclick = () => box.remove();

    box.style.position = 'fixed';
    box.appendChild(close);
    box.appendChild(title);
    box.appendChild(bodyEl);
    box.appendChild(btnEl);
    document.body.appendChild(box);
    render();
  }

  function render(extra) {
    if (!bodyEl) return;
    const hooks = [];
    hooks.push(sawXHR ? 'XHR ✅' : 'XHR ⏳');
    hooks.push(sawFetch ? 'fetch ✅' : 'fetch ⏳');
    bodyEl.innerHTML =
      '已捕获 <b style="color:#7dd3fc;font-size:15px">' + items.size + '</b> 条' +
      (pageCount ? '（' + pageCount + ' 页）' : '') + '<br>' +
      '<span style="opacity:.6;font-size:12px">钩子：' + hooks.join(' · ') + '</span>' +
      (extra ? '<br><span style="opacity:.75">' + extra + '</span>' : '');
  }

  // ======================= 收集 =======================
  function absorb(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return; }
    if (!data || typeof data !== 'object') return;

    const list = data.aweme_list || data.data || [];
    if (!Array.isArray(list)) return;

    let added = 0;
    list.forEach((a) => {
      if (a && a.aweme_id && !items.has(a.aweme_id)) {
        items.set(a.aweme_id, a);
        added++;
      }
    });
    pageCount++;

    // has_more 可能是 0/1 或 true/false
    const hm = data.has_more;
    lastHasMore = (hm === 0 || hm === false) ? false
                : (hm === 1 || hm === true) ? true
                : null;

    if (lastHasMore === false && items.size > 0) {
      btnEl.style.display = 'block';
      btnEl.textContent = '导出 ' + items.size + ' 条';
      render('<span style="color:#6ee7a8">已到底部，可以导出了</span>');
    } else {
      render('继续往下滚动，加载更多…' + (added ? '' : '（本页无新增）'));
    }
  }

  // ---------------- 钩子 1：XHR ----------------
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__nexusFav = MATCH.test(String(url || '')); } catch (e) {}
    return XO.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (this.__nexusFav) {
      sawXHR = true;
      this.addEventListener('load', () => {
        try { absorb(this.responseText); } catch (e) {}
      });
    }
    return XS.apply(this, arguments);
  };

  // ---------------- 钩子 2：fetch ----------------
  const OF = window.fetch;
  if (typeof OF === 'function') {
    window.fetch = function (input, init) {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      const hit = MATCH.test(url);
      const p = OF.apply(this, arguments);
      if (hit) {
        sawFetch = true;
        p.then((res) => {
          // 克隆一份读，不干扰页面自己的消费
          try {
            res.clone().text().then(absorb).catch(() => {});
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
      // 收藏夹里可能混图文/图集，标出来方便后面过滤
      aweme_type: a.aweme_type || a.media_type || '',
      digg_count: (a.statistics && a.statistics.digg_count) || 0,
    }));

    const payload = {
      exported_at: new Date().toISOString(),
      count: rows.length,
      source: 'nexus-core-userscript',
      version: '2.0.0',
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
           ' 条 → douyin-favorites.json</span><br>' +
           '<span style="opacity:.6;font-size:12px">放到桌面，然后告诉我</span>');
  }

  // 兜底：面板被误关了也能导出
  window.__nexusDyExport = exportNow;

  // ======================= 启动 =======================
  // 只在收藏夹相关页面显示面板，别在抖音首页上乱弹
  function isCollectionPage() {
    const h = location.href;
    if (/collection|collect|favorite|my\/self/i.test(h)) return true;
    // 路径判断不到时，看页面有没有"收藏"标题
    const t = (document.title || '') + (document.body ? document.body.innerText.slice(0, 400) : '');
    return /收藏/.test(t);
  }

  function boot() {
    if (!document.body) return;
    if (isCollectionPage()) {
      buildPanel();
      render('请<b>在页面上往下滚动</b>，我会自动收集');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 抖音是单页应用，路由切换不会刷新页面 —— 监听变化再试一次
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (tries > 40) return clearInterval(timer);
    if (!box && isCollectionPage()) {
      buildPanel();
      render('请<b>在页面上往下滚动</b>，我会自动收集');
    }
  }, 1000);
})();
