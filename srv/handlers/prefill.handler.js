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

async function fetchCustomerPayload(subjectId) {
  return fetchCustomerPayloadBySubject({ subjectId, subjectFieldCode: 'KNA1.KUNNR' });
}

function resolveSubjectStrategy(subjectFieldCode) {
  const normalized = typeof subjectFieldCode === 'string' ? subjectFieldCode.trim() : '';
  if (normalized === 'BUT000.PARTNER') {
    return { type: 'PARTNER', genKeyCandidates: ['Partner', 'BusinessPartner'] };
  }
  if (/\.KUNNR$/i.test(normalized)) {
    return { type: 'KUNNR', genKeyCandidates: ['Kunnr'] };
  }
  return null;
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
  if (!subjectId) req.reject(400, 'subjectId is required');
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

  const payload = await fetchCustomerPayloadBySubject({ subjectId, subjectFieldCode });
  const mappedFields = await readRequestPrefillFields(tx, request.PROCESS_ID);

  // FIELD_CODE convention: SAP_TABLE.SAP_FIELD
  const valuesByFieldCode = new Map();
  const upsertCandidates = [];

  for (const field of mappedFields) {
    const rawValue = pickPayloadValue(payload, field.SAP_FIELD);
    const value = toPersistedValue(rawValue);
    if (value === null || value === '') continue;

    const fieldControl = await getEffectiveFieldControl(tx, {
      processRoleId: editor.PROCESS_ROLE_ID,
      countryCode: request.COUNTRY_CODE,
      fieldId: field.FIELD_ID
    });
    if ([FIELD_CONTROL.READ_ONLY, FIELD_CONTROL.HIDDEN].includes(fieldControl)) continue;

    const fieldCode = `${field.SAP_TABLE}.${field.SAP_FIELD}`;
    valuesByFieldCode.set(fieldCode, value);
    upsertCandidates.push({ fieldId: field.FIELD_ID, value });
  }

  if (!valuesByFieldCode.size) {
    return JSON.stringify({ ok: true, updated: 0 });
  }

  const dedupByFieldId = new Map();
  for (const candidate of upsertCandidates) {
    if (!dedupByFieldId.has(candidate.fieldId)) dedupByFieldId.set(candidate.fieldId, candidate);
  }
  const finalCandidates = [...dedupByFieldId.values()];

  const fieldIds = finalCandidates.map((x) => x.fieldId);
  const inClause = fieldIds.map(() => '?').join(',');
  const existingRows = await tx.run(
    `SELECT "ID", "FIELD_ID"
       FROM "MDG_REQUEST_FIELD_VALUE"
      WHERE "REQUEST_ID" = ?
        AND "FIELD_ID" IN (${inClause})`,
    [requestId, ...fieldIds]
  );
  const existingByFieldId = new Map(existingRows.map((r) => [r.FIELD_ID, r]));

  let updated = 0;
  for (const candidate of finalCandidates) {
    const current = existingByFieldId.get(candidate.fieldId);
    if (current) {
      await tx.run(
        `UPDATE "MDG_REQUEST_FIELD_VALUE"
            SET "VALUE" = ?,
                "MODIFIEDAT" = ?,
                "MODIFIEDBY" = ?
          WHERE "ID" = ?`,
        [candidate.value, now(), userId, current.ID]
      );
      updated += 1;
      continue;
    }

    await tx.run(
      `INSERT INTO "MDG_REQUEST_FIELD_VALUE"
       ("ID", "REQUEST_ID", "FIELD_ID", "LINE_NO", "VALUE", "MODIFIEDAT", "MODIFIEDBY")
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), requestId, candidate.fieldId, 1, candidate.value, now(), userId]
    );
    updated += 1;
  }

  return JSON.stringify({ ok: true, updated });
}

module.exports = { prefillCustomer };
