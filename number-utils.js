/*
 * POS numeric utilities.
 * Raw API/database values remain unchanged; only input values and rendered
 * display strings are normalized/formatted in the browser.
 */
(function (global) {
  'use strict';

  const numberFormatterCache = new Map();
  const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
  const ASCII_DIGITS = '0123456789';

  function translateDigits(value) {
    return String(value).replace(/[٠-٩۰-۹]/g, function (digit) {
      const arabicIndex = ARABIC_DIGITS.indexOf(digit);
      if (arabicIndex !== -1) return ASCII_DIGITS[arabicIndex];
      const persianIndex = PERSIAN_DIGITS.indexOf(digit);
      return persianIndex === -1 ? digit : ASCII_DIGITS[persianIndex];
    });
  }

  /**
   * Convert Arabic/Persian digits and decimal punctuation to ASCII.
   * Numeric controls additionally lose grouping separators, because commas
   * are invalid inside the value of an HTML input[type="number"].
   */
  function normalizeEnglishDigits(value, options) {
    if (value === null || value === undefined) return value;
    const numeric = Boolean(options && options.numeric);
    let result = translateDigits(value)
      .replace(/[٫﹒．]/g, '.')
      .replace(/[−﹣]/g, '-');

    if (numeric) {
      result = result.replace(/[٬,\u00a0\u202f\s]/g, '');
    }
    return result;
  }

  function formatter(minimumFractionDigits, maximumFractionDigits) {
    const key = `${minimumFractionDigits}:${maximumFractionDigits}`;
    if (!numberFormatterCache.has(key)) {
      numberFormatterCache.set(key, new Intl.NumberFormat('en-US', {
        useGrouping: true,
        minimumFractionDigits,
        maximumFractionDigits
      }));
    }
    return numberFormatterCache.get(key);
  }

  function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const normalized = normalizeEnglishDigits(value, { numeric: true });
    if (!normalized) return null;
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }

  function formatPosNumber(value, decimals) {
    const number = toNumber(value);
    if (number === null) {
      return value === null || value === undefined
        ? ''
        : normalizeEnglishDigits(String(value));
    }
    const maxDigits = Number.isInteger(decimals)
      ? Math.max(0, Math.min(6, decimals))
      : 3;
    const minDigits = Number.isInteger(decimals)
      ? maxDigits
      : (Number.isInteger(number)
        ? 0
        : Math.min(3, String(number).split('.')[1]?.length || 0));
    return formatter(minDigits, maxDigits).format(number);
  }

  function formatPosMoney(value) { return formatPosNumber(value, 2); }
  function formatPosQuantity(value) { return formatPosNumber(value); }

  function isEditableField(element) {
    if (!element || !element.tagName) return false;
    const tag = element.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return false;
    if (element.disabled || element.readOnly) return false;
    if (tag === 'input' && /^(button|submit|reset|checkbox|radio|file|hidden|color|date|datetime-local|month|time|week)$/.test(element.type)) {
      return false;
    }
    return true;
  }

  function isNumericControl(element) {
    if (!element || !element.tagName) return false;
    const inputMode = (element.getAttribute('inputmode') || '').toLowerCase();
    return (element.tagName.toLowerCase() === 'input' && element.type === 'number')
      || inputMode === 'numeric'
      || inputMode === 'decimal'
      || element.hasAttribute('data-numeric')
      || element.hasAttribute('data-number')
      || (element.tagName.toLowerCase() === 'input' && element.type === 'tel');
  }

  function normalizedCaret(value, caret, numeric) {
    if (!Number.isFinite(caret)) return caret;
    return normalizeEnglishDigits(value.slice(0, caret), { numeric }).length;
  }

  function normalizeInputValue(element) {
    if (!isEditableField(element)) return false;
    const numeric = isNumericControl(element);
    const value = element.value == null ? '' : String(element.value);
    const normalized = normalizeEnglishDigits(value, { numeric });
    if (normalized === value) return false;

    const hadFocus = document.activeElement === element;
    const start = hadFocus && typeof element.selectionStart === 'number'
      ? normalizedCaret(value, element.selectionStart, numeric) : null;
    const end = hadFocus && typeof element.selectionEnd === 'number'
      ? normalizedCaret(value, element.selectionEnd, numeric) : null;

    element.value = normalized;
    if (hadFocus && typeof element.setSelectionRange === 'function' && start !== null && end !== null) {
      try { element.setSelectionRange(start, end); } catch (_) { /* type=number may reject selection APIs */ }
    }
    return true;
  }

  function isGroupedNumberField(element) {
    return Boolean(element && element.dataset && (element.dataset.groupedNumber !== undefined || element.dataset.numberFormat === 'grouped'));
  }

  function groupedDecimals(element) {
    const value = element && element.dataset ? Number(element.dataset.decimals) : NaN;
    return Number.isInteger(value) ? Math.max(0, Math.min(6, value)) : 2;
  }

  function stripGroupedValue(element) {
    if (!isEditableField(element)) return;
    const normalized = normalizeEnglishDigits(element.value || '', { numeric: true });
    if (element.value !== normalized) element.value = normalized;
  }

  function formatGroupedInput(element) {
    if (!isEditableField(element) || !isGroupedNumberField(element)) return;
    const number = toNumber(element.value);
    if (number === null) return;
    element.value = formatPosNumber(number, groupedDecimals(element));
  }

  function prepareGroupedInput(element) {
    if (!element || !isGroupedNumberField(element) || !isEditableField(element)) return;
    if (element.type === 'number') {
      const raw = normalizeEnglishDigits(element.value || '', { numeric: true });
      try { element.type = 'text'; } catch (_) {}
      element.value = raw;
    }
    element.setAttribute('inputmode', 'decimal');
    element.setAttribute('autocomplete', 'off');
    formatGroupedInput(element);
  }

  function normalizeAllGroupedInputs() {
    if (!global.document) return;
    document.querySelectorAll('input[type="number"], input[data-grouped-number], input[data-number-format="grouped"]').forEach(function (element) {
      if (element.type === 'number' && !element.hasAttribute('data-grouped-number') && !element.hasAttribute('data-number-format')) element.setAttribute('data-grouped-number', '');
      prepareGroupedInput(element);
    });
  }

  function insertNormalizedText(element, text) {
    if (!isEditableField(element)) return;
    const numeric = isNumericControl(element);
    const normalized = normalizeEnglishDigits(text, { numeric });
    const start = typeof element.selectionStart === 'number' ? element.selectionStart : element.value.length;
    const end = typeof element.selectionEnd === 'number' ? element.selectionEnd : start;
    const next = element.value.slice(0, start) + normalized + element.value.slice(end);
    element.value = next;
    const caret = start + normalized.length;
    if (typeof element.setSelectionRange === 'function') {
      try { element.setSelectionRange(caret, caret); } catch (_) { /* ignore unsupported input types */ }
    }
    element.dispatchEvent(new Event('input', { bubbles: true, inputType: 'insertText' }));
  }

  function normalizeTarget(target) {
    if (isEditableField(target)) normalizeInputValue(target);
  }

  function installInputNormalization() {
    if (global.__posInputNormalizationInstalled) return;
    global.__posInputNormalizationInstalled = true;

    document.addEventListener('beforeinput', function (event) {
      const target = event.target;
      if (!isEditableField(target) || !event.data) return;
      const normalized = normalizeEnglishDigits(event.data, { numeric: isNumericControl(target) });
      if (normalized === event.data) return;
      event.preventDefault();
      insertNormalizedText(target, event.data);
    }, true);

    document.addEventListener('input', function (event) {
      normalizeTarget(event.target);
    }, true);

    document.addEventListener('change', function (event) {
      normalizeTarget(event.target);
    }, true);

    document.addEventListener('blur', function (event) {
      if (isGroupedNumberField(event.target)) formatGroupedInput(event.target);
      normalizeTarget(event.target);
    }, true);

    document.addEventListener('focus', function (event) {
      if (isGroupedNumberField(event.target)) stripGroupedValue(event.target);
    }, true);

    document.addEventListener('click', function (event) {
      const target = event.target && event.target.closest ? event.target.closest('button, [type="submit"]') : null;
      if (target) document.querySelectorAll('input[data-grouped-number], input[data-number-format="grouped"]').forEach(stripGroupedValue);
    }, true);

    document.addEventListener('submit', function () {
      document.querySelectorAll('input[data-grouped-number], input[data-number-format="grouped"]').forEach(stripGroupedValue);
    }, true);

    document.addEventListener('keydown', function (event) {
      const target = event.target;
      if (!isEditableField(target) || !event.key || !/[٠-٩۰-۹٫٬]/.test(event.key)) return;
      event.preventDefault();
      insertNormalizedText(target, event.key);
    }, true);

    document.addEventListener('paste', function (event) {
      const target = event.target;
      if (!isEditableField(target)) return;
      const clipboard = event.clipboardData || global.clipboardData;
      const text = clipboard && clipboard.getData ? clipboard.getData('text') : '';
      if (!text || normalizeEnglishDigits(text, { numeric: isNumericControl(target) }) === text) return;
      event.preventDefault();
      insertNormalizedText(target, text);
    }, true);

    document.querySelectorAll('input, textarea').forEach(normalizeInputValue);
    normalizeAllGroupedInputs();

    const observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (node.matches && node.matches('input, textarea')) normalizeInputValue(node);
          if (node.querySelectorAll) node.querySelectorAll('input, textarea').forEach(normalizeInputValue);
          if (node.matches && node.matches('input, [data-grouped-number], [data-number-format="grouped"]')) prepareGroupedInput(node);
          if (node.querySelectorAll) node.querySelectorAll('input[type="number"], input[data-grouped-number], input[data-number-format="grouped"]').forEach(function (element) {
            if (element.type === 'number' && !element.hasAttribute('data-grouped-number') && !element.hasAttribute('data-number-format')) element.setAttribute('data-grouped-number', '');
            prepareGroupedInput(element);
          });
        });
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    if (!document.getElementById('pos-number-input-style')) {
      const style = document.createElement('style');
      style.id = 'pos-number-input-style';
      style.textContent = [
        'input, textarea { font-variant-numeric: tabular-nums; }',
        'input[type="number"], input[inputmode="numeric"], input[inputmode="decimal"], input[data-numeric], input[data-number], input[type="tel"] { direction: ltr; unicode-bidi: plaintext; }'
      ].join('\n');
      document.head.appendChild(style);
    }
  }

  global.normalizeEnglishDigits = global.normalizeEnglishDigits || normalizeEnglishDigits;
  global.formatPosNumber = global.formatPosNumber || formatPosNumber;
  global.formatPosMoney = global.formatPosMoney || formatPosMoney;
  global.formatPosQuantity = global.formatPosQuantity || formatPosQuantity;
  global.POSNumberUtils = {
    normalizeEnglishDigits,
    formatPosNumber,
    formatPosMoney,
    formatPosQuantity,
    toNumber,
    normalizeInputValue,
    formatGroupedInput,
    stripGroupedValue
  };

  if (global.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', installInputNormalization, { once: true });
    } else {
      installInputNormalization();
    }
  }
})(window);
