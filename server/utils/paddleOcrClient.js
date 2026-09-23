/**
 * PaddleOCR-VL 官方在线 API（AI Studio）Node 客户端
 * 文档：https://www.paddleocr.ai/latest/version3.x/inference_deployment/serving/paddleocr_official_api/python.html
 *
 * 能力：PDF（含扫描件）/图片 → 版面分析、OCR、跨页表格合并、印章识别、标题分级
 * 流程：创建任务(multipart) → 轮询任务状态 → 拉取 JSONL 结果 → 归一化
 *
 * 环境变量：
 *   OCR_KEY                   AI Studio access token（https://aistudio.baidu.com/account/accessToken）
 *   OCR_BASE_URL              默认 https://paddleocr.aistudio-app.com
 *   OCR_API_VERSION           默认 v2
 *   OCR_MODEL                 默认 PaddleOCR-VL-1.6
 *   OCR_POLL_INTERVAL_MS      轮询间隔，默认 3000
 *   OCR_TIMEOUT_MS            单任务总超时，默认 600000
 */
const fs = require('fs');
const path = require('path');
const { recordAIRequest } = require('./aiLogger');
const { createdBy } = require('./auditContext');
// 注意：必须使用 Node 内置全局 FormData/Blob（Node 18+）。
// 第三方 form-data 包生成的流在全局 fetch(undici) 下会出现 multipart 边界不被服务端识别的问题
// （服务端返回 code=10007「模型传参错误」）。

const BASE_URL = (process.env.OCR_BASE_URL || 'https://paddleocr.aistudio-app.com').replace(/\/$/, '');
const API_VERSION = process.env.OCR_API_VERSION || 'v2';
const MODEL = process.env.OCR_MODEL || 'PaddleOCR-VL-1.6';
const POLL_INTERVAL = Number(process.env.OCR_POLL_INTERVAL_MS || 3000);
const DEFAULT_TIMEOUT = Number(process.env.OCR_TIMEOUT_MS || 600000);

const JOB_URL = `${BASE_URL}/api/${API_VERSION}/ocr/jobs`;

class PaddleOcrError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'PaddleOcrError';
    this.code = code;
    this.status = status;
  }
}

function getToken() {
  const token = process.env.OCR_KEY;
  if (!token || token === 'your_aistudio_access_token' || token === 'fdjsakfjdsakjfdsakfjkasfds') {
    throw new PaddleOcrError('OCR_KEY 未配置或仍为占位值，请在 server/.env.development 填入 AI Studio access token', 'NO_TOKEN');
  }
  return token;
}

/** 带超时的 fetch 封装 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new PaddleOcrError(`请求超时: ${url}`, 'TIMEOUT');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 瞬时故障重试策略
 * AI Studio 官方共享推理队列在高峰期会返回业务码 10010「任务提交队列已满」，
 * 实测该错误是随机出现的（同一文件连续提交约 1/3 概率被拒），重试即可成功。
 * 若不重试会让「上传 PDF/图片 → 解析」链路随机失败，故统一指数退避重试。
 */
const RETRYABLE_BIZ_CODES = new Set([10010, 10011, 12001]); // 队列已满 / 并发受限 / 服务繁忙
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const CREATE_RETRY_MAX = Number(process.env.OCR_CREATE_RETRY_MAX || 8);
const POLL_RETRY_MAX = Number(process.env.OCR_POLL_RETRY_MAX || 4);
const RETRY_BASE_MS = Number(process.env.OCR_RETRY_BASE_MS || 2000);
const RETRY_CAP_MS = Number(process.env.OCR_RETRY_CAP_MS || 20000);

/** 该次失败是否值得重试（HTTP 状态码或业务码任一命中即可） */
function isRetryable(status, body) {
  const biz = body && typeof body === 'object' ? Number(body.code) : NaN;
  if (Number.isFinite(biz) && biz !== 0 && RETRYABLE_BIZ_CODES.has(biz)) return true;
  return RETRYABLE_STATUS.has(Number(status));
}

/** 指数退避 + 抖动，避免多文件同时重试再次撞满队列 */
function retryDelay(attempt) {
  const base = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
  return base + Math.floor(Math.random() * 500);
}

/** 读取响应体（优先 JSON，失败则退回纯文本并包成 {msg}，保证错误信息不丢） */
async function readBody(res) {
  const raw = await res.text().catch(() => '');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { msg: raw.replace(/\s+/g, ' ').trim().slice(0, 300) };
  }
}

/** 构造统一的 API 异常（纯函数，不读取响应体） */
function makeApiError(res, action, body) {
  const biz = body && typeof body === 'object' && body.code != null ? Number(body.code) : null;
  const detail = body && typeof body === 'object'
    ? (body.msg || body.message || (body.errors ? JSON.stringify(body.errors) : ''))
    : String(body == null ? '' : body);
  const map = {
    401: 'Access Token 无效或已过期，请检查 OCR_KEY（https://aistudio.baidu.com/account/accessToken）',
    403: '没有 OCR 接口权限或资源不可访问',
    404: 'OCR 任务不存在',
    413: '文件过大，超出 OCR 服务限制',
    415: '不支持的文件类型（仅支持 PDF/PNG/JPG/JPEG/WebP/BMP/TIFF）'
  };
  let suffix = map[res.status] || detail || res.statusText;
  if (biz != null && biz !== 0 && !String(suffix).includes(String(biz))) suffix += `（code=${biz}）`;
  return new PaddleOcrError(
    `${action}失败(HTTP ${res.status})：${suffix}`,
    biz != null && biz !== 0 ? 'API_' + biz : 'HTTP_' + res.status,
    res.status
  );
}

/** 注意：本模块抛错统一走 makeApiError(res, action, body)。
 *  不要再提供「接收 Response 自行读体」的抛错函数——调用方若已读过响应体，
 *  二次读取只能拿到空体，真实错误原因会退化成 statusText（如 "Bad Request"），
 *  历史上曾因此把「队列已满」这样的可诊断信息吞掉。
 */

/**
 * 创建 OCR 任务
 * @param {Buffer} fileBuffer 文件二进制
 * @param {string} fileName 文件名（含扩展名）
 * @param {string} mimeType MIME
 * @param {object} extraPayload 可选参数覆盖
 * @returns {Promise<string>} jobId
 */
async function createJob(fileBuffer, fileName, mimeType, extraPayload = {}) {
  // 审计场景默认参数：版面分析 + 印章 + 跨页表格合并 + 标题分级 + 方向/扭曲矫正，temperature=0 保证稳定
  const payload = {
    useLayoutDetection: true,
    useChartRecognition: false,
    useSealRecognition: true,
    useOcrForImageBlock: false,
    mergeTables: true,
    relevelTitles: true,
    useDocOrientationClassify: true,
    useDocUnwarping: true,
    layoutNms: true,
    layoutShapeMode: 'auto',
    temperature: 0.0,
    topP: 1.0,
    repetitionPenalty: 1.05,
    ...extraPayload
  };

  // 每次尝试重建 FormData（Blob 可重复读取，但重建可彻底规避流被消费的风险）
  // 使用全局 FormData 时不要手动设置 Content-Type，由 fetch 自动写入带 boundary 的 multipart 头
  const buildForm = () => {
    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: mimeType || 'application/octet-stream' }), fileName);
    form.append('model', MODEL);
    form.append('optionalPayload', JSON.stringify(payload));
    return form;
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= CREATE_RETRY_MAX; attempt++) {
    let res = null, body = null, netErr = null;
    try {
      res = await fetchWithTimeout(JOB_URL, {
        method: 'POST',
        headers: { Authorization: `bearer ${getToken()}` },
        body: buildForm()
      }, 120000);
      body = await readBody(res);
    } catch (e) {
      netErr = e;
    }

    const bizCode = body && typeof body === 'object' && body.code != null ? Number(body.code) : null;
    const jobId = body && typeof body === 'object' ? body.data?.jobId : null;

    if (!netErr && res.ok && jobId && (bizCode === null || bizCode === 0)) {
      if (attempt > 1) console.warn(`[ocr] 创建任务第 ${attempt} 次尝试成功（前 ${attempt - 1} 次为瞬时故障）`);
      return jobId;
    }

    const retryable = netErr ? true : isRetryable(res.status, body);
    let err;
    if (netErr) {
      err = netErr instanceof PaddleOcrError ? netErr : new PaddleOcrError(`创建OCR任务网络异常：${netErr.message}`, 'NETWORK');
    } else if (bizCode !== null && bizCode !== 0) {
      err = new PaddleOcrError(`创建OCR任务被拒(code=${bizCode})：${body.msg || body.message || '参数错误'}`, 'API_' + bizCode, res.status);
    } else if (res.ok && !jobId) {
      err = new PaddleOcrError(`创建OCR任务响应缺少 jobId：${JSON.stringify(body).slice(0, 300)}`, 'BAD_RESPONSE');
    } else {
      err = makeApiError(res, '创建OCR任务', body);
    }

    if (retryable && attempt < CREATE_RETRY_MAX) {
      const wait = retryDelay(attempt);
      console.warn(`[ocr] ${err.message} → ${(wait / 1000).toFixed(1)}s 后重试（第 ${attempt + 1}/${CREATE_RETRY_MAX} 次）`);
      lastErr = err;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (retryable) err.message += `（瞬时故障，已重试 ${CREATE_RETRY_MAX} 次仍失败，请稍后再试）`;
    throw err;
  }
  throw lastErr || new PaddleOcrError('创建OCR任务失败：重试次数已用尽', 'RETRY_EXHAUSTED');
}

/** 查询任务状态（响应业务字段均在 data 下）
 *  轮询期间的 429/5xx 等瞬时故障在内部退避重试，避免一次网络抖动就整份资料解析失败
 */
async function getJob(jobId) {
  let lastErr = null;
  for (let attempt = 1; attempt <= POLL_RETRY_MAX; attempt++) {
    let res = null, body = null, netErr = null;
    try {
      res = await fetchWithTimeout(`${JOB_URL}/${encodeURIComponent(jobId)}`, {
        headers: { Authorization: `bearer ${getToken()}` }
      }, 30000);
      body = await readBody(res);
    } catch (e) {
      netErr = e;
    }
    if (!netErr && res.ok) return (body && typeof body === 'object' ? body.data : null) || {};

    const retryable = netErr ? true : isRetryable(res.status, body);
    const err = netErr
      ? (netErr instanceof PaddleOcrError ? netErr : new PaddleOcrError(`查询OCR任务网络异常：${netErr.message}`, 'NETWORK'))
      : makeApiError(res, '查询OCR任务', body);
    if (retryable && attempt < POLL_RETRY_MAX) {
      lastErr = err;
      await new Promise(r => setTimeout(r, retryDelay(attempt)));
      continue;
    }
    throw err;
  }
  throw lastErr || new PaddleOcrError('查询OCR任务失败：重试次数已用尽', 'RETRY_EXHAUSTED');
}

/** 下载 JSONL 结果并按行解析（每行形如 {"result": {...}}） */
async function downloadJsonl(jsonUrl) {
  const res = await fetchWithTimeout(jsonUrl, {}, 120000);
  if (!res.ok) throw new PaddleOcrError(`下载OCR结果失败 HTTP ${res.status}`, 'RESULT_HTTP_' + res.status, res.status);
  const text = await res.text();
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.result) records.push(obj.result);
    } catch {
      // 跳过非 JSON 行
    }
  }
  if (records.length === 0) throw new PaddleOcrError('OCR 结果 JSONL 解析为空', 'EMPTY_RESULT');
  return records;
}

/**
 * 从 bbox 数组/对象计算归一化坐标 {x,y,w,h}，均为 0-1
 * 兼容 [x1,y1,x2,y2]、[[x1,y1],[x2,y1],[x2,y2],[x1,y2]]、{x,y,width,height} 等形态
 */
function normalizeBbox(box, pageWidth, pageHeight) {
  try {
    if (!box || !pageWidth || !pageHeight) return null;
    let xs = [], ys = [];
    if (Array.isArray(box)) {
      if (box.length === 4 && box.every(v => typeof v === 'number')) {
        xs = [box[0], box[2]]; ys = [box[1], box[3]];
      } else if (box.every(p => Array.isArray(p) && p.length >= 2)) {
        xs = box.map(p => p[0]); ys = box.map(p => p[1]);
      } else {
        return null;
      }
    } else if (typeof box === 'object') {
      if (typeof box.x === 'number' && typeof box.y === 'number') {
        const w = box.width ?? box.w ?? 0, h = box.height ?? box.h ?? 0;
        xs = [box.x, box.x + w]; ys = [box.y, box.y + h];
      } else if (Array.isArray(box.poly)) {
        return normalizeBbox(box.poly, pageWidth, pageHeight);
      } else {
        return null;
      }
    } else {
      return null;
    }
    const x1 = Math.min(...xs), y1 = Math.min(...ys), x2 = Math.max(...xs), y2 = Math.max(...ys);
    return {
      x: Number((x1 / pageWidth).toFixed(5)),
      y: Number((y1 / pageHeight).toFixed(5)),
      w: Number(((x2 - x1) / pageWidth).toFixed(5)),
      h: Number(((y2 - y1) / pageHeight).toFixed(5)),
      pageWidth, pageHeight
    };
  } catch {
    return null;
  }
}

/**
 * 从单页 prunedResult 宽容提取版面要素（字段名以真实响应为准，首跑后可校准）
 */
function extractElements(pruned) {
  const elements = [];
  const width = pruned?.width || 0;
  const height = pruned?.height || 0;
  // 真实响应为 snake_case：prunedResult.parsing_res_list
  const list = Array.isArray(pruned?.parsing_res_list) ? pruned.parsing_res_list
    : Array.isArray(pruned?.parsingResList) ? pruned.parsingResList : [];
  list.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    const label = String(
      item.block_label || item.label || item.blockLabel || item.block_type || item.type || item.category || ''
    ).toLowerCase();
    const content = item.block_content ?? item.markdown ?? item.content ?? item.text ?? item.html ?? '';
    if (!content && !label) return;
    // VL 版面标签：doc_title/figure_title/paragraph_title=标题，table=表格，seal=印章，
    // figure/picture=图片，chart=图表，formula=公式，vision_footnote=页眉页脚，number=页码/表号，text=正文
    let elementType = 'text';
    if (label === 'table' || label.includes('table')) elementType = 'table';
    else if (label === 'seal' || label.includes('seal') || label.includes('stamp')) elementType = 'seal';
    else if (label.includes('title')) elementType = 'title';
    else if (label === 'figure' || label === 'picture' || (label.includes('figure') && !label.includes('title')) || label.includes('image') || label.includes('img')) elementType = 'image';
    else if (label.includes('chart')) elementType = 'chart';
    else if (label.includes('formula')) elementType = 'formula';
    const box = item.block_bbox ?? item.blockBbox ?? item.bbox ?? item.box ?? item.poly ?? item.layout_bbox;
    elements.push({
      index: idx,
      label: item.block_label || item.label || item.block_type || item.type || '',
      elementType,
      content: String(content),
      bbox: normalizeBbox(box, width, height),
      groupId: item.group_id ?? null,
      polygon: Array.isArray(item.block_polygon_points) ? item.block_polygon_points : null,
      noisy: label === 'number' // 页码/表号不作审计证据
    });
  });
  return { elements, width, height };
}

/**
 * 兜底要素提取：VL 在线 API 不返回块坐标，从每页 markdown 中切出
 * 表格 / 居中标题 / 印章线索 / 文本段，证据定位粒度为「文件 + 页码 + 序号」
 */
function extractElementsFromMarkdown(md) {
  const elements = [];
  let idx = 0;
  const pushSealHints = (text) => {
    const re = /([\u4e00-\u9fa5A-Za-z0-9（）()·]{2,35}?(?:公章|专用章|财务专用章|合同专用章|发票专用章|印章))/g;
    let m;
    const seen = new Set();
    while ((m = re.exec(text))) {
      if (!seen.has(m[1])) { seen.add(m[1]); elements.push({ index: idx++, label: 'seal_hint', elementType: 'seal', content: m[1], bbox: null }); }
    }
  };
  const pushPlain = (raw) => {
    // 居中 div 视为标题
    const centerRe = /<div[^>]*text-align:\s*center[^>]*>([\s\S]*?)<\/div>/gi;
    let last = 0, cm;
    const flushText = (s) => {
      const t = String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (t.length >= 2) {
        pushSealHints(t);
        elements.push({ index: idx++, label: 'text', elementType: 'text', content: t.slice(0, 6000), bbox: null });
      }
    };
    while ((cm = centerRe.exec(raw))) {
      if (cm.index > last) flushText(raw.slice(last, cm.index));
      const title = cm[1].replace(/<[^>]+>/g, '').trim();
      if (title) elements.push({ index: idx++, label: 'title', elementType: 'title', content: title.slice(0, 200), bbox: null });
      last = cm.index + cm[0].length;
    }
    if (last < raw.length) flushText(raw.slice(last));
  };
  const tableRe = /<table[^>]*>[\s\S]*?<\/table>/gi;
  let last = 0, m;
  while ((m = tableRe.exec(md))) {
    if (m.index > last) pushPlain(md.slice(last, m.index));
    elements.push({ index: idx++, label: 'table', elementType: 'table', content: m[0], bbox: null });
    last = m.index + m[0].length;
  }
  if (last < md.length) pushPlain(md.slice(last));
  return elements;
}

/** 合并多段 JSONL 记录为一份结果（与官方 SDK Result 合并语义对齐） */
function mergeRecords(records) {
  const pages = [];
  let docType = 'unknown';
  for (const record of records) {
    if (record?.dataInfo?.type) docType = record.dataInfo.type;
    const lpr = Array.isArray(record?.layoutParsingResults) ? record.layoutParsingResults : [];
    for (const page of lpr) pages.push(page);
  }
  return { pages, docType };
}

/**
 * 归一化为审计模块使用的结构
 * @returns {{docType:string,numPages:number,pages:Array,markdownText:string,raw:object}}
 */
const TYPE_LABEL_CN = { table: '表格', title: '标题', seal: '印章', image: '图片', chart: '图表', formula: '公式', text: '正文' };

function normalizeResult(records) {
  const { pages: rawPages, docType } = mergeRecords(records);
  const pages = [];
  const flat = [];
  const markdownParts = [];
  rawPages.forEach((page, i) => {
    const pruned = page?.prunedResult || {};
    let { elements, width, height } = extractElements(pruned);
    const markdown = page?.markdown?.text || '';
    // VL 在线 API 对图片不返回块坐标时，从 markdown 切出表格/标题/印章/文本要素（页码级定位）
    if (elements.length === 0 && markdown) elements = extractElementsFromMarkdown(markdown);
    markdownParts.push(markdown);
    const pageNo = i + 1;
    const titleEl = elements.find(e => e.elementType === 'title');
    pages.push({
      pageNo,
      width: width || pruned?.width || 0,
      height: height || pruned?.height || 0,
      markdown,
      images: page?.markdown?.images || {},
      inputImage: page?.inputImage || '',
      outputImages: page?.outputImages || {},
      elements
    });
    // 扁平要素（对齐 Excel 解析器，供 audit_element 入库与 Agent 检索）；页码/表号等噪音跳过
    elements.forEach(e => {
      if (e.noisy) return;
      const cn = TYPE_LABEL_CN[e.elementType] || '正文';
      let anchorLabel = `第 ${pageNo} 页·${cn}`;
      if (e.elementType === 'table') anchorLabel += titleEl ? `·${titleEl.content.slice(0, 20)}` : `#${e.index + 1}`;
      const bbox = e.bbox ? { ...e.bbox, polygon: e.polygon || undefined } : null;
      flat.push({
        pageNo,
        sheetName: null,
        elementType: e.elementType,
        label: e.label || '',
        content: e.content,
        bbox,
        anchorLabel,
        groupId: e.groupId ?? null
      });
    });
  });
  return {
    docType,
    numPages: pages.length,
    pages,
    elements: flat,
    markdownText: markdownParts.join('\n\n'),
    raw: records
  };
}

/** 下载临时图片 URL 到本地（失败不阻断主流程） */
async function downloadAsset(url, targetFile) {
  try {
    const res = await fetchWithTimeout(url, {}, 60000);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * 完整执行一次 OCR：提交 → 轮询 → 取结果
 * @param {object} p
 * @param {Buffer} p.buffer 文件二进制
 * @param {string} p.fileName 文件名
 * @param {string} [p.mimeType]
 * @param {function} [p.onProgress] (progress:0-100, extra) => void
 * @returns {Promise<{jobId:string, result:object}>}
 */
async function parseFile(params) {
  const reqTime = new Date();
  try {
    const out = await _parseFileInner(params);
    recordAIRequest({
      userId: createdBy(),
      businessType: 'paddle_ocr',
      businessId: out.jobId,
      requestUrl: JOB_URL,
      requestModel: MODEL,
      requestBody: { fileName: params.fileName, mimeType: params.mimeType },
      responseResult: {
        jobId: out.jobId,
        docType: out.result.docType,
        numPages: out.result.numPages,
        elementCount: out.result.elements.length
      },
      requestTime: reqTime,
      responseTime: new Date(),
      status: 0
    });
    return out;
  } catch (err) {
    recordAIRequest({
      userId: createdBy(),
      businessType: 'paddle_ocr',
      businessId: null,
      requestUrl: JOB_URL,
      requestModel: MODEL,
      requestBody: { fileName: params.fileName, mimeType: params.mimeType },
      responseResult: null,
      requestTime: reqTime,
      responseTime: new Date(),
      status: 1,
      errorMsg: `${err.code ? '[' + err.code + '] ' : ''}${err.message}`
    });
    throw err;
  }
}

async function _parseFileInner({ buffer, fileName, mimeType, onProgress }) {
  const startedAt = Date.now();
  const jobId = await createJob(buffer, fileName, mimeType);
  onProgress && onProgress(2, { jobId, state: 'pending' });

  // 轮询
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - startedAt > DEFAULT_TIMEOUT) {
      throw new PaddleOcrError(`OCR 任务超过 ${Math.round(DEFAULT_TIMEOUT / 1000)}s 未完成（jobId=${jobId}）`, 'JOB_TIMEOUT');
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    const job = await getJob(jobId);
    const state = job.state;
    const prog = job.extractProgress || {};
    if (state === 'done') {
      const jsonUrl = job?.resultUrl?.jsonUrl;
      if (!jsonUrl) throw new PaddleOcrError(`OCR 任务完成但缺少 resultUrl.jsonUrl（jobId=${jobId}）`, 'NO_RESULT_URL');
      onProgress && onProgress(95, { jobId, state, progress: prog });
      const records = await downloadJsonl(jsonUrl);
      const result = normalizeResult(records);
      onProgress && onProgress(100, { jobId, state: 'done' });
      return { jobId, result };
    }
    if (state === 'failed') {
      throw new PaddleOcrError(`OCR 任务失败（jobId=${jobId}）：${job.errorMsg || '未知错误'}`, 'JOB_FAILED');
    }
    // pending / running：按页数进度估算 5~90
    let pct = 5;
    if (prog.totalPages > 0) {
      pct = 5 + Math.round((prog.extractedPages / prog.totalPages) * 85);
    }
    onProgress && onProgress(pct, { jobId, state, progress: prog });
  }
}

module.exports = {
  PaddleOcrError,
  createJob,
  getJob,
  downloadJsonl,
  downloadAsset,
  normalizeBbox,
  parseFile,
  JOB_URL,
  MODEL
};
