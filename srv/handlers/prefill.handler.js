const cds = require('@sap/cds');
const { s4Get } = require('./_lib/s4.client');
const {
  FIELD_CONTROL,
  currentUserId,
  getEffectiveFieldControl,
  getRequestById,
  getUserRoleAssignments,
  normalizeStatus,
  now,
  resolveEditorRoleFromStatus,
  uuid
} = require('./_lib/mdg-workflow.util');
const { insertRequestFieldChangeLog } = require('./_lib/request-change-log.util');

const CUSTOMER_PREFILL_SOURCES = [
  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS', entitySet: 'zcds_clientes_gen', required: true },
  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS', entitySet: 'zcds_clientes_orgv' },
  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_SOC_CDS', entitySet: 'zcds_clientes_soc' },
  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_COM_CDS', entitySet: 'ZCDS_CLIENTES_COM' },
  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_EMP_CDS', entitySet: 'zcds_clientes_emp' },
  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_BAN_CDS', entitySet: 'zcds_clientes_ban' },
  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_IMP_CDS', entitySet: 'zcds_clientes_Imp' },
  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_NIF_CDS', entitySet: 'zcds_clientes_nif' }
];
const GEN_SOURCE = CUSTOMER_PREFILL_SOURCES[0];
const NON_GEN_SOURCES = CUSTOMER_PREFILL_SOURCES.slice(1);

function escapeODataString(value) {
  return String(value).replace(/'/g, "''");
}

function toPersistedValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function pickPayloadValue(payload, sapField) {
  if (!sapField) return undefined;

  if (Object.prototype.hasOwnProperty.call(payload, sapField)) return payload[sapField];

  const upper = sapField.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(payload, upper)) return payload[upper];

  const lower = sapField.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(payload, lower)) return payload[lower];

  return undefined;
}

function mergeRows(target, rows) {
  for (const row of rows || []) {
    for (const [key, value] of Object.entries(row || {})) {
      if (key.startsWith('__')) continue;
      if (value === null || value === undefined || value === '') continue;
      if (!Object.prototype.hasOwnProperty.call(target, key)) {
        target[key] = value;
      }
    }
  }
}

function canonicalFieldCode(sapTable, sapField) {
  const table = String(sapTable || '').trim().toUpperCase();
  const field = String(sapField || '').trim().toUpperCase();
  if (!table || !field) return '';
  return `${table}.${field}`;
}

async function fetchCustomerPayload(subjectId) {
  return fetchCustomerPayloadBySubject({ subjectId, subjectFieldCode: 'KNA1.KUNNR' });
}

function resolveSubjectStrategy(subjectFieldCode) {
  const normalized = typeof subjectFieldCode === 'string' ? subjectFieldCode.trim() : '';
  if (normalized === 'BUT000.PARTNER') {
    return { type: 'PARTNER', genKeyCandidates: ['Partner', 'BusinessPartner'] };
  }
  if (/\.SORTL$/i.test(normalized)) {
    return { type: 'SORTL', genKeyCandidates: ['Sortl', 'TaxNumber1'] };
  }
  if (/\.KUNNR$/i.test(normalized)) {
    return { type: 'KUNNR', genKeyCandidates: ['Kunnr', 'Sortl'] };
  }
  return null;
}

function isCustomerSubjectField(subjectFieldCode) {
  return Boolean(resolveSubjectStrategy(subjectFieldCode));
}

function extractKunnr(rows, fallbackSubjectId, strategyType) {
  for (const row of rows || []) {
    const value = row?.Kunnr ?? row?.KUNNR;
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  if (strategyType === 'KUNNR') return String(fallbackSubjectId).trim();
  return '';
}

async function queryRowsByField(source, fieldName, subjectId) {
  const escaped = escapeODataString(subjectId);
  const filter = `${fieldName} eq '${escaped}'`;
  return s4Get({
    servicePath: source.servicePath,
    entitySet: source.entitySet,
    query: { $filter: filter, $top: 10 }
  });
}

async function readBlockSapSources(tx, processId) {
  if (!processId) return [];
  try {
    const rows = await tx.run(
      `SELECT
          "BLOCK_ID"         AS "BLOCK_ID",
          "DESTINATION_NAME" AS "DESTINATION_NAME",
          "SERVICE_PATH"     AS "SERVICE_PATH",
          "ENTITYSET"        AS "ENTITYSET",
          "KEY_FIELD"        AS "KEY_FIELD",
          "FILTER_TEMPLATE"  AS "FILTER_TEMPLATE",
          "IS_COLLECTION"    AS "IS_COLLECTION"
         FROM "MDG_BLOCK_SAP_SOURCE"
        WHERE "PROCESS_ID" = ?
          AND "IS_ENABLED" = true
        ORDER BY "BLOCK_ID", "ID"`,
      [processId]
    );
    return rows || [];
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('mdg_block_sap_source') && (msg.includes('invalid table') || msg.includes('not found') || msg.includes('does not exist'))) {
      return [];
    }
    throw err;
  }
}

function buildSourceFilter({ keyField, filterTemplate, subjectId }) {
  const escaped = escapeODataString(subjectId);
  const template = String(filterTemplate || '').trim();
  if (template) {
    return template
      .replace(/\{subjectId\}/gi, escaped)
      .replace(/\{SUBJECT_ID\}/g, escaped);
  }
  const key = String(keyField || '').trim();
  if (!key) return '';
  return `${key} eq '${escaped}'`;
}

async function fetchPayloadFromBlockSources(tx, { processId, subjectId }) {
  const sources = await readBlockSapSources(tx, processId);
  if (!sources.length || !subjectId) return { payload: {}, usedSources: [] };

  const payload = {};
  const usedSources = [];
  for (const source of sources) {
    const servicePath = String(source.SERVICE_PATH || '').trim();
    const entitySet = String(source.ENTITYSET || '').trim();
    if (!servicePath || !entitySet) continue;

    const filter = buildSourceFilter({
      keyField: source.KEY_FIELD,
      filterTemplate: source.FILTER_TEMPLATE,
      subjectId
    });
    const query = { $top: 50 };
    if (filter) query.$filter = filter;

    try {
      const rows = await s4Get({ servicePath, entitySet, query });
      mergeRows(payload, rows);
      usedSources.push({ servicePath, entitySet, rows: rows.length });
    } catch (err) {
      console.warn(`[PREFILL_BLOCK_SOURCE] request processId=${processId} source=${servicePath}/${entitySet} failed: ${err?.message || err}`);
    }
  }
  return { payload, usedSources };
}

async function fetchCustomerPayloadBySubject({ subjectId, subjectFieldCode }) {
  const payload = {};
  const strategy = resolveSubjectStrategy(subjectFieldCode);
  if (!strategy) {
    const err = new Error(`Unsupported subjectFieldCode: ${subjectFieldCode}`);
    err.statusCode = 400;
    throw err;
  }

  // GEN is mandatory; use subject key strategy to find the record.
  let genRows = [];
  let lastGenError = null;
  for (const keyField of strategy.genKeyCandidates) {
    try {
      const rows = await queryRowsByField(GEN_SOURCE, keyField, subjectId);
      if (rows.length > 0) {
        genRows = rows;
        break;
      }
    } catch (err) {
      lastGenError = err;
    }
  }
  if (!genRows.length && lastGenError && GEN_SOURCE.required) throw lastGenError;

  mergeRows(payload, genRows);

  const kunnr = extractKunnr(genRows, subjectId, strategy.type);
  if (!kunnr) return payload;

  // Remaining customer services are queried by KUNNR.
  for (const source of NON_GEN_SOURCES) {
    try {
      const rows = await queryRowsByField(source, 'Kunnr', kunnr);
      mergeRows(payload, rows);
    } catch (err) {
      if (source.required) throw err;
    }
  }

  return payload;
}

async function readRequestPrefillFields(tx, processId) {
  return tx.run(
    `SELECT DISTINCT
        fc."ID"         AS "FIELD_ID",
        fc."FIELD_CODE" AS "FIELD_CODE",
        fc."SAP_TABLE"  AS "SAP_TABLE",
        fc."SAP_FIELD"  AS "SAP_FIELD"
       FROM "MDG_PROCESS_BLOCK" pb
       JOIN "MDG_BLOCK_FIELD" bf
         ON bf."BLOCK_ID" = pb."BLOCK_ID"
       JOIN "MDG_FIELD_CATALOG" fc
         ON fc."ID" = bf."FIELD_ID"
      WHERE pb."PROCESS_ID" = ?
        AND fc."SAP_TABLE" IS NOT NULL
        AND fc."SAP_FIELD" IS NOT NULL
        AND LENGTH(TRIM(fc."SAP_TABLE")) > 0
        AND LENGTH(TRIM(fc."SAP_FIELD")) > 0`,
    [processId]
  );
}

async function prefillCustomer(req) {
  const tx = cds.tx(req);
  const userId = currentUserId(req);

  const requestId = req.data?.requestId;
  const subjectId = typeof req.data?.subjectId === 'string' ? req.data.subjectId.trim() : '';
  const countryCode = typeof req.data?.countryCode === 'string' ? req.data.countryCode.trim() : '';
  const subjectFieldCode = typeof req.data?.subjectFieldCode === 'string' ? req.data.subjectFieldCode.trim() : '';

  if (!requestId) req.reject(400, 'requestId is required');
  if (!countryCode) req.reject(400, 'countryCode is required');
  if (!subjectFieldCode) req.reject(400, 'subjectFieldCode is required');

  const request = await getRequestById(tx, requestId);
  if (!request) req.reject(404, `Request not found: ${requestId}`);
  if (request.ISDELETED) req.reject(409, 'Request is deleted');
  if (request.COUNTRY_CODE !== countryCode) {
    req.reject(400, `countryCode mismatch: request country is ${request.COUNTRY_CODE}`);
  }

  const status = normalizeStatus(request.STATUS);
  const assignments = await getUserRoleAssignments(tx, req, {
    processId: request.PROCESS_ID,
    countryCode: request.COUNTRY_CODE
  });
  const editor = resolveEditorRoleFromStatus(assignments, status);
  if (!editor) {
    req.reject(403, `User cannot edit RequestValues for status ${status}`);
  }

  if (!subjectId) {
    return JSON.stringify({ ok: true, updated: 0, reason: 'missing_subject_id' });
  }

  let payload = {};
  let usedSources = [];
  const blockSourceResult = await fetchPayloadFromBlockSources(tx, {
    processId: request.PROCESS_ID,
    subjectId
  });

  if (Object.keys(blockSourceResult.payload || {}).length > 0) {
    payload = blockSourceResult.payload;
    usedSources = blockSourceResult.usedSources || [];
  } else if (isCustomerSubjectField(subjectFieldCode)) {
    payload = await fetchCustomerPayloadBySubject({ subjectId, subjectFieldCode });
  } else {
    payload = {};
  }

  if (usedSources.length) {
    console.log('[PREFILL_BLOCK_SOURCE_USED]', {
      requestId,
      processId: request.PROCESS_ID,
      sources: usedSources
    });
  }

  const mappedFields = await readRequestPrefillFields(tx, request.PROCESS_ID);

  // FIELD_CODE convention: SAP_TABLE.SAP_FIELD
  const valuesByFieldCode = new Map();
  const upsertCandidates = [];
  const seenCanonicalInRun = new Set();

  for (const field of mappedFields) {
    const rawValue = pickPayloadValue(payload, field.SAP_FIELD);
    const value = toPersistedValue(rawValue);
    if (value === null || value === '') continue;

    const canonicalCode = canonicalFieldCode(field.SAP_TABLE, field.SAP_FIELD);
    if (!canonicalCode) continue;
    if (seenCanonicalInRun.has(canonicalCode)) continue;
    seenCanonicalInRun.add(canonicalCode);

    const fieldControl = await getEffectiveFieldControl(tx, {
      processRoleId: editor.PROCESS_ROLE_ID,
      countryCode: request.COUNTRY_CODE,
      fieldId: field.FIELD_ID
    });
    if ([FIELD_CONTROL.READ_ONLY, FIELD_CONTROL.HIDDEN].includes(fieldControl)) continue;

    const fieldCode = String(field.FIELD_CODE || '').trim() || `${field.SAP_TABLE}.${field.SAP_FIELD}`;
    valuesByFieldCode.set(fieldCode, value);
    upsertCandidates.push({ fieldId: field.FIELD_ID, value, fieldCode, canonicalCode });
  }

  if (!valuesByFieldCode.size) {
    return JSON.stringify({ ok: true, updated: 0 });
  }

  const dedupByFieldId = new Map();
  for (const candidate of upsertCandidates) {
    if (!dedupByFieldId.has(candidate.fieldId)) dedupByFieldId.set(candidate.fieldId, candidate);
  }
  const finalCandidates = [...dedupByFieldId.values()];

  const existingRows = await tx.run(
    `SELECT rv."ID", rv."FIELD_ID", rv."VALUE", fc."FIELD_CODE", fc."SAP_TABLE", fc."SAP_FIELD"
       FROM "MDG_REQUEST_FIELD_VALUE"
       AS rv
       JOIN "MDG_FIELD_CATALOG" AS fc
         ON fc."ID" = rv."FIELD_ID"
      WHERE "REQUEST_ID" = ?
        AND rv."LINE_NO" = 1`,
    [requestId]
  );
  const existingByFieldId = new Map(existingRows.map((r) => [r.FIELD_ID, r]));
  const existingCanonical = new Set();
  for (const row of existingRows) {
    const canonicalByTableField = canonicalFieldCode(row.SAP_TABLE, row.SAP_FIELD);
    if (canonicalByTableField) existingCanonical.add(canonicalByTableField);
    const canonicalByFieldCode = String(row.FIELD_CODE || '').trim().toUpperCase();
    if (canonicalByFieldCode) existingCanonical.add(canonicalByFieldCode);
  }

  let updated = 0;
  for (const candidate of finalCandidates) {
    if (existingCanonical.has(candidate.canonicalCode)) {
      continue;
    }
    const candidateFieldCode = String(candidate.fieldCode || '').trim().toUpperCase();
    if (candidateFieldCode && existingCanonical.has(candidateFieldCode)) {
      continue;
    }
    const current = existingByFieldId.get(candidate.fieldId);
    if (current) {
      // Prefill is write-once: do not overwrite/log again on later updates.
      continue;
    }

    await tx.run(
      `INSERT INTO "MDG_REQUEST_FIELD_VALUE"
       ("ID", "REQUEST_ID", "FIELD_ID", "LINE_NO", "VALUE", "MODIFIEDAT", "MODIFIEDBY")
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), requestId, candidate.fieldId, 1, candidate.value, now(), userId]
    );
    await insertRequestFieldChangeLog(tx, {
      requestId,
      fieldId: candidate.fieldId,
      fieldCode: candidate.fieldCode || `FIELD_ID:${candidate.fieldId}`,
      lineNo: 1,
      oldValue: null,
      newValue: candidate.value,
      changeType: 'CREATE',
      changedBy: userId,
      changedRole: editor.ROLE_CODE,
      source: 'PREFILL_CUSTOMER'
    });
    existingCanonical.add(candidate.canonicalCode);
    if (candidateFieldCode) existingCanonical.add(candidateFieldCode);
    updated += 1;
  }

  return JSON.stringify({ ok: true, updated });
}

module.exports = {
  prefillCustomer,
  fetchCustomerPayloadBySubject,
  isCustomerSubjectField
};
