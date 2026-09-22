/**
 * 审计资料路由 /api/audit/documents
 * 上传（PDF/Word/Excel/图片）→ 登记 audit_document → 后台解析（PaddleOCR / xlsx / mammoth）
 * 解析结果查看、页面底图/裁剪图取证、删除
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const router = express.Router();
const auth = require('../../middleware/auth');
const { operLog } = require('../../logger');
const snowflake = require('../../utils/snowflake');
const { createdBy } = require('../../utils/auditContext');
const db = require('../../db');
const parseService = require('../../utils/audit/parseService');

router.use(auth);

// 审计资料专用上传：扫描件 PDF 可能很大（单档 100MB）
// 扩展名 → 标准 MIME 白名单（MIME 与扩展名任一命中即放行，兼容 octet-stream 的环境）
const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads');
const ALLOW_EXT = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};
const ALLOW_MIMES = new Set(Object.values(ALLOW_EXT));

function dateDir() {
  const now = new Date();
  return path.join(String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
}

// multipart 文件名以 UTF-8 字节传输，busboy 默认按 latin1 解码，中文需转回 utf8
function decodeOriginalName(name) {
  try {
    const s = Buffer.from(String(name), 'latin1').toString('utf8');
    // 转码后出现中文/全角字符，才认定原文件名被 latin1 误解码
    return /[一-龥＀-￯]/.test(s) ? s : name;
  } catch {
    return name;
  }
}

const auditUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT, dateDir());
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, crypto.randomBytes(16).toString('hex') + (ALLOW_EXT[ext] ? ext : ''));
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    file.originalname = decodeOriginalName(file.originalname);
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOW_EXT[ext] || ALLOW_MIMES.has(file.mimetype)) return cb(null, true);
    cb(new Error('不支持的文件类型，仅允许 PDF / Word(.docx) / Excel(.xlsx,.xls) / PNG·JPG·WebP·GIF 图片'));
  }
});

function fileUrlOf(file) {
  const rel = path.relative(UPLOAD_ROOT, file.path).split(path.sep).join('/');
  return '/uploads/' + rel;
}

// OCR 任务串行队列（避免多文件并发触发在线 API 限流）
let parseChain = Promise.resolve();
function enqueueParse(documentId, userId) {
  parseChain = parseChain
    .then(() => parseService.parseDocument(documentId, userId))
    .catch(err => console.error('[audit] 解析队列异常:', err.message));
}

// 「解析中」的僵尸锁回收阈值
// 进程重启/崩溃会让 parse_status 永久停在 processing，此时重试接口会一直返回 409，
// 该资料再也无法解析（审计场景不可接受）。parseService 解析期间会持续刷新 updated_at，
// 因此超过该阈值仍未更新的 processing 判定为中断，允许重新入队。
const STALE_PROCESSING_MS = Number(process.env.PARSE_STALE_MS || 15 * 60 * 1000);

function isStaleProcessing(doc) {
  if (!doc || doc.parse_status !== 'processing') return false;
  const t = doc.updated_at ? new Date(doc.updated_at).getTime() : 0;
  return !Number.isFinite(t) || t === 0 || Date.now() - t > STALE_PROCESSING_MS;
}

const PHOTO_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff'];

function inferDocType(fileName, hint) {
  if (hint && ['pdf_text', 'pdf_mixed', 'pdf_scan', 'excel', 'word', 'photo', 'other'].includes(hint)) return hint;
  const ext = path.extname(fileName || '').toLowerCase();
  if (ext === '.pdf') return 'pdf_mixed';
  if (PHOTO_EXTS.includes(ext)) return 'photo';
  if (['.xlsx', '.xls'].includes(ext)) return 'excel';
  if (['.docx', '.doc'].includes(ext)) return 'word';
  return 'other';
}

function inferBizCategory(fileName, hint) {
  const allow = ['contract', 'boq', 'control_price', 'settlement', 'payment', 'visa', 'photo', 'invoice', 'other'];
  if (hint && allow.includes(hint)) return hint;
  const n = String(fileName || '');
  if (/合同|协议/.test(n)) return 'contract';
  if (/签证|变更|洽商|联系单/.test(n)) return 'visa';
  if (/清单|招标|控制价/.test(n)) return /控制价/.test(n) ? 'control_price' : 'boq';
  if (/结算|决算|审核/.test(n)) return 'settlement';
  if (/付款|支付|进度款/.test(n)) return 'payment';
  if (/发票|票据/.test(n)) return 'invoice';
  if (/\.(png|jpe?g|webp|bmp|tif{1,2})$/i.test(n)) return 'photo';
  return 'other';
}

// 项目下资料列表
router.get('/project/:projectId', async (req, res) => {
  const [rows] = await db.query(
    'SELECT * FROM audit_document WHERE project_id=? AND del_flag=0 ORDER BY created_at DESC, id DESC LIMIT 500',
    [req.params.projectId]
  );
  res.json(rows);
});

// 上传资料（支持多文件，字段名 files）
router.post('/upload', auditUpload.array('files', 20), operLog('审计资料', 1), async (req, res) => {
  const { project_id, doc_type, biz_category } = req.body || {};
  // project_id 可选（清标分析等独立功能资料可为空/NULL）
  let finalProjectId = null;
  if (project_id && project_id.trim()) {
    const [proj] = await db.query('SELECT id FROM audit_project WHERE id=? AND del_flag=0', [project_id.trim()]);
    if (proj.length === 0) return res.status(404).json({ error: '审计项目不存在' });
    finalProjectId = project_id.trim();
  }
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: '请选择文件' });

  const created = [];
  for (const file of req.files) {
    const id = snowflake.nextId();
    const url = fileUrlOf(file);
    const docType = inferDocType(file.originalname, doc_type);
    const biz = inferBizCategory(file.originalname, biz_category);
    await db.query(
      `INSERT INTO audit_document
        (id, project_id, file_name, file_url, file_path, file_size, mime_type, file_ext,
         doc_type, biz_category, parse_status, parse_progress, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      [id, finalProjectId, file.originalname, url, file.path, file.size,
       file.mimetype, path.extname(file.originalname).toLowerCase(),
       docType, biz, createdBy(), createdBy()]
    );
    const [rows] = await db.query('SELECT * FROM audit_document WHERE id=?', [id]);
    created.push(rows[0]);
    // 自动入队解析
    enqueueParse(id, req.userId);
  }
  res.json({ success: true, documents: created });
});

// 单个资料详情
router.get('/:id', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM audit_document WHERE id=? AND del_flag=0', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: '资料不存在' });
  res.json(rows[0]);
});

// 触发/重试解析
router.post('/:id/parse', async (req, res) => {
  const [rows] = await db.query('SELECT id, parse_status, updated_at FROM audit_document WHERE id=? AND del_flag=0', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: '资料不存在' });
  const doc = rows[0];
  if (doc.parse_status === 'processing' && !isStaleProcessing(doc)) {
    return res.status(409).json({ error: '该资料正在解析中' });
  }
  const recovered = doc.parse_status === 'processing';
  enqueueParse(req.params.id, req.userId);
  res.json({
    success: true,
    recovered,
    message: recovered ? '检测到解析任务已中断，已重新入队' : '已加入解析队列'
  });
});

// 批量触发解析
router.post('/parse-batch', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  let count = 0;
  for (const id of ids.slice(0, 50)) {
    const [rows] = await db.query('SELECT parse_status, updated_at FROM audit_document WHERE id=? AND del_flag=0', [id]);
    if (rows.length !== 1) continue;
    if (rows[0].parse_status === 'processing' && !isStaleProcessing(rows[0])) continue; // 正在解析，跳过
    enqueueParse(id, req.userId);
    count++;
  }
  res.json({ success: true, count, requested: ids.length });
});

// 解析结果（前端展示用精简结构，剥离原始大块 raw 数据）
router.get('/:id/result', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM audit_document WHERE id=? AND del_flag=0', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: '资料不存在' });
  const doc = rows[0];
  const stored = parseService.loadResult(req.params.id);
  if (!stored) return res.status(404).json({ error: '解析结果不存在，请先解析', parse_status: doc.parse_status });

  const p = stored.parser || {};
  let data;
  if (stored.kind === 'excel') {
    data = {
      kind: 'excel',
      sheetCount: p.sheetCount,
      sheets: (p.sheets || []).map(s => ({
        name: s.name, index: s.index, rowCount: s.rowCount, colCount: s.colCount,
        range: s.range, html: s.html, merges: s.merges
      }))
    };
  } else if (stored.kind === 'word') {
    data = { kind: 'word', html: p.html, markdownText: p.markdownText, elements: p.elements, warnings: p.warnings };
  } else {
    const pageFilter = req.query.page ? Number(req.query.page) : null;
    let pages = (p.pages || []).map(pg => ({
      pageNo: pg.pageNo,
      width: pg.width,
      height: pg.height,
      markdown: pg.markdown,
      localImage: pg.localImage || '',
      blockImages: pg.blockImages || {},
      elements: (pg.elements || []).map(e => ({
        index: e.index, label: e.label, elementType: e.elementType,
        content: e.content, bbox: e.bbox
      }))
    }));
    if (pageFilter) pages = pages.filter(pg => pg.pageNo === pageFilter);
    data = { kind: 'ocr', docType: p.docType, numPages: p.numPages, jobId: stored.ocrJobId, pages };
  }
  res.json({ document: doc, result: data });
});

// 解析资源文件（页面底图/表格裁剪图，登录后可访问，防目录穿越）
router.get('/:id/asset', async (req, res) => {
  const rel = String(req.query.path || '');
  if (!rel || rel.includes('\0')) return res.status(400).json({ error: '非法路径' });
  const base = parseService.resultDir(req.params.id);
  const target = path.normalize(path.join(base, rel));
  if (!target.startsWith(base) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return res.status(404).json({ error: '资源不存在' });
  }
  res.sendFile(target);
});

// 删除资料（软删，保留落盘结果作为审计证据）
router.delete('/:id', operLog('审计资料', 3), async (req, res) => {
  await db.query('UPDATE audit_document SET del_flag=1 WHERE id=?', [req.params.id]);
  await db.query('UPDATE audit_element SET del_flag=1 WHERE document_id=?', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
