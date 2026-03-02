const cds = require('@sap/cds');
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
  VH_CustomerGen:  {
    servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS',
    entitySet: 'I_BusinessPartner',
    keyField: 'Kunnr',
    fieldCode: 'KNA1.KUNNR',
    filterMode: 'local',
    searchFields: ['Kunnr', 'Name1']
  },
  VH_CustomerClassification: { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS', entitySet: 'I_CustomerClassification', keyField: 'CustomerClassification', searchFields: ['CustomerClassification', 'CustomerClassification_Text'], filterMode: 'local' },
  VH_CustomerOrgV: { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS', entitySet: 'I_SalesOrganization', syntheticKey: true, keyParts: ['Vkorg'], fieldCode: 'KNVV.VKORG' },
  VH_CustomerVtweg: { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS', entitySet: 'I_DistributionChainCountry', syntheticKey: true, keyParts: ['Vkorg', 'Vtweg'], fieldCode: 'KNVV.VTWEG' },
  VH_CustomerSpart: { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS', entitySet: 'I_Division', syntheticKey: true, keyParts: ['Spart'], fieldCode: 'KNVV.SPART' },
  VH_CustomerSoc:  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_SOC_CDS',  entitySet: 'I_CompanyCode', syntheticKey: true, keyParts: ['Bukrs', 'Maber'] },
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

function mapCustomerGenRows(rows) {
  return (rows || []).map((row) => {
    const kunnr = String(
      row?.Kunnr ??
      row?.BusinessPartner ??
      row?.Partner ??
      ''
    ).trim();
    const name1 = String(
      row?.Name1 ??
      row?.BusinessPartnerName ??
      row?.OrganizationBPName1 ??
      ''
    ).trim();
    const partner = String(row?.Partner ?? row?.BusinessPartner ?? kunnr).trim();
    return {
      Kunnr: kunnr,
      Partner: partner,
      Name1: name1
    };
  }).filter((row) => row.Kunnr);
}

function _translateCustomerGenFilterToRemote(filterExpr) {
  const src = String(filterExpr || '').trim();
  if (!src) return '';
  return src
    .replace(/\bKunnr\b/g, 'BusinessPartner')
    .replace(/\bPartner\b/g, 'BusinessPartner')
    .replace(/\bName1\b/g, 'BusinessPartnerName');
}

function _translateCustomerGenSelectToRemote(selectExpr) {
  const parts = String(selectExpr || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!parts.length) return undefined;

  const mapped = parts.map((p) => {
    if (p === 'Kunnr' || p === 'Partner') return 'BusinessPartner';
    if (p === 'Name1') return 'BusinessPartnerName';
    return p;
  });
  return Array.from(new Set(mapped)).join(',');
}

async function _fetchCustomerGenLocalWindow({ cfg, baseRemoteQuery, localFilter, localSearch, localTop, localSkip }) {
  const target = Math.max(Number(localSkip || 0), 0) + Math.max(Number(localTop || 0), 0);
  const batchSize = 500;
  const maxScan = 50000;
  let scanned = 0;
  let offset = 0;
  let aggregated = [];

  while (aggregated.length < target && scanned < maxScan) {
    const q = { ...baseRemoteQuery, $top: batchSize, $skip: offset };
    const remoteRows = await s4Get({ servicePath: cfg.servicePath, entitySet: cfg.entitySet, query: q });
    if (!remoteRows.length) break;

    let rows = mapCustomerGenRows(remoteRows);
    if (localFilter) rows = applyLocalFilter(rows, localFilter);
    if (localSearch) rows = applyLocalSearch(rows, localSearch, cfg.searchFields || ['Kunnr', 'Name1']);
    aggregated = aggregated.concat(rows);

    scanned += remoteRows.length;
    offset += remoteRows.length;
    if (remoteRows.length < batchSize) break;
  }

  if (scanned >= maxScan) {
    console.warn(`[VH_CustomerGen] local fallback reached scan cap ${maxScan}`);
  }
  return applyLocalPaging(aggregated, localTop, localSkip);
}

function _extractEqValue(filterExpr, fieldName) {
  const f = String(filterExpr || '');
  const re = new RegExp(`${fieldName}\\s+eq\\s+'((?:''|[^'])*)'`, 'i');
  const m = f.match(re);
  if (!m) return null;
  return String(m[1]).replace(/''/g, "'");
}

function _escapeODataLiteral(value) {
  return String(value ?? '').replace(/'/g, "''");
}

function _getContextInput(req, q) {
  const payloadContext = req?.data?.context;
  const queryContext =
    q?.context ??
    req?._?.query?.context ??
    req?._?.req?.query?.context ??
    req?.req?.query?.context;
  const raw = payloadContext ?? queryContext;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return {};
  }
}

function _getRequestIdInput(req, q) {
  return String(
    req?.data?.requestId ??
    req?.data?.REQUEST_ID ??
    q?.requestId ??
    q?.REQUEST_ID ??
    req?._?.query?.requestId ??
    req?._?.query?.REQUEST_ID ??
    req?._?.req?.query?.requestId ??
    req?._?.req?.query?.REQUEST_ID ??
    req?.req?.query?.requestId ??
    req?.req?.query?.REQUEST_ID ??
    ''
  ).trim();
}

function _getFieldCodeInput(req, q) {
  return String(
    req?.data?.fieldCode ??
    req?.data?.FIELD_CODE ??
    q?.fieldCode ??
    q?.FIELD_CODE ??
    req?._?.query?.fieldCode ??
    req?._?.query?.FIELD_CODE ??
    req?._?.req?.query?.fieldCode ??
    req?._?.req?.query?.FIELD_CODE ??
    req?.req?.query?.fieldCode ??
    req?.req?.query?.FIELD_CODE ??
    ''
  ).trim();
}

async function _getVhFieldCodes(tx, vhName) {
  if (!vhName) return [];
  const rows = await tx.run(
    `SELECT "FIELD_CODE"
       FROM "MDG_FIELD_CATALOG"
      WHERE "VH_SERVICE" = 'CAP'
        AND "VH_ENTITYSET" = ?`,
    [vhName]
  );
  return (rows || [])
    .map((row) => String(row.FIELD_CODE || '').trim())
    .filter(Boolean);
}

async function _loadVhDependencies(tx, fieldCode) {
  if (!fieldCode) return [];
  try {
    return await tx.run(
      `SELECT
          "FIELD_CODE",
          "DEPENDS_ON_FIELD_CODE",
          "VH_PROPERTY_NAME",
          "REQUIRED",
          "EVALUATION_ORDER",
          "IS_ACTIVE"
         FROM "MDG_FIELD_VH_DEPENDENCY"
        WHERE "FIELD_CODE" = ?
          AND "IS_ACTIVE" = true
        ORDER BY "EVALUATION_ORDER" ASC`,
      [fieldCode]
    );
  } catch (_) {
    // Backward compatible path if dependency table not present in a landscape.
    return [];
  }
}

async function _readRequestValueByFieldCode(tx, requestId, fieldCode) {
  if (!requestId || !fieldCode) return null;
  const rows = await tx.run(
    `SELECT rv."VALUE" AS "VALUE"
       FROM "MDG_REQUEST_FIELD_VALUE" rv
       JOIN "MDG_FIELD_CATALOG" fc
         ON fc."ID" = rv."FIELD_ID"
      WHERE rv."REQUEST_ID" = ?
        AND fc."FIELD_CODE" = ?
      ORDER BY rv."LINE_NO" ASC
      LIMIT 1`,
    [requestId, fieldCode]
  );
  const value = rows?.[0]?.VALUE;
  return value === undefined || value === null ? null : String(value).trim();
}

async function _resolveDependencyValue(tx, req, q, dep, contextMap, requestId) {
  const depFieldCode = String(dep?.DEPENDS_ON_FIELD_CODE || '').trim();
  if (!depFieldCode) return null;

  const fromContext = contextMap?.[depFieldCode];
  if (fromContext !== undefined && fromContext !== null && String(fromContext).trim() !== '') {
    return String(fromContext).trim();
  }

  const depSimple = depFieldCode.split('.').pop();
  const fromSimpleContext = contextMap?.[depSimple];
  if (fromSimpleContext !== undefined && fromSimpleContext !== null && String(fromSimpleContext).trim() !== '') {
    return String(fromSimpleContext).trim();
  }

  const fromRequest = await _readRequestValueByFieldCode(tx, requestId, depFieldCode);
  if (fromRequest) return fromRequest;

  const vhPropertyName = String(dep?.VH_PROPERTY_NAME || '').trim();
  if (vhPropertyName) {
    const fromQueryFilter = _extractEqValue(q?.$filter, vhPropertyName);
    if (fromQueryFilter) return fromQueryFilter;
  }

  return null;
}

async function _applyDependencyFilters(tx, req, vhName, fieldCode, q, remoteQ) {
  const effectiveFieldCode = String(fieldCode || '').trim();
  if (!effectiveFieldCode) return { missingRequired: false, dependencies: [] };

  const deps = await _loadVhDependencies(tx, effectiveFieldCode);
  if (!deps.length) return { missingRequired: false, dependencies: [] };

  const contextMap = _getContextInput(req, q);
  const requestId = _getRequestIdInput(req, q);
  const depFilters = [];
  const unresolvedRequired = [];

  for (const dep of deps) {
    const value = await _resolveDependencyValue(tx, req, q, dep, contextMap, requestId);
    const vhPropertyName = String(dep?.VH_PROPERTY_NAME || '').trim();
    const isRequired = dep?.REQUIRED === true || String(dep?.REQUIRED).toLowerCase() === 'true' || dep?.REQUIRED === 1;

    if (!value) {
      if (isRequired) unresolvedRequired.push(String(dep?.DEPENDS_ON_FIELD_CODE || '').trim() || vhPropertyName || '?');
      continue;
    }
    if (!vhPropertyName) continue;

    depFilters.push(`${vhPropertyName} eq '${_escapeODataLiteral(value)}'`);
  }

  if (depFilters.length) {
    remoteQ.$filter = remoteQ.$filter ? `(${remoteQ.$filter}) and (${depFilters.join(' and ')})` : depFilters.join(' and ');
  }

  if (unresolvedRequired.length) {
    console.warn(`[VH_DEP_MISSING] ${vhName} fieldCode=${effectiveFieldCode} missing=${unresolvedRequired.join(',')}`);
    return { missingRequired: true, dependencies: deps };
  }
  return { missingRequired: false, dependencies: deps };
}

function mapCustomerOrgVRows(rows) {
  return (rows || []).map((row) => ({
    Kunnr: '',
    Vkorg: String(row?.Vkorg ?? row?.SalesOrganization ?? '').trim(),
    VkorgText: String(row?.VkorgText ?? row?.SalesOrganizationName ?? row?.SalesOrganizationText ?? '').trim(),
    Vtweg: '',
    VtwegText: '',
    Spart: '',
    SpartText: ''
  })).filter((row) => row.Vkorg);
}

function mapCustomerVtwegRows(rows) {
  return (rows || []).map((row) => ({
    Vkorg: String(row?.Vkorg ?? row?.ProductSalesOrg ?? '').trim(),
    VkorgText: String(row?.VkorgText ?? row?.SalesOrganizationName ?? '').trim(),
    Vtweg: String(row?.Vtweg ?? row?.ProductDistributionChnl ?? '').trim(),
    VtwegText: String(row?.VtwegText ?? row?.DistributionChannelName ?? row?.DistributionChannelText ?? '').trim()
  })).filter((row) => row.Vkorg && row.Vtweg);
}

function mapCustomerSpartRows(rows) {
  return (rows || []).map((row) => ({
    Spart: String(row?.Spart ?? row?.Division ?? '').trim(),
    SpartText: String(row?.SpartText ?? row?.DivisionName ?? row?.DivisionText ?? '').trim()
  })).filter((row) => row.Spart);
}

function _toCsvSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  );
}

function getCustomerSocMode(q) {
  const selectSet = _toCsvSet(q?.$select);
  const filter = String(q?.$filter || '').toLowerCase();
  const bySelectMaber = selectSet.has('Maber') || selectSet.has('MaberText');
  if (bySelectMaber || filter.includes('maber') || filter.includes('dunningarea')) return 'DUNNING_AREA';
  return 'COMPANY_CODE';
}

function mapCustomerSocRows(rows, mode) {
  if (mode === 'DUNNING_AREA') {
    return (rows || []).map((row) => ({
      Kunnr: '',
      Bukrs: '',
      BukrsText: '',
      Maber: String(row?.Maber ?? row?.DunningArea ?? '').trim(),
      MaberText: String(row?.MaberText ?? row?.DunningAreaName ?? row?.DunningAreaText ?? '').trim()
    })).filter((row) => row.Maber);
  }
  return (rows || []).map((row) => ({
    Kunnr: '',
    Bukrs: String(row?.Bukrs ?? row?.CompanyCode ?? '').trim(),
    BukrsText: String(row?.BukrsText ?? row?.CompanyCodeName ?? row?.CompanyCodeText ?? '').trim(),
    Maber: '',
    MaberText: ''
  })).filter((row) => row.Bukrs);
}

async function readCustomerOrgV(req) {
  const cfg = VH_MAP.VH_CustomerOrgV;
  const tx = cds.tx(req);
  const q = pickODataOptions(getQueryOptions(req));
  if (q.$top === undefined) q.$top = 50;

  const localFilter = q.$filter;
  const localSearch = q.$search ?? q.search ?? q.q;
  const localTop = q.$top;
  const localSkip = q.$skip;
  const remoteQ = { ...q };
  delete remoteQ.$filter;
  const depFieldCode = _getFieldCodeInput(req, q) || cfg.fieldCode;
  const depState = await _applyDependencyFilters(tx, req, 'VH_CustomerOrgV', depFieldCode, q, remoteQ);
  if (depState.missingRequired) return [];
  if (localFilter || localSearch) {
    delete remoteQ.$top;
    delete remoteQ.$skip;
    delete remoteQ.$search;
    delete remoteQ.search;
    delete remoteQ.q;
  }

  let rows = await s4Get({ servicePath: cfg.servicePath, entitySet: cfg.entitySet, query: remoteQ });
  rows = mapCustomerOrgVRows(rows);

  if (localFilter) rows = applyLocalFilter(rows, localFilter);
  if (localSearch) rows = applyLocalSearch(rows, localSearch, ['Vkorg', 'VkorgText']);
  if (localFilter || localSearch) rows = applyLocalPaging(rows, localTop, localSkip);

  const withId = rows.map((row, idx) => ({ ...row, ID: toSyntheticId(row, cfg.keyParts, idx) }));
  return dedupeRows(withId, (row) => String(row?.ID || '').trim() || null);
}

async function readCustomerGen(req) {
  const cfg = VH_MAP.VH_CustomerGen;
  const tx = cds.tx(req);
  const q = pickODataOptions(getQueryOptions(req));
  if (q.$top === undefined) q.$top = 50;

  const localFilter = q.$filter;
  const localSearch = q.$search ?? q.search ?? q.q;
  const localTop = q.$top;
  const localSkip = q.$skip;
  const remoteQ = { ...q };

  // $search from UI is applied in CAP as local fallback for cross-backend compatibility.
  delete remoteQ.$search;
  delete remoteQ.search;
  delete remoteQ.q;

  const depFieldCode = _getFieldCodeInput(req, q) || cfg.fieldCode;
  const depState = await _applyDependencyFilters(tx, req, 'VH_CustomerGen', depFieldCode, q, remoteQ);
  if (depState.missingRequired) return [];

  const depFilterOnly = remoteQ.$filter ? String(remoteQ.$filter) : '';
  const translatedFilter = _translateCustomerGenFilterToRemote(localFilter);
  if (localFilter) {
    remoteQ.$filter = depFilterOnly
      ? `(${depFilterOnly}) and (${translatedFilter})`
      : translatedFilter;
  }

  const translatedSelect = _translateCustomerGenSelectToRemote(q.$select);
  if (translatedSelect) remoteQ.$select = translatedSelect;

  let rows;
  try {
    rows = await s4Get({ servicePath: cfg.servicePath, entitySet: cfg.entitySet, query: remoteQ });
    rows = mapCustomerGenRows(rows);
    if (localSearch) rows = applyLocalSearch(rows, localSearch, cfg.searchFields || ['Kunnr', 'Name1']);
    return dedupeRows(rows, (row) => String(row?.[cfg.keyField] ?? '').trim() || null);
  } catch (err) {
    // If backend rejects translated expression/select, fallback to local filtering in paged blocks.
    const fallbackBase = { ...remoteQ };
    if (localFilter) fallbackBase.$filter = depFilterOnly || undefined;
    delete fallbackBase.$select;
    delete fallbackBase.$top;
    delete fallbackBase.$skip;

    const localWindow = await _fetchCustomerGenLocalWindow({
      cfg,
      baseRemoteQuery: fallbackBase,
      localFilter,
      localSearch,
      localTop,
      localSkip
    });
    return dedupeRows(localWindow, (row) => String(row?.[cfg.keyField] ?? '').trim() || null);
  }
}

async function readCustomerVtweg(req) {
  const cfg = VH_MAP.VH_CustomerVtweg;
  const tx = cds.tx(req);
  const q = pickODataOptions(getQueryOptions(req));
  if (q.$top === undefined) q.$top = 50;

  const localFilter = q.$filter;
  const localSearch = q.$search ?? q.search ?? q.q;
  const localTop = q.$top;
  const localSkip = q.$skip;
  const remoteQ = { ...q };
  delete remoteQ.$filter;
  const depFieldCode = _getFieldCodeInput(req, q) || cfg.fieldCode;
  const depState = await _applyDependencyFilters(tx, req, 'VH_CustomerVtweg', depFieldCode, q, remoteQ);
  if (depState.missingRequired) return [];
  if (!remoteQ.$filter) {
    const depVkorg = _extractEqValue(localFilter, 'Vkorg');
    if (depVkorg) {
      remoteQ.$filter = `ProductSalesOrg eq '${_escapeODataLiteral(depVkorg)}'`;
    }
  }
  if (localFilter || localSearch) {
    delete remoteQ.$top;
    delete remoteQ.$skip;
    delete remoteQ.$search;
    delete remoteQ.search;
    delete remoteQ.q;
  }

  let rows = await s4Get({ servicePath: cfg.servicePath, entitySet: cfg.entitySet, query: remoteQ });
  rows = mapCustomerVtwegRows(rows);

  if (localFilter) rows = applyLocalFilter(rows, localFilter);
  if (localSearch) rows = applyLocalSearch(rows, localSearch, ['Vkorg', 'VkorgText', 'Vtweg', 'VtwegText']);
  if (localFilter || localSearch) rows = applyLocalPaging(rows, localTop, localSkip);

  const withId = rows.map((row, idx) => ({ ...row, ID: toSyntheticId(row, cfg.keyParts, idx) }));
  return dedupeRows(withId, (row) => String(row?.ID || '').trim() || null);
}

async function readCustomerSpart(req) {
  const cfg = VH_MAP.VH_CustomerSpart;
  const tx = cds.tx(req);
  const q = pickODataOptions(getQueryOptions(req));
  if (q.$top === undefined) q.$top = 50;

  const localFilter = q.$filter;
  const localSearch = q.$search ?? q.search ?? q.q;
  const localTop = q.$top;
  const localSkip = q.$skip;
  const remoteQ = { ...q };
  delete remoteQ.$filter;
  const depFieldCode = _getFieldCodeInput(req, q) || cfg.fieldCode;
  const depState = await _applyDependencyFilters(tx, req, 'VH_CustomerSpart', depFieldCode, q, remoteQ);
  if (depState.missingRequired) return [];
  if (localFilter || localSearch) {
    delete remoteQ.$top;
    delete remoteQ.$skip;
    delete remoteQ.$search;
    delete remoteQ.search;
    delete remoteQ.q;
  }

  let rows = await s4Get({ servicePath: cfg.servicePath, entitySet: cfg.entitySet, query: remoteQ });
  rows = mapCustomerSpartRows(rows);

  if (localFilter) rows = applyLocalFilter(rows, localFilter);
  if (localSearch) rows = applyLocalSearch(rows, localSearch, ['Spart', 'SpartText']);
  if (localFilter || localSearch) rows = applyLocalPaging(rows, localTop, localSkip);

  const withId = rows.map((row, idx) => ({ ...row, ID: toSyntheticId(row, cfg.keyParts, idx) }));
  return dedupeRows(withId, (row) => String(row?.ID || '').trim() || null);
}

async function readCustomerSoc(req) {
  const cfg = VH_MAP.VH_CustomerSoc;
  const tx = cds.tx(req);
  const q = pickODataOptions(getQueryOptions(req));
  if (q.$top === undefined) q.$top = 50;

  const mode = getCustomerSocMode(q);
  const localFilter = q.$filter;
  const localSearch = q.$search ?? q.search ?? q.q;
  const localTop = q.$top;
  const localSkip = q.$skip;
  const remoteQ = { ...q };

  let entitySet = 'I_CompanyCode';
  let depFieldCode = 'KNB1.BUKRS';
  let searchFields = ['Bukrs', 'BukrsText'];
  if (mode === 'DUNNING_AREA') {
    entitySet = 'I_DunningAreaStdVH';
    depFieldCode = 'KNB1.MABER';
    searchFields = ['Maber', 'MaberText'];
  }

  delete remoteQ.$filter;
  const effectiveDepFieldCode = _getFieldCodeInput(req, q) || depFieldCode;
  const depState = await _applyDependencyFilters(tx, req, 'VH_CustomerSoc', effectiveDepFieldCode, q, remoteQ);
  if (depState.missingRequired) return [];
  if (localFilter || localSearch) {
    delete remoteQ.$top;
    delete remoteQ.$skip;
    delete remoteQ.$search;
    delete remoteQ.search;
    delete remoteQ.q;
  }

  let rows = await s4Get({ servicePath: cfg.servicePath, entitySet, query: remoteQ });
  rows = mapCustomerSocRows(rows, mode);

  if (localFilter) rows = applyLocalFilter(rows, localFilter);
  if (localSearch) rows = applyLocalSearch(rows, localSearch, searchFields);
  if (localFilter || localSearch) rows = applyLocalPaging(rows, localTop, localSkip);

  const withId = rows.map((row, idx) => ({ ...row, ID: toSyntheticId(row, cfg.keyParts, idx) }));
  return dedupeRows(withId, (row) => String(row?.ID || '').trim() || null);
}

function applyLocalSearch(rows, searchText, fields = []) {
  const term = String(searchText ?? '').trim().replace(/^"(.*)"$/, '$1').toLowerCase();
  if (!term) return rows;
  if (!Array.isArray(fields) || !fields.length) return rows;
  return (rows || []).filter((row) =>
    fields.some((f) => String(row?.[f] ?? '').toLowerCase().includes(term))
  );
}

function shouldForceLocalFilterVerification(filterExpr) {
  const f = String(filterExpr || '').trim().toLowerCase();
  if (!f) return false;
  return f.includes('substringof(') || f.includes('contains(');
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
  const tx = cds.tx(req);

  const q = pickODataOptions(getQueryOptions(req));

  // Guardrails: limit default top to avoid huge calls
  if (q.$top === undefined) q.$top = 50;

  // Keep an optional local fallback for $filter (some S/4 views ignore substringof/contains).
  const localFilter = q.$filter;
  const localSearch = q.$search ?? q.search ?? q.q;
  const localTop = q.$top;
  const localSkip = q.$skip;
  const filterMode = cfg.filterMode || 'auto'; // auto=remote first, fallback local on known filter errors
  const enforceLocalFilter = Boolean(localFilter) && (
    filterMode === 'local' ||
    (filterMode === 'auto' && shouldForceLocalFilterVerification(localFilter))
  );
  const remoteQ = { ...q };
  let forceLocalFilter = false;
  let fieldCode = _getFieldCodeInput(req, q) || String(cfg.fieldCode || '').trim();
  if (!fieldCode) {
    const fieldCodes = await _getVhFieldCodes(tx, vhName);
    if (fieldCodes.length === 1) fieldCode = fieldCodes[0];
  }

  if (localFilter && filterMode === 'local') {
    delete remoteQ.$filter;
    forceLocalFilter = true;
  }
  if (localFilter && filterMode === 'auto' && enforceLocalFilter) {
    // Avoid sending UI-local field names (e.g. Kunnr/Name1) to remote sets
    // that expose different canonical properties (e.g. BusinessPartner).
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
  if (forceLocalFilter || enforceLocalFilter) {
    delete remoteQ.$top;
    delete remoteQ.$skip;
  }
  if (vhName === 'VH_CustomerGen') {
    // Local contract fields (Kunnr/Name1) are not S/4 canonical names in I_BusinessPartner.
    delete remoteQ.$select;
  }

  const depState = await _applyDependencyFilters(tx, req, vhName, fieldCode, q, remoteQ);
  if (depState.missingRequired) return [];

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

  if (vhName === 'VH_CustomerGen') {
    rows = mapCustomerGenRows(rows);
  }

  if (localFilter && (forceLocalFilter || enforceLocalFilter)) {
    rows = applyLocalFilter(rows, localFilter);
  }
  if (localSearch && cfg.searchFields) {
    rows = applyLocalSearch(rows, localSearch, cfg.searchFields);
  }
  if ((localFilter && (forceLocalFilter || enforceLocalFilter)) || (localSearch && cfg.searchFields)) {
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
  readCustomerGen,
  readCustomerClassification: (req) => readVH(req, 'VH_CustomerClassification'),
  readCustomerOrgV,
  readCustomerVtweg,
  readCustomerSpart,
  readCustomerSoc,
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
