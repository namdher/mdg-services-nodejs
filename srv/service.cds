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
    key Kunnr   : String(10);
    Partner     : String(10);
    Name1       : String(80);
  }

  @cds.persistence.skip @readonly entity VH_CustomerOrgV {
    key ID    : String(200);
    Kunnr     : String(10);
    Vkorg     : String(4);
    VkorgText : String(80);
    Vtweg     : String(2);
    VtwegText : String(80);
    Spart     : String(2);
    SpartText : String(80);
  }

  @cds.persistence.skip @readonly entity VH_CustomerVtweg {
    key ID      : String(200);
    Vkorg       : String(4);
    VkorgText   : String(80);
    Vtweg       : String(2);
    VtwegText   : String(80);
  }

  @cds.persistence.skip @readonly entity VH_CustomerSpart {
    key ID      : String(200);
    Spart       : String(2);
    SpartText   : String(80);
    Division    : String(2);
    Division_Text : String(80);
    DivisionOID : String(40);
  }

  @cds.persistence.skip @readonly entity VH_CustomerSoc {
    key ID    : String(200);
    Kunnr     : String(10);
    Bukrs     : String(4);
    BukrsText : String(80);
    Maber     : String(2);
    MaberText : String(80);
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

  @cds.persistence.skip @readonly entity VH_CustomerPaymentCondition {
    key PaymentCondition            : String(4);
    PaymentCondition_Text           : String(120);
    PaymentTerms                    : String(4);
  }

  @cds.persistence.skip @readonly entity VH_CustomerBzirk {
    key SalesDistrict               : String(6);
    SalesDistrict_Text              : String(120);
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
    ProductDistributionChnl_Text     : String(80);
    ProductSalesOrg                  : String(4);
  }

  @cds.persistence.skip @readonly entity VH_MaterialKtgrm {
    key AcctAssignmentGroup           : String(4);
    Description                       : String(120);
  }

  @cds.persistence.skip @readonly entity VH_DriverGen {
    key Kunnr   : String(10);
    Name1       : String(80);
    Name2       : String(80);
  }

  @cds.persistence.skip @readonly entity VH_DriverRol {
    key ID      : String(200);
    Kunnr       : String(10);
    Bp_Role     : String(6);
    Dfval       : String(20);
    Role        : String(4);
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
