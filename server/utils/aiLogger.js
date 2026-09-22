/**
 * 统一AI请求日志工具
 * 记录全站所有AI调用的请求地址、参数、返回结果、耗时、业务类型/标识
 * 采用 fire-and-forget 异步落库（不 await，不阻塞主业务流程），与 server/logger.js 的 operLog 套路一致
 */
const db = require('../db');
const snowflake = require('./snowflake');

/**
 * 记录一次AI请求日志
 * @param {Object} p
 * @param {number|string|null} p.userId 发起请求的用户ID
 * @param {string} p.businessType 业务类型标识，如 error_analysis/financial_analysis/tutoring_chat 等
 * @param {string|number|null} p.businessId 业务唯一标识（session_id/answer_id/book_id等）
 * @param {string} p.requestUrl AI请求地址
 * @param {string} p.requestModel 请求使用的模型名
 * @param {Object} p.requestBody 请求体对象（会自动脱敏 image_url）
 * @param {any} p.responseResult 成功时的原始返回（对象或字符串），失败可传 null
 * @param {Date} p.requestTime 请求发起时间
 * @param {Date} p.responseTime 响应返回时间
 * @param {number} p.status 0成功 1失败
 * @param {string} p.errorMsg 失败时的错误描述
 */
function recordAIRequest(p) {
  try {
    const body = { ...(p.requestBody || {}) };
    // 脱敏：图片base64/图片URL不入库（体积大、无排障价值）
    if (Array.isArray(body.messages)) {
      body.messages = body.messages.map(m => {
        if (Array.isArray(m.content)) {
          return {
            ...m,
            content: m.content.map(c => (c && c.type === 'image_url') ? { ...c, image_url: '[REDACTED]' } : c)
          };
        }
        return m;
      });
    }
    const requestParams = JSON.stringify(body).substring(0, 60000);
    const responseResult = typeof p.responseResult === 'string'
      ? p.responseResult.substring(0, 60000)
      : JSON.stringify(p.responseResult != null ? p.responseResult : null).substring(0, 60000);

    const id = snowflake.nextId();
    const costTime = (p.responseTime && p.requestTime) ? (p.responseTime.getTime() - p.requestTime.getTime()) : null;

    db.query(
      `INSERT INTO sl_sys_ai_log
       (id, user_id, business_type, business_id, request_url, request_model, request_params,
        response_result, status, error_msg, request_time, response_time, cost_time, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        p.userId || null,
        p.businessType,
        p.businessId != null ? String(p.businessId) : null,
        p.requestUrl || null,
        p.requestModel || null,
        requestParams,
        responseResult,
        p.status || 0,
        p.errorMsg ? String(p.errorMsg).substring(0, 500) : null,
        p.requestTime,
        p.responseTime || null,
        costTime,
        p.userId || null
      ]
    ).catch(err => console.error('[aiLogger] 写入AI日志失败:', err.message));
  } catch (err) {
    console.error('[aiLogger] 记录AI日志异常:', err.message);
  }
}

module.exports = { recordAIRequest };
