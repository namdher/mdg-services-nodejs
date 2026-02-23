using { MDG_REQUEST_HEADER, MDG_REQUEST_FIELD_VALUE, MDG_REQUEST_COMMENT } from '../db/model';

service MDGService @(path:'/mdg') {

  entity Requests      as projection on MDG_REQUEST_HEADER;
  entity RequestValues as projection on MDG_REQUEST_FIELD_VALUE;
  entity RequestComments as projection on MDG_REQUEST_COMMENT;

  @cds.persistence.skip @readonly entity VH_CustomerGen {
    key Partner : String(10);
    key Kunnr   : String(10);
    Name1       : String(80);
  }

  @cds.persistence.skip @readonly entity VH_CustomerOrgV {
    key Kunnr : String(10);
    key Vkorg : String(4);
    key Vtweg : String(2);
    key Spart : String(2);
  }

  @cds.persistence.skip @readonly entity VH_CustomerSoc {
    key Kunnr : String(10);
    key Bukrs : String(4);
    key Maber : String(2);
  }

  @cds.persistence.skip @readonly entity VH_CustomerBan {
    key Kunnr : String(10);
    key Banks : String(3);
    key Bankl : String(15);
    key Bankn : String(18);
  }

  @cds.persistence.skip @readonly entity VH_CustomerImp {
    key Kunnr : String(10);
    key Aland : String(3);
    key Tatyp : String(4);
  }

  @cds.persistence.skip @readonly entity VH_CustomerNif {
    key Kunnr : String(10);
    key Taxtype : String(4);
  }

  action approveRequest(ID : String(36), COMMENT : String(1000)) returns LargeString;
  action rejectRequest(ID : String(36), COMMENT : String(1000)) returns LargeString;
  action whoAmI() returns LargeString;
  action getAvailableProcesses(countryCode : String(3)) returns LargeString;
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
