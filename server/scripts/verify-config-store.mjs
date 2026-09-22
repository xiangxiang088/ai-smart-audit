/**
 * 统一配置中心接口验证（可重复执行，结束时清理临时测试数据）
 *   验证：配置域列举、类型往返（string/number/boolean/json）、密钥脱敏、
 *         域名非法拦截、删除、以及旧接口 /api/settings/ai 契约不变。
 *
 * 前置：另起实例以免打扰正在运行的服务
 *   PORT=3004 node server.js
 * 用法：node scripts/verify-config-store.mjs [--base=http://127.0.0.1:3004]
 */
const argBase = process.argv.find(a => a.startsWith('--base='));
const BASE = argBase ? argBase.slice(7) : 'http://127.0.0.1:3004';
const API = BASE + '/api';

const TEST_NS = 'selftest.tmp';

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

const login = await call('POST', '/auth/login', { username: 'admin', password: '123456' });
const token = login.data?.token;
if (!token) { console.error('登录失败', login.status, login.text.slice(0, 300)); process.exit(1); }
console.log('登录成功\n');

console.log('===== 1. 配置域导航 =====');
const list = await call('GET', '/admin/config', null, token);
const nsNames = (list.data?.namespaces || []).map(n => n.namespace);
console.log('  已注册配置域:', nsNames.join(', ') || '(空)');
check('GET /api/admin/config 返回配置域列表', Array.isArray(list.data?.namespaces));
check('包含审计模型链域 audit.ai', nsNames.includes('audit.ai'));
check('包含教育模块域 edu.ai', nsNames.includes('edu.ai'));

console.log('\n===== 2. 审计模型链域（值应为 json，且不被脱敏）=====');
const auditNs = await call('GET', '/admin/config/audit.ai', null, token);
const chainItem = auditNs.data?.items?.find(i => i.key === 'model_chain');
console.log('  model_chain.type =', chainItem?.type);
console.log('  model_chain 值   =', chainItem ? `{ activeModel=${chainItem.value?.activeModel}, models=${chainItem.value?.models?.length} }` : '(缺失)');
check('audit.ai/model_chain 存在', !!chainItem);
check('其类型为 json 且已解析为对象', chainItem?.type === 'json' && typeof chainItem.value === 'object');
check('主模型字段可读', typeof chainItem?.value?.activeModel === 'string');

console.log('\n===== 3. 教育模块域（密钥必须脱敏、布尔必须还原为 true）=====');
const eduNs = await call('GET', '/admin/config/edu.ai', null, token);
const eduItems = Object.fromEntries((eduNs.data?.items || []).map(i => [i.key, i]));
console.log('  model        =', eduItems.model?.value, `(${eduItems.model?.type})`);
console.log('  enabled      =', eduItems.enabled?.value, `(${eduItems.enabled?.type})`);
console.log('  api_key      =', eduItems.api_key?.value, `(secret=${eduItems.api_key?.secret})`);
check('edu.ai/model 为 glm-4-flash', eduItems.model?.value === 'glm-4-flash');
check('enabled 还原为布尔 true（非字符串 "true"）', eduItems.enabled?.value === true);
check('api_key 标记为 secret', eduItems.api_key?.secret === true);
check('api_key 已脱敏（不含完整密钥）', /^\S{0,4}\*{4}/.test(String(eduItems.api_key?.value || '')));

console.log('\n===== 4. 类型往返（临时域 selftest.tmp）=====');
const put = await call('PUT', `/admin/config/${TEST_NS}`, {
  items: [
    { key: 'str', value: 'hello' },
    { key: 'num', value: 42 },
    { key: 'bool', value: true },
    { key: 'obj', value: { a: 1, b: ['x'] } },
    { key: 'sec', value: 'supersecretvalue', secret: true }
  ]
}, token);
check('批量写入临时域', put.ok && put.data?.written?.length === 5, `written=${put.data?.written?.join(',')}`);

const readBack = await call('GET', `/admin/config/${TEST_NS}`, null, token);
const rb = Object.fromEntries((readBack.data?.items || []).map(i => [i.key, i]));
console.log('  读回:', JSON.stringify({
  str: rb.str?.value, num: rb.num?.value, bool: rb.bool?.value, obj: rb.obj?.value, sec: rb.sec?.value
}));
check('string 往返', rb.str?.value === 'hello' && rb.str?.type === 'string');
check('number 往返（保持数字类型）', rb.num?.value === 42 && rb.num?.type === 'number');
check('boolean 往返（保持布尔类型）', rb.bool?.value === true && rb.bool?.type === 'boolean');
check('json 往返（对象结构完整）', JSON.stringify(rb.obj?.value) === JSON.stringify({ a: 1, b: ['x'] }));
check('密钥项写入后读取即脱敏', rb.sec?.secret === true && rb.sec?.value === 'supe****alue');

console.log('\n===== 5. 覆盖写与「留空不修改密钥」语义 =====');
await call('PUT', `/admin/config/${TEST_NS}`, { items: [{ key: 'sec', value: '' }] }, token);
const afterEmpty = await call('GET', `/admin/config/${TEST_NS}`, null, token);
const secAfter = (afterEmpty.data?.items || []).find(i => i.key === 'sec');
check('密钥传空值时不覆盖原值', secAfter?.value === 'supe****alue', `现值=${secAfter?.value}`);

console.log('\n===== 6. 域名与权限校验 =====');
const bad = await call('GET', '/admin/config/Bad_Name', null, token);
check('非法域名被拦截（400）', bad.status === 400, `status=${bad.status}`);
const noAuth = await call('GET', '/admin/config/edu.ai');
check('未登录访问被拦截（401）', noAuth.status === 401, `status=${noAuth.status}`);

console.log('\n===== 7. 旧接口 /api/settings/ai 契约不变 =====');
const oldGet = await call('GET', '/settings/ai', null, token);
console.log('  ai_model        =', oldGet.data?.ai_model);
console.log('  ai_vision_model =', oldGet.data?.ai_vision_model);
console.log('  ai_enabled      =', oldGet.data?.ai_enabled, `(${typeof oldGet.data?.ai_enabled})`);
console.log('  ai_api_key_masked =', oldGet.data?.ai_api_key_masked);
check('旧接口仍返回 ai_model', oldGet.data?.ai_model === 'glm-4-flash');
check('旧接口仍返回 ai_vision_model', oldGet.data?.ai_vision_model === 'glm-4v-flash');
check('旧接口 ai_enabled 为布尔', typeof oldGet.data?.ai_enabled === 'boolean');
check('旧接口返回掩码且不返回明文密钥', !!oldGet.data?.ai_api_key_masked && oldGet.data?.ai_api_key === undefined);

const oldPut = await call('PUT', '/settings/ai', { ai_model: 'glm-4-flash', ai_enabled: true }, token);
check('旧接口写入成功（未带密钥，不影响已存密钥）', oldPut.ok);
const oldGet2 = await call('GET', '/settings/ai', null, token);
check('写入后掩码仍在（密钥未被清空）', !!oldGet2.data?.ai_api_key_masked, `masked=${oldGet2.data?.ai_api_key_masked}`);

console.log('\n===== 8. 清理临时测试数据 =====');
let removed = 0;
for (const k of ['str', 'num', 'bool', 'obj', 'sec']) {
  const d = await call('DELETE', `/admin/config/${TEST_NS}/${k}`, null, token);
  if (d.data?.removed) removed++;
}
const afterClean = await call('GET', `/admin/config/${TEST_NS}`, null, token);
check('临时域键已全部删除', removed === 5 && (afterClean.data?.items || []).length === 0, `removed=${removed}`);

console.log('\n================ 汇总 ================');
const failed = results.filter(r => !r.pass);
console.log(`通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败：', failed.map(f => f.name).join('、'));
  process.exitCode = 1;
} else {
  console.log('全部通过 ✅');
}
