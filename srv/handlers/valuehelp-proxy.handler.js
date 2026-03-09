const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { s4Get } = require('./_lib/s4.client');
const { getQueryOptions, pickODataOptions, applyLocalFilter, applyLocalPaging } = require('./_lib/odata.util');

const MAX_VH_CONTEXT_CHARS = Number(process.env.MDG_VH_MAX_CONTEXT_CHARS || 4000);
const S4_DESTINATION_NAME = process.env.MDG_S4_DESTINATION || 'S4H-TECH';
const FAIL_FAST_ON_VH_METADATA = String(process.env.MDG_VH_FAIL_FAST || 'false').toLowerCase() === 'true';

const _metadataEntitySetCache = new Map();
const _vhInvalidMappings = new Map();

function _escapeODataLiteral(value) {
  return String(value ?? '').replace(/'/g, "''");
}

function _isEmptyValue(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function _toCsvArray(value) {
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function _hasFieldCaseInsensitive(row, fieldName) {
  if (!row || !fieldName) return false;
  if (Object.prototype.hasOwnProperty.call(row, fieldName)) return true;
  const lower = String(fieldName).toLowerCase();
  return Object.keys(row).some((k) => String(k).toLowerCase() === lower);
}

function _extractEntitySetNamesFromMetadata(xml) {
  const out = new Set();
  const text = String(xml || '');
  const regex = /<EntitySet[^>]*Name="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match?.[1]) out.add(String(match[1]).trim());
  }
  return out;
}

async function _fetchMetadataEntitySets(servicePath) {
  const normalizedPath = String(servicePath || '').trim().replace(/\/+$/, '');
  const cacheKey = normalizedPath;
  if (_metadataEntitySetCache.has(cacheKey)) return _metadataEntitySetCache.get(cacheKey);

  const url = `${normalizedPath}/$metadata`;
  const response = await executeHttpRequest(
    { destinationName: S4_DESTINATION_NAME },
    {
      method: 'GET',
      url,
      headers: { Accept: 'application/xml, text/xml, application/atom+xml, */*' }
    }
  );

  const xml =
    typeof response?.data === 'string'
      ? response.data
      : Buffer.isBuffer(response?.data)
        ? response.data.toString('utf8')
        : String(response?.data || '');
  const entitySets = _extractEntitySetNamesFromMetadata(xml);
  _metadataEntitySetCache.set(cacheKey, entitySets);
  return entitySets;
}

function _vhConfigError(vhName, reason, details = {}) {
  const error = new Error(`Value help mapping error for ${vhName}: ${reason}`);
  error.statusCode = 500;
  error.code = 'VH_CONFIG_ERROR';
  // cds runtime expects `err.details` to be iterable (array of detail objects).
  const isIterable = details && typeof details !== 'string' && typeof details[Symbol.iterator] === 'function';
  if (Array.isArray(details)) {
    error.details = details;
  } else if (isIterable) {
    error.details = Array.from(details);
  } else if (details && Object.keys(details).length) {
    error.details = [
      {
        code: 'VH_CONFIG_ERROR',
        message: `Value help mapping error for ${vhName}: ${reason}`,
        target: `/${vhName}`,
        ...details
      }
    ];
  } else {
    error.details = [];
  }
  return error;
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
  const rawStr = String(raw);
  if (rawStr.length > MAX_VH_CONTEXT_CHARS) {
    req.reject(
      400,
      `Value help context too large (${rawStr.length} chars). Send only dependency fields in context.`
    );
  }
  try {
    return JSON.parse(rawStr);
  } catch (_) {
    return {};
  }
}

function _findContextEntry(contextMap, key) {
  if (!contextMap || !key) return { found: false, value: null };
  if (Object.prototype.hasOwnProperty.call(contextMap, key)) {
    const raw = contextMap[key];
    if (raw === undefined || raw === null) return { found: true, value: '' };
    return { found: true, value: String(raw).trim() };
  }
  const keyLower = String(key).toLowerCase();
  for (const [ctxKey, ctxValue] of Object.entries(contextMap)) {
    if (String(ctxKey).toLowerCase() !== keyLower) continue;
    if (ctxValue === undefined || ctxValue === null) return { found: true, value: '' };
    return { found: true, value: String(ctxValue).trim() };
  }
  return { found: false, value: null };
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

function _getFieldIdInput(req, q) {
  return String(
    req?.data?.fieldId ??
      req?.data?.FIELD_ID ??
      q?.fieldId ??
      q?.FIELD_ID ??
      req?._?.query?.fieldId ??
      req?._?.query?.FIELD_ID ??
      req?._?.req?.query?.fieldId ??
      req?._?.req?.query?.FIELD_ID ??
      req?.req?.query?.fieldId ??
      req?.req?.query?.FIELD_ID ??
      ''
  ).trim();
}

function _getBlockIdInput(req, q) {
  return String(
    req?.data?.blockId ??
      req?.data?.BLOCK_ID ??
      q?.blockId ??
      q?.BLOCK_ID ??
      req?._?.query?.blockId ??
      req?._?.query?.BLOCK_ID ??
      req?._?.req?.query?.blockId ??
      req?._?.req?.query?.BLOCK_ID ??
      req?.req?.query?.blockId ??
      req?.req?.query?.BLOCK_ID ??
      ''
  ).trim();
}

function _getProcessCodeInput(req, q) {
  const raw = String(
    req?.data?.processCode ??
      req?.data?.PROCESS_CODE ??
      q?.processCode ??
      q?.PROCESS_CODE ??
      req?._?.query?.processCode ??
      req?._?.query?.PROCESS_CODE ??
      req?._?.req?.query?.processCode ??
      req?._?.req?.query?.PROCESS_CODE ??
      req?.req?.query?.processCode ??
      req?.req?.query?.PROCESS_CODE ??
      ''
  ).trim();
  return raw.replace(/^'+|'+$/g, '');
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
  return _isEmptyValue(value) ? null : String(value).trim();
}

function _normalizeCatalogRow(row) {
  if (!row) return null;
  return {
    FIELD_ID: String(row.FIELD_ID ?? row.ID ?? '').trim(),
    FIELD_CODE: String(row.FIELD_CODE || '').trim(),
    VH_ENTITYSET: String(row.VH_ENTITYSET || '').trim(),
    VH_KEY_FIELD: String(row.VH_KEY_FIELD || '').trim(),
    VH_TEXT_FIELD: String(row.VH_TEXT_FIELD || '').trim(),
    VH_SEARCH_FIELDS: String(row.VH_SEARCH_FIELDS || '').trim()
  };
}

function _ensureCatalogRowMatchesRequestedVh(row, vhName, input = {}) {
  const actualVh = String(row?.VH_ENTITYSET || '').trim();
  if (actualVh && actualVh !== vhName) {
    throw _vhConfigError(
      vhName,
      `${input.fieldId ? `fieldId '${input.fieldId}'` : `fieldCode '${input.fieldCode || ''}'`} resolved to vhEntitySet '${actualVh}', expected '${vhName}'`,
      {
        ...input,
        expectedVhEntitySet: vhName,
        actualVhEntitySet: actualVh,
        resolvedFieldId: row?.FIELD_ID || '',
        resolvedFieldCode: row?.FIELD_CODE || ''
      }
    );
  }
}

function _logCatalogResolution(vhName, input = {}, source = '', row = null) {
  console.info(
    `[VH_RESOLVE] vhEntitySet=${vhName} input=${JSON.stringify({
      fieldId: input.fieldId || '',
      fieldCode: input.fieldCode || '',
      requestId: input.requestId || '',
      blockId: input.blockId || '',
      processCode: input.processCode || ''
    })} source=${source} resolved=${JSON.stringify({
      fieldId: row?.FIELD_ID || '',
      fieldCode: row?.FIELD_CODE || '',
      vhEntitySet: row?.VH_ENTITYSET || '',
      vhKeyField: row?.VH_KEY_FIELD || '',
      vhTextField: row?.VH_TEXT_FIELD || ''
    })}`
  );
}

async function _loadCatalogRuntime(tx, vhName, input = {}) {
  const fieldId = String(input.fieldId || '').trim();
  const fieldCode = String(input.fieldCode || '').trim();
  const requestId = String(input.requestId || '').trim();
  const blockId = String(input.blockId || '').trim();
  const processCode = String(input.processCode || '').trim();

  if (fieldId) {
    const byFieldId = await tx.run(
      `SELECT
         "ID"            as "FIELD_ID",
         "FIELD_CODE",
         "VH_ENTITYSET",
         "VH_KEY_FIELD",
         "VH_TEXT_FIELD",
         "VH_SEARCH_FIELDS"
       FROM "MDG_FIELD_CATALOG"
      WHERE "ID" = ?
        AND "VH_SERVICE" = 'CAP'
      LIMIT 1`,
      [fieldId]
    );
    const row = _normalizeCatalogRow(byFieldId?.[0]);
    if (row) {
      _ensureCatalogRowMatchesRequestedVh(row, vhName, input);
      _logCatalogResolution(vhName, input, 'fieldId', row);
      return row;
    }
  }

  if (requestId && fieldCode) {
    let sql =
      `SELECT DISTINCT
         fc."ID"             as "FIELD_ID",
         fc."FIELD_CODE"     as "FIELD_CODE",
         fc."VH_ENTITYSET"   as "VH_ENTITYSET",
         fc."VH_KEY_FIELD"   as "VH_KEY_FIELD",
         fc."VH_TEXT_FIELD"  as "VH_TEXT_FIELD",
         fc."VH_SEARCH_FIELDS" as "VH_SEARCH_FIELDS"
       FROM "MDG_REQUEST_HEADER" rh
       JOIN "MDG_PROCESS_BLOCK" pb
         ON pb."PROCESS_ID" = rh."PROCESS_ID"
       JOIN "MDG_BLOCK_FIELD" bf
         ON bf."BLOCK_ID" = pb."BLOCK_ID"
       JOIN "MDG_FIELD_CATALOG" fc
         ON fc."ID" = bf."FIELD_ID"
      WHERE rh."ID" = ?
        AND fc."FIELD_CODE" = ?
        AND fc."VH_SERVICE" = 'CAP'`;
    const params = [requestId, fieldCode];
    if (blockId) {
      sql += ` AND bf."BLOCK_ID" = ?`;
      params.push(blockId);
    }
    sql += ` ORDER BY fc."ID" ASC`;
    const rows = (await tx.run(sql, params)).map(_normalizeCatalogRow).filter(Boolean);

    const exact = rows.filter((r) => r.VH_ENTITYSET === vhName);
    if (exact.length === 1) {
      _logCatalogResolution(vhName, input, 'requestContext', exact[0]);
      return exact[0];
    }
    if (exact.length > 1) {
      throw _vhConfigError(vhName, `ambiguous fieldCode '${fieldCode}' for request context`, {
        ...input,
        errorCode: 'AMBIGUOUS_FIELD_CODE',
        candidates: exact.map((r) => ({ fieldId: r.FIELD_ID, fieldCode: r.FIELD_CODE, vhEntitySet: r.VH_ENTITYSET }))
      });
    }
  }

  if (processCode && fieldCode) {
    const rows = await tx.run(
      `SELECT DISTINCT
         fc."ID"             as "FIELD_ID",
         fc."FIELD_CODE"     as "FIELD_CODE",
         fc."VH_ENTITYSET"   as "VH_ENTITYSET",
         fc."VH_KEY_FIELD"   as "VH_KEY_FIELD",
         fc."VH_TEXT_FIELD"  as "VH_TEXT_FIELD",
         fc."VH_SEARCH_FIELDS" as "VH_SEARCH_FIELDS"
       FROM "MDG_PROCESS" p
       JOIN "MDG_PROCESS_BLOCK" pb
         ON pb."PROCESS_ID" = p."ID"
       JOIN "MDG_BLOCK_FIELD" bf
         ON bf."BLOCK_ID" = pb."BLOCK_ID"
       JOIN "MDG_FIELD_CATALOG" fc
         ON fc."ID" = bf."FIELD_ID"
      WHERE p."PROCESS_CODE" = ?
        AND fc."FIELD_CODE" = ?
        AND fc."VH_SERVICE" = 'CAP'
      ORDER BY fc."ID" ASC`,
      [processCode, fieldCode]
    );
    const normalized = (rows || []).map(_normalizeCatalogRow).filter(Boolean);
    const exact = normalized.filter((r) => r.VH_ENTITYSET === vhName);
    if (exact.length === 1) {
      _logCatalogResolution(vhName, input, 'processCode', exact[0]);
      return exact[0];
    }
  }

  if (fieldCode) {
    const byFieldCode = await tx.run(
      `SELECT
         "ID"            as "FIELD_ID",
         "FIELD_CODE",
         "VH_ENTITYSET",
         "VH_KEY_FIELD",
         "VH_TEXT_FIELD",
         "VH_SEARCH_FIELDS"
       FROM "MDG_FIELD_CATALOG"
      WHERE "FIELD_CODE" = ?
        AND "VH_SERVICE" = 'CAP'
      ORDER BY "ID" ASC`,
      [fieldCode]
    );
    const rows = (byFieldCode || []).map(_normalizeCatalogRow).filter(Boolean);
    if (rows.length > 1) {
      const exact = rows.filter((r) => r.VH_ENTITYSET === vhName);
      if (exact.length === 1) {
        _logCatalogResolution(vhName, input, 'fieldCode+vh', exact[0]);
        return exact[0];
      }
      throw _vhConfigError(vhName, `ambiguous fieldCode '${fieldCode}' without context`, {
        ...input,
        errorCode: 'AMBIGUOUS_FIELD_CODE',
        candidates: rows.map((r) => ({ fieldId: r.FIELD_ID, fieldCode: r.FIELD_CODE, vhEntitySet: r.VH_ENTITYSET }))
      });
    }
    if (rows[0]) {
      _ensureCatalogRowMatchesRequestedVh(rows[0], vhName, input);
      _logCatalogResolution(vhName, input, 'fieldCode', rows[0]);
      return rows[0];
    }
  }

  const byVh = await tx.run(
    `SELECT
       "ID"            as "FIELD_ID",
       "FIELD_CODE",
       "VH_ENTITYSET",
       "VH_KEY_FIELD",
       "VH_TEXT_FIELD",
       "VH_SEARCH_FIELDS"
     FROM "MDG_FIELD_CATALOG"
    WHERE "VH_SERVICE" = 'CAP'
      AND "VH_ENTITYSET" = ?
    ORDER BY "FIELD_CODE" ASC
    LIMIT 1`,
    [vhName]
  );

  const row = _normalizeCatalogRow(byVh?.[0]);
  if (!row) {
    throw _vhConfigError(vhName, 'no MDG_FIELD_CATALOG entry found', input);
  }
  _logCatalogResolution(vhName, input, 'vhEntitySet', row);
  return row;
}

async function _loadRouteRuntime(tx, vhName) {
  const sqlActive =
    `SELECT
       "VH_ENTITYSET",
       "DESTINATION_NAME",
       "SERVICE_PATH",
       "REMOTE_ENTITYSET",
       "REMOTE_KEY_FIELD",
       "REMOTE_TEXT_FIELD",
       "REMOTE_SEARCH_FIELDS"
     FROM "MDG_VH_ROUTE"
    WHERE "VH_ENTITYSET" = ?
      AND "IS_ENABLED" = true
    ORDER BY "VH_ENTITYSET" ASC
    LIMIT 1`;

  const sqlPlain =
    `SELECT
       "VH_ENTITYSET",
       "DESTINATION_NAME",
       "SERVICE_PATH",
       "REMOTE_ENTITYSET",
       "REMOTE_KEY_FIELD",
       "REMOTE_TEXT_FIELD",
       "REMOTE_SEARCH_FIELDS"
     FROM "MDG_VH_ROUTE"
    WHERE "VH_ENTITYSET" = ?
    ORDER BY "VH_ENTITYSET" ASC
    LIMIT 1`;

  let rows = [];
  try {
    rows = await tx.run(sqlActive, [vhName]);
  } catch (_) {
    rows = await tx.run(sqlPlain, [vhName]);
  }

  if (!rows?.[0]) {
    throw _vhConfigError(vhName, 'no active MDG_VH_ROUTE mapping found', { vhEntitySet: vhName });
  }

  const route = rows[0];
  if (!String(route.SERVICE_PATH || '').trim() || !String(route.REMOTE_ENTITYSET || '').trim()) {
    throw _vhConfigError(vhName, 'invalid MDG_VH_ROUTE mapping (missing SERVICE_PATH or REMOTE_ENTITYSET)', {
      vhEntitySet: vhName,
      servicePath: route.SERVICE_PATH,
      remoteEntitySet: route.REMOTE_ENTITYSET
    });
  }

  return route;
}

async function _validateRouteEntitySet(vhName, route) {
  const servicePath = String(route.SERVICE_PATH || '').trim();
  const remoteEntitySet = String(route.REMOTE_ENTITYSET || '').trim();

  const entitySets = await _fetchMetadataEntitySets(servicePath);
  if (!entitySets.has(remoteEntitySet)) {
    throw _vhConfigError(vhName, `entitySet '${remoteEntitySet}' not found in metadata '${servicePath}'`, {
      vhEntitySet: vhName,
      servicePath,
      remoteEntitySet
    });
  }
}

async function _loadVhDependencies(tx, fieldCode) {
  if (!fieldCode) return [];
  try {
    const rows = await tx.run(
      `SELECT
         "FIELD_CODE",
         "DEPENDS_ON_FIELD_CODE",
         "VH_PROPERTY_NAME",
         "IS_REQUIRED" as "REQUIRED",
         "EVALUATION_ORDER",
         "IS_ENABLED" as "IS_ACTIVE"
       FROM "MDG_FIELD_VH_DEPENDENCY"
      WHERE "FIELD_CODE" = ?
        AND "IS_ENABLED" = true
      ORDER BY "EVALUATION_ORDER" ASC`,
      [fieldCode]
    );
    return rows;
  } catch (_) {
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
      return [];
    }
  }
}

async function _resolveDependencyValue(tx, dep, contextMap, requestId) {
  const depFieldCode = String(dep?.DEPENDS_ON_FIELD_CODE || '').trim();
  if (!depFieldCode) return { value: null, source: null };

  const fromContextFull = _findContextEntry(contextMap, depFieldCode);
  if (fromContextFull.found) return { value: fromContextFull.value, source: 'context' };

  const depSimple = depFieldCode.split('.').pop();
  const fromContextSimple = _findContextEntry(contextMap, depSimple);
  if (fromContextSimple.found) return { value: fromContextSimple.value, source: 'context' };

  const fromRequest = await _readRequestValueByFieldCode(tx, requestId, depFieldCode);
  if (fromRequest) return { value: fromRequest, source: 'persisted' };

  return { value: null, source: null };
}

async function _applyDependencyFilters(tx, req, vhName, fieldCode, q, remoteQ) {
  const deps = await _loadVhDependencies(tx, fieldCode);
  if (!deps.length) return { missingRequired: false, resolvedDepLogs: [] };

  const contextMap = _getContextInput(req, q);
  const requestId = _getRequestIdInput(req, q);
  const depFilters = [];
  const unresolvedRequired = [];
  const resolvedDepLogs = [];

  for (const dep of deps) {
    const resolved = await _resolveDependencyValue(tx, dep, contextMap, requestId);
    const value = resolved?.value;
    const vhPropertyName = String(dep?.VH_PROPERTY_NAME || '').trim();
    const isRequired = dep?.REQUIRED === true || String(dep?.REQUIRED).toLowerCase() === 'true' || dep?.REQUIRED === 1;
    const dependsOn = String(dep?.DEPENDS_ON_FIELD_CODE || '').trim();

    resolvedDepLogs.push({
      dependsOn,
      vhPropertyName,
      value: value || '',
      source: resolved?.source || 'none',
      required: Boolean(isRequired)
    });

    if (_isEmptyValue(value)) {
      if (isRequired) unresolvedRequired.push(dependsOn || vhPropertyName || '?');
      continue;
    }

    if (!vhPropertyName) continue;
    depFilters.push(`${vhPropertyName} eq '${_escapeODataLiteral(value)}'`);
  }

  if (depFilters.length) {
    remoteQ.$filter = remoteQ.$filter ? `(${remoteQ.$filter}) and (${depFilters.join(' and ')})` : depFilters.join(' and ');
  }

  if (unresolvedRequired.length) {
    console.warn(`[VH_DEP_MISSING] vh=${vhName} fieldCode=${fieldCode || '-'} missing=${unresolvedRequired.join(',')}`);
    return { missingRequired: true, resolvedDepLogs };
  }

  return { missingRequired: false, resolvedDepLogs };
}

function _validateCatalogRouteContract(vhName, catalog, route) {
  const localKey = String(catalog?.VH_KEY_FIELD || '').trim();
  const localText = String(catalog?.VH_TEXT_FIELD || '').trim();

  if (!localKey || !localText) {
    throw _vhConfigError(vhName, 'invalid MDG_FIELD_CATALOG entry (missing VH_KEY_FIELD or VH_TEXT_FIELD)', {
      vhEntitySet: vhName,
      fieldCode: catalog?.FIELD_CODE || '',
      vhKeyField: localKey,
      vhTextField: localText
    });
  }
}

function _validateRemotePayloadContract(vhName, rows, catalog, route) {
  if (!Array.isArray(rows) || !rows.length) return;
  const probe = rows[0] || {};
  const keyField = String(catalog?.VH_KEY_FIELD || '').trim();
  const textField = String(catalog?.VH_TEXT_FIELD || '').trim();
  const rowFields = Object.keys(probe || {});

  if (!_hasFieldCaseInsensitive(probe, keyField) || !_hasFieldCaseInsensitive(probe, textField)) {
    throw _vhConfigError(vhName, 'remote payload does not expose configured vhKeyField/vhTextField', {
      vhEntitySet: vhName,
      fieldCode: catalog?.FIELD_CODE || '',
      vhKeyField: keyField,
      vhTextField: textField,
      remoteKeyField: String(route?.REMOTE_KEY_FIELD || '').trim(),
      remoteTextField: String(route?.REMOTE_TEXT_FIELD || '').trim(),
      servicePath: String(route?.SERVICE_PATH || '').trim(),
      remoteEntitySet: String(route?.REMOTE_ENTITYSET || '').trim(),
      sampleRemoteFields: rowFields.slice(0, 40)
    });
  }
}

function _applyLocalSearch(rows, searchText, fields = []) {
  const term = String(searchText ?? '').trim().replace(/^"(.*)"$/, '$1').toLowerCase();
  if (!term) return rows;
  if (!Array.isArray(fields) || !fields.length) return rows;
  return (rows || []).filter((row) =>
    fields.some((f) => String(row?.[f] ?? '').toLowerCase().includes(term))
  );
}

function _ensureEntityKeys(vhName, rows, catalog) {
  const entity = cds.model?.definitions?.[`MDGService.${vhName}`];
  const elements = entity?.elements || {};
  const keyFields = Object.keys(elements).filter((k) => elements[k]?.key);
  if (!keyFields.length) return rows;

  const localKey = String(catalog?.VH_KEY_FIELD || '').trim();

  return (rows || []).map((row, idx) => {
    const out = { ...row };

    for (const keyField of keyFields) {
      if (!_isEmptyValue(out[keyField])) continue;

      if (localKey && keyField !== localKey && !_isEmptyValue(out[localKey])) {
        out[keyField] = out[localKey];
        continue;
      }

      if (keyField === 'ID') {
        const seed = localKey && !_isEmptyValue(out[localKey]) ? String(out[localKey]) : String(idx + 1);
        out.ID = seed.slice(0, 200);
        continue;
      }

      out[keyField] = localKey && !_isEmptyValue(out[localKey]) ? out[localKey] : String(idx + 1);
    }

    return out;
  });
}

function _dedupeByCatalogKey(rows, catalog) {
  const localKey = String(catalog?.VH_KEY_FIELD || '').trim();
  if (!localKey) return rows;
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = String(row?.[localKey] ?? '').trim();
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

function _logVhRequest({ fieldCode, vhName, route, depLogs, remoteFilter }) {
  console.info(
    `[VH_REQ] fieldCode=${fieldCode || '-'} vhEntitySet=${vhName} servicePath=${route?.SERVICE_PATH || ''} remoteEntitySet=${route?.REMOTE_ENTITYSET || ''} deps=${JSON.stringify(
      depLogs || []
    )} remoteFilter=${remoteFilter || ''}`
  );
}

function _buildRemoteQuery(q) {
  const remoteQ = { ...q };
  // UI filter/search/select are usually local contract fields, not remote canonical names.
  delete remoteQ.$select;
  delete remoteQ.$filter;
  delete remoteQ.$search;
  delete remoteQ.search;
  delete remoteQ.q;
  return remoteQ;
}

async function _readVhGeneric(req, vhName) {
  const tx = cds.tx(req);
  const q = pickODataOptions(getQueryOptions(req));
  if (q.$top === undefined) q.$top = 50;

  const fieldId = _getFieldIdInput(req, q);
  const fieldCode = _getFieldCodeInput(req, q);
  const requestId = _getRequestIdInput(req, q);
  const blockId = _getBlockIdInput(req, q);
  const processCode = _getProcessCodeInput(req, q);
  const localFilter = q.$filter;
  const localSearch = q.$search ?? q.search ?? q.q;
  const localTop = q.$top;
  const localSkip = q.$skip;

  const catalog = await _loadCatalogRuntime(tx, vhName, {
    fieldId,
    fieldCode,
    requestId,
    blockId,
    processCode
  });
  const route = await _loadRouteRuntime(tx, vhName);
  _validateCatalogRouteContract(vhName, catalog, route);

  const invalidReason = _vhInvalidMappings.get(vhName);
  if (invalidReason) {
    throw _vhConfigError(vhName, invalidReason, {
      vhEntitySet: vhName,
      servicePath: route.SERVICE_PATH,
      remoteEntitySet: route.REMOTE_ENTITYSET
    });
  }

  await _validateRouteEntitySet(vhName, route);

  const remoteQ = _buildRemoteQuery(q);
  const dep = await _applyDependencyFilters(tx, req, vhName, catalog.FIELD_CODE, q, remoteQ);
  _logVhRequest({
    fieldCode: catalog.FIELD_CODE,
    vhName,
    route,
    depLogs: dep.resolvedDepLogs,
    remoteFilter: remoteQ.$filter
  });

  if (dep.missingRequired) return [];

  let rows = await s4Get({
    servicePath: String(route.SERVICE_PATH || '').trim(),
    entitySet: String(route.REMOTE_ENTITYSET || '').trim(),
    query: remoteQ
  });
  _validateRemotePayloadContract(vhName, rows, catalog, route);

  if (localFilter) rows = applyLocalFilter(rows, localFilter);
  if (localSearch) rows = _applyLocalSearch(rows, localSearch, _toCsvArray(catalog.VH_SEARCH_FIELDS));
  if (localFilter || localSearch) rows = applyLocalPaging(rows, localTop, localSkip);

  rows = _ensureEntityKeys(vhName, rows, catalog);
  rows = _dedupeByCatalogKey(rows, catalog);

  return rows;
}

async function _loadAllRoutes(db) {
  const sqlActive =
    `SELECT
       "VH_ENTITYSET",
       "DESTINATION_NAME",
       "SERVICE_PATH",
       "REMOTE_ENTITYSET",
       "REMOTE_KEY_FIELD",
       "REMOTE_TEXT_FIELD",
       "REMOTE_SEARCH_FIELDS"
     FROM "MDG_VH_ROUTE"
    WHERE "IS_ENABLED" = true`;

  const sqlPlain =
    `SELECT
       "VH_ENTITYSET",
       "DESTINATION_NAME",
       "SERVICE_PATH",
       "REMOTE_ENTITYSET",
       "REMOTE_KEY_FIELD",
       "REMOTE_TEXT_FIELD",
       "REMOTE_SEARCH_FIELDS"
     FROM "MDG_VH_ROUTE"`;

  try {
    return await db.run(sqlActive);
  } catch (_) {
    return db.run(sqlPlain);
  }
}

async function validateVhMappingsOnStartup() {
  _vhInvalidMappings.clear();
  _metadataEntitySetCache.clear();

  let routes = [];
  try {
    const db = await cds.connect.to('db');
    routes = await _loadAllRoutes(db);
  } catch (err) {
    const msg = `cannot read MDG_VH_ROUTE: ${String(err?.message || err)}`;
    if (FAIL_FAST_ON_VH_METADATA) throw new Error(msg);
    console.error(JSON.stringify({ tag: 'VH_STARTUP_ROUTE_READ_ERROR', error: msg }));
    return;
  }

  for (const route of routes || []) {
    const vhName = String(route?.VH_ENTITYSET || '').trim();
    const servicePath = String(route?.SERVICE_PATH || '').trim();
    const remoteEntitySet = String(route?.REMOTE_ENTITYSET || '').trim();
    if (!vhName || !servicePath || !remoteEntitySet) {
      _vhInvalidMappings.set(vhName || '?', 'invalid route row (missing VH_ENTITYSET/SERVICE_PATH/REMOTE_ENTITYSET)');
      console.error(
        JSON.stringify({
          tag: 'VH_STARTUP_MAPPING_INVALID',
          vhName,
          servicePath,
          remoteEntitySet
        })
      );
      continue;
    }

    try {
      const entitySets = await _fetchMetadataEntitySets(servicePath);
      if (!entitySets.has(remoteEntitySet)) {
        const reason = `entitySet '${remoteEntitySet}' not found in metadata '${servicePath}'`;
        _vhInvalidMappings.set(vhName, reason);
        console.error(
          JSON.stringify({
            tag: 'VH_STARTUP_MAPPING_MISSING',
            vhName,
            servicePath,
            remoteEntitySet,
            reason
          })
        );
      }
    } catch (err) {
      const reason = `metadata fetch failed for '${servicePath}': ${String(err?.message || err)}`;
      _vhInvalidMappings.set(vhName, reason);
      console.error(
        JSON.stringify({
          tag: 'VH_STARTUP_METADATA_ERROR',
          vhName,
          servicePath,
          remoteEntitySet,
          reason
        })
      );
    }
  }

  if (_vhInvalidMappings.size && FAIL_FAST_ON_VH_METADATA) {
    const details = Array.from(_vhInvalidMappings.entries())
      .map(([vhName, reason]) => `${vhName}: ${reason}`)
      .join('; ');
    throw new Error(`VH metadata validation failed: ${details}`);
  }
}

const expose = (vhName) => (req) => _readVhGeneric(req, vhName);

module.exports = {
  readCustomerGen: expose('VH_CustomerGen'),
  readCustomerClassification: expose('VH_CustomerClassification'),
  readMaterialProduct: expose('VH_MaterialProduct'),
  readMaterialSalesOrg: expose('VH_MaterialSalesOrg'),
  readMaterialVtweg: expose('VH_MaterialVtweg'),
  readMaterialKtgrm: expose('VH_MaterialKtgrm'),
  readCustomerOrgV: expose('VH_CustomerOrgV'),
  readCustomerVtweg: expose('VH_CustomerVtweg'),
  readCustomerSpart: expose('VH_CustomerSpart'),
  readCustomerLzone: expose('VH_CustomerLzone'),
  readCustomerRegion: expose('VH_CustomerRegion'),
  readCustomerPaymentCondition: expose('VH_CustomerPaymentCondition'),
  readCustomerBzirk: expose('VH_CustomerBzirk'),
  readCustomerDunningArea: expose('VH_CustomerDunningArea'),
  readDestMercBP: expose('VH_DestMercBP'),
  readDestMercOrgV: expose('VH_DestMercOrgV'),
  readDestMercVtweg: expose('VH_DestMercVtweg'),
  readDestMercSpart: expose('VH_DestMercSpart'),
  readDestMercBzirk: expose('VH_DestMercBzirk'),
  readDestMercSoc: expose('VH_DestMercSoc'),
  readDestMercDunningArea: expose('VH_DestMercDunningArea'),
  readDestMercPaymentCondition: expose('VH_DestMercPaymentCondition'),
  readDestMercImp: expose('VH_DestMercImp'),
  readDestFactBP: expose('VH_DestFactBP'),
  readDestFactSalesOrg: expose('VH_DestFactSalesOrg'),
  readDestFactVtweg: expose('VH_DestFactVtweg'),
  readDestMercBanks: expose('VH_DestMercBanks'),
  readDestMercBank: expose('VH_DestMercBank'),
  readDestMercLzone: expose('VH_DestMercLzone'),
  readDestMercRegion: expose('VH_DestMercRegion'),
  readCustomerSoc: expose('VH_CustomerSoc'),
  readCustomerCom: expose('VH_CustomerCom'),
  readCustomerEmp: expose('VH_CustomerEmp'),
  readCustomerBan: expose('VH_CustomerBan'),
  readCustomerImp: expose('VH_CustomerImp'),
  readCustomerNif: expose('VH_CustomerNif'),
  readDriverGen: expose('VH_DriverGen'),
  readDriverRol: expose('VH_DriverRol'),
  readDriverCom: expose('VH_DriverCom'),
  readDriverImp: expose('VH_DriverImp'),
  readDriverNif: expose('VH_DriverNif'),
  readDriverAdi: expose('VH_DriverAdi'),
  readBillToGen: expose('VH_BillToGen'),
  readBillToCom: expose('VH_BillToCom'),
  readBillToImp: expose('VH_BillToImp'),
  readShipToGen: expose('VH_ShipToGen'),
  readShipToCom: expose('VH_ShipToCom'),
  readResources: expose('VH_Resources'),
  validateVhMappingsOnStartup
};
