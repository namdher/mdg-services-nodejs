const cds = require('@sap/cds');

module.exports = cds.service.impl(async function () {

  const vh = require('./handlers/valuehelp-proxy.handler');
  const auth = require('./handlers/auth.handler');
  const process = require('./handlers/process.handler');
  const form = require('./handlers/formDefinition.handler');
  const s4Metadata = require('./handlers/s4-metadata.handler');
  const requestCrud = require('./handlers/request-crud.handler');
  const comments = require('./handlers/comments.handler');
  const workflowActions = require('./handlers/workflow-action.handler');

  // Turno 3: wire VH_* entitysets to S/4 via destination S4H-TECH
  this.on('READ', 'VH_CustomerGen', vh.readCustomerGen);
  this.on('READ', 'VH_CustomerOrgV', vh.readCustomerOrgV);
  this.on('READ', 'VH_CustomerSoc', vh.readCustomerSoc);
  this.on('READ', 'VH_CustomerCom', vh.readCustomerCom);
  this.on('READ', 'VH_CustomerEmp', vh.readCustomerEmp);
  this.on('READ', 'VH_CustomerBan', vh.readCustomerBan);
  this.on('READ', 'VH_CustomerImp', vh.readCustomerImp);
  this.on('READ', 'VH_CustomerNif', vh.readCustomerNif);
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

  this.on('whoAmI', auth.whoAmI);
  this.on('getAvailableProcesses', process.getAvailableProcesses);
  this.on('getFormDefinition', form.getFormDefinition);
  this.on('fetchS4Metadata', s4Metadata.fetchS4Metadata);

  requestCrud.register(this);
  comments.register(this);
  workflowActions.register(this);

});
