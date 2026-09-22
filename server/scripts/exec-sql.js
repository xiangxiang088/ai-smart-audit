/**
 * SQL 迁移脚本执行器
 * 用法：node scripts/exec-sql.js <sql文件路径，相对server目录>
 * 例：  node scripts/exec-sql.js sql/v1.1.x/20260920-audit-init.sql
 * 说明：按 server.js 相同规则加载环境变量（NODE_ENV 决定 .env / .env.development / .env.production）
 */
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

const envFile = process.env.NODE_ENV === 'production'
  ? '.env.production'
  : process.env.NODE_ENV === 'development'
    ? '.env.development'
    : '.env';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

async function main() {
  const relPath = process.argv[2];
  if (!relPath) {
    console.error('用法: node scripts/exec-sql.js <sql文件相对路径>');
    process.exit(1);
  }
  const sqlFile = path.isAbsolute(relPath) ? relPath : path.join(__dirname, '..', relPath);
  if (!fs.existsSync(sqlFile)) {
    console.error('SQL 文件不存在:', sqlFile);
    process.exit(1);
  }
  const sql = fs.readFileSync(sqlFile, 'utf8');

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
    supportBigNumbers: true,
    bigNumberStrings: true
  });

  try {
    console.log(`▶ 执行迁移: ${path.basename(sqlFile)} → ${process.env.DB_NAME}@${process.env.DB_HOST}`);
    await conn.query(sql);
    console.log('✅ 迁移执行完成');
  } catch (err) {
    console.error('❌ 迁移失败:', err.message);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

main();
