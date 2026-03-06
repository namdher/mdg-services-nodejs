function _normalizeDataType(dataType) {
  return String(dataType || '').trim().toUpperCase();
}

function _edmFromFallbackDataType(dataType) {
  const dt = _normalizeDataType(dataType);
  if (!dt) return null;
  if (dt.includes('BOOL')) return 'Edm.Boolean';
  if (dt.includes('INT')) return 'Edm.Int32';
  if (dt.includes('DEC') || dt.includes('NUM') || dt.includes('DOUBLE') || dt.includes('FLOAT')) return 'Edm.Decimal';
  if (dt.includes('DATE') || dt.includes('TIME')) return 'Edm.DateTime';
  return 'Edm.String';
}

function _toBoolean(raw) {
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  const text = String(raw ?? '').trim().toLowerCase();
  if (['true', 'x', '1', 'yes', 'y', 'si', 'sí'].includes(text)) return { ok: true, value: true };
  if (['false', '', '0', 'no', 'n'].includes(text)) return { ok: true, value: false };
  return { ok: false, reason: `invalid_boolean:${String(raw)}` };
}

function _toInteger(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'empty_integer' };
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, reason: `invalid_integer:${text}` };
  return { ok: true, value: n };
}

function _toNumber(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'empty_number' };
  const n = Number(text);
  if (!Number.isFinite(n)) return { ok: false, reason: `invalid_number:${text}` };
  return { ok: true, value: n };
}

function _toDecimalString(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'empty_decimal' };
  // Accept canonical decimal format used by OData V2 payloads.
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, reason: `invalid_decimal:${text}` };
  return { ok: true, value: text };
}

function _toODataV2DateTime(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'empty_datetime' };

  // Already in OData V2 JSON Date format
  if (/^\/Date\((-?\d+)\)\/$/.test(text)) {
    return { ok: true, value: text };
  }

  // Strict YYYY-MM-DD -> UTC midnight
  const ymd = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const y = Number(ymd[1]);
    const m = Number(ymd[2]);
    const d = Number(ymd[3]);
    const ms = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
    const dt = new Date(ms);
    if (Number.isNaN(dt.getTime())) return { ok: false, reason: `invalid_datetime:${text}` };
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) {
      return { ok: false, reason: `invalid_datetime:${text}` };
    }
    return { ok: true, value: `/Date(${ms})/` };
  }

  // Compact YYYYMMDD (common SAP/legacy date representation)
  const ymdCompact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (ymdCompact) {
    const y = Number(ymdCompact[1]);
    const m = Number(ymdCompact[2]);
    const d = Number(ymdCompact[3]);
    const ms = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
    const dt = new Date(ms);
    if (Number.isNaN(dt.getTime())) return { ok: false, reason: `invalid_datetime:${text}` };
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) {
      return { ok: false, reason: `invalid_datetime:${text}` };
    }
    return { ok: true, value: `/Date(${ms})/` };
  }

  // Excel-like serial date (days since 1899-12-30), used by some UI/date libs.
  // Example: 45847 -> 2025-07-09
  if (/^\d{1,6}$/.test(text)) {
    const serial = Number(text);
    if (Number.isFinite(serial) && serial >= 1 && serial <= 100000) {
      const excelEpochUtcMs = Date.UTC(1899, 11, 30, 0, 0, 0, 0);
      const ms = excelEpochUtcMs + (serial * 24 * 60 * 60 * 1000);
      return { ok: true, value: `/Date(${ms})/` };
    }
  }

  // Reject other plain numeric values to avoid accidental year conversion
  if (/^-?\d+$/.test(text)) {
    return { ok: false, reason: `invalid_datetime_numeric:${text}` };
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return { ok: false, reason: `invalid_datetime:${text}` };
  return { ok: true, value: `/Date(${parsed.getTime()})/` };
}

function _toIsoDateTimeOffset(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'empty_datetimeoffset' };
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return { ok: false, reason: `invalid_datetimeoffset:${text}` };
  return { ok: true, value: parsed.toISOString() };
}

function convertValueForSap(raw, { edmType, fallbackDataType } = {}) {
  const effectiveEdmType = edmType || _edmFromFallbackDataType(fallbackDataType) || 'Edm.String';

  switch (effectiveEdmType) {
    case 'Edm.Boolean':
      return _toBoolean(raw);
    case 'Edm.Int16':
    case 'Edm.Int32':
    case 'Edm.Int64':
      return _toInteger(raw);
    case 'Edm.Decimal':
      return _toDecimalString(raw);
    case 'Edm.Double':
    case 'Edm.Single':
      return _toNumber(raw);
    case 'Edm.DateTime':
      return _toODataV2DateTime(raw);
    case 'Edm.DateTimeOffset':
      return _toIsoDateTimeOffset(raw);
    case 'Edm.String':
    default: {
      const text = String(raw ?? '');
      if (!text.trim()) return { ok: false, reason: 'empty_string' };
      return { ok: true, value: text };
    }
  }
}

module.exports = { convertValueForSap };
