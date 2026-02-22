const cds = require('@sap/cds');

module.exports = cds.service.impl(async function () {

  const vh = require('./handlers/valuehelp-proxy.handler');
  const auth = require('./handlers/auth.handler');
  const process = require('./handlers/process.handler');
  const form = require('./handlers/formDefinition.handler')

  // Turno 3: wire VH_* entitysets to S/4 via destination S4H-TECH
  this.on('READ', 'VH_CustomerGen', vh.readCustomerGen);
  this.on('READ', 'VH_CustomerOrgV', vh.readCustomerOrgV);
  this.on('READ', 'VH_CustomerSoc', vh.readCustomerSoc);
  this.on('READ', 'VH_CustomerBan', vh.readCustomerBan);
  this.on('READ', 'VH_CustomerImp', vh.readCustomerImp);
  this.on('READ', 'VH_CustomerNif', vh.readCustomerNif);

  this.on('whoAmI', async (req) => auth.whoAmI(req));
  this.on('getAvailableProcesses', process.getAvailableProcesses);

  this.on('getFormDefinition', form.getFormDefinition)

});
