/**
 * 火山方舟 Ark 客户端（OpenAI 兼容 /chat/completions）
 *
 * 模型链完全由「模型配置」页（/pc/ai-model-config.html）决定，
 * 持久化为统一配置中心（utils/configStore）中 `audit.ai` 域的 `model_chain` 键：
 *   - activeModel            当前主模型，永远排在调用链第一位
 *   - models[] 数组顺序       即降级优先级：主模型之后按数组顺序依次尝试
 *   - models[].enabled       关掉即彻底跳过该模型（不想用某个模型就把它关掉）
 *   - models[].timeoutMs     该模型专属超时（毫秒）；未配置则用调用方传入值
 *   - chainTimeoutMs         整条链的总时间预算，防止「单模型超时 × N 个模型」成倍放大
 *   - failoverEnabled=false  只调用主模型，一次都不试备用（不想等前两个就用它）
 *   - baseUrl / apiKey 留空时回退环境变量 ARK_BASE_URL / ARK_API_KEY
 *   - 主模型遇到 欠费(402)/限流(429)/无权限(403)/服务端5xx/网络超时/模型未开通 时，
 *     自动切换到下一个已启用备用模型；参数类 400 不切换
 *   - 读取带 30 秒缓存（由 configStore 统一维护），保存后可调 reload() 立即生效
 *
 * 超时语义（重要）：
 *   调用方传 stream=true 时 timeoutMs 是「空闲超时」——每收到一段 SSE 数据就重置计时，
 *   只要模型还在持续吐 token 就不会被中断；非流式则是「整体超时」。
 *   清标这类长报告必须流式，否则会卡在 ~307s 被中间网络设备按空闲超时掐断（fetch failed），
 *   导致主模型必定降级到弱模型、报告漏检。
 */
const configStore = require('../configStore');
const { recordAIRequest } = require('../aiLogger');
const { createdBy } = require('../auditContext');

const DEFAULT_BASE_URL = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';

// 模型链在统一配置中心中的归属（换域只需改这两行，业务代码不动）
const CONFIG_NS = 'audit.ai';
const CONFIG_KEY = 'model_chain';
const CONFIG_DESC = '审计 Agent 模型链（主模型 + 备用降级顺序 + 各模型超时 + 故障转移开关）';

function envDefaults() {
  return {
    failoverEnabled: true,
    activeModel: process.env.ARK_MODEL || 'doubao-seed-evolving',
    chainTimeoutMs: 1800000,
    models: [
      {
        key: 'seed-evolving',
        label: 'Doubao-Seed-Evolving（投稿口径 = Seed-2.1-pro-0915）',
        model: process.env.ARK_MODEL || 'doubao-seed-evolving',
        baseUrl: '', apiKey: '', role: 'primary', enabled: true,
        timeoutMs: 900000,
        supportsTools: true, supportsVision: true,
        freeQuota: '50万tokens免费额度',
        note: '活动指定模型，工具调用/多模态/Agent 能力最强；长报告单次可达 15 分钟'
      },
      {
        key: 'seed-21-turbo',
        label: 'Doubao-Seed-2.1-turbo（备用1）',
        model: 'doubao-seed-2-1-turbo-260628',
        baseUrl: '', apiKey: '', role: 'backup', enabled: true,
        timeoutMs: 600000,
        supportsTools: true, supportsVision: true,
        freeQuota: '50万tokens免费额度',
        note: '同代 turbo，主模型欠费/限流时自动顶上'
      },
      {
        key: 'seed-20-lite',
        label: 'Doubao-Seed-2.0-lite（备用2）',
        model: 'doubao-seed-2-0-lite-260215',
        baseUrl: '', apiKey: '', role: 'backup', enabled: true,
        timeoutMs: 300000,
        supportsTools: true, supportsVision: true,
        freeQuota: '免费额度',
        note: '再兜底，轻量低成本；长清单逐项核对能力较弱'
      }
    ]
  };
}

/** 库内配置与环境变量合并：空 baseUrl/apiKey 回退 env */
function withEnv(cfg) {
  const base = envDefaults();
  // 库内配置可能是旧版本写入的（没有 timeoutMs 等后加字段），
  // 按 key 回退到内置默认，避免“字段缺失 = 0 = 退化成 120s 兜底”这种静默降级。
  const baseByKey = new Map(base.models.map(m => [m.key, m]));
  const merged = {
    failoverEnabled: cfg.failoverEnabled !== false,
    activeModel: cfg.activeModel || base.activeModel,
    chainTimeoutMs: Number(cfg.chainTimeoutMs) > 0 ? Number(cfg.chainTimeoutMs) : base.chainTimeoutMs,
    models: (Array.isArray(cfg.models) && cfg.models.length ? cfg.models : base.models).map(m => ({
      ...m,
      timeoutMs: Number(m.timeoutMs) > 0
        ? Number(m.timeoutMs)
        : (baseByKey.get(m.key)?.timeoutMs || 0),
      baseUrl: m.baseUrl || process.env.ARK_BASE_URL || DEFAULT_BASE_URL,
      apiKey: m.apiKey || process.env.ARK_API_KEY || '',
      enabled: m.enabled !== false
    }))
  };
  return merged;
}

/** 读取模型链配置。缓存由 configStore 统一维护（30s TTL），force=true 强制重读 */
async function getConfig(force = false) {
  if (force) configStore.reload(CONFIG_NS);
  let cfg = null;
  try {
    const stored = await configStore.get(CONFIG_NS, CONFIG_KEY, null);
    if (stored && typeof stored === 'object') cfg = withEnv(stored);
  } catch (err) {
    console.warn('[arkClient] 读取模型配置失败，使用环境变量默认:', err.message);
  }
  if (!cfg) cfg = withEnv(envDefaults());
  return cfg;
}

async function saveConfig(cfg, userId) {
  // 持久化时不落 env 回退值：baseUrl/apiKey 等于 env 的写空串
  const persisted = {
    failoverEnabled: !!cfg.failoverEnabled,
    activeModel: cfg.activeModel,
    chainTimeoutMs: Number(cfg.chainTimeoutMs) > 0 ? Number(cfg.chainTimeoutMs) : 0,
    models: (cfg.models || []).map(m => ({
      key: m.key, label: m.label, model: m.model, role: m.role,
      enabled: m.enabled !== false,
      timeoutMs: Number(m.timeoutMs) > 0 ? Number(m.timeoutMs) : 0,
      supportsTools: !!m.supportsTools, supportsVision: !!m.supportsVision,
      freeQuota: m.freeQuota || '', note: m.note || '',
      baseUrl: m.baseUrl && m.baseUrl !== (process.env.ARK_BASE_URL || DEFAULT_BASE_URL) ? m.baseUrl : '',
      apiKey: m.apiKey && m.apiKey !== process.env.ARK_API_KEY ? m.apiKey : ''
    }))
  };
  await configStore.set(CONFIG_NS, CONFIG_KEY, persisted, {
    type: 'json',
    description: CONFIG_DESC,
    userId
  });
  return getConfig(true);
}

/** 清模型链缓存，下次读取即从库重载 */
function reload() { configStore.reload(CONFIG_NS); }

/**
 * 按配置生成调用链。**数组顺序即降级优先级**：
 *   activeModel 永远排第一，其后按 models 数组顺序追加「已启用」的模型。
 *   - 不想用某个模型 → 前端把它 enabled 关掉，这里直接跳过（一次都不试）
 *   - 不想试任何备用 → failoverEnabled=false，只返回主模型
 */
function buildChain(cfg) {
  const all = cfg.models || [];
  const active = all.find(m => m.model === cfg.activeModel || m.key === cfg.activeModel)
    || all.find(m => m.role === 'primary')
    || all[0];
  if (!active || active.enabled === false) return [];
  if (!cfg.failoverEnabled) return [active];
  const backups = all.filter(m => m !== active && m.enabled !== false);
  return [active, ...backups];
}

/** 判断错误是否值得切换到下一个模型 */
function isFailoverStatus(status, bodyText) {
  if ([402, 403, 404, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status === 400) {
    // 模型未开通 / 模型不存在 / 不支持某能力 等模型侧问题才切换；纯参数错误不切换
    return /model|not found|not support|unavailable|decommission|下线|未开通|不存在|不支持/i.test(bodyText || '');
  }
  return false;
}

/**
 * 解析 OpenAI 兼容的 SSE 流，返回与非流式等价的返回结构。
 * 关键点：每收到一段数据就回调 armTimeout 重置计时 —— 即流式使用「空闲超时」，
 * 只要模型还在持续吐 token 就不会被中断（长报告因此可以跑过代理的固定空闲阈值）。
 * @param {Function} [onDelta] 每收到一段正文即回调 (增量文本, 累计文本)，
 *        供上层做「边生成边下发」（如智能问答的逐字渲染）
 */
async function readSse(res, armTimeout, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', content = '', reasoning = '', usage = null, modelId = null;
  const toolCalls = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    armTimeout();
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let chunk = null;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.model) modelId = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (!d) continue;
      if (d.content) {
        content += d.content;
        if (onDelta) { try { onDelta(d.content, content); } catch { /* 回调异常不影响流读取 */ } }
      }
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index || 0;
          toolCalls[i] = toolCalls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id += tc.id;
          if (tc.function && tc.function.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function && tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  }
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  const tcs = toolCalls.filter(Boolean);
  if (tcs.length) message.tool_calls = tcs;
  return { model: modelId, choices: [{ message, finish_reason: 'stop' }], usage };
}

/**
 * 单次调用（默认非流式，行为不变）。
 * opts.stream=true 时走 SSE 流式请求：长报告生成期间Ark 在思考阶段不返回任何字节，
 * 非流式请求会被中间网络设备按「空闲超时」掐断（实测固定在 ~307s 报 fetch failed，
 * 导致主模型必定降级到弱模型、报告漏检）。流式下持续下发 token，可稳定跑完。
 */
async function callOnce(model, payload, timeoutMs, opts = {}) {
  if (!model.apiKey) throw new Error(`模型 ${model.model} 未配置 API Key（env ARK_API_KEY 也为空）`);
  const useStream = opts.stream === true;
  const controller = new AbortController();
  let timer = null;
  const armTimeout = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };
  armTimeout();
  try {
    const body = { ...payload, model: model.model };
    if (useStream) {
      body.stream = true;
      body.stream_options = { include_usage: true }; // 尽量拿到 usage（部分网关不支持，拿不到也不影响）
    }
    const res = await fetch(`${model.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${model.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      const err = new Error((json && (json.error?.message || json.message)) || text.slice(0, 300) || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = text.slice(0, 800);
      err.failover = isFailoverStatus(res.status, text);
      throw err;
    }
    if (useStream) return await readSse(res, armTimeout, opts.onDelta);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return json;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 对话补全（OpenAI 兼容，支持 tools 与多模态 messages）
 * @param {object} p
 * @param {Array} p.messages
 * @param {Array} [p.tools]
 * @param {string|object} [p.toolChoice]
 * @param {boolean} [p.json] 要求 JSON 输出
 * @param {number} [p.temperature]
 * @param {number} [p.maxTokens]
 * @param {number} [p.timeoutMs] 默认 120s
 * @param {boolean} [p.stream] 流式请求（长输出必开：非流式会被中间设备按空闲超时掐断）
 * @param {Function} [p.onDelta] 流式下每段正文回调 (增量, 累计)，用于边生成边下发
 * @param {Function} [p.onReset] 降级到备用模型前回调，上层据此清空已下发的半截内容
 * @param {string} [p.businessType] 业务类型（写入 sl_sys_ai_log），如 audit_chat/bid_clearing
 * @param {string|number} [p.businessId] 业务标识（项目ID/会话ID）
 * @param {string|number} [p.userId] 发起人，缺省取异步上下文用户
 * @returns {Promise<{content:string, toolCalls:Array, model:string, usage:object, chain:Array, raw:object}>}
 */
async function chatCompletion(p) {
  const cfg = await getConfig();
  const chain = buildChain(cfg);
  if (chain.length === 0) throw new Error('未配置任何可用模型，请在「模型设置」中启用');

  const payload = {
    messages: p.messages,
    temperature: p.temperature ?? 0.1,
    max_tokens: p.maxTokens || 4096
  };
  if (p.tools && p.tools.length) {
    payload.tools = p.tools;
    payload.tool_choice = p.toolChoice || 'auto';
  }
  if (p.json) payload.response_format = { type: 'json_object' };

  const attempts = [];
  let lastErr;
  // 整条模型链的总时间预算：优先用调用方传入，其次用「模型配置」页的 chainTimeoutMs。
  // 目的是兜住“单模型超时 × N 个模型”的累积放大——曾出现 600s × 3 个模型、最坏 30 分钟才出结果。
  const budget = p.totalTimeoutMs > 0 ? p.totalTimeoutMs : (cfg.chainTimeoutMs > 0 ? cfg.chainTimeoutMs : 0);
  const deadline = budget > 0 ? Date.now() + budget : 0;
  for (const model of chain) {
    const started = Date.now();
    // 降级重试：上一个模型可能已经吐了一部分内容（流中断），
    // 内容已作废，先让上层清空再重新累计，避免前后两段模型输出粘在一起。
    if (attempts.length && p.onReset) { try { p.onReset(); } catch { /* ignore */ } }
    // 超时优先级：模型级配置（页面可改）> 调用方传入 > 默认 120s
    const asked = model.timeoutMs > 0 ? model.timeoutMs : (p.timeoutMs || 120000);
    let perModelTimeout = asked;
    if (deadline) {
      const remain = deadline - Date.now();
      if (remain < 5000) {
        attempts.push({ key: model.key, model: model.model, ok: false, latencyMs: 0, error: '总时间预算已耗尽，跳过该模型', status: null });
        continue;
      }
      perModelTimeout = Math.min(perModelTimeout, remain);
    }
    const reqTime = new Date();
    const logCtx = {
      userId: p.userId || createdBy(),
      businessType: p.businessType || 'ark_chat',
      businessId: p.businessId
    };
    try {
      const json = await callOnce(model, payload, perModelTimeout, { stream: p.stream === true, onDelta: p.onDelta });
      const msg = json.choices && json.choices[0] && json.choices[0].message;
      attempts.push({ key: model.key, model: model.model, ok: true, latencyMs: Date.now() - started });
      recordAIRequest({
        ...logCtx,
        requestUrl: `${model.baseUrl.replace(/\/$/, '')}/chat/completions`,
        requestModel: model.model,
        requestBody: { ...payload, model: model.model, stream: p.stream === true },
        responseResult: json,
        requestTime: reqTime,
        responseTime: new Date(),
        status: 0
      });
      const failedBefore = attempts.filter(a => !a.ok);
      if (failedBefore.length) {
        console.warn(`[ark] 已降级到 ${model.model}（此前失败：${failedBefore.map(a => `${a.model}:${a.error || a.status}`).join(' | ')}）`);
      }
      return {
        content: msg?.content || '',
        toolCalls: msg?.tool_calls || [],
        reasoning: msg?.reasoning_content || '',
        model: json.model || model.model,
        modelKey: model.key,
        usage: json.usage || null,
        chain: attempts,
        raw: json
      };
    } catch (err) {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      attempts.push({ key: model.key, model: model.model, ok: false, latencyMs: Date.now() - started, error: err.message, status: err.status });
      recordAIRequest({
        ...logCtx,
        requestUrl: `${model.baseUrl.replace(/\/$/, '')}/chat/completions`,
        requestModel: model.model,
        requestBody: { ...payload, model: model.model, stream: p.stream === true },
        responseResult: null,
        requestTime: reqTime,
        responseTime: new Date(),
        status: 1,
        errorMsg: `${err.status != null ? 'HTTP' + err.status + ' ' : ''}${err.message}`
      });
      lastErr = err;
      const canFailover = err.name === 'AbortError' || err.failover === true || !err.status;
      console.warn(`[ark] 模型 ${model.model} 调用失败(${secs}s, ${canFailover ? '可降级' : '不可降级'})：${err.message}`);
      if (!cfg.failoverEnabled || !canFailover) break;
    }
  }
  const e = new Error(`所有模型均调用失败：${lastErr?.message || '未知错误'}`);
  e.attempts = attempts;
  throw e;
}

/** 连通性测试：逐个模型发极简请求 */
async function testChain(timeoutMs = 30000) {
  const cfg = await getConfig(true);
  const models = (cfg.models || []).filter(m => m.enabled !== false);
  const results = [];
  for (const model of models) {
    const started = Date.now();
    const reqTime = new Date();
    const testPayload = {
      messages: [{ role: 'user', content: 'ping，请回复：pong' }],
      max_tokens: 16,
      temperature: 0,
      model: model.model
    };
    try {
      const json = await callOnce(model, testPayload, timeoutMs);
      results.push({
        key: model.key, label: model.label, model: model.model,
        ok: true, latencyMs: Date.now() - started,
        reply: (json.choices?.[0]?.message?.content || '').slice(0, 50),
        isActive: cfg.activeModel === model.model || cfg.activeModel === model.key
      });
      recordAIRequest({
        userId: createdBy(),
        businessType: 'model_test',
        businessId: model.key,
        requestUrl: `${model.baseUrl.replace(/\/$/, '')}/chat/completions`,
        requestModel: model.model,
        requestBody: testPayload,
        responseResult: json,
        requestTime: reqTime,
        responseTime: new Date(),
        status: 0
      });
    } catch (err) {
      results.push({
        key: model.key, label: model.label, model: model.model,
        ok: false, latencyMs: Date.now() - started,
        error: err.message, status: err.status || null,
        isActive: cfg.activeModel === model.model || cfg.activeModel === model.key
      });
      recordAIRequest({
        userId: createdBy(),
        businessType: 'model_test',
        businessId: model.key,
        requestUrl: `${model.baseUrl.replace(/\/$/, '')}/chat/completions`,
        requestModel: model.model,
        requestBody: testPayload,
        responseResult: null,
        requestTime: reqTime,
        responseTime: new Date(),
        status: 1,
        errorMsg: `${err.status != null ? 'HTTP' + err.status + ' ' : ''}${err.message}`
      });
    }
  }
  return { failoverEnabled: cfg.failoverEnabled, activeModel: cfg.activeModel, results };
}

/** 给前端的脱敏配置（不回显 key） */
async function getPublicConfig() {
  const cfg = await getConfig();
  const chain = buildChain(cfg);
  const chainKeys = chain.map(m => m.key);
  return {
    failoverEnabled: cfg.failoverEnabled,
    activeModel: cfg.activeModel,
    chainTimeoutMs: cfg.chainTimeoutMs,
    models: cfg.models.map(m => ({
      key: m.key, label: m.label, model: m.model,
      // role 按当前 activeModel 动态推导，避免改了主模型后标签still写着「备用1」
      role: (m.model === cfg.activeModel || m.key === cfg.activeModel) ? 'primary' : 'backup',
      enabled: m.enabled !== false,
      timeoutMs: m.timeoutMs || 0,
      inChain: chainKeys.includes(m.key),
      chainOrder: chainKeys.indexOf(m.key) + 1, // 0 = 未进入调用链
      supportsTools: !!m.supportsTools, supportsVision: !!m.supportsVision,
      freeQuota: m.freeQuota || '', note: m.note || '',
      hasCustomKey: !!m.apiKey && m.apiKey !== process.env.ARK_API_KEY,
      usingEnvKey: !m.apiKey || m.apiKey === process.env.ARK_API_KEY,
      hasKey: !!m.apiKey,
      hasCustomBaseUrl: !!m.baseUrl && m.baseUrl !== (process.env.ARK_BASE_URL || DEFAULT_BASE_URL)
    })),
    // 实际调用顺序预览：一眼看清「先试谁、失败后落到谁」
    effectiveChain: chain.map((m, i) => ({
      order: i + 1, key: m.key, label: m.label, model: m.model, timeoutMs: m.timeoutMs || 0
    }))
  };
}

module.exports = { chatCompletion, testChain, getConfig, getPublicConfig, saveConfig, reload, buildChain, DEFAULT_BASE_URL };
