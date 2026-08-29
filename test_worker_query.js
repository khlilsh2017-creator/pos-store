const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('worker.js', 'utf8');
const start = source.indexOf('function parseListQuery');
const end = source.indexOf('function appendDateRange', start);
if (start < 0 || end < 0) throw new Error('query helpers not found');
const context = { URL, Math, Number, parseInt, String, console, businessISODate: () => '2026-08-26' };
vm.runInNewContext(`${source.slice(start, end)}; this.parseListQuery = parseListQuery;`, context);
const parse = context.parseListQuery;
function request(query) { return { url: `https://api.test/data${query ? `?${query}` : ''}` }; }
let q = parse(request(''));
if (q.page !== 1 || q.limit !== 20 || q.offset !== 0) throw new Error('default paging failed');
q = parse(request('page=3&limit=50&from=2026-08-01&to=2026-08-23'));
if (q.page !== 3 || q.limit !== 50 || q.offset !== 100 || q.from !== '2026-08-01' || q.to !== '2026-08-23') throw new Error('valid paging/range failed');
q = parse(request('page=0&limit=999'));
if (q.page !== 1 || q.limit !== 100 || q.offset !== 0) throw new Error('limit/page clamping failed');
q = parse(request('page=x&limit=nope'));
if (q.page !== 1 || q.limit !== 20) throw new Error('invalid paging fallback failed');
console.log('PASS worker query contract');
