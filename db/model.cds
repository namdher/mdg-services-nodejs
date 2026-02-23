@cds.persistence.exists entity MDG_MASTER_OBJECT {
  key ID : UUID;
  MASTER_OBJECT_CODE : String(50);
  NAME : String(120);
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_OBJECT_BLOCK {
  key ID : UUID;
  MASTER_OBJECT_ID : UUID;              // <- FK UUID
  BLOCK_CODE : String(60);
  NAME : String(120);
  DISPLAY_ORDER : Integer;
}

@cds.persistence.exists entity MDG_FIELD_CATALOG {
  key ID : UUID;
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
  key ID : UUID;
  BLOCK_ID : UUID;                     // <- FK UUID
  FIELD_ID : UUID;                     // <- FK UUID
  DISPLAY_ORDER : Integer;
}

@cds.persistence.exists entity MDG_FIELD_ALIAS {
  key ID : UUID;
  FIELD_ID : UUID;                     // <- FK UUID
  ALIAS : String(120);
  SOURCE : String(80);
}

@cds.persistence.exists entity MDG_PROCESS {
  key ID : UUID;
  PROCESS_CODE : String(80);
  NAME : String(150);
  MASTER_OBJECT_ID : UUID;             // <- FK UUID
  WF_VERSION : String(10);
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_PROCESS_ROLE {
  key ID : UUID;
  PROCESS_ID : UUID;                   // <- FK UUID
  ROLE_CODE : String(30);
  FRONT_CODE : String(30);
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_PROCESS_STEP {
  key ID : UUID;
  PROCESS_ID : UUID;                   // <- FK UUID
  STEP_CODE : String(30);
  STEP_ORDER : Integer;
  OWNER_ROLE_CODE : String(30);
}

@cds.persistence.exists entity MDG_PROCESS_BLOCK {
  key ID : UUID;
  PROCESS_ID : UUID;                   // <- FK UUID
  BLOCK_ID : UUID;                     // <- FK UUID
  DISPLAY_ORDER : Integer;
}

@cds.persistence.exists entity MDG_COUNTRY {
  key ID : UUID;
  COUNTRY_CODE : String(3);
  NAME : String(80);
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_COUNTRY_ROLE_SCOPE {
  key ID : UUID;
  COUNTRY_CODE : String(3);            // <- negocio (no UUID)
  PROCESS_ROLE_ID : UUID;              // <- FK UUID
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_IAS_GROUP_ROLE_MAP {
  key ID : UUID;
  IAS_GROUP : String(200);
  PROCESS_ROLE_ID : UUID;              // <- FK UUID
  PROCESS_ID : UUID;                   // <- FK UUID
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_FIELD_CONTROL_RULE_BASE {
  key ID : UUID;
  PROCESS_ROLE_ID : UUID;              // <- FK UUID
  FIELD_ID : UUID;                     // <- FK UUID
  FIELD_CONTROL_BASE : Integer;
  DEFAULT_BASE : String(500);
}

@cds.persistence.exists entity MDG_FIELD_CONTROL_RULE_COUNTRY {
  key ID : UUID;
  COUNTRY_CODE : String(3);            // <- negocio
  PROCESS_ROLE_ID : UUID;              // <- FK UUID
  FIELD_ID : UUID;                     // <- FK UUID
  FIELD_CONTROL_OVERRIDE : Integer;
  DEFAULT_OVERRIDE : String(500);
}

@cds.persistence.exists entity MDG_BLOCK_SAP_SOURCE {
  key ID : UUID;
  PROCESS_ID : UUID;                   // <- FK UUID
  BLOCK_ID : UUID;                     // <- FK UUID
  DESTINATION_NAME : String(120);
  SERVICE_PATH : String(200);
  ENTITYSET : String(120);
  KEY_FIELD : String(60);
  FILTER_TEMPLATE : String(300);
  IS_COLLECTION : Boolean;
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_REQUEST_HEADER {
  key ID : UUID;
  PROCESS_ID : UUID;                   // <- FK UUID
  MASTER_OBJECT_ID : UUID;             // <- FK UUID
  COUNTRY_CODE : String(3);

  SUBJECT_TYPE : String(30);
  SUBJECT_ID : String(60);
  SUBJECT_NAME : String(200);
  STATUS : String(30);

  CREATEDAT : Timestamp @cds.on.insert: $now;
  CREATEDBY : String(255) @cds.on.insert: $user;

  MODIFIEDAT : Timestamp @cds.on.update: $now;
  MODIFIEDBY : String(255) @cds.on.update: $user;

  ISDELETED : Boolean default false;   // <- default
  DELETEDAT : Timestamp;
  DELETEDBY : String(255);
}

@cds.persistence.exists entity MDG_REQUEST_FIELD_VALUE {
  key ID : UUID;
  REQUEST_ID : UUID;                   // <- FK UUID
  FIELD_ID : UUID;                     // <- FK UUID
  LINE_NO : Integer;
  VALUE : LargeString;

  MODIFIEDAT : Timestamp @cds.on.insert: $now @cds.on.update: $now;
  MODIFIEDBY : String(255) @cds.on.insert: $user @cds.on.update: $user;
}

@cds.persistence.exists entity MDG_REQUEST_APPROVAL_TASK {
  key ID : UUID;
  REQUEST_ID : UUID;                   // <- FK UUID
  PROCESS_ROLE_ID : UUID;              // <- FK UUID
  TASK_STATUS : String(30);
  ASSIGNED_TO : String(255);
  DECISION_AT : Timestamp;
  COMMENT : String(1000);

  CREATEDAT : Timestamp @cds.on.insert: $now;
  CREATEDBY : String(255) @cds.on.insert: $user;

  MODIFIEDAT : Timestamp @cds.on.update: $now;
  MODIFIEDBY : String(255) @cds.on.update: $user;
}

@cds.persistence.exists entity MDG_REQUEST_ACTION_LOG {
  key ID : UUID;
  REQUEST_ID : UUID;                   // <- FK UUID
  ACTION : String(40);
  ACTOR_USER : String(255);
  ACTOR_ROLE : String(30);
  COMMENT : String(1000);
  CREATEDAT : Timestamp @cds.on.insert: $now;
}

@cds.persistence.exists entity MDG_REQUEST_COMMENT {
  key ID : UUID;
  REQUEST_ID : UUID;                   // <- FK UUID
  AUTHOR_USER : String(255);
  AUTHOR_ROLE : String(30);
  MESSAGE : LargeString;
  CREATEDAT : Timestamp @cds.on.insert: $now;
  CREATEDBY : String(255) @cds.on.insert: $user;
}

@cds.persistence.exists entity MDG_REQUEST_SAP_MESSAGE {
  key ID : UUID;
  REQUEST_ID : UUID;                   // <- FK UUID
  SAP_TARGET_ID : UUID;                // <- FK UUID (si apunta a MDG_SAP_TARGET.ID)
  HTTP_STATUS : Integer;
  CORRELATION_ID : String(100);
  SAP_OBJECT_KEY : String(80);
  PAYLOAD_JSON : LargeString;
  RESPONSE_JSON : LargeString;
  CREATEDAT : Timestamp @cds.on.insert: $now;
}

@cds.persistence.exists entity MDG_SAP_TARGET {
  key ID : UUID;
  PROCESS_ID : UUID;                   // <- FK UUID
  TARGET_CODE : String(60);
  DESTINATION_NAME : String(120);
  SERVICE_PATH : String(200);
  ENTITYSET : String(120);
  OPERATION : String(20);
  IS_ENABLED : Boolean;
}

@cds.persistence.exists entity MDG_SAP_PAYLOAD_MAP {
  key ID : UUID;
  PROCESS_ID : UUID;                   // <- FK UUID
  FIELD_ID : UUID;                     // <- FK UUID
  SAP_TARGET_ID : UUID;                // <- FK UUID
  SAP_PATH : String(200);
  SAP_PROPERTY : String(120);
  VALUE_TRANSFORM : String(200);
}
