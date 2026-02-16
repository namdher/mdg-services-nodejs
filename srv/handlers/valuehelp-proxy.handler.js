const { s4Get } = require('./_lib/s4.client');
const { getQueryOptions, pickODataOptions } = require('./_lib/odata.util');

// Stable mapping of CAP VH_* entitysets -> S/4 OData services/entity sets
const VH_MAP = {
  VH_CustomerGen:  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS',  entitySet: 'zcds_clientes_gen'  },
  VH_CustomerOrgV: { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS', entitySet: 'zcds_clientes_orgv' },
  VH_CustomerSoc:  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_SOC_CDS',  entitySet: 'zcds_clientes_soc'  },
  VH_CustomerBan:  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_BAN_CDS',  entitySet: 'zcds_clientes_ban'  },
  VH_CustomerImp:  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_IMP_CDS',  entitySet: 'zcds_clientes_Imp'  },
  VH_CustomerNif:  { servicePath: '/sap/opu/odata/sap/ZCDS_CLIENTES_NIF_CDS',  entitySet: 'zcds_clientes_nif'  }
};

async function readVH(req, vhName) {
  const cfg = VH_MAP[vhName];
  if (!cfg) req.reject(500, `VH mapping not found for ${vhName}`);

  const q = pickODataOptions(getQueryOptions(req));

  // Guardrails: limit default top to avoid huge calls
  if (q.$top === undefined) q.$top = 50;

  return await s4Get({ servicePath: cfg.servicePath, entitySet: cfg.entitySet, query: q });
}

module.exports = {
  readCustomerGen:  (req) => readVH(req, 'VH_CustomerGen'),
  readCustomerOrgV: (req) => readVH(req, 'VH_CustomerOrgV'),
  readCustomerSoc:  (req) => readVH(req, 'VH_CustomerSoc'),
  readCustomerBan:  (req) => readVH(req, 'VH_CustomerBan'),
  readCustomerImp:  (req) => readVH(req, 'VH_CustomerImp'),
  readCustomerNif:  (req) => readVH(req, 'VH_CustomerNif')
};
