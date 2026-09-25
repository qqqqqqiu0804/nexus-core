/**
 * ecosystem.config.js —— nexus-api 的正式 pm2 配置
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要有这个文件
 *
 * 在这之前，nexus-api 是直接用 pm2 CLI 起的（`pm2 start server.js --name nexus-api --env ...`），
 * 环境变量只存在于 /root/.pm2/dump.pm2 里。问题：
 *   1. 换机器 / 重装 pm2 → 配置全丢，而且没有记录能还原（AUTH_TOKEN 会永久丢失）
 *   2. `pm2 restart` 到底带了哪套环境变量，全凭 dump 里的残留
 *   3. 读代码的人不知道线上跑的是什么参数
 * 现在配置进仓库，一眼可见、可复现、可 review。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 密钥处理（重要）
 *
 * **AUTH_TOKEN 不写在这个文件里。** 它放在 server/.env，那个文件被 .gitignore 排除。
 * 本文件只负责「读进来」，所以它可以安全地入库。
 *
 * 首次部署 / 换机器时，手动创建 server/.env：
 *   echo 'AUTH_TOKEN=<64位随机十六进制>' > server/.env
 *   chmod 600 server/.env
 * 生成新 token：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * ─────────────────────────────────────────────────────────────────────
 * 用法
 *
 *   cd /root/nexus-core
 *   pm2 start ecosystem.config.js          # 首次
 *   pm2 reload nexus-api                   # 平滑重载（改配置后）
 *   pm2 restart nexus-api                  # 硬重启
 *   pm2 save                               # 固化到 dump，开机自启用
 *
 * ⚠️ 端口是 3458（Node 内部），不要和 Nginx 外部的 3457 搞混。
 */

const fs = require('fs');
const path = require('path');

// 极简 .env 读取：不引 dotenv（这个项目刻意保持零依赖）。
// 只支持 KEY=VALUE 一行一条，忽略空行和 # 注释，值两端的引号会被去掉。
function loadEnvFile(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;  // 文件不存在是正常的（比如在本地跑测试时）
  }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

// server/.env 优先；没有就退回仓库根的 .env（两种位置都认）
const SERVER_DIR = path.join(__dirname, 'server');

// 测试逃生门：设了 NEXUS_ENV_FILE 就只读那一个文件，跳过默认的 .env 探测。
//
// 为什么必须有：默认优先级是「.env 文件 > 进程环境变量」，这在线上是对的，
// 但让测试无法注入假 token —— 只要机器上存在 server/.env（每个真实部署都有），
// 传进去的 AUTH_TOKEN 就会被文件里的真值盖掉。后果有两个，都不好：
//   1. 测出来的不是被测对象，断言会误报
//   2. 断言失败时会把**真实 token 打印到测试输出里**
// 所以这里开一个显式口子：测试传 NEXUS_ENV_FILE=/tmp/不存在 就得到干净环境。
const ENV_FILE_OVERRIDE = process.env.NEXUS_ENV_FILE;
const fileEnv = ENV_FILE_OVERRIDE !== undefined
  ? loadEnvFile(ENV_FILE_OVERRIDE)   // 只读指定文件（传个不存在的路径即「无文件」）
  : Object.assign(
      {},
      loadEnvFile(path.join(__dirname, '.env')),
      loadEnvFile(path.join(SERVER_DIR, '.env'))
    );

// 优先级：.env 文件 > 进程已有环境变量 > 配置里的默认值。
// 这样「临时覆盖」和「持久配置」两套都工作。
//
// 注意 `||` 会把空字符串当成「没有」：AUTH_TOKEN='' 会继续往下取。
// 这正是自检能生效的原因 —— 测试传空 token 时不会停在空串上。
const pick = (key, fallback) => fileEnv[key] || process.env[key] || fallback;

const PORT = pick('PORT', '3458');
const AUTH_TOKEN = pick('AUTH_TOKEN', '');
const CORS_ORIGIN = pick(
  'CORS_ORIGIN',
  [
    'https://nexus.kotete.xyz',       // 主域名（手机主要走这个）
    'https://kotete.xyz',
    'http://kotete.xyz:908',
    'https://kotete.xyz:908',
    'http://8.134.190.49:908',        // 源站 IP 直连（排查用）
  ].join(',')
);

// 启动前自检：没有 token 就直接报错退出，不要让 pm2 反复重启刷日志。
// server.js 自己也会检查，但那是在进程内；这里提前拦住能给出更清楚的提示。
if (!AUTH_TOKEN) {
  console.error(
    '\n[ecosystem] 缺少 AUTH_TOKEN。\n' +
    '  请在 ' + path.join(SERVER_DIR, '.env') + ' 里写一行：\n' +
    '    AUTH_TOKEN=<64位随机十六进制>\n' +
    '  生成：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n'
  );
  process.exit(1);
}

module.exports = {
  apps: [{
    name: 'nexus-api',

    // cwd 用 server/ 而不是仓库根：server.js 里的相对路径（journal.db、data/files）
    // 都是按 __dirname 算的，但 __dirname/data 这种默认值依赖 cwd 保持一致。
    // 线上实测就是 server/，照抄以保持一致。
    cwd: SERVER_DIR,
    script: 'server.js',

    // fork 模式单实例：用了 node:sqlite 的 DatabaseSync，
    // 多实例会各自持有数据库连接，WAL 下能跑但没必要，单人用量也吃不满一个核。
    exec_mode: 'fork',
    instances: 1,

    // 环境变量：全部显式写出来，不再依赖 dump
    env: {
      NODE_ENV: 'production',   // 关掉 Express 的堆栈回显（配合 server.js 的全局 error handler）
      PORT: String(PORT),
      AUTH_TOKEN: AUTH_TOKEN,
      CORS_ORIGIN: CORS_ORIGIN,
    },

    autorestart: true,
    // 崩了就重启，但不要疯狂重启：连崩 10 次说明是配置/代码问题，重试无意义。
    max_restarts: 10,
    restart_delay: 2000,        // 重启前等 2s，避免日志刷屏
    // 2C2G 机器，跑到 400MB 就重启（正常运行时约 25~35MB，这是兜底）
    max_memory_restart: '400M',

    // 日志：默认写 ~/.pm2/logs/nexus-api-{out,err}.log，
    // 加日期前缀方便排查「哪天开始出问题」
    merge_logs: true,
    time: true,                 // 日志行前加时间戳

    // 给 10s 优雅退出：SSE 长连接需要时间收尾，不然会被 SIGKILL 直接切断
    kill_timeout: 10000,

    // 不用 watch：改动靠 deploy.sh 走「测试→重启」，不要文件一动就重启
    watch: false,
  }],
};
