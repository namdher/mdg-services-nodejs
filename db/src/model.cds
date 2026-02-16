namespace mdg;

@cds.persistence.exists entity MDG_MASTER_OBJECT {
  key ID : String(36);
  MASTER_OBJECT_CODE : String(50);
  NAME : String(120);
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_OBJECT_BLOCK {
  key ID : String(36);
  MASTER_OBJECT_ID : String(36);
  BLOCK_CODE : String(60);
  NAME : String(120);
  DISPLAY_ORDER : Integer;
}

@cds.persistence.exists entity MDG_FIELD_CATALOG {
  key ID : String(36);
  FIELD_CODE : String(80);
  BUSINESS_LABEL : String(200);
  SAP_TABLE : String(30);
  SAP_FIELD : String(30);
  DATA_TYPE : String(30);
  LENGTH : Integer;
  DECIMALS : Integer;
  IS_MULTI : Boolean;

  VH_DESTINATION : String(120);
  VH_SERVICE : String(200);
  VH_ENTITYSET : String(120);
  VH_KEY_FIELD : String(60);
  VH_TEXT_FIELD : String(60);
  VH_SEARCH_FIELDS : String(500);
}

@cds.persistence.exists entity MDG_BLOCK_FIELD {
  key ID : String(36);
  BLOCK_ID : String(36);
  FIELD_ID : String(36);
  DISPLAY_ORDER : Integer;
}

@cds.persistence.exists entity MDG_FIELD_ALIAS {
  key ID : String(36);
  FIELD_ID : String(36);
  ALIAS : String(120);
  SOURCE : String(80);
}

@cds.persistence.exists entity MDG_PROCESS {
  key ID : String(36);
  PROCESS_CODE : String(80);
  NAME : String(150);
  MASTER_OBJECT_ID : String(36);
  WF_VERSION : String(10);
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_PROCESS_ROLE {
  key ID : String(36);
  PROCESS_ID : String(36);
  ROLE_CODE : String(30);
  FRONT_CODE : String(30);
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_PROCESS_STEP {
  key ID : String(36);
  PROCESS_ID : String(36);
  STEP_CODE : String(30);
  STEP_ORDER : Integer;
  OWNER_ROLE_CODE : String(30);
}

@cds.persistence.exists entity MDG_PROCESS_BLOCK {
  key ID : String(36);
  PROCESS_ID : String(36);
  BLOCK_ID : String(36);
  DISPLAY_ORDER : Integer;
}

@cds.persistence.exists entity MDG_COUNTRY {
  key ID : String(36);
  COUNTRY_CODE : String(3);
  NAME : String(80);
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_COUNTRY_ROLE_SCOPE {
  key ID : String(36);
  COUNTRY_CODE : String(3);
  PROCESS_ROLE_ID : String(36);
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_IAS_GROUP_ROLE_MAP {
  key ID : String(36);
  IAS_GROUP : String(200);
  PROCESS_ROLE_ID : String(36);
  PROCESS_ID : String(36);
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_FIELD_CONTROL_RULE_BASE {
  key ID : String(36);
  PROCESS_ROLE_ID : String(36);
  FIELD_ID : String(36);
  FIELD_CONTROL_BASE : Integer;
  DEFAULT_BASE : String(500);
}

@cds.persistence.exists entity MDG_FIELD_CONTROL_RULE_COUNTRY {
  key ID : String(36);
  COUNTRY_CODE : String(3);
  PROCESS_ROLE_ID : String(36);
  FIELD_ID : String(36);
  FIELD_CONTROL_OVERRIDE : Integer;
  DEFAULT_OVERRIDE : String(500);
}

@cds.persistence.exists entity MDG_BLOCK_SAP_SOURCE {
  key ID : String(36);
  PROCESS_ID : String(36);
  BLOCK_ID : String(36);
  DESTINATION_NAME : String(120);
  SERVICE_PATH : String(200);
  ENTITYSET : String(120);
  KEY_FIELD : String(60);
  FILTER_TEMPLATE : String(300);
  IS_COLLECTION : Boolean;
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_REQUEST_HEADER {
  key ID : String(36);
  PROCESS_ID : String(36);
  MASTER_OBJECT_ID : String(36);
  COUNTRY_CODE : String(3);
  SUBJECT_TYPE : String(30);
  SUBJECT_ID : String(60);
  SUBJECT_NAME : String(200);
  STATUS : String(30);
  createdAt : Timestamp;
  createdBy : String(255);
  modifiedAt : Timestamp;
  modifiedBy : String(255);
  isDeleted : Boolean;
  deletedAt : Timestamp;
  deletedBy : String(255);
}

@cds.persistence.exists entity MDG_REQUEST_FIELD_VALUE {
  key ID : String(36);
  REQUEST_ID : String(36);
  FIELD_ID : String(36);
  LINE_NO : Integer;
  VALUE : LargeString;
  updatedAt : Timestamp;
  updatedBy : String(255);
}

@cds.persistence.exists entity MDG_REQUEST_APPROVAL_TASK {
  key ID : String(36);
  REQUEST_ID : String(36);
  PROCESS_ROLE_ID : String(36);
  TASK_STATUS : String(30);
  ASSIGNED_TO : String(255);
  DECISION_AT : Timestamp;
  COMMENT : String(1000);
  createdAt : Timestamp;
  createdBy : String(255);
  modifiedAt : Timestamp;
  modifiedBy : String(255);
}

@cds.persistence.exists entity MDG_REQUEST_ACTION_LOG {
  key ID : String(36);
  REQUEST_ID : String(36);
  ACTION : String(40);
  ACTOR_USER : String(255);
  ACTOR_ROLE : String(30);
  COMMENT : String(1000);
  createdAt : Timestamp;
}

@cds.persistence.exists entity MDG_REQUEST_SAP_MESSAGE {
  key ID : String(36);
  REQUEST_ID : String(36);
  SAP_TARGET_ID : String(36);
  HTTP_STATUS : Integer;
  CORRELATION_ID : String(100);
  SAP_OBJECT_KEY : String(80);
  PAYLOAD_JSON : LargeString;
  RESPONSE_JSON : LargeString;
  createdAt : Timestamp;
}

@cds.persistence.exists entity MDG_SAP_TARGET {
  key ID : String(36);
  PROCESS_ID : String(36);
  TARGET_CODE : String(60);
  DESTINATION_NAME : String(120);
  SERVICE_PATH : String(200);
  ENTITYSET : String(120);
  OPERATION : String(20);
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_SAP_PAYLOAD_MAP {
  key ID : String(36);
  PROCESS_ID : String(36);
  FIELD_ID : String(36);
  SAP_TARGET_ID : String(36);
  SAP_PATH : String(200);
  SAP_PROPERTY : String(120);
  VALUE_TRANSFORM : String(200);
}
