/**
 * 审计资料解析调度服务
 * 按文件类型分发：Excel → 本地 xlsx；Word(.docx) → 本地 mammoth；PDF/图片 → PaddleOCR-VL 在线 API
 * 结果落盘 server/data/audit-parse/{documentId}/，要素（含证据锚点）写入 audit_element
 */
const fs = require('fs');
const path = require('path');
const db = require('../../db');
const snowflake = require('../snowflake');
const { createdBy, runWithUser } = require('../auditContext');
const { parseExcel } = require('./parsers/excelParser');
const { parseWord } = require('./parsers/wordParser');
const { parseOcr } = require('./parsers/ocrParser');
const { PaddleOcrError } = require('../paddleOcrClient');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const DATA_ROOT = path.join(SERVER_ROOT, 'data', 'audit-parse');
const UPLOAD_ROOT = path.join(SERVER_ROOT, 'uploads');

const EXCEL_EXTS = ['.xlsx', '.xls'];
const WORD_EXTS = ['.docx'];
const OCR_EXTS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'];

function resultDir(documentId) {
  return path.join(DATA_ROOT, String(documentId));
}

/** 读取落盘结果 */
function loadResult(documentId) {
  const file = path.join(resultDir(documentId), 'result.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** file_url(/uploads/...) 兜底映射本地磁盘路径 */
function resolveLocalPath(doc) {
  if (doc.file_path && fs.existsSync(doc.file_path)) return doc.file_path;
  if (doc.file_url && doc.file_url.startsWith('/uploads/')) {
    const candidate = path.join(UPLOAD_ROOT, doc.file_url.replace(/^\/uploads\//, ''));
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function extOf(fileName) {
  return path.extname(fileName || '').toLowerCase();
}

/** 内容摘要（列表展示用） */
function makeSummary(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
}

/**
 * 执行解析（异步后台调用，不向前端抛错，错误落库）
 * @param {string|number} documentId
 * @param {string} [operatorUserId] 触发解析的用户ID（后台任务需显式传入以保留审计上下文）
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function parseDocument(documentId, operatorUserId) {
  return runWithUser(operatorUserId ? String(operatorUserId) : null, () => _runParse(documentId));
}

async function _runParse(documentId) {
  const [rows] = await db.query('SELECT * FROM audit_document WHERE id = ? AND del_flag = 0', [documentId]);
  const doc = rows[0];
  if (!doc) return { ok: false, error: '资料不存在' };

  const dir = resultDir(documentId);
  fs.mkdirSync(dir, { recursive: true });

  try {
    await db.query(
      "UPDATE audit_document SET parse_status='processing', parse_progress=1, parse_error=NULL WHERE id=?",
      [documentId]
    );

    const localPath = resolveLocalPath(doc);
    if (!localPath) throw new Error('源文件在服务器上不存在，请重新上传');
    const ext = extOf(doc.file_name);

    let parsed;
    let jobId = null;

    if (EXCEL_EXTS.includes(ext)) {
      parsed = parseExcel(localPath);
    } else if (WORD_EXTS.includes(ext)) {
      parsed = await parseWord(localPath);
    } else if (OCR_EXTS.includes(ext)) {
      const r = await parseOcr({
        filePath: localPath,
        fileName: doc.file_name,
        mimeType: doc.mime_type,
        assetDir: dir,
        onProgress: async (pct) => {
          await db.query('UPDATE audit_document SET parse_progress=? WHERE id=?', [pct, documentId]).catch(() => {});
        }
      });
      parsed = { kind: 'ocr', ...r.result, jobId: r.jobId };
      jobId = r.jobId;
    } else {
      throw new Error(`暂不支持的文件类型：${ext}`);
    }

    // 落盘完整结果（供问答/核对检索；data 目录不入库 git）。
    // 剔除 OCR 原始 JSONL（raw，体积大且与 pages/elements 重复），减小 result.json 体积
    const { raw: _raw, ...parserLite } = parsed;
    const stored = {
      version: 1,
      documentId: String(documentId),
      fileName: doc.file_name,
      kind: parsed.kind,
      parsedAt: new Date().toISOString(),
      ocrJobId: jobId,
      parser: parserLite
    };
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(stored), 'utf8');
    fs.writeFileSync(path.join(dir, 'content.md'), parsed.markdownText || '', 'utf8');

    // 组装要素行
    let elements = Array.isArray(parsed.elements) ? parsed.elements : [];
    if (parsed.kind === 'ocr') {
      // OCR：若某页未提取到版面要素，用整页 markdown 兜底一条
      parsed.pages.forEach(page => {
        const has = elements.some(e => e.pageNo === page.pageNo);
        if (!has && page.markdown) {
          elements.push({
            pageNo: page.pageNo,
            sheetName: null,
            elementType: 'text',
            content: page.markdown,
            anchorLabel: `第 ${page.pageNo} 页`,
            bbox: null
          });
        }
      });
    }

    // 重写 audit_element
    await db.query('DELETE FROM audit_element WHERE document_id = ?', [documentId]);
    if (elements.length > 0) {
      const values = [];
      const params = [];
      const uid = createdBy();
      elements.slice(0, 3000).forEach(el => {
        values.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))');
        params.push(
          snowflake.nextId(), doc.project_id, documentId,
          el.pageNo || 0, el.sheetName || null, el.elementType || 'text',
          String(el.content || '').slice(0, 16 * 1024 * 1024 - 1),
          el.bbox ? JSON.stringify(el.bbox) : null,
          el.anchorLabel || null,
          uid, uid
        );
      });
      const sql = `INSERT INTO audit_element
        (id, project_id, document_id, page_no, sheet_name, element_type, content_md, bbox_json, anchor_label, created_by, updated_by, created_at, updated_at)
        VALUES ${values.join(',')}`;
      await db.query(sql, params);
    }

    // 更新资料主表
    const pageCount = parsed.kind === 'ocr' ? (parsed.numPages || (OCR_EXTS.includes(ext) && ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'].includes(ext) ? 1 : 0)) : 0;
    const sheetCount = parsed.kind === 'excel' ? (parsed.sheetCount || 0) : 0;
    await db.query(
      `UPDATE audit_document SET parse_status='done', parse_progress=100, parse_error=NULL,
        ocr_job_id=?, result_path=?, page_count=?, sheet_count=?, summary_text=?, updated_at=NOW(3) WHERE id=?`,
      [jobId, `audit-parse/${documentId}`, pageCount, sheetCount, makeSummary(parsed.markdownText), documentId]
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof PaddleOcrError ? `${err.message}${err.code ? '（' + err.code + '）' : ''}` : err.message;
    await db.query(
      "UPDATE audit_document SET parse_status='failed', parse_progress=0, parse_error=? WHERE id=?",
      [String(msg).slice(0, 1900), documentId]
    ).catch(() => {});
    return { ok: false, error: msg };
  }
}

module.exports = {
  DATA_ROOT,
  resultDir,
  loadResult,
  resolveLocalPath,
  parseDocument,
  extOf,
  EXCEL_EXTS, WORD_EXTS, OCR_EXTS
};
