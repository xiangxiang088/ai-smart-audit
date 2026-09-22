/**
 * 审计核对程序路由 /api/audit/checks
 * POST /run  运行清单↔结算跨页表勾稽
 * GET  /programs?project_id=  程序运行记录
 * GET  /programs/:id/items?conclusion=  核对明细
 * DELETE /programs/:id  软删一次运行
 */
const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const { operLog } = require('../../logger');
const db = require('../../db');
const { runBoqCheck } = require('../../utils/audit/check/boqCheck');
const { runVisaCheck } = require('../../utils/audit/check/visaCheck');
const { buildChecksWorkbook } = require('../../utils/audit/check/exportChecks');
const { buildFindingsDocx } = require('../../utils/audit/check/exportWord');
const { runFindingScan } = require('../../utils/audit/check/findingScan');

router.use(auth);

async function assertProject(projectId, userId) {
  const isAdmin = await auth.isAdmin(userId);
  const [rows] = await db.query('SELECT id FROM audit_project WHERE id=? AND del_flag=0', [projectId]);
  if (!rows.length) { const e = new Error('项目不存在'); e.status = 404; throw e; }
  if (!isAdmin) {
    const [own] = await db.query('SELECT id FROM audit_project WHERE id=? AND user_id=?', [projectId, userId]);
    if (!own.length) { const e = new Error('无权访问该项目'); e.status = 403; throw e; }
  }
}

// 运行核对
router.post('/run', operLog('核对程序', 0), async (req, res) => {
  try {
    const { project_id, program_type } = req.body || {};
    if (!project_id) return res.status(400).json({ error: '缺少 project_id' });
    await assertProject(project_id, req.userId);
    const type = program_type || 'boq_settlement';
    const result = type === 'visa_evidence'
      ? await runVisaCheck(project_id, req.userId)
      : await runBoqCheck(project_id, req.userId);
    // 核对完成后同步刷新疑点台账（规则扫描 + 分级），保证「疑点台账」与「核对程序」结论一致
    let findings = null;
    try {
      findings = await runFindingScan(project_id, req.userId);
    } catch (e) {
      console.error('[audit] 疑点台账扫描失败:', e.message);
    }
    res.json({ ...result, findings });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 程序列表
router.get('/programs', async (req, res) => {
  try {
    const { project_id } = req.query;
    if (!project_id) return res.status(400).json({ error: '缺少 project_id' });
    await assertProject(project_id, req.userId);
    const [rows] = await db.query(
      "SELECT id, program_type, program_name, status, summary_json, created_at FROM audit_check_program WHERE project_id=? AND del_flag=0 ORDER BY id DESC",
      [project_id]);
    rows.forEach(r => { try { r.summary = JSON.parse(r.summary_json); } catch (e) {} delete r.summary_json; });
    res.json(rows);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 导出 Excel 台账
router.get('/export', async (req, res) => {
  try {
    const { project_id } = req.query;
    if (!project_id) return res.status(400).json({ error: '缺少 project_id' });
    await assertProject(project_id, req.userId);
    const { buf, fileName } = await buildChecksWorkbook(project_id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(fileName));
    res.send(buf);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 导出 Word 发现清单
router.get('/export-word', async (req, res) => {
  try {
    const { project_id } = req.query;
    if (!project_id) return res.status(400).json({ error: '缺少 project_id' });
    await assertProject(project_id, req.userId);
    const { buf, fileName } = await buildFindingsDocx(project_id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(fileName));
    res.send(buf);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 明细
router.get('/programs/:id/items', async (req, res) => {
  try {
    const programId = req.params.id;
    const [prog] = await db.query('SELECT project_id FROM audit_check_program WHERE id=? AND del_flag=0', [programId]);
    if (!prog.length) return res.status(404).json({ error: '核对记录不存在' });
    await assertProject(prog[0].project_id, req.userId);
    const cond = (req.query.conclusion && req.query.conclusion !== 'all') ? 'AND conclusion=?' : '';
    const params = cond ? [programId, req.query.conclusion] : [programId];
    const [rows] = await db.query(
      `SELECT * FROM audit_check_item WHERE program_id=? AND del_flag=0 ${cond} ORDER BY FIELD(conclusion,'diff','unconfirmed','match'), item_code LIMIT 2000`,
      params);
    rows.forEach(r => { try { r.evidence = JSON.parse(r.evidence_json); } catch (e) {} delete r.evidence_json; });
    res.json(rows);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 删除一次运行
router.delete('/programs/:id', operLog('核对程序', 3), async (req, res) => {
  try {
    const programId = req.params.id;
    const [prog] = await db.query('SELECT project_id FROM audit_check_program WHERE id=? AND del_flag=0', [programId]);
    if (!prog.length) return res.status(404).json({ error: '核对记录不存在' });
    await assertProject(prog[0].project_id, req.userId);
    await db.query('UPDATE audit_check_program SET del_flag=1 WHERE id=?', [programId]);
    await db.query('UPDATE audit_check_item SET del_flag=1 WHERE program_id=?', [programId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
