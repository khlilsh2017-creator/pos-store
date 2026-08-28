(function (global) {
  'use strict';
  const TIME_ZONE = 'Asia/Aden';
  const SQL_UTC_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/;
  const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

  function toDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const text = String(value).trim();
    if (DATE_ONLY_RE.test(text)) {
      const [year, month, day] = text.split('-').map(Number);
      return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - 180 * 60000);
    }
    const match = text.match(SQL_UTC_RE);
    const normalized = match ? `${match[1]}T${match[2]}Z` : text;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function parts(value, withTime) {
    const date = toDate(value);
    if (!date) return null;
    const options = { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' };
    if (withTime) Object.assign(options, { hour: '2-digit', minute: '2-digit', hour12: false });
    const result = {};
    new Intl.DateTimeFormat('en-CA', options).formatToParts(date).forEach(part => {
      if (part.type !== 'literal') result[part.type] = part.value;
    });
    return result;
  }

  function date(value) {
    const p = parts(value, false);
    return p ? `${p.year}-${p.month}-${p.day}` : (value ? String(value) : '--');
  }

  function dateTime(value) {
    const p = parts(value, true);
    return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : (value ? String(value) : '--');
  }

  function localized(value, options) {
    const parsed = toDate(value);
    return parsed ? new Intl.DateTimeFormat('ar-SA', { timeZone: TIME_ZONE, ...(options || {}) }).format(parsed) : (value ? String(value) : '--');
  }

  function inputToUTC(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return undefined;
    const utcMillis = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0)) - 180 * 60000;
    return new Date(utcMillis).toISOString().slice(0, 19).replace('T', ' ');
  }

  function toLocalInput(value) {
    const p = parts(value, true);
    return p ? `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` : '';
  }

  function nowLocalInput() { return toLocalInput(new Date()); }

  global.POSDate = { TIME_ZONE, toDate, date, dateTime, localized, inputToUTC, toLocalInput, nowLocalInput, today: () => date(new Date()) };
  global.posDate = date;
  global.posDateTime = dateTime;
})(window);

// SQLite CURRENT_TIMESTAMP is UTC; e.g. 2026-08-24 23:00:00 becomes 2026-08-25 02:00 in Asia/Aden.
