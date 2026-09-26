/* ============================================================================
 * 抖音收藏夹导出脚本 —— 在抖音收藏夹页面的浏览器控制台里运行
 *
 * 用法：
 *   1. 电脑 Edge 打开抖音 → 登录 → 进「我的收藏」→ 往下滚几屏
 *   2. F12 → Console（控制台）
 *   3. 把本文件全部内容粘进去 → 回车
 *   4. 它会在页面上显示一个进度浮层，完成后自动下载 douyin-favorites.json
 *
 * 原理：不自己算签名、不碰 cookie。
 *       抖音网页自己会调收藏夹接口，我们只是把这个接口的返回结果截下来。
 *       所以它用的是页面自己的登录态和签名，服务端看不出区别。
 *
 * 只读：本脚本不调用任何写接口（不收藏、不取消、不点赞）。
 * ========================================================================== */
(function () {
  'use strict';

  // ---- 找收藏夹接口：抖音翻页时会反复调它，我们把响应截下来 ----
  const MATCH = /\/aweme\/v1\/web\/aweme\/listcollection\//;

  const items = new Map();   // aweme_id -> 条目，自动去重
  let pages = 0;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  // ---- 先铺一个浮层，让你看得见它在干活 ----
  const box = document.createElement('div');
  box.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
    'background:#111', 'color:#fff', 'padding:12px 16px', 'border-radius:10px',
    'font:13px/1.6 -apple-system,"Segoe UI",sans-serif', 'max-width:300px',
    'box-shadow:0 6px 24px rgba(0,0,0,.4)',
  ].join(';');
  box.textContent = '收藏夹导出：等待接口响应…（请在页面上往下滚动）';
  document.body.appendChild(box);
  const say = (t) => { box.innerHTML = t; };
  const done = (t) => { box.innerHTML = t; setTimeout(() => box.remove(), 20000); };

  // ---- 挂钩 XHR，截获收藏夹接口的返回 ----
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__isFav = MATCH.test(url || '');
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (this.__isFav) {
      this.addEventListener('load', () => {
        try {
          const data = JSON.parse(this.responseText);
          const list = data.aweme_list || [];
          list.forEach((a) => {
            if (a && a.aweme_id) items.set(a.aweme_id, a);
          });
          pages++;
          const hasMore = data.has_more;
          say(
            '已捕获 <b>' + items.size + '</b> 条（第 ' + pages + ' 页）<br>' +
            (hasMore
              ? '继续往下滚，加载更多…'
              : '<span style="color:#4ade80">已到底部</span> → 点下方按钮导出')
          );
          if (!hasMore && items.size) addButton();
        } catch (e) { /* 非 JSON 响应，忽略 */ }
      });
    }
    return origSend.apply(this, arguments);
  };

  // ---- 导出按钮 ----
  function addButton() {
    if (box.querySelector('button')) return;
    const b = document.createElement('button');
    b.textContent = '导出 ' + items.size + ' 条';
    b.style.cssText = [
      'margin-top:10px', 'width:100%', 'padding:9px', 'border:0',
      'border-radius:7px', 'background:#2563eb', 'color:#fff',
      'font-size:13px', 'font-weight:600', 'cursor:pointer',
    ].join(';');
    b.onclick = exportNow;
    box.appendChild(b);
  }

  // ---- 真正导出：只留用得上的字段，别把整个对象塞给你 ----
  function exportNow() {
    const rows = [...items.values()].map((a) => ({
      aweme_id: a.aweme_id,
      desc: (a.desc || '').replace(/\s+/g, ' ').trim(),
      url: 'https://www.douyin.com/video/' + a.aweme_id,
      author: (a.author && (a.author.nickname || a.author.unique_id)) || '',
      duration_ms: (a.video && a.video.duration) || a.duration || 0,
      create_time: a.create_time || 0,
      // 收藏夹里可能混了图文/图集，标注出来方便后面过滤
      type: a.aweme_type || a.media_type || '',
      digg_count: (a.statistics && a.statistics.digg_count) || 0,
    }));

    const payload = {
      exported_at: new Date().toISOString(),
      count: rows.length,
      source: 'douyin-collection-console',
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

    done('<b>已导出 ' + rows.length + ' 条</b><br>' +
         '文件：douyin-favorites.json<br>' +
         '<span style="opacity:.7">放到桌面然后告诉我</span>');
  }

  // ---- 兜底：手动导出（万一下拉加载被拦） ----
  window.__dyFavExport = exportNow;
  window.__dyFavCount = () => items.size;

  say('收藏夹导出：已挂好监听。请<b>在页面上往下滚动</b>，加载收藏列表。');
})();
