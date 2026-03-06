const cds = require('@sap/cds');

module.exports = cds.service.impl(async function () {

  const vh = require('./handlers/valuehelp-proxy.handler');
  const auth = require('./handlers/auth.handler');
  const process = require('./handlers/process.handler');
  const form = require('./handlers/formDefinition.handler');
  const prefill = require('./handlers/prefill.handler');
  const internalVh = require('./handlers/internal-vh.handler');
  const overviewVh = require('./handlers/overview-vh.handler');
  const overviewEnrichment = require('./handlers/overview-enrichment.handler');
  const readAccess = require('./handlers/read-access.handler');
  const changeLogEnrichment = require('./handlers/change-log-enrichment.handler');
  const s4Metadata = require('./handlers/s4-metadata.handler');
  const requestCrud = require('./handlers/request-crud.handler');
  const comments = require('./handlers/comments.handler');
  const workflowActions = require('./handlers/workflow-action.handler');

  // Turno 3: wire VH_* entitysets to S/4 via destination S4H-TECH
  this.on('READ', 'VH_CustomerGen', vh.readCustomerGen);
  this.on('READ', 'VH_CustomerClassification', vh.readCustomerClassification);
  this.on('READ', 'VH_CustomerOrgV', vh.readCustomerOrgV);
  this.on('READ', 'VH_CustomerVtweg', vh.readCustomerVtweg);
  this.on('READ', 'VH_CustomerSpart', vh.readCustomerSpart);
  this.on('READ', 'VH_CustomerSoc', vh.readCustomerSoc);
  this.on('READ', 'VH_CustomerCom', vh.readCustomerCom);
  this.on('READ', 'VH_CustomerEmp', vh.readCustomerEmp);
  this.on('READ', 'VH_CustomerBan', vh.readCustomerBan);
  this.on('READ', 'VH_CustomerImp', vh.readCustomerImp);
  this.on('READ', 'VH_CustomerNif', vh.readCustomerNif);
  this.on('READ', 'VH_MaterialProduct', vh.readMaterialProduct);
  this.on('READ', 'VH_MaterialSalesOrg', vh.readMaterialSalesOrg);
  this.on('READ', 'VH_MaterialVtweg', vh.readMaterialVtweg);
  this.on('READ', 'VH_DriverGen', vh.readDriverGen);
  this.on('READ', 'VH_DriverRol', vh.readDriverRol);
  this.on('READ', 'VH_DriverCom', vh.readDriverCom);
  this.on('READ', 'VH_DriverImp', vh.readDriverImp);
  this.on('READ', 'VH_DriverNif', vh.readDriverNif);
  this.on('READ', 'VH_DriverAdi', vh.readDriverAdi);
  this.on('READ', 'VH_BillToGen', vh.readBillToGen);
  this.on('READ', 'VH_BillToCom', vh.readBillToCom);
  this.on('READ', 'VH_BillToImp', vh.readBillToImp);
  this.on('READ', 'VH_ShipToGen', vh.readShipToGen);
  this.on('READ', 'VH_ShipToCom', vh.readShipToCom);
  this.on('READ', 'VH_Resources', vh.readResources);
  this.on('READ', 'VH_BU_GROUP', internalVh.readVhBuGroup);
  this.on('READ', 'VH_Internal_TAXKD', internalVh.readVhInternalTaxkd);
  this.on('READ', 'VH_Internal_TATYP', internalVh.readVhInternalTatyp);
  this.on('READ', 'VH_Internal_BU_GROUP', internalVh.readVhInternalBuGroup);
  this.on('READ', 'VH_Internal_KTOKD', internalVh.readVhInternalKtokd);
  this.on('READ', 'VH_Internal_ANRED', internalVh.readVhInternalAnred);
  this.on('READ', 'VH_Internal_BPKIND', internalVh.readVhInternalBpkind);
  this.on('READ', 'VH_Internal_KUKLA', internalVh.readVhInternalKukla);
  this.on('READ', 'VH_Internal_TIME_ZONE', internalVh.readVhInternalTimeZone);
  this.on('READ', 'VH_Internal_LANGU_CORR', internalVh.readVhInternalLanguCorr);
  this.on('READ', 'VH_Internal_DEFLT_COMM', internalVh.readVhInternalDefltComm);
  this.on('READ', 'VH_Internal_ZZBKVID', internalVh.readVhInternalZzbkvid);
  this.on('READ', 'VH_Internal_MAHNA', internalVh.readVhInternalMahna);
  this.on('READ', 'VH_Internal_MAHNS', internalVh.readVhInternalMahns);
  this.on('READ', 'VH_Status', internalVh.readVhStatus);
  this.on('READ', 'VH_AllowedProcesses', overviewVh.readVhAllowedProcesses);

  this.before('READ', 'RequestsOverview', readAccess.beforeReadRequestsOverview);
  this.after('READ', 'RequestsOverview', overviewEnrichment.afterReadRequestsOverview);
  this.before('READ', 'Requests', readAccess.beforeReadRequests);
  this.before('READ', 'RequestValues', readAccess.beforeReadRequestValues);
  this.before('READ', 'RequestComments', readAccess.beforeReadRequestComments);
  this.before('READ', 'RequestFieldChangeLogs', readAccess.beforeReadRequestFieldChangeLogs);
  this.before('READ', 'RequestActions', readAccess.beforeReadRequestActions);
  this.before('READ', 'RequestSapMessages', readAccess.beforeReadRequestSapMessages);
  this.after('READ', 'RequestFieldChangeLogs', changeLogEnrichment.afterReadRequestFieldChangeLogs);

  this.on('whoAmI', auth.whoAmI);
  this.on('getAvailableProcesses', process.getAvailableProcesses);
  this.on('getFormDefinition', form.getFormDefinition);
  this.on('prefillCustomer', prefill.prefillCustomer);
  this.on('fetchS4Metadata', s4Metadata.fetchS4Metadata);

  requestCrud.register(this);
  comments.register(this);
  workflowActions.register(this);

});
