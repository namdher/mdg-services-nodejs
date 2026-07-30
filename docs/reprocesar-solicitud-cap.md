# Reprocesar una solicitud hacia SAP usando CAP

Esta es la ruta oficial para reintentar una solicitud y que baje a SAP por el mismo action que usa la app.

## Regla de oro

No ejecutar handlers sueltos ni construir payloads manuales para "probar SAP".

Para que la prueba sea valida debe entrar por `approveRequest`, porque ese action ejecuta:

- Validacion de estado y rol.
- Construccion de payload desde HANA.
- Defaults configurados.
- Derivaciones de negocio.
- POST real a SAP via destination.
- Persistencia en `MDG_REQUEST_SAP_MESSAGE`.
- Cambio de estado final segun resultado.

## Camino preferido: Cloud Foundry runtime

Cuando el acceso local desde BAS falle con `ECONNRESET`, la via correcta es ejecutar una tarea dentro del runtime CF del CAP. Ese runtime tiene la conectividad real hacia los destinations.

Comando reusable despues de desplegar el script:

```sh
cf run-task mdg-services-nodejs-srv \
  --name mdg-retry-<REQUEST_SHORT>-$(date +%s) \
  --command "node scripts/retry-approve-request-cf.js <REQUEST_ID> <IAS_MANAGER_GROUP> <USER_EMAIL>"
```

Ejemplo real probado:

```sh
cf run-task mdg-services-nodejs-srv \
  --name mdg-retry-2df15adc-companycode-1785440842 \
  --command "node scripts/retry-approve-request-cf.js 2df15adc-eeb7-4f4a-96c3-613780ef56a3 MDG_CUSTOMER_EXTEND_COMPANYCODE_MANAGER namdher.colmenares@vacconsultores.cl"
```

Resultado validado en QAS:

- CF task: `94`
- Estado task: `SUCCEEDED`
- Solicitud: `2df15adc-eeb7-4f4a-96c3-613780ef56a3`
- Proceso: `CUSTOMER_EXTEND_COMPANYCODE`
- Entity set SAP: `ClientesEmpresarialSet`
- HTTP SAP: `201`
- Estado final solicitud: `APPROVED`
- Payload clave enviado: `Kunnr=1236904`, `Bukrs=A050`, `Mahna=ZVEN`, `Mahns=1`

## Ver logs de la tarea CF

```sh
cf tasks mdg-services-nodejs-srv
cf logs mdg-services-nodejs-srv --recent
```

Buscar en logs:

```text
MDG_RETRY_APPROVE_START
MDG_RETRY_APPROVE_RESULT
SAP_POST_RESULT
```

## Camino local: solo para diagnostico

El camino local sirve para revisar comportamiento CAP, pero no debe tomarse como prueba definitiva contra SAP si aparece `ECONNRESET`.

Actualizar `default-env.json`:

```sh
npm run default_env
cp default-env.json srv/default-env.json
cp default-env.json db/default-env.json
```

Levantar CAP local sin validar todas las VH en startup:

```sh
MDG_SKIP_VH_STARTUP_VALIDATION=true npm run start:local
```

Ejecutar el action CAP real:

```sh
curl -sS -u 'P029977:' \
  -H 'Content-Type: application/json' \
  -X POST 'http://localhost:4004/mdg/approveRequest' \
  -d '{"ID":"<REQUEST_ID>","COMMENT":"Reintento tecnico"}'
```

Si local falla con `read ECONNRESET` pero CF funciona, el problema es conectividad local/BAS hacia el on-premise destination, no necesariamente SAP ni CAP.

## Verificar resultado en HANA

Revisar cabecera:

```sql
SELECT "ID", "STATUS", "SUBJECT_ID", "MODIFIEDBY", "MODIFIEDAT"
  FROM "MDG_REQUEST_HEADER"
 WHERE "ID" = '<REQUEST_ID>';
```

Revisar ultimo mensaje SAP:

```sql
SELECT "STATUS", "HTTP_STATUS", "SAP_OBJECT_KEY", "MESSAGE", "PAYLOAD_JSON", "CREATEDAT"
  FROM "MDG_REQUEST_SAP_MESSAGE"
 WHERE "REQUEST_ID" = '<REQUEST_ID>'
 ORDER BY "CREATEDAT" DESC;
```

## Nota importante sobre estado

`approveRequest` normalmente ejecuta cuando la solicitud esta `IN_REVIEW`.

Si una solicitud queda en `REWORK` por un fallo tecnico ya corregido y se necesita reintentar el POST, la tarea CF puede reabrirla tecnicamente a `IN_REVIEW` antes de llamar `approveRequest`. Eso debe quedar trazado con usuario real, no con usuarios genericos tipo `codex`.
