const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const DESTINATION_NAME = 'S4H-TECH';

function isDevToolsEnabled() {
  return process.env.NODE_ENV !== 'production' || String(process.env.MDG_DEV_TOOLS).toLowerCase() === 'true';
}

function _toText(payload) {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  if (payload === undefined || payload === null) return '';
  try {
    return JSON.stringify(payload);
  } catch (_) {
    return String(payload);
  }
}

function _extractMessageFromBody(payload) {
  if (!payload) return '';

  if (typeof payload === 'object') {
    const candidates = [
      payload?.error?.message?.value,
      payload?.error?.message,
      payload?.message?.value,
      payload?.message,
      payload?.error_description
    ];
    const first = candidates.find(v => typeof v === 'string' && v.trim());
    if (first) return first.trim();
  }

  const bodyText = _toText(payload);
  if (!bodyText) return '';

  // OData XML error body: <message ...>...</message>
  const xmlMsg = bodyText.match(/<message[^>]*>([\s\S]*?)<\/message>/i);
  if (xmlMsg?.[1]) return xmlMsg[1].trim();

  // Generic JSON body encoded as text.
  try {
    const parsed = JSON.parse(bodyText);
    const jsonMsg = parsed?.error?.message?.value || parsed?.error?.message || parsed?.message?.value || parsed?.message;
    if (typeof jsonMsg === 'string' && jsonMsg.trim()) return jsonMsg.trim();
  } catch (_) {
    // not JSON text
  }

  return bodyText.slice(0, 240).trim();
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
    const status = err?.response?.status || err?.statusCode || err?.cause?.response?.status || 500;
    const rawBody = err?.response?.data ?? err?.cause?.response?.data;
    const backendMessage = _extractMessageFromBody(rawBody);
    const correlationId =
      err?.response?.headers?.['x-correlationid'] ||
      err?.response?.headers?.['x-correlation-id'] ||
      err?.correlationId ||
      '';

    if (isDevToolsEnabled()) {
      const bodyText = _toText(rawBody);
      console.error('fetchS4Metadata error', {
        destination: DESTINATION_NAME,
        url,
        status,
        correlationId,
        body: bodyText.slice(0, 300)
      });
    }

    const detail = backendMessage || err?.message || 'Failed to fetch S/4 metadata';
    const suffix = correlationId ? ` (correlationId: ${correlationId})` : '';
    req.reject(502, `S/4 metadata request failed (upstream ${status}): ${detail}${suffix}`);
  }
}

module.exports = { fetchS4Metadata };
