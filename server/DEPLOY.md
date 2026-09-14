# DEPLOY.md — 从买服务器到上线全流程

> 这是**作战手册**：照着敲命令即可。本地开发见 [README.md](./README.md)。
> 总耗时约 2~3 小时（不含备案等待），总花费约 100~180 元/年。

---

## 0. 先做路线决策（这一步决定了后面的分支）

手机的浏览器**不允许 HTTPS 页面请求 HTTP 接口**（混合内容拦截）。而 GitHub Pages 是 HTTPS，所以：

| 路线 | 怎么做 | 手机能用吗 | 费用 | 耗时 |
|---|---|---|---|---|
| **A. 纯 IP 访问** | 服务器跑服务，手机开 `http://IP:端口`（前端由服务端托管，同源） | ✅ 能（走服务器托管的前端） | 0（只有服务器钱） | 1 小时 |
| **B. 域名 + 非标端口 + 免费证书** | 域名解析到 IP，证书用 DNS 验证签发，走非标端口 | ✅ 能，且 HTTPS | +域名 60~80 元 | 1 天（实名认证） |
| **C. 域名 + 备案 + 80/443** | 走标准姿势，最优雅 | ✅ 能 | +域名 | 1~3 周（备案） |

**建议**：先走 A（今天就能用），想优雅了再升 B 或 C。

⚠️ 注意一个容易踩的坑：**同一个域名在手机和电脑上 localStorage 是各自独立的**。想让多设备数据真正一致，数据必须走后端接口（见第 10 节）。这是 v4 的核心任务。

---

## 1. 采购清单

| 项目 | 推荐 | 价格 | 备注 |
|---|---|---|---|
| 服务器 | 腾讯云/阿里云**轻量应用服务器** 2核2G 3M | 68~99 元/年（新用户首年） | 别买 CVM/ECS，轻量够用且便宜 |
| 地域 | **广州**（离永州最近） | — | 延迟最低 |
| 镜像 | Ubuntu 22.04 LTS | — | 别选宝塔面板，要学就学原生 |
| 域名 | .com 或 .cn | 60~80 / 20~35 元首年 | 路线 B/C 才需要 |
| 证书 | Let's Encrypt | 免费 | 自动续期 |
| 备案 | 免费但要等 | 0 | 只在路线 C 需要 |

**避坑**：轻量服务器**首年 68，续费 300+**。到期前要么迁移，要么换厂商新客活动，别默默续费。

---

## 2. 服务器初始化（30 分钟）

登录（买完在控制台能看到公网 IP；首次用控制台设置的密码）：

```bash
ssh root@<你的公网IP>
```

### 2.1 立刻做四件事

```bash
# ① 时区！服务器默认 UTC，会让我们刚修过的时区问题以另一种形式复活
sudo timedatectl set-timezone Asia/Shanghai
date                     # 应显示 CST +8

# ② 更新系统
sudo apt update && sudo apt upgrade -y

# ③ 建普通用户（别一直用 root 跑服务）
adduser hxt
usermod -aG sudo hxt

# ④ 加 swap（1G 内存机器必备，防 OOM）
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

### 2.2 配 SSH 密钥登录（强烈建议）

```bash
# 在你自己电脑上执行（不是服务器）
ssh-keygen -t ed25519 -C "hxt-nexus"
ssh-copy-id hxt@<公网IP>
ssh hxt@<公网IP>          # 能免密登录就成功了
```

然后**关掉密码登录**（服务器上执行）：

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

> 从此只用 `ssh hxt@IP` 登录。被暴力破解的概率直接归零。

---

## 3. 装运行环境（15 分钟）

```bash
# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git nginx sqlite3
node -v && npm -v          # 应输出 v22.x

# 进程守护（崩了自动重启 + 开机自启）
sudo npm install -g pm2
```

---

## 4. 部署后端（20 分钟）

```bash
cd ~
git clone https://github.com/qqqqqqiu0804/nexus-core.git
cd nexus-core/server
npm install --omit=dev
```

### 4.1 用 ecosystem 文件管理配置（别把 token 写进命令行历史）

创建 `~/nexus-core/server/ecosystem.config.js`：

```js
module.exports = {
  apps: [{
    name: 'nexus-api',
    script: 'server.js',
    env: {
      PORT: 3457,
      AUTH_TOKEN: '把这里换成你自己的长随机串',
      CORS_ORIGIN: 'https://qqqqqqiu0804.github.io'
    }
  }]
};
```

生成一个靠谱的 token：

```bash
openssl rand -hex 32        # 复制输出，粘到上面 AUTH_TOKEN
```

### 4.2 启动 + 开机自启

```bash
chmod 600 ecosystem.config.js      # 里面是密钥，收紧权限
pm2 start ecosystem.config.js
pm2 save                            # 记住当前进程列表
pm2 startup                         # 按提示复制粘贴它输出的那行 sudo 命令
pm2 logs nexus-api --lines 20       # 看启动日志
```

### 4.3 本机自测

```bash
curl -i http://localhost:3457/api/entries
# 期望：HTTP/1.1 401 Unauthorized（说明服务活着，且鉴权生效）

curl -H "Authorization: Bearer <你的token>" http://localhost:3457/api/entries
# 期望：200 + JSON
```

---

## 5. 打通外部访问（10 分钟）★ 新手第一坑

服务在本机通了，但外面连不上——**99% 是安全组/防火墙没放行**。

**① 云控制台的安全组/防火墙**（这一步在网页上做）：

```
轻量应用服务器控制台 → 防火墙 → 添加规则
协议 TCP，端口 3457，来源 0.0.0.0/0，备注 nexus-api
```

**② 服务器自己的防火墙**（如果你开了 ufw）：

```bash
sudo ufw allow 22/tcp
sudo ufw allow 3457/tcp
sudo ufw enable
sudo ufw status
```

**③ 从本机（不是服务器）测试**：

```bash
curl -i http://<公网IP>:3457/api/entries     # 期望 401
```

手机浏览器打开 `http://<公网IP>:3457` → **应该能看到整个工作台**（服务端托管的 `../index.html`，同源、无跨域问题）。

> `401` 是**好消息**：说明网络通了、服务在跑、鉴权在工作。400/500 才要查。

---

## 6. 域名与 HTTPS（路线 B/C，按需）

### 6.1 注册 + 实名（0.5~2 个工作日）

阿里云/腾讯云域名注册 → 选 `.com` 或 `.cn` → **必须做实名认证**（上传身份证，否则域名会被暂停解析）。

### 6.2 加解析

```
域名控制台 → 解析 → 添加记录
记录类型 A，主机记录 nexus，记录值 <公网IP>
```

验证：`ping nexus.你的域名.com` 应返回你的服务器 IP。

### 6.3 备案（只在路线 C 需要）

国内服务器的 **80/443 端口必须备案**才能用（不备案会被运营商拦截）。

- 入口：服务器厂商的备案系统（腾讯云/阿里云 App 里就能提交）
- 材料：身份证、手机号核验、（个人备案）网站名称建议写「个人学习笔记」这类，**别写"官方/中国/湖南"等敏感词**
- 时长：1~3 周

**想跳过备案**：用非标端口（如 `https://nexus.你的域名.com:3457`）——非标端口不在拦截范围内。

### 6.4 申请免费证书（路线 B/C）

用 **DNS 验证**方式签发（不依赖 80 端口，非标端口也能用）：

```bash
sudo apt install -y certbot
# 手动 DNS 验证（会提示你去域名控制台加一条 TXT 记录）
sudo certbot certonly --manual --preferred-challenges dns -d nexus.你的域名.com
```

证书路径：`/etc/letsencrypt/live/nexus.你的域名.com/`

> 更省心的做法：把域名 DNS 托管到 **Cloudflare**（免费），开橙云代理 → 自动有 HTTPS，还隐藏源站 IP。代价是国内访问速度一般。

### 6.5 Nginx 反向代理

`/etc/nginx/sites-available/nexus`：

```nginx
server {
    listen 3457 ssl http2;                       # 非标端口 + HTTPS；备案后改 443
    server_name nexus.你的域名.com;

    ssl_certificate     /etc/letsencrypt/live/nexus.你的域名.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nexus.你的域名.com/privkey.pem;

    client_max_body_size 10m;                    # 日记批量导入可能较大

    location / {
        proxy_pass http://127.0.0.1:3457;        # 把端口腾出来给 Nginx，后端改 3458
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # AI 周报是 SSE 流式，必须关掉响应缓冲，否则打字机效果变成"憋 30 秒一次性吐出来"
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/nexus /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> **AI 周报的 Ollama 仍留在你自己的电脑上**：服务器 2G 内存跑不动 7B 模型，分工是「服务器管数据，PC 管算力」。

---

## 7. 前端接入（5 分钟）

打开工作台 → 「我的」→ 日记后端，把地址改成服务器地址：

| 访问方式 | API 地址填 | 说明 |
|---|---|---|
| 手机走服务器托管的前端 | `http://<IP>:3457`（或 `https://nexus.域名`） | 同源，最省事 |
| 电脑继续用 GitHub Pages | `https://nexus.域名` | **必须 HTTPS**，否则被混合内容拦截 |

改完点「测试连接」→ 写一篇日记 → 另一台设备打开能看到 = 通了。

---

## 8. 备份与恢复（20 分钟）★ 必做，不做等于定时炸弹

### 8.1 备份脚本

`~/backup-nexus.sh`：

```bash
#!/bin/bash
set -e
DB=~/nexus-core/server/journal.db
DIR=~/backups
mkdir -p "$DIR"
# 用 sqlite3 的 .backup（WAL 模式下直接 cp 可能拿到不一致的快照）
sqlite3 "$DB" ".backup '$DIR/journal-$(date +%F).db'"
# 只留最近 14 天
find "$DIR" -name 'journal-*.db' -mtime +14 -delete
echo "[$(date '+%F %T')] backup ok: $(ls -1 $DIR | wc -l) files"
```

```bash
chmod +x ~/backup-nexus.sh && ~/backup-nexus.sh && ls -lh ~/backups

# 每天凌晨 3 点自动备份
( crontab -l 2>/dev/null; echo "0 3 * * * /home/hxt/backup-nexus.sh >> /home/hxt/backups/backup.log 2>&1" ) | crontab -
```

### 8.2 异地一份（服务器挂了才是真的挂了）

```bash
# 方案一：定时拉回自己电脑（电脑上执行）
scp hxt@<IP>:~/backups/journal-*.db ~/nexus-backups/

# 方案二：传到对象存储（腾讯云 COS / 阿里云 OSS，装 coscmd/ossutil）
# 方案三：私有 GitHub 仓库（数据量小，够用）
```

### 8.3 恢复演练（每季度做一次）

```bash
pm2 stop nexus-api
cp ~/backups/journal-2026-09-13.db ~/nexus-core/server/journal.db
rm -f ~/nexus-core/server/journal.db-wal ~/nexus-core/server/journal.db-shm
pm2 start nexus-api
```

> 备份的**唯一价值**是"验证过能恢复"。没演练过的备份 = 心理安慰。
> 我们这周刚因为"没备份 + 覆盖式同步"丢过一份数据，别再交第二次学费。

---

## 9. 上线验收清单

- [ ] `http://IP:3457/api/entries` 返回 401（服务活着 + 鉴权生效）
- [ ] 带 token 的请求返回 200
- [ ] 手机浏览器能打开工作台并写入日记
- [ ] `sudo reboot` 后，服务自动恢复（`pm2 list` 显示 online）
- [ ] `date` 显示 Asia/Shanghai（+8）
- [ ] 备份脚本跑通，`~/backups` 里有文件，且**做过一次恢复演练**
- [ ] AUTH_TOKEN 不在 git 仓库里（只存在于 `ecosystem.config.js`，且 `chmod 600`）
- [ ] SSH 密码登录已关闭，root 不能直接登录
- [ ] 防火墙只放行了必要端口（22 / 3457）

---

## 10. 部署完之后的第一件事：自建同步，废掉 JSONBin

现在的痛点：任务/记账/习惯存在 localStorage，靠 JSONBin 做多设备同步——而 JSONBin 是个会抽风的第三方，我们已经在它身上丢过一次数据。

服务器到位后，**自己实现一个 KV 同步接口**就是最优解：

```
表：kv(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)
接口：GET  /api/kv          拉全量
      PUT  /api/kv          批量写入（body 里带 client_updated_at，服务端比对时间戳）
```

前端把现在的 `SyncManager` 从 JSONBin 换成自己的接口即可（约 30 行改动），顺带还能：
- 做**合并**而不是覆盖（本地有、云端没有的键保留）——这正是上次数据事故的根治方案
- 保留历史版本（每次写入存一行快照），**随时回滚**
- 手机/电脑真正实时同步

这一步既是 v4 的起点，也是把"数据主权"拿回自己手里。

---

## 附录：故障排查

| 症状 | 大概率原因 | 怎么查 |
|---|---|---|
| 外部访问超时 | 安全组没放行端口 | 控制台防火墙规则 |
| 401 | token 不对/没带 header | `curl -H "Authorization: Bearer xxx"` |
| 服务起了又挂 | 内存不足 / 端口占用 | `pm2 logs`、`free -h`、`ss -tlnp \| grep 3457` |
| 改了代码不生效 | 忘了重启 | `pm2 restart nexus-api` |
| 数据库锁住 | 两个进程同时开同一个 db | 确认只有一个 `nexus-api` 在跑 |
| 时间差 8 小时 | 服务器时区是 UTC | `sudo timedatectl set-timezone Asia/Shanghai` |
| AI 周报卡住不出字 | Nginx 缓冲了 SSE | 配置里加 `proxy_buffering off;` |

---

## 时间线与花费总览

```
第 0 天  买服务器（10 分钟，68~99 元）
第 0 天  初始化 + 部署 + 打通访问（约 2 小时，0 元）
第 0 天  ✅ 手机已经能用了（路线 A 完成，总花费 ≈ 服务器钱）
第 1~2 天  注册域名 + 实名（60~80 元）
第 3~20 天 备案（如走路线 C）
第 N 天  Nginx + HTTPS + 备份 + 验收（约 1 小时）
         ✅ 完整形态上线
```
