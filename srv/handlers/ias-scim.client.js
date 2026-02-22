// srv/handlers/ias-scim.client.js
const cds = require('@sap/cds');

function payload(req){
  return req?._?.req?.authInfo?.getTokenInfo?.()?.getPayload?.() || {};
}

function headersSCIM(){
  return {
    Accept: 'application/scim+json',
    'Content-Type': 'application/scim+json'
  };
}

function normalizeGroups(user){
  return (user?.groups || []).map(g => g?.value || g?.display).filter(Boolean);
}

function isEmail(v){ return String(v||'').includes('@'); }

async function scimGet(ias, path){
  return await ias.send({ method:'GET', path, headers: headersSCIM() });
}

async function getUserById(ias, id){
  return await scimGet(ias, `/service/scim/Users/${encodeURIComponent(id)}`);
}

// IAS suele soportar filter por userName (tu tenant rechaza emails.value)
async function findUserByUserName(ias, userName){
  const filters = [
    `userName eq "${String(userName).replace(/"/g,'\\"')}"`,
    `userName eq '${String(userName).replace(/'/g,"\\'")}'`
  ];

  let lastErr = null;
  for (const f of filters) {
    const path = `/service/scim/Users?filter=${encodeURIComponent(f)}&startIndex=1&count=1`;
    try {
      const res = await scimGet(ias, path);
      return res?.Resources?.[0] || null;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function getIASGroups(req){
  const p = payload(req);

  const scimId = p.user_id || null;            // a veces NO es SCIM id, lo veremos con debug
  const userName = p.user_name || null;        // normalmente el email
  const email = p.email || null;

  const ias = await cds.connect.to('IAS_SCIM');
  const debug = { scimId, userName, email, byId:null, byUserName:null };

  // 1) by-id si user_id parece un ID usable (no email y no vacío)
  if (scimId && !isEmail(scimId)) {
    try {
      const user = await getUserById(ias, scimId);
      debug.byId = { ok:true, used:`/service/scim/Users/${scimId}`, scimUserId:user?.id, userName:user?.userName };
      return { groups: normalizeGroups(user), debug };
    } catch (e) {
      debug.byId = { ok:false, status: e.statusCode || e.status, message: e.message };
    }
  }

  // 2) fallback: search by userName (email normalmente)
  const key = userName || email;
  if (key) {
    try {
      const user = await findUserByUserName(ias, key);
      debug.byUserName = { ok:true, found:!!user, scimUserId:user?.id, userName:user?.userName };
      return { groups: normalizeGroups(user), debug };
    } catch (e) {
      debug.byUserName = { ok:false, status: e.statusCode || e.status, message: e.message };
    }
  }

  return { groups: [], debug: { ...debug, ok:false, reason:'No SCIM user resolved' } };
}

module.exports = { getIASGroups };