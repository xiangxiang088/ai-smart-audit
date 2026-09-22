/**
 * 统一配置中心路由（分域键值配置）
 *
 *   GET    /api/admin/config                      列出所有配置域及其条目数
 *   GET    /api/admin/config/:namespace           读取某域全部配置（密钥自动脱敏）
 *   PUT    /api/admin/config/:namespace           写入某域（仅管理员）
 *   DELETE /api/admin/config/:namespace/:key      删除某键（仅管理员）
 *
 * 存储与类型语义见 utils/configStore.js；库表为 sl_sys_config(namespace, config_key, ...)。
 *
 * 提交形态（两种都支持）：
 *   { "items": [{ "key": "model", "value": "glm-4-flash", "type": "string" }] }
 *   { "model": "glm-4-flash", "enabled": true }
 * 密钥项传空值默认视为「不修改」（页面上留空 = 保持原密钥）；
 * 如需显式清空，传 skipEmptySecrets: false。
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { operLog } = require('../logger');
const configStore = require('../utils/configStore');

router.use(auth);

// 域名格式：小写字母/数字，可点分层级（如 audit.ai、sys.mail）
const NS_PATTERN = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

function validateNamespace(req, res, next) {
  const ns = req.params.namespace;
  if (!NS_PATTERN.test(String(ns || ''))) {
    return res.status(400).json({
      error: `配置域名不合法：${ns}（只允许小写字母/数字，可用点分层级，如 audit.ai）`
    });
  }
  next();
}

/** 把请求体归一化为 [{ key, value, type?, secret?, description? }] */
function toEntries(body) {
  const b = body || {};
  if (Array.isArray(b.items)) return b.items.filter(x => x && x.key);
  return Object.entries(b)
    .filter(([k]) => k !== 'items' && k !== 'skipEmptySecrets')
    .map(([key, value]) => ({ key, value }));
}

router.get('/', async (req, res) => {
  try {
    res.json({ namespaces: await configStore.listNamespaces() });
  } catch (err) {
    console.error('列出配置域失败:', err);
    res.status(500).json({ error: '列出配置域失败：' + err.message });
  }
});

router.get('/:namespace', validateNamespace, async (req, res) => {
  try {
    const ns = req.params.namespace;
    res.json(await configStore.describe(ns, { maskSecrets: true }));
  } catch (err) {
    console.error(`读取配置域 ${req.params.namespace} 失败:`, err);
    res.status(500).json({ error: '读取配置失败：' + err.message });
  }
});

router.put('/:namespace', validateNamespace, auth.requireAdmin, operLog('系统配置', 2), async (req, res) => {
  try {
    const ns = req.params.namespace;
    const entries = toEntries(req.body);
    if (!entries.length) return res.status(400).json({ error: '没有可保存的配置项' });

    const written = await configStore.setMany(ns, entries, {
      userId: req.userId,
      skipEmptySecrets: (req.body || {}).skipEmptySecrets !== false
    });
    configStore.reload(ns);
    res.json({ ok: true, written, config: await configStore.describe(ns) });
  } catch (err) {
    console.error(`保存配置域 ${req.params.namespace} 失败:`, err);
    res.status(500).json({ error: '保存配置失败：' + err.message });
  }
});

router.delete('/:namespace/:key', validateNamespace, auth.requireAdmin, operLog('系统配置', 3), async (req, res) => {
  try {
    const removed = await configStore.remove(req.params.namespace, req.params.key);
    res.json({ ok: true, removed });
  } catch (err) {
    console.error(`删除配置 ${req.params.namespace}/${req.params.key} 失败:`, err);
    res.status(500).json({ error: '删除配置失败：' + err.message });
  }
});

module.exports = router;
