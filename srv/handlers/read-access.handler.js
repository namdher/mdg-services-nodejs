const cds = require('@sap/cds');
const { resolveGroups } = require('./auth.handler');
const { getRequestById, getUserRoleAssignments, currentUserId } = require('./_lib/mdg-workflow.util');

function addWhere(req, exprTokens) {
  if (!req.query?.SELECT) return;
  if (!Array.isArray(req.query.SELECT.where)) req.query.SELECT.where = [];
  if (req.query.SELECT.where.length) req.query.SELECT.where.push('and');
  req.query.SELECT.where.push(...exprTokens);
}

function addEquals(req, field, value) {
  addWhere(req, [{ ref: [field] }, '=', { val: value }]);
}

function addInValues(req, field, values) {
  if (!values.length) {
    addWhere(req, [{ val: 1 }, '=', { val: 0 }]);
    return;
  }
  addWhere(req, [{ ref: [field] }, 'in', { list: values.map((v) => ({ val: v })) }]);
}

function readEqualsLiteralFromWhere(where = [], field) {
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

function requestedEntityId(req) {
  return req.data?.ID || req.params?.[0]?.ID || null;
}

async function getAllowedRequestIds(tx, req, { frontCode = null, excludeDeleted = false } = {}) {
  const { resolvedGroups } = await resolveGroups(req);
  if (!resolvedGroups?.length) return [];
  const actorUser = String(currentUserId(req) || '').trim().toLowerCase();

  const groupIn = resolvedGroups.map(() => '?').join(',');
  let sql = `SELECT
                r."ID" AS "ID",
                r."CREATEDBY" AS "CREATEDBY",
                MAX(CASE WHEN pr."ROLE_CODE" = 'REQUESTER' THEN 1 ELSE 0 END) AS "HAS_REQUESTER",
                MAX(CASE WHEN pr."ROLE_CODE" <> 'REQUESTER' THEN 1 ELSE 0 END) AS "HAS_ELEVATED"
               FROM "MDG_REQUEST_HEADER" r
               JOIN "MDG_IAS_GROUP_ROLE_MAP" m
                 ON m."PROCESS_ID" = r."PROCESS_ID"
                AND m."IS_ENABLED" = true
               JOIN "MDG_PROCESS_ROLE" pr
                 ON pr."ID" = m."PROCESS_ROLE_ID"
                AND pr."IS_ENABLED" = true
              WHERE m."IAS_GROUP" IN (${groupIn})
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
                       AND s1."COUNTRY_CODE" = r."COUNTRY_CODE"
                      AND s1."IS_ENABLED" = true
                  )
                )`;

  if (frontCode) sql += ` AND r."FRONT_CODE" = ?`;
  if (excludeDeleted) sql += ` AND COALESCE(r."ISDELETED", false) = false`;
  sql += ` GROUP BY r."ID", r."CREATEDBY"`;

  const params = [...resolvedGroups];
  if (frontCode) params.push(frontCode);
  const rows = await tx.run(sql, params);
  return (rows || [])
    .filter((row) => {
      const hasElevated = Number(row.HAS_ELEVATED || 0) === 1;
      if (hasElevated) return true;

      const hasRequester = Number(row.HAS_REQUESTER || 0) === 1;
      if (!hasRequester) return false;

      const createdBy = String(row.CREATEDBY || '').trim().toLowerCase();
      return !!actorUser && createdBy === actorUser;
    })
    .map((row) => row.ID);
}

async function ensureRequestAccess(tx, req, requestId) {
  const request = await getRequestById(tx, requestId);
  if (!request) return;

  const assignments = await getUserRoleAssignments(tx, req, {
    processId: request.PROCESS_ID,
    countryCode: request.COUNTRY_CODE
  });

  if (!assignments.length) {
    req.reject(403, 'User has no access to this request');
  }

  const hasElevatedRole = assignments.some((a) => String(a.ROLE_CODE || '').trim().toUpperCase() !== 'REQUESTER');
  if (hasElevatedRole) return;

  const hasRequesterRole = assignments.some((a) => String(a.ROLE_CODE || '').trim().toUpperCase() === 'REQUESTER');
  if (!hasRequesterRole) {
    req.reject(403, 'User has no access to this request');
  }

  const ownerRows = await tx.run(
    `SELECT "CREATEDBY"
       FROM "MDG_REQUEST_HEADER"
      WHERE "ID" = ?`,
    [requestId]
  );
  const createdBy = String(ownerRows?.[0]?.CREATEDBY || '').trim().toLowerCase();
  const actorUser = String(currentUserId(req) || '').trim().toLowerCase();
  if (!actorUser || createdBy !== actorUser) {
    req.reject(403, 'User has no access to this request');
  }
}

async function beforeReadRequestsOverview(req) {
  const tx = cds.tx(req);
  const requestId = requestedEntityId(req);

  // Key reads (single request) must not force FRONT_CODE defaults.
  if (requestId) {
    const allowedRequestIds = await getAllowedRequestIds(tx, req, {
      excludeDeleted: true
    });
    addEquals(req, 'ISDELETED', false);
    addInValues(req, 'ID', allowedRequestIds);
    return;
  }

  const requestedFrontCode = readEqualsLiteralFromWhere(req.query?.SELECT?.where, 'FRONT_CODE');
  const allowedRequestIds = await getAllowedRequestIds(tx, req, {
    frontCode: requestedFrontCode || null,
    excludeDeleted: true
  });

  addEquals(req, 'ISDELETED', false);
  addInValues(req, 'ID', allowedRequestIds);
}

async function beforeReadRequests(req) {
  const tx = cds.tx(req);
  const requestId = requestedEntityId(req);
  if (requestId) {
    await ensureRequestAccess(tx, req, requestId);
    return;
  }

  const allowedRequestIds = await getAllowedRequestIds(tx, req);
  addInValues(req, 'ID', allowedRequestIds);
}

async function beforeReadRequestValues(req) {
  const tx = cds.tx(req);
  const allowedRequestIds = await getAllowedRequestIds(tx, req);
  addInValues(req, 'REQUEST_ID', allowedRequestIds);
}

async function beforeReadRequestComments(req) {
  const tx = cds.tx(req);
  const allowedRequestIds = await getAllowedRequestIds(tx, req);
  addInValues(req, 'REQUEST_ID', allowedRequestIds);
}

async function beforeReadRequestFieldChangeLogs(req) {
  const tx = cds.tx(req);
  const allowedRequestIds = await getAllowedRequestIds(tx, req);
  addInValues(req, 'REQUEST_ID', allowedRequestIds);
}

async function beforeReadRequestActions(req) {
  const tx = cds.tx(req);
  const allowedRequestIds = await getAllowedRequestIds(tx, req);
  addInValues(req, 'REQUEST_ID', allowedRequestIds);
}

async function beforeReadRequestSapMessages(req) {
  const tx = cds.tx(req);
  const allowedRequestIds = await getAllowedRequestIds(tx, req);
  addInValues(req, 'REQUEST_ID', allowedRequestIds);
}

module.exports = {
  beforeReadRequestsOverview,
  beforeReadRequests,
  beforeReadRequestValues,
  beforeReadRequestComments,
  beforeReadRequestFieldChangeLogs,
  beforeReadRequestActions,
  beforeReadRequestSapMessages
};
