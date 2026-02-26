// srv/handlers/process.handler.js
const cds = require('@sap/cds');
const { resolveGroups } = require('./auth.handler');

async function getAvailableProcesses(req) {
  const { countryCode } = req.data;
  const frontCode = typeof req.data?.frontCode === 'string' ? req.data.frontCode.trim() : '';
  const db = await cds.connect.to('db');

  const { MDG_IAS_GROUP_ROLE_MAP, MDG_PROCESS, MDG_COUNTRY_ROLE_SCOPE, MDG_PROCESS_ROLE } = db.entities;

  const { resolvedGroups } = await resolveGroups(req);
  if (!resolvedGroups.length) return JSON.stringify({ ok: true, processes: [] });

  const maps = await db.run(
    SELECT.from(MDG_IAS_GROUP_ROLE_MAP).columns('PROCESS_ID','PROCESS_ROLE_ID')
      .where({ IS_ENABLED: true })
      .and({ IAS_GROUP: { in: resolvedGroups } })
  );
  if (!maps.length) return JSON.stringify({ ok: true, processes: [] });

  const roleIds = [...new Set(maps.map(m => m.PROCESS_ROLE_ID))];

  const scopes = await db.run(
    SELECT.from(MDG_COUNTRY_ROLE_SCOPE).columns('PROCESS_ROLE_ID')
      .where({ COUNTRY_CODE: countryCode, IS_ENABLED: true })
      .and({ PROCESS_ROLE_ID: { in: roleIds } })
  );

  const allowedRoleIds = new Set(scopes.map(s => s.PROCESS_ROLE_ID));
  const allowedProcIds = new Set(
    maps.filter(m => allowedRoleIds.has(m.PROCESS_ROLE_ID)).map(m => m.PROCESS_ID)
  );

  if (!allowedProcIds.size) return JSON.stringify({ ok: true, processes: [] });

  if (frontCode) {
    const requesterRoles = await db.run(
      SELECT.from(MDG_PROCESS_ROLE).columns('PROCESS_ID')
        .where({
          PROCESS_ID: { in: [...allowedProcIds] },
          ROLE_CODE: 'REQUESTER',
          IS_ENABLED: true,
          FRONT_CODE: frontCode
        })
    );

    const frontFilteredProcIds = new Set(requesterRoles.map(r => r.PROCESS_ID));
    if (!frontFilteredProcIds.size) return JSON.stringify({ ok: true, processes: [] });

    for (const procId of [...allowedProcIds]) {
      if (!frontFilteredProcIds.has(procId)) {
        allowedProcIds.delete(procId);
      }
    }
    if (!allowedProcIds.size) return JSON.stringify({ ok: true, processes: [] });
  }

  const procs = await db.run(
    SELECT.from(MDG_PROCESS).columns('ID','PROCESS_CODE','NAME','MASTER_OBJECT_ID','WF_VERSION')
      .where({ ID: { in: [...allowedProcIds] }, IS_ENABLED: true })
      .orderBy('PROCESS_CODE')
  );

  return JSON.stringify({ ok: true, processes: procs });
}

module.exports = { getAvailableProcesses };
