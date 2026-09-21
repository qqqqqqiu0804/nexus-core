/**
 * 中国象棋走法校验器的测例。
 *
 * 直接抽取 index.html 里那段真实代码来跑——测的是同一份实现，不是复制品。
 * 跑法：  node tests/xiangqi-moves.test.js
 *
 * 覆盖：车/马(蹩腿)/炮(隔子吃)/象(塞眼、不过河)/士(九宫)/帅将(九宫、照面)/兵卒(过河)/走后自将。
 */
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

const start = html.indexOf('// ===== 每日象棋残局 =====');
const end = html.indexOf('function renderDailyHub() {');
if (start < 0 || end < 0 || end < start) { console.error('提取代码段失败'); process.exit(1); }
const code = html.slice(start, end);
const api = new Function(code + '\nreturn { xqBoard, xqLegalMove, xqMovesFor, xqKingsFacing, xqInCheck, xqLoser, xqAiChoose, XIANGQI_LEVELS };')();
console.log('代码段长度', code.length, '字符\n');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '   ← 期望 ' + expected + '，实际 ' + actual));
}
const B = api.xqBoard;

console.log('【1】八个关卡的初始局面必须合法（不照面、红方未被将军）');
for (const eg of api.XIANGQI_LEVELS) {
  const b = B(eg.pieces);
  t(eg.name + ' · 不照面', api.xqKingsFacing(b), false);
  t(eg.name + ' · 红方未被将军', api.xqInCheck(b, 'r'), false);
}

console.log('\n【2】车');
const b1 = B([['R', 0, 9], ['K', 3, 9], ['k', 4, 0]]);   // 车a1 帅d1 将e10
t('a1→a5 直线无阻 = 合法', api.xqLegalMove(b1, 0, 9, 0, 5), true);
t('a1→d1 吃己方帅 = 非法', api.xqLegalMove(b1, 0, 9, 3, 9), false);
t('a1→e5 不走直线 = 非法', api.xqLegalMove(b1, 0, 9, 4, 5), false);
t('a1→e1 横线中间 d1 有帅挡 = 非法', api.xqLegalMove(b1, 0, 9, 4, 9), false);

console.log('\n【3】帅/将');
t('帅 d1→d2 九宫内一步 = 合法', api.xqLegalMove(b1, 3, 9, 3, 8), true);
t('帅 d1→e2 斜走 = 非法', api.xqLegalMove(b1, 3, 9, 4, 8), false);
t('帅 d1→a1 出九宫 = 非法', api.xqLegalMove(b1, 3, 9, 0, 9), false);
t('将 e10→e9 一步 = 合法', api.xqLegalMove(b1, 4, 0, 4, 1), true);
t('将 e10→d9 斜走 = 非法', api.xqLegalMove(b1, 4, 0, 3, 1), false);

console.log('\n【4】将帅照面');
const bFace = B([['R', 0, 9], ['K', 4, 9], ['k', 4, 0]]);   // 帅e1 将e10 同列中间全空
t('照面局面能被识别', api.xqKingsFacing(bFace), true);
t('照面局面下任何走法都不合法（走完仍照面）', api.xqMovesFor(bFace, 0, 9).length, 0);

console.log('\n【5】炮（吃子必须隔一子）');
const b4 = B([['N', 2, 4], ['C', 4, 7], ['K', 3, 9], ['k', 4, 0], ['a', 4, 1]]);   // 马c5 炮e3 帅d1 / 将e10 士e9
t('炮 e3→e10 隔黑士吃将 = 合法', api.xqLegalMove(b4, 4, 7, 4, 0), true);
t('炮 e3→e9 相邻吃子（中间 0 子）= 非法', api.xqLegalMove(b4, 4, 7, 4, 1), false);
t('炮 e3→e5 空地直移 = 合法', api.xqLegalMove(b4, 4, 7, 4, 5), true);
t('炮 e3→a5 不走直线 = 非法', api.xqLegalMove(b4, 4, 7, 0, 5), false);

console.log('\n【6】马与蹩马腿');
const nMare = B([['N', 2, 4], ['K', 4, 9]]);
t('马 c5→a6 日字无蹩腿 = 合法', api.xqLegalMove(nMare, 2, 4, 0, 3), true);
const nBlocked = B([['N', 2, 4], ['K', 4, 9], ['p', 1, 4]]);      // b5 放子 = 跳 a6 的横腿
t('马 c5→a6 被 b5 蹩腿 = 非法', api.xqLegalMove(nBlocked, 2, 4, 0, 3), false);
const nBlocked2 = B([['N', 2, 4], ['K', 4, 9], ['p', 2, 3]]);     // c6 放子 = 跳 b7 的竖腿
t('马 c5→b7 被 c6 蹩腿 = 非法', api.xqLegalMove(nBlocked2, 2, 4, 1, 2), false);
t('马 c5→b7 腿空 = 合法', api.xqLegalMove(nMare, 2, 4, 1, 2), true);
t('马 c5→c6 直走 = 非法', api.xqLegalMove(nMare, 2, 4, 2, 3), false);

console.log('\n【7】象（走田、不过河、塞象眼）');
const bEle = B([['B', 2, 9], ['K', 4, 9]]);
t('红相 c1→a3 走田 = 合法', api.xqLegalMove(bEle, 2, 9, 0, 7), true);
t('红相 c1→c3 直走 = 非法', api.xqLegalMove(bEle, 2, 9, 2, 7), false);
const bEleBlock = B([['B', 2, 9], ['K', 4, 9], ['p', 1, 8]]);     // 象眼 b2 有子
t('红相 c1→a3 象眼被塞 = 非法', api.xqLegalMove(bEleBlock, 2, 9, 0, 7), false);
const bEleRiver = B([['b', 2, 0], ['k', 4, 0]]);
t('黑象 c10→a8 = 合法', api.xqLegalMove(bEleRiver, 2, 0, 0, 2), true);
const bEleCross = B([['B', 2, 4], ['K', 4, 9]]);                 // 红方在下：y≥5 才是本岸
t('红相 c5→a3 跳到 y2（过河）= 非法', api.xqLegalMove(bEleCross, 2, 4, 0, 2), false);
t('红相 c5→a7 跳到 y6（本岸）= 合法', api.xqLegalMove(bEleCross, 2, 4, 0, 6), true);

console.log('\n【8】兵/卒');
const bP = B([['P', 4, 6], ['K', 4, 9]]);                        // 红兵 e4，未过河
t('红兵 e4→e3 前进 = 合法', api.xqLegalMove(bP, 4, 6, 4, 5), true);
t('红兵 e4→d4 横走（未过河）= 非法', api.xqLegalMove(bP, 4, 6, 3, 6), false);
t('红兵 e4→e5 后退 = 非法', api.xqLegalMove(bP, 4, 6, 4, 7), false);
const bP2 = B([['P', 4, 3], ['K', 4, 9]]);                       // 红兵 e6，已过河
t('红兵 e6→d6 横走（已过河）= 合法', api.xqLegalMove(bP2, 4, 3, 3, 3), true);
t('红兵 e6→e5 仍可前进 = 合法', api.xqLegalMove(bP2, 4, 3, 4, 2), true);
const bP3 = B([['p', 4, 3], ['k', 4, 0]]);                       // 黑卒 e7，黑方未过河
t('黑卒 e7→e8 前进 = 合法', api.xqLegalMove(bP3, 4, 3, 4, 4), true);
t('黑卒 e7→d7 横走（未过河）= 非法', api.xqLegalMove(bP3, 4, 3, 3, 3), false);
const bP3b = B([['p', 4, 6], ['k', 4, 0]]);                      // 黑卒 e4，黑方已过河
t('黑卒 e4→d4 横走（已过河）= 合法', api.xqLegalMove(bP3b, 4, 6, 3, 6), true);
const bP4 = B([['p', 4, 7], ['k', 4, 0]]);
t('黑卒 e3→d3 横走（已过河）= 合法', api.xqLegalMove(bP4, 4, 7, 3, 7), true);

console.log('\n【9】走后不能自将（白脸将/被将军）');
const bPin = B([['K', 4, 9], ['R', 3, 9], ['k', 4, 0], ['r', 3, 0]]);   // 红车 d1 挡在两将之间
t('红车 d1 不能离开（走了就照面）= 非法', api.xqLegalMove(bPin, 3, 9, 3, 5), false);
t('红车 d1 沿 d 线走到 d5 也非法（离开即照面）', api.xqLegalMove(bPin, 3, 9, 3, 4), false);

console.log('\n【10】将死 / 胜负判定');
// 黑将缩在九宫左上角：d 列车封住竖线、e 列车封住 e10 → 无路可走
const bMate = B([['R', 3, 9], ['R', 4, 5], ['K', 4, 9], ['k', 3, 0]]);
t('黑方被将死 → 判负', api.xqLoser(bMate), 'b');
const badLevels = api.XIANGQI_LEVELS.filter(eg => api.xqLoser(B(eg.pieces)) !== null);
t('八个关卡的初始局面都未分胜负' +
  (badLevels.length ? '（有问题的关卡：' + badLevels.map(x => x.name).join('、') + '）' : ''),
  badLevels.length, 0);

console.log('\n【11】AI 应手必须是合法着法（跑 30 次）');
let aiOk = true;
for (let i = 0; i < 30 && aiOk; i++) {
  const bb = B([['R', 0, 9], ['K', 3, 9], ['k', 4, 0]]);
  const mv = api.xqAiChoose(bb, 'b');
  if (!mv) { aiOk = false; t('AI 应能给出着法（第 ' + i + ' 次）', false, true); break; }
  if (!api.xqLegalMove(bb, mv.from[0], mv.from[1], mv.to[0], mv.to[1])) {
    aiOk = false;
    t('AI 着法合法（第 ' + i + ' 次）', false, true);
  }
}
if (aiOk) t('AI 连续 30 次都给出合法着法', true, true);

console.log('\n【12】关卡正解序列必须真的能杀（逐关验算）');
let lvOk = 0, lvBad = 0;
for (const lv of api.XIANGQI_LEVELS) {
  if (!lv.solution) continue;              // 限步关没有唯一正解，跳过
  const bb = B(lv.pieces);
  let legal = true;
  for (const mv of lv.solution) {
    if (!api.xqLegalMove(bb, mv[0], mv[1], mv[2], mv[3])) { legal = false; break; }
    bb[mv[3]][mv[2]] = bb[mv[1]][mv[0]];
    bb[mv[1]][mv[0]] = null;
  }
  const mate = api.xqLoser(bb) === 'b';
  const ok = legal && mate;
  ok ? lvOk++ : lvBad++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + lv.name + '：' + lv.solution.length + ' 手，' +
    (legal ? '着法全合法' : '有非法着法') + '，' + (mate ? '终局将死黑方' : '终局没杀死'));
}
t('带正解的关卡全部验算通过（' + lvOk + ' 关）', lvBad, 0);

console.log('\n【13】棋盘可点击性（回归自线上「不能落子」）');
/*
 * 出过的真 bug：棋盘从「格子阵列」换成 SVG 真棋盘后，空的交叉点底下没有任何元素——
 * SVG 的线条压在落点上把点击吃掉了，点空落点毫无反应（只有吃子能走）。
 * 这里锁三件事：① SVG 让开指针；② 90 个交叉点各有一个带 xqTap 的热区；③ 走通一次选中→落子。
 */
const css = html.slice(0, html.indexOf('</style>'));
t('棋盘 SVG 已让开指针', /\.xq-plane\s*>\s*svg\s*\{[^}]*pointer-events:\s*none/.test(css), true);

const box = { innerHTML: '' };
const api2 = new Function('document', 'Store', 'mkIcon', 'escHtml', code +
  '\nreturn { renderDailyChess, xqNewGame, xqTap, xqLevelTo, getState: function () { return _xqState; } };')(
  { getElementById: id => (id === 'daily-chess-body' ? box : null) },
  { get: (k, d) => (d === undefined ? null : d), set: function () {} },
  function () { return '<svg></svg>'; },
  function (s) { return String(s == null ? '' : s); },
);
api2.xqNewGame();
api2.renderDailyChess();
const out = String(box.innerHTML);
const hitList = [...out.matchAll(/class="xq-hit"[^>]*onclick="xqTap\((\d+),(\d+)\)"/g)];
t('交叉点热区数量', hitList.length, 90);
t('热区覆盖全部坐标（0-8 × 0-9）', new Set(hitList.map(m => m[1] + ',' + m[2])).size, 90);
t('棋子不再挂 onclick（避免与热区双触发）', /class="xq-p[^"]*"[^>]*onclick=/.test(out), false);

// 走一遍：选中某个红子 → 点它的合法落点 → 应当真的落子（used +1）
const freeIdx = api.XIANGQI_LEVELS.findIndex(l => l.limit && !l.solution);
api2.xqLevelTo(freeIdx);
const firstBoard = api2.getState().board;
let fx = -1, fy = -1;
for (let y = 0; y < 10 && fx < 0; y++) {
  for (let x = 0; x < 9; x++) {
    const pc = firstBoard[y][x];
    if (pc && pc === pc.toUpperCase()) { fx = x; fy = y; break; }
  }
}
api2.xqTap(fx, fy);
const legal = api2.getState().moves;
t('点自己的子能选中并给出落点', legal.length > 0, true);
api2.xqTap(legal[0][0], legal[0][1]);
t('点落点确实落子（步数 +1）', api2.getState().used, 1);

console.log('\n————————————————————————');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
