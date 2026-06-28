# NEXUS CORE

赛博朋克风格单文件 HTML 任务管理面板，支持跨设备云同步。

## 在线访问

- GitHub Pages: https://qqqqqqiu0804.github.io/nexus-core/
- CodeBuddy: https://ba15bbd8ec254e5a89bcdddef611c810.app.codebuddy.work

## 功能特性

- **赛博朋克 UI**：霓虹色调、故障特效、终端风格交互
- **任务管理**：创建/编辑/删除任务，支持优先级、标签、截止日期
- **悬赏板**：每日刷新的随机挑战，双倍奖励
- **番茄钟**：专注计时器，关联任务自动推进进度
- **积分商店**：用积分兑换奖励（看剧、游戏、奶茶等）
- **成就系统**：15 个成就解锁挑战
- **数据看板**：完成趋势、类型分布、本周统计

## 云同步设置（基于 jsonbin.io）

1. 访问 [jsonbin.io](https://jsonbin.io/login) → 注册/登录
2. 点击 **API Keys** → 复制你的 Master Key（以 `$2a$` 开头）
3. 打开本应用 → 点击右上角 **云同步** 按钮
4. 粘贴 API Key → **留空 Bin ID** → 点击「保存并连接」
5. 系统自动创建云端存储，弹窗显示 Bin ID
6. 复制 Bin ID，在另一台设备填入相同的 API Key + Bin ID → 连接
7. 之后数据自动同步，无需手动操作

## 同步机制

- 数据变更后 3 秒自动上传（防抖）
- 启动时自动拉取云端数据
- 冲突检测：基于时间戳，Last Write Wins
- 支持手动操作：立即同步 / 仅上传 / 仅下载 / 断开连接

## 使用方式

直接在浏览器中打开 `nexus-core.html` 即可使用，无需安装任何依赖。

## 技术栈

- 纯 HTML + CSS + JavaScript（单文件，无外部依赖）
- jsonbin.io（云同步后端）
- localStorage（本地持久化）
