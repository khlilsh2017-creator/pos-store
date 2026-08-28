const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync('filter-utils.js', 'utf8');
const storage = new Map();
const window = {
  localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  fetch: () => Promise.resolve(),
  alert: () => {}
};
const document = {
  readyState: 'loading',
  addEventListener: () => {},
  getElementById: () => null,
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, style: {}, classList: { add: () => {} } }),
  head: { appendChild: () => {} },
  querySelector: () => null,
  body: {}
};
const context = { window, document, location: { pathname: '/unknown.html' }, URL, URLSearchParams, Request: class Request {}, console };
vm.runInNewContext(code, context);
const filters = window.POSFilters;
if (!filters) throw new Error('POSFilters was not exported');
const today = filters.localISODate();
const todayState = filters.normalize({ preset: 'today', limit: 20 });
if (todayState.from !== today || todayState.to !== today) throw new Error('today preset failed');
const monthState = filters.normalize({ preset: 'month', limit: 50 });
if (!monthState.from.endsWith('-01') || monthState.limit !== 50) throw new Error('month/limit preset failed');
const invalid = filters.validate({ preset: 'custom', from: '2026-08-25', to: '2026-08-24' });
if (invalid.ok) throw new Error('custom date validation failed');
const params = filters.queryString({ preset: 'today', from: today, to: today, limit: 100, page: 2 });
if (params.get('from') !== today || params.get('limit') !== '100' || params.get('page') !== '2') throw new Error('query serialization failed');
console.log('PASS filter-utils unit tests');
