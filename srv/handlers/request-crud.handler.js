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

function resolveDefaultValue(defaultBase) {
  if (defaultBase === null || defaultBase === undefined) return null;
  const raw = String(defaultBase);
  const token = raw.trim().toUpperCase();
  if (token === '$NOW_DATE' || token === 'TODAY') {
    return toLocalIsoDate();
  }
  return raw;
}

async function applyDefaultsToRequest(tx, requestId, processId, countryCode, processRoleId, userId = 'system') {
  if (!requestId || !processId || !processRoleId) return 0;

  const scopedDefaults = await tx.run(
    `SELECT DISTINCT
        fc."ID"          AS "FIELD_ID",
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

    const resolved = resolveDefaultValue(row.DEFAULT_BASE);
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
