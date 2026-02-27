const cds = require('@sap/cds');
const { resolveGroups } = require('./auth.handler');

async function readVhAllowedProcesses(req) {
  const tx = cds.tx(req);
  const { resolvedGroups } = await resolveGroups(req);
  if (!resolvedGroups?.length) return [];

  const inGroups = resolvedGroups.map(() => '?').join(',');
  const rows = await tx.run(
    `SELECT DISTINCT
        p."ID"           AS "ID",
        p."PROCESS_CODE" AS "PROCESS_CODE",
        p."NAME"         AS "NAME"
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
        AND requester."FRONT_CODE" = 'MTO'
      WHERE m."IS_ENABLED" = true
        AND m."IAS_GROUP" IN (${inGroups})
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
    resolvedGroups
  );

  return rows;
}

module.exports = { readVhAllowedProcesses };
