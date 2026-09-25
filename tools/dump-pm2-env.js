// 导出 pm2 里 nexus-api 的完整有效配置，用于生成 ecosystem.config.js。
// 关键：node_args 会把 Node 自己的启动参数也塞进来（-r esm 之类），
// 那不是「用户配置」，要剔除。另外 pm2 内部会注入一堆 PM2_*/NODE_APP_INSTANCE 等，
// 这些也不能写进配置文件，否则每次启动都会带上上一轮的痕迹。
const { execSync } = require('child_process');
const raw = execSync('pm2 jlist', { encoding: 'utf8' });
const arr = JSON.parse(raw);
const app = arr.find(x => x.name === 'nexus-api');
if (!app) { console.log('NOT FOUND'); process.exit(1); }
const e = app.pm2_env || {};

// pm2 自动注入的环境变量前缀，不属于用户配置
const INJECTED = /^(PM2_|NODE_APP_INSTANCE|_|PATH|PWD|HOME|SHELL|USER|LOGNAME|TERM|SHLVL|OLDPWD|LANG|LS_COLORS|HOSTNAME|npm_|NODE_|INIT_CWD|MAIL|MOTD)/;

console.log('=== 进程拓扑 ===');
console.log('name        :', app.name);
console.log('script      :', e.pm_exec_path);
console.log('cwd         :', e.pm_cwd);
console.log('interpreter :', e.exec_interpreter);
console.log('args        :', JSON.stringify(e.args));
console.log('node_args   :', JSON.stringify(e.node_args));
console.log('instances   :', e.instances);
console.log('exec_mode   :', e.exec_mode);
console.log('autorestart :', e.autorestart);
console.log('max_mem     :', e.max_memory_restart);
console.log('restart_delay:', e.restart_delay);
console.log('max_restarts:', e.max_restarts);
console.log('watch       :', e.watch);
console.log('unstable_restarts:', e.unstable_restarts);
console.log('kill_timeout:', e.kill_timeout);
console.log('listen_timeout:', e.listen_timeout);

console.log('\n=== 用户环境变量（已剔除 PM2 注入项）===');
const keys = Object.keys(e.env || {}).filter(k => !INJECTED.test(k)).sort();
for (const k of keys) {
  const v = String(e.env[k]);
  const hide = /TOKEN|SECRET|PASS|KEY/i.test(k);
  console.log('  ' + k + ' = ' + (hide ? (v.slice(0, 4) + '***(' + v.length + ' chars)') : v));
}

console.log('\n=== 备份/其他相关环境变量（可能有用的线索）===');
for (const k of ['BACKUP_DIR', 'OLLAMA_URL', 'DATA_DIR', 'DB_PATH', 'REPORT_DIR']) {
  const v = e.env && e.env[k];
  console.log('  ' + k + ': ' + (v || '(未设置 → 用代码里的默认值)'));
}
