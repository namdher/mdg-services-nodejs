const cds = require('@sap/cds');
const { resolveGroups } = require('./auth.handler');

function _readEqualsLiteralFromWhere(where = [], field) {
  if (!Array.isArray(where) || !field) return null;
  for (let i = 0; i < where.length - 2; i++) {
    const left = where[i];
    const op = where[i + 1];
    const right = where[i + 2];
    if (!left || typeof left !== 'object' || !Array.isArray(left.ref)) continue;
    if (String(left.ref[0] || '') !== String(field)) continue;
    if (op !== '=') continue;
    if (!right || typeof right !== 'object' || right.val === undefined || right.val === null) continue;
    return String(right.val);
  }
  return null;
}

async function readVhAllowedProcesses(req) {
  const tx = cds.tx(req);
  const { resolvedGroups } = await resolveGroups(req);
  if (!resolvedGroups?.length) return [];
  const frontCode = _readEqualsLiteralFromWhere(req?.query?.SELECT?.where, 'FRONT_CODE')
    || (typeof req?.data?.FRONT_CODE === 'string' ? req.data.FRONT_CODE.trim() : '')
    || '';

  const inGroups = resolvedGroups.map(() => '?').join(',');
  const params = [...resolvedGroups];
  const frontCodeFilter = frontCode ? ' AND requester."FRONT_CODE" = ?' : '';
  if (frontCode) params.push(frontCode);
  const rows = await tx.run(
    `SELECT DISTINCT
        p."ID"           AS "ID",
        p."PROCESS_CODE" AS "PROCESS_CODE",
        p."NAME"         AS "NAME",
        requester."FRONT_CODE" AS "FRONT_CODE"
       FROM "MDG_IAS_GROUP_ROLE_MAP" m
       JOIN "MDG_PROCESS_ROLE" pr
         ON pr."ID" = m."PROCESS_ROLE_ID"
        AND pr."IS_ENABLED" = true
       JOIN "MDG_PROCESS" p
         ON p."ID" = m."PROCESS_ID"
        AND p."IS_ENABLED" = true
       JOIN "MDG_PROCESS_ROLE" requester
         ON requester."PROCESS_ID" = p."ID"
        AND requester."ROLE_CODE" = 'REQUESTER'
        AND requester."IS_ENABLED" = true
      WHERE m."IS_ENABLED" = true
        AND m."IAS_GROUP" IN (${inGroups})
        ${frontCodeFilter}
        AND (
          NOT EXISTS (
            SELECT 1
              FROM "MDG_COUNTRY_ROLE_SCOPE" s0
             WHERE s0."PROCESS_ROLE_ID" = pr."ID"
               AND s0."IS_ENABLED" = true
          )
          OR EXISTS (
            SELECT 1
              FROM "MDG_COUNTRY_ROLE_SCOPE" s1
             WHERE s1."PROCESS_ROLE_ID" = pr."ID"
               AND s1."IS_ENABLED" = true
          )
        )
      ORDER BY p."PROCESS_CODE"`,
    params
  );

  return rows;
}

module.exports = { readVhAllowedProcesses };
