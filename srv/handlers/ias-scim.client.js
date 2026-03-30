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
function isUuidLike(v){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || '').trim());
}

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

  const scimId = p.user_id || null;
  const sub = p.sub || null;
  const userUuid = p.user_uuid || null;
  const configuredLoginClaim = String(process.env.MDG_IAS_LOGIN_CLAIM || 'login_name').trim();
  const loginName = p[configuredLoginClaim] || p.login_name || null;
  const userName = p.user_name || null;
  const email = p.email || null;

  const ias = await cds.connect.to('IAS_SCIM');
  const debug = { scimId, sub, userUuid, loginName, userName, email, byId:null, byUserName:null };

  let resolvedUser = null;

  // 1) by-id with UUID-like identifiers from token
  const idCandidates = [scimId, sub, userUuid]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .filter((v) => !isEmail(v) && isUuidLike(v));
  for (const id of idCandidates) {
    try {
      const user = await getUserById(ias, id);
      debug.byId = { ok:true, used:`/service/scim/Users/${id}`, scimUserId:user?.id, userName:user?.userName };
      resolvedUser = user || null;
      return { groups: normalizeGroups(user), user: resolvedUser, debug };
    } catch (e) {
      debug.byId = { ok:false, used:`/service/scim/Users/${id}`, status: e.statusCode || e.status, message: e.message };
    }
  }

  // 2) fallback: search strictly by userName/login (never by email)
  const userNameCandidates = [loginName, userName]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .filter((v) => !isEmail(v));
  for (const key of userNameCandidates) {
    try {
      const user = await findUserByUserName(ias, key);
      debug.byUserName = { ok:true, used:key, found:!!user, scimUserId:user?.id, userName:user?.userName };
      resolvedUser = user || null;
      return { groups: normalizeGroups(user), user: resolvedUser, debug };
    } catch (e) {
      debug.byUserName = { ok:false, used:key, status: e.statusCode || e.status, message: e.message };
    }
  }

  return { groups: [], user: null, debug: { ...debug, ok:false, reason:'No SCIM user resolved (id/login only)' } };
}

async function getIASUser(req) {
  const { user = null, debug = {} } = await getIASGroups(req);
  return { user, debug };
}

module.exports = { getIASGroups, getIASUser };
