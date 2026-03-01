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

function _toIsoDate(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'empty_datetime' };
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return { ok: false, reason: `invalid_datetime:${text}` };
  return { ok: true, value: d.toISOString() };
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
    case 'Edm.Double':
    case 'Edm.Single':
      return _toNumber(raw);
    case 'Edm.DateTime':
    case 'Edm.DateTimeOffset':
      return _toIsoDate(raw);
    case 'Edm.String':
    default: {
      const text = String(raw ?? '');
      if (!text.trim()) return { ok: false, reason: 'empty_string' };
      return { ok: true, value: text };
    }
  }
}

module.exports = { convertValueForSap };

