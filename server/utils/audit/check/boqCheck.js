/**
 * 核对程序一：清单 ↔ 结算（控制价）跨页表勾稽
 * 左方 = Excel 分部分项清单计价表；右方 = PDF/图片中锚点含"分部分项工程量清单与计价"的跨页表。
 * 按清单编码（12 位）首次出现为主项行建索引，逐项比工程量 / 综合单价 / 合价，落 audit_check_program + audit_check_item。
 */
const db = require('../../../db');
const snowflake = require('../../snowflake');
const { htmlTableToRows, locateColumns, toNumber, cleanCell } = require('../agent/tableUtils');

const CODE_RE = /\d{9,13}/;
const EPS = 0.01;          // 金额绝对容差
const QTY_REL = 0.01;      // 工程量相对容差 1%

/** 从一组 table 要素抽取清单项（首次出现编码即主项，跨页继承的定额子目行丢弃） */
function extractLines(els, side) {
  const out = [];
  for (const el of els) {
    const { rows } = htmlTableToRows(el.content_md || '');
    if (!rows.length) continue;
    const { columns } = locateColumns(rows);
    if (!columns.code || !columns.name) continue;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [];
      const rawCode = cleanCell(row[columns.code] || '').replace(/\s/g, '');
      const m = rawCode.match(CODE_RE);
      if (!m) continue;
      const code = m[0];
      out.push({
        code,
        name: cleanCell(row[columns.name] || '').replace(/\s+/g, ' ').slice(0, 80),
        unit: cleanCell(row[columns.unit] || ''),
        qty: columns.qty != null ? toNumber(row[columns.qty]) : null,
        price: columns.price != null ? toNumber(row[columns.price]) : null,
        amount: columns.amount != null ? toNumber(row[columns.amount]) : null,
        side,
        elementId: String(el.id),
        docId: String(el.docId),
        pageNo: el.page_no,
        sheetName: el.sheet_name || null,
      });
    }
  }
  // 首次出现即主项
  const map = new Map();
  for (const l of out) if (!map.has(l.code)) map.set(l.code, l);
  return [...map.values()];
}

function near(a, b) {
  if (a == null || b == null) return null;
  return Math.abs(a - b) <= EPS;
}

/** 运行核对，落库，返回 {programId, summary} */
async function runBoqCheck(projectId, userId) {
  // 两侧要素
  // 左：Excel 清单底稿；右：PDF/图片中的跨页结算（控制价）表。
  // 右方表名措辞因项目而异（分部分项工程结算表 / 分部分项工程量清单计价表 / E.1 分部分项工程量清单与计价表 …），
  // 若只认单一措辞会让右方恒为空、核对退化成"全部差异"，故放宽为「含"分部分项"且含 计价/结算/清单 之一」。
  const [xls] = await db.query(
    "SELECT id, document_id docId, sheet_name sheetName, page_no pageNo, content_md content_md FROM audit_element WHERE project_id=? AND element_type='table' AND sheet_name LIKE '%分部分项%'",
    [projectId]);
  const [pdf] = await db.query(
    `SELECT id, document_id docId, sheet_name sheetName, page_no pageNo, content_md content_md FROM audit_element
      WHERE project_id=? AND element_type='table'
        AND anchor_label LIKE '%分部分项%'
        AND (anchor_label LIKE '%计价%' OR anchor_label LIKE '%结算%' OR anchor_label LIKE '%清单%')`,
    [projectId]);
  if (!xls.length && !pdf.length) {
    const e = new Error('未在资料中识别到"分部分项"清单/结算表，请先完成资料解析'); e.status = 400; throw e;
  }

  const left = extractLines(xls, 'left');
  const right = extractLines(pdf, 'right');
  const lmap = new Map(left.map(l => [l.code, l]));
  const rmap = new Map(right.map(l => [l.code, l]));

  // 资料名映射（证据用）
  const [docs] = await db.query('SELECT id, file_name FROM audit_document WHERE project_id=?', [projectId]);
  const docName = {}; docs.forEach(d => { docName[String(d.id)] = d.file_name; });

  const leftLabel = xls.length ? 'Excel 清单' : '清单资料';
  const rightLabel = pdf.length ? '结算/控制价资料' : '结算资料';

  // 重跑即覆盖：软删同项目同类型旧记录
  const [oldProgs] = await db.query("SELECT id FROM audit_check_program WHERE project_id=? AND program_type='boq_settlement' AND del_flag=0", [projectId]);
  for (const o of oldProgs) await db.query("UPDATE audit_check_item SET del_flag=1 WHERE program_id=?", [o.id]);
  await db.query("UPDATE audit_check_program SET del_flag=1 WHERE project_id=? AND program_type='boq_settlement' AND del_flag=0", [projectId]);

  const programId = String(snowflake.nextId());
  await db.query(
    "INSERT INTO audit_check_program (id, project_id, program_type, program_name, status, created_by) VALUES (?,?,?,?,?,?)",
    [programId, projectId, 'boq_settlement', '清单↔结算跨页表勾稽', 'running', userId]);

  const codes = new Set([...lmap.keys(), ...rmap.keys()]);
  let match = 0, diff = 0, unconfirmed = 0, onlyLeft = 0, onlyRight = 0;
  let totalDiffAmount = 0, totalIncrease = 0, totalDecrease = 0;
  const items = [];

  // 三态判定：一侧完全没有可比对数据时不给"差异"结论。
  // 缺数据 ≠ 多计/少计，强行判差异会把"资料缺失"误报成"金额问题"，与审计结论的严肃性冲突。
  const comparable = left.length > 0 && right.length > 0;

  for (const code of codes) {
    const l = lmap.get(code), r = rmap.get(code);
    const item = {
      item_code: code,
      item_name: (l && l.name) || (r && r.name) || '',
      unit: (l && l.unit) || (r && r.unit) || '',
      left_label: leftLabel, right_label: rightLabel,
      qty_left: l ? l.qty : null, qty_right: r ? r.qty : null,
      price_left: l ? l.price : null, price_right: r ? r.price : null,
      amount_left: l ? l.amount : null, amount_right: r ? r.amount : null,
      diff_qty: null, diff_amount: null, conclusion: 'unconfirmed', diff_desc: null, suggestion: null,
      evidence: {
        left: l ? { docId: l.docId, fileName: docName[l.docId], pageNo: l.pageNo, sheetName: l.sheetName, elementId: l.elementId } : null,
        right: r ? { docId: r.docId, fileName: docName[r.docId], pageNo: r.pageNo, sheetName: r.sheetName, elementId: r.elementId } : null,
      },
    };

    if (!comparable) {
      unconfirmed++;
      item.conclusion = 'unconfirmed';
      item.diff_desc = left.length === 0
        ? `未从左方（${leftLabel}）提取到可比对的清单项，无法确认该编码是否存在差异`
        : `未从右方（${rightLabel}）提取到可比对的清单项，无法确认该编码是否存在差异`;
      item.suggestion = left.length === 0
        ? '补充或重新解析清单（Excel）资料后重新核对'
        : '补充或重新解析结算/控制价资料后重新核对';
      items.push(item);
      continue;
    }

    if (l && r) {
      // 两侧都命中编码，但关键数值一个都没解析出来 → 无法确认（不是"一致"）
      if (l.qty == null && r.qty == null && l.price == null && r.price == null && l.amount == null && r.amount == null) {
        unconfirmed++;
        item.conclusion = 'unconfirmed';
        item.diff_desc = '两侧均未解析出工程量/综合单价/合价，无法确认是否存在差异';
        item.suggestion = '提高原件清晰度或人工补录关键数值后重新核对';
        items.push(item);
        continue;
      }
      const qd = (l.qty != null && r.qty != null) ? l.qty - r.qty : null;
      const ad = (l.amount != null && r.amount != null) ? r.amount - l.amount : null;
      const qtyOk = qd == null || Math.abs(qd) <= Math.max(EPS, Math.abs(r.qty) * QTY_REL);
      const priceOk = near(l.price, r.price) !== false || (l.price == null || r.price == null);
      const amtOk = near(l.amount, r.amount) !== false || (l.amount == null || r.amount == null);
      item.diff_qty = qd;
      item.diff_amount = ad;
      if (qtyOk && priceOk && amtOk) {
        item.conclusion = 'match'; match++;
      } else {
        item.conclusion = 'diff'; diff++;
        const parts = [];
        if (!qtyOk) parts.push(`工程量 ${l.qty} vs ${r.qty}（差 ${qd}）`);
        if (priceOk === false) parts.push(`综合单价 ${l.price} vs ${r.price}`);
        if (amtOk === false) parts.push(`合价 ${l.amount} vs ${r.amount}（差 ${ad}）`);
        item.diff_desc = parts.join('；');
        item.suggestion = '核对该清单项工程量/单价/合价差异原因，确认是否多计少计';
        if (ad != null) { totalDiffAmount += Math.abs(ad); if (ad > 0) totalIncrease += ad; else totalDecrease += -ad; }
      }
    } else if (l) {
      onlyLeft++;
      item.conclusion = 'diff'; diff++;
      item.diff_desc = `右方（${rightLabel}）未见该编码清单项，左方有金额 ${l.amount}`;
      item.suggestion = '核实是否右方漏项或左方多计';
    } else {
      onlyRight++;
      item.conclusion = 'diff'; diff++;
      item.diff_desc = `左方（${leftLabel}）未见该编码清单项，右方有金额 ${r.amount}`;
      item.suggestion = '核实是否左方清单遗漏（如漏计单位工程）';
    }

    items.push(item);
  }

  // 批量落明细
  for (const it of items) {
    await db.query(
      `INSERT INTO audit_check_item
       (id, program_id, project_id, item_code, item_name, unit, left_label, right_label,
        qty_left, qty_right, price_left, price_right, amount_left, amount_right,
        diff_qty, diff_amount, conclusion, diff_desc, evidence_json, suggestion, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [String(snowflake.nextId()), programId, projectId, it.item_code, it.item_name, it.unit, it.left_label, it.right_label,
        it.qty_left, it.qty_right, it.price_left, it.price_right, it.amount_left, it.amount_right,
        it.diff_qty, it.diff_amount, it.conclusion, it.diff_desc, JSON.stringify(it.evidence), it.suggestion, userId]);
  }

  const summary = {
    total: items.length, match, diff, unconfirmed, onlyLeft, onlyRight,
    totalDiffAmount: Math.round(totalDiffAmount * 100) / 100,
    totalIncrease: Math.round(totalIncrease * 100) / 100,
    totalDecrease: Math.round(totalDecrease * 100) / 100,
    leftLabel, rightLabel,
    leftCount: left.length, rightCount: right.length,
  };
  await db.query("UPDATE audit_check_program SET status='done', summary_json=? WHERE id=?", [JSON.stringify(summary), programId]);
  return { programId, summary };
}

module.exports = { runBoqCheck, extractLines };
