const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const auth = require('../middleware/auth');
const { recordLoginLog, recordLogoutLog, operLog } = require('../logger');
const snowflake = require('../utils/snowflake');

const { isAdmin } = require('../middleware/auth');

const router = express.Router();
const { JWT_SECRET } = auth;

// 输入校验工具
function validateUsername(username) {
  if (!username || typeof username !== 'string') return '请输入用户名';
  if (username.length < 3 || username.length > 20) return '用户名长度需3-20个字符';
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) return '用户名只能包含字母、数字、下划线、中文';
  return null;
}
function validatePassword(password) {
  if (!password || typeof password !== 'string') return '请输入密码';
  if (password.length < 6 || password.length > 50) return '密码长度需6-50个字符';
  return null;
}
function validateNickname(nickname) {
  if (!nickname || typeof nickname !== 'string') return '请输入昵称';
  if (nickname.length < 1 || nickname.length > 20) return '昵称长度需1-20个字符';
  return null;
}

// 注册
router.post('/register', async (req, res) => {
  try {
    const { username, password, nickname } = req.body;
    const err = validateUsername(username) || validatePassword(password) || validateNickname(nickname);
    if (err) return res.status(400).json({ error: err });

    const [existing] = await db.query('SELECT id FROM sl_sys_user WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.status(400).json({ error: '用户名已存在' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = snowflake.nextId();
    await db.query(
      'INSERT INTO sl_sys_user (id, username, password, nickname, created_by) VALUES (?, ?, ?, ?, ?)',
      [userId, username, hashedPassword, nickname, userId]
    );

    const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '30d' });
    await recordLoginLog({ username, userId, status: '0', msg: '注册成功并登录', req });
    const adminFlag = await isAdmin(userId);
    res.json({ token, is_admin: adminFlag, user: { id: userId, username, nickname } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '注册失败' });
  }
});

// 登录
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: '用户名或密码错误' });
    }
    if (username.length > 50 || password.length > 100) {
      return res.status(400).json({ error: '用户名或密码错误' });
    }
    const [users] = await db.query('SELECT * FROM sl_sys_user WHERE username = ? AND del_flag = 0', [username]);
    if (users.length === 0) {
      await recordLoginLog({ username, status: '1', msg: '用户不存在', req });
      return res.status(400).json({ error: '用户名或密码错误' });
    }

    const user = users[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      await recordLoginLog({ username, userId: user.id, status: '1', msg: '密码错误', req });
      return res.status(400).json({ error: '用户名或密码错误' });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    await recordLoginLog({ username: user.username, userId: user.id, status: '0', msg: '登录成功', req });
    const adminFlag = await isAdmin(user.id);
    res.json({
      token,
      is_admin: adminFlag,
      user: { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar }
    });
  } catch (err) {
    console.error(err);
    await recordLoginLog({ username: req.body?.username, status: '1', msg: '登录异常: ' + err.message, req });
    res.status(500).json({ error: '登录失败' });
  }
});

// 退出登录
router.post('/logout', auth, async (req, res) => {
  try {
    await recordLogoutLog(req, req.userId, req.user?.username || '');
  } catch (err) {
    console.error('[logout] 记录登出日志失败:', err.message);
  }
  res.json({ success: true });
});

// 获取用户信息
router.get('/me', auth, async (req, res) => {
  const [users] = await db.query('SELECT id, username, nickname, avatar, email FROM sl_sys_user WHERE id = ? AND del_flag = 0', [req.userId]);
  if (users.length === 0) return res.status(401).json({ error: '用户不存在' });
  res.json(users[0]);
});

// 更新用户信息
router.put('/me', auth, operLog('个人信息', 2), async (req, res) => {
  const { nickname, avatar, email } = req.body;
  // 校验昵称
  if (nickname !== undefined) {
    const err = validateNickname(nickname);
    if (err) return res.status(400).json({ error: err });
  }
  // 校验邮箱格式
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }
  // 限制avatar URL长度
  if (avatar && avatar.length > 500) {
    return res.status(400).json({ error: '头像URL过长' });
  }
  await db.query('UPDATE sl_sys_user SET nickname=?, avatar=?, email=? WHERE id=?',
    [nickname, avatar || null, email || null, req.userId]);
  res.json({ success: true });
});

// 修改密码
router.post('/change-password', auth, operLog('个人信息', 2), async (req, res) => {
  try {
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password) {
      return res.status(400).json({ error: '请填写完整信息' });
    }
    const pwdErr = validatePassword(new_password);
    if (pwdErr) return res.status(400).json({ error: pwdErr });

    const [users] = await db.query('SELECT * FROM sl_sys_user WHERE id = ? AND del_flag = 0', [req.userId]);
    if (users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const validPassword = await bcrypt.compare(old_password, users[0].password);
    if (!validPassword) {
      return res.status(400).json({ error: '原密码不正确' });
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE sl_sys_user SET password = ? WHERE id = ?', [hashedPassword, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '修改密码失败' });
  }
});

module.exports = router;
