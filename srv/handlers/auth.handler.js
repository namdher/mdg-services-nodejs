// srv/handlers/auth.handler.js
function uniq(a){ return [...new Set((a || []).filter(Boolean))]; }

let _loggedNoGroupsOnce = false;

function extractBearerToken(req) {
  const candidates = [
    req?.headers?.authorization,
    req?.headers?.['x-forwarded-authorization'],
    req?.req?.headers?.authorization,
    req?.req?.headers?.['x-forwarded-authorization'],
    req?._?.req?.headers?.authorization,
    req?._?.req?.headers?.['x-forwarded-authorization']
  ];

  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;

    const bearer = value.match(/^Bearer\s+(.+)$/i);
    if (bearer?.[1]) return bearer[1].trim();

    if (value.split('.').length === 3) return value;
  }
  return null;
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};

    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    return {};
  }
}

function tokenPayload(req){
  const ti = req?._?.req?.authInfo?.getTokenInfo?.();
  if (ti && typeof ti.getPayload === 'function') {
    const p = ti.getPayload();
    if (p && Object.keys(p).length) return p;
  }
  if (ti && typeof ti.getClaims === 'function') {
    const c = ti.getClaims();
    if (c && Object.keys(c).length) return c;
  }

  const token = extractBearerToken(req);
  if (token) {
    const decoded = decodeJwtPayload(token);
    if (decoded && Object.keys(decoded).length) return decoded;
  }
  return {};
}

async function resolveGroups(req){
  const token = extractBearerToken(req);
  const payload = tokenPayload(req);

  const samlGroupsRaw = payload?.["xs.system.attributes"]?.["xs.saml.groups"];
  const roleCollectionsRaw = payload?.["xs.system.attributes"]?.["xs.rolecollections"];

  const samlGroups = Array.isArray(samlGroupsRaw) ? samlGroupsRaw : [];
  const roleCollections = Array.isArray(roleCollectionsRaw) ? roleCollectionsRaw : [];
  const resolvedGroups = uniq([...samlGroups, ...roleCollections]);

  if (token && resolvedGroups.length === 0 && !_loggedNoGroupsOnce) {
    console.warn('TOKEN_DECODED_BUT_NO_GROUPS');
    _loggedNoGroupsOnce = true;
  }

  return {
    payload,
    iasGroups: samlGroups,
    roleCollections,
    resolvedGroups
  };
}

async function whoAmI(req){
  const { payload, iasGroups, roleCollections, resolvedGroups } = await resolveGroups(req);

  // DEBUG: imprime completo en logs (CF logs)
  console.log("JWT FULL PAYLOAD =", JSON.stringify(payload, null, 2));

  return JSON.stringify({
    ok: true,
    user: {
      id: req.user?.id || payload.user_name || payload.sub,
      sub: payload.sub,
      email: payload.email,
      name: payload.given_name || payload.name
    },
    tokenDebug: {
      tokenUserId: payload.user_id,
      tokenUserName: payload.user_name,
      tokenEmail: payload.email
    },
    claims: {
      ias_groups: iasGroups,
      xs_rolecollections: roleCollections
    },
    resolvedGroups,
    payloadKeys: Object.keys(payload || {}).slice(0, 80),

    // DEBUG: payload completo (quitar luego)
    payload
  });
}

module.exports = { tokenPayload, resolveGroups, whoAmI };
