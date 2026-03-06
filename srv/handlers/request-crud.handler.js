const cds = require('@sap/cds');
const { s4Get } = require('./_lib/s4.client');
const {
  FIELD_CONTROL,
  ROLE_CODES,
  STATUS,
  currentUserId,
  getEffectiveFieldControl,
  getRequestById,
  getRequestValueById,
  getUserRoleAssignments,
  insertActionLog,
  normalizeStatus,
  now,
  resolveEditorRoleFromStatus,
  upsertApprovalTaskOnSubmit,
  uuid,
  validateMandatoryFieldsOnSubmit
} = require('./_lib/mdg-workflow.util');
const {
  SYSTEM_FIELD_ID,
  areValuesEqual,
  insertRequestFieldChangeLog
} = require('./_lib/request-change-log.util');

function getEntityId(req) {
  return req.data?.ID || req.params?.[0]?.ID;
}

function escapeODataString(value) {
  return String(value).replace(/'/g, "''");
}

async function getFieldCodeById(tx, fieldId) {
  if (!fieldId) return null;
  const rows = await tx.run(
    `SELECT "FIELD_CODE"
       FROM "MDG_FIELD_CATALOG"
      WHERE "ID" = ?`,
    [fieldId]
  );
  return rows?.[0]?.FIELD_CODE || null;
}

async function getRequestValueDetailById(tx, valueId) {
  const rows = await tx.run(
    `SELECT "ID", "REQUEST_ID", "FIELD_ID", "LINE_NO", "VALUE"
       FROM "MDG_REQUEST_FIELD_VALUE"
      WHERE "ID" = ?`,
    [valueId]
  );
  return rows?.[0] || null;
}

function isCustomerKunnrField(fieldCode) {
  return typeof fieldCode === 'string' && /\.KUNNR$/i.test(fieldCode.trim());
}

async function resolveCustomerNameByKunnr(kunnr) {
  if (!kunnr) return null;
  const escaped = escapeODataString(kunnr);
  const rows = await s4Get({
    servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS',
    entitySet: 'zcds_clientes_gen',
    query: { $filter: `Kunnr eq '${escaped}'`, $top: 1 }
  });
  const name = rows?.[0]?.Name1;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

async function syncRequestSubjectFromRequestValue(tx, { requestId, fieldId, rawValue, userId }) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue || '').trim();
  if (!requestId || !fieldId || !value) return;

  const fieldCode = await getFieldCodeById(tx, fieldId);
  if (!isCustomerKunnrField(fieldCode)) return;

  const requestRows = await tx.run(
    `SELECT "SUBJECT_NAME"
       FROM "MDG_REQUEST_HEADER"
      WHERE "ID" = ?`,
    [requestId]
  );
  const currentSubjectName = requestRows?.[0]?.SUBJECT_NAME ?? null;

  let resolvedSubjectName = null;
  try {
    resolvedSubjectName = await resolveCustomerNameByKunnr(value);
  } catch (err) {
    console.warn(`[MDG_SUBJECT_SYNC] customer lookup failed for KUNNR=${value}: ${err?.message || err}`);
  }

  await tx.run(
    `UPDATE "MDG_REQUEST_HEADER"
        SET "SUBJECT_ID" = ?,
            "SUBJECT_TYPE" = 'CUSTOMER',
            "SUBJECT_NAME" = ?,
            "MODIFIEDAT" = ?,
            "MODIFIEDBY" = ?
      WHERE "ID" = ?`,
    [value, resolvedSubjectName || currentSubjectName, now(), userId, requestId]
  );
}

function toLocalIsoDate(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isDateLikeDataType(dataType) {
  const dt = String(dataType || '').trim().toUpperCase();
  return dt.includes('DATE') || dt.includes('TIME');
}

function resolveDefaultValue(defaultBase, dataType) {
  if (defaultBase === null || defaultBase === undefined) return null;
  const raw = String(defaultBase);
  const token = raw.trim().toUpperCase();
  if (!isDateLikeDataType(dataType)) return raw;
  if (token === '$NOW_DATE' || token === 'TODAY' || token === 'NOW' || token === '$NOW') {
    return toLocalIsoDate();
  }
  return raw;
}

function parseBooleanLike(value) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined) return false;
  const v = String(value).trim().toLowerCase();
  if (!v) return false;
  return v === 'true' || v === 'x' || v === '1' || v === 'y' || v === 'yes' || v === 'si' || v === 'sí';
}

async function getRequesterRoleId(tx, processId) {
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

function isNonEmpty(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function normalizeRequestValueInput(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function normalizeSapField(value) {
  return String(value || '').trim().toUpperCase();
}

function isAddressSapField(sapField) {
  const norm = normalizeSapField(sapField);
  return new Set([
    'STREET',
    'HOUSE_NUM1',
    'CITY1',
    'CITY2',
    'POST_CODE1',
    'REGION',
    'COUNTRY',
    'TIME_ZONE',
    'LZONE',
    'LANGU_CORR'
  ]).has(norm);
}

async function getRequesterDefaultByFieldIds(tx, { processId, countryCode, fieldIds }) {
  const ids = Array.from(new Set((fieldIds || []).map((x) => String(x || '').trim()).filter(Boolean)));
  if (!processId || !ids.length) return new Map();
  const requesterRoleId = await getRequesterRoleId(tx, processId);
  if (!requesterRoleId) return new Map();
  const inClause = ids.map(() => '?').join(',');
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
    [requesterRoleId, requesterRoleId, countryCode, ...ids]
  );
  const out = new Map();
  for (const row of rows || []) {
    const value = String(row.DEFAULT_VALUE || '').trim();
    if (value) out.set(String(row.FIELD_ID), value);
  }
  return out;
}

async function syncDestMercEmbeddedFromKna1(tx, { requestId, userId }) {
  const reqRows = await tx.run(
    `SELECT r."PROCESS_ID" AS "PROCESS_ID", r."COUNTRY_CODE" AS "COUNTRY_CODE", p."PROCESS_CODE" AS "PROCESS_CODE"
       FROM "MDG_REQUEST_HEADER" r
       JOIN "MDG_PROCESS" p ON p."ID" = r."PROCESS_ID"
      WHERE r."ID" = ?`,
    [requestId]
  );
  const request = reqRows?.[0];
  if (!request || String(request.PROCESS_CODE || '').trim().toUpperCase() !== 'CUSTOMER_CREATION') return 0;
  const requesterRoleId = await getRequesterRoleId(tx, request.PROCESS_ID);
  if (!requesterRoleId) return 0;

  // Mirror only read-only destination fields without fixed default in CUST_DESTMERC_GEN.
  const destRows = await tx.run(
    `SELECT DISTINCT
        fc."ID" AS "FIELD_ID",
        fc."FIELD_CODE" AS "FIELD_CODE",
        fc."SAP_FIELD" AS "SAP_FIELD",
        COALESCE(fcc."FIELD_CONTROL_OVERRIDE", fcb."FIELD_CONTROL_BASE", ${FIELD_CONTROL.DEFAULT}) AS "EFFECTIVE_CONTROL",
        COALESCE(NULLIF(TRIM(fcc."DEFAULT_OVERRIDE"), ''), NULLIF(TRIM(fcb."DEFAULT_BASE"), '')) AS "EFFECTIVE_DEFAULT"
       FROM "MDG_PROCESS_BLOCK" pb
       JOIN "MDG_OBJECT_BLOCK" ob
         ON ob."ID" = pb."BLOCK_ID"
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
        AND ob."BLOCK_CODE" = 'CUST_DESTMERC_GEN'
        AND fc."FIELD_CODE" LIKE 'BUT000-KNA1.%'
        AND fc."SAP_FIELD" IS NOT NULL
        AND LENGTH(TRIM(fc."SAP_FIELD")) > 0`,
    [requesterRoleId, requesterRoleId, request.COUNTRY_CODE, request.PROCESS_ID]
  );
  const destFields = (destRows || [])
    .map((r) => ({
      fieldId: String(r.FIELD_ID || '').trim(),
      fieldCode: String(r.FIELD_CODE || '').trim(),
      sapField: String(r.SAP_FIELD || '').trim(),
      control: Number(r.EFFECTIVE_CONTROL),
      defaultValue: String(r.EFFECTIVE_DEFAULT || '').trim()
    }))
    .filter((r) => r.fieldId && r.fieldCode && r.sapField)
    .filter((r) => r.control === FIELD_CONTROL.READ_ONLY)
    .filter((r) => !r.defaultValue);
  if (!destFields.length) return 0;

  const sourceRows = await tx.run(
    `SELECT c."SAP_FIELD" AS "SAP_FIELD", v."VALUE" AS "VALUE", c."FIELD_CODE" AS "FIELD_CODE"
       FROM "MDG_PROCESS_BLOCK" pb
       JOIN "MDG_OBJECT_BLOCK" ob ON ob."ID" = pb."BLOCK_ID"
       JOIN "MDG_BLOCK_FIELD" bf ON bf."BLOCK_ID" = pb."BLOCK_ID"
       JOIN "MDG_FIELD_CATALOG" c ON c."ID" = bf."FIELD_ID"
       JOIN "MDG_REQUEST_FIELD_VALUE" v
         ON v."FIELD_ID" = c."ID"
        AND v."REQUEST_ID" = ?
        AND v."LINE_NO" = 1
      WHERE pb."PROCESS_ID" = ?
        AND ob."BLOCK_CODE" IN ('CUST_GEN', 'CUST_ADDR')
        AND c."FIELD_CODE" LIKE 'KNA1.%'
        AND c."SAP_FIELD" IS NOT NULL
        AND LENGTH(TRIM(c."SAP_FIELD")) > 0`,
    [requestId, request.PROCESS_ID]
  );
  const sourceByFieldCode = new Map();
  const sourceBySapField = new Map();
  for (const row of sourceRows || []) {
    const key = normalizeSapField(row.SAP_FIELD);
    const fieldCode = String(row.FIELD_CODE || '').trim().toUpperCase();
    const value = String(row.VALUE || '').trim();
    if (!value) continue;
    if (fieldCode && !sourceByFieldCode.has(fieldCode)) sourceByFieldCode.set(fieldCode, value);
    if (key && !sourceBySapField.has(key)) sourceBySapField.set(key, value);
  }

  const fieldIds = destFields.map((d) => d.fieldId);
  const inClause = fieldIds.map(() => '?').join(',');
  const existingRows = await tx.run(
    `SELECT "ID", "FIELD_ID", "LINE_NO", "VALUE"
       FROM "MDG_REQUEST_FIELD_VALUE"
      WHERE "REQUEST_ID" = ?
        AND "LINE_NO" = 1
        AND "FIELD_ID" IN (${inClause})`,
    [requestId, ...fieldIds]
  );
  const existingByFieldId = new Map((existingRows || []).map((r) => [String(r.FIELD_ID), r]));

  // Dedup by destination logical field to avoid duplicated catalog mappings.
  const dedup = new Map();
  for (const row of destFields) {
    const key = `${row.fieldCode.toUpperCase()}|${normalizeSapField(row.sapField)}`;
    if (!dedup.has(key)) dedup.set(key, row);
  }

  let changed = 0;
  const ts = now();
  for (const dest of dedup.values()) {
    const current = existingByFieldId.get(dest.fieldId);
    const currentValue = String(current?.VALUE || '').trim();
    if (currentValue) continue; // destination explicit value always wins

    const suffix = dest.fieldCode.toUpperCase().startsWith('BUT000-KNA1.')
      ? dest.fieldCode.slice('BUT000-KNA1.'.length)
      : null;
    const sourceFieldCode = suffix ? `KNA1.${suffix}` : null;
    const sapFieldNorm = normalizeSapField(dest.sapField);
    const nextValue = (sourceFieldCode && sourceByFieldCode.get(sourceFieldCode))
      || sourceBySapField.get(sapFieldNorm)
      || null;

    if (!isNonEmpty(nextValue)) continue;
    if (areValuesEqual(current?.VALUE ?? null, nextValue)) continue;

    if (current?.ID) {
      await tx.run(
        `UPDATE "MDG_REQUEST_FIELD_VALUE"
            SET "VALUE" = ?, "MODIFIEDAT" = ?, "MODIFIEDBY" = ?
          WHERE "ID" = ?`,
        [nextValue, ts, userId, current.ID]
      );
    } else {
      await tx.run(
        `INSERT INTO "MDG_REQUEST_FIELD_VALUE"
         ("ID", "REQUEST_ID", "FIELD_ID", "LINE_NO", "VALUE", "MODIFIEDAT", "MODIFIEDBY")
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), requestId, dest.fieldId, 1, nextValue, ts, userId]
      );
    }

    await insertRequestFieldChangeLog(tx, {
      requestId,
      fieldId: dest.fieldId,
      fieldCode: dest.fieldCode || `FIELD_ID:${dest.fieldId}`,
      lineNo: 1,
      oldValue: current?.VALUE ?? null,
      newValue: nextValue,
      changeType: current?.ID ? 'UPDATE' : 'CREATE',
      changedBy: userId,
      changedRole: ROLE_CODES.REQUESTER,
      source: 'PREFILL_CUSTOMER'
    });
    changed += 1;
  }
  return changed;
}

async function syncDestFactReadonlyFromKna1(tx, { requestId, userId }) {
  const reqRows = await tx.run(
    `SELECT r."PROCESS_ID" AS "PROCESS_ID", r."COUNTRY_CODE" AS "COUNTRY_CODE", p."PROCESS_CODE" AS "PROCESS_CODE"
       FROM "MDG_REQUEST_HEADER" r
       JOIN "MDG_PROCESS" p ON p."ID" = r."PROCESS_ID"
      WHERE r."ID" = ?`,
    [requestId]
  );
  const request = reqRows?.[0];
  if (!request || String(request.PROCESS_CODE || '').trim().toUpperCase() !== 'CUSTOMER_CREATION') return 0;

  const ctrlRows = await tx.run(
    `SELECT v."VALUE" AS "VALUE"
       FROM "MDG_REQUEST_FIELD_VALUE" v
       JOIN "MDG_FIELD_CATALOG" c ON c."ID" = v."FIELD_ID"
      WHERE v."REQUEST_ID" = ?
        AND c."FIELD_CODE" = 'MDG_CTRL.CREATE_DESTFACT'
      ORDER BY v."LINE_NO", v."ID"
      LIMIT 1`,
    [requestId]
  );
  const createDestFact = parseBooleanLike(ctrlRows?.[0]?.VALUE);
  if (!createDestFact) return 0;

  const requesterRoleId = await getRequesterRoleId(tx, request.PROCESS_ID);
  if (!requesterRoleId) return 0;

  const destRows = await tx.run(
    `SELECT
        d."ID" AS "FIELD_ID",
        d."FIELD_CODE" AS "FIELD_CODE",
        d."SAP_FIELD" AS "SAP_FIELD",
        COALESCE(fcc."FIELD_CONTROL_OVERRIDE", fcb."FIELD_CONTROL_BASE", ${FIELD_CONTROL.DEFAULT}) AS "EFFECTIVE_CONTROL"
       FROM "MDG_PROCESS_BLOCK" pb
       JOIN "MDG_BLOCK_FIELD" bf
         ON bf."BLOCK_ID" = pb."BLOCK_ID"
       JOIN "MDG_FIELD_CATALOG" d
         ON d."ID" = bf."FIELD_ID"
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_BASE" fcb
         ON fcb."PROCESS_ROLE_ID" = ?
        AND fcb."FIELD_ID" = d."ID"
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_COUNTRY" fcc
         ON fcc."PROCESS_ROLE_ID" = ?
        AND fcc."FIELD_ID" = d."ID"
        AND fcc."COUNTRY_CODE" = ?
      WHERE pb."PROCESS_ID" = ?
        AND d."FIELD_CODE" LIKE 'BUT000-KNA1.%'
        AND d."SAP_FIELD" IS NOT NULL
        AND LENGTH(TRIM(d."SAP_FIELD")) > 0`,
    [requesterRoleId, requesterRoleId, request.COUNTRY_CODE, request.PROCESS_ID]
  );
  const readonlyDest = (destRows || [])
    .filter((r) => Number(r.EFFECTIVE_CONTROL) === FIELD_CONTROL.READ_ONLY)
    .map((r) => ({
      fieldId: r.FIELD_ID,
      fieldCode: String(r.FIELD_CODE || '').trim(),
      sapField: String(r.SAP_FIELD || '').trim()
    }))
    .filter((r) => r.fieldId && r.sapField)
    .filter((r) => r.fieldCode !== 'BUT000-KNA1.KTOKD');
  const readonlyDedup = new Map();
  for (const row of readonlyDest) {
    const key = String(row.fieldCode || '').trim().toUpperCase();
    if (!key) continue;
    if (!readonlyDedup.has(key)) readonlyDedup.set(key, row);
  }
  const readonlyDestScoped = [...readonlyDedup.values()];
  if (!readonlyDestScoped.length) return 0;

  const values = await tx.run(
    `SELECT
        c."ID" AS "FIELD_ID",
        c."FIELD_CODE" AS "FIELD_CODE",
        c."SAP_FIELD" AS "SAP_FIELD",
        v."ID" AS "VALUE_ID",
        v."LINE_NO" AS "LINE_NO",
        v."VALUE" AS "VALUE"
       FROM "MDG_PROCESS_BLOCK" pb
       JOIN "MDG_BLOCK_FIELD" bf
         ON bf."BLOCK_ID" = pb."BLOCK_ID"
       JOIN "MDG_FIELD_CATALOG" c
         ON c."ID" = bf."FIELD_ID"
       LEFT JOIN "MDG_REQUEST_FIELD_VALUE" v
         ON v."FIELD_ID" = c."ID"
        AND v."REQUEST_ID" = ?
      WHERE pb."PROCESS_ID" = ?
        AND (c."FIELD_CODE" LIKE 'KNA1.%'
         OR c."FIELD_CODE" LIKE 'BUT000-KNA1.%')
      ORDER BY
        c."FIELD_CODE",
        CASE WHEN v."LINE_NO" = 1 THEN 0 ELSE 1 END,
        v."LINE_NO",
        v."ID"`,
    [requestId, request.PROCESS_ID]
  );

  const sourceBySapField = new Map();
  const destValueByFieldId = new Map();

  for (const row of values || []) {
    const fieldCode = String(row.FIELD_CODE || '').trim();
    const sapField = String(row.SAP_FIELD || '').trim();
    const value = row.VALUE;
    if (!sapField) continue;

    if (fieldCode.startsWith('KNA1.') && isNonEmpty(value) && !sourceBySapField.has(sapField)) {
      sourceBySapField.set(sapField, String(value));
    }
    if (fieldCode.startsWith('BUT000-KNA1.') && !destValueByFieldId.has(row.FIELD_ID)) {
      destValueByFieldId.set(row.FIELD_ID, {
        valueId: row.VALUE_ID || null,
        lineNo: Number(row.LINE_NO || 1),
        value: isNonEmpty(value) ? String(value) : ''
      });
    }
  }

  let changed = 0;
  const ts = now();
  for (const dest of readonlyDestScoped) {
    const sourceValue = sourceBySapField.get(dest.sapField);
    if (!isNonEmpty(sourceValue)) continue;

    const currentDest = destValueByFieldId.get(dest.fieldId);
    if (currentDest && isNonEmpty(currentDest.value)) continue;

    if (currentDest?.valueId) {
      await tx.run(
        `UPDATE "MDG_REQUEST_FIELD_VALUE"
            SET "VALUE" = ?, "MODIFIEDAT" = ?, "MODIFIEDBY" = ?
          WHERE "ID" = ?`,
        [sourceValue, ts, userId, currentDest.valueId]
      );
    } else {
      await tx.run(
        `INSERT INTO "MDG_REQUEST_FIELD_VALUE"
         ("ID", "REQUEST_ID", "FIELD_ID", "LINE_NO", "VALUE", "MODIFIEDAT", "MODIFIEDBY")
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), requestId, dest.fieldId, 1, sourceValue, ts, userId]
      );
    }

    await insertRequestFieldChangeLog(tx, {
      requestId,
      fieldId: dest.fieldId,
      fieldCode: dest.fieldCode,
      lineNo: currentDest?.lineNo || 1,
      oldValue: currentDest?.value || null,
      newValue: sourceValue,
      changeType: currentDest?.valueId ? 'UPDATE' : 'CREATE',
      changedBy: userId,
      changedRole: ROLE_CODES.REQUESTER,
      source: 'PREFILL_CUSTOMER'
    });
    changed += 1;
  }
  return changed;
}

async function applyDefaultsToRequest(tx, requestId, processId, countryCode, processRoleId, userId = 'system') {
  if (!requestId || !processId || !processRoleId) return 0;

  const scopedDefaults = await tx.run(
    `SELECT DISTINCT
        fc."ID"          AS "FIELD_ID",
        fc."DATA_TYPE"   AS "DATA_TYPE",
        fcb."DEFAULT_BASE" AS "DEFAULT_BASE"
       FROM "MDG_PROCESS_BLOCK" pb
       JOIN "MDG_BLOCK_FIELD" bf
         ON bf."BLOCK_ID" = pb."BLOCK_ID"
       JOIN "MDG_FIELD_CATALOG" fc
         ON fc."ID" = bf."FIELD_ID"
       JOIN "MDG_FIELD_CONTROL_RULE_BASE" fcb
         ON fcb."FIELD_ID" = fc."ID"
        AND fcb."PROCESS_ROLE_ID" = ?
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_COUNTRY" fcc
         ON fcc."PROCESS_ROLE_ID" = fcb."PROCESS_ROLE_ID"
        AND fcc."FIELD_ID" = fcb."FIELD_ID"
        AND fcc."COUNTRY_CODE" = ?
      WHERE pb."PROCESS_ID" = ?
        AND fcb."DEFAULT_BASE" IS NOT NULL
        AND LENGTH(TRIM(fcb."DEFAULT_BASE")) > 0
        AND COALESCE(fcc."FIELD_CONTROL_OVERRIDE", fcb."FIELD_CONTROL_BASE", ${FIELD_CONTROL.DEFAULT}) = ${FIELD_CONTROL.READ_ONLY}`,
    [processRoleId, countryCode, processId]
  );

  if (!scopedDefaults.length) {
    console.log(`[MDG_DEFAULTS] request=${requestId} process=${processId} country=${countryCode} inserted=0`);
    return 0;
  }

  const fieldIds = scopedDefaults.map((row) => row.FIELD_ID);
  const inClause = fieldIds.map(() => '?').join(',');
  const existingRows = await tx.run(
    `SELECT "FIELD_ID"
       FROM "MDG_REQUEST_FIELD_VALUE"
      WHERE "REQUEST_ID" = ?
        AND "FIELD_ID" IN (${inClause})`,
    [requestId, ...fieldIds]
  );
  const existingFieldIds = new Set(existingRows.map((row) => row.FIELD_ID));

  let inserted = 0;
  const ts = now();
  for (const row of scopedDefaults) {
    if (existingFieldIds.has(row.FIELD_ID)) continue;

    const resolved = resolveDefaultValue(row.DEFAULT_BASE, row.DATA_TYPE);
    if (resolved === null || resolved === '') continue;

    await tx.run(
      `INSERT INTO "MDG_REQUEST_FIELD_VALUE"
       ("ID", "REQUEST_ID", "FIELD_ID", "LINE_NO", "VALUE", "MODIFIEDAT", "MODIFIEDBY")
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), requestId, row.FIELD_ID, 1, resolved, ts, userId]
    );
    inserted += 1;
  }

  console.log(`[MDG_DEFAULTS] request=${requestId} process=${processId} country=${countryCode} inserted=${inserted}`);
  return inserted;
}

async function beforeCreateRequest(req) {
  const tx = cds.tx(req);
  const userId = currentUserId(req);
  console.log("=== MDG DEBUG CREATE Requests ===");
  console.log("req.user?.id =", req.user?.id);
  console.log("has Authorization header =", !!req.headers?.authorization);
  console.log("PROCESS_ID =", req.data?.PROCESS_ID, "COUNTRY_CODE =", req.data?.COUNTRY_CODE);
  try {
    const { resolveGroups } = require("./auth.handler");
    const dbg = await resolveGroups(req);
    console.log("resolvedGroups.length =", dbg?.resolvedGroups?.length);
    console.log("resolvedGroups.sample =", (dbg?.resolvedGroups || []).slice(0, 30));
  } catch (e) {
    console.log("resolveGroups error:", e?.message);
  }
  console.log("=== END MDG DEBUG ===");
  if (!req.data.PROCESS_ID || !req.data.COUNTRY_CODE) {
    req.reject(400, 'PROCESS_ID and COUNTRY_CODE are required');
  }

  let processCode = null;
  if (!req.data.MASTER_OBJECT_ID) {
    const processRows = await tx.run(
      `SELECT "MASTER_OBJECT_ID", "PROCESS_CODE"
         FROM "MDG_PROCESS"
        WHERE "ID" = ?`,
      [req.data.PROCESS_ID]
    );
    const masterObjectId = processRows?.[0]?.MASTER_OBJECT_ID;
    processCode = processRows?.[0]?.PROCESS_CODE || null;
    if (masterObjectId) {
      req.data.MASTER_OBJECT_ID = masterObjectId;
    } else {
      req.reject(400, 'MASTER_OBJECT_ID is required (process has no MASTER_OBJECT_ID)');
    }
  } else {
    const processRows = await tx.run(
      `SELECT "PROCESS_CODE"
         FROM "MDG_PROCESS"
        WHERE "ID" = ?`,
      [req.data.PROCESS_ID]
    );
    processCode = processRows?.[0]?.PROCESS_CODE || null;
  }

  const assignments = await getUserRoleAssignments(tx, req, {
    processId: req.data.PROCESS_ID,
    countryCode: req.data.COUNTRY_CODE
  });

  if (!assignments.some((a) => a.ROLE_CODE === ROLE_CODES.REQUESTER)) {
    req.reject(403, 'Only REQUESTER can create requests for this process/country');
  }
  req._requestAuditRoleCode = ROLE_CODES.REQUESTER;

  const incomingStatus = normalizeStatus(req.data.STATUS);
  if (incomingStatus && incomingStatus !== STATUS.DRAFT) {
    req.reject(400, `Invalid initial STATUS: ${incomingStatus}. Requests must start in DRAFT.`);
  }

  const requesterRoleRows = await tx.run(
    `SELECT "ID", "FRONT_CODE"
       FROM "MDG_PROCESS_ROLE"
      WHERE "PROCESS_ID" = ?
        AND "ROLE_CODE" = 'REQUESTER'
        AND "IS_ENABLED" = true
      ORDER BY "ID"`,
    [req.data.PROCESS_ID]
  );
  const requesterRole = requesterRoleRows?.[0] || null;
  req.data.FRONT_CODE = requesterRole?.FRONT_CODE ?? null;
  req._defaultsContext = {
    processCode,
    processRoleId: requesterRole?.ID || null
  };

  const ts = now();
  req.data.ID = req.data.ID || uuid();
  req.data.STATUS = STATUS.DRAFT;
  if (req.data.ISDELETED === undefined || req.data.ISDELETED === null) {
    req.data.ISDELETED = false;
  }

  req.data.CREATEDAT = req.data.CREATEDAT || ts;
  req.data.CREATEDBY = req.data.CREATEDBY || userId;
  req.data.MODIFIEDAT = ts;
  req.data.MODIFIEDBY = userId;
}

async function afterCreateRequest(_, req) {
  const tx = cds.tx(req);
  const userId = currentUserId(req);

  const requestId = req.data?.ID;
  const processId = req.data?.PROCESS_ID;
  const countryCode = req.data?.COUNTRY_CODE;
  const status = normalizeStatus(req.data?.STATUS);
  const processRoleId = req._defaultsContext?.processRoleId || null;

  await insertRequestFieldChangeLog(tx, {
    requestId,
    fieldId: SYSTEM_FIELD_ID,
    fieldCode: 'MDG_REQUEST_HEADER.CREATE',
    oldValue: null,
    newValue: null,
    changeType: 'CREATE',
    changedBy: userId,
    changedRole: req._requestAuditRoleCode || ROLE_CODES.REQUESTER,
    source: 'REQUEST_CREATE'
  });

  if (!requestId || !processId || !countryCode || !processRoleId) return;
  if (status !== STATUS.DRAFT) return;

  await applyDefaultsToRequest(tx, requestId, processId, countryCode, processRoleId, userId);
}

async function beforeUpdateRequest(req) {
  const tx = cds.tx(req);
  const userId = currentUserId(req);
  const requestId = getEntityId(req);

  if (!requestId) req.reject(400, 'Missing request ID');

  const current = await getRequestById(tx, requestId);
  if (!current) req.reject(404, `Request not found: ${requestId}`);
  if (current.ISDELETED) req.reject(409, 'Request is deleted');

  const currentStatus = normalizeStatus(current.STATUS);
  const assignments = await getUserRoleAssignments(tx, req, {
    processId: current.PROCESS_ID,
    countryCode: current.COUNTRY_CODE
  });

  const editor = resolveEditorRoleFromStatus(assignments, currentStatus);
  if (!editor) {
    req.reject(403, `User cannot edit request in status ${currentStatus}`);
  }

  req._requestBefore = current;
  req._requestAuditRoleCode = editor.ROLE_CODE;

  const incomingStatus = req.data.STATUS === undefined ? undefined : normalizeStatus(req.data.STATUS);
  let isSubmitTransition = false;

  if (incomingStatus !== undefined && incomingStatus !== currentStatus) {
    const isValidSubmit = [STATUS.DRAFT, STATUS.REWORK].includes(currentStatus) && incomingStatus === STATUS.SUBMITTED;
    if (!isValidSubmit) {
      req.reject(400, `Invalid status transition: ${currentStatus} -> ${incomingStatus}`);
    }

    // Ensure read-only defaults are materialized before mandatory validation/submit.
    await applyDefaultsToRequest(
      tx,
      requestId,
      current.PROCESS_ID,
      current.COUNTRY_CODE,
      editor.PROCESS_ROLE_ID,
      userId
    );

    await validateMandatoryFieldsOnSubmit(tx, {
      requestId,
      processId: current.PROCESS_ID,
      processRoleId: editor.PROCESS_ROLE_ID,
      countryCode: current.COUNTRY_CODE
    });

    req.data.STATUS = STATUS.IN_REVIEW;
    isSubmitTransition = true;
  } else if (incomingStatus !== undefined) {
    req.data.STATUS = incomingStatus;
  }

  req.data.MODIFIEDAT = now();
  req.data.MODIFIEDBY = userId;

  if (isSubmitTransition) {
    req._submitTransition = {
      requestId,
      processId: current.PROCESS_ID,
      actorUser: userId,
      actorRole: editor.ROLE_CODE
    };
  }
}

async function afterUpdateRequest(_, req) {
  const tx = cds.tx(req);
  const userId = currentUserId(req);
  const requestId = getEntityId(req);
  const before = req._requestBefore;
  const roleCode = req._requestAuditRoleCode || null;

  if (requestId && before) {
    const candidates = ['PROCESS_ID', 'FRONT_CODE', 'MASTER_OBJECT_ID', 'COUNTRY_CODE', 'SUBJECT_TYPE', 'SUBJECT_ID', 'SUBJECT_NAME', 'STATUS', 'ISDELETED'];
    for (const key of candidates) {
      if (req.data?.[key] === undefined) continue;
      const oldValue = before[key];
      const newValue = req.data[key];
      if (areValuesEqual(oldValue, newValue)) continue;
      await insertRequestFieldChangeLog(tx, {
        requestId,
        fieldId: SYSTEM_FIELD_ID,
        fieldCode: `MDG_REQUEST_HEADER.${key}`,
        oldValue,
        newValue,
        changeType: 'UPDATE',
        changedBy: userId,
        changedRole: roleCode,
        source: 'REQUEST_UPDATE'
      });
    }
  }

  if (!req._submitTransition) return;

  const { requestId: submitRequestId, processId, actorUser, actorRole } = req._submitTransition;

  await insertActionLog(tx, {
    requestId: submitRequestId,
    action: 'SUBMIT',
    actorUser,
    actorRole,
    comment: null
  });

  await upsertApprovalTaskOnSubmit(tx, {
    requestId: submitRequestId,
    processId,
    actorUser
  });
}

async function onDeleteRequest(req) {
  const tx = cds.tx(req);
  const userId = currentUserId(req);
  const requestId = getEntityId(req);

  if (!requestId) req.reject(400, 'Missing request ID');

  const current = await getRequestById(tx, requestId);
  if (!current) req.reject(404, `Request not found: ${requestId}`);
  if (current.ISDELETED) return;

  const assignments = await getUserRoleAssignments(tx, req, {
    processId: current.PROCESS_ID,
    countryCode: current.COUNTRY_CODE
  });

  const editor = resolveEditorRoleFromStatus(assignments, normalizeStatus(current.STATUS));
  if (!editor) {
    req.reject(403, `User cannot delete request in status ${current.STATUS}`);
  }

  const ts = now();
  await tx.run(
    `UPDATE "MDG_REQUEST_HEADER"
        SET "ISDELETED" = true,
            "DELETEDAT" = ?,
            "DELETEDBY" = ?,
            "MODIFIEDAT" = ?,
            "MODIFIEDBY" = ?
      WHERE "ID" = ?`,
    [ts, userId, ts, userId, requestId]
  );

  await insertRequestFieldChangeLog(tx, {
    requestId,
    fieldId: SYSTEM_FIELD_ID,
    fieldCode: 'MDG_REQUEST_HEADER.ISDELETED',
    oldValue: false,
    newValue: true,
    changeType: 'DELETE',
    changedBy: userId,
    changedRole: editor.ROLE_CODE,
    source: 'REQUEST_DELETE'
  });
}

async function beforeUpsertRequestValue(req) {
  const tx = cds.tx(req);
  const userId = currentUserId(req);
  if (Object.prototype.hasOwnProperty.call(req.data || {}, 'VALUE')) {
    req.data.VALUE = normalizeRequestValueInput(req.data.VALUE);
  }
  const event = req.event;

  let requestId = req.data.REQUEST_ID;
  let fieldId = req.data.FIELD_ID;

  if (event === 'UPDATE') {
    const valueId = getEntityId(req);
    if (!valueId) req.reject(400, 'Missing RequestValue ID');

    const currentValue = await getRequestValueById(tx, valueId);
    if (!currentValue) req.reject(404, `RequestValue not found: ${valueId}`);
    const currentDetail = await getRequestValueDetailById(tx, valueId);

    requestId = requestId || currentValue.REQUEST_ID;
    fieldId = fieldId || currentValue.FIELD_ID;

    req.data.REQUEST_ID = requestId;
    req.data.FIELD_ID = fieldId;
    req._requestValueAudit = {
      requestId,
      fieldId,
      lineNo: currentDetail?.LINE_NO ?? req.data?.LINE_NO ?? 1,
      oldValue: currentDetail?.VALUE ?? null,
      changeType: 'UPDATE'
    };
  }

  if (!requestId || !fieldId) {
    req.reject(400, 'REQUEST_ID and FIELD_ID are required');
  }

  const request = await getRequestById(tx, requestId);
  if (!request) req.reject(404, `Request not found: ${requestId}`);
  if (request.ISDELETED) req.reject(409, 'Request is deleted');

  const status = normalizeStatus(request.STATUS);
  const assignments = await getUserRoleAssignments(tx, req, {
    processId: request.PROCESS_ID,
    countryCode: request.COUNTRY_CODE
  });

  const editor = resolveEditorRoleFromStatus(assignments, status);
  if (!editor) {
    req.reject(403, `User cannot edit RequestValues for status ${status}`);
  }

  const fieldControl = await getEffectiveFieldControl(tx, {
    processRoleId: editor.PROCESS_ROLE_ID,
    countryCode: request.COUNTRY_CODE,
    fieldId
  });

  if ([FIELD_CONTROL.READ_ONLY, FIELD_CONTROL.HIDDEN].includes(fieldControl)) {
    req.reject(403, `Field is not writable for role ${editor.ROLE_CODE} (fieldControl=${fieldControl})`);
  }

  const fieldCode = await getFieldCodeById(tx, fieldId);
  const lineNo = req.data?.LINE_NO ?? req._requestValueAudit?.lineNo ?? 1;
  req._requestValueAudit = {
    ...(req._requestValueAudit || {}),
    requestId,
    fieldId,
    fieldCode: fieldCode || null,
    lineNo,
    roleCode: editor.ROLE_CODE,
    changeType: event === 'CREATE' ? 'CREATE' : (req._requestValueAudit?.changeType || 'UPDATE')
  };

  req.data.MODIFIEDAT = now();
  req.data.MODIFIEDBY = userId;

  if (event === 'CREATE') {
    req.data.ID = req.data.ID || uuid();
  }

  if (req.data.VALUE !== undefined && req.data.VALUE !== null && String(req.data.VALUE).trim() !== '') {
    await syncRequestSubjectFromRequestValue(tx, {
      requestId,
      fieldId,
      rawValue: req.data.VALUE,
      userId
    });
  }
}

async function afterUpsertRequestValue(_, req) {
  const tx = cds.tx(req);
  const userId = currentUserId(req);
  const audit = req._requestValueAudit;
  if (!audit?.requestId || !audit?.fieldId) return;

  if (req.event === 'UPDATE' && req.data?.VALUE === undefined) return;

  const newValue = req.data?.VALUE ?? null;
  const oldValue = audit.oldValue ?? null;
  const changeType = audit.changeType || (req.event === 'CREATE' ? 'CREATE' : 'UPDATE');
  if (changeType === 'UPDATE' && areValuesEqual(oldValue, newValue)) return;

  await insertRequestFieldChangeLog(tx, {
    requestId: audit.requestId,
    fieldId: audit.fieldId,
    fieldCode: audit.fieldCode || `FIELD_ID:${audit.fieldId}`,
    lineNo: audit.lineNo || 1,
    oldValue,
    newValue,
    changeType,
    changedBy: userId,
    changedRole: audit.roleCode || null,
    source: req.event === 'CREATE' ? 'REQUEST_VALUE_CREATE' : 'REQUEST_VALUE_UPDATE'
  });

  const triggerFieldCode = String(audit.fieldCode || '').trim().toUpperCase();
  const shouldSyncDestFact = triggerFieldCode.startsWith('KNA1.')
    || triggerFieldCode.startsWith('BUT000-KNA1.')
    || triggerFieldCode === 'MDG_CTRL.CREATE_DESTFACT';
  const shouldSyncDestMerc = triggerFieldCode.startsWith('KNA1.')
    || triggerFieldCode.startsWith('BUT000-KNA1.');
  if (shouldSyncDestFact) {
    await syncDestFactReadonlyFromKna1(tx, {
      requestId: audit.requestId,
      userId
    });
  }
  if (shouldSyncDestMerc) {
    await syncDestMercEmbeddedFromKna1(tx, {
      requestId: audit.requestId,
      userId
    });
  }
}

async function onDeleteRequestValue(req) {
  const tx = cds.tx(req);
  const userId = currentUserId(req);
  const valueId = getEntityId(req);
  if (!valueId) req.reject(400, 'Missing RequestValue ID');

  const currentValue = await getRequestValueDetailById(tx, valueId);
  if (!currentValue) req.reject(404, `RequestValue not found: ${valueId}`);

  const request = await getRequestById(tx, currentValue.REQUEST_ID);
  if (!request) req.reject(404, `Request not found: ${currentValue.REQUEST_ID}`);
  if (request.ISDELETED) req.reject(409, 'Request is deleted');

  const status = normalizeStatus(request.STATUS);
  const assignments = await getUserRoleAssignments(tx, req, {
    processId: request.PROCESS_ID,
    countryCode: request.COUNTRY_CODE
  });
  const editor = resolveEditorRoleFromStatus(assignments, status);
  if (!editor) req.reject(403, `User cannot edit RequestValues for status ${status}`);

  const fieldControl = await getEffectiveFieldControl(tx, {
    processRoleId: editor.PROCESS_ROLE_ID,
    countryCode: request.COUNTRY_CODE,
    fieldId: currentValue.FIELD_ID
  });
  if ([FIELD_CONTROL.READ_ONLY, FIELD_CONTROL.HIDDEN].includes(fieldControl)) {
    req.reject(403, `Field is not writable for role ${editor.ROLE_CODE} (fieldControl=${fieldControl})`);
  }

  await tx.run(`DELETE FROM "MDG_REQUEST_FIELD_VALUE" WHERE "ID" = ?`, [valueId]);

  const fieldCode = await getFieldCodeById(tx, currentValue.FIELD_ID);
  await insertRequestFieldChangeLog(tx, {
    requestId: currentValue.REQUEST_ID,
    fieldId: currentValue.FIELD_ID,
    fieldCode: fieldCode || `FIELD_ID:${currentValue.FIELD_ID}`,
    lineNo: currentValue.LINE_NO || 1,
    oldValue: currentValue.VALUE,
    newValue: null,
    changeType: 'DELETE',
    changedBy: userId,
    changedRole: editor.ROLE_CODE,
    source: 'REQUEST_VALUE_DELETE'
  });
}

function register(service) {
  service.before('CREATE', 'Requests', beforeCreateRequest);
  service.after('CREATE', 'Requests', afterCreateRequest);
  service.before('UPDATE', 'Requests', beforeUpdateRequest);
  service.after('UPDATE', 'Requests', afterUpdateRequest);
  service.on('DELETE', 'Requests', onDeleteRequest);

  service.before('CREATE', 'RequestValues', beforeUpsertRequestValue);
  service.before('UPDATE', 'RequestValues', beforeUpsertRequestValue);
  service.after('CREATE', 'RequestValues', afterUpsertRequestValue);
  service.after('UPDATE', 'RequestValues', afterUpsertRequestValue);
  service.on('DELETE', 'RequestValues', onDeleteRequestValue);
}

module.exports = { register };
