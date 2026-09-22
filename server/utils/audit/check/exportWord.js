/**
 * Word 审计发现清单导出（.docx）
 * 正式文书风格：项目信息 → 结论概述 → 疑点清单表 → 清单勾稽结果 → 签章核对结果 → 复核说明
 */
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, BorderStyle
} = require('docx');
const db = require('../../../db');

const FONT = '仿宋';
const AUDIT_TYPE_CN = { cost: '工程造价审计', settlement: '工程结算审计', completion: '竣工决算审计', financial: '财务审计', engineering: '工程审计' };
function auditTypeCN(v) { return AUDIT_TYPE_CN[v] || v || '工程审计'; }
const border = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
const cellBorders = { top: border, bottom: border, left: border, right: border };

function p(text, opts = {}) {
  return new Paragraph({
    alignment: opts.align,
    spacing: { after: opts.after != null ? opts.after : 120, line: 320 },
    children: [new TextRun({ text: String(text == null ? '' : text), bold: !!opts.bold, size: opts.size || 24, font: FONT, color: opts.color })],
  });
}
function heading(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 120 },
    children: [new TextRun({ text, bold: true, size: 28, font: FONT })] });
}
function cell(text, opts = {}) {
  return new TableCell({
    borders: cellBorders,
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    shading: opts.head ? { fill: 'E8EEF7' } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: String(text == null ? '' : text), bold: !!opts.head, size: 20, font: FONT, color: opts.color })] })],
  });
}
function row(cells, head) {
  return new TableRow({ tableHeader: !!head, children: cells });
}

function evLoc(ev, side) {
  const e = ev && ev[side];
  if (!e) return '';
  const where = e.sheetName ? e.sheetName : (e.pageNo ? `第${e.pageNo}页` : '');
  return `${e.fileName || ''} ${where}`.trim();
}

async function buildFindingsDocx(projectId) {
  const [projRows] = await db.query('SELECT * FROM audit_project WHERE id=?', [projectId]);
  const proj = projRows[0] || {};
  const [programs] = await db.query(
    "SELECT id, program_type, program_name, summary_json, created_at FROM audit_check_program WHERE project_id=? AND del_flag=0 ORDER BY id", [projectId]);

  const findings = [];
  let boqSummary = null, visaSummary = null;
  for (const prg of programs) {
    let s = {}; try { s = JSON.parse(prg.summary_json); } catch (e) {}
    if (prg.program_type === 'boq_settlement') boqSummary = s;
    if (prg.program_type === 'visa_evidence') visaSummary = s;
    const [items] = await db.query("SELECT * FROM audit_check_item WHERE program_id=? AND del_flag=0 AND conclusion='diff' ORDER BY item_code", [prg.id]);
    for (const it of items) {
      let ev = {}; try { ev = JSON.parse(it.evidence_json); } catch (e) {}
      let type = '数据差异';
      if (prg.program_type === 'visa_evidence') type = '签章/会签异常';
      else if ((it.diff_desc || '').includes('未见该编码')) type = (it.diff_desc || '').startsWith('左方（') ? '右方有/左方漏项' : '左方有/右方缺失';
      findings.push({
        src: prg.program_name, type,
        desc: `${it.item_code || ''} ${it.item_name || ''}`.trim() + (it.diff_desc ? `（${it.diff_desc}）` : ''),
        suggestion: it.suggestion || '',
        amount: it.amount_right != null ? Number(it.amount_right) : (it.diff_amount != null ? Math.abs(Number(it.diff_amount)) : null),
        evidence: evLoc(ev, 'left') || evLoc(ev, 'right'),
      });
    }
  }
  const totalAmount = findings.reduce((s, f) => s + (f.amount || 0), 0);

  const children = [];
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 },
    children: [new TextRun({ text: '工程审计发现清单', bold: true, size: 40, font: FONT })] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 },
    children: [new TextRun({ text: '（智能审读 · 供人工复核）', size: 22, font: FONT, color: '888888' })] }));

  // 项目信息表
  children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
    row([cell('项目名称', { head: true, width: 18 }), cell(proj.project_name || '', { width: 40 }), cell('审计类型', { head: true, width: 14 }), cell(auditTypeCN(proj.audit_type), { width: 28 })]),
    row([cell('项目编号', { head: true }), cell(proj.project_code || ''), cell('生成时间', { head: true }), cell(new Date().toLocaleString('zh-CN'))]),
  ] }));
  children.push(p(''));

  // 一、结论概述
  children.push(heading('一、审读结论概述'));
  if (boqSummary) {
    children.push(p(`清单↔结算跨页表勾稽：共比对清单项 ${boqSummary.total} 项，其中一致 ${boqSummary.match} 项，差异/缺失 ${boqSummary.diff} 项（右方有而左方漏 ${boqSummary.onlyRight || 0} 项，左方有而右方缺 ${boqSummary.onlyLeft || 0} 项）。`));
  }
  if (visaSummary) {
    children.push(p(`签证/合同三方签章核对：识别签署页 ${visaSummary.signPageCount || 0} 个、印章 ${visaSummary.rightCount || 0} 枚，建设/监理/施工三方逐项核对，签章或会签异常 ${visaSummary.diff} 项。`));
  }
  children.push(p(`本次智能审读共形成疑点 ${findings.length} 条，疑点涉及金额合计约 ${totalAmount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 元（以原件复核为准）。`, { bold: true }));

  // 二、疑点清单表
  children.push(heading('二、疑点发现清单'));
  const fRows = [row([
    cell('序号', { head: true, width: 6 }), cell('疑点类型', { head: true, width: 14 }),
    cell('疑点描述', { head: true, width: 40 }), cell('审计建议', { head: true, width: 22 }),
    cell('涉及金额(元)', { head: true, width: 10 }), cell('证据位置', { head: true, width: 8 })], true)];
  findings.forEach((f, i) => {
    fRows.push(row([
      cell(i + 1), cell(f.type), cell(f.desc), cell(f.suggestion),
      cell(f.amount != null ? f.amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—'),
      cell(f.evidence)]));
  });
  if (!findings.length) fRows.push(row([cell('未发现疑点', { width: 100 })]));
  children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: fRows }));

  // 三、复核说明
  children.push(heading('三、复核与取证说明'));
  children.push(p('1. 本清单由工程审计智能审读 Agent 依据 PaddleOCR-VL 对 PDF/图片/Excel/Word 的版面、跨页表格与印章识别结果，结合 Seed 大模型逐项勾稽自动生成。'));
  children.push(p('2. 每条疑点均可在系统「疑点台账 / 核对程序」中点击"原件"溯源到具体文件、页码与表格位置，建议审计人员结合原件与现场情况复核确认后再行定性。'));
  children.push(p('3. 智能审读结果为辅助线索，不替代审计人员的专业判断；"漏项/缺章"等结论需以书面资料和对方确认为准。'));

  const doc = new Document({
    sections: [{ properties: {}, children }],
    styles: { default: { document: { run: { font: FONT, size: 24 } } } },
  });
  const buf = await Packer.toBuffer(doc);
  const fileName = `审计发现清单_${proj.project_name || ''}_${new Date().toISOString().slice(0, 10)}.docx`;
  return { buf, fileName, findingCount: findings.length };
}

module.exports = { buildFindingsDocx };
