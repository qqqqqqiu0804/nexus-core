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

const start = html.indexOf('// ===== 中国象棋闯关题库 =====');
const end = html.indexOf('function renderDailyHub() {');
if (start < 0 || end < 0 || end < start) { console.error('提取代码段失败'); process.exit(1); }
const code = html.slice(start, end);
const api = new Function(code + '\nreturn { xqBoard, xqLegalMove, xqMovesFor, xqKingsFacing, xqInCheck, xqLoser, ' +
  'xqFromFen, xqAllMoves, xqMateIn, xqRedWinsFromHere, xqIsGoodMove, xqBestDefense, xqDo, xqBack, ' +
  'XQ_TIERS, XIANGQI_LEVELS };')();
console.log('代码段长度', code.length, '字符\n');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '   ← 期望 ' + expected + '，实际 ' + actual));
}
const B = api.xqBoard;

console.log('【1】全部 ' + api.XIANGQI_LEVELS.length + ' 关的初始局面必须合法（两将不照面）');
let facing = 0;
api.XIANGQI_LEVELS.forEach(function (lv, i) {
  if (api.xqKingsFacing(api.xqFromFen(lv.f))) { facing++; console.log('    第 ' + (i + 1) + ' 关照面：' + lv.f); }
});
t('没有一关是「两将照面」的非法局面', facing, 0);
const fenBack = api.xqFromFen('3k5/9/9/9/9/4R4/9/9/R8/4K4 w');
t('FEN 解析：黑将在 d10', fenBack[0][3], 'k');
t('FEN 解析：红帅在 e1', fenBack[9][4], 'K');
t('FEN 解析：红车在 a2', fenBack[8][0], 'R');
t('三档难度都存在', api.XQ_TIERS.length, 3);
t('三档区间刚好覆盖整个题库',
  api.XQ_TIERS[api.XQ_TIERS.length - 1].to, api.XIANGQI_LEVELS.length - 1);

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
const badLevels = api.XIANGQI_LEVELS.filter(eg => api.xqLoser(api.xqFromFen(eg.f)) !== null);
t('全部关卡的初始局面都未分胜负' +
  (badLevels.length ? '（有问题的关卡：' + badLevels.map(x => x.s).join('、') + '）' : ''),
  badLevels.length, 0);

console.log('\n【11】黑方「最强防守」必须是合法着法（逐关抽查）');
let defChecked = 0;
const defBad = [];
api.XIANGQI_LEVELS.forEach(function (lv, i) {
  if (i % 7) return;                                   // 每 7 关抽 1 关
  const bb = api.xqFromFen(lv.f);
  const mv = api.xqBestDefense(bb, lv.m);
  if (!mv) return;                                     // 红方先走，此刻黑方不一定有应手
  defChecked++;
  if (!api.xqLegalMove(bb, mv[0], mv[1], mv[2], mv[3])) defBad.push('第 ' + (i + 1) + ' 关');
});
t('抽查 ' + defChecked + ' 关，黑方最强防守都是合法着法' + (defBad.length ? '：' + defBad.join('、') : ''), defBad.length, 0);

console.log('\n【12】每一关都必须真的有解（逐关找一步保杀着法，剪枝优先）');
const noSol = [];
let slowestFind = 0, slowestFindAt = '';
api.XIANGQI_LEVELS.forEach(function (lv, i) {
  const bb = api.xqFromFen(lv.f);
  const t0 = Date.now();
  let found = false;
  for (const m of api.xqAllMoves(bb, 'r')) {
    const cap = api.xqDo(bb, m);
    found = (lv.m === 1) ? (api.xqAllMoves(bb, 'b').length === 0)
                         : api.xqRedWinsFromHere(bb, lv.m - 1, true);   // 剪枝：连将杀一试就知道
    api.xqBack(bb, m, cap);
    if (found) break;
  }
  const ms = Date.now() - t0;
  if (ms > slowestFind) { slowestFind = ms; slowestFindAt = '第 ' + (i + 1) + ' 关（' + lv.m + '步）'; }
  if (!found) noSol.push('第 ' + (i + 1) + ' 关（' + lv.m + '步）');
});
t('没有「无解」的关卡' + (noSol.length ? '：' + noSol.join('、') : ''), noSol.length, 0);
console.log('    单关找一步正解最慢 ' + slowestFind + 'ms（' + slowestFindAt + '）');

console.log('\n【14】难度标定抽样复核（完整搜索，较慢）');
const sample = [0, 10, 25, 33, 45, 60, 70, 85, 103];
const badLv = [];
sample.forEach(function (i) {
  const lv = api.XIANGQI_LEVELS[i];
  if (!lv) return;
  const bb = api.xqFromFen(lv.f);
  const canMate = api.xqMateIn(bb.map(r => r.slice()), 'r', lv.m, false);
  const canLess = lv.m > 1 ? api.xqMateIn(bb.map(r => r.slice()), 'r', lv.m - 1, false) : false;
  if (!canMate || canLess) {
    badLv.push('第 ' + (i + 1) + ' 关（标 ' + lv.m + ' 步，能杀=' + canMate + '，更少步也能杀=' + canLess + '）');
  }
});
t('抽样 ' + sample.length + ' 关的难度标定正确' + (badLv.length ? '：' + badLv.join('；') : ''), badLv.length, 0);

console.log('\n【15】判定耗时守门（单次判定，模拟真实点击）');
let goodWorst = 0, badWorst = 0;
[0, 20, 45, 70, 92, 103].forEach(function (i) {
  const lv = api.XIANGQI_LEVELS[i];
  if (!lv) return;
  const bb = api.xqFromFen(lv.f);
  const moves = api.xqAllMoves(bb, 'r');
  let good = null, bad = null;
  for (const m of moves) {
    const cap = api.xqDo(bb, m);
    const ok = (lv.m === 1) ? (api.xqAllMoves(bb, 'b').length === 0) : api.xqRedWinsFromHere(bb, lv.m - 1, true);
    api.xqBack(bb, m, cap);
    if (ok && !good) good = m;
    else if (!ok && !bad) bad = m;
    if (good && bad) break;
  }
  if (good) { const t0 = Date.now(); api.xqIsGoodMove(bb, good, lv.m); goodWorst = Math.max(goodWorst, Date.now() - t0); }
  if (bad) { const t0 = Date.now(); api.xqIsGoodMove(bb, bad, lv.m); badWorst = Math.max(badWorst, Date.now() - t0); }
});
t('走对时的单次判定最慢 ' + goodWorst + 'ms（阈值 300ms）', goodWorst < 300, true);
console.log('    走错时的单次判定最慢 ' + badWorst + 'ms（慢是正常的：要先剪枝否定、再完整搜索确认）');

console.log('\n【13】棋盘可点击性（回归自线上「不能落子」）');
/*
 * 出过的真 bug：棋盘从「格子阵列」换成 SVG 真棋盘后，空的交叉点底下没有任何元素——
 * SVG 的线条压在落点上把点击吃掉了，点空落点毫无反应（只有吃子能走）。
 * 这里锁三件事：① SVG 让开指针；② 90 个交叉点各有一个带 xqTap 的热区；③ 走通一次选中→落子。
 */
const css = html.slice(0, html.indexOf('</style>'));
t('棋盘 SVG 已让开指针', /\.xq-plane\s*>\s*svg\s*\{[^}]*pointer-events:\s*none/.test(css), true);

const box = { innerHTML: '' };
const api2 = new Function('document', 'Store', 'mkIcon', 'escHtml', 'showToast', code +
  '\nreturn { renderDailyChess, xqNewGame, xqTap, xqLevelTo, xqAllMoves, xqIsGoodMove, xqUndo, ' +
  'getState: function () { return _xqState; } };')(
  { getElementById: id => (id === 'daily-chess-body' ? box : null) },
  { get: (k, d) => (d === undefined ? null : d), set: function () {} },
  function () { return '<svg></svg>'; },
  function (s) { return String(s == null ? '' : s); },
  function () {},                                       // showToast
);
api2.xqNewGame();
api2.renderDailyChess();
const out = String(box.innerHTML);
const hitList = [...out.matchAll(/class="xq-hit"[^>]*onclick="xqTap\((\d+),(\d+)\)"/g)];
t('交叉点热区数量', hitList.length, 90);
t('热区覆盖全部坐标（0-8 × 0-9）', new Set(hitList.map(m => m[1] + ',' + m[2])).size, 90);
t('棋子不再挂 onclick（避免与热区双触发）', /class="xq-p[^"]*"[^>]*onclick=/.test(out), false);

// 走一遍：点自己的子 → 点落点，应当真的落子（used +1）。
// 必须挑一个「保杀」的着法——新判定会拒绝不保杀的走法（那是设计，不是 bug）。
api2.xqLevelTo(0);
const st0 = api2.getState();
const lv0 = api.XIANGQI_LEVELS[0];
let gm = null;
for (const m of api2.xqAllMoves(st0.board, 'r')) {
  if (api2.xqIsGoodMove(st0.board, m, lv0.m)) { gm = m; break; }
}
t('第 1 关存在保杀的着法', !!gm, true);
api2.xqTap(gm[0], gm[1]);                                    // 点自己的子 → 选中
t('点自己的子能选中并给出落点', api2.getState().moves.length > 0, true);
api2.xqTap(gm[2], gm[3]);                                    // 点落点 → 落子
t('点落点确实落子（步数 +1）', api2.getState().used, 1);

// 反向：不保杀的着法必须被拒绝（不推进步数）
api2.xqLevelTo(0);
const st1 = api2.getState();
let bad2 = null;
for (const m of api2.xqAllMoves(st1.board, 'r')) {
  if (!api2.xqIsGoodMove(st1.board, m, lv0.m)) { bad2 = m; break; }
}
if (bad2) {
  api2.xqTap(bad2[0], bad2[1]);
  api2.xqTap(bad2[2], bad2[3]);
  t('走一步不保杀的着法 → 被拒绝，步数不推进', api2.getState().used, 0);
}

console.log('\n【16】悔棋要撤掉整个回合（含黑方应手），且多步题黑方会还手');
const twoStepIdx = api.XIANGQI_LEVELS.findIndex(l => l.m === 2);
api2.xqLevelTo(twoStepIdx);                                   // 第一道两步杀
const stx = api2.getState();
const lvx = api.XIANGQI_LEVELS[twoStepIdx];
let gx = null;
for (const m of api2.xqAllMoves(stx.board, 'r')) {
  if (api2.xqIsGoodMove(stx.board, m, lvx.m)) { gx = m; break; }
}
api2.xqTap(gx[0], gx[1]);
api2.xqTap(gx[2], gx[3]);
t('走一着后：红方 1 手 + 黑方应手 1 手 = 2 条历史', api2.getState().history.length, 2);
t('黑方应手之后轮回到红方', api2.getState().turn, 'r');
t('红方步数记为 1', api2.getState().used, 1);
api2.xqUndo();
t('悔棋一次即回到走之前（步数归零）', api2.getState().used, 0);
t('悔棋后历史清空', api2.getState().history.length, 0);

console.log('\n————————————————————————');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
