/**
 * 工程审计 Agent 取证循环（function-calling）
 * 眼睛＝PaddleOCR 已把资料结构化为 audit_element；大脑＝Seed 模型通过工具自行检索取证，
 * 最终成稿强约束：每个事实挂证据编号、无依据即答"未发现"并列应补清单，禁止编造数字。
 */
const ark = require('../arkClient');
const { createToolContext } = require('./tools');
const { createJsonFieldStreamer } = require('../../jsonFieldStream');

const MAX_TOOL_ROUNDS = 6;

const SYSTEM_PROMPT = `你是工程结算审计专家助手，服务于审计人员，对中标清单、控制价、结算书、合同、变更签证、发票、现场照片等工程资料进行核对与问答。

【工作方式】
1. 先用 list_documents 了解本项目已上传哪些资料及类型，再规划取证。
2. 用 search_evidence 按名称/清单编码/金额/单位检索，用 get_evidence_detail 取完整表格，用 list_seals 核签章，用 list_sheets/get_page 逐表逐页核对。可多次、多关键词交叉取证。
3. 做"左方 vs 右方"勾稽对比时（如中标清单 vs 结算书），必须分别取到两侧证据，不得只凭一侧下结论。

【铁律——违反即为错误】
- 只能依据工具返回的资料作答，严禁编造或推测任何数字、编码、金额、单位、日期、单位名称、签章。
- 答案中每个事实、数字、金额后必须用全角方括号标注证据编号，如〔e1〕；同一结论有多份证据时全部标注，如〔e2〕〔e5〕。
- 资料中查不到依据的，明确写"在所提供资料中未发现"，不得含糊带过。
- 金额保留资料原始精度并注明单位；工程量、单价、合价区分清楚；对比用 Markdown 表格。
- 签章/签字以 list_seals 识别结果为准；"无盖章/无签字/无照片/无审批"必须有对应的检索过程支撑。
- 你是审计取证助手，不替被审计单位编造理由，不给出资料之外的法律定论。`;

const FINALIZE_PROMPT = `取证结束。请严格基于上方工具实际返回的资料，输出最终答复。只输出一个 JSON 对象（不要输出 markdown 代码块、不要任何 JSON 以外的文字），结构如下：
{
  "answer": "给审计人员的正式答复，使用 Markdown；每个事实/数字/金额后用全角方括号标注证据编号如〔e1〕；左右对比用表格；先给结论再列依据；",
  "citationEids": ["e1"],
  "missing": ["资料中缺失、需被审计单位补充的材料，或因资料不足无法确认的事项；没有则为空数组"],
  "confidence": "high|mid|low"
}
规则：citationEids 只能填写工具结果中真实出现过的证据编号，且必须与 answer 中标注的编号一致；凡无证据支撑的内容，一律写入 missing，不得在 answer 中编造。
字段顺序必须严格保持 answer 在第一位，不要调整顺序，也不要输出任何注释或说明文字。`;

function extractEids(text) {
  const set = new Set();
  const re = /e\d+/g;
  let m;
  while ((m = re.exec(String(text || '')))) set.add(m[0]);
  return Array.from(set);
}

/**
 * 运行一次审计问答 Agent
 * @param {object} p
 * @param {string|number} p.projectId
 * @param {string} p.question
 * @param {Array<{role:string,content:string}>} [p.history] 既往对话（仅 user/assistant 文本）
 * @param {Function} [p.onEvent] 过程事件回调，用于「边跑边推」给前端。事件类型：
 *        - progress 取证轮次推进 / 进入成稿阶段：{ phase, round, maxRounds, text }
 *        - tool     单个工具调用开始与结束：{ round, tool, args, status, count, eids, error, ms }
 *        - answer   成稿正文增量：{ text } 或降级重来时的 { reset:true }
 * @returns {Promise<{answer,citations,missing,confidence,trace,model,modelKey,usage,rounds}>}
 */
async function runAgent({ projectId, question, history = [], onEvent = null, userId = null }) {
  // 写入 sl_sys_ai_log 的业务上下文（取证循环 + 成稿，所有模型尝试统一归属）
  const aiLogCtx = { businessType: 'audit_chat', businessId: String(projectId), userId };
  // 事件回调只服务于「让用户看到进展」，自身异常绝不能影响取证主流程
  const emit = (type, data) => {
    if (!onEvent) return;
    try { onEvent({ type, ...data }); } catch { /* 忽略回调异常 */ }
  };
  const ctx = createToolContext(projectId);
  const trace = [];
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const h of history.slice(-6)) {
    if (h.role === 'user' || h.role === 'assistant') messages.push({ role: h.role, content: String(h.content || '') });
  }
  messages.push({ role: 'user', content: question });

  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let lastModel = null;
  let lastModelKey = null;
  let rounds = 0;

  const accumulateUsage = (u) => {
    if (!u) return;
    totalUsage.prompt_tokens += u.prompt_tokens || 0;
    totalUsage.completion_tokens += u.completion_tokens || 0;
    totalUsage.total_tokens += u.total_tokens || 0;
  };

  // 阶段一：工具取证循环
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rounds = round + 1;
    emit('progress', {
      phase: 'evidence', round: rounds, maxRounds: MAX_TOOL_ROUNDS,
      text: `第 ${rounds} 轮取证：正在判断该调阅哪些资料…`
    });
    const resp = await ark.chatCompletion({
      ...aiLogCtx,
      messages,
      tools: ctx.definitions,
      toolChoice: 'auto',
      temperature: 0.1,
      maxTokens: 4096,
      timeoutMs: 120000
    });
    accumulateUsage(resp.usage);
    lastModel = resp.model;
    lastModelKey = resp.modelKey;

    const toolCalls = resp.toolCalls || [];
    if (!toolCalls.length) {
      // 模型认为无需再取证，提前结束（其文本作为草稿，最终仍统一走成稿）
      emit('progress', { phase: 'evidence', round: rounds, maxRounds: MAX_TOOL_ROUNDS, text: '资料梳理完成，准备成稿…' });
      messages.push({ role: 'assistant', content: resp.content || '' });
      break;
    }
    messages.push({
      role: 'assistant',
      content: resp.content || '',
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function?.name, arguments: tc.function?.arguments || '{}' }
      }))
    });

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
      const step = { round: round + 1, tool: name, args, ok: true };
      emit('tool', { round: step.round, tool: name, args, status: 'running' });
      const toolStarted = Date.now();
      let resultText;
      try {
        resultText = await ctx.execute(name, args);
        step.eids = extractEids(resultText);
        let parsed = null;
        try { parsed = JSON.parse(resultText); } catch {}
        if (parsed) {
          step.count = parsed.count ?? (parsed.evidence ? parsed.evidence.length : undefined);
          if (parsed.error) { step.ok = false; step.error = parsed.error; }
        }
      } catch (e) {
        step.ok = false;
        step.error = e.message;
        resultText = JSON.stringify({ error: e.message });
      }
      step.ms = Date.now() - toolStarted;
      trace.push(step);
      emit('tool', {
        round: step.round, tool: name, args,
        status: step.ok ? 'ok' : 'fail',
        count: step.count, eids: step.eids, error: step.error, ms: step.ms
      });
      messages.push({ role: 'tool', tool_call_id: tc.id, name, content: resultText });
    }
  }

  // 阶段二：基于取证结果成稿（JSON 强约束）
  // 这里必须流式，两个理由：①长答复走非流式容易被中间网络设备按空闲超时掐断；
  // ②可以把 JSON 里的 answer 字段实时解码推给前端，用户边生成边读，而不是干等。
  messages.push({ role: 'system', content: FINALIZE_PROMPT });
  emit('progress', { phase: 'finalize', text: '取证完成，正在依据证据成稿…' });
  const answerStream = createJsonFieldStreamer('answer');
  const finalParams = { messages, json: true, temperature: 0.05, maxTokens: 4096, timeoutMs: 120000 };
  let finalResp = null;
  try {
    finalResp = await ark.chatCompletion({
      ...finalParams,
      ...aiLogCtx,
      stream: true,
      // 降级到备用模型前先清空，免得两个模型的半截正文粘成一段
      onReset: () => { answerStream.reset(); emit('answer', { reset: true }); },
      onDelta: (d) => {
        const delta = answerStream.push(d);
        if (delta) emit('answer', { text: delta });
      }
    });
    if (!finalResp || !String(finalResp.content || '').trim()) throw new Error('流式成稿未返回任何内容');
  } catch (e) {
    // 网关不支持 stream + json_object、或流中途断开：退回非流式，功能不退化（只是不再逐字）
    console.warn(`[agentLoop] 流式成稿失败，退回非流式：${e.message}`);
    emit('answer', { reset: true });
    emit('progress', { phase: 'finalize', text: '成稿重试中…' });
    finalResp = await ark.chatCompletion({ ...finalParams, ...aiLogCtx });
  }
  accumulateUsage(finalResp.usage);
  lastModel = finalResp.model || lastModel;
  lastModelKey = finalResp.modelKey || lastModelKey;

  let parsedFinal;
  try {
    // 兼容个别模型在 JSON 外包裹内容
    const raw = finalResp.content || '';
    const m = raw.match(/\{[\s\S]*\}/);
    parsedFinal = JSON.parse(m ? m[0] : raw);
  } catch {
    // JSON 解析失败则降级为纯文本答案，引用从正文抽取
    parsedFinal = { answer: finalResp.content || '（模型返回格式异常，请重试）', citationEids: extractEids(finalResp.content), missing: [], confidence: 'low' };
  }

  let answer = String(parsedFinal.answer || '').trim();
  // 仅保留本次真实取证到的证据编号
  const validEids = new Set(ctx.bag.keys());
  let cited = Array.isArray(parsedFinal.citationEids) ? parsedFinal.citationEids.filter(e => validEids.has(e)) : [];
  const inAnswer = extractEids(answer).filter(e => validEids.has(e));
  inAnswer.forEach(e => { if (!cited.includes(e)) cited.push(e); });
  // 清除正文中无效的证据标记
  answer = answer.replace(/〔(e\d+)〕/g, (whole, eid) => (validEids.has(eid) ? whole : ''));

  const citations = cited.map(eid => ctx.bag.get(eid));
  const missing = Array.isArray(parsedFinal.missing) ? parsedFinal.missing.map(String) : [];

  return {
    answer,
    citations,
    missing,
    confidence: ['high', 'mid', 'low'].includes(parsedFinal.confidence) ? parsedFinal.confidence : 'mid',
    trace,
    model: lastModel,
    modelKey: lastModelKey,
    usage: totalUsage,
    rounds,
    evidenceCount: ctx.bag.size
  };
}

module.exports = { runAgent, SYSTEM_PROMPT, extractEids };
