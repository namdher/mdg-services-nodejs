using { MDG_REQUEST_HEADER, MDG_REQUEST_FIELD_VALUE, MDG_REQUEST_COMMENT, MDG_PROCESS } from '../db/model';

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
      r.CREATEDAT,
      r.CREATEDBY,
      r.MODIFIEDAT,
      r.MODIFIEDBY,
      r.ISDELETED
  };
  entity RequestValues as projection on MDG_REQUEST_FIELD_VALUE;
  entity RequestComments as projection on MDG_REQUEST_COMMENT;

  @cds.persistence.skip @readonly entity VH_CustomerGen {
    key Kunnr   : String(10);
    Partner     : String(10);
    Name1       : String(80);
  }

  @cds.persistence.skip @readonly entity VH_CustomerOrgV {
    key ID    : String(200);
    Kunnr     : String(10);
    Vkorg     : String(4);
    Vtweg     : String(2);
    Spart     : String(2);
  }

  @cds.persistence.skip @readonly entity VH_CustomerSoc {
    key ID    : String(200);
    Kunnr     : String(10);
    Bukrs     : String(4);
    Maber     : String(2);
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
  }

  @cds.persistence.skip @readonly entity VH_CustomerImp {
    key ID    : String(200);
    Kunnr     : String(10);
    Aland     : String(3);
    Tatyp     : String(4);
  }

  @cds.persistence.skip @readonly entity VH_CustomerNif {
    key ID      : String(200);
    Kunnr       : String(10);
    Taxtype     : String(4);
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

  @cds.persistence.skip @readonly entity VH_Status {
    key CODE : String(30);
    TEXT     : String(80);
  }

  @cds.persistence.skip @readonly entity VH_AllowedProcesses {
    key ID          : UUID;
    PROCESS_CODE    : String(80);
    NAME            : String(150);
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
  { $Type: 'UI.DataField', Value: STATUS, Label: 'Estado' },
  { $Type: 'UI.DataField', Value: SUBJECT_ID, Label: 'ID Maestro' },
  { $Type: 'UI.DataField', Value: SUBJECT_NAME, Label: 'Nombre' },
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
  PROCESS_ID @Common.Label: 'Proceso';
  PROCESS_ID @Common.ValueList: {
    CollectionPath: 'VH_AllowedProcesses',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: PROCESS_ID, ValueListProperty: 'ID' },
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
};
