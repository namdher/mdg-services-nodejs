const cds = require('@sap/cds');
let _requestResultsRouteRegistered = false;
let _vhMappingsValidated = false;

module.exports = cds.service.impl(async function () {

  const vh = require('./handlers/valuehelp-proxy.handler');
  if (!_vhMappingsValidated) {
    _vhMappingsValidated = true;
    await vh.validateVhMappingsOnStartup();
  }
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
  this.on('READ', 'VH_CustomerLzone', vh.readCustomerLzone);
  this.on('READ', 'VH_CustomerRegion', vh.readCustomerRegion);
  this.on('READ', 'VH_Country', vh.readCountry);
  this.on('READ', 'VH_OwnerBP', vh.readOwnerBp);
  this.on('READ', 'VH_TransportistaBP', vh.readTransportistaBp);
  this.on('READ', 'VH_CustomerPaymentCondition', vh.readCustomerPaymentCondition);
  this.on('READ', 'VH_CustomerBzirk', vh.readCustomerBzirk);
  this.on('READ', 'VH_SalesGroup', vh.readSalesGroup);
  this.on('READ', 'VH_SalesOffice', vh.readSalesOffice);
  this.on('READ', 'VH_CustomerGroup8', vh.readCustomerGroup8);
  this.on('READ', 'VH_CustomerDunningArea', vh.readCustomerDunningArea);
  this.on('READ', 'VH_DestMercBP', vh.readDestMercBP);
  this.on('READ', 'VH_DestMercOrgV', vh.readDestMercOrgV);
  this.on('READ', 'VH_DestMercVtweg', vh.readDestMercVtweg);
  this.on('READ', 'VH_DestMercSpart', vh.readDestMercSpart);
  this.on('READ', 'VH_DestMercBzirk', vh.readDestMercBzirk);
  this.on('READ', 'VH_DestMercSoc', vh.readDestMercSoc);
  this.on('READ', 'VH_DestMercDunningArea', vh.readDestMercDunningArea);
  this.on('READ', 'VH_DestMercPaymentCondition', vh.readDestMercPaymentCondition);
  this.on('READ', 'VH_DestMercImp', vh.readDestMercImp);
  this.on('READ', 'VH_DestFactBP', vh.readDestFactBP);
  this.on('READ', 'VH_DestFactSalesOrg', vh.readDestFactSalesOrg);
  this.on('READ', 'VH_DestFactVtweg', vh.readDestFactVtweg);
  this.on('READ', 'VH_DestMercBanks', vh.readDestMercBanks);
  this.on('READ', 'VH_DestMercBank', vh.readDestMercBank);
  this.on('READ', 'VH_DestMercLzone', vh.readDestMercLzone);
  this.on('READ', 'VH_DestMercRegion', vh.readDestMercRegion);
  this.on('READ', 'VH_CustomerSoc', vh.readCustomerSoc);
  this.on('READ', 'VH_CustomerCom', vh.readCustomerCom);
  this.on('READ', 'VH_CustomerEmp', vh.readCustomerEmp);
  this.on('READ', 'VH_CustomerBan', vh.readCustomerBan);
  this.on('READ', 'VH_CustomerImp', vh.readCustomerImp);
  this.on('READ', 'VH_CustomerNif', vh.readCustomerNif);
  this.on('READ', 'VH_MaterialProduct', vh.readMaterialProduct);
  this.on('READ', 'VH_MaterialSalesOrg', vh.readMaterialSalesOrg);
  this.on('READ', 'VH_MaterialVtweg', vh.readMaterialVtweg);
  this.on('READ', 'VH_MaterialKtgrm', vh.readMaterialKtgrm);
  this.on('READ', 'VH_MaterialUoM', vh.readMaterialUoM);
  this.on('READ', 'VH_DriverGen', vh.readDriverGen);
  this.on('READ', 'VH_DriverRol', vh.readDriverRol);
  this.on('READ', 'VH_DriverCom', vh.readDriverCom);
  this.on('READ', 'VH_DriverImp', vh.readDriverImp);
  this.on('READ', 'VH_DriverNif', vh.readDriverNif);
  this.on('READ', 'VH_DriverAdi', vh.readDriverAdi);
  this.on('READ', 'VH_DriverRelationshipBP', vh.readDriverRelationshipBp);
  this.on('READ', 'VH_BillToGen', vh.readBillToGen);
  this.on('READ', 'VH_BillToCom', vh.readBillToCom);
  this.on('READ', 'VH_BillToImp', vh.readBillToImp);
  this.on('READ', 'VH_ShipToGen', vh.readShipToGen);
  this.on('READ', 'VH_ShipToCom', vh.readShipToCom);
  this.on('READ', 'VH_Resources', vh.readResources);
  this.on('READ', 'VH_ResourceTransportationType', vh.readResourceTransportationType);
  this.on('READ', 'VH_ResourceLocation', vh.readResourceLocation);
  this.on('READ', 'VH_BU_GROUP', internalVh.readVhBuGroup);
  this.on('READ', 'VH_Internal_TAXKD', internalVh.readVhInternalTaxkd);
  this.on('READ', 'VH_Internal_Boolean', internalVh.readVhInternalBoolean);
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
  this.on('READ', 'VH_Internal_MABER', internalVh.readVhInternalMaber);
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
  this.on('getRequestResults', workflowActions.getRequestResults);
  this.on('getFormDefinition', form.getFormDefinition);
  this.on('prefillCustomer', prefill.prefillCustomer);
  this.on('fetchS4Metadata', s4Metadata.fetchS4Metadata);

  requestCrud.register(this);
  comments.register(this);
  workflowActions.register(this);

  if (!_requestResultsRouteRegistered) {
    _requestResultsRouteRegistered = true;
    const srv = this;
    const registerRequestResultsRoute = (app) => {
      app.get('/mdg/request-results', async (req, res) => {
        const requestId = String(req.query?.requestId || '').trim();
        if (!requestId) {
          res.status(400).json({
            error: {
              code: '400',
              message: { lang: 'en', value: 'requestId is required' },
              severity: 'error'
            }
          });
          return;
        }
        try {
          const result = await srv.send({
            event: 'getRequestResults',
            data: { requestId }
          });
          res.status(200).json(result || []);
        } catch (err) {
          const status = Number(err?.statusCode || 500);
          res.status(status).json({
            error: {
              code: String(status),
              message: { lang: 'en', value: String(err?.message || 'Internal Server Error') },
              severity: 'error'
            }
          });
        }
      });
    };
    if (cds.app) registerRequestResultsRoute(cds.app);
    else cds.on('bootstrap', registerRequestResultsRoute);
  }

});
