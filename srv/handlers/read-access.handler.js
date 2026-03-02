const cds = require('@sap/cds');
const { resolveGroups } = require('./auth.handler');
const { getRequestById, getUserRoleAssignments } = require('./_lib/mdg-workflow.util');

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

  const groupIn = resolvedGroups.map(() => '?').join(',');
  let sql = `SELECT DISTINCT r."ID" AS "ID"
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

  const params = [...resolvedGroups];
  if (frontCode) params.push(frontCode);
  const rows = await tx.run(sql, params);
  return rows.map((row) => row.ID);
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
}

async function beforeReadRequestsOverview(req) {
  const tx = cds.tx(req);
  const requestId = requestedEntityId(req);

  // Key reads (single request) must not force default FRONT_CODE=MTO.
  // Otherwise FTD (or other fronts) are filtered out even with a valid ID.
  if (requestId) {
    const allowedRequestIds = await getAllowedRequestIds(tx, req, {
      excludeDeleted: true
    });
    addEquals(req, 'ISDELETED', false);
    addInValues(req, 'ID', allowedRequestIds);
    return;
  }

  const requestedFrontCode = readEqualsLiteralFromWhere(req.query?.SELECT?.where, 'FRONT_CODE');
  const effectiveFrontCode = requestedFrontCode || 'MTO';
  const allowedRequestIds = await getAllowedRequestIds(tx, req, {
    frontCode: effectiveFrontCode,
    excludeDeleted: true
  });

  if (!requestedFrontCode) addEquals(req, 'FRONT_CODE', effectiveFrontCode);
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

module.exports = {
  beforeReadRequestsOverview,
  beforeReadRequests,
  beforeReadRequestValues,
  beforeReadRequestComments,
  beforeReadRequestFieldChangeLogs
};
