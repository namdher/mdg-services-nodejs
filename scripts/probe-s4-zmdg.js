#!/usr/bin/env node
'use strict';

const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
try {
  require('@sap/xsenv').loadEnv();
} catch (_) {
  // The probe can still run in Cloud Foundry where env vars are already present.
}

const destinationName = process.env.MDG_S4_DESTINATION || 'S4H-TECH';
const servicePath = process.env.MDG_S4_SERVICE_PATH || '/sap/opu/odata/sap/ZMDG_DM_SRV';

async function probe(label, request, options) {
  const started = Date.now();
  try {
    const res = await executeHttpRequest({ destinationName }, request, options);
    console.log(JSON.stringify({
      label,
      ok: true,
      status: res.status,
      ms: Date.now() - started,
      contentType: res.headers?.['content-type'] || res.headers?.['Content-Type'] || null,
      xcsrf: res.headers?.['x-csrf-token'] || res.headers?.['X-CSRF-Token'] || null,
      bodyPreview: typeof res.data === 'string' ? res.data.slice(0, 180) : JSON.stringify(res.data || {}).slice(0, 180)
    }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({
      label,
      ok: false,
      status: err?.response?.status || err?.statusCode || null,
      code: err?.code || err?.cause?.code || null,
      ms: Date.now() - started,
      message: String(err?.message || err),
      bodyPreview: typeof err?.response?.data === 'string'
        ? err.response.data.slice(0, 240)
        : JSON.stringify(err?.response?.data || err?.data || {}).slice(0, 240)
    }, null, 2));
  }
}

(async () => {
  const base = servicePath.replace(/\/+$/, '');
  await probe('metadata', {
    method: 'GET',
    url: `${base}/$metadata`,
    timeout: 120000,
    headers: { Accept: 'application/xml, text/xml, */*' }
  });
  await probe('service-root-csrf', {
    method: 'GET',
    url: `${base}/`,
    timeout: 120000,
    headers: {
      Accept: 'application/json',
      'x-csrf-token': 'Fetch'
    }
  });
  await probe('entity-csrf', {
    method: 'GET',
    url: `${base}/ClientesEmpresarialSet`,
    timeout: 120000,
    headers: {
      Accept: 'application/json',
      'x-csrf-token': 'Fetch'
    },
    params: { '$top': 1 }
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
