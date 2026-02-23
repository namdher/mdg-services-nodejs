const cds = require('@sap/cds');
const {
  currentUserId,
  getRequestById,
  getUserRoleAssignments,
  normalizeStatus,
  resolvePreferredRoleForComment,
  roleToBusinessName,
  now,
  uuid
} = require('./_lib/mdg-workflow.util');

async function beforeCreateRequestComment(req) {
  const tx = cds.tx(req);
  const userId = currentUserId(req);

  const requestId = req.data.REQUEST_ID;
  if (!requestId) req.reject(400, 'REQUEST_ID is required');

  const message = typeof req.data.MESSAGE === 'string' ? req.data.MESSAGE.trim() : '';
  if (!message) req.reject(400, 'MESSAGE is required');

  const request = await getRequestById(tx, requestId);
  if (!request) req.reject(404, `Request not found: ${requestId}`);
  if (request.ISDELETED) req.reject(409, 'Request is deleted');

  const assignments = await getUserRoleAssignments(tx, req, {
    processId: request.PROCESS_ID,
    countryCode: request.COUNTRY_CODE
  });

  if (!assignments.length) {
    req.reject(403, 'User has no access to this request');
  }

  const chosen = resolvePreferredRoleForComment(assignments, normalizeStatus(request.STATUS));
  if (!chosen) {
    req.reject(403, 'Unable to resolve user role for this request');
  }

  req.data.ID = req.data.ID || uuid();
  req.data.MESSAGE = message;
  req.data.CREATEDAT = now();
  req.data.CREATEDBY = userId;
  req.data.AUTHOR_USER = userId;
  req.data.AUTHOR_ROLE = roleToBusinessName(chosen.ROLE_CODE);
}

function register(service) {
  service.before('CREATE', 'RequestComments', beforeCreateRequestComment);
}

module.exports = { register };
