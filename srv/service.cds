using { MDG_REQUEST_HEADER, MDG_REQUEST_FIELD_VALUE, MDG_REQUEST_COMMENT, MDG_REQUEST_FIELD_CHANGE_LOG, MDG_REQUEST_ACTION_LOG, MDG_REQUEST_SAP_MESSAGE, MDG_FIELD_CATALOG, MDG_PROCESS } from '../db/model';

service MDGService @(path:'/mdg') {

  entity Requests      as projection on MDG_REQUEST_HEADER;
  entity RequestsOverview as select from MDG_REQUEST_HEADER as r
    left join MDG_PROCESS as p on p.ID = r.PROCESS_ID {
      key r.ID as ID,
      r.PROCESS_ID,
      r.FRONT_CODE,
      p.PROCESS_CODE as PROCESS_CODE,
      p.NAME as PROCESS_NAME,
      r.COUNTRY_CODE,
      r.STATUS,
      cast(
        case
          when r.STATUS = 'DRAFT' then 'Borrador'
          when r.STATUS = 'IN_REVIEW' then 'En revisión'
          when r.STATUS = 'REWORK' then 'Devuelto'
          when r.STATUS = 'APPROVED' then 'Aprobado'
          when r.STATUS = 'SUBMITTED' then 'Enviado'
          else r.STATUS
        end
      as String(30)) as STATUS_TEXT,
      r.SUBJECT_ID,
      r.SUBJECT_NAME,
      cast('' as String(1000)) as LAST_COMMENT,
      cast('' as String(40)) as LAST_MANAGER_DECISION,
      cast('' as String(255)) as LAST_MANAGER_USER,
      r.CREATEDAT,
      r.CREATEDBY,
      r.MODIFIEDAT,
      r.MODIFIEDBY,
      r.ISDELETED
  };
  entity RequestValues as projection on MDG_REQUEST_FIELD_VALUE;
  entity RequestComments as projection on MDG_REQUEST_COMMENT;
  entity RequestActions as projection on MDG_REQUEST_ACTION_LOG;
  entity RequestSapMessages as projection on MDG_REQUEST_SAP_MESSAGE;
  @readonly entity RequestFieldChangeLogs as select from MDG_REQUEST_FIELD_CHANGE_LOG as l
    left join MDG_FIELD_CATALOG as fc on fc.ID = l.FIELD_ID {
      key l.ID,
      l.REQUEST_ID,
      l.FIELD_ID,
      l.FIELD_CODE,
      cast(
        case
          when fc.BUSINESS_LABEL is not null and length(trim(fc.BUSINESS_LABEL)) > 0 then fc.BUSINESS_LABEL
          when l.FIELD_CODE = 'MDG_REQUEST_HEADER.CREATE' then 'Evento de creación'
          when l.FIELD_CODE = 'MDG_REQUEST_HEADER.STATUS' then 'Estado'
          when l.FIELD_CODE = 'MDG_REQUEST_HEADER.SUBJECT_ID' then 'Cliente'
          when l.FIELD_CODE = 'MDG_REQUEST_HEADER.SUBJECT_TYPE' then 'Tipo de sujeto'
          when l.FIELD_CODE = 'MDG_REQUEST_HEADER.ISDELETED' then 'Eliminación de solicitud'
          when l.FIELD_CODE = 'MDG_REQUEST_COMMENT.MESSAGE' then 'Comentario'
          else l.FIELD_CODE
        end
      as String(200)) as FIELD_LABEL,
      l.LINE_NO,
      l.OLD_VALUE,
      l.NEW_VALUE,
      l.CHANGE_TYPE,
      cast(
        case
          when l.CHANGE_TYPE = 'CREATE' then 'Creación'
          when l.CHANGE_TYPE = 'UPDATE' then 'Actualización'
          when l.CHANGE_TYPE = 'DELETE' then 'Eliminación'
          else l.CHANGE_TYPE
        end
      as String(40)) as CHANGE_TYPE_TEXT,
      l.CHANGED_AT,
      l.CHANGED_BY,
      l.CHANGED_ROLE,
      cast(
        case
          when l.CHANGED_ROLE = 'REQUESTER' then 'Solicitante'
          when l.CHANGED_ROLE = 'ENRICHER' then 'Enriquecedor'
          when l.CHANGED_ROLE = 'APPROVER' then 'Manager'
          else l.CHANGED_ROLE
        end
      as String(40)) as CHANGED_ROLE_TEXT,
      l.SOURCE,
      cast(
        case
          when l.SOURCE = 'REQUEST_CREATE' then 'Creación solicitud'
          when l.SOURCE = 'REQUEST_UPDATE' then 'Actualización solicitud'
          when l.SOURCE = 'REQUEST_DELETE' then 'Eliminación solicitud'
          when l.SOURCE = 'REQUEST_VALUE_CREATE' then 'Creación valor'
          when l.SOURCE = 'REQUEST_VALUE_UPDATE' then 'Actualización valor'
          when l.SOURCE = 'REQUEST_VALUE_DELETE' then 'Eliminación valor'
          when l.SOURCE = 'REQUEST_COMMENT_CREATE' then 'Comentario'
          when l.SOURCE = 'WORKFLOW_APPROVE' then 'Aprobación'
          when l.SOURCE = 'WORKFLOW_REJECT' then 'Rechazo'
          when l.SOURCE = 'PREFILL_CUSTOMER' then 'Prefill cliente'
          else l.SOURCE
        end
      as String(80)) as SOURCE_TEXT
  };

  @cds.persistence.skip @readonly entity VH_CustomerGen {
    key BusinessPartner         : String(10);
    BusinessPartnerName     : String(80);
    BusinessPartnerCategory : String(2);
    Kunnr   : String(10);
    Partner : String(10);
    Name1   : String(80);
  }

  @cds.persistence.skip @readonly entity VH_CustomerOrgV {
    key SalesOrganization       : String(4);
    SalesOrganization_Text  : String(80);
    Kunnr     : String(10);
    Vtweg     : String(2);
    VtwegText : String(80);
    Spart     : String(2);
    SpartText : String(80);
  }

  @cds.persistence.skip @readonly entity VH_CustomerVtweg {
    key ProductDistributionChnl : String(2);
    ProductSalesOrg         : String(4);
    Country                 : String(3);
  }

  @cds.persistence.skip @readonly entity VH_CustomerSpart {
    key Division    : String(2);
    Division_Text : String(80);
    DivisionOID : String(40);
  }

  @cds.persistence.skip @readonly entity VH_CustomerSoc {
    key CompanyCode       : String(4);
    CompanyCodeName   : String(80);
    Kunnr     : String(10);
    Maber     : String(2);
    MaberText : String(80);
    DunningArea       : String(2);
    DunningArea_Text  : String(80);
  }

  @cds.persistence.skip @readonly entity VH_CustomerDunningArea {
    key DunningArea                 : String(2);
    DunningArea_Text                : String(120);
    CompanyCode                     : String(4);
  }

  @cds.persistence.skip @readonly entity VH_CustomerCom {
    key ID      : String(200);
    Kunnr       : String(10);
    Parnr       : String(10);
    Name1       : String(80);
    SMTP_ADDR   : String(241);
    TEL_NUMBER  : String(30);
  }

  @cds.persistence.skip @readonly entity VH_CustomerEmp {
    key ID    : String(200);
    Kunnr     : String(10);
    Bukrs     : String(4);
    Ekorg     : String(4);
    Vkorg     : String(4);
  }

  @cds.persistence.skip @readonly entity VH_CustomerBan {
    key ID    : String(200);
    Kunnr     : String(10);
    Banks     : String(3);
    Bankl     : String(15);
    Bankn     : String(18);
    EbppAccname : String(120);
    Country      : String(3);
    Country_Text : String(120);
    Bank         : String(15);
    BankInternalID : String(15);
  }

  @cds.persistence.skip @readonly entity VH_CustomerImp {
    key ID    : String(200);
    Kunnr     : String(10);
    Aland     : String(3);
    Tatyp     : String(4);
  }

  @cds.persistence.skip @readonly entity VH_CustomerLzone {
    key TransportZone               : String(10);
    TransportZoneDescription        : String(120);
    CountryCode                     : String(3);
    TransportZone_Text              : String(120);
  }

  @cds.persistence.skip @readonly entity VH_CustomerRegion {
    key Region                      : String(3);
    Region_Text                     : String(120);
    ProvincialTaxCode               : String(30);
  }

  @cds.persistence.skip @readonly entity VH_Country {
    key Country                     : String(3);
    Country_Text                    : String(120);
  }

  @cds.persistence.skip @readonly entity VH_OwnerBP {
    key BusinessPartner             : String(10);
    key BusinessPartnerRole         : String(6);
    BusinessPartnerName             : String(120);
  }

  @cds.persistence.skip @readonly entity VH_TransportistaBP {
    key BusinessPartner             : String(10);
    key BusinessPartnerRole         : String(6);
    BusinessPartnerName             : String(120);
  }

  @cds.persistence.skip @readonly entity VH_DriverRelationshipBP {
    key RelatedBusinessPartner      : String(10);
    SourceBusinessPartner           : String(10);
    BusinessPartnerRole             : String(6);
    RelationshipCategory            : String(6);
  }

  @cds.persistence.skip @readonly entity VH_CustomerPaymentCondition {
    key PaymentCondition            : String(4);
    PaymentCondition_Text           : String(120);
    PaymentTerms                    : String(4);
  }

  @cds.persistence.skip @readonly entity VH_CustomerBzirk {
    key SalesDistrict               : String(6);
    SalesDistrict_Text              : String(120);
  }

  @cds.persistence.skip @readonly entity VH_SalesGroup {
    key SalesGroup                  : String(3);
    SalesGroup_Text                 : String(20);
  }

  @cds.persistence.skip @readonly entity VH_SalesOffice {
    key SalesOffice                 : String(4);
    SalesOrganization               : String(4);
    DistributionChannel             : String(2);
    OrganizationDivision            : String(2);
  }

  @cds.persistence.skip @readonly entity VH_CustomerGroup8 {
    key CustomerGroup8              : String(3);
    CustomerGroup8Name              : String(20);
    SalesOrganization               : String(4);
  }

  @cds.persistence.skip @readonly entity VH_DestMercBP {
    key BusinessPartner             : String(10);
    BusinessPartnerCategory         : String(2);
    BusinessPartnerName             : String(120);
  }

  @cds.persistence.skip @readonly entity VH_DestMercOrgV {
    key SalesOrganization           : String(4);
    SalesOrganization_Text          : String(80);
  }

  @cds.persistence.skip @readonly entity VH_DestMercVtweg {
    key ProductDistributionChnl     : String(2);
    ProductSalesOrg                 : String(4);
    Country                         : String(3);
  }

  @cds.persistence.skip @readonly entity VH_DestMercSpart {
    key Division                    : String(2);
    Division_Text                   : String(80);
    DivisionOID                     : String(40);
  }

  @cds.persistence.skip @readonly entity VH_DestMercBzirk {
    key SalesDistrict               : String(6);
    SalesDistrict_Text              : String(120);
  }

  @cds.persistence.skip @readonly entity VH_DestMercSoc {
    key CompanyCode                 : String(4);
    CompanyCodeName                 : String(80);
  }

  @cds.persistence.skip @readonly entity VH_DestMercDunningArea {
    key DunningArea                 : String(2);
    DunningArea_Text                : String(120);
    CompanyCode                     : String(4);
  }

  @cds.persistence.skip @readonly entity VH_DestMercPaymentCondition {
    key PaymentCondition            : String(4);
    PaymentCondition_Text           : String(120);
    PaymentTerms                    : String(4);
  }

  @cds.persistence.skip @readonly entity VH_DestMercImp {
    key Aland                       : String(3);
    Tatyp                           : String(4);
  }

  @cds.persistence.skip @readonly entity VH_DestFactBP {
    key BusinessPartner             : String(10);
    BusinessPartnerCategory         : String(2);
    BusinessPartnerName             : String(120);
  }

  @cds.persistence.skip @readonly entity VH_DestFactSalesOrg {
    key SalesOrganization           : String(4);
    SalesOrganization_Text          : String(80);
    SalesOrganizationCurrency       : String(5);
    CompanyCode                     : String(4);
  }

  @cds.persistence.skip @readonly entity VH_DestFactVtweg {
    key ProductDistributionChnl     : String(2);
    Country                         : String(3);
    ProductSalesOrg                 : String(4);
  }

  @cds.persistence.skip @readonly entity VH_DestMercBanks {
    key Country                     : String(3);
    Country_Text                    : String(120);
  }

  @cds.persistence.skip @readonly entity VH_DestMercBank {
    key Bank                        : String(15);
    BankInternalID                  : String(15);
    BankCountry                     : String(3);
  }

  @cds.persistence.skip @readonly entity VH_DestMercLzone {
    key TransportZone               : String(10);
    CountryCode                     : String(3);
    TransportZoneDescription        : String(120);
    TransportZone_Text              : String(120);
  }

  @cds.persistence.skip @readonly entity VH_DestMercRegion {
    key Region                      : String(3);
    Region_Text                     : String(120);
    Country                         : String(3);
  }

  @cds.persistence.skip @readonly entity VH_CustomerNif {
    key ID      : String(200);
    Kunnr       : String(10);
    Taxtype     : String(4);
  }

  @cds.persistence.skip @readonly entity VH_CustomerClassification {
    key CustomerClassification      : String(2);
    CustomerClassification_Text     : String(20);
  }

  @cds.persistence.skip @readonly entity VH_MaterialProduct {
    key Material        : String(40);
    Material_Text       : String(120);
  }

  @cds.persistence.skip @readonly entity VH_MaterialSalesOrg {
    key SalesOrganization      : String(4);
    SalesOrganization_Text     : String(80);
  }

  @cds.persistence.skip @readonly entity VH_MaterialVtweg {
    key ProductDistributionChnl      : String(2);
    ProductSalesOrg                  : String(4);
    Country                          : String(3);
  }

  @cds.persistence.skip @readonly entity VH_MaterialKtgrm {
    key AcctAssignmentGroup           : String(4);
    Description                       : String(120);
  }

  @cds.persistence.skip @readonly entity VH_MaterialUoM {
    key UnitOfMeasure                 : String(3);
    UnitOfMeasure_Text                : String(120);
  }

  @cds.persistence.skip @readonly entity VH_DriverGen {
    key Kunnr               : String(10);
    Name1Text               : String(80);
    Transportista           : String(10);
    TransportistaName       : String(81);
  }

  @cds.persistence.skip @readonly entity VH_DriverRol {
    key Kunnr       : String(10);
    key Bp_Role     : String(6);
    key Role        : String(4);
    key Dfval       : String(20);
    ValidFrom   : String(40);
  }

  @cds.persistence.skip @readonly entity VH_DriverCom {
    key ID      : String(200);
    Kunnr       : String(10);
    Vkorg       : String(4);
    Vtweg       : String(2);
    Spart       : String(2);
    Ernam       : String(12);
    Erdat       : String(40);
  }

  @cds.persistence.skip @readonly entity VH_DriverImp {
    key ID      : String(200);
    Kunnr       : String(10);
    Aland       : String(3);
    Tatyp       : String(4);
    Taxkd       : String(1);
  }

  @cds.persistence.skip @readonly entity VH_DriverNif {
    key ID      : String(200);
    Kunnr       : String(10);
    Taxtype     : String(4);
    Taxnum      : String(20);
    Taxnumxl    : String(60);
  }

  @cds.persistence.skip @readonly entity VH_DriverAdi {
    key Kunnr   : String(10);
    Driver_Group: String(4);
    ShortDriverId: String(6);
  }

  @cds.persistence.skip @readonly entity VH_BillToGen {
    key Kunnr   : String(10);
    Name1       : String(80);
    Name2       : String(80);
  }

  @cds.persistence.skip @readonly entity VH_BillToCom {
    key ID      : String(200);
    Kunnr       : String(10);
    Vkorg       : String(4);
    Vtweg       : String(2);
    Spart       : String(2);
    Ernam       : String(12);
    Erdat       : String(40);
  }

  @cds.persistence.skip @readonly entity VH_BillToImp {
    key ID      : String(200);
    Kunnr       : String(10);
    Aland       : String(3);
    Tatyp       : String(4);
    Taxkd       : String(1);
  }

  @cds.persistence.skip @readonly entity VH_ShipToGen {
    key Kunnr   : String(10);
    Name1       : String(80);
    Name2       : String(80);
  }

  @cds.persistence.skip @readonly entity VH_ShipToCom {
    key ID      : String(200);
    Kunnr       : String(10);
    Vkorg       : String(4);
    Vtweg       : String(2);
    Spart       : String(2);
    Ernam       : String(12);
    Erdat       : String(40);
  }

  @cds.persistence.skip @readonly entity VH_Resources {
    key ID      : String(200);
    Resuid      : String(10);
    Simversid   : String(4);
    Simsessid   : String(10);
    Name        : String(120);
    ResourceGroup : String(60);
  }

  @cds.persistence.skip @readonly entity VH_ResourceTransportationType {
    key TransportationType : String(10);
    Description            : String(40);
  }

  @cds.persistence.skip @readonly entity VH_ResourceLocation {
    key LocationNumber : String(20);
    LocationType       : String(4);
    Description        : String(40);
  }

  @cds.persistence.skip @readonly entity VH_BU_GROUP {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_TAXKD {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_Boolean {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_TATYP {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_BU_GROUP {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_KTOKD {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_ANRED {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_BPKIND {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_KUKLA {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_TIME_ZONE {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_LANGU_CORR {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_DEFLT_COMM {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_ZZBKVID {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_MAHNA {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_MABER {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Internal_MAHNS {
    key CODE : String(40);
    TEXT     : String(120);
  }

  @cds.persistence.skip @readonly entity VH_Status {
    key CODE : String(30);
    TEXT     : String(80);
  }

  @cds.persistence.skip @readonly entity VH_AllowedProcesses {
    key ID          : UUID;
    PROCESS_CODE    : String(80);
    NAME            : String(150);
    FRONT_CODE      : String(30);
  }

  action approveRequest(ID : String(36), COMMENT : String(1000)) returns LargeString;
  action rejectRequest(ID : String(36), COMMENT : String(1000)) returns LargeString;
  action syncCustomerDestinationAddress(ID : String(36)) returns Integer;
  action prefillCustomer(
    requestId   : UUID,
    subjectId   : String(60),
    countryCode : String(3),
    subjectFieldCode : String(80)
  ) returns LargeString;
  action fetchS4Metadata(servicePath : String) returns LargeString;
  action whoAmI() returns LargeString;
  action getAvailableProcesses(countryCode : String(3), frontCode : String(30)) returns LargeString;
  type RequestResultItem : {
    stepCode      : String(80);
    status        : String(20);
    externalId    : String(80);
    message       : String(400);
    targetCode    : String(60);
    entitySet     : String(120);
    correlationId : String(100);
    createdAt     : Timestamp;
  };
  function getRequestResults(requestId : UUID) returns array of RequestResultItem;
  type FormFieldRuntime : {
    processCode    : String(80);
    countryCode    : String(3);
    roleCode       : String(30);
    processRoleId  : UUID;

    blockId        : UUID;
    blockCode      : String(60);
    blockName      : String(120);
    blockOrder     : Integer;

    fieldId        : UUID;
    fieldCode      : String(80);
    label          : String(200);

    sapTable       : String(30);
    sapField       : String(30);
    dataType       : String(30);
    length         : Integer;
    decimals       : Integer;
    isMulti        : Boolean;

    fieldControl   : Integer;      // 0/1/3/7
    defaultValue   : String(500);

    vhDestination  : String(120);
    vhService      : String(200);
    vhEntitySet    : String(120);
    vhKeyField     : String(60);
    vhTextField    : String(60);
    vhSearchFields : String(500);
  };

  action getFormDefinition(
    processCode : String(80),
    countryCode : String(3),
    roleCode    : String(30)
  ) returns array of FormFieldRuntime;
}

annotate MDGService.Requests with {
  SUBJECT_ID @Common.ValueList: {
    CollectionPath: 'VH_CustomerGen',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: SUBJECT_ID, ValueListProperty: 'Kunnr' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Name1' }
    ]
  };
};

annotate MDGService.RequestsOverview with @UI.LineItem: [
  { $Type: 'UI.DataField', Value: PROCESS_NAME, Label: 'Proceso' },
  { $Type: 'UI.DataField', Value: STATUS_TEXT, Label: 'Estado' },
  { $Type: 'UI.DataField', Value: SUBJECT_ID, Label: 'ID Maestro' },
  { $Type: 'UI.DataField', Value: SUBJECT_NAME, Label: 'Nombre' },
  { $Type: 'UI.DataField', Value: LAST_COMMENT, Label: 'Último comentario' },
  { $Type: 'UI.DataField', Value: LAST_MANAGER_DECISION, Label: 'Última decisión' },
  { $Type: 'UI.DataField', Value: LAST_MANAGER_USER, Label: 'Manager' },
  { $Type: 'UI.DataField', Value: CREATEDAT, Label: 'Creado' },
  { $Type: 'UI.DataField', Value: CREATEDBY, Label: 'Creado por' },
  { $Type: 'UI.DataField', Value: MODIFIEDAT, Label: 'Modificado' }
];

annotate MDGService.RequestsOverview with @UI.SelectionFields: [
  PROCESS_ID,
  STATUS,
  SUBJECT_ID
];

annotate MDGService.RequestsOverview with {
  PROCESS_CODE @UI.Hidden: true;
  FRONT_CODE @UI.Hidden: true;
  PROCESS_ID @Common.Label: 'Proceso';
  PROCESS_ID @Common.ValueList: {
    CollectionPath: 'VH_AllowedProcesses',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: PROCESS_ID, ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterIn', LocalDataProperty: FRONT_CODE, ValueListProperty: 'FRONT_CODE' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'PROCESS_CODE' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'NAME' }
    ]
  };
  PROCESS_ID @Common.Text: PROCESS_NAME;
  PROCESS_ID @Common.TextArrangement: #TextOnly;
  PROCESS_NAME @Common.Label: 'Proceso';
  STATUS @Common.Label: 'Estado';
  STATUS @Common.ValueListWithFixedValues: true;
  STATUS @Common.ValueList: {
    CollectionPath: 'VH_Status',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: STATUS, ValueListProperty: 'CODE' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'TEXT' }
    ]
  };
  STATUS @Common.Text: STATUS_TEXT;
  STATUS @Common.TextArrangement: #TextOnly;
  STATUS_TEXT @Common.Label: 'Estado';
  SUBJECT_ID @Common.Label: 'ID Maestro';
  SUBJECT_NAME @Common.Label: 'Nombre';
  LAST_COMMENT @Common.Label: 'Último comentario';
  LAST_MANAGER_DECISION @Common.Label: 'Última decisión';
  LAST_MANAGER_USER @Common.Label: 'Manager';
  CREATEDAT @Common.Label: 'Creado';
  CREATEDBY @Common.Label: 'Creado por';
  MODIFIEDAT @Common.Label: 'Modificado';
};

annotate MDGService.VH_Status with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Estado';
};

annotate MDGService.VH_AllowedProcesses with {
  ID @Common.Label: 'ID Proceso';
  PROCESS_CODE @Common.Label: 'Código Proceso';
  NAME @Common.Label: 'Proceso';
  FRONT_CODE @UI.Hidden: true;
  FRONT_CODE @Common.Label: 'Frente';
};

annotate MDGService.RequestFieldChangeLogs with @UI.LineItem: [
  { $Type: 'UI.DataField', Value: REQUEST_ID, Label: 'Solicitud' },
  { $Type: 'UI.DataField', Value: FIELD_LABEL, Label: 'Campo' },
  { $Type: 'UI.DataField', Value: CHANGE_TYPE_TEXT, Label: 'Tipo cambio' },
  { $Type: 'UI.DataField', Value: OLD_VALUE, Label: 'Valor anterior' },
  { $Type: 'UI.DataField', Value: NEW_VALUE, Label: 'Valor nuevo' },
  { $Type: 'UI.DataField', Value: CHANGED_BY, Label: 'Usuario' },
  { $Type: 'UI.DataField', Value: CHANGED_ROLE_TEXT, Label: 'Rol' },
  { $Type: 'UI.DataField', Value: SOURCE_TEXT, Label: 'Origen' },
  { $Type: 'UI.DataField', Value: CHANGED_AT, Label: 'Fecha' }
];

annotate MDGService.RequestFieldChangeLogs with @UI.SelectionFields: [
  REQUEST_ID,
  FIELD_CODE,
  CHANGE_TYPE,
  CHANGED_BY,
  SOURCE,
  CHANGED_AT
];

annotate MDGService.RequestFieldChangeLogs with {
  REQUEST_ID @Common.Label: 'Solicitud';
  FIELD_ID @Common.Label: 'ID Campo';
  FIELD_CODE @UI.Hidden: true;
  FIELD_CODE @Common.Label: 'Campo';
  FIELD_LABEL @Common.Label: 'Campo';
  LINE_NO @Common.Label: 'Línea';
  OLD_VALUE @Common.Label: 'Valor anterior';
  NEW_VALUE @Common.Label: 'Valor nuevo';
  CHANGE_TYPE @UI.Hidden: true;
  CHANGE_TYPE @Common.Label: 'Tipo cambio';
  CHANGE_TYPE_TEXT @Common.Label: 'Tipo cambio';
  CHANGED_AT @Common.Label: 'Fecha';
  CHANGED_BY @Common.Label: 'Usuario';
  CHANGED_ROLE @UI.Hidden: true;
  CHANGED_ROLE @Common.Label: 'Rol';
  CHANGED_ROLE_TEXT @Common.Label: 'Rol';
  SOURCE @UI.Hidden: true;
  SOURCE @Common.Label: 'Origen';
  SOURCE_TEXT @Common.Label: 'Origen';
};

annotate MDGService.VH_CustomerGen with {
  BusinessPartner @Common.Label: 'Socio comercial';
  BusinessPartnerName @Common.Label: 'Nombre';
  BusinessPartnerCategory @Common.Label: 'Categoría';
  Kunnr @Common.Label: 'Cliente';
  Partner @Common.Label: 'Socio';
  Name1 @Common.Label: 'Razón social';
};

annotate MDGService.VH_CustomerOrgV with {
  SalesOrganization @Common.Label: 'Organización de ventas';
  SalesOrganization_Text @Common.Label: 'Descripción';
  Kunnr @Common.Label: 'Cliente';
  Vtweg @Common.Label: 'Canal';
  VtwegText @Common.Label: 'Descripción canal';
  Spart @Common.Label: 'Sector';
  SpartText @Common.Label: 'Descripción sector';
};

annotate MDGService.VH_CustomerVtweg with {
  ProductDistributionChnl @Common.Label: 'Canal de distribución';
  ProductSalesOrg @Common.Label: 'Organización de ventas';
  Country @Common.Label: 'País';
};

annotate MDGService.VH_CustomerSpart with {
  Division @Common.Label: 'Sector';
  Division_Text @Common.Label: 'Descripción';
  DivisionOID @Common.Label: 'Identificador';
};

annotate MDGService.VH_CustomerSoc with {
  CompanyCode @Common.Label: 'Sociedad';
  CompanyCodeName @Common.Label: 'Nombre de sociedad';
  Kunnr @Common.Label: 'Cliente';
  Maber @Common.Label: 'Área de reclamación';
  MaberText @Common.Label: 'Descripción área';
  DunningArea @Common.Label: 'Área de reclamación';
  DunningArea_Text @Common.Label: 'Descripción';
};

annotate MDGService.VH_CustomerDunningArea with {
  DunningArea @Common.Label: 'Área de reclamación';
  DunningArea_Text @Common.Label: 'Descripción';
  CompanyCode @Common.Label: 'Sociedad';
};

annotate MDGService.VH_CustomerCom with {
  Kunnr @Common.Label: 'Cliente';
  Parnr @Common.Label: 'Socio';
  Name1 @Common.Label: 'Razón social';
  SMTP_ADDR @Common.Label: 'Correo electrónico';
  TEL_NUMBER @Common.Label: 'Teléfono';
};

annotate MDGService.VH_CustomerEmp with {
  Kunnr @Common.Label: 'Cliente';
  Bukrs @Common.Label: 'Sociedad';
  Ekorg @Common.Label: 'Organización de compras';
  Vkorg @Common.Label: 'Organización de ventas';
};

annotate MDGService.VH_CustomerBan with {
  Kunnr @Common.Label: 'Cliente';
  Banks @Common.Label: 'País banco';
  Bankl @Common.Label: 'Banco';
  Bankn @Common.Label: 'Cuenta bancaria';
  EbppAccname @Common.Label: 'Titular';
  Country @Common.Label: 'País';
  Country_Text @Common.Label: 'Descripción país';
  Bank @Common.Label: 'Banco';
  BankInternalID @Common.Label: 'ID banco';
};

annotate MDGService.VH_CustomerImp with {
  Kunnr @Common.Label: 'Cliente';
  Aland @Common.Label: 'País';
  Tatyp @Common.Label: 'Clave';
};

annotate MDGService.VH_CustomerLzone with {
  TransportZone @Common.Label: 'Zona de transporte';
  TransportZoneDescription @Common.Label: 'Descripción';
  CountryCode @Common.Label: 'País';
  TransportZone_Text @Common.Label: 'Texto';
};

annotate MDGService.VH_CustomerRegion with {
  Region @Common.Label: 'Región';
  Region_Text @Common.Label: 'Descripción';
  ProvincialTaxCode @Common.Label: 'Código fiscal provincial';
};

annotate MDGService.VH_Country with {
  Country @Common.Label: 'País';
  Country_Text @Common.Label: 'Descripción';
};

annotate MDGService.VH_OwnerBP with {
  BusinessPartner @Common.Label: 'Socio comercial';
  BusinessPartnerRole @Common.Label: 'Rol';
  BusinessPartnerName @Common.Label: 'Nombre';
};

annotate MDGService.VH_TransportistaBP with {
  BusinessPartner @Common.Label: 'Transportista';
  BusinessPartnerRole @Common.Label: 'Rol';
  BusinessPartnerName @Common.Label: 'Nombre transportista';
};

annotate MDGService.VH_CustomerPaymentCondition with {
  PaymentCondition @Common.Label: 'Condición de pago';
  PaymentCondition_Text @Common.Label: 'Descripción';
  PaymentTerms @Common.Label: 'Términos de pago';
};

annotate MDGService.VH_CustomerBzirk with {
  SalesDistrict @Common.Label: 'Distrito de ventas';
  SalesDistrict_Text @Common.Label: 'Descripción';
};

annotate MDGService.VH_SalesGroup with {
  SalesGroup @Common.Label: 'Grupo de vendedores';
  SalesGroup_Text @Common.Label: 'Descripción';
};

annotate MDGService.VH_SalesOffice with {
  SalesOffice @Common.Label: 'Oficina de ventas';
  SalesOrganization @Common.Label: 'Organización de ventas';
  DistributionChannel @Common.Label: 'Canal de distribución';
  OrganizationDivision @Common.Label: 'Sector';
};

annotate MDGService.VH_CustomerGroup8 with {
  CustomerGroup8 @Common.Label: 'Nivel de imagen';
  CustomerGroup8Name @Common.Label: 'Descripción';
  SalesOrganization @Common.Label: 'Organización de ventas';
};

annotate MDGService.VH_DestMercBP with {
  BusinessPartner @Common.Label: 'Socio comercial';
  BusinessPartnerCategory @Common.Label: 'Categoría';
  BusinessPartnerName @Common.Label: 'Nombre';
};

annotate MDGService.VH_DestMercOrgV with {
  SalesOrganization @Common.Label: 'Organización de ventas';
  SalesOrganization_Text @Common.Label: 'Descripción';
};

annotate MDGService.VH_DestMercVtweg with {
  ProductDistributionChnl @Common.Label: 'Canal de distribución';
  ProductSalesOrg @Common.Label: 'Organización de ventas';
  Country @Common.Label: 'País';
};

annotate MDGService.VH_DestMercSpart with {
  Division @Common.Label: 'Sector';
  Division_Text @Common.Label: 'Descripción';
  DivisionOID @Common.Label: 'Identificador';
};

annotate MDGService.VH_DestMercBzirk with {
  SalesDistrict @Common.Label: 'Distrito de ventas';
  SalesDistrict_Text @Common.Label: 'Descripción';
};

annotate MDGService.VH_DestMercSoc with {
  CompanyCode @Common.Label: 'Sociedad';
  CompanyCodeName @Common.Label: 'Nombre de sociedad';
};

annotate MDGService.VH_DestMercDunningArea with {
  DunningArea @Common.Label: 'Área de reclamación';
  DunningArea_Text @Common.Label: 'Descripción';
  CompanyCode @Common.Label: 'Sociedad';
};

annotate MDGService.VH_DestMercPaymentCondition with {
  PaymentCondition @Common.Label: 'Condición de pago';
  PaymentCondition_Text @Common.Label: 'Descripción';
  PaymentTerms @Common.Label: 'Términos de pago';
};

annotate MDGService.VH_DestMercImp with {
  Aland @Common.Label: 'País';
  Tatyp @Common.Label: 'Clave';
};

annotate MDGService.VH_DestFactBP with {
  BusinessPartner @Common.Label: 'Socio comercial';
  BusinessPartnerCategory @Common.Label: 'Categoría';
  BusinessPartnerName @Common.Label: 'Nombre';
};

annotate MDGService.VH_DestFactSalesOrg with {
  SalesOrganization @Common.Label: 'Organización de ventas';
  SalesOrganization_Text @Common.Label: 'Descripción';
  SalesOrganizationCurrency @Common.Label: 'Moneda';
  CompanyCode @Common.Label: 'Sociedad';
};

annotate MDGService.VH_DestFactVtweg with {
  ProductDistributionChnl @Common.Label: 'Canal de distribución';
  Country @Common.Label: 'País';
  ProductSalesOrg @Common.Label: 'Organización de ventas';
};

annotate MDGService.VH_DestMercBanks with {
  Country @Common.Label: 'País';
  Country_Text @Common.Label: 'Descripción';
};

annotate MDGService.VH_DestMercBank with {
  Bank @Common.Label: 'Banco';
  BankInternalID @Common.Label: 'ID banco';
  BankCountry @Common.Label: 'País banco';
};

annotate MDGService.VH_DestMercLzone with {
  TransportZone @Common.Label: 'Zona de transporte';
  CountryCode @Common.Label: 'País';
  TransportZoneDescription @Common.Label: 'Descripción';
  TransportZone_Text @Common.Label: 'Texto';
};

annotate MDGService.VH_DestMercRegion with {
  Region @Common.Label: 'Región';
  Region_Text @Common.Label: 'Descripción';
  Country @Common.Label: 'País';
};

annotate MDGService.VH_CustomerNif with {
  Kunnr @Common.Label: 'Cliente';
  Taxtype @Common.Label: 'Tipo de impuesto';
};

annotate MDGService.VH_CustomerClassification with {
  CustomerClassification @Common.Label: 'Clasificación';
  CustomerClassification_Text @Common.Label: 'Descripción';
};

annotate MDGService.VH_MaterialProduct with {
  Material @Common.Label: 'Material';
  Material_Text @Common.Label: 'Descripción';
};

annotate MDGService.VH_MaterialSalesOrg with {
  SalesOrganization @Common.Label: 'Organización de ventas';
  SalesOrganization_Text @Common.Label: 'Descripción';
};

annotate MDGService.VH_MaterialVtweg with {
  ProductDistributionChnl @Common.Label: 'Canal de distribución';
  ProductSalesOrg @Common.Label: 'Organización de ventas';
  Country @Common.Label: 'País';
};

annotate MDGService.VH_MaterialKtgrm with {
  AcctAssignmentGroup @Common.Label: 'Grupo de imputación';
  Description @Common.Label: 'Descripción';
};

annotate MDGService.VH_MaterialUoM with {
  UnitOfMeasure @Common.Label: 'Unidad de medida';
  UnitOfMeasure_Text @Common.Label: 'Descripción';
};

annotate MDGService.VH_DriverRelationshipBP with {
  RelatedBusinessPartner @Common.Label: 'Conductor';
  SourceBusinessPartner @Common.Label: 'Dueño';
  BusinessPartnerRole @Common.Label: 'Rol BP';
  RelationshipCategory @Common.Label: 'Relación';
};

annotate MDGService.VH_DriverGen with {
  Kunnr @Common.Label: 'Conductor';
  Name1Text @Common.Label: 'Nombre';
  Transportista @Common.Label: 'Transportista';
  TransportistaName @Common.Label: 'Nombre transportista';
};

annotate MDGService.VH_DriverRol with {
  Kunnr @Common.Label: 'Conductor';
  Bp_Role @Common.Label: 'Rol BP';
  Role @Common.Label: 'Rol';
  Dfval @Common.Label: 'Valor por defecto';
  ValidFrom @Common.Label: 'Válido desde';
};

annotate MDGService.VH_DriverCom with {
  Kunnr @Common.Label: 'Conductor';
  Vkorg @Common.Label: 'Organización de ventas';
  Vtweg @Common.Label: 'Canal';
  Spart @Common.Label: 'Sector';
  Ernam @Common.Label: 'Creado por';
  Erdat @Common.Label: 'Fecha de creación';
};

annotate MDGService.VH_DriverImp with {
  Kunnr @Common.Label: 'Conductor';
  Aland @Common.Label: 'País';
  Tatyp @Common.Label: 'Clave';
  Taxkd @Common.Label: 'Clasificación';
};

annotate MDGService.VH_DriverNif with {
  Kunnr @Common.Label: 'Conductor';
  Taxtype @Common.Label: 'Tipo de impuesto';
  Taxnum @Common.Label: 'Número fiscal';
  Taxnumxl @Common.Label: 'Número fiscal largo';
};

annotate MDGService.VH_DriverAdi with {
  Kunnr @Common.Label: 'Conductor';
  Driver_Group @Common.Label: 'Grupo de conductores';
  ShortDriverId @Common.Label: 'ID corto';
};

annotate MDGService.VH_BillToGen with {
  Kunnr @Common.Label: 'Destinatario de factura';
  Name1 @Common.Label: 'Nombre';
  Name2 @Common.Label: 'Nombre 2';
};

annotate MDGService.VH_BillToCom with {
  Kunnr @Common.Label: 'Destinatario de factura';
  Vkorg @Common.Label: 'Organización de ventas';
  Vtweg @Common.Label: 'Canal';
  Spart @Common.Label: 'Sector';
  Ernam @Common.Label: 'Creado por';
  Erdat @Common.Label: 'Fecha de creación';
};

annotate MDGService.VH_BillToImp with {
  Kunnr @Common.Label: 'Destinatario de factura';
  Aland @Common.Label: 'País';
  Tatyp @Common.Label: 'Clave';
  Taxkd @Common.Label: 'Clasificación';
};

annotate MDGService.VH_ShipToGen with {
  Kunnr @Common.Label: 'Destinatario de mercadería';
  Name1 @Common.Label: 'Nombre';
  Name2 @Common.Label: 'Nombre 2';
};

annotate MDGService.VH_ShipToCom with {
  Kunnr @Common.Label: 'Destinatario de mercadería';
  Vkorg @Common.Label: 'Organización de ventas';
  Vtweg @Common.Label: 'Canal';
  Spart @Common.Label: 'Sector';
  Ernam @Common.Label: 'Creado por';
  Erdat @Common.Label: 'Fecha de creación';
};

annotate MDGService.VH_Resources with {
  Resuid @Common.Label: 'Recurso';
  Simversid @Common.Label: 'Versión simulación';
  Simsessid @Common.Label: 'Sesión simulación';
  Name @Common.Label: 'Nombre';
  ResourceGroup @Common.Label: 'Grupo de recursos';
};

annotate MDGService.VH_ResourceTransportationType with {
  TransportationType @Common.Label: 'Clase de transporte';
  Description @Common.Label: 'Descripción';
};

annotate MDGService.VH_ResourceLocation with {
  LocationNumber @Common.Label: 'Ubicación';
  LocationType @Common.Label: 'Tipo de ubicación';
  Description @Common.Label: 'Descripción';
};

annotate MDGService.VH_BU_GROUP with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_TAXKD with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_Boolean with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_TATYP with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_BU_GROUP with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_KTOKD with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_ANRED with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_BPKIND with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_KUKLA with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_TIME_ZONE with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_LANGU_CORR with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_DEFLT_COMM with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_ZZBKVID with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_MAHNA with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_MABER with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};

annotate MDGService.VH_Internal_MAHNS with {
  CODE @Common.Label: 'Código';
  TEXT @Common.Label: 'Descripción';
};
