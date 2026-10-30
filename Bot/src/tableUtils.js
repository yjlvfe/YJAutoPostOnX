'use strict';

const escapeHtml = text => String(text ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');
const clean = value => String(value ?? '').replace(/[\r\n\t\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\|/g, '¦').slice(0, 48);

function visualWidth(str) {
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code >= 0x0600 && code <= 0x06FF) w += 1;
    else if (code >= 0x1F300 && code <= 0x1F9FF) w += 2;
    else w += 1;
  }
  return w;
}

function padCell(str, width, align = 'left') {
  const pad = Math.max(0, width - visualWidth(str));
  if (align === 'right') return ' '.repeat(pad) + str;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return ' '.repeat(left) + str + ' '.repeat(right);
  }
  return str + ' '.repeat(pad);
}

function preTable(headers, rows, caption = '') {
  const cleanedHeaders = headers.map(clean);
  const cleanedRows = rows.map(r => r.map(clean));
  const allRows = [cleanedHeaders, ...cleanedRows];
  
  const colCount = headers.length;
  const widths = Array(colCount).fill(0);
  for (const row of allRows) {
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(widths[c], visualWidth(row[c] || ''));
    }
  }

  const top = '┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
  const mid = '├' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '└' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';

  const formatLine = (row, isHeader = false) => {
    const cells = row.map((cell, c) => {
      const align = isHeader ? 'center' : (colCount === 2 && c === 0 ? 'right' : 'center');
      return ' ' + padCell(cell, widths[c], align) + ' ';
    });
    return '│' + cells.join('│') + '│';
  };

  const lines = [top, formatLine(cleanedHeaders, true), mid];
  for (const row of cleanedRows) {
    lines.push(formatLine(row, false));
  }
  lines.push(bot);

  const title = clean(caption);
  return `${title ? `<b>📊 ${escapeHtml(title)}</b>\n` : ''}<pre><code>${lines.join('\n')}</code></pre>`;
}

module.exports = { preTable, escapeHtml, clean };
