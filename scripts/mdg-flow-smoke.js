#!/usr/bin/env node
'use strict';

const Module = require('module');
const path = require('path');
const fs = require('fs');
const cds = require('@sap/cds');

const SAMPLE_VALUES = {
  'BUT000-KNA1.KUNNR': '1156916',
  'KNA1.KUNNR': '1156916',
  'KNVV.VKORG': 'VA96',
  'KNVV.VTWEG': '20',
  'KNVV.SPART': '04',
  'KNVV.KVGR1': 'C01',
  'KNVV.KVGR2': '0',
  'KNVV.KVGR3': '800',
  'KNVV.KVGR4': '1',
  'KNVV.KVGR5': '001',
  'KNVV.ZZKVGR6': 'ECO',
  'KNVV.ZZKVGR7': '0',
  'KNVV.ZZKVGR8': 'D',
  'KNVV.ZZKVGR9': 'SI',
  'KNVV.ZZKVGR10': 'LA',
  'KNVV.ZZREIA': '1',
  'KNVV.ZZREIC': '1',
  'KNVV.ZZREICP': 'CAD-0001',
  'KNVV.ZZREIV': '1',
  'KNVV.ZZPOAN': '0',
  'KNVV.ZZPOCE': '0',
  'KNVV.ZZPOCP': '0',
  'KNVV.ZZPOVS': '0',
  'KNVV.ZZCLAD': '1156916',
  'KNVV.ZZFOPR': 'PD',
  'KNVV.ZZEMBA': 'CO',
  'KNVV.ZZTIEN': 'GD',
  'KNVV.ZZNORM': 'NO',
  'KNVV.ZZMAAC': 'NO',
  'KNVV.ZZADI11': '0000',
  'KNVV.ZZADI12': 'BC-0001',
  'KNVV.ZZADI13': 'ZC01',
  'KNVV.ZZADI14': 'AP',
  'KNVV.ZZADI15': 'ALM',
  'KNVV.ZZADI16': 'A001',
  'KNVV.ZZADI17': 'RB_FUG',
  'KNVV.ZZADI18': 'SI'
};

const EXPECTED_ADDITIONAL_PROPS = [
  'Kvgr1', 'Kvgr2', 'Kvgr3', 'Kvgr4', 'Kvgr5',
  'Zzkvgr6', 'Zzkvgr7', 'Zzkvgr8', 'Zzkvgr9', 'Zzkvgr10',
  'Zzreia', 'Zzreic', 'Zzreicp', 'Zzreiv',
  'Zzpoan', 'Zzpoce', 'Zzpocp', 'Zzpovs',
  'Zzclad', 'Zzfopr', 'Zzemba', 'Zztien',
  'Zznorm', 'Zzmaac',
  'Zzadi11', 'Zzadi12', 'Zzadi13', 'Zzadi14', 'Zzadi15', 'Zzadi16', 'Zzadi17', 'Zzadi18'
];

function parseArgs(argv) {
  const out = {
    mode: 'mock',
    customer: null,
    destmerc: null,
    injectSamples: true
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mock') out.mode = 'mock';
    else if (a === '--real-post') out.mode = 'real';
    else if (a === '--customer') out.customer = argv[++i];
    else if (a === '--destmerc') out.destmerc = argv[++i];
    else if (a === '--no-inject-samples') out.injectSamples = false;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/mdg-flow-smoke.js --mock --customer <requestId> --destmerc <requestId>
  MDG_FLOW_REAL_POST_CONFIRM=YES node scripts/mdg-flow-smoke.js --real-post --customer <inReviewId> --destmerc <inReviewId>

Modes:
  --mock       Runs approveRequest end-to-end with S/4 mocked and rolls DB back.
  --real-post  Calls the real S/4 POST. Requests must already be IN_REVIEW.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return out;
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
  const req = {
    data: { ID: requestId, COMMENT: comment || 'Automated MDG flow smoke test' },
    user: { id: userId },
    headers: { authorization: `Bearer ${token}` },
    _: { req: { headers: { authorization: `Bearer ${token}` } } },
    reject(status, message) {
      const err = new Error(message || `Request rejected with ${status}`);
      err.statusCode = status;
      throw err;
    }
  };
  return req;
}

function loadWorkflow({ mockHttp }) {
  const filename = path.resolve('srv/handlers/workflow-action.handler.js');
  let code = fs.readFileSync(filename, 'utf8');
  code = code.replace(
    'module.exports = { register, getRequestResults };',
    `module.exports = { register, getRequestResults, approveRequest, __test: {
      _resolveSapTargetsForProcessAnyState,
      _classifyCustomerCreationTarget,
      _classifyDestMercCreationTarget
    } };`
  );

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (mockHttp && request === '@sap-cloud-sdk/http-client') {
      return {
        executeHttpRequest: async (_destination, options) => mockHttp(options)
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const m = new Module(filename, module);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(path.dirname(filename));
    m._compile(code, filename);
    return m.exports;
  } finally {
    Module._load = originalLoad;
  }
}

async function readRequest(tx, requestId) {
  const rows = await tx.run(
    `SELECT h."ID", h."PROCESS_ID", p."PROCESS_CODE", h."STATUS", h."COUNTRY_CODE", h."SUBJECT_ID"
       FROM "MDG_REQUEST_HEADER" h
       JOIN "MDG_PROCESS" p ON p."ID" = h."PROCESS_ID"
      WHERE h."ID" = ?`,
    [requestId]
  );
  return rows[0] || null;
}

async function approverGroups(tx, processId, countryCode) {
  const rows = await tx.run(
    `SELECT DISTINCT m."IAS_GROUP"
       FROM "MDG_IAS_GROUP_ROLE_MAP" m
       JOIN "MDG_PROCESS_ROLE" pr ON pr."ID" = m."PROCESS_ROLE_ID"
      WHERE m."PROCESS_ID" = ?
        AND m."IS_ENABLED" = true
        AND pr."IS_ENABLED" = true
        AND pr."ROLE_CODE" = 'APPROVER'
        AND (
          NOT EXISTS (
            SELECT 1 FROM "MDG_COUNTRY_ROLE_SCOPE" s0
             WHERE s0."PROCESS_ROLE_ID" = pr."ID"
               AND s0."IS_ENABLED" = true
          )
          OR EXISTS (
            SELECT 1 FROM "MDG_COUNTRY_ROLE_SCOPE" s1
             WHERE s1."PROCESS_ROLE_ID" = pr."ID"
               AND s1."COUNTRY_CODE" = ?
               AND s1."IS_ENABLED" = true
          )
        )`,
    [processId, countryCode]
  );
  return rows.map((r) => r.IAS_GROUP).filter(Boolean);
}

async function injectSamples(tx, requestId, request) {
  const processId = request.PROCESS_ID;
  const includePrincipal = String(request.PROCESS_CODE || '').toUpperCase() === 'DESTMERC_CREATION';
  const targets = await tx.run(
    `SELECT "ID", "ENTITYSET"
       FROM "MDG_SAP_TARGET"
      WHERE "PROCESS_ID" = ?
        AND UPPER(COALESCE("OPERATION", 'POST')) = 'POST'
        AND "IS_ENABLED" = true`,
    [processId]
  );
  const targetIds = targets.map((t) => t.ID).filter(Boolean);
  if (!targetIds.length) return 0;

  const codes = Object.keys(SAMPLE_VALUES).filter((code) => {
    if (includePrincipal) return true;
    return !['BUT000-KNA1.KUNNR', 'KNA1.KUNNR'].includes(code);
  });
  const rows = await tx.run(
    `SELECT DISTINCT fc."ID", fc."FIELD_CODE"
       FROM "MDG_FIELD_CATALOG" fc
       JOIN "MDG_SAP_PAYLOAD_MAP" pm ON pm."FIELD_ID" = fc."ID"
      WHERE fc."FIELD_CODE" IN (${codes.map(() => '?').join(',')})
        AND pm."SAP_TARGET_ID" IN (${targetIds.map(() => '?').join(',')})`,
    [...codes, ...targetIds]
  );
  const principalRows = includePrincipal ? await tx.run(
    `SELECT DISTINCT "ID", "FIELD_CODE"
       FROM "MDG_FIELD_CATALOG"
      WHERE "FIELD_CODE" IN ('BUT000-KNA1.KUNNR', 'KNA1.KUNNR')`
  ) : [];
  for (const row of principalRows || []) {
    if (!rows.some((r) => r.ID === row.ID)) rows.push(row);
  }
  if (!rows.length) return 0;

  const ids = rows.map((r) => r.ID);
  await tx.run(
    `DELETE FROM "MDG_REQUEST_FIELD_VALUE"
      WHERE "REQUEST_ID" = ?
        AND "FIELD_ID" IN (${ids.map(() => '?').join(',')})`,
    [requestId, ...ids]
  );

  const now = new Date();
  await tx.run(INSERT.into('MDG_REQUEST_FIELD_VALUE').entries(rows.map((r) => ({
    ID: cds.utils.uuid(),
    REQUEST_ID: requestId,
    FIELD_ID: r.ID,
    LINE_NO: 1,
    VALUE: SAMPLE_VALUES[r.FIELD_CODE],
    MODIFIEDAT: now,
    MODIFIEDBY: 'mdg-flow-smoke'
  }))));
  return rows.length;
}

function makeMockHttp(callLog) {
  const ids = {
    ClientesGeneralSet: '9000000010',
    DestMercaderiaGeneralSet: '9000000020',
    ClientesOrgVentaSet: '9000000010',
    DestMercaderiaComercialSet: '9000000020',
    DestMercaderiaImpuestosSet: '9000000020'
  };
  return async function mockHttp(options) {
    const url = String(options?.url || '');
    const entitySet = url.split('/').filter(Boolean).pop();
    const payload = options?.data || {};
    callLog.push({
      entitySet,
      url,
      payload,
      additionalPresent: EXPECTED_ADDITIONAL_PROPS.filter((p) => Object.prototype.hasOwnProperty.call(payload, p)),
      additionalMissing: EXPECTED_ADDITIONAL_PROPS.filter((p) => !Object.prototype.hasOwnProperty.call(payload, p))
    });
    return {
      status: 201,
      headers: { 'x-correlationid': `mock-${callLog.length}` },
      data: {
        d: {
          Kunnr: ids[entitySet] || payload.Kunnr || payload.BusinessPartner || '9000000099',
          BusinessPartner: ids[entitySet] || payload.BusinessPartner || payload.Kunnr || '9000000099',
          Vkorg: payload.Vkorg,
          Vtweg: payload.Vtweg,
          Spart: payload.Spart
        }
      }
    };
  };
}

async function runOne({ db, requestId, mode, inject }) {
  const tx = db.tx();
  const originalCdsTx = cds.tx;
  cds.tx = () => tx;

  const callLog = [];
  const workflow = loadWorkflow({
    mockHttp: mode === 'mock' ? makeMockHttp(callLog) : null
  });
  try {
    const request = await readRequest(tx, requestId);
    if (!request) throw new Error(`Request not found: ${requestId}`);

    const groups = await approverGroups(tx, request.PROCESS_ID, request.COUNTRY_CODE);
    if (!groups.length) throw new Error(`No APPROVER IAS group configured for ${request.PROCESS_CODE}/${request.COUNTRY_CODE}`);

    let insertedSamples = 0;
    if (mode === 'mock') {
      await tx.run(`UPDATE "MDG_REQUEST_HEADER" SET "STATUS" = 'IN_REVIEW' WHERE "ID" = ?`, [requestId]);
      if (inject) insertedSamples = await injectSamples(tx, requestId, request);
    } else if (request.STATUS !== 'IN_REVIEW') {
      throw new Error(`Real POST requires request ${requestId} to be IN_REVIEW. Current status: ${request.STATUS}`);
    }

    const token = fakeJwt(groups, 'mdg-flow-smoke@local');
    const req = makeReq({ requestId, token, userId: 'mdg-flow-smoke@local' });
    const raw = await workflow.approveRequest(req);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const results = await workflow.getRequestResults(makeReq({ requestId, token, userId: 'mdg-flow-smoke@local' }));

    const out = {
      requestId,
      processCode: request.PROCESS_CODE,
      originalStatus: request.STATUS,
      mode,
      insertedSamples,
      approveResult: parsed,
      resultCount: Array.isArray(results) ? results.length : null,
      results,
      postCalls: callLog.map((c) => ({
        entitySet: c.entitySet,
        kunnr: c.payload.Kunnr || null,
        kunnrPrinc: c.payload.KunnrPrinc || null,
        vkorg: c.payload.Vkorg || null,
        vtweg: c.payload.Vtweg || null,
        spart: c.payload.Spart || null,
        additionalPresentCount: c.additionalPresent.length,
        additionalMissing: c.entitySet === 'DestMercaderiaComercialSet' ? c.additionalMissing : []
      }))
    };

    if (mode === 'mock') await tx.rollback();
    else await tx.commit();
    return out;
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  } finally {
    cds.tx = originalCdsTx;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode === 'real' && process.env.MDG_FLOW_REAL_POST_CONFIRM !== 'YES') {
    throw new Error('Real POST blocked. Set MDG_FLOW_REAL_POST_CONFIRM=YES and use requests already in IN_REVIEW.');
  }
  const ids = [args.customer, args.destmerc].filter(Boolean);
  if (!ids.length) throw new Error('Provide --customer and/or --destmerc request IDs.');

  const db = await cds.connect.to('db');

  const outputs = [];
  for (const requestId of ids) {
    outputs.push(await runOne({
      db,
      requestId,
      mode: args.mode,
      inject: args.injectSamples
    }));
  }

  console.log(JSON.stringify({ ok: true, mode: args.mode, outputs }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    message: err.message,
    statusCode: err.statusCode || null,
    stack: err.stack
  }, null, 2));
  process.exit(1);
});
