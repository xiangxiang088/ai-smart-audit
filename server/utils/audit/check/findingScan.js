/**
 * 审计疑点台账 —— 规则扫描器
 *
 * 把「核对程序差异」与「规则命中」统一落库到 audit_finding，形成带风险分级的疑点台账。
 * 对应 P0 要求的疑点类型：
 *   qty_diff       量差异常（清单↔结算工程量/合价差异）
 *   no_seal        三无/签章异常（签证缺编号·日期·签章；合同或签证缺某一方会签）
 *   round_amount   凑整金额（大额整千整万，易被用于调节结算）
 *   invoice_serial 连号发票（同代码下发票号码连续）
 *   late_visa      竣工后/集中签证（短时间内密集签证）
 *
 * 风险分级 high / mid / low；重跑扫描时按「类型+标题」继承人工标记（已核实/误报），
 * 避免每次重扫把人工复核结果清零。
 */
const db = require('../../../db');
const snowflake = require('../../snowflake');

const SOURCES_AUTO = ['check', 'scan'];

function fmtMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseEv(json) {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function locEv(docId, fileName, pageNo, sheetName) {
  return { docId: docId ? String(docId) : null, fileName: fileName || null, pageNo: pageNo || null, sheetName: sheetName || null, elementId: null };
}

/** 按金额量级给出风险等级 */
function riskByAmount(amt) {
  if (amt == null || !Number.isFinite(amt)) return 'mid';
  const a = Math.abs(amt);
  if (a >= 100000) return 'high';
  if (a >= 10000) return 'mid';
  return 'low';
}

// ---------------------------------------------------------------- 规则 1
/** 核对程序差异 → 量差异常 / 签章异常 */
async function scanCheckDiffs(projectId) {
  const out = [];

  // 资料缺口：核对程序某一侧完全没提取到可比对数据时，明细结论是「无法确认」而非「差异」。
  // 这本身就是一条应补资料的疑点，单列出来比混在一堆差异里更容易被审计人员看到。
  const [progs] = await db.query(
    `SELECT id, program_name, summary_json FROM audit_check_program
      WHERE project_id = ? AND program_type = 'boq_settlement' AND del_flag = 0 AND status = 'done'`,
    [projectId]);
  for (const p of progs) {
    let s = {};
    try { s = JSON.parse(p.summary_json || '{}'); } catch (e) {}
    const leftN = Number(s.leftCount || 0), rightN = Number(s.rightCount || 0);
    if (leftN === 0 && rightN === 0) continue;
    if (leftN > 0 && rightN > 0) continue;
    out.push({
      finding_type: 'other',
      title: '清单↔结算资料缺口，核对结论为"无法确认"',
      risk_level: 'mid',
      description: `${p.program_name}：左方（${s.leftLabel || '清单'}）提取 ${leftN} 项，右方（${s.rightLabel || '结算'}）提取 ${rightN} 项。`
        + `因一侧缺少可比对数据，${s.unconfirmed != null ? s.unconfirmed : '若干'} 条明细结论只能记为"无法确认"，不足以支撑差异认定。`,
      suggestion: '补充缺失一侧的清单/结算（控制价）资料并重新解析后重跑核对',
      source: 'check',
      ref_id: null,
      evidence: { left: null, right: null },
      amount: null
    });
  }

  const [rows] = await db.query(
    `SELECT i.*, p.program_type, p.program_name
       FROM audit_check_item i
       JOIN audit_check_program p ON p.id = i.program_id
      WHERE i.project_id = ? AND i.del_flag = 0 AND p.del_flag = 0 AND i.conclusion = 'diff'
      ORDER BY ABS(COALESCE(i.diff_amount, 0)) DESC
      LIMIT 2000`,
    [projectId]);

  for (const it of rows) {
    const ev = parseEv(it.evidence_json);
    const desc = String(it.diff_desc || '');

    if (it.program_type === 'visa_evidence') {
      // 「有栏无章」= 正文有该方签字栏却一枚章都没有 → 高危
      const hasLineNoSeal = /有栏无章|未见任何签章/.test(desc);
      const noPartyLine = /未识别到该方会签|未见[^，。]*签字栏/.test(desc);
      out.push({
        finding_type: 'no_seal',
        title: `${it.item_name} 签章核对异常`,
        risk_level: hasLineNoSeal ? 'high' : 'mid',
        description: `${it.item_code}｜${desc}`,
        suggestion: it.suggestion || '核对原件签章是否遗漏，必要时要求补充盖章',
        source: 'check',
        ref_id: it.id,
        evidence: ev,
        amount: null,
        _noPartyLine: noPartyLine
      });
      continue;
    }

    // 清单↔结算：量/价/合价差异
    const amt = it.diff_amount != null ? Math.abs(Number(it.diff_amount)) : null;
    const qtyDiff = it.diff_qty != null && Math.abs(Number(it.diff_qty)) > 0;
    const parts = [];
    if (qtyDiff) parts.push(`工程量 左 ${it.qty_left ?? '—'} / 右 ${it.qty_right ?? '—'}，差 ${it.diff_qty}`);
    if (it.amount_left != null || it.amount_right != null) {
      parts.push(`合价 左 ${fmtMoney(it.amount_left) || '—'} / 右 ${fmtMoney(it.amount_right) || '—'}`);
    }
    if (desc) parts.push(desc);

    out.push({
      finding_type: 'qty_diff',
      title: `${it.item_name || it.item_code} 清单↔结算差异`,
      risk_level: riskByAmount(amt),
      description: `${it.item_code} ${it.item_name || ''}｜${parts.join('；')}`.slice(0, 1800),
      suggestion: it.suggestion || '核实工程量、综合单价差异原因，确认是否多计少计',
      source: 'check',
      ref_id: it.id,
      evidence: ev,
      amount: amt
    });
  }
  return out;
}

// ---------------------------------------------------------------- 规则 2
/** 签证单要素完整性 → 三无签证（缺编号 / 日期 / 签章） */
async function scanVisaCompleteness(projectId) {
  const [docs] = await db.query(
    `SELECT id, file_name FROM audit_document
      WHERE project_id = ? AND del_flag = 0 AND biz_category = 'visa' AND parse_status = 'done'`,
    [projectId]);

  const out = [];
  for (const d of docs) {
    const [els] = await db.query(
      'SELECT element_type, content_md, page_no FROM audit_element WHERE project_id = ? AND document_id = ?',
      [projectId, d.id]);
    if (!els.length) continue;

    const text = els.filter(e => e.element_type !== 'seal').map(e => e.content_md || '').join('\n');
    const sealCount = els.filter(e => e.element_type === 'seal').length;
    const firstPage = els.find(e => e.page_no)?.page_no || null;

    const missing = [];
    if (!/编\s*号|编号\s*[:：]|No\.?\s*\d/i.test(text)) missing.push('编号');
    if (!/\d{4}\s*[年.\-/]\s*\d{1,2}\s*[月.\-/]\s*\d{1,2}/.test(text)) missing.push('日期');
    if (sealCount === 0) missing.push('签章');
    if (!missing.length) continue;

    out.push({
      finding_type: 'no_seal',
      title: `签证单要素不完整：缺${missing.join('、')}`,
      risk_level: missing.length >= 3 ? 'high' : missing.length === 2 ? 'mid' : 'low',
      description: `${d.file_name}｜未识别到「${missing.join('、')}」。签证单通常应同时具备编号、日期与三方签章，缺项需调阅原件核实。`,
      suggestion: `核实原件中${missing.join('、')}是否真实缺失；要素不全的签证不宜单独作为结算依据`,
      source: 'scan',
      evidence: { left: locEv(d.id, d.file_name, firstPage), right: null },
      amount: null
    });
  }
  return out;
}

// ---------------------------------------------------------------- 规则 3
/** 凑整金额：明细合价为整千元且金额较大 */
async function scanRoundAmounts(projectId) {
  const [rows] = await db.query(
    `SELECT i.item_code, i.item_name, i.amount_left, i.amount_right, i.evidence_json, p.program_name
       FROM audit_check_item i
       JOIN audit_check_program p ON p.id = i.program_id
      WHERE i.project_id = ? AND i.del_flag = 0 AND p.del_flag = 0`,
    [projectId]);

  const seen = new Set();
  const hits = [];
  for (const it of rows) {
    const amt = Number(it.amount_right ?? it.amount_left);
    if (!Number.isFinite(amt)) continue;
    const a = Math.abs(amt);
    if (a < 2000 || a % 1000 !== 0) continue;           // 只看 2000 以上且整千
    const key = `${it.item_code}|${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ ...it, amt: a });
  }

  return hits
    .sort((x, y) => y.amt - x.amt)
    .slice(0, 100)
    .map(it => ({
      finding_type: 'round_amount',
      title: `${it.item_name || it.item_code} 金额凑整`,
      risk_level: it.amt >= 50000 && it.amt % 10000 === 0 ? 'mid' : 'low',
      description: `${it.item_code} ${it.item_name || ''}｜合价 ${fmtMoney(it.amt)} 元为整千金额。凑整金额可能掩盖实际工程量或单价，建议核对计算书与现场实际。`,
      suggestion: '核对工程量计算过程与单价组成，确认凑整是否合理',
      source: 'check',
      evidence: parseEv(it.evidence_json),
      amount: it.amt
    }));
}

// ---------------------------------------------------------------- 规则 4
/**
 * 纯函数：找出连续号段（同发票代码下号码差 1）
 * @param {Array<{docId:string,fileName:string,code:string,no:number}>} recs
 * @returns {Array<{code:string, items:Array}>} items 长度 >= 2 才算连号
 */
function findSerialRuns(recs) {
  const byCode = new Map();
  for (const r of recs) {
    const k = r.code || '(未识别代码)';
    if (!byCode.has(k)) byCode.set(k, []);
    byCode.get(k).push(r);
  }
  const runs = [];
  for (const [code, list] of byCode) {
    const sorted = [...list].sort((a, b) => a.no - b.no);
    let cur = [sorted[0]];
    const flush = () => { if (cur.length >= 2) runs.push({ code, items: cur }); cur = []; };
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].no - sorted[i - 1].no === 1) cur.push(sorted[i]);
      else { flush(); cur = [sorted[i]]; }
    }
    flush();
  }
  return runs;
}

/** 连号发票：同发票代码下号码连续 */
async function scanInvoiceSerial(projectId) {
  const [docs] = await db.query(
    `SELECT id, file_name FROM audit_document
      WHERE project_id = ? AND del_flag = 0 AND biz_category = 'invoice' AND parse_status = 'done'`,
    [projectId]);
  if (docs.length < 2) return [];

  const recs = [];
  for (const d of docs) {
    const [els] = await db.query(
      'SELECT content_md FROM audit_element WHERE project_id = ? AND document_id = ?',
      [projectId, d.id]);
    const text = els.map(e => e.content_md || '').join('\n');
    const codeM = text.match(/(?:发票代码|代码)\s*[:：]?\s*([0-9]{10,12})/);
    const noM = text.match(/(?:发票号码|号码|No\.?)\s*[:：]?\s*([0-9]{8})/) || text.match(/\b([0-9]{8})\b/);
    if (!noM) continue;
    recs.push({ docId: String(d.id), fileName: d.file_name, code: codeM ? codeM[1] : '', no: Number(noM[1]) });
  }
  if (recs.length < 2) return [];

  return findSerialRuns(recs).map(({ code, items }) => {
    const from = items[0].no, to = items[items.length - 1].no;
    const pad = (n) => String(n).padStart(8, '0');
    return {
      finding_type: 'invoice_serial',
      title: `发票连号：${code === '(未识别代码)' ? '' : code + ' '}${pad(from)}~${pad(to)}`,
      risk_level: 'high',
      description: `共 ${items.length} 张发票号码连续（${pad(from)} ~ ${pad(to)}）。连号发票通常出自同一开票批次，需核实是否属于同一笔业务被拆分开票，或存在重复报销。`,
      suggestion: '核对发票对应的合同、付款凭证与验收记录，确认连号发票是否对应真实独立业务',
      source: 'scan',
      evidence: {
        left: locEv(items[0].docId, items[0].fileName, null),
        right: locEv(items[items.length - 1].docId, items[items.length - 1].fileName, null)
      },
      amount: null
    };
  });
}

// ---------------------------------------------------------------- 规则 5
/** 竣工后 / 集中签证：短时间内密集签证 */
async function scanVisaClustering(projectId) {
  const [docs] = await db.query(
    `SELECT id, file_name FROM audit_document
      WHERE project_id = ? AND del_flag = 0 AND biz_category = 'visa' AND parse_status = 'done'`,
    [projectId]);
  if (!docs.length) return [];

  const dated = [];
  for (const d of docs) {
    const [els] = await db.query(
      'SELECT content_md FROM audit_element WHERE project_id = ? AND document_id = ?',
      [projectId, d.id]);
    const text = els.map(e => e.content_md || '').join('\n');
    const re = /(\d{4})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})/g;
    let m, first = null;
    while ((m = re.exec(text))) {
      const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (!Number.isFinite(t)) continue;
      if (first == null || t < first) first = t;
    }
    if (first != null) dated.push({ docId: String(d.id), fileName: d.file_name, ts: first });
  }
  if (dated.length < 2) return [];

  dated.sort((a, b) => a.ts - b.ts);
  const WINDOW_DAYS = 30;
  const out = [];
  const used = new Set();
  for (let i = 0; i < dated.length; i++) {
    const start = dated[i].ts;
    const group = dated.filter(x => x.ts >= start && x.ts <= start + WINDOW_DAYS * 86400000);
    if (group.length < 2) continue;
    if (group.some(g => used.has(g.docId))) continue;
    group.forEach(g => used.add(g.docId));
    const days = Math.round((group[group.length - 1].ts - start) / 86400000);
    const dstr = (t) => new Date(t).toISOString().slice(0, 10);
    out.push({
      finding_type: 'late_visa',
      title: `短周期集中签证（${group.length} 份 / ${days} 天内）`,
      risk_level: group.length >= 3 ? 'high' : 'mid',
      description: `签证日期集中在 ${dstr(start)} ~ ${dstr(group[group.length - 1].ts)}（${days} 天内 ${group.length} 份）。若该区间位于竣工验收之后，可能存在事后补签证；建议比对竣工验收时间与签证时间。`,
      suggestion: '调取竣工验收报告与监理日志，核实签证是否在施工期间及时办理',
      source: 'scan',
      evidence: { left: locEv(group[0].docId, group[0].fileName, null), right: locEv(group[group.length - 1].docId, group[group.length - 1].fileName, null) },
      amount: null
    });
  }
  return out;
}

// ---------------------------------------------------------------- 编排
/**
 * 执行一次全量疑点扫描并落库
 * @returns {Promise<{total:number, high:number, mid:number, low:number, byType:Object}>}
 */
async function runFindingScan(projectId, userId) {
  const collected = [
    ...await scanCheckDiffs(projectId),
    ...await scanVisaCompleteness(projectId),
    ...await scanRoundAmounts(projectId),
    ...await scanInvoiceSerial(projectId),
    ...await scanVisaClustering(projectId)
  ];

  // 重扫前保留人工复核状态（按 类型+标题 继承），避免「已核实/误报」被清空
  const [olds] = await db.query(
    `SELECT finding_type, title, status, remark FROM audit_finding
      WHERE project_id = ? AND del_flag = 0 AND source IN (${SOURCES_AUTO.map(() => '?').join(',')})`,
    [projectId, ...SOURCES_AUTO]);
  const carry = new Map(olds.map(o => [`${o.finding_type}|${o.title}`, o]));

  await db.query(
    `UPDATE audit_finding SET del_flag = 1, updated_by = ?
      WHERE project_id = ? AND del_flag = 0 AND source IN (${SOURCES_AUTO.map(() => '?').join(',')})`,
    [userId, projectId, ...SOURCES_AUTO]);

  const RANK = { high: 0, mid: 1, low: 2 };
  collected.sort((a, b) => (RANK[a.risk_level] ?? 9) - (RANK[b.risk_level] ?? 9));

  const byType = {};
  for (const f of collected) {
    byType[f.finding_type] = (byType[f.finding_type] || 0) + 1;
    const old = carry.get(`${f.finding_type}|${f.title}`);
    const evidence = { ...(f.evidence || {}) };
    if (f.amount != null) evidence.amount = f.amount;
    await db.query(
      `INSERT INTO audit_finding
         (id, project_id, finding_type, title, risk_level, description, evidence_json, suggestion,
          source, ref_id, status, remark, created_by, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [String(snowflake.nextId()), projectId, f.finding_type, String(f.title).slice(0, 255), f.risk_level,
        f.description || null, JSON.stringify(evidence), (f.suggestion || '').slice(0, 500),
        f.source || 'scan', f.ref_id || null, old ? old.status : 'open', old ? old.remark : null,
        userId, userId]);
  }

  return {
    total: collected.length,
    high: collected.filter(x => x.risk_level === 'high').length,
    mid: collected.filter(x => x.risk_level === 'mid').length,
    low: collected.filter(x => x.risk_level === 'low').length,
    byType
  };
}

module.exports = {
  runFindingScan,
  findSerialRuns,
  scanCheckDiffs,
  scanVisaCompleteness,
  scanRoundAmounts,
  scanInvoiceSerial,
  scanVisaClustering
};
