const cds = require('@sap/cds');

function toArray(data) {
  if (Array.isArray(data)) return data;
  if (!data) return [];
  return [data];
}

async function afterReadRequestsOverview(data, req) {
  const rows = toArray(data);
  if (!rows.length) return data;

  const requestIds = [...new Set(rows.map((r) => String(r?.ID || '').trim()).filter(Boolean))];
  if (!requestIds.length) return data;

  const tx = cds.tx(req);
  const inClause = requestIds.map(() => '?').join(',');
  const latestComments = await tx.run(
    `SELECT x."REQUEST_ID", x."MESSAGE"
       FROM (
         SELECT
           c."REQUEST_ID",
           c."MESSAGE",
           ROW_NUMBER() OVER (PARTITION BY c."REQUEST_ID" ORDER BY c."CREATEDAT" DESC, c."ID" DESC) AS "RN"
         FROM "MDG_REQUEST_COMMENT" c
         WHERE c."REQUEST_ID" IN (${inClause})
       ) x
      WHERE x."RN" = 1`,
    requestIds
  );

  const latestManagerActions = await tx.run(
    `SELECT y."REQUEST_ID", y."ACTION", y."ACTOR_USER"
       FROM (
         SELECT
           al."REQUEST_ID",
           al."ACTION",
           al."ACTOR_USER",
           ROW_NUMBER() OVER (PARTITION BY al."REQUEST_ID" ORDER BY al."CREATEDAT" DESC, al."ID" DESC) AS "RN"
         FROM "MDG_REQUEST_ACTION_LOG" al
         WHERE al."REQUEST_ID" IN (${inClause})
           AND al."ACTION" IN ('APPROVE', 'REJECT')
           AND al."ACTOR_ROLE" = 'APPROVER'
       ) y
      WHERE y."RN" = 1`,
    requestIds
  );

  const byRequest = new Map(
    (latestComments || []).map((row) => [String(row.REQUEST_ID), String(row.MESSAGE || '')])
  );
  const byRequestManager = new Map(
    (latestManagerActions || []).map((row) => [
      String(row.REQUEST_ID),
      {
        action: String(row.ACTION || '').toUpperCase(),
        user: String(row.ACTOR_USER || '')
      }
    ])
  );

  for (const row of rows) {
    row.LAST_COMMENT = byRequest.get(String(row.ID)) || '';
    const mgr = byRequestManager.get(String(row.ID));
    row.LAST_MANAGER_USER = mgr?.user || '';
    row.LAST_MANAGER_DECISION = mgr?.action === 'APPROVE'
      ? 'Aprobado'
      : (mgr?.action === 'REJECT' ? 'Rechazado' : '');
  }
  return data;
}

module.exports = { afterReadRequestsOverview };
