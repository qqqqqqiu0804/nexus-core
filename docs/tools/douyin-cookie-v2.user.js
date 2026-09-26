// ==UserScript==
// @name         抖音 cookie 提取 v2（突破 HttpOnly）
// @namespace    nexus-core/dy-cookie-v2
// @version      2.0.0
// @description  用 GM_cookie 读 HttpOnly cookie —— document.cookie 读不到 ttwid
// @match        https://www.douyin.com/*
// @run-at       document-idle
// @grant        GM_cookie
// @grant        GM.cookie
// @grant        GM_setClipboard
// @connect      douyin.com
// ==/UserScript==

/*
 * ★ v1 为什么失败（2026-09-26 实测确认）
 *
 * `document.cookie` 读不到 ttwid，因为它是 HttpOnly：
 *
 *   ttwid    httpOnly=true
 *   odin_tt  httpOnly=true
 *
 * HttpOnly 是浏览器层面的硬限制 —— 网页 JS 永远读不到，等多久都没用。
 * v1 拿到的 4 项（s_v_web_id / passport_csrf_token / UIFID / UIFID_TEMP）
 * 恰好全是非 HttpOnly 的，而最关键的 ttwid 缺席，下载必然失败。
 *
 * ★ v2 怎么解决
 *
 * 篡改猴是浏览器扩展，可以用 GM_cookie API 读到 HttpOnly cookie。
 * 这是唯一在「不需要用户手动操作」前提下拿到 ttwid 的正规途径。
 *
 * 安全：仍然只导出访客标识，登录凭证（sessionid 等）即使能读也不取。
 */

(function () {
  'use strict';

  // 要取的：访客标识
  const WANT = [
    'ttwid',                 // ★ 最核心，HttpOnly
    'odin_tt',               // ★ HttpOnly
    'msToken',
    's_v_web_id',
    'tt_scid',
    'passport_csrf_token',
    'UIFID',
    'UIFID_TEMP',
    '__ac_nonce',
    '__ac_signature',
  ];

  // 绝不导出的：登录凭证（即使 GM_cookie 能读到）
  const DANGER = [
    'sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt', 'sid_guard',
    'passport_auth', 'passport_assist_user', 'passport_auth_status',
    'sid_ucp_v1', 'ssid_ucp_v1', 'login_time', 'store-region',
  ];

  // GM_cookie 有两种调用风格，都要兼容
  //   老版: GM_cookie.list({domain}, cb)
  //   新版: GM.cookie.list({domain})  → Promise
  function cookieList() {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof GM_cookie !== 'undefined' && GM_cookie && GM_cookie.list) {
          GM_cookie.list({ domain: '.douyin.com' }, function (cookies, err) {
            if (err) return reject(new Error(String(err)));
            resolve(cookies || []);
          });
          return;
        }
        if (typeof GM !== 'undefined' && GM.cookie && GM.cookie.list) {
          GM.cookie.list({ domain: '.douyin.com' }).then(resolve).catch(reject);
          return;
        }
        reject(new Error('当前环境没有 GM_cookie 权限'));
      } catch (e) { reject(e); }
    });
  }

  function setClipboard(text) {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof GM_setClipboard !== 'undefined') {
          GM_setClipboard(text, 'text');
          return resolve();
        }
      } catch (e) { /* 落到下面 */ }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(resolve).catch(reject);
        return;
      }
      reject(new Error('没有可用的剪贴板 API'));
    });
  }

  function buildNetscape(picked) {
    const exp = Math.floor(Date.now() / 1000) + 86400 * 30;
    const lines = [
      '# Netscape HTTP Cookie File',
      '# nexus-core v2 —— 含 HttpOnly 访客标识，不含登录凭证',
      '# 生成时间: ' + new Date().toISOString(),
    ];
    Object.keys(picked).forEach(function (k) {
      lines.push([
        '.douyin.com', 'TRUE', '/', 'FALSE', exp, k, picked[k],
      ].join('\t'));
    });
    return lines.join('\n') + '\n';
  }

  async function collect() {
    let cookies = [];
    let err = '';
    try {
      cookies = await cookieList();
    } catch (e) {
      err = e.message || String(e);
    }

    // 兜底：document.cookie（能拿到非 HttpOnly 的部分）
    const fromDoc = {};
    document.cookie.split(';').forEach(function (s) {
      const i = s.indexOf('=');
      if (i > 0) fromDoc[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    });

    const picked = {};
    const httpOnlyGot = [];
    let leaked = [];

    // 先从 GM_cookie 取（含 HttpOnly）
    cookies.forEach(function (c) {
      if (WANT.indexOf(c.name) >= 0) {
        picked[c.name] = c.value;
        if (c.httpOnly) httpOnlyGot.push(c.name);
      }
      if (DANGER.indexOf(c.name) >= 0) leaked.push(c.name);
    });

    // 再用 document.cookie 补（GM_cookie 万一不可用）
    WANT.forEach(function (k) {
      if (!picked[k] && fromDoc[k]) picked[k] = fromDoc[k];
    });

    const missing = WANT.filter(function (k) { return !picked[k]; });

    return {
      picked: picked,
      httpOnlyGot: httpOnlyGot,
      missing: missing,
      leaked: leaked,
      netscape: buildNetscape(picked),
      total: cookies.length,
      gmOk: !err,
      gmErr: err,
    };
  }

  async function panel() {
    const old = document.getElementById('__dyck2');
    if (old) old.remove();

    const r = await collect();

    const box = document.createElement('div');
    box.id = '__dyck2';
    box.style.cssText = [
      'position:fixed', 'left:12px', 'top:12px', 'z-index:2147483647',
      'width:340px', 'max-height:82vh', 'overflow:auto',
      'background:#0f172a', 'color:#e2e8f0',
      'border:1px solid #334155', 'border-radius:12px',
      'padding:12px',
      'font:12px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'box-shadow:0 8px 32px rgba(0,0,0,.5)',
    ].join(';');

    const gmStatus = r.gmOk
      ? '<div style="color:#6ee7a8">✅ GM_cookie 可用（读到 ' + r.total + ' 项）</div>'
      : '<div style="color:#f87171">❌ GM_cookie 不可用：' + r.gmErr +
        '<br><span style="opacity:.75">只能拿到非 HttpOnly 部分，ttwid 会缺</span></div>';

    const haveTtwid = !!r.picked.ttwid;
    const ttwidLine = haveTtwid
      ? '<div style="color:#6ee7a8;font-weight:700">✅ ttwid 已拿到（长度 ' +
        r.picked.ttwid.length + '）← 下载的关键</div>'
      : '<div style="color:#f87171;font-weight:700">❌ ttwid 没拿到 —— 下载会失败</div>';

    const dangerHtml = r.leaked.length
      ? '<div style="margin-top:6px;padding:6px;background:#7f1d1d;border-radius:6px;color:#fecaca">' +
        '⚠️ 检测到登录凭证（已自动排除，不会导出）：' + r.leaked.join(', ') + '</div>'
      : '';

    const missingHtml = r.missing.length
      ? '<div style="margin-top:6px;color:#fbbf24">未获取：' + r.missing.join(', ') +
        '<br><span style="opacity:.75">（非关键的可以忽略；ttwid 必须有）</span></div>'
      : '';

    box.innerHTML =
      '<div style="font-weight:700;font-size:14px;margin-bottom:8px">🍪 抖音 cookie 提取 v2</div>' +
      gmStatus +
      '<div style="margin-top:8px;padding:8px;background:#1e293b;border-radius:6px">' +
      ttwidLine +
      '<div style="margin-top:6px;opacity:.85">已取 ' + Object.keys(r.picked).length +
      ' 项：' + Object.keys(r.picked).join(', ') + '</div>' +
      (r.httpOnlyGot.length
        ? '<div style="opacity:.7;font-size:11px">其中 HttpOnly（v1 拿不到的）：' +
          r.httpOnlyGot.join(', ') + '</div>'
        : '') +
      '</div>' +
      missingHtml + dangerHtml +
      '<button id="__dyck2Copy" style="margin-top:10px;width:100%;padding:10px;border:0;' +
      'border-radius:8px;background:' + (haveTtwid ? '#16a34a' : '#b45309') + ';color:#fff;' +
      'font-size:13px;font-weight:700;cursor:pointer">' +
      (haveTtwid ? '📋 复制 cookie 文件内容' : '⚠️ ttwid 缺失，仍要复制') + '</button>' +
      '<div id="__dyck2Msg" style="margin-top:6px;text-align:center;opacity:.7"></div>' +
      '<button id="__dyck2Re" style="margin-top:6px;width:100%;padding:8px;border:1px solid #475569;' +
      'border-radius:8px;background:transparent;color:#94a3b8;font-size:12px;cursor:pointer">' +
      '🔄 重新读取（等页面加载完再试）</button>' +
      '<div style="margin-top:8px;font-size:11px;opacity:.55;line-height:1.5">' +
      '只含访客标识，登录凭证即使读到也不导出。</div>';

    document.body.appendChild(box);

    document.getElementById('__dyck2Copy').onclick = async function () {
      const msg = document.getElementById('__dyck2Msg');
      try {
        await setClipboard(r.netscape);
        msg.textContent = '✅ 已复制 ' + r.netscape.length + ' 字符，粘给我即可';
        msg.style.color = '#6ee7a8';
      } catch (e) {
        msg.textContent = '复制失败，已显示在下方';
        msg.style.color = '#f87171';
        const pre = document.createElement('pre');
        pre.style.cssText = 'margin-top:8px;padding:8px;background:#1e293b;border-radius:6px;' +
          'font-size:10px;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto';
        pre.textContent = r.netscape;
        box.appendChild(pre);
      }
    };

    document.getElementById('__dyck2Re').onclick = function () { panel(); };
  }

  if (document.body) {
    setTimeout(panel, 800);   // 给 JS 一点时间写 cookie
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(panel, 800); });
  }

  // 逃生舱
  window.__dyCookie2 = collect;
  window.__dyCookie2Show = panel;
})();
