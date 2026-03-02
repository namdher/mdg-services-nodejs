function getQueryOptions(req) {
  const rawCandidates = [
    req?._?.query,
    req?._?.req?.query,
    req?.req?.query,
    req?._?.req?._query
  ];
  const out = {};

  const copyQuery = (q) => {
    if (!q || typeof q !== 'object') return;
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || v === null || v === '') continue;
      if (k.startsWith('$')) out[k] = v;
      else if (k === 'top' || k === 'skip' || k === 'select' || k === 'filter' || k === 'search' || k === 'orderby' || k === 'expand') {
        out[`$${k}`] = v;
      }
    }
  };

  for (const q of rawCandidates) copyQuery(q);

  const rawUrls = [
    req?._?.req?.originalUrl,
    req?._?.req?.url,
    req?.req?.originalUrl,
    req?.req?.url
  ];
  for (const rawUrl of rawUrls) {
    if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.includes('?')) continue;
    const qs = rawUrl.slice(rawUrl.indexOf('?') + 1);
    const params = new URLSearchParams(qs);
    for (const [k, v] of params.entries()) {
      if (!k) continue;
      if (k.startsWith('$')) out[k] = v;
      else if (k === 'top' || k === 'skip' || k === 'select' || k === 'filter' || k === 'search' || k === 'orderby' || k === 'expand') {
        out[`$${k}`] = v;
      }
    }
  }

  return out;
}

function pickODataOptions(q) {
  const allowed = ['$top','$skip','$select','$filter','$search','$orderby','$expand'];
  const out = {};
  for (const k of allowed) if (q[k] !== undefined) out[k] = q[k];
  return out;
}

function encodeQuery(q) {
  const parts = [];
  for (const [k, v] of Object.entries(q || {})) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function _dequote(value) {
  const s = String(value ?? '').trim();
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function _evalAtom(row, atom) {
  const expr = String(atom || '').trim();
  if (!expr) return true;

  // substringof('abc',Field)
  const sub = expr.match(/^substringof\(\s*'((?:''|[^'])*)'\s*,\s*([A-Za-z0-9_]+)\s*\)$/i);
  if (sub) {
    const needle = _dequote(`'${sub[1]}'`).toLowerCase();
    const field = sub[2];
    const hay = String(row?.[field] ?? '').toLowerCase();
    return hay.includes(needle);
  }

  // contains(Field,'abc')
  const contains = expr.match(/^contains\(\s*([A-Za-z0-9_]+)\s*,\s*'((?:''|[^'])*)'\s*\)$/i);
  if (contains) {
    const field = contains[1];
    const needle = _dequote(`'${contains[2]}'`).toLowerCase();
    const hay = String(row?.[field] ?? '').toLowerCase();
    return hay.includes(needle);
  }

  // startswith(Field,'abc')
  const startsWith = expr.match(/^startswith\(\s*([A-Za-z0-9_]+)\s*,\s*'((?:''|[^'])*)'\s*\)$/i);
  if (startsWith) {
    const field = startsWith[1];
    const needle = _dequote(`'${startsWith[2]}'`).toLowerCase();
    const hay = String(row?.[field] ?? '').toLowerCase();
    return hay.startsWith(needle);
  }

  // Field eq 'value'  or Field eq 123
  const eq = expr.match(/^([A-Za-z0-9_]+)\s+eq\s+(.+)$/i);
  if (eq) {
    const field = eq[1];
    const right = eq[2].trim();
    const rhs = right.startsWith("'") ? _dequote(right) : right;
    return String(row?.[field] ?? '') === String(rhs);
  }

  // If we do not understand the expression, do not block results.
  return true;
}

function applyLocalFilter(rows, filterExpr) {
  const src = Array.isArray(rows) ? rows : [];
  const f = String(filterExpr || '').trim();
  if (!f) return src;

  // Basic support for SmartFilterBar patterns: OR groups of AND atoms.
  const orParts = f.split(/\s+or\s+/i).map((x) => x.trim()).filter(Boolean);
  return src.filter((row) => {
    for (const orPart of orParts) {
      const andParts = orPart.split(/\s+and\s+/i).map((x) => x.trim()).filter(Boolean);
      const ok = andParts.every((atom) => _evalAtom(row, atom));
      if (ok) return true;
    }
    return false;
  });
}

function applyLocalPaging(rows, top, skip) {
  const s = Number(skip || 0);
  const t = top === undefined ? undefined : Number(top);
  const start = Number.isFinite(s) && s > 0 ? s : 0;
  const sliced = rows.slice(start);
  if (t === undefined || !Number.isFinite(t) || t < 0) return sliced;
  return sliced.slice(0, t);
}

module.exports = { getQueryOptions, pickODataOptions, encodeQuery, applyLocalFilter, applyLocalPaging };
