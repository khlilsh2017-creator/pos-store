const TIME_ZONE = 'Asia/Aden';
function parts(value, withTime = true) {
  const options = { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' };
  if (withTime) Object.assign(options, { hour: '2-digit', minute: '2-digit', hour12: false });
  const result = {};
  new Intl.DateTimeFormat('en-CA', options).formatToParts(new Date(`${value.replace(' ', 'T')}Z`)).forEach(part => {
    if (part.type !== 'literal') result[part.type] = part.value;
  });
  return result;
}
const sample = parts('2026-08-24 23:00:00');
if (`${sample.year}-${sample.month}-${sample.day} ${sample.hour}:${sample.minute}` !== '2026-08-25 02:00') {
  throw new Error(`unexpected local date: ${JSON.stringify(sample)}`);
}
console.log('PASS SQLite UTC 23:00 on day 24 displays as local 02:00 on day 25');
