# Cookie 交接（2026-09-26 · 下载音频用）

> 上接 `COOKIE-AND-KEY.md`（收藏夹导出已完成，337 条到手）。
> 这份只讲**下载音频**这一步的 cookie 要求。

---

## 一、先把话说清楚：需要什么 cookie，风险在哪

### 三个来源的报错原文，指向同一件事

| 工具 | 报错原文 |
|---|---|
| yt-dlp | `Fresh cookies (not necessarily logged in) are needed` |
| f2 配置说明 | `登录后的cookie，如果使用未登录的cookie，则无法持久稳定下载作品` |
| f2 实测 | 签名生成正确，服务端仍 403 |

**关键信息：`not necessarily logged in`** ——
抖音下载侧要的是**新鲜度**，不是**登录态**。
它要的是 cookie 里那串访客标识（`ttwid` 这类），用来过防爬。

### 所以风险等级

| 给什么 | 风险 |
|---|---|
| **只给访客标识**（推荐） | 低。不含账号身份，别人拿不到你的收藏/私信/发布权 |
| 给完整登录 cookie | **高**。等于交出"以你身份登录"的凭据，能读也能删你的东西 |

**→ 我们要的是第一种。**

### 服务器自己拿不到

已实测（2026-09-26）：

```bash
curl -s -i https://www.douyin.com/ -H "User-Agent: Mozilla/5.0 ..."
# → Set-Cookie 数量：0
```

`ttwid` 是**页面 JS 算出来的**，不是 HTTP 头下发的。所以**必须从你的浏览器拿**，
服务器无法自行生成。这是客观限制，不是我偷懒。

---

## 二、怎么拿（推荐：只导访客标识）

### 方法 A：从浏览器复制 cookie 字符串（最快）

1. Edge 打开抖音（**不用登录**也可以，未登录访问一下就行）
2. 按 **F12** → 切到 **「控制台」**
3. 粘贴这一行回车：

```js
document.cookie
```

4. 会输出一长串，类似：

```
ttwid=1%7Cxxxxx...; passport_csrf_token=...; s_v_web_id=verify_xxx...
```

5. **把整串复制给我**（发在对话里就行）

### 方法 B：如果方法 A 拿到的串太长/不完整

在控制台粘这个，它只挑出访客标识那几个：

```js
(() => {
  const want = ['ttwid','s_v_web_id','msToken','passport_csrf_token','odin_tt','tt_scid'];
  const all = document.cookie.split(';').map(s => s.trim());
  const got = all.filter(c => want.some(w => c.startsWith(w + '=')));
  console.log(got.join('; '));
  return got.join('; ');
})()
```

把输出复制给我。

---

## 三、拿到之后我怎么做

1. 把 cookie 写进服务器 `/root/nexus-core/server/.douyin-cookie.txt`，`chmod 600`
2. 跑**那一条**（「有时候不允许也是一种自爱」73 秒）验证
3. **把结果原样给你看**（一句话观点 + 3 要点 + 标签）
4. 你说行，我再批量；你说不行，我调 prompt 重跑

**先用 1 条验证，不批量。** 这是之前说好的。

---

## 四、用完怎么处理

| 时机 | 动作 |
|---|---|
| 跑完这一批 | 告诉你，你可以去抖音「退出全部设备」让这串失效 |
| 你要求时 | 我立刻删掉服务器上的 cookie 文件 |

**cookie 只在服务器上，不进代码仓库**（`.gitignore` 已排除）。
`AUTH_TOKEN` 那次不会重演。

---

## 五、绕不过去的现实

抖音下载侧的防爬比收藏夹接口**更严**（收藏夹那套是三层，
这套是「新鲜 cookie + 签名」双重要求）。

我试过 f2（GitHub 上最活跃的抖音下载库，今天还在更新），
**它能正确生成 `a_bogus` 签名，但服务端照样 403** ——
说明**签名不是障碍，cookie 才是**。没有别的绕过办法。

所以这一步只能你配合。但只需要**访客标识**，不用账号凭据。
