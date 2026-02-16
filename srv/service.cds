using { MDG_REQUEST_HEADER, MDG_REQUEST_FIELD_VALUE } from '../db/model';

service MDGService @(path:'/mdg') {

  entity Requests      as projection on MDG_REQUEST_HEADER;
  entity RequestValues as projection on MDG_REQUEST_FIELD_VALUE;

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

  action approveRequest(requestId : String(36), comment : String(1000)) returns LargeString;
  action rejectRequest(requestId : String(36), comment : String(1000)) returns LargeString;
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
