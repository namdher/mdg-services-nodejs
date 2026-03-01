const cds = require('@sap/cds');

const SYSTEM_FIELD_ID = '00000000-0000-0000-0000-000000000000';

function _toStringValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function _normalizeFieldCode(fieldCode) {
  const out = String(fieldCode || '').trim();
  if (!out) return null;
  return out.slice(0, 80);
}

function _normalizeRole(role) {
  const out = String(role || '').trim();
  return out ? out.slice(0, 30) : null;
}

function _normalizeSource(source) {
  const out = String(source || '').trim();
  return out ? out.slice(0, 30) : null;
}

function _normalizeChangeType(changeType) {
  const out = String(changeType || 'UPDATE').trim().toUpperCase();
  if (out === 'CREATE' || out === 'UPDATE' || out === 'DELETE') return out;
  return 'UPDATE';
}

function areValuesEqual(a, b) {
  const av = _toStringValue(a);
  const bv = _toStringValue(b);
  return av === bv;
}

async function insertRequestFieldChangeLog(tx, {
  requestId,
  fieldId,
  fieldCode,
  lineNo = 1,
  oldValue,
  newValue,
  changeType = 'UPDATE',
  changedBy,
  changedRole,
  source
}) {
  if (!requestId || !changedBy) return;

  await tx.run(
    `INSERT INTO "MDG_REQUEST_FIELD_CHANGE_LOG"
     ("ID", "REQUEST_ID", "FIELD_ID", "FIELD_CODE", "LINE_NO", "OLD_VALUE", "NEW_VALUE", "CHANGE_TYPE", "CHANGED_AT", "CHANGED_BY", "CHANGED_ROLE", "SOURCE")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cds.utils.uuid(),
      requestId,
      fieldId || SYSTEM_FIELD_ID,
      _normalizeFieldCode(fieldCode),
      Number.isFinite(Number(lineNo)) ? Number(lineNo) : 1,
      _toStringValue(oldValue),
      _toStringValue(newValue),
      _normalizeChangeType(changeType),
      new Date(),
      String(changedBy).slice(0, 255),
      _normalizeRole(changedRole),
      _normalizeSource(source)
    ]
  );
}

module.exports = {
  SYSTEM_FIELD_ID,
  areValuesEqual,
  insertRequestFieldChangeLog
};

