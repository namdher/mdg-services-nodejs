const { s4Get } = require('./_lib/s4.client');
const { getQueryOptions, pickODataOptions, applyLocalFilter, applyLocalPaging } = require('./_lib/odata.util');

/*
  Driver VH mapping (CAP -> S/4):
  VH_DriverGen -> ZCDS_CONDUCTORES_GEN_CDS / zcds_conductores_gen
  VH_DriverRol -> ZCDS_CONDUCTORES_ROL_CDS / zcds_conductores_rol
  VH_DriverCom -> ZCDS_CONDUCTORES_COM_CDS / zcds_conductores_com
  VH_DriverImp -> ZCDS_CONDUCTORES_IMP_CDS / zcds_conductores_imp
  VH_DriverNif -> ZCDS_CONDUCTORES_NIF_CDS / zcds_conductores_nif
  VH_DriverAdi -> ZCDS_CONDUCTORES_ADI_CDS / zcds_conductores_adi

  Billing/Shipping/Resources VH mapping (CAP -> S/4):
  VH_BillToGen -> ZCDS_DESTFACT_GEN_CDS / zcds_destfact_gen
  VH_BillToCom -> ZCDS_DESTFACT_COM_CDS / zcds_destfact_com
  VH_BillToImp -> ZCDS_DESTFACT_IMP_CDS / zcds_destfact_imp
  VH_ShipToGen -> ZCDS_DESTMERC_GEN_CDS / zcds_destmerc_gen
  VH_ShipToCom -> ZCDS_DESTMERC_COM_CDS / zcds_destmerc_com
  VH_Resources -> ZCDS_RECURSOS_CDS / zcds_recursos
*/

// Stable mapping of CAP VH_* entitysets -> S/4 OData services/entity sets
const VH_MAP = {
  VH_CustomerGen:  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS',  entitySet: 'zcds_clientes_gen', keyField: 'Kunnr' },
  VH_CustomerClassification: { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS', entitySet: 'I_CustomerClassification', keyField: 'CustomerClassification', searchFields: ['CustomerClassification', 'CustomerClassification_Text'], filterMode: 'local' },
  VH_CustomerOrgV: { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS', entitySet: 'zcds_clientes_orgv', syntheticKey: true, keyParts: ['Kunnr', 'Vkorg', 'Vtweg', 'Spart'] },
  VH_CustomerSoc:  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_SOC_CDS',  entitySet: 'zcds_clientes_soc', syntheticKey: true, keyParts: ['Kunnr', 'Bukrs', 'Maber'] },
  VH_CustomerCom:  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_COM_CDS',  entitySet: 'ZCDS_CLIENTES_COM', syntheticKey: true, keyParts: ['Kunnr', 'Parnr'] },
  VH_CustomerEmp:  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_EMP_CDS',  entitySet: 'zcds_clientes_emp', syntheticKey: true, keyParts: ['Kunnr', 'Bukrs', 'Ekorg', 'Vkorg'] },
  VH_CustomerBan:  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_BAN_CDS',  entitySet: 'zcds_clientes_ban', syntheticKey: true, keyParts: ['Kunnr', 'Banks', 'Bankl', 'Bankn'] },
  VH_CustomerImp:  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_IMP_CDS',  entitySet: 'zcds_clientes_Imp', syntheticKey: true, keyParts: ['Kunnr', 'Aland', 'Tatyp'] },
  VH_CustomerNif:  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_NIF_CDS',  entitySet: 'zcds_clientes_nif', syntheticKey: true, keyParts: ['Kunnr', 'Taxtype'] },
  VH_DriverGen:    { servicePath: '/sap/opu/odata/sap/ZCDS_CONDUCTORES_GEN_CDS', entitySet: 'zcds_conductores_gen', keyField: 'Kunnr' },
  VH_DriverRol:    { servicePath: '/sap/opu/odata/sap/ZCDS_CONDUCTORES_ROL_CDS', entitySet: 'zcds_conductores_rol', syntheticKey: true, keyParts: ['Kunnr', 'Bp_Role', 'Dfval'] },
  VH_DriverCom:    { servicePath: '/sap/opu/odata/sap/ZCDS_CONDUCTORES_COM_CDS', entitySet: 'zcds_conductores_com', syntheticKey: true, keyParts: ['Kunnr', 'Vkorg', 'Vtweg', 'Spart'] },
  VH_DriverImp:    { servicePath: '/sap/opu/odata/sap/ZCDS_CONDUCTORES_IMP_CDS', entitySet: 'zcds_conductores_imp', syntheticKey: true, keyParts: ['Kunnr', 'Aland', 'Tatyp'] },
  VH_DriverNif:    { servicePath: '/sap/opu/odata/sap/ZCDS_CONDUCTORES_NIF_CDS', entitySet: 'zcds_conductores_nif', syntheticKey: true, keyParts: ['Kunnr', 'Taxtype'] },
  VH_DriverAdi:    { servicePath: '/sap/opu/odata/sap/ZCDS_CONDUCTORES_ADI_CDS', entitySet: 'zcds_conductores_adi', keyField: 'Kunnr' },
  VH_BillToGen:    { servicePath: '/sap/opu/odata/sap/ZCDS_DESTFACT_GEN_CDS', entitySet: 'zcds_destfact_gen', keyField: 'Kunnr' },
  VH_BillToCom:    { servicePath: '/sap/opu/odata/sap/ZCDS_DESTFACT_COM_CDS', entitySet: 'zcds_destfact_com', syntheticKey: true, keyParts: ['Kunnr', 'Vkorg', 'Vtweg', 'Spart'] },
  VH_BillToImp:    { servicePath: '/sap/opu/odata/sap/ZCDS_DESTFACT_IMP_CDS', entitySet: 'zcds_destfact_imp', syntheticKey: true, keyParts: ['Kunnr', 'Aland', 'Tatyp'] },
  VH_ShipToGen:    { servicePath: '/sap/opu/odata/sap/ZCDS_DESTMERC_GEN_CDS', entitySet: 'zcds_destmerc_gen', keyField: 'Kunnr' },
  VH_ShipToCom:    { servicePath: '/sap/opu/odata/sap/ZCDS_DESTMERC_COM_CDS', entitySet: 'zcds_destmerc_com', syntheticKey: true, keyParts: ['Kunnr', 'Vkorg', 'Vtweg', 'Spart'] },
  VH_Resources:    { servicePath: '/sap/opu/odata/sap/ZCDS_RECURSOS_CDS', entitySet: 'zcds_recursos', syntheticKey: true, keyParts: ['Resuid', 'Simversid', 'Simsessid'] }
};

function toSyntheticId(row, keyParts = [], idx = 0) {
  const raw = keyParts.map((k) => String(row?.[k] ?? '').trim()).join('|') || String(idx + 1);
  return String(raw).slice(0, 200);
}

function dedupeRows(rows, identityFn) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const key = identityFn(row);
    if (!key) {
      out.push(row);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function applyLocalSearch(rows, searchText, fields = []) {
  const term = String(searchText ?? '').trim().replace(/^"(.*)"$/, '$1').toLowerCase();
  if (!term) return rows;
  if (!Array.isArray(fields) || !fields.length) return rows;
  return (rows || []).filter((row) =>
    fields.some((f) => String(row?.[f] ?? '').toLowerCase().includes(term))
  );
}

function isFilterUnsupportedError(err) {
  const msg = String(err?.message || '').toLowerCase();
  const payload = (() => {
    try {
      return JSON.stringify(err).toLowerCase();
    } catch (_) {
      return '';
    }
  })();
  const text = `${msg} ${payload}`;
  return (
    text.includes('property contains not found') ||
    text.includes('property substringof not found') ||
    text.includes('invalid filter') ||
    text.includes('function contains') ||
    text.includes('function substringof')
  );
}

async function readVH(req, vhName) {
  const cfg = VH_MAP[vhName];
  if (!cfg) req.reject(500, `VH mapping not found for ${vhName}`);

  const q = pickODataOptions(getQueryOptions(req));

  // Guardrails: limit default top to avoid huge calls
  if (q.$top === undefined) q.$top = 50;

  // Keep an optional local fallback for $filter (some S/4 views ignore substringof/contains).
  const localFilter = q.$filter;
  const localSearch = q.$search ?? q.search ?? q.q;
  const localTop = q.$top;
  const localSkip = q.$skip;
  const filterMode = cfg.filterMode || 'auto'; // auto=remote first, fallback local on known filter errors
  const remoteQ = { ...q };
  let forceLocalFilter = false;

  if (localFilter && filterMode === 'local') {
    delete remoteQ.$filter;
    forceLocalFilter = true;
  }
  if (localSearch && cfg.searchFields) {
    delete remoteQ.$top;
    delete remoteQ.$skip;
    delete remoteQ.$search;
    delete remoteQ.search;
    delete remoteQ.q;
  }
  if (forceLocalFilter) {
    delete remoteQ.$top;
    delete remoteQ.$skip;
  }

  let rows;
  try {
    rows = await s4Get({ servicePath: cfg.servicePath, entitySet: cfg.entitySet, query: remoteQ });
  } catch (err) {
    if (localFilter && filterMode === 'auto' && isFilterUnsupportedError(err)) {
      const retryQ = { ...q };
      delete retryQ.$filter;
      delete retryQ.$top;
      delete retryQ.$skip;
      rows = await s4Get({ servicePath: cfg.servicePath, entitySet: cfg.entitySet, query: retryQ });
      forceLocalFilter = true;
    } else {
      throw err;
    }
  }

  if (localFilter && forceLocalFilter) {
    rows = applyLocalFilter(rows, localFilter);
  }
  if (localSearch && cfg.searchFields) {
    rows = applyLocalSearch(rows, localSearch, cfg.searchFields);
  }
  if ((localFilter && forceLocalFilter) || (localSearch && cfg.searchFields)) {
    rows = applyLocalPaging(rows, localTop, localSkip);
  }

  if (cfg.syntheticKey) {
    const withId = rows.map((row, idx) => ({ ...row, ID: toSyntheticId(row, cfg.keyParts, idx) }));
    return dedupeRows(withId, (row) => String(row?.ID || '').trim() || null);
  }
  if (cfg.keyField) {
    return dedupeRows(rows, (row) => String(row?.[cfg.keyField] ?? '').trim() || null);
  }
  return dedupeRows(rows, (row) => JSON.stringify(row));
}

module.exports = {
  readCustomerGen:  (req) => readVH(req, 'VH_CustomerGen'),
  readCustomerClassification: (req) => readVH(req, 'VH_CustomerClassification'),
  readCustomerOrgV: (req) => readVH(req, 'VH_CustomerOrgV'),
  readCustomerSoc:  (req) => readVH(req, 'VH_CustomerSoc'),
  readCustomerCom:  (req) => readVH(req, 'VH_CustomerCom'),
  readCustomerEmp:  (req) => readVH(req, 'VH_CustomerEmp'),
  readCustomerBan:  (req) => readVH(req, 'VH_CustomerBan'),
  readCustomerImp:  (req) => readVH(req, 'VH_CustomerImp'),
  readCustomerNif:  (req) => readVH(req, 'VH_CustomerNif'),
  readDriverGen:    (req) => readVH(req, 'VH_DriverGen'),
  readDriverRol:    (req) => readVH(req, 'VH_DriverRol'),
  readDriverCom:    (req) => readVH(req, 'VH_DriverCom'),
  readDriverImp:    (req) => readVH(req, 'VH_DriverImp'),
  readDriverNif:    (req) => readVH(req, 'VH_DriverNif'),
  readDriverAdi:    (req) => readVH(req, 'VH_DriverAdi'),
  readBillToGen:    (req) => readVH(req, 'VH_BillToGen'),
  readBillToCom:    (req) => readVH(req, 'VH_BillToCom'),
  readBillToImp:    (req) => readVH(req, 'VH_BillToImp'),
  readShipToGen:    (req) => readVH(req, 'VH_ShipToGen'),
  readShipToCom:    (req) => readVH(req, 'VH_ShipToCom'),
  readResources:    (req) => readVH(req, 'VH_Resources')
};
