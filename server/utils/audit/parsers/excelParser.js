/**
 * Excel 解析器（xlsx 库）
 * 保留每个工作表的原始数值（审计数字核对）与格式化文本，输出 HTML 表格与证据要素
 * 证据粒度：工作表 → 单元格区域（sheet_name + 单元格地址）
 */
const XLSX = require('xlsx');

function escHtml(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** AOA 二维数组转 HTML 表格 */
function aoaToHtml(aoa, merges) {
  if (!Array.isArray(aoa) || aoa.length === 0) return '<table></table>';
  // 合并单元格映射：起点 → {rs, cs}
  const mergeMap = {};
  const skipSet = new Set();
  (merges || []).forEach(m => {
    mergeMap[`${m.s.r}_${m.s.c}`] = { rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 };
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r !== m.s.r || c !== m.s.c) skipSet.add(`${r}_${c}`);
      }
    }
  });

  const maxCols = aoa.reduce((mx, row) => Math.max(mx, Array.isArray(row) ? row.length : 0), 0);
  let html = '<table border="1" cellspacing="0" cellpadding="4">';
  aoa.forEach((row, r) => {
    html += '<tr>';
    for (let c = 0; c < maxCols; c++) {
      const key = `${r}_${c}`;
      if (skipSet.has(key)) continue;
      const m = mergeMap[key];
      const attrs = m ? ` rowspan="${m.rs}" colspan="${m.cs}"` : '';
      const val = Array.isArray(row) ? row[c] : '';
      const tag = r === 0 ? 'th' : 'td';
      html += `<${tag}${attrs} data-rc="${XLSX.utils.encode_cell({ r, c })}">${escHtml(val)}</${tag}>`;
    }
    html += '</tr>';
  });
  html += '</table>';
  return html;
}

/**
 * @param {string} filePath 本地文件路径
 * @returns {{kind:'excel', sheetCount:number, sheets:Array, elements:Array, markdownText:string}}
 */
function parseExcel(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true, cellNF: true, cellText: false });
  const sheets = [];
  const elements = [];
  const mdParts = [];

  wb.SheetNames.forEach((name, idx) => {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) {
      sheets.push({ name, index: idx, rowCount: 0, colCount: 0, range: '', aoa: [], aoaText: [], html: '<table></table>', merges: [] });
      return;
    }
    const range = XLSX.utils.decode_range(ws['!ref']);
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    const aoaText = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    const merges = ws['!merges'] || [];
    const html = aoaToHtml(aoaText, merges);
    sheets.push({
      name,
      index: idx,
      rowCount: range.e.r - range.s.r + 1,
      colCount: range.e.c - range.s.c + 1,
      range: ws['!ref'],
      aoa,
      aoaText,
      html,
      merges: merges.map(m => ({
        s: XLSX.utils.encode_cell(m.s),
        e: XLSX.utils.encode_cell(m.e)
      }))
    });
    mdParts.push(`## 工作表：${name}\n\n${html}`);
    elements.push({
      pageNo: idx + 1,
      sheetName: name,
      elementType: 'table',
      content: html,
      anchorLabel: `工作表「${name}」（${ws['!ref']}，${range.e.r - range.s.r + 1}行×${range.e.c - range.s.c + 1}列）`,
      bbox: { sheet: name, range: ws['!ref'], kind: 'sheet' }
    });
  });

  return {
    kind: 'excel',
    sheetCount: sheets.length,
    sheets,
    elements,
    markdownText: mdParts.join('\n\n')
  };
}

module.exports = { parseExcel, aoaToHtml };
