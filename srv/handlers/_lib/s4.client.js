const cds = require('@sap/cds');
const { encodeQuery } = require('./odata.util');

const TRANSIENT_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN']);

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _isTransientS4ReadError(err) {
  const code = err?.code || err?.reason?.code || err?.cause?.code || err?.rootCause?.code;
  const status = Number(err?.response?.status || err?.statusCode || err?.cause?.response?.status || err?.reason?.response?.status || 0);
  return TRANSIENT_ERROR_CODES.has(String(code || '').toUpperCase()) || status === 502 || status === 503 || status === 504;
}

async function s4Get({ servicePath, entitySet, query = {} }) {
  const s4 = await cds.connect.to('S4H'); // requires S4H in package.json cds.requires
  const path = `${servicePath.replace(/\/$/, '')}/${entitySet}${encodeQuery(query)}`;
  let res;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      res = await s4.send({ method: 'GET', path });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (!_isTransientS4ReadError(err) || attempt === 3) break;
      await _sleep(250 * attempt);
    }
  }

  if (lastError) throw lastError;

  // Normalize OData V2 response
  if (res?.d?.results) return res.d.results;
  if (res?.d) return [res.d];
  // Fallback
  if (Array.isArray(res?.value)) return res.value;
  if (Array.isArray(res)) return res;
  return res ? [res] : [];
}

module.exports = { s4Get };
