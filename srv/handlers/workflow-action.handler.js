const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { getEntitySetSchema } = require('./_lib/edmx-zmdg-dm.parser');
const { convertValueForSap } = require('./_lib/type-convert');
const {
  ROLE_CODES,
  STATUS,
  currentUserId,
  findAssignment,
  getRequestById,
  getUserRoleAssignments,
  insertActionLog,
  insertComment,
  normalizeStatus,
  roleToBusinessName,
  updateApprovalTaskOnDecision
} = require('./_lib/mdg-workflow.util');
const { SYSTEM_FIELD_ID, areValuesEqual, insertRequestFieldChangeLog } = require('./_lib/request-change-log.util');

const S4_DESTINATION_NAME = 'S4H-TECH';
const S4_SERVICE_PATH = '/sap/opu/odata/sap/ZMDG_DM_SRV';
const PROCESS_TO_ENTITYSET = Object.freeze({
  CUSTOMER_CREATION: 'ClientesGeneralSet',
  CUSTOMER_EXTEND_SALESAREA: 'ClientesOrgVentaSet',
  CUSTOMER_EXTEND_COMPANYCODE: 'ClientesEmpresarialSet',
  CUSTOMER_DATA_BANK: 'ClientesBancoSet',
  CUSTOMER_TAX_OUTPUT: 'ClientesImpuestosSet',
  CUSTOMER_NIF: 'ClientesNIFSet'
});
const STATUS_COMPLETED = STATUS.APPROVED;
const CSRF_CACHE = new Map();

function _normalizePropertyName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function _stringifySafe(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function _extractHeaderValue(headers, key) {
  if (!headers || typeof headers !== 'object') return null;
  const target = String(key).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() !== target) continue;
    // Keep all Set-Cookie entries; CSRF validation may require full cookie context.
    if (Array.isArray(v) && target === 'set-cookie') return v;
    if (Array.isArray(v)) return v[0] || null;
    return v ?? null;
  }
  return null;
}

function _buildCookieHeader(setCookieHeader) {
  if (!setCookieHeader) return null;
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const pairs = raw
    .map((c) => String(c || '').split(';')[0].trim())
    .filter(Boolean);
  return pairs.length ? pairs.join('; ') : null;
}

function _responseBodyToText(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  try {
    return JSON.stringify(body);
  } catch (_err) {
    return String(body);
  }
}

function _isCsrfFailure(err) {
  const status = Number(err?.response?.status || err?.statusCode || 0);
  if (status !== 403) return false;
  const bodyText = _responseBodyToText(err?.response?.data).toLowerCase();
  const msgText = String(err?.message || '').toLowerCase();
  const text = `${bodyText} ${msgText}`;
  return text.includes('csrf') || text.includes('token');
}

async function _fetchCsrfContext({ forceRefresh = false, fetchUrl } = {}) {
  const key = `${S4_DESTINATION_NAME}::${fetchUrl || '$metadata'}`;
  if (!forceRefresh && CSRF_CACHE.has(key)) {
    return CSRF_CACHE.get(key);
  }

  const metadataUrl = fetchUrl || `${S4_SERVICE_PATH.replace(/\/+$/, '')}/`;
  const res = await executeHttpRequest(
    { destinationName: S4_DESTINATION_NAME },
    {
      method: 'GET',
      url: metadataUrl,
      headers: {
        'X-CSRF-Token': 'Fetch',
        Accept: 'application/json, application/xml, text/xml, application/atom+xml, */*'
      }
    }
  );

  const headers = res?.headers || {};
  const csrfContext = {
    token: _extractHeaderValue(headers, 'x-csrf-token') || null,
    cookie: _buildCookieHeader(_extractHeaderValue(headers, 'set-cookie')) || null
  };
  CSRF_CACHE.set(key, csrfContext);
  return csrfContext;
}

function _extractCorrelationId(responseHeaders, errorHeaders) {
  return _extractHeaderValue(responseHeaders, 'x-correlation-id')
    || _extractHeaderValue(responseHeaders, 'sap-correlationid')
    || _extractHeaderValue(responseHeaders, 'sap-request-id')
    || _extractHeaderValue(errorHeaders, 'x-correlation-id')
    || _extractHeaderValue(errorHeaders, 'sap-correlationid')
    || _extractHeaderValue(errorHeaders, 'sap-request-id')
    || null;
}

function _extractSapObjectKey(body) {
  if (!body) return null;
  const data = body?.d || body;
  if (!data || typeof data !== 'object') return null;
  const candidates = ['SAP_OBJECT_KEY', 'SapObjectKey', 'ObjectKey', 'BusinessPartner', 'Partner', 'Kunnr', 'Customer'];
  for (const key of candidates) {
    const value = data[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).slice(0, 80);
    }
  }
  return null;
}

function _extractSapErrorMessage(body) {
  const message = body?.error?.message?.value || body?.error?.message || null;
  if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 200);
  const text = _responseBodyToText(body).trim();
  return text ? text.slice(0, 200) : 'Error de integración SAP';
}

function _buildSkippedFieldsComment(skippedFields) {
  if (!Array.isArray(skippedFields) || skippedFields.length === 0) return null;
  const compact = skippedFields.map((s) => ({
    fieldCode: s?.fieldCode || null,
    sapField: s?.sapField || null,
    reason: s?.reason || null
  }));
  const raw = _stringifySafe({ count: skippedFields.length, skippedFields: compact }) || '';
  return raw.length > 1000 ? `${raw.slice(0, 997)}...` : raw;
}

async function _resolveProcessForRequest(tx, requestId) {
  const rows = await tx.run(
    `SELECT
        p."ID"           AS "PROCESS_ID",
        p."PROCESS_CODE" AS "PROCESS_CODE"
       FROM "MDG_REQUEST_HEADER" r
       JOIN "MDG_PROCESS" p
         ON p."ID" = r."PROCESS_ID"
      WHERE r."ID" = ?`,
    [requestId]
  );
  return rows?.[0] || null;
}

async function _resolveSapTargetId(tx, { processId, entitySet }) {
  try {
    const rows = await tx.run(
      `SELECT "ID"
         FROM "MDG_SAP_TARGET"
        WHERE "PROCESS_ID" = ?
          AND "IS_ENABLED" = true
          AND "DESTINATION_NAME" = ?
          AND "SERVICE_PATH" = ?
          AND "ENTITYSET" = ?
        ORDER BY "ID"`,
      [processId, S4_DESTINATION_NAME, S4_SERVICE_PATH, entitySet]
    );
    if (rows?.[0]?.ID) return rows[0].ID;

    // Fallback: accept configuration variants on destination/service path
    // while still scoping by process + entityset + enabled.
    const fallbackRows = await tx.run(
      `SELECT "ID"
         FROM "MDG_SAP_TARGET"
        WHERE "PROCESS_ID" = ?
          AND "IS_ENABLED" = true
          AND UPPER("ENTITYSET") = UPPER(?)
        ORDER BY "ID"`,
      [processId, entitySet]
    );
    return fallbackRows?.[0]?.ID || null;
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('mdg_sap_target') && (msg.includes('invalid table') || msg.includes('not found') || msg.includes('does not exist'))) {
      return null;
    }
    throw err;
  }
}

async function _buildSapPayload(tx, requestId, entitySet, processId) {
  let scopedProcessId = processId;
  if (!scopedProcessId) {
    const reqRows = await tx.run(
      `SELECT "PROCESS_ID"
         FROM "MDG_REQUEST_HEADER"
        WHERE "ID" = ?`,
      [requestId]
    );
    scopedProcessId = reqRows?.[0]?.PROCESS_ID || null;
  }

  const allowedFieldRows = scopedProcessId
    ? await tx.run(
      `SELECT DISTINCT bf."FIELD_ID" AS "FIELD_ID"
         FROM "MDG_PROCESS_BLOCK" pb
         JOIN "MDG_BLOCK_FIELD" bf
           ON bf."BLOCK_ID" = pb."BLOCK_ID"
        WHERE pb."PROCESS_ID" = ?`,
      [scopedProcessId]
    )
    : [];

  const allowedFieldIds = (allowedFieldRows || [])
    .map((r) => r.FIELD_ID)
    .filter(Boolean);

  if (!allowedFieldIds.length) {
    return { payload: {}, skippedFields: [] };
  }

  const inClause = allowedFieldIds.map(() => '?').join(',');
  const rows = await tx.run(
    `SELECT
        v."FIELD_ID"  AS "FIELD_ID",
        v."LINE_NO"   AS "LINE_NO",
        v."VALUE"     AS "VALUE",
        c."FIELD_CODE" AS "FIELD_CODE",
        c."SAP_FIELD" AS "SAP_FIELD",
        c."DATA_TYPE" AS "DATA_TYPE"
       FROM "MDG_REQUEST_FIELD_VALUE" v
       JOIN "MDG_FIELD_CATALOG" c
         ON c."ID" = v."FIELD_ID"
      WHERE v."REQUEST_ID" = ?
        AND v."FIELD_ID" IN (${inClause})
        AND c."SAP_FIELD" IS NOT NULL
        AND LENGTH(TRIM(c."SAP_FIELD")) > 0
      ORDER BY
        v."FIELD_ID",
        CASE WHEN v."LINE_NO" = 1 THEN 0 ELSE 1 END,
        v."LINE_NO",
        v."ID"`,
    [requestId, ...allowedFieldIds]
  );

  const entitySchema = getEntitySetSchema(entitySet);
  const metadataProps = entitySchema?.properties || {};
  const canonicalProps = new Map();
  for (const [propName, propType] of Object.entries(metadataProps)) {
    const key = _normalizePropertyName(propName);
    if (!key || canonicalProps.has(key)) continue;
    canonicalProps.set(key, { propName, propType });
  }

  const selectedFieldIds = new Set();
  const payload = {};
  const skippedFields = [];

  for (const row of rows || []) {
    const fieldId = row.FIELD_ID;
    if (selectedFieldIds.has(fieldId)) continue;
    selectedFieldIds.add(fieldId);

    const sapField = String(row.SAP_FIELD || '').trim();
    const rawValue = row.VALUE;
    if (!sapField) {
      skippedFields.push({ fieldId, fieldCode: row.FIELD_CODE, sapField, reason: 'missing_sap_field' });
      continue;
    }

    let canonicalSapField = sapField;
    let edmType = metadataProps[sapField];
    if (!edmType) {
      const canonical = canonicalProps.get(_normalizePropertyName(sapField));
      if (canonical) {
        canonicalSapField = canonical.propName;
        edmType = canonical.propType;
      }
    }

    if (!edmType) {
      skippedFields.push({ fieldId, fieldCode: row.FIELD_CODE, sapField, reason: 'property_not_in_metadata' });
      continue;
    }

    const conversion = convertValueForSap(rawValue, { edmType, fallbackDataType: row.DATA_TYPE });
    if (!conversion.ok) {
      skippedFields.push({
        fieldId,
        fieldCode: row.FIELD_CODE,
        sapField: canonicalSapField,
        reason: conversion.reason || 'type_conversion_failed'
      });
      continue;
    }

    payload[canonicalSapField] = conversion.value;
  }

  return { payload, skippedFields };
}

async function _postToS4AndPersist(tx, {
  requestId,
  processId,
  processCode,
  entitySet,
  payload,
  userId,
  previousStatus,
  skippedFields = []
}) {
  if (Array.isArray(skippedFields) && skippedFields.length) {
    console.warn('[SAP_PAYLOAD_SKIPPED_FIELDS]', JSON.stringify({
      requestId,
      processCode,
      entitySet,
      count: skippedFields.length,
      skippedFields
    }));
  }

  const url = `${S4_SERVICE_PATH.replace(/\/+$/, '')}/${entitySet}`;
  const csrfFetchUrl = `${S4_SERVICE_PATH.replace(/\/+$/, '')}/`;
  let sapTargetId = await _resolveSapTargetId(tx, { processId, entitySet });
  if (!sapTargetId) {
    // Fallback mode: routing is code-driven (process -> entityset),
    // keep persistence working even without MDG_SAP_TARGET configuration.
    sapTargetId = processId;
    console.warn('[SAP_TARGET_FALLBACK]', {
      requestId,
      processId,
      processCode,
      entitySet,
      sapTargetId
    });
  }
  let status = 500;
  let responseBody = null;
  let responseHeaders = null;
  let errorHeaders = null;

  try {
    let csrf = await _fetchCsrfContext({ fetchUrl: csrfFetchUrl });
    const res = await executeHttpRequest(
      { destinationName: S4_DESTINATION_NAME },
      {
        method: 'POST',
        url,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(csrf?.token ? { 'X-CSRF-Token': csrf.token } : {}),
          ...(csrf?.cookie ? { Cookie: csrf.cookie } : {})
        },
        data: payload
      }
    );
    status = Number(res?.status || 200);
    responseBody = res?.data ?? null;
    responseHeaders = res?.headers ?? null;
  } catch (err) {
    if (_isCsrfFailure(err)) {
      try {
        const csrf = await _fetchCsrfContext({ forceRefresh: true, fetchUrl: csrfFetchUrl });
        const retryRes = await executeHttpRequest(
          { destinationName: S4_DESTINATION_NAME },
          {
            method: 'POST',
            url,
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              ...(csrf?.token ? { 'X-CSRF-Token': csrf.token } : {}),
              ...(csrf?.cookie ? { Cookie: csrf.cookie } : {})
            },
            data: payload
          }
        );
        status = Number(retryRes?.status || 200);
        responseBody = retryRes?.data ?? null;
        responseHeaders = retryRes?.headers ?? null;
      } catch (retryErr) {
        status = Number(retryErr?.response?.status || retryErr?.statusCode || 500);
        responseBody = retryErr?.response?.data ?? { error: retryErr?.message || 'S/4 POST failed' };
        errorHeaders = retryErr?.response?.headers ?? null;
      }
    } else {
      status = Number(err?.response?.status || err?.statusCode || 500);
      responseBody = err?.response?.data ?? { error: err?.message || 'S/4 POST failed' };
      errorHeaders = err?.response?.headers ?? null;
    }
  }

  const correlationId = _extractCorrelationId(responseHeaders, errorHeaders);
  const sapObjectKey = _extractSapObjectKey(responseBody);
  const payloadJson = _stringifySafe(payload) || '{}';
  const responseJson = _stringifySafe(responseBody) || '';

  await tx.run(
    `INSERT INTO "MDG_REQUEST_SAP_MESSAGE"
     ("ID", "REQUEST_ID", "SAP_TARGET_ID", "HTTP_STATUS", "CORRELATION_ID", "SAP_OBJECT_KEY", "PAYLOAD_JSON", "RESPONSE_JSON", "CREATEDAT")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cds.utils.uuid(), requestId, sapTargetId, status, correlationId, sapObjectKey, payloadJson, responseJson, new Date()]
  );

  const ok = status >= 200 && status < 300;
  const finalStatus = ok ? STATUS_COMPLETED : STATUS.REWORK;
  const currentHeaderRows = await tx.run(
    `SELECT "SUBJECT_ID", "SUBJECT_TYPE"
       FROM "MDG_REQUEST_HEADER"
      WHERE "ID" = ?`,
    [requestId]
  );
  const beforeSubjectId = currentHeaderRows?.[0]?.SUBJECT_ID ?? null;
  const beforeSubjectType = currentHeaderRows?.[0]?.SUBJECT_TYPE ?? null;

  await tx.run(
    `UPDATE "MDG_REQUEST_HEADER"
        SET "STATUS" = ?,
            "MODIFIEDAT" = ?,
            "MODIFIEDBY" = ?
      WHERE "ID" = ?`,
    [finalStatus, new Date(), userId, requestId]
  );
  if (!areValuesEqual(previousStatus, finalStatus)) {
    await insertRequestFieldChangeLog(tx, {
      requestId,
      fieldId: SYSTEM_FIELD_ID,
      fieldCode: 'MDG_REQUEST_HEADER.STATUS',
      oldValue: previousStatus,
      newValue: finalStatus,
      changeType: 'UPDATE',
      changedBy: userId,
      changedRole: ROLE_CODES.APPROVER,
      source: 'WORKFLOW_APPROVE'
    });
  }

  if (finalStatus === STATUS_COMPLETED && processCode === 'CUSTOMER_CREATION' && sapObjectKey) {
    await tx.run(
      `UPDATE "MDG_REQUEST_HEADER"
          SET "SUBJECT_ID" = ?,
              "SUBJECT_TYPE" = 'CUSTOMER',
              "MODIFIEDAT" = ?,
              "MODIFIEDBY" = ?
        WHERE "ID" = ?`,
      [sapObjectKey, new Date(), userId, requestId]
    );
    if (!areValuesEqual(beforeSubjectId, sapObjectKey)) {
      await insertRequestFieldChangeLog(tx, {
        requestId,
        fieldId: SYSTEM_FIELD_ID,
        fieldCode: 'MDG_REQUEST_HEADER.SUBJECT_ID',
        oldValue: beforeSubjectId,
        newValue: sapObjectKey,
        changeType: 'UPDATE',
        changedBy: userId,
        changedRole: ROLE_CODES.APPROVER,
        source: 'WORKFLOW_APPROVE'
      });
    }
    if (!areValuesEqual(beforeSubjectType, 'CUSTOMER')) {
      await insertRequestFieldChangeLog(tx, {
        requestId,
        fieldId: SYSTEM_FIELD_ID,
        fieldCode: 'MDG_REQUEST_HEADER.SUBJECT_TYPE',
        oldValue: beforeSubjectType,
        newValue: 'CUSTOMER',
        changeType: 'UPDATE',
        changedBy: userId,
        changedRole: ROLE_CODES.APPROVER,
        source: 'WORKFLOW_APPROVE'
      });
    }
  }

  if (!ok) {
    const sapErrorMessage = _extractSapErrorMessage(responseBody);
    await insertComment(tx, {
      requestId,
      authorUser: userId,
      authorRole: roleToBusinessName(ROLE_CODES.APPROVER),
      message: `Error SAP: ${sapErrorMessage}`
    });
    await insertActionLog(tx, {
      requestId,
      action: 'SAP_ERROR',
      actorUser: userId,
      actorRole: ROLE_CODES.APPROVER,
      comment: sapErrorMessage
    });
  }

  return {
    ok,
    requestId,
    processCode,
    entitySet,
    httpStatus: status,
    finalStatus,
    skippedFields
  };
}

async function _handleDecision(req, { actionName, toStatus, taskDecision }) {
  const tx = cds.tx(req);
  const userId = currentUserId(req);

  const requestId = req.data?.ID || req.data?.requestId;
  const comment = typeof (req.data?.COMMENT ?? req.data?.comment) === 'string'
    ? (req.data.COMMENT ?? req.data.comment).trim()
    : '';

  if (!requestId) req.reject(400, 'ID is required');

  const request = await getRequestById(tx, requestId);
  if (!request) req.reject(404, `Request not found: ${requestId}`);
  if (request.ISDELETED) req.reject(409, 'Request is deleted');

  const status = normalizeStatus(request.STATUS);
  if (status !== STATUS.IN_REVIEW) {
    req.reject(409, `Action ${actionName} is only allowed when request is IN_REVIEW`);
  }

  const assignments = await getUserRoleAssignments(tx, req, {
    processId: request.PROCESS_ID,
    countryCode: request.COUNTRY_CODE
  });

  const manager = findAssignment(assignments, ROLE_CODES.APPROVER);
  if (!manager) {
    req.reject(403, 'Only MANAGER (ROLE_CODE=APPROVER) can execute this action');
  }

  let approveResult = null;
  if (actionName === 'APPROVE') {
    const process = await _resolveProcessForRequest(tx, requestId);
    const processCode = process?.PROCESS_CODE || null;
    const processId = process?.PROCESS_ID || request.PROCESS_ID;
    const entitySet = PROCESS_TO_ENTITYSET[processCode];
    if (!entitySet) {
      req.reject(400, `Unsupported process for S/4 submit: ${processCode || 'UNKNOWN'}`);
    }

    const { payload, skippedFields } = await _buildSapPayload(tx, requestId, entitySet, processId);
    approveResult = await _postToS4AndPersist(tx, {
      requestId,
      processId,
      processCode,
      entitySet,
      payload,
      userId,
      previousStatus: status,
      skippedFields
    });
  } else {
    await tx.run(
      `UPDATE "MDG_REQUEST_HEADER"
          SET "STATUS" = ?,
              "MODIFIEDAT" = ?,
              "MODIFIEDBY" = ?
        WHERE "ID" = ?`,
      [toStatus, new Date(), userId, requestId]
    );
    if (!areValuesEqual(status, toStatus)) {
      await insertRequestFieldChangeLog(tx, {
        requestId,
        fieldId: SYSTEM_FIELD_ID,
        fieldCode: 'MDG_REQUEST_HEADER.STATUS',
        oldValue: status,
        newValue: toStatus,
        changeType: 'UPDATE',
        changedBy: userId,
        changedRole: ROLE_CODES.APPROVER,
        source: 'WORKFLOW_REJECT'
      });
    }
  }

  if (comment) {
    await insertComment(tx, {
      requestId,
      authorUser: userId,
      authorRole: roleToBusinessName(ROLE_CODES.APPROVER),
      message: comment
    });
  }

  if (actionName === 'APPROVE' && Array.isArray(approveResult?.skippedFields) && approveResult.skippedFields.length > 0) {
    await insertActionLog(tx, {
      requestId,
      action: 'SAP_SKIPPED_FIELDS',
      actorUser: userId,
      actorRole: ROLE_CODES.APPROVER,
      comment: _buildSkippedFieldsComment(approveResult.skippedFields)
    });
  }

  await insertActionLog(tx, {
    requestId,
    action: actionName,
    actorUser: userId,
    actorRole: ROLE_CODES.APPROVER,
    comment: comment || null
  });

  await updateApprovalTaskOnDecision(tx, {
    requestId,
    processRoleId: manager.PROCESS_ROLE_ID,
    decision: actionName === 'APPROVE' && !approveResult?.ok ? 'ERROR' : taskDecision,
    comment: comment || null,
    actorUser: userId
  });

  if (actionName === 'APPROVE') {
    return JSON.stringify({
      ok: Boolean(approveResult?.ok),
      requestId: approveResult?.requestId || requestId,
      processCode: approveResult?.processCode || null,
      entitySet: approveResult?.entitySet || null,
      httpStatus: approveResult?.httpStatus || null,
      finalStatus: approveResult?.finalStatus || null,
      skippedFields: approveResult?.skippedFields || []
    });
  }

  return JSON.stringify({ ok: true, requestId, status: toStatus, action: actionName });
}

async function approveRequest(req) {
  return _handleDecision(req, {
    actionName: 'APPROVE',
    toStatus: STATUS.APPROVED,
    taskDecision: 'APPROVED'
  });
}

async function rejectRequest(req) {
  return _handleDecision(req, {
    actionName: 'REJECT',
    toStatus: STATUS.REWORK,
    taskDecision: 'REJECTED'
  });
}

function register(service) {
  service.on('approveRequest', approveRequest);
  service.on('rejectRequest', rejectRequest);
}

module.exports = { register };
