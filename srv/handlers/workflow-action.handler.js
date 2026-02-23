const cds = require('@sap/cds');
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

  await tx.run(
    `UPDATE "MDG_REQUEST_HEADER"
        SET "STATUS" = ?,
            "MODIFIEDAT" = ?,
            "MODIFIEDBY" = ?
      WHERE "ID" = ?`,
    [toStatus, new Date(), userId, requestId]
  );

  if (comment) {
    await insertComment(tx, {
      requestId,
      authorUser: userId,
      authorRole: roleToBusinessName(ROLE_CODES.APPROVER),
      message: comment
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
    decision: taskDecision,
    comment: comment || null,
    actorUser: userId
  });

  return JSON.stringify({
    ok: true,
    requestId,
    status: toStatus,
    action: actionName
  });
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
