/**
 * 工程审计 - 智能问答（证据溯源）
 * 会话/消息管理 + 向审计 Agent 提问
 */
const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const { operLog, recordOperLog } = require('../../logger');
const svc = require('../../utils/audit/agent/chatService');

router.use(auth);

// 会话列表
router.get('/sessions', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: '缺少 project_id' });
    const list = await svc.listSessions(projectId, req.userId, await auth.isAdmin(req.userId));
    res.json(list);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 新建会话
router.post('/sessions', operLog('智能问答', 1), async (req, res) => {
  try {
    const { project_id, title } = req.body || {};
    if (!project_id) return res.status(400).json({ error: '缺少 project_id' });
    const s = await svc.createSession(project_id, req.userId, await auth.isAdmin(req.userId), title);
    res.json(s);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 删除会话
router.delete('/sessions/:id', operLog('智能问答', 3), async (req, res) => {
  try {
    await svc.deleteSession(req.params.id, req.userId, await auth.isAdmin(req.userId));
    res.json({ success: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 消息历史
router.get('/sessions/:id/messages', async (req, res) => {
  try {
    await svc.assertSessionAccess(req.params.id, req.userId, await auth.isAdmin(req.userId));
    res.json(await svc.listMessages(req.params.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 提问（同步运行 Agent，约 10-60s；保留给流式不可用时的降级链路）
router.post('/sessions/:id/ask', operLog('智能问答', 0), async (req, res) => {
  try {
    const { content } = req.body || {};
    const msg = await svc.ask(req.params.id, req.userId, await auth.isAdmin(req.userId), content);
    res.json(msg);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, attempts: e.attempts || undefined });
  }
});

/**
 * 流式提问（SSE）。Agent 的取证进度与成稿正文实时下发，用户不必干等到最后。
 * 事件：start / progress / tool / answer / done / error
 * 注意：POST 无法用浏览器 EventSource，前端用 fetch + ReadableStream 读取。
 */
router.post('/sessions/:id/ask-stream', async (req, res) => {
  const started = Date.now();

  // 先做一次访问校验：会话不存在/无权访问属于「流还没开始」的错误，
  // 这样能以正常的 HTTP 状态码返回；一旦发出 SSE 头就只能塞 200 里了。
  try {
    await svc.assertSessionAccess(req.params.id, req.userId, await auth.isAdmin(req.userId));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 反代（nginx）不缓冲，否则事件会被攒到最后一起发
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  // 整个问答可能跑几分钟，关掉 socket 空闲超时
  req.setTimeout(0);
  if (res.socket && typeof res.socket.setTimeout === 'function') res.socket.setTimeout(0);

  let clientGone = false;
  const send = (event, data) => {
    if (clientGone || res.writableEnded) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { clientGone = true; }
  };
  // 心跳保活：和长模型请求同一个坑——中间网络设备会按空闲超时掐连接，
  // 取证阶段可能几十秒没有输出，靠注释行把连接吊住。
  const heartbeat = setInterval(() => {
    if (clientGone || res.writableEnded) return;
    try { res.write(': ping\n\n'); } catch { clientGone = true; }
  }, 15000);
  res.on('close', () => { clientGone = true; });

  let summary = null;
  let failure = '';
  try {
    const { content } = req.body || {};
    const msg = await svc.askStream(req.params.id, req.userId, await auth.isAdmin(req.userId), content, send);
    if (msg) {
      summary = {
        streamed: true, messageId: msg.id, contentLength: (msg.content || '').length,
        model: msg.model, rounds: msg.rounds, evidenceCount: msg.evidenceCount
      };
    } else {
      failure = 'Agent 运行失败';
    }
  } catch (e) {
    failure = e.message || '流式问答失败';
    send('error', { message: failure, status: e.status || 500 });
  } finally {
    clearInterval(heartbeat);
    if (!clientGone && !res.writableEnded) res.end();
    // SSE 用 res.write，不经过 res.json，操作日志中间件捕捉不到，这里手动补一条
    setImmediate(() => recordOperLog({
      title: '智能问答', businessType: 0, req,
      result: summary || { error: failure },
      statusCode: failure ? 500 : 200,
      costTime: Date.now() - started,
      errorMsg: failure
    }));
  }
});

module.exports = router;
