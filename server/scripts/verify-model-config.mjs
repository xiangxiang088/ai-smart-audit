/**
 * 模型配置接口回归测试（可重复执行，结束时自动恢复原有配置）
 *   验证：新增字段返回、模型链重排序、停用跳过、关闭故障切换、超时持久化、非法配置拦截。
 *
 * 前置：为避免打扰正在运行的服务，建议另起一个实例
 *   PORT=3004 node server.js
 * 用法：node scripts/verify-model-config.mjs [--base=http://127.0.0.1:3004]
 */
const argBase = process.argv.find(a => a.startsWith('--base='));
const BASE = argBase ? argBase.slice(7) : 'http://127.0.0.1:3004';
const API = BASE + '/api';

async function call(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, ok: res.ok, data: json, text };
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

// 1. 登录
const login = await call('POST', '/auth/login', { username: 'admin', password: '123456' });
const token = login.data?.token;
if (!token) { console.error('登录失败', login.status, login.text.slice(0, 300)); process.exit(1); }
console.log('登录成功\n');

// 2. 读取当前配置
const g1 = await call('GET', '/audit/ai-config', null, token);
console.log('当前配置：');
console.log('  activeModel        =', g1.data.activeModel);
console.log('  failoverEnabled    =', g1.data.failoverEnabled);
console.log('  chainTimeoutMs     =', g1.data.chainTimeoutMs);
console.log('  models 顺序        =', g1.data.models.map(m => m.key).join(' → '));
console.log('  effectiveChain     =', g1.data.effectiveChain.map(c => `${c.order}.${c.key}`).join(' → '));
console.log('  每模型 timeoutMs   =', g1.data.models.map(m => `${m.key}:${m.timeoutMs}`).join(', '));
console.log('');

check('GET 返回 effectiveChain', Array.isArray(g1.data.effectiveChain) && g1.data.effectiveChain.length > 0);
check('GET 返回每模型 timeoutMs', g1.data.models.every(m => typeof m.timeoutMs === 'number'));
check('GET 返回 chainTimeoutMs', typeof g1.data.chainTimeoutMs === 'number');
check('GET 返回动态 role', g1.data.models.filter(m => m.role === 'primary').length === 1);

const backup = JSON.parse(JSON.stringify(g1.data));

// 3. 把最后一个模型设为主模型 + 关闭故障切换 → 应只剩它一个
const last = backup.models[backup.models.length - 1];
const put1 = await call('PUT', '/audit/ai-config', {
  activeModel: last.model,
  failoverEnabled: false,
  chainTimeoutMs: 600000,
  models: [
    { key: last.key, enabled: true, timeoutMs: 120000 },
    ...backup.models.filter(m => m.key !== last.key).map(m => ({ key: m.key, enabled: true, timeoutMs: 0 }))
  ]
}, token);
check('PUT 保存成功', put1.ok, put1.ok ? '' : (put1.data?.error || put1.text.slice(0, 200)));
check(`PUT 后主模型 = ${last.key}`, put1.data?.config?.activeModel === last.model);
check(`PUT 后链首 = ${last.key}`, put1.data?.config?.effectiveChain?.[0]?.key === last.key);
check('关闭故障切换后 effectiveChain 仅 1 个', put1.data?.config?.effectiveChain?.length === 1);
check('每模型超时已持久化（120000）', put1.data?.config?.models.find(m => m.key === last.key)?.timeoutMs === 120000);
check('chainTimeoutMs 已持久化（600000）', put1.data?.config?.chainTimeoutMs === 600000);

// 4. 顺序反转 + 停用中间那个 + 开启故障切换
const rev = [...backup.models].reverse();
const put2 = await call('PUT', '/audit/ai-config', {
  activeModel: rev[0].model,
  failoverEnabled: true,
  chainTimeoutMs: 1800000,
  models: rev.map((m, i) => ({ key: m.key, enabled: i !== 1, timeoutMs: 0 }))
}, token);
console.log('');
console.log('重排后 models 顺序   =', put2.data?.config?.models.map(m => m.key).join(' → '));
console.log('重排后 effectiveChain=', put2.data?.config?.effectiveChain.map(c => `${c.order}.${c.key}`).join(' → '));
check(`重排后链首 = ${rev[0].key}（证明顺序可控）`, put2.data?.config?.effectiveChain?.[0]?.key === rev[0].key);
check(`停用的 ${rev[1].key} 未进入调用链`, !put2.data?.config?.effectiveChain?.some(c => c.key === rev[1].key));
check(`启用的 ${rev[2].key} 顺位进入调用链`, put2.data?.config?.effectiveChain?.[1]?.key === rev[2].key);
check('保存后 models 顺序按提交保留', put2.data?.config?.models.map(m => m.key).join() === rev.map(m => m.key).join());

// 5. 非法配置拦截：把所有模型停用
const put3 = await call('PUT', '/audit/ai-config', {
  activeModel: rev[0].model,
  failoverEnabled: true,
  models: rev.map(m => ({ key: m.key, enabled: false, timeoutMs: 0 }))
}, token);
check('全部停用时被拒绝（400）', put3.status === 400, put3.data?.error || '');

// 6. 恢复原有配置
const restore = await call('PUT', '/audit/ai-config', {
  activeModel: backup.activeModel,
  failoverEnabled: backup.failoverEnabled,
  chainTimeoutMs: backup.chainTimeoutMs,
  models: backup.models.map(m => ({ key: m.key, model: m.model, enabled: m.enabled, timeoutMs: m.timeoutMs }))
}, token);
check('原配置已恢复', restore.data?.config?.activeModel === backup.activeModel
  && restore.data?.config?.failoverEnabled === backup.failoverEnabled
  && restore.data?.config?.chainTimeoutMs === backup.chainTimeoutMs);

const failed = results.filter(r => !r.pass);
console.log('\n================ 汇总 ================');
console.log(`通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) { console.log('失败：', failed.map(f => f.name).join('、')); process.exit(1); }
console.log('全部通过 ✅');
