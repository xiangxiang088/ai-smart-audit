/**
 * 清标分析服务
 * - 维护「清标任务 → 投标方 → 资料」结构（资料复用 audit_document 及其解析结果）
 * - 将招标控制价 + 各投标方解析内容压缩拼装后，调用 Ark 大模型生成 Markdown 清标报告
 * - 分析任务走内存串行队列（与 documents.js 的解析队列同模式），状态/报告落库
 */
const db = require('../../../db');
const auth = require('../../../middleware/auth');
const snowflake = require('../../snowflake');
const { createdBy, updatedBy } = require('../../auditContext');
const parseService = require('../parseService');
const ark = require('../arkClient');
const { htmlTableToRows, rowsToCsv } = require('../agent/tableUtils');
const { BID_CLEARING_SYSTEM_PROMPT } = require('./prompt');

const CONTROL_CAP = 40000;   // 招标控制价单份资料字符上限
const PER_DOC_CAP = 30000;   // 投标方单份资料字符上限
const TOTAL_CAP   = 160000;  // 喂给模型的总字符上限
const MAX_OUTPUT_TOKENS = 16384;
// 超时不再在此写死：单个模型的超时（models[].timeoutMs）与整链总预算（chainTimeoutMs）
// 统一由「模型配置」页维护（/pc/ai-model-config.html → audit_ai_config），
// 调模型不用改代码、不用重新打包。这里只声明输出长度上限。
const STALE_ANALYZING_MINUTES = 15; // analyzing 状态超过此时长视为僵尸（服务器重启导致任务丢失）

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------------- 访问校验 ----------------

async function loadSession(sessionId) {
  const [rows] = await db.query('SELECT * FROM audit_bid_session WHERE id=? AND del_flag=0', [sessionId]);
  return rows[0] || null;
}

/** 检测僵尸会话：analyzing 状态超过阈值（通常因服务器重启导致任务丢失） */
function isStaleAnalyzing(session) {
  if (!session || session.status !== 'analyzing') return false;
  const updatedAt = new Date(session.updated_at);
  const ageMinutes = (Date.now() - updatedAt.getTime()) / 60000;
  return ageMinutes > STALE_ANALYZING_MINUTES;
}

async function assertSessionAccess(sessionId, userId) {
  const session = await loadSession(sessionId);
  if (!session) throw httpError(404, '清标任务不存在');
  // 权限：管理员可访问所有任务；普通用户仅可访问自己创建的任务
  const isAdmin = await auth.isAdmin(userId);
  if (!isAdmin && String(session.created_by) !== String(userId)) {
    throw httpError(403, '无权访问该清标任务');
  }
  return session;
}

async function loadParty(partyId) {
  const [rows] = await db.query('SELECT * FROM audit_bid_party WHERE id=? AND del_flag=0', [partyId]);
  return rows[0] || null;
}

// 资料必须属于当前用户（清标独立资料 project_id=NULL）
async function assertDocOwnership(documentId, userId) {
  const isAdmin = await auth.isAdmin(userId);
  const [rows] = await db.query(
    'SELECT id FROM audit_document WHERE id=? AND del_flag=0',
    [documentId]);
  if (!rows.length) throw httpError(400, '资料不存在');
  if (!isAdmin) {
    const [own] = await db.query('SELECT id FROM audit_document WHERE id=? AND user_id=?', [documentId, userId]);
    if (!own.length) throw httpError(403, '无权使用该资料');
  }
}

// ---------------- 任务 CRUD ----------------

async function listSessions(userId) {
  const isAdmin = await auth.isAdmin(userId);
  const sql = isAdmin
    ? `SELECT s.id, s.title, s.status, s.control_doc_id, s.analyzed_at, s.created_at, s.updated_at,
         (SELECT COUNT(*) FROM audit_bid_party p WHERE p.session_id=s.id AND p.del_flag=0) AS party_count
       FROM audit_bid_session s
       WHERE s.del_flag=0
       ORDER BY s.updated_at DESC, s.id DESC`
    : `SELECT s.id, s.title, s.status, s.control_doc_id, s.analyzed_at, s.created_at, s.updated_at,
         (SELECT COUNT(*) FROM audit_bid_party p WHERE p.session_id=s.id AND p.del_flag=0) AS party_count
       FROM audit_bid_session s
       WHERE s.created_by=? AND s.del_flag=0
       ORDER BY s.updated_at DESC, s.id DESC`;
  const [rows] = await db.query(sql, isAdmin ? [] : [userId]);
  return rows;
}

async function createSession(title, userId) {
  const name = String(title || '').trim() || '清标分析任务';
  const id = snowflake.nextId();
  await db.query(
    `INSERT INTO audit_bid_session (id, project_id, title, status, created_by, updated_by)
     VALUES (?, NULL, ?, 'draft', ?, ?)`,
    [id, name.slice(0, 200), createdBy(), updatedBy()]);
  return loadSession(id);
}

async function renameSession(sessionId, title, userId) {
  await assertSessionAccess(sessionId, userId);
  const name = String(title || '').trim();
  if (!name) throw httpError(400, '任务名称不能为空');
  await db.query('UPDATE audit_bid_session SET title=?, updated_by=? WHERE id=?',
    [name.slice(0, 200), updatedBy(), sessionId]);
  return loadSession(sessionId);
}

async function deleteSession(sessionId, userId) {
  const session = await assertSessionAccess(sessionId, userId);
  await db.query('UPDATE audit_bid_session SET del_flag=1, updated_by=? WHERE id=?', [updatedBy(), sessionId]);
  const [parties] = await db.query('SELECT id FROM audit_bid_party WHERE session_id=?', [sessionId]);
  for (const p of parties) {
    await db.query('UPDATE audit_bid_party SET del_flag=1 WHERE id=?', [p.id]);
    await db.query('DELETE FROM audit_bid_party_doc WHERE party_id=?', [p.id]);
  }
  return { ok: true };
}

async function setControlDoc(sessionId, documentId, userId) {
  const session = await assertSessionAccess(sessionId, userId);
  await assertDocOwnership(documentId, userId);
  await db.query('UPDATE audit_bid_session SET control_doc_id=?, updated_by=? WHERE id=?',
    [documentId, updatedBy(), sessionId]);
  return loadSession(sessionId);
}

// ---------------- 投标方 ----------------

async function addParty(sessionId, partyName, userId) {
  await assertSessionAccess(sessionId, userId);
  const name = String(partyName || '').trim();
  if (!name) throw httpError(400, '投标单位名称不能为空');
  const [maxSort] = await db.query('SELECT COALESCE(MAX(sort_no),0) AS m FROM audit_bid_party WHERE session_id=?', [sessionId]);
  const id = snowflake.nextId();
  await db.query(
    'INSERT INTO audit_bid_party (id, session_id, party_name, sort_no, created_by, updated_by) VALUES (?,?,?,?,?,?)',
    [id, sessionId, name.slice(0, 200), (maxSort[0].m || 0) + 1, createdBy(), updatedBy()]);
  return loadParty(id);
}

async function renameParty(partyId, partyName, userId) {
  const party = await loadParty(partyId);
  if (!party) throw httpError(404, '投标方不存在');
  await assertSessionAccess(party.session_id, userId);
  const name = String(partyName || '').trim();
  if (!name) throw httpError(400, '投标单位名称不能为空');
  await db.query('UPDATE audit_bid_party SET party_name=?, updated_by=? WHERE id=?',
    [name.slice(0, 200), updatedBy(), partyId]);
  return loadParty(partyId);
}

async function removeParty(partyId, userId) {
  const party = await loadParty(partyId);
  if (!party) throw httpError(404, '投标方不存在');
  await assertSessionAccess(party.session_id, userId);
  await db.query('UPDATE audit_bid_party SET del_flag=1, updated_by=? WHERE id=?', [updatedBy(), partyId]);
  await db.query('DELETE FROM audit_bid_party_doc WHERE party_id=?', [partyId]);
  return { ok: true };
}

async function attachPartyDoc(partyId, documentId, userId) {
  const party = await loadParty(partyId);
  if (!party) throw httpError(404, '投标方不存在');
  await assertSessionAccess(party.session_id, userId);
  await assertDocOwnership(documentId, userId);
  await db.query(
    'INSERT IGNORE INTO audit_bid_party_doc (id, party_id, document_id, created_by) VALUES (?,?,?,?)',
    [snowflake.nextId(), partyId, documentId, createdBy()]);
  return { ok: true };
}

async function detachPartyDoc(partyId, documentId, userId) {
  const party = await loadParty(partyId);
  if (!party) throw httpError(404, '投标方不存在');
  await assertSessionAccess(party.session_id, userId);
  await db.query('DELETE FROM audit_bid_party_doc WHERE party_id=? AND document_id=?', [partyId, documentId]);
  return { ok: true };
}

// ---------------- 任务详情（含控制价/投标方及解析状态） ----------------

const DOC_FIELDS = 'id, file_name, parse_status, parse_progress, parse_error';

async function getDetail(sessionId, userId) {
  const session = await assertSessionAccess(sessionId, userId);
  let control = null;
  if (session.control_doc_id) {
    const [rows] = await db.query(`SELECT ${DOC_FIELDS} FROM audit_document WHERE id=? AND del_flag=0`,
      [session.control_doc_id]);
    control = rows[0] || null;
  }
  const [parties] = await db.query(
    'SELECT id, party_name, sort_no FROM audit_bid_party WHERE session_id=? AND del_flag=0 ORDER BY sort_no, id',
    [sessionId]);
  for (const p of parties) {
    const [links] = await db.query(
      `SELECT d.id, d.file_name, d.parse_status, d.parse_progress, d.parse_error
       FROM audit_bid_party_doc l
       INNER JOIN audit_document d ON d.id=l.document_id AND d.del_flag=0
       WHERE l.party_id=? ORDER BY l.created_at, l.id`,
      [p.id]);
    p.docs = links;
  }

  // 是否可分析：控制价已解析 + 至少一家投标方 + 每家至少一份资料且全部解析完成
  const allPartyDocs = parties.flatMap(p => p.docs);
  const ready = !!control && control.parse_status === 'done'
    && parties.length > 0
    && parties.every(p => p.docs.length > 0)
    && allPartyDocs.every(d => d.parse_status === 'done');
  const busy = [control, ...allPartyDocs].some(d => d && (d.parse_status === 'pending' || d.parse_status === 'processing'));

  // 僵尸会话检测：analyzing 状态超时（服务器重启导致任务丢失）
  const stale = isStaleAnalyzing(session);

  return {
    ...session,
    control,
    parties,
    can_analyze: ready,
    docs_busy: busy,
    is_stale: stale
  };
}

// ---------------- 内容拼装 ----------------

/** OCR markdown 中的 HTML <table> 替换为紧凑 CSV */
function tablesToCsv(md) {
  return String(md || '').replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
    const { rows } = htmlTableToRows(tableHtml);
    return rows.length ? '\n' + rowsToCsv(rows) + '\n' : '';
  });
}

/** 单份资料解析结果 → 喂给模型的紧凑文本 */
function docToText(documentId, cap) {
  const stored = parseService.loadResult(documentId);
  if (!stored || !stored.parser) return '';
  const { kind, parser } = stored;
  let text = '';
  if (kind === 'excel') {
    text = (parser.sheets || []).map(sh => {
      const { rows } = htmlTableToRows(sh.html);
      return `工作表「${sh.name}」（${sh.rowCount}行×${sh.colCount}列）\n${rowsToCsv(rows)}`;
    }).join('\n\n');
  } else if (kind === 'word') {
    text = parser.markdownText || '';
  } else if (kind === 'ocr') {
    text = tablesToCsv(parser.markdownText || '');
  }
  return text.slice(0, cap);
}

function buildUserPrompt(detail) {
  const parts = [];
  parts.push('========== 【招标控制价】 ==========');
  parts.push(`文件名称：${detail.control.file_name}`);
  parts.push(docToText(detail.control.id, CONTROL_CAP));
  detail.parties.forEach((p, i) => {
    parts.push('');
    parts.push(`========== 【投标方 ${i + 1}】单位名称：${p.party_name} ==========`);
    p.docs.forEach(d => {
      parts.push(`文件名称：${d.file_name}`);
      parts.push(docToText(d.id, PER_DOC_CAP));
    });
  });
  parts.unshift('以下为本次清标评审的全部资料，请严格按评审要求逐项核对并输出 Markdown 报告。\n');
  const msg = parts.join('\n');
  return msg.length > TOTAL_CAP ? msg.slice(0, TOTAL_CAP) : msg;
}

// ---------------- 分析执行（内存串行队列） ----------------

let analysisChain = Promise.resolve();

function startAnalysis(sessionId, userId) {
  // 入队前先做一次存在性校验（调用方可 await 拿到即时错误），实际执行在后台串行
  analysisChain = analysisChain
    .then(() => runAnalysis(sessionId))
    .catch(err => console.error('[bid-clearing] 分析队列异常:', err.message));
}

async function runAnalysis(sessionId) {
  const session = await loadSession(sessionId);
  if (!session) return;

  // 僵尸会话自动恢复
  if (isStaleAnalyzing(session)) {
    console.warn(`[bid-clearing] 检测到僵尸会话 ${sessionId}，自动重置为 draft`);
    await db.query(
      `UPDATE audit_bid_session SET status='draft', error_msg=? WHERE id=?`,
      ['分析超时（服务器重启导致任务丢失），已自动重置，请重新点击"开始分析"', sessionId]);
    return;
  }

  const detail = await getDetail(sessionId, session.created_by || '0');
  if (!detail.can_analyze) {
    await db.query('UPDATE audit_bid_session SET status=?, error_msg=?, updated_by=? WHERE id=?',
      ['failed', '招标控制价或投标方资料尚未全部解析完成，暂不能分析', updatedBy(), sessionId]);
    return;
  }
  await db.query("UPDATE audit_bid_session SET status='analyzing', error_msg=NULL, updated_by=? WHERE id=?",
    [updatedBy(), sessionId]);
  try {
    const result = await ark.chatCompletion({
      businessType: 'bid_clearing',
      businessId: String(sessionId),
      userId: session.created_by || null,
      messages: [
        { role: 'system', content: BID_CLEARING_SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(detail) }
      ],
      temperature: 0.1,
      maxTokens: MAX_OUTPUT_TOKENS,
      stream: true
      // 超时故意不传：走「模型配置」页的 models[].timeoutMs（每模型）与 chainTimeoutMs（整链总预算）
    });
    const report = String(result.content || '').trim();
    if (!report) throw new Error('模型未返回有效报告内容');
    // 记录档位降级：让"实际用了哪个模型、前面哪几个失败了"在界面与日志里可见
    const failedAttempts = (result.chain || []).filter(a => !a.ok);
    const modelInfo = failedAttempts.length
      ? `${result.model || ''}（已降级，失败：${failedAttempts.map(a => a.model).join('、')}）`.slice(0, 255)
      : (result.model || '');
    if (failedAttempts.length) {
      console.warn(`[bid-clearing] 会话 ${sessionId} 档位降级：${failedAttempts.map(a => `${a.model}(${a.error || a.status})`).join(' | ')}`);
    }
    // 降级警示写入报告正文顶部：备用弱模型在长清单场景漏检明显，会给出"未发现异常"这类错误结论，
    // 若不加提示，使用者会把降级产物直接当成清标结论采信。
    const reportFinal = failedAttempts.length
      ? `> ⚠️ **本报告由备用模型生成（非首选模型）**\n`
        + `> 首选模型 ${failedAttempts.map(a => a.model).join('、')} 调用失败`
        + `（${failedAttempts.map(a => `${a.error || a.status}`).join('；')}），已降级至 **${result.model}**。\n`
        + `> 降级模型在长清单的逐项核对能力有限，凡报告中标注“未发现异常”的检查项均可能不成立，请务必人工复核后再采用。\n\n`
        + report
      : report;
    await db.query(
      `UPDATE audit_bid_session
       SET status='done', report_md=?, model_info=?, usage_json=?, error_msg=NULL, analyzed_at=NOW(3), updated_by=?
       WHERE id=?`,
      [reportFinal, modelInfo, result.usage ? JSON.stringify(result.usage) : null, updatedBy(), sessionId]);
  } catch (err) {
    await db.query('UPDATE audit_bid_session SET status=?, error_msg=?, updated_by=? WHERE id=?',
      ['failed', String(err.message).slice(0, 1900), updatedBy(), sessionId]).catch(() => {});
  }
}

module.exports = {
  listSessions,
  createSession,
  renameSession,
  deleteSession,
  setControlDoc,
  addParty,
  renameParty,
  removeParty,
  attachPartyDoc,
  detachPartyDoc,
  getDetail,
  startAnalysis
};
