const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { getEntitySetSchema } = require('./_lib/edmx-zmdg-dm.parser');
const { s4Get } = require('./_lib/s4.client');
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

const QAS_S4_DESTINATION_NAME = 'S4H-TECH';

function _normalizeS4DestinationName() {
  return QAS_S4_DESTINATION_NAME;
}

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
    mandatoryFieldsMissingForStep: 'Mandatory fields missing for step {entitySet}: {fields}',
    materialCodeAlreadyExists: 'Material code already exists in SAP: {materialCode}'
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
    mandatoryFieldsMissingForStep: 'Faltan campos obligatorios para el paso {entitySet}: {fields}',
    materialCodeAlreadyExists: 'El código de material ya existe en SAP: {materialCode}'
  }
});
const STATUS_COMPLETED = STATUS.APPROVED;
const ALLOWED_CHILE_COMPANY_CODES = Object.freeze(['A023', 'A032', 'A050', 'A071', 'A080', 'A090', 'A096']);

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

function _escapeODataLiteral(value) {
  return String(value || '').replace(/'/g, "''");
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

function _extractJwtFromReq(req) {
  const authHeader =
    req?.headers?.authorization ||
    req?._?.req?.headers?.authorization ||
    req?.http?.req?.headers?.authorization ||
    cds?.context?.http?.req?.headers?.authorization ||
    '';
  const value = String(authHeader || '').trim();
  if (!value) return null;
  const m = value.match(/^Bearer\s+(.+)$/i);
  return (m?.[1] || value || '').trim() || null;
}

function _decodeJwtPayloadUnsafe(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    return {};
  }
}

function _maskToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= 16) return `${raw.slice(0, 4)}...`;
  return `${raw.slice(0, 8)}...${raw.slice(-8)}`;
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

function _toStepCode(processCode, entitySet, targetCode) {
  const p = String(processCode || '').trim().toUpperCase();
  const e = String(entitySet || '').trim().toUpperCase();
  const t = String(targetCode || '').trim().toUpperCase();
  if (p === 'CUSTOMER_CREATION') {
    if (e === 'CLIENTESGENERALSET') return 'CUSTOMER_CREATE';
    if (e === 'DESTMERCADERIAGENERALSET') return 'DESTMERC_CREATE';
    if (e === 'DESTFACTURAGENERALSET') return 'DESTFACT_CREATE';
    if (e === 'DESTFACTURACOMERCIALSET') return 'DESTFACT_SALES_EXTEND';
  }
  if (p === 'TRANSPORT_DRIVER_CREATION') {
    if (e === 'CONDUCTORESGENERALSET') return 'DRIVER_CREATE';
    if (e === 'CONDUCTORESCOMERCIALSET') return 'DRIVER_SALES_EXTEND';
  }
  if (t) return t.replace(/[^A-Z0-9]+/g, '_');
  if (e) return e.replace(/[^A-Z0-9]+/g, '_');
  return 'SAP_STEP';
}

function _toStepStatus(ok, explicitStatus = null) {
  if (explicitStatus) return String(explicitStatus).trim().toUpperCase();
  return ok ? 'SUCCESS' : 'ERROR';
}

function _toStepMessage({ ok, status, entitySet, sapObjectKey, sapErrorMessage, explicitMessage }) {
  if (explicitMessage) return String(explicitMessage).slice(0, 400);
  const s = String(status || '').toUpperCase();
  if (s === 'SKIPPED') return `Step ${entitySet} skipped`;
  if (ok) return `Step ${entitySet} succeeded${sapObjectKey ? ` (ID: ${sapObjectKey})` : ''}`;
  return `Step ${entitySet} failed: ${sapErrorMessage || 'SAP integration error'}`;
}

function _buildSapResultEnvelope({
  processCode,
  stepCode,
  targetCode,
  entitySet,
  status,
  externalId,
  message,
  correlationId,
  responseBody
}) {
  return {
    _mdgResult: {
      processCode: processCode || null,
      stepCode: stepCode || null,
      targetCode: targetCode || null,
      entitySet: entitySet || null,
      status: status || null,
      externalId: externalId || null,
      message: message || null,
      correlationId: correlationId || null,
      createdAt: new Date().toISOString()
    },
    sapResponse: responseBody ?? null
  };
}

async function _upsertSapStepMessage(tx, {
  requestId,
  sapTargetId,
  httpStatus,
  correlationId,
  sapObjectKey,
  payload,
  responseBody,
  processCode,
  targetCode,
  entitySet,
  status,
  message
}) {
  const normalizedStatus = String(status || '').trim().toUpperCase();
  const envelope = _buildSapResultEnvelope({
    processCode,
    stepCode: _toStepCode(processCode, entitySet, targetCode),
    targetCode,
    entitySet,
    status: normalizedStatus,
    externalId: sapObjectKey,
    message,
    correlationId,
    responseBody
  });
  const payloadJson = _stringifySafe(payload) || '{}';
  const responseJson = _stringifySafe(envelope) || '';

  const id = cds.utils.uuid();
  await tx.run(
    `INSERT INTO "MDG_REQUEST_SAP_MESSAGE"
     ("ID", "REQUEST_ID", "SAP_TARGET_ID", "HTTP_STATUS", "CORRELATION_ID", "SAP_OBJECT_KEY", "PAYLOAD_JSON", "RESPONSE_JSON", "CREATEDAT")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, requestId, sapTargetId, httpStatus, correlationId, sapObjectKey, payloadJson, responseJson, new Date()]
  );
  return id;
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
      destinationName: _normalizeS4DestinationName(r.DESTINATION_NAME),
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

async function _resolveSapTargetsForProcessAnyState(tx, { processId, operation = 'POST' }) {
  try {
    const rows = await tx.run(
      `SELECT "ID", "TARGET_CODE", "DESTINATION_NAME", "SERVICE_PATH", "ENTITYSET", "OPERATION", "IS_ENABLED"
         FROM "MDG_SAP_TARGET"
        WHERE "PROCESS_ID" = ?
          AND UPPER(COALESCE("OPERATION", 'POST')) = UPPER(?)
        ORDER BY "ID"`,
      [processId, operation]
    );
    return (rows || []).map((r) => ({
      id: r.ID,
      targetCode: r.TARGET_CODE,
      destinationName: _normalizeS4DestinationName(r.DESTINATION_NAME),
      servicePath: r.SERVICE_PATH,
      entitySet: r.ENTITYSET,
      operation: r.OPERATION,
      isEnabled: Boolean(r.IS_ENABLED)
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

function _classifyCustomerCreationTarget(target) {
  const entitySet = String(target?.entitySet || '').trim().toUpperCase();
  const targetCode = String(target?.targetCode || '').trim().toUpperCase();
  const id = String(target?.id || '');
  const token = `${targetCode} ${entitySet}`;

  const isCustomerCompany = entitySet === 'CLIENTESEMPRESARIALSET'
    || token.includes('COMPANYCODE')
    || token.includes('EMPRESARIAL');
  if (isCustomerCompany) {
    return { stepType: 'CUSTOMER_COMP', order: 30, label: 'Cliente sociedad' };
  }

  const isCustomerSales = entitySet === 'CLIENTESORGVENTASET'
    || (token.includes('CLIENT') && (token.includes('ORGVENTA') || token.includes('SALESAREA')));
  if (isCustomerSales) {
    return { stepType: 'CUSTOMER_SALES', order: 40, label: 'Cliente organización de ventas' };
  }

  const isDestMercSales = entitySet === 'DESTMERCADERIACOMERCIALSET'
    || ((token.includes('DESTMERC') || token.includes('DESTMERCADERIA')) && (token.includes('COMERCIAL') || token.includes('ORG') || token.includes('SALES')));
  if (isDestMercSales) {
    return { stepType: 'DESTMERC_SALES', order: 50, label: 'Destinatario mercadería organización de ventas' };
  }

  const isCustomerMain = entitySet === 'CLIENTESGENERALSET'
    || targetCode === 'SAP_CUSTOMER_CREATION'
    || targetCode === 'SAP_CUSTOMER_CREATION_GENERAL'
    || targetCode === 'SAP_CUSTOMER_CREATION_CUSTOMER_GENERAL'
    || (targetCode.endsWith('_GENERAL') && token.includes('CLIENT') && !token.includes('DESTMERC'));
  if (isCustomerMain) {
    return { stepType: 'CUSTOMER_MAIN', order: 10, label: 'Cliente' };
  }

  const isDestMercMain = entitySet === 'DESTMERCADERIAGENERALSET'
    || targetCode === 'SAP_CUSTOMER_CREATION_DESTMERC_GENERAL'
    || targetCode === 'SAP_DESTMERC_CREATION'
    || ((token.includes('DESTMERC') || token.includes('DESTMERCADERIA')) && token.includes('GENERAL'));
  if (isDestMercMain) {
    return { stepType: 'DESTMERC_MAIN', order: 20, label: 'Destinatario mercadería' };
  }

  const isSales = entitySet.includes('COMERCIAL') || token.includes('SALES') || token.includes('ORG');
  if (isSales) {
    return { stepType: 'FOLLOW_UP', order: 60, label: entitySet || targetCode || id };
  }

  return { stepType: 'FOLLOW_UP', order: 70, label: entitySet || targetCode || id };
}

async function _loadSapTargetFieldMeta(tx, { processId, sapTargetId }) {
  if (!processId || !sapTargetId) return [];
  const rows = await tx.run(
    `SELECT DISTINCT
        pm."FIELD_ID" AS "FIELD_ID",
        fc."FIELD_CODE" AS "FIELD_CODE",
        fc."SAP_FIELD" AS "SAP_FIELD",
        fc."DATA_TYPE" AS "DATA_TYPE"
       FROM "MDG_SAP_PAYLOAD_MAP" pm
       JOIN "MDG_FIELD_CATALOG" fc
         ON fc."ID" = pm."FIELD_ID"
      WHERE pm."PROCESS_ID" = ?
        AND pm."SAP_TARGET_ID" = ?`,
    [processId, sapTargetId]
  );
  return (rows || []).filter((r) => r.FIELD_ID);
}

async function _resolveRequesterDefaultsByFieldId(tx, { processId, countryCode, fieldIds }) {
  const scopedFieldIds = Array.from(new Set((fieldIds || []).map((x) => String(x || '').trim()).filter(Boolean)));
  if (!processId || !scopedFieldIds.length) return new Map();

  const roleRows = await tx.run(
    `SELECT "ID"
       FROM "MDG_PROCESS_ROLE"
      WHERE "PROCESS_ID" = ?
        AND "ROLE_CODE" = 'REQUESTER'
        AND "IS_ENABLED" = true
      ORDER BY "ID"
      LIMIT 1`,
    [processId]
  );
  const requesterRoleId = roleRows?.[0]?.ID || null;
  if (!requesterRoleId) return new Map();

  const inClause = scopedFieldIds.map(() => '?').join(',');
  const rows = await tx.run(
    `SELECT
        fc."ID" AS "FIELD_ID",
        COALESCE(NULLIF(TRIM(fcc."DEFAULT_OVERRIDE"), ''), NULLIF(TRIM(fcb."DEFAULT_BASE"), '')) AS "DEFAULT_VALUE"
       FROM "MDG_FIELD_CATALOG" fc
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_BASE" fcb
         ON fcb."PROCESS_ROLE_ID" = ?
        AND fcb."FIELD_ID" = fc."ID"
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_COUNTRY" fcc
         ON fcc."PROCESS_ROLE_ID" = ?
        AND fcc."FIELD_ID" = fc."ID"
        AND fcc."COUNTRY_CODE" = ?
      WHERE fc."ID" IN (${inClause})`,
    [requesterRoleId, requesterRoleId, countryCode, ...scopedFieldIds]
  );

  const out = new Map();
  for (const row of rows || []) {
    const v = String(row.DEFAULT_VALUE || '').trim();
    if (v) out.set(String(row.FIELD_ID), v);
  }
  return out;
}

async function _applyConfiguredDefaultsToPayload(tx, {
  processRoleId,
  countryCode,
  entitySet,
  allowedFieldIds,
  payload
}) {
  if (!payload || typeof payload !== 'object') return { payload, backfilled: [] };
  const scopedFieldIds = Array.from(new Set((allowedFieldIds || []).map((x) => String(x || '').trim()).filter(Boolean)));
  if (!processRoleId || !scopedFieldIds.length) return { payload, backfilled: [] };

  const inClause = scopedFieldIds.map(() => '?').join(',');
  const rows = await tx.run(
    `SELECT
        fc."ID" AS "FIELD_ID",
        fc."FIELD_CODE" AS "FIELD_CODE",
        fc."SAP_FIELD" AS "SAP_FIELD",
        fc."DATA_TYPE" AS "DATA_TYPE",
        COALESCE(fcc."FIELD_CONTROL_OVERRIDE", fcb."FIELD_CONTROL_BASE", 0) AS "FIELD_CONTROL",
        COALESCE(NULLIF(TRIM(fcc."DEFAULT_OVERRIDE"), ''), NULLIF(TRIM(fcb."DEFAULT_BASE"), '')) AS "DEFAULT_VALUE"
       FROM "MDG_FIELD_CATALOG" fc
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_BASE" fcb
         ON fcb."PROCESS_ROLE_ID" = ?
        AND fcb."FIELD_ID" = fc."ID"
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_COUNTRY" fcc
         ON fcc."PROCESS_ROLE_ID" = ?
        AND fcc."FIELD_ID" = fc."ID"
        AND fcc."COUNTRY_CODE" = ?
      WHERE fc."ID" IN (${inClause})`,
    [processRoleId, processRoleId, countryCode, ...scopedFieldIds]
  );

  const schema = getEntitySetSchema(entitySet);
  const props = schema?.properties || {};
  const canonicalByNorm = new Map();
  for (const [propName, propType] of Object.entries(props)) {
    canonicalByNorm.set(_normalizePropertyName(propName), { propName, propType });
  }

  const backfilled = [];
  for (const row of rows || []) {
    const defaultValue = String(row.DEFAULT_VALUE || '').trim();
    const sapField = String(row.SAP_FIELD || '').trim();
    if (!defaultValue || !sapField) continue;

    const canonical = canonicalByNorm.get(_normalizePropertyName(sapField));
    if (!canonical?.propName) continue;
    if (_isNonEmpty(payload[canonical.propName])) continue;

    const conversion = convertValueForSap(defaultValue, {
      edmType: canonical.propType,
      fallbackDataType: row.DATA_TYPE
    });
    if (!conversion.ok) continue;

    payload[canonical.propName] = conversion.value;
    backfilled.push({
      fieldId: row.FIELD_ID,
      fieldCode: String(row.FIELD_CODE || '').trim(),
      sapField,
      fieldControl: Number(row.FIELD_CONTROL ?? 0),
      sourceFieldCode: 'CONFIG_DEFAULT'
    });
  }

  return { payload, backfilled };
}

async function _readLatestRequestFieldValueByCode(tx, { requestId, fieldCode }) {
  const rows = await tx.run(
    `SELECT v."VALUE" AS "VALUE"
       FROM "MDG_REQUEST_FIELD_VALUE" v
       JOIN "MDG_FIELD_CATALOG" c
         ON c."ID" = v."FIELD_ID"
      WHERE v."REQUEST_ID" = ?
        AND c."FIELD_CODE" = ?
      ORDER BY
        CASE WHEN v."LINE_NO" = 1 THEN 0 ELSE 1 END,
        v."LINE_NO",
        v."MODIFIEDAT" DESC,
        v."ID" DESC
      LIMIT 1`,
    [requestId, fieldCode]
  );
  return String(rows?.[0]?.VALUE || '').trim();
}

async function _assertMaterialCodeDoesNotExist(tx, req, { requestId, processCode }) {
  if (String(processCode || '').trim().toUpperCase() !== 'MATERIAL_CREATION_COMBOS') return;

  const materialCode = await _readLatestRequestFieldValueByCode(tx, {
    requestId,
    fieldCode: 'MARA.MATNR'
  });
  if (!materialCode) return;

  const rows = await s4Get({
    servicePath: '/sap/opu/odata/sap/ZCDS_MATERIALES_ORGV_CDS',
    entitySet: 'I_Material',
    query: {
      '$select': 'Material',
      '$top': 1,
      '$filter': `Material eq '${_escapeODataLiteral(materialCode)}'`
    }
  });

  const exists = (rows || []).some((row) => String(row?.Material || '').trim() === materialCode);
  if (exists) {
    req.reject(409, _t(req, 'materialCodeAlreadyExists', { materialCode }));
  }
}

function _normalizeSearchTermValue(value, maxLength = 20) {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.slice(0, maxLength);
}

function _deriveMcod2ValueFromPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return '';
  const processCode = String(options.processCode || '').trim().toUpperCase();

  if (processCode === 'CUSTOMER_CREATION') {
    const rutValue = _normalizeSearchTermValue(payload.Sortl || '');
    if (rutValue) return rutValue;
  }

  const orgName = _normalizeSearchTermValue(payload.Namorg1 || payload.Name1 || payload.NameText || '');
  if (orgName) return orgName;

  const personName = _normalizeSearchTermValue(
    [payload.NameFirst, payload.NameMiddle, payload.NameLast]
      .filter((part) => _isNonEmpty(part))
      .join(' ')
  );
  if (personName) return personName;

  return '';
}

function _deriveBusort2ValueFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';

  const driverSearchTerm = _normalizeSearchTermValue(
    [payload.NameFirst, payload.NameLast]
      .filter((part) => _isNonEmpty(part))
      .join(' ')
  );
  if (driverSearchTerm) return driverSearchTerm;

  return '';
}

function _applyDerivedBusinessTermsToPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return { payload, derived: [] };

  const derived = [];
  const processCode = String(options.processCode || '').trim().toUpperCase();
  const mcod2 = _deriveMcod2ValueFromPayload(payload, { processCode });
  if (mcod2 && !_isNonEmpty(payload.Mcod2)) {
    payload.Mcod2 = mcod2;
    derived.push({
      fieldCode: '*.MCOD2',
      sapField: 'MCOD2',
      sourceFieldCode: 'DERIVED_BUSINESS_TERM'
    });
  }

  if (processCode === 'TRANSPORT_DRIVER_CREATION') {
    const busort2 = _deriveBusort2ValueFromPayload(payload);
    if (busort2 && !_isNonEmpty(payload.Busort2)) {
      payload.Busort2 = busort2;
      derived.push({
        fieldCode: '*.BU_SORT2',
        sapField: 'Busort2',
        sourceFieldCode: 'DERIVED_DRIVER_SEARCH_TERM'
      });
    }
  }

  const maber = String(payload.Maber || '').trim();
  const mahnaByMaber = {
    '': 'ZVEN',
    '01': 'ZCHE',
    '02': 'ZJUD'
  };
  const mahnsByMaber = {
    '': '1',
    '01': '1',
    '02': '2'
  };
  const derivedMahna = mahnaByMaber[maber];
  if (derivedMahna && !_isNonEmpty(payload.Mahna)) {
    payload.Mahna = derivedMahna;
    derived.push({
      fieldCode: 'KNB1.MAHNA',
      sapField: 'MAHNA',
      sourceFieldCode: 'DERIVED_FROM_MABER'
    });
  }

  const derivedMahns = mahnsByMaber[maber];
  if (derivedMahns && !_isNonEmpty(payload.Mahns)) {
    payload.Mahns = derivedMahns;
    derived.push({
      fieldCode: 'KNB1.MAHNS',
      sapField: 'MAHNS',
      sourceFieldCode: 'DERIVED_FROM_MABER'
    });
  }

  return { payload, derived };
}

function _classifyDestMercCreationTarget(target) {
  const entitySet = String(target?.entitySet || '').trim().toUpperCase();
  const targetCode = String(target?.targetCode || '').trim().toUpperCase();
  const token = `${targetCode} ${entitySet}`;

  if (entitySet === 'DESTMERCADERIAGENERALSET') {
    return { stepType: 'DESTMERC_MAIN', order: 10, label: 'Destinatario mercadería' };
  }
  if (entitySet === 'CLIENTESORGVENTASET' || (token.includes('CLIENT') && token.includes('SALES'))) {
    return { stepType: 'CUSTOMER_SALES', order: 20, label: 'Cliente principal organización de ventas' };
  }
  if (entitySet === 'DESTMERCADERIACOMERCIALSET' || (token.includes('DESTMERC') && token.includes('SALES'))) {
    return { stepType: 'DESTMERC_SALES', order: 30, label: 'Destinatario mercadería organización de ventas' };
  }
  if (entitySet === 'DESTMERCADERIAIMPUESTOSSET' || token.includes('TAX')) {
    return { stepType: 'DESTMERC_TAX', order: 40, label: 'Destinatario mercadería impuestos' };
  }
  return { stepType: 'FOLLOW_UP', order: 50, label: entitySet || targetCode || String(target?.id || '') };
}

async function _readLatestRequestFieldValueByCodes(tx, { requestId, fieldCodes }) {
  const scopedCodes = Array.from(new Set((fieldCodes || []).map((x) => String(x || '').trim()).filter(Boolean)));
  if (!requestId || !scopedCodes.length) return '';
  const rows = await tx.run(
    `SELECT v."VALUE" AS "VALUE"
       FROM "MDG_REQUEST_FIELD_VALUE" v
       JOIN "MDG_FIELD_CATALOG" c
         ON c."ID" = v."FIELD_ID"
      WHERE v."REQUEST_ID" = ?
        AND c."FIELD_CODE" IN (${scopedCodes.map(() => '?').join(',')})
      ORDER BY
        CASE WHEN v."LINE_NO" = 1 THEN 0 ELSE 1 END,
        v."LINE_NO",
        v."MODIFIEDAT" DESC,
        v."ID" DESC
      LIMIT 1`,
    [requestId, ...scopedCodes]
  );
  return String(rows?.[0]?.VALUE || '').trim();
}

function _isAddressSapField(sapField) {
  const norm = _normalizePropertyName(sapField);
  const addressFields = new Set([
    _normalizePropertyName('Street'),
    _normalizePropertyName('HouseNum1'),
    _normalizePropertyName('City1'),
    _normalizePropertyName('City2'),
    _normalizePropertyName('PostCode1'),
    _normalizePropertyName('Region'),
    _normalizePropertyName('Country'),
    _normalizePropertyName('TimeZone'),
    _normalizePropertyName('Lzone'),
    _normalizePropertyName('LanguCorr')
  ]);
  return addressFields.has(norm);
}

async function _applyCustomerToDestMercMirror(tx, {
  requestId,
  processId,
  countryCode,
  entitySet,
  targetFieldMeta,
  payload
}) {
  if (!payload || typeof payload !== 'object') return { payload, mirrored: [] };
  const targetRows = Array.isArray(targetFieldMeta) ? targetFieldMeta : [];
  if (!targetRows.length) return { payload, mirrored: [] };

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
  const destExplicitBySapField = new Map();
  for (const row of values || []) {
    const fieldCode = String(row.FIELD_CODE || '').trim();
    const sapField = String(row.SAP_FIELD || '').trim();
    const value = row.VALUE;
    if (!sapField || !_isNonEmpty(value)) continue;

    if (fieldCode.startsWith('KNA1.') && !sourceBySapField.has(_normalizePropertyName(sapField))) {
      sourceBySapField.set(_normalizePropertyName(sapField), {
        value: String(value),
        dataType: row.DATA_TYPE,
        sourceFieldCode: fieldCode
      });
    }
    if (!fieldCode.startsWith('KNA1.') && fieldCode.includes('.')) {
      const key = _normalizePropertyName(sapField);
      if (!destExplicitBySapField.has(key)) {
        destExplicitBySapField.set(key, String(value));
      }
    }
  }

  const defaultsByFieldId = await _resolveRequesterDefaultsByFieldId(tx, {
    processId,
    countryCode,
    fieldIds: targetRows.map((r) => r.FIELD_ID)
  });

  const schema = getEntitySetSchema(entitySet);
  const props = schema?.properties || {};
  const canonicalByNorm = new Map();
  for (const [propName, propType] of Object.entries(props)) {
    canonicalByNorm.set(_normalizePropertyName(propName), { propName, propType });
  }

  const mirrored = [];
  for (const row of targetRows) {
    const sapField = String(row.SAP_FIELD || '').trim();
    if (!sapField) continue;
    const norm = _normalizePropertyName(sapField);
    const canonical = canonicalByNorm.get(norm);
    if (!canonical?.propName) continue;
    if (_isNonEmpty(payload[canonical.propName])) continue; // explicit payload wins
    if (_isNonEmpty(destExplicitBySapField.get(norm))) continue; // explicit destination value wins

    if (_isAddressSapField(sapField)) continue; // never mirror address automatically

    // Explicit rule: destination BU_GROUP must keep configured default (e.g. Z009), not copied from customer.
    if (norm === _normalizePropertyName('BU_GROUP')) {
      const cfgDefault = String(defaultsByFieldId.get(String(row.FIELD_ID)) || '').trim();
      const fallbackDefault = 'Z009';
      const chosen = cfgDefault || fallbackDefault;
      if (!_isNonEmpty(chosen)) continue;
      const conversion = convertValueForSap(chosen, {
        edmType: canonical.propType,
        fallbackDataType: row.DATA_TYPE
      });
      if (!conversion.ok) continue;
      payload[canonical.propName] = conversion.value;
      mirrored.push({
        sourceFieldCode: 'DEFAULT_BASE',
        targetFieldCode: String(row.FIELD_CODE || '').trim(),
        sapField
      });
      continue;
    }

    const source = sourceBySapField.get(norm);
    if (!source || !_isNonEmpty(source.value)) continue;

    // Explicit rule: destination RUT/SORTL follows customer value.
    if (norm !== _normalizePropertyName('SORTL') && !_isNonEmpty(source.value)) continue;

    const conversion = convertValueForSap(source.value, {
      edmType: canonical.propType,
      fallbackDataType: source.dataType || row.DATA_TYPE
    });
    if (!conversion.ok) continue;

    payload[canonical.propName] = conversion.value;
    mirrored.push({
      sourceFieldCode: source.sourceFieldCode,
      targetFieldCode: String(row.FIELD_CODE || '').trim(),
      sapField
    });
  }

  return { payload, mirrored };
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

const MATERIAL_COMBO_COMPONENT_FIELD_CODES = Object.freeze([
  'STPO.STLAN',
  'STPO.IDNRK',
  'STPO.MENGE',
  'STPO.MEINS'
]);

const MATERIAL_COMBO_REQUIRED_COMPONENT_CODES = Object.freeze([
  'STPO.IDNRK',
  'STPO.MENGE',
  'STPO.MEINS'
]);

async function _loadMaterialComboComponentMap(tx, { processId, sapTargetId }) {
  if (!processId || !sapTargetId) return [];
  const rows = await tx.run(
    `SELECT
        pm."FIELD_ID"    AS "FIELD_ID",
        pm."SAP_PATH"    AS "SAP_PATH",
        pm."SAP_PROPERTY" AS "SAP_PROPERTY",
        fc."FIELD_CODE"  AS "FIELD_CODE",
        fc."DATA_TYPE"   AS "DATA_TYPE"
       FROM "MDG_SAP_PAYLOAD_MAP" pm
       JOIN "MDG_FIELD_CATALOG" fc
         ON fc."ID" = pm."FIELD_ID"
      WHERE pm."PROCESS_ID" = ?
        AND pm."SAP_TARGET_ID" = ?
        AND UPPER(COALESCE(pm."SAP_PATH", '')) = 'N_COMPONENTES'`,
    [processId, sapTargetId]
  );
  return (rows || []).map((r) => ({
    fieldId: String(r.FIELD_ID || '').trim(),
    fieldCode: String(r.FIELD_CODE || '').trim().toUpperCase(),
    sapPath: String(r.SAP_PATH || '').trim(),
    sapProperty: String(r.SAP_PROPERTY || '').trim(),
    dataType: String(r.DATA_TYPE || '').trim()
  })).filter((r) => r.fieldId && r.fieldCode && r.sapProperty);
}

function _throwMaterialComboMandatoryError(entitySet, details) {
  const err = new Error(`Mandatory fields missing for step ${entitySet}: ${details.join('; ')}`);
  err.statusCode = 400;
  err.code = 'MANDATORY_FIELDS_MISSING_STEP';
  err.details = details;
  throw err;
}

function _throwMaterialComboConfigError(entitySet, reason) {
  const err = new Error(`Invalid component mapping for step ${entitySet}: ${reason}`);
  err.statusCode = 422;
  err.code = 'INVALID_COMPONENT_MAPPING';
  throw err;
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
  const processCode = String(options.processCode || '').trim().toUpperCase();
  const sapTargetId = String(options.sapTargetId || '').trim();
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
  const isMaterialComboFlow =
    processCode === 'MATERIAL_CREATION_COMBOS' &&
    String(entitySet || '').trim().toUpperCase() === 'MATERIALESCOMBOSSET';
  let componentFieldIds = new Set();

  if (isMaterialComboFlow) {
    const componentMapRows = await _loadMaterialComboComponentMap(tx, {
      processId: scopedProcessId,
      sapTargetId
    });
    const expected = new Set(MATERIAL_COMBO_COMPONENT_FIELD_CODES);
    const actual = new Set(componentMapRows.map((r) => r.fieldCode));
    const missing = MATERIAL_COMBO_COMPONENT_FIELD_CODES.filter((c) => !actual.has(c));
    const extras = Array.from(actual).filter((c) => !expected.has(c));
    if (missing.length) {
      _throwMaterialComboConfigError(entitySet, `missing component mappings: ${missing.join(', ')}`);
    }
    if (extras.length) {
      _throwMaterialComboConfigError(entitySet, `unexpected component mappings: ${extras.join(', ')}`);
    }

    const componentMapByCode = new Map(componentMapRows.map((r) => [r.fieldCode, r]));
    componentFieldIds = new Set(componentMapRows.map((r) => r.fieldId));

    const latestByFieldLine = new Map();
    for (const row of rows || []) {
      const fieldId = String(row.FIELD_ID || '').trim();
      if (!componentFieldIds.has(fieldId)) continue;
      const lineNo = Number(row.LINE_NO || 1);
      const key = `${fieldId}::${lineNo}`;
      if (!latestByFieldLine.has(key)) latestByFieldLine.set(key, row);
    }

    const byLine = new Map();
    for (const row of latestByFieldLine.values()) {
      const lineNo = Number(row.LINE_NO || 1);
      if (!byLine.has(lineNo)) byLine.set(lineNo, {});
      const fieldCode = String(row.FIELD_CODE || '').trim().toUpperCase();
      byLine.get(lineNo)[fieldCode] = row.VALUE;
    }

    const lineErrors = [];
    const lineItems = [];
    const orderedLineNos = Array.from(byLine.keys()).sort((a, b) => a - b);
    for (const lineNo of orderedLineNos) {
      const rowByCode = byLine.get(lineNo) || {};
      const rawStlan = String(rowByCode['STPO.STLAN'] ?? '').trim();
      const resolvedStlan = rawStlan || '5';

      const missingFields = [];
      for (const fieldCode of MATERIAL_COMBO_REQUIRED_COMPONENT_CODES) {
        const v = String(rowByCode[fieldCode] ?? '').trim();
        if (!v) missingFields.push(fieldCode);
      }
      if (missingFields.length) {
        lineErrors.push(`LINE_NO ${lineNo}: ${missingFields.join(', ')}`);
        continue;
      }

      const lineRawByCode = {
        ...rowByCode,
        'STPO.STLAN': resolvedStlan
      };

      const lineItem = {};
      for (const fieldCode of MATERIAL_COMBO_COMPONENT_FIELD_CODES) {
        const mapRow = componentMapByCode.get(fieldCode);
        if (!mapRow) continue;
        const raw = String(lineRawByCode[fieldCode] ?? '').trim();
        if (!raw) continue;
        const conversion = convertValueForSap(raw, {
          fallbackDataType: mapRow.dataType
        });
        if (!conversion.ok) {
          lineErrors.push(`LINE_NO ${lineNo}: ${fieldCode} (${conversion.reason || 'type_conversion_failed'})`);
          continue;
        }
        lineItem[mapRow.sapProperty] = conversion.value;
      }
      if (Object.keys(lineItem).length) {
        lineItems.push(lineItem);
      }
    }

    if (lineErrors.length) {
      _throwMaterialComboMandatoryError(entitySet, lineErrors);
    }
    payload.N_Componentes = lineItems;
  }

  for (const row of rows || []) {
    const fieldId = row.FIELD_ID;
    if (componentFieldIds.has(String(fieldId || '').trim())) {
      skippedFields.push({
        fieldId,
        fieldCode: row.FIELD_CODE,
        sapField: row.SAP_FIELD,
        reason: 'component_multi_line_group'
      });
      continue;
    }
    if (selectedFieldIds.has(fieldId)) continue;
    selectedFieldIds.add(fieldId);
    const fieldCode = String(row.FIELD_CODE || '').trim();
    if (fieldCode.toUpperCase().startsWith('MDG_CTRL.')) {
      skippedFields.push({ fieldId, fieldCode, sapField: null, reason: 'internal_control_field' });
      continue;
    }

    const sapField = String(row.SAP_FIELD || '').trim();
    let rawValue = row.VALUE;
    const fieldControl = Number(fieldControlByFieldId.get(fieldId) ?? 0);
    const hasPersistedValue = _isNonEmpty(rawValue);
    if (fieldControl === 7 && !hasPersistedValue) {
      skippedFields.push({ fieldId, fieldCode: row.FIELD_CODE, sapField: row.SAP_FIELD, reason: 'hidden_without_value' });
      continue;
    }
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

    // Resource name rule:
    // /SAPAPO/RES_HEAD.NAME must start with CL (prepend if missing, avoid duplicates).
    const isResHeadName =
      _normalizePropertyName(fieldCode) === _normalizePropertyName('/SAPAPO/RES_HEAD.NAME') ||
      _normalizePropertyName(sapField) === _normalizePropertyName('/SAPAPO/RES_HEAD.NAME');
    if (isResHeadName && rawValue !== undefined && rawValue !== null) {
      const nameValue = String(rawValue).trim();
      if (nameValue) {
        rawValue = nameValue.toUpperCase().startsWith('CL') ? nameValue : `CL${nameValue}`;
      }
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
  req,
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
  const destinationName = _normalizeS4DestinationName(sapTarget?.destinationName);

  return _postToS4AndPersistLegacy(tx, {
    req,
    requestId,
    processId,
    processCode,
    sapTarget,
    payload,
    userId,
    previousStatus,
    skippedFields,
    updateRequestState,
    emitErrorBusinessComment,
    updateSubjectFromSap
  });
}

async function _postToS4AndPersistLegacy(tx, {
  req,
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
  const destinationName = _normalizeS4DestinationName(sapTarget?.destinationName);
  const servicePath = String(sapTarget?.servicePath || '').trim();
  const entitySet = String(sapTarget?.entitySet || '').trim();
  const sapTargetId = sapTarget?.id || null;
  const jwt = _extractJwtFromReq(req);
  const claims = _decodeJwtPayloadUnsafe(jwt);
  const nowEpoch = Math.floor(Date.now() / 1000);
  console.info('[PP_DEBUG_REQUEST]', JSON.stringify({
    destinationName,
    servicePath,
    entitySet,
    hasJwt: Boolean(jwt),
    tokenMask: _maskToken(jwt),
    reqUserId: req?.user?.id || null,
    claims: {
      user_name: claims.user_name || null,
      login_name: claims.login_name || null,
      email: claims.email || null,
      sub: claims.sub || null,
      user_id: claims.user_id || null,
      origin: claims.origin || null,
      iss: claims.iss || null,
      exp: claims.exp || null,
      expInSec: claims.exp ? Number(claims.exp) - nowEpoch : null
    }
  }));

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
      jwt ? { destinationName, jwt } : { destinationName },
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
    console.warn('[PP_DEBUG_ERROR]', JSON.stringify({
      destinationName,
      servicePath,
      entitySet,
      status,
      message: String(err?.message || ''),
      wwwAuthenticate:
        err?.response?.headers?.['www-authenticate'] ||
        err?.response?.headers?.['WWW-Authenticate'] ||
        null
    }));
  }

  const correlationId = _extractCorrelationId(responseHeaders, errorHeaders);
  console.log('[SAP_POST_RESULT]', {
    processCode,
    entitySet,
    status,
    correlationId
  });
  const sapObjectKey = _extractSapObjectKey(responseBody);
  const responseJson = _stringifySafe(responseBody) || '';

  const ok = status >= 200 && status < 300;
  await _upsertSapStepMessage(tx, {
    requestId,
    sapTargetId,
    httpStatus: status,
    correlationId,
    sapObjectKey,
    payload,
    responseBody,
    processCode,
    targetCode: sapTarget?.targetCode || null,
    entitySet,
    status: _toStepStatus(ok),
    message: _toStepMessage({
      ok,
      status: _toStepStatus(ok),
      entitySet,
      sapObjectKey,
      sapErrorMessage: ok ? null : _extractSapErrorMessage(responseBody)
    })
  });
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

function _setPayloadPropertyFromSchema(entitySet, payload, propertyCandidates, value, fallbackProperty) {
  const resolvedValue = String(value || '').trim();
  if (!resolvedValue || !payload || typeof payload !== 'object') return payload;
  const schema = getEntitySetSchema(entitySet);
  const props = schema?.properties || {};
  const map = new Map();
  for (const k of Object.keys(props)) map.set(_normalizePropertyName(k), k);
  for (const candidate of propertyCandidates || []) {
    const canonical = map.get(_normalizePropertyName(candidate));
    if (canonical) {
      payload[canonical] = resolvedValue;
      return payload;
    }
  }
  if (fallbackProperty && !Object.prototype.hasOwnProperty.call(payload, fallbackProperty)) {
    payload[fallbackProperty] = resolvedValue;
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

async function _persistSkippedStepResult(tx, {
  requestId,
  processCode,
  sapTarget,
  reason,
  message,
  externalId = null
}) {
  await _upsertSapStepMessage(tx, {
    requestId,
    sapTargetId: sapTarget?.id || null,
    httpStatus: 208,
    correlationId: null,
    sapObjectKey: externalId || null,
    payload: {},
    responseBody: { skipped: true, reason: reason || null },
    processCode,
    targetCode: sapTarget?.targetCode || null,
    entitySet: sapTarget?.entitySet || null,
    status: 'SKIPPED',
    message: message || `Step ${sapTarget?.entitySet || sapTarget?.targetCode || 'UNKNOWN'} skipped`
  });
}

function _parseResultEnvelope(responseJsonRaw) {
  if (!responseJsonRaw) return null;
  let parsed = null;
  try {
    parsed = typeof responseJsonRaw === 'string' ? JSON.parse(responseJsonRaw) : responseJsonRaw;
  } catch (_err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed._mdgResult && typeof parsed._mdgResult === 'object' ? parsed._mdgResult : null;
}

async function _fetchRequestResults(tx, requestId) {
  const rows = await tx.run(
    `SELECT
        m."ID" AS "ID",
        m."HTTP_STATUS" AS "HTTP_STATUS",
        m."CORRELATION_ID" AS "CORRELATION_ID",
        m."SAP_OBJECT_KEY" AS "SAP_OBJECT_KEY",
        m."RESPONSE_JSON" AS "RESPONSE_JSON",
        m."CREATEDAT" AS "CREATEDAT",
        t."TARGET_CODE" AS "TARGET_CODE",
        t."ENTITYSET" AS "ENTITYSET",
        p."PROCESS_CODE" AS "PROCESS_CODE"
       FROM "MDG_REQUEST_SAP_MESSAGE" m
       LEFT JOIN "MDG_SAP_TARGET" t ON t."ID" = m."SAP_TARGET_ID"
       LEFT JOIN "MDG_REQUEST_HEADER" r ON r."ID" = m."REQUEST_ID"
       LEFT JOIN "MDG_PROCESS" p ON p."ID" = r."PROCESS_ID"
      WHERE m."REQUEST_ID" = ?
      ORDER BY m."CREATEDAT" ASC, m."ID" ASC`,
    [requestId]
  );

  const normalized = (rows || []).map((row) => {
    const meta = _parseResultEnvelope(row.RESPONSE_JSON);
    const statusFromHttp = Number(row.HTTP_STATUS || 0) >= 200 && Number(row.HTTP_STATUS || 0) < 300 ? 'SUCCESS' : 'ERROR';
    const status = String(meta?.status || statusFromHttp).toUpperCase();
    const stepCode = meta?.stepCode
      || _toStepCode(row.PROCESS_CODE, row.ENTITYSET, row.TARGET_CODE);
    const message = meta?.message
      || _toStepMessage({
        ok: status === 'SUCCESS',
        status,
        entitySet: row.ENTITYSET,
        sapObjectKey: row.SAP_OBJECT_KEY,
        sapErrorMessage: null
      });
    return {
      stepCode,
      status,
      externalId: String(meta?.externalId || row.SAP_OBJECT_KEY || '').trim() || null,
      message,
      targetCode: row.TARGET_CODE || null,
      entitySet: row.ENTITYSET || null,
      correlationId: row.CORRELATION_ID || null,
      createdAt: row.CREATEDAT
    };
  });

  // Keep UI idempotent: expose latest record per step code while preserving storage history.
  const latestByStep = new Map();
  for (const item of normalized) {
    const key = String(item.stepCode || '').trim().toUpperCase();
    if (!key) continue;
    const prev = latestByStep.get(key);
    const prevTs = prev?.createdAt ? new Date(prev.createdAt).getTime() : -1;
    const currTs = item?.createdAt ? new Date(item.createdAt).getTime() : -1;
    if (!prev || currTs >= prevTs) latestByStep.set(key, item);
  }
  return Array.from(latestByStep.values())
    .filter((item) => String(item.status || '').toUpperCase() !== 'SKIPPED')
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
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
    await _assertMaterialCodeDoesNotExist(tx, req, { requestId, processCode });
    const sapTargets = await _resolveSapTargetsForProcess(tx, { processId, operation: 'POST' });
    if (!sapTargets.length) {
      req.reject(422, _t(req, 'noSapTargetConfigured', { processCode: processCode || 'UNKNOWN' }));
    }

    if (processCode === 'CUSTOMER_CREATION') {
      const requesterRoleId = await _resolveRequesterRoleId(tx, processId);
      const allTargets = await _resolveSapTargetsForProcessAnyState(tx, { processId, operation: 'POST' });
      const enabledTargets = (allTargets || []).filter((t) => t.isEnabled);
      if (!enabledTargets.length) {
        req.reject(422, _t(req, 'noSapTargetConfigured', { processCode: processCode || 'UNKNOWN' }));
      }

      const classified = enabledTargets.map((t) => ({ ...t, ..._classifyCustomerCreationTarget(t) }));
      const customerMain = classified.find((t) => t.stepType === 'CUSTOMER_MAIN');
      const destMercMain = classified.find((t) => t.stepType === 'DESTMERC_MAIN');
      if (!customerMain) {
        req.reject(422, _t(req, 'noSapTargetForEntitySet', { processCode: processCode || 'UNKNOWN', entitySet: 'CUSTOMER_MAIN' }));
      }
      if (!destMercMain) {
        req.reject(422, _t(req, 'noSapTargetForEntitySet', { processCode: processCode || 'UNKNOWN', entitySet: 'DESTMERC_MAIN' }));
      }

      const orderedSteps = [
        customerMain,
        destMercMain,
        ...classified.filter((t) => t.id !== customerMain.id && t.id !== destMercMain.id)
          .sort((a, b) => {
            if (a.order !== b.order) return a.order - b.order;
            return String(a.entitySet || '').localeCompare(String(b.entitySet || ''));
          })
      ];

      const disabledTargets = (allTargets || []).filter((t) => !t.isEnabled);
      for (const target of disabledTargets) {
        await _persistSkippedStepResult(tx, {
          requestId,
          processCode,
          sapTarget: target,
          reason: 'target_disabled',
          message: `Paso ${target.entitySet || target.targetCode || target.id} omitido por configuración deshabilitada`
        });
        await insertComment(tx, {
          requestId,
          authorUser: userId,
          authorRole: roleToBusinessName(ROLE_CODES.APPROVER),
          message: `Paso ${target.entitySet || target.targetCode || target.id} omitido por configuración deshabilitada`
        });
      }

      const stepResults = [];
      let customerId = String(request?.SUBJECT_ID || '').trim() || null;
      let destMercId = null;

      for (const step of orderedSteps) {
        const stepKey = step.stepType === 'CUSTOMER_MAIN'
          ? 'CLIENTE'
          : (step.stepType === 'DESTMERC_MAIN' ? 'DESTMERC_GENERAL' : `FOLLOWUP_${step.entitySet}`);
        const entitySet = String(step.entitySet || '').trim();

        const alreadyOk = await _readLatestSuccessfulStep(tx, {
          requestId,
          processId,
          entitySet
        });
        if (alreadyOk) {
          const resumedId = String(alreadyOk.SAP_OBJECT_KEY || '').trim() || null;
          if (step.stepType === 'CUSTOMER_MAIN' && resumedId && !customerId) {
            customerId = resumedId;
            await _upsertRequestSubject(tx, {
              requestId,
              subjectId: customerId,
              subjectType: 'CUSTOMER',
              userId,
              source: 'WORKFLOW_APPROVE_RESUME'
            });
          }
          if (step.stepType === 'DESTMERC_MAIN' && resumedId) {
            destMercId = resumedId;
          }
          stepResults.push({
            step,
            result: {
              ok: true,
              requestId,
              processCode,
              entitySet,
              httpStatus: Number(alreadyOk.HTTP_STATUS || 200),
              finalStatus: STATUS_COMPLETED,
              skippedFields: [],
              sapObjectKey: resumedId,
              resumed: true
            }
          });
          await _persistSkippedStepResult(tx, {
            requestId,
            processCode,
            sapTarget: step,
            reason: 'already_completed',
            message: `Paso ${entitySet} omitido por estar previamente completado`,
            externalId: resumedId || null
          });
          await insertActionLog(tx, {
            requestId,
            action: 'SAP_STEP_SKIPPED',
            actorUser: userId,
            actorRole: ROLE_CODES.APPROVER,
            comment: _stringifySafe({
              step: stepKey,
              entitySet,
              reason: 'already_completed'
            })
          });
          continue;
        }

        const targetFieldMeta = await _loadSapTargetFieldMeta(tx, {
          processId,
          sapTargetId: step.id
        });
        const allowedFieldIds = targetFieldMeta.map((r) => String(r.FIELD_ID || '').trim()).filter(Boolean);

        const { payload, skippedFields } = await _buildSapPayload(
          tx,
          requestId,
          entitySet,
          processId,
          {
            allowedFieldIds,
            processRoleId: requesterRoleId,
            countryCode: request.COUNTRY_CODE,
            creationDateOverride: requestCreatedDate,
            excludeSapFields: entitySet === 'ClientesGeneralSet' ? ['Zzfechac'] : []
          }
        );

        const defaultResult = await _applyConfiguredDefaultsToPayload(tx, {
          processRoleId: requesterRoleId,
          countryCode: request.COUNTRY_CODE,
          entitySet,
          allowedFieldIds,
          payload
        });

        try {
          await _validateMandatoryForFieldIds(tx, {
            requestId,
            processRoleId: requesterRoleId,
            countryCode: request.COUNTRY_CODE,
            fieldIds: allowedFieldIds,
            entitySet,
            payload
          });
        } catch (err) {
          if (err?.code === 'MANDATORY_FIELDS_MISSING_STEP') {
            req.reject(400, _t(req, 'mandatoryFieldsMissingForStep', {
              entitySet,
              fields: (err.details || []).join(', ')
            }));
          }
          throw err;
        }

        let mirrored = defaultResult.backfilled || [];
        if (step.stepType === 'DESTMERC_MAIN') {
          const mirroredResult = await _applyCustomerToDestMercMirror(tx, {
            requestId,
            processId,
            countryCode: request.COUNTRY_CODE,
            entitySet,
            targetFieldMeta,
            payload
          });
          mirrored = [...mirrored, ...(mirroredResult.mirrored || [])];
        }

        const derivedResult = _applyDerivedBusinessTermsToPayload(payload, { processCode });
        mirrored = [...mirrored, ...(derivedResult.derived || [])];

        const stepSubjectId = (
          step.stepType === 'CUSTOMER_COMP' || step.stepType === 'CUSTOMER_SALES'
            ? customerId
            : (step.stepType === 'DESTMERC_SALES' ? destMercId : (destMercId || customerId))
        );
        const idForChildSteps = String(stepSubjectId || '').trim() || null;
        if (step.stepType === 'CUSTOMER_COMP' || step.stepType === 'CUSTOMER_SALES') {
          if (!idForChildSteps) {
            req.reject(422, `Customer creation follow-up step ${entitySet} requires the newly created customer ID, but no customer ID was resolved from the previous step.`);
          }
        }
        if (step.stepType === 'DESTMERC_SALES') {
          if (!idForChildSteps) {
            req.reject(422, `Destinatario mercaderia follow-up step ${entitySet} requires the newly created destinatario ID, but no destinatario ID was resolved from the previous step.`);
          }
        }
        if (step.stepType !== 'CUSTOMER_MAIN' && idForChildSteps) {
          // Follow-up steps in CUSTOMER_CREATION must always use the IDs created in prior SAP steps.
          _setCustomerIdInPayloadFromSchema(entitySet, payload, idForChildSteps);
        }
        if (step.stepType === 'DESTMERC_SALES' && customerId) {
          _setPayloadPropertyFromSchema(
            entitySet,
            payload,
            ['KunnrPrinc', 'KUNNRPRINC', 'CustomerPrincipal'],
            customerId,
            'KunnrPrinc'
          );
        }

        const result = await _postToS4AndPersist(tx, {
          req,
          requestId,
          processId,
          processCode,
          sapTarget: step,
          payload,
          userId,
          previousStatus: status,
          skippedFields,
          updateRequestState: false,
          emitErrorBusinessComment: false,
          updateSubjectFromSap: step.stepType === 'CUSTOMER_MAIN'
        });

        await insertActionLog(tx, {
          requestId,
          action: result.ok ? 'SAP_STEP_OK' : 'SAP_STEP_ERROR',
          actorUser: userId,
          actorRole: ROLE_CODES.APPROVER,
          comment: _stringifySafe({
            step: stepKey,
            entitySet,
            ok: result.ok,
            httpStatus: result.httpStatus,
            sapObjectKey: result.sapObjectKey || null,
            payload: _summarizePayload(payload),
            mirrored
          })
        });

        if (result.ok) {
          const stepId = String(result.sapObjectKey || '').trim() || null;
          if (step.stepType === 'CUSTOMER_MAIN') {
            customerId = stepId || customerId;
          } else if (step.stepType === 'DESTMERC_MAIN') {
            destMercId = stepId || destMercId;
          }

          let message = null;
          if (step.stepType === 'CUSTOMER_MAIN') {
            message = `Cliente creado: ${stepId || '(sin id)'}`;
          } else if (step.stepType === 'DESTMERC_MAIN') {
            message = `Destinatario mercadería creado: ${stepId || '(sin id)'}`;
          } else {
            message = `Paso ${entitySet} ejecutado correctamente${stepId ? ` (ID: ${stepId})` : ''}.`;
          }
          await insertComment(tx, {
            requestId,
            authorUser: userId,
            authorRole: roleToBusinessName(ROLE_CODES.APPROVER),
            message
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

      const lastStep = stepResults[stepResults.length - 1]?.result || null;
      approveResult = {
        ok: !failed,
        requestId,
        processCode,
        entitySet: orderedSteps.map((s) => s.entitySet).join(','),
        stepCount: stepResults.length,
        httpStatus: failed ? failed.result.httpStatus : (lastStep?.httpStatus || 200),
        finalStatus,
        skippedFields: anySkipped,
        sapObjectKey: String(destMercId || customerId || '').trim() || null
      };
    } else if (processCode === 'DESTMERC_CREATION') {
      const requesterRoleId = await _resolveRequesterRoleId(tx, processId);
      const allTargets = await _resolveSapTargetsForProcessAnyState(tx, { processId, operation: 'POST' });
      const enabledTargets = (allTargets || []).filter((t) => t.isEnabled);
      if (!enabledTargets.length) {
        req.reject(422, _t(req, 'noSapTargetConfigured', { processCode: processCode || 'UNKNOWN' }));
      }

      const classified = enabledTargets.map((t) => ({ ...t, ..._classifyDestMercCreationTarget(t) }));
      const orderedSteps = classified.sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return String(a.entitySet || '').localeCompare(String(b.entitySet || ''));
      });

      const customerPrincipalId = await _readLatestRequestFieldValueByCodes(tx, {
        requestId,
        fieldCodes: ['BUT000-KNA1.KUNNR', 'KNA1.KUNNR']
      });

      const stepResults = [];
      let destMercId = String(request?.SUBJECT_ID || '').trim() || null;

      for (const step of orderedSteps) {
        const entitySet = String(step.entitySet || '').trim();
        const alreadyOk = await _readLatestSuccessfulStep(tx, {
          requestId,
          processId,
          entitySet
        });
        if (alreadyOk) {
          const resumedId = String(alreadyOk.SAP_OBJECT_KEY || '').trim() || null;
          if (step.stepType === 'DESTMERC_MAIN' && resumedId && !destMercId) {
            destMercId = resumedId;
          }
          stepResults.push({
            step,
            result: {
              ok: true,
              requestId,
              processCode,
              entitySet,
              httpStatus: Number(alreadyOk.HTTP_STATUS || 200),
              finalStatus: STATUS_COMPLETED,
              skippedFields: [],
              sapObjectKey: resumedId,
              resumed: true
            }
          });
          continue;
        }

        const targetFieldMeta = await _loadSapTargetFieldMeta(tx, {
          processId,
          sapTargetId: step.id
        });
        const allowedFieldIds = targetFieldMeta.map((r) => String(r.FIELD_ID || '').trim()).filter(Boolean);
        const { payload, skippedFields } = await _buildSapPayload(
          tx,
          requestId,
          entitySet,
          processId,
          {
            allowedFieldIds,
            processRoleId: requesterRoleId,
            countryCode: request.COUNTRY_CODE,
            processCode,
            sapTargetId: step.id
          }
        );

        await _applyConfiguredDefaultsToPayload(tx, {
          processRoleId: requesterRoleId,
          countryCode: request.COUNTRY_CODE,
          entitySet,
          allowedFieldIds,
          payload
        });
        _applyDerivedBusinessTermsToPayload(payload, { processCode });

        if (step.stepType === 'CUSTOMER_SALES') {
          if (!customerPrincipalId) {
            req.reject(422, 'La creación de destinatario requiere un cliente principal para ampliar el área de ventas.');
          }
          _setCustomerIdInPayloadFromSchema(entitySet, payload, customerPrincipalId);
        }
        if (step.stepType === 'DESTMERC_SALES' || step.stepType === 'DESTMERC_TAX') {
          if (!destMercId) {
            req.reject(422, `El paso ${entitySet} requiere el ID del destinatario recién creado.`);
          }
          _setCustomerIdInPayloadFromSchema(entitySet, payload, destMercId);
        }
        if (step.stepType === 'DESTMERC_SALES' && customerPrincipalId) {
          _setPayloadPropertyFromSchema(
            entitySet,
            payload,
            ['KunnrPrinc', 'KUNNRPRINC', 'CustomerPrincipal'],
            customerPrincipalId,
            'KunnrPrinc'
          );
        }

        const result = await _postToS4AndPersist(tx, {
          req,
          requestId,
          processId,
          processCode,
          sapTarget: step,
          payload,
          userId,
          previousStatus: status,
          skippedFields,
          updateRequestState: false,
          emitErrorBusinessComment: false,
          updateSubjectFromSap: step.stepType === 'DESTMERC_MAIN'
        });

        if (result.ok && step.stepType === 'DESTMERC_MAIN') {
          destMercId = String(result.sapObjectKey || '').trim() || destMercId;
        }

        stepResults.push({ step, result });
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

      const lastStep = stepResults[stepResults.length - 1]?.result || null;
      approveResult = {
        ok: !failed,
        requestId,
        processCode,
        entitySet: orderedSteps.map((s) => s.entitySet).join(','),
        stepCount: stepResults.length,
        httpStatus: failed ? failed.result.httpStatus : (lastStep?.httpStatus || 200),
        finalStatus,
        skippedFields: anySkipped,
        sapObjectKey: String(destMercId || customerPrincipalId || '').trim() || null
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
          await _persistSkippedStepResult(tx, {
            requestId,
            processCode,
            sapTarget: target,
            reason: 'already_completed',
            message: `Paso ${target.entitySet} omitido por estar previamente completado`,
            externalId: conductorId
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
          req,
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
        stepCount: stepResults.length,
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

      const requesterRoleId = await _resolveRequesterRoleId(tx, processId);
      const targetFieldMeta = await _loadSapTargetFieldMeta(tx, {
        processId,
        sapTargetId: sapTarget.id
      });
      const allowedFieldIds = targetFieldMeta.map((r) => String(r.FIELD_ID || '').trim()).filter(Boolean);
      const { payload, skippedFields } = await _buildSapPayload(tx, requestId, sapTarget.entitySet, processId, {
        processCode,
        sapTargetId: sapTarget.id,
        processRoleId: requesterRoleId,
        countryCode: request.COUNTRY_CODE
      });

      await _applyConfiguredDefaultsToPayload(tx, {
        processRoleId: requesterRoleId,
        countryCode: request.COUNTRY_CODE,
        entitySet: sapTarget.entitySet,
        allowedFieldIds,
        payload
      });
      _applyDerivedBusinessTermsToPayload(payload, { processCode });

      approveResult = await _postToS4AndPersist(tx, {
        req,
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
      if (approveResult && approveResult.stepCount === undefined) {
        approveResult.stepCount = 1;
      }
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

  if (actionName === 'APPROVE' && approveResult?.ok && Number(approveResult?.stepCount || 1) <= 1) {
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

async function getRequestResults(req) {
  const tx = cds.tx(req);
  const requestId = req.data?.requestId || req.data?.REQUEST_ID || req.data?.ID || req.data?.id;
  if (!requestId) req.reject(400, _t(req, 'idRequired'));

  const request = await getRequestById(tx, requestId);
  if (!request) req.reject(404, _t(req, 'requestNotFound', { requestId }));
  if (request.ISDELETED) req.reject(409, _t(req, 'requestDeleted'));

  return _fetchRequestResults(tx, requestId);
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
  service.on('getRequestResults', getRequestResults);
}

module.exports = { register, getRequestResults };
