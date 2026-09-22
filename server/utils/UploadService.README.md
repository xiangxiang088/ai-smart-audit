# UploadService 文件上传服务类

统一管理所有文件上传，按日期分类存储到 `uploads/` 目录。

## 特性

- ✅ **日期分类存储**：自动按 `YYYY/MM/DD` 结构组织文件
- ✅ **类型安全**：基于 MIME 类型验证，不信任客户端扩展名
- ✅ **安全文件名**：使用加密级随机文件名，防止文件名枚举和路径穿越
- ✅ **灵活配置**：支持自定义上传目录、文件大小限制、MIME 类型白名单
- ✅ **多实例支持**：预置图片、文档上传实例，可扩展更多类型
- ✅ **文件管理**：提供文件删除、URL 转换、路径获取等工具方法

## 目录结构

```
uploads/
  └── 2026/
      └── 08/
          └── 11/
              ├── a1b2c3d4e5f6...abc123.jpg
              ├── f6e5d4c3b2a1...def456.png
              └── ...
```

## 基础用法

### 1. 在路由中使用预置实例

```javascript
const express = require('express');
const { imageUploadService } = require('../utils/UploadService');

const router = express.Router();

// 单文件上传
router.post('/upload', imageUploadService.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });

  const url = imageUploadService.getFileUrl(req.file);
  res.json({ url }); // 返回: { url: "/uploads/2026/08/11/xxx.jpg" }
});

// 多文件上传
router.post('/upload-multiple', imageUploadService.array('images', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '请上传文件' });
  }

  const urls = imageUploadService.getFileUrls(req.files);
  res.json({ urls }); // 返回: { urls: ["/uploads/...", "/uploads/..."] }
});

// 删除文件
router.delete('/file', (req, res) => {
  const { url } = req.body;
  const deleted = imageUploadService.deleteFile(url);
  res.json({ success: deleted });
});
```

### 2. 创建自定义上传实例

```javascript
const { UploadService } = require('../utils/UploadService');

// 视频上传实例
const videoUploadService = new UploadService({
  allowedMimeTypes: {
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov'
  },
  maxFileSize: 50 * 1024 * 1024, // 50MB
  uploadRoot: path.join(__dirname, '../../uploads')
});

// 使用自定义实例
router.post('/upload-video', videoUploadService.single('video'), (req, res) => {
  const url = videoUploadService.getFileUrl(req.file);
  res.json({ url });
});
```

## API 文档

### 构造函数

```javascript
new UploadService(options)
```

**参数：**
- `options.uploadRoot` (string): 上传根目录，默认 `__dirname/../../uploads`
- `options.maxFileSize` (number): 最大文件大小（字节），默认 5MB
- `options.allowedMimeTypes` (object): MIME 类型白名单，格式：`{ 'mime/type': '.ext' }`

### 实例方法

#### `single(fieldName)`
返回单文件上传中间件。

**参数：**
- `fieldName` (string): 表单字段名，默认 `'file'`

**返回：** Express 中间件函数

**示例：**
```javascript
router.post('/upload', uploadService.single('photo'), (req, res) => {
  console.log(req.file); // Multer 文件对象
});
```

#### `array(fieldName, maxCount)`
返回多文件上传中间件。

**参数：**
- `fieldName` (string): 表单字段名
- `maxCount` (number): 最大文件数，默认 10

**返回：** Express 中间件函数

**示例：**
```javascript
router.post('/upload-multiple', uploadService.array('photos', 5), (req, res) => {
  console.log(req.files); // Multer 文件对象数组
});
```

#### `fields(fields)`
返回多字段上传中间件。

**参数：**
- `fields` (array): 字段配置数组，格式：`[{ name: 'avatar', maxCount: 1 }, { name: 'gallery', maxCount: 8 }]`

**返回：** Express 中间件函数

**示例：**
```javascript
router.post('/profile', uploadService.fields([
  { name: 'avatar', maxCount: 1 },
  { name: 'cover', maxCount: 1 }
]), (req, res) => {
  console.log(req.files.avatar); // [文件对象]
  console.log(req.files.cover);  // [文件对象]
});
```

#### `getFileUrl(file)`
获取文件的 URL 路径。

**参数：**
- `file` (object): Multer 文件对象（来自 req.file）

**返回：** (string) 文件 URL，如 `/uploads/2026/08/11/xxx.jpg`

#### `getFileUrls(files)`
获取多个文件的 URL 数组。

**参数：**
- `files` (array): Multer 文件对象数组（来自 req.files）

**返回：** (array) 文件 URL 数组

#### `deleteFile(fileUrl)`
根据 URL 删除文件。

**参数：**
- `fileUrl` (string): 文件 URL，如 `/uploads/2026/08/11/xxx.jpg`

**返回：** (boolean) 是否删除成功

**示例：**
```javascript
const deleted = uploadService.deleteFile('/uploads/2026/08/11/abc123.jpg');
console.log(deleted); // true 或 false
```

#### `getFilePath(fileUrl)`
将文件 URL 转换为绝对路径。

**参数：**
- `fileUrl` (string): 文件 URL

**返回：** (string) 文件绝对路径

## 预置实例

### `imageUploadService`
图片上传实例，支持 JPG、PNG、GIF、WEBP，最大 5MB。

```javascript
const { imageUploadService } = require('../utils/UploadService');

router.post('/upload-image', imageUploadService.single('image'), (req, res) => {
  const url = imageUploadService.getFileUrl(req.file);
  res.json({ url });
});
```

### `documentUploadService`
文档上传实例，支持 PDF、Word、Excel，最大 10MB。

```javascript
const { documentUploadService } = require('../utils/UploadService');

router.post('/upload-doc', documentUploadService.single('document'), (req, res) => {
  const url = documentUploadService.getFileUrl(req.file);
  res.json({ url });
});
```

## 错误处理

```javascript
router.post('/upload', imageUploadService.single('image'), (req, res) => {
  // Multer 错误会被 Express 错误处理中间件捕获
  if (!req.file) {
    return res.status(400).json({ error: '请上传文件' });
  }

  const url = imageUploadService.getFileUrl(req.file);
  res.json({ url });
});

// 添加错误处理中间件（在 app.js 或 server.js 中）
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '文件太大' });
    }
    return res.status(400).json({ error: err.message });
  }

  if (err.message.includes('不支持的文件类型')) {
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({ error: '服务器错误' });
});
```

## 前端调用示例

### 单文件上传

```javascript
async function uploadImage(file) {
  const formData = new FormData();
  formData.append('image', file);

  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  });

  const data = await res.json();
  return data.url; // "/uploads/2026/08/11/xxx.jpg"
}

// 使用示例
const input = document.getElementById('fileInput');
input.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) {
    const url = await uploadImage(file);
    console.log('上传成功:', url);
    document.getElementById('preview').src = url;
  }
});
```

### 多文件上传

```javascript
async function uploadMultipleImages(files) {
  const formData = new FormData();
  for (let file of files) {
    formData.append('images', file);
  }

  const res = await fetch('/api/upload/multiple', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  });

  const data = await res.json();
  return data.urls; // ["/uploads/...", "/uploads/..."]
}
```

### 删除文件

```javascript
async function deleteFile(url) {
  const res = await fetch('/api/upload', {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url })
  });

  const data = await res.json();
  return data.success;
}
```

## 安全特性

1. **MIME 类型验证**：仅允许白名单中的 MIME 类型，不信任客户端文件扩展名
2. **加密随机文件名**：使用 `crypto.randomBytes(16)` 生成文件名，防止枚举攻击
3. **路径穿越防护**：使用 `path.join()` 和固定目录结构，防止路径穿越
4. **文件大小限制**：通过 Multer 的 `limits.fileSize` 限制上传大小
5. **认证保护**：建议在路由中使用 `auth` 中间件，要求登录后才能上传

## 扩展建议

### 1. 添加文件记录表

将上传的文件信息记录到数据库，便于管理和清理：

```sql
CREATE TABLE sys_file (
  id BIGINT UNSIGNED PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  file_url VARCHAR(255) NOT NULL,
  file_size INT UNSIGNED NOT NULL,
  mime_type VARCHAR(50) NOT NULL,
  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='文件上传记录';
```

### 2. 添加缩略图生成

使用 `sharp` 库自动生成图片缩略图：

```javascript
const sharp = require('sharp');

async function generateThumbnail(filePath) {
  const thumbPath = filePath.replace(/(\.\w+)$/, '_thumb$1');
  await sharp(filePath)
    .resize(200, 200, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toFile(thumbPath);
  return thumbPath;
}
```

### 3. 添加文件清理定时任务

定期清理未使用的文件：

```javascript
const cron = require('node-cron');

// 每天凌晨2点清理30天前的未关联文件
cron.schedule('0 2 * * *', async () => {
  // 查询数据库中所有文件记录
  // 扫描 uploads 目录
  // 删除数据库中不存在的文件
});
```

## 注意事项

1. 确保 `uploads/` 目录有写权限
2. 生产环境建议使用 CDN 或对象存储（OSS）代替本地存储
3. 定期备份 `uploads/` 目录
4. 考虑添加文件访问权限控制
5. 对于敏感文件，建议加密存储

## 迁移指南

如果项目中已有旧的上传代码，可以按以下步骤迁移：

1. 安装 UploadService：将 `UploadService.js` 复制到 `server/utils/` 目录
2. 替换导入：`const { imageUploadService } = require('../utils/UploadService')`
3. 替换中间件：将 `upload.single('image')` 替换为 `imageUploadService.single('image')`
4. 替换 URL 生成：使用 `imageUploadService.getFileUrl(req.file)` 代替手动拼接
5. 测试上传功能，确保文件路径正确

## 许可

本模块遵循项目整体许可协议。
