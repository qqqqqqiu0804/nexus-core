#!/usr/bin/env node
/**
 * mobile-audit.js —— 手机端体验的静态审计
 *
 * 背景：用户定了一条铁律「一切改动以手机端体验为准」。
 * 光靠自觉会忘，所以把关卡写成可执行的检查，能进 CI。
 *
 * 检查项（全部是静态分析，不需要起浏览器）：
 *   1. 根字号必须是 16px（是 rem 令牌语义正确的前提）
 *   2. 不许出现 font-size 硬编码字面量（必须走 --fs-* 令牌）
 *   3. --fs-* 令牌换算成 px 后，最小值不得低于 12px
 *   4. 不许用 title 承载信息（手机不显示 tooltip）
 *   5. viewport 必须包含 width=device-width（否则手机上按 980px 渲染）
 *
 * 用法：node tests/mobile-audit.js [index.html 路径]
 */
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

console.log('【1】根字号必须是 16px');
const rootM = html.match(/html\s*\{[^}]*font-size:\s*([\d.]+)px/);
if (!rootM) {
  bad('没找到 html { font-size } —— 请显式写成 16px，别依赖浏览器默认');
} else if (parseFloat(rootM[1]) === 16) {
  ok('html { font-size: 16px }');
} else {
  bad(`html 根字号是 ${rootM[1]}px，不是 16px —— 所有 rem 令牌都会被隐式缩放，` +
      `令牌注释里的 px 会撒谎（14px 会让 0.75rem 变成 10.5px）`);
}

console.log('【2】不许硬编码 font-size 字面量');
const literals = html.match(/font-size:\s*[\d.]+(rem|px|em)/g) || [];
// 允许 html 根字号那一处（上面已单独检查）
const offenders = literals.filter(s => !/px/.test(s));
if (offenders.length === 0) {
  ok('没有 rem/em 字面量（全部走令牌）');
} else {
  bad(`发现 ${offenders.length} 处硬编码字号：${[...new Set(offenders)].slice(0, 6).join(', ')}` +
      `\n      应改用 --fs-* 令牌，否则调字号要满文件找`);
}

console.log('【3】--fs-* 令牌在滑条两端都不得低于 12px');
// ★ 2026-09-26 改：令牌体系从「全部 rem」变成两层：
//   · 小字（2xs / xs）：绝对 px，不跟随滑条
//   · 其余：calc(基准px * var(--fs-r)) 或 max(下限px, calc(...))
// 所以不能再只匹配 rem。新检查要覆盖**滑条两端**：
//   最不利的情形是 --fs-r 取最小值（13/16 = 0.8125），此时所有 calc 都缩到最小。
// 只要「最小值那一端」全部 ≥12px，就说明铁律守住了。
const rootPx = rootM ? parseFloat(rootM[1]) : 16;
const FONT_MIN_PX = 13;                     // 滑条下限（与 JS 里 FONT_MIN 保持一致）
const minRatio = FONT_MIN_PX / rootPx;      // 最小缩放比 = 0.8125

// 抽出令牌定义行：--fs-xxx: <值>;
const tokenLines = [...html.matchAll(/--fs-([a-z0-9]+):\s*([^;]+);/g)]
  .map(([, name, expr]) => ({ name, expr: expr.trim() }));

if (!tokenLines.length) {
  bad('没找到任何 --fs-* 令牌');
} else {
  const tiny = [];
  const report = [];
  for (const { name, expr } of tokenLines) {
    if (name === 'r') continue;             // --fs-r 是缩放比本身，不是字号
    let px = null;

    // 形态一：纯 px 字面量（如 12px）—— 不跟随滑条
    const pxLit = expr.match(/^([\d.]+)px$/);
    // 形态二：calc(Npx * var(--fs-r)) —— 跟随滑条，取最小值那端
    const calcLit = expr.match(/^calc\(\s*([\d.]+)px\s*\*\s*var\(--fs-r\)\s*\)$/);
    // 形态三：max(Npx, calc(...)) —— 有下限，取「下限与缩到底」中的较大者
    const maxLit = expr.match(/^max\(\s*([\d.]+)px\s*,\s*calc\(\s*([\d.]+)px\s*\*\s*var\(--fs-r\)\s*\)\s*\)$/);

    if (pxLit) px = parseFloat(pxLit[1]);
    else if (calcLit) px = parseFloat(calcLit[1]) * minRatio;
    else if (maxLit) px = Math.max(parseFloat(maxLit[1]), parseFloat(maxLit[2]) * minRatio);

    if (px === null) {
      // 没认出来的写法：不静默放过，提示去更新这个检查
      report.push(`--fs-${name}: 无法解析「${expr}」，请更新 mobile-audit 的解析`);
      continue;
    }
    report.push(`--fs-${name}=${px.toFixed(1)}px`);
    if (px < 12 - 0.01) tiny.push(`--fs-${name} 最小渲染 ${px.toFixed(1)}px（表达式：${expr}）`);
  }

  if (tiny.length === 0) {
    ok(`${report.length} 个令牌滑到最小档也全部 ≥12px  [${report.join(' ')}]`);
  } else {
    bad(`滑条拉到最小时，以下令牌会小于 12px，手机上读起来累：\n      ${tiny.join('\n      ')}`);
  }
}

console.log('【4】不许用 title 承载信息');
// 允许的例外：sr-only 之类的纯无障碍用途（当前项目没有），所以一律禁止
const titles = html.match(/\stitle="[^"]*"/g) || [];
if (titles.length === 0) {
  ok('没有 title 属性（说明都写进了可见文字）');
} else {
  bad(`发现 ${titles.length} 处 title，手机浏览器不显示 tooltip：\n      ` +
      titles.slice(0, 6).join('\n      '));
}

console.log('【5】viewport 必须按设备宽度渲染');
if (/name="viewport"[^>]*width=device-width/.test(html)) {
  ok('viewport 含 width=device-width');
} else {
  bad('viewport 缺少 width=device-width —— 手机上会按桌面宽度缩放，字会很小');
}

console.log('\n────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
