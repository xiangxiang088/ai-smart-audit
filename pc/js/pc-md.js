/* ---------------- 轻量 Markdown 渲染（共享：智能问答 / 清标分析） ----------------
 * 先 esc() 转义防 XSS，再做行内替换；GFM 管道表格 / 标题 / 列表 / 段落。
 * 依赖 common.js 的 esc()。
 */
function inlineMd(s) {
  // 证据角标 〔e1〕
  s = s.replace(/〔(e\d+)〕/g, (m, eid) => `<sup class="cite" data-eid="${eid}" title="点击查看证据来源">${eid.slice(1)}</sup>`);
  // 粗体
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 行内代码
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function renderTable(lines) {
  const rows = lines.map(l => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim()));
  const head = rows[0] || [];
  const body = rows.slice(2);
  return '<div class="au-md-table"><table><thead><tr>' +
    head.map(h => `<th>${inlineMd(esc(h))}</th>`).join('') + '</tr></thead><tbody>' +
    body.map(r => '<tr>' + head.map((_, i) => `<td>${inlineMd(esc(r[i] || ''))}</td>`).join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

function isTableSep(l) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-') && l.includes('|');
}

function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;
  let listType = null;
  const closeList = () => { if (listType) { html.push(listType === 'ul' ? '</ul>' : '</ol>'); listType = null; } };

  while (i < lines.length) {
    const l = lines[i];
    // 表格块
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const block = [];
      while (i < lines.length && lines[i].includes('|')) { block.push(lines[i]); i++; }
      html.push(renderTable(block));
      continue;
    }
    if (!l.trim()) { closeList(); i++; continue; }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const lv = h[1].length;
      html.push(`<h${lv + 1}>${inlineMd(esc(h[2]))}</h${lv + 1}>`);
      i++; continue;
    }
    const ul = l.match(/^\s*[-*]\s+(.*)$/);
    const ol = l.match(/^\s*\d+[.、]\s*(.*)$/);
    if (ul) {
      if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
      html.push('<li>' + inlineMd(esc(ul[1])) + '</li>');
      i++; continue;
    }
    if (ol) {
      if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
      html.push('<li>' + inlineMd(esc(ol[1])) + '</li>');
      i++; continue;
    }
    closeList();
    html.push('<p>' + inlineMd(esc(l)) + '</p>');
    i++;
  }
  closeList();
  return html.join('');
}
