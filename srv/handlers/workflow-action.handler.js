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
    noSapTargetConfigured: 'No SAP target configured for process {processCode} in MDG_SAP_TARGET',
    noSapTargetForEntitySet: 'No SAP target configured for process {processCode} and entity set {entitySet}',
    invalidDestfactFlags: 'Invalid controls: EXTEND_DESTFACT_SALES=true requires CREATE_DESTFACT=true',
    mandatoryFieldsMissingForStep: 'Mandatory fields missing for step {entitySet}: {fields}'
  },
  es: {
    idRequired: 'ID es requerido',
    requestNotFound: 'Solicitud no encontrada: {requestId}',
    requestDeleted: 'La solicitud está eliminada',
    actionOnlyInReview: 'La acción {actionName} solo está permitida cuando la solicitud está en IN_REVIEW',
    onlyManagerCanExecute: 'Solo MANAGER (ROLE_CODE=APPROVER) puede ejecutar esta acción',
    noSapTargetConfigured: 'No hay target SAP configurado para el proceso {processCode} en MDG_SAP_TARGET',
    noSapTargetForEntitySet: 'No hay target SAP configurado para el proceso {processCode} y entity set {entitySet}',
    invalidDestfactFlags: 'Controles inválidos: EXTEND_DESTFACT_SALES=true requiere CREATE_DESTFACT=true',
    mandatoryFieldsMissingForStep: 'Faltan campos obligatorios para el paso {entitySet}: {fields}'
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

const SAP_PROPERTY_ALIASES = Object.freeze({
  CLIENTESGENERALSET: Object.freeze({
    zzfityp: 'Fityp',
    fityp: 'Fityp'
  }),
  DESTFACTURAGENERALSET: Object.freeze({
    fityp: 'Zzfityp',
    zzfityp: 'Zzfityp'
  }),
  CONDUCTORESGENERALSET: Object.freeze({
    fityp: 'Zzfityp',
    zzfityp: 'Zzfityp'
  }),
  DESTMERCADERIAGENERALSET: Object.freeze({
    fityp: 'Zzfityp',
    zzfityp: 'Zzfityp'
  })
});

function _resolveSapPropertyAlias(entitySet, sapField) {
  const setKey = String(entitySet || '').trim().toUpperCase();
  const aliases = SAP_PROPERTY_ALIASES[setKey];
  if (!aliases) return null;
  return aliases[_normalizePropertyName(sapField)] || null;
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
  const root = body?.d || body;
  const data = Array.isArray(root?.results) ? root.results[0] : root;
  if (!data || typeof data !== 'object') return null;

  const byNorm = new Map();
  for (const [k, v] of Object.entries(data)) {
    byNorm.set(_normalizePropertyName(k), v);
  }

  const candidates = [
    'SAP_OBJECT_KEY', 'SapObjectKey', 'ObjectKey',
    'BusinessPartner', 'Partner', 'Kunnr', 'Customer',
    'Resuid', 'Material'
  ];
  for (const key of candidates) {
    const value = byNorm.get(_normalizePropertyName(key));
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim().slice(0, 80);
    }
  }

  const kunnr = byNorm.get('kunnr');
  const vkorg = byNorm.get('vkorg');
  const vtweg = byNorm.get('vtweg');
  const spart = byNorm.get('spart');
  if ([kunnr, vkorg, vtweg, spart].every((x) => x !== undefined && x !== null && String(x).trim() !== '')) {
    return `KUNNR=${String(kunnr).trim()};VKORG=${String(vkorg).trim()};VTWEG=${String(vtweg).trim()};SPART=${String(spart).trim()}`.slice(0, 80);
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
  const rows = await _resolveSapTargetsForProcess(tx, { processId, operation });
  return rows?.[0] || null;
}

async function _resolveSapTargetsForProcess(tx, { processId, operation = 'POST' }) {
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
    return (rows || []).map((r) => ({
      id: r.ID,
      destinationName: r.DESTINATION_NAME,
      servicePath: r.SERVICE_PATH,
      entitySet: r.ENTITYSET,
      operation: r.OPERATION
    }));
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('mdg_sap_target') && (msg.includes('invalid table') || msg.includes('not found') || msg.includes('does not exist'))) {
      return [];
    }
    throw err;
  }
}

function _pickSapTargetByEntitySet(targets, entitySet) {
  const wanted = String(entitySet || '').trim().toUpperCase();
  if (!wanted) return null;
  return (targets || []).find((t) => String(t?.entitySet || '').trim().toUpperCase() === wanted) || null;
}

function _parseBooleanLike(value) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined) return false;
  const v = String(value).trim().toLowerCase();
  if (!v) return false;
  return v === 'true' || v === 'x' || v === '1' || v === 'y' || v === 'yes' || v === 'si' || v === 'sí';
}

async function _readCustomerCreationControls(tx, requestId) {
  const rows = await tx.run(
    `SELECT c."FIELD_CODE" AS "FIELD_CODE", v."VALUE" AS "VALUE"
       FROM "MDG_REQUEST_FIELD_VALUE" v
       JOIN "MDG_FIELD_CATALOG" c
         ON c."ID" = v."FIELD_ID"
      WHERE v."REQUEST_ID" = ?
        AND c."FIELD_CODE" IN ('MDG_CTRL.CREATE_DESTFACT', 'MDG_CTRL.EXTEND_DESTFACT_SALES')
      ORDER BY v."LINE_NO", v."ID"`,
    [requestId]
  );

  const controls = {
    CREATE_DESTFACT: false,
    EXTEND_DESTFACT_SALES: false
  };
  for (const row of rows || []) {
    const code = String(row.FIELD_CODE || '').trim().toUpperCase();
    const parsed = _parseBooleanLike(row.VALUE);
    if (code === 'MDG_CTRL.CREATE_DESTFACT') controls.CREATE_DESTFACT = parsed;
    if (code === 'MDG_CTRL.EXTEND_DESTFACT_SALES') controls.EXTEND_DESTFACT_SALES = parsed;
  }
  return controls;
}

async function _buildSapPayload(tx, requestId, entitySet, processId, options = {}) {
  const fieldCodePrefixes = Array.isArray(options.fieldCodePrefixes)
    ? options.fieldCodePrefixes.map((p) => String(p || '').trim()).filter(Boolean)
    : [];
  const explicitAllowedFieldIds = Array.isArray(options.allowedFieldIds)
    ? options.allowedFieldIds.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const processRoleId = options.processRoleId || null;
  const countryCode = options.countryCode || null;
  const creationDateOverride = options.creationDateOverride || null;
  const excludeSapFields = Array.isArray(options.excludeSapFields)
    ? new Set(options.excludeSapFields.map((x) => _normalizePropertyName(x)))
    : new Set();
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

  const allowedFieldRows = explicitAllowedFieldIds.length
    ? explicitAllowedFieldIds.map((id) => ({ FIELD_ID: id }))
    : (scopedProcessId
    ? await tx.run(
      `SELECT DISTINCT bf."FIELD_ID" AS "FIELD_ID"
         FROM "MDG_PROCESS_BLOCK" pb
         JOIN "MDG_BLOCK_FIELD" bf
           ON bf."BLOCK_ID" = pb."BLOCK_ID"
        WHERE pb."PROCESS_ID" = ?`,
      [scopedProcessId]
    )
    : []);

  const allowedFieldIds = (allowedFieldRows || [])
    .map((r) => r.FIELD_ID)
    .filter(Boolean);

  if (!allowedFieldIds.length) {
    return { payload: {}, skippedFields: [] };
  }

  const inClause = allowedFieldIds.map(() => '?').join(',');
  let rows = await tx.run(
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
        v."MODIFIEDAT" DESC,
        v."ID" DESC`,
    [requestId, ...allowedFieldIds]
  );

  if (fieldCodePrefixes.length) {
    rows = (rows || []).filter((row) => {
      const code = String(row?.FIELD_CODE || '').trim();
      return fieldCodePrefixes.some((prefix) => code.startsWith(prefix));
    });
  }

  let fieldControlByFieldId = new Map();
  if (processRoleId) {
    const controls = await tx.run(
      `SELECT
          fc."ID" AS "FIELD_ID",
          COALESCE(fcc."FIELD_CONTROL_OVERRIDE", fcb."FIELD_CONTROL_BASE", 0) AS "FIELD_CONTROL"
         FROM "MDG_FIELD_CATALOG" fc
         LEFT JOIN "MDG_FIELD_CONTROL_RULE_BASE" fcb
           ON fcb."PROCESS_ROLE_ID" = ?
          AND fcb."FIELD_ID" = fc."ID"
         LEFT JOIN "MDG_FIELD_CONTROL_RULE_COUNTRY" fcc
           ON fcc."PROCESS_ROLE_ID" = ?
          AND fcc."FIELD_ID" = fc."ID"
          AND fcc."COUNTRY_CODE" = ?
        WHERE fc."ID" IN (${inClause})`,
      [processRoleId, processRoleId, countryCode, ...allowedFieldIds]
    );
    fieldControlByFieldId = new Map((controls || []).map((r) => [r.FIELD_ID, Number(r.FIELD_CONTROL ?? 0)]));
  }

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
    const fieldControl = Number(fieldControlByFieldId.get(fieldId) ?? 0);
    if (fieldControl === 7) {
      skippedFields.push({ fieldId, fieldCode: row.FIELD_CODE, sapField: row.SAP_FIELD, reason: 'hidden_by_field_control' });
      continue;
    }

    const fieldCode = String(row.FIELD_CODE || '').trim();
    if (fieldCode.toUpperCase().startsWith('MDG_CTRL.')) {
      skippedFields.push({ fieldId, fieldCode, sapField: null, reason: 'internal_control_field' });
      continue;
    }

    const sapField = String(row.SAP_FIELD || '').trim();
    let rawValue = row.VALUE;
    if (!sapField) {
      skippedFields.push({ fieldId, fieldCode: row.FIELD_CODE, sapField, reason: 'missing_sap_field' });
      continue;
    }
    const normalizedSapField = _normalizePropertyName(sapField);
    if (
      (String(entitySet || '').trim().toUpperCase() === 'CLIENTESGENERALSET' && normalizedSapField === _normalizePropertyName('Zzfechac')) ||
      excludeSapFields.has(normalizedSapField)
    ) {
      skippedFields.push({ fieldId, fieldCode: row.FIELD_CODE, sapField, reason: 'excluded_by_rule' });
      continue;
    }

    // Customer creation rule: creation date field must come from request CREATEDAT.
    if (
      creationDateOverride &&
      (
        fieldCode.toUpperCase().endsWith('.ZZFECHAC') ||
        sapField.toUpperCase() === 'ZZFECHAC'
      )
    ) {
      rawValue = creationDateOverride;
    }

    let canonicalSapField = sapField;
    let edmType = metadataProps[sapField];
    if (!edmType) {
      const alias = _resolveSapPropertyAlias(entitySet, sapField);
      if (alias && metadataProps[alias]) {
        canonicalSapField = alias;
        edmType = metadataProps[alias];
      }
    }
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

    if (!Object.prototype.hasOwnProperty.call(payload, canonicalSapField)) {
      payload[canonicalSapField] = conversion.value;
    }
  }

  return { payload, skippedFields };
}

function _toDateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function _readRequestCreatedDate(tx, requestId) {
  const rows = await tx.run(
    `SELECT "CREATEDAT"
       FROM "MDG_REQUEST_HEADER"
      WHERE "ID" = ?`,
    [requestId]
  );
  return _toDateOnly(rows?.[0]?.CREATEDAT || null);
}

async function _readLastSuccessfulSapObjectKey(tx, requestId, sapTargetId) {
  if (!requestId || !sapTargetId) return null;
  const rows = await tx.run(
    `SELECT "SAP_OBJECT_KEY"
       FROM "MDG_REQUEST_SAP_MESSAGE"
      WHERE "REQUEST_ID" = ?
        AND "SAP_TARGET_ID" = ?
        AND "HTTP_STATUS" >= 200
        AND "HTTP_STATUS" < 300
        AND "SAP_OBJECT_KEY" IS NOT NULL
        AND LENGTH(TRIM("SAP_OBJECT_KEY")) > 0
      ORDER BY "CREATEDAT" DESC, "ID" DESC
      LIMIT 1`,
    [requestId, sapTargetId]
  );
  return String(rows?.[0]?.SAP_OBJECT_KEY || '').trim() || null;
}

async function _upsertRequestSubject(tx, {
  requestId,
  subjectId,
  subjectType,
  userId,
  source = 'WORKFLOW_APPROVE'
}) {
  const nextSubjectId = String(subjectId || '').trim();
  if (!nextSubjectId) return;

  const rows = await tx.run(
    `SELECT "SUBJECT_ID", "SUBJECT_TYPE"
       FROM "MDG_REQUEST_HEADER"
      WHERE "ID" = ?`,
    [requestId]
  );
  const beforeSubjectId = rows?.[0]?.SUBJECT_ID ?? null;
  const beforeSubjectType = rows?.[0]?.SUBJECT_TYPE ?? null;
  const nextSubjectType = String(subjectType || '').trim() || beforeSubjectType || null;

  if (areValuesEqual(beforeSubjectId, nextSubjectId) && areValuesEqual(beforeSubjectType, nextSubjectType)) {
    return;
  }

  await tx.run(
    `UPDATE "MDG_REQUEST_HEADER"
        SET "SUBJECT_ID" = ?,
            "SUBJECT_TYPE" = ?,
            "MODIFIEDAT" = ?,
            "MODIFIEDBY" = ?
      WHERE "ID" = ?`,
    [nextSubjectId, nextSubjectType, new Date(), userId, requestId]
  );

  if (!areValuesEqual(beforeSubjectId, nextSubjectId)) {
    await insertRequestFieldChangeLog(tx, {
      requestId,
      fieldId: SYSTEM_FIELD_ID,
      fieldCode: 'MDG_REQUEST_HEADER.SUBJECT_ID',
      oldValue: beforeSubjectId,
      newValue: nextSubjectId,
      changeType: 'UPDATE',
      changedBy: userId,
      changedRole: ROLE_CODES.APPROVER,
      source
    });
  }
  if (!areValuesEqual(beforeSubjectType, nextSubjectType)) {
    await insertRequestFieldChangeLog(tx, {
      requestId,
      fieldId: SYSTEM_FIELD_ID,
      fieldCode: 'MDG_REQUEST_HEADER.SUBJECT_TYPE',
      oldValue: beforeSubjectType,
      newValue: nextSubjectType,
      changeType: 'UPDATE',
      changedBy: userId,
      changedRole: ROLE_CODES.APPROVER,
      source
    });
  }
}

async function _loadProcessBlockFieldMap(tx, processId, blockCodes = []) {
  const codes = (blockCodes || []).map((c) => String(c || '').trim()).filter(Boolean);
  if (!processId || !codes.length) return new Map();
  const inClause = codes.map(() => '?').join(',');
  const rows = await tx.run(
    `SELECT
        ob."BLOCK_CODE" AS "BLOCK_CODE",
        bf."FIELD_ID"   AS "FIELD_ID"
       FROM "MDG_PROCESS_BLOCK" pb
       JOIN "MDG_OBJECT_BLOCK" ob
         ON ob."ID" = pb."BLOCK_ID"
       JOIN "MDG_BLOCK_FIELD" bf
         ON bf."BLOCK_ID" = pb."BLOCK_ID"
      WHERE pb."PROCESS_ID" = ?
        AND ob."BLOCK_CODE" IN (${inClause})`,
    [processId, ...codes]
  );
  const map = new Map();
  for (const code of codes) map.set(code, []);
  for (const row of rows || []) {
    const code = String(row.BLOCK_CODE || '').trim();
    const fieldId = String(row.FIELD_ID || '').trim();
    if (!code || !fieldId) continue;
    const arr = map.get(code) || [];
    arr.push(fieldId);
    map.set(code, arr);
  }
  for (const [code, ids] of map.entries()) {
    map.set(code, Array.from(new Set(ids)));
  }
  return map;
}

function _mergeFieldIds(...lists) {
  const out = new Set();
  for (const list of lists || []) {
    for (const id of list || []) out.add(String(id));
  }
  return Array.from(out);
}

async function _validateMandatoryForFieldIds(tx, {
  requestId,
  processRoleId,
  countryCode,
  fieldIds,
  entitySet,
  payload
}) {
  const scoped = Array.from(new Set((fieldIds || []).map((x) => String(x || '').trim()).filter(Boolean)));
  if (!scoped.length || !processRoleId) return;

  const inClause = scoped.map(() => '?').join(',');
  const rows = await tx.run(
    `SELECT
        fc."ID" AS "FIELD_ID",
        fc."FIELD_CODE" AS "FIELD_CODE",
        fc."SAP_FIELD" AS "SAP_FIELD",
        COALESCE(fcc."FIELD_CONTROL_OVERRIDE", fcb."FIELD_CONTROL_BASE", 0) AS "FIELD_CONTROL",
        rv."VALUE" AS "VALUE"
       FROM "MDG_FIELD_CATALOG" fc
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_BASE" fcb
         ON fcb."PROCESS_ROLE_ID" = ?
        AND fcb."FIELD_ID" = fc."ID"
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_COUNTRY" fcc
         ON fcc."PROCESS_ROLE_ID" = ?
        AND fcc."FIELD_ID" = fc."ID"
        AND fcc."COUNTRY_CODE" = ?
       LEFT JOIN "MDG_REQUEST_FIELD_VALUE" rv
         ON rv."FIELD_ID" = fc."ID"
        AND rv."REQUEST_ID" = ?
        AND rv."LINE_NO" = 1
      WHERE fc."ID" IN (${inClause})`,
    [processRoleId, processRoleId, countryCode, requestId, ...scoped]
  );

  const schema = getEntitySetSchema(entitySet);
  const props = schema?.properties || {};
  const canonicalByNorm = new Map();
  for (const p of Object.keys(props)) canonicalByNorm.set(_normalizePropertyName(p), p);

  const missing = [];
  for (const row of rows || []) {
    const control = Number(row.FIELD_CONTROL ?? 0);
    if (control !== 1) continue; // mandatory only
    const sapField = String(row.SAP_FIELD || '').trim();
    if (!sapField) continue;
    const canonical = canonicalByNorm.get(_normalizePropertyName(sapField)) || sapField;
    const payloadVal = payload?.[canonical];
    const requestVal = row.VALUE;
    const hasPayload = payloadVal !== undefined && payloadVal !== null && String(payloadVal).trim() !== '';
    const hasRequest = requestVal !== undefined && requestVal !== null && String(requestVal).trim() !== '';
    if (!hasPayload && !hasRequest) {
      missing.push(String(row.FIELD_CODE || sapField));
    }
  }

  if (missing.length) {
    const err = new Error(`Mandatory fields missing for step ${entitySet}: ${missing.join(', ')}`);
    err.statusCode = 400;
    err.code = 'MANDATORY_FIELDS_MISSING_STEP';
    err.details = missing;
    throw err;
  }
}

async function _validateMandatoryForStep(tx, {
  requestId,
  processId,
  processRoleId,
  countryCode,
  entitySet,
  payload
}) {
  if (!processRoleId) return;
  const schema = getEntitySetSchema(entitySet);
  const props = schema?.properties || {};
  const propByNorm = new Map();
  for (const p of Object.keys(props)) propByNorm.set(_normalizePropertyName(p), p);

  const rows = await tx.run(
    `SELECT
        fc."ID" AS "FIELD_ID",
        fc."FIELD_CODE" AS "FIELD_CODE",
        fc."SAP_FIELD" AS "SAP_FIELD",
        COALESCE(fcc."FIELD_CONTROL_OVERRIDE", fcb."FIELD_CONTROL_BASE", 0) AS "FIELD_CONTROL",
        CASE
          WHEN EXISTS (
            SELECT 1
              FROM "MDG_REQUEST_FIELD_VALUE" rv
             WHERE rv."REQUEST_ID" = ?
               AND rv."FIELD_ID" = fc."ID"
               AND rv."LINE_NO" = 1
               AND rv."VALUE" IS NOT NULL
               AND LENGTH(TRIM(rv."VALUE")) > 0
          ) THEN 1
          ELSE 0
        END AS "HAS_VALUE"
       FROM "MDG_PROCESS_BLOCK" pb
       JOIN "MDG_BLOCK_FIELD" bf
         ON bf."BLOCK_ID" = pb."BLOCK_ID"
       JOIN "MDG_FIELD_CATALOG" fc
         ON fc."ID" = bf."FIELD_ID"
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_BASE" fcb
         ON fcb."PROCESS_ROLE_ID" = ?
        AND fcb."FIELD_ID" = fc."ID"
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_COUNTRY" fcc
         ON fcc."PROCESS_ROLE_ID" = ?
        AND fcc."FIELD_ID" = fc."ID"
        AND fcc."COUNTRY_CODE" = ?
      WHERE pb."PROCESS_ID" = ?
        AND fc."SAP_FIELD" IS NOT NULL
        AND LENGTH(TRIM(fc."SAP_FIELD")) > 0`,
    [requestId, processRoleId, processRoleId, countryCode, processId]
  );

  const missing = [];
  for (const row of rows || []) {
    const control = Number(row.FIELD_CONTROL ?? 0);
    if (control !== 1) continue; // mandatory only
    const canonical = propByNorm.get(_normalizePropertyName(row.SAP_FIELD));
    if (!canonical) continue; // not part of this entity set
    const payloadValue = payload?.[canonical];
    const hasPayload = payloadValue !== undefined && payloadValue !== null && String(payloadValue).trim() !== '';
    const hasRequest = Number(row.HAS_VALUE || 0) === 1;
    if (!hasPayload && !hasRequest) {
      missing.push(String(row.FIELD_CODE || row.SAP_FIELD || '').trim());
    }
  }

  if (missing.length) {
    const err = new Error(`Mandatory fields missing for step ${entitySet}: ${missing.join(', ')}`);
    err.statusCode = 400;
    err.code = 'MANDATORY_FIELDS_MISSING_STEP';
    err.details = missing;
    throw err;
  }
}

async function _postToS4AndPersist(tx, {
  requestId,
  processId,
  processCode,
  sapTarget,
  payload,
  userId,
  previousStatus,
  skippedFields = [],
  updateRequestState = true,
  emitErrorBusinessComment = true,
  updateSubjectFromSap = false
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

  if (updateRequestState) {
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
  }

  const subjectTypeByProcessCode = {
    CUSTOMER_CREATION: 'CUSTOMER',
    TRANSPORT_DRIVER_CREATION: 'DRIVER'
  };
  const subjectTypeForProcess = subjectTypeByProcessCode[String(processCode || '').trim().toUpperCase()] || null;

  if (updateSubjectFromSap && sapObjectKey) {
    const nextSubjectType = subjectTypeForProcess || beforeSubjectType || null;
    await tx.run(
      `UPDATE "MDG_REQUEST_HEADER"
          SET "SUBJECT_ID" = ?,
              "SUBJECT_TYPE" = ?,
              "MODIFIEDAT" = ?,
              "MODIFIEDBY" = ?
        WHERE "ID" = ?`,
      [sapObjectKey, nextSubjectType, new Date(), userId, requestId]
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
    if (!areValuesEqual(beforeSubjectType, nextSubjectType)) {
      await insertRequestFieldChangeLog(tx, {
        requestId,
        fieldId: SYSTEM_FIELD_ID,
        fieldCode: 'MDG_REQUEST_HEADER.SUBJECT_TYPE',
        oldValue: beforeSubjectType,
        newValue: nextSubjectType,
        changeType: 'UPDATE',
        changedBy: userId,
        changedRole: ROLE_CODES.APPROVER,
        source: 'WORKFLOW_APPROVE'
      });
    }
  }

  if (!ok && emitErrorBusinessComment) {
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
    sapObjectKey,
    sapErrorMessage: ok ? null : _extractSapErrorMessage(responseBody),
    responseJson
  };
}

function _summarizePayload(payload) {
  const keys = Object.keys(payload || {});
  return {
    fields: keys.length,
    keys: keys.slice(0, 40)
  };
}

function _chooseIdForBusinessComment(result, fallbackId) {
  const id = String(result?.sapObjectKey || fallbackId || '').trim();
  return id || null;
}

function _setCustomerIdInPayloadFromSchema(entitySet, payload, customerId) {
  const id = String(customerId || '').trim();
  if (!id || !payload || typeof payload !== 'object') return payload;
  const schema = getEntitySetSchema(entitySet);
  const props = schema?.properties || {};
  const map = new Map();
  for (const k of Object.keys(props)) map.set(_normalizePropertyName(k), k);
  const candidates = ['Kunnr', 'Customer', 'BusinessPartner', 'Partner'];
  for (const c of candidates) {
    const canonical = map.get(_normalizePropertyName(c));
    if (canonical) payload[canonical] = id;
  }
  // Safety fallback when metadata is incomplete/unavailable in runtime.
  if (!Object.prototype.hasOwnProperty.call(payload, 'Kunnr')) {
    payload.Kunnr = id;
  }
  return payload;
}

function _isNonEmpty(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

async function _resolveRequesterRoleId(tx, processId) {
  const rows = await tx.run(
    `SELECT "ID"
       FROM "MDG_PROCESS_ROLE"
      WHERE "PROCESS_ID" = ?
        AND "ROLE_CODE" = 'REQUESTER'
        AND "IS_ENABLED" = true
      ORDER BY "ID"
      LIMIT 1`,
    [processId]
  );
  return rows?.[0]?.ID || null;
}

async function _applyDestFactGeneralReadonlyBackfill(tx, {
  requestId,
  processId,
  countryCode,
  entitySet,
  payload
}) {
  if (!payload || typeof payload !== 'object') return { payload, backfilled: [] };

  const requesterRoleId = await _resolveRequesterRoleId(tx, processId);
  if (!requesterRoleId) return { payload, backfilled: [] };

  const readonlyRows = await tx.run(
    `SELECT
        d."ID" AS "FIELD_ID",
        d."FIELD_CODE" AS "FIELD_CODE",
        d."SAP_FIELD" AS "SAP_FIELD",
        COALESCE(fcc."FIELD_CONTROL_OVERRIDE", fcb."FIELD_CONTROL_BASE", 0) AS "EFFECTIVE_CONTROL"
       FROM "MDG_FIELD_CATALOG" d
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_BASE" fcb
         ON fcb."PROCESS_ROLE_ID" = ?
        AND fcb."FIELD_ID" = d."ID"
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_COUNTRY" fcc
         ON fcc."PROCESS_ROLE_ID" = ?
        AND fcc."FIELD_ID" = d."ID"
        AND fcc."COUNTRY_CODE" = ?
      WHERE d."FIELD_CODE" LIKE 'BUT000-KNA1.%'
        AND d."SAP_FIELD" IS NOT NULL
        AND LENGTH(TRIM(d."SAP_FIELD")) > 0`,
    [requesterRoleId, requesterRoleId, countryCode]
  );

  const readonlyDest = (readonlyRows || [])
    .filter((r) => Number(r.EFFECTIVE_CONTROL) === 3)
    .map((r) => ({
      fieldId: r.FIELD_ID,
      fieldCode: String(r.FIELD_CODE || '').trim(),
      sapField: String(r.SAP_FIELD || '').trim()
    }))
    // DestFact KTOKD is independent from customer creation KTOKD.
    // Keep the DestFact-configured/default value (e.g. Z011), never backfill from KNA1.
    .filter((r) => r.fieldCode !== 'BUT000-KNA1.KTOKD')
    .filter((r) => r.sapField);
  if (!readonlyDest.length) return { payload, backfilled: [] };

  const values = await tx.run(
    `SELECT
        c."FIELD_CODE" AS "FIELD_CODE",
        c."SAP_FIELD" AS "SAP_FIELD",
        c."DATA_TYPE" AS "DATA_TYPE",
        v."VALUE" AS "VALUE",
        v."LINE_NO" AS "LINE_NO"
       FROM "MDG_FIELD_CATALOG" c
       LEFT JOIN "MDG_REQUEST_FIELD_VALUE" v
         ON v."FIELD_ID" = c."ID"
        AND v."REQUEST_ID" = ?
      WHERE c."FIELD_CODE" LIKE 'KNA1.%'
         OR c."FIELD_CODE" LIKE 'BUT000-KNA1.%'
      ORDER BY
        c."FIELD_CODE",
        CASE WHEN v."LINE_NO" = 1 THEN 0 ELSE 1 END,
        v."LINE_NO",
        v."ID"`,
    [requestId]
  );

  const sourceBySapField = new Map();
  const destByFieldCode = new Map();
  for (const row of values || []) {
    const fieldCode = String(row.FIELD_CODE || '').trim();
    const sapField = String(row.SAP_FIELD || '').trim();
    const value = row.VALUE;
    const dataType = row.DATA_TYPE;
    if (!sapField) continue;

    if (fieldCode.startsWith('KNA1.') && _isNonEmpty(value) && !sourceBySapField.has(sapField)) {
      sourceBySapField.set(sapField, { value: String(value), dataType, sourceFieldCode: fieldCode });
    }

    if (fieldCode.startsWith('BUT000-KNA1.') && !destByFieldCode.has(fieldCode)) {
      destByFieldCode.set(fieldCode, _isNonEmpty(value) ? String(value) : '');
    }
  }

  const schema = getEntitySetSchema(entitySet);
  const props = schema?.properties || {};
  const canonicalByNorm = new Map();
  for (const [propName, propType] of Object.entries(props)) {
    canonicalByNorm.set(_normalizePropertyName(propName), { propName, propType });
  }

  const backfilled = [];
  for (const dest of readonlyDest) {
    const explicitDestValue = destByFieldCode.get(dest.fieldCode);
    if (_isNonEmpty(explicitDestValue)) continue;

    const source = sourceBySapField.get(dest.sapField);
    if (!source || !_isNonEmpty(source.value)) continue;

    const canonical = canonicalByNorm.get(_normalizePropertyName(dest.sapField));
    if (!canonical?.propName) continue;
    if (_isNonEmpty(payload[canonical.propName])) continue;

    const conversion = convertValueForSap(source.value, {
      edmType: canonical.propType,
      fallbackDataType: source.dataType
    });
    if (!conversion.ok) continue;

    payload[canonical.propName] = conversion.value;
    backfilled.push({
      targetFieldCode: dest.fieldCode,
      sourceFieldCode: source.sourceFieldCode,
      sapField: dest.sapField
    });
  }

  return { payload, backfilled };
}

async function _readLatestSuccessfulStep(tx, { requestId, processId, entitySet }) {
  const rows = await tx.run(
    `SELECT
        m."HTTP_STATUS"    AS "HTTP_STATUS",
        m."SAP_OBJECT_KEY" AS "SAP_OBJECT_KEY",
        m."CREATEDAT"      AS "CREATEDAT"
       FROM "MDG_REQUEST_SAP_MESSAGE" m
       JOIN "MDG_SAP_TARGET" t
         ON t."ID" = m."SAP_TARGET_ID"
      WHERE m."REQUEST_ID" = ?
        AND t."PROCESS_ID" = ?
        AND UPPER(COALESCE(t."ENTITYSET", '')) = UPPER(?)
        AND m."HTTP_STATUS" >= 200
        AND m."HTTP_STATUS" < 300
      ORDER BY m."CREATEDAT" DESC
      LIMIT 1`,
    [requestId, processId, entitySet]
  );
  return rows?.[0] || null;
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
    const requestCreatedDate = await _readRequestCreatedDate(tx, requestId);
    const sapTargets = await _resolveSapTargetsForProcess(tx, { processId, operation: 'POST' });
    if (!sapTargets.length) {
      req.reject(422, _t(req, 'noSapTargetConfigured', { processCode: processCode || 'UNKNOWN' }));
    }

    if (processCode === 'CUSTOMER_CREATION') {
      const controls = await _readCustomerCreationControls(tx, requestId);
      if (controls.EXTEND_DESTFACT_SALES && !controls.CREATE_DESTFACT) {
        req.reject(400, _t(req, 'invalidDestfactFlags'));
      }

      const requesterRoleId = await _resolveRequesterRoleId(tx, processId);
      const blockMap = await _loadProcessBlockFieldMap(tx, processId, [
        'CUST_GEN',
        'CUST_ADDR',
        'CUST_DESTFACT_GEN',
        'CUST_DESTFACT_SALES'
      ]);
      const customerFieldIds = _mergeFieldIds(
        blockMap.get('CUST_GEN') || [],
        blockMap.get('CUST_ADDR') || []
      );
      const destFactGenFieldIds = _mergeFieldIds(blockMap.get('CUST_DESTFACT_GEN') || []);
      const destFactSalesFieldIds = _mergeFieldIds(blockMap.get('CUST_DESTFACT_SALES') || []);

      const stepDefs = [
        {
          key: 'CLIENTE',
          entitySet: 'ClientesGeneralSet',
          enabled: true,
          successMessage: 'Se creó Cliente {id}',
          fieldIds: customerFieldIds
        },
        {
          key: 'DESTFACT_GENERAL',
          entitySet: 'DestFacturaGeneralSet',
          enabled: controls.CREATE_DESTFACT,
          successMessage: 'Se creó Destinatario Facturación {id}',
          fieldIds: destFactGenFieldIds
        },
        {
          key: 'DESTFACT_VENTAS',
          entitySet: 'DestFacturaComercialSet',
          enabled: controls.EXTEND_DESTFACT_SALES,
          successMessage: 'Se amplió Org. Venta Destinatario {id}',
          fieldIds: destFactSalesFieldIds
        }
      ].filter((s) => s.enabled);

      const stepResults = [];
      let customerId = String(request?.SUBJECT_ID || '').trim() || null;
      let destFactId = null;
      for (let i = 0; i < stepDefs.length; i++) {
        const step = stepDefs[i];
        const alreadyOk = await _readLatestSuccessfulStep(tx, {
          requestId,
          processId,
          entitySet: step.entitySet
        });
        if (alreadyOk) {
          if (step.entitySet === 'ClientesGeneralSet' && !customerId) {
            customerId = String(alreadyOk.SAP_OBJECT_KEY || '').trim() || customerId;
            if (customerId) {
              await _upsertRequestSubject(tx, {
                requestId,
                subjectId: customerId,
                subjectType: 'CUSTOMER',
                userId,
                source: 'WORKFLOW_APPROVE_RESUME'
              });
            }
          }
          if (step.entitySet === 'DestFacturaGeneralSet') {
            destFactId = String(alreadyOk.SAP_OBJECT_KEY || '').trim() || destFactId;
          }
          stepResults.push({
            step,
            result: {
              ok: true,
              requestId,
              processCode,
              entitySet: step.entitySet,
              httpStatus: Number(alreadyOk.HTTP_STATUS || 200),
              finalStatus: STATUS_COMPLETED,
              skippedFields: [],
              sapObjectKey: String(alreadyOk.SAP_OBJECT_KEY || '').trim() || null,
              resumed: true
            }
          });
          await insertActionLog(tx, {
            requestId,
            action: 'SAP_STEP_SKIPPED',
            actorUser: userId,
            actorRole: ROLE_CODES.APPROVER,
            comment: _stringifySafe({
              step: step.key,
              entitySet: step.entitySet,
              reason: 'already_completed'
            })
          });
          continue;
        }

        const sapTarget = _pickSapTargetByEntitySet(sapTargets, step.entitySet);
        if (!sapTarget?.entitySet || !sapTarget?.destinationName || !sapTarget?.servicePath) {
          req.reject(422, _t(req, 'noSapTargetForEntitySet', { processCode: processCode || 'UNKNOWN', entitySet: step.entitySet }));
        }

        const { payload, skippedFields } = await _buildSapPayload(
          tx,
          requestId,
          step.entitySet,
          processId,
          {
            allowedFieldIds: step.fieldIds || [],
            processRoleId: requesterRoleId,
            countryCode: request.COUNTRY_CODE,
            creationDateOverride: requestCreatedDate,
            excludeSapFields: step.entitySet === 'ClientesGeneralSet' ? ['Zzfechac'] : []
          }
        );

        try {
          await _validateMandatoryForFieldIds(tx, {
            requestId,
            processRoleId: requesterRoleId,
            countryCode: request.COUNTRY_CODE,
            fieldIds: step.fieldIds || [],
            entitySet: step.entitySet,
            payload
          });
        } catch (err) {
          if (err?.code === 'MANDATORY_FIELDS_MISSING_STEP') {
            req.reject(400, _t(req, 'mandatoryFieldsMissingForStep', {
              entitySet: step.entitySet,
              fields: (err.details || []).join(', ')
            }));
          }
          throw err;
        }

        let backfilled = [];
        if (step.entitySet === 'DestFacturaGeneralSet') {
          const patched = await _applyDestFactGeneralReadonlyBackfill(tx, {
            requestId,
            processId,
            countryCode: request.COUNTRY_CODE,
            entitySet: step.entitySet,
            payload
          });
          backfilled = patched.backfilled || [];
        }
        const stepCustomerId = step.entitySet === 'DestFacturaComercialSet'
          ? (String(destFactId || '').trim() || String(customerId || '').trim() || null)
          : (String(customerId || '').trim() || null);
        if (i > 0 && stepCustomerId) {
          _setCustomerIdInPayloadFromSchema(step.entitySet, payload, stepCustomerId);
        }

        const result = await _postToS4AndPersist(tx, {
          requestId,
          processId,
          processCode,
          sapTarget,
          payload,
          userId,
          previousStatus: status,
          skippedFields,
          updateRequestState: false,
          emitErrorBusinessComment: false,
          updateSubjectFromSap: i === 0
        });

        const payloadSummary = _summarizePayload(payload);
        await insertActionLog(tx, {
          requestId,
          action: result.ok ? 'SAP_STEP_OK' : 'SAP_STEP_ERROR',
          actorUser: userId,
          actorRole: ROLE_CODES.APPROVER,
          comment: _stringifySafe({
            step: step.key,
            entitySet: step.entitySet,
            ok: result.ok,
            httpStatus: result.httpStatus,
            sapObjectKey: result.sapObjectKey || null,
            payload: payloadSummary,
            backfilled
          })
        });

        if (result.ok) {
          const businessId = _chooseIdForBusinessComment(result, customerId);
          const msg = step.successMessage.replace('{id}', businessId || '(sin id)');
          await insertComment(tx, {
            requestId,
            authorUser: userId,
            authorRole: roleToBusinessName(ROLE_CODES.APPROVER),
            message: msg
          });
        } else {
          const sapErrorMessage = result?.sapErrorMessage || 'SAP integration error';
          await insertComment(tx, {
            requestId,
            authorUser: userId,
            authorRole: roleToBusinessName(ROLE_CODES.APPROVER),
            message: `Error SAP: ${sapErrorMessage}`
          });
        }

        stepResults.push({ step, result });
        if (i === 0 && result.ok) {
          customerId = String(result.sapObjectKey || '').trim() || customerId;
        }
        if (step.entitySet === 'DestFacturaGeneralSet' && result.ok) {
          destFactId = String(result.sapObjectKey || '').trim() || destFactId;
        }
        if (!result.ok) break;
      }

      const failed = stepResults.find((s) => !s.result?.ok);
      const anySkipped = stepResults.flatMap((s) => s.result?.skippedFields || []);
      const finalStatus = failed ? STATUS.REWORK : STATUS_COMPLETED;
      await tx.run(
        `UPDATE "MDG_REQUEST_HEADER"
            SET "STATUS" = ?,
                "MODIFIEDAT" = ?,
                "MODIFIEDBY" = ?
          WHERE "ID" = ?`,
        [finalStatus, new Date(), userId, requestId]
      );
      if (!areValuesEqual(status, finalStatus)) {
        await insertRequestFieldChangeLog(tx, {
          requestId,
          fieldId: SYSTEM_FIELD_ID,
          fieldCode: 'MDG_REQUEST_HEADER.STATUS',
          oldValue: status,
          newValue: finalStatus,
          changeType: 'UPDATE',
          changedBy: userId,
          changedRole: ROLE_CODES.APPROVER,
          source: 'WORKFLOW_APPROVE'
        });
      }

      approveResult = {
        ok: !failed,
        requestId,
        processCode,
        entitySet: stepResults.map((s) => s.step.entitySet).join(','),
        httpStatus: failed ? failed.result.httpStatus : (stepResults[stepResults.length - 1]?.result?.httpStatus || 200),
        finalStatus,
        skippedFields: anySkipped,
        sapObjectKey: customerId
      };
    } else if (processCode === 'TRANSPORT_DRIVER_CREATION') {
      const requesterRoleId = await _resolveRequesterRoleId(tx, processId);
      const activeTargets = (sapTargets || [])
        .filter((t) => ['CONDUCTORESGENERALSET', 'CONDUCTORESCOMERCIALSET'].includes(String(t?.entitySet || '').toUpperCase()));
      const priority = {
        CONDUCTORESGENERALSET: 10,
        CONDUCTORESCOMERCIALSET: 20
      };
      const orderedTargets = activeTargets.sort((a, b) => {
        const pa = priority[String(a.entitySet || '').toUpperCase()] ?? 999;
        const pb = priority[String(b.entitySet || '').toUpperCase()] ?? 999;
        return pa - pb;
      });

      if (!orderedTargets.length) {
        req.reject(422, _t(req, 'noSapTargetConfigured', { processCode: processCode || 'UNKNOWN' }));
      }

      const stepResults = [];
      let conductorId = String(request?.SUBJECT_ID || '').trim() || null;
      const generalTarget = orderedTargets.find((t) => String(t?.entitySet || '').toUpperCase() === 'CONDUCTORESGENERALSET');
      if (!conductorId && generalTarget?.id) {
        conductorId = await _readLastSuccessfulSapObjectKey(tx, requestId, generalTarget.id);
        if (conductorId) {
          await _upsertRequestSubject(tx, {
            requestId,
            subjectId: conductorId,
            subjectType: 'DRIVER',
            userId,
            source: 'WORKFLOW_APPROVE_RESUME'
          });
        }
      }
      for (const target of orderedTargets) {
        const isGeneralStep = String(target?.entitySet || '').toUpperCase() === 'CONDUCTORESGENERALSET';
        if (isGeneralStep && conductorId) {
          stepResults.push({
            ok: true,
            skippedFields: [],
            httpStatus: 208,
            sapObjectKey: conductorId,
            skippedStep: true
          });
          await insertActionLog(tx, {
            requestId,
            action: 'SAP_STEP_SKIPPED',
            actorUser: userId,
            actorRole: ROLE_CODES.APPROVER,
            comment: _stringifySafe({
              step: target.entitySet,
              entitySet: target.entitySet,
              reason: 'already_completed',
              sapObjectKey: conductorId
            })
          });
          continue;
        }

        const { payload, skippedFields } = await _buildSapPayload(
          tx,
          requestId,
          target.entitySet,
          processId,
          {
            processRoleId: requesterRoleId,
            countryCode: request.COUNTRY_CODE
          }
        );
        if (!isGeneralStep && conductorId) {
          _setCustomerIdInPayloadFromSchema(target.entitySet, payload, conductorId);
        }

        try {
          await _validateMandatoryForStep(tx, {
            requestId,
            processId,
            processRoleId: requesterRoleId,
            countryCode: request.COUNTRY_CODE,
            entitySet: target.entitySet,
            payload
          });
        } catch (err) {
          if (err?.code === 'MANDATORY_FIELDS_MISSING_STEP') {
            req.reject(400, _t(req, 'mandatoryFieldsMissingForStep', {
              entitySet: target.entitySet,
              fields: (err.details || []).join(', ')
            }));
          }
          throw err;
        }

        const result = await _postToS4AndPersist(tx, {
          requestId,
          processId,
          processCode,
          sapTarget: target,
          payload,
          userId,
          previousStatus: status,
          skippedFields,
          updateRequestState: false,
          emitErrorBusinessComment: false,
          updateSubjectFromSap: target.entitySet === 'ConductoresGeneralSet'
        });

        await insertActionLog(tx, {
          requestId,
          action: result.ok ? 'SAP_STEP_OK' : 'SAP_STEP_ERROR',
          actorUser: userId,
          actorRole: ROLE_CODES.APPROVER,
          comment: _stringifySafe({
            step: target.entitySet,
            entitySet: target.entitySet,
            ok: result.ok,
            httpStatus: result.httpStatus,
            sapObjectKey: result.sapObjectKey || null,
            payload: _summarizePayload(payload)
          })
        });

        if (result.ok) {
          await insertComment(tx, {
            requestId,
            authorUser: userId,
            authorRole: roleToBusinessName(ROLE_CODES.APPROVER),
            message: `Paso ${target.entitySet} ejecutado correctamente${result.sapObjectKey ? ` (ID: ${result.sapObjectKey})` : ''}.`
          });
        } else {
          const sapErrorMessage = result?.sapErrorMessage || 'SAP integration error';
          await insertComment(tx, {
            requestId,
            authorUser: userId,
            authorRole: roleToBusinessName(ROLE_CODES.APPROVER),
            message: `Error SAP en ${target.entitySet}: ${sapErrorMessage}`
          });
        }

        stepResults.push(result);
        if (isGeneralStep && result.ok) {
          conductorId = String(result.sapObjectKey || '').trim() || conductorId;
        }
        if (!result.ok) break; // If General fails, do not execute Comercial.
      }

      const failed = stepResults.find((s) => !s.ok);
      const finalStatus = failed ? STATUS.REWORK : STATUS_COMPLETED;
      await tx.run(
        `UPDATE "MDG_REQUEST_HEADER"
            SET "STATUS" = ?,
                "MODIFIEDAT" = ?,
                "MODIFIEDBY" = ?
          WHERE "ID" = ?`,
        [finalStatus, new Date(), userId, requestId]
      );
      if (!areValuesEqual(status, finalStatus)) {
        await insertRequestFieldChangeLog(tx, {
          requestId,
          fieldId: SYSTEM_FIELD_ID,
          fieldCode: 'MDG_REQUEST_HEADER.STATUS',
          oldValue: status,
          newValue: finalStatus,
          changeType: 'UPDATE',
          changedBy: userId,
          changedRole: ROLE_CODES.APPROVER,
          source: 'WORKFLOW_APPROVE'
        });
      }

      const anySkipped = stepResults.flatMap((s) => s.skippedFields || []);
      const last = stepResults[stepResults.length - 1] || null;
      approveResult = {
        ok: !failed,
        requestId,
        processCode,
        entitySet: orderedTargets.map((t) => t.entitySet).join(','),
        httpStatus: last?.httpStatus || null,
        finalStatus,
        skippedFields: anySkipped,
        sapObjectKey: conductorId || last?.sapObjectKey || null
      };
    } else {
      const sapTarget = sapTargets[0];
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
        skippedFields,
        updateSubjectFromSap: true
      });
    }
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
