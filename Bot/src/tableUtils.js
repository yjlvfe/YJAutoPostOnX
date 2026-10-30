'use strict';

const escapeHtml = text => String(text ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');
const clean = value => String(value ?? '').replace(/[\r\n\t\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\|/g, '¦').slice(0, 48);

// Ordinary sendMessage/editMessageText HTML supports pre/code, not native tables.
// Measure clean text before escaping so entities do not change column padding.
function preTable(headers, rows, caption = '') {
  const cells = [headers, ...rows].map(row => row.map(clean));
  const widths = headers.map((_, i) => Math.max(...cells.map(row => [...row[i]].length)));
  const lines = cells.map(row => row.map((cell, i) =>
    escapeHtml(cell + ' '.repeat(widths[i] - [...cell].length))).join(' | '));
  const title = clean(caption);
  return `${title ? `<b>${escapeHtml(title)}:</b>\n` : ''}<pre><code>${lines.join('\n')}</code></pre>`;
}

module.exports = { preTable, escapeHtml, clean };
