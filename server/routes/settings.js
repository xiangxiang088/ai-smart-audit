/**
 * 系统设置路由
 *
 * AI 配置：教育/记账模块的 AI 设置归属统一配置中心的 `edu.ai` 域
 * （结构与读写语义见 utils/configStore.js）。
 * 对外 API 契约（/api/settings/ai 的请求与响应键名）保持不变，老前端页面无需改动。
 */
const express = require('express');
const auth = require('../middleware/auth');
const { operLog } = require('../logger');
const configStore = require('../utils/configStore');

const router = express.Router();

// 教育/记账模块 AI 配置的配置域
const EDU_AI_NS = 'edu.ai';

// 对外 API 契约键名 ↔ 配置中心键名。
// 配置中心已用域名表达归属，故域内键名不再重复 ai_ 前缀（edu.ai 下再叫 ai_model 是冗余）。
const EDU_AI_KEYS = {
  ai_api_url: 'api_url',
  ai_api_key: 'api_key',
  ai_model: 'model',
  ai_vision_model: 'vision_model',
  ai_enabled: 'enabled'
};

// 默认AI配置（对外键名口径）
const DEFAULT_AI_CONFIG = {
  ai_api_url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  ai_api_key: '',
  ai_model: 'glm-4-flash',
  ai_vision_model: 'glm-4v-flash',
  ai_enabled: 'false'
};

/** 读取 edu.ai 域并转成对外键名口径（含密钥明文，仅服务端内部使用） */
async function readEduAi() {
  const stored = await configStore.getNamespace(EDU_AI_NS);
  const out = {};
  for (const [extKey, innerKey] of Object.entries(EDU_AI_KEYS)) {
    const v = stored[innerKey];
    out[extKey] = v === undefined || v === null ? DEFAULT_AI_CONFIG[extKey] : String(v);
  }
  return out;
}

function isEnabled(v) {
  return v === true || v === 'true';
}

// 获取AI配置（隐藏完整key）
router.get('/ai', auth, async (req, res) => {
  const config = await readEduAi();
  // 隐藏完整API Key
  const hasKey = config.ai_api_key && config.ai_api_key.length > 4;
  config.ai_api_key_masked = hasKey
    ? config.ai_api_key.slice(0, 3) + '****' + config.ai_api_key.slice(-4)
    : '';
  config.ai_enabled = isEnabled(config.ai_enabled);
  delete config.ai_api_key; // 不返回完整key
  res.json(config);
});

// 更新AI配置（仅管理员）
router.put('/ai', auth, auth.requireAdmin, operLog('AI配置', 2), async (req, res) => {
  const { ai_api_url, ai_api_key, ai_model, ai_vision_model, ai_enabled } = req.body;

  // 校验URL格式
  if (ai_api_url !== undefined && ai_api_url) {
    try { new URL(ai_api_url); } catch {
      return res.status(400).json({ error: 'API地址格式不正确' });
    }
  }

  const entries = [];
  if (ai_api_url !== undefined) {
    entries.push({ key: EDU_AI_KEYS.ai_api_url, value: ai_api_url, type: 'string' });
  }
  // 留空 = 不修改：页面上回显的是掩码串，不能把掩码当成新密钥写回去
  if (ai_api_key && String(ai_api_key).trim()) {
    entries.push({ key: EDU_AI_KEYS.ai_api_key, value: String(ai_api_key).trim(), type: 'string', secret: true });
  }
  if (ai_model !== undefined) {
    entries.push({ key: EDU_AI_KEYS.ai_model, value: ai_model, type: 'string' });
  }
  if (ai_vision_model !== undefined) {
    entries.push({ key: EDU_AI_KEYS.ai_vision_model, value: ai_vision_model, type: 'string' });
  }
  if (ai_enabled !== undefined) {
    entries.push({ key: EDU_AI_KEYS.ai_enabled, value: !!ai_enabled, type: 'boolean' });
  }

  if (entries.length) {
    await configStore.setMany(EDU_AI_NS, entries, { userId: req.userId });
    configStore.reload(EDU_AI_NS);
  }
  res.json({ success: true });
});

// 仅供服务端内部使用 - 获取完整AI配置
async function getAIConfig() {
  const config = await readEduAi();
  return {
    apiUrl: config.ai_api_url || DEFAULT_AI_CONFIG.ai_api_url,
    apiKey: config.ai_api_key || '',
    model: config.ai_model || DEFAULT_AI_CONFIG.ai_model,
    visionModel: config.ai_vision_model || DEFAULT_AI_CONFIG.ai_vision_model,
    enabled: isEnabled(config.ai_enabled)
  };
}

// 手动同步系统分类（为当前账本补齐缺失的系统分类）
router.post('/sync-categories', auth, operLog('分类同步', 2), async (req, res) => {
  const { getBookRole } = require('../middleware/bookAccess');
  const { syncCategoriesForBook } = require('../scripts/sync-categories');
  const bookId = req.body.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });
  const added = await syncCategoriesForBook(bookId);
  res.json({ success: true, added });
});

module.exports = router;
module.exports.getAIConfig = getAIConfig;
