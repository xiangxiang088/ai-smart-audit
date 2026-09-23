require('express-async-errors');

// 根据 NODE_ENV 加载对应环境变量文件：.env.production / .env.development / .env
const path = require('path');
const fs = require('fs');
const envFile = process.env.NODE_ENV === 'production'
  ? '.env.production'
  : process.env.NODE_ENV === 'development'
    ? '.env.development'
    : '.env';
const envPath = path.join(__dirname, envFile);
// 文件缺失必须显式告警：dotenv 读不到文件时是**静默**的，
// 结果数据库、密钥、CORS 白名单全部为空，表现为各种莫名其妙的运行期错误。
// （注意 .env* 都在 .gitignore 里，不会随代码一起部署，服务器上必须手动创建。）
const envFileExists = fs.existsSync(envPath);
if (!envFileExists) {
  console.warn(`⚠️  环境变量文件 ${envFile} 不存在，本次启动仅使用系统环境变量`);
}
require('dotenv').config({ path: envPath });
const LOADED_ENV_FILE = envFileExists ? envFile : `(缺失: ${envFile})`;

const express = require('express');
// 注：CORS 未使用 cors 中间件，见下方「CORS 配置」处自实现（需读取 req.headers.host 做同源判断）
const crypto = require('crypto');

// ===== 静态资源版本指纹（解决微信/浏览器缓存问题）=====
// 使用文件内容 MD5 作为版本号，部署后文件内容变了就自动失效（不依赖文件修改时间）
const publicDir = path.join(__dirname, '../public');
const pcDir     = path.join(__dirname, '../pc');

// 内存缓存：{ filePath -> { size, mtimeMs, hash } }，避免每次请求重算 MD5
const _assetHashCache = new Map();

function getAssetVersion(assetPath) {
  // assetPath 如 /pc/js/pc-common.js 或 /css/common.css
  let filePath;
  if (assetPath.startsWith('/pc/')) {
    filePath = path.join(pcDir, assetPath.slice(3));
  } else {
    filePath = path.join(publicDir, assetPath);
  }
  try {
    const stat = fs.statSync(filePath);
    const cached = _assetHashCache.get(filePath);
    // 若文件大小和 mtime 均未变，直接复用缓存 hash
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.hash;
    }
    // 读取文件内容算 MD5 前8位
    const content = fs.readFileSync(filePath);
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
    _assetHashCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
    return hash;
  } catch {
    return null;
  }
}

const app = express();
const PORT = process.env.PORT || 3003;

// ===== 安全中间件 =====

// 安全响应头（类似helmet的核心功能）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // 禁用地理位置，摄像头/麦克风允许（语音记账/OCR拍照需要）
  res.setHeader('Permissions-Policy', 'geolocation=()');
  next();
});

// ===== CORS 配置 =====
// 本系统前端调用后端用的是**相对路径**（`const API = '/api'`），正常情况下是同源请求，
// 浏览器根本不做 CORS 校验。但浏览器对 POST/PUT 等请求仍会附带 Origin 头，
// 若服务端对同源请求也套白名单，那么部署域名 / IP / 端口一变（换服务器、上 HTTPS、走 Nginx 反代）
// 就会报「Not allowed by CORS」——一个纯粹的部署配置问题，却被表现成登录失败。
// 因此这里按两条路径放行：
//   1) 同源请求：Origin 的 hostname 与请求 Host 的 hostname 相同 → 直接放行。
//      经 Nginx 反代、HTTPS 在网关终止的场景同样成立（只比主机名，不比协议与端口）。
//   2) 跨域请求：在 ALLOWED_ORIGINS 显式登记，支持逗号分隔、*.example.com 通配子域、* 全放行。
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ALLOW_ALL = ALLOWED_ORIGINS.includes('*');

// 通配规则：* 可出现在任意位置，匹配该位置的任意非 / 字符。
//   https://*.example.com  → 只匹配 https 协议下 example.com 的任意层级子域
//   *.example.com          → 不含协议时自动补成 *://*.example.com
// 通配作用于「完整来源」字符串，因此 https://evil-xunnan.net、https://xunnan.net.evil.com
// 这类后缀/前缀拼接都命中不了 *.xunnan.net。
//
// 注意：配置里写的一定是完整来源（带 https://），所以不能用 startsWith('*.') 之类的
// 前缀判断来识别通配 —— 那样会把 https://*.example.com 当成精确匹配项，规则静默失效。
function compileOriginGlob(pattern) {
  if (!pattern.includes('*')) return null;
  const withScheme = pattern.includes('://') ? pattern : '*://' + pattern;
  const rx = '^' + withScheme
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')   // 转义正则元字符（* 留到下一步单独处理）
    .replace(/\*/g, '[^/]*')
    + '$';
  return new RegExp(rx, 'i');
}

const originGlobs  = ALLOWED_ORIGINS.map(compileOriginGlob).filter(Boolean);
const exactOrigins = ALLOWED_ORIGINS.filter(o => o !== '*' && !o.includes('*'));

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/** 判断某次请求的 CORS 是否放行，返回 { ok, reason } 便于日志定位 */
function checkOrigin(origin, reqHost) {
  if (!origin) return { ok: true, reason: 'no-origin' };  // curl / 服务端调用 / 同源简单请求
  if (ALLOW_ALL) return { ok: true, reason: 'allow-all' };

  const originHost = hostnameOf(origin);
  // 同源判定（含反向代理场景）：只比主机名，忽略协议与端口差异
  const reqHostname = String(reqHost || '').split(':')[0].toLowerCase();
  if (originHost && reqHostname && originHost === reqHostname) return { ok: true, reason: 'same-origin' };

  if (exactOrigins.includes(origin)) return { ok: true, reason: 'whitelist' };
  // 通配匹配的是「完整来源」，不是 hostname
  if (originGlobs.some(re => re.test(origin))) return { ok: true, reason: 'whitelist-glob' };
  return { ok: false, reason: 'not-allowed' };
}

// 这里自己实现而不用 cors 中间件：同源判断需要读 req.headers.host，
// 而 cors 的 origin 回调签名是 (origin, callback)，拿不到 req。
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const verdict = checkOrigin(origin, req.headers.host);

  if (!verdict.ok) {
    console.warn(
      `[cors] 拒绝来源 ${origin}（Host: ${req.headers.host}）；` +
      `白名单: ${ALLOWED_ORIGINS.join(', ') || '(空)'}`
    );
    // 403 + 可操作提示：这是部署配置问题，不是业务错误，别让排查者去翻代码
    return res.status(403).json({
      error: '跨域请求被拒绝：请求来源不在允许范围内。若为私有化部署，请检查服务端 ALLOWED_ORIGINS 配置。'
    });
  }

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);  // 回显具体来源（credentials=true 时不能用 *）
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');                       // 避免 CDN / 代理把响应串给别的来源
  }

  // 预检请求到此结束，不进入业务路由
  if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] || 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '7200');       // 预检结果缓存 2 小时
    return res.status(204).end();
  }

  next();
});

// 通用内存限流中间件工厂
function createRateLimiter(maxAttempts, windowMs, message) {
  const attempts = new Map();
  // 定期清理
  setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of attempts) {
      const recent = times.filter(t => now - t < windowMs);
      if (recent.length === 0) attempts.delete(ip);
      else attempts.set(ip, recent);
    }
  }, 5 * 60 * 1000);
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const times = attempts.get(ip) || [];
    const recent = times.filter(t => now - t < windowMs);
    if (recent.length >= maxAttempts) {
      return res.status(429).json({ error: message || '请求过于频繁，请稍后再试' });
    }
    recent.push(now);
    attempts.set(ip, recent);
    next();
  };
}

// 各接口限流策略
app.use('/api/auth/login', createRateLimiter(10, 60 * 1000, '登录尝试次数过多，请1分钟后再试'));
app.use('/api/auth/register', createRateLimiter(3, 60 * 1000, '注册过于频繁，请1分钟后再试'));
app.use('/api/auth/change-password', createRateLimiter(5, 10 * 60 * 1000, '操作过于频繁，请10分钟后再试'));
app.use('/api/ai', createRateLimiter(20, 60 * 1000, 'AI请求过于频繁，请1分钟后再试'));
app.use('/api/feedback', createRateLimiter(10, 60 * 1000, '反馈提交过于频繁，请1分钟后再试'));
app.use('/api/notice', createRateLimiter(60, 60 * 1000, '请求过于频繁，请稍后再试'));
app.use('/api/notifications', createRateLimiter(60, 60 * 1000, '请求过于频繁，请稍后再试'));

// 教育系统AI分析限流（已废弃，改造为工程审计系统）
// 注意：必须在对应路由 app.use(path, router) 挂载之前注册，
// 否则路由已 res.json() 响应后，Express 不会再执行这里的中间件（限流将完全失效）
// app.use('/api/edu/error-analysis', createRateLimiter(20, 60 * 1000, 'AI分析请求过于频繁，请1分钟后再试'));
// app.use('/api/edu/tutoring', createRateLimiter(20, 60 * 1000, 'AI请求过于频繁，请1分钟后再试'));
// app.use('/api/edu/analytics', createRateLimiter(20, 60 * 1000, 'AI分析请求过于频繁，请1分钟后再试'));
// app.use('/api/edu/assessment', createRateLimiter(30, 60 * 1000, '评测请求过于频繁，请1分钟后再试'));
// app.use('/api/edu/learning-engine', createRateLimiter(30, 60 * 1000, '请求过于频繁，请1分钟后再试'));

// 信任反向代理：必须早于任何读取 req.ip 的中间件（限流、操作日志）。
// 默认 'loopback'（只信任来自本机的代理，也即 Nginx 与 Node 同机部署的常见形态）——
// 'loopback' 不会信任外网伪造的 X-Forwarded-For，因此无条件启用是安全的。
// 原先只在 NODE_ENV=production 时启用，一旦部署时忘记设置该变量，
// 所有请求的 req.ip 都会是代理 IP，导致登录限流被全站共享、操作日志 IP 失真。
// 若 Nginx 与 Node 不同机，用 TRUST_PROXY 指定代理地址或网段（如 TRUST_PROXY=192.168.1.10）。
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';
app.set('trust proxy', TRUST_PROXY);

// 中间件
app.use(express.json({ limit: '10mb' }));

// HTML 文件下发时注入资源版本号（?v=hash），解决微信/浏览器缓存不更新问题
app.use((req, res, next) => {
  if (!req.path.endsWith('.html')) return next();

  let filePath;
  if (req.path.startsWith('/pc/')) {
    // PC端：/pc/index.html → pcDir/index.html
    filePath = path.join(pcDir, req.path.slice(3));
  } else {
    filePath = path.join(publicDir, req.path);
  }
  if (!fs.existsSync(filePath)) return next();

  let html = fs.readFileSync(filePath, 'utf8');
  // 注入 css/js 版本号，支持相对路径和绝对路径（/js/、/pc/js/、/css/、/pc/css/）
  html = html.replace(/(href|src)="((?:\/)?(?:pc\/)?(?:css|js)\/[^"?]+\.(?:css|js))"/g, (match, attr, assetPath) => {
    const key = assetPath.startsWith('/') ? assetPath : '/' + assetPath;
    const ver = getAssetVersion(key);
    return ver ? `${attr}="${assetPath}?v=${ver}"` : match;
  });
  // 微信/iOS WebView 必须同时设置这三个头才能彻底禁止 HTML 缓存
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
});

app.use(express.static(path.join(__dirname, '../public'), {
  // 禁止自动吐出 public/index.html（旧移动首页），让根路由 '/' 的重定向生效
  index: false,
  // HTML 完全不缓存；带 ?v= 指纹的 CSS/JS 可强缓存1年；其余每次校验
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath, stat) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
      // 有 ?v= 指纹时由版本号保证唯一性，可长期缓存
      // express.static 不感知 query，这里统一用 no-cache + must-revalidate
      // 让浏览器每次必须向服务器校验（304=快速复用，200=获取新内容）
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// PC端静态资源
app.use('/pc', express.static(path.join(__dirname, '../pc'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath, stat) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// 用户上传文件（按年月日分类存储在根目录 uploads/）
app.use('/uploads', express.static(path.join(__dirname, '../uploads'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30天
  }
}));

// 学科封面图片（covers/ 目录，按学段分类）
app.use('/covers', express.static(path.join(__dirname, '../covers'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30天
  }
}));

// API路由模块化

// ===== 系统基础路由（保留）=====
app.use('/api/auth', require('./routes/auth'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/notice', require('./routes/notice'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/version', require('./routes/version'));

// ===== 系统管理路由（用户/角色/菜单/字典 RBAC）=====
app.use('/api/admin/users', require('./routes/admin-users'));
app.use('/api/admin/roles', require('./routes/admin-roles'));
app.use('/api/admin/menus', require('./routes/admin-menus'));
app.use('/api/admin/dict', require('./routes/admin-dict'));
app.use('/api/admin/config', require('./routes/admin-config'));

// ===== 工程审计模块（Seed Evolving 三期 case：工程审计智能审读 Agent）=====
app.use('/api/audit/projects', require('./routes/audit/projects'));
app.use('/api/audit/documents', require('./routes/audit/documents'));
app.use('/api/audit/ai-config', require('./routes/audit/aiConfig'));
app.use('/api/audit/chat', require('./routes/audit/chat'));
app.use('/api/audit/checks', require('./routes/audit/checks'));
app.use('/api/audit/findings', require('./routes/audit/findings'));
app.use('/api/audit/bid-clearing', require('./routes/audit/bidClearing'));

// ===== 原记账业务路由（已替换为教育系统，暂时保留供平滑迁移）=====
// app.use('/api/books', require('./routes/books'));
// app.use('/api/accounts', require('./routes/accounts'));
// app.use('/api/categories', require('./routes/categories'));
// app.use('/api/entities', require('./routes/entities'));
// app.use('/api/records', require('./routes/records'));
// app.use('/api/budgets', require('./routes/budgets'));
// app.use('/api/loans', require('./routes/loans'));
// app.use('/api/reports', require('./routes/reports'));
// app.use('/api/export', require('./routes/export'));
// app.use('/api/ai', require('./routes/ai'));

// ===== AI智能教育助手路由（已废弃，改造为工程审计系统）=====
// const eduSubjects      = require('./routes/education/subjects');
// const eduAssessment    = require('./routes/education/assessment');
// const eduFavorites     = require('./routes/education/favorites');
// const eduProfile       = require('./routes/education/profile');
// const eduErrorAnalysis = require('./routes/education/error-analysis');
// const eduQuestions     = require('./routes/education/questions');
// const eduLearningEngine = require('./routes/education/learning-engine');

// 学科与知识点管理
// app.use('/api/edu', eduSubjects);
// 评测流程（/api/edu/assessment/...）
// app.use('/api/edu/assessment', eduAssessment);
// 学生画像（/api/edu/profile/...）
// app.use('/api/edu/profile', eduProfile);
// 错因分析（/api/edu/error-analysis/...）
// app.use('/api/edu/error-analysis', eduErrorAnalysis);
// 题库管理（/api/edu/admin/questions/...）
// app.use('/api/edu', eduQuestions);
// 自适应学习引擎（/api/edu/learning-engine/...）
// app.use('/api/edu/learning-engine', eduLearningEngine);
// 题目收藏（/api/edu/favorites/...）
// app.use('/api/edu/favorites', eduFavorites);
// AI交互辅导工具（/api/edu/tutoring/...）
// const eduTutoring = require('./routes/education/tutoring');
// app.use('/api/edu/tutoring', eduTutoring);
// 学习数据智能分析（/api/edu/analytics/...）
// const eduAnalytics = require('./routes/education/analytics');
// app.use('/api/edu/analytics', eduAnalytics);
// 长期记忆与成长记录（/api/edu/memory/...）
// const eduMemory = require('./routes/education/memory');
// app.use('/api/edu/memory', eduMemory);

// 原记账模板接口已移除（教育系统不需要）

// 根路径：纯 PC 产品，直达 PC 登录页
app.get('/', (req, res) => {
  res.redirect('/pc/login.html');
});

// 全局错误处理（必须在所有路由之后）
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  if (!res.headersSent) {
    res.status(err.status || 400).json({
      error: process.env.NODE_ENV === 'production' ? '请求处理失败' : err.message
    });
  }
});

// 404处理
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: '接口不存在' });
  } else {
    const publicDir = path.resolve(__dirname, '../public');
    const filePath = path.resolve(publicDir, '.' + req.path);
    // 防止路径穿越：确保解析后的路径仍在 public 目录内
    if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
      return res.status(403).send('Forbidden');
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(filePath);
    } else {
      res.redirect('/pc/index.html');
    }
  }
});

// 防止未捕获的异常导致进程崩溃
// 注意：这里只负责兜住请求级异常，不能让它吞掉启动期的致命错误（见下方 server.on('error')）
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});

const server = app.listen(PORT, () => {
  console.log(`🔍 工程审计智能审读 Agent 已启动`);
  console.log(`📍 访问地址: http://localhost:${PORT}`);
  console.log(`💻 PC端: http://localhost:${PORT}/pc/audit-project.html`);
  console.log(`🆔 进程 PID: ${process.pid}`);
  // 回显「实际生效的配置」：部署阶段最难查的就是「改了配置却没生效」，
  // 让人一眼看到加载了哪个文件、白名单是什么，比翻代码猜要省事得多。
  console.log(`⚙️  环境文件: ${LOADED_ENV_FILE}（NODE_ENV=${process.env.NODE_ENV || '未设置'}）`);
  console.log(`🌐 CORS: 同源放行 + 白名单 [${ALLOWED_ORIGINS.join(', ') || '空'}]  trust proxy=${TRUST_PROXY}`);
  console.log(`🗄️  数据库: ${process.env.DB_HOST || '(未配置)'}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME || '(未配置)'}`);
  if (!process.env.JWT_SECRET) {
    console.warn('⚠️  JWT_SECRET 未配置：将使用内置默认密钥，所有已登录用户的 token 会在重启后失效，且存在伪造风险');
  }
});

// 监听失败必须让进程退出：
// 若缺少 error 监听，EADDRINUSE 会冒泡成 uncaughtException 并被上面的“防崩溃”处理器吞掉，
// 进程既不对外服务、也不退出，变成一个占着端口/日志句柄/数据库连接的僵尸实例。
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ 端口 ${PORT} 已被占用，本实例无法启动（请先停止占用该端口的进程）。`);
  } else {
    console.error('❌ 服务监听失败:', err.message);
  }
  process.exit(1);
});
