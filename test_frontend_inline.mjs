import fs from 'node:fs';
import path from 'node:path';

const root = '/home/ubuntu/pos_project_mobile_accounting_audited';
const files = fs.readdirSync(root).filter(name => name.endsWith('.html'));
let total = 0;
for (const name of files) {
  const html = fs.readFileSync(path.join(root, name), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(s => s.trim());
  for (let i = 0; i < scripts.length; i++) {
    total++;
    try { new Function(scripts[i]); }
    catch (error) { throw new Error(`${name} inline script ${i + 1}: ${error.message}`); }
  }
}
const numberUtils = fs.readFileSync(path.join(root, 'number-utils.js'), 'utf8');
const context = { window: {}, Intl, Map, String, Number, Boolean, Math, Object };
const vm = await import('node:vm');
vm.runInNewContext(numberUtils, context);
const u = context.window.POSNumberUtils;
const cases = [
  ['١٢٣٤٥٦٫٧٥', '123456.75'],
  ['1,234,567.75', '1234567.75'],
  ['-12 345', '-12345']
];
for (const [input, expected] of cases) {
  const actual = u.normalizeEnglishDigits(input, {numeric: true});
  if (actual !== expected) throw new Error(`normalize ${input}: expected ${expected}, got ${actual}`);
}
if (u.formatPosMoney('1234567.5') !== '1,234,567.50') throw new Error('formatPosMoney failed');
if (u.formatPosQuantity('1234567.5') !== '1,234,567.5') throw new Error('formatPosQuantity failed');
console.log(`PASS: ${total} inline HTML scripts parsed; number normalization/grouping cases passed.`);
