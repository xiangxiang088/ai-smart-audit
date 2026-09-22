/**
 * 核对结果 / 疑点台账 Excel 导出（含统计公式）
 * 输出：汇总、清单勾稽明细、签章核对、疑点台账 四个 sheet
 *
 * 疑点台账优先取规则扫描落库的 audit_finding（带风险分级与人工复核状态），
 * 尚无扫描结果时回退为「由核对差异临时归集」，保证导出链路在未扫描时也可用。
 */
const XLSX = require('xlsx');
const db = require('../../../db');

function evLoc(ev, side) {
  const e = ev && ev[side];
  if (!e) return '';
  const where = e.sheetName ? e.sheetName : (e.pageNo ? `第${e.pageNo}页` : '');
  return `${e.fileName || ''} ${where}`.trim();
}
function confCN(c) { return c === 'match' ? '一致' : c === 'diff' ? '差异/缺失' : '无法确认'; }

const RISK_CN = { high: '高', mid: '中', low: '低' };
const STATUS_CN = { open: '待核实', confirmed: '已核实属实', misreport: '误报', closed: '已关闭' };
const TYPE_CN = {
  no_seal: '签章异常/三无签证',
  no_photo: '缺少影像资料',
  qty_diff: '量差异常',
  round_amount: '凑整金额',
  late_visa: '集中/竣工后签证',
  duplicate: '重复计量',
  invoice_serial: '连号发票',
  other: '其他'
};

/** 疑点台账表头（列序与汇总公式的引用列保持一致：C=类型 F=金额 H=风险 I=状态） */
const FINDING_HEAD = ['序号', '来源程序', '疑点类型', '疑点描述', '审计建议', '金额(元)', '证据位置', '风险等级', '复核状态'];

async function buildChecksWorkbook(projectId) {
  const [proj] = await db.query('SELECT project_name FROM audit_project WHERE id=?', [projectId]);
  const [programs] = await db.query(
    "SELECT id, program_type, program_name, status, summary_json, created_at FROM audit_check_program WHERE project_id=? AND del_flag=0 ORDER BY id",
    [projectId]);
  const wb = XLSX.utils.book_new();

  // ---- 收集明细 ----
  const boqRows = [], visaRows = [], derivedFindingRows = [];
  for (const prg of programs) {
    const [items] = await db.query('SELECT * FROM audit_check_item WHERE program_id=? AND del_flag=0 ORDER BY FIELD(conclusion,"diff","unconfirmed","match"), item_code', [prg.id]);
    items.forEach(it => {
      let ev = {};
      try { ev = JSON.parse(it.evidence_json); } catch (e) {}
      if (prg.program_type === 'visa_evidence') {
        visaRows.push([it.item_code, it.item_name, confCN(it.conclusion), it.diff_desc || '', it.suggestion || '', evLoc(ev, 'left')]);
      } else {
        boqRows.push([
          it.item_code, it.item_name, it.unit || '',
          it.qty_left, it.qty_right, it.price_left, it.price_right, it.amount_left, it.amount_right,
          it.diff_qty, it.diff_amount, confCN(it.conclusion), it.diff_desc || '', it.suggestion || '',
          evLoc(ev, 'left'), evLoc(ev, 'right')
        ]);
      }
      if (it.conclusion === 'diff') {
        let type = '数据差异';
        if ((it.diff_desc || '').includes('未见该编码')) type = (it.diff_desc || '').startsWith('左方（') ? '右方有/左方漏项' : '左方有/右方缺失';
        else if (prg.program_type === 'visa_evidence') type = '签章/会签异常';
        derivedFindingRows.push([derivedFindingRows.length + 1, prg.program_name, type,
          (it.item_code + ' ' + (it.item_name || '')).replace(/\s+/g, ' '), it.suggestion || '',
          it.amount_right != null ? Number(it.amount_right) : (it.diff_amount != null ? Math.abs(Number(it.diff_amount)) : ''),
          evLoc(ev, 'left') || evLoc(ev, 'right'), '中', '待核实']);
      }
    });
  }

  // ---- 疑点台账：优先 audit_finding（规则扫描 + 人工复核状态）----
  const [fRows] = await db.query(
    `SELECT * FROM audit_finding WHERE project_id=? AND del_flag=0
      ORDER BY FIELD(risk_level,'high','mid','low'), id DESC`, [projectId]);
  let findingRows;
  if (fRows.length) {
    findingRows = fRows.map((f, i) => {
      let ev = {};
      try { ev = JSON.parse(f.evidence_json || '{}'); } catch (e) {}
      const amt = typeof ev.amount === 'number' ? ev.amount : '';
      const loc = [evLoc(ev, 'left'), evLoc(ev, 'right')].filter(Boolean).join(' / ');
      return [i + 1,
        f.source === 'check' ? '核对程序' : '规则扫描',
        TYPE_CN[f.finding_type] || f.finding_type,
        String(f.description || f.title || '').slice(0, 3000),
        f.suggestion || '',
        amt, loc,
        RISK_CN[f.risk_level] || f.risk_level,
        STATUS_CN[f.status] || f.status];
    });
  } else {
    findingRows = derivedFindingRows;
  }
  const highCount = findingRows.filter(r => r[7] === '高').length;
  const openCount = findingRows.filter(r => r[8] === '待核实').length;
  const qtyDiffCount = findingRows.filter(r => r[2] === '量差异常').length;

  // ---- 汇总 sheet（公式引用明细，可在 Excel 中复算）----
  const sumAoa = [
    ['工程审计智能审读 · 核对汇总台账'],
    ['项目名称', proj[0] ? proj[0].project_name : '', '生成时间', new Date().toLocaleString('zh-CN')],
    [],
    ['一、清单↔结算跨页表勾稽'],
    ['核对明细总项数', boqRows.length],
    ['其中：一致', { t: 'n', f: `COUNTIF('清单勾稽明细'!L:L,"一致")`, v: boqRows.filter(r => r[11] === '一致').length }],
    ['其中：差异/缺失', { t: 'n', f: `COUNTIF('清单勾稽明细'!L:L,"差异/缺失")`, v: boqRows.filter(r => r[11] === '差异/缺失').length }],
    [],
    ['二、签证/合同三方签章核对'],
    ['核对项数（签署页×三方）', visaRows.length],
    ['签章/会签异常数', { t: 'n', f: `COUNTIF('签章核对'!C:C,"差异/缺失")`, v: visaRows.filter(r => r[2] === '差异/缺失').length }],
    [],
    ['三、疑点台账'],
    ['疑点总数', { t: 'n', f: `COUNTA('疑点台账'!A:A)-1`, v: findingRows.length }],
    ['其中：高风险', { t: 'n', f: `COUNTIF('疑点台账'!H:H,"高")`, v: highCount }],
    ['其中：量差异常', { t: 'n', f: `COUNTIF('疑点台账'!C:C,"量差异常")`, v: qtyDiffCount }],
    ['待核实数', { t: 'n', f: `COUNTIF('疑点台账'!I:I,"待核实")`, v: openCount }],
    ['疑点涉及金额合计（元）', { t: 'n', f: `SUM('疑点台账'!F:F)`, v: findingRows.reduce((s, r) => s + (Number(r[5]) || 0), 0) }],
    [],
    ['说明：本表由工程审计智能审读 Agent 依据 PaddleOCR-VL 识别结果与 Seed 大模型核对自动生成，每条疑点均可在系统中点"原件"溯源到文件页码；金额与结论以原件为准，需人工复核确认。'],
  ];
  const wsSum = XLSX.utils.aoa_to_sheet(sumAoa);
  wsSum['!cols'] = [{ wch: 30 }, { wch: 20 }, { wch: 16 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsSum, '汇总');

  // ---- 清单勾稽明细 ----
  const boqHead = ['清单编码', '项目名称', '单位', '左工程量', '右工程量', '左综合单价', '右综合单价', '左合价', '右合价', '工程量差(左-右)', '合价差(右-左)', '结论', '差异说明', '审计建议', '左证据', '右证据'];
  const wsBoq = XLSX.utils.aoa_to_sheet([boqHead, ...boqRows]);
  wsBoq['!cols'] = [{ wch: 14 }, { wch: 34 }, { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 12 }, { wch: 13 }, { wch: 13 }, { wch: 10 }, { wch: 30 }, { wch: 26 }, { wch: 26 }, { wch: 26 }];
  XLSX.utils.book_append_sheet(wb, wsBoq, '清单勾稽明细');

  // ---- 签章核对 ----
  const visaHead = ['文件·签署页', '核对方', '结论', '说明', '审计建议', '证据位置'];
  const wsVisa = XLSX.utils.aoa_to_sheet([visaHead, ...visaRows]);
  wsVisa['!cols'] = [{ wch: 26 }, { wch: 24 }, { wch: 10 }, { wch: 44 }, { wch: 34 }, { wch: 26 }];
  XLSX.utils.book_append_sheet(wb, wsVisa, '签章核对');

  // ---- 疑点台账 ----
  const wsF = XLSX.utils.aoa_to_sheet([FINDING_HEAD, ...findingRows]);
  wsF['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 20 }, { wch: 70 }, { wch: 34 }, { wch: 13 }, { wch: 30 }, { wch: 10 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsF, '疑点台账');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fileName = `审计核对台账_${proj[0] ? proj[0].project_name : ''}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  return { buf, fileName, findingCount: findingRows.length, highCount, openCount };
}

module.exports = { buildChecksWorkbook, TYPE_CN, RISK_CN, STATUS_CN };
