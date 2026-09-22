/**
 * 清标分析端到端测试
 *
 * 用法：
 *   node scripts/e2e-bid-clearing.mjs --group=2
 *   node scripts/e2e-bid-clearing.mjs --group=1 --parse-timeout=1800
 *   node scripts/e2e-bid-clearing.mjs --group=2,3
 *
 * 可选参数：
 *   --group=1|2|3|1,2,3   要跑的组（默认 2）
 *   --base=http://127.0.0.1:3003
 *   --user=admin --pass=123456
 *   --parse-timeout=900   单组解析等待上限（秒）
 *   --analyze-timeout=660 单组分析等待上限（秒）
 *   --keep                跑完不删任务（默认保留，便于在页面里查看）
 *
 * 流程（严格按清标数据模型）：
 *   登录 → 建任务 → 上传招标控制价并挂接 → 逐家建投标方并挂接报价 →
 *   等待全部解析完成 → 触发分析 → 轮询至 done/failed → 校验报告
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SAMPLES = path.join(PROJECT_ROOT, 'docs/bid-clearing-samples');
const OUT_DIR = path.join(PROJECT_ROOT, 'server/data/e2e-report');

// ---------- 参数 ----------
function argVal(name, dflt) {
  const p = process.argv.find(a => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : dflt;
}
const BASE = argVal('base', process.env.AUDIT_BASE_URL || 'http://127.0.0.1:3003');
const USERNAME = argVal('user', 'admin');
const PASSWORD = argVal('pass', '123456');
const GROUPS = String(argVal('group', '2')).split(',').map(s => s.trim()).filter(Boolean);
const PARSE_TIMEOUT_MS = Number(argVal('parse-timeout', 1800)) * 1000;
// 注意：must be > 服务端 arkClient 的 timeoutMs(600s)，否则轮询会先于模型返回而误报"分析超时"
const ANALYZE_TIMEOUT_MS = Number(argVal('analyze-timeout', 900)) * 1000;

// ---------- 测试资料定义 ----------
// checks 为「考点级断言」：must = 报告中必须出现（命中该考点）；forbid = 不得出现（反向断言，
// 命中说明模型给出了与事实相反的结论，比漏报更危险）。字符串按子串匹配，正则按 test 匹配；
// 金额一律写成容忍千分位的正则（如 /5,?799\.95/），避免因 5,799.95 / 5799.95 两种写法误判。
// 考点来源：docs/bid-clearing-samples/README.md 第二节「每组可触发的清标校验点」。
const G = {
  '1': {
    title: '清标测试-第1组-扬州站东路',
    dir: '第1组-扬州站东路',
    control: '招标控制价-站东路（扬冶路-国防路）工程施工.pdf',
    bidders: [
      { name: '江苏兴业环境集团有限公司', file: '投标报价文件-兴业环境-江苏兴业环境集团有限公司.xlsx' },
      { name: '扬州一建集团有限公司', file: '投标报价文件-扬州一建-扬州一建集团有限公司.xlsx' },
      { name: '江苏双联建设工程有限公司', file: '投标报价文件-江苏双联-江苏双联建设工程有限公司.docx' },
    ],
    checks: [
      { id: 'arith-040203004002', level: 'high',   desc: '算术性错误：兴业环境 040203004002（合价≠单价×数量，多计12%）', must: ['040203004002'] },
      { id: 'unbalanced',        level: 'medium', desc: '不平衡报价：兴业环境（土石方/道路偏高、绿化/路灯/交安偏低）', must: ['不平衡报价'] },
      { id: 'omission-050102013001', level: 'high', desc: '漏报：扬州一建 050102013001（综合单价空缺未填）', must: ['050102013001'] },
      { id: 'zero-bid-04B017',   level: 'high',   desc: '零报价：扬州一建 04B017（单价填0、合价非0）', must: ['04B017'] },
      { id: 'safety-fee',        level: 'medium', desc: '安全文明施工费偏低：扬州一建（约控制价82%）', must: ['安全文明'] },
      { id: 'provisional-360157', level: 'high',  desc: '暂列金额被下调：江苏双联 360,157.95 元', must: [/360,?157\.95/] },
      { id: 'qty-tampered',      level: 'high',   desc: '工程量擅自改动：江苏双联 雨污水工程第6项（改为88%）',
        forbid: [/工程量[^。\n|]{0,25}(完全一致|无擅自改动|未发现改动|无改动|一致，不得变动)/] },
      { id: 'item-missing',      level: 'high',   desc: '漏项：江苏双联 交安工程缺 1 个清单项',
        forbid: [/清单项[^。\n|]{0,20}(与招标一致|无缺项|无遗漏|一致，无缺项)/] },
      { id: 'sum-mismatch',      level: 'high',   desc: '汇总与总价不一致：兴业 5,799.95 / 一建 17,946.89 / 双联 366,540.50',
        must: [/5,?799\.95/, /17,?946\.89/, /366,?540\.50/] },
    ],
  },
  '2': {
    title: '清标测试-第2组-杨庙镇Y014沿山河南路',
    dir: '第2组-杨庙镇Y014沿山河南路',
    control: '招标控制价-杨庙镇Y014沿山河南路提档升级改造工程.xlsx',
    bidders: [
      { name: '扬州天达建设集团有限公司', file: '投标报价文件-扬州天达建设集团有限公司.xlsx' },
      { name: '扬州润扬路面工程有限公司', file: '投标报价文件-扬州润扬路面工程有限公司.xlsx' },
      { name: '江苏靖翔交通工程有限公司', file: '投标报价文件-江苏靖翔交通工程有限公司.xlsx' },
    ],
    checks: [
      { id: 'unbalanced',     level: 'medium', desc: '不平衡报价：扬州天达（路基高、安全设施低）', must: ['不平衡报价'] },
      { id: 'omission',       level: 'high',   desc: '漏报：扬州天达 水泥混凝土基层（厚150mm C20）', must: [/水泥混凝土/] },
      { id: 'zero-bid',       level: 'high',   desc: '零报价：江苏靖翔 软土路基处理·高性能聚酯布', must: [/聚酯布/] },
      { id: 'qty-changed',    level: 'medium', desc: '工程量改动：江苏靖翔 细粒式沥青混凝土', must: [/细粒式沥青/] },
      { id: 'sum-mismatch',   level: 'high',   desc: '汇总与总价不一致：天达 220,393.66 / 靖翔 19,651.95', must: [/220,?393\.66/, /19,?651\.95/] },
    ],
  },
  '3': {
    title: '清标测试-第3组-北京市政道路',
    dir: '第3组-北京市政道路',
    control: '招标控制价-最高投标限价.docx',
    bidders: [
      { name: '北京天龙建筑集团有限公司', file: '投标报价文件-北京天龙建筑集团有限公司.xlsx' },
      { name: '北京住通建设有限公司', file: '投标报价文件-北京住通建设有限公司.xlsx' },
      { name: '北京城建五维建设有限公司', file: '投标报价文件-北京城建五维建设有限公司.xlsx' },
      { name: '北京热力市政工程建设有限公司', file: '投标报价文件-北京热力市政工程建设有限公司.xlsx' },
      { name: '鸿川建筑产业集团有限公司', file: '投标报价文件-鸿川建筑产业集团有限公司.xlsx' },
    ],
    checks: [
      { id: 'near-ceiling',   level: 'medium', desc: '踩线报价：天龙建筑 6,224,705.94（仅低限价 7.31 元）', must: [/6,?224,?705\.94|7\.31/] },
      { id: 'safety-fee',     level: 'medium', desc: '安全文明施工费异常：鸿川 300,581.91（约 −30.8%）', must: [/300,?581\.91/] },
      { id: 'provisional-ok', level: 'medium', desc: '暂列金额一致：5 家均为 514,481.63（应判"未发现异常"）', must: [/514,?481\.63/] },
      { id: 'anti-hallucination', level: 'medium', desc: '反幻觉：附件未载明项目名称，模型应提示信息缺失而非编造',
        must: [/未载明|未提供|未标注|未明确|缺失|无从核对/] },
    ],
  },
};

// ---------- 工具 ----------
const REPORT = { startedAt: new Date().toISOString(), base: BASE, groups: {}, issues: [] };
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[90m', c: '\x1b[36m', x: '\x1b[0m' };
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`${C.d}${ts()}${C.x}`, ...a);
const ok = (...a) => console.log(`${C.d}${ts()}${C.x} ${C.g}✓${C.x}`, ...a);
const warn = (...a) => console.log(`${C.d}${ts()}${C.x} ${C.y}!${C.x}`, ...a);
const bad = (...a) => console.log(`${C.d}${ts()}${C.x} ${C.r}✗${C.x}`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function issue(group, level, title, detail) {
  REPORT.issues.push({ group, level, title, detail: String(detail ?? '').slice(0, 3000) });
  (level === 'high' ? bad : warn)(`[${level}] 组${group} · ${title}`);
}

/** 单条断言是否命中：字符串按子串、正则按 test */
function hit(text, pat) {
  return pat instanceof RegExp ? pat.test(text) : text.includes(pat);
}

/**
 * 考点级报告校验。
 * - must 未命中 → 漏检（按该考点的 level 上报）
 * - forbid 命中 → 反向断言（一律 high）：模型给出了与事实相反的结论，比单纯漏检更危险，
 *   会让评审人误信"无缺项/工程量未改动"而放过废标线索。
 */
function checkReport(group, report, checks) {
  const res = { total: checks.length, passed: 0, missed: [], contradicted: [] };
  for (const ck of checks) {
    const missed = (ck.must || []).filter(pat => !hit(report, pat));
    const badHits = (ck.forbid || []).filter(pat => hit(report, pat));
    if (missed.length) {
      res.missed.push(ck.id);
      issue(group, ck.level || 'high', `考点未命中：${ck.desc}`, `报告中未出现：${missed.map(String).join(' / ')}`);
    }
    if (badHits.length) {
      res.contradicted.push(ck.id);
      issue(group, 'high', `反向断言：${ck.desc}`, `报告给出与事实相反的结论，命中禁用表述：${badHits.map(String).join(' / ')}`);
    }
    if (!missed.length && !badHits.length) res.passed++;
  }
  if (res.passed === res.total && res.total) ok(`考点全部命中（${res.total}/${res.total}）`);
  else log(`考点命中 ${res.passed}/${res.total}｜漏检 ${res.missed.length} 项｜反向断言 ${res.contradicted.length} 项`);
  return res;
}

let TOKEN = '';
async function api(method, p, opts = {}) {
  const { json, form, timeoutMs = 180000, binary } = opts;
  const headers = {};
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (form) body = form;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + p, { method, headers, body, signal: ctrl.signal });
    const ct = res.headers.get('content-type') || '';
    let data;
    if (binary) data = Buffer.from(await res.arrayBuffer());
    else if (ct.includes('json')) { try { data = await res.json(); } catch { data = null; } }
    else data = await res.text();
    return { status: res.status, ok: res.ok, data, ct, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, ok: false, error: e.name === 'AbortError' ? `请求超时(${timeoutMs}ms)` : e.message, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

async function uploadFiles(group, fileNames, label) {
  const fd = new FormData();
  fd.append('project_id', ''); // 清标资料不绑定项目
  for (const fn of fileNames) {
    const abs = path.join(SAMPLES, G[group].dir, fn);
    if (!fs.existsSync(abs)) throw new Error(`样本文件不存在: ${abs}`);
    fd.append('files', new Blob([fs.readFileSync(abs)]), fn);
  }
  const r = await api('POST', '/api/audit/documents/upload', { form: fd, timeoutMs: 300000 });
  if (!r.ok) throw new Error(`上传失败[${label}] HTTP ${r.status}: ${r.data?.error || r.error || JSON.stringify(r.data)}`);
  const docs = r.data?.documents || [];
  if (!docs.length) throw new Error(`上传返回无 documents[${label}]`);
  for (const d of docs) {
    if (d.project_id !== null && d.project_id !== undefined && d.project_id !== '') {
      issue(group, 'medium', '资料被意外绑定到项目', `${d.file_name} project_id=${d.project_id}`);
    }
  }
  return docs;
}

async function waitParse(group, docIds, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < PARSE_TIMEOUT_MS) {
    const stats = [];
    for (const id of docIds) {
      const r = await api('GET', `/api/audit/documents/${id}`);
      stats.push(r.ok ? { id, status: r.data.parse_status, err: r.data.parse_error || r.data.error_msg } : { id, status: 'ERROR' });
    }
    const done = stats.filter(s => s.status === 'done').length;
    const failed = stats.filter(s => s.status === 'failed' || s.status === 'ERROR');
    process.stdout.write(`\r${C.d}${ts()}${C.x}   ${label}: ${done}/${stats.length} 已解析${failed.length ? ` ${C.r}(${failed.length} 失败)${C.x}` : ''}   `);
    if (failed.length) {
      console.log('');
      for (const f of failed) issue(group, 'high', '解析失败', `doc=${f.id} status=${f.status} ${f.err || ''}`);
      return stats;
    }
    if (done === stats.length) { console.log(''); return stats; }
    await sleep(6000);
  }
  console.log('');
  issue(group, 'high', '解析超时', `${label} 超过 ${PARSE_TIMEOUT_MS / 1000}s 未全部完成`);
  return null;
}

async function pollSession(group, sessionId, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ANALYZE_TIMEOUT_MS) {
    const r = await api('GET', `/api/audit/bid-clearing/sessions/${sessionId}`);
    if (!r.ok) { issue(group, 'high', '查询任务详情失败', `HTTP ${r.status} ${r.data?.error || ''}`); return null; }
    const st = r.data.status;
    process.stdout.write(`\r${C.d}${ts()}${C.x}   ${label}: status=${st}   `);
    if (st === 'done' || st === 'failed') { console.log(''); return r.data; }
    await sleep(5000);
  }
  console.log('');
  issue(group, 'high', '分析超时', `${label} 超过 ${ANALYZE_TIMEOUT_MS / 1000}s 未结束`);
  return null;
}

// ---------- 主流程 ----------
async function runGroup(g) {
  const cfg = G[g];
  if (!cfg) { issue(g, 'high', '未知分组', g); return; }
  log(`${C.c}========== 第 ${g} 组：${cfg.title} ==========${C.x}`);
  const gr = REPORT.groups[g] = { title: cfg.title, steps: {} };
  const t0 = Date.now();

  // 1. 建任务
  const s = await api('POST', '/api/audit/bid-clearing/sessions', { json: { title: cfg.title } });
  if (!s.ok) { issue(g, 'high', '建任务失败', `HTTP ${s.status} ${s.data?.error || s.error}`); return; }
  const sessionId = s.data.id;
  ok(`任务已创建 id=${sessionId} status=${s.data.status}`);
  gr.steps.createSession = { ok: true, id: sessionId };

  // 2. 招标控制价
  const ctrlDocs = await uploadFiles(g, [cfg.control], '控制价');
  ok(`控制价上传成功：${ctrlDocs[0].file_name} (id=${ctrlDocs[0].id})`);
  const setC = await api('PUT', `/api/audit/bid-clearing/sessions/${sessionId}/control`, { json: { document_id: ctrlDocs[0].id } });
  if (!setC.ok) issue(g, 'high', '挂接控制价失败', `HTTP ${setC.status} ${setC.data?.error || setC.error}`);
  else ok('控制价已挂接');

  // 3. 各投标方
  const allDocIds = [ctrlDocs[0].id];
  for (const b of cfg.bidders) {
    const p = await api('POST', `/api/audit/bid-clearing/sessions/${sessionId}/parties`, { json: { party_name: b.name } });
    if (!p.ok) { issue(g, 'high', `新增投标方失败: ${b.name}`, `HTTP ${p.status} ${p.data?.error || p.error}`); continue; }
    const partyId = p.data.id;
    const docs = await uploadFiles(g, [b.file], b.name);
    allDocIds.push(docs[0].id);
    const at = await api('POST', `/api/audit/bid-clearing/parties/${partyId}/documents`, { json: { document_id: docs[0].id } });
    if (!at.ok) issue(g, 'high', `挂接报价失败: ${b.name}`, `HTTP ${at.status} ${at.data?.error || at.error}`);
    else ok(`投标方已就绪：${b.name}`);
  }

  // 4. 等全部解析
  const stats = await waitParse(g, allDocIds, '解析');
  if (!stats) return;
  ok(`全部解析完成（${allDocIds.length} 份）`);
  gr.steps.parse = { ok: true, docs: allDocIds.length };

  // 5. can_analyze 预检
  const pre = await api('GET', `/api/audit/bid-clearing/sessions/${sessionId}`);
  log(`can_analyze=${pre.data?.can_analyze}  control=${pre.data?.control?.parse_status}  parties=${pre.data?.parties?.length}`);
  gr.steps.precheck = { can_analyze: pre.data?.can_analyze, parties: pre.data?.parties?.length };
  if (!pre.data?.can_analyze) issue(g, 'high', '前置校验未通过', 'can_analyze=false，无法分析');

  // 6. 触发分析
  const a = await api('POST', `/api/audit/bid-clearing/sessions/${sessionId}/analyze`, { json: {} });
  if (!a.ok) { issue(g, 'high', '触发分析失败', `HTTP ${a.status} ${a.data?.error || a.error}`); return; }
  ok('分析已入队，等待模型返回…');

  // 7. 轮询
  const fin = await pollSession(g, sessionId, '分析');
  if (!fin) return;
  gr.steps.analyze = { status: fin.status, error: fin.error_msg || null };
  if (fin.status !== 'done') {
    issue(g, 'high', '分析未成功', `status=${fin.status} error=${fin.error_msg || ''}`);
    return;
  }
  const report = String(fin.report_md || '');
  ok(`分析完成：报告 ${report.length} 字，model=${fin.model_info || '-'}`);
  gr.steps.reportLength = report.length;

  // 8. 校验报告（考点级断言）
  const checkResult = checkReport(g, report, cfg.checks || []);
  gr.steps.checks = checkResult;
  gr.steps.reportLength = report.length;

  for (const name of cfg.bidders.map(b => b.name)) {
    if (!report.includes(name)) issue(g, 'low', '报告未提及某投标方', name);
  }

  // 落盘报告
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rp = path.join(OUT_DIR, `清标报告-第${g}组.md`);
  fs.writeFileSync(rp, report, 'utf8');
  log(`报告已保存: ${rp}`);

  gr.ms = Date.now() - t0;
  ok(`第 ${g} 组完成，用时 ${(gr.ms / 1000).toFixed(1)}s`);
}

(async () => {
  console.log(`${C.c}清标分析端到端测试${C.x}  base=${BASE}  组=${GROUPS.join(',')}`);
  const lr = await api('POST', '/api/auth/login', { json: { username: USERNAME, password: PASSWORD } });
  if (!lr.ok || !lr.data?.token) { bad(`登录失败: HTTP ${lr.status} ${lr.data?.error || lr.error}`); process.exit(1); }
  TOKEN = lr.data.token;
  ok(`登录成功 user=${lr.data.user?.username}`);

  for (const g of GROUPS) {
    try { await runGroup(g); }
    catch (e) { issue(g, 'high', '异常中断', e.message); }
  }

  REPORT.finishedAt = new Date().toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jp = path.join(OUT_DIR, `bid-clearing-report-${Date.now()}.json`);
  fs.writeFileSync(jp, JSON.stringify(REPORT, null, 2), 'utf8');

  console.log('');
  console.log(`${C.c}=== 汇总 ===${C.x}`);
  for (const [g, v] of Object.entries(REPORT.groups)) console.log(`  第${g}组: ${v.steps?.analyze?.status || '未完成'}  ${v.ms ? (v.ms / 1000).toFixed(1) + 's' : ''}`);
  const highs = REPORT.issues.filter(i => i.level === 'high');
  console.log(`  问题: high=${highs.length} total=${REPORT.issues.length}`);
  console.log(`  报告: ${jp}`);
  process.exit(highs.length ? 2 : 0);
})();
