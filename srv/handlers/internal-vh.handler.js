const DATA = {
  VH_BU_GROUP: [
    { CODE: 'Z001', TEXT: 'BP Group Z001' },
    { CODE: 'Z002', TEXT: 'BP Group Z002' },
    { CODE: 'Z003', TEXT: 'BP Group Z003' }
  ],
  VH_Internal_TAXKD: [
    { CODE: '0', TEXT: 'Tax Exempt' },
    { CODE: '1', TEXT: 'Taxable' },
    { CODE: '2', TEXT: 'Reduced Tax' }
  ],
  VH_Internal_BU_GROUP: [
    { CODE: 'Z001', TEXT: 'BP Group Z001' },
    { CODE: 'Z002', TEXT: 'BP Group Z002' },
    { CODE: 'Z003', TEXT: 'BP Group Z003' }
  ],
  VH_Internal_KTOKD: [
    { CODE: 'ZAG1', TEXT: 'Account Group General' },
    { CODE: 'ZAG2', TEXT: 'Account Group Retail' },
    { CODE: 'ZAG3', TEXT: 'Account Group Wholesale' }
  ],
  VH_Internal_ANRED: [
    { CODE: '0001', TEXT: 'Mr.' },
    { CODE: '0002', TEXT: 'Ms.' },
    { CODE: '0003', TEXT: 'Company' }
  ],
  VH_Internal_BPKIND: [
    { CODE: '1', TEXT: 'Natural Person' },
    { CODE: '2', TEXT: 'Legal Entity' },
    { CODE: '3', TEXT: 'Organization' }
  ],
  VH_Internal_KUKLA: [
    { CODE: '01', TEXT: 'Retail Customer' },
    { CODE: '02', TEXT: 'Wholesale Customer' },
    { CODE: '03', TEXT: 'Strategic Account' }
  ],
  VH_Internal_TIME_ZONE: [
    { CODE: 'America/Santiago', TEXT: 'Chile - Santiago' },
    { CODE: 'America/Punta_Arenas', TEXT: 'Chile - Punta Arenas' },
    { CODE: 'UTC', TEXT: 'UTC' }
  ],
  VH_Internal_LANGU_CORR: [
    { CODE: 'ES', TEXT: 'Spanish' },
    { CODE: 'EN', TEXT: 'English' },
    { CODE: 'PT', TEXT: 'Portuguese' }
  ],
  VH_Internal_DEFLT_COMM: [
    { CODE: 'EMAIL', TEXT: 'Email' },
    { CODE: 'PHONE', TEXT: 'Phone' },
    { CODE: 'FAX', TEXT: 'Fax' }
  ]
};

function readStatic(name) {
  return async function readInternalVh() {
    return DATA[name];
  };
}

module.exports = {
  readVhBuGroup: readStatic('VH_BU_GROUP'),
  readVhInternalTaxkd: readStatic('VH_Internal_TAXKD'),
  readVhInternalBuGroup: readStatic('VH_Internal_BU_GROUP'),
  readVhInternalKtokd: readStatic('VH_Internal_KTOKD'),
  readVhInternalAnred: readStatic('VH_Internal_ANRED'),
  readVhInternalBpkind: readStatic('VH_Internal_BPKIND'),
  readVhInternalKukla: readStatic('VH_Internal_KUKLA'),
  readVhInternalTimeZone: readStatic('VH_Internal_TIME_ZONE'),
  readVhInternalLanguCorr: readStatic('VH_Internal_LANGU_CORR'),
  readVhInternalDefltComm: readStatic('VH_Internal_DEFLT_COMM')
};
