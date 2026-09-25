# 六项安全问题复审 —— 规划 / 可行性 / 实施记录

> 复审时间：2026-09-26 02:53
> 复审基准：`57c8b12`（与线上完全一致，已用 `git log` 双向核对）
> 提出方：用户转述的第三方审计清单（P0×1 / P1×3 / P2×2）

---

## 第零步：先给结论（重要）

**这 6 项在当前代码里全部已经修复，且已在线上生效。** 修复提交是
`4cc9bf0`（2026-09-26 02:14:11），我在同一轮里逐条独立验证后应用并部署。

因此下面的规划**不是**「怎么修」，而是「怎么证明它已经修好、且没有在
后续 4 个提交里被悄悄改回去」。这个区别很关键 —— 如果我照着清单去
"再修一遍"，会在已经正确的代码上叠加改动，那是纯风险。

| 级别 | 问题 | 当前状态 | 证据位置 |
|---|---|---|---|
| P0 | `inspViewImage` 拼 innerHTML | ✅ 已修 | `index.html:2374` |
| P1 | 分类名/标签未转义（2 处） | ✅ 已修 | `index.html:2120`、`2414` |
| P1 | 500 回显 `e.message` | ✅ 已修 | `server.js:315-324`、`924` |
| P1 | KV 相等时间戳静默丢写 | ✅ 已修 | `server.js:455` |
| P2 | `redirect:'follow'` 白名单首跳绕过 | ✅ 已修 | `server.js:529-571` |
| P2 | `/report/:name` 请求内 gzipSync 阻塞 | ✅ 已修 | `server.js:188`、`196`、`945` |

---

## 一、规划：分三步走

### 步骤 A —— 逐条核实"当前是否已修"，而不是"是否曾经修过"

审计清单是**快照**，代码是**移动的**。所以核实必须做两层：

1. **存在性**：当前 HEAD 里，危险写法还在不在？
   - `grep` 危险模式（`redirect: 'follow'`、请求内 `gzipSync`、`e.message` 回显）
   - 读修复后的函数体，确认逻辑本身正确
2. **防回归**：修复之后有没有被改回去？
   - `git diff 4cc9bf0..HEAD` 逐文件看
   - 对每一条关键安全行，检查它在新版本里是否仍存在

**为什么要第 2 层**：`4cc9bf0` 之后还有 4 个提交，其中 `d772365`
动了 675 行 `index.html`（字号令牌化）。行数这么大，光看
「没删掉安全行」不够，得确认**每一行转义调用都没丢**。

### 步骤 B —— 风险评估：哪些是真问题，哪些是理论问题

不能因为清单写了 P1/P2 就一律按最高优先级处理。要区分：

- **真实可利用**：有明确的攻击路径、且在真实部署里可达
- **理论成立但实际不可达**：需要攻击者已经有 token（等于已完全失守）
- **已被其他机制挡住**：外层的防御让这一层失效

### 步骤 C —— 实施：只做真正还需要做的事

如果全部已修，实施内容收敛为「补证据 + 补测试」，**不改业务代码**。

---

## 二、可行性评估

在设计测试前就想清楚哪些能测、哪些测不了 —— 否则会写出「看着很厉害
其实什么都没验证」的测试。

| 目标 | 可行性 | 手段 | 限制 |
|---|---|---|---|
| 证明 P0/P1-a 已修 | ✅ 高 | 静态断言 + 真实 DOM 行为测试 | 需要 DOM 环境 |
| 证明 P1-b/P1-c 已修 | ✅ 高 | 对真实 HTTP 服务器发请求 | 无 |
| 证明 P2-a 已修 | ⚠️ 中 | 静态断言 + 白名单单测 | **端到端测不了**，见下 |
| 证明 P2-b 已修 | ✅ 高 | 时间测量 + 日志断言 | 报告太小，信号弱 |
| 证明"没被改回去" | ✅ 高 | git diff 审计 | 无 |

### P2-a 为什么端到端测不了（必须诚实说明）

`/api/link-title` 受 `app.use('/api', ...)` 鉴权保护。要触发它必须先有 token。
而一旦有 token，攻击者已经能读写全部 `kv` 数据（含 wallet / investments /
dailyLife）—— 再研究他能不能拿这个端点去打内网，价值已经很低了。

**所以「可达性」这个前提本身是弱的**，我不会为了凑一个漂亮的端到端
测试去假装它可达。可行的做法是：
1. 静态断言 `redirect: 'manual'` 存在、`MAX_HOPS` 存在、逐跳调 `validateHop`
2. 单独抽出 `hopGuard` 做单元测试（不依赖 token、不依赖网络）
3. 在报告里**明确写出**「这条端到端不可测，因为前置条件已有 token」

**这样写出来的测试比假装端到端的更有价值**，因为它没有说谎。

### P2-b 的信号很弱，要如实标注

`report/` 只有一个 26 KB 的 HTML，`gzipSync` 压 26 KB 大约 3–8 ms。
延迟抖动的量级远大于这个数字，**用挂钟时间区分「请求内压缩」和
「启动时预压缩」基本不可能**。

可行的替代信号是**日志**：启动时预压缩会打 `月报预压缩: N 份`，
请求内压缩不会打。这个信号是确定性的。

还有一条我之前已经量化过的数据可以用：冷启动首次请求
`/report/<name>` 返回 `Content-Encoding: gzip` —— 如果压缩发生在
请求内，那么"第一次请求"和"压缩已完成"之间没有可观测的先后；
但配合启动日志 + `warmReportCache()` 在 `app.listen` 里同步调用的
代码事实，可以形成完整证据链。

**结论：以日志 + 代码结构为主证据，时间测量只作辅助且标注噪声。**

---

## 三、实施结果（含实际验证证据）

### P0 —— `inspViewImage` 注入

```js
// index.html:2374
function inspViewImage(url) {
  const d = document.createElement('div');
  d.className = 'insp-viewer';
  const img = document.createElement('img');
  img.src = safeFileUrl(url);   // 只接受本站 /api/files/ 下的地址
  d.appendChild(img);
  ...
```

**为什么这条是真 P0**：`fileUrl` 跟着 `inspirations` 走 KV 同步。
而 `importAllData()`（`index.html:1921`）会把导入 JSON 里的任意字符串
**原样**写进 `localStorage` 的 `nexus_*` 键 —— 没有任何值校验。
「导入一个被污染的 JSON」→「打开灵感库」→ 执行任意脚本，
这是一条完整的存储型 XSS 链路。

**修复是双层的**，这点很重要：改 `createElement` 解决"怎么插入"，
`safeFileUrl` 解决"插什么"。只有第一层的话，`img.src = 'javascript:...'`
之类仍然有空间；只有第二层的话，`innerHTML` 的解析歧义仍在。
两层都要有。

`safeFileUrl` 用 `/^(.*?)(\/api\/files\/[0-9a-f]{32}\.[A-Za-z0-9]+)$/`
强制路径部分必须匹配，前缀放空串（同源）或 serverBase（跨源）。
这同时挡掉了 `//evil.com/x.png` 这种「每次开灵感库都往外发请求带 Referer」的
数据外泄。

### P1-a —— 两处转义

两处都是「属性值 + 正文」双转义：

```js
// renderQuickCats (index.html:2120)
'<button ... onclick="quickPick(&quot;' + escAttr(c) + '&quot;)">' + escHtml(c) + '</button>'
```

```js
// renderInspirations 标签栏 (index.html:2414)
const t = escAttr(e[0]);
return '<button ... onclick="inspSetTagFilter(&quot;' + t + '&quot;)">#' + escHtml(e[0]) + ' ' + e[1] + '</button>';
```

`escAttr` 的定义（`index.html:2455`）是 `escHtml` + 把 `"` 换成 `&quot;`。
在 `onclick="quickPick(&quot;...&quot;)"` 这个结构里，注入者要逃出的是
**双引号定界的 HTML 属性**，所以 `"` → `&quot;` 正是必需的那一步。

### P1-b —— 500 不回显

```js
const internalError = (res) => res.status(500).json({ error: 'internal error' });
// wrap / wrapAsync 捕获后统一走它；全局 error handler 同样只回固定文案
```

原问题在 `NODE_ENV` 未设时，Express 会把完整 `SyntaxError` 堆栈
（含 `node_modules` 绝对路径、依赖行号）回给客户端 —— 等于免费送一份
内部目录结构 + 依赖版本清单，用来精确匹配已知 CVE。

本次额外收益：`ecosystem.config.js` 现在显式设了
`NODE_ENV: 'production'`（`server.js` 的 10 行 diff 之一），
两层都堵上了。**这一点是本轮配置工作顺带加固的，值得记一笔。**

### P1-c —— KV 相等时间戳

```js
// server.js:455
if (!cur || ts >= Number(cur.updated_at)) {   // 原来是 ts > ...
```

原逻辑 `>` 两个分支都不覆盖 `ts === cur.updated_at`，但接口仍然返回
`ok:true` —— **客户端以为写成功了，服务器实际上丢弃了**。
真实数据丢失路径，而且完全静默。

为什么改成 `>=` 是安全的：同毫秒的两次写入，后到的覆盖先到的，
结果与「客户端在那一毫秒里连续调用两次」的语义一致。客户端时间戳
本身在毫秒精度下无法区分先后，取后者是合理选择 —— 重要的是
**不再假装成功**。

### P2-a —— 逐跳校验

```js
// server.js:529-571
for (let hop = 0; hop <= MAX_HOPS; hop++) {
  const res = await fetch(current, { signal: ctrl.signal, redirect: 'manual', ... });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc) return {...};
    let next; try { next = new URL(loc, current).href; } catch { return {...}; }
    if (validateHop && !validateHop(next)) return { ..., blocked: true };
    current = next;
    continue;
  }
  ...
}
return { status: 508, error: 'too_many_redirects' };
```

关键点：`redirect: 'manual'` 让 3xx 不被自动跟随，`Location` 经
`new URL(loc, current)` 解析为绝对地址后交给 `validateHop` 复查。
`hopGuard(true)` 校验「协议是 http(s) + host 在白名单内」。

`MAX_HOPS = 5` 同时挡掉重定向环。

**覆盖面（诚实说明）**：`hopGuard(true)` 接在
`bilibiliTitle`（`server.js:590`）和 `/api/link-title` 通用兜底
（`server.js:620`）两处 —— 也就是**唯二由用户直接给 URL 的抓取路径**。

另外三处故意不挂 guard，因为它们跑的是硬编码常量 URL：
- `bilibiliTitle` 内部走 `api.bilibili.com` 的 view 接口（`:595`）
- `fetchFundQuote` 打 `fund.eastmoney.com`（`:656`）
- `fetchGoldQuote` 打 `sge.com.cn`（`:725`）
- `fetchStockQuoteMap` 打 `qt.gtimg.cn`（`:755`，用原生 fetch，因为要 GBK 解码）

这四处 URL 里没有任何用户可控成分，不挂 guard 是正确的 —— 挂了
反而会因为白名单只含视频站而全部失效。

### P2-b —— 预压缩

```js
// server.js:188（在 reportFile() 里，只在该 name 首次被读时执行）
gz: zlib.gzipSync(raw, { level: 6 }),

// server.js:196  启动时把所有 *.html 全部预热
function warmReportCache() { ... }

// server.js:945  在 app.listen 回调里同步调用
warmReportCache();
```

`warmReportCache` 在 `app.listen` 里调用，`reportFile()` 是懒填充的
`Map` 缓存。**启动后所有合法报告都已在缓存里，请求路径只做 `Map.get` +
`res.end(c.gz)`，不存在同步压缩。**

必须如实标注的两点：
1. **仍有理论边界**：如果运行期间有**新文件**落进 `report/`，
   下一次请求会触发一次 `gzipSync`。要彻底消除得加 `fs.watch`
   或改成异步 `zlib.gzip` 回调。**当前不做的理由**：报告是部署时
   用脚本生成的，不会在运行中掉落；加复杂度换一个不存在的风险不划算。
   这是**有意识的取舍，不是遗漏**。
2. 见上文「信号很弱」——时间测量区分不出这件事。

### 防回归审计（步骤 A 第 2 层）

```
git diff 4cc9bf0..HEAD --stat
  index.html       | 675 ++++++++++++++++++---------
  server/server.js |  10 +-
```

675 行的改动看着吓人，逐行看过了：**全部是
`font-size: 0.72rem` → `font-size: var(--fs-xs)` 这类令牌替换。**

关键确认——**转义调用一个都没丢**：抽出的每条 `escHtml(r.range)`、
`escAttr(r.id)`、`escHtml(r.content)` 等，在新版本里
**每一个仍然带着自己的转义函数**，包括那行唯一发生实质变化的
`<a href=...>${escHtml(it.link)}`（只是把字号换成令牌）。

`server/server.js` 的 10 行 diff = `CORS_ORIGIN` 默认值那一段。
安全逻辑零改动。

---

## 四、结论与建议

### 结论

这 6 项**全部已修复并在线上生效**，且经防回归审计确认未被回退。
清单描述的是修复前的状态。

### 对审计清单本身的两点评价（供参考）

1. **P0 的判断是准确的**，而且指出了正确的根因方向（`fileUrl` 来自 KV）。
   但它没点出更关键的一环：`importAllData()` 的**零校验写入**才是让
   这个 P0 可被利用的入口。修渲染层是治标，`importAllData` 加值校验
   才算治本 —— 这一条我列在「已知未修」里，值得后续处理。
2. **P2-a / P2-b 定为 P2 偏高**。两条都需要「攻击者已有 token」这个
   前置条件，而 token 等于全量数据权限。定 P3 更准确。
   这不影响修复价值（都已修），但影响排期优先级判断。

### 后续真正值得做的（按性价比排序）

1. **`importAllData()` 加值校验** —— 治本。目前任何导入 JSON 都能往
   `nexus_*` 写任意字符串。建议：按 key 校验结构 / 长度上限 /
   丢非法项并告知用户。这是**唯一还没堵的入口**。
2. **轮换 `AUTH_TOKEN`** —— 仍是泄漏过的 `3137...5650`。
   改 `server/.env` 一行 + `pm2 restart` 即可，客户端需同步更新。
3. `report/` 目录改 `fs.watch` —— 仅在"运行期会新增报告"成立时才需要。

---

## 五、本轮新增测试

新建 `tests/security-regression.test.js`，把上述 6 条固化成断言，
**任何一条被改回去就会变红**。设计要点：

- 静态断言用「读源码 + 正则」，不依赖网络和 token
- `hopGuard` 逻辑单独测（不依赖 token、不依赖网络）
- 能测的尽量测行为，测不了的**在注释里写明为什么测不了**，
  不用假测试充数
