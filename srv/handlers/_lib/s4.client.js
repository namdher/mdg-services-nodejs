const cds = require('@sap/cds');
const { encodeQuery } = require('./odata.util');

async function s4Get({ servicePath, entitySet, query = {} }) {
  const s4 = await cds.connect.to('S4H'); // requires S4H in package.json cds.requires
  const path = `${servicePath.replace(/\/$/, '')}/${entitySet}${encodeQuery(query)}`;
  const res = await s4.send({ method: 'GET', path });

  // Normalize OData V2 response
  if (res?.d?.results) return res.d.results;
  if (res?.d) return [res.d];
  // Fallback
  if (Array.isArray(res?.value)) return res.value;
  if (Array.isArray(res)) return res;
  return res ? [res] : [];
}

module.exports = { s4Get };
