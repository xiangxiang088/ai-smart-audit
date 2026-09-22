const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/**
 * 文件上传服务类
 * 统一管理所有文件上传，按日期分类存储到 uploads/ 目录
 */
class UploadService {
  constructor(options = {}) {
    // 默认配置
    this.uploadRoot = options.uploadRoot || path.join(__dirname, '../../uploads');
    this.maxFileSize = options.maxFileSize || 5 * 1024 * 1024; // 默认5MB
    this.allowedMimeTypes = options.allowedMimeTypes || {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp'
    };

    // 初始化 multer 存储配置
    this.storage = multer.diskStorage({
      destination: (req, file, cb) => {
        const dateDir = this._getDateDir();
        const uploadDir = path.join(this.uploadRoot, dateDir);
        this._ensureDir(uploadDir);
        cb(null, uploadDir);
      },
      filename: (req, file, cb) => {
        const ext = this.allowedMimeTypes[file.mimetype] || this._getExtFromMime(file.mimetype);
        const uniqueName = `${crypto.randomBytes(16).toString('hex')}${ext}`;
        cb(null, uniqueName);
      }
    });

    // 创建 multer 实例
    this.uploader = multer({
      storage: this.storage,
      fileFilter: (req, file, cb) => this._fileFilter(req, file, cb),
      limits: { fileSize: this.maxFileSize }
    });
  }

  /**
   * 生成按日期分类的目录路径 YYYY/MM/DD
   * @returns {string} 日期目录路径
   */
  _getDateDir() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return path.join(String(y), m, d);
  }

  /**
   * 确保目录存在，不存在则递归创建
   * @param {string} dir 目录路径
   */
  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 文件类型过滤器
   * @param {Object} req Express请求对象
   * @param {Object} file Multer文件对象
   * @param {Function} cb 回调函数
   */
  _fileFilter(req, file, cb) {
    if (this.allowedMimeTypes[file.mimetype]) {
      cb(null, true);
    } else {
      const allowed = Object.keys(this.allowedMimeTypes).join(', ');
      cb(new Error(`不支持的文件类型。允许的类型：${allowed}`), false);
    }
  }

  /**
   * 从MIME类型获取扩展名
   * @param {string} mimetype MIME类型
   * @returns {string} 扩展名
   */
  _getExtFromMime(mimetype) {
    const parts = mimetype.split('/');
    return parts.length > 1 ? `.${parts[1]}` : '.bin';
  }

  /**
   * 获取单文件上传中间件
   * @param {string} fieldName 表单字段名，默认 'file'
   * @returns {Function} Express中间件
   */
  single(fieldName = 'file') {
    return this.uploader.single(fieldName);
  }

  /**
   * 获取多文件上传中间件
   * @param {string} fieldName 表单字段名
   * @param {number} maxCount 最大文件数
   * @returns {Function} Express中间件
   */
  array(fieldName, maxCount = 10) {
    return this.uploader.array(fieldName, maxCount);
  }

  /**
   * 获取多字段上传中间件
   * @param {Array} fields 字段配置数组
   * @returns {Function} Express中间件
   */
  fields(fields) {
    return this.uploader.fields(fields);
  }

  /**
   * 获取上传后的文件URL（相对于网站根目录）
   * @param {Object} file Multer文件对象
   * @returns {string} 文件URL
   */
  getFileUrl(file) {
    if (!file) return null;
    const dateDir = this._getDateDir().split(path.sep).join('/');
    return `/uploads/${dateDir}/${file.filename}`;
  }

  /**
   * 获取多个文件的URL数组
   * @param {Array} files Multer文件对象数组
   * @returns {Array} 文件URL数组
   */
  getFileUrls(files) {
    if (!files || !Array.isArray(files)) return [];
    return files.map(f => this.getFileUrl(f));
  }

  /**
   * 将文件URL安全地解析为磁盘绝对路径，并校验结果仍位于 uploadRoot 内
   * 防止 /uploads/../../etc/passwd 之类的路径穿越
   * @param {string} fileUrl 文件URL（如 /uploads/2026/08/11/xxx.jpg）
   * @returns {string|null} 校验通过的绝对路径，非法则返回 null
   */
  _resolveSafePath(fileUrl) {
    if (!fileUrl || typeof fileUrl !== 'string' || !fileUrl.startsWith('/uploads/')) return null;
    const uploadRootResolved = path.resolve(this.uploadRoot);
    const relative = fileUrl.slice('/uploads/'.length);
    const resolved = path.resolve(uploadRootResolved, relative);
    if (resolved !== uploadRootResolved && !resolved.startsWith(uploadRootResolved + path.sep)) {
      return null;
    }
    return resolved;
  }

  /**
   * 删除文件
   * @param {string} fileUrl 文件URL（如 /uploads/2026/08/11/xxx.jpg）
   * @returns {boolean} 是否删除成功
   */
  deleteFile(fileUrl) {
    try {
      const filePath = this._resolveSafePath(fileUrl);
      if (!filePath) return false;
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
      return false;
    } catch (err) {
      console.error('删除文件失败:', err);
      return false;
    }
  }

  /**
   * 获取文件绝对路径
   * @param {string} fileUrl 文件URL
   * @returns {string} 文件绝对路径
   */
  getFilePath(fileUrl) {
    return this._resolveSafePath(fileUrl);
  }
}

// 导出单例实例（图片上传）
const imageUploadService = new UploadService({
  allowedMimeTypes: {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp'
  },
  maxFileSize: 5 * 1024 * 1024 // 5MB
});

// 导出文档上传实例（可选，预留）
const documentUploadService = new UploadService({
  allowedMimeTypes: {
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx'
  },
  maxFileSize: 10 * 1024 * 1024 // 10MB
});

module.exports = {
  UploadService,
  imageUploadService,
  documentUploadService
};
