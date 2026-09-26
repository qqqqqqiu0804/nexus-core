// ==UserScript==
// @name         抖音收藏夹采集（列表 + 视频地址）
// @namespace    nexus-core/dy-collect
// @version      4.0.0
// @description  进收藏夹滚动，采集条目元信息 + 视频播放地址，导出给服务器跑 ASR
// @author       nexus-core
// @match        https://www.douyin.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/* ============================================================================
 * v4.0（2026-09-26）：在 v3.2 基础上加「视频地址采集」
 *
 * 为什么需要采集地址（这是被现实逼出来的设计）：
 *   抖音对服务器 IP 做了风控（滑块验证），服务器**不可能**自己拿到视频。
 *   实测过：yt-dlp 403、f2（签名合法）403、手写 fetch 挂死。
 *   只有「真实浏览器里页面自己发的请求」能拿到数据（200）。
 *
 *   所以在用户的浏览器里采集地址，导出后交给服务器下载 ——
 *   这是我们能走的唯一一条干净路子，不做任何对抗。
 *
 * ⚠️ CDN 地址有时效（通常几小时）。
 *    采完尽快交给我处理，别隔夜。
 *
 * 保留 v3.2 的「记录开关」——用户手动控制从哪一刻开始收。
 *
 * 只读：不收藏、不取消收藏、不点赞、不修改任何数据。
 * ==========================================================================*/

(function () {
  'use strict';

  // ---- v3.2 的记录开关 ----
  const items = new Map();     // aweme_id → 条目（含 play_url）
  const groups = new Map();    // 分组名 → 数量
  const seenApis = new Set();
  let armed = false;
  let pageCount = 0;
  let box = null, bodyEl = null, btnEl = null, armEl = null, msgEl = null;

  // ---------- 从响应里抽条目 ----------
  function normItem(a) {
    if (!a || typeof a !== 'object') return null;
    const id = String(a.aweme_id || a.awemeId || a.id || '');
    if (!id) return null;

    const desc = String(a.desc || a.title || '').trim();
    const author = (a.author && (a.author.nickname || a.author.unique_id)) ||
                   a.nickname || a.author_name || '';
    const dur = a.video && (a.video.duration || a.duration) ||
                a.duration || 0;

    // ★ 视频地址：从多个可能的位置提取
    let playUrl = '';
    const v = a.video || {};
    // 优先级：play_addr > download_addr > bit_rate 里挑一个
    const cands = [
      v.play_addr && v.play_addr.url_list,
      v.download_addr && v.download_addr.url_list,
      v.bit_rate && v.bit_rate[0] && v.bit_rate[0].play_addr &&
        v.bit_rate[0].play_addr.url_list,
    ];
    for (const list of cands) {
      if (Array.isArray(list) && list.length) {
        // 优先 https，优先 douyinvod（流媒体域名）
        const sorted = list.slice().sort(function (x, y) {
          const sx = (/^https:/.test(x) ? 2 : 0) + (/douyinvod/.test(x) ? 1 : 0);
          const sy = (/^https:/.test(y) ? 2 : 0) + (/douyinvod/.test(y) ? 1 : 0);
          return sy - sx;
        });
        playUrl = sorted[0];
        if (playUrl) break;
      }
    }

    return {
      aweme_id: id,
      desc: desc,
      author: String(author),
      duration_ms: Math.round(Number(dur) * 1000) || 0,
      create_time: Number(a.create_time || 0),
      digg_count: Number(a.digg_count || 0),
      aweme_type: String(a.aweme_type || ''),
      play_url: playUrl,
      url: 'https://www.douyin.com/video/' + id,
    };
  }

  // ---------- 收数据 ----------
  function absorb(text, apiPath) {
    if (!armed) {
      // 没开开关：只记分组名给用户看
      try {
        const d = JSON.parse(text);
        const arrs = [d && d.collect_list, d && d.collection_list]
          .filter(Array.isArray);
        for (const arr of arrs) {
          arr.forEach(function (g) {
            if (!g || typeof g !== 'object') return;
            const name = g.name || g.title || g.collect_name;
            const cnt = g.count ?? g.aweme_count ?? g.total;
            if (name && cnt !== undefined) {
              groups.set(String(name), { name: String(name), count: cnt });
            }
          });
        }
        if (groups.size) render();
      } catch (e) {}
      return;
    }

    let added = 0;
    try {
      const d = JSON.parse(text);
      const pool = [];
      const push = function (v) { if (v && typeof v === 'object') pool.push(v); };

      [d.aweme_list, d.awemeList, d.collect_list, d.data, d.items]
        .forEach(function (a) { if (Array.isArray(a)) a.forEach(push); });

      if (d.aweme_detail) push(d.aweme_detail);
      if (d.aweme_details && Array.isArray(d.aweme_details)) d.aweme_details.forEach(push);

      // 有些响应把条目埋在 cell_data 里
      if (Array.isArray(d.cell_data)) {
        d.cell_data.forEach(function (c) {
          if (c && c.aweme) push(c.aweme);
        });
      }

      pool.forEach(function (raw) {
        const n = normItem(raw);
        if (!n) return;
        if (items.has(n.aweme_id)) {
          // 已有：只有补上 play_url 才更新（地址可能这次才拿到）
          const old = items.get(n.aweme_id);
          if (!old.play_url && n.play_url) { items.set(n.aweme_id, n); added++; }
          return;
        }
        items.set(n.aweme_id, n);
        added++;
      });
      pageCount++;
      if (added) render();
    } catch (e) {}
  }

  // ---------- 拦截 XHR ----------
  const XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    const url = String(u || '');
    if (this.addEventListener) {
      this.addEventListener('load', function () {
        if (!/douyin\.com/.test(url)) return;
        try {
          const p = new URL(url, location.origin).pathname;
          seenApis.add(p);
        } catch (e) {}
        // 采集目标：列表接口 + 详情接口
        if (/aweme\/(detail|favorite)|collects\/(video\/)?list|aweme\/v1\/web\/aweme\/post/i
              .test(url)) {
          absorb(this.responseText || '', url);
        }
      });
    }
    return XO.apply(this, arguments);
  };

  // ---------- 拦截 fetch ----------
  if (window.fetch) {
    const F = window.fetch;
    window.fetch = function (input, init) {
      const url = String((input && input.url) || input || '');
      const p = F.apply(this, arguments);
      if (/aweme\/(detail|favorite)|collects\/list/.test(url)) {
        p.then(function (res) {
          res.clone().text().then(function (t) { absorb(t, url); }).catch(function () {});
        }).catch(function () {});
      }
      return p;
    };
  }

  // ---------- 面板 ----------
  function render() {
    if (!msgEl) return;
    const withUrl = [...items.values()].filter(function (i) { return i.play_url; }).length;

    if (armed) {
      msgEl.innerHTML =
        '<span style="color:#6ee7a8;font-weight:700">⏺ 正在采集</span><br>' +
        '条目 <b style="color:#7dd3fc;font-size:17px">' + items.size + '</b> 条<br>' +
        '<span style="color:' + (withUrl > 0 ? '#6ee7a8' : '#fbbf24') + '">' +
        '含播放地址 <b>' + withUrl + '</b> 条' +
        (withUrl === 0 ? '<br><span style="font-size:11px;opacity:.8">' +
          '要让视频开始播才有地址，往下滑</span>' : '') +
        '</span><br>' +
        '<span style="font-size:11px;opacity:.6">已处理 ' + pageCount + ' 批</span>';
    } else if (items.size) {
      msgEl.innerHTML =
        '已有 <b>' + items.size + '</b> 条 <span style="color:#fbbf24">（未在采集）</span>';
    } else if (groups.size) {
      msgEl.innerHTML =
        '看到 ' + groups.size + ' 个收藏夹<br>' +
        '<span style="opacity:.8">→ 先点进要采的夹，再点绿色按钮</span>';
    } else {
      msgEl.innerHTML =
        '<span style="opacity:.85">还没开始</span><br>' +
        '<span style="opacity:.6;font-size:11px">' +
        '① 进「我的收藏」<br>② 点进要的收藏夹<br>③ 点绿色按钮<br>' +
        '④ 往下滑，让视频都播一遍</span>';
    }

    if (btnEl) {
      const n = items.size;
      const w = withUrl;
      btnEl.style.display = n ? 'block' : 'none';
      btnEl.textContent = '导出 ' + n + ' 条' + (w ? '（' + w + ' 条有地址）' : '');
    }
    if (armEl) {
      armEl.textContent = armed ? '⏹ 停止采集'
        : (items.size ? '🔄 重新开始' : '⏺ 开始采集');
      armEl.style.background = armed ? '#dc2626' : '#16a34a';
    }
  }

  function toggleArm() {
    armed = !armed;
    if (armed) {
      items.clear();
      pageCount = 0;
      if (btnEl) btnEl.style.display = 'none';
    }
    render();
  }

  function build() {
    box = document.createElement('div');
    box.id = '__dyCollect';
    box.style.cssText = [
      'position:fixed', 'right:10px', 'top:10px', 'z-index:2147483647',
      'width:290px', 'background:#0f172a', 'color:#e2e8f0',
      'border:1px solid #334155', 'border-radius:12px', 'padding:12px',
      'font:13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'box-shadow:0 8px 32px rgba(0,0,0,.5)',
    ].join(';');

    box.innerHTML =
      '<div style="font-weight:700;font-size:14px;margin-bottom:6px">' +
      '📥 收藏夹采集 v4</div>' +
      '<div id="__dcMsg" style="margin-bottom:8px;font-size:12px"></div>' +
      '<button id="__dcArm" style="width:100%;padding:11px;border:0;border-radius:8px;' +
      'background:#16a34a;color:#fff;font-size:13px;font-weight:700;cursor:pointer">' +
      '⏺ 开始采集</button>' +
      '<button id="__dcExport" style="display:none;margin-top:8px;width:100%;padding:11px;' +
      'border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:13px;' +
      'font-weight:700;cursor:pointer">导出</button>' +
      '<div id="__dcNote" style="margin-top:8px;font-size:11px;opacity:.6;line-height:1.5">' +
      '① 进收藏夹 → ② 点开始 → ③ 往下滑让视频播 → ④ 导出<br>' +
      '<span style="color:#fbbf24">地址有时效，导出后尽快给我</span></div>';

    document.body.appendChild(box);
    msgEl = box.querySelector('#__dcMsg');
    btnEl = box.querySelector('#__dcExport');
    armEl = box.querySelector('#__dcArm');

    armEl.onclick = toggleArm;
    btnEl.onclick = function () {
      const rows = [...items.values()];
      const payload = {
        exported_at: new Date().toISOString(),
        count: rows.length,
        with_url: rows.filter(function (r) { return r.play_url; }).length,
        source: 'nexus-core-collect',
        version: '4.0.0',
        note: 'CDN 地址有时效，尽快处理',
        groups: [...groups.values()],
        seen_apis: [...seenApis],
        items: rows,
      };
      const text = JSON.stringify(payload, null, 1);
      const done = function () {
        const n = box.querySelector('#__dcNote');
        n.innerHTML = '<span style="color:#6ee7a8">✅ 已复制 ' + rows.length +
          ' 条（' + payload.with_url + ' 条含地址），粘给我</span>';
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () { fallback(text); });
      } else { fallback(text); }

      function fallback(t) {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); }
        catch (e) {
          const pre = document.createElement('pre');
          pre.style.cssText = 'margin-top:8px;padding:6px;background:#1e293b;' +
            'border-radius:6px;font-size:9px;white-space:pre-wrap;' +
            'word-break:break-all;max-height:150px;overflow:auto';
          pre.textContent = t;
          box.appendChild(pre);
          ta.remove();
        }
      }
    };

    render();
  }

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);

  // 逃生舱
  window.__dyCollect = function () { return [...items.values()]; };
  window.__dyCollectArm = function () { if (!armed) toggleArm(); };
  window.__dyCollectDisarm = function () { if (armed) toggleArm(); };
  window.__dyCollectStat = function () {
    return {
      armed: armed,
      items: items.size,
      withUrl: [...items.values()].filter(function (i) { return i.play_url; }).length,
      groups: groups.size,
      apis: [...seenApis],
    };
  };
})();
