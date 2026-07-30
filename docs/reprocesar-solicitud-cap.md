# Reprocesar una solicitud hacia SAP usando CAP

Esta es la ruta correcta para reintentar una solicitud y que baje a SAP por el mismo action que usa la app.

## 1. Actualizar `default-env.json`

Si el plugin `cf default-env` no esta instalado, usar `cf env` y regenerar `default-env.json` con `VCAP_SERVICES` y `VCAP_APPLICATION`.

Luego copiarlo a:

```sh
cp default-env.json srv/default-env.json
cp default-env.json db/default-env.json
```

## 2. Levantar CAP local sin validar todas las VH en startup

La validacion de metadata de ayudas de busqueda puede bloquear el arranque local por timeouts/ECONNRESET de S4. Para reprocesar una solicitud no se necesita esa validacion.

```sh
MDG_SKIP_VH_STARTUP_VALIDATION=true npm run start:local
```

## 3. Confirmar estado de la solicitud

El action `approveRequest` solo ejecuta si la solicitud esta `IN_REVIEW`.

Si quedo `REWORK` por un fallo SAP previo y se necesita reintentar tecnicamente, reabrirla a `IN_REVIEW` dejando comentario/bitacora.

## 4. Ejecutar por CAP, no por handler directo

Usar el endpoint CAP real:

```sh
curl -sS -u 'P029977:' \
  -H 'Content-Type: application/json' \
  -X POST 'http://localhost:4004/mdg/approveRequest' \
  -d '{"ID":"<REQUEST_ID>","COMMENT":"Reintento tecnico"}'
```

Esto ejecuta:

- Control de estado y rol.
- Construccion de payload desde HANA.
- Defaults configurados.
- Derivaciones de negocio.
- POST real a SAP via destination `S4H-TECH`.
- Persistencia en `MDG_REQUEST_SAP_MESSAGE`.
- Cambio de estado final segun resultado.

## 5. Revisar resultado

```sh
curl -sS -u 'P029977:' \
  'http://localhost:4004/mdg/request-results?requestId=<REQUEST_ID>'
```

Tambien se puede revisar `MDG_REQUEST_SAP_MESSAGE` uniendo con `MDG_SAP_TARGET` para ver entity set, payload y respuesta SAP.
