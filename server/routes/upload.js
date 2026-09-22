const express = require('express');
const auth = require('../middleware/auth');
const { operLog } = require('../logger');
const { imageUploadService, documentUploadService } = require('../utils/UploadService');

const router = express.Router();

/**
 * 图片上传接口
 * 使用统一的 UploadService 类管理文件上传
 * 所有文件按日期分类存储到 uploads/YYYY/MM/DD/ 目录
 */
router.post('/', auth, operLog('图片上传', 1), imageUploadService.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传图片' });
  const url = imageUploadService.getFileUrl(req.file);
  res.json({ url });
});

/**
 * 多图片上传接口
 * 支持一次上传多个图片文件
 */
router.post('/multiple', auth, operLog('批量图片上传', 1), imageUploadService.array('images', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '请上传图片' });
  }
  const urls = imageUploadService.getFileUrls(req.files);
  res.json({ urls });
});

/**
 * 文档上传接口（预留）
 * 支持 PDF、Word、Excel 等文档格式
 */
router.post('/document', auth, operLog('文档上传', 1), documentUploadService.single('document'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文档' });
  const url = documentUploadService.getFileUrl(req.file);
  res.json({ url });
});

/**
 * 文件删除接口
 * 根据文件URL删除已上传的文件
 */
router.delete('/', auth, operLog('文件删除', 3), (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '缺少文件URL' });

  const deleted = imageUploadService.deleteFile(url);
  if (deleted) {
    res.json({ success: true, message: '文件删除成功' });
  } else {
    res.status(404).json({ error: '文件不存在或删除失败' });
  }
});

/**
 * OCR识别接口（预留）
 * 上传图片并进行OCR文字识别
 */
router.post('/ocr', auth, imageUploadService.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传图片' });

  // TODO: 集成OCR服务（如腾讯云OCR、百度OCR等）
  const url = imageUploadService.getFileUrl(req.file);

  res.json({
    success: true,
    url,
    data: {
      text: '（OCR功能待集成）',
      confidence: 0
    }
  });
});

module.exports = router;
