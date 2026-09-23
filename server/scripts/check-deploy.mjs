#!/usr/bin/env node
/**
 * 部署自检 —— 一键排查「配置没生效 / 部署后行为不对」类问题
 *
 * 为什么需要它：部署阶段最难查的不是代码报错，而是**改了配置却没生效**。
 * dotenv 读不到文件时是静默的，NODE_ENV 没传进去会加载错的文件，
 * ALLOWED_ORIGINS 白名单不含部署域名会把同源请求也拒掉（表现为登录报 Not allowed by CORS）……
 * 这些问题的共同点是：代码没错、日志不响，全靠人去猜。
 *
 * 用法：
 *   node scripts/check-deploy.mjs                        # 全套检查（含运行时探测）
 *   node scripts/check-deploy.mjs --host=ai-audit.xunnan.net   # 指定线上域名，按它推演 CORS 行为
 *   node scripts/check-deploy.mjs --port=3003 --no-probe # 只做静态检查，不连服务
 *
 * 退出码：0 = 无致命问题，1 = 存在 ❌ 项
 */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');

// ---------- 参数 ----------
const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const HAS = (name) => args.includes(`--${name}`) || args.some(a => a.startsWith(`--${name}=`));

// ---------- 输出 ----------
const results = [];
const PASS = (title, detail = '') => results.push({ level: 'pass', title, detail });
const WARN = (title, detail = '') => results.push({ level: 'warn', title, detail });
const FAIL = (title, detail = '') => results.push({ level: 'fail', title, detail });
const INFO = (title, detail = '') => results.push({ level: 'info', title, detail });
// 小节标题也进队列，保证最终输出顺序与检查顺序一致
const section = (name) => results.push({ level: 'section', title: name });

function printResults() {
  const icon = { pass: '\x1b[32m✅\x1b[0m', warn: '\x1b[33m⚠️ \x1b[0m', fail: '\x1b[31m❌\x1b[0m', info: '\x1b[36mℹ️ \x1b[0m' };
  for (const r of results) {
    if (r.level === 'section') {
      console.log(`\n\x1b[1m${r.title}\x1b[0m`);
      continue;
    }
    console.log(`${icon[r.level]} ${r.title}`);
    if (r.detail) {
      for (const line of String(r.detail).split('\n')) console.log(`     ${line}`);
    }
  }
  const n = (lv) => results.filter(r => r.level === lv).length;
  console.log(
    `\n\x1b[1m汇总\x1b[0m  ✅ ${n('pass')}   ⚠️  ${n('warn')}   ❌ ${n('fail')}`
  );
}

// ---------- 1. 运行环境 ----------
section('1) 运行环境');
INFO(`Node ${process.version}  ·  ${process.platform} ${process.arch}`);
INFO(`服务目录 ${SERVER_DIR}`);

// ---------- 2. 环境文件 ----------
section('2) 环境变量文件');

const NODE_ENV = process.env.NODE_ENV;
const ENV_CANDIDATES = ['.env', '.env.development', '.env.production'];
const fileState = {};
for (const f of ENV_CANDIDATES) {
  const p = path.join(SERVER_DIR, f);
  fileState[f] = {
    exists: fs.existsSync(p),
    keys: fs.existsSync(p) ? parseKeys(p) : []
  };
}

/** 仅取出 key 名，不读值（避免把密钥打印出来） */
function parseKeys(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  return raw.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => l.slice(0, l.indexOf('=')).trim());
}

// server.js 的加载规则
const targetEnvFile = NODE_ENV === 'production'
  ? '.env.production'
  : NODE_ENV === 'development'
    ? '.env.development'
    : '.env';

INFO(`NODE_ENV = ${NODE_ENV || '(未设置)'}`);
INFO(`将加载   = ${targetEnvFile}`);

for (const f of ENV_CANDIDATES) {
  const st = fileState[f];
  const mark = f === targetEnvFile ? ' ← 本次实际加载' : '';
  if (st.exists) INFO(`${f.padEnd(18)} 存在，${st.keys.length} 个变量${mark}`);
  else console.log(`\x1b[36mℹ️ \x1b[0m ${f.padEnd(18)} 不存在${mark}`);
}

if (!fileState[targetEnvFile].exists) {
  FAIL(
    `实际要加载的 ${targetEnvFile} 不存在`,
    NODE_ENV === 'production'
      ? '生产部署必须手动创建它（.env* 都在 .gitignore 里，不会随代码上传）。\n' +
        '  最省事的做法：cp .env.production.example .env.production 再改值。'
      : '本次启动只有系统环境变量可用，数据库/密钥等配置大概率是空的。'
  );
} else {
  PASS(`${targetEnvFile} 存在`);
}

// 键完整性：与变量最全的文件对比，找出缺失项
const allKeys = new Set(ENV_CANDIDATES.flatMap(f => fileState[f].keys));
const targetKeys = new Set(fileState[targetEnvFile].keys);
const missing = [...allKeys].filter(k => !targetKeys.has(k));
if (missing.length) {
  WARN(
    `${targetEnvFile} 比其它环境文件少 ${missing.length} 个变量`,
    `缺失：${missing.join(', ')}\n` +
    '  若这些值在别处另有来源（如模型链存在数据库）可忽略，否则会出现「某个功能莫名不可用」。'
  );
}

// ---------- 3. 关键变量 ----------
section('3) 关键配置');

// 按 server.js 同样的规则加载目标 env 文件，取实际生效值
const loaded = dotenv.parse(fs.readFileSync(path.join(SERVER_DIR, targetEnvFile), 'utf8'));
const cfg = { ...loaded, ...process.env };   // 进程环境变量优先（与 dotenv 默认行为一致）

const REQUIRED = [
  ['JWT_SECRET', '未配置 → 使用内置默认密钥，重启后所有登录态失效，且存在伪造风险'],
  ['DB_HOST', '未配置 → 数据库连接会失败'],
  ['DB_USER', '未配置 → 数据库连接会失败'],
  ['DB_NAME', '未配置 → 数据库连接会失败'],
];
for (const [k, why] of REQUIRED) {
  if (cfg[k]) PASS(`${k} 已配置`);
  else FAIL(`${k} 缺失`, why);
}

const OPTIONAL = [
  ['ARK_API_KEY', '未配置 → 模型调用依赖数据库里的模型链配置提供密钥'],
  ['OCR_KEY', '未配置 → 资料解析（OCR）不可用'],
];
for (const [k, why] of OPTIONAL) {
  if (cfg[k]) PASS(`${k} 已配置`);
  else WARN(`${k} 为空`, why);
}

// CORS 白名单
const ALLOWED = String(cfg.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ORIGIN_GLOBS = ALLOWED.filter(o => o.includes('*') && o !== '*');
if (!ALLOWED.length) {
  INFO('ALLOWED_ORIGINS 为空 → 仅同源请求可访问（前后端同域部署属正常，无需配置）');
} else {
  INFO(`ALLOWED_ORIGINS = ${ALLOWED.join(', ')}`);
  if (ORIGIN_GLOBS.length) INFO(`含 ${ORIGIN_GLOBS.length} 条通配规则：${ORIGIN_GLOBS.join(', ')}`);
  if (ALLOWED.includes('*')) WARN('ALLOWED_ORIGINS 包含 * → 放行全部来源', '仅建议内网/自用环境这样配置');
}
INFO(`TRUST_PROXY = ${cfg.TRUST_PROXY || 'loopback（默认值）'}`);

// ---------- 4. 运行时探测 ----------
const PORT = Number(argVal('port', cfg.PORT || 3003));
const DEPLOY_HOST = argVal('host', null);
const PROBE_PATH = '/api/__cors_probe__';   // 故意用一个不存在的路径：不触碰业务逻辑，也不触发限流

const probeDisabled = HAS('no-probe');

section('4) 服务探测');

if (probeDisabled) {
  INFO('已跳过（--no-probe）');
} else {
  const listening = await isPortListening(PORT);
  if (!listening) {
    WARN(`端口 ${PORT} 未监听`, '服务没在运行。启动后再跑本脚本，才能验证 CORS 行为。');
  } else {
    PASS(`端口 ${PORT} 正在监听`);

    const sameOriginHost = DEPLOY_HOST || `127.0.0.1:${PORT}`;
    const cases = [
      {
        name: `同源请求（Host=${sameOriginHost}）`,
        host: sameOriginHost,
        origin: `http${DEPLOY_HOST ? 's' : ''}://${sameOriginHost}`,
        expect: 'allow',
        why: '同源请求本就与 CORS 无关，必须放行；被拒说明服务跑的是旧代码或需重启'
      },
      {
        name: '同域名不同协议/端口（模拟 Nginx 反代 + HTTPS 终结）',
        host: `${DEPLOY_HOST || 'audit.example.com'}`,
        origin: `https://${DEPLOY_HOST || 'audit.example.com'}:8443`,
        expect: 'allow',
        why: '只比主机名，忽略协议与端口'
      },
      {
        name: '白名单外的第三方来源',
        host: `${DEPLOY_HOST || 'audit.example.com'}`,
        origin: 'https://evil.example.net',
        expect: ALLOWED.includes('*') ? 'allow' : 'deny',
        why: ALLOWED.includes('*') ? '配置了 * ，放行是预期行为' : '必须拒绝，否则白名单形同虚设'
      }
    ];

    // 若配置了通配，补一条通配命中用例
    for (const glob of ORIGIN_GLOBS) {
      const sample = glob.includes('://')
        ? glob.replace('*', 'sub')
        : `https://sub.${glob.replace(/^\*\./, '')}`;
      cases.push({
        name: `通配命中（${glob}）`,
        host: DEPLOY_HOST || 'audit.example.com',
        origin: sample,
        expect: 'allow',
        why: '应被通配规则放行（若被拒，检查通配写法是否含协议前缀）'
      });
    }

    for (const c of cases) {
      const r = await probe(PORT, { host: c.host, origin: c.origin, method: 'GET', path: PROBE_PATH });
      if (r.error) {
        FAIL(`${c.name} → 请求失败`, r.error);
        continue;
      }
      // 判据用「有没有回显 Access-Control-Allow-Origin」，不用状态码：
      // 被拒时不同实现返回的状态码不一样（旧实现 400、新实现 403），
      // 但只要是放行，服务端必然会回显该头。
      const acao = r.headers['access-control-allow-origin'];
      const denied = !acao;
      const actual = denied ? 'deny' : 'allow';

      if (actual === c.expect) {
        const extra = c.expect === 'allow' && acao
          ? `（回显 Access-Control-Allow-Origin: ${acao}）`
          : '';
        PASS(`${c.name} → ${c.expect === 'allow' ? '放行' : '拒绝'} ${extra}`);
      } else {
        FAIL(
          `${c.name} → 期望${c.expect === 'allow' ? '放行' : '拒绝'}，实际${denied ? '拒绝' : '放行'}（HTTP ${r.status}）`,
          c.why + (r.body ? `\n  响应体：${r.body.slice(0, 200)}` : '')
        );
      }
    }

    // 预检请求
    const pre = await probe(PORT, {
      host: DEPLOY_HOST || `127.0.0.1:${PORT}`,
      origin: `http${DEPLOY_HOST ? 's' : ''}://${DEPLOY_HOST || `127.0.0.1:${PORT}`}`,
      method: 'OPTIONS',
      path: PROBE_PATH,
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' }
    });
    if (pre.error) FAIL('预检请求（OPTIONS）→ 请求失败', pre.error);
    else if (pre.status === 204 && pre.headers['access-control-allow-methods']) {
      PASS(`预检请求（OPTIONS）→ 204，Allow-Methods: ${pre.headers['access-control-allow-methods']}`);
    } else {
      FAIL(`预检请求（OPTIONS）→ 期望 204 且带 Allow-Methods，实际 HTTP ${pre.status}`,
        '预检不通过会让所有带 Authorization 头的跨域请求直接失败。');
    }
  }
}

// ---------- 5. 结论 ----------
const failed = results.filter(r => r.level === 'fail');
if (failed.length) {
  section('结论');
  console.log('发现 ' + failed.length + ' 个需要处理的问题。若涉及 CORS，常见原因是：');
  console.log('  · 服务跑的还是旧代码 → 重启服务');
  console.log('  · 部署域名不在白名单且服务端未做同源放行 → 升级到包含同源放行逻辑的版本');
  console.log('  · NODE_ENV 未通过启动参数传入 → PM2 用 --env production，systemd 用 Environment=NODE_ENV=production');
}

printResults();
process.exit(failed.length ? 1 : 0);

// ================= 工具函数 =================

function isPortListening(port) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
  });
}

/** 直接发原始 HTTP 请求，才能自由设置 Host 头（fetch/undici 会拦掉 Host） */
function probe(port, { host, origin, method, path: p, headers = {} }) {
  return new Promise(resolve => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: p,
        method,
        headers: { Host: host, Origin: origin, ...headers },
        timeout: 5000
      },
      res => {
        let body = '';
        res.on('data', c => { if (body.length < 2000) body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ error: '请求超时（5s）' }); });
    req.on('error', e => resolve({ error: e.message }));
    req.end();
  });
}
