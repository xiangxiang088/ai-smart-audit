/**
 * auditContext.js
 * 利用 Node.js AsyncLocalStorage 在整个请求异步链中透传当前用户 ID，
 * 无需将 req.userId 逐层传递到每一个函数参数。
 *
 * 用法：
 *   const { createdBy, updatedBy } = require('../utils/auditContext');
 *
 *   // INSERT
 *   db.query(`INSERT INTO t (id, name, created_by) VALUES (?,?,?)`,
 *            [id, name, createdBy()]);
 *
 *   // UPDATE
 *   db.query(`UPDATE t SET name=?, updated_by=? WHERE id=?`,
 *            [name, updatedBy(), id]);
 */
const { AsyncLocalStorage } = require('async_hooks');

const _store = new AsyncLocalStorage();

/**
 * 在 auth 中间件中调用，把 userId 绑定到当前请求的异步上下文。
 * @param {string} userId
 * @param {Function} fn  - 通常是 Express next()
 */
function runWithUser(userId, fn) {
  return _store.run({ userId }, fn);
}

/**
 * 返回当前请求的用户 ID（用于 INSERT 的 created_by）。
 * 在请求上下文之外调用时返回 null。
 */
function createdBy() {
  return _store.getStore()?.userId ?? null;
}

/**
 * 返回当前请求的用户 ID（用于 UPDATE 的 updated_by）。
 * 语义上与 createdBy() 相同，分开命名是为了让 SQL 语句的意图更清晰。
 */
function updatedBy() {
  return _store.getStore()?.userId ?? null;
}

module.exports = { runWithUser, createdBy, updatedBy };
