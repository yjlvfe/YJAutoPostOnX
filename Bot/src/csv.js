'use strict';

const FORMULA_PREFIX = /^[=+\-@]/;

function parseCsv(input, { required = ['account', 'text'], rejectFormulas = true } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('CSV must not be empty');
  const rows = splitRows(input).map(parseLine).filter(row => row.some(Boolean));
  if (rows.length < 2) throw new Error('CSV requires a header and at least one row');
  const headers = rows.shift().map(value => value.trim());
  const seen = new Set();
  for (const header of headers) {
    if (!header || seen.has(header)) throw new Error('CSV has invalid or duplicate headers');
    seen.add(header);
  }
  for (const field of required) if (!seen.has(field)) throw new Error(`CSV missing required column: ${field}`);
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV row ${index + 2} has wrong column count`);
    const row = Object.fromEntries(headers.map((header, i) => [header, values[i].trim()]));
    for (const field of required) if (!row[field]) throw new Error(`CSV row ${index + 2} missing ${field}`);
    if (rejectFormulas && Object.values(row).some(value => FORMULA_PREFIX.test(value))) throw new Error(`CSV row ${index + 2} contains unsafe formula-like value`);
    return row;
  });
}

function splitRows(input) {
  const rows = []; let current = ''; let quote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') { current += ch; if (quote && input[i + 1] === '"') { current += '"'; i++; } else quote = !quote; }
    else if ((ch === '\n' || ch === '\r') && !quote) { if (ch === '\r' && input[i + 1] === '\n') i++; rows.push(current); current = ''; }
    else current += ch;
  }
  if (quote) throw new Error('CSV has unterminated quote');
  rows.push(current); return rows;
}
function parseLine(line) {
  const values = []; let value = ''; let quote = false; let closed = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quote && line[i + 1] === '"') { value += '"'; i++; }
      else if (quote) { quote = false; closed = true; }
      else if (value === '' && !closed) quote = true;
      else throw new Error('CSV has malformed quote');
    } else if (ch === ',' && !quote) { values.push(value); value = ''; closed = false; }
    else {
      if (closed) throw new Error('CSV has malformed quote');
      value += ch;
    }
  }
  if (quote) throw new Error('CSV has unterminated quote');
  values.push(value); return values;
}
module.exports = { parseCsv, splitRows, parseLine, FORMULA_PREFIX };
