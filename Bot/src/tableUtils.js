'use strict';

const escapeHtml = text => String(text ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Keep cells single-line, bounded and aligned by Unicode code points. Slicing
// the raw UTF-16 string can split an astral character and make the visual
// border drift on Telegram clients.
const clean = value => Array.from(String(value ?? '')
  .replace(/[\r\n\t\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '')
  .replace(/\|/g, '¦'))
  .slice(0, 48)
  .join('');

const cleanPreCell = value => {
  const str = String(value ?? '');
  const match = str.match(/^<a\s+[^>]*>([\s\S]*?)<\/a>$/i);
  return clean(match ? match[1] : str);
};

const cleanRichCell = value => {
  const str = String(value ?? '');
  const match = str.match(/^<a\s+href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>$/i);
  if (match) {
    const href = match[1];
    const innerText = clean(match[2]);
    return `<a href="${escapeHtml(href)}">${escapeHtml(innerText)}</a>`;
  }
  return escapeHtml(clean(str));
};

function displayWidth(value) {
  return Array.from(String(value ?? '')).length;
}

function padDisplayWidth(value, width) {
  const text = String(value ?? '');
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function preTable(headers = [], rows = [], caption = '') {
  const normalizedHeaders = Array.isArray(headers) ? headers.map(clean) : [];
  const normalizedRows = Array.isArray(rows)
    ? rows.map(row => (Array.isArray(row) ? row : [row]).map(cleanPreCell))
    : [];
  const columnCount = Math.max(normalizedHeaders.length, ...normalizedRows.map(row => row.length), 0);
  if (!columnCount) return caption ? `<pre><code>${escapeHtml(clean(caption))}</code></pre>` : '<pre><code></code></pre>';

  const allRows = (normalizedHeaders.length ? [normalizedHeaders, ...normalizedRows] : normalizedRows).map(row =>
    Array.from({ length: columnCount }, (_, index) => row[index] ?? '')
  );
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(1, ...allRows.map(row => displayWidth(row[index])))
  );
  const horizontal = (left, middle, right) => left + widths.map(width => '─'.repeat(width + 2)).join(middle) + right;
  const renderRow = row => `│${row.map((cell, index) => ` ${padDisplayWidth(cell, widths[index])} `).join('│')}│`;
  const lines = [];
  if (caption) lines.push(clean(caption));
  const topBorder = horizontal('┌', '┬', '┐');
  const bottomBorder = horizontal('└', '┴', '┘');
  const ellipsisRow = renderRow(Array.from({ length: columnCount }, () => '…'));
  const overhead = 30 + escapeHtml(bottomBorder).length;

  if (normalizedHeaders.length) {
    lines.push(topBorder);
    lines.push(renderRow(allRows[0]));
    lines.push(horizontal('├', '┼', '┤'));
    const dataRows = allRows.slice(1);
    for (const row of dataRows) {
      const rowLine = renderRow(row);
      const currentLength = escapeHtml(lines.join('\n')).length;
      const rowEscapedLen = escapeHtml(rowLine).length + 1;
      const ellipsisEscapedLen = escapeHtml(ellipsisRow).length + 1;
      if (currentLength + rowEscapedLen + ellipsisEscapedLen + overhead > 4096) {
        lines.push(ellipsisRow);
        break;
      }
      lines.push(rowLine);
    }
    lines.push(bottomBorder);
  } else {
    lines.push(topBorder);
    for (const row of allRows) {
      const rowLine = renderRow(row);
      const currentLength = escapeHtml(lines.join('\n')).length;
      const rowEscapedLen = escapeHtml(rowLine).length + 1;
      const ellipsisEscapedLen = escapeHtml(ellipsisRow).length + 1;
      if (currentLength + rowEscapedLen + ellipsisEscapedLen + overhead > 4096) {
        lines.push(ellipsisRow);
        break;
      }
      lines.push(rowLine);
    }
    lines.push(bottomBorder);
  }
  return `<pre><code>${escapeHtml(lines.join('\n'))}</code></pre>`;
}

function richTable(headers = [], rows = [], caption = '') {
  const normalizedHeaders = Array.isArray(headers) ? headers.map(clean) : [];
  const rawRows = Array.isArray(rows) ? rows : [];
  const columnCount = Math.max(normalizedHeaders.length, ...rawRows.map(row => (Array.isArray(row) ? row.length : 1)), 0);
  if (columnCount > 20) {
    throw Object.assign(new Error('Table exceeds maximum column limit of 20'), { code: 'TELEGRAM_TABLE_LIMIT' });
  }
  const totalRows = (normalizedHeaders.length ? 1 : 0) + rawRows.length;
  if (totalRows > 500) {
    throw Object.assign(new Error('Table exceeds maximum block limit of 500'), { code: 'TELEGRAM_TABLE_LIMIT' });
  }

  const parts = ['<table bordered compact>'];
  if (caption) parts.push(`<caption>${escapeHtml(clean(caption))}</caption>`);
  if (normalizedHeaders.length) {
    const paddedHeaders = Array.from({ length: columnCount }, (_, i) => normalizedHeaders[i] ?? '');
    parts.push('<tr>' + paddedHeaders.map(h => `<th align="center">${escapeHtml(h)}</th>`).join('') + '</tr>');
  }
  for (const row of rawRows) {
    const cells = Array.isArray(row) ? row : [row];
    const paddedRow = Array.from({ length: columnCount }, (_, i) => cells[i] ?? '');
    parts.push('<tr>' + paddedRow.map((cell, idx) => {
      const align = (columnCount === 2 && idx === 1) ? 'right' : 'center';
      return `<td align="${align}">${cleanRichCell(cell)}</td>`;
    }).join('') + '</tr>');
  }
  parts.push('</table>');
  const result = parts.join('');
  if (result.length > 32768) {
    throw Object.assign(new Error('Table HTML exceeds limit of 32768 characters'), { code: 'TELEGRAM_TABLE_LIMIT' });
  }
  return result;
}

function decodeHtmlEntities(str) {
  return String(str ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseTableHtml(tableHtml) {
  let caption = '';
  const captionMatch = tableHtml.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
  if (captionMatch) {
    caption = decodeHtmlEntities(captionMatch[1].replace(/<[^>]+>/g, '').trim());
  }

  const cleanCell = cellHtml => {
    const withLinks = cellHtml.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const cleanText = text.replace(/<[^>]+>/g, '').trim();
      return href ? `${cleanText} (${href})` : cleanText;
    });
    const stripped = withLinks.replace(/<[^>]+>/g, '').trim();
    return decodeHtmlEntities(stripped);
  };

  const headers = [];
  const rows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(tableHtml)) !== null) {
    const rowContent = trMatch[1];
    const thMatches = [...rowContent.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)];
    if (thMatches.length && !headers.length) {
      headers.push(...thMatches.map(m => cleanCell(m[1])));
      continue;
    }
    const tdMatches = [...rowContent.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (tdMatches.length) {
      rows.push(tdMatches.map(m => cleanCell(m[1])));
    } else if (thMatches.length) {
      rows.push(thMatches.map(m => cleanCell(m[1])));
    }
  }
  return { caption, headers, rows };
}

function richHtmlToFallback(html) {
  if (typeof html !== 'string') return '';
  const tableRegex = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
  let replaced = html.replace(tableRegex, match => {
    const { caption, headers, rows } = parseTableHtml(match);
    return preTable(headers, rows, caption);
  });
  replaced = replaced.replace(/<\/?(?:table|caption|tr|th|td|thead|tbody)\b[^>]*>/gi, '');
  replaced = replaced.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const cleanText = text.replace(/<[^>]+>/g, '').trim();
    return href ? `${cleanText} (${href})` : cleanText;
  });
  if (replaced.length > 4096) {
    const suffix = '\n…</code></pre>';
    const allowed = 4096 - 18;
    const spans = [];
    const spanRegex = /<pre><code>([\s\S]*?)<\/code><\/pre>/g;
    let m;
    while ((m = spanRegex.exec(replaced)) !== null) {
      spans.push({ open: m.index, contentStart: m.index + 11, end: m.index + m[0].length });
    }
    const active = spans.find(s => s.contentStart <= allowed && s.end > allowed);
    if (active) {
      let prefix = replaced.slice(0, allowed);
      prefix = prefix.replace(/<[^>]*$/, '').replace(/&[a-zA-Z0-9#]*$/, '');
      replaced = prefix + suffix;
    } else {
      const partial = spans.find(s => s.open < 4095 && s.contentStart > allowed);
      const cutAt = partial ? Math.min(partial.open, 4095) : 4095;
      const prefix = replaced.slice(0, cutAt).replace(/<[^>]*$/, '').replace(/&[a-zA-Z0-9#]*$/, '');
      replaced = prefix + '…';
    }
  }
  return replaced;
}

function formatTable(headers = [], rows = [], caption = '') {
  return richTable(headers, rows, caption);
}

module.exports = { richTable, preTable, formatTable, richHtmlToFallback, escapeHtml, clean };
