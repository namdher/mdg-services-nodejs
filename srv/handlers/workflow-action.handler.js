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

const I18N = Object.freeze({
  en: {
    idRequired: 'ID is required',
    requestNotFound: 'Request not found: {requestId}',
    requestDeleted: 'Request is deleted',
    actionOnlyInReview: 'Action {actionName} is only allowed when request is IN_REVIEW',
    onlyManagerCanExecute: 'Only MANAGER (ROLE_CODE=APPROVER) can execute this action',
    noSapTargetConfigured: 'No SAP target configured for process {processCode} in MDG_SAP_TARGET'
  },
  es: {
    idRequired: 'ID es requerido',
    requestNotFound: 'Solicitud no encontrada: {requestId}',
    requestDeleted: 'La solicitud está eliminada',
    actionOnlyInReview: 'La acción {actionName} solo está permitida cuando la solicitud está en IN_REVIEW',
    onlyManagerCanExecute: 'Solo MANAGER (ROLE_CODE=APPROVER) puede ejecutar esta acción',
    noSapTargetConfigured: 'No hay target SAP configurado para el proceso {processCode} en MDG_SAP_TARGET'
  }
});
const STATUS_COMPLETED = STATUS.APPROVED;

function _detectLocale(req) {
  const raw = String(
    req?.locale ||
    req?.user?.locale ||
    req?.headers?.['accept-language'] ||
    req?._?.req?.headers?.['accept-language'] ||
    ''
  ).toLowerCase();
  if (raw.startsWith('es')) return 'es';
  return 'en';
}

function _t(req, key, params = {}) {
  const locale = _detectLocale(req);
  const bundle = I18N[locale] || I18N.en;
  const fallback = I18N.en[key] || key;
  const template = bundle[key] || fallback;
  return template.replace(/\{(\w+)\}/g, (_, token) => String(params[token] ?? ''));
}

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

function _extractCorrelationId(responseHeaders, errorHeaders) {
  const pick = (headers, key) => {
    if (!headers || typeof headers !== 'object') return null;
    const target = String(key).toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (String(k).toLowerCase() !== target) continue;
      if (Array.isArray(v)) return v[0] || null;
      return v ?? null;
    }
    return null;
  };
  return pick(responseHeaders, 'x-correlation-id')
    || pick(responseHeaders, 'sap-correlationid')
    || pick(responseHeaders, 'sap-request-id')
    || pick(errorHeaders, 'x-correlation-id')
    || pick(errorHeaders, 'sap-correlationid')
    || pick(errorHeaders, 'sap-request-id')
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
  return text ? text.slice(0, 200) : 'SAP integration error';
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

async function _resolveSapTargetConfig(tx, { processId, operation = 'POST' }) {
  try {
    const rows = await tx.run(
      `SELECT "ID", "DESTINATION_NAME", "SERVICE_PATH", "ENTITYSET", "OPERATION"
         FROM "MDG_SAP_TARGET"
        WHERE "PROCESS_ID" = ?
          AND "IS_ENABLED" = true
          AND UPPER(COALESCE("OPERATION", 'POST')) = UPPER(?)
        ORDER BY "ID"`,
      [processId, operation]
    );
    if (!rows?.[0]) return null;
    return {
      id: rows[0].ID,
      destinationName: rows[0].DESTINATION_NAME,
      servicePath: rows[0].SERVICE_PATH,
      entitySet: rows[0].ENTITYSET,
      operation: rows[0].OPERATION
    };
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
  sapTarget,
  payload,
  userId,
  previousStatus,
  skippedFields = []
}) {
  const destinationName = String(sapTarget?.destinationName || '').trim();
  const servicePath = String(sapTarget?.servicePath || '').trim();
  const entitySet = String(sapTarget?.entitySet || '').trim();
  const sapTargetId = sapTarget?.id || null;

  if (Array.isArray(skippedFields) && skippedFields.length) {
    console.warn('[SAP_PAYLOAD_SKIPPED_FIELDS]', JSON.stringify({
      requestId,
      processCode,
      entitySet,
      count: skippedFields.length,
      skippedFields
    }));
  }

  const url = `${servicePath.replace(/\/+$/, '')}/${entitySet}`;
  let status = 500;
  let responseBody = null;
  let responseHeaders = null;
  let errorHeaders = null;

  try {
    const res = await executeHttpRequest(
      { destinationName },
      {
      method: 'POST',
      url,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      data: payload
      },
      {
        fetchCsrfToken: true
      }
    );
    status = Number(res?.status || 200);
    responseBody = res?.data ?? null;
    responseHeaders = res?.headers ?? null;
  } catch (err) {
    status = Number(err?.response?.status || err?.statusCode || 500);
    responseBody = err?.response?.data ?? err?.data ?? { error: err?.message || 'S/4 POST failed' };
    errorHeaders = err?.response?.headers ?? err?.headers ?? null;
  }

  const correlationId = _extractCorrelationId(responseHeaders, errorHeaders);
  console.log('[SAP_POST_RESULT]', {
    processCode,
    entitySet,
    status,
    correlationId
  });
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
    skippedFields,
    sapObjectKey
  };
}

async function _handleDecision(req, { actionName, toStatus, taskDecision }) {
  const tx = cds.tx(req);
  const userId = currentUserId(req);

  const requestId = req.data?.ID || req.data?.requestId;
  const comment = typeof (req.data?.COMMENT ?? req.data?.comment) === 'string'
    ? (req.data.COMMENT ?? req.data.comment).trim()
    : '';

  if (!requestId) req.reject(400, _t(req, 'idRequired'));

  const request = await getRequestById(tx, requestId);
  if (!request) req.reject(404, _t(req, 'requestNotFound', { requestId }));
  if (request.ISDELETED) req.reject(409, _t(req, 'requestDeleted'));

  const status = normalizeStatus(request.STATUS);
  if (status !== STATUS.IN_REVIEW) {
    req.reject(409, _t(req, 'actionOnlyInReview', { actionName }));
  }

  const assignments = await getUserRoleAssignments(tx, req, {
    processId: request.PROCESS_ID,
    countryCode: request.COUNTRY_CODE
  });

  const manager = findAssignment(assignments, ROLE_CODES.APPROVER);
  if (!manager) {
    req.reject(403, _t(req, 'onlyManagerCanExecute'));
  }

  let approveResult = null;
  if (actionName === 'APPROVE') {
    const process = await _resolveProcessForRequest(tx, requestId);
    const processCode = process?.PROCESS_CODE || null;
    const processId = process?.PROCESS_ID || request.PROCESS_ID;
    const sapTarget = await _resolveSapTargetConfig(tx, { processId, operation: 'POST' });
    if (!sapTarget?.entitySet || !sapTarget?.destinationName || !sapTarget?.servicePath) {
      req.reject(422, _t(req, 'noSapTargetConfigured', { processCode: processCode || 'UNKNOWN' }));
    }

    const { payload, skippedFields } = await _buildSapPayload(tx, requestId, sapTarget.entitySet, processId);
    approveResult = await _postToS4AndPersist(tx, {
      requestId,
      processId,
      processCode,
      sapTarget,
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

  if (actionName === 'APPROVE' && approveResult?.ok) {
    const objectKey = String(approveResult?.sapObjectKey || '').trim();
    const successMessage = objectKey
      ? `Aprobación enviada exitosamente a SAP. ID generado: ${objectKey}.`
      : `Aprobación enviada exitosamente a SAP (HTTP ${approveResult?.httpStatus ?? 200}).`;
    await insertComment(tx, {
      requestId,
      authorUser: userId,
      authorRole: roleToBusinessName(ROLE_CODES.APPROVER),
      message: successMessage
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
