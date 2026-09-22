/**
 * OCR 解析器：PDF（文字/图文/扫描）与图片（PNG/JPG/...）统一走 PaddleOCR-VL 在线 API
 * 解析后把每页底图（inputImage，BOS 临时链接）固化到本地，供前端证据框选
 */
const fs = require('fs');
const path = require('path');
const paddle = require('../../paddleOcrClient');

/** 从 URL 推断图片扩展名 */
function extFromUrl(url, fallback = '.png') {
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.toLowerCase().match(/\.(png|jpe?g|webp|bmp|tiff?)$/);
    return m ? (m[1] === 'jpeg' ? '.jpg' : '.' + m[1].replace('tiff', 'tiff')) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * @param {object} p
 * @param {string} p.filePath 本地源文件
 * @param {string} p.fileName
 * @param {string} p.mimeType
 * @param {string} p.assetDir 结果资源目录（pages/ 图片落地处）
 * @param {function} [p.onProgress]
 * @returns {Promise<{kind:'ocr', jobId:string, result:object}>}
 */
async function parseOcr({ filePath, fileName, mimeType, assetDir, onProgress }) {
  const buffer = fs.readFileSync(filePath);
  const { jobId, result } = await paddle.parseFile({ buffer, fileName, mimeType, onProgress });

  // 固化每页底图（失败不阻断，保留临时 URL 兜底）
  const pagesDir = path.join(assetDir, 'pages');
  for (const page of result.pages) {
    if (page.inputImage) {
      const ext = extFromUrl(page.inputImage);
      const localRel = path.posix.join('pages', `p${page.pageNo}${ext}`);
      const ok = await paddle.downloadAsset(page.inputImage, path.join(pagesDir, `p${page.pageNo}${ext}`));
      page.localImage = ok ? localRel : '';
    }
    // 表格/图片块裁剪图（key 为相对路径，value 为临时 URL）
    const blockImgs = {};
    const imgEntries = Object.entries(page.images || {}).concat(Object.entries(page.outputImages || {}));
    for (const [rel, url] of imgEntries) {
      if (!url || typeof url !== 'string') continue;
      const safeName = rel.replace(/[\\/:*?"<>|]/g, '_');
      const ext = extFromUrl(url, path.extname(safeName) || '.png');
      const localRel = path.posix.join('images', `p${page.pageNo}_${safeName}`).replace(/\.[^.]+$/, '') + ext;
      const ok = await paddle.downloadAsset(url, path.join(assetDir, localRel));
      blockImgs[rel] = ok ? localRel : url;
    }
    page.blockImages = blockImgs;
  }

  return { kind: 'ocr', jobId, result };
}

module.exports = { parseOcr };
