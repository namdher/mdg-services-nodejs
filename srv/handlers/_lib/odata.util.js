function getQueryOptions(req) {
  // CAP: req._.query has odata options, fallback to express query
  return req._?.query || req._?.req?.query || {};
}

function pickODataOptions(q) {
  const allowed = ['$top','$skip','$select','$filter','$search','$orderby','$expand'];
  const out = {};
  for (const k of allowed) if (q[k] !== undefined) out[k] = q[k];
  return out;
}

function encodeQuery(q) {
  const parts = [];
  for (const [k, v] of Object.entries(q || {})) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

module.exports = { getQueryOptions, pickODataOptions, encodeQuery };
