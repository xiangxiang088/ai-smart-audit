/**
 * 审计表格工具：把 OCR/Excel 产出的 HTML <table> 解析为行列矩阵，
 * 正确处理 rowspan / colspan（工程清单表大量使用合并表头），并提供按列取值/数值清洗。
 */

/** HTML 实体与空白归一化 */
function cleanCell(html) {
  return String(html == null ? '' : html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ ]+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * HTML 表格 → 二维矩阵（含合并单元格展开）
 * @param {string} html
 * @returns {{rows:Array<Array<string>>, rowCount:number, colCount:number}}
 */
function htmlTableToRows(html) {
  if (!html || !/<table/i.test(html)) return { rows: [], rowCount: 0, colCount: 0 };
  const tableHtml = html.match(/<table[\s\S]*?<\/table>/i)?.[0] || html;
  const trList = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const grid = []; // 稀疏网格，rowspan/colspan 用占位符填充
  const OCC = { __occ: true };

  trList.forEach((trHtml, r) => {
    if (!grid[r]) grid[r] = [];
    let c = 0;
    const cells = trHtml.match(/<(td|th)[\s\S]*?<\/\1>/gi) || [];
    cells.forEach((cellHtml) => {
      while (grid[r][c] === OCC || (grid[r][c] && grid[r][c].__occ)) c++;
      const rs = Math.max(1, parseInt((cellHtml.match(/rowspan\s*=\s*["']?(\d+)/i) || [])[1], 10) || 1);
      const cs = Math.max(1, parseInt((cellHtml.match(/colspan\s*=\s*["']?(\d+)/i) || [])[1], 10) || 1);
      const text = cleanCell(cellHtml);
      for (let dr = 0; dr < rs; dr++) {
        for (let dc = 0; dc < cs; dc++) {
          const rr = r + dr, cc = c + dc;
          if (!grid[rr]) grid[rr] = [];
          grid[rr][cc] = dr === 0 && dc === 0 ? text : OCC;
        }
      }
      c += cs;
    });
  });

  // 规整为矩形矩阵，占位符向上/向左继承真实值（合并单元格语义=同值）
  const rows = [];
  const colCount = grid.reduce((m, row) => Math.max(m, row.length), 0);
  grid.forEach((row, r) => {
    const out = [];
    for (let c = 0; c < colCount; c++) {
      let v = row[c];
      if (v === undefined || (v && v.__occ)) {
        // 向上继承（rowspan）
        v = r > 0 ? rows[r - 1][c] : '';
      }
      out.push(typeof v === 'string' ? v : '');
    }
    rows.push(out);
  });
  return { rows, rowCount: rows.length, colCount };
}

/** 从文本中解析数值（去掉千分位、单位、货币符号；括号表示负数） */
function toNumber(text) {
  if (text == null) return null;
  let s = String(text).trim();
  if (!s) return null;
  let neg = false;
  if (/^[（(].*[)）]$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[,，]/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!s) return null;
  const n = parseFloat(s[0]);
  if (Number.isNaN(n)) return null;
  return neg ? -n : n;
}

/**
 * 在矩阵中定位表头行与关键列
 * @param {string[][]} rows
 * @param {string[]} nameKeywords 名称列关键词，如 ['名称','项目名称','分项']
 * @param {string[]} codeKeywords 编码列，如 ['编码','序号','清单编码']
 * @returns {{headerRow:number, columns:Object}}
 */
function locateColumns(rows, nameKeywords = [], codeKeywords = []) {
  const result = { headerRow: -1, columns: {} };
  const joined = rows.map(r => r.join('|'));
  // 找同时包含最多关键词的行作为表头
  let best = -1, bestScore = 0;
  rows.forEach((row, i) => {
    if (i > Math.min(8, rows.length - 1)) return;
    let score = 0;
    const map = {};
    row.forEach((cell, c) => {
      const t = String(cell).replace(/\s/g, '');
      if (/序号|编号|编码/.test(t)) { map.code = c; score++; }
      // 名称列只认"名称/分项/子目"，避免"标段：…项目"等页眉串误命中
      if (/名称|分项名称|子目|项目名称/.test(t)) { map.name = c; score++; }
      if (/单位/.test(t)) { map.unit = c; score++; }
      if (/工程量|数量/.test(t)) { map.qty = c; score++; }
      if (/综合单价|单价/.test(t)) { map.price = c; score++; }
      if (/合价|金额|总价/.test(t)) { map.amount = c; score++; }
    });
    if (score > bestScore) { bestScore = score; best = i; result.columns = map; }
  });
  result.headerRow = best;
  if (nameKeywords.length || codeKeywords.length) {
    // 预留：按调用方关键词进一步纠偏
  }
  return result;
}

/** 矩阵转 CSV（便于导出/喂给模型） */
function rowsToCsv(rows) {
  return rows.map(r => r.map(c => {
    const s = String(c == null ? '' : c).replace(/\s*\n\s*/g, ' ');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
}

module.exports = { cleanCell, htmlTableToRows, toNumber, locateColumns, rowsToCsv };
