const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const DESTINATION_NAME = 'S4H-TECH';

function isDevToolsEnabled() {
  return process.env.NODE_ENV !== 'production' || String(process.env.MDG_DEV_TOOLS).toLowerCase() === 'true';
}

async function fetchS4Metadata(req) {

  const servicePath = typeof req.data?.servicePath === 'string' ? req.data.servicePath.trim() : '';
  if (!servicePath || !servicePath.startsWith('/sap/opu/odata/sap/')) {
    req.reject(400, "servicePath must start with '/sap/opu/odata/sap/'");
  }

  const basePath = servicePath.replace(/\/+$/, '');
  const url = `${basePath}/$metadata`;

  try {
    const response = await executeHttpRequest(
      { destinationName: DESTINATION_NAME },
      {
        method: 'GET',
        url,
        headers: {
          Accept: 'application/xml, text/xml, application/atom+xml, */*'
        }
      }
    );

    const data = response?.data;
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data === undefined || data === null) return '';
    return String(data);
  } catch (err) {
    if (isDevToolsEnabled()) {
      const status = err?.response?.status || err?.statusCode || err?.cause?.response?.status || 'unknown';
      const rawBody = err?.response?.data ?? err?.cause?.response?.data ?? '';
      const bodyText = typeof rawBody === 'string'
        ? rawBody
        : Buffer.isBuffer(rawBody)
          ? rawBody.toString('utf8')
          : rawBody
            ? JSON.stringify(rawBody)
            : '';
      console.error('fetchS4Metadata error', {
        destination: DESTINATION_NAME,
        url,
        status,
        body: bodyText.slice(0, 300)
      });
    }
    const msg = err?.message || 'Failed to fetch S/4 metadata';
    req.reject(502, msg);
  }
}

module.exports = { fetchS4Metadata };
