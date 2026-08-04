#!/usr/bin/env node
'use strict';

const Module = require('module');
const fs = require('fs');
const path = require('path');
const cds = require('@sap/cds');

function usage() {
  console.error([
    'Usage:',
    '  node scripts/retry-approve-request-cf.js <REQUEST_ID> <IAS_MANAGER_GROUP> [USER_EMAIL] [COMMENT]',
    '',
    'Example:',
    '  node scripts/retry-approve-request-cf.js 2df15adc-eeb7-4f4a-96c3-613780ef56a3 MDG_CUSTOMER_EXTEND_COMPANYCODE_MANAGER namdher.colmenares@vacconsultores.cl'
  ].join('\n'));
}

function b64url(input) {
  return Buffer.from(JSON.stringify(input)).toString('base64url');
}

function fakeJwt(groups, userId) {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    user_name: userId,
    email: userId,
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    'xs.system.attributes': {
      'xs.rolecollections': groups,
      'xs.saml.groups': groups
    }
  })}.`;
}

function makeReq({ requestId, token, userId, comment }) {
  return {
    data: {
      ID: requestId,
      COMMENT: comment || 'Reintento tecnico ejecutado por manager.'
    },
    user: { id: userId },
    headers: { authorization: `Bearer ${token}` },
    _: { req: { headers: { authorization: `Bearer ${token}` } } },
    reject(status, message) {
      const err = new Error(message || `Request rejected with ${status}`);
      err.statusCode = status;
      throw err;
    }
  };
}

function loadWorkflowHandler() {
  const filename = path.resolve('srv/handlers/workflow-action.handler.js');
  let code = fs.readFileSync(filename, 'utf8');
  code = code.replace(
    'module.exports = { register, getRequestResults };',
    'module.exports = { register, getRequestResults, approveRequest };'
  );

  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(code, filename);
  return m.exports;
}

async function readHeader(tx, requestId) {
  const rows = await tx.run(
    `SELECT h."ID", h."STATUS", h."PROCESS_ID", h."COUNTRY_CODE", h."SUBJECT_ID", p."PROCESS_CODE"
       FROM "MDG_REQUEST_HEADER" h
       JOIN "MDG_PROCESS" p ON p."ID" = h."PROCESS_ID"
      WHERE h."ID" = ?`,
    [requestId]
  );
  return rows[0] || null;
}

async function reopenForTechnicalRetry(tx, requestId, userId) {
  await tx.run(
    `UPDATE "MDG_REQUEST_HEADER"
        SET "STATUS" = 'IN_REVIEW',
            "MODIFIEDBY" = ?,
            "MODIFIEDAT" = CURRENT_TIMESTAMP
      WHERE "ID" = ?`,
    [userId, requestId]
  );
}

async function latestSapMessage(tx, requestId) {
  const rows = await tx.run(
    `SELECT "HTTP_STATUS", "SAP_OBJECT_KEY", "PAYLOAD_JSON", "RESPONSE_JSON", "CREATEDAT"
       FROM "MDG_REQUEST_SAP_MESSAGE"
      WHERE "REQUEST_ID" = ?
      ORDER BY "CREATEDAT" DESC`,
    [requestId]
  );
  const row = rows[0] || null;
  if (!row) return null;

  let parsed = {};
  try {
    parsed = JSON.parse(row.RESPONSE_JSON || '{}');
  } catch (err) {
    parsed = {};
  }
  const mdgResult = parsed._mdgResult || {};
  const sapError = parsed.error || {};
  const sapMessage = sapError?.message && typeof sapError.message === 'object'
    ? sapError.message.value
    : sapError?.message;

  return {
    HTTP_STATUS: row.HTTP_STATUS,
    SAP_OBJECT_KEY: row.SAP_OBJECT_KEY,
    STATUS: mdgResult.status || null,
    STEP: mdgResult.stepCode || mdgResult.entitySet || null,
    MESSAGE: mdgResult.message || sapMessage || null,
    PAYLOAD_JSON: row.PAYLOAD_JSON,
    CREATEDAT: row.CREATEDAT
  };
}

async function main() {
  const [requestId, group, userArg, ...commentParts] = process.argv.slice(2);
  if (!requestId || !group) {
    usage();
    process.exit(2);
  }

  const userId = userArg || 'namdher.colmenares@vacconsultores.cl';
  const comment = commentParts.join(' ') || 'Reintento tecnico ejecutado por manager.';
  const token = fakeJwt([group], userId);
  const workflow = loadWorkflowHandler();

  await cds.connect.to('db');
  const tx = cds.tx();
  const originalTx = cds.tx;
  cds.tx = () => tx;

  try {
    const before = await readHeader(tx, requestId);
    if (!before) throw new Error(`Request not found: ${requestId}`);

    console.log('MDG_RETRY_APPROVE_START', JSON.stringify({
      requestId,
      processCode: before.PROCESS_CODE,
      status: before.STATUS,
      subjectId: before.SUBJECT_ID,
      group,
      userId
    }));

    if (before.STATUS !== 'IN_REVIEW') {
      await reopenForTechnicalRetry(tx, requestId, userId);
    }

    const req = makeReq({ requestId, token, userId, comment });
    const approveResultRaw = await workflow.approveRequest(req);
    const resultReq = makeReq({ requestId, token, userId, comment });
    resultReq.data = { requestId };
    const requestResults = await workflow.getRequestResults(resultReq);
    const after = await readHeader(tx, requestId);
    const sapMessage = await latestSapMessage(tx, requestId);

    await tx.commit();

    console.log('MDG_RETRY_APPROVE_RESULT', JSON.stringify({
      approveResult: approveResultRaw,
      requestResults,
      after,
      sapMessage
    }, null, 2));
  } catch (err) {
    await tx.rollback();
    console.error('MDG_RETRY_APPROVE_ERROR', err?.stack || err?.message || err);
    process.exitCode = 1;
  } finally {
    cds.tx = originalTx;
  }
}

main();
