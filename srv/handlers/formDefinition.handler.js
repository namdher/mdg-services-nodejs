const cds = require('@sap/cds')

// OJO: ajusta el path según tu proyecto real.
// Tú ya tienes resolveGroups porque lo usaste en whoAmI.
const { resolveGroups } = require('./auth.handler')

const DEFAULT_FIELD_CONTROL = 0
const VH_DEP_DEBUG = String(process.env.MDG_VH_DEP_DEBUG || 'false').toLowerCase() === 'true'

function _toLocalIsoDate(value = new Date()) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function _isDateLikeDataType(dataType) {
  const dt = String(dataType || '').trim().toUpperCase()
  return dt.includes('DATE') || dt.includes('TIME')
}

function _resolveDefaultToken(defaultValue, dataType) {
  if (defaultValue === null || defaultValue === undefined) return null
  const raw = String(defaultValue)
  const token = raw.trim().toUpperCase()
  if (!_isDateLikeDataType(dataType)) return raw
  if (token === 'TODAY' || token === '$NOW_DATE' || token === 'NOW' || token === '$NOW') {
    return _toLocalIsoDate()
  }
  return raw
}

async function _getProcess(tx, processCode) {
  const rows = await tx.run(
    `SELECT "ID","PROCESS_CODE","NAME","MASTER_OBJECT_ID","WF_VERSION","IS_ENABLED"
       FROM "MDG_PROCESS"
      WHERE "PROCESS_CODE" = ?`,
    [processCode]
  )
  return rows?.[0] || null
}

async function _resolveProcessRoleId(tx, { processId, roleCode, countryCode, groups }) {
  if (!Array.isArray(groups) || groups.length === 0) return null

  const inGroups = groups.map(() => '?').join(',')
  const rows = await tx.run(
    `
    SELECT DISTINCT m."PROCESS_ROLE_ID" as "PROCESS_ROLE_ID"
      FROM "MDG_IAS_GROUP_ROLE_MAP" m
      JOIN "MDG_PROCESS_ROLE" pr
        ON pr."ID" = m."PROCESS_ROLE_ID"
     WHERE m."PROCESS_ID" = ?
       AND pr."ROLE_CODE" = ?
       AND m."IS_ENABLED" = true
       AND pr."IS_ENABLED" = true
       AND m."IAS_GROUP" IN (${inGroups})
    `,
    [processId, roleCode, ...groups]
  )

  if (!rows.length) return null
  const processRoleId = rows[0].PROCESS_ROLE_ID

  // Country scope: si existe configuración de scope para ese role, entonces lo aplico.
  // Si NO existe nada configurado para ese role, lo dejo pasar (fallback).
  const scopeCntRows = await tx.run(
    `SELECT COUNT(*) as "CNT"
       FROM "MDG_COUNTRY_ROLE_SCOPE"
      WHERE "PROCESS_ROLE_ID" = ?
        AND "IS_ENABLED" = true`,
    [processRoleId]
  )

  const scopeCnt = Number(scopeCntRows?.[0]?.CNT || 0)
  if (scopeCnt > 0) {
    const ok = await tx.run(
      `SELECT 1 as "OK"
         FROM "MDG_COUNTRY_ROLE_SCOPE"
        WHERE "PROCESS_ROLE_ID" = ?
          AND "COUNTRY_CODE" = ?
          AND "IS_ENABLED" = true`,
      [processRoleId, countryCode]
    )
    if (!ok.length) return null
  }

  return processRoleId
}

async function _readFormFields(tx, { processId, processRoleId, countryCode }) {
  const sql = `
    SELECT
      pb."BLOCK_ID"        as "BLOCK_ID",
      pb."DISPLAY_ORDER"   as "BLOCK_ORDER",
      ob."BLOCK_CODE"      as "BLOCK_CODE",
      ob."NAME"            as "BLOCK_NAME",

      bf."FIELD_ID"        as "FIELD_ID",
      bf."DISPLAY_ORDER"   as "FIELD_ORDER",
      fc."FIELD_CODE"      as "FIELD_CODE",
      fc."BUSINESS_LABEL"  as "LABEL",

      fc."SAP_TABLE"       as "SAP_TABLE",
      fc."SAP_FIELD"       as "SAP_FIELD",
      fc."DATA_TYPE"       as "DATA_TYPE",
      fc."LENGTH"          as "LENGTH",
      fc."DECIMALS"        as "DECIMALS",
      fc."IS_MULTI"        as "IS_MULTI",

      COALESCE(fcc."FIELD_CONTROL_OVERRIDE", fcb."FIELD_CONTROL_BASE", ${DEFAULT_FIELD_CONTROL}) as "FIELD_CONTROL",
      COALESCE(fcc."DEFAULT_OVERRIDE",       fcb."DEFAULT_BASE",       NULL)                  as "DEFAULT_VALUE",

      fc."VH_DESTINATION"  as "VH_DESTINATION",
      fc."VH_SERVICE"      as "VH_SERVICE",
      fc."VH_ENTITYSET"    as "VH_ENTITYSET",
      fc."VH_KEY_FIELD"    as "VH_KEY_FIELD",
      fc."VH_TEXT_FIELD"   as "VH_TEXT_FIELD",
      fc."VH_SEARCH_FIELDS"as "VH_SEARCH_FIELDS"

    FROM "MDG_PROCESS_BLOCK" pb
    JOIN "MDG_OBJECT_BLOCK"  ob  ON ob."ID"      = pb."BLOCK_ID"
    JOIN "MDG_BLOCK_FIELD"   bf  ON bf."BLOCK_ID"= pb."BLOCK_ID"
    JOIN "MDG_FIELD_CATALOG" fc  ON fc."ID"      = bf."FIELD_ID"

    LEFT JOIN "MDG_FIELD_CONTROL_RULE_BASE" fcb
      ON fcb."PROCESS_ROLE_ID" = ?
     AND fcb."FIELD_ID"        = fc."ID"

    LEFT JOIN "MDG_FIELD_CONTROL_RULE_COUNTRY" fcc
      ON fcc."PROCESS_ROLE_ID" = ?
     AND fcc."FIELD_ID"        = fc."ID"
     AND fcc."COUNTRY_CODE"    = ?

    WHERE pb."PROCESS_ID" = ?
    ORDER BY pb."DISPLAY_ORDER", bf."DISPLAY_ORDER"
  `

  return tx.run(sql, [processRoleId, processRoleId, countryCode, processId])
}

async function _readVhDependencies(tx, fields) {
  const items = Array.isArray(fields) ? fields : []
  const fieldIds = Array.from(new Set(items.map((x) => String(x?.FIELD_ID || '').trim()).filter(Boolean)))
  const fieldCodes = Array.from(new Set(items.map((x) => String(x?.FIELD_CODE || '').trim()).filter(Boolean)))
  if (!fieldIds.length && !fieldCodes.length) return { byFieldId: {}, byFieldCode: {} }

  try {
    let rows = []

    // Primary path: real HANA structure with FIELD_ID + IS_ENABLED.
    if (fieldIds.length) {
      const placeholders = fieldIds.map(() => '?').join(',')
      rows = await tx.run(
        `SELECT
            d."FIELD_ID"              as "FIELD_ID",
            d."FIELD_CODE"            as "FIELD_CODE",
            d."DEPENDS_ON_FIELD_CODE" as "DEPENDS_ON_FIELD_CODE",
            d."VH_PROPERTY_NAME"      as "VH_PROPERTY_NAME",
            d."IS_REQUIRED"           as "IS_REQUIRED",
            d."EVALUATION_ORDER"      as "EVALUATION_ORDER"
           FROM "MDG_FIELD_VH_DEPENDENCY" d
          WHERE d."IS_ENABLED" = true
            AND d."FIELD_ID" IN (${placeholders})
          ORDER BY d."FIELD_ID" ASC, d."EVALUATION_ORDER" ASC`,
        fieldIds
      )
    }

    // Secondary path: by FIELD_CODE on real structure.
    if (!rows.length && fieldCodes.length) {
      const placeholders = fieldCodes.map(() => '?').join(',')
      rows = await tx.run(
        `SELECT
            "FIELD_ID"                as "FIELD_ID",
            "FIELD_CODE"              as "FIELD_CODE",
            "DEPENDS_ON_FIELD_CODE"   as "DEPENDS_ON_FIELD_CODE",
            "VH_PROPERTY_NAME"        as "VH_PROPERTY_NAME",
            "IS_REQUIRED"             as "IS_REQUIRED",
            "EVALUATION_ORDER"        as "EVALUATION_ORDER"
           FROM "MDG_FIELD_VH_DEPENDENCY"
          WHERE "IS_ENABLED" = true
            AND "FIELD_CODE" IN (${placeholders})
          ORDER BY "FIELD_CODE" ASC, "EVALUATION_ORDER" ASC`,
        fieldCodes
      )
    }

    // Backward compatible fallback for older landscapes (IS_ACTIVE/REQUIRED).
    if (!rows.length && fieldIds.length) {
      const placeholders = fieldIds.map(() => '?').join(',')
      rows = await tx.run(
        `SELECT
            fc."ID"                   as "FIELD_ID",
            fc."FIELD_CODE"           as "FIELD_CODE",
            d."DEPENDS_ON_FIELD_CODE" as "DEPENDS_ON_FIELD_CODE",
            d."VH_PROPERTY_NAME"      as "VH_PROPERTY_NAME",
            d."REQUIRED"              as "IS_REQUIRED",
            d."EVALUATION_ORDER"      as "EVALUATION_ORDER"
           FROM "MDG_FIELD_CATALOG" fc
           JOIN "MDG_FIELD_VH_DEPENDENCY" d
             ON d."FIELD_CODE" = fc."FIELD_CODE"
            AND d."IS_ACTIVE" = true
          WHERE fc."ID" IN (${placeholders})
          ORDER BY fc."ID" ASC, d."EVALUATION_ORDER" ASC`,
        fieldIds
      )
    }

    if (!rows.length && fieldCodes.length) {
      const placeholders = fieldCodes.map(() => '?').join(',')
      rows = await tx.run(
        `SELECT
            NULL                      as "FIELD_ID",
            "FIELD_CODE"              as "FIELD_CODE",
            "DEPENDS_ON_FIELD_CODE"   as "DEPENDS_ON_FIELD_CODE",
            "VH_PROPERTY_NAME"        as "VH_PROPERTY_NAME",
            "REQUIRED"                as "IS_REQUIRED",
            "EVALUATION_ORDER"        as "EVALUATION_ORDER"
           FROM "MDG_FIELD_VH_DEPENDENCY"
          WHERE "IS_ACTIVE" = true
            AND "FIELD_CODE" IN (${placeholders})
          ORDER BY "FIELD_CODE" ASC, "EVALUATION_ORDER" ASC`,
        fieldCodes
      )
    }

    const byFieldId = {}
    const byFieldCode = {}
    for (const row of rows || []) {
      const dep = {
        parentFieldCode: String(row.DEPENDS_ON_FIELD_CODE || '').trim(),
        vhPropertyName: String(row.VH_PROPERTY_NAME || '').trim(),
        isRequired:
          row.IS_REQUIRED === true || String(row.IS_REQUIRED).toLowerCase() === 'true' || row.IS_REQUIRED === 1,
        evaluationOrder: Number(row.EVALUATION_ORDER || 0)
      }
      const fieldId = String(row.FIELD_ID || '').trim()
      const fieldCode = String(row.FIELD_CODE || '').trim()
      if (fieldId) {
        if (!byFieldId[fieldId]) byFieldId[fieldId] = []
        byFieldId[fieldId].push(dep)
      }
      if (fieldCode) {
        if (!byFieldCode[fieldCode]) byFieldCode[fieldCode] = []
        byFieldCode[fieldCode].push(dep)
      }
    }

    return { byFieldId, byFieldCode }
  } catch (_) {
    // Backward compatible path if dependency table is not available in a landscape.
    return { byFieldId: {}, byFieldCode: {} }
  }
}

async function getFormDefinition(req) {
  const { processCode, countryCode, roleCode } = req.data || {}

  if (!processCode || !countryCode || !roleCode) {
    req.reject(400, 'Missing params: processCode, countryCode, roleCode')
  }

  const tx = cds.tx(req)

  // 1) Resolver grupos del usuario (IAS + role collections, etc)
  const { resolvedGroups = [], payload } = await resolveGroups(req)

  // (opcional) debug rápido en CF logs
  // console.log('getFormDefinition user=', req.user?.id, 'groups=', resolvedGroups)

  // 2) Buscar proceso
  const process = await _getProcess(tx, processCode)
  if (!process) req.reject(404, `Unknown processCode: ${processCode}`)

  // 3) Resolver processRoleId según (process + roleCode + groups + country scope)
  const processRoleId = await _resolveProcessRoleId(tx, {
    processId: process.ID,
    roleCode,
    countryCode,
    groups: resolvedGroups
  })

  if (!processRoleId) {
    req.reject(
      403,
      `No access: user has no mapping in MDG_IAS_GROUP_ROLE_MAP for process=${processCode}, role=${roleCode}, country=${countryCode}`
    )
  }

  // 4) Traer definición (blocks + fields + fieldControl efectivo + default efectivo + VH metadata)
  const rows = await _readFormFields(tx, {
    processId: process.ID,
    processRoleId,
    countryCode
  })
  const deps = await _readVhDependencies(tx, rows)

  // 5) Respuesta OData: DEVUELVE ARRAY (NO string JSON)
  return rows.map(r => ({
    ...(VH_DEP_DEBUG
      ? (() => {
          const fieldId = String(r.FIELD_ID || '').trim()
          const fieldCode = String(r.FIELD_CODE || '').trim()
          const depsByFieldId = deps.byFieldId[fieldId] || []
          const depsByFieldCode = deps.byFieldCode[fieldCode] || []
          const selectedDependency = depsByFieldId.length ? depsByFieldId : depsByFieldCode
          console.info(
            `[VH_DEP_DEBUG] processCode=${processCode} fieldId=${fieldId} fieldCode=${fieldCode} depsByFieldId=${JSON.stringify(
              depsByFieldId
            )} depsByFieldCode=${JSON.stringify(depsByFieldCode)} selectedDependency=${JSON.stringify(selectedDependency)}`
          )
          return {}
        })()
      : {}),
    processCode,
    countryCode,
    roleCode,
    processRoleId,

    blockId: r.BLOCK_ID,
    blockCode: r.BLOCK_CODE,
    blockName: r.BLOCK_NAME,
    blockOrder: r.BLOCK_ORDER,

    fieldId: r.FIELD_ID,
    fieldCode: r.FIELD_CODE,
    label: r.LABEL,

    sapTable: r.SAP_TABLE,
    sapField: r.SAP_FIELD,
    dataType: r.DATA_TYPE,
    length: r.LENGTH,
    decimals: r.DECIMALS,
    isMulti: r.IS_MULTI,

    fieldControl: r.FIELD_CONTROL,
    defaultValue: _resolveDefaultToken(r.DEFAULT_VALUE, r.DATA_TYPE),

    vhDestination: r.VH_DESTINATION,
    vhService: r.VH_SERVICE,
    vhEntitySet: r.VH_ENTITYSET,
    vhKeyField: r.VH_KEY_FIELD,
    vhTextField: r.VH_TEXT_FIELD,
    vhSearchFields: r.VH_SEARCH_FIELDS,
    vhDependency:
      deps.byFieldId[String(r.FIELD_ID || '').trim()] ||
      deps.byFieldCode[String(r.FIELD_CODE || '').trim()] ||
      []
  }))
}

module.exports = { getFormDefinition }
