#!/usr/bin/env node
/**
 * ecosystem-config.test.js —— pm2 配置的正确性测试
 *
 * 为什么值得专门测：这个文件是「换机器后能不能把服务起回来」的唯一依据。
 * 它写错了不会立刻报错，而是在某次迁移时才发现 AUTH_TOKEN 丢了 / 端口错了。
 * 所以把关键不变量固化成断言。
 *
 * 用临时目录模拟，不污染仓库；不依赖 pm2 是否安装。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CFG = path.join(ROOT, 'ecosystem.config.js');

// 测试必须与「机器上真实存在 server/.env」这件事隔离。
//
// 起因是个真实的坑：配置的优先级是 .env 文件 > 进程环境变量，这在线上是对的，
// 但测试往子进程里注入 AUTH_TOKEN=test-token 时，会被机器上真实的 server/.env
// 盖掉 —— 于是断言拿到的是真 token，既误报失败，又把真实密钥打印进输出。
// 解决：传一个不存在的路径，让配置只读那个空文件。
const NO_ENV_FILE = path.join(ROOT, 'tests', '.no-such-env-file');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

// 在隔离子进程里加载配置，这样可以控制 env。
//
// 踩坑记录：在这台 Windows 机器上 spawnSync(process.execPath, ...) 会抛
// EBUSY（进程被占用/防病毒扫描），无论跑什么都会失败。所以：
//   1. 优先找系统 node 做子进程（路径稳定、通常不被占用）
//   2. 彻底 spawn 不成就退回「在当前进程用 module 缓存隔离」的方式，
//      绝不因为环境问题让测试崩掉
function findNodeBin() {
  const cands = [
    process.env.SYSTEM_NODE,
    'C:/Program Files/nodejs/node.exe',
    process.platform === 'win32' ? null : '/usr/bin/node',
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

function loadConfigInProcess({ env = {} } = {}) {
  // 回退方案：清掉 require 缓存，临时改 process.env，再加载一次。
  // 配置里缺 token 时会调 process.exit(1) —— 那会直接杀掉测试进程，
  // 所以临时把它换成抛异常。
  //
  // 踩坑记录：只替换 process.exit 是不够的。自检的真实顺序是
  //   console.error('缺少 AUTH_TOKEN...')  →  process.exit(1)
  // 于是异常信息里只有 '__EXIT__1'，那句真正有用的提示跑到了 stderr，
  // 断言 /缺少 AUTH_TOKEN/ 就永远匹配不上（表现为「报错了但原因不明」）。
  // 所以这里把 console.error 也一并截流，拼进 message 里。
  //
  // 另一个坑：NEXUS_ENV_FILE 必须一起改，否则真实 .env 会盖掉注入的 token。
  const saved = {};
  const keys = ['AUTH_TOKEN', 'PORT', 'CORS_ORIGIN', 'NEXUS_ENV_FILE'];
  for (const k of keys) { saved[k] = process.env[k]; }
  const realExit = process.exit;
  const realErr = console.error;
  const lines = [];
  process.exit = (code) => { throw new Error('__EXIT__' + code); };
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  try {
    process.env.NEXUS_ENV_FILE = NO_ENV_FILE;
    for (const k of keys) {
      if (k === 'NEXUS_ENV_FILE') continue;
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    delete require.cache[require.resolve(CFG)];
    return { app: require(CFG).apps[0] };
  } catch (e) {
    return {
      refused: true,
      message: String(e && e.message || e) + '\n' + lines.join('\n'),
    };
  } finally {
    process.exit = realExit;
    console.error = realErr;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve(CFG)];
  }
}

let _nodeBin;
function loadConfig(opts) {
  if (_nodeBin === undefined) _nodeBin = findNodeBin();
  if (!_nodeBin) return loadConfigInProcess(opts);
  const { env = {} } = opts;
  const code = `
    const c = require(${JSON.stringify(CFG)});
    process.stdout.write('__OK__' + JSON.stringify(c.apps[0]));
  `;
  const child = require('child_process').spawnSync(_nodeBin, ['-e', code], {
    env: Object.assign({}, process.env, env, { NEXUS_ENV_FILE: NO_ENV_FILE }),
    encoding: 'utf8',
  });
  if (child.error || child.status === null) return loadConfigInProcess(opts);
  const out = child.stdout || '';
  if (out.startsWith('__OK__')) return { app: JSON.parse(out.slice(6)) };
  // 非 OK：可能是配置 process.exit(1) 或加载异常
  return { refused: true, message: (child.stderr || '') + out };
}

// 判断一次加载是否「因缺 token 而拒绝」。
// 两条路径都算拒绝成立：
//   1. 子进程路径 —— stderr 里有自检提示原文
//   2. 进程内回退 —— 走到 process.exit 被拦下的 __EXIT__1
//      （此时 message 里也带上了截流下来的 console.error 原文，双保险）
function refusedBecauseNoToken(r) {
  const all = (r.message || '') + '\n' + (r.error || '');
  return /缺少 AUTH_TOKEN/.test(all) || /__EXIT__1/.test(all);
}

console.log('【1】配置文件本身');
if (!fs.existsSync(CFG)) {
  bad('ecosystem.config.js 不存在');
  process.exit(1);
}
ok('ecosystem.config.js 存在');

// 关键：真实 .env 绝不能入库。
// 注意 Windows 上 spawnSync('git') 可能抛 EBUSY（防病毒/索引占用），
// 所以这里必须 try/catch —— 测试脚本自己要稳，不能因为环境问题崩掉。
let trackedEnv = null;
try {
  trackedEnv = execFileSync('git', ['ls-files', 'server/.env', '.env'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch (e) {
  console.log('  ~ 跳过（git 不可用：' + e.code + '）');
}
if (trackedEnv === '') ok('.env 未被 git 跟踪（密钥不入库）');
else if (trackedEnv) bad('.env 被 git 跟踪了！密钥会泄漏：' + trackedEnv);

// 模板必须入库，且不能含真实值
const tpl = path.join(ROOT, 'server', '.env.example');
if (!fs.existsSync(tpl)) bad('.env.example 模板缺失');
else {
  const t = fs.readFileSync(tpl, 'utf8');
  const hasValue = /^AUTH_TOKEN=.+$/m.test(t);
  if (hasValue) bad('.env.example 里 AUTH_TOKEN 竟然有值 —— 模板必须是空的');
  else ok('.env.example 存在且 AUTH_TOKEN 留空');
}

console.log('【2】无 AUTH_TOKEN 时必须拒绝启动');
{
  const r = loadConfig({ env: { AUTH_TOKEN: '' } });
  if (r.app) {
    bad('缺 token 时竟然加载成功了，配置没有自检');
  } else if (refusedBecauseNoToken(r)) {
    ok('缺 token 时报错退出，且提示清楚');
  } else {
    bad('缺 token 时报错了但原因不明：' + JSON.stringify(r).slice(0, 200));
  }
}

console.log('【2b】注入的 token 不能被机器上的真实 .env 盖掉');
{
  // 回归测试：曾经因为优先级是「.env > 进程环境变量」，
  // 在有 server/.env 的机器上测试会读到真 token —— 误报 + 泄漏密钥。
  const r = loadConfig({ env: { AUTH_TOKEN: 'injected-token-xyz' } });
  if (!r.app) {
    bad('加载失败：' + JSON.stringify(r).slice(0, 200));
  } else if (r.app.env.AUTH_TOKEN === 'injected-token-xyz') {
    ok('注入值生效（测试与真实 .env 已隔离）');
  } else if (/^[0-9a-f]{64}$/.test(String(r.app.env.AUTH_TOKEN))) {
    bad('读到了真实 .env 里的 token —— 隔离失效，且会把密钥打印出来');
  } else {
    bad('注入值被覆盖成了：' + String(r.app.env.AUTH_TOKEN).slice(0, 40));
  }
}

console.log('【3】有 AUTH_TOKEN 时的配置不变量');
{
  const r = loadConfig({ env: { AUTH_TOKEN: 'test-token-for-unit-test' } });
  if (!r.app) { bad('加载失败：' + JSON.stringify(r).slice(0, 200)); }
  else {
    const a = r.app;
    const checks = [
      ['name', a.name, 'nexus-api'],
      ['script', a.script, 'server.js'],
      ['exec_mode', a.exec_mode, 'fork'],
      ['instances', a.instances, 1],
      ['env.NODE_ENV', a.env.NODE_ENV, 'production'],
      ['env.PORT', a.env.PORT, '3458'],
      ['env.AUTH_TOKEN', a.env.AUTH_TOKEN, 'test-token-for-unit-test'],
      ['autorestart', a.autorestart, true],
      ['watch', a.watch, false],
    ];
    for (const [label, got, want] of checks) {
      if (got === want) ok(`${label} = ${JSON.stringify(got)}`);
      else bad(`${label} = ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
    }
    // cwd 必须以 server 结尾（相对路径依赖它）
    if (typeof a.cwd === 'string' && a.cwd.endsWith('server')) ok('cwd 指向 server/');
    else bad('cwd 不是 server/：' + a.cwd);

    // 端口不能是 Nginx 的 3457
    if (a.env.PORT !== '3457') ok('PORT 不是 Nginx 的 3457（没搞混内外端口）');
    else bad('PORT 误用了 Nginx 外部端口 3457');

    // kill_timeout 要够长，否则 SSE 长连接会被硬切
    if (Number(a.kill_timeout) >= 5000) ok(`kill_timeout = ${a.kill_timeout}ms（够 SSE 收尾）`);
    else bad('kill_timeout 太短，SSE 会被 SIGKILL 硬切');

    // CORS 里不该再有已废弃的 GitHub Pages 来源
    if (!String(a.env.CORS_ORIGIN || '').includes('github.io')) ok('CORS 已移除 github.io');
    else bad('CORS 仍含 github.io（GH Pages 已弃用）');

    // 主域名必须在白名单里
    if (String(a.env.CORS_ORIGIN || '').includes('nexus.kotete.xyz')) ok('CORS 含主域名 nexus.kotete.xyz');
    else bad('CORS 缺少主域名');
  }
}

console.log('\n────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
