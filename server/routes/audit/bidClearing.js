/**
 * 清标分析路由 /api/audit/bid-clearing
 * 任务（session）：1 份招标控制价 + N 家投标方，分析产出 Markdown 报告
 */
const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const { operLog } = require('../../logger');
const svc = require('../../utils/audit/bidclearing/bidClearingService');

router.use(auth);

function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    res.status(e.status || 500).json({ error: e.message });
  });
}

// ---------- 任务 ----------

// 任务列表（不再需要 project_id）
router.get('/sessions', wrap(async (req, res) => {
  res.json(await svc.listSessions(req.userId));
}));

// 新建任务（不再需要 project_id）
router.post('/sessions', operLog('清标分析', 1), wrap(async (req, res) => {
  const { title } = req.body || {};
  res.json(await svc.createSession(title, req.userId));
}));

// 任务详情（含投标方/资料/解析状态/报告）
router.get('/sessions/:id', wrap(async (req, res) => {
  res.json(await svc.getDetail(req.params.id, req.userId));
}));

// 重命名任务
router.put('/sessions/:id', operLog('清标分析', 2), wrap(async (req, res) => {
  const { title } = req.body || {};
  res.json(await svc.renameSession(req.params.id, title, req.userId));
}));

// 删除任务
router.delete('/sessions/:id', operLog('清标分析', 3), wrap(async (req, res) => {
  res.json(await svc.deleteSession(req.params.id, req.userId));
}));

// 设置招标控制价资料
router.put('/sessions/:id/control', operLog('清标分析', 2), wrap(async (req, res) => {
  const { document_id } = req.body || {};
  if (!document_id) return res.status(400).json({ error: '缺少 document_id' });
  res.json(await svc.setControlDoc(req.params.id, document_id, req.userId));
}));

// 开始清标分析（后台串行执行，前端轮询状态）
router.post('/sessions/:id/analyze', operLog('清标分析', 0), wrap(async (req, res) => {
  await svc.getDetail(req.params.id, req.userId); // 访问校验
  svc.startAnalysis(req.params.id, req.userId);
  res.json({ ok: true });
}));

// ---------- 投标方 ----------

// 新增投标方
router.post('/sessions/:id/parties', operLog('清标分析', 1), wrap(async (req, res) => {
  const { party_name } = req.body || {};
  res.json(await svc.addParty(req.params.id, party_name, req.userId));
}));

// 重命名投标方
router.put('/parties/:partyId', operLog('清标分析', 2), wrap(async (req, res) => {
  const { party_name } = req.body || {};
  res.json(await svc.renameParty(req.params.partyId, party_name, req.userId));
}));

// 删除投标方
router.delete('/parties/:partyId', operLog('清标分析', 3), wrap(async (req, res) => {
  res.json(await svc.removeParty(req.params.partyId, req.userId));
}));

// 投标方挂接资料
router.post('/parties/:partyId/documents', operLog('清标分析', 1), wrap(async (req, res) => {
  const { document_id } = req.body || {};
  if (!document_id) return res.status(400).json({ error: '缺少 document_id' });
  res.json(await svc.attachPartyDoc(req.params.partyId, document_id, req.userId));
}));

// 投标方移除资料
router.delete('/parties/:partyId/documents/:documentId', operLog('清标分析', 3), wrap(async (req, res) => {
  res.json(await svc.detachPartyDoc(req.params.partyId, req.params.documentId, req.userId));
}));

module.exports = router;
