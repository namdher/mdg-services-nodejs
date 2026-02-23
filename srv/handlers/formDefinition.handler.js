const cds = require('@sap/cds')

// OJO: ajusta el path según tu proyecto real.
// Tú ya tienes resolveGroups porque lo usaste en whoAmI.
const { resolveGroups } = require('./auth.handler')

const DEFAULT_FIELD_CONTROL = 0

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

  // 5) Respuesta OData: DEVUELVE ARRAY (NO string JSON)
  return rows.map(r => ({
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
    defaultValue: r.DEFAULT_VALUE,

    vhDestination: r.VH_DESTINATION,
    vhService: r.VH_SERVICE,
    vhEntitySet: r.VH_ENTITYSET,
    vhKeyField: r.VH_KEY_FIELD,
    vhTextField: r.VH_TEXT_FIELD,
    vhSearchFields: r.VH_SEARCH_FIELDS
  }))
}

module.exports = { getFormDefinition }
