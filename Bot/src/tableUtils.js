'use strict';

const escapeHtml = text => String(text ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');
const clean = value => String(value ?? '').replace(/[\r\n\t\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\|/g, '¦').slice(0, 48);

function richTable(headers, rows, caption = '') {
  const parts = ['<table bordered compact>'];
  if (caption) parts.push(`<caption>${escapeHtml(clean(caption))}</caption>`);
  if (headers && headers.length) {
    parts.push('<tr>' + headers.map(h => `<th align="center">${escapeHtml(clean(h))}</th>`).join('') + '</tr>');
  }
  for (const row of rows) {
    parts.push('<tr>' + row.map((cell, idx) => {
      const align = (headers.length === 2 && idx === 1) ? 'right' : 'center';
      return `<td align="${align}">${escapeHtml(clean(cell))}</td>`;
    }).join('') + '</tr>');
  }
  parts.push('</table>');
  return parts.join('');
}

function preTable(headers, rows, caption = '') {
  return richTable(headers, rows, caption);
}

module.exports = { richTable, preTable, escapeHtml, clean };
