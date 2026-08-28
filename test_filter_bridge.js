const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync('filter-utils.js', 'utf8');
const storage = new Map();
storage.set('pos_filters_expenses_v3', JSON.stringify({ preset: 'month', from: '2026-08-01', to: '2026-08-23', limit: 50 }));
let captured = [];
const window = {
  localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  fetch: (input, init) => { captured.push({ input, init }); return Promise.resolve({ ok: true }); },
  alert: () => {},
  showToast: () => {}
};
const document = {
  readyState: 'loading',
  addEventListener: () => {},
  getElementById: () => null,
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, style: {}, classList: { add: () => {} } }),
  head: { appendChild: () => {} },
  querySelector: () => null,
  querySelectorAll: () => [],
  body: {}
};
const location = { pathname: '/expenses.html', href: 'http://localhost/expenses.html' };
const context = { window, document, location, localStorage: window.localStorage, URL, URLSearchParams, Request: class Request { constructor(url, init) { this.url = url; this.init = init; } }, console };
vm.runInNewContext(code, context);
(async () => {
  await window.fetch('http://localhost/expenses?search=rent&page=3');
  if (captured.length !== 1) throw new Error('GET was not forwarded');
  const url = new URL(captured[0].input);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Aden', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); const dateParts = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value])); const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  if (url.searchParams.get('from') !== '2026-08-01' || url.searchParams.get('to') !== today || url.searchParams.get('limit') !== '50' || url.searchParams.get('page') !== '3' || url.searchParams.get('search') !== 'rent') throw new Error(`bridge query mismatch: ${url}`);
  await window.fetch('http://localhost/expenses', { method: 'POST', body: '{}' });
  if (captured.length !== 2 || captured[1].input !== 'http://localhost/expenses') throw new Error('POST was modified');
  console.log('PASS filter fetch bridge contract');
})();
