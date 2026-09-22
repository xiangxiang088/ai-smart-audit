/**
 * 项目资料内存仓库：把某项目已解析的资料与要素一次性载入内存并缓存，
 * 供 Agent 检索工具在内存中做关键词评分检索（避免每次工具调用都全表 LIKE 扫描 mediumtext）。
 * 解析状态变化后调用 invalidate(projectId) 或等待 TTL 过期。
 */
const db = require('../../../db');
const { cleanCell } = require('./tableUtils');

const TTL_MS = 3 * 60 * 1000;
const cache = new Map(); // projectId -> {at, docs, elements, docMap}

function tokenize(query) {
  const toks = [];
  const str = String(query || '').toLowerCase();
  // 字母数字编码 / 金额（清单编码、税号、数字）整体保留
  (str.match(/[a-z0-9][a-z0-9.\-]{1,}/g) || []).forEach(t => toks.push(t));
  // 中文连续段：整段 + 二元切分
  const segs = str.match(/[一-龥]{2,}/g) || [];
  segs.forEach(seg => {
    toks.push(seg);
    if (seg.length > 2) {
      for (let i = 0; i < seg.length - 1; i++) toks.push(seg.slice(i, i + 2));
    }
  });
  return Array.from(new Set(toks.filter(Boolean)));
}

function plainText(el) {
  if (el._plain !== undefined) return el._plain;
  el._plain = cleanCell(el.content).replace(/\s+/g, ' ');
  return el._plain;
}

/** 载入项目（带缓存） */
async function loadProject(projectId, { force = false } = {}) {
  const hit = cache.get(String(projectId));
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit;

  const [docs] = await db.query(
    `SELECT id, file_name, doc_type, biz_category, page_count, sheet_count, summary_text
     FROM audit_document WHERE project_id=? AND del_flag=0 ORDER BY created_at ASC`,
    [projectId]
  );
  const [els] = await db.query(
    `SELECT id, document_id, page_no, sheet_name, element_type, content_md, bbox_json, anchor_label
     FROM audit_element WHERE project_id=? AND del_flag=0`,
    [projectId]
  );

  const docMap = new Map();
  docs.forEach(d => docMap.set(String(d.id), {
    id: String(d.id),
    fileName: d.file_name,
    docType: d.doc_type,
    bizCategory: d.biz_category,
    pageCount: d.page_count,
    sheetCount: d.sheet_count,
    summary: d.summary_text || ''
  }));

  const elements = els.map(r => {
    let bbox = null;
    if (r.bbox_json) { try { bbox = JSON.parse(r.bbox_json); } catch { bbox = null; } }
    return {
      id: String(r.id),
      docId: String(r.document_id),
      pageNo: r.page_no || 0,
      sheetName: r.sheet_name || '',
      type: r.element_type || 'text',
      content: r.content_md || '',
      bbox,
      anchor: r.anchor_label || '',
      _plain: undefined
    };
  });

  const loaded = { at: Date.now(), docs: Array.from(docMap.values()), docMap, elements };
  cache.set(String(projectId), loaded);
  return loaded;
}

function invalidate(projectId) {
  if (projectId == null) cache.clear();
  else cache.delete(String(projectId));
}

/** 取命中关键词附近的纯文本窗口 */
function makeSnippet(el, tokens) {
  const text = plainText(el);
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of tokens) { if (t.length >= 2) { const i = lower.indexOf(t); if (i >= 0 && (pos < 0 || i < pos)) pos = i; } }
  if (pos < 0) return text.slice(0, 220);
  const start = Math.max(0, pos - 90);
  return (start > 0 ? '…' : '') + text.slice(start, start + 240) + (start + 240 < text.length ? '…' : '');
}

const TYPE_WEIGHT = { title: 1.6, seal: 1.4, table: 1.15, text: 1, image: 0.6, chart: 1, formula: 0.8 };

/**
 * 内存关键词检索
 * @param {object} store loadProject 返回值
 * @param {string} query 关键词/自然语言片段
 * @param {object} opt {docIds, types, limit}
 */
function search(store, query, opt = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const docIds = opt.docIds ? new Set(opt.docIds.map(String)) : null;
  const types = opt.types ? new Set(opt.types) : null;
  const limit = opt.limit || 12;
  const scored = [];
  for (const el of store.elements) {
    if (docIds && !docIds.has(el.docId)) continue;
    if (types && !types.has(el.type)) continue;
    const hay = (el.sheetName + ' ' + el.anchor + ' ' + plainText(el)).toLowerCase();
    let score = 0;
    let hitCount = 0;
    for (const t of tokens) {
      if (!t) continue;
      let idx = hay.indexOf(t);
      let hits = 0;
      while (idx >= 0) { hits++; idx = hay.indexOf(t, idx + t.length); if (hits >= 5) break; }
      if (hits) {
        hitCount++;
        // 长 token（整段短语/编码）权重高
        score += hits * (t.length >= 4 ? 2 : 1);
      }
    }
    if (hitCount === 0) continue;
    // 覆盖度优先（命中的不同 token 占比），再按类型加权
    score = score * (TYPE_WEIGHT[el.type] || 1) * (0.6 + 0.4 * Math.min(hitCount / Math.max(3, tokens.filter(t => t.length >= 2).length), 1) * 2);
    scored.push({ el, score: Math.round(score * 100) / 100 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => ({ el: x.el, score: x.score, snippet: makeSnippet(x.el, tokens) }));
}

module.exports = { loadProject, invalidate, search, tokenize, plainText };
