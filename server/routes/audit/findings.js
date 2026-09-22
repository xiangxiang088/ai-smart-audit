/**
 * 审计疑点台账路由 /api/audit/findings
 *
 * GET    /                 疑点列表（可按 risk_level / status / finding_type 过滤，含统计）
 * POST   /scan             重新执行规则扫描（核对差异 + 凑整 + 连号发票 + 集中签证 + 三无签证）
 * PATCH  /:id/status       标记已核实 / 误报 / 关闭（人工复核闭环）
 * DELETE /:id              软删除人工确认无效的疑点
 */
const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const { operLog } = require('../../logger');
const db = require('../../db');
const { runFindingScan } = require('../../utils/audit/check/findingScan');

router.use(auth);

const RISK_LEVELS = new Set(['high', 'mid', 'low']);
const STATUSES = new Set(['open', 'confirmed', 'misreport', 'closed']);

/** 疑点类型中文名（与 audit_finding.finding_type 注释一致） */
const TYPE_LABEL = {
  no_seal: '签章异常/三无签证',
  no_photo: '缺少影像资料',
  qty_diff: '量差异常',
  round_amount: '凑整金额',
  late_visa: '集中/竣工后签证',
  duplicate: '重复计量',
  invoice_serial: '连号发票',
  other: '其他'
};

async function assertProject(projectId, userId) {
  const isAdmin = await auth.isAdmin(userId);
  const [rows] = await db.query('SELECT id FROM audit_project WHERE id=? AND del_flag=0', [projectId]);
  if (!rows.length) { const e = new Error('项目不存在'); e.status = 404; throw e; }
  if (!isAdmin) {
    const [own] = await db.query('SELECT id FROM audit_project WHERE id=? AND user_id=?', [projectId, userId]);
    if (!own.length) { const e = new Error('无权访问该项目'); e.status = 403; throw e; }
  }
}

function decode(row) {
  let evidence = null;
  try { evidence = JSON.parse(row.evidence_json || 'null'); } catch { evidence = null; }
  const amount = evidence && typeof evidence.amount === 'number' ? evidence.amount : null;
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    finding_type: row.finding_type,
    type_label: TYPE_LABEL[row.finding_type] || row.finding_type,
    title: row.title,
    risk_level: row.risk_level,
    description: row.description,
    suggestion: row.suggestion,
    source: row.source,
    ref_id: row.ref_id != null ? String(row.ref_id) : null,
    status: row.status,
    remark: row.remark,
    amount,
    evidence,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// 疑点列表 + 分级统计
router.get('/', async (req, res) => {
  try {
    const { project_id, risk_level, status, finding_type } = req.query;
    if (!project_id) return res.status(400).json({ error: '缺少 project_id' });
    await assertProject(project_id, req.userId);

    const where = ['project_id = ?', 'del_flag = 0'];
    const params = [project_id];
    if (risk_level && RISK_LEVELS.has(risk_level)) { where.push('risk_level = ?'); params.push(risk_level); }
    if (status && STATUSES.has(status)) { where.push('status = ?'); params.push(status); }
    if (finding_type) { where.push('finding_type = ?'); params.push(finding_type); }

    const [rows] = await db.query(
      `SELECT * FROM audit_finding WHERE ${where.join(' AND ')}
        ORDER BY FIELD(risk_level,'high','mid','low'), id DESC LIMIT 2000`,
      params);

    // 全量统计（不受当前过滤影响，供页面展示分级概览）
    const [stat] = await db.query(
      `SELECT risk_level, status, finding_type, COUNT(*) AS cnt
         FROM audit_finding WHERE project_id = ? AND del_flag = 0
        GROUP BY risk_level, status, finding_type`,
      [project_id]);

    const summary = {
      total: 0, high: 0, mid: 0, low: 0,
      open: 0, confirmed: 0, misreport: 0, closed: 0,
      byType: {}
    };
    stat.forEach(r => {
      const c = Number(r.cnt) || 0;
      summary.total += c;
      if (summary[r.risk_level] != null) summary[r.risk_level] += c;
      if (summary[r.status] != null) summary[r.status] += c;
      summary.byType[r.finding_type] = (summary.byType[r.finding_type] || 0) + c;
    });

    res.json({ summary, typeLabel: TYPE_LABEL, total: rows.length, list: rows.map(decode) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 重新扫描
router.post('/scan', operLog('疑点台账', 0), async (req, res) => {
  try {
    const { project_id } = req.body || {};
    if (!project_id) return res.status(400).json({ error: '缺少 project_id' });
    await assertProject(project_id, req.userId);
    const summary = await runFindingScan(project_id, req.userId);
    res.json({ success: true, summary });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 人工复核：标记已核实 / 误报 / 关闭
router.patch('/:id/status', operLog('疑点台账', 2), async (req, res) => {
  try {
    const { status, remark } = req.body || {};
    if (!STATUSES.has(String(status))) {
      return res.status(400).json({ error: 'status 仅支持 open / confirmed / misreport / closed' });
    }
    const [rows] = await db.query('SELECT project_id FROM audit_finding WHERE id=? AND del_flag=0', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: '疑点不存在' });
    await assertProject(rows[0].project_id, req.userId);

    const sets = ['status = ?', 'updated_by = ?'];
    const params = [status, req.userId];
    if (remark !== undefined) { sets.push('remark = ?'); params.push(remark == null ? null : String(remark).slice(0, 500)); }
    params.push(req.params.id);
    await db.query(`UPDATE audit_finding SET ${sets.join(', ')} WHERE id=?`, params);

    const [after] = await db.query('SELECT * FROM audit_finding WHERE id=?', [req.params.id]);
    res.json(decode(after[0]));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 软删除
router.delete('/:id', operLog('疑点台账', 3), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT project_id FROM audit_finding WHERE id=? AND del_flag=0', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: '疑点不存在' });
    await assertProject(rows[0].project_id, req.userId);
    await db.query('UPDATE audit_finding SET del_flag=1, updated_by=? WHERE id=?', [req.userId, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
