const cds = require('@sap/cds');
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

function getEntityId(req) {
  return req.data?.ID || req.params?.[0]?.ID;
}

async function beforeCreateRequest(req) {
  const tx = cds.tx(req);
  const userId = currentUserId(req);

  if (!req.data.PROCESS_ID || !req.data.COUNTRY_CODE) {
    req.reject(400, 'PROCESS_ID and COUNTRY_CODE are required');
  }

  const assignments = await getUserRoleAssignments(tx, req, {
    processId: req.data.PROCESS_ID,
    countryCode: req.data.COUNTRY_CODE
  });

  if (!assignments.some((a) => a.ROLE_CODE === ROLE_CODES.REQUESTER)) {
    req.reject(403, 'Only REQUESTER can create requests for this process/country');
  }

  const incomingStatus = normalizeStatus(req.data.STATUS);
  if (incomingStatus && incomingStatus !== STATUS.DRAFT) {
    req.reject(400, `Invalid initial STATUS: ${incomingStatus}. Requests must start in DRAFT.`);
  }

  const requesterRoleRows = await tx.run(
    `SELECT "FRONT_CODE"
       FROM "MDG_PROCESS_ROLE"
      WHERE "PROCESS_ID" = ?
        AND "ROLE_CODE" = 'REQUESTER'
        AND "IS_ENABLED" = true
      ORDER BY "ID"`,
    [req.data.PROCESS_ID]
  );
  req.data.FRONT_CODE = requesterRoleRows?.[0]?.FRONT_CODE ?? null;

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

  const incomingStatus = req.data.STATUS === undefined ? undefined : normalizeStatus(req.data.STATUS);
  let isSubmitTransition = false;

  if (incomingStatus !== undefined && incomingStatus !== currentStatus) {
    const isValidSubmit = [STATUS.DRAFT, STATUS.REWORK].includes(currentStatus) && incomingStatus === STATUS.SUBMITTED;
    if (!isValidSubmit) {
      req.reject(400, `Invalid status transition: ${currentStatus} -> ${incomingStatus}`);
    }

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
  if (!req._submitTransition) return;

  const tx = cds.tx(req);
  const { requestId, processId, actorUser, actorRole } = req._submitTransition;

  await insertActionLog(tx, {
    requestId,
    action: 'SUBMIT',
    actorUser,
    actorRole,
    comment: null
  });

  await upsertApprovalTaskOnSubmit(tx, {
    requestId,
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

  await tx.run(
    `UPDATE "MDG_REQUEST_HEADER"
        SET "ISDELETED" = true,
            "DELETEDAT" = ?,
            "DELETEDBY" = ?,
            "MODIFIEDAT" = ?,
            "MODIFIEDBY" = ?
      WHERE "ID" = ?`,
    [now(), userId, now(), userId, requestId]
  );
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

    requestId = requestId || currentValue.REQUEST_ID;
    fieldId = fieldId || currentValue.FIELD_ID;

    req.data.REQUEST_ID = requestId;
    req.data.FIELD_ID = fieldId;
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

  req.data.MODIFIEDAT = now();
  req.data.MODIFIEDBY = userId;

  if (event === 'CREATE') {
    req.data.ID = req.data.ID || uuid();
  }
}

function register(service) {
  service.before('CREATE', 'Requests', beforeCreateRequest);
  service.before('UPDATE', 'Requests', beforeUpdateRequest);
  service.after('UPDATE', 'Requests', afterUpdateRequest);
  service.on('DELETE', 'Requests', onDeleteRequest);

  service.before('CREATE', 'RequestValues', beforeUpsertRequestValue);
  service.before('UPDATE', 'RequestValues', beforeUpsertRequestValue);
}

module.exports = { register };
