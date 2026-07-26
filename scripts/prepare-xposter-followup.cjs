'use strict';

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'apply-xposter-followup.cjs');
let source = fs.readFileSync(file, 'utf8');

// The follow-up applier contains template literals whose output is JavaScript
// source. Interpolations inside those generated files must survive until the
// generated code runs; only the helper's own ${label} diagnostics belong to the
// applier process itself.
source = source.replace(/(?<!\\)\$\{(?!label\})/g, '\\${');
fs.writeFileSync(file, source, 'utf8');
console.log('Prepared nested xposter follow-up templates.');
