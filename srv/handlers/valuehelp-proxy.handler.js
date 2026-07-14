const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { s4Get } = require('./_lib/s4.client');
const { getQueryOptions, pickODataOptions, applyLocalFilter, applyLocalPaging } = require('./_lib/odata.util');

const MAX_VH_CONTEXT_CHARS = Number(process.env.MDG_VH_MAX_CONTEXT_CHARS || 4000);
const S4_DESTINATION_NAME = 'S4H-TECH';
const FAIL_FAST_ON_VH_METADATA = String(process.env.MDG_VH_FAIL_FAST || 'false').toLowerCase() === 'true';

const _metadataEntitySetCache = new Map();
const _vhInvalidMappings = new Map();
const ALLOWED_CHILE_COMPANY_CODES = new Set(['A023', 'A032', 'A050', 'A071', 'A080', 'A090', 'A096']);

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

function _escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _mergeODataFilters(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a) return b;
  if (!b) return a;
  return `(${a}) and (${b})`;
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

async function _readRequestDefaultByFieldCode(tx, requestId, fieldCode) {
  if (!requestId || !fieldCode) return null;

  const rows = await tx.run(
    `SELECT DISTINCT
        COALESCE(
          NULLIF(TRIM(fcc."DEFAULT_OVERRIDE"), ''),
          NULLIF(TRIM(fcb."DEFAULT_BASE"), '')
        ) AS "DEFAULT_VALUE"
       FROM "MDG_REQUEST_HEADER" rh
       JOIN "MDG_PROCESS_BLOCK" pb
         ON pb."PROCESS_ID" = rh."PROCESS_ID"
       JOIN "MDG_BLOCK_FIELD" bf
         ON bf."BLOCK_ID" = pb."BLOCK_ID"
       JOIN "MDG_FIELD_CATALOG" fc
         ON fc."ID" = bf."FIELD_ID"
       JOIN "MDG_PROCESS_ROLE" pr
         ON pr."PROCESS_ID" = rh."PROCESS_ID"
        AND pr."IS_ENABLED" = true
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_BASE" fcb
         ON fcb."PROCESS_ROLE_ID" = pr."ID"
        AND fcb."FIELD_ID" = fc."ID"
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_COUNTRY" fcc
         ON fcc."PROCESS_ROLE_ID" = pr."ID"
        AND fcc."FIELD_ID" = fc."ID"
        AND fcc."COUNTRY_CODE" = rh."COUNTRY_CODE"
      WHERE rh."ID" = ?
        AND fc."FIELD_CODE" = ?`,
    [requestId, fieldCode]
  );

  const defaults = Array.from(new Set(
    (rows || [])
      .map((row) => String(row.DEFAULT_VALUE || '').trim())
      .filter(Boolean)
  ));

  // Only infer a default when every active process role agrees on its value.
  return defaults.length === 1 ? defaults[0] : null;
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

  const fromDefault = await _readRequestDefaultByFieldCode(tx, requestId, depFieldCode);
  if (fromDefault) return { value: fromDefault, source: 'default' };

  return { value: null, source: null };
}

async function _applyDependencyFilters(tx, req, vhName, fieldCode, q, remoteQ) {
  const rawDeps = await _loadVhDependencies(tx, fieldCode);
  const seenDependencies = new Set();
  const deps = rawDeps.filter((dep) => {
    const dependencyKey = [
      String(dep?.DEPENDS_ON_FIELD_CODE || '').trim().toUpperCase(),
      String(dep?.VH_PROPERTY_NAME || '').trim().toUpperCase()
    ].join('|');

    if (seenDependencies.has(dependencyKey)) return false;
    seenDependencies.add(dependencyKey);
    return true;
  });
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
    remoteQ.$filter = _mergeODataFilters(remoteQ.$filter, depFilters.join(' and '));
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

function _catalogRouteFieldPairs(catalog, route) {
  const localSearchFields = _toCsvArray(catalog?.VH_SEARCH_FIELDS);
  const remoteSearchFields = _toCsvArray(route?.REMOTE_SEARCH_FIELDS);
  const localKey = String(catalog?.VH_KEY_FIELD || '').trim();
  const localText = String(catalog?.VH_TEXT_FIELD || '').trim();
  const remoteKey = String(route?.REMOTE_KEY_FIELD || '').trim();
  const remoteText = String(route?.REMOTE_TEXT_FIELD || '').trim();
  const pairs = [
    [localKey, remoteKey],
    [localText, remoteText]
  ];

  localSearchFields.forEach((localField, idx) => {
    const local = String(localField || '').trim();
    let remote = String(remoteSearchFields[idx] || '').trim();
    if (!remote && local && local === localKey) remote = remoteKey;
    if (!remote && local && local === localText) remote = remoteText;
    pairs.push([local, remote || local]);
  });

  return pairs
    .map(([localField, remoteField]) => [String(localField || '').trim(), String(remoteField || '').trim()])
    .filter(([localField]) => localField);
}

function _buildRemoteFieldMap(catalog, route) {
  const map = new Map();
  for (const [localField, remoteField] of _catalogRouteFieldPairs(catalog, route)) {
    const target = remoteField || localField;
    map.set(localField.toLowerCase(), target);
    map.set(target.toLowerCase(), target);
  }
  return map;
}

function _mapRemoteField(fieldMap, fieldName) {
  const raw = String(fieldName || '').trim();
  if (!raw) return '';
  return fieldMap.get(raw.toLowerCase()) || raw;
}

function _isSimpleODataPropertyName(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value || '').trim());
}

function _buildRemoteSelect(vhName, catalog, route) {
  const fieldMap = _buildRemoteFieldMap(catalog, route);
  const fields = [
    _mapRemoteField(fieldMap, catalog?.VH_KEY_FIELD || route?.REMOTE_KEY_FIELD),
    _mapRemoteField(fieldMap, catalog?.VH_TEXT_FIELD || route?.REMOTE_TEXT_FIELD)
  ]
    .map((field) => String(field || '').trim())
    .filter((field) => _isSimpleODataPropertyName(field));

  if (vhName === 'VH_DriverGen') {
    fields.push('Transportista', 'TransportistaName');
  }

  return Array.from(new Set(fields)).join(',');
}

function _translateLocalFilterToRemote(filterExpr, catalog, route) {
  const original = String(filterExpr || '').trim();
  if (!original) return '';

  const fieldMap = _buildRemoteFieldMap(catalog, route);
  let translated = original;
  let touched = false;
  let canTranslate = true;

  translated = translated.replace(
    /\bcontains\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*'((?:''|[^'])*)'\s*\)/gi,
    (match, field, literal) => {
      const remoteField = fieldMap.get(String(field || '').trim().toLowerCase());
      if (!remoteField) {
        canTranslate = false;
        return match;
      }
      touched = true;
      return `substringof('${literal}',${remoteField})`;
    }
  );

  translated = translated.replace(
    /\bsubstringof\(\s*'((?:''|[^'])*)'\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/gi,
    (match, literal, field) => {
      const remoteField = fieldMap.get(String(field || '').trim().toLowerCase());
      if (!remoteField) {
        canTranslate = false;
        return match;
      }
      touched = true;
      return `substringof('${literal}',${remoteField})`;
    }
  );

  translated = translated.replace(
    /\bstartswith\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*'((?:''|[^'])*)'\s*\)/gi,
    (match, field, literal) => {
      const remoteField = fieldMap.get(String(field || '').trim().toLowerCase());
      if (!remoteField) {
        canTranslate = false;
        return match;
      }
      touched = true;
      return `startswith(${remoteField},'${literal}')`;
    }
  );

  for (const [localLower, remoteField] of fieldMap.entries()) {
    const field = _escapeRegExp(localLower);
    const re = new RegExp(`\\b(${field})\\s+eq\\s+((?:'(?:(?:'')|[^'])*')|[^\\s\\)]+)`, 'gi');
    translated = translated.replace(re, (_, __, value) => {
      touched = true;
      return `${remoteField} eq ${value}`;
    });
  }

  return touched && canTranslate ? translated : '';
}

function _buildRemoteSearchFilter(searchText, catalog, route) {
  const term = String(searchText ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!term) return '';

  const fieldMap = _buildRemoteFieldMap(catalog, route);
  const remoteSearchFields = _toCsvArray(route?.REMOTE_SEARCH_FIELDS);
  const localSearchFields = _toCsvArray(catalog?.VH_SEARCH_FIELDS);
  const fields = remoteSearchFields.length
    ? remoteSearchFields
    : localSearchFields.map((field) => _mapRemoteField(fieldMap, field));
  const uniqueFields = Array.from(new Set(fields.map((field) => String(field || '').trim()).filter(Boolean)));
  if (!uniqueFields.length) return '';

  const literal = _escapeODataLiteral(term);
  return uniqueFields.map((field) => `substringof('${literal}',${field})`).join(' or ');
}

function _applyCatalogRouteAliases(rows, catalog, route) {
  const pairs = _catalogRouteFieldPairs(catalog, route);
  if (!pairs.length) return rows;

  return (rows || []).map((row) => {
    const out = { ...row };
    for (const [localField, remoteField] of pairs) {
      if (!remoteField || localField === remoteField) continue;
      if (_isEmptyValue(out[localField]) && !_isEmptyValue(out[remoteField])) out[localField] = out[remoteField];
      if (_isEmptyValue(out[remoteField]) && !_isEmptyValue(out[localField])) out[remoteField] = out[localField];
    }
    return out;
  });
}

function _logVhRequest({ fieldCode, vhName, route, depLogs, remoteFilter }) {
  console.info(
    `[VH_REQ] fieldCode=${fieldCode || '-'} vhEntitySet=${vhName} servicePath=${route?.SERVICE_PATH || ''} remoteEntitySet=${route?.REMOTE_ENTITYSET || ''} deps=${JSON.stringify(
      depLogs || []
    )} remoteFilter=${remoteFilter || ''}`
  );
}

function _buildRemoteQuery(q, catalog, route, vhName = '') {
  const remoteQ = { ...q };
  // UI filter/search/select are usually local contract fields, not remote canonical names.
  delete remoteQ.$select;
  delete remoteQ.$filter;
  delete remoteQ.$search;
  delete remoteQ.search;
  delete remoteQ.q;

  const remoteSelect = _buildRemoteSelect(vhName, catalog, route);
  if (remoteSelect) remoteQ.$select = remoteSelect;

  return remoteQ;
}

const STATIC_VH_FILTERS = {
  VH_OwnerBP: [`BusinessPartnerRole eq 'CRM010'`],
  VH_TransportistaBP: [`BusinessPartnerRole eq 'CRM010'`],
  VH_DriverRelationshipBP: [`BusinessPartnerRole eq 'TM0001'`, `RelationshipCategory eq 'CRMS01'`]
};

async function _readRequestSubjectId(tx, requestId) {
  if (!requestId) return '';
  const rows = await tx.run(
    `SELECT "SUBJECT_ID"
       FROM "MDG_REQUEST_HEADER"
      WHERE "ID" = ?`,
    [requestId]
  );
  return String(rows?.[0]?.SUBJECT_ID || '').trim();
}

async function _loadExistingCustomerCompanies(customerId) {
  const kunnr = String(customerId || '').trim();
  if (!kunnr) return new Set();
  const rows = await s4Get({
    servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_EMP_CDS',
    entitySet: 'zcds_clientes_emp',
    query: {
      $select: 'Kunnr,Bukrs,CompanyCode',
      $filter: `Kunnr eq '${_escapeODataLiteral(kunnr)}'`,
      $top: 200
    }
  });
  const existing = new Set();
  for (const row of rows || []) {
    const code = String(row?.Bukrs || row?.CompanyCode || '').trim();
    if (code) existing.add(code);
  }
  return existing;
}

async function _applyCompanyCodeRestrictions(tx, vhName, rows, { requestId, processCode }) {
  if (!['VH_CustomerSoc', 'VH_DestMercSoc'].includes(String(vhName || ''))) return rows;

  let filtered = (rows || []).filter((row) => {
    const code = String(row?.CompanyCode || row?.Bukrs || '').trim();
    return code && ALLOWED_CHILE_COMPANY_CODES.has(code);
  });

  const process = String(processCode || '').trim().toUpperCase();
  if (vhName === 'VH_CustomerSoc' && requestId && process === 'CUSTOMER_EXTEND_COMPANYCODE') {
    const customerId = await _readRequestSubjectId(tx, requestId);
    if (customerId) {
      const existing = await _loadExistingCustomerCompanies(customerId);
      filtered = filtered.filter((row) => {
        const code = String(row?.CompanyCode || row?.Bukrs || '').trim();
        return code && !existing.has(code);
      });
    }
  }

  return filtered;
}

function _applyDriverGenRestrictions(vhName, rows) {
  if (String(vhName || '') !== 'VH_DriverGen') return rows;

  // ABAP prefilters TM0001 conductors; Transportista is populated from BUT050/CRMS01.
  return (rows || []).filter((row) => !_isEmptyValue(row?.Transportista));
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

  try {
    await _validateRouteEntitySet(vhName, route);
  } catch (err) {
    if (FAIL_FAST_ON_VH_METADATA || err?.code === 'VH_CONFIG_ERROR') {
      throw err;
    }
    console.error(
      JSON.stringify({
        tag: 'VH_RUNTIME_METADATA_WARNING',
        vhName,
        servicePath: route.SERVICE_PATH,
        remoteEntitySet: route.REMOTE_ENTITYSET,
        reason: String(err?.message || err)
      })
    );
  }

  const remoteQ = _buildRemoteQuery(q, catalog, route, vhName);
  const remoteLocalFilter = _translateLocalFilterToRemote(localFilter, catalog, route);
  const remoteSearchFilter = _buildRemoteSearchFilter(localSearch, catalog, route);
  const remoteLocalCriteriaApplied = Boolean(
    (!localFilter || remoteLocalFilter) && (!localSearch || remoteSearchFilter)
  );
  remoteQ.$filter = _mergeODataFilters(remoteLocalFilter, remoteSearchFilter);
  remoteQ.$filter = _mergeODataFilters(
    remoteQ.$filter,
    (STATIC_VH_FILTERS[vhName] || []).join(' and ')
  );

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
  rows = _applyCatalogRouteAliases(rows, catalog, route);
  rows = _applyDriverGenRestrictions(vhName, rows);
  rows = await _applyCompanyCodeRestrictions(tx, vhName, rows, {
    requestId,
    processCode
  });
  _validateRemotePayloadContract(vhName, rows, catalog, route);

  if (localFilter && !remoteLocalFilter) rows = applyLocalFilter(rows, localFilter);
  if (localSearch && !remoteSearchFilter) rows = _applyLocalSearch(rows, localSearch, _toCsvArray(catalog.VH_SEARCH_FIELDS));
  if ((localFilter || localSearch) && !remoteLocalCriteriaApplied) rows = applyLocalPaging(rows, localTop, localSkip);

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
      if (FAIL_FAST_ON_VH_METADATA) _vhInvalidMappings.set(vhName, reason);
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
  readMaterialUoM: expose('VH_MaterialUoM'),
  readCustomerOrgV: expose('VH_CustomerOrgV'),
  readCustomerVtweg: expose('VH_CustomerVtweg'),
  readCustomerSpart: expose('VH_CustomerSpart'),
  readCustomerLzone: expose('VH_CustomerLzone'),
  readCustomerRegion: expose('VH_CustomerRegion'),
  readCountry: expose('VH_Country'),
  readOwnerBp: expose('VH_OwnerBP'),
  readTransportistaBp: expose('VH_TransportistaBP'),
  readCustomerPaymentCondition: expose('VH_CustomerPaymentCondition'),
  readCustomerBzirk: expose('VH_CustomerBzirk'),
  readSalesGroup: expose('VH_SalesGroup'),
  readSalesOffice: expose('VH_SalesOffice'),
  readCustomerGroup8: expose('VH_CustomerGroup8'),
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
  readDriverRelationshipBp: expose('VH_DriverRelationshipBP'),
  readBillToGen: expose('VH_BillToGen'),
  readBillToCom: expose('VH_BillToCom'),
  readBillToImp: expose('VH_BillToImp'),
  readShipToGen: expose('VH_ShipToGen'),
  readShipToCom: expose('VH_ShipToCom'),
  readResources: expose('VH_Resources'),
  readResourceTransportationType: expose('VH_ResourceTransportationType'),
  readResourceLocation: expose('VH_ResourceLocation'),
  validateVhMappingsOnStartup
};
