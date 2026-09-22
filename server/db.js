const mysql = require('mysql2/promise');

// 数据库配置 - 优先使用环境变量
// 开发环境默认值仅用于本地快速体验，生产环境必须通过 .env.production 配置
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ai_education',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
  // BIGINT 字段返回字符串，避免 JavaScript Number 精度丢失（雪花ID为18位数字，超出JS安全整数范围）
  supportBigNumbers: true,
  bigNumberStrings: true,
  // 远程 RDS 场景：开启 TCP keep-alive 并把首次探测提前到 10s，
  // 防止空闲连接被 NAT/防火墙静默掐断后，池里残留“死连接”导致查询卡死/间歇无数据
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
};

// 生产环境必须通过环境变量配置数据库，否则直接退出
if (process.env.NODE_ENV === 'production') {
  if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_PASSWORD || !process.env.DB_NAME) {
    console.error('❌ 生产环境必须通过环境变量配置数据库连接(DB_HOST/DB_USER/DB_PASSWORD/DB_NAME)');
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    console.error('❌ 生产环境必须设置 JWT_SECRET 环境变量');
    process.exit(1);
  }
}

const pool = mysql.createPool(dbConfig);

// 连接级错误（死连接/网络中断）——发生时打印日志，mysql2 会自动从池中摘除
pool.on('connection', conn => {
  conn.on('error', err => {
    console.error('[mysql connection error]', err.code, err.message);
  });
});

// 连接级错误码：查询可能落在了已失效的连接上
const CONN_ERROR_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND'
]);

// 仅对只读语句自动重试一次（SELECT/SHOW/DESCRIBE/EXPLAIN），写语句不重试以免重复执行
function isReadOnly(sql) {
  const head = String(sql).trimStart().toUpperCase();
  return head.startsWith('SELECT') || head.startsWith('SHOW') ||
         head.startsWith('DESC') || head.startsWith('EXPLAIN');
}

async function queryWithRetry(sql, params, attempt = 0) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    if (attempt < 1 && err && CONN_ERROR_CODES.has(err.code) && isReadOnly(sql)) {
      console.warn('[mysql] 查询遇到连接错误，自动重试一次:', err.code);
      return queryWithRetry(sql, params, attempt + 1);
    }
    throw err;
  }
}

// 对外保持与 mysql2 连接池相同的接口，仅增强 query
const dbExport = {
  query: queryWithRetry,
  execute: (...args) => pool.execute(...args),
  getConnection: (...args) => pool.getConnection(...args),
  end: (...args) => pool.end(...args),
  on: (...args) => pool.on(...args),
  pool
};

// 测试连接
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ 数据库连接成功');
    connection.release();
  } catch (err) {
    console.error('❌ 数据库连接失败:', err.message);
    console.log('请先执行 server/sql/v1.0.x/init-db.sql 初始化数据库，并通过环境变量或 db.js 配置连接信息');
  }
}

testConnection();

module.exports = dbExport;
