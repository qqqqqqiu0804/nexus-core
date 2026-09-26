// ==UserScript==
// @name         抖音视频地址探测（只观察，不下载）
// @namespace    nexus-core/dy-probe
// @version      1.0.0
// @description  看看在你的浏览器里能不能拿到视频真实地址 —— 决定自动下载方案是否可行
// @match        https://www.douyin.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * 为什么需要这个探测：
 *
 * 我在服务器上试了 yt-dlp / f2 / 手写 fetch，全部失败。
 * 最后发现根因是抖音对自动化环境弹滑块验证 —— 不是 cookie 问题。
 *
 * 那唯一可行的路就是「用你的浏览器抓」。
 * 但这条路的前提是：**你浏览器里能拿到视频的真实播放地址**。
 *
 * 这个脚本就是验证这个前提。它只观察，不下载、不修改任何东西。
 */

(function () {
  'use strict';

  const hits = [];       // 抓到的媒体响应
  const apis = [];       // 抓到的接口
  let box = null, bodyEl = null;

  // ---- 拦截 XHR ----
  const XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    const url = String(u || '');
    if (/aweme\/detail|play_addr|play\/|video\/|aweme\/v1\/play/i.test(url)) {
      apis.push({ t: 'xhr', url: url.slice(0, 150) });
      render();
    }
    this.addEventListener('load', function () {
      // 详情接口的返回里带 play_addr
      if (/aweme\/detail/i.test(url) && this.responseText) {
        try {
          const d = JSON.parse(this.responseText);
          const det = d && d.aweme_detail;
          if (det) {
            const pa = det.video && det.video.play_addr;
            if (pa && pa.url_list && pa.url_list.length) {
              hits.push({ kind: 'play_addr', url: pa.url_list[0].slice(0, 200) });
              render();
            }
          }
        } catch (e) {}
      }
    });
    return XO.apply(this, arguments);
  };

  // ---- 拦截 fetch ----
  if (window.fetch) {
    const F = window.fetch;
    window.fetch = function (input, init) {
      const url = String((input && input.url) || input || '');
      if (/aweme\/detail|play_addr|aweme\/v1\/play/i.test(url)) {
        apis.push({ t: 'fetch', url: url.slice(0, 150) });
        render();
      }
      return F.apply(this, arguments);
    };
  }

  // ---- 观察 video 元素 ----
  function scanVideos() {
    document.querySelectorAll('video').forEach(function (v) {
      const src = v.currentSrc || v.src;
      if (src && !hits.some(function (h) { return h.url === src; })) {
        hits.push({ kind: 'video元素', url: src.slice(0, 200) });
      }
      v.querySelectorAll('source').forEach(function (s) {
        if (s.src && !hits.some(function (h) { return h.url === s.src; })) {
          hits.push({ kind: 'source', url: s.src.slice(0, 200) });
        }
      });
    });
    render();
  }

  function render() {
    if (!box) return;
    box.querySelector('#__pbHits').innerHTML = hits.length
      ? hits.map(function (h) {
          return '<div style="margin:3px 0;font-size:11px;word-break:break-all">' +
            '<span style="color:#6ee7a8">[' + h.kind + ']</span> ' +
            '<span style="opacity:.8">' + h.url + '</span></div>';
        }).join('')
      : '<div style="opacity:.6;font-size:11px">还没抓到。请往下滑，让视频开始播放</div>';

    box.querySelector('#__pbApis').innerHTML = apis.length
      ? apis.slice(-8).map(function (a) {
          return '<div style="margin:2px 0;font-size:10px;opacity:.7;word-break:break-all">' +
            '[' + a.t + '] ' + a.url + '</div>';
        }).join('')
      : '<div style="opacity:.6;font-size:11px">还没抓到相关接口</div>';

    const el = box.querySelector('#__pbCount');
    if (el) {
      el.textContent = hits.length;
      el.style.color = hits.length ? '#6ee7a8' : '#94a3b8';
    }
  }

  function build() {
    box = document.createElement('div');
    box.id = '__dyProbe';
    box.style.cssText = [
      'position:fixed', 'right:10px', 'top:10px', 'z-index:2147483647',
      'width:330px', 'max-height:78vh', 'overflow:auto',
      'background:#0f172a', 'color:#e2e8f0',
      'border:1px solid #334155', 'border-radius:10px',
      'padding:10px', 'font:12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'box-shadow:0 8px 30px rgba(0,0,0,.5)',
    ].join(';');

    box.innerHTML =
      '<div style="font-weight:700;font-size:13px;margin-bottom:4px">🔍 视频地址探测</div>' +
      '<div style="font-size:11px;opacity:.7;margin-bottom:8px">' +
      '只观察，不下载。打开一个视频，往下滑让它播</div>' +
      '<div style="padding:6px;background:#1e293b;border-radius:6px;margin-bottom:6px">' +
      '<div style="font-weight:700">抓到 <span id="__pbCount">0</span> 个真实地址</div>' +
      '<div id="__pbHits"></div></div>' +
      '<div style="font-weight:700;font-size:11px;margin-bottom:2px;opacity:.8">相关接口</div>' +
      '<div id="__pbApis" style="max-height:140px;overflow:auto"></div>' +
      '<button id="__pbCopy" style="margin-top:8px;width:100%;padding:8px;border:0;' +
      'border-radius:6px;background:#16a34a;color:#fff;font-size:12px;font-weight:700;' +
      'cursor:pointer">📋 复制诊断结果</button>' +
      '<div id="__pbMsg" style="margin-top:5px;text-align:center;font-size:11px;opacity:.7"></div>';

    document.body.appendChild(box);

    box.querySelector('#__pbCopy').onclick = function () {
      const out = JSON.stringify({
        time: new Date().toISOString(),
        hits: hits,
        apis: apis,
        videoCount: document.querySelectorAll('video').length,
        pageUrl: location.href,
      }, null, 1);
      const msg = box.querySelector('#__pbMsg');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(out).then(function () {
          msg.textContent = '✅ 已复制，粘给我';
          msg.style.color = '#6ee7a8';
        }).catch(function () { showRaw(out, msg); });
      } else {
        showRaw(out, msg);
      }
    };

    function showRaw(t, msg) {
      msg.textContent = '复制失败，手动选中下面内容';
      const pre = document.createElement('pre');
      pre.style.cssText = 'margin-top:6px;padding:6px;background:#1e293b;border-radius:6px;' +
        'font-size:9px;white-space:pre-wrap;word-break:break-all;max-height:150px;overflow:auto';
      pre.textContent = t;
      box.appendChild(pre);
    }

    render();
  }

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);

  setInterval(scanVideos, 1500);

  window.__dyProbe = function () { return { hits: hits, apis: apis }; };
  window.__dyProbeScan = scanVideos;
})();
