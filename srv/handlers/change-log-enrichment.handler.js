function toArray(data) {
  if (Array.isArray(data)) return data;
  if (!data) return [];
  return [data];
}

function mapStatusText(value) {
  const key = String(value || '').trim().toUpperCase();
  if (key === 'DRAFT') return 'Borrador';
  if (key === 'IN_REVIEW') return 'En revisión';
  if (key === 'REWORK') return 'Devuelto';
  if (key === 'APPROVED') return 'Aprobado';
  if (key === 'SUBMITTED') return 'Enviado';
  if (key === 'ERROR') return 'Error';
  return String(value || '');
}

async function afterReadRequestFieldChangeLogs(data) {
  const rows = toArray(data);
  for (const row of rows) {
    if (String(row?.FIELD_CODE || '') !== 'MDG_REQUEST_HEADER.STATUS') continue;
    row.OLD_VALUE = mapStatusText(row?.OLD_VALUE);
    row.NEW_VALUE = mapStatusText(row?.NEW_VALUE);
  }
  return data;
}

module.exports = { afterReadRequestFieldChangeLogs };
