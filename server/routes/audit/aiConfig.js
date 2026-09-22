/**
 * 审计 Agent 模型配置路由
 *   GET  /api/audit/ai-config         查看模型链（key 脱敏，登录可见）
 *   PUT  /api/audit/ai-config         保存配置（仅管理员）
 *   POST /api/audit/ai-config/test    连通性测试（仅管理员）
 *   POST /api/audit/ai-config/reload  清缓存重载（仅管理员）
 */
const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const { operLog } = require('../../logger');
const ark = require('../../utils/audit/arkClient');

router.use(auth);

// 查看脱敏配置
router.get('/', async (req, res) => {
  try {
    const cfg = await ark.getPublicConfig();
    res.json(cfg);
  } catch (err) {
    console.error('获取模型配置失败:', err);
    res.status(500).json({ error: '获取模型配置失败：' + err.message });
  }
});

// 保存（管理员）
router.put('/', auth.requireAdmin, operLog('模型配置', 2), async (req, res) => {
  try {
    const current = await ark.getConfig(true);
    const body = req.body || {};
    const incoming = Array.isArray(body.models) ? body.models : [];

    // 以「前端提交的 models 顺序」为权威 —— 上移/下移即调整降级优先级。
    // 未出现在提交列表里的既有模型追加到末尾，避免前端漏传导致配置被静默丢掉。
    const ordered = [];
    for (const patch of incoming) {
      const hit = current.models.find(m => m.key === patch.key || (patch.model && m.model === patch.model));
      if (hit && !ordered.some(o => o.cur === hit)) ordered.push({ cur: hit, patch });
    }
    for (const cur of current.models) {
      if (!ordered.some(o => o.cur === cur)) ordered.push({ cur, patch: null });
    }

    const models = ordered.map(({ cur, patch }) => {
      const next = { ...cur };
      if (!patch) return next;
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
      if (patch.label) next.label = String(patch.label);
      if (patch.model) next.model = String(patch.model).trim();
      if (patch.note !== undefined) next.note = String(patch.note || '');
      if (patch.freeQuota !== undefined) next.freeQuota = String(patch.freeQuota || '');
      if (patch.timeoutMs !== undefined) {
        const t = Math.round(Number(patch.timeoutMs));
        // 0 或非法 = 跟随调用方默认；上限 1 小时，防止误填把单个模型拖死
        next.timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(t, 3600000) : 0;
      }
      // apiKey：undefined/未提交=保持原值；空串=清除自定义（回退 env）；非空=覆盖
      if (typeof patch.apiKey === 'string') next.apiKey = patch.apiKey.trim();
      if (typeof patch.baseUrl === 'string') next.baseUrl = patch.baseUrl.trim();
      return next;
    });

    const activeModel = body.activeModel || current.activeModel;
    const activeHit = models.find(m => m.model === activeModel || m.key === activeModel);
    if (!activeHit) return res.status(400).json({ error: '主模型不在配置列表中' });
    if (activeHit.enabled === false) return res.status(400).json({ error: '主模型必须是已启用的模型' });
    if (models.every(m => m.enabled === false)) return res.status(400).json({ error: '至少要启用一个模型' });
    // 主模型固定排链首：让「列表顺序 = 降级顺序」直观且不会被误配
    const finalModels = [activeHit, ...models.filter(m => m !== activeHit)];

    const chainTimeoutMs = Math.round(Number(body.chainTimeoutMs));
    await ark.saveConfig({
      failoverEnabled: typeof body.failoverEnabled === 'boolean' ? body.failoverEnabled : current.failoverEnabled,
      activeModel,
      // 上限 2 小时，避免误填导致请求永远挂着
      chainTimeoutMs: Number.isFinite(chainTimeoutMs) && chainTimeoutMs > 0
        ? Math.min(chainTimeoutMs, 7200000)
        : current.chainTimeoutMs,
      models: finalModels
    }, req.userId);

    res.json({ ok: true, config: await ark.getPublicConfig() });
  } catch (err) {
    console.error('保存模型配置失败:', err);
    res.status(500).json({ error: '保存失败：' + err.message });
  }
});

// 连通性测试（管理员）
router.post('/test', auth.requireAdmin, async (req, res) => {
  try {
    const result = await ark.testChain(req.body?.timeoutMs || 30000);
    res.json(result);
  } catch (err) {
    console.error('模型连通性测试失败:', err);
    res.status(500).json({ error: '测试失败：' + err.message });
  }
});

// 清缓存
router.post('/reload', auth.requireAdmin, async (req, res) => {
  ark.reload();
  res.json({ ok: true });
});

module.exports = router;
