/**
 * 审计证据溯源问答：会话与消息持久化，编排 Agent 取证循环
 */
const db = require('../../../db');
const snowflake = require('../../snowflake');
const { runAgent } = require('./agentLoop');

async function assertProjectAccess(projectId, userId, isAdmin) {
  const [rows] = await db.query('SELECT id, project_name, user_id FROM audit_project WHERE id=? AND del_flag=0', [projectId]);
  if (!rows.length) { const e = new Error('项目不存在'); e.status = 404; throw e; }
  if (!isAdmin && String(rows[0].user_id) !== String(userId)) {
    const e = new Error('无权访问该项目'); e.status = 403; throw e;
  }
  return rows[0];
}

async function assertSessionAccess(sessionId, userId, isAdmin) {
  const [rows] = await db.query('SELECT * FROM audit_chat_session WHERE id=? AND del_flag=0', [sessionId]);
  if (!rows.length) { const e = new Error('会话不存在'); e.status = 404; throw e; }
  if (!isAdmin && String(rows[0].user_id) !== String(userId)) {
    const e = new Error('无权访问该会话'); e.status = 403; throw e;
  }
  return rows[0];
}

async function createSession(projectId, userId, isAdmin, title) {
  await assertProjectAccess(projectId, userId, isAdmin);
  const id = snowflake.nextId();
  await db.query(
    'INSERT INTO audit_chat_session (id, project_id, title, user_id, last_message_at, created_by, updated_by) VALUES (?,?,?,?,NULL,?,?)',
    [id, projectId, title || '新会话', userId, userId, userId]
  );
  return getSession(id);
}

async function getSession(id) {
  const [rows] = await db.query('SELECT * FROM audit_chat_session WHERE id=? AND del_flag=0', [id]);
  return rows[0] || null;
}

async function listSessions(projectId, userId, isAdmin) {
  await assertProjectAccess(projectId, userId, isAdmin);
  const [rows] = await db.query(
    `SELECT s.*, (SELECT content FROM audit_chat_message m WHERE m.session_id=s.id AND m.role='user' ORDER BY m.created_at ASC LIMIT 1) AS first_question
     FROM audit_chat_session s WHERE s.project_id=? AND s.del_flag=0 ORDER BY s.last_message_at DESC, s.created_at DESC`,
    [projectId]
  );
  return rows;
}

async function listMessages(sessionId) {
  const [rows] = await db.query(
    'SELECT id, role, content, citations_json, created_at FROM audit_chat_message WHERE session_id=? ORDER BY created_at ASC',
    [sessionId]
  );
  return rows.map(r => ({
    id: String(r.id), role: r.role, content: r.content, createdAt: r.created_at,
    meta: r.citations_json ? JSON.parse(r.citations_json) : null
  }));
}

async function deleteSession(sessionId, userId, isAdmin) {
  const s = await assertSessionAccess(sessionId, userId, isAdmin);
  await db.query('UPDATE audit_chat_session SET del_flag=1, updated_by=? WHERE id=?', [userId, sessionId]);
  return s;
}

/** 提问前准备：校验会话 → 读最近 6 条历史 → 落用户消息 */
async function prepareAsk(sessionId, userId, isAdmin, content) {
  const session = await assertSessionAccess(sessionId, userId, isAdmin);
  const question = String(content || '').trim();
  if (!question) { const e = new Error('问题不能为空'); e.status = 400; throw e; }

  const [histRows] = await db.query(
    `SELECT role, content FROM (
       SELECT role, content, created_at FROM audit_chat_message WHERE session_id=? ORDER BY created_at DESC LIMIT 6
     ) t ORDER BY created_at ASC`,
    [sessionId]
  );

  const userMsgId = snowflake.nextId();
  await db.query(
    'INSERT INTO audit_chat_message (id, session_id, project_id, role, content) VALUES (?,?,?,?,?)',
    [userMsgId, sessionId, session.project_id, 'user', question.slice(0, 60000)]
  );

  return {
    session, question,
    history: histRows.map(r => ({ role: r.role, content: r.content }))
  };
}

/** Agent 失败也要留痕：写一条说明性助手消息，便于排查（不把堆栈暴露给前端） */
async function persistFailure(session, userId, question, e) {
  const errId = snowflake.nextId();
  await db.query(
    'INSERT INTO audit_chat_message (id, session_id, project_id, role, content, citations_json) VALUES (?,?,?,?,?,?)',
    [errId, session.id, session.project_id, 'assistant',
      '审计助手暂时无法完成本次分析（模型服务调用失败），请稍后重试或检查「模型设置」中的模型与密钥。',
      JSON.stringify({ error: true, errorMsg: String(e.message || e).slice(0, 500), attempts: e.attempts || null })]
  );
  await touchSession(session, userId, question);
}

/** Agent 成功：落库助手消息并返回前端所需的扁平结构 */
async function persistAnswer(session, userId, question, result) {
  const meta = {
    citations: result.citations,
    missing: result.missing,
    confidence: result.confidence,
    trace: result.trace,
    model: result.model,
    modelKey: result.modelKey,
    usage: result.usage,
    rounds: result.rounds,
    evidenceCount: result.evidenceCount
  };
  const asstId = snowflake.nextId();
  await db.query(
    'INSERT INTO audit_chat_message (id, session_id, project_id, role, content, citations_json) VALUES (?,?,?,?,?,?)',
    [asstId, session.id, session.project_id, 'assistant', result.answer, JSON.stringify(meta)]
  );
  await touchSession(session, userId, question);

  return {
    id: String(asstId), role: 'assistant', content: result.answer,
    citations: result.citations, missing: result.missing, confidence: result.confidence,
    trace: result.trace, model: result.model, modelKey: result.modelKey,
    usage: result.usage, rounds: result.rounds, evidenceCount: result.evidenceCount
  };
}

/**
 * 提问并运行审计 Agent（同步一次性返回，保留给降级链路使用）
 * @returns {Promise<object>} 助手消息（含 answer/citations/missing/trace）
 */
async function ask(sessionId, userId, isAdmin, content) {
  const { session, question, history } = await prepareAsk(sessionId, userId, isAdmin, content);
  let result;
  try {
    result = await runAgent({ projectId: String(session.project_id), question, history, userId });
  } catch (e) {
    await persistFailure(session, userId, question, e);
    const err = new Error('Agent 运行失败：' + String(e.message || e).slice(0, 200));
    err.status = 502;
    throw err;
  }
  return persistAnswer(session, userId, question, result);
}

/**
 * 流式提问：Agent 跑的每一步都通过 emit(event, data) 实时下发，最后落库。
 * 事件：start / progress / tool / answer / done / error
 * @param {Function} emit (event:string, data:object)=>void
 * @returns {Promise<object|null>} 成功返回助手消息，失败返回 null（错误已通过 error 事件下发）
 */
async function askStream(sessionId, userId, isAdmin, content, emit) {
  const safeEmit = (event, data) => { try { emit(event, data); } catch { /* 客户端断开，忽略 */ } };
  const { session, question, history } = await prepareAsk(sessionId, userId, isAdmin, content);
  safeEmit('start', { question, sessionId: String(sessionId) });

  let result;
  try {
    result = await runAgent({
      projectId: String(session.project_id),
      question,
      history,
      userId,
      onEvent: (ev) => {
        // tool / answer 原样透传，其余（progress）归入进度类
        if (ev.type === 'tool' || ev.type === 'answer') safeEmit(ev.type, ev);
        else safeEmit('progress', ev);
      }
    });
  } catch (e) {
    await persistFailure(session, userId, question, e);
    safeEmit('error', { message: 'Agent 运行失败：' + String(e.message || e).slice(0, 200) });
    return null;
  }

  const msg = await persistAnswer(session, userId, question, result);
  safeEmit('done', msg);
  return msg;
}

async function touchSession(session, userId, question) {
  const title = session.title && session.title !== '新会话' ? session.title : question.slice(0, 20);
  await db.query('UPDATE audit_chat_session SET last_message_at=NOW(3), title=?, updated_by=? WHERE id=?',
    [title, userId, session.id]);
}

module.exports = {
  assertProjectAccess, assertSessionAccess, createSession, getSession, listSessions, listMessages, deleteSession,
  ask, askStream
};
