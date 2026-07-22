const cds = require('@sap/cds');
const { resolveGroups } = require('../auth.handler');

const ROLE_CODES = Object.freeze({
  REQUESTER: 'REQUESTER',
  ENRICHER: 'ENRICHER',
  APPROVER: 'APPROVER'
});

const STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  IN_REVIEW: 'IN_REVIEW',
  REWORK: 'REWORK',
  APPROVED: 'APPROVED'
});

const FIELD_CONTROL = Object.freeze({
  OPTIONAL: 0,
  MANDATORY: 1,
  READ_ONLY: 3,
  HIDDEN: 7,
  DEFAULT: 0
});

function normalizeStatus(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

function currentUserId(req) {
  return req.user?.id || 'anonymous';
}

function uuid() {
  return cds.utils.uuid();
}

function now() {
  return new Date();
}

function roleToBusinessName(roleCode) {
  return roleCode === ROLE_CODES.APPROVER ? 'MANAGER' : roleCode;
}

function _optionalInClause(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.map(() => '?').join(',');
}

async function getRequestById(tx, requestId) {
  const rows = await tx.run(
    `SELECT "ID", "PROCESS_ID", "MASTER_OBJECT_ID", "COUNTRY_CODE", "STATUS", "ISDELETED"
       FROM "MDG_REQUEST_HEADER"
      WHERE "ID" = ?`,
    [requestId]
  );
  return rows?.[0] || null;
}

async function getRequestValueById(tx, valueId) {
  const rows = await tx.run(
    `SELECT "ID", "REQUEST_ID", "FIELD_ID"
       FROM "MDG_REQUEST_FIELD_VALUE"
      WHERE "ID" = ?`,
    [valueId]
  );
  return rows?.[0] || null;
}

async function getUserRoleAssignments(tx, req, { processId, countryCode }) {
  const { resolvedGroups = [] } = await resolveGroups(req);
  const inGroups = _optionalInClause(resolvedGroups);
  if (!inGroups) return [];

  return tx.run(
    `SELECT DISTINCT
        pr."ID"        AS "PROCESS_ROLE_ID",
        pr."ROLE_CODE" AS "ROLE_CODE"
       FROM "MDG_IAS_GROUP_ROLE_MAP" m
       JOIN "MDG_PROCESS_ROLE" pr
         ON pr."ID" = m."PROCESS_ROLE_ID"
      WHERE m."PROCESS_ID" = ?
        AND m."IS_ENABLED" = true
        AND pr."IS_ENABLED" = true
        AND m."IAS_GROUP" IN (${inGroups})
        AND (
          NOT EXISTS (
            SELECT 1
              FROM "MDG_COUNTRY_ROLE_SCOPE" s0
             WHERE s0."PROCESS_ROLE_ID" = pr."ID"
               AND s0."IS_ENABLED" = true
          )
          OR EXISTS (
            SELECT 1
              FROM "MDG_COUNTRY_ROLE_SCOPE" s1
             WHERE s1."PROCESS_ROLE_ID" = pr."ID"
               AND s1."COUNTRY_CODE" = ?
               AND s1."IS_ENABLED" = true
          )
        )`,
    [processId, ...resolvedGroups, countryCode]
  );
}

function findAssignment(assignments, roleCode) {
  return assignments.find((a) => a.ROLE_CODE === roleCode) || null;
}

function resolveEditorRoleFromStatus(assignments, status) {
  if ([STATUS.DRAFT, STATUS.REWORK].includes(status)) {
    return findAssignment(assignments, ROLE_CODES.REQUESTER);
  }
  if (status === STATUS.IN_REVIEW) {
    return findAssignment(assignments, ROLE_CODES.ENRICHER);
  }
  return null;
}

function resolvePreferredRoleForComment(assignments, status) {
  const available = new Set(assignments.map((a) => a.ROLE_CODE));

  const preference = {
    [STATUS.DRAFT]: [ROLE_CODES.REQUESTER, ROLE_CODES.ENRICHER, ROLE_CODES.APPROVER],
    [STATUS.REWORK]: [ROLE_CODES.REQUESTER, ROLE_CODES.ENRICHER, ROLE_CODES.APPROVER],
    [STATUS.SUBMITTED]: [ROLE_CODES.ENRICHER, ROLE_CODES.APPROVER, ROLE_CODES.REQUESTER],
    [STATUS.IN_REVIEW]: [ROLE_CODES.ENRICHER, ROLE_CODES.APPROVER, ROLE_CODES.REQUESTER],
    [STATUS.APPROVED]: [ROLE_CODES.APPROVER, ROLE_CODES.ENRICHER, ROLE_CODES.REQUESTER]
  };

  const ordered = preference[status] || [ROLE_CODES.REQUESTER, ROLE_CODES.ENRICHER, ROLE_CODES.APPROVER];
  const roleCode = ordered.find((r) => available.has(r));
  return roleCode ? findAssignment(assignments, roleCode) : null;
}

async function getEffectiveFieldControl(tx, { processRoleId, countryCode, fieldId }) {
  const rows = await tx.run(
    `SELECT COALESCE(fcc."FIELD_CONTROL_OVERRIDE", fcb."FIELD_CONTROL_BASE", ${FIELD_CONTROL.DEFAULT}) AS "FIELD_CONTROL"
       FROM "DUMMY"
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_BASE" fcb
         ON fcb."PROCESS_ROLE_ID" = ?
        AND fcb."FIELD_ID" = ?
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_COUNTRY" fcc
         ON fcc."PROCESS_ROLE_ID" = ?
        AND fcc."FIELD_ID" = ?
        AND fcc."COUNTRY_CODE" = ?`,
    [processRoleId, fieldId, processRoleId, fieldId, countryCode]
  );

  return Number(rows?.[0]?.FIELD_CONTROL ?? FIELD_CONTROL.DEFAULT);
}

async function validateMandatoryFieldsOnSubmit(tx, { requestId, processId, processRoleId, countryCode }) {
  const processRows = await tx.run(
    `SELECT "PROCESS_CODE"
       FROM "MDG_PROCESS"
      WHERE "ID" = ?`,
    [processId]
  );
  const processCode = String(processRows?.[0]?.PROCESS_CODE || '').trim().toUpperCase();

  const mandatoryRows = await tx.run(
    `SELECT DISTINCT
        fc."ID"         AS "FIELD_ID",
        fc."FIELD_CODE" AS "FIELD_CODE",
        ob."BLOCK_CODE" AS "BLOCK_CODE"
       FROM "MDG_PROCESS_BLOCK" pb
       JOIN "MDG_OBJECT_BLOCK" ob
         ON ob."ID" = pb."BLOCK_ID"
       JOIN "MDG_BLOCK_FIELD" bf
         ON bf."BLOCK_ID" = pb."BLOCK_ID"
       JOIN "MDG_FIELD_CATALOG" fc
         ON fc."ID" = bf."FIELD_ID"
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_BASE" fcb
         ON fcb."PROCESS_ROLE_ID" = ?
        AND fcb."FIELD_ID" = fc."ID"
       LEFT JOIN "MDG_FIELD_CONTROL_RULE_COUNTRY" fcc
         ON fcc."PROCESS_ROLE_ID" = ?
        AND fcc."FIELD_ID" = fc."ID"
        AND fcc."COUNTRY_CODE" = ?
      WHERE pb."PROCESS_ID" = ?
        AND COALESCE(fcc."FIELD_CONTROL_OVERRIDE", fcb."FIELD_CONTROL_BASE", ${FIELD_CONTROL.DEFAULT}) = ${FIELD_CONTROL.MANDATORY}`,
    [processRoleId, processRoleId, countryCode, processId]
  );

  if (!mandatoryRows.length) return;

  let scopedMandatoryRows = mandatoryRows;

  // Optional subflows in CUSTOMER_CREATION are controlled by request flags.
  if (processCode === 'CUSTOMER_CREATION') {
    const flagRows = await tx.run(
      `SELECT c."FIELD_CODE" AS "FIELD_CODE", v."VALUE" AS "VALUE"
         FROM "MDG_REQUEST_FIELD_VALUE" v
         JOIN "MDG_FIELD_CATALOG" c ON c."ID" = v."FIELD_ID"
        WHERE v."REQUEST_ID" = ?
          AND v."LINE_NO" = 1
          AND c."FIELD_CODE" IN ('MDG_CTRL.CREATE_DESTFACT', 'MDG_CTRL.EXTEND_DESTFACT_SALES')`,
      [requestId]
    );
    const flagByCode = new Map(
      (flagRows || []).map((r) => [
        String(r.FIELD_CODE || '').trim().toUpperCase(),
        String(r.VALUE || '').trim().toLowerCase()
      ])
    );
    const isTruthy = (v) => ['true', '1', 'x', 'y', 'yes', 'si', 'sí'].includes(v || '');
    const createDestFact = isTruthy(flagByCode.get('MDG_CTRL.CREATE_DESTFACT'));
    const extendDestFactSales = isTruthy(flagByCode.get('MDG_CTRL.EXTEND_DESTFACT_SALES'));

    scopedMandatoryRows = scopedMandatoryRows.filter((row) => {
      const blockCode = String(row.BLOCK_CODE || '').trim().toUpperCase();
      if (blockCode === 'CUST_DESTFACT_GEN') return createDestFact;
      if (blockCode === 'CUST_DESTFACT_SALES') return createDestFact && extendDestFactSales;
      return true;
    });
  }

  if (!scopedMandatoryRows.length) return;

  const targetRows = await tx.run(
    `SELECT "ID", "IS_ENABLED"
       FROM "MDG_SAP_TARGET"
      WHERE "PROCESS_ID" = ?
        AND UPPER(COALESCE("OPERATION", 'POST')) = 'POST'`,
    [processId]
  );
  const hasAnyTarget = (targetRows || []).length > 0;
  if (hasAnyTarget && scopedMandatoryRows.length) {
    const enabledTargetIds = new Set(
      (targetRows || [])
        .filter((r) => !!r.IS_ENABLED)
        .map((r) => String(r.ID || '').trim())
        .filter(Boolean)
    );
    const fieldIds = scopedMandatoryRows.map((r) => String(r.FIELD_ID || '').trim()).filter(Boolean);
    if (fieldIds.length) {
      const inClause = fieldIds.map(() => '?').join(',');
      const mapRows = await tx.run(
        `SELECT DISTINCT "FIELD_ID", "SAP_TARGET_ID"
           FROM "MDG_SAP_PAYLOAD_MAP"
          WHERE "PROCESS_ID" = ?
            AND "FIELD_ID" IN (${inClause})`,
        [processId, ...fieldIds]
      );
      const mappedByField = new Map();
      for (const row of mapRows || []) {
        const fieldId = String(row.FIELD_ID || '').trim();
        const targetId = String(row.SAP_TARGET_ID || '').trim();
        if (!fieldId || !targetId) continue;
        if (!mappedByField.has(fieldId)) mappedByField.set(fieldId, new Set());
        mappedByField.get(fieldId).add(targetId);
      }

      scopedMandatoryRows = scopedMandatoryRows.filter((row) => {
        const fieldId = String(row.FIELD_ID || '').trim();
        const mappedTargets = mappedByField.get(fieldId);
        // If field is not mapped to SAP payload, keep legacy behavior and validate it.
        if (!mappedTargets || mappedTargets.size === 0) return true;
        // Validate only if field participates in at least one enabled target.
        for (const targetId of mappedTargets) {
          if (enabledTargetIds.has(targetId)) return true;
        }
        return false;
      });
    }
  }

  if (!scopedMandatoryRows.length) return;

  const fieldIds = scopedMandatoryRows.map((r) => r.FIELD_ID);
  const inClause = fieldIds.map(() => '?').join(',');

  const values = await tx.run(
    `SELECT
        "FIELD_ID" AS "FIELD_ID",
        MAX(CASE WHEN "VALUE" IS NOT NULL AND LENGTH(TRIM("VALUE")) > 0 THEN 1 ELSE 0 END) AS "HAS_VALUE"
       FROM "MDG_REQUEST_FIELD_VALUE"
      WHERE "REQUEST_ID" = ?
        AND "FIELD_ID" IN (${inClause})
      GROUP BY "FIELD_ID"`,
    [requestId, ...fieldIds]
  );

  const hasValue = new Set(values.filter((v) => Number(v.HAS_VALUE) === 1).map((v) => v.FIELD_ID));
  const missing = scopedMandatoryRows.filter((f) => !hasValue.has(f.FIELD_ID));

  if (missing.length > 0) {
    const missingCodes = missing.map((m) => m.FIELD_CODE).join(', ');
    const err = new Error(`Mandatory fields missing: ${missingCodes}`);
    err.statusCode = 400;
    throw err;
  }
}

async function insertActionLog(tx, { requestId, action, actorUser, actorRole, comment }) {
  try {
    const safeComment = comment == null ? null : String(comment).slice(0, 1000);
    await tx.run(
      `INSERT INTO "MDG_REQUEST_ACTION_LOG"
       ("ID", "REQUEST_ID", "ACTION", "ACTOR_USER", "ACTOR_ROLE", "COMMENT", "CREATEDAT")
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), requestId, action, actorUser, actorRole, safeComment, now()]
    );
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('mdg_request_action_log') && (msg.includes('invalid table') || msg.includes('not found') || msg.includes('does not exist'))) {
      return;
    }
    throw err;
  }
}

async function upsertApprovalTaskOnSubmit(tx, { requestId, processId, actorUser }) {
  try {
    const roleRows = await tx.run(
      `SELECT "ID"
         FROM "MDG_PROCESS_ROLE"
        WHERE "PROCESS_ID" = ?
          AND "ROLE_CODE" = 'APPROVER'
          AND "IS_ENABLED" = true
        ORDER BY "ID"`,
      [processId]
    );
    const approverRoleId = roleRows?.[0]?.ID;
    if (!approverRoleId) return;

    const existing = await tx.run(
      `SELECT "ID"
         FROM "MDG_REQUEST_APPROVAL_TASK"
        WHERE "REQUEST_ID" = ?
          AND "PROCESS_ROLE_ID" = ?
        ORDER BY "CREATEDAT" DESC`,
      [requestId, approverRoleId]
    );

    if (existing?.length) {
      await tx.run(
        `UPDATE "MDG_REQUEST_APPROVAL_TASK"
            SET "TASK_STATUS" = 'PENDING',
                "ASSIGNED_TO" = NULL,
                "DECISION_AT" = NULL,
                "COMMENT" = NULL,
                "MODIFIEDAT" = ?,
                "MODIFIEDBY" = ?
          WHERE "ID" = ?`,
        [now(), actorUser, existing[0].ID]
      );
      return;
    }

    await tx.run(
      `INSERT INTO "MDG_REQUEST_APPROVAL_TASK"
       ("ID", "REQUEST_ID", "PROCESS_ROLE_ID", "TASK_STATUS", "ASSIGNED_TO", "DECISION_AT", "COMMENT", "CREATEDAT", "CREATEDBY", "MODIFIEDAT", "MODIFIEDBY")
       VALUES (?, ?, ?, 'PENDING', NULL, NULL, NULL, ?, ?, ?, ?)`,
      [uuid(), requestId, approverRoleId, now(), actorUser, now(), actorUser]
    );
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('mdg_request_approval_task') && (msg.includes('invalid table') || msg.includes('not found') || msg.includes('does not exist'))) {
      return;
    }
    throw err;
  }
}

async function updateApprovalTaskOnDecision(tx, { requestId, processRoleId, decision, comment, actorUser }) {
  try {
    const rows = await tx.run(
      `SELECT "ID"
         FROM "MDG_REQUEST_APPROVAL_TASK"
        WHERE "REQUEST_ID" = ?
          AND "PROCESS_ROLE_ID" = ?
        ORDER BY "CREATEDAT" DESC`,
      [requestId, processRoleId]
    );

    if (!rows.length) return;

    await tx.run(
      `UPDATE "MDG_REQUEST_APPROVAL_TASK"
          SET "TASK_STATUS" = ?,
              "DECISION_AT" = ?,
              "COMMENT" = ?,
              "MODIFIEDAT" = ?,
              "MODIFIEDBY" = ?
        WHERE "ID" = ?`,
      [decision, now(), comment || null, now(), actorUser, rows[0].ID]
    );
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('mdg_request_approval_task') && (msg.includes('invalid table') || msg.includes('not found') || msg.includes('does not exist'))) {
      return;
    }
    throw err;
  }
}

async function insertComment(tx, { requestId, authorUser, authorRole, message }) {
  await tx.run(
    `INSERT INTO "MDG_REQUEST_COMMENT"
     ("ID", "REQUEST_ID", "AUTHOR_USER", "AUTHOR_ROLE", "MESSAGE", "CREATEDAT", "CREATEDBY")
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), requestId, authorUser, authorRole, message, now(), authorUser]
  );
}

module.exports = {
  FIELD_CONTROL,
  ROLE_CODES,
  STATUS,
  currentUserId,
  findAssignment,
  getEffectiveFieldControl,
  getRequestById,
  getRequestValueById,
  getUserRoleAssignments,
  insertActionLog,
  insertComment,
  normalizeStatus,
  now,
  resolveEditorRoleFromStatus,
  resolvePreferredRoleForComment,
  roleToBusinessName,
  updateApprovalTaskOnDecision,
  upsertApprovalTaskOnSubmit,
  uuid,
  validateMandatoryFieldsOnSubmit
};
