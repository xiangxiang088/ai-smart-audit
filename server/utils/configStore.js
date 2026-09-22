/**
 * 分域配置中心（system config store）
 *
 * 全系统配置统一走这里读写，存储为 `sl_sys_config` 的分域键值结构：
 *   (namespace, config_key) → config_value + value_type + is_secret + description
 *
 * 约定：
 *   - namespace 用点分层级表达归属，如 `audit.ai`（审计模型链）、`edu.ai`（教育/记账 AI）
 *   - value_type ∈ string | number | boolean | json，取值时自动按类型解码，
 *     调用方拿到的就是 number / boolean / object，避免「'false' 是 truthy」这类坑
 *   - is_secret=1 的配置：服务端内部 `get()` 拿明文；对外输出必须走
 *     `describe()` / `getNamespace({ maskSecrets: true })`，自动脱敏
 *
 * 缓存：按 namespace 缓存 30 秒；任何写操作立即失效该域缓存 → 改完即生效、不用重启
 *
 * 用法：
 *   const cfgStore = require('../utils/configStore');
 *   await cfgStore.get('audit.ai', 'model_chain', null);   // 已解码的值
 *   await cfgStore.getNamespace('edu.ai');                 // { key: value }
 *   await cfgStore.set('audit.ai', 'model_chain', obj, { type: 'json', userId });
 *   await cfgStore.setMany('edu.ai', [{ key, value, type, secret }], { userId });
 *   await cfgStore.registerDefaults('edu.ai', { model: { value: 'glm-4-flash' } });
 *   cfgStore.reload('audit.ai');                           // 或 reload() 全清
 */
const db = require('../db');

const CACHE_TTL = 30000;
const VALID_TYPES = ['string', 'number', 'boolean', 'json'];

const cache = new Map();

function normalizeType(t) {
  return VALID_TYPES.includes(t) ? t : 'string';
}

/** 库内原始值 → JS 值（按 value_type 解码） */
function decode(row) {
  const raw = row.config_value;
  if (raw === null || raw === undefined) return null;
  switch (row.value_type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return raw === 'true' || raw === '1';
    case 'json': {
      try { return JSON.parse(raw); } catch { return null; }
    }
    default:
      return String(raw);
  }
}

/** JS 值 → 库内原始值 + 类型（未显式指定类型时按值的形态推断） */
function encode(value, explicitType) {
  let type = normalizeType(explicitType);
  if (!explicitType) {
    if (typeof value === 'number') type = 'number';
    else if (typeof value === 'boolean') type = 'boolean';
    else if (value !== null && typeof value === 'object') type = 'json';
  }
  let raw = null;
  if (value !== null && value !== undefined) {
    raw = type === 'json' ? JSON.stringify(value) : String(value);
  }
  return { type, raw };
}

/** 密钥脱敏：保留头 4 位 + 尾 4 位，过短的整串打码 */
function mask(secret) {
  const s = String(secret ?? '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/** 读取一个域的全部行（带缓存），返回 Map<config_key, row> */
async function loadNamespace(ns, force = false) {
  const hit = cache.get(ns);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL) return hit.map;

  const map = new Map();
  try {
    const [rows] = await db.query(
      `SELECT config_key, config_value, value_type, is_secret, description, updated_at
         FROM sl_sys_config WHERE namespace = ?`,
      [ns]
    );
    for (const r of rows) map.set(r.config_key, r);
  } catch (err) {
    // 读不到就返回空集，由调用方的 fallback / 内置默认兜底，不让配置故障放大成业务故障
    console.warn(`[configStore] 读取配置域 ${ns} 失败，回退默认值：${err.message}`);
  }
  cache.set(ns, { map, at: Date.now() });
  return map;
}

/** 取单个配置（已按类型解码）。不存在或解码失败时返回 fallback */
async function get(ns, key, fallback = null) {
  const map = await loadNamespace(ns);
  const row = map.get(key);
  if (!row) return fallback;
  const val = decode(row);
  return val === null ? fallback : val;
}

/** 取整个域为普通对象（密钥默认原样返回，仅服务端内部使用） */
async function getNamespace(ns, { maskSecrets = false } = {}) {
  const map = await loadNamespace(ns);
  const out = {};
  for (const [key, row] of map) {
    const val = decode(row);
    if (maskSecrets && row.is_secret) out[key] = mask(row.config_value);
    else out[key] = val;
  }
  return out;
}

/** 取整个域的元信息（供配置管理页展示：类型 / 是否密钥 / 描述 / 更新时间） */
async function describe(ns, { maskSecrets = true } = {}) {
  const map = await loadNamespace(ns);
  return {
    namespace: ns,
    items: [...map.entries()].map(([key, row]) => ({
      key,
      type: row.value_type,
      secret: !!row.is_secret,
      description: row.description || '',
      updatedAt: row.updated_at,
      value: row.is_secret && maskSecrets ? mask(row.config_value) : decode(row)
    }))
  };
}

/** 写单个配置。secret 传 undefined 时保留原值（避免误清标记） */
async function set(ns, key, value, { type, secret, description, userId } = {}) {
  const { type: t, raw } = encode(value, type);
  // secret 未传 = 不修改标记：INSERT 时落 0（列 NOT NULL），UPDATE 时保留原值
  const secretFlag = secret === undefined ? null : (secret ? 1 : 0);
  await db.query(
    `INSERT INTO sl_sys_config
       (namespace, config_key, config_value, value_type, is_secret, description, updated_by)
     VALUES (?, ?, ?, ?, COALESCE(?, 0), ?, ?)
     ON DUPLICATE KEY UPDATE
       config_value = VALUES(config_value),
       value_type   = VALUES(value_type),
       is_secret    = IF(? IS NULL, is_secret, VALUES(is_secret)),
       description  = COALESCE(VALUES(description), description),
       updated_by   = VALUES(updated_by)`,
    [ns, key, raw, t, secretFlag, description || null, userId || null, secretFlag]
  );
  cache.delete(ns);
}

/**
 * 批量写。entries 形如 [{ key, value, type?, secret?, description? }] 或 { key: value }
 * 选项 skipEmptySecrets=true 时，密钥项传空值视为「不修改」（页面上留空 = 保持原密钥）。
 * 判定「是密钥项」有两条依据：调用方显式标了 secret，或库中该键本就是密钥 ——
 * 后者让调用方即便不声明标记，也不会把掩码/空串误写成新密钥。
 */
async function setMany(ns, entries, { userId, skipEmptySecrets = false } = {}) {
  const list = Array.isArray(entries)
    ? entries
    : Object.entries(entries).map(([key, value]) => ({ key, value }));

  const written = [];
  for (const item of list) {
    if (!item || !item.key) continue;
    if (item.value === undefined) continue;
    const isEmpty = item.value === null || item.value === '';
    if (skipEmptySecrets && isEmpty) {
      const existing = (await loadNamespace(ns)).get(item.key);
      if (item.secret || (existing && existing.is_secret)) continue;
    }
    await set(ns, item.key, item.value, {
      type: item.type,
      secret: item.secret,
      description: item.description,
      userId
    });
    written.push(item.key);
  }
  return written;
}

async function remove(ns, key) {
  const [res] = await db.query(
    'DELETE FROM sl_sys_config WHERE namespace = ? AND config_key = ?',
    [ns, key]
  );
  cache.delete(ns);
  return res.affectedRows > 0;
}

/** 列出所有配置域及其条目数（供配置管理页做导航） */
async function listNamespaces() {
  const [rows] = await db.query(
    `SELECT namespace, COUNT(*) AS item_count, MAX(updated_at) AS last_updated_at
       FROM sl_sys_config GROUP BY namespace ORDER BY namespace`
  );
  return rows.map(r => ({
    namespace: r.namespace,
    itemCount: Number(r.item_count),
    lastUpdatedAt: r.last_updated_at
  }));
}

/**
 * 首次运行写入默认值（已存在的键不覆盖）。
 * defaults 形如 { model: { value: 'glm-4-flash', type: 'string', description: '...' } }
 * 或简写 { model: 'glm-4-flash' }
 */
async function registerDefaults(ns, defaults, { userId } = {}) {
  const map = await loadNamespace(ns, true);
  const created = [];
  for (const [key, spec] of Object.entries(defaults || {})) {
    if (map.has(key)) continue;
    const item = spec !== null && typeof spec === 'object' && 'value' in spec ? spec : { value: spec };
    await set(ns, key, item.value, {
      type: item.type,
      secret: item.secret,
      description: item.description,
      userId
    });
    created.push(key);
  }
  return created;
}

/** 清缓存：传 ns 只清该域，不传清全部 */
function reload(ns) {
  if (ns) cache.delete(ns);
  else cache.clear();
}

module.exports = {
  get,
  getNamespace,
  describe,
  set,
  setMany,
  remove,
  listNamespaces,
  registerDefaults,
  reload,
  mask,
  decode,
  encode,
  VALID_TYPES
};
