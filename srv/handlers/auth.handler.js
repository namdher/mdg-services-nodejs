// srv/handlers/auth.handler.js
const { getIASGroups } = require('./ias-scim.client');

function uniq(a){ return [...new Set((a||[]).filter(Boolean))]; }

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
  return {};
}

async function resolveGroups(req){
  const payload = tokenPayload(req);

  const samlGroups = payload?.["xs.system.attributes"]?.["xs.saml.groups"] || [];
  const roleCollections = payload?.["xs.system.attributes"]?.["xs.rolecollections"] || [];

  const resolvedGroups = [...new Set([].concat(samlGroups).concat(roleCollections).filter(Boolean))];

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