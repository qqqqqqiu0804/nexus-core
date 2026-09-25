#!/usr/bin/env node
/**
 * chess-ui.test.js —— 象棋界面视觉层的静态回归
 *
 * 背景：棋盘 UI 在重构时连踩三个布局坑（百分比高度循环依赖、绝对定位百分比偏移、
 * SVG 替换元素内禀比例），每一个都是「静态看代码完全正常，一进浏览器就错」。
 * 光靠注释挡不住，所以把关键约束写成可执行断言，进 CI。
 *
 * 这些断言不是「有没有写某行 CSS」，而是「几何约束成不成立」——
 * 比如从 padding 和棋子宽度反推边距够不够，从 aspect-ratio 反推格距比是多少。
 * 这样即使有人重写这段 CSS，只要几何仍正确，测试就不会误报。
 *
 * 用法：node tests/chess-ui.test.js [index.html 路径]
 */
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

// 把 CSS 和 JS 分开处理，各自去注释。
// 不要对整份 HTML 直接跑 /\/\*[\s\S]*?\*\//g —— CSS 里存在未配对的 /* 或 *\/ 序列时，
// 非贪婪匹配会跨过 </style> 边界把后面的 JS 一起吃掉，函数体整个消失（这个测试栽过）。
function stripBlockComment(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const a = s.indexOf('/*', i);
    if (a < 0) { out += s.slice(i); break; }
    const b = s.indexOf('*/', a + 2);
    if (b < 0) { out += s.slice(i); break; }
    out += s.slice(i, a);
    i = b + 2;
  }
  return out;
}
const styleBlock = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/) || [, ''])[1];
const scriptBlock = (html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/) || [, ''])[1];
// CSS：去块注释。JS：去 // 行注释和 /* */ 块注释
const css = stripBlockComment(styleBlock);
const js = stripBlockComment(scriptBlock).replace(/^[ \t]*\/\/.*$/gm, '');
// code = 去注释后的全文，供跨 CSS/JS 的检查使用
const code = css + '\n' + js;

// 取某个选择器的规则体（只匹配第一条，够用且避免误伤 @media 里的同名）
function rule(sel) {
  const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  return m ? m[1] : null;
}
// 从规则体里取某个属性的数值（去注释）
function prop(body, name) {
  if (!body) return null;
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = clean.match(new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)'));
  return m ? m[1].trim() : null;
}
// 取 aspect-ratio 的比值 W:H
function aspectRatio(body) {
  const v = prop(body, 'aspect-ratio');
  if (!v) return null;
  const m = v.match(/([\d.]+)\s*\/\s*([\d.]+)/);
  return m ? parseFloat(m[1]) / parseFloat(m[2]) : null;
}
// 取 padding: a b c 形式，返回 [top, right, bottom, left]
function padding4(body) {
  const v = prop(body, 'padding');
  if (!v) return null;
  const parts = v.split(/\s+/).map(s => parseFloat(s));
  if (parts.some(isNaN)) return null;
  if (parts.length === 4) return parts;
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  return null;
}
// 取百分比宽度
function pct(body, name) {
  const v = prop(body, name);
  if (!v) return null;
  const m = v.match(/([\d.]+)%/);
  return m ? parseFloat(m[1]) : null;
}

console.log('【1】棋盘必须用 flex 撑满坐标面（防三个布局坑复发）');
const board = rule('.xq-board');
const plane = rule('.xq-plane');
if (/\bdisplay:\s*flex\b/.test(board || '')) {
  ok('.xq-board 是 flex 容器');
} else {
  bad('.xq-board 不是 flex —— 坐标面会退回百分比高度/绝对定位，' +
      '触发 aspect-ratio × 百分比 padding 的循环依赖，0 行棋子会被上边框切掉半个');
}
if (/\bflex:\s*1\b/.test(plane || '')) {
  ok('.xq-plane 用 flex:1 撑满内容盒');
} else {
  bad('.xq-plane 没有 flex:1 —— 坐标面尺寸不确定，网格与棋子会整体错位');
}
if (/position:\s*absolute/.test(plane || '')) {
  bad('.xq-plane 又用上绝对定位了 —— 绝对定位的百分比偏移解析基准是 padding box，' +
      '与棋盘外框不一致，实测偏差 6px 并导致棋子被切');
} else {
  ok('.xq-plane 不是绝对定位（避开百分比偏移解析基差的坑）');
}

console.log('【2】网格 SVG 必须显式给定宽高');
const svgRule = rule('.xq-plane > svg') || rule('.xq-plane>svg');
const svgW = prop(svgRule || '', 'width');
const svgH = prop(svgRule || '', 'height');
if (svgW === '100%' && svgH === '100%') {
  ok('.xq-plane > svg 显式 width/height: 100%');
} else {
  bad(`SVG 没显式给定宽高（width=${svgW}, height=${svgH}）—— SVG 是替换元素有内禀比例，
      只给 inset 它会按 viewBox 自己算高度（实测矮 45px），网格线与棋子整体错位`);
}

console.log('【3】网格线颜色不得写在 SVG 表现属性里');
// 表现属性在 Edge/Safari 上解析不了 CSS 变量，会把 stroke 判成 none
const badStroke = (code.match(/stroke="(?!none|currentColor)[^"]*"/g) || [])
  .filter(s => /var\(/.test(s));
if (badStroke.length === 0) {
  ok('没有把 CSS 变量写进 stroke 属性');
} else {
  bad(`发现 ${badStroke.length} 处 stroke="var(...)" —— Edge/Safari 解析不了会把整条线丢掉，` +
      `棋盘会变白板：${badStroke.slice(0, 3).join(', ')}`);
}
// 反向验证：xqGridSvg 必须用 class 而不是内联 stroke
const gridFn = js.match(/function xqGridSvg\(\)[\s\S]*?\n\}/);
if (gridFn && /class="xq-groove"/.test(gridFn[0]) && /class="xq-ridge"/.test(gridFn[0])) {
  ok('xqGridSvg() 用 class 挂色（xq-groove / xq-ridge）');
} else {
  bad('xqGridSvg() 没有用 class="xq-groove" / class="xq-ridge" 挂色 —— ' +
      '若改成内联 stroke，Edge/Safari 会把线丢掉');
}
if (/\.xq-groove\s*\{/.test(code) && /\.xq-ridge\s*\{/.test(code)) {
  ok('刻痕双层类 .xq-groove / .xq-ridge 都在 CSS 里有定义');
} else {
  bad('缺 .xq-groove 或 .xq-ridge 的 CSS 规则 —— xqGridSvg() 用的是这两个类，没规则就等于没线');
}

console.log('【4】几何约束：棋子不得溢出棋盘');
const pad = padding4(board || '');
const pieceW = pct(rule('.xq-p') || '', 'width');
if (!pad || pieceW == null) {
  bad(`取值失败（padding=${JSON.stringify(pad)}, 棋子宽=${pieceW}）`);
} else {
  const half = pieceW / 2;
  // 左右：棋子中心落在坐标面左右边沿时，半个子伸进石边，石边必须更宽
  const sideMin = Math.min(pad[1], pad[3]);
  if (sideMin > half) {
    ok(`左右石边 ${sideMin}% > 半个棋子 ${half}% —— 0/8 列不会被裁`);
  } else {
    bad(`左右石边只有 ${sideMin}%，小于半个棋子 ${half}% —— 0 列和 8 列的棋子会被左右边框切掉`);
  }
  // 上下同理
  if (pad[0] > half) {
    ok(`上石边 ${pad[0]}% > 半个棋子 ${half}% —— 0 行（黑方底线）不会被裁`);
  } else {
    bad(`上石边只有 ${pad[0]}%，小于半个棋子 ${half}% —— 0 行棋子会被上边框切掉一半`);
  }
  if (pad[2] >= pad[0]) {
    ok(`下石边 ${pad[2]}% ≥ 上石边 ${pad[0]}%（参考图上下不对称，下方留帅位）`);
  } else {
    bad(`下石边 ${pad[2]}% 小于上石边 ${pad[0]}% —— 与参考图特征不符（应为上窄下宽）`);
  }
}

console.log('【5】几何约束：棋子直径必须小于格距');
if (pieceW == null) {
  bad('取不到 .xq-p 宽度');
} else if (pieceW < 12.5) {
  ok(`棋子 ${pieceW}% < 格距 12.5% —— 相邻棋子不会黏连`);
} else {
  bad(`棋子 ${pieceW}% ≥ 格距 12.5% —— 相邻棋子会重叠，盘面会糊`);
}

console.log('【6】几何约束：格距比必须接近参考图的 1.085');
const ar = aspectRatio(board || '');
if (ar == null || !pad) {
  bad('取不到 aspect-ratio 或 padding');
} else {
  // 坐标面 w = W*(1-左右pad/100)，h = H*(1-上下pad/100)
  const planeW = 1 - (pad[1] + pad[3]) / 100;
  const planeH = (1 / ar) * (1 - (pad[0] + pad[2]) / 100);
  const pitchRatio = (planeH / 9) / (planeW / 8);
  // 容差 window 别开太宽：8/9 会算成 0.966、8/11 会算成 1.181，
  // 窗口一旦放到 0.95~1.22，这两种明显的错误比例都能蒙过去（变异测试验过）。
  // 当前实现是 1.046，取 1.00~1.12 既容得下正常微调，又能挡住「凭感觉写 8/9」。
  if (pitchRatio >= 1.00 && pitchRatio <= 1.12) {
    ok(`格距比 Y:X = ${pitchRatio.toFixed(3)}（目标 1.085，容差 1.00~1.12）`);
  } else {
    bad(`格距比 Y:X = ${pitchRatio.toFixed(3)}，超出 1.00~1.12 —— ` +
        `棋盘会被拉长或压扁，棋子与横线对不上。改 padding/aspect-ratio 后要重新量，别凭感觉写 8/9`);
  }
}

console.log('【7】触控目标：交叉点热区不得小于 44px');
const hitW = pct(rule('.xq-hit') || '', 'width');
if (hitW == null) {
  bad('取不到 .xq-hit 宽度');
} else {
  // 最窄主流屏宽 375px；容器左右各 16px、区块内边距按 0 估（保守取上界屏宽）
  const planeWpx = (375 - 32) * (1 - 0) * (1 - ((pad ? pad[1] + pad[3] : 12) / 100));
  const hitPx = planeWpx * hitW / 100;
  if (hitPx >= 43.5) {   // 允许半像素的舍入
    ok(`热区 ${hitW}% ≈ ${hitPx.toFixed(1)}px @375px 屏（≥44px 下限）`);
  } else {
    bad(`热区 ${hitW}% ≈ ${hitPx.toFixed(1)}px @375px 屏，低于 44px —— ` +
        `手指会频繁点空。格距只有 12.5%，热区必须大于它靠重叠来凑够触控面积`);
  }
  if (hitW > 12.5) {
    ok(`热区 ${hitW}% > 格距 12.5%（相邻热区重叠，等价吸附到最近交叉点）`);
  } else {
    bad(`热区 ${hitW}% ≤ 格距 12.5% —— 格与格之间会出现点不到的死区`);
  }
}

console.log('【8】操作按钮高度满足触控下限');
const opsRule = rule('.xq-op') || rule('.xq-ops');
const opMinH = prop(rule('.xq-op') || '', 'min-height');
if (opMinH && parseFloat(opMinH) >= 44) {
  ok(`.xq-op min-height: ${opMinH}`);
} else {
  bad(`.xq-op 没有 44px 的 min-height（现值 ${opMinH}）`);
}

console.log('【9】选中态必须用独立 ::before 外环，不得覆盖棋子的 box-shadow');
// 覆盖 .xq-p 自身的 box-shadow 会把「厚度 + 落地阴影」一起吃掉，选中时棋子会瞬间变平。
// 只查 .xq-p.sel / .xq-p.last 自身的规则体，不查它们的 ::before（::before 上写发光是正确做法）。
const selfSel = (code.match(/\.xq-p\.sel\s*\{([^}]*)\}/) || [])[1] || '';
const selfLast = (code.match(/\.xq-p\.last\s*\{([^}]*)\}/) || [])[1] || '';
if (/box-shadow/.test(selfSel) || /box-shadow/.test(selfLast)) {
  bad('.xq-p.sel / .xq-p.last 自身改了 box-shadow —— 会覆盖棋子的「厚度 + 落地阴影」，' +
      '选中时棋子会瞬间变平。应该写在 .xq-p.sel::before 上');
} else {
  ok('.xq-p.sel / .xq-p.last 自身不碰 box-shadow');
}
if (/\.xq-p\.sel::before/.test(code)) {
  ok('选中态用独立 ::before 外环（内含发光，不干扰棋子本体）');
} else {
  bad('没有 .xq-p.sel::before —— 选中态缺少独立外环，只能去覆盖 box-shadow，会压平棋子');
}

console.log('【10】棋子必须让开指针（落子统一走热区，避免双触发）');
const pRule = rule('.xq-p') || '';
if (/pointer-events:\s*none/.test(pRule)) {
  ok('.xq-p 有 pointer-events: none');
} else {
  bad('.xq-p 没有 pointer-events: none —— 棋子与热区会双触发，一次触摸走两步');
}

console.log('【11】三行横排必须能兜住窄屏（不溢出）');
// 难度三连 / 34 个关卡号 / 五个操作按钮都是「横排且子项不可折行」。
// 375px 与 320px 实测都放得下，但那是「当前文案长度」下的结论 ——
// 关卡名变长或用户调大默认字号就会撑破。
//
// 两种布局各有对应的兜底手法，测试只要求「用对了其中一种」，不强制具体写法：
//   · flex 行：flex-wrap:wrap（放不下换行）+ min-width:0（容器可被压窄）
//   · grid 行：minmax(0,1fr)（轨道允许压到 0，1fr 的隐含最小值是 auto）+ min-width:0
[['.xq-tiers', '难度三连（flex）'], ['.xq-ops', '操作行（grid）'], ['.xq-lvs', '关卡号行（flex）']]
  .forEach(([sel, name]) => {
    const body = rule(sel) || '';
    const canShrink = /min-width:\s*0/.test(body);
    const flexOk = /display:\s*flex/.test(body) && /flex-wrap:\s*wrap/.test(body);
    const gridOk = /display:\s*grid/.test(body) && /minmax\(\s*0\s*,/.test(body);
    if (canShrink && (flexOk || gridOk)) {
      ok(`${sel}（${name}）有窄屏兜底（${flexOk ? 'flex-wrap+min-width' : 'minmax(0,1fr)+min-width'}）`);
    } else {
      bad(`${sel}（${name}）缺窄屏兜底 —— 需要 min-width:0（有=${canShrink}）` +
          ` 且 flex+flex-wrap（${flexOk}）或 grid+minmax(0,·)（${gridOk}）；` +
          `否则窄屏/大字号时整行会向右溢出被裁`);
    }
  });
// 难度块的文字要有 ellipsis 收口，否则换行后子项仍按 min-content 撑宽
const tierRule = rule('.xq-tier') || '';
if (/text-overflow:\s*ellipsis/.test(tierRule) && /min-width:\s*0/.test(tierRule)) {
  ok('.xq-tier 文字有 ellipsis 收口 + min-width:0');
} else {
  bad('.xq-tier 缺 text-overflow:ellipsis 或 min-width:0 —— 文字会撑破容器而不是省略');
}

console.log('\n────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
