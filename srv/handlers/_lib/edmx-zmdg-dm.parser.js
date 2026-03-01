const fs = require('fs');
const path = require('path');

const METADATA_CANDIDATE_PATHS = [
  path.resolve(__dirname, '../../external/s4-metadata/ZMDG_DM_SRV.metadata.xml'),
  path.resolve(__dirname, '../../../external/s4-metadata/ZMDG_DM_SRV.metadata.xml')
];

let cachedMetadata = null;

function _parseAttributes(raw) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)="([^"]*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function _shortEntityTypeName(entityType) {
  if (!entityType) return '';
  const parts = String(entityType).split('.');
  return parts[parts.length - 1];
}

function _parseMetadata(xml) {
  const entityTypes = {};
  const entitySets = {};

  const entityTypeRe = /<EntityType\b([^>]*)>([\s\S]*?)<\/EntityType>/g;
  let typeMatch;
  while ((typeMatch = entityTypeRe.exec(xml)) !== null) {
    const typeAttrs = _parseAttributes(typeMatch[1] || '');
    const typeName = typeAttrs.Name;
    if (!typeName) continue;

    const properties = {};
    const propertyRe = /<Property\b([^>]*)\/>/g;
    let propMatch;
    while ((propMatch = propertyRe.exec(typeMatch[2] || '')) !== null) {
      const propAttrs = _parseAttributes(propMatch[1] || '');
      if (!propAttrs.Name) continue;
      properties[propAttrs.Name] = propAttrs.Type || null;
    }

    entityTypes[typeName] = { entityTypeName: typeName, properties };
  }

  const entitySetRe = /<EntitySet\b([^>]*)\/>/g;
  let setMatch;
  while ((setMatch = entitySetRe.exec(xml)) !== null) {
    const setAttrs = _parseAttributes(setMatch[1] || '');
    const entitySetName = setAttrs.Name;
    const entityTypeFull = setAttrs.EntityType;
    if (!entitySetName || !entityTypeFull) continue;

    const entityTypeName = _shortEntityTypeName(entityTypeFull);
    const typeDef = entityTypes[entityTypeName] || { entityTypeName, properties: {} };
    entitySets[entitySetName] = {
      entitySetName,
      entityTypeName,
      properties: typeDef.properties
    };
  }

  return { entityTypes, entitySets };
}

function _resolveMetadataPath() {
  for (const p of METADATA_CANDIDATE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadZmdgDmMetadata() {
  if (cachedMetadata) return cachedMetadata;

  const metadataPath = _resolveMetadataPath();
  if (!metadataPath) {
    throw new Error('ZMDG_DM_SRV.metadata.xml not found in expected paths');
  }

  const xml = fs.readFileSync(metadataPath, 'utf8');
  cachedMetadata = _parseMetadata(xml);
  cachedMetadata.metadataPath = metadataPath;
  return cachedMetadata;
}

function getEntitySetSchema(entitySetName) {
  const md = loadZmdgDmMetadata();
  return md.entitySets[entitySetName] || null;
}

module.exports = {
  getEntitySetSchema,
  loadZmdgDmMetadata
};
