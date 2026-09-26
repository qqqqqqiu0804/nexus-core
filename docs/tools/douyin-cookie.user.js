// ==UserScript==
// @name         抖音 cookie 提取（最小集 · 低风险）
// @namespace    nexus-core/dy-cookie
// @version      1.0.0
// @description  只提取下载音频所需的访客标识，不碰登录态
// @match        https://www.douyin.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 为什么只取这几个：
 *
 *   下载音频需要的是「一个新鲜的浏览器环境指纹」，
 *   不是「你的登录身份」。yt-dlp 和 f2 的报错原文都是
 *   「Fresh cookies (not necessarily logged in) are needed」——
 *   说的是"新鲜"，不是"已登录"。
 *
 *   所以只挑访客标识 + 设备指纹，**不导出 sessionid / passport 等登录凭证**。
 *   这样即使这份 cookie 泄露，别人也拿不到你的账号。
 *
 * 只要这几个：
 *   ttwid           —— 抖音最核心的访客标识，JS 生成的，服务器自己拿不到
 *   s_v_web_id      —— 验证指纹
 *   msToken         —— 反爬 token
 *   odin_tt         —— 设备标识
 *   tt_scid         —— 安全标识
 *   passport_csrf_token —— CSRF（非登录凭证）
 *   UIFID / UIFID_TEMP  —— 用户界面指纹
 */

(function () {
  'use strict';

  const WANT = [
    'ttwid',
    's_v_web_id',
    'msToken',
    'odin_tt',
    'tt_scid',
    'passport_csrf_token',
    'UIFID',
    'UIFID_TEMP',
  ];

  // 明确排除的（看到就报警，防止手滑带出去）
  const DANGER = [
    'sessionid',
    'sessionid_ss',
    'sid_tt',
    'passport_auth',
    'uid_tt',
    'sid_guard',
  ];

  function collect() {
    const all = {};
    document.cookie.split(';').forEach(function (s) {
      const i = s.indexOf('=');
      if (i < 0) return;
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim();
      all[k] = v;
    });

    const picked = {};
    WANT.forEach(function (k) {
      if (all[k]) picked[k] = all[k];
    });

    const leaked = DANGER.filter(function (k) { return all[k]; });

    // 拼成 Netscape cookie 文件格式（yt-dlp 要的格式）
    // 域必须是 .douyin.com，含子域
    const exp = Math.floor(Date.now() / 1000) + 86400 * 30;
    const lines = [
      '# Netscape HTTP Cookie File',
      '# 由 nexus-core 抖音脚本生成 —— 仅访客标识，不含登录凭证',
      '# 生成时间: ' + new Date().toISOString(),
    ];
    Object.keys(picked).forEach(function (k) {
      lines.push([
        '.douyin.com',   // domain
        'TRUE',          // include subdomains
        '/',             // path
        'FALSE',         // secure（TRUE/FALSE 都行）
        exp,             // expiry
        k,
        picked[k],
      ].join('\t'));
    });

    return {
      picked: picked,
      missing: WANT.filter(function (k) { return !all[k]; }),
      leaked: leaked,
      netscape: lines.join('\n') + '\n',
      total: Object.keys(all).length,
    };
  }

  function panel() {
    const old = document.getElementById('__dyck');
    if (old) old.remove();

    const r = collect();

    const box = document.createElement('div');
    box.id = '__dyck';
    box.style.cssText = [
      'position:fixed', 'left:12px', 'top:12px', 'z-index:2147483647',
      'width:340px', 'max-height:80vh', 'overflow:auto',
      'background:#0f172a', 'color:#e2e8f0',
      'border:1px solid #334155', 'border-radius:12px',
      'padding:12px', 'font:12px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'box-shadow:0 8px 32px rgba(0,0,0,.5)',
    ].join(';');

    const dangerHtml = r.leaked.length
      ? '<div style="margin-top:6px;padding:6px;background:#7f1d1d;border-radius:6px;color:#fecaca">' +
        '⚠️ 检测到登录凭证（已自动排除）：' + r.leaked.join(', ') + '</div>'
      : '';

    const missingHtml = r.missing.length
      ? '<div style="margin-top:6px;color:#fbbf24">还没生成的关键项：' + r.missing.join(', ') +
        '<br><span style="opacity:.75">（刷新一次页面通常就有了）</span></div>'
      : '';

    box.innerHTML =
      '<div style="font-weight:700;font-size:14px;margin-bottom:8px">🍪 抖音 cookie 提取</div>' +
      '<div style="opacity:.8">页面 cookie 共 <b>' + r.total + '</b> 项</div>' +
      '<div style="margin-top:6px;padding:8px;background:#1e293b;border-radius:6px">' +
      '<div style="color:#6ee7a8;font-weight:700;margin-bottom:4px">✅ 已提取（' +
      Object.keys(r.picked).length + ' 项）</div>' +
      Object.keys(r.picked).map(function (k) {
        return '<div style="opacity:.85">' + k +
          ' <span style="opacity:.5">长度 ' + r.picked[k].length + '</span></div>';
      }).join('') +
      '</div>' +
      missingHtml +
      dangerHtml +
      '<button id="__dyckCopy" style="margin-top:10px;width:100%;padding:10px;border:0;' +
      'border-radius:8px;background:#16a34a;color:#fff;font-size:13px;font-weight:700;cursor:pointer">' +
      '📋 复制 cookie 文件内容</button>' +
      '<div id="__dyckMsg" style="margin-top:6px;text-align:center;opacity:.7"></div>' +
      '<div style="margin-top:8px;font-size:11px;opacity:.55;line-height:1.5">' +
      '只含访客标识，不含账号登录凭证。<br>复制后直接整段发给我即可。</div>';

    document.body.appendChild(box);

    document.getElementById('__dyckCopy').onclick = function () {
      const t = r.netscape;
      const msg = document.getElementById('__dyckMsg');
      const done = function () {
        msg.textContent = '✅ 已复制 ' + t.length + ' 字符';
        msg.style.color = '#6ee7a8';
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(done).catch(function () { fallback(t, done); });
      } else {
        fallback(t, done);
      }
    };

    function fallback(t, done) {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) {
        const msg = document.getElementById('__dyckMsg');
        msg.textContent = '复制失败，请手动选中下面内容';
        const pre = document.createElement('pre');
        pre.style.cssText = 'margin-top:8px;padding:8px;background:#1e293b;border-radius:6px;' +
          'font-size:10px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto';
        pre.textContent = t;
        box.appendChild(pre);
        ta.remove();
      }
    }
  }

  // 等 body 出来再画
  if (document.body) {
    panel();
  } else {
    document.addEventListener('DOMContentLoaded', panel);
  }

  // 逃生舱：控制台可调
  window.__dyCookie = collect;
  window.__dyCookieShow = panel;
})();
